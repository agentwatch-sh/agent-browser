// The fail-closed watch and the owner rule of the service's Chrome unit (the self-contained design, section 13.2 and
// build note 5 of section 13.5; board ab-v16.94.3). The watch runs with a fake link, a virtual clock and its count in a
// temp folder; the owner rule with a fake unit-state reader, and the systemd reader with a fake systemctl. No test reads
// the user's systemd or starts a unit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNING_STATES, Owner, ownership, SERVICE_UNIT, systemdUnitState, testOwner, type UnitState } from "../src/service/unit/owner.ts";
import { FailClosedWatch, NO_LINK, RECEIVER_MISSING_MS, type LinkPort, type WatchStop } from "../src/service/unit/watch.ts";

type W = { dir: string; now: number; chrome: { pid: number; start: number | null } | null; link: LinkPort & { r: boolean; c: boolean; b: boolean; s: boolean }; stops: WatchStop[]; sessions: boolean; boot: string; make: () => FailClosedWatch; close: () => void };
function world(): W {
  const dir = mkdtempSync(join(tmpdir(), "ab-watch-"));
  const w: W = {
    dir, now: 5_000_000, chrome: { pid: 4242, start: 777 }, stops: [], sessions: true, boot: "boot-1",
    link: { r: false, c: false, b: false, s: false, ready() { return this.r; }, confirmed() { return this.c; }, busy() { return this.b; }, scopesReady() { return this.s; } },
    make: () => new FailClosedWatch({
      file: join(dir, "watch.json"), bootId: () => w.boot, clock: () => w.now, link: w.link, sessionsComplete: () => w.sessions,
      chrome: () => w.chrome, stop: async (reason) => { w.stops.push(reason); w.chrome = null; return true; }, log: () => {},
    }),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
  return w;
}
async function run(w: W, watch: FailClosedWatch, ms: number, step = 1000) { for (let t = 0; t < ms; t += step) { w.now += step; await watch.tick(); } }

test("the watch stops a Chrome whose receiver confirmed nothing for 60 s, once, with receiver_missing; stage 1b part 1 has no link, so its Chrome stops 60 s after its first check", async () => {
  assert.equal(RECEIVER_MISSING_MS, 60_000);
  assert.deepEqual([NO_LINK.ready(), NO_LINK.confirmed(), NO_LINK.busy(), NO_LINK.scopesReady()], [false, false, false, false]);
  const w = world();
  try {
    const watch = w.make();
    await watch.tick();
    await run(w, watch, 59_000);
    assert.deepEqual(w.stops, [], "59 s: no stop");
    await run(w, watch, 1000);
    assert.deepEqual(w.stops, ["receiver_missing"]);
    await run(w, watch, 5000);
    assert.deepEqual(w.stops, ["receiver_missing"], "once");
  } finally { w.close(); }
});

test("a confirm on a linked receiver starts the count again; sessions_unread when a receiver takes set_scopes but no complete set_sessions came; the time of a request on a live link does not count", async () => {
  const w = world();
  try {
    const watch = w.make();
    await watch.tick();
    await run(w, watch, 50_000);
    w.link.r = true; w.link.c = true;
    await run(w, watch, 1000);
    w.link.c = false;
    await run(w, watch, 59_000);
    assert.deepEqual(w.stops, [], "counted from the confirm");
    w.link.b = true;
    await run(w, watch, 30_000);
    assert.deepEqual(w.stops, [], "busy: the time does not count");
    w.link.b = false; w.link.s = true; w.sessions = false;
    await run(w, watch, 1000);
    assert.deepEqual(w.stops, ["sessions_unread"]);
  } finally { w.close(); }
});

test("build note 5: the count is kept on disk for this Chrome (pid, start time, boot id); a new instance of the service goes on with it, and a new count comes for another Chrome, another start time or another boot", async () => {
  const w = world();
  try {
    const first = w.make();
    await first.tick();
    await run(w, first, 40_000);
    const disk = JSON.parse(readFileSync(join(w.dir, "watch.json"), "utf8"));
    assert.deepEqual({ ...disk, since: 0 }, { v: 1, boot: "boot-1", pid: 4242, start: 777, since: 0 });
    // A restart of the service: a new watch at the same Chrome goes on with the count.
    const second = w.make();
    await run(w, second, 20_000);
    assert.deepEqual(w.stops, ["receiver_missing"], "40 s + 20 s: the stop comes at 60 s, not 60 s after the restart");
    for (const [what, change] of [["another start time", () => { w.chrome = { pid: 4242, start: 778 }; }], ["another pid", () => { w.chrome = { pid: 4343, start: 777 }; }], ["another boot", () => { w.chrome = { pid: 4242, start: 777 }; w.boot = "boot-2"; }]] as const) {
      w.stops.length = 0;
      w.boot = "boot-1"; w.chrome = { pid: 4242, start: 777 };
      writeFileSync(join(w.dir, "watch.json"), JSON.stringify({ v: 1, boot: "boot-1", pid: 4242, start: 777, since: w.now - 50_000 }));
      change();
      const next = w.make();
      await next.tick();
      await run(w, next, 20_000);
      assert.deepEqual(w.stops, [], `${what}: a new count`);
    }
    // A count from the future (a clock that is not the same) is no count.
    w.chrome = { pid: 4242, start: 777 }; w.boot = "boot-1";
    writeFileSync(join(w.dir, "watch.json"), JSON.stringify({ v: 1, boot: "boot-1", pid: 4242, start: 777, since: w.now + 999_999 }));
    const fut = w.make();
    await fut.tick();
    await run(w, fut, 59_000);
    assert.deepEqual(w.stops, []);
  } finally { w.close(); }
});

test("the owner rule: the service owns only while its unit is active, activating or deactivating and its MainPID is this process; a read that fails is no ownership", () => {
  assert.deepEqual(OWNING_STATES, ["active", "activating", "deactivating"]);
  assert.equal(SERVICE_UNIT, "agent-browser.service");
  const s = (active: string, mainPid = 100, sub = "running"): UnitState => ({ active, sub, mainPid });
  for (const a of ["active", "activating", "deactivating"]) assert.deepEqual(ownership(s(a), 100), { owns: true }, a);
  assert.deepEqual(ownership(s("activating", 100, "auto-restart"), 100), { owns: true }, "between automatic restarts");
  for (const a of ["inactive", "failed", "reloading", "maintenance"]) assert.deepEqual(ownership(s(a), 100), { owns: false, why: `its own unit is ${a}` });
  assert.deepEqual(ownership(s("active", 101), 100), { owns: false, why: "it is not the MainPID of its own unit (101)" }, "a copy started by hand while the unit runs");
  assert.deepEqual(ownership(null, 100), { owns: false, why: "the state of its own unit cannot be read" });
});

test("Owner: each check reads the state; the first no is final, logged once, and resolves lost; --test owns with no unit", async () => {
  const states: (UnitState | null)[] = [{ active: "active", sub: "running", mainPid: 100 }, { active: "deactivating", sub: "stop-sigterm", mainPid: 100 }, { active: "inactive", sub: "dead", mainPid: 0 }, { active: "active", sub: "running", mainPid: 100 }];
  const logs: string[] = [];
  let reads = 0;
  const o = new Owner(async () => { reads++; return states.shift() ?? null; }, (l) => logs.push(l), 100);
  assert.equal(await o.check("a"), true);
  assert.equal(await o.check("b"), true);
  assert.equal(await o.check("a start"), false);
  assert.equal(await o.check("d"), false, "final");
  assert.equal(reads, 3, "no read after the no");
  assert.equal(await o.lost, "its own unit is inactive");
  assert.deepEqual(logs, ["owner: the service does not own the Chrome unit (its own unit is inactive), before a start; it stops its owner parts"]);
  const broken = new Owner(async () => { throw new Error("boom"); }, () => {}, 100);
  assert.equal(await broken.check("x"), false, "a reader that throws is no ownership");
  assert.deepEqual(await testOwner(4242)(), { active: "active", sub: "running", mainPid: 4242 });
});

test("the systemd reader: one systemctl --user show of the service's own unit (ActiveState, SubState, MainPID, LoadState); a unit that systemd does not know, a failed or slow call, or a bad answer is null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-sysctl-"));
  try {
    const fake = (out: string, code = 0, sleep = 0) => {
      const p = join(dir, `systemctl-${Math.random().toString(36).slice(2)}`);
      // A slow one is `exec sleep`, so the timeout's SIGKILL ends it and no process stays.
      writeFileSync(p, `#!/bin/sh\necho "$@" > ${p}.args\n${sleep ? `exec sleep ${sleep}\n` : ""}printf '%s' '${out}'\nexit ${code}\n`);
      chmodSync(p, 0o755);
      return p;
    };
    const ok = fake("ActiveState=activating\nSubState=auto-restart\nMainPID=0\nLoadState=loaded\n");
    assert.deepEqual(await systemdUnitState("agent-browser.service", { systemctl: ok })(), { active: "activating", sub: "auto-restart", mainPid: 0 });
    assert.equal(readFileSync(`${ok}.args`, "utf8").trim(), "--user show agent-browser.service --property=ActiveState,SubState,MainPID,LoadState");
    assert.equal(await systemdUnitState("x", { systemctl: fake("ActiveState=inactive\nSubState=dead\nMainPID=0\nLoadState=not-found\n") })(), null);
    assert.equal(await systemdUnitState("x", { systemctl: fake("ActiveState=active\n", 1) })(), null);
    assert.equal(await systemdUnitState("x", { systemctl: fake("ActiveState=active\nSubState=running\nMainPID=abc\n") })(), null);
    assert.equal(await systemdUnitState("x", { systemctl: fake("ActiveState=active\nSubState=running\nMainPID=1\n", 0, 3), timeoutMs: 300 })(), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
