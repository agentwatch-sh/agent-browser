// The dry run's stand-in for agent-browser's give-back watcher, the prototype (mac-watchback.ts, which osascript runs
// on the Mac): the same ready line on standard output and the same log lines on standard error, so that the dry run
// starts, reads and ends it as the Mac run does. It sees no take (Linux has no front app) and activates nothing. It
// ends when the agent's pid is gone (a signal 0, which sends nothing), at its time limit, or at the check's SIGTERM.
//
//   node test/live/anti-detect/mac-standin-watchback.ts AGENT_PID BOUND_MS BEFORE_PID
//
// MAC_STANDIN_WATCHBACK_END_MS=N: N ms after its start it ends with "end=error" (a prototype that fails while it gives
// the front back: the check's own watcher then gives it back again).

const [agent, bound, before] = process.argv.slice(2).map(Number);
if (![agent, bound, before].every((n) => Number.isSafeInteger(n) && n > 0)) { process.stderr.write("usage: mac-standin-watchback.ts AGENT_PID BOUND_MS BEFORE_PID\n"); process.exit(2); }
const t0 = Date.now();
const log = (what: string) => process.stderr.write(`${new Date().toISOString()} watch-back ${what}\n`);
process.stdout.write(`${JSON.stringify({ before, bundle: null, agent })}\n`);
log(`watch agent=${agent} before=${before}`);
const alive = () => { try { process.kill(agent, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
const failAt = Number(process.env.MAC_STANDIN_WATCHBACK_END_MS ?? 0);
setInterval(() => {
  if (failAt > 0 && Date.now() - t0 >= failAt) { log('end=error "stand-in: MAC_STANDIN_WATCHBACK_END_MS"'); process.exit(0); }
  if (!alive()) { log("end=agent-gone"); process.exit(0); }
  if (Date.now() - t0 >= bound) { log("end=bound"); process.exit(0); }
}, 25);
