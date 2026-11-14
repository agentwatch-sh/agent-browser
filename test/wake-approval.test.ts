// After a Mac sleep, the agent Chrome that a person approved by hand reconnects with no new Allow click (board task
// ab-b84.32, issue #9; the operator's answer ab-g6b): only after a sleep and a wake, only for the same agent Chrome
// profile, only within 12 hours of the last approval by hand. Each condition has its own fake here, and each one that
// fails keeps the prompt for a person. With the setting off nothing changes. No test runs osascript or pmset: the
// fakes stand in for both, and a proxy child here finds no agent Chrome, so it clicks nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentBrowser } from "../src/browser.ts";
import { ApprovalNeededError } from "../src/errors.ts";
import { commands } from "../src/commands.ts";
import { optionsFromFlags } from "../src/cli.ts";
import { approvalNeededMessage, promptNotice, proxyLogPath, type ProxyAttempt } from "../src/diagnostics.ts";
import { resolveOptions, stateDir, type Settings } from "../src/options.ts";
import { proxyArgs, proxyInfo, startProxy, stopProxy } from "../src/proxy.ts";
import {
  HAND_APPROVAL_FILE, WAKE_APPROVAL_MS, WAKE_YES, makeWakeApprover, parsePmsetLog, readHandApproval, recordHandApproval, wakeApproval, wakeStatus,
  type HandApproval, type WakeDeps,
} from "../src/wake.ts";
import { FakeChrome } from "./fake-chrome.ts";
import { consumer } from "./helpers.ts";

const H = 60 * 60 * 1000;
const PROFILE = "/fixture/agent/profile";
const settings = (extra: Record<string, unknown> = {}): Settings =>
  resolveOptions({ stateDir: "/tmp/ab-wake-x", profileDir: PROFILE, allow: ["example.org"], approveAfterWake: true, platform: "darwin", log: () => {}, ...extra });

/** A pmset -g log row: the time in whole seconds, the type column padded and a tab, as pmset prints it. */
function pm(at: number, type: string, text: string, offset = "+0000"): string {
  const local = new Date(at + (offset === "+0000" ? 0 : (offset.startsWith("-") ? -1 : 1) * (Number(offset.slice(1, 3)) * H + Number(offset.slice(3)) * 60_000)));
  const stamp = local.toISOString().slice(0, 19).replace("T", " ");
  return `${stamp} ${offset} ${type.padEnd(24)}\t${text}`;
}

// The scene that every condition holds in: a person clicked at 08:00, Chrome closed the connection at a lid close at
// 10:00:00.272, macOS entered sleep 5 s later and woke at 10:40, and the next command runs at 10:41.
const HAND = Date.parse("2026-11-13T08:00:00.000Z");
const END = Date.parse("2026-11-13T10:00:00.272Z");
const SLEEP = Date.parse("2026-11-13T10:00:05.000Z");
const WAKE = Date.parse("2026-11-13T10:40:00.000Z");
const NOW = Date.parse("2026-11-13T10:41:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const pmset = (rows: string[]) => async () => rows.join("\n") + "\n";
const SLEEP_AND_WAKE = [
  pm(END - 30 * 60_000, "Assertions", "PID 1(launchd) Created ..."),
  pm(SLEEP, "Sleep", "Entering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active Using Batt (Charge:80%)"),
  pm(WAKE, "Wake", "Wake from Deep Idle [CDNVA] : due to EC.LidOpen/Lid Open Using BATT (Charge:79%)"),
];

function row(phase: string, at: number, detail?: string): ProxyAttempt {
  return { at: iso(at), attempt: "a", pid: 1, phase, target: "agent Chrome", upstream: "ws://x", approval: "unknown", ...(detail ? { detail } : {}) };
}
const closedAtSleep = [row("child-exit", END, "Chrome connection closed (code 1006)"), row("child-ready", HAND + 1000), row("child-connected", HAND)];

/** Every condition holds; `over` replaces one fake. */
function scene(over: WakeDeps = {}): WakeDeps {
  return {
    now: () => NOW,
    hand: () => ({ profile: PROFILE, at: iso(HAND) }),
    rows: () => closedAtSleep,
    pid: () => 4242,
    pmsetLog: pmset(SLEEP_AND_WAKE),
    ...over,
  };
}

test("all three hold (the same profile, a sleep and a wake after the end, within 12 h of the hand approval): the approver answers", async () => {
  const d = await wakeApproval(settings(), scene());
  assert.equal(d.ok, true, d.ok ? "" : d.why);
  assert.ok(d.ok);
  assert.equal(d.pid, 4242);
  assert.match(d.detail, new RegExp(`slept at ${iso(SLEEP)} and woke at ${iso(WAKE)}`));
  assert.match(d.detail, new RegExp(`approval by hand at ${iso(HAND)}`));
  assert.match(d.detail, new RegExp(`until ${iso(HAND + 12 * H)}`));
});

test("the same profile: no hand approval, or one for another profile, keeps the prompt for a person", async () => {
  const none = await wakeApproval(settings(), scene({ hand: () => undefined }));
  assert.equal(none.ok, false);
  assert.match(!none.ok ? none.why : "", /no approval by hand/);
  const other = await wakeApproval(settings(), scene({ hand: () => ({ profile: "/fixture/other/profile", at: iso(HAND) }) }));
  assert.equal(other.ok, false);
  assert.match(!other.ok ? other.why : "", /another agent Chrome profile/);
  const gone = await wakeApproval(settings(), scene({ pid: () => undefined }));
  assert.equal(gone.ok, false, "with no agent Chrome of this profile running, the approver has no pid to click on");
  assert.match(!gone.ok ? gone.why : "", /does not run/);
});

test("within 12 hours of the hand approval: an older one, or one later than now, keeps the prompt for a person", async () => {
  const inside = await wakeApproval(settings(), scene({ now: () => HAND + 12 * H - 60_000, pmsetLog: pmset(SLEEP_AND_WAKE) }));
  assert.equal(inside.ok, true, "a minute before the 12 hours end it still answers");
  const late = await wakeApproval(settings(), scene({ now: () => HAND + 12 * H + 1 }));
  assert.equal(late.ok, false);
  assert.match(!late.ok ? late.why : "", /more than 12 hours ago/);
  const future = await wakeApproval(settings(), scene({ hand: () => ({ profile: PROFILE, at: iso(NOW + 60_000) }) }));
  assert.equal(future.ok, false);
  assert.match(!future.ok ? future.why : "", /later than now/);
});

test("a machine approval never extends the 12 hours: they count from the hand approval, not from a later automatic one", async () => {
  // A wake approval at 10:41 connects and ends at the next sleep at 19:00; at 20:30 the hand approval of 08:00 is 12.5 h old.
  const rows = [row("child-exit", HAND + 11 * H, "Chrome connection closed (code 1006)"), row("child-approve", NOW, `${WAKE_YES}, ...`), ...closedAtSleep];
  const later = [pm(HAND + 11 * H + 4000, "Sleep", "Entering Sleep state due to 'Clamshell Sleep'"), pm(HAND + 12.4 * H, "Wake", "Wake from Deep Idle")];
  const d = await wakeApproval(settings(), scene({ rows: () => rows, now: () => HAND + 12.5 * H, pmsetLog: pmset(later) }));
  assert.equal(d.ok, false);
  assert.match(!d.ok ? d.why : "", /more than 12 hours ago/);
});

test("a sleep and a wake between the end and now: each missing part keeps the prompt for a person", async () => {
  const cases: [string, WakeDeps, RegExp][] = [
    ["the end was a stop, not Chrome's close", { rows: () => [row("child-exit", END, "SIGTERM"), ...closedAtSleep.slice(1)] }, /ended with SIGTERM, not with Chrome's close/],
    ["the end was the idle timeout", { rows: () => [row("child-exit", END, "idle"), ...closedAtSleep.slice(1)] }, /ended with idle/],
    ["no end is recorded", { rows: () => closedAtSleep.slice(1) }, /no end of an approved connection/],
    ["the end came before the hand approval", { rows: () => [row("child-exit", HAND - 60_000, "Chrome connection closed (code 1006)")] }, /before the last approval by hand/],
    ["no sleep follows the end (a Chrome quit, a sleep an hour later)", { pmsetLog: pmset([pm(END + H, "Sleep", "Entering Sleep state due to 'Idle Sleep'"), pm(END + 2 * H, "Wake", "Wake from Deep Idle")]) }, /no sleep within 60 s after the end/],
    ["a sleep came before the end only", { pmsetLog: pmset([pm(END - 120_000, "Sleep", "Entering Sleep state due to 'Idle Sleep'"), pm(WAKE, "Wake", "Wake from Deep Idle")]) }, /no sleep within 60 s after the end/],
    ["no wake follows the sleep", { pmsetLog: pmset(SLEEP_AND_WAKE.slice(0, 2)) }, /no wake after the sleep/],
    ["the wake is later than now", { now: () => WAKE - 120_000 }, /no wake after the sleep/],
    ["pmset fails (not a Mac, or no log)", { pmsetLog: async () => { throw new Error("spawn /usr/bin/pmset ENOENT"); } }, /pmset -g log failed: spawn \/usr\/bin\/pmset ENOENT/],
    ["an automatic click after this end was already tried", { rows: () => [row("parent-wake", WAKE + 1000, `${WAKE_YES}, ...`), ...closedAtSleep] }, /already tried/],
  ];
  for (const [name, over, why] of cases) {
    const d = await wakeApproval(settings(), scene(over));
    assert.equal(d.ok, false, name);
    assert.match(!d.ok ? d.why : "", why, name);
  }
});

test("only macOS, only the agent Chrome that agent-browser finds by its profile", async () => {
  const linux = await wakeApproval(settings({ platform: "linux" }), scene());
  assert.equal(linux.ok, false);
  assert.match(!linux.ok ? linux.why : "", /only on macOS/);
  const off = await wakeApproval(settings({ approveAfterWake: false }), scene());
  assert.equal(off.ok, false);
  assert.match(!off.ok ? off.why : "", /is off/);
  const base = { stateDir: "/tmp/ab-wake-x", allow: ["example.org"], approveAfterWake: true };
  assert.throws(() => resolveOptions({ ...base, mode: "personal" }), /approveAfterWake is only for the agent browser/);
  assert.throws(() => resolveOptions({ ...base, approve: "osascript" }), /approve or approveAfterWake, not both/);
  assert.throws(() => resolveOptions({ ...base, endpoint: "ws://127.0.0.1:9/devtools/browser/x" }), /approveAfterWake needs the agent Chrome/);
  assert.throws(() => resolveOptions({ ...base, cdpUrl: "ws+unix:///tmp/x.sock:/devtools/browser/s" }), /approveAfterWake is for the proxy/);
  assert.equal(resolveOptions({ stateDir: "/tmp/ab-wake-x" }).approveAfterWake, false, "off by default");
});

test("pmset's log: the Sleep and Wake rows, with their offset; never a Wake Requests or Sleep Service row", () => {
  const events = parsePmsetLog([
    "Time stamp                Domain                Message                                                                Duration  Delay",
    pm(SLEEP, "Sleep", "Entering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active", "-0300"),
    pm(SLEEP + 1000, "Wake Requests", "[*process=mDNSResponder request=Maintenance deltaSecs=7200]"),
    pm(SLEEP + 2000, "Sleep Service", "SleepService: window begins"),
    pm(SLEEP + 3000, "Kernel Client Acks", "Delays to Sleep notifications: [AppleEmbeddedOSSupportHost driver is slow(msg: SystemWillSleep)(1012 ms)]"),
    pm(WAKE - 60_000, "DarkWake", "DarkWake from Deep Idle [CDN] : due to RTC/Maintenance Using BATT", "-0300"),
    pm(WAKE, "Wake", "DarkWake to FullWake from Deep Idle [CDNVA] : due to HID Activity", "+0530"),
    "2026-11-13 11:00:00 +0000 Wake \tWake from Normal Sleep [CDNVA] : due to UserActivity",
    "garbage line",
  ].join("\n"));
  assert.deepEqual(events.map((e) => [e.kind, iso(e.at)]), [["sleep", iso(SLEEP)], ["wake", iso(WAKE - 60_000)], ["wake", iso(WAKE)], ["wake", "2026-11-13T11:00:00.000Z"]]);
});

test("the hand approval record: the profile and the time, mode 0600, in the state folder; a broken file counts as none", () => {
  const c = consumer(["example.org"]);
  try {
    const s = resolveOptions(c.options({ approveAfterWake: true }));
    assert.equal(readHandApproval(s), undefined);
    const h = recordHandApproval(s, HAND) as HandApproval;
    assert.deepEqual(h, { profile: s.profileDir, at: iso(HAND) });
    const path = join(s.stateDir, HAND_APPROVAL_FILE);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { profile: s.profileDir, at: iso(HAND) }, "only the profile and the time: no secret");
    assert.deepEqual(readHandApproval(s), h);
    writeFileSync(path, "{\"profile\": 3}");
    assert.equal(readHandApproval(s), undefined);
    assert.match(wakeStatus(s, HAND), /approve after wake: on; no approval by hand is recorded/);
    recordHandApproval(s, HAND);
    assert.match(wakeStatus(s, HAND + H), new RegExp(`approve after wake: on; the last approval by hand was at ${iso(HAND)}; after a Mac sleep the approver answers until ${iso(HAND + WAKE_APPROVAL_MS)}`));
    assert.match(wakeStatus(s, HAND + 13 * H), /12 hours ended at .*; a person clicks Allow/);
  } finally { c.remove(); }
});

test("the wake approver clicks Allow with osascript on the decided pid only, and never by the process name", async () => {
  const calls: { bin: string; args: string[] }[] = [];
  const run = async (bin: string, args: string[]) => { calls.push({ bin, args }); return { ok: true, detail: "clicked Allow" }; };
  const s = settings();
  const w = makeWakeApprover(s, 4242, { run, currentPid: () => 4242, chromeBin: "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta" });
  assert.ok("approve" in w);
  await w.approve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, "osascript");
  assert.match(calls[0].args[1], /unix id is 4242/);
  assert.doesNotMatch(calls[0].args[1], /to activate/);
  const moved = makeWakeApprover(s, 4242, { run, currentPid: () => 5151 });
  assert.ok("why" in moved);
  assert.match(moved.why, /now pid 5151, not pid 4242/);
  const gone = makeWakeApprover(s, 4242, { run, currentPid: () => undefined });
  assert.ok("why" in gone);
  assert.match(gone.why, /no longer runs/);
  assert.equal(calls.length, 1, "no click for a pid that changed or ended");
});

test("the setting carries to the proxy child as a CLI flag; off, the argv is as before", () => {
  const parse = (flags: string[]) => optionsFromFlags(Object.fromEntries(flags.map((f, i, a) => f.startsWith("--") ? [f.slice(2), a[i + 1]?.startsWith("--") || a[i + 1] === undefined ? true : a[i + 1]] : [null, null]).filter(([k]) => k)) as Record<string, string | boolean>, () => {});
  assert.equal(parse(["--state-dir", "/tmp/ab-x", "--approve-after-wake"]).approveAfterWake, true);
  assert.equal(parse(["--state-dir", "/tmp/ab-x"]).approveAfterWake, false);
  const off = resolveOptions({ stateDir: "/tmp/ab-x" }), on = resolveOptions({ stateDir: "/tmp/ab-x", approveAfterWake: true });
  const argv = proxyArgs(off, "ws://u", "a1", 90_000);
  assert.ok(!argv.includes("--approve-after-wake") && !argv.includes("--wake-approve"), "off: no new flag");
  assert.deepEqual(proxyArgs(on, "ws://u", "a1", 90_000).filter((a) => a.startsWith("--") && a.includes("wake")), ["--approve-after-wake"]);
  const yes = proxyArgs(on, "ws://u", "a1", 90_000, 4242);
  assert.equal(yes[yes.indexOf("--wake-approve") + 1], "4242");
});

test("the stderr notice and the noPrompt error say what approve after wake does, and why not", () => {
  const s = settings({ platform: "linux" });
  const yes = promptNotice(s, "agent Chrome", 90_000, "darwin", { ok: true, pid: 4242, detail: "the connection ended at X" });
  assert.match(yes, /Chrome holds it until the approve-after-wake setting answers its "Allow remote debugging\?" prompt/);
  assert.match(yes, /approve after wake answers it: the connection ended at X/);
  assert.doesNotMatch(yes, /front/, "no person needs to bring the window to the front");
  const no = promptNotice(s, "agent Chrome", 90_000, "darwin", { ok: false, why: "no wake after the sleep" });
  assert.match(no, /until a person clicks Allow on its/);
  assert.match(no, /approve after wake does not answer it: no wake after the sleep/);
  assert.match(approvalNeededMessage(s, "agent Chrome", { ok: false, why: "no wake after the sleep" }), /; approve after wake does not answer it \(no wake after the sleep\)\. noPrompt/);
  const plain = resolveOptions({ stateDir: "/tmp/ab-wake-x", allow: ["example.org"], log: () => {} });
  assert.equal(promptNotice(plain, "t", 90_000, "linux"), promptNotice(plain, "t", 90_000, "linux", undefined), "off: the notice is as before");
  assert.doesNotMatch(promptNotice(plain, "t", 90_000, "linux") + approvalNeededMessage(plain, "t"), /after wake/);
});

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 424242, exitCode: null as number | null, signalCode: null as string | null,
    unref() {}, kill(signal: string) { child.signalCode = signal; child.emit("exit", null, signal); return true; },
  });
  return child;
}

test("startProxy: a yes spawns the child with the pid to click on, logs the decision, and says so on stderr", async () => {
  const c = consumer(["example.org"]), lines: string[] = [];
  try {
    const s = resolveOptions(c.options({ approveAfterWake: true, log: (l: string) => { lines.push(l); } }));
    stateDir(s);
    let argv: string[] = [];
    const spawn = (_bin: string, args: string[]) => { argv = args; const ch = fakeChild(); setTimeout(() => { ch.exitCode = 1; ch.emit("exit", 1, null); }, 10); return ch as never; };
    await assert.rejects(startProxy(s, "ws://127.0.0.1:9/devtools/browser/x", 3_000, { spawn, wake: { ok: true, pid: 4242, detail: "the connection ended at X" } }));
    assert.equal(argv[argv.indexOf("--wake-approve") + 1], "4242");
    assert.ok(argv.includes("--approve-after-wake"));
    assert.match(lines.join("\n"), /approve-after-wake setting answers/);
    const log = readFileSync(proxyLogPath(s), "utf8");
    assert.match(log, /"phase":"parent-wake","detail":"approve after wake: yes, the connection ended at X"/);

    argv = []; lines.length = 0;
    await assert.rejects(startProxy(s, "ws://127.0.0.1:9/devtools/browser/x", 3_000, { spawn, wake: { ok: false, why: "no wake after the sleep" } }));
    assert.ok(!argv.includes("--wake-approve"), "a no gives the child no pid: a person clicks");
    assert.match(lines.join("\n"), /a person clicks Allow on its .*approve after wake does not answer it: no wake after the sleep/);
    assert.match(readFileSync(proxyLogPath(s), "utf8"), /"phase":"parent-wake","detail":"approve after wake: no, no wake after the sleep; a person clicks Allow"/);
  } finally { c.remove(); }
});

test("noPrompt with approve after wake: a no fails at once (approval_needed, with the reason); a yes connects; off, the fake is never asked", async () => {
  const fake = await FakeChrome.start();
  const c = consumer(["127.0.0.1"]);
  const gone = async (s: Settings) => { stopProxy(s); for (let i = 0; i < 200 && proxyInfo(s); i++) await new Promise((r) => setTimeout(r, 20)); };
  try {
    const s = resolveOptions(c.options({ approveAfterWake: true, noPrompt: true, noLaunch: false }));
    stateDir(s);
    let launched = 0;
    const launch = async () => { launched++; return fake.ws; };
    await assert.rejects(AgentBrowser.connect(s, { launch, wake: async () => ({ ok: false, why: "no wake after the sleep" }) }), (e: unknown) => {
      assert.ok(e instanceof ApprovalNeededError);
      assert.match(e.message, /approve after wake does not answer it \(no wake after the sleep\)/);
      return true;
    });
    assert.equal(launched, 0, "a no starts nothing");

    const b = await AgentBrowser.connect(s, { launch, wake: async () => ({ ok: true, pid: 4242, detail: "the connection ended at X" }) });
    await b.disconnect();
    assert.equal(launched, 1);
    const log = readFileSync(proxyLogPath(s), "utf8");
    assert.match(log, /"phase":"parent-wake","detail":"approve after wake: yes, the connection ended at X"/);
    // This child finds no agent Chrome with pid 4242 (none runs here), so it clicks nothing: a person approved it.
    assert.match(log, /"phase":"child-wake-skip","detail":"approve after wake: no click: the agent Chrome pid 4242 of this profile no longer runs; a person clicks Allow"/);
    assert.match(log, /"phase":"child-hand-approval"/);
    assert.equal(readHandApproval(s)?.profile, s.profileDir);
    await gone(s);

    const off = resolveOptions(c.options({ noPrompt: true, noLaunch: false }));
    let asked = 0;
    await assert.rejects(AgentBrowser.connect(off, { launch, wake: async () => { asked++; return { ok: true, pid: 1, detail: "x" }; } }), ApprovalNeededError);
    assert.equal(asked, 0, "with the setting off the decision is never made");
  } finally { await gone(resolveOptions(c.options())); await fake.close(); c.remove(); }
});

test("the setting off changes nothing: no record, no wake rows, the same status", async () => {
  const fake = await FakeChrome.start();
  const c = consumer(["127.0.0.1"]);
  try {
    const s = resolveOptions(c.options());
    stateDir(s);
    await startProxy(s, fake.ws, 10_000);
    assert.equal(existsSync(join(s.stateDir, HAND_APPROVAL_FILE)), false, "a hand approval is recorded only with the setting on");
    assert.doesNotMatch(readFileSync(proxyLogPath(s), "utf8"), /wake|hand-approval/);
    stopProxy(s);
    for (let i = 0; i < 200 && proxyInfo(s); i++) await new Promise((r) => setTimeout(r, 20));
    const status = await commands.status(s);
    assert.doesNotMatch(status.detail ?? "", /after wake/);
    const on = await commands.status({ ...s, approveAfterWake: true });
    assert.match(on.detail ?? "", /; approve after wake: on; no approval by hand is recorded/);
  } finally { stopProxy(resolveOptions(c.options())); await fake.close(); c.remove(); }
});

test("a connection that the wake approver answered writes no hand approval: a machine approval never extends the 12 hours", async () => {
  const fake = await FakeChrome.start();
  const c = consumer(["127.0.0.1"]);
  const s = resolveOptions(c.options({ approveAfterWake: true }));
  stateDir(s);
  // A stand-in for the agent Chrome of this profile: a process whose command line has its --user-data-dir. taylor has no
  // osascript, so the approver's click fails there and clicks nothing; the fake Chrome opens the connection with no prompt.
  const { spawn } = await import("node:child_process");
  const chrome = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "--", `--user-data-dir=${s.profileDir}`], { stdio: "ignore" });
  try {
    for (let i = 0; i < 100 && !(await import("../src/agent.ts")).agentChromePid(s); i++) await new Promise((r) => setTimeout(r, 20));
    await startProxy(s, fake.ws, 10_000, { wake: { ok: true, pid: chrome.pid!, detail: "the connection ended at X" } });
    const log = readFileSync(proxyLogPath(s), "utf8");
    assert.match(log, new RegExp(`"phase":"child-approve","detail":"after a Mac sleep and wake \\(approve after wake\\): answering the remote-debugging dialog of the agent Chrome pid ${chrome.pid} for this connection"`));
    assert.doesNotMatch(log, /child-hand-approval|child-wake-skip/);
    assert.equal(existsSync(join(s.stateDir, HAND_APPROVAL_FILE)), false);
  } finally {
    stopProxy(s);
    for (let i = 0; i < 200 && proxyInfo(s); i++) await new Promise((r) => setTimeout(r, 20));
    chrome.kill("SIGKILL");
    await fake.close();
    c.remove();
  }
});
