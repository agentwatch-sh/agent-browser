// The give-back guard of a macOS agent Chrome start (src/giveback.ts, ab-b84.11). No real osascript and
// no real AppKit run here: the guard's script runs in a vm context with a fake AppKit bridge (a scripted
// front app and clock), and startGiveBack runs a stand-in for osascript. Nothing activates a real app.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import vm from "node:vm";
import {
  GIVE_BACK_BOUND_MS, GIVE_BACK_GRACE_MS, GIVE_BACK_READY_MS, GIVE_BACK_SCRIPT, OSASCRIPT, giveBackArgs, giveBackToken, parseReady, startGiveBack,
} from "../src/giveback.ts";

const BETA = "/Applications/Google Chrome Beta.app";
const STABLE = "/Applications/Google Chrome.app";

test("the guard's argv: the script is a constant, and the bundle and the time limit follow it as arguments, never as script text", () => {
  const a = giveBackArgs(BETA), b = giveBackArgs("/Users/x/Apps/Odd \"name\" ${x}.app", 20_000);
  assert.deepEqual(a, ["-l", "JavaScript", "-e", GIVE_BACK_SCRIPT, BETA, String(GIVE_BACK_BOUND_MS)]);
  assert.equal(b[3], a[3], "the same script for every bundle and limit");
  assert.deepEqual(b.slice(4), ["/Users/x/Apps/Odd \"name\" ${x}.app", "20000"]);
  assert.equal(GIVE_BACK_SCRIPT.includes(BETA), false);
  assert.equal(GIVE_BACK_SCRIPT.includes("${"), false, "no template text in the script");
  assert.equal(OSASCRIPT, "/usr/bin/osascript");
});

test("the guard's argv refuses a path that is no app bundle, and a time limit that is no whole number from 1 to 60 s", () => {
  for (const bundle of ["Google Chrome Beta.app", "/Applications/Google Chrome Beta.app/", "/Applications/Google Chrome Beta", "/a.app\0/b.app", "/a\n.app", ""]) {
    assert.throws(() => giveBackArgs(bundle), /app bundle/, JSON.stringify(bundle));
  }
  for (const ms of [999, 60_001, 1500.5, Number.NaN, -1]) assert.throws(() => giveBackArgs(BETA, ms), /time limit/, String(ms));
  assert.equal(giveBackArgs(BETA, 1000).at(-1), "1000");
  assert.equal(giveBackArgs(BETA, 60_000).at(-1), "60000");
});

test("the guard's script asks macOS to activate one app only, the app in front at its start, and uses no Apple Event, no System Events and no shell", () => {
  assert.deepEqual(GIVE_BACK_SCRIPT.match(/\.activate\w*\(/g), [".activateWithOptions("]);
  assert.match(GIVE_BACK_SCRIPT, /before\.activateWithOptions\(0\)/);
  for (const banned of ["Application(", "System Events", "doShellScript", "currentApplication", "NSAppleScript", "NSTask", "openURL", "launchApplication", "terminate", "forceTerminate", "CGEventPost"]) {
    assert.equal(GIVE_BACK_SCRIPT.includes(banned), false, banned);
  }
  assert.match(GIVE_BACK_SCRIPT, /^ObjC\.import\("AppKit"\);$/m);
});

// ---------- the script, in a vm context with a fake AppKit bridge ----------

type FakeApp = { pid: number; bundleId: string | null; path: string | null; terminated?: boolean };

/**
 * A fake of the JXA bridge that the script uses: NSWorkspace (front app, running apps), NSRunningApplication,
 * NSURL, NSFileHandle, NSRunLoop and NSDate, and ObjC.import/unwrap. Time moves only when the script spins the
 * run loop. `events` change the front app at a time (ms after the start); an activation request makes its app
 * the front `grantMs` later (null: macOS refuses it).
 */
function guardRun(argv: string[], p: {
  apps: FakeApp[]; front: number | null; running?: number[]; events?: { at: number; front: number | null; terminate?: number }[]; grantMs?: number | null; throwAt?: number;
  /** The run loop has no input source, so runUntilDate returns at once (AppKit's documented case). */
  runLoopReturnsAtOnce?: boolean;
}) {
  const T0 = 1_800_000_000_000;
  p = { ...p, apps: p.apps.map((a) => ({ ...a })) }; // a quit marks this run's copy only
  let clock = T0, front = p.front, polls = 0, fronts = 0;
  const stdout: string[] = [], stderr: string[] = [], asks: { pid: number; at: number; options: unknown }[] = [], spins: number[] = [], sleeps: number[] = [], imports: string[] = [];
  const pending = [...(p.events ?? [])].map((e) => ({ ...e, at: T0 + e.at })).sort((a, b) => a.at - b.at);
  const NIL = { isNil: () => true };
  const nsString = (s: string) => ({ isNil: () => false, js: s, dataUsingEncoding: (enc: number) => { assert.equal(enc, 4); return { text: s }; } });
  const nsUrl = (path: string) => ({ isNil: () => false, URLByStandardizingPath: { isNil: () => false, path: nsString(normalize(path)) } });
  const find = (pid: number) => p.apps.find((a) => a.pid === pid)!;
  /** The front changes and quits that are due, as the run loop delivers them. */
  const deliver = () => {
    while (pending.length && pending[0].at <= clock) {
      const e = pending.shift()!;
      if (e.terminate !== undefined) find(e.terminate).terminated = true;
      else front = e.front;
    }
  };
  const bridged = (app: FakeApp) => ({
    isNil: () => false,
    get processIdentifier() { return app.pid; },
    get bundleIdentifier() { return app.bundleId === null ? NIL : nsString(app.bundleId); },
    get bundleURL() { return app.path === null ? NIL : nsUrl(app.path); },
    get isTerminated() { return !!app.terminated; },
    activateWithOptions(options: unknown) {
      asks.push({ pid: app.pid, at: clock - T0, options });
      if (p.grantMs !== null) pending.push({ at: clock + (p.grantMs ?? 40), front: app.pid }), pending.sort((a, b) => a.at - b.at);
      return true;
    },
  });
  const $ = Object.assign((s: string) => nsString(s), {
    NSUTF8StringEncoding: 4,
    NSFileHandle: {
      fileHandleWithStandardOutput: { writeData: (d: { text: string }) => stdout.push(d.text) },
      fileHandleWithStandardError: { writeData: (d: { text: string }) => stderr.push(d.text) },
    },
    NSURL: { fileURLWithPath: (path: string) => nsUrl(path) },
    NSWorkspace: {
      sharedWorkspace: {
        get frontmostApplication() {
          fronts++;
          if (p.throwAt !== undefined && clock - T0 >= p.throwAt) throw new Error("bridge: no such property");
          return front === null ? NIL : bridged(find(front));
        },
        get runningApplications() {
          const list = p.apps.filter((a) => (p.running ?? p.apps.map((x) => x.pid)).includes(a.pid));
          return { count: list.length, objectAtIndex: (i: number) => bridged(list[i]) };
        },
      },
    },
    NSRunLoop: {
      currentRunLoop: {
        runUntilDate: (d: { seconds: number }) => {
          polls++;
          spins.push(d.seconds);
          if (!p.runLoopReturnsAtOnce) clock += Math.round(d.seconds * 1000);
          deliver();
        },
      },
    },
    NSThread: { sleepForTimeInterval: (seconds: number) => { sleeps.push(seconds); clock += Math.round(seconds * 1000); } },
    NSDate: { dateWithTimeIntervalSinceNow: (seconds: number) => ({ seconds }) },
  });
  class FakeDate extends Date {
    constructor(...a: []) { super(...((a.length ? a : [clock]) as [number])); }
    static now() { return clock; }
  }
  const ObjC = { import: (name: string) => { imports.push(name); }, unwrap: (o: { js?: unknown }) => o?.js };
  const ctx = vm.createContext({ $, ObjC, Date: FakeDate });
  vm.runInContext(GIVE_BACK_SCRIPT, ctx);
  const result = (ctx as { run: (a: string[]) => unknown }).run(argv);
  const lines = stderr.map((l) => {
    assert.match(l, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z give-back [^\n]+\n$/, "one launches.log line");
    return l.slice("2027-01-15T08:00:00.000Z give-back ".length, -1);
  });
  return { result, stdout, lines, asks, polls, fronts, spins, sleeps, imports, elapsed: clock - T0, ready: stdout.length ? JSON.parse(stdout[0]) : undefined };
}

const TERMINAL: FakeApp = { pid: 500, bundleId: "com.apple.Terminal", path: "/System/Applications/Utilities/Terminal.app" };
const FINDER: FakeApp = { pid: 600, bundleId: "com.apple.finder", path: "/System/Library/CoreServices/Finder.app" };
const AGENT: FakeApp = { pid: 701, bundleId: "com.google.Chrome.beta", path: BETA };
const args = [BETA, "15000"];

test("the guard records the app in front and says so on standard output, then gives the front back when the new agent Chrome takes it, and keeps watching", () => {
  const r = guardRun(args, { apps: [TERMINAL, FINDER, AGENT], running: [500, 600], front: 500, events: [{ at: 600, front: 701 }], grantMs: 40 });
  assert.deepEqual(r.imports, ["AppKit"]);
  assert.deepEqual(r.ready, { before: 500, bundle: "com.apple.Terminal" });
  assert.equal(r.stdout.length, 1, "one line on standard output: the guard watches");
  assert.deepEqual(r.asks.map((a) => [a.pid, a.options]), [[500, 0]], "one request, to the app in front before, with no options");
  assert.ok(r.asks[0].at >= 600 && r.asks[0].at <= 650, `asked within one poll of the take (${r.asks[0].at} ms)`);
  assert.equal(r.lines[0], "took=701 from=500");
  assert.equal(r.lines[1], "asked=500 sent=true");
  assert.match(r.lines[2], /^back=500 after-ms=(4\d|5\d|6\d|7\d)$/, r.lines[2]);
  assert.equal(r.lines[3], "end=bound asks=1", "it watches until the start ends it, or at the latest to its time limit");
  assert.equal(r.lines.length, 4);
  assert.ok(r.elapsed >= 15_000 && r.elapsed < 15_100, `${r.elapsed} ms`);
  assert.ok(r.spins.every((s) => s === 0.025), "it polls every 25 ms, spinning the run loop so that AppKit's front app stays current");
  assert.deepEqual(r.sleeps, [], "the run loop waited, so no sleep");
  assert.equal(r.result, undefined, "nothing for osascript to print");
});

test("a second take of the front by the same new Chrome (session restore activates its last window at the end) is given back too, within 3 asks for the whole start", () => {
  const r = guardRun(args, { apps: [TERMINAL, AGENT], running: [500], front: 500, events: [{ at: 600, front: 701 }, { at: 1200, front: 701 }, { at: 2000, front: 701 }, { at: 3000, front: 701 }], grantMs: 40 });
  assert.deepEqual(r.asks.map((a) => a.pid), [500, 500, 500], "three takes, three requests");
  assert.deepEqual(r.lines.filter((l) => l.startsWith("took=")), ["took=701 from=500", "took=701 from=500", "took=701 from=500", "took=701 from=500"]);
  assert.equal(r.lines.filter((l) => l.startsWith("back=500")).length, 3);
  assert.equal(r.lines.at(-1), "end=limit asks=3", "a fourth take finds the asks spent: the guard stops, and the front stays with Chrome");
  assert.ok(r.elapsed >= 3000 && r.elapsed < 3100, `${r.elapsed} ms`);
});

test("the guard never treats an instance of the bundle that ran before the start as the new Chrome, such as the operator's own Google Chrome", () => {
  const own: FakeApp = { pid: 650, bundleId: "com.google.Chrome", path: STABLE };
  const agent: FakeApp = { pid: 702, bundleId: "com.google.Chrome", path: STABLE };
  const r = guardRun([STABLE, "15000"], { apps: [TERMINAL, own, agent], running: [500, 650], front: 500, events: [{ at: 300, front: 650 }] });
  assert.deepEqual(r.asks, []);
  assert.deepEqual(r.lines, ["before=650", "end=bound asks=0"], "the operator went to their own Chrome: it is now the app in front");
  // The operator's own Chrome in front before the start: the new instance of the same bundle is the agent's.
  const back = guardRun([STABLE, "15000"], { apps: [own, agent], running: [650], front: 650, events: [{ at: 700, front: 702 }] });
  assert.deepEqual(back.ready, { before: 650, bundle: "com.google.Chrome" });
  assert.deepEqual(back.asks.map((a) => a.pid), [650]);
  assert.match(back.lines[2], /^back=650 after-ms=\d+$/);
  // Another new instance of the bundle (a second start beside this one) is neither this start's Chrome nor an app to give the front back to.
  const other: FakeApp = { pid: 703, bundleId: "com.google.Chrome", path: STABLE };
  const two = guardRun([STABLE, "15000"], { apps: [TERMINAL, agent, other], running: [500], front: 500, events: [{ at: 600, front: 702 }, { at: 1000, front: 703 }, { at: 1500, front: 702 }], grantMs: null });
  assert.deepEqual(two.asks.map((a) => a.pid), [500, 500, 500], "it asks only for the Chrome that took the front first");
  assert.equal(two.lines.includes("before=703"), false);
});

test("a switch of the front by the operator before the take: the guard records that app and gives the front back to it", () => {
  const r = guardRun(args, { apps: [TERMINAL, FINDER, AGENT], running: [500, 600], front: 500, events: [{ at: 200, front: 600 }, { at: 700, front: 701 }], grantMs: 40 });
  assert.deepEqual(r.lines.slice(0, 3), ["before=600", "took=701 from=600", "asked=600 sent=true"]);
  assert.deepEqual(r.asks.map((a) => a.pid), [600], "the app in front just before the take, never the app in front at the guard's start");
  assert.match(r.lines[3], /^back=600 after-ms=\d+$/);
  // After the request, another app came to the front instead: that app is now the app in front, and the guard asks for nothing more.
  const after = guardRun(args, { apps: [TERMINAL, FINDER, AGENT], running: [500, 600], front: 500, events: [{ at: 600, front: 701 }, { at: 640, front: 600 }], grantMs: null });
  assert.deepEqual(after.asks.map((a) => a.pid), [500]);
  assert.deepEqual(after.lines.slice(-2), ["before=600", "end=bound asks=1"]);
});

test("macOS refuses the request: the guard asks again 250 ms apart, at most 3 times, then stops", () => {
  const r = guardRun(args, { apps: [TERMINAL, AGENT], running: [500], front: 500, events: [{ at: 600, front: 701 }], grantMs: null });
  assert.deepEqual(r.asks.map((a) => a.pid), [500, 500, 500]);
  const gaps = r.asks.slice(1).map((a, i) => a.at - r.asks[i].at);
  assert.ok(gaps.every((g) => g >= 250 && g < 300), `gaps ${gaps}`);
  assert.deepEqual(r.lines.filter((l) => l.startsWith("asked=")), ["asked=500 sent=true", "asked=500 sent=true", "asked=500 sent=true"]);
  assert.equal(r.lines.at(-1), "end=refused asks=3");
  assert.ok(r.elapsed < 600 + 3 * 300, `${r.elapsed} ms`);
});

test("the guard ends on its own at its time limit, with no app in front, or when the app to give the front back to quits during a take", () => {
  const quiet = guardRun([BETA, "2000"], { apps: [TERMINAL, AGENT], running: [500], front: 500 });
  assert.deepEqual(quiet.lines, ["end=bound asks=0"]);
  assert.ok(quiet.elapsed >= 2000 && quiet.elapsed < 2100, `${quiet.elapsed} ms`);
  assert.ok(quiet.polls >= 70 && quiet.polls <= 90, `about 80 polls of 25 ms (${quiet.polls})`);
  assert.deepEqual(quiet.asks, []);

  const none = guardRun(args, { apps: [AGENT], running: [], front: null });
  assert.deepEqual(none.ready, { before: 0, bundle: null });
  assert.deepEqual(none.lines, ["end=no-front asks=0"]);
  assert.equal(none.polls, 0);

  const gone = guardRun(args, { apps: [TERMINAL, AGENT], running: [500], front: 500, events: [{ at: 600, front: 701 }, { at: 700, front: 701, terminate: 500 }], grantMs: null });
  assert.deepEqual(gone.lines.slice(-1), ["end=gone asks=1"]);
  // With no take, a quit of that app ends nothing: the next app in front takes its place.
  const quit = guardRun([BETA, "2000"], { apps: [TERMINAL, FINDER, AGENT], running: [500, 600], front: 500, events: [{ at: 300, front: 500, terminate: 500 }, { at: 350, front: 600 }, { at: 900, front: 701 }], grantMs: 40 });
  assert.deepEqual(quit.asks.map((a) => a.pid), [600]);
  assert.deepEqual(quit.lines.slice(0, 2), ["before=600", "took=701 from=600"]);
});

test("a run loop with no input source returns at once: the guard then sleeps the rest of each 25 ms, so it never spins hot", () => {
  const r = guardRun(args, { apps: [TERMINAL, AGENT], running: [500], front: 500, events: [{ at: 600, front: 701 }], grantMs: 40, runLoopReturnsAtOnce: true });
  assert.ok(r.sleeps.length >= 590 && r.sleeps.every((s) => Math.abs(s - 0.025) < 1e-9), `${r.sleeps.length} sleeps`);
  assert.deepEqual(r.asks.map((a) => a.pid), [500]);
  assert.ok(r.lines.some((l) => /^back=500 /.test(l)));
  const quiet = guardRun([BETA, "1000"], { apps: [TERMINAL, AGENT], running: [500], front: 500, runLoopReturnsAtOnce: true });
  assert.ok(quiet.polls >= 38 && quiet.polls <= 42, `about 40 polls in 1 s (${quiet.polls})`);
});

test("a moment with no app in front (pid 0, nil) changes nothing", () => {
  const r = guardRun(args, { apps: [TERMINAL, AGENT], running: [500], front: 500, events: [{ at: 200, front: null }, { at: 260, front: 500 }, { at: 700, front: 701 }] });
  assert.deepEqual(r.asks.map((a) => a.pid), [500]);
  assert.deepEqual(r.lines.slice(0, 2), ["took=701 from=500", "asked=500 sent=true"]);
});

test("a bad argv ends the guard before it reads anything; a bridge error is logged, never thrown", () => {
  for (const argv of [[], [BETA], [BETA, "15000", "x"], ["relative.app", "15000"], [BETA, "15s"], [BETA, "999"], [BETA, "015000"], ["/a.app/", "15000"]]) {
    const r = guardRun(argv, { apps: [TERMINAL], front: 500 });
    assert.deepEqual(r.lines, ["end=usage"], JSON.stringify(argv));
    assert.equal(r.stdout.length, 0);
    assert.equal(r.fronts, 0, "it read no front app");
  }
  const broken = guardRun(args, { apps: [TERMINAL, AGENT], running: [500], front: 500, throwAt: 100 });
  assert.equal(broken.lines.length, 1);
  assert.match(broken.lines[0], /^end=error "Error: bridge: no such property"$/);
  assert.deepEqual(broken.asks, []);
});

test("the guard's ready line: a whole pid and a bundle id, or why it is no ready line", () => {
  assert.deepEqual(parseReady('{"before": 500, "bundle": "com.apple.Terminal"}'), { pid: 500, bundle: "com.apple.Terminal" });
  assert.deepEqual(parseReady('{"before": 500, "bundle": null}'), { pid: 500, bundle: null });
  assert.deepEqual(parseReady('{"before": 500, "bundle": "odd id with spaces"}'), { pid: 500, bundle: null }, "a bundle id that launches.log cannot hold as one token is left out");
  assert.deepEqual(parseReady('{"before": 0, "bundle": null}'), { pid: 0, bundle: null });
  for (const bad of ["", "{", '{"before": "500"}', '{"before": -1}', '{"before": 1.5}', '{"bundle": "x"}', "[500]", "null"]) assert.equal(parseReady(bad), undefined, bad);
});

test("the launches.log token says whether the guard watches, the app it gives the front back to, and how long the start waited for it", () => {
  const finish = async () => {};
  assert.equal(giveBackToken(undefined), "give-back=off");
  assert.equal(giveBackToken({ state: "on", front: { pid: 500, bundle: "com.apple.Terminal" }, readyMs: 183, finish }), "give-back=on front=500/com.apple.Terminal ready-ms=183");
  assert.equal(giveBackToken({ state: "on", front: { pid: 500, bundle: null }, readyMs: 90, finish }), "give-back=on front=500 ready-ms=90");
  for (const state of ["not-ready", "failed", "no-front"] as const) assert.equal(giveBackToken({ state, finish }), `give-back=${state}`);
});

// ---------- startGiveBack, with a stand-in for osascript ----------

/** A stand-in for osascript: it records its argv, then acts as FAKE_GUARD says (a JSON object). */
function fakeOsascript() {
  const dir = mkdtempSync(join(tmpdir(), "ab-giveback-"));
  const bin = join(dir, "osascript");
  writeFileSync(bin, `#!${process.execPath}
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const o = JSON.parse(process.env.FAKE_GUARD || "{}");
writeFileSync(join(${JSON.stringify(dir)}, "argv-" + process.pid + ".json"), JSON.stringify(process.argv.slice(2)));
process.on("SIGTERM", () => { writeFileSync(join(${JSON.stringify(dir)}, "sigterm-" + process.pid), ""); process.exit(0); });
setTimeout(() => {
  if (o.stdout !== undefined) process.stdout.write(o.stdout);
  if (o.stderr) process.stderr.write(o.stderr);
  if (o.exitMs !== undefined) setTimeout(() => process.exit(0), o.exitMs);
}, o.readyAfterMs ?? 0);
setInterval(() => {}, 1000);
`);
  chmodSync(bin, 0o755);
  const log = join(dir, "launches.log");
  writeFileSync(log, "earlier line\n");
  return { dir, bin, log, logText: () => readFileSync(log, "utf8"), cleanup: () => rmSync(dir, { recursive: true, force: true }), sigterm: (pid: number) => { try { readFileSync(join(dir, `sigterm-${pid}`)); return true; } catch { return false; } } };
}
const withEnv = async <T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> => {
  const old = process.env.FAKE_GUARD;
  process.env.FAKE_GUARD = env.FAKE_GUARD;
  try { return await fn(); } finally { if (old === undefined) delete process.env.FAKE_GUARD; else process.env.FAKE_GUARD = old; }
};
const alive = (pid: number | undefined) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

test("startGiveBack: the guard is ready once it names the front app; its log lines go to launches.log; the start does not wait for its end", async () => {
  const f = fakeOsascript();
  try {
    const g = await withEnv({ FAKE_GUARD: JSON.stringify({ stdout: '{"before": 500, "bundle": "com.apple.Terminal"}\n', stderr: "2026-11-04T10:00:00.000Z give-back took=701 from=500\n", exitMs: 300 }) },
      () => startGiveBack(BETA, f.log, { bin: f.bin }));
    assert.equal(g.state, "on");
    assert.deepEqual(g.front, { pid: 500, bundle: "com.apple.Terminal" });
    assert.ok(typeof g.readyMs === "number" && g.readyMs < GIVE_BACK_READY_MS);
    assert.ok(alive(g.pid), "it still watches after it is ready");
    await g.finish(GIVE_BACK_GRACE_MS);
    assert.equal(alive(g.pid), false, "it ended by itself within the grace");
    assert.equal(f.sigterm(g.pid!), false, "so the launch did not end it");
    assert.equal(f.logText(), "earlier line\n2026-11-04T10:00:00.000Z give-back took=701 from=500\n", "appended to launches.log, and nothing from the start");
    const [argv] = readdirSync(f.dir).filter((n) => n.startsWith("argv-")).map((n) => JSON.parse(readFileSync(join(f.dir, n), "utf8")));
    assert.deepEqual(argv, giveBackArgs(BETA));
  } finally { f.cleanup(); }
});

test("startGiveBack: finish ends a guard that still watches, and says so in launches.log", async () => {
  const f = fakeOsascript();
  try {
    const g = await withEnv({ FAKE_GUARD: JSON.stringify({ stdout: '{"before": 500, "bundle": null}\n' }) }, () => startGiveBack(BETA, f.log, { bin: f.bin }));
    assert.equal(g.state, "on");
    const t = Date.now();
    await g.finish(200);
    assert.ok(Date.now() - t < 1500, "the launch waited the grace, then ended it");
    for (let i = 0; i < 50 && alive(g.pid); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(f.sigterm(g.pid!), "SIGTERM");
    assert.match(f.logText(), /\n\d{4}-\d\d-\d\dT[\d:.]+Z give-back end=stopped by=launch\n$/);
    await g.finish(200);
    assert.equal(f.logText().match(/end=stopped/g)?.length, 1, "a second finish does nothing");
  } finally { f.cleanup(); }
});

test("startGiveBack never throws and never holds a start up for long: not ready in time, ended early, a bad line, no front app, no osascript", async () => {
  const f = fakeOsascript();
  try {
    const slow = await withEnv({ FAKE_GUARD: JSON.stringify({ readyAfterMs: 5000, stdout: '{"before": 500}\n' }) }, () => startGiveBack(BETA, f.log, { bin: f.bin, readyMs: 300 }));
    assert.equal(slow.state, "not-ready");
    for (let i = 0; i < 50 && alive(slow.pid); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(f.sigterm(slow.pid!), "a guard that is not ready in time is ended: it could record the new Chrome as the app in front");

    const ended = await withEnv({ FAKE_GUARD: JSON.stringify({ stdout: "", exitMs: 0 }) }, () => startGiveBack(BETA, f.log, { bin: f.bin }));
    assert.equal(ended.state, "failed");

    const bad = await withEnv({ FAKE_GUARD: JSON.stringify({ stdout: "not json\n" }) }, () => startGiveBack(BETA, f.log, { bin: f.bin }));
    assert.equal(bad.state, "failed");
    for (let i = 0; i < 50 && alive(bad.pid); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(f.sigterm(bad.pid!));

    const none = await withEnv({ FAKE_GUARD: JSON.stringify({ stdout: '{"before": 0, "bundle": null}\n', exitMs: 0 }) }, () => startGiveBack(BETA, f.log, { bin: f.bin }));
    assert.equal(none.state, "no-front");

    const missing = await startGiveBack(BETA, f.log, { bin: join(f.dir, "no-such-osascript") });
    assert.equal(missing.state, "failed");
    await missing.finish(GIVE_BACK_GRACE_MS);

    const noBundle = await startGiveBack("/not/a/bundle", f.log, { bin: f.bin });
    assert.equal(noBundle.state, "failed");
    assert.equal(noBundle.pid, undefined, "nothing started");
  } finally { f.cleanup(); }
});

test("startGiveBack: an error event from the guard after its ready line (a signal that cannot be sent) never throws in the start", async () => {
  const f = fakeOsascript();
  try {
    let guard: ChildProcess | undefined;
    const g = await withEnv({ FAKE_GUARD: JSON.stringify({ stdout: '{"before": 500, "bundle": null}\n' }) },
      () => startGiveBack(BETA, f.log, { bin: f.bin, spawn: (bin, a, o) => (guard = spawn(bin, a, o)) }));
    assert.equal(g.state, "on");
    assert.doesNotThrow(() => guard!.emit("error", new Error("kill EPERM")));
    await g.finish(0);
    for (let i = 0; i < 50 && alive(g.pid); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(f.sigterm(g.pid!), "the launch still ends it");
  } finally { f.cleanup(); }
});

test("startGiveBack runs no real osascript under node --test: a test can never activate a real app", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-giveback-"));
  try {
    const g = await startGiveBack(BETA, join(dir, "launches.log"));
    assert.equal(g.state, "failed");
    assert.equal(g.pid, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
