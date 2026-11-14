// After a Mac sleep, the agent Chrome that a person approved by hand reconnects with no new Allow click (approveAfterWake;
// board task ab-b84.32, issue #9). The operator's answer (board item ab-g6b): "Only after a sleep and wake, only for the
// same agent Chrome profile, and only within 12 hours of your own last click. macOS asks once for Accessibility
// permission. Any other prompt still waits for you."
//
// Why it is needed: Chrome closes the approved connection itself 4 ms after macOS sends kIOMessageSystemWillSleep, and its
// approval mode asks again for each new connection (measured 2026-10-30, README "A Mac sleep ends the approval"). So the
// first command after a wake raises a new "Allow remote debugging?" prompt.
//
// What it does: at a new connection with no approved proxy up, the existing macOS approver (approver.ts, osascript) answers
// that prompt only when every condition of wakeApproval holds. Each one that fails leaves the prompt for a person, as
// before. With the setting off (the default), nothing here runs and no file is written.
//
// The hand approval record (HAND_APPROVAL_FILE in the state folder, next to chrome-proxy.json and chrome-proxy.log, mode
// 0600): the agent Chrome's profile (its --user-data-dir) and the time of the last connection that opened with no
// approver, that is, that a person approved. Only such a connection writes it, so an automatic approval never extends
// the 12 hours. It holds no secret.
//
// The sleep sign: `pmset -g log`, macOS's power log, which has a row for each sleep ("Sleep", "Entering Sleep state due
// to ...") and each wake ("Wake", "DarkWake"), with its time; issue #9's measurement read the same rows. The last approved
// connection must have ended with Chrome's close ("Chrome connection closed" in chrome-proxy.log), a sleep must begin
// within SLEEP_AFTER_CLOSE_MS after that end (measured: 5 s), and a wake must follow that sleep before now. A wall-clock
// gap alone cannot tell a sleep from an idle hour, and sysctl's kern.sleeptime holds only the latest sleep, not the one
// that followed the end.

import { execFile } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { agentChromePid } from "./agent.ts";
import { makeApprover, type ApproverDeps, type RunResult } from "./approver.ts";
import { recentProxyRows, type ProxyAttempt } from "./diagnostics.ts";
import { statePath, type Settings } from "./options.ts";

/** How long after the last approval by hand the approver may answer a prompt after a sleep (the operator's choice). */
export const WAKE_APPROVAL_MS = 12 * 60 * 60 * 1000;
/** The latest start of the sleep after Chrome's close: measured 5 s on 2026-10-30; macOS waits up to 30 s for a slow sleep notice. */
export const SLEEP_AFTER_CLOSE_MS = 60_000;
/** pmset's log has whole seconds: a row's time is up to 1 s before the event. */
const PMSET_SECOND_MS = 1_000;
const PMSET_TIMEOUT_MS = 15_000;
export const HAND_APPROVAL_FILE = "hand-approval.json";
/** The start of the proxy log's detail of a yes (the parent-wake row). */
export const WAKE_YES = "approve after wake: yes";

export type HandApproval = { profile: string; at: string };
export type PowerEvent = { at: number; kind: "sleep" | "wake"; text: string };
export type WakeDecision = { ok: true; pid: number; detail: string } | { ok: false; why: string };

const iso = (ms: number) => new Date(ms).toISOString();

/** The last approval by hand of this state folder, or undefined when none is recorded (or the file is broken). */
export function readHandApproval(s: Settings): HandApproval | undefined {
  try {
    const r = JSON.parse(readFileSync(statePath(s, HAND_APPROVAL_FILE), "utf8"));
    return typeof r?.profile === "string" && typeof r?.at === "string" && Number.isFinite(Date.parse(r.at)) ? { profile: r.profile, at: r.at } : undefined;
  } catch { return undefined; }
}

/** Record that a person approved this connection by hand, now. Written whole (a rename), mode 0600. Never throws. */
export function recordHandApproval(s: Settings, now = Date.now()): HandApproval | undefined {
  const record: HandApproval = { profile: s.profileDir, at: iso(now) };
  try {
    const path = statePath(s, HAND_APPROVAL_FILE), tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, path);
    return record;
  } catch { return undefined; }
}

const PMSET_ROW = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2}) (Sleep|Wake|DarkWake)(?: *\t| {2,})\s*(\S.*)$/;

/**
 * The sleeps and wakes of `pmset -g log`, in its order (oldest first). A row is "<date> <time> <offset> <type> <tab>
 * <message>"; only the types Sleep (an "Entering Sleep state" message), Wake and DarkWake count. "Wake Requests" and
 * "Sleep Service" are other types: their second word follows one space, where a type's column ends with a tab or two spaces.
 */
export function parsePmsetLog(text: string): PowerEvent[] {
  const events: PowerEvent[] = [];
  for (const line of text.split("\n")) {
    const m = PMSET_ROW.exec(line.trimEnd());
    if (!m) continue;
    const at = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
    const kind = m[5] === "Sleep" ? "sleep" : "wake";
    if (!Number.isFinite(at) || !(kind === "sleep" ? /^Entering Sleep state\b/ : /^(?:Dark)?Wake\b/).test(m[6])) continue;
    events.push({ at, kind, text: m[6].slice(0, 120) });
  }
  return events;
}

const pmsetLog = () => new Promise<string>((resolve, reject) => {
  execFile("/usr/bin/pmset", ["-g", "log"], { encoding: "utf8", timeout: PMSET_TIMEOUT_MS, maxBuffer: 256 << 20 }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

export type WakeDeps = {
  now?: () => number;
  hand?: () => HandApproval | undefined;
  /** The proxy log's recent rows, the latest first (recentProxyRows). */
  rows?: () => ProxyAttempt[];
  /** The running agent Chrome of this profile (agentChromePid). */
  pid?: () => number | undefined;
  pmsetLog?: () => Promise<string>;
};

/**
 * May the macOS approver answer the prompt of the connection that is about to open? Yes only when all hold:
 *  1. the same agent Chrome profile: the last approval by hand of this state folder was for s.profileDir, and that
 *     profile's agent Chrome runs (its pid, so the click never goes to another Chrome);
 *  2. a sleep and a wake: the last approved connection ended with Chrome's close, after that approval by hand; a sleep
 *     began within SLEEP_AFTER_CLOSE_MS after the end; a wake followed it before now; and no automatic click was tried
 *     since that end (one try for each sleep: a click that failed leaves the next prompt for a person);
 *  3. within 12 hours: now is at most WAKE_APPROVAL_MS after that approval by hand.
 * Read-only: it writes nothing.
 */
export async function wakeApproval(s: Settings, deps: WakeDeps = {}): Promise<WakeDecision> {
  const no = (why: string): WakeDecision => ({ ok: false, why });
  if (!s.approveAfterWake) return no("the approve-after-wake setting is off");
  if (s.mode !== "agent" || s.endpoint || s.cdpUrl) return no("it is only for the agent Chrome that agent-browser finds by its profile");
  if (s.platform !== "darwin") return no("it acts only on macOS");
  const now = (deps.now ?? Date.now)();
  const hand = (deps.hand ?? (() => readHandApproval(s)))();
  if (!hand) return no("no approval by hand is recorded for this state folder");
  if (hand.profile !== s.profileDir) return no(`the last approval by hand was for another agent Chrome profile (${hand.profile})`);
  const handAt = Date.parse(hand.at), until = handAt + WAKE_APPROVAL_MS;
  if (!(handAt <= now)) return no(`the last approval by hand (${hand.at}) is later than now`);
  if (now > until) return no(`the last approval by hand was at ${hand.at}, more than 12 hours ago`);
  const rows = (deps.rows ?? (() => recentProxyRows(s)))();
  const endIndex = rows.findIndex((r) => r.phase === "child-exit"), end = rows[endIndex];
  if (!end) return no("no end of an approved connection is recorded");
  const endAt = Date.parse(end.at);
  if (!/^Chrome connection closed\b/.test(end.detail ?? "")) return no(`the last approved connection ended with ${end.detail ?? "no recorded reason"}, not with Chrome's close`);
  if (!(endAt >= handAt)) return no(`the last recorded end (${end.at}) came before the last approval by hand (${hand.at})`);
  if (rows.slice(0, endIndex).some((r) => r.phase === "parent-wake" && r.detail?.startsWith(WAKE_YES)))
    return no(`an automatic click after the end at ${end.at} was already tried`);
  const pid = (deps.pid ?? (() => agentChromePid(s)))();
  if (!pid) return no("the agent Chrome of this profile does not run");
  let events: PowerEvent[];
  try { events = parsePmsetLog(await (deps.pmsetLog ?? pmsetLog)()); }
  catch (e) { return no(`pmset -g log failed: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`); }
  const sleepIndex = events.findIndex((e) => e.kind === "sleep" && e.at + PMSET_SECOND_MS > endAt && e.at <= endAt + SLEEP_AFTER_CLOSE_MS);
  if (sleepIndex < 0) return no(`pmset's log shows no sleep within 60 s after the end at ${end.at}`);
  const sleep = events[sleepIndex];
  const wake = events.slice(sleepIndex + 1).find((e) => e.kind === "wake" && e.at <= now + PMSET_SECOND_MS);
  if (!wake) return no(`pmset's log shows no wake after the sleep at ${iso(sleep.at)}`);
  return {
    ok: true, pid,
    detail: `the approved connection ended at ${end.at}, the Mac slept at ${iso(sleep.at)} and woke at ${iso(wake.at)}; the last approval by hand at ${hand.at} for this profile lets the approver answer until ${iso(until)}; agent Chrome pid ${pid}`,
  };
}

/**
 * The proxy child's approver after a yes: the macOS osascript approver, on the pid that the decision found, and only while
 * this profile's agent Chrome still has that pid (so the click never goes to another Chrome, or by the process name).
 */
export function makeWakeApprover(s: Settings, pid: number, deps: ApproverDeps & { currentPid?: () => number | undefined } = {}):
  { approve: () => Promise<RunResult> } | { why: string } {
  const current = (deps.currentPid ?? (() => agentChromePid(s)))();
  if (current !== pid) return { why: current ? `the agent Chrome of this profile is now pid ${current}, not pid ${pid}` : `the agent Chrome pid ${pid} of this profile no longer runs` };
  const approve = makeApprover({ ...s, approve: "osascript" }, { ...deps, pid, platform: "darwin" });
  return approve ? { approve } : { why: "no macOS approver for this browser" };
}

/** The status clause: the setting, the last approval by hand, and when the approver's 12 hours end. */
export function wakeStatus(s: Settings, now = Date.now()): string {
  const hand = readHandApproval(s);
  if (!hand || hand.profile !== s.profileDir) return "approve after wake: on; no approval by hand is recorded for this agent Chrome profile, so a person clicks Allow";
  const until = Date.parse(hand.at) + WAKE_APPROVAL_MS;
  return now > until
    ? `approve after wake: on; the last approval by hand was at ${hand.at}; its 12 hours ended at ${iso(until)}; a person clicks Allow`
    : `approve after wake: on; the last approval by hand was at ${hand.at}; after a Mac sleep the approver answers until ${iso(until)}`;
}
