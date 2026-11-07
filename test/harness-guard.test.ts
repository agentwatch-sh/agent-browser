// The live harnesses' guard (board ab-v16.78; test/live/guard.ts and test/live/harness_guard.py): a stand-in driver
// starts the guard as a harness does, then its stand-in processes (an "Xvfb", a "Chromium" with its own session and a
// child, as the agent Chrome of launchAgentChrome, and a "daemon" that it does not name to the guard, which only the
// guard's record of the driver's tree finds). After a kill -9 of the driver, ps must find none of them within
// GONE_MS. A second harness waits for the lock until the first harness's processes are gone; its wait has a limit.
// Each test has a lock file of its own (HARNESS_LOCK), never the real one. Linux only (the guard is).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
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
// OLD: a pid that is not the driver's (the test's own older process): the guard must leave it alone.
if (process.env.OLD) guard.track(Number(process.env.OLD), "old");
// LATE: a recorded process that starts a child (sleep LATE) at its SIGTERM, after the driver's end.
if (process.env.LATE) guard.track(spawn("python3", ["-c", "import signal, subprocess, time; signal.signal(signal.SIGTERM, lambda *a: subprocess.Popen(['sleep', '" + process.env.LATE + "'])); time.sleep(600)"], { stdio: "ignore" }).pid, "late");
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
    assert.match(d.stderr(), /harness-guard: kill9: HARNESS_LOCK names \S+harness\.lock, not the harness lock \S+\/\.cache\/agent-harness\/harness\.lock: this harness waits only for harnesses with the same HARNESS_LOCK/);
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

test("the reserved displays: guard.ts keeps harness_guard.py's list, and the parity probe's display search skips them", () => {
  const py = readFileSync(fileURLToPath(new URL("./live/harness_guard.py", import.meta.url)), "utf8");
  const list = (/^RESERVED_DISPLAYS = \(([^)]*)\)/m.exec(py)?.[1] ?? "").split(",").map((x) => Number(x.trim()));
  const ts = readFileSync(GUARD_TS, "utf8");
  assert.deepEqual((/RESERVED_DISPLAYS: readonly number\[\] = \[([^\]]*)\]/.exec(ts)?.[1] ?? "").split(",").map((x) => Number(x.trim())), list);
  assert.deepEqual(list, [0, 90, 147, 190, 191, 192]);
  const probe = readFileSync(fileURLToPath(new URL("./live/parity/probe.ts", import.meta.url)), "utf8");
  assert.match(probe, /let n = 90;\n\s+while \(RESERVED_DISPLAYS\.includes\(n\) \|\| existsSync/);
});

/** Run `code` in Python with harness_guard importable (no byte code). */
const py = (code: string) => spawnSync("python3", ["-I", "-B", "-c", `import sys; sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL("./live/", import.meta.url)))})\n${code}`], { encoding: "utf8", timeout: 60_000 });

test("a record whose pid another process took since (another start time) gets no signal; a record with its own start time does", { skip }, () => {
  const r = py(`
import argparse, subprocess, harness_guard as h
a = argparse.Namespace(name="stale", driver=0, pid_dir=None, channel_fd=0, limit=0, wait=1)
for start_delta in (1, 0):
    p = subprocess.Popen(["sleep", "30"])
    g = h.Guard(a)
    g.rec[p.pid] = [h.stat_of(p.pid)[1] + start_delta, "x", None]  # no pidfd: the start-time check alone
    g.reason = "the test"
    g.stop()
    print("alive" if p.poll() is None else "stopped")
    p.kill(); p.wait()
`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["alive", "stopped"], r.stderr);
});

test("a pid that the driver names but that is neither in its tree nor started after the guard is left alone", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-guard-"));
  const old = spawn("sleep", ["606"], { stdio: "ignore", detached: true });
  old.unref();
  const pids = [old.pid!];
  try {
    await sleep(1100); // the start-time clock counts 1/100 s
    const d = driver(dir, "old", { OLD: String(old.pid) });
    const i = await d.info;
    pids.push(...standIns(i), i.guard);
    d.child.kill("SIGKILL");
    assert.deepEqual(await goneWithin(standIns(i), GONE_MS), []);
    assert.deepEqual(await goneWithin([i.guard], GONE_MS), []);
    assert.deepEqual(running([old.pid!]), [old.pid], "the older process still runs");
    assert.ok(await logged(d.stderr, new RegExp(`harness-guard: old: leaves pid ${old.pid} \\(old\\) alone: it is not in the driver's tree and it started before the guard`)), d.stderr());
  } finally { stopOwn(pids); rmSync(dir, { recursive: true, force: true }); }
});

test("a child that a recorded process starts after the driver's end (outside the driver's tree) is stopped too", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-guard-"));
  const late = `607.${process.pid}${Date.now() % 1000}`;
  const lateOnes = () => execFileSync("ps", ["-e", "-o", "pid=,args="], { encoding: "utf8" }).split("\n").filter((l) => l.trim().endsWith(`sleep ${late}`)).map((l) => Number(l.trim().split(" ")[0]));
  const pids: number[] = [];
  try {
    const d = driver(dir, "late", { LATE: late });
    const i = await d.info;
    pids.push(...standIns(i), i.guard);
    d.child.kill("SIGKILL");
    assert.deepEqual(await goneWithin([i.guard], 25_000), [], d.stderr());
    assert.deepEqual(lateOnes(), [], `the late child is gone: ${d.stderr()}`);
  } finally { stopOwn([...pids, ...lateOnes()]); rmSync(dir, { recursive: true, force: true }); }
});

test("a harness that is not a child of the holder's driver waits for the lock, also with HARNESS_GUARD_HELD naming the holder", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-guard-"));
  const a = driver(dir, "holder");
  const i = await a.info;
  const pids = [...standIns(i), i.guard];
  try {
    const x = driver(dir, "unrelated", { HARNESS_GUARD_HELD: String(i.guard), HARNESS_LOCK_WAIT: "1" });
    assert.equal(await Promise.race([x.exited, sleep(15_000).then(() => "still running after 15 s")]), 2, x.stderr());
    assert.match(x.stderr(), /unrelated: the harness lock .* is still held after 1 s/);
    a.child.kill("SIGKILL");
    assert.deepEqual(await goneWithin([...standIns(i), i.guard], GONE_MS), []);
  } finally { stopOwn(pids); rmSync(dir, { recursive: true, force: true }); }
});

test("the guard closes the fds that it inherited (an outer lock's fd, a caller's pipe), and stops at a missing pipe", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-guard-"));
  const pids: number[] = [];
  try {
    // As under `flock heavy.lock run.sh up`: a shell gives the guard an open fd 7 (the outer lock's) and its stderr
    // pipe. The call must return at once (the guard keeps no pipe of the caller), and the guard must hold no fd 7.
    const marker = join(dir, "outer.lock");
    writeFileSync(marker, "");
    mkdirSync(join(dir, "pids"));
    const up = spawnSync("/bin/sh", ["-c", `exec 7<"${marker}"; python3 -I -B "${fileURLToPath(new URL("./live/harness_guard.py", import.meta.url))}" --name fds --driver 0 --limit 60 --pid-dir "${join(dir, "pids")}" --log "${join(dir, "guard.log")}" 2>&1`],
      { env: { ...process.env, HARNESS_LOCK: join(dir, "harness.lock") }, encoding: "utf8", timeout: 15_000 });
    assert.equal(up.status, 0, `the call returned (${up.error?.message ?? ""}): ${up.stdout}`);
    const guardPid = Number(/^locked (\d+) /m.exec(up.stdout)?.[1]);
    pids.push(guardPid);
    const links = readdirSync(`/proc/${guardPid}/fd`).map((n) => { try { return readlinkSync(`/proc/${guardPid}/fd/${n}`); } catch { return ""; } });
    assert.ok(!links.includes(marker), `the guard holds no fd of ${marker}: ${links.join(" ")}`);
    assert.ok(links.some((l) => l.endsWith("harness.lock")), "it holds the harness lock");
    assert.equal(readlinkSync(`/proc/${guardPid}/fd/2`), join(dir, "guard.log"), "its stderr is the run's log, not the caller's pipe");
    process.kill(guardPid, "SIGTERM");
    assert.deepEqual(await goneWithin([guardPid], GONE_MS), []);
    // A pipe fd that the driver did not give: the guard sees no end there, so it stops the driver's processes at once.
    const sh = spawn("/bin/sh", ["-c", "sleep 608 & wait"], { stdio: "ignore" });
    pids.push(sh.pid!);
    await sleep(300);
    const kid = running([sh.pid!]).filter((p) => p !== sh.pid);
    pids.push(...kid);
    const g = spawn("python3", ["-I", "-B", fileURLToPath(new URL("./live/harness_guard.py", import.meta.url)), "--name", "nofd", "--driver", String(sh.pid), "--channel-fd", "9"],
      { env: { ...process.env, HARNESS_LOCK: join(dir, "harness.lock") }, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    g.stderr!.on("data", (b) => { err += b; });
    assert.deepEqual(await goneWithin(kid, GONE_MS), [], err);
    assert.ok(await logged(() => err, /harness-guard: nofd: the driver's pipe \(fd 9\) is missing; it stops 1 processes of the harness: sleep \d+/), err);
    assert.doesNotMatch(err, /Traceback/);
  } finally { stopOwn(pids); rmSync(dir, { recursive: true, force: true }); }
});

test("every harness refuses a reserved display that its option names (--display 90, DISPLAY_N=90) before it makes or starts anything", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-guard-"));
  try {
    const live = fileURLToPath(new URL("./live/", import.meta.url));
    // A stand-in chrome-extension checkout: the agent-mode run checks only that its two files are there.
    mkdirSync(join(dir, "ext/agent"), { recursive: true });
    mkdirSync(join(dir, "ext/test/live"), { recursive: true });
    writeFileSync(join(dir, "ext/agent/manifest.json"), "{}");
    writeFileSync(join(dir, "ext/test/live/host.py"), "");
    // Stand-ins that fail at once, first on PATH: a harness whose check let the display through starts no real Xvfb
    // (and the agent-mode run no npm install); it then fails with another message, and the row fails.
    mkdirSync(join(dir, "bin"));
    for (const bin of ["Xvfb", "npm"]) writeFileSync(join(dir, "bin", bin), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const PATH = `${join(dir, "bin")}:${process.env.PATH}`;
    const out = join(dir, "out");
    const rows: [string, string[], Record<string, string>, RegExp][] = [
      ["background-tabs/check.ts", ["--display", "90"], {}, /^--display names :90, a reserved display/],
      ["background-tabs/override.ts", ["--display", "90"], {}, /^--display names :90, a reserved display/],
      ["background-tabs/visibility.ts", ["--display", "90"], {}, /^--display names :90, a reserved display/],
      ["function-keys/check.ts", ["--display", "90"], {}, /^--display names :90, a reserved display/],
      ["anti-detect/run.ts", ["--display", "147"], {}, /^--display names :147, a reserved display/],
      ["anti-detect/extra.ts", ["--display", "0"], {}, /--display/],
      ["anti-detect/extra.ts", ["--display", "190"], {}, /^--display names :190, a reserved display/],
      ["anti-detect/mac.ts", ["--dry-run", "--display", "90"], {}, /^--display names :90, a reserved display/],
      // The dry run's stable part takes the next display: 89 would give :90, 146 :147, 189 :190.
      ["anti-detect/mac.ts", ["--dry-run", "--display", "89"], {}, /^--display 89 \(its stable part takes the next one\) names :90, a reserved display/],
      ["anti-detect/mac.ts", ["--dry-run", "--display", "146"], {}, /names :147, a reserved display/],
      ["anti-detect/mac.ts", ["--dry-run", "--display", "189"], {}, /names :190, a reserved display/],
      ["agent-mode/run.ts", [], { DISPLAY_N: "90", CHROME_EXTENSION: join(dir, "ext"), SITE_PORT: "0" }, /^DISPLAY_N names :90, a reserved display/],
    ];
    for (const [file, args, env, want] of rows) {
      const r = spawnSync(process.execPath, [join(live, file), ...(file.startsWith("agent-mode") ? [] : ["--out-dir", out]), ...args],
        { env: { ...process.env, PATH, CHROMIUM: "/bin/false", HARNESS_LOCK: join(dir, "harness.lock"), ...env }, encoding: "utf8", timeout: 60_000 });
      assert.equal(r.status, 2, `${file} ${args.join(" ")} ${JSON.stringify(env)}: ${r.stderr}`);
      assert.match(r.stderr, want, `${file} ${args.join(" ")}`);
      assert.doesNotMatch(r.stderr, /harness-guard/, `${file}: no guard, no lock`);
    }
    assert.equal(existsSync(out), false, "no harness made its out dir");
    assert.equal(existsSync(join(dir, "harness.lock")), false, "no harness took the lock");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the option parsers: a reserved display is refused, its neighbours are not; the stable part checks only its own display", async () => {
  const { startMode: bt } = await import("./live/background-tabs/rules.ts");
  const { startMode: fk } = await import("./live/function-keys/trials.ts");
  const { macArgs } = await import("./live/anti-detect/mac-rules.ts");
  const { reservedDisplay } = await import("./live/guard.ts");
  for (const n of [0, 90, 147, 190, 191, 192]) assert.match(reservedDisplay(n, "--display") ?? "", new RegExp(`^--display names :${n}, a reserved display`));
  for (const n of [1, 89, 91, 146, 148, 189, 193]) assert.equal(reservedDisplay(n, "--display"), null);
  assert.match((bt("linux", { display: "90" }) as { error: string }).error, /reserved display/);
  assert.equal((bt("linux", { display: "91" }) as { display: number }).display, 91);
  assert.match((fk("linux", { display: "192" }) as { error: string }).error, /names :192, a reserved display/);
  assert.equal((fk("linux", { display: "91" }) as { display: number }).display, 91);
  const linux = { platform: "linux", exists: (p: string) => p === "/usr/bin/chromium", defaultChrome: "/x" };
  assert.equal(macArgs(["--dry-run", "--out-dir", "/tmp/o", "--display", "88"], linux).ok, true);
  assert.equal(macArgs(["--dry-run", "--out-dir", "/tmp/o", "--display", "89"], linux).ok, false);
  const stable = (d: string) => macArgs(["--dry-run", "--part", "stable", "--quiet-since", "1", "--pointer", "1,2", "--out-dir", "/tmp/o", "--display", d], linux);
  assert.equal(stable("146").ok, true, "the stable part runs on its own display only");
  assert.equal(stable("147").ok, false);
});

test("record() keeps no pidfd of a process whose start time is not the snapshot's (the pid was taken again)", { skip }, () => {
  const r = py(`
import argparse, os, subprocess, harness_guard as h
a = argparse.Namespace(name="snap", driver=0, pid_dir=None, channel_fd=0, limit=0, wait=1)
g = h.Guard(a)
p = subprocess.Popen(["sleep", "30"])
st = h.stat_of(p.pid)
g.record(p.pid, (st[0], st[1] - 1, st[2], st[3]))  # a snapshot of the process that had this pid before
print("stale", p.pid in g.rec)
g.record(p.pid, st)
print("own", p.pid in g.rec and g.rec[p.pid][2] is not None)
p.kill(); p.wait()
`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["stale False", "own True"], r.stderr);
});

test("watch() compares the driver's start time before it records the driver's tree: a dead driver's pid that another process took adds no record", { skip }, () => {
  const r = py(`
import argparse, os, subprocess, time, harness_guard as h
p = subprocess.Popen(["sh", "-c", "sleep 30 & wait"])  # another process with a child now has the driver's pid
time.sleep(0.3)
rd, wr = os.pipe()  # the driver's pipe stays open: only the start time tells that the driver is gone
a = argparse.Namespace(name="reused", driver=p.pid, pid_dir=None, channel_fd=rd, channel_missing=False, limit=0, wait=1)
g = h.Guard(a)
g.driver_start = h.stat_of(p.pid)[1] - 1
g.watch()
print("reason", g.reason)
print("records", sorted(g.rec))
g.stop()
print("alive", p.poll() is None, len(h.tree(h.table(), [p.pid])))
p.kill(); p.wait()
`);
  assert.equal(r.status, 0, r.stderr);
  const [reason, records, alive] = r.stdout.trim().split("\n");
  assert.match(reason, /^reason the driver \d+ is gone$/);
  assert.equal(records, "records []");
  assert.equal(alive, "alive True 1", "the other process and its child still run");
});
