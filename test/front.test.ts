// `front` (#3): the operator brings the agent Chrome that asks "Allow remote debugging?" to the front.
// Crafted `ps` rows, made-up state folders in the temp folder (with the SingletonLock link that Chrome
// writes), and a stand-in runner in place of osascript, lsappinfo and sw_vers: nothing here starts,
// activates or connects to a Chrome or an app. The JXA script runs in a stand-in of the ObjC bridge
// (node:vm), so its own checks are tested off macOS too.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { lutimesSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { AGENT_ARGS, CHROME_BETA_BIN, CHROME_STABLE_BIN } from "../src/agent.ts";
import { human } from "../src/cli.ts";
import { commands } from "../src/commands.ts";
import { promptNotice } from "../src/diagnostics.ts";
import {
  bringToFront, FRONT_JXA, FRONT_LIMIT_MS, isAsn, LSAPPINFO, lsappinfoPid, OSASCRIPT, osascriptFront, psStartTime, singletonLock, SW_VERS,
  type FrontDeps, type FrontRun,
} from "../src/front.ts";
import { resolveOptions, type Settings } from "../src/options.ts";
import * as trials from "./live/function-keys/trials.ts";
import { cli } from "./helpers.ts";

const UID = process.getuid!();
const SIG = AGENT_ARGS.join(" ");
const INSPECT = "chrome://inspect/#remote-debugging";
const mac = (uid: number, pid: number, command: string) => `${String(uid).padStart(5)} ${String(pid).padStart(5)} ${command}`;
/** The agent Chrome's start time, as ps gives it (seconds since 1970). */
const START = 1_793_815_632;

let tmp = "";
before(() => { tmp = mkdtempSync(join(tmpdir(), "ab-front-")); });
after(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * A consumer's settings on a made-up state folder (with its profile folder), and, when `lock` (a pid)
 * is given, the SingletonLock that Chrome makes, made at `made` (by default 1 s after the start).
 */
function settings(name: string, extra: Partial<Settings> = {}, lock?: number, made = START + 1): Settings {
  const stateDir = join(tmp, name);
  const s = resolveOptions({ stateDir, log: () => {}, ...extra });
  mkdirSync(s.profileDir, { recursive: true });
  if (lock !== undefined) {
    symlinkSync(`MBP-2023-M2.local-${lock}`, join(s.profileDir, "SingletonLock"));
    lutimesSync(join(s.profileDir, "SingletonLock"), made, made);
  }
  return s;
}

/** The agent Chrome of `s` as ps shows it, on `bin`, as launchAgentChrome starts it. */
const agentRow = (s: Settings, pid: number, bin = CHROME_STABLE_BIN) =>
  mac(UID, pid, `${bin} ${SIG} --user-data-dir=${s.profileDir} --window-name=${s.commandName}: ${s.stateDir} ${INSPECT}`);

type Call = string[];
/**
 * A stand-in for osascript, lsappinfo and sw_vers. `replies` gives osascript's JSON for each `how`
 * ("activate", "activate-from"); `fronts` gives the front app's pid for each lsappinfo read, in order
 * (the last one repeats).
 */
function stand(replies: Record<string, object | string>, fronts: number[]): { run: FrontRun; calls: Call[] } {
  const calls: Call[] = [];
  let read = 0;
  const run: FrontRun = async (argv) => {
    calls.push(argv);
    if (argv[0] === OSASCRIPT) {
      const reply = replies[argv[5]];
      if (reply === undefined) return { ok: false, stdout: "", stderr: "no reply" };
      return { ok: true, stdout: (typeof reply === "string" ? reply : JSON.stringify(reply)) + "\n", stderr: "" };
    }
    if (argv[0] === LSAPPINFO && argv[1] === "front") return { ok: true, stdout: "ASN:0x0-0x2a02a:\n", stderr: "" };
    if (argv[0] === LSAPPINFO && argv[1] === "info") {
      const pid = fronts[Math.min(read++, fronts.length - 1)];
      return { ok: true, stdout: `"pid"=${pid}\n`, stderr: "" };
    }
    if (argv[0] === SW_VERS) return { ok: true, stdout: "15.1\n", stderr: "" };
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };
  return { run, calls };
}

const osascriptCalls = (calls: Call[]) => calls.filter((c) => c[0] === OSASCRIPT);
const noSleep = async () => {};
/** The deps of a Mac (Darwin 24 is macOS 15) with these ps rows and this runner. */
const onMac = (ps: string, run: FrontRun, extra: Partial<FrontDeps> = {}): FrontDeps =>
  ({ platform: "darwin", ps: () => ps, uid: UID, started: () => START, release: () => "24.1.0", run, sleep: noSleep, ...extra });
const ok = (extra: object = {}) => ({ found: true, path: CHROME_STABLE_BIN, launched: START + 0.4, before: 600, sent: true, ...extra });
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("osascriptFront: osascript's JavaScript with the script, then the call, the pid, the binary and the start time; the script names only NSRunningApplication and NSWorkspace", () => {
  assert.deepEqual(osascriptFront("activate", 4100, CHROME_STABLE_BIN, START),
    [OSASCRIPT, "-l", "JavaScript", "-e", FRONT_JXA, "activate", "4100", CHROME_STABLE_BIN, String(START)]);
  assert.deepEqual([OSASCRIPT, LSAPPINFO, SW_VERS], ["/usr/bin/osascript", "/usr/bin/lsappinfo", "/usr/bin/sw_vers"]);
  assert.match(FRONT_JXA, /^ObjC\.import\("AppKit"\);/);
  assert.deepEqual([...new Set(FRONT_JXA.match(/\$\.\w+/g))].sort(), ["$.NSRunningApplication", "$.NSWorkspace"]);
  // No Apple Event (no app by name, no System Events, no scripting additions, no AppleScript or Scripting Bridge), no Accessibility, no input events.
  for (const word of ["Application(", "System Events", "includeStandardAdditions", "doShellScript", "delay(", "NSAppleScript", "NSAppleEventDescriptor",
    "SBApplication", "AXUIElement", "CGEvent", "ObjC.bindFunction"]) assert.ok(!FRONT_JXA.includes(word), word);
  assert.ok(FRONT_LIMIT_MS < 120_000, "under the Python adapter's default timeout");
});

test("psStartTime reads `LC_ALL=C ps -o lstart=` in local time; isAsn and lsappinfoPid are the function-key check's own", () => {
  assert.equal(psStartTime("Wed Nov  4 18:07:12 2026\n"), new Date(2026, 10, 4, 18, 7, 12).getTime() / 1000);
  assert.equal(psStartTime("Mon Jan 15 09:05:03 2027"), new Date(2027, 0, 15, 9, 5, 3).getTime() / 1000);
  for (const bad of ["", "Wed Nov  4 18:07 2026", "mer nov  4 18:07:12 2026", "Wed Nov  4 18:07:12 2026\nThu Nov  5 01:00:00 2026", "Wed Foo  4 18:07:12 2026"])
    assert.equal(psStartTime(bad), undefined, JSON.stringify(bad));
  assert.equal(trials.isAsn, isAsn);
  assert.equal(trials.lsappinfoPid, lsappinfoPid);
});

test("singletonLock: the pid in the profile's SingletonLock link and when it was made, only when this user owns the link", () => {
  const s = settings("lock", {}, 4100);
  assert.deepEqual(singletonLock(s.profileDir, UID), { pid: 4100, made: START + 1 });
  assert.equal(singletonLock(s.profileDir, UID + 1), undefined, "another user's link");
  assert.equal(singletonLock(join(tmp, "no-such-profile"), UID), undefined);
  const file = settings("lock-file");
  rmSync(file.profileDir, { recursive: true });
  mkdirSync(join(file.profileDir, "SingletonLock"), { recursive: true });
  assert.equal(singletonLock(file.profileDir, UID), undefined, "not a link");
});

test("macOS: front unhides and activates the agent Chrome that holds this consumer's profile, by its pid, never the operator's own Chrome of the same app or another consumer's agent Chrome", async () => {
  const s = settings("mine", {}, 4100), other = settings("other", {}, 4050);
  const ps = [
    mac(0, 1, "/sbin/launchd"),
    mac(UID, 600, "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"),
    // The operator's own Chrome: the same app, no agent launch flags, its own profile.
    mac(UID, 4000, CHROME_STABLE_BIN),
    agentRow(other, 4050, CHROME_BETA_BIN),
    agentRow(s, 4100),
    mac(UID, 4101, `/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/156.0.7300.2/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --user-data-dir=${s.profileDir}`),
  ].join("\n");
  const started: number[] = [];
  const { run, calls } = stand({ activate: ok() }, [600, 600, 4100]);
  const r = await bringToFront(s, onMac(ps, run, { started: (pid) => { started.push(pid); return START; } }));
  assert.equal(r.via, "activate");
  assert.deepEqual(r.chrome, { pid: 4100, profileDir: s.profileDir, stateDir: s.stateDir, windowName: `agent-browser: ${s.stateDir}`, commandName: "agent-browser", proxy: null });
  assert.deepEqual(started, [4100]);
  assert.deepEqual(osascriptCalls(calls), [osascriptFront("activate", 4100, CHROME_STABLE_BIN, START)], "one request, for the agent Chrome's pid only");
  for (const c of calls) assert.ok(!c.some((a) => a === "4000" || a === "4050"), `no call names the operator's Chrome or another consumer's: ${c.slice(0, 3).join(" ")}`);
  assert.deepEqual(calls.filter((c) => c[0] !== OSASCRIPT).map((c) => c.slice(0, 4)),
    [[LSAPPINFO, "front"], [LSAPPINFO, "info", "-only", "pid"], [LSAPPINFO, "front"], [LSAPPINFO, "info", "-only", "pid"], [LSAPPINFO, "front"], [LSAPPINFO, "info", "-only", "pid"]],
    "it reads the front app until it is the agent Chrome; no sw_vers on success");
});

test("a Chrome on this profile that agent-browser did not start, while an agent-browser proxy of this user drives it, is this consumer's agent Chrome (as `chromes` lists it)", async () => {
  const s = settings("driven", {}, 4600);
  const proxy = `/usr/local/bin/node /opt/agent-browser/bin/agent-browser.js proxy ws://127.0.0.1:52100/devtools/browser/9f8e --state-dir ${s.stateDir} `
    + `--socket ${s.socketPath} --profile ${s.profileDir} --mode agent --proxy-idle-ms 43200000 --command-name agent-browser --attempt 5f0e9a --timeout-ms 89000`;
  const ps = [mac(UID, 4600, `${CHROME_STABLE_BIN} --user-data-dir=${s.profileDir}`), mac(UID, 4700, proxy)].join("\n");
  const { run, calls } = stand({ activate: ok() }, [4600]);
  const r = await bringToFront(s, onMac(ps, run));
  assert.deepEqual([r.chrome.pid, r.chrome.stateDir, r.via], [4600, s.stateDir, "activate"]);
  assert.deepEqual(osascriptCalls(calls), [osascriptFront("activate", 4600, CHROME_STABLE_BIN, START)]);
});

test("the refusal: no agent Chrome holds this profile: a Chrome that agent-browser did not start and no proxy drives, a process that only names it, another user's, a stale lock, no lock; nothing runs", async () => {
  const cases: [string, number | undefined, (s: Settings) => string[]][] = [
    // A Chrome that the operator started by hand on this profile: no agent launch flags, no proxy.
    ["hand", 4200, (s) => [mac(UID, 4200, `${CHROME_STABLE_BIN} --user-data-dir=${s.profileDir}`)]],
    ["names", 4210, (s) => [mac(UID, 4210, `/usr/bin/tail -f ${s.stateDir}/launches.log --user-data-dir=${s.profileDir}`)]],
    // An agent Chrome of another user on this very profile path.
    ["other-user", 4400, (s) => [mac(UID + 1, 4400, `${CHROME_STABLE_BIN} ${SIG} --user-data-dir=${s.profileDir} ${INSPECT}`)]],
    // The lock names a pid that the operator's own Chrome has now; the agent Chrome of this profile quit.
    ["stale", 4000, () => [mac(UID, 4000, CHROME_STABLE_BIN)]],
    // An agent Chrome on this profile, but no lock (not this profile's holder by Chrome's own record).
    ["no-lock", undefined, (s) => [agentRow(s, 4500)]],
  ];
  for (const [name, lock, rows] of cases) {
    const s = settings(`refuse-${name}`, {}, lock);
    const { run, calls } = stand({}, [600]);
    let started = 0;
    await assert.rejects(bringToFront(s, onMac(rows(s).join("\n"), run, { started: () => { started++; return START; } })), (e: Error) => {
      assert.equal(e.name, "Error", name);
      assert.match(e.message, new RegExp(`^no agent-browser Chrome of this user holds profile ${escape(s.profileDir)}: front brings only an agent Chrome forward`), name);
      return true;
    });
    assert.deepEqual([calls, started], [[], 0], `${name}: no ps start time, no osascript, no lsappinfo`);
  }
});

test("the refusal: another consumer's agent Chrome whose profile ps reads short at a \" -\" (it looks like this profile there) is never chosen, also when a stale lock here names its pid", async () => {
  // This consumer's profile is <tmp>/dash/profile and no Chrome holds it; the other consumer's profile
  // is "<tmp>/dash/profile -b/profile", which ps joins so that it reads "<tmp>/dash/profile" up to " -b".
  const s = settings("dash");
  const other = settings("dash-other", { profileDir: `${s.profileDir} -b/profile` }, 4800);
  const ps = mac(UID, 4800, `${CHROME_STABLE_BIN} ${SIG} --user-data-dir=${other.profileDir} --window-name=agent-browser: ${other.stateDir} ${INSPECT}`);
  const { run, calls } = stand({ activate: ok() }, [4800]);
  await assert.rejects(bringToFront(s, onMac(ps, run)), /^Error: no agent-browser Chrome of this user holds profile/);
  // This profile's own Chrome quit and left its lock; the other consumer's Chrome has that pid now.
  const t = settings("dash2", {}, 4900, START - 3600);
  const tOther = mac(UID, 4900, `${CHROME_STABLE_BIN} ${SIG} --user-data-dir=${t.profileDir} -b/profile --window-name=agent-browser: ${t.profileDir} -b ${INSPECT}`);
  await assert.rejects(bringToFront(t, onMac(tOther, run)),
    new RegExp(`^Error: refusing: the SingletonLock of profile ${escape(t.profileDir)} names pid 4900, but it is older than that process \\(a stale lock\\); nothing was brought forward$`));
  assert.deepEqual(calls, []);
  // A lock made 2 s or less before the start that ps gives (in whole seconds) is the process's own.
  const u = settings("dash3", {}, 4950, START - 2);
  const own = stand({ activate: ok() }, [4950]);
  assert.equal((await bringToFront(u, onMac(agentRow(u, 4950), own.run))).via, "activate");
});

test("the refusal: a pid that another program has now (its executable, or a launch date that is not the agent Chrome's start), a pid that this login session has no app for, a pid that ps no longer lists: nothing is activated", async () => {
  const s = settings("reused", {}, 4100);
  const ps = agentRow(s, 4100);
  const terminal = "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";
  const other = stand({ activate: { found: true, path: terminal, launched: START + 3600, sent: false } }, [600]);
  await assert.rejects(bringToFront(s, onMac(ps, other.run)),
    new RegExp(`^Error: refusing: pid 4100 is now ${escape(terminal)}, not the agent Chrome ${escape(CHROME_STABLE_BIN)}; nothing was brought forward$`));
  assert.equal(osascriptCalls(other.calls).length, 1, "no second request");
  // The same binary (for example the operator's own Google Chrome), started an hour later on this pid.
  const later = stand({ activate: ok({ launched: START + 3600, sent: false }) }, [600]);
  await assert.rejects(bringToFront(s, onMac(ps, later.run)),
    new RegExp(`^Error: refusing: pid 4100 is now an app that started at ${escape(new Date((START + 3600) * 1000).toISOString())}, not the agent Chrome that started at ${escape(new Date(START * 1000).toISOString())}; nothing was brought forward$`));
  // No launch date (an app that did not start through Launch Services): the executable check only.
  const undated = stand({ activate: ok({ launched: null }) }, [4100]);
  assert.equal((await bringToFront(s, onMac(ps, undated.run))).via, "activate");
  const gone = stand({ activate: { found: false } }, [600]);
  await assert.rejects(bringToFront(s, onMac(ps, gone.run)),
    /^Error: this login session has no app with pid 4100: the agent Chrome has quit, or it runs in another login session; nothing was brought forward$/);
  const unlisted = stand({ activate: ok() }, [4100]);
  await assert.rejects(bringToFront(s, onMac(ps, unlisted.run, { started: () => undefined })), /^Error: the agent Chrome \(pid 4100\) has quit; nothing was brought forward$/);
  assert.deepEqual(unlisted.calls, []);
  const failed = stand({}, [600]);
  await assert.rejects(bringToFront(s, onMac(ps, failed.run)), /^Error: osascript failed \(activate, pid 4100\): no reply$/);
  const garbled = stand({ activate: "true" }, [600]);
  await assert.rejects(bringToFront(s, onMac(ps, garbled.run)), /^Error: osascript gave no reply that front can read \(activate, pid 4100\): true$/);
});

test("macOS refuses the first request: on macOS 14 and later front asks once more (activate-from), then fails with the macOS version, the pids, the requests and where the window is", async () => {
  const s = settings("refused", {}, 4100);
  const ps = agentRow(s, 4100);
  // The second request works.
  const second = stand({ activate: ok(), "activate-from": ok() }, [...Array(15).fill(600), 4100]);
  const r = await bringToFront(s, onMac(ps, second.run));
  assert.equal(r.via, "activate-from");
  assert.deepEqual(osascriptCalls(second.calls), [osascriptFront("activate", 4100, CHROME_STABLE_BIN, START), osascriptFront("activate-from", 4100, CHROME_STABLE_BIN, START)]);
  // Neither works.
  let slept = 0;
  const neither = stand({ activate: ok(), "activate-from": ok() }, [600]);
  await assert.rejects(bringToFront(s, onMac(ps, neither.run, { sleep: async () => { slept++; } })), (e: Error) => {
    assert.equal(e.message, `macOS 15.1 did not bring the agent browser to the front (pid 4100, profile ${s.profileDir}): activate sent, activate-from sent; `
      + "the app in front is pid 600, as before. macOS 14 and later can refuse an activation that the app in front did not yield. "
      + `Find the window in the Dock: Control-click the icon of the agent browser's Chrome and choose the window "agent-browser: ${s.stateDir}"`);
    return true;
  });
  assert.equal(slept, 30, "1.5 s of reads after each request");
  // Before macOS 14 (Darwin 22) there is no activate-from; a request that macOS did not send is not waited for; an unknown front app, version and window name are said so.
  const t = settings("refused-old", {}, 4100);
  const old = stand({ activate: ok({ sent: false }) }, [600]);
  slept = 0;
  await assert.rejects(bringToFront(t, onMac(agentRow(t, 4100).replace(/ --window-name=\S+ \S+/, ""), async (argv, ms) =>
    argv[0] === OSASCRIPT ? old.run(argv, ms) : { ok: false, stdout: "", stderr: "failed" }, { release: () => "22.6.0", sleep: async () => { slept++; } })), (e: Error) => {
    assert.match(e.message, /^macOS \(Darwin 22\) did not bring the agent browser to the front \(pid 4100, profile .*\): activate not sent, activate-from not sent \(macOS before 14\); the app in front is unknown\. .*choose its window$/);
    return true;
  });
  assert.deepEqual([slept, osascriptCalls(old.calls).length], [0, 1]);
});

test("front stops at its time limit, under the Python adapter's default timeout, and gives each command at most the time that is left", async () => {
  const s = settings("limit", {}, 4100);
  let clock = 0;
  const timeouts: number[] = [];
  const slow = stand({ activate: ok(), "activate-from": ok() }, [600]);
  const run: FrontRun = async (argv, ms) => { timeouts.push(ms); clock += 4_000; return slow.run(argv, ms); };
  await assert.rejects(bringToFront(s, onMac(agentRow(s, 4100), run, { now: () => clock })),
    /^Error: front stopped at its time limit of 60 s \(pid 4100; activate sent\); the agent browser may not be in front$/);
  assert.ok(clock <= FRONT_LIMIT_MS + 4_000, String(clock));
  assert.equal(timeouts[0], 15_000, "osascript's own timeout");
  assert.ok(timeouts.every((ms) => ms > 0 && ms <= 15_000));
  assert.equal(timeouts.at(-1), Math.min(5_000, FRONT_LIMIT_MS - (clock - 4_000)), "the last one gets what is left");
});

test("front is for the agent browser on macOS: personal mode, Linux and other systems are refused before anything runs", async () => {
  let ran = 0;
  const ps = () => { ran++; return ""; };
  const run: FrontRun = async () => { ran++; return { ok: true, stdout: "", stderr: "" }; };
  await assert.rejects(bringToFront(settings("personal", { mode: "personal" }), { platform: "darwin", ps, run }),
    /^UsageError: front is for the agent browser; it never brings the operator's own Chrome forward$/);
  for (const platform of ["linux", "freebsd", "win32"] as const)
    await assert.rejects(bringToFront(settings(`off-${platform}`), { platform, ps, run }), (e: Error) => {
      assert.equal(e.name, "UsageError");
      assert.match(e.message, new RegExp(`^front brings a window forward on macOS only, not on ${platform}`));
      return true;
    });
  assert.equal(ran, 0);
});

type JxaApp = { path: string | null; launched?: number | null; activate?: boolean; unhide?: "property" | "function" };
/**
 * Run FRONT_JXA's run handler in a stand-in of JXA's ObjC bridge: apps by pid and the front app. A
 * method with no arguments runs on property access (Apple's JXA notes), or, with unhide "function",
 * the bridge gives a function.
 */
function jxa(argv: string[], world: { apps: Record<number, JxaApp>; front: number | null }) {
  const calls: unknown[][] = [];
  const nil = { isNil: () => true };
  const app = (pid: number) => {
    const a = world.apps[pid];
    if (!a) return nil;
    const o: Record<string, unknown> = {
      isNil: () => false,
      processIdentifier: pid,
      executableURL: a.path === null ? nil : { isNil: () => false, path: { js: a.path } },
      launchDate: a.launched === null ? nil : { isNil: () => false, timeIntervalSince1970: a.launched ?? START + 0.4 },
      activateWithOptions: (options: number) => { calls.push(["activateWithOptions", pid, options]); return a.activate ?? true; },
      activateFromApplicationOptions: (from: { processIdentifier: number }, options: number) => {
        calls.push(["activateFromApplicationOptions", pid, from.processIdentifier, options]); return a.activate ?? true;
      },
    };
    if (a.unhide === "function") o.unhide = () => { calls.push(["unhide", pid]); return true; };
    else Object.defineProperty(o, "unhide", { get: () => { calls.push(["unhide", pid]); return true; } });
    return o;
  };
  const $ = {
    NSRunningApplication: { runningApplicationWithProcessIdentifier: (pid: number) => app(pid) },
    NSWorkspace: { sharedWorkspace: { frontmostApplication: world.front === null ? nil : { isNil: () => false, processIdentifier: world.front } } },
  };
  const imported: string[] = [];
  const context = createContext({ $, ObjC: { import: (name: string) => { imported.push(name); } }, argv });
  const out = runInContext(`${FRONT_JXA}\nrun(argv);`, context);
  return { reply: JSON.parse(out), calls, imported };
}

test("the JXA script: it unhides and activates only the pid whose executable is the agent Chrome's binary and whose launch date is its start, with all its windows", () => {
  const terminal = "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";
  const apps: Record<number, JxaApp> = { 4100: { path: CHROME_STABLE_BIN }, 600: { path: terminal }, 4300: { path: null } };
  const world = { apps, front: 600 };
  const args = (how: string, pid: number) => [how, String(pid), CHROME_STABLE_BIN, String(START)];
  let r = jxa(args("activate", 4100), world);
  assert.deepEqual(r.imported, ["AppKit"]);
  assert.deepEqual(r.reply, { found: true, path: CHROME_STABLE_BIN, launched: START + 0.4, before: 600, sent: true });
  assert.deepEqual(r.calls, [["unhide", 4100], ["activateWithOptions", 4100, 3]], "unhide, then NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps");
  r = jxa(args("activate", 4100), { ...world, apps: { 4100: { path: CHROME_STABLE_BIN, unhide: "function" } } });
  assert.deepEqual(r.calls, [["unhide", 4100], ["activateWithOptions", 4100, 3]], "a bridge that gives unhide as a function: called once");
  r = jxa(args("activate-from", 4100), world);
  assert.deepEqual(r.reply, { found: true, path: CHROME_STABLE_BIN, launched: START + 0.4, before: 600, sent: true });
  assert.deepEqual(r.calls, [["unhide", 4100], ["activateFromApplicationOptions", 4100, 600, 1]], "naming the app in front, with all windows");
  r = jxa(args("activate-from", 4100), { ...world, front: null });
  assert.deepEqual([r.reply.sent, r.reply.before, r.calls], [false, 0, [["unhide", 4100]]], "no app in front to name");
  // Another program on the pid (its executable, no executable, or a launch date more than 5 s from the start), or no app: nothing changes.
  for (const [pid, a] of [[600, apps[600]], [4300, apps[4300]], [4100, { path: CHROME_STABLE_BIN, launched: START + 6 }], [4100, { path: CHROME_STABLE_BIN, launched: START - 5.5 }]] as const) {
    r = jxa(args("activate", pid), { ...world, apps: { [pid]: a } });
    assert.deepEqual([r.reply.sent, r.calls], [false, []], JSON.stringify(a));
  }
  r = jxa(args("activate", 4100), { ...world, apps: { 4100: { path: CHROME_STABLE_BIN, launched: START - 4.9 } } });
  assert.equal(r.reply.sent, true, "within 5 s");
  r = jxa(args("activate", 4100), { ...world, apps: { 4100: { path: CHROME_STABLE_BIN, launched: null } } });
  assert.deepEqual([r.reply.launched, r.reply.sent], [null, true], "no launch date: the executable check only");
  r = jxa(args("activate", 4999), world);
  assert.deepEqual([r.reply, r.calls], [{ found: false }, []]);
  r = jxa(args("activate", 4100), { ...world, apps: { 4100: { path: CHROME_STABLE_BIN, activate: false } } });
  assert.equal(r.reply.sent, false);
});

test("front's result, its human form, and the CLI on this system: refused off macOS with a usage error, and --state-dir is required", async () => {
  const minimized = "  if no window shows, it is minimized: click it in the Dock (or click the agent browser's Chrome icon there)\n";
  assert.equal(human({ ok: true, command: "front", chromePid: 4100, profileDir: "/s/profile", stateDir: "/s", windowName: "agent-browser: /s", via: "activate" }),
    `the agent browser (pid 4100) is in front: window "agent-browser: /s"\n  profile /s/profile\n${minimized}`);
  assert.equal(human({ ok: true, command: "front", chromePid: 4100, profileDir: "/s/profile", stateDir: null, windowName: null, via: "activate-from" }),
    `the agent browser (pid 4100) is in front: window name unknown\n  profile /s/profile\n${minimized}`);
  if (process.platform === "darwin") return; // the CLI would activate a real app there
  const s = settings("cli");
  await assert.rejects(commands.front(s), /front brings a window forward on macOS only/);
  const r = await cli(["front", "--state-dir", s.stateDir, "--json"]);
  assert.equal(r.status, 2, r.stdout);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.command, "front");
  assert.equal(r.json.error.code, "usage");
  assert.match(r.json.error.message, new RegExp(`^front brings a window forward on macOS only, not on ${process.platform}`));
  const h = await cli(["front", "--state-dir", s.stateDir]);
  assert.equal(h.status, 2);
  assert.match(h.stderr, /^agent-browser: front brings a window forward on macOS only/);
  const none = await cli(["front", "--json"]);
  assert.equal(none.status, 2);
  assert.match(none.json.error.message, /--state-dir is required/);
});

test("the prompt notice names front on macOS, for a person: not on Linux, not with an approver, not in personal mode, not with an endpoint override", () => {
  const s = settings("notice", { commandName: "vedlo browser" });
  const hint = "; a person at the Mac can bring that window to the front with `vedlo browser front` (a person runs it; an agent never runs it: it takes the operator's focus)";
  assert.ok(promptNotice(s, "agent Chrome", 90_000, "darwin").endsWith(hint), promptNotice(s, "agent Chrome", 90_000, "darwin"));
  assert.ok(!promptNotice(s, "agent Chrome", 90_000, "linux").includes(" front`"));
  assert.ok(!promptNotice(settings("notice-approve", { approve: "osascript" }), "agent Chrome", 90_000, "darwin").includes(" front`"));
  assert.ok(!promptNotice(settings("notice-personal", { mode: "personal" }), "personal Chrome", 90_000, "darwin").includes(" front`"));
  assert.ok(!promptNotice(settings("notice-endpoint", { endpoint: "ws://127.0.0.1:9/devtools/browser/x" }), "agent Chrome", 90_000, "darwin").includes(" front`"));
});
