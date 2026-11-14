// The start and the stop by use (board ab-v16.94.11; the operator's answer Q5 on board item ab-1n8; the self-contained
// design, sections 5.1, 5.6 and 19; C12 and C11): Chrome and Xvfb start at the first use and stop when no agent used the
// browser for the grace time, while the service's doors run at all times. The Chrome unit runs on the fake world of
// test/fake-unit-world.ts (no real Xvfb or Chrome); the use signal is the test's own where the rule is the part's, and the
// service's real one where the wiring is tested. The endpoint's and the MCP path's waits run on their real servers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CDPConnection } from "../src/cdp.ts";
import { NOT_READY } from "../src/relay/model.ts";
import { sessionRefusal } from "../src/relay/peer.ts";
import { ControlDoor } from "../src/service/control.ts";
import { MCP_TEXT, type McpReadiness } from "../src/service/mcp/admission.ts";
import { McpPort, type McpHandler } from "../src/service/mcp/port.ts";
import type { McpReader, TcpLine } from "../src/service/mcp/proc.ts";
import { Stage1a, startService } from "../src/service/service.ts";
import { Stage1c } from "../src/service/stage1c.ts";
import { Owner, type UnitState } from "../src/service/unit/owner.ts";
import * as Part from "../src/service/unit/part.ts";
import type { ReceiverPort } from "../src/service/receiver.ts";
import { DAEMON_HELLO, daemonClient, sleep, type DaemonClient } from "./fake-daemon.ts";
import { FakeReceiver, harness, lineOf, raw, until } from "./fake-bridge.ts";
import { FakeTools, World } from "./fake-unit-world.ts";

const TOKEN = { kind: "token", user: "ann", via: "cli" };
const DAEMON = { kind: "daemon", user: "ann", via: "daemon" };
const CONFIG = { t: "req", id: "cfg", op: "config", by: { kind: "daemon", user: "ann", via: "config" }, enabled: true, control: true, chrome_bin: "/usr/bin/chromium", chrome_args: [] };
const ACTIVE: UnitState = { active: "active", sub: "running", mainPid: process.pid };
const MIN = 60_000;
const control = JSON.parse(readFileSync(new URL("./vectors/control.json", import.meta.url), "utf8"));
// The part's names by a namespace (so each test fails on its own where a name is missing).
const { STATE_TEXTS, UnitPart } = Part;
const P = Part as Record<string, any>;
const IDLE_STOP_DEFAULT_MINUTES: number = P.IDLE_STOP_DEFAULT_MINUTES, IDLE_STOP_MAX_MINUTES: number = P.IDLE_STOP_MAX_MINUTES, USE_RETRY_MS: number = P.USE_RETRY_MS, USE_WAIT_MS: number = P.USE_WAIT_MS;
const useFailed = (reason: string): string => P.useFailed(reason);
const idleStopMinutes = (v: unknown): number | null => P.idleStopMinutes(v);
const GOOGLE = { ...CONFIG, chrome_bin: null };

// ------------------------------------------------------------------ the part's rig: the fake world, a use signal of the test

type Use = { now: string[]; lastRequest: number | null };
type Rig = { w: World; part: Part.UnitPart; tools: FakeTools; door: ControlDoor; logs: string[]; owns: { yes: boolean }; use: Use; c: DaemonClient; close: () => Promise<void> };
async function rig(o: { before?: (w: World, tools: FakeTools) => void; watchLimitMs?: number; useWaitMs?: number; sleep?: (w: World, ms: number) => Promise<void> } = {}): Promise<Rig> {
  const w = new World();
  const tools = new FakeTools();
  o.before?.(w, tools);
  const logs: string[] = [];
  const owns = { yes: true };
  const use: Use = { now: [], lastRequest: null };
  let handler!: Stage1a;
  const part = new UnitPart({
    paths: w.paths, procs: w.procs, tools, log: (l) => logs.push(l),
    owner: new Owner(async () => (owns.yes ? ACTIVE : { ...ACTIVE, active: "inactive" }), (l) => logs.push(l)),
    endpoint: () => ({ form: "pidfd" }), sessionsComplete: () => handler.sessionsComplete,
    unit: { ...w.deps(tools, { displays: { first: 173, last: 175 }, ...(o.sleep ? { sleep: (ms: number) => o.sleep!(w, ms) } : {}) }) },
    clock: () => w.now, wall: () => Date.UTC(2026, 10, 11, 12, 0, 0) + w.now - 1_000_000,
    superviseMs: 10, watchMs: 5, watchLimitMs: o.watchLimitMs ?? 100 * 3_600_000, firstCheckMs: 100 * 3_600_000,
    use: { now: () => [...use.now], quietFor: () => (use.lastRequest === null ? Infinity : w.now - use.lastRequest) },
    usePollMs: 2, useWaitMs: o.useWaitMs,
  });
  handler = new Stage1a({ agentDoor: { url: (s) => `ws+unix:///x/cdp.sock:/devtools/browser/${s}`, state: () => ({ form: "pidfd" }) }, parts: [part] });
  const dir = mkdtempSync(join(tmpdir(), "ab-use-"));
  const door = await ControlDoor.open({ path: join(dir, "control.sock"), admit: async () => ({ ok: true }), handler, log: (l) => logs.push(l) });
  await part.begin();
  const c = await daemonClient(door.path);
  await c.next();
  c.send(DAEMON_HELLO);
  return { w, part, tools, door, logs, owns, use, c, close: async () => { c.end(); await part.stop(); await door.stop(); rmSync(dir, { recursive: true, force: true }); w.close(); } };
}
let n = 0;
const req = (c: DaemonClient, op: string, by: object, fields: object = {}) => { const id = `q${++n}`; c.send({ t: "req", id, op, by, ...fields }); return c.answer(id, 10_000); };
const status = async (c: DaemonClient) => (await req(c, "status", DAEMON)).data;
const events = (c: DaemonClient, ev?: string) => c.lines.filter((l) => l.t === "ev" && (ev === undefined || l.ev === ev));
const config = async (r: Rig, fields: object = {}) => { r.c.send({ ...CONFIG, id: `cfg${++n}`, ...fields }); await r.c.answer(`cfg${n}`); };
/** Some checks of the watch (its loop runs every 5 ms of real time). */
const ticks = () => sleep(40);
const running = (r: Rig) => () => r.part.unit.running();

// ------------------------------------------------------------------ rule 1: the start at a use

test("no start with no use: with a config and time passing, no Chrome and no Xvfb start, and the state stays off", async () => {
  const r = await rig();
  try {
    await config(r);
    r.w.now += 30 * MIN;
    await ticks();
    assert.equal(r.w.spawned.length, 0, "nothing started");
    const s = await status(r.c);
    assert.deepEqual([s.state, s.agent_text, s.operator_text, s.chrome_pid], ["off", STATE_TEXTS.off.agent_text, STATE_TEXTS.off.operator_text, null]);
    assert.deepEqual(events(r.c), []);
    // I2: no agent's text names a stop or a start.
    for (const t of Object.values(STATE_TEXTS)) assert.doesNotMatch(t.agent_text, /\b(stop|start|restart)/i);
    assert.match(STATE_TEXTS.off.operator_text, /starts at the next use/);
  } finally { await r.close(); }
});

test("the start at the first use: a request that needs the browser starts Chrome and Xvfb, the state is starting from its first moment, ready goes out with Chrome's pid, and the request goes on when its check says ready", async () => {
  const r = await rig();
  try {
    await config(r);
    const woke = r.part.wake(running(r));
    assert.equal(r.part.state(), "starting", "starting from the first moment");
    assert.equal(await woke, null, "the request goes on");
    const chrome = r.w.named("chromium");
    assert.equal(chrome.length, 1);
    assert.equal(r.w.named("Xvfb").length, 1);
    const ready = await r.c.next((l) => l.ev === "ready");
    assert.equal(ready.chrome_pid, chrome[0].pid, "ready carries the new Chrome's pid");
    const s = await status(r.c);
    assert.deepEqual([s.state, s.chrome_pid], ["ready", chrome[0].pid]);
    assert.ok(r.logs.includes("unit: an agent uses the agent browser; starting Chrome"));
    // A request whose check is not ready waits while Chrome runs, at most USE_WAIT_MS, then goes on (its caller answers).
    let ok = false;
    const waits = r.part.wake(() => ok);
    await sleep(20);
    assert.deepEqual(r.part.usedBy(), ["waiting"], "a waiting request is a use");
    ok = true;
    assert.equal(await waits, null);
    assert.deepEqual(r.part.usedBy(), []);
    assert.equal(USE_WAIT_MS, 60_000);
  } finally { await r.close(); }
});

test("one start for many waiting requests: five requests at once start one Chrome and one Xvfb, with one ready event", async () => {
  const r = await rig();
  try {
    await config(r);
    const all = await Promise.all([0, 1, 2, 3, 4].map(() => r.part.wake(running(r))));
    assert.deepEqual(all, [null, null, null, null, null]);
    assert.equal(r.w.named("chromium").length, 1);
    assert.equal(r.w.spawned.filter((p) => p.argv[0].endsWith("Xvfb")).length, 1, "one Xvfb");
    assert.equal(r.w.spawned.filter((p) => p.argv[0].endsWith("chromium")).length, 1, "one Chrome");
    await sleep(20);
    assert.equal(events(r.c, "ready").length, 1);
    assert.equal(r.logs.filter((l) => l === "unit: an agent uses the agent browser; starting Chrome").length, 1);
  } finally { await r.close(); }
});

test("a use starts nothing with no config yet, or with enabled false; the request goes on at once", async () => {
  const r = await rig();
  try {
    assert.equal(await r.part.wake(running(r)), null);
    await config(r, { enabled: false });
    assert.equal(await r.part.wake(running(r)), null);
    assert.equal(r.w.spawned.length, 0);
    assert.deepEqual(events(r.c), []);
  } finally { await r.close(); }
});

// ------------------------------------------------------------------ rule 2: the stop by use

test("the stop by use: after the grace time with no use, Chrome and Xvfb stop, the profile stays, the record says wanted false, stopped goes out with the reason idle and no by, and last_stop carries it; not one second before", async () => {
  const r = await rig();
  try {
    await config(r);
    await r.part.wake(running(r));
    const chrome = r.w.named("chromium")[0], xvfb = r.w.named("Xvfb")[0];
    r.w.now += IDLE_STOP_DEFAULT_MINUTES * MIN - 1000;
    await ticks();
    assert.equal(events(r.c, "stopped").length, 0, "no stop before the grace time");
    assert.ok(r.w.alive(chrome.pid));
    r.w.now += 1000;
    const st = await r.c.next((l) => l.ev === "stopped");
    assert.deepEqual(st, { t: "ev", ev: "stopped", reason: "idle" });
    assert.equal(r.w.alive(chrome.pid), false);
    assert.equal(r.w.alive(xvfb.pid), false);
    assert.ok(existsSync(r.w.paths.profile), "the profile stays on disk");
    assert.equal(JSON.parse(readFileSync(r.w.paths.unitFile, "utf8")).wanted, false);
    const s = await status(r.c);
    assert.deepEqual([s.state, s.last_stop.reason, s.last_stop.by, s.agent_text], ["off", "idle", null, STATE_TEXTS.off.agent_text]);
    assert.ok(r.logs.includes("unit: no agent used the agent browser for 10 min; stopping Chrome and Xvfb (the profile stays)"));
  } finally { await r.close(); }
});

test("the grace time counts from each start of Chrome: a start op after a long time with no Chrome is not stopped at once", async () => {
  const r = await rig();
  try {
    await config(r);
    r.w.now += 60 * MIN;
    await ticks();
    assert.deepEqual(await req(r.c, "start", TOKEN), { t: "res", id: `q${n}`, ok: true, data: {} });
    await ticks();
    r.w.now += 10 * MIN - 1000;
    await ticks();
    assert.equal(events(r.c, "stopped").length, 0, "no stop before the grace time after the start");
    r.w.now += 1000;
    await r.c.next((l) => l.ev === "stopped" && l.reason === "idle");
  } finally { await r.close(); }
});

test("no stop while a client is connected or a request or a send runs; the grace time counts from the last use, also from a request between two checks", async () => {
  const r = await rig();
  try {
    await config(r);
    await r.part.wake(running(r));
    for (const source of ["client", "request", "send", "mcp"]) {
      r.use.now = [source];
      r.w.now += 30 * MIN;
      await ticks();
      assert.equal(events(r.c, "stopped").length, 0, `no stop while a ${source} uses the browser`);
      assert.deepEqual(r.part.usedBy(), [source]);
    }
    r.use.now = [];
    r.w.now += 9 * MIN;
    await ticks();
    assert.equal(events(r.c, "stopped").length, 0, "the grace time counts from the last use");
    // A request that came and went between two checks (the time since the last request or send).
    r.use.lastRequest = r.w.now;
    r.w.now += 9 * MIN;
    await ticks();
    assert.equal(events(r.c, "stopped").length, 0, "the grace time counts from the last request");
    r.w.now += MIN;
    await r.c.next((l) => l.ev === "stopped" && l.reason === "idle");
  } finally { await r.close(); }
});

test("a request during the stop by use waits for the stop's end, then starts Chrome again (one stop, then one start with a new pid)", async () => {
  const r = await rig();
  try {
    await config(r);
    await r.part.wake(running(r));
    const first = r.w.named("chromium")[0];
    // The stop holds until the test lets it go on, so a request comes while it runs.
    const stop = r.part.unit.stop.bind(r.part.unit);
    let go!: () => void;
    const held = new Promise<void>((x) => { go = x; });
    r.part.unit.stop = async () => { await held; return stop(); };
    r.w.now += 10 * MIN;
    await until(() => r.part.idleStopping, "the stop by use to run");
    const woke = r.part.wake(running(r));
    await sleep(20);
    assert.equal(r.w.named("chromium")[0].pid, first.pid, "the request waits while the stop runs");
    assert.deepEqual(r.part.usedBy(), ["waiting"]);
    assert.equal(r.part.state(), "starting", "the state reads starting while a request waits for the stop's end (review-120 note 6)");
    go();
    assert.equal(await woke, null);
    assert.equal(r.part.idleStopping, false);
    const second = r.w.named("chromium");
    assert.equal(second.length, 1);
    assert.notEqual(second[0].pid, first.pid, "a new Chrome");
    assert.equal(r.w.alive(first.pid), false);
    await r.c.next((l) => l.ev === "ready" && l.chrome_pid === second[0].pid);
    const evs = events(r.c).filter((l) => l.ev === "stopped" || l.ev === "ready").map((l) => `${l.ev} ${l.reason ?? l.chrome_pid}`);
    assert.deepEqual(evs, [`ready ${first.pid}`, "stopped idle", `ready ${second[0].pid}`]);
  } finally { await r.close(); }
});

test("the grace time: status gives it (default 10 min); config's idle_stop_minutes sets it (a whole number from 1 to 1440, else 10, with a log line); the stop comes after it", async () => {
  const r = await rig();
  try {
    assert.equal((await status(r.c)).idle_stop_minutes, 10);
    await config(r, { idle_stop_minutes: 3 });
    assert.equal((await status(r.c)).idle_stop_minutes, 3);
    await r.part.wake(running(r));
    r.w.now += 3 * MIN - 1000;
    await ticks();
    assert.equal(events(r.c, "stopped").length, 0);
    r.w.now += 1000;
    await r.c.next((l) => l.ev === "stopped" && l.reason === "idle");
    for (const bad of [0, 1441, 2.5, "5", -1, true]) {
      await config(r, { idle_stop_minutes: bad });
      assert.equal((await status(r.c)).idle_stop_minutes, 10, JSON.stringify(bad));
    }
    assert.equal(r.logs.filter((l) => l === "unit: config's idle_stop_minutes is not a whole number from 1 to 1440; the grace time is 10 min").length, 6);
    await config(r, { idle_stop_minutes: null });
    await config(r, { idle_stop_minutes: 1440 });
    assert.equal((await status(r.c)).idle_stop_minutes, 1440);
    await config(r);
    assert.equal((await status(r.c)).idle_stop_minutes, 10, "a config with no key: the default");
    assert.deepEqual([idleStopMinutes(1), idleStopMinutes(IDLE_STOP_MAX_MINUTES), idleStopMinutes(1441), idleStopMinutes(0)], [1, 1440, null, null]);
  } finally { await r.close(); }
});

test("the owner rule comes before the stop by use: a service that no longer owns stops nothing", async () => {
  const r = await rig();
  try {
    await config(r);
    await r.part.wake(running(r));
    r.owns.yes = false;
    r.w.now += 11 * MIN;
    await ticks();
    assert.equal(events(r.c, "stopped").length, 0);
    assert.equal(r.w.named("chromium").length, 1, "Chrome stays for the next owner");
    assert.ok(r.logs.some((l) => /before the stop of an unused browser/.test(l)) || r.logs.some((l) => /before the supervisor's check/.test(l)));
  } finally { await r.close(); }
});

// ------------------------------------------------------------------ rule 3: C12's needs (update, failed start)

test("an update that waits shows as pending in status and in the chrome event; it moves at the stop by use: the next start runs the newer copy", async () => {
  const r = await rig({ before: (_w, tools) => { tools.versions = ["157.0.7000.1-1"]; } });
  try {
    await config(r, { chrome_bin: null });
    await r.part.wake(running(r));
    assert.equal((await status(r.c)).chrome_version, "157.0.7000.1-1");
    r.part.updater.noteGood("157.0.7000.1-1");
    r.tools.versions.push("158.0.7100.1-1");
    (r.part.updater as any).ready = "158.0.7100.1-1";
    await r.c.next((l) => l.ev === "chrome" && l.update === "pending");
    assert.equal((await status(r.c)).update, "pending");
    r.w.now += 10 * MIN;
    await r.c.next((l) => l.ev === "stopped" && l.reason === "idle");
    assert.ok(r.logs.includes("update: the agent browser stopped with no use; its next start runs Google Chrome 158.0.7100.1-1"));
    assert.equal((await status(r.c)).update, null, "no Google Chrome runs");
    await r.part.wake(running(r));
    await ticks();
    const s = await status(r.c);
    assert.equal(s.chrome_version, "158.0.7100.1-1", "the next start runs the newer copy");
    assert.equal(s.update, "moving", "the new copy is on its probation until its receiver confirms");
  } finally { await r.close(); }
});

test("a start that fails at the first use: the request gets the start's error with its reason; stopped(start_failed) goes out once for the run of failures; the requests of the next 10 s get the error at once with no new start; a start that works ends the run", async () => {
  const r = await rig();
  try {
    await config(r, { chrome_bin: "/usr/bin/nochromium" });
    const text = useFailed("Chromium not found: /usr/bin/nochromium");
    assert.equal(text, "The agent browser could not get ready: Chromium not found: /usr/bin/nochromium.");
    assert.equal(await r.part.wake(running(r)), text);
    await r.c.next((l) => l.ev === "stopped");
    assert.deepEqual(events(r.c, "stopped"), [{ t: "ev", ev: "stopped", reason: "start_failed" }]);
    const s = await status(r.c);
    assert.deepEqual([s.state, s.last_stop.reason, s.last_stop.by], ["off", "start_failed", null]);
    assert.ok(s.operator_text.endsWith("The last start at an agent's use failed: Chromium not found: /usr/bin/nochromium."), s.operator_text);
    assert.equal(s.agent_text, STATE_TEXTS.off.agent_text, "the agent's text gets no sentence");
    const tries = () => r.logs.filter((l) => l === "unit: an agent uses the agent browser; starting Chrome").length;
    assert.equal(await r.part.wake(running(r)), text, "the same error at once");
    assert.equal(tries(), 1, "no new start in the next 10 s");
    r.w.now += USE_RETRY_MS;
    assert.equal(await r.part.wake(running(r)), text);
    assert.equal(tries(), 2, "a new start after 10 s");
    await sleep(20);
    assert.equal(events(r.c, "stopped").length, 1, "one stopped event for the run of failures");
    await config(r);
    assert.equal(await r.part.wake(running(r)), null, "a start that works (a changed config cleared the hold-off)");
    assert.ok(!(await status(r.c)).operator_text.includes("The last start at an agent's use failed"));
    await req(r.c, "stop", TOKEN);
    await config(r, { chrome_bin: "/usr/bin/nochromium" });
    assert.equal(await r.part.wake(running(r)), text);
    await until(() => events(r.c, "stopped").length === 3, "the third stopped event");
    assert.deepEqual(events(r.c, "stopped").map((l) => l.reason), ["start_failed", "stop", "start_failed"], "a new run of failures sends its own event");
  } finally { await r.close(); }
});

// ------------------------------------------------------------------ rule 4: the supervisor and the fail-closed watch

test("a stop by use is no crash: after it the supervisor starts nothing, the fail-closed watch counts no Chrome and sends no stop, and no event goes out", async () => {
  const r = await rig();
  try {
    await config(r);
    await r.part.wake(running(r));
    r.w.now += 10 * MIN;
    await r.c.next((l) => l.ev === "stopped" && l.reason === "idle");
    const spawned = r.w.spawned.length, evs = events(r.c).length;
    await sleep(200); // twenty checks of the supervisor and forty of the watch
    r.w.now += 61_000;
    await sleep(100);
    r.w.now += 60 * MIN;
    await sleep(100);
    assert.equal(r.w.spawned.length, spawned, "no restart");
    assert.equal(events(r.c).length, evs, "no event after the stop's own");
    assert.equal(r.part.watch.missingFor(), null, "the watch counts no Chrome");
    const s = await status(r.c);
    assert.deepEqual([s.state, s.last_stop.reason], ["off", "idle"], "not failed closed");
  } finally { await r.close(); }
});

test("P2: after a fail-closed stop a use starts Chrome again at most once in 60 s: in the hold-off a request gets that moment's answer at once and the state stays failed closed; a run of fail-closed stops after starts at a use sends its stopped once, until a Chrome stays up past the watch", async () => {
  const r = await rig({ watchLimitMs: 60_000 });
  try {
    await config(r);
    const spawns = () => r.w.spawned.filter((p) => p.argv[0].endsWith("chromium")).length;
    const closed = () => events(r.c).filter((l) => l.ev === "stopped" && l.reason === "receiver_missing").length;
    await r.part.wake(running(r));
    await ticks(); // the watch's first check sees this Chrome
    r.w.now += 61_000;
    await r.c.next((l) => l.ev === "stopped" && l.reason === "receiver_missing");
    const s1 = await status(r.c);
    assert.equal(s1.state, "failed closed");
    assert.match(s1.operator_text, /The next use by an agent starts it again\./);
    assert.doesNotMatch(s1.operator_text, /Browser page/);
    assert.equal(Part.FAIL_HOLD_MS, 60_000);
    // The hold-off: the request goes on at once (its caller gives that moment's 503), with no start and no wait.
    r.w.now += 59_000;
    assert.equal(await r.part.wake(running(r)), null);
    assert.deepEqual([spawns(), r.part.state(), r.part.usedBy().length], [1, "failed closed", 0], "no start in the hold-off");
    // After the hold-off, one start; its fail-closed stop is the run's second: last_stop only, no second event.
    r.w.now += 1000;
    await r.part.wake(running(r));
    assert.equal(spawns(), 2);
    const at1 = s1.last_stop.at;
    await ticks();
    r.w.now += 61_000;
    await until(() => !r.part.unit.running(), "the second fail-closed stop");
    await sleep(30);
    assert.equal(closed(), 1, "one stopped for the run");
    const s2 = await status(r.c);
    assert.deepEqual([s2.state, s2.last_stop.reason], ["failed closed", "receiver_missing"]);
    assert.notEqual(s2.last_stop.at, at1, "last_stop carries the later stop");
    // A Chrome that stays up past the watch ends the run: the next fail-closed stop sends its stopped again.
    r.w.now += 60_000;
    await r.part.wake(running(r));
    (r.part.watch as any).d.limitMs = 10 * 60_000;
    await ticks();
    r.w.now += 61_000;
    await ticks();
    (r.part.watch as any).d.limitMs = 60_000;
    r.w.now += 1000;
    await until(() => closed() === 2, "the stopped of a new run");
    assert.equal(r.part.unit.running(), false);
  } finally { await r.close(); }
});

// ------------------------------------------------------------------ the endpoint's wait (src/relay/endpoint.ts)

test("the endpoint: an upgrade that finds the link down waits for the service's start at a use, then the checks run again and the client connects; the wait's text, when a start fails, is its 503", async () => {
  const calls: string[] = [];
  let answer: string | null = null;
  let up: (() => Promise<void>) | null = null;
  const h = await harness({ use: { stopping: () => false, wake: async (scope) => { calls.push(scope); if (answer === null) await up!(); return answer === null ? null : [503, answer]; } } });
  up = () => h.ready();
  try {
    const c = await h.connect("s1");
    assert.deepEqual(calls, ["s1"], "one wait, with the scope");
    assert.match((await c.send("Browser.getVersion")).product, /Chrome/);
    await c.close();
    h.fake.line({ t: "link", up: false });
    await until(() => h.relay.model.notReady() === NOT_READY.link, "the link to drop");
    answer = "The agent browser could not get ready: Chromium not found: /x.";
    const got = await raw(h.url("s2"));
    assert.deepEqual([got.status, got.body], [503, answer]);
    assert.deepEqual(calls, ["s1", "s2"]);
  } finally { await h.close(); }
});

test("the endpoint: no wait for the refusals that a start cannot end (an Origin, a path, an extension too old, a scope with no list); with no start at a use the link's 503 comes at once", async () => {
  const calls: string[] = [];
  const h = await harness({ use: { stopping: () => false, wake: async (scope) => { calls.push(scope); return null; } } });
  try {
    assert.equal((await raw(h.url("s1"), { Origin: "https://x.example" })).status, 403);
    assert.equal((await raw(h.url("s1").replace("/devtools/browser/s1", "/other"))).status, 404);
    h.fake.info = { bridge: 0 };
    h.fake.line({ t: "link", up: true, version: "0.1.0" });
    await until(() => h.relay.model.notReady() === NOT_READY.old, "the old extension");
    assert.deepEqual(Object.values(await raw(h.url("s1"))).slice(0, 2), [503, NOT_READY.old]);
    assert.deepEqual(calls, [], "no wait");
  } finally { await h.close(); }
  const h2 = await harness({ use: { stopping: () => false, wake: async (scope) => { calls.push(scope); return null; } } });
  try {
    await h2.ready({ t: "allowlist", lists: { a: ["a.example"] }, scopes: { s1: "a" }, default: null });
    const got = await raw(h2.url("s9"));
    assert.deepEqual([got.status, got.body], [503, NOT_READY.noList]);
    assert.deepEqual(calls, [], "no wait for a scope with no list");
  } finally { await h2.close(); }
  const h3 = await harness();
  try {
    const got = await raw(h3.url("s1"));
    assert.deepEqual([got.status, got.body], [503, NOT_READY.link], "the relay with no start at a use answers at once");
  } finally { await h3.close(); }
});

test("the endpoint: while the service stops Chrome for lack of use, a new upgrade counts the link as down, waits, and connects after the start", async () => {
  let stopping = true;
  const calls: string[] = [];
  const h = await harness({ use: { stopping: () => stopping, wake: async (scope) => { calls.push(scope); stopping = false; return null; } } });
  try {
    await h.ready(lineOf(["a.example"]));
    const c = await h.connect("s1");
    assert.deepEqual(calls, ["s1"], "the upgrade waited");
    await c.close();
    await h.connect("s1");
    assert.deepEqual(calls, ["s1"], "no wait when no stop runs");
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ the MCP path's wait (src/service/mcp/port.ts)

const V = JSON.parse(readFileSync(new URL("./vectors/endpoint.json", import.meta.url), "utf8"));
const UID: number = V.mcpService.uid;
const T = V.mcpTokens;
type P = { pid: number; ppid: number; start: number; state: string; cgroup: string | null };
/** A reader of the vectors' linux world: each client gets its line, its inode and its holders (as in service-mcp-port.test.ts). */
class WorldReader implements McpReader {
  readonly w = new Map<number, P>(V.procs.filter((p: any) => p.world === "linux").map((p: any) => [p.pid, p]));
  service = "";
  private readonly conns = new Map<string, { inode: number; holders: number[] }>();
  private next = 90000;
  readonly pending: number[][] = [];
  accepted(client: string): void { this.conns.set(client, { inode: (this.next += 10), holders: this.pending.shift() ?? [] }); }
  tcp(): TcpLine[] {
    const out: TcpLine[] = [{ local: this.service, remote: "0.0.0.0:0", uid: UID, inode: 80000 }];
    for (const [client, c] of this.conns) out.push({ local: this.service, remote: client, uid: UID, inode: c.inode + 1 }, { local: client, remote: this.service, uid: UID, inode: c.inode });
    return out;
  }
  holders(inode: number): number[] { for (const c of this.conns.values()) if (c.inode === inode) return [...c.holders]; return []; }
  proc(pid: number) { const p = this.w.get(pid); return p ? { ppid: p.ppid, start: p.start, state: p.state } : null; }
  cgroup(pid: number) { return this.w.get(pid)?.cgroup ?? null; }
}
const OK = "the stub transport admits this request";
/**
 * The port with a stub handler: a request with the header `x-tool: call` stands for a tool call, so the stub calls its
 * browser gate first (as the transport does) and answers only when the gate says go on; every other request stands for
 * one that needs no browser.
 */
async function mcpPort(readiness: () => McpReadiness, use: { refusal(scope: string): string | null; wake(scope: string): Promise<string | null> }) {
  const r = new WorldReader();
  const seen: string[] = [], forwarded: string[] = [];
  const handler: McpHandler = {
    async request(req, res, scope, browser) {
      seen.push(`${scope}${browser ? " (Chrome down)" : ""}`);
      if (req.headers["x-tool"] === "call" && browser && !(await browser())) return;
      forwarded.push(scope);
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(OK) }).end(OK);
    },
    endSessions() {},
  };
  const port = await McpPort.open({ listen: { port: 0 }, handler, readiness, use, log: () => {}, reader: r, uid: UID });
  r.service = `127.0.0.1:${port.port}`;
  port.listener.prependListener("connection", (s: Socket) => r.accepted(`127.0.0.1:${s.remotePort}`));
  port.setSessions({ sessions: V.mcpSnapshots.tokens.sessions } as any);
  const ask = async (tool = false): Promise<{ status: number; body: string }> => {
    r.pending.push([3102]);
    const s = connect({ host: "127.0.0.1", port: port.port });
    s.on("error", () => {});
    let buf = "";
    s.on("data", (d) => { buf += d; });
    s.write(`GET /mcp/md-lead HTTP/1.1\r\nhost: 127.0.0.1:${port.port}\r\nauthorization: Bearer ${T.leadRun2.token}\r\n${tool ? "x-tool: call\r\n" : ""}\r\n`);
    await until(() => /\r\n\r\n/.test(buf) && buf.length >= buf.indexOf("\r\n\r\n") + 4 + Number(/content-length: (\d+)/i.exec(buf)?.[1] ?? 0), "the answer", 10_000);
    s.destroy();
    return { status: Number(buf.split(" ")[1]), body: buf.slice(buf.indexOf("\r\n\r\n") + 4) };
  };
  return { port, seen, forwarded, ask, reader: r };
}

test("O1: while Chrome is down, an MCP request that needs no browser passes step 8 with no start; a tool call starts Chrome through its gate, steps 3 to 8 run again, and the handler answers; a failed start's text is the 503 of step 8; the service's own refusal comes at once", async () => {
  let ready: McpReadiness = { controlOff: false, notReady: NOT_READY.link, sites: null };
  const wakes: string[] = [];
  let answer: string | null = null, refusal: string | null = null;
  const p = await mcpPort(() => ready, { refusal: () => refusal, wake: async (scope) => { wakes.push(scope); await sleep(30); if (answer === null) ready = { controlOff: false, notReady: null, sites: 2 }; return answer; } });
  try {
    assert.deepEqual(await p.ask(), { status: 200, body: OK }, "a request that needs no browser");
    assert.deepEqual([wakes, p.seen], [[], ["md-lead (Chrome down)"]], "no start");
    assert.deepEqual(await p.ask(true), { status: 200, body: OK }, "a tool call");
    assert.deepEqual(wakes, ["md-lead"], "the tool call started Chrome");
    ready = { controlOff: false, notReady: NOT_READY.allowlist, sites: null };
    answer = "The agent browser could not get ready: Xvfb not found on PATH.";
    assert.deepEqual(await p.ask(true), { status: 503, body: answer });
    refusal = NOT_READY.noList;
    assert.deepEqual(await p.ask(), { status: 503, body: NOT_READY.noList }, "the service's own refusal, at once");
    assert.equal(wakes.length, 2);
  } finally { await p.port.stop(); }
});

test("the MCP path: no gate and no start for control off, an extension too old, or a scope with no list while Chrome runs", async () => {
  const calls: string[] = [];
  for (const [ready, body] of [
    [{ controlOff: true, notReady: NOT_READY.link, sites: null }, MCP_TEXT.controlOff],
    [{ controlOff: false, notReady: NOT_READY.old, sites: null }, NOT_READY.old],
    [{ controlOff: false, notReady: null, sites: null }, NOT_READY.noList],
  ] as [McpReadiness, string][]) {
    const p = await mcpPort(() => ready, { refusal: (scope) => { calls.push(`refusal ${scope}`); return null; }, wake: async (scope) => { calls.push(scope); return null; } });
    try { assert.deepEqual(await p.ask(true), { status: 503, body }); } finally { await p.port.stop(); }
  }
  assert.deepEqual(calls, []);
});

test("a send needs the browser: each import calls the start at a use before its wait for the receiver", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-use-send-"));
  let up = false;
  let events: { up(): void } | null = null;
  const port: ReceiverPort = {
    attach: (e) => { events = e; }, isUp: () => up,
    request: async () => ({ cookies_set: 1, errors: [] }), allowlist() {}, endScope() {},
  };
  let woke = 0;
  const s = new Stage1c({ listsFolder: join(dir, "lists"), stateFolder: join(dir, "state"), receiver: port, log: () => {}, wake: async () => { woke++; setTimeout(() => { up = true; events!.up(); }, 20); return null; } });
  try {
    s.setSessions({ t: "req", id: "s", op: "set_sessions", by: DAEMON, sessions: [], remote: [], box: { hosts: ["box.example"], cookie_names: [] } } as any);
    const payload = { v: 1, domain: "example.com", url: "https://www.example.com/", origin: "https://www.example.com", cookies: [], storage: { local: {}, session: {}, idb: [], caches: [] } };
    const a = await s.ops.import({ t: "req", id: "i", op: "import", by: { kind: "operator", user: "ann", via: "send" }, payload } as any);
    assert.equal(woke, 1, "one start at a use for the send");
    assert.equal((a as any).data?.cookies_set, 1, JSON.stringify(a));
  } finally { s.stop(); rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ the service's wiring (service.ts)

const HELLO = { t: "hello", v: 2, version: "0.3.6", channels: ["main", "bridge"], features: ["scopes"] };
/** This process's start time (field 22 of /proc/self/stat): the root of the test's session. */
const myStart = () => { const st = readFileSync("/proc/self/stat", "latin1"); return Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[19]); };

test("the service: an upgrade of a live session's scope while Chrome does not run starts it and waits; the client then connects; the use signal names the client, a running request and a running send; a scope that is no live session, or control off, starts nothing", { skip: process.platform !== "linux", timeout: 60_000 }, async (t) => {
  const w = new World();
  const dir = mkdtempSync(join(tmpdir(), "ab-use-svc-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); w.close(); });
  mkdirSync(join(dir, "lists"));
  writeFileSync(join(dir, "lists", "owner.repo.json"), JSON.stringify({ allow: ["a.example"], repo: "owner/repo" }));
  const tools = new FakeTools();
  const logs: string[] = [];
  const s = await startService({
    agentDoor: join(dir, "cdp.sock"), controlDoor: join(dir, "control.sock"), daemonCommand: join(dir, "daemon-command.json"), log: (l) => logs.push(l), mainPid: async () => null,
    lists: { listsFolder: join(dir, "lists"), stateFolder: w.paths.state },
    unit: { paths: w.paths, owner: async () => ACTIVE, tools, procs: w.procs, part: { unit: w.deps(tools), firstCheckMs: 3_600_000, usePollMs: 5 } },
    link: { socket: join(dir, "link.sock"), pidfds: { failed: "none" }, xdotool: null, peer: async () => ({ ok: true, pid: 4242 }) },
  });
  const shims: Socket[] = [];
  try {
    const DAEMON_CFG = { kind: "daemon", user: "ann", via: "config" };
    await s.state.handle({ ...CONFIG, by: DAEMON_CFG } as any);
    await s.state.handle({ t: "req", id: "s", op: "set_sessions", by: DAEMON, sessions: [{ scope: "web-1", repo: "owner/repo", roots: [{ pid: process.pid, start: myStart() }], cgroup: null, lifetime_id: null, mcp_token: null }], remote: [], box: { hosts: ["box.example"], cookie_names: [] } } as any);
    const part = s.part!;
    assert.deepEqual(part.usedBy(), []);
    const url = (scope: string) => `ws+unix://${join(dir, "cdp.sock")}:/devtools/browser/${scope}`;
    // A scope that is no live session: the link's 503 at once, and no Chrome.
    const other = await raw(url("web-9"));
    assert.deepEqual([other.status, other.body], [503, NOT_READY.link]);
    assert.equal(w.named("chromium").length, 0, "no start for a scope that is no live session");
    // The live session's upgrade waits: Chrome and Xvfb start; then "Chrome" starts the host shim, which links.
    const client = CDPConnection.connect(url("web-1"), 30_000);
    await until(() => w.named("chromium").length === 1, "Chrome to start", 10_000);
    const fr = new FakeReceiver();
    const shim = connect(join(dir, "link.sock"));
    shims.push(shim);
    shim.on("error", () => {});
    let buf = "";
    const open = new Map<string, Buffer[]>();
    shim.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0;) {
        const p = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        const key = `${p.ch ?? "main"} ${p.id}`;
        const parts = open.get(key) ?? []; parts.push(Buffer.from(p.b64, "base64")); open.set(key, parts);
        if (parts.length < p.n) continue;
        open.delete(key);
        const q = JSON.parse(Buffer.concat(parts).toString("utf8"));
        if (p.ch === "bridge") fr.output.write(`${JSON.stringify(q)}\n`);
        else if (q.op === "set_scopes") shim.write(`${JSON.stringify({ t: "res", id: q.id, ok: true, data: { rules: 1, closed: 0, refused: 0 } })}\n`);
        else if (q.op === "import") setTimeout(() => shim.write(`${JSON.stringify({ t: "res", id: q.id, ok: true, data: { cookies_set: 0, errors: [] } })}\n`), 300);
      }
    });
    fr.input.on("data", (d) => shim.write(d));
    await new Promise((r) => shim.once("connect", r));
    shim.write(`${JSON.stringify(HELLO)}\n`);
    const cdp = await client;
    assert.match((await cdp.send("Browser.getVersion")).product, /Chrome/);
    assert.ok(logs.includes("unit: an agent uses the agent browser; starting Chrome"));
    assert.ok(part.usedBy().includes("client"), "an open client connection of the agent door");
    // A client's message that runs: the fake receiver holds the answer of its bridge call. The model's own bridge calls
    // are no use (review-120 B2).
    const model = (s.agent as any).relay.model;
    fr.op = (q) => (q.op === "tabs.query" ? new Promise(() => {}) : undefined);
    void model.bridge.call("tabs.query", [{}]).catch(() => {});
    await until(() => (s.carrier as any).inFlight() > 0, "the model's own call in flight");
    assert.ok(!part.usedBy().includes("request"), "a bridge call of the model's own that runs is no use");
    fr.op = (q) => (q.op === "tabs.query" || q.op === "tabs.create" || q.op === "windows.create" ? new Promise(() => {}) : undefined);
    void cdp.send("Target.createTarget", { url: "about:blank" }).catch(() => {});
    await until(() => part.usedBy().includes("request"), "the client's request");
    // A send that runs.
    const payload = { v: 1, domain: "example.com", url: "https://www.example.com/", origin: "https://www.example.com", cookies: [], storage: { local: {}, session: {}, idb: [], caches: [] } };
    const sending = s.state.handle({ t: "req", id: "i", op: "import", by: { kind: "operator", user: "ann", via: "send" }, payload } as any);
    await until(() => part.usedBy().includes("send"), "the send");
    await sending;
    await cdp.close();
    // Control off: a use starts nothing.
    await s.state.handle({ ...CONFIG, control: false, by: DAEMON_CFG } as any);
    await part.stopBrowser(null);
    shim.destroy(); // Chrome's host shim ends with Chrome
    await until(() => model.notReady() !== null, "the link to drop");
    const off = await raw(url("web-1"));
    assert.equal(off.status, 503);
    assert.equal(w.named("chromium").length, 0, "no start with control off");
  } finally { for (const x of shims) x.destroy(); await s.stop(); }
});

test("the service with its MCP path: an MCP tool call that runs is a use, an open MCP session is none; the MCP path has the start at a use; its readiness counts a stop by use that runs as a link that is down", { skip: process.platform !== "linux", timeout: 30_000 }, async (t) => {
  const w = new World();
  const dir = mkdtempSync(join(tmpdir(), "ab-use-mcp-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); w.close(); });
  const tools = new FakeTools();
  const s = await startService({
    agentDoor: join(dir, "cdp.sock"), controlDoor: join(dir, "control.sock"), daemonCommand: join(dir, "daemon-command.json"), log: () => {}, mainPid: async () => null,
    lists: { listsFolder: join(dir, "lists"), stateFolder: w.paths.state },
    unit: { paths: w.paths, owner: async () => ACTIVE, tools, procs: w.procs, part: { unit: w.deps(tools), firstCheckMs: 3_600_000 } },
    mcp: { listen: { port: 0 } },
  });
  try {
    const port = s.mcp!.mcpPort as any;
    const readiness = port.o.readiness as (scope: string) => McpReadiness;
    const model = (s.agent as any).relay.model;
    model.notReady = () => null;
    assert.equal(readiness("web-1").notReady, null);
    (s.part as any).idleStop = Promise.resolve();
    assert.equal(readiness("web-1").notReady, NOT_READY.link, "a stop by use that runs");
    (s.part as any).idleStop = null;
    assert.equal(typeof port.o.use?.wake, "function", "the MCP path has the start at a use");
    // An open MCP session is no use; a tool call that runs is (the daemon lead's P1).
    assert.deepEqual(s.part!.usedBy(), []);
    const tr = s.mcp!.mcpTransport as any;
    tr.size = () => 1;
    assert.deepEqual(s.part!.usedBy(), [], "an open MCP session is no use");
    tr.activity = () => ({ calls: 1, quietFor: 0 });
    assert.deepEqual(s.part!.usedBy(), ["mcp"], "a tool call that runs");
  } finally { await s.stop(); }
});

// ------------------------------------------------------------------ review-120: the rig of the real service with its link

/** A shim on the link socket for the fake Chrome, with a fresh fake receiver behind it (its bridge), that answers channel main. */
function shimOn(path: string, o: { holdImport?: boolean; laterConfirmMs?: number } = {}) {
  const fr = new FakeReceiver();
  const s = connect(path);
  const main: any[] = [];
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
      main.push(q);
      if (q.op === "set_scopes") {
        // `laterConfirmMs`: each confirm after the first comes this much later.
        const ok = () => { if (!s.destroyed) s.write(`${JSON.stringify({ t: "res", id: q.id, ok: true, data: { rules: 1, closed: 0, refused: 0 } })}\n`); };
        if (o.laterConfirmMs && main.filter((x) => x.op === "set_scopes").length > 1) setTimeout(ok, o.laterConfirmMs); else ok();
      }
      else if (q.op === "import") setTimeout(() => s.write(`${JSON.stringify({ t: "res", id: q.id, ok: true, data: { cookies_set: 0, errors: [] } })}\n`), o.holdImport ? 300 : 0);
    }
  });
  fr.input.on("data", (d) => { if (!s.destroyed) s.write(d); });
  s.once("connect", () => s.write(`${JSON.stringify(HELLO)}\n`));
  return { s, fr, main };
}

type Svc = Awaited<ReturnType<typeof startService>> & { w: World; dir: string; logs: string[]; shims: ReturnType<typeof shimOn>[]; url: (scope: string) => string; sessions: (items: any[]) => Promise<void> };
/**
 * The real service on the fake world, with its link (a fake peer check of the shim), and a host of the fake Chrome: each
 * fake Chrome that starts gets a shim on the link, which ends with it. `lists`: the list files of the test.
 */
async function svc(t: { after: (f: () => Promise<void> | void) => void }, o: { lists: Record<string, string[]>; mcp?: boolean; shim?: { laterConfirmMs?: number }; linkDownMs?: number }): Promise<Svc> {
  const w = new World();
  const dir = mkdtempSync(join(tmpdir(), "ab-use-r1-"));
  mkdirSync(join(dir, "lists"));
  for (const [name, allow] of Object.entries(o.lists)) writeFileSync(join(dir, "lists", `${name}.json`), JSON.stringify({ allow, repo: name.replace(".", "/") }));
  const tools = new FakeTools();
  const logs: string[] = [];
  const s = await startService({
    agentDoor: join(dir, "cdp.sock"), controlDoor: join(dir, "control.sock"), daemonCommand: join(dir, "daemon-command.json"), log: (l) => logs.push(l), mainPid: async () => null,
    lists: { listsFolder: join(dir, "lists"), stateFolder: w.paths.state },
    unit: { paths: w.paths, owner: async () => ACTIVE, tools, procs: w.procs, part: { unit: w.deps(tools), firstCheckMs: 3_600_000, usePollMs: 5, watchMs: 20 } },
    link: { socket: join(dir, "link.sock"), pidfds: { failed: "none" }, xdotool: null, peer: async () => ({ ok: true, pid: 4242 }) },
    ...(o.mcp ? { mcp: { listen: { port: 0 } } } : {}),
  });
  const shims: ReturnType<typeof shimOn>[] = [];
  let pid = 0;
  // `linkDownMs`: the link of a Chrome that ended goes down that much later (a loaded box's late link down).
  const late = new Set<NodeJS.Timeout>();
  const host = setInterval(() => {
    const c = w.named("chromium")[0];
    if (c && c.pid !== pid) { pid = c.pid; shims.at(-1)?.s.destroy(); shims.push(shimOn(join(dir, "link.sock"), o.shim)); }
    else if (!c && pid !== 0) {
      pid = 0;
      const shim = shims.at(-1);
      if (!o.linkDownMs) shim?.s.destroy();
      else { const tm = setTimeout(() => { late.delete(tm); shim?.s.destroy(); }, o.linkDownMs); late.add(tm); }
    }
  }, 5);
  t.after(async () => { clearInterval(host); for (const tm of late) clearTimeout(tm); for (const x of shims) x.s.destroy(); await s.stop(); rmSync(dir, { recursive: true, force: true }); w.close(); });
  await s.state.handle({ ...CONFIG, by: { kind: "daemon", user: "ann", via: "config" } } as any);
  const sessions = async (items: any[]) => { await s.state.handle({ t: "req", id: "s", op: "set_sessions", by: DAEMON, sessions: items, remote: [], box: { hosts: ["box.example"], cookie_names: [] } } as any); };
  return Object.assign(s, { w, dir, logs, shims, url: (scope: string) => `ws+unix://${join(dir, "cdp.sock")}:/devtools/browser/${scope}`, sessions });
}
const me = () => [{ pid: process.pid, start: myStart() }];
const session = (scope: string, repo: string, roots: { pid: number; start: number }[], extra: object = {}) => ({ scope, repo, roots, cgroup: null, lifetime_id: null, mcp_token: null, ...extra });
const starts = (x: Svc) => x.logs.filter((l) => l === "unit: an agent uses the agent browser; starting Chrome").length;

test("B1: while Chrome is off, the service's own checks come at once with no start and no wait: a process of web-1 at web-2's path gets the session's 403, a scope that no confirm can name or that has no list the no-list 503; their retries never start Chrome nor count as a use; only an upgrade that passes every check but the link starts it", { skip: process.platform !== "linux", timeout: 60_000 }, async (t) => {
  const x = await svc(t, { lists: { "owner.repo": ["a.example"] } });
  const part = x.part!;
  // web-1 is this process's session; web-2's session is another one (a root that is gone).
  await x.sessions([session("web-1", "owner/repo", me()), session("web-2", "owner/repo", [{ pid: 999_999, start: 1 }])]);
  const s1c = (x.state as any).parts.find((p: any) => p instanceof Stage1c) as Stage1c;
  const view = s1c.useView.bind(s1c);
  for (let i = 0; i < 5; i++) {
    const at = Date.now();
    const other = await raw(x.url("web-2"));
    assert.deepEqual([other.status, other.body], [403, sessionRefusal(process.pid)], "the session's 403 at once");
    // A scope that no confirm can name (two live sessions share it), and a scope that the object gives no list.
    for (const v of [{ named: false, nameable: false, list: null, sites: 0 }, { named: true, nameable: true, list: null, sites: 0 }]) {
      s1c.useView = (scope: string) => (scope === "web-1" ? v : view(scope));
      const nolist = await raw(x.url("web-1"));
      assert.deepEqual([nolist.status, nolist.body], [503, NOT_READY.noList], `the no-list 503 at once (${JSON.stringify(v)})`);
    }
    // C11's order: a scope that no confirm can name gets the no-list 503 before the session check.
    s1c.useView = (scope: string) => (scope === "web-2" ? { named: false, nameable: false, list: null, sites: 0 } : view(scope));
    const unnamed = await raw(x.url("web-2"));
    assert.deepEqual([unnamed.status, unnamed.body], [503, NOT_READY.noList], "step 5 comes before step 6");
    s1c.useView = view;
    assert.ok(Date.now() - at < 2000, "no wait");
    assert.deepEqual(part.usedBy(), [], "a refused client is never held");
  }
  assert.deepEqual([x.w.named("chromium").length, starts(x)], [0, 0], "no start");
  // An upgrade that passes every check but the link starts Chrome and waits.
  const cdp = await CDPConnection.connect(x.url("web-1"), 30_000);
  assert.equal(starts(x), 1);
  assert.match((await cdp.send("Browser.getVersion")).product, /Chrome/);
  await cdp.close();
  // Chrome runs: a refused client's retries (the model's own 403) are no use, so the stop by use comes.
  (part as any).idleMinutes = 0.02; // 1.2 s
  const end = Date.now() + 8000;
  while (part.unit.running() && Date.now() < end) {
    const r = await raw(x.url("web-2"));
    assert.equal(r.status, 403);
    await sleep(50);
  }
  assert.equal(part.unit.running(), false, "the retries of a refused client did not keep Chrome up");
  assert.equal((x.state.status() as any).last_stop.reason, "idle");
});

test("B1 on the MCP path: a session whose list has no site gets the no-list 503 at step 8 at once, with no start", { skip: process.platform !== "linux", timeout: 60_000 }, async (t) => {
  const tok = control.testTokens[0];
  const x = await svc(t, { lists: {}, mcp: true });
  await x.sessions([session("web-1", "owner/repo", me(), { lifetime_id: "lt-1", mcp_token: tok.fingerprint })]);
  const url = `http://127.0.0.1:${x.mcp!.mcpPort!.port}/mcp/web-1`;
  for (let i = 0; i < 3; i++) {
    const at = Date.now();
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), signal: AbortSignal.timeout(30_000) });
    assert.deepEqual([r.status, await r.text()], [503, NOT_READY.noList]);
    assert.ok(Date.now() - at < 2000, "at once");
  }
  assert.deepEqual([x.w.named("chromium").length, starts(x), x.part!.usedBy().length], [0, 0, 0]);
});

test("F1: a launch after the service's start while Chrome is off starts Chrome on the agent door; the client connects after the push and its confirm name its scope", { skip: process.platform !== "linux", timeout: 60_000 }, async (t) => {
  // The confirm of the push that names the launch comes 300 ms after it: the wait must last until the line names it.
  const x = await svc(t, { lists: { "owner.repo": ["a.example"] }, shim: { laterConfirmMs: 300 } });
  await x.sessions([]); // the first complete read: no session
  await x.sessions([session("web-1", "owner/repo", me())]); // a launch after it: the restart gate keeps it out of the object
  const s1c = (x.state as any).parts.find((p: any) => p instanceof Stage1c) as Stage1c;
  assert.deepEqual(s1c.useView("web-1"), { named: false, nameable: true, list: "owner.repo", sites: 1 }, "left out until a confirm");
  const cdp = await CDPConnection.connect(x.url("web-1"), 30_000);
  assert.equal(starts(x), 1, "the launch's use started Chrome");
  assert.match((await cdp.send("Browser.getVersion")).product, /Chrome/);
  const pushes = x.shims.at(-1)!.main.filter((q) => q.op === "set_scopes");
  assert.ok(pushes.length >= 2 && !Object.hasOwn(pushes[0].scopes, "web-1") && pushes.at(-1).scopes["web-1"] === "owner.repo", "the first push leaves the launch out, a later one names it");
  await cdp.close();
});

test("F1 on the MCP path: a launch after the service's start: initialize needs no browser, and a tool call starts Chrome and gets its answer after the push and its confirm", { skip: process.platform !== "linux", timeout: 120_000 }, async (t) => {
  const tok = control.testTokens[0];
  const x = await svc(t, { lists: { "owner.repo": ["a.example"] }, mcp: true });
  await x.sessions([]);
  await x.sessions([session("web-1", "owner/repo", me(), { lifetime_id: "lt-1", mcp_token: tok.fingerprint })]);
  const url = `http://127.0.0.1:${x.mcp!.mcpPort!.port}/mcp/web-1`;
  const post = async (body: object, sid?: string) => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${tok.token}`, ...(sid ? { "Mcp-Session-Id": sid } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const text = await r.text();
    return { status: r.status, sid: r.headers.get("mcp-session-id"), body: text ? JSON.parse(text) : null, text };
  };
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  assert.equal(init.status, 200, init.text);
  assert.equal(starts(x), 0, "no start for initialize");
  const a = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_tabs", arguments: { action: "list" } } }, init.sid!);
  assert.ok(a.status === 200 && a.body.result, a.text);
  assert.equal(starts(x), 1, "the tool call started Chrome");
  assert.ok(x.shims.at(-1)!.main.filter((q) => q.op === "set_scopes").length >= 2, "the push that names the launch came after the first confirm");
});

test("F1: a name that ended while Chrome was off and launches again starts Chrome; the client connects after the prune of the name and the push that names it", { skip: process.platform !== "linux", timeout: 60_000 }, async (t) => {
  const x = await svc(t, { lists: { "owner.repo": ["a.example"] } });
  await x.sessions([session("web-1", "owner/repo", me())]);
  await x.state.handle({ t: "req", id: "e", op: "session_ended", by: DAEMON, scope: "web-1" } as any);
  await x.sessions([session("web-1", "owner/repo", me())]); // the name launches again: rule 2 keeps it out until a confirm
  const s1c = (x.state as any).parts.find((p: any) => p instanceof Stage1c) as Stage1c;
  assert.deepEqual([s1c.useView("web-1").named, s1c.useView("web-1").nameable], [false, true]);
  const cdp = await CDPConnection.connect(x.url("web-1"), 30_000);
  assert.equal(starts(x), 1);
  assert.match((await cdp.send("Browser.getVersion")).product, /Chrome/);
  await cdp.close();
});

test("F1: a scope that two live sessions share is refused at once with no start (the door refuses such a snapshot; the check holds also when one reaches the book); its roots keep both sessions' roots", { skip: process.platform !== "linux", timeout: 60_000 }, async (t) => {
  const x = await svc(t, { lists: { "owner.repo": ["a.example"] } });
  await x.sessions([session("web-1", "owner/repo", me()), session("web-1", "owner/repo", [{ pid: 999_999, start: 1 }])]);
  assert.deepEqual((x.state as any).roots().get("web-1"), [...me(), { pid: 999_999, start: 1 }], "the roots of both sessions");
  const s1c = (x.state as any).parts.find((p: any) => p instanceof Stage1c) as Stage1c;
  assert.deepEqual(s1c.useView("web-1"), { named: false, nameable: false, list: null, sites: 0 });
  const r = await raw(x.url("web-1"));
  assert.deepEqual([r.status, r.body], [503, NOT_READY.noList]);
  assert.deepEqual([starts(x), x.part!.usedBy().length], [0, 0]);
});

test("review-120b's note: a send in the hold-off after a fail-closed stop gets that moment's answer at once, with no wait for a receiver", { skip: process.platform !== "linux", timeout: 30_000 }, async (t) => {
  const x = await svc(t, { lists: { "owner.repo": ["a.example"] } });
  await x.sessions([session("web-1", "owner/repo", me())]);
  const part = x.part as any;
  part.failClosedAt = part.clock();
  part.lastStop = { reason: "receiver_missing", at: "2026-11-12T00:00:00Z", by: null };
  assert.equal(x.part!.failClosedHold(), true);
  const payload = { v: 1, domain: "example.com", url: "https://www.example.com/", origin: "https://www.example.com", cookies: [], storage: { local: {}, session: {}, idb: [], caches: [] } };
  const at = Date.now();
  const a = await x.state.handle({ t: "req", id: "i", op: "import", by: { kind: "operator", user: "ann", via: "send" }, payload } as any);
  assert.deepEqual(a, { error: "The sign-in for example.com was not sent: the agent extension is not connected." });
  assert.ok(Date.now() - at < 2000, "at once");
  assert.equal(starts(x), 0);
});

test("B1: the service's own pid (an MCP's browser) passes the check before a start at a use only with a live ticket of its scope", { skip: process.platform !== "linux", timeout: 60_000 }, async (t) => {
  const tok = control.testTokens[0];
  const x = await svc(t, { lists: { "owner.repo": ["a.example"] }, mcp: true });
  await x.sessions([session("web-1", "owner/repo", me(), { lifetime_id: "lt-1", mcp_token: tok.fingerprint })]);
  // This test runs in the service's process: its own CDP client is the service's own pid.
  const bare = await raw(x.url("web-1"));
  assert.deepEqual([bare.status, bare.body], [403, sessionRefusal(process.pid)], "no ticket: the session's 403 at once");
  const other = await raw(`${x.url("web-1")}?ticket=${x.mcp!.tickets.mint("web-2")}`);
  assert.deepEqual([other.status, other.body], [403, sessionRefusal(process.pid)], "a ticket of another scope: the session's 403 at once");
  assert.deepEqual([x.w.named("chromium").length, starts(x)], [0, 0], "no start");
  const cdp = await CDPConnection.connect(`${x.url("web-1")}?ticket=${x.mcp!.tickets.mint("web-1")}`, 30_000);
  assert.equal(starts(x), 1, "a live ticket of the scope starts Chrome and waits");
  assert.match((await cdp.send("Browser.getVersion")).product, /Chrome/);
  await cdp.close();
});

test("B2: the quiet time counts only the agents' traffic: after the client leaves, a set_sessions change (a new set_scopes, its confirm, a new allowlist line and the model's content-settings calls) does not reset it", { skip: process.platform !== "linux", timeout: 60_000 }, async (t) => {
  const x = await svc(t, { lists: { "owner.repo": ["a.example"] } });
  const part = x.part!;
  await x.sessions([session("web-1", "owner/repo", me())]);
  const cdp = await CDPConnection.connect(x.url("web-1"), 30_000);
  await cdp.send("Browser.getVersion");
  await cdp.close();
  await until(() => part.usedBy().length === 0, "the client to leave");
  const left = performance.now();
  await sleep(200);
  const shim = x.shims.at(-1)!;
  const pushes = shim.main.filter((q) => q.op === "set_scopes").length;
  const settings = () => shim.fr.requests.filter((q) => q.op.startsWith("contentSettings.")).length;
  const before = settings();
  await x.sessions([session("web-1", "owner/repo", me()), session("web-2", "owner/repo", [{ pid: 999_999, start: 1 }])]);
  await until(() => shim.main.filter((q) => q.op === "set_scopes").length > pushes && settings() > before, "the new push, its line and the model's content-settings calls");
  await sleep(50);
  const quiet = (part as any).o.use.quietFor();
  assert.ok(quiet >= performance.now() - left - 30 && quiet >= 200, `the quiet time goes on from the client's leave (${Math.round(quiet)} ms)`);
  assert.deepEqual(part.usedBy(), []);
});

test("P1 and O1: initialize, tools/list and a DELETE start nothing; an MCP session stays open over a stop by use and is no use by being open; its next tool call starts Chrome again, the MCP's browser connects again with a new ticket, and the call gets its answer", { skip: process.platform !== "linux", timeout: 120_000 }, async (t) => {
  const tok = control.testTokens[0];
  // A late link down (board ab-b84.30): on a loaded box the stop's end (Chrome's link goes down, and the relay closes
  // the MCP's own connection) comes after the unit stops; a tool call before it reaches the MCP's old browser
  // connection. Each run forces it, so the test waits for the stop's end, not for the unit's flag only.
  const x = await svc(t, { lists: { "owner.repo": ["a.example"] }, mcp: true, linkDownMs: 500 });
  const conns = () => (x.agent as any).relay.model.connectionCount as number;
  const part = x.part!;
  await x.sessions([session("web-1", "owner/repo", me(), { lifetime_id: "lt-1", mcp_token: tok.fingerprint })]);
  let minted = 0;
  const mint = x.mcp!.tickets.mint.bind(x.mcp!.tickets);
  x.mcp!.tickets.mint = (scope: string) => { minted++; return mint(scope); };
  const url = `http://127.0.0.1:${x.mcp!.mcpPort!.port}/mcp/web-1`;
  const post = async (body: object, sid?: string) => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${tok.token}`, ...(sid ? { "Mcp-Session-Id": sid } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const text = await r.text();
    return { status: r.status, sid: r.headers.get("mcp-session-id"), body: text ? JSON.parse(text) : null, text };
  };
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  assert.equal(init.status, 200, init.text);
  const sid = init.sid!;
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  const list = await post({ jsonrpc: "2.0", id: 9, method: "tools/list" }, sid);
  assert.ok(list.status === 200 && list.body.result.tools.length > 0, list.text);
  assert.deepEqual([starts(x), x.w.named("chromium").length, part.usedBy().length], [0, 0, 0], "initialize, the notification and tools/list need no browser: no start, no use (review-120b O1)");
  const call = (id: number) => post({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "browser_tabs", arguments: { action: "list" } } }, sid);
  const a = await call(2);
  assert.ok(a.status === 200 && a.body.result, a.text);
  assert.equal(starts(x), 1, "the tool call started Chrome");
  assert.equal(minted, 1, "the MCP's browser connected with a ticket");
  const act = x.mcp!.activity();
  assert.ok(act.calls === 0 && act.quietFor < 10_000, "the tool call counted as a use while it ran, and its end starts the quiet time");
  const pid1 = x.w.named("chromium")[0].pid;
  await until(() => part.usedBy().length === 0, "no use while the MCP session is open and no call runs", 5000);
  // The stop by use: the open MCP session and the MCP's own open connection do not hold it.
  (part as any).idleMinutes = 0.02; // 1.2 s
  assert.equal(conns(), 1, "the MCP's own connection is open before the stop");
  await until(() => !part.unit.running(), "the stop by use", 15_000);
  await until(() => conns() === 0, "the stop's end: the link down closes the MCP's own connection", 15_000);
  assert.equal((x.state.status() as any).last_stop.reason, "idle");
  assert.equal(x.mcp!.mcpTransport!.size("web-1"), 1, "the MCP session stays open");
  (part as any).idleMinutes = 10;
  // The next tool call: step 8 waits for the start at a use; the MCP connects again with a new ticket.
  const b = await call(3);
  assert.ok(b.status === 200 && b.body.result, b.text);
  assert.equal(starts(x), 2, "the tool call started Chrome again");
  assert.notEqual(x.w.named("chromium")[0].pid, pid1, "a new Chrome");
  assert.equal(minted, 2, "a new ticket for the new connection");
  await until(() => conns() === 1, "the MCP's own connection to the new Chrome");
  // The session's end while Chrome is off (a DELETE) starts nothing.
  (part as any).idleMinutes = 0.02;
  await until(() => !part.unit.running(), "the second stop by use", 15_000);
  await until(() => conns() === 0, "the second stop's end", 15_000);
  const del = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${tok.token}`, "Mcp-Session-Id": sid }, signal: AbortSignal.timeout(30_000) });
  assert.equal(del.status, 200, await del.text());
  assert.deepEqual([starts(x), part.unit.running()], [2, false], "a DELETE at the session's end starts nothing");
});

test("P1, board ab-b84.33: a tool call right after a stop by use, before the stopped Chrome's own link goes down (a late link down), starts Chrome again, and the MCP's browser connects again with a new ticket", { skip: process.platform !== "linux", timeout: 120_000 }, async (t) => {
  const tok = control.testTokens[0];
  // The stopped Chrome's link goes down 30 s late: before the fix, a call in that time reached the MCP's old browser
  // connection, with no start and no new ticket.
  const x = await svc(t, { lists: { "owner.repo": ["a.example"] }, mcp: true, linkDownMs: 30_000 });
  const conns = () => (x.agent as any).relay.model.connectionCount as number;
  const part = x.part!;
  await x.sessions([session("web-1", "owner/repo", me(), { lifetime_id: "lt-1", mcp_token: tok.fingerprint })]);
  let minted = 0;
  const mint = x.mcp!.tickets.mint.bind(x.mcp!.tickets);
  x.mcp!.tickets.mint = (scope: string) => { minted++; return mint(scope); };
  const url = `http://127.0.0.1:${x.mcp!.mcpPort!.port}/mcp/web-1`;
  const post = async (body: object, sid?: string) => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${tok.token}`, ...(sid ? { "Mcp-Session-Id": sid } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const text = await r.text();
    return { status: r.status, sid: r.headers.get("mcp-session-id"), body: text ? JSON.parse(text) : null, text };
  };
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  assert.equal(init.status, 200, init.text);
  const sid = init.sid!;
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  const call = (id: number) => post({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "browser_tabs", arguments: { action: "list" } } }, sid);
  const a = await call(2);
  assert.ok(a.status === 200 && a.body.result, a.text);
  assert.deepEqual([starts(x), minted, conns()], [1, 1, 1], "the first call started Chrome, and the MCP's browser connected with a ticket");
  const pid1 = x.w.named("chromium")[0].pid;
  (part as any).idleMinutes = 0.02; // 1.2 s
  // The stop by use ends: its `stopped` went out, and the stop runs no more.
  await until(() => (x.state.status() as any).last_stop?.reason === "idle" && !part.idleStopping, "the stop by use", 15_000);
  (part as any).idleMinutes = 10;
  // The next tool call, long before the late link down.
  const b = await call(3);
  assert.ok(b.status === 200 && b.body.result, b.text);
  assert.equal(starts(x), 2, "the tool call started Chrome again");
  assert.notEqual(x.w.named("chromium")[0]?.pid, pid1, "a new Chrome");
  assert.equal(minted, 2, "a new ticket for the new connection");
  await until(() => conns() === 1, "the MCP's own connection to the new Chrome");
});

test("P1 and O2: the MCP's own ticket connection is no use, neither open nor by its messages; an agent's open connection counts by being open and by its messages", { timeout: 30_000 }, async () => {
  const { Tickets } = await import("../src/service/mcp/ticket.ts");
  const { PeerGate } = await import("../src/relay/peer.ts");
  const reader = { form: "stat", peer: () => ({ pid: process.pid, uid: 1001, pidfd: null, start: 77 }), proc: (p: number) => (p === process.pid ? { ppid: 1, start: 77, state: "S" } : null), cgroup: () => null, poll: () => 0, fdinfoPid: () => null, close: () => {} };
  const tickets = new Tickets();
  const h = await harness({ peerCheck: new PeerGate({ reader: reader as any, uid: 1001 }), tickets } as any);
  try {
    await h.ready({ t: "allowlist", lists: { a: ["a.example"] }, scopes: { "web-1": "a" }, default: null });
    const own = await CDPConnection.connect(`${h.url("web-1")}?ticket=${tickets.mint("web-1")}`);
    assert.deepEqual([h.relay.traffic().agents, h.relay.traffic().busy], [0, 0], "the MCP's own connection is no agent's");
    assert.equal(h.relay.traffic().quietFor, Infinity);
    await own.send("Browser.getVersion");
    assert.deepEqual([h.relay.traffic().busy, h.relay.traffic().quietFor], [0, Infinity], "its messages are no use (review-120b O2): its tool calls count");
    await own.close();
  } finally { await h.close(); }
  const h2 = await harness();
  try {
    await h2.ready();
    const c = await h2.connect("s1");
    assert.equal(h2.relay.traffic().agents, 1, "an agent's open connection");
    await c.send("Browser.getVersion");
    assert.ok(h2.relay.traffic().quietFor < 1000, "an agent's message counts");
    await c.close();
    await until(() => h2.relay.traffic().agents === 0, "the close");
  } finally { await h2.close(); }
});

// ------------------------------------------------------------------ review-120 B3: a client that leaves while it waits

test("B3: a client that resets while its upgrade waits does not crash or stop the service: no connection opens for it, and the next client connects", { timeout: 30_000 }, async () => {
  let release!: (r: [number, string] | null) => void;
  const calls: string[] = [];
  const h = await harness({ use: { stopping: () => false, wake: (scope) => { calls.push(scope); return new Promise((r) => { release = r; }); } } });
  try {
    for (const answer of ["503", "101"] as const) {
      const s = connect(h.socket);
      s.on("error", () => {});
      await new Promise((r) => s.once("connect", r));
      s.write("GET /devtools/browser/s1 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
      await until(() => calls.length > 0, "the wait");
      s.destroy();
      await sleep(30);
      if (answer === "101") await h.ready();
      release(null);
      await until(() => h.relay.model.connectionCount === 0, `${answer}: no connection for the client that left`, 2000);
      calls.length = 0;
    }
    const c = await h.connect("s1");
    assert.match((await c.send("Browser.getVersion")).product, /Chrome/, "the relay goes on");
    await c.close();
    // An upgrade that still waits when the relay stops: its socket closes, and the stop ends.
    h.fake.line({ t: "link", up: false });
    await until(() => h.relay.model.notReady() !== null, "the link to drop");
    const late = connect(h.socket);
    late.on("error", () => {});
    const gone = new Promise((r) => late.once("close", r));
    await new Promise((r) => late.once("connect", r));
    late.write("GET /devtools/browser/s1 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    await until(() => calls.length > 0, "the late wait");
    const closing = h.close();
    assert.equal(await Promise.race([closing.then(() => "closed"), sleep(5000).then(() => "hangs")]), "closed", "the stop does not wait for the upgrade");
    await gone;
    return;
  } finally { await h.close(); }
});

test("B3: a client that leaves while its MCP tool call waits for the start at a use does not crash or stop the port: its call never reaches the MCP, and the next request gets its answer", { timeout: 30_000 }, async () => {
  let ready: McpReadiness = { controlOff: false, notReady: NOT_READY.link, sites: null };
  let release!: (r: string | null) => void;
  let waits = 0;
  const p = await mcpPort(() => ready, { refusal: () => null, wake: () => { waits++; return new Promise((r) => { release = r; }); } });
  try {
    // The port's fake reader takes this connection as md-lead's (the vectors' world).
    p.reader.pending.push([3102]);
    const s = connect({ host: "127.0.0.1", port: p.port.port });
    s.on("error", () => {});
    await new Promise((r) => s.once("connect", r));
    s.write(`GET /mcp/md-lead HTTP/1.1\r\nhost: 127.0.0.1:${p.port.port}\r\nauthorization: Bearer ${T.leadRun2.token}\r\nx-tool: call\r\n\r\n`);
    await until(() => waits === 1, "the tool call's wait");
    s.resetAndDestroy();
    await sleep(30);
    ready = { controlOff: false, notReady: null, sites: 2 };
    release(null);
    await sleep(100);
    assert.deepEqual(p.forwarded, [], "the call of the client that left never reached the MCP");
    assert.deepEqual(await p.ask(true), { status: 200, body: OK }, "the port goes on");
  } finally { await p.port.stop(); }
});

test("note 1: the limit of a request's wait covers the whole wait: the end of a stop by use, and the start", async () => {
  const r = await rig({ useWaitMs: 40 });
  try {
    await config(r);
    await r.part.wake(running(r));
    // A stop by use that holds: the request goes on after its limit, while the stop still runs.
    const stop = r.part.unit.stop.bind(r.part.unit);
    let go!: () => void;
    const held = new Promise<void>((x) => { go = x; });
    r.part.unit.stop = async () => { await held; return stop(); };
    r.w.now += 10 * MIN;
    await until(() => r.part.idleStopping, "the stop by use to run");
    const at = Date.now();
    assert.equal(await r.part.wake(running(r)), null);
    assert.ok(Date.now() - at < 1000 && r.part.idleStopping, "it went on while the stop runs");
    assert.deepEqual(r.part.usedBy(), []);
    go();
    await until(() => !r.part.idleStopping, "the stop's end");
    // A start that holds (its owner check waits): the request goes on after its limit, and the start goes on.
    let pass!: () => void;
    const gate = new Promise<void>((x) => { pass = x; });
    const check = (r.part as any).o.owner.check.bind((r.part as any).o.owner);
    (r.part as any).o.owner.check = async (what: string) => { if (what === "a start") await gate; return check(what); };
    const at2 = Date.now();
    assert.equal(await r.part.wake(running(r)), null);
    assert.ok(Date.now() - at2 < 1000 && !r.part.unit.running(), "it went on while the start waits");
    pass();
    await until(() => r.part.unit.running(), "the start goes on and ends");
  } finally { await r.close(); }
});

test("note 3: a daemon stop during the install wait of a start at a use is the daemon's stop: no start_failed, no last start's failure, no hold-off", async () => {
  // The install's polls of 500 ms (virtual) take 5 ms of real time, so the stop comes during the wait.
  const r = await rig({ before: (_w, tools) => { tools.versions = []; }, sleep: async (w, ms) => { if (ms === 500) await sleep(5); w.now += ms; await new Promise((x) => setImmediate(x)); } });
  try {
    await config(r, { chrome_bin: null });
    const woke = r.part.wake(running(r));
    await until(() => r.tools.pending !== null, "the install");
    await req(r.c, "stop", TOKEN);
    r.tools.pending!.resolve();
    assert.equal(await woke, null, "the request gets that moment's answer");
    await sleep(30);
    assert.equal(events(r.c, "stopped").length, 0, "no start_failed");
    const s = await status(r.c);
    assert.ok(!s.operator_text.includes("The last start at an agent's use failed"), s.operator_text);
    assert.ok(r.logs.includes("unit: a stop came during the start at an agent's use; it stays stopped"));
    assert.equal(await r.part.wake(running(r)), null);
    assert.equal(r.part.unit.running(), true, "no hold-off: the next use starts Chrome");
  } finally { await r.close(); }
});

test("note 4: an import gives a start that failed at its use the send's error at once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-use-send2-"));
  const port: ReceiverPort = { attach: () => {}, isUp: () => false, request: async () => ({}), allowlist() {}, endScope() {} };
  const s = new Stage1c({ listsFolder: join(dir, "lists"), stateFolder: join(dir, "state"), receiver: port, log: () => {}, wake: async () => "The agent browser could not get ready: Xvfb not found on PATH." });
  try {
    s.setSessions({ t: "req", id: "s", op: "set_sessions", by: DAEMON, sessions: [], remote: [], box: { hosts: ["box.example"], cookie_names: [] } } as any);
    const payload = { v: 1, domain: "example.com", url: "https://www.example.com/", origin: "https://www.example.com", cookies: [], storage: { local: {}, session: {}, idb: [], caches: [] } };
    const at = Date.now();
    const a = await s.ops.import({ t: "req", id: "i", op: "import", by: { kind: "operator", user: "ann", via: "send" }, payload } as any);
    assert.deepEqual(a, { error: "The sign-in for example.com was not sent: the agent browser could not get ready: Xvfb not found on PATH." });
    assert.ok(Date.now() - at < 2000, "at once, with no wait for the receiver");
  } finally { s.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("note 5: after a crash the supervisor's backoff stays for a use: the request waits for the supervisor's start, and its restart does not reset the grace time", async () => {
  const r = await rig();
  try {
    await config(r);
    await r.part.wake(running(r));
    const first = r.w.named("chromium")[0];
    r.w.now += 9 * MIN;
    r.w.end(first.pid); // a crash: the record still wants Chrome
    await until(() => r.part.state() === "starting" || !r.part.unit.running(), "the crash");
    const woke = r.part.wake(running(r));
    assert.equal(await woke, null);
    const second = r.w.named("chromium");
    assert.equal(second.length, 1);
    assert.ok(r.w.logs.some((l) => /is gone; starting it again in 1 s/.test(l)), "the supervisor's backoff");
    assert.equal(r.logs.filter((l) => l === "unit: an agent uses the agent browser; starting Chrome").length, 1, "the use started no Chrome of its own");
    assert.equal(r.w.spawned.filter((p) => p.argv[0].endsWith("chromium")).length, 2);
  } finally { await r.close(); }
  const r2 = await rig();
  try {
    await config(r2);
    await r2.part.wake(running(r2));
    r2.w.now += 9 * MIN;
    const first = r2.w.named("chromium")[0];
    r2.w.end(first.pid);
    await r2.c.next((l) => l.ev === "ready" && l.chrome_pid !== first.pid, 10_000);
    r2.w.now += MIN;
    await r2.c.next((l) => l.ev === "stopped" && l.reason === "idle", 5000);
  } finally { await r2.close(); }
});

test("note 11: a config that changed clears the hold-off of a failed start; the same config does not", async () => {
  const r = await rig();
  try {
    await config(r, { chrome_bin: "/usr/bin/nochromium" });
    const text = useFailed("Chromium not found: /usr/bin/nochromium");
    assert.equal(await r.part.wake(running(r)), text);
    await config(r, { chrome_bin: "/usr/bin/nochromium" });
    assert.equal(await r.part.wake(running(r)), text, "the same config: still the hold-off");
    assert.equal(r.logs.filter((l) => l === "unit: an agent uses the agent browser; starting Chrome").length, 1);
    await config(r);
    assert.equal(await r.part.wake(running(r)), null, "a changed config: a new start at once");
    assert.equal(r.part.unit.running(), true);
  } finally { await r.close(); }
});
