// The Mac's give-back watcher script (src/watchback.ts; board task ab-v16.27, the operator's answer ab-or9), which the
// service's Mac Chrome runs (src/service/unit/mac-chrome.ts): for as long as the agent Chrome runs it gives the front
// back to the operator's app each time the agent Chrome takes it, and it never fights the operator (a click, the Command
// key, a hold file, a start in front). No real osascript and no real AppKit run here: the script runs in a vm context
// with a fake AppKit bridge (a scripted front app, input and clock), as in test/giveback.test.ts. Nothing activates a
// real app. Board ab-v16.9.3 removed the watcher's own node process (`give-back-watch`), which only the agent Chrome that
// agent-browser started itself used, and its tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize } from "node:path";
import vm from "node:vm";
import { parseWatchLines, parseWatchReady, WATCH_BACK_SCRIPT, watchBackArgs } from "../src/watchback.ts";

const BETA = "/Applications/Google Chrome Beta.app";
const STABLE = "/Applications/Google Chrome.app";

test("the watcher's argv: the script is a constant, and the bundle, the agent Chrome's pid, its node process's pid and the state folder follow it", () => {
  const a = watchBackArgs(BETA, 701, 4242, "/srv/x/state"), b = watchBackArgs("/srv/x/Odd \"name\" ${x}.app", 9_999_999, 1, "/a b/c");
  assert.deepEqual(a, ["-l", "JavaScript", "-e", WATCH_BACK_SCRIPT, BETA, "701", "4242", "/srv/x/state"]);
  assert.equal(b[3], a[3], "the same script for every argument");
  assert.equal(WATCH_BACK_SCRIPT.includes(BETA), false);
  assert.equal(WATCH_BACK_SCRIPT.includes("${"), false, "no template text in the script");
  for (const bundle of ["Google Chrome Beta.app", `${BETA}/`, "/a\n.app", ""]) assert.throws(() => watchBackArgs(bundle, 701, 4242, "/s"), /app bundle/, JSON.stringify(bundle));
  for (const pid of [0, -1, 1.5, 10_000_000, Number.NaN]) assert.throws(() => watchBackArgs(BETA, pid, 4242, "/s"), /agent Chrome's pid/, String(pid));
  for (const pid of [0, 1.5]) assert.throws(() => watchBackArgs(BETA, 701, pid, "/s"), /node process's pid/, String(pid));
  for (const dir of ["state", "/a\nb", ""]) assert.throws(() => watchBackArgs(BETA, 701, 4242, dir), /absolute state folder/, JSON.stringify(dir));
});

test("the watcher's script asks macOS to activate one app only, with the start guard's call, and uses no Apple Event, no System Events, no shell and no input", () => {
  assert.deepEqual(WATCH_BACK_SCRIPT.match(/\.activate\w*\(/g), [".activateWithOptions("]);
  assert.match(WATCH_BACK_SCRIPT, /before\.activateWithOptions\(0\)/);
  for (const banned of ["Application(", "System Events", "doShellScript", "currentApplication", "NSAppleScript", "NSTask", "openURL", "launchApplication", "terminate(", "forceTerminate",
    "CGEventPost", "CGEventCreate", "CGWarpMouseCursorPosition", "CGEventTap", "addGlobalMonitor", "hide(", "writeToFile", "removeItem"])
    assert.equal(WATCH_BACK_SCRIPT.includes(banned), false, banned);
  assert.match(WATCH_BACK_SCRIPT, /^ObjC\.import\("AppKit"\);$/m);
  assert.match(WATCH_BACK_SCRIPT, /const POLL_S = 0\.025, RETRY_MS = 250, MAX_ASKS = 3, BEAT_POLLS = 10, LOOKUP_POLLS = 40, OWN_MS = 1000, COMMAND = 1048576;/);
  assert.equal(1 << 20, 1048576, "NSEventModifierFlagCommand");
  assert.match(WATCH_BACK_SCRIPT, /\$\.getppid\(\) === parentPid\) ppid = /, "getppid only when its first value is the node process (review-66b F)");
});

// ---------- the script, in a vm context with a fake AppKit bridge ----------

type FakeApp = { pid: number; bundleId: string | null; path: string | null; terminated?: boolean; lost?: boolean };
type Ev = { at: number; front?: number | null; terminate?: number; lose?: number; mouse?: boolean; command?: boolean; shift?: boolean; tap?: boolean };

/**
 * A fake of the JXA bridge that the script uses, as test/giveback.test.ts's: time moves only when the script spins the
 * run loop. `events` change the front app, quit an app (terminate: its object says so; lose: only a look-up again
 * finds it gone, as the second Google Chrome instance of 2026-11-06), press or release a mouse button or the Command
 * key (NSEvent's state), or tap (a press and a release between two polls: only CoreGraphics' HID time shows it), at a
 * time (ms after the start). An activation request makes its app the front `grantMs` later (null: macOS refuses it).
 * `holds`: the hold files' contents by name (the time is the fake clock's, ms after the start).
 */
function watchRun(argv: string[], p: {
  apps: FakeApp[]; front: number | null; events?: Ev[]; grantMs?: number | null; throwAt?: number; endAt?: number;
  ppid?: { at: number; pid: number }[] | "none"; pipeGoneAt?: number;
  input?: { ns?: boolean; cg?: boolean }; holds?: Record<string, { until: number }>;
}) {
  const T0 = 1_800_000_000_000;
  p = { ...p, apps: p.apps.map((a) => ({ ...a })) };
  let clock = T0, front = p.front, buttons = 0, flags = 0, lastPress = -1e12;
  const stdout: string[] = [], stderr: string[] = [], asks: { pid: number; at: number; options: unknown }[] = [], imports: string[] = [], reads: string[] = [];
  const pending = [...(p.events ?? [])].map((e) => ({ ...e, at: T0 + e.at })).sort((a, b) => a.at - b.at);
  const NIL = { isNil: () => true };
  const nsString = (s: string) => ({ isNil: () => false, js: s, dataUsingEncoding: (enc: number) => { assert.equal(enc, 4); return { text: s }; } });
  const nsUrl = (path: string) => ({ isNil: () => false, URLByStandardizingPath: { isNil: () => false, path: nsString(normalize(path)) } });
  const find = (pid: number) => p.apps.find((a) => a.pid === pid);
  const deliver = () => {
    while (pending.length && pending[0].at <= clock) {
      const e = pending.shift()!;
      if (e.terminate !== undefined) find(e.terminate)!.terminated = true;
      if (e.lose !== undefined) find(e.lose)!.lost = true;
      if (e.front !== undefined) front = e.front;
      if (e.mouse !== undefined) { buttons = e.mouse ? 1 : 0; if (e.mouse) lastPress = clock; }
      if (e.command !== undefined) flags = e.command ? 1 << 20 : 0;
      if (e.shift !== undefined) flags = e.shift ? 1 << 17 : 0;
      if (e.tap) lastPress = clock;
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
    NSString: {
      stringWithContentsOfFileEncodingError: (path: string, enc: number, e: unknown) => {
        assert.equal(enc, 4); assert.equal(e, null);
        reads.push(path);
        const name = path.slice(path.lastIndexOf("/") + 1), h = p.holds?.[name];
        return h ? nsString(JSON.stringify({ until: T0 + h.until, pid: 9 })) : NIL;
      },
    },
    NSRunningApplication: { runningApplicationWithProcessIdentifier: (pid: number) => { const a = find(pid); return a && !a.terminated && !a.lost ? bridged(a) : NIL; } },
    NSWorkspace: {
      sharedWorkspace: {
        get frontmostApplication() {
          if (p.throwAt !== undefined && clock - T0 >= p.throwAt) throw new Error("bridge: no such property");
          return front === null ? NIL : bridged(find(front)!);
        },
      },
    },
    NSRunLoop: { currentRunLoop: { runUntilDate: (d: { seconds: number }) => {
      clock += Math.round(d.seconds * 1000); deliver();
      if (p.endAt !== undefined && clock - T0 >= p.endAt) throw new Error("test: the end of the run");
    } } },
    NSThread: { sleepForTimeInterval: (seconds: number) => { clock += Math.round(seconds * 1000); } },
    NSDate: { dateWithTimeIntervalSinceNow: (seconds: number) => ({ seconds }) },
  });
  if (p.input?.ns !== false) Object.defineProperty($, "NSEvent", { value: { get pressedMouseButtons() { return buttons; }, get modifierFlags() { return flags; } } });
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
      if (name === "CoreGraphics") {
        if (p.input?.cg === false) throw new Error("ObjC.import: no such framework");
        Object.assign($, { CGEventSourceSecondsSinceLastEventType: (state: number, type: number) => {
          assert.equal(state, 1, "the HID system's state");
          assert.ok([1, 3, 25].includes(type), `a mouse press type: ${type}`);
          return type === 1 ? (clock - lastPress) / 1000 : 1e6;
        } });
      }
    },
    unwrap: (o: { js?: unknown }) => o?.js,
  };
  const ctx = vm.createContext({ $, ObjC: objc, Date: FakeDate });
  vm.runInContext(WATCH_BACK_SCRIPT, ctx);
  (ctx as { run: (a: string[]) => unknown }).run(argv);
  const log = parseWatchLines(stderr.join(""));
  return { stdout, lines: log.map((l) => l.text), log, asks, imports, reads, elapsed: clock - T0, ready: stdout.length ? parseWatchReady(stdout[0].trim()) : undefined };
}

const TERMINAL: FakeApp = { pid: 500, bundleId: "com.apple.Terminal", path: "/System/Applications/Utilities/Terminal.app" };
const FINDER: FakeApp = { pid: 600, bundleId: "com.apple.finder", path: "/System/Library/CoreServices/Finder.app" };
const AGENT: FakeApp = { pid: 701, bundleId: "com.google.Chrome.beta", path: BETA };
const STATE = "/srv/x/state";
const args = [BETA, "701", "4242", STATE];
/** The run ends here (the script has no time limit: it runs for as long as the agent Chrome does). */
const END = 20_000;

test("the watcher names the app it gives the front back to, then gives the front back at each take of the agent Chrome, for as long as the agent Chrome runs", () => {
  const takes = [600, 2000, 4000, 6000, 8000].map((at) => ({ at, front: 701 }));
  const r = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, events: takes, grantMs: 40, endAt: END });
  assert.deepEqual(r.ready, { watch: true, before: 500, bundle: "com.apple.Terminal", agent: 701, input: "nsevent+cg" });
  assert.equal(r.lines[0], "watch agent=701 before=500 parent=4242 ppid=yes input=nsevent+cg");
  assert.equal(r.asks.length, 5, "five takes, five requests");
  assert.ok(r.asks.every((a) => a.pid === 500 && a.options === 0));
  for (const [i, at] of [600, 2000, 4000, 6000, 8000].entries()) assert.ok(r.asks[i].at >= at && r.asks[i].at <= at + 30, `ask ${i} at ${r.asks[i].at} ms, within one poll of the take at ${at}`);
  assert.equal(r.lines.filter((l) => l === "took=701 from=500").length, 5, "no own= on a take with no person's input");
  for (const l of r.lines.filter((x) => x.startsWith("back="))) assert.match(l, /^back=500 after-ms=(4\d|5\d|6\d|7\d) asks=1$/);
  assert.match(r.lines.at(-1)!, /^end=error ".*the end of the run"$/, "it ran until the test ended it: no time limit");
  assert.deepEqual(r.imports, ["AppKit", "CoreGraphics", "unistd"]);
  assert.deepEqual(r.reads.slice(0, 2), [`${STATE}/give-back-hold-front.json`, `${STATE}/give-back-hold-approval.json`], "the holds are read at each new take");
  assert.equal(r.reads.length, 10, "and only then (two files for each of the five takes)");
});

test("the operator's own switch is never fought: a click (an agent window, its Dock icon), Cmd-Tab, a tap that only the HID time shows; the next app in front is the app to give the front back to", () => {
  const ev = (input: Ev[], gap = 0): Ev[] => [...input, { at: 1000 + gap, front: 701 }, { at: 3000, front: 600 }, { at: 5000, front: 701 }];
  // A click on an agent window or on its Dock icon: the button is down when, or shortly before, the agent Chrome comes to the front.
  const click = watchRun(args, { apps: [TERMINAL, FINDER, AGENT], front: 500, events: ev([{ at: 900, mouse: true }, { at: 990, mouse: false }]), grantMs: 40, endAt: 7000 });
  assert.ok(click.lines.includes("took=701 from=500 own=click"), click.lines.join("\n"));
  assert.deepEqual(click.asks.map((a) => a.pid), [600], "only the later take (with no input) is given back, to the app the operator went to");
  assert.ok(click.lines.includes("before=600 after-ms=2000"));
  // Cmd-Tab: the Command key is down until just before the switch.
  const cmd = watchRun(args, { apps: [TERMINAL, FINDER, AGENT], front: 500, events: ev([{ at: 700, command: true }, { at: 950, command: false }]), grantMs: 40, endAt: 7000 });
  assert.ok(cmd.lines.includes("took=701 from=500 own=command"), cmd.lines.join("\n"));
  assert.deepEqual(cmd.asks.map((a) => a.pid), [600]);
  // A quick tap between two polls: the HID time of the last mouse press shows it.
  const tap = watchRun(args, { apps: [TERMINAL, FINDER, AGENT], front: 500, events: ev([{ at: 1005, tap: true }], 30), grantMs: 40, endAt: 7000 });
  assert.ok(tap.lines.includes("took=701 from=500 own=click"), tap.lines.join("\n"));
  // Without CoreGraphics the sampled button alone: the tap is missed (a take of the front with no input is given back).
  const noCg = watchRun(args, { apps: [TERMINAL, FINDER, AGENT], front: 500, events: ev([{ at: 1005, tap: true }], 30), grantMs: 40, endAt: 7000, input: { cg: false } });
  assert.equal(noCg.ready?.input, "nsevent");
  assert.ok(noCg.lines.includes("took=701 from=500"));
  // A press more than 1 s before the take is not the switch.
  const old = watchRun(args, { apps: [TERMINAL, FINDER, AGENT], front: 500, events: ev([{ at: 100, mouse: true }, { at: 150, mouse: false }, { at: 300, command: true }, { at: 350, command: false }], 500), grantMs: 40, endAt: 7000 });
  assert.ok(old.lines.includes("took=701 from=500"), old.lines.join("\n"));
  assert.deepEqual(old.asks.map((a) => a.pid), [500, 600]);
});

test("the 1 s of OWN_MS at its edge: a press that ended 1.0 to 1.3 s before the take is not the switch; one less than 1 s before is (review-69c N3)", () => {
  // The button sampled as down until `up` (ms after the start), the take at 3000: own only when the last down sample is within 1000 ms.
  for (const [up, own] of [[1700, false], [1950, false], [1990, false], [2050, true], [2400, true]] as const) {
    const r = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, input: { cg: false }, events: [{ at: up - 60, mouse: true }, { at: up, mouse: false }, { at: 3000, front: 701 }], grantMs: 40, endAt: 4000 });
    assert.equal(r.lines.includes("took=701 from=500 own=click"), own, `a press up at ${up} ms, the take at 3000 ms: ${r.lines.join(" | ")}`);
  }
  // The same with CoreGraphics' time of the last press (a tap).
  for (const [at, own] of [[1700, false], [1960, false], [2010, true]] as const) {
    const r = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, input: { ns: false }, events: [{ at, tap: true }, { at: 3000, front: 701 }], grantMs: 40, endAt: 4000 });
    assert.equal(r.lines.includes("took=701 from=500 own=click"), own, `a tap at ${at} ms: ${r.lines.join(" | ")}`);
  }
});

test("OWN_MS at exactly its edge: a button last seen down exactly 1000 ms before the take still makes it the operator's (review-check)", () => {
  // The fake clock moves 25 ms a poll: the button is down at the poll of 1975 ms and up at 2000; the take is seen at 2975.
  const at = (take: number) => watchRun(args, { apps: [TERMINAL, AGENT], front: 500, input: { cg: false }, events: [{ at: 1960, mouse: true }, { at: 1990, mouse: false }, { at: take, front: 701 }], grantMs: 40, endAt: 4000 });
  assert.ok(at(2975).lines.includes("took=701 from=500 own=click"), "1000 ms: the operator's");
  assert.ok(at(3000).lines.includes("took=701 from=500"), "1025 ms: given back");
});

test("keys alone do not make a take the operator's: a person who types in their own app gets the front back at once (ab-or9)", () => {
  // Typing gives no mouse button and no Command key; Shift (a capital letter) and the other modifiers are not the Command key.
  const r = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, events: [{ at: 850, shift: true }, { at: 900, front: 701 }, { at: 950, shift: false }], grantMs: 40, endAt: 3000 });
  assert.deepEqual(r.asks.map((a) => a.pid), [500]);
  assert.ok(r.asks[0].at - 900 <= 30);
});

test("a click or the Command key during a take that the watcher gives back makes it the operator's: no more asks", () => {
  const r = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, events: [{ at: 1000, front: 701 }, { at: 1100, mouse: true }, { at: 1180, mouse: false }], grantMs: null, endAt: 4000 });
  assert.deepEqual(r.asks.map((a) => a.at), [1000], "one ask, before the click");
  assert.ok(r.lines.some((l) => /^own=click after-ms=1\d\d$/.test(l)), r.lines.join("\n"));
  assert.ok(!r.lines.some((l) => l.startsWith("refused=")));
  const k = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, events: [{ at: 1000, front: 701 }, { at: 1150, command: true }, { at: 1300, command: false }], grantMs: null, endAt: 4000 });
  assert.deepEqual(k.asks.length, 1);
  assert.ok(k.lines.some((l) => /^own=command after-ms=1\d\d$/.test(l)));
});

test("a hold of `front` or of an approval: a take then is the operator's; after the hold a take is given back again", () => {
  const front = watchRun(args, { apps: [TERMINAL, FINDER, AGENT], front: 500, holds: { "give-back-hold-front.json": { until: 2000 } },
    events: [{ at: 1000, front: 701 }, { at: 2500, front: 600 }, { at: 3000, front: 701 }], grantMs: 40, endAt: 5000 });
  assert.ok(front.lines.includes("took=701 from=500 own=front"), front.lines.join("\n"));
  assert.deepEqual(front.asks.map((a) => [a.pid, a.at >= 3000]), [[600, true]], "the later take, after the hold, is given back");
  const approval = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, holds: { "give-back-hold-approval.json": { until: 9000 } }, events: [{ at: 1000, front: 701 }], grantMs: 40, endAt: 3000 });
  assert.ok(approval.lines.includes("took=701 from=500 own=approval"));
  assert.deepEqual(approval.asks, []);
  const past = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, holds: { "give-back-hold-front.json": { until: 500 } }, events: [{ at: 1000, front: 701 }], grantMs: 40, endAt: 3000 });
  assert.equal(past.asks.length, 1, "a hold that ended");
});

test("the agent Chrome in front at the start (a start with no give-back, launch --login): no app to give the front back to until another app comes to the front", () => {
  const r = watchRun(args, { apps: [TERMINAL, AGENT], front: 701, events: [{ at: 2000, front: 500 }, { at: 4000, front: 701 }], grantMs: 40, endAt: 6000 });
  assert.deepEqual(r.ready, { watch: true, before: 0, bundle: null, agent: 701, input: "nsevent+cg" });
  assert.deepEqual(r.lines.slice(0, 4), ["watch agent=701 before=0 parent=4242 ppid=yes input=nsevent+cg", "took=701 from=0 own=start", "before=500 after-ms=1975", "took=701 from=500"]);
  assert.deepEqual(r.asks.map((a) => a.pid), [500]);
  assert.equal(r.reads.length, 2, "no hold is read for the start's take");
});

test("macOS refuses: 3 asks 250 ms apart for that take, then none until the front leaves the agent Chrome; another app in front ends a take", () => {
  const r = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, events: [{ at: 600, front: 701 }, { at: 3000, front: 500 }, { at: 5000, front: 701 }, { at: 5100, front: 500 }], grantMs: null, endAt: 7000 });
  assert.deepEqual(r.asks.map((a) => a.at - r.asks[0].at).slice(0, 3), [0, 250, 500]);
  assert.equal(r.asks.length, 4, "3 for the refused take, then 1 for the next one");
  assert.ok(r.lines.includes("refused=500 asks=3"));
  const mid = watchRun(args, { apps: [TERMINAL, FINDER, AGENT], front: 500, events: [{ at: 600, front: 701 }, { at: 640, front: 600 }], grantMs: null, endAt: 2000 });
  assert.ok(mid.lines.some((l) => /^before=600 after-ms=\d+$/.test(l)));
  assert.deepEqual(mid.asks.map((a) => a.pid), [500]);
});

test("the watcher ends when the agent Chrome quits: its AppKit object says so, or a look-up again finds it gone (the second Google Chrome instance of 2026-11-06)", () => {
  const gone = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, events: [{ at: 1000, terminate: 701 }], endAt: 20_000 });
  assert.equal(gone.lines.at(-1), "end=agent-gone");
  assert.ok(gone.elapsed >= 1000 && gone.elapsed < 1100);
  const lost = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, events: [{ at: 1000, lose: 701 }], endAt: 20_000 });
  assert.equal(lost.lines.at(-1), "end=agent-gone", "isTerminated never said so");
  assert.ok(lost.elapsed >= 1000 && lost.elapsed <= 2100, `within a second of the quit: ${lost.elapsed} ms`);
});

test("the watcher refuses a pid of another bundle, and with no input source it does not watch (it cannot tell the operator's own switch)", () => {
  const other = watchRun([BETA, "600", "4242", STATE], { apps: [TERMINAL, FINDER, AGENT], front: 500 });
  assert.deepEqual([other.ready?.watch, other.lines], [false, ["end=no-agent"]]);
  assert.deepEqual(watchRun([STABLE, "701", "4242", STATE], { apps: [TERMINAL, AGENT], front: 500 }).lines, ["end=no-agent"]);
  assert.deepEqual(watchRun(args, { apps: [TERMINAL], front: 500 }).lines, ["end=no-agent"], "no such pid");
  const none = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, input: { ns: false, cg: false } });
  assert.deepEqual([none.ready?.watch, none.ready?.input, none.lines], [false, "none", ["end=no-input"]]);
  const cgOnly = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, input: { ns: false }, endAt: 1000 });
  assert.equal(cgOnly.ready?.input, "cg");
  const noFront = watchRun(args, { apps: [TERMINAL, AGENT], front: null, events: [{ at: 500, front: 500 }, { at: 900, front: 701 }], grantMs: 40, endAt: 2000 });
  assert.equal(noFront.ready?.before, 0);
  assert.ok(noFront.lines.includes("before=500"), "the first app in front is the one to give the front back to");
  assert.deepEqual(noFront.asks.map((a) => a.pid), [500]);
});

test("the watcher ends when its node process is gone: its parent pid changes (getppid, used only when its first value is that process), or its write to the pipe fails", () => {
  const r = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, ppid: [{ at: 0, pid: 4242 }, { at: 3000, pid: 1 }] });
  assert.equal(r.lines.at(-1), "end=parent-gone", "after a kill -9 of node, launchd (pid 1) is its parent");
  assert.ok(r.elapsed >= 3000 && r.elapsed <= 3300, `within one beat of 250 ms (${r.elapsed} ms)`);
  const beats = r.stdout.slice(1);
  assert.ok(beats.length >= 11 && beats.every((b) => b === "\n"), `an empty line every 250 ms (${beats.length})`);
  const pipe = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, ppid: "none", pipeGoneAt: 2000 });
  assert.equal(pipe.lines[0], "watch agent=701 before=500 parent=4242 ppid=no input=nsevent+cg");
  assert.match(pipe.lines.at(-1)!, /^end=error ".*Broken pipe"$/);
  assert.ok(pipe.elapsed >= 2000 && pipe.elapsed <= 2300, `${pipe.elapsed} ms`);
  // review-66b F: a getppid that does not give the node process at the start is not used; the pipe still tells.
  const odd = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, ppid: [{ at: 0, pid: 4243 }], pipeGoneAt: 1500 });
  assert.equal(odd.lines[0], "watch agent=701 before=500 parent=4242 ppid=no input=nsevent+cg");
  assert.match(odd.lines.at(-1)!, /^end=error ".*Broken pipe"$/, "not end=parent-gone at its first beat");
});

test("a bad argv ends the watcher before it reads anything; a bridge error is logged, never thrown", () => {
  for (const a of [[BETA, "701", "4242"], ["Chrome.app", "701", "4242", STATE], [BETA, "0", "4242", STATE], [BETA, "701", "0", STATE], [BETA, "701", "4242", "state"]]) {
    const r = watchRun(a, { apps: [TERMINAL, AGENT], front: 500 });
    assert.deepEqual([r.stdout, r.lines], [[], ["end=usage"]], a.join(" "));
  }
  const r = watchRun(args, { apps: [TERMINAL, AGENT], front: 500, throwAt: 300 });
  assert.match(r.lines.at(-1)!, /^end=error "Error: bridge: no such property"$/);
});

test("the ready line and the log lines, as the service reads them", () => {
  assert.deepEqual(parseWatchReady('{"watch":true,"before":500,"bundle":"com.apple.Terminal","agent":701,"input":"nsevent"}'), { watch: true, before: 500, bundle: "com.apple.Terminal", agent: 701, input: "nsevent" });
  for (const bad of ["", "x", "{}", '{"watch":true,"before":-1,"agent":1}', '{"before":1,"agent":1}', '{"watch":1,"before":1,"agent":1}']) assert.equal(parseWatchReady(bad), undefined, bad);
  const log = parseWatchLines(["2026-11-06T10:00:00.000Z watch-back watch agent=701 before=500", "2026-11-06T10:00:00.500Z give-back end=stopped by=launch", "2026-11-06T10:00:01.250Z watch-back took=701 from=500 own=click", ""].join("\n"));
  assert.deepEqual(log.map((l) => l.text), ["watch agent=701 before=500", "took=701 from=500 own=click"]);
  assert.deepEqual(log[1].kv, { took: "701", from: "500", own: "click" });
});
