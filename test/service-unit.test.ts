// The Chrome unit of `agent-browser service` (the self-contained design, sections 5.1, 5.2 and 13.2; board
// ab-v16.94.3): Xvfb with its auth file and its display, Chrome detached with its flags and its environment, the unit
// record, the adoption by pid and start time, the boot sweep, the stop, the supervisor and the Google Chrome install of
// a start. The unit's real code runs against a fake world (test/fake-unit-world.ts): a fake /proc, a fake X root, fake
// processes and a virtual clock. One test starts a real `sleep` to check the detached spawn and the group signal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AGENT_ARGS } from "../src/agent.ts";
import { abstractDisplays, DISPLAY_FIRST, DISPLAY_LAST, displayInUse, freeDisplays, realDisplayFs } from "../src/service/unit/display.ts";
import { Procs } from "../src/service/unit/procs.ts";
import { readRecord, writeJsonDurable } from "../src/service/unit/record.ts";
import { BACKOFF_MAX_MS, BACKOFF_MIN_MS, HEALTHY_MS, SUPERVISE_MS, CHROME_INSTALLING, CHROME_NOT_INSTALLED, ChromeUnit, configFrom, ConfigError, DEFAULT_CONFIG, KIND_CHROMIUM, KIND_GOOGLE, NotOwnerError, signalGroup, spawnDetached, StartError, STOPPED_DURING_INSTALL, XVFB_TRIES, type UnitEvent } from "../src/service/unit/unit.ts";
import { AUTH_NAME, COOKIE_LEN, writeXauthority, xauthEntry } from "../src/service/unit/xauth.ts";
import { FakeTools, World } from "./fake-unit-world.ts";

const CHROMIUM = { ...DEFAULT_CONFIG, chromeBin: "/usr/bin/chromium" };
function unitIn(w: World, o: { tools?: FakeTools; cfg?: typeof DEFAULT_CONFIG | null; displays?: { first: number; last: number }; mayAct?: (what: string) => Promise<boolean> } = {}) {
  const tools = o.tools ?? new FakeTools();
  const u = new ChromeUnit(w.deps(tools, { displays: o.displays ?? { first: 173, last: 175 }, mayAct: o.mayAct }));
  u.config = o.cfg === undefined ? CHROMIUM : o.cfg;
  return { u, tools };
}
const record = (w: World) => { const r = readRecord(w.paths.unitFile); assert.equal(r.kind, "ok"); return (r as any).record; };
const chromeOf = (w: World) => w.spawned.filter((p) => !p.argv[0].endsWith("Xvfb"));
const xvfbOf = (w: World) => w.spawned.filter((p) => p.argv[0].endsWith("Xvfb"));

// ------------------------------------------------------------------ Xvfb, its display and its auth file

test("Xvfb: -nolisten tcp, its own auth file, the screen of browser.display_size, on the first free display; its record names it", async () => {
  const w = new World();
  try {
    const { u } = unitIn(w, { cfg: { ...CHROMIUM, displaySize: "1440x960" } });
    assert.equal(await u.start(), true);
    const [x] = xvfbOf(w);
    assert.deepEqual(x.argv, ["/usr/bin/Xvfb", ":173", "-nolisten", "tcp", "-auth", w.paths.xauth, "-screen", "0", "1440x960x24"]);
    assert.equal(statSync(w.paths.xauth).mode & 0o777, 0o600);
    const r = record(w);
    assert.equal(r.display, 173);
    assert.equal(r.xvfb_pid, x.pid);
    assert.equal(r.xvfb_start, x.start);
    assert.deepEqual(r.display_size, [1440, 960]);
  } finally { w.close(); }
});

test("the X auth file: one FamilyWild MIT-MAGIC-COOKIE-1 entry (the bytes of a hand-built vector), mode 0600 also over a looser file; a fresh cookie at each Xvfb start; no argv, environment value or log line holds the cookie", async () => {
  const w = new World();
  try {
    const cookie = Buffer.from("0123456789abcdef");
    const want = Buffer.concat([Buffer.from([0xff, 0xff, 0, 0, 0, 3]), Buffer.from("173"), Buffer.from([0, 18]), Buffer.from(AUTH_NAME), Buffer.from([0, 16]), cookie]);
    assert.deepEqual(xauthEntry(173, cookie), want);
    const loose = join(w.dir, "loose");
    writeFileSync(loose, "x", { mode: 0o644 });
    writeXauthority(loose, 173, cookie);
    assert.equal(statSync(loose).mode & 0o777, 0o600);
    assert.deepEqual(readFileSync(loose), want);
    assert.throws(() => xauthEntry(1, Buffer.from("short")), (e: Error) => !e.message.includes("short") && e.message.includes(String(COOKIE_LEN)));
    const { u } = unitIn(w);
    await u.start();
    const first = readFileSync(w.paths.xauth).subarray(-16);
    await u.stop();
    await u.start();
    const second = readFileSync(w.paths.xauth).subarray(-16);
    assert.notDeepEqual(first, second, "a fresh cookie at each start");
    const hex = [first, second].map((b) => b.toString("hex"));
    for (const p of w.spawned) {
      for (const a of [...p.argv, ...Object.values(p.env ?? {})]) for (const h of hex) assert.ok(!a.includes(h) && !a.includes(Buffer.from(h, "hex").toString("latin1")), "no argv or env value holds the cookie");
    }
    for (const l of w.logs) for (const h of hex) assert.ok(!l.includes(h));
  } finally { w.close(); }
});

test("the display chooser: the first free display from 90 to 189; a display in use (its socket, its lock file, or its abstract socket) is skipped", () => {
  assert.deepEqual([DISPLAY_FIRST, DISPLAY_LAST], [90, 189]);
  const exists = new Set(["/x/.X11-unix/X90", "/x/.X91-lock"]);
  const net = "Num       RefCount Protocol Flags    Type St Inode Path\n0000000000000000: 00000002 00000000 00010000 0001 01 1 @/tmp/.X11-unix/X92\n0000000000000000: 00000002 00000000 00010000 0001 01 2 /tmp/.X11-unix/X95\n";
  const fs = { exists: (p: string) => exists.has(p), netUnix: () => net };
  assert.deepEqual([...abstractDisplays(net)], [92]);
  assert.equal(displayInUse(90, "/x", fs), true, "its socket");
  assert.equal(displayInUse(91, "/x", fs), true, "its lock file");
  assert.equal(displayInUse(92, "/x", fs), true, "its abstract socket");
  assert.equal(displayInUse(93, "/x", fs), false);
  assert.deepEqual(freeDisplays("/x", fs).slice(0, 2), [93, 94]);
  assert.equal(freeDisplays("/x", fs).at(-1), 189);
  assert.equal(freeDisplays("/x", fs).length, 100 - 3);
});

test("a start skips a taken display, moves to the next display when Xvfb exits, fails after 10 exits, and stops an Xvfb that opens no display in 5 s", async () => {
  const w = new World();
  try {
    writeFileSync(join(w.xRoot, ".X173-lock"), "");
    const { u } = unitIn(w);
    w.behave.Xvfb = ["exit"];
    await u.start();
    assert.deepEqual(xvfbOf(w).map((p) => p.argv[1]), [":174", ":175"], "173 taken, 174 exited, 175 took");
    await u.stop();
    const w2 = new World();
    try {
      const { u: u2 } = unitIn(w2, { displays: { first: 100, last: 130 } });
      w2.behave.Xvfb = Array(XVFB_TRIES).fill("exit");
      await assert.rejects(u2.start(), (e: Error) => e instanceof StartError && e.message === `Xvfb exited on ${XVFB_TRIES} displays in a row`);
      w2.behave.Xvfb = ["nosocket"];
      await assert.rejects(u2.start(), /Xvfb did not open display :100 in 5 s/);
      assert.equal(w2.alive(xvfbOf(w2).at(-1)!.pid), false, "the Xvfb with no display is stopped");
    } finally { w2.close(); }
  } finally { w.close(); }
});

// ------------------------------------------------------------------ Chrome, its flags and its environment

test("Chrome: detached on the unit's display, on the agent profile, with AGENT_ARGS, the fixed flags, the config's lang, size and chrome_args, and about:blank; chrome_bin from config keeps the way back to Chromium", async () => {
  const w = new World();
  try {
    const { u } = unitIn(w, { cfg: { ...CHROMIUM, chromeArgs: ["--enable-features=Foo"], lang: "de-DE", displaySize: "1280x900" } });
    await u.start();
    const [c] = chromeOf(w);
    assert.deepEqual(c.argv, ["/usr/bin/chromium", `--user-data-dir=${w.paths.profile}`, ...AGENT_ARGS, "--password-store=basic",
      "--silent-debugger-extension-api", "--enable-unsafe-swiftshader", "--lang=de-DE", "--window-position=0,0", "--window-size=1280,900", "--enable-features=Foo", "about:blank"]);
    assert.equal(c.argv.some((a) => /remote-debugging|enable-automation|headless/.test(a)), false);
    assert.deepEqual(u.chromeFacts(), { kind: KIND_CHROMIUM, version: "" });
    const r = record(w);
    assert.equal(r.wanted, true);
    assert.equal(r.chrome_pid, c.pid);
    assert.equal(r.chrome_start, c.start);
    assert.deepEqual(r.chrome, { kind: KIND_CHROMIUM, version: "" });
    assert.equal(r.chrome_bin, "/usr/bin/chromium");
    assert.equal(typeof r.started_at, "number");
  } finally { w.close(); }
});

test("assertSafeChromeArgs is the only flags check: a refused switch in chrome_args (remote debugging, automation, headless, another profile) refuses the start before any spawn, and names the switch, never its value", async () => {
  for (const bad of ["--remote-debugging-port=9222", "-remote-debugging-pipe", "--enable-automation", " --headless=new", "--user-data-dir=/home/ann/.config/google-chrome", "--profile-directory=Default"]) {
    const w = new World();
    try {
      const { u } = unitIn(w, { cfg: { ...CHROMIUM, chromeArgs: ["--ok", bad] } });
      await assert.rejects(u.start(), (e: Error) => e instanceof ConfigError && /refusing to launch Chrome with --/.test(e.message) && !e.message.includes("9222") && !e.message.includes("google-chrome"), bad);
      assert.equal(w.spawned.length, 0, `${bad}: nothing started`);
    } finally { w.close(); }
  }
});

test("Chrome's environment is built from scratch: only PATH, HOME (the unit's own), LANG, XDG_RUNTIME_DIR, DISPLAY, XAUTHORITY, TZ when set, and CHROME_VERSION_EXTRA for Google Chrome; no token", async () => {
  const w = new World();
  try {
    const { u } = unitIn(w, { cfg: { ...CHROMIUM, timezone: "Europe/Berlin" } });
    await u.start();
    const [c] = chromeOf(w);
    assert.deepEqual(c.env, { PATH: "/usr/bin:/bin", HOME: w.paths.home, LANG: "C.UTF-8", XDG_RUNTIME_DIR: "/run/user/1000", DISPLAY: ":173", XAUTHORITY: w.paths.xauth, TZ: "Europe/Berlin" });
    assert.deepEqual(xvfbOf(w)[0].env, { PATH: "/usr/bin:/bin", HOME: "/home/ann", LANG: "C.UTF-8", XDG_RUNTIME_DIR: "/run/user/1000" });
    assert.equal(statSync(w.paths.downloads).mode & 0o777, 0o700);
    const prefs = JSON.parse(readFileSync(w.paths.preferences, "utf8"));
    assert.equal(prefs.download.default_directory, w.paths.downloads);
  } finally { w.close(); }
});

test("a start with no config, with browser.enabled false or with a bad size is refused before any spawn; config's keys: enabled, chrome_bin (null or empty: Google Chrome), chrome_args, and agentwatch's display_size, lang and timezone", async () => {
  assert.deepEqual(configFrom({ enabled: true, control: true, chrome_bin: null, chrome_args: [], display_size: "1600x1000", lang: "fr-FR", timezone: "UTC", other: 1 }),
    { enabled: true, chromeBin: "", chromeArgs: [], displaySize: "1600x1000", lang: "fr-FR", timezone: "UTC" });
  assert.equal(configFrom({ enabled: false, chrome_bin: "/usr/bin/chromium", chrome_args: ["--x"] }).enabled, false);
  for (const [cfg, re] of [[null, /no config yet/], [{ ...CHROMIUM, enabled: false }, /browser.enabled is false/], [{ ...CHROMIUM, displaySize: "100x100" }, /display_size must be WIDTHxHEIGHT/]] as const) {
    const w = new World();
    try {
      const { u } = unitIn(w, { cfg: cfg as any });
      await assert.rejects(u.start(), re);
      assert.equal(w.spawned.length, 0);
    } finally { w.close(); }
  }
});

test("a Chrome that exits at once fails the start and its new Xvfb is stopped; a missing Xvfb or Chromium binary fails the start", async () => {
  const w = new World();
  try {
    const { u } = unitIn(w);
    w.behave.chromium = ["exit"];
    await assert.rejects(u.start(), /Chromium exited at start/);
    assert.equal(w.named("Xvfb").length, 0, "its Xvfb is stopped");
    w.programs.Xvfb = null;
    await assert.rejects(u.start(), /Xvfb not found on PATH/);
    w.programs.Xvfb = "/usr/bin/Xvfb";
    w.programs["/usr/bin/chromium"] = null;
    await assert.rejects(u.start(), /Chromium not found: \/usr\/bin\/chromium/);
  } finally { w.close(); }
});

test("a start twice starts once; a stop waits for a start that runs", async () => {
  const w = new World();
  try {
    const { u } = unitIn(w);
    await Promise.all([u.start(), u.start()]);
    assert.equal(chromeOf(w).length, 1);
    assert.equal(await u.start(), false);
    await u.stop();
    const s = u.start();
    while (!u.locked) await new Promise((r) => setImmediate(r));
    const stopped = u.stop(); // it waits for the start that holds the lock
    assert.equal(await s, true);
    await stopped;
    assert.equal(w.named("chromium").length, 0, "the stop came after the start");
    assert.equal(record(w).wanted, false);
  } finally { w.close(); }
});

// ------------------------------------------------------------------ the owner rule before a start

test("the owner rule is asked right before each Chrome start: a no refuses the start with NotOwnerError and starts nothing", async () => {
  const w = new World();
  try {
    const asked: string[] = [];
    const { u } = unitIn(w, { mayAct: async (what) => { asked.push(what); return false; } });
    await assert.rejects(u.start(), NotOwnerError);
    assert.deepEqual(asked, ["a Chrome start"]);
    assert.equal(w.spawned.length, 0);
  } finally { w.close(); }
});

// ------------------------------------------------------------------ the stop

test("stop: SIGTERM to Chrome, then to Xvfb; SIGKILL after 5 s; the record says wanted false; a pid whose command line changed is never signalled", async () => {
  const w = new World();
  try {
    const { u } = unitIn(w);
    await u.start();
    const [x] = xvfbOf(w), [c] = chromeOf(w);
    w.stubborn.add("chromium");
    w.live.get(c.pid)!.stubborn = true;
    const t0 = w.now;
    assert.equal(await u.stop(), true);
    assert.deepEqual(w.signals, [[c.pid, "SIGTERM"], [c.pid, "SIGKILL"], [x.pid, "SIGTERM"]]);
    assert.ok(w.now - t0 >= 5000, "the grace");
    assert.equal(record(w).wanted, false);
    assert.equal(await u.stop(), false, "nothing was running");
    // A reused pid: the recorded Chrome's pid runs another program now.
    w.stubborn.clear();
    await u.start();
    const c2 = chromeOf(w).at(-1)!;
    w.end(c2.pid);
    w.add({ pid: c2.pid, start: c2.start, argv: ["/usr/bin/vim", "notes.txt"] });
    w.signals.length = 0;
    await u.stop();
    assert.equal(w.signals.some(([p]) => p === c2.pid), false, "the other program is never signalled");
    assert.ok(w.alive(c2.pid));
  } finally { w.close(); }
});

test("the stop also stops each Chrome on the profile that the unit does not hold (never one of another profile or a similar path)", async () => {
  const w = new World();
  try {
    const orphan = w.add({ argv: ["/usr/bin/chromium", `--user-data-dir=${w.paths.profile}`] });
    const child = w.add({ argv: ["/usr/lib/chromium/chromium", "--type=renderer", `--user-data-dir=${w.paths.profile}`], ppid: orphan.pid, pgrp: orphan.pid });
    const other = w.add({ argv: ["/usr/bin/chromium", `--user-data-dir=${w.paths.profile}-2`] });
    const foreign = w.add({ argv: ["/usr/bin/chromium", `--user-data-dir=${w.paths.profile}`], uid: w.uid + 1 });
    const { u } = unitIn(w);
    await u.stop();
    assert.equal(w.alive(orphan.pid), false);
    assert.deepEqual(w.signals.map(([p]) => p), [orphan.pid], "only the root of the tree");
    assert.equal(w.alive(child.pid), true, "a child goes with its root (on a box)");
    assert.equal(w.alive(other.pid), true);
    assert.equal(w.alive(foreign.pid), true, "another user's process is never signalled");
  } finally { w.close(); }
});

// ------------------------------------------------------------------ the adoption

async function startedThenNewUnit(w: World) {
  const { u } = unitIn(w);
  await u.start();
  const [x] = xvfbOf(w), [c] = chromeOf(w);
  return { x, c, next: () => unitIn(w).u };
}

test("the adoption after a restart: only what the record names, by pid and start time, on the agent profile and the X auth file, when the record says wanted", async () => {
  const w = new World();
  try {
    const { x, c, next } = await startedThenNewUnit(w);
    const u2 = next();
    assert.deepEqual(u2.adopt(), { adopted: true, wanted: true, unreadable: null });
    assert.equal(u2.running(), true);
    assert.equal(u2.chromePid(), c.pid);
    assert.equal(u2.runningDisplay(), 173);
    assert.equal(w.spawned.length, 2, "nothing new started");
    assert.deepEqual(w.signals, []);
    // The adopted unit stops them.
    await u2.stop();
    assert.equal(w.alive(c.pid) || w.alive(x.pid), false);
  } finally { w.close(); }
});

test("nothing is adopted unless everything matches: another start time (a reused pid), another profile, no X auth marker, another program as Xvfb, wanted false, or another user; the record's Xvfb alone gets SIGTERM", async () => {
  const cases: [string, (w: World, x: any, c: any) => void, boolean][] = [
    ["Chrome's start time differs", (w, _x, c) => { w.end(c.pid); w.add({ ...c, start: c.start + 1 }); }, true],
    ["Chrome on another profile", (w, _x, c) => { w.end(c.pid); w.add({ ...c, argv: ["/usr/bin/chromium", "--user-data-dir=/other"] }); }, true],
    ["Xvfb's start time differs", (w, x) => { w.end(x.pid); w.add({ ...x, start: x.start + 1 }); }, false],
    ["Xvfb without the X auth file", (w, x) => { w.end(x.pid); w.add({ ...x, argv: ["/usr/bin/Xvfb", ":173"] }); }, false],
    ["xauth names the file, not Xvfb", (w, x) => { w.end(x.pid); w.add({ ...x, argv: ["/usr/bin/xauth", "-f", w.paths.xauth, ":173"], exe: "/usr/bin/xauth" }); }, false],
    ["wanted false", (w) => { const r = record(w); writeJsonDurable(w.paths.unitFile, { ...r, wanted: false }); }, true],
    ["Chrome of another user", (w, _x, c) => { w.end(c.pid); w.add({ ...c, uid: w.uid + 1 }); }, true],
  ];
  for (const [what, change, xvfbStopped] of cases) {
    const w = new World();
    try {
      const { x, c, next } = await startedThenNewUnit(w);
      change(w, x, c);
      const u2 = next();
      assert.equal(u2.adopt().adopted, false, what);
      assert.equal(u2.running(), false, what);
      const sigs = w.signals.filter(([, s]) => s === "SIGTERM").map(([p]) => p);
      assert.deepEqual(sigs, xvfbStopped ? [x.pid] : [], `${what}: only the record's own Xvfb gets SIGTERM`);
      assert.equal(w.signals.some(([p]) => p === c.pid), false, `${what}: Chrome is never signalled by the adoption`);
    } finally { w.close(); }
  }
});

test("a record of agentwatch's daemon (no start times) is adopted by pid and markers, and the service writes the start times; no record adopts nothing", async () => {
  const w = new World();
  try {
    const { x, c, next } = await startedThenNewUnit(w);
    const r = record(w);
    delete r.xvfb_start; delete r.chrome_start;
    writeJsonDurable(w.paths.unitFile, r);
    const u2 = next();
    assert.equal(u2.adopt().adopted, true);
    assert.equal(record(w).chrome_start, c.start);
    assert.equal(record(w).xvfb_start, x.start);
  } finally { w.close(); }
  const w2 = new World();
  try {
    const { u } = unitIn(w2);
    assert.deepEqual(u.adopt(), { adopted: false, wanted: false, unreadable: null });
  } finally { w2.close(); }
});

test("an unreadable record is not no record: the owner finds Chrome on the profile and Xvfb by its X auth file (exactly one of each) and adopts them; with two it adopts nothing and stops nothing", async () => {
  const w = new World();
  try {
    const { c, next } = await startedThenNewUnit(w);
    writeFileSync(w.paths.unitFile, "{not json");
    const u2 = next();
    const a = u2.adopt();
    assert.deepEqual(a, { adopted: true, wanted: true, unreadable: "it is not JSON" });
    assert.equal(u2.chromePid(), c.pid);
    assert.equal(record(w).chrome_pid, c.pid, "a new record");
    writeFileSync(w.paths.unitFile, "[]");
    w.add({ argv: ["/usr/bin/chromium", `--user-data-dir=${w.paths.profile}`] });
    const u3 = next();
    assert.equal(u3.adopt().adopted, false);
    assert.deepEqual(w.signals, [], "nothing is stopped");
  } finally { w.close(); }
});

test("an unreadable record (review-106 note 6): the adopted Chrome's kind, version and binary come from its program: a copy of the tools folder is Google Chrome of that copy's version, any other program Chromium", async () => {
  const w = new World();
  try {
    const tools = new FakeTools();
    tools.root = w.paths.chromes;
    tools.versions = ["158.0.7100.1-1"];
    const binary = tools.copy("158.0.7100.1-1").binary;
    const { u } = unitIn(w, { tools, cfg: DEFAULT_CONFIG });
    await u.start();
    assert.equal(chromeOf(w)[0].argv[0], binary);
    writeFileSync(w.paths.unitFile, "{not json");
    const u2 = unitIn(w, { tools, cfg: DEFAULT_CONFIG }).u;
    assert.equal(u2.adopt().adopted, true);
    assert.deepEqual(u2.chromeFacts(), { kind: KIND_GOOGLE, version: "158.0.7100.1-1" });
    assert.deepEqual([record(w).chrome, record(w).chrome_bin], [{ kind: KIND_GOOGLE, version: "158.0.7100.1-1" }, binary]);
  } finally { w.close(); }
  const w2 = new World();
  try {
    const { u } = unitIn(w2);
    await u.start();
    writeFileSync(w2.paths.unitFile, "{not json");
    const u2 = unitIn(w2).u;
    assert.equal(u2.adopt().adopted, true);
    assert.deepEqual(u2.chromeFacts(), { kind: KIND_CHROMIUM, version: "" });
    assert.deepEqual([record(w2).chrome, record(w2).chrome_bin], [{ kind: KIND_CHROMIUM, version: "" }, "/usr/bin/chromium"]);
  } finally { w2.close(); }
});

test("the boot sweep (stopOrphans) spares the adopted Chrome and every process below it, and stops a Chrome on the profile that no record names", async () => {
  const w = new World();
  try {
    const { c, next } = await startedThenNewUnit(w);
    const helper = w.add({ argv: ["/usr/lib/chromium/chrome_crashpad_handler"], ppid: c.pid });
    const below = w.add({ argv: ["/usr/lib/chromium/chromium", "--type=gpu-process", `--user-data-dir=${w.paths.profile}`], ppid: helper.pid });
    const orphan = w.add({ argv: ["/usr/bin/chromium", `--user-data-dir=${w.paths.profile}`] });
    const u2 = next();
    u2.adopt();
    assert.equal(await u2.stopOrphans(), true);
    assert.deepEqual(w.signals, [[orphan.pid, "SIGTERM"]]);
    assert.ok(w.alive(c.pid) && w.alive(below.pid));
  } finally { w.close(); }
});

// ------------------------------------------------------------------ the supervisor

test("the supervisor's check comes every 5 s; its backoff runs from 1 s to 60 s", () => {
  assert.deepEqual([SUPERVISE_MS, BACKOFF_MIN_MS, BACKOFF_MAX_MS, HEALTHY_MS], [5000, 1000, 60_000, 300_000]);
});

test("the supervisor: a wanted Chrome that is gone starts again after the backoff (1 s, doubling), with its Xvfb when that is gone too; nothing happens when not wanted; a start sends ready", async () => {
  const w = new World();
  try {
    const { u } = unitIn(w);
    const events: UnitEvent[] = [];
    await u.start();
    const [x, c] = [xvfbOf(w)[0], chromeOf(w)[0]];
    w.end(c.pid);
    const t0 = w.now;
    await u.superviseOnce((e) => events.push(e));
    assert.ok(w.now - t0 >= 1000, "the first backoff");
    assert.equal(chromeOf(w).length, 2, "Chrome again");
    assert.equal(xvfbOf(w).length, 1, "the same Xvfb");
    assert.ok(w.alive(x.pid));
    assert.deepEqual(events, [{ kind: "ready" }]);
    w.end(chromeOf(w)[1].pid); w.end(x.pid);
    await u.superviseOnce((e) => events.push(e));
    assert.deepEqual(w.logs.filter((l) => /is gone; starting it again in/.test(l)).map((l) => l.replace(/.* in /, "")), ["1 s", "2 s"], "the backoff doubles");
    assert.equal(xvfbOf(w).length, 2, "Xvfb again too");
    await u.stop();
    const n = w.spawned.length;
    await u.superviseOnce((e) => events.push(e));
    assert.equal(w.spawned.length, n, "not wanted: nothing");
  } finally { w.close(); }
});

test("the supervisor starts nothing before the first config (build note 8: the part starts a wanted Chrome at that config), and counts no failure", async () => {
  const w = new World();
  try {
    const { u } = unitIn(w, { cfg: null });
    (u as any).wantedFlag = true;
    const t0 = w.now;
    for (let i = 0; i < 4; i++) await u.superviseOnce(() => assert.fail("no event"));
    assert.equal(w.now, t0, "no backoff, no try");
    assert.equal((u as any).failures, 0);
  } finally { w.close(); }
});

test("the supervisor reports start_failed once after three failed starts in a row; a NotOwnerError from the owner rule ends it", async () => {
  const w = new World();
  try {
    const { u } = unitIn(w);
    const events: UnitEvent[] = [];
    await u.start();
    w.end(chromeOf(w)[0].pid);
    w.behave.chromium = ["exit", "exit", "exit", "exit"];
    for (let i = 0; i < 4; i++) await u.superviseOnce((e) => events.push(e));
    assert.deepEqual(events.map((e) => e.kind), ["start_failed"]);
    assert.match((events[0] as any).reason, /Chromium exited at start/);
    let ok = true;
    const w2 = new World();
    try {
      const { u: u2 } = unitIn(w2, { mayAct: async () => ok });
      await u2.start();
      w2.end(chromeOf(w2)[0].pid);
      ok = false;
      await assert.rejects(u2.superviseOnce(() => {}), NotOwnerError);
      assert.equal(chromeOf(w2).length, 1, "no restart when the service does not own");
    } finally { w2.close(); }
  } finally { w.close(); }
});

// ------------------------------------------------------------------ Google Chrome from the tools folder

test("chrome_bin empty runs the newest copy of the tools folder (never a failed one), with CHROME_VERSION_EXTRA; with no copy a start begins the install, waits for it, then runs the new copy", async () => {
  const w = new World();
  try {
    const tools = new FakeTools();
    tools.versions = ["157.0.7000.1-1", "156.0.6900.1-1"];
    w.programs[tools.copy("157.0.7000.1-1").binary] = tools.copy("157.0.7000.1-1").binary;
    const { u } = unitIn(w, { tools, cfg: DEFAULT_CONFIG });
    await u.start();
    const [c] = chromeOf(w);
    assert.equal(c.argv[0], tools.copy("157.0.7000.1-1").binary);
    assert.equal(c.env!.CHROME_VERSION_EXTRA, "stable");
    assert.deepEqual(u.chromeFacts(), { kind: KIND_GOOGLE, version: "157.0.7000.1-1" });
    assert.deepEqual(record(w).chrome, { kind: KIND_GOOGLE, version: "157.0.7000.1-1" });
    await u.stop();
    // No copy: the start installs.
    const w2 = new World();
    try {
      const t2 = new FakeTools();
      const { u: u2 } = unitIn(w2, { tools: t2, cfg: DEFAULT_CONFIG });
      const p = u2.start();
      for (let i = 0; i < 5 && !t2.pending; i++) await new Promise((r) => setImmediate(r));
      assert.deepEqual(t2.calls, ["ensure latest"]);
      assert.equal(u2.chromeInstalling(), true);
      t2.pending!.resolve();
      await p;
      assert.equal(chromeOf(w2)[0].argv[0], t2.copy("158.0.7100.1-1").binary);
    } finally { w2.close(); }
  } finally { w.close(); }
});

test("an install that runs longer than 45 s answers that Chrome is being installed, and goes on; a stop during the wait keeps the unit stopped; the supervisor never installs", async () => {
  const w = new World();
  try {
    const tools = new FakeTools();
    const { u } = unitIn(w, { tools, cfg: DEFAULT_CONFIG });
    await assert.rejects(u.start(), (e: Error) => e.message === CHROME_INSTALLING);
    assert.equal(u.chromeInstalling(), true);
    const p = u.start();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    await u.stop();
    tools.pending!.resolve();
    await assert.rejects(p, (e: Error) => e.message === STOPPED_DURING_INSTALL);
    assert.equal(chromeOf(w).length, 0);
    // The supervisor path (no fetch): with no copy and no recorded Chromium it says that Chrome is not installed.
    const w2 = new World();
    try {
      const t2 = new FakeTools();
      const { u: u2 } = unitIn(w2, { tools: t2, cfg: DEFAULT_CONFIG });
      (u2 as any).wantedFlag = true;
      const logs = w2.logs;
      await u2.superviseOnce(() => {});
      assert.deepEqual(t2.calls, [], "no install");
      assert.ok(logs.some((l) => l.includes(CHROME_NOT_INSTALLED)));
    } finally { w2.close(); }
  } finally { w.close(); }
});

test("a start runs the newest copy that did not fail, and with upto (the way back) the last good copy exactly", async () => {
  const w = new World();
  try {
    const tools = new FakeTools();
    tools.versions = ["157.0.7000.1-1", "158.0.7100.1-1", "159.0.7200.1-1"];
    for (const v of tools.versions) w.programs[tools.copy(v).binary] = tools.copy(v).binary;
    const u = new ChromeUnit(w.deps(tools, { displays: { first: 173, last: 175 }, refused: () => new Set(["159.0.7200.1-1"]) }));
    u.config = DEFAULT_CONFIG;
    await u.start();
    assert.equal(u.chromeFacts()!.version, "158.0.7100.1-1");
    await u.stop();
    await u.start({ upto: "157.0.7000.1-1" });
    assert.equal(u.chromeFacts()!.version, "157.0.7000.1-1");
  } finally { w.close(); }
});

// ------------------------------------------------------------------ the detached spawn and the record's write

test("spawnDetached: the process runs in its own session and process group with no stdio, and the service does not wait for it; signalGroup signals its group", { timeout: 20_000 }, async () => {
  const p = spawnDetached(["/bin/sleep", "30"], { PATH: "/usr/bin:/bin" });
  try {
    const procs = new Procs();
    const st = readFileSync(`/proc/${p.pid}/stat`, "latin1");
    const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
    assert.equal(Number(f[2]), p.pid, "its own process group");
    assert.equal(Number(f[3]), p.pid, "its own session");
    assert.equal(readFileSync(`/proc/${p.pid}/fd/0`, { flag: "r" }).length, 0);
    signalGroup(procs)(p.pid, "SIGTERM");
    for (let i = 0; i < 100 && !p.exited(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(p.exited(), true);
  } finally { if (!p.exited()) process.kill(p.pid, "SIGKILL"); }
});

test("the unit record's write: a temp file of mode 0600 in the same folder, then the rename; no temp file stays", () => {
  const w = new World();
  try {
    mkdirSync(w.paths.state, { recursive: true });
    writeJsonDurable(w.paths.unitFile, { wanted: true });
    assert.equal(statSync(w.paths.unitFile).mode & 0o777, 0o600);
    assert.deepEqual(readRecord(w.paths.unitFile), { kind: "ok", record: { wanted: true } });
    assert.deepEqual(readFileSync(w.paths.unitFile, "utf8").trim().startsWith("{"), true);
    assert.deepEqual(readRecord(join(w.dir, "none.json")), { kind: "none" });
  } finally { w.close(); }
});
