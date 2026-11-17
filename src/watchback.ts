// The give-back watcher of the Mac (board task ab-v16.27; the operator's answer ab-or9, 2026-11-06: "Give the front
// back at once"). Chrome can make the agent Chrome the front app by itself: a site's popup did on 2026-11-05 (5 to 25 ms
// until the check gave the front back), and so does the start (src/giveback.ts guards the start only). While the agent
// Chrome is the front app, the operator's keys go to it. So for as long as the agent Chrome runs, this watcher records
// the operator's front app and asks macOS to activate it again each time the agent Chrome takes the front, as the
// start's guard does. agent-browser's service runs it for its Mac Chrome (src/service/unit/mac-chrome.ts).
//
// It never fights the operator (the builder note of ab-or9). A take of the front is the operator's own, and the watcher
// leaves the agent Chrome in front until another app comes to the front, when at the take (OWN_MS):
//   click     a mouse button was down less than 1 s before: a click on an agent window, on its Dock icon or in its Dock
//             menu, in Mission Control or App Expose (AppKit's NSEvent.pressedMouseButtons, sampled every 25 ms, and
//             CoreGraphics' time since the last mouse press of the HID system, which a quick tap cannot pass)
//   command   the Command key was down less than 1 s before: Cmd-Tab (NSEvent.modifierFlags, sampled every 25 ms)
//   front     a hold file give-back-hold-front.json in the state folder holds a time in the future
//   approval  a hold file give-back-hold-approval.json in the state folder holds a time in the future
//   start     no app was recorded yet: the agent Chrome was the front app when the watcher started
// Since board ab-v16.9.3 no part of agent-browser writes the two hold files: `front` and the CDP proxy, which wrote
// them, are gone. The script still reads them, unchanged, because the service's Mac watcher runs this same script.
// A click or the Command key during a take that the watcher is giving back makes that take the operator's too: it
// asks no more. Keys alone do not count: a person who types in their own app while a popup takes the front must get
// the front back at once, else their next keys go to the agent Chrome (ab-or9's reason). So a switch to the agent
// Chrome by keys alone, other than Cmd-Tab (Spotlight or a launcher with Return), is given back once; Cmd-Tab and a
// click reach it.
//
// How it runs: osascript (JavaScript for Automation, as the start guard: no compiled helper, no Apple Event, no System
// Events, no input) with watchBackArgs. It ends when its parent process is gone: getppid (only when its first value is
// that process: review-66b F), and an empty line every 250 ms on a pipe that only that process reads (review-66b E: the
// process keeps reading it). The script also looks the agent's pid up again every second.
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

export const OSASCRIPT = "/usr/bin/osascript";
/**
 * A watcher that could not watch an agent Chrome (no input reading in JXA, no osascript, a script error): the service
 * starts no new one for the same Chrome before this time; for another Chrome, or after it, it does.
 */
export const WATCH_RETRY_MS = 10 * 60_000;

/**
 * The watcher (JXA). argv: the agent's app bundle path, the agent Chrome's pid, the pid of its parent process (the service)
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
