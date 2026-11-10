// Google Chrome follows Google's stable channel (the self-contained design, sections 5.1 and 5.6; board ab-v16.94.3):
// the move rules (the idle hour, the clients, the 24 h limit that drops only the clients rule), the update's state
// file, the timed check, and a move with its probation and its way back. The unit runs on the fake world of
// test/fake-unit-world.ts with fake tools; nothing reads Google's index.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { ChromeUnit, DEFAULT_CONFIG } from "../src/service/unit/unit.ts";
import { ChromeMover, ChromeUpdater, CHECK_EVERY_MS, FIRST_CHECK_MS, FORCE_AFTER_MS, forcedMove, SEND_QUIET_MS, shouldMove, UPDATE_IDLE_MS, type Activity } from "../src/service/unit/updates.ts";
import { FakeTools, World } from "./fake-unit-world.ts";

const H = 3_600_000;
const idle = { inFlight: 0, idleFor: H, importing: false, clients: false, sinceSend: H, waitingFor: 0 };

test("the move rules: an older running copy and a newer ready one; no request in flight, the bridge idle an hour, no import, no send in the last hour, and no client; after 24 h only the clients rule goes", () => {
  assert.deepEqual([FIRST_CHECK_MS, CHECK_EVERY_MS, UPDATE_IDLE_MS, SEND_QUIET_MS, FORCE_AFTER_MS], [600_000, 43_200_000, H, H, 24 * H]);
  const [a, b] = ["157.0.7000.1-1", "158.0.7100.1-1"];
  assert.equal(shouldMove(a, b, idle), true);
  assert.equal(shouldMove(b, b, idle), false, "not newer");
  assert.equal(shouldMove(b, a, idle), false, "never a downgrade");
  assert.equal(shouldMove(null, b, idle), false, "no Google Chrome runs");
  for (const [k, v] of [["inFlight", 1], ["idleFor", H - 1], ["importing", true], ["sinceSend", H - 1], ["clients", true]] as const) assert.equal(shouldMove(a, b, { ...idle, [k]: v }), false, k);
  assert.equal(shouldMove(a, b, { ...idle, clients: true, waitingFor: 24 * H - 1 }), false, "a client holds it back for 24 h");
  assert.equal(shouldMove(a, b, { ...idle, clients: true, waitingFor: 24 * H }), true, "then the clients rule goes");
  for (const [k, v] of [["inFlight", 1], ["idleFor", H - 1], ["importing", true], ["sinceSend", 0]] as const) assert.equal(shouldMove(a, b, { ...idle, clients: true, waitingFor: 48 * H, [k]: v }), false, `${k} stays after 24 h`);
  assert.equal(forcedMove({ clients: true, waitingFor: 24 * H }), true);
  assert.equal(forcedMove({ clients: false, waitingFor: 48 * H }), false);
});

test("the update's state file: the last good copy, the failed versions (never started again), since when an update waits; it outlives a restart; a damaged file refuses nothing and is never written", () => {
  const w = new World();
  try {
    const mk = () => new ChromeUpdater({ tools: new FakeTools(), file: w.paths.updateFile, wanted: () => true, log: (l) => w.logs.push(l) });
    const u = mk();
    u.noteGood("157.0.7000.1-1");
    u.noteFailed("158.0.7100.1-1", "no receiver confirmed the lists in 60 s");
    u.noteWait(1234.5);
    const again = mk();
    assert.equal(again.lastGood(), "157.0.7000.1-1");
    assert.deepEqual([...again.refused()], ["158.0.7100.1-1"]);
    assert.equal(again.waitSince(), 1234.5);
    assert.equal(again.failedText(), "Google Chrome 158.0.7100.1-1 did not start: no receiver confirmed the lists in 60 s");
    again.noteGood("159.0.7200.1-1");
    assert.deepEqual([...mk().refused()], [], "a newer good copy ends the failed records");
    writeFileSync(w.paths.updateFile, "{damaged");
    const broken = mk();
    assert.deepEqual([...broken.refused()], []);
    broken.noteFailed("160.0.1.1-1", "x");
    broken.noteGood("160.0.1.1-1");
    assert.equal(readFileSync(w.paths.updateFile, "utf8"), "{damaged", "never written over");
    assert.match(broken.stateProblem(), /cannot be read/);
  } finally { w.close(); }
});

test("the timed check: none while the browser is off, chrome_bin is set, the box is unsupported or no copy is installed; else it reads the index, installs a newer release (never one not newer than a failed move's), keeps the newest ready, and prunes", async () => {
  const w = new World();
  try {
    const tools = new FakeTools();
    tools.autoInstall = true;
    let wanted = false;
    const u = new ChromeUpdater({ tools, file: w.paths.updateFile, wanted: () => wanted, log: (l) => w.logs.push(l) });
    assert.equal(await u.checkOnce(), null);
    wanted = true;
    assert.equal(await u.checkOnce(), null, "no copy: a box that never ran the agent browser never reads the index");
    assert.deepEqual(tools.calls, []);
    tools.versions = ["157.0.7000.1-1"];
    tools.why = "gpgv is not installed";
    assert.equal(await u.checkOnce(), null);
    tools.why = null;
    assert.equal(await u.checkOnce(), "158.0.7100.1-1");
    assert.deepEqual(tools.calls, ["latest", "ensure 158.0.7100.1-1"]);
    assert.equal(u.readyVersion(), "158.0.7100.1-1");
    assert.deepEqual([...tools.pruned.at(-1)!].sort(), ["157.0.7000.1-1", "158.0.7100.1-1"]);
    u.noteFailed("159.0.7200.1-1", "x");
    tools.entry = { ...tools.entry, version: "159.0.7200.1-1" };
    tools.calls.length = 0;
    await u.checkOnce();
    assert.deepEqual(tools.calls, ["latest"], "a release not newer than the failed move's is never installed");
    tools.latestEntry = async () => { throw new Error("Google's Chrome index could not be downloaded: x"); };
    assert.equal(await u.checkOnce(), null);
    assert.match(u.error(), /could not be downloaded/);
  } finally { w.close(); }
});

/** A unit that runs Google Chrome 157 with 158 ready, a link that the test confirms, and the mover. */
async function moving(o: Partial<Activity> = {}) {
  const w = new World();
  const tools = new FakeTools();
  tools.versions = ["157.0.7000.1-1"];
  for (const v of ["157.0.7000.1-1", "158.0.7100.1-1"]) w.programs[tools.copy(v).binary] = tools.copy(v).binary;
  const updater = new ChromeUpdater({ tools, file: w.paths.updateFile, wanted: () => true, log: (l) => w.logs.push(l) });
  const unit = new ChromeUnit(w.deps(tools, { displays: { first: 173, last: 175 }, refused: () => updater.refused() }));
  unit.config = DEFAULT_CONFIG;
  await unit.start();
  updater.noteGood("157.0.7000.1-1");
  const act: Activity = { inFlight: () => 0, idleFor: () => Infinity, importing: () => false, clients: () => false, sinceSend: () => Infinity, ...o };
  const asked: string[] = [];
  const mover = new ChromeMover({ unit, updater, activity: act, clock: () => w.now, wall: () => 1_762_750_000_000 + w.now, mayAct: async (x) => { asked.push(x); return true; }, log: (l) => w.logs.push(l) });
  tools.versions.push("158.0.7100.1-1");
  (updater as any).ready = "158.0.7100.1-1";
  return { w, tools, updater, unit, mover, asked };
}
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };

test("a move waits for the idle hour from the service's start and for the clients to leave, then restarts Chrome on the new copy (the owner rule first); its confirm makes it the last good copy and prunes", async () => {
  let clients = true;
  const { w, unit, mover, updater, tools, asked } = await moving({ clients: () => clients });
  try {
    mover.tick(true);
    assert.equal(mover.moving, false, "the idle hour counts from the service's start");
    w.now += H;
    mover.tick(true);
    assert.equal(mover.moving, false, "a client holds the move back");
    assert.equal(mover.updateState(), "waiting");
    clients = false;
    mover.tick(true);
    assert.equal(mover.moving, true);
    await settle();
    while (mover.moving) await settle();
    assert.deepEqual(asked, ["a Chrome move"]);
    assert.equal(unit.chromeFacts()!.version, "158.0.7100.1-1");
    assert.equal(mover.updateState(), "moving", "on probation");
    mover.tick(true);
    assert.equal(updater.lastGood(), "158.0.7100.1-1");
    assert.equal(mover.updateState(), "current");
    assert.deepEqual([...tools.pruned.at(-1)!].sort(), ["157.0.7000.1-1", "158.0.7100.1-1"]);
  } finally { w.close(); }
});

test("a client that stays: the move comes after the update waited 24 h (kept in the state file across a restart)", async () => {
  const { w, unit, mover: first, updater } = await moving({ clients: () => true });
  try {
    w.now += H;
    first.tick(true);
    assert.equal(first.moving, false);
    assert.equal(typeof updater.waitSince(), "number", "the wait is on disk");
    // A restart of the service after 12 h: a new mover reads the wait from the state file.
    w.now += 12 * H;
    const mover = new ChromeMover({ unit, updater, activity: { inFlight: () => 0, idleFor: () => Infinity, importing: () => false, clients: () => true, sinceSend: () => Infinity }, clock: () => w.now, wall: () => 1_762_750_000_000 + w.now, mayAct: async () => true, log: (l) => w.logs.push(l) });
    mover.tick(true);
    assert.equal(mover.moving, false);
    w.now += 12 * H - 1;
    mover.tick(true);
    assert.equal(mover.moving, false, "1 ms short of 24 h");
    w.now += 1;
    mover.tick(true);
    assert.equal(mover.moving, true, "24 h since the wait began, before the restart: only the clients rule goes");
    while (mover.moving) await settle();
    assert.equal(unit.chromeFacts()!.version, "158.0.7100.1-1");
    assert.ok(w.logs.some((l) => /moves now although an agent holds a connection/.test(l)));
  } finally { w.close(); }
});

test("a move whose new Chrome gets no confirm in 60 s takes the way back: the version is noted, never started again, and the last good copy starts exactly", async () => {
  const { w, unit, mover, updater } = await moving();
  try {
    w.now += H;
    mover.tick(true);
    while (mover.moving) await settle();
    assert.equal(unit.chromeFacts()!.version, "158.0.7100.1-1");
    w.now += 60_000;
    mover.tick(false);
    await settle();
    while ((mover as any).reverting) await settle();
    assert.deepEqual([...updater.refused()], ["158.0.7100.1-1"]);
    assert.equal(unit.chromeFacts()!.version, "157.0.7000.1-1");
    assert.equal(mover.updateState(), "failed");
    await unit.stop();
    await unit.start();
    assert.equal(unit.chromeFacts()!.version, "157.0.7000.1-1", "never started again");
  } finally { w.close(); }
});

test("no move without a confirm, with chrome_bin set, with the browser off, or while a request runs", async () => {
  for (const [what, set] of [["no confirm", null], ["chrome_bin", (u: ChromeUnit) => { u.config = { ...DEFAULT_CONFIG, chromeBin: "/usr/bin/chromium" }; }], ["off", (u: ChromeUnit) => { u.config = { ...DEFAULT_CONFIG, enabled: false }; }]] as const) {
    const { w, unit, mover } = await moving();
    try {
      w.now += H;
      set?.(unit);
      mover.tick(set !== null);
      assert.equal(mover.moving, false, what);
    } finally { w.close(); }
  }
  const { w, mover } = await moving({ inFlight: () => 1 });
  try { w.now += H; mover.tick(true); assert.equal(mover.moving, false, "in flight"); } finally { w.close(); }
});
