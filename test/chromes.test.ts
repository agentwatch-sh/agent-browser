// The machine-wide listing (`chromes`, #3): crafted `ps` rows of Linux (procps) and macOS (BSD ps),
// and made-up state folders in the temp folder. Nothing here starts a Chrome; the CLI test proves that
// the listing connects to nothing and signals nothing.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_ARGS, CHROME_BETA_BIN, CHROME_STABLE_BIN, agentWindowName, launchAgentChrome } from "../src/agent.ts";
import { listAgentChromes, parseUserPs } from "../src/chromes.ts";
import { resolveOptions } from "../src/options.ts";
import { proxyArgs } from "../src/proxy.ts";
import { cli } from "./helpers.ts";

const UID = process.getuid!();
const OTHER = UID + 1;
/** agent-browser's own launch flags, as `ps` shows them before --user-data-dir. */
const SIG = AGENT_ARGS.join(" ");
const INSPECT = "chrome://inspect/#remote-debugging";

let tmp = "";
before(() => { tmp = mkdtempSync(join(tmpdir(), "ab-chromes-")); });
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A made-up state folder with a profile folder and these files (an object is written as JSON). */
function folder(name: string, files: Record<string, string | object> = {}): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "profile"), { recursive: true });
  for (const [f, v] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), typeof v === "string" ? v : JSON.stringify(v));
  }
  return dir;
}

// procps right-aligns the uid in 5 columns and the pid in 7; BSD ps on macOS the pid in 5.
const linux = (uid: number, pid: number, command: string) => `${String(uid).padStart(5)} ${String(pid).padStart(7)} ${command}`;
const mac = (uid: number, pid: number, command: string) => `${String(uid).padStart(5)} ${String(pid).padStart(5)} ${command}`;

const proxyCommand = (node: string, bin: string, upstream: string, o: { stateDir: string; profile: string; mode?: string; commandName: string; extra?: string }) =>
  `${node} ${bin} proxy ${upstream} --state-dir ${o.stateDir} --socket ${o.stateDir}/chrome-proxy.sock --profile ${o.profile} --mode ${o.mode ?? "agent"} --proxy-idle-ms 43200000 --command-name ${o.commandName}${o.extra ? ` ${o.extra}` : ""} --attempt 5f0e9a --timeout-ms 89000`;

test("parseUserPs reads the uid, pid and command of procps and BSD ps rows, and skips lines that are not processes", () => {
  const rows = parseUserPs([
    linux(0, 1, "/sbin/init"),
    linux(0, 2, "[kthreadd]"),
    mac(501, 4100, `${CHROME_BETA_BIN} --user-data-dir=/Users/me/Application Support/x`),
    "",
    "not a process",
  ].join("\n"));
  assert.deepEqual(rows, [
    { uid: 0, pid: 1, command: "/sbin/init" },
    { uid: 0, pid: 2, command: "[kthreadd]" },
    { uid: 501, pid: 4100, command: `${CHROME_BETA_BIN} --user-data-dir=/Users/me/Application Support/x` },
  ]);
});

test("Linux: each agent Chrome main process of this user, with its state folder, window, command name and approved proxy; never a helper, another user's Chrome or a process that only names the profile", () => {
  const A = folder("linux-a", { "chrome-proxy.json": { pid: 200400, upstream: "ws://127.0.0.1:41234/devtools/browser/0b1c" } });
  const B = join(tmp, "My Projects", "vedlo state");
  mkdirSync(join(B, "My Profile"), { recursive: true });
  // B's pid file names a proxy of another user: not this user's proxy, so not up for this listing.
  writeFileSync(join(B, "chrome-proxy.json"), JSON.stringify({ pid: 300400, upstream: "ws://127.0.0.1:41999/devtools/browser/ffff" }));
  const ps = [
    linux(0, 1, "/sbin/init"),
    linux(UID, 200100, `/opt/google/chrome-beta/chrome ${SIG} --user-data-dir=${A}/profile --window-name=agent-browser: ${A} ${INSPECT}`),
    linux(UID, 200102, `/opt/google/chrome-beta/chrome_crashpad_handler --monitor-self --monitor-self-annotation=ptype=crashpad-handler --database=${A}/profile/Crash Reports --url=https://clients2.google.com/cr/report --annotation=channel=beta --initial-client-fd=5 --shared-client-connection`),
    linux(UID, 200105, `/opt/google/chrome-beta/chrome --type=zygote --no-zygote-sandbox --crashpad-handler-pid=200102 --enable-crash-reporter=,beta --user-data-dir=${A}/profile`),
    linux(UID, 200140, `/opt/google/chrome-beta/chrome --type=renderer --crashpad-handler-pid=200102 --user-data-dir=${A}/profile --lang=en-US --num-raster-threads=4`),
    // Debian's chromium wrapper puts its own flags first; the profile and the command name hold spaces.
    linux(UID, 200300, `/usr/lib/chromium/chromium --show-component-extension-options --enable-gpu-rasterization --no-default-browser-check --disable-pings --media-router=0 ${SIG} --user-data-dir=${B}/My Profile --window-name=vedlo browser: ${B} --lang=en-US ${INSPECT} https://example.org/`),
    linux(UID, 200400, proxyCommand("/home/me/.nvm/versions/node/v26.1.0/bin/node", "/home/me/src/app/node_modules/agent-browser/bin/agent-browser.js", "ws://127.0.0.1:41234/devtools/browser/0b1c", { stateDir: A, profile: `${A}/profile`, commandName: "agent-browser" })),
    linux(OTHER, 300400, proxyCommand("/usr/bin/node", "/opt/agent-browser/bin/agent-browser.js", "ws://127.0.0.1:41999/devtools/browser/ffff", { stateDir: B, profile: `${B}/My Profile`, commandName: "vedlo browser" })),
    // Another user's agent Chrome, with every mark of one.
    linux(OTHER, 300100, `/opt/google/chrome/chrome ${SIG} --user-data-dir=/home/other/state/profile --window-name=agent-browser: /home/other/state ${INSPECT}`),
    // Processes that only name the profile in their argv.
    linux(UID, 200500, `claude --print the browser binary with --user-data-dir=${A}/profile, no --type=`),
    linux(UID, 200510, `tail -f ${A}/launches.log`),
    linux(UID, 200520, `/usr/bin/python3 /home/me/bin/probe.py ${SIG} --user-data-dir=${A}/profile`),
    linux(UID, 200530, `/usr/bin/timeout 5 /opt/google/chrome/chrome ${SIG} --user-data-dir=${A}/profile`),
    // A Chrome of this user that agent-browser did not start (a Playwright run): no launch flags, no proxy.
    linux(UID, 200600, `/home/me/.cache/ms-playwright/chromium-1200/chrome-linux/chrome --disable-field-trial-config --no-first-run --user-data-dir=/tmp/playwright_chromiumdev_profile-x --remote-debugging-pipe --no-startup-window`),
  ].join("\n");
  assert.deepEqual(listAgentChromes({ ps: () => ps, uid: UID }), [
    { pid: 200100, profileDir: `${A}/profile`, stateDir: A, windowName: `agent-browser: ${A}`, commandName: "agent-browser",
      proxy: { pid: 200400, upstream: "ws://127.0.0.1:41234/devtools/browser/0b1c" } },
    { pid: 200300, profileDir: `${B}/My Profile`, stateDir: B, windowName: `vedlo browser: ${B}`, commandName: "vedlo browser", proxy: null },
  ]);
});

test("macOS: the app binary's main process only (never a Helper, the crashpad handler, `open`, or the operator's own Chrome); a restoring profile's window name is unknown; Chrome takes the last --window-name", () => {
  const C = folder("mac-c", { "chrome-proxy.json": { pid: 4500, upstream: "ws://127.0.0.1:52100/devtools/browser/9f8e" } });
  // D restores its session, so its window keeps an old name; its pid file is stale (no such process).
  const D = folder("mac-d", { "profile/Default/Secure Preferences": { session: { restore_on_startup: 1 } }, "chrome-proxy.json": { pid: 4999, upstream: "ws://127.0.0.1:1/devtools/browser/old" } });
  // E's pid file names a pid that the system gave to a renderer since: not a proxy.
  const E = folder("mac-e", { "chrome-proxy.json": { pid: 4103, upstream: "ws://127.0.0.1:2/devtools/browser/old" } });
  const helpers = "/Applications/Google Chrome Beta.app/Contents/Frameworks/Google Chrome Beta Framework.framework/Versions/158.0.7400.2/Helpers";
  const ps = [
    mac(0, 1, "/sbin/launchd"),
    mac(UID, 4100, `${CHROME_BETA_BIN} ${SIG} --user-data-dir=${C}/profile --window-name=agentwatch browser: ${C} ${INSPECT}`),
    mac(UID, 4101, `${helpers}/chrome_crashpad_handler --monitor-self-annotation=ptype=crashpad-handler --database=${C}/profile/Crashpad --url=https://clients2.google.com/cr/report --annotation=channel=beta --handshake-fd=5`),
    mac(UID, 4102, `${helpers}/Google Chrome Beta Helper (GPU).app/Contents/MacOS/Google Chrome Beta Helper (GPU) --type=gpu-process --user-data-dir=${C}/profile --gpu-preferences=UAAAAAAAAAAgAAAEAAAAAAAAAAAAAAAAAABgAAEAAAA4AAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAABAAAAAAAAAAIAAAAAAAAAAoAAAAAAAAAAgAAAAAAAAA`),
    mac(UID, 4103, `${helpers}/Google Chrome Beta Helper (Renderer).app/Contents/MacOS/Google Chrome Beta Helper (Renderer) --type=renderer --user-data-dir=${C}/profile --lang=en-US`),
    mac(UID, 4200, CHROME_STABLE_BIN),
    mac(UID, 4300, `/usr/bin/open -n -g -a /Applications/Google Chrome Beta.app --args ${SIG} --user-data-dir=${D}/profile --window-name=agent-browser: ${D} ${INSPECT}`),
    mac(UID, 4400, `${CHROME_BETA_BIN} ${SIG} --user-data-dir=${D}/profile --window-name=agent-browser: ${D} ${INSPECT}`),
    // A consumer's chromeArgs name the window too: Chrome takes the last --window-name.
    mac(UID, 4410, `${CHROME_STABLE_BIN} ${SIG} --user-data-dir=${E}/profile --window-name=agent-browser: ${E} --window-name=Research ${INSPECT}`),
    mac(UID, 4500, proxyCommand("/opt/homebrew/Cellar/node/26.1.0/bin/node", "/Users/me/My Projects/agent-browser/bin/agent-browser.js", "ws://127.0.0.1:52100/devtools/browser/9f8e",
      { stateDir: C, profile: `${C}/profile`, commandName: "agentwatch browser", extra: `--approve-command ["/usr/local/bin/approve","--fast"]` })),
    mac(OTHER, 5100, `${CHROME_BETA_BIN} ${SIG} --user-data-dir=/Users/other/state/profile --window-name=agent-browser: /Users/other/state ${INSPECT}`),
    mac(UID, 4600, `/bin/zsh -c grep -- '--user-data-dir=${C}/profile' launches.log`),
  ].join("\n");
  assert.deepEqual(listAgentChromes({ ps: () => ps, uid: UID }), [
    { pid: 4100, profileDir: `${C}/profile`, stateDir: C, windowName: `agentwatch browser: ${C}`, commandName: "agentwatch browser",
      proxy: { pid: 4500, upstream: "ws://127.0.0.1:52100/devtools/browser/9f8e" } },
    { pid: 4400, profileDir: `${D}/profile`, stateDir: D, windowName: null, commandName: "agent-browser", proxy: null },
    { pid: 4410, profileDir: `${E}/profile`, stateDir: E, windowName: "Research", commandName: "agent-browser", proxy: null },
  ]);
});

test("a Chrome with no window name in its argv (started before #3, or by hand): the state folder and command name come from its proxy, or the profile's parent with a launches.log, else they are unknown", () => {
  const F = folder("old-f", { "launches.log": "2026-10-01T00:00:00.000Z chrome=1 by=2 cwd=/ cmd=x launch\n" });
  const G = folder("old-g");
  const H = folder("old-h", { "chrome-proxy.json": { pid: 600, upstream: "ws://127.0.0.1:3/devtools/browser/h" } });
  const hProfile = join(tmp, "old-h-profile");
  const I = folder("hand-i"), J = folder("personal-j");
  const node = "/usr/bin/node", bin = "/opt/agent-browser/bin/agent-browser.js";
  const ps = [
    linux(UID, 100, `/opt/google/chrome/chrome ${SIG} --user-data-dir=${F}/profile ${INSPECT}`),
    linux(UID, 200, `/opt/google/chrome/chrome ${SIG} --user-data-dir=${G}/profile ${INSPECT}`),
    linux(UID, 300, `/opt/google/chrome/chrome ${SIG} --user-data-dir=${hProfile} ${INSPECT}`),
    linux(UID, 600, proxyCommand(node, bin, "ws://127.0.0.1:3/devtools/browser/h", { stateDir: H, profile: hProfile, commandName: "vedlo browser" })),
    // Started by hand on an agent profile, without agent-browser's flags: its agent-browser proxy is
    // the evidence. That proxy has no pid file yet (it waits for the approval), so it is not up.
    linux(UID, 400, `/opt/google/chrome/chrome --user-data-dir=${I}/profile`),
    linux(UID, 700, proxyCommand(node, bin, "ws://127.0.0.1:4/devtools/browser/i", { stateDir: I, profile: `${I}/profile`, commandName: "agentwatch browser" })),
    // A personal-mode proxy never drives the Chrome on its (unused) profile, so it is no evidence.
    linux(UID, 500, `/opt/google/chrome/chrome --user-data-dir=${J}/profile`),
    linux(UID, 800, proxyCommand(node, bin, "ws://127.0.0.1:5/devtools/browser/j", { stateDir: J, profile: `${J}/profile`, mode: "personal", commandName: "agent-browser" })),
  ].join("\n");
  assert.deepEqual(listAgentChromes({ ps: () => ps, uid: UID }), [
    { pid: 100, profileDir: `${F}/profile`, stateDir: F, windowName: null, commandName: null, proxy: null },
    { pid: 200, profileDir: `${G}/profile`, stateDir: null, windowName: null, commandName: null, proxy: null },
    { pid: 300, profileDir: hProfile, stateDir: H, windowName: null, commandName: "vedlo browser", proxy: { pid: 600, upstream: "ws://127.0.0.1:3/devtools/browser/h" } },
    { pid: 400, profileDir: `${I}/profile`, stateDir: I, windowName: null, commandName: "agentwatch browser", proxy: null },
  ]);
});

test("files of another user are never read: no pid file, no profile preferences, no launches.log; the argv still names the state folder", () => {
  // These files belong to the user that runs the test, so for uid `stranger` they are another user's.
  const stranger = UID + 4242;
  const K = folder("owner-k", { "chrome-proxy.json": { pid: 900, upstream: "ws://127.0.0.1:6/devtools/browser/k" } });
  const L = folder("owner-l", { "launches.log": "x\n" });
  const ps = [
    linux(stranger, 100, `/opt/google/chrome/chrome ${SIG} --user-data-dir=${K}/profile --window-name=agent-browser: ${K} ${INSPECT}`),
    linux(stranger, 900, proxyCommand("/usr/bin/node", "/opt/agent-browser/bin/agent-browser.js", "ws://127.0.0.1:6/devtools/browser/k", { stateDir: K, profile: `${K}/profile`, commandName: "agent-browser" })),
    linux(stranger, 200, `/opt/google/chrome/chrome ${SIG} --user-data-dir=${L}/profile ${INSPECT}`),
  ].join("\n");
  assert.deepEqual(listAgentChromes({ ps: () => ps, uid: stranger }), [
    { pid: 100, profileDir: `${K}/profile`, stateDir: K, windowName: null, commandName: "agent-browser", proxy: null },
    { pid: 200, profileDir: `${L}/profile`, stateDir: null, windowName: null, commandName: null, proxy: null },
  ]);
});

test("the pid file must name this state folder's own proxy: one of another state folder, another profile, personal mode, or another upstream (a later proxy on a reused pid) is not up", () => {
  const node = "/usr/bin/node", bin = "/opt/agent-browser/bin/agent-browser.js";
  const elsewhere = join(tmp, "elsewhere");
  const rows: string[] = [], expected: unknown[] = [];
  const cases: { name: string; pid: number; proxy: Partial<{ stateDir: string; profile: string; mode: string; upstream: string }>; up: boolean }[] = [
    { name: "id-state", pid: 710, proxy: { stateDir: elsewhere }, up: false },
    { name: "id-profile", pid: 720, proxy: { profile: join(elsewhere, "profile") }, up: false },
    { name: "id-mode", pid: 730, proxy: { mode: "personal" }, up: false },
    { name: "id-upstream", pid: 740, proxy: { upstream: "ws://127.0.0.1:7/devtools/browser/later" }, up: false },
    { name: "id-match", pid: 750, proxy: {}, up: true },
  ];
  for (const c of cases) {
    const upstream = `ws://127.0.0.1:7/devtools/browser/${c.name}`;
    const dir = folder(c.name, { "chrome-proxy.json": { pid: c.pid, upstream } });
    rows.push(linux(UID, c.pid - 100, `/opt/google/chrome/chrome ${SIG} --user-data-dir=${dir}/profile --window-name=agent-browser: ${dir} ${INSPECT}`));
    rows.push(linux(UID, c.pid, proxyCommand(node, bin, c.proxy.upstream ?? upstream,
      { stateDir: c.proxy.stateDir ?? dir, profile: c.proxy.profile ?? `${dir}/profile`, mode: c.proxy.mode, commandName: "agent-browser" })));
    expected.push({ pid: c.pid - 100, profileDir: `${dir}/profile`, stateDir: dir, windowName: `agent-browser: ${dir}`, commandName: "agent-browser",
      proxy: c.up ? { pid: c.pid, upstream } : null });
  }
  assert.deepEqual(listAgentChromes({ ps: () => rows.join("\n"), uid: UID }), expected);
});

test("the binary, the profile and the launch flags: `timeout` in front of a macOS Chrome, another app bundle, the last --user-data-dir, the flags right in front of the profile, and a value that ends at a single-dash switch", () => {
  const P = folder("guard-p"), Q = folder("guard-q"), R1 = folder("guard-r1"), R2 = folder("guard-r2"), S1 = folder("guard-s1"), S2 = folder("guard-s2");
  const ps = [
    // " /" in front of the app path: a second argument, so `timeout` itself, not a Chrome.
    mac(UID, 100, `/opt/homebrew/bin/timeout 600 ${CHROME_BETA_BIN} ${SIG} --user-data-dir=${P}/profile --window-name=agent-browser: ${P} ${INSPECT}`),
    // Only the Chrome and Chromium app bundles, and only their own binary.
    mac(UID, 110, `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser ${SIG} --user-data-dir=${P}/profile --window-name=agent-browser: ${P} ${INSPECT}`),
    mac(UID, 120, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper ${SIG} --user-data-dir=${P}/profile --window-name=agent-browser: ${P} ${INSPECT}`),
    // Chromium, with a chromeArgs element in Chrome's single-dash form after the window name.
    mac(UID, 130, `/Applications/Chromium.app/Contents/MacOS/Chromium ${SIG} --user-data-dir=${Q}/profile --window-name=agent-browser: ${Q} -incognito ${INSPECT}`),
    // Chrome takes the last --user-data-dir; a proxy of this user drives that profile.
    linux(UID, 200, `/opt/google/chrome/chrome --user-data-dir=${R1}/profile --user-data-dir=${R2}/profile`),
    linux(UID, 210, proxyCommand("/usr/bin/node", "/opt/agent-browser/bin/agent-browser.js", "ws://127.0.0.1:8/devtools/browser/r", { stateDir: R2, profile: `${R2}/profile`, commandName: "vedlo browser" })),
    // agent-browser's flags count only right in front of the profile.
    linux(UID, 300, `/opt/google/chrome/chrome --user-data-dir=${S1}/profile ${SIG} ${INSPECT}`),
    linux(UID, 310, `/opt/google/chrome/chrome ${SIG} --lang=en-US --user-data-dir=${S2}/profile ${INSPECT}`),
  ].join("\n");
  assert.deepEqual(listAgentChromes({ ps: () => ps, uid: UID }), [
    { pid: 130, profileDir: `${Q}/profile`, stateDir: Q, windowName: `agent-browser: ${Q}`, commandName: "agent-browser", proxy: null },
    { pid: 200, profileDir: `${R2}/profile`, stateDir: R2, windowName: null, commandName: "vedlo browser", proxy: null },
  ]);
});

test("an agent Chrome that release v0.2.9 or a build before this change started, with the two timer flags, is still listed until it quits (ab-v16.13)", () => {
  const T = folder("timers-t"), U = folder("timers-u");
  const before = "--no-first-run --no-default-browser-check --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling";
  assert.notEqual(before, SIG, "today's launch has no timer flag");
  const ps = [
    linux(UID, 100, `/opt/google/chrome/chrome ${before} --user-data-dir=${T}/profile --window-name=agent-browser: ${T} ${INSPECT}`),
    mac(UID, 110, `${CHROME_BETA_BIN} ${before} --user-data-dir=${U}/profile --window-name=vedlo browser: ${U} ${INSPECT}`),
    // Only the two flags, without the rest of that launch, are no evidence.
    linux(UID, 120, `/opt/google/chrome/chrome --disable-renderer-backgrounding --disable-background-timer-throttling --user-data-dir=${tmp}/x/profile ${INSPECT}`),
  ].join("\n");
  assert.deepEqual(listAgentChromes({ ps: () => ps, uid: UID }), [
    { pid: 100, profileDir: `${T}/profile`, stateDir: T, windowName: `agent-browser: ${T}`, commandName: "agent-browser", proxy: null },
    { pid: 110, profileDir: `${U}/profile`, stateDir: U, windowName: `vedlo browser: ${U}`, commandName: "vedlo browser", proxy: null },
  ]);
});

test("a file of another user inside this user's folders is not read: a pid file, either preference file of the profile, a launches.log", () => {
  const files = (pid: number, extra: Record<string, string | object> = {}) => ({ "chrome-proxy.json": { pid, upstream: `ws://127.0.0.1:9/devtools/browser/${pid}` }, ...extra });
  const T = folder("foreign-t", files(810)), X = folder("foreign-x", files(860));
  const U = folder("foreign-u", { "profile/Default/Secure Preferences": { session: { restore_on_startup: 4 } } });
  const V = folder("foreign-v", { "profile/Default/Preferences": { session: { restore_on_startup: 4 } } });
  const W = folder("foreign-w", { "launches.log": "x\n" });
  // These paths report another owner; everything else is this user's, as on disk.
  const foreign = new Set([join(T, "chrome-proxy.json"), join(U, "profile/Default/Secure Preferences"), join(V, "profile/Default/Preferences"), join(W, "launches.log")]);
  const stat = (path: string) => {
    const st = statSync(path, { throwIfNoEntry: false });
    return st && foreign.has(path) ? { uid: OTHER, isFile: () => st.isFile(), isDirectory: () => st.isDirectory() } : st;
  };
  const chrome = (pid: number, dir: string, named = true) =>
    linux(UID, pid, `/opt/google/chrome/chrome ${SIG} --user-data-dir=${dir}/profile${named ? ` --window-name=agent-browser: ${dir}` : ""} ${INSPECT}`);
  const proxy = (pid: number, dir: string) =>
    linux(UID, pid, proxyCommand("/usr/bin/node", "/opt/agent-browser/bin/agent-browser.js", `ws://127.0.0.1:9/devtools/browser/${pid}`, { stateDir: dir, profile: `${dir}/profile`, commandName: "agent-browser" }));
  const ps = [chrome(800, T), proxy(810, T), chrome(820, U), chrome(830, V), chrome(840, W, false), chrome(850, X), proxy(860, X)].join("\n");
  const entry = (pid: number, dir: string, more: object) => ({ pid, profileDir: `${dir}/profile`, stateDir: dir, windowName: `agent-browser: ${dir}`, commandName: "agent-browser", proxy: null, ...more });
  assert.deepEqual(listAgentChromes({ ps: () => ps, uid: UID, stat }), [
    entry(800, T, {}),
    entry(820, U, { windowName: null }),
    entry(830, V, { windowName: null }),
    { pid: 840, profileDir: `${W}/profile`, stateDir: null, windowName: null, commandName: null, proxy: null },
    entry(850, X, { proxy: { pid: 860, upstream: "ws://127.0.0.1:9/devtools/browser/860" } }),
  ]);
});

test("the listing reads the argv that agent-browser itself makes: launchAgentChrome's Chrome and proxyArgs' proxy, in a folder with spaces", async () => {
  const st = resolveOptions({ stateDir: join(tmp, "My Projects", "real launch"), commandName: "vedlo browser", chromeArgs: ["--lang=en-US"], log: () => {} });
  const calls: { bin: string; args: string[] }[] = [];
  let probes = 0;
  await launchAgentChrome(st, { timeoutMs: 2_000, urls: [INSPECT, "https://example.org/"] }, {
    endpoint: async () => ++probes < 2 ? undefined : "ws://127.0.0.1:9222/devtools/browser/real",
    pid: () => undefined, exists: (p) => p === CHROME_BETA_BIN,
    spawn: (bin, args) => { calls.push({ bin, args }); return { pid: 4242, exitCode: null, unref() {} }; },
  });
  const upstream = "ws://127.0.0.1:9222/devtools/browser/real";
  writeFileSync(join(st.stateDir, "chrome-proxy.json"), JSON.stringify({ pid: 4300, upstream }));
  const ps = [
    mac(UID, 4242, [calls[0].bin, ...calls[0].args].join(" ")),
    mac(UID, 4300, [process.execPath, ...proxyArgs({ ...st, approve: { command: ["/usr/local/bin/approve", "--fast"] } }, upstream, "a1", 90_000)].join(" ")),
  ].join("\n");
  assert.deepEqual(listAgentChromes({ ps: () => ps, uid: UID }), [
    { pid: 4242, profileDir: st.profileDir, stateDir: st.stateDir, windowName: agentWindowName(st), commandName: "vedlo browser", proxy: { pid: 4300, upstream } },
  ]);
});

// A stand-in for a Chrome or a proxy: it listens where that one listens (a TCP port on 127.0.0.1, or
// a Unix socket path), writes down each connection and each signal that it gets, and ends by itself
// when its stdin pipe closes (the test ends it so, and a test runner that dies closes it too), or
// after two minutes. It prints {"port"} once it listens, or {"error"} and ends.
const STAND_IN = `
const fs = require("node:fs"), net = require("node:net");
const [log, at] = process.argv.slice(1);
const note = (what) => fs.appendFileSync(log, process.pid + " " + what + "\\n");
for (const s of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT", "SIGUSR2"]) process.on(s, () => note(s));
const server = net.createServer((c) => { note("connection"); c.destroy(); });
server.on("error", (e) => { process.stdout.write(JSON.stringify({ error: e.message }) + "\\n"); process.exit(1); });
server.listen(at === "tcp" ? { port: 0, host: "127.0.0.1" } : { path: at }, () => process.stdout.write(JSON.stringify({ port: server.address().port ?? null }) + "\\n"));
process.stdin.on("end", () => process.exit(0)).resume();
setTimeout(() => process.exit(0), 120_000);
`;

/** Start a stand-in (STAND_IN) that listens at `at` ("tcp" or a socket path); `children` gets it at once, so the caller can end it. */
function standIn(children: ChildProcess[], log: string, at: string): Promise<number | null> {
  const child = spawn(process.execPath, ["-e", STAND_IN, log, at], { stdio: ["pipe", "pipe", "ignore"] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = "";
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`the stand-in on ${at} ended (exit ${code}) before it listened: ${out}`)));
    child.stdout!.on("data", (d) => {
      out += d;
      if (!out.includes("\n")) return;
      const info = JSON.parse(out.split("\n")[0]);
      if (info.error) reject(new Error(`the stand-in cannot listen on ${at}: ${info.error}`));
      else resolve(info.port);
    });
  });
}

/** End a stand-in: close its stdin and wait for its exit. */
function endStandIn(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => { child.once("exit", () => resolve()); child.stdin!.end(); });
}

test("the CLI: `chromes` needs no --state-dir, prints one JSON document or the human list, and connects to nothing and signals nothing", { timeout: 60_000 }, async () => {
  const children: ChildProcess[] = [];
  try {
    const M = folder("cli-m"), log = join(tmp, "stand-ins.log");
    // The stand-in Chrome owns the debugging port that its profile's DevToolsActivePort names, and the
    // stand-in proxy owns the state folder's socket, so a listing that probed either (agentEndpoint,
    // socketAlive) would reach one of them and show in the log.
    const port = await standIn(children, log, "tcp");
    await standIn(children, log, join(M, "chrome-proxy.sock"));
    const [chrome, proxy] = children;
    const upstream = `ws://127.0.0.1:${port}/devtools/browser/m`;
    writeFileSync(join(M, "profile", "DevToolsActivePort"), `${port}\n/devtools/browser/m`);
    writeFileSync(join(M, "chrome-proxy.json"), JSON.stringify({ pid: proxy.pid, upstream }));
    const rows = (list: [number, number, string][]) => {
      // `ps ... -o uid=,pid=,command=` gets the uid column; any other call (agentChromePid's) gets pid and command.
      writeFileSync(join(tmp, "ps-uid.txt"), list.map(([uid, pid, command]) => linux(uid, pid, command)).join("\n") + "\n");
      writeFileSync(join(tmp, "ps.txt"), list.map(([, pid, command]) => `${String(pid).padStart(7)} ${command}`).join("\n") + "\n");
    };
    rows([
      [0, 1, "/sbin/init"],
      [UID, chrome.pid!, `/opt/google/chrome/chrome ${SIG} --user-data-dir=${M}/profile --window-name=agent-browser: ${M} ${INSPECT}`],
      [UID, proxy.pid!, proxyCommand(process.execPath, "/opt/agent-browser/bin/agent-browser.js", upstream, { stateDir: M, profile: `${M}/profile`, commandName: "agent-browser" })],
    ]);
    // A stand-in `ps` first on PATH: the CLI reads these rows, not this machine's processes.
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "ps"), `#!/bin/sh\ncase "$*" in\n  *uid=*) cat '${join(tmp, "ps-uid.txt")}' ;;\n  *) cat '${join(tmp, "ps.txt")}' ;;\nesac\n`);
    chmodSync(join(bin, "ps"), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };

    const r = await cli(["chromes", "--json"], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json, { ok: true, command: "chromes", chromes: [
      { pid: chrome.pid, profileDir: `${M}/profile`, stateDir: M, windowName: `agent-browser: ${M}`, commandName: "agent-browser", proxy: { pid: proxy.pid, upstream } },
    ] });
    const h = await cli(["chromes"], { env });
    assert.equal(h.status, 0, h.stderr);
    assert.equal(h.stdout, [
      `pid ${chrome.pid}  agent-browser  approved proxy up (pid ${proxy.pid})`,
      `  state folder  ${M}`,
      `  profile       ${M}/profile`,
      `  window        ${JSON.stringify(`agent-browser: ${M}`)}`,
      "",
    ].join("\n"));

    assert.equal(existsSync(log) ? readFileSync(log, "utf8") : "", "", "no connection and no signal reached the stand-in Chrome or proxy");
    for (const c of [chrome, proxy]) assert.ok(c.exitCode === null && c.signalCode === null, `pid ${c.pid} still runs`);

    rows([[0, 1, "/sbin/init"]]);
    const none = await cli(["chromes"], { env });
    assert.equal(none.stdout, "no agent-browser Chrome of this user is running\n");
    assert.deepEqual((await cli(["chromes", "--json"], { env })).json, { ok: true, command: "chromes", chromes: [] });
  } finally {
    await Promise.all(children.map(endStandIn));
  }
});
