// The agent browser's Chrome flags and the guard on a caller's Chrome switches (src/agent.ts), which the service's Chrome
// unit uses (src/service/unit/), and the process helpers of the library. Chrome is never started here. Board ab-v16.9.3 removed the agent Chrome that
// agent-browser started itself (launch, the chrome://inspect seeding, the process look-ups) and its tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_ARGS, appBundle, assertSafeChromeArgs, CHROME_STABLE_BIN, hasUserDataDir, parsePs, processTree } from "../src/agent.ts";
import { UsageError } from "../src/errors.ts";

test("the agent Chrome starts without the two timer flags, so a hidden tab's timers run as in the operator's Chrome, and keeps a window behind others visible (ab-v16.13)", () => {
  assert.deepEqual(AGENT_ARGS, ["--no-first-run", "--no-default-browser-check", "--disable-backgrounding-occluded-windows"]);
  assert.equal(appBundle(CHROME_STABLE_BIN), "/Applications/Google Chrome.app");
  assert.equal(appBundle("/usr/bin/chromium"), undefined);
});

// Every form of a switch name that Chrome's parser reads as that switch (one argv element; whitespace
// trimmed; "--" or "-" as the prefix, "/" on Windows; the name ends at "="), plus upper and mixed case.
function switchForms(name: string): string[] {
  const mixed = name.replace(/(^|-)([a-z])/g, (_, d: string, c: string) => d + c.toUpperCase());
  return [`--${name}`, `-${name}`, `/${name}`, `--${name.toUpperCase()}`, `-${mixed}`, `--${name}=value`, `-${name}=`,
    ` --${name}`, `\t--${name}=x\n`];
}

const REFUSED: { why: RegExp; names: string[]; extra?: string[] }[] = [
  { why: /navigator\.webdriver/, names: ["remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address",
    "remote-debugging-targets", "remote-debugging-io-pipes", "remote-debugging-something-else", "enable-automation"],
    extra: ["--remote-debugging-port=9222", "--remote-debugging-address=0.0.0.0"] },
  { why: /runs Chrome headless/, names: ["headless"],
    extra: ["--headless=new", "--headless=old", "--headless=chrome", "-headless=new", "--HEADLESS=NEW", "/headless=new", " --headless=new"] },
  { why: /another profile, for example the operator's own/, names: ["user-data-dir", "profile-directory"],
    extra: ["--user-data-dir=/opt/operator/Application Support/Google/Chrome", "--profile-directory=Default", "--profile-directory=Profile 1"] },
];

test("assertSafeChromeArgs refuses every remote-debugging, automation, headless and profile switch, in every dash, slash, case and whitespace form, with or without a value", () => {
  for (const { why, names, extra = [] } of REFUSED) {
    for (const flag of [...names.flatMap(switchForms), ...extra]) {
      assert.throws(() => assertSafeChromeArgs(["--lang=en-US", flag]), (e: unknown) => e instanceof UsageError && why.test(e.message), JSON.stringify(flag));
    }
  }
  // The error names the switch as "--" and its canonical name, never its value (a value can be a path or a secret).
  assert.throws(() => assertSafeChromeArgs(["--user-data-dir=/opt/operator/Application Support/Google/Chrome"]), (e: unknown) =>
    e instanceof UsageError && /^refusing to launch Chrome with --user-data-dir: /.test(e.message) && !e.message.includes("/opt/operator"));
  assert.throws(() => assertSafeChromeArgs([" -Headless=new"]), /: refusing to launch Chrome with --headless: it runs Chrome headless/);
  assert.throws(() => assertSafeChromeArgs(["--profile-directory=Profile 1"]), /the service sets the agent profile itself/);
});

test("a refusal names only '--' and the canonical switch name: nothing after the name in the element (a space, a '/', an '=') reaches the message", () => {
  for (const [flag, shown] of [
    ["--headless /secret/path", "--headless"],
    ["--headless\t/secret/path", "--headless"],
    [" -HEADLESS /secret/path=x", "--headless"],
    ["--headlessSECRET", "--headless"],
    ["--remote-debugging-port /secret/path", "--remote-debugging-port"],
    ["--remote-debugging-port/secret/path", "--remote-debugging-port"],
    ["/Remote-Debugging-Pipe=/secret/path", "--remote-debugging-pipe"],
    ["--enable-automation=/secret/path", "--enable-automation"],
    ["--user-data-dir=/secret/path", "--user-data-dir"],
    ["-Profile-Directory=secret path", "--profile-directory"],
  ]) {
    assert.throws(() => assertSafeChromeArgs([flag]), (e: unknown) => {
      assert.ok(e instanceof UsageError, flag);
      const head = `refusing to launch Chrome with ${shown}: `;
      assert.ok(e.message.startsWith(head), `${JSON.stringify(flag)}: ${e.message}`);
      assert.ok(!/secret/i.test(e.message), `${JSON.stringify(flag)} leaks its value: ${e.message}`);
      return true;
    }, flag);
  }
});

test("assertSafeChromeArgs lets ordinary flags through, and reads one argv element as one switch, as Chrome does", () => {
  assert.doesNotThrow(() => assertSafeChromeArgs([
    ...AGENT_ARGS, "--lang=en-US", "--enable-unsafe-swiftshader", "--window-size=1280,800", "--no-first-run", "chrome://inspect/#remote-debugging",
    // Decided: a switch's value is never inspected. Chrome reads each of these as the switch before the
    // first "=" with the rest as its value, so none of them turns headless mode on or names a profile.
    "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessX/1.0 Chrome/154.0.0.0 Safari/537.36",
    "--lang=en-US --headless", "--lang=en-US --user-data-dir=/other", "--js-flags=--remote-debugging-port=9222",
    "--disable-features=HeadlessMode,UserDataDir",
    // Not a switch at all (no "-" or "/" prefix): Chrome opens these as URLs.
    "https://headless.example.org/", "headless.example.org", "user-data-dir",
    // Near misses: a different switch name.
    "--enable-automation-something", "--user-data-dir-x", "--profile-directory-x", "--no-headless-x",
  ]));
});

test("parsePs reads `ps ax -o pid=,ppid=,command=` and skips lines that are not processes; hasUserDataDir matches a whole folder", () => {
  const rows = parsePs([
    "    1     0 /sbin/launchd",
    "  100     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/p/Application Support/x",
    "",
    "not a process",
  ].join("\n"));
  assert.deepEqual(rows, [
    { pid: 1, ppid: 0, command: "/sbin/launchd" },
    { pid: 100, ppid: 1, command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/p/Application Support/x" },
  ]);
  assert.equal(hasUserDataDir(rows[1].command, "/p/Application Support/x"), true);
  assert.equal(hasUserDataDir(rows[1].command, "/p/Application Support"), false, "a folder that the flag only starts with");
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
