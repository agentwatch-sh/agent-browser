// The Chrome unit inside the service, through the control door (contract C12; the self-contained design, sections 5.6
// and 13.2; board ab-v16.94.3): the ops start and stop with their provenance and the stop's `by`, the events ready,
// chrome and stopped, Chrome's facts in status, an answer that comes after a half-close, config's enabled false, the
// start of a wanted Chrome at the first config (build note 8), the watch's fail-closed stop, the supervisor through the
// part, and the owner rule at the service's start and during its run. The unit runs on the fake world of
// test/fake-unit-world.ts; the door admits each connection here (test/service-admission.test.ts checks the admission).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as require_fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlDoor } from "../src/service/control.ts";
import { NotOwnerAtStart, Stage1a, startService } from "../src/service/service.ts";
import { Owner, type UnitState } from "../src/service/unit/owner.ts";
import { NOT_OWNER, STATE_TEXTS, UnitPart } from "../src/service/unit/part.ts";
import { writeJsonDurable } from "../src/service/unit/record.ts";
import { CHECK_EVERY_MS, FIRST_CHECK_MS } from "../src/service/unit/updates.ts";
import { DAEMON_HELLO, daemonClient, sleep, type DaemonClient } from "./fake-daemon.ts";
import { FakeTools, World } from "./fake-unit-world.ts";

const control = JSON.parse(readFileSync(new URL("./vectors/control.json", import.meta.url), "utf8"));
const TOKEN = { kind: "token", user: "ann", via: "cli" };
const WEB = { kind: "operator", user: "ann", via: "web" };
const DAEMON = { kind: "daemon", user: "ann", via: "daemon" };
const CONFIG = { t: "req", id: "cfg", op: "config", by: { kind: "daemon", user: "ann", via: "config" }, enabled: true, control: true, chrome_bin: "/usr/bin/chromium", chrome_args: [] };
const ACTIVE: UnitState = { active: "active", sub: "running", mainPid: process.pid };

type Rig = { w: World; part: UnitPart; door: ControlDoor; logs: string[]; owns: { yes: boolean; hook?: () => Promise<void> }; c: DaemonClient; close: () => Promise<void> };
async function rig(o: { begin?: boolean; watchLimitMs?: number; before?: (w: World, tools: FakeTools) => void; linkDown?: () => void } = {}): Promise<Rig> {
  const w = new World();
  const tools = new FakeTools();
  o.before?.(w, tools);
  const logs: string[] = [];
  const owns: Rig["owns"] = { yes: true };
  let handler!: Stage1a;
  const part = new UnitPart({
    paths: w.paths, procs: w.procs, tools, log: (l) => logs.push(l),
    owner: new Owner(async () => { await owns.hook?.(); return owns.yes ? ACTIVE : { ...ACTIVE, active: "inactive" }; }, (l) => logs.push(l)),
    endpoint: () => ({ form: "pidfd" }), sessionsComplete: () => handler.sessionsComplete,
    unit: { ...w.deps(tools, { displays: { first: 173, last: 175 } }) },
    clock: () => w.now, wall: () => Date.UTC(2026, 10, 10, 12, 0, 0) + w.now - 1_000_000,
    superviseMs: 10, watchMs: 5, watchLimitMs: o.watchLimitMs ?? 3_600_000, firstCheckMs: 3_600_000,
    ...(o.linkDown ? { linkDown: o.linkDown } : {}),
  });
  handler = new Stage1a({ agentDoor: { url: (s) => `ws+unix:///x/cdp.sock:/devtools/browser/${s}`, state: () => ({ form: "pidfd" }) }, parts: [part] });
  const dir = mkdtempSync(join(tmpdir(), "ab-part-"));
  const door = await ControlDoor.open({ path: join(dir, "control.sock"), admit: async () => ({ ok: true }), handler, log: (l) => logs.push(l) });
  if (o.begin !== false) await part.begin();
  const c = await daemonClient(door.path);
  await c.next();
  c.send(DAEMON_HELLO);
  return { w, part, door, logs, owns, c, close: async () => { c.end(); await part.stop(); await door.stop(); rmSync(dir, { recursive: true, force: true }); w.close(); } };
}
const req = (c: DaemonClient, id: string, op: string, by: object, fields: object = {}) => { c.send({ t: "req", id, op, by, ...fields }); return c.answer(id, 10_000); };
const status = async (c: DaemonClient, id: string) => (await req(c, id, "status", DAEMON)).data;
const events = (c: DaemonClient) => c.lines.filter((l) => l.t === "ev");

test("start and stop through the control door: the answer after Chrome runs or is gone; ready, chrome and stopped (with the stop's by) events; Chrome's facts and last_stop in status; each act logged with its provenance", async () => {
  const r = await rig();
  try {
    const { c } = r;
    c.send(CONFIG);
    await c.answer("cfg");
    const off = await status(c, "s0");
    assert.deepEqual([off.state, off.agent_text, off.operator_text], ["off", STATE_TEXTS.off.agent_text, STATE_TEXTS.off.operator_text]);
    assert.deepEqual([off.chrome_kind, off.chrome_version, off.chrome_pid, off.extension_version, off.update, off.last_stop], [null, null, null, null, null, null]);
    assert.deepEqual(await req(c, "a", "start", TOKEN), { t: "res", id: "a", ok: true, data: {} });
    const chrome = r.w.named("chromium")[0];
    assert.deepEqual(events(c), [
      { t: "ev", ev: "ready", chrome_pid: chrome.pid, chrome_version: null, extension_version: null, endpoint: { form: "pidfd" } },
      { t: "ev", ev: "chrome", version: null, update: null },
    ]);
    const on = await status(c, "s1");
    assert.deepEqual([on.state, on.agent_text, on.chrome_kind, on.chrome_pid, on.update], ["ready", STATE_TEXTS.ready.agent_text, "chromium", chrome.pid, null]);
    assert.deepEqual(await req(c, "b", "stop", WEB), { t: "res", id: "b", ok: true, data: {} });
    assert.equal(r.w.alive(chrome.pid), false);
    assert.deepEqual(events(c).at(-1), { t: "ev", ev: "stopped", reason: "stop", by: WEB });
    const after = await status(c, "s2");
    assert.equal(after.state, "off");
    assert.deepEqual(after.last_stop, { reason: "stop", at: after.last_stop.at, by: WEB });
    assert.match(after.last_stop.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.ok(r.logs.includes("control: start by token ann via cli: ok"), r.logs.join("\n"));
    assert.ok(r.logs.includes("control: stop by operator ann via web: ok"));
    // A stop with nothing running: no event.
    const n = events(c).length;
    await req(c, "c", "stop", TOKEN);
    assert.equal(events(c).length, n);
    // The kinds: a start or a stop by the daemon itself is a bad request (C12).
    assert.deepEqual(await req(c, "d", "start", DAEMON), { t: "res", id: "d", ok: false, error: "bad request" });
    for (const s of Object.values(STATE_TEXTS)) assert.doesNotMatch(s.agent_text, /\b(stop|start|restart)/i, "I2");
  } finally { await r.close(); }
});

test("a requested stop is a stop, not a crash: after the stop op, or a stop through the part's own stopBrowser (the later use rule, board ab-v16.94.11), neither the supervisor nor the watch starts or stops anything", async () => {
  const r = await rig({ watchLimitMs: 60_000 });
  try {
    const { c } = r;
    c.send(CONFIG); await c.answer("cfg");
    for (const how of ["op", "function"] as const) {
      if (how === "op") await req(c, `a-${how}`, "start", TOKEN);
      else assert.deepEqual(await r.part.startBrowser(null), { data: {} });
      const pid = r.w.named("chromium")[0].pid;
      await c.next((l) => l.t === "ev" && l.ev === "ready" && l.chrome_pid === pid, 10_000);
      const stops = events(c).filter((l) => l.ev === "stopped").length;
      if (how === "op") await req(c, `b-${how}`, "stop", WEB);
      else assert.deepEqual(await r.part.stopBrowser(null), { data: {} });
      while (events(c).filter((l) => l.ev === "stopped").length === stops) await sleep(5);
      assert.equal(r.w.alive(pid), false);
      const spawned = r.w.spawned.length, evs = events(c).length;
      await sleep(200); // twenty checks of the supervisor and forty of the watch
      r.w.now += 61_000;
      await sleep(100);
      assert.equal(r.w.spawned.length, spawned, `${how}: no restart after a requested stop`);
      assert.equal(events(c).length, evs, `${how}: no event after the stop's own`);
      assert.equal(r.part.watch.missingFor(), null, `${how}: the watch counts no Chrome`);
      assert.equal((await status(c, `s-${how}`)).state, "off");
    }
    assert.deepEqual(events(c).filter((l) => l.ev === "stopped"), [{ t: "ev", ev: "stopped", reason: "stop", by: WEB }, { t: "ev", ev: "stopped", reason: "stop" }], "the function's stop has no by");
  } finally { await r.close(); }
});

test("a start that fails answers its reason; a start or a stop while the service does not own answers that it does not own, and starts nothing", async () => {
  const r = await rig();
  try {
    const { c } = r;
    assert.match((await req(c, "a", "start", TOKEN)).error, /no config yet/);
    c.send({ ...CONFIG, id: "cfg2", chrome_args: ["--remote-debugging-port=9222"] });
    await c.answer("cfg2");
    const bad = await req(c, "b", "start", TOKEN);
    assert.match(bad.error, /refusing to launch Chrome with --remote-debugging-port/);
    assert.ok(!bad.error.includes("9222"));
    c.send({ ...CONFIG, id: "cfg3" });
    await c.answer("cfg3");
    r.owns.yes = false;
    assert.deepEqual(await req(c, "c", "start", TOKEN), { t: "res", id: "c", ok: false, error: NOT_OWNER });
    // Google Chrome with no copy: a start of a service that does not own never begins an install.
    c.send({ ...CONFIG, id: "cfg4", chrome_bin: null }); await c.answer("cfg4");
    assert.deepEqual(await req(c, "c2", "start", TOKEN), { t: "res", id: "c2", ok: false, error: NOT_OWNER });
    assert.deepEqual((r.part as any).o.tools.calls, [], "no install");
    assert.deepEqual(await req(c, "d", "stop", TOKEN), { t: "res", id: "d", ok: false, error: NOT_OWNER });
    assert.equal(r.w.spawned.length, 0);
  } finally { await r.close(); }
});

test("an op that answers later answers before the close: a daemon that half-closes after its start still gets the answer, then the door closes", async () => {
  const r = await rig();
  try {
    r.c.send(CONFIG);
    await r.c.answer("cfg");
    r.c.send({ t: "req", id: "late", op: "start", by: TOKEN });
    r.c.socket.end(); // a half-close: the daemon writes no more
    const a = await r.c.answer("late", 10_000);
    assert.deepEqual(a, { t: "res", id: "late", ok: true, data: {} });
    await r.c.closed;
    assert.ok(r.logs.some((l) => /connection \d+ closed: the end of the stream/.test(l)));
  } finally { await r.close(); }
});

/** A rig whose unit's stop, link drop and `stopped` write their order into `seq`; `fail` makes the unit's stop throw after it ran. */
async function stopRig(): Promise<{ r: Rig; part: any; seq: string[]; fail: { on: boolean }; until: (f: () => boolean, what: string) => Promise<void>; start: (id: string) => Promise<void> }> {
  const seq: string[] = [];
  const fail = { on: false };
  const r = await rig({ linkDown: () => { seq.push("link down"); } });
  const part = r.part as any;
  const unitStop = part.unit.stop.bind(part.unit);
  part.unit.stop = async () => {
    const ran = await unitStop();
    seq.push("unit stop");
    if (fail.on) throw new Error("a test's failed read of /proc");
    return ran;
  };
  const stopped = part.stopped.bind(part);
  part.stopped = (reason: string, ...rest: unknown[]) => { seq.push(`stopped ${reason}`); stopped(reason, ...rest); };
  const until = async (f: () => boolean, what: string) => { for (let i = 0; i < 400 && !f(); i++) await sleep(5); assert.ok(f(), what); };
  const start = async (id: string) => {
    assert.deepEqual(await req(r.c, id, "start", TOKEN), { t: "res", id, ok: true, data: {} });
    assert.equal(r.w.named("chromium").length, 1);
    seq.length = 0;
  };
  r.c.send(CONFIG); await r.c.answer("cfg");
  return { r, part, seq, fail, until, start };
}

test("board ab-b84.34 N2: each stop of Chrome that leaves it off (the stop op, the fail-closed watch's, enabled false, the stop by use) drops the stopped Chrome's link after the unit's stop and before its stopped", async () => {
  const { r, part, seq, until, start } = await stopRig();
  try {
    const { c } = r;
    // The stop op.
    await start("a");
    assert.deepEqual(await req(c, "b", "stop", WEB), { t: "res", id: "b", ok: true, data: {} });
    assert.deepEqual(seq, ["unit stop", "link down", "stopped stop"], "the stop op");
    // The fail-closed watch's stop.
    await start("c");
    assert.equal(await part.failClosed("sessions_unread"), true);
    assert.deepEqual(seq, ["unit stop", "link down", "stopped sessions_unread"], "the fail-closed watch's stop");
    // enabled false (no event).
    await start("d");
    c.send({ ...CONFIG, id: "off", enabled: false }); await c.answer("off");
    await until(() => seq.length === 2, "the stop of a browser that is turned off");
    assert.deepEqual(seq, ["unit stop", "link down"], "enabled false");
    c.send({ ...CONFIG, id: "on" }); await c.answer("on");
    // The stop by use (board ab-b84.33): the same order.
    await start("e");
    part.idleMinutes = 0;
    await until(() => seq.length === 3, "the stop by use");
    assert.deepEqual(seq, ["unit stop", "link down", "stopped idle"], "the stop by use");
    part.idleMinutes = 10;
  } finally { await r.close(); }
});

test("board ab-b84.34 N1: a unit's stop that fails (the stop by use, the stop op) drops the stopped Chrome's link all the same, and sends no stopped", async () => {
  const { r, part, seq, fail, until, start } = await stopRig();
  try {
    // The stop by use: its failure is logged.
    await start("a");
    fail.on = true;
    part.idleMinutes = 0;
    await until(() => r.logs.includes("unit: the stop of an unused browser failed: Error"), "the failed stop by use");
    assert.deepEqual(seq, ["unit stop", "link down"], "a failed stop by use drops the link too");
    part.idleMinutes = 10;
    fail.on = false;
    // The stop op: its answer is an error.
    await start("b");
    fail.on = true;
    const failed = await req(r.c, "c", "stop", WEB);
    assert.equal(failed.ok, false, JSON.stringify(failed));
    assert.deepEqual(seq, ["unit stop", "link down"], "a failed stop op drops the link too");
    fail.on = false;
  } finally { await r.close(); }
});

test("config with enabled false stops a running Chrome (no event: it is not a fault)", async () => {
  const r = await rig();
  try {
    const { c } = r;
    c.send(CONFIG); await c.answer("cfg");
    await req(c, "a", "start", TOKEN);
    const n = events(c).length;
    c.send({ ...CONFIG, id: "off", enabled: false }); await c.answer("off");
    for (let i = 0; i < 200 && r.w.named("chromium").length; i++) await sleep(5);
    assert.equal(r.w.named("chromium").length, 0);
    assert.equal(events(c).length, n, "no event");
    assert.equal((await status(c, "s")).state, "off");
  } finally { await r.close(); }
});

test("build note 8: at the service's start a record that wants the browser and whose Chrome is gone waits for the first config, then starts it (state starting until then); a record with wanted false starts nothing", async () => {
  const r = await rig({ before: (w) => { writeJsonDurable(w.paths.unitFile, { wanted: true, display: 173, xvfb_pid: 99999, chrome_pid: 99998, chrome: { kind: "chromium", version: "" }, chrome_bin: "/usr/bin/chromium" }); } });
  try {
    const { c } = r;
    assert.equal((await status(c, "s0")).state, "starting");
    await sleep(100); // ten checks of the supervisor
    assert.equal(r.w.spawned.length, 0, "nothing before the config");
    assert.deepEqual(events(c), [], "no start_failed before the config");
    c.send(CONFIG); await c.answer("cfg");
    const ready = await c.next((l) => l.t === "ev" && l.ev === "ready", 10_000);
    assert.equal(r.w.named("chromium").length, 1);
    assert.equal(ready.chrome_pid, r.w.named("chromium")[0].pid, "ready names the new Chrome's pid");
  } finally { await r.close(); }
  // Google Chrome with no copy yet: the start at the first config installs it (a restart by the supervisor never installs).
  const r3 = await rig({ before: (w, tools) => {
    tools.autoInstall = true;
    w.programs[tools.copy(tools.entry.version).binary] = tools.copy(tools.entry.version).binary;
    writeJsonDurable(w.paths.unitFile, { wanted: true, display: 173, xvfb_pid: 99999, chrome_pid: 99998, chrome: { kind: "google-chrome", version: "157.0.7000.1-1" } });
  } });
  try {
    r3.c.send({ ...CONFIG, chrome_bin: null }); await r3.c.answer("cfg");
    const ready = await r3.c.next((l) => l.t === "ev" && l.ev === "ready", 10_000);
    assert.equal(ready.chrome_version, "158.0.7100.1-1", "the installed copy");
  } finally { await r3.close(); }
  const r2 = await rig({ before: (w) => { writeJsonDurable(w.paths.unitFile, { wanted: false, display: 173, xvfb_pid: 99999, chrome_pid: 99998 }); } });
  try {
    r2.c.send(CONFIG); await r2.c.answer("cfg");
    await sleep(50);
    assert.equal(r2.w.spawned.length, 0);
    assert.equal((await status(r2.c, "s")).state, "off");
  } finally { await r2.close(); }
});

// ------------------------------------------------------------------ review-106 B1: a config before the service's start ends

const WANTED_GONE = (w: World) => { writeJsonDurable(w.paths.unitFile, { wanted: true, display: 173, xvfb_pid: 99999, chrome_pid: 99998, chrome: { kind: "chromium", version: "" }, chrome_bin: "/usr/bin/chromium" }); };
/** A live Xvfb and Chrome of the unit, and the record that names them (an adoption takes them). */
function adoptable(w: World): { x: number; ch: number } {
  const x = w.add({ argv: ["/usr/bin/Xvfb", ":173", "-nolisten", "tcp", "-auth", w.paths.xauth, "-screen", "0", "1280x900x24"] });
  const ch = w.add({ argv: ["/usr/bin/chromium", `--user-data-dir=${w.paths.profile}`, "about:blank"] });
  writeJsonDurable(w.paths.unitFile, { wanted: true, display: 173, display_size: [1280, 900], xvfb_pid: x.pid, xvfb_start: x.start, chrome_pid: ch.pid, chrome_start: ch.start, chrome: { kind: "chromium", version: "" }, chrome_bin: "/usr/bin/chromium" });
  return { x: x.pid, ch: ch.pid };
}

test("review-106 B1: a config that comes before the service's start ends: a wanted record whose Chrome is gone starts Chrome at once in begin, with one ready for its pid; after the watch's fail-closed stop no later config starts Chrome (only a start op does), and the state stays failed closed", async () => {
  const r = await rig({ begin: false, watchLimitMs: 60_000, before: WANTED_GONE });
  try {
    const { c } = r;
    c.send(CONFIG); await c.answer("cfg");
    assert.equal(r.w.spawned.length, 0, "nothing before the start of the part");
    await r.part.begin();
    const chrome = r.w.named("chromium");
    assert.equal(chrome.length, 1, "Chrome runs when begin ends: it waits for no later config and no supervisor's restart");
    const ready = await c.next((l) => l.t === "ev" && l.ev === "ready", 10_000);
    assert.equal(ready.chrome_pid, chrome[0].pid);
    assert.equal((await status(c, "s1")).state, "ready");
    // The fail-closed watch stops it (stage 1b part 1 has no receiver).
    while (r.part.watch.missingFor() === null) await sleep(2);
    r.w.now += 60_000;
    assert.deepEqual(await c.next((l) => l.t === "ev" && l.ev === "stopped", 10_000), { t: "ev", ev: "stopped", reason: "receiver_missing" });
    assert.equal((await status(c, "s2")).state, "failed closed");
    // The daemon sends config at each connect and at each change: none starts Chrome again.
    for (const id of ["cfg2", "cfg3"]) { c.send({ ...CONFIG, id }); await c.answer(id); }
    await sleep(100); // ten checks of the supervisor
    assert.equal(r.w.named("chromium").length, 0, "no start without a start op");
    assert.equal((await status(c, "s3")).state, "failed closed");
    assert.deepEqual(events(c).filter((l) => l.ev === "ready").map((l) => l.chrome_pid), [chrome[0].pid], "one ready for the pid");
    assert.deepEqual(await req(c, "a", "start", TOKEN), { t: "res", id: "a", ok: true, data: {} });
    assert.equal(r.w.named("chromium").length, 1, "a start op starts it again");
  } finally { await r.close(); }
});

test("review-106b F1: a stop that comes while the start of a wanted Chrome waits for its owner check wins: no Chrome starts, the record says wanted false, and a later config starts nothing", async () => {
  const r = await rig({ begin: false, before: WANTED_GONE });
  try {
    const { c } = r;
    c.send(CONFIG); await c.answer("cfg");
    // The next owner check waits until the test lets it go; every later one passes at once.
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    let armed = true;
    r.owns.hook = async () => { if (armed) { armed = false; await gate; } };
    const begun = r.part.begin();
    for (let i = 0; i < 200 && armed; i++) await sleep(2);
    assert.equal(armed, false, "the start of the wanted Chrome waits in its owner check");
    assert.deepEqual(await req(c, "b", "stop", TOKEN), { t: "res", id: "b", ok: true, data: {} });
    release();
    await begun;
    await sleep(50);
    assert.equal(r.w.named("chromium").length, 0, "the stop wins: no Chrome starts");
    assert.equal(JSON.parse(readFileSync(r.w.paths.unitFile, "utf8")).wanted, false, "the record says wanted false");
    c.send({ ...CONFIG, id: "cfg2" }); await c.answer("cfg2");
    await sleep(50);
    assert.equal(r.w.named("chromium").length, 0, "and a later config starts nothing");
  } finally { await r.close(); }
});

test("review-106b F1: a stop that comes during the start's sweep of a Chrome that no record names (one that holds out against SIGTERM) wins: begin starts no Chrome, and the record says wanted false", async () => {
  let orphan = 0;
  const r = await rig({ begin: false, before: (w) => { WANTED_GONE(w); orphan = w.add({ argv: ["/usr/bin/chromium", `--user-data-dir=${w.paths.profile}`, "about:blank"], stubborn: true }).pid; } });
  try {
    const { c } = r;
    c.send(CONFIG); await c.answer("cfg");
    const begun = r.part.begin();
    for (let i = 0; i < 500 && !r.w.signals.some(([p, s]) => p === orphan && s === "SIGTERM"); i++) await sleep(2);
    assert.ok(r.w.signals.some(([p, s]) => p === orphan && s === "SIGTERM"), "the sweep asks the orphan to stop");
    c.send({ t: "req", id: "b", op: "stop", by: TOKEN });
    await sleep(30); // the stop passes its owner check and waits for the sweep's lock
    r.w.now += 10_000; // the orphan's grace ends: the sweep kills it and lets the lock go
    await begun;
    assert.deepEqual(await c.answer("b", 10_000), { t: "res", id: "b", ok: true, data: {} });
    await sleep(50);
    assert.equal(r.w.named("chromium").length, 0, "the stop wins: begin starts no Chrome");
    assert.equal(JSON.parse(readFileSync(r.w.paths.unitFile, "utf8")).wanted, false, "the record says wanted false");
  } finally { await r.close(); }
});

test("review-106b F1: with no config yet, a stop during the start's sweep leaves no start waiting: the state is off, and the first config starts nothing", async () => {
  let orphan = 0;
  const r = await rig({ begin: false, before: (w) => { WANTED_GONE(w); orphan = w.add({ argv: ["/usr/bin/chromium", `--user-data-dir=${w.paths.profile}`, "about:blank"], stubborn: true }).pid; } });
  try {
    const { c } = r;
    const begun = r.part.begin();
    for (let i = 0; i < 500 && !r.w.signals.some(([p, s]) => p === orphan && s === "SIGTERM"); i++) await sleep(2);
    c.send({ t: "req", id: "b", op: "stop", by: TOKEN });
    await sleep(30);
    r.w.now += 10_000;
    await begun;
    assert.deepEqual(await c.answer("b", 10_000), { t: "res", id: "b", ok: true, data: {} });
    assert.equal((await status(c, "s1")).state, "off", "no start waits for the config");
    c.send(CONFIG); await c.answer("cfg");
    await sleep(50);
    assert.equal(r.w.named("chromium").length, 0, "the first config starts nothing");
  } finally { await r.close(); }
});

test("review-106 B1: a config with enabled false that comes before the service's start ends applies at the start: the adopted Chrome and its Xvfb stop, and a wanted record whose Chrome is gone starts nothing; no event, the record says wanted false, the state is off", async () => {
  let pids = { x: 0, ch: 0 };
  const r = await rig({ begin: false, before: (w) => { pids = adoptable(w); } });
  try {
    const { c } = r;
    c.send({ ...CONFIG, enabled: false }); await c.answer("cfg");
    await r.part.begin();
    assert.equal(r.w.alive(pids.ch), false, "the adopted Chrome stops");
    assert.equal(r.w.alive(pids.x), false, "and its Xvfb");
    assert.equal(JSON.parse(readFileSync(r.w.paths.unitFile, "utf8")).wanted, false);
    await sleep(100); // ten checks of the supervisor
    assert.equal(r.w.spawned.length, 0);
    assert.deepEqual(events(c), [], "no ready and no stopped: turning it off is not a fault");
    assert.equal((await status(c, "s")).state, "off");
  } finally { await r.close(); }
  const r2 = await rig({ begin: false, before: WANTED_GONE });
  try {
    const { c } = r2;
    c.send({ ...CONFIG, enabled: false }); await c.answer("cfg");
    await r2.part.begin();
    await sleep(100); // ten checks of the supervisor
    assert.equal(r2.w.spawned.length, 0, "nothing starts");
    assert.deepEqual(events(c), [], "no start_failed");
    assert.equal((await status(c, "s")).state, "off");
    assert.equal(JSON.parse(readFileSync(r2.w.paths.unitFile, "utf8")).wanted, false);
  } finally { await r2.close(); }
});

test("one ready for each Chrome pid: a start op that comes while the supervisor's restart runs sends no second ready for the restarted Chrome", async () => {
  const r = await rig();
  try {
    const { c } = r;
    c.send(CONFIG); await c.answer("cfg");
    await req(c, "a", "start", TOKEN);
    const first = r.w.named("chromium")[0];
    // The supervisor's restart holds the unit's lock; its owner check right before the spawn takes 200 ms here, and
    // the start op comes then (before the restarted Chrome runs).
    let held = false;
    r.owns.hook = async () => { if (!held && r.part.unit.locked) { held = true; await sleep(200); } };
    r.w.end(first.pid);
    while (!held) await new Promise((res) => setImmediate(res));
    assert.equal(r.w.named("chromium").length, 0, "the restart has not spawned yet");
    assert.deepEqual(await r.part.startBrowser(TOKEN as any), { data: {} });
    const second = r.w.named("chromium");
    assert.equal(second.length, 1);
    await sleep(50);
    assert.deepEqual(events(c).filter((l) => l.ev === "ready").map((l) => l.chrome_pid), [first.pid, second[0].pid], "one ready for each pid");
  } finally { await r.close(); }
});

test("a pendingStart flag never outlives a start or a fail-closed stop (the second guard of review-106 B1; the test sets the flag by hand, since no path sets it while Chrome runs)", async () => {
  const r = await rig({ watchLimitMs: 60_000 });
  try {
    const { c } = r;
    c.send(CONFIG); await c.answer("cfg");
    await req(c, "a", "start", TOKEN);
    const first = r.w.named("chromium")[0];
    (r.part as any).pendingStart = true;
    r.w.end(first.pid);
    await c.next((l) => l.t === "ev" && l.ev === "ready" && l.chrome_pid !== first.pid, 10_000);
    assert.equal((r.part as any).pendingStart, false, "a start that succeeds clears it");
    (r.part as any).pendingStart = true;
    while (r.part.watch.missingFor() === null) await sleep(2);
    r.w.now += 60_000;
    await c.next((l) => l.t === "ev" && l.ev === "stopped", 10_000);
    assert.equal((await status(c, "s")).state, "failed closed", "the fail-closed stop clears it");
    c.send({ ...CONFIG, id: "cfg2" }); await c.answer("cfg2");
    await sleep(50);
    assert.equal(r.w.named("chromium").length, 0, "and no config starts Chrome then");
  } finally { await r.close(); }
});

test("the Chrome update check of the part: the first 10 min after the start, then every 12 h (FIRST_CHECK_MS and CHECK_EVERY_MS are its defaults); review-106 B2: once the owner rule says no, the timed check calls neither latestEntry nor ensure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = new World();
  const owns = { yes: true };
  const tools = new FakeTools();
  tools.versions = ["157.0.7000.1-1"];
  tools.autoInstall = true;
  const part = new UnitPart({
    paths: w.paths, procs: w.procs, tools, log: () => {},
    owner: new Owner(async () => (owns.yes ? ACTIVE : { ...ACTIVE, active: "inactive" }), () => {}),
    endpoint: () => ({ form: "pidfd" }), sessionsComplete: () => true, unit: w.deps(tools),
    superviseMs: 100 * 3_600_000, watchMs: 100 * 3_600_000,
  });
  const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((res) => setImmediate(res)); };
  const after = async (ms: number) => { t.mock.timers.tick(ms); await flush(); };
  const checks = () => tools.calls.filter((x) => x === "latest").length;
  try {
    part.onConfig({ enabled: true, chrome_bin: null, chrome_args: [] });
    await part.begin();
    await after(FIRST_CHECK_MS - 1);
    assert.equal(checks(), 0, "none before 10 min");
    await after(1);
    assert.equal(checks(), 1, "the first at 10 min");
    await after(CHECK_EVERY_MS - 1);
    assert.equal(checks(), 1, "none before 12 h more");
    await after(1);
    assert.equal(checks(), 2, "then every 12 h");
    owns.yes = false;
    const calls = tools.calls.length;
    await after(CHECK_EVERY_MS);
    await after(CHECK_EVERY_MS);
    assert.deepEqual(tools.calls.slice(calls), [], "a service that does not own reads no index and installs nothing");
  } finally { await part.stop(); w.close(); }
});

test("the watch through the part: with no receiver (stage 1b part 1) Chrome stops after the limit, with one stopped event receiver_missing, the state failed closed and last_stop with no by", async () => {
  const r = await rig({ watchLimitMs: 60_000 });
  try {
    const { c } = r;
    c.send(CONFIG); await c.answer("cfg");
    await req(c, "a", "start", TOKEN);
    // The first check of the watch that sees this Chrome starts its count.
    while (r.part.watch.missingFor() === null) await sleep(2);
    r.w.now += 59_000;
    await sleep(30);
    assert.equal(events(c).some((l) => l.ev === "stopped"), false, "59 s: no stop");
    r.w.now += 1_000;
    const ev = await c.next((l) => l.t === "ev" && l.ev === "stopped", 10_000);
    assert.deepEqual(ev, { t: "ev", ev: "stopped", reason: "receiver_missing" });
    const s = await status(c, "s");
    assert.deepEqual([s.state, s.agent_text, s.last_stop.reason, s.last_stop.by], ["failed closed", STATE_TEXTS["failed closed"].agent_text, "receiver_missing", null]);
    assert.equal(r.w.named("chromium").length, 0);
    assert.ok(r.logs.some((l) => /with no receiver that confirmed the lists; stopping it/.test(l)));
  } finally { await r.close(); }
});

test("the boot sweep at the service's start: a Chrome on the profile that no record names is stopped; with a unit record that cannot be read, no Chrome is stopped", async () => {
  let orphan = 0;
  const r = await rig({ before: (w) => { orphan = w.add({ argv: ["/usr/bin/chromium", `--user-data-dir=${w.paths.profile}`] }).pid; } });
  try {
    assert.equal(r.w.alive(orphan), false);
    assert.deepEqual(r.w.signals, [[orphan, "SIGTERM"]]);
  } finally { await r.close(); }
  const pids: number[] = [];
  const r2 = await rig({ before: (w) => {
    require_fs.writeFileSync(w.paths.unitFile, "{not json");
    for (let i = 0; i < 2; i++) pids.push(w.add({ argv: ["/usr/bin/chromium", `--user-data-dir=${w.paths.profile}`] }).pid);
  } });
  try {
    assert.deepEqual(r2.w.signals, [], "no sweep on a record that cannot be read");
    for (const p of pids) assert.ok(r2.w.alive(p));
  } finally { await r2.close(); }
});

test("the watch asks the owner rule right before its stop: a service that no longer owns never stops Chrome", async () => {
  const r = await rig({ watchLimitMs: 60_000 });
  try {
    const { c } = r;
    c.send(CONFIG); await c.answer("cfg");
    await req(c, "a", "start", TOKEN);
    while (r.part.watch.missingFor() === null) await sleep(2);
    r.owns.yes = false;
    r.w.now += 61_000;
    await sleep(100);
    assert.equal(events(c).some((l) => l.ev === "stopped"), false);
    assert.equal(r.w.named("chromium").length, 1, "Chrome stays");
  } finally { await r.close(); }
});

test("the supervisor through the part: a Chrome that crashed starts again and sends ready; when the owner rule says no at its tick, the part stops its loops and lost resolves, and Chrome stays", async () => {
  const r = await rig();
  try {
    const { c } = r;
    c.send(CONFIG); await c.answer("cfg");
    await req(c, "a", "start", TOKEN);
    const first = r.w.named("chromium")[0];
    r.w.end(first.pid);
    const ready = await c.next((l) => l.t === "ev" && l.ev === "ready" && l.chrome_pid !== first.pid, 10_000);
    const second = r.w.named("chromium")[0];
    assert.equal(ready.chrome_pid, second.pid);
    r.owns.yes = false;
    const owner = (r.part as any).o.owner as Owner;
    assert.equal(await Promise.race([owner.lost, sleep(5000).then(() => "no")]), "its own unit is inactive");
    await r.part.stop();
    assert.ok(r.w.alive(second.pid), "Chrome stays for the next owner");
  } finally { await r.close(); }
});

test("the owner rule at the service's start: a service whose own unit is not active opens its control door first, then closes it and exits (NotOwnerAtStart), with no agent door; one that owns opens both and begins the unit", { timeout: 30_000 }, async () => {
  const w = new World();
  const dir = mkdtempSync(join(tmpdir(), "ab-own-"));
  try {
    const sock = join(dir, "control.sock"), cdp = join(dir, "cdp.sock");
    const logs: string[] = [];
    const base = { agentDoor: cdp, controlDoor: sock, daemonCommand: join(dir, "daemon-command.json"), log: (l: string) => logs.push(l), mainPid: async () => null };
    const unit = (state: UnitState | null) => ({ paths: w.paths, owner: async () => state, tools: new FakeTools(), procs: w.procs, part: { unit: w.deps(new FakeTools()), firstCheckMs: 3_600_000 } });
    await assert.rejects(startService({ ...base, unit: unit({ ...ACTIVE, active: "inactive" }) }), (e: Error) => e instanceof NotOwnerAtStart && /its own unit is inactive/.test(e.message));
    assert.ok(logs.includes(`control: ready on ${sock}`), "the control door opened first");
    assert.equal(existsSync(sock), false, "and closed");
    assert.equal(existsSync(cdp), false, "no agent door");
    await assert.rejects(startService({ ...base, unit: unit({ ...ACTIVE, mainPid: process.pid + 1 }) }), NotOwnerAtStart);
    const s = await startService({ ...base, unit: unit(ACTIVE) });
    try {
      assert.ok(existsSync(sock) && existsSync(cdp));
      assert.ok(s.part);
      assert.ok(logs.some((l) => /service: ready \(pid \d+; the Chrome unit runs\)/.test(l)));
      assert.ok(w.logs.includes("unit: no unit record; nothing adopted"), "the unit's adoption ran (its log is the world's here)");
    } finally { await s.stop(); }
    assert.equal(existsSync(sock) || existsSync(cdp), false);
  } finally { rmSync(dir, { recursive: true, force: true }); w.close(); }
});

test("the vectors' start and stops get the vectors' answers from the real service part", async () => {
  const r = await rig();
  try {
    const { c } = r;
    c.send(CONFIG); await c.answer("cfg");
    for (const id of ["r11", "r12", "r13", "b4", "b17"]) {
      const v = [...control.requests, ...control.badRequests].find((x: any) => x.req.id === id);
      c.send(v.req);
      assert.deepEqual(await c.answer(id, 10_000), v.res, v.note);
    }
  } finally { await r.close(); }
});

test("with stage 1c's part beside it, status gives the Chrome unit's state and texts, then each part's sentences in the two texts", async () => {
  const w = new World();
  try {
    const tools = new FakeTools();
    const unit = new UnitPart({
      paths: w.paths, procs: w.procs, tools, log: () => {}, owner: new Owner(async () => ACTIVE, () => {}),
      endpoint: () => ({ form: "pidfd" }), sessionsComplete: () => true, unit: w.deps(tools), firstCheckMs: 3_600_000,
    });
    const other = { ops: {}, status: () => ({ lists: ["a.b"] }), notes: () => ({ agent: ["The lists are on their way."], operator: ["One list cannot be read."] }) };
    const s = new Stage1a({ agentDoor: { url: (x) => x, state: () => ({ form: "pidfd" }) }, parts: [other, unit] }).status();
    assert.equal(s.state, "off");
    assert.equal(s.agent_text, `${STATE_TEXTS.off.agent_text} The lists are on their way.`);
    assert.equal(s.operator_text, `${STATE_TEXTS.off.operator_text} One list cannot be read.`);
    assert.deepEqual(s.lists, ["a.b"]);
  } finally { w.close(); }
});
