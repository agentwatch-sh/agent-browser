// Stage 1c of the self-contained agent browser (board ab-v16.94.4): the blocked-site prompts that move into the service
// (the design, section 5.1, "The blocked-site prompts"): the per-host limit of a blocked report (once in 10 s, at most
// 256 hosts kept), the prompt of a blocked host with its list, its cover check, its warnings (broad providers, shared
// hosts, SIGN_IN_HOSTS), its recipients and the dismissals. The cases are agentwatch's reference cases
// (tests/gateway/test_browser_prompts.py, tests/test_browser_prompt_rules.py, the limit cases of
// tests/daemon/browser/test_service.py and the blocked vectors of tests/daemon/browser/bridge_vector.json), ported.
// Each test uses a temp folder only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROAD_HOSTS, BROAD_TEXT, SHARED_TEXT, SIGN_IN_HOSTS, warningsFor } from "../src/service/prompts/rules.ts";
import { BLOCKED_HOSTS_KEPT, BLOCKED_MIN_MS, DISMISS_S, MAX_DISMISSALS, MAX_PROMPTS, PromptBook, type Recipient, type Target } from "../src/service/prompts/prompts.ts";
import { writeJson } from "../src/service/lists/files.ts";

// ------------------------------------------------------------------ the warnings (test_browser_prompt_rules.py)

test("the warnings: a broad provider's exact host, and a shared sign-in host with its subdomains (the domain boundaries)", () => {
  const cases: [string, string[]][] = [
    ["acme.okta.com", []], ["okta.com.evil.net", []], ["evilokta.com", []], ["google.com", ["broad"]], ["auth0.com", ["broad"]], ["okta.com", ["broad"]],
    ["microsoftonline.com", ["broad"]], ["login.microsoftonline.com", ["shared"]], ["accounts.google.com", ["shared"]], ["sub.accounts.google.com", ["shared"]],
    ["github.com", ["shared"]], ["sub.github.com", ["shared"]], ["github.com.evil.net", []], ["login.example.com", []], ["login.live.com", ["shared"]],
    ["appleid.apple.com", ["shared"]], ["signin.aws.amazon.com", ["shared"]], ["id.atlassian.com", ["shared"]],
  ];
  for (const [host, kinds] of cases) assert.deepEqual(warningsFor(host).map((w) => w.kind), kinds, host);
  assert.deepEqual(warningsFor("google.com"), [{ kind: "broad", text: BROAD_TEXT }]);
  assert.deepEqual(warningsFor("github.com"), [{ kind: "shared", text: SHARED_TEXT }]);
  assert.equal(BROAD_TEXT, "This covers every customer of the provider and its own site. Use your tenant's host.");
  assert.match(SHARED_TEXT, /^This host serves every account of the provider\./);
  assert.deepEqual([...BROAD_HOSTS].sort(), ["auth0.com", "google.com", "microsoftonline.com", "okta.com"]);
  assert.equal(SIGN_IN_HOSTS.length, 7);
});

// ------------------------------------------------------------------ the rig

type Rig = { dir: string; file: string; now: number[]; wall: number[]; logs: string[]; book: PromptBook; make: (o?: { write?: (p: string, v: unknown) => void }) => PromptBook; done: () => void };
function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "ab-prompts-"));
  const file = join(dir, "state", "prompt-dismissals.json");
  const now = [1_000_000], wall = [100], logs: string[] = [];
  const make = (o: { write?: (p: string, v: unknown) => void } = {}) => new PromptBook({ file, now: () => now[0], wall: () => wall[0], log: (l) => logs.push(l), write: o.write });
  return { dir, file, now, wall, logs, book: make(), make, done: () => rmSync(dir, { recursive: true, force: true }) };
}
function withRig(f: (r: Rig) => void): () => void { return () => { const r = rig(); try { f(r); } finally { r.done(); } }; }
const target = (hosts: string[] = ["app.example"], name = "a.b", repo: string | null = "a/b"): Target => ({ name, repo, hosts });
const block = (host = "blocked.example", scope: string | null = "worker", from: string | null = "app.example") => ({ host, scope, from });
const one = (t: Target | null = target(), r: Recipient | null = { session: "worker", lifetime_id: "life1" }) => ({ targetOf: () => t, recipientOf: () => r });
/** A block that the limit lets through: the clock moves past the limit first. */
function see(r: Rig, b = block(), o = one(), book = r.book) { r.now[0] += BLOCKED_MIN_MS; return book.blocked(b, o.targetOf, o.recipientOf); }

// ------------------------------------------------------------------ the per-host limit (on_blocked, the blocked vectors)

test("the limit: one blocked report per host in 10 s, counted from the last one that went; a dropped report does not move it; it is shared across scopes and sources", withRig((r) => {
  assert.equal(BLOCKED_MIN_MS, 10_000);
  const t0 = r.now[0];
  assert.equal(r.book.admit("a.example"), true, "at 0 s");
  r.now[0] = t0 + 6000;
  assert.equal(r.book.admit("a.example"), false, "a dropped attempt at 6 s (another scope, the model's report)");
  r.now[0] = t0 + 9999;
  assert.equal(r.book.admit("a.example"), false);
  assert.equal(r.book.admit("b.example"), true, "another host");
  r.now[0] = t0 + 10_000;
  assert.equal(r.book.admit("a.example"), true, "the host limit ends at exactly 10 s");
  r.now[0] = t0 + 12_000;
  assert.equal(r.book.admit("a.example"), false);
}));

test("the limit keeps at most 256 hosts: a full state drops a new host; 255 leave one place; a full state frees the hosts past their 10 s first", withRig((r) => {
  assert.equal(BLOCKED_HOSTS_KEPT, 256);
  const t0 = r.now[0];
  for (let i = 0; i < 256; i++) assert.equal(r.book.admit(`h${i}.example`), true);
  r.now[0] = t0 + 1000;
  assert.equal(r.book.admit("new.example"), false, "256 recent hosts: a new host is dropped");
  const r2 = rig();
  try {
    for (let i = 0; i < 255; i++) r2.book.admit(`h${i}.example`);
    r2.now[0] += 1000;
    assert.equal(r2.book.admit("new.example"), true, "255 recent hosts leave one place");
  } finally { r2.done(); }
  const r3 = rig();
  try {
    const s = r3.now[0];
    r3.book.admit("h0.example");
    r3.now[0] = s + 2000;
    for (let i = 1; i < 256; i++) r3.book.admit(`h${i}.example`);
    r3.now[0] = s + 11_000;
    assert.equal(r3.book.admit("new.example"), true, "h0 is past its 10 s, so its place is free");
  } finally { r3.done(); }
}));

test("a flood of blocked hosts stays bounded: exactly 256 go, and after the limit a late host goes and the state holds it alone", withRig((r) => {
  for (let i = 0; i < 400; i++) r.book.blocked(block(`f${i}.example`, null, null), () => null, () => null);
  assert.equal(r.logs.filter((l) => /^prompts: blocked a navigation to f\d+\.example$/.test(l)).length, 256);
  assert.ok(r.book.hostsKept() <= 256);
  r.now[0] += BLOCKED_MIN_MS;
  r.book.blocked(block("late.example", null, null), () => null, () => null);
  assert.equal(r.logs.at(-1), "prompts: blocked a navigation to late.example");
  assert.equal(r.book.hostsKept(), 1);
}));

test("each blocked report that goes is logged with its host only, never its scope; a host that the host rules refuse is dropped and not logged", withRig((r) => {
  see(r, block("a.example", "private-scope", "listed.example"), one(null));
  r.now[0] += 6000;
  r.book.blocked(block("a.example", "other-scope"), () => null, () => null);
  r.now[0] += 4000;
  r.book.blocked(block("a.example", "other-scope"), () => null, () => null);
  r.book.blocked(block("https://user:secret@x.example/path", "s"), () => null, () => null);
  assert.deepEqual(r.logs, ["prompts: blocked a navigation to a.example", "prompts: blocked a navigation to a.example"]);
  assert.ok(r.logs.every((l) => !l.includes("scope") && !l.includes("secret")));
}));

// ------------------------------------------------------------------ the prompts (test_browser_prompts.py)

test("a block makes one prompt with its scope's list, the list's repo and its from host; the event is open, with no URL path", withRig((r) => {
  const evs = see(r);
  const [view] = r.book.views();
  assert.deepEqual({ host: view.host, list: view.list, repo: view.repo, from: view.from, scopes: view.scopes, recipients: view.recipients },
    { host: "blocked.example", list: "a.b", repo: "a/b", from: "app.example", scopes: ["worker"], recipients: [{ session: "worker", lifetime_id: "life1" }] });
  assert.match(view.id, /^[0-9a-f]{32}$/);
  assert.deepEqual(Object.keys(view), ["id", "host", "list", "repo", "scopes", "from", "warnings", "recipients"]);
  assert.deepEqual(evs, [{ t: "ev", ev: "prompt", id: view.id, state: "open", host: "blocked.example", scope: "worker", list: "a.b", from: "app.example", warnings: [] }]);
}));

test("one open prompt for each host and list; a block of the same host for another list makes a second prompt; a block that changes nothing sends no event", withRig((r) => {
  see(r);
  assert.deepEqual(see(r), [], "the same block again: no change, no event");
  see(r);
  assert.equal(r.book.views().length, 1);
  const evs = see(r, block("blocked.example", "other"), one(target([], "c.d", "c/d"), { session: "other", lifetime_id: null }));
  assert.equal(evs[0].state, "open");
  assert.deepEqual(r.book.views().map((v) => v.list).sort(), ["a.b", "c.d"]);
  const changed = see(r, block("blocked.example", "w2"), one(target(), { session: "w2", lifetime_id: "life2" }));
  assert.deepEqual(changed.map((e) => [e.state, e.scope]), [["changed", "w2"]], "a new scope changes the prompt");
  assert.deepEqual(r.book.views().find((v) => v.list === "a.b")!.scopes, ["w2", "worker"]);
}));

test("no prompt for a block with no scope, of a scope with no list (unknown, waiting or with no target), or of a host that the host rules refuse", withRig((r) => {
  for (const [b, t] of [[block("blocked.example", null), target()], [block(), null], [block("https://user:secret@blocked.example"), target()], [block("*.example"), target()], [block("127.0.0.1"), target()]] as const) {
    assert.deepEqual(see(r, b as any, one(t as any)), []);
  }
  assert.deepEqual(r.book.views(), []);
}));

test("the from host counts only when it is a valid host on the block's own list; each block sets it again (an invalid one clears it)", withRig((r) => {
  for (const from of ["other.example", "https://bad.example/path", "<script>", null]) {
    see(r, block("blocked.example", "worker", from));
    assert.equal(r.book.views()[0].from, null, String(from));
  }
  see(r, block("another.example", "worker", "WWW.App.Example."));
  assert.equal(r.book.views().find((v) => v.host === "another.example")!.from, "www.app.example");
  see(r);
  assert.equal(r.book.views().find((v) => v.host === "blocked.example")!.from, "app.example");
  const evs = see(r, block("blocked.example", "worker", "https://user:secret@bad.example"));
  assert.equal(r.book.views().find((v) => v.host === "blocked.example")!.from, null);
  assert.deepEqual(evs.map((e) => [e.state, e.from]), [["changed", null]]);
}));

test("a host that the list covers has no prompt; a list change that covers it closes the prompt with a closed event", withRig((r) => {
  assert.deepEqual(see(r, block("www.app.example")), []);
  see(r);
  const [p] = r.book.views();
  const evs = r.book.revalidate(() => target(["example"]));
  assert.deepEqual(evs, [{ t: "ev", ev: "prompt", id: p.id, state: "closed", host: "blocked.example", scope: "worker", list: "a.b", from: null, warnings: [] }]);
  assert.deepEqual(r.book.views(), []);
}));

test("a stale scope of a prompt (its list is not the prompt's list now, or it has none) closes the prompt; a from host that the list no longer covers is cleared", withRig((r) => {
  see(r);
  see(r, block("blocked.example", "other"));
  assert.equal(r.book.views().length, 1);
  assert.deepEqual(r.book.revalidate(() => target()), [], "nothing changed");
  const evs = r.book.revalidate((s) => (s === "other" ? null : target()));
  assert.deepEqual(evs.map((e) => e.state), ["closed"]);
  assert.deepEqual(r.book.views(), []);
  see(r);
  assert.deepEqual(r.book.revalidate(() => target(["app.example"], "c.d", "c/d")).map((e) => e.state), ["closed"], "another list now");
  see(r);
  const ch = r.book.revalidate(() => target(["x.example"]));
  assert.deepEqual(ch.map((e) => [e.state, e.from]), [["changed", null]]);
  assert.equal(r.book.views()[0].from, null);
}));

test("the prompt limit keeps the 20 newest, and a dropped prompt gets a closed event", withRig((r) => {
  assert.equal(MAX_PROMPTS, 20);
  let closed = 0;
  for (let n = 0; n < 21; n++) closed += see(r, block(`h${n}.example`)).filter((e) => e.state === "closed").length;
  const views = r.book.views();
  assert.equal(views.length, 20);
  assert.equal(views[0].host, "h1.example");
  assert.equal(views.at(-1)!.host, "h20.example");
  assert.equal(closed, 1);
}));

test("a dismissal holds for 24 h and outlives a restart of the service; the file is mode 0600 and holds no open prompt", withRig((r) => {
  assert.equal(DISMISS_S, 86_400);
  see(r);
  assert.equal(existsSync(r.file), false, "open prompts are not kept on disk");
  const [p] = r.book.views();
  const evs = r.book.dismiss(p.id);
  assert.deepEqual(evs.map((e) => [e.state, e.id]), [["closed", p.id]]);
  assert.deepEqual(r.book.views(), []);
  assert.equal(statSync(r.file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(r.file, "utf8")), [{ host: "blocked.example", list: "a.b", until: 100 + 86_400 }]);
  const restored = r.make();
  assert.deepEqual(restored.views(), [], "open prompts are not restored");
  r.wall[0] += 86_399;
  assert.deepEqual(see(r, block(), one(), restored), []);
  r.wall[0] += 1;
  assert.equal(see(r, block(), one(), restored).length, 1);
}));

test("a dismissal whose write fails is no success: it throws, and the prompt stays open", withRig((r) => {
  const book = r.make({ write: () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } });
  see(r, block(), one(), book);
  const [p] = book.views();
  assert.throws(() => book.dismiss(p.id), (e: any) => e.code === "ENOSPC");
  assert.equal(book.views().length, 1);
  assert.equal(existsSync(r.file), false);
}));

test("the dismissal limit keeps the 500 newest", withRig((r) => {
  assert.equal(MAX_DISMISSALS, 500);
  for (let n = 0; n < 501; n++) {
    see(r, block(`h${n}.example`));
    const [p] = r.book.views();
    r.book.dismiss(p.id);
  }
  const restored = r.make();
  assert.deepEqual(see(r, block("h1.example"), one(), restored), []);
  see(r, block("h0.example"), one(), restored);
  assert.deepEqual(restored.views().map((v) => v.host), ["h0.example"]);
}));

test("a dismissals file that is damaged, or rows that break the rules (another host form, a bad list, an until in the past), are dropped at the start", withRig((r) => {
  writeJson(r.file, [
    { host: "ok.example", list: "a.b", until: 1000 }, { host: "OK.example", list: "a.b", until: 1000 }, { host: "x.example", list: "../x", until: 1000 },
    { host: "y.example", list: "a.b", until: 50 }, { host: "z.example", list: "a.b", until: true }, "junk",
  ]);
  const book = r.make();
  assert.deepEqual(see(r, block("ok.example"), one(), book), []);
  for (const h of ["x.example", "y.example", "z.example"]) assert.equal(see(r, block(h), one(target([], "a.b")), book).length, 1, h);
  writeJson(r.file, { not: "a list" });
  assert.deepEqual(r.make().views(), []);
}));

test("the recipients: each session that a block stopped, with the lifetime id of its run then, once; a null lifetime id is still a recipient", withRig((r) => {
  see(r, block(), one(target(), { session: "worker", lifetime_id: "life1" }));
  see(r, block(), one(target(), { session: "worker", lifetime_id: "life1" }));
  see(r, block(), one(target(), { session: "worker", lifetime_id: "life2" }));
  see(r, block("blocked.example", "w2"), one(target(), { session: "w2", lifetime_id: null }));
  see(r, block("blocked.example", "w3"), one(target(), null));
  assert.deepEqual(r.book.views()[0].recipients, [{ session: "worker", lifetime_id: "life1" }, { session: "worker", lifetime_id: "life2" }, { session: "w2", lifetime_id: null }]);
}));

test("find gives an open prompt by its id; close sends its closed event once", withRig((r) => {
  see(r);
  const [p] = r.book.views();
  assert.equal(r.book.find(p.id)!.host, "blocked.example");
  assert.equal(r.book.find("p-gone"), undefined);
  assert.equal(r.book.close(p.id).length, 1);
  assert.deepEqual(r.book.close(p.id), []);
  assert.deepEqual(readdirSync(r.dir), [], "no file without a dismissal");
}));
