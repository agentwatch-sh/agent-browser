// Board ab-v16.81: a start moves the agent extension to the staged CRX (C12, the agent package). On Linux the service
// stages the receiver's CRX through Chrome's external extensions file, and while the old receiver runs Chrome installs a
// newer CRX only at its next start (a delayed install: the old receiver holds its native port, so it never goes idle).
// So a start of a new Google Chrome with a staged package waits for the first hello of that Chrome, and a hello older
// than the package starts Chrome once more (agentwatch's _start_unit). In a fake world (test/fake-unit-world.ts): no
// real Chrome, Xvfb or link; the test's link counts the hellos that the test's receiver says.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { NOT_READY } from "../src/relay/model.ts";
import type { McpReadiness } from "../src/service/mcp/admission.ts";
import { startService } from "../src/service/service.ts";
import { Owner, type UnitState } from "../src/service/unit/owner.ts";
import * as Part from "../src/service/unit/part.ts";
import type { MacStart } from "../src/service/unit/mac-chrome.ts";
import type { LinkPort } from "../src/service/unit/watch.ts";
import { raw } from "./fake-bridge.ts";
import { sleep } from "./fake-daemon.ts";
import { FakeTools, World } from "./fake-unit-world.ts";
import { tempDir } from "./temp-dirs.ts";

// Tests first: the new names are read from the module, so this file loads before they exist.
const P = Part as Record<string, any>;
const { STATE_TEXTS, UnitPart, useFailed } = Part;
const ACTIVE: UnitState = { active: "active", sub: "running", mainPid: process.pid };
const TOKEN = { kind: "token", user: "ann", via: "cli" } as const;
const STAGED = "0.3.11";
const LINUX_GOOGLE = { enabled: true, chrome_bin: null, chrome_args: [] };
const CHROMIUM = { enabled: true, chrome_bin: "/usr/bin/chromium", chrome_args: [] };

async function until<T>(fn: () => T, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}

/** The test's receiver on the test's link: each hello counts; a stop of Chrome drops the link (linkDown). */
type Recv = { count: number; version: string | null };
type Rig = {
  w: World; part: Part.UnitPart; tools: FakeTools; logs: string[]; events: Record<string, unknown>[]; recv: Recv; link: LinkPort;
  hello: (v: string) => void; chromes: () => number[]; owns: { yes: boolean }; close: () => Promise<void>;
};

/** The fake `open` of the Mac (test/service-mac.test.ts): it adds the new Chrome as launchd's child; `opens` counts. */
function fakeMac(w: World, opens = { n: 0 }): MacStart {
  const bin = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return {
    app: (b) => ({ binary: b || bin, bundle: "/Applications/Google Chrome.app", version: "156.0.8078.80", google: !b }),
    open: async (_bundle, args) => { opens.n++; w.add({ argv: [bin, ...args], ppid: 1 }); return 0; },
    guard: async () => ({ finish: async () => {} }),
  };
}

/** An owner whose check for `what` waits until the test lets it go; each other check says yes at once (review-200 B1). */
function heldOwner(what: string) {
  let release!: () => void, held = false;
  const gate = new Promise<void>((r) => { release = r; });
  const owner = { check: async (w: string) => { if (w === what) { held = true; await gate; } return true; } } as unknown as Owner;
  return { owner, held: () => held, release: () => release() };
}

async function rig(o: { config?: Record<string, unknown>; prepare?: () => string; mac?: boolean; useWaitMs?: number; owner?: Owner } = {}): Promise<Rig> {
  const w = new World();
  const tools = new FakeTools();
  tools.root = w.paths.chromes;
  tools.versions = ["158.0.7100.1-1"];
  const logs: string[] = [];
  const events: Record<string, unknown>[] = [];
  const owns = { yes: true };
  const recv: Recv = { count: 0, version: null };
  const link: LinkPort & { hellos(): number; version(): string | null } = {
    ready: () => recv.version !== null, confirmed: () => recv.version !== null, busy: () => false, scopesReady: () => recv.version !== null,
    hellos: () => recv.count, version: () => recv.version,
  };
  const part = new UnitPart({
    paths: w.paths, procs: w.procs, tools, log: (l) => logs.push(l),
    owner: o.owner ?? new Owner(async () => (owns.yes ? ACTIVE : { ...ACTIVE, active: "inactive" }), (l) => logs.push(l)),
    endpoint: () => ({ form: "pidfd" }), sessionsComplete: () => true,
    unit: {
      ...w.deps(tools, { displays: { first: 173, last: 175 }, prepare: { run: o.prepare ?? (() => STAGED), lastFile: () => null } }),
      ...(o.mac ? { mac: fakeMac(w) } : {}),
    },
    clock: () => w.now, wall: () => Date.UTC(2026, 10, 17, 12, 0, 0) + w.now - 1_000_000,
    superviseMs: 10, watchMs: 5, watchLimitMs: 100 * 3_600_000, firstCheckMs: 100 * 3_600_000,
    link, extensionVersion: () => recv.version ?? part.unit.stagedPackage(), linkDown: () => { recv.version = null; },
    usePollMs: 2, useWaitMs: o.useWaitMs,
  });
  part.attach((ev) => events.push(ev));
  part.onConfig(o.config ?? LINUX_GOOGLE);
  await part.begin();
  const chromes = () => w.spawned.filter((p) => !p.argv[0].endsWith("Xvfb")).map((p) => p.pid);
  return {
    w, part, tools, logs, events, recv, link, owns, chromes,
    hello: (v) => { recv.count++; recv.version = v; },
    close: async () => { await part.stop(); w.close(); },
  };
}

/** The receiver of each new Chrome says the next version of `says` once that Chrome runs (null: it says nothing). */
function receiver(r: Rig, says: (string | null)[]): () => void {
  let last: number | null = null;
  const t = setInterval(() => {
    const id = r.part.unit.chromeId();
    if (!id || id.pid === last) return;
    last = id.pid;
    const v = says.shift();
    if (typeof v === "string") r.hello(v);
  }, 1);
  return () => clearInterval(t);
}

/** Let the part's clock run (one second each 2 ms of real time) until `p` settles; at most `maxMs` of the part's time. */
async function pump<T>(r: Rig, p: Promise<T>, maxMs = 40_000): Promise<T> {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  for (let t = 0; !done && t < maxMs; t += 1000) { await sleep(2); r.w.now += 1000; }
  return p;
}

const ofKind = (r: Rig, ev: string) => r.events.filter((e) => e.ev === ev);
const MOVE_LINE = (said: string) => `unit: the agent extension ${said} waits for Chrome's next start (the staged package is ${STAGED}); starting Chrome once more`;
const STILL_LINE = (said: string) => `unit: warning: the agent extension did not move to ${STAGED} at Chrome's next start (its hello says ${said}); Chrome does not start again`;

test("board ab-v16.81: the versions compare as dotted integers (a missing part is 0); a version that is not dotted integers, on either side, is never older", () => {
  const older = (a: string | null, b: string | null): boolean => P.extensionOlder(a, b);
  assert.equal(typeof P.extensionOlder, "function");
  for (const [a, b] of [["0.3.10", "0.3.11"], ["0.3.9", "0.3.10"], ["0.2", "0.3.11"], ["0.3", "0.3.0.1"], ["1", "1.0.0.1"]]) assert.equal(older(a, b), true, `${a} < ${b}`);
  for (const [a, b] of [["0.3.11", "0.3.11"], ["0.3.12", "0.3.11"], ["0.3", "0.3.0"], ["0.3.0.0", "0.3"], ["1.0", "0.9.9"]]) assert.equal(older(a, b), false, `${a} >= ${b}`);
  for (const [a, b] of [["dev", "0.3.11"], ["0.3.10", "x"], ["0.3.10-beta", "0.3.11"], ["0.3.10", "0.3.11.1.2"], ["", "0.3.11"], [null, "0.3.11"], ["0.3.10", null], [" 0.3.10", "0.3.11"]]) assert.equal(older(a, b), false, `${a} / ${b}: never older`);
  assert.equal(P.RECEIVER_HELLO_WAIT_MS, 30_000);
});

test("board ab-v16.81: an older first hello gives exactly one more start; one ready (of the second Chrome), no stopped; the log line; the start answers {}", async () => {
  const r = await rig();
  const stop = receiver(r, ["0.3.10", STAGED]);
  try {
    assert.deepEqual(await r.part.startBrowser(TOKEN), { data: {} });
    const pids = r.chromes();
    assert.equal(pids.length, 2, "one more start");
    assert.equal(r.w.alive(pids[0]), false, "the first Chrome is gone");
    assert.equal(r.part.unit.chromePid(), pids[1]);
    const ready = ofKind(r, "ready");
    assert.equal(ready.length, 1, "one ready");
    assert.equal(ready[0].chrome_pid, pids[1], "the ready of the second Chrome");
    assert.equal(ready[0].extension_version, STAGED);
    assert.deepEqual(ofKind(r, "stopped"), [], "no stopped event");
    assert.equal(r.logs.filter((l) => l === MOVE_LINE("0.3.10")).length, 1, r.logs.join("\n"));
    assert.equal(r.logs.filter((l) => l.includes("did not move")).length, 0);
    assert.equal(r.part.state(), "ready");
    assert.equal(r.part.startHolds, false, "no start runs now");
  } finally { stop(); await r.close(); }
});

test("board ab-v16.81: an equal, a newer or an unparsable hello gives no second start; the ready of the first Chrome", async () => {
  for (const said of [STAGED, "0.3.12", "0.4", "dev"]) {
    const r = await rig();
    const stop = receiver(r, [said]);
    try {
      assert.deepEqual(await r.part.startBrowser(TOKEN), { data: {} });
      assert.equal(r.chromes().length, 1, `${said}: no second start`);
      assert.equal(ofKind(r, "ready").length, 1);
      assert.equal(ofKind(r, "ready")[0].chrome_pid, r.chromes()[0]);
      assert.equal(r.logs.filter((l) => l.includes("waits for Chrome's next start")).length, 0);
    } finally { stop(); await r.close(); }
  }
});

test("board ab-v16.81: no hello in time (RECEIVER_HELLO_WAIT_MS): no second start, and the start answers with its ready", async () => {
  const r = await rig();
  try {
    const p = r.part.startBrowser(TOKEN);
    await until(() => r.part.unit.running(), "the first Chrome");
    await sleep(30);
    assert.equal(ofKind(r, "ready").length, 0, "no ready while the start waits for the hello");
    assert.equal(r.part.state(), "starting", "the state while the start waits");
    assert.equal(r.part.startHolds, true, "a new connection waits while the start runs");
    assert.deepEqual(await pump(r, p), { data: {} });
    assert.equal(r.chromes().length, 1);
    assert.equal(ofKind(r, "ready").length, 1);
    assert.equal(r.part.unit.running(), true);
  } finally { await r.close(); }
});

test("board ab-v16.81: a second hello that is still older gives one warning line, and no third start (never a loop)", async () => {
  const r = await rig();
  const stop = receiver(r, ["0.3.10", "0.3.10", "0.3.10"]);
  try {
    assert.deepEqual(await r.part.startBrowser(TOKEN), { data: {} });
    assert.equal(r.chromes().length, 2);
    assert.equal(r.logs.filter((l) => l === MOVE_LINE("0.3.10")).length, 1);
    assert.equal(r.logs.filter((l) => l === STILL_LINE("0.3.10")).length, 1, r.logs.join("\n"));
    assert.equal(ofKind(r, "ready").length, 1);
    assert.equal(ofKind(r, "ready")[0].chrome_pid, r.chromes()[1]);
    await sleep(60);
    assert.equal(r.chromes().length, 2, "nothing more starts");
  } finally { stop(); await r.close(); }
});

test("board ab-v16.81: a stop op, enabled false or the part's close during the wait for a hello keeps Chrome stopped; no ready of the first Chrome", async () => {
  // The stop op during the first wait.
  let r = await rig();
  try {
    const p = r.part.startBrowser(TOKEN);
    await until(() => r.part.unit.running(), "the first Chrome");
    await sleep(20);
    assert.deepEqual(await r.part.stopBrowser(TOKEN), { data: {} });
    assert.deepEqual(await p, { data: {} });
    assert.equal(r.part.unit.running(), false);
    assert.equal(r.chromes().length, 1, "no second start");
    assert.equal(ofKind(r, "ready").length, 0);
    assert.deepEqual(ofKind(r, "stopped").map((e) => e.reason), ["stop"]);
    await sleep(40);
    assert.equal(r.part.unit.running(), false, "it stays stopped");
  } finally { await r.close(); }
  // The stop op during the wait for the second Chrome's hello.
  r = await rig();
  let stop = receiver(r, ["0.3.10", null]);
  try {
    const p = r.part.startBrowser(TOKEN);
    await until(() => r.chromes().length === 2 && r.part.unit.running(), "the second Chrome");
    await sleep(20);
    assert.deepEqual(await r.part.stopBrowser(TOKEN), { data: {} });
    assert.deepEqual(await p, { data: {} });
    assert.equal(r.part.unit.running(), false);
    assert.equal(r.chromes().length, 2);
    assert.equal(ofKind(r, "ready").length, 0);
  } finally { stop(); await r.close(); }
  // enabled false during the first wait.
  r = await rig();
  try {
    const p = r.part.startBrowser(TOKEN);
    await until(() => r.part.unit.running(), "the first Chrome");
    await sleep(20);
    r.part.onConfig({ ...LINUX_GOOGLE, enabled: false });
    assert.deepEqual(await p, { data: {} });
    await until(() => !r.part.unit.running(), "the stop of enabled false");
    await sleep(40);
    assert.equal(r.chromes().length, 1);
    assert.equal(ofKind(r, "ready").length, 0);
  } finally { await r.close(); }
  // The part's close during the first wait: the start ends, Chrome runs on for the next owner, no ready.
  r = await rig();
  try {
    const p = r.part.startBrowser(TOKEN);
    await until(() => r.part.unit.running(), "the first Chrome");
    await sleep(20);
    await r.part.stop();
    await p;
    assert.equal(r.chromes().length, 1);
    assert.equal(ofKind(r, "ready").length, 0);
  } finally { await r.close(); }
  // The owner rule says no at the second start: Chrome stays stopped, and the start answers the owner's text.
  r = await rig();
  stop = receiver(r, ["0.3.10"]);
  try {
    let n = 0;
    const start = r.part.unit.start.bind(r.part.unit);
    r.part.unit.start = async (o) => { if (++n === 2) r.owns.yes = false; return start(o); };
    assert.deepEqual(await r.part.startBrowser(TOKEN), { error: Part.NOT_OWNER });
    assert.equal(r.part.unit.running(), false);
    assert.equal(r.chromes().length, 1);
    assert.equal(ofKind(r, "ready").length, 0);
  } finally { stop(); await r.close(); }
});

test("board ab-v16.81: a failed second start at a use is a failed start (the use's error, one stopped start_failed), not a stop that came during the start", async () => {
  // A start error passes its own text.
  let r = await rig({ prepare: (() => { let n = 0; return () => { if (++n === 2) throw new Error("the agent extension could not be written: ENOSPC"); return STAGED; }; })() });
  let stop = receiver(r, ["0.3.10"]);
  try {
    const why = await r.part.wake(() => r.link.ready());
    assert.match(String(why), /^The agent browser could not get ready: Google Chrome could not be set up: the agent extension could not be written: ENOSPC/);
    assert.deepEqual(ofKind(r, "stopped").map((e) => e.reason), ["start_failed"]);
    assert.equal(ofKind(r, "ready").length, 0);
    assert.ok(r.logs.some((l) => l.startsWith("unit: the start at an agent's use failed: ")), r.logs.join("\n"));
    assert.ok(!r.logs.some((l) => l.includes("a stop came during the start")));
    assert.ok(r.part.notes().operator.some((l) => l.startsWith("The last start at an agent's use failed: ")));
  } finally { stop(); await r.close(); }
  // Any other error: the move's text, with the error's kind only.
  r = await rig();
  stop = receiver(r, ["0.3.10", "0.3.10"]);
  try {
    let n = 0;
    const start = r.part.unit.start.bind(r.part.unit);
    r.part.unit.start = async (o) => { if (++n === 2) throw new TypeError("a secret /path"); return start(o); };
    const text = `the agent browser could not start Chrome again to move the agent extension to ${STAGED} (TypeError)`;
    assert.equal(await r.part.wake(() => r.link.ready()), useFailed(text));
    assert.deepEqual(ofKind(r, "stopped").map((e) => e.reason), ["start_failed"]);
    assert.ok(r.logs.includes(`unit: ${text}`));
    assert.ok(!r.logs.some((l) => l.includes("a secret")));
    assert.ok(!r.logs.some((l) => l.includes("a stop came during the start")));
    assert.equal(P.extensionMoveFailed("stop", STAGED, "Error"), `the agent browser could not stop Chrome to move the agent extension to ${STAGED} (Error)`);
    // The op start gets the same text as its answer.
    n = 0;
    assert.deepEqual(await r.part.startBrowser(TOKEN), { error: text });
  } finally { stop(); await r.close(); }
});

test("board ab-v16.81: a request that comes during the move waits for the final Chrome, also when its check says ready at once (the old receiver links and confirms); an op start during the move joins it", async () => {
  const r = await rig();
  try {
    const p = r.part.startBrowser(TOKEN);
    const first = await until(() => r.part.unit.chromePid(), "the first Chrome");
    r.hello("0.3.10"); // the old receiver links and confirms quickly
    assert.equal(r.part.startHolds, true, "the agent door and the MCP path count the link as down");
    let at: { pid: number | null; version: string | null } | null = null;
    const woke = r.part.wake(() => r.link.ready()).then((v) => { at = { pid: r.part.unit.chromePid(), version: r.recv.version }; return v; });
    await sleep(30);
    assert.equal(at, null, "no request reaches the first Chrome");
    const second = await until(() => { const c = r.part.unit.chromePid(); return c !== null && c !== first ? c : null; }, "the second Chrome");
    const op = r.part.startBrowser(TOKEN);
    await sleep(30);
    assert.equal(at, null, "nor the second Chrome before its hello");
    r.hello(STAGED);
    assert.equal(await woke, null);
    assert.deepEqual(at, { pid: second, version: STAGED });
    assert.deepEqual(await p, { data: {} });
    assert.deepEqual(await op, { data: {} });
    assert.equal(r.chromes().length, 2, "one move");
    assert.equal(ofKind(r, "ready").length, 1);
    assert.equal(r.part.startHolds, false);
  } finally { await r.close(); }
  // A start at a use: the request that started Chrome waits through the move too.
  const u = await rig();
  const stop = receiver(u, ["0.3.10", STAGED]);
  try {
    assert.equal(await u.part.wake(() => u.link.ready()), null);
    assert.equal(u.chromes().length, 2);
    assert.equal(u.part.unit.chromePid(), u.chromes()[1]);
    assert.equal(u.recv.version, STAGED);
    assert.equal(ofKind(u, "ready").length, 1);
  } finally { stop(); await u.close(); }
});

test("board ab-v16.81, review-200 notes 1 and 2: at a request's limit while the move runs, a send gets the starting text (never the first Chrome's receiver); an upgrade or an MCP call gets null, and its checks run again while the gate still counts the link as down", async () => {
  const r = await rig({ useWaitMs: 5000 });
  try {
    const p = r.part.startBrowser(TOKEN);
    await until(() => r.part.unit.chromePid(), "the first Chrome");
    r.hello("0.3.10");
    const send = r.part.wake(() => r.link.ready(), { send: true });
    const door = r.part.wake(() => r.link.ready());
    await until(() => r.chromes().length === 2 && r.part.unit.running(), "the second Chrome");
    // The second Chrome's receiver says nothing: the move waits; the requests' own limit passes first.
    const both = Promise.all([send, door]);
    assert.deepEqual(await pump(r, both, 10_000), [STATE_TEXTS.starting.agent_text, null]);
    assert.equal(r.part.startHolds, true, "the re-run checks count the link as down (the agent door's stopping(), the MCP readiness)");
    await pump(r, p);
  } finally { await r.close(); }
});

test("review-200 B1: a stop op that comes while the move waits for its owner check keeps Chrome stopped: no second start, no ready, the record says wanted false", async () => {
  const h = heldOwner("a move of the agent extension");
  const r = await rig({ owner: h.owner });
  const stop = receiver(r, ["0.3.10", STAGED]);
  try {
    const p = r.part.startBrowser(TOKEN);
    await until(() => h.held(), "the move's owner check");
    assert.deepEqual(await r.part.stopBrowser(TOKEN), { data: {} });
    h.release();
    assert.deepEqual(await p, { data: {} });
    await sleep(40);
    assert.equal(r.part.unit.running(), false);
    assert.equal(r.chromes().length, 1, "no second start");
    assert.equal(ofKind(r, "ready").length, 0);
    assert.deepEqual(ofKind(r, "stopped").map((e) => e.reason), ["stop"]);
    assert.equal(JSON.parse(readFileSync(r.w.paths.unitFile, "utf8")).wanted, false);
    assert.ok(!r.logs.some((l) => l.includes("starting Chrome once more")), "no move");
  } finally { stop(); await r.close(); }
});

test("review-200 B1: on the Mac, a stop op that comes while the restart at a version change waits for its owner check keeps Chrome stopped: no second open, no ready, the record says wanted false", async () => {
  const w = new World();
  const h = heldOwner("a restart of the agent Chrome at a version change");
  const opens = { n: 0 };
  const events: Record<string, unknown>[] = [];
  const part = new UnitPart({
    paths: w.paths, procs: w.procs, tools: new FakeTools(), owner: h.owner, log: (l) => w.logs.push(l),
    endpoint: () => ({ form: "mac" }), sessionsComplete: () => true, activity: { clients: () => false },
    unit: w.deps(new FakeTools(), { mac: fakeMac(w, opens) }),
    mac: { watcher: { tick: () => {}, stop: () => {} }, versions: () => ({ agent: "156.0.8078.74", operator: "156.0.8078.80" }), disk: () => "156.0.8078.80", everyMs: 0 },
  });
  try {
    part.attach((ev) => events.push(ev));
    part.onConfig({ enabled: true, chrome_bin: "", chrome_args: [] });
    await part.unit.start();
    assert.equal(opens.n, 1);
    const p = (part as any).macVersionCheck() as Promise<void>;
    await until(() => h.held(), "the restart's owner check");
    assert.deepEqual(await part.stopBrowser(TOKEN), { data: {} });
    h.release();
    await p;
    assert.equal(part.unit.running(), false);
    assert.equal(opens.n, 1, "no second open");
    assert.deepEqual(events.filter((e) => e.ev === "ready"), []);
    assert.equal(JSON.parse(readFileSync(w.paths.unitFile, "utf8")).wanted, false);
  } finally { await part.stop(); w.close(); }
});

test("review-200 note 6: the service's gate: while a start runs (startHolds), the agent door's stopping() and the MCP readiness count the link as down; after it they do not", { skip: process.platform !== "linux", timeout: 30_000 }, async (t) => {
  const w = new World();
  const dir = tempDir("ab-move-gate-");
  t.after(() => { rmSync(dir, { recursive: true, force: true }); w.close(); });
  const tools = new FakeTools();
  const s = await startService({
    agentDoor: join(dir, "cdp.sock"), controlDoor: join(dir, "control.sock"), daemonCommand: join(dir, "daemon-command.json"), log: () => {}, mainPid: async () => null,
    lists: { listsFolder: join(dir, "lists"), stateFolder: w.paths.state },
    unit: { paths: w.paths, owner: async () => ACTIVE, tools, procs: w.procs, part: { unit: w.deps(tools), firstCheckMs: 3_600_000 } },
    mcp: { listen: { port: 0 } },
  });
  try {
    const readiness = (s.mcp!.mcpPort as any).o.readiness as (scope: string) => McpReadiness;
    (s.agent as any).relay.model.notReady = () => null;
    const door = async () => (await raw(`ws+unix://${join(dir, "cdp.sock")}:/devtools/browser/web-1`)).body;
    assert.equal(readiness("web-1").notReady, null);
    assert.notEqual(await door(), NOT_READY.link, "no start runs: step 4 passes (the scope's own 503 comes after it)");
    // A start that runs: the part's count of the startBrowser calls in flight (its receiver check and move included).
    (s.part as any).startRuns = 1;
    assert.equal(s.part!.startHolds, true);
    assert.equal(readiness("web-1").notReady, NOT_READY.link, "the MCP readiness");
    assert.equal(await door(), NOT_READY.link, "the agent door's stopping(): step 4's 503");
    (s.part as any).startRuns = 0;
    assert.equal(readiness("web-1").notReady, null);
    assert.notEqual(await door(), NOT_READY.link);
  } finally { await s.stop(); }
});

test("board ab-v16.81: the Mac and a Chromium of chrome_bin do not wait for a hello: the start answers at once with its ready", async () => {
  for (const o of [{ config: CHROMIUM }, { mac: true, config: { enabled: true, chrome_bin: "", chrome_args: [] } }]) {
    const r = await rig(o);
    try {
      const t0 = Date.now();
      assert.deepEqual(await r.part.startBrowser(TOKEN), { data: {} });
      assert.ok(Date.now() - t0 < 3000, "no wait");
      assert.equal(r.part.unit.stagedPackage(), null);
      assert.equal(r.part.unit.running(), true);
      if (!o.mac) assert.equal(r.chromes().length, 1);
      assert.equal(ofKind(r, "ready").length, 1);
    } finally { await r.close(); }
  }
});
