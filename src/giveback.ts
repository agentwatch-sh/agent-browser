// The give-back guard of a macOS agent Chrome start (ab-b84.11). `open -n -g` keeps Launch Services from
// activating the new Chrome, but Chrome activates itself when it shows its first window (Chromium's window
// Show() calls [NSApp activateIgnoringOtherApps:YES]): measured 2026-11-04 through `launch`, 12 of 12 starts
// took the front. So before such a start a small guard records the app in front, and when the new agent
// Chrome takes the front from it, the guard asks macOS to activate that app again
// (NSRunningApplication.activateWithOptions). Measured with the same call from a Swift helper on 2026-11-04
// (test/live/takeover/giveback.swift, Chrome Beta, 3 starts): macOS granted every request, and the
// operator's app was back in front after 83, 43 and 36 ms. A short change stays: keys typed in that time
// go to Chrome. On macOS 14 and later macOS can refuse the request (cooperative activation).
//
// An npm package ships no compiled helper, so the guard is JavaScript for Automation, run by
// /usr/bin/osascript through its Objective-C bridge to AppKit. It sends no Apple Event and no input, uses
// no System Events, and needs no Accessibility, Automation or Screen Recording grant. The script is a
// constant: its only inputs are its arguments (the agent's app bundle path, and its time limit as a whole
// number of ms), never text put into the script. It only ever activates the app that was in front just
// before the new Chrome took the front: at first the app in front at its start, then any app that the
// operator (or macOS) brings to the front while the new Chrome is not in front. It watches until the start
// that made it ends it (src/agent.ts: at the latest GIVE_BACK_GRACE_MS after the endpoint is up), so a
// second take by the same Chrome (session restore activates its last window at the end of a restore) is
// given back too; it asks at most 3 times in all for one start, and ends on its own at its time limit.
// It cannot tell the operator's own switch to the new Chrome from Chrome's own activation: if the operator
// switches to the new Chrome while the guard watches, the guard sends them back (up to 3 asks in about
// 750 ms for one take); once the 3 asks of the start are spent, or once the start has ended it, never again.

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { underNodeTest } from "./options.ts";

export const OSASCRIPT = "/usr/bin/osascript";

/** The guard's own time limit: it ends sooner, once the front is back, or when the start that made it ends it. */
export const GIVE_BACK_BOUND_MS = 15_000;
/** How long a start waits for the guard to record the app in front; then it starts Chrome without a guard. */
export const GIVE_BACK_READY_MS = 3_000;
/**
 * Once the agent Chrome's endpoint is up, how long the guard still watches before the start ends it (the new
 * Chrome took the front at its first window during the launch phase in 12 of 12 starts on 2026-11-04; a
 * session restore can activate its last window at the end of the restore): so a guard never acts on what
 * follows the start, such as Chrome's approval prompt, which must stay in front.
 */
export const GIVE_BACK_GRACE_MS = 1_000;

/**
 * The guard (JXA). argv: the agent's app bundle path and the time limit in ms. Once it watches, it prints one
 * JSON line on standard output, {"before": pid, "bundle": id} (pid 0: no app in front, and it ends). Then it
 * polls the front app every 25 ms, spinning the run loop so that AppKit's view of the front app stays
 * current (it sleeps the rest of the 25 ms when the run loop returns at once). The new Chrome is the first
 * new instance of the bundle (one that did not run at the guard's start, so never the operator's own Google
 * Chrome) that takes the front. Each time it takes the front from the recorded app, the guard asks macOS to
 * activate that app, again after 250 ms while the new Chrome stays in front, at most 3 times in all. When
 * another app comes to the front while the new Chrome is not in front, that app is the recorded app from
 * then on. The guard ends when the start ends it (SIGTERM), when macOS did not give the front back within
 * the asks ("refused"), when the new Chrome takes the front with the asks spent ("limit"), when the
 * recorded app quits during a take ("gone"), or at its time limit ("bound"). Each log line goes to standard
 * error (launches.log): "<ISO time> give-back <what>".
 */
export const GIVE_BACK_SCRIPT = String.raw`ObjC.import("AppKit");

const POLL_S = 0.025, RETRY_MS = 250, MAX_ASKS = 3;

// One step of the guard: from its state, the time, the app in front (null: none for a moment; else its pid,
// and whether it is a new instance of the agent's bundle) and whether the recorded app has quit, the next
// state and what to do. st.before: the recorded app; st.agent: the new Chrome, once it took the front;
// st.took: when the take in progress began (null: no take); st.asks: the asks of the whole start.
function step(st, now, front, beforeGone) {
  if (now - st.startedAt >= st.boundMs) return { st: st, end: "bound" };
  if (st.took !== null && beforeGone) return { st: st, end: "gone" };
  if (front === null) return { st: st };
  if (front.pid === st.before) {
    if (st.took === null) return { st: st };
    return { st: Object.assign({}, st, { took: null }), log: "back=" + st.before + " after-ms=" + (now - st.took) };
  }
  if (front.fresh && (st.agent === null || st.agent === front.pid)) {
    if (st.took === null) {
      const took = Object.assign({}, st, { agent: front.pid, took: now }), log = "took=" + front.pid + " from=" + st.before;
      if (st.asks >= MAX_ASKS) return { st: took, log: log, end: "limit" };
      return { st: Object.assign(took, { asks: st.asks + 1, askedAt: now }), log: log, ask: true };
    }
    if (now - st.askedAt < RETRY_MS) return { st: st };
    if (st.asks >= MAX_ASKS) return { st: st, end: "refused" };
    return { st: Object.assign({}, st, { asks: st.asks + 1, askedAt: now }), ask: true };
  }
  // Another new instance of the bundle (another start beside this one): not this start's Chrome, and never an app to activate.
  if (front.fresh) return { st: st };
  // Another app is in front, which the operator (or macOS) chose: from now on it is the app to give the front back to.
  return { st: Object.assign({}, st, { before: front.pid, took: null }), log: "before=" + front.pid };
}

function run(argv) {
  const err = $.NSFileHandle.fileHandleWithStandardError;
  const write = (handle, line) => handle.writeData($(line + "\n").dataUsingEncoding($.NSUTF8StringEncoding));
  const log = (text) => write(err, new Date().toISOString() + " give-back " + text);
  try {
    if (argv.length !== 2 || !/^\/.*[^\/]\.app$/.test(argv[0]) || !/^[1-9][0-9]{3,4}$/.test(argv[1])) { log("end=usage"); return; }
    const nil = (o) => o === undefined || o === null || (typeof o.isNil === "function" && o.isNil());
    const text = (o) => { if (nil(o)) return null; const v = ObjC.unwrap(o); return typeof v === "string" ? v : null; };
    const pathOf = (url) => (nil(url) ? null : text(url.URLByStandardizingPath.path));
    const pidOf = (app) => { if (nil(app)) return 0; const pid = app.processIdentifier; return typeof pid === "number" && pid > 0 ? pid : 0; };
    const bundle = pathOf($.NSURL.fileURLWithPath(argv[0]));
    const inBundle = (app) => bundle !== null && pathOf(app.bundleURL) === bundle;
    const workspace = $.NSWorkspace.sharedWorkspace;
    const apps = workspace.runningApplications, old = [];
    for (let i = 0; i < apps.count; i++) { const a = apps.objectAtIndex(i); if (inBundle(a)) old.push(pidOf(a)); }
    // The recorded app's own AppKit object: an activation goes to that process, never to a pid that another app took over.
    let before = workspace.frontmostApplication;
    const beforePid = pidOf(before);
    write($.NSFileHandle.fileHandleWithStandardOutput, JSON.stringify({ before: beforePid, bundle: beforePid ? text(before.bundleIdentifier) : null }));
    if (!beforePid) { log("end=no-front asks=0"); return; }
    let st = { before: beforePid, agent: null, startedAt: Date.now(), boundMs: Number(argv[1]), took: null, asks: 0, askedAt: 0 };
    for (;;) {
      // The run loop delivers AppKit's news of the front app; with no input source it returns at once.
      const spun = Date.now();
      $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(POLL_S));
      const rest = POLL_S - (Date.now() - spun) / 1000;
      if (rest > 0.002) $.NSThread.sleepForTimeInterval(rest);
      const app = workspace.frontmostApplication, pid = pidOf(app);
      const fresh = pid !== 0 && pid !== st.before && old.indexOf(pid) < 0 && inBundle(app);
      const r = step(st, Date.now(), pid ? { pid: pid, fresh: fresh } : null, !!before.isTerminated);
      if (r.st.before !== st.before) before = app;
      st = r.st;
      if (r.log) log(r.log);
      if (r.ask) log("asked=" + st.before + " sent=" + !!before.activateWithOptions(0));
      if (r.end) { log("end=" + r.end + " asks=" + st.asks); return; }
    }
  } catch (e) {
    log("end=error " + JSON.stringify(String(e)));
  }
}
`;

/** osascript's argv for the guard: the constant script, then the bundle and the time limit as arguments. */
export function giveBackArgs(bundle: string, boundMs: number = GIVE_BACK_BOUND_MS): string[] {
  if (!/^\/.*[^/]\.app$/.test(bundle) || /[\0\n]/.test(bundle)) throw new Error(`the give-back guard needs an absolute app bundle path (/X.app): ${JSON.stringify(bundle)}`);
  if (!Number.isInteger(boundMs) || boundMs < 1000 || boundMs > 60_000) throw new Error(`the give-back guard's time limit must be a whole number of ms from 1000 to 60000: ${boundMs}`);
  return ["-l", "JavaScript", "-e", GIVE_BACK_SCRIPT, bundle, String(boundMs)];
}

/** The app in front before the start, as the guard recorded it (bundle: its bundle id, if launches.log can hold it as one token). */
export type FrontApp = { pid: number; bundle: string | null };

/** The guard's ready line, or undefined when it is none. */
export function parseReady(line: string): FrontApp | undefined {
  let v: unknown;
  try { v = JSON.parse(line); } catch { return undefined; }
  const o = v as { before?: unknown; bundle?: unknown } | null;
  if (!o || typeof o !== "object" || !Number.isSafeInteger(o.before) || (o.before as number) < 0) return undefined;
  const bundle = typeof o.bundle === "string" && /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(o.bundle) ? o.bundle : null;
  return { pid: o.before as number, bundle };
}

export type GiveBack = {
  /** "on": the guard watches; else why the start has none ("not-ready", "failed", or "no-front": no app was in front). */
  state: "on" | "not-ready" | "failed" | "no-front";
  front?: FrontApp;
  /** How long the start waited for the guard's ready line. */
  readyMs?: number;
  /** The guard's pid, if it started. */
  pid?: number;
  /** Wait at most `ms` for the guard to end by itself, then end it (launches.log: "end=stopped by=launch"). Never throws. */
  finish(ms: number): Promise<void>;
};

/** How launches.log names the guard of a start: "give-back=on front=<pid>[/<bundle id>] ready-ms=<n>", or why there is none. */
export function giveBackToken(g: Pick<GiveBack, "state" | "front" | "readyMs"> | undefined): string {
  if (!g) return "give-back=off";
  if (g.state !== "on") return `give-back=${g.state}`;
  return `give-back=on front=${g.front!.pid}${g.front!.bundle ? `/${g.front!.bundle}` : ""} ready-ms=${g.readyMs}`;
}

/**
 * Start the guard for a start of the agent Chrome from `bundle`, and resolve once it has recorded the app in
 * front (at most `readyMs`), so that the start runs `open` after that. Its log lines go to `logFile`
 * (launches.log). It never throws: a guard that does not start, or is not ready in time, is ended and named
 * in the result, and the start goes on without it. Under node --test it runs only a given `bin` (a stand-in),
 * so no test can activate a real app.
 */
export async function startGiveBack(bundle: string, logFile: string, deps: { bin?: string; readyMs?: number; boundMs?: number; spawn?: typeof spawn } = {}): Promise<GiveBack> {
  const t0 = Date.now();
  const none = (state: "not-ready" | "failed" | "no-front", pid?: number): GiveBack => ({ state, pid, finish: async () => {} });
  if (!deps.bin && underNodeTest()) return none("failed");
  let child: ChildProcess, fd: number | undefined;
  try {
    const args = giveBackArgs(bundle, deps.boundMs);
    try { fd = openSync(logFile, "a"); } catch { /* the guard still runs; its log lines are lost */ }
    child = (deps.spawn ?? spawn)(deps.bin ?? OSASCRIPT, args, { stdio: ["ignore", "pipe", fd ?? "ignore"] });
  } catch { return none("failed"); } finally { if (fd !== undefined) closeSync(fd); }
  let ended = false;
  child.on("error", () => {}); // a spawn or a signal that failed (handled below or harmless): never an unhandled error in the start
  const closed = new Promise<void>((r) => child.once("close", () => { ended = true; r(); }));
  // The first line on standard output, or why there is none: the time ran out, or the guard ended (or never started).
  const ready = await new Promise<{ line?: string; why: "line" | "timeout" | "ended" }>((resolve) => {
    let buf = "";
    const timer = setTimeout(() => resolve({ why: "timeout" }), deps.readyMs ?? GIVE_BACK_READY_MS);
    const done = (v: { line?: string; why: "line" | "ended" }) => { clearTimeout(timer); resolve(v); };
    child.stdout!.on("data", (b) => { buf += b; const i = buf.indexOf("\n"); if (i >= 0) done({ line: buf.slice(0, i), why: "line" }); });
    child.once("error", () => done({ why: "ended" }));
    child.once("close", () => done({ why: "ended" }));
  });
  child.stdout!.destroy(); // the guard writes nothing more there
  child.unref();
  const stop = () => { if (!ended) { ended = true; child.kill("SIGTERM"); } };
  // A guard that is not ready in time is ended: it could still record the new Chrome as the app in front.
  if (ready.why === "timeout") { stop(); return none("not-ready", child.pid); }
  const front = ready.line === undefined ? undefined : parseReady(ready.line);
  if (!front) { stop(); return none("failed", child.pid); }
  if (!front.pid) { stop(); return none("no-front", child.pid); } // it ends by itself too
  const finish = async (ms: number) => {
    if (ended) return;
    await Promise.race([closed, new Promise((r) => setTimeout(r, ms))]);
    if (ended) return;
    stop();
    try { appendFileSync(logFile, `${new Date().toISOString()} give-back end=stopped by=launch\n`); } catch { /* logging never blocks a launch */ }
  };
  return { state: "on", front, readyMs: Date.now() - t0, pid: child.pid, finish };
}
