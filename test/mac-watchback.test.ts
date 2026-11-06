// agent-browser's give-back watcher as the Mac check runs it (test/live/anti-detect/mac-watchback.ts, ab-v16.68): a
// prototype of the start guard (src/giveback.ts) for as long as the agent Chrome runs. No real osascript and no real
// AppKit run here: the script runs in a vm context with a fake AppKit bridge (a scripted front app and clock), as in
// test/giveback.test.ts. Nothing activates a real app. The dry run's stand-in for it runs as a child process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, normalize } from "node:path";
import vm from "node:vm";
import { parseWatchBack, parseWatchBackReady, WATCH_BACK_MAX_MS, WATCH_BACK_SCRIPT, watchBackArgs } from "./live/anti-detect/mac-watchback.ts";
import { ROOT } from "./helpers.ts";

const BETA = "/Applications/Google Chrome Beta.app";
const STABLE = "/Applications/Google Chrome.app";

test("the watcher's argv: the script is a constant, and the bundle, the agent Chrome's pid and the time limit follow it as arguments", () => {
  const a = watchBackArgs(BETA, 701, 60_000, 4242), b = watchBackArgs("/Users/x/Odd \"name\" ${x}.app", 9_999_999, WATCH_BACK_MAX_MS, 1);
  assert.deepEqual(a, ["-l", "JavaScript", "-e", WATCH_BACK_SCRIPT, BETA, "701", "60000", "4242"]);
  assert.equal(b[3], a[3], "the same script for every bundle, pid and limit");
  assert.deepEqual(b.slice(4), ["/Users/x/Odd \"name\" ${x}.app", "9999999", String(WATCH_BACK_MAX_MS), "1"]);
  assert.equal(WATCH_BACK_SCRIPT.includes(BETA), false);
  assert.equal(WATCH_BACK_SCRIPT.includes("${"), false, "no template text in the script");
  for (const bundle of ["Google Chrome Beta.app", `${BETA}/`, "/a\n.app", ""]) assert.throws(() => watchBackArgs(bundle, 701, 60_000, 4242), /app bundle/, JSON.stringify(bundle));
  for (const pid of [0, -1, 1.5, 10_000_000, Number.NaN]) assert.throws(() => watchBackArgs(BETA, pid, 60_000, 4242), /pid/, String(pid));
  for (const ms of [999, WATCH_BACK_MAX_MS + 1, 1500.5]) assert.throws(() => watchBackArgs(BETA, 701, ms, 4242), /time limit/, String(ms));
  for (const pid of [0, 1.5, 10_000_000]) assert.throws(() => watchBackArgs(BETA, 701, 60_000, pid), /the check's own pid/, String(pid));
});

test("the watcher's script asks macOS to activate one app only, with the start guard's call, and uses no Apple Event, no System Events and no shell", () => {
  assert.deepEqual(WATCH_BACK_SCRIPT.match(/\.activate\w*\(/g), [".activateWithOptions("]);
  assert.match(WATCH_BACK_SCRIPT, /before\.activateWithOptions\(0\)/);
  for (const banned of ["Application(", "System Events", "doShellScript", "currentApplication", "NSAppleScript", "NSTask", "openURL", "launchApplication", "terminate(", "forceTerminate", "CGEventPost", "CGWarpMouseCursorPosition", "hide("])
    assert.equal(WATCH_BACK_SCRIPT.includes(banned), false, banned);
  assert.match(WATCH_BACK_SCRIPT, /^ObjC\.import\("AppKit"\);$/m);
  assert.match(WATCH_BACK_SCRIPT, /const POLL_S = 0\.025, RETRY_MS = 250, MAX_ASKS = 3, BEAT_POLLS = 10;/, "the start guard's poll, retry and asks, and a beat every 250 ms");
  assert.match(WATCH_BACK_SCRIPT, /try \{ ObjC\.import\("unistd"\);[^\n]*\} catch \(e\) \{ ppid = null; \}/, "getppid only where JXA can import it; else the pipe alone");
});

// ---------- the script, in a vm context with a fake AppKit bridge ----------

type FakeApp = { pid: number; bundleId: string | null; path: string | null; terminated?: boolean };

/**
 * A fake of the JXA bridge that the script uses, as test/giveback.test.ts's: time moves only when the script spins the
 * run loop. `events` change the front app (or quit an app) at a time (ms after the start); an activation request makes
 * its app the front `grantMs` later (null: macOS refuses it).
 */
function watchRun(argv: string[], p: {
  apps: FakeApp[]; front: number | null; events?: { at: number; front?: number | null; terminate?: number }[]; grantMs?: number | null; throwAt?: number;
  /** getppid as JXA bridges it after ObjC.import("unistd"): the parent pid from a time on (ms after the start), or none (the import fails). */
  ppid?: { at: number; pid: number }[] | "none";
  /** A write to standard output fails from this time on (ms after the start): the check's node process is gone (EPIPE). */
  pipeGoneAt?: number;
}) {
  const T0 = 1_800_000_000_000;
  p = { ...p, apps: p.apps.map((a) => ({ ...a })) };
  let clock = T0, front = p.front;
  const stdout: string[] = [], stderr: string[] = [], asks: { pid: number; at: number; options: unknown }[] = [], imports: string[] = [];
  const pending = [...(p.events ?? [])].map((e) => ({ ...e, at: T0 + e.at })).sort((a, b) => a.at - b.at);
  const NIL = { isNil: () => true };
  const nsString = (s: string) => ({ isNil: () => false, js: s, dataUsingEncoding: (enc: number) => { assert.equal(enc, 4); return { text: s }; } });
  const nsUrl = (path: string) => ({ isNil: () => false, URLByStandardizingPath: { isNil: () => false, path: nsString(normalize(path)) } });
  const find = (pid: number) => p.apps.find((a) => a.pid === pid);
  const deliver = () => {
    while (pending.length && pending[0].at <= clock) {
      const e = pending.shift()!;
      if (e.terminate !== undefined) find(e.terminate)!.terminated = true;
      if (e.front !== undefined) front = e.front;
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
      fileHandleWithStandardOutput: { writeData: (d: { text: string }) => { if (p.pipeGoneAt !== undefined && clock - T0 >= p.pipeGoneAt) throw new Error("NSFileHandleOperationException: Broken pipe"); stdout.push(d.text); } },
      fileHandleWithStandardError: { writeData: (d: { text: string }) => stderr.push(d.text) },
    },
    NSURL: { fileURLWithPath: (path: string) => nsUrl(path) },
    NSRunningApplication: { runningApplicationWithProcessIdentifier: (pid: number) => { const a = find(pid); return a && !a.terminated ? bridged(a) : NIL; } },
    NSWorkspace: {
      sharedWorkspace: {
        get frontmostApplication() {
          if (p.throwAt !== undefined && clock - T0 >= p.throwAt) throw new Error("bridge: no such property");
          return front === null ? NIL : bridged(find(front)!);
        },
      },
    },
    NSRunLoop: { currentRunLoop: { runUntilDate: (d: { seconds: number }) => { clock += Math.round(d.seconds * 1000); deliver(); } } },
    NSThread: { sleepForTimeInterval: (seconds: number) => { clock += Math.round(seconds * 1000); } },
    NSDate: { dateWithTimeIntervalSinceNow: (seconds: number) => ({ seconds }) },
  });
  class FakeDate extends Date {
    constructor(...a: []) { super(...((a.length ? a : [clock]) as [number])); }
    static now() { return clock; }
  }
  const ppid = p.ppid ?? [{ at: 0, pid: 4242 }];
  const objc = {
    import: (name: string) => {
      imports.push(name);
      if (name === "unistd") {
        if (ppid === "none") throw new Error("ObjC.import: no such library");
        Object.assign($, { getppid: () => [...ppid].reverse().find((x) => clock - T0 >= x.at)!.pid });
      }
    },
    unwrap: (o: { js?: unknown }) => o?.js,
  };
  const ctx = vm.createContext({ $, ObjC: objc, Date: FakeDate });
  vm.runInContext(WATCH_BACK_SCRIPT, ctx);
  (ctx as { run: (a: string[]) => unknown }).run(argv);
  const log = parseWatchBack(stderr.join(""));
  return { stdout, lines: log.map((l) => l.text), log, asks, imports, elapsed: clock - T0, ready: stdout.length ? parseWatchBackReady(stdout[0].trim()) : undefined };
}

const TERMINAL: FakeApp = { pid: 500, bundleId: "com.apple.Terminal", path: "/System/Applications/Utilities/Terminal.app" };
const FINDER: FakeApp = { pid: 600, bundleId: "com.apple.finder", path: "/System/Library/CoreServices/Finder.app" };
const AGENT: FakeApp = { pid: 701, bundleId: "com.google.Chrome.beta", path: BETA };
const args = [BETA, "701", "20000", "4242"];

test("the watcher names the app it gives the front back to, then gives the front back at each take of the agent Chrome, with 3 asks for each take, for as long as it runs", () => {
  const takes = [600, 2000, 4000, 6000, 8000].map((at) => ({ at, front: 701 }));
  const r = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, events: takes, grantMs: 40 });
  assert.deepEqual(r.ready, { before: 500, bundle: "com.apple.Terminal", agent: 701 });
  assert.equal(r.lines[0], "watch agent=701 before=500 parent=4242 ppid=yes");
  assert.equal(r.asks.length, 5, "five takes, five requests: unlike the start guard, the asks are for each take, not for the whole run");
  assert.ok(r.asks.every((a) => a.pid === 500 && a.options === 0));
  for (const [i, at] of [600, 2000, 4000, 6000, 8000].entries()) assert.ok(r.asks[i].at >= at && r.asks[i].at <= at + 30, `ask ${i} at ${r.asks[i].at} ms, within one 25 ms poll of the take at ${at}`);
  assert.equal(r.lines.filter((l) => l === "took=701 from=500").length, 5);
  for (const l of r.lines.filter((x) => x.startsWith("back="))) assert.match(l, /^back=500 after-ms=(4\d|5\d|6\d|7\d) asks=1$/);
  assert.match(r.lines[2], /^asked=500 n=1 sent=true$/);
  assert.equal(r.lines.at(-1), "end=bound");
  assert.ok(r.elapsed >= 20_000 && r.elapsed < 20_100, `${r.elapsed} ms`);
  // The log's times are the fake clock's: a take's took line comes at its poll.
  const took = r.log.find((l) => "took" in l.kv)!;
  assert.ok(took.t - 1_800_000_000_000 >= 600 && took.t - 1_800_000_000_000 <= 630);
});

test("macOS refuses: the watcher asks 3 times 250 ms apart for that take, then waits for the front to leave the agent Chrome, and gives the next take back again", () => {
  const r = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, events: [{ at: 600, front: 701 }, { at: 3000, front: 500 }, { at: 5000, front: 701 }, { at: 5100, front: 500 }], grantMs: null });
  assert.deepEqual(r.asks.map((a) => a.at - r.asks[0].at).slice(0, 3), [0, 250, 500]);
  assert.equal(r.asks.length, 4, "3 for the refused take, then 1 for the next one");
  assert.ok(r.lines.includes("refused=500 asks=3"));
  assert.ok(r.lines.some((l) => /^back=500 after-ms=24\d\d asks=3$/.test(l)), "the operator's app came back by other means");
  assert.equal(r.lines.filter((l) => l.startsWith("took=")).length, 2);
});

test("another app in front: from then on the watcher gives the front back to it, and a take that another app ends is over", () => {
  const r = watchRun(args, { apps: [TERMINAL, FINDER, AGENT], front: 500, events: [{ at: 300, front: 600 }, { at: 700, front: 701 }], grantMs: 40 });
  assert.deepEqual(r.lines.slice(1, 4), ["before=600", "took=701 from=600", "asked=600 n=1 sent=true"]);
  assert.deepEqual(r.asks.map((a) => a.pid), [600]);
  const mid = watchRun(args, { apps: [TERMINAL, FINDER, AGENT], front: 500, events: [{ at: 600, front: 701 }, { at: 640, front: 600 }], grantMs: null });
  assert.ok(mid.lines.some((l) => /^before=600 after-ms=\d+$/.test(l)), "a person (or macOS) chose another app during the take");
  assert.deepEqual(mid.asks.map((a) => a.pid), [500], "and no more asks for that take");
});

test("the watcher ends when the agent Chrome quits, never treats a pid of another bundle as the agent, and refuses to start with the agent in front or no front app", () => {
  const gone = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, events: [{ at: 1000, terminate: 701 }] });
  assert.equal(gone.lines.at(-1), "end=agent-gone");
  assert.ok(gone.elapsed >= 1000 && gone.elapsed < 1100);
  const other = watchRun([BETA, "600", "20000", "4242"], { apps: [TERMINAL, FINDER, AGENT], front: 500 });
  assert.deepEqual([other.ready?.before, other.lines], [0, ["end=no-agent"]], "pid 600 is Finder, not an instance of the agent's bundle");
  const stable = watchRun([STABLE, "701", "20000", "4242"], { apps: [TERMINAL, AGENT], front: 500 });
  assert.deepEqual(stable.lines, ["end=no-agent"], "the pid must be an instance of the bundle that it was given");
  const inFront = watchRun(args, { apps: [TERMINAL, AGENT], front: 701 });
  assert.deepEqual([inFront.ready?.before, inFront.lines], [0, ["end=agent-in-front"]], "it would give the front back to the agent Chrome itself");
  const none = watchRun(args, { apps: [TERMINAL, AGENT], front: null });
  assert.deepEqual([none.ready?.before, none.lines], [0, ["end=no-front"]]);
  assert.deepEqual(watchRun(args, { apps: [TERMINAL], front: 500 }).lines, ["end=no-agent"], "no such pid");
});

test("the watcher ends when the check's node process is gone: its parent pid changes (getppid), or its write to the check's pipe fails", () => {
  const r = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, ppid: [{ at: 0, pid: 4242 }, { at: 3000, pid: 1 }] });
  assert.equal(r.lines.at(-1), "end=parent-gone", "after a kill -9 of node, launchd (pid 1) is its parent");
  assert.ok(r.elapsed >= 3000 && r.elapsed <= 3300, `it ends within one beat of 250 ms (${r.elapsed} ms)`);
  assert.deepEqual(r.imports, ["AppKit", "unistd"]);
  const beats = r.stdout.slice(1);
  assert.ok(beats.length >= 11 && beats.every((b) => b === "\n"), `an empty line every 250 ms on the pipe that only the check reads (${beats.length})`);
  const pipe = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, ppid: "none", pipeGoneAt: 2000 });
  assert.equal(pipe.lines[0], "watch agent=701 before=500 parent=4242 ppid=no", "no getppid in this JXA: the pipe alone tells");
  assert.match(pipe.lines.at(-1)!, /^end=error ".*Broken pipe"$/, "with no reader the write fails (or SIGPIPE ends osascript at once)");
  assert.ok(pipe.elapsed >= 2000 && pipe.elapsed <= 2300, `${pipe.elapsed} ms`);
  const other = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, ppid: [{ at: 0, pid: 4243 }] });
  assert.equal(other.lines.at(-1), "end=parent-gone", "a parent that is not the check from the start: it ends at its first beat");
});

test("a bad argv ends the watcher before it reads anything; a bridge error is logged, never thrown", () => {
  for (const a of [[BETA, "701", "20000"], ["Chrome.app", "701", "20000", "4242"], [BETA, "0", "20000", "4242"], [BETA, "701", "999", "4242"], [BETA, "701", "1000000", "4242"], [BETA, "701", "20000", "0"]]) {
    const r = watchRun(a, { apps: [TERMINAL, AGENT], front: 500 });
    assert.deepEqual([r.stdout, r.lines], [[], ["end=usage"]], a.join(" "));
  }
  const r = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, throwAt: 300 });
  assert.match(r.lines.at(-1)!, /^end=error "Error: bridge: no such property"$/);
});

test("the ready line and the log of the watcher, as the check reads them", () => {
  assert.deepEqual(parseWatchBackReady('{"before":500,"bundle":"com.apple.Terminal","agent":701}'), { before: 500, bundle: "com.apple.Terminal", agent: 701 });
  assert.deepEqual(parseWatchBackReady('{"before":0,"bundle":null,"agent":701}'), { before: 0, bundle: null, agent: 701 });
  for (const bad of ["", "x", "{}", '{"before":-1,"agent":1}', '{"before":1}', '{"before":1.5,"agent":1}']) assert.equal(parseWatchBackReady(bad), undefined, bad);
  const log = parseWatchBack(["2026-11-06T10:00:00.000Z watch-back watch agent=701 before=500", "noise", "2026-11-06T10:00:01.250Z watch-back took=701 from=500",
    "2026-11-06T10:00:01.300Z watch-back back=500 after-ms=50 asks=1", "2026-11-06T10:00:09.000Z watch-back end=error \"Error: x=y\"", ""].join("\n"));
  assert.deepEqual(log.map((l) => l.t - Date.parse("2026-11-06T10:00:00.000Z")), [0, 1250, 1300, 9000]);
  assert.deepEqual(log[0].kv, { watch: "", agent: "701", before: "500" });
  assert.deepEqual(log[2].kv, { back: "500", "after-ms": "50", asks: "1" });
  assert.equal(log[3].kv.end, "error");
});

test("the dry run's stand-in for the watcher: its ready line names the given app, and it ends when the agent's pid is gone", async () => {
  const agent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600)"], { stdio: "ignore" });
  const child = spawn(process.execPath, [join(ROOT, "test", "live", "anti-detect", "mac-standin-watchback.ts"), String(agent.pid), "20000", "4242", String(process.pid)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout!.on("data", (b) => { out += b; });
  child.stderr!.on("data", (b) => { err += b; });
  const code = await new Promise((r) => child.once("exit", r));
  assert.equal(code, 0);
  assert.deepEqual(parseWatchBackReady(out.split("\n")[0]), { before: 4242, bundle: null, agent: agent.pid });
  assert.deepEqual(parseWatchBack(err).map((l) => l.text), [`watch agent=${agent.pid} before=4242 parent=${process.pid} ppid=yes`, "end=agent-gone"]);
});
