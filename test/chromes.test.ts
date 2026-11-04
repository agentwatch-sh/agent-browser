// The machine-wide listing (`chromes`, #3): crafted `ps` rows of Linux (procps) and macOS (BSD ps),
// and made-up state folders in the temp folder. Nothing here starts a Chrome; the CLI test proves that
// the listing connects to nothing and signals nothing.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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

/** A process that only waits and writes down each signal that it gets: it stands in for a Chrome or a proxy. */
function idle(log: string): ChildProcess {
  const code = `for (const s of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT", "SIGUSR2"]) process.on(s, () => require("node:fs").appendFileSync(${JSON.stringify(log)}, s + "\\n"));
setInterval(() => {}, 60_000);`;
  return spawn(process.execPath, ["-e", code], { stdio: "ignore" });
}

test("the CLI: `chromes` needs no --state-dir, prints one JSON document or the human list, and connects to nothing and signals nothing", async () => {
  const M = folder("cli-m");
  const signals = join(tmp, "signals.log");
  const chrome = idle(signals), proxy = idle(signals);
  // A debugging port in the profile and the proxy's socket: a listing that connected to either would show here.
  let connections = 0;
  const port = createServer(() => { connections++; }), sock = createServer(() => { connections++; });
  await new Promise<void>((r) => port.listen(0, "127.0.0.1", () => r()));
  await new Promise<void>((r) => sock.listen(join(M, "chrome-proxy.sock"), () => r()));
  try {
    const upstream = `ws://127.0.0.1:${(port.address() as { port: number }).port}/devtools/browser/m`;
    writeFileSync(join(M, "profile", "DevToolsActivePort"), `${(port.address() as { port: number }).port}\n/devtools/browser/m`);
    writeFileSync(join(M, "chrome-proxy.json"), JSON.stringify({ pid: proxy.pid, upstream }));
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(tmp, "ps.txt"), [
      linux(0, 1, "/sbin/init"),
      linux(UID, chrome.pid!, `/opt/google/chrome/chrome ${SIG} --user-data-dir=${M}/profile --window-name=agent-browser: ${M} ${INSPECT}`),
      linux(UID, proxy.pid!, proxyCommand(process.execPath, "/opt/agent-browser/bin/agent-browser.js", upstream, { stateDir: M, profile: `${M}/profile`, commandName: "agent-browser" })),
    ].join("\n") + "\n");
    // A stand-in `ps` first on PATH: the CLI reads these rows, not this machine's processes.
    writeFileSync(join(bin, "ps"), `#!/bin/sh\ncat '${join(tmp, "ps.txt")}'\n`);
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

    assert.equal(connections, 0, "no connection to the debugging port or the proxy socket");
    assert.equal(existsSync(signals), false, "no signal reached the Chrome or the proxy");
    for (const c of [chrome, proxy]) assert.ok(c.exitCode === null && c.signalCode === null, `pid ${c.pid} still runs`);

    writeFileSync(join(tmp, "ps.txt"), linux(0, 1, "/sbin/init") + "\n");
    const none = await cli(["chromes"], { env });
    assert.equal(none.stdout, "no agent-browser Chrome of this user is running\n");
    assert.deepEqual((await cli(["chromes", "--json"], { env })).json, { ok: true, command: "chromes", chromes: [] });
  } finally {
    // They write down SIGTERM and keep running, so only SIGKILL ends them.
    chrome.kill("SIGKILL");
    proxy.kill("SIGKILL");
    port.close();
    sock.close();
  }
});
