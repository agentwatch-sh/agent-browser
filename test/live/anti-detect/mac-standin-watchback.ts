// A stand-in for the Mac's give-back watcher script (src/watchback.ts, WATCH_BACK_SCRIPT, which osascript runs on the
// Mac), for the tests and the Mac check's dry run on Linux: agent-browser runs it in place of /usr/bin/osascript (the
// internal watchBackCommand option) with the same arguments, and it gives the same ready line on standard output and
// the same log lines on standard error. It sees no take (Linux has no front app) and activates nothing.
//
//   node test/live/anti-detect/mac-standin-watchback.ts -l JavaScript -e SCRIPT BUNDLE AGENT_PID PARENT_PID STATE_DIR
//
// As the script, it ends when its parent (the watcher's node process, PARENT_PID) is gone: its parent pid changes, or
// its empty line every 250 ms on standard output finds no reader. It also ends when the agent's pid is gone (a signal
// 0, which sends nothing). MAC_STANDIN_WATCHBACK_END_MS=N: N ms after its start it ends with "end=error" (a watcher
// that fails). MAC_STANDIN_WATCHBACK_FRONT=PID: the app that it names as the app to give the front back to (default
// 4242). MAC_STANDIN_WATCHBACK_SEEN=FILE: it appends one line "beat N ok" per beat that it wrote (a test reads it).
// MAC_STANDIN_WATCHBACK_BLIND=1: it does not look at the agent's pid (as the prototype missed the quit of a second
// Google Chrome instance on 2026-11-06): only its node process can see the quit.

import { appendFileSync } from "node:fs";

const [agent, parent] = process.argv.slice(-3, -1).map(Number);
const before = Number(process.env.MAC_STANDIN_WATCHBACK_FRONT ?? 4242);
if (![agent, parent].every((n) => Number.isSafeInteger(n) && n > 0)) { process.stderr.write("usage: mac-standin-watchback.ts -l JavaScript -e SCRIPT BUNDLE AGENT_PID PARENT_PID STATE_DIR\n"); process.exit(2); }
const t0 = Date.now();
const log = (what: string) => process.stderr.write(`${new Date().toISOString()} watch-back ${what}\n`);
process.stdout.write(`${JSON.stringify({ watch: true, before, bundle: null, agent, input: "stand-in" })}\n`);
log(`watch agent=${agent} before=${before} parent=${parent} ppid=yes input=stand-in`);
// With no reader on standard output the write fails: the watcher's node process is gone.
process.stdout.on("error", () => { log("end=error \"Broken pipe\""); process.exit(0); });
let polls = 0;
const alive = () => { try { process.kill(agent, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
const failAt = Number(process.env.MAC_STANDIN_WATCHBACK_END_MS ?? 0), seen = process.env.MAC_STANDIN_WATCHBACK_SEEN, blind = process.env.MAC_STANDIN_WATCHBACK_BLIND === "1";
setInterval(() => {
  if (failAt > 0 && Date.now() - t0 >= failAt) { log('end=error "stand-in: MAC_STANDIN_WATCHBACK_END_MS"'); process.exit(0); }
  if (++polls % 10 === 0) {
    process.stdout.write("\n", (e) => { if (!e && seen) appendFileSync(seen, `beat ${polls / 10} ok\n`); });
    if (process.ppid !== parent) { log("end=parent-gone"); process.exit(0); }
  }
  if (!blind && !alive()) { log("end=agent-gone"); process.exit(0); }
}, 25);
