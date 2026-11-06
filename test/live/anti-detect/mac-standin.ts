// The dry run's stand-in for mac-watch.swift (mac.ts --dry-run, on Linux): the same protocol (JSON lines out,
// commands in), with no front app other than itself, no Space and a pointer that never moves. Its snaps list the
// agent Chromium's own X windows (xwininfo's stacking order, top first; xdotool for the pid), so that the window
// analysis runs on real windows; the private Xvfb has no window of an operator. It lets the dry run drive every
// phase, analyse the logs and write the summary; it measures nothing of a Mac.
//
//   node test/live/anti-detect/mac-standin.ts SECONDS
//
// (mac-standin-watchback.ts stands in for agent-browser's give-back watcher, the prototype of mac-watchback.ts.)
//
// To test the check's stop rules, its refusals and its analysis, these variables make it log what a Mac can show:
// MAC_STANDIN_TAKE_MS=N (N ms after its start, the agent Chrome takes the front for 120 ms, or for
// MAC_STANDIN_TAKE_LEN_MS, and the front comes back),
// MAC_STANDIN_POINTER_MS=N (N ms after its start, the pointer moves: a person at the Mac), MAC_STANDIN_INPUT_MS=N
// (N ms after its start, a key press of the hardware: a person at the Mac), and MAC_STANDIN_HID=NAME=S[,NAME=S]
// (the ready line's HID reading of NAME is S seconds; the others are 3600: a reading of 0 makes the check refuse).

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const seconds = Number(process.argv[2]);
if (!Number.isFinite(seconds) || seconds <= 0) { process.stderr.write("usage: mac-standin.ts SECONDS\n"); process.exit(2); }
const emit = (ev: string, fields: Record<string, unknown> = {}) => process.stdout.write(`${JSON.stringify({ ...fields, t: Date.now(), ev })}\n`);
const front = { pid: process.pid, name: "dry run (no front app on Linux)", bundle: null, agent: false };
const state = { locked: false, onConsole: true, asleep: false };
let agentPid = 0, armed = false, personWhy = "", inFront = false;
/** The six HID readings of mac-watch.swift's ready line (seconds since the hardware's last event of each type). */
const hid: Record<string, number> = Object.fromEntries(["keyDown", "flagsChanged", "leftMouseDown", "rightMouseDown", "otherMouseDown", "scrollWheel"].map((n) => [n, 3600]));
for (const pair of (process.env.MAC_STANDIN_HID ?? "").split(",").filter(Boolean)) { const [n, v] = pair.split("="); hid[n] = Number(v); }
const finish = (why: string) => { emit("end", { why }); process.exit(0); };
/** The agent's visible top-level X windows, top first: [pid, id, x, y, w, h, 100], as mac-watch.swift's list. */
function xWindows(): number[][] {
  if (!agentPid || !process.env.DISPLAY) return [];
  try {
    const run = (bin: string, args: string[]) => execFileSync(bin, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const mine = new Set(run("xdotool", ["search", "--onlyvisible", "--pid", String(agentPid)]).split("\n").filter(Boolean).map(Number));
    return run("xwininfo", ["-root", "-children"]).split("\n").flatMap((l) => {
      const m = /^\s+(0x[0-9a-f]+) .*\s(\d+)x(\d+)\+(-?\d+)\+(-?\d+)\s/.exec(l);
      const id = m ? parseInt(m[1], 16) : 0;
      return m && mine.has(id) ? [[agentPid, id, Number(m[4]), Number(m[5]), Number(m[2]), Number(m[3]), 100]] : [];
    });
  } catch { return []; }
}

emit("ready", { ...state, front, pointer: [-1000, -1000], space: null, spaceReader: false, displays: [], old: [], hid });
emit("windows", { why: "ready", list: [], owners: {} });
setInterval(() => emit("alive", { ...state, space: null }), 1000);
const takeAt = Number(process.env.MAC_STANDIN_TAKE_MS ?? 0), pointerAt = Number(process.env.MAC_STANDIN_POINTER_MS ?? 0), inputAt = Number(process.env.MAC_STANDIN_INPUT_MS ?? 0);
// As mac-watch.swift: the first sign of a person stops the give-back for good.
const personSeen = (why: string) => { if (personWhy) return; personWhy = why; armed = false; emit("disarmed", { why }); };
if (takeAt > 0) setTimeout(() => {
  emit("front", { pid: agentPid, name: "agent Chrome (stand-in)", bundle: null, agent: true });
  inFront = true;
  setTimeout(() => { inFront = false; emit("front", front); }, Number(process.env.MAC_STANDIN_TAKE_LEN_MS ?? 120));
}, takeAt);
if (pointerAt > 0) setTimeout(() => { emit("pointer", { x: 1, y: 2 }); personSeen("pointer"); }, pointerAt);
if (inputAt > 0) setTimeout(() => { emit("input", { kind: "keyDown", agoMs: 0 }); personSeen("input"); }, inputAt);
setTimeout(() => finish("limit"), seconds * 1000);
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const [verb, rest = ""] = line.trim().split(/ (.*)/s);
  if (verb === "arm") { if (personWhy) emit("disarmed", { why: personWhy }); else { armed = true; emit("armed"); } }
  else if (verb === "disarm") { armed = false; emit("disarmed"); }
  // As mac-watch.swift: one last request, only while the agent Chrome is in front (on Linux the stand-in asks nobody).
  else if (verb === "giveback") emit("giveback", { asked: inFront, front: inFront ? { pid: agentPid, name: "agent Chrome (stand-in)", agent: true } : front });
  else if (verb === "agent") { agentPid = Number(rest) || 0; emit("agent", { pid: agentPid }); }
  else if (verb === "snap") {
    const list = xWindows();
    emit("windows", { why: "snap", label: rest, list, owners: { [agentPid]: "Chromium (dry run)" }, front, space: null,
      agentAll: list.map(([, n, x, y, w, h]) => ({ n, layer: 0, x, y, w, h, alpha: 1, onscreen: true })), agentApp: { pid: agentPid, policy: 0, hidden: false, active: false } });
  }
  else if (verb === "quit") finish("quit");
  else emit("error", { what: "unknown command", line });
});
rl.on("close", () => finish("eof"));
