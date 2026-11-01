// Tab scopes: several callers (agent sessions) share one agent browser and its state folder, and each
// works in its own scope. The library and the real CLI, against the fake Chrome, through the real
// proxy. No real browser starts and no site is contacted.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentBrowser } from "../src/browser.ts";
import { COMMAND_SPECS, commands } from "../src/commands.ts";
import { TabNotFoundError, UsageError } from "../src/errors.ts";
import { withFileLock } from "../src/lock.ts";
import { resolveOptions } from "../src/options.ts";
import { stopProxy } from "../src/proxy.ts";
import { FakeChrome } from "./fake-chrome.ts";
import { cli, consumer, fixtureServer, flags, site, type CliRun, type Consumer, type Fixture } from "./helpers.ts";

let fx: Fixture, fake: FakeChrome, c: Consumer, base: string;

before(async () => {
  fx = await fixtureServer();
  base = fx.base;
  fake = await FakeChrome.start(site(base));
  c = consumer();
});

after(async () => {
  stopProxy(resolveOptions(c.options()));
  await fake?.close();
  await fx?.close();
  c?.remove();
});

/** A caller of the shared state folder, in this tab scope (none: every tab). */
const connect = (scope?: string) => AgentBrowser.connect(c.options({ endpoint: fake.ws, ...(scope === undefined ? {} : { tabScope: scope }) }));
const scopeRecord = () => JSON.parse(readFileSync(join(c.stateDir, "tab-scopes.json"), "utf8"));
const registry = () => JSON.parse(readFileSync(join(c.stateDir, "tabs.json"), "utf8"));

/** Run the CLI with --json for the test consumer, in this tab scope (none: no --tab-scope). */
async function run(args: string[], scope?: string, input?: string): Promise<CliRun> {
  const r = await cli([...args, ...flags(c, fake.ws, scope === undefined ? [] : ["--tab-scope", scope]), "--json"], { input });
  assert.equal(r.stdout.trim().split("\n").length, 1, `one line on stdout: ${r.stdout} ${r.stderr}`);
  assert.equal(r.json?.command, args[0], r.stdout);
  return r;
}

const ids = (pages: { targetId: string }[]) => pages.map((p) => p.targetId).sort();

test("a tab scope is one plain word: 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or a digit", async () => {
  for (const good of ["a", "0", "sess-a", "A.b_c-1", "x".repeat(64)]) assert.equal(resolveOptions({ stateDir: c.stateDir, tabScope: good }).tabScope, good);
  assert.equal(resolveOptions({ stateDir: c.stateDir }).tabScope, undefined, "no scope by default");
  for (const bad of ["", " ", "a b", "-a", ".a", "_a", "a/b", "../a", "a:b", 'a"b', "a\nb", "a\u0000", "naïve", "x".repeat(65), 5, null])
    assert.throws(() => resolveOptions({ stateDir: c.stateDir, tabScope: bad as string }), UsageError, JSON.stringify(bad));
  const r = await cli(["tabs", "--tab-scope", "two words", "--state-dir", c.stateDir, "--allowlist", c.allowlist, "--json"]);
  assert.equal(r.status, 2);
  assert.deepEqual(r.json.error, { code: "usage", message: 'tabScope must be 1 to 64 letters, digits, ".", "_" or "-", starting with a letter or a digit, not "two words"' });
  const help = await cli(["--help"]);
  assert.match(help.stdout, /--tab-scope X/);
  assert.match(help.stdout, /--any-scope \(on\s+tabs, window and every command that takes <tab>\)/);
});

test("no tab scope: every document, tabs.json and the resolver are as before, and every tab is visible", async () => {
  let r = await run(["open", base + "/?plain", "--name", "work"]);
  assert.deepEqual(Object.keys(r.json).sort(), ["command", "ok", "tab", "window"]);
  assert.deepEqual(Object.keys(r.json.tab), ["id", "targetId", "name", "url", "title"], "a TabRef as before, in the same order");
  const work = r.json.tab;
  r = await run(["tabs"]);
  assert.deepEqual(r.json, { ok: true, command: "tabs", tabs: [work], window: null }, "no scope fields");
  assert.deepEqual(registry(), { work: work.targetId }, "tabs.json keeps its format");
  assert.equal(existsSync(join(c.stateDir, "tab-scopes.json")), false, "nothing is written for scopes");
  r = await run(["text", "nothing-matches"]);
  assert.deepEqual(r.json.error, { code: "tab_not_found", message: 'no allowlisted tab matches "nothing-matches" (see: agent-browser tabs)' });

  // Every tab is visible with no scope: a session's tab too, by its target-id prefix, its URL and its name.
  const a = await connect("sess-a");
  try {
    const theirs = await a.open(base + "/next?alpha", { name: "theirs" });
    r = await run(["tabs"]);
    assert.deepEqual(r.json.tabs.map((t: any) => [t.name, t.scope]).sort(), [["theirs", "sess-a"], ["work", undefined]]);
    for (const ref of [theirs.targetId.slice(0, 8), "?alpha", "theirs", "work"]) {
      r = await run(["text", ref]);
      assert.equal(r.json.ok, true, `${ref}: ${r.stdout}`);
    }
    await theirs.close();
  } finally { await a.disconnect(); }
  r = await run(["close", "work"]);
  assert.deepEqual(registry(), {});
});

test("a scope sees only its own tabs, in all three forms; a match outside it names --any-scope and never the tab's URL or title", async () => {
  const a = await connect("sess-a"), b = await connect("sess-b"), u = await connect();
  const hand = fake.addPage(base + "/?hand"); // a tab the operator opened by hand: no scope
  try {
    const mine = await a.open(base + "/?alpha", { name: "main" });
    const theirs = await b.open(base + "/next?beta", { name: "main" }); // title "next"
    const plain = await u.open(base + "/?gamma", { name: "work" });

    assert.deepEqual(ids(await a.allowedPages()), [mine.targetId]);
    assert.deepEqual(ids(await b.allowedPages()), [theirs.targetId]);
    assert.equal((await a.resolve("main")).targetId, mine.targetId, "both scopes name a tab main, and each finds its own");
    assert.equal((await b.resolve("main")).targetId, theirs.targetId);
    assert.equal((await a.resolve(mine.targetId.slice(0, 6).toLowerCase())).targetId, mine.targetId);
    assert.equal((await a.resolve("?alpha")).targetId, mine.targetId);

    const callsBefore = fake.callsFor(theirs.targetId).length;
    // A name or a target-id prefix that matches only outside the scope: the hint names --any-scope.
    const outside = [theirs.targetId.slice(0, 8), theirs.targetId.slice(0, 5).toLowerCase(), plain.targetId.slice(0, 8), "work", hand.targetId.slice(0, 8)];
    for (const ref of outside) {
      await assert.rejects(a.resolve(ref), (e: Error) => {
        assert.ok(e instanceof TabNotFoundError, ref);
        assert.equal(e.message, `no tab of scope "sess-a" matches "${ref}", but a tab outside this scope does (another scope's, or one with no scope); pass --any-scope to reach it`);
        return true;
      });
    }
    // A URL substring that matches only outside the scope: the plain error, so the hint is no oracle on other scopes' URLs.
    for (const ref of ["?beta", "next", "?gamma", "?hand"]) {
      await assert.rejects(a.resolve(ref), (e: Error) => {
        assert.ok(e instanceof TabNotFoundError, ref);
        assert.equal(e.message, `no allowlisted tab of scope "sess-a" matches "${ref}" (see: agent-browser tabs)`);
        return true;
      });
    }
    await assert.rejects(a.resolve("no-such-tab"), { message: 'no allowlisted tab of scope "sess-a" matches "no-such-tab" (see: agent-browser tabs)' });
    await assert.rejects(a.find("?beta"), TabNotFoundError);
    assert.equal(fake.callsFor(theirs.targetId).length, callsBefore, "a scoped caller made no CDP call that names another scope's tab");

    // --any-scope: every allowlisted tab, a name of this scope first.
    const any = { anyScope: true };
    assert.equal((await a.resolve(theirs.targetId.slice(0, 8), any)).targetId, theirs.targetId);
    assert.equal((await a.resolve("?beta", any)).targetId, theirs.targetId);
    assert.equal((await a.resolve("work", any)).targetId, plain.targetId);
    assert.equal((await a.resolve("?hand", any)).targetId, hand.targetId);
    assert.equal((await a.resolve("main", any)).targetId, mine.targetId, "this scope's own name comes first");
    const all = await a.allowedPages(any);
    assert.deepEqual(ids(all), ids([mine, theirs, plain, hand]));
    assert.deepEqual(Object.fromEntries(all.map((p) => [p.targetId, p.scope ?? null])),
      { [mine.targetId]: "sess-a", [theirs.targetId]: "sess-b", [plain.targetId]: null, [hand.targetId]: null });

    // No scope: every tab; a name that two scopes use is refused, not guessed.
    await assert.rejects(u.resolve("main"), { message: '"main" names a tab in each of 2 other scopes; use the tab\'s target-id prefix (see: agent-browser tabs)' });
    await assert.rejects(a.resolve("main-not", any), { message: 'no allowlisted tab matches "main-not" (see: agent-browser tabs --any-scope)' });
    assert.equal((await u.resolve("?beta")).targetId, theirs.targetId);
    await theirs.close();
    assert.equal((await u.resolve("main")).targetId, mine.targetId, "one scope's name, when it is the only one");
    await mine.close();
    await plain.close();
  } finally {
    fake.pages.delete(hand.targetId);
    for (const x of [a, b, u]) await x.disconnect();
  }
});

test("names are kept per scope: a new tab takes a name only from an older tab of its own scope, and unnamed tabs are recorded too", async () => {
  const a = await connect("sess-a"), b = await connect("sess-b");
  try {
    const first = await a.open(base, { name: "main" });
    const other = await b.open(base, { name: "main" });
    const second = await a.open(base, { name: "main" });
    const unnamed = await a.open(base);
    const rec = scopeRecord();
    assert.deepEqual(rec[first.targetId], { scope: "sess-a", name: null }, "the older tab stays in its scope, without the name");
    assert.deepEqual(rec[second.targetId], { scope: "sess-a", name: "main" });
    assert.deepEqual(rec[other.targetId], { scope: "sess-b", name: "main" }, "another scope's tab keeps the same name");
    assert.deepEqual(rec[unnamed.targetId], { scope: "sess-a", name: null });
    assert.equal((await a.resolve("main")).targetId, second.targetId);
    assert.equal((await b.resolve("main")).targetId, other.targetId);
    assert.deepEqual(ids(await a.allowedPages()), ids([first, second, unnamed]));
    assert.ok(!existsSync(join(c.stateDir, "tabs.json")) || !Object.values(registry()).some((id) => [first, second, other, unnamed].some((t) => t.targetId === id)),
      "a scoped tab's name is never in tabs.json");
    for (const t of [first, other, second, unnamed]) await t.close();
    assert.deepEqual(scopeRecord(), {});
  } finally {
    await a.disconnect();
    await b.disconnect();
  }
});

test("close drops a tab from its scope's record; a tab that Chrome no longer has is dropped at the next change", async () => {
  const a = await connect("sess-a"), u = await connect();
  try {
    const one = await a.open(base, { name: "one" });
    const two = await a.open(base, { name: "two" });
    const named = await u.open(base, { name: "unscoped" });
    await one.close();
    assert.equal(scopeRecord()[one.targetId], undefined, "close removes it from the record");
    // Closed by hand, not through agent-browser: gone from every list at once, and from the record at the next change.
    await a.conn.send("Target.closeTarget", { targetId: two.targetId });
    await a.conn.send("Target.closeTarget", { targetId: named.targetId });
    assert.deepEqual(await a.allowedPages(), []);
    await assert.rejects(a.resolve("two"), /no allowlisted tab of scope "sess-a"/);
    assert.deepEqual(scopeRecord()[two.targetId], { scope: "sess-a", name: "two" }, "still in the file until the next change");
    const three = await a.open(base);
    assert.deepEqual(Object.keys(scopeRecord()), [three.targetId], "the next change dropped the closed tab");
    assert.deepEqual(registry(), {}, "and the closed tab's name in tabs.json");
    await three.close();
  } finally {
    await a.disconnect();
    await u.disconnect();
  }
});

test("CLI calls of two scopes at the same time lose no record (the record lock)", async () => {
  const scopes = ["sess-a", "sess-b", "sess-a", "sess-b", "sess-a", "sess-b", "sess-a", "sess-b"];
  const opened = await Promise.all(scopes.map((s, i) => run(["open", base + "/", "--name", `t${i}`], s)));
  const unscoped = await Promise.all([0, 1, 2].map((i) => run(["open", base + "/", "--name", `u${i}`])));
  for (const r of [...opened, ...unscoped]) assert.equal(r.json.ok, true, r.stdout);
  const rec = scopeRecord();
  opened.forEach((r, i) => assert.deepEqual(rec[r.json.tab.targetId], { scope: scopes[i], name: `t${i}` }, `t${i}`));
  assert.equal(Object.keys(rec).length, scopes.length);
  assert.deepEqual(registry(), Object.fromEntries(unscoped.map((r, i) => [`u${i}`, r.json.tab.targetId])));
  assert.equal(existsSync(join(c.stateDir, "tabs.lock")), false, "the lock is released");
  // Closing at the same time from both scopes (each its own tabs) empties the record.
  const closed = await Promise.all([...opened.map((r, i) => run(["close", `t${i}`], scopes[i])), ...unscoped.map((_, i) => run(["close", `u${i}`]))]);
  for (const r of closed) assert.equal(r.json.ok, true, r.stdout);
  assert.deepEqual(scopeRecord(), {});
  assert.deepEqual(registry(), {});
});

test("tabs in a scope lists its tabs and only a count of the others; --any-scope lists every tab with its scope", async () => {
  await run(["open", base + "/?alpha", "--name", "main"], "sess-a");
  const theirs = (await run(["open", base + "/next?beta", "--name", "main"], "sess-b")).json.tab;
  const plain = (await run(["open", base + "/?gamma", "--name", "work"])).json.tab;
  const hand = fake.addPage(base + "/?hand");
  const mail = fake.addPage("https://mail.example.org/inbox");
  try {
    let r = await run(["tabs"], "sess-a");
    assert.deepEqual(Object.keys(r.json).sort(), ["command", "ok", "outOfScope", "scope", "tabs", "window"]);
    assert.deepEqual(r.json.tabs.map((t: any) => [t.name, t.scope, t.url]), [["main", "sess-a", base + "/?alpha"]]);
    assert.deepEqual(Object.keys(r.json.tabs[0]), ["id", "targetId", "name", "scope", "url", "title"]);
    assert.equal(r.json.scope, "sess-a");
    assert.equal(r.json.outOfScope, 3, "sess-b's tab, the unscoped tab and the hand tab; the off-list mail tab is never counted here");
    assert.ok(!/beta|gamma|hand|next|mail/.test(r.stdout), "other tabs: a count only, no URL, title or name");

    r = await run(["tabs", "--any-scope"], "sess-a");
    assert.deepEqual(r.json.tabs.map((t: any) => [t.url, t.scope ?? null]).sort(),
      [[base + "/?alpha", "sess-a"], [base + "/?gamma", null], [base + "/?hand", null], [base + "/next?beta", "sess-b"]]);
    assert.equal(r.json.outOfScope, 3, "the same count: tabs outside the scope");

    r = await run(["tabs"]);
    assert.deepEqual(Object.keys(r.json).sort(), ["command", "ok", "tabs", "window"], "no scope: no scope fields");
    assert.equal(r.json.tabs.length, 4);

    r = await run(["status"], "sess-a");
    assert.equal(r.json.allowedTabs, 4, "status counts the whole browser, also in a scope");

    const text = await cli(["tabs", ...flags(c, fake.ws, ["--tab-scope", "sess-a"])]);
    assert.match(text.stdout, /^[0-9A-F]{8} {2}main {6}.*\?alpha\n3 allowlisted tabs outside scope sess-a\n$/);
    const every = await cli(["tabs", "--any-scope", ...flags(c, fake.ws, ["--tab-scope", "sess-a"])]);
    assert.match(every.stdout, new RegExp(`^${theirs.id} {2}main .*\\?beta {2}\\[scope sess-b\\]$`, "m"));
    assert.match(every.stdout, new RegExp(`^${plain.id} {2}work .*\\?gamma {2}\\[no scope\\]$`, "m"));
    assert.match(every.stdout, /\?alpha\n/, "this scope's own tab has no mark");
  } finally {
    fake.pages.delete(hand.targetId);
    fake.pages.delete(mail.targetId);
    await run(["close", "main"], "sess-a");
    await run(["close", "main"], "sess-b");
    await run(["close", "work"]);
  }
});

test("every command that takes a tab resolves it in the scope; --any-scope reaches past it", async () => {
  const ffmpeg = join(c.dir, "ffmpeg"); // record checks ffmpeg before it resolves the tab; this stand-in passes that check
  writeFileSync(ffmpeg, "#!/bin/sh\necho ' V..... libx264  H.264'\n");
  chmodSync(ffmpeg, 0o755);
  const theirs = (await run(["open", base + "/?beta", "--name", "theirs"], "sess-b")).json.tab;
  const id = theirs.id;
  const argsFor: Record<string, string[]> = {
    goto: ["goto", id, base + "/next"],
    outline: ["outline", id],
    click: ["click", id, "#1"],
    hover: ["hover", id, "#1"],
    type: ["type", id, "--stdin"],
    press: ["press", id, "Enter"],
    text: ["text", id],
    eval: ["eval", id, "1"],
    shot: ["shot", id],
    fetch: ["fetch", id, base + "/small.txt", join(c.dir, "f.txt")],
    download: ["download", id, base + "/file.bin", join(c.dir, "d.bin")],
    close: ["close", id],
    net: ["net", id, "--seconds", "1"],
    record: ["record", id, "--out", join(c.dir, "r.mp4"), "--ffmpeg", ffmpeg],
    window: ["window", "pin", id],
  };
  const withTab = COMMAND_SPECS.filter((s) => s.params.some((p) => p.name === "tab" && p.cli === "positional") || s.name === "window"); // open's --tab is a flag, not a <tab>
  assert.deepEqual(Object.keys(argsFor).sort(), withTab.map((s) => s.name).sort(), "every command that takes a tab is tried here");
  for (const s of [...withTab, COMMAND_SPECS.find((x) => x.name === "tabs")!])
    assert.deepEqual(s.params.at(-1), { name: "anyScope", type: "boolean", required: false, cli: "--any-scope", description: s.params.at(-1)!.description }, s.name);

  const callsBefore = fake.callsFor(theirs.targetId).length;
  for (const [name, args] of Object.entries(argsFor)) {
    const r = await run(args, "sess-a", "typed");
    if (name === "window") { // a pin under a tab scope needs --any-scope, which also widens the tab lookup
      assert.equal(r.json.error?.code, "usage", `${name}: ${r.stdout}`);
      assert.match(r.json.error.message, /pass --any-scope to do it anyway$/);
      continue;
    }
    assert.equal(r.json.error?.code, "tab_not_found", `${name}: ${r.stdout}`);
    assert.match(r.json.error.message, /^no tab of scope "sess-a" matches "[0-9A-F]{8}", but a tab outside this scope does .*; pass --any-scope to reach it$/, name);
  }
  assert.equal(fake.callsFor(theirs.targetId).length, callsBefore, "none of them touched the tab");

  let r = await run(["text", id, "--any-scope"], "sess-a");
  assert.equal(r.json.ok, true, r.stdout);
  assert.deepEqual([r.json.tab.name, r.json.tab.scope], ["theirs", "sess-b"]);
  r = await run(["window", "pin", id, "--any-scope"], "sess-a");
  assert.equal(typeof r.json.window, "number", r.stdout);
  assert.deepEqual(r.json.tabs.map((t: any) => t.id), [id], "--any-scope: every tab in the pinned window");
  r = await run(["window"], "sess-a");
  assert.deepEqual(r.json.tabs, [], "in this scope: none of the pinned window's tabs");
  await run(["window", "unpin", "--any-scope"], "sess-a");
  r = await run(["close", id, "--any-scope"], "sess-a");
  assert.equal(r.json.ok, true, r.stdout);
  assert.equal(scopeRecord()[theirs.targetId], undefined, "closed from another scope, it leaves its own scope's record");
  r = await run(["tabs", "--any-scope"], "sess-b");
  assert.deepEqual(r.json.tabs, []);
});

test("parallel text calls of two scopes lose no read mark (reads.json changes under the record lock); a closed tab's mark is dropped", async () => {
  const scopes = ["sess-a", "sess-b"];
  const tabs = await Promise.all(Array.from({ length: 10 }, (_, i) => run(["open", base + `/?read${i}`, "--name", `r${i}`], scopes[i % 2])));
  for (const r of tabs) assert.equal(r.json.ok, true, r.stdout);
  const marks = () => JSON.parse(readFileSync(join(c.stateDir, "reads.json"), "utf8"));
  try {
    for (let round = 0; round < 3; round++) {
      const read = await Promise.all(tabs.map((_, i) => run(["text", `r${i}`], scopes[i % 2])));
      for (const r of read) assert.equal(r.json.ok, true, r.stdout);
      const m = marks();
      tabs.forEach((r, i) => assert.equal(m[r.json.tab.targetId], base + `/?read${i}`, `round ${round}: the mark of r${i}`));
      assert.equal(existsSync(join(c.stateDir, "tabs.lock")), false, "the lock is released");
    }
    // Every read counts for the read-first rule of shot.
    const shot = await run(["shot", "r3", join(c.dir, "r3.png")], "sess-b");
    assert.equal(shot.json.ok, true, shot.stdout);
    // The loss above is a race; this is not: while another process holds the record lock, a read mark waits for it.
    const id2 = tabs[2].json.tab.targetId, readsFile = join(c.stateDir, "reads.json");
    const { pending } = await withFileLock(join(c.stateDir, "tabs.lock"), Date.now() + 1_000, async () => {
      const without = marks();
      delete without[id2];
      writeFileSync(readsFile, JSON.stringify(without));
      let done = false;
      const pending = run(["text", "r2"], "sess-a").finally(() => { done = true; });
      for (let t = 0; t < 20; t++) {
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(marks()[id2], undefined, "no mark is written while another process holds the lock");
      }
      assert.equal(done, false, "the text call waits for the lock");
      return { pending }; // not awaited here: the call can finish only once this lock is released
    });
    const waited = await pending;
    assert.equal(waited.json.ok, true, waited.stdout);
    assert.equal(marks()[id2], base + "/?read2", "written once the lock is free");
    // Closed by hand: its mark goes at the next change of the record.
    const gone = tabs[0].json.tab.targetId;
    fake.pages.delete(gone);
    assert.equal((await run(["text", "r1"], "sess-b")).json.ok, true);
    assert.equal(marks()[gone], undefined, "a tab that Chrome no longer has loses its mark");
    assert.equal(Object.keys(marks()).length, 9);
  } finally {
    await Promise.all(tabs.slice(1).map((_, j) => run(["close", `r${j + 1}`], scopes[(j + 1) % 2])));
  }
  assert.deepEqual(marks(), {}, "close drops the mark too");
});

test("under a tab scope, window pin and unpin need --any-scope (the pin confines every scope); with no scope they are unchanged; window.json is replaced, never rewritten in place", async () => {
  const one = (await run(["open", base + "/?pin1", "--name", "one"], "sess-a")).json.tab;
  const a = await connect("sess-a");
  const other = await a.open(base + "/?pin2", { name: "two", newWindow: true });
  const windowFile = join(c.stateDir, "window.json");
  try {
    for (const args of [["window", "pin", "one"], ["window", "unpin"]]) {
      const r = await run(args, "sess-a");
      assert.equal(r.status, 2, r.stdout);
      assert.deepEqual(r.json.error, { code: "usage", message: `window ${args[1]}: the pinned window belongs to the whole state folder, so this changes the tabs of every scope, not only of scope "sess-a"; pass --any-scope to do it anyway` });
      assert.equal(existsSync(windowFile), false, "nothing was pinned");
    }
    await assert.rejects(commands.window(c.options({ endpoint: fake.ws, tabScope: "sess-a" }), { unpin: true }), UsageError, "the library refuses it too");

    let r = await run(["window", "pin", "one", "--any-scope"], "sess-a");
    assert.equal(r.json.ok, true, r.stdout);
    assert.equal(r.json.window, await a.windowOf(one.targetId));
    const first = statSync(windowFile).ino;
    assert.deepEqual(JSON.parse(readFileSync(windowFile, "utf8")), { windowId: r.json.window });
    const second = await a.windowOf(other.targetId);
    assert.notEqual(second, r.json.window);
    await a.pinWindow(second); // the library call: the CLI can pin only a tab inside the pinned window now
    assert.deepEqual(JSON.parse(readFileSync(windowFile, "utf8")), { windowId: second });
    assert.notEqual(statSync(windowFile).ino, first, "a new file renamed over the old one: a reader never sees half of it");
    assert.deepEqual(readdirSync(c.stateDir).filter((f) => f.endsWith(".tmp")), [], "no temporary file is left");
    r = await run(["window", "unpin", "--any-scope"], "sess-a");
    assert.equal(r.json.window, null);

    // No scope: pin and unpin as before, with no flag.
    r = await run(["window", "pin", one.id]);
    assert.equal(typeof r.json.window, "number", r.stdout);
    r = await run(["window", "unpin"]);
    assert.equal(r.json.window, null, r.stdout);
    assert.equal(existsSync(windowFile), false);
  } finally {
    await other.close();
    await a.disconnect();
    await run(["close", "one"], "sess-a");
  }
});

test("open closes its new tab again when the tab record lock times out, so no unrecorded tab stays behind", { timeout: 60_000 }, async () => {
  const a = await connect("sess-a");
  try {
    const before = new Set(fake.pages.keys());
    // Another process holds the record lock for longer than open waits for it (10 s).
    await withFileLock(join(c.stateDir, "tabs.lock"), Date.now() + 1_000, async () => {
      await assert.rejects(a.open(base + "/?locked", { name: "locked" }), /the tab record lock timed out/);
    });
    assert.deepEqual([...fake.pages.keys()].filter((id) => !before.has(id)), [], "the new tab was closed");
    const rec: Record<string, { name: string | null }> = existsSync(join(c.stateDir, "tab-scopes.json")) ? scopeRecord() : {};
    assert.ok(!Object.values(rec).some((e) => e.name === "locked"), "and never recorded");
    const r = await run(["tabs", "--any-scope"]);
    assert.ok(!r.stdout.includes("?locked"), "no tab of it is left, scoped or not");
  } finally { await a.disconnect(); }
});
