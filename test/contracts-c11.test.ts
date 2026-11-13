// Contract C11 (the endpoint): docs/contracts/C11.md is its master since board task ab-v16.94.1, and
// test/vectors/endpoint.json its vectors. Both came from chrome-extension (docs/protocol.md and test/vectors/endpoint.json
// at main 66078cd), with these tests: they moved from chrome-extension's test/contracts.test.mjs with the text, so that
// the tests stay beside the text that they read. The small reference rules below follow the text, so a vector that breaks
// a rule fails here first. The bridge's constants (C10) come from the copy of chrome-extension's bridge.json at 8a3b66f
// (its constants and pointer constants are the same at 66078cd). Tests for the parts that the self-contained agent
// browser adds (board ab-v16.94: the service, the MCP path, the per-session MCP configuration) are at the end, and after them
// the tests of the input stage (board ab-t30.6, task ab-t30.8): its part of C11 and test/vectors/stage.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizeEntry } from "../src/relay/scopes.ts";
import { PLAYWRIGHT_FOCUS } from "../src/relay/policy.ts";
import { charKey } from "../src/record.ts";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
// A missing file reads as "", so each assertion fails on its own (tests first).
const readOr = (p: string) => { try { return read(p); } catch { return ""; } };
const C11 = readOr("docs/contracts/C11.md");
const endpoint = JSON.parse(read("test/vectors/endpoint.json"));
const bridge = JSON.parse(read("test/vectors/chrome-extension-8a3b66f/bridge.json"));
const K = bridge.constants;
const PK = bridge.pointerConstants;
const SCOPE = new RegExp(endpoint.scope.pattern);

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

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
// Whether a contract's text says s, whatever its line breaks.
const flat = (t) => t.replace(/\s+/g, " ");
const says = (text, s) => flat(text).includes(flat(s));

// C4's rules for set_scopes, which the relay applies to its allowlist line (C10, C11). The list entries follow C5
// (normalizeEntry: the relay's own; no rule of C11 depends on an entry).
const NAME = SCOPE;
// A valid name (C4): a string that matches the scope pattern. A field that must name a list and
// holds neither a valid name nor null (nor "*" for operator) counts 1 in refused and applies as null.
const validName = (v) => typeof v === "string" && NAME.test(v);
const normalized = (e) => normalizeEntry(e) === e;
function applySetScopes(msg) {
  let refused = 0;
  const lists = {};
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
  const scopes = {};
  if (isObj(msg.scopes)) {
    for (const [scope, v] of Object.entries(msg.scopes)) {
      if (!NAME.test(scope)) refused += 1; // applies as absent
      else if (!(v === null || validName(v))) {
        refused += 1;
        scopes[scope] = null; // no list, no fall-back to default
      } else scopes[scope] = v;
    }
  } else refused += 1;
  let def = null;
  if (validName(msg.default)) def = msg.default;
  else if (msg.default !== null) refused += 1; // also a missing default
  if (!isObj(msg.scopes)) def = null; // no scope gets default while the scopes are not known
  let operator = null;
  if (Object.hasOwn(msg, "operator") && msg.operator !== null) {
    const o = msg.operator;
    if (o === "*") operator = "*";
    else if (validName(o)) operator = Object.hasOwn(lists, o) ? o : null;
    else refused += 1;
  }
  // A scope's list: its scopes entry when it has one (no fall-back), else default.
  const listOf = (scope) => {
    const name = Object.hasOwn(scopes, scope) ? scopes[scope] : def;
    return name !== null && Object.hasOwn(lists, name) ? name : null;
  };
  return { lists, scopes, default: def, operator, refused, listOf };
}
// The relay's allowlist line (C11): C4's rules, the roots with --peer-check, and a line with a
// roots field that a relay without --peer-check applies as no line at all.
// An item of roots: an object with an integer pid from 2 and an integer start from 0, both at most
// 2^53 - 1 (Number.isSafeInteger); its other fields are ignored.
const isRoot = (r) => isObj(r) && Number.isSafeInteger(r.pid) && r.pid > 1 && Number.isSafeInteger(r.start) && r.start >= 0;
function applyLine(line, peerCheck) {
  if (!peerCheck && Object.hasOwn(line, "roots")) return { failClosed: true };
  const a = applySetScopes(line);
  let roots = null;
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
const sentences = (text) => flat(text).split(/(?<=\.)\s+/);

// The part of C11 from a bold heading to the next bold heading.
function part(text, heading) {
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
  const has = (list) => { for (const s of list) assert.ok(says(ses, s), `C11 says: ${s}`); };
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
    "and, when `SO_PEERPIDFD` gives a pidfd, the pid that the pidfd names (the `Pid:` line of `/proc/self/fdinfo/<pidfd>`) and a `poll` of that pidfd, which must return 0 (the child lives; review-19 note 5)", "A connection from the relay to itself would not do",
    "a pidfd of the child selects the **pidfd form**; `ENOPROTOOPT` (a kernel before 6.5) selects the **stat form**, which is not a failure; any other error fails the test",
    "The whole test has a time limit, `SELF_TEST_MS = 5000`", "In every path (a pass, a failure, the time limit) the relay stops the child and removes the folder",
    "`relay: the peer check runs (<form>)`, with `<form>` one of `pidfd`, `stat` and `mac`, or `relay: the peer check cannot run: <reason>`",
    "the relay admits no connection, and it answers each upgrade with the 503 `the relay cannot read the program of a connection` (step 3) until it stops: it fails closed"]);
  // The peer read (step 3; review-54b notes 1 and 4).
  has(["`getsockopt(SOL_SOCKET, SO_PEERCRED)` on the accepted socket gives the peer's pid and uid", "In the pidfd form `getsockopt(SOL_SOCKET, SO_PEERPIDFD)` gives a pidfd of the same process",
    "In the stat form the relay reads the peer's start time (field 22) at the accept too, so that the window of a reused pid starts there (review-54b note 4)",
    "`getsockopt(SOL_LOCAL, LOCAL_PEERPID)` gives a pid, `LOCAL_PEERCRED` the uid, and `proc_pidinfo` the peer's start time, read at the accept",
    "The peer's 403 (step 3) is the one answer for every read that fails at the accept (review-54b note 1)",
    "In the pidfd form any error of `SO_PEERPIDFD` is the peer's 403, whatever its code"]);
  // The session check (step 6; review-54b note 2).
  has(["libc `poll` of the pidfd (`POLLIN`, a 0 ms timeout) returns 0 (not readable; 1, readable, means that the peer has exited, and -1, an error, counts as not alive too), the `Pid:` line of its `fdinfo` is the peer's pid (`-1` means that it was reaped), and the peer's `/proc/<pid>/stat` can be read and its state (field 3) is not `Z`",
    "Each of the three counts alone: a process can show the state `Z` before its pidfd polls readable", "and a pidfd can poll readable while the state still shows `R` (both measured, review-54b note 2)",
    "Stat form and the Mac: the pid is still there, its start time is the one of the accept, and its state is not `Z` (on the Mac `pbi_status` is not `SZOMB`)",
    "The walk, from the peer itself (hop 0) to its parent, and on. It stops at the first process that matches a root of the line, of any scope (also a root that does not count, below)",
    "at pid 1; at a pid that has gone, or whose parent is 0; at a parent whose start time is later than its child's (the parent's pid came back during the walk, so it is not the child's parent; the same start time is a fork in the same clock tick, and the walk goes on; review-19 note 7); or after 32 hops (a root at most 32 parents above the peer counts)",
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
    "A root counts only while it lives", "A `(pid, start)` that two scopes name counts for neither scope", "A root that is an ancestor of another root (the walk from the other root reaches it, with the walk's own stop rules from its first hop: a parent whose start time is later than the other root's start time is no parent, so it is no ancestor; review-19b note 7) does not count, for the walk or the cgroup",
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
    "a tab holds a CDP button from a `mousePressed` on any of its sessions, its own or a frame's (review-68 B2), until Chrome answered a `mouseReleased` on any of them",
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
  const has = (list) => { for (const s of list) assert.ok(says(C11, s), `C11 says: ${s}`); };
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
  const has = (list) => { for (const s of list) assert.ok(says(C11, s), `C11 says: ${s}`); };
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
const answerById = Object.fromEntries(endpoint.upgradeAnswers.map((a) => [a.id, a]));
const closeById = Object.fromEntries(endpoint.closes.filter((c) => c.id).map((c) => [c.id, c]));
// The fake process table of a case: its world, with the case's entries in place of the world's.
function worldOf(c) {
  const w = new Map(endpoint.procs.filter((p) => p.world === c.world).map((p) => [p.pid, p]));
  for (const p of c.procs ?? []) {
    if (p.gone) w.delete(p.pid);
    else w.set(p.pid, p);
  }
  return w;
}
const MAX_HOPS = 32;
const key = (pid, start) => `${pid}:${start}`;
// The walk from pid (hop 0) through its parents: the first process that matches a root of `named`
// (by pid and start), or null when it reaches pid 1, a pid that has gone, a parent 0, a parent whose
// start time is later than its child's (its pid came back), or 32 hops.
function walk(w, pid, named, child = null) {
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
function rootsThatCount(roots, w) {
  const named = new Map();
  for (const [scope, list] of Object.entries(roots)) {
    for (const { pid, start } of list) {
      const k = key(pid, start);
      if (!named.has(k)) named.set(k, { pid, start, scopes: new Set() });
      named.get(k).scopes.add(scope);
    }
  }
  for (const r of named.values()) {
    const s = w.get(r.pid);
    r.live = s !== undefined && s.start === r.start;
    r.cgroup = r.live ? s.cgroup : null;
  }
  const ancestors = new Set();
  for (const r of named.values()) {
    if (!r.live) continue;
    const rest = new Map([...named].filter(([k]) => k !== key(r.pid, r.start)));
    const above = walk(w, w.get(r.pid).ppid, rest, w.get(r.pid)); // the root's parent is compared with the root (review-19b note 7)
    if (above) ancestors.add(above);
  }
  const live = [...named.values()].filter((r) => r.live);
  for (const [k, r] of named) {
    r.scope = r.scopes.size === 1 ? [...r.scopes][0] : null;
    r.counts = r.live && r.scope !== null && !ancestors.has(k);
    const parent = r.live ? w.get(w.get(r.pid).ppid) : undefined;
    r.cgroupCounts = r.counts && typeof r.cgroup === "string" && parent !== undefined && parent.cgroup !== r.cgroup &&
      !live.some((o) => o !== r && [...o.scopes].some((x) => x !== r.scope) && o.cgroup === r.cgroup) &&
      !live.some((o) => o !== r && typeof o.cgroup === "string" && o.cgroup.startsWith(r.cgroup + "/"));
  }
  return named;
}
// Step 3: the peer read at the accept.
function peerRead(c) {
  const p = c.peer;
  if (!p.read || !(Number.isInteger(p.pid) && p.pid > 0) || p.uid !== "own") return false;
  return c.relay.selfTest === "pidfd" ? isObj(p.pidfd) : Number.isInteger(p.start);
}
// Step 6: the session check. The root that admits the connection, or null.
function sessionCheck(c, a, scope) {
  const w = worldOf(c), p = c.peer, form = c.relay.selfTest;
  const alive = () => {
    const s = w.get(p.pid);
    if (!s || s.state === "Z") return false;
    if (form === "pidfd") return p.pidfd.poll === 0 && p.pidfd.fdinfoPid === p.pid; // 1: readable (exited); -1: an error
    return s.start === p.start; // the stat form and the Mac: the start of the accept
  };
  if (!alive()) return null;
  const named = rootsThatCount(a.roots, w);
  const at = walk(w, p.pid, named);
  let admitted = null;
  if (at !== null) {
    const r = named.get(at);
    admitted = r.counts && r.scope === scope ? at : null; // any other root refuses, whatever the cgroup says
  } else if (form !== "mac") {
    const cg = w.get(p.pid).cgroup;
    for (const [k, r] of named) {
      if (r.scope === scope && r.cgroupCounts && typeof cg === "string" && (cg === r.cgroup || cg.startsWith(r.cgroup + "/"))) admitted = k;
    }
  }
  return admitted !== null && alive() ? admitted : null;
}
function admit(c) {
  const headers = c.request.headers ?? {};
  if (Object.hasOwn(headers, "origin")) return "fromPage"; // 1
  const url = new URL(c.request.path, "http://relay");
  const m = /^\/devtools\/browser\/([^/]*)$/.exec(url.pathname);
  if (!m || !SCOPE.test(m[1])) return "notFound"; // 2
  const scope = m[1];
  const relay = c.relay;
  if (c.peerCheck) { // 3
    if (relay.selfTest === "failed") return "cannotRead";
    if (!peerRead(c)) return "peerUnread";
  }
  if (!relay.link) return "notConnected"; // 4
  if (relay.bridge === 0) return "tooOld";
  if (relay.line === null) return "notConfirmed";
  if (relay.bridge === null) return "notConnected";
  const a = applyLine(endpoint.lines[relay.line], c.peerCheck);
  if (a.failClosed) return "rootsWithout";
  if (c.peerCheck && !Object.hasOwn(a.scopes, scope)) return "noList"; // 5
  if (c.peerCheck && sessionCheck(c, a, scope) === null) return "session"; // 6
  if (a.listOf(scope) === null || (relay.ended ?? []).includes(scope)) return "noList"; // 7
  return c.request.upgrade === false ? "notFound" : 101; // 8: a plain request gets no connection
}

test("before the upgrade: each check vector gets the answer of C11's order", () => {
  const seen = new Set();
  for (const c of endpoint.upgradeChecks) {
    const want = c.answer?.status === 101 ? 101 : c.answer;
    assert.ok(want === 101 || Object.hasOwn(answerById, want), `${c.note}: a known answer`);
    assert.equal(admit(c), want, c.note);
    seen.add(want);
  }
  for (const a of endpoint.upgradeAnswers) assert.ok(seen.has(a.id), `a check vector for ${a.id}`);
  assert.ok(seen.has(101), "a vector of an upgrade");
  const steps = ["1. A request with an `Origin` header", "2. A path or scope that does not match", "3. With the peer check, the peer read", "4. The relay is not ready", "5. With the peer check, a scope that the last `allowlist` line does not name", "6. With the peer check, the session check", "7. A scope with no list"];
  for (const s of steps) assert.ok(C11.includes(s), `C11 has the step ${s}`);
  assert.ok(C11.includes("`upgradeChecks`") && C11.includes("`lineCloses`"), "C11 names the vectors");
  assert.equal(answerById.session.body.split("<pid>").length, 2, "the session's 403 holds the peer's pid once");
  for (const list of [endpoint.upgradeAnswers, endpoint.closes.filter((c) => c.id)]) assert.equal(new Set(list.map((x) => x.id)).size, list.length, "each id once");
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
    for (const k of Object.keys(c.relay)) assert.ok(["link", "bridge", "line", "selfTest", "ended"].includes(k), `${c.note}: a known relay field ${k}`);
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
  const by = (answer, f) => checked.some((c) => (c.answer?.status === 101 ? 101 : c.answer) === answer && f(c, worldOf(c)));
  const proc = (c, w) => w.get(c.peer.pid);
  const chainTo = (c, w, pid) => { let x = c.peer.pid; for (let i = 0; i <= MAX_HOPS && w.has(x); i++) { if (x === pid) return i; x = w.get(x).ppid; } return -1; };
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
  assert.ok(by("session", (c, w) => c.relay.selfTest === "pidfd" && proc(c, w)?.state === "Z" && c.peer.pidfd.poll === 0 && c.peer.pidfd.fdinfoPid === c.peer.pid), "Z before the pidfd polls readable");
  assert.ok(by("session", (c, w) => c.relay.selfTest === "pidfd" && c.peer.pidfd.poll === 1 && proc(c, w)?.state !== "Z"), "a readable pidfd while the state is not Z");
  assert.ok(by("session", (c, w) => c.relay.selfTest === "pidfd" && c.peer.pidfd.poll === -1 && c.peer.pidfd.fdinfoPid === c.peer.pid && proc(c, w)?.state !== "Z"), "a poll that returns -1 (review-19 note 5)");
  assert.ok(by("session", (c, w) => c.relay.selfTest === "pidfd" && c.peer.pidfd.poll === 0 && ![-1, c.peer.pid].includes(c.peer.pidfd.fdinfoPid) && proc(c, w)?.state !== "Z"), "an fdinfo pid that is not -1 and not the peer's (review-19 V10)");
  for (const c of checked.filter((x) => x.relay.selfTest === "pidfd" && isObj(x.peer.pidfd))) assert.ok([0, 1, -1].includes(c.peer.pidfd.poll) && Number.isInteger(c.peer.pidfd.fdinfoPid), `${c.note}: poll and fdinfoPid`);
  assert.ok(by("session", (c, w) => c.relay.selfTest === "pidfd" && c.peer.pidfd.fdinfoPid === -1 && proc(c, w)?.state !== "Z"), "an fdinfo pid of -1");
  for (const form of ["stat", "mac"]) {
    assert.ok(by("session", (c, w) => c.relay.selfTest === form && proc(c, w) && proc(c, w).start !== c.peer.start), `${form}: a start that changed`);
    assert.ok(by("session", (c, w) => c.relay.selfTest === form && proc(c, w)?.state === "Z" && proc(c, w).start === c.peer.start), `${form}: Z`);
  }
  assert.ok(by("session", (c, w) => c.relay.selfTest === "stat" && !proc(c, w)), "stat: the pid has gone by the walk");
  assert.ok(by("session", (c, w) => c.relay.selfTest === "pidfd" && !proc(c, w)), "pidfd: the pid has gone");
  // The walk and the cgroup.
  const scopeOf = (c) => new URL(c.request.path, "http://relay").pathname.split("/").pop();
  assert.ok(by(101, (c) => (applyLine(endpoint.lines[c.relay.line], true).roots[scopeOf(c)] ?? []).some((r) => r.pid === c.peer.pid)), "the pane's process itself (hop 0)");
  assert.ok(by(101, (c, w) => c.world === "mac" && chainTo(c, w, 4000) === MAX_HOPS) && by("session", (c, w) => c.world === "mac" && w.get(c.peer.pid)?.ppid === 4032), "a root at hop 32 counts, at hop 33 not");
  assert.ok(by(101, (c, w) => c.world === "linux" && w.get(proc(c, w)?.ppid)?.note.startsWith("systemd --user")), "the pane's cgroup admits a re-parented peer");
  assert.ok(by("session", (c, w) => c.world === "mac" && w.get(proc(c, w)?.ppid)?.note === "launchd"), "the Mac: no cgroup for a re-parented peer");
  assert.ok(by("session", (c, w) => c.world === "noScope" && proc(c, w)?.ppid === 1144) && by(101, (c) => c.world === "noScope"), "no scope of its own: the walk only");
  assert.ok(by("session", (c, w) => c.world === "noScope" && proc(c, w)?.ppid === 1144 && [...w.values()].filter((p) => p.ppid === 3000).length === 1), "a lone pane in its parent's cgroup: the cgroup does not count");
  assert.ok(by(101, (c, w) => (c.procs ?? []).some((p) => p.pid === 3100 && !p.gone && p.ppid === 3200)), "the walk passes a pid whose start is not the root's");
  assert.ok(by("session", (c, w) => proc(c, w)?.cgroup?.startsWith("/user.slice/user-1001.slice/user@1001.service/app.slice/tmux-spawn-1a2b.scope") && !proc(c, w).cgroup.startsWith("/user.slice/user-1001.slice/user@1001.service/app.slice/tmux-spawn-1a2b.scope/") && proc(c, w).cgroup !== "/user.slice/user-1001.slice/user@1001.service/app.slice/tmux-spawn-1a2b.scope"), "a cgroup name that is no path under the root's");
  assert.ok(by(101, (c, w) => proc(c, w)?.cgroup?.endsWith(".scope/job")), "a cgroup under the root's");
  for (const [answer, line, what] of [["session", "peerSharedRoot", "two scopes name a root"], [101, "peerSharedRoot", "the other root of such a scope counts"], ["session", "peerServerRoot", "an ancestor of another root"], [101, "peerServerRoot", "the root under it counts"],
    ["session", "peerNested", "a nested cgroup"], ["session", "peerNoRoots", "a line with no roots"], ["session", "peerNoLead", "a scope with no root"], [101, "peerLeadTwice", "a root named twice by one scope"], [101, "peerTwoPanes", "a second pane"]]) {
    assert.ok(by(answer, (c) => c.relay.line === line), `${what} (${line})`);
  }
  assert.ok(by("session", (c) => (c.procs ?? []).some((p) => p.pid === 3200 && p.cgroup?.endsWith("tmux-spawn-1a2b.scope"))), "a cgroup that a root of another scope shares");
  // review-19 B1, B2: a shared root from both scopes; an ancestor root's cgroup, for a peer whose walk does not pass it; a walk
  // that stops at a root that does not count, for a peer in the cgroup of a root of the scope that counts.
  const shared = applyLine(endpoint.lines.peerSharedRoot, true).roots;
  const sharedRoot = shared["md-lead"].find((r) => shared["md-worker"].some((o) => o.pid === r.pid && o.start === r.start));
  for (const sc of ["md-lead", "md-worker"]) assert.ok(by("session", (c, w) => c.relay.line === "peerSharedRoot" && scopeOf(c) === sc && chainTo(c, w, sharedRoot.pid) >= 0), `a shared root, from ${sc}`);
  const server = applyLine(endpoint.lines.peerServerRoot, true).roots["md-worker"][0];
  assert.ok(by("session", (c, w) => c.relay.line === "peerServerRoot" && chainTo(c, w, server.pid) < 0 && proc(c, w)?.cgroup === w.get(server.pid).cgroup), "an ancestor root's cgroup admits no one (F2)");
  assert.ok(by("session", (c, w) => c.relay.line === "peerSharedRoot" && scopeOf(c) === "md-worker" && chainTo(c, w, sharedRoot.pid) >= 0 && shared["md-worker"].some((r) => r.pid !== sharedRoot.pid && proc(c, w)?.cgroup === w.get(r.pid).cgroup)), "the walk stops at a root that does not count, whatever the cgroup (F3)");
  assert.ok(by("session", (c) => c.relay.line === "peerUnnamedShares" && Object.keys(applyLine(endpoint.lines.peerUnnamedShares, true).roots).some((sc) => !Object.hasOwn(endpoint.lines.peerUnnamedShares.scopes, sc))), "a root of a scope that scopes does not name counts for the defensive rules (V21)");
  assert.ok(by("session", (c, w) => c.relay.line === "peer" && (c.procs ?? []).some((p) => p.pid === 3100 && !p.gone && p.start === 6000 && !w.has(p.ppid)) && proc(c, w)?.ppid === 1144), "a root whose parent the relay cannot read: no cgroup (V19)");
  assert.ok(by("session", (c, w) => (c.procs ?? []).some((p) => p.pid === proc(c, w)?.ppid && p.start > proc(c, w).start)) && by(101, (c, w) => (c.procs ?? []).some((p) => p.pid === proc(c, w)?.ppid && p.start === proc(c, w).start)), "a parent later than its child stops the walk; the same start does not (note 7)");
  assert.ok(by("session", (c) => c.relay.line === "peerLeadNull" && (c.procs ?? []).some((p) => p.pid === 3100 && p.gone)), "the ended session with 5 b: the session's 403 after the line (note 2)");
  // review-19b note 2: the walk compares each parent with its own child (hop 1 is later than hop 2, the peer is later than both).
  assert.ok(by("session", (c, w) => { const a = proc(c, w), b = w.get(a?.ppid), d = w.get(b?.ppid); return a && b && d && b.start < a.start && d.start > b.start && a.start > d.start; }), "a parent later than its child, though not later than the peer (note 2)");
  // review-19b note 7: the ancestor rule compares a root's parent with the root.
  assert.ok(by(101, (c, w) => { const all = Object.values(applyLine(endpoint.lines[c.relay.line], true).roots).flat(); return all.some((r) => { const x = w.get(r.pid), up = x && w.get(x.ppid); return up && up.start > x.start && all.some((o) => o.pid === x.ppid && o.start === up.start); }); }), "a root whose parent is a root that started later: no ancestor (note 7)");
  // The refusal after end_scope is step 7, and a plain request has the same order.
  assert.ok(checked.some((c) => c.answer === "noList" && (c.relay.ended ?? []).includes(scopeOf(c))) && by("session", (c) => (c.relay.ended ?? []).includes(scopeOf(c))), "an ended scope: step 6 before step 7");
  assert.ok(endpoint.upgradeChecks.some((c) => !c.peerCheck && c.answer === "noList" && (c.relay.ended ?? []).includes(scopeOf(c))), "an ended scope without the peer check");
  for (const answer of ["notFound", "session", "noList"]) assert.ok(checked.some((c) => c.request.upgrade === false && c.answer === answer), `a plain request gets ${answer} with the peer check`);
  assert.ok(endpoint.upgradeChecks.some((c) => !c.peerCheck && c.request.upgrade === false && c.answer === "notFound"), "a plain request that is admitted gets the 404");
  assert.ok(endpoint.upgradeChecks.every((c) => c.request.upgrade !== false || c.answer !== 101), "a plain request never gets an upgrade");
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
    let ended = new Set(), line = null;
    for (const st of c.steps) {
      if (st.line !== undefined) {
        assert.ok(ids.has(st.line), `${c.note}: a known line`);
        line = applyLine(endpoint.lines[st.line], c.peerCheck);
        for (const sc of [...ended]) if (Object.hasOwn(line.scopes, sc)) ended.delete(sc); // a line that names it, also with null
      } else if (st.endScope !== undefined) {
        ended.add(st.endScope);
      } else {
        assert.equal(st.restart, true, c.note);
        ended = new Set();
        line = null;
      }
    }
    assert.ok(line !== null, `${c.note}: a line came`);
    const refused = (c.peerCheck && !Object.hasOwn(line.scopes, c.scope)) || ended.has(c.scope) || line.listOf(c.scope) === null;
    assert.equal(refused ? "noList" : "admit", c.answer, c.note);
    if (refused) refuses++; else admits++;
  }
  assert.ok(admits >= 4 && refuses >= 4, "both answers");
  const has = (f) => endpoint.endScopes.some(f);
  assert.ok(has((c) => !c.peerCheck && c.answer === "admit" && c.steps.some((s) => s.line === "plainLeadDropped") && c.steps.some((s) => s.line === "plainLeadNull")), "5 b: the default list admits the scope after the null entry is dropped");
  assert.ok(has((c) => c.peerCheck && c.answer === "noList" && c.steps.some((s) => s.line === "peerLeadGone")), "with the peer check, an unnamed scope gets the no-list 503");
  assert.ok(has((c) => c.answer === "noList" && c.steps.some((s) => s.line === "plainLeadDropped") && !c.steps.some((s) => s.line === "plainLeadNull")), "a line that does not name the scope keeps the refusal");
  assert.ok(has((c) => c.answer === "admit" && c.steps.some((s) => s.restart)) && has((c) => c.answer === "noList" && c.steps.some((s) => s.restart)), "the limit: a restart loses the set; a replayed null entry is safe");
  assert.ok(has((c) => c.answer === "admit" && c.steps.some((s) => s.restart) && c.steps.at(-1).line === "plainLeadDropped"), "the limit: after a restart a line that does not name the scope admits it by default");
  assert.ok(has((c) => c.answer === "admit" && c.steps.some((s) => s.endScope === "md-worker")), "an end_scope of another scope does not touch this one");
});

test("at each allowlist line: each close vector follows C11", () => {
  for (const c of endpoint.lineCloses) {
    const scope = c.connection.scope;
    const a = applyLine(endpoint.lines[c.line], c.peerCheck);
    let got = null;
    if (a.failClosed || (c.peerCheck && !Object.hasOwn(a.scopes, scope)) || a.listOf(scope) === null) got = "noList";
    else if (c.peerCheck && !(Object.hasOwn(a.roots, scope) && a.roots[scope].some((r) => r.pid === c.connection.root.pid && r.start === c.connection.root.start))) got = "root";
    assert.equal(got, c.close, c.note);
    assert.equal(c.connection.root === null, !c.peerCheck, `${c.note}: a root with the peer check only`);
  }
  for (const id of ["noList", "root"]) {
    assert.equal(closeById[id]?.code, 1008, id);
    assert.ok(endpoint.lineCloses.some((c) => c.close === id), `a vector for ${id}`);
  }
  assert.ok(endpoint.lineCloses.some((c) => c.close === null), "a vector of a connection that stays");
  assert.ok(endpoint.lineCloses.some((c) => c.close === null && c.line === "peerSharedRoot"), "an open connection stays when another scope names its root too");
  assert.ok(endpoint.lineCloses.some((c) => c.close === "root" && applyLine(endpoint.lines[c.line], true).roots[c.connection.scope]?.some((r) => r.pid === c.connection.root.pid && r.start !== c.connection.root.start)), "the same pid with another start closes");
});

// Where a call goes (C11's table): the model, Chrome, or a refusal. The methods of the sign-in act (board ab-v16.97.1) are
// the service's model's from stage 1e part 2 (`act`: a model with the act): on the root the model answers them then,
// and before that they are outside the set. On a page session they are refused in each model (review-112 B6). The
// routing vectors give both: `to` for today's model (the relay's), and `withAct` for a model with the act.
const SIGN_IN_METHODS = ["AgentBrowser.signIn", "AgentBrowser.signIns"];
function route(session, method, params = {}, child = false, act = false) {
  if (session === "root") return endpoint.modelSet.includes(method) || (act && SIGN_IN_METHODS.includes(method)) ? "the model" : "refused";
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
const templateRe = (t) =>
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

// The refusals of C11 that depend on the params (page marks, cookies, URLs, contexts).
const MAIN_WORLD = (name) => typeof name !== "string" || name === "";
const NAVIGATE_OK = (url) => url === "about:blank" || /^(https?|data):/i.test(url) || /^blob:https?:\/\//i.test(url);
const NEW_TAB_OK = (url) => url === undefined || url === "" || url === "about:blank" || /^https?:/i.test(url);
const schemeOf = (url) => /^([a-z][a-z0-9+.-]*:)/i.exec(url)?.[1].toLowerCase() ?? "relative";
const named = (list, re) => Array.isArray(list) && list.some((h) => isObj(h) && re.test(String(h.name)));
// binaryResponseHeaders: base64 of name\0value\0name\0value...
const binaryNamed = (b64, re) => {
  if (typeof b64 !== "string") return false;
  const parts = Buffer.from(b64, "base64").toString("utf8").split("\0");
  return parts.some((p, i) => i % 2 === 0 && re.test(p));
};
const COOKIE = /^cookie$/i;
const SET_COOKIE = /^set-cookie$/i;
// The scope's list of the samples (C11, the refusals): a navigation of the main frame, a new tab, a
// grant with an origin, off the list.
const onList = (host) => endpoint.scopeList.some((d) => host === d || host.endsWith("." + d));
const webHost = (url) => {
  const u = /^blob:/i.test(String(url)) ? String(url).slice(5) : String(url);
  if (!URL.canParse(u)) return null;
  const p = new URL(u);
  return /^https?:$/.test(p.protocol) ? p.hostname : null;
};
const offList = (url) => {
  const h = webHost(url);
  return h !== null && !onList(h);
};
const mainFrame = (params) => params.frameId === undefined || params.frameId === endpoint.mainFrameId;
function paramRefusal(method, params = {}) {
  switch (method) {
    case "Page.addScriptToEvaluateOnNewDocument": return MAIN_WORLD(params.worldName);
    case "Runtime.addBinding": return MAIN_WORLD(params.executionContextName);
    case "Storage.clearDataForOrigin":
    case "Storage.clearDataForStorageKey":
      return String(params.storageTypes ?? "").split(",").map((s) => s.trim()).some((s) => s === "cookies" || s === "all");
    case "Network.setExtraHTTPHeaders": return isObj(params.headers) && Object.keys(params.headers).some((h) => COOKIE.test(h));
    case "Fetch.continueRequest": return named(params.headers, COOKIE);
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
  assert.ok(endpoint.refusals.some((r) => /^file:/.test(r.params?.url ?? "")), "S12: a file: URL is refused");
  assert.ok(endpoint.refusals.some((r) => schemeOf(r.params?.url ?? "x:") === "relative"), "a relative URL is refused");
  assert.ok(endpoint.passes.some((p) => p.method === "Target.createTarget" && p.params.url === ""), "an empty url is about:blank");
  // The refusals per scope (C11): the main frame, a blob: inner origin, a new tab, and a frame passes.
  const offRefused = endpoint.refusals.filter((r) => r.error.startsWith("Not allowed: "));
  assert.ok(offRefused.some((r) => r.method === "Page.navigate" && r.params.frameId === undefined), "the main frame with no frameId");
  assert.ok(offRefused.some((r) => r.method === "Page.navigate" && r.params.frameId === endpoint.mainFrameId), "the main frame by its frameId");
  assert.ok(offRefused.some((r) => r.method === "Page.navigate" && /^blob:/.test(r.params.url)), "a blob: URL");
  assert.ok(offRefused.some((r) => r.method === "Target.createTarget"), "a new tab");
  assert.ok(endpoint.passes.some((p) => p.method === "Page.navigate" && p.params.frameId !== undefined && !mainFrame(p.params) && offList(p.params.url)), "a frame's navigation passes (O11)");
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
function hide(x, marker) {
  if (Array.isArray(x)) return x.map((y) => hide(y, marker));
  if (!isObj(x)) return x;
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (LISTS.includes(k) && Array.isArray(v)) out[k] = [];
    else if (HEADER_OBJECTS.includes(k) && isObj(v)) out[k] = Object.fromEntries(Object.entries(v).map(([h, s]) => [h, COOKIE_HEADER.test(h) ? marker : s]));
    else if (HEADER_LISTS.includes(k) && Array.isArray(v)) out[k] = v.map((h) => (isObj(h) && COOKIE_HEADER.test(h.name) ? { ...h, value: marker } : h));
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
  assert.ok(says(C11, "a parent whose start time is later than the other root's start time is no parent, so it is no ancestor; review-19b note 7"), "note 7");
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
    "On the Mac the port refuses every connection (fail closed) until the Mac's TCP peer reader (`libproc`) is built and measured (stage 4). Until then a launchd holder accepts and closes each connection.",
  ]);
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
    "no `Authorization: Bearer <token>` header: 401 `The agent browser needs this session's connection token. agentwatch adds it to the sessions that it starts while the repo's list has a site.`;",
    "a session whose `mcp_token` is `null`: 401 `This session has no connection token. agentwatch adds one when it starts a session while the repo's list has a site: restart the session.`;",
    "a token whose fingerprint is not the session's: 401 `The agent browser does not know this connection token for this session.` The text does not say whether the token belongs to another session.",
    "Each 401 carries `WWW-Authenticate: Bearer realm=\"agent-browser\"`, with no `resource_metadata`, so no client starts an OAuth login (stage 2's live check proves it).",
    "8. The readiness and the scope's list: the 503s of steps 4, 5 and 7 before the upgrade, with their texts.",
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
    "The check costs 10.4 ms p50 to 23.1 ms p50 on taylor (M2), once for each connection.",
    "A client of another OS user is refused by the uid column; M2 reasoned this case and did not run it.",
    "As on the endpoint, the check does not stop a hostile process of the same OS user. The token does not change this: a process of the user can read every session's entry file. A token works only from its own session, and it ends with the session.",
  ]);
  // The texts of the MCP path that are new: each has its status, once.
  for (const t of ["403 `The agent browser admits only the Host 127.0.0.1:<port> or localhost:<port>.`", "404 `Not found. Connect an MCP client to /mcp/<scope>.`", "503 `The agent browser is off: the operator turned agent control off.`",
    "401 `The agent browser needs this session's connection token. agentwatch adds it to the sessions that it starts while the repo's list has a site.`",
    "401 `This session has no connection token. agentwatch adds one when it starts a session while the repo's list has a site: restart the session.`",
    "401 `The agent browser does not know this connection token for this session.`"]) {
    assert.equal(flat(C11).split(flat(t)).length, 2, `C11 has ${t} once`);
  }
  // The reused texts are the endpoint's own answers (the vectors).
  const bodies = new Set(endpoint.upgradeAnswers.map((a: any) => a.body));
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
    "On the MCP path a scope whose list has no site gets the no-list 503 too: the list is the allow (the token design, sections 6.5 and 7.2). The endpoint keeps its own rule: there a scope whose list is empty is admitted, and it can open `about:blank` only.",
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
    "Tools and argument keys pass only through the allow list (`docs/contracts/mcp-allow-list.md`), and the service's own tools of the allow list's `service_tools` only for a request that the MCP port admitted with the walk (a local admission: the sign-in act, below).",
    "The service refuses each argument that the allow list marks as a path when the path is outside the scope's folder, `<state>/mcp/<scope>/`, after `realpath`.",
    "The MCP's Playwright connects back to the endpoint's CDP path with the MCP session's scope and a one-time ticket, which only a connection from the service's own pid can use. Every rule of this file applies to that connection.",
    "The MCP code of each scope runs in one worker thread of the service, with a heap limit (first value 512 MiB). A worker that passes it ends with its MCP sessions, and their clients get an error.",
    "No log line of the MCP path holds a tool argument, page content, a cookie, a URL path, a payload, a username, a password, a form value, an `Authorization` header, a token, a token's fingerprint or a lifetime id, and a request that the service refuses for its size or its shape is never logged (the log rule of C12).",
  ]);
  const how = partOr("How a session gets the MCP (from stage 2; the operator's answer Q2 of ab-bi3, and the daemon lead's condition 4).");
  sayAll(how, [
    "agentwatch writes the MCP's HTTP entry into a session's own MCP configuration at the session's launch, only when the session's scope has a list with at least one site. agentwatch mints the session's token at the launch, sends its fingerprint in `set_sessions`, writes the entry file before the launch and removes it at the session's end.",
    "Each entry that agentwatch writes names `127.0.0.1`, never `localhost`: the service listens only on `127.0.0.1`.",
    "agentwatch writes the entry only when the `LISTEN` line of `127.0.0.1:<port>` in `/proc/net/tcp` has the user's uid. Otherwise it writes no entry, and `agentwatch health` shows red.",
    "agentwatch never writes the entry into the user's global files. For Claude Code it writes a file for the session under its tokens folder (`tokens/agent-browser/sessions/<random name>.json`, 0600, with a new random name for each run), which the launch passes with `--mcp-config`.",
    "For Codex it writes the session's profile file under its tokens folder and a link to it in the session's Codex home (`aw-<random name>.config.toml`), and the launch passes `-p aw-<random name>`; a Codex session with agentwatch's app server gets no entry until a Codex release lets the app server read a profile (the token design's answer E a). No command line holds a lifetime id.",
    "Nothing goes into the session's environment: the operator's answer age-4ks (\"env: no\") stays.",
    "agentwatch does not change a running session's MCP configuration. A list that gets its first site after a session's launch takes effect at that session's next launch, so the session needs a restart.",
  ]);
  for (const s of ["CODEX_HOME", "by hand"]) assert.ok(!says(C11, s), `C11: no ${s} (D19)`);
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
function tcpLines(c: any, again: boolean): any[] | null {
  const k = again ? "tcpAgain" : "tcp";
  if (Object.hasOwn(c.connection, k)) return c.connection[k];
  if (again) return tcpLines(c, false);
  const client = c.connection.client, srv = `127.0.0.1:${MCP_PORT}`;
  return [{ local: srv, remote: "0.0.0.0:0", uid: MCP_UID, inode: 80000 }, { local: srv, remote: client, uid: MCP_UID, inode: 81002 }, { local: client, remote: srv, uid: MCP_UID, inode: 81001 }];
}
/** Step 1: the one line whose local address is the client's and whose remote address is the service's port (the full tuple). */
const clientLine = (lines: any[] | null, client: string) => {
  const m = (lines ?? []).filter((l) => l.local === client && l.remote === `127.0.0.1:${MCP_PORT}`);
  return lines !== null && m.length === 1 ? m[0] : null;
};
/** The scope of one holder by the walk, else (not on the Mac) by a root's cgroup that counts; null: no root that counts. */
function holderScope(w: Map<number, any>, pid: number, named: Map<string, any>): string | null {
  const at = walk(w, pid, named);
  if (at !== null) { const r = named.get(at); return r.counts ? r.scope : null; }
  const cg = w.get(pid)?.cgroup;
  if (typeof cg !== "string") return null;
  const scopes = new Set([...named.values()].filter((r) => r.cgroupCounts && (cg === r.cgroup || cg.startsWith(r.cgroup + "/"))).map((r) => r.scope));
  return scopes.size === 1 ? [...scopes][0] : null;
}
const lowest = (pids: number[]) => (pids.length ? Math.min(...pids) : null);
/** The snapshot of a check: its set_sessions, or none before the first one (no session, so no root counts: OP1). */
const snapOf = (c: any) => (c.service.snapshot === null ? { sessions: [], lists: {} } : endpoint.mcpSnapshots[c.service.snapshot]);
/** Steps 1 and 2: the connection's scope, or the refusal with the pid of the session's 403. */
function mcpConnection(c: any): { scope: string; pid: number | null } | { answer: string; pid: number | null } {
  const line = clientLine(tcpLines(c, false), c.connection.client);
  if (!line || line.uid !== MCP_UID) return { answer: "peerUnread", pid: null };
  const w = worldOf(c), snap = snapOf(c);
  const named = rootsThatCount(Object.fromEntries(snap.sessions.map((s: any) => [s.scope, s.roots])), w);
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
function mcpRequest(c: any, conn: { scope: string; pid: number | null }, r: any): { answer: string; pid?: number | null } {
  // OP7: each value without its leading and trailing spaces and tabs (RFC 9110's OWS), as Node's parser gives it.
  const h = (n: string) => r.headers.filter(([k]: [string]) => k === n).map(([, v]: [string, string]) => v.replace(/^[ \t]+|[ \t]+$/g, ""));
  if (h("origin").length) return { answer: "fromPage" }; // 3
  const host = h("host");
  if (host.length !== 1 || ![`127.0.0.1:${MCP_PORT}`, `localhost:${MCP_PORT}`].includes(host[0])) return { answer: "badHost" }; // 4
  const m = /^\/mcp(?:\/([^/]*))?$/.exec(r.path.split("?")[0]); // OP5: the raw path, up to its first ?
  if (!m || (m[1] !== undefined && !SCOPE.test(m[1]))) return { answer: "mcpNotFound" }; // 5
  if (m[1] !== undefined && m[1] !== conn.scope) return { answer: "session", pid: conn.pid }; // 6
  const snap = snapOf(c);
  const item = snap.sessions.find((s: any) => s.scope === conn.scope);
  const auth = h("authorization");
  const bearer = auth.length === 1 ? /^bearer (.+)$/i.exec(auth[0]) : null;
  if (!bearer) return { answer: "needsToken" }; // 7
  if (item.mcp_token === null) return { answer: "noToken" };
  if (mcpSha256(bearer[1]) !== item.mcp_token) return { answer: "unknownToken" };
  if (c.service.ready !== "ready") return { answer: c.service.ready }; // 8
  if (snap.lists[conn.scope] === null || endpoint.mcpLists[snap.lists[conn.scope]].length === 0) return { answer: "noList" }; // OP2: a list with no site
  const sid = h("mcp-session-id"); // the transport, after the admission
  if (sid.length && endpoint.mcpSessionIds[sid[0]] !== conn.scope) return { answer: "unknownSession" };
  return { answer: "pass" };
}
/** Each request's answer on the connection, in order, until the first refusal. */
function mcpRun(c: any): { answer: string; pid?: number | null }[] {
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
  for (const [name, t] of Object.entries<any>(endpoint.mcpTokens)) {
    assert.match(t.token, /^abt1_[A-Za-z0-9_-]{43}$/, name);
    const raw = Buffer.from(t.token.slice(5), "base64url");
    assert.ok(raw.length === 32 && raw.toString("base64url") === t.token.slice(5) && /^test, not a token: [ -~]+$/.test(raw.toString("latin1")), `${name}: 32 bytes of its own ASCII label, a test value`);
    assert.equal(t.fingerprint, mcpSha256(t.token), `${name}: its fingerprint`);
  }
  const fps = new Set(Object.values<any>(endpoint.mcpTokens).map((t) => t.fingerprint));
  for (const [id, snap] of Object.entries<any>(endpoint.mcpSnapshots)) {
    const scopes = snap.sessions.map((s: any) => s.scope);
    assert.equal(new Set(scopes).size, scopes.length, `${id}: one scope once`);
    const tokens = snap.sessions.map((s: any) => s.mcp_token).filter((x: any) => x !== null);
    assert.equal(new Set(tokens).size, tokens.length, `${id}: one fingerprint once`);
    for (const s of snap.sessions) {
      assert.deepEqual(Object.keys(s).sort(), ["cgroup", "lifetime_id", "mcp_token", "repo", "roots", "scope"], `${id}: ${s.scope} is an item of C12's set_sessions`);
      assert.ok(SCOPE.test(s.scope) && s.roots.every(isRoot), `${id}: ${s.scope}`);
      assert.ok(s.mcp_token === null || fps.has(s.mcp_token), `${id}: ${s.scope}: null or the fingerprint of a test token`);
      assert.ok(s.lifetime_id !== null || s.mcp_token === null, `${id}: ${s.scope}: no fingerprint with a null lifetime id`);
    }
    assert.deepEqual(Object.keys(snap.lists).sort(), [...scopes].sort(), `${id}: a list (or null) for each scope`);
    for (const l of Object.values<any>(snap.lists)) assert.ok(l === null || Object.hasOwn(endpoint.mcpLists, l), `${id}: the list ${l} has its sites in mcpLists`);
  }
  // mcpLists: each list's sites, each a host of C5's form; a list with no site, and a list with sites.
  for (const [name, hosts] of Object.entries<any>(endpoint.mcpLists)) assert.ok(SCOPE.test(name) && Array.isArray(hosts) && hosts.every((h: string) => normalized(h)), `mcpLists: ${name}`);
  assert.ok(Object.values<any>(endpoint.mcpLists).some((h) => h.length === 0) && Object.values<any>(endpoint.mcpLists).some((h) => h.length > 0), "mcpLists: a list with no site and a list with sites");
  assert.ok(!Object.values<any>(endpoint.mcpSnapshots).some((snap) => snap.sessions.some((s: any) => s.mcp_token === endpoint.mcpTokens.stranger.fingerprint)), "the stranger's token is no session's");
  // The answers: each id once, each text of C11, with its WWW-Authenticate for a 401; no answer holds a token or a fingerprint.
  const ids = MCP_ANSWERS.map((a: any) => a.id);
  assert.equal(new Set(ids).size, ids.length, "each answer id once");
  for (const a of endpoint.mcpAnswers) {
    if (a.body !== null) assert.ok(says(C11, `${a.status} \`${a.body}\``), `C11 has ${a.status} ${a.body}`);
    assert.equal(a.status === 401, Object.hasOwn(a, "headers"), `${a.id}: headers for a 401 only`);
    if (a.status === 401) assert.deepEqual(a.headers, { "www-authenticate": "Bearer realm=\"agent-browser\"" }, a.id);
  }
  assert.ok(says(C11, "`WWW-Authenticate: Bearer realm=\"agent-browser\"`"), "C11 names the header");
  const answersText = JSON.stringify(endpoint.mcpAnswers);
  for (const t of Object.values<any>(endpoint.mcpTokens)) assert.ok(!answersText.includes(t.token) && !answersText.includes(t.fingerprint), "no answer echoes a token or a fingerprint");
  assert.ok(!/abt1_/.test(answersText) && /abt1_/.test(JSON.stringify([...endpoint.mcpAnswers, { body: endpoint.mcpTokens.leadRun2.token }])), "the scan finds a planted token (its twin)");
});

test("the MCP path's admission: each check vector gets the answers of C11's order (steps 1 and 2 once, steps 3 to 8 for each request, then the transport)", () => {
  const known = new Set([...MCP_ANSWERS.map((a: any) => a.id), "pass"]);
  for (const c of endpoint.mcpChecks) {
    for (const k of Object.keys(c)) assert.ok(["note", "world", "procs", "service", "connection", "requests"].includes(k), `${c.note}: a known field ${k}`);
    assert.ok(["linux", "noScope"].includes(c.world) && (c.service.snapshot === null || Object.hasOwn(endpoint.mcpSnapshots, c.service.snapshot)), c.note);
    assert.ok(c.requests.length > 0 && c.requests.slice(0, -1).every((r: any) => r.answer === "pass"), `${c.note}: only the last request can be refused`);
    const got = mcpRun(c);
    const want = c.requests.map((r: any) => (Object.hasOwn(r, "pid") ? { answer: r.answer, pid: r.pid } : { answer: r.answer }));
    for (const r of c.requests) assert.ok(known.has(r.answer), `${c.note}: a known answer ${r.answer}`);
    assert.equal(got.length, want.length, `${c.note}: one answer for each request`);
    for (const [i, w] of want.entries()) {
      assert.equal(got[i].answer, w.answer, c.note);
      if (Object.hasOwn(w, "pid")) assert.equal(got[i].pid, w.pid, `${c.note}: the pid of the session's 403`);
      // OP3: a connection with no holder gets the peer's 403, so each session's 403 names a holder's pid.
      if (w.answer === "session") assert.ok(Object.hasOwn(w, "pid") && c.connection.holders.includes(w.pid), `${c.note}: the session's 403 names a holder`);
      if (c.connection.holders.length === 0) assert.equal(w.answer, "peerUnread", `${c.note}: no holder, the peer's 403`);
    }
  }
});

test("the MCP path's admission: the vectors hold each case of the daemon lead's F11 and of the token design's section 14.1", () => {
  const cases = endpoint.mcpChecks.map((c: any) => ({ c, r: c.requests.at(-1), h: (n: string) => c.requests.at(-1).headers.filter(([k]: [string]) => k === n).map(([, v]: [string, string]) => v) }));
  const has = (what: string, f: (x: any) => boolean) => assert.ok(cases.some(f), what);
  const T = endpoint.mcpTokens, bearer = (x: any) => x.h("authorization")[0]?.slice(7);
  const own = (x: any) => snapOf(x.c).sessions.find((s: any) => s.scope === mcpConnection(x.c).scope);
  const lineOf = (x: any) => clientLine(tcpLines(x.c, false), x.c.connection.client);
  // F11: the uid, two scopes, the Host forms, /mcp alone, a wrong path scope, a session id of another scope.
  has("another uid by the full tuple, beside the service's accepted socket of the service's uid", (x) => x.r.answer === "peerUnread" && lineOf(x)?.uid !== MCP_UID && (x.c.connection.tcp ?? []).some((l: any) => l.remote === x.c.connection.client && l.uid === MCP_UID));
  has("an unreadable table", (x) => x.r.answer === "peerUnread" && x.c.connection.tcp === null);
  has("no line of the client's tuple", (x) => x.r.answer === "peerUnread" && Array.isArray(x.c.connection.tcp) && !x.c.connection.tcp.some((l: any) => l.local === x.c.connection.client));
  has("two lines of the client's tuple", (x) => x.r.answer === "peerUnread" && (x.c.connection.tcp ?? []).filter((l: any) => l.local === x.c.connection.client).length === 2);
  has("a line that changed at the second read", (x) => x.r.answer === "session" && Object.hasOwn(x.c.connection, "tcpAgain"));
  has("no holder: the peer's 403 (OP3)", (x) => x.r.answer === "peerUnread" && x.c.connection.holders.length === 0 && !Object.hasOwn(x.r, "pid"));
  has("a forked client: two holders of one session", (x) => x.r.answer === "pass" && x.c.connection.holders.length === 2);
  has("step 1 before step 3", (x) => x.r.answer === "peerUnread" && x.h("origin").length > 0);
  has("holders of two scopes", (x) => x.r.answer === "session" && new Set(x.c.connection.holders.map((p: number) => holderScope(worldOf(x.c), p, rootsThatCount(Object.fromEntries(snapOf(x.c).sessions.map((s: any) => [s.scope, s.roots])), worldOf(x.c))))).size === 2);
  for (const host of [`127.0.0.1:${MCP_PORT}`, `localhost:${MCP_PORT}`]) has(`the Host ${host} admitted`, (x) => x.r.answer === "pass" && x.h("host")[0] === host);
  for (const host of [`[::1]:${MCP_PORT}`, "127.0.0.1", `127.0.0.1:${MCP_PORT + 1}`, `LOCALHOST:${MCP_PORT}`]) has(`the Host ${host} refused`, (x) => x.r.answer === "badHost" && x.h("host")[0] === host);
  has("no Host", (x) => x.r.answer === "badHost" && x.h("host").length === 0);
  has("/mcp alone with the walk's scope", (x) => x.r.answer === "pass" && x.r.path === "/mcp");
  has("a wrong path scope", (x) => x.r.answer === "session" && /^\/mcp\/md-worker$/.test(x.r.path) && mcpConnection(x.c).scope === "md-lead");
  has("an MCP session id of another scope", (x) => x.r.answer === "unknownSession" && endpoint.mcpSessionIds[x.h("mcp-session-id")[0]] && endpoint.mcpSessionIds[x.h("mcp-session-id")[0]] !== mcpConnection(x.c).scope);
  has("Origin with the session's own token", (x) => x.r.answer === "fromPage" && bearer(x) && mcpSha256(bearer(x)) === own(x)?.mcp_token);
  has("the walk refuses a browser process", (x) => x.r.answer === "session" && (x.c.procs ?? []).some((p: any) => /Chrome/.test(p.note ?? "") && x.c.connection.holders.includes(p.pid)));
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
  has("the no-list 503 with a valid token", (x) => x.r.answer === "noList" && bearer(x) && mcpSha256(bearer(x)) === own(x)?.mcp_token);
  has("a snapshot that drops the session: the walk's refusal", (x) => x.r.answer === "session" && x.c.service.snapshot === "workerDropped" && bearer(x) === T.worker.token);
  has("a changed mcp_token: the session's own token of its new snapshot", (x) => x.c.service.snapshot === "leadNull" && x.r.answer === "noToken");
  // The order: each earlier step before the token, and the token before the readiness.
  for (const [what, answer] of [["Origin", "fromPage"], ["Host", "badHost"], ["the path", "mcpNotFound"], ["the path's scope", "session"]]) has(`${what} before step 7`, (x) => x.r.answer === answer && x.h("authorization").length === 0);
  has("step 7 before step 8", (x) => x.r.answer === "needsToken" && x.c.service.ready !== "ready");
  has("the admission before the transport", (x) => x.r.answer === "needsToken" && x.h("mcp-session-id").length > 0);
  has("step 1 before step 7: another uid with no token", (x) => x.r.answer === "peerUnread" && x.h("authorization").length === 0);
  has("step 2 before step 7: no session with no token", (x) => x.r.answer === "session" && x.h("authorization").length === 0 && x.r.path === "/mcp/md-lead" && mcpConnection(x.c).answer === "session");
  has("steps 3 to 8 for each request", (x) => x.c.requests.length === 2 && x.r.answer !== "pass");
  for (const id of ["controlOff", "notConnected", "notConfirmed", "tooOld"]) has(`step 8: ${id}`, (x) => x.r.answer === id);
  for (const a of endpoint.mcpAnswers) has(`a vector of ${a.id}`, (x) => x.r.answer === a.id);
  // The lead's decisions on the open points of part 2a.
  has("OP1: before the first set_sessions the walk's session's 403, with the session's own token", (x) => x.c.service.snapshot === null && x.r.answer === "session" && bearer(x) === T.leadRun2.token);
  has("OP2: a list with no site: the no-list 503 with the session's own token", (x) => x.r.answer === "noList" && x.c.service.snapshot !== null && endpoint.mcpLists[snapOf(x.c).lists[mcpConnection(x.c).scope]]?.length === 0 && mcpSha256(bearer(x)) === own(x)?.mcp_token);
  for (const path of ["/mcp/./md-lead", "/mcp/x/../md-lead", "//mcp/md-lead", "/mcp/md%2Dlead", "http://127.0.0.1:47311/mcp/md-lead"]) has(`OP5: the raw path ${path}: the 404`, (x) => x.r.answer === "mcpNotFound" && x.r.path === path && bearer(x) === T.leadRun2.token);
  has("OP5: a query does not change the path", (x) => x.r.answer === "pass" && x.r.path.startsWith("/mcp/md-lead?"));
  has("OP7: a space after the session's own token: admitted", (x) => x.r.answer === "pass" && x.h("authorization")[0] === `Bearer ${T.leadRun2.token} `);
  has("OP7: Bearer with only spaces after it: no token", (x) => x.r.answer === "needsToken" && /^Bearer {2,}$/.test(x.h("authorization")[0] ?? ""));
});

test("at each set_sessions: each MCP close vector follows C11 (a session that the snapshot drops, a changed mcp_token, an admitting root that left)", () => {
  const closes = new Set<string | null>();
  for (const v of endpoint.mcpCloses) {
    const before = endpoint.mcpSnapshots[v.connection.snapshot].sessions.find((s: any) => s.scope === v.connection.scope);
    assert.ok(before?.roots.some((r: any) => r.pid === v.connection.root.pid && r.start === v.connection.root.start), `${v.note}: the root admitted the connection`);
    const now = endpoint.mcpSnapshots[v.snapshot].sessions.find((s: any) => s.scope === v.connection.scope);
    const got = !now ? "dropped" : now.mcp_token !== before.mcp_token ? "token" : !now.roots.some((r: any) => r.pid === v.connection.root.pid && r.start === v.connection.root.start) ? "root" : null;
    assert.equal(got, v.close, v.note);
    closes.add(v.close);
  }
  assert.deepEqual([...closes].sort(), ["dropped", "root", "token", null].sort(), "a vector of each close, and of a connection that stays");
  assert.ok(endpoint.mcpCloses.some((v: any) => v.close === "token" && endpoint.mcpSnapshots[v.snapshot].sessions.find((s: any) => s.scope === v.connection.scope).mcp_token === null), "a fingerprint that became null closes");
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
    "`{\"scope\":\"taylor/<session>\",\"box\":\"taylor\",\"list\":<the grant's list>,\"mcp_token\":\"<64 hex>\"}`",
    "Each admitted request goes, unread, to the Mac service's agent door for that scope (stage 5 decides the carrier: the Mac's gateway or the Mac's daemon).",
    "**The address check** (the operator's answer ab-5t3):",
    "**The route** (the gateway's rules):",
    "**The box comes from the link.**",
    "**The check of each list before the merge.**",
    "| The remote token's mint and the session's entry on taylor, the link, the seal, the machine keys, the grant and its approval, the fingerprint lists, the gateway route and its rules, the address check, the rate limit, the Mac rules, the remote session in `set_sessions` (its box from the link's peer identity, each list checked before the merge) | agentwatch |",
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
// The stage is not built yet (board tasks ab-t30.9 to ab-t30.12, behind a build switch): C11's part "The input stage" and
// test/vectors/stage.json are the contract that the build follows. The tests assert each sentence of the part exactly, and
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
  "Board tasks ab-t30.9 to ab-t30.12 and ab-t30.19 build the stage behind a build switch.",
  "The switch stays off until all five tasks are merged, so that no part of the stage reaches a client before the whole stage is built.",
  "While the switch is off, the model sends each call as the rest of this file says, and no rule of this part applies.",
  "In this file, \"with the stage on\" names a rule that applies only while the switch is on.",
  // board ab-t30.19: sentences with no text before.
  "With the switch on, the daemon's relay (`agent-browser relay`, the daemon's child) has no clipboard of its own display, so a long text never pastes there: it goes as Playwright's own input (the paste, below, rule 2).",
  "Every client.",
  "With the stage on, the stage shapes the input of every client of agent mode on every site, on Linux and on the Mac:",
  "Playwright, the Playwright MCP inside the service, and agent-browser's own commands over the endpoint (the answer Q1 a).",
  "No client sets anything.",
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
  "each utility call that a recognizer matches (the recognizers, below).",
  "It passes every other call as the rest of this file says.",
  // board ab-t30.19 (before: On a child session of a cross-origin frame, the stage takes only `DOM.scrollIntoViewIfNeeded` and the utility calls of the hit-target, focus and fill recognizers.)
  "On a child session of a cross-origin frame, the stage takes only `DOM.scrollIntoViewIfNeeded`, the utility calls of the hit-target, focus and fill recognizers, and each `Input.*` call (review-126 note 3).",
  "Such an input call goes as the client sent it, in an action of the tab under the input lock, and it gets Chrome's answer within `STAGE_EVENT_WAIT_MS` (the action's watchdog), so no key reaches a frame while a paste of another page has its text on the clipboard (the paste, below).",
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
  "The lock that an ended plan's events take again (dialogs, below) has the same limit: at the limit it is free, and the plan's remaining ended calls go with no lock and no activation.",
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
  "The end of the wait for a close: `Page.javascriptDialogClosed`; Chrome's answer to the client's `Page.handleJavaScriptDialog`; the client's `Page.disable` (no `Page.javascriptDialogClosed` can come after it); `Inspector.targetCrashed`; a navigation of the tab's main frame (`Page.frameNavigated` with no parent); and the end of the tab in the model (a drop).",
  "At the first four the steps above go on: the stage sends the held events, and each held client call gets Chrome's answer, or Chrome's error.",
  "At the others:",
  "A navigation of the main frame.",
  "The stage sends no held move, press or key press, so none reaches the new document.",
  "Each held client call gets the error that the context is gone.",
  "Step 4 sends only the release of each button and key that the plan holds, with the `clickCount` of its press, so nothing stays down.",
  "Then the lock is free, and the gate opens.",
  "The end of the client's session or connection (also a C10 timeout's detach, which ends the client's sessions of the tab, and the end of the relay's link, which closes every connection).",
  "The stage sends no held event, and nothing goes back to the client.",
  "It sends only the release of each button and key that the plan holds, with the `clickCount` of its press, at once, before the model detaches the tab.",
  "The lock is free at once, and the gate opens.",
  "The tab's end (its target ends, the tab closes, or Chrome detaches it).",
  "The lock is free at once.",
  "Each held client call goes to Chrome as the client sent it, with no lock, and gets Chrome's answer, or Chrome's error for a closed target.",
  "Then the stage sends the release of each button and key that the plan holds, and the gate opens.",
  "A drop ends the plan also when no dialog is open.",
  "Each held call of a dropped tab ends on the tab's old state, also when its step runs after the drop, so no lock stays with a dropped tab.",
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
  "`(Date.now() - latency) / 1000` on Linux, in whole milliseconds, as X11 gives the times of its events.",
  "The latency is `STAGE_LATENCY_MS` = 3 to 5 (ms, a first value).",
  "The time comes from the send, never from the plan, so no event has a time in the future.",
  "On the Mac the timestamp keeps its fraction:",
  "`(performance.timeOrigin + performance.now() - latency) / 1000`.",
  "Pointer moves go at the rate of a device: one move each `STAGE_MOVE_MS = 8` ms (125 Hz, a first value).",
  "The stage sends each move at its time, with no wait for the answer of the move before it.",
  "Chromium then puts the moves of one frame into one `pointermove` with their samples, as for a real mouse.",
  "At most `STAGE_MOVES_IN_FLIGHT = 8` moves of a tab are without an answer.",
  "When a move is due while 8 wait, the stage stops the path, sends the client's own event, and logs it.",
  "For the stage's paths this bound takes the place of `CATCH_UP_MAX_UNANSWERED`.",
  "On Linux the stage rounds each point to a whole CSS px, as X11 gives its points.",
  "Playwright's points can have a fraction.",
  "A person's input (first values).",
  "The generator (`src/human/`) draws each value with a seed, from the parameter files `src/human/params/linux.json` and `mac.json`.",
  "A reviewed change of a parameter file changes these values, this part and the vectors together.",
  "Each scope gets one person, drawn once for the life of the scope, so that a site cannot link two sessions by one rhythm.",
  "A path starts at the page's last point, never at a fixed point.",
  "When the page has no last point, the path starts at the X pointer's place mapped into the page (Linux, at an activation), else at a random point of the middle 30% to 70% of the viewport.",
  "A path has one sample each `STAGE_MOVE_MS`, in whole px on Linux, with no sample that does not move, at a speed of at most 3.5 px/ms.",
  "It ends at the client's point, or at the spread point of its press (below).",
  "Its time is 300 to 1000 ms (Fitts's law).",
  "When a long move cannot keep both rules, the speed rule wins: the path takes longer than 1000 ms, and its time has no upper bound.",
  "A move of more than 500 px can add an overshoot leg only while its time stays at most 1500 ms.",
  "The pause before a press is 80 to 400 ms.",
  "The press has `force` 0.5 and a hold of 60 to 180 ms.",
  "The gap of a double click, from the first release to the second press, is 90 to 150 ms.",
  "The hold of a key is 50 to 250 ms.",
  "A Shift `rawKeyDown` comes 45 to 95 ms before a shifted character, which then has `modifiers` 8, and the release of Shift comes 15 to 60 ms after the release of the last key that it holds.",
  "A run of shifted characters keeps Shift down.",
  "In a chord, each modifier comes 40 to 120 ms before the key, and the releases come 20 to 80 ms apart, in reverse order.",
  // Board ab-t30.10 (review-111 point 3): a client's chord of two modifiers.
  // review-119 N9 (before: "A client's second modifier of one chord (for example `Control+Shift+ArrowLeft`) comes 20 to 80 ms after the first.").
  "A client's later modifier of one chord (for example the Shift of `Control+Shift+ArrowLeft`) comes 20 to 80 ms after the one before, and less when that keeps all of them within 80 ms of the first, so that the key comes 40 to 120 ms after each.",
  "A wheel notch is `STAGE_NOTCH_PX = 120` px on Linux (the notch of X11), and the gaps between notches are 35 to 90 ms.",
  "No idle moves: the pointer moves only for a client's call (the answer Q4 a).",
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
  "It sends the rest of the path to the client's point as `Input.dispatchDragEvent`: first a `dragEnter` of its own at the first point after the report (with the data of `Input.dragIntercepted`), then `dragOver` events at the rate of the device.",
  "When Chrome reports no drag, the whole path goes with the button down.",
  "A client's `Input.dispatchDragEvent` in a drag of the stage: a `dragEnter` goes as a `dragOver` at its point, because the page has its `dragenter` already.",
  "A `dragOver` goes as a path of `dragOver` events to its point.",
  "A `drop` goes after a pause, as a press does.",
  "A `dragCancel` goes as it is.",
  "A drag event of a drag that the stage did not start goes as it is.",
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
  "At the close of a connection, the tabs whose last sessions end flush at the same time, each within `STAGE_FLUSH_MS` (below), before their detaches (review-126b R1).",
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
  "The daemon's relay (`agent-browser relay`) has none, because its display is the daemon's: there a long text never pastes, and it goes as Playwright's own input.",
  "No connection holds a grant of the clipboard (`clipboardReadWrite` or `clipboardSanitizedWrite`: permissions and content settings, below), and no change of its setting is under way: a grant counts from the client's `Browser.grantPermissions` until a `Browser.resetPermissions` or the close of its connection has cleared the setting (review-126 note 2).",
  "Its content setting acts on the whole profile, and a page with it can read the clipboard.",
  "The client holds no key.",
  "The focused element (the typing rule's read) is an `input` of a text type or a `textarea`.",
  "A contenteditable keeps Playwright's own input, because the editor of a page can change a pasted text.",
  "No earlier paste's `V` (of any tab) waits for its answer (review-126 B4).",
  "Chrome reads the selection in `V`'s default action, after the page's `keydown` handler, so a page whose handler runs long reads it late: with a handler of 3 s, Chrome asked for the selection 3,004 to 3,016 ms after the send of `V`, and when the owner held another page's text at 2.5 s, the page pasted that text (measured by board ab-t30.19 on Chromium 156).",
  "A `V` with no answer closes the paste path until its answer comes or its tab ends, and each long text then goes as Playwright's own input; the stage counts it.",
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
  "The input lock gives one paste at a time, no paste puts its text on the selection while an earlier paste's `V` has no answer (rule 6), and a frame's own session gets no input while a text is on the selection (the calls that the stage takes, above).",
  "The sign-in act (below) never uses the clipboard: its own fill sends a long value as one `Input.insertText`.",
  "Its calls go to the bridge through the model's act port, which has no clipboard, and the stage never sees them (review-126 note 8).",
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
  "When the notches cannot bring it into view, and on the Mac until the Mac's wheel model exists, the field gets no click, and the stage counts it.",
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
  "While the stage holds a button (the scroll of `dragTo`'s drop target), it sends the client's call as it is, and counts it: a path with no button would end the drag (board ab-t30.12 decides the drag).",
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
  "Until the Mac's wheel model exists (part B, board ab-t30.7, and the input design's build task 9), the stage sends `mouseWheel` and `DOM.scrollIntoViewIfNeeded` on the Mac as the client sent them, with the stage's timestamp.",
  "Files:",
  "`DOM.setFileInputFiles` with `files` (Playwright's `setInputFiles` with paths and a local browser).",
  "The stage clicks the input with the file chooser intercepted (`Page.setInterceptFileChooserDialog`, as `src/input.ts` `setFiles` does), and it sends the client's files to the input that the chooser names.",
  "It turns the interception on only for its click, when the client has it off, and turns it off after the click.",
  "A `Page.fileChooserOpened` of the stage's own interception does not go to a client.",
  "When the click opens no chooser in 2 s, when the chooser names another input, or when another element covers the input, the stage sends the client's call as it is, and counts it.",
  "The recognizers.",
  "A utility call is a `Runtime.callFunctionOn` of Playwright's utility script, `(utilityScript, ...args) => utilityScript.evaluate(...args)`.",
  "Its arguments are, in this order: the utility script, two flags, the text of Playwright's function (the `value` of the fourth argument), the count of arguments, Playwright's serialized argument, and then the handles.",
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
  "| select option | `^async\\s*\\(\\[injected\\b[^\\]]*\\]\\)\\s*=>\\s*\\{[\\s\\S]*\\breturn\\s+injected\\.selectOptions\\(node,\\s*[\\w$]+\\);?\\s*\\}\\s*$` | the node | nothing: the call passes, and the stage counts it |",
  "| set files | `^\\(\\[injected\\b[^\\]]*\\]\\)\\s*=>\\s*injected\\.setInputFiles\\([^)]*\\)\\s*$` | the node | nothing: the call passes, and the stage counts it |",
  "A text that only contains one of these names, for example in a client's own function, does not match.",
  "The vectors' `recognizers` hold the texts of Playwright 1.64.1, 1.65.0 and 1.66.0-alpha-2026-11-09 (the `playwright-core` of `@playwright/mcp` 0.0.85).",
  "A test pins them.",
  "A Playwright version with other texts matches no recognizer, and its calls pass unchanged;",
  "a release adds its texts to the vectors.",
  "A call that no recognizer matches passes unchanged, and the stage counts it.",
  "No client's action fails because of it.",
  "The stage never answers a utility call itself and never changes its arguments.",
  "It only puts its own input before the call.",
  "`locator.drop()` and `dispatchEvent()` run scripts of Playwright's in the page's main world, and they pass as any call.",
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
  "The script calls (the answer Q3 a).",
  "In the first build these calls pass, and the stage counts them:",
  "`selectOption`, until a probe shows that the popup of a select takes CDP keys;",
  "the `fill` of a `date`, `time`, `datetime-local`, `month`, `week`, `color` or `range` input (a script sets the value);",
  "`setInputFiles` with buffers, `locator.drop`, `dispatchEvent` and `blur`;",
  "`focus` on an element that is not a text field, and `selectText` on an element that is not an `input` or a `textarea`.",
  "The page sees the script's events (`isTrusted` false), as with Playwright's own input.",
  "Board task ab-t30.12 adds the translations of Q3 a, and it changes this part first: a select gets a click, the arrow keys and Enter;",
  "a date input gets a click and typed digits;",
  "files from buffers get a click on the input, with the files in the scope's own folder.",
  "The cases of no change.",
  "The stage sends a call as the client sent it, in the order of the gate, and counts it, in these cases.",
  "An input call then gets the stage's timestamp.",
  "a call of a kind that this part does not name (for example `Input.synthesizeTapGesture`, or `Input.dispatchTouchEvent` of a client that turned on touch itself);",
  "a utility call that no recognizer matches;",
  // board ab-t30.19 (before: a text that the typing rule refuses (the answer Q2 a);)
  "a text that the typing rule refuses (the answer Q2 a), and a long text or a collected part that the paste rule refuses;",
  "a script call that a person cannot make (the answer Q3 a);",
  "a wheel or a scroll on the Mac, until the Mac's wheel model exists;",
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
  "`STAGE_MOVE_MS = 8`, `STAGE_LATENCY_MS` = 3 to 5, `STAGE_EVENT_WAIT_MS = 2000`, `STAGE_MOVES_IN_FLIGHT = 8`, `STAGE_NOTCH_PX = 120` (Linux), `STAGE_TYPE_MAX_MS = 10000`, `STAGE_ACTION_MAX_MS = 25000`, `STAGE_SCROLL_ROUNDS = 4`, `CLIPBOARD_HOLD_MS = 500`, `STAGE_FLUSH_MS = 5000`.",
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
    "With the stage on (the input stage, below), the catch-up is the stage's path.",
    "After an X record or a cover mark, the stage's next path starts at the recorded point.",
    "The catch-up's own rules (the thresholds of 50 px and 2 px, the samples of 16 ms, `CATCH_UP_MAX_UNANSWERED`) give way to the stage's rules: each path starts at the page's last point, at the rate of a device, within the bound `STAGE_MOVES_IN_FLIGHT`.",
  ],
  "Refusals.": [
    "The input stage (above) adds no refusal (the operator's answer Q3 a, board item ab-0z5): a call that a person cannot make passes, or it goes as a person's input that gives the same result.",
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
    "The Mac (with the stage on). Until the Mac's wheel model exists (part B, board ab-t30.7, and the input design's build task 9), the stage sends `mouseWheel` and `DOM.scrollIntoViewIfNeeded` on the Mac as the client sent them, with the stage's timestamp.",
    "A client's `Page.handleJavaScriptDialog` never waits. With the stage on, the model sends it to Chrome at once, before the tab's gate and before any step of the stage, of an activation or of a world lookup.",
    "Each read of the stage waits at most `GEOMETRY_WAIT_MS` (200 ms).",
    "Each wait for an answer of the stage's own event has the limit `STAGE_EVENT_WAIT_MS = 2000`, counted from the oldest event of the plan that has no answer.",
  ]);
});

test("C11's MCP inside the service changes by one sentence only (the input design's section 12.1, point 8)", () => {
  const mcp = partOr("The MCP inside the service (from stage 1d; the self-contained design, section 8.2).");
  const bullets = mcp.split("\n- ").slice(1).map((b) => flat(b).trim());
  assert.equal(bullets.length, 13, "the seven bullets of stage 0, the input stage's one, stage 1d part 2b's four (the configuration, the roots, the ticket, the worker) and the folder's life (board ab-v16.94.12, review-115 note 3)");
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
  // Board ab-t30.19: CLIPBOARD_HOLD_MS, the paste's wait for the clipboard's owner, is a constant of the part too.
  const named = [...new Set([...design.matchAll(/`((?:STAGE|CLIPBOARD)_[A-Z_]+)/g)].map((m) => m[1]))];
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
      for (const f of Object.keys(o)) assert.ok(["method", "type", "for", "from", "at", "rule", "fields", "pass", "session", "path", "line", "gapMs", "durMs", "durRule", "count", "notches", "rest", "typing", "holdMs", "shift"].includes(f), `${at}: a known field ${f}`);
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

test("each stage vector's events follow C11's rules: paths, short moves, presses, the spread point, wheel notches, typed keys and the Mac's pass", () => {
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
        assert.ok(linux && o.notches === undefined && p?.type === "mouseWheel" && o.from === `out:${k - 1}` && o.rule === "notchGapMs" && within(o.at, F.notchGapMs), `${at}: the rest one person's gap after the notches before it`);
        assert.ok(o.fields.x === p.fields.x && o.fields.y === p.fields.y, `${at}: at the notches' point`);
        const sum = Math.abs(o.fields.deltaY) + Math.abs(o.fields.deltaX);
        assert.ok(sum > K.STAGE_NOTCH_PX && sum % K.STAGE_NOTCH_PX === 0, `${at}: the sum of whole notches`);
      } else if (o.method === "Input.dispatchMouseEvent" && o.type === "mouseWheel") {
        assert.ok(linux, `${at}: no notch on the Mac`);
        assert.deepEqual(o.gapMs, F.notchGapMs, `${at}: a person's gaps between notches`);
        assert.equal(Math.abs(o.fields.deltaY) + Math.abs(o.fields.deltaX), K.STAGE_NOTCH_PX, `${at}: a notch of STAGE_NOTCH_PX`);
      }
      if (o.typing !== undefined) {
        const t: string = o.typing;
        for (const ch of t) assert.ok(charKey(ch), `${at}: ${JSON.stringify(ch)} has a US key (typing rule 2)`);
        assert.ok(!/[\n\t]/.test(t), `${at}: no line feed and no tab (typing rule 2)`);
        assert.ok(t.length * F.fastKeyMs[1] <= K.STAGE_TYPE_MAX_MS, `${at}: the plan fits in STAGE_TYPE_MAX_MS (typing rule 3)`);
        const field = v.page.nodes[v.page.focused] ?? v.page.nodes[nodeOf(v.in.find((c: any) => recognizerOf(V, c) === "fill")?.params ?? {})];
        assert.ok(typesInto(field), `${at}: typed keys only into an input of a text type or a textarea (typing rule 1)`);
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
        if (c.method === "Input.dispatchMouseEvent" && c.params.type === "mouseWheel") assert.ok(!linux, `${at}: a wheel passes only on the Mac`);
        if (c.method === "Input.insertText") {
          const t: string = c.params.text;
          const field = v.page.nodes[v.page.focused];
          assert.ok(/[\n\t]/.test(t) || [...t].some((ch) => !charKey(ch)) || t.length * F.fastKeyMs[0] > K.STAGE_TYPE_MAX_MS || !typesInto(field), `${at}: an Input.insertText passes only when the typing rule refuses it`);
        }
        // A scroll into view passes on the Mac, or at a fallback: here the end after a round that does not move the scroller.
        const round = o.from.startsWith("out:") ? v.out[outIndex(o.from)] : null;
        if (c.method === "DOM.scrollIntoViewIfNeeded") assert.ok(!linux || (round?.notches > 0 && round.for === o.for && o.at[0] >= F.scrollWaitMs), `${at}: a scroll into view passes only on the Mac or at its fallback`);
      }
    });
    // The wheel: n = max(0, round((|delta| + r) / 120)) notches, r the residual in the call's direction; one notch when n is 0 and r >= 0.
    for (const c of v.in.filter((x: any) => x.method === "Input.dispatchMouseEvent" && x.params.type === "mouseWheel")) {
      const items = v.out.filter((o: any) => o.for === c.id);
      if (!linux) { assert.ok(items.length === 1 && items[0].pass, `${w} ${c.id}: the Mac's wheel passes`); continue; }
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
    // DOM.scrollIntoViewIfNeeded on Linux: in view, {} with no event; else the notches that bring the middle to the middle
    // of its scroller (the viewport, or a frame's own viewport), from the scroller's position; then {} after the smooth
    // scroll's wait, or the client's call when the round did not move the scroller.
    for (const c of v.in.filter((x: any) => x.method === "DOM.scrollIntoViewIfNeeded")) {
      const n = v.page.nodes[c.params.objectId], b = n.box, f = n.frame ? v.page.frames[n.frame] : null, d = f ? (f.border ?? 0) + (f.padding ?? 0) : 0;
      const vp = f ? { width: f.box.width - 2 * d, height: f.box.height - 2 * d } : v.page.viewport, sy = f ? f.scrollY ?? 0 : v.page.scrollers?.document?.scrollY ?? 0;
      const axis = (lo: number, size: number, view: number, share: number) => (lo >= 0 && lo + size <= view) || Math.abs(lo + size / 2 - view / 2) <= (view * share) / 2;
      const inView = axis(b.x, b.width, vp.width, 0.8) && axis(b.y - sy, b.height, vp.height, 0.6);
      const items = v.out.filter((o: any) => o.for === c.id);
      const a = v.answers.find((x: any) => x.id === c.id);
      if (!linux) continue;
      if (inView) assert.ok(items.length === 0 && a.after === "none" && isObj(a.result) && Object.keys(a.result).length === 0, `${w} ${c.id}: in view: {} with no event`);
      else {
        const want = Math.round((b.y - sy + b.height / 2 - vp.height / 2) / K.STAGE_NOTCH_PX);
        assert.ok(items.some((o: any) => o.notches === Math.abs(want) && o.fields.deltaY === Math.sign(want) * K.STAGE_NOTCH_PX), `${w} ${c.id}: ${want} notches bring the middle to the middle`);
        const passed = items.find((o: any) => o.pass);
        if (passed) assert.ok(passed.at[0] >= F.scrollWaitMs && a.after === `out:${v.out.indexOf(passed)}`, `${w} ${c.id}: the client's call after the round that did not move the scroller`);
        else assert.ok(a.rule === "scrollWaitMs" && a.at[0] >= F.scrollWaitMs && isObj(a.result), `${w} ${c.id}: {} after the smooth scroll's wait`);
      }
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
        assert.equal(clicks.length, isTextField(n) && !n.focused && name !== "select text" || (name === "select text" && typesInto(n) && !n.focused) ? 1 : 0, `${w} ${c.id}: a focus click only for a text field with no focus`);
      }
      if (["retry scroll", "blur", "select option", "set files", null].includes(name) && c.method === "Runtime.callFunctionOn") {
        assert.ok(v.out.filter((o: any) => o.for === c.id).every((o: any) => o.pass), `${w} ${c.id}: the call passes`);
      }
    }
  }
});

test("each stage vector's answers follow C11's rules: each call once, held until its events, an early answer only for a key release, a dialog's answer first", () => {
  const V = vectorsOrFail();
  for (const v of V.vectors) {
    const w = v.id;
    assert.deepEqual(v.answers.map((a: any) => a.id).sort((x: number, y: number) => x - y), v.in.map((c: any) => c.id), `${w}: each call gets one answer`);
    const byId = new Map(v.in.map((c: any) => [c.id, c]));
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
  "**The sign-in act (from stage 1e; the stored sign-ins design, board ab-v16.95).** The design is `docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md`, sections 4, 7 and 8, with the operator's answers of 2026-11-10 (board item ab-8w8: Q1 a, Q2 b, Q3 b, Q4 a). The service's model builds the act in stage 1e part 2 (board ab-v16.97.4), off by default, and it serves sessions from stage 3. The store, its ops and the act's events are C12's (the stored sign-ins). The relay has no sign-in act: it refuses both methods as calls outside its set (`Not available in the agent browser: <method>.`). On the Mac the store and the act stay off until stage 4 measures whether another program of the same user can read the service's memory.",
  "What the act does. An agent asks for a sign-in by the name of a credential that the operator stored. The service types the credential's username and password into a tab of its own that no client can reach, and moves the sign-in's cookies and `localStorage` into the default context. No answer, event, status or log line holds a username, a password or a form value.",
  "The entry.",
  "CDP: `AgentBrowser.signIn` with `{\"name\":\"<name>\"}` and `AgentBrowser.signIns` with `{}`, on the root session or on a browser session of the agent door. The model answers both (where each call goes, above). On a page session the model refuses both with `Not available in the agent browser: <method>.`, and they never reach Chrome. Playwright sends them on a browser CDP session: `const s = await browser.newBrowserCDPSession(); await s.send(\"AgentBrowser.signIn\", { name: \"staging\" })`.",
  "The CLI: `agent-browser sign-in <name>` and `agent-browser sign-ins`, and `agentwatch browser sign-in <name>`, a thin wrapper. They send the method over the agent door, so the walk gives the scope.",
  "The MCP: the service's own tools `browser_sign_in` (`name`) and `browser_sign_ins` (no argument), of the allow list's `service_tools`. The service runs them as the method for the MCP session's scope, only for a request that the MCP port admitted with the uid check and the walk (a local admission). A request that a remote token admitted (stage 5: the token design, section 10) gets a `tools/list` without them, and a call of either name gets the refusal of check 1.",
  "`AgentBrowser.signIns` answers the store's state and the names and the origins that the caller's scope may use (checks 2 and 3, below): `{\"state\":\"none\"|\"locked\"|\"open\",\"signIns\":[{\"name\":\"<name>\",\"origin\":\"<origin>\"}]}`. Names and origins are not secrets. It refuses only by check 1, and it sends no `sign_in` event (C12).",
  "The checks before the act, in this order. The first check that fails gives its text (what the agent sees, below), and no act starts.",
  "The request came by a local admission: the agent door (the kernel's peer check and the walk), or the MCP port with the uid check and the walk. A request on the MCP's ticket connection to the endpoint has the admission of its MCP session. A request that a remote token admitted never reaches a later check. The agent browser is ready (the readiness, before the upgrade).",
  "The last `sign_ins` (C12) holds a record of that `name` whose `approved` is `true`, and the scope's list covers the record's host. With the answer Q2 b, each scope whose list covers the host may use the credential: a credential names no repos. No such name, a name whose host the scope's list does not cover, and an offer that waits get the same text. Two approved records of one name in the last `sign_ins` each break (C12, names and ids), so check 2 finds neither of them, and the request gets that text too (C12's vector `checkTwo`).",
  "The scope's list covers each host of the record's `send_to`.",
  "The store is open (C12).",
  "The record opens: its seal's tag holds with its plain fields as the additional data, so its `approved` is `true` in the seal too; its `gen` is not lower than the highest `gen` that the service saw for its `id`; and its `id` is not a removed id.",
  "The credential is not stopped, and fewer than 6 of its acts started in the last hour.",
  "No other act runs. An act waits for the act before it, at most 60 s. A request that waited is checked again at its turn: checks 4, 5 and 6 run again before the act starts, and the record's values open only then, so a stop of the credential or the hour's last act by an act before it, or a lock during the wait, refuses it as a check before the act does.",
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

test("C11's part on the sign-in act holds exactly its sentences, and it is the last part of C11", () => {
  const p = partOr(SIGN_IN_HEADING);
  for (const s of SIGN_IN_ITEMS) assert.ok(says(p, s), `C11 says: ${s}`);
  assert.equal(clean(p), SIGN_IN_ITEMS.join(" "), "the part holds no other text");
  const at = C11.indexOf(`**${SIGN_IN_HEADING}`);
  assert.ok(C11.indexOf("**How a session gets the MCP (from stage 2;") < at && C11.indexOf("\n**", at + 2) < 0, "the part comes after how a session gets the MCP, at the end");
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
  { file: "C11", why: "the test flag and the socket take (part 2b, item 8; review-114 note 1)", old: "- The URL is `http://127.0.0.1:<port>/mcp/<scope>`. The service listens on `127.0.0.1` only, on one port for", text: "- The MCP port is off by default. The service opens it only when systemd passes it the socket of `agent-browser-mcp.socket` (the sd_listen_fds protocol), or in its `--test` mode with `--test-mcp-port <port>`: 0 (a free port that the kernel picks) or a port from 1024 to 65535, on `127.0.0.1`. It has no default port. As sd_listen_fds does, the service sets `FD_CLOEXEC` on each passed fd as soon as `LISTEN_PID` and `LISTEN_FDS` are its own, before it reads the names, and it removes `LISTEN_PID`, `LISTEN_FDS` and `LISTEN_FDNAMES` from its environment in every path: also in `--test` mode, where it takes no passed fd, and when only `LISTEN_FDNAMES` is set. When the take fails, the service opens no MCP port, and `status` says `failed` (C12). The service opens the MCP port before its control door, so the MCP's state, and with it the hello's features, is fixed before the first hello (C12). - The URL is `http://127.0.0.1:<port>/mcp/<scope>`. The service listens on `127.0.0.1` only, on one port for" },
  { file: "C11", why: "the answer for one more MCP session (part 2b, item 3)", old: "- The service makes one Playwright MCP server object for each MCP session, from the pinned `@playwright/mcp` package's public entry. At most 4 MCP sessions for each scope and 32 for each service (first values).", text: "- The service makes one Playwright MCP server object for each MCP session, from the pinned `@playwright/mcp` package's public entry. At most 4 MCP sessions for each scope and 32 for each service (first values). One more `initialize` gets HTTP 503 with the JSON-RPC error `-32000` and the text `The agent browser serves at most 4 MCP sessions for each agentwatch session. End one of this session's MCP sessions (DELETE), then initialize again.` or, at the service's limit, `The agent browser serves at most 32 MCP sessions, and each is in use. Initialize again later.`" },
  { file: "C11", why: "the configuration and the roots (part 2b, item 4)", old: "- Its configuration also sets `timeouts.action: 30000` in `createConnection`, in place of the MCP's default of 5 s, so that an action that the input stage (above) translates ends inside the MCP's action timeout.", text: "- Its configuration also sets `timeouts.action: 30000` in `createConnection`, in place of the MCP's default of 5 s, so that an action that the input stage (above) translates ends inside the MCP's action timeout. - It also sets `webmcp: false` (a page's own tools: their listing runs page code, and no allow list names them) and `saveSession: false`. The scope's CDP endpoint comes through the context getter of `createConnection`, which connects with the ticket (below) and gives the default context: with `browser.cdpEndpoint` in the configuration the package would also start a pipe server for the browser in the temp folder and write a server registry entry, which another program of the user could use to reach the browser around the agent door. So the MCP never launches, downloads or binds a browser. - The service answers the MCP server's `roots/list` itself, with the scope's folder, so the MCP's own file guardrail and its relative file names use that folder. It answers each other request of the server to the client with `Method not found`, and it drops the server's notifications (the transport sends no stream)." },
  { file: "C11", why: "the path rule (part 2b, item 6)", old: "- The service refuses each argument that the allow list marks as a path when the path is outside the scope's folder, `<state>/mcp/<scope>/`, after `realpath`.", text: "- The service refuses each argument that the allow list marks as a path when the path is outside the scope's folder, `<state>/mcp/<scope>/`, after `realpath`. A relative path is read from the scope's folder; for a file that does not exist yet the service takes the `realpath` of its deepest folder that exists. A value that is no string and no list of strings is refused as a path. The service makes `<state>/mcp` and the scope's folder, each with mode 0700, at the scope's first MCP session. At each path argument it reads both with `lstat`: when one of them is a link or no folder of the service's user, it refuses each path argument with the format's answer (a call with no path argument passes)." },
  { file: "C11", why: "the ticket (part 2b, item 5)", old: "- The MCP's Playwright connects back to the endpoint's CDP path with the MCP session's scope and a one-time ticket, which only a connection from the service's own pid can use. Every rule of this file applies to that connection.", text: "- The MCP's Playwright connects back to the endpoint's CDP path with the MCP session's scope and a one-time ticket, which only a connection from the service's own pid can use. Every rule of this file applies to that connection. - The ticket is 32 random bytes in base64url, in the query of the CDP path: `/devtools/browser/<scope>?ticket=<ticket>`. The service makes a new ticket for the worker at each connect of the MCP's browser: at the first tool that needs the browser, and again at the next such tool after `browser_close` or after the endpoint closed the connection (a 1008 close, for example). A ticket lives 30 s (first value), and it is gone after its first check, whatever the result. In the agent door's checks before the upgrade, the ticket takes the place of the walk at step 6: a connection from the service's own pid passes it only with a live ticket of its scope, and no root admits it; with no such ticket it gets the session's 403. A ticket from any other pid admits nothing, and that connection gets the walk. The ticket never leaves the service's process, and no log line holds it." },
  { file: "C11", why: "the worker (part 2b, item 7)", old: "- The MCP code of each scope runs in one worker thread of the service, with a heap limit (first value 512 MiB). A worker that passes it ends with its MCP sessions, and their clients get an error.", text: "- The MCP code of each scope runs in one worker thread of the service, with a heap limit (first value 512 MiB). A worker that passes it ends with its MCP sessions, and their clients get an error. - The service starts a scope's worker at the scope's first MCP session and stops it with its last. The worker has an environment of its own (no variable of the service's environment reaches it), and the service reads and drops its standard output and error. When a worker passes its limit, each request that waits for it gets the JSON-RPC error `-32603` with the text `This MCP session has ended: the MCP of its agentwatch session passed its memory limit. Initialize a new MCP session.` (after a failure of the worker: `This MCP session has ended: the MCP of its agentwatch session failed. Initialize a new MCP session.`; an `initialize` whose server object is not made yet gets the 503 of the transport's table), and each later request of those MCP sessions gets the 404 of an unknown MCP session. The model, Chrome, the doors and the other scopes' workers go on." },
  { file: "C11", why: "the transport (part 2b, item 3)", old: "**How a session gets the MCP (from stage 2; the operator's answer Q2 of ab-bi3, and the daemon lead's condition 4).**", text: "**The transport of the MCP path (from stage 1d; the self-contained design, section 8.2).** The service's own small Streamable HTTP transport, with no MCP SDK package, answers each request that passed steps 1 to 8, with JSON only: - A `POST` carries one JSON-RPC message, and a request gets one answer with `Content-Type: application/json`. A batch gets HTTP 400 with `-32600` and `Invalid Request: the agent browser takes one JSON-RPC message in each POST.`; a body that is no JSON gets HTTP 400 with `-32700` and `Parse error`; a body of more than 1 MiB (first value) gets HTTP 413 with `-32600` and `Request too large: the agent browser takes at most 1048576 bytes in one POST.`, and the connection closes. - `initialize` makes a new MCP session: its id, 32 lowercase hex digits, is in the answer's `Mcp-Session-Id` header. An `initialize` with an `Mcp-Session-Id` gets HTTP 400. Each other message carries the session's id: with none it gets HTTP 400 with `-32000` and `Bad Request: this request needs the Mcp-Session-Id of its MCP session; initialize first.`; an unknown id, or an id of another scope, gets the 404 of an unknown MCP session: HTTP 404 with `-32001` and `Session not found`. - Of the requests only `initialize`, `ping`, `tools/list` and `tools/call` reach the MCP; each other request gets `-32601` and `Method not found`. Of the notifications only `notifications/initialized` and `notifications/cancelled` reach it, and the others are dropped. A notification or a client's answer gets HTTP 202 with no body. A client that closes its connection before its answer cancels that request: when the MCP has the request, the service sends it `notifications/cancelled`, and the service frees the request's id at once (the MCP never answers a request that it cancelled), so a later request with that id goes on. A client's own `notifications/cancelled` of a request of its MCP session that still waits reaches the MCP too, and it frees that id at once; the request's POST, while it is open, gets HTTP 200 with `-32800` and `Request cancelled: the client sent notifications/cancelled for this request.` (a tool call that waits for the start at a use gets it when that wait ends, or that wait's refusal). The MCP has no code of its own for a cancelled request, and `-32800` is the code that the Language Server Protocol gives one. The pinned MCP ignores a cancel whose `requestId` is `0` or `\"\"`, or whose `params` its schema refuses (a `reason` that is no string), and it then runs the call and answers it. So once the MCP has the request, such a cancel frees nothing: the id stays busy and a tool call counts as a use until the MCP's answer, which goes to the POST while it is open; for a client that closes its connection, the service sends no cancel for the id `0` or `\"\"`. - A `GET` gets HTTP 405 with `Allow: POST, DELETE`: the service sends no stream. A `DELETE` with the session's id ends that MCP session: HTTP 200 with no body. - At `session_ended` and at the close at a change, each request of an MCP session that ends while it waits gets `-32603` and `This MCP session has ended: its agentwatch session ended or changed. Initialize a new MCP session.` (an `initialize` whose server object is not made yet gets the 503 of the table below). - No log line of the transport holds an MCP session id; a line names an MCP session by its number. The transport's answers: each answer of an error carries the request's id, or `null` when the request has none that the service can read (a body that is no JSON-RPC 2.0 message of the shapes below has none). The transport gives no other answer than these, the HTTP 200 answers of the allow list's format (`docs/contracts/mcp-allow-list.md`), the 202 and the 200 above, and the MCP's own answers: the result or the JSON-RPC error that the MCP gives to a request that reaches it, which the transport passes on with HTTP 200 (for `tools/list`, with only the list's tools and keys). | Case | HTTP status | JSON-RPC code | Text | | --- | --- | --- | --- | | A batch | 400 | `-32600` | `Invalid Request: the agent browser takes one JSON-RPC message in each POST.` | | A body that is no JSON | 400 | `-32700` | `Parse error` | | A body that is JSON but no JSON-RPC 2.0 message of the three shapes below, also a message whose id is no string and no safe integer | 400 | `-32600` | `Invalid Request` | | A request whose id is the id of a request of the same MCP session that still waits | 400 | `-32600` | `Invalid Request: a request with this id still waits in this MCP session.` | | A body of more than 1 MiB | 413 | `-32600` | `Request too large: the agent browser takes at most 1048576 bytes in one POST.` | | An `initialize` with an `Mcp-Session-Id` | 400 | `-32600` | `Bad Request: initialize makes a new MCP session, so it carries no Mcp-Session-Id.` | | Another message with no `Mcp-Session-Id` | 400 | `-32000` | `Bad Request: this request needs the Mcp-Session-Id of its MCP session; initialize first.` | | An `Mcp-Session-Id` that the service does not know, or one of another scope | 404 | `-32001` | `Session not found` | | A `GET`, or a method other than `POST` and `DELETE` | 405 | `-32000` | `Method not allowed: the agent browser's MCP sends no stream; POST each message, and DELETE ends the MCP session.` | | One more `initialize` at the scope's limit | 503 | `-32000` | `The agent browser serves at most 4 MCP sessions for each agentwatch session. End one of this session's MCP sessions (DELETE), then initialize again.` | | One more `initialize` at the service's limit | 503 | `-32000` | `The agent browser serves at most 32 MCP sessions, and each is in use. Initialize again later.` | | An `initialize` whose MCP session the service cannot make | 503 | `-32000` | `The agent browser could not make an MCP session now. Initialize again.` | | A request of another method | 200 | `-32601` | `Method not found` | | A request that its client cancelled with its own `notifications/cancelled` while its POST is open | 200 | `-32800` | `Request cancelled: the client sent notifications/cancelled for this request.` | | A request of an MCP session that ends while it waits (`session_ended`, the close at a change, a `DELETE`) | 200 | `-32603` | `This MCP session has ended: its agentwatch session ended or changed. Initialize a new MCP session.` | | A request that waits for a worker that passed its heap limit | 200 | `-32603` | `This MCP session has ended: the MCP of its agentwatch session passed its memory limit. Initialize a new MCP session.` | | A request that waits for a worker that failed | 200 | `-32603` | `This MCP session has ended: the MCP of its agentwatch session failed. Initialize a new MCP session.` | - The service cannot make an MCP session when the scope's worker does not make the session's server object within 30 s (first value) or fails to make it, when the session ends before its server object is made (`session_ended`, the close at a change, the worker's heap limit or failure), or when the service stops. An `initialize` whose MCP session ends after its server object is made gets the `-32603` answer of its end, as any request that waits. - A JSON-RPC 2.0 message is a JSON object with `jsonrpc` `\"2.0\"` in one of three shapes, with no other member: a request (`jsonrpc`, an `id`, a `method` that is a string, and a `params` or none), a notification (`jsonrpc`, a `method` that is a string, and a `params` or none), or a client's answer (`jsonrpc`, an `id`, and exactly one of `result` and `error`). A `params` is a JSON object; its `_meta`, when it has one, is a JSON object whose `progressToken`, when it has one, is a string or a safe integer, and whose `io.modelcontextprotocol/related-task`, when it has one, is a JSON object with a string `taskId`. An `id` is a string or a safe integer: an integer from -(2^53 - 1) to 2^53 - 1 (a larger one loses its exact value in the service's JSON parse). The shapes of a request and of a notification are exactly the shapes that the MCP's own SDK takes: it gives no answer to a request of another shape (the pinned version: an extra member, a `params` that is no object, a `_meta` that is no object), so a body of another shape never reaches the MCP. A client's answer never reaches the MCP (the service sends no request to the client), so its shape is the transport's own (the SDK would also take an error with no id). A request whose id is the id of a request of the same MCP session that still waits never reaches the MCP either, and the waiting request keeps its own answer. A request waits until its answer or its cancel, from the moment that it passes the transport's checks (a tool call also while it waits for the start at a use). **How a session gets the MCP (from stage 2; the operator's answer Q2 of ab-bi3, and the daemon lead's condition 4).**" },
  { file: "TDP", why: "review-114 note 4 (OP1, the same in the token design)", old: "Until the daemon's first `set_sessions`, no root counts, so each MCP connection gets the session's 403 of step 2: C11's order holds, and the 403's text says to connect again in a few seconds.", text: "Until the daemon's first `set_sessions`, no root counts, so each MCP connection with a holder gets the session's 403 of step 2: C11's order holds, and the 403's text says to connect again in a few seconds." },
  { file: "C12P", why: "review-114 note 3 (OP6)", old: "(a session launched while the name was shared has none, so its MCP gets the second 401 of C11's step 7).", text: "(a session launched while the name was shared has none, so agentwatch writes no MCP entry for it: its client sends no `Authorization` header and gets the first 401 of C11's step 7, and only a request with a bearer gets the second 401)." },
  { file: "C12P", why: "status mcp (part 2b, item 8)", old: "`state` is `none` while the service has no MCP (before stage 1d), and then `address` is `null`. Stage 1d names the other states and fixes the form of `address`, an opaque text that the daemon shows as it is. This file fixes no transport of the MCP.", text: "`state` is `none` while the service serves no MCP (before stage 1d, and from stage 1d while its MCP path is off), and then `address` is `null`. From stage 1d `state` is also `ready` while the service serves the MCP with its admission and its token check, and `closed` while the service closes each MCP connection with no answer (the Mac, until its peer reader exists), each with the MCP's `address` (C11: `127.0.0.1:<port>`); and `failed` when the service could not open its MCP path, with the `address` `null`. The daemon shows `address` as it is." },
  { file: "C12P", why: "the hello (part 2b, item 8)", old: "- The service's hello gets the feature `mcp_token` in stage 1d, with the MCP path and its token check.", text: "- The service's hello gets the feature `mcp_token` in stage 1d, with the MCP path and its token check. The hello lists it while `status`'s `mcp` state is `ready`, and only then; `agent-browser service --hello` serves no MCP, so its hello has no `mcp_token`. The service opens its MCP path before its control door, so its `mcp` state is fixed before its first hello and stays the same for the service's run: each connection of a run gets the same features, and a hello with no `mcp_token` means no MCP until the service's next start. The daemon waits for no other line." },
  { file: "ALLOWP", why: "the first list (part 2b, item 2)", old: "Stage 1d (board ab-v16.94.5) writes the first list for the pinned version of `@playwright/mcp`, and its test. Stage 1d's first list holds the 24 tools of M3's part C (the self-contained design, section 8.2), and no `browser_run_code_unsafe`.", text: "Stage 1d (board ab-v16.94.5) writes the first list for the pinned version of `@playwright/mcp`, and its test. Stage 1d's first list, `src/service/mcp/allow-list.json`, is for `@playwright/mcp` 0.0.83: it holds the 24 tools of that version's `tools/list` other than `browser_run_code_unsafe`, as M3's part C did for 0.0.85 (the self-contained design, section 8.2)." },
  { file: "ALLOWP", why: "the arguments that are no object; the service tools before stage 1e (part 2b, item 2)", old: "- `tools/call` with an argument key that the tool's `keys` does not name: the service refuses it before the call reaches the MCP's code, with the JSON-RPC error `-32602` and the message `Not available in the agent browser: the argument <key> of <tool>`.", text: "- `tools/call` with an argument key that the tool's `keys` does not name: the service refuses it before the call reaches the MCP's code, with the JSON-RPC error `-32602` and the message `Not available in the agent browser: the argument <key> of <tool>`. - `tools/call` whose `arguments` is not a JSON object: the service refuses it before the call reaches the MCP's code, with the JSON-RPC error `-32602` and the message `Not available in the agent browser: the arguments of <tool> must be a JSON object`. - Until stage 1e (board ab-v16.97.5) serves them, the service's own tools are in no `tools/list`, and a `tools/call` of one gets the `-32601` answer of a tool that `tools` does not name." },
  { file: "ALLOWP", why: "the test reads the file words widely (part 2b, item 2)", old: "- each string property whose schema speaks of a file or a path (its name or its description) is in `paths`, or is left out of `keys`;", text: "- each string property whose schema speaks of a file or a path (its name or its description) is in `paths`, or is left out of `keys`, with no exception for a string whose values an `enum` or a `const` fixes, with the `type` `string` or with no `type`; a schema speaks of a file or a path when its name or its description holds `file`, `path`, `folder` or `directory`, in any case, also inside a word (so `browser_take_screenshot`'s `type`, an `enum` string whose description names the file name's extension, is left out of `keys` in the first list); the test reads each string inside a key's schema too, in `anyOf`, `oneOf`, `allOf`, `items`, nested `properties`, `additionalProperties` and `propertyNames`, with the names and descriptions on its way, and a key whose schema has a shape that the test cannot read (no `type` and no `anyOf`, `oneOf`, `allOf`, `enum` or `const`, a `$ref`, or a keyword that the test does not know) fails the test; - each key that a tool's `schema` requires is in its `keys`; - no tool's `keys` names `_meta` (the package reads `arguments._meta` to change the base of relative file names);" },
]
test("stage 1d part 2b and review-114: C11, C12, the token design and the allow list's format say each new text exactly, and no old text", () => {
  const files: Record<string, string> = { C11, C12P, ALLOWP, TDP };
  assert.equal(PART_2B.length, 18);
  for (const e of PART_2B) {
    assert.ok(says(files[e.file], e.text), `${e.file}, ${e.why}: ${e.text.slice(0, 120)}`);
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

// Review-115 (the fix round of stage 1d part 2b): each changed or new text, exactly; each old text that the round
// replaced is gone. The list of old and new texts is in the PR's body for the daemon lead.
const PART_2B_R1: { file: string; why: string; old: string; text: string }[] = [
  { file: "C11", why: "review-115 B2 and note 7: every answer of the transport, its causes, and the request ids", old: "- At `session_ended` and at the close at a change, each request of an MCP session that ends while it waits gets `-32603` and `This MCP session has ended: its agentwatch session ended or changed. Initialize a new MCP session.` - No log line of the transport holds an MCP session id; a line names an MCP session by its number.", text: "- At `session_ended` and at the close at a change, each request of an MCP session that ends while it waits gets `-32603` and `This MCP session has ended: its agentwatch session ended or changed. Initialize a new MCP session.` (an `initialize` whose server object is not made yet gets the 503 of the table below). - No log line of the transport holds an MCP session id; a line names an MCP session by its number. The transport's answers: each answer of an error carries the request's id, or `null` when the request has none that the service can read (a body that is no JSON-RPC 2.0 message of the shapes below has none). The transport gives no other answer than these, the HTTP 200 answers of the allow list's format (`docs/contracts/mcp-allow-list.md`), the 202 and the 200 above, and the MCP's own answers: the result or the JSON-RPC error that the MCP gives to a request that reaches it, which the transport passes on with HTTP 200 (for `tools/list`, with only the list's tools and keys). | Case | HTTP status | JSON-RPC code | Text | | --- | --- | --- | --- | | A batch | 400 | `-32600` | `Invalid Request: the agent browser takes one JSON-RPC message in each POST.` | | A body that is no JSON | 400 | `-32700` | `Parse error` | | A body that is JSON but no JSON-RPC 2.0 message of the three shapes below, also a message whose id is no string and no safe integer | 400 | `-32600` | `Invalid Request` | | A request whose id is the id of a request of the same MCP session that still waits | 400 | `-32600` | `Invalid Request: a request with this id still waits in this MCP session.` | | A body of more than 1 MiB | 413 | `-32600` | `Request too large: the agent browser takes at most 1048576 bytes in one POST.` | | An `initialize` with an `Mcp-Session-Id` | 400 | `-32600` | `Bad Request: initialize makes a new MCP session, so it carries no Mcp-Session-Id.` | | Another message with no `Mcp-Session-Id` | 400 | `-32000` | `Bad Request: this request needs the Mcp-Session-Id of its MCP session; initialize first.` | | An `Mcp-Session-Id` that the service does not know, or one of another scope | 404 | `-32001` | `Session not found` | | A `GET`, or a method other than `POST` and `DELETE` | 405 | `-32000` | `Method not allowed: the agent browser's MCP sends no stream; POST each message, and DELETE ends the MCP session.` | | One more `initialize` at the scope's limit | 503 | `-32000` | `The agent browser serves at most 4 MCP sessions for each agentwatch session. End one of this session's MCP sessions (DELETE), then initialize again.` | | One more `initialize` at the service's limit | 503 | `-32000` | `The agent browser serves at most 32 MCP sessions, and each is in use. Initialize again later.` | | An `initialize` whose MCP session the service cannot make | 503 | `-32000` | `The agent browser could not make an MCP session now. Initialize again.` | | A request of another method | 200 | `-32601` | `Method not found` | | A request that its client cancelled with its own `notifications/cancelled` while its POST is open | 200 | `-32800` | `Request cancelled: the client sent notifications/cancelled for this request.` | | A request of an MCP session that ends while it waits (`session_ended`, the close at a change, a `DELETE`) | 200 | `-32603` | `This MCP session has ended: its agentwatch session ended or changed. Initialize a new MCP session.` | | A request that waits for a worker that passed its heap limit | 200 | `-32603` | `This MCP session has ended: the MCP of its agentwatch session passed its memory limit. Initialize a new MCP session.` | | A request that waits for a worker that failed | 200 | `-32603` | `This MCP session has ended: the MCP of its agentwatch session failed. Initialize a new MCP session.` | - The service cannot make an MCP session when the scope's worker does not make the session's server object within 30 s (first value) or fails to make it, when the session ends before its server object is made (`session_ended`, the close at a change, the worker's heap limit or failure), or when the service stops. An `initialize` whose MCP session ends after its server object is made gets the `-32603` answer of its end, as any request that waits. - A JSON-RPC 2.0 message is a JSON object with `jsonrpc` `\"2.0\"` in one of three shapes, with no other member: a request (`jsonrpc`, an `id`, a `method` that is a string, and a `params` or none), a notification (`jsonrpc`, a `method` that is a string, and a `params` or none), or a client's answer (`jsonrpc`, an `id`, and exactly one of `result` and `error`). A `params` is a JSON object; its `_meta`, when it has one, is a JSON object whose `progressToken`, when it has one, is a string or a safe integer, and whose `io.modelcontextprotocol/related-task`, when it has one, is a JSON object with a string `taskId`. An `id` is a string or a safe integer: an integer from -(2^53 - 1) to 2^53 - 1 (a larger one loses its exact value in the service's JSON parse). The shapes of a request and of a notification are exactly the shapes that the MCP's own SDK takes: it gives no answer to a request of another shape (the pinned version: an extra member, a `params` that is no object, a `_meta` that is no object), so a body of another shape never reaches the MCP. A client's answer never reaches the MCP (the service sends no request to the client), so its shape is the transport's own (the SDK would also take an error with no id). A request whose id is the id of a request of the same MCP session that still waits never reaches the MCP either, and the waiting request keeps its own answer. A request waits until its answer or its cancel, from the moment that it passes the transport's checks (a tool call also while it waits for the start at a use)." },
  { file: "C11", why: "review-115 B2: the worker's end during an initialize", old: "(after a failure of the worker: `This MCP session has ended: the MCP of its agentwatch session failed. Initialize a new MCP session.`), and each later request of those MCP sessions gets the 404 of an unknown MCP session.", text: "(after a failure of the worker: `This MCP session has ended: the MCP of its agentwatch session failed. Initialize a new MCP session.`; an `initialize` whose server object is not made yet gets the 503 of the transport's table), and each later request of those MCP sessions gets the 404 of an unknown MCP session." },
  { file: "C11", why: "review-115 B1 and note 1: the open before the control door; the variables in every path", old: "in every path. When the take fails, the service opens no MCP port, and `status` says `failed` (C12).", text: "in every path: also in `--test` mode, where it takes no passed fd, and when only `LISTEN_FDNAMES` is set. When the take fails, the service opens no MCP port, and `status` says `failed` (C12). The service opens the MCP port before its control door, so the MCP's state, and with it the hello's features, is fixed before the first hello (C12)." },
  { file: "C11", why: "review-115 note 2: real folders, not links", old: "no list of strings is refused as a path. The service makes the folder, with mode 0700, at the scope's first MCP session.", text: "no list of strings is refused as a path. The service makes `<state>/mcp` and the scope's folder, each with mode 0700, at the scope's first MCP session. At each path argument it reads both with `lstat`: when one of them is a link or no folder of the service's user, it refuses each path argument with the format's answer (a call with no path argument passes)." },
  { file: "C11", why: "review-115 note 13: a new ticket at each connect", old: "The service makes it for the worker at the MCP's first tool that needs the browser; it lives 30 s (first value), and", text: "The service makes a new ticket for the worker at each connect of the MCP's browser: at the first tool that needs the browser, and again at the next such tool after `browser_close` or after the endpoint closed the connection (a 1008 close, for example). A ticket lives 30 s (first value), and" },
  { file: "C11", why: "review-115 note 2: the limit of the path rule", old: "session. The stored sign-ins do not change this: such a process can replace the service and wait for the operator's next unlock, or use the display's X authority during an act.", text: "session. The stored sign-ins do not change this: such a process can replace the service and wait for the operator's next unlock, or use the display's X authority during an act. - The path rule of the MCP inside the service (below) does not stop a process of the same OS user either: it can put a link or a hard link to another file into the scope's folder, or change a file between the service's check and the MCP's open of it." },
  { file: "C12P", why: "review-115 B1: the hello is right for each connection", old: "- The service's hello gets the feature `mcp_token` in stage 1d, with the MCP path and its token check. The hello lists it while `status`'s `mcp` state is `ready`, and only then; `agent-browser service --hello` serves no MCP, so its hello has no `mcp_token`.", text: "- The service's hello gets the feature `mcp_token` in stage 1d, with the MCP path and its token check. The hello lists it while `status`'s `mcp` state is `ready`, and only then; `agent-browser service --hello` serves no MCP, so its hello has no `mcp_token`. The service opens its MCP path before its control door, so its `mcp` state is fixed before its first hello and stays the same for the service's run: each connection of a run gets the same features, and a hello with no `mcp_token` means no MCP until the service's next start. The daemon waits for no other line." },
  { file: "ALLOWP", why: "review-115 note 6: tools/list shows only the list's keys", old: "- `tools/list`: the service drops each tool that `tools` does not name, and adds each tool of `service_tools` for a request with a local admission; a request that a remote token admitted gets no tool of `service_tools`.", text: "- `tools/list`: the service drops each tool that `tools` does not name, and adds each tool of `service_tools` for a request with a local admission; a request that a remote token admitted gets no tool of `service_tools`. - In `tools/list` the input schema of each tool of `tools` holds only the keys of its `keys`: the service drops each other property and its entry in `required`." },
  { file: "ALLOWP", why: "review-115 notes 5, 6 and 9: the list test reads deeper; required keys; _meta", old: "names the file name's extension, is left out of `keys` in the first list);", text: "names the file name's extension, is left out of `keys` in the first list); the test reads each string inside a key's schema too, in `anyOf`, `oneOf`, `allOf`, `items`, nested `properties`, `additionalProperties` and `propertyNames`, with the names and descriptions on its way, and a key whose schema has a shape that the test cannot read (no `type` and no `anyOf`, `oneOf`, `allOf`, `enum` or `const`, a `$ref`, or a keyword that the test does not know) fails the test; - each key that a tool's `schema` requires is in its `keys`; - no tool's `keys` names `_meta` (the package reads `arguments._meta` to change the base of relative file names);" },
];
test("review-115: C11, C12 and the allow list's format say each text of the fix round exactly, and no replaced text", () => {
  const files: Record<string, string> = { C11, C12P, ALLOWP };
  for (const e of PART_2B_R1) {
    assert.ok(says(files[e.file], e.text), `${e.file}, ${e.why}: ${e.text.slice(0, 160)}`);
    if (!flat(e.text).includes(flat(e.old))) assert.ok(!says(files[e.file], e.old), `${e.file}, ${e.why}: the old text is gone`);
  }
  assert.ok(!/MCP port|--test-mcp-port|agent-browser-mcp\.socket/.test(C12P), "C12 names no MCP port");
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
  {"file": "C11", "why": "review-115b P2 and its note: the service's cancel frees the id at once; a client's own cancel gets an answer", "old": "A client that closes its connection before its answer cancels that request (`notifications/cancelled`).", "text": "A client that closes its connection before its answer cancels that request: when the MCP has the request, the service sends it `notifications/cancelled`, and the service frees the request's id at once (the MCP never answers a request that it cancelled), so a later request with that id goes on. A client's own `notifications/cancelled` of a request of its MCP session that still waits reaches the MCP too, and it frees that id at once; the request's POST, while it is open, gets HTTP 200 with `-32800` and `Request cancelled: the client sent notifications/cancelled for this request.` (a tool call that waits for the start at a use gets it when that wait ends, or that wait's refusal). The MCP has no code of its own for a cancelled request, and `-32800` is the code that the Language Server Protocol gives one. The pinned MCP ignores a cancel whose `requestId` is `0` or `\"\"`, or whose `params` its schema refuses (a `reason` that is no string), and it then runs the call and answers it. So once the MCP has the request, such a cancel frees nothing: the id stays busy and a tool call counts as a use until the MCP's answer, which goes to the POST while it is open; for a client that closes its connection, the service sends no cancel for the id `0` or `\"\"`."},
  {"file": "C11", "why": "review-115b P4: the id null of a body of another shape", "old": "", "text": "The transport's answers: each answer of an error carries the request's id, or `null` when the request has none that the service can read (a body that is no JSON-RPC 2.0 message of the shapes below has none)."},
  {"file": "C11", "why": "review-115b P3: the MCP's own answers, passed on with HTTP 200", "old": "(`docs/contracts/mcp-allow-list.md`), and the 202 and the 200 above.", "text": "The transport gives no other answer than these, the HTTP 200 answers of the allow list's format (`docs/contracts/mcp-allow-list.md`), the 202 and the 200 above, and the MCP's own answers: the result or the JSON-RPC error that the MCP gives to a request that reaches it, which the transport passes on with HTTP 200 (for `tools/list`, with only the list's tools and keys)."},
  {"file": "C11", "why": "review-115b P4 and its note on safe integers: the 400 row of a body of another shape", "old": "| A body that is JSON but no JSON-RPC 2.0 message, or a request whose id is no string and no integer | 400 | `-32600` | `Invalid Request` |", "text": "| A body that is JSON but no JSON-RPC 2.0 message of the three shapes below, also a message whose id is no string and no safe integer | 400 | `-32600` | `Invalid Request` |"},
  {"file": "C11", "why": "review-115b's note: the row of a request that its client cancelled", "old": "", "text": "| A request that its client cancelled with its own `notifications/cancelled` while its POST is open | 200 | `-32800` | `Request cancelled: the client sent notifications/cancelled for this request.` |"},
  {"file": "C11", "why": "review-115b P4 and its note on safe integers: the three shapes, the safe integer, the wait of a request", "old": "- A request's id is a string or an integer: a request with another id never reaches the MCP.", "text": "- A JSON-RPC 2.0 message is a JSON object with `jsonrpc` `\"2.0\"` in one of three shapes, with no other member: a request (`jsonrpc`, an `id`, a `method` that is a string, and a `params` or none), a notification (`jsonrpc`, a `method` that is a string, and a `params` or none), or a client's answer (`jsonrpc`, an `id`, and exactly one of `result` and `error`). A `params` is a JSON object; its `_meta`, when it has one, is a JSON object whose `progressToken`, when it has one, is a string or a safe integer, and whose `io.modelcontextprotocol/related-task`, when it has one, is a JSON object with a string `taskId`. An `id` is a string or a safe integer: an integer from -(2^53 - 1) to 2^53 - 1 (a larger one loses its exact value in the service's JSON parse). The shapes of a request and of a notification are exactly the shapes that the MCP's own SDK takes: it gives no answer to a request of another shape (the pinned version: an extra member, a `params` that is no object, a `_meta` that is no object), so a body of another shape never reaches the MCP. A client's answer never reaches the MCP (the service sends no request to the client), so its shape is the transport's own (the SDK would also take an error with no id). A request whose id is the id of a request of the same MCP session that still waits never reaches the MCP either, and the waiting request keeps its own answer. A request waits until its answer or its cancel, from the moment that it passes the transport's checks (a tool call also while it waits for the start at a use)."},
  {"file": "C11", "why": "review-115 note 3: the scope's folder lives as long as the scope's session", "old": "", "text": "- The scope's folder lives as long as the scope's agentwatch session (review-115 note 3). At C12's `session_ended`, and at each C12 `set_sessions` for each scope that the snapshot names neither in `sessions` nor in `remote` (also a session that ended while the service was down, which got no `session_ended`), the service ends the scope's MCP sessions and, after the request's answer and once every worker of the scope has stopped, removes the scope's folder with its files. So a later session of the same launch name does not read the files of an earlier one, and its first MCP session makes the folder again; an MCP session of the scope that begins before those workers have stopped keeps the folder and its files. While two live sessions share a launch name, the daemon sends no item for that name (C12, the field rules; the vectors' `r14`), so the service removes that name's folder while the earlier session lives, as it removes the list copy (C12). The service removes only a folder or a link whose name is a scope, and only while `<state>/mcp` is a folder of the service's user that is no link; a link in the scope's place or in the folder goes as a link, and its target stays, and another entry of a scope's name (a plain file) stays. A removal that fails gets a log line with the scope and the error's code, never a path. The service's own stop removes no folder."},
  {"file": "C12", "why": "review-115 note 3: session_ended removes the MCP folder", "old": "closes its MCP connections and ends its MCP sessions (C11), removes its list copy, and records the ended scope.", "text": "closes its MCP connections, ends its MCP sessions and, after its answer, once the scope's MCP workers have stopped, removes its MCP folder with its files (C11), removes its list copy, and records the ended scope."},
  {"file": "C12", "why": "review-115 note 3: set_sessions removes the MCP folder of each scope that it does not name", "old": "", "text": "It removes the MCP folder of each scope that the snapshot does not name, with its files, after its answer, once the scope's MCP workers have stopped (C11). Each `set_sessions` is the daemon's whole list of live sessions: a scope that a snapshot leaves out loses its MCP sessions and its MCP folder with its files. So after its start the daemon sends its first `set_sessions` only when its own discovery of the live sessions is complete."},
  {"file": "ALLOWP", "why": "review-115b P1: no exception for a string with enum or const", "old": "", "text": "is left out of `keys`, with no exception for a string whose values an `enum` or a `const` fixes, with the `type` `string` or with no `type`;"},
];
test("board ab-v16.94.12: C11, C12 and the allow list's format say each text of review-115b and of note 3 exactly, and no replaced text", () => {
  const files: Record<string, string> = { C11, C12: C12P, ALLOWP };
  assert.equal(REVIEW_115B.length, 10);
  for (const e of REVIEW_115B) {
    assert.ok(says(files[e.file], e.text), `${e.file}, ${e.why}: ${e.text.slice(0, 160)}`);
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
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readAllowList } = await import("../src/service/mcp/allow-list.ts");
  const dir = mkdtempSync(join(tmpdir(), "ab-c11-folder-log-"));
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
  {"file": "C11", "why": "review-121 notes 1 and 2: the cancel goes to the MCP only when it has the request; a cancel that the MCP ignores frees nothing", "old": "A client that closes its connection before its answer cancels that request: the service sends `notifications/cancelled` to the MCP, and it frees the request's id at once (the MCP never answers a cancelled request), so a later request with that id goes on. A client's own `notifications/cancelled` of a request of its MCP session that still waits reaches the MCP too, and it frees that id at once; the request's POST, while it is open, gets HTTP 200 with `-32800` and `Request cancelled: the client sent notifications/cancelled for this request.` (a tool call that waits for the start at a use gets it when that wait ends, or that wait's refusal). The MCP has no code of its own for a cancelled request, and `-32800` is the code that the Language Server Protocol gives one.", "text": "A client that closes its connection before its answer cancels that request: when the MCP has the request, the service sends it `notifications/cancelled`, and the service frees the request's id at once (the MCP never answers a request that it cancelled), so a later request with that id goes on. A client's own `notifications/cancelled` of a request of its MCP session that still waits reaches the MCP too, and it frees that id at once; the request's POST, while it is open, gets HTTP 200 with `-32800` and `Request cancelled: the client sent notifications/cancelled for this request.` (a tool call that waits for the start at a use gets it when that wait ends, or that wait's refusal). The MCP has no code of its own for a cancelled request, and `-32800` is the code that the Language Server Protocol gives one. The pinned MCP ignores a cancel whose `requestId` is `0` or `\"\"`, or whose `params` its schema refuses (a `reason` that is no string), and it then runs the call and answers it. So once the MCP has the request, such a cancel frees nothing: the id stays busy and a tool call counts as a use until the MCP's answer, which goes to the POST while it is open; for a client that closes its connection, the service sends no cancel for the id `0` or `\"\"`."},
  {"file": "C11", "why": "review-121 note 3: the SDK's shapes for a request and a notification; a client's answer never reaches the MCP", "old": "These are the shapes that the MCP's own SDK takes: it gives no answer to a message of another shape (the pinned version: an extra member, a `params` that is no object, a `_meta` that is no object), so a body of another shape never reaches the MCP.", "text": "The shapes of a request and of a notification are exactly the shapes that the MCP's own SDK takes: it gives no answer to a request of another shape (the pinned version: an extra member, a `params` that is no object, a `_meta` that is no object), so a body of another shape never reaches the MCP. A client's answer never reaches the MCP (the service sends no request to the client), so its shape is the transport's own (the SDK would also take an error with no id)."},
  {"file": "C11", "why": "review-121 B3, B2 and notes 4 to 6: a shared launch name, a failed removal, every stopping worker, after the answer, only a folder or a link", "old": "- The scope's folder lives as long as the scope's agentwatch session (review-115 note 3). At C12's `session_ended`, and at each C12 `set_sessions` for each scope that the snapshot names neither in `sessions` nor in `remote` (also a session that ended while the service was down, which got no `session_ended`), the service ends the scope's MCP sessions and, once the scope's worker has stopped, removes the scope's folder with its files. So a later session of the same launch name never reads the files of an earlier one, and its first MCP session makes the folder again. The service removes only a folder whose name is a scope, and only while `<state>/mcp` is a folder of the service's user that is no link; a link in the scope's place goes as a link, and its target stays. A new MCP session of the scope before that stop keeps the folder. The service's own stop removes no folder.", "text": "- The scope's folder lives as long as the scope's agentwatch session (review-115 note 3). At C12's `session_ended`, and at each C12 `set_sessions` for each scope that the snapshot names neither in `sessions` nor in `remote` (also a session that ended while the service was down, which got no `session_ended`), the service ends the scope's MCP sessions and, after the request's answer and once every worker of the scope has stopped, removes the scope's folder with its files. So a later session of the same launch name does not read the files of an earlier one, and its first MCP session makes the folder again; an MCP session of the scope that begins before those workers have stopped keeps the folder and its files. While two live sessions share a launch name, the daemon sends no item for that name (C12, the field rules; the vectors' `r14`), so the service removes that name's folder while the earlier session lives, as it removes the list copy (C12). The service removes only a folder or a link whose name is a scope, and only while `<state>/mcp` is a folder of the service's user that is no link; a link in the scope's place or in the folder goes as a link, and its target stays, and another entry of a scope's name (a plain file) stays. A removal that fails gets a log line with the scope and the error's code, never a path. The service's own stop removes no folder."},
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
  { file: "C11", why: "review-124 B1 and N2: a request that waited is checked again at its turn", old: "No other act runs. An act waits for the act before it, at most 60 s.", text: "No other act runs. An act waits for the act before it, at most 60 s. A request that waited is checked again at its turn: checks 4, 5 and 6 run again before the act starts, and the record's values open only then, so a stop of the credential or the hour's last act by an act before it, or a lock during the wait, refuses it as a check before the act does." },
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
