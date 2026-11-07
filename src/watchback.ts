// The give-back watcher of the Mac (board task ab-v16.27; the operator's answer ab-or9, 2026-11-06: "Give the front
// back at once"). On the Mac an agent page gets a window of its own (options.ts, macWindows), and Chrome can still make
// the agent Chrome the front app by itself: a site's popup did on 2026-11-05 (5 to 25 ms until the check gave the
// front back), and so does the start (src/giveback.ts guards the start only). While the agent Chrome is the front app,
// the operator's keys go to it. So for as long as the agent Chrome runs, this watcher records the operator's front app
// and asks macOS to activate it again each time the agent Chrome takes the front, as the start's guard does.
//
// It never fights the operator (the builder note of ab-or9). A take of the front is the operator's own, and the watcher
// leaves the agent Chrome in front until another app comes to the front, when at the take (OWN_MS):
//   click     a mouse button was down less than 1 s before: a click on an agent window, on its Dock icon or in its Dock
//             menu, in Mission Control or App Expose (AppKit's NSEvent.pressedMouseButtons, sampled every 25 ms, and
//             CoreGraphics' time since the last mouse press of the HID system, which a quick tap cannot pass)
//   command   the Command key was down less than 1 s before: Cmd-Tab (NSEvent.modifierFlags, sampled every 25 ms)
//   front     agent-browser's `front` asked for the front (a hold file that `front` writes before its request)
//   approval  a proxy of this state folder waits for Chrome's "Allow remote debugging?" answer (a hold file that the
//             proxy writes for its handshake), so the prompt can stay in front
//   start     no app was recorded yet: the agent Chrome was the front app when the watcher started (a start with no
//             give-back leaves it in front for the approval prompt; `launch --login` starts it in front)
// A click or the Command key during a take that the watcher is giving back makes that take the operator's too: it
// asks no more. Keys alone do not count: a person who types in their own app while a popup takes the front must get
// the front back at once, else their next keys go to the agent Chrome (ab-or9's reason). So a switch to the agent
// Chrome by keys alone, other than Cmd-Tab (Spotlight or a launcher with Return), is given back once; Cmd-Tab, a click
// and `front` reach it.
//
// How it runs. The first agent-browser command on the Mac that finds the agent Chrome with no watcher (`launch` at its
// end, AgentBrowser.connect after the proxy is up: ensureWatchBack) starts `agent-browser give-back-watch`, a detached
// node process (runWatchBack). That process writes give-back-watch.json in the state folder, starts the watcher script
// (osascript, JavaScript for Automation, as the start guard and `front`: no compiled helper, no Apple Event, no System
// Events, no input; whether macOS asks a permission for its reading of the mouse buttons, the Command key and the HID
// time is not measured yet: the Mac check's own watcher reads that HID time with none) and ends when the agent Chrome
// quits: it checks the pid every 250 ms with
// a signal 0 (and every 5 s that ps still shows that pid as the agent Chrome on this profile). On the Mac run of
// 2026-11-06 the prototype's own check (AppKit's isTerminated) missed the quit of a second Google Chrome instance for
// 3.8 s; the signal 0 does not depend on AppKit. The script also looks the agent's pid up again every second. It ends
// when its node process is gone: getppid (only when its first value is that process: review-66b F), and an empty line
// every 250 ms on a pipe that only that process reads (review-66b E: the process keeps reading it).
//
// Log lines go to launches.log in the state folder, "<ISO time> watch-back <what>":
//   watch agent=PID before=PID parent=PID ppid=yes|no input=nsevent+cg|nsevent|cg    it watches (before=0: none yet)
//   took=PID from=PID [own=click|command|front|approval|start]  the agent Chrome took the front (own: left in front)
//   own=click|command after-ms=N     the operator acted during a take that the watcher was giving back: it asks no more
//   asked=PID n=N sent=BOOL          one activation request for the app to give the front back to (3 for one take, 250 ms apart)
//   back=PID after-ms=N asks=N       that app is in front again
//   refused=PID asks=N               the 3 asks are spent: no more until the front leaves the agent Chrome
//   before=PID [after-ms=N]          another app came to the front: the app to give the front back to from then on
//   end=WHY                          the script's end: agent-gone, parent-gone, no-agent, no-input, usage, error
//   end=WHY by=node                  its node process's end: agent-gone, stopped (SIGTERM: `quit`, a test), script-ended
//                                    code=N; "end=another chrome=PID" (a watcher runs for that Chrome already),
//                                    "end=no-agent chrome=PID" (that pid is not the agent Chrome), "end=no-osascript"

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { agentChromeBin, agentChromePid, appBundle, isAgentChromeCommand } from "./agent.ts";
import { withFileLock } from "./lock.ts";
import { macWindows, statePath, underNodeTest, type Settings } from "./options.ts";

export const OSASCRIPT = "/usr/bin/osascript";
/** The record of the running watcher in the state folder: {"pid": its node process, "chrome": the agent Chrome's pid, "at": its last beat (epoch ms)}. */
export const WATCH_FILE = "give-back-watch.json";
/** The hold files: while one holds a time in the future, a take of the front is the operator's own (see the head of this file). */
export const HOLD_FILES = { front: "give-back-hold-front.json", approval: "give-back-hold-approval.json" } as const;
export type HoldKind = keyof typeof HOLD_FILES;
/** How often the node process checks that the agent Chrome runs (a signal 0), and beats its record. */
export const WATCH_POLL_MS = 250;
/** How often it checks with ps that the pid is still the agent Chrome on this profile (a pid can go to another process). */
export const WATCH_PS_MS = 5000;
/** A record whose beat is older than this is a watcher that is gone (its pid can belong to another process now). */
export const WATCH_STALE_MS = 15_000;
/**
 * A watcher that could not watch an agent Chrome (no input reading in JXA, no osascript, a script error): its record of
 * that (give-back-watch-failed.json, the Chrome's pid and why), so that the commands do not start a new one for the same
 * Chrome each time (each start costs a node process and osascript); for another Chrome, or after this time, they do.
 */
export const WATCH_FAILED_FILE = "give-back-watch-failed.json", WATCH_RETRY_MS = 10 * 60_000;

/**
 * The watcher (JXA). argv: the agent's app bundle path, the agent Chrome's pid, the pid of its node process (runWatchBack)
 * and the state folder (for the hold files). Once it watches it prints one JSON line on standard output, {"watch": bool,
 * "before": pid, "bundle": id, "agent": pid, "input": "nsevent+cg"|"nsevent"|"cg"|"none"} (watch false: it ends; before 0:
 * no app to give the front back to yet). Then an empty line every 250 ms. It polls the front app every 25 ms, spinning
 * the run loop as the start guard does, and samples the person's input each poll (see the head of this file).
 */
export const WATCH_BACK_SCRIPT = String.raw`ObjC.import("AppKit");

const POLL_S = 0.025, RETRY_MS = 250, MAX_ASKS = 3, BEAT_POLLS = 10, LOOKUP_POLLS = 40, OWN_MS = 1000, COMMAND = 1048576;
const HOLDS = [["front", "/give-back-hold-front.json"], ["approval", "/give-back-hold-approval.json"]];

// One step of the watcher: from its state, the time, the app in front (null: none for a moment; else its pid, and
// whether it is the agent Chrome), a hold in force at a new take (null, "front" or "approval"), whether the agent
// Chrome has quit and whether the app to give the front back to has quit, the next state and what to do. st.before:
// the app to give the front back to (0: none yet); st.took: when the take in progress began (null: no take); st.own:
// why that take is the operator's (null: the watcher gives it back); st.asks: the asks of that take; st.spent: no more
// asks for it; st.mouseAt, st.commandAt: when a mouse button and the Command key were last seen down.
function step(st, now, front, hold, agentGone, beforeGone) {
  if (agentGone) return { st: st, end: "agent-gone" };
  if (front === null) return { st: st };
  if (front.agent) {
    if (st.took === null) {
      const own = st.before === 0 ? "start" : hold !== null ? hold : now - st.mouseAt <= OWN_MS ? "click" : now - st.commandAt <= OWN_MS ? "command" : null;
      const took = Object.assign({}, st, { took: now, own: own, asks: 0, askedAt: 0, spent: false }), log = "took=" + front.pid + " from=" + st.before;
      if (own !== null) return { st: took, log: log + " own=" + own };
      if (beforeGone) return { st: Object.assign(took, { spent: true }), log: log + " gone=" + st.before };
      return { st: Object.assign(took, { asks: 1, askedAt: now }), log: log, ask: true };
    }
    if (st.own !== null || st.spent) return { st: st };
    // The operator clicked, or held the Command key, during the take: from now on it is theirs.
    const late = st.mouseAt > st.took ? "click" : st.commandAt > st.took ? "command" : null;
    if (late !== null) return { st: Object.assign({}, st, { own: late }), log: "own=" + late + " after-ms=" + (now - st.took) };
    if (now - st.askedAt < RETRY_MS) return { st: st };
    if (st.asks >= MAX_ASKS) return { st: Object.assign({}, st, { spent: true }), log: "refused=" + st.before + " asks=" + st.asks };
    return { st: Object.assign({}, st, { asks: st.asks + 1, askedAt: now }), ask: true };
  }
  if (front.pid === st.before) {
    if (st.took === null) return { st: st };
    return { st: Object.assign({}, st, { took: null, own: null, spent: false }), log: "back=" + st.before + " after-ms=" + (now - st.took) + " asks=" + st.asks };
  }
  // Another app is in front, which the operator (or macOS) chose: from now on it is the app to give the front back to.
  return { st: Object.assign({}, st, { before: front.pid, took: null, own: null, spent: false }), log: "before=" + front.pid + (st.took === null ? "" : " after-ms=" + (now - st.took)) };
}

function run(argv) {
  const err = $.NSFileHandle.fileHandleWithStandardError, out = $.NSFileHandle.fileHandleWithStandardOutput;
  const write = (handle, line) => handle.writeData($(line + "\n").dataUsingEncoding($.NSUTF8StringEncoding));
  const log = (text) => write(err, new Date().toISOString() + " watch-back " + text);
  try {
    if (argv.length !== 4 || !/^\/.*[^\/]\.app$/.test(argv[0]) || !/^[1-9][0-9]{0,6}$/.test(argv[1]) || !/^[1-9][0-9]{0,6}$/.test(argv[2]) || !/^\/[^\n]*$/.test(argv[3])) { log("end=usage"); return; }
    const nil = (o) => o === undefined || o === null || (typeof o.isNil === "function" && o.isNil());
    const text = (o) => { if (nil(o)) return null; const v = ObjC.unwrap(o); return typeof v === "string" ? v : null; };
    const pathOf = (url) => (nil(url) ? null : text(url.URLByStandardizingPath.path));
    const pidOf = (app) => { if (nil(app)) return 0; const pid = app.processIdentifier; return typeof pid === "number" && pid > 0 ? pid : 0; };
    const bundle = pathOf($.NSURL.fileURLWithPath(argv[0]));
    const inBundle = (app) => bundle !== null && !nil(app) && pathOf(app.bundleURL) === bundle;
    const agentPid = Number(argv[1]), parentPid = Number(argv[2]), holdDir = argv[3];
    // The agent Chrome's own AppKit object (its isTerminated), and a look-up again every second: on 2026-11-06 the
    // object of a second Google Chrome instance did not say that it quit.
    const lookUp = () => $.NSRunningApplication.runningApplicationWithProcessIdentifier(agentPid);
    const agent = lookUp();
    // The person's input: AppKit's mouse buttons and Command key now (sampled each poll), and CoreGraphics' time since
    // the HID system's last mouse press (left 1, right 3, other 25), where the bridge has them.
    let ns = false, cg = null;
    try { ns = typeof $.NSEvent.pressedMouseButtons === "number" && typeof $.NSEvent.modifierFlags === "number"; } catch (e) { ns = false; }
    try { ObjC.import("CoreGraphics"); const since = (type) => $.CGEventSourceSecondsSinceLastEventType(1, type); const v = since(1); if (typeof v === "number" && v >= 0) cg = since; } catch (e) { cg = null; }
    const input = ns && cg ? "nsevent+cg" : ns ? "nsevent" : cg ? "cg" : "none";
    const workspace = $.NSWorkspace.sharedWorkspace;
    // The app to give the front back to: its own AppKit object, so an activation goes to that process, never to a pid that another app took over.
    let before = workspace.frontmostApplication;
    let beforePid = pidOf(before);
    if (beforePid === agentPid) { beforePid = 0; before = null; }
    const isAgent = inBundle(agent), watches = isAgent && input !== "none";
    write(out, JSON.stringify({ watch: watches, before: beforePid, bundle: watches && beforePid ? text(before.bundleIdentifier) : null, agent: agentPid, input: input }));
    if (!isAgent) { log("end=no-agent"); return; }
    if (!watches) { log("end=no-input"); return; }
    // Its node process: getppid where JXA can import it (unistd) and its first value is that process; the pipe in any case.
    let ppid = null;
    try { ObjC.import("unistd"); if (typeof $.getppid === "function" && $.getppid() === parentPid) ppid = () => $.getppid(); } catch (e) { ppid = null; }
    log("watch agent=" + agentPid + " before=" + beforePid + " parent=" + parentPid + " ppid=" + (ppid ? "yes" : "no") + " input=" + input);
    const until = (file) => {
      try { const t = text($.NSString.stringWithContentsOfFileEncodingError(holdDir + file, $.NSUTF8StringEncoding, null)); const v = t === null ? null : JSON.parse(t); return v && typeof v.until === "number" ? v.until : 0; } catch (e) { return 0; }
    };
    const holdAt = (now) => { for (let i = 0; i < HOLDS.length; i++) if (now < until(HOLDS[i][1])) return HOLDS[i][0]; return null; };
    let st = { before: beforePid, took: null, own: null, asks: 0, askedAt: 0, spent: false, mouseAt: 0, commandAt: 0 };
    for (let polls = 1; ; polls++) {
      // The run loop delivers AppKit's news of the front app; with no input source it returns at once.
      const spun = Date.now();
      $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(POLL_S));
      const rest = POLL_S - (Date.now() - spun) / 1000;
      if (rest > 0.002) $.NSThread.sleepForTimeInterval(rest);
      if (polls % BEAT_POLLS === 0) {
        // With no reader (the node process is gone) this write ends the watcher: SIGPIPE, or an error (caught below).
        write(out, "");
        if (ppid && ppid() !== parentPid) { log("end=parent-gone"); return; }
      }
      const now = Date.now();
      if (ns) { try { if ($.NSEvent.pressedMouseButtons) st.mouseAt = now; if ($.NSEvent.modifierFlags & COMMAND) st.commandAt = now; } catch (e) { /* the next poll */ } }
      if (cg) { try { const s = Math.min(cg(1), cg(3), cg(25)); if (s >= 0 && s < 86400) st.mouseAt = Math.max(st.mouseAt, now - Math.round(s * 1000)); } catch (e) { /* the next poll */ } }
      let agentGone = nil(agent) || !!agent.isTerminated;
      if (!agentGone && polls % LOOKUP_POLLS === 0) { const a = lookUp(); agentGone = nil(a) || !!a.isTerminated; }
      const app = workspace.frontmostApplication, pid = pidOf(app), isFront = pid === agentPid;
      const hold = isFront && st.took === null && st.before !== 0 ? holdAt(now) : null;
      const r = step(st, now, pid ? { pid: pid, agent: isFront } : null, hold, agentGone, !nil(before) && !!before.isTerminated);
      if (r.st.before !== st.before) before = app;
      st = r.st;
      if (r.log) log(r.log);
      if (r.ask) log("asked=" + st.before + " n=" + st.asks + " sent=" + !!before.activateWithOptions(0));
      if (r.end) { log("end=" + r.end); return; }
    }
  } catch (e) {
    log("end=error " + JSON.stringify(String(e)));
  }
}
`;

/** osascript's argv for the watcher: the constant script, then the bundle, the agent Chrome's pid, its node process's pid and the state folder. */
export function watchBackArgs(bundle: string, agentPid: number, parentPid: number, stateDir: string): string[] {
  if (!/^\/.*[^/]\.app$/.test(bundle) || /[\0\n]/.test(bundle)) throw new Error(`the give-back watcher needs an absolute app bundle path (/X.app): ${JSON.stringify(bundle)}`);
  for (const [what, pid] of [["the agent Chrome's pid", agentPid], ["its node process's pid", parentPid]] as const)
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 9_999_999) throw new Error(`the give-back watcher needs ${what}: ${pid}`);
  if (!stateDir.startsWith("/") || /[\0\n]/.test(stateDir)) throw new Error(`the give-back watcher needs an absolute state folder: ${JSON.stringify(stateDir)}`);
  return ["-l", "JavaScript", "-e", WATCH_BACK_SCRIPT, bundle, String(agentPid), String(parentPid), stateDir];
}

/** The watcher's ready line, or undefined when it is none. */
export function parseWatchReady(line: string): { watch: boolean; before: number; bundle: string | null; agent: number; input: string } | undefined {
  let v: unknown;
  try { v = JSON.parse(line); } catch { return undefined; }
  const o = v as { watch?: unknown; before?: unknown; bundle?: unknown; agent?: unknown; input?: unknown } | null;
  if (!o || typeof o !== "object" || typeof o.watch !== "boolean" || !Number.isSafeInteger(o.before) || (o.before as number) < 0 || !Number.isSafeInteger(o.agent)) return undefined;
  return { watch: o.watch, before: o.before as number, bundle: typeof o.bundle === "string" ? o.bundle : null, agent: o.agent as number, input: typeof o.input === "string" ? o.input : "none" };
}

/** One line of the watcher's log (launches.log): its time (ms since 1970), its text, and its words as keys ("took=1 from=2": { took: "1", from: "2" }). */
export type WatchLine = { t: number; text: string; kv: Record<string, string> };

/** The watcher's lines in a log ("<ISO time> watch-back <what>"); other lines are left out. */
export function parseWatchLines(text: string): WatchLine[] {
  return text.split("\n").flatMap((line) => {
    const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) watch-back (.+)$/.exec(line);
    const t = m ? Date.parse(m[1]) : Number.NaN;
    if (!m || !Number.isFinite(t)) return [];
    const kv: Record<string, string> = {};
    for (const word of m[2].split(" ")) { const i = word.indexOf("="); if (i > 0) kv[word.slice(0, i)] ??= word.slice(i + 1); else if (word) kv[word] ??= ""; }
    return [{ t, text: m[2], kv }];
  });
}

// ---------- the holds ----------

/** Write a hold until `until` (epoch ms): a take of the front before then is the operator's own (front, approval). Never throws. */
export function holdGiveBack(s: Settings, kind: HoldKind, until: number): void {
  try {
    const path = statePath(s, HOLD_FILES[kind]), tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ until, pid: process.pid }), { mode: 0o600 });
    renameSync(tmp, path);
  } catch { /* the watcher then gives such a take back once */ }
}

/** End a hold that this process wrote (another process's hold stays). Never throws. */
export function releaseGiveBack(s: Settings, kind: HoldKind): void {
  try {
    const path = statePath(s, HOLD_FILES[kind]);
    if (JSON.parse(readFileSync(path, "utf8")).pid === process.pid) rmSync(path, { force: true });
  } catch { /* none */ }
}

/**
 * The hold of a proxy's upstream handshake on the Mac (runProxy): Chrome's "Allow remote debugging?" prompt may be in
 * front until the operator answers it, so the watcher takes a take of the front in that time as the operator's. It
 * ends at `timeoutMs` at the latest (a proxy that a kill -9 ended), else at the release that this returns.
 */
export function holdForApproval(s: Settings, timeoutMs: number): () => void {
  if (!macWindows(s)) return () => {};
  holdGiveBack(s, "approval", Date.now() + timeoutMs);
  return () => releaseGiveBack(s, "approval");
}

/** The hold in force now, or null (as the watcher reads it). */
export function holdNow(s: Settings, now = Date.now()): HoldKind | null {
  for (const kind of Object.keys(HOLD_FILES) as HoldKind[]) {
    try { if (now < JSON.parse(readFileSync(statePath(s, HOLD_FILES[kind]), "utf8")).until) return kind; } catch { /* none */ }
  }
  return null;
}

// ---------- the record, and the start from a command ----------

type WatchRecord = { pid: number; chrome: number; at: number };

export function readWatch(s: Settings): WatchRecord | undefined {
  try {
    const r = JSON.parse(readFileSync(statePath(s, WATCH_FILE), "utf8"));
    return Number.isSafeInteger(r?.pid) && Number.isSafeInteger(r?.chrome) && typeof r?.at === "number" ? r : undefined;
  } catch { return undefined; }
}

function writeWatch(s: Settings, r: WatchRecord) {
  const path = statePath(s, WATCH_FILE), tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(r), { mode: 0o600 });
  renameSync(tmp, path);
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

function readFailed(s: Settings): { chrome: number; at: number; why: string } | undefined {
  try {
    const r = JSON.parse(readFileSync(statePath(s, WATCH_FAILED_FILE), "utf8"));
    return Number.isSafeInteger(r?.chrome) && typeof r?.at === "number" ? r : undefined;
  } catch { return undefined; }
}

function writeFailed(s: Settings, chrome: number, why: string) {
  try {
    const path = statePath(s, WATCH_FAILED_FILE), tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ chrome, at: Date.now(), why }), { mode: 0o600 });
    renameSync(tmp, path);
  } catch { /* the next command starts a watcher again */ }
}

/** A watcher runs for this state folder: its record's pid lives and beat less than WATCH_STALE_MS ago. */
export function watchRunning(s: Settings, now = Date.now()): WatchRecord | undefined {
  const r = readWatch(s);
  return r && now - r.at < WATCH_STALE_MS && alive(r.pid) ? r : undefined;
}

/** The CLI entry that the watcher's node process runs from (as the proxy's). */
const BIN_PATH = new URL("../bin/agent-browser.js", import.meta.url).pathname;

/** The argv of the watcher's node process for this consumer and agent Chrome. */
export function watchProcessArgs(s: Settings, chromePid: number): string[] {
  return [BIN_PATH, "give-back-watch", "--state-dir", s.stateDir, "--profile", s.profileDir, "--chrome-pid", String(chromePid), "--command-name", s.commandName,
    ...(s.chromeBin ? ["--chrome-bin", s.chromeBin] : []), ...(s.watchBackCommand ? ["--watch-back-command", JSON.stringify(s.watchBackCommand)] : [])];
}

type SpawnLike = (bin: string, args: string[], opts: object) => Pick<ChildProcess, "pid" | "unref" | "once">;

/**
 * Make sure the give-back watcher runs for the agent Chrome of this consumer (the Mac's design, macWindows): when no
 * watcher runs (watchRunning), find the agent Chrome on this profile (ps) and start the watcher's node process,
 * detached (it outlives this command). Never throws, and never waits for the watcher. What it did: "off" (not the Mac's
 * design; or under node --test with no stand-in: no test starts osascript), "running", "no-chrome" (no agent Chrome of
 * this profile: an endpoint that another program started), "started", "failed".
 */
export async function ensureWatchBack(s: Settings, deps: { spawn?: SpawnLike; pid?: () => number | undefined } = {}): Promise<"off" | "running" | "no-chrome" | "started" | "failed"> {
  if (!macWindows(s) || s.stopped?.()) return "off";
  if (!s.watchBackCommand && (underNodeTest() || process.platform !== "darwin")) return "off";
  try {
    if (watchRunning(s)) return "running";
    return await withFileLock(statePath(s, "give-back-watch.lock"), Date.now() + 2000, async () => {
      // The stop again: it can come while this waits for the lock (review-69d note 2).
      if (s.stopped?.()) return "off" as const;
      if (watchRunning(s)) return "running" as const;
      const chromePid = (deps.pid ?? (() => agentChromePid(s)))();
      if (!chromePid) return "no-chrome" as const;
      const failed = readFailed(s);
      if (failed && failed.chrome === chromePid && Date.now() - failed.at < WATCH_RETRY_MS) return "failed" as const;
      const fd = openSync(statePath(s, "launches.log"), "a");
      try {
        const child = (deps.spawn ?? (spawn as unknown as SpawnLike))(process.execPath, watchProcessArgs(s, chromePid), { detached: true, stdio: ["ignore", "ignore", fd] });
        child.once("error", () => {});
        child.unref();
        // The record at once, so that the next command does not start a second one; the watcher writes its own.
        if (child.pid) writeWatch(s, { pid: child.pid, chrome: chromePid, at: Date.now() });
      } finally { closeSync(fd); }
      return "started" as const;
    }, "the give-back watcher's start lock");
  } catch { return "failed"; }
}

/**
 * Stop this consumer's watcher (`quit`): SIGTERM to the pid of its record, only when ps shows that pid as this state
 * folder's watcher. True when it sent the signal.
 */
export function stopWatchBack(s: Settings, command = (p: number) => execFileSync("ps", ["-ww", "-o", "command=", "-p", String(p)], { encoding: "utf8" })): boolean {
  const r = readWatch(s);
  if (!r) return false;
  try {
    const line = ` ${command(r.pid).trim()} `;
    if (!/\/bin\/agent-browser\.js give-back-watch /.test(line) || !line.includes(` --state-dir ${s.stateDir} `)) return false;
    process.kill(r.pid, "SIGTERM");
    return true;
  } catch { return false; }
}

// ---------- the watcher's node process ----------

export type WatchDeps = {
  /** The agent Chrome runs (default: a signal 0 to its pid). */
  alive?: (pid: number) => boolean;
  /** ps's command line of a pid, or undefined (default: ps -o command=). */
  cmdline?: (pid: number) => string | undefined;
  pollMs?: number;
  psMs?: number;
};

const psCommand = (pid: number): string | undefined => {
  try { return execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 }).trim() || undefined; } catch { return undefined; }
};

/**
 * The watcher's node process (`agent-browser give-back-watch`, started by ensureWatchBack): one for each agent Chrome of
 * a state folder (give-back-watch.json, under a lock: a second one for the same Chrome ends with "end=another"). It runs
 * the watcher script (osascript, or the settings' watchBackCommand in a test or a dry run) and keeps reading its pipe,
 * checks the agent Chrome every WATCH_POLL_MS (a signal 0) and every WATCH_PS_MS (ps: still the agent Chrome on this
 * profile), and ends with it, at SIGTERM or SIGINT, or when the script ends: its last line is "end=agent-gone by=node",
 * "end=stopped by=node" or "end=script-ended code=N by=node". It removes its record and ends the script. Resolves when
 * it has ended.
 */
export async function runWatchBack(s: Settings, chromePid: number, deps: WatchDeps = {}): Promise<void> {
  const logFile = statePath(s, "launches.log");
  const line = (what: string) => { try { appendFileSync(logFile, `${new Date().toISOString()} watch-back ${what}\n`); } catch { /* logging never stops it */ } };
  const isAlive = deps.alive ?? alive, cmdline = deps.cmdline ?? psCommand;
  const isAgent = () => isAgentChromeCommand(cmdline(chromePid) ?? "", s.profileDir);
  if (!isAlive(chromePid) || !isAgent()) { line(`end=no-agent chrome=${chromePid}`); return; }
  const mine = await withFileLock(statePath(s, "give-back-watch.lock"), Date.now() + 5000, async () => {
    const r = watchRunning(s);
    if (r && r.pid !== process.pid && r.chrome === chromePid) return false;
    writeWatch(s, { pid: process.pid, chrome: chromePid, at: Date.now() });
    return true;
  }, "the give-back watcher's start lock").catch(() => false);
  if (!mine) { line(`end=another chrome=${chromePid}`); return; }
  let bin: string, pre: string[] = [];
  const bundle = appBundle(agentChromeBin(s)) ?? (s.watchBackCommand ? "/stand-in.app" : undefined);
  if (s.watchBackCommand) [bin, ...pre] = s.watchBackCommand;
  else bin = OSASCRIPT;
  const removeRecord = () => { try { if (readWatch(s)?.pid === process.pid) rmSync(statePath(s, WATCH_FILE), { force: true }); } catch { /* gone */ } };
  if (!bundle || (!s.watchBackCommand && !existsSync(OSASCRIPT))) { line(`end=no-osascript chrome=${chromePid}`); removeRecord(); writeFailed(s, chromePid, "no-osascript"); return; }
  let child: ChildProcess;
  const fd = openSync(logFile, "a");
  try { child = spawn(bin, [...pre, ...watchBackArgs(bundle, chromePid, process.pid, s.stateDir)], { stdio: ["ignore", "pipe", fd] }); }
  catch (e) { line(`end=error ${JSON.stringify(String((e as Error).message))}`); removeRecord(); writeFailed(s, chromePid, "spawn"); return; }
  finally { closeSync(fd); }
  child.on("error", () => {});
  // Its later lines are empty beats: keep reading them, so that the pipe always has a reader while this process lives
  // (with no reader the script ends: review-66b E).
  child.stdout!.resume();
  let done: (why: string) => void = () => {};
  const ended = new Promise<string>((r) => { done = r; });
  // The script ends by itself when the agent Chrome quits (its own look), or at an error.
  child.once("exit", (code, signal) => done(isAlive(chromePid) ? `script-ended code=${code ?? signal}` : "agent-gone"));
  const onSignal = () => done("stopped");
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  let lastPs = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    if (!isAlive(chromePid)) return done("agent-gone");
    if (now - lastPs >= (deps.psMs ?? WATCH_PS_MS)) { lastPs = now; if (!isAgent()) return done("agent-gone"); }
    try { writeWatch(s, { pid: process.pid, chrome: chromePid, at: now }); } catch { /* the next beat */ }
  }, deps.pollMs ?? WATCH_POLL_MS);
  const why = await ended;
  clearInterval(timer);
  process.removeListener("SIGTERM", onSignal);
  process.removeListener("SIGINT", onSignal);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  line(`end=${why} by=node`);
  removeRecord();
  // A script that ended while its agent Chrome runs could not watch it (no input reading, an error): no new one for that Chrome for a while.
  if (why.startsWith("script-ended")) writeFailed(s, chromePid, why);
}
