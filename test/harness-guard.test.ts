// The live harnesses' guard (board ab-v16.78; test/live/guard.ts and test/live/harness_guard.py): a stand-in driver
// starts the guard as a harness does, then its stand-in processes (an "Xvfb", a "Chromium" with its own session and a
// child, as the agent Chrome of launchAgentChrome, and a "daemon" that it does not name to the guard, which only the
// guard's record of the driver's tree finds). After a kill -9 of the driver, ps must find none of them within
// GONE_MS. A second harness waits for the lock until the first harness's processes are gone; its wait has a limit.
// Each test has a lock file of its own (HARNESS_LOCK), never the real one. Linux only (the guard is).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GUARD_TS = fileURLToPath(new URL("./live/guard.ts", import.meta.url));
/** The time that ps may still show a process of the harness after the driver's kill -9. */
const GONE_MS = 10_000;
const skip = process.platform !== "linux" ? "the guard is Linux only" : false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The stand-in driver: the guard, then its processes; one JSON line with their pids, then it runs until killed. */
const DRIVER = `
import { spawn } from "node:child_process";
import { harnessGuard } from ${JSON.stringify(GUARD_TS)};
const tg = Date.now();
const guard = await harnessGuard(process.env.NAME);
const t0 = Date.now();
const xvfb = process.env.XVFB_SLOW === "1" ? spawn(process.execPath, ["-e", "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1000)); setInterval(() => {}, 1000);"], { stdio: "ignore" })
  : spawn("/bin/sh", ["-c", "exec sleep 600"], { stdio: "ignore" });
guard.track(xvfb.pid, "Xvfb");
const chromium = spawn("/bin/sh", ["-c", "sleep 600 & exec sleep 601"], { stdio: "ignore", detached: true });
chromium.unref();
guard.track(chromium.pid, "Chromium");
const daemon = spawn("sleep", ["602"], { stdio: "ignore" });
if (process.env.NESTED) spawn(process.execPath, ["-e", process.env.NESTED], { stdio: "inherit", env: { ...process.env, NAME: "nested", NESTED: "" } });
await new Promise((r) => setTimeout(r, 1500));
console.log(JSON.stringify({ guard: guard.pid, mode: guard.mode, waitedMs: t0 - Number(process.env.T0), guardMs: t0 - tg, xvfb: xvfb.pid, chromium: chromium.pid, daemon: daemon.pid }));
setInterval(() => {}, 1000);
`;

/** Every stand-in driver that a test started: each test's end stops what is left of them (the test's own processes only). */
const drivers: number[] = [];
type Started = { child: ChildProcess; t0: number; info: Promise<any>; stderr: () => string; exited: Promise<number | null> };
function driver(dir: string, name: string, env: Record<string, string> = {}): Started {
  const file = join(dir, "driver.mjs");
  writeFileSync(file, DRIVER);
  const t0 = Date.now();
  const child = spawn(process.execPath, [file], { env: { ...process.env, HARNESS_LOCK: join(dir, "harness.lock"), HARNESS_GUARD_HELD: "", NAME: name, T0: String(t0), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stderr!.on("data", (b) => { err += b; });
  const info = new Promise<any>((resolve) => child.stdout!.on("data", (b) => {
    out += b;
    const line = out.split("\n").find((l) => l.startsWith("{"));
    if (line) resolve(JSON.parse(line));
  }));
  const exited = new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
  drivers.push(child.pid!);
  return { child, t0, info, stderr: () => err, exited };
}

/** The pids of `pids` that ps still shows, with their children (a zombie has ended). */
function running(pids: number[]): number[] {
  const ps = execFileSync("ps", ["-e", "-o", "pid=,ppid=,stat="], { encoding: "utf8" }).trim().split("\n").map((l) => l.trim().split(/\s+/));
  const all = new Set(pids);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of ps) if (all.has(Number(ppid)) && !all.has(Number(pid))) { all.add(Number(pid)); grew = true; }
  }
  return ps.filter(([pid, , stat]) => all.has(Number(pid)) && !stat.startsWith("Z")).map(([pid]) => Number(pid));
}
async function goneWithin(pids: number[], ms: number): Promise<number[]> {
  const t0 = Date.now();
  let left = running(pids);
  while (left.length && Date.now() - t0 < ms) { await sleep(100); left = running(pids); }
  return left;
}
/** True when `log()` matches `re` within `ms`: the guard's last lines can reach the pipe just before it ends. */
async function logged(log: () => string, re: RegExp, ms = 3000): Promise<boolean> {
  const t0 = Date.now();
  while (!re.test(log()) && Date.now() - t0 < ms) await sleep(50);
  return re.test(log());
}
/** The test's own cleanup: only the pids that its stand-in driver reported. */
function stopOwn(pids: number[]) { for (const p of running([...drivers.splice(0), ...pids])) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } } }
const standIns = (i: any) => [i.xvfb, i.chromium, i.daemon];

test("after a kill -9 of the driver, ps finds no process of the harness (Xvfb, Chromium with its child, the daemon) within 10 s", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-guard-"));
  const d = driver(dir, "kill9");
  const i = await d.info;
  const pids = [...standIns(i), i.guard];
  try {
    assert.equal(i.mode, "locked");
    const before = running(standIns(i));
    assert.ok(before.length >= 4, `the stand-ins run (the Chromium with its child): ${before}`);
    d.child.kill("SIGKILL");
    await d.exited;
    assert.deepEqual(await goneWithin(standIns(i), GONE_MS), [], `left after the driver's kill -9; guard's log: ${d.stderr()}`);
    assert.ok(await logged(d.stderr, /harness-guard: kill9: the driver \d+ (ended \(its pipe closed\)|is gone); it stops \d+ processes of the harness: .*Xvfb \d+/), `the guard's log: ${d.stderr()}`);
    // The guard frees the lock after the processes are gone: the next harness gets it at once.
    assert.deepEqual(await goneWithin([i.guard], 3000), [], "the guard ended");
    const next = driver(dir, "next");
    const j = await next.info;
    pids.push(...standIns(j));
    assert.equal(j.mode, "locked");
    assert.doesNotMatch(next.stderr(), /waits for the harness lock/);
    next.child.kill("SIGKILL");
    assert.deepEqual(await goneWithin([...standIns(j), j.guard], GONE_MS), []);
  } finally { stopOwn(pids); rmSync(dir, { recursive: true, force: true }); }
});

test("a second harness waits for the lock, with a log line, until the first harness's processes are gone", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-guard-"));
  // The first harness's Xvfb stand-in takes 1 s to end after its SIGTERM.
  const a = driver(dir, "first", { XVFB_SLOW: "1" });
  const i = await a.info;
  const pids = [...standIns(i), i.guard];
  try {
    const b = driver(dir, "second", { HARNESS_LOCK_WAIT: "30" });
    let bReady = 0;
    void b.info.then((j) => { bReady = Date.now(); pids.push(...standIns(j)); });
    await sleep(2500);
    assert.equal(bReady, 0, "the second harness started nothing while the first one ran");
    assert.ok(await logged(b.stderr, /harness-guard: second: waits for the harness lock .*harness\.lock \(guard=\d+ driver=\d+ name=first since=\S+\); it waits at most 30 s \(HARNESS_LOCK_WAIT\)/), b.stderr());
    a.child.kill("SIGKILL");
    const killed = Date.now();
    const j = await b.info;
    pids.push(...standIns(j));
    assert.deepEqual(running(standIns(i)), [], "the first harness's processes are gone");
    // The first harness's Xvfb stand-in ends 1 s after its SIGTERM: the second harness got the lock only after that.
    const locked = b.t0 + j.waitedMs;
    assert.ok(locked - killed >= 900, `the second harness got the lock ${locked - killed} ms after the kill`);
    assert.match(b.stderr(), /harness-guard: second: has the harness lock after \d+ s/);
    b.child.kill("SIGKILL");
    assert.deepEqual(await goneWithin(standIns(j), GONE_MS), []);
    assert.deepEqual(await goneWithin([j.guard], GONE_MS), []);
  } finally { stopOwn(pids); rmSync(dir, { recursive: true, force: true }); }
});

test("the wait has its limit: a harness that does not get the lock within HARNESS_LOCK_WAIT exits 2 and starts nothing", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-guard-"));
  const a = driver(dir, "holder");
  const i = await a.info;
  const pids = [...standIns(i), i.guard];
  try {
    const b = driver(dir, "late", { HARNESS_LOCK_WAIT: "1" });
    let started = false;
    void b.info.then(() => { started = true; });
    assert.equal(await Promise.race([b.exited, sleep(15_000).then(() => "still running after 15 s")]), 2);
    assert.equal(started, false);
    assert.match(b.stderr(), /late: the harness lock .*harness\.lock is still held after 1 s \(guard=\d+ driver=\d+ name=holder since=\S+\); the harness starts nothing/);
    a.child.kill("SIGKILL");
    assert.deepEqual(await goneWithin([...standIns(i), i.guard], GONE_MS), []);
  } finally { stopOwn(pids); rmSync(dir, { recursive: true, force: true }); }
});

test("a harness that a harness started does not wait for its parent's lock, and its own processes still end with it", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-guard-"));
  // The parent starts a nested driver (as anti-detect/mac.ts starts its second part); the nested one reports its pids too.
  const nested = `const { spawn } = require("node:child_process"); const fs = require("node:fs");
    const c = spawn(process.execPath, [${JSON.stringify(join(dir, "driver.mjs"))}], { stdio: ["ignore", "pipe", "inherit"], env: process.env });
    c.stdout.on("data", (b) => fs.appendFileSync(${JSON.stringify(join(dir, "nested.json"))}, b));
    process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
  const a = driver(dir, "parent", { NESTED: nested, HARNESS_LOCK_WAIT: "5" });
  const i = await a.info;
  const pids = [...standIns(i), i.guard];
  try {
    let n: any;
    for (let k = 0; k < 100 && !n; k++) { await sleep(100); try { n = JSON.parse(readFileSync(join(dir, "nested.json"), "utf8").split("\n")[0]); } catch { /* not yet */ } }
    assert.ok(n, `the nested harness started: ${a.stderr()}`);
    pids.push(...standIns(n), n.guard);
    assert.equal(n.mode, "nested");
    // HARNESS_LOCK_WAIT is 5 s: a nested harness that waited for the lock would have exited 2.
    assert.ok(n.guardMs < 4000, `the nested harness did not wait for the lock (${n.guardMs} ms)`);
    assert.doesNotMatch(a.stderr(), /nested: waits for the harness lock/);
    a.child.kill("SIGKILL");
    // The parent's guard stops the whole tree, the nested harness's stand-ins with it.
    assert.deepEqual(await goneWithin([...standIns(i), ...standIns(n)], GONE_MS), [], a.stderr());
    // The process between the two drivers ignores SIGTERM: the parent's guard ends it with SIGKILL after 5 s, and only
    // then ends itself.
    assert.deepEqual(await goneWithin([i.guard, n.guard], 25_000), [], a.stderr());
    assert.ok(await logged(a.stderr, /harness-guard: parent: every process of the harness is gone after \d+\.\d s \(SIGKILL after 5 s\); the lock is free/), a.stderr());
  } finally { stopOwn(pids); rmSync(dir, { recursive: true, force: true }); }
});

test("every harness under test/live that starts Xvfb takes the harness guard first", () => {
  const live = fileURLToPath(new URL("./live/", import.meta.url));
  const files = (readdirSync(live, { recursive: true }) as string[]).filter((f) => /\.(ts|mjs|js)$/.test(f)).sort();
  const starters = files.filter((f) => /(spawn|start)\("Xvfb"/.test(readFileSync(join(live, f), "utf8")));
  assert.deepEqual(starters, ["agent-mode/run.ts", "anti-detect/extra.ts", "anti-detect/mac.ts", "anti-detect/run.ts", "background-tabs/check.ts",
    "background-tabs/override.ts", "background-tabs/visibility.ts", "function-keys/check.ts", "parity/probe.ts"]);
  for (const f of starters) {
    const src = readFileSync(join(live, f), "utf8");
    const guard = src.indexOf("await harnessGuard("), xvfb = src.search(/(spawn|start)\("Xvfb"/);
    assert.ok(guard > 0 && guard < xvfb, `${f}: harnessGuard before its Xvfb`);
    assert.match(src, /\.track\(xvfb\.pid, "Xvfb"\)|harness\?\.track\(child\.pid/, `${f}: its Xvfb goes to track() at once`);
  }
});
