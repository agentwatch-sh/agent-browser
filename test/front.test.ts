// `front` (#3): the operator brings the agent Chrome that asks "Allow remote debugging?" to the front.
// Crafted `ps` rows and made-up state folders in the temp folder, and a stand-in runner in place of
// osascript and lsappinfo: nothing here starts, activates or connects to a Chrome or an app. The JXA
// script runs in a stand-in of the ObjC bridge (node:vm), so its own checks are tested off macOS too.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { AGENT_ARGS, CHROME_BETA_BIN, CHROME_STABLE_BIN } from "../src/agent.ts";
import { human } from "../src/cli.ts";
import { commands } from "../src/commands.ts";
import { promptNotice } from "../src/diagnostics.ts";
import { bringToFront, FRONT_JXA, LSAPPINFO, OSASCRIPT, osascriptFront, type FrontRun } from "../src/front.ts";
import { resolveOptions, type Settings } from "../src/options.ts";
import { cli } from "./helpers.ts";

const UID = process.getuid!();
const SIG = AGENT_ARGS.join(" ");
const INSPECT = "chrome://inspect/#remote-debugging";
const mac = (uid: number, pid: number, command: string) => `${String(uid).padStart(5)} ${String(pid).padStart(5)} ${command}`;

let tmp = "";
before(() => { tmp = mkdtempSync(join(tmpdir(), "ab-front-")); });
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A consumer's settings on a made-up state folder (with its profile folder). */
function settings(name: string, extra: Partial<Settings> = {}): Settings {
  const stateDir = join(tmp, name);
  mkdirSync(join(stateDir, "profile"), { recursive: true });
  return resolveOptions({ stateDir, log: () => {}, ...extra });
}

/** The agent Chrome of `s` as ps shows it, on `bin`, as launchAgentChrome starts it. */
const agentRow = (s: Settings, pid: number, bin = CHROME_STABLE_BIN) =>
  mac(UID, pid, `${bin} ${SIG} --user-data-dir=${s.profileDir} --window-name=${s.commandName}: ${s.stateDir} ${INSPECT}`);

type Call = string[];
/**
 * A stand-in for osascript and lsappinfo. `replies` gives osascript's JSON for each `how`
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
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };
  return { run, calls };
}

const osascriptCalls = (calls: Call[]) => calls.filter((c) => c[0] === OSASCRIPT);
const noSleep = async () => {};

test("osascriptFront: osascript's JavaScript with the script, then the call, the pid and the binary as the run handler's arguments", () => {
  assert.deepEqual(osascriptFront("activate", 4100, CHROME_STABLE_BIN), [OSASCRIPT, "-l", "JavaScript", "-e", FRONT_JXA, "activate", "4100", CHROME_STABLE_BIN]);
  assert.equal(OSASCRIPT, "/usr/bin/osascript");
  assert.equal(LSAPPINFO, "/usr/bin/lsappinfo");
  // The script sends no Apple Event: it never addresses an app by name (Application(...), System Events) and never loads the scripting additions.
  for (const word of ["Application(", "System Events", "includeStandardAdditions", "doShellScript", "delay("]) assert.ok(!FRONT_JXA.includes(word), word);
  assert.match(FRONT_JXA, /^ObjC\.import\("AppKit"\);/);
});

test("macOS: front activates the agent Chrome on this consumer's profile by its pid, never the operator's own Chrome of the same app or another consumer's agent Chrome", async () => {
  const s = settings("mine"), other = settings("other");
  const ps = [
    mac(0, 1, "/sbin/launchd"),
    mac(UID, 600, "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"),
    // The operator's own Chrome: the same app, no agent launch flags, its own profile.
    mac(UID, 4000, CHROME_STABLE_BIN),
    agentRow(other, 4050, CHROME_BETA_BIN),
    agentRow(s, 4100),
    mac(UID, 4101, `/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/156.0.7300.2/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --user-data-dir=${s.profileDir}`),
  ].join("\n");
  const { run, calls } = stand({ activate: { found: true, path: CHROME_STABLE_BIN, before: 600, sent: true, macos: 15 } }, [600, 600, 4100]);
  const r = await bringToFront(s, { platform: "darwin", ps: () => ps, uid: UID, run, sleep: noSleep });
  assert.equal(r.via, "activate");
  assert.deepEqual(r.chrome, { pid: 4100, profileDir: s.profileDir, stateDir: s.stateDir, windowName: `agent-browser: ${s.stateDir}`, commandName: "agent-browser", proxy: null });
  assert.deepEqual(osascriptCalls(calls), [osascriptFront("activate", 4100, CHROME_STABLE_BIN)], "one request, for the agent Chrome's pid only");
  for (const c of calls) assert.ok(!c.some((a) => a === "4000" || a === "4050"), `no call names the operator's Chrome or another consumer's: ${c.slice(0, 3).join(" ")}`);
  assert.deepEqual(calls.filter((c) => c[0] === LSAPPINFO).map((c) => c.slice(1, 4)), [["front"], ["info", "-only", "pid"], ["front"], ["info", "-only", "pid"], ["front"], ["info", "-only", "pid"]],
    "it reads the front app until it is the agent Chrome");
});

test("the refusal: no agent Chrome on this profile (a Chrome on it that agent-browser did not start, a process that only names it, another consumer's agent Chrome): nothing runs", async () => {
  const s = settings("hand"), other = settings("hand-other");
  const ps = [
    // A Chrome that the operator started by hand on this profile: no agent launch flags, no proxy.
    mac(UID, 4200, `${CHROME_STABLE_BIN} --user-data-dir=${s.profileDir}`),
    mac(UID, 4210, `/usr/bin/tail -f ${s.stateDir}/launches.log --user-data-dir=${s.profileDir}`),
    agentRow(other, 4300),
    // An agent Chrome of another user on this very profile path.
    mac(UID + 1, 4400, `${CHROME_STABLE_BIN} ${SIG} --user-data-dir=${s.profileDir} ${INSPECT}`),
  ].join("\n");
  const { run, calls } = stand({}, [600]);
  await assert.rejects(bringToFront(s, { platform: "darwin", ps: () => ps, uid: UID, run, sleep: noSleep }), (e: Error) => {
    assert.equal(e.name, "Error");
    assert.match(e.message, new RegExp(`^no agent-browser Chrome of this user runs on profile ${s.profileDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: front brings only an agent Chrome forward`));
    return true;
  });
  assert.deepEqual(calls, [], "no osascript, no lsappinfo");
});

test("the refusal: the pid's executable is another app now (the pid was reused after ps read it), or the agent Chrome quit: nothing is activated", async () => {
  const s = settings("reused");
  const ps = agentRow(s, 4100);
  const reused = stand({ activate: { found: true, path: "/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", sent: false, macos: 15 } }, [600]);
  await assert.rejects(bringToFront(s, { platform: "darwin", ps: () => ps, uid: UID, run: reused.run, sleep: noSleep }),
    /^Error: refusing: pid 4100 is now \/Applications\/Utilities\/Terminal\.app\/Contents\/MacOS\/Terminal, not the agent Chrome \/Applications\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome; nothing was brought forward$/);
  assert.equal(osascriptCalls(reused.calls).length, 1, "no second request");
  const quit = stand({ activate: { found: false, macos: 15 } }, [600]);
  await assert.rejects(bringToFront(s, { platform: "darwin", ps: () => ps, uid: UID, run: quit.run, sleep: noSleep }), /the agent Chrome \(pid 4100\) has quit/);
  const failed = stand({}, [600]);
  await assert.rejects(bringToFront(s, { platform: "darwin", ps: () => ps, uid: UID, run: failed.run, sleep: noSleep }), /^Error: osascript failed \(activate, pid 4100\): no reply$/);
  const garbled = stand({ activate: "true" }, [600]);
  await assert.rejects(bringToFront(s, { platform: "darwin", ps: () => ps, uid: UID, run: garbled.run, sleep: noSleep }), /^Error: osascript gave no reply that front can read \(activate, pid 4100\): true$/);
});

test("macOS refuses the first request (cooperative activation): front asks once more with the app in front as the one that hands over, then fails with the pids, the requests and where the window is", async () => {
  const s = settings("refused");
  const ps = agentRow(s, 4100);
  const reply = (sent: boolean) => ({ found: true, path: CHROME_STABLE_BIN, before: 600, sent, macos: 15 });
  // The second request works.
  const second = stand({ activate: reply(true), "activate-from": reply(true) }, [600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 4100]);
  const r = await bringToFront(s, { platform: "darwin", ps: () => ps, uid: UID, run: second.run, sleep: noSleep });
  assert.equal(r.via, "activate-from");
  assert.deepEqual(osascriptCalls(second.calls), [osascriptFront("activate", 4100, CHROME_STABLE_BIN), osascriptFront("activate-from", 4100, CHROME_STABLE_BIN)]);
  // Neither works.
  let slept = 0;
  const neither = stand({ activate: reply(true), "activate-from": reply(true) }, [600]);
  await assert.rejects(bringToFront(s, { platform: "darwin", ps: () => ps, uid: UID, run: neither.run, sleep: async () => { slept++; } }), (e: Error) => {
    assert.equal(e.message, `macOS did not bring the agent browser to the front (pid 4100, profile ${s.profileDir}): activate sent, activate-from sent; `
      + `the app in front is pid 600, as before. macOS 14 and later can refuse an activation that the app in front did not hand over. `
      + `Find the window in the Dock: Control-click the icon of the agent browser's Chrome and choose the window "agent-browser: ${s.stateDir}"`);
    return true;
  });
  assert.equal(slept, 30, "1.5 s of reads after each request");
  // A request that macOS does not send (activate-from before macOS 14) is not waited for; an unknown front app and window name are said so.
  const old = stand({ activate: reply(true), "activate-from": { ...reply(false), macos: 13 } }, [600]);
  const t = settings("refused-restoring");
  slept = 0;
  await assert.rejects(bringToFront(t, { platform: "darwin", ps: () => agentRow(t, 4100).replace(/ --window-name=\S+ \S+/, ""), uid: UID,
    run: async (argv, ms) => argv[0] === LSAPPINFO ? { ok: false, stdout: "", stderr: "lsappinfo failed" } : old.run(argv, ms), sleep: async () => { slept++; } }), (e: Error) => {
    assert.match(e.message, /: activate sent, activate-from not sent; the app in front is unknown\. .*Control-click the icon of the agent browser's Chrome and choose its window$/);
    return true;
  });
  assert.equal(slept, 15, "no wait after a request that was not sent");
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

/** Run FRONT_JXA's run handler in a stand-in of JXA's ObjC bridge: apps by pid, the front app, the macOS version. */
function jxa(argv: string[], world: { apps: Record<number, { path: string | null; activate?: boolean }>; front: number | null; version: string }) {
  const calls: unknown[][] = [];
  const nil = { isNil: () => true };
  const app = (pid: number) => {
    const a = world.apps[pid];
    if (!a) return nil;
    return {
      isNil: () => false,
      processIdentifier: pid,
      executableURL: a.path === null ? nil : { isNil: () => false, path: { js: a.path } },
      activateWithOptions: (options: number) => { calls.push(["activateWithOptions", pid, options]); return a.activate ?? true; },
      activateFromApplicationOptions: (from: { processIdentifier: number }, options: number) => {
        calls.push(["activateFromApplicationOptions", pid, from.processIdentifier, options]); return a.activate ?? true;
      },
    };
  };
  const $ = {
    NSProcessInfo: { processInfo: { operatingSystemVersionString: { js: world.version } } },
    NSRunningApplication: { runningApplicationWithProcessIdentifier: (pid: number) => app(pid) },
    NSWorkspace: { sharedWorkspace: { frontmostApplication: world.front === null ? nil : { isNil: () => false, processIdentifier: world.front } } },
  };
  const imported: string[] = [];
  const context = createContext({ $, ObjC: { import: (name: string) => { imported.push(name); } }, argv });
  const out = runInContext(`${FRONT_JXA}\nrun(argv);`, context);
  return { reply: JSON.parse(out), calls, imported };
}

test("the JXA script: it activates only the pid whose executable is the agent Chrome's binary, with all its windows; activate-from only on macOS 14 and later", () => {
  const apps = { 4100: { path: CHROME_STABLE_BIN }, 600: { path: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" }, 4300: { path: null } };
  const sonoma = { apps, front: 600, version: "Version 14.6.1 (Build 23G93)" };
  let r = jxa(["activate", "4100", CHROME_STABLE_BIN], sonoma);
  assert.deepEqual(r.imported, ["AppKit"]);
  assert.deepEqual(r.reply, { found: true, path: CHROME_STABLE_BIN, before: 600, sent: true, macos: 14 });
  assert.deepEqual(r.calls, [["activateWithOptions", 4100, 3]], "NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps");
  r = jxa(["activate-from", "4100", CHROME_STABLE_BIN], sonoma);
  assert.deepEqual(r.reply, { found: true, path: CHROME_STABLE_BIN, before: 600, sent: true, macos: 14 });
  assert.deepEqual(r.calls, [["activateFromApplicationOptions", 4100, 600, 1]], "from the app in front, with all windows");
  r = jxa(["activate-from", "4100", CHROME_STABLE_BIN], { ...sonoma, version: "Version 13.6 (Build 22G120)" });
  assert.deepEqual([r.reply.sent, r.reply.macos, r.calls], [false, 13, []], "no activate-from before macOS 14");
  r = jxa(["activate-from", "4100", CHROME_STABLE_BIN], { ...sonoma, front: null });
  assert.deepEqual([r.reply.sent, r.reply.before, r.calls], [false, 0, []], "no app in front to hand over");
  // A pid that is another app now, an app with no executable, or no app: nothing is activated.
  for (const [pid, path] of [["600", "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"], ["4300", null]] as const) {
    r = jxa(["activate", pid, CHROME_STABLE_BIN], sonoma);
    assert.deepEqual([r.reply, r.calls], [{ found: true, path, sent: false, macos: 14 }, []], pid);
  }
  r = jxa(["activate", "4999", CHROME_STABLE_BIN], sonoma);
  assert.deepEqual([r.reply, r.calls], [{ found: false, macos: 14 }, []]);
  r = jxa(["activate", "4100", CHROME_STABLE_BIN], { ...sonoma, apps: { 4100: { path: CHROME_STABLE_BIN, activate: false } }, version: "garbled" });
  assert.deepEqual(r.reply, { found: true, path: CHROME_STABLE_BIN, before: 600, sent: false, macos: 0 });
});

test("front's result, its human form, and the CLI on this system: refused off macOS with a usage error, and --state-dir is required", async () => {
  assert.equal(human({ ok: true, command: "front", chromePid: 4100, profileDir: "/s/profile", stateDir: "/s", windowName: "agent-browser: /s", via: "activate" }),
    `the agent browser (pid 4100) is in front: window "agent-browser: /s"\n  profile ${"/s/profile"}\n`);
  assert.equal(human({ ok: true, command: "front", chromePid: 4100, profileDir: "/s/profile", stateDir: null, windowName: null, via: "activate-from" }),
    "the agent browser (pid 4100) is in front: window name unknown\n  profile /s/profile\n");
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

test("the prompt notice names front on macOS, for a person: not on Linux, not with an approver, not in personal mode", () => {
  const s = settings("notice", { commandName: "vedlo browser" });
  const hint = "; a person at the Mac can bring that window to the front with `vedlo browser front`";
  assert.ok(promptNotice(s, "agent Chrome", 90_000, "darwin").endsWith(hint), promptNotice(s, "agent Chrome", 90_000, "darwin"));
  assert.ok(!promptNotice(s, "agent Chrome", 90_000, "linux").includes(" front`"));
  assert.ok(!promptNotice(settings("notice-approve", { approve: "osascript" }), "agent Chrome", 90_000, "darwin").includes(" front`"));
  assert.ok(!promptNotice(settings("notice-personal", { mode: "personal" }), "personal Chrome", 90_000, "darwin").includes(" front`"));
  assert.ok(!promptNotice(settings("notice-endpoint", { endpoint: "ws://127.0.0.1:9/devtools/browser/x" }), "agent Chrome", 90_000, "darwin").includes(" front`"));
});
