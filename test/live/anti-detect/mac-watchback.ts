// A prototype of the give-back watcher that the Mac build needs (board task ab-v16.68, for ab-v16.27): agent-browser's
// start guard (src/giveback.ts) run for as long as the agent Chrome runs, the operator's answer ab-or9 ("Give the front
// back at once": a watcher records the operator's front app and activates it again each time the agent Chrome takes
// the front). The Mac check (mac.ts) runs it as agent-browser would run it: /usr/bin/osascript, JavaScript for
// Automation, the guard's 25 ms poll, its one activation call (activateWithOptions(0)) and its 3 asks 250 ms apart,
// but for each take. The check measures its times per take apart from its own watcher (mac-watch.swift), which only
// logs while this one runs and gives the front back only when this one has not within FALLBACK_MS (mac-rules.ts).
//
// It is a prototype in the check, not agent-browser's code: src/ has no such watcher, and nothing in agent-browser
// runs this one. The build decides its own: a person's own switch to the agent Chrome (this prototype sends them back,
// as the start guard does for its time), Chrome's approval prompt and `front`, which must stay in front.
//
//   osascript -l JavaScript -e WATCH_BACK_SCRIPT BUNDLE_PATH AGENT_PID BOUND_MS     (watchBackArgs)
//
// Standard output: one JSON line once it watches, {"before": pid, "bundle": id, "agent": pid} (before 0: it does not
// watch, and it ends). Standard error (the check's watch-back.log): "<ISO time> watch-back <what>", one line each:
//   watch agent=PID before=PID       it watches
//   took=PID from=PID                the agent Chrome took the front from the app to give it back to
//   asked=PID n=N sent=BOOL          one activation request for that app (at most 3 for one take, 250 ms apart)
//   back=PID after-ms=N asks=N       that app is in front again (after-ms: from the take, as this watcher saw it)
//   refused=PID asks=N               the 3 asks of the take are spent: it asks no more until the front leaves the agent
//   before=PID [after-ms=N]          another app came to the front: the app to give the front back to from now on
//   end=WHY                          agent-gone (the agent Chrome quit), bound (its time limit), no-agent, no-front,
//                                    agent-in-front, usage or error; the check adds "end=stopped by=check" at its SIGTERM
// It sends no Apple Event and no input, uses no System Events, and needs no Accessibility, Automation or Screen
// Recording grant (as the start guard). The script is a constant: its only inputs are its arguments.

/** The prototype's own time limit, at most (the check gives it the rest of its run). */
export const WATCH_BACK_MAX_MS = 900_000;

/**
 * The prototype (JXA). argv: the agent's app bundle path, the agent Chrome's pid, and the time limit in ms. The agent
 * Chrome is that pid, and only while it is an instance of that bundle (checked at the start; a quit ends the watcher,
 * so a pid that another process takes later is never the agent). It polls the front app every 25 ms, spinning the run
 * loop as the start guard does. Each time the agent Chrome takes the front, it asks macOS to activate the app that was
 * in front before, again after 250 ms while the agent Chrome stays in front, at most 3 times for that take; then it
 * waits for the front to leave the agent Chrome. When another app comes to the front, that app is the one to give the
 * front back to from then on. It ends when the agent Chrome quits, at its time limit, or at the check's SIGTERM.
 */
export const WATCH_BACK_SCRIPT = String.raw`ObjC.import("AppKit");

const POLL_S = 0.025, RETRY_MS = 250, MAX_ASKS = 3;

// One step of the watcher: from its state, the time, the app in front (null: none for a moment; else its pid, and
// whether it is the agent Chrome), whether the agent Chrome has quit and whether the app to give the front back to
// has quit, the next state and what to do. st.before: the app to give the front back to; st.took: when the take in
// progress began (null: no take); st.asks: the asks of that take; st.spent: no more asks for that take.
function step(st, now, front, agentGone, beforeGone) {
  if (agentGone) return { st: st, end: "agent-gone" };
  if (now - st.startedAt >= st.boundMs) return { st: st, end: "bound" };
  if (front === null) return { st: st };
  if (front.agent) {
    if (st.took === null) {
      const took = Object.assign({}, st, { took: now, asks: 0, askedAt: 0, spent: false }), log = "took=" + front.pid + " from=" + st.before;
      if (beforeGone) return { st: Object.assign(took, { spent: true }), log: log + " gone=" + st.before };
      return { st: Object.assign(took, { asks: 1, askedAt: now }), log: log, ask: true };
    }
    if (st.spent || now - st.askedAt < RETRY_MS) return { st: st };
    if (st.asks >= MAX_ASKS) return { st: Object.assign({}, st, { spent: true }), log: "refused=" + st.before + " asks=" + st.asks };
    return { st: Object.assign({}, st, { asks: st.asks + 1, askedAt: now }), ask: true };
  }
  if (front.pid === st.before) {
    if (st.took === null) return { st: st };
    return { st: Object.assign({}, st, { took: null, spent: false }), log: "back=" + st.before + " after-ms=" + (now - st.took) + " asks=" + st.asks };
  }
  // Another app is in front, which the operator (or macOS) chose: from now on it is the app to give the front back to.
  return { st: Object.assign({}, st, { before: front.pid, took: null, spent: false }), log: "before=" + front.pid + (st.took === null ? "" : " after-ms=" + (now - st.took)) };
}

function run(argv) {
  const err = $.NSFileHandle.fileHandleWithStandardError;
  const write = (handle, line) => handle.writeData($(line + "\n").dataUsingEncoding($.NSUTF8StringEncoding));
  const log = (text) => write(err, new Date().toISOString() + " watch-back " + text);
  try {
    if (argv.length !== 3 || !/^\/.*[^\/]\.app$/.test(argv[0]) || !/^[1-9][0-9]{0,6}$/.test(argv[1]) || !/^[1-9][0-9]{3,5}$/.test(argv[2])) { log("end=usage"); return; }
    const nil = (o) => o === undefined || o === null || (typeof o.isNil === "function" && o.isNil());
    const text = (o) => { if (nil(o)) return null; const v = ObjC.unwrap(o); return typeof v === "string" ? v : null; };
    const pathOf = (url) => (nil(url) ? null : text(url.URLByStandardizingPath.path));
    const pidOf = (app) => { if (nil(app)) return 0; const pid = app.processIdentifier; return typeof pid === "number" && pid > 0 ? pid : 0; };
    const bundle = pathOf($.NSURL.fileURLWithPath(argv[0]));
    const inBundle = (app) => bundle !== null && !nil(app) && pathOf(app.bundleURL) === bundle;
    const agentPid = Number(argv[1]);
    // The agent Chrome's own AppKit object: its isTerminated says when it quits.
    const agent = $.NSRunningApplication.runningApplicationWithProcessIdentifier(agentPid);
    const workspace = $.NSWorkspace.sharedWorkspace;
    // The app to give the front back to: its own AppKit object, so an activation goes to that process, never to a pid that another app took over.
    let before = workspace.frontmostApplication;
    const beforePid = pidOf(before), isAgent = inBundle(agent);
    const watches = isAgent && beforePid !== 0 && beforePid !== agentPid;
    write($.NSFileHandle.fileHandleWithStandardOutput, JSON.stringify({ before: watches ? beforePid : 0, bundle: watches ? text(before.bundleIdentifier) : null, agent: agentPid }));
    if (!isAgent) { log("end=no-agent"); return; }
    if (!beforePid) { log("end=no-front"); return; }
    if (beforePid === agentPid) { log("end=agent-in-front"); return; }
    log("watch agent=" + agentPid + " before=" + beforePid);
    let st = { before: beforePid, startedAt: Date.now(), boundMs: Number(argv[2]), took: null, asks: 0, askedAt: 0, spent: false };
    for (;;) {
      // The run loop delivers AppKit's news of the front app; with no input source it returns at once.
      const spun = Date.now();
      $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(POLL_S));
      const rest = POLL_S - (Date.now() - spun) / 1000;
      if (rest > 0.002) $.NSThread.sleepForTimeInterval(rest);
      const app = workspace.frontmostApplication, pid = pidOf(app);
      const r = step(st, Date.now(), pid ? { pid: pid, agent: pid === agentPid } : null, !!agent.isTerminated, !!before.isTerminated);
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

/** osascript's argv for the prototype: the constant script, then the bundle, the agent Chrome's pid and the time limit as arguments. */
export function watchBackArgs(bundle: string, agentPid: number, boundMs: number): string[] {
  if (!/^\/.*[^/]\.app$/.test(bundle) || /[\0\n]/.test(bundle)) throw new Error(`the give-back watcher needs an absolute app bundle path (/X.app): ${JSON.stringify(bundle)}`);
  if (!Number.isSafeInteger(agentPid) || agentPid < 1 || agentPid > 9_999_999) throw new Error(`the give-back watcher needs the agent Chrome's pid: ${agentPid}`);
  if (!Number.isInteger(boundMs) || boundMs < 1000 || boundMs > WATCH_BACK_MAX_MS) throw new Error(`the give-back watcher's time limit must be a whole number of ms from 1000 to ${WATCH_BACK_MAX_MS}: ${boundMs}`);
  return ["-l", "JavaScript", "-e", WATCH_BACK_SCRIPT, bundle, String(agentPid), String(boundMs)];
}

/** The prototype's ready line: the app it gives the front back to (0: it does not watch), or undefined when the line is none. */
export function parseWatchBackReady(line: string): { before: number; bundle: string | null; agent: number } | undefined {
  let v: unknown;
  try { v = JSON.parse(line); } catch { return undefined; }
  const o = v as { before?: unknown; bundle?: unknown; agent?: unknown } | null;
  if (!o || typeof o !== "object" || !Number.isSafeInteger(o.before) || (o.before as number) < 0 || !Number.isSafeInteger(o.agent)) return undefined;
  return { before: o.before as number, bundle: typeof o.bundle === "string" ? o.bundle : null, agent: o.agent as number };
}

import type { BackLine } from "./mac-rules.ts";


/**
 * The prototype's log (watch-back.log): one BackLine per line of the form "<ISO time> watch-back <what>": its time (ms
 * since 1970), and its words as keys ("took=1 from=2": { took: "1", from: "2" }; a word with no "=" has the value "").
 */
export function parseWatchBack(text: string): BackLine[] {
  return text.split("\n").flatMap((line) => {
    const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) watch-back (.+)$/.exec(line);
    const t = m ? Date.parse(m[1]) : Number.NaN;
    if (!m || !Number.isFinite(t)) return [];
    const kv: Record<string, string> = {};
    for (const word of m[2].split(" ")) { const i = word.indexOf("="); if (i > 0) kv[word.slice(0, i)] ??= word.slice(i + 1); else if (word) kv[word] ??= ""; }
    return [{ t, text: m[2], kv }];
  });
}
