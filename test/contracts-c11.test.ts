// Contract C11 (the endpoint): docs/contracts/C11.md is its master since board task ab-v16.94.1, and
// test/vectors/endpoint.json its vectors. Both came from chrome-extension (docs/protocol.md and test/vectors/endpoint.json
// at main 66078cd), with these tests: they moved from chrome-extension's test/contracts.test.mjs with the text, so that
// the tests stay beside the text that they read. The small reference rules below follow the text, so a vector that breaks
// a rule fails here first. The bridge's constants (C10) come from the copy of chrome-extension's bridge.json at 4a4eb50
// (its constants and pointer constants are the same at 66078cd, 8a3b66f, 3d0a54a, 9fd239f, 8819e7e, d0a3d49, a25bfa8
// and 9962e11). Tests for the parts that the self-contained agent browser adds (board ab-v16.94: the service, the MCP path,
// the per-session MCP configuration) are at the end, and after them the tests of the input stage (board ab-t30.6, task
// ab-t30.8): its part of C11 and test/vectors/stage.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizeEntry } from "../src/relay/scopes.ts";
import { PLAYWRIGHT_FOCUS } from "../src/relay/policy.ts";
import { charKey } from "../src/record.ts";
import { tempDir } from "./temp-dirs.ts";
import { blockedReport, readBridge, readEndpoint, type CaseProc, type Check, type Checked, type Json, type JsonObject, type McpCheck, type McpSnapshot, type Proc, type TcpLine } from "./contracts-c11-vectors.ts";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
// A missing file reads as "", so each assertion fails on its own (tests first).
const readOr = (p: string) => { try { return read(p); } catch { return ""; } };
const C11 = readOr("docs/contracts/C11.md");
const endpoint = readEndpoint(read("test/vectors/endpoint.json"));
const bridge = readBridge(read("test/vectors/chrome-extension-4a4eb50/bridge.json"));
const K = bridge.constants;
const PK = bridge.pointerConstants;
const SCOPE = new RegExp(endpoint.scope.pattern);
/** C11's remote scope (stage 5), by its words: two names of the scope pattern with one `/`. */
const REMOTE = new RegExp(`^${endpoint.scope.pattern.slice(1, -1)}\\/${endpoint.scope.pattern.slice(1, -1)}$`);

// The rows of the Markdown table under a header line: first cell (a code span) -> the other cells.
function table(text: string, header: string) {
  const lines = text.split("\n");
  const at = lines.indexOf(header);
  assert.ok(at >= 0, `the table ${header}`);
  const rows = new Map();
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith("| ")) break;
    const cells = line.slice(2, -2).split(" | ").map((c) => c.trim());
    const m = /^`([^`]+)`$/.exec(cells[0]);
    assert.ok(m, `the first cell is one code span: ${line}`);
    rows.set(m[1], cells.slice(1));
  }
  return rows;
}

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
/** An object of the vectors that a rule reads as one: a test fails at another value. */
const objectOf = (x: unknown, what: string) => {
  assert.ok(isObj(x), `${what}: an object`);
  return x;
};
/** A value that a rule needs: a test fails at a missing one (as the plain read would, with a TypeError). */
const must = <T>(x: T | null | undefined, what: string): T => {
  assert.ok(x !== undefined && x !== null, `${what}: there`);
  return x;
};
// Whether a contract's text says s, whatever its line breaks.
const flat = (t: string) => t.replace(/\s+/g, " ");
const says = (text: string, s: string) => flat(text).includes(flat(s));

// C4's rules for set_scopes, which the relay applies to its allowlist line (C10, C11). The list entries follow C5
// (normalizeEntry: the relay's own; no rule of C11 depends on an entry).
const NAME = SCOPE;
// A valid name (C4): a string that matches the scope pattern. A field that must name a list and
// holds neither a valid name nor null (nor "*" for operator) counts 1 in refused and applies as null.
const validName = (v: unknown): v is string => typeof v === "string" && NAME.test(v);
const normalized = (e: unknown): e is string => normalizeEntry(e) === e;
// C4's "*" (the receiver 0.3.16; C11, the blanket profile; board ab-4wh): a local scope's value "*" applies only in the
// blanket shape: `lists` an empty object, `default` null, `operator` null or absent, exactly one scope, and a good `exclude`
// or none (at most 8 names of at most 512 characters in all, each a name of labels a-z, 0-9, _ and -, one label allowed,
// and no IP address). Any other "*" counts 1 and applies as null.
const EXCLUDE_NAME = /^(?!-)[a-z0-9_-]{1,63}(?<!-)(\.(?!-)[a-z0-9_-]{1,63}(?<!-))*$/;
const goodExclude = (x: unknown) => Array.isArray(x) && x.length <= 8 && x.join("").length <= 512 && x.every((n) => typeof n === "string" && n.length <= 253 && EXCLUDE_NAME.test(n) && !/^[0-9.]+$/.test(n));
const blanketShape = (msg: Record<string, unknown>) => isObj(msg.lists) && Object.keys(msg.lists).length === 0 && msg.default === null
  && (!Object.hasOwn(msg, "operator") || msg.operator === null) && isObj(msg.scopes) && Object.keys(msg.scopes).length === 1
  && (!Object.hasOwn(msg, "exclude") || goodExclude(msg.exclude));
// `remote`: the service's model, which applies a remote scope's entry (stage 5 T2); every other reader keeps C4's pattern.
function applySetScopes(msg: Record<string, unknown>, remote = false) {
  let refused = 0;
  const star = blanketShape(msg);
  const lists: Record<string, string[]> = {};
  if (isObj(msg.lists)) {
    for (const [name, v] of Object.entries(msg.lists)) {
      if (!NAME.test(name) || !Array.isArray(v)) {
        refused += 1 + (Array.isArray(v) ? v.length : 0); // the list, and each of its entries
        continue;
      }
      const ok = v.filter(normalized);
      refused += v.length - ok.length;
      lists[name] = ok;
    }
  } else refused += 1;
  const scopes: Record<string, string | null> = {};
  if (isObj(msg.scopes)) {
    for (const [scope, v] of Object.entries(msg.scopes)) {
      if (!NAME.test(scope) && !(remote && REMOTE.test(scope))) refused += 1; // applies as absent
      else if (v === "*" && star && NAME.test(scope)) scopes[scope] = "*"; // the blanket scope's "*": the public host class
      else if (!(v === null || validName(v))) {
        refused += 1;
        scopes[scope] = null; // no list, no fall-back to default
      } else scopes[scope] = v;
    }
  } else refused += 1;
  let def: string | null = null;
  if (validName(msg.default)) def = msg.default;
  else if (msg.default !== null) refused += 1; // also a missing default
  if (!isObj(msg.scopes)) def = null; // no scope gets default while the scopes are not known
  let operator: string | null = null;
  if (Object.hasOwn(msg, "operator") && msg.operator !== null) {
    const o = msg.operator;
    if (o === "*") operator = "*";
    else if (validName(o)) operator = Object.hasOwn(lists, o) ? o : null;
    else refused += 1;
  }
  // A scope's list: its scopes entry when it has one (no fall-back), else default; a remote scope that scopes does not
  // name has no list (C4: default applies only to a local scope; stage 5 T2).
  const listOf = (scope: string) => {
    const name = Object.hasOwn(scopes, scope) ? scopes[scope] : REMOTE.test(scope) ? null : def;
    if (name === "*") return name;
    return name !== null && Object.hasOwn(lists, name) ? name : null;
  };
  return { lists, scopes, default: def, operator, refused, listOf };
}
// The relay's allowlist line (C11): C4's rules, the roots with --peer-check, and a line with a
// roots field that a relay without --peer-check applies as no line at all.
// An item of roots: an object with an integer pid from 2 and an integer start from 0, both at most
// 2^53 - 1 (Number.isSafeInteger); its other fields are ignored.
const safe = (x: unknown): x is number => Number.isSafeInteger(x);
const isRoot = (r: unknown): r is Root => isObj(r) && safe(r.pid) && r.pid > 1 && safe(r.start) && r.start >= 0;
type Root = { pid: number; start: number };
type Roots = Record<string, Root[]>;
// The line that a relay applies (with the peer check: its roots), or the line with roots that a relay without the peer
// check applies as no line at all (failClosed: none of the other fields).
type Applied<R> = ReturnType<typeof applySetScopes> & { roots: R; failClosed?: undefined };
type FailClosed = { failClosed: true } & { [K in Exclude<keyof Applied<null>, "failClosed">]?: undefined };
function applyLine(line: Record<string, unknown>, peerCheck: true, remote?: boolean): Applied<Roots>;
function applyLine(line: Record<string, unknown>, peerCheck: boolean, remote?: boolean): Applied<Roots | null> | FailClosed;
function applyLine(line: Record<string, unknown>, peerCheck: boolean, remote = false): Applied<Roots | null> | FailClosed {
  if (!peerCheck && Object.hasOwn(line, "roots")) return { failClosed: true };
  const a = applySetScopes(line, remote);
  let roots: Roots | null = null;
  if (peerCheck) {
    roots = {};
    if (isObj(line.roots)) {
      for (const [scope, list] of Object.entries(line.roots)) {
        if (NAME.test(scope) && Array.isArray(list)) roots[scope] = list.filter(isRoot).map(({ pid, start }) => ({ pid, start }));
      }
    }
  }
  return { ...a, roots };
}

// The sentences of a text, whatever their line breaks.
const sentences = (text: string) => flat(text).split(/(?<=\.)\s+/);

// The part of C11 from a bold heading to the next bold heading.
function part(text: string, heading: string) {
  const start = text.indexOf(`**${heading}`);
  assert.ok(start >= 0, `the part ${heading}`);
  const next = text.indexOf("\n**", start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

// ---- C11's text: the rules that moved from chrome-extension's tests, where they read C11 beside C4, C5 and C10 ----

test("C11 is the per-scope contract in force: no target block, no set_allowlist rule and no key text is left", () => {
  assert.ok(C11.length > 1000, "docs/contracts/C11.md has the text of C11");
  assert.ok(!C11.includes("Target (board ab-v16.23)"), "no target block");
  assert.ok(!/\bC11's target\b/.test(C11), "no reference to a target block");
  assert.ok(!C11.includes("set_allowlist"), "C11 names no set_allowlist");
  for (const s of ["--keys", "X-Agentwatch-Key", "AGENTWATCH_BROWSER_CRED", '"keys"', "keys on", "Without keys", "without keys", "with keys", "the scope's key", "the key's 403", "the hash check",
    "timingSafeEqual", "?key=", "(ab-v16.35 and ab-v16.36)", "keysWithout", "~/.config/agentwatch/tokens/"]) {
    assert.ok(!says(C11, s), `C11: no ${s}`);
  }
  assert.ok(!/"keys?"|keysOn|x-agentwatch-key|\?key=/i.test(JSON.stringify(endpoint)), "no key in the vectors");
});

test("C11's readiness, the tabs of a scope with no list, a popup that waits for its scope, Target.closeTarget and daemon.blocked (moved with the text)", () => {
  assert.ok(says(C11, "the steps of the link up (C10, \"The daemon and the relay\") are done"), "C11's readiness waits for the steps of the link up");
  assert.ok(says(C11, "at a line whose `scopes` and `lists` are objects, it also drops from its model each tab of a scope that the line gives no list"), "C11: the relay drops the tabs of a scope with no list");
  assert.ok(says(C11, "A tab that still waits for its `bridge.tabScope` (up to `TAB_SCOPE_WAIT_MS`) has no scope yet, and it stays"), "C11: a popup that waits for its scope stays");
  assert.ok(says(C11, "At a line whose `scopes` or `lists` is not an object it drops no tab"), "C11: no drop at a line that is not applied");
  assert.ok(says(C11, "while Chrome's own `Target.closeTarget` does not"), "C11: today's relay's Target.closeTarget runs beforeunload");
  assert.ok(says(C11, "The navigation refusal reports `daemon.blocked` (C10, the daemon's own ops). Only an `ok` answer lets the relay name the Browser permission prompt in its refusal; otherwise it keeps the text in the row."), "C11: daemon.blocked");
});

test("C11's socket, URL, answers and closes follow the peer check", () => {
  const url = part(C11, "The socket and the URL.");
  for (const s of ["The URL contains no secret, with or without the peer check", "`agentwatch browser env` prints `PLAYWRIGHT_MCP_CDP_ENDPOINT=<url>`, with no comment lines",
    "keeps it for the session's life, with or without the peer check", "Without the peer check, every process of the daemon's OS user that can open the socket may connect, with any scope",
    "With the peer check, a connection needs its process in the agentwatch session of its scope"]) {
    assert.ok(says(url, s), `C11 says: ${s}`);
  }
  const before = part(C11, "Before the upgrade.");
  for (const s of ["a peer that the relay cannot read (a read at the accept fails, gives no pid, or gives a uid other than the relay's", "a peer that is not in the session of its scope (the session check, below)",
    "`<pid>` is the peer's pid, as the relay read it at the accept", "(the relay's self-test failed: the scope's session, below)",
    "a relay whose self-test failed gives its 503 (`the relay cannot read the program of a connection`); else a peer that it cannot read gets the peer's 403. Both come at once, also while the relay is not ready",
    "a relay without `--peer-check` whose last `allowlist` line has a `roots` field",
    "5. With the peer check, a scope that the last `allowlist` line does not name: the no-list 503. A just-launched session connects again",
    "the peer is alive, and the walk from it reaches a root of the scope that counts; a walk that stops at any other root refuses",
    "Only when the walk reaches no root, on Linux, may the peer's cgroup count: it must be in the pane's scope of a root of the scope. Else the session's 403",
    "With the peer check, that is a named scope whose entry is `null` (also an entry that applies as `null`, C4) or names a list that is not in `lists`", "without the peer check, also a scope that the line does not name while `default` gives no list",
    "With the peer check too, the relay never asks the daemon during an upgrade: it reads the peer at the accept, and step 6 runs in its event loop",
    "A session that is live at the deploy of the peer check gets its root in the daemon's first line after it"]) {
    assert.ok(says(before, s), `C11 says: ${s}`);
  }
  const ends = part(C11, "When a connection ends.");
  for (const s of ["With the peer check, at each `allowlist` line, the relay closes every connection of a scope that still has a list (the same list or another one) but whose root that admitted it (its pid and start, by the walk or by its cgroup) is no longer one of the scope's roots that apply (also at a line with no `roots` field)",
    "A connection keeps its scope until it closes, the line drops the root that admitted it, or the scope ends: the check runs once, at the upgrade"]) {
    assert.ok(says(ends, s), `C11 says: ${s}`);
  }
  assert.ok(says(part(C11, "The scope's list (board ab-v16.23)."), "With the peer check, a scope that the line does not name has no list, whatever `default` says: step 5 gives it the no-list 503 before the session check"), "C11: the scope's list with the peer check");
});

test("C11's scope's session holds the design's rules: the self-test, the peer read, the session check, the line, the defensive root rules, the roots' life and the limit", () => {
  const ses = part(C11, "The scope's session (the peer check; board ab-v16.50).");
  const has = (list: string[]) => { for (const s of list) assert.ok(says(ses, s), `C11 says: ${s}`); };
  // The words and the flag.
  has(["The **peer** of a connection is the process that called `connect()` on the client's side", "A **root** is a pair `(pid, start)`: the pid of a session's tmux pane process and the start time of that process",
    "On Linux `start` is field 22 of `/proc/<pid>/stat`", "on the Mac it is `pbi_start_tvsec * 1000000 + pbi_start_tvusec` of `proc_pidinfo`'s `PROC_PIDTBSDINFO`",
    "A process **matches** a root when its pid and its start time are both the root's. A pid alone never matches", "The **walk** goes from the peer to its parent (field 4 of `/proc/<pid>/stat`; `pbi_ppid` on the Mac)",
    "The **pane's scope** (Linux) is the systemd scope `tmux-spawn-<uuid>.scope`", "A cgroup is inherited at a fork and stays at a re-parent",
    "from its start, `agent-browser relay --socket <path> --peer-check`, not from an `allowlist` line"]);
  // The self-test (design 9.4; review-54b note 3).
  has(["a dynamic `import(\"node:ffi\")`, never a static import", "`ERR_UNKNOWN_BUILTIN_MODULE`", "A relay without `--peer-check` never loads `node:ffi`",
    "It makes a folder of mode 0700 with `mkdtemp` next to the endpoint socket", "The socket's path is at most 103 bytes, as the endpoint's; a longer path fails the test",
    "It starts a child process (`process.execPath` with a few lines of script) that connects to that socket and stays until the relay has read the connection",
    "the pid (the child's pid), the uid (the relay's), the peer's parent (the relay's own pid) and the peer's start time (field 22 of `/proc/<pid>/stat`, or `proc_pidinfo` on the Mac: the relay must be able to read it)",
    // Board ab-v16.52: the Mac's self-test reads the child as each accept does (the review's M2: p_puniqueid, no version 0).
    "On the Mac the relay reads the child as at each accept (the peer read, below: `LOCAL_PEERTOKEN`, then the child's `p_idversion`); the token's pid version must not be 0, the child's `p_puniqueid` must be the relay's own `p_uniqueid`, and the child's `p_uniqueid` must be later than the relay's (board ab-v16.52).",
    "and, when `SO_PEERPIDFD` gives a pidfd, the pid that the pidfd names (the `Pid:` line of `/proc/self/fdinfo/<pidfd>`) and a `poll` of that pidfd, which must return 0 (the child lives; review-19 note 5)", "A connection from the relay to itself would not do",
    "a pidfd of the child selects the **pidfd form**; `ENOPROTOOPT` (a kernel before 6.5) selects the **stat form**, which is not a failure; any other error fails the test",
    "The whole test has a time limit, `SELF_TEST_MS = 5000`", "In every path (a pass, a failure, the time limit) the relay stops the child and removes the folder",
    "`relay: the peer check runs (<form>)`, with `<form>` one of `pidfd`, `stat` and `mac`, or `relay: the peer check cannot run: <reason>`",
    "the relay admits no connection, and it answers each upgrade with the 503 `the relay cannot read the program of a connection` (step 3) until it stops: it fails closed"]);
  // The peer read (step 3; review-54b notes 1 and 4).
  has(["`getsockopt(SOL_SOCKET, SO_PEERCRED)` on the accepted socket gives the peer's pid and uid", "In the pidfd form `getsockopt(SOL_SOCKET, SO_PEERPIDFD)` gives a pidfd of the same process",
    "In the stat form the relay reads the peer's start time (field 22) at the accept too, so that the window of a reused pid starts there (review-54b note 4)",
    // Board ab-v16.52: the Mac's peer read is LOCAL_PEERTOKEN and the p_idversion of its pid, with no clock; it replaces the
    // wall-clock rule of board ab-v16.94.19 (review-145 N2) and its clock-step limit (board ab-v16.94.21, review-147 note 2).
    "The Mac: `getsockopt(SOL_LOCAL, LOCAL_PEERTOKEN)` gives the peer's audit token: its pid (`val[5]`) and its pid version (`val[7]`); `LOCAL_PEERCRED` gives the uid.",
    "Then `proc_pidinfo` gives the peer's `p_uniqueid` (`PROC_PIDUNIQIDENTIFIERINFO`), its parent, start time and state (`PROC_PIDTBSDINFO`), and last its `p_uniqueid` again, which must be the same, with its `p_idversion`.",
    "The peer has a start time only when that `p_idversion` is the token's pid version: each new process gets a new pid version, so a pid that another process got after the token's read gives the peer's 403 (board ab-v16.52). No clock takes part.",
    // The review's M3: exec, from the xnu source.
    "From the xnu source, not measured: an exec gives the process a new `p_idversion` and keeps its `p_uniqueid` and its start time, so a peer that execs between the token's read and the last read gets the 403 (fail closed), and an exec never makes a parent look later than its child.",
    "Measured on the Mac (board ab-v16.52, the probe at 92ea894, run 2026-11-25): the token's pid is `LOCAL_PEERPID`, the last process that used the client's socket; at the accept that is the connecter.",
    "After the connecter exits, `LOCAL_PEERPID` still names its pid until another holder uses the socket, and the token's read fails (`EINVAL`): the peer's 403. `val[7]` was the `p_idversion` of that pid in 10 of 10 reads.",
    "The peer's 403 (step 3) is the one answer for every read that fails at the accept (review-54b note 1)",
    "In the pidfd form any error of `SO_PEERPIDFD` is the peer's 403, whatever its code"]);
  // The session check (step 6; review-54b note 2).
  has(["libc `poll` of the pidfd (`POLLIN`, a 0 ms timeout) returns 0 (not readable; 1, readable, means that the peer has exited, and -1, an error, counts as not alive too), the `Pid:` line of its `fdinfo` is the peer's pid (`-1` means that it was reaped), and the peer's `/proc/<pid>/stat` can be read and its state (field 3) is not `Z`",
    "Each of the three counts alone: a process can show the state `Z` before its pidfd polls readable", "and a pidfd can poll readable while the state still shows `R` (both measured, review-54b note 2)",
    "Stat form and the Mac: the pid is still there, its start time is the one of the accept, and its state is not `Z` (on the Mac `pbi_status` is not `SZOMB`)",
    "The walk, from the peer itself (hop 0) to its parent, and on. It stops at the first process that matches a root of the line, of any scope (also a root that does not count, below)",
    "at pid 1; at a pid that has gone, or whose parent is 0; at a parent whose start time is later than its child's (the parent's pid came back during the walk, so it is not the child's parent; the same start time is a fork in the same clock tick, and the walk goes on; review-19 note 7); or after 32 hops (a root at most 32 parents above the peer counts)",
    // Board ab-v16.52: the Mac's walk orders by p_uniqueid, read last.
    "On the Mac the walk compares `p_uniqueid` (`PROC_PIDUNIQIDENTIFIERINFO`) in place of the start time: the kernel counts it up at each fork, never gives it again, and a step of the clock does not move it (board ab-v16.52; measured: it ordered each parent before its child from the probe's own process to launchd, whose `p_uniqueid` is 1).",
    // The review's M1: two p_uniqueid reads, so a pid that comes back at the child fails closed too.
    "The relay reads it before and after the other reads of each process, and a process counts only when both reads give the same `p_uniqueid`: a pid that came back between those reads, at the child or at a parent, makes the walk stop.",
    "When it stops at any other root, the relay refuses it, whatever the cgroup says", "a process whose own walk reaches its own session's root never counts as another session",
    "On Linux only, and only when the walk stopped at no root: the peer's cgroup", "the peer's cgroup is the cgroup of a root of S whose cgroup counts, or a cgroup under it (`<root cgroup>/...`: a path under it, not a longer name with the same start)",
    "The Mac has no cgroups: the walk alone decides there", "Before it admits, the relay checks item 1 again", "it then closes the pidfd with libc `close`, as in every other path"]);
  // The line's rules (design 9.2).
  has(["`\"roots\":{\"<scope>\":[{\"pid\":<pane pid>,\"start\":<pane start>}]}`", "a root that one scope names twice is one root", "A `roots` that is not an object applies as an empty object",
    "An entry whose scope does not match the scope pattern, or whose value is not a list, applies as absent",
    "An item that is not an object with an integer `pid` from 2 to 2^53 - 1 and an integer `start` from 0 to 2^53 - 1 is dropped, and the other items of its list apply", "The other fields of an item are ignored",
    "A scope with no root that applies admits no connection (step 6)", "A relay with `--peer-check` that gets a line with no `roots` field applies the lists, and no scope has a root",
    "A relay started without `--peer-check` that gets a line with a `roots` field (any value) applies no list of that line, as if no line had come: it closes the open connections (1008, no list any more)"]);
  // The defensive root rules.
  has(["so that the usual mistakes of a line (a pid of the tmux server, a pane that two scopes name, a pane with no scope of its own) admit no wrong session",
    "They cannot catch every wrong line: a line that names another session's pane as a scope's root admits that session's processes to the scope, so the daemon must send each session's own pane (review-19 note 3)",
    "a parent that the relay cannot read counts as the same cgroup", "A root of a scope that `scopes` does not name still counts for the defensive root rules",
    "Its open connections closed at the `end_scope` (1000) or close at that line (1008)",
    "When the import, the `dlopen`, a symbol, the listen, the child, the read, a compare or the time limit fails, the relay admits no connection",
    "The design's W2 (the relay asks the daemon over Node's IPC channel) is a later build, only if this test fails on a box that agentwatch runs",
    "a `getsockopt` that fails, no pid (0), a uid other than the relay's, and in the stat form and on the Mac a start time that the relay cannot read",
    "A root counts only while it lives", "A `(pid, start)` that two scopes name counts for neither scope", "A root that is an ancestor of another root (the walk from the other root reaches it, with the walk's own stop rules from its first hop: a parent whose start time is later than the other root's start time (on the Mac: whose `p_uniqueid` is later; board ab-v16.52) is no parent, so it is no ancestor; review-19b note 7) does not count, for the walk or the cgroup",
    "A root's cgroup counts only when its pane has a scope of its own: the cgroup is not the cgroup of the root's parent", "no live root of another scope has the same cgroup, and no other live root's cgroup is under it (a nested scope)",
    "A root whose cgroup does not count still counts for the walk", "At a check the relay reads again only the scope's own roots (one `stat` and one cgroup read each)",
    "its cgroup only while it is the cgroup of the line's read"]);
  // The roots' life (design 9.2 and 10; review-54b notes 5 and 6; ab-6gs).
  has(["The daemon sends the roots of every live session in each `allowlist` line, from the session's first line on",
    "At a launch, the daemon reads the new pane's pid and start (after `tmux new-session`, before the launch line) and does the pane's scope wait (below) before the scope enters its map, so the first line that names the scope carries its root, with the root's own scope cgroup",
    "The daemon does this wait before it sends the first line that carries a new root, at a launch and at a respawn, or it sends that line again after the wait (review-19 note 1)",
    "so a line from before the move gives the root its parent's cgroup (the tmux server's), and the root's cgroup does not count until the next line",
    "the session's 403 ends with `If this session started or restarted just now, connect again in a few seconds.`",
    "The daemon starts the pane's shell first, and types the agent's launch line into it only after the pane is in its own scope",
    "a process that the pane forks before that move stays in the tmux server's cgroup for its life", "with a time limit (agentwatch picks it; a few seconds)",
    "It does not wait on the Mac (no cgroups), nor on a box where the tmux server cannot reach the user's D-Bus", "When the time limit passes, the daemon types the launch line",
    "When a root changes (a respawned pane: a restart, an account swap, a resume), the daemon writes a line with the new root as soon as the new pane is in its own scope (the scope wait above), with the last confirmed object, before the agent starts in the new pane",
    "Such a line comes only after the first `ok` on the current connection (review-19 note 6)", "Before that `ok`, the new root goes into the line that follows it",
    "`tmux respawn-pane -k` gives the pane a new process and a new scope, so the old pane's jobs (in the old scope, under no live root) are refused, also by their cgroup",
    "At a session's end the daemon drops the scope's roots in the line that drops the scope", "Already before that line the pane has ended, so its root matches no process and its cgroup counts for no connection",
    "for its own scope it gets the session's 403 until that line, and after it the no-list 503 (step 5) with 5 a. With 5 b it gets the session's 403 only until the line of C4's rule 3 drops the `null` entry: the line that ends the session names the scope `null` and gives it no root, so step 6 comes before step 7 (review-19 note 2), and after the rule 3 line the scope is unnamed and step 5 gives the no-list 503 (review-19b note 5); for any other scope it gets the session's 403",
    "A session that agentwatch only stops (its agent ends, its pane stays) keeps its pane and its root until agentwatch ends the session",
    "Over a daemon restart the daemon reads the pane of each live session again and sends its roots in its next line"]);
  // What others get, the jobs, the limit, age-4ks.
  has(["What a program that no agentwatch session started gets: the session's 403 (step 6)", "a command of `systemd-run --user` cannot connect",
    "With the walk alone (the Mac; a Linux box whose panes have no scope of their own) `nohup <job> &` in a shell that exits, `setsid -f`, a double fork and `systemd-run` are refused",
    "On Linux with the pane's scope (P2, the operator's ab-6gs answer) such a job is admitted while it stays in the pane's scope; only `systemd-run` and a new tmux pane are refused",
    "It does not stop a hostile process of the same OS user", "run a command through a server that another session left running (`tmux -L <server> run-shell`: by the server's cgroup it then counts as that session)",
    "the check binds a connection to the session whose process connected", "The operator's answer age-4ks (\"env: no\", 2026-11-04) stands",
    "each case gives the peer and a fake process table, so both sides test with a fake peer reader"]);
  assert.ok(!says(ses, "for a moment"), "review-54b note 6: no 'for a moment' in the rules of the move");
  assert.ok(!says(ses, "so that a wrong line never admits a wrong session"), "review-19 note 3: the old claim is gone");
  // Board ab-v16.52: the wall-clock rule of the Mac's peer read and its clock-step limit are gone, and LOCAL_PEERPID is measured.
  for (const old of ["A start time later than the moment right before the `LOCAL_PEERPID` read", "That moment and the start time are both times of the wall clock", "From the xnu source (not measured; board ab-v16.52)", "from the peer to launchd", "The relay reads it after the other reads of each process"]) assert.ok(!says(ses, old), `board ab-v16.52: no "${old}"`);
});

test("C11 states the pointer at an activation (board ab-v16.70): the paths' states, the step, its waits and limits, the catch-up, the geometry and the fallback", () => {
  for (const s of [
    "The pointer at an activation (board ab-v16.70; the relay builds it in board ab-v16.71).",
    "So, on Linux with one window per page, the relay has the daemon move the X pointer (C10, the daemon's own ops) along a person-shaped path, from the last point of the page under the pointer to the last point of the page that comes forward, before the window comes forward. It does this for every client.",
    "(agent-browser `docs/superpowers/specs/2026-11-06-agent-pointer-move-design.md`, section 3) gives the reasons",
    // The states: the probe, on, off (an older daemon) and unknown; the front page after the paths turn on.
    "They are unknown until the first answer of the probe, `daemon.pointerAt`, which the relay sends at each link up. An answer turns them on, and gives `at`, the display's size and `views`.",
    "`unknown op`, `wrong display` and `not connected` (an older daemon) turn them off until the next link up, and `no display` for 60 s. `busy`, `too many moves`, `disconnected` and the relay's own timer leave them unknown, and the next step that needs them probes again. Each time the paths turn on, the front page is unknown.",
    "While the paths are off, the relay is exactly as the bullets above say: no geometry read, no wait, no catch-up and no path, and `Page.bringToFront` and `Target.activateTarget` go as above.",
    // What it keeps.
    "a wheel event more than 2 px from it, a child session's pointer input and touch input make it unknown",
    "after failed reads of step 1, after a raise that reached its limit or that failed for an input or a `Page.bringToFront`, and after any client's `Browser.setWindowBounds` (below)",
    // Board ab-t30.12.3 (before: ... until Chrome answered a `mouseReleased` on any of them).
    // review-138 N1 (before: a tab holds a CDP button from a `mousePressed` on any of its sessions, its own or a frame's (review-68 B2), until Chrome answered a `mouseReleased`, or a `drop` or a `dragCancel` of `Input.dispatchDragEvent` (a drop takes the place of the release, and the button is up after it: board ab-t30.12.3), on any of them)
    "a tab holds a CDP button from a `mousePressed` on any of its sessions, its own or a frame's (review-68 B2), until Chrome answered a `mouseReleased`, or answered a `drop` or a `dragCancel` of `Input.dispatchDragEvent` with no error (a drop takes the place of the release, and the button is up after it: board ab-t30.12.3; with the input stage on or off, review-138 N1: the tab has one mark for all its buttons, so such an answer ends the hold also when Chrome had no drag or another button is down), on any of them",
    // The step, its order and its waits.
    "`Page.bringToFront` and `Target.activateTarget` go through it too: they wait for the chain and for their tab's gate, as an input does, and answer after the step.",
    "1. Read the tab and its window (`tabs.get`, `windows.get`).",
    "2. Decide. With the front page known, a page comes under the pointer when it is not the front page, or, for `Target.activateTarget`, when its tab is not active and its window is the front page's window.",
    "With the front page unknown, the focus decides as above, and no path plays.",
    "3. Wait and hold, only when a path can play, all within one `ACTIVATE_MAX_MS = 2000`; at the limit, no path.",
    "No other page's button counts.",
    "Wait for the end of a catch-up that runs in the front page. Then chain the front page's gate on its old gate",
    "Last, wait for the answers of both pages' pointer input that already went to Chrome.",
    "4. Plan.",
    "none is needed when `at` is T. The path follows agent-browser's `src/input.ts` generator from S to T, sampled every 16 ms,",
    "each `dt` at most 250 ms, stretched in time until no step is over 50 px, with a first step of 2 px or more",
    "5. Play: send `daemon.movePointer`, and wait for its answer, at most its wait.",
    "6. Record (the X records). On `ok` the answered position is the last point of both pages",
    "On `pointer moved` the answered position is `at` and the entering page's last point, and the front page's point is unknown.",
    "the relay reads the pointer (`daemon.pointerAt`) and records it as `at` and as the entering page's point, and after a failed path also as the front page's point",
    "7. The raise: bring the page forward, within one `ACTIVATE_MAX_MS`. For an input, `tabs.update` with `{\"active\":true}` when its tab is not active, and `windows.update` with `{\"focused\":true}` when a page comes under the pointer or its window does not have the focus; the client's `Page.bringToFront`; or the `tabs.update` of `Target.activateTarget`. The raise succeeds when its calls answer with no error within the limit. Then open the front page's gate.",
    "8. The input goes. A press's catch-up, if any, runs inside its chain step, from step 6's record.",
    "The limits: one `ACTIVATE_MAX_MS` for steps 1 and 2, one for step 3, 1.2 s for the reads of step 4 (the geometry's `GEOMETRY_WAIT_MS = 200`, and `daemon.pointerAt`), the path's wait (at most 3 s), 1.2 s for the read after a failed path, and one `ACTIVATE_MAX_MS` for step 7",
    "The worst case is about 11.4 s",
    // The catch-up and its bound per tab (review-63d B1, review-63e note E).
    "a move more than 50 px from it, or a press or a wheel more than 2 px from it, the relay first sends CDP `mouseMoved` events (no button)",
    "The relay decides it when the event leaves the tab's gate, against the page's point at that time.",
    "Each page's cover mark: another page came on top of it.",
    "A new tab that comes on top also marks the old front page. The mark changes no last point.",
    "The relay marks the leaving page before the raise, even when no X path plays or `at` is T.",
    "A failed or late answer can still have raised the window.",
    "A raise with an unknown front page sets no cover mark.",
    "for a page whose point is an X record or has a cover mark",
    "The catch-up runs once after each X record or cover. The first pointer input consumes the cover mark; unrelated calls keep it.",
    "Another record or cover is necessary for another catch-up between the client's events.",
    "The relay sends no catch-up while the page holds a button.",
    "A tab has at most `CATCH_UP_MAX_UNANSWERED = 4` catch-up moves without an answer: no catch-up starts while the tab has unanswered catch-up moves, and when a move is due while 4 wait (a page with an open dialog answers none), the catch-up stops and the client's event goes as with the paths off.",
    "A step and a catch-up never overlap on one page.",
    // The geometry read.
    "one `Runtime.evaluate` in the relay's own isolated world, only for a bridge tab, one in flight per tab, with no `Page.enable` or `Runtime.enable` of the relay's own, and with C10's default wait",
    "a geometry is also not usable when a device-metrics override is in force on the tab",
    // No path, the fallback and an older daemon (review-63e note C).
    "When the relay sends no path, that activation is as with the paths off",
    "(the first activation after the relay's start, after a link change, and after the paths turn on)",
    "With an older daemon (`unknown op`, `not connected`) the paths stay off. On the Mac the relay sends no pointer op (`daemon.pointerAt` or `daemon.movePointer`).",
    // The links from the existing text.
    "With the paths on, the activation has the steps and the limits of the pointer at an activation (below).",
    "With the paths on (Linux), both go through the activation step (the pointer at an activation, below).",
  ]) assert.ok(says(C11, s), `C11 says: ${s}`);
  // The catch-up's bound is per tab, never per catch-up (review-63e note E), and C10's per-tab limit is the 64 it protects.
  assert.ok(!says(C11, "per catch-up"), "no bound per catch-up");
  assert.ok(says(C11, "So the tab's 64 requests in flight (C10) never fill in front of the client's `Page.handleJavaScriptDialog`.") && K.MAX_IN_FLIGHT_PER_TAB === 64, "the 64 of C10");
  assert.equal(endpoint.constants.ACTIVATE_MAX_MS, 2000, "the 2 s of the activation");
  // The step's worst case: 2 + 2 + 1.2 + 3 + 1.2 + 2 s; the path's wait at most the longest move's wait.
  const longest = PK.POINTER_START_MS + PK.POINTER_PATH_MAX_MS + PK.POINTER_KILL_MS + PK.POINTER_SLACK_MS;
  assert.ok(longest <= 3000, "the path's wait is at most 3 s");
  assert.equal(Math.round((3 * endpoint.constants.ACTIVATE_MAX_MS + 2 * PK.POINTER_READ_WAIT_MS + 3000) / 100) / 10, 11.4, "the worst case");
});

// The lead's decisions on agent-browser PR #68 (board ab-v16.71), in C11 by board ab-v16.77.
test("C11 states the lead's decisions of board ab-v16.71 (board ab-v16.77): the content box, the kept geometry, a jump with no path and the gate rule", () => {
  const has = (list: string[]) => { for (const s of list) assert.ok(says(C11, s), `C11 says: ${s}`); };
  // The content box: the tests and the clamp of the path, the clamp of the catch-up, and where it comes from.
  has([
    "No path when S or T is outside the front page's content box (its viewport less its scrollbars, 2 px inside its edges; the lead's decision in board ab-v16.71); none is needed when `at` is T.",
    "each point clamped 2 px inside the front page's content box, in whole pixels (a page gets no mouse event over its scrollbars, so a path over one gave an unexplained change live)",
    "each point clamped 2 px inside the page's content box as in step 4 (from the page's kept geometry, else a read, which keeps no geometry; with neither, or with one that fails the read's own rules (below), no clamp), except the event's own point, which stays where the client sent it.",
    "The read also gives the content box: `visualViewport.width` and `height` (the viewport less its scrollbars, at a scale of 1; else `documentElement.clientWidth` and `clientHeight`).",
    "S or T is outside the front page's content box; the path does not fit the limits",
  ]);
  for (const s of ["2 px inside the front page's viewport", "S or T is outside the front page's viewport"]) assert.ok(!says(C11, s), `C11: no ${s}`);
  // The kept geometry: what the relay keeps, who uses it, where it goes, no path without it, and its limit.
  has([
    "Each page's kept geometry: its last usable geometry from the relay's own reads (below).",
    "The kept geometry (the lead's decision in board ab-v16.71; review-68 N2). The relay keeps each page's last usable geometry from its own reads.",
    "Step 4 uses it for a page that is no bridge tab (agent-browser's CLI ends its connection after each command, and the relay then detaches its page), and the catch-up uses it before a read.",
    "The relay drops it at every window event that it sees: any client's `Browser.setWindowBounds`; on the page's own session, a client's `Emulation.setDeviceMetricsOverride`, `Emulation.clearDeviceMetricsOverride`, `Emulation.setVisibleSize`, `Emulation.setPageScaleFactor`, `Emulation.setScrollbarsHidden`, `Page.setDeviceMetricsOverride` or `Page.clearDeviceMetricsOverride`; the page's `Page.frameResized`; its `tabs.onReplaced` (the new tab has none) and its `tabs.onRemoved`; and a link change.",
    "When a page that is no bridge tab has no kept geometry, the step sends no path.",
    "A front page whose `document.visibilityState` is `\"hidden\"` has no usable geometry (a page under the pointer is visible), so the step sends no path.",
    "The limit (review-68 N9): a kept geometry can be out of date when its window moves or changes its size, or its content box changes, with no event that the relay sees: a site popup's `window.moveTo` or `window.resizeTo`, the page's own fullscreen change, or a scrollbar that the page got or lost after the read (with no client attached, no `Page.frameResized` reaches the relay).",
    "The path then follows the old rectangle: real moves and hovers only, at points from the pages' input, at most 5 paths a second, over what lies there now.",
    "a geometry is missing or not usable (a hidden front page has no usable geometry);",
  ]);
  // A step with no path can show one jump or one unexplained change.
  has([
    "A page that never had a pointer event then enters with its first pointer event, which is no position change. A page whose point was known or became unknown enters at the X pointer: at most one unexplained change or one jump.",
    "The entry carries the movement from the page's last point when Chrome still has that point as the base of the movement (the page got pointer input since its window last lost the pointer), so it is a jump when the X pointer is more than 100 px from that point",
  ]);
  assert.ok(!says(C11, "never a jump"), "C11: no 'never a jump'");
  assert.ok(!says(C11, "one unexplained position change at most, or one jump"), "C11: the words of review-68");
  // The gate rule applies only while the front page holds a button.
  has(["When the front page holds a button, wait for its release. The rule \"no path when its tab's next call waits in the activation chain (its gate is set, or becomes set during the wait)\" applies only while the front page holds a button, because only then does the release wait behind this step"]);
  assert.ok(!says(C11, "wait for its release; no path when"), "C11: the gate rule is no rule of every step");
});

// Review-68's rules of agent-browser PR #68 (board ab-v16.71, head b186c06), in C11 by board ab-v16.77.
test("C11 states review-68's rules of agent-browser PR #68 (board ab-v16.77): the world, the kept read, the held button, the front page by a raise, Browser.setWindowBounds in the chain, the limits", () => {
  const has = (list: string[]) => { for (const s of list) assert.ok(says(C11, s), `C11 says: ${s}`); };
  has([
    // B1: a world before each read, and its ids.
    "Each read first sends `Page.createIsolatedWorld` on the main frame and evaluates in the context id that it returns; when the evaluate names an unknown context (a navigation between the two calls), the relay sends both once more",
    // N2: the rules of a usable geometry, and the kept read.
    "It also gives `document.visibilityState`.",
    "The read's own rules: a geometry is not usable when the ratio or the scale is not 1, the screen size is not the display's, a width or a height of the viewport or of the content box is 4 px or less, or the content box is wider or taller than the viewport.",
    "The relay's rules: a geometry is also not usable when a device-metrics override is in force on the tab (from a client's `Emulation.setDeviceMetricsOverride` or `Page.setDeviceMetricsOverride` on the page's own session until its `Emulation.clearDeviceMetricsOverride` or `Page.clearDeviceMetricsOverride`, or until the tab is detached), when the window is minimized (the entering page's, by step 1's `windows.get`), or when it is a hidden front page. A read in flight gives no geometry.",
    "It keeps a read only when the read is usable as a front page's geometry: the rules above, not hidden, and not minimized when step 1 read the window.",
    "A read keeps or drops the kept geometry only when it answers within `GEOMETRY_WAIT_MS` and no drop event of the page (below) came after the read started (the relay counts each page's drop events): then a read that is not usable, or that fails, drops the kept one. A late answer is dropped and changes nothing. A catch-up's own read changes no kept geometry.",
    // N1: the front page only by a raise that the relay sends.
    "the page of the last activation step that made it the front page (by the rule of step 6, when step 7's raise succeeds), or a new tab that comes on top, with no raise (a new active tab that opens a window, or that becomes the active tab of the front page's window)",
    "The front page decides, not the focus, and for an input the raise (step 7) sends `windows.update` with `{\"focused\":true}` also to a focused window. With the front page unknown, the focus decides as above, and no path plays. Then a page becomes the front page (and step 6 records it) only when the raise brings a window forward: the `windows.update` of an input whose window does not have the focus, or the client's `Page.bringToFront` (review-68 N1). A raise that only switches the tab (`tabs.update`, also that of `Target.activateTarget`), or an input whose window has the focus, leaves the front page unknown, with no record: a focused window can lie under a newer window.",
    "Each record that maps a display position into a page gives that page an unknown point when the position is outside the page's viewport, or when the page's geometry is missing or not usable (the read's own rules, and no device-metrics override). The entering page is the front page when the raise (step 7) succeeds and either a page came under the pointer (the front page was known) or, with the front page unknown, the raise brought a window forward (step 7; the rule of step 2); a failed `tabs.update` of `Target.activateTarget` gives the client the error and keeps the front page as it was.",
    // N3: activateTarget's tabs.update after failed reads.
    "When the reads fail or reach their limit, the front page is unknown and no path plays: the input goes with no raise, the client's `Page.bringToFront` goes, and `Target.activateTarget` sends its `tabs.update` within one `ACTIVATE_MAX_MS` (review-68 N3).",
    // B2: a held button on any session.
    "a frame's pointer input still makes the page's point unknown",
    // B3: Browser.setWindowBounds in the activation chain.
    "A client's `Browser.setWindowBounds`, with the paths on, waits in the activation chain (review-68 B3): behind every step already in the chain (the path of the step that runs plays at the window's old place), and behind the catch-ups that run in its window's pages; then the front page is unknown, the kept geometry of every page in the relay's model goes (of every window and every scope), and the window changes. Later steps wait behind it. The window's scope check runs first: a call whose window holds no tab of the client's scope gets `Browser window not found` and changes nothing. With the paths off or unknown it goes at once.",
    // The limit of movement 0 (board ab-v16.76).
    "Movement 0 after a page loses the pointer (measured in board ab-v16.71; fixed for known raises by board ab-v16.76): Chrome gives the covered page's next event movement 0.",
    "The cover mark now applies the catch-up even when its point is a client point.",
    "The same thresholds, path limits, held-button rule and per-tab bound of 4 unanswered catch-up moves apply. An unknown point still has no catch-up.",
    "A window change that the relay cannot observe remains outside this rule.",
    "An unexplained change is a pointer event whose position change from the page's last pointer event does not agree with its movement (`movementX`, `movementY`).",
  ]);
  for (const s of ["The entering page is the front page now.", "(in the read, or in the read that gave its kept geometry)", "the world again", "still sets or drops it", "so no client sees the world, and the page's own events reach the client", "(unknown for the front page when it is outside its viewport)", "whose raise the relay sent (step 2)", "or the relay sent the raise (step 2)", "7. Bring the page forward:", "the kept geometries go", "covers it only after an X record", "never between a client's own events"]) assert.ok(!says(C11, s), `C11: no ${s}`);
});

// ---- C11: the endpoint ----

test("C11 states the scope rule and the one context of the vector, and the vector's scopes follow the rule", () => {
  assert.ok(C11.includes("`" + endpoint.scope.pattern + "`"));
  assert.ok(C11.includes(`"browserContextId":"${endpoint.defaultContext}"`));
  const re = new RegExp(endpoint.scope.pattern);
  for (const s of endpoint.scope.valid) assert.ok(re.test(s), `valid: ${s}`);
  for (const s of endpoint.scope.invalid) assert.ok(!re.test(s), `invalid: ${JSON.stringify(s)}`);
  // Every agentwatch session name is a scope (agentwatch sessions/naming.py).
  const session = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  for (const s of [...endpoint.scope.valid, ...endpoint.scope.invalid]) if (session.test(s)) assert.ok(re.test(s), s);
});

test("C11 states every answer of the endpoint before the upgrade", () => {
  for (const a of endpoint.upgradeAnswers) {
    assert.ok(C11.includes(`${a.status} \`${a.body}\``), `${a.status} ${a.body}`);
  }
  for (const c of endpoint.closes) assert.ok(C11.includes(`${c.code}, \`${c.reason}\``), `${c.code} ${c.reason}`);
});

test("C11 states the relay's constants", () => {
  for (const [name, value] of Object.entries(endpoint.constants)) assert.ok(C11.includes(`\`${name} = ${value}\``), `C11 has \`${name} = ${value}\``);
});

// Before the upgrade (C11): the order of the checks, with and without the peer check.
const answerById = Object.fromEntries([...endpoint.upgradeAnswers, ...endpoint.blanketAnswers].map((a) => [a.id, a]));
const closeById = Object.fromEntries(endpoint.closes.filter((c) => c.id).map((c) => [c.id, c]));
// The fake process table of a case: its world, with the case's entries in place of the world's.
type Pr = Proc | Extract<CaseProc, { ppid: number }>;
type World = Map<number, Pr>;
function worldOf(c: { world?: string; procs?: CaseProc[] }): World {
  const w: World = new Map(endpoint.procs.filter((p) => p.world === c.world).map((p) => [p.pid, p]));
  for (const p of c.procs ?? []) {
    if (p.gone) w.delete(p.pid);
    else w.set(p.pid, p);
  }
  return w;
}
const MAX_HOPS = 32;
// A process's parent in the table (none for no process).
const parentOf = (w: World, p: Pr | undefined) => (p === undefined ? undefined : w.get(p.ppid));
// The allowlist line of the vectors by its name (a check that names none has no line to apply).
const namedLine = (name: string | null) => endpoint.lines[must(name, "a line's name")];
const key = (pid: number, start: number) => `${pid}:${start}`;
// The walk from pid (hop 0) through its parents: the first process that matches a root of `named`
// (by pid and start), or null when it reaches pid 1, a pid that has gone, a parent 0, a parent whose
// start time is later than its child's (its pid came back), or 32 hops.
function walk(w: World, pid: number, named: Map<string, unknown>, child: Pr | null = null): string | null {
  // child: the process whose parent pid is the first hop (its start time bounds the parent's).
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const s = w.get(pid);
    if (!s || (child !== null && s.start > child.start)) return null;
    if (named.has(key(pid, s.start))) return key(pid, s.start);
    if (pid === 1 || s.ppid === 0) return null;
    child = s;
    pid = s.ppid;
  }
  return null;
}
// The defensive root rules (C11, the scope's session): which roots of the line count, for the walk
// and for the cgroup, from the stat and the cgroup of each root.
// A root of the line: its scopes, and (set in the order below) whether it is live, its cgroup, its one scope, whether it
// counts for the walk, and whether its cgroup counts.
// `line`: a root of the line (it can admit); `context` (board ab-4wh.9): the roots of the service's sessions, which stop the
// walk and count for the rules under their own scope but admit no connection.
type Named = { pid: number; start: number; scopes: Set<string>; line: boolean; live: boolean; cgroup: string | null; scope: string | null; counts: boolean; cgroupCounts: boolean };
function rootsThatCount(roots: Record<string, Root[]>, w: World, context: Record<string, Root[]> = {}): Map<string, Named> {
  const named = new Map<string, Named>();
  for (const [from, line] of [[roots, true], [context, false]] as const) for (const [scope, list] of Object.entries(from)) {
    for (const { pid, start } of list) {
      const k = key(pid, start);
      if (!named.has(k)) named.set(k, { pid, start, scopes: new Set(), line: false, live: false, cgroup: null, scope: null, counts: false, cgroupCounts: false });
      const n = must(named.get(k), k);
      n.scopes.add(scope);
      if (line) n.line = true;
    }
  }
  for (const r of named.values()) {
    const s = w.get(r.pid), live = s !== undefined && s.start === r.start;
    r.live = live;
    r.cgroup = live ? s.cgroup : null;
  }
  const ancestors = new Set<string>();
  for (const r of named.values()) {
    const s = w.get(r.pid);
    if (!r.live || s === undefined) continue; // a live root is in the table
    const rest = new Map([...named].filter(([k]) => k !== key(r.pid, r.start)));
    const above = walk(w, s.ppid, rest, s); // the root's parent is compared with the root (review-19b note 7)
    if (above) ancestors.add(above);
  }
  const live = [...named.values()].filter((r) => r.live);
  for (const [k, r] of named) {
    r.scope = r.scopes.size === 1 ? [...r.scopes][0] : null;
    r.counts = r.live && r.scope !== null && !ancestors.has(k);
    const s = w.get(r.pid);
    const parent = r.live && s !== undefined ? w.get(s.ppid) : undefined; // a live root is in the table
    r.cgroupCounts = r.counts && typeof r.cgroup === "string" && parent !== undefined && parent.cgroup !== r.cgroup &&
      !live.some((o) => o !== r && [...o.scopes].some((x) => x !== r.scope) && o.cgroup === r.cgroup) &&
      !live.some((o) => o !== r && typeof o.cgroup === "string" && o.cgroup.startsWith(r.cgroup + "/"));
  }
  return named;
}
// Step 3: the peer read at the accept.
function peerRead(c: Checked) {
  const p = c.peer;
  if (!p.read || !(Number.isInteger(p.pid) && p.pid > 0) || p.uid !== "own") return false;
  return c.relay.selfTest === "pidfd" ? isObj(p.pidfd) : Number.isInteger(p.start);
}
// Step 6: the session check. The root that admits the connection, or null.
function sessionCheck(c: Checked, a: Applied<Roots | null>, scope: string, context: Record<string, Root[]> = {}) {
  const w = worldOf(c), p = c.peer, form = c.relay.selfTest;
  const alive = () => {
    const s = w.get(p.pid);
    if (!s || s.state === "Z") return false;
    if (form === "pidfd") { const pidfd = must(p.pidfd, `${c.note}: the pidfd of step 3`); return pidfd.poll === 0 && pidfd.fdinfoPid === p.pid; } // 1: readable (exited); -1: an error
    return s.start === p.start; // the stat form and the Mac: the start of the accept
  };
  if (!alive()) return null;
  const named = rootsThatCount(must(a.roots, `${c.note}: the roots of the peer check`), w, context);
  const at = walk(w, p.pid, named);
  let admitted: string | null = null;
  if (at !== null) {
    const r = must(named.get(at), at);
    admitted = r.counts && r.scope === scope && r.line ? at : null; // any other root refuses, whatever the cgroup says
  } else if (form !== "mac") {
    const cg = must(w.get(p.pid), `${c.note}: the live peer`).cgroup;
    for (const [k, r] of named) {
      if (r.scope === scope && r.line && r.cgroupCounts && typeof cg === "string" && (cg === r.cgroup || cg.startsWith(r.cgroup + "/"))) admitted = k;
    }
  }
  return admitted !== null && alive() ? admitted : null;
}
function admit(c: Check): string | 101 {
  const headers = c.request.headers ?? {};
  if (Object.hasOwn(headers, "origin")) return "fromPage"; // 1
  const url = new URL(c.request.path, "http://relay");
  const m = /^\/devtools\/browser\/(.*)$/.exec(url.pathname);
  if (!m || !(SCOPE.test(m[1]) || REMOTE.test(m[1]))) return "notFound"; // 2
  const scope = m[1];
  const relay = c.relay;
  // Stage 5 T2: a remote scope passes only from the service's own pid (c.service: the relay inside the service, with
  // the MCP's tickets); every other peer gets its 403 after step 3, and with no peer check after step 2.
  const remote = REMOTE.test(scope), own = c.peerCheck && c.service !== undefined && c.peer.pid === c.service.pid;
  if (remote && !c.peerCheck) return "remote";
  if (c.peerCheck) { // 3
    if (relay.selfTest === "failed") return "cannotRead";
    if (!peerRead(c)) return "peerUnread";
    if (remote && !own) return "remote";
  }
  // The blanket Chrome (board ab-4wh): the blanket scope's upgrade reads the blanket model, its link, bridge.info and line;
  // every other scope's reads the main model. The blanket model's step 4 has the blanket profile's texts.
  const blanket = toBlanket(c);
  const own4 = blanket ? must(relay.blanket, c.note) : relay;
  if (!own4.link) return blanket ? "blanketNotConnected" : "notConnected"; // 4
  if (own4.bridge === 0) return blanket ? "blanketTooOld" : "tooOld";
  if (own4.line === null) return blanket ? "blanketNotConnected" : "notConfirmed";
  if (own4.bridge === null) return blanket ? "blanketNotConnected" : "notConnected";
  const a = applyLine(endpoint.lines[own4.line], c.peerCheck, c.service !== undefined);
  if (a.failClosed) return "rootsWithout";
  if (c.peerCheck && !Object.hasOwn(a.scopes, scope)) return "noList"; // 5
  if (own) { if (c.service.ticket !== scope) return remote ? "remote" : "session"; } // 6: the ticket takes the walk's place
  else if (c.peerCheck && sessionCheck(c, relay.blanket ? { ...a, roots: gateRoots(c) } : a, scope, contextOf(c)) === null) return "session"; // 6
  if (a.listOf(scope) === null || (!blanket && (relay.ended ?? []).includes(scope))) return "noList"; // 7
  return c.request.upgrade === false ? "notFound" : 101; // 8: a plain request gets no connection
}
// The check's scope goes to the blanket model: the relay has the blanket Chrome, and the scope is its blanket scope now.
function toBlanket(c: Check): boolean {
  const b = c.relay.blanket, m = /^\/devtools\/browser\/(.*)$/.exec(new URL(c.request.path, "http://relay").pathname);
  return b !== undefined && b.scope !== null && m !== null && m[1] === b.scope;
}
// The gate's roots with the blanket Chrome (C11, the blanket profile: each model's line admits only its own scopes): of
// the main line, while the main link is up, each scope's but the blanket scope's; of the blanket line, while the blanket
// link is up, only the blanket scope's. The service's sessions (relay.sessions; boards ab-4wh.9 to ab-4wh.11, with or
// without the blanket Chrome) are the context of sessionCheck: they stop the walk and count for the rules, and admit no
// connection.
// The context of sessionCheck (C11, the service's sessions): the roots of the service's sessions by scope, and the roots
// of no scope (relay.contextRoots, board ab-4wh.12) as the roots of one scope that no line names (the empty name).
function contextOf(c: Check): Record<string, Root[]> {
  const out: Record<string, Root[]> = { ...(c.relay.sessions ?? {}) };
  if (c.relay.contextRoots) out[""] = c.relay.contextRoots;
  return out;
}
function gateRoots(c: Check): Roots {
  const b = must(c.relay.blanket, c.note), out: Roots = {};
  if (c.relay.link && c.relay.line !== null) for (const [scope, list] of Object.entries(applyLine(endpoint.lines[c.relay.line], true).roots)) if (scope !== b.scope) out[scope] = list;
  if (b.link && b.line !== null && b.scope !== null) { const list = applyLine(endpoint.lines[b.line], true).roots[b.scope]; if (list) out[b.scope] = list; }
  return out;
}

// A check's answer: an answer id, or 101 (the vectors' `{ "status": 101 }`).
const wantOf = (c: Check) => (typeof c.answer === "string" ? c.answer : c.answer.status);

test("before the upgrade: each check vector gets the answer of C11's order", () => {
  const seen = new Set<string | 101>();
  for (const c of endpoint.upgradeChecks) {
    const want = wantOf(c);
    assert.ok(want === 101 || Object.hasOwn(answerById, want), `${c.note}: a known answer`);
    assert.equal(admit(c), want, c.note);
    // With the blanket Chrome an upgrade names its model (board ab-4wh); without it, none.
    if (typeof c.answer === "object") assert.equal(c.answer.model, c.relay.blanket ? (toBlanket(c) ? "blanket" : "main") : undefined, `${c.note}: the model`);
    seen.add(want);
  }
  for (const a of [...endpoint.upgradeAnswers, ...endpoint.blanketAnswers]) assert.ok(seen.has(a.id), `a check vector for ${a.id}`);
  assert.ok(seen.has(101), "a vector of an upgrade");
  const steps = ["1. A request with an `Origin` header", "2. A path or scope that does not match", "3. With the peer check, the peer read", "4. The relay is not ready", "5. With the peer check, a scope that the last `allowlist` line does not name", "6. With the peer check, the session check", "7. A scope with no list"];
  for (const s of steps) assert.ok(C11.includes(s), `C11 has the step ${s}`);
  assert.ok(C11.includes("`upgradeChecks`") && C11.includes("`lineCloses`"), "C11 names the vectors");
  assert.equal(answerById.session.body.split("<pid>").length, 2, "the session's 403 holds the peer's pid once");
  for (const list of [[...endpoint.upgradeAnswers, ...endpoint.blanketAnswers], endpoint.closes.filter((c) => c.id)]) assert.equal(new Set(list.map((x) => x.id)).size, list.length, "each id once");
});

test("the session check: each world is a process table, and each rule of C11 has a vector", () => {
  for (const p of endpoint.procs) {
    assert.ok(["linux", "noScope", "mac"].includes(p.world), p.note);
    assert.ok(Number.isSafeInteger(p.pid) && p.pid > 0 && Number.isSafeInteger(p.ppid) && Number.isSafeInteger(p.start), p.note);
    assert.ok(["S", "R", "Z"].includes(p.state), p.note);
    assert.ok(p.world === "mac" ? p.cgroup === null : typeof p.cgroup === "string" && p.cgroup.startsWith("/"), `${p.note}: a cgroup on Linux only`);
  }
  for (const world of ["linux", "noScope", "mac"]) {
    const pids = endpoint.procs.filter((p) => p.world === world).map((p) => p.pid);
    assert.equal(new Set(pids).size, pids.length, `${world}: each pid once`);
  }
  for (const c of endpoint.upgradeChecks) {
    for (const k of Object.keys(c)) assert.ok(["note", "peerCheck", "relay", "request", "peer", "world", "procs", "answer"].includes(k), `${c.note}: a known field ${k}`);
    for (const k of Object.keys(c.relay)) assert.ok(["link", "bridge", "line", "selfTest", "ended", "blanket", "sessions", "contextRoots"].includes(k), `${c.note}: a known relay field ${k}`);
    for (const k of Object.keys(c.relay.blanket ?? {})) assert.ok(["scope", "link", "bridge", "line"].includes(k), `${c.note}: a known blanket field ${k}`);
    // relay.sessions (boards ab-4wh.9 to ab-4wh.11): the relay inside the service, so only with the peer check.
    if (c.relay.sessions || c.relay.contextRoots) assert.ok(c.peerCheck, `${c.note}: the service's sessions with the peer check`);
    if (typeof c.answer === "object") for (const k of Object.keys(c.answer)) assert.ok(["status", "model"].includes(k), `${c.note}: a known answer field ${k}`);
    for (const k of Object.keys(c.request)) assert.ok(["path", "headers", "upgrade"].includes(k), `${c.note}: a known request field ${k}`);
    for (const k of Object.keys(c.peer ?? {})) assert.ok(["read", "pid", "uid", "pidfd", "start"].includes(k), `${c.note}: a known peer field ${k}`);
    if (isObj(c.peer?.pidfd)) for (const k of Object.keys(c.peer.pidfd)) assert.ok(["poll", "fdinfoPid"].includes(k), `${c.note}: a known pidfd field ${k} (review-19b note 8)`);
  }
  const checked = endpoint.upgradeChecks.filter((c) => c.peerCheck);
  for (const c of checked) {
    assert.ok(["pidfd", "stat", "mac", "failed"].includes(c.relay.selfTest), `${c.note}: the self-test's result`);
    assert.ok(isObj(c.peer) && ["linux", "noScope", "mac"].includes(c.world), `${c.note}: a peer and a world`);
    assert.equal(c.relay.selfTest === "mac", c.world === "mac", `${c.note}: the Mac's form in the Mac's world`);
    if (c.relay.selfTest === "pidfd") assert.ok(Object.hasOwn(c.peer, "pidfd") && !Object.hasOwn(c.peer, "start"), c.note);
    if (["stat", "mac"].includes(c.relay.selfTest)) assert.ok(Object.hasOwn(c.peer, "start") && !Object.hasOwn(c.peer, "pidfd"), c.note);
  }
  for (const c of endpoint.upgradeChecks.filter((x) => !x.peerCheck)) assert.ok(!Object.hasOwn(c.relay, "selfTest") && !Object.hasOwn(c, "peer"), `${c.note}: no peer read without the peer check`);
  const by = (answer: string | 101, f: (c: (typeof checked)[number], w: World) => unknown) => checked.some((c) => wantOf(c) === answer && f(c, worldOf(c)));
  const proc = (c: Checked, w: World) => w.get(c.peer.pid);
  const chainTo = (c: Checked, w: World, pid: number) => { let x = c.peer.pid; for (let i = 0; i <= MAX_HOPS && w.has(x); i++) { if (x === pid) return i; x = must(w.get(x), `${x}`).ppid; } return -1; };
  const pidfdOf = (c: Checked) => must(c.peer.pidfd, `${c.note}: the pidfd`);
  const noteOf = (p: Pr | undefined) => (p === undefined ? undefined : must(p.note, `${p.pid}: a note`));
  // The peer read (step 3).
  assert.ok(by("peerUnread", (c) => !c.peer.read), "SO_PEERCRED fails");
  assert.ok(by("peerUnread", (c) => c.peer.read && c.relay.selfTest === "pidfd" && c.peer.pidfd === null), "SO_PEERPIDFD fails: the same 403 (review-54b note 1)");
  assert.ok(by("peerUnread", (c) => c.peer.pid === 0), "no pid");
  assert.ok(by("peerUnread", (c) => c.peer.uid !== "own"), "another uid");
  for (const form of ["stat", "mac"]) assert.ok(by("peerUnread", (c) => c.relay.selfTest === form && c.peer.start === null), `${form}: no start at the accept`);
  assert.ok(by("peerUnread", (c) => !c.relay.link), "the peer's 403 also while the link is down");
  assert.ok(by("cannotRead", (c) => !c.relay.link) && by("cannotRead", (c) => !c.peer.read), "the self-test's 503 also while not ready, before the peer's 403");
  assert.ok(by("fromPage", (c) => !c.peer.read) && by("notFound", (c) => !c.peer.read) && by("notFound", (c) => c.relay.selfTest === "failed"), "Origin and the 404 come before the peer read");
  // The alive checks (review-54b note 2: each counts alone).
  assert.ok(by("session", (c, w) => c.relay.selfTest === "pidfd" && proc(c, w)?.state === "Z" && pidfdOf(c).poll === 0 && pidfdOf(c).fdinfoPid === c.peer.pid), "Z before the pidfd polls readable");
  assert.ok(by("session", (c, w) => c.relay.selfTest === "pidfd" && pidfdOf(c).poll === 1 && proc(c, w)?.state !== "Z"), "a readable pidfd while the state is not Z");
  assert.ok(by("session", (c, w) => c.relay.selfTest === "pidfd" && pidfdOf(c).poll === -1 && pidfdOf(c).fdinfoPid === c.peer.pid && proc(c, w)?.state !== "Z"), "a poll that returns -1 (review-19 note 5)");
  assert.ok(by("session", (c, w) => c.relay.selfTest === "pidfd" && pidfdOf(c).poll === 0 && ![-1, c.peer.pid].includes(pidfdOf(c).fdinfoPid) && proc(c, w)?.state !== "Z"), "an fdinfo pid that is not -1 and not the peer's (review-19 V10)");
  for (const c of checked.filter((x) => x.relay.selfTest === "pidfd" && isObj(x.peer.pidfd))) assert.ok([0, 1, -1].includes(pidfdOf(c).poll) && Number.isInteger(pidfdOf(c).fdinfoPid), `${c.note}: poll and fdinfoPid`);
  assert.ok(by("session", (c, w) => c.relay.selfTest === "pidfd" && pidfdOf(c).fdinfoPid === -1 && proc(c, w)?.state !== "Z"), "an fdinfo pid of -1");
  for (const form of ["stat", "mac"]) {
    assert.ok(by("session", (c, w) => { const p = proc(c, w); return c.relay.selfTest === form && p && p.start !== c.peer.start; }), `${form}: a start that changed`);
    assert.ok(by("session", (c, w) => { const p = proc(c, w); return c.relay.selfTest === form && p?.state === "Z" && p.start === c.peer.start; }), `${form}: Z`);
  }
  assert.ok(by("session", (c, w) => c.relay.selfTest === "stat" && !proc(c, w)), "stat: the pid has gone by the walk");
  assert.ok(by("session", (c, w) => c.relay.selfTest === "pidfd" && !proc(c, w)), "pidfd: the pid has gone");
  // The walk and the cgroup.
  const scopeOf = (c: Check) => must(new URL(c.request.path, "http://relay").pathname.split("/").pop(), c.note);
  assert.ok(by(101, (c) => (applyLine(namedLine(c.relay.line), true).roots[scopeOf(c)] ?? []).some((r) => r.pid === c.peer.pid)), "the pane's process itself (hop 0)");
  assert.ok(by(101, (c, w) => c.world === "mac" && chainTo(c, w, 4000) === MAX_HOPS) && by("session", (c, w) => c.world === "mac" && w.get(c.peer.pid)?.ppid === 4032), "a root at hop 32 counts, at hop 33 not");
  assert.ok(by(101, (c, w) => c.world === "linux" && noteOf(parentOf(w, proc(c, w)))?.startsWith("systemd --user")), "the pane's cgroup admits a re-parented peer");
  assert.ok(by("session", (c, w) => c.world === "mac" && parentOf(w, proc(c, w))?.note === "launchd"), "the Mac: no cgroup for a re-parented peer");
  assert.ok(by("session", (c, w) => c.world === "noScope" && proc(c, w)?.ppid === 1144) && by(101, (c) => c.world === "noScope"), "no scope of its own: the walk only");
  assert.ok(by("session", (c, w) => c.world === "noScope" && proc(c, w)?.ppid === 1144 && [...w.values()].filter((p) => p.ppid === 3000).length === 1), "a lone pane in its parent's cgroup: the cgroup does not count");
  assert.ok(by(101, (c, w) => (c.procs ?? []).some((p) => p.pid === 3100 && !p.gone && p.ppid === 3200)), "the walk passes a pid whose start is not the root's");
  assert.ok(by("session", (c, w) => { const g = proc(c, w)?.cgroup; return g?.startsWith("/user.slice/user-1001.slice/user-1001-manager.service/app.slice/tmux-spawn-1a2b.scope") && !g.startsWith("/user.slice/user-1001.slice/user-1001-manager.service/app.slice/tmux-spawn-1a2b.scope/") && g !== "/user.slice/user-1001.slice/user-1001-manager.service/app.slice/tmux-spawn-1a2b.scope"; }), "a cgroup name that is no path under the root's");
  assert.ok(by(101, (c, w) => proc(c, w)?.cgroup?.endsWith(".scope/job")), "a cgroup under the root's");
  for (const [answer, line, what] of [["session", "peerSharedRoot", "two scopes name a root"], [101, "peerSharedRoot", "the other root of such a scope counts"], ["session", "peerServerRoot", "an ancestor of another root"], [101, "peerServerRoot", "the root under it counts"],
    ["session", "peerNested", "a nested cgroup"], ["session", "peerNoRoots", "a line with no roots"], ["session", "peerNoLead", "a scope with no root"], [101, "peerLeadTwice", "a root named twice by one scope"], [101, "peerTwoPanes", "a second pane"]] satisfies [string | 101, string, string][]) {
    assert.ok(by(answer, (c) => c.relay.line === line), `${what} (${line})`);
  }
  assert.ok(by("session", (c) => (c.procs ?? []).some((p) => p.pid === 3200 && p.cgroup?.endsWith("tmux-spawn-1a2b.scope"))), "a cgroup that a root of another scope shares");
  // review-19 B1, B2: a shared root from both scopes; an ancestor root's cgroup, for a peer whose walk does not pass it; a walk
  // that stops at a root that does not count, for a peer in the cgroup of a root of the scope that counts.
  const shared = applyLine(endpoint.lines.peerSharedRoot, true).roots;
  const sharedRoot = must(shared["md-lead"].find((r) => shared["md-worker"].some((o) => o.pid === r.pid && o.start === r.start)), "the shared root");
  for (const sc of ["md-lead", "md-worker"]) assert.ok(by("session", (c, w) => c.relay.line === "peerSharedRoot" && scopeOf(c) === sc && chainTo(c, w, sharedRoot.pid) >= 0), `a shared root, from ${sc}`);
  const server = applyLine(endpoint.lines.peerServerRoot, true).roots["md-worker"][0];
  assert.ok(by("session", (c, w) => c.relay.line === "peerServerRoot" && chainTo(c, w, server.pid) < 0 && proc(c, w)?.cgroup === must(w.get(server.pid), "the server root").cgroup), "an ancestor root's cgroup admits no one (F2)");
  assert.ok(by("session", (c, w) => c.relay.line === "peerSharedRoot" && scopeOf(c) === "md-worker" && chainTo(c, w, sharedRoot.pid) >= 0 && shared["md-worker"].some((r) => r.pid !== sharedRoot.pid && proc(c, w)?.cgroup === must(w.get(r.pid), `${r.pid}`).cgroup)), "the walk stops at a root that does not count, whatever the cgroup (F3)");
  assert.ok(by("session", (c) => c.relay.line === "peerUnnamedShares" && Object.keys(applyLine(endpoint.lines.peerUnnamedShares, true).roots).some((sc) => !Object.hasOwn(objectOf(endpoint.lines.peerUnnamedShares.scopes, "the scopes of peerUnnamedShares"), sc))), "a root of a scope that scopes does not name counts for the defensive rules (V21)");
  assert.ok(by("session", (c, w) => c.relay.line === "peer" && (c.procs ?? []).some((p) => p.pid === 3100 && !p.gone && p.start === 6000 && !w.has(p.ppid)) && proc(c, w)?.ppid === 1144), "a root whose parent the relay cannot read: no cgroup (V19)");
  assert.ok(by("session", (c, w) => { const a = proc(c, w); return (c.procs ?? []).some((p) => p.pid === a?.ppid && !p.gone && p.start > a.start); }) && by(101, (c, w) => { const a = proc(c, w); return (c.procs ?? []).some((p) => p.pid === a?.ppid && p.start === a.start); }), "a parent later than its child stops the walk; the same start does not (note 7)");
  assert.ok(by("session", (c) => c.relay.line === "peerLeadNull" && (c.procs ?? []).some((p) => p.pid === 3100 && p.gone)), "the ended session with 5 b: the session's 403 after the line (note 2)");
  // review-19b note 2: the walk compares each parent with its own child (hop 1 is later than hop 2, the peer is later than both).
  assert.ok(by("session", (c, w) => { const a = proc(c, w), b = parentOf(w, a), d = parentOf(w, b); return a && b && d && b.start < a.start && d.start > b.start && a.start > d.start; }), "a parent later than its child, though not later than the peer (note 2)");
  // review-19b note 7: the ancestor rule compares a root's parent with the root.
  assert.ok(by(101, (c, w) => { const all = Object.values(applyLine(namedLine(c.relay.line), true).roots).flat(); return all.some((r) => { const x = w.get(r.pid), up = parentOf(w, x); return x && up && up.start > x.start && all.some((o) => o.pid === x.ppid && o.start === up.start); }); }), "a root whose parent is a root that started later: no ancestor (note 7)");
  // The refusal after end_scope is step 7, and a plain request has the same order.
  assert.ok(checked.some((c) => c.answer === "noList" && (c.relay.ended ?? []).includes(scopeOf(c))) && by("session", (c) => (c.relay.ended ?? []).includes(scopeOf(c))), "an ended scope: step 6 before step 7");
  assert.ok(endpoint.upgradeChecks.some((c) => !c.peerCheck && c.answer === "noList" && (c.relay.ended ?? []).includes(scopeOf(c))), "an ended scope without the peer check");
  for (const answer of ["notFound", "session", "noList"]) assert.ok(checked.some((c) => c.request.upgrade === false && c.answer === answer), `a plain request gets ${answer} with the peer check`);
  assert.ok(endpoint.upgradeChecks.some((c) => !c.peerCheck && c.request.upgrade === false && c.answer === "notFound"), "a plain request that is admitted gets the 404");
  assert.ok(endpoint.upgradeChecks.every((c) => c.request.upgrade !== false || wantOf(c) !== 101), "a plain request never gets an upgrade");
  assert.ok(by("session", (c) => (c.procs ?? []).some((p) => p.pid === 3100 && !p.gone && p.start !== 6000)), "a root pid with another start");
  assert.ok(by("session", (c) => c.peer.pid === 3203 && c.request.path.endsWith("/md-lead")) && by(101, (c) => c.peer.pid === 3203 && c.request.path.endsWith("/md-worker")), "the walk decides over a joined cgroup");
  assert.ok(by(101, (c) => c.peer.pid === 3302 && c.request.path.endsWith("/md-lead")), "the cost: the server path counts as the server's session (review-54)");
  // The roots' life: the session's end (ab-6gs) and a respawn.
  assert.ok(by("session", (c) => c.relay.line === "peer" && (c.procs ?? []).some((p) => p.pid === 3100 && p.gone)), "the session ended, before the line: the session's 403");
  assert.ok(checked.some((c) => c.answer === "noList" && c.relay.line === "peerLeadGone" && c.request.path.endsWith("/md-lead")), "the session ended, after the line: the no-list 503");
  assert.ok(by("session", (c) => c.relay.line === "peerRespawned") && by(101, (c) => c.relay.line === "peerRespawned"), "after a respawn: the old pane's job refused, the new pane's agent admitted");
  // Step 6 comes before step 7, and step 5 before step 6.
  assert.ok(by("session", (c) => c.request.path.endsWith("/md-none")) && checked.some((c) => c.answer === "noList" && c.request.path.endsWith("/md-none")), "step 6 before step 7");
  assert.ok(checked.some((c) => c.answer === "noList" && c.peer.pid === 3500), "step 5 before step 6");
});

test("the refusal after end_scope: each sequence follows C11", () => {
  const ids = new Set(Object.keys(endpoint.lines));
  let admits = 0, refuses = 0;
  for (const c of endpoint.endScopes) {
    let ended = new Set<string>(), line: Applied<Roots | null> | FailClosed | null = null;
    for (const st of c.steps) {
      if (st.line !== undefined) {
        assert.ok(ids.has(st.line), `${c.note}: a known line`);
        line = applyLine(endpoint.lines[st.line], c.peerCheck);
        for (const sc of [...ended]) if (Object.hasOwn(must(line.scopes, c.note), sc)) ended.delete(sc); // a line that names it, also with null
      } else if (st.endScope !== undefined) {
        ended.add(st.endScope);
      } else {
        assert.equal(st.restart, true, c.note);
        ended = new Set();
        line = null;
      }
    }
    assert.ok(line !== null, `${c.note}: a line came`);
    const refused = (c.peerCheck && !Object.hasOwn(must(line.scopes, c.note), c.scope)) || ended.has(c.scope) || must(line.listOf, c.note)(c.scope) === null;
    assert.equal(refused ? "noList" : "admit", c.answer, c.note);
    if (refused) refuses++; else admits++;
  }
  assert.ok(admits >= 4 && refuses >= 4, "both answers");
  const has = (f: (c: (typeof endpoint.endScopes)[number]) => unknown) => endpoint.endScopes.some(f);
  assert.ok(has((c) => !c.peerCheck && c.answer === "admit" && c.steps.some((s) => s.line === "plainLeadDropped") && c.steps.some((s) => s.line === "plainLeadNull")), "5 b: the default list admits the scope after the null entry is dropped");
  assert.ok(has((c) => c.peerCheck && c.answer === "noList" && c.steps.some((s) => s.line === "peerLeadGone")), "with the peer check, an unnamed scope gets the no-list 503");
  assert.ok(has((c) => c.answer === "noList" && c.steps.some((s) => s.line === "plainLeadDropped") && !c.steps.some((s) => s.line === "plainLeadNull")), "a line that does not name the scope keeps the refusal");
  assert.ok(has((c) => c.answer === "admit" && c.steps.some((s) => s.restart)) && has((c) => c.answer === "noList" && c.steps.some((s) => s.restart)), "the limit: a restart loses the set; a replayed null entry is safe");
  assert.ok(has((c) => c.answer === "admit" && c.steps.some((s) => s.restart) && c.steps[c.steps.length - 1].line === "plainLeadDropped"), "the limit: after a restart a line that does not name the scope admits it by default");
  assert.ok(has((c) => c.answer === "admit" && c.steps.some((s) => s.endScope === "md-worker")), "an end_scope of another scope does not touch this one");
});

test("at each allowlist line: each close vector follows C11", () => {
  for (const c of endpoint.lineCloses) {
    const scope = c.connection.scope;
    const a = applyLine(endpoint.lines[c.line], c.peerCheck);
    let got: string | null = null;
    if (a.failClosed || (c.peerCheck && !Object.hasOwn(a.scopes, scope)) || a.listOf(scope) === null) got = "noList";
    else if (c.peerCheck) {
      const roots = must(a.roots, `${c.note}: the roots of the peer check`);
      if (!(Object.hasOwn(roots, scope) && roots[scope].some((r) => r.pid === c.connection.root.pid && r.start === c.connection.root.start))) got = "root";
    }
    assert.equal(got, c.close, c.note);
    assert.equal(c.connection.root === null, !c.peerCheck, `${c.note}: a root with the peer check only`);
  }
  for (const id of ["noList", "root"]) {
    assert.equal(closeById[id]?.code, 1008, id);
    assert.ok(endpoint.lineCloses.some((c) => c.close === id), `a vector for ${id}`);
  }
  assert.ok(endpoint.lineCloses.some((c) => c.close === null), "a vector of a connection that stays");
  assert.ok(endpoint.lineCloses.some((c) => c.close === null && c.line === "peerSharedRoot"), "an open connection stays when another scope names its root too");
  assert.ok(endpoint.lineCloses.some((c) => c.close === "root" && applyLine(endpoint.lines[c.line], true).roots[c.connection.scope]?.some((r) => r.pid === must(c.connection.root, c.note).pid && r.start !== must(c.connection.root, c.note).start)), "the same pid with another start closes");
});

// The blanket profile's vectors (C11, the blanket profile; board ab-4wh, its cases from board ab-4wh.7): C11's texts, the
// model of each scope, a holder change, the lines of the blanket shape, the closes on the blanket model and the refusals.
test("the blanket profile's vectors follow C11: its two texts of step 4, the model by scope, a holder change, the blanket shape, the closes and the refusals with their texts", () => {
  const B = flat(part(C11, "The blanket profile (board ab-4wh"));
  // Step 4's two texts are C11's, each in the blanket part.
  assert.deepEqual(endpoint.blanketAnswers.map((a) => [a.id, a.status]), [["blanketNotConnected", 503], ["blanketTooOld", 503]]);
  for (const a of endpoint.blanketAnswers) assert.ok(B.includes(`\`${a.body}\``), `C11's blanket part has ${a.body}`);
  assert.ok(B.includes("Else the answer is a 503 with one of these bodies"), "C11: a 503");
  assert.ok(says(C11, "The vectors. Board ab-4wh.4 adds the blanket scope's cases to `test/vectors/endpoint.json`."), "C11 names the vectors");
  // The lines of the blanket shape: "*" only there, with no entries of the lists.
  const star = applySetScopes(endpoint.lines.blanket);
  assert.deepEqual([star.listOf("md-worker"), star.refused, star.listOf("md-lead")], ["*", 0, null], "the blanket line gives md-worker \"*\" and no other scope a list");
  assert.deepEqual([applySetScopes(endpoint.lines.blanketOther).listOf("md-lead"), applySetScopes(endpoint.lines.blanketEnd).listOf("md-worker")], ["*", null]);
  const wrong = applySetScopes(endpoint.lines.blanketWrongShape);
  assert.deepEqual([wrong.listOf("md-worker"), wrong.refused, Object.hasOwn(wrong.scopes, "md-worker")], [null, 1, true], "a \"*\" next to a list applies as null and counts 1");
  for (const name of ["blanket", "blanketEnd", "blanketOther", "blanketRespawned"]) assert.ok(blanketShape(endpoint.lines[name]) || Object.keys(objectOf(endpoint.lines[name].scopes, name)).length === 0, `${name}: the blanket shape`);
  assert.ok(!Object.hasOwn(objectOf(endpoint.lines.blanketMain.scopes, "blanketMain"), "md-worker"), "the main line leaves the blanket scope out");
  for (const [why, line] of [["a list", { ...endpoint.lines.blanket, lists: { md: ["a.example"] } }], ["a default", { ...endpoint.lines.blanket, default: "md" }], ["the operator's \"*\"", { ...endpoint.lines.blanket, operator: "*" }],
    ["two scopes", { ...endpoint.lines.blanket, scopes: { "md-worker": "*", "md-lead": null } }], ["9 excluded names", { ...endpoint.lines.blanket, exclude: Array.from({ length: 9 }, (_, i) => `n${i}.example.net`) }],
    ["an excluded IP address", { ...endpoint.lines.blanket, exclude: ["10.0.0.1"] }], ["an excluded name with upper case", { ...endpoint.lines.blanket, exclude: ["Box"] }]] satisfies [string, JsonObject][]) {
    assert.equal(applySetScopes(line).listOf("md-worker"), null, why);
  }
  // The cases: each model, each text, a holder change and the session check across the two lines.
  const cases = endpoint.upgradeChecks.filter((c) => c.relay.blanket !== undefined);
  const scopeOf = (c: Check) => must(new URL(c.request.path, "http://relay").pathname.split("/").pop(), c.note);
  const has = (f: (c: (typeof cases)[number]) => unknown) => cases.some(f);
  assert.ok(cases.length >= 15 && cases.every((c) => c.peerCheck), "the blanket cases run with the peer check (the relay inside the service)");
  assert.ok(has((c) => typeof c.answer === "object" && c.answer.model === "blanket") && has((c) => typeof c.answer === "object" && c.answer.model === "main"), "each model takes a connection");
  assert.ok(has((c) => typeof c.answer === "object" && c.answer.model === "blanket" && !c.relay.link), "the blanket scope does not wait for the main link");
  assert.ok(has((c) => c.answer === "notConnected" && toBlanket(c) === false && must(c.relay.blanket, c.note).link), "another scope keeps the main text while the blanket link is ready");
  for (const id of ["blanketNotConnected", "blanketTooOld"]) assert.ok(has((c) => c.answer === id && toBlanket(c)), `the blanket scope gets ${id}`);
  for (const f of [(b: { link: boolean }) => !b.link, (b: { line: string | null }) => b.line === null, (b: { bridge: number | null }) => b.bridge === null]) assert.ok(has((c) => c.answer === "blanketNotConnected" && f(must(c.relay.blanket, c.note))), "each way the blanket model is not ready");
  const lineScope = (c: Check) => { const b = must(c.relay.blanket, c.note); return b.line === null ? null : Object.keys(objectOf(endpoint.lines[b.line].scopes, b.line))[0] ?? null; };
  assert.ok(has((c) => c.answer === "noList" && c.relay.blanket?.scope !== null && lineScope(c) !== c.relay.blanket?.scope && scopeOf(c) === lineScope(c)), "a holder change: the old holder goes to the main model");
  assert.ok(has((c) => c.answer === "noList" && toBlanket(c) && lineScope(c) !== scopeOf(c)), "a holder change: the new holder before its line");
  assert.ok(has((c) => typeof c.answer === "object" && c.answer.model === "blanket" && c.relay.blanket?.line === "blanketOther"), "after the holder change: the new holder reaches the blanket model");
  assert.ok(has((c) => c.answer === "noList" && c.relay.blanket?.scope === null), "no holder: the main model");
  assert.ok(has((c) => c.answer === "session" && toBlanket(c)) && has((c) => c.answer === "session" && !toBlanket(c)), "the session check across the two lines, both ways");
  assert.ok(has((c) => c.answer === "noList" && c.relay.blanket?.line === "blanketWrongShape") && has((c) => c.answer === "session" && c.relay.blanket?.line === "blanketWrongShape"), "a \"*\" of another shape: step 6, then step 7");
  // The closes on the blanket model: the reference of lineCloses reads the same lines.
  const closes = endpoint.lineCloses.filter((c) => c.peerCheck && c.model === "blanket");
  for (const id of [null, "noList", "root"]) assert.ok(closes.some((c) => c.close === id), `a blanket close ${id}`);
  assert.ok(closes.some((c) => c.line === "blanketEnd" && c.close === "noList") && closes.some((c) => c.line === "blanketOther" && c.close === "noList"), "the end and a holder change close the old holder's connection");
  // The refusals: C11's texts, the host in the text of the public host class.
  const NOT_PUBLIC = "Not allowed: <host> is not a public host name. A session with a blanket approval opens public host names only: no IP address, no localhost, no single-label name, no name under .local, .internal, .home.arpa or .localdomain, and no name of this box.";
  assert.ok(B.includes(`\`${NOT_PUBLIC}\``), "C11's text of a host outside the class");
  const refusalOf = new Map(endpoint.refusals.map((r) => [r.method, r.error]));
  for (const r of endpoint.blanketRefusals) {
    assert.equal(r.session, "root", r.method);
    const url = typeof r.params.url === "string" ? new URL(r.params.url) : null;
    if (r.error.startsWith("Not allowed: ")) assert.equal(r.error, NOT_PUBLIC.replace("<host>", must(url, r.method).hostname), `${r.method} ${url}`);
    else if (r.method === "Target.createBrowserContext") assert.equal(r.error, refusalOf.get(r.method), "the refusal of this file stays");
    else assert.ok(B.includes(`\`${r.error}\``), `C11's blanket part has ${r.error}`);
  }
  for (const m of ["Browser.grantPermissions", "AgentBrowser.signIn", "AgentBrowser.signIns", "Target.createBrowserContext"]) assert.ok(endpoint.blanketRefusals.some((r) => r.method === m), m);
  assert.ok(endpoint.blanketRefusals.some((r) => (r.params.url as string | undefined)?.includes(must(endpoint.lines.blanket.exclude as string[] | undefined, "exclude")[1])), "a name of this box (the line's exclude)");
});

// Boards ab-4wh.9 to ab-4wh.11 (the review of ab-4wh.7, C1; the review of ab-4wh.9, m3; aw-lead's note on ab-4wh.9): the
// peer check's rule of the service's sessions, and the code that does it: the relay's gate takes the service's sessions,
// on every service, as roots that stop the walk and count for the rules, with the roots of each session that ended since
// the last set_sessions, and only a line's roots admit.
test("boards ab-4wh.9 to ab-4wh.11: C11 says that the gate holds every session's roots at all times on every service, also of a session that ended since the last set_sessions, and that only a scope's own line admits it, and the relay and the service do so", () => {
  const B = part(C11, "The blanket profile (board ab-4wh");
  for (const t of ["stay as this file says. Each model's line admits only its own scopes.",
    "The service's sessions (the defensive root rules; boards ab-4wh.9 to ab-4wh.11) count also while a line is not there: the blanket Chrome is stopped, or a link is down.",
    "So a process of a nested session whose roots the service holds, or under a root that two such sessions name, never passes as another scope."]) assert.ok(says(B, t), `C11's blanket part: ${t}`);
  assert.ok(!says(C11, "with one addition to the peer check (board ab-4wh.9)") && !says(C11, "less a session that has ended since"), "C11's old words are gone");
  const rules = C11.slice(C11.indexOf("- The defensive root rules."), C11.indexOf("- The roots' life (the daemon;"));
  // The review of ab-4wh.12, m2: the item's heading names board ab-4wh.12 too.
  assert.ok(!says(rules, "The service's sessions (boards ab-4wh.9 to ab-4wh.11)."), "the item's old heading is gone");
  for (const t of ["The service's sessions (boards ab-4wh.9 to ab-4wh.12). The relay inside the service also holds the roots of every local session of the service's last `set_sessions` (C12), and of each session that ended since, until the next `set_sessions`.",
    "It reads them again after each `set_sessions` and `session_ended`, and when its agent door opens.",
    "Each of these roots stops the walk and takes part in the rules above under its own scope, also while a line does not carry it: a link is down, the receiver has not confirmed the push of a new snapshot yet, or the line leaves the scope out.",
    "Such a root admits no connection: only a root of the scope in its own model's line admits it.",
    "So a process of a session whose roots the service holds never passes as another scope, also when no line carries them.",
    // The review of ab-4wh.10, I1, closed by board ab-4wh.12 (aw-lead's shape, 2026-11-26): the roots of no scope.
    "The daemon sends no item for a launch name that two live sessions share (C12). To a service whose hello lists the feature `context_roots` it sends the roots of such sessions in `context_roots`, with no scope (C12; board ab-4wh.12), and on the Mac the service adds the roots of each session whose name it drops for a case twin (C12, `set_sessions`).",
    "The relay holds each of them as a root of one scope that no line names: it stops the walk and takes part in the rules above, it admits no connection, and each `set_sessions` replaces it.",
    "So a process of such a session never passes as another scope either, and a root of it under a root of another scope makes that root an ancestor (the rule above).",
    "When the daemon sends no `context_roots` (a daemon or a service without the feature), the service holds no roots of such a session, and a process of it under a root of another scope still passes as that scope.",
    "A root whose process has exited changes no answer, so the roots of an ended session refuse only while its pane's process still runs.",
    // The review of ab-4wh.10, m2: a kept root under a root of another scope.
    "While such a root lives under a root of another scope, that root is an ancestor (the rule above), so the processes of that scope also get the session's 403 until the next `set_sessions`.",
    // Board ab-4wh.13: the MCP path's walk reads the same roots (below).
    "The MCP path's walk (the admission of the MCP path, step 2; board ab-4wh.13) reads the same roots.",
    "The relay of `agent-browser relay` has none of these roots."]) assert.ok(says(rules, t), `C11's defensive root rules: ${t}`);
  assert.ok(!says(C11, "so the service holds no roots of such a session, and a process of it under a root of another scope still passes as that scope (board ab-4wh.12, the daemon side)."), "C11's gap sentence of ab-4wh.10 is gone (board ab-4wh.12)");
  assert.ok(!says(C11, "So a process of a session whose root no line carries never passes as another scope.") && !says(C11, "So a process of a nested session, or under a root that two sessions name, never passes as another scope."), "C11 claims no more than the code does (the review of ab-4wh.10, I1)");
  assert.ok(says(C12P, "One scope appears at most once in `sessions`") && says(C12P, "the daemon sends no item for a launch name that two live sessions have"), "C12: no item for a shared launch name");
  // The review of ab-4wh.10, m3: the check before a start at a use reads the ended roots too. (The text of the start at a
  // use itself stays: three records of earlier reviews hold it exactly, contracts-c12.test.ts.)
  assert.ok(says(rules, "The service's session check before a start at a use (the start at a use, above) reads the same roots, also of each session that ended since, and the roots of no scope."), "C11: the check before a start at a use");
  assert.ok(says(C12P, "drops its roots from the model's line (the relay's gate and the MCP path's walk keep them as roots that admit no connection until the next `set_sessions`: C11, the service's sessions)"), "C12's session_ended (board ab-4wh.13: also the MCP path's walk)");
  // aw-lead's decision on the window of board ab-4wh.11: the reason in the peer check's design (its limits).
  assert.ok(says(readOr("docs/superpowers/specs/2026-11-05-peer-admission-design.md"), "The relay's gate and the MCP path's walk (board ab-4wh.13) keep them as roots that refuse only until the next `set_sessions`: a longer hold would refuse the own processes of the session above it for that time (the ancestor rule), and agentwatch ends a session's processes with its tmux session. A daemonized left-over process is the edge case, and this short window is enough."), "the design says why the window ends at the next set_sessions");
  const endpointTs = readOr("src/relay/endpoint.ts"), peerTs = readOr("src/relay/peer.ts"), serviceTs = readOr("src/service/service.ts"), doorTs = readOr("src/service/agent-door.ts");
  // Every relay with a gate takes the service's sessions as the context, with or without the blanket Chrome.
  assert.ok(endpointTs.includes("const context = o.sessions?.() ?? new Map();") && endpointTs.includes("if (!blanket) { gate.setRoots(mainLine, context); return; }") && endpointTs.includes("gate.setRoots(own, context);"), "the relay gives the gate the service's sessions as the context");
  assert.ok(!endpointTs.includes("if (!gate || !blanket) return;"), "no context only with the blanket Chrome");
  assert.ok(doorTs.includes("...(o.sessions ? { sessions: o.sessions } : {})"), "the agent door passes the sessions on");
  // The service: every agent door gets them, the state reads them again after each set_sessions and session_ended (not
  // the blanket part), and the roots of an ended session stay until the next set_sessions.
  assert.ok(serviceTs.includes("sessions: () => state.contextRoots(),") && !serviceTs.includes("addressCheck, sessions:"), "the service gives every agent door the context roots");
  assert.ok(serviceTs.includes("sessionsChanged: () => (agent as (AgentDoor & { relay: Relay }) | null)?.relay.sessionsChanged() });"), "the state's hook reads them again");
  assert.ok(!readOr("src/service/blanket/part.ts").includes("changed?: () => void"), "the refresh does not depend on the blanket part");
  const handle = serviceTs.slice(serviceTs.indexOf("  handle(req: Req): Answer | Promise<Answer> {"));
  // The review of ab-4wh.10, m4: the refresh runs in a finally, also when a part throws.
  assert.ok(handle.includes('if (req.op !== "set_sessions" && req.op !== "session_ended") return this.op(req);') && handle.includes("try { return this.op(req); } finally { this.changed(); }"), "after set_sessions and after session_ended, in a finally");
  assert.ok(serviceTs.split("RootState.read(peerReader, state.roots(), state.contextRoots())").length === 3, "both checks before a start at a use read the ended roots as context");
  const end = serviceTs.slice(serviceTs.indexOf("  private endScope("));
  assert.ok(end.indexOf("this.endedRoots.set(scope") >= 0 && end.indexOf("this.endedRoots.set(scope") < end.indexOf("this.sessions = this.sessions.filter((s) => s.scope !== scope);"), "endScope keeps the ended session's roots");
  assert.ok(handle.indexOf("this.endedRoots = new Map();") > 0 && handle.indexOf("this.endedRoots = new Map();") < handle.indexOf("this.endScope(scope, \"set_sessions\")"), "set_sessions drops them");
  const read = peerTs.slice(peerTs.indexOf("static read(reader: PeerReader, roots: Roots, context: Roots = new Map()): RootState {"));
  assert.ok(read.length > 0 && read.indexOf("for (const [scope, list] of roots) {") > read.indexOf("const byScope"), "only the line's roots admit (byScope)");
});

// Board ab-4wh.12 (aw-lead's shape, 2026-11-26): the roots of no scope (C12's context_roots, and the Mac's dropped case
// twins) reach the relay's gate under one key that no scope has, and the vectors hold them on Linux and in the Mac's form.
test("board ab-4wh.12: the roots of no scope reach the relay's gate under the empty name, which no scope has, and only with the hello's feature; the vectors hold them on Linux and in the Mac's form", () => {
  const peerTs = readOr("src/relay/peer.ts"), serviceTs = readOr("src/service/service.ts");
  assert.ok(peerTs.includes('export const NO_SCOPE = "";'), "the key of no scope");
  assert.ok(!new RegExp(endpoint.scope.pattern).test(""), "no scope is the empty name");
  assert.ok(serviceTs.includes("if (this.noScope.length > 0) out.set(NO_SCOPE, this.noScope.map((r) => ({ ...r })));"), "contextRoots gives them under NO_SCOPE");
  assert.ok(serviceTs.includes("this.takesContextRoots && Array.isArray(req.context_roots)"), "only with the feature");
  const set = serviceTs.slice(serviceTs.indexOf('      case "set_sessions": {'));
  assert.ok(set.indexOf("this.noScope = unnamed.map(") > 0 && set.indexOf("this.noScope = unnamed.map(") < set.indexOf("this.eachPart((p) => p.setSessions?.(kept));"), "each set_sessions replaces them");
  const cases = endpoint.upgradeChecks.filter((c) => c.relay.contextRoots);
  assert.ok(cases.some((c) => c.world === "linux" && c.answer === "session") && cases.some((c) => c.world === "mac" && c.answer === "session"), "a refusal on Linux and in the Mac's form");
});

// Board ab-4wh.13 (the review of ab-4wh.10, m5; the stated limit of ab-4wh.12): the MCP path's walk keeps the same roots
// that refuse as the relay's gate, from the one source (the state's contextRoots): an ended session's roots until the
// next set_sessions, and the roots of no scope. The texts of C11 say so, the old limit is gone, and the code does so.
test("board ab-4wh.13: C11 says that the MCP path's walk reads the roots of the service's sessions, also of an ended session and of no scope, and the port reads them from the gate's own source", () => {
  const rules = C11.slice(C11.indexOf("- The defensive root rules."), C11.indexOf("- The roots' life (the daemon;"));
  // The review of ab-4wh.13, m2: a root admits only while it counts.
  assert.ok(says(rules, "There a root of a session of the last `set_sessions` admits its scope while it counts (the rules above), and the roots of each session that ended since and the roots of no scope admit no connection."), "C11's service's sessions: the MCP path");
  assert.ok(!says(C11, "The MCP path's walk reads its own snapshot of `set_sessions`") && !says(C11, "with no root of `context_roots`"), "the stated limit of ab-4wh.12 is gone");
  const adm = part(C11, "The admission of the MCP path (from stage 1d;");
  for (const t of ["The walk reads the roots of the service's sessions (the defensive root rules, above; board ab-4wh.13), as the relay's gate does.",
    "A root of a session of the last `set_sessions` admits its scope while it counts (the defensive root rules).",
    "A root of a session that ended since, until the next `set_sessions`, and a root of no scope stop the walk and admit no connection.",
    // The review of ab-4wh.13, m1: the MCP path's own close at a change, for a root that a set_sessions puts under a root.
    "A `set_sessions` can put a root of another session, or a root of no scope (`context_roots`, or on the Mac a dropped case twin's root), under a root that admitted an MCP connection (board ab-4wh.13).",
    "That root then no longer counts (the ancestor rule), so the service closes the connection and ends the MCP sessions of its scope, but the scope's open connections of the endpoint stay."]) assert.ok(says(adm, t), `C11's admission of the MCP path: ${t}`);
  assert.ok(!says(adm, "`set_sessions` admits its scope. ") && !says(rules, "`set_sessions` admits its scope, and"), "no root admits with no condition (m2)");
  // The review of ab-4wh.13, m4: C12's session_ended and the design note name the MCP path's walk too.
  assert.ok(says(C12P, "the relay's gate and the MCP path's walk keep them as roots that admit no connection until the next `set_sessions`") && says(readOr("docs/superpowers/specs/2026-11-05-peer-admission-design.md"), "The relay's gate and the MCP path's walk (board ab-4wh.13) keep them as roots that refuse only until the next `set_sessions`"), "C12 and the design note (m4)");
  const serviceTs = readOr("src/service/service.ts"), portTs = readOr("src/service/mcp/port.ts"), partTs = readOr("src/service/mcp/part.ts"), admTs = readOr("src/service/mcp/admission.ts");
  assert.ok(serviceTs.includes("context: () => state.contextRoots(),"), "the service gives the MCP part the gate's source");
  assert.ok(partTs.includes("...(this.o.context ? { context: this.o.context } : {})"), "the part gives it to the port");
  assert.ok(portTs.includes("mcp_token: s.mcp_token ?? null })), this.o.context?.());") && portTs.includes("this.snapshot.without(walkReader(this.reader), scope, this.o.context?.());"), "the port reads it at set_sessions and session_ended");
  assert.ok(admTs.includes("RootState.read(reader, new Map([...items].map(([scope, s]) => [scope, s.roots])), context)"), "only the items admit; the context refuses");
});

// Where a call goes (C11's table): the model, Chrome, or a refusal. The methods of the sign-in act (board ab-v16.97.1) are
// the service's model's from stage 1e part 2 (`act`: a model with the act): on the root the model answers them then,
// and before that they are outside the set. On a page session they are refused in each model (review-112 B6). The
// routing vectors give both: `to` for today's model (the relay's), and `withAct` for a model with the act.
const SIGN_IN_METHODS = ["AgentBrowser.signIn", "AgentBrowser.signIns"];
function route(session: string, method: string, params: JsonObject = {}, child = false, act = false) {
  if (session === "root") return endpoint.modelSet.includes(method) || (act && SIGN_IN_METHODS.includes(method)) ? "the model" : "refused";
  // The client's mark of a secret (board ab-t30.22): the one AgentBrowser.* call that the model answers on a page session.
  if (method === "AgentBrowser.setSecretInput") return "the model";
  if (/^AgentBrowser\./.test(method)) return "refused";
  if (method === "Target.setAutoAttach") return "Chrome";
  if (method === "Target.getTargetInfo") return params.targetId === undefined ? "Chrome" : "the model";
  if (method === "Target.detachFromTarget") return child ? "Chrome" : "the model";
  if (/^(Target|Browser)\./.test(method)) return endpoint.pageModelSet.includes(method) ? "the model" : "refused";
  return "Chrome";
}

test("C11's table says where each call of the model's set goes, and the routing vectors agree", () => {
  const rows = table(C11, "| Method | On the root or a browser session | On a page session |");
  assert.deepEqual([...rows.keys()].sort(), [...endpoint.modelSet, ...SIGN_IN_METHODS].sort());
  for (const m of SIGN_IN_METHODS) assert.deepEqual(rows.get(m), ["the model", "refused"], `${m}: the model; refused on a page session`);
  for (const [method, cells] of rows) {
    assert.equal(cells[0], "the model", method);
    assert.ok(cells[1].startsWith(route("page", method)), `${method}: ${cells[1]}`);
  }
  for (const r of endpoint.routing) {
    assert.equal(route(r.session, r.method, r.params, r.child === true), r.to, `${r.session} ${r.method} ${JSON.stringify(r.params)}`);
    if (r.withAct !== undefined) assert.equal(route(r.session, r.method, r.params, r.child === true, true), r.withAct, `${r.session} ${r.method}: with the act`);
  }
  // Each method of the sign-in act has a routing row on the root and on a page session (review-112 B6).
  for (const m of SIGN_IN_METHODS) for (const session of ["root", "page"]) assert.ok(endpoint.routing.some((r) => r.method === m && r.session === session && r.withAct !== undefined), `${session} ${m}: a routing row`);
  for (const m of endpoint.pageModelSet) assert.ok(endpoint.modelSet.includes(m), m);
});

// A refusal template of C11 as a regular expression: each <placeholder> stands for one word.
const templateRe = (t: string) =>
  new RegExp("^" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/<[a-z]+>/g, "[^ ]+") + "$");

test("C11 states every refusal template, and each refusal vector follows one", () => {
  for (const t of endpoint.templates) assert.ok(C11.includes("`" + t + "`"), `C11 has \`${t}\``);
  const res = endpoint.templates.map(templateRe);
  for (const r of endpoint.refusals) {
    const hits = res.filter((re) => re.test(r.error));
    assert.equal(hits.length >= 1, true, `${r.method}: ${r.error}`);
    assert.ok(["root", "page"].includes(r.session), r.method);
    if (!r.example) assert.ok(C11.includes("`" + r.method + "`") || C11.includes("`" + r.method.split(".")[0] + ".*`"), `C11 names ${r.method}`);
  }
});

// The refusals of C11 that depend on the params (page marks, cookies, URLs, contexts). A param is any JSON value: a
// pattern reads it as its text (String, as RegExp's test and exec do).
const MAIN_WORLD = (name: unknown) => typeof name !== "string" || name === "";
const NAVIGATE_OK = (url: unknown) => url === "about:blank" || /^(https?|data):/i.test(String(url)) || /^blob:https?:\/\//i.test(String(url));
const NEW_TAB_OK = (url: unknown) => url === undefined || url === "" || url === "about:blank" || /^https?:/i.test(String(url));
const schemeOf = (url: unknown) => /^([a-z][a-z0-9+.-]*:)/i.exec(String(url))?.[1].toLowerCase() ?? "relative";
const named = (list: unknown, re: RegExp) => Array.isArray(list) && list.some((h) => isObj(h) && re.test(String(h.name)));
// binaryResponseHeaders: base64 of name\0value\0name\0value...
const binaryNamed = (b64: unknown, re: RegExp) => {
  if (typeof b64 !== "string") return false;
  const parts = Buffer.from(b64, "base64").toString("utf8").split("\0");
  return parts.some((p, i) => i % 2 === 0 && re.test(p));
};
const COOKIE = /^cookie$/i;
const SET_COOKIE = /^set-cookie$/i;
// The scope's list of the samples (C11, the refusals): a navigation of the main frame, a new tab, a
// grant with an origin, off the list.
const onList = (host: string) => endpoint.scopeList.some((d) => host === d || host.endsWith("." + d));
const webHost = (url: unknown) => {
  const u = /^blob:/i.test(String(url)) ? String(url).slice(5) : String(url);
  if (!URL.canParse(u)) return null;
  const p = new URL(u);
  return /^https?:$/.test(p.protocol) ? p.hostname : null;
};
const offList = (url: unknown) => {
  const h = webHost(url);
  return h !== null && !onList(h);
};
const mainFrame = (params: JsonObject) => params.frameId === undefined || params.frameId === endpoint.mainFrameId;
function paramRefusal(method: string, params: JsonObject = {}) {
  switch (method) {
    case "Page.addScriptToEvaluateOnNewDocument": return MAIN_WORLD(params.worldName);
    case "Runtime.addBinding": return MAIN_WORLD(params.executionContextName);
    case "Storage.clearDataForOrigin":
    case "Storage.clearDataForStorageKey":
      return String(params.storageTypes ?? "").split(",").map((s) => s.trim()).some((s) => s === "cookies" || s === "all");
    case "Network.setExtraHTTPHeaders": return isObj(params.headers) && Object.keys(params.headers).some((h) => COOKIE.test(h));
    // A paused request's new URL: the scheme rule of Page.navigate (board ab-t30.29).
    case "Fetch.continueRequest": return named(params.headers, COOKIE) || (params.url !== undefined && !NAVIGATE_OK(params.url));
    // The receiver has access to local files (board ab-t30.27): a client loads only a web page's URL (board ab-t30.29).
    case "Network.loadNetworkResource": return !NAVIGATE_OK(params.url ?? "");
    case "Fetch.fulfillRequest":
    case "Fetch.continueResponse":
      return named(params.responseHeaders, SET_COOKIE) || binaryNamed(params.binaryResponseHeaders, SET_COOKIE);
    case "Page.navigate": return !NAVIGATE_OK(params.url ?? "") || (mainFrame(params) && offList(params.url ?? ""));
    case "Target.createTarget": {
      const ctx = params.browserContextId;
      return (ctx !== undefined && ctx !== endpoint.defaultContext) || !NEW_TAB_OK(params.url) || offList(params.url ?? "");
    }
    case "Browser.grantPermissions": return params.origin === undefined ? null : offList(params.origin);
    default: return null;
  }
}

test("the refusals and passes that depend on the params follow C11's rules", () => {
  for (const r of endpoint.refusals) {
    const hit = paramRefusal(r.method, r.params);
    if (hit !== null) assert.equal(hit, true, `refused: ${r.method} ${JSON.stringify(r.params)}`);
    // A URL refusal names the URL's scheme, or "relative".
    if (/ URLs \(/.test(r.error)) assert.ok(r.error.includes(`browser: ${schemeOf(r.params.url)} URLs (${r.method})`), r.error);
    // A refusal off the scope's list names the host.
    if (r.error.startsWith("Not allowed: ")) assert.equal(r.error, `Not allowed: ${webHost(r.params.url ?? r.params.origin)} is not on the allowlist`, r.method);
  }
  for (const p of endpoint.passes) {
    assert.notEqual(paramRefusal(p.method, p.params), true, `passes: ${p.method} ${JSON.stringify(p.params)}`);
  }
  assert.ok(endpoint.refusals.some((r) => /^file:/.test(String(r.params?.url ?? ""))), "S12: a file: URL is refused");
  assert.ok(endpoint.refusals.some((r) => schemeOf(r.params?.url ?? "x:") === "relative"), "a relative URL is refused");
  assert.ok(endpoint.passes.some((p) => p.method === "Target.createTarget" && p.params.url === ""), "an empty url is about:blank");
  // The refusals per scope (C11): the main frame, a blob: inner origin, a new tab, and a frame passes.
  const offRefused = endpoint.refusals.filter((r) => r.error.startsWith("Not allowed: "));
  assert.ok(offRefused.some((r) => r.method === "Page.navigate" && r.params.frameId === undefined), "the main frame with no frameId");
  assert.ok(offRefused.some((r) => r.method === "Page.navigate" && r.params.frameId === endpoint.mainFrameId), "the main frame by its frameId");
  assert.ok(offRefused.some((r) => r.method === "Page.navigate" && /^blob:/.test(String(r.params.url))), "a blob: URL");
  assert.ok(offRefused.some((r) => r.method === "Target.createTarget"), "a new tab");
  assert.ok(endpoint.passes.some((p) => p.method === "Page.navigate" && p.params.frameId !== undefined && !mainFrame(p.params) && offList(p.params.url)), "a frame's navigation passes (O11)");
});

// Board ab-t30.29: no client reads a local file through Chrome, now that the receiver has access to local files (board
// ab-t30.27; C12, the agent package). The changed rows (old, then new) and the new sentences.
test("ab-t30.29: C11 refuses each call that loads a client's url by the scheme rule, and PWA.*, because the receiver has access to local files", () => {
  const F = flat(C11);
  for (const [old, now] of [
    ["| Calls outside the model's set; extensions; the old interception | A call that the table above refuses; `Extensions.*`; `Target.exposeDevToolsProtocol`; `Network.setRequestInterception` |",
      "| Calls outside the model's set; extensions; installed web apps; the old interception | A call that the table above refuses; `Extensions.*`; `PWA.*` (board ab-t30.29); `Target.exposeDevToolsProtocol`; `Network.setRequestInterception` | `Not available in the agent browser: <method>.` |"],
    ["| `chrome://` pages, other extensions' pages, local files | `Page.navigate` with a `url` that is not `about:blank`",
      "| `chrome://` pages, other extensions' pages, local files | `Page.navigate`, `Network.loadNetworkResource` and `Fetch.continueRequest` (board ab-t30.29) with a `url` that is not `about:blank` and whose scheme is not `http:`, `https:` or `data:`, and is not `blob:` with an `http:` or `https:` inner origin;"],
  ]) {
    assert.ok(!F.includes(old), `the old row is gone: ${old.slice(0, 80)}`);
    assert.ok(F.includes(now), `C11 says: ${now.slice(0, 80)}`);
  }
  for (const s of [
    "No client reads a local file through Chrome (board ab-t30.29).",
    "The receiver that the service installs on Linux has access to local files (C12, the agent package; board ab-t30.27), and Chrome lets a client with that access load a `file:` URL with `Network.loadNetworkResource` and read its stream with `IO.read`.",
    "So the model refuses each call that loads a client's `url` by the row above, on any session: `Page.navigate` (a tab or a frame), `Network.loadNetworkResource`, `Fetch.continueRequest` (a paused request's new URL) and `Target.createTarget`.",
    "It refuses `PWA.*` too (an installed app's install from a bundle file and its launch with local files).",
    "A client's own file choice stays: `DOM.setFileInputFiles` and the `data.files` of `Input.dispatchDragEvent`, with the stage's rule for files (above).",
    "`Page.getResourceContent`, `Page.searchInResource`, `Network.getResponseBody` and `IO.read` give only what a page or a call already loaded.",
    "Chrome itself blocks a page's own navigation to a `file:` URL (a link, a redirect, `window.open`); the MCP's live check measures it (`test/live/mcp-live/check.ts`, point 11).",
  ]) assert.ok(F.includes(s), `C11 says: ${s}`);
  // Each refused call has a refusal vector with C11's text.
  for (const m of ["Network.loadNetworkResource", "Fetch.continueRequest"])
    assert.ok(endpoint.refusals.some((r) => r.method === m && /^file:/.test(String(r.params.url ?? "")) && r.error === `Not available in the agent browser: file: URLs (${m}). Agent mode opens web pages only.`), `a file: vector of ${m}`);
  assert.ok(endpoint.refusals.some((r) => r.method.startsWith("PWA.") && r.error === `Not available in the agent browser: ${r.method}.`), "a PWA.* vector");
  assert.ok(endpoint.passes.some((p) => p.method === "Network.loadNetworkResource" && /^https:/.test(String(p.params.url))), "a web page's URL loads");
});

test("every cookie call of C11 is a refusal vector", () => {
  for (const m of endpoint.cookieMethods) {
    assert.ok(C11.includes("`" + m + "`"), `C11 names ${m}`);
    assert.ok(endpoint.refusals.some((r) => r.method === m), `a refusal vector for ${m}`);
  }
});

test("C11 states the limits of the cookie rule", () => {
  for (const s of endpoint.cookieLimits) assert.ok(C11.includes(s), `C11 says: ${s}`);
});

// The cookie marker of C11, at any depth: Cookie and Set-Cookie values and rawCookieLine
// become the marker, the cookie lists [].
const COOKIE_HEADER = /^(cookie|set-cookie)$/i;
const LISTS = ["associatedCookies", "blockedCookies", "exemptedCookies"];
const HEADER_OBJECTS = ["headers", "requestHeaders"];
const HEADER_LISTS = ["headers", "responseHeaders"];
const HEADER_TEXTS = ["headersText", "requestHeadersText"];
const RAW_LINES = ["rawCookieLine"];
function hide(x: Json, marker: string): Json {
  if (Array.isArray(x)) return x.map((y) => hide(y, marker));
  if (!isObj(x)) return x;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(x)) {
    if (LISTS.includes(k) && Array.isArray(v)) out[k] = [];
    else if (HEADER_OBJECTS.includes(k) && isObj(v)) out[k] = Object.fromEntries(Object.entries(v).map(([h, s]) => [h, COOKIE_HEADER.test(h) ? marker : s]));
    else if (HEADER_LISTS.includes(k) && Array.isArray(v)) out[k] = v.map((h) => (isObj(h) && COOKIE_HEADER.test(String(h.name)) ? { ...h, value: marker } : h));
    else if (HEADER_TEXTS.includes(k) && typeof v === "string") out[k] = v.replace(/^((?:set-)?cookie):[^\r\n]*/gim, `$1: ${marker}`);
    else if (RAW_LINES.includes(k) && typeof v === "string") out[k] = marker;
    else out[k] = hide(v, marker);
  }
  return out;
}

test("each cookie marker vector follows C11's rule", () => {
  assert.ok(C11.includes("`" + endpoint.cookieMarker + "`"), "C11 names the marker");
  for (const name of [...LISTS, ...HEADER_OBJECTS, ...HEADER_LISTS, ...HEADER_TEXTS, ...RAW_LINES]) {
    assert.ok(C11.includes("`" + name + "`"), `C11 names ${name}`);
  }
  assert.ok(endpoint.cookieHide.length > 0);
  for (const v of endpoint.cookieHide) {
    assert.ok(/^(Network|Fetch|Audits)\./.test(v.method), v.method);
    assert.ok(C11.includes("`" + v.method + "`"), `C11 names ${v.method}`);
    assert.notDeepEqual(v.in, v.out, `${v.method}: the vector hides something`);
    assert.deepEqual(hide(v.in, endpoint.cookieMarker), v.out, v.method);
  }
  for (const m of ["Network.webSocketHandshakeResponseReceived", "Audits.issueAdded"]) {
    assert.ok(endpoint.cookieHide.some((v) => v.method === m), `a vector for ${m}`);
  }
  assert.ok(endpoint.cookieHide.some((v) => Object.hasOwn(v.in, "redirectResponse")), "a vector for redirectResponse");
});

test("C11 states the refusal after end_scope, its order and the plain request", () => {
  for (const t of [
    "From the `end_scope` on, the relay refuses each new connection of that scope with the no-list 503 (step 7), also over a link change, until a later `allowlist` line names the scope again",
    "also with a `null` entry",
    "without the peer check the `default` list then admits the scope again, and with the peer check step 5 gives it the no-list 503",
    "The relay keeps this set of ended scopes in memory only.",
    "the line that the daemon replays to a restarted relay must not name an ended scope with a list",
    "With the peer check this refusal is step 7 too, after the session check: a process of another session gets the session's 403 first",
    "8. A request that passes steps 1 to 7 and is no WebSocket upgrade (a plain HTTP request)",
    "So a plain request gets the same checks in the same order as an upgrade, and the 404 only when the scope is admitted.",
    "`endScopes` in `test/vectors/endpoint.json`",
  ]) assert.ok(says(C11, t), t);
  assert.ok(says(C11, "gets no connection: the 404 of step 2"), "step 8: the 404");
});

test("C11 holds review-19b's notes", () => {
  assert.ok(says(C11, "The daemon does not hold a respawn for that `ok` (review-19b note 3)"), "note 3");
  assert.ok(says(C11, "the agent gets the 503 of step 4 (`its extension has not confirmed the allowlist`)"), "note 3: step 4");
  assert.ok(says(C11, "the peer's parent (the relay's own pid) and the peer's start time"), "note 4");
  assert.ok(says(C11, "With 5 b it gets the session's 403 only until the line of C4's rule 3 drops the `null` entry"), "note 5");
  assert.ok(says(C11, "after the rule 3 line the scope is unnamed and step 5 gives the no-list 503 (review-19b note 5)"), "note 5: step 5");
  assert.ok(says(C11, "a parent whose start time is later than the other root's start time (on the Mac: whose `p_uniqueid` is later; board ab-v16.52) is no parent, so it is no ancestor; review-19b note 7"), "note 7");
});

// C11 is the shared implementation contract (board ab-v16.82).
for (const sentence of [
  "The relay retains a union of at most 128 world ids per tab as refusal candidates, including worlds in the back-forward cache.",
  "The relay never evicts a retained id while the tab stays in the model.",
  "Geometry reads, navigation, context destruction, context clearing and a client's world creation keep all retained ids.",
  "The tab's removal or a link reset clears the retained state.",
  "On the tab's own session only, the relay drops the world's `Runtime.executionContextCreated` by its name, records its id within the bound, and adds the id to the event filter.",
  "A separate set filters the current document's `Runtime.executionContextDestroyed`, `Debugger.scriptParsed` and `Debugger.scriptFailedToParse` events.",
  "Each geometry read replaces this event filter with its current world.",
  "A dropped `Runtime.executionContextDestroyed` removes its id from the event filter only.",
  "A context of another name, or a successful answer to a client's `Page.createIsolatedWorld` on the tab's own session, releases that id from the event filter only.",
  "A context clear or a main-frame navigation resets the event filter and still reaches the client.",
  "These event-filter changes never remove a retained refusal candidate, so a client can see its own context's events after renderer reuse.",
  "The relay refuses a client's call into its own isolated world before the call reaches Chrome (agent-browser PR #72 and PR #85).",
  "The check runs when the call goes to Chrome, so a call behind an activation step uses the world that the step's read made.",
  "The check applies on the tab's own session to integer `contextId` and `executionContextId` values, including `Runtime.evaluate`, `Runtime.callFunctionOn`, `DOM.resolveNode` and `Runtime.compileScript`.",
  "The same 3-level search also reads `contextId` and `executionContextId` in nested objects and lists.",
  "It also reads `objectId`, `callFrameId` and each key whose name ends in `ObjectId`, at the top level and in nested objects and lists down to 3 levels.",
  "These paths include `Runtime.callFunctionOn` arguments and `Debugger.setVariableValue`'s `newValue`.",
  "The relay extracts the context from V8's object-id and call-frame-id form `<isolate>.<ctx>.<n>`, with an optional minus sign on the isolate and decimal integers in all three parts.",
  "The refusal depends on that form: another form, including the old JSON form `{\"injectedScriptId\":...}`, names no context for this check.",
  "The check does not read `uniqueContextId`, so the protection also depends on keeping the world's unique id and name hidden from clients.",
  "The relay's own reads use `returnByValue`, and their answers never go to a client.",
  "The error code is `-32000`, with this exact text (`<method>` is the client's method): `Not available in the agent browser: the relay's own isolated world (<method> names its execution context, or an object or a call frame in it). Use the page's main world or a world of your own (Page.createIsolatedWorld).`",
  "`Runtime.runIfWaitingForDebugger` is exempt because it runs no code in a context and must release a held tab.",
  "Child sessions are exempt because each numbers its contexts on its own.",
  "Calls that name no context are exempt.",
  "Before a call that names a retained id, the relay resolves its private world on the current main frame with `Page.createIsolatedWorld`.",
  "This native lookup runs no script and enables no domain.",
  "Chrome returns the existing world's id for that document, or creates the world when the document has none with that name.",
  "The returned id joins the retained union within the same 128-id bound.",
  "A native lookup also adds its returned id to the event filter.",
  "The relay refuses the call when it names the returned current id.",
  "A numeric id reused for a client's context in another renderer stays usable, and the cached renderer's world stays protected when it returns.",
  "At 128 retained ids, the relay checks every context-bearing call with the same native lookup, retains all 128 ids and allocates no more entries.",
  "Newly created or restored worlds thus stay protected after the bound.",
  "A failed lookup, a malformed answer, a lost frame, a removed tab, a detach or a wait beyond `GEOMETRY_WAIT_MS = 200` ms refuses the call.",
  "A late lookup answer never forwards the call.",
  "The tab's later forwarded calls wait behind the lookup and the first call's submission or refusal, including later calls with no context and navigations.",
  "The gate opens after submission or refusal and does not wait for an ordinary CDP answer, so a dialog or held target can receive its release command.",
  "Activation steps also wait for lookup and submission.",
  "A `Page.bringToFront` keeps its bounded reply wait, including when the tab read fails.",
  "A client's world with a reused id pays one native lookup round trip on each call that names it, potentially for the tab's lifetime.",
  "Each lookup can hold later calls for up to 200 ms.",
  "With an old daemon, or on the Mac, the relay makes no world and this check refuses nothing.",
  "A call can reach Chrome between the world's first `Page.createIsolatedWorld` in a document and its answer.",
  "A navigation can commit between the native lookup and the forwarded client call, or between world creation and the geometry evaluate.",
  "These separate CDP commands are not atomic: retention closes the cache-restore gap between geometry reads, but the navigation races and object-id format dependency remain.",
  "The relay records a device-metrics set or clear when it sends the call to Chrome, before Chrome answers.",
  "A set that Chrome refuses counts as an override until its clear or a detach."
]) {
  test(`C11 states: ${sentence}`, () => assert.ok(says(C11, sentence), sentence));
}

test("C11 defines unexplained change exactly once", () => {
  assert.equal((C11.replace(/\s+/g, " ").match(/An unexplained change is/g) ?? []).length, 1);
});

test("C11 removes the replaced review-32d and one-set rules", () => {
  for (const sentence of [
    "On the tab's own session only, the relay drops the world's `Runtime.executionContextCreated` by its name and records its id within the bound.",
    "A context of another name, or a client's successful `Page.createIsolatedWorld` answer, releases that id from the event filter only.",
    "The tab's later calls to Chrome wait behind the lookup and the first call's submission or refusal, including later calls with no context and navigations.",
    "(step 6, after the raise of step 7)",
    "The front page decides, not the focus, and the raise (step 7) sends `windows.update` with `{\"focused\":true}` also to a focused window.",
    "Each read replaces the set of the world's ids with its new id.",
    "On the tab's own session only, the relay drops the world's `Runtime.executionContextCreated` (by the world's name, for any id; the id joins the set), and `Runtime.executionContextDestroyed`, `Debugger.scriptParsed` and `Debugger.scriptFailedToParse` of the ids in the set, so no client sees the world.",
    "An id that left the set is no longer the relay's: its events go to the client as any page's events (also a `Runtime.executionContextDestroyed` of the relay's old world, of a context that the client never saw created; a client ignores an id that it does not know).",
    "`Runtime.executionContextsCleared` empties the set and still goes to the client.",
    "An id that stays in the set until the next read can name a page's context after a navigation, and the relay then drops that page's own events of that id (`Runtime.executionContextDestroyed`, `Debugger.scriptParsed` and `Debugger.scriptFailedToParse`)."
  ]) assert.ok(!says(C11, sentence), `C11 removes: ${sentence}`);
});

for (const sentence of [
  "The front page, the page under the pointer: the page of the last activation step that made it the front page (by the rule of step 6, when step 7's raise succeeds), or a new tab that comes on top, with no raise (a new active tab that opens a window, or that becomes the active tab of the front page's window); unknown at the relay's start, at a link change, at its `tabs.onRemoved` or `tabs.onReplaced`, after failed reads of step 1, after a raise that reached its limit or that failed for an input or a `Page.bringToFront`, and after any client's `Browser.setWindowBounds` (below).",
  "The front page decides, not the focus, and for an input the raise (step 7) sends `windows.update` with `{\"focused\":true}` also to a focused window."
]) {
  test(`C11 corrects: ${sentence}`, () => assert.ok(says(C11, sentence), sentence));
}

// ---- C11 in this repository, and the parts of the self-contained agent browser (board ab-v16.94.1) ----

// The part of C11 from a bold heading to the next bold heading, or "" when it is missing (so each assertion fails alone).
const partOr = (heading: string) => (C11.includes(`**${heading}`) ? part(C11, heading) : "");
const sayAll = (text: string, list: string[]) => { for (const s of list) assert.ok(says(text, s), `C11 says: ${s}`); };

test("C11's master is this file since board ab-v16.94.1: where the text and the vectors came from, the names of the other contracts, the parties", () => {
  assert.ok(C11.startsWith("# C11. The endpoint (agent-browser's relay; from stage 3 also the service)\n"), "the heading: the service serves only from stage 3");
  sayAll(partOr("The master of C11 (board task ab-v16.94.1)."), [
    "This file is the master for C11 since board task ab-v16.94.1, stage 0 of the self-contained agent browser.",
    "Its text came from chrome-extension `docs/protocol.md` (main `66078cd`), where C11 was before, with no change of a rule.",
    "That file keeps a short C11 that names this file.",
    "The vectors came with the text: this repository's `test/vectors/endpoint.json` is a copy of chrome-extension's `test/vectors/endpoint.json` at `66078cd`, and it is the master of C11's vectors from then on.",
    "In this file, C1 to C10 are the contracts of chrome-extension `docs/protocol.md`, and `test/vectors/scopes.json` and `test/vectors/bridge.json` are chrome-extension's vectors of C4 and C10.",
    "C12 is the control door, `docs/contracts/C12.md`.",
    "C11 binds this repository (the relay, and the service, which stage 1 builds and which serves from stage 3) and agentwatch (the daemon). The receiver's own rules stay in C4, C5 and C10.",
  ]);
  assert.ok(!says(C11, "from stage 1 the service") && !says(C11, "from stage 1 also the service"), "no text puts the service as a party before stage 3");
  // The old intro's own sentence still holds here, and the text names this repository's vectors.
  assert.ok(says(C11, "This file is the master for C11. The vectors: `test/vectors/endpoint.json`."), "the old intro's sentence");
  // The moved sentence stays, and the new one after it separates the endpoint from the MCP port (review-95 N3).
  assert.ok(says(partOr("The socket and the URL."), "A path is at most 103 bytes. There is no TCP port. The endpoint has no TCP port; the MCP port of stage 1d is a separate port (the MCP path, below)."), "the endpoint has no TCP port");
});

test("C11 states the stages of the self-contained agent browser, and that stage 0 changes no rule", () => {
  sayAll(partOr("The self-contained agent browser (board ab-v16.94)."), [
    "The self-contained design is `docs/superpowers/specs/2026-11-09-self-contained-agent-browser-design.md`, and its section 19 records the operator's answers of 2026-11-10.",
    "Stage 0 changes no rule of this file.",
    "| The endpoint of this file at the endpoint path that the daemon gives, with every rule of this file, on a box whose switch is on | agent-browser's service (`agent-browser service`), in place of the relay | stage 3 (stage 1 builds it, off by default) |",
    "| The MCP path over loopback TCP and its admission (the MCP path, below) | agent-browser's service | stage 1d builds it, off by default; it serves sessions from stage 3 |",
    "| The MCP's allow list (`docs/contracts/mcp-allow-list.md`) | agent-browser's service | stage 1d |",
    "| The per-session MCP configuration (how a session gets the MCP, below) | agentwatch | stage 2 builds it, off by default |",
    "| The per-session tokens: the daemon mints and holds; the service checks a fingerprint from `set_sessions` (the token design) | agentwatch and agent-browser's service | stage 1d (the service) and stage 2 (agentwatch) |",
    "| The remote MCP path for a session of another box | agentwatch and agent-browser's service | stage 5: direct HTTPS with a remote token and the address check (the token design, section 10) |",
    "The token design, `docs/superpowers/specs/2026-11-10-mcp-connection-tokens-design.md` (board ab-v16.94.10), adds a connection token for each session to the MCP path, with the operator's answers of 2026-11-10 (the MCP path, below).",
    "Until stage 3, and on a box whose switch is off, the relay (`agent-browser relay`, the daemon's child) serves the endpoint, and the daemon is its other party, as the rest of this file says.",
    "From stage 3, on a box whose switch is on, the service serves the endpoint at the same path, with the same rules, in place of the relay.",
    "The daemon's lines to the relay (C10, the daemon and the relay) then become the service's own state: C12's `set_sessions` gives the sessions, their repos and their roots, from which the service builds the lists and the scopes, and C12's `session_ended` gives the end of a scope.",
    "The readiness, the answers, the closes and the refusals stay as this file says.",
    "From stage 3, on a box whose switch is on, `browser.control: false` (C12, `config`) makes the service answer each request on the endpoint and on the MCP path with 503 `The agent browser is off: the operator turned agent control off.`",
    "This answer is the first check of the readiness: step 4 before the upgrade, and step 8 of the MCP path's admission (below). Today the endpoint does not exist then (the self-contained design, section 14).",
  ]);
  for (const old of ["stage 5 (the self-contained design, section 9; this file has no rule for it yet)", "and step 7 of the MCP path's admission"]) assert.ok(!says(C11, old), `C11: no ${old} (the token design)`);
});

test("C11 states the MCP path over loopback TCP (the operator's answer Q1, ab-bi3), its URL, its label scope and its held port", () => {
  sayAll(partOr("The MCP path (from stage 1d; the operator's answer Q1 of board item ab-bi3, 2026-11-10)."), [
    "The service serves the standard Playwright MCP (the answer Q4) over Streamable HTTP on a loopback TCP port. Nothing serves it before stage 1d, and no session gets it before stage 3.",
    "The operator confirmed HTTP and added connection tokens (board item ab-6ng), one for each session (ab-0wv): the token design gives the rules.",
    "The URL is `http://127.0.0.1:<port>/mcp/<scope>`. The service listens on `127.0.0.1` only, on one port for each OS user and box. It holds no `[::1]` port.",
    "No secret is in the URL. A session's own MCP configuration holds the session's connection token in the `Authorization` header (`Bearer abt1_...`), in a 0600 file under agentwatch's tokens folder, and each request carries it only there.",
    "The service reads a token only from the `Authorization` header, never from the URL: a token in the query gives the request no token (the first 401 of step 7), and a token in the path is no scope of the connection (step 6).",
    "The scope in the path is a label, and it gives no right: the walk decides the scope (the admission, below).",
    "A request whose path names another scope than the walk's gets the session's 403. A request to `/mcp` alone names no scope, and the walk's scope applies.",
    "A local session reaches the MCP only through this URL. No stdio shim runs for it.",
    "On the endpoint's Unix socket the MCP path serves no local session: a request for `/mcp` there gets the 404 of step 2, as today.",
    "The port stays held while the service is down, so another OS user cannot listen on it, and no connection ever starts `agent-browser.service`.",
    "On Linux a systemd user socket unit holds the port, and the service takes its socket from that unit; while the service is down, a connection waits with no answer (fail closed).",
    "The units are the daemon lead's proposal, which stage 1d proves (the self-contained design, section 19, build note 1).",
    // Board ab-v16.94.6: the Mac's TCP peer reader is built; board ab-v16.94.32: the Mac check measured it (MAC_PORT_GATE).
    "The Mac's port gate is open: the Mac check measured the Mac's TCP peer reader (board ab-v16.94.32), so on the Mac the port admits a connection by the same steps as on Linux (the admission, below).",
    "The reader is built (board ab-v16.94.6): for steps 1 and 2 it reads each socket of each process of the service's user with `proc_pidinfo` (`PROC_PIDLISTFDS`) and `proc_pidfdinfo` (`PROC_PIDFDSOCKETINFO`).",
    // Board ab-v16.94.29: the line's uid is the holders' real uid; the socket's soi_stat.vst_uid read 0 at the Mac check.
    "The client's line is the IPv4 TCP socket whose local and remote addresses are the full tuple; its holders are the processes that hold it, and its uid is the real uid of its holders (`proc_pidinfo`, `PROC_PIDTBSDINFO`).",
    "When two holders have different real uids, or the service cannot read a holder's uid, the line's uid matches no user, and the connection gets the peer's 403 (fail closed).",
    "The reader does not use the socket's own `soi_stat.vst_uid`: the Mac check read 0 there for each socket (board ab-v16.94.29). The walk reads `proc_pidinfo`, and orders by `p_uniqueid` as the endpoint's walk does on the Mac (board ab-v16.52).",
  ]);
  assert.ok(!says(C11, "its uid is the uid of the user that made the socket"), "C11: the Mac's line uid is no longer the socket's maker's uid");
  for (const old of ["Board item ab-6ng asks the operator to check this reading", "No secret is in the URL or in a session's MCP configuration", "no key and no token"]) assert.ok(!says(C11, old), `C11: no ${old} (the token design)`);
});

test("C11 states the admission of the MCP path: the uid by the full tuple first, then the walk, before any request byte; Origin, Host, path, label, readiness; the pid, the closes and the limits", () => {
  sayAll(partOr("The admission of the MCP path (from stage 1d; the daemon lead's conditions for the TCP choice)."), [
    "At each new TCP connection the service runs these checks in this order. The first check that fails gives its answer at once, and the service then closes the connection. Steps 1 and 2 run before the service reads any byte of the request.",
    "1. The uid. The service finds the client's socket in `/proc/net/tcp` by the full tuple: the local address is the client's address and port, and the remote address is `127.0.0.1:<port>`.",
    "Exactly one line must match; no line or more than one gets the peer's 403. (A match by the client's port alone can match the service's own accepted socket.)",
    "The service reads the uid column of that line. A uid other than the service's gets the peer's 403 (`The agent browser cannot tell which program connects, so it refuses the connection.`), before any other check.",
    "2. The walk. The service finds each process that holds the socket's inode (`/proc/<pid>/fd`), and walks each holder by the rules of the scope's session (above).",
    "Each holder must reach a root that counts, and all holders the roots of one scope: that scope is the connection's scope.",
    "No holder gets the peer's 403, which names no pid. A process whose `/proc/<pid>/fd` the service cannot read (a process of another user, or a process that is not dumpable) is no holder for this check: when no other process holds the socket, the connection gets the peer's 403. A holder that reaches no root, or holders of two scopes get the session's 403. So the walk refuses a browser process: Chrome is no session's process.",
    "The service then reads the client's line of `/proc/net/tcp` again, and a line that changed gets the session's 403 too.",
    "The connection's scope gives its session, and `set_sessions` gives the session's `mcp_token` (from the one item of that scope: C12's rule of one scope once).",
    "3. A request with an `Origin` header: its 403 (`A web page cannot connect to the agent browser.`).",
    "4. A `Host` header that is not exactly `127.0.0.1:<port>` or `localhost:<port>`, no `Host` header, or two `Host` header lines or more (the service counts the header lines as the request carries them, as at step 7): 403 `The agent browser admits only the Host 127.0.0.1:<port> or localhost:<port>.` This check stops DNS rebinding. It keeps both forms, although each entry that agentwatch writes names `127.0.0.1`.",
    "5. A path that is not `/mcp` or `/mcp/<scope>` with a scope that matches the scope pattern: 404 `Not found. Connect an MCP client to /mcp/<scope>.`",
    "6. A path whose scope is not the connection's scope: the session's 403.",
    "7. The token (the token design). A request has an `Authorization: Bearer <token>` header when it has exactly one `Authorization` header line (the service counts the header lines as the request carries them, whatever the case of their name), and that header's value is `Bearer` (in any case), one space and a token of one character or more.",
    "The token is every character after that one space: after two spaces the token starts with a space, and text after the token is part of the token, so each is a token that the service does not know. A tab in place of the space is not this form.",
    "The service hashes the token with SHA-256 and compares the digest with the session's `mcp_token` in constant time. The first of these three cases that holds gives its answer:",
    "no `Authorization: Bearer <token>` header: 401 `The agent browser needs this session's connection token. agentwatch adds the agent browser's MCP to each session that it launches while the switch browser.service is on.`;",
    "a session whose `mcp_token` is `null`: 401 `This session has no connection token. agentwatch adds the agent browser's MCP to each session that it launches while the switch browser.service is on: restart the session.`;",
    "a token whose fingerprint is not the session's: 401 `The agent browser does not know this connection token for this session.` The text does not say whether the token belongs to another session.",
    "Each 401 carries `WWW-Authenticate: Bearer realm=\"agent-browser\"`, with no `resource_metadata`, so no client starts an OAuth login (stage 2's live check proves it).",
    "8. The readiness: the 503s of step 4 before the upgrade, with their texts. A scope with no list, or with a list with no site, gets no 503 at this step (below).",
    "The self-test's 503 of step 3 before the upgrade does not apply here: this check reads `/proc/net/tcp`, `/proc/<pid>/fd` and the `stat` files, and needs no `node:ffi`. When the service cannot read `/proc/net/tcp`, each connection gets the peer's 403 at step 1.",
    "The pid of the session's 403 (`<pid>`): the lowest pid among the holders that the walk refused. When the walk refused no holder (holders of two scopes, a line that changed, or step 6), it is the lowest pid among all the holders.",
    "Steps 1 and 2 run once for each connection, and a connection keeps its scope until it closes. Steps 3 to 8 run for each request on the connection. A refused request never has its header in a log line or in an answer.",
    "A request with the MCP session id of another scope, or with an MCP session id that the service does not know, gets the 404 of an unknown MCP session: the transport's answer to an unknown `Mcp-Session-Id` (the self-contained design, section 8.2, M3).",
    "An `Origin` header, a wrong `Host` and the walk's refusal of a browser process are three separate checks, and the service keeps all three.",
    "At C12's `session_ended`, the service closes the scope's MCP connections and ends its MCP sessions.",
    "At each C12 `set_sessions`, the service closes each MCP connection when a root that admitted it no longer counts for its scope, also when only that root's cgroup stops counting for a connection that the root's cgroup admitted, and each MCP connection of a session that the snapshot drops or whose `mcp_token` changed. This rule is the MCP path's own: the endpoint's 1008 close at an `allowlist` line (when a connection ends, above) asks only whether the line still names the root.",
    "The shared vectors: `mcpChecks` and `mcpCloses` in `test/vectors/endpoint.json`, with `mcpSnapshots`, `mcpLists`, `mcpTokens`, `mcpSessionIds` and `mcpAnswers` (each case gives the lines of `/proc/net/tcp`, the holders and a fake process table, so both sides test with a fake reader; the tokens are made-up test values).",
  ]);
  for (const old of ["7. The readiness and the scope's list", "Steps 3 to 7 run for each request"]) assert.ok(!says(C11, old), `C11: no ${old} (the token design)`);
  assert.ok(!says(C11, "by the client's port, and reads its uid"), "no match by the client's port alone (F5)");
  sayAll(partOr("The limits of the MCP path's admission (from stage 1d; the self-contained design, sections 8.3 and 18, M2)."), [
    "The check finds the holders of the socket, not the process that connected. A process that forks after its connect has a child that holds the socket too, and that child must be in the same session.",
    "A client that writes its request and exits at once is refused: no process holds the socket at the check (M2: 50 of 50).",
    "The check costs 10.4 ms p50 to 23.1 ms p50 on the Linux server (M2), once for each connection.",
    "A client of another OS user is refused by the uid column; M2 reasoned this case and did not run it.",
    "As on the endpoint, the check does not stop a hostile process of the same OS user. The token does not change this: a process of the user can read every session's entry file. A token works only from its own session, and it ends with the session.",
  ]);
  // The texts of the MCP path that are new: each has its status, once.
  for (const t of ["403 `The agent browser admits only the Host 127.0.0.1:<port> or localhost:<port>.`", "404 `Not found. Connect an MCP client to /mcp/<scope>.`", "503 `The agent browser is off: the operator turned agent control off.`",
    "401 `The agent browser needs this session's connection token. agentwatch adds the agent browser's MCP to each session that it launches while the switch browser.service is on.`",
    "401 `This session has no connection token. agentwatch adds the agent browser's MCP to each session that it launches while the switch browser.service is on: restart the session.`",
    "401 `The agent browser does not know this connection token for this session.`"]) {
    assert.equal(flat(C11).split(flat(t)).length, 2, `C11 has ${t} once`);
  }
  // The reused texts are the endpoint's own answers (the vectors).
  const bodies = new Set(endpoint.upgradeAnswers.map((a) => a.body));
  for (const b of ["The agent browser cannot tell which program connects, so it refuses the connection.", "A web page cannot connect to the agent browser."]) assert.ok(bodies.has(b), `an answer of the endpoint: ${b}`);
});

// The lead's decisions on the open points of stage 1d part 2a (board ab-v16.94.5): each has its C11 sentences, exactly,
// and the old sentence is gone. OP6 (session_ended for a shared launch name) is the daemon lead's.
test("C11 states the lead's decisions OP1 to OP5 and OP7 on the MCP path's admission, and the token design's section 6.4 says OP1", () => {
  const A = partOr("The admission of the MCP path (from stage 1d; the daemon lead's conditions for the TCP choice).");
  sayAll(A, [
    // OP1: C11's order holds; before the first set_sessions no root counts.
    "Before the service's first `set_sessions` no root counts, so each connection with a holder gets the session's 403, whose text says to connect again in a few seconds (a refusal at step 1 and a connection with no holder still get the peer's 403).",
    // OP2: on the MCP path the list is the allow.
    "On the MCP path a scope with no list, or with a list with no site, passes this step for every request, and each tool works there: a tool call starts a stopped Chrome, `PageFetch` needs no allowlist (PageFetch, below), and the browser tools keep the scope's list, so a navigation to a host that the list does not cover gets the allowlist refusal (the refusals, above), which makes the operator's prompt (C12) and does not wait for the operator's answer (board ab-v16.104; the PageFetch design, sections 5.2 and 5.13; the operator, 2026-11-15: \"every agent gets the mcp for PageFetch\" and \"let's also give it the navigation mcp. when the agent requests a page that's not on the allowlist, it goes to the operator for approval.\").",
    "The MCP's browser is a connection of the agent door, so the browser tools of both doors have one rule, the agent door's: a session whose repo has no list file, or a list file with no site, has its repo's list with no site in the object (C12), the endpoint admits its scope, and its pages open only `about:blank` and the hosts that its list covers; a scope that the line does not name, or names with no list, gets the no-list 503 there (steps 5 and 7 before the upgrade).",
    // OP3: no holder, no pid.
    "No holder gets the peer's 403, which names no pid. A process whose `/proc/<pid>/fd` the service cannot read (a process of another user, or a process that is not dumpable) is no holder for this check: when no other process holds the socket, the connection gets the peer's 403. A holder that reaches no root, or holders of two scopes get the session's 403.",
    "A connection with no holder gets the peer's 403 (step 2), so the session's 403 always names a holder.",
    // OP4: the close at a change also ends the MCP sessions.
    "It also ends the MCP sessions of each such session, as at `session_ended`: of a session that the snapshot drops or whose `mcp_token` changed (also when it has no open connection), and of a scope whose connection closed for its root.",
    // OP5: the raw headers and the raw path.
    "exactly one `Authorization` header line (the service counts the header lines as the request carries them, whatever the case of their name)",
    "The path is the request target as the client sent it, up to its first `?`, with no normalization: `/mcp/./<scope>`, `/mcp/x/../<scope>`, `//mcp/<scope>` and a percent-encoded scope get this 404. A query does not change the path.",
    // OP7: the header's value without its leading and trailing whitespace.
    "The header's value is its field value without its leading and trailing spaces and tabs (RFC 9110), as Node's HTTP parser gives it: so `Bearer <token> ` with a space after the token carries that token, and `Bearer` with only spaces after it is not this form.",
  ]);
  for (const old of ["No holder, a holder that reaches no root, or holders of two scopes get the session's 403.", "exactly one `Authorization` header, and that header's value"]) assert.ok(!says(C11, old), `C11: no ${old}`);
  const T = readOr("docs/superpowers/specs/2026-11-10-mcp-connection-tokens-design.md");
  assert.ok(says(T, "Until the daemon's first `set_sessions`, no root counts, so each MCP connection with a holder gets the session's 403 of step 2: C11's order holds, and the 403's text says to connect again in a few seconds."), "the token design's 6.4: OP1");
  assert.ok(!says(T, "each MCP request gets the readiness 503 of step 8"), "the token design's 6.4: no readiness 503 before the first set_sessions");
});

test("C11 states the MCP inside the service and how a session gets the MCP (the answers Q2 and Q4; the daemon lead's condition 4 and D19)", () => {
  sayAll(partOr("The MCP inside the service (from stage 1d; the self-contained design, section 8.2)."), [
    "The service makes one Playwright MCP server object for each MCP session, from the pinned `@playwright/mcp` package's public entry. At most 4 MCP sessions for each scope and 32 for each service (first values).",
    "Its configuration is fixed: the scope's CDP endpoint and the default context; the capabilities named explicitly, never `core-install`, `storage`, `devtools`, `testing` or `config`; `allowUnrestrictedFileAccess: false`; and an output folder for each scope in the state folder.",
    // Board ab-t30.34 (before: ... (a local admission: the sign-in act, below).): the press and hold is input, for each admission.
    "Tools and argument keys pass only through the allow list (`docs/contracts/mcp-allow-list.md`), and the service's own tools of the allow list's `service_tools` only for a request that the MCP port admitted with the walk (a local admission: the sign-in act, below), but `browser_press_hold`, an input tool, for each admission (the press and hold, below; board ab-t30.34).",
    "The service refuses each argument that the allow list marks as a path when the path is outside the scope's folder, `<state>/mcp/<scope>/`, after `realpath`.",
    "The MCP's Playwright connects back to the endpoint's CDP path with the MCP session's scope and a one-time ticket, which only a connection from the service's own pid can use. Every rule of this file applies to that connection.",
    "The MCP code of each scope runs in one worker thread of the service, with a heap limit (first value 512 MiB). A worker that passes it ends with its MCP sessions, and their clients get an error.",
    "No log line of the MCP path holds a tool argument, page content, a cookie, a URL path, a payload, a username, a password, a form value, an `Authorization` header, a token, a token's fingerprint or a lifetime id, and a request that the service refuses for its size or its shape is never logged (the log rule of C12).",
  ]);
  const how = partOr("How a session gets the MCP (from stage 2; the operator's answer Q2 of ab-bi3, and the daemon lead's condition 4).");
  sayAll(how, [
    "agentwatch adds the agent browser's MCP to each session that it launches while the switch browser.service is on: it writes the MCP's HTTP entry into the session's own MCP configuration at the session's launch, also when the session's repo has no list or a list with no site (board ab-v16.104; the PageFetch design, section 5.2: the operator's answer O1 changes the answer Q2). agentwatch mints the session's token at the launch, sends its fingerprint in `set_sessions`, writes the entry file before the launch and removes it at the session's end.",
    "Each entry that agentwatch writes names `127.0.0.1`, never `localhost`: the service listens only on `127.0.0.1`.",
    "agentwatch writes the entry only when the `LISTEN` line of `127.0.0.1:<port>` in `/proc/net/tcp` has the user's uid. Otherwise it writes no entry, and `agentwatch health` shows red.",
    "agentwatch never writes the entry into the user's global files. For Claude Code it writes a file for the session under its tokens folder (`tokens/agent-browser/sessions/<random name>.json`, 0600, with a new random name for each run), which the launch passes with `--mcp-config`.",
    "For Codex it writes the session's profile file under its tokens folder and a link to it in the session's Codex home (`aw-<random name>.config.toml`), and the launch passes `-p aw-<random name>`; a Codex session with agentwatch's app server gets no entry until a Codex release lets the app server read a profile (the token design's answer E a). No command line holds a lifetime id.",
    "Nothing goes into the session's environment: the operator's answer age-4ks (\"env: no\") stays.",
    "agentwatch does not change a running session's MCP configuration. A list that gets its first site after a session's launch takes effect at that session's next launch, so the session needs a restart.",
  ]);
  // Board goal ab-sta: the card payment's part quotes the design's "buy by hand" (section 8.7); D19 is the MCP configuration's rule.
  const beforePay = C11.split("\n**The card payment (board goal ab-sta;")[0];
  for (const s of ["CODEX_HOME", "by hand"]) assert.ok(!says(beforePay, s), `C11: no ${s} (D19)`);
  for (const old of ["For Codex it uses a `-c` override for each launch.", "For Claude Code it writes a file for the session, which the launch passes", "a URL path or a payload, and a request that the service refuses"]) assert.ok(!says(C11, old), `C11: no ${old} (the token design)`);
});

test("C11 keeps no sentence of the stdio shim as the local MCP path, and no rule of the self-contained browser before its stage", () => {
  for (const s of ["agent-browser mcp", "a stdio shim, `agent-browser mcp`", "The MCP's local path is the stdio shim", "{\"command\":\"agent-browser\",\"args\":[\"mcp\"]}"]) assert.ok(!says(C11, s), `C11: no ${s}`);
  // Each new part names its stage in its heading, so no reader takes it for a rule of today.
  for (const h of ["The MCP path (from stage 1d;", "The admission of the MCP path (from stage 1d;", "The limits of the MCP path's admission (from stage 1d;", "The MCP inside the service (from stage 1d;", "How a session gets the MCP (from stage 2;"]) {
    assert.ok(C11.includes(`**${h}`), `the part ${h}`);
  }
  // The new parts come after the old text: the old text's last part is still the scope's session, before them.
  assert.ok(C11.indexOf("**The scope's session (the peer check; board ab-v16.50).**") < C11.indexOf("**The MCP path (from stage 1d;"), "the order of the parts");
});

// ---- The MCP path's admission with the token step (board ab-v16.94.5, build task 1 of the token design, board ab-v16.94.10) ----
// The vectors mcpChecks and mcpCloses of test/vectors/endpoint.json, with the reference of C11's admission of the MCP path:
// steps 1 and 2 once for each connection (the uid by the full tuple, the walk of each holder), then steps 3 to 8 and the
// transport for each request. The walk is the scope's session's (worldOf, walk, rootsThatCount above), with the roots of the
// last set_sessions. Stage 1d's service tests its own code against the same vectors.

const MCP_PORT = endpoint.mcpService?.port, MCP_UID = endpoint.mcpService?.uid;
const MCP_ANSWERS = [...(endpoint.mcpAnswers ?? []), ...endpoint.upgradeAnswers];
const mcpSha256 = (t: string) => createHash("sha256").update(t, "ascii").digest("hex");
/** The lines of /proc/net/tcp at the first read (again: the second), with the default of the vectors' note. */
function tcpLines(c: McpCheck, again: boolean): TcpLine[] | null {
  const k = again ? "tcpAgain" : "tcp";
  if (Object.hasOwn(c.connection, k)) return c.connection[k] ?? null; // a field that is there holds the lines or null
  if (again) return tcpLines(c, false);
  const client = c.connection.client, srv = `127.0.0.1:${MCP_PORT}`;
  return [{ local: srv, remote: "0.0.0.0:0", uid: MCP_UID, inode: 80000 }, { local: srv, remote: client, uid: MCP_UID, inode: 81002 }, { local: client, remote: srv, uid: MCP_UID, inode: 81001 }];
}
/** Step 1: the one line whose local address is the client's and whose remote address is the service's port (the full tuple). */
const clientLine = (lines: TcpLine[] | null, client: string) => {
  const m = (lines ?? []).filter((l) => l.local === client && l.remote === `127.0.0.1:${MCP_PORT}`);
  return lines !== null && m.length === 1 ? m[0] : null;
};
/** The scope of one holder by the walk, else (not on the Mac) by a root's cgroup that counts; null: no root that counts. */
function holderScope(w: World, pid: number, named: Map<string, Named>): string | null {
  const at = walk(w, pid, named);
  if (at !== null) { const r = must(named.get(at), at); return r.counts ? r.scope : null; }
  const cg = w.get(pid)?.cgroup;
  if (typeof cg !== "string") return null;
  const scopes = new Set([...named.values()].filter((r) => r.cgroupCounts && (cg === r.cgroup || cg.startsWith(r.cgroup + "/"))).map((r) => r.scope));
  return scopes.size === 1 ? [...scopes][0] : null;
}
const lowest = (pids: number[]) => (pids.length ? Math.min(...pids) : null);
/** The snapshot of a check: its set_sessions, or none before the first one (no session, so no root counts: OP1). */
const snapOf = (c: McpCheck): McpSnapshot => (c.service.snapshot === null ? { sessions: [], lists: {} } : endpoint.mcpSnapshots[c.service.snapshot]);
/** Steps 1 and 2: the connection's scope, or the refusal with the pid of the session's 403. */
function mcpConnection(c: McpCheck): { scope: string; pid: number | null } | { answer: string; pid: number | null } {
  const line = clientLine(tcpLines(c, false), c.connection.client);
  if (!line || line.uid !== MCP_UID) return { answer: "peerUnread", pid: null };
  const w = worldOf(c), snap = snapOf(c);
  const named = rootsThatCount(Object.fromEntries(snap.sessions.map((s) => [s.scope, s.roots])), w);
  const holders: number[] = c.connection.holders;
  if (holders.length === 0) return { answer: "peerUnread", pid: null }; // OP3: no holder names no pid
  const scopes = holders.map((pid) => holderScope(w, pid, named));
  const refused = holders.filter((_, i) => scopes[i] === null);
  if (refused.length) return { answer: "session", pid: lowest(refused) };
  if (new Set(scopes).size !== 1) return { answer: "session", pid: lowest(holders) };
  const again = clientLine(tcpLines(c, true), c.connection.client);
  if (!again || JSON.stringify(again) !== JSON.stringify(line)) return { answer: "session", pid: lowest(holders) };
  return { scope: scopes[0]!, pid: lowest(holders) };
}
/** Steps 3 to 8 for one request, then the transport's check of its MCP session id. */
function mcpRequest(c: McpCheck, conn: { scope: string; pid: number | null }, r: McpCheck["requests"][number]): { answer: string; pid?: number | null } {
  // OP7: each value without its leading and trailing spaces and tabs (RFC 9110's OWS), as Node's parser gives it.
  const h = (n: string) => r.headers.filter(([k]) => k === n).map(([, v]) => v.replace(/^[ \t]+|[ \t]+$/g, ""));
  if (h("origin").length) return { answer: "fromPage" }; // 3
  const host = h("host");
  if (host.length !== 1 || ![`127.0.0.1:${MCP_PORT}`, `localhost:${MCP_PORT}`].includes(host[0])) return { answer: "badHost" }; // 4
  const m = /^\/mcp(?:\/([^/]*))?$/.exec(r.path.split("?")[0]); // OP5: the raw path, up to its first ?
  if (!m || (m[1] !== undefined && !SCOPE.test(m[1]))) return { answer: "mcpNotFound" }; // 5
  if (m[1] !== undefined && m[1] !== conn.scope) return { answer: "session", pid: conn.pid }; // 6
  const snap = snapOf(c);
  const item = snap.sessions.find((s) => s.scope === conn.scope);
  const auth = h("authorization");
  const bearer = auth.length === 1 ? /^bearer (.+)$/i.exec(auth[0]) : null;
  if (!bearer) return { answer: "needsToken" }; // 7
  const token = must(item, `${c.note}: the session of ${conn.scope}`).mcp_token;
  if (token === null) return { answer: "noToken" };
  if (mcpSha256(bearer[1]) !== token) return { answer: "unknownToken" };
  if (c.service.ready !== "ready") return { answer: c.service.ready }; // 8
  // Board ab-v16.104 (in place of OP2): a scope with no list, or a list with no site, passes step 8 for every request.
  const sid = h("mcp-session-id"); // the transport, after the admission
  if (sid.length && endpoint.mcpSessionIds[sid[0]] !== conn.scope) return { answer: "unknownSession" };
  return { answer: "pass" };
}
/** The connection's scope (steps 1 and 2), or none at a refusal. */
const connScope = (c: McpCheck) => { const conn = mcpConnection(c); return "scope" in conn ? conn.scope : undefined; };
/** The connection's refusal (steps 1 and 2), or none when it has a scope. */
const connAnswer = (c: McpCheck) => { const conn = mcpConnection(c); return "answer" in conn ? conn.answer : undefined; };
/** Each request's answer on the connection, in order, until the first refusal. */
function mcpRun(c: McpCheck): { answer: string; pid?: number | null }[] {
  const conn = mcpConnection(c);
  if ("answer" in conn) return [conn];
  const out: { answer: string; pid?: number | null }[] = [];
  for (const r of c.requests) {
    const a = mcpRequest(c, conn, r);
    out.push(a);
    if (a.answer !== "pass") break;
  }
  return out;
}

test("the MCP path's vectors: the test tokens and the snapshots follow the token design and C12's field rules", () => {
  assert.ok(endpoint.mcpChecks && endpoint.mcpCloses && endpoint.mcpSnapshots && endpoint.mcpTokens && endpoint.mcpAnswers && endpoint.mcpSessionIds, "test/vectors/endpoint.json has the MCP path's vectors");
  // review-113 N1: the token design is board ab-v16.94.10; this stage is board ab-v16.94.5.
  for (const t of [endpoint.mcpNote, endpoint.contract]) assert.ok(says(t, "the token design, board ab-v16.94.10") && !says(t, "the token design, board ab-v16.94.5") && !says(t, "(the token design)"), "the vectors name the token design's board");
  assert.ok(Number.isInteger(MCP_PORT) && MCP_UID === 1001, "the service's port and uid (procsNote: the uid 1001)");
  for (const [name, t] of Object.entries(endpoint.mcpTokens)) {
    assert.match(t.token, /^abt1_[A-Za-z0-9_-]{43}$/, name);
    const raw = Buffer.from(t.token.slice(5), "base64url");
    assert.ok(raw.length === 32 && raw.toString("base64url") === t.token.slice(5) && /^test, not a token: [ -~]+$/.test(raw.toString("latin1")), `${name}: 32 bytes of its own ASCII label, a test value`);
    assert.equal(t.fingerprint, mcpSha256(t.token), `${name}: its fingerprint`);
  }
  const fps = new Set(Object.values(endpoint.mcpTokens).map((t) => t.fingerprint));
  for (const [id, snap] of Object.entries(endpoint.mcpSnapshots)) {
    const scopes = snap.sessions.map((s) => s.scope);
    assert.equal(new Set(scopes).size, scopes.length, `${id}: one scope once`);
    const tokens = snap.sessions.map((s) => s.mcp_token).filter((x) => x !== null);
    assert.equal(new Set(tokens).size, tokens.length, `${id}: one fingerprint once`);
    for (const s of snap.sessions) {
      assert.deepEqual(Object.keys(s).sort(), ["cgroup", "lifetime_id", "mcp_token", "repo", "roots", "scope"], `${id}: ${s.scope} is an item of C12's set_sessions`);
      assert.ok(SCOPE.test(s.scope) && s.roots.every(isRoot), `${id}: ${s.scope}`);
      assert.ok(s.mcp_token === null || fps.has(s.mcp_token), `${id}: ${s.scope}: null or the fingerprint of a test token`);
      assert.ok(s.lifetime_id !== null || s.mcp_token === null, `${id}: ${s.scope}: no fingerprint with a null lifetime id`);
    }
    assert.deepEqual(Object.keys(snap.lists).sort(), [...scopes].sort(), `${id}: a list (or null) for each scope`);
    for (const l of Object.values(snap.lists)) assert.ok(l === null || Object.hasOwn(endpoint.mcpLists, l), `${id}: the list ${l} has its sites in mcpLists`);
  }
  // mcpLists: each list's sites, each a host of C5's form; a list with no site, and a list with sites.
  for (const [name, hosts] of Object.entries(endpoint.mcpLists)) assert.ok(SCOPE.test(name) && Array.isArray(hosts) && hosts.every((h: string) => normalized(h)), `mcpLists: ${name}`);
  assert.ok(Object.values(endpoint.mcpLists).some((h) => h.length === 0) && Object.values(endpoint.mcpLists).some((h) => h.length > 0), "mcpLists: a list with no site and a list with sites");
  assert.ok(!Object.values(endpoint.mcpSnapshots).some((snap) => snap.sessions.some((s) => s.mcp_token === endpoint.mcpTokens.stranger.fingerprint)), "the stranger's token is no session's");
  // The answers: each id once, each text of C11, with its WWW-Authenticate for a 401; no answer holds a token or a fingerprint.
  const ids = MCP_ANSWERS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, "each answer id once");
  for (const a of endpoint.mcpAnswers) {
    if (a.body !== null) assert.ok(says(C11, `${a.status} \`${a.body}\``), `C11 has ${a.status} ${a.body}`);
    assert.equal(a.status === 401, Object.hasOwn(a, "headers"), `${a.id}: headers for a 401 only`);
    if (a.status === 401) assert.deepEqual(a.headers, { "www-authenticate": "Bearer realm=\"agent-browser\"" }, a.id);
  }
  assert.ok(says(C11, "`WWW-Authenticate: Bearer realm=\"agent-browser\"`"), "C11 names the header");
  const answersText = JSON.stringify(endpoint.mcpAnswers);
  for (const t of Object.values(endpoint.mcpTokens)) assert.ok(!answersText.includes(t.token) && !answersText.includes(t.fingerprint), "no answer echoes a token or a fingerprint");
  assert.ok(!/abt1_/.test(answersText) && /abt1_/.test(JSON.stringify([...endpoint.mcpAnswers, { body: endpoint.mcpTokens.leadRun2.token }])), "the scan finds a planted token (its twin)");
});

test("the MCP path's admission: each check vector gets the answers of C11's order (steps 1 and 2 once, steps 3 to 8 for each request, then the transport)", () => {
  const known = new Set([...MCP_ANSWERS.map((a) => a.id), "pass"]);
  for (const c of endpoint.mcpChecks) {
    for (const k of Object.keys(c)) assert.ok(["note", "world", "procs", "service", "connection", "requests"].includes(k), `${c.note}: a known field ${k}`);
    assert.ok(["linux", "noScope"].includes(c.world) && (c.service.snapshot === null || Object.hasOwn(endpoint.mcpSnapshots, c.service.snapshot)), c.note);
    assert.ok(c.requests.length > 0 && c.requests.slice(0, -1).every((r) => r.answer === "pass"), `${c.note}: only the last request can be refused`);
    const got = mcpRun(c);
    const want = c.requests.map((r) => (Object.hasOwn(r, "pid") ? { answer: r.answer, pid: r.pid } : { answer: r.answer }));
    for (const r of c.requests) assert.ok(known.has(r.answer), `${c.note}: a known answer ${r.answer}`);
    assert.equal(got.length, want.length, `${c.note}: one answer for each request`);
    for (const [i, w] of want.entries()) {
      assert.equal(got[i].answer, w.answer, c.note);
      if (Object.hasOwn(w, "pid")) assert.equal(got[i].pid, w.pid, `${c.note}: the pid of the session's 403`);
      // OP3: a connection with no holder gets the peer's 403, so each session's 403 names a holder's pid.
      if (w.answer === "session") assert.ok(Object.hasOwn(w, "pid") && c.connection.holders.some((p) => p === w.pid), `${c.note}: the session's 403 names a holder`);
      if (c.connection.holders.length === 0) assert.equal(w.answer, "peerUnread", `${c.note}: no holder, the peer's 403`);
    }
  }
});

test("the MCP path's admission: the vectors hold each case of the daemon lead's F11 and of the token design's section 14.1", () => {
  const cases = endpoint.mcpChecks.map((c) => ({ c, r: c.requests[c.requests.length - 1], h: (n: string) => c.requests[c.requests.length - 1].headers.filter(([k]) => k === n).map(([, v]) => v) }));
  type Case = (typeof cases)[number];
  const has = (what: string, f: (x: Case) => unknown) => assert.ok(cases.some(f), what);
  const T = endpoint.mcpTokens, bearer = (x: Case) => x.h("authorization")[0]?.slice(7);
  const own = (x: Case) => snapOf(x.c).sessions.find((s) => s.scope === connScope(x.c));
  const lineOf = (x: Case) => clientLine(tcpLines(x.c, false), x.c.connection.client);
  // F11: the uid, two scopes, the Host forms, /mcp alone, a wrong path scope, a session id of another scope.
  has("another uid by the full tuple, beside the service's accepted socket of the service's uid", (x) => x.r.answer === "peerUnread" && lineOf(x)?.uid !== MCP_UID && (x.c.connection.tcp ?? []).some((l) => l.remote === x.c.connection.client && l.uid === MCP_UID));
  has("an unreadable table", (x) => x.r.answer === "peerUnread" && x.c.connection.tcp === null);
  has("no line of the client's tuple", (x) => x.r.answer === "peerUnread" && Array.isArray(x.c.connection.tcp) && !x.c.connection.tcp.some((l) => l.local === x.c.connection.client));
  has("two lines of the client's tuple", (x) => x.r.answer === "peerUnread" && (x.c.connection.tcp ?? []).filter((l) => l.local === x.c.connection.client).length === 2);
  has("a line that changed at the second read", (x) => x.r.answer === "session" && Object.hasOwn(x.c.connection, "tcpAgain"));
  has("no holder: the peer's 403 (OP3)", (x) => x.r.answer === "peerUnread" && x.c.connection.holders.length === 0 && !Object.hasOwn(x.r, "pid"));
  has("a forked client: two holders of one session", (x) => x.r.answer === "pass" && x.c.connection.holders.length === 2);
  has("step 1 before step 3", (x) => x.r.answer === "peerUnread" && x.h("origin").length > 0);
  has("holders of two scopes", (x) => x.r.answer === "session" && new Set(x.c.connection.holders.map((p: number) => holderScope(worldOf(x.c), p, rootsThatCount(Object.fromEntries(snapOf(x.c).sessions.map((s) => [s.scope, s.roots])), worldOf(x.c))))).size === 2);
  for (const host of [`127.0.0.1:${MCP_PORT}`, `localhost:${MCP_PORT}`]) has(`the Host ${host} admitted`, (x) => x.r.answer === "pass" && x.h("host")[0] === host);
  for (const host of [`[::1]:${MCP_PORT}`, "127.0.0.1", `127.0.0.1:${MCP_PORT + 1}`, `LOCALHOST:${MCP_PORT}`]) has(`the Host ${host} refused`, (x) => x.r.answer === "badHost" && x.h("host")[0] === host);
  has("no Host", (x) => x.r.answer === "badHost" && x.h("host").length === 0);
  has("/mcp alone with the walk's scope", (x) => x.r.answer === "pass" && x.r.path === "/mcp");
  has("a wrong path scope", (x) => x.r.answer === "session" && /^\/mcp\/md-worker$/.test(x.r.path) && connScope(x.c) === "md-lead");
  has("an MCP session id of another scope", (x) => x.r.answer === "unknownSession" && endpoint.mcpSessionIds[x.h("mcp-session-id")[0]] && endpoint.mcpSessionIds[x.h("mcp-session-id")[0]] !== connScope(x.c));
  has("Origin with the session's own token", (x) => x.r.answer === "fromPage" && bearer(x) && mcpSha256(bearer(x)) === own(x)?.mcp_token);
  has("the walk refuses a browser process", (x) => x.r.answer === "session" && (x.c.procs ?? []).some((p) => /Chrome/.test(p.note ?? "") && x.c.connection.holders.includes(p.pid)));
  has("a process outside every session with a session's own token", (x) => x.r.answer === "session" && x.c.connection.holders.includes(3501) && bearer(x) === T.leadRun2.token);
  // 14.1: the token cases.
  has("the walk's session's own token: admitted", (x) => x.r.answer === "pass" && bearer(x) === T.leadRun2.token);
  has("no header", (x) => x.r.answer === "needsToken" && x.h("authorization").length === 0 && x.r.path === "/mcp/md-lead");
  has("a session with mcp_token null", (x) => x.r.answer === "noToken" && own(x)?.mcp_token === null && own(x)?.lifetime_id === null);
  has("another session's token", (x) => x.r.answer === "unknownToken" && bearer(x) === T.worker.token);
  has("a token of no session", (x) => x.r.answer === "unknownToken" && bearer(x) === T.stranger.token);
  has("a token of another lifetime id of the same scope", (x) => x.r.answer === "unknownToken" && bearer(x) === T.leadRun1.token && own(x)?.lifetime_id !== "lt-lead-1");
  has("the earlier run's token while its snapshot holds", (x) => x.r.answer === "pass" && bearer(x) === T.leadRun1.token);
  has("a second Authorization header with the right token", (x) => x.r.answer === "needsToken" && x.h("authorization").length === 2 && x.h("authorization").every((v: string) => v === `Bearer ${T.leadRun2.token}`));
  has("another scheme", (x) => x.r.answer === "needsToken" && /^Basic /.test(x.h("authorization")[0] ?? ""));
  // review-113 B3: the token is every character after the one space.
  has("two spaces after Bearer: a token that starts with a space", (x) => x.r.answer === "unknownToken" && x.h("authorization")[0] === `Bearer  ${T.leadRun2.token}`);
  has("a tab after Bearer: not the header form", (x) => x.r.answer === "needsToken" && x.h("authorization")[0] === `Bearer\t${T.leadRun2.token}`);
  has("text after the session's own token: part of the token", (x) => x.r.answer === "unknownToken" && (x.h("authorization")[0] ?? "").startsWith(`Bearer ${T.leadRun2.token} `));
  has("a token in the query, no header", (x) => x.r.answer === "needsToken" && x.r.path.includes(`?access_token=${T.leadRun2.token}`) && x.h("authorization").length === 0);
  has("a token in the path", (x) => x.r.answer === "session" && x.r.path === `/mcp/${T.leadRun2.token}`);
  has("a bearer of another length", (x) => x.r.answer === "unknownToken" && bearer(x)?.length !== T.leadRun2.token.length);
  has("the fingerprint as the bearer", (x) => x.r.answer === "unknownToken" && bearer(x) === T.leadRun2.fingerprint);
  // Board ab-v16.104: no scope gets the no-list 503 at step 8 any more; a browser tool's call with a valid token passes.
  has("a browser tool's call of a scope with a list with no site, with a valid token: it passes", (x) => x.r.answer === "pass" && x.r.tool === "browser_navigate" && bearer(x) && mcpSha256(bearer(x)) === own(x)?.mcp_token);
  has("a snapshot that drops the session: the walk's refusal", (x) => x.r.answer === "session" && x.c.service.snapshot === "workerDropped" && bearer(x) === T.worker.token);
  has("a changed mcp_token: the session's own token of its new snapshot", (x) => x.c.service.snapshot === "leadNull" && x.r.answer === "noToken");
  // The order: each earlier step before the token, and the token before the readiness.
  for (const [what, answer] of [["Origin", "fromPage"], ["Host", "badHost"], ["the path", "mcpNotFound"], ["the path's scope", "session"]]) has(`${what} before step 7`, (x) => x.r.answer === answer && x.h("authorization").length === 0);
  has("step 7 before step 8", (x) => x.r.answer === "needsToken" && x.c.service.ready !== "ready");
  has("the admission before the transport", (x) => x.r.answer === "needsToken" && x.h("mcp-session-id").length > 0);
  has("step 1 before step 7: another uid with no token", (x) => x.r.answer === "peerUnread" && x.h("authorization").length === 0);
  has("step 2 before step 7: no session with no token", (x) => x.r.answer === "session" && x.h("authorization").length === 0 && x.r.path === "/mcp/md-lead" && connAnswer(x.c) === "session");
  has("steps 3 to 8 for each request", (x) => x.c.requests.length === 2 && x.r.answer !== "pass");
  for (const id of ["controlOff", "notConnected", "notConfirmed", "tooOld"]) has(`step 8: ${id}`, (x) => x.r.answer === id);
  for (const a of endpoint.mcpAnswers) has(`a vector of ${a.id}`, (x) => x.r.answer === a.id);
  // The lead's decisions on the open points of part 2a.
  has("OP1: before the first set_sessions the walk's session's 403, with the session's own token", (x) => x.c.service.snapshot === null && x.r.answer === "session" && bearer(x) === T.leadRun2.token);
  // Board ab-v16.104 (in place of OP2): in a scope with no list, or with a list with no site, every request passes step 8,
  // also a tools/call of a browser tool (each request of a connection, not only its last).
  const every = endpoint.mcpChecks.flatMap((c) => c.requests.map((r) => ({ c, r })));
  type Request = (typeof every)[number];
  for (const l of ["no list", "a list with no site"]) {
    const which = (x: Request) => {
      if (x.c.service.snapshot === null || x.c.service.ready !== "ready") return false;
      const conn = mcpConnection(x.c);
      if (!("scope" in conn)) return false;
      const list = snapOf(x.c).lists[conn.scope];
      return l === "no list" ? list === null : list != null && endpoint.mcpLists[list]?.length === 0;
    };
    const holds = (what: string, f: (x: Request) => boolean) => assert.ok(every.some((x) => which(x) && f(x)), `board ab-v16.104, ${l}: ${what}`);
    holds("a request that is no tools/call passes", (x) => x.r.answer === "pass" && x.r.tool === undefined);
    holds("a PageFetch call passes", (x) => x.r.answer === "pass" && x.r.tool === "PageFetch");
    holds("a call of a browser tool passes", (x) => x.r.answer === "pass" && x.r.tool === "browser_navigate");
  }
  for (const path of ["/mcp/./md-lead", "/mcp/x/../md-lead", "//mcp/md-lead", "/mcp/md%2Dlead", "http://127.0.0.1:47311/mcp/md-lead"]) has(`OP5: the raw path ${path}: the 404`, (x) => x.r.answer === "mcpNotFound" && x.r.path === path && bearer(x) === T.leadRun2.token);
  has("OP5: a query does not change the path", (x) => x.r.answer === "pass" && x.r.path.startsWith("/mcp/md-lead?"));
  has("OP7: a space after the session's own token: admitted", (x) => x.r.answer === "pass" && x.h("authorization")[0] === `Bearer ${T.leadRun2.token} `);
  has("OP7: Bearer with only spaces after it: no token", (x) => x.r.answer === "needsToken" && /^Bearer {2,}$/.test(x.h("authorization")[0] ?? ""));
});

test("at each set_sessions: each MCP close vector follows C11 (a session that the snapshot drops, a changed mcp_token, an admitting root that left)", () => {
  const closes = new Set<string | null>();
  for (const v of endpoint.mcpCloses) {
    const before = endpoint.mcpSnapshots[v.connection.snapshot].sessions.find((s) => s.scope === v.connection.scope);
    assert.ok(before?.roots.some((r) => r.pid === v.connection.root.pid && r.start === v.connection.root.start), `${v.note}: the root admitted the connection`);
    const now = endpoint.mcpSnapshots[v.snapshot].sessions.find((s) => s.scope === v.connection.scope);
    const got = !now ? "dropped" : now.mcp_token !== must(before, v.note).mcp_token ? "token" : !now.roots.some((r) => r.pid === v.connection.root.pid && r.start === v.connection.root.start) ? "root" : null;
    assert.equal(got, v.close, v.note);
    closes.add(v.close);
  }
  assert.deepEqual([...closes].sort(), ["dropped", "root", "token", null].sort(), "a vector of each close, and of a connection that stays");
  assert.ok(endpoint.mcpCloses.some((v) => v.close === "token" && must(endpoint.mcpSnapshots[v.snapshot].sessions.find((s) => s.scope === v.connection.scope), v.note).mcp_token === null), "a fingerprint that became null closes");
});

// The service design's sentences that the token design's section 13 changes (build task 1). The design is no contract, but
// the contracts name it as their source, so its changed sentences are asserted here, with the old sentences' absence.
const SERVICE_DESIGN = readOr("docs/superpowers/specs/2026-11-09-self-contained-agent-browser-design.md");
test("the service design states the changes of the token design's section 13: the status, sections 1, 7.1, 8.3 to 8.5, 9, 11, 12 and 19", () => {
  const D = SERVICE_DESIGN;
  for (const s of [
    // The status block, and section 1, items 5 and 9.
    "The token design ([2026-11-10-mcp-connection-tokens-design.md](2026-11-10-mcp-connection-tokens-design.md), board ab-v16.94.10) adds a connection token for each session to the MCP's admission of section 8.3 and C11, with the operator's answers of 2026-11-10 (section 19).",
    "A local session reaches the MCP with its client's HTTP configuration, `http://127.0.0.1:<port>/mcp/<scope>`, with the session's own connection token in the `Authorization` header of its MCP entry: no stdio shim runs (the operator's answer Q1, section 19, and the token design).",
    "The operator answered the token design's questions on 2026-11-10 (board items ab-0wv, ab-sxg, ab-ufy, ab-5t3 and ab-h93; section 19): agentwatch mints a token for each session at the session's start; the repo's list is the allow; the token goes in the `Authorization` header of the session's MCP entry; a session of another box calls the serving box directly over HTTPS, and the serving box takes its token only from that box's known addresses; a Codex session with agentwatch's app server gets no MCP until a Codex release lets the app server read a profile.",
    // Section 7.1, the table "Daemon to service".
    "| `set_sessions {sessions:[{scope, repo, roots:[{pid,start}], cgroup, mcp_token}], remote:[{scope, box, list, mcp_token}], box:{hosts, cookie_names}}` |",
    "`mcp_token` is the fingerprint of the session's connection token, or `null` (the token design); the provenance does not change. |",
    // Section 8.3, 8.4 and 8.5.
    "a per-session MCP configuration in a 0600 file under agentwatch's tokens folder, with the session's own token in its `Authorization` header, which must be the token of the walk's session (the token design). No stdio shim runs.",
    "The token design gives the split of the admission between agentwatch and the service: agentwatch's daemon mints a token for each session, and the service checks the token's fingerprint for each request, after the uid check and the walk. A session on another box calls the serving box directly over HTTPS (section 9, by the token design's answer D c).",
    "**A token for each session**: the operator's answers to ab-6ng and ab-0wv, designed in the token design; the walk stays.",
    "The entry holds the URL with the session's scope (a label: the walk decides the scope) and the session's own token in its `Authorization` header. agentwatch writes it into a 0600 file under its tokens folder before the launch, and it removes the file at the session's end.",
    "The launch gives it to the session's own configuration (Claude Code: the session's file with `--mcp-config`; Codex: the session's profile `aw-<random name>` with `-p`, a link in the Codex home to the session's file; Codex with agentwatch's app server gets no entry until a Codex release lets the app server read a profile, by the operator's answer E a), never through the user's global files.",
    "agentwatch writes the entry only when the service's hello has the feature `mcp_token` and the service answered the `set_sessions` that carries the session's fingerprint (the token design, section 9.1, rules 3 and 6).",
    "Nothing goes into the session's environment: the operator's answer age-4ks (\"env: no\") stays.",
    // Section 9: the path of the token design's answer D c.
    "The path is the token design's answer D c (its section 10): the session's client calls the Mac's `agentwatch.sh` address directly over HTTPS, with the session's remote token in its `Authorization` header.",
    "The session's MCP configuration names `https://<label>.agentwatch.sh/mcp/<box>/<session>`, with the session's remote token in its `Authorization` header.",
    "The link carries the grant, the fingerprint lists of the calling box's sessions and the state of the grant's list. The MCP requests go by direct HTTPS; TLS ends at Cloudflare's edge, so they are not sealed, by the operator's choice (ab-h93; the token design, section 10).",
    "`{\"scope\":\"<box>/<session>\",\"box\":\"<box>\",\"list\":<the grant's list>,\"mcp_token\":\"<64 hex>\"}`",
    "Each admitted request goes, unread, to the Mac service's agent door for that scope (stage 5 decides the carrier: the Mac's gateway or the Mac's daemon).",
    "**The address check** (the operator's answer ab-5t3):",
    "**The route** (the gateway's rules):",
    "**The box comes from the link.**",
    "**The check of each list before the merge.**",
    "| The remote token's mint and the session's entry on the Linux server, the link, the seal, the machine keys, the grant and its approval, the fingerprint lists, the gateway route and its rules, the address check, the rate limit, the Mac rules, the remote session in `set_sessions` (its box from the link's peer identity, each list checked before the merge) | agentwatch |",
    "the remote token check, the answer size limit,",
    "It checks the link, the seal and the grant (the operator's consent), and lists each remote session in its `set_sessions` as",
    "A local scope always needs a local walk; the carrier never gets a local scope.",
    "(\"the answer is larger than the limit for a remote session; ask for a smaller part, for example one element's snapshot or a viewport screenshot\")",
    "cross-box by direct HTTPS with the session's remote token, the gateway's address check and the serving service's fingerprint check (section 9, the token design's answer D c).",
    // Sections 11 and 12.
    "each session's token lives only in its 0600 entry file under agentwatch's tokens folder and in its client's memory; the service holds only its SHA-256 |",
    "the entry files are 0600 in 0700 folders |",
    "a per-session MCP configuration in a 0600 file under agentwatch's tokens folder; the session's own token in the `Authorization` header only, checked against its fingerprint for each request.",
    // Section 19.
    "for Codex the session's profile (`-p aw-<random name>`), whose file is a link to the session's 0600 file under agentwatch's tokens folder (the operator's answers C and ab-ufy, the daemon lead's form); Codex with agentwatch's app server gets no entry until a Codex release lets the app server read a profile (the answer E a of the token design).",
    "No secret is in the URL. The session's own token is in its MCP entry's `Authorization` header, in a 0600 file under agentwatch's tokens folder (the operator's answers C and ab-ufy). The scope in the path is a label: the walk decides the scope.",
    "Q1 is about a local session. Section 9's path for a session of another box does not change by it. The token design's answer D c changes section 9.",
    "**The token design's answers (2026-11-10, each confirmed on its board item).**",
  ]) assert.ok(says(D, s), `the service design says: ${s}`);
  for (const old of [
    "A new design (board ab-v16.94.10) replaces the MCP's admission of section 8.3 and C11, and stage 1d waits for it.",
    "no stdio shim runs, and no key (the operator's answer Q1, section 19)",
    "`set_sessions {sessions:[{scope, repo, roots:[{pid,start}], cgroup}], remote:[{scope, box, list}]",
    "a per-session MCP configuration; and no secret.",
    "Board ab-v16.94.10 designs it before stage 1d builds the MCP; until then, this section is the record of the earlier reading.",
    "until that design says otherwise",
    "**A key per session**: not needed.",
    "and no secret. agentwatch writes it into a configuration of the session's own",
    "Codex: a `-c` override for each launch",
    "names `agentwatch browser mcp --box <mac>`, a stdio shim of agentwatch's.",
    "So the remote path needs a new daemon socket:",
    "The walk is new Python code in agentwatch",
    "Each request and each answer travels sealed, as the link's seal rule says for every link message.",
    "It connects to the Mac service's agent door for that scope and carries the bytes.",
    "the new remote MCP socket, the stdio shim to it",
    "a per-session MCP configuration; no secret.",
    "for Codex a `-c` override for each launch (the daemon lead's change D19)",
    "No secret is in the URL or in the configuration.",
    "cross-box through the link and a new kernel-checked daemon socket",
    "the answer is larger than the link's limit",
    "applies the Mac rules (below), and lists each remote session",
    "the daemon never gets a local scope",
  ]) assert.ok(!says(D, old), `the service design: no ${old}`);
  // The operator's words of the token design's section 2, quoted as they are.
  for (const q of [
    "\"agentwatch mints the token and inserts it into the mcp configuration i think. can we do that? so it gets generated when the session starts.\"",
    "\"mint the token when the agentwatch session begins.\"",
    "\"can't we put the token in the MCP call in the header? i think mcp protocol supports this. so it would be no extra command. it would just be in the headers.\"",
    "\"keep it. token goes in the mcp header.\"",
    "\"you can use an IP allowlist as long as you have the ipv4 and ipv6 of each daemon.\"",
  ]) assert.ok(says(D, q) && says(readOr("docs/superpowers/specs/2026-11-10-mcp-connection-tokens-design.md"), q), `the operator's words, as the token design quotes them: ${q}`);
  assert.ok(!/\/home\//.test(D) && !/abt1_[A-Za-z0-9_-]{8}/.test(D), "no box path and no token in the service design");
});

// ---- The input stage (board ab-t30.6; the input design's section 12.1; board task ab-t30.8) ----
// The stage is built, and its build switch is on (board tasks ab-t30.9 to ab-t30.12, ab-t30.19, ab-t30.21 and ab-t30.22
// built it; board task ab-t30.24 turned the switch on): C11's part "The input stage" and test/vectors/stage.json are the
// contract that the build follows. The tests assert each sentence of the part exactly, and
// that the part holds no other text; they assert the changed rules in the other parts of C11; and small reference rules
// check the vectors against the part's constants, first values, recognizers, typing rule and wheel rule.

const stageText = readOr("test/vectors/stage.json");
const S: any = stageText ? JSON.parse(stageText) : null;
const DESIGN = readOr("docs/superpowers/specs/2026-11-10-vanilla-playwright-human-input-design.md");
const STAGE_HEADING = "The input stage (board ab-t30.6).";
const stagePart = () => partOr(STAGE_HEADING);
// The text of a part with no Markdown markup: no list marker, no table rule, one space for each run of white space.
const clean = (text: string) => text.split("\n").filter((l) => !/^\|(?: --- \|)+$/.test(l.trim())).map((l) => l.trim().replace(/^(?:- |\d+\. )/, "")).join(" ").replace(/\s+/g, " ").trim();
const vectorsOrFail = () => { assert.ok(S, "test/vectors/stage.json has the vectors"); return S; };

// Every sentence of the part, in order (a table row is one item). The part holds exactly these, and no other text.
// Board ab-t30.27: the input stage's files part says when Chrome takes the receiver's DOM.setFileInputFiles (new
// sentences, no old text). The PR's body lists them for the daemon lead.
const T30_27_C11: string[] = [
  "Chrome takes `DOM.setFileInputFiles` from an extension's `chrome.debugger` only while the extension has access to local files, and without it Chrome answers `Not allowed` (board ab-t30.27).",
  "Without that access the read of the types (below) fails, so a set files call passes (`filesPass:noRead`), and Chrome refuses a client's `DOM.setFileInputFiles` with paths after the stage's click.",
  "An unpacked extension (the relay's, the Mac's) has that access by default; the service gives it to its receiver, the packed CRX on Linux, before each start of Chrome (C12, the agent package).",
  "The live check of board ab-t30.27 (the service, Chromium 156 on Linux, the receiver from its CRX) measured: a client with `isLocal: true` sets a local file's path through the stage's click and chooser (`fileClicks` 1, `filesByChooser` 1), and a local folder's path on a `webkitdirectory` input passes (`filesPass:directory`) and reaches the page.",
];
const STAGE_ITEMS: string[] = [
  "**The input stage (board ab-t30.6).**",
  "The input design is agent-browser `docs/superpowers/specs/2026-11-10-vanilla-playwright-human-input-design.md` (board ab-t30.6).",
  "The operator answered its questions Q1 to Q4 on 2026-11-10 with option a each (its section 15; board item ab-0z5).",
  // Board ab-t30.18 (the operator's answer on ab-pf8): a sentence with no text before.
  // review-123 (B1) (before: The operator answered its open points 1 and 2 on 2026-11-12 (board item ab-pf8): a field that opens a panel at a click gets no focus click, and the typed keys of a `fill` stay (the focus click and the typing rule, below).).
  "The operator answered its open points 1 and 2 on 2026-11-12 (board item ab-pf8): a field with a sign that it opens a panel at a click gets no focus click, and the typed keys of a `fill` stay (the focus click and the typing rule, below).",
  // board ab-t30.19: sentences with no text before.
  "The operator answered board item ab-8fu on 2026-11-12: \"can we do a simulated copy/paste for long text input? and we use a person typing for short input only?\"",
  "So a long text goes as a person's paste, and only a short text is typed (the collected keys, the typing rule and the paste, below; board ab-t30.19).",
  "The stage is a part of the model (`src/relay/stage.ts`), between the tab's gate and the bridge.",
  "It keeps what each client call asks for: the point, the button, the keys, the text and the element to scroll to.",
  "It changes how the call reaches the page: a person's path from the page's last point, a pause, a press of a person's length, keys with a person's holds and gaps, a real Shift key, and wheel notches.",
  "The vectors:",
  "`test/vectors/stage.json`.",
  "The build switch.",
  // board ab-t30.19 (before: Board tasks ab-t30.9 to ab-t30.12 build the stage behind a build switch. The switch stays off until all four tasks are merged, so that no part of the stage reaches a client before the whole stage is built.)
  // board ab-t30.22 (before: Board tasks ab-t30.9 to ab-t30.12 and ab-t30.19 build the stage behind a build switch. The switch stays off until all five tasks are merged, so that no part of the stage reaches a client before the whole stage is built.)
  // board ab-t30.21 (before: Board tasks ab-t30.9 to ab-t30.12, ab-t30.19 and ab-t30.22 build the stage behind a build switch. The switch stays off until all six tasks are merged, ...)
  // board ab-t30.24 (before: Board tasks ab-t30.9 to ab-t30.12, ab-t30.19, ab-t30.21 and ab-t30.22 build the stage behind a build switch. The switch stays off until all seven tasks are merged, so that no part of the stage reaches a client before the whole stage is built.)
  "Board tasks ab-t30.9 to ab-t30.12, ab-t30.19, ab-t30.21 and ab-t30.22 built the stage behind a build switch (`STAGE_BUILD_ON`, `src/relay/stage.ts`).",
  "The switch stayed off until all seven tasks were merged, so that no part of the stage reached a client before the whole stage was built.",
  // board ab-t30.24: sentences with no text before.
  "Board task ab-t30.24 turned the switch on: the stage shapes the input of every client in the default path, and no variable and no setting turns it off.",
  "Only a test turns the stage off (the model's `stage` option, `false`).",
  "While the switch is off, the model sends each call as the rest of this file says, and no rule of this part applies.",
  "In this file, \"with the stage on\" names a rule that applies only while the switch is on.",
  // board ab-t30.19: sentences with no text before.
  // board ab-t30.22 (before: With the switch on, the daemon's relay (`agent-browser relay`, the daemon's child) has no clipboard of its own display, so a long text never pastes there: it goes as Playwright's own input (the paste, below, rule 2).)
  "With the switch on, the daemon's relay (`agent-browser relay`, the daemon's child) has no display at all, so a long text never pastes there: it goes as Playwright's own input (the paste, below, rule 2).",
  "Every client.",
  "With the stage on, the stage shapes the input of every client of agent mode on every site, on Linux and on the Mac:",
  "Playwright, the Playwright MCP inside the service, and agent-browser's own commands over the endpoint (the answer Q1 a).",
  // review-129 note 2 (before: No client sets anything.)
  "No client needs to set anything (the client's mark of a secret is optional).",
  "This part adds no op to C10 or C12, and no setting of the operator.",
  "The source.",
  "The stage sends CDP input (`Input.*` through `debugger.sendCommand`) on every platform.",
  "Real X input stays only for the X pointer's path at an activation (the pointer at an activation, above).",
  "On the Mac the stage uses no X input and never the operator's own pointer.",
  // Review-116 (board ab-t30.9), N2.
  "The stage's own commands go as the model sends a client's: a press, or a move with a button down, that has no `force` gets `force` 0.5, and a command that reaches C10's timeout detaches the tab (where each call goes, above).",
  "The calls that the stage takes.",
  "On a page session of a tab (the tab's own session), the stage takes these calls:",
  "`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent` and `Input.insertText`, of every `type`;",
  "`Input.dispatchDragEvent` while a drag of the stage runs (the drag, below);",
  "`DOM.scrollIntoViewIfNeeded` and `DOM.setFileInputFiles`;",
  // board ab-t30.22 (before: each utility call that a recognizer matches (the recognizers, below).)
  "each utility call that a recognizer matches (the recognizers, below);",
  "`AgentBrowser.setSecretInput`, the client's mark of a secret, which the model answers (the paste, below).",
  "It passes every other call as the rest of this file says.",
  // board ab-t30.19 (before: On a child session of a cross-origin frame, the stage takes only `DOM.scrollIntoViewIfNeeded` and the utility calls of the hit-target, focus and fill recognizers.)
  // Board ab-t30.12.1 (before: "On a child session of a cross-origin frame, the stage takes only `DOM.scrollIntoViewIfNeeded`, the utility calls of the hit-target, focus and fill recognizers, and each `Input.*` call (review-126 note 3).").
  "On a child session of a cross-origin frame, the stage takes only `DOM.scrollIntoViewIfNeeded`, the utility calls of the hit-target, focus, fill, select text and select option recognizers, and each `Input.*` call (review-126 note 3).",
  "Such an input call goes as the client sent it, in an action of the tab under the input lock, and it gets Chrome's answer within `STAGE_EVENT_WAIT_MS` (the action's watchdog), so no key reaches a frame while a paste of another page has its text on the clipboard (the paste, below).",
  // review-126b R2 and note 4 (new sentences)
  "Each call of an ended plan, and each call that waits for the lock when the model drops the tab, goes as the events of an ended plan go (dialogs, below): after the dialog's close, with the lock taken again and the activation before a press or a key press; at the end of the client's session it does not go and nothing goes back, and at the tab's end it goes to Chrome as the client sent it (review-126b R2).",
  "An error of such a call fails only that call, as with no stage: the tab's other calls go on (review-126b note 4).",
  "Chrome takes a key event, an `Input.insertText` and a `Control+V` that CDP sends on an out-of-process frame's own session: the frame's field got the text and the paste, with trusted events (measured by board ab-t30.19 on Chromium 156).",
  "Playwright sends the input of a frame on the top page's session, and the stage plays it there.",
  "A same-origin frame has no session of its own: its utility calls come on the top page's session.",
  "The gate.",
  "The stage is a step of the tab's gate.",
  "A tab's calls reach Chrome in the client's order: a call that comes after an input call waits until the stage has sent the events of that input.",
  "So a `Runtime.evaluate` after a click sees the page after the click.",
  "An ordinary call that the stage passes leaves the gate when the model sends it, not when Chrome answers (above).",
  "The stage's own reads (an element's box, the focused element, a hit test, a frame's offset, a scroll position) go to Chrome inside the step, and no client sees them or their answers.",
  // review-119 B3 (before: "... `Target.getTargetInfo`, `DOMDebugger.getEventListeners`).").
  // Board ab-t30.11 (before: "... `DOMDebugger.getEventListeners`, `DOM.getNodeForLocation`).").
  "They run in the relay's own isolated world (the geometry read, above), or they are protocol reads (`DOM.getContentQuads`, `DOM.getBoxModel`, `Page.getLayoutMetrics`, `DOM.getFrameOwner`, `Target.getTargetInfo`, `DOMDebugger.getEventListeners`, `DOM.getNodeForLocation`, `DOM.describeNode`, `DOM.resolveNode`).",
  // Board ab-t30.10 (before: "Three reads start from the node handle of a client's call, and they run in Playwright's utility world on that handle: the frame mapping, the focus click's read of the field, and the recovery's read at the hit point.").
  // review-119 P1 (before: "... the typing rule's read of the focused element in a cross-origin frame ...").
  // Board ab-t30.11 (before: "... (on a node of that frame that a client's call named), and the recovery's read at the hit point.").
  // review-122 B4 (before: "These reads start from the node handle of a client's call, and they run in Playwright's utility world on that handle: the frame mapping, the focus click's read of the field and its hit test, the typing rule's reads of the focused element in a cross-origin frame (on a node of that frame that a client's call named), the scroll's read of the element and its scrollers, the wheel point's read, and the recovery's read at the hit point.").
  // Board ab-t30.18 (before: "... the frame mapping, the focus click's read of the field and its hit test, the typing rule's reads ...").
  "These reads start from the node handle of a client's call, and they run in Playwright's utility world on that handle: the frame mapping, the focus click's read of the field, its hit test and its reads of the area near the field, the typing rule's reads of the focused element in a cross-origin frame (on a node of that frame that a client's call named), the scroll's read of the element and its levels, the wheel point's rules 1, 3 and 4, and the recovery's read at the hit point.",
  // review-122 B4: a case with no rule before.
  // Board ab-t30.18 (before: "Three reads run in other worlds: ..., and the wheel point's rule 2 reads the listeners on handles of the page's main world (`DOM.describeNode` and `DOM.resolveNode`, then `DOMDebugger.getEventListeners`), which run no page script.").
  "Four reads run in other worlds: the scroll's read and the wheel point's rules 1, 3 and 4 on a cross-origin frame's owner run in the relay's own isolated world on the owner (`DOM.resolveNode` with its `backendNodeId`), `mouseWheel`'s column (the scroll and the wheel, below) runs in the relay's own isolated world at the page's last point, and the wheel point's rule 2 and the focus click's read of the field's listeners read the listeners on handles of the page's main world (`DOM.describeNode` and `DOM.resolveNode`, then `DOMDebugger.getEventListeners`), which run no page script.",
  "The input lock.",
  "The agent browser has one input lock for all its pages, in memory (board ab-v16.46).",
  "A translated action holds the lock from its first event to its last.",
  "It takes the lock before its activation step, so that no window comes forward while the action of another page runs.",
  "A pointer action is its path, its press and its release.",
  // Board ab-t30.17, N9 (PR #116): new sentences (old: none; the lock was free between two steps of mouse.move with steps).
  "A move with no button down keeps its action and the lock for the tab's next call (a move run): a step of `mouse.move` with `steps` comes only after the answer of the step before, so no other tab's action comes between two steps (the open point N9 of board ab-t30.17).",
  // review-136 notes 7, 8 and 9 (before: The run ends at the tab's next call that the stage does not take, 1 s (`RUN_IDLE_MS`) after the move, or at the action's limit `STAGE_ACTION_MAX_MS`.)
  "The run ends at the tab's next call that the stage does not take, 1 s (`RUN_IDLE_MS`) after the move, or at the action's limit `STAGE_ACTION_MAX_MS`.",
  "That limit counts from the action's start, so a `mouse.move` with many `steps`, or a client's moves less than 1 s apart, can reach it: the stage then ends the action there, as at each action's limit, and logs it (review-136 note 7).",
  "A call that the stage does not take while the tab's next move waits in the tab's gate does not end the run, which then ends 1 s after its last move (review-136 note 8: only calls of one tab that a client sends at the same time do this; Playwright sends the steps one at a time).",
  "A navigation of the main frame does not end the run: a move in the next 1 s goes in the same action into the new document, with no new activation (review-136 note 9).",
  "A key run is the keys of one tab with no other call between them: it ends at the tab's next call that is not a key, or 1 s after its last key.",
  // Board ab-t30.10: the open point N10 of PR #116 (board ab-t30.17): the lock rule for keys.
  // review-119 N13 and B7 (before: "A key that a client holds down, a modifier or not, keeps its run and the lock until the key's `keyUp`, as a held button does, within the limit `STAGE_ACTION_MAX_MS` (board ab-t30.10, the open point N10 of board ab-t30.17).").
  "A key that a client holds down, a modifier or not, keeps the action and its lock until the key's `keyUp`, as a held button does, within the limit `STAGE_ACTION_MAX_MS`, which counts from the action's start (board ab-t30.10, the open point N10 of board ab-t30.17).",
  "The tab's next call that is not a key still ends the key run, and it goes in the same action.",
  "The 1 s counts from the run's last key event when the client holds no key.",
  // review-119b note (one action) (before: "Playwright's focus call (and the call of `fill` when it gets a focus click), its focus click and the keys or the text that follow it are one action: one lock, one activation and one limit, from the focus call.").
  "Playwright's focus call, its focus click (when it gets one) and the keys or the text that follow it are one action: one lock, one activation and one limit, from the focus call.",
  "So are the call of `fill` that takes the lock (its field is a text field that fails the first focus test of the focus click, below), its focus click (when it gets one) and the text that follows it.",
  "With no key after it, such an action holds the lock until 1 s (`RUN_IDLE_MS`) after the call, or until the tab's next call that is not a key.",
  // board ab-t30.19: sentences with no text before.
  "A collected part (the collected keys, below) sends no event while it collects: it goes in the action that is open (the action of Playwright's focus call), else it takes the lock at its end, with the activation.",
  "Another tab's input waits for the lock, in the order of arrival, and that tab's later calls wait behind it in its own gate.",
  "In the service, agent-browser's own commands reach Chrome through the endpoint and the stage, so they share the lock.",
  "The file lock `input.lock` stays only for agent-browser's direct mode (its own Chrome, with no endpoint).",
  // Review-116, B3 (before: "at the limit the stage sends the rest of the action at once, with no person's timing, and logs it.").
  "A hold has the limit `STAGE_ACTION_MAX_MS = 25000`: at the limit the plan ends (dialogs, below), so the lock is free at once, the rest of the action goes with no person's timing, and the stage logs it.",
  // Board ab-t30.10 (before: "At this limit the stage sends no release of its own: the client still holds its button or key, and its own release goes later.").
  "At this limit the stage sends no release of a client's button or key: the client still holds it, and its own release goes later.",
  // review-119 B6 and the daemon lead's P3 (before: "The stage sends at once the planned releases of a key run (a release that it answered early) and the release of each key of its own (its Shift, a chord's modifier).").
  "The stage takes the lock again in the order of arrival, with the same limit, as the events of an ended plan do (dialogs, below), and then sends the planned releases of a key run (a release that it answered early) and the release of each key of its own (its Shift, the modifier of a chord that the stage sends, such as the Control of `Control+Home`, and a key of a typed text).",
  // Review-116b R1: the lock that an ended plan's events take again has a limit.
  // review-126b note 3 (before: The lock that an ended plan's events take again (dialogs, below) has the same limit: at the limit it is free, and the plan's remaining ended calls go with no lock and no activation.)
  "The lock that an ended plan's events take again (dialogs, below) has the same limit: at the limit it is free, and the plan's next ended call takes it again in the order of arrival, with the same limit and the activation before a press or a key press, so no ended call goes with no lock (review-126b note 3).",
  "The answers.",
  "A held answer.",
  "The stage answers a client call only after it has sent the events of that call and Chrome has answered them:",
  "a move, after the last move of its path;",
  "a press, after the pause and the press;",
  "a release, after the hold and the release;",
  "a wheel call, after its last notch;",
  "a key press, after the key's `keyDown`.",
  "Playwright sends the move, the press and the release of a click together, so the release arrives before the press has its answer.",
  "The stage keeps their order.",
  "The early answer of a key release.",
  "Rollover needs the next key's press before this key's release, and Playwright waits for the answer of each key call.",
  // review-123 (the bound, the smaller option) (before: So the stage answers a `keyUp` before it sends it when the plan says that the next key can overlap: the base part of the next interval (the interval less the part of the letter pair) is shorter than this key's hold. The release then goes at its planned time.).
  // review-123b (the smaller option removed: the old text again) (at 780229e: So the stage answers a `keyUp` early in two cases: before it sends it, when the plan says that the next key can overlap (the base part of the next interval, the interval less the part of the letter pair, is shorter than this key's hold); and when it has sent it, with no wait for Chrome's answer, in the rest of a key run after `STAGE_ACTION_MAX_MS` (the time of a key run, below). In the first case the release then goes at its planned time, and in the second at once.).
  "So the stage answers a `keyUp` before it sends it when the plan says that the next key can overlap: the base part of the next interval (the interval less the part of the letter pair) is shorter than this key's hold.",
  "The release then goes at its planned time.",
  "Every later call of the tab that is not a key press waits until that release has gone.",
  // board ab-t30.19 (before: In no other case does the stage answer a call before its events. A client can trust an answer: the page has the events.)
  "Each call of a collected part gets its answer at once, before its events (the collected keys, below).",
  "In no other case does the stage answer a call before its events.",
  "A client can trust an answer: the page has the events, and the events of a collected part reach it before the tab's next call.",
  "An error of an event.",
  "When Chrome refuses an event of a plan, the stage stops the plan and sends no more of its events.",
  "First it sends the release of each button and key that the plan holds.",
  "The client call of the refused event gets Chrome's error, and each other client call of the plan whose events did not go gets the same error.",
  // Review-116, N8.
  // Review-116b note E. Old: "... and the setup goes as the client sent it."
  "A sample that the stage sends before a hit-target setup (the hover's samples outside the target, the recovery's move out) belongs to no client call that has come: at its error the plan stops in the same way, and the setup goes as the client sent it, with no path of the stage's before it (no hover path).",
  "Shift and rollover.",
  "A key with no Shift that follows a shifted key waits for the planned release of that key and for the release of Shift.",
  "The stage never sends a release before its planned hold has passed.",
  "Dialogs (the input design, section 4.3a).",
  "A page with an open dialog answers no input event, and the stage waits for the answers of its own events.",
  "A client's `Page.handleJavaScriptDialog` never waits.",
  "With the stage on, the model sends it to Chrome at once, before the tab's gate and before any step of the stage, of an activation or of a world lookup.",
  "A client sends that call only after `Page.javascriptDialogOpening`, so it expects no call of its own to go first.",
  "A dialog ends the plan.",
  "The stage watches the tab's `Page.javascriptDialogOpening` events that go to the client.",
  "When a dialog opens during a plan, the plan ends at once:",
  "The stage drops the events of the plan that no client call asked for (the rest of the path, the pauses).",
  // Board ab-t30.9 measured open point 5: Chrome drops the input that it gets while a dialog is open (the rule before:
  // "It sends at once, in order, each event ...", "It frees the input lock and opens the tab's gate.", "Chrome keeps these
  // events until the dialog closes, as with Playwright's own input.", and the conditional "If the build measures that
  // Chrome drops input events while a dialog is open, this rule changes first: then the client calls of an ended plan get
  // an error that names the dialog").
  "It frees the input lock at once.",
  // Review-116, B1 and N3 (before: "When the dialog closes (`Page.javascriptDialogClosed`, or Chrome's answer to the
  // client's `Page.handleJavaScriptDialog`), it sends at once, in order, ... and the release of each button and key that
  // the plan holds. Then it opens the tab's gate.").
  "When the dialog closes, it takes the input lock again, in the order of arrival, and it runs the activation before an ended press or key press (the window comes forward for input, above).",
  "It sends at once, in order, each event that a client call of the plan asked for and that has not gone (the move to the client's point, the press, the release), and the release of each button and key that the plan holds, with the `clickCount` of its press.",
  "Then it frees the lock, and only then does it open the tab's gate.",
  // Board ab-t30.17, note D of PR #116: a new sentence (old: none; the end's release went at once, while the second dialog was open).
  "An ended press or key press can open a dialog of its own, and Chrome answers it only after that dialog's close: so the release of each button and key that the plan holds waits for the answers of the ended presses and key presses that went, at most `STAGE_EVENT_WAIT_MS`, and then for the close of a dialog that is open (note D of board ab-t30.17).",
  // review-136 note 6 (a new sentence).
  "The stage holds the input lock in that wait, so the other tabs wait for the lock while that dialog stays open, at most `STAGE_ACTION_MAX_MS`; an ended press or key press on a frame's own session is not waited for, because Playwright sends no input there (review-136 note 6).",
  "Chrome keeps the input events that it got before the dialog opened, and it drops each input event that it gets while the dialog is open: it answers that event at once, and the page never gets it (measured by board ab-t30.9 on Chromium 156: a release and a move sent while the `confirm()` of a `mousedown` handler was open were answered at once and never reached the page, and the press that opened the dialog was answered after the close).",
  "So the stage holds the events of an ended plan until the close, and the page gets what Playwright's own input gives it.",
  "The stage never goes on with a plan after its dialog closes, and the tab's later calls wait in its gate behind those events, so no event of a plan goes after a later client call.",
  // Review-116, B1 and B3: one rule for every end of a plan; N1 and the daemon lead's point: the end of the wait.
  // Review-116b note A. Old: "...; only at a dialog do steps 3 and 4 wait for the close."
  "Every end of a plan (a dialog, `STAGE_EVENT_WAIT_MS`, `STAGE_ACTION_MAX_MS`) follows these steps; only at a dialog do steps 3 and 4 wait for the close, and at `STAGE_ACTION_MAX_MS` step 4 sends no release of its own (the input lock, above).",
  // Review-116b R1 and the daemon lead's point on sentence 6. Old: "The end of the wait for a close: ...; a navigation of the
  // tab's main frame (...); `Inspector.targetCrashed`; and the end of the tab in the model (its target ends, the tab closes,
  // Chrome detaches it, or the client's session or connection ends)." "Then the stage sends the held events, and each held
  // client call gets Chrome's answer, or Chrome's error for a closed target; then the gate opens."
  // Board ab-t30.17, point 2. Old: "...; the client's `Page.disable` (no `Page.javascriptDialogClosed` can come after it); ..."
  "The end of the wait for a close: `Page.javascriptDialogClosed`; Chrome's answer to the client's `Page.handleJavaScriptDialog`; after the client's `Page.disable`, the answer of the stage's own read of the page (below); `Inspector.targetCrashed`; a navigation of the tab's main frame (`Page.frameNavigated` with no parent); and the end of the tab in the model (a drop).",
  "At the first four the steps above go on: the stage sends the held events, and each held client call gets Chrome's answer, or Chrome's error.",
  "At the others:",
  "A navigation of the main frame.",
  "The stage sends no held move, press or key press, so none reaches the new document.",
  "Each held client call gets the error that the context is gone.",
  "Step 4 sends only the release of each button and key that the plan holds, with the `clickCount` of its press, so nothing stays down.",
  "Then the lock is free, and the gate opens.",
  // Board ab-t30.17, point 1 (note C of review-116b) and the daemon lead's point on a beforeunload dialog: new sentences
  // (old: none; a close always sent the held events, also a close that a navigation made).
  "Chrome closes an open dialog at the start of a navigation of the main frame, before its `Page.frameNavigated` (measured by board ab-t30.17 on Chromium 156: at a client's `Page.navigate` while the `confirm()` of a `mousedown` handler was open, `Page.frameStartedNavigating` came, and 4 to 7 ms later `Page.javascriptDialogClosed` with `result` false, with no `Page.frameNavigated` before it; the held events that the probe sent at that close reached the old document, and its held press opened a new `confirm()`, so the navigation never committed).",
  // review-136 notes 1, 2 and 3 (before: So these are a navigation of the main frame too: a close while a cross-document navigation of the main frame is under way (its `Page.frameStartedNavigating` came at most `STAGE_ACTION_MAX_MS` before the close, with no `Page.frameNavigated` or `Page.frameStoppedLoading` of the main frame after it; the main frame is the frame of the last `Page.frameNavigated` with no parent, else the dialog's frame), also one that started before the dialog opened; the close of a `beforeunload` dialog that the client accepts (it starts the navigation); and a `Page.frameNavigated` with no parent after the close while the held calls of the dialog's plan have not gone (they wait for the lock again).)
  "So these are a navigation of the main frame too: the close of a dialog that is not a `beforeunload` dialog while a cross-document navigation of the main frame is under way (its `Page.frameStartedNavigating` came at most `STAGE_ACTION_MAX_MS` before the close, with no `Page.frameNavigated` of the main frame after it and no `Page.frameStoppedLoading` of the frame of that start; the main frame is the frame of the last `Page.frameNavigated` with no parent, else the tab's target, whose id is Chrome's id of its main frame, else the dialog's frame; review-136 notes 1 and 2), also one that started before the dialog opened; the close of a `beforeunload` dialog that the client accepts (it starts the navigation; a dismissed one is no navigation, also after a navigation that started before it: review-136 note 3); and a `Page.frameNavigated` with no parent after the close while the held calls of the dialog's plan have not gone (they wait for the lock again).",
  "The end of the client's session or connection (also a C10 timeout's detach, which ends the client's sessions of the tab, and the end of the relay's link, which closes every connection).",
  "The stage sends no held event, and nothing goes back to the client.",
  "It sends only the release of each button and key that the plan holds, with the `clickCount` of its press, at once, before the model detaches the tab.",
  "The lock is free at once, and the gate opens.",
  "The tab's end (its target ends, the tab closes, or Chrome detaches it).",
  "The lock is free at once.",
  "Each held client call goes to Chrome as the client sent it, with no lock, and gets Chrome's answer, or Chrome's error for a closed target.",
  "Then the stage sends the release of each button and key that the plan holds, and the gate opens.",
  // review-131 B1: new sentence
  // review-131b N4 (before at 0fa5dbc: For the paste's closed set (the paste, rule 6), only a close ends the tab's page: at Chrome's detach of the debugger the page can still run, and the paste path stays closed for `V_READ_MAX_MS` after it (review-131 B1).)
  "For the paste's closed set (the paste, rule 6), only a close ends the tab's page: at Chrome's detach of the debugger the page can still run, and the paste path stays closed for `V_READ_MAX_MS` after it when, at the detach, the tab's `V`, its read or its closed path was in the set (review-131 B1).",
  "A drop ends the plan also when no dialog is open.",
  "Each held call of a dropped tab ends on the tab's old state, also when its step runs after the drop, so no lock stays with a dropped tab.",
  // Board ab-t30.17, point 2 (review-116b): new sentences (old: none; the wait ended at the client's Page.disable, and the held events went while the dialog was open).
  "The client's `Page.disable` ends no dialog: Chrome's dialog manager keeps it open (measured by board ab-t30.17 on Chromium 156: while the `confirm()` of a `mousedown` handler was open, Chrome gave no answer to a session's `Page.disable` in 3 s, and none to its `Page.getFrameTree`; another session's `Page.handleJavaScriptDialog` closed the dialog 7.5 s after that `Page.disable`, and only then did Chrome answer the press and a `Runtime.evaluate` that the first session sent while the dialog was open).",
  // review-136 note 4 (before: So a client's `Page.disable` while the stage waits for a close goes to Chrome at once, before the tab's gate (the ended plan's calls wait there for that close), as a client's `Page.handleJavaScriptDialog` does.)
  "So a client's `Page.disable` while the stage waits for a close goes to Chrome at once, before the tab's gate (the ended plan's calls wait there for that close), as a client's `Page.handleJavaScriptDialog` does.",
  "It then goes before the same client's calls that wait in the tab's gate (the held input calls and any later call, for example a `Page.enable`), and their answers can come after its answer (review-136 note 4).",
  "After it no `Page.javascriptDialogClosed` can come, so the stage then reads the page in the relay's own isolated world (a read that reads nothing): Chrome answers that read only when the page runs again, after the dialog's close (where Chrome ends the dialog at `Page.disable`, at once).",
  "The read's answer or its error ends the wait; with neither in `STAGE_ACTION_MAX_MS` after the `Page.disable`, the wait ends then, the held events go (Chrome drops those that it gets while the dialog is open), and the stage logs it.",
  // review-136 note 5 (a new sentence).
  "The read is `Page.createIsolatedWorld`, then `Runtime.evaluate`; no probe measured `Page.createIsolatedWorld` while a dialog is open, and for a dialog of a frame in another process the main frame's read answers at once: where Chrome answers the read at once, the wait ends at once and the held events go while the dialog is open, as before the read (review-136 note 5).",
  "Each client call of an ended plan gets Chrome's own answer to its event when that answer comes, or Chrome's error.",
  // Old: "The stage gives no answer of its own."
  "The stage gives no answer of its own, except the error at a navigation of the main frame (above).",
  "Each read of the stage waits at most `GEOMETRY_WAIT_MS` (200 ms).",
  "At the limit the read fails open: the stage sends the client's call as it is, and counts it.",
  "Each wait for an answer of the stage's own event has the limit `STAGE_EVENT_WAIT_MS = 2000`, counted from the oldest event of the plan that has no answer.",
  "At the limit the plan ends as at a dialog.",
  "This also covers a dialog when no client has `Page` enabled, and a dialog between two events of a plan.",
  "A late answer changes nothing.",
  "With no `Page.javascriptDialogOpening` the stage knows of no dialog, and it sends the events of the ended plan with no wait for a close.",
  "A hold counts from the send of the press, not from its answer, so a `confirm()` in a `mousedown` handler does not make the hold longer.",
  "When the answer of the press does not come, the plan ends by these rules, and the release goes by the steps above: after the dialog's close, or with no wait for a close when the stage knows of no dialog.",
  "The timestamps and the rate.",
  "Each event that the stage sends has a CDP `timestamp` that is a person's input latency before its send:",
  // Board ab-t30.15, R10 P2 (old: "`(Date.now() - latency) / 1000` on Linux, in whole milliseconds, as X11 gives the times of its events.").
  "`(Date.now() - latency) / 1000` on Linux, on a whole millisecond of the X server's clock, as X11 gives the times of its events.",
  "The X server's clock is the monotonic clock, and Chrome maps a CDP `timestamp` to it by the offset of the monotonic clock to the wall clock, which Chrome reads once (`TimeTicks::UnixEpoch()`).",
  "So the stage rounds `Date.now() - latency + offset` to a whole millisecond and then takes the offset away; it reads the offset once, as the monotonic time at a change of `Date.now()` less its millisecond (the median of 5 reads).",
  "A page then sees whole-millisecond gaps also between the stage's events and the X server's own events, for example the event at the X pointer when Chrome brings a window forward (the harness's row R10).",
  "The latency is `STAGE_LATENCY_MS` = 3 to 5 (ms, a first value).",
  "The time comes from the send, never from the plan, so no event has a time in the future.",
  "On the Mac the timestamp keeps its fraction:",
  "`(performance.timeOrigin + performance.now() - latency) / 1000`.",
  // Board ab-t30.13 (before: "Pointer moves go at the rate of a device: one move each `STAGE_MOVE_MS = 8` ms (125 Hz, a first value).").
  "Pointer moves go at the rate of a device: one move each `STAGE_MOVE_MS = 8` ms (125 Hz; part B: the person's sample gaps median 8.1 ms, p10 7.9, p90 8.3).",
  "The stage sends each move at its time, with no wait for the answer of the move before it.",
  "Chromium then puts the moves of one frame into one `pointermove` with their samples, as for a real mouse.",
  "At most `STAGE_MOVES_IN_FLIGHT = 8` moves of a tab are without an answer.",
  "When a move is due while 8 wait, the stage stops the path, sends the client's own event, and logs it.",
  "For the stage's paths this bound takes the place of `CATCH_UP_MAX_UNANSWERED`.",
  "On Linux the stage rounds each point to a whole CSS px, as X11 gives its points.",
  "Playwright's points can have a fraction.",
  // Board ab-t30.32, step B1 (new sentences; before: none). The Mac probe's move went through the stage's whole-px path.
  // The review's fix round (I1, M2): the stage's own points are whole px on the Mac too; only the client's keep a fraction.
  "On the Mac the stage's paths and short moves are in whole CSS px too (`mac.json` `device.wholePx`), and so are the points that the stage chooses itself (a wheel point, the spread point, the point of its own click).",
  "Only the client's own points keep their fraction on the Mac, for example a press and its release at the client's point: where the pointer's rules (below) round the client's point, they round it on Linux only, and a path to a client's point ends at that point rounded.",
  "Board ab-t30.32 keeps the device's whole px on the Mac (`device.wholePx` stays true): step B1 of the input fit (a press with a person's fraction) does not pass, and step B2 (the moves of less than 1 px) does not start.",
  "A person's pointer events on the Mac all have a fraction (part B: 3208 of 3208 `pointermove` events), but no probe has shown yet that a fraction of a CDP point reaches a page on the Mac.",
  "The Mac probe (Chrome 158 on macOS) moved the pointer to 300.37, 200.61 through the stage's whole-px path, and the page got `clientX` 300 and `clientY` 201, with a fraction in 0 of 59 `pointermove` events.",
  "A person's input (first values).",
  "The generator (`src/human/`) draws each value with a seed, from the parameter files `src/human/params/linux.json` and `mac.json`.",
  // Board ab-t30.13: the next two sentences are new (the values of the hand and of the device).
  "The values of the hand (path, pause, press, keys) are the same in `linux.json` and `mac.json`.",
  "The values of the device (whole px, whole ms, the wheel) are different for each platform, as the rules below say.",
  "A reviewed change of a parameter file changes these values, this part and the vectors together.",
  "Each scope gets one person, drawn once for the life of the scope, so that a site cannot link two sessions by one rhythm.",
  "A path starts at the page's last point, never at a fixed point.",
  "When the page has no last point, the path starts at the X pointer's place mapped into the page (Linux, at an activation), else at a random point of the middle 30% to 70% of the viewport.",
  // Board ab-t30.13 (before: "... at a speed of at most 3.5 px/ms.").
  // Board ab-t30.32, the review's fix round (M2) (before: "A path has one sample each `STAGE_MOVE_MS`, in whole px on Linux, ..." and "It ends at the client's point, or at the spread point of its press (below).").
  "A path has one sample each `STAGE_MOVE_MS`, in whole px, with no sample that does not move, at a speed of at most 8 px/ms.",
  "It ends at the client's point rounded to a whole px, or at the spread point of its press (below).",
  "Its time is 300 to 1000 ms (Fitts's law).",
  "When a long move cannot keep both rules, the speed rule wins: the path takes longer than 1000 ms, and its time has no upper bound.",
  "A move of more than 500 px can add an overshoot leg only while its time stays at most 1500 ms.",
  // Board ab-t30.30 (new sentences; before: none, and the stage's paths had no clamp). Review-165 B1, N1 and N2 (before:
  // "Each sample of a path but the last stays 2 px inside the page's content box, as the catch-up's points (board
  // ab-t30.30: ...)." and "The stage reads that box once for each action, after its activation: ...").
  "From the first sample of a move inside the page's content box, 2 px inside its edges as the catch-up's points, to its last sample there, each sample stays inside that box (board ab-t30.30: a path past the viewport's edge gave the page an unexplained change live).",
  "The samples before and after that range and the last sample stay as planned, so no step gets longer, and a sample that the box puts on the one before it goes, which leaves a gap of two or more sample times.",
  "This holds for a path and for the client's line of a short move, whose sample at the box's edge can then be more than 1 px off that line.",
  "The stage reads that box once in each action, when it plans the action's first move: from the page's kept geometry, else from a read that keeps none; with the paths off (the Mac too) or with no usable geometry, no sample is clamped.",
  // Board ab-t30.13 (before: "The pause before a press is 80 to 400 ms."; the sentence after it is new).
  "The pause before a press is 25 to 190 ms.",
  "It counts from the last sample that moves the pointer 1 px or more.",
  "The press has `force` 0.5 and a hold of 60 to 180 ms.",
  "The gap of a double click, from the first release to the second press, is 90 to 150 ms.",
  "The hold of a key is 50 to 250 ms.",
  // Board ab-t30.13 (before: "A Shift `rawKeyDown` comes 45 to 95 ms before a shifted character, ...").
  "A Shift `rawKeyDown` comes 45 to 480 ms before a shifted character, which then has `modifiers` 8, and the release of Shift comes 15 to 60 ms after the release of the last key that it holds.",
  "A run of shifted characters keeps Shift down.",
  "In a chord, each modifier comes 40 to 120 ms before the key, and the releases come 20 to 80 ms apart, in reverse order.",
  // Board ab-t30.10 (review-111 point 3): a client's chord of two modifiers.
  // review-119 N9 (before: "A client's second modifier of one chord (for example `Control+Shift+ArrowLeft`) comes 20 to 80 ms after the first.").
  "A client's later modifier of one chord (for example the Shift of `Control+Shift+ArrowLeft`) comes 20 to 80 ms after the one before, and less when that keeps all of them within 80 ms of the first, so that the key comes 40 to 120 ms after each.",
  // Board ab-t30.32, step B3 (before: "A wheel notch is `STAGE_NOTCH_PX = 120` px on Linux (the notch of X11), and the gaps between notches are 35 to 90 ms.").
  "A wheel notch is `STAGE_NOTCH_PX = 120` px on Linux (the notch of X11) and on the Mac (board ab-t30.32: the scroll and the wheel, below), and the gaps between notches are 35 to 90 ms.",
  // Board ab-t30.34 (before: No idle moves: the pointer moves only for a client's call (the answer Q4 a).)
  "No idle moves: the pointer moves only for a client's call (the answer Q4 a) and for the hand in the stage's own hold of `browser_press_hold` (the press and hold, below; board ab-t30.34).",
  "The pointer:",
  "`Input.dispatchMouseEvent`.",
  "`mouseMoved` with no button down, to the page's last point: no event, because a mouse that does not move sends none.",
  "The stage answers it at once, with no lock and no activation.",
  "`mouseMoved` with no button down, at most 50 px from the page's last point: samples of the client's line at the rate of the device.",
  "Their speed is 0.5 to 1.5 px/ms, with 0 to 1 px of jitter across the line.",
  "Such a move is a step of `mouse.move` with `steps` or of `click({ steps })`, or a short move.",
  "`mouseMoved` with no button down, farther: a path from the page's last point to the client's point.",
  "A hover (a hit-target setup with the action `hover`, below).",
  "When the stage sees the setup, it plans the whole path to Playwright's point, sends the samples of the path that are outside the target's box, and then sends the setup.",
  "It sends the rest of the path, from its first sample inside the box, at Playwright's `mouseMoved`.",
  "When the pointer is inside the target's box already, the whole path goes after the setup.",
  "With `hover({ modifiers })` the modifier's press goes as the client sends it, and the last leg has the client's `modifiers`.",
  // Board ab-t30.9 (the pointer part's build): the cases that had no rule.
  "The hover's action holds the input lock from its first sample to its last.",
  "When Playwright's `mouseMoved` does not come within 1 s of the answer of the setup, the stage drops the rest of the path and frees the lock, and it does so at once after a miss of the setup.",
  "`mousePressed`: a pause when the press follows a path, then the press, with the client's `button`, `buttons`, `clickCount` and `modifiers`, and `force` 0.5.",
  "The press is at the client's point rounded to a whole px, or at the spread point (below).",
  "A press with `clickCount` 2 or 3 comes one gap of a double click after the release before it.",
  "A press away from the page's last point (a client that sent no move there) gets a path there first, and then the pause.",
  "`mouseReleased`: the release, at the later of its arrival and the send of the press plus the hold.",
  "So a client's `delay` gives a hold of at least that delay.",
  "The release of a button that the stage released at the end of a plan (dialogs, above) gets no event, because a button that is up cannot go up: the stage answers it at once.",
  "The same holds for the `keyUp` of such a key.",
  "The spread point.",
  "A person's press spreads around the middle of a target: an offset from the middle with a standard deviation of 1/8 of the target's smaller side, at most 1/4 of that side.",
  "The path then ends at the spread point.",
  "The stage uses it only when all of these are true;",
  "else it presses at the client's point, rounded:",
  "a locator click: a hit-target setup of the action `mouse` before it, `clickCount` 1, and no press of the same action with `clickCount` 2 or 3 (so never a press of a `dblclick` or of a triple click);",
  "no `position`: the client's point is within 1 px of the middle of the element's content quad (the answer of the client's own `DOM.getContentQuads`);",
  "an element whose effect does not depend on the point:",
  "`button`, `a[href]`, an `input` of the type `button`, `submit`, `reset`, `checkbox` or `radio`, `label`, `summary`, or an element with the role `button`, `link`, `checkbox`, `radio`, `tab`, `menuitem` or `switch`;",
  "never a `canvas`, an `img` with a map, an `svg`, a `video`, an `input` of another type, a `textarea` or a contenteditable;",
  "the stage's own hit test at the spread point gives the same element as at the client's point.",
  "The stage decides the spread point when it plans the path to the client's point.",
  "So a press that comes after the answer of that move (a click with `delay`) and a click in a frame (whose hit-target setup gives the hit point in the frame's own points) are at the client's point, rounded.",
  "A click with a modifier (Playwright's `ensureModifiers`).",
  "The modifier's `rawKeyDown` goes as it comes, because Playwright waits for its answer before the move.",
  "The path and the press have the client's `modifiers`.",
  "The stage holds the modifier's `keyUp` until 60 to 200 ms after the mouse release, and answers it after it has gone.",
  "When the pointer is at the client's point already (no path), the press comes 40 to 120 ms after the modifier's press, the time of a chord.",
  "A click or a hover in a frame.",
  "The client's input comes on the top page's session, in the top page's points, and the stage plays it there.",
  "The hit point of a hover's setup in a frame is in the frame's own points, and the stage maps it to the top page (the frame mapping, below).",
  "`Input.dispatchTouchEvent` and `Input.synthesizeTapGesture` go as they are.",
  "Playwright refuses `tap()` without `hasTouch`, and a context from `connectOverCDP` has none.",
  "The drag.",
  "`mouseMoved` with the left button down while the client's `Input.setInterceptDrags` is on (Playwright's drag manager: `dragTo`, and `mouse.move` with a held button over an HTML5 draggable).",
  "The stage first waits 100 to 300 ms after the press, as a person does.",
  "Then it sends a short path with the button down, until Chrome reports `Input.dragIntercepted`.",
  // Board ab-t30.12.3: the probe's facts, the model's report, a report after the last move (sentences with no text before).
  "Each move goes after Chrome's answer of the move before it.",
  "Chrome's report comes before the answer of the move that starts the drag, the first move more than 4 px from the press on one axis (measured: board ab-t30.12.3).",
  "The model gives the stage Chrome's `Input.dragIntercepted` of the tab's own session, and the client gets it too.",
  "It sends the rest of the path to the client's point as `Input.dispatchDragEvent`: first a `dragEnter` of its own at the first point after the report (with the data of `Input.dragIntercepted`), then `dragOver` events at the rate of the device.",
  "When the report comes after the last move, that `dragEnter` goes at the client's point.",
  "When Chrome reports no drag, the whole path goes with the button down.",
  // Board ab-t30.12.3: Playwright's view of a person's drag (sentences with no text before).
  "Playwright's drag manager looks for a `dragstart` right after the page's first `mousemove` with the button down.",
  "A person's path starts with short moves, so the drag starts at a later move, and Playwright sees no drag (measured: board ab-t30.12.3).",
  "It then sends no `dragEnter` and no `drop`: its later moves and its release go as mouse events.",
  "So in a drag that Chrome reported, a client's `mouseMoved` with the left button down goes as the path to its point (drag events), and the client's release of the left button goes as the `drop` at its point, after a pause.",
  "A client's `Input.dispatchDragEvent` in a drag of the stage: a `dragEnter` goes as a `dragOver` at its point, because the page has its `dragenter` already.",
  "A `dragOver` goes as a path of `dragOver` events to its point.",
  "A `drop` goes after a pause, as a press does.",
  "A `dragCancel` goes as it is.",
  // Board ab-t30.12.3: the drop's point, the end of the drag and of a plan in it (sentences with no text before).
  "A drop at another point than the page's last one gets the drag's path there first.",
  // review-138 N2 and N3 (before: A drop or a `dragCancel` ends the drag and the press: Chrome's button is up after it (measured), so no release goes after it.)
  "A drop or a `dragCancel` ends the drag and the press, also one of an ended plan (review-138 N2): Chrome's button is up after it (measured), so no release goes after it.",
  "When Chrome answers that drop or `dragCancel` with an error, the drag and the press stay, and the plan's stop sends the `dragCancel` of a drag that Chrome reported, or else the release (review-138 N3).",
  "A drop or a `dragCancel` that goes as it is ends the stage's record of the press also when Chrome had no drag, and one of an ended plan ends it also at an error answer: then no release goes after it (review-138 N3).",
  "When a plan ends in a drag that Chrome reported (dialogs, `STAGE_EVENT_WAIT_MS`), the end sends a `dragCancel` in place of the release of the left button.",
  // review-138 N4 (a new sentence).
  "When the plan ends before Chrome's report of a drag that the client's last move started, the end sends the release, and the stage ignores the later report: Chrome's intercepted drag then ends at the client's own drop or `dragCancel` (review-138 N4: a narrow race; the client gets the report too).",
  // Board ab-t30.12.3 (before: A drag event of a drag that the stage did not start goes as it is.)
  "A drag event of a drag that the stage did not start goes as it is, and the stage counts it (`dragAsIs`).",
  "Its drop or `dragCancel` ends the client's press too.",
  "The keys and the text:",
  "`Input.dispatchKeyEvent` and `Input.insertText`.",
  // board ab-t30.19 (before: A key run (`keyboard.type`, `pressSequentially`, `type`, `press`, `keyboard.down` and `keyboard.up`): each key gets a person's timing.)
  "A key run (`keyboard.type`, `pressSequentially`, `type`, `press`, `keyboard.down` and `keyboard.up`): each key that the stage does not collect (the collected keys, below) gets a person's timing.",
  "That is the hold, the time from one press to the next with its pauses at the ends of words and lines, and rollover by the early answer.",
  "A key press goes at the later of its arrival and its planned time.",
  "A release goes at the later of its arrival and the end of the key's planned hold.",
  "So a client's `delay` gives a hold of at least that delay.",
  "A shifted character that comes with `modifiers` 0 (Playwright's capital or symbol): a Shift `rawKeyDown` before it, the key with `modifiers` 8, and the release of Shift after it.",
  "In about 70% of cases the left Shift (`location` 1) comes for a key of the right hand, and the right Shift (`location` 2) for a key of the left hand.",
  "A chord of `press` (for example `Control+A`): the client's modifier presses, the key and the releases in reverse order, with the times of a chord above.",
  // Board ab-t30.10: the cases with no rule before (review-111 points 1 and 2; a raw client's char and modifier bits).
  "A key that comes with the Shift bit while no Shift key is down gets the same Shift press.",
  // review-119b R2 (before: "A client's own press of Shift while the stage's Shift is down sends no event, because the key is down; the client's later release is the release of that Shift.").
  "A client's own press of Shift while the stage's Shift is down sends no event, because the key is down; the client's later release is the release of that Shift, with that Shift's own code (its side), also after `STAGE_ACTION_MAX_MS` and at an ended plan, and it sends no event when the end of a plan released that Shift already.",
  // review-119 N2 and the daemon lead's P2.
  "The Shift is then the client's, and the stage sends no release of its own for it.",
  "When the client releases it before the stage's shifted characters end, the next shifted character gets a new Shift press of the stage's.",
  "A bit of `Control`, `Alt` or `Meta` that a client sets while it holds no such key goes on the event as it is, with no press of the stage's own.",
  "A press of a key that is down already (a second `keyDown` with no `keyUp` between) is a keyboard's auto-repeat: it goes at its arrival with `autoRepeat` true, with no new hold.",
  "A `char` goes right after its key's press.",
  // board ab-t30.19 (before: `Input.insertText` (Playwright's `fill`, `keyboard.insertText`, and a character with no US key in `keyboard.type`): typed keys when the typing rule (below) allows them.)
  "The collected keys (the operator's answer on board item ab-8fu; board ab-t30.19).",
  "A key run reaches the stage one key at a time, so the stage learns the length of its text by collecting it.",
  "A call joins the tab's collected part when it is a `keyDown` of one character with a key on the US layout whose `key` is that character (Playwright's printable key), with no `modifiers`, no `autoRepeat` and no editing command, while the client holds no key, that key is not down and no collected key is down; the `keyUp` of the collected key that is down; or an `Input.insertText` of a text that is not empty while a part is open and no collected key is down (Playwright's character with no US key; such a call opens no part).",
  "A call on a frame's own session, a call of an ended plan (dialogs, above) and a call after an error of an event (the answers, above) never join.",
  "The tab collects also after its key run's time reached `STAGE_TYPE_MAX_MS` (the time of a key run, below).",
  "Each such call gets its answer at once, with no event: the second exception to \"no answer before its events\" (the answers, above).",
  "The part ends at the tab's next call that does not join it (a key with no text, `Enter`, `Tab`, a key with `modifiers`, a call that the stage takes, and a call that it does not take), or `RUN_IDLE_MS` after its last call, as a step of the tab's gate.",
  "That call, and every later call of the tab in the tab's gate, waits until the part has gone: its events went and Chrome answered them, or its plan ended (the end of a part's plan, below), each wait with its limit.",
  "The part's ended or failed action is closed before that call, so the call takes the lock as a new action and never waits for a lock of its own tab (review-126 B1).",
  "The tab's close and the end of the client's last session on it wait for the part too (the flush, below); a client's `Page.handleJavaScriptDialog` never waits (dialogs, above).",
  "At its end the part's text goes typed when its typing plan at the person's speed fits in what is left of the key run's `STAGE_TYPE_MAX_MS` (the typing rule's rule 3 and the time of a key run, below): with a person's timing, each hold at least the least hold of the client's own calls (a client's `delay`), and each character with no US key as `Input.insertText` at its time.",
  "Else it goes as a person's paste when the paste rule allows it (the paste, below).",
  "Else it goes as the client's own key events, at once, in order, with the stage's timestamps, at most 8 of them without an answer (Playwright's own input).",
  "After the key run's time reached `STAGE_TYPE_MAX_MS`, each part goes as the client's own key events at once (review-126 B5).",
  "A collected key whose `keyUp` has not come at the end goes after the part as the client's own press, with a person's timing, and stays down until the client's `keyUp`.",
  "The end of a part's plan.",
  "No client call waits for a part, so an error that a typed or a pasted text would give its call goes to the log and the counts, with no text.",
  "At a dialog, at `STAGE_EVENT_WAIT_MS`, at `STAGE_ACTION_MAX_MS` and at a navigation of the main frame, a typed part ends as a typed text does (the typing rule, below), a pasted part as a paste does (the paste, below), and the client's own key events of a part go as the events of an ended plan (dialogs, above).",
  "At a dialog Chrome drops each input event that it gets while the dialog is open, so the client's own key events of a part after the first one that has no answer at the end (the one that opened the dialog) go again after the close.",
  "After the end each wait for Chrome's answers of those events has the limit `STAGE_EVENT_WAIT_MS`: when 8 of them have no answer in that time, or an event gets an error, the rest of the part does not go, the release of each key that the part holds goes, and the log gets the error `The input stage ended a collected part of a key run, and <n> of its key events did not go: <the page did not answer, an error of an event, the page navigated, or the end of the tab or of the session>.` (review-126 B2).",
  "An error of an event stops the part's plan as at any error of an event (the answers, above).",
  // review-126b R1 (before: Every end of a part's plan frees the lock and opens the tab's gate by the steps of dialogs (above), and the part's ended or failed action is closed before the tab's next call (above).)
  "Every end of a part's plan frees the lock and opens the tab's gate by the steps of dialogs (above), and the part's ended or failed action is closed before the tab's next call (above); a part whose plan runs at a flush frees the lock after its rest (the flush, below; review-126b R1).",
  "Each wait of a part has its limit: `CLIPBOARD_HOLD_MS`, `STAGE_EVENT_WAIT_MS` and one more `STAGE_EVENT_WAIT_MS` for Chrome's answers; only the wait for a dialog's close has none of its own, and it ends at the close (the client's `Page.handleJavaScriptDialog` never waits), at the client's `Page.disable`, at a crash, at a navigation of the main frame and at the end of the tab (dialogs, above).",
  "A part that collects keeps its limit: when `STAGE_ACTION_MAX_MS` ends the action that it is in, the part still goes `RUN_IDLE_MS` after its last call (review-126 note 6).",
  "The flush (review-126 B3).",
  "The client has the answers of a part's calls before the part goes, so the part must reach the page before the client's own end, as Playwright's own input does.",
  "Before the model closes the tab for the client (`Target.closeTarget`) and before it detaches the tab at the end of the client's last session on it (`Target.detachFromTarget`, and the close of the client's connection, as Playwright's `browser.close()` over `connectOverCDP` gives it), the rest of the tab's part goes first, in the tab's gate after the tab's calls before it.",
  // review-126b R1, part B1's note (before: At the close of a connection, the tabs whose last sessions end flush at the same time, each within `STAGE_FLUSH_MS` (below), before their detaches (review-126b R1).)
  "At the close of a connection, the tabs whose last sessions end flush at the same time, each within `STAGE_FLUSH_MS` (below), before their detaches, and an end_scope closes its scope's connections at the same time, so the tabs of all of them flush at the same time too (review-126b R1).",
  "The flush takes no lock of its own and makes no activation, so it never waits for another tab's lock: its events (one `Input.insertText`, and a printable key's press or release of the part, with no modifiers and no commands) use no clipboard and no pointer, and `Input.insertText` reads no selection (review-126b R1).",
  // review-126b R1 (before: A collected part that has not gone goes as one `Input.insertText` of its text, under the lock.)
  "A collected part that has not gone goes as one `Input.insertText` of its text.",
  "A part whose step waits for the lock (another tab's action holds it) does not run: the flush ends the wait, the part goes as the flush, one `Input.insertText` of its text, and it never types or pastes later (review-126b R1).",
  // review-126b R1 (before: A part whose plan runs ends as at `STAGE_ACTION_MAX_MS`, so the rest of its text goes as one `Input.insertText`: after a refused paste too, and for the client's own key events of a part after the release of a key whose press went.)
  "A part whose plan runs (it has the lock, and its typed keys, its paste or its own key events go) ends as at `STAGE_ACTION_MAX_MS`, so the rest of its text goes as one `Input.insertText`: after a refused paste too, and for the client's own key events of a part after the release of a key whose press went.",
  "That part keeps the lock until its rest has gone, and its close then frees it, so no other tab's action takes the window's focus first: the rest of a typed or a pasted part keeps its focus check, and it goes only when the part's field still has the focus, as at every end of a typed or a pasted text (the typing rule and the paste, below; review-126b R1).",
  "The flush's text with no lock of the part's own has no focus check: a part that has not gone, a part whose step waits for the lock, and a rest that waits for the lock again after an earlier end of its plan (the flush ends that wait too).",
  "The check reads the window's focus (`document.hasFocus()`), which needs the activation and so the lock; the text goes to the element that has the focus in the page, as Playwright's own `Input.insertText` does.",
  "One call goes within the limit also for a long text, where the client's own key events would take seconds, and Chrome inserts the same text in an `input` or a `textarea`.",
  // review-126b R1 (before: The close or the detach waits for it at most `STAGE_FLUSH_MS = 5000` (two waits of `STAGE_EVENT_WAIT_MS`, and 1 s for the lock and the reads), then goes on, and the stage counts each flush.)
  "The close or the detach waits for it at most `STAGE_FLUSH_MS = 5000` (two waits of `STAGE_EVENT_WAIT_MS`, for the answers of a running part's sent events and for the answer of its rest, and 1 s for the stage's reads of the field), then goes on, and the stage counts each flush.",
  "At every other end of the tab or of the session (the receiver closed the tab, a crash, a line with no list for the tab's scope, a detach after C10's timeout, the end of the link), no event of the part goes after it.",
  "`Input.insertText` (Playwright's `fill`, `keyboard.insertText`, and a character with no US key in `keyboard.type`): typed keys when the typing rule (below) allows them, and a person's paste of a long text when the paste rule allows it (the paste, below).",
  "Else the text goes as it is, after one person's time from one press to the next.",
  "The first typed key replaces the selection that Playwright's script made.",
  "`clear()` (Playwright's script selects all, then the `Delete` key): the key with a person's hold.",
  "The typing rule.",
  "The stage sends typed keys in place of the text of an `Input.insertText` only when all of these are true;",
  "else it sends the call as it is:",
  "The focused element (the stage's own read at the call; when the focus is in a cross-origin frame, the stage reads it on that frame's own session) is an `input` of a text type (`text`, `search`, `email`, `url`, `tel`, `password`, `number`, or no type) or a `textarea`.",
  "A contenteditable keeps the inserted text, because the editor of a page can change typed keys.",
  // Board ab-t30.10 (before: "Each character has a key on the US layout (`src/record.ts` `charKey`), and the text has no line feed and no tab.").
  "The text is not empty, each character has a key on the US layout (`src/record.ts` `charKey`), and the text has no line feed and no tab.",
  "A line feed would send a message in a chat field with Enter-to-send, and a tab moves the focus.",
  // board ab-t30.19 (before: The plan at the person's speed fits in `STAGE_TYPE_MAX_MS = 10000`, or the plan at the fast end of the person's spread (100 to 120 ms a key) fits in it, and then the stage types at that speed. A longer text goes as one `Input.insertText` (the answer Q2 a).)
  "The plan at the person's speed fits in what is left of the key run's `STAGE_TYPE_MAX_MS = 10000` (the time of a key run, below): a text of at most about 40 to 50 characters.",
  "The stage never types the plan at the fast end of the person's spread (100 to 120 ms a key): the operator answered board item ab-2qb on 2026-11-13 with \"Paste it\": \"Only a text that fits in 10 s at a person's usual speed (about 40 to 50 characters) is typed.",
  "Every longer text goes as a person's paste.",
  "The key times look more like a person's (recommended).\" (board ab-t30.20).",
  "A longer text goes as a person's paste when the paste rule allows it (the operator's answer on board item ab-8fu; the paste, below), else as one `Input.insertText` (the answer Q2 a).",
  "This holds for `fill`, `keyboard.insertText` and the collected parts of `pressSequentially`, `locator.type` and `keyboard.type`.",
  // review-119b R1 (before: "On the Mac the same, with the Mac's editing commands for keys such as Backspace (`src/record.ts` `macCommands`).").
  "On the Mac the same, with the Mac's editing commands for keys such as Backspace (`src/human/keys.ts` `macCommands`).",
  // Board ab-t30.10: rule 5 (a held modifier would change the typed keys), the plan's own times (review-111 point 4), the answer.
  // review-119 B2 b (before: "The client holds no modifier key: a held Shift, Control, Alt or Meta would change the typed keys.").
  "The client holds no key: a held Shift, Control, Alt or Meta would change the typed keys, and a held letter would go down twice.",
  "Typed keys follow the times of the plan that rule 3 checked, so the typed text takes at most `STAGE_TYPE_MAX_MS`.",
  "The call is answered after the plan's last event.",
  "After the last key the stage reads the value of the field.",
  // Board ab-t30.10 (before: "When it is not the text, the stage logs the difference and counts it, and it does not repair the field.").
  "When it is not the field's text before the keys with the typed text in place of its selection (after `fill`, whose script selects all of it: the text), the stage logs it, with no text, and counts it, and it does not repair the field.",
  "This is the one named exception to the same result as Playwright's own input: a key handler of a page (a tag input, an autocomplete, an input mask) can act on typed keys, where Playwright's own `fill` inserts the text in one step.",
  // Board ab-t30.10: the end of a typed text's plan (a case with no rule before).
  // review-119 B2 a, B6, N3, N4 and the daemon lead's P1 (before: "When a plan of typed keys ends before its last key (a dialog, `STAGE_EVENT_WAIT_MS`, `STAGE_ACTION_MAX_MS`), the stage sends the release of each key that the plan holds, and the characters whose keys did not go as one `Input.insertText`, as the client's own call, which gets Chrome's answer.").
  // review-119b R3 (before: "When a plan of typed keys ends before its last event (a dialog, `STAGE_EVENT_WAIT_MS`, `STAGE_ACTION_MAX_MS`, or a navigation of the main frame), a character is typed when its `keyDown` reached the page: Chrome drops each input event that it gets while a dialog is open, so a `keyDown` sent after the first event of the plan that has no answer at the end did not reach it.").
  "When a plan of typed keys ends before its last event (a dialog, `STAGE_EVENT_WAIT_MS`, `STAGE_ACTION_MAX_MS`, or a navigation of the main frame), each character whose `keyDown` the stage sent is typed, except at a dialog: Chrome drops each input event that it gets while a dialog is open, so there a `keyDown` sent after the first event of the plan that has no answer at the end did not reach the page.",
  // the daemon lead's point (a bound for the wait for answers) (before: "At `STAGE_EVENT_WAIT_MS` and at `STAGE_ACTION_MAX_MS` the page can be busy (a key handler that runs long): Chrome queues its input events and gives them to it later, so the stage first waits for Chrome's answers of the plan's sent events.").
  "At `STAGE_EVENT_WAIT_MS` and at `STAGE_ACTION_MAX_MS` the page can be busy (a key handler that runs long): Chrome queues its input events and gives them to it later, so the stage first waits for Chrome's answers of the plan's sent events, with the lock free, for at most one more `STAGE_EVENT_WAIT_MS`.",
  "When the answers do not come in that time (a key handler that never returns), no character of the rest goes, because a key with no answer can still reach the page later.",
  "The release of each key that the plan holds goes as at any end of a plan, with no wait for its answer: Chrome gives it to the page when the page answers again (when the client's session ends during the wait, the release goes at that end).",
  "The call gets the error `The input stage ended a typed text at <the end>, and <n> characters may not have gone: the page did not answer.`, where `<n>` counts the characters whose `keyDown` has no answer from Chrome.",
  // review-119b O1 (before: "After the dialog's close, with the lock taken again in the order of arrival, the stage sends the release of each key that the plan holds.").
  "After the dialog's close, with the lock taken again in the order of arrival (and, when characters remain, the activation, because another tab's action can take the window's focus while the lock is free), the stage sends the release of each key that the plan holds.",
  "Then, when the field that the typing rule's read marked (a value of the world of that read, which no page script sees) still has the focus by the focus click's test (it is the active element of its document, and that document has the focus), the stage sends the characters that were not typed as one `Input.insertText`, as the client's own call, which gets Chrome's answer.",
  // review-119b O2 (before: "Else, and at a navigation of the main frame, no character goes, and the call gets the error `The input stage ended a typed text at <the end>, and <n> characters did not go: <the field no longer has the focus, or the page navigated>.`").
  // the daemon lead's point (a bound for the wait for answers) (before: "Else, and at a navigation of the main frame, no character goes, and after Chrome's answers of the plan's events and of its releases the call gets the error `The input stage ended a typed text at <the end>, and <n> characters did not go: <the field no longer has the focus, or the page navigated>.`").
  "Else, and at a navigation of the main frame, no character goes, and the call gets the error `The input stage ended a typed text at <the end>, and <n> characters did not go: <the field no longer has the focus, or the page navigated>.` after Chrome's answers of the plan's events and of its releases, or after `STAGE_EVENT_WAIT_MS` when they do not come.",
  "When every character was typed, the call gets its answer after Chrome's answers of the plan's events.",
  // board ab-t30.19 (before: The time of a key run. The stage does not know the length of a run in advance. It types at the person's speed for the first `STAGE_RUN_SLOW_MS = 12000` of the run, then at the fast end of the person's spread. At `STAGE_ACTION_MAX_MS` the rest of the run goes at Playwright's own speed, with no person's timing, and the stage counts it. So a `pressSequentially` or a `type` of more than about 850 characters still ends with Playwright's 30 s timeout through the stage (measured by board ab-t30.18: 820 to 921 characters went within 30 s, and on a busy box once only 598), and the rest of its text does not go. This is the state until board task ab-t30.19, which builds the operator's answer on board item ab-8fu (2026-11-12): "can we do a simulated copy/paste for long text input? and we use a person typing for short input only?" The stage's build switch stays off until that task is merged.)
  "The paste (the operator's answer on board item ab-8fu; board ab-t30.19).",
  "A long text (the typing rule's rule 3, above) of an `Input.insertText` or of a collected part goes as a person's paste when all of these are true; else it goes as Playwright's own input (the client's `Input.insertText`, or the client's own key events of a collected part), and the stage counts why:",
  "Linux.",
  "On the Mac, Chrome shares the operator's own clipboard, so the stage never pastes there (an open point of the input design's stage 4).",
  "The stage has the clipboard of the service's own display: the X selection owner of the unit's own Xvfb (`src/service/unit/clipboard.ts`).",
  // board ab-t30.22 (before: The daemon's relay (`agent-browser relay`) has none, because its display is the daemon's: there a long text never pastes, and it goes as Playwright's own input.)
  "The daemon's relay (`agent-browser relay`) has none, because it has no display at all: agentwatch starts it with only `PATH`, `HOME`, `LANG` and `XDG_RUNTIME_DIR` in its environment, so no `DISPLAY`, no `XAUTHORITY` and no variable of the stage's tests reaches it.",
  "There a long text never pastes, and it goes as Playwright's own input.",
  "The live rows' door (`relayTestClipboard`, `src/service/unit/clipboard.ts`) gives the relay a clipboard only when both test variables are set: `AGENT_BROWSER_INPUT_STAGE=test`, and `AGENT_BROWSER_STAGE_CLIPBOARD` with a display and the X authority file of that display.",
  "The door refuses only the displays `:0` (a desktop) and `:90` (the operator's agent browser on the Linux server), and agentwatch's private Chrome display can be any of `:90` to `:189`.",
  "This is safe, because agentwatch never passes the test variables to the relay: the door stays shut there, and only a live row of a test opens it, on the run's own Xvfb.",
  "No connection holds a grant of the clipboard (`clipboardReadWrite` or `clipboardSanitizedWrite`: permissions and content settings, below), and no change of its setting is under way: a grant counts from the client's `Browser.grantPermissions` until a `Browser.resetPermissions` or the close of its connection has cleared the setting (review-126 note 2).",
  "Its content setting acts on the whole profile, and a page with it can read the clipboard.",
  "The client holds no key.",
  "The focused element (the typing rule's read) is an `input` of a text type or a `textarea`.",
  "A contenteditable keeps Playwright's own input, because the editor of a page can change a pasted text.",
  // board ab-t30.21 (before: No earlier paste's `V` (of any tab) waits for its answer (review-126 B4).)
  "No earlier paste's `V` (of any tab) is in the closed set: a `V` is in it from its send until its answer (review-126 B4), and then until the page answers the stage's read after that answer (board ab-t30.21, below).",
  "Chrome reads the selection in `V`'s default action, after the page's `keydown` handler, so a page whose handler runs long reads it late: with a handler of 3 s, Chrome asked for the selection 3,004 to 3,016 ms after the send of `V`, and when the owner held another page's text at 2.5 s, the page pasted that text (measured by board ab-t30.19 on Chromium 156).",
  "A `V` with no answer closes the paste path until its answer comes or its tab ends, and each long text then goes as Playwright's own input; the stage counts it.",
  // review-126b note 2 (new sentences)
  "An error answer of `V` is not its answer, because Chrome can still run `V`'s paste in the page: after an error the paste path stays closed until `V`'s tab ends or its main frame navigates (`Page.frameNavigated`), and the stage logs and counts it (review-126b note 2).",
  "The measure (board ab-t30.19 on Chromium 156, a `keydown` handler of 3 s): a CDP session that detached 500 ms after the send of `V` got no error, and `V`'s answer came 3,017 to 3,021 ms after its send, after the page read the selection (3,008 to 3,010 ms); at a navigation of the main frame that started 500 ms after the send of `V`, Chrome answered `V` at once (512 and 515 ms), a page of the same site still read the selection at 3,008 ms, 18 ms before its `Page.frameNavigated`, and a page of another site, whose `Page.frameNavigated` came at 519 ms, never read it.",
  "The detach of the agent browser's debugger at a session's end is not measured.",
  // board ab-t30.21: rule 6's open point becomes the rule (before: So the old document reads no selection after `Page.frameNavigated`, but an answer of `V` that the start of a navigation brings comes before the page reads the selection, and the path is then open while that page's handler runs (an open point).)
  "So the old document reads no selection after `Page.frameNavigated`, but an answer of `V` that the start of a navigation brings comes before the page reads the selection.",
  // review-131 (before at 7bbcff0: So at `V`'s answer the stage sends one read where `V`'s default action runs, and `V` stays in the closed set until the page answers it (board ab-t30.21): `V_READ` in the stage's own isolated world on the top page, or, for a field in a cross-origin frame, `V_READ_IN` on the field's node on that frame's own session.)
  "So at `V`'s answer the stage sends one read where `V`'s default action runs, and `V` stays in the closed set until the page answers it (board ab-t30.21): `V_READ` in the stage's own isolated world on the top page, or, for a field in a cross-origin frame, `V_READ_IN` on the node of the focus read (the typing rule's read at `V`'s time) on that frame's own session.",
  // review-131 (before at 7bbcff0: The read reads nothing of the page, and Chrome answers it only after `V`'s default action.)
  "The read reads nothing of the page, and the document that ran `V`'s default action answers it only after that default action; at a navigation to another site the new document answers it, after `Page.frameNavigated`, which ends the wait (below).",
  "The measure (board ab-t30.21 on Chromium 156, a `keydown` handler of 3 s, the read sent at `V`'s answer): with no navigation, the read's answer came 18 to 23 ms after the page read the selection; at a navigation of the main frame to the same site that started 500 ms after the send of `V`, `V`'s answer came at 510 to 512 ms, the page read the selection at 3,008 to 3,014 ms, `Page.frameNavigated` came at 3,027 to 3,050 ms, and the read's answer at 3,046 to 3,077 ms; a navigation that the page's own handler started gave the same order (`V`'s answer at 513 to 517 ms, the selection at 3,009 to 3,024 ms, the read's answer at 3,046 to 3,112 ms).",
  "At a navigation to another site the read's answer came 25 to 32 ms after `V`'s answer, and the old page never read the selection; at the tab's end (its close about 490 ms after `V`'s answer) the read got an error when Chrome ended the tab, 1,512 to 1,514 ms after the send of `V`, and the page never read the selection.",
  "For a field in a cross-origin frame, the frame's own navigation did not bring `V`'s answer early (it came at 3,019 to 3,022 ms, after the page read the selection), and at a navigation of the main frame `V`'s answer came at once (512 to 514 ms), the read on the frame's session got an error at 516 to 520 ms, `Page.frameNavigated` came at 520 to 525 ms, and the frame never read the selection.",
  // review-131: new sentences
  "With a dialog of the handler (an `alert` that the probe closed 2 s later), `V`'s answer came at 2,021 to 2,026 ms, the page read the selection at 2,013 to 2,016 ms, and the read's answer came at 2,029 to 2,039 ms; at a navigation of the same site 500 ms after the send of `V`, Chrome closed the dialog and answered `V` at once (512 to 514 ms), the page read the selection at 520 to 521 ms, `Page.frameNavigated` came at 539 to 541 ms, and the read's answer at 557 to 566 ms (measured by board ab-t30.21's review round).",
  "An error of the read is not its answer: the paste path then stays closed, as after an error answer of `V`, until `V`'s tab ends or its main frame navigates, and the stage logs and counts it.",
  // review-131 (before at 7bbcff0: `Page.frameNavigated` of the tab's main frame and the tab's end end the wait for the read, because the old document reads no selection after them; an answer or an error of the read after that end changes nothing.)
  "`Page.frameNavigated` of the tab's main frame ends the wait for the read, because the old document reads no selection after it; a frame's own `Page.frameNavigated` (on the frame's own session, or with a parent frame) does not, and the event keeps a `V` with no answer in the closed set.",
  // review-131: new sentences
  "A close of the tab (Chrome's `tabs.onRemoved`, or the receiver's map has the tab no more) ends the wait at once, because its page ended: the measure saw no read of the selection after Chrome ended a closed tab; an answer or an error of the read after an end changes nothing.",
  // review-131b (before at 0fa5dbc: At a tab's end where the page can still run (Chrome's detach of the debugger, a tab that leaves the model as an orphan (C5), or a tab that Chrome replaces), the paste path stays closed for `V_READ_MAX_MS` after the drop while the tab's `V`, its read or its closed path held it, and the stage logs and counts it (review-131 B1).)
  "At a drop that is no close (Chrome's detach of the debugger or a tab that leaves the model as an orphan (C5), where the page can still run, or a tab that Chrome replaces, whose old page is gone, where the bound only fails closed), the paste path stays closed for `V_READ_MAX_MS` after the drop when, at the drop, the tab's `V`, its read or its closed path was in the set, and the stage logs and counts it (review-131 B1).",
  // review-131b: new sentences
  "A close that follows Chrome's detach of the same tab ends the bound; after an orphan the model knows the tab no more, so the bound runs its full time (fail closed).",
  "The bound is the read's own limit, because the stage then sees no event of that page: the measured pages read the selection at most about 2.5 s after the start of a navigation, and Chrome ended a closed tab about 0.5 s after its close; a page whose handler still runs `V_READ_MAX_MS` after such a drop is not held (reasoned, not measured).",
  // review-131 (before at 7bbcff0: The wait has the limit `V_READ_MAX_MS` (10 s): at the limit the paste path stays closed for that tab (fail closed), as after an error answer of `V`, until its tab ends or its main frame navigates, also when the read answers later; the stage logs and counts it.)
  // review-131b (before at 0fa5dbc: The wait has the limit `V_READ_MAX_MS` (10 s): at the limit the paste path of every tab stays closed (fail closed), as after an error answer of `V`, until that tab ends (with the bound above for a tab's end where the page can still run) or its main frame navigates, also when the read answers later; the stage logs and counts it.)
  "The wait has the limit `V_READ_MAX_MS` (10 s): at the limit the paste path of every tab stays closed (fail closed), as after an error answer of `V`, until `V`'s tab ends (with the bound above for a drop that is no close) or its main frame navigates, also when the read answers later; the stage logs and counts it.",
  "Each paste costs one read: it goes at `V`'s answer, the client's call does not wait for it, and in the measure it came 8 to 13 ms after `V`'s answer in the top page's world (two CDP calls) and 3 to 4 ms after it on a frame's session (one call).",
  // review-131: new sentences
  // review-131b (before at 0fa5dbc: The client's own Control+V is a `V` too (review-131 note 1): a `keyDown` or `rawKeyDown` with the Control modifier and the key v, or one whose `commands` hold a paste command, joins the closed set from its send until its answer, and then until the page answers the stage's read (on the top page, or on a frame's own session on a node of it that the client's calls named), as the stage's own `V` does, so no paste of the stage puts its text on the selection while that page can still read it.)
  "The client's own paste is a `V` too (review-131 note 1, review-131b N1): each `keyDown` or `rawKeyDown` that Chrome takes as a paste on Linux joins the closed set from its send until its answer, and then until the page answers the stage's read, as the stage's own `V` does, so no paste of the stage puts its text on the selection while that page can still read it.",
  // review-131b: new sentences
  "The source of those keys is Chrome's own key table (Chromium's editing key table, `editing_behavior.cc`: on Linux Control+V and Control+Shift+V by V's key code, Shift+Insert by Insert's key code, and the DOM key Paste), which matches its modifiers exactly; the stage takes more (fail closed): the Control modifier, with any other, and the key v in any case, the code `KeyV` or the key code 86, whatever the key text; the Shift modifier, with any other, and Insert by its key, its code or the key code 45; the key Paste; and any key event whose `commands` hold a command that starts with paste.",
  "The stage's read after it goes where its default action runs, as for the stage's own `V`: a focus read at the key's time, before the key goes, gives the field's node on a cross-origin frame's own session when the focus is there, also when the client sends the key on the top session, as Playwright does; when that read gives no field, the read goes on a node of the key's own frame session that the client's calls named, else on the top page.",
  "Its cost is one focus read for each client paste key, before the key goes: at most `GEOMETRY_WAIT_MS`, and at most 1 s when the focus is in a cross-origin frame, as at `V`'s time.",
  "The stage tracks it only with a clipboard: with none it never pastes.",
  // review-131b: new sentences
  "So any client, with one paste key into a page whose handler never ends, with an error answer of its own paste key, or with a read that never answers, keeps the paste path of every tab in every scope closed until its tab ends (after the error or the read's limit, also until its main frame navigates); the cost is that each long text then goes as Playwright's own input, and nothing hangs.",
  "Reasoned, not measured: a history step to a page that the back/forward cache restores ends the wait at its `Page.frameNavigated`, as a navigation does, and that the document that leaves reads no selection after it is reasoned from the measured navigations; a navigation that starts before the keydown reaches the page leaves the read behind the page's handler and `V`'s default action in the document that gets the key, as in the measure.",
  // board ab-t30.22: sentences with no text before (the field rule, the client's mark, and what the stage knows of a part's field).
  // review-129 (before: ... none of the tokens `current-password`, `new-password` and `one-time-code`, in any case.)
  "The field is no field of a secret (board ab-t30.22): by the typing rule's read, its type is not `password`, and its `autocomplete` attribute has none of the tokens `current-password`, `new-password`, `one-time-code`, `cc-number` and `cc-csc`, in any case.",
  "The client has not marked its texts on the tab as secrets (the client's mark, below).",
  // review-129 B1, note 1, note 4 and bar 1 (before: When rule 7 or rule 8 does not hold, and the rules before it hold, the text goes as one `Input.insertText`, as a password manager's fill does: a `fill` or a `keyboard.insertText` as the client's own call, and a collected part as one `Input.insertText` of its text in place of its key events; the stage counts it. So with the stage on, a secret never goes through the clipboard: it goes typed when its typing plan fits (the typing rule), else as one `Input.insertText` or as Playwright's own input. The stage reads the field of a collected part at the part's end, before the part's events go: the focused element then is the field of the part's first key, because no key of the part has reached the page, and a Tab, an Enter and every other call end a part (a page script can still move the focus while a part is collected).)
  "When rule 7 or rule 8 does not hold, and the rules before it hold, the text goes as one `Input.insertText`, as a password manager's fill does.",
  "A `fill` or a `keyboard.insertText` goes as the client's own call, whose result is the client's, as before.",
  // review-129b N2 (before: ... when the field did not take the text (its old value), the part goes as the client's own keys.)
  "A collected part goes as one `Input.insertText` of its text in place of its key events; then the stage reads the field, and when the field did not take the text (its old value, and not the value that the text gives in place of the field's selection), the part goes as the client's own keys.",
  "The text can still arrive twice when a page's input handler takes it and puts back the old value, as with the paste's refusal (an open point).",
  "The stage counts each.",
  // review-129b B1, B2 and N3 (before: The stage reads the field again right before `V`: when the field is then a field of a secret, or the client's mark holds, the text goes as above with no paste (`V` does not go, and `Control` goes up); when it is no text field, or the read fails, the text goes as Playwright's own input.)
  "The stage reads the field again at `V`'s time, after the gap that follows `Control` and before the clipboard holds the text: when the field is then a field of a secret, the text goes as above with no paste (`V` does not go, and `Control` goes up); when it is no text field, or the read fails, the text goes as Playwright's own input.",
  "The client's mark cannot change there, because the mark is a step of the tab's gate.",
  "The read can make `V` late: by at most `GEOMETRY_WAIT_MS` (200 ms), and by at most 1 s when the top page's read finds the focus in a cross-origin frame (one read on the top page and up to four in frames).",
  "A moment stays after the read, the clipboard's hold (at most `CLIPBOARD_HOLD_MS`) and the send of `V`: a page that makes the field a field of a secret in that moment still gets the paste (an open point).",
  "So with the stage on, a text for a field of a secret and a text that the client marked never go through the clipboard: each goes typed when its typing plan fits (the typing rule), else as one `Input.insertText` or as Playwright's own input.",
  // review-129b N4 (before: ... a password field that a "show password" toggle made a text field, and a card field ...)
  "Every other field pastes a long text by these rules, also a field that holds a secret with no sign of it: a text field that CSS masks, a password field that a \"show password\" toggle made a text field with no secret token (a field that keeps `autocomplete=current-password` is still a field of a secret), and a card field other than the number and the code (for example `cc-exp`).",
  "The client's mark is the way for such a field.",
  "The stage reads the field of a collected part at the part's end, before the part's events go: the focused element then is the field of the part's first key, because no key of the part has reached the page, and a Tab, an Enter and every other call end a part.",
  "A page script can still move the focus while a part is collected: then the whole part goes into the field that has the focus at the part's end (Playwright's own keys would go into the field that has the focus at each key), and when that field is no field of a secret and no mark holds, the part pastes there.",
  "The paste goes after one person's time from one press to the next: the stage's own `Control` (a `rawKeyDown` with `modifiers` 2), then `V` 40 to 120 ms after it (a `rawKeyDown` with `modifiers` 2 and no text, as a keyboard gives it), the release of `V` after a person's hold, and the release of `Control` 20 to 80 ms after it.",
  "The text is on the CLIPBOARD selection only from the time of `V` to the answer of its `keyDown`: Chrome reads the selection in that key's default action, and the stage then gives the selection up and clears the text at once, also at every end of the paste's plan, before the lock is free.",
  "When the owner does not hold the text within `CLIPBOARD_HOLD_MS = 500`, `V` does not go, `Control` goes up, and the text goes as Playwright's own input.",
  "After the paste's last event the stage reads the field's value.",
  "The text in place of the field's selection is a paste (an `input` has a space for each line break, as Chrome inserts a text there).",
  "The field's old value is a paste that the page refused (a `paste` or `beforeinput` handler that prevents it), and the text then goes as Playwright's own input.",
  "Another value (a paste handler of the page that inserts its own text) is counted and logged with no text, and the stage does not repair the field.",
  "The call gets its answer after these steps.",
  "The page sees what a person's paste gives it: trusted `keydown` events of `Control` and `v`, a `paste` event with the text in `clipboardData`, `beforeinput` and `input` with the `inputType` `insertFromPaste`, and the `keyup` events (measured by board ab-t30.19 on Chromium 156).",
  "The end of a paste's plan (a dialog, `STAGE_EVENT_WAIT_MS`, `STAGE_ACTION_MAX_MS`, a navigation of the main frame): the selection goes, with the text, at once.",
  "At `STAGE_EVENT_WAIT_MS` and at `STAGE_ACTION_MAX_MS` the stage waits for Chrome's answers of the paste's events, with the lock free, for at most one more `STAGE_EVENT_WAIT_MS`; when they do not come, the call gets the error `The input stage ended a pasted text at <the end>, and <n> characters may not have gone: the page did not answer.` After a dialog's close, with the lock taken again and the activation, the stage sends the release of each key of the paste that is down, and it reads the field.",
  "A paste goes on as above.",
  "The field's old value, while the field still has the focus by the focus click's test, gives Playwright's own input of the text as the events of an ended plan.",
  "Else, and at a navigation of the main frame, no text goes, and the call gets the error `The input stage ended a pasted text at <the end>, and <n> characters did not go: <the field no longer has the focus, or the page navigated>.`",
  "Why no page of another scope reads the text, though the one browser's clipboard serves the tabs of every scope.",
  "A page reads the clipboard only with the Clipboard API and a grant of the clipboard: with no grant its `navigator.clipboard.readText()` waits on a prompt that nobody answers, and `document.execCommand(\"paste\")` is refused to a web page (measured by board ab-t30.19).",
  "The stage pastes nothing while a connection holds a grant (rule 3).",
  "The focus is no guard by itself: in the probe, with a grant, a page in a window that was not in front read the clipboard under Playwright's focus emulation (measured).",
  "In agent mode with one window per page the model answers Playwright's `Emulation.setFocusEmulationEnabled` itself (focus emulation, above), so only the page in front has the focus; the rules above do not rest on it.",
  "The text is on the selection for one paste only (measured: Chrome asked for it 2 to 17 ms after the send of `V`, and `V`'s answer came 9 to 24 ms after it; 387 ms for a text of 300,000 bytes, which goes as an incremental transfer).",
  "The selection is the one of the service's own display, whose X server admits only a client with the cookie of the service's own X authority file; the operator's display and its clipboard belong to another X server.",
  // review-126b R2 (before: The input lock gives one paste at a time, no paste puts its text on the selection while an earlier paste's `V` has no answer (rule 6), and a frame's own session gets no input while a text is on the selection (the calls that the stage takes, above).)
  "The input lock gives one paste at a time, no paste puts its text on the selection while an earlier paste's `V` has no answer (rule 6), and no input event goes to any session with no lock while a text is on the selection (review-126b R2): a frame's own session gets its input under the lock, also a call of an ended plan (the calls that the stage takes, above), and the events of an ended plan take the lock again after its limit (the input lock, above).",
  "The one exception is the flush (above): its events (one `Input.insertText`, and printable keys with no modifiers and no commands) cannot paste.",
  "A held call at the tab's end goes with no lock, as the client sent it, to a target that ended or that Chrome detached (dialogs, above).",
  "The sign-in act (below) never uses the clipboard: its own fill sends a long value as one `Input.insertText`.",
  "Its calls go to the bridge through the model's act port, which has no clipboard, and the stage never sees them (review-126 note 8).",
  // board ab-t30.22: sentences with no text before (the client's mark of a secret).
  "The client's mark of a secret (board ab-t30.22).",
  "A client marks its texts on a tab as secrets with `AgentBrowser.setSecretInput` with `{\"enabled\":true}` on the tab's own page session, and it ends the mark with `{\"enabled\":false}`.",
  "The model answers it itself with `{}`, and it never reaches Chrome.",
  "With the stage on, the call is a step of the tab's gate (the calls that the stage takes, above): it ends the tab's key run first, so a collected part before it goes with the mark as it was, and its answer comes after the events of the tab's earlier calls.",
  "The mark holds for every text of the tab (each `Input.insertText` and each collected part) until `{\"enabled\":false}`, or until the stage forgets the tab: at the end of the client's last session on the tab, and at the tab's end.",
  "With the switch off, the model answers `{}` and keeps nothing, because no text pastes.",
  // review-129 note 3 (before: ...; on the root, on a browser session and on a frame's own session the call is refused, as every other `AgentBrowser.*` call is.)
  "A call whose `enabled` is not `true` or `false` gets the error `enabled must be true or false`; on the root, on a browser session and on a frame's own session the call is refused with `Not available in the agent browser: AgentBrowser.setSecretInput.`, also in a model with the sign-in act.",
  "A client that does not send it sees no change.",
  // review-129 bar 4 (before: agent-browser's own `type --stdin` (the way of agentwatch's skill for a secret) sends `{"enabled":true}` before its first input call and `{"enabled":false}` after its last one; it ignores an error answer (a Chrome or an endpoint that does not know the method), and its text then goes as before.)
  "agent-browser's own `type --stdin` (the way of agentwatch's skill for a secret) sends `{\"enabled\":true}` before its first input call and `{\"enabled\":false}` after its last one, also after an error of the type.",
  // review-129b N1 (before: A client's secret path fails closed on an error answer of `{"enabled":true}`. An answer that says the method is not known or not available (Chrome's `'AgentBrowser.setSecretInput' wasn't found`, code -32601, or `Not available in the agent browser: AgentBrowser.setSecretInput.` of an endpoint that predates the mark) comes from a browser or an endpoint where nothing pastes, and the text goes as before. Every other error answer stops the text: `type --stdin` sends no input call and fails with the error `type: the agent browser did not take the mark of a secret, so no text was sent (<the error>)`.)
  "A client's secret path fails closed.",
  "A client sends the mark on the session of its input calls (the tab's own page session); there a current endpoint never answers `Not available`.",
  "An answer of a method that is not known, or that is not available, from an endpoint or a Chrome with no stage (Chrome's `'AgentBrowser.setSecretInput' wasn't found`, code -32601, or `Not available in the agent browser: AgentBrowser.setSecretInput.`) lets the text go; any other error answer, no answer in the client's own time limit, and a closed connection stop the text: `type --stdin` (its time limit: 60 s) sends no input call and fails with the error `type: the agent browser did not take the mark of a secret, so no text was sent (<the error>)`.",
  "An error answer of `{\"enabled\":false}` changes nothing.",
  "agentwatch's `--stdin` path follows the same rule.",
  "The time of a key run.",
  "The key run's time with a person's timing (the time of its steps in the tab's gate: its typed keys and texts, its pastes and its other keys; the step of a collected call takes no time) is at most `STAGE_TYPE_MAX_MS`.",
  "A part or a text whose typing plan does not fit in what is left goes as a paste (above).",
  "When the run's time reaches `STAGE_TYPE_MAX_MS`, the rest of the run goes with no person's timing, and the stage counts it: the printable keys still join collected parts, each with its answer at once, and each part goes as the client's own key events at once, at most 8 of them without an answer; each other key and text goes as the client sent it, with the stage's timestamp, in its order, with Chrome's answer (review-126 B5).",
  "So the stage adds at most about `STAGE_TYPE_MAX_MS` and one part to Playwright's own time of a key run.",
  "A `pressSequentially` or a `type` of one long line (its typing plan does not fit, and it has no line break) goes as one paste: measured by board ab-t30.19, one of 2,500 characters took 1.8 to 2.1 s through the stage (Playwright's own: about 6 s), because each key call gets its answer at once, and its paste went before the client's next call; one of 30 lines took 13.1 to 13.6 s (17 to 20 s before the review-126 round), and one of 60 lines (2,459 characters) took 15.7 to 16.9 s (Playwright's own: 5.3 to 5.6 s) with each of the three Playwright versions (the review-126 round).",
  "The focus click.",
  "Before Playwright's script focus of a text field (the focus and fill recognizers, below), the stage clicks the field as a person does, by the rules of `src/input.ts` `focusField`.",
  // Board ab-t30.10 (before: "The stage reads the field in Playwright's utility world on the node's own handle: whether it has the focus, its kind, and the length of its text.").
  "The stage reads the field in Playwright's utility world on the node's own handle: whether it has the focus, its kind, the length of its text, and its caret.",
  "A field with the focus gets no click.",
  // Board ab-t30.10: which focus counts, and the field of fill.
  "Before Playwright's focus call the stage takes the lock and runs the activation (the window comes forward for input, above); the field then has the focus when it is the active element of its document and that document has the focus (Playwright's own test).",
  // review-119 N5 and N6 (before: "Before `fill`, the field has the focus when it is the active element of its document, because the script of `fill` selects its text; the field is Playwright's retarget of the node (the control of a label).").
  "Before `fill` the stage reads the field before the activation: when it has the focus by the same test, the stage gives no click and runs no activation; else the stage takes the lock, runs the activation and reads the field again.",
  "The field of `fill` is Playwright's retarget of the node (the control of a label).",
  "A field that is disabled or read-only gets no click (Playwright's `fill` refuses it, and a script focus of a disabled field does nothing), and the stage counts it.",
  "Only a text field gets the click: an `input` of a text type, a `textarea` or a contenteditable.",
  "On another element the utility call passes (the answer Q3 a).",
  // Board ab-t30.18 (the operator's answer on ab-pf8, case 1): sentences with no text before.
  // review-123 (B1, the daemon lead's sentence 4, notes 1, 2 and 6) (before: A field that opens a panel at a click gets no click (the operator's answer on board item ab-pf8, 2026-11-12). After the focus test (before `fill`, after the activation and the read again), the stage reads the field's signs: in its read of the field, the role `combobox` (a token of the field's `role`, or of the `role` of an element around it in the flat tree), `aria-haspopup` with the value `true`, `menu`, `listbox`, `tree`, `grid` or `dialog`, `aria-expanded` with the value `true` or `false`, `aria-autocomplete` with the value `list` or `both`, and an `input` whose `list` names a `datalist`; then a `click` listener of the page's own scripts on the field itself, which it reads on the field's handle in the page's main world, as the wheel point's rule 2 reads them. A listener of another event is no sign: a page can count the presses of a field with a `mousedown` listener, and such a field opens nothing. Playwright's script focus then goes as the client sent it, as with Playwright's own input: the page sees a focus with no click on these fields only, and no panel opens. Such a field gets no notches either, because the script focus scrolls it into view. The stage counts it, with its sign. When the read of the listeners fails or reaches its limit, the field gets no click, and the stage counts it.).
  "A field with a sign that it opens a panel at a click gets no click (the operator's answer on board item ab-pf8, 2026-11-12).",
  // review-123b (N4: the forms of EMPTY_HANDLER) (at 780229e: After the focus test (before `fill`, after the activation and the read again), the stage reads the field's signs: in its read of the field, the role `combobox` (a token of the field's `role`, or of the `role` of an element around it in the flat tree), `aria-haspopup` with the value `true`, `menu`, `listbox`, `tree`, `grid` or `dialog`, `aria-expanded` with the value `true` or `false`, `aria-autocomplete` with the value `list` or `both`, and an `input` whose `list` names a `datalist`; then, on an `input` only, a `click` listener of the page's own scripts on the field itself whose handler is not an empty function, which it reads on the field's handle in the page's main world, as the wheel point's rule 2 reads them, with the stage's object group, so that Chrome gives the text of each handler.).
  "After the focus test (before `fill`, after the activation and the read again), the stage reads the field's signs: in its read of the field, the role `combobox` (a token of the field's `role`, or of the `role` of an element around it in the flat tree), `aria-haspopup` with the value `true`, `menu`, `listbox`, `tree`, `grid` or `dialog`, `aria-expanded` with the value `true` or `false`, `aria-autocomplete` with the value `list` or `both`, and an `input` whose `list` names a `datalist`; then, on an `input` only, a `click` listener of the page's own scripts on the field itself whose handler is not an empty function in one of the forms of `EMPTY_HANDLER` (`src/relay/stage.ts`: `function name(…) {}`, `(…) => {}` and `e => {}`, each also `async`, with only white space in the body), which it reads on the field's handle in the page's main world, as the wheel point's rule 2 reads them, with the stage's object group, so that Chrome gives the text of each handler.",
  "A listener of another event is no sign: a page can count the presses of a field with a `mousedown` listener, and such a field can open nothing.",
  "A `textarea` and a contenteditable have no listener sign, because an editor puts a `click` listener on its own root; the cover count (below) measures a panel that a click on such a field opens.",
  "An empty handler is no sign either, because a framework can put one on an element whose click its root handles; a listener whose handler Chrome does not give is a sign.",
  "Playwright's script focus then goes as the client sent it, as with Playwright's own input, and no click opens a panel (a field that opens at focus still opens, as with Playwright's own input).",
  "The page sees a focus with no click on such a field, also when its click listener opens nothing.",
  "Such a field gets no notches either, because the script focus scrolls it into view.",
  "The stage counts it, with its sign.",
  "When the read of the listeners fails or does not end within `GEOMETRY_WAIT_MS` in all, the field gets no click, and the stage counts it.",
  // review-123 (the daemon lead's sentence 5, note 3) (before: After each focus click the stage counts the new elements that cover the area near the field: the field's box widened by 40 px on each side and by 240 px above and below it, within the viewport of its own document. Before the path to the click, it reads every element at each point of a grid of 9 by 25 points over that area (`elementsFromPoint`), and two frames after the release it reads the top element at each point. An element there that was at no point before, and that is not the field, an element inside it or an element around it, is new. It counts once, with its highest ancestor that was at no point before (a panel with its cells). The count measures the panels that the signs above miss. The stage sends no input of its own for them (no `Escape`, no other click).).
  "After each focus click the stage counts the new elements that cover the area near the field: the field's box widened by 40 px on each side and by 240 px above and below it, within the viewport of its own document.",
  "Before the path to the click, it reads every element at each point of a grid of 9 columns by 25 rows over that area (`elementsFromPoint`), and two frames after the release it reads the top element at each point.",
  "An element there that was at no point before, and that is not the field, an element inside it or an element around it, is new.",
  "It counts once, with its highest ancestor that was at no point before (a panel with its cells).",
  "The count measures the panels that the signs above miss, as an upper bound: a hint that the focus shows, a hover panel that the path opened, other changes of the page during the path, and a field node that a framework replaces at the focus count too.",
  "The stage sends no input of its own for them (no `Escape`, no other click).",
  "The click goes where the script focus puts the caret.",
  "In an `input` or a `textarea` with text, and in a contenteditable, the point is 2 to 5 px from the left edge (Playwright's caret reset puts the caret at 0).",
  "In an empty `input` or `textarea`, it is a point from 25% to 75% across.",
  "The point is 35% to 65% down in an `input`, and 6 to 12 px from the top in a `textarea` or a contenteditable.",
  // Board ab-t30.10 (before: "When the caret is not where the script focus would put it after the click, the stage sends `Home` (an `input`) or `Control+Home` (a `textarea`).").
  "The script focus puts the caret at the start of an `input` with the caret reset (`pressSequentially`, `press` and `type`), and else where the field's own selection is (a `textarea`, and `focus()`).",
  "When the caret is not there after the click, the stage sends keys of its own that move it: to the start `Home` (an `input`) or `Control+Home` (a `textarea`), to the end `End` or `Control+End`, and to another place in a text of at most 64 characters the start, then `ArrowRight` and `Shift+ArrowRight`.",
  "Else the stage sets it with the field's own `setSelectionRange` in Playwright's utility world, and counts it.",
  // review-119 B5 (before: "... `Meta+ArrowDown` to the end, with the Mac's editing commands.").
  // review-119b R1 (before: "On the Mac the keys are `Meta+ArrowLeft` (an `input`) or `Meta+ArrowUp` (a `textarea`) to the start and `Meta+ArrowRight` or `Meta+ArrowDown` to the end, with the Mac's editing commands of each key with its modifiers (`src/record.ts` `macCommands`: `Meta+ArrowRight` is `moveToRightEndOfLine`).").
  "On the Mac the keys are `Meta+ArrowLeft` (an `input`) or `Meta+ArrowUp` (a `textarea`) to the start and `Meta+ArrowRight` or `Meta+ArrowDown` to the end, with the Mac's editing commands of each key with its modifiers (`src/human/keys.ts` `macCommands`: `Meta+ArrowRight` is `moveToRightEndOfLine`).",
  "`fill` gets no caret keys, because its script selects the text.",
  // review-119 B4.
  "Before Playwright's focus call, an `input` of the type `email` or `number` with text gets no click: its caret cannot be read or set, and the script focus leaves it where the field's own selection is.",
  "The utility call alone gives it the focus, and the stage counts it.",
  // Board ab-t30.11, review-119 N14 (before: "A field out of view first gets notches into view (the scroll, below), then the click.").
  "A field out of view first gets notches into view (the scroll, below), also inside a frame's own scroller; then the stage reads the field again and clicks it.",
  // review-122: a sentence that board ab-t30.12 could build in two ways: a case with no rule before.
  "These notches are for the focus click of `fill` and of Playwright's focus call (`pressSequentially`, `type` and `press`); board ab-t30.12 decides the other clicks of this part (`selectText()`, the file chooser, a `select`, a date input).",
  // Board ab-t30.32, step B3 (before: "When the notches cannot bring it into view, and on the Mac until the Mac's wheel model exists, the field gets no click, and the stage counts it.").
  "When the notches cannot bring it into view, the field gets no click, and the stage counts it.",
  "A point of the click outside the visible part of the field's nearest scroller gets no click, and the stage counts it.",
  // review-119 B3 (before: "A field that has no box, or that another element covers at the point of the click (the stage's own hit test), gets no click.").
  "A field that has no box, or that another element covers at the point of the click, gets no click.",
  // review-119b R4 (before: "The stage's own hit test reads the element at the point in the field's own document, and at each frame level above it the element at the mapped point: in a same-origin level in Playwright's utility world, and in a cross-origin level with `DOM.getNodeForLocation` on the parent's session, against the frame owner's `backendNodeId`.").
  "The stage's own hit test reads the element at the point in the field's own document, and at each frame level above it the element at the mapped point: in a same-origin level in Playwright's utility world, and in a cross-origin level with `DOM.getNodeForLocation` on the parent's session, against the frame owner's `backendNodeId`.",
  "`DOM.getNodeForLocation` reads a point of the parent's document, so the stage adds the scroll of that document to the mapped point (its layout viewport's offset, from `Page.getLayoutMetrics` on the parent's session), and it gives no click when it cannot read that scroll.",
  "Each must be the field or the frame's owner.",
  "The utility call alone gives it the focus, and the stage counts it.",
  "A field in a cross-origin frame: the stage maps the point of the click to the top page (the frame mapping, below), and it sends the click on the top page's session.",
  "`selectText()` on an `input` or a `textarea`: a click on it and the select-all chord (`Control+A`, on the Mac `Meta+A`), then the utility call.",
  "The scroll and the wheel.",
  "`mouseWheel` on Linux: notches of `STAGE_NOTCH_PX` in the direction of the call, on each axis, at the page's last point, with a person's gaps.",
  "The stage keeps a residual for each axis of a page: what the page's wheel calls asked for, less what its notches gave.",
  // review-122 note 12: a case with no rule before.
  "A navigation of the main frame starts the residual again.",
  "A call gets `n = max(0, round((|delta| + r) / 120))` notches (round half up), where `r` is the residual in the direction of the call.",
  "When `n` is 0 and `r` is 0 or more, the call gets one notch, so a call whose delta is not 0 gets a wheel event unless earlier notches have already given it.",
  "So a series of wheel calls scrolls the asked total within one notch.",
  "Playwright's `mouse.wheel` does not wait for the scroll and does not check it.",
  // Board ab-t30.11: cases with no rule before (the call that earlier notches have given, the order of the axes, the gap
  // across calls, a page with no last point, the notches with no wait for each answer, the end of a plan in the notches).
  "A call that earlier notches have given gets no event: the stage answers it at once, with no lock and no activation.",
  // review-122 note 8: a case with no rule before.
  "A call whose delta is 0 on both axes gets one wheel event with that delta at the client's point, as Playwright's own input sends it.",
  "The notches of the vertical axis go first.",
  // review-122b R8 (before: "The first notch of a call comes at the later of its arrival and one gap after the page's last notch or the end of the stage's path before it, so the calls of a client that sends them at once get a person's gaps too.").
  "The first notch of a call comes after the call's column read (below), at the later of that read's end and one gap after the page's last notch or the end of the stage's path before it, so the calls of a client that sends them at once get a person's gaps too.",
  "When the page has no last point, the stage first sends a path to the client's point, as before a press, and the notches go there.",
  "The stage sends each notch at its time with no wait for the answer of the one before, as a wheel sends its events.",
  // review-122, the lead's option b: a case with no rule before.
  // review-122b R2 (before: "Before the notches, the stage reads the call's column from the page's last point, in the relay's own isolated world: the content that the notches move under the point, on the scroller that the point's chain scrolls first in the direction of the call, as rules 1, 2 and 4 of the wheel point (below) read it, also inside open shadow roots.").
  "Before the notches, the stage reads the call's column from the page's last point, in the relay's own isolated world: the content that the notches move under the point, on the scroller that the point's chain scrolls first in the direction of the call, as rules 1, 2 and 4 of the wheel point (below) read it, also inside open shadow roots and in the elements assigned to their slots.",
  "The element under the point at the start, the elements around it, the elements inside it when it is an element of rule 1, and the elements with `position: fixed` do not count.",
  "When the column meets such an element, the notches go until the next one would bring it under the point, and the rest goes as one wheel event at the same point, one gap later, in the same action, and the stage counts it.",
  "The residual does not change, and the stage answers the call after Chrome answers that event.",
  "Over a cross-origin frame, and when a read fails, all the notches go, and the stage counts it.",
  // review-122, the daemon lead's P1 and note 1 (before: "When the plan of a call ends before its last notch (dialogs, above), the notches that did not go go as one wheel event with their sum, at the page's last point, as the client's own event of an ended plan.").
  "When the plan of a call ends before its last event (dialogs, above), a notch is gone when Chrome answered it, and at a dialog also the first notch with no answer at the end (it opened the dialog), but no later one (Chrome drops the input that it gets while a dialog is open).",
  // review-122, the daemon lead's P1 and note 1: a case with no rule before.
  "At `STAGE_EVENT_WAIT_MS` and at `STAGE_ACTION_MAX_MS` the stage first waits for the answers, for at most one more `STAGE_EVENT_WAIT_MS`; when they do not come, the call gets an error with the count of the notches that may not have gone.",
  // review-122b R3 (before: "The notches that did not go go as one wheel event with their sum, at the page's last point, as the client's own event of an ended plan, only when the page's last point is still a wheel point of the call's scroller: after a dialog's close, with the lock taken again, the stage reads the column again, the element under the point and the scroller must be the same, and the column must hold no element of rules 1, 2 and 4.").
  "The notches that did not go go as one wheel event with their sum, at the page's last point, as the client's own event of an ended plan, only when the page's last point is still a wheel point of the call's scroller: after a dialog's close, with the lock taken again, the stage reads the column again; the scroller of each axis must be the same, the element under the point must be the same or have a chain up to that scroller that passes rule 1, and the column must hold no element of rules 1, 2 and 4.",
  "Else no rest goes, and the call gets an error that names the end and the count of the notches that did not go.",
  // review-122b R5 (before: "A navigation of the main frame stops the notches of a call, as it stops a typed text: no rest goes, and the call gets that error.").
  "A navigation of the main frame from the start of the column read stops the notches of a call, as it stops a typed text: no rest goes, and the call gets that error.",
  "`DOM.scrollIntoViewIfNeeded` (Playwright's scroll before each pointer action, and `scrollIntoViewIfNeeded()`), on Linux:",
  // Board ab-t30.11 (before: "The stage reads the element's box (`DOM.getContentQuads` with the node of the call) and the viewport (`Page.getLayoutMetrics`).").
  // review-122 B2, notes 4 and 5 (before: "The stage reads the element's box (the call's `rect` in it, when the call has one) and its scrollers, innermost first, up through its same-origin frames, in Playwright's utility world on the node of the call: the box, the scroll position and the scroll range of each.").
  "The stage reads the element's box (the call's `rect` in it, when the call has one) with its scroll-margin, and its levels, innermost first, up through its same-origin frames in the flat tree (a slotted element's slot comes before its parent), in Playwright's utility world on the node of the call: the box, the scroll position, the scroll range and the scroll-padding of each.",
  // review-122 B2 (before: "A scroller is an element whose overflow on an axis is `auto`, `scroll` or `overlay` and whose content is larger than its box there, and the document, which has no range on an axis where its overflow is `hidden` or `clip`.").
  "A level is a scroller, or a box that clips the element and that no notch moves.",
  // review-122 B2: a case with no rule before.
  "A scroller is an element whose overflow on an axis is `auto`, `scroll` or `overlay` and whose content is larger than its box there, and the document.",
  // review-122b R8 (before: "A box that no notch moves is an element whose overflow on an axis is `hidden` or `clip` and whose content is larger than its box there (a carousel), and the document on an axis where its overflow is `hidden` or `clip`; a script scroll moves it.").
  "A box that no notch moves is an element whose overflow on an axis is `hidden` or `clip` and whose content is larger than its box there (a carousel), and the document on an axis where its overflow is `hidden` or `clip`; the client's call gives it the state that Playwright's own input gives it (a script scroll moves a box with `hidden`, and no scroll moves a box with `clip`).",
  "The scrollers above an element with `position: fixed` do not move it.",
  // review-122 B2 (before: "The stage reads the viewport (`Page.getLayoutMetrics`), and it finds the visible part of each scroller: its box within the viewport and within each scroller around it.").
  "The stage reads the viewport (`Page.getLayoutMetrics`), and it finds the visible part of each level: its box within the viewport and within each level around it.",
  "When the element is in view, the stage answers `{}` with no scroll.",
  // Board ab-t30.11 (before: "An element is in view when all of it is inside the viewport on an axis, or when its middle is in the middle 60% (vertical) or 80% (horizontal) of the viewport.").
  // review-122 B2 and note 4 (before: "An element is in view when on each axis all of it is inside the visible part of its nearest scroller (the viewport for an element with no inner scroller), or its middle is in the middle 60% (vertical) or 80% (horizontal) of that part.").
  "An element is in view when on each axis all of it (with its scroll-margin) is inside the visible part of its nearest level (the viewport for an element with no inner level) less that level's scroll-padding, or its middle is in the middle 60% (vertical) or 80% (horizontal) of that part.",
  // Board ab-t30.11 (before: "Else the stage finds the element's scroller and a wheel point over it (below)." and "It moves the pointer there with a path when it is not there, and it sends the notches that bring the element's middle to the middle of the viewport.").
  // review-122 B2 and note 4 (before: "Else the stage plans, for each scroller from the innermost out, the move that brings the element's middle to the middle of that scroller's box, within its scroll range, with no move on an axis where the element is in view of that box already; for each scroller, the element is clipped to the scroller inside it, after that one's move.").
  "Else the stage plans, for each level from the innermost out, the move that brings the element's middle to the middle of that level's box less its scroll-padding, within its scroll range, with no move on an axis where the element is in view of that box already; for each level, the element is clipped to the level inside it, after that one's move.",
  // review-122 B2 and note 4: a case with no rule before.
  "When a box that no notch moves must move, the stage sends the client's call as it is, at once, and counts it.",
  "The round is the outermost scroller that must move, so that the scrollers inside it come into view first.",
  "The stage finds a wheel point over the visible part of that scroller (below).",
  // review-122 note 7 and a sentence that board ab-t30.12 could build in two ways (before: "It moves the pointer there with a path when it is not there, and it sends the notches of that move: `round(|move| / 120)` on each axis, and at least one.").
  "It moves the pointer there with a path when it is not there, and it sends the notches of that move: on each axis whose move is 1 px or more, `round(|move| / 120)` notches, and at least one.",
  "It waits for the smooth scroll to end (350 ms, a first value), reads again, and repeats, at most `STAGE_SCROLL_ROUNDS = 4` rounds.",
  "When the element is in view, it answers `{}`.",
  // Board ab-t30.11 (before: "When the element is still not in view, or when a round did not move the scroller, the stage sends the client's call as it is (a script scroll), and logs it.").
  // review-122 note 11 (before: "When the element is still not in view, when a round did not move its scroller, or when no scroller can move it, the stage sends the client's call as it is (a script scroll), and logs it.").
  "When the element is still not in view, when a round did not move its scroller, when the in-flight bound stopped the path to the wheel point, or when no scroller can move it, the stage sends the client's call as it is (a script scroll), and logs and counts it.",
  // Board ab-t30.11: a case with no rule before (the end of a plan in a scroll's rounds).
  // review-122 note 6 (before: "When the plan ends during the rounds (dialogs, above), the stage sends the client's call as it is, at once.").
  "When the plan ends during the rounds (dialogs, above), or the main frame navigates, the stage sends the client's call as it is, at once.",
  // review-122 note 6: a case with no rule before.
  // Board ab-t30.12.3 (before: ... a path with no button would end the drag (board ab-t30.12 decides the drag).)
  "While the stage holds a button (the scroll of `dragTo`'s drop target), it sends the client's call as it is, and counts it: a path with no button would end the drag (the drag, above).",
  "The wheel point.",
  "A point over the visible part of the scroller is a wheel point only when all of these are true (the stage's own read):",
  "The element under the point, and each ancestor of it up to the scroller, is not an `input`, `select`, `textarea`, contenteditable, `canvas`, `embed`, `object`, `video`, `audio` or `iframe`.",
  // Board ab-t30.11 (before: "No element on that chain has a wheel listener (`wheel`, `mousewheel`) that is not passive (`DOMDebugger.getEventListeners`).").
  "No element of the scroller (it, or an element inside it) that has a wheel listener (`wheel`, `mousewheel`) that is not passive has a box that holds the point or meets its column (rule 4).",
  // review-122 B1 and note 13 (before: "The stage reads the listeners of the page's own scripts on the scroller with its whole subtree (`DOMDebugger.getEventListeners` with no `pierce`, on the scroller resolved in the page's main world with `DOM.describeNode` and `DOM.resolveNode`), and the boxes of their elements (`DOM.getContentQuads`).").
  // review-122b R2 (before: "The stage reads the listeners of the page's own scripts on the scroller with its whole subtree and on each open shadow root inside it (`DOMDebugger.getEventListeners` with no `pierce`, on each root resolved in the page's main world with `DOM.describeNode` and `DOM.resolveNode`), and the boxes of their elements (`DOM.getContentQuads`), in at most 1,000 ms in all.").
  "The stage reads the listeners of the page's own scripts on the scroller with its whole subtree, on each open shadow root inside it, and on each element assigned to a slot inside it that the scroller's own tree does not hold (`DOMDebugger.getEventListeners` with no `pierce`, on each root resolved in the page's main world with `DOM.describeNode` and `DOM.resolveNode`), and the boxes of their elements (`DOM.getContentQuads`), in at most 1,000 ms in all.",
  // review-122 B1 and note 13: a case with no rule before.
  "A closed shadow root, and the roots after the first 32, stay out of the read.",
  "The listeners of the window and of the document do not count.",
  // Board ab-t30.11 (before: "The element under the point scrolls the target scroller.").
  "The element under the point scrolls the target scroller: no other scroller comes before it on that chain.",
  // Board ab-t30.11: a case with no rule before (the content that the notches move under the point).
  "The point's column holds no element of rule 1 and no other scroller with a range on the axis of the move.",
  // review-122 B1 (before: "The column is the line from the point along the round's move (the vertical axis first), as the page's content is now: the content that the notches move under the point.").
  // review-122b R2 (before: "The column is the line from the point along the round's move (the vertical axis first), as the page's content is now, also inside open shadow roots: the content that the notches move under the point.").
  "The column is the line from the point along the round's move (the vertical axis first), as the page's content is now, also inside open shadow roots and in the elements assigned to their slots: the content that the notches move under the point.",
  // review-122 B1 and note 3 (before: "The element, the elements around it and inside it, and the elements with `position: fixed`, which do not move, do not count.").
  "The elements around the element and inside it (in the flat tree), and the elements with `position: fixed`, which do not move, do not count.",
  // review-122 B1 and note 3: a case with no rule before.
  // review-122b R4 (before: "The element itself counts when it is a `canvas`, an `embed`, an `object`, a `video`, an `audio` or a frame, or when it has the focus and is an element of rule 1 (a focused number input changes its value under the wheel).").
  "The element itself counts when it is a `canvas`, an `embed`, an `object`, a `video`, an `audio` or a frame, or when it has the focus and is an element of rule 1 (a focused number input changes its value under the wheel); a frame around the element at a level above it, and a cross-origin frame's owner, are around it and do not count.",
  "Chromium gives each wheel event of CDP to the element under the point at its time (measured by board ab-t30.11 on Chromium 156: an inner scroller that came under the point got the later notches of one `mouse.wheel`).",
  // Board ab-t30.11 (before: "The stage tries the page's last point first, then the points of a 5 x 5 grid over the visible part of the scroller.").
  "The stage tries the page's last point first, then the points of a 5 x 5 grid over the visible part of the scroller, at 14%, 32%, 50%, 68% and 86% of it across and down, the nearest to the page's last point first.",
  "When no point passes, the stage sends the client's call as it is.",
  // Board ab-t30.11: a case with no rule before (a point over a frame).
  "A point over a frame is a wheel point of a scroller in that frame only when, at each frame level above the scroller, the element at the point is the frame's element.",
  "An element in a cross-origin frame: the frame's session sends the call.",
  // Board ab-t30.11 (before: "The stage reads the box there, and it sends the notches on the top page's session at a point over the frame.").
  "The stage reads the box and the frame's scrollers there and maps them to the top page (the frame mapping, below).",
  // review-122 B4 (before: "It reads the top page's scrollers on the frame's owner, in its own world (`DOM.resolveNode` with the owner's `backendNodeId`), and it sends the notches on the top page's session at a point over the frame where the top page's element is the frame's owner.").
  "It reads the top page's scrollers on the frame's owner in the relay's own isolated world (`DOM.resolveNode` with the owner's `backendNodeId`), and it sends the notches on the top page's session at a point over the frame where the top page's element is the frame's owner.",
  // review-122 B4 and note 10 (before: "For an element of a cross-origin frame inside another cross-origin frame, the stage sends the client's call as it is.").
  "For an element of a cross-origin frame inside another cross-origin frame, the stage sends the client's call as it is, and counts it.",
  "A retry's script scroll (the retry scroll recognizer, below) passes in the first build, and the stage counts it.",
  "The Mac (with the stage on).",
  // Board ab-t30.32, step B3 (before: "Until the Mac's wheel model exists (part B, board ab-t30.7, and the input design's build task 9), the stage sends `mouseWheel` and `DOM.scrollIntoViewIfNeeded` on the Mac as the client sent them, with the stage's timestamp.").
  "The stage sends `mouseWheel` and `DOM.scrollIntoViewIfNeeded` on the Mac by the rules for Linux above, with the same notches of `STAGE_NOTCH_PX` and with the Mac's timestamps (the timestamps and the rate, above).",
  "Board ab-t30.32 (step B3 of the input fit) measured the reason with the Mac probe (Chrome 158 on macOS): a CDP `mouseWheel` of `deltaY` 13 and one of `deltaY` 120 each gave one wheel event with `wheelDeltaY` -120 (`deltaMode` 0), as on Linux.",
  "A train of small deltas, as a person's trackpad gives (part B: a median `deltaY` of 13 px, with `wheelDeltaY` about -3 x `deltaY`), would then show -120 on each event, which a trackpad does not give.",
  "A notch of 120 px gives `wheelDeltaY` -120, as a notch of X11 does.",
  // Board ab-t30.12.2 (before: Files: `DOM.setFileInputFiles` with `files` (Playwright's `setInputFiles` with paths and a local browser). The stage clicks the input with the file chooser intercepted (`Page.setInterceptFileChooserDialog`, as `src/input.ts` `setFiles` does), and it sends the client's files to the input that the chooser names. It turns the interception on only for its click, when the client has it off, and turns it off after the click. A `Page.fileChooserOpened` of the stage's own interception does not go to a client. When the click opens no chooser in 2 s, when the chooser names another input, or when another element covers the input, the stage sends the client's call as it is, and counts it.).
  // review-135 B1, B2 and L1 (before: "A file's type is the browser's type for its name, as with a person's choice (Playwright's own script gives the file the client's `mimeType`)." "A client's `DOM.setFileInputFiles` that names a file in the stage's folder (also after its links), on any session, gets an error (`FILES_NOT_YOURS`), so no client's call carries a file of another scope." "...; a file that the stage cannot write; a `DOM.setFileInputFiles` of the stage that fails; ...").
  "Files:",
  "`DOM.setFileInputFiles` with `files` (Playwright's `setInputFiles` with paths and a local browser), and the set files call (Playwright's `setInputFiles` with buffers; board ab-t30.12.2, the answer Q3 a: \"files from buffers get a click on the input, and the service writes them to the scope's own folder for the file chooser\").",
  "A local browser is one that the client connects to with `isLocal: true`; with no `isLocal`, Playwright 1.64.1 to 1.66.0-alpha reads the files of paths and sends them in a set files call (its `prepareFilesForUpload`; measured: the live rows of board ab-t30.12.2).",
  "The stage clicks the input with the file chooser intercepted (`Page.setInterceptFileChooserDialog`, as `src/input.ts` `setFiles` does), and it sends the client's files to the input that the chooser names.",
  "An input with no box gets the click on a label of it that has a box, as `setFiles` does.",
  "The click's point is the select's (the script calls, below).",
  // review-135 N1 (before: It turns the interception on only for its click, when the client has it off, and turns it off after the click.)
  "It turns the interception on only for its click, when the client has it off, and turns it off after the click, or after the wait for a late chooser (below) when no chooser came.",
  // review-140 N8 (board ab-t30.24): a sentence with no text before.
  "The client's setting (its `Page.setInterceptFileChooserDialog` on the tab's own session) counts when the model sends it to Chrome after the tab's gate, not when it comes (review-140 N8): a file call before it in the gate still turns the interception on for its click.",
  // review-144 N2 (board ab-t30.25): a sentence with no text before.
  "The stage takes the client's setting as the model sends it, before Chrome's answer: when Chrome refuses the call, the stage's record differs from Chrome's interception until the client's next setting (review-144 N2).",
  "A `Page.fileChooserOpened` of the stage's own interception does not go to a client.",
  "When the click opens no chooser in 2 s (`FILE_CHOOSER_WAIT_MS`), when the chooser names another input, or when another element covers the input, the stage sends the client's call as it is, and counts it.",
  // review-135 N1 (a new sentence).
  "When no chooser of its click came, a chooser that opens later goes to no client and opens no dialog of Chrome on the service's display (review-135 N1): the stage's own interception stays on until that chooser, a navigation of the main frame, the stage's next click on a file input, or 25 s (`STAGE_ACTION_MAX_MS`).",
  // review-140 N1 (board ab-t30.24) (before: With the client's interception on, or when the client sets its interception in that time, only a chooser of the stage's input goes to no client then, and it is not the client's open chooser.)
  // review-144 N1 (board ab-t30.25) (before: With the client's interception on, or when the client's setting goes to Chrome in the click's wait or in that time (review-140 N1), only a chooser ...)
  "With the client's interception on, or when the client's setting goes to Chrome in that time (review-140 N1; a setting that comes in the click's wait waits in the tab's gate and goes after the click's step: review-144 N1), only a chooser of the stage's input goes to no client then, it is not the client's open chooser, and the end of that time leaves the interception as the client set it.",
  "The probe of board ab-t30.12.2 (Chromium 156 on Linux, local pages) measured: the intercepted chooser names the input by its `backendNodeId`, also after a click on its label; the page gets a trusted click and then the browser's trusted `input` and `change`; no `cancel` event comes when the interception goes off.",
  // Board ab-t30.27 (new sentences): the receiver's access to local files.
  ...T30_27_C11,
  "Buffers.",
  "The stage writes the call's files (each file's `name`, its bytes, and its `lastModifiedMs` as the file's time) to a new folder of the tab's scope (below).",
  "After the chooser it sends `DOM.setFileInputFiles` with their paths to the input that the chooser names.",
  "Then the client's call goes with `FILES_SET` (`() => undefined`) in place of Playwright's function: the client gets Chrome's answer to the call, and the page gets no file and no event of a script.",
  "Before the click the stage gives the written files to a file input of its own world that is in no document (`FILE_PROBE`: no page script can reach it, and its events reach no listener), reads the types that Chrome gives them (Chrome's types for their names, with the box's own types), and lets that input go.",
  // review-135b N5 (before: It translates the call only when each type is the client's `mimeType` as `File` gives it (in lower case), so that the page gets Playwright's result (review-135 L1; the answer Q3 a: only where a person's input gives the same result).)
  "It translates the call only when each type is the client's `mimeType` as `File` gives it (in lower case, and empty when it holds a character outside U+0020 to U+007E; review-135b N5), so that the page gets Playwright's result (review-135 L1; the answer Q3 a: only where a person's input gives the same result).",
  "Else the call passes as it is, and the stage counts it (`filesPass:type`).",
  "The scope's own folder.",
  "The service's folder of the stage's files is `scope-files` in its state folder.",
  // review-135b N4 (before: The service's start removes it with every file of an earlier run and makes it again (mode 0700).)
  "The service's start removes it with every file of an earlier run and makes it again (mode 0700); a start with the stage off removes it and makes none (review-135b N4).",
  "Each scope has one folder in it with the scope's name (mode 0700), and each call a new folder in the scope's folder (mode 0700), with each file under its own name (mode 0600, never over a file that is there).",
  "The end of the scope removes the scope's folder.",
  // review-135 N2 (a new sentence).
  "A write that is still in progress at that end can make the scope's folder again, and its files then stay until the service's next start (review-135 N2: the window is narrow, because the scope's connections close first).",
  "The stage writes a call's files only into the folder of its tab's scope.",
  // review-135 N4 (a new sentence).
  "A scope has no limit of the total size of its files: the files of each call stay until the scope ends, also when the call passes after the write (review-135 N4).",
  // board ab-t30.27, review-153 B1 (before: ... that names a file in the stage's folder (also after its links), on any session, gets an error (`FILES_NOT_YOURS`).)
  "A client's `DOM.setFileInputFiles`, or `Input.dispatchDragEvent` with `data.files` (review-135 B1), that names a file in the stage's folder, the folder itself or a folder that holds it (also after links; board ab-t30.27: Chrome lists a folder's files, with its subfolders, on a folder input or a drop), on any session, gets an error (`FILES_NOT_YOURS`).",
  // review-135b R1 (before: ... that is not absolute or that has a `..` part gets an error too (`FILES_PATH_FORM`; review-135 B2: ... can miss the folder).)
  // board ab-t30.27 (before: While the stage has its folder, a file path of those two calls ...)
  // review-157 N2, board ab-v16.94.25 (before: ... that is not absolute, that has a `..` part or that holds a NUL byte gets an error too ...)
  // review-159 N3 (before: ... so no file has such a path; ...)
  "While the stage has its folder, or the model knows the service's state folder, a file path of those two calls that is not absolute, that has a `..` part, that holds a NUL byte or that has as many bytes as the system's `PATH_MAX` or more (`FILE_PATH_MAX`: 4096 on Linux, 1024 on the Mac; the limit counts the NUL at a path's end, so the kernel opens no file by such a path; review-157 N2: the cost of the checks grows with a path's length) gets an error too (`FILES_PATH_FORM`; review-135 B2: the kernel follows a link before a `..`, so a check of the text can miss the folder; review-135b R1: Chrome cuts a path at its first NUL byte, so a check of the whole text can miss the folder).",
  // board ab-t30.27, review-153 B1 and N1 (new sentences).
  // review-153b N3, board ab-t30.29 (before: In the service the state folder's rule comes first (`FILES_STATE`; board ab-t30.27): ...)
  "In the service the state folder's rule comes before the stage's folder rule (`FILES_STATE`; board ab-t30.27): a path in the state folder, the folder itself or a folder that holds it (for example its parent, the home folder or `/`), also after links, gets an error, because the state folder holds the agent profile, whose files (its `Cookies` and `Login Data`, for example) Chrome gives to a page now that the receiver has access to local files.",
  "Only a path whose real path is inside the MCP folder of the tab's own scope, `<state>/mcp/<scope>/`, passes that rule, while that folder and `<state>/mcp` are no links: the MCP's Playwright sends a folder of it as its path.",
  // board ab-v16.94.22 (a new sentence).
  "That part compares the real path's text (board ab-v16.94.22): another form of that folder (on the Mac a change of case or the data volume's form) gets the error, and the MCP sends the service's own form.",
  "So no client's call carries a file of another scope.",
  // review-153b B1 and N1, board ab-t30.29 (new sentences).
  // review-157 N1, board ab-v16.94.25 (before: That rule also refuses a path in `/proc`, `/dev` or `/sys`, ... while the model reads the path in the service's process.)
  "That rule also refuses a path in `/proc`, `/dev`, `/sys` or `/.vol`, or one of those folders, as written or after links (for example `/proc/self/fd`, `/proc/self/fd/<n>`, `/proc/thread-self/fd`, `/proc/<pid>/fd` and `/dev/fd/<n>`; review-153b B1, board ab-t30.29), with no part for the MCP folder: Chrome opens the path in its own process, where `/proc/self` and `/dev/fd` name Chrome's own open files (the profile's too), while the model reads the path in the service's process, and on the Mac `/.vol/<device>/<inode>/...` names a file by the device and inode of a file or folder inside the state folder (the profile, for example), which the compare by device and inode does not see (review-157 N1).",
  // board ab-v16.94.22, review-155 N1 (before: On the Mac the state folder's rule and the stage's folder rule compare paths with no regard to case (review-153b N1: APFS ignores case by default).)
  "The state folder's rule and the stage's folder rule compare a path with the folder as text and also by device and inode (board ab-v16.94.22, review-155 N1): a path is in the folder, or is the folder, when the folder's device and inode are those of the path or of a folder above it, as written or after links, and a path holds the folder when its device and inode are those of a folder above the folder, also above the folder's form on the Mac's data volume (`/System/Volumes/Data/...`).",
  "A path that does not exist counts by its nearest folder that exists: a missing file under the profile gets the error, and a missing file outside passes (Chrome makes no file through a file input, so a missing file gives no file).",
  // review-157 N1 and N3, board ab-v16.94.25 (before: So another form of the same folder gets the error too: ...)
  "So another form of the state folder or of the stage's folder, or of a folder above one of them, gets the error too: on the Mac a change of case or of Unicode normalization (APFS ignores both by default), the data volume's form or a firmlink, and on Linux a bind mount.",
  // review-135 N5 (a new sentence).
  // review-153b N2, board ab-t30.29 (before: The checks read a path and its links when the call comes: a process of the service's own user (only such a process can write in the folder, mode 0700) can still change a link between the check and Chrome's read, or put a link at a scope's folder (review-135 N5).)
  "The checks read a path and its links when the call comes, and not the links inside a folder that a call names: a local process that writes links can still change a link between the check and Chrome's read (Chrome reads a file when the page reads it), put a link at a scope's folder (review-135 N5), or put a link to a file of the state folder inside a folder that a call names, which Chrome's listing follows (review-153b N2).",
  // review-135 N6 (before: The relay of the old path has no folder: there a set files call passes, and the stage counts it.)
  // board ab-t30.27 (before: The relay of the old path has no folder: there a set files call under the limit (below) passes, and the stage counts it.)
  "The relay of the old path has no folder and knows no state folder: there no client's path is refused for them, and a set files call under the limit (below) passes, and the stage counts it.",
  "The limit.",
  // review-135 N6 (before: On Linux, a set files call of the tab's own session whose files are 50 MB or more in all (`FILES_MAX_BYTES`, Playwright's own limit for buffers) gets an error that names the limit (`FILES_TOO_LARGE`), with no click and no file.)
  "On Linux, a set files call of the tab's own session whose files are 50 MiB (52,428,800 bytes) or more in all (`FILES_MAX_BYTES`, Playwright's own limit for buffers, whose check refuses the same sizes) gets an error that names the limit (`FILES_TOO_LARGE`), with no click and no file, also on the relay of the old path (review-135 N6).",
  "The client's own chooser.",
  "When the client's interception is on, a `Page.fileChooserOpened` that the stage does not wait for goes to the client, and the stage keeps its input.",
  "The client's next file call of that input (for example Playwright's `fileChooser.setFiles()`) gets its files with no click, as a person picks files in an open chooser.",
  // review-135b N2 (before: A navigation of the main frame closes it.)
  "A navigation of the main frame closes it, and so does a file call that passes as the client sent it (below), as a choice in it does: the next file call of its input gets a click (review-135b N2).",
  "These pass as the client sent them, and the stage counts each (`filesPass:<why>`): a call on the Mac; a call on a frame's own session; an element that is not a file input, a disabled input, a directory input (`webkitdirectory`), and an input with no box and no label with a box; no files; a name that is empty, `.` or `..`, that holds a `/`, a `\\` or a NUL, that is longer than 255 bytes, or that another file of the call has; a file that the stage cannot write; a file whose type from Chrome is not the client's `mimeType`, and a read of the types that fails; a `DOM.setFileInputFiles` of the stage that fails; a navigation, a dialog or another end of the plan in the wait.",
  "At the end of the client's session the call does not go, and nothing goes back.",
  "The Mac (an open point).",
  "The extension's `chrome.debugger` takes both calls on Linux (the two-modes probe: from an unpacked extension), and the interception acts in the browser before any dialog, so the same path can work on the Mac.",
  "No run on the Mac measured it, so there the calls pass, counted (`filesPass:mac`).",
  "The recognizers.",
  "A utility call is a `Runtime.callFunctionOn` of Playwright's utility script, `(utilityScript, ...args) => utilityScript.evaluate(...args)`.",
  // Board ab-t30.28 (before: Its arguments are, in this order: the utility script, two flags, the text of Playwright's function (the `value` of the fourth argument), the count of arguments, Playwright's serialized argument, and then the handles.)
  "Its arguments are, in this order: the utility script, two flags (three in the `playwright-core` 1.64.0-alpha-1790635538000 that the service's MCP, `@playwright/mcp` 0.0.83, pins: its third flag, `serialize`, is an argument with no `value` or with an array), the text of Playwright's function (the `value` of the fourth argument, or of the fifth after three flags), the count of arguments, Playwright's serialized argument, and then the handles.",
  "In the serialized argument, a string, a number or a boolean is itself, `undefined` and `null` are `{\"v\": ...}`, a handle is `{\"h\": <index into the handles>}`, an array is `{\"a\": [...]}`, and an object is `{\"o\": [{\"k\": <key>, \"v\": <value>}]}`.",
  "A recognizer matches the whole text of the function with its pattern (a JavaScript regular expression), as `PLAYWRIGHT_FOCUS` does:",
  "| Recognizer | The pattern of the function's text | What the stage reads | What the stage does |",
  "| hit-target check | `^\\(\\[injected\\b[^\\]]*\\]\\)\\s*=>\\s*injected\\.setupHitTargetInterceptor\\([^)]*\\)\\s*$` | `actionType`, `hitPoint`, the node, and the answer of the setup (a string is a miss of Playwright's first check) | for `hover`, the samples of the path outside the target before the setup; after a miss, the recovery |",
  "| the check's stop | `^\\(([A-Za-z_$][\\w$]*)\\)\\s*=>\\s*\\1\\.stop\\(\\)\\s*$`, with the handle that a hit-target setup of the tab returned as its first handle | its answer (`\"done\"`, or a miss at the first event) | after a miss, the recovery at the next setup |",
  "| focus | `PLAYWRIGHT_FOCUS`: `^\\(\\[injected\\b[^\\]]*\\]\\)\\s*=>\\s*injected\\.focusNode\\([^)]*\\)\\s*$` | the node | the focus click |",
  "| fill | `^async\\s*\\(\\[injected\\b[^\\]]*\\]\\)\\s*=>\\s*\\{[\\s\\S]*\\breturn\\s+injected\\.fill\\(node,\\s*[\\w$]+\\);?\\s*\\}\\s*$` | the node | the focus click |",
  "| select text | `^async\\s*\\(\\[injected\\b[^\\]]*\\]\\)\\s*=>\\s*\\{[\\s\\S]*\\breturn\\s+injected\\.selectText\\(node\\);?\\s*\\}\\s*$` | the node | on an `input` or a `textarea`, a click and the select-all chord |",
  "| retry scroll | `^\\(\\[injected\\b[^\\]]*\\]\\)\\s*=>\\s*\\{[\\s\\S]*\\bnode\\.scrollIntoView\\(\\{\\s*\\.\\.\\.[\\w$]+,\\s*behavior:\\s*\"instant\"\\s*\\}\\);[\\s\\S]*\\}\\s*$` | the node | nothing in the first build: the call passes, and the stage counts it |",
  "| blur | `^\\(\\[injected\\b[^\\]]*\\]\\)\\s*=>\\s*injected\\.blurNode\\([^)]*\\)\\s*$` | the node | nothing: the call passes, and the stage counts it |",
  "| select option | `^async\\s*\\(\\[injected\\b[^\\]]*\\]\\)\\s*=>\\s*\\{[\\s\\S]*\\breturn\\s+injected\\.selectOptions\\(node,\\s*[\\w$]+\\);?\\s*\\}\\s*$` | the node, and the client's options | on a select that is not a list box, a click, keys in its popup and Enter (the script calls, below) |",
  // Board ab-t30.12.2 (before: ... | the node | nothing: the call passes, and the stage counts it |).
  "| set files | `^\\(\\[injected\\b[^\\]]*\\]\\)\\s*=>\\s*injected\\.setInputFiles\\([^)]*\\)\\s*$` | the node, and the files (`name`, `mimeType`, `buffer`, `lastModifiedMs`) | the files in the scope's own folder, and the chooser's click (files, above) |",
  "A text that only contains one of these names, for example in a client's own function, does not match.",
  "The vectors' `recognizers` hold the texts of Playwright 1.64.1, 1.65.0 and 1.66.0-alpha-2026-11-09 (the `playwright-core` of `@playwright/mcp` 0.0.85).",
  "A test pins them.",
  "A Playwright version with other texts matches no recognizer, and its calls pass unchanged;",
  "a release adds its texts to the vectors.",
  // Board ab-t30.12.3 (before: A call that no recognizer matches passes unchanged, and the stage counts it.)
  "A call that no recognizer matches passes unchanged, and the stage counts it (`noRecognizer`).",
  // review-138 N6 (a new sentence).
  "The count holds every utility call that no recognizer matches, `page.evaluate` too, so it does not tell `locator.drop` or `dispatchEvent` from other calls; the harness counts those (R7, R15; review-138 N6).",
  "No client's action fails because of it.",
  // Board ab-t30.12.1 (before: "The stage never answers a utility call itself and never changes its arguments." "It only puts its own input before the call.").
  "The stage never answers a utility call itself.",
  // Board ab-t30.12.2 (before: It puts its own input before the call, and it changes the arguments of one kind of call only: after its input of a `selectOption` or of the `fill` of a picker or a range input, the call goes with Playwright's function in `SKIP_EVENTS` (the script calls, below).)
  "It puts its own input before the call, and it changes the arguments of two kinds of call only: after its input of a `selectOption` or of the `fill` of a picker or a range input, the call goes with Playwright's function in `SKIP_EVENTS` (the script calls, below); after its file choice of a set files call, the call goes with `FILES_SET` in place of Playwright's function (files, above).",
  // Board ab-t30.12.3: the harness's count (a sentence with no text before).
  "`locator.drop()` and `dispatchEvent()` run scripts of Playwright's in the page's main world, and they pass as any call.",
  "The page sees their events with `isTrusted` false, which the harness counts (R7, R15).",
  "The hit-target check and its misses.",
  "The miss watch.",
  "The stage reads the answer of each hit-target setup (a string is a miss of Playwright's first check) and of each stop (`\"done\"`, or a miss at the first event).",
  // Review-116b note B. Old: "A miss marks the tab."
  "A miss marks the tab with the node of its setup.",
  "The recovery at the next setup.",
  // Old: "Before the stage sends the next setup of a marked tab, it reads ..."
  "Before the stage sends the next setup of a marked tab, when that setup is of the marked node, it reads the element at the hit point, in Playwright's utility world on the node of the setup.",
  "When that element is not the target or inside it, the stage takes its highest ancestor that does not hold the target (for example the root of a menu, which holds the trigger and the panel).",
  "It moves the pointer out of both boxes, on the side away from the target, to a point 15 px outside.",
  "It waits two frames, and it reads the box of the ancestor again.",
  "Then it sends the setup.",
  "The way around.",
  "The next path to the target goes around that box: when the straight way crosses the box (10 px wider on each side), the path goes through the corner of the wider box that gives the shortest way, as two paths.",
  // Review-116, B2 (before: "the setups of one node with no setup of another node between them." and "After them, the
  // stage sends the rest of the action's input as Playwright sends it, with only the timestamps and the rate above, and
  // counts it.").
  "At most two recoveries in one action: the setups of one node, each within 2 s of a miss of that node (Playwright tries again at most 500 ms after a miss).",
  "After them, each later attempt of that node goes as Playwright sends it, with only the timestamps and the rate above, and the stage counts it: its input from its setup to the end of that attempt (the setup's own miss, its stop's answer, or the end of the stage's action).",
  "A mouse call with no setup, and a setup with no miss of its node in the 2 s before it, get the person's input.",
  "The frame mapping.",
  "Playwright gives the hit point of a frame's element in the frame's own points, and it sends the input on the top page's session, in the top page's points.",
  "So the stage maps a hit point by the frame of the node of the call, on every session:",
  "A same-origin frame: one call in Playwright's utility world on the node's own handle gives the node's box in the top page's points.",
  "For each frame level up to the top page, it adds the box of the frame element plus its border and padding (the sum of Playwright's `_checkFrameIsHitTarget`).",
  "A cross-origin frame (a child session): the stage finds the frame's owner on the parent's session (`DOM.getFrameOwner` with the frame's id, the target id of the child session) and reads its content box (the `content` quad of `DOM.getBoxModel`; `DOM.getContentQuads` gives the border box), level by level.",
  "Within a level that is same-origin, rule 1 applies.",
  "The top page's point is the hit point plus the sum, and the target's box is the node's box plus the sum.",
  "When a read fails or reaches its limit, or when a frame has a transform (Playwright then gives no hit point), the stage plays no path before the setup, and the hover goes the naive way (a retry of Playwright's).",
  "The stage counts it.",
  // Board ab-t30.12.1 (before: "The script calls (the answer Q3 a)." "In the first build these calls pass, and the stage counts them:"
  // "`selectOption`, until a probe shows that the popup of a select takes CDP keys;" "the `fill` of a `date`, `time`,
  // `datetime-local`, `month`, `week`, `color` or `range` input (a script sets the value);" "`setInputFiles` with buffers,
  // `locator.drop`, `dispatchEvent` and `blur`;" "`focus` on an element that is not a text field, and `selectText` on an
  // element that is not an `input` or a `textarea`." "The page sees the script's events (`isTrusted` false), as with
  // Playwright's own input." "Board task ab-t30.12 adds the translations of Q3 a, and it changes this part first: a select
  // gets a click, the arrow keys and Enter;" "a date input gets a click and typed digits;" "files from buffers get a click on
  // the input, with the files in the scope's own folder.").
  "The script calls (the answer Q3 a; board ab-t30.12.1).",
  "Where a person's input gives Playwright's result, the stage translates the call; the rest pass, and the stage counts them.",
  "The probe of board ab-t30.12.1 (Chromium 156 on Linux, local pages) measured the facts below.",
  // review-132 (B1, B2, B3, notes a and b; at fa5ae84 rule 1 had no Mac sentence; rule 2 said "a year 4, a millisecond 3, the
  // others 2, with zeros in front; the hour of a 12-hour field 1 to 12, and its AM/PM field `a` or `p`; 0 for a field that
  // the value does not hold."; rule 3 had no value sentence; rule 6 did not name the Mac, the forms, the range values, a
  // fieldset, the state checks or the focus; rule 7 had no state check and no focus read).
  "`selectOption` on a select that is not a list box (not `multiple`, and a `size` of 1 or less).",
  "The stage reads the select in Playwright's utility world and finds the client's option as Playwright's `selectOptions` does: the first option that one of the client's options matches (an option's handle; else each of `valueOrLabel`, `value`, `label` with its white space normalized, and `index` that the client gives).",
  "It clicks the select at a point of its middle (its popup opens: measured), waits a person's pause, presses the keys that go to the option in the popup, and presses Enter.",
  "Measured: the popup takes CDP keys; its arrow keys skip a disabled or a hidden option and start at the selected option (also a disabled one), or before the first option when none is selected; Home and End go to the first and the last option; typed letters go to the first option whose label starts with them, in any case.",
  "The keys are the shortest of: the arrow keys, Home or End and the arrow keys (at most `SELECT_KEYS_MAX` = 8 arrow keys: a run of 30 arrow keys missed in the probe), and the shortest start of the option's label that no other option's label has (at most `SELECT_TYPE_MAX` = 12 characters, each a key of the US layout with no Shift; a start whose first two characters are the same is one longer, as Chrome cycles at the second).",
  "The page gets the click, one trusted `input` and `change`, and Chrome's own `click` on the select.",
  "On the Mac a select's popup is a native menu that no probe measured: there `selectOption` passes, and the stage counts it (`selectPass:mac`).",
  "The `fill` of a `date`, `time`, `datetime-local`, `month` or `week` input.",
  "The stage reads the input's fields in their order on the screen (the `pseudo` names of its user-agent shadow tree: `DOM.describeNode` with `pierce`), clicks 2 to 5 px from its left edge (the first field gets the focus: measured), waits a person's pause, and types the value's digits field by field with a person's timing: a year 4, the others 2, with zeros in front; the hour of a 12-hour field 1 to 12, and its AM/PM field `a` or `p`.",
  "ArrowRight comes after a year that is not the last field, and after the month of a `month` input (measured: they do not move on by themselves).",
  "The stage types a value only in the form that the typed fields give: a value of a `time` or a `datetime-local` input holds a second exactly when the input has a second field, that second is not 00, and the value holds no millisecond (and the input has no millisecond field).",
  "The stage types only a valid value: a year from 0001, a month from 1 to 12, a day of that month, a week of that year (52 or 53), an hour from 0 to 23, a minute and a second from 0 to 59.",
  "The page gets the browser's trusted `input` and `change` at each new value, as with a person's typing.",
  "The `fill` of a `range` input.",
  "The stage clicks its track at the value's place (with Chrome's default thumb of `RANGE_THUMB_PX` = 16 px: measured), then sends the arrow keys for the rest (at most `RANGE_KEYS_MAX` = 10).",
  "It translates only a value from the minimum to the maximum that is the minimum plus a whole number of steps, written as Chrome writes that number.",
  "The page gets the browser's trusted `input` and `change`.",
  "`selectText` on an `input` of a text type or a `textarea`.",
  "The stage gives the focus click (none when the field has the focus; a read-only field gets it too), waits a person's pause, and sends the select-all chord (Control+A; on the Mac Meta+A with the command `selectAll`).",
  "Then the call goes as the client sent it: its `select()` and `focus()` give the page trusted events only.",
  "From the press of rule 1, 2 or 3 on, at every end of the plan, the client's call goes with Playwright's function inside `SKIP_EVENTS`.",
  "Playwright's function runs as it is, in its utility world.",
  "While it runs, its own `input` and `change` on the field (Playwright's retarget of the node) are skipped when the field's value is still the value that it had when the call began.",
  "When Playwright's function changes the value (the stage's keys missed), its events go, as with no stage.",
  "The wrapper changes only the prototype of Playwright's own world, for the time of the call; the page's world never sees it.",
  "The client gets Chrome's answer to that call: Playwright's own result and errors.",
  "After its keys the stage reads the value and counts whether they gave the client's value (`selectByKeys`, `pickerTyped`, `rangeSet`; else `selectMissed`, `pickerMissed`, `rangeMissed`, with a log line).",
  // Board ab-t30.12.2 (before: ... rule 7); `setInputFiles` with buffers, `locator.drop`, `dispatchEvent` and `blur` ...).
  // Board ab-t30.12.3 (before: ... `locator.drop`, `dispatchEvent` and `blur` (counted as `blurs`); ...)
  "These pass as the client sent them, and the stage counts each: `selectOption` on the Mac (rule 1); a select that is a list box or disabled, and an element that is no select; no such option, or a disabled one (Playwright's own error); an option that the keys do not reach; the option selected already, and a picker or range input that has the value already (a person changes nothing, and Playwright's call still sends its events, which a page can wait for); an empty value; a value that is not of the input's form, not in the form that the typed fields give, or not valid (rule 2); a range value that rule 3 does not translate; a range with a step of `any`, from right to left or up and down, or in a cross-origin frame; a `color` input (its click opens Chrome's color chooser: measured); a disabled or read-only input, also one in a disabled `fieldset`; a call whose states Playwright's own checks refuse, and a click that gives the field no focus (rule 7); `locator.drop` and `dispatchEvent` (no recognizer matches them: counted as `noRecognizer`), and `blur` (counted as `blurs`); `focus` on an element that is not a text field; `selectText` on an element that is not an `input` or a `textarea`.",
  "The page then sees the script's events (`isTrusted` false), as with Playwright's own input.",
  "The ends.",
  "The input of rules 1 to 4 is an action of the tab under the input lock, with the activation, and every end of a plan holds for it (dialogs, `STAGE_EVENT_WAIT_MS`, `STAGE_ACTION_MAX_MS`, an event's error).",
  "Before its input of rules 1 to 3, the stage runs Playwright's own state checks of the call: Playwright's `checkElementStates`, on the call's own handle of Playwright's injected script, with the states that the call's function names (for example `visible`, `enabled` and `editable`, which read `aria-disabled` and `aria-readonly`, also of an ancestor); a call with `force` has none.",
  "When a state does not hold, or the read fails or reaches its limit, the call passes, counted (`selectPass:states`, `pickerPass:states`, `rangePass:states`): Playwright's own call then fails with no event.",
  "After its click, the stage reads the active element of the field's document: when it is not the field (for example, the page cancels `mousedown`), or the read fails or reaches its limit, no key goes, and the call passes as the client sent it, counted (`selectPass:noFocus`, `pickerPass:noFocus`, `rangePass:noFocus`).",
  "At the end of the client's session the call of rules 1 to 3 does not go, and nothing goes back.",
  "A field out of view first gets notches into view (the focus click); one with no box, or that another element covers at the point, gets no click, and its call passes, counted.",
  // Board ab-t30.12.2 (before: Board task ab-t30.12.2 adds files from buffers: a click on the input, with the files in the scope's own folder.)
  "Files from buffers get a click on the input, with the files in the scope's own folder (files, above; board ab-t30.12.2).",
  "The cases of no change.",
  "The stage sends a call as the client sent it, in the order of the gate, and counts it, in these cases.",
  "An input call then gets the stage's timestamp.",
  "a call of a kind that this part does not name (for example `Input.synthesizeTapGesture`, or `Input.dispatchTouchEvent` of a client that turned on touch itself);",
  "a utility call that no recognizer matches;",
  // board ab-t30.19 (before: a text that the typing rule refuses (the answer Q2 a);)
  "a text that the typing rule refuses (the answer Q2 a), and a long text or a collected part that the paste rule refuses;",
  "a script call that a person cannot make (the answer Q3 a);",
  // Board ab-t30.32, step B3: the case "a wheel or a scroll on the Mac, until the Mac's wheel model exists;" is gone.
  "a drag event of a drag that the stage did not start;",
  "a read that fails or reaches its limit.",
  "The log and the counts.",
  "No log line and no count of the stage holds a point, a key or a text (C10's log rule).",
  "The stage counts each case of no change and each end of a plan (a dialog, `STAGE_EVENT_WAIT_MS`, `STAGE_MOVES_IN_FLIGHT`, `STAGE_ACTION_MAX_MS`), for the harness (board ab-t30.2).",
  "The time of a client's action.",
  "A translated pointer action ends in about 2.5 s at most, plus the activation step and a scroll of up to `STAGE_SCROLL_ROUNDS` rounds.",
  // review-123 (the bound) (before: That is inside Playwright's default action timeout of 30 s, and the limits of a key run keep a key run inside it too.).
  // review-123b (the bound, the state until ab-t30.19) (at 780229e: That is inside Playwright's default action timeout of 30 s. A key run is inside it only up to the bound of the time of a key run (above).).
  "That is inside Playwright's default action timeout of 30 s.",
  // board ab-t30.19 (before: Until board task ab-t30.19, a key run is inside it only up to the bound of the time of a key run (above).)
  "A key run adds at most about `STAGE_TYPE_MAX_MS` and one part to Playwright's own time of it (the time of a key run, above).",
  "The default test timeout of `@playwright/test` is 30 s for a whole test, and the stage's time adds up over the actions of a test.",
  "So a client that runs `@playwright/test` against agent mode must raise its test timeout (for example to 120 s).",
  "The stage cannot see the timeout of a test.",
  "The Playwright MCP inside the service gets an action timeout of 30 s (the MCP inside the service, below).",
  "The constants (first values; the `constants` of the vectors):",
  // board ab-t30.19 (before: `STAGE_MOVE_MS = 8`, `STAGE_LATENCY_MS` = 3 to 5, `STAGE_EVENT_WAIT_MS = 2000`, `STAGE_MOVES_IN_FLIGHT = 8`, `STAGE_NOTCH_PX = 120` (Linux), `STAGE_TYPE_MAX_MS = 10000`, `STAGE_RUN_SLOW_MS = 12000`, `STAGE_ACTION_MAX_MS = 25000`, `STAGE_SCROLL_ROUNDS = 4`.)
  // board ab-t30.21 (before: ... `CLIPBOARD_HOLD_MS = 500`, `STAGE_FLUSH_MS = 5000`.)
  // board ab-t30.32 (before: ... `STAGE_NOTCH_PX = 120` (Linux), ...)
  "`STAGE_MOVE_MS = 8`, `STAGE_LATENCY_MS` = 3 to 5, `STAGE_EVENT_WAIT_MS = 2000`, `STAGE_MOVES_IN_FLIGHT = 8`, `STAGE_NOTCH_PX = 120` (Linux and the Mac), `STAGE_TYPE_MAX_MS = 10000`, `STAGE_ACTION_MAX_MS = 25000`, `STAGE_SCROLL_ROUNDS = 4`, `CLIPBOARD_HOLD_MS = 500`, `STAGE_FLUSH_MS = 5000`, `V_READ_MAX_MS = 10000`.",
  "The vectors (`test/vectors/stage.json`) have one or more vectors for each row of the input design's table of every input path (its section 5.1).",
  "Each vector gives the client calls in, the events out and the order of the answers, with a seed and a fake clock.",
  "An event out has its method, its type and its key fields, and its time as a range.",
  "The bounds of each range come from the first values above, and they hold for every seed.",
  "The stage's tests (with a fake bridge and a fake clock) and the tests of this file read the same vectors.",
];

test("C11's part on the input stage holds exactly its sentences, after the pointer at an activation (the input design's section 12.1, point 1)", () => {
  const p = stagePart();
  for (const s of STAGE_ITEMS) assert.ok(says(p, s), `C11 says: ${s}`);
  assert.equal(clean(p), STAGE_ITEMS.join(" "), "the part holds no other text");
  const at = C11.indexOf(`**${STAGE_HEADING}`);
  assert.ok(C11.indexOf("- The pointer at an activation (board ab-v16.70;") < at && at < C11.indexOf("**Permissions and content settings.**"), "the part comes after \"One window per page\", whose last bullet is the pointer at an activation");
  assert.equal(C11.lastIndexOf("\n**", at - 2), C11.indexOf("\n**One window per page (board ab-v16.28).**"), "the part before it is \"One window per page\"");
});

test("board ab-t30.24: the build switch is on in the build, and C11 and stage.ts's header say so exactly", () => {
  const code = readOr("src/relay/stage.ts");
  assert.ok(code.includes("\nexport const STAGE_BUILD_ON = true;\n"), "STAGE_BUILD_ON is true in the build");
  assert.ok(!/STAGE_BUILD_ON = false/.test(code), "no other value");
  const header = code.slice(0, code.indexOf("\nimport ")).split("\n").map((l) => l.replace(/^\/\/ ?/, "")).join(" ").replace(/\s+/g, " ");
  assert.ok(header.includes("The build switch (C11, the build switch): board tasks ab-t30.9 to ab-t30.12, ab-t30.19, ab-t30.21 and ab-t30.22 built the stage behind it, and board task ab-t30.24 turned it on: STAGE_BUILD_ON is true, so the stage shapes the input of every client in the default path, with no setting. Only a test turns the stage off (the model's `stage` option, false)."),
    "stage.ts's header says that the switch is on");
  assert.ok(!/STAGE_BUILD_ON is false|stays off in the default path/.test(header), "the header no longer says that the switch is off");
  const p = stagePart();
  for (const sentence of [
    "Board task ab-t30.24 turned the switch on: the stage shapes the input of every client in the default path, and no variable and no setting turns it off.",
    "Only a test turns the stage off (the model's `stage` option, `false`).",
  ]) assert.ok(says(p, sentence), `C11 says: ${sentence}`);
  assert.ok(!says(p, "The switch stays off until all seven tasks are merged"), "C11 no longer says that the switch stays off");
});

test("review-144 N7: production never sets the model's stage option (C11: only a test turns the stage off): the service's main.ts and the CLI name no `stage` option", () => {
  for (const file of ["src/service/main.ts", "src/cli.ts"]) {
    const code = readOr(file);
    assert.ok(code.length > 0, `${file} is there`);
    assert.doesNotMatch(code, /\bstage\s*:|[{,]\s*stage\s*[,}]|\bstage\s*=/, `${file} sets no stage option`);
  }
  // The doors between them and the model pass the option only when their caller gives one.
  assert.ok(readOr("src/relay/endpoint.ts").includes("...(o.stage !== undefined ? { stage: o.stage } : {})"), "startRelay passes only a given option");
  assert.ok(readOr("src/service/service.ts").includes("...(o.stage !== undefined ? { stage: o.stage } : {})"), "the service passes only a given option");
  assert.ok(readOr("src/service/agent-door.ts").includes("...(o.stage !== undefined ? { stage: o.stage } : {})"), "the agent door passes only a given option");
});

test("review-144 N6 (board ab-t30.25): the input design's open point 8 names the stage on the Mac with no live run, a point for the Mac checks after stage 4", () => {
  const open = DESIGN.slice(DESIGN.indexOf("## 16. Open points"), DESIGN.indexOf("## 17. What this design does not cover"));
  // Board ab-t30.32 (before: "... with C11's Mac rules (no X input, no paste, and `mouseWheel` and `DOM.scrollIntoViewIfNeeded` as the client sent them), ...").
  assert.ok(says(open, "8. **The stage on the Mac has no live run** (review-144 N6). Since board task ab-t30.24 turned the build switch on, the Mac's relay child runs the stage with C11's Mac rules (no X input and no paste; since board ab-t30.32 the wheel's notches as on Linux), and no live row has run on the Mac."), "the point");
  assert.ok(says(open, "This is a point for the Mac checks after stage 4 (the Mac): the live rows run there once before a client depends on the stage on the Mac."), "the Mac checks");
});

// The changed rules of section 12.1 in the other parts of C11 (points 2, 3, 4, 7 and 8; point 5, the Mac, is in the part).
const CHANGED: Record<string, string[]> = {
  "One window per page (board ab-v16.28).": [
    "With the stage on (the input stage, below), on Linux with one window per page, the first move of a translated pointer action is an input that starts an action too.",
    "So the activation comes before the path, not only before the press, as a person brings a window forward before the hand moves in it.",
    "A translated pointer action is a path that the stage sends for a client's call, with its press and its release: a move, a click, a hover, a drag, the stage's own focus click, or the way to a wheel point.",
    "The activation decides, as for a press, whether the page comes forward.",
    "The stage's own focus click is an input that starts an action.",
    "With the stage on, a client's `Page.handleJavaScriptDialog` goes at once too: it never waits behind that input (the input stage, below).",
    "With the stage on (the input stage, below), the events that the stage sent set it, not the client's points.",
    // review-144 N3 (board ab-t30.25) (before: With the stage on (the input stage, below), the catch-up is the stage's path.)
    "With the stage on (the input stage, below), the catch-up is the stage's path, and the relay sends no catch-up of its own: the build switch is on (board ab-t30.24), so only a test's model with the stage off sends one (review-144 N3).",
    "After an X record or a cover mark, the stage's next path starts at the recorded point.",
    "The catch-up's own rules (the thresholds of 50 px and 2 px, the samples of 16 ms, `CATCH_UP_MAX_UNANSWERED`) give way to the stage's rules: each path starts at the page's last point, at the rate of a device, within the bound `STAGE_MOVES_IN_FLIGHT`.",
  ],
  "Refusals.": [
    "The input stage (above) adds no refusal (the operator's answer Q3 a, board item ab-0z5): a call that a person cannot make passes, or it goes as a person's input that gives the same result.",
    // Board ab-t30.12.2: a sentence with no text before.
    // review-135 B1 and B2 (before: ... and a client's `DOM.setFileInputFiles` that names a file of the stage's own folder.)
    // review-135b R1 (before: ... or a path that is not absolute or that has a `..` part.)
    // review-135 N6 (before: Its only refusals are of files (the input stage, files; board ab-t30.12.2): a set files call of 50 MB or more in all on Linux, and a client's `DOM.setFileInputFiles` or `Input.dispatchDragEvent` that names a file of the stage's own folder, or a path that is not absolute, that has a `..` part or that holds a NUL byte (review-135b R1).)
    // board ab-t30.27 (before: ... that names a file of the stage's own folder, or a path that is not absolute, ...)
    // review-153b B1, board ab-t30.29 (before: ... in the service a path of the state folder, the folder or a folder that holds it (board ab-t30.27), or a path that is not absolute, ...)
    // review-157 N1 and N2, board ab-v16.94.25 (before: ... or a path in `/proc`, `/dev` or `/sys` (review-153b B1), or a path that is not absolute, that has a `..` part or that holds a NUL byte (review-135b R1).)
    "Its only refusals are of files (the input stage, files; board ab-t30.12.2): a set files call of 50 MiB or more in all on Linux, and a client's `DOM.setFileInputFiles` or `Input.dispatchDragEvent` that names a file of the stage's own folder, the folder or a folder that holds it, in the service a path of the state folder, the folder or a folder that holds it (board ab-t30.27) or a path in `/proc`, `/dev`, `/sys` or `/.vol` (review-153b B1, review-157 N1), or a path that is not absolute, that has a `..` part, that holds a NUL byte (review-135b R1) or that has `PATH_MAX` bytes or more (review-157 N2).",
  ],
  "The MCP inside the service (from stage 1d; the self-contained design, section 8.2).": [
    "Its configuration also sets `timeouts.action: 30000` in `createConnection`, in place of the MCP's default of 5 s, so that an action that the input stage (above) translates ends inside the MCP's action timeout.",
  ],
};

test("C11 states the changed rules of the input stage in their parts: the window before the path, the dialog's answer, the last point and the catch-up, no new refusal, the MCP's action timeout", () => {
  for (const [heading, list] of Object.entries(CHANGED)) sayAll(partOr(heading), list);
  const win = flat(partOr("One window per page (board ab-v16.28)."));
  const order = (a: string, b: string, c: string, what: string, text = win) => assert.ok(text.indexOf(flat(a)) >= 0 && text.indexOf(flat(a)) < text.indexOf(flat(b)) && text.indexOf(flat(b)) < text.indexOf(flat(c)), what);
  order("3. It sends the input (`debugger.sendCommand`).", CHANGED["One window per page (board ab-v16.28)."][0], "- The order and the limit.", "point 2: in the bullet \"The window comes forward for input\", after the activation's steps");
  order("The calls that the model answers go at once.", CHANGED["One window per page (board ab-v16.28)."][5], "When an activation does not end in 2 s", "point 7: in the bullet \"The order and the limit\"");
  order("a child session's pointer input and touch input make it unknown.", CHANGED["One window per page (board ab-v16.28)."][6], "The pointer's place `at`, from the daemon's answers", "point 3: each page's last point, in \"What the relay keeps\"");
  order("A step and a catch-up never overlap on one page.", CHANGED["One window per page (board ab-v16.28)."][7], "- The geometry read:", "point 3: the catch-up is the stage's path, at the end of the catch-up's bullet");
  order("A rule applies on every session (the root, a browser session, a page session) unless it names one.", CHANGED["Refusals."][0], "A new context (board ab-jzg Q1: refuse).", "point 4: in the lead of the refusals", flat(partOr("Refusals.")));
  assert.ok(!says(C11, "adds a refusal") && !/\bno refusal of its own\b/.test(C11), "point 4: no refusal of the stage anywhere");
  // Point 5 and point 7 in the part itself.
  sayAll(stagePart(), [
    // Board ab-t30.32, step B3 (before: "The Mac (with the stage on). Until the Mac's wheel model exists (part B, board ab-t30.7, and the input design's build task 9), the stage sends `mouseWheel` and `DOM.scrollIntoViewIfNeeded` on the Mac as the client sent them, with the stage's timestamp.").
    "The Mac (with the stage on). The stage sends `mouseWheel` and `DOM.scrollIntoViewIfNeeded` on the Mac by the rules for Linux above, with the same notches of `STAGE_NOTCH_PX` and with the Mac's timestamps (the timestamps and the rate, above).",
    "A client's `Page.handleJavaScriptDialog` never waits. With the stage on, the model sends it to Chrome at once, before the tab's gate and before any step of the stage, of an activation or of a world lookup.",
    "Each read of the stage waits at most `GEOMETRY_WAIT_MS` (200 ms).",
    "Each wait for an answer of the stage's own event has the limit `STAGE_EVENT_WAIT_MS = 2000`, counted from the oldest event of the plan that has no answer.",
  ]);
});

test("C11's MCP inside the service changes by one sentence only (the input design's section 12.1, point 8)", () => {
  const mcp = partOr("The MCP inside the service (from stage 1d; the self-contained design, section 8.2).");
  const bullets = mcp.split("\n- ").slice(1).map((b) => flat(b).trim());
  assert.equal(bullets.length, 14, "the seven bullets of stage 0, the input stage's one, stage 1d part 2b's four (the configuration, the roots, the ticket, the worker), the folder's life (board ab-v16.94.12, review-115 note 3) and the folder upload (board ab-v16.94.17, F2; its rule since board ab-t30.27)");
  assert.equal(bullets[2], flat(CHANGED["The MCP inside the service (from stage 1d; the self-contained design, section 8.2)."][0]), "the new bullet follows the configuration's bullet");
  assert.equal(flat(mcp).split("timeouts.action").length, 2, "the MCP's part names the action timeout once");
  // The other parts of the MCP keep their text: no transport, no admission and no configuration file changes (the existing tests assert them).
  for (const h of ["The MCP path (from stage 1d;", "The admission of the MCP path (from stage 1d;", "How a session gets the MCP (from stage 2;"]) assert.ok(!partOr(h).includes("timeouts.action"), `${h}: no change`);
});

// The vectors.
const sp = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
function stageTable() {
  const lines = C11.split("\n");
  const at = lines.findIndex((l) => l.trim() === "| Recognizer | The pattern of the function's text | What the stage reads | What the stage does |");
  assert.ok(at >= 0, "C11's table of the recognizers");
  const rows = new Map<string, string[]>();
  for (const l of lines.slice(at + 2)) {
    const t = l.trim();
    if (!t.startsWith("| ")) break;
    const cells = t.slice(2, -2).split(" | ").map((c) => c.trim());
    rows.set(cells[0], cells.slice(1));
  }
  return rows;
}
function designRows(): string[] {
  const lines = DESIGN.split("\n");
  const at = lines.findIndex((l) => l.startsWith("| Playwright call | CDP that the model sees |"));
  assert.ok(at >= 0, "the input design's table of every input path (section 5.1)");
  const rows: string[] = [];
  for (const l of lines.slice(at + 2)) { if (!l.startsWith("| ")) break; rows.push(l.slice(2).split(" | ")[0].trim()); }
  return rows;
}

test("the vectors' constants are C11's constants and the input design's (section 12.1, point 1), and its first values are C11's", () => {
  const V = vectorsOrFail();
  const design = DESIGN.slice(DESIGN.indexOf("### 12.1"), DESIGN.indexOf("### 12.2"));
  // Board ab-t30.19: CLIPBOARD_HOLD_MS, the paste's wait for the clipboard's owner, is a constant of the part too; board
  // ab-t30.21: V_READ_MAX_MS, the limit of the wait for the paste's read after V's answer.
  const named = [...new Set([...design.matchAll(/`((?:STAGE|CLIPBOARD|V_READ)_[A-Z_]+)/g)].map((m) => m[1]))];
  assert.deepEqual(Object.keys(V.constants).sort(), named.sort(), "the constants of the design's section 12.1");
  const p = stagePart();
  for (const [name, v] of Object.entries(V.constants) as [string, any][]) {
    if (Array.isArray(v)) {
      assert.ok(says(p, `\`${name}\` = ${v[0]} to ${v[1]}`) && says(design, `\`${name}\` = ${v[0]} to ${v[1]}`), `${name} = ${v[0]} to ${v[1]}`);
    } else {
      assert.ok(says(p, `\`${name} = ${v}\``) && says(design, `\`${name} = ${v}\``), `\`${name} = ${v}\``);
    }
  }
  assert.ok(says(p, "The constants (first values; the `constants` of the vectors):"), "the part names the vectors' constants");
  assert.equal(V.constants.STAGE_MOVES_IN_FLIGHT, 8);
  assert.ok(V.constants.STAGE_ACTION_MAX_MS < 30000, "a translated action ends inside Playwright's default action timeout of 30 s");
  // Each first value of the vectors is a phrase of C11's part.
  const F = V.firstValues;
  const r = (k: string) => `${F[k][0]} to ${F[k][1]}`;
  const phrases: Record<string, string> = {
    pathMs: `Its time is ${r("pathMs")} ms (Fitts's law).`,
    longPathMs: `only while its time stays at most ${F.longPathMs[1]} ms.`,
    longPathPx: `A move of more than ${F.longPathPx} px can add an overshoot leg`,
    maxSpeedPxPerMs: `at a speed of at most ${F.maxSpeedPxPerMs} px/ms.`,
    shortMovePx: `at most ${F.shortMovePx} px from the page's last point: samples of the client's line`,
    shortSpeedPxPerMs: `Their speed is ${r("shortSpeedPxPerMs")} px/ms`,
    pauseMs: `The pause before a press is ${r("pauseMs")} ms.`,
    holdMs: `The press has \`force\` 0.5 and a hold of ${r("holdMs")} ms.`,
    dblGapMs: `from the first release to the second press, is ${r("dblGapMs")} ms.`,
    keyHoldMs: `The hold of a key is ${r("keyHoldMs")} ms.`,
    shiftBeforeMs: `A Shift \`rawKeyDown\` comes ${r("shiftBeforeMs")} ms before a shifted character`,
    shiftAfterMs: `the release of Shift comes ${r("shiftAfterMs")} ms after the release of the last key that it holds.`,
    chordBeforeMs: `In a chord, each modifier comes ${r("chordBeforeMs")} ms before the key`,
    chordReleaseGapMs: `the releases come ${r("chordReleaseGapMs")} ms apart, in reverse order.`,
    modifierAfterMs: `holds the modifier's \`keyUp\` until ${r("modifierAfterMs")} ms after the mouse release`,
    notchGapMs: `the gaps between notches are ${r("notchGapMs")} ms.`,
    scrollWaitMs: `It waits for the smooth scroll to end (${F.scrollWaitMs} ms, a first value)`,
    dragWaitMs: `The stage first waits ${r("dragWaitMs")} ms after the press, as a person does.`,
    fastKeyMs: `the plan at the fast end of the person's spread (${r("fastKeyMs")} ms a key)`,
    spreadSd: `a standard deviation of 1/${1 / F.spreadSd} of the target's smaller side, at most 1/${1 / F.spreadMax} of that side.`,
  };
  assert.deepEqual(Object.keys(F).sort(), [...Object.keys(phrases), "spreadMax"].sort(), "each first value has its phrase");
  for (const [k, s] of Object.entries(phrases)) assert.ok(says(p, s), `${k}: C11 says ${s}`);
});

// Board ab-t30.13, step A: the input stage takes the operator's recorded values (part B, PR #117; the research's section
// 8.3). Four first values change in C11 and the vectors together, STAGE_MOVE_MS keeps 8 with part B's note, and the
// device's values stay for each platform (step B, board ab-t30.32, is the Mac's).
test("board ab-t30.13: C11 and the vectors say step A's values: the speed limit 8 px/ms, the pause 25 to 190 ms from the last 1 px move, the Shift lead 45 to 480 ms, STAGE_MOVE_MS 8 with part B's gaps; no old text", () => {
  const V = vectorsOrFail(), F = V.firstValues, p = stagePart();
  assert.deepEqual([F.maxSpeedPxPerMs, F.pauseMs, F.shiftBeforeMs, V.constants.STAGE_MOVE_MS], [8, [25, 190], [45, 480], 8]);
  for (const s of ["at a speed of at most 8 px/ms.", "The pause before a press is 25 to 190 ms. It counts from the last sample that moves the pointer 1 px or more.",
    "A Shift `rawKeyDown` comes 45 to 480 ms before a shifted character", "(125 Hz; part B: the person's sample gaps median 8.1 ms, p10 7.9, p90 8.3).",
    "The values of the hand (path, pause, press, keys) are the same in `linux.json` and `mac.json`."]) assert.ok(says(p, s), `C11 says: ${s}`);
  for (const old of ["at most 3.5 px/ms", "The pause before a press is 80 to 400 ms.", "45 to 95 ms before a shifted character", "(125 Hz, a first value)"])
    assert.ok(!says(C11, old), `no old text: ${old}`);
  // A path's least count of moves follows the speed limit: the distance to the middle of the target over 8 px/ms for 8 ms.
  const lows = V.vectors.flatMap((v: any) => v.out.filter((o: any) => o.path && o.path.part === undefined).map((o: any) => {
    const m = (x: any) => (Array.isArray(x) ? (x[0] + x[1]) / 2 : x);
    return [o.count[0], Math.ceil(Math.hypot(m(o.path.to.x) - o.path.from.x, m(o.path.to.y) - o.path.from.y) / (F.maxSpeedPxPerMs * o.gapMs))];
  }));
  assert.equal(lows.length, 28, "the vectors' whole paths");
  for (const [lo, want] of lows) assert.equal(lo, want, "each whole path's least count is the speed limit's");
  // Every pause item has the new range.
  const pauses = V.vectors.flatMap((v: any) => v.out.filter((o: any) => o.rule === "pauseMs").map((o: any) => o.at));
  assert.equal(pauses.length, 29);
  for (const at of pauses) assert.deepEqual(at, F.pauseMs);
});

// Board ab-t30.32, step B (the Mac probe, Chrome 158 on macOS): B1 does not pass (the probe's move went through the
// stage's whole-px path, so it shows no fraction of a CDP point on the Mac), B2 does not start, and B3 gives the Mac
// Linux's notches (a CDP mouseWheel there gives wheelDeltaY -120 for a deltaY of 13 and of 120).
test("board ab-t30.32: C11, mac.json and the Mac vectors say step B: whole px on the Mac (B1 does not pass, B2 does not start) and Linux's notches on the Mac (B3); no old text", () => {
  const V = vectorsOrFail(), p = stagePart();
  for (const s of ["Board ab-t30.32 keeps the device's whole px on the Mac (`device.wholePx` stays true): step B1 of the input fit (a press with a person's fraction) does not pass, and step B2 (the moves of less than 1 px) does not start.",
    "where the pointer's rules (below) round the client's point, they round it on Linux only, and a path to a client's point ends at that point rounded.",
    "and so are the points that the stage chooses itself (a wheel point, the spread point, the point of its own click).",
    "It ends at the client's point rounded to a whole px, or at the spread point of its press (below).",
    "The stage sends `mouseWheel` and `DOM.scrollIntoViewIfNeeded` on the Mac by the rules for Linux above",
    "a CDP `mouseWheel` of `deltaY` 13 and one of `deltaY` 120 each gave one wheel event with `wheelDeltaY` -120 (`deltaMode` 0), as on Linux."]) assert.ok(says(p, s), `C11 says: ${s}`);
  for (const old of ["Mac's wheel model", "a wheel or a scroll on the Mac", "`STAGE_NOTCH_PX = 120` (Linux),", "Its other points keep their fraction", "in whole px on Linux, with no sample"]) assert.ok(!says(C11, old), `no old text: ${old}`);
  const mac = JSON.parse(readOr("src/human/params/mac.json")), linux = JSON.parse(readOr("src/human/params/linux.json"));
  assert.equal(mac.device.wholePx, true, "mac.json keeps whole px (B1)");
  assert.deepEqual(mac.wheel, linux.wheel, "the Mac's wheel is Linux's (B3)");
  for (const k of ["device.wholePx", "wheel"]) assert.match(mac.sources[k], /ab-t30\.32/, `mac.json names step B's probe for ${k}`);
  assert.match(mac.note, /ab-t30\.32/, "mac.json's note names step B");
  for (const id of ["wheel-mac", "scroll-into-view-mac"]) {
    const v = V.vectors.find((x: any) => x.id === id);
    const twin = V.vectors.find((x: any) => x.id === id.replace(/-mac$/, ""));
    assert.ok(v && v.platform === "mac" && twin.platform === "linux", `${id}: a Mac vector with a Linux twin`);
    assert.ok(!v.out.some((o: any) => o.pass && v.in.find((c: any) => c.id === o.for)?.method !== "Runtime.callFunctionOn"), `${id}: no wheel or scroll passes`);
    assert.deepEqual(v.out, twin.out, `${id}: the events of its Linux twin`);
    assert.deepEqual(v.answers, twin.answers, `${id}: the answers of its Linux twin`);
  }
});

test("the vectors' recognizers are C11's table: each pattern matches its Playwright texts of the three versions, and no client's function or other text", () => {
  const V = vectorsOrFail();
  const rows = stageTable();
  assert.deepEqual([...rows.keys()].sort(), V.recognizers.map((x: any) => x.name).sort(), "the rows of C11's table");
  assert.ok(says(stagePart(), "The vectors' `recognizers` hold the texts of Playwright 1.64.1, 1.65.0 and 1.66.0-alpha-2026-11-09"), "C11 names the three versions");
  const all = V.recognizers.map((x: any) => ({ ...x, re: new RegExp(x.pattern) }));
  for (const x of all) {
    const pattern = sp(rows.get(x.name)![0]).find((c) => c.startsWith("^"));
    assert.equal(pattern, x.pattern, `${x.name}: C11's pattern is the vectors' pattern`);
    assert.deepEqual(Object.keys(x.texts).sort(), ["1.64.1", "1.65.0", "1.66.0-alpha-2026-11-09"], `${x.name}: the three versions`);
    for (const [ver, t] of Object.entries(x.texts) as [string, string][]) {
      assert.ok(x.re.test(t), `${x.name}: matches the text of ${ver}`);
      for (const o of all) if (o !== x) assert.ok(!o.re.test(t), `${x.name}'s text of ${ver} matches no other recognizer (${o.name})`);
    }
    assert.ok(x.notTexts.length > 0, `${x.name}: a client's function that only contains the name`);
    for (const t of x.notTexts) for (const o of all) assert.ok(!o.re.test(t), `${x.name}: ${JSON.stringify(t)} matches no recognizer (${o.name})`);
  }
  // The focus recognizer is the relay's PLAYWRIGHT_FOCUS of today (C11, "Playwright's focus call").
  assert.equal(all.find((x: any) => x.name === "focus").pattern, PLAYWRIGHT_FOCUS.source, "the focus pattern is PLAYWRIGHT_FOCUS");
  assert.ok(sp(rows.get("focus")![0]).includes("PLAYWRIGHT_FOCUS"), "C11's row names PLAYWRIGHT_FOCUS");
  assert.ok(says(stagePart(), `\`${V.utility.functionDeclaration}\``), "C11 names the utility script's function");
});

// The vectors' reference rules (C11's part on the input stage).
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isRange = (x: unknown): x is [number, number] => Array.isArray(x) && x.length === 2 && x.every(isNum) && x[0] <= x[1];
const within = (r: [number, number], b: [number, number]) => r[0] >= b[0] && r[1] <= b[1];
const mid = (v: any) => (isNum(v) ? v : (v[0] + v[1]) / 2);
const whole = (v: any) => (isNum(v) ? Number.isInteger(v) : isRange(v) && v.every(Number.isInteger));
const STAGE_SENDS = ["Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "Input.dispatchDragEvent", "Page.setInterceptFileChooserDialog", "DOM.setFileInputFiles"];
const TEXT_TYPES = ["text", "search", "email", "url", "tel", "password", "number", undefined];
const isTextField = (n: any) => !!n && ((n.tag === "input" && TEXT_TYPES.includes(n.type)) || n.tag === "textarea" || n.contenteditable === true);
const typesInto = (n: any) => !!n && ((n.tag === "input" && TEXT_TYPES.includes(n.type)) || n.tag === "textarea");
/** The inputs whose fill the stage types field by field (C11, the script calls; board ab-t30.12.1). */
const PICKERS = ["date", "time", "datetime-local", "month", "week"];
// Condition 3 of the spread point: an element whose effect does not depend on the point.
const spreads = (n: any) => !!n && (["button", "label", "summary"].includes(n.tag) || (n.tag === "a" && n.href) || (n.tag === "input" && ["button", "submit", "reset", "checkbox", "radio"].includes(n.type)) || ["button", "link", "checkbox", "radio", "tab", "menuitem", "switch"].includes(n.role));
// Playwright's serialized argument (C11, the recognizers): its object's key, for [injected, node, { ... }].
const argOf = (params: any, k: string) => params.arguments?.[5]?.value?.a?.[2]?.o?.find((e: any) => e.k === k)?.v;
const nodeOf = (params: any) => params.arguments?.at(-1)?.objectId;
const recognizerOf = (V: any, c: any) => {
  if (c.method !== "Runtime.callFunctionOn" || c.params.functionDeclaration !== V.utility.functionDeclaration) return null;
  const t = c.params.arguments?.[3]?.value;
  const hits = V.recognizers.filter((x: any) => new RegExp(x.pattern).test(t));
  assert.ok(hits.length <= 1, `at most one recognizer for ${JSON.stringify(t).slice(0, 60)}`);
  return hits[0]?.name ?? null;
};
const ref = (s: string) => /^(start|in:\d+|out:\d+)$/.test(s);
const outIndex = (s: string) => Number(s.slice(4));
const pointsOf = (o: any) => [o.path?.from, o.path?.to, o.line?.from, o.line?.to, o.fields && "x" in o.fields ? o.fields : null].filter(Boolean);

test("every row of the input design's table of every input path has a vector, and each other vector names a rule of C11's part", () => {
  const V = vectorsOrFail();
  const rows = designRows();
  assert.equal(rows.length, 36, "the 36 rows of section 5.1");
  const named = new Set(V.vectors.filter((v: any) => v.row !== undefined).map((v: any) => v.row));
  for (const r of rows) assert.ok(named.has(r), `a vector for the row ${r}`);
  for (const r of named) assert.ok(rows.includes(r as string), `${r}: a row of the design`);
  const p = stagePart();
  for (const v of V.vectors.filter((x: any) => x.row === undefined)) assert.ok(typeof v.rule === "string" && p.includes(`- ${v.rule}`), `${v.id}: the rule ${v.rule} is a bullet of C11's part`);
  assert.ok(says(p, "The vectors:") && says(p, "`test/vectors/stage.json`.") && V.contract.includes("docs/contracts/C11.md") && V.contract.includes("The input stage (board ab-t30.6)"), "C11 and the vectors name each other");
});

test("each stage vector has the shape of its format: the client calls in, the events out, the answers", () => {
  const V = vectorsOrFail();
  assert.deepEqual(Object.keys(V).sort(), ["constants", "contract", "firstValues", "format", "recognizers", "utility", "vectors"]);
  const ids = new Set<string>();
  for (const v of V.vectors) {
    const w = `${v.id}`;
    assert.ok(!ids.has(v.id), `${w}: a unique id`); ids.add(v.id);
    for (const k of Object.keys(v)) assert.ok(["id", "row", "rule", "note", "platform", "seed", "clock", "page", "chrome", "in", "out", "answers"].includes(k), `${w}: a known field ${k}`);
    assert.ok((v.row === undefined) !== (v.rule === undefined), `${w}: a row or a rule`);
    assert.ok(["linux", "mac"].includes(v.platform) && Number.isInteger(v.seed) && v.clock === 0 && typeof v.note === "string", `${w}: platform, seed, clock, note`);
    assert.ok(isObj(v.page) && isObj(v.page.viewport) && isObj(v.page.nodes), `${w}: the page`);
    v.in.forEach((c: any, i: number) => {
      assert.equal(c.id, i + 1, `${w}: the calls in order`);
      assert.equal([c.at, c.after, c.afterEvent].filter((x) => x !== undefined).length, 1, `${w} ${c.id}: one of at, after and afterEvent`);
      if (c.after !== undefined) assert.ok(Number.isInteger(c.after) && c.after < c.id, `${w} ${c.id}: after an earlier call`);
      for (const k of Object.keys(c)) assert.ok(["id", "at", "after", "afterEvent", "waitMs", "session", "method", "params"].includes(k), `${w} ${c.id}: a known field ${k}`);
      assert.ok(typeof c.method === "string" && isObj(c.params) && (c.session === undefined || c.session === "child"), `${w} ${c.id}: method, params, session`);
      if (c.method === "Runtime.callFunctionOn" && c.params.functionDeclaration === V.utility.functionDeclaration) assert.equal(typeof c.params.arguments[3].value, "string", `${w} ${c.id}: the function's text`);
    });
    const inIds = new Set(v.in.map((c: any) => c.id));
    v.out.forEach((o: any, k: number) => {
      const at = `${w} out:${k}`;
      for (const f of Object.keys(o)) assert.ok(["method", "type", "for", "from", "at", "rule", "fields", "pass", "session", "path", "line", "gapMs", "durMs", "durRule", "count", "notches", "rest", "typing", "holdMs", "shift", "skipEvents", "filesSet"].includes(f), `${at}: a known field ${f}`);
      assert.ok(o.pass === true ? o.method === undefined : STAGE_SENDS.includes(o.method), `${at}: a method that the stage sends, or a pass`);
      assert.ok(o.for === null || inIds.has(o.for), `${at}: for a client call, or null`);
      assert.ok(ref(o.from) && (!o.from.startsWith("in:") || inIds.has(Number(o.from.slice(3)))) && (!o.from.startsWith("out:") || outIndex(o.from) < k), `${at}: from an earlier time`);
      assert.ok(isRange(o.at), `${at}: at is a range`);
      if (o.rule !== undefined) assert.ok(isRange(V.firstValues[o.rule]) && within(o.at, V.firstValues[o.rule]), `${at}: at within the first value ${o.rule}`);
    });
    for (const a of v.answers) {
      for (const f of Object.keys(a)) assert.ok(["id", "after", "result", "mayBeEarly", "waits", "error", "from", "at", "rule"].includes(f), `${w} answer ${a.id}: a known field ${f}`);
      assert.ok(a.after === "none" || (/^out:\d+$/.test(a.after) && outIndex(a.after) < v.out.length), `${w} answer ${a.id}: after an item or none`);
    }
  }
});

// Board ab-t30.32 (step B3): the Mac gets the same notches as Linux, so no vector's wheel or scroll passes on the Mac.
test("each stage vector's events follow C11's rules: paths, short moves, presses, the spread point, wheel notches (on Linux and on the Mac), typed keys", () => {
  const V = vectorsOrFail();
  const K = V.constants, F = V.firstValues;
  for (const v of V.vectors) {
    const w = v.id, linux = v.platform === "linux";
    const byId = new Map(v.in.map((c: any) => [c.id, c]));
    let lastPointer: any = null;
    let residual = 0, asked = 0, given = 0;
    v.out.forEach((o: any, k: number) => {
      const at = `${w} out:${k}`;
      if (linux) for (const pt of pointsOf(o)) assert.ok(whole(pt.x) && whole(pt.y), `${at}: whole px on Linux`);
      if (o.path) {
        assert.equal(o.gapMs, K.STAGE_MOVE_MS, `${at}: one move each STAGE_MOVE_MS`);
        const d = Math.hypot(mid(o.path.to.x) - o.path.from.x, mid(o.path.to.y) - o.path.from.y);
        assert.ok(d > F.shortMovePx, `${at}: a path is longer than a short move`);
        const rule = d > F.longPathPx ? "longPathMs" : "pathMs";
        if (o.path.part === undefined) {
          assert.equal(o.durRule, rule, `${at}: the path's time by its length`);
          assert.ok(within(o.durMs, F[rule]), `${at}: its time within ${rule}`);
          assert.ok(o.count[0] >= Math.ceil(d / (F.maxSpeedPxPerMs * o.gapMs)), `${at}: enough moves for a speed of at most ${F.maxSpeedPxPerMs} px/ms`);
        } else {
          assert.deepEqual(o.path.totalMs, F[rule], `${at}: the whole path's time by its length`);
          assert.ok(within(o.durMs, [0, F[rule][1]]), `${at}: a part within the whole path's time`);
        }
        assert.ok(isRange(o.count) && o.count[0] >= 1 && o.count[1] <= Math.floor(o.durMs[1] / o.gapMs) + 1, `${at}: the count of moves fits the time`);
        if (o.path.part !== "until dragIntercepted") lastPointer = o.path.to;
      }
      if (o.line) {
        const d = Math.hypot(o.line.to.x - o.line.from.x, o.line.to.y - o.line.from.y);
        assert.ok(d > 0 && d <= F.shortMovePx, `${at}: a short move is at most ${F.shortMovePx} px`);
        assert.equal(o.gapMs, K.STAGE_MOVE_MS, `${at}: the rate of a device`);
        assert.ok(o.durMs[0] >= d / F.shortSpeedPxPerMs[1] && o.durMs[1] <= d / F.shortSpeedPxPerMs[0], `${at}: a speed of ${F.shortSpeedPxPerMs[0]} to ${F.shortSpeedPxPerMs[1]} px/ms`);
        lastPointer = o.line.to;
      }
      if (o.method === "Input.dispatchMouseEvent" && o.type === "mousePressed") {
        assert.equal(o.fields.force, 0.5, `${at}: force 0.5`);
        if (lastPointer) assert.deepEqual({ x: o.fields.x, y: o.fields.y }, { x: lastPointer.x, y: lastPointer.y }, `${at}: the press is where the path ended`);
        const c: any = byId.get(o.for);
        if (c?.method === "Input.dispatchMouseEvent" && isRange(o.fields.x)) {
          // The spread point: a locator click (a hit-target setup of the action mouse), clickCount 1, at the middle of an element of condition 3.
          const setup = v.in.find((x: any) => recognizerOf(V, x) === "hit-target check");
          assert.ok(setup && argOf(setup.params, "actionType") === "mouse" && o.fields.clickCount === 1, `${at}: the spread point only for a locator click with clickCount 1`);
          assert.ok(!v.in.some((x: any) => x.method === "Input.dispatchMouseEvent" && x.params?.type === "mousePressed" && x.params?.clickCount >= 2), `${at}: no spread point in an action with a press of clickCount 2 or 3 (a dblclick, a triple click)`);
          const n = v.page.nodes[nodeOf(setup.params)], b = n.box, max = F.spreadMax * Math.min(b.width, b.height);
          const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
          assert.ok(spreads(n), `${at}: condition 3`);
          assert.ok(Math.abs(c.params.x - cx) <= 1 && Math.abs(c.params.y - cy) <= 1, `${at}: condition 2, the client's point is the middle`);
          assert.ok(within(o.fields.x, [cx - max, cx + max]) && within(o.fields.y, [cy - max, cy + max]), `${at}: at most 1/4 of the smaller side from the middle`);
        } else if (c?.method === "Input.dispatchMouseEvent") {
          assert.deepEqual([o.fields.x, o.fields.y], [Math.round(c.params.x), Math.round(c.params.y)], `${at}: the client's point, rounded half up`);
          assert.equal(o.fields.clickCount, c.params.clickCount, `${at}: the client's clickCount`);
          assert.equal(o.fields.button, c.params.button, `${at}: the client's button`);
        } else {
          // A click of the stage's own (the focus click, the file input's click): inside the field, after the page's notches before it.
          const n = v.page.nodes[nodeOf(c.params) ?? c.params.objectId];
          const dy = v.out.slice(0, k).filter((x: any) => x.notches && !n.frame).reduce((a: number, x: any) => a + x.notches * x.fields.deltaY, 0);
          assert.ok(n && within(o.fields.x, [n.box.x, n.box.x + n.box.width]) && within(o.fields.y, [n.box.y - dy, n.box.y - dy + n.box.height]), `${at}: the stage's click is inside its element`);
        }
      }
      if (o.method === "Input.dispatchMouseEvent" && o.type === "mouseReleased") {
        const p = v.out.slice(0, k).reverse().find((x: any) => x.type === "mousePressed");
        assert.ok(p && p.fields.button === o.fields.button && o.fields.buttons === 0, `${at}: the release of the press before it`);
        assert.deepEqual([o.fields.x, o.fields.y], [p.fields.x, p.fields.y], `${at}: at the press's point`);
        assert.ok(o.rule === "holdMs" || o.from.startsWith("in:") || o.rule === undefined && within(o.at, [0, 1]), `${at}: the hold, or the client's later release, or at once at a dialog`);
      }
      if (o.method === "Input.dispatchMouseEvent" && o.type === "mouseWheel" && o.rest) {
        // review-122 (the lead's option b): the rest of a wheel call as one event, at the notches' point, one person's gap
        // after the last notch before it, with the sum of whole notches.
        const p = v.out[k - 1];
        assert.ok(o.notches === undefined && p?.type === "mouseWheel" && o.from === `out:${k - 1}` && o.rule === "notchGapMs" && within(o.at, F.notchGapMs), `${at}: the rest one person's gap after the notches before it`);
        assert.ok(o.fields.x === p.fields.x && o.fields.y === p.fields.y, `${at}: at the notches' point`);
        const sum = Math.abs(o.fields.deltaY) + Math.abs(o.fields.deltaX);
        assert.ok(sum > K.STAGE_NOTCH_PX && sum % K.STAGE_NOTCH_PX === 0, `${at}: the sum of whole notches`);
      } else if (o.method === "Input.dispatchMouseEvent" && o.type === "mouseWheel") {
        assert.deepEqual(o.gapMs, F.notchGapMs, `${at}: a person's gaps between notches`);
        assert.equal(Math.abs(o.fields.deltaY) + Math.abs(o.fields.deltaX), K.STAGE_NOTCH_PX, `${at}: a notch of STAGE_NOTCH_PX`);
      }
      if (o.typing !== undefined) {
        const t: string = o.typing;
        for (const ch of t) assert.ok(charKey(ch), `${at}: ${JSON.stringify(ch)} has a US key (typing rule 2)`);
        assert.ok(!/[\n\t]/.test(t), `${at}: no line feed and no tab (typing rule 2)`);
        assert.ok(t.length * F.fastKeyMs[1] <= K.STAGE_TYPE_MAX_MS, `${at}: the plan fits in STAGE_TYPE_MAX_MS (typing rule 3)`);
        const field = v.page.nodes[v.page.focused] ?? v.page.nodes[nodeOf(v.in.find((c: any) => recognizerOf(V, c) === "fill")?.params ?? {})];
        // Board ab-t30.12.1: the digits of a picker input's fill are the stage's own keys (the script calls), not a client's text.
        assert.ok(typesInto(field) || (field?.tag === "input" && PICKERS.includes(field.type)), `${at}: typed keys only into an input of a text type or a textarea (typing rule 1), or a picker input's digits (the script calls)`);
        assert.deepEqual(o.shift, [...new Set([...t].filter((ch) => charKey(ch)!.modifiers !== 0))], `${at}: a Shift for each shifted character`);
        // Board ab-t30.19: a collected part's holds are at least the client's least hold (a client's delay: the call's waitMs).
        assert.ok(JSON.stringify(o.holdMs) === JSON.stringify(F.keyHoldMs) || (o.holdMs[0] > F.keyHoldMs[1] && v.in.some((c: any) => c.waitMs === o.holdMs[0])), `${at}: the holds of keys, or at least the client's delay`);
      }
      if (o.method === "Input.dispatchKeyEvent" && o.type === "keyDown") {
        const ch = charKey(o.fields.key);
        if (ch && ch.modifiers !== 0) {
          const s = v.out[k - 1];
          assert.ok(s?.type === "rawKeyDown" && s.fields.key === "Shift" && o.from === `out:${k - 1}` && o.rule === "shiftBeforeMs" && o.fields.modifiers === 8, `${at}: a Shift press before a shifted character`);
        }
      }
      // A pass is the client's own call: only where C11 names a case of no change, a call that the stage does not take, or a recognizer that passes.
      if (o.pass) {
        const c: any = byId.get(o.for);
        assert.ok(c, `${at}: the pass of a client call`);
        if (c.method === "Input.dispatchMouseEvent" && c.params.type === "mouseWheel") assert.fail(`${at}: a wheel call gets notches, on Linux and on the Mac (board ab-t30.32)`);
        if (c.method === "Input.insertText") {
          const t: string = c.params.text;
          const field = v.page.nodes[v.page.focused];
          assert.ok(/[\n\t]/.test(t) || [...t].some((ch) => !charKey(ch)) || t.length * F.fastKeyMs[0] > K.STAGE_TYPE_MAX_MS || !typesInto(field), `${at}: an Input.insertText passes only when the typing rule refuses it`);
        }
        // A scroll into view passes only at a fallback (on the Mac too since board ab-t30.32): here the end after a round that does not move the scroller.
        const round = o.from.startsWith("out:") ? v.out[outIndex(o.from)] : null;
        if (c.method === "DOM.scrollIntoViewIfNeeded") assert.ok(round?.notches > 0 && round.for === o.for && o.at[0] >= F.scrollWaitMs, `${at}: a scroll into view passes only at its fallback`);
      }
    });
    // The wheel: n = max(0, round((|delta| + r) / 120)) notches, r the residual in the call's direction; one notch when n is 0 and r >= 0.
    for (const c of v.in.filter((x: any) => x.method === "Input.dispatchMouseEvent" && x.params.type === "mouseWheel")) {
      const items = v.out.filter((o: any) => o.for === c.id);
      const d = c.params.deltaY, sign = Math.sign(d), r = (asked - given) * sign;
      let n = Math.max(0, Math.round((Math.abs(d) + r) / K.STAGE_NOTCH_PX));
      if (n === 0 && r >= 0) n = 1;
      asked += d; given += n * K.STAGE_NOTCH_PX * sign; residual = asked - given;
      if (n === 0) assert.equal(items.length, 0, `${w} ${c.id}: no notch`);
      // review-122 (the lead's option b): the notches that the call's column lets go, then the rest as one event; both give n.
      else if (items.length === 2 && items[1].rest) assert.ok(items[0].notches >= 1 && items[0].fields.deltaY === sign * K.STAGE_NOTCH_PX && items[0].notches * K.STAGE_NOTCH_PX + Math.abs(items[1].fields.deltaY) === n * K.STAGE_NOTCH_PX && Math.sign(items[1].fields.deltaY) === sign, `${w} ${c.id}: ${n} notches, some as one event`);
      else assert.ok(items.length === 1 && items[0].notches === n && items[0].fields.deltaY === sign * K.STAGE_NOTCH_PX, `${w} ${c.id}: ${n} notches`);
      assert.ok(Math.abs(residual) < K.STAGE_NOTCH_PX, `${w} ${c.id}: the total within one notch`);
    }
    // DOM.scrollIntoViewIfNeeded on Linux and on the Mac: in view, {} with no event; else the notches that bring the middle to the middle
    // of its scroller (the viewport, or a frame's own viewport), from the scroller's position; then {} after the smooth
    // scroll's wait, or the client's call when the round did not move the scroller.
    for (const c of v.in.filter((x: any) => x.method === "DOM.scrollIntoViewIfNeeded")) {
      const n = v.page.nodes[c.params.objectId], b = n.box, f = n.frame ? v.page.frames[n.frame] : null, d = f ? (f.border ?? 0) + (f.padding ?? 0) : 0;
      const vp = f ? { width: f.box.width - 2 * d, height: f.box.height - 2 * d } : v.page.viewport, sy = f ? f.scrollY ?? 0 : v.page.scrollers?.document?.scrollY ?? 0;
      const axis = (lo: number, size: number, view: number, share: number) => (lo >= 0 && lo + size <= view) || Math.abs(lo + size / 2 - view / 2) <= (view * share) / 2;
      const inView = axis(b.x, b.width, vp.width, 0.8) && axis(b.y - sy, b.height, vp.height, 0.6);
      const items = v.out.filter((o: any) => o.for === c.id);
      const a = v.answers.find((x: any) => x.id === c.id);
      if (inView) assert.ok(items.length === 0 && a.after === "none" && isObj(a.result) && Object.keys(a.result).length === 0, `${w} ${c.id}: in view: {} with no event`);
      else {
        const want = Math.round((b.y - sy + b.height / 2 - vp.height / 2) / K.STAGE_NOTCH_PX);
        assert.ok(items.some((o: any) => o.notches === Math.abs(want) && o.fields.deltaY === Math.sign(want) * K.STAGE_NOTCH_PX), `${w} ${c.id}: ${want} notches bring the middle to the middle`);
        const passed = items.find((o: any) => o.pass);
        if (passed) assert.ok(passed.at[0] >= F.scrollWaitMs && a.after === `out:${v.out.indexOf(passed)}`, `${w} ${c.id}: the client's call after the round that did not move the scroller`);
        else assert.ok(a.rule === "scrollWaitMs" && a.at[0] >= F.scrollWaitMs && isObj(a.result), `${w} ${c.id}: {} after the smooth scroll's wait`);
      }
    }
    // Board ab-t30.12.2 (files): DOM.setFileInputFiles on Linux: the interception on, one click, the client's files to the input that the chooser names (its backendNodeId), the interception off.
    for (const c of v.in.filter((x: any) => x.method === "DOM.setFileInputFiles" && x.session !== "child" && linux)) {
      const own = v.out.filter((o: any) => o.for === c.id), set = own.find((o: any) => o.method === "DOM.setFileInputFiles");
      assert.ok(own[0]?.fields?.enabled === true && own.filter((o: any) => o.type === "mousePressed").length === 1 && JSON.stringify(set?.fields?.files) === JSON.stringify(c.params.files)
        && typeof set?.fields?.backendNodeId === "number" && own.at(-1)?.fields?.enabled === false, `${w} ${c.id}: a click with the chooser intercepted, then the client's files to the chooser's input`);
    }
    // The recognizers' effects: a hover's path before the setup, a focus click before the script focus of a text field.
    for (const c of v.in) {
      const name = recognizerOf(V, c);
      const passK = v.out.findIndex((o: any) => o.pass && o.for === c.id);
      const before = v.out.slice(0, passK);
      if (name === "hit-target check" && argOf(c.params, "actionType") === "hover") {
        const move = v.in.find((x: any) => x.id > c.id && x.method === "Input.dispatchMouseEvent" && x.params.type === "mouseMoved");
        assert.ok(before.some((o: any) => o.path?.part === "outside" && o.for === move.id), `${w} ${c.id}: the hover's samples outside the target before the setup`);
        assert.ok(v.out.slice(passK + 1).some((o: any) => o.path?.part === "inside" && o.for === move.id), `${w} ${c.id}: the rest of the path at Playwright's move`);
      }
      if (["focus", "fill", "select text"].includes(name)) {
        const n = v.page.nodes[nodeOf(c.params)];
        const clicks = before.filter((o: any) => o.for === c.id && o.type === "mousePressed");
        // Board ab-t30.12.1: the fill of a picker input gets a click on its first field (the script calls).
        const picker = name === "fill" && n?.tag === "input" && PICKERS.includes(n.type);
        assert.equal(clicks.length, isTextField(n) && !n.focused && name !== "select text" || (name === "select text" && typesInto(n) && !n.focused) || picker ? 1 : 0, `${w} ${c.id}: a focus click only for a text field with no focus, or a picker input`);
        if (picker) assert.ok(v.out.find((o: any) => o.pass && o.for === c.id)?.skipEvents === true, `${w} ${c.id}: a picker's fill goes in SKIP_EVENTS after the stage's keys`);
      }
      // Board ab-t30.12.1: a translated selectOption: one click on the select, keys, then the call in SKIP_EVENTS.
      if (name === "select option") {
        const own = before.filter((o: any) => o.for === c.id), pass = v.out[passK];
        assert.ok(own.length === 0 ? !pass.skipEvents : own.filter((o: any) => o.type === "mousePressed").length === 1 && own.some((o: any) => o.method === "Input.dispatchKeyEvent" && o.fields?.key === "Enter") && pass.skipEvents === true,
          `${w} ${c.id}: the call as the client sent it, or after a click and keys up to Enter in SKIP_EVENTS`);
      }
      // Board ab-t30.12.2: a set files call (buffers) on Linux: one click with the interception on, the files to the chooser's input, then the call with FILES_SET.
      if (name === "set files" && linux) {
        const own = v.out.filter((o: any) => o.for === c.id && !o.pass), pass = v.out.find((o: any) => o.pass && o.for === c.id);
        assert.ok(own.filter((o: any) => o.type === "mousePressed").length === 1 && own[0].method === "Page.setInterceptFileChooserDialog" && own[0].fields?.enabled === true
          && own.some((o: any) => o.method === "DOM.setFileInputFiles" && typeof o.fields?.backendNodeId === "number") && pass?.filesSet === true, `${w} ${c.id}: a click, the files to the chooser's input, then the call with FILES_SET`);
      }
      if (["retry scroll", "blur", null].includes(name) && c.method === "Runtime.callFunctionOn") {
        assert.ok(v.out.filter((o: any) => o.for === c.id).every((o: any) => o.pass && !o.skipEvents), `${w} ${c.id}: the call passes as the client sent it`);
      }
    }
  }
});

test("each stage vector's answers follow C11's rules: each call once, held until its events, an early answer only for a key release, a dialog's answer first", () => {
  const V = vectorsOrFail();
  for (const v of V.vectors) {
    const w = v.id;
    assert.deepEqual(v.answers.map((a: any) => a.id).sort((x: number, y: number) => x - y), v.in.map((c: any) => c.id), `${w}: each call gets one answer`);
    const byId = new Map<number, Record<string, unknown>>(v.in.map((c: any) => [c.id, c])); // each call is an object (the format test)
    let last = -1;
    const seen = new Set<number>();
    for (const a of v.answers) {
      const c: any = byId.get(a.id);
      const mine = v.out.map((o: any, k: number) => (o.for === a.id ? k : -1)).filter((k: number) => k >= 0);
      if (a.after === "none") {
        assert.ok(mine.length === 0, `${w} ${a.id}: an answer with no event only for a call with no event`);
        assert.ok(isObj(a.result) || a.error === "the same", `${w} ${a.id}: the stage's own result, or the plan's error`);
      } else {
        const k = outIndex(a.after);
        assert.equal(v.out[k].for, a.id, `${w} ${a.id}: after an item of its own plan`);
        assert.equal(k, Math.max(...mine), `${w} ${a.id}: a held answer comes after the last event of its call`);
        if (a.waits === undefined) { assert.ok(k >= last, `${w} ${a.id}: the answers in the order of their events`); last = k; }
      }
      if (a.mayBeEarly) assert.ok(c.method === "Input.dispatchKeyEvent" && c.params.type === "keyUp", `${w} ${a.id}: an early answer only for a key release`);
      if (a.waits !== undefined) assert.ok(seen.has(a.waits) && byId.get(a.waits)?.method === "Page.handleJavaScriptDialog", `${w} ${a.id}: Chrome's answer after the client's dialog answer`);
      if (a.error === "chrome") assert.ok(isObj(v.chrome?.errors?.[a.after]), `${w} ${a.id}: Chrome refused that event`);
      if (a.error === "the same") assert.ok(v.answers.some((x: any) => x.error === "chrome" && seen.has(x.id)), `${w} ${a.id}: the same error as the refused event`);
      seen.add(a.id);
    }
    // A client's Page.handleJavaScriptDialog goes to Chrome at once, before the tab's gate (the dialog rules).
    for (const c of v.in.filter((x: any) => x.method === "Page.handleJavaScriptDialog")) {
      const o = v.out.find((x: any) => x.pass && x.for === c.id);
      assert.ok(o && o.from === `in:${c.id}` && o.at[1] === 0, `${w} ${c.id}: the dialog's answer goes at once`);
      const opens = outIndex(v.chrome.dialog.opensAt);
      for (const k of v.out.map((x: any, i: number) => i).filter((i: number) => i > opens && v.out[i].for !== c.id)) assert.ok(within(v.out[k].at, [0, 1]), `${w} out:${k}: after the dialog, the plan's client events go at once`);
    }
  }
});

// ---- The sign-in act (board ab-v16.97.1; the stored sign-ins design, section 10) ----
// Stage 1e part 2 (board ab-v16.97.4) builds the act in the service's model, and the MCP tools come with stage 1d (board
// ab-v16.97.5): C11's part "The sign-in act" is the contract that they follow. The tests assert each sentence of the part
// exactly, and that the part holds no other text; they assert the changed sentences in the other parts of C11; and they
// check the table of what the agent sees: one result code and one text for each cause, no value of a page, and I2.

const SIGN_IN_DESIGN = readOr("docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md");
const SIGN_IN_HEADING = "The sign-in act (from stage 1e; the stored sign-ins design, board ab-v16.95).";
// Every sentence of the part, in order (a list item and a table row are one item). The part holds exactly these.
const SIGN_IN_ITEMS: string[] = [
  "**The sign-in act (from stage 1e; the stored sign-ins design, board ab-v16.95).** The design is `docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md`, sections 4, 7 and 8, with the operator's answers of 2026-11-10 (board item ab-8w8: Q1 a, Q2 b, Q3 b, Q4 a). The service's model builds the act in stage 1e part 2 (board ab-v16.97.4), off by default, and it serves sessions from stage 3. The store, its ops and the act's events are C12's (the stored sign-ins). The relay has no sign-in act: it refuses both methods as calls outside its set (`Not available in the agent browser: <method>.`). On the Mac the store and the act stay off until stage 4 (board ab-v16.97.14). The Mac memory probe (board ab-v16.97.8, 2026-11-25) read two Node processes of its own, of the same file as the service's Node, while DevToolsSecurity was disabled: `task_for_pid` and `task_read_for_pid` of the same user got no port; Apple's `vmmap` and `leaks` got a read port, but no leaks graph held the probe's marker; `leaks --fullContent` refused the writable contents (\"restricted\"); and the probe skipped lldb. On the Mac the service makes its protected start (C12, the stored sign-ins: the protections) and only logs the result.",
  "What the act does. An agent asks for a sign-in by the name of a credential that the operator stored. The service types the credential's username and password into a tab of its own that no client can reach, and moves the sign-in's cookies and `localStorage` into the default context. No answer, event, status or log line holds a username, a password or a form value.",
  "The entry.",
  "CDP: `AgentBrowser.signIn` with `{\"name\":\"<name>\"}` and `AgentBrowser.signIns` with `{}`, on the root session or on a browser session of the agent door. The model answers both (where each call goes, above). On a page session the model refuses both with `Not available in the agent browser: <method>.`, and they never reach Chrome. Playwright sends them on a browser CDP session: `const s = await browser.newBrowserCDPSession(); await s.send(\"AgentBrowser.signIn\", { name: \"staging\" })`.",
  "The CLI: `agent-browser sign-in <name>` and `agent-browser sign-ins`, and `agentwatch browser sign-in <name>`, a thin wrapper. They send the method over the agent door, so the walk gives the scope.",
  "The MCP: the service's own tools `browser_sign_in` (`name`) and `browser_sign_ins` (no argument), of the allow list's `service_tools` (board ab-v16.97.5). The MCP path's transport answers them itself, and a call of either never reaches the MCP's code. The service runs them as the method for the MCP session's scope, only for a request that the MCP port admitted with the uid check and the walk (a local admission), and only while the service has the act. A request that a remote token admitted (stage 5: the token design, section 10) gets a `tools/list` without them, and a call of either name gets the refusal of check 1.",
  "The admission of each request on the MCP path. The MCP port admits each connection by steps 1 and 2 (the uid check and the walk), and it gives each request of the connection that passes steps 3 to 8 to the transport with the word `local`. The transport takes only that word as a local admission: a request with no word is remote, so a new path to the transport fails closed. The transport reads the word at each request, not at the MCP session's `initialize`. The MCP port admits no request by a remote token: a remote request comes only through the carrier (the remote MCP path), which gives the word `remote`. For the live check, the service's `--test` mode takes `--test-mcp-remote-scope <scope>` with `--test-mcp-port`: the port gives each request of that one scope the word `remote`. It takes rights away only: steps 1 to 8 still run.",
  "A remote admission on the MCP path. The transport gives a call of either tool at once to the act's method with the admission `remote` and no argument of the client, and the act's check 1 refuses it with its text, whatever its arguments. So the call opens no window, and it reads no name and no credential. A call of `browser_sign_in` sends check 1's one refusal `end` with the result `remote` (C12: an act id of its own, no `start`, within the rate of the refusal ends) and gets the act's log line. A call of `browser_sign_ins` sends no event, as `AgentBrowser.signIns` sends none. While the service has no act, the transport gives check 1's text itself, with no event. The call passes no browser gate, and it is no use (C12). The MCP path also logs `mcp: MCP session <n> (scope <scope>): a tools/call of <tool> refused (a remote admission)`.",
  "A local admission on the MCP path. A call of either tool is a tool call of its MCP session: it passes the browser gate first (the start at a use), and it counts as a use until the act's method ends, also after its client has gone. A cancel while the call waits at the browser gate ends the call: its id is free at once, its POST gets the cancelled answer, and no act starts. A call whose client leaves during that wait starts no act either. Once the act's method runs, no cancel stops it: a `notifications/cancelled` of the call then changes nothing, its id stays busy, and its POST gets the act's answer. While the service has no act (the Mac until stage 4, and a service with no store, native link, lists or Chrome unit), a `tools/list` holds neither tool, and a call of either gets the allow list's `-32601` answer.",
  "What the MCP tools give: a tool result with one text item. `browser_sign_in` gives the success's text (what the agent sees, below), made from the record's origin alone, or on a refusal a tool error (`isError: true`) with the text `Not signed in: <text>`. `browser_sign_ins` gives the answer of `AgentBrowser.signIns` as compact JSON, `{\"state\":\"<state>\",\"signIns\":[{\"name\":\"<name>\",\"origin\":\"<origin>\"}]}`, with no other field. Another exception of the act gets the MCP path's fixed 500 (`The agent browser could not answer this request.`), which echoes nothing.",
  "`AgentBrowser.signIns` answers the store's state and the names and the origins that the caller's scope may use (checks 2 and 3, below): `{\"state\":\"none\"|\"locked\"|\"open\",\"signIns\":[{\"name\":\"<name>\",\"origin\":\"<origin>\"}]}`. Names and origins are not secrets. It refuses only by check 1, and it sends no `sign_in` event (C12).",
  "The checks before the act, in this order. The first check that fails gives its text (what the agent sees, below), and no act starts.",
  "The request came by a local admission: the agent door (the kernel's peer check and the walk), or the MCP port with the uid check and the walk. A request on the MCP's ticket connection to the endpoint has the admission of its MCP session. A request that a remote token admitted never reaches a later check. The agent browser is ready (the readiness, before the upgrade).",
  "The last `sign_ins` (C12) holds a record of that `name` whose `approved` is `true`, and the scope's list covers the record's host. With the answer Q2 b, each scope whose list covers the host may use the credential: a credential names no repos. No such name, a name whose host the scope's list does not cover, and an offer that waits get the same text. Two approved records of one name in the last `sign_ins` each break (C12, names and ids), so check 2 finds neither of them, and the request gets that text too (C12's vector `checkTwo`).",
  "The scope's list covers each host of the record's `send_to`.",
  "The store is open (C12).",
  "The record opens: its seal's tag holds with its plain fields as the additional data, so its `approved` is `true` in the seal too; its `gen` is not lower than the highest `gen` that the service saw for its `id`; and its `id` is not a removed id.",
  "The credential is not stopped, and fewer than 6 of its acts started in the last hour.",
  "No other act and no PageFetch runs: the act and PageFetch share the one private window (PageFetch, above). An act waits for the window at most 60 s, and, when a fetch holds the window at the act's request, also that fetch's longest hold (80 s): an act waits for a running fetch and never fails because of it (the daemon lead's rule); a waiting act gets the window before every waiting fetch. A request that waited is checked again at its turn: checks 4, 5 and 6 run again before the act starts, and the record's values open only then, so a stop of the credential or the hour's last act by an act before it, or a lock during the wait, refuses it as a check before the act does.",
  "The act is a use for the start and the stop by use (board ab-v16.94.11): an act that finds Chrome down starts it, and Chrome does not stop while an act runs.",
  "A request that a check refuses is no act: it counts for none of the hour's limit of 6, the acts of C12's `status` and the results in a row of the lockout guard (below). It sends one `end` event with an act id of its own and no `start` (C12, the stored sign-ins), within the rate of the refusal ends: at most 10 for one scope in any 60 s; past that, one a minute, which carries `dropped`, the number that did not go (C12). Each refused request still gets its answer and its log line.",
  "The act window and its context.",
  "The receiver opens the act window with C10's `windows.create`, `incognito: true`, `focused: false` and the mark of an act (the receiver's part of the stored sign-ins, board ab-v16.97.3), with the caller's scope for the list rules (C4, C5), at `about:blank`, held as C10 says. The act starts only with a receiver whose hello's `features` hold `act` (C4): the service tests for membership in the list, never for equality, so a receiver with more features has the act. With no such receiver, or when the receiver opens no incognito window, the act ends with no window. The window has an incognito browser context of its own. It shares no cookie, storage, Cache Storage, service worker, `BroadcastChannel`, HTTP cache or history with the default context, and Chrome drops it when its last window closes. The act tab also bypasses service workers (`Network.setBypassServiceWorker`).",
  "One act context at a time. Before an act the receiver closes an act window that a crash left. The act refuses while another incognito window is open.",
  "The model marks each act tab, and a popup of an act tab is an act tab. No connection sees an act tab, attaches it or gets an event of it. The model keeps every incognito tab (the act's tabs and the operator's private tabs) from every client: each event and read that C10 still gives of one (its list N4: `tabs.onCreated`, `tabs.onUpdated`, `tabs.onRemoved`, `tabs.onReplaced`, `webNavigation.onCreatedNavigationTarget`, `webNavigation.onErrorOccurred`, `downloads.onCreated` and `downloads.onChanged`, the answers of `tabs.get`, `tabs.query`, `windows.get` and `debugger.getTargets`, and the act tab's `debugger.onEvent` and `debugger.onDetach`, which carry the typed values) goes to the act only, also a `bridge.tabScope` or a `bridge.tooLarge` of one; a download of one never joins a client's download; and a window that holds one is in no window lookup. `Target.getTargets` leaves it out; no `Target.targetCreated`, `Target.targetInfoChanged`, `Target.targetDestroyed`, `Target.attachedToTarget` or `Target.detachedFromTarget` of it goes to a client; a client's `Target.setAutoAttach` attaches nothing of it; and each call with its target id gets `No target with given id found`. Its window is in no window lookup: `Browser.getWindowForTarget` with its id gets `No target with given id found`, and `Browser.getWindowBounds` and `Browser.setWindowBounds` with its window id get `Browser window not found` (the refusals, above). No client's screenshot, recording or close reaches it.",
  "The service attaches its own session to the act tab, inside its own process. No socket carries that session. The act tab is new: a new document in a new context, with no opener and no window name, and no client has a script, a binding or an init script in it.",
  "Before the sign-in page loads, the service moves the act window at the X level to the right of the screen's area: it gives the act tab's `about:blank` page a title of its own, a new random value for each act that the service sets (`aw-act-` and 8 random bytes in hex; the X move takes no title of another form), and moves each X window with that title. It types no key until `windows.get` reports the window outside the screen (no pixel of it on the screen). An act popup is a tab whose opener is a tab of the act (the `openerTabId` of its `tabs.onCreated`, or C10's `webNavigation.onCreatedNavigationTarget` with a tab of the act as its source), or the added tab of an act popup's `tabs.onReplaced`; another incognito tab (an operator's private window) is no act popup, and the act moves nothing of it. The service attaches its own session to each act popup, with `Fetch` (the guard, below) and `Network` (its blocked requests count). An act popup that opens before the password's last key ends the act, so no key goes after the service learns of the popup: the act reads that again at once before each key. An act popup whose session, `Network` or `Fetch` fails ends the act too, also after the password's last key. An act popup in a window of its own moves off the screen by a title of its own in its page, a new random value for each act popup of the same form, never by the bounds of a window (`windows.update` refuses an act popup's window); a popup's window that is not outside the screen within 2 s ends the act.",
  "From the act's start to its end, agentwatch's live view sends no frame of the display to a viewer and plays no input from one (C12's `sign_in` event).",
  "The fallback. When the incognito window cannot be had, the act can run in a window of the default context, with the service-worker bypass, and the model freezes each client tab of the credential's origin during the act (`Page.setWebLifecycleState` with `frozen`). An agent's tab of that origin then still shares its storage, Cache Storage and `BroadcastChannel` with the act tab, and the Browser pane says so. The fallback is a build decision only for that case; stage 1e part 2 (board ab-v16.97.4) builds none: with no incognito window the act ends with no window.",
  "The form rules. The service reads the page only in an isolated world of its own (`Page.createIsolatedWorld`).",
  "The service navigates the act tab to the record's `origin` and `path`. After the load, the main frame's origin must be the record's exact origin.",
  "The main frame has exactly one visible, enabled password field. With two or more the act ends. With none and exactly one visible username field, the sign-in has two steps (rule 5).",
  "The username field is the visible text, email or tel field before the password field in its form; a field with `autocomplete=\"username\"` or `type=\"email\"` comes first. A credential with an empty username skips it.",
  "When the password field is in a `<form>`, the form's method is `post` and its action's origin is in `send_to`. This check comes before the first key. A password field with no `<form>` (a sign-in by script) goes on, with the block and the guard as its checks.",
  "A sign-in in two steps: the act fills the username, submits, waits for the next page, and applies rules 1 to 4 again. At most one such step.",
  "The act tab's `Network` domain is on from the navigation of rule 1. At the first key, a WebSocket or a WebTransport session of the page to a host outside `send_to` that is still open ends the act.",
  "The type watch. Before the first key, the service puts a `MutationObserver` on the password field's `type` attribute in its isolated world. When the type changes, the observer empties the field in its own callback, and the act ends.",
  "The first build reads only the main frame: a sign-in form in a frame gets the text of no form.",
  "The fill and the submit.",
  "The service takes the input lock of the browser (the input design, section 4.4) for its clicks and keys, and a client's input calls wait for it: with the input stage on, the stage's lock; with it off, a step of the activation chain, which each client input that starts an action waits for.",
  "It clicks each field and types its value with the person's input of the input design: the generator's keys when each character has a key on the US layout and the plan at the person's speed fits in 10 s (a value of at most about 40 to 50 characters), else one `Input.insertText`, as a password manager's fill does. The act never types a value at the fast end of the person's spread: the operator's answer on board item ab-2qb (the typing rule's rule 3, in the input stage) covers the act too (review-126b note 1). The act never uses the clipboard (the input stage, the paste). The values reach Chrome only in the act tab's `Input` calls, over the native link.",
  "It submits as a person does: a click on the form's visible submit button, else Enter in the password field.",
  "The block and the guard.",
  "From the first key to the act's end, the receiver holds the act's session rules (C5, rules A to E of the receiver's part of the stored sign-ins). They block each request of the act tab, of its popups and of the site's workers to a host outside `send_to`, every resource type, the WebSocket included, except a top-level GET. The act types no key until the receiver confirms the rules, and the receiver removes them at the act's end, also after a failure.",
  "The guard. The service keeps `Fetch` on in the act tab and in each act popup that its session holds, for every URL, at the request stage. It fails (`Fetch.failRequest` with `BlockedByClient`) a request whose URL holds the password, on any origin, and a request to an origin outside `send_to` whose body holds the password or whose body Chrome does not give. It looks for the password in five forms: plain, URL-encoded, JSON-escaped, base64 and base64url. Every other request continues unchanged. A paused request whose event was too large for the link (C10's `bridge.tooLarge`) fails: the guard cannot read it.",
  "A blocked or failed request does not end the act. No event, prompt, report or log line names its host, because a host that the page chooses can carry the password: the `end` event and the act's log line give only the number of requests that the block stopped (in the act tab and in each act popup that the service's session holds) and the number that the guard stopped. A block of the list rules (C4, C5) in an act tab or its popups makes no blocked-site prompt and no blocked report that names its host: the service counts it with the requests that the block stopped.",
  "Not stopped, stated plainly: a send to an origin of `send_to` (any path, a hash, an encryption, a compression, a part of the value, a WebSocket); a service worker's WebSocket to a subdomain or another port of a `send_to` host; a top-level GET of an act tab or an act popup to a host on the scope's list with a changed or partial value; the requests of an act popup before the service's session holds its `Fetch` (its first navigation among them), so a popup that the page opens after the password's last key, or in the moment before the service learns of it, can send a GET with the whole value to a host on the scope's list; DNS prefetch and preconnect; and WebRTC.",
  "The outcome. The act watches the act tab for at most 30 s after the submit.",
  "Signed in: the main frame commits a new page or its URL changes, and after 1 s with no navigation the main frame has no visible password field. A final host that the scope's list does not cover ends the act (C4 and C5 block it); an error page of a blocked navigation, and `about:blank` (where the list's guard sends a page off the list), count as such a host.",
  "Not accepted: a visible password field is still there after that 1 s.",
  "A second factor: a visible field for a code and no password field: `autocomplete=\"one-time-code\"`, or an input whose name or id holds `otp`, `totp`, `2fa`, `mfa` or `code` and whose `maxlength` is 4 to 10. The act fills nothing there (the answer Q4 a).",
  "Timeout: none of these in 30 s.",
  "The lockout guard. Three results in a row of not accepted, timeout or a second factor stop the credential, until the operator's \"Start again\" in the Browser pane (C12's `sign_in_start_again`). A signed-in result sets the count to zero, and each other result leaves it as it is. At most 6 acts of one credential start in one hour, whatever their results. The service keeps the count, the stop and the hour's acts in its state file (C12), so a restart of the service does not clear them.",
  "The clean end and the move, in this order, also after a refusal in the middle of the act:",
  "The service empties each input of the main frame.",
  "Only after signed in: the leak check, then the move. The service reads the act context's cookies of the credential's host and its subdomains, and the origin's `localStorage`. The service reads the `localStorage` only from a page on the credential's origin; from another origin the move holds no `localStorage` item. When a cookie value or a `localStorage` key or value holds the password in one of the five forms, the act makes no move. Else the service builds a C2 payload: `domain` the credential's host, `origin` its origin, `url` the origin with the path `/`, the cookies of the host and its subdomains, `storage.local` the `localStorage` items, and `storage.session` and `storage.idb` empty. It checks the payload as stage 1c checks an import (the C2 rules and the box's own sign-in rule), and gives it to the receiver's `import` (C4, C6). This is the import's code path inside the service, not C12's op `import`. C6's import closes each tab of the default context whose origin is the credential's origin, and replaces the host's cookies.",
  "It clears the tab's history (`Page.resetNavigationHistory`).",
  "It turns `Fetch` off and sends C4's `act_end`: the receiver closes each tab of the act (the act window and its popups), then removes the act's rules; the service closes no window itself. Chrome drops the act's context with its last window. An act whose `act_rules` failed or came late sends `act_end` too, and so does an act whose `windows.create` got no answer in time; an act that opened no window sends none. An `act_end` that fails goes once more after 500 ms; after a second failure the service logs it, and the next act window or the receiver's start ends the act (C10).",
  "It fills the buffers of the values with zeros, and drops the opened record.",
  "What the agent sees.",
  "Success: the answer `{\"signedIn\":true,\"name\":\"<name>\",\"origin\":\"<origin>\"}`. The CLI and the MCP tool give the text `Signed in to <origin>. Your tabs of this site were closed for the sign-in; open the site again: it loads signed in.`",
  "A refusal: the CDP error `{\"code\":-32000,\"message\":\"Not signed in: <text>\"}`, with one text of the table below. The CLI prints it and exits with 1, and the MCP tool gives it as its error. The result is the code in C12's `end` event and in the log line. `<name>` is the asked name (as a JSON string when it is not a string that matches the scope pattern, and `null` for a request with no `name`), `<host>` is the host that the list does not cover, and `<origin>` is the record's origin. A link that goes down during the act ends it with the result `not_ready` and the readiness's text of that moment.",
  "| The cause | The result | The text |",
  "| Signed in | `signed_in` | the success above |",
  "| A remote admission (check 1) | `remote` | `Stored sign-ins work only for sessions of this box.` |",
  "| Not ready (check 1) | `not_ready` | the 503 body of the readiness, for example `The agent browser is not ready: its extension is not connected.` |",
  "| No such name for the scope (check 2) | `no_such_name` | `There is no stored sign-in named <name> for this repo.` |",
  "| A host of `send_to` that the list does not cover (check 3) | `not_allowed` | `Not allowed: <host> is not on the allowlist` |",
  "| Locked (check 4) | `locked` | `The stored sign-ins are locked. The operator unlocks them in the Browser pane.` |",
  "| The record (check 5) | `cannot_open` | `The stored sign-in cannot be opened. The operator adds it again.` |",
  "| Stopped (check 6) | `stopped` | `The site did not accept this stored sign-in three times. The operator checks it in the Browser pane.` |",
  "| The hour's limit (check 6) | `hour_limit` | `This stored sign-in was used often in the last hour. Try again later.` |",
  "| Busy for 60 s (check 7) | `busy` | `Another sign-in runs now. Try again in a minute.` |",
  "| Another private window | `private_window` | `Another private window is open in the agent browser.` |",
  "| Another origin (form rule 1) | `other_origin` | `The sign-in page is on another origin than the stored sign-in names.` |",
  "| More than one password field (form rule 2) | `password_fields` | `The page has more than one password field.` |",
  "| No form (form rule 2, or a form in a frame) | `no_form` | `There is no sign-in form that the agent browser can fill.` |",
  "| The form's target (form rule 4) | `form_target` | `The sign-in form sends to another place than the stored sign-in names.` |",
  "| An open connection (form rule 6) | `open_connection` | `The sign-in page keeps a connection to another site open.` |",
  "| The type watch (form rule 7) | `type_watch` | `The page showed the password field as text, so the agent browser ended the sign-in.` |",
  "| The act's rules | `rules` | `The agent browser could not hold the sign-in's rules.` |",
  "| The window | `window` | `The agent browser could not move the sign-in window off the screen.` |",
  "| An act popup before the last key | `popup` | `The sign-in page opened another window, so the agent browser ended the sign-in.` |",
  "| No act window (no feature `act`, no incognito window) | `no_window` | `The agent browser could not open the sign-in window.` |",
  "| Not accepted | `not_accepted` | `The site did not accept the stored sign-in.` |",
  "| A second factor | `second_factor` | `The site asks for a second factor. The agent browser cannot answer it: ask the operator.` |",
  "| A host on no list | `off_list` | `The site went to a host on no list after the sign-in.` |",
  "| Timeout | `timeout` | `The site did not finish the sign-in in 30 s.` |",
  "| The act tab is gone (its session ended, it closed or was replaced, or a call of the act failed) | `lost` | `The agent browser lost the sign-in window before the sign-in finished.` |",
  "| A leak of the site | `leak` | `The site keeps the password where its pages can read it, so the agent browser did not keep the sign-in.` |",
  "| The move | `move` | `The sign-in worked, but the agent browser could not move it to your tabs.` |",
  "No text holds a value of the page: a site's own error text can name the username, so the act never passes it on. No text names a stop or a start of the agent browser (I2).",
  "During and after the act.",
  "During the act each call on the agent's own tabs works as before, and its input calls wait for the input lock while the act types and clicks. The agent's own tabs of the site, in the default context, share nothing with the act's context.",
  "After the act the move has closed the agent's tabs of the credential's origin. The agent opens them again, and they load signed-in pages. The act window, its context and its history are gone.",
  "A site that keeps its sign-in in one tab's `sessionStorage` or in IndexedDB gives the agent's tabs no sign-in in the first build.",
  "The log. The service logs one line for each request of `AgentBrowser.signIn`: the user, the scope, the session's `repo`, the act id, the credential's id and name, the origin, the result, the time that it took, the number of requests that the block stopped and the number that the guard stopped. A refusal by check 1 or 2 names no credential. The move logs stage 1c's import line (counts only), and it sends no `error` event: that event is the op `import`'s (C12), and the act's `end` event gives the move's result. No log line holds a username, a password, a form value, a page's text, a URL path, a query or the host of a request that the block or the guard stopped.",
  "The limits, stated plainly.",
  "The move puts the sign-in's session into the one default context, so each scope whose list covers the host gets the signed-in pages (what one profile shares between scopes, above). The answer Q2 decides who may start a sign-in, not who rides the session after it.",
  "A site's own pages can show the username after the sign-in.",
  "A program of the user with the display's X authority can read the display and the act window's title, move the window back onto the screen, and send it input.",
  "A hostile process of the same OS user can replace the service and wait for the operator's next unlock (the limits of the MCP path's admission, above).",
];

// Board ab-v16.97.8, part 2 (the Mac's protected start; aw-lead's OK before the merge): the changed text of the sign-in
// act's part, exactly, and the old text is gone. The old and new texts go to aw-lead with the PR.
const MAC_PROTECTED_START_C11 = [
  { old: "On the Mac the store and the act stay off until stage 4 measures whether another program of the same user can read the service's memory.", text: "On the Mac the store and the act stay off until stage 4 (board ab-v16.97.14). The Mac memory probe (board ab-v16.97.8, 2026-11-25) read two Node processes of its own, of the same file as the service's Node, while DevToolsSecurity was disabled: `task_for_pid` and `task_read_for_pid` of the same user got no port; Apple's `vmmap` and `leaks` got a read port, but no leaks graph held the probe's marker; `leaks --fullContent` refused the writable contents (\"restricted\"); and the probe skipped lldb. On the Mac the service makes its protected start (C12, the stored sign-ins: the protections) and only logs the result." },
];
test("board ab-v16.97.8 part 2: C11's sign-in act gives the Mac memory probe's result and the Mac's protected start; the store and the act stay off on the Mac until board ab-v16.97.14", () => {
  const p = partOr(SIGN_IN_HEADING);
  for (const c of MAC_PROTECTED_START_C11) {
    assert.ok(says(p, c.text), `C11 says: ${c.text}`);
    assert.ok(!says(C11, c.old), `the old text is gone: ${c.old}`);
    assert.ok(SIGN_IN_ITEMS[0].endsWith(c.text), "the part's first item ends with it");
  }
  // The review's I1 and the re-check's m1 and m3: the texts claim only what the probe's data shows (its own Node
  // processes of the service's file; vmmap and leaks got a read port; only the leaks graphs were searched for the marker;
  // lldb skipped), never a stronger claim: not C11's part, not C12, not the design and not protect.ts's head.
  const texts = { "C11's part": p, C12: readOr("docs/contracts/C12.md"), "the design": SIGN_IN_DESIGN, "protect.ts": readOr("src/service/signins/protect.ts") };
  for (const [name, t] of Object.entries(texts)) {
    assert.ok(t.length > 0, `${name} is read`);
    for (const claim of ["no reader of the same user", "got the writable memory", "asks for a password", "no output held the probe's marker"]) assert.ok(!says(t, claim), `${name}: no claim: ${claim}`);
  }
  assert.ok(says(SIGN_IN_DESIGN, "no leaks graph held the probe's marker") && says(texts["protect.ts"], "no leaks graph held the probe's marker"), "the design and protect.ts say the narrow claim");
});

test("C11's part on the sign-in act holds exactly its sentences, and only the card payment's part comes after it", () => {
  const p = partOr(SIGN_IN_HEADING);
  for (const s of SIGN_IN_ITEMS) assert.ok(says(p, s), `C11 says: ${s}`);
  assert.equal(clean(p), SIGN_IN_ITEMS.join(" "), "the part holds no other text");
  const at = C11.indexOf(`**${SIGN_IN_HEADING}`);
  // Board goal ab-sta: the card payment's part (CARD_PAY, at the end of this file) is the last part of C11.
  assert.ok(C11.indexOf("**How a session gets the MCP (from stage 2;") < at && C11.indexOf("\n**", at + 2) === C11.indexOf("\n**The card payment (board goal ab-sta;"), "the part comes after how a session gets the MCP, before the card payment");
  assert.ok(p.split("\n").every((l) => (l.match(/`/g) ?? []).length % 2 === 0), "no code span over a line break");
  assert.ok(!/\/home\//.test(p), "no box path");
});

// The changed sentences of the sign-in design's section 10 in the other parts of C11.
const SIGN_IN_CHANGED: Record<string, string[]> = {
  "The self-contained agent browser (board ab-v16.94).": [
    "| The sign-in act (`AgentBrowser.signIn`, `AgentBrowser.signIns`), the act window and its context (the sign-in act, below) | agent-browser's service | stage 1e builds it, off by default; it serves sessions from stage 3 |",
    "The row of the sign-in act comes from the stored sign-ins design (`docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md`, board ab-v16.95, section 10) and the operator's answers of 2026-11-10 (board item ab-8w8).",
  ],
  "Where each call goes.": [
    "The model answers the calls of its set (two-modes design, section 4.3) on the root session and on a browser session (`Target.attachToBrowserTarget`), and `AgentBrowser.signIn` and `AgentBrowser.signIns` (the sign-in act, below).",
    "| `AgentBrowser.signIn` | the model | refused |",
    "| `AgentBrowser.signIns` | the model | refused |",
  ],
  "The scope, and one connection per tab.": [
    "Every other tab is in no scope, and no connection sees it: the operator's tabs, the restore tab of an import, a tab that the receiver's map does not hold. An act tab of the sign-in act is in its caller's scope for the list rules, but no connection sees it, attaches it or gets an event of it; a popup of an act tab is an act tab.",
    "There is one browser context. Every target has `\"browserContextId\":\"agentwatch-default\"`, also in the answers and events from Chrome that the model passes on. The sign-in act's window is in an incognito context of its own; no answer and no event of any client holds it or its tab.",
  ],
  "Permissions and content settings.": [
    // Board ab-t30.19: a sentence with no text before (the paste rule 3).
    "With the stage on, while a connection holds a grant of `clipboard`, the input stage pastes nothing (the input stage, the paste).",
    "What one profile shares between scopes, stated plainly: a content setting is per origin pattern and acts on the whole profile, so a grant of one scope applies to another scope's tab on the same host; the sent sign-ins (cookies, storage, workers) and the sessions that the sign-in act moves into it are in the profile for every scope; only navigation is guarded per scope.",
  ],
  "Refusals.": [
    "| A tab of another scope, an act tab of the sign-in act, or no such tab | `Target.attachToTarget`, `Target.closeTarget`, `Target.activateTarget`, `Target.getTargetInfo`, `Browser.getWindowForTarget` | `No target with given id found` |",
    "| A window with no tab of the scope, or the sign-in act's window | `Browser.getWindowBounds`, `Browser.setWindowBounds` | `Browser window not found` |",
  ],
  "The limits of the MCP path's admission (from stage 1d; the self-contained design, sections 8.3 and 18, M2).": [
    "A token works only from its own session, and it ends with the session. The stored sign-ins do not change this: such a process can replace the service and wait for the operator's next unlock, or use the display's X authority during an act.",
  ],
};
const SIGN_IN_GONE = [
  "(`Target.attachToBrowserTarget`). Every other call there is refused",
  "| A tab of another scope, or no such tab |",
  "| A window with no tab of the scope |",
  "the sent sign-ins (cookies, storage, workers) are in the profile for every scope",
  "Tools and argument keys pass only through the allow list (`docs/contracts/mcp-allow-list.md`).",
  "a cookie, a URL path or a payload, and a request that the service refuses",
];

test("C11 states the changed rules of the sign-in act in their parts: the part table, where each call goes, the scope and the context, what one profile shares, the refusals, the MCP's tools and log, and the limit", () => {
  for (const [heading, list] of Object.entries(SIGN_IN_CHANGED)) sayAll(partOr(heading), list);
  for (const s of SIGN_IN_GONE) assert.ok(!says(C11, s), `C11 no longer says: ${s}`);
  // The two methods route as the table says: the model on the root, refused on a page session.
  for (const m of SIGN_IN_METHODS) assert.deepEqual([route("root", m, {}, false, true), route("page", m, {}, false, true)], ["the model", "refused"], m);
});

// review-112: the sentences of the fix round in C11's part, and the old ones gone (B1, B2, B3, B4, the ticket connection,
// a request with no name, the move's error event, the lockout's other results).
test("C11 states the fixes of review-112: the Network domain from the navigation, no host of a blocked request, a refusal is no act, Start again's op, the ticket connection, a request with no name, and the move's error event", () => {
  sayAll(partOr(SIGN_IN_HEADING), [
    "The act tab's `Network` domain is on from the navigation of rule 1.",
    "No event, prompt, report or log line names its host, because a host that the page chooses can carry the password: the `end` event and the act's log line give only the number of requests that the block stopped (in the act tab and in each act popup that the service's session holds) and the number that the guard stopped.",
    "A block of the list rules (C4, C5) in an act tab or its popups makes no blocked-site prompt and no blocked report that names its host: the service counts it with the requests that the block stopped.",
    "A request that a check refuses is no act: it counts for none of the hour's limit of 6, the acts of C12's `status` and the results in a row of the lockout guard (below). It sends one `end` event with an act id of its own and no `start` (C12, the stored sign-ins), within the rate of the refusal ends: at most 10 for one scope in any 60 s; past that, one a minute, which carries `dropped`, the number that did not go (C12). Each refused request still gets its answer and its log line.",
    "until the operator's \"Start again\" in the Browser pane (C12's `sign_in_start_again`). A signed-in result sets the count to zero, and each other result leaves it as it is.",
    "A request on the MCP's ticket connection to the endpoint has the admission of its MCP session.",
    "`<name>` is the asked name (as a JSON string when it is not a string that matches the scope pattern, and `null` for a request with no `name`)",
    "The move logs stage 1c's import line (counts only), and it sends no `error` event: that event is the op `import`'s (C12), and the act's `end` event gives the move's result.",
    "It refuses only by check 1, and it sends no `sign_in` event (C12).",
  ]);
  for (const s of [
    "The `end` event names the host of each one, never its path.",
    "and the host of each request that the block or the guard stopped",
    "A request that check 1, 2 or 3 refuses is no act: it sends no event",
  ]) assert.ok(!says(C11, s), `C11 no longer says: ${s}`);
  // review-112b: the routing text names the refusal of every other AgentBrowser.* call on a page session, as route() does.
  assert.ok(says(C11, "- Every other `Browser.*`, `Target.*` or `AgentBrowser.*` call on a page session is refused, as on the root."), "C11 names AgentBrowser.* on a page session");
  assert.ok(!says(C11, "- Every other `Browser.*` or `Target.*` call on a page session is refused, as on the root."), "the old routing sentence is gone");
  // board ab-t30.22: the client's mark of a secret, the one AgentBrowser.* call that the model answers on a page session.
  assert.ok(says(C11, "- Every other `Browser.*`, `Target.*` or `AgentBrowser.*` call on a page session is refused, as on the root. The one exception is `AgentBrowser.setSecretInput` on the tab's own page session, the client's mark of a secret, which the model answers (the input stage, the paste)."), "C11 names the mark's exception");
});

// The table of what the agent sees: the cause, the result (C12's `end` event and the log line) and the text.
function actTable() {
  const lines = C11.split("\n");
  const at = lines.indexOf("| The cause | The result | The text |");
  assert.ok(at >= 0, "C11's table of what the agent sees");
  const rows: { cause: string; result: string; texts: string[] }[] = [];
  for (const l of lines.slice(at + 2)) {
    if (!l.startsWith("| ")) break;
    const [cause, result, text] = l.slice(2, -2).split(" | ");
    rows.push({ cause, result: /^`([a-z_]+)`$/.exec(result)?.[1] ?? result, texts: [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]) });
  }
  return rows;
}

test("the sign-in act's table: one result and one text for each cause, the design's texts, no value of a page, no stop or start (I2), and C11's own texts where it reuses them", () => {
  const rows = actTable();
  const results = rows.map((r) => r.result);
  assert.equal(new Set(results).size, rows.length, "one result for each cause");
  for (const r of results) assert.match(r, /^[a-z_]+$/, r);
  assert.equal(results[0], "signed_in", "the success first");
  assert.deepEqual(rows[0].texts, [], "the success's text is above the table");
  const texts = rows.slice(1).map((r) => r.texts[0]);
  assert.equal(new Set(texts).size, texts.length, "one text for each cause");
  for (const t of texts) {
    assert.doesNotMatch(t, /\b(stop|stops|stopped|start|starts|restart)\b/i, `I2: ${t}`);
    for (const ph of t.match(/<[a-z]+>/g) ?? []) assert.ok(["<name>", "<host>"].includes(ph), `${t}: only the asked name or a host of the record`);
  }
  // The texts of the design's section 7.9 (board ab-v16.97.4 brought its type watch's text to C11's: it names no stop, I2).
  const design = SIGN_IN_DESIGN.slice(SIGN_IN_DESIGN.indexOf("### 7.9"), SIGN_IN_DESIGN.indexOf("### 7.10"));
  for (const r of rows.slice(1)) if (r.result !== "not_ready") assert.ok(design.includes("`" + r.texts[0] + "`"), `the design's text: ${r.texts[0]}`);
  assert.equal(rows.find((r) => r.result === "type_watch")!.texts[0], "The page showed the password field as text, so the agent browser ended the sign-in.");
  // Reused texts are C11's own: the readiness's 503 body, and the refusal off the scope's list.
  const bodies = new Set(endpoint.upgradeAnswers.map((a) => a.body));
  assert.ok(bodies.has(rows.find((r) => r.result === "not_ready")!.texts[0]), "the readiness's body");
  assert.ok(endpoint.templates.includes(rows.find((r) => r.result === "not_allowed")!.texts[0]), "C11's text off the list");
  // Every cause of the design's table has a row (its row "the form" has three texts: three rows here).
  // Board ab-v16.97.4 adds two causes, in C11 and the design: no act window (`no_window`) and a lost act tab (`lost`).
  assert.equal(rows.length, 1 + 25 + 2, "the success, the design's 25 rows, and two more rows for the form's three texts");
  for (const r of ["no_window", "lost", "popup"]) assert.ok(rows.some((x) => x.result === r), r);
  // The success's text and the refusal's form.
  sayAll(partOr(SIGN_IN_HEADING), [
    "Success: the answer `{\"signedIn\":true,\"name\":\"<name>\",\"origin\":\"<origin>\"}`.",
    "A refusal: the CDP error `{\"code\":-32000,\"message\":\"Not signed in: <text>\"}`, with one text of the table below.",
  ]);
});

// Stage 1d part 2b (board ab-v16.94.5): the Playwright MCP inside the service, and the notes of the review of part 2a
// (review-114). Each changed or new text of C11, C12, the token design and the allow list's format, exactly; each old
// text is gone. The list of old and new texts is in the PR's body for the daemon lead.
const C12P = readOr("docs/contracts/C12.md"), ALLOWP = readOr("docs/contracts/mcp-allow-list.md"), TDP = readOr("docs/superpowers/specs/2026-11-10-mcp-connection-tokens-design.md");
const PART_2B: { file: string; why: string; old: string; text: string }[] = [
  { file: "C11", why: "review-114 notes 4 and 7 (OP1; the unreadable holder)", old: "holders the roots of one scope: that scope is the connection's scope. No holder gets the peer's 403, which names no pid. A holder that reaches no root, or holders of two scopes get the session's 403. So the walk refuses a browser process: Chrome is no session's process. Before the service's first `set_sessions` no root counts, so each connection gets the session's 403, whose text says to connect again in a few seconds. The", text: "holders the roots of one scope: that scope is the connection's scope. No holder gets the peer's 403, which names no pid. A process whose `/proc/<pid>/fd` the service cannot read (a process of another user, or a process that is not dumpable) is no holder for this check: when no other process holds the socket, the connection gets the peer's 403. A holder that reaches no root, or holders of two scopes get the session's 403. So the walk refuses a browser process: Chrome is no session's process. Before the service's first `set_sessions` no root counts, so each connection with a holder gets the session's 403, whose text says to connect again in a few seconds (a refusal at step 1 and a connection with no holder still get the peer's 403). The" },
  { file: "C11", why: "review-114 note 6 (two Host lines)", old: "4. A `Host` header that is not exactly `127.0.0.1:<port>` or `localhost:<port>`, or no `Host` header: 403 `The agent browser admits only the Host 127.0.0.1:<port> or localhost:<port>.`", text: "4. A `Host` header that is not exactly `127.0.0.1:<port>` or `localhost:<port>`, no `Host` header, or two `Host` header lines or more (the service counts the header lines as the request carries them, as at step 7): 403 `The agent browser admits only the Host 127.0.0.1:<port> or localhost:<port>.`" },
  { file: "C11", why: "review-114 notes 2, 8 and 10 (pipelining, Expect, CONNECT; the 500; the timeouts)", old: "- Steps 1 and 2 run once for each connection, and a connection keeps its scope until it closes. Steps 3 to 8 run for each request on the connection. A refused request never has its header in a log line or in an answer.", text: "- Steps 1 and 2 run once for each connection, and a connection keeps its scope until it closes. Steps 3 to 8 run for each request on the connection. A refused request never has its header in a log line or in an answer. - After the first refusal of steps 3 to 8 the connection closes, and a later request that the client sent on it (a pipelined request) gets no check, no answer and no handler. A request with `Expect: 100-continue` runs steps 3 to 8 before the service sends `100 Continue`; a request with another expectation runs steps 3 to 8, then gets 417 `Expectation Failed`, and the connection closes. A `CONNECT` request gets no answer, and the connection closes. - An exception of the service while it checks or answers a request gives 500 `The agent browser could not answer this request.`, which echoes nothing; the connection closes, and the service goes on. - The timeouts of an admitted connection (first values): a request's header comes whole within 10 s of the admission or of the end of the last answer on the connection, and a request's body pauses for at most 30 s; else the service closes the connection with no answer. While the service works on a request, no timeout runs." },
  { file: "C11", why: "review-114 note 5 (the close at a change)", old: "- At each C12 `set_sessions`, the service closes each MCP connection whose admitting root is no longer a root of its scope that counts, as the endpoint's 1008 close does at an `allowlist` line (when a connection ends, above), and each MCP connection of a session that the snapshot drops or whose `mcp_token` changed.", text: "- At each C12 `set_sessions`, the service closes each MCP connection when a root that admitted it no longer counts for its scope, also when only that root's cgroup stops counting for a connection that the root's cgroup admitted, and each MCP connection of a session that the snapshot drops or whose `mcp_token` changed. This rule is the MCP path's own: the endpoint's 1008 close at an `allowlist` line (when a connection ends, above) asks only whether the line still names the root." },
  { file: "C11", why: "the test flag and the socket take (part 2b, item 8; review-114 note 1)", old: "- The URL is `http://127.0.0.1:<port>/mcp/<scope>`. The service listens on `127.0.0.1` only, on one port for", text: "- The MCP port is off by default. The service opens it only when systemd passes it the socket of `agent-browser-mcp.socket` (the sd_listen_fds protocol), on the Mac only when launchd gives it the socket of its job's `Sockets` entry `agent-browser-mcp` (below), or in its `--test` mode with `--test-mcp-port <port>`: 0 (a free port that the kernel picks) or a port from 1024 to 65535, on `127.0.0.1`. It has no default port. On Linux, as sd_listen_fds does, the service sets `FD_CLOEXEC` on each passed fd as soon as `LISTEN_PID` and `LISTEN_FDS` are its own, before it reads the names, and it removes `LISTEN_PID`, `LISTEN_FDS` and `LISTEN_FDNAMES` from its environment in every path: also in `--test` mode, where it takes no passed fd, and when only `LISTEN_FDNAMES` is set. When the take fails, the service opens no MCP port, and `status` says `failed` (C12). The service opens the MCP port before its control door, so the MCP's state, and with it the hello's features, is fixed before the first hello (C12). - The URL is `http://127.0.0.1:<port>/mcp/<scope>`. The service listens on `127.0.0.1` only, on one port for" },
  { file: "C11", why: "the answer for one more MCP session (part 2b, item 3)", old: "- The service makes one Playwright MCP server object for each MCP session, from the pinned `@playwright/mcp` package's public entry. At most 4 MCP sessions for each scope and 32 for each service (first values).", text: "- The service makes one Playwright MCP server object for each MCP session, from the pinned `@playwright/mcp` package's public entry. At most 4 MCP sessions for each scope and 32 for each service (first values). One more `initialize` gets HTTP 503 with the JSON-RPC error `-32000` and the text `The agent browser serves at most 4 MCP sessions for each agentwatch session. End one of this session's MCP sessions (DELETE), then initialize again.` or, at the service's limit, `The agent browser serves at most 32 MCP sessions, and each is in use. Initialize again later.`" },
  { file: "C11", why: "the configuration and the roots (part 2b, item 4)", old: "- Its configuration also sets `timeouts.action: 30000` in `createConnection`, in place of the MCP's default of 5 s, so that an action that the input stage (above) translates ends inside the MCP's action timeout.", text: "- Its configuration also sets `timeouts.action: 30000` in `createConnection`, in place of the MCP's default of 5 s, so that an action that the input stage (above) translates ends inside the MCP's action timeout. - It also sets `webmcp: false` (a page's own tools: their listing runs page code, and no allow list names them) and `saveSession: false`. The scope's CDP endpoint comes through the context getter of `createConnection`, which connects with the ticket (below) and gives the default context: with `browser.cdpEndpoint` in the configuration the package would also start a pipe server for the browser in the temp folder and write a server registry entry, which another program of the user could use to reach the browser around the agent door. So the MCP never launches, downloads or binds a browser. - The service answers the MCP server's `roots/list` itself, with the scope's folder, so the MCP's own file guardrail and its relative file names use that folder. It answers each other request of the server to the client with `Method not found`, and it drops the server's notifications (the transport sends no stream)." },
  { file: "C11", why: "the path rule (part 2b, item 6)", old: "- The service refuses each argument that the allow list marks as a path when the path is outside the scope's folder, `<state>/mcp/<scope>/`, after `realpath`.", text: "- The service refuses each argument that the allow list marks as a path when the path is outside the scope's folder, `<state>/mcp/<scope>/`, after `realpath`. A relative path is read from the scope's folder; for a file that does not exist yet the service takes the `realpath` of its deepest folder that exists. A value that is no string and no list of strings is refused as a path. The service makes `<state>/mcp` and the scope's folder, each with mode 0700, at the scope's first MCP session. At each path argument it reads both with `lstat`: when one of them is a link or no folder of the service's user, it refuses each path argument with the format's answer (a call with no path argument passes)." },
  { file: "C11", why: "the ticket (part 2b, item 5)", old: "- The MCP's Playwright connects back to the endpoint's CDP path with the MCP session's scope and a one-time ticket, which only a connection from the service's own pid can use. Every rule of this file applies to that connection.", text: "- The MCP's Playwright connects back to the endpoint's CDP path with the MCP session's scope and a one-time ticket, which only a connection from the service's own pid can use. Every rule of this file applies to that connection. - The ticket is 32 random bytes in base64url, in the query of the CDP path: `/devtools/browser/<scope>?ticket=<ticket>`. The service makes a new ticket for the worker at each connect of the MCP's browser: at the first tool that needs the browser, and again at the next such tool after `browser_close` or after the endpoint closed the connection (a 1008 close, for example). A ticket lives 30 s (first value), and it is gone after its first check, whatever the result. In the agent door's checks before the upgrade, the ticket takes the place of the walk at step 6: a connection from the service's own pid passes it only with a live ticket of its scope, and no root admits it; for a local scope, with no such ticket it gets the session's 403. A ticket from any other pid admits nothing, and for a local scope that connection gets the walk. For a remote scope, the service's own pid with no such ticket gets the remote scope's 403 at step 6, and a connection from any other pid gets that 403 right after step 3, with no walk. The ticket never leaves the service's process, and no log line holds it." },
  { file: "C11", why: "the worker (part 2b, item 7)", old: "- The MCP code of each scope runs in one worker thread of the service, with a heap limit (first value 512 MiB). A worker that passes it ends with its MCP sessions, and their clients get an error.", text: "- The MCP code of each scope runs in one worker thread of the service, with a heap limit (first value 512 MiB). A worker that passes it ends with its MCP sessions, and their clients get an error. - The service starts a scope's worker at the scope's first MCP session and stops it with its last. The worker has an environment of its own (no variable of the service's environment reaches it), and the service reads and drops its standard output and error. When a worker passes its limit, each request that waits for it gets the JSON-RPC error `-32603` with the text `This MCP session has ended: the MCP of its agentwatch session passed its memory limit. Initialize a new MCP session.` (after a failure of the worker: `This MCP session has ended: the MCP of its agentwatch session failed. Initialize a new MCP session.`; an `initialize` whose server object is not made yet gets the 503 of the transport's table), and each later request of those MCP sessions gets the 404 of an unknown MCP session. The model, Chrome, the doors and the other scopes' workers go on." },
  { file: "C11", why: "the transport (part 2b, item 3)", old: "**How a session gets the MCP (from stage 2; the operator's answer Q2 of ab-bi3, and the daemon lead's condition 4).**", text: "**The transport of the MCP path (from stage 1d; the self-contained design, section 8.2).** The service's own small Streamable HTTP transport, with no MCP SDK package, answers each request that passed steps 1 to 8, with JSON only: - A `POST` carries one JSON-RPC message, and a request gets one answer with `Content-Type: application/json`. A batch gets HTTP 400 with `-32600` and `Invalid Request: the agent browser takes one JSON-RPC message in each POST.`; a body that is no JSON gets HTTP 400 with `-32700` and `Parse error`; a body of more than 1 MiB (first value) gets HTTP 413 with `-32600` and `Request too large: the agent browser takes at most 1048576 bytes in one POST.`, and the connection closes. - `initialize` makes a new MCP session: its id, 32 lowercase hex digits, is in the answer's `Mcp-Session-Id` header. An `initialize` with an `Mcp-Session-Id` gets HTTP 400. Each other message carries the session's id: with none it gets HTTP 400 with `-32000` and `Bad Request: this request needs the Mcp-Session-Id of its MCP session; initialize first.`; an unknown id, or an id of another scope, gets the 404 of an unknown MCP session: HTTP 404 with `-32001` and `Session not found`. - Of the requests only `initialize`, `ping`, `tools/list` and `tools/call` reach the MCP; each other request gets `-32601` and `Method not found`. Of the notifications only `notifications/initialized` and `notifications/cancelled` reach it, and the others are dropped. A notification or a client's answer gets HTTP 202 with no body. A client that closes its connection before its answer cancels that request: when the MCP has the request, the service sends it `notifications/cancelled`, and the service frees the request's id at once (the MCP never answers a request that it cancelled), so a later request with that id goes on. An answer that the MCP sent before it got the cancel goes nowhere: it never becomes the answer of a later request with that id (board ab-v16.94.20). The worker keeps a cancel that the pinned MCP does not ignore (below) of a `browser_close` call that runs, or of a request that waits for the end of one, from the MCP; until such a call has ended, the worker holds each later message of the MCP session other than a cancel, also `notifications/initialized` (the MCP inside the service, above; board ab-v16.94.18 and ab-v16.94.20). A client's own `notifications/cancelled` of a request of its MCP session that still waits reaches the MCP too, and it frees that id at once; the request's POST, while it is open, gets HTTP 200 with `-32800` and `Request cancelled: the client sent notifications/cancelled for this request.` (a tool call that waits for the start at a use gets it when that wait ends, or that wait's refusal). The MCP has no code of its own for a cancelled request, and `-32800` is the code that the Language Server Protocol gives one. The pinned MCP ignores a cancel whose `requestId` is `0` or `\"\"`, or whose `params` its schema refuses (a `reason` that is no string), and it then runs the call and answers it. So once the MCP has the request, such a cancel frees nothing: the id stays busy until the MCP's answer or the end of its MCP session, and while the POST is open, the MCP's answer goes to it and a tool call counts as a use. For a client that closes its connection, the service sends no cancel for the id `0` or `\"\"`, and the tool call is no use from that close on (board ab-v16.94.14): the pinned `browser_evaluate` has no time limit, so a script that never settles would otherwise keep Chrome from its stop by use until the MCP session ends. - A `GET` gets HTTP 405 with `Allow: POST, DELETE`: the service sends no stream. A `DELETE` with the session's id ends that MCP session: HTTP 200 with no body. - For a remote admission an answer of more than 16777216 bytes (first value) is not sent: the call gets a tool error with `The answer is larger than the limit for a remote session; ask for a smaller part, for example one element's snapshot or a viewport screenshot.` - At `session_ended` and at the close at a change, each request of an MCP session that ends while it waits gets `-32603` and `This MCP session has ended: its agentwatch session ended or changed. Initialize a new MCP session.` (an `initialize` whose server object is not made yet gets the 503 of the table below). - No log line of the transport holds an MCP session id; a line names an MCP session by its number. The transport's answers: each answer of an error carries the request's id, or `null` when the request has none that the service can read (a body that is no JSON-RPC 2.0 message of the shapes below has none). The transport gives no other answer than these, the HTTP 200 answers of the allow list's format (`docs/contracts/mcp-allow-list.md`), the 202 and the 200 above, and the MCP's own answers: the result or the JSON-RPC error that the MCP gives to a request that reaches it, which the transport passes on with HTTP 200 (for `tools/list`, with only the list's tools and keys; for a remote admission, a `tools/call` answer within the limit above, or else its tool error). | Case | HTTP status | JSON-RPC code | Text | | --- | --- | --- | --- | | A batch | 400 | `-32600` | `Invalid Request: the agent browser takes one JSON-RPC message in each POST.` | | A body that is no JSON | 400 | `-32700` | `Parse error` | | A body that is JSON but no JSON-RPC 2.0 message of the three shapes below, also a message whose id is no string and no safe integer | 400 | `-32600` | `Invalid Request` | | A request whose id is the id of a request of the same MCP session that still waits | 400 | `-32600` | `Invalid Request: a request with this id still waits in this MCP session.` | | A body of more than 1 MiB | 413 | `-32600` | `Request too large: the agent browser takes at most 1048576 bytes in one POST.` | | An `initialize` with an `Mcp-Session-Id` | 400 | `-32600` | `Bad Request: initialize makes a new MCP session, so it carries no Mcp-Session-Id.` | | Another message with no `Mcp-Session-Id` | 400 | `-32000` | `Bad Request: this request needs the Mcp-Session-Id of its MCP session; initialize first.` | | An `Mcp-Session-Id` that the service does not know, or one of another scope | 404 | `-32001` | `Session not found` | | A `GET`, or a method other than `POST` and `DELETE` | 405 | `-32000` | `Method not allowed: the agent browser's MCP sends no stream; POST each message, and DELETE ends the MCP session.` | | One more `initialize` at the scope's limit, when no MCP session of the scope can give its place (each has a request that waits, or its `initialize` runs) | 503 | `-32000` | `The agent browser serves at most 4 MCP sessions for each agentwatch session. End one of this session's MCP sessions (DELETE), then initialize again.` | | One more `initialize` at the service's limit | 503 | `-32000` | `The agent browser serves at most 32 MCP sessions, and each is in use. Initialize again later.` | | One more `initialize` of a remote admission at the limit of 16 remote MCP sessions or at the service's limit | 200 | `-32000` | `The agent browser has no free place for an MCP session of another box now: it serves at most 16 MCP sessions of other boxes, and at most 32 in all. Initialize again later.` | | An `initialize` whose MCP session the service cannot make | 503 | `-32000` | `The agent browser could not make an MCP session now. Initialize again.` | | A request of another method | 200 | `-32601` | `Method not found` | | A request that its client cancelled with its own `notifications/cancelled` while its POST is open | 200 | `-32800` | `Request cancelled: the client sent notifications/cancelled for this request.` | | A request of an MCP session that ends while it waits (`session_ended`, the close at a change, a `DELETE`) | 200 | `-32603` | `This MCP session has ended: its agentwatch session ended or changed. Initialize a new MCP session.` | | A request that waits for a worker that passed its heap limit | 200 | `-32603` | `This MCP session has ended: the MCP of its agentwatch session passed its memory limit. Initialize a new MCP session.` | | A request that waits for a worker that failed | 200 | `-32603` | `This MCP session has ended: the MCP of its agentwatch session failed. Initialize a new MCP session.` | - The service cannot make an MCP session when the scope's worker does not make the session's server object within 30 s (first value) or fails to make it, when the session ends before its server object is made (`session_ended`, the close at a change, the worker's heap limit or failure), or when the service stops. An `initialize` whose MCP session ends after its server object is made gets the `-32603` answer of its end, as any request that waits. - A JSON-RPC 2.0 message is a JSON object with `jsonrpc` `\"2.0\"` in one of three shapes, with no other member: a request (`jsonrpc`, an `id`, a `method` that is a string, and a `params` or none), a notification (`jsonrpc`, a `method` that is a string, and a `params` or none), or a client's answer (`jsonrpc`, an `id`, and exactly one of `result` and `error`). A `params` is a JSON object; its `_meta`, when it has one, is a JSON object whose `progressToken`, when it has one, is a string or a safe integer, and whose `io.modelcontextprotocol/related-task`, when it has one, is a JSON object with a string `taskId`. An `id` is a string or a safe integer: an integer from -(2^53 - 1) to 2^53 - 1 (a larger one loses its exact value in the service's JSON parse). The shapes of a request and of a notification are exactly the shapes that the MCP's own SDK takes: it gives no answer to a request of another shape (the pinned version: an extra member, a `params` that is no object, a `_meta` that is no object), so a body of another shape never reaches the MCP. A client's answer never reaches the MCP (the service sends no request to the client), so its shape is the transport's own (the SDK would also take an error with no id). A request whose id is the id of a request of the same MCP session that still waits never reaches the MCP either, and the waiting request keeps its own answer. A request waits until its answer or its cancel, from the moment that it passes the transport's checks (a tool call also while it waits for the start at a use). **How a session gets the MCP (from stage 2; the operator's answer Q2 of ab-bi3, and the daemon lead's condition 4).**" },
  { file: "TDP", why: "review-114 note 4 (OP1, the same in the token design)", old: "Until the daemon's first `set_sessions`, no root counts, so each MCP connection gets the session's 403 of step 2: C11's order holds, and the 403's text says to connect again in a few seconds.", text: "Until the daemon's first `set_sessions`, no root counts, so each MCP connection with a holder gets the session's 403 of step 2: C11's order holds, and the 403's text says to connect again in a few seconds." },
  { file: "C12P", why: "review-114 note 3 (OP6)", old: "(a session launched while the name was shared has none, so its MCP gets the second 401 of C11's step 7).", text: "(a session launched while the name was shared has none, so agentwatch writes no MCP entry for it: its client sends no `Authorization` header and gets the first 401 of C11's step 7, and only a request with a bearer gets the second 401)." },
  { file: "C12P", why: "status mcp (part 2b, item 8)", old: "`state` is `none` while the service has no MCP (before stage 1d), and then `address` is `null`. Stage 1d names the other states and fixes the form of `address`, an opaque text that the daemon shows as it is. This file fixes no transport of the MCP.", text: "`state` is `none` while the service serves no MCP (before stage 1d, and from stage 1d while its MCP path is off), and then `address` is `null`. From stage 1d `state` is also `ready` while the service serves the MCP with its admission and its token check, and `closed` while the service closes each MCP connection with no answer (only under a test switch since board ab-v16.94.32; before it, the Mac until its peer reader was measured), each with the MCP's `address` (C11: `127.0.0.1:<port>`); and `failed` when the service could not open its MCP path, with the `address` `null`. The daemon shows `address` as it is." },
  { file: "C12P", why: "the hello (part 2b, item 8)", old: "- The service's hello gets the feature `mcp_token` in stage 1d, with the MCP path and its token check.", text: "- The service's hello gets the feature `mcp_token` in stage 1d, with the MCP path and its token check. The hello lists it while `status`'s `mcp` state is `ready`, and only then; `agent-browser service --hello` serves no MCP, so its hello has no `mcp_token`. The service opens its MCP path before its control door, so its `mcp` state is fixed before its first hello and stays the same for the service's run: each connection of a run gets the same features, and a hello with no `mcp_token` means no MCP until the service's next start. The daemon waits for no other line." },
  { file: "ALLOWP", why: "the first list (part 2b, item 2)", old: "Stage 1d (board ab-v16.94.5) writes the first list for the pinned version of `@playwright/mcp`, and its test. Stage 1d's first list holds the 24 tools of M3's part C (the self-contained design, section 8.2), and no `browser_run_code_unsafe`.", text: "Stage 1d (board ab-v16.94.5) writes the first list for the pinned version of `@playwright/mcp`, and its test. Stage 1d's first list, `src/service/mcp/allow-list.json`, is for `@playwright/mcp` 0.0.83: it holds the 24 tools of that version's `tools/list` other than `browser_run_code_unsafe`, as M3's part C did for 0.0.85 (the self-contained design, section 8.2)." },
  { file: "ALLOWP", why: "the arguments that are no object; the service tools before stage 1e (part 2b, item 2)", old: "- `tools/call` with an argument key that the tool's `keys` does not name: the service refuses it before the call reaches the MCP's code, with the JSON-RPC error `-32602` and the message `Not available in the agent browser: the argument <key> of <tool>`.", text: "- `tools/call` with an argument key that the tool's `keys` does not name: the service refuses it before the call reaches the MCP's code, with the JSON-RPC error `-32602` and the message `Not available in the agent browser: the argument <key> of <tool>`. - `tools/call` whose `arguments` is not a JSON object: the service refuses it before the call reaches the MCP's code, with the JSON-RPC error `-32602` and the message `Not available in the agent browser: the arguments of <tool> must be a JSON object`." },
  { file: "ALLOWP", why: "the test reads the file words widely (part 2b, item 2)", old: "- each string property whose schema speaks of a file or a path (its name or its description) is in `paths`, or is left out of `keys`;", text: "- each string property whose schema speaks of a file or a path (its name or its description) is in `paths`, or is left out of `keys`, with no exception for a string whose values an `enum` or a `const` fixes, with the `type` `string` or with no `type`; a schema speaks of a file or a path when its name or its description holds `file`, `path`, `folder` or `directory`, in any case, also inside a word (so `browser_take_screenshot`'s `type`, an `enum` string whose description names the file name's extension, is left out of `keys` in the first list); the test reads each string inside a key's schema too, in `anyOf`, `oneOf`, `allOf`, `items`, nested `properties`, `additionalProperties` and `propertyNames`, with the names and descriptions on its way, and a key whose schema has a shape that the test cannot read (no `type` and no `anyOf`, `oneOf`, `allOf`, `enum` or `const`, a `$ref`, or a keyword that the test does not know) fails the test; - each key that a tool's `schema` requires is in its `keys`; - no tool's `keys` names `_meta` (the package reads `arguments._meta` to change the base of relative file names);" },
]
test("stage 1d part 2b and review-114: C11, C12, the token design and the allow list's format say each new text exactly, and no old text", () => {
  const files: Record<string, string> = { C11, C12P, ALLOWP, TDP };
  assert.equal(PART_2B.length, 18);
  for (const e of PART_2B) {
    assert.ok(says(files[e.file], longNow(e.text)), `${e.file}, ${e.why}: ${e.text.slice(0, 120)}`);
    if (!flat(e.text).includes(flat(e.old))) assert.ok(!says(files[e.file], e.old), `${e.file}, ${e.why}: the old text is gone: ${e.old.slice(0, 120)}`);
  }
  // C12 stays transport-neutral (B3): it names no MCP port and no flag of the MCP path.
  assert.ok(!/MCP port|--test-mcp-port|agent-browser-mcp\.socket/.test(C12P), "C12 names no MCP port");
});

test("the texts of stage 1d part 2b are the code's: the limits, the transport's answers, the 500, the timeouts, the ticket's life and the worker's heap", async () => {
  const t = await import("../src/service/mcp/transport.ts");
  const port = await import("../src/service/mcp/port.ts");
  const ticket = await import("../src/service/mcp/ticket.ts");
  const workers = await import("../src/service/mcp/workers.ts");
  const al = await import("../src/service/mcp/allow-list.ts");
  for (const s of [t.MCP_ANSWER.perScope, t.MCP_ANSWER.perService, t.MCP_ANSWER.batch, t.MCP_ANSWER.parse, t.MCP_ANSWER.tooLarge, t.MCP_ANSWER.noSessionId, t.MCP_ANSWER.unknownSession, t.MCP_ANSWER.methodNotFound, t.MCP_ANSWER.ended, t.MCP_ANSWER.memory, t.MCP_ANSWER.failed, port.MCP_FAILED]) {
    assert.ok(says(C11, `\`${s}\``), `C11 names the text: ${s}`);
  }
  assert.ok(says(ALLOWP, `\`${al.refuseArguments("<tool>").message}\``));
  assert.deepEqual([t.MCP_SESSIONS_PER_SCOPE, t.MCP_SESSIONS_PER_SERVICE, t.MCP_MAX_BODY, port.MCP_HEADERS_MS, port.MCP_IDLE_MS, ticket.TICKET_MS, workers.MCP_HEAP_MB], [4, 32, 1024 * 1024, 10_000, 30_000, 30_000, 512]);
  assert.deepEqual([...t.MCP_REQUESTS], ["initialize", "ping", "tools/list", "tools/call"]);
  assert.deepEqual([...t.MCP_NOTIFICATIONS], ["notifications/initialized", "notifications/cancelled"]);
  // No text of the MCP path names a stop or a start of the agent browser (I2).
  for (const s of Object.values(t.MCP_ANSWER)) assert.doesNotMatch(s, /\b(stop|start|restart)/i, s);
});

// Board ab-sta.9 (a long MCP call keeps its client; Refs #222): a request that waits long gets its answer as an event
// stream, so a Node MCP client (undici: 300 s for the header, 300 s for each pause of the body) keeps it. Each changed or
// new text of C11, exactly; each old text is gone. The list of old and new texts is in the PR's body for the daemon lead.
const LONG_CALL: { file: string; why: string; old: string; text: string }[] = [
  { file: "C11", why: "the port's 500 after the switch to a stream", old: "which echoes nothing; the connection closes, and the service goes on.", text: "which echoes nothing; the connection closes, and the service goes on. After the answer of a request became an event stream, such an exception gives that stream's last event in place of the 500 (the transport of the MCP path, below), and then the connection closes in the same way, after that event." },
  { file: "C11", why: "the MCP's notifications: of the MCP's messages, the transport carries only its answers (review-230 N6)", old: "`Method not found`, and it drops the server's notifications (the transport sends no stream).", text: "`Method not found`, and it drops the server's notifications (of the MCP's messages, the transport carries only its answers to the client)." },
  { file: "C11", why: "the transport's head: JSON, and an event stream for a request that waits long", old: "answers each request that passed steps 1 to 8, with JSON only: - A `POST` carries one JSON-RPC message, and a request gets one answer with `Content-Type: application/json`. A batch", text: "answers each request that passed steps 1 to 8 with JSON, and a request that waits long with an event stream (below): - A `POST` carries one JSON-RPC message, and a request gets one answer with `Content-Type: application/json`, or the event stream of a request that waits long (below). A batch" },
  { file: "C11", why: "the stream of a request that waits long; a GET opens no stream (the 405 and its text stay)", old: "- A `GET` gets HTTP 405 with `Allow: POST, DELETE`: the service sends no stream. A `DELETE` with the session's id ends that MCP session: HTTP 200 with no body.", text: "- A request that waits long (board ab-sta.9). A Node MCP client (the MCP SDK's client over fetch, that is undici) drops a request whose answer's header does not come within 300 s, or whose body pauses for 300 s. `browser_pay` waits up to 10 minutes for the operator's approval, and PageFetch and the sign-in act can wait for the one private window. So a request that still waits 30 s (first value) after its arrival, and that has reached the MCP or the service's own tool, gets its answer as an event stream, when its `Accept` header names `text/event-stream` (the MCP's Streamable HTTP transport, version 2025-06-18). A tool call reaches its tool only after its browser gate, which waits at most 60 s and sends no beat: when the call spent 30 s or more in the gate, its answer becomes a stream at once after the gate. The stream starts at once with HTTP 200, `Content-Type: text/event-stream` and `Cache-Control: no-cache`. It carries a beat at once and then each 30 s (first value): the comment line `: the request still waits`, or, for a request whose `_meta` has a `progressToken`, the event of `notifications/progress` with that token and a `progress` that counts 1, 2, 3 and on. The request's answer is the last event (`event: message` and one `data` line of its JSON), and then the stream ends. No event has an `id`, so a client does not resume a stream. A request that gets its answer within the 30 s, and a request whose `Accept` does not name `text/event-stream` (a media range with `q=0` does not count, and neither does a wildcard), get the one JSON answer, as before. In a stream the cancels, the ends and the answers of this part and of the table below stay the same, and each answer comes as the last event. An exception of the service after the switch to a stream gives the JSON-RPC error `-32603` with the 500's text `The agent browser could not answer this request.` as the last event, and the log line `mcp: MCP session <n> (scope <scope>): a <method> failed (in its stream)`; then the connection closes after that event, as after the 500, and a later request on it gets no answer. The carrier of the remote MCP path forwards no `Accept` (above), so a request of the carrier gets the one JSON answer. - A `GET` gets HTTP 405 with `Allow: POST, DELETE`: the service opens no stream for a `GET`, and only the answer of a request that waits long is a stream. A `DELETE` with the session's id ends that MCP session: HTTP 200 with no body." },
  { file: "C11", why: "the transport's answers: the last event -32603 of a stream after an exception (review-230 N1)", old: "(`docs/contracts/mcp-allow-list.md`), the 202 and the 200 above, and the MCP's own answers:", text: "(`docs/contracts/mcp-allow-list.md`), the 202 and the 200 above, the last event `-32603` of a stream after an exception (above), and the MCP's own answers:" },
];
/** A text of an earlier list as LONG_CALL changed it. */
const longNow = (s: string) => { let t = flat(s); for (const e of LONG_CALL) if (t.includes(flat(e.old))) t = t.replace(flat(e.old), flat(e.text)); return t; };
test("board ab-sta.9: C11 says each text of LONG_CALL exactly, and each old text is gone; the values are the code's: the 30 s, the beat's comment, the 500's text, which Accept takes a stream; the 405 and its text stay", async () => {
  for (const e of LONG_CALL) {
    assert.ok(says(C11, e.text), `${e.why}: ${e.text.slice(0, 120)}`);
    if (!flat(e.text).includes(flat(e.old))) assert.ok(!says(C11, e.old), `${e.why}: the old text is gone`);
  }
  for (const gone of ["with JSON only", "the service sends no stream", "the transport sends no stream", "the transport carries only the MCP's answers", "after it reached the MCP or the service's own tool (a tool call: after its browser gate)"]) assert.ok(!says(C11, gone), `C11 no longer says: ${gone}`);
  const t = await import("../src/service/mcp/transport.ts") as any;
  const port = await import("../src/service/mcp/port.ts");
  assert.deepEqual([t.MCP_STREAM_AFTER_MS, t.MCP_BEAT_MS], [30_000, 30_000], "C11's 30 s and 30 s (first values)");
  assert.ok(says(C11, `the comment line \`: ${t.MCP_BEAT_COMMENT}\``), "the beat's comment is the code's");
  assert.ok(says(C11, `with the 500's text \`${port.MCP_FAILED}\` as the last event`), "the 500's text is the code's");
  assert.deepEqual(t.MCP_ANSWERS.noStream, { status: 405, code: -32000, text: "Method not allowed: the agent browser's MCP sends no stream; POST each message, and DELETE ends the MCP session." }, "the 405 of a GET stays");
  for (const a of ["application/json, text/event-stream", "text/event-stream", "TEXT/Event-Stream;q=0.5", "application/json,text/event-stream", "text/event-stream; charset=utf-8"]) assert.equal(t.acceptsStream(a), true, a);
  for (const a of [undefined, "", "application/json", "*/*", "text/*", "text/event-stream;q=0", "text/event-stream ; q=0.000", "text/event-streams"]) assert.equal(t.acceptsStream(a), false, String(a));
  // The code's own words follow: no "sends no stream" in the transport's head, no "JSON-only" transport in session.ts.
  const head = flat(read("src/service/mcp/transport.ts").split("\nimport ")[0].replace(/\n\/\/\s*/g, " "));
  assert.ok(!head.includes("The service sends no stream") && head.includes("The service opens no stream for a GET: a GET gets 405."), "transport.ts's head");
  assert.ok(!read("src/service/mcp/session.ts").includes("JSON-only"), "session.ts's head");
});

// Review-115 (the fix round of stage 1d part 2b): each changed or new text, exactly; each old text that the round
// replaced is gone. The list of old and new texts is in the PR's body for the daemon lead.
const PART_2B_R1: { file: string; why: string; old: string; text: string }[] = [
  { file: "C11", why: "review-115 B2 and note 7: every answer of the transport, its causes, and the request ids", old: "- At `session_ended` and at the close at a change, each request of an MCP session that ends while it waits gets `-32603` and `This MCP session has ended: its agentwatch session ended or changed. Initialize a new MCP session.` - No log line of the transport holds an MCP session id; a line names an MCP session by its number.", text: "- At `session_ended` and at the close at a change, each request of an MCP session that ends while it waits gets `-32603` and `This MCP session has ended: its agentwatch session ended or changed. Initialize a new MCP session.` (an `initialize` whose server object is not made yet gets the 503 of the table below). - No log line of the transport holds an MCP session id; a line names an MCP session by its number. The transport's answers: each answer of an error carries the request's id, or `null` when the request has none that the service can read (a body that is no JSON-RPC 2.0 message of the shapes below has none). The transport gives no other answer than these, the HTTP 200 answers of the allow list's format (`docs/contracts/mcp-allow-list.md`), the 202 and the 200 above, and the MCP's own answers: the result or the JSON-RPC error that the MCP gives to a request that reaches it, which the transport passes on with HTTP 200 (for `tools/list`, with only the list's tools and keys; for a remote admission, a `tools/call` answer within the limit above, or else its tool error). | Case | HTTP status | JSON-RPC code | Text | | --- | --- | --- | --- | | A batch | 400 | `-32600` | `Invalid Request: the agent browser takes one JSON-RPC message in each POST.` | | A body that is no JSON | 400 | `-32700` | `Parse error` | | A body that is JSON but no JSON-RPC 2.0 message of the three shapes below, also a message whose id is no string and no safe integer | 400 | `-32600` | `Invalid Request` | | A request whose id is the id of a request of the same MCP session that still waits | 400 | `-32600` | `Invalid Request: a request with this id still waits in this MCP session.` | | A body of more than 1 MiB | 413 | `-32600` | `Request too large: the agent browser takes at most 1048576 bytes in one POST.` | | An `initialize` with an `Mcp-Session-Id` | 400 | `-32600` | `Bad Request: initialize makes a new MCP session, so it carries no Mcp-Session-Id.` | | Another message with no `Mcp-Session-Id` | 400 | `-32000` | `Bad Request: this request needs the Mcp-Session-Id of its MCP session; initialize first.` | | An `Mcp-Session-Id` that the service does not know, or one of another scope | 404 | `-32001` | `Session not found` | | A `GET`, or a method other than `POST` and `DELETE` | 405 | `-32000` | `Method not allowed: the agent browser's MCP sends no stream; POST each message, and DELETE ends the MCP session.` | | One more `initialize` at the scope's limit, when no MCP session of the scope can give its place (each has a request that waits, or its `initialize` runs) | 503 | `-32000` | `The agent browser serves at most 4 MCP sessions for each agentwatch session. End one of this session's MCP sessions (DELETE), then initialize again.` | | One more `initialize` at the service's limit | 503 | `-32000` | `The agent browser serves at most 32 MCP sessions, and each is in use. Initialize again later.` | | One more `initialize` of a remote admission at the limit of 16 remote MCP sessions or at the service's limit | 200 | `-32000` | `The agent browser has no free place for an MCP session of another box now: it serves at most 16 MCP sessions of other boxes, and at most 32 in all. Initialize again later.` | | An `initialize` whose MCP session the service cannot make | 503 | `-32000` | `The agent browser could not make an MCP session now. Initialize again.` | | A request of another method | 200 | `-32601` | `Method not found` | | A request that its client cancelled with its own `notifications/cancelled` while its POST is open | 200 | `-32800` | `Request cancelled: the client sent notifications/cancelled for this request.` | | A request of an MCP session that ends while it waits (`session_ended`, the close at a change, a `DELETE`) | 200 | `-32603` | `This MCP session has ended: its agentwatch session ended or changed. Initialize a new MCP session.` | | A request that waits for a worker that passed its heap limit | 200 | `-32603` | `This MCP session has ended: the MCP of its agentwatch session passed its memory limit. Initialize a new MCP session.` | | A request that waits for a worker that failed | 200 | `-32603` | `This MCP session has ended: the MCP of its agentwatch session failed. Initialize a new MCP session.` | - The service cannot make an MCP session when the scope's worker does not make the session's server object within 30 s (first value) or fails to make it, when the session ends before its server object is made (`session_ended`, the close at a change, the worker's heap limit or failure), or when the service stops. An `initialize` whose MCP session ends after its server object is made gets the `-32603` answer of its end, as any request that waits. - A JSON-RPC 2.0 message is a JSON object with `jsonrpc` `\"2.0\"` in one of three shapes, with no other member: a request (`jsonrpc`, an `id`, a `method` that is a string, and a `params` or none), a notification (`jsonrpc`, a `method` that is a string, and a `params` or none), or a client's answer (`jsonrpc`, an `id`, and exactly one of `result` and `error`). A `params` is a JSON object; its `_meta`, when it has one, is a JSON object whose `progressToken`, when it has one, is a string or a safe integer, and whose `io.modelcontextprotocol/related-task`, when it has one, is a JSON object with a string `taskId`. An `id` is a string or a safe integer: an integer from -(2^53 - 1) to 2^53 - 1 (a larger one loses its exact value in the service's JSON parse). The shapes of a request and of a notification are exactly the shapes that the MCP's own SDK takes: it gives no answer to a request of another shape (the pinned version: an extra member, a `params` that is no object, a `_meta` that is no object), so a body of another shape never reaches the MCP. A client's answer never reaches the MCP (the service sends no request to the client), so its shape is the transport's own (the SDK would also take an error with no id). A request whose id is the id of a request of the same MCP session that still waits never reaches the MCP either, and the waiting request keeps its own answer. A request waits until its answer or its cancel, from the moment that it passes the transport's checks (a tool call also while it waits for the start at a use)." },
  { file: "C11", why: "review-115 B2: the worker's end during an initialize", old: "(after a failure of the worker: `This MCP session has ended: the MCP of its agentwatch session failed. Initialize a new MCP session.`), and each later request of those MCP sessions gets the 404 of an unknown MCP session.", text: "(after a failure of the worker: `This MCP session has ended: the MCP of its agentwatch session failed. Initialize a new MCP session.`; an `initialize` whose server object is not made yet gets the 503 of the transport's table), and each later request of those MCP sessions gets the 404 of an unknown MCP session." },
  { file: "C11", why: "review-115 B1 and note 1: the open before the control door; the variables in every path", old: "in every path. When the take fails, the service opens no MCP port, and `status` says `failed` (C12).", text: "in every path: also in `--test` mode, where it takes no passed fd, and when only `LISTEN_FDNAMES` is set. When the take fails, the service opens no MCP port, and `status` says `failed` (C12). The service opens the MCP port before its control door, so the MCP's state, and with it the hello's features, is fixed before the first hello (C12)." },
  { file: "C11", why: "review-115 note 2: real folders, not links", old: "no list of strings is refused as a path. The service makes the folder, with mode 0700, at the scope's first MCP session.", text: "no list of strings is refused as a path. The service makes `<state>/mcp` and the scope's folder, each with mode 0700, at the scope's first MCP session. At each path argument it reads both with `lstat`: when one of them is a link or no folder of the service's user, it refuses each path argument with the format's answer (a call with no path argument passes)." },
  { file: "C11", why: "review-115 note 13: a new ticket at each connect", old: "The service makes it for the worker at the MCP's first tool that needs the browser; it lives 30 s (first value), and", text: "The service makes a new ticket for the worker at each connect of the MCP's browser: at the first tool that needs the browser, and again at the next such tool after `browser_close` or after the endpoint closed the connection (a 1008 close, for example). A ticket lives 30 s (first value), and" },
  { file: "C11", why: "review-115 note 2: the limit of the path rule", old: "session. The stored sign-ins do not change this: such a process can replace the service and wait for the operator's next unlock, or use the display's X authority during an act.", text: "session. The stored sign-ins do not change this: such a process can replace the service and wait for the operator's next unlock, or use the display's X authority during an act. - The path rule of the MCP inside the service (below) does not stop a process of the same OS user either: it can put a link or a hard link to another file into the scope's folder, or change a file between the service's check and the MCP's open of it." },
  { file: "C12P", why: "review-115 B1: the hello is right for each connection", old: "- The service's hello gets the feature `mcp_token` in stage 1d, with the MCP path and its token check. The hello lists it while `status`'s `mcp` state is `ready`, and only then; `agent-browser service --hello` serves no MCP, so its hello has no `mcp_token`.", text: "- The service's hello gets the feature `mcp_token` in stage 1d, with the MCP path and its token check. The hello lists it while `status`'s `mcp` state is `ready`, and only then; `agent-browser service --hello` serves no MCP, so its hello has no `mcp_token`. The service opens its MCP path before its control door, so its `mcp` state is fixed before its first hello and stays the same for the service's run: each connection of a run gets the same features, and a hello with no `mcp_token` means no MCP until the service's next start. The daemon waits for no other line." },
  { file: "ALLOWP", why: "review-115 note 6: tools/list shows only the list's keys", old: "- `tools/list`: the service drops each tool that `tools` does not name, and adds each tool of `service_tools` for a request with a local admission; a request that a remote token admitted gets no tool of `service_tools`.", text: "- `tools/list`: the service drops each tool that `tools` does not name, and adds each tool of `service_tools` for a request with a local admission while the service has the part that serves it (the sign-in act for `browser_sign_in` and `browser_sign_ins`, PageFetch for `PageFetch`); a request that a remote token admitted gets no tool of `service_tools`. - In `tools/list` the input schema of each tool of `tools` holds only the keys of its `keys`: the service drops each other property and its entry in `required`." },
  { file: "ALLOWP", why: "review-115 notes 5, 6 and 9: the list test reads deeper; required keys; _meta", old: "names the file name's extension, is left out of `keys` in the first list);", text: "names the file name's extension, is left out of `keys` in the first list); the test reads each string inside a key's schema too, in `anyOf`, `oneOf`, `allOf`, `items`, nested `properties`, `additionalProperties` and `propertyNames`, with the names and descriptions on its way, and a key whose schema has a shape that the test cannot read (no `type` and no `anyOf`, `oneOf`, `allOf`, `enum` or `const`, a `$ref`, or a keyword that the test does not know) fails the test; - each key that a tool's `schema` requires is in its `keys`; - no tool's `keys` names `_meta` (the package reads `arguments._meta` to change the base of relative file names);" },
];
test("review-115: C11, C12 and the allow list's format say each text of the fix round exactly, and no replaced text", () => {
  const files: Record<string, string> = { C11, C12P, ALLOWP };
  for (const e of PART_2B_R1) {
    assert.ok(says(files[e.file], longNow(payNow(e.text))), `${e.file}, ${e.why}: ${e.text.slice(0, 160)}`);
    if (!flat(e.text).includes(flat(e.old))) assert.ok(!says(files[e.file], e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
  assert.ok(!/MCP port|--test-mcp-port|agent-browser-mcp\.socket/.test(C12P), "C12 names no MCP port");
});

// Board ab-v16.97.5: the stored sign-ins' MCP tools in stage 1d's transport, for a local admission only. Each changed or
// new text of C11, C12 and the allow list's format, exactly (old, then new); each old text is gone. The list is in the
// PR's body for the daemon lead. The sign-in act's part of C11 holds the five MCP items in SIGN_IN_ITEMS (above).
const MCP_SIGN_IN: { file: string; why: string; old: string; text: string }[] = [
  { file: "C11", why: "the MCP entry: the transport answers the tools, while the service has the act", old: "The MCP: the service's own tools `browser_sign_in` (`name`) and `browser_sign_ins` (no argument), of the allow list's `service_tools`. The service runs them as the method for the MCP session's scope, only for a request that the MCP port admitted with the uid check and the walk (a local admission). A request that a remote token admitted", text: "The MCP: the service's own tools `browser_sign_in` (`name`) and `browser_sign_ins` (no argument), of the allow list's `service_tools` (board ab-v16.97.5). The MCP path's transport answers them itself, and a call of either never reaches the MCP's code. The service runs them as the method for the MCP session's scope, only for a request that the MCP port admitted with the uid check and the walk (a local admission), and only while the service has the act. A request that a remote token admitted (stage 5: the token design, section 10) gets a `tools/list` without them, and a call of either name gets the refusal of check 1." },
  { file: "C11", why: "new: how the MCP knows the admission of each request; the live check's stand-in", old: "", text: "The admission of each request on the MCP path. The MCP port admits each connection by steps 1 and 2 (the uid check and the walk), and it gives each request of the connection that passes steps 3 to 8 to the transport with the word `local`. The transport takes only that word as a local admission: a request with no word is remote, so a new path to the transport fails closed. The transport reads the word at each request, not at the MCP session's `initialize`. The MCP port admits no request by a remote token: a remote request comes only through the carrier (the remote MCP path), which gives the word `remote`. For the live check, the service's `--test` mode takes `--test-mcp-remote-scope <scope>` with `--test-mcp-port`: the port gives each request of that one scope the word `remote`. It takes rights away only: steps 1 to 8 still run." },
  { file: "C11", why: "new: a remote admission never reaches the act", old: "", text: "A remote admission on the MCP path. The transport gives a call of either tool at once to the act's method with the admission `remote` and no argument of the client, and the act's check 1 refuses it with its text, whatever its arguments. So the call opens no window, and it reads no name and no credential. A call of `browser_sign_in` sends check 1's one refusal `end` with the result `remote` (C12: an act id of its own, no `start`, within the rate of the refusal ends) and gets the act's log line. A call of `browser_sign_ins` sends no event, as `AgentBrowser.signIns` sends none. While the service has no act, the transport gives check 1's text itself, with no event. The call passes no browser gate, and it is no use (C12). The MCP path also logs `mcp: MCP session <n> (scope <scope>): a tools/call of <tool> refused (a remote admission)`." },
  { file: "C11", why: "new: a local call is a tool call (the gate, the use, no cancel); no act, no tools", old: "", text: "A local admission on the MCP path. A call of either tool is a tool call of its MCP session: it passes the browser gate first (the start at a use), and it counts as a use until the act's method ends, also after its client has gone. A cancel while the call waits at the browser gate ends the call: its id is free at once, its POST gets the cancelled answer, and no act starts. A call whose client leaves during that wait starts no act either. Once the act's method runs, no cancel stops it: a `notifications/cancelled` of the call then changes nothing, its id stays busy, and its POST gets the act's answer. While the service has no act (the Mac until stage 4, and a service with no store, native link, lists or Chrome unit), a `tools/list` holds neither tool, and a call of either gets the allow list's `-32601` answer." },
  { file: "C11", why: "new: the tools' results", old: "", text: "What the MCP tools give: a tool result with one text item. `browser_sign_in` gives the success's text (what the agent sees, below), made from the record's origin alone, or on a refusal a tool error (`isError: true`) with the text `Not signed in: <text>`. `browser_sign_ins` gives the answer of `AgentBrowser.signIns` as compact JSON, `{\"state\":\"<state>\",\"signIns\":[{\"name\":\"<name>\",\"origin\":\"<origin>\"}]}`, with no other field. Another exception of the act gets the MCP path's fixed 500 (`The agent browser could not answer this request.`), which echoes nothing." },
  { file: "C12P", why: "the sign_in event: also from the MCP tool of a local admission; none for a remote one", old: "`sign_in` comes from the sign-in act's method, `AgentBrowser.signIn` (C11), for each request. `act` is an id", text: "`sign_in` comes from the sign-in act's method, `AgentBrowser.signIn` (C11), for each request, also for each call of the MCP tool `browser_sign_in` that reaches the method (C11). A call that a remote token admitted never gets past the method's check 1 (C11): it sends check 1's one refusal `end`, with the result `remote`. `act` is an id" },
  { file: "ALLOWP", why: "the service tools in tools/list (no longer: until stage 1e)", old: "- Until stage 1e (board ab-v16.97.5) serves them, the service's own tools are in no `tools/list`, and a `tools/call` of one gets the `-32601` answer of a tool that `tools` does not name.", text: "- The service's own tools are in a `tools/list` only for a request with a local admission while the service has the part that serves each of them (C11), after the tools of `tools`, each as `{\"name\",\"description\",\"inputSchema\"}` with its `description` and its `schema`. While the service does not have that part, a `tools/call` of the tool with a local admission gets the `-32601` answer of a tool that `tools` does not name." },
  { file: "ALLOWP", why: "a local call's arguments that are no object", old: "For a request with a local admission, an argument key that the tool's `keys` does not name gets the `-32602` answer above;", text: "For a request with a local admission, `arguments` that is not a JSON object, or an argument key that the tool's `keys` does not name, gets its `-32602` answer above; else the service runs the sign-in act's method or PageFetch for the MCP session's scope (C11, the sign-in act and PageFetch)." },
];
// Review-130 (the fix round of board ab-v16.97.5): each changed text, old at d865373, then new; each old text is gone.
const MCP_SIGN_IN_R1: { file: string; why: string; old: string; text: string }[] = [
  {"file": "C11", "why": "open point 1: a remote call goes to the act's check 1, with its refusal end", "old": "A remote admission on the MCP path. The transport answers a call of either tool at once with the tool error of check 1, whatever its arguments, also while the service has no act. The call never reaches the act: it starts no act, it sends no `sign_in` event (C12), and the act logs no line for it. It passes no browser gate, and it is no use (C12). Its log line is the MCP path's: `mcp: MCP session <n> (scope <scope>): a tools/call of <tool> refused (a remote admission)`.", "text": "A remote admission on the MCP path. The transport gives a call of either tool at once to the act's method with the admission `remote` and no argument of the client, and the act's check 1 refuses it with its text, whatever its arguments. So the call opens no window, and it reads no name and no credential. A call of `browser_sign_in` sends check 1's one refusal `end` with the result `remote` (C12: an act id of its own, no `start`, within the rate of the refusal ends) and gets the act's log line. A call of `browser_sign_ins` sends no event, as `AgentBrowser.signIns` sends none. While the service has no act, the transport gives check 1's text itself, with no event. The call passes no browser gate, and it is no use (C12). The MCP path also logs `mcp: MCP session <n> (scope <scope>): a tools/call of <tool> refused (a remote admission)`."},
  {"file": "C11", "why": "note 1: a cancel at the browser gate ends the call", "old": "A local admission on the MCP path. A call of either tool is a tool call of its MCP session: it passes the browser gate first (the start at a use), and it counts as a use until the act's method ends, also after its client has gone. No cancel stops a running act: a `notifications/cancelled` of the call changes nothing, its id stays busy, and its POST gets the act's answer. A call whose client leaves while it waits at the browser gate starts no act. While the service has no act (the Mac until stage 4, and a service with no store, native link, lists or Chrome unit), a `tools/list` holds neither tool, and a call of either gets the allow list's `-32601` answer.", "text": "A local admission on the MCP path. A call of either tool is a tool call of its MCP session: it passes the browser gate first (the start at a use), and it counts as a use until the act's method ends, also after its client has gone. A cancel while the call waits at the browser gate ends the call: its id is free at once, its POST gets the cancelled answer, and no act starts. A call whose client leaves during that wait starts no act either. Once the act's method runs, no cancel stops it: a `notifications/cancelled` of the call then changes nothing, its id stays busy, and its POST gets the act's answer. While the service has no act (the Mac until stage 4, and a service with no store, native link, lists or Chrome unit), a `tools/list` holds neither tool, and a call of either gets the allow list's `-32601` answer."},
  {"file": "C12P", "why": "open point 1: the sign_in event of a remote call", "old": "`sign_in` comes from the sign-in act's method, `AgentBrowser.signIn` (C11), for each request, also for a call of the MCP tool `browser_sign_in` with a local admission. A call of an MCP tool that a remote token admitted never reaches the act (C11), so it sends no `sign_in` event. `act` is an id", "text": "`sign_in` comes from the sign-in act's method, `AgentBrowser.signIn` (C11), for each request, also for each call of the MCP tool `browser_sign_in` that reaches the method (C11). A call that a remote token admitted never gets past the method's check 1 (C11): it sends check 1's one refusal `end`, with the result `remote`. `act` is an id"},
  {"file": "ALLOWP", "why": "note 3: tools/list, while the service has the act", "old": "- `tools/list`: the service drops each tool that `tools` does not name, and adds each tool of `service_tools` for a request with a local admission; a request that a remote token admitted gets no tool of `service_tools`.", "text": "- `tools/list`: the service drops each tool that `tools` does not name, and adds each tool of `service_tools` for a request with a local admission while the service has the part that serves it (the sign-in act for `browser_sign_in` and `browser_sign_ins`, PageFetch for `PageFetch`); a request that a remote token admitted gets no tool of `service_tools`."},
];
test("review-130: C11, C12 and the allow list's format say each text of the fix round exactly, and no text of d865373 that it replaced", () => {
  const files: Record<string, string> = { C11, C12P, ALLOWP };
  assert.equal(MCP_SIGN_IN_R1.length, 4);
  for (const e of MCP_SIGN_IN_R1) {
    assert.ok(says(files[e.file], payNow(e.text)), `${e.file}, ${e.why}: ${e.text.slice(0, 160)}`);
    assert.ok(!says(files[e.file], e.old), `${e.file}, ${e.why}: the old text is gone: ${e.old.slice(0, 120)}`);
  }
  for (const e of MCP_SIGN_IN_R1.filter((x) => x.file === "C11")) assert.ok(SIGN_IN_ITEMS.includes(e.text), "the sign-in act's part holds it as one item");
});

test("board ab-v16.97.5: C11, C12 and the allow list's format say each text of the stored sign-ins' MCP tools exactly, and no old text", () => {
  const files: Record<string, string> = { C11, C12P, ALLOWP };
  assert.equal(MCP_SIGN_IN.length, 8);
  for (const e of MCP_SIGN_IN) {
    assert.ok(says(files[e.file], payNow(e.text)), `${e.file}, ${e.why}: ${e.text.slice(0, 160)}`);
    if (e.old && !flat(e.text).includes(flat(e.old))) assert.ok(!says(files[e.file], e.old), `${e.file}, ${e.why}: the old text is gone: ${e.old.slice(0, 120)}`);
  }
  for (const e of MCP_SIGN_IN.filter((x) => x.file === "C11")) assert.ok(SIGN_IN_ITEMS.includes(e.text), `the sign-in act's part holds it as one item: ${e.text.slice(0, 80)}`);
  // C12 stays transport-neutral: it names an MCP tool, never the MCP port or a flag of the MCP path.
  assert.ok(!/MCP port|--test-mcp-port|--test-mcp-remote-scope|agent-browser-mcp\.socket/.test(C12P), "C12 names no MCP port and no flag of it");
});

test("board ab-v16.97.5: the texts of the MCP tools are the code's: check 1's text, the success's text, the log line, the fixed 500, the -32601 answer and the flag", async () => {
  const ar = await import("../src/service/signins/act-rules.ts");
  const port = await import("../src/service/mcp/port.ts");
  const al = await import("../src/service/mcp/allow-list.ts");
  const main = await import("../src/service/main.ts");
  const transport = readOr("src/service/mcp/transport.ts");
  assert.ok(says(ALLOWP, `\`Not signed in: ${ar.ACT_TEXT.remote}\``), "the allow list's format names check 1's tool error");
  assert.ok(transport.includes("if (e instanceof ActRefusal) return toolResult(id, e.message, true);") && transport.includes("else await act.signIn(caller, {});"), "a remote call: the act's own check 1 and its text, as a tool error");
  assert.ok(transport.includes("const text = `Not signed in: ${ACT_TEXT.remote}`;"), "with no act: check 1's text of the act's rules");
  assert.ok(transport.includes("this.o.log(`mcp: MCP session ${s.n} (scope ${scope}): a tools/call of ${params.name as string} refused (a remote admission)`);"), "the transport's log line");
  assert.ok(says(C11, "`mcp: MCP session <n> (scope <scope>): a tools/call of <tool> refused (a remote admission)`"), "C11 names the log line");
  assert.ok(transport.includes("return toolResult(id, signedInText(r.origin));") && says(C11, `\`${ar.signedInText("<origin>")}\``), "the success's text is C11's");
  assert.ok(says(C11, `(\`${port.MCP_FAILED}\`)`), "C11 names the fixed 500");
  assert.ok(says(ALLOWP, `\`${al.refuseTool("<tool>").message}\``), "the -32601 answer");
  assert.match(main.SERVICE_USAGE, /--test-mcp-remote-scope SCOPE/);
});

test("review-115 B2: C11's table of the transport's answers is the code's table, row for row: each status, code and text, and no answer of the code without its row", async () => {
  const t = await import("../src/service/mcp/transport.ts");
  const lines = C11.split("\n");
  const at = lines.indexOf("| Case | HTTP status | JSON-RPC code | Text |");
  assert.ok(at >= 0, "C11's table of the transport's answers");
  const rows: string[] = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith("| ")) break;
    const cells = line.slice(2, -2).split(" | ");
    const code = /^`(-\d+)`$/.exec(cells[2]), text = /^`(.+)`$/.exec(cells[3]);
    assert.ok(code && text && /^\d{3}$/.test(cells[1]), line);
    rows.push(JSON.stringify([Number(cells[1]), Number(code![1]), text![1]]));
  }
  const ours = Object.values(t.MCP_ANSWERS).map((a: any) => JSON.stringify([a.status, a.code, a.text]));
  assert.deepEqual([...rows].sort(), [...ours].sort(), "the same answers");
  assert.equal(new Set(ours).size, ours.length, "each answer once");
  for (const s of Object.values(t.MCP_ANSWERS) as any[]) assert.doesNotMatch(s.text, /\b(stop|start|restart)/i, s.text);
});

// Board ab-v16.94.12 (review-115b, the narrow re-check of PR #115, and review-115's note 3): each changed or new text of
// C11, C12 and the allow list's format, exactly; each old text that it replaced is gone (an empty `old` is a new text).
// The list of old and new texts is in the PR's body for the daemon lead.
const REVIEW_115B: { file: string; why: string; old: string; text: string }[] = [
  {"file": "C11", "why": "review-115b P2 and its note: the service's cancel frees the id at once; a client's own cancel gets an answer", "old": "A client that closes its connection before its answer cancels that request (`notifications/cancelled`).", "text": "A client that closes its connection before its answer cancels that request: when the MCP has the request, the service sends it `notifications/cancelled`, and the service frees the request's id at once (the MCP never answers a request that it cancelled), so a later request with that id goes on. An answer that the MCP sent before it got the cancel goes nowhere: it never becomes the answer of a later request with that id (board ab-v16.94.20). The worker keeps a cancel that the pinned MCP does not ignore (below) of a `browser_close` call that runs, or of a request that waits for the end of one, from the MCP; until such a call has ended, the worker holds each later message of the MCP session other than a cancel, also `notifications/initialized` (the MCP inside the service, above; board ab-v16.94.18 and ab-v16.94.20). A client's own `notifications/cancelled` of a request of its MCP session that still waits reaches the MCP too, and it frees that id at once; the request's POST, while it is open, gets HTTP 200 with `-32800` and `Request cancelled: the client sent notifications/cancelled for this request.` (a tool call that waits for the start at a use gets it when that wait ends, or that wait's refusal). The MCP has no code of its own for a cancelled request, and `-32800` is the code that the Language Server Protocol gives one. The pinned MCP ignores a cancel whose `requestId` is `0` or `\"\"`, or whose `params` its schema refuses (a `reason` that is no string), and it then runs the call and answers it. So once the MCP has the request, such a cancel frees nothing: the id stays busy until the MCP's answer or the end of its MCP session, and while the POST is open, the MCP's answer goes to it and a tool call counts as a use. For a client that closes its connection, the service sends no cancel for the id `0` or `\"\"`, and the tool call is no use from that close on (board ab-v16.94.14): the pinned `browser_evaluate` has no time limit, so a script that never settles would otherwise keep Chrome from its stop by use until the MCP session ends."},
  {"file": "C11", "why": "review-115b P4: the id null of a body of another shape", "old": "", "text": "The transport's answers: each answer of an error carries the request's id, or `null` when the request has none that the service can read (a body that is no JSON-RPC 2.0 message of the shapes below has none)."},
  {"file": "C11", "why": "review-115b P3: the MCP's own answers, passed on with HTTP 200", "old": "(`docs/contracts/mcp-allow-list.md`), and the 202 and the 200 above.", "text": "The transport gives no other answer than these, the HTTP 200 answers of the allow list's format (`docs/contracts/mcp-allow-list.md`), the 202 and the 200 above, and the MCP's own answers: the result or the JSON-RPC error that the MCP gives to a request that reaches it, which the transport passes on with HTTP 200 (for `tools/list`, with only the list's tools and keys; for a remote admission, a `tools/call` answer within the limit above, or else its tool error)."},
  {"file": "C11", "why": "review-115b P4 and its note on safe integers: the 400 row of a body of another shape", "old": "| A body that is JSON but no JSON-RPC 2.0 message, or a request whose id is no string and no integer | 400 | `-32600` | `Invalid Request` |", "text": "| A body that is JSON but no JSON-RPC 2.0 message of the three shapes below, also a message whose id is no string and no safe integer | 400 | `-32600` | `Invalid Request` |"},
  {"file": "C11", "why": "review-115b's note: the row of a request that its client cancelled", "old": "", "text": "| A request that its client cancelled with its own `notifications/cancelled` while its POST is open | 200 | `-32800` | `Request cancelled: the client sent notifications/cancelled for this request.` |"},
  {"file": "C11", "why": "review-115b P4 and its note on safe integers: the three shapes, the safe integer, the wait of a request", "old": "- A request's id is a string or an integer: a request with another id never reaches the MCP.", "text": "- A JSON-RPC 2.0 message is a JSON object with `jsonrpc` `\"2.0\"` in one of three shapes, with no other member: a request (`jsonrpc`, an `id`, a `method` that is a string, and a `params` or none), a notification (`jsonrpc`, a `method` that is a string, and a `params` or none), or a client's answer (`jsonrpc`, an `id`, and exactly one of `result` and `error`). A `params` is a JSON object; its `_meta`, when it has one, is a JSON object whose `progressToken`, when it has one, is a string or a safe integer, and whose `io.modelcontextprotocol/related-task`, when it has one, is a JSON object with a string `taskId`. An `id` is a string or a safe integer: an integer from -(2^53 - 1) to 2^53 - 1 (a larger one loses its exact value in the service's JSON parse). The shapes of a request and of a notification are exactly the shapes that the MCP's own SDK takes: it gives no answer to a request of another shape (the pinned version: an extra member, a `params` that is no object, a `_meta` that is no object), so a body of another shape never reaches the MCP. A client's answer never reaches the MCP (the service sends no request to the client), so its shape is the transport's own (the SDK would also take an error with no id). A request whose id is the id of a request of the same MCP session that still waits never reaches the MCP either, and the waiting request keeps its own answer. A request waits until its answer or its cancel, from the moment that it passes the transport's checks (a tool call also while it waits for the start at a use)."},
  {"file": "C11", "why": "review-115 note 3: the scope's folder lives as long as the scope's session", "old": "", "text": "- The scope's folder lives as long as the scope's agentwatch session (review-115 note 3). At C12's `session_ended`, and at each C12 `set_sessions` for each scope that the snapshot names neither in `sessions` nor in `remote` (also a session that ended while the service was down, which got no `session_ended`), the service ends the scope's MCP sessions and, after the request's answer and once every worker of the scope has stopped, removes the scope's folder with its files. So a later session of the same launch name does not read the files of an earlier one, and its first MCP session makes the folder again; an MCP session of the scope that begins before those workers have stopped keeps the folder and its files until the next `session_ended` of the scope or the next `set_sessions` that names the scope neither in `sessions` nor in `remote`, also after that MCP session ends (a `DELETE`, its worker's end): that message ends the scope's MCP sessions that are still open and then removes them as above. While two live sessions share a launch name, the daemon sends no item for that name (C12, the field rules; the vectors' `r14`), so the service removes that name's folder while the earlier session lives, as it removes the list copy (C12). The service removes only a folder or a link whose name is a scope, and only while `<state>/mcp` is a folder of the service's user that is no link; a link in the scope's place or in the folder goes as a link, and its target stays, and another entry of a scope's name (a plain file) stays. A removal that fails gets a log line with the scope and the error's code, never a path. The service's own stop removes no folder."},
  {"file": "C12", "why": "review-115 note 3: session_ended removes the MCP folder", "old": "closes its MCP connections and ends its MCP sessions (C11), removes its list copy, and records the ended scope.", "text": "closes its MCP connections, ends its MCP sessions and, after its answer, once the scope's MCP workers have stopped, removes its MCP folder with its files (C11), removes its list copy, and records the ended scope."},
  {"file": "C12", "why": "review-115 note 3: set_sessions removes the MCP folder of each scope that it does not name", "old": "", "text": "It removes the MCP folder of each scope that the snapshot does not name, with its files, after its answer, once the scope's MCP workers have stopped (C11). Each `set_sessions` is the daemon's whole list of live sessions: a scope that a snapshot leaves out loses its MCP sessions and its MCP folder with its files. So after its start the daemon sends its first `set_sessions` only when its own discovery of the live sessions is complete."},
  {"file": "ALLOWP", "why": "review-115b P1: no exception for a string with enum or const", "old": "", "text": "is left out of `keys`, with no exception for a string whose values an `enum` or a `const` fixes, with the `type` `string` or with no `type`;"},
];
test("board ab-v16.94.12: C11, C12 and the allow list's format say each text of review-115b and of note 3 exactly, and no replaced text", () => {
  const files: Record<string, string> = { C11, C12: C12P, ALLOWP };
  assert.equal(REVIEW_115B.length, 10);
  for (const e of REVIEW_115B) {
    assert.ok(says(files[e.file], longNow(e.text)), `${e.file}, ${e.why}: ${e.text.slice(0, 160)}`);
    if (e.old !== "" && !flat(e.text).includes(flat(e.old))) assert.ok(!says(files[e.file], e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
  assert.ok(!/MCP port|--test-mcp-port|agent-browser-mcp\.socket/.test(C12P), "C12 names no MCP port");
  // "integer" only as a safe integer in the transport's part (review-115b's note).
  const transport = partOr("The transport of the MCP path (from stage 1d; the self-contained design, section 8.2).");
  assert.ok(transport.length > 0);
  assert.doesNotMatch(flat(transport), /string or an integer|no string and no integer/, "the transport's part names a safe integer, as the code takes it");
  assert.ok(says(transport, "An `id` is a string or a safe integer: an integer from -(2^53 - 1) to 2^53 - 1"));
});

test("board ab-v16.94.12: the texts are the code's: the cancelled answer, the shapes' members, the safe integer and the folder's log line", async () => {
  const t = await import("../src/service/mcp/transport.ts") as any;
  assert.deepEqual(t.MCP_ANSWERS.cancelled, { status: 200, code: -32800, text: "Request cancelled: the client sent notifications/cancelled for this request." });
  assert.ok(says(C11, `HTTP 200 with \`-32800\` and \`${t.MCP_ANSWER.cancelled}\``), "C11 names the cancelled answer with its code");
  const shape = t.messageShape as (m: unknown) => string | null;
  assert.equal(shape({ jsonrpc: "2.0", id: 2 ** 53 - 1, method: "ping" }), "request");
  assert.equal(shape({ jsonrpc: "2.0", id: 2 ** 53, method: "ping" }), null, "no safe integer");
  assert.equal(shape({ jsonrpc: "2.0", id: 1, method: "ping", extra: 1 }), null, "no other member");
  assert.equal(shape({ jsonrpc: "2.0", id: 1, method: "ping", params: { _meta: { "io.modelcontextprotocol/related-task": { taskId: "t" } } } }), "request", "the related task's key of C11");
  assert.ok(says(C11, "`io.modelcontextprotocol/related-task`"));
  // The folder's log line (review-121 note 7): the scope and the why, and no path.
  const { mkdirSync, writeFileSync, rmSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { readAllowList } = await import("../src/service/mcp/allow-list.ts");
  const dir = tempDir("ab-c11-folder-log-");
  const log: string[] = [];
  const tr = new t.McpTransport({ list: readAllowList(), stateFolder: dir, ticketUrl: () => null, log: (l: string) => log.push(l) });
  try {
    mkdirSync(join(dir, "mcp", "web-1"), { recursive: true });
    writeFileSync(join(dir, "mcp", "web-1", "f.txt"), "a test file");
    await tr.dropScope("web-1", "its session ended");
    assert.equal(existsSync(join(dir, "mcp", "web-1")), false);
    assert.deepEqual(log, ["mcp: the folder of scope web-1 is emptied (its session ended)"]);
    assert.ok(says(C11, "A removal that fails gets a log line with the scope and the error's code, never a path."));
  } finally { await tr.stop(); rmSync(dir, { recursive: true, force: true }); }
});

// Board ab-v16.94.12, review-121's fix round: each changed text of C11, C12 and the allow list's format, exactly; each
// old text (the PR's first head, 7d9544c) is gone. The list is in the PR's body for the daemon lead.
const REVIEW_121: { file: string; why: string; old: string; text: string }[] = [
  {"file": "C11", "why": "review-121 notes 1 and 2: the cancel goes to the MCP only when it has the request; a cancel that the MCP ignores frees nothing", "old": "A client that closes its connection before its answer cancels that request: the service sends `notifications/cancelled` to the MCP, and it frees the request's id at once (the MCP never answers a cancelled request), so a later request with that id goes on. A client's own `notifications/cancelled` of a request of its MCP session that still waits reaches the MCP too, and it frees that id at once; the request's POST, while it is open, gets HTTP 200 with `-32800` and `Request cancelled: the client sent notifications/cancelled for this request.` (a tool call that waits for the start at a use gets it when that wait ends, or that wait's refusal). The MCP has no code of its own for a cancelled request, and `-32800` is the code that the Language Server Protocol gives one.", "text": "A client that closes its connection before its answer cancels that request: when the MCP has the request, the service sends it `notifications/cancelled`, and the service frees the request's id at once (the MCP never answers a request that it cancelled), so a later request with that id goes on. An answer that the MCP sent before it got the cancel goes nowhere: it never becomes the answer of a later request with that id (board ab-v16.94.20). The worker keeps a cancel that the pinned MCP does not ignore (below) of a `browser_close` call that runs, or of a request that waits for the end of one, from the MCP; until such a call has ended, the worker holds each later message of the MCP session other than a cancel, also `notifications/initialized` (the MCP inside the service, above; board ab-v16.94.18 and ab-v16.94.20). A client's own `notifications/cancelled` of a request of its MCP session that still waits reaches the MCP too, and it frees that id at once; the request's POST, while it is open, gets HTTP 200 with `-32800` and `Request cancelled: the client sent notifications/cancelled for this request.` (a tool call that waits for the start at a use gets it when that wait ends, or that wait's refusal). The MCP has no code of its own for a cancelled request, and `-32800` is the code that the Language Server Protocol gives one. The pinned MCP ignores a cancel whose `requestId` is `0` or `\"\"`, or whose `params` its schema refuses (a `reason` that is no string), and it then runs the call and answers it. So once the MCP has the request, such a cancel frees nothing: the id stays busy until the MCP's answer or the end of its MCP session, and while the POST is open, the MCP's answer goes to it and a tool call counts as a use. For a client that closes its connection, the service sends no cancel for the id `0` or `\"\"`, and the tool call is no use from that close on (board ab-v16.94.14): the pinned `browser_evaluate` has no time limit, so a script that never settles would otherwise keep Chrome from its stop by use until the MCP session ends."},
  {"file": "C11", "why": "review-121 note 3: the SDK's shapes for a request and a notification; a client's answer never reaches the MCP", "old": "These are the shapes that the MCP's own SDK takes: it gives no answer to a message of another shape (the pinned version: an extra member, a `params` that is no object, a `_meta` that is no object), so a body of another shape never reaches the MCP.", "text": "The shapes of a request and of a notification are exactly the shapes that the MCP's own SDK takes: it gives no answer to a request of another shape (the pinned version: an extra member, a `params` that is no object, a `_meta` that is no object), so a body of another shape never reaches the MCP. A client's answer never reaches the MCP (the service sends no request to the client), so its shape is the transport's own (the SDK would also take an error with no id)."},
  {"file": "C11", "why": "review-121 B3, B2 and notes 4 to 6: a shared launch name, a failed removal, every stopping worker, after the answer, only a folder or a link", "old": "- The scope's folder lives as long as the scope's agentwatch session (review-115 note 3). At C12's `session_ended`, and at each C12 `set_sessions` for each scope that the snapshot names neither in `sessions` nor in `remote` (also a session that ended while the service was down, which got no `session_ended`), the service ends the scope's MCP sessions and, once the scope's worker has stopped, removes the scope's folder with its files. So a later session of the same launch name never reads the files of an earlier one, and its first MCP session makes the folder again. The service removes only a folder whose name is a scope, and only while `<state>/mcp` is a folder of the service's user that is no link; a link in the scope's place goes as a link, and its target stays. A new MCP session of the scope before that stop keeps the folder. The service's own stop removes no folder.", "text": "- The scope's folder lives as long as the scope's agentwatch session (review-115 note 3). At C12's `session_ended`, and at each C12 `set_sessions` for each scope that the snapshot names neither in `sessions` nor in `remote` (also a session that ended while the service was down, which got no `session_ended`), the service ends the scope's MCP sessions and, after the request's answer and once every worker of the scope has stopped, removes the scope's folder with its files. So a later session of the same launch name does not read the files of an earlier one, and its first MCP session makes the folder again; an MCP session of the scope that begins before those workers have stopped keeps the folder and its files until the next `session_ended` of the scope or the next `set_sessions` that names the scope neither in `sessions` nor in `remote`, also after that MCP session ends (a `DELETE`, its worker's end): that message ends the scope's MCP sessions that are still open and then removes them as above. While two live sessions share a launch name, the daemon sends no item for that name (C12, the field rules; the vectors' `r14`), so the service removes that name's folder while the earlier session lives, as it removes the list copy (C12). The service removes only a folder or a link whose name is a scope, and only while `<state>/mcp` is a folder of the service's user that is no link; a link in the scope's place or in the folder goes as a link, and its target stays, and another entry of a scope's name (a plain file) stays. A removal that fails gets a log line with the scope and the error's code, never a path. The service's own stop removes no folder."},
  {"file": "C12", "why": "review-121 note 5: session_ended removes the folder after its answer, once the workers have stopped", "old": "closes its MCP connections, ends its MCP sessions and removes its MCP folder with its files (C11), removes its list copy, and records the ended scope.", "text": "closes its MCP connections, ends its MCP sessions and, after its answer, once the scope's MCP workers have stopped, removes its MCP folder with its files (C11), removes its list copy, and records the ended scope."},
  {"file": "C12", "why": "the daemon lead's point P1 and review-121 note 5: each set_sessions is the daemon's whole list; its first one after a start only when its discovery is complete", "old": "It removes the MCP folder of each scope that the snapshot does not name, with its files (C11).", "text": "It removes the MCP folder of each scope that the snapshot does not name, with its files, after its answer, once the scope's MCP workers have stopped (C11). Each `set_sessions` is the daemon's whole list of live sessions: a scope that a snapshot leaves out loses its MCP sessions and its MCP folder with its files. So after its start the daemon sends its first `set_sessions` only when its own discovery of the live sessions is complete."},
  {"file": "ALLOWP", "why": "review-121 notes 8 and 9: the exception's rule inside the rule of file and path keys, with no type too", "old": "- the rule of file and path keys has no exception for a string whose values an `enum` or a `const` fixes: such a string that speaks of a file or a path is in `paths`, or is left out of `keys`, as any string (`browser_take_screenshot`'s `type` is an `enum` string of this kind).", "text": "- each string property whose schema speaks of a file or a path (its name or its description) is in `paths`, or is left out of `keys`, with no exception for a string whose values an `enum` or a `const` fixes, with the `type` `string` or with no `type`; a schema speaks of a file or a path when its name or its description holds `file`, `path`, `folder` or `directory`, in any case, also inside a word (so `browser_take_screenshot`'s `type`, an `enum` string whose description names the file name's extension, is left out of `keys` in the first list); the test reads each string inside a key's schema too, in `anyOf`, `oneOf`, `allOf`, `items`, nested `properties`, `additionalProperties` and `propertyNames`, with the names and descriptions on its way, and a key whose schema has a shape that the test cannot read (no `type` and no `anyOf`, `oneOf`, `allOf`, `enum` or `const`, a `$ref`, or a keyword that the test does not know) fails the test;"},
];
test("board ab-v16.94.12, review-121: C11, C12 and the allow list's format say each text of the fix round exactly, and no replaced text", () => {
  const files: Record<string, string> = { C11, C12: C12P, ALLOWP };
  assert.equal(REVIEW_121.length, 6);
  for (const e of REVIEW_121) {
    assert.ok(says(files[e.file], e.text), `${e.file}, ${e.why}: ${e.text.slice(0, 160)}`);
    if (!flat(e.text).includes(flat(e.old))) assert.ok(!says(files[e.file], e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
  // The format's exception is a part of the rule of file and path keys, not a rule of its own (review-121 note 9).
  assert.ok(!/^- the rule of file and path keys/m.test(ALLOWP));
  assert.ok(!/MCP port|--test-mcp-port|agent-browser-mcp\.socket/.test(C12P), "C12 names no MCP port");
});

// Board ab-v16.94.14 (the small points of review-121b): each changed text of C11 and C12, from main before the task
// (old) to the task's text (new); each old text is gone. The PR's body lists them for the daemon lead.
const REVIEW_121B: { file: string; why: string; old: string; text: string }[] = [
  {"file": "C11", "why": "O1 and N4 (R1): a tool call with the id 0 or \"\" is no use from its client's close; the id stays busy until the MCP's answer or the end of its MCP session", "old": "So once the MCP has the request, such a cancel frees nothing: the id stays busy and a tool call counts as a use until the MCP's answer, which goes to the POST while it is open; for a client that closes its connection, the service sends no cancel for the id `0` or `\"\"`.", "text": "So once the MCP has the request, such a cancel frees nothing: the id stays busy until the MCP's answer or the end of its MCP session, and while the POST is open, the MCP's answer goes to it and a tool call counts as a use. For a client that closes its connection, the service sends no cancel for the id `0` or `\"\"`, and the tool call is no use from that close on (board ab-v16.94.14): the pinned `browser_evaluate` has no time limit, so a script that never settles would otherwise keep Chrome from its stop by use until the MCP session ends."},
  {"file": "C11", "why": "N4 (R3): an MCP session that begins before the workers have stopped keeps the folder while it lives", "old": "So a later session of the same launch name does not read the files of an earlier one, and its first MCP session makes the folder again; an MCP session of the scope that begins before those workers have stopped keeps the folder and its files.", "text": "So a later session of the same launch name does not read the files of an earlier one, and its first MCP session makes the folder again; an MCP session of the scope that begins before those workers have stopped keeps the folder and its files until the next `session_ended` of the scope or the next `set_sessions` that names the scope neither in `sessions` nor in `remote`, also after that MCP session ends (a `DELETE`, its worker's end): that message ends the scope's MCP sessions that are still open and then removes them as above."},
  {"file": "C12", "why": "O1: a tool call of the MCP whose client closed its connection is no use", "old": "An MCP session counts only by its tool calls, while Chrome runs and at step 8 (C11). An open MCP session", "text": "An MCP session counts only by its tool calls, while Chrome runs and at step 8 (C11). A tool call that the MCP runs (not a call of one of the service's own tools) whose client closed its connection is no use from that close on, also when the MCP runs it on to its answer (C11); a call of one of the service's own tools with a local admission stays a use until its method ends (the sign-in act's method, or PageFetch's), also after its client's close (C11, the sign-in act and PageFetch)."},
];
test("board ab-v16.94.14: C11 and C12 say each text of O1 and N4 exactly, and no replaced text", () => {
  const files: Record<string, string> = { C11, C12: C12P };
  assert.equal(REVIEW_121B.length, 3);
  for (const e of REVIEW_121B) {
    assert.ok(says(files[e.file], e.text), `${e.file}, ${e.why}: ${e.text.slice(0, 160)}`);
    assert.ok(!says(files[e.file], e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
  assert.ok(!/MCP port|--test-mcp-port|agent-browser-mcp\.socket/.test(C12P), "C12 names no MCP port");
});

// Board ab-v16.94.15 (the notes of review-134): each changed text of C11 and C12, from main before the task (old) to the
// task's text (new); each old text is gone. The PR's body lists them for the daemon lead.
const REVIEW_134: { file: string; why: string; old: string; text: string }[] = [
  {"file": "C11", "why": "note 2 (R3): the folder stays until the next session_ended or set_sessions without the scope, also after that MCP session's end (a DELETE removes no folder)", "old": "So a later session of the same launch name does not read the files of an earlier one, and its first MCP session makes the folder again; an MCP session of the scope that begins before those workers have stopped keeps the folder and its files while it lives: the next `session_ended` of the scope, or the next `set_sessions` that names the scope neither in `sessions` nor in `remote`, ends that MCP session too and then removes them as above.", "text": "So a later session of the same launch name does not read the files of an earlier one, and its first MCP session makes the folder again; an MCP session of the scope that begins before those workers have stopped keeps the folder and its files until the next `session_ended` of the scope or the next `set_sessions` that names the scope neither in `sessions` nor in `remote`, also after that MCP session ends (a `DELETE`, its worker's end): that message ends the scope's MCP sessions that are still open and then removes them as above."},
  {"file": "C12", "why": "note 3: the rule of a closed client is for a call that the MCP runs; a call of the service's own tools stays a use until its act ends", "old": "A tool call of the MCP whose client closed its connection is no use from that close on, also when the MCP runs it on to its answer (C11).", "text": "A tool call that the MCP runs (not a call of one of the service's own tools) whose client closed its connection is no use from that close on, also when the MCP runs it on to its answer (C11); a call of one of the service's own tools with a local admission stays a use until its method ends (the sign-in act's method, or PageFetch's), also after its client's close (C11, the sign-in act and PageFetch)."},
];
test("board ab-v16.94.15: C11 and C12 say each text of notes 2 and 3 of review-134 exactly, and no replaced text", () => {
  const files: Record<string, string> = { C11, C12: C12P };
  assert.equal(REVIEW_134.length, 2);
  for (const e of REVIEW_134) {
    assert.ok(says(files[e.file], e.text), `${e.file}, ${e.why}: ${e.text.slice(0, 160)}`);
    assert.ok(!says(files[e.file], e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
});

// Board ab-v16.94.16 (F1 and F4 of the MCP live harness, PR #142): each changed text of C11, from main before the task
// (old) to the task's text (new); each old text is gone. The PR's body lists them for the daemon lead.
const BOARD_94_16: { file: string; why: string; old: string; text: string }[] = [
  { file: "C11", why: "F4: at the scope's limit, the MCP session with no request that waits and the oldest last message or answer gives its place", old: "or, at the service's limit, `The agent browser serves at most 32 MCP sessions, and each is in use. Initialize again later.` - Its configuration is fixed:", text: "or, at the service's limit, `The agent browser serves at most 32 MCP sessions, and each is in use. Initialize again later.` At the scope's limit, an `initialize` first ends one MCP session of the scope that has no request that waits: the one whose client sent its last message, or got its last answer, first (board ab-v16.94.16). The MCP SDK's client sends no `DELETE` at its `close()`, so a client that reconnects leaves its old MCP session open, and that session gives its place. The service cannot tell such an old MCP session from the MCP session of a live client that has no request that waits, so a live client's MCP session can give its place too, and more than 4 clients that work in one scope can end each other's MCP sessions again and again (board ab-v16.94.18). The ended session's next request gets the 404 of an unknown MCP session. The service ends that MCP session before it makes the new one: when the new one then cannot be made (the 503 of an `initialize` whose MCP session the service cannot make; the `-32603` answer `This MCP session has ended: …` when the worker or the new MCP session ends while its `initialize` waits for the MCP; the MCP's own error to the `initialize`; or an error of the service), the ended session stays ended (board ab-v16.94.18 and ab-v16.94.20). Only when each MCP session of the scope has a request that waits, or its `initialize` runs, does one more `initialize` get the 503 of the scope's limit. At most 16 of the service's 32 MCP sessions are remote (first value): MCP sessions whose `initialize` had a remote admission. One more `initialize` of a remote admission, at that limit or at the service's limit, gets HTTP 200 (not 503) with the JSON-RPC error `-32000` and the text `The agent browser has no free place for an MCP session of another box now: it serves at most 16 MCP sessions of other boxes, and at most 32 in all. Initialize again later.` A local initialize at the service's limit gets the 503 of the service's limit, as before. At a remote scope's own limit its MCP sessions give their place as a local scope's do. A scope with a `/` always has the remote admission. - Its configuration is fixed:" },
  { file: "C11", why: "F1: browser_close closes the MCP session's browser connection before its answer", old: "The ticket never leaves the service's process, and no log line holds it. - The MCP code of each scope", text: "The ticket never leaves the service's process, and no log line holds it. After the MCP's answer to a `browser_close` call, and before that answer goes to the client, the worker closes the MCP session's browser connection, as at the end of the MCP session, so the MCP connects again with a new ticket at its next tool that needs the browser (board ab-v16.94.16). The worker does so also when the client cancels the call, by its own `notifications/cancelled` or by the close of its connection, with a cancel that the pinned MCP does not ignore (the transport of the MCP path, below): the worker keeps that cancel from the MCP, the MCP runs the call to its answer, the worker closes the connection, and the answer goes nowhere (board ab-v16.94.18). From a `browser_close` call until the worker has closed the connection after its answer, each later message of the MCP session other than a cancel (each request, and also `notifications/initialized`) waits in the worker (board ab-v16.94.20), and the MCP then gets them in their order, so that no call reaches the browser that the MCP has closed. A cancel that the pinned MCP does not ignore removes such a waiting request, and it never reaches the MCP (board ab-v16.94.18). - The MCP code of each scope" },
];
test("board ab-v16.94.16: C11 says each text of F1 and F4 exactly, and no replaced text", () => {
  const files: Record<string, string> = { C11, C12: C12P };
  assert.equal(BOARD_94_16.length, 2);
  for (const e of BOARD_94_16) {
    assert.ok(says(files[e.file], e.text), `${e.file}, ${e.why}: ${e.text.slice(0, 160)}`);
    assert.ok(!says(files[e.file], e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
});

// Board ab-v16.94.18 (the notes of review-143 on PR #143): each changed text of C11, from main before the task (old)
// to the task's text (new); each old text is gone. The texts of BOARD_94_16 and of earlier lists above hold these
// changes too. The PR's body lists them for the daemon lead.
const BOARD_94_18: { file: string; why: string; old: string; text: string }[] = [
  { file: "C11", why: "N3 (review-143): a live client's quiet MCP session can give its place, and more than 4 active clients of one scope can end each other's; N7: the place goes before the new MCP session is made", old: "and that session gives its place. The ended session's next request gets the 404 of an unknown MCP session. Only when", text: "and that session gives its place. The service cannot tell such an old MCP session from the MCP session of a live client that has no request that waits, so a live client's MCP session can give its place too, and more than 4 clients that work in one scope can end each other's MCP sessions again and again (board ab-v16.94.18). The ended session's next request gets the 404 of an unknown MCP session. The service ends that MCP session before it makes the new one: when the new one then cannot be made (the 503 of an `initialize` whose MCP session the service cannot make; the `-32603` answer `This MCP session has ended: …` when the worker or the new MCP session ends while its `initialize` waits for the MCP; the MCP's own error to the `initialize`; or an error of the service), the ended session stays ended (board ab-v16.94.18 and ab-v16.94.20). Only when" },
  { file: "C11", why: "N3 (review-143): the table's 503 of the scope's limit comes only when no MCP session of the scope can give its place", old: "| One more `initialize` at the scope's limit | 503 |", text: "| One more `initialize` at the scope's limit, when no MCP session of the scope can give its place (each has a request that waits, or its `initialize` runs) | 503 |" },
  { file: "C11", why: "N1 and N2 (review-143): a cancelled browser_close closes the connection too; a later request waits until the close ends; a cancel removes a waiting request", old: "at its next tool that needs the browser (board ab-v16.94.16). - The MCP code of each scope", text: "at its next tool that needs the browser (board ab-v16.94.16). The worker does so also when the client cancels the call, by its own `notifications/cancelled` or by the close of its connection, with a cancel that the pinned MCP does not ignore (the transport of the MCP path, below): the worker keeps that cancel from the MCP, the MCP runs the call to its answer, the worker closes the connection, and the answer goes nowhere (board ab-v16.94.18). From a `browser_close` call until the worker has closed the connection after its answer, each later message of the MCP session other than a cancel (each request, and also `notifications/initialized`) waits in the worker (board ab-v16.94.20), and the MCP then gets them in their order, so that no call reaches the browser that the MCP has closed. A cancel that the pinned MCP does not ignore removes such a waiting request, and it never reaches the MCP (board ab-v16.94.18). - The MCP code of each scope" },
  { file: "C11", why: "N1 and N2 (review-143): the transport's rule of the cancel names the worker's two cases", old: "so a later request with that id goes on. A client's own", text: "so a later request with that id goes on. An answer that the MCP sent before it got the cancel goes nowhere: it never becomes the answer of a later request with that id (board ab-v16.94.20). The worker keeps a cancel that the pinned MCP does not ignore (below) of a `browser_close` call that runs, or of a request that waits for the end of one, from the MCP; until such a call has ended, the worker holds each later message of the MCP session other than a cancel, also `notifications/initialized` (the MCP inside the service, above; board ab-v16.94.18 and ab-v16.94.20). A client's own" },
];
test("board ab-v16.94.18: C11 says each text of review-143's notes 1, 2, 3 and 7 exactly, and no replaced text", () => {
  const files: Record<string, string> = { C11, C12: C12P };
  assert.equal(BOARD_94_18.length, 4);
  for (const e of BOARD_94_18) {
    assert.ok(says(files[e.file], e.text), `${e.file}, ${e.why}: ${e.text.slice(0, 160)}`);
    assert.ok(!says(files[e.file], e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
});

// Board ab-v16.94.20 (the notes of review-146 on PR #146): each changed or new text of C11, from main before the task
// (old) to the task's text (new); each old text is gone. The texts of BOARD_94_18 and of earlier lists above hold these
// changes too. The PR's body lists them for the daemon lead.
const BOARD_94_20: { file: string; why: string; old: string; text: string }[] = [
  { file: "C11", why: "N1 (review-146): an answer that the MCP sent before it got the cancel never becomes the answer of a later request with that id", old: "so a later request with that id goes on. The worker keeps a cancel of a", text: "so a later request with that id goes on. An answer that the MCP sent before it got the cancel goes nowhere: it never becomes the answer of a later request with that id (board ab-v16.94.20). The worker keeps a cancel" },
  { file: "C11", why: "N2 (review-146): the N7 list names each case in which the new MCP session cannot be made", old: "made (the 503 of an `initialize` whose MCP session the service cannot make, or an error of the service), the ended session stays ended (board ab-v16.94.18).", text: "made (the 503 of an `initialize` whose MCP session the service cannot make; the `-32603` answer `This MCP session has ended: …` when the worker or the new MCP session ends while its `initialize` waits for the MCP; the MCP's own error to the `initialize`; or an error of the service), the ended session stays ended (board ab-v16.94.18 and ab-v16.94.20)." },
  { file: "C11", why: "N3 (review-146): each later message but a cancel waits while browser_close runs, also notifications/initialized", old: "each later request of the MCP session waits in the worker, and the MCP then gets them in their order", text: "each later message of the MCP session other than a cancel (each request, and also `notifications/initialized`) waits in the worker (board ab-v16.94.20), and the MCP then gets them in their order" },
  { file: "C11", why: "N3 (review-146): the transport's rule names the cancel that the pinned MCP does not ignore, and each message that the worker holds", old: "The worker keeps a cancel of a `browser_close` call that runs, or of a request that waits for the end of one, from the MCP (the MCP inside the service, above; board ab-v16.94.18).", text: "The worker keeps a cancel that the pinned MCP does not ignore (below) of a `browser_close` call that runs, or of a request that waits for the end of one, from the MCP; until such a call has ended, the worker holds each later message of the MCP session other than a cancel, also `notifications/initialized` (the MCP inside the service, above; board ab-v16.94.18 and ab-v16.94.20)." },
];
test("board ab-v16.94.20: C11 says each text of review-146's notes 1, 2 and 3 exactly, and no replaced text", () => {
  assert.equal(BOARD_94_20.length, 4);
  for (const e of BOARD_94_20) {
    assert.ok(says(C11, e.text), `${e.file}, ${e.why}: ${e.text.slice(0, 160)}`);
    assert.ok(!says(C11, e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
});

// Stage 1e part 2 (board ab-v16.97.4): the sign-in act in the service's model. Each changed or new text of C11 and C12,
// exactly; each old text that it replaced is gone. The list of old and new texts is in the PR's body for the daemon lead.
const PART_1E2: { file: string; why: string; old: string; text: string }[] = [
  { file: "C12", why: "the credential's id in sign_in_seal's binding (review-118 note 6; the daemon lead's answer)", old: "The seal's binding has the purpose `browser-sign-in` and the fields `op` (the request's op), `rid` and `at`, and for `sign_in_seal` also `name`, `origin`, `path` and `send_to` (from `record`) and `offer`, so a seal for a request with `\"offer\":true` never opens for a request with `\"offer\":false`, and the reverse.", text: "The seal's binding has the purpose `browser-sign-in` and the fields `op` (the request's op), `rid` and `at`, and for `sign_in_seal` also `id`, `name`, `origin`, `path` and `send_to` (from `record`) and `offer`, so a seal for a request with `\"offer\":true` never opens for a request with `\"offer\":false`, and the reverse, and a seal for one credential's `id` never opens for another `id` (board ab-v16.97.4)." },
  { file: "C12", why: "PR #112's open point 11: the rate of the refusal ends", old: "A request that a check before the act refuses (C11, checks 1 to 7) is no act: it sends one `end` with its own `act` and no `start`.", text: "A request that a check before the act refuses (C11, checks 1 to 7) is no act: it sends one `end` with its own `act` and no `start`, within the rate of the refusal ends (below)." },
  { file: "C12", why: "PR #112's open point 11: the field dropped", old: "and `stopped_now` (`true` when the act's result stopped the credential: C11's lockout guard).", text: "and `stopped_now` (`true` when the act's result stopped the credential: C11's lockout guard). A refusal's `end` that the service sends after refusal ends of the same scope that it did not send also has `dropped`, their number (the rate of the refusal ends, below)." },
  { file: "C12", why: "PR #112's open point 11: the event table", old: "for `end` also `result`, `ms`, `blocked`, `guarded` and `stopped_now`;", text: "for `end` also `result`, `ms`, `blocked`, `guarded` and `stopped_now`, and `dropped` on a refusal's `end` after ends of its scope that the rate did not send;" },
  { file: "C12", why: "PR #112's open point 11: the rule (the daemon lead's mail of 2026-11-11)", old: "(a new bullet before: - No host of a blocked request.)", text: "The rate of the refusal ends (PR #112's open point 11; the daemon lead's rule). The service sends at most 10 `end` events with no `start` (refusal ends) for one scope in any 60 s. It sends no further refusal end of that scope, and it counts each one that it does not send. The next refusal end of the scope that it sends after such ones carries `dropped`, their number, and it sends that one only when at least 60 s have passed since its last refusal end of the scope; the count then starts again. Each scope has its own rate, an act's `start` and `end` are outside it, and each refused request still gets its answer and its log line. The vectors' `refusalRate` gives a run of refusals and the ends that go." },
  { file: "C11", why: "PR #112's open point 4: check 2 and two approved records of one name", old: "No such name, a name whose host the scope's list does not cover, and an offer that waits get the same text.", text: "No such name, a name whose host the scope's list does not cover, and an offer that waits get the same text. Two approved records of one name in the last `sign_ins` each break (C12, names and ids), so check 2 finds neither of them, and the request gets that text too (C12's vector `checkTwo`)." },
  { file: "C11", why: "PR #112's open point 11: the rate of the refusal ends", old: "It sends one `end` event with an act id of its own and no `start` (C12, the stored sign-ins).", text: "It sends one `end` event with an act id of its own and no `start` (C12, the stored sign-ins), within the rate of the refusal ends: at most 10 for one scope in any 60 s; past that, one a minute, which carries `dropped`, the number that did not go (C12). Each refused request still gets its answer and its log line." },
  { file: "C11", why: "the act window's focus, the hello's feature by membership, and no window", old: "The receiver opens the act window with C10's `windows.create`, `incognito: true` and the mark of an act (the receiver's part of the stored sign-ins, board ab-v16.97.3), with the caller's scope for the list rules (C4, C5), at `about:blank`, held as C10 says.", text: "The receiver opens the act window with C10's `windows.create`, `incognito: true`, `focused: false` and the mark of an act (the receiver's part of the stored sign-ins, board ab-v16.97.3), with the caller's scope for the list rules (C4, C5), at `about:blank`, held as C10 says. The act starts only with a receiver whose hello's `features` hold `act` (C4): the service tests for membership in the list, never for equality, so a receiver with more features has the act. With no such receiver, or when the receiver opens no incognito window, the act ends with no window." },
  { file: "C11", why: "C10's list N4: every incognito tab kept from every client", old: "No connection sees an act tab, attaches it or gets an event of it.", text: "No connection sees an act tab, attaches it or gets an event of it. The model keeps every incognito tab (the act's tabs and the operator's private tabs) from every client: each event and read that C10 still gives of one (its list N4: `tabs.onCreated`, `tabs.onUpdated`, `tabs.onRemoved`, `tabs.onReplaced`, `webNavigation.onCreatedNavigationTarget`, `webNavigation.onErrorOccurred`, `downloads.onCreated` and `downloads.onChanged`, the answers of `tabs.get`, `tabs.query`, `windows.get` and `debugger.getTargets`, and the act tab's `debugger.onEvent` and `debugger.onDetach`, which carry the typed values) goes to the act only, also a `bridge.tabScope` or a `bridge.tooLarge` of one; a download of one never joins a client's download; and a window that holds one is in no window lookup." },
  { file: "C11", why: "the X move: how the service finds the act window and an act popup's window", old: "Before the first key, the service moves the act window at the X level to the right of the screen's area. It types no key until `windows.get` reports the window outside the screen.", text: "Before the sign-in page loads, the service moves the act window at the X level to the right of the screen's area: it gives the act tab's `about:blank` page a title of its own, a new random value for each act that the service sets (`aw-act-` and 8 random bytes in hex; the X move takes no title of another form), and moves each X window with that title. It types no key until `windows.get` reports the window outside the screen (no pixel of it on the screen). An act popup is a tab whose opener is a tab of the act (the `openerTabId` of its `tabs.onCreated`, or C10's `webNavigation.onCreatedNavigationTarget` with a tab of the act as its source), or the added tab of an act popup's `tabs.onReplaced`; another incognito tab (an operator's private window) is no act popup, and the act moves nothing of it. The service attaches its own session to each act popup, with `Fetch` (the guard, below) and `Network` (its blocked requests count). An act popup that opens before the password's last key ends the act, so no key goes after the service learns of the popup: the act reads that again at once before each key. An act popup whose session, `Network` or `Fetch` fails ends the act too, also after the password's last key. An act popup in a window of its own moves off the screen by a title of its own in its page, a new random value for each act popup of the same form, never by the bounds of a window (`windows.update` refuses an act popup's window); a popup's window that is not outside the screen within 2 s ends the act." },
  { file: "C11", why: "the input lock with the input stage on and off", old: "The service takes the input lock of the browser (the input design, section 4.4) for its clicks and keys, and a client's input calls wait for it.", text: "The service takes the input lock of the browser (the input design, section 4.4) for its clicks and keys, and a client's input calls wait for it: with the input stage on, the stage's lock; with it off, a step of the activation chain, which each client input that starts an action waits for." },
  { file: "C11", why: "the guard: a paused request too large for the link", old: "It looks for the password in five forms: plain, URL-encoded, JSON-escaped, base64 and base64url. Every other request continues unchanged.", text: "It looks for the password in five forms: plain, URL-encoded, JSON-escaped, base64 and base64url. Every other request continues unchanged. A paused request whose event was too large for the link (C10's `bridge.tooLarge`) fails: the guard cannot read it." },
  { file: "C11", why: "the leak check reads the credential origin's localStorage only", old: "When a cookie value or a `localStorage` value holds the password in one of the five forms, the act makes no move.", text: "The service reads the `localStorage` only from a page on the credential's origin; from another origin the move holds no `localStorage` item. When a cookie value or a `localStorage` key or value holds the password in one of the five forms, the act makes no move." },
  { file: "C11", why: "the clean end is C4's act_end (the receiver's order: the tabs, then the rules)", old: "It turns `Fetch` off, has the receiver remove the act's rules, and closes the act window and its popups. Chrome drops the act's context with its last window.", text: "It turns `Fetch` off and sends C4's `act_end`: the receiver closes each tab of the act (the act window and its popups), then removes the act's rules; the service closes no window itself. Chrome drops the act's context with its last window. An act whose `act_rules` failed or came late sends `act_end` too, and so does an act whose `windows.create` got no answer in time; an act that opened no window sends none. An `act_end` that fails goes once more after 500 ms; after a second failure the service logs it, and the next act window or the receiver's start ends the act (C10)." },
  { file: "C11", why: "the outcome: an error page and about:blank are hosts on no list", old: "A final host that the scope's list does not cover ends the act (C4 and C5 block it).", text: "A final host that the scope's list does not cover ends the act (C4 and C5 block it); an error page of a blocked navigation, and `about:blank` (where the list's guard sends a page off the list), count as such a host." },
  { file: "C11", why: "no fallback in the first build", old: "The fallback is a build decision only for that case.", text: "The fallback is a build decision only for that case; stage 1e part 2 (board ab-v16.97.4) builds none: with no incognito window the act ends with no window." },
  { file: "C11", why: "a link that goes down during the act", old: "`<origin>` is the record's origin.", text: "`<origin>` is the record's origin. A link that goes down during the act ends it with the result `not_ready` and the readiness's text of that moment." },
  { file: "C11", why: "the act's two new results: no act window, a lost act tab", old: "(a new row after: | The window | `window` | `The agent browser could not move the sign-in window off the screen.` |)", text: "| No act window (no feature `act`, no incognito window) | `no_window` | `The agent browser could not open the sign-in window.` |" },
  { file: "C11", why: "the act's two new results: no act window, a lost act tab", old: "(a new row after: | Timeout | `timeout` | `The site did not finish the sign-in in 30 s.` |)", text: "| The act tab is gone (its session ended, it closed or was replaced, or a call of the act failed) | `lost` | `The agent browser lost the sign-in window before the sign-in finished.` |" },
];
test("stage 1e part 2: C11 and C12 say each new text of the sign-in act exactly, and no replaced text", () => {
  const files: Record<string, string> = { C11, C12: C12P };
  assert.equal(PART_1E2.length, 19);
  for (const e of PART_1E2) {
    assert.ok(says(files[e.file], e.text), `${e.file}, ${e.why}: ${e.text.slice(0, 160)}`);
    if (!e.old.startsWith("(a new ") && !flat(e.text).includes(flat(e.old))) assert.ok(!says(files[e.file], e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
});

test("stage 1e part 2: the act's texts in the code are C11's table, result for result (act-rules.ts ACT_TEXT)", async () => {
  const { ACT_TEXT, signedInText } = await import("../src/service/signins/act-rules.ts");
  const rows = actTable();
  const table = new Map(rows.slice(1).map((r) => [r.result, r.texts]));
  for (const [result, text] of Object.entries(ACT_TEXT)) {
    const texts = table.get(result);
    assert.ok(texts, `C11 has the result ${result}`);
    assert.ok(texts!.includes(text.replace("<name>", "<name>").replace("<host>", "<host>")), `${result}: ${text}`);
  }
  for (const r of rows.slice(1)) if (r.result !== "not_ready") assert.ok(Object.hasOwn(ACT_TEXT, r.result), `the code has C11's result ${r.result}`);
  assert.ok(says(C11, `\`${signedInText("<origin>")}\``), "the success's text");
});

// The fix round of review-124 (board ab-v16.97.4): each changed or new text of C11, exactly; each old text that it
// replaced is gone. The list of old and new texts is in the PR's body for the daemon lead.
const PART_1E2_R1: { file: string; why: string; old: string; text: string }[] = [
  { file: "C11", why: "review-124 B1 and N2: a request that waited is checked again at its turn", old: "No other act runs. An act waits for the act before it, at most 60 s.", text: "No other act and no PageFetch runs: the act and PageFetch share the one private window (PageFetch, above). An act waits for the window at most 60 s, and, when a fetch holds the window at the act's request, also that fetch's longest hold (80 s): an act waits for a running fetch and never fails because of it (the daemon lead's rule); a waiting act gets the window before every waiting fetch. A request that waited is checked again at its turn: checks 4, 5 and 6 run again before the act starts, and the record's values open only then, so a stop of the credential or the hour's last act by an act before it, or a lock during the wait, refuses it as a check before the act does." },
  { file: "C11", why: "review-124 B2, B3 and B4: an act popup by its opener, its session and guard, the end at a popup before the last key, its own marker", old: "Before the sign-in page loads, the service moves the act window at the X level to the right of the screen's area: it gives the act tab's `about:blank` page a title of its own and moves each X window with that title. It types no key until `windows.get` reports the window outside the screen (no pixel of it on the screen). An act popup in a window of its own moves the same way, found by its window's bounds among the X windows that were not there at the act's start (`windows.update` refuses an act popup's window); a popup's window that is not outside the screen within 2 s ends the act.", text: "Before the sign-in page loads, the service moves the act window at the X level to the right of the screen's area: it gives the act tab's `about:blank` page a title of its own, a new random value for each act that the service sets (`aw-act-` and 8 random bytes in hex; the X move takes no title of another form), and moves each X window with that title. It types no key until `windows.get` reports the window outside the screen (no pixel of it on the screen). An act popup is a tab whose opener is a tab of the act (the `openerTabId` of its `tabs.onCreated`, or C10's `webNavigation.onCreatedNavigationTarget` with a tab of the act as its source), or the added tab of an act popup's `tabs.onReplaced`; another incognito tab (an operator's private window) is no act popup, and the act moves nothing of it. The service attaches its own session to each act popup, with `Fetch` (the guard, below) and `Network` (its blocked requests count). An act popup that opens before the password's last key ends the act, so no key goes after the service learns of the popup: the act reads that again at once before each key. An act popup whose session, `Network` or `Fetch` fails ends the act too, also after the password's last key. An act popup in a window of its own moves off the screen by a title of its own in its page, a new random value for each act popup of the same form, never by the bounds of a window (`windows.update` refuses an act popup's window); a popup's window that is not outside the screen within 2 s ends the act." },
  { file: "C11", why: "review-124 B2: the guard in each act popup", old: "The guard. The service keeps `Fetch` on in the act tab for every URL, at the request stage.", text: "The guard. The service keeps `Fetch` on in the act tab and in each act popup that its session holds, for every URL, at the request stage." },
  { file: "C11", why: "review-124 N9: the blocked requests of the act popups count", old: "the `end` event and the act's log line give only the number of requests that the block stopped and the number that the guard stopped.", text: "the `end` event and the act's log line give only the number of requests that the block stopped (in the act tab and in each act popup that the service's session holds) and the number that the guard stopped." },
  { file: "C11", why: "review-124 B2: what the guard does not see of an act popup", old: "a top-level or popup GET to a host on the scope's list with a changed or partial value; DNS prefetch and preconnect; and WebRTC.", text: "a top-level GET of an act tab or an act popup to a host on the scope's list with a changed or partial value; the requests of an act popup before the service's session holds its `Fetch` (its first navigation among them), so a popup that the page opens after the password's last key, or in the moment before the service learns of it, can send a GET with the whole value to a host on the scope's list; DNS prefetch and preconnect; and WebRTC." },
  { file: "C11", why: "review-124 N3: act_end once more", old: "An act whose `act_rules` failed or came late sends `act_end` too, and so does an act whose `windows.create` got no answer in time; an act that opened no window sends none.", text: "An act whose `act_rules` failed or came late sends `act_end` too, and so does an act whose `windows.create` got no answer in time; an act that opened no window sends none. An `act_end` that fails goes once more after 500 ms; after a second failure the service logs it, and the next act window or the receiver's start ends the act (C10)." },
  { file: "C11", why: "review-124 B2: the act's new result `popup`", old: "(a new row after: | The window | `window` | `The agent browser could not move the sign-in window off the screen.` |)", text: "| An act popup before the last key | `popup` | `The sign-in page opened another window, so the agent browser ended the sign-in.` |" },
];
test("review-124: C11 says each new text of the fix round exactly, and no replaced text", () => {
  assert.equal(PART_1E2_R1.length, 7);
  for (const e of PART_1E2_R1) {
    assert.ok(says(C11, e.text), `C11, ${e.why}: ${e.text.slice(0, 160)}`);
    if (!e.old.startsWith("(a new ") && !flat(e.text).includes(flat(e.old))) assert.ok(!says(C11, e.old), `C11, ${e.why}: the old text is gone`);
  }
});

// The focused change after review-124b (board ab-v16.97.4): C11's two changed sentences and the design's four texts,
// exactly (review-124b note j: the design's 7.3, 7.6 and section 15 texts get an exact test too); each old text is gone.
const PART_1E2_R2: { file: string; why: string; old: string; text: string }[] = [
  { file: "C11", why: "review-124b F1, note a, note d and the daemon lead's point 2: the act popup sentence", old: "Before the sign-in page loads, the service moves the act window at the X level to the right of the screen's area: it gives the act tab's `about:blank` page a title of its own and moves each X window with that title. It types no key until `windows.get` reports the window outside the screen (no pixel of it on the screen). An act popup is a tab whose opener is a tab of the act (the `openerTabId` of its `tabs.onCreated`, or C10's `webNavigation.onCreatedNavigationTarget` with a tab of the act as its source), or the added tab of an act popup's `tabs.onReplaced`; another incognito tab (an operator's private window) is no act popup, and the act moves nothing of it. The service attaches its own session to each act popup, with `Fetch` (the guard, below) and `Network` (its blocked requests count). An act popup that opens before the act's last key ends the act, so no key goes after the service learns of the popup. An act popup in a window of its own moves off the screen by a title of its own in its page, never by the bounds of a window (`windows.update` refuses an act popup's window); a popup's window that is not outside the screen within 2 s ends the act.", text: "Before the sign-in page loads, the service moves the act window at the X level to the right of the screen's area: it gives the act tab's `about:blank` page a title of its own, a new random value for each act that the service sets (`aw-act-` and 8 random bytes in hex; the X move takes no title of another form), and moves each X window with that title. It types no key until `windows.get` reports the window outside the screen (no pixel of it on the screen). An act popup is a tab whose opener is a tab of the act (the `openerTabId` of its `tabs.onCreated`, or C10's `webNavigation.onCreatedNavigationTarget` with a tab of the act as its source), or the added tab of an act popup's `tabs.onReplaced`; another incognito tab (an operator's private window) is no act popup, and the act moves nothing of it. The service attaches its own session to each act popup, with `Fetch` (the guard, below) and `Network` (its blocked requests count). An act popup that opens before the password's last key ends the act, so no key goes after the service learns of the popup: the act reads that again at once before each key. An act popup whose session, `Network` or `Fetch` fails ends the act too, also after the password's last key. An act popup in a window of its own moves off the screen by a title of its own in its page, a new random value for each act popup of the same form, never by the bounds of a window (`windows.update` refuses an act popup's window); a popup's window that is not outside the screen within 2 s ends the act." },
  { file: "C11", why: "review-124b F3 and note a: a popup's GET with a changed or partial value", old: "a top-level GET of an act tab to a host on the scope's list with a changed or partial value; the requests of an act popup before the service's session holds its `Fetch` (its first navigation among them), so a popup that the page opens after the act's last key, or in the moment before the service learns of it, can send a GET with the whole value to a host on the scope's list; DNS prefetch and preconnect; and WebRTC.", text: "a top-level GET of an act tab or an act popup to a host on the scope's list with a changed or partial value; the requests of an act popup before the service's session holds its `Fetch` (its first navigation among them), so a popup that the page opens after the password's last key, or in the moment before the service learns of it, can send a GET with the whole value to a host on the scope's list; DNS prefetch and preconnect; and WebRTC." },
  { file: "DESIGN", why: "review-124b F3 and note a: 7.6's limit", old: "a top-level navigation by GET of the act tab to a host on the scope's list, with a changed or partial value (the guard finds only the whole value); the requests of an act popup before the service's session holds its `Fetch` (its first navigation among them), so a popup that the page opens after the act's last key, or in the moment before the service learns of it, can send a GET with the whole value (board ab-v16.97.4, review-124 B2: the act ends at an act popup that opens before its last key);", text: "a top-level navigation by GET of the act tab or an act popup to a host on the scope's list, with a changed or partial value (the guard finds only the whole value); the requests of an act popup before the service's session holds its `Fetch` (its first navigation among them), so a popup that the page opens after the password's last key, or in the moment before the service learns of it, can send a GET with the whole value (board ab-v16.97.4, review-124 B2: the act ends at an act popup that opens before the password's last key);" },
  { file: "DESIGN", why: "review-124b F3: 7.6's guard in each act popup", old: "**The guard.** The service also keeps `Fetch` on in the act tab for every URL, at the request stage.", text: "**The guard.** The service also keeps `Fetch` on in the act tab and in each act popup that its session holds, for every URL, at the request stage." },
  { file: "DESIGN", why: "review-124b F3: section 15 names both cases of the popup limit", old: "GET of the act tab to a host on the scope's list with a changed or partial value, the first requests of an act popup before the service's session holds its `Fetch` (a popup after the act's last key), DNS prefetch and preconnect, and WebRTC", text: "GET of the act tab or an act popup to a host on the scope's list with a changed or partial value, the first requests of an act popup before the service's session holds its `Fetch` (a popup that opens after the password's last key, or in the moment before the service learns of it), DNS prefetch and preconnect, and WebRTC" },
  { file: "DESIGN", why: "the daemon lead's point 2: 7.3's title of the X move", old: "The act types no key until `windows.get` reports the window outside the screen; else it ends with \"The agent browser could not move the sign-in window off the screen.\"", text: "The act types no key until `windows.get` reports the window outside the screen; else it ends with \"The agent browser could not move the sign-in window off the screen.\" The service finds the act window, and the window of each act popup, by a title that it sets in that tab's page: a new random value for each act and each act popup (`aw-act-` and 8 random bytes in hex; the X move takes no title of another form), never by the bounds of a window (board ab-v16.97.4)." },
];
test("review-124b: C11 and the design say each text of the focused change exactly, and no replaced text", () => {
  const files: Record<string, string> = { C11, DESIGN: SIGN_IN_DESIGN };
  assert.equal(PART_1E2_R2.length, 6);
  for (const e of PART_1E2_R2) {
    assert.ok(says(files[e.file], e.text), `${e.file}, ${e.why}: ${e.text.slice(0, 160)}`);
    if (!flat(e.text).includes(flat(e.old))) assert.ok(!says(files[e.file], e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
  assert.ok(!says(C11, "the act's last key"), "C11 says the password's last key (review-124b note a)");
});


// ---- The merge guard (board ab-v16.99; the operator's rule of 2026-11-12) ----
// C11's part holds exactly these items, in order (a list item and a table row are one item). The marker's strings, the
// texts and the log lines are the code's (src/relay/merge-guard.ts); the changed sentences elsewhere are listed old, then new.
const MERGE_GUARD_HEADING = "The merge guard (board ab-v16.99; the operator's rule of 2026-11-12).";
const MERGE_GUARD_ITEMS: string[] = [
  "**The merge guard (board ab-v16.99; the operator's rule of 2026-11-12).** The design is `docs/superpowers/specs/2026-11-13-triage-merge-guard-design.md`. The operator's rule (agentwatch board item age-zbo): \"No PR from automatic issue triage is allowed to be merged, even if i've already given agents authorization to merge to staging.\" The model refuses an agent's merge of a triage PR (each method), its Ready for review, its auto-merge and its approve, the same actions as agentwatch's own merge hook, for every scope and every client: the agent door, the MCP inside the service, and the relay of the old path. The receiver's floor (C10's `bridge.mergeGuard`, C5's merge guard's floor) adds the tabs that no client holds. agentwatch's hook covers `gh` and the API from a shell; this guard covers the browser path: an agent's input, and the page's own requests.",
  "The marker: one definition, the same as agentwatch's merge hook (the manager's decision, which the daemon lead and the operator's rule share). A PR is marked when any one holds: one of its labels equals `agentwatch-triage` or `triage`, compared without case (GitHub compares label names without case); its title starts with `[agentwatch triage]` or `[triage]`, compared without case, with no trailing space needed; its head branch starts with `agentwatch-triage/` (an extra sign). The bare forms `triage` and `[triage]` are there because hand-started triage PRs carry them; agentwatch's built feature uses `agentwatch-triage` and `[agentwatch triage]`. A false match only refuses a merge, the safe side of the operator's rule.",
  "The hosts. The guarded hosts are GitHub's: `github.com` and each of its subdomains (`api.github.com` among them). Only the service's `--test` adds one more, with `--test-merge-guard-host <host>`: a normalized host under `.localhost`, a stand-in of GitHub for the live check. The service refuses that flag without `--test`, and a host that is not under `.localhost`. A write is a request to a guarded host whose method is not `GET`, `HEAD` or `OPTIONS`.",
  "The verdicts. The model reads GitHub's own answers of a PR's URLs at Fetch's response stage, with `Fetch.getResponseBody`: `/<owner>/<repo>/pull/<n>` and its sub-paths, `/<owner>/<repo>/issues/<n>`, and on the API host `api.<host>` `/repos/<owner>/<repo>/pulls/<n>` and `/repos/<owner>/<repo>/issues/<n>`. A 2xx answer that shows a form of the marker makes the PR marked: a label as its link (`/labels/<name>`), its `data-name`, its JSON `\"name\"` or a search's `label:<name>`; a title prefix at the start of the page's `<title>`, of an element's text, of a `title` attribute or of a JSON `\"title\"`; the head branch's prefix anywhere (each also with its characters escaped). Only the PR's own page (the conversation, `files`, `commits` or `checks`) as a 2xx HTML answer that names the PR's path, or the PR's API object (`/repos/<owner>/<repo>/pulls/<n>`) as a 2xx JSON answer with its number, with no form of the marker, makes it unmarked. A PR that the model saw marked stays marked for the model's life. Every other PR is unknown. The verdicts hold for every scope; a PR of the stand-in host is never a PR of GitHub. The model also keeps the node ids (`PR_...`) of each marked PR's answers.",
  "The judge. The model refuses a write, in this order: when the tab's page (its last top URL, from `tabs.onUpdated` or the top frame's document request) or the request's `Referer` is a PR page that is marked or unknown (so no write leaves a triage PR's page: no merge, Ready for review, auto-merge, approve, comment, or edit of its label or title); when the request names a marked PR, or its URL or body names a node id of a marked PR; when it is a merge of branches or a write of a ref (`/repos/<owner>/<repo>/merges`, `/repos/<owner>/<repo>/git/...`, `git-receive-pack`, or a GraphQL `mergeBranch`, `updateRef` or `updateRefs`); when it is a merge-type action of a PR (a path segment after `/pull/<n>/`, or after the API's `/pulls/<n>/`, that holds `merge`, `ready`, `queue` or `review`) that is not known unmarked, or a merge on no PR (a path segment that holds `merge` or `enqueue`) from a page that is no known-unmarked PR; when it is a GraphQL request (the last path segment holds `graphql`) whose body Chrome did not give or that is larger than 1 MiB; and when it is a GraphQL request whose body names `mergePullRequest`, `enablePullRequestAutoMerge`, `enqueuePullRequest`, `markPullRequestReadyForReview`, `addPullRequestReview`, `submitPullRequestReview`, `mergeMethod` or `APPROVE`, from a page that is no known-unmarked PR. Every other write goes.",
  "The side that it fails to. When the model cannot tell (a page of an unknown PR, a merge-type action of an unknown PR, a GraphQL body that it cannot read), it refuses: the rule allows no agent's merge of a triage PR, the browser cannot undo a merge, and a refused merge of another PR costs one step (load the PR's page, then try again).",
  "What the agent sees. The model answers a refused write itself with `Fetch.fulfillRequest`, so the request never reaches GitHub: HTTP 403 with `Cache-Control: no-store`; for a document (a form's POST) a `text/plain` page of the text; for any other request `{\"message\":\"<text>\",\"errors\":[{\"type\":\"FORBIDDEN\",\"message\":\"<text>\"}]}`, with `Access-Control-Allow-Origin` of the request's `Origin`. When that answer fails, the request fails with `BlockedByClient`. The texts:",
  "| Reason | The text |",
  "| marked | `The agent browser refused this request: the pull request came from agentwatch issue triage. No agent merges such a pull request, marks it ready for review, turns on its auto-merge, approves it or changes it in the agent browser; only the operator does, on GitHub (the operator's rule, 2026-11-12).` |",
  "| unknown | `The agent browser refused this request: it could not tell whether the pull request came from agentwatch issue triage, and no agent merges such a pull request (the operator's rule, 2026-11-12). Load the pull request's own page in this tab, then try again.` |",
  "| untied | `The agent browser refused this request: it cannot tie the request to a pull request that did not come from agentwatch issue triage (a merge of branches, a write of a branch, or a GraphQL request that it cannot read), and no agent merges such a pull request (the operator's rule, 2026-11-12).` |",
  "The guard's Fetch. Before a client gets its first session of a tab, the model turns on its own `Fetch` in the tab with its patterns: each URL of a guarded host at the request stage, and the PR URLs and `api.<host>/repos/` at the response stage. It turns it on in each child session that Chrome attaches in that tab (a frame or a worker of the client's auto-attach) too, before the client lets the child run. A client's `Fetch.enable` there goes to Chrome with the guard's patterns and the client's; a client's `Fetch.disable` goes as a `Fetch.enable` of the guard's patterns, and the model lets each request that the client held go on (a refused write with its 403). The model judges and reads each paused request of a guarded host before any client gets it; a client gets it then only when its own patterns ask for it, so a client that intercepts (Playwright's `page.route`) still sees each request of a GitHub page. A pause that no pattern of the client asks for goes on (`Fetch.continueRequest`); a `Fetch.authRequired` of a guarded host gets `CancelAuth`, and another one that the client does not handle gets `Default`.",
  "The clients' Fetch commands. A Fetch command whose `requestId` names a request that the model holds (one of a guarded host, until it has judged or read it) gets `Invalid InterceptionId.` A client's `Fetch.continueRequest` of a refused write goes to Chrome as the model's `Fetch.fulfillRequest` with the 403 (a client's own `Fetch.fulfillRequest` or `Fetch.failRequest` of it goes as it is: neither reaches GitHub). A `Fetch.continueRequest` that changes the `url`, `method`, `postData` or `headers` of a request of a guarded host, or whose `url` is on a guarded host, gets `Not available in the agent browser: a request to <host> that a client changes (Fetch.continueRequest). The agent browser judges each request to GitHub itself (the merge guard of pull requests from agentwatch issue triage).`, and it does not reach Chrome: the model answers that request itself with a 403 of the same text (a client such as Playwright's `route.continue` drops a protocol error, so the request never waits for it). A redirect to a guarded host is a new request at the request stage, which the model judges.",
  "The page's policy. While the model has no floor that the receiver confirmed on the current link (no answer yet to `bridge.mergeGuard`, an `unknown op` answer, an error, or a link change before the answer), `Page.setBypassCSP` with `enabled` true gets `Not available in the agent browser: Page.setBypassCSP.` So with no floor a page's Content Security Policy stays in force, and a client starts no worker of its own script where the page's policy forbids it. With a confirmed floor it goes to Chrome as before. A page's request never goes through a service worker in a tab whose bypass is on (the page's service worker, below). A worker's own request (a shared worker's or a service worker's) has no tab, and the floor blocks each write of it. A dedicated worker's request goes through the tab's own session, also with no auto-attach of the client (measured: the live check of board ab-v16.99), so the model judges it; only a blob worker of a page that a service worker controls sends its requests through that service worker (the page's service worker, below).",
  "The page's service worker (the operator's answer of 2026-11-13 on board item ab-u92, \"On GitHub only\": \"Other sites keep their service workers. On GitHub, a PR page that an agent opens through a link from another site can need one reload before a merge or a comment works. The guard stays complete.\"). In a tab that a client holds, the model turns the service worker's bypass on while the tab's main frame is on a guarded host, and only then: `Network` on with the smallest buffers (`maxTotalBufferSize` and `maxResourceBufferSize` 0: Chrome takes them and then keeps no body, measured; the guard reads no `Network` data) when the client has not turned it on, then `Network.setBypassServiceWorker` with `bypass` true. It turns the bypass on at the arm when the tab's page is on a guarded host, before it sends a client's `Page.navigate` to a guarded address, before its own navigation of a new tab of `Target.createTarget` to a guarded address, and when the main frame commits on a guarded host by another way (a link, a redirect, a history step: C10's `tabs.onUpdated`, which a navigation that a service worker answers also gives). It turns the bypass off when the main frame commits on a host that is not guarded: `Network.setBypassServiceWorker` with the client's own last `bypass` value, and `Network.disable` when the client has not turned `Network` on. So once the bypass is on, no request of a page of a guarded host goes through a service worker (GitHub's own code registers one on its pages), and each one is on the tab's session, where the model judges it. Chrome applies the bypass only while `Network` is on (measured: the live check of board ab-v16.99), so while the bypass is on the model keeps `Network` on: a client's `Network.disable` gets an answer and does not reach Chrome (it takes effect when the bypass goes off); a client's `Network.enable` goes to Chrome, and the bypass follows it; the session's `Network` events go to a client only while it has `Network` on. While the bypass is off, the client's `Network` calls and its events are as before. The model does the same in the session of each dedicated worker of such a tab that the client's auto-attach brings, before the client lets the worker run: a blob worker of a page that a service worker controls sends its requests through that service worker (measured). A client's `Network.setBypassServiceWorker` with a `bypass` that is not true on a session where the bypass is on gets `Not available in the agent browser: Network.setBypassServiceWorker with bypass false. The merge guard keeps a page's service worker off in each tab that a client holds (the merge guard of pull requests from agentwatch issue triage).`; with `bypass` true it gets an answer with no change.",
  "The arm's limit. Each step of the arm waits at most 3 s (`ARM_LIMIT_MS`). `Network.enable` and the bypass go to the page's renderer, which a page's dialog, a busy or a crashed renderer can hold (measured: a `beforeunload` dialog of a navigation in a tab with no client held a raw client's `Target.setAutoAttach` and Playwright's `connectOverCDP` past 20 s). When `Fetch.enable` fails or does not answer in time, the tab is not turned on. When `Network.enable` or the bypass fails or does not answer in time, the client gets its session (or its `Page.navigate` goes), the guard's `Fetch` and the `Network` rules of the bypass stay on in the tab, and the bypass follows a late answer; the floor names the tab at its `Fetch` in both cases, and it blocks each write of a request with no tab (a page's service worker's). A dialog that opened before the client's session does not reach the client's `Page.handleJavaScriptDialog` (\"No dialog is showing\", measured): the operator closes it in the live view (the live check presses its Return key), or the client closes the tab.",
  "The cost of the bypass, in each tab that a client holds, only while its main frame is on a guarded host: (1) a page of GitHub that needs its service worker does not get it there (an offline page, a download or a stream that the worker makes, a header or a token that the worker adds); Playwright's `serviceWorkers: 'allow'` acts as `'block'` and Puppeteer's `page.setBypassServiceWorker(false)` fails on GitHub's pages only; agent mode already shows no service worker to a client (Playwright's `context.serviceWorkers()` is empty); a site that needs its worker (an offline page, a development mock such as Mock Service Worker) works in a client's tab, except on GitHub; (2) a PR page that the tab reaches by a link, a redirect or a history step from another site can load under GitHub's worker before its commit turns the bypass on: the model read no answer of it, so its PR is unknown, and a write from it gets the text of an unknown PR, which says to load the PR's page again; that reload goes with the bypass on and gives the verdict (measured); (3) the first page of another site that the tab reaches from GitHub loads with the bypass still on (it goes off at the commit), so that page skips its service worker until a reload; (4) `Network` is on also for a client that never turns it on: Chrome keeps buffers for the tab (the guard's smallest ones), and the tab's `Network` events cross the link, where the model drops them; (5) a client's `Network.disable` reaches Chrome only when the bypass goes off, so until then the client's `Network` state (extra headers, blocked URLs, network conditions, the cache setting, buffer sizes) stays; (6) a client that turns `Network` on late gets later events of requests that started before, with no `requestWillBeSent`, and a `Fetch.requestPaused` can name a `networkId` whose events that client never got; (7) the arm's limit: a page's dialog or a busy renderer makes a client's first session of a tab on a guarded host, or its `Page.navigate` to one, wait up to 3 s for each step. The model has no session in the operator's own tabs, so a write that a page's service worker sends there for a page of a guarded host has no tab, and the floor blocks it (measured with the stand-in's worker: the write through the worker was blocked, a write of the page itself went).",
  "An event too large for the link. A `Fetch.requestPaused` that C10's `bridge.tooLarge` replaces fails (`Fetch.failRequest` with `BlockedByClient`) in a tab whose page is on a guarded host; elsewhere it goes on, as before.",
  "The floor. At each link up, and after each tab that it turns on, the model sends `bridge.mergeGuard` with `[{\"hosts\":[...],\"tabs\":[...]}]`: the guarded hosts and every tab where its `Fetch` is on (a request that a page's service worker sends has no tab, so the floor blocks its write also from such a tab, measured). The receiver then blocks each write to a guarded host from every other tab and from each request with no tab (C5). A receiver before the floor answers `unknown op`: the model sends no `bridge.mergeGuard` again until the next link up, logs `merge guard: the receiver has no floor (bridge.mergeGuard: unknown op): only the tabs that a client holds are guarded`, and only the tabs that a client holds are guarded. A tab whose `Fetch.enable` fails or does not answer in the arm's limit is not named, so the floor keeps its writes blocked.",
  "The counts and the log. The model counts the writes that it judged, the refusals of each reason, the clients' Fetch commands that it refused, the answers that it read and the reads that failed, and it keeps the number of marked and unmarked PRs and of marked node ids. One log line names a reason and a host at most once in 5 minutes: `merge guard: refused a write to <host> (<method>, tab <id>): <reason>; refused so far: <n>`. No log line holds a URL path, a query, a header, a body, a cookie or a page's text.",
  "What it cannot stop, stated plainly: a raw API call with a token outside the agent browser (agentwatch's own merge hook and its limits); a PR whose markers somebody removed outside the agent browser before the model saw it marked (the browser has no copy of agentwatch's PR registry); a GraphQL request whose operation the model cannot read (a persisted query id), from a page that is no PR page, that names a marked PR only by a node id that the model never saw in a marked PR's answer; with no floor, a write that a shared worker or a service worker sends by itself (not a page's request), for example a background sync, which no tab's session sees; with no floor, a write of a blob worker of a page that a service worker controls when the client's auto-attach does not bring the worker (the write goes through the service worker, measured), and a page's request that a service worker takes in a tab whose bypass is not on yet (a page of a guarded host that a link, a redirect or a history step brought, before its commit turns the bypass on; or a bypass that has not answered in the arm's limit); with no floor, or with the floor of a receiver before 0.3.11 (the old path while agentwatch pins such a receiver), in a page of any site, a write of a frame of another site that the client's auto-attach does not bring: it has no session, and no rule of that floor blocks it in the tab, so only layer 1 is left; the request is cross-site, so it carries none of GitHub's SameSite cookies; the floor of the receiver 0.3.11 or a later one closes that case with its initiator rule (C5's rule 89, board ab-v16.100): it blocks each write to a guarded host from a page or a frame of another host (not a top-level request) in every tab except the operator's marked tabs and the act tabs, the guarded tabs too; with that rule, in a guarded tab, a write of a frame of a guarded host in a page of another host that the client's auto-attach does not bring: it has no session in the tab, rule 89 passes it (its initiator is a guarded host), and no layer of the guard judges it (C5's \"What it does not stop\"); a write of a tab with no client while the receiver has no floor; a write whose pause comes in the moment of a link drop or of Chrome's own detach, before the model's answer; a message on a WebSocket; GitHub Enterprise hosts; and the operator's own tabs, which no client reaches, where the operator merges.",
  "The release. The guard is in the model of the service and of the relay of the old path; the service serves sessions from stage 3. The floor comes with the receiver's release that adds `bridge.mergeGuard` and with the pin of agent-browser that names it. The service pins that release or a later one, the receiver 0.3.16 (board ab-v16.97.10, ab-v16.102, ab-v16.94.7.7, ab-v16.100, ab-v16.112, ab-v16.115, ab-sta.4, ab-4wh.2; C12, the agent package): its model has the floor once the receiver confirms it on the current link, and then `Page.setBypassCSP` with `enabled` true goes to Chrome. At a link change the receiver 0.3.12 (board ab-v16.88; chrome-extension's C10) ends no attachment while a `Target.closeTarget` command of a receiver's close runs on it: its cleanup waits for that command's answer before the detach. The receiver 0.3.13 (board ab-v16.67; C10) sends a second `Target.closeTarget` for a dropped close (Chrome answered the close's command with no error and closed no tab) before the fallback's `chrome.tabs.remove`, and the close's item waits for it, so an item of the receiver's removal queue ends at most five times `REMOVAL_WAIT_MS` (10 s) after it starts, not three times (6 s). The receiver 0.3.14 (board ab-v16.83; chrome-extension's C5 and C10) changes two parts. Its worker removal of the recorded origins (C5) takes review-30h's notes: a stop of a check or a failed call later in it keeps due only the origins that the check has neither removed nor recorded again, so the next removal of a recorded origin gets a follow-up check of its own; a due origin that a commit put back into the record or the pending set and that the check removes gets a follow-up check for that removal too; a list end's removal of every worker also keeps the origins that are due for a follow-up check of the sites that the marked tabs show or that the remaining lists cover; and a running check drops the origins that tabs commit during it just before its call, and notes none during the call. C5 states one more limit: that removal keeps only the origins that are due when its check starts, so a worker that its page registered again after its removal goes at a list end within about two times `RECHECK_MS` (10 s) of that removal, also when a marked tab shows its site or a list in force covers it. In the fetch window's download cancel (C10), the receiver cancels no incognito download while an act tab is open and no fetch tab is: such a download is the act's or the operator's, and the fetch window's rules are then left ones (for example those of a `fetch_end` that answered `rules not removed`). C10 states two limits: the receiver still cancels each download of a private window that the operator opens while a fetch tab is open, or while only the fetch window's rules are left and no act tab is open; and its cancel at `downloads.onCreated` races Chrome's completion of a small download, whose file then stays. The receiver 0.3.15 (board ab-sta.4; chrome-extension's C4 and C5) adds the receiver's part of the pay act of the card payment (below) and the hello's feature `pay`. The C4 request `pay_cookies_copy` (`{tab, domain}`, answered `{count}`) writes the default context's cookies of a registrable domain and its subdomains, httpOnly included, into the act tab's own store, and its answer holds the count only, never a name or a value: the one read of the default store that the receiver makes for an act, a narrow exception to review-ce44 N10, for the pay act only. The C4 request `pay_merchant_block` (`{tab, domain, on}`, answered `{rules}`) adds or removes C5's rule 90: from the copy of the merchant's session to the act's end, it blocks each request to the merchant's registrable domain from every tab except the act tabs, so that an agent's tab cannot change the cart or the order; a request of a worker with no tab (a service worker or a shared worker) of the act's own context is blocked by rule 90 too (C5's stated limit), while a dedicated worker of an act tab sends its requests with the act tab's id, so rule 90 lets them go (measured on the Linux server, board ab-sta.8). `act_end` and a start of the receiver's worker remove rule 90 with the act's rules. Both requests refuse a domain with no dot and an IP literal (`bad request`). Only a service with the payment act (`--card-pay`) sends either request and tests the feature `pay`; with no payment act a `tools/list` holds neither `browser_pay` nor `browser_pay_status`, and a local call of either gets the allow list's `-32601` answer (the card payment, below). The receiver 0.3.16 (board ab-4wh.2; chrome-extension's C4 and C5) adds the hello's feature `blanket` and a local scope's value `\"*\"` (C4, the blanket profile). The receiver applies `\"*\"` only for a local scope of a blanket-shaped `set_scopes`: `lists` an empty object, `default` `null`, `operator` `null` or absent, exactly one scope, and a good `exclude` or none. Such a scope may open any `http(s)` host of the public host class: a name of two labels or more of `[a-z0-9_-]` whose last label holds a letter or `_`, that is no IP literal, and that is not `localhost`, `local`, `internal`, `home.arpa` or `localdomain`, not a name of `exclude` (the box's own names, at most 8), and not a name under one of them. Any other `\"*\"` (a remote scope's, one in an object of another shape, or one next to a bad `exclude`) counts 1 in `refused` and applies as `null` (fail closed). C5's public rules give the scope's tabs two allow rules of the class (main frames; frames and `<object>`/`<embed>` documents) and the block rule 91, which blocks each request of those tabs to `localhost`, `local`, `internal`, `home.arpa`, `localdomain` or a name of `exclude`, or a name under one of them, also with a trailing dot. C4 states the limit: the class judges a host's name, not its address, so a public name that resolves to a private address passes (on Linux the service's address proxy closes it for the blanket Chrome: the blanket profile, below). The service sends `\"*\"` only on the blanket Chrome's link (board ab-4wh.3); until that build no service sends it. The relay of the old path has the guard and the floor only when agentwatch moves both of its pins at once (chrome-extension's C1: agentwatch pins both repositories and moves them at once): its agent-browser pin to a commit at or after this guard's merge commit (`d37e49f`), and its receiver pin to a release at or after 0.3.8, with no other agentwatch change. With the guard and a receiver before the floor, `Page.setBypassCSP` with `enabled` true stays refused on the old path. A receiver with the floor under a relay with no guard (an agent-browser commit before `d37e49f`) names no guarded tab, so its floor blocks each write to GitHub's hosts from every client tab and from each request with no tab (fail closed), and that relay lets `Page.setBypassCSP` with `enabled` true go to Chrome. agentwatch's `triage enable` must require an agent-browser commit at or after this guard's merge commit, and a receiver version at or after the first release with the floor (0.3.8); agentwatch's carrier passes `bridge.mergeGuard` on to the receiver and the receiver's answer back, both unchanged (a carrier that answers the op itself would confirm a floor that is not there).",
];
test("C11's part on the merge guard holds exactly its sentences, after how a session gets the MCP and before the sign-in act", () => {
  const p = partOr(MERGE_GUARD_HEADING);
  for (const s of MERGE_GUARD_ITEMS) assert.ok(says(p, s), `C11 says: ${s.slice(0, 120)}`);
  assert.equal(clean(p), MERGE_GUARD_ITEMS.join(" "), "the part holds no other text");
  const at = C11.indexOf(`**${MERGE_GUARD_HEADING}`);
  assert.ok(C11.indexOf("**How a session gets the MCP (from stage 2;") < at && at < C11.indexOf(`**${SIGN_IN_HEADING}`));
  assert.ok(p.split("\n").every((l) => (l.match(/`/g) ?? []).length % 2 === 0), "no code span over a line break");
  assert.ok(!/\/home\//.test(p), "no box path");
});

test("the merge guard's marker in C11 is the code's one definition: both labels, both title prefixes, the head branch prefix, and the reason for the bare forms", async () => {
  const { TRIAGE_MARKER, MARKER_FORMS } = await import("../src/relay/merge-guard.ts");
  const p = flat(partOr(MERGE_GUARD_HEADING));
  for (const l of TRIAGE_MARKER.labels) assert.ok(p.includes(`one of its labels equals \`agentwatch-triage\` or \`triage\``) && p.includes(`\`${l}\``), l);
  for (const t of TRIAGE_MARKER.titlePrefixes) assert.ok(p.includes(`\`${t}\``), t);
  assert.ok(p.includes(`its head branch starts with \`${TRIAGE_MARKER.headBranchPrefix}\``));
  assert.equal(Object.keys(MARKER_FORMS).length, TRIAGE_MARKER.labels.length + TRIAGE_MARKER.titlePrefixes.length + 1, "one form for each string");
  assert.ok(p.includes("The bare forms `triage` and `[triage]` are there because hand-started triage PRs carry them") && p.includes("A false match only refuses a merge, the safe side of the operator's rule."));
});

test("the merge guard's texts in C11 are the code's, exactly", async () => {
  const { GUARD_TEXT, MergeGuard } = await import("../src/relay/merge-guard.ts");
  const p = flat(partOr(MERGE_GUARD_HEADING));
  for (const r of ["marked", "unknown", "untied"] as const) assert.ok(p.includes(`| ${r} | \`${GUARD_TEXT[r]}\` |`), r);
  assert.ok(p.includes(`\`${GUARD_TEXT.rewrite("<host>")}\``));
  assert.ok(p.includes(`gets \`${GUARD_TEXT.badId}\``));
  const logs: string[] = [];
  const g = new MergeGuard({ log: (l) => logs.push(l), send: async () => ({}), op: async () => { throw new Error("unknown op"); } });
  await g.linkUp();
  assert.ok(p.includes(`logs \`${logs[0]}\``), logs[0]);
  assert.ok(p.includes("`merge guard: refused a write to <host> (<method>, tab <id>): <reason>; refused so far: <n>`"));
  const refusals = flat(partOr("Refusals."));
  assert.ok(refusals.includes(`| \`Fetch.continueRequest\` with a \`url\` on a guarded host, or with a \`url\`, \`method\`, \`postData\` or \`headers\` for a request of a guarded host | \`${GUARD_TEXT.rewrite("<host>")}\` |`));
  assert.ok(refusals.includes(`that the model has not judged or read yet | \`${GUARD_TEXT.badId}\` |`));
  assert.ok(refusals.includes("| A page's Content Security Policy off while the receiver gives no floor (the merge guard, below) | `Page.setBypassCSP` with `enabled` true, while the model has no floor that the receiver confirmed on the current link | `Not available in the agent browser: <method>.` |"));
});

// The operator's ab-u92 (board ab-v16.99): the service worker's bypass on GitHub only. C11's changed sentences, old (at
// 6604ebe) then new, each exactly; the old text is gone. A sentence of an earlier list that this change replaced is this
// list's old text.
const MERGE_GUARD_FC3: { why: string; old: string; text: string }[] = [
  { why: "the refusal row: the sessions where the bypass is on", old: "| A page's service worker on (the merge guard, below) | `Network.setBypassServiceWorker` with a `bypass` that is not true, on a session where the guard turned the bypass on: a tab's own session, or the session of a dedicated worker that the client's auto-attach brings | `Not available in the agent browser: Network.setBypassServiceWorker with bypass false. The merge guard keeps a page's service worker off in each tab that a client holds (the merge guard of pull requests from agentwatch issue triage).` |",
    text: "| A page's service worker on (the merge guard, below) | `Network.setBypassServiceWorker` with a `bypass` that is not true, on a session where the bypass is on: a tab's own session while its main frame is on a guarded host, or the session of a dedicated worker of such a tab that the client's auto-attach brings | `Not available in the agent browser: Network.setBypassServiceWorker with bypass false. The merge guard keeps a page's service worker off in each tab that a client holds (the merge guard of pull requests from agentwatch issue triage).` |" },
  { why: "item 5 of the list: the page's service worker, on GitHub only (the operator's ab-u92)", old: "The page's service worker. In each tab where it turns its `Fetch` on, at the same moment and before the client gets the session, the model turns `Network` on with the smallest buffers (`maxTotalBufferSize` and `maxResourceBufferSize` 0: Chrome takes them and then keeps no body, measured; the guard reads no `Network` data) and sends `Network.setBypassServiceWorker` with `bypass` true. So no request of the tab's pages goes through a service worker (GitHub's own code registers one on its pages), and each one is on the tab's session, where the model judges it. Chrome applies the bypass only while `Network` is on (measured: the live check of board ab-v16.99), so the model keeps `Network` on there: a client's `Network.disable` gets an answer and does not reach Chrome; a client's `Network.enable` goes to Chrome, and the bypass follows it; the session's `Network` events go to a client only while it has `Network` on. The model does the same in the session of each dedicated worker that the client's auto-attach brings, before the client lets the worker run: a blob worker of a page that a service worker controls (a page that loaded before the tab's bypass, or that the service worker claimed) sends its requests through that service worker (measured). A client's `Network.setBypassServiceWorker` with a `bypass` that is not true on such a session gets `Not available in the agent browser: Network.setBypassServiceWorker with bypass false. The merge guard keeps a page's service worker off in each tab that a client holds (the merge guard of pull requests from agentwatch issue triage).`; with `bypass` true it gets an answer with no change. This holds in each tab that a client holds, on every site: the first navigation into GitHub from another site would go through GitHub's worker before the model knows its target.",
    text: "The page's service worker (the operator's answer of 2026-11-13 on board item ab-u92, \"On GitHub only\": \"Other sites keep their service workers. On GitHub, a PR page that an agent opens through a link from another site can need one reload before a merge or a comment works. The guard stays complete.\"). In a tab that a client holds, the model turns the service worker's bypass on while the tab's main frame is on a guarded host, and only then: `Network` on with the smallest buffers (`maxTotalBufferSize` and `maxResourceBufferSize` 0: Chrome takes them and then keeps no body, measured; the guard reads no `Network` data) when the client has not turned it on, then `Network.setBypassServiceWorker` with `bypass` true. It turns the bypass on at the arm when the tab's page is on a guarded host, before it sends a client's `Page.navigate` to a guarded address, before its own navigation of a new tab of `Target.createTarget` to a guarded address, and when the main frame commits on a guarded host by another way (a link, a redirect, a history step: C10's `tabs.onUpdated`, which a navigation that a service worker answers also gives). It turns the bypass off when the main frame commits on a host that is not guarded: `Network.setBypassServiceWorker` with the client's own last `bypass` value, and `Network.disable` when the client has not turned `Network` on. So once the bypass is on, no request of a page of a guarded host goes through a service worker (GitHub's own code registers one on its pages), and each one is on the tab's session, where the model judges it. Chrome applies the bypass only while `Network` is on (measured: the live check of board ab-v16.99), so while the bypass is on the model keeps `Network` on: a client's `Network.disable` gets an answer and does not reach Chrome (it takes effect when the bypass goes off); a client's `Network.enable` goes to Chrome, and the bypass follows it; the session's `Network` events go to a client only while it has `Network` on. While the bypass is off, the client's `Network` calls and its events are as before. The model does the same in the session of each dedicated worker of such a tab that the client's auto-attach brings, before the client lets the worker run: a blob worker of a page that a service worker controls sends its requests through that service worker (measured). A client's `Network.setBypassServiceWorker` with a `bypass` that is not true on a session where the bypass is on gets `Not available in the agent browser: Network.setBypassServiceWorker with bypass false. The merge guard keeps a page's service worker off in each tab that a client holds (the merge guard of pull requests from agentwatch issue triage).`; with `bypass` true it gets an answer with no change." },
  { why: "the arm's limit: the floor names the tab at its Fetch", old: "When `Network.enable` or the bypass fails or does not answer in time, the client gets its session, the guard's `Fetch` and its `Network` rules above stay on in the tab, and the floor keeps the tab; when those calls answer later, the model names the tab to the floor then.",
    text: "When `Network.enable` or the bypass fails or does not answer in time, the client gets its session (or its `Page.navigate` goes), the guard's `Fetch` and the `Network` rules of the bypass stay on in the tab, and the bypass follows a late answer; the floor names the tab at its `Fetch` in both cases, and it blocks each write of a request with no tab (a page's service worker's)." },
  { why: "item 7 of the list: the cost of the bypass, on GitHub only", old: "The cost of the bypass, in each tab that a client holds, on every site: (1) a site that needs its service worker does not work there: an offline page, a development mock such as Mock Service Worker, a download or a stream that the worker makes, a header or a token that the worker adds; agent mode already shows no service worker to a client (Playwright's `context.serviceWorkers()` is empty), Playwright's `serviceWorkers: 'allow'` acts as `'block'`, and Puppeteer's `page.setBypassServiceWorker(false)` fails; (2) `Network` is on also for a client that never turns it on: Chrome keeps its buffers for the tab (the guard's smallest ones, until a client turns `Network` on with its own), and the tab's `Network` events cross the link, where the model drops them; (3) a client's `Network.disable` no longer reaches Chrome, so the client's `Network` state (extra headers, blocked URLs, network conditions, the cache setting, buffer sizes) stays until the detach; (4) a client that turns `Network` on late gets later events of requests that started before, with no `requestWillBeSent`, and a `Fetch.requestPaused` can name a `networkId` whose events that client never got; (5) the arm's limit: a page's dialog or a busy renderer at a client's first session makes it wait up to 3 s for each step, and the floor keeps that tab until the bypass answers. The model has no session in the operator's own tabs, so a write that a page's service worker sends there for a page of a guarded host has no tab, and the floor blocks it (measured with the stand-in's worker: the write through the worker was blocked, a write of the page itself went).",
    text: "The cost of the bypass, in each tab that a client holds, only while its main frame is on a guarded host: (1) a page of GitHub that needs its service worker does not get it there (an offline page, a download or a stream that the worker makes, a header or a token that the worker adds); Playwright's `serviceWorkers: 'allow'` acts as `'block'` and Puppeteer's `page.setBypassServiceWorker(false)` fails on GitHub's pages only; agent mode already shows no service worker to a client (Playwright's `context.serviceWorkers()` is empty); a site that needs its worker (an offline page, a development mock such as Mock Service Worker) works in a client's tab, except on GitHub; (2) a PR page that the tab reaches by a link, a redirect or a history step from another site can load under GitHub's worker before its commit turns the bypass on: the model read no answer of it, so its PR is unknown, and a write from it gets the text of an unknown PR, which says to load the PR's page again; that reload goes with the bypass on and gives the verdict (measured); (3) the first page of another site that the tab reaches from GitHub loads with the bypass still on (it goes off at the commit), so that page skips its service worker until a reload; (4) `Network` is on also for a client that never turns it on: Chrome keeps buffers for the tab (the guard's smallest ones), and the tab's `Network` events cross the link, where the model drops them; (5) a client's `Network.disable` reaches Chrome only when the bypass goes off, so until then the client's `Network` state (extra headers, blocked URLs, network conditions, the cache setting, buffer sizes) stays; (6) a client that turns `Network` on late gets later events of requests that started before, with no `requestWillBeSent`, and a `Fetch.requestPaused` can name a `networkId` whose events that client never got; (7) the arm's limit: a page's dialog or a busy renderer makes a client's first session of a tab on a guarded host, or its `Page.navigate` to one, wait up to 3 s for each step. The model has no session in the operator's own tabs, so a write that a page's service worker sends there for a page of a guarded host has no tab, and the floor blocks it (measured with the stand-in's worker: the write through the worker was blocked, a write of the page itself went)." },
  { why: "the floor's tabs: each tab with the guard's Fetch", old: "`[{\"hosts\":[...],\"tabs\":[...]}]`: the guarded hosts and every tab where its `Fetch` and the bypass are on.",
    text: "`[{\"hosts\":[...],\"tabs\":[...]}]`: the guarded hosts and every tab where its `Fetch` is on (a request that a page's service worker sends has no tab, so the floor blocks its write also from such a tab, measured)." },
  { why: "the floor of a tab whose Fetch does not start", old: "A tab whose `Fetch.enable`, `Network.enable` or `Network.setBypassServiceWorker` fails or does not answer in the arm's limit is not named, so the floor keeps its writes blocked.",
    text: "A tab whose `Fetch.enable` fails or does not answer in the arm's limit is not named, so the floor keeps its writes blocked." },
  { why: "what it cannot stop: a page's request through a worker in a tab whose bypass is not on yet", old: "and a page's request that a service worker takes in a tab whose bypass has not answered yet (the arm's limit);",
    text: "and a page's request that a service worker takes in a tab whose bypass is not on yet (a page of a guarded host that a link, a redirect or a history step brought, before its commit turns the bypass on; or a bypass that has not answered in the arm's limit);" },
];
test("the operator's ab-u92: C11 says each changed sentence exactly, and no replaced text; the operator's words, the rule's moments and its costs", async () => {
  const { GUARD_TEXT } = await import("../src/relay/merge-guard.ts");
  assert.equal(MERGE_GUARD_FC3.length, 7);
  for (const e of MERGE_GUARD_FC3) {
    assert.ok(says(C11, e.text), `${e.why}: ${e.text.slice(0, 120)}`);
    assert.ok(!says(C11, e.old), `${e.why}: the old text is gone`);
  }
  const p = flat(partOr(MERGE_GUARD_HEADING));
  assert.ok(p.includes("(the operator's answer of 2026-11-13 on board item ab-u92, \"On GitHub only\": \"Other sites keep their service workers. On GitHub, a PR page that an agent opens through a link from another site can need one reload before a merge or a comment works. The guard stays complete.\")"), "the operator's words");
  for (const moment of ["at the arm when the tab's page is on a guarded host", "before it sends a client's `Page.navigate` to a guarded address", "before its own navigation of a new tab of `Target.createTarget` to a guarded address", "when the main frame commits on a guarded host by another way", "It turns the bypass off when the main frame commits on a host that is not guarded"]) assert.ok(p.includes(moment), moment);
  assert.ok(p.includes(`on a session where the bypass is on gets \`${GUARD_TEXT.serviceWorker}\`; with \`bypass\` true it gets an answer with no change.`), "the part names the code's text");
  for (const cost of ["Playwright's `serviceWorkers: 'allow'` acts as `'block'` and Puppeteer's `page.setBypassServiceWorker(false)` fails on GitHub's pages only", "works in a client's tab, except on GitHub", "that reload goes with the bypass on and gives the verdict", "skips its service worker until a reload"]) assert.ok(p.includes(cost), cost);
  assert.ok(!p.includes("on every site: the first navigation into GitHub"), "no bypass on every site");
});

// review-125b (board ab-v16.99): the lead's last focused change. C11's changed sentences, old (at 74f1175) then new, each
// exactly; the old text is gone. A sentence of an earlier list that this change replaced is this list's old text.
const MERGE_GUARD_FC2: { why: string; old: string; text: string }[] = [
  { why: "item 5: the refusal row matches the code", old: "| A page's service worker on (the merge guard, below) | `Network.setBypassServiceWorker` with `bypass` false, in a tab where the guard's `Fetch` is on | `Not available in the agent browser: Network.setBypassServiceWorker with bypass false. The merge guard keeps a page's service worker off in each tab that a client holds (the merge guard of pull requests from agentwatch issue triage).` |",
    text: "| A page's service worker on (the merge guard, below) | `Network.setBypassServiceWorker` with a `bypass` that is not true, on a session where the guard turned the bypass on: a tab's own session, or the session of a dedicated worker that the client's auto-attach brings | `Not available in the agent browser: Network.setBypassServiceWorker with bypass false. The merge guard keeps a page's service worker off in each tab that a client holds (the merge guard of pull requests from agentwatch issue triage).` |" },
  { why: "item 3: the page's policy names the blob worker of a controlled page", old: "The page's policy. While the model has no floor that the receiver confirmed on the current link (no answer yet to `bridge.mergeGuard`, an `unknown op` answer, an error, or a link change before the answer), `Page.setBypassCSP` with `enabled` true gets `Not available in the agent browser: Page.setBypassCSP.` So with no floor a page's Content Security Policy stays in force, and a client starts no worker of its own script where the page's policy forbids it. With a confirmed floor it goes to Chrome as before. A page's request never goes through a service worker in a tab where the guard's `Fetch` is on (the page's service worker, below). A worker's own request (a shared worker's or a service worker's) has no tab, and the floor blocks each write of it. A dedicated worker's request goes through the tab's own session, also with no auto-attach of the client (measured: the live check of board ab-v16.99), so the model judges it.",
    text: "The page's policy. While the model has no floor that the receiver confirmed on the current link (no answer yet to `bridge.mergeGuard`, an `unknown op` answer, an error, or a link change before the answer), `Page.setBypassCSP` with `enabled` true gets `Not available in the agent browser: Page.setBypassCSP.` So with no floor a page's Content Security Policy stays in force, and a client starts no worker of its own script where the page's policy forbids it. With a confirmed floor it goes to Chrome as before. A page's request never goes through a service worker in a tab whose bypass is on (the page's service worker, below). A worker's own request (a shared worker's or a service worker's) has no tab, and the floor blocks each write of it. A dedicated worker's request goes through the tab's own session, also with no auto-attach of the client (measured: the live check of board ab-v16.99), so the model judges it; only a blob worker of a page that a service worker controls sends its requests through that service worker (the page's service worker, below)." },
  { why: "F2 and item 3: the page's service worker, with the smallest buffers and the dedicated worker's session", old: "The page's service worker. In each tab where it turns its `Fetch` on, at the same moment and before the client gets the session, the model turns `Network` on and sends `Network.setBypassServiceWorker` with `bypass` true. So no request of the tab's pages goes through a service worker (GitHub's own code registers one on its pages), and each one is on the tab's session, where the model judges it. Chrome applies the bypass only while `Network` is on (measured: the live check of board ab-v16.99), so the model keeps `Network` on in the tab: a client's `Network.disable` there gets an answer and does not reach Chrome; a client's `Network.enable` goes to Chrome, and the bypass follows it; the tab's `Network` events go to a client only while it has `Network` on. When one of these calls fails, the tab is not turned on, as with a failed `Fetch.enable`. A client's `Network.setBypassServiceWorker` with `bypass` false there gets `Not available in the agent browser: Network.setBypassServiceWorker with bypass false. The merge guard keeps a page's service worker off in each tab that a client holds (the merge guard of pull requests from agentwatch issue triage).`; with `bypass` true it gets an answer with no change. This holds in each tab that a client holds, on every site: the first navigation into GitHub from another site would go through GitHub's worker before the model knows its target.",
    text: "The page's service worker. In each tab where it turns its `Fetch` on, at the same moment and before the client gets the session, the model turns `Network` on with the smallest buffers (`maxTotalBufferSize` and `maxResourceBufferSize` 0: Chrome takes them and then keeps no body, measured; the guard reads no `Network` data) and sends `Network.setBypassServiceWorker` with `bypass` true. So no request of the tab's pages goes through a service worker (GitHub's own code registers one on its pages), and each one is on the tab's session, where the model judges it. Chrome applies the bypass only while `Network` is on (measured: the live check of board ab-v16.99), so the model keeps `Network` on there: a client's `Network.disable` gets an answer and does not reach Chrome; a client's `Network.enable` goes to Chrome, and the bypass follows it; the session's `Network` events go to a client only while it has `Network` on. The model does the same in the session of each dedicated worker that the client's auto-attach brings, before the client lets the worker run: a blob worker of a page that a service worker controls (a page that loaded before the tab's bypass, or that the service worker claimed) sends its requests through that service worker (measured). A client's `Network.setBypassServiceWorker` with a `bypass` that is not true on such a session gets `Not available in the agent browser: Network.setBypassServiceWorker with bypass false. The merge guard keeps a page's service worker off in each tab that a client holds (the merge guard of pull requests from agentwatch issue triage).`; with `bypass` true it gets an answer with no change. This holds in each tab that a client holds, on every site: the first navigation into GitHub from another site would go through GitHub's worker before the model knows its target." },
  { why: "F1: the arm's limit", old: "(a new item after the page's service worker)",
    text: "The arm's limit. Each step of the arm waits at most 3 s (`ARM_LIMIT_MS`). `Network.enable` and the bypass go to the page's renderer, which a page's dialog, a busy or a crashed renderer can hold (measured: a `beforeunload` dialog of a navigation in a tab with no client held a raw client's `Target.setAutoAttach` and Playwright's `connectOverCDP` past 20 s). When `Fetch.enable` fails or does not answer in time, the tab is not turned on. When `Network.enable` or the bypass fails or does not answer in time, the client gets its session, the guard's `Fetch` and its `Network` rules above stay on in the tab, and the floor keeps the tab; when those calls answer later, the model names the tab to the floor then. A dialog that opened before the client's session does not reach the client's `Page.handleJavaScriptDialog` (\"No dialog is showing\", measured): the operator closes it in the live view (the live check presses its Return key), or the client closes the tab." },
  { why: "F2: every cost, named", old: "The cost of the bypass. In a tab that a client holds, a site that serves its pages only from its service worker (an offline page) does not load them; agent mode already shows no service worker to a client (Playwright's `context.serviceWorkers()` is empty). Each such tab's `Network` events cross the link, also for a client that does not turn `Network` on. The model has no session in the operator's own tabs, so a write that a page's service worker sends there for a page of a guarded host has no tab, and the floor blocks it (measured with the stand-in's worker: the write through the worker was blocked, a write of the page itself went).",
    text: "The cost of the bypass, in each tab that a client holds, on every site: (1) a site that needs its service worker does not work there: an offline page, a development mock such as Mock Service Worker, a download or a stream that the worker makes, a header or a token that the worker adds; agent mode already shows no service worker to a client (Playwright's `context.serviceWorkers()` is empty), Playwright's `serviceWorkers: 'allow'` acts as `'block'`, and Puppeteer's `page.setBypassServiceWorker(false)` fails; (2) `Network` is on also for a client that never turns it on: Chrome keeps its buffers for the tab (the guard's smallest ones, until a client turns `Network` on with its own), and the tab's `Network` events cross the link, where the model drops them; (3) a client's `Network.disable` no longer reaches Chrome, so the client's `Network` state (extra headers, blocked URLs, network conditions, the cache setting, buffer sizes) stays until the detach; (4) a client that turns `Network` on late gets later events of requests that started before, with no `requestWillBeSent`, and a `Fetch.requestPaused` can name a `networkId` whose events that client never got; (5) the arm's limit: a page's dialog or a busy renderer at a client's first session makes it wait up to 3 s for each step, and the floor keeps that tab until the bypass answers. The model has no session in the operator's own tabs, so a write that a page's service worker sends there for a page of a guarded host has no tab, and the floor blocks it (measured with the stand-in's worker: the write through the worker was blocked, a write of the page itself went)." },
  { why: "F1 and item 4: the floor's tabs", old: "`[{\"hosts\":[...],\"tabs\":[...]}]`: the guarded hosts and every tab where its `Fetch` is on.",
    text: "`[{\"hosts\":[...],\"tabs\":[...]}]`: the guarded hosts and every tab where its `Fetch` and the bypass are on." },
  { why: "F1: the floor of a tab whose bypass does not answer", old: "A tab whose `Fetch.enable`, `Network.enable` or `Network.setBypassServiceWorker` fails is not turned on, so the floor keeps its writes blocked.",
    text: "A tab whose `Fetch.enable`, `Network.enable` or `Network.setBypassServiceWorker` fails or does not answer in the arm's limit is not named, so the floor keeps its writes blocked." },
  { why: "item 3 and F1: what it cannot stop, the blob worker with no auto-attach and the bypass not answered yet", old: "(new words in the item of what it cannot stop)",
    text: "with no floor, a write of a blob worker of a page that a service worker controls when the client's auto-attach does not bring the worker (the write goes through the service worker, measured), and a page's request that a service worker takes in a tab whose bypass has not answered yet (the arm's limit);" },
  { why: "item 7: the frame of another site, said truly", old: "with a confirmed floor and the page's policy bypassed, a write of a frame of another site in a page of a guarded host that the client's auto-attach does not bring (the browser sends it as a cross-site request);",
    text: "in a page of any site, a write of a frame of another site that the client's auto-attach does not bring: it has no session, and the floor leaves the tab to layer 1; the request is cross-site, so it carries none of GitHub's SameSite cookies; the board task ab-v16.100 (an initiator rule in the floor) closes it;" },
  { why: "item 6: the old path's floor, with the carrier in the next sentence", old: "The relay of the old path has the floor once that receiver release is pinned: agentwatch's carrier passes the op on unchanged, with no agentwatch change. Until then `Page.setBypassCSP` with `enabled` true stays refused on both paths.",
    text: "The relay of the old path has the floor once that receiver release is pinned, with no agentwatch change. Until then `Page.setBypassCSP` with `enabled` true stays refused on both paths." },
  { why: "item 6: the release, in the lead's words", old: "agentwatch's `triage enable` must require both the agent-browser commit with this guard and the receiver release with the floor (0.3.8), not either one alone.",
    text: "agentwatch's `triage enable` must require an agent-browser commit at or after this guard's merge commit, and a receiver version at or after the first release with the floor (0.3.8); agentwatch's carrier passes `bridge.mergeGuard` on to the receiver and the receiver's answer back, both unchanged (a carrier that answers the op itself would confirm a floor that is not there)." },
];
test("review-125b: C11 says each changed sentence exactly, and no replaced text; the release and the frame in the lead's words", async () => {
  const { GUARD_TEXT, ARM_LIMIT_MS, GUARD_NETWORK } = await import("../src/relay/merge-guard.ts");
  assert.equal(MERGE_GUARD_FC2.length, 11);
  for (const e of MERGE_GUARD_FC2) {
    assert.ok(says(C11, e.text) || replacedByFc(e.text), `${e.why}: ${e.text.slice(0, 120)}`);
    if (!e.old.startsWith("(a new") && !e.old.startsWith("(new words")) assert.ok(!says(C11, e.old), `${e.why}: the old text is gone`);
  }
  const p = flat(partOr(MERGE_GUARD_HEADING));
  assert.ok(p.includes("agentwatch's `triage enable` must require an agent-browser commit at or after this guard's merge commit, and a receiver version at or after the first release with the floor (0.3.8); agentwatch's carrier passes `bridge.mergeGuard` on to the receiver and the receiver's answer back, both unchanged (a carrier that answers the op itself would confirm a floor that is not there)."), "the release, in the lead's words");
  assert.ok(p.includes(nowText("in a page of any site, a write of a frame of another site that the client's auto-attach does not bring: it has no session, and the floor leaves the tab to layer 1; the request is cross-site, so it carries none of GitHub's SameSite cookies; the board task ab-v16.100 (an initiator rule in the floor) closes it;")), "the frame, in the lead's words, as the pin of 0.3.11 changed them");
  assert.ok(p.includes(`Each step of the arm waits at most ${ARM_LIMIT_MS / 1000} s (\`ARM_LIMIT_MS\`).`), "the code's limit");
  assert.ok(p.includes(`(\`maxTotalBufferSize\` and \`maxResourceBufferSize\` ${GUARD_NETWORK.maxTotalBufferSize}:`) && GUARD_NETWORK.maxResourceBufferSize === 0, "the code's buffers");
  const refusals = flat(partOr("Refusals."));
  assert.ok(refusals.includes(`| \`Network.setBypassServiceWorker\` with a \`bypass\` that is not true, on a session where the bypass is on: a tab's own session while its main frame is on a guarded host, or the session of a dedicated worker of such a tab that the client's auto-attach brings | \`${GUARD_TEXT.serviceWorker}\` |`), "the row has the code's text (as the operator's ab-u92 changed it)");
  for (const cost of ["Mock Service Worker", "Playwright's `serviceWorkers: 'allow'` acts as `'block'`", "Puppeteer's `page.setBypassServiceWorker(false)` fails", "(extra headers, blocked URLs, network conditions, the cache setting, buffer sizes) stays", "with no `requestWillBeSent`, and a `Fetch.requestPaused` can name a `networkId` whose events that client never got", "the arm's limit: a page's dialog or a busy renderer"]) assert.ok(p.includes(cost), cost);
});

// The lead's focused change (board ab-v16.99): the page's service worker. C11's changed sentences, old (at de5a7b0) then new,
// each exactly; the old text is gone. A sentence of an earlier list that this change replaced is this list's old text.
const MERGE_GUARD_FC: { why: string; old: string; text: string }[] = [
  { why: "the routing sentence", old: "Every other call on a page session goes to Chrome (`debugger.sendCommand`), after the refusals below; the merge guard (below) changes a client's `Fetch` calls on the way.",
    text: "Every other call on a page session goes to Chrome (`debugger.sendCommand`), after the refusals below; the merge guard (below) changes a client's `Fetch` calls and some of its `Network` calls on the way." },
  { why: "the refusal of a page's service worker", old: "(a new row after the merge guard's rows)",
    text: "| A page's service worker on (the merge guard, below) | `Network.setBypassServiceWorker` with `bypass` false, in a tab where the guard's `Fetch` is on | `Not available in the agent browser: Network.setBypassServiceWorker with bypass false. The merge guard keeps a page's service worker off in each tab that a client holds (the merge guard of pull requests from agentwatch issue triage).` |" },
  { why: "item 4: the page's policy, with no premise of GitHub's worker-src", old: "The page's policy. While the model has no floor that the receiver confirmed on the current link (no answer yet to `bridge.mergeGuard`, an `unknown op` answer, an error, or a link change before the answer), `Page.setBypassCSP` with `enabled` true gets `Not available in the agent browser: Page.setBypassCSP.` So a page's Content Security Policy stays in force: on GitHub only GitHub's own scripts run in a worker (its `worker-src`). With a confirmed floor it goes to Chrome as before: a write of a shared worker or a service worker has no tab, and the floor blocks it. A dedicated worker's request goes through the tab's own session, also with no auto-attach of the client (measured: the live check of board ab-v16.99), so the model judges it.",
    text: "The page's policy. While the model has no floor that the receiver confirmed on the current link (no answer yet to `bridge.mergeGuard`, an `unknown op` answer, an error, or a link change before the answer), `Page.setBypassCSP` with `enabled` true gets `Not available in the agent browser: Page.setBypassCSP.` So with no floor a page's Content Security Policy stays in force, and a client starts no worker of its own script where the page's policy forbids it. With a confirmed floor it goes to Chrome as before. A page's request never goes through a service worker in a tab where the guard's `Fetch` is on (the page's service worker, below). A worker's own request (a shared worker's or a service worker's) has no tab, and the floor blocks each write of it. A dedicated worker's request goes through the tab's own session, also with no auto-attach of the client (measured: the live check of board ab-v16.99), so the model judges it." },
  { why: "item 2: the rule of the page's service worker", old: "(a new item after the page's policy)",
    text: "The page's service worker. In each tab where it turns its `Fetch` on, at the same moment and before the client gets the session, the model turns `Network` on and sends `Network.setBypassServiceWorker` with `bypass` true. So no request of the tab's pages goes through a service worker (GitHub's own code registers one on its pages), and each one is on the tab's session, where the model judges it. Chrome applies the bypass only while `Network` is on (measured: the live check of board ab-v16.99), so the model keeps `Network` on in the tab: a client's `Network.disable` there gets an answer and does not reach Chrome; a client's `Network.enable` goes to Chrome, and the bypass follows it; the tab's `Network` events go to a client only while it has `Network` on. When one of these calls fails, the tab is not turned on, as with a failed `Fetch.enable`. A client's `Network.setBypassServiceWorker` with `bypass` false there gets `Not available in the agent browser: Network.setBypassServiceWorker with bypass false. The merge guard keeps a page's service worker off in each tab that a client holds (the merge guard of pull requests from agentwatch issue triage).`; with `bypass` true it gets an answer with no change. This holds in each tab that a client holds, on every site: the first navigation into GitHub from another site would go through GitHub's worker before the model knows its target." },
  { why: "items 2 and 3: the cost of the bypass, and the operator's own tabs", old: "(a new item after the page's service worker)",
    text: "The cost of the bypass. In a tab that a client holds, a site that serves its pages only from its service worker (an offline page) does not load them; agent mode already shows no service worker to a client (Playwright's `context.serviceWorkers()` is empty). Each such tab's `Network` events cross the link, also for a client that does not turn `Network` on. The model has no session in the operator's own tabs, so a write that a page's service worker sends there for a page of a guarded host has no tab, and the floor blocks it (measured with the stand-in's worker: the write through the worker was blocked, a write of the page itself went)." },
  { why: "item 2: the floor of a tab whose bypass fails", old: "A tab whose `Fetch.enable` fails is not turned on, so the floor keeps its writes blocked.",
    text: "A tab whose `Fetch.enable`, `Network.enable` or `Network.setBypassServiceWorker` fails is not turned on, so the floor keeps its writes blocked." },
  { why: "item 4: what it cannot stop, a worker's own write with no floor", old: "a request of a shared worker or a service worker, which no tab's session sees, where GitHub's `worker-src` runs only GitHub's own scripts and the floor blocks the writes of a worker with no tab;",
    text: "with no floor, a write that a shared worker or a service worker sends by itself (not a page's request), for example a background sync, which no tab's session sees;" },
  { why: "item 4: the release, both parts before agentwatch's triage enable", old: "(new words in the release item)",
    text: "agentwatch's `triage enable` must require both the agent-browser commit with this guard and the receiver release with the floor (0.3.8), not either one alone." },
];
// The service's pin of receiver 0.3.8 (board ab-v16.97.10, with its review-127 B1): C11's changed sentences of the release
// item, old (at d37e49f) then new, each exactly; the old text is gone. A sentence of an earlier list that this change replaced
// is this list's old text.
const MERGE_GUARD_PIN: { why: string; old: string; text: string }[] = [
  { why: "the service pins the receiver with the floor", old: "(new words in the release item, after the floor's release)",
    text: "The floor comes with the receiver's release that adds `bridge.mergeGuard` and with the pin of agent-browser that names it. The service pins that release or a later one, the receiver 0.3.16 (board ab-v16.97.10, ab-v16.102, ab-v16.94.7.7, ab-v16.100, ab-v16.112, ab-v16.115, ab-sta.4, ab-4wh.2; C12, the agent package): its model has the floor once the receiver confirms it on the current link, and then `Page.setBypassCSP` with `enabled` true goes to Chrome." },
  { why: "the old path: agentwatch's own pin of the receiver, and the refusal only there", old: "The relay of the old path has the floor once that receiver release is pinned, with no agentwatch change. Until then `Page.setBypassCSP` with `enabled` true stays refused on both paths.",
    text: "The relay of the old path has the guard and the floor only when agentwatch moves both of its pins at once (chrome-extension's C1: agentwatch pins both repositories and moves them at once): its agent-browser pin to a commit at or after this guard's merge commit (`d37e49f`), and its receiver pin to a release at or after 0.3.8, with no other agentwatch change. With the guard and a receiver before the floor, `Page.setBypassCSP` with `enabled` true stays refused on the old path. A receiver with the floor under a relay with no guard (an agent-browser commit before `d37e49f`) names no guarded tab, so its floor blocks each write to GitHub's hosts from every client tab and from each request with no tab (fail closed), and that relay lets `Page.setBypassCSP` with `enabled` true go to Chrome." },
];
// Board ab-v16.100: the service pins the receiver 0.3.11 (chrome-extension 9fd239f, PR #49: the merge guard's floor gets
// the initiator rule, C5's rule 89). The texts that the pin move changes, old then new, each exactly; the old text is gone.
// The C11 entries are the last list of nowText; the test is at the end of the file.
const PIN_0311: { file: "C11" | "C12"; why: string; old: string; text: string }[] = [
  { file: "C11", why: "the release item names the service's pin",
    old: "The service pins that release or a later one, the receiver 0.3.10 (board ab-v16.97.10, ab-v16.102, ab-v16.94.7.7; C12, the agent package)",
    text: "The service pins that release or a later one, the receiver 0.3.11 (board ab-v16.97.10, ab-v16.102, ab-v16.94.7.7, ab-v16.100; C12, the agent package)" },
  { file: "C12", why: "the sender of the pinned commit",
    old: "`sender` gives the sender of the chrome-extension commit that agent-browser pins (`3d0a54a`, C1).",
    text: "`sender` gives the sender of the chrome-extension commit that agent-browser pins (`9fd239f`, C1)." },
  { file: "C11", why: "what it cannot stop: rule 89 closes the frame of another site; the frame of a guarded host stays out (C5)",
    old: "in a page of any site, a write of a frame of another site that the client's auto-attach does not bring: it has no session, and the floor leaves the tab to layer 1; the request is cross-site, so it carries none of GitHub's SameSite cookies; the board task ab-v16.100 (an initiator rule in the floor) closes it;",
    text: "with no floor, or with the floor of a receiver before 0.3.11 (the old path while agentwatch pins such a receiver), in a page of any site, a write of a frame of another site that the client's auto-attach does not bring: it has no session, and no rule of that floor blocks it in the tab, so only layer 1 is left; the request is cross-site, so it carries none of GitHub's SameSite cookies; the floor of the receiver 0.3.11 or a later one closes that case with its initiator rule (C5's rule 89, board ab-v16.100): it blocks each write to a guarded host from a page or a frame of another host (not a top-level request) in every tab except the operator's marked tabs and the act tabs, the guarded tabs too; with that rule, in a guarded tab, a write of a frame of a guarded host in a page of another host that the client's auto-attach does not bring: it has no session in the tab, rule 89 passes it (its initiator is a guarded host), and no layer of the guard judges it (C5's \"What it does not stop\");" },
];
// Board ab-v16.112: the service pins the receiver 0.3.13 (chrome-extension 8819e7e, PR #51; with 0.3.12 of PR #50). The
// texts that the pin move changes, old then new, each exactly; the old text is gone. The new words say what 0.3.12
// (board ab-v16.88) and 0.3.13 (board ab-v16.67) change, from chrome-extension's C10 at 8819e7e. The C11 entries are
// the last list of nowText; the test is at the end of the file.
const PIN_0313: { file: "C11" | "C12"; why: string; old: string; text: string }[] = [
  { file: "C11", why: "the release item names the service's pin",
    old: "The service pins that release or a later one, the receiver 0.3.11 (board ab-v16.97.10, ab-v16.102, ab-v16.94.7.7, ab-v16.100; C12, the agent package)",
    text: "The service pins that release or a later one, the receiver 0.3.13 (board ab-v16.97.10, ab-v16.102, ab-v16.94.7.7, ab-v16.100, ab-v16.112; C12, the agent package)" },
  { file: "C12", why: "the sender of the pinned commit",
    old: "`sender` gives the sender of the chrome-extension commit that agent-browser pins (`9fd239f`, C1).",
    text: "`sender` gives the sender of the chrome-extension commit that agent-browser pins (`8819e7e`, C1)." },
  { file: "C11", why: "what the receivers 0.3.12 and 0.3.13 change (C10)", old: "(new words in the release item, after `Page.setBypassCSP` goes to Chrome)",
    text: "At a link change the receiver 0.3.12 (board ab-v16.88; chrome-extension's C10) ends no attachment while a `Target.closeTarget` command of a receiver's close runs on it: its cleanup waits for that command's answer before the detach. The receiver 0.3.13 (board ab-v16.67; C10) sends a second `Target.closeTarget` for a dropped close (Chrome answered the close's command with no error and closed no tab) before the fallback's `chrome.tabs.remove`, and the close's item waits for it, so an item of the receiver's removal queue ends at most five times `REMOVAL_WAIT_MS` (10 s) after it starts, not three times (6 s)." },
];
// Board ab-b84.44: the service pins chrome-extension d0a3d49 (PR #52, board ab-b84.43: the sender 0.2.1; the receiver
// stays 0.3.13). C12's sender names the new pin and the sender's new version, old then new, each exactly; the old text
// is gone. C11 does not change. The test is at the end of the file.
const PIN_SENDER_021: { file: "C11" | "C12"; why: string; old: string; text: string }[] = [
  { file: "C12", why: "the sender of the pinned commit",
    old: "`sender` gives the sender of the chrome-extension commit that agent-browser pins (`8819e7e`, C1).",
    text: "`sender` gives the sender of the chrome-extension commit that agent-browser pins (`d0a3d49`, C1)." },
  { file: "C12", why: "the sender's version",
    old: "`version` is the version in the manifest of that commit's `operator/` folder (`0.2.0`), not the receiver's version.",
    text: "`version` is the version in the manifest of that commit's `operator/` folder (`0.2.1`), not the receiver's version." },
];
// Board ab-v16.115: the service pins the receiver 0.3.14 (chrome-extension a25bfa8, PR #53, board ab-v16.83; the sender
// stays 0.2.1). The texts that the pin move changes, old then new, each exactly; the old text is gone. The new words say
// what 0.3.14 changes, from chrome-extension's C5 (the worker removal of the recorded origins) and C10 (the fetch
// window's download cancel) at a25bfa8. The C11 entries are the last list of nowText; the test is at the end of the
// pin tests.
const PIN_0314: { file: "C11" | "C12"; why: string; old: string; text: string }[] = [
  { file: "C11", why: "the release item names the service's pin",
    old: "The service pins that release or a later one, the receiver 0.3.13 (board ab-v16.97.10, ab-v16.102, ab-v16.94.7.7, ab-v16.100, ab-v16.112; C12, the agent package)",
    text: "The service pins that release or a later one, the receiver 0.3.14 (board ab-v16.97.10, ab-v16.102, ab-v16.94.7.7, ab-v16.100, ab-v16.112, ab-v16.115; C12, the agent package)" },
  { file: "C12", why: "the sender of the pinned commit",
    old: "`sender` gives the sender of the chrome-extension commit that agent-browser pins (`d0a3d49`, C1).",
    text: "`sender` gives the sender of the chrome-extension commit that agent-browser pins (`a25bfa8`, C1)." },
  { file: "C11", why: "what the receiver 0.3.14 changes (C5, C10)", old: "(new words in the release item, after what 0.3.13 changes)",
    text: "The receiver 0.3.14 (board ab-v16.83; chrome-extension's C5 and C10) changes two parts. Its worker removal of the recorded origins (C5) takes review-30h's notes: a stop of a check or a failed call later in it keeps due only the origins that the check has neither removed nor recorded again, so the next removal of a recorded origin gets a follow-up check of its own; a due origin that a commit put back into the record or the pending set and that the check removes gets a follow-up check for that removal too; a list end's removal of every worker also keeps the origins that are due for a follow-up check of the sites that the marked tabs show or that the remaining lists cover; and a running check drops the origins that tabs commit during it just before its call, and notes none during the call. C5 states one more limit: that removal keeps only the origins that are due when its check starts, so a worker that its page registered again after its removal goes at a list end within about two times `RECHECK_MS` (10 s) of that removal, also when a marked tab shows its site or a list in force covers it. In the fetch window's download cancel (C10), the receiver cancels no incognito download while an act tab is open and no fetch tab is: such a download is the act's or the operator's, and the fetch window's rules are then left ones (for example those of a `fetch_end` that answered `rules not removed`). C10 states two limits: the receiver still cancels each download of a private window that the operator opens while a fetch tab is open, or while only the fetch window's rules are left and no act tab is open; and its cancel at `downloads.onCreated` races Chrome's completion of a small download, whose file then stays." },
];
// Board ab-sta.4 (the secure card checkout, Task 3): the service pins the receiver 0.3.15 (chrome-extension 9962e11, PR
// #54; the sender stays 0.2.1). The texts that the pin move changes, old then new, each exactly; the old text is gone.
// The new words say what 0.3.15 changes, from chrome-extension's C4 (the requests pay_cookies_copy and
// pay_merchant_block, the hello's feature pay) and C5 (rule 90) at 9962e11, and that the service serves no payment tool
// yet (C11's card payment: the transport guard stays). The C11 entries are the last list of nowText; the test is at the
// end of the pin tests.
const PIN_0315: { file: "C11" | "C12"; why: string; old: string; text: string }[] = [
  { file: "C11", why: "the release item names the service's pin",
    old: "The service pins that release or a later one, the receiver 0.3.14 (board ab-v16.97.10, ab-v16.102, ab-v16.94.7.7, ab-v16.100, ab-v16.112, ab-v16.115; C12, the agent package)",
    text: "The service pins that release or a later one, the receiver 0.3.15 (board ab-v16.97.10, ab-v16.102, ab-v16.94.7.7, ab-v16.100, ab-v16.112, ab-v16.115, ab-sta.4; C12, the agent package)" },
  { file: "C12", why: "the sender of the pinned commit",
    old: "`sender` gives the sender of the chrome-extension commit that agent-browser pins (`a25bfa8`, C1).",
    text: "`sender` gives the sender of the chrome-extension commit that agent-browser pins (`9962e11`, C1)." },
  { file: "C11", why: "what the receiver 0.3.15 changes (C4, C5), and no payment tool yet", old: "(new words in the release item, after what 0.3.14 changes)",
    text: "The receiver 0.3.15 (board ab-sta.4; chrome-extension's C4 and C5) adds the receiver's part of the pay act of the card payment (below) and the hello's feature `pay`. The C4 request `pay_cookies_copy` (`{tab, domain}`, answered `{count}`) writes the default context's cookies of a registrable domain and its subdomains, httpOnly included, into the act tab's own store, and its answer holds the count only, never a name or a value: the one read of the default store that the receiver makes for an act, a narrow exception to review-ce44 N10, for the pay act only. The C4 request `pay_merchant_block` (`{tab, domain, on}`, answered `{rules}`) adds or removes C5's rule 90: from the copy of the merchant's session to the act's end, it blocks each request to the merchant's registrable domain from every tab except the act tabs, so that an agent's tab cannot change the cart or the order; a request of a worker has no tab, so rule 90 also blocks the merchant's requests of a worker of the act's own context (C5's stated limit). `act_end` and a start of the receiver's worker remove rule 90 with the act's rules. Both requests refuse a domain with no dot and an IP literal (`bad request`). The service sends neither request and tests no feature `pay` yet: no service has the payment act, so a `tools/list` holds neither `browser_pay` nor `browser_pay_status`, and a call of either gets the allow list's `-32601` answer (the card payment, below)." },
];
// Board ab-sta.6 (the secure card checkout, Task 5a; review-225's N1 and N2): C11's card text agrees with the receiver
// 0.3.15 as merged and with the service's preparation (src/service/pay/act.ts). N1: only a local call of a payment tool
// gets the allow list's -32601 answer (a remote call gets C11's refusal). N2: the receiver has no act kind `pay`, but two
// requests of its feature `pay` (C4's pay_merchant_block and pay_cookies_copy) and C5's rule 90, which blocks the
// merchant's domain from every tab except the act tabs, and also the workers of the act's own context. The request's
// text also says where the domain comes from (Chrome's public suffix list), the storage's write in a blank document, the
// act's rules and the window's end at each end of a request. Old then new, each exactly; the old text is gone.
const CARD_COPY: { file: "C11"; why: string; old: string; text: string }[] = [
  { file: "C11", why: "review-225 N1: the release item of 0.3.15: only a local call gets -32601",
    old: "and a call of either gets the allow list's `-32601` answer (the card payment, below).",
    text: "and a local call of either gets the allow list's `-32601` answer (the card payment, below)." },
  { file: "C11", why: "review-225 N1: the card payment's admission",
    old: "While the service has no payment act, a `tools/list` holds neither tool, and a call of either gets the allow list's `-32601` answer.",
    text: "While the service has no payment act, a `tools/list` holds neither tool, and a local call of either gets the allow list's `-32601` answer (a remote call gets the refusal below)." },
  { file: "C11", why: "review-225 N2: the request: the receiver's two requests and rule 90 (its tabs and the workers), the domain from Chrome, the storage, the act's rules",
    old: "It copies the merchant's session into a new act window (the receiver's act kind `pay`: C4, C5 and C10). From the copy to the act's end, the receiver blocks each request of the default context to the merchant's registrable domain, so the agent's tabs cannot change the cart or the order. The act tab loads the tab's URL, and the service reads the page's order:",
    text: "It copies the merchant's session into a new act window (C10's act window, with the receiver's two requests of the hello's feature `pay`: C4's `pay_merchant_block` and `pay_cookies_copy`, and C5's rule 90). The merchant's registrable domain is the one that Chrome gives for the main frame of the agent's tab (Chrome's public suffix list), read before any request to the receiver: an empty one (a host that is itself a public suffix), an IP literal, or one that is not the host or a parent of it stops the request with the session copy's text, and a host that ends in `.localhost` (a loopback test host) is its own domain (a bare `localhost` stops). From the copy to the act's end, rule 90 blocks each request to the merchant's registrable domain from every tab except the act tabs, so the agent's tabs cannot change the cart or the order; a request of a worker has no tab, so rule 90 also blocks the merchant's requests of a worker of the act's own context (C5's stated limit). The service reads the origin's `localStorage` from the agent's tab by CDP and writes it into the act's context before any script of the merchant runs: the act's `Fetch` answers the first load of the origin with a blank document, and the service writes the storage there. The act tab loads the tab's URL, the act's rules (C4's `act_rules`) hold, and the service reads the page's order:" },
  { file: "C11", why: "the request: each end ends the act window",
    old: "(new words at the end of the request's item)",
    text: "Each end of a request ends its act window with the act's clean end (below), also before the approval, so `act_end` removes rule 90 with the act's rules." },
];
// Board ab-sta.7 (the secure card checkout, Task 5b): the payment act exists behind the service's option `--card-pay`
// (off by default; agentwatch does not pass it). C11 says each text of CARD_ACT exactly, and each old text is gone.
const CARD_ACT: { file: "C11"; why: string; old: string; text: string }[] = [
  { file: "C11", why: "the card payment, item 1: only a service started with --card-pay has the payment act", old: "This part fixes the contract of the payment act: the service builds the act later (the plan's Tasks 4 and 5), off by default, on Linux first.", text: "This part fixes the contract of the payment act (the plan's Tasks 4 and 5). Only a service that agent-browser's command starts with `--card-pay` has the payment act, on Linux only (board ab-sta.7): the option is off by default, and agentwatch does not start the service so yet." },
  { file: "C11", why: "the card payment's admission: only a service started with --card-pay", old: "Today no service has the payment act.", text: "Only a service that agent-browser's command starts with `--card-pay` has the payment act, and agentwatch does not start the service so yet." },
  { file: "C11", why: "the release item of 0.3.15: only a service with the payment act sends the pay act's requests", old: "The service sends neither request and tests no feature `pay` yet: no service has the payment act, so a `tools/list` holds neither `browser_pay` nor `browser_pay_status`, and a local call of either gets the allow list's `-32601` answer (the card payment, below).", text: "Only a service with the payment act (`--card-pay`) sends either request and tests the feature `pay`; with no payment act a `tools/list` holds neither `browser_pay` nor `browser_pay_status`, and a local call of either gets the allow list's `-32601` answer (the card payment, below)." },
  { file: "C11", why: "the act: the stops before the first key (review-227 N1, N5c), the guard's forms and providers, the focus, the rules after the press, the end", old: "(new words at the end of the act's item)", text: "Before its first key the act stops with the text of a lost window when the act tab opened a popup, when the act window has another tab, or when the act cannot read the window's tabs, and with the text of the act's rules when the act page keeps a WebSocket or a WebTransport open to a host outside the act's rules (the sign-in act's form rule 6), or when the guard cannot start in a frame or a worker of the act tab. The guard fails each request of the act tab, its frames and its workers whose URL holds the card's number (its digits, or groups of them with spaces, dashes, `+` or `%20`, also after a percent-decoding of each `%XX`), and each one whose body holds it, unless the request goes to a provider: an origin of the list of payment providers' origins, or a host of a listed host's own domain with the listed origin's scheme (the listed host without its first label, when that still has a dot). A request whose body Chrome does not give fails too, unless it goes to a provider. Each value of a text field goes into the field after a person's click on it; a select of the expiry's month or year gets its option from a script in the act's own isolated world. Before each key the act checks that the provider frame still shows the document that it found, that the field has the focus of that document, and that the act page's own focus is on the provider frame; else it stops and empties the fields. After the fill the act unticks the save-card boxes again, and right before the press it reads the total and the boxes once more. When a request takes the card's number to a provider before the press (a page that pays when the card is complete; the guard lets it go), the act writes the keep's `unknown` at once, and each later end of the act before the press is Unknown with the Unknown text, never `Not paid`; when that write fails, the act stops at once, and its result is Unknown. After the press the act's rules grow by the origins that the act page and its frames then call (C4's `act_rules` again, with at most 32 origins, and never after the act's end), and the guard still applies to each request. The result reader gives Declined only while the page stays and a new line near the card fields (a line of the page's alert or status regions, or of a provider frame) names a decline; a page whose new lines also name a confirmation gives Unknown, and the lines that the page showed before the press count for no result, also after a new page. At its end the act empties the fields of each provider frame and fills the buffers of the card's values with zeros." },
  { file: "C11", why: "the table: an open connection outside the act's rules (review-227 N1)", old: "| The act's rules | `stopped` | `The agent browser could not hold the payment's rules.` |", text: "| The act's rules, or before the first key a connection of the act page that is open to a host outside them, or a frame or a worker where the guard cannot start | `stopped` | `The agent browser could not hold the payment's rules.` |" },
  { file: "C11", why: "the table: a field that lost the focus during the fill", old: "| A provider frame that loaded again during the fill (the act empties the fields) | `stopped` | `The payment provider's frame loaded again during the fill.` |", text: "| A provider frame that loaded again during the fill, or a field that lost the focus during it (the act empties the fields) | `stopped` | `The payment provider's frame loaded again during the fill.` |" },
  { file: "C11", why: "the table: a stop after the card's number went to the provider before the press is Unknown (review-228 N8, the lead's call)", old: "| Each other end after the press (no confirmation within 60 s, a lost tab, a link change, a stop of the service, the act's 5 minutes) | `unknown` | `The payment's result is unknown. Do not pay again: check the merchant's mail or account.` |", text: "| Each other end after the press (no confirmation within 60 s, a lost tab, a link change, a stop of the service, the act's 5 minutes), or a stop after the card's number went to the provider before the press | `unknown` | `The payment's result is unknown. Do not pay again: check the merchant's mail or account.` |" },
  { file: "C11", why: "the table: a popup or another tab of the act window (review-227 N5c)", old: "| The act tab is gone before the press | `stopped` | `The agent browser lost the payment window before the payment.` |", text: "| The act tab is gone before the press, or before the first key it opened a popup, the act window has another tab, or the act cannot read the window's tabs | `stopped` | `The agent browser lost the payment window before the payment.` |" },
];
// Board ab-sta.8 (the card payment's live check; the lead's design call after it): Chrome applies the act's rules before
// the act's Fetch sees a request, so the act's rules stay after the press and hold the act's provider's frame and API
// origins from the start, sent again once the card fields are found; the guard lets a body with the number go only to the
// act's provider; a dedicated worker of an act tab sends its requests with the act tab's id, so rule 90 lets them go. C11
// says each text exactly, each old text is gone; the card part's items 25 and 27 hold them.
const CARD_LIVE: { file: "C11"; why: string; old: string; text: string }[] = [
  { file: "C11", why: "rule 90 and the act's workers (measured: a dedicated worker's requests carry the act tab's id), in the release item of 0.3.15 and in the request", old: "a request of a worker has no tab, so rule 90 also blocks the merchant's requests of a worker of the act's own context (C5's stated limit).", text: "a request of a worker with no tab (a service worker or a shared worker) of the act's own context is blocked by rule 90 too (C5's stated limit), while a dedicated worker of an act tab sends its requests with the act tab's id, so rule 90 lets them go (measured on the Linux server, board ab-sta.8)." },
  { file: "C11", why: "the request: the act's rules again once the card fields are found, with the act's provider's frame and API origins", old: "The act tab loads the tab's URL, the act's rules (C4's `act_rules`) hold, and the service reads the page's order:", text: "The act tab loads the tab's URL, and the act's rules (C4's `act_rules`) hold. Once the act finds the card fields, the service sends the act's rules again, with the request's origin, then the card-field frame and API origins of the one provider whose frames hold the card fields (the act's provider, from the service's list of payment providers), then the merchant's origins that the act tab called, at most 32 and no other provider's origin, and the receiver confirms them before the `pay_request` and before the first key; card fields in the frames of two providers stop the request with the text of card fields outside a provider frame. The service reads the page's order:" },
  { file: "C11", why: "the act: the guard lets a body with the number go only to the act's provider", old: "unless the request goes to a provider: an origin of the list of payment providers' origins, or a host of a listed host's own domain with the listed origin's scheme (the listed host without its first label, when that still has a dot). A request whose body Chrome does not give fails too, unless it goes to a provider.", text: "unless the request goes to the act's provider: an origin of its card-field frames or of its API, or a host of such a listed host's own domain with the listed origin's scheme (the listed host without its first label, when that still has a dot); a body with the number to another provider's origin fails. A request whose body Chrome does not give fails too, unless it goes to the act's provider." },
  { file: "C11", why: "the act: after the press the act's rules stay (measured: Chrome applies them before the act's Fetch)", old: "After the press the act's rules grow by the origins that the act page and its frames then call (C4's `act_rules` again, with at most 32 origins, and never after the act's end), and the guard still applies to each request.", text: "After the press the act's rules stay as they were at the fill, and the guard still applies to each request: Chrome applies the act's rules before the act's `Fetch` sees a request, so the act cannot learn a new origin after the press (measured on the Linux server, board ab-sta.8); a top-level GET navigation stays open (C5), so a confirmation on another host still loads." },
  { file: "C11", why: "the act: card fields found again outside the act's provider's frames stop it", old: "(new words after the hash's stop, in the act's item)", text: "The act reads the page's order again, and a hash that differs from the approved one stops it. Card fields that it finds again outside the act's provider's frames stop it with the text of card fields outside a provider frame." },
  { file: "C11", why: "the act: a dedicated worker attached on the act tab's own session (no Fetch of its own; the tab's Fetch pauses its requests: measured) keeps the guard, each other one stops (review-229 N2)", old: "or when the guard cannot start in a frame or a worker of the act tab. The guard fails", text: "or when the guard cannot start in a frame or a worker of the act tab. A dedicated worker that Chrome attaches on the act tab's own session has no `Fetch` of its own through the receiver's debugger, and the act tab's own `Fetch` pauses that worker's requests (measured on the Linux server, board ab-sta.8), so the guard holds there; each other frame or worker whose `Fetch` cannot start stops the act. The guard fails" },
];
// Board ab-sta.14 (review-231 N3; the lead's decision: fail closed): the service cannot tie a provider's hosted payment
// page to the merchant (no view of a server redirect, and the agent can forge a link, a history entry or a referrer), so
// check 6 counts only a tab of the origin, the act page's origin must be the request's, and a hosted payment page stops
// with a text of its own until a binding exists; after the approval the act page must still be the page of the
// preparation (review-232 N1), and the limits name the stop (review-232 N3). C11 says each text exactly, each old text is
// gone; the card part's items 22, 25, 27, 51a and 81a hold them.
const CARD_HOSTED: { file: "C11"; why: string; old: string; text: string }[] = [
  { file: "C11", why: "check 6: only a tab of the origin counts; a hosted payment page stops", old: "Exactly one tab of the scope shows a page of the origin, or a known provider's hosted payment page (the service's list of payment providers' origins, the design's section 8.4): the agent's tab. `origin` stays the merchant's origin.", text: "Exactly one tab of the scope shows a page of the origin: the agent's tab. The service cannot tie a known provider's hosted payment page (an origin of the service's list of payment providers' origins, the design's section 8.4) to the merchant, so such a page is no page of the origin (board ab-sta.14): when the origin is such an origin, or when no tab of the scope shows the origin and a tab of the scope shows such a page, the request stops with the text of a hosted payment page." },
  { file: "C11", why: "the request: the act page's origin must be the request's; a hosted payment page there stops", old: "The act tab loads the tab's URL, and the act's rules (C4's `act_rules`) hold.", text: "The act tab loads the tab's URL, and the act's rules (C4's `act_rules`) hold; the act page's origin must be the request's origin, and a known provider's hosted payment page there (a page that moved after check 6) stops the request with the text of a hosted payment page." },
  { file: "C11", why: "the table: the row of a hosted payment page, right after check 6's row", old: "(a new row after check 6's row)", text: "| A known provider's hosted payment page as the origin, or in a tab of the scope with no tab of the origin (check 6), or as the act page | `stopped` | `This checkout's payment page is on a payment provider's own site, and the agent browser cannot tie it to <origin>. The operator buys it by hand.` |" },
  { file: "C11", why: "the act: after the approval the act page is still the page of the preparation on the request's origin (review-232 N1)", old: "(new words after the stop of card fields found again, in the act's item)", text: "The act page must still be the page of the preparation, on the request's origin: when the act tab's main frame loaded a new document after the preparation's last read of the card fields, or its origin is not the request's origin, at the order's read again or when the act finds the card fields again, the act stops before its first key with the text of a hosted payment page for a known provider's hosted payment page, and with the text of no payment step otherwise." },
  { file: "C11", why: "the limits: a hosted payment page stops (review-232 N3, as the design's section 14)", old: "(a new item of the limits, after the first)", text: "A checkout that pays on a provider's hosted payment page stops, and the operator buys by hand: the service cannot tie such a page to the merchant yet (board ab-sta.14). A binding to the merchant comes later, after board ab-sta.15 shows whether the first ticket sites use hosted pages." },
];
// Board ab-4wh.2 (the blanket profile): the service pins the receiver 0.3.16 (chrome-extension 4a4eb50, PR #55; the
// sender stays 0.2.1). The texts that the pin move changes, old then new, each exactly; the old text is gone. The new
// words say what 0.3.16 changes, from chrome-extension's C4 (the hello's feature blanket, a local scope's "*" in a
// blanket-shaped set_scopes, the public host class with localdomain and exclude) and C5 (the public rules and rule 91)
// at 4a4eb50, and that the service sends "*" only on the blanket Chrome's link (board ab-4wh.3). The C11 entries are
// the last list of nowText; the test is at the end of the pin tests.
const PIN_0316: { file: "C11" | "C12"; why: string; old: string; text: string }[] = [
  { file: "C11", why: "the release item names the service's pin",
    old: "The service pins that release or a later one, the receiver 0.3.15 (board ab-v16.97.10, ab-v16.102, ab-v16.94.7.7, ab-v16.100, ab-v16.112, ab-v16.115, ab-sta.4; C12, the agent package)",
    text: "The service pins that release or a later one, the receiver 0.3.16 (board ab-v16.97.10, ab-v16.102, ab-v16.94.7.7, ab-v16.100, ab-v16.112, ab-v16.115, ab-sta.4, ab-4wh.2; C12, the agent package)" },
  { file: "C12", why: "the sender of the pinned commit",
    old: "`sender` gives the sender of the chrome-extension commit that agent-browser pins (`9962e11`, C1).",
    text: "`sender` gives the sender of the chrome-extension commit that agent-browser pins (`4a4eb50`, C1)." },
  { file: "C11", why: "what the receiver 0.3.16 changes (C4, C5), and no service sends \"*\" yet", old: "(new words in the release item, after what 0.3.15 changes)",
    text: "The receiver 0.3.16 (board ab-4wh.2; chrome-extension's C4 and C5) adds the hello's feature `blanket` and a local scope's value `\"*\"` (C4, the blanket profile). The receiver applies `\"*\"` only for a local scope of a blanket-shaped `set_scopes`: `lists` an empty object, `default` `null`, `operator` `null` or absent, exactly one scope, and a good `exclude` or none. Such a scope may open any `http(s)` host of the public host class: a name of two labels or more of `[a-z0-9_-]` whose last label holds a letter or `_`, that is no IP literal, and that is not `localhost`, `local`, `internal`, `home.arpa` or `localdomain`, not a name of `exclude` (the box's own names, at most 8), and not a name under one of them. Any other `\"*\"` (a remote scope's, one in an object of another shape, or one next to a bad `exclude`) counts 1 in `refused` and applies as `null` (fail closed). C5's public rules give the scope's tabs two allow rules of the class (main frames; frames and `<object>`/`<embed>` documents) and the block rule 91, which blocks each request of those tabs to `localhost`, `local`, `internal`, `home.arpa`, `localdomain` or a name of `exclude`, or a name under one of them, also with a trailing dot. C4 states the limit: the class judges a host's name, not its address, so a public name that resolves to a private address passes (on Linux the service's address proxy closes it for the blanket Chrome: the blanket profile, below). The service sends `\"*\"` only on the blanket Chrome's link (board ab-4wh.3); until that build no service sends it." },
];
/** A text as CARD_HOSTED changed it (board ab-sta.14). */
const hostedNow = (s: string) => { let t = flat(s); for (const f of CARD_HOSTED) { if (f.old.startsWith("(")) continue; const o = flat(f.old); if (t.includes(o)) t = t.replace(o, flat(f.text)); } return t; };
/** A text of an earlier list as the later lists changed it, in their order (the first focused change, review-125b, ab-u92, the pin of 0.3.8, the pin of 0.3.11, the pin of 0.3.13, the pin of the sender 0.2.1, the pin of 0.3.14, the pin of 0.3.15, the card text of ab-sta.6, the payment act of ab-sta.7, the live check's rules of ab-sta.8, the hosted payment page of ab-sta.14, the pin of 0.3.16). */
const nowText = (s: string) => {
  let t = flat(s);
  for (const list of [MERGE_GUARD_FC, MERGE_GUARD_FC2, MERGE_GUARD_FC3, MERGE_GUARD_PIN, PIN_0311, PIN_0313, PIN_SENDER_021, PIN_0314, PIN_0315, CARD_COPY, CARD_ACT, CARD_LIVE, CARD_HOSTED, PIN_0316]) for (const f of list) { const o = flat(f.old); if (!o.startsWith("(") && t.includes(o)) t = t.replace(o, flat(f.text)); }
  return t;
};
/** A text as CARD_LIVE changed it (board ab-sta.8), then CARD_HOSTED (board ab-sta.14). */
const liveNow = (s: string) => { let t = flat(s); for (const f of CARD_LIVE) { if (f.old.startsWith("(")) continue; const o = flat(f.old); while (t.includes(o)) t = t.replace(o, flat(f.text)); } return hostedNow(t); };
/** An earlier text that a later list replaced: C11 says it as the later lists changed it. */
const replacedByFc = (s: string) => flat(s) !== nowText(s) && says(C11, nowText(s));
test("the lead's focused change: C11 says each changed sentence exactly, and no replaced text", async () => {
  const { GUARD_TEXT } = await import("../src/relay/merge-guard.ts");
  assert.equal(MERGE_GUARD_FC.length, 8);
  for (const e of MERGE_GUARD_FC) {
    assert.ok(says(C11, e.text) || replacedByFc(e.text), `${e.why}: ${e.text.slice(0, 120)}`);
    if (!e.old.startsWith("(a new") && !e.old.startsWith("(new words")) assert.ok(!says(C11, e.old), `${e.why}: the old text is gone`);
  }
  const p = flat(partOr(MERGE_GUARD_HEADING));
  assert.ok(p.includes(`gets \`${GUARD_TEXT.serviceWorker}\`; with \`bypass\` true it gets an answer with no change.`), "the part names the code's text");
  const refusals = flat(partOr("Refusals."));
  const at = refusals.indexOf("| A page's service worker on"), changes = refusals.indexOf("| A request to GitHub that a client changes"), chrome = refusals.indexOf("| `chrome://` pages");
  assert.ok(changes > 0 && changes < at && at < chrome, "the row comes after the merge guard's rows, before the row of chrome:// pages");
  assert.ok(!/worker-src/.test(p), "no premise of GitHub's worker-src");
});

test("the pin of receiver 0.3.8 (board ab-v16.97.10): C11 says each changed sentence of the release item exactly, and no replaced text; the version is the service's pin", async () => {
  const { AGENT_VERSION } = await import("../src/service/package/pins.ts");
  assert.equal(MERGE_GUARD_PIN.length, 2);
  for (const e of MERGE_GUARD_PIN) {
    assert.ok(says(C11, e.text), `${e.why}: ${e.text.slice(0, 120)}`);
    if (!e.old.startsWith("(new words")) assert.ok(!says(C11, e.old), `${e.why}: the old text is gone`);
  }
  const p = flat(partOr(MERGE_GUARD_HEADING));
  assert.ok(p.includes(`The service pins that release or a later one, the receiver ${AGENT_VERSION} (board ab-v16.97.10, ab-v16.102, ab-v16.94.7.7, ab-v16.100, ab-v16.112, ab-v16.115, ab-sta.4, ab-4wh.2;`), "the release item names the code's pin");
  assert.ok(!p.includes("stays refused on both paths"), "the service's path has the floor");
  // review-127 B1: the old path needs both of agentwatch's pins; a receiver with the floor under a relay with no guard fails closed.
  assert.ok(p.includes("only when agentwatch moves both of its pins at once") && p.includes("at or after this guard's merge commit (`d37e49f`), and its receiver pin to a release at or after 0.3.8"), "both pins");
  assert.ok(p.includes("names no guarded tab, so its floor blocks each write to GitHub's hosts from every client tab and from each request with no tab (fail closed)"), "the receiver's floor under a relay with no guard");
  assert.ok(!p.includes("once agentwatch's own pin of the receiver names that release"), "no old path with the receiver's pin alone");
});

// The sentences of C11's other parts that the merge guard changes: old, then new.
const MERGE_GUARD_CHANGED: { part: string; old: string; text: string }[] = [
  { part: "Where each call goes.", old: "Every other call on a page session goes to Chrome (`debugger.sendCommand`), after the refusals below.", text: "Every other call on a page session goes to Chrome (`debugger.sendCommand`), after the refusals below; the merge guard (below) changes a client's `Fetch` calls on the way." },
  { part: "Refusals.", old: "(a new row before the row of `chrome://` pages)", text: "| A page's Content Security Policy off while the receiver gives no floor (the merge guard, below) | `Page.setBypassCSP` with `enabled` true, while the model has no floor that the receiver confirmed on the current link | `Not available in the agent browser: <method>.` |" },
  { part: "Refusals.", old: "(a new row before the row of `chrome://` pages)", text: "| A request that the model holds (the merge guard, below) | A `Fetch.*` call whose `requestId` names a request of a guarded host that the model has not judged or read yet | `Invalid InterceptionId.` |" },
  { part: "Refusals.", old: "(a new row before the row of `chrome://` pages)", text: "| A request to GitHub that a client changes (the merge guard, below) | `Fetch.continueRequest` with a `url` on a guarded host, or with a `url`, `method`, `postData` or `headers` for a request of a guarded host | `Not available in the agent browser: a request to <host> that a client changes (Fetch.continueRequest). The agent browser judges each request to GitHub itself (the merge guard of pull requests from agentwatch issue triage).` |" },
];
test("the merge guard's changed sentences in C11's other parts: each new text exactly, and no old text", () => {
  assert.equal(MERGE_GUARD_CHANGED.length, 4);
  for (const e of MERGE_GUARD_CHANGED) {
    assert.ok(says(partOr(e.part), e.text) || replacedByFc(e.text), `${e.part}: ${e.text.slice(0, 120)}`);
    if (!e.old.startsWith("(a new ")) assert.ok(!says(C11, e.old), `the old text is gone: ${e.old}`);
  }
  const rows = flat(partOr("Refusals.")).indexOf("| A page's Content Security Policy off"), chrome = flat(partOr("Refusals.")).indexOf("| `chrome://` pages");
  assert.ok(rows > 0 && rows < chrome, "the three rows come before the row of chrome:// pages");
});

// review-125 (board ab-v16.99): the fix round's changed sentences of C11, old then new, each exactly; the old text is gone.
const MERGE_GUARD_R1: { why: string; old: string; text: string }[] = [
  { why: "note A: the policy row", old: "| A page's Content Security Policy off (the merge guard, below) | `Page.setBypassCSP` with `enabled` true | `Not available in the agent browser: <method>.` |",
    text: "| A page's Content Security Policy off while the receiver gives no floor (the merge guard, below) | `Page.setBypassCSP` with `enabled` true, while the model has no floor that the receiver confirmed on the current link | `Not available in the agent browser: <method>.` |" },
  { why: "note A: the merge guard's item of the page's policy", old: "The page's policy. `Page.setBypassCSP` with `enabled` true gets `Not available in the agent browser: Page.setBypassCSP.` So a page's Content Security Policy stays in force: on GitHub only GitHub's own scripts run in a worker (its `worker-src`).",
    text: "The page's policy. While the model has no floor that the receiver confirmed on the current link (no answer yet to `bridge.mergeGuard`, an `unknown op` answer, an error, or a link change before the answer), `Page.setBypassCSP` with `enabled` true gets `Not available in the agent browser: Page.setBypassCSP.` So a page's Content Security Policy stays in force: on GitHub only GitHub's own scripts run in a worker (its `worker-src`). With a confirmed floor it goes to Chrome as before: a write of a shared worker or a service worker has no tab, and the floor blocks it. A dedicated worker's request goes through the tab's own session, also with no auto-attach of the client (measured: the live check of board ab-v16.99), so the model judges it." },
  { why: "note B: the release of the old relay path (the daemon lead's fact: the carrier forwards every op that is not daemon.*)", old: "the relay of the old path has it only when agentwatch's carrier passes the op on.",
    text: "The relay of the old path has the floor once that receiver release is pinned: agentwatch's carrier passes the op on unchanged, with no agentwatch change. Until then `Page.setBypassCSP` with `enabled` true stays refused on both paths." },
  { why: "note A: what it cannot stop, a frame of another site with the page's policy bypassed", old: "(new words in the item of what it cannot stop)",
    text: "with a confirmed floor and the page's policy bypassed, a write of a frame of another site in a page of a guarded host that the client's auto-attach does not bring (the browser sends it as a cross-site request);" },
];
test("review-125: C11 says each changed sentence of the fix round exactly, and no replaced text", () => {
  assert.equal(MERGE_GUARD_R1.length, 4);
  for (const e of MERGE_GUARD_R1) {
    assert.ok(says(C11, e.text) || replacedByFc(e.text), `${e.why}: ${e.text.slice(0, 120)}`);
    if (!e.old.startsWith("(new words")) assert.ok(!says(C11, e.old), `${e.why}: the old text is gone`);
  }
});

// Board ab-t30.17: the open points of the input stage's pointer part (PR #116). The C11 sentences are in STAGE_ITEMS
// (above); the input design's texts, each new text exactly and each replaced text gone.
const T30_17_DESIGN: { why: string; old: string; text: string }[] = [
  { why: "N9: a move run (4.4)", old: "A pointer action is a path, its press and its release. A key run is",
    text: "A pointer action is a path, its press and its release. A move with no button down keeps its action for the tab's next call (a move run), so no other tab's action comes between two steps of `mouse.move` with `steps` (board ab-t30.17, N9); the run ends at the tab's next call that the stage does not take, 1 s after the move, or at `STAGE_ACTION_MAX_MS`. A key run is" },
  { why: "point 1 and note D (4.3a)", old: "(a new bullet)",
    text: "**A navigation's close and a second dialog** (board ab-t30.17; C11, dialogs, holds the rules). Chrome closes an open dialog at the start of a navigation of the main frame, before its `Page.frameNavigated` (measured on Chromium 156). So the close of a dialog that is not a `beforeunload` dialog while such a navigation is under way, and the accepted close of a `beforeunload` dialog (a dismissed one keeps the page: review-136 note 3), end the wait as a navigation does: no held move, press or key press goes, and each held call gets the error that the context is gone. An ended press or key press can open a second dialog, and Chrome answers it only after that dialog's close: the end's releases wait for that answer, so Chrome does not drop them." },
  // Review-136 note 3 (before: So a close while such a navigation is under way, and the accepted close of a `beforeunload` dialog, end the wait as a navigation does).
  { why: "review-136 note 3 (4.3a)", old: "So a close while such a navigation is under way, and the accepted close of a `beforeunload` dialog, end the wait",
    text: "So the close of a dialog that is not a `beforeunload` dialog while such a navigation is under way, and the accepted close of a `beforeunload` dialog (a dismissed one keeps the page: review-136 note 3), end the wait as a navigation does" },
  // Review-135 N6, the table of section 5.1 (before: 50 MB or more in all: refused, as Playwright refuses).
  { why: "review-135 N6 (5.1)", old: "50 MB or more in all: refused, as Playwright refuses", text: "50 MiB or more in all: refused, as Playwright refuses" },
  { why: "point 2 (4.3a)", old: "(a new bullet)",
    text: "**The client's `Page.disable`** (board ab-t30.17). It ends no dialog: Chrome's dialog manager keeps the dialog open, and a read of the page waits for its close (measured on Chromium 156). So the model sends it before the tab's gate, and the stage's wait ends at the answer of its own read of the page (after the close), or at `STAGE_ACTION_MAX_MS`." },
];
test("board ab-t30.17: the input design says each text of the pointer part's open points exactly, and no replaced text", () => {
  for (const e of T30_17_DESIGN) {
    assert.ok(says(DESIGN, e.text), `the design, ${e.why}: ${e.text.slice(0, 120)}`);
    if (!e.old.startsWith("(a new")) assert.ok(!says(DESIGN, e.old), `the design, ${e.why}: the old text is gone`);
  }
});

test("board ab-v16.94.6: C11's Mac reader is the code's: the struct sizes that it reads; the Mac check measured it, so the port's gate is open (board ab-v16.94.32)", async () => {
  const mac = await import("../src/service/mac.ts");
  const proc = await import("../src/service/mcp/proc.ts");
  assert.deepEqual([mac.PROC_PIDLISTFDS, mac.PROC_PIDFDSOCKETINFO, mac.SOCKET_FDINFO_SIZE, mac.PROC_BSDINFO_SIZE], [1, 3, 792, 136]);
  assert.equal(proc.MAC_TCP_READER_MEASURED, true, "C11: the Mac check measured the reader, so the Mac's port admits by the same steps as Linux");
  assert.ok(says(C11, "the Mac check measured the Mac's TCP peer reader (board ab-v16.94.32)"));
  assert.ok(!says(C11, "until the Mac check measures the Mac's TCP peer reader"), "the gate's old sentence is gone");
  assert.ok(!says(C11, "until the Mac's TCP peer reader (`libproc`) is built and measured (stage 4)"), "the old sentence is gone");
});

// Board ab-t30.27 (in place of board ab-v16.94.17, F2): C11's MCP inside the service on a folder upload, old, then new.
// The PR's body lists both for the daemon lead.
const T30_27_FOLDER: { file: string; why: string; old: string; text: string }[] = [
  {"file": "C11", "why": "a folder of the scope's folder in browser_file_upload's paths goes to the MCP as sent: the receiver now has access to local files (C12), so Chrome takes the folder's path; the refusal of board ab-v16.94.17 F2 goes; review-153 N5: the page gets the files on a folder input only, and Playwright's own errors otherwise", "old": "- A folder in `browser_file_upload`'s `paths` reaches no page (board ab-v16.94.17, F2). Chrome answers `DOM.setFileInputFiles` with `Not allowed` for a client that has no access to local files (its DevTools DOM handler: the only `Not allowed` of that method), and the receiver that the service installs on Linux (the packed CRX, an external extension) has none. The MCP's Playwright connects with no `isLocal`, so it sends the content of each file (a set files call), but a folder always as its path. So when a path of a call that passes the rule above names a folder (`stat` when the call comes, after its links; a relative path is read from the scope's folder), the service sends the call to the MCP with no `paths`, as the MCP's cancel of its open file chooser, and the client gets HTTP 200 with `-32602` and `Not available in the agent browser: paths names a folder (the agent browser gives a file input files only). The service closed the file chooser: open a chooser again and pass the paths of files`, whatever the MCP answers. So the client's next tool call needs no cancel of the chooser. A path that becomes a folder after that `stat` reaches Chrome, which refuses it: the MCP's chooser then stays open until the client cancels it (`browser_file_upload` with no `paths`).", "text": "- A folder in `browser_file_upload`'s `paths` that passes the rule above goes to the MCP as the client sent it: the MCP's Playwright sends a folder as its path (`DOM.setFileInputFiles`), and Chrome takes that path because the service's receiver has access to local files (C12, the agent package; board ab-t30.27, in place of the refusal of board ab-v16.94.17, F2), so a folder input (`webkitdirectory`) gets the folder's files, while a plain file input, a folder with a file and two folders get Playwright's own errors."},
];
test("board ab-t30.27: C11 says the folder upload's new rule exactly, after the path rule and before the scope's folder; the refusal's bullet is gone", () => {
  assert.equal(T30_27_FOLDER.length, 1);
  for (const e of T30_27_FOLDER) {
    assert.ok(says(C11, e.text), `${e.file}, ${e.why}: ${e.text.slice(0, 160)}`);
    assert.ok(!says(C11, e.old), `${e.file}, ${e.why}: the old bullet is gone`);
  }
  const f = flat(C11);
  const at = f.indexOf(flat(T30_27_FOLDER[0].text));
  assert.ok(at > f.indexOf("(a call with no path argument passes)."), "after the path rule");
  assert.ok(at < f.indexOf("- The scope's folder lives as long as the scope's agentwatch session"), "before the scope's folder");
  assert.ok(!says(C11, "paths names a folder") && !says(C11, "has none. The MCP's Playwright connects with no `isLocal`"), "no text of the refusal");
});

test("board ab-t30.27: C11's files part says when Chrome takes the receiver's DOM.setFileInputFiles, after the probe's measures and before the buffers", () => {
  const f = flat(C11);
  const at = T30_27_C11.map((t) => f.indexOf(flat(t)));
  assert.ok(at.every((i) => i > 0), "C11 says each sentence");
  assert.ok(at.every((i, n) => n === 0 || i > at[n - 1]), "in this order");
  assert.ok(at[0] > f.indexOf("no `cancel` event comes when the interception goes off."), "after the probe of board ab-t30.12.2");
  assert.ok(at[at.length - 1] < f.indexOf("- Buffers. The stage writes the call's files"), "before the buffers");
});

test("board ab-t30.27 (review-153 B1): C11 names FILES_STATE, and the service gives the model its state folder", async () => {
  const st = await import("../src/relay/stage.ts") as any;
  assert.match(st.FILES_STATE, /state folder/);
  assert.ok(says(C11, "(`FILES_STATE`; board ab-t30.27)"));
  const svc = readOr("src/service/service.ts");
  assert.ok(svc.includes("if (o.unit) opened.relay.model.setStateFolder(new StateFolder(o.unit.paths.state));"), "the service sets the state folder");
});

// ---- PageFetch (board ab-v16.102; the PageFetch design, docs/superpowers/specs/2026-11-15-page-fetch-design.md) ----
// Stage 2, the service's part: C11's part "PageFetch" is the contract that src/service/fetch/ follows. The tests assert
// each sentence of the part exactly, and that the part holds no other text; that its texts and numbers are the code's;
// and each changed sentence of C11, C12 and the allow list's format (old, then new; the PR's body lists them for the
// daemon lead).

const PAGE_FETCH_HEADING = "PageFetch (board ab-v16.102; the PageFetch design).";
// Every sentence of the part, in order (a list item and a table row are one item). The part holds exactly these.
const PAGE_FETCH_ITEMS: string[] = [
  "**PageFetch (board ab-v16.102; the PageFetch design).** The design is `docs/superpowers/specs/2026-11-15-page-fetch-design.md`, approved by the operator (board answer ab-1wu, 2026-11-15), with the operator's answers O1 and O2 (its section 9). Board ab-v16.102 builds its stage 2, the service's part, and it serves sessions from stage 3. The receiver's part is chrome-extension's: the fetch window of C10's `windows.create` with the mark `fetch`, the hello's feature `fetch` and the request `fetch_end` of C4, and the fetch tab's rules of C5. Board ab-v16.103 adds PDFs (the design's stage 3; PDFs, below), and board ab-v16.104 the navigation tools for every agent (stage 5: the MCP path's step 8, above); agentwatch's MCP entry for every session (stage 4) and the Mac (stage 6) come later. The relay has no PageFetch.",
  "What PageFetch does. An agent gives one URL. The service loads the page in a clean private window of the agent Chrome that no client sees, waits until the page has rendered, converts the live DOM to markdown (for a PDF, pdf.js reads the text of its pages: PDFs, below), ends the window, and answers the markdown. PageFetch never clicks, types or sends a form, so it needs no allowlist; the address rule (below) keeps it from the box itself and from private networks.",
  "The entry. The MCP's own tool `PageFetch` of the allow list's `service_tools` (`docs/contracts/mcp-allow-list.md`), with `url` (required: an absolute `http:` or `https:` URL), `mode` (`main`, the default, or `whole`) and `offset` (a whole number of 0 or more, 0 by default). The MCP path's transport answers it itself, and a call never reaches the MCP's code. The service has PageFetch on Linux with the native link and the Chrome unit, also with no stored sign-ins; PageFetch does not need the stored sign-ins part.",
  "A local admission (the sign-in act's entry, below). A call is a tool call of its MCP session: it passes the browser gate first (the start at a use: a call that finds Chrome stopped starts it, and the start's own wait comes first), and it counts as a use until PageFetch's method ends, also after its client has gone. A cancel at the gate ends the call, and no fetch starts; no cancel stops a running fetch.",
  "A remote admission. A call that a remote token admitted gets the tool error `Not fetched (unavailable): PageFetch works only for sessions of this box.` at once, whatever its arguments. It passes no browser gate, it is no use, and it opens no window. The MCP path also logs `mcp: MCP session <n> (scope <scope>): a tools/call of PageFetch refused (a remote admission)`.",
  "While the service has no PageFetch (the Mac until stage 6, and a service with no native link or no Chrome unit), a `tools/list` holds no `PageFetch`, and a call gets the allow list's `-32601` answer.",
  "The answer. A tool result with one text item: the header's lines, an empty line, then the markdown. The header's lines, in this order: `URL: <the final URL>`; `Title: <the page's title>`; `Status: <the HTTP status of the main document>` (or `none`); `Kind: html`, or `Kind: pdf` for a PDF; `Mode: main`, `Mode: whole`, or `Mode: whole (main gave fewer than 200 characters)`; `Length: <n> characters`, with ` (the service keeps at most 5000000 characters of a page)` after it for a page that the service cut; for an answer that holds a part, `Part: characters <offset> to <end>; the next part starts at offset <end>` or `Part: characters <offset> to <end>; the last part`; and, for a page that looks like a bot check page, `Note: the page looks like a bot check page; its content is the check, not the page.` A page whose consent layer the conversion's safety rule kept (below) gets one more line at the end of the header: `Note: the page shows a consent layer; its content may need a consent, which PageFetch never gives.`; a page that gets both notes has the bot check page's note first. An HTTP status of 400 or more is no error: the page's text comes with its status, because an error page can say why. A page looks like a bot check page (board ab-v16.107) when its status is 401, 403, 429 or 503 and its title (the check read's, the whole title in any case, its spaces collapsed) is one of the check page titles: `Just a moment...`, `Attention Required! | Cloudflare`, `Please Wait... | Cloudflare` and `Verifying you are human` (Cloudflare), `Security Verification` (a check page that answered 401 on the real-page check of 2026-11-15), `Access Denied` (Akamai), `Access to this page has been denied` with or without its full stop (HUMAN), `Pardon Our Interruption` (Imperva), `DDoS-Guard`, `Vercel Security Checkpoint`, `Making sure you're not a bot!` (Anubis) and `Sucuri WebSite Firewall - Access Denied` (Sucuri); the list is `CHECK_PAGE_TITLES` in `src/service/fetch/fetch-page.ts`, with each title's source. DataDome and AWS WAF have no fixed title: the check read finds their checks by their frames and elements. Such an answer stays `ok`: PageFetch never clicks, never waits for such a check to pass and never tries again.",
  "The errors. A refusal is a tool error (`isError: true`) with one text, `Not fetched (<code>): <sentence>` (the texts, below). Another exception of PageFetch gets the MCP path's fixed 500 (`The agent browser could not answer this request.`).",
  "The order of a call. The first step that fails gives its text.",
  "The arguments (`refused`).",
  "A read on: a call with an `offset` past 0 reads the scope's memory of the same `url` and `mode` (below), with no fetch, no rate and no window. With no such result in the memory the call goes on as a new fetch.",
  "The address rule of the URL (`refused`), before the rate and any window: a refused URL costs no fetch.",
  "The scope's rate: at most 30 fetches in any 10 minutes for one scope (`busy`, with the time to wait).",
  "The receiver's hello holds `fetch` (a test for membership in C4's list), and the agent browser is ready (`unavailable`).",
  "The window's turn (the one private window, below): `busy` when 8 fetches wait, or after a wait of 10 minutes.",
  "Step 5 again, then the fetch, at most 60 s from the turn (`timeout`), then the end.",
  "The fetch window. The receiver opens it with C10's `windows.create` `[{\"url\":\"about:blank\",\"focused\":false,\"incognito\":true,\"width\":1280,\"height\":900}, <scope>, \"fetch\"]`, the caller's scope. The window has a desktop width, 1280 by 900 pixels (board ab-v16.110): the removal of hidden elements (the conversion, below) reads the rendered page's computed style at this width, so a responsive page's desktop content counts as shown. A screen narrower than that can make the window narrower. The bridge's error `another private window is open` gives `busy`, and another failure gives `unavailable`, with the log line `page-fetch: the fetch window did not open (windows.create failed: <error>)` (board ab-v16.94.31), where `<error>` is the bridge's error with each URL as `<a URL>`, at most 160 characters. An answer with no window id, no tab or a window that is not incognito gives `unavailable` too, with the log line `page-fetch: the fetch window did not open (windows.create gave <what>)`, where `<what>` is `no window`, `no tab` or `a window that is not incognito`. The model hides the window's tab and each popup of it, as an act tab: no client sees it, attaches to it or gets its events. The service's own session on the tab, before the navigation: `Page.enable`, `Network.enable`, `Network.setBypassServiceWorker` `{\"bypass\":true}`, `Page.setDownloadBehavior` `{\"behavior\":\"deny\"}`, `Fetch.enable` for every URL at the request stage and for every document at the response stage (`{\"patterns\":[{\"urlPattern\":\"*\",\"requestStage\":\"Request\"},{\"urlPattern\":\"*\",\"resourceType\":\"Document\",\"requestStage\":\"Response\"}]}`), `Target.setAutoAttach` `{\"autoAttach\":true,\"waitForDebuggerOnStart\":true,\"flatten\":true}` and `Page.getFrameTree`; a failure of one of them, other than `Page.setDownloadBehavior`, gives `unavailable` (the receiver still cancels a download, below). On Linux the window then moves outside the screen at the X level by a title marker, as the act window; a window that is not outside within 3 s gives `unavailable`. Then `Page.navigate` with the URL.",
  "The end. After each fetch that opened a window, also after an error, the service sends C4's `fetch_end` `{}`, once more after 500 ms when it fails, at most 20 s in all; it never closes the window itself. Chrome then drops the incognito context with its cookies, storage and cache. The receiver ends a fetch window that a crash or a failed `fetch_end` left before the next private window opens. A `fetch_end` that fails gets the log line `page-fetch: fetch_end failed twice (<why>); the next private window or the receiver's start ends the fetch window`, or `failed at the end's limit` in place of `failed twice`, and the window's next holder sends `fetch_end` once more (the one private window, below), with the log line `page-fetch: the left fetch window ended before the next private window` or `page-fetch: the left fetch window did not end before the next private window (<why>)`.",
  "The one private window. All incognito windows of a Chrome share one cookie jar, so one lock in the service holds the sign-in act and PageFetch: neither starts while the other runs. A waiting act gets the window before every waiting fetch. At most 8 fetches wait, and one more gets `busy`; a fetch waits at most 10 minutes. Both refuse while the operator has a private window open in the agent Chrome (the receiver's check).",
  "The daemon lead's rule: a sign-in act, whoever starts it, waits for a running fetch and never fails because of it. So the act's wait (check 7, below) also covers one fetch to its longest hold, 80 s (its 60 s, then its end's 20 s). The lock ends a fetch's hold at 80 s, also when the fetch's own code has not ended. When a fetch's `fetch_end` failed, the window's next holder (an act or a fetch) sends `fetch_end` once more, at most 10 s, before its own window, so a fetch window that did not end does not refuse the act's window; only a receiver that cannot end it then refuses it.",
  "The address rule. PageFetch never reaches the box itself or a private network.",
  // Board ab-4wh.6, the review's M1 and M2 (before: "... each of these in an IPv4-mapped, IPv4-compatible or NAT64 form (`::ffff:a.b.c.d`,
  // `::a.b.c.d`, `::ffff:0:a.b.c.d`, `64:ff9b::a.b.c.d`), and each name that is ...").
  "The URL: only `http:` and `https:`. The host is the WHATWG URL parser's, the parser of Chrome, so each IPv4 form that Chrome takes (`0x7f.1`, `2130706433`) reaches the check as its dotted form. Refused: loopback (`127.0.0.0/8`, `::1`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16` with `169.254.169.254`, `fe80::/10`), carrier-grade NAT (`100.64.0.0/10`), unique local (`fc00::/7`), site-local (`fec0::/10`), multicast (`224.0.0.0/4`, `ff00::/8`), reserved (`240.0.0.0/4`), unspecified (`0.0.0.0/8`, `::`), each of these in an IPv4-mapped, IPv4-compatible, NAT64 or 6to4 form (`::ffff:a.b.c.d`, `::a.b.c.d`, `::ffff:0:a.b.c.d`, `64:ff9b::a.b.c.d`, and `2002::/16` with the IPv4 address in its bits 16 to 47), Teredo (`2001::/32`) and local-use NAT64 (`64:ff9b:1::/48`) as a whole, an IPv4 address with a zone (`%`; board ab-4wh.6), and each name that is `localhost`, `local` or `internal` or ends in `.localhost`, `.local` or `.internal`.",
  "An IP literal is checked by its range. A name is checked by every address that the box's resolver gives for it (`getaddrinfo`): one refused address refuses it, and a name with no address is refused. The service checks the URL before it opens the window.",
  "Every request of the fetch tab, its frames and its workers: the guard. Each request pauses (`Fetch.requestPaused`), and the service continues it only when its URL passes the same rule: `http`, `https`, `ws` and `wss` by their host; `data`, `blob` and `about` pass; every other scheme fails. The service checks each host once in a fetch, and at most 64 different hosts (a scheme and a host) in one fetch, because the box's resolver runs on a small shared pool: a request to another host fails (`BlockedByClient`, with no lookup), and the fetch goes on; a request of the main document to another host also ends the fetch (`blocked`; board ab-v16.105), so that no answer holds Chrome's error page of that navigation. A request that fails the rule fails with `BlockedByClient`. A request of the main document (the navigation, a redirect, the page's own navigation) that fails it refuses the fetch (`refused`). A paused request that is too large for the link fails.",
  "A frame or a worker that Chrome attaches to the tab's session waits before it runs (`waitForDebuggerOnStart`) until its own session has `Fetch.enable` for every URL and its own `Target.setAutoAttach`; then the service sends its `Network.enable`, and it runs (`Runtime.runIfWaitingForDebugger`). One for which `Fetch.enable` or `Target.setAutoAttach` fails never runs: when Chrome reports its end (`Target.detachedFromTarget`) within 500 ms (a frame that ended or that the receiver blocked before it loaded, a worker that stopped), the fetch goes on with the log line `page-fetch: a <kind> of the fetch ended before its guard (<command>)`; else the fetch ends (`unavailable`) with the log line `page-fetch: a <kind> of the fetch got no guard (<command> failed: <why>)`. The page is not ready while the service waits for that end. A dedicated worker (`worker`) whose session has no Fetch domain (Chrome's `-32601` for `Fetch.enable`) loads through its frame's network stack, where the frame's own guard holds each of its requests: it runs, with the log line `page-fetch: a worker of the fetch has no Fetch domain; its frame's guard holds its requests`; a frame with no Fetch domain ends the fetch. A failure of `Network.enable` alone (the reads of the child's WebSockets, defence in depth: the receiver's rule blocks each WebSocket and WebTransport of a fetch tab, C5) gets the log line `page-fetch: a <kind> of the fetch runs with no WebSocket reads (Network.enable failed: <why>)`, and the child runs with its guard. `<kind>` is `frame` or Chrome's type of the target (`worker`); `<why>` is the error's text with no URL, at most 160 characters.",
  "A WebSocket or a WebTransport is no request of the guard. The receiver's rule blocks each one in a fetch tab (C5): the connection fails, and the page goes on. The service reads each one that Chrome reports in the session of the tab, of a frame or of a worker, and counts it in its log line. One whose host fails the address rule (an IP literal by its range, a name by the resolver, within the fetch's 64 hosts) ends the fetch (`refused`).",
  "The main frame's navigations: the first and at most 10 more (redirects and the page's own navigations); one more fails and gives `blocked`.",
  "Stated limits. A service worker or a shared worker of the page is not always a child of the tab, so its requests can pass outside the guard; for them the guards are Chrome's Local Network Access check, which stays on, and the receiver's rule for refused IP literals of the fetch window (C5), and the window's end drops each such worker with the incognito context. Chrome resolves a name again when it sends the request, so a name whose address changes between the two lookups (DNS rebinding) can pass the service's check; Local Network Access stops such a request to loopback and to private ranges. No live run measured the following in the service's path (the reviews of board ab-v16.102; board ab-v16.105): a popup that opens and its workers, the uploads of the Reporting API and of Network Error Logging, the prefetch and the prerender of speculation rules, `<link rel=preconnect>`, and a page with a service worker; some of them can reach the network outside the guard. `agent-browser page-fetch` differs (boards ab-v16.113 and ab-v16.114): it turns the Reporting API and Network Error Logging off (board ab-v16.114 measured their uploads outside the guard), and it holds each new target of its browser context before it runs.",
  "The load and the wait. The page is ready when the load event of its current document has come, no navigation of the main frame has started for 2 s (a request of the main document, a commit, a navigation in the document), and no network request of the tab has been open for 500 ms. A request that the tab's session reports ends when any session of the fetch (the tab's, a frame's or a worker's) reports its end with the same request id: Chrome reports the start of a dedicated worker's script in the tab's session and its end in the worker's session, both with the worker's target id (board ab-v16.106). The script of a worker whose `Network.enable` failed, or that Chrome detached, is never open. The ready wait is at most 30 s from the navigation. At ready, the check read (below) runs: a check that needs a click gives `blocked` at once; a check page waits for its own navigation, and a page that is still a check page at 30 s gives `blocked`; another page goes to the conversion. At 30 s a page whose load event has come goes to the conversion, also with a request that is still open; a page with no load event gives `timeout`. A navigation that Chrome fails (`Page.navigate`'s `errorText`, other than `net::ERR_ABORTED` and `net::ERR_BLOCKED_BY_CLIENT`) gives `timeout` with Chrome's error text. `net::ERR_BLOCKED_BY_CLIENT` gives `refused`: the receiver's rule blocked the page or a redirect before the guard saw it (a redirect of the main document to a refused IP literal), and Chrome gives no URL of it. A PDF ends the ready wait at once, before every other end of the fetch (PDFs, below).",
  "The check read. A read in a new isolated world: the title, the start of the text, the frames and the marks of the page; with the URLs of the tab's frames that CDP gives. The marks come from the challenge vendors' public documentation, never from a live probe. A check that needs a click: a visible frame of `hcaptcha.com`, of reCAPTCHA's `/recaptcha/api2/anchor` or `/recaptcha/enterprise/anchor` (not its invisible form, `size=invisible`), of `captcha-delivery.com` (DataDome), or of `arkoselabs.com` or `funcaptcha.com`; the elements `#px-captcha` (HUMAN), `.h-captcha`, or AWS WAF's captcha; the texts `Verify you are human by completing the action below` (Cloudflare), `Press & Hold` or `Press and hold the button` (HUMAN). A check page that can pass with no input: Cloudflare's challenge elements (`#challenge-running`, `#challenge-stage`, `#challenge-form`), Anubis's (`#anubis_challenge`, its script), or the title `Just a moment...`, `Making sure you're not a bot!`, `DDoS-Guard` or `Vercel Security Checkpoint`.",
  "No input. The service sends no `Input.*` event and no key. It grants no permission and answers no prompt: a permission prompt waits until the window's end drops it. It dismisses each dialog (`alert`, `confirm`, `prompt`, `beforeunload`) with `Page.handleJavaScriptDialog` `{\"accept\":false}`, also a dialog of a frame. Downloads are denied: the service sends `Page.setDownloadBehavior` `{\"behavior\":\"deny\"}`, and the receiver cancels each download of a fetch window (C10). The model gives the events of each incognito download to the act's listeners, which PageFetch's are while it runs, and never to a client; PageFetch counts each incognito download that starts while it runs in its log line, and it calls no `downloads.cancel`. A popup of the tab is hidden, the service's own session holds it and fails each request that the session holds, and it closes by `window.close()` from an isolated world; a request of the popup before that session holds it is not held (Chrome's popup blocker stops a popup with no person's click). A popup that the service cannot hold ends the fetch (`unavailable`, with the log line `page-fetch: a popup of the fetch got no guard (<step> failed: <why>)`), unless Chrome removes its tab within 500 ms (it closed): then the fetch goes on with the log line `page-fetch: a popup of the fetch closed before its hold ended (<step>)`.",
  "The conversion. Defuddle (the pinned `defuddle` 0.19.5: its own browser build `defuddle/full`, which carries its markdown step, read once from the installed package) runs in a new isolated world of the main frame (`Page.createIsolatedWorld` with `grantUniversalAccess` `false`), as one script that gives the build a `module` of its own, so it sets no global; the page's scripts cannot see it or change its result. Defuddle reads a copy of the document, and the live DOM stays as it is. Its options: in `main`, `{\"url\":\"<url>\",\"markdown\":true,\"useAsync\":false,\"removeHiddenElements\":true}` (no call to a third party); in `whole`, also `{\"contentSelector\":\"body\",\"removeLowScoring\":false,\"removeExactSelectors\":false,\"removePartialSelectors\":false,\"removeContentPatterns\":false}`, so the whole body stays with its menus and lists. Both modes remove hidden elements: the copy that Defuddle reads has no element that the rendered page hides (its computed `display` is `none` or its `visibility` is `hidden`, by a style sheet or by an inline style), so no retry of Defuddle brings one back: not its retries for little content (with no removal of hidden elements, and with its largest hidden block), not its schema.org retry, not its index page retry, and not the fallback from `main` to `whole` (board ab-v16.110: a museum's object page, whose consent layer has an id of its own that no root below matches, still gave 833,174 characters of the layer's closed partner list in `main` after board ab-v16.109). An element whose `visibility` is `hidden` and that holds an element that the page shows again stays without its own text, so the text of the shown element stays. An element of a shadow root has no such mark of its own: it goes with a host or another element around it that the page hides, and else only by Defuddle's own rules. The removal comes after Defuddle's flattening of shadow roots and before the drop of a consent layer (below). The cost: text that a person sees only after a click (a closed tab or accordion that a style hides) does not come in either mode. In both modes the copy also drops the layer of a consent manager (board ab-v16.107: a museum's object page gave 833,174 characters of a consent manager's partner list in `main`, which a person sees only after opening the consent layer): each element of the copy's body that is a root of a common consent manager goes with its content. The roots, from the markup of each vendor's public script (`CONSENT_ROOTS` in `src/service/fetch/fetch-page.ts`): OneTrust (`#onetrust-consent-sdk`, `#onetrust-banner-sdk`, `#onetrust-pc-sdk`, `.onetrust-pc-dark-filter`), Cookiebot (`#CybotCookiebotDialog`, `#CybotCookiebotDialogBodyUnderlay`, `#CookiebotWidget`), Didomi (`#didomi-host`), Usercentrics (`#usercentrics-root`, `#usercentrics-cmp-ui`), Sourcepoint (`#sp_message_container_<n>`), Quantcast Choice (`#qc-cmp2-container`, `.qc-cmp2-container`), TrustArc (`#consent_blackbar`, `#truste-consent-track`, `.truste_box_overlay`, `.truste_overlay`), Osano (`.osano-cm-window`, `.osano-cm-dialog`, `.osano-cm-info-dialog`), iubenda (`#iubenda-cs-banner`, `#iubenda-iframe`), CookieYes (`#cookie-law-info-bar`, `#cliSettingsPopup`, `.cky-consent-container`, `.cky-modal`, `.cky-overlay`), Complianz (`#cmplz-cookiebanner-container`, `.cmplz-cookiebanner`), consentmanager.net (`#cmpwrapper`, `#cmpbox`, `#cmpbox2`), Google Funding Choices (`.fc-consent-root`, `.fc-ccpa-root`), Borlabs Cookie (`#BorlabsCookieBox`, `#BorlabsCookieBoxWrap`, `#BorlabsCookieWidget`), Termly (`#termly-code-snippet-support`), Ketch (`#lanyard_root`), Axeptio (`#axeptio_overlay`, `.axeptio_mount`), Klaro (`#klaro`), Civic Cookie Control (`#ccc`) and Cookie Information (`#coiOverlay`, `#cookie-information-template-wrapper`). A root matches by its whole id or by one of its whole class names (Sourcepoint's id: `sp_message_container_` and a number), never by a part of a name, so a page's own `consent-article` stays. In the layer, each element whose `aria-hidden` is `true` or that has the `hidden` attribute goes too. The drop comes after Defuddle's flattening of shadow roots, which pairs the live elements with the copy's by their order and brings a layer in a shadow host into the copy. The safety rule: when the copy has fewer than 200 characters of text outside the roots (a page whose content is the consent layer), the roots stay, and only the hidden parts of the layer go: those, and each element of the layer that the rendered page hides, which the removal of hidden elements (above) takes before the drop (board ab-v16.109: else Defuddle's retries for little content take a partner list that a style sheet closes, and the museum's object page still gave 833,174 characters of it). The layer's visible text stays, and the header gets the note of a consent layer; the answer stays `ok`: PageFetch never clicks, never waits for a consent and never tries again. When `main` gives fewer than 200 characters (after trimming), PageFetch converts the whole page instead, and the header says so. A conversion that fails gives `unavailable`.",
  "PDFs (board ab-v16.103; the design, section 5.7; the operator's answer ab-20v, 2026-11-15: \"Yes, with Mozilla's PDF library (pdf.js)\"). PageFetch gives the text of a PDF; there is no text recognition.",
  "What is a PDF. A response of the main frame's document at the response stage whose type (the media type of its `Content-Type`, in any case) is `application/pdf` and that is no redirect (a 3xx with a `Location`). Each other response of a document goes on at once (`Fetch.continueRequest`). A main document that the network domain reports with the type `application/pdf` while the service held no response of it gives `unavailable`, before the lost window's text.",
  "The bytes. The service holds that response, so Chrome's PDF viewer and a download never get it: it takes the body with `Fetch.takeResponseBodyAsStream` and `IO.read` in parts of at most 1,048,576 bytes, closes the stream (`IO.close`), and fails the request (`Fetch.failRequest` with `Aborted`). A PDF of more than 25 MB (26,214,400 bytes) gives `too_large`: a `Content-Length` above it, with no content encoding, reads no byte, and a stream stops at the part that passes it. A read that fails (for example, Chrome ended the tab's session) gives `unavailable`. The PDF ends the ready wait at once, before every other end of the fetch; the check read and Defuddle do not run.",
  "The read. pdf.js (the pinned `pdfjs-dist` 6.4.299, its legacy build for Node) reads the text in a worker thread of the service with a heap limit of 512 MiB, no environment and no Node flag of the service, until the end of the fetch's 60 s (then `timeout`). The heap limit does not cover the buffers of pdf.js's decoded streams, so the service reads its resident memory every 50 ms while the worker runs and ends the worker when that memory rises more than 1 GiB (1,073,741,824 bytes) above its value at the worker's start (then `too_large`). No script of the PDF runs: pdf.js's core API only (`getDocument`, `getPage`, `getTextContent`, `getMetadata`), with `useWasm`, `useSystemFonts`, `enableXfa` and `useWorkerFetch` false and `disableFontFace` true, its CMaps and standard fonts from the package's own folders, no network, and no native package (the worker refuses `@napi-rs/canvas`). The service drops the worker's output. A PDF that needs a password, and one that pdf.js cannot read, give `unavailable`.",
  "The answer. The markdown holds the text of each page under a `## Page <n>` line, and `(This page has no text.)` for a page with none; a PDF with no text gives `This PDF has no text (<n> pages): it may be a scan, and PageFetch has no text recognition.` (`1 page` for one page). The header's `URL:` is the URL of the PDF's response, `Title:` the PDF's own title (empty when it has none), `Status:` the response's status, `Kind: pdf`, and `Mode:` the call's mode (both modes give the same text). Parts, the memory and the 5,000,000 characters that the service keeps are as for a page; pdf.js stops after the page at which the text passes that limit.",
  "Parts and the memory. One answer holds at most 100,000 characters of the markdown, from `offset`. The service keeps the whole markdown of a fetch, at most 5,000,000 characters, in memory for 15 minutes for the scope that fetched it, at most 20 results for each scope (the oldest goes first), by its `url` and `mode`. At each call the service removes the results older than 15 minutes and the rate's fetches older than 10 minutes of every scope, also of a scope that does not come back. A read on serves only the same scope. An `offset` at or past the end of the markdown is refused.",
  "The log. The service logs one line for each call: `page-fetch: scope <scope>, host <host>, result <result>, status <status>, <ms> ms, <n> characters, <d> downloads, <w> websockets`, with `ok` or the code as the result (`ok (from memory)` for a read on), the status or `none`, the answer's size, the number of incognito downloads that started while the fetch ran, and the number of WebSockets and WebTransports that the page opened (no host and no URL of them). No log line holds a URL path, a query or a page's text, because a URL can hold a token.",
  "The texts of the errors.",
  "| Cause | Code | Text |",
  "| No `url`, an empty one, or one that is no string | `refused` | `Not fetched (refused): Give the URL of a page as the argument url.` |",
  "| A `url` that is no absolute URL | `refused` | `Not fetched (refused): The URL must be an absolute http or https URL.` |",
  "| A `url` of another scheme | `refused` | `Not fetched (refused): The URL must use http or https.` |",
  "| A `mode` other than `main` and `whole` | `refused` | `Not fetched (refused): mode must be main or whole.` |",
  "| An `offset` that is no whole number of 0 or more | `refused` | `Not fetched (refused): offset must be a whole number of 0 or more.` |",
  "| An `offset` at or past the end of the markdown | `refused` | `Not fetched (refused): offset <offset> is past the end of the page's <n> characters.` |",
  "| The URL's host fails the address rule | `refused` | `Not fetched (refused): The host <why>; PageFetch never reaches the box itself or a private network.` |",
  "| A request of the main document fails it | `refused` | `Not fetched (refused): The page went on to another address, and the host <why>; PageFetch never reaches the box itself or a private network.` |",
  "| The receiver blocked the main document's navigation (`net::ERR_BLOCKED_BY_CLIENT`) | `refused` | `Not fetched (refused): The page or a redirect went to an address that the agent browser blocks; PageFetch never reaches the box itself or a private network.` |",
  "| A WebSocket or a WebTransport of the tab, a frame or a worker whose host fails it | `refused` | `Not fetched (refused): The page opened a connection, and the host <why>; PageFetch never reaches the box itself or a private network.` |",
  "| A check that needs a click | `blocked` | `Not fetched (blocked): The page shows a check that needs a person's click (<check>); PageFetch never clicks.` |",
  "| A check page at the ready limit | `blocked` | `Not fetched (blocked): The page stayed on a check page (<check>) for 30 s.` |",
  "| More than 10 navigations | `blocked` | `Not fetched (blocked): The page went through more than 10 navigations.` |",
  "| A request of the main document to a host past the 64 hosts | `blocked` | `Not fetched (blocked): The page went on to more than 64 hosts.` |",
  "| No load event in the ready wait | `timeout` | `Not fetched (timeout): The page did not load within 30 s.` |",
  "| A navigation that Chrome fails | `timeout` | `Not fetched (timeout): The page did not load (<Chrome's error text>).` |",
  "| The whole limit | `timeout` | `Not fetched (timeout): The page did not finish within 60 s.` |",
  "| A private window of the operator | `busy` | `Not fetched (busy): A private window of the operator is open in the agent browser; try again after it closes.` |",
  "| 8 fetches wait | `busy` | `Not fetched (busy): Eight fetches already wait for the agent browser's private window; try again later.` |",
  "| A wait of 10 minutes for the window | `busy` | `Not fetched (busy): PageFetch waited 10 minutes for the agent browser's private window; try again later.` |",
  "| The scope's rate | `busy` | `Not fetched (busy): This session made 30 fetches in 10 minutes; try again in <s> s.` |",
  "| A remote admission | `unavailable` | `Not fetched (unavailable): PageFetch works only for sessions of this box.` |",
  "| A receiver with no `fetch` feature | `unavailable` | `Not fetched (unavailable): The agent extension has no fetch window; it needs a newer release.` |",
  "| The agent browser is not ready | `unavailable` | `Not fetched (unavailable): <C11's readiness text>` |",
  "| The window does not open | `unavailable` | `Not fetched (unavailable): The agent browser could not open its fetch window.` |",
  "| A command of the service's own session fails | `unavailable` | `Not fetched (unavailable): The agent browser could not hold its fetch window.` |",
  "| The window is not outside the screen in 3 s | `unavailable` | `Not fetched (unavailable): The agent browser could not keep its fetch window off the screen.` |",
  "| A frame, a worker or a popup that the service cannot guard | `unavailable` | `Not fetched (unavailable): The agent browser could not guard a frame, a worker or a popup of the page.` |",
  "| The tab is gone (its session ended, or it closed or was replaced) | `unavailable` | `Not fetched (unavailable): The agent browser lost its fetch window before the page was ready.` |",
  "| A PDF larger than 25 MB | `too_large` | `Not fetched (too_large): The PDF is larger than 25 MB.` |",
  "| A PDF whose read needs more than 1 GiB of memory | `too_large` | `Not fetched (too_large): The PDF needs more than 1024 MB of memory to read.` |",
  "| A PDF whose bytes or text the service cannot read | `unavailable` | `Not fetched (unavailable): The agent browser could not read the PDF.` |",
  "| A PDF that needs a password | `unavailable` | `Not fetched (unavailable): The PDF needs a password; PageFetch reads no protected PDF.` |",
  "| The converter does not load | `unavailable` | `Not fetched (unavailable): The agent browser could not load its converter.` |",
  "| The conversion fails | `unavailable` | `Not fetched (unavailable): The agent browser could not convert the page.` |",
  "`<why>` is the host and its reason: `<host> is <a kind of address>` for an IP literal or a refused name (for example `127.0.0.1 is a loopback address`, `app.localhost is a name of the box itself`), `<host> has <a kind of address>` for a name with a refused address, or `<host> has no address in the box's resolver`. No text holds the page's text, a URL path or a query.",
];

test("C11's part on PageFetch holds exactly its sentences, after the merge guard and before the sign-in act", () => {
  const p = partOr(PAGE_FETCH_HEADING);
  for (const s of PAGE_FETCH_ITEMS) assert.ok(says(p, s), `C11 says: ${s.slice(0, 120)}`);
  assert.equal(clean(p), PAGE_FETCH_ITEMS.join(" "), "the part holds no other text");
  const at = C11.indexOf(`**${PAGE_FETCH_HEADING}`);
  assert.ok(C11.indexOf(`**${MERGE_GUARD_HEADING}`) < at && at < C11.indexOf(`**${SIGN_IN_HEADING}`));
  assert.ok(p.split("\n").every((l) => (l.match(/`/g) ?? []).length % 2 === 0), "no code span over a line break");
  assert.ok(!/\/home\//.test(p), "no box path");
});

test("PageFetch's texts and numbers in C11 are the code's: the tool, each error text, the limits, the lock, the window, Defuddle's options, the challenge marks", async () => {
  const pf = await import("../src/service/fetch/page-fetch.ts");
  const lk = await import("../src/service/fetch/lock.ts");
  const fp = await import("../src/service/fetch/fetch-page.ts");
  const al = await import("../src/service/mcp/allow-list.ts");
  const p = flat(partOr(PAGE_FETCH_HEADING));
  const code = readOr("src/service/fetch/page-fetch.ts");
  assert.equal(pf.PAGE_FETCH, "PageFetch");
  assert.equal(pf.FETCH_FEATURE, "fetch");
  assert.ok(Object.hasOwn(al.SERVICE_TOOLS, "PageFetch"));
  // Each fixed text of the table is a text of the code (a text with a <part> has its fixed parts in the code).
  const rows = PAGE_FETCH_ITEMS.filter((s) => s.startsWith("| ") && !s.startsWith("| Cause") && !s.startsWith("| ---"));
  assert.equal(rows.length, 35);
  for (const r of rows) {
    const m = /`Not fetched \((\w+)\): (.*)` \|$/.exec(r);
    assert.ok(m, r);
    const code_ = m![1];
    assert.ok(["refused", "blocked", "timeout", "too_large", "busy", "unavailable"].includes(code_), r);
    if (m![2] === "<C11's readiness text>") continue;
    // The fixed pieces: the text without its <parts> and its numbers (the code makes those from its limits).
    for (const piece of m![2].split(/<[^>]+>|\b\d[\d,.]*(?: s| minutes| fetches| navigations| characters)?\b/)) {
      const bit = piece.replace(/^[\s;,.)]+|[\s.(]+$/g, "");
      if (bit.length > 3) assert.ok(code.includes(bit), `the code holds: ${bit}`);
    }
  }
  const L = pf.FETCH_LIMITS;
  assert.deepEqual([L.readyMs, L.wholeMs, L.settleMs, L.quietMs, L.navigations, L.hosts, L.endMs, L.moveMs, L.waitMs, L.rate, L.rateMs, L.memoryMs, L.memoryCount, L.partChars, L.fallbackChars, L.keepChars],
    [30_000, 60_000, 2_000, 500, 10, 64, 20_000, 3_000, 600_000, 30, 600_000, 900_000, 20, 100_000, 200, 5_000_000]);
  assert.equal(L.goneMs, 500, "a failed child's or popup's end: 500 ms");
  assert.deepEqual([lk.LOCK_LIMITS.queue, lk.LOCK_LIMITS.fetchHoldMs, lk.LOCK_LIMITS.leftMs], [8, 80_000, 10_000]);
  assert.equal(lk.LOCK_LIMITS.fetchHoldMs, L.wholeMs + L.endMs, "a fetch's longest hold is its whole limit and its end");
  for (const s of ["at most 30 s from the navigation", "no navigation of the main frame has started for 2 s", "open for 500 ms", "at most 10 more", "at most 20 s in all", "within 3 s",
    "waits at most 10 minutes", "at most 30 fetches in any 10 minutes", "for 15 minutes", "at most 20 results", "at most 100,000 characters", "fewer than 200 characters", "at most 5,000,000 characters",
    "At most 8 fetches wait", "at most 64 different hosts", "within 500 ms (a frame that ended", "unless Chrome removes its tab within 500 ms", "older than 15 minutes and the rate's fetches older than 10 minutes of every scope", "its longest hold, 80 s (its 60 s, then its end's 20 s)", "The lock ends a fetch's hold at 80 s", "at most 10 s, before its own window"]) assert.ok(p.includes(s), `C11 says: ${s}`);
  assert.ok(p.includes(`\`${JSON.stringify(fp.defuddleOptions("<url>", false))}\``), "the options of main");
  const whole = fp.defuddleOptions("u", true) as Record<string, unknown>;
  assert.ok(p.includes(`\`${JSON.stringify(Object.fromEntries(Object.entries(whole).filter(([k]) => !["url", "markdown", "useAsync", "removeHiddenElements"].includes(k))))}\``), "the options of whole");
  for (const [part] of fp.CHALLENGES.clickFrames) assert.ok(p.includes(part.replace(/^\//, "")), `the click frame ${part}`);
  for (const [t] of fp.CHALLENGES.clickTexts) assert.ok(p.includes(t), `the click text ${t}`);
  for (const [t] of fp.CHALLENGES.checkTitles) assert.ok(p.toLowerCase().includes(t), `the check title ${t}`);
  assert.ok(p.includes('`[{"url":"about:blank","focused":false,"incognito":true,"width":1280,"height":900}, <scope>, "fetch"]`'), "the window's op");
  assert.ok(code.includes('[{ url: "about:blank", focused: false, incognito: true, width: 1280, height: 900 }, r.scope, "fetch"]'));
});

// The changed sentences of C11, C12 and the allow list's format (old, then new; an empty old is a new sentence).
const BOARD_V16_102: { file: string; why: string; old: string; text: string }[] = [
  { file: "C11", why: "the stage table: the row of PageFetch", old: "", text: "| PageFetch (the MCP's own tool `PageFetch`), its address rule, its fetch window and the one private window that it shares with the sign-in act (PageFetch, below) | agent-browser's service | board ab-v16.102 builds it on Linux; it serves sessions from stage 3 |" },
  { file: "C11", why: "the stage table: where the row of PageFetch comes from", old: "", text: "The row of PageFetch comes from the PageFetch design (`docs/superpowers/specs/2026-11-15-page-fetch-design.md`, board ab-v16.102), approved by the operator (board answer ab-1wu, 2026-11-15)." },
  { file: "C11", why: "the sign-in act's check 7: the one private window with PageFetch", old: "No other act runs. An act waits for the act before it, at most 60 s. A request that waited is checked again at its turn:", text: "No other act and no PageFetch runs: the act and PageFetch share the one private window (PageFetch, above). An act waits for the window at most 60 s, and, when a fetch holds the window at the act's request, also that fetch's longest hold (80 s): an act waits for a running fetch and never fails because of it (the daemon lead's rule); a waiting act gets the window before every waiting fetch. A request that waited is checked again at its turn:" },
  { file: "C12", why: "the use: a call of PageFetch stays a use until PageFetch's method ends", old: "stays a use until its act's method ends, also after its client's close (C11, the sign-in act).", text: "stays a use until its method ends (the sign-in act's method, or PageFetch's), also after its client's close (C11, the sign-in act and PageFetch)." },
  { file: "ALLOW", why: "where PageFetch comes from", old: "", text: "The PageFetch design (`docs/superpowers/specs/2026-11-15-page-fetch-design.md`, board ab-v16.102) adds the service's own tool `PageFetch`." },
  { file: "ALLOW", why: "service_tools: three tools", old: "the service answers them itself (C11, the sign-in act). They are exactly these two, in every list:", text: "the service answers them itself (C11, the sign-in act and PageFetch). They are exactly these three, in every list:" },
  { file: "ALLOW", why: "tools/list: each own tool with its part", old: "and adds each tool of `service_tools` for a request with a local admission while the service has the sign-in act; a request that a remote token admitted gets no tool of `service_tools`.", text: "and adds each tool of `service_tools` for a request with a local admission while the service has the part that serves it (the sign-in act for `browser_sign_in` and `browser_sign_ins`, PageFetch for `PageFetch`); a request that a remote token admitted gets no tool of `service_tools`." },
  { file: "ALLOW", why: "the own tools in tools/list and the -32601 without their part", old: "The service's own tools are in a `tools/list` only for a request with a local admission while the service has the sign-in act (C11), after the tools of `tools`, each as `{\"name\",\"description\",\"inputSchema\"}` with its `description` and its `schema`. While the service has no sign-in act, a `tools/call` of one with a local admission gets the `-32601` answer of a tool that `tools` does not name.", text: "The service's own tools are in a `tools/list` only for a request with a local admission while the service has the part that serves each of them (C11), after the tools of `tools`, each as `{\"name\",\"description\",\"inputSchema\"}` with its `description` and its `schema`. While the service does not have that part, a `tools/call` of the tool with a local admission gets the `-32601` answer of a tool that `tools` does not name." },
  { file: "ALLOW", why: "tools/call: the remote answer of PageFetch and its local run", old: "For a request that a remote token admitted, the answer is the tool error of the sign-in act's check 1, a result with `isError: true` and the text `Not signed in: Stored sign-ins work only for sessions of this box.`, whatever its arguments. For a request with a local admission, `arguments` that is not a JSON object, or an argument key that the tool's `keys` does not name, gets its `-32602` answer above; else the service runs the sign-in act's method for the MCP session's scope (C11, the sign-in act).", text: "For a request that a remote token admitted, the answer of `browser_sign_in` and `browser_sign_ins` is the tool error of the sign-in act's check 1, a result with `isError: true` and the text `Not signed in: Stored sign-ins work only for sessions of this box.`, and the answer of `PageFetch` is the tool error `Not fetched (unavailable): PageFetch works only for sessions of this box.`, whatever its arguments. For a request with a local admission, `arguments` that is not a JSON object, or an argument key that the tool's `keys` does not name, gets its `-32602` answer above; else the service runs the sign-in act's method or PageFetch for the MCP session's scope (C11, the sign-in act and PageFetch)." },
  { file: "C11", why: "the live run: a navigation that the receiver blocked is refused", old: "A navigation that Chrome fails (`Page.navigate`'s `errorText`, other than `net::ERR_ABORTED`) gives `timeout` with Chrome's error text.", text: "A navigation that Chrome fails (`Page.navigate`'s `errorText`, other than `net::ERR_ABORTED` and `net::ERR_BLOCKED_BY_CLIENT`) gives `timeout` with Chrome's error text. `net::ERR_BLOCKED_BY_CLIENT` gives `refused`: the receiver's rule blocked the page or a redirect before the guard saw it (a redirect of the main document to a refused IP literal), and Chrome gives no URL of it." },
  { file: "C11", why: "the live run: the error text of a navigation that the receiver blocked", old: "", text: "| The receiver blocked the main document's navigation (`net::ERR_BLOCKED_BY_CLIENT`) | `refused` | `Not fetched (refused): The page or a redirect went to an address that the agent browser blocks; PageFetch never reaches the box itself or a private network.` |" },
  { file: "C11", why: "the live run: a frame or a worker that Chrome ended is skipped; Network.enable alone does not end the fetch", old: "A frame or a worker that Chrome attaches to the tab's session waits before it runs (`waitForDebuggerOnStart`) until its own session has `Fetch.enable` for every URL, its own `Target.setAutoAttach` and `Network.enable`; then it runs (`Runtime.runIfWaitingForDebugger`). One for which any of the three fails ends the fetch (`unavailable`), and it never runs.", text: "A frame or a worker that Chrome attaches to the tab's session waits before it runs (`waitForDebuggerOnStart`) until its own session has `Fetch.enable` for every URL and its own `Target.setAutoAttach`; then the service sends its `Network.enable`, and it runs (`Runtime.runIfWaitingForDebugger`). One for which `Fetch.enable` or `Target.setAutoAttach` fails never runs: when Chrome reports its end (`Target.detachedFromTarget`) within 500 ms (a frame that ended or that the receiver blocked before it loaded, a worker that stopped), the fetch goes on with the log line `page-fetch: a <kind> of the fetch ended before its guard (<command>)`; else the fetch ends (`unavailable`) with the log line `page-fetch: a <kind> of the fetch got no guard (<command> failed: <why>)`. The page is not ready while the service waits for that end. A dedicated worker (`worker`) whose session has no Fetch domain (Chrome's `-32601` for `Fetch.enable`) loads through its frame's network stack, where the frame's own guard holds each of its requests: it runs, with the log line `page-fetch: a worker of the fetch has no Fetch domain; its frame's guard holds its requests`; a frame with no Fetch domain ends the fetch. A failure of `Network.enable` alone (the reads of the child's WebSockets, defence in depth: the receiver's rule blocks each WebSocket and WebTransport of a fetch tab, C5) gets the log line `page-fetch: a <kind> of the fetch runs with no WebSocket reads (Network.enable failed: <why>)`, and the child runs with its guard. `<kind>` is `frame` or Chrome's type of the target (`worker`); `<why>` is the error's text with no URL, at most 160 characters." },
  { file: "C11", why: "the live run: a popup that closed is gone, not a failure", old: "A popup that the service cannot hold ends the fetch (`unavailable`).", text: "A popup that the service cannot hold ends the fetch (`unavailable`, with the log line `page-fetch: a popup of the fetch got no guard (<step> failed: <why>)`), unless Chrome removes its tab within 500 ms (it closed): then the fetch goes on with the log line `page-fetch: a popup of the fetch closed before its hold ended (<step>)`." },
];
test("board ab-v16.102: C11, C12 and the allow list's format say each changed text of PageFetch exactly, and no old text", () => {
  const files: Record<string, string> = { C11, C12: C12P, ALLOW: ALLOWP };
  assert.equal(BOARD_V16_102.length, 13);
  for (const e of BOARD_V16_102) {
    assert.ok(says(files[e.file], payNow(e.text)), `${e.file}, ${e.why}: ${e.text.slice(0, 160)}`);
    if (e.old) assert.ok(!says(files[e.file], e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
});

// ---- Board ab-v16.106: a PageFetch page with a dedicated worker is ready when it is quiet (live run 5 of PR #171: 30.6 s).
// The changed sentence of C11 (old, then new); the PR body lists it. The code's rule: test/page-fetch.test.ts.
const BOARD_V16_106: { why: string; old: string; text: string }[] = [
  { why: "the ready rule: a request of the tab ends in any session of the fetch; a worker's script whose end no session reports is never open", old: "and no network request of the tab has been open for 500 ms. The ready wait is at most 30 s from the navigation.", text: "and no network request of the tab has been open for 500 ms. A request that the tab's session reports ends when any session of the fetch (the tab's, a frame's or a worker's) reports its end with the same request id: Chrome reports the start of a dedicated worker's script in the tab's session and its end in the worker's session, both with the worker's target id (board ab-v16.106). The script of a worker whose `Network.enable` failed, or that Chrome detached, is never open. The ready wait is at most 30 s from the navigation." },
];

test("board ab-v16.106: C11's ready rule of PageFetch says the end of a request in any session of the fetch exactly, and no old text; the log line of a failed Network.enable has no exception for a worker", () => {
  const p = partOr(PAGE_FETCH_HEADING);
  for (const e of BOARD_V16_106) {
    assert.ok(says(p, e.text), `${e.why}: ${e.text.slice(0, 160)}`);
    assert.ok(!says(p, e.old), `${e.why}: the old text is gone`);
  }
  assert.ok(says(p, "A failure of `Network.enable` alone (the reads of the child's WebSockets, defence in depth: the receiver's rule blocks each WebSocket and WebTransport of a fetch tab, C5) gets the log line `page-fetch: a <kind> of the fetch runs with no WebSocket reads (Network.enable failed: <why>)`, and the child runs with its guard."), "the log line of a failed Network.enable, for every kind");
});

// ---- Board ab-v16.103: PageFetch reads the text of a PDF with pdf.js (the PageFetch design, section 5.7; the operator's
// answer ab-20v). Each changed sentence of C11 and of the allow list's format (old, then new; an empty old is a new
// sentence); the PR body lists them for the daemon lead.
const BOARD_V16_103: { file: string; why: string; old: string; text: string }[] = [
  { file: "C11", why: "the part's opening: PDFs are built", old: "PDFs (the design's stage 3), agentwatch's MCP entry for every session (stage 4), the navigation tools for every agent (stage 5) and the Mac (stage 6) come later.", text: "Board ab-v16.103 adds PDFs (the design's stage 3; PDFs, below)" },
  { file: "C11", why: "what PageFetch does: a PDF's text", old: "converts the live DOM to markdown, ends the window, and answers the markdown.", text: "converts the live DOM to markdown (for a PDF, pdf.js reads the text of its pages: PDFs, below), ends the window, and answers the markdown." },
  { file: "C11", why: "the header: Kind pdf", old: "`Kind: html`; `Mode: main`, `Mode: whole`, or", text: "`Kind: html`, or `Kind: pdf` for a PDF; `Mode: main`, `Mode: whole`, or" },
  { file: "C11", why: "the fetch window's session: the response stage of every document", old: "`Fetch.enable` for every URL at the request stage, `Target.setAutoAttach`", text: "`Fetch.enable` for every URL at the request stage and for every document at the response stage (`{\"patterns\":[{\"urlPattern\":\"*\",\"requestStage\":\"Request\"},{\"urlPattern\":\"*\",\"resourceType\":\"Document\",\"requestStage\":\"Response\"}]}`), `Target.setAutoAttach`" },
  { file: "C11", why: "the ready wait: a PDF ends it at once (D1)", old: "A main document of the type `application/pdf` gives `unavailable` until the design's stage 3.", text: "A PDF ends the ready wait at once, before every other end of the fetch (PDFs, below)." },
  // The new item PDFs and its four sub-items.
  ...PAGE_FETCH_ITEMS.slice(PAGE_FETCH_ITEMS.findIndex((t) => t.startsWith("PDFs (board ab-v16.103")), PAGE_FETCH_ITEMS.findIndex((t) => t.startsWith("PDFs (board ab-v16.103")) + 5).map((text) => ({ file: "C11", why: "the new item PDFs", old: "", text })),
  { file: "C11", why: "the error table: the PDF's rows", old: "| A PDF | `unavailable` | `Not fetched (unavailable): The page is a PDF; PageFetch reads PDFs in a later release.` |", text: "| A PDF larger than 25 MB | `too_large` | `Not fetched (too_large): The PDF is larger than 25 MB.` |" },
  { file: "C11", why: "review B1: the memory limit of the read", old: "", text: "The heap limit does not cover the buffers of pdf.js's decoded streams, so the service reads its resident memory every 50 ms while the worker runs and ends the worker when that memory rises more than 1 GiB (1,073,741,824 bytes) above its value at the worker's start (then `too_large`)." },
  { file: "C11", why: "review B1: the error row of the memory limit", old: "", text: "| A PDF whose read needs more than 1 GiB of memory | `too_large` | `Not fetched (too_large): The PDF needs more than 1024 MB of memory to read.` |" },
  { file: "C11", why: "the error table: the PDF's rows", old: "", text: "| A PDF whose bytes or text the service cannot read | `unavailable` | `Not fetched (unavailable): The agent browser could not read the PDF.` |" },
  { file: "C11", why: "the error table: the PDF's rows", old: "", text: "| A PDF that needs a password | `unavailable` | `Not fetched (unavailable): The PDF needs a password; PageFetch reads no protected PDF.` |" },
  { file: "ALLOW", why: "the PageFetch tool's description names PDFs (the lead's open point)", old: "Fetch one web page that blocks plain HTTP clients (a 401, a 403, a bot check, a page that needs JavaScript) and get its rendered content as markdown.", text: "Fetch one web page or PDF that blocks plain HTTP clients (a 401, a 403, a bot check, a page that needs JavaScript) and get its rendered content as markdown, or the text of each page of a PDF." },
];
test("board ab-v16.103: C11 and the allow list's format say each changed text of PageFetch's PDFs exactly, and no old text; the numbers are the code's", async () => {
  const files: Record<string, string> = { C11, ALLOW: ALLOWP };
  assert.equal(BOARD_V16_103.length, 16);
  assert.deepEqual(BOARD_V16_103.filter((e) => e.why === "the new item PDFs").map((e) => e.text.slice(0, 14)), ["PDFs (board ab", "What is a PDF.", "The bytes. The", "The read. pdf.", "The answer. Th"]);
  for (const e of BOARD_V16_103) {
    assert.ok(says(files[e.file], e.text), `${e.file}, ${e.why}: ${e.text.slice(0, 160)}`);
    if (e.old) assert.ok(!says(files[e.file], e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
  const pf = await import("../src/service/fetch/page-fetch.ts");
  const pt = await import("../src/service/fetch/pdf-text.ts");
  const al = await import("../src/service/mcp/allow-list.ts");
  const p = flat(partOr(PAGE_FETCH_HEADING));
  assert.equal(pf.FETCH_LIMITS.pdfBytes, 26_214_400);
  assert.ok(p.includes("A PDF of more than 25 MB (26,214,400 bytes) gives `too_large`"));
  assert.equal(pf.PDF_PART_BYTES, 1_048_576);
  assert.ok(p.includes("in parts of at most 1,048,576 bytes"));
  assert.equal(pt.PDF_HEAP_MB, 512);
  assert.ok(p.includes("with a heap limit of 512 MiB"));
  // Review B1: the memory limit, its check's period, and its text (the code makes "1024 MB" from the limit).
  assert.deepEqual([pt.PDF_MEMORY_BYTES, pf.FETCH_LIMITS.pdfMemory, pt.PDF_MEMORY_CHECK_MS], [1_073_741_824, 1_073_741_824, 50]);
  assert.ok(p.includes("every 50 ms while the worker runs") && p.includes("more than 1 GiB (1,073,741,824 bytes) above its value at the worker's start"));
  assert.ok(p.includes(`\`Not fetched (too_large): The PDF needs more than ${pf.FETCH_LIMITS.pdfMemory / (1024 * 1024)} MB of memory to read.\``));
  assert.ok(p.includes(`\`${pt.noPdfText(2).replace("2 pages", "<n> pages")}\``) && pt.noPdfText(1).includes("(1 page)"), "the text of a PDF with no text");
  assert.ok(p.includes(`\`${pt.NO_PAGE_TEXT}\``));
  assert.ok(p.includes(`\`pdfjs-dist\` ${JSON.parse(readOr("package.json")).dependencies["pdfjs-dist"]}`), "the pinned version");
  assert.match(String((al.SERVICE_TOOLS as any).PageFetch.description), /^Fetch one web page or PDF that blocks plain HTTP clients/);
});

// ---- Board ab-v16.107: PageFetch gives a page's own content, not a consent manager's layer; a check page's note. The
// changed sentences of C11's part "PageFetch" (old, then new; an empty old is a new sentence); the PR body lists them.
const BOARD_V16_107: { why: string; old: string; text: string }[] = [
  { why: "the answer's header: the note of a bot check page", old: "; and, for an answer that holds a part, `Part: characters <offset> to <end>; the next part starts at offset <end>` or `Part: characters <offset> to <end>; the last part`.", text: "; for an answer that holds a part, `Part: characters <offset> to <end>; the next part starts at offset <end>` or `Part: characters <offset> to <end>; the last part`; and, for a page that looks like a bot check page, `Note: the page looks like a bot check page; its content is the check, not the page.`" },
  { why: "when a page looks like a bot check page, and the answer stays ok", old: "", text: "A page looks like a bot check page (board ab-v16.107) when its status is 401, 403, 429 or 503 and its title (the check read's, the whole title in any case, its spaces collapsed) is one of the check page titles: `Just a moment...`, `Attention Required! | Cloudflare`, `Please Wait... | Cloudflare` and `Verifying you are human` (Cloudflare), `Security Verification` (a check page that answered 401 on the real-page check of 2026-11-15), `Access Denied` (Akamai), `Access to this page has been denied` with or without its full stop (HUMAN), `Pardon Our Interruption` (Imperva), `DDoS-Guard`, `Vercel Security Checkpoint`, `Making sure you're not a bot!` (Anubis) and `Sucuri WebSite Firewall - Access Denied` (Sucuri); the list is `CHECK_PAGE_TITLES` in `src/service/fetch/fetch-page.ts`, with each title's source. DataDome and AWS WAF have no fixed title: the check read finds their checks by their frames and elements. Such an answer stays `ok`: PageFetch never clicks, never waits for such a check to pass and never tries again." },
  { why: "the conversion: the copy drops a consent manager's layer, with the safety rule", old: "", text: "In both modes the copy also drops the layer of a consent manager (board ab-v16.107: a museum's object page gave 833,174 characters of a consent manager's partner list in `main`, which a person sees only after opening the consent layer): each element of the copy's body that is a root of a common consent manager goes with its content. The roots, from the markup of each vendor's public script (`CONSENT_ROOTS` in `src/service/fetch/fetch-page.ts`): OneTrust (`#onetrust-consent-sdk`, `#onetrust-banner-sdk`, `#onetrust-pc-sdk`, `.onetrust-pc-dark-filter`), Cookiebot (`#CybotCookiebotDialog`, `#CybotCookiebotDialogBodyUnderlay`, `#CookiebotWidget`), Didomi (`#didomi-host`), Usercentrics (`#usercentrics-root`, `#usercentrics-cmp-ui`), Sourcepoint (`#sp_message_container_<n>`), Quantcast Choice (`#qc-cmp2-container`, `.qc-cmp2-container`), TrustArc (`#consent_blackbar`, `#truste-consent-track`, `.truste_box_overlay`, `.truste_overlay`), Osano (`.osano-cm-window`, `.osano-cm-dialog`, `.osano-cm-info-dialog`), iubenda (`#iubenda-cs-banner`, `#iubenda-iframe`), CookieYes (`#cookie-law-info-bar`, `#cliSettingsPopup`, `.cky-consent-container`, `.cky-modal`, `.cky-overlay`), Complianz (`#cmplz-cookiebanner-container`, `.cmplz-cookiebanner`), consentmanager.net (`#cmpwrapper`, `#cmpbox`, `#cmpbox2`), Google Funding Choices (`.fc-consent-root`, `.fc-ccpa-root`), Borlabs Cookie (`#BorlabsCookieBox`, `#BorlabsCookieBoxWrap`, `#BorlabsCookieWidget`), Termly (`#termly-code-snippet-support`), Ketch (`#lanyard_root`), Axeptio (`#axeptio_overlay`, `.axeptio_mount`), Klaro (`#klaro`), Civic Cookie Control (`#ccc`) and Cookie Information (`#coiOverlay`, `#cookie-information-template-wrapper`). A root matches by its whole id or by one of its whole class names (Sourcepoint's id: `sp_message_container_` and a number), never by a part of a name, so a page's own `consent-article` stays. In the layer, each element whose `aria-hidden` is `true` or that has the `hidden` attribute goes too. The drop comes after Defuddle's flattening of shadow roots, which pairs the live elements with the copy's by their order and brings a layer in a shadow host into the copy. The safety rule: when the copy has fewer than 200 characters of text outside the roots (a page whose content is the consent layer), the roots stay, and only those hidden parts of the layer go." },
];
test("board ab-v16.107: C11's part on PageFetch says each changed sentence exactly (as board ab-v16.109 changed it), and no old text", () => {
  const p = partOr(PAGE_FETCH_HEADING);
  assert.equal(BOARD_V16_107.length, 3);
  for (const e of BOARD_V16_107) {
    assert.ok(says(p, after110(after109(e.text))), `${e.why}: ${e.text.slice(0, 160)}`);
    if (e.old) assert.ok(!says(C11, e.old), `${e.why}: the old text is gone`);
  }
});

// ---- Board ab-v16.109: a page whose content needs consent gives the consent layer's visible text and a note, not its
// closed partner list. The changed sentences of C11's part "PageFetch" (old, then new; an empty old is a new sentence);
// the PR body lists them for the daemon lead.
const BOARD_V16_109: { why: string; old: string; text: string }[] = [
  { why: "the answer's header: the note of a consent layer, after the note of a bot check page", old: "", text: "A page whose consent layer the conversion's safety rule kept (below) gets one more line at the end of the header: `Note: the page shows a consent layer; its content may need a consent, which PageFetch never gives.`; a page that gets both notes has the bot check page's note first." },
  { why: "the safety rule: the layer's parts that a style hides go too, only inside the kept roots; the note; the answer stays ok", old: "The safety rule: when the copy has fewer than 200 characters of text outside the roots (a page whose content is the consent layer), the roots stay, and only those hidden parts of the layer go.", text: "The safety rule: when the copy has fewer than 200 characters of text outside the roots (a page whose content is the consent layer), the roots stay, and only the hidden parts of the layer go: those and each element of the layer that the rendered page hides by a style (its computed `display` is `none` or its `visibility` is `hidden`) (board ab-v16.109: else Defuddle's retries for little content take a partner list that a style sheet closes, and the museum's object page still gave 833,174 characters of it). The layer's visible text stays, and the header gets the note of a consent layer; the answer stays `ok`: PageFetch never clicks, never waits for a consent and never tries again." },
];
/** A text of BOARD_V16_107 as board ab-v16.109 changed it. */
const after109 = (s: string) => {
  let t = flat(s);
  for (const f of BOARD_V16_109) { const o = flat(f.old); if (o && t.includes(o)) t = t.replace(o, flat(f.text)); }
  return t;
};
test("board ab-v16.109: C11's part on PageFetch says each changed sentence exactly, and no old text; the code's note, its place in the header and the safety rule's drop", async () => {
  const p = partOr(PAGE_FETCH_HEADING);
  assert.equal(BOARD_V16_109.length, 2);
  for (const e of BOARD_V16_109) {
    assert.ok(says(p, after110(e.text)), `${e.why}: ${e.text.slice(0, 160)}`);
    if (e.old) assert.ok(!says(C11, e.old), `${e.why}: the old text is gone`);
  }
  const fp = await import("../src/service/fetch/fetch-page.ts");
  assert.ok(flat(p).includes(`\`${fp.CONSENT_LAYER_NOTE}\``), "the note");
  const code = readOr("src/service/fetch/page-fetch.ts");
  assert.ok(code.includes("if (r.checkPage) lines.push(CHECK_PAGE_NOTE);\n    if (r.consentLayer) lines.push(CONSENT_LAYER_NOTE);"), "the consent note after the check page's note");
  assert.ok(code.includes("consentLayer: out.consentLayer === true"), "the conversion's flag");
  const expr = fp.convertExpression("/*bundle*/", "u", "main", 200);
  // Board ab-v16.110: the removal of hidden elements takes the layer's marked elements before the drop, so the safety
  // rule has no drop of its own for them.
  assert.ok(!expr.includes("if (marked(el)) el.remove();"), "the safety rule's drop by the marks is gone (board ab-v16.110)");
  assert.ok(!expr.includes("hiddenClass") && !expr.includes('c === "hidden"'), "no drop by a class (review note N4)");
});

// ---- Board ab-v16.110: PageFetch never gives what a person cannot see: the copy that Defuddle reads has no element that
// the rendered page hides. The changed sentences of C11's part "PageFetch" (old, then new); the PR body lists them for
// the daemon lead.
const BOARD_V16_110: { why: string; old: string; text: string }[] = [
  { why: "the conversion: the copy has no element that the rendered page hides, so no retry of Defuddle brings one back; the cost", old: "Both modes remove hidden elements.", text: "Both modes remove hidden elements: the copy that Defuddle reads has no element that the rendered page hides (its computed `display` is `none` or its `visibility` is `hidden`, by a style sheet or by an inline style), so no retry of Defuddle brings one back: not its retries for little content (with no removal of hidden elements, and with its largest hidden block), not its schema.org retry, not its index page retry, and not the fallback from `main` to `whole` (board ab-v16.110: a museum's object page, whose consent layer has an id of its own that no root below matches, still gave 833,174 characters of the layer's closed partner list in `main` after board ab-v16.109). An element whose `visibility` is `hidden` and that holds an element that the page shows again stays without its own text, so the text of the shown element stays. An element of a shadow root has no such mark of its own: it goes with a host or another element around it that the page hides, and else only by Defuddle's own rules. The removal comes after Defuddle's flattening of shadow roots and before the drop of a consent layer (below). The cost: text that a person sees only after a click (a closed tab or accordion that a style hides) does not come in either mode." },
  { why: "the safety rule: the layer's hidden elements go with the copy's other hidden elements, before the drop", old: "The safety rule: when the copy has fewer than 200 characters of text outside the roots (a page whose content is the consent layer), the roots stay, and only the hidden parts of the layer go: those and each element of the layer that the rendered page hides by a style (its computed `display` is `none` or its `visibility` is `hidden`) (board ab-v16.109: else Defuddle's retries for little content take a partner list that a style sheet closes, and the museum's object page still gave 833,174 characters of it).", text: "The safety rule: when the copy has fewer than 200 characters of text outside the roots (a page whose content is the consent layer), the roots stay, and only the hidden parts of the layer go: those, and each element of the layer that the rendered page hides, which the removal of hidden elements (above) takes before the drop (board ab-v16.109: else Defuddle's retries for little content take a partner list that a style sheet closes, and the museum's object page still gave 833,174 characters of it)." },
  { why: "the fetch window: a desktop width, 1280 by 900 pixels, for the computed style that the removal of hidden elements reads (the daemon lead's condition)", old: "The fetch window. The receiver opens it with C10's `windows.create` `[{\"url\":\"about:blank\",\"focused\":false,\"incognito\":true}, <scope>, \"fetch\"]`, the caller's scope.", text: "The fetch window. The receiver opens it with C10's `windows.create` `[{\"url\":\"about:blank\",\"focused\":false,\"incognito\":true,\"width\":1280,\"height\":900}, <scope>, \"fetch\"]`, the caller's scope. The window has a desktop width, 1280 by 900 pixels (board ab-v16.110): the removal of hidden elements (the conversion, below) reads the rendered page's computed style at this width, so a responsive page's desktop content counts as shown. A screen narrower than that can make the window narrower." },
];
/** A text of BOARD_V16_107 or BOARD_V16_109 as board ab-v16.110 changed it. */
const after110 = (s: string) => {
  let t = flat(s);
  for (const f of BOARD_V16_110) { const o = flat(f.old); if (o && t.includes(o)) t = t.replace(o, flat(f.text)); }
  return t;
};
test("board ab-v16.110: C11's part on PageFetch says each changed sentence exactly, and no old text; the code removes the marked elements of each copy after Defuddle's flattening and before the consent drop", async () => {
  const p = partOr(PAGE_FETCH_HEADING);
  assert.equal(BOARD_V16_110.length, 3);
  for (const e of BOARD_V16_110) {
    assert.ok(says(p, e.text), `${e.why}: ${e.text.slice(0, 160)}`);
    assert.ok(!says(C11, e.old), `${e.why}: the old text is gone`);
  }
  const fp = await import("../src/service/fetch/fetch-page.ts");
  const expr = fp.convertExpression("/*bundle*/", "u", "main", 200);
  assert.ok(expr.includes("try { return flatten.call(this, live, copy); } finally { dropHidden(copy, before); dropConsent(copy); }"), "after the flattening, before the consent drop");
  assert.ok(expr.includes(`for (const el of copy.body.querySelectorAll('[style="display:none"]')) el.remove();`), "a mark of display none takes the element");
  assert.ok(expr.includes("if (!shownIn(g)) { g.remove(); continue; }") && expr.includes("if (before.has(el)) return true;"), "visibility hidden with no shown element of the copy in it (review-183 B2)");
  assert.ok(expr.includes('const before = new Set(copy && copy.body ? copy.body.querySelectorAll("*") : []);'), "the copy's elements before the flattening");
  assert.ok(expr.includes('core.replaceShadowHost = markedReplace(core.replaceShadowHost);') && expr.includes('if (div && div.nodeType === 1) div.setAttribute("style", mark);'), "a host's mark goes to its replacement");
});

// Board ab-v16.94.31: a fetch window that does not open gets a log line with the receiver's error. The old sentence,
// then the new text (the PR's body lists both for the daemon lead).
const BOARD_V16_94_31: { why: string; old: string; text: string }[] = [
  { why: "the fetch window: the log line of a failed windows.create, with the bridge's error", old: "The bridge's error `another private window is open` gives `busy`, and another failure gives `unavailable`. The model hides", text: "The bridge's error `another private window is open` gives `busy`, and another failure gives `unavailable`, with the log line `page-fetch: the fetch window did not open (windows.create failed: <error>)` (board ab-v16.94.31), where `<error>` is the bridge's error with each URL as `<a URL>`, at most 160 characters." },
  { why: "the fetch window: the log line of an answer with no window, no tab or no incognito window", old: "", text: "An answer with no window id, no tab or a window that is not incognito gives `unavailable` too, with the log line `page-fetch: the fetch window did not open (windows.create gave <what>)`, where `<what>` is `no window`, `no tab` or `a window that is not incognito`." },
];
test("board ab-v16.94.31: C11's part on PageFetch says the fetch window's log lines exactly, and no old text; the code writes them, with the bridge's error through whyOf", () => {
  const p = partOr(PAGE_FETCH_HEADING);
  assert.equal(BOARD_V16_94_31.length, 2);
  for (const e of BOARD_V16_94_31) {
    assert.ok(says(p, e.text), `${e.why}: ${e.text.slice(0, 160)}`);
    if (e.old) assert.ok(!says(C11, e.old), `${e.why}: the old text is gone`);
  }
  const code = readOr("src/service/fetch/page-fetch.ts");
  assert.ok(code.includes("this.o.log(`page-fetch: the fetch window did not open (windows.create failed: ${whyOf(e)})`);"), "the failed call's line");
  assert.ok(code.includes("this.o.log(`page-fetch: the fetch window did not open (windows.create gave ${"), "the bad answer's line");
  for (const what of ['"no window"', '"no tab"', '"a window that is not incognito"']) assert.ok(code.includes(what), what);
  assert.ok(code.includes('.replace(/[a-z][a-z0-9+.-]*:\\/\\/\\S*/gi, "<a URL>").slice(0, 160)'), "whyOf: each URL as <a URL>, at most 160 characters");
});

// ---- Board ab-v16.105: PageFetch's review notes. A request of the main document to a host past the fetch's 64 hosts ends
// the fetch (re-check 168B note 4: else the answer could hold Chrome's error page with ok), and the stated limits name
// what no live run measured in the service's path (review-168 N2 and N6, re-check 168B note 7). The changed sentences of
// C11's part "PageFetch" (old, then new; an empty old is a new sentence); the PR body lists them for the daemon lead.
const BOARD_V16_105: { why: string; old: string; text: string }[] = [
  { why: "the guard: a request of the main document to a host past the 64 hosts ends the fetch (blocked); every other request past them fails, and the fetch goes on", old: "a request to another host fails, also a navigation of the main frame, and the fetch goes on.", text: "a request to another host fails (`BlockedByClient`, with no lookup), and the fetch goes on; a request of the main document to another host also ends the fetch (`blocked`; board ab-v16.105), so that no answer holds Chrome's error page of that navigation." },
  { why: "the texts: the row of the main document past the 64 hosts, after the row of the navigations", old: "", text: "| A request of the main document to a host past the 64 hosts | `blocked` | `Not fetched (blocked): The page went on to more than 64 hosts.` |" },
  { why: "the stated limits: what no live run measured in the service's path, and how agent-browser page-fetch differs (PRs #214 and #215)", old: "", text: "No live run measured the following in the service's path (the reviews of board ab-v16.102; board ab-v16.105): a popup that opens and its workers, the uploads of the Reporting API and of Network Error Logging, the prefetch and the prerender of speculation rules, `<link rel=preconnect>`, and a page with a service worker; some of them can reach the network outside the guard. `agent-browser page-fetch` differs (boards ab-v16.113 and ab-v16.114): it turns the Reporting API and Network Error Logging off (board ab-v16.114 measured their uploads outside the guard), and it holds each new target of its browser context before it runs." },
];
test("board ab-v16.105: C11's part on PageFetch says the main document past the 64 hosts and the unmeasured items exactly, and no old text; the code ends the fetch only for the main document, with the table's text; agent-browser page-fetch's report uploads are off and its new targets wait", () => {
  const p = partOr(PAGE_FETCH_HEADING);
  assert.equal(BOARD_V16_105.length, 3);
  for (const e of BOARD_V16_105) {
    assert.ok(says(p, e.text), `${e.why}: ${e.text.slice(0, 160)}`);
    if (e.old) assert.ok(!says(C11, e.old), `${e.why}: the old text is gone`);
  }
  assert.ok(says(p, "Not fetched (blocked): The page went through more than 10 navigations.` | " + BOARD_V16_105[1].text), "the row after the navigations' row");
  assert.ok(says(p, "Local Network Access stops such a request to loopback and to private ranges. " + BOARD_V16_105[2].text), "at the end of the stated limits");
  const code = readOr("src/service/fetch/page-fetch.ts");
  assert.ok(code.includes('if (main && "over" in c && c.over) r.tooManyHosts = true;\n      else if (main) r.refusedMain = c.why;\n      fail();'), "the main document past the limit: blocked; every request past it fails");
  assert.ok(code.includes("if (r.tooManyHosts) no(\"blocked\", `The page went on to more than ${this.limits.hosts} hosts.`);"), "the table's text");
  assert.ok(code.includes('if (!c.ok && !("over" in c && c.over) && !r.refusedSocket) r.refusedSocket = c.why;'), "a WebSocket past the limit ends no fetch");
  const cli = readOr("src/page-fetch-cli.ts");
  assert.ok(cli.includes('"Reporting", "NetworkErrorLogging",'), "agent-browser page-fetch turns the report uploads off");
  assert.ok(cli.includes('await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });'), "and holds each new target of its context");
});

test("board ab-v16.107: the consent roots, the check page titles, their statuses and the note in C11 are the code's", async () => {
  const fp = await import("../src/service/fetch/fetch-page.ts");
  const p = flat(partOr(PAGE_FETCH_HEADING));
  const code = readOr("src/service/fetch/page-fetch.ts");
  assert.ok(p.includes(`\`${fp.CHECK_PAGE_NOTE}\``), "the note");
  assert.ok(code.includes("lines.push(CHECK_PAGE_NOTE)") && code.includes("looksLikeCheckPage(r.status, shownTitle)"), "the code's header and its rule");
  assert.deepEqual(fp.CHECK_PAGE_STATUSES, [401, 403, 429, 503]);
  assert.ok(p.includes("when its status is 401, 403, 429 or 503"));
  // C11 names HUMAN's title once, "with or without its full stop".
  for (const [t] of fp.CHECK_PAGE_TITLES) assert.ok(p.toLowerCase().includes(`\`${t.endsWith("...") ? t : t.replace(/\.$/, "")}\``), `the check page title ${t}`);
  assert.equal(fp.CONSENT_ROOTS.length, 20);
  for (const r of fp.CONSENT_ROOTS) {
    const names = [...(r.ids ?? []).map((i) => `#${i}`), ...(r.classes ?? []).map((c) => `.${c}`), ...(r.numberedIds ?? []).map((x) => `#${x}<n>`)];
    assert.ok(names.length > 0, r.vendor);
    assert.ok(p.includes(`${r.vendor} (${names.map((n) => `\`${n}\``).join(", ")})`), `the roots of ${r.vendor}`);
  }
  const expr = fp.convertExpression("/*bundle*/", "u", "main", 200);
  assert.ok(expr.includes(JSON.stringify(fp.consentArgs())), "the conversion carries the roots");
});

// ---- Board ab-v16.104: every agent gets the agent browser's MCP with its browser tools, and an off-list page goes to
// the operator (the PageFetch design, sections 5.2 and 5.13; the operator's answer O1, and "let's also give it the
// navigation mcp"). Each changed sentence of C11 (old, then new; an empty old is a new sentence); the PR body lists them
// for the daemon lead. The 401 texts and the sentence on how a session gets the MCP are the daemon lead's words (2026-11-15).
const BOARD_V16_104: { why: string; old: string; text: string }[] = [
  { why: "step 8: the readiness only; no 503 for a scope with no list or no site", old: "8. The readiness and the scope's list: the 503s of steps 4, 5 and 7 before the upgrade, with their texts (the no-list 503 of steps 5 and 7 only for a `tools/call` of a tool other than `PageFetch`, below).", text: "8. The readiness: the 503s of step 4 before the upgrade, with their texts. A scope with no list, or with a list with no site, gets no 503 at this step (below)." },
  { why: "step 8 while Chrome is down: only a scope that no confirm can name gets the no-list 503 at once", old: "(the start at a use, above), and so does a `tools/call` of a tool other than `PageFetch` in a scope with no list, or with a list with no site; else the request passes this step with no start", text: "While this step would refuse with `its extension is not connected` or `its extension has not confirmed the allowlist` (Chrome is down, or its lists are not confirmed yet), a scope that no confirm can name gets the no-list 503 at once from the service's own snapshot (the start at a use, above); else the request passes this step with no start, and a request that needs no browser (`initialize`, `tools/list`, `ping`, a notification, a GET, a DELETE) goes on." },
  { why: "step 8: every tool of a scope with no list or no site works; the browser tools keep the list, and an off-list navigation makes the operator's prompt", old: "On the MCP path a scope whose list has no site gets the no-list 503 too, but only for a `tools/call` of a tool other than `PageFetch`: the list is the allow of the browser tools (the token design, sections 6.5 and 7.2), and `PageFetch` needs no allowlist (PageFetch, below). In a scope with no list, or with a list with no site, every other request passes this step, and a call of `PageFetch` works there and starts a stopped Chrome (board ab-v16.104; the PageFetch design, section 5.2; the operator's answer O1, 2026-11-15: \"every agent gets the mcp for PageFetch\").", text: "On the MCP path a scope with no list, or with a list with no site, passes this step for every request, and each tool works there: a tool call starts a stopped Chrome, `PageFetch` needs no allowlist (PageFetch, below), and the browser tools keep the scope's list, so a navigation to a host that the list does not cover gets the allowlist refusal (the refusals, above), which makes the operator's prompt (C12) and does not wait for the operator's answer (board ab-v16.104; the PageFetch design, sections 5.2 and 5.13; the operator, 2026-11-15: \"every agent gets the mcp for PageFetch\" and \"let's also give it the navigation mcp. when the agent requests a page that's not on the allowlist, it goes to the operator for approval.\")." },
  { why: "step 8: one rule for the browser tools of both doors, the agent door's", old: "The endpoint keeps its own rule: there a scope whose list is empty is admitted, and it can open `about:blank` only.", text: "The MCP's browser is a connection of the agent door, so the browser tools of both doors have one rule, the agent door's: a session whose repo has no list file, or a list file with no site, has its repo's list with no site in the object (C12), the endpoint admits its scope, and its pages open only `about:blank` and the hosts that its list covers; a scope that the line does not name, or names with no list, gets the no-list 503 there (steps 5 and 7 before the upgrade)." },
  { why: "step 7: the 401 with no token (the daemon lead's words)", old: "The agent browser needs this session's connection token. agentwatch adds it to the sessions that it starts while the repo's list has a site.", text: "The agent browser needs this session's connection token. agentwatch adds the agent browser's MCP to each session that it launches while the switch browser.service is on." },
  { why: "step 7: the 401 of a session with no token (the daemon lead's words)", old: "This session has no connection token. agentwatch adds one when it starts a session while the repo's list has a site: restart the session.", text: "This session has no connection token. agentwatch adds the agent browser's MCP to each session that it launches while the switch browser.service is on: restart the session." },
  { why: "how a session gets the MCP: every session (the daemon lead's words)", old: "only when the session's scope has a list with at least one site.", text: "agentwatch adds the agent browser's MCP to each session that it launches while the switch browser.service is on: it writes the MCP's HTTP entry into the session's own MCP configuration at the session's launch, also when the session's repo has no list or a list with no site (board ab-v16.104; the PageFetch design, section 5.2: the operator's answer O1 changes the answer Q2). agentwatch mints the session's token at the launch, sends its fingerprint in `set_sessions`, writes the entry file before the launch and removes it at the session's end." },
  { why: "the refusals: the text after the carrier's ok says that the operator was asked, and the navigation does not wait", old: "", text: "After an `ok` answer the refusal is `Not allowed: <host> is not on the allowlist. The operator has a Browser permission prompt in the agentwatch web viewer. The agent browser asked the operator to allow <host>. This navigation does not wait for the answer: try it again after the operator allows <host>. Do not repeat it in a loop.` The navigation does not wait for the operator's answer: after the operator's allow, the agent's next try passes (board ab-v16.104; the PageFetch design, section 5.13)." },
  { why: "PageFetch's opening: stage 5 is built", old: "the navigation tools for every agent (stage 5) and the Mac (stage 6) come later.", text: "Board ab-v16.103 adds PDFs (the design's stage 3; PDFs, below), and board ab-v16.104 the navigation tools for every agent (stage 5: the MCP path's step 8, above); agentwatch's MCP entry for every session (stage 4) and the Mac (stage 6) come later." },
];
test("board ab-v16.104: C11 says each changed sentence of the MCP path and the refusal exactly, and no old text; the code's texts are C11's, and step 8 gives no no-list 503", async () => {
  assert.equal(BOARD_V16_104.length, 9);
  for (const e of BOARD_V16_104) {
    assert.ok(says(C11, e.text), `C11, ${e.why}: ${e.text.slice(0, 160)}`);
    if (e.old) assert.ok(!says(C11, e.old), `C11, ${e.why}: the old text is gone`);
  }
  // The code: the 401 texts and the refusal after an ok are C11's; admitRequest has no no-list 503 of step 8.
  const { MCP_TEXT } = await import("../src/service/mcp/admission.ts");
  assert.equal(MCP_TEXT.needsToken, "The agent browser needs this session's connection token. agentwatch adds the agent browser's MCP to each session that it launches while the switch browser.service is on.");
  assert.equal(MCP_TEXT.noToken, "This session has no connection token. agentwatch adds the agent browser's MCP to each session that it launches while the switch browser.service is on: restart the session.");
  const { TEXT } = await import("../src/relay/policy.ts");
  assert.equal(TEXT.notAllowed("off.example", true), "Not allowed: off.example is not on the allowlist. The operator has a Browser permission prompt in the agentwatch web viewer. The agent browser asked the operator to allow off.example. This navigation does not wait for the answer: try it again after the operator allows off.example. Do not repeat it in a loop.");
  assert.equal(TEXT.notAllowed("off.example"), "Not allowed: off.example is not on the allowlist", "with no ok the row's text stays");
  const admission = readOr("src/service/mcp/admission.ts"), port = readOr("src/service/mcp/port.ts");
  assert.ok(!admission.includes("NO_SITE") && !port.includes("NO_SITE") && !admission.includes("r.sites"), "step 8 reads no sites");
});

// Board ab-v16.94.30: on the Mac the service takes the MCP port's socket from launchd (launch_activate_socket, the job's
// Sockets entry agent-browser-mcp). Each changed or new text of C11, exactly, and the old text is gone; the PR's body
// lists them, old then new, for the daemon lead (agentwatch's side: the plist's Sockets entry).
const MAC_MCP_SOCKET: { file: string; why: string; old: string; text: string }[] = [
  { file: "C11", why: "the Mac in the rule of the MCP port's socket (board ab-v16.94.30)", old: "- The MCP port is off by default. The service opens it only when systemd passes it the socket of `agent-browser-mcp.socket` (the sd_listen_fds protocol), or in its `--test` mode with `--test-mcp-port <port>`: 0 (a free port that the kernel picks) or a port from 1024 to 65535, on `127.0.0.1`. It has no default port. As sd_listen_fds does, the service sets `FD_CLOEXEC` on each passed fd as soon as `LISTEN_PID` and `LISTEN_FDS` are its own, before it reads the names, and it removes `LISTEN_PID`, `LISTEN_FDS` and `LISTEN_FDNAMES` from its environment in every path: also in `--test` mode, where it takes no passed fd, and when only `LISTEN_FDNAMES` is set.", text: "- The MCP port is off by default. The service opens it only when systemd passes it the socket of `agent-browser-mcp.socket` (the sd_listen_fds protocol), on the Mac only when launchd gives it the socket of its job's `Sockets` entry `agent-browser-mcp` (below), or in its `--test` mode with `--test-mcp-port <port>`: 0 (a free port that the kernel picks) or a port from 1024 to 65535, on `127.0.0.1`. It has no default port. On Linux, as sd_listen_fds does, the service sets `FD_CLOEXEC` on each passed fd as soon as `LISTEN_PID` and `LISTEN_FDS` are its own, before it reads the names, and it removes `LISTEN_PID`, `LISTEN_FDS` and `LISTEN_FDNAMES` from its environment in every path: also in `--test` mode, where it takes no passed fd, and when only `LISTEN_FDNAMES` is set." },
  { file: "C11", why: "the Mac's socket from launchd: the key, one fd, FD_CLOEXEC at once, the free, the fail-closed rule (board ab-v16.94.30)", old: "", text: "- On the Mac launchd holds the port (board ab-v16.94.30; built, not run on a Mac yet). The service's launchd job (C12) has the `Sockets` entry `agent-browser-mcp`, a stream socket on `127.0.0.1` (IPv4) at the port, and the service takes its socket with `launch_activate_socket(\"agent-browser-mcp\")`, never in its `--test` mode. It sets `FD_CLOEXEC` on each fd that launchd gives at once (`ioctl` with `FIOCLEX`, then `fcntl` with `F_GETFD` reads the flag back), before it counts the fds, so no child (Chrome, a tool) keeps the port, and it frees launchd's array of fds in every path. It takes exactly one fd, a TCP listener on `127.0.0.1`, and listens on it as on Linux. When the job has no such entry (`ENOENT`), or launchd gives `ESRCH` (the job's plist has no `Sockets` key, or the service is no launchd job; the Mac check of board ab-v16.94.33), the service opens no MCP port, writes a log line, and `status` says `none` (C12). When launchd gives no fd or more than one, when the call fails in another way (`EALREADY`: the socket was taken already), or when the service cannot set `FD_CLOEXEC` on an fd, the service opens no MCP port, writes a log line, and `status` says `failed` (C12): fail closed." },
];
test("board ab-v16.94.30: C11 says the Mac's MCP socket from launchd exactly (the key, one fd, FD_CLOEXEC at once, the fail-closed rule), after the held port and before the Mac's port gate; the code's values", async () => {
  for (const e of MAC_MCP_SOCKET) {
    assert.ok(says(C11, e.text), `${e.file}, ${e.why}: ${e.text.slice(0, 120)}`);
    if (e.old && !flat(e.text).includes(flat(e.old))) assert.ok(!says(C11, e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
  const P = flat(partOr("The MCP path (from stage 1d; the operator's answer Q1 of board item ab-bi3, 2026-11-10)."));
  const at = (s: string) => P.indexOf(flat(s));
  const held = at("The units are the daemon lead's proposal, which stage 1d proves"), mac = at(MAC_MCP_SOCKET[1].text), gate = at("- The Mac's port gate is open: the Mac check measured");
  assert.ok(held >= 0 && mac > held && gate > mac, `the order: the held port, launchd's socket, the Mac's port gate (${held}, ${mac}, ${gate})`);
  const ls = await import("../src/service/mcp/launchd-socket.ts");
  assert.equal(ls.MCP_SOCKET_KEY, "agent-browser-mcp");
  assert.ok(says(C11, `\`launch_activate_socket("${ls.MCP_SOCKET_KEY}")\``) && says(C11, `\`Sockets\` entry \`${ls.MCP_SOCKET_KEY}\``));
  // Board ab-v16.94.32 opened the gate: the Mac check measured the reader (MAC_PORT_GATE, below).
  const proc = await import("../src/service/mcp/proc.ts");
  assert.equal(proc.MAC_TCP_READER_MEASURED, true);
});

// Board ab-v16.94.33: the Mac check B1.1 (2026-11-16): launchd gives ESRCH also to its own job when the job's plist has
// no Sockets key. C11's sentence, old then new, exactly; the old text is gone; the PR's body lists it for the daemon lead.
const MAC_ESRCH = {
  old: "When the job has no such entry (`ENOENT`), or the service is no launchd job (`ESRCH`), the service opens no MCP port, writes a log line, and `status` says `none` (C12).",
  text: "When the job has no such entry (`ENOENT`), or launchd gives `ESRCH` (the job's plist has no `Sockets` key, or the service is no launchd job; the Mac check of board ab-v16.94.33), the service opens no MCP port, writes a log line, and `status` says `none` (C12).",
};
test("board ab-v16.94.33: C11 says that ESRCH also comes for a launchd job with no Sockets key (the Mac check B1.1), exactly; the old text is gone", () => {
  assert.ok(says(C11, MAC_ESRCH.text), MAC_ESRCH.text.slice(0, 120));
  assert.ok(!says(C11, MAC_ESRCH.old), "the old text is gone");
});

// Board ab-v16.94.32: the Mac check measured the Mac's TCP peer reader (check group A: 40 of 40), so the Mac's port gate
// opens. Each changed text of C11's Mac port gate bullet, exactly, and the old text is gone; the PR's body lists them,
// old then new, for the daemon lead.
const MAC_PORT_GATE: { why: string; old: string; text: string }[] = [
  { why: "the gate is open: the Mac check measured the reader, with its numbers (board ab-v16.94.32)",
    old: "- On the Mac the port refuses every connection (fail closed) until the Mac check measures the Mac's TCP peer reader.",
    text: "- The Mac's port gate is open: the Mac check measured the Mac's TCP peer reader (board ab-v16.94.32), so on the Mac the port admits a connection by the same steps as on Linux (the admission, below). In the check's group A all 40 checks passed: the reader read the sockets (`tcp()`) in 4.6 ms (58 lines) and gave exactly one line for the socket of the check's child process, with the operator's uid and with the child's pid as its holder; the accepted socket has the reverse tuple and is held by the check's own process." },
  { why: "the service holds launchd's socket itself (board ab-v16.94.30), and only a test switch closes the gate",
    old: "Until then a launchd holder accepts and closes each connection.",
    text: "The service holds launchd's socket itself (board ab-v16.94.30, above) and runs steps 1 and 2 with this reader at each accept, before it reads any byte. Only a test switch still closes the gate: the port then accepts and closes each connection with no answer and no read, and `status` says `closed` (C12)." },
];
test("board ab-v16.94.32: C11's Mac port gate bullet says each new text exactly (the reader measured, launchd's socket in the service, the test switch), after launchd's socket and before the reader; no old text; the code's gate is open", async () => {
  assert.equal(MAC_PORT_GATE.length, 2);
  for (const e of MAC_PORT_GATE) {
    assert.ok(says(C11, e.text), `C11, ${e.why}: ${e.text.slice(0, 120)}`);
    assert.ok(!says(C11, e.old), `C11, ${e.why}: the old text is gone`);
  }
  const P = flat(partOr("The MCP path (from stage 1d; the operator's answer Q1 of board item ab-bi3, 2026-11-10)."));
  const at = (s: string) => P.indexOf(flat(s));
  const socket = at("- On the Mac launchd holds the port (board ab-v16.94.30;"), gate = at(MAC_PORT_GATE[0].text + " " + MAC_PORT_GATE[1].text), reader = at("The reader is built (board ab-v16.94.6): for steps 1 and 2");
  assert.ok(socket >= 0 && gate > socket && reader > gate, `the order: launchd's socket, the gate's texts in one run, the reader (${socket}, ${gate}, ${reader})`);
  const proc = await import("../src/service/mcp/proc.ts");
  assert.equal(proc.MAC_TCP_READER_MEASURED, true, "the code's gate is open");
  assert.deepEqual([proc.macPortClosed("darwin"), proc.macPortClosed("darwin", false), proc.macPortClosed("linux")], [false, true, false], "only the test switch closes it");
});

// Board ab-v16.94.7.4 (stage 5 T3; the plan docs/superpowers/plans/2026-11-16-stage-5-remote-scopes.md, task T3): the
// limits of a remote admission in the transport. Each new text of C11 and of the allow list's format, exactly; each old
// text that it replaced is gone. `plan: true` marks the plan's texts; the others are this task's own, and the PR's body
// lists them all, old then new, for the daemon lead's explicit OK. The code's constants follow the words.
const REMOTE_LIMITS: { file: string; why: string; plan: boolean; old: string; text: string }[] = [
  { file: "C11", plan: true, why: "the path rule: a remote admission names no file", old: "(a call with no path argument passes). - A folder in `browser_file_upload`'s `paths`", text: "(a call with no path argument passes). For a remote admission it refuses each such argument, wherever it points: -32602 `Not available in the agent browser: <key> names a file, and a session of another box cannot name a file of this box.` Tools that give their data inline work. - A folder in `browser_file_upload`'s `paths`" },
  { file: "C11", plan: true, why: "the transport: the answer limit of a remote admission", old: "HTTP 200 with no body. - At `session_ended` and at the close at a change", text: "HTTP 200 with no body. - For a remote admission an answer of more than 16777216 bytes (first value) is not sent: the call gets a tool error with `The answer is larger than the limit for a remote session; ask for a smaller part, for example one element's snapshot or a viewport screenshot.` - At `session_ended` and at the close at a change" },
  { file: "C11", plan: false, why: "the transport's other answers: the MCP's answer within the limit", old: "which the transport passes on with HTTP 200 (for `tools/list`, with only the list's tools and keys).", text: "which the transport passes on with HTTP 200 (for `tools/list`, with only the list's tools and keys; for a remote admission, a `tools/call` answer within the limit above, or else its tool error)." },
  { file: "C11", plan: true, why: "the remote scope's folder", old: "The service's own stop removes no folder. - The MCP's Playwright connects back", text: "The service's own stop removes no folder. A remote scope's folder is `<state>/mcp-remote/<box>/<session>/`. No tool of a remote scope reads it. It goes at the scope's end, as a local scope's folder goes." },
  // Board ab-v16.94.7.8: the sentence of Chrome's own copy is that task's now (before: it ended "as before: the service removes no file there, and only the remote scope's copy in its folder goes at the scope's end.").
  { file: "C11", plan: false, why: "the remote scope's folder: its mode, its refusals, its removal and the MCP's output folder", old: "", text: "as a local scope's folder goes. The service makes `<state>/mcp-remote`, the box's folder and the remote scope's folder, each with mode 0700, at the scope's first MCP session, and the MCP's output folder (its copies of downloads and the other files that it writes) is the remote scope's folder. Chrome keeps its own copy of each download in the agent profile's downloads folder (on Linux a folder `Downloads` in the state folder), as before. For a download of a remote scope's page the service removes that copy (board ab-v16.94.7.8) at the end of its handling of the download: after Chrome reports the download complete (`Page.downloadProgress`) and its item complete (`downloads.search` by the item's id), and before the client hears the end. It takes only the item that Chrome's `downloads.onCreated` tied to the download by the item's `finalUrl` (the URL after the redirects), and only when that item's `finalUrl` is the download's URL and the item started at most 10 s (first value) before the service got `Page.downloadWillBegin`. It removes nothing with no such item (also when none is complete within the wait), for an incognito item, an item of the act or an item that another download holds, when a download of another scope had the same URL while it ran, and when Chrome has another item whose `finalUrl` or `url` is the download's URL and that started at most 10 s before `Page.downloadWillBegin` or later (also a download of a tab with no client), or that search fails (board ab-v16.94.7.10). It removes the file only while the downloads folder is a folder of the service's user that is no link, the path's folder after `realpath` is that folder or a folder in it, and the path is a regular file that is no link. A refusal and a failed removal get a log line with the scope and the reason or the error's code, never a path; a failed removal changes nothing that the client hears. A local scope's download stays there. Any copy in the remote scope's folder goes at the scope's end, as before. When one of the three is a link or no folder of the service's user, or on the Mac when a folder's name differs from the box or the session only in case, the `initialize` gets the 503 of an MCP session that the service cannot make, and so does a scope that is neither a scope nor a remote scope. At the scope's end the service removes the remote scope's folder only while `<state>/mcp-remote` and the box's folder are folders of the service's user that are no links, and then the box's folder when it is empty. - The MCP's Playwright connects back" },
  { file: "C11", plan: false, why: "the limit of 16 remote MCP sessions (the daemon lead's form of PR #194's fix round: no eviction; a remote initialize at either limit gets HTTP 200)", old: "does one more `initialize` get the 503 of the scope's limit. - Its configuration is fixed:", text: "does one more `initialize` get the 503 of the scope's limit. At most 16 of the service's 32 MCP sessions are remote (first value): MCP sessions whose `initialize` had a remote admission. One more `initialize` of a remote admission, at that limit or at the service's limit, gets HTTP 200 (not 503) with the JSON-RPC error `-32000` and the text `The agent browser has no free place for an MCP session of another box now: it serves at most 16 MCP sessions of other boxes, and at most 32 in all. Initialize again later.` A local initialize at the service's limit gets the 503 of the service's limit, as before. At a remote scope's own limit its MCP sessions give their place as a local scope's do. A scope with a `/` always has the remote admission. - Its configuration is fixed:" },
  { file: "C11", plan: false, why: "the transport's table: the old 503 row of the service's limit unchanged, and the new row of a remote admission (HTTP 200)", old: "| One more `initialize` at the service's limit | 503 | `-32000` | `The agent browser serves at most 32 MCP sessions, and each is in use. Initialize again later.` | | An `initialize` whose MCP session the service cannot make |", text: "| One more `initialize` at the service's limit | 503 | `-32000` | `The agent browser serves at most 32 MCP sessions, and each is in use. Initialize again later.` | | One more `initialize` of a remote admission at the limit of 16 remote MCP sessions or at the service's limit | 200 | `-32000` | `The agent browser has no free place for an MCP session of another box now: it serves at most 16 MCP sessions of other boxes, and at most 32 in all. Initialize again later.` |" },
  { file: "ALLOWP", plan: false, why: "the format: the path argument of a remote admission", old: "`Not available in the agent browser: <key> must name a file in the session's folder <folder>`. - `tools/call` of a tool of `service_tools`", text: "`Not available in the agent browser: <key> must name a file in the session's folder <folder>`. For a request that a remote token admitted, the service refuses each such argument, wherever it points, with the JSON-RPC error `-32602` and the message `Not available in the agent browser: <key> names a file, and a session of another box cannot name a file of this box.`; a call with no such argument passes. - `tools/call` of a tool of `service_tools`" },
];
test("board ab-v16.94.7.4: C11 and the allow list's format say the limits of a remote admission exactly (the plan's three texts and this task's own), each old text is gone, and the code's constants are the texts' values", async () => {
  const files: Record<string, string> = { C11, ALLOWP };
  for (const e of REMOTE_LIMITS) {
    assert.ok(says(files[e.file], e.text), `${e.file}, ${e.why}: ${e.text.slice(0, 160)}`);
    if (e.old) assert.ok(!says(files[e.file], e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
  assert.equal(REMOTE_LIMITS.filter((e) => e.plan).length, 3, "the plan's three texts of T3");
  // The fix round of PR #194 (the daemon lead's decision): no eviction, so C11 says nothing of a local place taken.
  assert.ok(!says(C11, "A local session is not refused because of remote sessions") && !says(C11, "of a local admission at the service's limit, when no remote MCP session can give its place"), "the eviction's texts are gone");
  const al = await import("../src/service/mcp/allow-list.ts") as any;
  const tr = await import("../src/service/mcp/transport.ts") as any;
  assert.ok(says(C11, `-32602 \`${al.refuseRemotePath?.("<key>")?.message}\``), "the code's refusal is C11's text");
  assert.ok(says(ALLOWP, `\`${al.refuseRemotePath?.("<key>")?.message}\``), "the code's refusal is the format's text");
  assert.ok(says(C11, `an answer of more than ${tr.MCP_REMOTE_ANSWER_MAX} bytes (first value)`) && tr.MCP_REMOTE_ANSWER_MAX === 16 * 1024 * 1024, "16 MiB");
  assert.ok(says(C11, `a tool error with \`${tr.MCP_REMOTE_TOO_LARGE}\``), "the code's tool error is C11's text");
  assert.ok(says(C11, `At most ${tr.MCP_REMOTE_SESSIONS} of the service's ${tr.MCP_SESSIONS_PER_SERVICE} MCP sessions are remote (first value)`) && tr.MCP_REMOTE_SESSIONS === 16, "16 of the 32");
  assert.deepEqual(tr.MCP_ANSWERS.perRemote, { status: 200, code: -32000, text: "The agent browser has no free place for an MCP session of another box now: it serves at most 16 MCP sessions of other boxes, and at most 32 in all. Initialize again later." });
  assert.equal(tr.scopeFolder?.("/s", "box/s1"), "/s/mcp-remote/box/s1/", "the remote scope's folder");
  assert.equal(tr.scopeFolder?.("/s", "web-1"), "/s/mcp/web-1/", "a local scope's folder stays");
});

// Board ab-v16.94.7.1 (stage 5 T1; the plan docs/superpowers/plans/2026-11-16-stage-5-remote-scopes.md, task T1): C11's
// remote scope, `<box>/<session>`. The scope's bullet gets two sentences, exactly; the old text, with no remote scope
// after it, is gone; the PR's body lists it for the daemon lead's explicit OK. The code's pattern follows the words.
const REMOTE_SCOPE_TEXT = {
  old: "- A scope matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Every agentwatch session name matches it. agentwatch picks each session's scope at its launch",
  text: "- A scope matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Every agentwatch session name matches it. A remote scope (stage 5) is `<box>/<session>`: two names of that pattern with one `/`. A local scope has no `/`, so the two never meet. agentwatch picks each session's scope at its launch",
};
test("board ab-v16.94.7.1: C11 says the remote scope <box>/<session> exactly, the old text is gone, and the code's REMOTE_SCOPE is two names of the scope pattern with one /", async () => {
  assert.ok(says(C11, REMOTE_SCOPE_TEXT.text), REMOTE_SCOPE_TEXT.text.slice(0, 160));
  assert.ok(!says(C11, REMOTE_SCOPE_TEXT.old), "the old text is gone");
  const code = await import("../src/relay/scopes.ts") as unknown as { REMOTE_SCOPE: RegExp; SCOPE: RegExp; isAnyScope: (x: unknown) => boolean };
  assert.equal(code.SCOPE.source, endpoint.scope.pattern, "SCOPE stays C11's local pattern");
  const name = endpoint.scope.pattern.slice(1, -1);
  assert.equal(code.REMOTE_SCOPE.source, `^${name}\\/${name}$`, "two names of the scope pattern with one /");
  for (const s of ["linux/web-1", "a/b"]) assert.ok(code.REMOTE_SCOPE.test(s) && !SCOPE.test(s) && code.isAnyScope(s), s);
  for (const s of ["web-1"]) assert.ok(!code.REMOTE_SCOPE.test(s) && SCOPE.test(s) && code.isAnyScope(s), s);
  for (const s of ["a/b/c", "/b", "a/", "a//b"]) assert.ok(!code.REMOTE_SCOPE.test(s) && !code.isAnyScope(s), s);
});

// Board ab-v16.94.7.3 (stage 5 T2; the plan docs/superpowers/plans/2026-11-16-stage-5-remote-scopes.md, task T2): the
// remote scope has no CDP path but the MCP's own ticket connection, and its list is its item's. The two texts of the
// plan, exactly; the order of the checks says where the new 403 comes (steps 3 and 6). The PR's body lists each new text
// for the daemon lead's explicit OK. The vectors: the new upgradeChecks lines and remoteChecks.
const REMOTE_T2 = {
  cdp: "- A remote scope has no CDP path. A request for `/devtools/browser/<box>/<session>` gets 403 `A session of another box reaches this agent browser only through its MCP.`, except the MCP's own connection with its ticket (the MCP inside the service).",
  list: "A remote scope's list is the list that its item names, never a repo's list.",
  // C4's rule (chrome-extension C1, the receiver's fail-closed change), which the relay matches.
  noDefault: "A remote scope that `scopes` does not name has no list: `default` applies only to a local scope.",
  step3: "Then a remote scope gets its 403 (the scope, and one connection per tab, below) at once, also while the relay is not ready, unless the peer is the service's own pid (a relay with no MCP inside the service has no such pid); without the peer check, every request of a remote scope gets it after step 2.",
  step6: "For a remote scope only the service's own pid comes here, and it passes only with a live ticket of the scope; with no such ticket it gets the remote scope's 403.",
};
test("board ab-v16.94.7.3: C11 says T2's texts exactly: the remote scope's 403 and the MCP's own ticket connection, its item's list, and the 403's place in the order of the checks; the code's text is the vector's", async () => {
  assert.ok(says(part(C11, "The scope, and one connection per tab."), REMOTE_T2.cdp), REMOTE_T2.cdp);
  assert.ok(says(part(C11, "The scope's list (board ab-v16.23)."), REMOTE_T2.list), REMOTE_T2.list);
  assert.ok(says(part(C11, "The scope's list (board ab-v16.23)."), REMOTE_T2.noDefault), REMOTE_T2.noDefault);
  assert.equal(applySetScopes({ lists: { md: [] }, scopes: {}, default: "md" }).listOf("box1/web-9"), null, "the reference: no default for a remote scope");
  const before = part(C11, "Before the upgrade.");
  assert.ok(says(before, REMOTE_T2.step3), REMOTE_T2.step3);
  assert.ok(says(before, REMOTE_T2.step6), REMOTE_T2.step6);
  const code = await import("../src/relay/endpoint.ts") as unknown as { REMOTE_ONLY_MCP: string };
  assert.equal(code.REMOTE_ONLY_MCP, "A session of another box reaches this agent browser only through its MCP.");
  assert.deepEqual(answerById.remote, { id: "remote", status: 403, body: code.REMOTE_ONLY_MCP });
});

test("board ab-v16.94.7.3: each remoteChecks vector (the relay inside the service, with the MCP's tickets) gets the answer of C11's order", () => {
  assert.ok(endpoint.remoteChecks.length >= 12);
  const seen = new Set();
  for (const c of endpoint.remoteChecks) {
    assert.ok(c.peerCheck && c.service && Number.isInteger(c.service.pid), `${c.note}: the service runs the peer check`);
    const want = wantOf(c);
    assert.equal(admit(c), want, c.note);
    seen.add(want);
  }
  for (const id of [101, "remote", "session", "noList", "notConnected", "fromPage", "cannotRead", "notFound"]) assert.ok(seen.has(id), `a remoteChecks vector for ${id}`);
  // The relay's line names a remote scope's roots too: no rule takes them (a remote scope has no roots).
  assert.deepEqual(Object.keys(applyLine(endpoint.lines.remote, true, true).roots), ["md-lead"]);
});

// Board ab-v16.94.7.7 (stage 5): the service pins the receiver 0.3.10 (chrome-extension 3d0a54a, PR #48: the receiver
// takes a remote scope <box>/<session>), and the model's daemon.blocked takes a remote scope (C10's vector bl44). The
// texts that the pin move changes, old then new, each exactly; the old text is gone. The PR's body lists each new text
// for the daemon lead's explicit OK. The pin of 0.3.11 (board ab-v16.100, PIN_0311) changed the first two texts again,
// and the pin of 0.3.13 (board ab-v16.112, PIN_0313) once more, the pin of the sender 0.2.1 (board ab-b84.44,
// PIN_SENDER_021) changed C12's text once more, and the pins of 0.3.14 (board ab-v16.115, PIN_0314), 0.3.15 (board
// ab-sta.4, PIN_0315) and 0.3.16 (board ab-4wh.2, PIN_0316) changed both once more each: C11 and C12 say them as those
// lists changed them.
const PIN_0310: { file: "C11" | "C12"; why: string; old: string; text: string }[] = [
  { file: "C11", why: "the release item names the service's pin",
    old: "The service pins that release or a later one, the receiver 0.3.9 (board ab-v16.97.10, ab-v16.102; C12, the agent package)",
    text: "The service pins that release or a later one, the receiver 0.3.10 (board ab-v16.97.10, ab-v16.102, ab-v16.94.7.7; C12, the agent package)" },
  { file: "C12", why: "the sender of the pinned commit",
    old: "`sender` gives the sender of the chrome-extension commit that agent-browser pins (`8ef807a`, C1).",
    text: "`sender` gives the sender of the chrome-extension commit that agent-browser pins (`3d0a54a`, C1)." },
  { file: "C11", why: "daemon.blocked's scope: a local or a remote scope", old: "(new words after the navigation refusal's daemon.blocked)",
    text: "Its `scope` is the tab's scope: a local scope, or a remote scope `<box>/<session>` (board ab-v16.94.7.7; C10's vector `bl44`, since the receiver 0.3.10 of chrome-extension `3d0a54a`). The relay and the service's native link take both; a scope of neither pattern gets `bad args` (`bl37`)." },
];
test("board ab-v16.94.7.7: C11 and C12 name the pin of the receiver 0.3.10 (as the pins of 0.3.11, 0.3.13, the sender 0.2.1, 0.3.14, 0.3.15 and 0.3.16 changed it) and say daemon.blocked's remote scope exactly; each old text is gone; the values are the code's and the vectors'", async () => {
  const { AGENT_VERSION, CHROME_EXTENSION_COMMIT } = await import("../src/service/package/pins.ts");
  assert.deepEqual([AGENT_VERSION, CHROME_EXTENSION_COMMIT.slice(0, 7)], ["0.3.16", "4a4eb50"], "the pin of 0.3.16 is the later pin");
  const later = (s: string) => { let x = flat(s); for (const f of [...PIN_0311, ...PIN_0313, ...PIN_SENDER_021, ...PIN_0314, ...PIN_0315, ...PIN_0316]) if (x.includes(flat(f.old))) x = x.replace(flat(f.old), flat(f.text)); return x; };
  for (const e of PIN_0310) {
    const doc = e.file === "C11" ? C11 : C12P;
    assert.ok(says(doc, e.text) || (later(e.text) !== flat(e.text) && says(doc, later(e.text))), `${e.file}, ${e.why}: ${e.text.slice(0, 120)}`);
    if (!e.old.startsWith("(new words")) assert.ok(!says(doc, e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
  assert.ok(says(C11, "The navigation refusal reports `daemon.blocked` (C10, the daemon's own ops). Only an `ok` answer lets the relay name the Browser permission prompt in its refusal; otherwise it keeps the text in the row. " + PIN_0310[2].text), "the new words follow the navigation refusal's daemon.blocked");
  // The vectors that the text names: bl44 (a remote scope: ok) and bl37 (two slashes: bad args), in the copy at 4a4eb50 (since 3d0a54a).
  const v = (id: string) => blockedReport(must(bridge.blockedVectors.find((x) => x.req.id === id), id), id);
  assert.deepEqual([REMOTE.test(v("bl44").req.args[0].scope), v("bl44").res.ok], [true, true]);
  assert.deepEqual([v("bl37").req.args[0].scope, v("bl37").res.error], ["scope/a/b", "bad args"]);
  const { blockedArgsFit } = await import("../src/relay/policy.ts");
  assert.equal(blockedArgsFit(v("bl44").req.args), true, "the model sends bl44's report");
  assert.equal(blockedArgsFit(v("bl37").req.args), false, "the model never sends bl37's");
});

// Board ab-v16.94.7.5 (stage 5 T4; the plan docs/superpowers/plans/2026-11-16-stage-5-remote-scopes.md, task T4): the
// carrier and the remote admission on the agent door. Each new or changed text of C11, exactly; each old text that it
// replaced is gone. `plan: true` marks the plan's texts (its two changed lines, the new part's A1, A2, checks 1 to 4 and
// the first 401); the others are this task's own (the brief's notes N1 and the download, the 403's place, the test flag),
// and the PR's body lists them all, old then new, for the daemon lead's explicit OK. The code's texts follow the words.
const T4_C11: { why: string; plan: boolean; old: string; text: string }[] = [
  { plan: true, why: "the MCP path on the endpoint's Unix socket",
    old: "a request for `/mcp` there gets the 404 of step 2, as today. - The port stays held",
    text: "- On the endpoint's Unix socket the MCP path serves no local session: a request for `/mcp` there gets the 404 of step 2, as today. From stage 5 it serves the carrier, for a remote scope only (the remote MCP path, below)." },
  { plan: true, why: "the admission of each request: no remote token on the port",
    old: "Until stage 5 the port admits no request by a remote token.",
    text: "The MCP port admits no request by a remote token: a remote request comes only through the carrier (the remote MCP path), which gives the word `remote`." },
  { plan: true, why: "the new part: its head", old: "",
    text: "**The remote MCP path (stage 5; board ab-v16.94.7.5; the plan `docs/superpowers/plans/2026-11-16-stage-5-remote-scopes.md`, A1, A2, Q1, Q2 and task T4).** A session of another box reaches this box's agent browser only through the carrier, and only for its remote scope `<box>/<session>`." },
  { plan: true, why: "the new part: A1 with Q1 and Q2 (the carrier is the gateway; its headers)", old: "",
    text: "- The carrier is the Mac's gateway (A1), not the daemon and not the MCP port. The gateway is a plain HTTP reverse proxy onto the agent door's Unix socket: streaming, the body unread, no redirect followed. It forwards the method, the path `/mcp/<box>/<session>`, `Authorization`, `Mcp-Session-Id`, `Content-Type` and the body's framing, and it sends `Host: localhost`. It drops each other header of the client (no `Cookie`, no `Origin`, no `CF-*`, no `X-Forwarded-*`, no `Accept`, no `MCP-Protocol-Version`). It gives back the status, `Content-Type`, `Mcp-Session-Id`, `WWW-Authenticate` and the body, streamed. The path is the only claim: the gateway's address check tied its box to the caller's address." },
  { plan: true, why: "the new part: A2 (the peer decides; the carrier rule)", old: "",
    text: "- The peer decides remote or local, never the request (A2). At each accept the agent door reads the peer. The carrier is the gateway's launchd job's pid (`LOCAL_PEERTOKEN`), or its direct child with the gateway's command line: the control door's rules 1 to 4 (C12, \"Who connects\"), with the gateway's job in place of agentwatch's unit and the file of `--gateway-command` in place of the daemon's expected command (C12, the command of stage 5)." },
  { plan: false, why: "the new part: the carrier rule's own refusal texts, and a refused peer stays local", old: "",
    text: "The rule has its own refusal texts: `The agent door cannot read the pid of the gateway's job, so it has no carrier.`, `The agent door's carrier is only the gateway's process: rule <n> failed (<reason>).` and `The agent door cannot read the program that connects (<reason>), so it has no carrier.` A peer that the rule refuses is no carrier: it stays local, and the text goes only to the log, for a request of that peer on the MCP path. Every other peer is local and needs the walk, as before. The carrier never gets a local scope." },
  { plan: true, why: "the new part: the switch, off by default", old: "",
    text: "- The switch is off by default: with no `--gateway-label` the agent door has no carrier, the hello has no `remote_scopes`, and nothing changes (C12). The label names a launchd job, so on Linux the switch gives no carrier: a Linux serving box (the gateway's systemd MainPID) comes later. The rule also needs the peer reader (on Linux with `SO_PEERPIDFD`, and `pidfd_open`; on the Mac its process reads) and the MCP path; without them the agent door has no carrier (fail closed), and a log line says why." },
  // Board ab-v16.94.7.9 (note 4 of the review of #196): check 2's Host 403 is the remote path's own text (before:
  // "exactly one `Host` header, `localhost` (the 403 of step 4).").
  { plan: true, why: "the new part: checks 1 to 4 at each request (with the daemon lead's 405)", old: "",
    text: "- One carrier connection carries the requests of many sessions, so these checks run at each request, in this order. The first check that fails gives its answer, and the connection then closes: 1. The method and the path. `POST` or `DELETE` to `/mcp/<box>/<session>` with a remote scope of the pattern goes on. A request with another method (a `GET`, for example) for a remote scope of the last `set_sessions` gets the transport's 405, as a local request does, and its connection stays open: a 404 on a request with `Mcp-Session-Id` reads to a client as an expired session. Each other request gets the 404 of step 5: `/mcp` alone, a local scope, a path with more parts, and a request with another method for a remote scope that the last `set_sessions` does not list. 2. No `Origin` header (the 403 of step 3), and exactly one `Host` header, `localhost`. No `Host` header, two `Host` header lines or more, or any other `Host` gets this path's own 403: `The agent browser's remote MCP path admits only the Host localhost.` 3. The token. The scope is a remote item of the last `set_sessions`, and the SHA-256 of the bearer equals that item's `mcp_token` in constant time (two 32-byte digests), as in step 7. No bearer gets the first 401 of this path: `The agent browser of this box needs the session's remote connection token. agentwatch adds it to each session that it launches while its box has the browser grant.` A scope that the last `set_sessions` does not list, and a token that is not the item's, get the third 401 of step 7. Each 401 has the `WWW-Authenticate` header of step 7. 4. The readiness: the 503s of step 8, with the service's start at a use, as for a local request." },
  { plan: true, why: "the new part: the word remote", old: "",
    text: "- A request that passes goes to the transport with the word `remote`, so the limits of a remote admission apply (the MCP inside the service, and the transport of the MCP path, below)." },
  { plan: true, why: "the new part: the carrier gets nothing else; every other peer stays local", old: "",
    text: "- The carrier gets nothing else. Its CDP upgrade gets a 403 (before the upgrade, above): `A session of another box reaches this agent browser only through its MCP.` for a remote scope, and the session's 403 for a local scope. Its MCP request for a local scope gets the 404 of check 1. A peer that is not the carrier keeps each answer of this file: a request on the agent door that is no upgrade, also for `/mcp/<box>/<session>`, gets the endpoint's 404." },
  { plan: true, why: "the new part: a dropped item or a changed token (with N4 on the Mac)", old: "",
    text: "- A `set_sessions` that drops a remote item, or changes its `mcp_token`, ends that scope's MCP sessions, and the next request with the old token gets the third 401. On the Mac the end of a remote name whose case twin lives (C12, `set_sessions`) ends that name's MCP sessions too, and it removes no folder." },
  { plan: false, why: "the new part: the log rule", old: "",
    text: "- The log rule of the MCP path holds: a log line names the request's number, the scope of a remote item, the method, the check and the status; never a token, a fingerprint, a URL path or a header." },
  { plan: false, why: "the new part: the live check's test flag (the brief's change to the plan: no unit)", old: "",
    text: "- The live check on the Linux server: in `--test` mode only, `--test-gateway-pid <pid>` takes the place of `--gateway-label`, and the rule reads that pid as the gateway job's pid. The harness starts its fake gateway as its own child process. agentwatch never passes the flag (C12)." },
  { plan: false, why: "before the upgrade: the carrier's 403 in the order of the checks",
    old: "2. A path or scope that does not match: the 404. 3. With the peer check",
    text: "2. A path or scope that does not match: the 404. Then the carrier of the remote MCP path (from stage 5; below) gets a 403 at once: the remote scope's 403 for a remote scope, and the session's 403 with the carrier's pid for a local scope." },
  { plan: false, why: "N1 of T2's review: the ticket's two sentences for a local scope, and the remote answers of steps 3 and 6",
    old: "with no such ticket it gets the session's 403. A ticket from any other pid admits nothing, and that connection gets the walk.",
    text: "its scope, and no root admits it; for a local scope, with no such ticket it gets the session's 403. A ticket from any other pid admits nothing, and for a local scope that connection gets the walk. For a remote scope, the service's own pid with no such ticket gets the remote scope's 403 at step 6, and a connection from any other pid gets that 403 right after step 3, with no walk." },
  // Board ab-v16.94.7.8: the service removes Chrome's own copy of a remote download; this entry has that task's sentence.
  { plan: false, why: "T3's open point: Chrome's own copy of a download",
    old: "is the remote scope's folder. When one of the three",
    text: "is the remote scope's folder. Chrome keeps its own copy of each download in the agent profile's downloads folder (on Linux a folder `Downloads` in the state folder), as before. For a download of a remote scope's page the service removes that copy (board ab-v16.94.7.8) at the end of its handling of the download: after Chrome reports the download complete (`Page.downloadProgress`) and its item complete (`downloads.search` by the item's id), and before the client hears the end. It takes only the item that Chrome's `downloads.onCreated` tied to the download by the item's `finalUrl` (the URL after the redirects), and only when that item's `finalUrl` is the download's URL and the item started at most 10 s (first value) before the service got `Page.downloadWillBegin`. It removes nothing with no such item (also when none is complete within the wait), for an incognito item, an item of the act or an item that another download holds, when a download of another scope had the same URL while it ran, and when Chrome has another item whose `finalUrl` or `url` is the download's URL and that started at most 10 s before `Page.downloadWillBegin` or later (also a download of a tab with no client), or that search fails (board ab-v16.94.7.10). It removes the file only while the downloads folder is a folder of the service's user that is no link, the path's folder after `realpath` is that folder or a folder in it, and the path is a regular file that is no link. A refusal and a failed removal get a log line with the scope and the reason or the error's code, never a path; a failed removal changes nothing that the client hears. A local scope's download stays there. Any copy in the remote scope's folder goes at the scope's end, as before." },
];
test("board ab-v16.94.7.5: C11 says T4's texts exactly (the plan's and this task's own), each old text is gone, the new part comes before the MCP inside the service, and the code's texts are C11's", async () => {
  for (const e of T4_C11) {
    assert.ok(says(C11, e.text), `C11, ${e.why}: ${e.text.slice(0, 160)}`);
    if (e.old) assert.ok(!says(C11, e.old), `C11, ${e.why}: the old text is gone`);
  }
  const remote = part(C11, "The remote MCP path (stage 5;");
  for (const e of T4_C11.filter((x) => x.why.startsWith("the new part"))) assert.ok(says(remote, e.text), `in the new part: ${e.why}`);
  assert.ok(C11.indexOf("**The remote MCP path (stage 5;") < C11.indexOf("**The MCP inside the service (from stage 1d;"), "the new part comes before the MCP inside the service");
  assert.ok(C11.indexOf("**The limits of the MCP path's admission") < C11.indexOf("**The remote MCP path (stage 5;"), "after the limits of the MCP path's admission");
  const R = await import("../src/service/mcp/remote.ts");
  const A = await import("../src/service/admission.ts");
  const M = await import("../src/service/mcp/admission.ts");
  const E = await import("../src/relay/endpoint.ts");
  assert.ok(says(remote, `\`${R.REMOTE_TEXT.needsToken}\``), "the first 401 is the code's");
  assert.ok(says(remote, `\`${A.CARRIER_NO_PID}\``), "the rule's text of no pid");
  assert.ok(says(remote, `\`${A.carrierRefused(1, "<reason>").replace("rule 1", "rule <n>")}\``), "the rule's refused text");
  assert.ok(says(remote, `\`${A.carrierCannotRead("<reason>")}\``), "the rule's cannot-read text");
  assert.ok(says(remote, `\`${E.REMOTE_ONLY_MCP}\``), "T2's 403");
  assert.equal(M.MCP_TEXT.unknownToken, "The agent browser does not know this connection token for this session.", "the third 401 of step 7");
});

// Board ab-v16.94.7.9 (stage 5: the text slips of T4's review; note 4 of the review of #196): only `Host: localhost`
// passes check 2 of the remote MCP path, so its Host 403 is its own text, not the MCP port's (which names 127.0.0.1:<port>
// and localhost:<port>). The new text exactly; the old text is gone; the code gives C11's text.
const S5_TEXTFIX_C11 = {
  old: "exactly one `Host` header, `localhost` (the 403 of step 4).",
  text: "2. No `Origin` header (the 403 of step 3), and exactly one `Host` header, `localhost`. No `Host` header, two `Host` header lines or more, or any other `Host` gets this path's own 403: `The agent browser's remote MCP path admits only the Host localhost.`",
};
test("board ab-v16.94.7.9: C11's remote MCP path has its own Host 403 (only localhost passes there), the old 'the 403 of step 4' is gone, and the code gives that text at check 2", async () => {
  const remote = part(C11, "The remote MCP path (stage 5;");
  assert.ok(says(remote, S5_TEXTFIX_C11.text), "check 2 of the remote MCP path names its own 403");
  assert.ok(!says(C11, S5_TEXTFIX_C11.old), "the old text is gone");
  const R = await import("../src/service/mcp/remote.ts");
  const M = await import("../src/service/mcp/admission.ts");
  assert.equal(R.REMOTE_TEXT.badHost, "The agent browser's remote MCP path admits only the Host localhost.", "the code's text");
  assert.ok(says(remote, `\`${R.REMOTE_TEXT.badHost}\``), "C11 quotes the code's text");
  assert.notEqual(R.REMOTE_TEXT.badHost, M.MCP_TEXT.badHost, "not the MCP port's text");
  const items = new Map([["box1/web-9", "0".repeat(64)]]);
  const readiness = () => ({ controlOff: false, notReady: null, sites: null });
  for (const host of [[], ["localhost", "localhost"], ["localhost:80"], ["127.0.0.1"], ["127.0.0.1:9223"], ["LOCALHOST"]]) {
    const req = { method: "POST", url: "/mcp/box1/web-9", rawHeaders: host.flatMap((h) => ["Host", h]) };
    assert.deepEqual(R.admitRemote({ req, items, readiness }), { step: 2, status: 403, body: R.REMOTE_TEXT.badHost }, `Host ${JSON.stringify(host)}`);
  }
});

// Board ab-v16.100: the service pins the receiver 0.3.11 (chrome-extension 9fd239f, PR #49). Its floor has rule 89, the
// initiator rule (C5): C11 and C12 say each text of PIN_0311 exactly, or as the pin of 0.3.13 (board ab-v16.112,
// PIN_0313), the pin of the sender 0.2.1 (board ab-b84.44, PIN_SENDER_021), the pin of 0.3.14 (board ab-v16.115,
// PIN_0314), the pin of 0.3.15 (board ab-sta.4, PIN_0315) and the pin of 0.3.16 (board ab-4wh.2, PIN_0316) changed
// it, and each old text is gone. The frame text stands in the item of what the guard cannot stop, in its place, and the
// copy of C10's floor vectors (at 4a4eb50, the same as at 9962e11, a25bfa8, d0a3d49, 8819e7e and 9fd239f) has rule 89
// as the text says it.
test("board ab-v16.100: C11 and C12 name the pin of the receiver 0.3.11 (as the pins of 0.3.13, the sender 0.2.1, 0.3.14, 0.3.15 and 0.3.16 changed it) and say what the floor's rule 89 stops and what stays out, exactly; each old text is gone; the values are the code's and the vectors'", async () => {
  const { AGENT_VERSION, CHROME_EXTENSION_COMMIT } = await import("../src/service/package/pins.ts");
  assert.deepEqual([AGENT_VERSION, CHROME_EXTENSION_COMMIT.slice(0, 7)], ["0.3.16", "4a4eb50"], "the pin of 0.3.16 is the later pin");
  assert.equal(PIN_0311.length, 3);
  const later = (s: string) => { let x = flat(s); for (const f of [...PIN_0313, ...PIN_SENDER_021, ...PIN_0314, ...PIN_0315, ...PIN_0316]) if (x.includes(flat(f.old))) x = x.replace(flat(f.old), flat(f.text)); return x; };
  for (const e of PIN_0311) {
    const doc = e.file === "C11" ? C11 : C12P;
    assert.ok(says(doc, e.text) || (later(e.text) !== flat(e.text) && says(doc, later(e.text))), `${e.file}, ${e.why}: ${e.text.slice(0, 120)}`);
    assert.ok(!says(doc, e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
  const p = flat(partOr(MERGE_GUARD_HEADING));
  assert.ok(p.includes("or a bypass that has not answered in the arm's limit); " + flat(PIN_0311[2].text) + " a write of a tab with no client while the receiver has no floor;"), "the frame text is in its place in the item of what the guard cannot stop");
  assert.ok(!p.includes("closes it;"), "no later task closes the frame of another site: rule 89 is in the pinned receiver");
  // Rule 89 in the copy of C10's floor vectors (C5's merge guard's floor, at 4a4eb50; the same as at 9962e11, a25bfa8, d0a3d49, 8819e7e and 9fd239f), as the text says it.
  const F = bridge.floor;
  const r89 = must(F.rules.find((r) => r.id === 89), "rule 89");
  assert.deepEqual(r89.action, { type: "block" });
  assert.deepEqual(r89.condition.requestDomains, F.state.hosts, "a write to a guarded host");
  assert.deepEqual(r89.condition.excludedInitiatorDomains, F.state.hosts, "from a page or a frame of another host");
  assert.deepEqual(r89.condition.excludedResourceTypes, ["main_frame"], "not a top-level request");
  assert.deepEqual(r89.condition.excludedRequestMethods, ["get", "head", "options"], "a write");
  assert.deepEqual(r89.condition.excludedTabIds, [...F.state.marked, ...F.state.act], "every tab except the operator's marked tabs and the act tabs");
  const under = (u: string | null) => u !== null && F.state.hosts.some((h: string) => { const n = new URL(u).hostname; return n === h || n.endsWith("." + h); });
  const write = (r: (typeof F.cases)[number]["request"]) => !["get", "head", "options"].includes(r.method) && under(r.url) && r.type !== "main_frame";
  const inGuarded = F.cases.filter((c) => F.state.guarded.includes(c.request.tabId) && write(c.request));
  const foreign = inGuarded.filter((c) => !under(c.request.initiator)), own = inGuarded.filter((c) => under(c.request.initiator));
  assert.ok(foreign.length >= 4 && own.length >= 2, "the vectors hold both kinds in a guarded tab");
  for (const c of foreign) assert.deepEqual(c.blockedBy, [89], `a guarded tab, another host's write is blocked: ${c.note}`);
  for (const c of own) assert.deepEqual(c.blockedBy, [], `a guarded tab, a guarded host's own write passes rule 89: ${c.note}`);
  const kept = F.cases.filter((c) => [...F.state.marked, ...F.state.act].includes(c.request.tabId));
  assert.ok(kept.length >= 3 && kept.every((c) => c.blockedBy.length === 0), "the operator's marked tabs and the act tabs: rule 89 blocks nothing");
});

// Board ab-v16.112: the service pins the receiver 0.3.13 (chrome-extension 8819e7e, PR #51; with 0.3.12 of PR #50). C11
// and C12 say each text of PIN_0313 exactly, or as the pin of the sender 0.2.1 (board ab-b84.44, PIN_SENDER_021), the
// pin of 0.3.14 (board ab-v16.115, PIN_0314), the pin of 0.3.15 (board ab-sta.4, PIN_0315) and the pin of 0.3.16
// (board ab-4wh.2, PIN_0316) changed it, and each old text is gone. The new words stand in the release item right after
// the service's pin, before the words of 0.3.14, 0.3.15 and 0.3.16, and their bound is C10's constant in the copy of
// bridge.json at 4a4eb50 (the same as at 9962e11, a25bfa8, d0a3d49 and 8819e7e).
test("board ab-v16.112: C11 and C12 name the pin of the receiver 0.3.13 (as the pins of the sender 0.2.1, of 0.3.14, of 0.3.15 and of 0.3.16 changed it) and say what 0.3.12 and 0.3.13 change, exactly; each old text is gone; the values are the code's and the vectors'", async () => {
  const { AGENT_VERSION, CHROME_EXTENSION_COMMIT } = await import("../src/service/package/pins.ts");
  assert.deepEqual([AGENT_VERSION, CHROME_EXTENSION_COMMIT.slice(0, 7)], ["0.3.16", "4a4eb50"], "the pin of 0.3.16 is the later pin");
  assert.equal(PIN_0313.length, 3);
  const later = (s: string) => { let x = flat(s); for (const f of [...PIN_SENDER_021, ...PIN_0314, ...PIN_0315, ...PIN_0316]) if (x.includes(flat(f.old))) x = x.replace(flat(f.old), flat(f.text)); return x; };
  for (const e of PIN_0313) {
    const doc = e.file === "C11" ? C11 : C12P;
    assert.ok(says(doc, e.text) || (later(e.text) !== flat(e.text) && says(doc, later(e.text))), `${e.file}, ${e.why}: ${e.text.slice(0, 120)}`);
    if (!e.old.startsWith("(new words")) assert.ok(!says(doc, e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
  const p = flat(partOr(MERGE_GUARD_HEADING));
  assert.ok(p.includes(`The service pins that release or a later one, the receiver ${AGENT_VERSION} (board`), "the release item names the code's pin");
  assert.ok(p.includes("and then `Page.setBypassCSP` with `enabled` true goes to Chrome. " + flat(PIN_0313[2].text) + " " + flat(PIN_0314[2].text) + " " + nowText(PIN_0315[2].text) + " " + flat(PIN_0316[2].text) + " The relay of the old path has the guard and the floor"), "the new words follow the service's pin in the release item, before the words of 0.3.14, 0.3.15 and 0.3.16");
  assert.ok(!p.includes("the receiver 0.3.11 (board"), "no older pin of the service");
  // The bound that the words name: five times REMOVAL_WAIT_MS (10 s), before 0.3.13 three times (6 s).
  assert.equal(K.REMOVAL_WAIT_MS, 2000);
  assert.deepEqual([5 * K.REMOVAL_WAIT_MS, 3 * K.REMOVAL_WAIT_MS], [10_000, 6_000]);
});

// Board ab-b84.44: the service pins chrome-extension d0a3d49 (PR #52, board ab-b84.43): the sender 0.2.1, whose popup
// calls a send unfinished only after 8 minutes; agent/, release/agent.crx and test/vectors/ are the same as at 8819e7e,
// so the receiver stays 0.3.13. C12 says each text of PIN_SENDER_021 exactly, or as the pins of 0.3.14 (board
// ab-v16.115, PIN_0314), 0.3.15 (board ab-sta.4, PIN_0315) and 0.3.16 (board ab-4wh.2, PIN_0316; each with the same
// sender 0.2.1) changed it, and each old text is gone; the commit and the version that the texts name are the code's.
test("board ab-b84.44: C12 names the pin of chrome-extension d0a3d49 (as the pins of 0.3.14, 0.3.15 and 0.3.16 changed it) and the sender 0.2.1, exactly; each old text is gone; the values are the code's", async () => {
  const { AGENT_VERSION, CHROME_EXTENSION_COMMIT } = await import("../src/service/package/pins.ts");
  const { senderData } = await import("../src/service/package/sender.ts");
  assert.deepEqual([AGENT_VERSION, CHROME_EXTENSION_COMMIT.slice(0, 7)], ["0.3.16", "4a4eb50"], "the pin of 0.3.16 (the same sender 0.2.1) is the later pin");
  assert.equal(senderData().version, "0.2.1");
  assert.equal(PIN_SENDER_021.length, 2);
  const later = (s: string) => { let x = flat(s); for (const f of [...PIN_0314, ...PIN_0315, ...PIN_0316]) if (x.includes(flat(f.old))) x = x.replace(flat(f.old), flat(f.text)); return x; };
  for (const e of PIN_SENDER_021) {
    const doc = e.file === "C11" ? C11 : C12P;
    assert.ok(says(doc, e.text) || (later(e.text) !== flat(e.text) && says(doc, later(e.text))), `${e.file}, ${e.why}: ${e.text.slice(0, 120)}`);
    assert.ok(!says(doc, e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
  assert.ok(says(C12P, `pins (\`${CHROME_EXTENSION_COMMIT.slice(0, 7)}\`, C1)`), "C12 names the code's pin");
  assert.ok(says(C12P, `\`operator/\` folder (\`${senderData().version}\`)`), "C12 names the version of the shipped operator/ folder");
});

// Board ab-v16.115: the service pins the receiver 0.3.14 (chrome-extension a25bfa8, PR #53, board ab-v16.83). C11 and
// C12 say each text of PIN_0314 exactly, or as the pins of 0.3.15 (board ab-sta.4, PIN_0315) and 0.3.16 (board
// ab-4wh.2, PIN_0316) changed it, and each old text is gone. The new words stand in the release item right after the
// words of 0.3.13, before the words of 0.3.15 and 0.3.16 and the old path. The sender (operator/) and the vectors (test/vectors/) were the same as at d0a3d49, so the sender
// stayed 0.2.1 and the copy at a25bfa8 had the same bytes.
test("board ab-v16.115: C11 and C12 name the pin of the receiver 0.3.14 (as the pins of 0.3.15 and 0.3.16 changed it) and say what 0.3.14 changes, exactly; each old text is gone; the values are the code's", async () => {
  const { AGENT_VERSION, CHROME_EXTENSION_COMMIT } = await import("../src/service/package/pins.ts");
  const { senderData } = await import("../src/service/package/sender.ts");
  assert.deepEqual([AGENT_VERSION, CHROME_EXTENSION_COMMIT.slice(0, 7)], ["0.3.16", "4a4eb50"], "the pin of 0.3.16 is the later pin");
  assert.equal(senderData().version, "0.2.1", "the sender does not change");
  assert.equal(PIN_0314.length, 3);
  const later = (s: string) => { let x = flat(s); for (const f of [...PIN_0315, ...PIN_0316]) if (x.includes(flat(f.old))) x = x.replace(flat(f.old), flat(f.text)); return x; };
  for (const e of PIN_0314) {
    const doc = e.file === "C11" ? C11 : C12P;
    assert.ok(says(doc, e.text) || (later(e.text) !== flat(e.text) && says(doc, later(e.text))), `${e.file}, ${e.why}: ${e.text.slice(0, 120)}`);
    if (!e.old.startsWith("(new words")) assert.ok(!says(doc, e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
  const p = flat(partOr(MERGE_GUARD_HEADING));
  assert.ok(p.includes(`The service pins that release or a later one, the receiver ${AGENT_VERSION} (board`), "the release item names the code's pin");
  assert.ok(p.includes("after it starts, not three times (6 s). " + flat(PIN_0314[2].text) + " " + nowText(PIN_0315[2].text) + " " + flat(PIN_0316[2].text) + " The relay of the old path has the guard and the floor"), "the new words follow the words of 0.3.13, before the words of 0.3.15 and 0.3.16 and the old path");
  assert.ok(!p.includes("the receiver 0.3.13 (board ab-v16.97.10"), "no older pin of the service");
  assert.ok(says(C12P, `pins (\`${CHROME_EXTENSION_COMMIT.slice(0, 7)}\`, C1)`), "C12 names the code's pin");
});

// Board ab-sta.4 (the secure card checkout, Task 3): the service pins the receiver 0.3.15 (chrome-extension 9962e11, PR
// #54). C11 and C12 say each text of PIN_0315 exactly, or as the pin of 0.3.16 (board ab-4wh.2, PIN_0316) changed it,
// and each old text is gone. The new words stand in the release item right after the words of 0.3.14, before the words
// of 0.3.16 and the old path. operator/ was the same as at a25bfa8, so the sender stayed 0.2.1; of the copied vectors
// only hello.json changed (the feature pay). C11's card payment says that only a service
// started with `--card-pay` has the payment act (board ab-sta.7), and the allow list's guard names both payment tools.
test("board ab-sta.4: C11 and C12 name the pin of the receiver 0.3.15 (as the pin of 0.3.16 changed it) and say what 0.3.15 changes, exactly; each old text is gone; the values are the code's and the vectors'", async () => {
  const { AGENT_VERSION, CHROME_EXTENSION_COMMIT } = await import("../src/service/package/pins.ts");
  const { senderData } = await import("../src/service/package/sender.ts");
  const { PAY_TOOLS } = await import("../src/service/mcp/allow-list.ts");
  assert.deepEqual([AGENT_VERSION, CHROME_EXTENSION_COMMIT.slice(0, 7)], ["0.3.16", "4a4eb50"], "the pin of 0.3.16 is the later pin");
  assert.equal(senderData().version, "0.2.1", "the sender does not change");
  assert.equal(PIN_0315.length, 3);
  for (const e of PIN_0315) {
    const doc = e.file === "C11" ? C11 : C12P;
    // Board ab-sta.6 (CARD_COPY) changed the last words of the third text (review-225 N1), and the pin of 0.3.16
    // (PIN_0316) the first two texts: C11 and C12 say them as changed.
    assert.ok(says(doc, nowText(e.text)), `${e.file}, ${e.why}: ${e.text.slice(0, 120)}`);
    if (!e.old.startsWith("(new words")) assert.ok(!says(doc, e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
  const p = flat(partOr(MERGE_GUARD_HEADING));
  assert.ok(p.includes(`The service pins that release or a later one, the receiver ${AGENT_VERSION} (board`), "the release item names the code's pin");
  assert.ok(p.includes("whose file then stays. " + nowText(PIN_0315[2].text) + " " + flat(PIN_0316[2].text) + " The relay of the old path has the guard and the floor"), "the new words follow the words of 0.3.14, before the words of 0.3.16 and the old path");
  assert.ok(!p.includes("the receiver 0.3.14 (board ab-v16.97.10"), "no older pin of the service");
  assert.ok(says(C12P, `pins (\`${CHROME_EXTENSION_COMMIT.slice(0, 7)}\`, C1)`), "C12 names the code's pin");
  // The feature that the words name is in the copy of C4's hello vector (at 4a4eb50; since 9962e11).
  const hello = JSON.parse(read("test/vectors/chrome-extension-4a4eb50/hello.json")).hello;
  assert.ok(hello.features.includes("pay"), "the feature pay");
  // The payment tools only with --card-pay (board ab-sta.7): C11's card payment says so, and the allow list's guard names both tools.
  assert.ok(says(C11, CARD_ACT[1].text), "C11's card payment: only a service started with --card-pay has the payment act");
  assert.deepEqual(PAY_TOOLS, ["browser_pay", "browser_pay_status"]);
});

// Board ab-4wh.2 (the blanket profile): the service pins the receiver 0.3.16 (chrome-extension 4a4eb50, PR #55). C11
// and C12 say each text of PIN_0316 exactly, and each old text is gone. The new words stand in the release item right
// after the words of 0.3.15, before the old path. operator/ is the same as at 9962e11, so the sender stays 0.2.1; of the
// copied vectors hello.json (the feature blanket) and scopes.json (the cases of "*", of a bad exclude and of a default
// "*", and a sweep of "*") change. The cases are the ones that the words name.
test("board ab-4wh.2: C11 and C12 name the pin of the receiver 0.3.16 and say what 0.3.16 changes, exactly; each old text is gone; the values are the code's and the vectors'", async () => {
  const { AGENT_VERSION, CHROME_EXTENSION_COMMIT } = await import("../src/service/package/pins.ts");
  const { senderData } = await import("../src/service/package/sender.ts");
  assert.equal(AGENT_VERSION, "0.3.16");
  assert.equal(CHROME_EXTENSION_COMMIT, "4a4eb50471dcebdb9ff1a2eedb970dec3bb65156");
  assert.equal(senderData().version, "0.2.1", "the sender does not change");
  assert.equal(PIN_0316.length, 3);
  for (const e of PIN_0316) {
    const doc = e.file === "C11" ? C11 : C12P;
    assert.ok(says(doc, e.text), `${e.file}, ${e.why}: ${e.text.slice(0, 120)}`);
    if (!e.old.startsWith("(new words")) assert.ok(!says(doc, e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
  const p = flat(partOr(MERGE_GUARD_HEADING));
  assert.ok(p.includes(`The service pins that release or a later one, the receiver ${AGENT_VERSION} (board`), "the release item names the code's pin");
  assert.ok(p.includes("the allow list's `-32601` answer (the card payment, below). " + flat(PIN_0316[2].text) + " The relay of the old path has the guard and the floor"), "the new words follow the words of 0.3.15, before the old path");
  assert.ok(!p.includes("the receiver 0.3.15 (board ab-v16.97.10"), "no older pin of the service");
  assert.ok(says(C12P, `pins (\`${CHROME_EXTENSION_COMMIT.slice(0, 7)}\`, C1)`), "C12 names the code's pin");
  // The feature that the words name is in the copy of C4's hello vector at 4a4eb50.
  const hello = JSON.parse(read("test/vectors/chrome-extension-4a4eb50/hello.json")).hello;
  assert.deepEqual(hello.features, ["scopes", "act", "fetch", "pay", "blanket"]);
  // The cases that the words name are in the copy of C4's scopes vector at 4a4eb50: the blanket-shaped object with
  // exclude (its scope's list is "*"), a "*" next to a list and the operator's "*", a bad exclude, a default "*", and a
  // remote scope's "*" (each other "*" counts 1 and applies as null).
  const scopesV = JSON.parse(read("test/vectors/chrome-extension-4a4eb50/scopes.json"));
  const star = scopesV.cases.filter((c: any) => Object.values(c.in.scopes ?? {}).some((v) => typeof v === "string" && v.includes("*")));
  assert.equal(star.length, 5);
  const blanket = star.filter((c: any) => c.refused === 0);
  assert.equal(blanket.length, 1);
  assert.deepEqual([blanket[0].in.lists, blanket[0].in.default, blanket[0].in.operator, Object.keys(blanket[0].in.scopes).length, blanket[0].listOf["web-blanket"]], [{}, null, null, 1, "*"]);
  assert.ok(Array.isArray(blanket[0].in.exclude) && blanket[0].in.exclude.length > 0, "the blanket case has exclude");
  for (const c of star.filter((x: any) => x !== blanket[0])) assert.ok(Object.values(c.applies.scopes).every((v) => v !== "*"), c.note);
  assert.ok(star.some((c: any) => Array.isArray(c.in.exclude) && c.in.exclude.some((n: string) => n.endsWith("."))), "the bad exclude");
  assert.ok(star.some((c: any) => c.in.default === "*"), "the default \"*\"");
  assert.ok(scopesV.sweep.some((v: any) => Object.values(v.in.scopes ?? {}).includes("*")), "the sweep of \"*\"");
});

// Board ab-v16.94.7.8 (stage 5: the service removes Chrome's own copy of a remote download; the daemon lead's later item
// on PR #196): C11 says the new rule exactly, in place of T4's "the service removes no file there"; the guard's texts
// and the model's line are the code's.
const CHROME_COPY_C11 = {
  old: "as before: the service removes no file there, and only the remote scope's copy in its folder goes at the scope's end.",
  text: "Chrome keeps its own copy of each download in the agent profile's downloads folder (on Linux a folder `Downloads` in the state folder), as before. For a download of a remote scope's page the service removes that copy (board ab-v16.94.7.8) at the end of its handling of the download: after Chrome reports the download complete (`Page.downloadProgress`) and its item complete (`downloads.search` by the item's id), and before the client hears the end. It takes only the item that Chrome's `downloads.onCreated` tied to the download by the item's `finalUrl` (the URL after the redirects), and only when that item's `finalUrl` is the download's URL and the item started at most 10 s (first value) before the service got `Page.downloadWillBegin`. It removes nothing with no such item (also when none is complete within the wait), for an incognito item, an item of the act or an item that another download holds, when a download of another scope had the same URL while it ran, and when Chrome has another item whose `finalUrl` or `url` is the download's URL and that started at most 10 s before `Page.downloadWillBegin` or later (also a download of a tab with no client), or that search fails (board ab-v16.94.7.10). It removes the file only while the downloads folder is a folder of the service's user that is no link, the path's folder after `realpath` is that folder or a folder in it, and the path is a regular file that is no link. A refusal and a failed removal get a log line with the scope and the reason or the error's code, never a path; a failed removal changes nothing that the client hears. A local scope's download stays there. Any copy in the remote scope's folder goes at the scope's end, as before.",
};
test("board ab-v16.94.7.8: C11 says that the service removes Chrome's own copy of a remote scope's download, exactly, in the remote scope's folder's paragraph; T4's old text is gone; the guard's words are the code's", async () => {
  assert.ok(says(C11, CHROME_COPY_C11.text), "the new rule");
  assert.ok(!says(C11, CHROME_COPY_C11.old), "the old text is gone");
  assert.ok(says(C11, "and the MCP's output folder (its copies of downloads and the other files that it writes) is the remote scope's folder. " + CHROME_COPY_C11.text + " When one of the three is a link"), "in its place in the paragraph");
  const G = await import("../src/relay/chrome-downloads.ts");
  assert.deepEqual(Object.keys(G.CHROME_COPY).sort(), ["folderNotOurs", "link", "noItem", "notAFile", "notOwn", "otherScope", "outside", "sameUrl", "searchFailed"]);
  for (const why of Object.values(G.CHROME_COPY)) assert.ok(!/[/\\]/.test(why), `a reason with no path: ${why}`);
  assert.equal(G.CHROME_COPY.otherScope, "another scope's download");
  // The fix round of review-204 (B1): the item's start, at most 10 s (first value) before the model got Page.downloadWillBegin.
  const M = await import("../src/relay/model.ts");
  assert.equal(M.DOWNLOAD_ITEM_SLACK_MS, 10_000, "C11's 10 s is the code's");
  assert.ok(says(C11, "and the item started at most 10 s (first value) before the service got `Page.downloadWillBegin`."));
});

// Board ab-v16.94.7.10 (recheck-204 N1): the tie and the check of a remote scope's item by its `finalUrl` only, and the
// new case with no removal (Chrome's other item of the URL in the download's time, or a failed search), in place of the
// tie "by the item's `url`, or for a remote scope also by its `finalUrl`" and the check "`finalUrl` or `url`".
const SAME_URL_C11 = {
  old: ["tied to the download (by the item's `url`, or for a remote scope also by its `finalUrl`, the URL after the redirects), and only when that item's `finalUrl` or `url` is the download's URL",
    "an item that another download holds, and when a download of another scope had the same URL while it ran."],
  text: "tied to the download by the item's `finalUrl` (the URL after the redirects), and only when that item's `finalUrl` is the download's URL and the item started at most 10 s (first value) before the service got `Page.downloadWillBegin`. It removes nothing with no such item (also when none is complete within the wait), for an incognito item, an item of the act or an item that another download holds, when a download of another scope had the same URL while it ran, and when Chrome has another item whose `finalUrl` or `url` is the download's URL and that started at most 10 s before `Page.downloadWillBegin` or later (also a download of a tab with no client), or that search fails (board ab-v16.94.7.10).",
};
test("board ab-v16.94.7.10: C11 says the remote scope's tie by `finalUrl` only and the new case with no removal, exactly; the old texts are gone; the reasons are the code's", async () => {
  assert.ok(says(C11, SAME_URL_C11.text), "the new rule");
  for (const old of SAME_URL_C11.old) assert.ok(!says(C11, old), `the old text is gone: ${old.slice(0, 80)}`);
  const G = await import("../src/relay/chrome-downloads.ts");
  assert.equal(G.CHROME_COPY.sameUrl, "another download of the same URL");
  assert.equal(G.CHROME_COPY.searchFailed, "the search for another download of the same URL failed");
});

// Board goal ab-sta, Task 1 (the secure card checkout's contracts; the design
// docs/superpowers/specs/2026-11-21-secure-card-checkout-design.md, sections 6, 7, 8 and 10, and its plan
// docs/superpowers/plans/2026-11-21-secure-card-checkout.md): C11's new part "The card payment" holds exactly the items
// of CARD_PAY whose file is "C11 part", in order, and it is the last part of C11, after the sign-in act. C11's other
// parts and the allow list's format say the other texts of CARD_PAY exactly, and each old text is gone. The table of what
// the agent sees gives one state and one text for each cause, the design's texts of section 8.7 exactly, and no text names
// a stop or a start (I2). The allow list's two new tools are the code's.
const CARD_PAY_HEADING = "The card payment (board goal ab-sta; the secure card checkout design).";
const CARD_PAY: { file: "C11 part" | "C11" | "ALLOW"; why: string; old?: string; text: string }[] = [
  { file: "C11 part", why: "the card payment, item 1 (board ab-sta.7: CARD_ACT)", text: "**The card payment (board goal ab-sta; the secure card checkout design).** The design is `docs/superpowers/specs/2026-11-21-secure-card-checkout-design.md`, sections 6, 7 and 8, with the operator's answers of 2026-11-21 (board item ab-uzv: Q1 to Q4), and its plan is `docs/superpowers/plans/2026-11-21-secure-card-checkout.md`. This part fixes the contract of the payment act (the plan's Tasks 4 and 5). Only a service that agent-browser's command starts with `--card-pay` has the payment act, on Linux only (board ab-sta.7): the option is off by default, and agentwatch does not start the service so yet. The card, its ops and the payment's events are C12's (the card payments). The relay has no payment act." },
  { file: "C11 part", why: "the card payment, item 2", text: "What the act does. An agent drives a merchant's checkout to its payment step in its own tab, and then asks for a payment with a card that the operator stored, by the card's name. The service copies the merchant's session into an act window of its own, reads the page's order there, and waits for the operator's approval in the Browser pane (C12's `pay_approve`, with `kind: operator` only). Then it types the card's values only inside a known payment provider's frame, presses the pay button and reads the result. The agent gets only the result's text." },
  { file: "C11 part", why: "the card payment, item 3", text: "No answer of either tool, no event, no status and no log line holds a digit of the card's number, its expiry or its security code (the design's R1). No text is made from them, and the result reader refuses each value that holds the card's last four digits, a run of four or more of the number's digits in their order, or its expiry. The order reader applies the same filter: it drops each order line that holds one of them, so no `pay_request` (C12) holds one." },
  { file: "C11 part", why: "the card payment, item 4", text: "The entry." },
  { file: "C11 part", why: "the card payment, item 5", text: "The MCP only: the service's own tools `browser_pay` and `browser_pay_status` of the allow list's `service_tools`. No CDP method and no CLI command pays." },
  { file: "C11 part", why: "the card payment, item 6", text: "`browser_pay` takes the keys `card`, `origin`, `amount`, `currency`, `description` and `button`, and the first five are required. `browser_pay_status` takes no key." },
  { file: "C11 part", why: "the card payment, item 7 (board ab-sta.6: CARD_COPY; board ab-sta.7: CARD_ACT)", text: "The admission is the sign-in act's: the service runs either tool only for a request that the MCP port admitted with the uid check and the walk (a local admission), and only while the service has the payment act. While the service has no payment act, a `tools/list` holds neither tool, and a local call of either gets the allow list's `-32601` answer (a remote call gets the refusal below). Only a service that agent-browser's command starts with `--card-pay` has the payment act, and agentwatch does not start the service so yet." },
  { file: "C11 part", why: "the card payment, item 8", text: "A request that a remote token admitted gets the tool error `Not paid: Payments work only for sessions of this box.` at once, whatever its arguments: it opens no window, reads no card, sends no event, passes no browser gate and is no use. The MCP path also logs `mcp: MCP session <n> (scope <scope>): a tools/call of <tool> refused (a remote admission)`." },
  { file: "C11 part", why: "the card payment, item 9", text: "A local call is a tool call of its MCP session, as a call of `browser_sign_in` is: it passes the browser gate first, it counts as a use until the payment act's method ends, and a cancel at the gate ends it. A cancel before the operator's approval ends the request. Once the approval applies, no cancel stops the act, and its result stays for `browser_pay_status`." },
  { file: "C11 part", why: "the card payment, item 10", text: "The keys." },
  { file: "C11 part", why: "the card payment, item 11", text: "`card` is the name of a stored card: it matches C11's scope pattern, as the name of a stored sign-in does." },
  { file: "C11 part", why: "the card payment, item 12", text: "`origin` is the merchant's origin as the WHATWG URL parser gives it: `https:`, or `http:` with a loopback host for tests (C12's rule of a sign-in's `origin`)." },
  { file: "C11 part", why: "the card payment, item 13", text: "`amount` is a decimal string above 0 with at most two decimals, for example `12.50`. `currency` is a code of three capital letters, for example `USD`." },
  { file: "C11 part", why: "the card payment, item 14", text: "`description` is the agent's own text of the purchase, at most 500 characters. The Browser pane shows it as the agent's words." },
  { file: "C11 part", why: "the card payment, item 15", text: "`button` is a hint of the pay button's text, at most 100 characters (a first value)." },
  { file: "C11 part", why: "the card payment, item 16", text: "The checks before the request, in this order. The first check that fails gives its text (what the agent sees, below), and no request starts." },
  { file: "C11 part", why: "the card payment, item 17", text: "The request came by a local admission, and the agent browser is ready (the sign-in act's check 1)." },
  { file: "C11 part", why: "the card payment, item 18", text: "Each key has its form (the keys, above)." },
  { file: "C11 part", why: "the card payment, item 19", text: "The store is open (C12)." },
  { file: "C11 part", why: "the card payment, item 20", text: "The last `sign_ins` (C12) holds a card of the asked name (a record of the kind `card`), and it opens. A stored sign-in is no card: the payment act refuses a record with no `kind`." },
  { file: "C11 part", why: "the card payment, item 21", text: "The scope's list covers the origin's host." },
  { file: "C11 part", why: "the card payment, item 22 (board ab-sta.14: CARD_HOSTED)", text: "Exactly one tab of the scope shows a page of the origin: the agent's tab. The service cannot tie a known provider's hosted payment page (an origin of the service's list of payment providers' origins, the design's section 8.4) to the merchant, so such a page is no page of the origin (board ab-sta.14): when the origin is such an origin, or when no tab of the scope shows the origin and a tab of the scope shows such a page, the request stops with the text of a hosted payment page." },
  { file: "C11 part", why: "the card payment, item 23", text: "No other payment request of the scope waits." },
  { file: "C11 part", why: "the card payment, item 24", text: "The one private window is free (PageFetch, above): the request waits for it at most 60 s, as a sign-in act does." },
  { file: "C11 part", why: "the card payment, item 25 (board ab-sta.6: CARD_COPY; board ab-sta.14: CARD_HOSTED)", text: "The request. The service gives the request an id, and records the agent's tab id and the tab's URL. It copies the merchant's session into a new act window (C10's act window, with the receiver's two requests of the hello's feature `pay`: C4's `pay_merchant_block` and `pay_cookies_copy`, and C5's rule 90). The merchant's registrable domain is the one that Chrome gives for the main frame of the agent's tab (Chrome's public suffix list), read before any request to the receiver: an empty one (a host that is itself a public suffix), an IP literal, or one that is not the host or a parent of it stops the request with the session copy's text, and a host that ends in `.localhost` (a loopback test host) is its own domain (a bare `localhost` stops). From the copy to the act's end, rule 90 blocks each request to the merchant's registrable domain from every tab except the act tabs, so the agent's tabs cannot change the cart or the order; a request of a worker with no tab (a service worker or a shared worker) of the act's own context is blocked by rule 90 too (C5's stated limit), while a dedicated worker of an act tab sends its requests with the act tab's id, so rule 90 lets them go (measured on the Linux server, board ab-sta.8). The service reads the origin's `localStorage` from the agent's tab by CDP and writes it into the act's context before any script of the merchant runs: the act's `Fetch` answers the first load of the origin with a blank document, and the service writes the storage there. The act tab loads the tab's URL, and the act's rules (C4's `act_rules`) hold; the act page's origin must be the request's origin, and a known provider's hosted payment page there (a page that moved after check 6) stops the request with the text of a hosted payment page. Once the act finds the card fields, the service sends the act's rules again, with the request's origin, then the card-field frame and API origins of the one provider whose frames hold the card fields (the act's provider, from the service's list of payment providers), then the merchant's origins that the act tab called, at most 32 and no other provider's origin, and the receiver confirms them before the `pay_request` and before the first key; card fields in the frames of two providers stop the request with the text of card fields outside a provider frame. The service reads the page's order: the order lines, the total, the currency, and the delivery name and email when the page shows them. When the total is the request's `amount` in its `currency`, the service sends C12's `pay_request` and waits up to 10 minutes for the operator's answer. At the end of each request that sent a `pay_request`, the service sends C12's `pay_result` once, with the result: also for the operator's refusal, the expiry, a cancel and an approval that does not match. Each end of a request ends its act window with the act's clean end (below), also before the approval, so `act_end` removes rule 90 with the act's rules." },
  { file: "C11 part", why: "the card payment, item 26", text: "The approval. The service takes only a `pay_approve` with `kind: operator` whose seal binds this request: its id, the origin, the amount, the currency, the card's name and the hash of the page's order (C12). It refuses a used request id. The approval is good for one act within 10 minutes. The operator's refusal ends the request." },
  { file: "C11 part", why: "the card payment, item 27 (board ab-sta.7: CARD_ACT; board ab-sta.14: CARD_HOSTED, review-232 N1)", text: "The act. The service sends C12's `pay` with `state` `start` before the act's first key, and with `state` `end` at the act's end. The act reads the page's order again, and a hash that differs from the approved one stops it. Card fields that it finds again outside the act's provider's frames stop it with the text of card fields outside a provider frame. The act page must still be the page of the preparation, on the request's origin: when the act tab's main frame loaded a new document after the preparation's last read of the card fields, or its origin is not the request's origin, at the order's read again or when the act finds the card fields again, the act stops before its first key with the text of a hosted payment page for a known provider's hosted payment page, and with the text of no payment step otherwise. It types the card's values only into the card fields of a provider frame, unticks each box near them that saves the card, reads the total once more, presses the pay button (the form's submit button, the button whose text says pay, buy or place order, or the agent's hint), and reads the result for up to 60 s. The act ends at most 5 minutes after its first key (a first value). Its clean end is the sign-in act's, without the move: no session moves back into the default context. Before its first key the act stops with the text of a lost window when the act tab opened a popup, when the act window has another tab, or when the act cannot read the window's tabs, and with the text of the act's rules when the act page keeps a WebSocket or a WebTransport open to a host outside the act's rules (the sign-in act's form rule 6), or when the guard cannot start in a frame or a worker of the act tab. A dedicated worker that Chrome attaches on the act tab's own session has no `Fetch` of its own through the receiver's debugger, and the act tab's own `Fetch` pauses that worker's requests (measured on the Linux server, board ab-sta.8), so the guard holds there; each other frame or worker whose `Fetch` cannot start stops the act. The guard fails each request of the act tab, its frames and its workers whose URL holds the card's number (its digits, or groups of them with spaces, dashes, `+` or `%20`, also after a percent-decoding of each `%XX`), and each one whose body holds it, unless the request goes to the act's provider: an origin of its card-field frames or of its API, or a host of such a listed host's own domain with the listed origin's scheme (the listed host without its first label, when that still has a dot); a body with the number to another provider's origin fails. A request whose body Chrome does not give fails too, unless it goes to the act's provider. Each value of a text field goes into the field after a person's click on it; a select of the expiry's month or year gets its option from a script in the act's own isolated world. Before each key the act checks that the provider frame still shows the document that it found, that the field has the focus of that document, and that the act page's own focus is on the provider frame; else it stops and empties the fields. After the fill the act unticks the save-card boxes again, and right before the press it reads the total and the boxes once more. When a request takes the card's number to a provider before the press (a page that pays when the card is complete; the guard lets it go), the act writes the keep's `unknown` at once, and each later end of the act before the press is Unknown with the Unknown text, never `Not paid`; when that write fails, the act stops at once, and its result is Unknown. After the press the act's rules stay as they were at the fill, and the guard still applies to each request: Chrome applies the act's rules before the act's `Fetch` sees a request, so the act cannot learn a new origin after the press (measured on the Linux server, board ab-sta.8); a top-level GET navigation stays open (C5), so a confirmation on another host still loads. The result reader gives Declined only while the page stays and a new line near the card fields (a line of the page's alert or status regions, or of a provider frame) names a decline; a page whose new lines also name a confirmation gives Unknown, and the lines that the page showed before the press count for no result, also after a new page. At its end the act empties the fields of each provider frame and fills the buffers of the card's values with zeros." },
  { file: "C11 part", why: "the card payment, item 28", text: "The one private window. A payment request holds the one private window from the session copy to the act's end, so a sign-in act and PageFetch wait for it by their own rules while the operator approves." },
  { file: "C11 part", why: "the card payment, item 29", text: "What the agent sees." },
  { file: "C11 part", why: "the card payment, item 30", text: "`browser_pay` gives a tool result with one text item, a text of the table below. A result of the state `paid` is a tool result; each other state is a tool error (`isError: true`). A text of the state `stopped` comes as `Not paid: <text>`." },
  { file: "C11 part", why: "the card payment, item 31", text: "When the session copy ran, the text has one more line: `Your tabs could not reach <domain> from the copy of the checkout to the end of the payment.`" },
  { file: "C11 part", why: "the card payment, item 32", text: "`<amount>` and `<currency>` are the request's, `<origin>` is its origin, `<number>` is the order number that the result reader took, `<name>` is the asked card name, `<host>` is the host that the list does not cover, and `<domain>` is the merchant's registrable domain." },
  { file: "C11 part", why: "the card payment, item 33", text: "`browser_pay_status` gives the results of the scope's payment requests of the last 24 hours, the newest first, as compact JSON: `{\"results\":[{\"state\":\"<state>\",\"text\":\"<text>\",\"at\":\"<time>\",\"origin\":\"<origin>\"}]}`, with no other field. `<time>` is the result's time in UTC (ISO 8601)." },
  { file: "C11 part", why: "the card payment, item 34", text: "| The cause | The state | The text |" },
  { file: "C11 part", why: "the card payment, item 35", text: "| Paid | `paid` | `Paid: <amount> <currency> to <origin>, order <number>` |" },
  { file: "C11 part", why: "the card payment, item 36", text: "| Paid, and the reader took no order number | `paid` | `Paid: <amount> <currency> to <origin>, order number not found` |" },
  { file: "C11 part", why: "the card payment, item 37", text: "| Paid, and the confirmation shows another amount (here `<amount>` is the confirmation's amount and currency) | `paid` | `Paid, but the merchant's confirmation shows <amount>` |" },
  { file: "C11 part", why: "the card payment, item 38", text: "| Declined | `declined` | `Declined by the card's bank or the merchant` |" },
  { file: "C11 part", why: "the card payment, item 39", text: "| A bank's second step after the press | `unknown` | `The card's bank asked for a second step. The payment's result is unknown: check the merchant's account before you buy by hand.` |" },
  { file: "C11 part", why: "the card payment, item 40 (board ab-sta.7: CARD_ACT)", text: "| Each other end after the press (no confirmation within 60 s, a lost tab, a link change, a stop of the service, the act's 5 minutes), or a stop after the card's number went to the provider before the press | `unknown` | `The payment's result is unknown. Do not pay again: check the merchant's mail or account.` |" },
  { file: "C11 part", why: "the card payment, item 41", text: "| A remote admission (check 1) | `stopped` | `Payments work only for sessions of this box.` |" },
  { file: "C11 part", why: "the card payment, item 42", text: "| Not ready (check 1) | `stopped` | the 503 body of the readiness, for example `The agent browser is not ready: its extension is not connected.` |" },
  { file: "C11 part", why: "the card payment, item 43", text: "| The key `amount` (check 2) | `stopped` | `The amount must be a decimal number above 0 with at most two decimals.` |" },
  { file: "C11 part", why: "the card payment, item 44", text: "| The key `currency` (check 2) | `stopped` | `The currency must be a code of three capital letters.` |" },
  { file: "C11 part", why: "the card payment, item 45", text: "| The key `description` (check 2) | `stopped` | `The description must be a text of at most 500 characters.` |" },
  { file: "C11 part", why: "the card payment, item 46", text: "| The key `card`, `origin` or `button` (check 2) | `stopped` | `The <key> of the payment request is not valid.` |" },
  { file: "C11 part", why: "the card payment, item 47", text: "| Locked (check 3) | `stopped` | `The stored sign-ins and cards are locked. The operator unlocks them in the Browser pane.` |" },
  { file: "C11 part", why: "the card payment, item 48", text: "| No such card (check 4) | `stopped` | `There is no stored card named <name>.` |" },
  { file: "C11 part", why: "the card payment, item 49", text: "| The card does not open (check 4) | `stopped` | `The stored card cannot be opened. The operator adds it again.` |" },
  { file: "C11 part", why: "the card payment, item 50", text: "| The list (check 5) | `stopped` | `Not allowed: <host> is not on the allowlist` |" },
  { file: "C11 part", why: "the card payment, item 51", text: "| No tab of the origin, or more than one (check 6) | `stopped` | `Exactly one tab of this session must show the checkout of <origin>.` |" },
  { file: "C11 part", why: "the card payment, item 51a (board ab-sta.14: CARD_HOSTED)", text: "| A known provider's hosted payment page as the origin, or in a tab of the scope with no tab of the origin (check 6), or as the act page | `stopped` | `This checkout's payment page is on a payment provider's own site, and the agent browser cannot tie it to <origin>. The operator buys it by hand.` |" },
  { file: "C11 part", why: "the card payment, item 52", text: "| Another request of the scope (check 7) | `stopped` | `A payment request of this scope waits.` |" },
  { file: "C11 part", why: "the card payment, item 53", text: "| Busy for 60 s (check 8) | `stopped` | `Another payment or sign-in runs now. Try again in a minute.` |" },
  { file: "C11 part", why: "the card payment, item 54", text: "| Another private window | `stopped` | `Another private window is open in the agent browser.` |" },
  { file: "C11 part", why: "the card payment, item 55", text: "| No act window (no feature `act`, no incognito window) | `stopped` | `The agent browser could not open the payment window.` |" },
  { file: "C11 part", why: "the card payment, item 56", text: "| The session copy | `stopped` | `The agent browser could not copy the checkout's session.` |" },
  { file: "C11 part", why: "the card payment, item 57 (board ab-sta.7: CARD_ACT)", text: "| The act's rules, or before the first key a connection of the act page that is open to a host outside them, or a frame or a worker where the guard cannot start | `stopped` | `The agent browser could not hold the payment's rules.` |" },
  { file: "C11 part", why: "the card payment, item 58", text: "| No payment step, or another origin, on the act page | `stopped` | `This checkout cannot move to the payment act` |" },
  { file: "C11 part", why: "the card payment, item 59", text: "| A check at the payment step (a captcha, a sign-in, a phone code) | `stopped` | `The checkout asks for a check that the agent browser cannot pass.` |" },
  { file: "C11 part", why: "the card payment, item 60", text: "| No total, or two candidate totals | `stopped` | `The agent browser cannot read the total of this checkout.` |" },
  { file: "C11 part", why: "the card payment, item 61", text: "| Another total | `stopped` | `The checkout's total is not <amount> <currency>.` |" },
  { file: "C11 part", why: "the card payment, item 62", text: "| Card fields outside a provider frame | `stopped` | `This checkout's card fields are not in a known payment provider's frame` |" },
  { file: "C11 part", why: "the card payment, item 63", text: "| No answer of the operator within 10 minutes | `stopped` | `The operator did not answer the payment request within 10 minutes.` |" },
  { file: "C11 part", why: "the card payment, item 64", text: "| The operator's refusal | `stopped` | `The operator refused this payment.` |" },
  { file: "C11 part", why: "the card payment, item 65", text: "| A cancel of the call before the approval (the call gets the cancelled answer; `pay_result` gets the text) | `stopped` | `The agent cancelled the payment request.` |" },
  { file: "C11 part", why: "the card payment, item 66", text: "| An approval that does not match the request | `stopped` | `This approval does not match the payment request` |" },
  { file: "C11 part", why: "the card payment, item 67", text: "| Another order after the approval (its hash) | `stopped` | `The checkout's order changed after the approval: a new request asks the operator again.` |" },
  { file: "C11 part", why: "the card payment, item 68", text: "| A box that saves the card and that the act cannot untick | `stopped` | `The checkout keeps the card, and the agent browser cannot turn that off.` |" },
  { file: "C11 part", why: "the card payment, item 69 (board ab-sta.7: CARD_ACT)", text: "| A provider frame that loaded again during the fill, or a field that lost the focus during it (the act empties the fields) | `stopped` | `The payment provider's frame loaded again during the fill.` |" },
  { file: "C11 part", why: "the card payment, item 70", text: "| Another total before the press (the act empties the fields) | `stopped` | `The checkout's total changed before the payment.` |" },
  { file: "C11 part", why: "the card payment, item 71", text: "| No pay button | `stopped` | `The agent browser found no pay button on the checkout.` |" },
  { file: "C11 part", why: "the card payment, item 72", text: "| The guard before the press | `stopped` | `The checkout tried to send the card's number to a place where it does not belong.` |" },
  { file: "C11 part", why: "the card payment, item 73", text: "| A lock of the store before the press | `stopped` | `The stored sign-ins and cards were locked before the payment.` |" },
  { file: "C11 part", why: "the card payment, item 74", text: "| The keep's write before the press | `stopped` | `The agent browser could not keep a record of the payment, so it did not pay.` |" },
  { file: "C11 part", why: "the card payment, item 75 (board ab-sta.7: CARD_ACT)", text: "| The act tab is gone before the press, or before the first key it opened a popup, the act window has another tab, or the act cannot read the window's tabs | `stopped` | `The agent browser lost the payment window before the payment.` |" },
  { file: "C11 part", why: "the card payment, item 76", text: "| The act's 5 minutes before the press | `stopped` | `The checkout did not reach the payment within 5 minutes.` |" },
  { file: "C11 part", why: "the card payment, item 77", text: "No text holds a value of the page other than an order number and a confirmation's amount that the reader took. No text names a stop or a start of the agent browser (I2)." },
  { file: "C11 part", why: "the card payment, item 78", text: "The keep. The service keeps the result of each request of the last 24 hours in a file of its own, `pay-results.json` in the folder of `--state-folder`, with mode 0600: the fields of C12's `pay_result` (the request id, the scope, the origin, the state, the text, the time and `alert`), and no value of the card, no order line, no description, no URL path and no query. Right before the press it writes the state `unknown` with the Unknown text, and at the act's end it replaces that entry with the result. It drops each entry older than 24 hours. `browser_pay_status` and the `earlier` of C12's `pay_request` read the keep, so a result survives a restart of the service: a stop of the service after the press leaves `unknown`. A file that the service cannot read at its start counts as no file, and the service logs the error's kind. A write that fails right before the press ends the act before the press." },
  { file: "C11 part", why: "the card payment, item 79", text: "The log. The service logs one line for each request of `browser_pay`: the user, the scope, the session's `repo`, the request id, the card's name, the origin, the amount and the currency, the state, the time that it took, and the number of requests that the block and the guard stopped. No log line holds a value of the card, the page's order, the agent's description, a URL path or a query." },
  { file: "C11 part", why: "the card payment, item 80", text: "The limits, stated plainly." },
  { file: "C11 part", why: "the card payment, item 81", text: "A checkout whose card fields are on the merchant's own page, or in a frame that is not on the provider list, stops, and the operator buys by hand." },
  { file: "C11 part", why: "the card payment, item 81a (board ab-sta.14: CARD_HOSTED, review-232 N3)", text: "A checkout that pays on a provider's hosted payment page stops, and the operator buys by hand: the service cannot tie such a page to the merchant yet (board ab-sta.14). A binding to the merchant comes later, after board ab-sta.15 shows whether the first ticket sites use hosted pages." },
  { file: "C11 part", why: "the card payment, item 82", text: "A checkout whose state lives only in one tab's `sessionStorage`, in IndexedDB or in a server session bound to the tab's connection does not survive the session copy." },
  { file: "C11 part", why: "the card payment, item 83", text: "A change at the moment of the press shows only after the payment, in the confirmation's amount." },
  { file: "C11", why: "the self-contained agent browser's table: the row of the card payment", text: "| The card payment (`browser_pay`, `browser_pay_status`), its act window and the operator's approval (the card payment, below) | agent-browser's service | board goal ab-sta builds it on Linux, off by default |" },
  { file: "C11", why: "where the row of the card payment comes from", text: "The row of the card payment comes from the secure card checkout design (`docs/superpowers/specs/2026-11-21-secure-card-checkout-design.md`, board goal ab-sta), approved by the operator (board item ab-lmv, 2026-11-21)." },
  { file: "ALLOW", why: "the format names the design that adds the two tools", text: "The secure card checkout design (`docs/superpowers/specs/2026-11-21-secure-card-checkout-design.md`, board goal ab-sta) adds the service's own tools `browser_pay` and `browser_pay_status`, which the service serves only with the payment act (C11, the card payment)." },
  { file: "ALLOW", why: "service_tools: five tools, and who answers them", old: "the service answers them itself (C11, the sign-in act and PageFetch). They are exactly these three, in every list:", text: "the service answers them itself (C11, the sign-in act, PageFetch and the card payment). They are exactly these five, in every list:" },
  { file: "ALLOW", why: "tools/list: the payment act serves the two tools", old: "(the sign-in act for `browser_sign_in` and `browser_sign_ins`, PageFetch for `PageFetch`);", text: "(the sign-in act for `browser_sign_in` and `browser_sign_ins`, PageFetch for `PageFetch`, the payment act for `browser_pay` and `browser_pay_status`);" },
  { file: "ALLOW", why: "tools/call: the answer of a remote admission", old: "`Not fetched (unavailable): PageFetch works only for sessions of this box.`, whatever its arguments.", text: "`Not fetched (unavailable): PageFetch works only for sessions of this box.`, and the answer of `browser_pay` and `browser_pay_status` is the tool error `Not paid: Payments work only for sessions of this box.`, whatever its arguments." },
  { file: "ALLOW", why: "tools/call: a local admission runs the payment act", old: "else the service runs the sign-in act's method or PageFetch for the MCP session's scope (C11, the sign-in act and PageFetch).", text: "else the service runs the sign-in act's method, PageFetch or the payment act for the MCP session's scope (C11, the sign-in act, PageFetch and the card payment)." },
];
/** A text of an earlier list as CARD_PAY changed it (the allow list's format names the two new tools). */
const payNow = (s: string) => { let t = flat(s); for (const e of CARD_PAY) if (e.old !== undefined && t.includes(flat(e.old))) t = t.replace(flat(e.old), flat(e.text)); return holdNow(t); };
/** The design's result texts (section 8.7), exactly. */
const PAY_RESULTS: Record<string, string> = {
  "Paid: <amount> <currency> to <origin>, order <number>": "paid",
  "Paid: <amount> <currency> to <origin>, order number not found": "paid",
  "Paid, but the merchant's confirmation shows <amount>": "paid",
  "Declined by the card's bank or the merchant": "declined",
  "The card's bank asked for a second step. The payment's result is unknown: check the merchant's account before you buy by hand.": "unknown",
  "The payment's result is unknown. Do not pay again: check the merchant's mail or account.": "unknown",
};
/** The stop texts that the design and the plan quote: the agent gets each of them as a stop. */
const PAY_DESIGN_STOPS = ["This checkout cannot move to the payment act", "This checkout's card fields are not in a known payment provider's frame", "This approval does not match the payment request", "A payment request of this scope waits."];

test("board goal ab-sta: C11's part on the card payment holds exactly the items of CARD_PAY, in order, and it is the last part of C11, after the sign-in act", () => {
  const p = partOr(CARD_PAY_HEADING);
  const items = CARD_PAY.filter((e) => e.file === "C11 part").map((e) => e.text);
  for (const s of items) assert.ok(says(p, s), `C11 says: ${s.slice(0, 120)}`);
  assert.equal(clean(p), items.join(" "), "the part holds no other text");
  const at = C11.indexOf(`**${CARD_PAY_HEADING}`);
  assert.ok(C11.indexOf(`**${SIGN_IN_HEADING}`) < at && C11.indexOf("\n**", at + 2) < 0, "the part comes after the sign-in act, at the end");
  assert.ok(p.split("\n").every((l) => (l.match(/`/g) ?? []).length % 2 === 0), "no code span over a line break");
  assert.ok(!/\/home\/|\/Users\//.test(p), "no box path");
  // No card number of any kind: no run of 12 or more digits, also in groups.
  assert.ok(!/\d(?:[ -]?\d){11,}/.test(p), "no card number");
});

test("board goal ab-sta: C11 and the allow list's format say each other text of CARD_PAY exactly, and each old text is gone", () => {
  for (const e of CARD_PAY.filter((x) => x.file !== "C11 part")) {
    const doc = e.file === "C11" ? C11 : ALLOWP;
    assert.ok(says(doc, holdNow(e.text)), `${e.file}, ${e.why}: ${e.text.slice(0, 120)}`);
    if (e.old !== undefined) assert.ok(!says(doc, e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
});

test("board goal ab-sta: the card payment's table gives one state and one text for each cause, the design's texts of section 8.7 exactly, the design's stops, no stop or start (I2) and no value of the card", () => {
  const p = partOr(CARD_PAY_HEADING);
  const lines = p.split("\n");
  const at = lines.indexOf("| The cause | The state | The text |");
  assert.ok(at > 0, "the table");
  const rows: { cause: string; state: string; text: string }[] = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith("| ")) break;
    const cells = line.slice(2, -2).split(" | ");
    assert.equal(cells.length, 3, line);
    rows.push({ cause: cells[0], state: cells[1], text: cells[2] });
  }
  assert.ok(rows.length >= 30, "each cause has a row");
  const texts = new Set<string>();
  for (const r of rows) {
    assert.ok(["`paid`", "`declined`", "`unknown`", "`stopped`"].includes(r.state), `${r.cause}: a state of PayResult`);
    const m = /^`([^`]+)`$/.exec(r.text);
    if (r.cause === "Not ready (check 1)") { assert.ok(r.text.startsWith("the 503 body of the readiness"), r.cause); continue; }
    assert.ok(m, `${r.cause}: one text`);
    assert.ok(!texts.has(m![1]), `${r.cause}: a text of its own`);
    texts.add(m![1]);
    assert.ok(!/\b(stop|start|restart)/i.test(m![1]), `${r.cause}: no stop or start of the agent browser (I2)`);
    assert.ok(!/\d{4}/.test(m![1].replace(/<[a-z]+>/g, "")), `${r.cause}: no digits of a card`);
    if (Object.hasOwn(PAY_RESULTS, m![1])) assert.equal(r.state, `\`${PAY_RESULTS[m![1]]}\``, `${r.cause}: the design's state`);
    else assert.equal(r.state, "`stopped`", `${r.cause}: a stop`);
  }
  for (const t of Object.keys(PAY_RESULTS)) assert.ok(texts.has(t), `the design's text: ${t}`);
  for (const t of PAY_DESIGN_STOPS) assert.ok(texts.has(t), `the design's stop: ${t}`);
  assert.ok([...texts].some((t) => t.includes("cannot read the total")), "the plan's stop: cannot read the total");
  assert.ok(texts.has("Payments work only for sessions of this box."), "the stop of a remote admission");
});

test("board goal ab-sta: the allow list holds browser_pay (six keys, the first five required) and browser_pay_status (no key) as the format gives them", async () => {
  const { SERVICE_TOOLS, readAllowList } = await import("../src/service/mcp/allow-list.ts");
  const pay = SERVICE_TOOLS.browser_pay, status = SERVICE_TOOLS.browser_pay_status;
  assert.ok(pay && status, "both tools");
  assert.deepEqual(pay.keys, ["card", "origin", "amount", "currency", "description", "button"]);
  assert.deepEqual(pay.schema.required, ["card", "origin", "amount", "currency", "description"]);
  assert.deepEqual(Object.keys(pay.schema.properties as object), pay.keys);
  assert.equal(pay.schema.additionalProperties, false);
  assert.deepEqual(status.keys, []);
  assert.deepEqual(status.schema, { type: "object", properties: {}, additionalProperties: false });
  // Board ab-t30.34 adds browser_press_hold after them.
  assert.deepEqual(Object.keys(SERVICE_TOOLS), ["browser_sign_in", "browser_sign_ins", "PageFetch", "browser_pay", "browser_pay_status", "browser_press_hold"]);
  assert.deepEqual(readAllowList().service_tools, SERVICE_TOOLS, "the list file holds them");
  const props = pay.schema.properties as Record<string, { pattern?: string; maxLength?: number }>;
  const amount = new RegExp(props.amount.pattern!), currency = new RegExp(props.currency.pattern!);
  for (const a of ["12.50", "0.5", "100", "3.00"]) assert.ok(amount.test(a), a);
  // review-224: the schema refuses zero, as the key's rule says ("above 0").
  for (const a of ["12.505", "-1", "1,00", "01.00", "", "0", "0.0", "0.00", "00"]) assert.ok(!amount.test(a), a);
  for (const a of ["0.01", "0.10", "10", "10.0"]) assert.ok(amount.test(a), a);
  assert.ok(currency.test("USD") && !currency.test("usd") && !currency.test("US"));
  assert.equal(props.description.maxLength, 500);
  assert.equal(props.button.maxLength, 100);
});

// Board ab-sta.6 (the secure card checkout, Task 5a): C11 says each text of CARD_COPY exactly, and each old text is gone
// (review-225's N1 and N2): no act kind `pay` and no "each request of the default context" is left in C11; the words name
// the receiver's two requests and rule 90 with its stated limit for the workers, and the code's values (the feature,
// the rule's id, the texts of the stops).
test("board ab-sta.6: C11's card text agrees with the receiver 0.3.15 and with the preparation (review-225 N1, N2): each text of CARD_COPY exactly, each old text gone; the values are the code's", async () => {
  for (const e of CARD_COPY) {
    assert.ok(says(C11, liveNow(e.text)), `${e.why}: ${e.text.slice(0, 120)}`);
    if (!e.old.startsWith("(new words")) assert.ok(!says(C11, e.old), `${e.why}: the old text is gone`);
  }
  assert.ok(!says(C11, "act kind `pay`"), "no act kind pay in C11");
  assert.ok(!says(C11, "blocks each request of the default context"), "rule 90 is not a block of the default context alone");
  // The card part holds the new texts in its items (CARD_PAY's items 7 and 25 are CARD_COPY's).
  const p = flat(partOr(CARD_PAY_HEADING));
  for (const e of CARD_COPY.slice(1)) assert.ok(p.includes(liveNow(e.text)), `the card part: ${e.why}`);
  assert.ok(flat(partOr(MERGE_GUARD_HEADING)).includes(liveNow(CARD_COPY[0].text)), "the release item of 0.3.15");
  // The values are the code's.
  const A = await import("../src/service/pay/act.ts");
  const { PAY_TEXT } = await import("../src/service/pay/texts.ts");
  assert.equal(A.PAY_FEATURE, "pay");
  assert.equal(A.ACT_FEATURE, "act");
  assert.equal(A.MERCHANT_RULE, 90);
  assert.equal(A.MAX_SEND_TO, 32);
  assert.equal(A.PAY_ACT_LIMITS.busyMs, 60_000, "check 8's 60 s");
  assert.ok(says(C11, "`The agent browser could not copy the checkout's session.`") && PAY_TEXT.copy === "The agent browser could not copy the checkout's session.");
  assert.equal(A.merchantDomain("co.uk", ""), null);
  assert.equal(A.merchantDomain("192.0.2.10", "192.0.2.10"), null);
  assert.equal(A.merchantDomain("shop.localhost", ""), "shop.localhost");
});

// Board ab-sta.8: C11 says each text of CARD_LIVE exactly (the rule-90 text twice: the release item of 0.3.15 and the
// request), each old text is gone; the card part's items hold them; the design says the same in its section 8.6; the
// values are the code's (no act_rules after the press; each provider's API origins; the second act_rules).
test("board ab-sta.8: C11 says that the act's rules stay after the press and hold the act's provider's frame and API origins from the start, that a body with the number goes only to the act's provider, and that rule 90 lets a dedicated worker of an act tab go, exactly (CARD_LIVE); each old text is gone; the design's section 8.6 agrees; the values are the code's", async () => {
  for (const e of CARD_LIVE) {
    assert.ok(says(C11, hostedNow(e.text)), `${e.why}: ${e.text.slice(0, 120)}`);
    if (!e.old.startsWith("(new words")) assert.ok(!says(C11, e.old), `${e.why}: the old text is gone`);
  }
  assert.equal(flat(C11).split(flat(CARD_LIVE[0].text)).length - 1, 2, "the rule-90 text in the release item of 0.3.15 and in the request");
  const p = flat(partOr(CARD_PAY_HEADING));
  for (const e of CARD_LIVE) assert.ok(p.includes(hostedNow(e.text)), `the card part: ${e.why}`);
  assert.ok(flat(partOr(MERGE_GUARD_HEADING)).includes(flat(CARD_LIVE[0].text)), "the release item of 0.3.15");
  assert.ok(!/act_rules`? again, with at most 32 origins/.test(flat(C11)) && !says(C11, "After the press the act's rules grow"), "no growth after the press");
  const design = flat(read("docs/superpowers/specs/2026-11-21-secure-card-checkout-design.md"));
  for (const w of ["After the press, the set stays as it was at the fill.", "so the act cannot learn a new host then (measured on the Linux server, board ab-sta.8)", "the frame and API origins of the one provider whose frames hold the card fields", "another provider's origin is no place for it"]) assert.ok(design.includes(w), `the design: ${w}`);
  assert.ok(!design.includes("the set grows by the hosts"), "the design's old text is gone");
  // The values are the code's: no act_rules after the preparation, each provider's API origins, the act's provider.
  const pa = read("src/service/pay/pay-act.ts");
  assert.ok(!/"act_rules"/.test(pa) && !/sendRules|rulesHeld/.test(pa), "the act sends no act_rules");
  const { PROVIDERS, providerHosts } = await import("../src/service/pay/providers.ts");
  assert.ok(PROVIDERS.find((x) => x.name === "stripe")!.api.includes("https://api.stripe.com"));
  const { MAX_SEND_TO } = await import("../src/service/pay/act.ts");
  assert.ok(PROVIDERS.every((x) => providerHosts(x).length + 1 <= MAX_SEND_TO), "each provider's origins fit in send_to with the request's origin");
});

// Board ab-sta.7 (the secure card checkout, Task 5b): C11 says each text of CARD_ACT exactly, and each old text is gone;
// the card part holds them in its items (CARD_PAY's items 1, 7, 27, 57, 69 and 75); the values are the code's (the
// option's name, the texts of the stops, the act's limits).
test("board ab-sta.7: C11 says that only a service started with --card-pay has the payment act, and the act's new rules, exactly (CARD_ACT); each old text is gone; the values are the code's", async () => {
  for (const e of CARD_ACT) {
    assert.ok(says(C11, liveNow(e.text)), `${e.why}: ${e.text.slice(0, 120)}`);
    if (!e.old.startsWith("(new words")) assert.ok(!says(C11, e.old), `${e.why}: the old text is gone`);
  }
  assert.ok(!says(C11, "no service has the payment act"), "no text says that no service has it");
  const p = flat(partOr(CARD_PAY_HEADING));
  for (const e of CARD_ACT.filter((_, i) => i !== 2)) assert.ok(p.includes(liveNow(e.text)), `the card part: ${e.why}`);
  // review-228 N9: the allow list's own words follow the option.
  assert.ok(!read("src/service/mcp/allow-list.ts").includes("No service has the payment act yet"));
  // review-228 N8, N10: the act item names the early number, the select, the same scheme and the unread body.
  for (const w of ["the act writes the keep's `unknown` at once", "a select of the expiry's month or year gets its option from a script", "with the listed origin's scheme", "A request whose body Chrome does not give fails too, unless it goes to the act's provider.", "that the act page's own focus is on the provider frame"]) assert.ok(p.includes(w), w);
  assert.ok(flat(partOr(MERGE_GUARD_HEADING)).includes(liveNow(CARD_ACT[2].text)), "the release item of 0.3.15");
  const { SERVICE_USAGE, serviceFeatures } = await import("../src/service/main.ts");
  assert.match(SERVICE_USAGE, / \[--card-pay\] /, "the option's name is the code's");
  assert.deepEqual(serviceFeatures("linux", true), ["sign_ins", "card_pay"]);
  assert.deepEqual(serviceFeatures("linux"), ["sign_ins"], "off by default");
  const { PAY_TEXT } = await import("../src/service/pay/texts.ts");
  const { PAY_FILL_LIMITS } = await import("../src/service/pay/pay-act.ts");
  const { MAX_SEND_TO } = await import("../src/service/pay/act.ts");
  assert.ok(says(C11, `| \`stopped\` | \`${PAY_TEXT.rules}\` |`) && says(C11, `| \`stopped\` | \`${PAY_TEXT.lostBefore}\` |`) && says(C11, `| \`stopped\` | \`${PAY_TEXT.frameLoaded}\` |`));
  assert.equal(PAY_FILL_LIMITS.actMs, 5 * 60_000, "C11's 5 minutes");
  assert.equal(PAY_FILL_LIMITS.resultMs, 60_000, "C11's 60 s");
  assert.equal(MAX_SEND_TO, 32, "C11's 32 origins");
});

// Board ab-sta.14: C11 says each text of CARD_HOSTED exactly, and each old text is gone; the card part holds them in its
// items (CARD_PAY's items 22, 25 and 51a), the new row right after check 6's; the design says the stop and its reason in
// its sections 8.4 and 14; the values are the code's (the text, and the act page's stop before the provider's rules).
test("board ab-sta.14: C11 says that a known provider's hosted payment page stops the card payment (check 6, the act page, the table's row), exactly (CARD_HOSTED); each old text is gone; the design's sections 8.4 and 14 agree; the values are the code's", async () => {
  for (const e of CARD_HOSTED) {
    assert.ok(says(C11, e.text), `${e.why}: ${e.text.slice(0, 120)}`);
    if (!e.old.startsWith("(")) assert.ok(!says(C11, e.old), `${e.why}: the old text is gone`);
  }
  const part = partOr(CARD_PAY_HEADING);
  for (const e of CARD_HOSTED) assert.ok(flat(part).includes(flat(e.text)), `the card part: ${e.why}`);
  const lines = part.split("\n");
  const at = lines.findIndex((l) => l.startsWith("| No tab of the origin, or more than one (check 6) |"));
  assert.ok(at > 0 && lines[at + 1] === CARD_HOSTED[2].text, "the new row comes right after check 6's row");
  assert.ok(!says(C11, "shows a page of the origin, or a known provider's hosted payment page"), "a hosted payment page passes check 6 nowhere");
  const design = flat(read("docs/superpowers/specs/2026-11-21-secure-card-checkout-design.md"));
  for (const w of ["A provider's hosted payment page (a page on the provider's own site, as the agent's tab or as the act page) stops the request for now with a text of its own (board ab-sta.14)",
    "The service cannot tie such a page to the merchant: it sees no server redirect of the merchant, and the agent can forge a link, a history entry or a referrer",
    "A checkout that pays on a provider's hosted payment page stops, and the operator buys by hand (board ab-sta.14, section 8.4)",
    // Review-232 N2: sections 3, 7.2 and 8.3 say the stop themselves.
    "The main frame of a provider's hosted payment page is no provider frame: such a page stops the request (board ab-sta.14, section 8.4).",
    "the merchant's origin (a provider's hosted payment page stops the request before the approval, board ab-sta.14, so the pane shows no provider's origin);",
    "A known provider's hosted payment page that the merchant's page sent it to ends the request with the text of a hosted payment page (board ab-sta.14, section 8.4)."]) assert.ok(design.includes(w), `the design: ${w.slice(0, 80)}`);
  for (const w of ["also the main frame of a provider's hosted payment page, when the merchant's page sends the act there",
    "and the provider's origin when the page pays through a provider's hosted page",
    "(or a known provider's hosted payment page that the merchant's page sent it to), the request ends with"]) assert.ok(!design.includes(w), `the design's old words are gone: ${w.slice(0, 80)}`);
  // The limits say the design's section 14 bullet (review-232 N3).
  const limits = flat(part.slice(part.indexOf("The limits, stated plainly.")));
  assert.ok(limits.includes(flat(CARD_HOSTED[4].text)), "the limits name the hosted page's stop");
  // The values are the code's: the row's text, and the act page's stop comes before any rule of a provider.
  const { PAY_TEXT } = await import("../src/service/pay/texts.ts");
  assert.ok(says(C11, `| \`stopped\` | \`${PAY_TEXT.hostedPage("<origin>")}\` |`), "the row's text is the code's");
  const act = read("src/service/pay/act.ts");
  assert.ok(act.indexOf("PAY_TEXT.hostedPage(this.request.origin)") > 0 && act.indexOf("PAY_TEXT.hostedPage(this.request.origin)") < act.indexOf("providerOfFields(frames, found"), "the act page's stop before the provider of the fields");
  assert.ok(!/provider_origin/.test(read("src/service/pay/request.ts").replace(/\/\/.*$/gm, "")), "the service sends no provider_origin");
  // Review-232 B1 and N1: the preparation checks the act page again after the order's read, and the act at its steps 2 and
  // 4; no card field of the main frame is ever filled.
  assert.ok(act.indexOf("this.step(this.samePage())") > act.indexOf("readOrder(this.session(), card)"), "the preparation's check after the order's read");
  const fill = read("src/service/pay/pay-act.ts");
  assert.ok(fill.indexOf("w.samePage()") > 0 && fill.indexOf("w.samePage()") < fill.indexOf("orderHash(order) !== this.ctx.order"), "the act's step 2");
  assert.ok(fill.indexOf("w.pageStop(") > 0 && fill.indexOf("w.pageStop(") < fill.indexOf("findCardFields(frames, this.extra)"), "the act's step 4");
  assert.ok(!fill.includes("t.frameId !== w.frame") && fill.includes("targets.some((t) => t.session === undefined)"), "no exception for a field of the main frame");
});


// ---- Board goal ab-4wh, Task 1 (ab-4wh.1): the blanket profile (docs/superpowers/specs/2026-11-25-blanket-profile-design.md) ----
// Today's cut for Linux (aw-lead and ab-lead, 2026-11-25). C11's new part "The blanket profile" holds exactly the items
// of BLANKET, in order, after PageFetch and before the sign-in act (the card payment stays the last part). C11's table of
// the self-contained agent browser gets one row, and the allow list's format one bullet. The texts follow the forms of
// the texts beside them, and the design note gives each of them exactly. The facts that the texts take from the code
// are the code's.
const BLANKET_HEADING = "The blanket profile (board ab-4wh; the blanket profile design).";
const BLANKET_DESIGN_PATH = "docs/superpowers/specs/2026-11-25-blanket-profile-design.md";
const BLANKET: { file: "C11 part" | "C11" | "ALLOW"; why: string; text: string }[] = [
  { file: "C11 part", why: "the blanket profile, item 1 (the heading and its paragraph)", text: "**The blanket profile (board ab-4wh; the blanket profile design).** The design is `docs/superpowers/specs/2026-11-25-blanket-profile-design.md`, today's cut for Linux (aw-lead and ab-lead, 2026-11-25). The operator's words (2026-11-25, agentwatch item age-qolw): \"i would do it for a session. a blanket approval for a specific session and that session gets its own profile with no cookies.\" A blanket scope opens any public host, but only in the blanket Chrome: a second agent Chrome on a new folder, with its own receiver and its own native link (C12, the blanket profile; C4, the blanket profile). Board ab-4wh.4 builds this part in the service on Linux, and board ab-4wh.16 on the Mac, where each new folder starts with a copy of the blanket template's two preference files, which hold the operator's one Load unpacked of the receiver (C12, the blanket profile on the Mac). The relay of the old path has no blanket profile." },
  { file: "C11 part", why: "the blanket profile, item 2 (The blanket scope)", text: "The blanket scope. The scope of the one item of C12's `set_sessions` with `\"blanket\": true` that has the blanket Chrome (C12). Its list is `\"*\"` (C4, the blanket profile): the public host class takes the list's place." },
  { file: "C11 part", why: "the blanket profile, item 3 (The routing)", text: "The routing. The service runs a second model whose bridge goes on the blanket link (C12). The blanket scope's upgrade of `/devtools/browser/<scope>` (the same endpoint URL) and its MCP ticket connection go to that model, and every other scope goes to the main model. The blanket model's allowlist line names only the blanket scope, with `\"*\"`, and the main model's line leaves it out. The scope sees only the blanket Chrome's tabs, windows, targets, downloads and events. The checks before the upgrade, the scope's session (the peer check) and the MCP path's admission stay as this file says. Each model's line admits only its own scopes. The service's sessions (the defensive root rules; boards ab-4wh.9 to ab-4wh.11) count also while a line is not there: the blanket Chrome is stopped, or a link is down. So a process of a nested session whose roots the service holds, or under a root that two such sessions name, never passes as another scope." },
  { file: "C11 part", why: "the blanket profile, item 4 (The readiness of a blanket scope)", text: "The readiness of a blanket scope. Step 4 before the upgrade and step 8 of the MCP path read the blanket link: the scope is ready when the blanket Chrome runs, its receiver's hello on the blanket link has the feature `blanket` (C4), the steps of the link up are done, and the receiver confirmed the `set_scopes` that gives the scope `\"*\"`. Else the answer is a 503 with one of these bodies: `The agent browser is not ready: the blanket profile's extension is not connected.` or, for a hello with no feature `blanket`, `The agent browser is not ready: the blanket profile's extension is too old for the blanket profile.` A use of the blanket scope starts only the blanket Chrome, and a failed start gives the start at a use's 503 (C12)." },
  { file: "C11 part", why: "the blanket profile, item 5 (The scope's list `'*'`)", text: "The scope's list `\"*\"`. The model applies C4's rule of `\"*\"` to the allowlist line, as the receiver applies it to `set_scopes`: each host of the public host class is on the scope's list, and every other host is off it. Layer 1: a client's call that loads a URL (`Page.navigate`, `Network.loadNetworkResource`, `Fetch.continueRequest` with a `url`, and `Target.createTarget` with a `url`) that passes the scheme rules (the refusals, above) and whose host is outside the class or is one of the box's own names (C12, `exclude`) gets the CDP error with the text `Not allowed: <host> is not a public host name. A session with a blanket approval opens public host names only: no IP address, no localhost, no single-label name, no name under .local, .internal, .home.arpa or .localdomain, and no name of this box.`, before any bridge request. The model makes no allow prompt for a blanket scope, and the service makes none from the blanket link: no list exists to allow a host into." },
  { file: "C11 part", why: "the blanket profile, item 6 (The client)", text: "The client. agentwatch's CLI writes `{\"allow\":[\"*\"]}` into the blanket scope's list copy, as it writes every list copy on its path, and the service writes no list copy for that scope (C12). agent-browser's client reads `\"*\"` as every host of the public host class (C4). agentwatch passes the same `--allowlist` path as today." },
  { file: "C11 part", why: "the blanket profile, item 7 (Permissions)", text: "Permissions. A blanket scope gets no permission grant: each grant call of \"Permissions and content settings\" (above) gets `Not available in the agent browser: permission grants in a session with a blanket approval.` The receiver's content settings check reads the lists, and the blanket Chrome has none (a later step)." },
  { file: "C11 part", why: "the blanket profile, item 8 (The refusals that stay)", text: "The refusals that stay. Every refusal of this file stays for a blanket scope, `Target.createBrowserContext` too. No method opens." },
  { file: "C11 part", why: "the blanket profile, item 9 (The service's own tools)", text: "The service's own tools. A `tools/list` of a blanket scope holds no tool of the allow list's `service_tools` but `browser_press_hold`, an input tool (the press and hold, above; board ab-t30.34). A call of one of the others is no use, passes no browser gate, sends no event, and gets a tool error (`isError: true`): `PageFetch` gets `Not fetched (unavailable): PageFetch does not work for a session with a blanket approval; open the page in this session's browser instead.`; `browser_sign_in` and `browser_sign_ins` get `Not signed in: Stored sign-ins do not work for a session with a blanket approval.`; and `browser_pay` and `browser_pay_status` get `Not paid: Payments do not work for a session with a blanket approval.` `AgentBrowser.signIn` and `AgentBrowser.signIns` of a blanket scope get the CDP error with the text `Stored sign-ins do not work for a session with a blanket approval.`" },
  { file: "C11 part", why: "the blanket profile, item 10 (The import and the send)", text: "The import and the send. The operator's send and the sign-in act's move (C12's `import`) go only to the shared profile's receiver. No import reaches the blanket Chrome (C12)." },
  { file: "C11 part", why: "the blanket profile, item 11 (Downloads)", text: "Downloads. As for a local scope: Chrome's own copy lands in the `Downloads` folder of the blanket Chrome's `HOME`, which goes with the blanket folder (C12), and the MCP's copies stay in the scope's folder `<state>/mcp/<scope>/` and go at the scope's end." },
  { file: "C11 part", why: "the blanket profile, item 12 (The input stage)", text: "The input stage. The two Chromes share one display, one X pointer and one clipboard: the blanket model takes the same input lock as the main model, so a paste's text on the clipboard never meets a key of the other Chrome. The blanket scope has no pointer paths (the pointer at an activation, above): its carrier has no X pointer, so that no X event of the blanket scope reaches a window of the main Chrome (board ab-4wh.15). Its probe `daemon.pointerAt` gets `no display`, and the paths stay off (each probe after the 60 s gets the same answer). So when a window of the blanket Chrome comes forward, its page gets the X server's pointer event at the X pointer's place, wherever the main model left it, with no path to it: a change of position that the page can see. The input stage works as in the main Chrome. A display of its own for the blanket Chrome would lift this limit. On the Mac (board ab-4wh.16) the blanket Chrome's windows are on the operator's screen, as the agent Chrome's are: there is no X pointer, no pointer path and no paste (the paste, above), and every input goes to Chrome at once, as in the main model on the Mac." },
  // Board ab-4wh.6 (the address proxy; the design, section 12) replaces item 13, the limits of today's cut (before: "The limits
  // of today's cut, stated plainly. The public host class judges a host's name, not its address: ... The next step (with
  // the Mac): PageFetch's address rule (PageFetch, above), with DNS, on every request of the scope's tabs, frames and workers.").
  { file: "C11 part", why: "the blanket profile, item 13 (The address proxy; board ab-4wh.6)", text: "The address proxy (board ab-4wh.6; the design, section 12). On Linux and on the Mac the blanket Chrome reaches the network only through the service's address proxy: a SOCKS5 proxy on `127.0.0.1`, on a port that the kernel picks at each start, that admits only a client of the service's uid (on Linux its line of `/proc/net/tcp`; on the Mac a socket of the blanket Chrome's own processes, its main process and that process's children, read with libSystem as the MCP path reads a socket there, with the same exact match of both addresses and ports, and the real uid of each holder). It listens from right before the blanket Chrome's start until that Chrome's stop, its end or a failed start, and at most 2 s after the Chrome exits by itself (C12, the start at a use). The service starts the blanket Chrome with `--proxy-server=socks5://127.0.0.1:<port>`, `--proxy-bypass-list=<-loopback>` (so loopback and link-local hosts go through the proxy too), `--webrtc-ip-handling-policy=disable_non_proxied_udp` and `--disable-quic`, before the config's `chrome_args` (C12). A client cannot give a browser context a proxy of its own: the model refuses `Target.createBrowserContext` and the `Extensions` domain (the refusals, above). Chrome sends each host to a SOCKS5 proxy unresolved. The proxy takes only `CONNECT` with the method \"no authentication\". A greeting of another SOCKS version gets no reply, and a method list without \"no authentication\" the answer `FF`. In the request, `BIND`, `UDP ASSOCIATE` and an unknown command get the reply `07`, an unknown address type `08`, and another SOCKS version, a reserved byte that is not 0, an empty or unprintable host or port 0 the reply `01`. Each of these closes the connection. It applies PageFetch's address rule (PageFetch, above) to each connection: an IP literal by its range; a name by its name, then by every address that the box's resolver gives for it (one refused address refuses it, and a name with no address is refused); and no address of the box's own network interfaces, read at each connection. It connects only to an address that it checked, so a name whose address changes after the check (DNS rebinding) never reaches a private address. So the rule holds for each request of the scope's tabs, frames and workers (service workers too), each WebSocket, WebRTC's TCP, the receiver's requests and Chrome's own traffic. A refused connection gets the reply `02` and fails as a network error (`net::ERR_SOCKS_CONNECTION_FAILED`), and the service logs one line with the kind of host and the reason, with no host, address, URL path or query (at most 20 lines in 10 s, then one line with the count). A connect that fails gets the reply `04`. The limits, so that no page can stop the service or the main Chrome: at most 256 client connections (one more closes at once, with no reply); the greeting and the request within 10 s and 600 bytes, else the connection closes with no reply; at most 2 lookups at a time and at most 64 that wait for one (a connection whose lookup would be one more is refused at once with `02`), and a connection whose lookup gives no answer in 10 s is refused (`02`); a waiting lookup whose connections all gave up starts no lookup, and a stop drops the waiting ones; the connect within 15 s, else the reply `04`; a name's checked addresses kept 60 s; after the reply the two sockets are piped, with no buffer of their own; when one side has ended, the other side must end within 30 s, else the proxy closes both; an open pair has no idle limit." },
  { file: "C11 part", why: "the blanket profile, item 14 (The limits, stated plainly; board ab-4wh.6)", text: "The limits, stated plainly. Chrome's Cast discovery (multicast, and the fetch of a device's description) and Chrome's DNS-over-HTTPS requests bypass the proxy; a page does not choose their addresses. A page's `dns-prefetch` still reaches the box's resolver, with no connection. A page sees three more differences: no HTTP/3, no WebTransport over HTTP/3, and no WebRTC UDP (only TCP through a TURN server). An enterprise policy of the box (`ProxySettings`, `ProxyOverrideRules`, `WebRtcIPHandling`) would override the flags or add rules to them; the service writes none. On Linux a process of the operator's uid can use the proxy, and it gains nothing by it; on the Mac only the blanket Chrome's own processes can (its peer check, above). After a crash of the service (a SIGKILL, the out-of-memory killer), the blanket Chrome runs on, because the service's unit has `KillMode=process` (systemd stops only the service's own process), until the service's next start stops it (C12, the service's start; agentwatch's unit starts the service again after 1 s, at most three times within 60 s, and then it stays down until its next start). In that time the proxy's port has no listener, so each request of the blanket Chrome fails, unless another process, also one of another uid, listens on that port first: that process then gets the blanket Chrome's connections. On the Mac (board ab-4wh.16) the blanket Chrome is a child of launchd, not of the service, so it also runs on after a crash of the service until the service's next start stops it, and launchd starts the service's job again after at least 10 s. The Mac's system proxy settings and its PAC do not apply to the blanket Chrome: the command line's proxy wins over them. On the Mac a connection to the public address of the operator's router can reach the router and its forwarded ports (hairpin NAT): that address is on no interface of the Mac, so the proxy does not know it." },
  { file: "C11 part", why: "the blanket profile, item 15 (The vectors)", text: "The vectors. Board ab-4wh.4 adds the blanket scope's cases to `test/vectors/endpoint.json`." },
  { file: "C11", why: "the self-contained agent browser's table: the row of the blanket profile", text: "| The blanket profile: one session's blanket approval in a second agent Chrome on a new folder, its routing and its public host class (the blanket profile, below; board ab-4wh) | agent-browser's service | board goal ab-4wh builds it on Linux, board ab-4wh.16 on the Mac |" },
  { file: "C11", why: "where the row of the blanket profile comes from", text: "The row of the blanket profile comes from the blanket profile design (`docs/superpowers/specs/2026-11-25-blanket-profile-design.md`, board ab-4wh), today's cut for Linux (aw-lead and ab-lead, 2026-11-25), and the Mac from its section 13 (board ab-4wh.16; the companion note `docs/superpowers/specs/2026-11-26-blanket-profile-mac-design.md`)." },
  { file: "ALLOW", why: "a blanket scope gets no service tool", text: "A blanket scope (C11, the blanket profile; board ab-4wh): its `tools/list` holds no tool of `service_tools`, also with a local admission, and a call of one gets the tool error of C11's part on the blanket profile, whatever its arguments." },
];
/** The texts of the blanket profile that an agent or a client reads (C11's part). */
const BLANKET_TEXTS = {
  layer1: "Not allowed: <host> is not a public host name. A session with a blanket approval opens public host names only: no IP address, no localhost, no single-label name, no name under .local, .internal, .home.arpa or .localdomain, and no name of this box.",
  grant: "Not available in the agent browser: permission grants in a session with a blanket approval.",
  fetch: "Not fetched (unavailable): PageFetch does not work for a session with a blanket approval; open the page in this session's browser instead.",
  signInTool: "Not signed in: Stored sign-ins do not work for a session with a blanket approval.",
  signInCdp: "Stored sign-ins do not work for a session with a blanket approval.",
  pay: "Not paid: Payments do not work for a session with a blanket approval.",
  notConnected: "The agent browser is not ready: the blanket profile's extension is not connected.",
  tooOld: "The agent browser is not ready: the blanket profile's extension is too old for the blanket profile.",
} as const;

test("board goal ab-4wh: C11's part on the blanket profile holds exactly the items of BLANKET, in order, after PageFetch and before the sign-in act", () => {
  const p = partOr(BLANKET_HEADING);
  const items = BLANKET.filter((e) => e.file === "C11 part").map((e) => e.text);
  for (const s of items) assert.ok(says(p, s), `C11 says: ${s.slice(0, 120)}`);
  assert.equal(clean(p), items.join(" "), "the part holds no other text");
  const at = C11.indexOf(`**${BLANKET_HEADING}`);
  assert.ok(C11.indexOf(`**${PAGE_FETCH_HEADING}`) < at && C11.indexOf("\n**", at + 2) === C11.indexOf(`\n**${SIGN_IN_HEADING}`), "after PageFetch, right before the sign-in act");
  assert.ok(p.split("\n").every((l) => (l.match(/`/g) ?? []).length % 2 === 0), "no code span over a line break");
  assert.ok(!/(?<![\w>])\/home\/|\/Users\//.test(p), "no box path");
  // Each text that an agent or a client reads is in the part, in a code span of its own.
  for (const [k, t] of Object.entries(BLANKET_TEXTS)) assert.ok(p.includes("`" + t + "`"), `the part gives the text ${k} in a code span`);
  // Linux, and the Mac since board ab-4wh.16 (the part says so, and "the Mac comes later" is gone). The address rule with DNS
  // is the address proxy (board ab-4wh.6).
  assert.ok(says(p, "Board ab-4wh.4 builds this part in the service on Linux, and board ab-4wh.16 on the Mac,") && !says(p, "The Mac comes later") && says(p, "The proxy takes only `CONNECT` with the method \"no authentication\"") && !says(p, "The next step (with the Mac)"));
});

test("board goal ab-4wh: C11 and the allow list's format say each other text of BLANKET exactly, with the mark (board ab-4wh)", () => {
  for (const e of BLANKET.filter((x) => x.file !== "C11 part")) {
    const doc = e.file === "C11" ? C11 : ALLOWP;
    assert.ok(says(doc, e.text), `${e.file}, ${e.why}: ${e.text.slice(0, 120)}`);
    assert.ok(e.text.includes("board ab-4wh"), `${e.why}: the mark`);
  }
});

test("board goal ab-4wh: the blanket profile's texts follow the forms of the texts beside them, name no stop or start (I2), and the design note gives each of them exactly", () => {
  const T = BLANKET_TEXTS;
  // PageFetch's form: `Not fetched (<code>): <sentence>`, with a code of PageFetch's table, as its remote admission's text.
  assert.ok(says(C11, "`Not fetched (unavailable): PageFetch works only for sessions of this box.`"));
  assert.match(T.fetch, /^Not fetched \(unavailable\): [A-Z]/);
  // The sign-in act's and the card payment's forms, as their remote admission's texts.
  assert.ok(says(ALLOWP, "`Not signed in: Stored sign-ins work only for sessions of this box.`") && T.signInTool === `Not signed in: ${T.signInCdp}`);
  assert.ok(says(ALLOWP, "`Not paid: Payments work only for sessions of this box.`") && T.pay.startsWith("Not paid: "));
  // Layer 1's form is the list's (`Not allowed: <host> ...`); the grant's is the other refusals'; the 503s are the readiness's.
  assert.ok(T.layer1.startsWith("Not allowed: <host> ") && says(C11, "`Not allowed: <host> is not on the allowlist`"));
  assert.ok(T.grant.startsWith("Not available in the agent browser: "));
  for (const t of [T.notConnected, T.tooOld]) assert.ok(t.startsWith("The agent browser is not ready: "), t);
  // I2: no agent's text names a stop or a start of the agent browser.
  for (const t of Object.values(T)) assert.ok(!/\b(stop|stops|stopped|start|starts|started|restart)\b/i.test(t), `no stop or start: ${t}`);
  // The design note gives each text exactly (its table of section 5).
  const design = readOr(BLANKET_DESIGN_PATH);
  for (const t of Object.values(T)) assert.ok(design.includes("`" + t + "`"), `the design note gives: ${t.slice(0, 100)}`);
});

test("board goal ab-4wh: the facts of the blanket texts are the code's: today's list entries, the refusals that stay, the agent Chrome's switches, the one incognito lock", async () => {
  // Today's lists cannot say "any host": an entry needs two labels and is no IP address, and "*" is no entry.
  for (const x of ["*", "intranet", "192.168.1.1"]) assert.equal(normalizeEntry(x), null, x);
  assert.equal(normalizeEntry("example.com"), "example.com");
  // Target.createBrowserContext stays refused, at policy.ts's line that the design names.
  const { refusal, TEXT } = await import("../src/relay/policy.ts");
  assert.equal(refusal("Target.createBrowserContext", {}, false), TEXT.newContext);
  assert.equal(read("src/relay/policy.ts").split("\n")[131].trim(), 'if (method === "Target.createBrowserContext") return TEXT.newContext;', "policy.ts, line 132");
  // The agent Chrome never runs with a remote-debugging switch (agent.ts), which is why no browser context exists.
  assert.ok(read("src/agent.ts").includes("It is NEVER started with --remote-debugging-port"));
  // One lock for the sign-in act and PageFetch, which rules out an incognito window.
  assert.ok(read("src/service/fetch/lock.ts").includes("All incognito windows of a Chrome share one cookie jar"));
  // The next step's rule exists: PageFetch's address rule.
  const { checkHost } = await import("../src/service/fetch/address.ts");
  assert.deepEqual(await checkHost("rebind.example", async () => ["10.0.0.7"]), { ok: false, why: "rebind.example has a private address" });
});

test("board goal ab-4wh: the design note says each decision of board ab-4wh.1, today's cut for Linux, and the build split of the board", () => {
  const d = flat(readOr(BLANKET_DESIGN_PATH));
  assert.ok(d.length > 1000, "the design note exists");
  for (const w of [
    "\"i would do it for a session. a blanket approval for a specific session and that session gets its own profile with no cookies.\"",
    "The Mac follows later (the Mac: a second profile with the operator's one Load unpacked).",
    // Why not an incognito window, and why not a CDP browser context.
    "**An incognito window: not chosen.** All incognito windows of one Chrome share one cookie jar.",
    "**A CDP browser context: not possible.** The agent Chrome never runs with `--remote-debugging-*`",
    // The decisions.
    "So the service learns the profile of a link from facts of the kernel: the socket that the shim reached, and the pid, the start time and the `--user-data-dir` of the shim's parent. No claim of the receiver takes part.",
    "At the blanket scope's first start the service deletes `<state>/blanket/` when it is there, and makes it new and empty (mode 0700). A start after a stop by use reuses it: the session lives, so its cookies stay for the session's life.",
    "**The start: at the blanket scope's first use,** as the start at a use (C12), not at the switch.",
    "The blanket Chrome stops by use after the same grace time (`idle_stop_minutes`), and the folder stays: the next use starts the blanket Chrome again on it, with the session's cookies. The daemon's `stop` and `enabled: false` stop the blanket Chrome and delete the folder.",
    "The door routes by scope:",
    "**The client.** agentwatch's CLI writes `{\"allow\":[\"*\"]}` into the blanket scope's list copy",
    "The service writes no list copy for the blanket scope (on the service path it writes every other scope's copy at each list change, `src/service/lists/copies.ts`), so it never overwrites the CLI's `\"*\"`; it still removes the scope's folder at the scope's end.",
    "**A public name that resolves to a private address** passes the host class",
    "**The DNS-rebinding race**",
    // Board ab-4wh.6 (before: "**The next step (with the Mac):** PageFetch's address rule (`src/service/fetch/address.ts`), with DNS, on every request"
    // and the row "| The box's local services and the LAN, by a public name that resolves to a private address | Yes, today |").
    "**The next step** was PageFetch's address rule with the model's own `Fetch` in each tab and a receiver floor. Board ab-4wh.6 chose the address proxy in its place (section 12)",
    "## 12. The address proxy (board ab-4wh.6, part 1: Linux)",
    "**The decision.** The service runs a small SOCKS5 proxy of its own for the blanket Chrome only, and the blanket Chrome reaches the network only through it.",
    // The threat model's rows.
    "| The shared profile's cookies | No |", "| Other scopes' tabs | No |",
    "| The box's local services and the LAN, by a public name that resolves to a private address, or by the box's own public address | No (Linux) |",
    "| The operator's signed-in sites | Only their public face |",
    // The build split of the board.
    "**ab-4wh.2**: the receiver", "**ab-4wh.3**: the service's blanket Chrome", "**ab-4wh.4**: the relay", "**ab-4wh.5**: the live checks",
  ]) assert.ok(d.includes(flat(w)), `the design note says: ${w.slice(0, 100)}`);
  const lines = readOr(BLANKET_DESIGN_PATH).split("\n");
  assert.ok(lines.length <= 400, `a short note: ${lines.length} lines`);
  assert.ok(lines.every((l) => (l.match(/`/g) ?? []).length % 2 === 0), "no code span over a line break");
  assert.ok(!/(?<![\w>])\/home\/|\/Users\//.test(d), "no box path");
});

// ---- Board ab-4wh.6, part 1 (Linux): the address proxy of the blanket Chrome (the design, section 12) ----
test("board ab-4wh.6: C11's address proxy and C12's start name the code's flags, switches, replies, limits and texts", async () => {
  const P = await import("../src/service/blanket/proxy.ts");
  const { WATCH_MS } = await import("../src/service/blanket/chrome.ts");
  const p = flat(partOr(BLANKET_HEADING));
  const item = p.slice(p.indexOf("The address proxy (board ab-4wh.6;"), p.indexOf("The limits, stated plainly."));
  assert.ok(item.length > 500, "the item of the address proxy");
  // The flags, in the code's order, before the config's chrome_args.
  const flags = P.proxyFlags(1).map((f) => f.replace("127.0.0.1:1", "127.0.0.1:<port>"));
  assert.ok(item.includes(`\`${flags[0]}\`, \`${flags[1]}\` (so loopback and link-local hosts go through the proxy too), \`${flags[2]}\` and \`${flags[3]}\`, before the config's \`chrome_args\` (C12).`), "the flags");
  // The replies (RFC 1928) and the limits, as the code has them.
  assert.deepEqual(P.REPLY, { ok: 0, failure: 1, notAllowed: 2, unreachable: 4, refused: 5, command: 7, addressType: 8 });
  for (const w of ["an unknown address type `08`", "the answer `FF`", "A refused connection gets the reply `02`",
    `at most ${P.LOG_LINES} lines in ${P.LOG_WINDOW_MS / 1000} s`, `at most ${P.MAX_CONNECTIONS} client connections`, `within ${P.HANDSHAKE_MS / 1000} s and ${P.MAX_HANDSHAKE_BYTES} bytes`,
    `at most ${P.LOOKUPS_AT_ONCE} lookups at a time`, `no answer in ${P.LOOKUP_MS / 1000} s is refused (\`02\`)`, `the connect within ${P.CONNECT_MS / 1000} s, else the reply \`04\``,
    `addresses kept ${P.CACHE_MS / 1000} s`, `and at most ${P.WAITING_LOOKUPS} that wait for one`, `the other side must end within ${P.HALF_CLOSE_MS / 1000} s, else the proxy closes both`,
    "an open pair has no idle limit", "another SOCKS version, a reserved byte that is not 0, an empty or unprintable host or port 0 the reply `01`", "`BIND`, `UDP ASSOCIATE` and an unknown command get the reply `07`",
    "A connect that fails gets the reply `04`."]) assert.ok(item.includes(w), `C11 says: ${w}`);
  // A client cannot give a context a proxy of its own: both refusals stay.
  const { refusal, TEXT } = await import("../src/relay/policy.ts");
  assert.equal(refusal("Target.createBrowserContext", { proxyServer: "socks5://10.0.0.1:1080" }, false), TEXT.newContext);
  assert.equal(refusal("Extensions.loadUnpacked", { path: "/x" }, false), "Not available in the agent browser: Extensions.loadUnpacked.");
  assert.ok(item.includes("the model refuses `Target.createBrowserContext` and the `Extensions` domain (the refusals, above)"));
  // C12: the start's sentences name the switches of the code and its reason text, and the watch's 2 s.
  const start = flat(C12P.slice(C12P.indexOf("- The start at a use. A use of the blanket scope"), C12P.indexOf("- The stop. The blanket Chrome stops by use")));
  assert.equal(WATCH_MS, 2_000);
  assert.ok(start.includes(`or at most ${WATCH_MS / 1000} s after the Chrome exits by itself.`) && !start.includes("so nothing listens while no blanket Chrome runs"), "the proxy's life, exactly (the review's I3)");
  assert.ok(item.includes(`and at most ${WATCH_MS / 1000} s after the Chrome exits by itself (C12, the start at a use).`) && !item.includes("listens only while the blanket Chrome runs"), "C11 says the same");
  assert.ok(start.includes(P.PROXY_SWITCHES.map((x, i) => (i === P.PROXY_SWITCHES.length - 1 ? `or \`--${x}\`` : `\`--${x}\``)).join(", ").replace(", or", " or")), "the six switches, in the code's order");
  assert.ok(start.includes("`" + (P.proxySwitchRefusal(["--proxy-server=x"]) ?? "").replace("--proxy-server", "--<switch>") + "`"), "the reason text");
  for (const a of ["-Proxy-Server=x", "/proxy-server"]) assert.ok(P.proxySwitchRefusal([a]) !== null && start.includes(a.replace("=x", "=...")), a);
});

// ---- Board ab-t30.34: the press and hold (an agent passes a press-and-hold check with a person's input) ----
// C11's new part holds exactly HOLD_ITEMS, in order, after the merge guard and before PageFetch. The changed sentences of
// C11 and the allow list's format are BOARD_T30_34 (old, then new; an empty old is a new sentence); aw-lead OKs them
// before the merge. The facts that the texts take from the code are the code's (src/human/hold.ts, the allow list).
const HOLD_HEADING = "The press and hold (board ab-t30.34).";
const HOLD_ITEMS: string[] = [
  "**The press and hold (board ab-t30.34).** The operator's words (2026-11-25): \"i found an interesting bot check today on fiverr. it was a button that i had to long-press. make sure you have something that can pass this.\" The check is most likely HUMAN Security's \"Press & Hold\" (the research note `docs/research/2026-11-26-press-and-hold-check.md`). Playwright MCP's vision cap stays off (ab-lead's decision, 2026-11-26), so no MCP client gets `browser_mouse_down` or `browser_mouse_up`: the service and the input stage control the hold's time, the hand's moves and the release, not the agent's turn time.",
  "The tool. The service's own tool `browser_press_hold` of the allow list's `service_tools` (`docs/contracts/mcp-allow-list.md`), with `ref` (required: a ref of the page snapshot, `e<n>` or `f<n>e<n>`, never a selector), `element` (the element's description, as `browser_click`'s) and `maxMs` (the hold's time limit: a whole number of ms from 1000 to 20000, 15000 by default, under `STAGE_ACTION_MAX_MS`). The MCP path's transport answers it itself. Another `ref` or `maxMs` gets the tool error `Not held: <why>` with no input.",
  "The admission and the scope. It is input, as the MCP's own input tools are: the service serves it to a local and to a remote admission, and to a blanket scope, while the scope's model has the input stage; else a call of it gets the allow list's `-32601`. A call of it is a tool call of its MCP session with each admission: it passes the browser gate, and it is a use while it runs, also after its client's close (C12, the use). Its hover (below) is the MCP's own call on the MCP's own connection, so the refusals, the scope's list and the input stage's rules of a client's input apply to it. The hold after the hover is input of the stage's own: it takes the input lock and the activation, and it has the stage's timestamps and rate (above). Unlike a client's press, it has the hand's moves, a read of the target's box before the press, the release's own time, the stage's own release at `STAGE_ACTION_MAX_MS`, and an answer at a dialog before the release (below).",
  // Board ab-t30.35 (m2; before: At the hover the stage keeps the target's `backendNodeId` (`DOM.describeNode` on the target's session).)
  "The element. The service sends the MCP session's worker the MCP's own `browser_hover` with `element` and the `ref` as `target`, under a request id of the service's own that no client sees. The MCP's Playwright finds the element by the ref, scrolls it into view and moves the pointer to it through the input stage (the hover, the frame mapping and the scroll, above), also in a cross-origin frame. An element in a closed shadow root has no ref of its own in the snapshot: the agent gives the ref of its host, and the press reaches the element under the point. The service puts nothing into the page: no attribute, and no script or event of the page's own world. While the hover runs, the model keeps each tab of the scope where a hit-target setup of the action `hover` comes, and the hold goes to that one tab. No such tab, or more than one, gets the tool error `Not held: <why>`, and so does a hover that fails (its text). The hover's path ends at a spread point of the target's box (the spread point, above: its offset rule and condition 4, the stage's own hit test of the top page; condition 3, the element's kind, does not apply: the agent chose a button to hold). At the hover the stage keeps the target's session (a cross-origin frame's own, else the tab's) and the target's `backendNodeId` on that session (`DOM.describeNode`). One hold of a scope runs at a time, from its call to its answer.",
  // Board ab-t30.35 (m2, m3; before: ... with no press; a read that fails goes on with the hover's box. Then `mousePressed` ...)
  "The press. A step of the stage's own in the tab's gate, so the tab's later calls wait for the hold's end, as an action of its own with the input lock and the activation: the pause before a press, from the hover's last move; then the target's box again (`DOM.getBoxModel` by its `backendNodeId`, mapped as the hover's box). When the press point is no longer in that box (another input changed the page after the hover), the answer is the tool error `Not held: the element is no longer under the pointer (the page changed after the hover); take a new snapshot and try again.` with no press. When Chrome or the link answers that read or the hover's `DOM.describeNode` with an error (the element left the document or has no box, the page navigated, or the tab's debugger or the link is gone), the answer is the tool error `Not held: the element is gone or has no box (the page changed after the hover); take a new snapshot and try again.` with no press. The answer is the same when the target's cross-origin frame loads a new document, or its session ends, between the hover and the press (the hover records that frame: end 3, below). A read with no answer in `GEOMETRY_WAIT_MS`, and a hover whose `DOM.describeNode` gave no `backendNodeId` in that time, go on with the hover's box, and the stage counts each. When the stage knows of an open dialog at the hold's start or before the press (its `Page.javascriptDialogOpening` came; also a dialog that opened during the hover: the pinned MCP answers that hover with its modal state and no error), the answer is the tool error `Not held: the page has a dialog open; handle the dialog, then take a new snapshot and try again.` with no press. A dialog whose `Page.javascriptDialogOpening` comes after the press is end 6. Then `mousePressed` with `button` left, `buttons` 1, `clickCount` 1 and `force` 0.5 at the end of the hover's path.",
  "The hand. During the hold the stage sends a `mouseMoved` with `button` left and `buttons` 1 at random gaps of 150 to 600 ms: a step of 1 px along one axis, never more than 2 px from the press point. Chrome starts a drag only at a move more than 4 px from the press on one axis (the drag, above), so no move starts a drag, and the stage's drag step takes none of these moves: it takes only a client's calls.",
  "The end of the hold, the first of these:",
  "The done state. Each 100 ms (counted from the end of the read before) the stage reads the pixels of the target's box inside the viewport, in whole CSS px (`Page.captureScreenshot` with that clip, in the page's document points). Each read has the limit `GEOMETRY_WAIT_MS` (200 ms), and a read that comes later counts as no read. The done state is a change of the pixels and then the same pixels for 300 ms. It means only that the box's pixels stopped changing (a fill that is full, a check mark), not the page's verdict. The read works through a cross-origin frame and a closed shadow root. The clip is the whole box: a fill that crosses a small part of the box leaves that part the same, which would look like the done state.",
  "A navigation of the main frame: its start (a cross-document navigation) or its commit.",
  // Board ab-t30.35 (m2, m4; before: A new document of the target's cross-origin frame (its `Page.frameNavigated` on the frame's own session), or the end of that frame's session.)
  "A new document of the target's cross-origin frame (a `Page.frameNavigated` of that frame's id on the frame's own session; the hover records both, also with no `backendNodeId`), or the end of that frame's session. A new document of another frame, also of a frame inside the target's frame, does not end the hold.",
  "The element gone: the element at the press point in the stage's own isolated world (a frame's owner, a shadow root's host) leaves the document or has no box.",
  "The time limit `maxMs`, from the press's send.",
  "An end of the plan: a dialog (dialogs, above), where the answer goes at once and the end's steps release the button at the dialog's close, after the agent handles it; an event with no answer in `STAGE_EVENT_WAIT_MS`, where the end's steps release it; the action's limit `STAGE_ACTION_MAX_MS`, Chrome's refusal of a hand move, and an error of the stage after the press, where the stage releases the button at once; and the tab's end.",
  "The release. `mouseReleased` at the hand's last point: 150 to 400 ms after the done state, and at once after a navigation, a new document of the frame, an element gone or the time limit. So the release comes about 450 to 900 ms after a check mark appears: the 300 ms of the same pixels, up to 100 ms to the next read and the read's own time, and the release's delay.",
  "The answer, a tool result: `Done: the hold lasted <n> ms; it ended when the element's pixels changed and then stayed the same. That is not the page's verdict: take a new snapshot to see the page.`; `Navigated: the hold lasted <n> ms; the page navigated, so the agent browser released the button at once.`; `Frame loaded: the hold lasted <n> ms; the element's frame loaded a new document, so the agent browser released the button at once.`; `Element gone: the hold lasted <n> ms; the element went away, so the agent browser released the button at once.`; `Time limit: the hold lasted <n> ms, the limit of <maxMs> ms; <why>.`, where `<why>` is `the element did not change`, `the element did not stop changing` or `the agent browser could not read the element's pixels`; `Not held to the end: the hold lasted <n> ms; <why>.` (a tool error) at an end of the plan or an error of the stage, where `<why>` says \"released\" only when the release went before the answer, and \"releases\" when it goes later: `the page opened a dialog; handle the dialog, and the agent browser releases the button when it closes`, `Chrome did not answer an event in 2000 ms; the agent browser releases the button when it has the input lock again`, `the action reached the input stage's limit of 25000 ms, and the agent browser released the button`, `Chrome refused a move of the hand, and the agent browser released the button`, `the tab went away`, `the input stage failed during the hold, and the agent browser released the button`, `the input stage failed during the hold; the page has a dialog open, and the agent browser releases the button when it closes`, `the input stage failed during the hold; the agent browser releases the button when it has the input lock again`, `the input stage failed during the hold; the button is up` or `the input stage failed during the hold, and the tab went away`; and with no press the tool error `Not held: <why>`. The log line: `mcp: MCP session <n> (scope <scope>): a press and hold ended (<end>, <n> ms)`, or `mcp: MCP session <n> (scope <scope>): a press and hold did not press`.",
  "A Playwright client's own hold. `mouse.down()`, a wait and `mouse.up()` go through the stage as any press and release (the pointer, above): the release goes at the later of its arrival and the press plus the person's hold, so the hold lasts the client's time. At `STAGE_ACTION_MAX_MS` the input lock goes free, and the button stays down until the client's release (the input lock, above). The stage adds no hand moves to a client's own hold.",
  // Board ab-t30.35 (m2's overlay and m1, limits: two sentences after "... see its effects.")
  "The limits, stated plainly. The first values come from public sources (the research note) and from no recording of a person's long hold; a Mac recording on the local test page can calibrate the release's delay. A press-and-hold check scores more than the hold (the research note: its sensor's other signals, a proof of work, the address's reputation), so a hold of a person's form does not pass each such check. A new document of a frame in the page's own process (a same-site frame) that holds the target does not end the hold by itself: the reads of the pixels and of the element see its effects. The read before the press checks the target's box only: an element that covers the target while the target's box stays the same is not seen, and the press goes to that element. When the MCP session's connection ends, the link ends, or Chrome detaches the tab while its page stays (for example at the Cancel button of Chrome's debugging infobar), while the hold's dialog is open (end 6), the stage sends the release at once (dialogs, above). At the connection's end Chrome gets it while the dialog is open and drops it; at the link's end the link answers it `not connected`, and at Chrome's detach the tab has no debugger, so it does not reach Chrome. The stage keeps no state of the tab after that end, so no release follows the dialog's later close: a page that stays gets no `mouseup` of the hold. A dialog that is open in Chrome at the press, but whose `Page.javascriptDialogOpening` comes after the press, ends the hold at that event (end 6): Chrome drops the press, and at the dialog's close the end's steps send the release, so the page gets a `mouseup` with no `mousedown` before it. The stage does not tell this press apart from one that Chrome took before the dialog opened. When the hover kept no target (a plain attempt at the recovery limit, or a hover whose frame mapping failed: the hover, above), the hold has no box check before the press, no pixel reads, no frame end (end 3) and no count of its own. A live test on a public site is the operator's decision (board ab-t30's limit). There is no hold of a key.",
  "The live check: `test/live/press-hold/check.ts`, on local pages only (two local sites: the button on the page, in a cross-origin frame and in a closed shadow root). It fails when the page gets a `resize`, a `visualViewport` `resize` or `scroll`, or a change of a `matchMedia` query during a hold."
];
const BOARD_T30_34: { file: "C11" | "C12" | "ALLOW"; why: string; old: string; text: string }[] = [
  { file: "C11", why: "the MCP inside the service: the press and hold for each admission", old: "(a local admission: the sign-in act, below).", text: "(a local admission: the sign-in act, below), but `browser_press_hold`, an input tool, for each admission (the press and hold, below; board ab-t30.34)." },
  { file: "C11", why: "the input stage: the hand's moves of the stage's own hold are no idle moves", old: "No idle moves: the pointer moves only for a client's call (the answer Q4 a).", text: "No idle moves: the pointer moves only for a client's call (the answer Q4 a) and for the hand in the stage's own hold of `browser_press_hold` (the press and hold, below; board ab-t30.34)." },
  { file: "C11", why: "the blanket profile: a blanket scope gets the press and hold", old: "A `tools/list` of a blanket scope holds no tool of the allow list's `service_tools`. A call of one is no use,", text: "A `tools/list` of a blanket scope holds no tool of the allow list's `service_tools` but `browser_press_hold`, an input tool (the press and hold, above; board ab-t30.34). A call of one of the others is no use," },
  { file: "ALLOW", why: "where the press and hold comes from", old: "", text: "Board ab-t30.34 (a press-and-hold check) adds the service's own tool `browser_press_hold`, an input tool (C11, the press and hold)." },
  { file: "ALLOW", why: "service_tools: six tools", old: "They are exactly these five, in every list:", text: "They are exactly these six, in every list:" },
  { file: "C12", why: "the use: a call of browser_press_hold with each admission (review of board ab-t30.34, M2)", old: "also after its client's close (C11, the sign-in act and PageFetch). An open MCP session", text: "also after its client's close (C11, the sign-in act and PageFetch). A call of `browser_press_hold` with each admission stays a use until it ends, also after its client's close (C11, the press and hold; board ab-t30.34). An open MCP session" },
  { file: "ALLOW", why: "tools/list: the press and hold for each admission (review of board ab-t30.34, M2)", old: "part that serves each of them (C11), after the tools of `tools`,", text: "part that serves each of them (C11), and `browser_press_hold` for each admission (below), after the tools of `tools`," },
  { file: "ALLOW", why: "the press and hold's admission, blanket scope and -32601", old: "", text: "`browser_press_hold` (C11, the press and hold; board ab-t30.34) is input, as the MCP's own input tools are: the rules above for a remote admission and for a blanket scope do not apply to it. The service adds it to the `tools/list` of each admission and of a blanket scope while the scope's model has the input stage, and it answers a call of it with each admission as for a local admission (its `-32602` answers above, else the press and hold for the MCP session's scope). While the scope's model has no input stage, a call of it gets the `-32601` answer of a tool that `tools` does not name." },
];
/** A text of an earlier board as BOARD_T30_34 changed it. */
function holdNow(s: string): string { let t = flat(s); for (const e of BOARD_T30_34) if (e.old && t.includes(flat(e.old))) t = t.replace(flat(e.old), flat(e.text)); return t; }

test("board ab-t30.34: C11's part on the press and hold holds exactly HOLD_ITEMS, in order, after the merge guard and before PageFetch", () => {
  const p = partOr(HOLD_HEADING);
  for (const s of HOLD_ITEMS) assert.ok(says(p, s), `C11 says: ${s.slice(0, 120)}`);
  assert.equal(clean(p), HOLD_ITEMS.join(" "), "the part holds no other text");
  const at = C11.indexOf(`**${HOLD_HEADING}`);
  assert.equal(C11.lastIndexOf("\n**", at - 2), C11.indexOf(`\n**${MERGE_GUARD_HEADING}`), "after the merge guard");
  assert.equal(C11.indexOf("\n**", at + 2), C11.indexOf(`\n**${PAGE_FETCH_HEADING}`), "right before PageFetch");
  assert.ok(p.split("\n").every((l) => (l.match(/`/g) ?? []).length % 2 === 0), "no code span over a line break");
  assert.ok(!/(?<![\w>])\/home\/|\/Users\//.test(p), "no box path");
});

test("board ab-t30.34: C11 and the allow list's format say each changed text of BOARD_T30_34 exactly, and no old text", () => {
  const files: Record<string, string> = { C11, C12: C12P, ALLOW: ALLOWP };
  assert.equal(BOARD_T30_34.length, 8);
  for (const e of BOARD_T30_34) {
    assert.ok(says(files[e.file], e.text), `${e.file}, ${e.why}: ${e.text.slice(0, 160)}`);
    if (e.old && !e.text.includes(e.old)) assert.ok(!says(files[e.file], e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
  // The C11 sentence of the MCP inside the service: its old end is gone (its new text starts with it).
  assert.ok(!says(C11, "only for a request that the MCP port admitted with the walk (a local admission: the sign-in act, below).\n"));
  assert.ok(!says(C11, "No idle moves: the pointer moves only for a client's call (the answer Q4 a). "));
});

test("board ab-t30.34: the facts of the texts are the code's: the hold's values, its answers, the tool's rule, the research note", async () => {
  const p = flat(partOr(HOLD_HEADING));
  const { HOLD, holdText, SNAPSHOT_REF } = await import("../src/human/hold.ts");
  const { SERVICE_TOOLS, HOLD_TOOL } = await import("../src/service/mcp/allow-list.ts");
  const { STAGE_ACTION_MAX_MS } = await import("../src/relay/stage.ts");
  // The values that the part names.
  assert.deepEqual([HOLD.minMs, HOLD.maxMs, HOLD.defaultMs, HOLD.moveGapMs, HOLD.moveMaxPx, HOLD.readMs, HOLD.stableMs, HOLD.releaseAfterMs], [1000, 20000, 15000, [150, 600], 2, 100, 300, [150, 400]]);
  assert.ok(HOLD.maxMs < STAGE_ACTION_MAX_MS);
  for (const w of ["from 1000 to 20000, 15000 by default", "at random gaps of 150 to 600 ms", "never more than 2 px from the press point", "Each 100 ms (counted from the end of the read before) the stage reads", "the same pixels for 300 ms", "150 to 400 ms after the done state"]) assert.ok(p.includes(w), w);
  // The answers that the part gives are holdText's, with <n> for the numbers; only the done state starts with Done.
  const base = { ok: true as const, heldMs: 1, moves: 0, maxMs: 2, pixels: "changing" as const };
  const n = (t: string) => t.replace(/\b1 ms\b/, "<n> ms").replace(/\b2 ms\b/, "<maxMs> ms");
  for (const end of ["done", "navigation", "frame", "gone"] as const) assert.ok(p.includes("`" + n(holdText({ ...base, end })) + "`"), n(holdText({ ...base, end })));
  assert.ok(p.includes("`Time limit: the hold lasted <n> ms, the limit of <maxMs> ms; <why>.`") && holdText({ ...base, end: "limit" }).startsWith("Time limit: the hold lasted 1 ms, the limit of 2 ms; "));
  for (const why of ["the element did not change", "the element did not stop changing", "the agent browser could not read the element's pixels"]) assert.ok(p.includes("`" + why + "`") && [holdText({ ...base, end: "limit", pixels: "still" }), holdText({ ...base, end: "limit" }), holdText({ ...base, end: "limit", pixels: "none" })].some((t) => t.endsWith(`; ${why}.`)), why);
  assert.ok(p.includes("`Not held to the end: the hold lasted <n> ms; <why>.`") && holdText({ ...base, end: "stopped", why: "x" }) === "Not held to the end: the hold lasted 1 ms; x.");
  assert.ok(p.includes("`Not held: <why>`") && holdText({ ok: false, why: "x." }) === "Not held: x.");
  // The reasons of an early end are the code's (HOLD_WHY), each in the part; "released" only where the release went before
  // the answer (the limit, a refused move, an error with the button sent), "releases" where it goes later.
  const { HOLD_WHY } = await import("../src/relay/stage.ts");
  for (const [k, w] of Object.entries(HOLD_WHY)) assert.ok(p.includes("`" + w + "`"), `the part gives ${k}: ${w}`);
  for (const k of ["dialog", "wait", "errorDialog", "errorWait"] as const) assert.ok(HOLD_WHY[k].includes("releases the button") && !HOLD_WHY[k].includes("released"), k);
  for (const k of ["limit", "move", "error"] as const) assert.ok(HOLD_WHY[k].includes("released the button"), k);
  // The texts of the stage that the part quotes (the dialog's, the moved element's) are the code's.
  const stage = read("src/relay/stage.ts");
  for (const t of ["the element is no longer under the pointer (the page changed after the hover); take a new snapshot and try again."]) assert.ok(stage.includes(`"${t}"`) && p.includes(t), t);
  assert.ok(p.includes("Each read has the limit `GEOMETRY_WAIT_MS` (200 ms)") && p.includes("about 450 to 900 ms after a check mark appears"));
  // The tool's rule: its keys, the ref's form, maxMs's bounds; the transport's log lines.
  const r = SERVICE_TOOLS[HOLD_TOOL] as any;
  assert.deepEqual(r.keys, ["element", "ref", "maxMs"]);
  assert.deepEqual(r.schema.required, ["ref"]);
  assert.equal(r.schema.properties.ref.pattern, SNAPSHOT_REF.source);
  assert.deepEqual([r.schema.properties.maxMs.minimum, r.schema.properties.maxMs.maximum], [HOLD.minMs, HOLD.maxMs]);
  const transport = read("src/service/mcp/transport.ts");
  assert.ok(transport.includes("a press and hold ${r.ok ? `ended (${r.end}, ${r.heldMs} ms)` : \"did not press\"}") && p.includes("`mcp: MCP session <n> (scope <scope>): a press and hold ended (<end>, <n> ms)`"));
  assert.ok(transport.includes('name: "browser_hover", arguments: { ...(typeof a.element === "string" ? { element: a.element } : {}), target: a.ref }'), "the MCP's own browser_hover with the ref as target");
  // The research note: public sources only, no vendor code, and the decision on the vision cap.
  const note = readOr("docs/research/2026-11-26-press-and-hold-check.md");
  assert.ok(note.length > 2000, "the research note exists");
  for (const w of ["no site with a bot check was opened, and no vendor code was read or taken apart", "ab-lead kept Playwright MCP's vision cap off", "https://docs.humansecurity.com/applications/human-challenge"]) assert.ok(flat(note).includes(w), w);
  assert.ok(!/(?<![\w>])\/home\/|\/Users\//.test(note), "no box path");
});

// ---- Board ab-t30.35: the press and hold's edges (the narrow re-check of board ab-t30.34: m1 to m4) ----
// The changed sentences of C11's part on the press and hold (old, then new; an empty old is a new sentence); aw-lead OKs
// them before the merge. The no-press reasons that the part quotes are the code's (HOLD_NOT).
const BOARD_T30_35: { why: string; old: string; text: string }[] = [
  { why: "m2: the hover keeps the target's session apart from its backendNodeId", old: "At the hover the stage keeps the target's `backendNodeId` (`DOM.describeNode` on the target's session).", text: "At the hover the stage keeps the target's session (a cross-origin frame's own, else the tab's) and the target's `backendNodeId` on that session (`DOM.describeNode`)." },
  { why: "m2: Chrome's error refuses the press; no answer in time goes on, counted", old: "with no press; a read that fails goes on with the hover's box. Then `mousePressed`", text: "with no press. When Chrome or the link answers that read or the hover's `DOM.describeNode` with an error (the element left the document or has no box, the page navigated, or the tab's debugger or the link is gone), the answer is the tool error `Not held: the element is gone or has no box (the page changed after the hover); take a new snapshot and try again.` with no press. The answer is the same when the target's cross-origin frame loads a new document, or its session ends, between the hover and the press (the hover records that frame: end 3, below). A read with no answer in `GEOMETRY_WAIT_MS`, and a hover whose `DOM.describeNode` gave no `backendNodeId` in that time, go on with the hover's box, and the stage counts each." },
  { why: "m3: a dialog that is open at the hold's start or before the press", old: "", text: "When the stage knows of an open dialog at the hold's start or before the press (its `Page.javascriptDialogOpening` came; also a dialog that opened during the hover: the pinned MCP answers that hover with its modal state and no error), the answer is the tool error `Not held: the page has a dialog open; handle the dialog, then take a new snapshot and try again.` with no press. A dialog whose `Page.javascriptDialogOpening` comes after the press is end 6. Then `mousePressed`" },
  { why: "m2 and m4: the frame's end by the kept session and the frame's own id", old: "A new document of the target's cross-origin frame (its `Page.frameNavigated` on the frame's own session), or the end of that frame's session.", text: "A new document of the target's cross-origin frame (a `Page.frameNavigated` of that frame's id on the frame's own session; the hover records both, also with no `backendNodeId`), or the end of that frame's session. A new document of another frame, also of a frame inside the target's frame, does not end the hold." },
  { why: "m2: the overlay, a limit", old: "", text: "The read before the press checks the target's box only: an element that covers the target while the target's box stays the same is not seen, and the press goes to that element." },
  { why: "m1 (the review's I1 and M6): the end of the session's connection, of the link or Chrome's detach with the hold's dialog open, a limit", old: "", text: "When the MCP session's connection ends, the link ends, or Chrome detaches the tab while its page stays (for example at the Cancel button of Chrome's debugging infobar), while the hold's dialog is open (end 6), the stage sends the release at once (dialogs, above). At the connection's end Chrome gets it while the dialog is open and drops it; at the link's end the link answers it `not connected`, and at Chrome's detach the tab has no debugger, so it does not reach Chrome. The stage keeps no state of the tab after that end, so no release follows the dialog's later close: a page that stays gets no `mouseup` of the hold." },
  { why: "the review's I2: a dialog whose event comes after the press, a limit", old: "", text: "A dialog that is open in Chrome at the press, but whose `Page.javascriptDialogOpening` comes after the press, ends the hold at that event (end 6): Chrome drops the press, and at the dialog's close the end's steps send the release, so the page gets a `mouseup` with no `mousedown` before it. The stage does not tell this press apart from one that Chrome took before the dialog opened." },
  { why: "the review's M4: a hover that kept no target, a limit", old: "", text: "When the hover kept no target (a plain attempt at the recovery limit, or a hover whose frame mapping failed: the hover, above), the hold has no box check before the press, no pixel reads, no frame end (end 3) and no count of its own." },
];

test("board ab-t30.35: C11's part on the press and hold says each changed text of BOARD_T30_35 exactly, and no old text; its no-press reasons are the code's", async () => {
  const p = partOr(HOLD_HEADING);
  assert.equal(BOARD_T30_35.length, 8);
  for (const e of BOARD_T30_35) {
    assert.ok(says(p, e.text), `${e.why}: ${e.text.slice(0, 160)}`);
    if (e.old) assert.ok(!says(p, e.old), `${e.why}: the old text is gone`);
  }
  // The texts of the first round that the review's fix round made exact are gone (the review of board ab-t30.35: I1, I2, M5).
  for (const t of ["and Chrome drops it because the dialog is open.", "When Chrome answers that read or the hover's `DOM.describeNode` with an error", "When the page has a dialog open at the hold's start or before the press", "which the hover kept, also with no `backendNodeId`"]) assert.ok(!says(p, t), `gone: ${t}`);
  // The limit of m1 is in the part's limits, and the m3 sentence in the press, before the press's event.
  assert.ok(flat(HOLD_ITEMS.find((s) => s.startsWith("The limits, stated plainly."))!).includes(flat(BOARD_T30_35[5].text)));
  assert.ok(flat(HOLD_ITEMS.find((s) => s.startsWith("The press."))!).includes(flat(BOARD_T30_35[2].text)));
  // The no-press reasons that the part quotes are the stage's HOLD_NOT, each as the answer `Not held: <why>`.
  const { HOLD_NOT } = await import("../src/relay/stage.ts");
  const { holdText } = await import("../src/human/hold.ts");
  assert.deepEqual(Object.keys(HOLD_NOT), ["dialog", "moved", "gone"]);
  for (const [k, w] of Object.entries(HOLD_NOT)) assert.ok(says(p, "`" + holdText({ ok: false, why: w }) + "`"), `the part gives ${k}: ${w}`);
  // The stage uses them: a dialog, Chrome's error at a read of the target, and the frame's session apart from the node.
  const stage = read("src/relay/stage.ts");
  for (const t of ["return answer({ ok: false, why: HOLD_NOT.dialog });", "if (now === REFUSED) { this.count(\"holdBoxErrors\"); return { ok: false, why: HOLD_NOT.gone }; }",
    "if (aim?.nodeError) { this.count(\"holdNodeErrors\"); return { ok: false, why: HOLD_NOT.gone }; }", "if (st.holdFrame?.loaded) { this.count(\"holdFrameLoads\"); return { ok: false, why: HOLD_NOT.gone }; }",
    "st.holdFrame = child !== undefined ? { child, frameId: st.frames.get(child)?.frameId, loaded: false } : null;"]) assert.ok(stage.includes(t), t);
});
