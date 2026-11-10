// The Chrome unit's parts of stage 1b part 2 (board ab-v16.94.9): the agent package before each start of a Google
// Chrome copy (agentwatch's _google_plan), its version in the `ready` event and in `status`, the hooks of the part for
// the native link (the end of the old host after each ready, the X pointer's kill before each stop), the fail-closed
// watch on the real link's port, and the service's end of an old host by note 7 at an adoption. In a fake world
// (test/fake-unit-world.ts): no real Chrome, Xvfb or signal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlDoor } from "../src/service/control.ts";
import { Stage1a, startService } from "../src/service/service.ts";
import { Owner, type UnitState } from "../src/service/unit/owner.ts";
import { UnitPart } from "../src/service/unit/part.ts";
import { ChromeUnit, DEFAULT_CONFIG, KIND_CHROMIUM, KIND_GOOGLE, StartError } from "../src/service/unit/unit.ts";
import { writeJsonDurable } from "../src/service/unit/record.ts";
import type { Pidfds } from "../src/service/link/old-host.ts";
import { shimArgv } from "../src/service/link/manifest.ts";
import { daemonClient, DAEMON_HELLO } from "./fake-daemon.ts";
import { FakeTools, World } from "./fake-unit-world.ts";

const ACTIVE: UnitState = { active: "active", sub: "running", mainPid: process.pid };
const RECEIVER = "ifhfjdmdbgbnmllffiadajepajbcdnai";
const google = (w: World, prepare?: ConstructorParameters<typeof ChromeUnit>[0]["prepare"]) => {
  const tools = new FakeTools();
  tools.root = w.paths.chromes;
  tools.versions = ["158.0.7100.1-1"];
  const u = new ChromeUnit(w.deps(tools, { displays: { first: 173, last: 175 }, prepare }));
  u.config = DEFAULT_CONFIG;
  return { u, tools };
};

test("each start of a Google Chrome copy runs the agent package first, and the unit keeps the staged version while that Chrome runs", async () => {
  const w = new World();
  try {
    const seen: string[] = [];
    const { u, tools } = google(w, { run: (copy) => { seen.push(copy.binary); return "0.3.6"; }, lastFile: () => null });
    await u.start();
    assert.deepEqual(seen, [tools.copy("158.0.7100.1-1").binary]);
    assert.equal(u.stagedPackage(), "0.3.6");
    assert.deepEqual(u.xDisplay(), { display: 173, xauth: w.paths.xauth, size: [1280, 900] });
    await u.stop();
    assert.equal(u.stagedPackage(), null);
    assert.equal(u.xDisplay(), null);
  } finally { w.close(); }
});

test("a start whose agent package fails is a start failure with the package's reason; a Chromium of chrome_bin runs no package", async () => {
  const w = new World();
  try {
    const { u } = google(w, { run: () => { throw new Error("the agent extension package does not match its pinned SHA-256"); }, lastFile: () => "0.3.6" });
    await assert.rejects(u.start(), (e: Error) => e instanceof StartError && e.message === "Google Chrome could not be set up: the agent extension package does not match its pinned SHA-256. To keep the box's Chromium, set browser.chrome_bin: /usr/bin/chromium");
    assert.equal(w.spawned.filter((p) => !p.argv[0].endsWith("Xvfb")).length, 0, "no Chrome started");
    const seen: string[] = [];
    const u2 = new ChromeUnit(w.deps(new FakeTools(), { displays: { first: 173, last: 175 }, prepare: { run: () => { seen.push("x"); return "0.3.6"; }, lastFile: () => null } }));
    u2.config = { ...DEFAULT_CONFIG, chromeBin: "/usr/bin/chromium" };
    await u2.start();
    assert.deepEqual(seen, []);
    assert.equal(u2.stagedPackage(), null);
  } finally { w.close(); }
});

test("the supervisor's start with a failed package: the copy's file of its last start keeps Google Chrome; with no file the recorded Chromium starts", async () => {
  const w = new World();
  try {
    let fail = false, lastFile: string | null = "0.3.6";
    const { u } = google(w, { run: () => { if (fail) throw new Error("the agent extension could not be written: ENOSPC"); return "0.3.6"; }, lastFile: () => lastFile });
    await u.start();
    const first = w.named("chrome")[0] ?? w.spawned.find((p) => p.argv[0].endsWith("/chrome"))!;
    fail = true;
    w.end(first.pid);
    await u.superviseOnce(() => {});
    for (let i = 0; i < 50 && !u.running(); i++) await u.superviseOnce(() => {});
    assert.equal(u.chromeFacts()?.kind, KIND_GOOGLE, "the copy starts again with the file of its last start");
    assert.ok(w.logs.some((l) => l.includes("Google Chrome starts with the package file of its last start")));
    assert.equal(u.stagedPackage(), "0.3.6", "the version of the last start's pinned package (review-110 B2)");
  } finally { w.close(); }
  const w2 = new World();
  try {
    let fail = false;
    const { u } = google(w2, { run: () => { if (fail) throw new Error("bad"); return "0.3.6"; }, lastFile: () => null });
    await u.start();
    // The record names a Chromium of chrome_bin: the supervisor's way back when the copy has no package file.
    const rec = JSON.parse(readFileSync(w2.paths.unitFile, "utf8"));
    writeJsonDurable(w2.paths.unitFile, { ...rec, chrome: { kind: KIND_CHROMIUM, version: "" }, chrome_bin: "/usr/bin/chromium" });
    fail = true;
    w2.end(w2.spawned.find((p) => p.argv[0].endsWith("/chrome"))!.pid);
    for (let i = 0; i < 50 && !u.running(); i++) await u.superviseOnce(() => {});
    assert.equal(u.chromeFacts()?.kind, KIND_CHROMIUM);
    assert.ok(w2.logs.some((l) => l.includes("starting the recorded Chromium again")));
  } finally { w2.close(); }
});

/** A part with the link's hooks, on a control door. */
async function partRig(o: { version?: () => string | null; begin?: boolean } = {}) {
  const w = new World();
  const tools = new FakeTools();
  const calls: string[] = [];
  let ready = false, confirmed = false;
  let handler!: Stage1a;
  const part = new UnitPart({
    paths: w.paths, procs: w.procs, tools, log: () => {}, owner: new Owner(async () => ACTIVE, () => {}),
    endpoint: () => ({ form: "pidfd" }), sessionsComplete: () => handler.sessionsComplete,
    unit: { ...w.deps(tools, { displays: { first: 173, last: 175 } }) },
    clock: () => w.now, superviseMs: 10, watchMs: 5, watchLimitMs: 60_000, firstCheckMs: 3_600_000,
    link: { ready: () => ready, confirmed: () => confirmed, busy: () => false, scopesReady: () => ready },
    extensionVersion: o.version ?? (() => "0.3.6"), onReady: () => calls.push("onReady"), beforeStop: () => calls.push("beforeStop"),
  });
  handler = new Stage1a({ agentDoor: { url: (s) => s, state: () => ({ form: "pidfd" }) }, parts: [part] });
  const dir = mkdtempSync(join(tmpdir(), "ab-plink-"));
  const door = await ControlDoor.open({ path: join(dir, "control.sock"), admit: async () => ({ ok: true }), handler, log: () => {} });
  await part.begin();
  const c = await daemonClient(door.path);
  await c.next();
  c.send(DAEMON_HELLO);
  const req = (id: string, op: string, by: object, fields: object = {}) => { c.send({ t: "req", id, op, by, ...fields }); return c.answer(id, 10_000); };
  return { w, part, c, calls, req, set: (r: boolean, k: boolean) => { ready = r; confirmed = k; }, close: async () => { c.end(); await part.stop(); await door.stop(); rmSync(dir, { recursive: true, force: true }); w.close(); } };
}
const TOKEN = { kind: "token", user: "ann", via: "cli" };
const CONFIG = { t: "req", id: "cfg", op: "config", by: { kind: "daemon", user: "ann", via: "config" }, enabled: true, control: true, chrome_bin: "/usr/bin/chromium", chrome_args: [] };

test("the ready event and status carry the extension's version; onReady comes after each ready and beforeStop before each stop", async () => {
  const r = await partRig();
  try {
    r.c.send(CONFIG); await r.c.answer("cfg");
    assert.equal((await r.req("s0", "status", { kind: "daemon", user: "ann", via: "daemon" })).data.extension_version, null, "no Chrome: no version");
    await r.req("a", "start", TOKEN);
    const ready = await r.c.next((l) => l.t === "ev" && l.ev === "ready");
    assert.equal(ready.extension_version, "0.3.6");
    assert.equal((await r.req("s1", "status", { kind: "daemon", user: "ann", via: "daemon" })).data.extension_version, "0.3.6");
    assert.deepEqual(r.calls, ["onReady"]);
    await r.req("b", "stop", TOKEN);
    assert.deepEqual(r.calls, ["onReady", "beforeStop"]);
  } finally { await r.close(); }
});

test("the fail-closed watch on the link's port: a linked receiver that confirmed the lists keeps Chrome; with no confirm it stops it after the limit", async () => {
  const r = await partRig();
  try {
    r.c.send(CONFIG); await r.c.answer("cfg");
    await r.req("a", "start", TOKEN);
    r.set(true, true);
    r.w.now += 120_000;
    await new Promise((s) => setTimeout(s, 50));
    assert.equal(r.part.unit.running(), true, "confirmed: no stop");
    r.set(true, false);
    r.w.now += 61_000;
    const stopped = await r.c.next((l) => l.t === "ev" && l.ev === "stopped", 10_000);
    assert.equal(stopped.reason, "sessions_unread", "a receiver that takes set_scopes, with no complete set_sessions");
  } finally { await r.close(); }
});

test("the service at an adoption ends the old owner's host among its Chrome's children through a pidfd (note 7), and never its own shim or a renderer", { timeout: 30_000 }, async (t) => {
  const w = new World();
  const dir = mkdtempSync(join(tmpdir(), "ab-old-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); w.close(); });
  const x = w.add({ argv: ["/usr/bin/Xvfb", ":173", "-nolisten", "tcp", "-auth", w.paths.xauth, "-screen", "0", "1280x900x24"] });
  const ch = w.add({ argv: ["/usr/bin/chromium", `--user-data-dir=${w.paths.profile}`, "about:blank"] });
  writeJsonDurable(w.paths.unitFile, { wanted: true, display: 173, display_size: [1280, 900], xvfb_pid: x.pid, xvfb_start: x.start, chrome_pid: ch.pid, chrome_start: ch.start, chrome: { kind: "chromium", version: "" }, chrome_bin: "/usr/bin/chromium" });
  const old = w.add({ ppid: ch.pid, argv: ["/usr/bin/python3", "-I", "/aw/native_host.py", `chrome-extension://${RECEIVER}/`] });
  const renderer = w.add({ ppid: ch.pid, argv: ["/usr/bin/chromium", "--type=renderer", `chrome-extension://${RECEIVER}/`] });
  const shim = { node: "/usr/bin/node", bin: "/ab/bin/agent-browser.js" };
  const mine = w.add({ ppid: ch.pid, argv: [...shimArgv(shim), `chrome-extension://${RECEIVER}/`] });
  const signalled: number[] = [];
  const pidfds: Pidfds = { open: (pid) => pid, signal: (fd) => { signalled.push(fd); return 0; }, close: () => {} };
  const tools = new FakeTools();
  const logs: string[] = [];
  const s = await startService({
    agentDoor: join(dir, "cdp.sock"), controlDoor: join(dir, "control.sock"), daemonCommand: join(dir, "daemon-command.json"), log: (l) => logs.push(l), mainPid: async () => null,
    lists: { listsFolder: join(dir, "lists"), stateFolder: w.paths.state },
    unit: { paths: w.paths, owner: async () => ACTIVE, tools, procs: w.procs, part: { unit: w.deps(tools), firstCheckMs: 3_600_000 } },
    link: { socket: join(dir, "link.sock"), pidfds, shim, xdotool: null },
  });
  try {
    assert.equal(s.part?.unit.chromePid(), ch.pid, "the service adopted Chrome");
    assert.deepEqual(signalled, [old.pid], "only the old host");
    assert.ok(!signalled.includes(renderer.pid) && !signalled.includes(mine.pid));
    assert.ok(logs.some((l) => l.includes(`ended the old host (pid ${old.pid})`)));
  } finally { await s.stop(); }
});
