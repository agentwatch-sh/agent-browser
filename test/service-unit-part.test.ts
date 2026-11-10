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
import { DAEMON_HELLO, daemonClient, sleep, type DaemonClient } from "./fake-daemon.ts";
import { FakeTools, World } from "./fake-unit-world.ts";

const control = JSON.parse(readFileSync(new URL("./vectors/control.json", import.meta.url), "utf8"));
const TOKEN = { kind: "token", user: "ann", via: "cli" };
const WEB = { kind: "operator", user: "ann", via: "web" };
const DAEMON = { kind: "daemon", user: "ann", via: "daemon" };
const CONFIG = { t: "req", id: "cfg", op: "config", by: { kind: "daemon", user: "ann", via: "config" }, enabled: true, control: true, chrome_bin: "/usr/bin/chromium", chrome_args: [] };
const ACTIVE: UnitState = { active: "active", sub: "running", mainPid: process.pid };

type Rig = { w: World; part: UnitPart; door: ControlDoor; logs: string[]; owns: { yes: boolean }; c: DaemonClient; close: () => Promise<void> };
async function rig(o: { begin?: boolean; watchLimitMs?: number; before?: (w: World, tools: FakeTools) => void } = {}): Promise<Rig> {
  const w = new World();
  const tools = new FakeTools();
  o.before?.(w, tools);
  const logs: string[] = [];
  const owns = { yes: true };
  let handler!: Stage1a;
  const part = new UnitPart({
    paths: w.paths, procs: w.procs, tools, log: (l) => logs.push(l),
    owner: new Owner(async () => (owns.yes ? ACTIVE : { ...ACTIVE, active: "inactive" }), (l) => logs.push(l)),
    endpoint: () => ({ form: "pidfd" }), sessionsComplete: () => handler.sessionsComplete,
    unit: { ...w.deps(tools, { displays: { first: 173, last: 175 } }) },
    clock: () => w.now, wall: () => Date.UTC(2026, 10, 10, 12, 0, 0) + w.now - 1_000_000,
    superviseMs: 10, watchMs: 5, watchLimitMs: o.watchLimitMs ?? 3_600_000, firstCheckMs: 3_600_000,
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
    await c.next((l) => l.t === "ev" && l.ev === "ready", 10_000);
    assert.equal(r.w.named("chromium").length, 1);
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
