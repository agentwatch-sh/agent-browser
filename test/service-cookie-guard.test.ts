// Board ab-dbm: the guard of the sent sign-ins' cookies (src/service/signin/cookie-guard.ts; C12, the status key
// `cookie_loss`). The record of each import's domain (its file and mode), the count of each domain in the agent
// profile's cookie file (read in place, immutable, a count by host_key only), the drop to 0 (one warning line, the status
// key and the operator's sentence, until the next import), the skips (one plain line, no warning), the coalesced check,
// and the wiring in the service (a check after a `ready` and after an import, in a fake world with a fake shim). Each
// cookie file here is a test file made with node:sqlite in a temp folder, with made-up hosts and sentinel values: never a
// real cookie file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHECK_DELAY_MS, COOKIE_RECORD, CookieGuard, cookieFile, countCookies, lossSentence, MAX_DOMAINS, type CookieCount } from "../src/service/signin/cookie-guard.ts";
import { Stage1c } from "../src/service/stage1c.ts";
import { ReceiverError, type ReceiverEvents, type ReceiverPort } from "../src/service/receiver.ts";
import { startService } from "../src/service/service.ts";
import { stampedLog } from "../src/service/main.ts";
import type { UnitState } from "../src/service/unit/owner.ts";
import { FakeReceiver } from "./fake-bridge.ts";
import { FakeTools, World } from "./fake-unit-world.ts";
import { tempDir } from "./temp-dirs.ts";

const NAME = "s3cr3t-SENTINEL-cookie-name-41ab";
const VALUE = "s3cr3t-SENTINEL-cookie-value-7f3a";
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(5); }
}

/** A cookie file in Chrome's form (the columns that matter here), with a row for each host; names and values are sentinels. */
function writeCookies(profile: string, hosts: string[]): string {
  mkdirSync(join(profile, "Default"), { recursive: true, mode: 0o700 });
  const file = cookieFile(profile);
  rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE cookies (creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL)");
  const ins = db.prepare("INSERT INTO cookies VALUES (?, ?, '', ?, ?, ?, '/')");
  hosts.forEach((h, i) => ins.run(i, h, `${NAME}-${i}`, VALUE, Buffer.from(`v10${VALUE}`)));
  db.close();
  return file;
}

type G = { dir: string; state: string; profile: string; logs: string[]; now: { t: number }; guard: CookieGuard; make: (o?: Partial<ConstructorParameters<typeof CookieGuard>[0]>) => CookieGuard; done: () => void };
function rig(o: Partial<ConstructorParameters<typeof CookieGuard>[0]> = {}): G {
  const dir = tempDir("ab-cookie-guard-");
  const state = join(dir, "state"), profile = join(state, "profile");
  mkdirSync(state, { mode: 0o700 });
  const logs: string[] = [];
  const now = { t: Date.parse("2026-11-27T05:00:00Z") };
  const guards: CookieGuard[] = [];
  const make = (x: Partial<ConstructorParameters<typeof CookieGuard>[0]> = {}) => {
    const g = new CookieGuard({ stateFolder: state, profile, log: (l) => logs.push(l), wall: () => now.t, delayMs: 3_600_000, ...o, ...x });
    guards.push(g);
    return g;
  };
  const guard = make();
  return { dir, state, profile, logs, now, guard, make, done: () => { for (const g of guards) g.stop(); rmSync(dir, { recursive: true, force: true }); } };
}
const withRig = (f: (g: G) => Promise<void> | void, o?: Partial<ConstructorParameters<typeof CookieGuard>[0]>) => async () => { const g = rig(o); try { await f(g); } finally { g.done(); } };
const noSecret = (text: string, what: string) => { for (const s of [NAME, VALUE, "s3cr3t"]) assert.ok(!text.includes(s), `${what}: ${s}`); };

test("board ab-dbm: an import's record holds the domain, the count set and the UTC time, in sign-in-cookies.json with mode 0600; a new guard (a restart) reads it back; a new import of the domain replaces its entry", withRig((g) => {
  assert.equal(existsSync(join(g.state, COOKIE_RECORD)), false, "no file before an import");
  g.guard.imported("a.example", 12);
  g.now.t += 1000;
  g.guard.imported("shop.example", 3);
  const file = join(g.state, COOKIE_RECORD);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const rec = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(rec, { v: 1, domains: [
    { domain: "a.example", cookies_set: 12, imported: "2026-11-27T05:00:00Z", count: null, lost: null },
    { domain: "shop.example", cookies_set: 3, imported: "2026-11-27T05:00:01Z", count: null, lost: null },
  ] });
  assert.deepEqual(g.make().domains(), rec.domains, "the record outlives a restart");
  g.now.t += 1000;
  g.guard.imported("a.example", 7);
  assert.deepEqual(g.guard.domains().map((e) => [e.domain, e.cookies_set, e.imported]), [["shop.example", 3, "2026-11-27T05:00:01Z"], ["a.example", 7, "2026-11-27T05:00:02Z"]]);
  // A bad file starts the record again with one line; a bad entry of a good file is dropped.
  writeFileSync(file, "{not json");
  const logs0 = g.logs.length;
  assert.deepEqual(g.make().domains(), []);
  assert.deepEqual(g.logs.slice(logs0), ["signin: the record of sent sign-ins cannot be read (it is not JSON); it starts again with no domain"]);
  writeFileSync(file, JSON.stringify({ v: 1, domains: [{ domain: "A B", cookies_set: 1, imported: "2026-11-27T05:00:00Z", count: null, lost: null }, { domain: "b.example", cookies_set: 2, imported: "2026-11-27T05:00:00Z", count: 2, lost: null }] }));
  assert.deepEqual(g.make().domains().map((e) => e.domain), ["b.example"]);
}));

test("board ab-dbm: the count reads the cookie file in place: each domain with its subdomains (a.example, .a.example, www.a.example), no other host that ends with the same letters; it runs while another connection holds an exclusive lock (immutable: no lock)", () => {
  const dir = tempDir("ab-cookie-count-");
  try {
    const file = writeCookies(join(dir, "profile"), ["a.example", ".a.example", "www.a.example", ".deep.www.a.example", "evila.example", "a.example.other", "shop.example", "b.example"]);
    const r = countCookies(file, ["a.example", "shop.example", "none.example"]);
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual([...(r as { counts: Map<string, number> }).counts], [["a.example", 4], ["shop.example", 1], ["none.example", 0]]);
    // A writer that holds the exclusive lock (no page written yet, so no journal): a plain read-only connection waits for
    // it (SQLITE_BUSY), the guard's immutable read does not.
    const writer = new DatabaseSync(file);
    writer.exec("BEGIN EXCLUSIVE");
    try {
      const plain = new DatabaseSync(file, { readOnly: true });
      assert.throws(() => plain.prepare("SELECT COUNT(*) FROM cookies").get(), /locked|busy/i, "the lock holds");
      plain.close();
      const r2 = countCookies(file, ["a.example"]);
      assert.ok(r2.ok, JSON.stringify(r2));
    } finally { writer.exec("ROLLBACK"); writer.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("board ab-dbm: a count that cannot run is a skip with its reason: no cookie file, a journal or a write-ahead log that is not empty, a file that is no SQLite file, a file that changed during the read, a Node with no node:sqlite", () => {
  const dir = tempDir("ab-cookie-skip-");
  try {
    const profile = join(dir, "profile");
    const why = (r: CookieCount) => (r.ok ? "counted" : r.why);
    assert.equal(why(countCookies(cookieFile(profile), ["a.example"])), "the agent profile has no cookie file");
    const file = writeCookies(profile, ["a.example"]);
    // An empty journal (Chrome's at rest) is no write.
    writeFileSync(`${file}-journal`, "");
    assert.equal(why(countCookies(file, ["a.example"])), "counted");
    writeFileSync(`${file}-journal`, "a journal that holds pages");
    assert.equal(why(countCookies(file, ["a.example"])), "Chrome was writing the cookie file");
    rmSync(`${file}-journal`);
    writeFileSync(`${file}-wal`, "a write-ahead log");
    assert.equal(why(countCookies(file, ["a.example"])), "Chrome was writing the cookie file");
    rmSync(`${file}-wal`);
    // A file that changes during the read (a stand-in of node:sqlite whose read appends to the file).
    const changing = { DatabaseSync: class { prepare() { return { get: () => { appendFileSync(file, "x"); return { n: 1 }; } }; } close() {} } } as any;
    assert.equal(why(countCookies(file, ["a.example"], changing)), "Chrome was writing the cookie file");
    assert.equal(why(countCookies(file, ["a.example"], null)), "this Node has no node:sqlite");
    writeFileSync(file, "not a database, and no cookie in it either: ".repeat(200));
    assert.match(why(countCookies(file, ["a.example"])), /^SQLite cannot read the cookie file \(.+\)$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("board ab-dbm: the baseline is an earlier count of the file, never cookies_set: an import with cookies_set 5 whose first count is 0 gives no warning; then a count above 0 and a drop to 0 give one warning line, the status item and the sentence, once", withRig((g) => {
  g.guard.imported("a.example", 5);
  writeCookies(g.profile, ["other.example"]);
  g.guard.check();
  assert.deepEqual(g.logs, ["signin: check 2026-11-27T05:00:00Z: a.example 0 cookies (5 set at the import of 2026-11-27T05:00:00Z)"]);
  assert.deepEqual(g.guard.status(), { cookie_loss: [] }, "no warning: the file never held the domain's cookies");
  assert.deepEqual(g.guard.notes(), { agent: [], operator: [] });
  g.logs.length = 0;
  g.now.t += 60_000;
  writeCookies(g.profile, ["a.example", "www.a.example", ".a.example"]);
  g.guard.check();
  assert.deepEqual(g.logs, ["signin: check 2026-11-27T05:01:00Z: a.example 3 cookies"]);
  g.logs.length = 0;
  g.now.t += 60_000;
  writeCookies(g.profile, ["other.example"]);
  g.guard.check();
  assert.deepEqual(g.logs, [
    "signin: check 2026-11-27T05:02:00Z: a.example 0 cookies (5 set at the import of 2026-11-27T05:00:00Z)",
    "signin: WARNING 2026-11-27T05:02:00Z: the agent profile has no cookie of the sign-in for a.example any more (3 cookies at the last count, 5 set at the import of 2026-11-27T05:00:00Z); the operator sends that sign-in again",
  ]);
  const loss = { domain: "a.example", at: "2026-11-27T05:02:00Z", imported: "2026-11-27T05:00:00Z" };
  assert.deepEqual(g.guard.status(), { cookie_loss: [loss] });
  assert.deepEqual(g.guard.notes(), { agent: [], operator: [lossSentence(loss)] });
  assert.equal(lossSentence(loss), "The agent profile has no cookie of the sign-in for a.example any more (sent at 2026-11-27T05:00:00Z, found at 2026-11-27T05:02:00Z): send that sign-in again.");
  // A later count finds 0 again: no second warning; the item stays.
  g.logs.length = 0;
  g.now.t += 60_000;
  g.guard.check();
  assert.deepEqual(g.logs.filter((l) => l.includes("WARNING")), []);
  assert.deepEqual(g.guard.status(), { cookie_loss: [loss] });
}));

test("board ab-dbm: the item and the sentence outlive a restart of the service, and the next import of the domain clears them; another domain's item stays", withRig((g) => {
  g.guard.imported("a.example", 2);
  g.guard.imported("shop.example", 1);
  writeCookies(g.profile, ["a.example", "shop.example"]);
  g.guard.check();
  writeCookies(g.profile, []);
  g.now.t += 60_000;
  g.guard.check();
  assert.deepEqual(g.guard.status().cookie_loss, [
    { domain: "a.example", at: "2026-11-27T05:01:00Z", imported: "2026-11-27T05:00:00Z" },
    { domain: "shop.example", at: "2026-11-27T05:01:00Z", imported: "2026-11-27T05:00:00Z" },
  ]);
  const again = g.make();
  assert.deepEqual(again.status(), g.guard.status(), "the restart keeps the items");
  assert.equal(again.notes().operator.length, 2);
  g.now.t += 60_000;
  again.imported("a.example", 4);
  assert.deepEqual(again.status().cookie_loss, [{ domain: "shop.example", at: "2026-11-27T05:01:00Z", imported: "2026-11-27T05:00:00Z" }]);
  assert.deepEqual(again.notes().operator, [lossSentence({ domain: "shop.example", at: "2026-11-27T05:01:00Z", imported: "2026-11-27T05:00:00Z" })]);
}));

test("board ab-dbm: a check that cannot run (no cookie file, Chrome writing, an SQLite error, an error of the count) gives one plain line, no warning and no item, and keeps the baseline", withRig((g) => {
  g.guard.imported("a.example", 2);
  writeCookies(g.profile, ["a.example", "www.a.example"]);
  g.guard.check();
  const file = cookieFile(g.profile);
  const cases: [string, () => void, () => void][] = [
    ["no cookie file", () => rmSync(file), () => writeCookies(g.profile, ["a.example", "www.a.example"])],
    ["Chrome was writing the cookie file", () => writeFileSync(`${file}-journal`, "pages"), () => rmSync(`${file}-journal`)],
    ["SQLite cannot read the cookie file", () => writeFileSync(file, "garbage ".repeat(600)), () => writeCookies(g.profile, ["a.example", "www.a.example"])],
  ];
  for (const [what, before, after] of cases) {
    g.logs.length = 0;
    before();
    g.guard.check();
    assert.equal(g.logs.length, 1, `${what}: one line`);
    assert.match(g.logs[0], /^signin: check \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ: the cookies of the agent profile are not counted: .+; no warning from this check$/, what);
    assert.ok(g.logs[0].includes(what === "no cookie file" ? "the agent profile has no cookie file" : what), `${what}: ${g.logs[0]}`);
    assert.deepEqual(g.guard.status(), { cookie_loss: [] }, `${what}: no item`);
    assert.equal(g.guard.domains()[0].count, 2, `${what}: the baseline stays`);
    after();
  }
  // A count that throws (the guard's count seam) is a skip too: one line, no warning, no item.
  const thrown = g.make({ count: () => { throw Object.assign(new Error("no"), { code: "EIO" }); } });
  g.logs.length = 0;
  thrown.check();
  assert.deepEqual(g.logs, ["signin: check 2026-11-27T05:00:00Z: the cookies of the agent profile are not counted: the count failed (EIO); no warning from this check"]);
  assert.deepEqual(thrown.status(), { cookie_loss: [] });
  assert.equal(thrown.domains()[0].count, 2, "the baseline stays");
}));

// The review of ab-dbm, M1: the cap of the record never drops an entry with an open item of cookie_loss (C12: the item
// stays until the next import of that domain).
test("board ab-dbm (review M1): over MAX_DOMAINS the oldest entry with no open item goes, never one with an open item, and never the new import; when each older entry has an open item, each stays, also over a restart", () => {
  const counts = new Map<string, number>();
  const g = rig({ count: (_f, domains) => ({ ok: true, counts: new Map(domains.map((d) => [d, counts.get(d) ?? 0])) }) });
  try {
    assert.equal(MAX_DOMAINS, 200);
    const name = (i: number) => `d${i}.example`;
    for (let i = 0; i < MAX_DOMAINS; i++) { g.guard.imported(name(i), 1); counts.set(name(i), 1); g.now.t += 1000; }
    g.guard.check();
    // The oldest domain's cookies go: its open item.
    counts.set(name(0), 0);
    g.guard.check();
    assert.deepEqual(g.guard.losses().map((l) => l.domain), [name(0)]);
    // The 201st domain: the oldest entry with no open item (d1) goes, the item of d0 stays.
    g.guard.imported("new.example", 1);
    const kept = g.guard.domains().map((e) => e.domain);
    assert.equal(kept.length, MAX_DOMAINS);
    assert.ok(kept.includes(name(0)) && !kept.includes(name(1)) && kept.includes("new.example"), kept.slice(0, 3).join(" "));
    assert.deepEqual(g.guard.losses().map((l) => l.domain), [name(0)], "the item stays");
    assert.equal(g.guard.notes().operator.length, 1, "the sentence stays");
    // Each entry with an open item (new.example's first count above 0 is its baseline): a new import adds one more, and
    // none goes; a restart keeps each.
    counts.set("new.example", 1);
    g.guard.check();
    for (const d of kept) counts.set(d, 0);
    g.guard.check();
    assert.equal(g.guard.losses().length, MAX_DOMAINS);
    g.guard.imported("newer.example", 1);
    assert.equal(g.guard.domains().length, MAX_DOMAINS + 1);
    assert.equal(g.guard.losses().length, MAX_DOMAINS);
    assert.equal(g.make().domains().length, MAX_DOMAINS + 1, "the restart keeps each");
  } finally { g.done(); }
});

test("board ab-dbm: no cookie name or value in a log line, the record's file, the status or the sentences", withRig((g) => {
  g.guard.imported("a.example", 3);
  writeCookies(g.profile, ["a.example", "www.a.example", "shop.example"]);
  g.guard.check();
  writeCookies(g.profile, ["shop.example"]);
  g.guard.check();
  assert.ok(g.logs.some((l) => l.includes("WARNING")), "the drop happened");
  noSecret(g.logs.join("\n"), "the log");
  noSecret(readFileSync(join(g.state, COOKIE_RECORD), "utf8"), "the file");
  noSecret(JSON.stringify(g.guard.status()), "the status");
  noSecret(JSON.stringify(g.guard.notes()), "the sentences");
}));

test("board ab-dbm: one pending check at a time: several triggers in the wait give one check, a later trigger moves it, and an import that runs moves it again; with no recorded domain nothing is due", async () => {
  const calls: number[] = [];
  let busy = false;
  const count = () => { calls.push(Date.now()); return { ok: true as const, counts: new Map([["a.example", 1]]) }; };
  const g = rig({ delayMs: 400, count, busy: () => busy });
  try {
    g.guard.started();
    await sleep(600);
    assert.deepEqual(calls, [], "no domain: no check");
    g.guard.imported("a.example", 1);
    g.guard.started();
    g.guard.imported("a.example", 1);
    await until(() => calls.length === 1, "the check");
    await sleep(600);
    assert.equal(calls.length, 1, "one check for three triggers");
    // A trigger in the wait moves the pending check: none comes before the wait after the last trigger.
    const t0 = Date.now();
    g.guard.started();
    await sleep(200);
    g.guard.started();
    await until(() => calls.length === 2, "the moved check");
    assert.ok(calls[1] - t0 >= 590, `the check came ${calls[1] - t0} ms after the first trigger`);
    // An import that runs when the check is due moves it; its end lets it run.
    busy = true;
    g.guard.started();
    await sleep(900);
    assert.equal(calls.length, 2, "no check while an import runs");
    busy = false;
    await until(() => calls.length === 3, "the check after the import");
    assert.equal(CHECK_DELAY_MS, 60_000);
  } finally { g.done(); }
});

test("board ab-dbm: stage 1c gives the guard each import's domain and count of cookies set, after the receiver's answer, also for the sign-in act's move; a failed import records nothing", async () => {
  const dir = tempDir("ab-cookie-1c-");
  const seen: [string, number][] = [];
  let events!: ReceiverEvents;
  let mode: "ok" | "refuse" = "ok";
  const port: ReceiverPort = {
    attach: (e) => { events = e; }, isUp: () => true, allowlist() {}, endScope() {},
    request: async (op) => {
      if (op === "set_scopes") return { rules: 0, closed: 0, refused: 0 };
      if (mode === "refuse") throw new ReceiverError("refused", "not imported");
      return { cookies_removed: 0, cookies_set: 2, tabs_closed: 0, local: 0, session: 0, idb_databases: 0, idb_records: 0, cache_entries: 0, errors: [] };
    },
  };
  const part = new Stage1c({ listsFolder: join(dir, "lists"), stateFolder: join(dir, "state"), receiver: port, log: () => {}, imported: (d, n) => seen.push([d, n]) });
  try {
    void events;
    await part.setSessions({ t: "req", id: "s", op: "set_sessions", by: { kind: "daemon", user: "ann", via: "daemon" }, sessions: [], remote: [], box: { hosts: ["box.localhost"], cookie_names: [] } } as any);
    const payload = { v: 1, domain: "shop.example", url: "https://www.shop.example/", origin: "https://www.shop.example",
      cookies: [{ name: "sid", value: VALUE, domain: ".shop.example", hostOnly: false, path: "/", secure: true, httpOnly: true, sameSite: "lax", session: true }],
      storage: { local: {}, session: {}, idb: [], caches: [] } };
    await part.ops.import({ t: "req", id: "i", op: "import", by: { kind: "operator", user: "ann", via: "send" }, payload } as any);
    assert.deepEqual(seen, [["shop.example", 2]]);
    assert.equal(await part.moveSignIn(payload), true);
    assert.deepEqual(seen, [["shop.example", 2], ["shop.example", 2]], "the act's move");
    mode = "refuse";
    await part.ops.import({ t: "req", id: "j", op: "import", by: { kind: "operator", user: "ann", via: "send" }, payload } as any);
    assert.equal(seen.length, 2, "a failed import records nothing");
  } finally { part.stop(); rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ the service: after a ready and after an import

const ACTIVE: UnitState = { active: "active", sub: "running", mainPid: process.pid };
const HELLO = { t: "hello", v: 2, version: "0.3.6", channels: ["main", "bridge"], features: ["scopes"] };
const DAEMON = { kind: "daemon", user: "ann", via: "daemon" };
const TOKEN = { kind: "token", user: "ann", via: "cli" } as const;
const CONFIG = { t: "req", id: "cfg", op: "config", by: { kind: "daemon", user: "ann", via: "config" }, enabled: true, control: true, chrome_bin: "/usr/bin/chromium", chrome_args: [] };

/** A fake shim and agent package on the link socket: the bridge to the fake receiver; set_scopes and import answered here. */
function shimOn(path: string, set: () => number): Socket {
  const fr = new FakeReceiver();
  const s = connect(path);
  s.on("error", () => {});
  let buf = "";
  const open = new Map<string, Buffer[]>();
  s.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0;) {
      const p = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      const key = `${p.ch ?? "main"} ${p.id}`;
      const parts = open.get(key) ?? []; parts.push(Buffer.from(p.b64, "base64")); open.set(key, parts);
      if (parts.length < p.n) continue;
      open.delete(key);
      const q = JSON.parse(Buffer.concat(parts).toString("utf8"));
      if (p.ch === "bridge") { fr.output.write(`${JSON.stringify(q)}\n`); continue; }
      const data = q.op === "set_scopes" ? { rules: 1, closed: 0, refused: 0 } : { cookies_removed: 0, cookies_set: set(), tabs_closed: 0, local: 0, session: 0, idb_databases: 0, idb_records: 0, cache_entries: 0, errors: [] };
      s.write(`${JSON.stringify({ t: "res", id: q.id, ok: true, data })}\n`);
    }
  });
  fr.input.on("data", (d) => { if (!s.destroyed) s.write(d); });
  s.once("connect", () => s.write(`${JSON.stringify(HELLO)}\n`));
  return s;
}

test("board ab-dbm: the service counts the sent sign-ins' cookies in its own agent profile after an import and after each ready of the agent Chrome; status gives cookie_loss and the operator's sentence after a drop", { skip: process.platform !== "linux", timeout: 90_000 }, async () => {
  const w = new World();
  const tools = new FakeTools();
  const dir = tempDir("ab-cookie-svc-");
  const logs: string[] = [];
  const s = await startService({
    agentDoor: join(dir, "cdp.sock"), controlDoor: join(dir, "control.sock"), daemonCommand: join(dir, "daemon-command.json"), log: (l) => logs.push(l), mainPid: async () => null,
    lists: { listsFolder: join(dir, "lists"), stateFolder: w.paths.state },
    unit: { paths: w.paths, owner: async () => ACTIVE, tools, procs: w.procs, part: { unit: w.deps(tools), firstCheckMs: 3_600_000, usePollMs: 5 } },
    link: { socket: join(dir, "link.sock"), pidfds: { failed: "none" }, xdotool: null, peer: async () => ({ ok: true, pid: 4242 }) },
    cookieGuard: { delayMs: 50 },
  });
  const shims: Socket[] = [];
  // "Chrome" starts the host shim, which links (a new shim for each new fake Chrome).
  let pid = 0;
  const host = setInterval(() => {
    const c = w.named("chromium")[0];
    if (c && c.pid !== pid) { pid = c.pid; shims.at(-1)?.destroy(); shims.push(shimOn(join(dir, "link.sock"), () => 2)); }
  }, 5);
  const checks = () => logs.filter((l) => l.startsWith("signin: check "));
  try {
    assert.ok(s.cookies, "the guard runs with the unit, the link and the lists");
    await s.state.handle({ ...CONFIG } as any);
    await s.state.handle({ t: "req", id: "s", op: "set_sessions", by: DAEMON, sessions: [], remote: [], box: { hosts: ["box.localhost"], cookie_names: [] } } as any);
    writeCookies(w.paths.profile, ["shop.example", "www.shop.example"]);
    const payload = { v: 1, domain: "shop.example", url: "https://www.shop.example/", origin: "https://www.shop.example",
      cookies: [{ name: "sid", value: VALUE, domain: ".shop.example", hostOnly: false, path: "/", secure: true, httpOnly: true, sameSite: "lax", session: true }],
      storage: { local: {}, session: {}, idb: [], caches: [] } };
    // The operator's send starts Chrome (a use), waits for the receiver and imports; the guard records it, and its check comes.
    const a = await s.state.handle({ t: "req", id: "i", op: "import", by: { kind: "operator", user: "ann", via: "send" }, payload } as any) as any;
    assert.equal(a.data?.cookies_set, 2, JSON.stringify(a));
    const rec = JSON.parse(readFileSync(join(w.paths.state, COOKIE_RECORD), "utf8"));
    assert.deepEqual(rec.domains.map((e: any) => [e.domain, e.cookies_set]), [["shop.example", 2]]);
    assert.equal(statSync(join(w.paths.state, COOKIE_RECORD)).mode & 0o777, 0o600);
    await until(() => checks().length >= 1, "the check after the import");
    assert.match(checks()[0], /^signin: check \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ: shop\.example 2 cookies$/);
    // The cookies vanish while Chrome is down; the next start's ready makes the check due, which finds the drop.
    assert.deepEqual(await s.part!.stopBrowser(TOKEN), { data: {} });
    writeCookies(w.paths.profile, ["other.example"]);
    const n = checks().length;
    assert.deepEqual(await s.part!.startBrowser(TOKEN), { data: {} });
    await until(() => checks().length > n, "the check after the ready");
    assert.ok(checks().at(-1)!.endsWith(": shop.example 0 cookies (2 set at the import of " + rec.domains[0].imported + ")"), checks().at(-1) ?? "");
    assert.equal(logs.filter((l) => l.startsWith("signin: WARNING ")).length, 1);
    const st = s.state.status() as any;
    assert.equal(st.cookie_loss.length, 1);
    assert.equal(st.cookie_loss[0].domain, "shop.example");
    assert.match(st.cookie_loss[0].at, ISO);
    assert.ok(st.operator_text.includes(lossSentence(st.cookie_loss[0])), st.operator_text);
    assert.ok(!st.agent_text.includes("shop.example"), "no sentence in the agent's text");
    noSecret(logs.join("\n") + JSON.stringify(st) + readFileSync(join(w.paths.state, COOKIE_RECORD), "utf8"), "the service");
  } finally { clearInterval(host); for (const x of shims) x.destroy(); await s.stop(); rmSync(dir, { recursive: true, force: true }); w.close(); }
});

test("board ab-dbm: the Mac's service log gives each line its UTC time first (stampedLog)", () => {
  const lines: string[] = [];
  const log = stampedLog((l) => lines.push(l), () => Date.parse("2026-11-27T05:00:00.789Z"));
  log("service: ready (pid 1)");
  assert.deepEqual(lines, ["2026-11-27T05:00:00Z service: ready (pid 1)"]);
});
