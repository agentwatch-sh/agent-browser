// The stand-in daemon's two pointer ops (board ab-v16.71; the agent pointer design, docs/superpowers/specs/
// 2026-11-06-agent-pointer-move-design.md, sections 2 and 4; contract C10 "The daemon's own ops" in chrome-extension's
// docs/protocol.md, the master). The live test's stand-in daemon (daemon.ts) answers daemon.pointerAt and
// daemon.movePointer itself, before its link checks, with C10's checks in their order; it reads the pointer before a
// play, and it plays a path as one script on `xdotool -` (standard input, one command a line). Its X world is the
// harness's own private Xvfb only (xdotoolWorld: an absolute xdotool, an environment of only DISPLAY and XAUTHORITY, no
// shell); test/pointer-daemon.test.ts gives it the worlds of the contract's vectors instead. It has no live view: its
// rows (not now) are in the checks for the vectors. It keeps no state of the place and logs no point.

import { spawn, type ChildProcess } from "node:child_process";
import { moveProblem, near, POINTER, type Pt } from "../../../src/relay/pointer.ts";

/** How a play ends: the script's last read (its getmouselocation), a failure (an exit code that is not 0), the timeout, or a kill. */
export type PlayEnd = { end: Pt } | "fails" | "timeout" | "operatorInput" | "unitStop" | "linkChange" | "relayEnd" | "daemonStop";
/** The daemon's X world (the vectors' world): the running Xvfb's size (null: no unit Xvfb), xdotool found, another X call. */
export type XWorld = {
  xvfb: { width: number; height: number } | null;
  xdotool: boolean;
  /** Another X call of the daemon runs (the vectors' xCall); the ops' own running call counts too. */
  xCall: () => boolean;
  /** The live view: its current views and the ms since the operator's last live-view input (null: none yet); null: no live view. */
  liveView: () => { views: number; quietMs: number | null } | null;
  /** CLOCK_MONOTONIC in ms. */
  clock: () => number;
  /** One getmouselocation, POINTER_READ_MS at most: the position, or null when it failed. */
  read: () => Promise<Pt | null>;
  /** One script on `xdotool -`, killed at `timeoutMs`. */
  play: (script: string[], timeoutMs: number) => Promise<PlayEnd>;
};
type Req = { t?: string; id: string; op: string; args?: unknown; wait?: number };
type Res = { t: "res"; ch: "bridge"; id: string; ok: boolean; data?: unknown; error?: string };

/** One played path, kept in memory for the live check's measure of `xdotool sleep` (never logged: C10's log rule). */
export type Played = { startedAt: number; endedAt: number; path: { x: number; y: number; dt: number }[]; answer: string };

export class PointerOps {
  private readonly x: XWorld;
  private running = false;
  private plays: number[] = [];
  private reads: number[] = [];
  /** The paths that played (for the live check's measure). */
  readonly played: Played[] = [];
  /** A count of each answer text (the daemon logs one line for each text a minute; the stand-in keeps the counts). */
  readonly counts = new Map<string, number>();

  constructor(x: XWorld) { this.x = x; }

  /** The plays and reads that started in the last second before this daemon's first request (the vectors' `started`). */
  started(paths: number, reads: number): void {
    const now = this.x.clock();
    this.plays = Array(paths).fill(now);
    this.reads = Array(reads).fill(now);
  }

  private busy(): boolean { return this.running || this.x.xCall(); }
  private recent(list: number[]): number[] { const now = this.x.clock(); return list.filter((t) => now - t < 1000); }
  private res(id: string, r: { data: unknown } | { error: string; data?: unknown }): Res {
    const text = "error" in r ? r.error : "ok";
    this.counts.set(text, (this.counts.get(text) ?? 0) + 1);
    return "error" in r ? { t: "res", ch: "bridge", id, ok: false, error: r.error, ...(r.data ? { data: r.data } : {}) } : { t: "res", ch: "bridge", id, ok: true, data: r.data };
  }
  private views(): number { return this.x.liveView()?.views ?? 0; }

  /** The answer to a daemon. op (C10), or null when none comes (a relay end, the daemon's stop). */
  async answer(req: Req): Promise<Res | null> {
    const args = req.args ?? [];
    if (req.op === "daemon.pointerAt") return this.pointerAt(req.id, args);
    if (req.op === "daemon.movePointer") return this.movePointer(req.id, args);
    return this.res(req.id, { error: "unknown op" });
  }

  private async pointerAt(id: string, args: unknown): Promise<Res> {
    if (!Array.isArray(args) || args.length) return this.res(id, { error: "bad args" });
    if (!this.x.xvfb || !this.x.xdotool) return this.res(id, { error: "no display" });
    if (this.busy()) return this.res(id, { error: "busy" });
    if ((this.reads = this.recent(this.reads)).length >= POINTER.POINTER_READS_PER_S) return this.res(id, { error: "too many moves" });
    this.reads.push(this.x.clock());
    this.running = true;
    let p: Pt | null;
    try { p = await this.x.read(); } finally { this.running = false; }
    if (!p) return this.res(id, { error: "no display" });
    return this.res(id, { data: { x: p.x, y: p.y, width: this.x.xvfb.width, height: this.x.xvfb.height, views: this.views() } });
  }

  private async movePointer(id: string, args: unknown): Promise<Res | null> {
    const problem = moveProblem(args, this.x.clock());
    if (problem === "bad args") return this.res(id, { error: "bad args" });
    if (!this.x.xvfb || !this.x.xdotool) return this.res(id, { error: "no display" });
    const m = (args as any[])[0];
    if (m.width !== this.x.xvfb.width || m.height !== this.x.xvfb.height) return this.res(id, { error: "wrong display" });
    if (problem === "out of bounds") return this.res(id, { error: "out of bounds" });
    if (this.busy()) return this.res(id, { error: "busy" });
    const live = this.x.liveView();
    if (live && (m.views !== live.views || (live.quietMs !== null && live.quietMs < POINTER.POINTER_VIEW_QUIET_MS))) return this.res(id, { error: "not now" });
    if ((this.plays = this.recent(this.plays)).length >= POINTER.POINTER_PATHS_PER_S) return this.res(id, { error: "too many moves" });
    // The read before the play (it does not count as a read), then notAfter after it: a slow read ends in too late.
    this.running = true;
    try {
      const p = await this.x.read();
      if (!p) return this.res(id, { error: "no display" });
      if (!near(p, m.at, POINTER.POINTER_NEAR_PX)) return this.res(id, { error: "pointer moved", data: { x: p.x, y: p.y, views: this.views() } });
      if (this.x.clock() > m.notAfter) return this.res(id, { error: "too late" });
      this.plays.push(this.x.clock());
      const script = scriptOf(m.path), total = m.path.reduce((a: number, q: { dt: number }) => a + q.dt, 0);
      const startedAt = Date.now();
      const end = await this.x.play(script, total + POINTER.POINTER_KILL_MS);
      const answer = typeof end === "object" ? "ok" : end;
      this.played.push({ startedAt, endedAt: Date.now(), path: m.path.map((q: any) => ({ x: q.x, y: q.y, dt: q.dt })), answer });
      if (typeof end === "object") return this.res(id, { data: { x: end.end.x, y: end.end.y, views: this.views() } });
      if (end === "operatorInput") return this.res(id, { error: "not now" });
      if (end === "linkChange") return this.res(id, { error: "disconnected" });
      if (end === "relayEnd" || end === "daemonStop") return null;
      return this.res(id, { error: "no display" }); // fails, timeout, unitStop: the place is unknown
    } finally { this.running = false; }
  }
}

/** The lines of a path's script on xdotool's standard input: `sleep <dt in s>` and `mousemove <x> <y>` for each point, then `getmouselocation`. */
export function scriptOf(path: { x: number; y: number; dt: number }[]): string[] {
  return [...path.flatMap((p) => [`sleep ${p.dt / 1000}`, `mousemove ${p.x} ${p.y}`]), "getmouselocation"];
}

/** getmouselocation's `x:812 y:431 screen:0 window:...`: the position, or null when x or y does not parse (a failure). */
export function parseLocation(out: string): Pt | null {
  const lines = out.trim().split("\n");
  const m = /^x:(-?\d+) y:(-?\d+)\b/.exec(lines[lines.length - 1] ?? "");
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

/**
 * The X world of the harness's own private Xvfb: xdotool by its absolute path, no shell, an environment of only DISPLAY
 * and XAUTHORITY of that Xvfb, its commands from the checked integers only. `kill(reason)` ends a playing script (a
 * relay end, a link change, the daemon's stop): the play then ends with that reason.
 */
export function xdotoolWorld(o: { display: string; xauth: string; size: { width: number; height: number }; xdotool?: string }) {
  const bin = o.xdotool ?? "/usr/bin/xdotool", env = { DISPLAY: o.display, XAUTHORITY: o.xauth };
  if (!/^:\d+$/.test(o.display) || o.display === ":0" || o.display === ":90") throw new Error(`the stand-in daemon's xdotool runs only on the harness's own Xvfb, not ${o.display}`);
  let playing: { child: ChildProcess; reason: PlayEnd | null } | null = null;
  const run = (args: string[], input: string | null, timeoutMs: number) => new Promise<{ code: number | null; out: string; timedOut: boolean; child: ChildProcess }>((resolve) => {
    const child = spawn(bin, args, { env, stdio: [input === null ? "ignore" : "pipe", "pipe", "ignore"] });
    let out = "", timedOut = false;
    child.stdout!.on("data", (d) => (out += d));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.once("error", () => { clearTimeout(timer); resolve({ code: -1, out, timedOut, child }); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, out, timedOut, child }); });
    if (input !== null) child.stdin!.end(input);
    if (input !== null) playing = { child, reason: null };
  });
  const world: XWorld & { kill: (reason: PlayEnd) => void } = {
    xvfb: o.size, xdotool: true, xCall: () => false, liveView: () => null, clock: () => Number(process.hrtime.bigint() / 1000000n),
    read: async () => {
      const r = await run(["getmouselocation"], null, POINTER.POINTER_READ_MS);
      return r.code === 0 && !r.timedOut ? parseLocation(r.out) : null;
    },
    play: async (script, timeoutMs) => {
      const r = await run(["-"], `${script.join("\n")}\n`, timeoutMs);
      const reason = playing?.child === r.child ? playing.reason : null;
      playing = null;
      if (reason) return reason;
      if (r.timedOut) return "timeout";
      const end = r.code === 0 ? parseLocation(r.out) : null;
      return end ? { end } : "fails";
    },
    kill: (reason) => { if (playing && !playing.reason) { playing.reason = reason; playing.child.kill("SIGKILL"); } },
  };
  return world;
}
