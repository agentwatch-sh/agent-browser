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
import { harness, lineOf, raw, until } from "./fake-bridge.ts";
import { FakeTools, World } from "./fake-unit-world.ts";

const TOKEN = { kind: "token", user: "ann", via: "cli" };
const DAEMON = { kind: "daemon", user: "ann", via: "daemon" };
const CONFIG = { t: "req", id: "cfg", op: "config", by: { kind: "daemon", user: "ann", via: "config" }, enabled: true, control: true, chrome_bin: "/usr/bin/chromium", chrome_args: [] };
const ACTIVE: UnitState = { active: "active", sub: "running", mainPid: process.pid };
const MIN = 60_000;
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
async function rig(o: { before?: (w: World, tools: FakeTools) => void } = {}): Promise<Rig> {
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
    unit: { ...w.deps(tools, { displays: { first: 173, last: 175 } }) },
    clock: () => w.now, wall: () => Date.UTC(2026, 10, 11, 12, 0, 0) + w.now - 1_000_000,
    superviseMs: 10, watchMs: 5, watchLimitMs: 100 * 3_600_000, firstCheckMs: 100 * 3_600_000,
    use: { now: () => [...use.now], quietFor: () => (use.lastRequest === null ? Infinity : w.now - use.lastRequest) },
    usePollMs: 2,
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
    r.w.now += USE_RETRY_MS;
    assert.equal(await r.part.wake(running(r)), null, "a start that works");
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

test("after a fail-closed stop a use starts Chrome again (the operator's texts name no start on the Browser page)", async () => {
  const r = await rig();
  try {
    await config(r);
    (r.part.watch as any).d.limitMs = 60_000;
    await r.part.wake(running(r));
    r.use.now = ["client"];
    await ticks(); // the watch's first check sees this Chrome
    r.w.now += 61_000;
    await r.c.next((l) => l.ev === "stopped" && l.reason === "receiver_missing");
    const s = await status(r.c);
    assert.equal(s.state, "failed closed");
    assert.match(s.operator_text, /The next use by an agent starts it again\./);
    assert.doesNotMatch(s.operator_text, /Browser page/);
    assert.equal(await r.part.wake(running(r)), null);
    assert.equal(r.part.unit.running(), true);
  } finally { await r.close(); }
});

// ------------------------------------------------------------------ the endpoint's wait (src/relay/endpoint.ts)

test("the endpoint: an upgrade that finds the link down waits for the service's start at a use, then the checks run again and the client connects; the wait's text, when a start fails, is its 503", async () => {
  const calls: string[] = [];
  let answer: string | null = null;
  let up: (() => Promise<void>) | null = null;
  const h = await harness({ use: { stopping: () => false, wake: async (scope) => { calls.push(scope); if (answer === null) await up!(); return answer; } } });
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
async function mcpPort(readiness: () => McpReadiness, wake: (scope: string) => Promise<string | null>) {
  const r = new WorldReader();
  const seen: string[] = [];
  const handler: McpHandler = { request(_req, res, scope) { seen.push(scope); res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(OK) }).end(OK); }, endSessions() {} };
  const port = await McpPort.open({ listen: { port: 0 }, handler, readiness, wake, log: () => {}, reader: r, uid: UID });
  r.service = `127.0.0.1:${port.port}`;
  port.listener.prependListener("connection", (s: Socket) => r.accepted(`127.0.0.1:${s.remotePort}`));
  port.setSessions({ sessions: V.mcpSnapshots.tokens.sessions } as any);
  const ask = async (): Promise<{ status: number; body: string }> => {
    r.pending.push([3102]);
    const s = connect({ host: "127.0.0.1", port: port.port });
    s.on("error", () => {});
    let buf = "";
    s.on("data", (d) => { buf += d; });
    s.write(`GET /mcp/md-lead HTTP/1.1\r\nhost: 127.0.0.1:${port.port}\r\nauthorization: Bearer ${T.leadRun2.token}\r\n\r\n`);
    await until(() => /\r\n\r\n/.test(buf) && buf.length >= buf.indexOf("\r\n\r\n") + 4 + Number(/content-length: (\d+)/i.exec(buf)?.[1] ?? 0), "the answer", 10_000);
    s.destroy();
    return { status: Number(buf.split(" ")[1]), body: buf.slice(buf.indexOf("\r\n\r\n") + 4) };
  };
  return { port, seen, ask };
}

test("the MCP path: a request that step 8 refuses for a link that is down waits for the start at a use, then steps 3 to 8 run again and the handler answers; a failed start's text is the 503 of step 8", async () => {
  let ready: McpReadiness = { controlOff: false, notReady: NOT_READY.link, sites: null };
  const calls: string[] = [];
  let answer: string | null = null;
  const p = await mcpPort(() => ready, async (scope) => { calls.push(scope); await sleep(30); if (answer === null) ready = { controlOff: false, notReady: null, sites: 2 }; return answer; });
  try {
    assert.deepEqual(await p.ask(), { status: 200, body: OK });
    assert.deepEqual([calls, p.seen], [["md-lead"], ["md-lead"]]);
    ready = { controlOff: false, notReady: NOT_READY.allowlist, sites: null };
    answer = "The agent browser could not get ready: Xvfb not found on PATH.";
    assert.deepEqual(await p.ask(), { status: 503, body: answer });
    assert.equal(calls.length, 2);
  } finally { await p.port.stop(); }
});

test("the MCP path: no wait for control off, an extension too old, or a scope with no list", async () => {
  const calls: string[] = [];
  for (const [ready, body] of [
    [{ controlOff: true, notReady: NOT_READY.link, sites: null }, MCP_TEXT.controlOff],
    [{ controlOff: false, notReady: NOT_READY.old, sites: null }, NOT_READY.old],
    [{ controlOff: false, notReady: null, sites: null }, NOT_READY.noList],
  ] as [McpReadiness, string][]) {
    const p = await mcpPort(() => ready, async (scope) => { calls.push(scope); return null; });
    try { assert.deepEqual(await p.ask(), { status: 503, body }); } finally { await p.port.stop(); }
  }
  assert.deepEqual(calls, []);
});

// ------------------------------------------------------------------ the send (stage1c.ts)

test("a send needs the browser: each import calls the start at a use before its wait for the receiver", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-use-send-"));
  let up = false;
  let events: { up(): void } | null = null;
  const port: ReceiverPort = {
    attach: (e) => { events = e; }, isUp: () => up,
    request: async () => ({ cookies_set: 1, errors: [] }), allowlist() {}, endScope() {},
  };
  let woke = 0;
  const s = new Stage1c({ listsFolder: join(dir, "lists"), stateFolder: join(dir, "state"), receiver: port, log: () => {}, wake: () => { woke++; setTimeout(() => { up = true; events!.up(); }, 20); } });
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
    const { FakeReceiver } = await import("./fake-bridge.ts");
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
    // A bridge request that runs: the fake receiver holds its answer.
    fr.op = (q) => (q.op === "tabs.query" ? new Promise(() => {}) : undefined);
    const model = (s.agent as any).relay.model;
    void model.bridge.call("tabs.query", [{}]).catch(() => {});
    await until(() => part.usedBy().includes("request"), "the request");
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

test("the service with its MCP path: an MCP session is a use; the MCP path has the start at a use; its readiness counts a stop by use that runs as a link that is down", { skip: process.platform !== "linux", timeout: 30_000 }, async (t) => {
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
    assert.equal(typeof port.o.wake, "function", "the MCP path has the start at a use");
    // An MCP session (the transport's count) is a use.
    assert.deepEqual(s.part!.usedBy(), []);
    (s.mcp!.mcpTransport as any).size = () => 1;
    assert.deepEqual(s.part!.usedBy(), ["mcp"], "an MCP session");
  } finally { await s.stop(); }
});
