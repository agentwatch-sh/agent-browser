// The agent browser (ported from vedlo's agent.test.ts). Chrome is never started: launches use a
// fake spawn and a fake endpoint probe, and process lookups read fake process tables.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  AGENT_ARGS, CHROME_BETA_BIN, CHROME_STABLE_BIN, INSPECT_URL, agentChromeBin, agentChromePid, agentEndpoint, assertNoDebuggingFlag,
  findAgentPid, launchAgentChrome, parsePs, processTree, restoresOnStartup, seedRemoteDebugging, type SpawnLike,
} from "../src/agent.ts";
import { AgentBrowser, endpointCandidates } from "../src/browser.ts";
import { MAX_SOCKET_PATH_BYTES, resolveOptions, type Settings } from "../src/options.ts";

let tmp: string, s: Settings;
const lines: string[] = [];

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "ab-agent-"));
  s = resolveOptions({ stateDir: join(tmp, "state"), allow: ["example.org"], log: (l) => lines.push(l) });
});
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A spawn that records its call and starts nothing. */
function fakeSpawn(calls: { bin: string; args: string[] }[], exitCode: number | null = null): SpawnLike {
  return (bin, args) => { calls.push({ bin, args }); return { pid: 4242, exitCode, unref() {} }; };
}

test("each consumer's profile, socket and state live in its own state folder; nothing defaults to a consumer path", () => {
  assert.equal(s.profileDir, join(tmp, "state", "profile"));
  assert.equal(s.socketPath, join(tmp, "state", "chrome-proxy.sock"));
  const other = resolveOptions({ stateDir: join(tmp, "other") });
  assert.notEqual(other.profileDir, s.profileDir);
  assert.notEqual(other.socketPath, s.socketPath);
  assert.throws(() => resolveOptions({} as never), /stateDir is required/);
  assert.throws(() => resolveOptions({ stateDir: "relative/state" }), /absolute/);
  assert.throws(() => resolveOptions({ stateDir: tmp, socketPath: "/" + "x".repeat(MAX_SOCKET_PATH_BYTES) }), /Unix socket path holds at most/);
  assert.throws(() => resolveOptions({ stateDir: tmp, mode: "shared" as never }), /mode must be/);
});

test("an existing agent process on the profile is found even without a debugging endpoint", () => {
  assert.equal(agentChromePid(s, () => `  42 ${CHROME_BETA_BIN} --user-data-dir=${s.profileDir}`), 42);
  assert.equal(agentChromePid(s, () => `  43 ${CHROME_BETA_BIN} --user-data-dir=${join(tmp, "other", "profile")}`), undefined, "another consumer's browser is not ours");
});

test("launch waits for an existing Chrome to enable debugging without spawning another", async () => {
  let probes = 0;
  lines.length = 0;
  const ws = await launchAgentChrome(s, { timeoutMs: 1_000 }, {
    endpoint: async () => ++probes === 1 ? undefined : "ws://127.0.0.1:9222/devtools/browser/existing",
    pid: () => 42,
    spawn: () => { throw new Error("must not spawn"); },
  });
  assert.match(ws, /existing$/);
  assert.match(lines.join("\n"), /42.*profile/);
});

test("noLaunch: no running agent browser fails with the consumer's launch command instead of starting one", async () => {
  const named = resolveOptions({ ...s, noLaunch: true, commandName: "vedlo browser" });
  await assert.rejects(launchAgentChrome(named, { timeoutMs: 1_000 }, {
    endpoint: async () => undefined, pid: () => undefined, spawn: () => { throw new Error("must not spawn"); },
  }), /not running.*`vedlo browser launch`/s);
});

test("a launch starts a regular Chrome on the consumer's profile, never with a debugging port, and logs who started it", async () => {
  const calls: { bin: string; args: string[] }[] = [];
  let probes = 0;
  const ws = await launchAgentChrome(s, { timeoutMs: 2_000, urls: [INSPECT_URL, "https://example.org/"] }, {
    endpoint: async () => ++probes < 2 ? undefined : "ws://127.0.0.1:9222/devtools/browser/new",
    pid: () => undefined, spawn: fakeSpawn(calls), exists: (p) => p === CHROME_BETA_BIN,
  });
  assert.match(ws, /new$/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, CHROME_BETA_BIN);
  assert.deepEqual(calls[0].args, [...AGENT_ARGS, `--user-data-dir=${s.profileDir}`, INSPECT_URL, "https://example.org/"]);
  assert.ok(!calls[0].args.some((a) => a.startsWith("--remote-debugging")), "no --remote-debugging-port or pipe");
  assert.ok(!calls[0].args.some((a) => a.startsWith("--headless")), "a visible browser the operator can approve");
  const log = readFileSync(join(s.stateDir, "launches.log"), "utf8");
  assert.match(log, /chrome=4242/);
  assert.match(log, new RegExp(`by=${process.pid}`));
  const localState = JSON.parse(readFileSync(join(s.profileDir, "Local State"), "utf8"));
  assert.equal(localState.devtools.remote_debugging["user-enabled"], true, "launch seeds remote debugging so no chrome://inspect click is needed");
});

test("chromeArgs: extra Chrome flags reach the spawn (between --user-data-dir and the urls), and a --remote-debugging flag among them is refused before any spawn", async () => {
  const calls: { bin: string; args: string[] }[] = [];
  let probes = 0;
  const withArgs = resolveOptions({ ...s, chromeArgs: ["--enable-unsafe-swiftshader", "--lang=en-US"] });
  await launchAgentChrome(withArgs, { timeoutMs: 2_000, urls: [INSPECT_URL] }, {
    endpoint: async () => ++probes < 2 ? undefined : "ws://127.0.0.1:9222/devtools/browser/new",
    pid: () => undefined, spawn: fakeSpawn(calls), exists: (p) => p === CHROME_BETA_BIN,
  });
  assert.deepEqual(calls[0].args, [...AGENT_ARGS, `--user-data-dir=${withArgs.profileDir}`, "--enable-unsafe-swiftshader", "--lang=en-US", INSPECT_URL]);

  const sneaky = resolveOptions({ ...s, chromeArgs: ["--remote-debugging-port=9222"] });
  await assert.rejects(launchAgentChrome(sneaky, { timeoutMs: 1_000 }, {
    endpoint: async () => undefined, pid: () => undefined, spawn: () => { throw new Error("must not spawn"); },
  }), /refusing to launch Chrome with --remote-debugging-port/);
});

test("chromeArgs must be an array of non-empty strings", () => {
  assert.throws(() => resolveOptions({ ...s, chromeArgs: "--lang=en-US" as unknown as string[] }), /chromeArgs must be an array/);
  assert.throws(() => resolveOptions({ ...s, chromeArgs: ["--ok", ""] }), /chromeArgs must be an array/);
  assert.throws(() => resolveOptions({ ...s, chromeArgs: ["--ok", 5 as unknown as string] }), /chromeArgs must be an array/);
  assert.doesNotThrow(() => resolveOptions({ ...s, chromeArgs: ["--enable-unsafe-swiftshader"] }));
});

test("seedRemoteDebugging turns remote debugging on in the profile, merges other keys, is idempotent, and never clobbers a corrupt file", () => {
  const prof = join(tmp, "seed-profile");
  mkdirSync(prof, { recursive: true });
  const ls = join(prof, "Local State");
  // no file yet: it is created with only the toggle
  assert.equal(seedRemoteDebugging(prof), true);
  assert.deepEqual(JSON.parse(readFileSync(ls, "utf8")), { devtools: { remote_debugging: { "user-enabled": true } } });
  // merges into existing content without losing other keys
  writeFileSync(ls, JSON.stringify({ browser: { last_version: 42 }, devtools: { adb_key: "x" } }));
  assert.equal(seedRemoteDebugging(prof), true);
  const after = JSON.parse(readFileSync(ls, "utf8"));
  assert.equal(after.browser.last_version, 42, "other top-level keys kept");
  assert.equal(after.devtools.adb_key, "x", "other devtools keys kept");
  assert.equal(after.devtools.remote_debugging["user-enabled"], true);
  // idempotent: already on, so the file is not rewritten
  const before = readFileSync(ls, "utf8");
  assert.equal(seedRemoteDebugging(prof), true);
  assert.equal(readFileSync(ls, "utf8"), before);
  // a corrupt Local State is left untouched (never clobber Chrome's own state)
  writeFileSync(ls, "{ not json");
  assert.equal(seedRemoteDebugging(prof), false);
  assert.equal(readFileSync(ls, "utf8"), "{ not json");
});

test("remote-debugging and enable-automation flags are refused before anything is spawned, incl. single-dash and mixed-case forms", async () => {
  for (const flag of [
    "--remote-debugging-port=9222", "--remote-debugging-port", "--remote-debugging-pipe", "--remote-debugging-address=0.0.0.0",
    "-remote-debugging-port=9222",    // Chrome's POSIX parser accepts a single dash too
    "--Remote-Debugging-Port=9222",   // defense in depth: the switch name is normalized to lowercase
    "--enable-automation", "-enable-automation", // also sets navigator.webdriver
  ]) {
    const calls: { bin: string; args: string[] }[] = [];
    await assert.rejects(launchAgentChrome(s, { extraArgs: [flag] }, { endpoint: async () => undefined, pid: () => undefined, spawn: fakeSpawn(calls) }), /navigator\.webdriver/, flag);
    assert.equal(calls.length, 0, flag);
  }
  // a near-miss switch and ordinary flags are allowed
  assert.doesNotThrow(() => assertNoDebuggingFlag(["--remote-debugging-something-else", "--no-first-run", "--enable-unsafe-swiftshader", "--lang=en-US"]));
});

test("a Chrome that hands the launch to a running instance means debugging is off there", async () => {
  await assert.rejects(launchAgentChrome(s, { timeoutMs: 2_000 }, {
    endpoint: async () => undefined, pid: () => undefined, spawn: fakeSpawn([], 0),
  }), /remote debugging is off: turn it on in chrome:\/\/inspect/);
});

test("reads 'continue where you left off' from Secure Preferences and never writes it", () => {
  const prof = join(tmp, "prefs-profile");
  mkdirSync(join(prof, "Default"), { recursive: true });
  assert.equal(restoresOnStartup(prof), undefined, "new profile: unknown");
  writeFileSync(join(prof, "Default", "Secure Preferences"), JSON.stringify({ session: { restore_on_startup: 1 } }));
  const before = readFileSync(join(prof, "Default", "Secure Preferences"), "utf8");
  assert.equal(restoresOnStartup(prof), true);
  assert.equal(readFileSync(join(prof, "Default", "Secure Preferences"), "utf8"), before, "untouched");
  writeFileSync(join(prof, "Default", "Secure Preferences"), JSON.stringify({ session: { restore_on_startup: 5 } }));
  assert.equal(restoresOnStartup(prof), false);
});

test("a stale DevToolsActivePort is not mistaken for a running browser", async () => {
  mkdirSync(s.profileDir, { recursive: true });
  writeFileSync(join(s.profileDir, "DevToolsActivePort"), "1\n/devtools/browser/stale\n");
  assert.equal(await agentEndpoint(s, { ownerPids: () => [], chromePid: () => undefined }), undefined);
});

test("a reused DevToolsActivePort owned by an unrelated listener is rejected", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    writeFileSync(join(s.profileDir, "DevToolsActivePort"), `${port}\n/devtools/browser/stale\n`);
    assert.equal(await agentEndpoint(s), undefined, "no agent Chrome runs on this profile");
    assert.equal(await agentEndpoint(s, { ownerPids: () => [999], chromePid: () => 42 }), undefined);
    assert.equal(await agentEndpoint(s, { ownerPids: () => [42], chromePid: () => 42 }), `ws://127.0.0.1:${port}/devtools/browser/stale`);
  } finally { server.close(); }
});

test("the agent browser runs from Chrome Beta when installed, else Google Chrome; chromeBin wins; never Chrome for Testing", () => {
  assert.equal(agentChromeBin({}, (p) => p === CHROME_BETA_BIN), CHROME_BETA_BIN);
  assert.equal(agentChromeBin({}, () => false), CHROME_STABLE_BIN);
  assert.equal(agentChromeBin({ chromeBin: "/x/Chrome" }, () => true), "/x/Chrome");
  const cft = "/Users/x/.cache/chrome/154/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  assert.throws(() => agentChromeBin({ chromeBin: cft }), /never runs from Chrome for Testing/);
  assert.throws(() => resolveOptions({ stateDir: tmp, chromeBin: cft }), /never runs from Chrome for Testing/);
  assert.throws(() => resolveOptions({ stateDir: tmp, chromeBin: "/opt/chrome-headless-shell" }), /Chrome for Testing/);
});

test("findAgentPid: the main process on the agent profile (by profile + role), never another profile, a helper, or a child", () => {
  const prof = "/p/agent/profile";
  const ps = [
    `  11 ${CHROME_STABLE_BIN} --user-data-dir=/Users/x/other`,
    `  12 /Applications/Google Chrome Beta.app/Contents/Frameworks/Google Chrome Beta Framework.framework/Versions/156.0.8078.4/Helpers/Google Chrome Beta Helper (Renderer).app/Contents/MacOS/Google Chrome Beta Helper (Renderer) --type=renderer --user-data-dir=${prof}`,
    `  13 ${CHROME_BETA_BIN} --no-first-run --user-data-dir=${prof} chrome://inspect/#remote-debugging`,
  ].join("\n");
  assert.equal(findAgentPid(ps, prof), 13);
  assert.equal(findAgentPid(`  21 ${CHROME_STABLE_BIN} --no-first-run --user-data-dir=${prof}`, prof), 21, "a stable-launched agent browser is still found");
  const custom = resolveOptions({ stateDir: tmp, profileDir: prof, chromeBin: "/another/Chrome" });
  assert.equal(agentChromePid(custom, () => `  22 ${CHROME_BETA_BIN} --no-first-run --user-data-dir=${prof}`), 22, "a Beta-launched browser stays findable after a binary override");
  assert.equal(findAgentPid(`  11 ${CHROME_STABLE_BIN} --user-data-dir=/Users/x/other`, prof), undefined);
  // Debian/Ubuntu: `chromium`/`google-chrome` are wrapper scripts that exec a different real binary,
  // so the launch path (e.g. /usr/bin/chromium) never appears in ps. Find it by profile + role anyway.
  assert.equal(findAgentPid(`  41 /usr/lib/chromium/chromium --no-first-run --user-data-dir=${prof} chrome://inspect/#remote-debugging`, prof), 41, "a Debian wrapper-launched Chromium is found by its real binary");
  // A Linux child carries --user-data-dir too, but --type= marks it a child, never the main process.
  assert.equal(findAgentPid(`  42 /usr/lib/chromium/chromium --type=zygote --user-data-dir=${prof}`, prof), undefined, "a zygote on the profile is not the main process");
  assert.equal(findAgentPid(`  43 /usr/lib/chromium/chromium --type=gpu-process --user-data-dir=${prof}`, prof), undefined, "a gpu process on the profile is not the main process");
});

test("findAgentPid: a profile folder with spaces matches whole, never a longer folder that starts with it", () => {
  const prof = "/Users/x/My Projects/app/state/profile";
  assert.equal(findAgentPid(`  31 ${CHROME_BETA_BIN} --no-first-run --user-data-dir=${prof}`, prof), 31, "flag last");
  assert.equal(findAgentPid(`  32 ${CHROME_BETA_BIN} --user-data-dir=${prof} --no-first-run chrome://inspect/#remote-debugging`, prof), 32, "flag in the middle");
  assert.equal(findAgentPid(`  33 ${CHROME_BETA_BIN} --user-data-dir=${prof}2 --no-first-run`, prof), undefined, "a sibling folder");
  assert.equal(findAgentPid(`  34 ${CHROME_BETA_BIN} --user-data-dir=${prof}/Default`, prof), undefined, "a folder inside it");
});

test("parsePs reads `ps ax -o pid=,ppid=,command=` and skips lines that are not processes", () => {
  const rows = parsePs([
    "    1     0 /sbin/launchd",
    "  100     1 /Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta --user-data-dir=/p/Application Support/x",
    "",
    "not a process",
  ].join("\n"));
  assert.deepEqual(rows, [
    { pid: 1, ppid: 0, command: "/sbin/launchd" },
    { pid: 100, ppid: 1, command: "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta --user-data-dir=/p/Application Support/x" },
  ]);
});

test("processTree: a process and everything below it, never its siblings or parents; a pid that is not running has no tree", () => {
  const rows = [
    { pid: 1, ppid: 0, command: "launchd" }, { pid: 10, ppid: 1, command: "main" }, { pid: 11, ppid: 10, command: "helper" },
    { pid: 12, ppid: 11, command: "grandchild" }, { pid: 20, ppid: 1, command: "other main" }, { pid: 21, ppid: 20, command: "other helper" },
  ];
  assert.deepEqual(processTree(rows, 10), [10, 11, 12]);
  assert.deepEqual(processTree(rows, 12), [12]);
  assert.deepEqual(processTree(rows, 99), []);
  // A process table is a snapshot: a pid reused as its own parent or a loop must not hang the walk.
  assert.deepEqual(processTree([{ pid: 5, ppid: 6, command: "a" }, { pid: 6, ppid: 5, command: "b" }, { pid: 7, ppid: 7, command: "c" }], 5), [5, 6]);
  assert.deepEqual(processTree([{ pid: 7, ppid: 7, command: "c" }], 7), [7]);
});

test("under node --test, personal mode never reaches the real Chrome profile, and state outside the temp dir is refused", async () => {
  const hits: number[] = [];
  const server = createServer((sock) => { hits.push(1); sock.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const home = mkdtempSync(join(tmpdir(), "ab-fakehome-"));
  const prof = join(home, "Library", "Application Support", "Google", "Chrome");
  mkdirSync(prof, { recursive: true });
  writeFileSync(join(prof, "DevToolsActivePort"), `${port}\n/devtools/browser/real\n`);
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const personal = resolveOptions({ stateDir: join(tmp, "personal"), allow: ["example.org"], mode: "personal" });
    assert.deepEqual(endpointCandidates(personal), []);
    await assert.rejects(AgentBrowser.connect(personal), /Could not reach Chrome \(mode personal\)/);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(hits.length, 0, "the listener standing in for the operator's Chrome got no connection");
    const explicit = resolveOptions({ ...personal, personalUserDataDir: prof });
    assert.deepEqual(endpointCandidates(explicit).map((c) => c.source), ["DevToolsActivePort"], "an explicit folder is read");

    const outside = mkdtempSync("/var/tmp/ab-decoy-");
    try {
      for (const mode of ["personal", "agent"] as const)
        await assert.rejects(AgentBrowser.connect({ stateDir: outside, allow: ["example.org"], mode, endpoint: `ws://127.0.0.1:${port}/devtools/browser/x` }), /outside the temp dir/);
      assert.equal(hits.length, 0);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
