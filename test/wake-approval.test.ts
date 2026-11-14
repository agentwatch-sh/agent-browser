// After a Mac sleep, the agent Chrome that a person approved by hand reconnects with no new Allow click (board task
// ab-b84.32, issue #9; the operator's answer ab-g6b): only after a sleep and a wake, only for the same agent Chrome
// profile, only within 12 hours of the last approval by hand. Each condition has its own fake here, and each one that
// fails keeps the prompt for a person. With the setting off nothing changes. No test runs osascript or pmset: the
// fakes stand in for both, and a proxy child here finds no agent Chrome, so it clicks nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentBrowser } from "../src/browser.ts";
import { ApprovalNeededError } from "../src/errors.ts";
import { commands } from "../src/commands.ts";
import { optionsFromFlags } from "../src/cli.ts";
import { approvalNeededMessage, promptNotice, proxyLogPath, recentProxyRows, recordProxyAttempt, type ProxyAttempt } from "../src/diagnostics.ts";
import { resolveOptions, stateDir, type Settings } from "../src/options.ts";
import { proxyArgs, proxyInfo, runProxy, startProxy, stopProxy } from "../src/proxy.ts";
import { agentChromePid } from "../src/agent.ts";
import { DEBUG_DIALOG_CLICKED, osascriptApproveDebugDialog } from "../src/approver.ts";
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
    hand: () => ({ profile: PROFILE, pid: 4242, at: iso(HAND) }),
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
  assert.equal(d.end, iso(END), "the yes names the end that it is for (startProxy checks it again under the start lock)");
  assert.match(d.detail, new RegExp(`slept at ${iso(SLEEP)} and woke at ${iso(WAKE)}`));
  assert.match(d.detail, new RegExp(`approval by hand at ${iso(HAND)}`));
  assert.match(d.detail, new RegExp(`until ${iso(HAND + 12 * H)}`));
});

test("the same profile and the same Chrome run: no hand approval, another profile, a restarted or ended Chrome, keeps the prompt for a person", async () => {
  const none = await wakeApproval(settings(), scene({ hand: () => undefined }));
  assert.equal(none.ok, false);
  assert.match(!none.ok ? none.why : "", /no approval by hand/);
  const other = await wakeApproval(settings(), scene({ hand: () => ({ profile: "/fixture/other/profile", at: iso(HAND) }) }));
  assert.equal(other.ok, false);
  assert.match(!other.ok ? other.why : "", /another agent Chrome profile/);
  // review-133 B1: the click is for the Chrome run that a person approved, not for any Chrome of the profile.
  const gone = await wakeApproval(settings(), scene({ pid: () => undefined }));
  assert.equal(gone.ok, false, "a quit (then a sleep within 60 s): the approved pid is gone");
  assert.match(!gone.ok ? gone.why : "", /the agent Chrome pid 4242, which a person approved, no longer runs/);
  const restarted = await wakeApproval(settings(), scene({ pid: () => 5151 }));
  assert.equal(restarted.ok, false, "a crash, an update relaunch, a quit and a new start, or a Chrome that an earlier command launched");
  assert.match(!restarted.ok ? restarted.why : "", /now pid 5151, not pid 4242, which a person approved \(a Chrome restart\)/);
  const noPid = await wakeApproval(settings(), scene({ hand: () => ({ profile: PROFILE, at: iso(HAND) }) }));
  assert.equal(noPid.ok, false);
  assert.match(!noPid.ok ? noPid.why : "", /names no agent Chrome pid/);
});

test("within 12 hours of the hand approval: an older one, or one later than now, keeps the prompt for a person", async () => {
  const inside = await wakeApproval(settings(), scene({ now: () => HAND + 12 * H - 60_000, pmsetLog: pmset(SLEEP_AND_WAKE) }));
  assert.equal(inside.ok, true, "a minute before the 12 hours end it still answers");
  const late = await wakeApproval(settings(), scene({ now: () => HAND + 12 * H + 1 }));
  assert.equal(late.ok, false);
  assert.match(!late.ok ? late.why : "", /more than 12 hours ago/);
  const future = await wakeApproval(settings(), scene({ hand: () => ({ profile: PROFILE, pid: 4242, at: iso(NOW + 60_000) }) }));
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
    assert.deepEqual(recordHandApproval(s, HAND), { profile: s.profileDir, at: iso(HAND) }, "no agent Chrome runs here: no pid to record");
    const h = recordHandApproval(s, HAND, 4242) as HandApproval;
    assert.deepEqual(h, { profile: s.profileDir, pid: 4242, at: iso(HAND) });
    const path = join(s.stateDir, HAND_APPROVAL_FILE);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { profile: s.profileDir, pid: 4242, at: iso(HAND) }, "only the profile, the Chrome pid and the time: no secret");
    assert.deepEqual(readHandApproval(s), h);
    writeFileSync(path, "{\"profile\": 3}");
    assert.equal(readHandApproval(s), undefined);
    assert.match(wakeStatus(s, HAND), /approve after wake: on; no approval by hand is recorded/);
    recordHandApproval(s, HAND, 4242);
    assert.match(wakeStatus(s, HAND + H), new RegExp(`approve after wake: on; the last approval by hand was at ${iso(HAND)} for agent Chrome pid 4242; after a Mac sleep the approver answers until ${iso(HAND + WAKE_APPROVAL_MS)}`));
    assert.match(wakeStatus(s, HAND + 13 * H), /12 hours ended at .*; a person clicks Allow/);
  } finally { c.remove(); }
});

test("the wake approver: Allow only in the remote-debugging dialog, on the approved pid, checked again in the child", async () => {
  const calls: { bin: string; args: string[] }[] = [];
  let answer = DEBUG_DIALOG_CLICKED;
  const run = async (bin: string, args: string[]) => { calls.push({ bin, args }); return { ok: true, detail: answer }; };
  const s = settings(), hand = () => ({ profile: PROFILE, pid: 4242, at: iso(HAND) }), now = () => NOW;
  const w = makeWakeApprover(s, 4242, { run, currentPid: () => 4242, hand, now });
  assert.ok("approve" in w);
  assert.deepEqual(await w.approve(), { ok: true, detail: DEBUG_DIALOG_CLICKED });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, "/usr/bin/osascript", "by its full path");
  const script = calls[0].args[1];
  assert.match(script, /first process whose unix id is 4242/);
  assert.doesNotMatch(script, /to activate|process "/, "never by the process name");
  // review-133 B3: the dialog by its own text, never web content, and one Allow button in that dialog's scope only.
  assert.match(script, /contains "remote debugging"/);
  assert.match(script, /"AXWebArea" then return/);
  // review-133b note 1: the scope walk stops at the dialog's window, after the window's own check.
  assert.match(script, /set b to my onlyAllow\(p\)\s+if b is not missing value then return b\s+--[^\n]*\n\s+try\s+if \(role of p\) is "AXWindow" then return missing value/);
  assert.match(script, /if n is 1 then return found/);
  assert.match(script, /return "no remote-debugging dialog found; clicked nothing"/);
  assert.doesNotMatch(script, /Cancel|Turn off/);
  // The match's other answer: the script found no such dialog, so it clicked nothing, and the approval is not done.
  answer = "no remote-debugging dialog found; clicked nothing";
  assert.deepEqual(await w.approve(), { ok: false, detail: answer });
  const cases: [string, Parameters<typeof makeWakeApprover>[2], RegExp][] = [
    ["the pid changed", { run, currentPid: () => 5151, hand, now }, /now pid 5151, not pid 4242/],
    ["the Chrome ended", { run, currentPid: () => undefined, hand, now }, /no longer runs/],
    ["a newer hand approval names another Chrome", { run, currentPid: () => 4242, hand: () => ({ profile: PROFILE, pid: 5151, at: iso(HAND) }), now }, /not for the agent Chrome pid 4242/],
    ["the 12 hours ended while the decision waited", { run, currentPid: () => 4242, hand, now: () => HAND + 12 * H + 1 }, /12 hours .* ended/],
  ];
  for (const [name, deps, why] of cases) {
    const x = makeWakeApprover(s, 4242, deps);
    assert.ok("why" in x, name);
    assert.match(x.why, why, name);
  }
  assert.equal(calls.length, 2, "no click for a pid that changed or ended, another hand approval, or ended 12 hours");
  assert.throws(() => osascriptApproveDebugDialog(0), /not a pid/);
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
  assert.ok(!proxyArgs(resolveOptions({ stateDir: "/tmp/ab-x", noPrompt: true }), "ws://u", "a1", 90_000).includes("--no-prompt"), "off: the child's argv is as before");
  assert.ok(proxyArgs(resolveOptions({ stateDir: "/tmp/ab-x", noPrompt: true, approveAfterWake: true }), "ws://u", "a1", 90_000).includes("--no-prompt"), "on: the child knows noPrompt, for its own check of a yes");
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

/** Write a proxy log row of an approved connection that Chrome closed (a Mac sleep), and give its time: the yes's end. */
function endRow(s: Settings): string {
  recordProxyAttempt(s, { attempt: `end-${Math.random()}`, target: "agent Chrome", upstream: "ws://x", phase: "child-exit", detail: "Chrome connection closed (code 1006)" });
  return recentProxyRows(s).find((r) => r.phase === "child-exit")!.at;
}

/** A stand-in for the agent Chrome of this profile: a process whose command line has its --user-data-dir. */
async function standInChrome(s: Settings) {
  const { spawn } = await import("node:child_process");
  const chrome = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "--", `--user-data-dir=${s.profileDir}`], { stdio: "ignore" });
  for (let i = 0; i < 100 && agentChromePid(s) !== chrome.pid; i++) await new Promise((r) => setTimeout(r, 20));
  return chrome;
}

test("startProxy: a yes spawns the child with the pid to click on, logs the decision, and says so on stderr", async () => {
  const c = consumer(["example.org"]), lines: string[] = [];
  try {
    const s = resolveOptions(c.options({ approveAfterWake: true, log: (l: string) => { lines.push(l); } }));
    stateDir(s);
    let argv: string[] = [];
    const spawn = (_bin: string, args: string[]) => { argv = args; const ch = fakeChild(); setTimeout(() => { ch.exitCode = 1; ch.emit("exit", 1, null); }, 10); return ch as never; };
    const end = endRow(s);
    await assert.rejects(startProxy(s, "ws://127.0.0.1:9/devtools/browser/x", 3_000, { spawn, wake: { ok: true, pid: 4242, end, detail: "the connection ended at X" } }));
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

test("review-133 B2: two commands at once: under the start lock the second sees the first one's try, and gets no click", async () => {
  const c = consumer(["example.org"]);
  try {
    const s = resolveOptions(c.options({ approveAfterWake: true }));
    stateDir(s);
    const spawned: string[][] = [];
    const spawn = (_bin: string, args: string[]) => { spawned.push(args); const ch = fakeChild(); setTimeout(() => { ch.exitCode = 1; ch.emit("exit", 1, null); }, 10); return ch as never; };
    const end = endRow(s);
    // Both commands decided yes before the lock (AgentBrowser.connect); the first one holds the lock and its click fails.
    const yes = { ok: true as const, pid: 4242, end, detail: "the connection ended at X" };
    await assert.rejects(startProxy(s, "ws://127.0.0.1:9/devtools/browser/x", 3_000, { spawn, wake: yes }));
    assert.ok(spawned[0].includes("--wake-approve"));
    await assert.rejects(startProxy(s, "ws://127.0.0.1:9/devtools/browser/x", 3_000, { spawn, wake: yes }));
    assert.ok(!spawned[1].includes("--wake-approve"), "the second command's prompt waits for a person");
    assert.match(readFileSync(proxyLogPath(s), "utf8"), new RegExp(`"phase":"parent-wake","detail":"approve after wake: no, an automatic click after the end at ${end} was already tried; a person clicks Allow"`));
    // With noPrompt the second one is approval_needed and starts nothing.
    const quiet = resolveOptions({ ...s, noPrompt: true });
    await assert.rejects(startProxy(quiet, "ws://127.0.0.1:9/devtools/browser/x", 3_000, { spawn, wake: yes }), (e: unknown) => {
      assert.ok(e instanceof ApprovalNeededError);
      assert.match(e.message, /approve after wake does not answer it \(an automatic click after the end at .* was already tried\)/);
      return true;
    });
    assert.equal(spawned.length, 2, "noPrompt: no child, so no prompt");
    // A yes for an end that is no longer the last one is spent too.
    endRow(s);
    await assert.rejects(startProxy(quiet, "ws://127.0.0.1:9/devtools/browser/x", 3_000, { spawn, wake: yes }), /changed since the decision/);
    assert.equal(spawned.length, 2);
  } finally { c.remove(); }
});

test("noPrompt with approve after wake: a no fails at once; a yes that the child refuses opens no connection; a yes connects; off, the fake is never asked", async () => {
  const fake = await FakeChrome.start();
  const c = consumer(["127.0.0.1"]);
  const gone = async (s: Settings) => { stopProxy(s); for (let i = 0; i < 200 && proxyInfo(s); i++) await new Promise((r) => setTimeout(r, 20)); };
  let chrome: Awaited<ReturnType<typeof standInChrome>> | undefined;
  try {
    const s = resolveOptions(c.options({ approveAfterWake: true, noPrompt: true, noLaunch: false }));
    stateDir(s);
    let launched = 0;
    const launch = async (o: Settings) => { launched++; assert.equal(o.noLaunch, true, "a yes with noPrompt never starts a Chrome"); return fake.ws; };
    await assert.rejects(AgentBrowser.connect(s, { launch, wake: async () => ({ ok: false, why: "no wake after the sleep" }) }), (e: unknown) => {
      assert.ok(e instanceof ApprovalNeededError);
      assert.match(e.message, /approve after wake does not answer it \(no wake after the sleep\)/);
      return true;
    });
    assert.equal(launched, 0, "a no starts nothing");

    // The child's own check: no agent Chrome with pid 4242 runs here, so with noPrompt it opens no connection.
    let end = endRow(s);
    await assert.rejects(AgentBrowser.connect(s, { launch, wake: async () => ({ ok: true, pid: 4242, end, detail: "the connection ended at X" }) }), (e: unknown) => {
      assert.ok(e instanceof ApprovalNeededError, String(e));
      assert.match(e.message, /approve after wake does not answer it \(the agent Chrome pid 4242 of this profile no longer runs\)/);
      return true;
    });
    let log = readFileSync(proxyLogPath(s), "utf8");
    assert.match(log, /"phase":"child-wake-skip","detail":"approve after wake: no click: the agent Chrome pid 4242 of this profile no longer runs; noPrompt opens no connection"/);
    assert.doesNotMatch(log, /"phase":"child-connect"/, "no upstream connection, so no prompt");
    assert.equal(readHandApproval(s), undefined);

    // The approved Chrome runs: the yes connects, and the wake approver (not a person) answered.
    chrome = await standInChrome(s);
    recordHandApproval(s, Date.now() - 60_000, chrome.pid);
    end = endRow(s);
    const b = await AgentBrowser.connect(s, { launch, wake: async () => ({ ok: true, pid: chrome!.pid!, end, detail: "the connection ended at X" }) });
    await b.disconnect();
    log = readFileSync(proxyLogPath(s), "utf8");
    assert.match(log, new RegExp(`"phase":"child-approve","detail":"after a Mac sleep and wake \\(approve after wake\\): answering the remote-debugging dialog of the agent Chrome pid ${chrome.pid}`));
    assert.doesNotMatch(log, /child-hand-approval/, "a machine approval writes no hand approval");
    await gone(s);

    const off = resolveOptions(c.options({ noPrompt: true, noLaunch: false }));
    let asked = 0;
    await assert.rejects(AgentBrowser.connect(off, { launch, wake: async () => { asked++; return { ok: true, pid: 1, end, detail: "x" }; } }), ApprovalNeededError);
    assert.equal(asked, 0, "with the setting off the decision is never made");
  } finally { chrome?.kill("SIGKILL"); await gone(resolveOptions(c.options())); await fake.close(); c.remove(); }
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
  // taylor has no osascript, so the approver's click fails there and clicks nothing; the fake Chrome opens the connection
  // with no prompt.
  const chrome = await standInChrome(s);
  try {
    const hand = recordHandApproval(s, Date.now() - 60_000, chrome.pid);
    await startProxy(s, fake.ws, 10_000, { wake: { ok: true, pid: chrome.pid!, end: endRow(s), detail: "the connection ended at X" } });
    const log = readFileSync(proxyLogPath(s), "utf8");
    assert.match(log, new RegExp(`"phase":"child-approve","detail":"after a Mac sleep and wake \\(approve after wake\\): answering the remote-debugging dialog of the agent Chrome pid ${chrome.pid} for this connection"`));
    assert.doesNotMatch(log, /child-hand-approval|child-wake-skip/);
    assert.deepEqual(readHandApproval(s), hand, "the record is the hand approval's, unchanged");
  } finally {
    stopProxy(s);
    for (let i = 0; i < 200 && proxyInfo(s); i++) await new Promise((r) => setTimeout(r, 20));
    chrome.kill("SIGKILL");
    await fake.close();
    c.remove();
  }
});

test("a person's approval records the approved Chrome's pid (review-133 B1)", async () => {
  const fake = await FakeChrome.start();
  const c = consumer(["127.0.0.1"]);
  const s = resolveOptions(c.options({ approveAfterWake: true }));
  stateDir(s);
  const chrome = await standInChrome(s);
  try {
    await startProxy(s, fake.ws, 10_000);
    assert.match(readFileSync(proxyLogPath(s), "utf8"), /"phase":"child-hand-approval"/);
    assert.equal(readHandApproval(s)?.pid, chrome.pid, "the pid of the Chrome run that the person approved");
  } finally {
    stopProxy(s);
    for (let i = 0; i < 200 && proxyInfo(s); i++) await new Promise((r) => setTimeout(r, 20));
    chrome.kill("SIGKILL");
    await fake.close();
    c.remove();
  }
});

test("review-133 B3: when the child's connection fails (a refusal, a timeout), its approver stops at once", async () => {
  const c = consumer(["example.org"]);
  try {
    const s = resolveOptions(c.options({ approveAfterWake: true }));
    stateDir(s);
    // A port with nothing on it: the upstream connection fails at once.
    const port = await new Promise<number>((resolve) => { const srv = createServer().listen(0, "127.0.0.1", () => { const p = (srv.address() as { port: number }).port; srv.close(() => resolve(p)); }); });
    let script = "", stopped = false;
    const run = (_bin: string, args: string[], _t: number, signal?: AbortSignal) => new Promise<{ ok: boolean; detail: string }>((resolve) => {
      script = args[1];
      // A fake osascript that keeps looking for the dialog until the child stops it.
      signal?.addEventListener("abort", () => { stopped = true; resolve({ ok: false, detail: "stopped" }); });
    });
    const started = Date.now();
    await assert.rejects(runProxy(s, `ws://127.0.0.1:${port}/devtools/browser/x`, {
      wakePid: 4242, wakeDeps: { run, currentPid: () => 4242, hand: () => ({ profile: s.profileDir, pid: 4242, at: new Date().toISOString() }) },
    }));
    for (let i = 0; i < 50 && !stopped; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(stopped, true, "the approver got the stop");
    assert.ok(Date.now() - started < 5_000);
    assert.match(script, /contains "remote debugging"/, "the wake path runs the dialog's own script");
    // runProxy refuses --wake-approve without --approve-after-wake.
    await assert.rejects(runProxy({ ...s, approveAfterWake: false }, `ws://127.0.0.1:${port}/devtools/browser/x`, { wakePid: 4242 }), /--wake-approve needs --approve-after-wake/);
  } finally { c.remove(); }
});
