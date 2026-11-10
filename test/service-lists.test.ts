// Stage 1c of the self-contained agent browser (board ab-v16.94.4): the service's host rules, list names, list files
// and list copies. The cases are agentwatch's reference cases (tests/daemon/browser/test_allowlist.py, test_lists.py,
// tests/test_browser_lists.py, and the list-copy cases of test_service.py), ported to the service. Each test uses a
// temp folder only: never the operator's lists or state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { covers, coveredBy, EntryError, listNameFor, NO_REPO, normalizeHost, normalizeRepo, REPO, SCOPE, UNREAD_LIST } from "../src/service/lists/hosts.ts";
import { DAMAGED_TEXT, ListDamagedError, ListFiles, OTHER_REPO_TEXT, SKIPPED_MANY_TEXT, SKIPPED_ONE_TEXT, skippedText } from "../src/service/lists/lists.ts";
import { ListCopies } from "../src/service/lists/copies.ts";

const mode = (p: string) => statSync(p).mode & 0o777;
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
function temp(): { dir: string; files: ListFiles; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ab-lists-"));
  return { dir, files: new ListFiles(join(dir, "browser", "lists")), done: () => rmSync(dir, { recursive: true, force: true }) };
}
function put(files: ListFiles, name: string, body: string | Buffer): string {
  const f = files.file(name);
  mkdirSync(files.folder, { recursive: true, mode: 0o700 });
  writeFileSync(f, body);
  return f;
}
const reason = (s: unknown) => { try { normalizeHost(s); return null; } catch (e) { assert.ok(e instanceof EntryError); return (e as EntryError).reason; } };

// ------------------------------------------------------------------ the host rules (test_allowlist.py)

test("the host rules accept and normalize an entry (C5)", () => {
  for (const [s, out] of [["Example.COM.", "example.com"], ["  a.example ", "a.example"], ["XN--Bcher-kva.example", "xn--bcher-kva.example"],
    ["a.example﻿", "a.example"], [" a.example　", "a.example"], ["a.0xg", "a.0xg"], ["a.1e3", "a.1e3"]]) assert.equal(normalizeHost(s), out, s);
  const name = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
  assert.equal(name.length, 253);
  assert.equal(normalizeHost(name), name, "253 characters");
});

const BAD = ["com", "https://a.example/x", "a.example:8080", "*.a.example", "1.2.3.4", "[::1]", "-a.example", "", "a.example..", "a b.example", "a@b.example", "a.example/x", "0x7f.1",
  "1.2.3", "a-.example", "a_b.example", ("a".repeat(62) + ".").repeat(4) + "com", "a".repeat(64) + ".example", "a".repeat(254), "a.example?x", "a.example#f", "a.example\\x",
  "a%2eexample.com", "a%41.example", "a.example\u0000", "a​.example", "a­.example", "a‌.example", "a‍.example", "a\u0001.example", "a\u007f.example",
  "a。example", "a．example", "a｡example", "straße.example", "ς.example", "a .example", "a͸.example", "a.example", "bücher.example", "ä.example"];

test("the host rules refuse each bad entry with a reason that never holds the entry", () => {
  for (const s of BAD) {
    const r = reason(s);
    assert.ok(typeof r === "string" && r.length > 0, JSON.stringify(s));
    if (s.length > 3) assert.ok(!r!.includes(s), `the reason echoes ${JSON.stringify(s)}`);
  }
});

const TABLE: [string, string][] = [["", "the entry is empty"], ["https://a.example/x", "paste the host only"], ["a.example/x", "paste the host only"], ["a.example:80", "a port is not allowed"],
  ["*.a.example", "a wildcard is not allowed"], ["a@b.example", "a user name is not allowed"], ["[::1]", "an IP address is not allowed"], ["1.2.3.4", "an IP address is not allowed"],
  ["a b.example", "whitespace is not allowed"], ["a.example..", "the host ends with extra dots"], [".a.example", "a label is empty"], ["a..example", "a label is empty"],
  ["com", "the host needs at least two labels"], ["a".repeat(64) + ".example", "a label must be 1 to 63 characters"], ["-a.example", "a label must not start or end with a hyphen"],
  ["a_b.example", "a character is not allowed"], ["a.example?x", "a character is not allowed"], ["a​.example", "a control or invisible character is not allowed"],
  ["a。example", "use a plain dot between labels"], ["straße.example", "use the punycode form"], ["\u001ca.example", "a character is not allowed"],
  ["\u0085a.example", "a control or invisible character is not allowed"], ["a.1", "the host is not valid"], ["a.123", "the host is not valid"], ["a.0x", "the host is not valid"],
  ["a.09", "the host is not valid"], ["a.256", "the host is not valid"], ["a.4294967296", "the host is not valid"], ["1.2.3.4.5", "the host is not valid"], ["1..2.3", "the host is not valid"],
  ["1.2.3", "an IP address is not allowed"], ["0x7f.1", "an IP address is not allowed"], ["ä".repeat(64) + ".example", "use the punycode form"],
  ["bücher.example", "use the punycode form"], ["例え.テスト", "use the punycode form"]];

test("the host rules' reason texts are agentwatch's and chrome-extension's (one text for each case)", () => {
  for (const [s, r] of TABLE) assert.equal(reason(s), r, JSON.stringify(s));
  assert.equal(reason(5), "the entry must be text");
  // Ruling 20: ASCII entries only; the punycode form is taken.
  assert.equal(reason("Bücher.example."), "use the punycode form");
  assert.equal(normalizeHost("xn--bcher-kva.example."), "xn--bcher-kva.example");
});

test("an entry covers itself and every subdomain", () => {
  assert.equal(covers("example.com", "a.b.example.com"), true);
  assert.equal(covers("example.com", "example.com"), true);
  assert.equal(covers("example.com", "badexample.com"), false);
  assert.equal(covers("a.example.com", "example.com"), false);
  assert.equal(coveredBy(["x.example", "example.com"], "w.example.com"), true);
  assert.equal(coveredBy([], "example.com"), false);
});

// ------------------------------------------------------------------ the list names (test_browser_lists.py)

test("the list names follow the repo, and two repos never share a list name", () => {
  assert.equal(listNameFor(null), "no-repo");
  assert.equal(NO_REPO, "no-repo");
  assert.equal(listNameFor("agentwatch-sh/agentwatch"), "agentwatch-sh.agentwatch");
  const long = "o/" + "r".repeat(70);
  assert.equal(listNameFor(long), "r-" + createHash("sha256").update(long).digest("hex").slice(0, 16));
  for (const r of [null, "a/b", long, "a/.b", "a/b_c"]) assert.ok(SCOPE.test(listNameFor(r)), String(r));
  assert.equal(new Set([null, "a/b.c", "a-b/c", "a/bc", "o/" + "r".repeat(70)].map(listNameFor)).size, 5);
  for (const bad of ["A/B", " a/b", "a/b ", "a", "a/b/c", "", "https://github.com/a/b", 5]) assert.throws(() => listNameFor(bad as string), String(bad));
  // The list of a session whose repo is not read yet: no repo's list has the name.
  assert.ok(SCOPE.test(UNREAD_LIST) && UNREAD_LIST !== NO_REPO && !UNREAD_LIST.includes(".") && !UNREAD_LIST.startsWith("r-"));
});

test("normalizeRepo lowercases and refuses other shapes; REPO takes GitHub's shapes", () => {
  assert.equal(normalizeRepo(" Agentwatch-SH/AgentWatch "), "agentwatch-sh/agentwatch");
  assert.equal(normalizeRepo("MarketData-App/website"), "marketdata-app/website");
  for (const bad of ["", "a", "a/b/c", "-a/b", "a/b c", "https://github.com/a/b", null, 5]) assert.equal(normalizeRepo(bad), null, String(bad));
  for (const r of ["a/b", "a-1/b.c_d-e", "x".repeat(39) + "/" + "y".repeat(100)]) assert.ok(REPO.test(r), r);
  for (const r of ["A/b", "a.b/c", "x".repeat(40) + "/y", "a/" + "y".repeat(101), "a/", "/b"]) assert.ok(!REPO.test(r), r);
});

// ------------------------------------------------------------------ the list files (test_lists.py)

test("the lists folder is the one that the service gets (CONFIG_DIR/browser/lists), and the old single list is allowlist.json next to it", () => {
  const files = new ListFiles("/cfg/browser/lists");
  assert.equal(files.file("a.b"), "/cfg/browser/lists/a.b.json");
  assert.equal(files.oldFile, "/cfg/browser/allowlist.json");
});

test("change writes today's format with the repo (mode 0600 in a folder of mode 0700), and read gives it back", () => {
  const t = temp();
  try {
    const r = t.files.change("a.b", ["Example.COM", "http://x.com/y"], [], "a/b");
    assert.deepEqual(r, { allow: ["example.com"], refused: [{ entry: "http://x.com/y", reason: "paste the host only" }] });
    const f = t.files.file("a.b");
    assert.deepEqual(json(f), { allow: ["example.com"], repo: "a/b" });
    assert.equal(readFileSync(f, "utf8"), '{\n  "allow": [\n    "example.com"\n  ],\n  "repo": "a/b"\n}\n', "agentwatch's own form of the file");
    assert.equal(mode(f), 0o600);
    assert.equal(mode(t.files.folder), 0o700);
    assert.deepEqual(readdirSync(t.files.folder), ["a.b.json"], "no temp file stays");
    assert.deepEqual(t.files.read("a.b"), { name: "a.b", repo: "a/b", hosts: ["example.com"], error: "" });
  } finally { t.done(); }
});

test("change of no-repo writes the repo null; a long repo's list is named by its hash", () => {
  const t = temp();
  try {
    assert.deepEqual(t.files.change("no-repo", ["a.localhost.example"], []), { allow: ["a.localhost.example"], refused: [] });
    assert.deepEqual(json(t.files.file("no-repo")), { allow: ["a.localhost.example"], repo: null });
    const repo = "o/" + "r".repeat(70);
    t.files.change(listNameFor(repo), ["x.example"], [], repo);
    const longs = t.files.loadAll().filter((i) => i.name.startsWith("r-"));
    assert.deepEqual(longs, [{ name: listNameFor(repo), repo, hosts: ["x.example"], error: "" }]);
  } finally { t.done(); }
});

test("change adds and removes (never replaces the list), sorts and keeps each host once; a removal that is invalid or not on the list is ignored", () => {
  const t = temp();
  try {
    t.files.change("a.b", ["b.example", "a.example", "B.example"], [], "a/b");
    const r = t.files.change("a.b", [], ["A.example", "none.example", "bad entry"], "a/b");
    assert.deepEqual(r.allow, ["b.example"]);
    assert.deepEqual(t.files.read("a.b").hosts, ["b.example"]);
    // An add keeps the entries of the file that the change does not name.
    assert.deepEqual(t.files.change("a.b", ["c.example"], [], "a/b").allow, ["b.example", "c.example"]);
  } finally { t.done(); }
});

test("change writes only the hosts that apply (agent-browser refuses a whole file for one bad entry)", () => {
  const t = temp();
  try {
    put(t.files, "a.b", JSON.stringify({ allow: [" X.example ", "*.y.example", 5], repo: "a/b" }));
    assert.deepEqual(t.files.change("a.b", ["z.example"], [], "a/b"), { allow: ["x.example", "z.example"], refused: [] });
    assert.deepEqual(json(t.files.file("a.b")), { allow: ["x.example", "z.example"], repo: "a/b" });
  } finally { t.done(); }
});

test("change keeps the repo of the file, or takes the repo that the caller gives only when it is the repo of the list's name", () => {
  const t = temp();
  try {
    put(t.files, "a.b", JSON.stringify({ allow: [], repo: "A/B" }));
    t.files.change("a.b", ["x.example"], [], null);
    assert.equal(json(t.files.file("a.b")).repo, "a/b", "the file's repo stays");
    t.files.change("c.d", ["x.example"], [], "a/b");
    assert.equal(json(t.files.file("c.d")).repo, null, "another list's repo is never written");
    t.files.change("c.d", ["x.example"], [], "c/d");
    assert.equal(json(t.files.file("c.d")).repo, "c/d");
    assert.throws(() => t.files.change("../x", ["x.example"], []), /a list name must be a scope name/);
    assert.equal(existsSync(join(t.dir, "browser", "x.json")), false);
  } finally { t.done(); }
});

test("change keeps a damaged list as it is and throws (also a list nested too deep)", () => {
  const t = temp();
  try {
    for (const body of ["{not json", "[" .repeat(200_000) + "]".repeat(200_000)]) {
      const f = put(t.files, "a.b", body);
      assert.throws(() => t.files.change("a.b", ["x.example"], [], "a/b"), ListDamagedError);
      assert.equal(readFileSync(f, "utf8"), body);
    }
    const f = put(t.files, "c.d", JSON.stringify({ allow: "x", repo: "c/d" }));
    assert.throws(() => t.files.change("c.d", ["x.example"], [], "c/d"), ListDamagedError);
    assert.equal(json(f).allow, "x");
  } finally { t.done(); }
});

test("an absent list is empty; a damaged list reads as empty with its error and keeps its repo", () => {
  const t = temp();
  try {
    assert.deepEqual(t.files.read("a.b"), { name: "a.b", repo: null, hosts: [], error: "" });
    for (const body of ['{"allow": "x"}', "{", "[]", "{}", "null", '{"allow": null}', Buffer.from([0xff, 0xfe]), '"x.example"']) {
      put(t.files, "a.b", body);
      const info = t.files.read("a.b");
      assert.deepEqual([info.hosts, info.error], [[], DAMAGED_TEXT], String(body));
    }
    put(t.files, "a.b", JSON.stringify({ allow: "x", repo: "A/B" }));
    assert.deepEqual(t.files.read("a.b"), { name: "a.b", repo: "a/b", hosts: [], error: DAMAGED_TEXT });
    rmSync(t.files.file("a.b"));
    mkdirSync(t.files.file("a.b"));
    assert.deepEqual(t.files.read("a.b"), { name: "a.b", repo: null, hosts: [], error: DAMAGED_TEXT }, "a folder in place of the file");
  } finally { t.done(); }
});

test("a hand-edited list is normalized, and its bad entries are counted, never named", () => {
  const t = temp();
  try {
    put(t.files, "a.b", JSON.stringify({ allow: [" X.com ", "x.com", "*.y.com", "http://z"] }));
    const info = t.files.read("a.b");
    assert.deepEqual(info.hosts, ["x.com"]);
    assert.equal(info.error, skippedText(2));
    assert.ok(!info.error.includes("y.com") && !info.error.includes("http"));
    put(t.files, "a.b", JSON.stringify({ allow: ["x.com", 7] }));
    assert.deepEqual(t.files.read("a.b"), { name: "a.b", repo: null, hosts: ["x.com"], error: skippedText(1) });
    assert.equal(SKIPPED_ONE_TEXT, "1 entry of the list is not a valid host name and is left out");
    assert.equal(SKIPPED_MANY_TEXT.replace("{count}", "2"), "2 entries of the list are not valid host names and are left out");
    assert.equal(skippedText(1), SKIPPED_ONE_TEXT);
    assert.equal(skippedText(3), SKIPPED_MANY_TEXT.replace("{count}", "3"));
  } finally { t.done(); }
});

test("a list file that names another repo gets no repo and says so; a repo null or in another case is no error; each error is named", () => {
  const t = temp();
  try {
    for (const stored of ["not a repo", "c/d", "a/b/c", 5, ["a/b"]]) {
      put(t.files, "a.b", JSON.stringify({ allow: ["x.example"], repo: stored }));
      assert.deepEqual(t.files.read("a.b"), { name: "a.b", repo: null, hosts: ["x.example"], error: OTHER_REPO_TEXT }, JSON.stringify(stored));
    }
    put(t.files, "no-repo", JSON.stringify({ allow: [], repo: "a/b" }));
    assert.deepEqual(t.files.read("no-repo"), { name: "no-repo", repo: null, hosts: [], error: OTHER_REPO_TEXT });
    put(t.files, "a.b", JSON.stringify({ allow: ["x.example"], repo: null }));
    assert.deepEqual(t.files.read("a.b"), { name: "a.b", repo: null, hosts: ["x.example"], error: "" });
    put(t.files, "a.b", JSON.stringify({ allow: [], repo: " A/B " }));
    assert.deepEqual(t.files.read("a.b"), { name: "a.b", repo: "a/b", hosts: [], error: "" });
    put(t.files, "a.b", JSON.stringify({ allow: ["x.example", "*.y.example"], repo: "c/d" }));
    assert.deepEqual(t.files.read("a.b"), { name: "a.b", repo: null, hosts: ["x.example"], error: `${OTHER_REPO_TEXT}; ${skippedText(1)}` });
    put(t.files, "a.b", JSON.stringify({ allow: "x", repo: "c/d" }));
    assert.deepEqual(t.files.read("a.b"), { name: "a.b", repo: null, hosts: [], error: `${DAMAGED_TEXT}; ${OTHER_REPO_TEXT}` });
  } finally { t.done(); }
});

test("a list name that is no scope is refused", () => {
  const files = new ListFiles("/cfg/browser/lists");
  for (const bad of ["../x", "", ".x", "a/b", "x".repeat(65)]) assert.throws(() => files.file(bad), /a list name must be a scope name/, bad);
  assert.throws(() => files.read("../x"));
});

test("loadAll reads each list that has a file, sorted by name; a damaged or deep list fails closed for its own list only", () => {
  const t = temp();
  try {
    assert.deepEqual(t.files.loadAll(), [], "no lists folder");
    t.files.change("c.d", ["c.example"], [], "c/d");
    t.files.change("no-repo", ["n.example"], []);
    t.files.change("a.b", ["a.example"], [], "a/b");
    writeFileSync(join(t.files.folder, ".hidden.json"), "{}");
    writeFileSync(join(t.files.folder, "notes.txt"), "x");
    assert.deepEqual(t.files.loadAll().map((i) => [i.name, i.repo, i.hosts]), [["a.b", "a/b", ["a.example"]], ["c.d", "c/d", ["c.example"]], ["no-repo", null, ["n.example"]]]);
    put(t.files, "a.b", '{"allow": ' + "[".repeat(200_000) + "]".repeat(200_000) + "}");
    assert.deepEqual(t.files.read("a.b"), { name: "a.b", repo: null, hosts: [], error: DAMAGED_TEXT });
    assert.deepEqual(t.files.loadAll()[1], { name: "c.d", repo: "c/d", hosts: ["c.example"], error: "" });
    put(t.files, "a.b", "{");
    assert.deepEqual(t.files.loadAll()[0], { name: "a.b", repo: null, hosts: [], error: DAMAGED_TEXT });
  } finally { t.done(); }
});

test("loadAll throws when the lists folder cannot be read (a file in its place): the status names it", () => {
  const t = temp();
  try {
    mkdirSync(join(t.dir, "browser"), { recursive: true });
    writeFileSync(t.files.folder, "x");
    assert.throws(() => t.files.loadAll(), (e: any) => e.code === "ENOTDIR");
  } finally { t.done(); }
});

test("the old single list is read only: its entries as they are, [] when it is absent or damaged; no list change writes it", () => {
  const t = temp();
  try {
    assert.deepEqual(t.files.oldAllow(), []);
    mkdirSync(join(t.dir, "browser"), { recursive: true });
    writeFileSync(t.files.oldFile, JSON.stringify({ allow: ["b.localhost", "a.localhost"] }));
    assert.deepEqual(t.files.oldAllow(), ["b.localhost", "a.localhost"]);
    t.files.change("a.b", ["x.example"], [], "a/b");
    assert.deepEqual(json(t.files.oldFile), { allow: ["b.localhost", "a.localhost"] }, "Decision 4: nothing copies or changes it");
    for (const body of ["{not json", "[]", '{"allow": "x"}', '{"allow": [1]}', "{}"]) {
      writeFileSync(t.files.oldFile, body);
      assert.deepEqual(t.files.oldAllow(), [], body);
    }
  } finally { t.done(); }
});

// ------------------------------------------------------------------ the list copy of each scope (commands/browser.py, test_service.py)

function copies() {
  const dir = mkdtempSync(join(tmpdir(), "ab-copies-"));
  const logs: string[] = [];
  return { dir, logs, copies: new ListCopies(join(dir, "state"), (l) => logs.push(l)), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the list copy of a scope is <state>/session-lists/<scope>/allowlist.json: the list's hosts only, mode 0600, in folders of mode 0700", () => {
  const c = copies();
  try {
    const p = c.copies.path("w");
    assert.equal(p, join(c.dir, "state", "session-lists", "w", "allowlist.json"));
    assert.equal(c.copies.write("w", ["a.example", "b.example"]), true);
    assert.deepEqual(json(p), { allow: ["a.example", "b.example"] });
    assert.equal(mode(p), 0o600);
    assert.equal(mode(join(c.dir, "state", "session-lists", "w")), 0o700);
    assert.equal(mode(join(c.dir, "state", "session-lists")), 0o700);
    assert.equal(c.copies.write("w", []), true);
    assert.deepEqual(json(p), { allow: [] });
    assert.deepEqual(readdirSync(join(c.dir, "state", "session-lists", "w")), ["allowlist.json"], "no temp file stays");
  } finally { c.done(); }
});

test("the list copy is never written through a symbolic link (at session-lists, at the scope's folder or at the file)", () => {
  for (const at of ["root", "folder", "file"] as const) {
    const c = copies();
    try {
      const elsewhere = join(c.dir, "elsewhere");
      mkdirSync(elsewhere);
      const root = join(c.dir, "state", "session-lists");
      if (at === "root") { mkdirSync(join(c.dir, "state")); symlinkSync(elsewhere, root); }
      else if (at === "folder") { mkdirSync(root, { recursive: true }); symlinkSync(elsewhere, join(root, "w")); }
      else { mkdirSync(join(root, "w"), { recursive: true }); symlinkSync(join(elsewhere, "target.json"), join(root, "w", "allowlist.json")); }
      assert.equal(c.copies.write("w", ["a.example"]), false, at);
      assert.deepEqual(readdirSync(elsewhere), [], `${at}: nothing written through the link`);
      assert.ok(c.logs.some((l) => /symbolic link/.test(l)), at);
    } finally { c.done(); }
  }
});

test("the end of a scope removes its list copy and no other; a second end, or the end of a scope with no copy, does nothing", () => {
  const c = copies();
  try {
    c.copies.write("x", ["a.example"]);
    c.copies.write("y", ["a.example"]);
    c.copies.remove("x");
    assert.equal(existsSync(join(c.dir, "state", "session-lists", "x")), false);
    assert.equal(existsSync(c.copies.path("y")), true);
    c.copies.remove("x");
    c.copies.remove("gone");
    assert.equal(existsSync(join(c.dir, "state", "session-lists")), true);
  } finally { c.done(); }
});

test("the end of a name that is no scope removes nothing, and no removal goes through a symbolic link", () => {
  const c = copies();
  try {
    c.copies.write("y", ["a.example"]);
    writeFileSync(join(c.dir, "state", "keep"), "x");
    for (const bad of ["..", ".", "x/../y", "../state", "bad name", ""]) c.copies.remove(bad);
    assert.equal(existsSync(c.copies.path("y")), true);
    assert.equal(existsSync(join(c.dir, "state", "keep")), true);
    // A link at the scope's folder: the link and its target stay.
    const elsewhere = join(c.dir, "elsewhere");
    mkdirSync(join(elsewhere, "x"), { recursive: true });
    writeFileSync(join(elsewhere, "x", "allowlist.json"), "{}");
    symlinkSync(join(elsewhere, "x"), join(c.dir, "state", "session-lists", "x"));
    c.copies.remove("x");
    assert.ok(lstatSync(join(c.dir, "state", "session-lists", "x")).isSymbolicLink());
    assert.equal(existsSync(join(elsewhere, "x", "allowlist.json")), true);
    // A link at session-lists itself.
    const c2 = copies();
    try {
      mkdirSync(join(c2.dir, "state"));
      symlinkSync(elsewhere, join(c2.dir, "state", "session-lists"));
      c2.copies.remove("x");
      assert.equal(existsSync(join(elsewhere, "x", "allowlist.json")), true);
      assert.ok(lstatSync(join(c2.dir, "state", "session-lists")).isSymbolicLink());
    } finally { c2.done(); }
  } finally { c.done(); }
});
