// Stage 1c of the self-contained agent browser (board ab-v16.94.4): the scope book. It turns the sessions of the last
// set_sessions, the per-repo lists and the ended names into the receiver's set_scopes object (C4) and the model's
// allowlist line (C10, C11), and keeps the file of ended scopes and the restart gate (C4's rules 1 and 2 of "the tabs of
// a session that ended"). The cases are agentwatch's reference cases (tests/daemon/browser/test_scopes.py), ported;
// the cases of the test browser's default list (choice 5 b) are left out: the service sends `default` null. Each test
// uses a temp folder only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAMAGED_TEXT, type ListInfo } from "../src/service/lists/lists.ts";
import { NO_REPO, SCOPE, UNREAD_LIST } from "../src/service/lists/hosts.ts";
import { ENDED_KEY, EndedFile, OPERATOR, READ_ERROR, ScopeBook, SHARED_ERROR, WRITE_ERROR, type SessionRow, type Ticket } from "../src/service/lists/scopes.ts";
import { writeJson } from "../src/service/lists/files.ts";

const WRITE_FAILED = WRITE_ERROR.replace("{kind}", "ENOSPC");
const DAMAGED_FILE = READ_ERROR.replace("{kind}", "damaged");
const row = (scope: string, repo: string | null = null, ...roots: [number, number][]): SessionRow => ({ scope, repo, repoKnown: true, roots: roots.map(([pid, start]) => ({ pid, start })) });

/** A fake list reader: the lists that a test sets, an empty list for the rest; it records each read. */
class Lists {
  readonly infos = new Map<string, ListInfo>();
  readonly reads: string[] = [];
  set(name: string, hosts: string[], error = "", repo: string | null = null) { this.infos.set(name, { name, repo, hosts, error }); }
  read = (name: string): ListInfo => { this.reads.push(name); return this.infos.get(name) ?? { name, repo: null, hosts: [], error: "" }; };
}
/** Writes of the ended file that fail with ENOSPC while `failing` is true. */
class Writes {
  failing = false;
  write = (path: string, value: unknown) => {
    if (this.failing) throw Object.assign(new Error("no space left on the device"), { code: "ENOSPC" });
    writeJson(path, value);
  };
}
type Rig = { dir: string; path: string; lists: Lists; writes: Writes; book: ScopeBook; file: () => any; make: () => ScopeBook; done: () => void };
function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "ab-scopes-"));
  const path = join(dir, "state", "ended-scopes.json");
  const lists = new Lists();
  const writes = new Writes();
  const make = () => new ScopeBook(new EndedFile(path, { write: writes.write }), lists.read);
  return { dir, path, lists, writes, book: make(), file: () => JSON.parse(readFileSync(path, "utf8")), make, done: () => rmSync(dir, { recursive: true, force: true }) };
}
function withRig(f: (r: Rig) => void): () => void { return () => { const r = rig(); try { f(r); } finally { r.done(); } }; }
const openGate = (book: ScopeBook, rows: SessionRow[]) => { book.setSessions(rows); book.confirmed(book.ticket()!); };
const scopesOf = (book: ScopeBook) => book.ticket()!.body.scopes;
const writeRaw = (path: string, body: string | Buffer) => { mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 }); writeFileSync(path, body); };

// ------------------------------------------------------------------ the constants and the ended file

test("the constants name the contract's values", () => {
  assert.equal(OPERATOR, "*");
  assert.equal(ENDED_KEY, "ended");
  assert.match(DAMAGED_FILE, /^the file of ended scopes cannot be read/);
  assert.match(DAMAGED_FILE, /the tabs of every live session close once/);
});

test("a missing ended file holds no name; a write keeps each name once, sorted, in one private file", withRig((r) => {
  const f = new EndedFile(r.path);
  assert.deepEqual(f.read(), { names: new Set(), error: "" });
  assert.equal(f.write(["b", "a", "b"]), "");
  assert.deepEqual(r.file(), { ended: ["a", "b"] });
  assert.equal(statSync(r.path).mode & 0o777, 0o600);
  assert.equal(statSync(join(r.dir, "state")).mode & 0o777, 0o700);
  assert.deepEqual(f.read(), { names: new Set(["a", "b"]), error: "" });
  assert.deepEqual(readdirSync(join(r.dir, "state")), ["ended-scopes.json"], "no temp file stays");
}));

test("an ended file that cannot be read gives its error (also one nested too deep): the book starts with it", withRig((r) => {
  for (const body of ["{", "[]", "{}", '{"ended": "x"}', '{"ended": [1]}', '{"ended": ["../x"]}', Buffer.from([0xff]), '{"ended": ' + "[".repeat(200_000) + "]".repeat(200_000) + "}"]) {
    writeRaw(r.path, body);
    assert.deepEqual(new EndedFile(r.path).read(), { names: new Set(), error: DAMAGED_FILE }, String(body).slice(0, 20));
  }
  const book = r.make();
  assert.equal(book.poisoned, true);
  assert.deepEqual(book.errors(), [DAMAGED_FILE]);
}));

test("an ended file write that fails gives its error and leaves no file", withRig((r) => {
  r.writes.failing = true;
  assert.equal(new EndedFile(r.path, { write: r.writes.write }).write(["x"]), WRITE_FAILED);
  assert.equal(existsSync(r.path), false);
}));

// ------------------------------------------------------------------ rule 1: the object

test("rule 1: no object before the first complete read of the sessions; zero sessions give empty objects", withRig((r) => {
  assert.equal(r.book.ticket(), null);
  assert.equal(r.book.readDone(), false);
  r.book.setSessions([]);
  assert.equal(r.book.readDone(), true);
  assert.deepEqual(r.book.ticket()!.body, { lists: {}, scopes: {}, default: null, operator: "*" });
}));

test("each live session is named with its repo's list, also an empty one; a repo is lowercased for its list", withRig((r) => {
  r.lists.set("a.b", ["x.com"]);
  r.book.setSessions([row("w1", "a/b"), row("w2", "a/b"), row("m", null)]);
  const body = r.book.ticket()!.body;
  assert.deepEqual(body.scopes, { w1: "a.b", w2: "a.b", m: "no-repo" });
  assert.deepEqual(body.lists, { "a.b": ["x.com"], "no-repo": [] });
  assert.equal(body.default, null);
  assert.equal(body.operator, "*");
  const b2 = r.make();
  b2.setSessions([row("w", "A/B")]);
  assert.deepEqual(scopesOf(b2), { w: "a.b" });
  assert.equal(b2.listOf("w"), "a.b");
}));

test("a name that is no scope is left out of the object and the line", withRig((r) => {
  r.book.setSessions([row("bad name", "a/b"), row("x".repeat(65), "a/b"), row("ok", "a/b")]);
  assert.deepEqual(scopesOf(r.book), { ok: "a.b" });
  assert.deepEqual(r.book.line(r.book.ticket()!.body, true).scopes, { ok: "a.b" });
}));

test("two live sessions with one scope get no list, and the errors say so; shared counts scope names only", withRig((r) => {
  r.book.setSessions([row("w", "a/b", [101, 1]), row("w", "c/d", [102, 2]), row("v", "a/b")]);
  const body = r.book.ticket()!.body;
  assert.deepEqual(body.scopes, { v: "a.b" });
  assert.deepEqual(body.lists, { "a.b": [] });
  assert.ok(r.book.errors().includes(SHARED_ERROR.replace("{scope}", "w")));
  assert.equal(SHARED_ERROR.replace("{scope}", "w"), "two live sessions have the launch name w: neither gets a list");
  assert.ok(!("w" in (r.book.line(body, true).roots ?? {})));
  assert.deepEqual(r.book.shared(), new Set(["w"]));
  r.book.setSessions([row("bad name"), row("bad name"), row("w")]);
  assert.deepEqual(r.book.shared(), new Set());
  assert.deepEqual(scopesOf(r.book), { w: "no-repo" });
}));

test("the body always holds objects for lists and scopes, with exactly C4's four keys", withRig((r) => {
  r.book.setSessions([]);
  r.book.sessionEnded("x");
  const body = r.book.ticket()!.body;
  assert.deepEqual(body.lists, {});
  assert.deepEqual(body.scopes, {});
  assert.deepEqual(Object.keys(body).sort(), ["default", "lists", "operator", "scopes"]);
}));

test("a damaged list applies as empty for its repo only, with its error; lists holds only the lists that scopes name", withRig((r) => {
  r.lists.set("a.b", [], DAMAGED_TEXT);
  r.lists.set("c.d", ["c.example"]);
  r.lists.set("e.f", ["y.com"]);
  r.book.setSessions([row("w", "a/b"), row("v", "c/d")]);
  const body = r.book.ticket()!.body;
  assert.deepEqual(body.lists, { "a.b": [], "c.d": ["c.example"] });
  assert.deepEqual(body.scopes, { w: "a.b", v: "c.d" });
  assert.ok(r.book.errors().includes(`list a.b: ${DAMAGED_TEXT}`));
}));

test("each ticket is a new object", withRig((r) => {
  r.book.setSessions([row("w", "a/b")]);
  const t = r.book.ticket()!;
  t.body.scopes.z = "a.b";
  t.body.lists["a.b"].push("evil.example");
  assert.deepEqual(r.book.ticket()!.body, { lists: { "a.b": [] }, scopes: { w: "a.b" }, default: null, operator: "*" });
}));

test("rows and listOf follow the live sessions", withRig((r) => {
  const w = row("w", "a/b", [101, 1]);
  r.book.setSessions([w, row("m")]);
  assert.deepEqual([...r.book.rows().keys()], ["w", "m"]);
  assert.deepEqual(r.book.rows().get("w"), w);
  assert.equal(r.book.listOf("w"), "a.b");
  assert.equal(r.book.listOf("m"), "no-repo");
  assert.equal(r.book.listOf("gone"), null);
}));

test("a session whose repo is not read yet gets the always empty unread-repo list; no file of that name is read", withRig((r) => {
  r.lists.set(NO_REPO, ["x.com"]);
  r.lists.set(UNREAD_LIST, ["evil.com"]);
  r.book.setSessions([{ scope: "s", repo: null, repoKnown: false, roots: [] }, row("m")]);
  const body = r.book.ticket()!.body;
  assert.deepEqual(body.scopes, { m: NO_REPO, s: UNREAD_LIST });
  assert.deepEqual(body.lists, { [NO_REPO]: ["x.com"], [UNREAD_LIST]: [] });
  assert.equal(r.book.listOf("s"), UNREAD_LIST);
  r.book.errors();
  assert.ok(!r.lists.reads.includes(UNREAD_LIST));
  assert.ok(SCOPE.test(UNREAD_LIST));
}));

test("a scope named constructor is a scope like any other (an own key of the object)", withRig((r) => {
  r.book.setSessions([row("constructor", "a/b"), row("toString")]);
  assert.deepEqual(scopesOf(r.book), { constructor: "a.b", toString: "no-repo" });
}));

// ------------------------------------------------------------------ rule 2: the file of ended scopes and the restart gate

test("rule 2: the file is written before sessionEnded returns", withRig((r) => {
  openGate(r.book, [row("x", "a/b")]);
  assert.equal(r.book.sessionEnded("x"), "");
  assert.deepEqual(r.file(), { ended: ["x"] });
  assert.deepEqual(r.book.heldInMemory(), new Set());
}));

test("an ended session leaves the next object and an ok in time prunes it", withRig((r) => {
  openGate(r.book, [row("x", "a/b"), row("y", "a/b")]);
  r.book.sessionEnded("x");
  r.book.setSessions([row("y", "a/b")]);
  const t = r.book.ticket()!;
  assert.deepEqual(t.body.scopes, { y: "a.b" });
  assert.equal(r.book.confirmed(t), false, "no live session waits for the name");
  assert.deepEqual(r.file(), { ended: [] });
}));

test("the end and the launch of one name split into two set_scopes: the ok of an object sent before the end prunes nothing", withRig((r) => {
  openGate(r.book, [row("x", "a/b", [101, 1])]);
  const t1 = r.book.ticket()!;
  assert.deepEqual(t1.body.scopes, { x: "a.b" });
  r.book.sessionEnded("x");
  r.book.setSessions([row("x", "a/b", [202, 2])]);
  assert.ok(!("x" in scopesOf(r.book)));
  assert.equal(r.book.confirmed(t1), false);
  assert.ok(!("x" in scopesOf(r.book)));
  assert.deepEqual(r.file(), { ended: ["x"] });
  const t2 = r.book.ticket()!;
  assert.ok(t2.seq > t1.seq);
  assert.equal(r.book.confirmed(t2), true, "a freed name: push at once");
  assert.deepEqual(scopesOf(r.book), { x: "a.b" });
  assert.deepEqual(r.file(), { ended: [] });
}));

test("an end drops the ended session's row, so its prune frees nothing; the next set_sessions puts back the live rows", withRig((r) => {
  openGate(r.book, [row("x", "a/b", [101, 1]), row("y", "a/b", [102, 2])]);
  r.book.sessionEnded("x");
  assert.equal(r.book.rows().has("x"), false);
  let t = r.book.ticket()!;
  assert.ok(!("x" in t.body.scopes));
  assert.equal(r.book.confirmed(t), false);
  t = r.book.ticket()!;
  assert.deepEqual(t.body.scopes, { y: "a.b" });
  assert.deepEqual(r.book.line(t.body, true).roots, { y: [{ pid: 102, start: 2 }] });
  assert.deepEqual(r.file(), { ended: [] });
}));

test("an end before the first complete read is held out until an ok in time", withRig((r) => {
  assert.equal(r.book.sessionEnded("x"), "");
  assert.deepEqual(r.file(), { ended: ["x"] });
  assert.equal(r.book.ticket(), null);
  r.book.setSessions([row("x", "a/b"), row("y", "a/b")]);
  const t = r.book.ticket()!;
  assert.deepEqual(t.body.scopes, { y: "a.b" });
  assert.equal(r.book.confirmed(t), true);
  assert.deepEqual(scopesOf(r.book), { x: "a.b", y: "a.b" });
}));

test("the restart gate: the names of the file and the launches stay out until the first ok in time, also when its prune's write fails", withRig((r) => {
  new EndedFile(r.path).write(["x"]);
  let book = r.make();
  assert.equal(book.poisoned, false);
  book.setSessions([row("x", "a/b"), row("y", "a/b")]);
  book.setSessions([row("x", "a/b"), row("y", "a/b"), row("z", "a/b")]); // z is a launch
  let t = book.ticket()!;
  assert.deepEqual(t.body.scopes, { y: "a.b" });
  assert.equal(book.confirmed(t), true, "freed: x and z");
  assert.deepEqual(scopesOf(book), { x: "a.b", y: "a.b", z: "a.b" });
  assert.deepEqual(r.file(), { ended: [] });
  // The same with a prune whose write fails: the gate opens (z is freed), and x stays out.
  new EndedFile(r.path).write(["x"]);
  book = r.make();
  book.setSessions([row("x", "a/b"), row("y", "a/b")]);
  book.setSessions([row("x", "a/b"), row("y", "a/b"), row("z", "a/b")]);
  t = book.ticket()!;
  r.writes.failing = true;
  assert.equal(book.confirmed(t), true);
  assert.deepEqual(scopesOf(book), { y: "a.b", z: "a.b" });
  assert.deepEqual(r.file(), { ended: ["x"] });
}));

test("a failed first ok keeps the gate shut; a scope of the first read is no launch; a launch after the gate opened is named at once", withRig((r) => {
  r.book.setSessions([row("y", "a/b")]);
  r.book.setSessions([row("y", "a/b"), row("z", "a/b")]);
  r.book.ticket(); // sent, with no ok in time
  r.book.setSessions([row("y", "a/b"), row("z", "a/b")]);
  assert.deepEqual(scopesOf(r.book), { y: "a.b" });
  const b2 = r.make();
  b2.setSessions([row("a", "a/b"), row("b", "a/b")]);
  b2.setSessions([row("a", "a/b"), row("b", "a/b")]);
  assert.deepEqual(scopesOf(b2), { a: "a.b", b: "a.b" });
  const b3 = r.make();
  openGate(b3, [row("a", "a/b")]);
  b3.setSessions([row("a", "a/b"), row("n", "a/b")]);
  assert.deepEqual(scopesOf(b3), { a: "a.b", n: "a.b" });
}));

test("a failed write keeps the name in memory and says so; a prune whose write fails keeps it; the next write that works prunes it", withRig((r) => {
  openGate(r.book, [row("x", "a/b")]);
  r.writes.failing = true;
  assert.equal(r.book.sessionEnded("x"), WRITE_FAILED);
  assert.deepEqual(r.book.heldInMemory(), new Set(["x"]));
  assert.equal(r.book.holdError(), WRITE_FAILED);
  assert.ok(r.book.errors().includes(WRITE_FAILED));
  r.book.setSessions([row("x", "a/b")]); // a new x launches: it stays out
  let t = r.book.ticket()!;
  assert.ok(!("x" in t.body.scopes));
  assert.equal(r.book.confirmed(t), false);
  assert.deepEqual(r.book.heldInMemory(), new Set(["x"]));
  assert.ok(!("x" in scopesOf(r.book)));
  r.writes.failing = false;
  assert.equal(r.book.confirmed(r.book.ticket()!), true);
  assert.deepEqual(r.book.heldInMemory(), new Set());
  assert.deepEqual(r.book.errors(), []);
  assert.deepEqual(scopesOf(r.book), { x: "a.b" });
  assert.deepEqual(r.file(), { ended: [] });
}));

test("a failed prune of a written name keeps it in the file (so not in memory only)", withRig((r) => {
  openGate(r.book, [row("x", "a/b")]);
  r.book.sessionEnded("x");
  r.book.setSessions([row("x", "a/b")]);
  r.writes.failing = true;
  assert.equal(r.book.confirmed(r.book.ticket()!), false);
  assert.deepEqual(r.book.heldInMemory(), new Set());
  assert.deepEqual(r.file(), { ended: ["x"] });
  assert.ok(!("x" in scopesOf(r.book)));
  assert.ok(r.book.errors().includes(WRITE_FAILED));
}));

test("a later end writes the held name too", withRig((r) => {
  r.book.setSessions([]);
  r.writes.failing = true;
  assert.equal(r.book.sessionEnded("x"), WRITE_FAILED);
  r.writes.failing = false;
  assert.equal(r.book.sessionEnded("y"), "");
  assert.deepEqual(r.file(), { ended: ["x", "y"] });
  assert.deepEqual(r.book.heldInMemory(), new Set());
}));

test("a name that ends again waits for an object sent after its last end", withRig((r) => {
  openGate(r.book, [row("x", "a/b")]);
  r.book.sessionEnded("x");
  const t1 = r.book.ticket()!;
  r.book.sessionEnded("x");
  assert.equal(r.book.confirmed(t1), false);
  r.book.setSessions([row("x", "a/b")]);
  assert.ok(!("x" in scopesOf(r.book)));
  assert.equal(r.book.confirmed(r.book.ticket()!), true);
}));

test("the end of a name that is no scope writes nothing", withRig((r) => {
  r.book.setSessions([]);
  assert.equal(r.book.sessionEnded("bad name"), "");
  assert.equal(r.book.sessionEnded(""), "");
  assert.equal(existsSync(r.path), false);
}));

test("an unreadable ended file holds every live name, is written again at the first read, and the first ok in time frees them", withRig((r) => {
  writeRaw(r.path, "{");
  const book = r.make();
  assert.equal(book.poisoned, true);
  assert.equal(book.ticket(), null);
  assert.deepEqual(book.errors(), [DAMAGED_FILE]);
  book.setSessions([row("a", "a/b"), row("b", null), row("bad name")]);
  assert.deepEqual(r.file(), { ended: ["a", "b"] });
  const t = book.ticket()!;
  assert.deepEqual(t.body.scopes, {});
  assert.equal(book.confirmed(t), true);
  assert.deepEqual(scopesOf(book), { a: "a.b", b: "no-repo" });
  assert.deepEqual(r.file(), { ended: [] });
}));

test("the read error clears after a good rewrite; poisoned stays (a fact of this start)", withRig((r) => {
  writeRaw(r.path, "{");
  const book = r.make();
  assert.ok(book.errors().includes(DAMAGED_FILE));
  book.setSessions([row("a", "a/b")]);
  assert.deepEqual(r.file(), { ended: ["a"] });
  assert.deepEqual(book.errors(), []);
  assert.equal(book.poisoned, true);
}));

test("an end before the first read keeps a damaged file (a stop then loses no hold of a live name)", withRig((r) => {
  writeRaw(r.path, "{");
  const book = r.make();
  assert.equal(book.sessionEnded("x"), "");
  assert.equal(readFileSync(r.path, "utf8"), "{");
  assert.deepEqual(book.heldInMemory(), new Set(["x"]));
  book.setSessions([row("a", "a/b")]);
  assert.deepEqual(r.file(), { ended: ["a", "x"] });
  assert.deepEqual(book.heldInMemory(), new Set());
  const t = book.ticket()!;
  assert.deepEqual(t.body.scopes, {});
  assert.equal(book.confirmed(t), true);
  assert.deepEqual(scopesOf(book), { a: "a.b" });
}));

test("a failed rewrite is tried again at the next set_sessions and at the next confirmed", withRig((r) => {
  writeRaw(r.path, "{");
  let book = r.make();
  r.writes.failing = true;
  book.setSessions([]);
  assert.equal(readFileSync(r.path, "utf8"), "{");
  assert.ok(book.errors().includes(WRITE_FAILED));
  r.writes.failing = false;
  book.setSessions([]);
  assert.deepEqual(r.file(), { ended: [] });
  assert.deepEqual(book.errors(), []);
  writeRaw(r.path, "{");
  book = r.make();
  r.writes.failing = true;
  book.setSessions([]);
  r.writes.failing = false;
  assert.equal(book.confirmed(book.ticket()!), false);
  assert.deepEqual(r.file(), { ended: [] });
  assert.deepEqual(book.errors(), []);
}));

test("a failed prune write is tried again at the next set_sessions; the prune waits for the next ok in time", withRig((r) => {
  openGate(r.book, [row("y", "a/b")]);
  r.book.sessionEnded("x");
  r.writes.failing = true;
  r.book.confirmed(r.book.ticket()!);
  assert.ok(r.book.errors().includes(WRITE_FAILED));
  r.writes.failing = false;
  r.book.setSessions([row("y", "a/b")]);
  assert.deepEqual(r.book.errors(), []);
  assert.deepEqual(r.file(), { ended: ["x"] });
  r.book.confirmed(r.book.ticket()!);
  assert.deepEqual(r.file(), { ended: [] });
}));

test("a prune whose write failed waits for the next ok (pruneWaits), also after a rewrite of the unpruned names", withRig((r) => {
  openGate(r.book, [row("y", "a/b")]);
  assert.equal(r.book.pruneWaits(), false);
  r.book.sessionEnded("x");
  r.book.setSessions([row("x", "a/b"), row("y", "a/b")]);
  const t = r.book.ticket()!;
  assert.deepEqual(t.body.scopes, { y: "a.b" });
  r.writes.failing = true;
  assert.equal(r.book.confirmed(t), false);
  assert.equal(r.book.pruneWaits(), true);
  r.writes.failing = false;
  r.book.setSessions([row("x", "a/b"), row("y", "a/b")]);
  assert.deepEqual(r.file(), { ended: ["x"] });
  assert.deepEqual(r.book.errors(), []);
  assert.equal(r.book.pruneWaits(), true);
  assert.deepEqual(r.book.ticket()!.body, t.body);
  assert.equal(r.book.confirmed(r.book.ticket()!), true);
  assert.equal(r.book.pruneWaits(), false);
  assert.deepEqual(scopesOf(r.book), { x: "a.b", y: "a.b" });
  assert.deepEqual(r.file(), { ended: [] });
}));

test("a failed rewrite with no name to prune is no prune that waits; a poisoned rewrite that fails holds the names in memory", withRig((r) => {
  writeRaw(r.path, "{");
  let book = r.make();
  r.writes.failing = true;
  book.setSessions([]);
  assert.equal(book.confirmed(book.ticket()!), false);
  assert.equal(book.pruneWaits(), false);
  writeRaw(r.path, "[]");
  book = r.make();
  book.setSessions([row("a", "a/b")]);
  assert.deepEqual(book.heldInMemory(), new Set(["a"]));
  assert.deepEqual(scopesOf(book), {});
  assert.ok(book.errors().includes(WRITE_FAILED));
}));

// ------------------------------------------------------------------ the line (C10, C11)

test("the line is the body with its tag; without roots it has no roots key", withRig((r) => {
  r.lists.set("a.b", ["x.com"]);
  openGate(r.book, [row("w", "a/b", [101, 5000])]);
  const body = r.book.ticket()!.body;
  const line = r.book.line(body, false);
  assert.deepEqual(line, { t: "allowlist", ...body });
  assert.ok(!("roots" in line));
  assert.equal(line.operator, "*");
  assert.equal(line.default, null);
}));

test("a line never names an ended scope with a list, also for a body from before the end; the body stays as it is", withRig((r) => {
  openGate(r.book, [row("x", "a/b", [101, 1]), row("y", "a/b", [102, 2])]);
  const body = r.book.ticket()!.body;
  assert.deepEqual(r.book.named(body), new Set(["x", "y"]));
  r.book.sessionEnded("x");
  const line = r.book.line(body, true);
  assert.deepEqual(line.scopes, { y: "a.b" });
  assert.ok(!("x" in line.roots!));
  assert.deepEqual(r.book.named(line), new Set(["y"]));
  assert.deepEqual(body.scopes, { x: "a.b", y: "a.b" });
}));

test("the line carries the roots of every live session but the ended ones; a launch that the gate holds has its roots and no list", withRig((r) => {
  new EndedFile(r.path).write(["x"]);
  const book = r.make();
  book.setSessions([row("w", "a/b", [101, 5000], [102, 5001]), row("x", "a/b", [104, 5003])]);
  book.setSessions([row("w", "a/b", [101, 5000], [102, 5001]), row("x", "a/b", [104, 5003]), row("z", "a/b", [103, 5002])]);
  const body = book.ticket()!.body;
  assert.deepEqual(body.scopes, { w: "a.b" });
  const line = book.line(body, true);
  assert.deepEqual(line.roots, { w: [{ pid: 101, start: 5000 }, { pid: 102, start: 5001 }], z: [{ pid: 103, start: 5002 }] });
  assert.ok(!("roots" in book.line(body, false)));
}));

test("a new session of an ended name has no roots until the prune", withRig((r) => {
  openGate(r.book, [row("w", "a/b", [101, 5000]), row("x", "a/b", [104, 5003])]);
  r.book.sessionEnded("x");
  r.book.setSessions([row("w", "a/b", [101, 5000]), row("x", "a/b", [105, 5004])]);
  let t = r.book.ticket()!;
  assert.deepEqual(r.book.line(t.body, true).roots, { w: [{ pid: 101, start: 5000 }] });
  r.book.confirmed(t);
  t = r.book.ticket()!;
  assert.deepEqual(r.book.line(t.body, true).roots, { w: [{ pid: 101, start: 5000 }], x: [{ pid: 105, start: 5004 }] });
}));

test("the line leaves out the roots of a name that is no scope, gives a root once, and drops roots out of C11's range", withRig((r) => {
  openGate(r.book, [row("bad name", "a/b", [301, 1]), row("x".repeat(65), "a/b", [302, 2]), row("w", "a/b", [101, 5000], [101, 5000], [102, 5001], [101, 5000])]);
  assert.deepEqual(r.book.line(r.book.ticket()!.body, true).roots, { w: [{ pid: 101, start: 5000 }, { pid: 102, start: 5001 }] });
  const b2 = r.make();
  openGate(b2, [row("w", "a/b", [1, 5], [2, 5], [2 ** 53 - 1, 2 ** 53 - 1], [2 ** 53, 0], [3, -1], [4, 2 ** 53]), row("v", "a/b", [0, 0])]);
  assert.deepEqual(b2.line(b2.ticket()!.body, true).roots, { w: [{ pid: 2, start: 5 }, { pid: 2 ** 53 - 1, start: 2 ** 53 - 1 }] });
}));

test("named reads only the scopes with a list", withRig((r) => {
  assert.deepEqual(r.book.named({ scopes: { a: "l", b: null } } as any), new Set(["a"]));
  assert.deepEqual(r.book.named({ scopes: null } as any), new Set());
  assert.deepEqual(r.book.named({} as any), new Set());
}));

test("a ticket's seq is the number of the last end that it knows", withRig((r) => {
  r.book.setSessions([]);
  const t0: Ticket = r.book.ticket()!;
  r.book.sessionEnded("a");
  r.book.sessionEnded("b");
  assert.equal(r.book.ticket()!.seq, t0.seq + 2);
}));
