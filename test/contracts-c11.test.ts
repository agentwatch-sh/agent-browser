// Contract C11 (the endpoint): docs/contracts/C11.md is its master since board task ab-v16.94.1, and
// test/vectors/endpoint.json its vectors. Both came from chrome-extension (docs/protocol.md and test/vectors/endpoint.json
// at main 66078cd), with these tests: they moved from chrome-extension's test/contracts.test.mjs with the text, so that
// the tests stay beside the text that they read. The small reference rules below follow the text, so a vector that breaks
// a rule fails here first. The bridge's constants (C10) come from the copy of chrome-extension's bridge.json at 8a3b66f
// (its constants and pointer constants are the same at 66078cd). Tests for the parts that the self-contained agent
// browser adds (board ab-v16.94: the service, the MCP path, the per-session MCP configuration) are at the end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeEntry } from "../src/relay/scopes.ts";

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

// Where a call goes (C11's table): the model, Chrome, or a refusal.
function route(session, method, params = {}, child = false) {
  if (session === "root") return endpoint.modelSet.includes(method) ? "the model" : "refused";
  if (method === "Target.setAutoAttach") return "Chrome";
  if (method === "Target.getTargetInfo") return params.targetId === undefined ? "Chrome" : "the model";
  if (method === "Target.detachFromTarget") return child ? "Chrome" : "the model";
  if (/^(Target|Browser)\./.test(method)) return endpoint.pageModelSet.includes(method) ? "the model" : "refused";
  return "Chrome";
}

test("C11's table says where each call of the model's set goes, and the routing vectors agree", () => {
  const rows = table(C11, "| Method | On the root or a browser session | On a page session |");
  assert.deepEqual([...rows.keys()].sort(), [...endpoint.modelSet].sort());
  for (const [method, cells] of rows) {
    assert.equal(cells[0], "the model", method);
    assert.ok(cells[1].startsWith(route("page", method)), `${method}: ${cells[1]}`);
  }
  for (const r of endpoint.routing) assert.equal(route(r.session, r.method, r.params, r.child === true), r.to, `${r.session} ${r.method} ${JSON.stringify(r.params)}`);
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

test("C11's master is this file since board ab-v16.94.1: where the text and the vectors came from, the names of the other contracts, the parties", () => {
  assert.ok(C11.startsWith("# C11. The endpoint (agent-browser's relay; from stage 1 also the service)\n"), "the heading");
  const master = partOr("The master of C11 (board task ab-v16.94.1).");
  for (const s of [
    "This file is the master for C11 since board task ab-v16.94.1, stage 0 of the self-contained agent browser.",
    "Its text came from chrome-extension `docs/protocol.md` (main `66078cd`), where C11 was before, with no change of a rule.",
    "That file keeps a short C11 that names this file.",
    "The vectors came with the text: this repository's `test/vectors/endpoint.json` is a copy of chrome-extension's `test/vectors/endpoint.json` at `66078cd`, and it is the master of C11's vectors from then on.",
    "In this file, C1 to C10 are the contracts of chrome-extension `docs/protocol.md`, and `test/vectors/scopes.json` and `test/vectors/bridge.json` are chrome-extension's vectors of C4 and C10.",
    "C12 is the control door, `docs/contracts/C12.md`.",
    "C11 binds this repository (the relay, and from stage 1 the service) and agentwatch (the daemon). The receiver's own rules stay in C4, C5 and C10.",
  ]) assert.ok(says(master, s), `C11 says: ${s}`);
  // The old intro's own sentence still holds here, and the text names this repository's vectors.
  assert.ok(says(C11, "This file is the master for C11. The vectors: `test/vectors/endpoint.json`."), "the old intro's sentence");
});

test("C11 states the stages of the self-contained agent browser, and that stage 0 changes no rule", () => {
  const sc = partOr("The self-contained agent browser (board ab-v16.94).");
  for (const s of [
    "The self-contained design is `docs/superpowers/specs/2026-11-09-self-contained-agent-browser-design.md`, and its section 19 records the operator's answers of 2026-11-10.",
    "Stage 0 changes no rule of this file.",
    "| The endpoint of this file at the endpoint path that the daemon gives, with every rule of this file, on a box whose switch is on | agent-browser's service (`agent-browser service`), in place of the relay | stage 3 (stage 1 builds it, off by default) |",
    "| The MCP path over loopback TCP and its admission (the MCP path, below) | agent-browser's service | stage 1d builds it, off by default; it serves sessions from stage 3 |",
    "| The MCP's allow list (`docs/contracts/mcp-allow-list.md`) | agent-browser's service | stage 1d |",
    "| The per-session MCP configuration (how a session gets the MCP, below) | agentwatch | stage 2 builds it, off by default |",
    "| The remote MCP path for a session of another box | agentwatch and agent-browser's service | stage 5 (the self-contained design, section 9; this file has no rule for it yet) |",
    "Until stage 3, and on a box whose switch is off, the relay (`agent-browser relay`, the daemon's child) serves the endpoint, and the daemon is its other party, as the rest of this file says.",
    "From stage 3, on a box whose switch is on, the service serves the endpoint at the same path, with the same rules, in place of the relay.",
    "The daemon's lines to the relay (C10, the daemon and the relay) then become the service's own state: C12's `set_sessions` gives the sessions, their repos and their roots, from which the service builds the lists and the scopes, and C12's `session_ended` gives the end of a scope.",
    "The readiness, the answers, the closes and the refusals stay as this file says.",
    "From stage 3, on a box whose switch is on, `browser.control: false` (C12, `config`) makes the service answer each request on the endpoint and on the MCP path with 503 `The agent browser is off: the operator turned agent control off.`",
    "This answer is the first check of the readiness: step 4 before the upgrade, and step 7 of the MCP path's admission (below). Today the endpoint does not exist then (the self-contained design, section 14).",
  ]) assert.ok(says(sc, s), `C11 says: ${s}`);
});

test("C11 states the MCP path over loopback TCP (the operator's answer Q1, ab-bi3), its URL, its label scope and its held port", () => {
  const mcp = partOr("The MCP path (from stage 1d; the operator's answer Q1 of board item ab-bi3, 2026-11-10).");
  for (const s of [
    "The service serves the standard Playwright MCP (the answer Q4) over Streamable HTTP on a loopback TCP port. Nothing serves it before stage 1d, and no session gets it before stage 3.",
    "Board item ab-6ng asks the operator to check this reading of the answer \"HTTP\". If the operator picks HTTP on the private socket with a helper instead, this part changes before stage 1d builds it.",
    "The URL is `http://127.0.0.1:<port>/mcp/<scope>`. The service listens on `127.0.0.1` only, on one port for each OS user and box.",
    "No secret is in the URL or in a session's MCP configuration: no key and no token.",
    "The scope in the path is a label, and it gives no right: the walk decides the scope (the admission, below).",
    "A request whose path names another scope than the walk's gets the session's 403. A request to `/mcp` alone names no scope, and the walk's scope applies.",
    "A local session reaches the MCP only through this URL. No stdio shim runs for it.",
    "On the endpoint's Unix socket the MCP path serves no local session: a request for `/mcp` there gets the 404 of step 2, as today.",
    "The port stays held while the service is down: on Linux a systemd user socket unit holds it, and on the Mac the launchd equivalent, so another OS user cannot listen on it.",
    "On the Mac the port refuses every connection (fail closed) until the Mac's TCP peer reader (`libproc`) is built and measured (stage 4).",
  ]) assert.ok(says(mcp, s), `C11 says: ${s}`);
});

test("C11 states the admission of the MCP path: the uid first, then the walk, before any request byte; Origin, Host, path, label, readiness; the limits", () => {
  const adm = partOr("The admission of the MCP path (from stage 1d; the daemon lead's conditions for the TCP choice).");
  for (const s of [
    "At each new TCP connection the service runs these checks in this order. The first check that fails gives its answer at once, and the service then closes the connection. Steps 1 and 2 run before the service reads any byte of the request.",
    "1. The uid. The service finds the client's socket in `/proc/net/tcp` by the client's port, and reads its uid column. A uid other than the service's gets the peer's 403 (`The agent browser cannot tell which program connects, so it refuses the connection.`), before any other check.",
    "2. The walk. The service finds each process that holds the socket's inode (`/proc/<pid>/fd`), and walks each holder by the rules of the scope's session (above).",
    "Each holder must reach a root that counts, and all holders the roots of one scope: that scope is the connection's scope.",
    "No holder, a holder that reaches no root, or holders of two scopes get the session's 403, with the lowest pid that the walk refused. So the walk refuses a browser process: Chrome is no session's process.",
    "The service then reads the client's line of `/proc/net/tcp` again, and a line that changed gets the session's 403 too.",
    "3. A request with an `Origin` header: its 403 (`A web page cannot connect to the agent browser.`).",
    "4. A `Host` header that is not exactly `127.0.0.1:<port>` or `localhost:<port>`, or no `Host` header: 403 `The agent browser admits only the Host 127.0.0.1:<port> or localhost:<port>.` This check stops DNS rebinding.",
    "5. A path that is not `/mcp` or `/mcp/<scope>` with a scope that matches the scope pattern: 404 `Not found. Connect an MCP client to /mcp/<scope>.`",
    "6. A path whose scope is not the connection's scope: the session's 403.",
    "7. The readiness and the scope's list: the 503s of steps 4, 5 and 7 before the upgrade, with their texts.",
    "Steps 1 and 2 run once for each connection, and a connection keeps its scope until it closes. Steps 3 to 7 run for each request on the connection.",
    "A request with the MCP session id of another scope gets the 404 of an unknown MCP session.",
    "An `Origin` header, a wrong `Host` and the walk's refusal of a browser process are three separate checks, and the service keeps all three.",
  ]) assert.ok(says(adm, s), `C11 says: ${s}`);
  const lim = partOr("The limits of the MCP path's admission (the self-contained design, sections 8.3 and 18, M2).");
  for (const s of [
    "The check finds the holders of the socket, not the process that connected. A process that forks after its connect has a child that holds the socket too, and that child must be in the same session.",
    "A client that writes its request and exits at once is refused: no process holds the socket at the check (M2: 50 of 50).",
    "The check costs 10.4 ms p50 to 23.1 ms p50 on taylor (M2), once for each connection.",
    "A client of another OS user is refused by the uid column; M2 reasoned this case and did not run it.",
    "As on the endpoint, the check does not stop a hostile process of the same OS user.",
  ]) assert.ok(says(lim, s), `C11 says: ${s}`);
  // The texts of the MCP path that are new: each has its status, once.
  for (const t of ["403 `The agent browser admits only the Host 127.0.0.1:<port> or localhost:<port>.`", "404 `Not found. Connect an MCP client to /mcp/<scope>.`", "503 `The agent browser is off: the operator turned agent control off.`"]) {
    assert.equal(flat(C11).split(flat(t)).length, 2, `C11 has ${t} once`);
  }
  // The reused texts are the endpoint's own answers (the vectors).
  const bodies = new Set(endpoint.upgradeAnswers.map((a: any) => a.body));
  for (const b of ["The agent browser cannot tell which program connects, so it refuses the connection.", "A web page cannot connect to the agent browser."]) assert.ok(bodies.has(b), `an answer of the endpoint: ${b}`);
});

test("C11 states the MCP inside the service and how a session gets the MCP (the answers Q2 and Q4; the daemon lead's condition 4)", () => {
  const inside = partOr("The MCP inside the service (from stage 1d; the self-contained design, section 8.2).");
  for (const s of [
    "The service makes one Playwright MCP server object for each MCP session, from the pinned `@playwright/mcp` package's public entry. At most 4 MCP sessions for each scope and 32 for each service (first values).",
    "Its configuration is fixed: the scope's CDP endpoint and the default context; the capabilities named explicitly, never `core-install`, `storage`, `devtools`, `testing` or `config`; `allowUnrestrictedFileAccess: false`; and an output folder for each scope in the state folder.",
    "Tools and argument keys pass only through the allow list (`docs/contracts/mcp-allow-list.md`).",
    "The service refuses each argument that the allow list marks as a path when the path is outside the scope's folder, `<state>/mcp/<scope>/`, after `realpath`.",
    "The MCP's Playwright connects back to the endpoint's CDP path with the MCP session's scope and a one-time ticket, which only a connection from the service's own pid can use. Every rule of this file applies to that connection.",
    "The MCP code of each scope runs in one worker thread of the service, with a heap limit (first value 512 MiB). A worker that passes it ends with its MCP sessions, and their clients get an error.",
  ]) assert.ok(says(inside, s), `C11 says: ${s}`);
  const how = partOr("How a session gets the MCP (from stage 2; the operator's answer Q2 of ab-bi3, and the daemon lead's condition 4).");
  for (const s of [
    "agentwatch writes the MCP's HTTP entry into a session's own MCP configuration at the session's launch, only when the session's scope has a list with at least one site.",
    "agentwatch never writes the entry into the user's global files. For Claude Code it writes a file for the session, which the launch passes with `--mcp-config`. For Codex it uses a `-c` override for the session or the account's own `CODEX_HOME`.",
    "Nothing goes into the session's environment: the operator's answer age-4ks (\"env: no\") stays.",
    "agentwatch does not change a running session's MCP configuration. A list that gets its first site after a session's launch takes effect at that session's next launch, so the session needs a restart (or the agent adds the entry by hand, as the skill says).",
  ]) assert.ok(says(how, s), `C11 says: ${s}`);
});

test("C11 keeps no sentence of the stdio shim as the local MCP path, and no rule of the self-contained browser before its stage", () => {
  for (const s of ["agent-browser mcp", "a stdio shim, `agent-browser mcp`", "The MCP's local path is the stdio shim", "{\"command\":\"agent-browser\",\"args\":[\"mcp\"]}"]) assert.ok(!says(C11, s), `C11: no ${s}`);
  // Each new part names its stage in its heading, so no reader takes it for a rule of today.
  for (const h of ["The MCP path (from stage 1d;", "The admission of the MCP path (from stage 1d;", "The MCP inside the service (from stage 1d;", "How a session gets the MCP (from stage 2;"]) {
    assert.ok(C11.includes(`**${h}`), `the part ${h}`);
  }
  // The new parts come after the old text: the old text's last part is still the scope's session, before them.
  assert.ok(C11.indexOf("**The scope's session (the peer check; board ab-v16.50).**") < C11.indexOf("**The MCP path (from stage 1d;"), "the order of the parts");
});
