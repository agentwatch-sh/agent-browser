// The helper processes of the Mac peer probe (probe.ts; board ab-v16.52, part 1). The probe, or a helper, starts each one
// with node, an argv of fixed words, the probe's socket and the probe's own temp folder. A helper prints nothing, writes
// files only in that folder (its ready file), and ends itself after LIMIT_MS whatever happens (shorter than the probe's
// time limit), so that none outlives the probe.
//
//   connect <case> <socket> <folder>   the connecter of each case: it connects to the probe's socket and does its case's
//                                      step when the probe asks on its IPC channel (fork, pass, spawn); it ends when that
//                                      channel ends (the probe's disconnect, or the probe's end)
//   sender <case> <fd> <folder>        case b's grandchild (the socket as fd 3) and case d's sender (the socket as fd 1):
//                                      it writes ready-<case> (its pid), and one byte on fd once go-<case> exists
//   receiver <case> - <folder>         case c's receiver: it takes the socket from the connecter's IPC message (SCM_RIGHTS),
//                                      writes ready-<case>, and writes one byte on the socket once go-<case> exists
//
// Every helper ends when end-<case> exists, and the receiver and case d's sender also when their IPC channel ends. Case
// b's grandchild has no channel: its parent has gone when it writes.

import { fork, spawn, type ChildProcess } from "node:child_process";
import { existsSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** A helper ends itself after this long (the probe's time limit is 30 s). */
const LIMIT_MS = 20_000;
/** The poll of the folder's go and end files. */
const POLL_MS = 5;

const SELF = fileURLToPath(import.meta.url);
const [mode, kase, arg, dir] = process.argv.slice(2);
const end = (code: number): never => process.exit(code);
if (!["connect", "sender", "receiver"].includes(mode) || !/^[a-d]$/.test(kase ?? "") || !arg || !dir) end(2);

setTimeout(() => end(3), LIMIT_MS);
const file = (name: string) => join(dir, `${name}-${kase}`);
const poll = setInterval(() => { if (existsSync(file("end"))) end(0); }, POLL_MS);
void poll;

/** Run `fn` once, when the go file of the case exists. */
function atGo(fn: () => void): void {
  const t = setInterval(() => {
    if (!existsSync(file("go"))) return;
    clearInterval(t);
    fn();
  }, POLL_MS);
}

/** The ready file, with this process's pid; written whole (a rename), so the probe never reads a part of it. */
function ready(): void {
  const tmp = `${file("ready")}.tmp`;
  writeFileSync(tmp, String(process.pid));
  renameSync(tmp, file("ready"));
}

const childArgs = ["--disable-sigusr1"];

if (mode === "connect") {
  const s: Socket = connect(arg);
  s.on("error", () => end(1));
  process.on("disconnect", () => end(0));
  let child: ChildProcess | null = null;
  process.on("message", (m: { do?: string }) => {
    if (child) return;
    if (kase === "b" && m?.do === "fork") {
      child = spawn(process.execPath, [...childArgs, SELF, "sender", "b", "3", dir], { stdio: ["ignore", "ignore", "ignore", s] });
      child.unref();
    } else if (kase === "c" && m?.do === "pass") {
      child = fork(SELF, ["receiver", "c", "-", dir], { execArgv: childArgs, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      child.send("socket", s);
    } else if (kase === "d" && m?.do === "spawn") {
      child = spawn(process.execPath, [...childArgs, SELF, "sender", "d", "1", dir], { stdio: ["ignore", s, "ignore", "ipc"] });
    }
    child?.on("error", () => end(1));
  });
} else if (mode === "sender") {
  const fd = Number(arg);
  if (kase === "d") process.on("disconnect", () => end(0));
  ready();
  atGo(() => { try { writeSync(fd, kase); } catch { end(1); } });
} else {
  process.on("disconnect", () => end(0));
  let got: Socket | null = null;
  process.on("message", (m: unknown, handle: unknown) => {
    if (got || m !== "socket" || !handle) return;
    got = handle as Socket;
    got.on("error", () => end(1));
    ready();
    atGo(() => got!.write(kase));
  });
}
