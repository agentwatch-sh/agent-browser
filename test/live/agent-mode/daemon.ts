// The live test's stand-in for the agentwatch daemon's bridge side (stage 4 builds the real one). It listens on a
// Unix socket for chrome-extension's live-test native host (test/live/host.py), which carries the agent package's
// native messages as NDJSON lines (contract C4), and it runs `agent-browser relay` as its child, whose standard input
// and output carry the bridge (C10). It sends each request to the receiver in C4 parts (PART_BYTES), joins the
// receiver's result parts, answers `not connected`, `disconnected` and `timeout` itself, and writes the link and
// allowlist lines. It applies one allowlist per scope (contract C4's set_scopes on channel main, the per-scope build of
// chrome-extension 0.3.x; board ab-v16.35): at each hello that lists the feature `scopes` it sends its current object,
// and after each `ok` answer on the current connection it writes that object to the relay as the allowlist line (C10).
// A receiver whose hello has no `scopes` gets the old set_allowlist with no domain, and the relay no line (C4, the
// rollout: fail closed). It logs ops, ids and sizes only. It can restart the relay with no link change, as
// agentwatch's backoff restart does (board ab-v16.40), stop the relay for a while, drop the link to the receiver, and
// write end_scope. With `peerCheck` (board ab-v16.51) it starts the relay with --peer-check and puts each session's
// roots into every allowlist line; a root change writes a line with the new roots and the last confirmed object at
// once, with no set_scopes (C10, C11: the roots' life). It answers the two daemon ops itself (board ab-v16.71; C10, the
// daemon's own ops; pointer-ops.ts): before its link checks, with xdotool on the harness's own private Xvfb only; with
// `pointer: "old"` it forwards them to the receiver, which answers `unknown op`, as a daemon from before that build.

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { PointerOps, xdotoolWorld, type Played } from "./pointer-ops.ts";

const PART_BYTES = 700_000;
const WAIT_SLACK_MS = 2000;
/** The daemon waits 10 s for a set_scopes answer (C4). */
const SET_SCOPES_WAIT_MS = 10_000;

/** The daemon ops: xdotool on the harness's own Xvfb (its display, its X auth file and its size), or "old": a daemon from before them. */
export type PointerOption = { display: string; xauth: string; size: { width: number; height: number } } | "old";
/** The fields of a set_scopes request (C4): lists by name, each scope's list name or null, and the default list. */
export type Scopes = { lists: Record<string, string[]>; scopes: Record<string, string | null>; default: string | null };
/** The receiver's answer to set_scopes: the scope rules in force, the tabs closed, the entries and names refused. */
export type ScopesAnswer = { ok: boolean; data?: { rules: number; closed: number; refused: number }; error?: string };

export class StandInDaemon {
  relay: ChildProcess;
  private readonly server: Server;
  private readonly o: { relaySocket: string; relayBin: string; relayLog: (line: string) => void; peerCheck?: boolean; pointer?: PointerOption };
  /** The daemon's own pointer ops on the harness's Xvfb (null: a daemon from before them, or no Xvfb of the harness). */
  private readonly pointer: { ops: PointerOps; world: ReturnType<typeof xdotoolWorld> } | null;
  /** The ids of the daemon ops that run (the duplicate-id check, C10). */
  private readonly daemonOps = new Set<string>();
  /** With the peer check: each session's roots, in every allowlist line. */
  private roots: Record<string, { pid: number; start: number }[]> = {};
  /** The last object that the receiver confirmed on the current connection (the line of a root change carries it). */
  private confirmed: Scopes | null = null;
  private version = "";
  private host: Socket | null = null;
  private bridgeUp = false;
  /** The hello of the current connection lists the feature `scopes` (C4). */
  private speaksScopes = false;
  /** The daemon's current object: the first set_scopes on each connection names every live session (C4, rule 1). */
  private current: Scopes;
  /** The set_scopes requests that wait for their answer: the object and the caller. */
  private readonly scopesReqs = new Map<string, { obj: Scopes; done: (a: ScopesAnswer) => void; timer: NodeJS.Timeout }>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly sent = new Map<string, { op: string; at: number }>();
  private readonly parts = new Map<string, string[]>();
  private nextMain = 1;
  private readonly own = new Map<string, (m: any) => void>();
  readonly log: string[] = [];
  /** Each set_scopes answer, in order (the live test reads `closed`). */
  readonly answers: { at: number; obj: Scopes; answer: ScopesAnswer }[] = [];

  constructor(o: { daemonSocket: string; relaySocket: string; relayBin: string; scopes: Scopes; relayLog: (line: string) => void; peerCheck?: boolean; pointer?: PointerOption }) {
    this.o = o;
    this.current = o.scopes;
    const world = o.pointer && o.pointer !== "old" ? xdotoolWorld(o.pointer) : null;
    this.pointer = world ? { ops: new PointerOps(world), world } : null;
    rmSync(o.daemonSocket, { force: true });
    this.server = createServer((sock) => this.onHost(sock));
    const umask = process.umask(0o077);
    try { this.server.listen(o.daemonSocket, () => chmodSync(o.daemonSocket, 0o600)); } finally { process.umask(umask); }
    this.relay = this.spawnRelay();
  }

  private spawnRelay(): ChildProcess {
    const relay = spawn(process.execPath, [this.o.relayBin, "relay", "--socket", this.o.relaySocket, ...(this.o.peerCheck ? ["--peer-check"] : [])], { stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: relay.stdout! }).on("line", (line) => this.fromRelay(line));
    createInterface({ input: relay.stderr! }).on("line", this.o.relayLog);
    return relay;
  }

  private note(text: string): void { this.log.push(`${new Date().toISOString()} ${text}`); }
  private toRelay(msg: object | string): void {
    // Not to a relay whose standard input ended (a restart): its late answers have no reader.
    if (this.relay.stdin?.writable) this.relay.stdin.write(`${typeof msg === "string" ? msg : JSON.stringify(msg)}\n`);
  }

  /**
   * Send `obj` as set_scopes and make it the current object. The answer comes after the receiver's rules are in force
   * and its sweep closed the tabs of each scope with no list (C4, C5); only an `ok` answer on the current connection
   * writes the allowlist line. No answer in 10 s counts as a failure, as for the real daemon.
   */
  setScopes(obj: Scopes): Promise<ScopesAnswer> {
    this.current = obj;
    return new Promise((resolve) => {
      if (!this.host || !this.speaksScopes) { resolve({ ok: false, error: "not connected" }); return; }
      const id = `m${this.nextMain++}`;
      const timer = setTimeout(() => { this.scopesReqs.delete(id); this.note(`set_scopes ${id} timeout`); resolve({ ok: false, error: "timeout" }); }, SET_SCOPES_WAIT_MS);
      this.scopesReqs.set(id, { obj, done: resolve, timer });
      this.toReceiver("main", { t: "req", id, op: "set_scopes", ...obj } as any);
    });
  }

  private onScopesAnswer(m: any): void {
    const req = this.scopesReqs.get(m.id);
    if (!req) return;
    this.scopesReqs.delete(m.id);
    clearTimeout(req.timer);
    const answer: ScopesAnswer = m.ok ? { ok: true, data: m.data } : { ok: false, error: String(m.error) };
    this.answers.push({ at: Date.now(), obj: req.obj, answer });
    this.note(`set_scopes ${m.id} ${m.ok ? `ok ${JSON.stringify(m.data)}` : `failed: ${m.error}`}`);
    // The relay applies C4's rules to the line, as the receiver did to set_scopes (C10).
    if (m.ok) { this.confirmed = req.obj; this.toRelay(this.lineOf(req.obj)); }
    req.done(answer);
  }

  /** The allowlist line of a confirmed object: with the peer check, with every session's roots. */
  private lineOf(obj: Scopes): object {
    return { t: "allowlist", ...obj, ...(this.o.peerCheck ? { roots: this.roots } : {}) };
  }

  /**
   * With the peer check: new roots (a launch, a respawned pane, a session's end). The line with them and the last
   * confirmed object goes at once, with no set_scopes round trip; before the first `ok` on the current connection the
   * roots go into the line that follows it (C11, the roots' life).
   */
  setRoots(roots: Record<string, { pid: number; start: number }[]>, o: { send?: boolean } = {}): void {
    this.roots = roots;
    // send false: the roots go with the next set_scopes's line (a session's end drops its scope and its roots in one line).
    if ((o.send ?? true) && this.confirmed && this.bridgeUp) this.toRelay(this.lineOf(this.confirmed));
  }

  /** A message to the receiver as C4 parts of its compact UTF-8 JSON. */
  private toReceiver(ch: "main" | "bridge", msg: { id: string }): boolean {
    if (!this.host) return false;
    const bytes = Buffer.from(JSON.stringify(msg));
    const n = Math.ceil(bytes.length / PART_BYTES);
    for (let seq = 0; seq < n; seq++) {
      const b64 = bytes.subarray(seq * PART_BYTES, (seq + 1) * PART_BYTES).toString("base64");
      this.host.write(`${JSON.stringify({ t: "part", ch, id: msg.id, seq, n, b64 })}\n`);
    }
    return true;
  }

  private answer(id: string, error: string): void {
    clearTimeout(this.pending.get(id));
    this.pending.delete(id);
    this.toRelay({ t: "res", ch: "bridge", id, ok: false, error });
  }

  private fromRelay(line: string): void {
    let req: any;
    try { req = JSON.parse(line); } catch { this.note(`dropped a relay line of ${line.length} bytes`); return; }
    if (req?.t !== "req" || typeof req.id !== "string" || typeof req.op !== "string") { this.note(`dropped a relay line of ${line.length} bytes`); return; }
    if (this.pending.has(req.id) || this.daemonOps.has(req.id)) { this.note(`dropped a relay line of ${line.length} bytes (its id waits)`); return; }
    // The daemon's own ops (C10): after the parse and the duplicate-id check, before the link checks, never to the receiver.
    if (req.op.startsWith("daemon.") && this.o.pointer !== "old") { this.daemonOp(req); return; }
    if (!this.bridgeUp) { this.toRelay({ t: "res", ch: "bridge", id: req.id, ok: false, error: "not connected" }); return; }
    const what = req.op === "debugger.sendCommand" ? `${req.op} ${req.args?.[1]} tab ${req.args?.[0]?.tabId}` : `${req.op}`;
    this.sent.set(req.id, { op: what, at: Date.now() });
    this.note(`req ${req.id} ${what}`);
    this.pending.set(req.id, setTimeout(() => { this.note(`timeout ${req.op} ${req.id}`); this.answer(req.id, "timeout"); }, (req.wait ?? 30_000) + WAIT_SLACK_MS));
    this.toReceiver("bridge", req);
  }

  /**
   * A daemon op (pointer-ops.ts): its answer goes to the relay that sent it, never to a relay that started after it (a
   * relay end kills the play: no answer). With no Xvfb of the harness: `no display`. It logs the op and the answer's
   * text, never a point.
   */
  private daemonOp(req: { id: string; op: string; args?: unknown; wait?: number }): void {
    const relay = this.relay, t0 = Date.now();
    this.daemonOps.add(req.id);
    const answer = this.pointer ? this.pointer.ops.answer(req as any) : Promise.resolve({ t: "res", ch: "bridge", id: req.id, ok: false, error: req.op === "daemon.pointerAt" || req.op === "daemon.movePointer" ? "no display" : "unknown op" });
    void answer.then((res) => {
      this.daemonOps.delete(req.id);
      this.note(`daemon ${req.op} ${req.id} ${res ? (res.ok ? "ok" : res.error) : "no answer"} after ${Date.now() - t0} ms`);
      if (res && this.relay === relay) this.toRelay(res);
    }, (e) => { this.daemonOps.delete(req.id); this.note(`daemon ${req.op} ${req.id} failed: ${(e as Error).message}`); });
  }

  /** The paths that the stand-in played (in memory only), for the live check's measure. */
  played(): Played[] { return this.pointer?.ops.played ?? []; }
  /** The count of each answer text of the daemon ops. */
  pointerCounts(): Record<string, number> { return Object.fromEntries(this.pointer?.ops.counts ?? []); }

  /** A res of channel bridge for the relay: the daemon passes it on unchanged, once. */
  private bridgeRes(line: string, id: string): void {
    if (!this.pending.has(id)) return;
    const s = this.sent.get(id);
    this.sent.delete(id);
    this.note(`res ${id} ${s?.op} after ${s ? Date.now() - s.at : "?"} ms`);
    clearTimeout(this.pending.get(id));
    this.pending.delete(id);
    this.toRelay(line);
  }

  private onHost(sock: Socket): void {
    if (this.host) { sock.destroy(); return; }
    this.host = sock;
    this.note("host connected");
    createInterface({ input: sock, crlfDelay: Infinity }).on("line", (line) => {
      let m: any;
      try { m = JSON.parse(line); } catch { return; }
      if (m.t === "hello") {
        this.note(`hello v${m.v} ${JSON.stringify(m.channels ?? [])}`);
        if (!Array.isArray(m.channels) || !m.channels.includes("bridge")) return;
        this.bridgeUp = true;
        this.version = m.version;
        this.speaksScopes = Array.isArray(m.features) && m.features.includes("scopes");
        this.toRelay({ t: "link", up: true, version: m.version });
        if (this.speaksScopes) void this.setScopes(this.current);
        else {
          // An old receiver: it blocks every site, and the relay gets no line, so it admits no connection (C4, the rollout).
          this.note("the receiver is too old for the per-repo allowlists (no feature scopes)");
          this.toReceiver("main", { t: "req", id: `m${this.nextMain++}`, op: "set_allowlist", domains: [] } as any);
        }
      } else if (m.t === "res" && m.ch === "bridge" && this.own.has(m.id)) { this.own.get(m.id)!(m); this.own.delete(m.id); }
      else if (m.t === "res" && m.ch === "bridge") this.bridgeRes(line, m.id);
      else if (m.t === "res" && this.scopesReqs.has(m.id)) this.onScopesAnswer(m);
      else if (m.t === "part" && m.ch === "bridge") {
        const got = this.parts.get(m.id) ?? [];
        got[m.seq] = m.b64;
        this.parts.set(m.id, got);
        if (got.filter((x) => x !== undefined).length === m.n) {
          this.parts.delete(m.id);
          this.bridgeRes(Buffer.concat(got.map((b) => Buffer.from(b, "base64"))).toString("utf8"), m.id);
        }
      } else if (m.t === "ev" && m.ch === "bridge") this.toRelay(line);
      else if (m.t === "blocked") this.note(`blocked tab ${m.tab}`);
    });
    sock.on("close", () => {
      this.note("host disconnected");
      if (this.host !== sock) return;
      this.host = null;
      // A link change kills a playing path: disconnected (C10, the kills).
      this.pointer?.world.kill("linkChange");
      for (const id of [...this.pending.keys()]) this.answer(id, "disconnected");
      // The answers of the old connection never come: the next connection's first set_scopes sends the current object.
      for (const [id, r] of this.scopesReqs) { clearTimeout(r.timer); this.scopesReqs.delete(id); r.done({ ok: false, error: "disconnected" }); }
      if (this.bridgeUp) this.toRelay({ t: "link", up: false });
      this.bridgeUp = false;
      this.speaksScopes = false;
      this.confirmed = null;
    });
  }

  /** A bridge request of the test itself (for example tabs.query, to know which tab is in front): its answer goes to the test, not to the relay. */
  ask(op: string, args: unknown[] = []): Promise<any> {
    const id = `live-${this.nextMain++}`;
    return new Promise((resolve, reject) => {
      this.own.set(id, (m) => (m.ok ? resolve(m.data ?? null) : reject(new Error(m.error))));
      if (!this.toReceiver("bridge", { t: "req", id, op, args, wait: 30_000 } as any)) reject(new Error("not connected"));
    });
  }

  /**
   * The relay ends (its standard input ends) and a new one starts, with no link change: agentwatch's backoff restart
   * of a relay that ended. As the real daemon, it turns the eager attach off, then writes the link-up line and the
   * list again to the new relay. The receiver sees no link change. Returns the old relay's exit code.
   */
  async restartRelay(whileDown?: () => Promise<void>): Promise<number | null> {
    const old = this.relay;
    const exited = new Promise<number | null>((r) => { if (old.exitCode !== null) r(old.exitCode); else old.once("exit", (code) => r(code)); });
    this.pointer?.world.kill("relayEnd"); // a relay end kills a playing path: no answer (C10)
    old.stdin!.end();
    const code = await Promise.race([exited, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
    for (const id of [...this.pending.keys()]) { clearTimeout(this.pending.get(id)); this.pending.delete(id); this.sent.delete(id); }
    if (this.bridgeUp) await this.ask("bridge.attachNew", [false]).catch(() => {});
    this.note(`relay restart (old exit ${code})`);
    // While no relay runs, for example: a session ends, so the daemon sends a set_scopes without it (the receiver sweeps).
    if (whileDown) await whileDown();
    this.relay = this.spawnRelay();
    if (this.bridgeUp) {
      this.toRelay({ t: "link", up: true, version: this.version });
      if (this.speaksScopes) void this.setScopes(this.current);
    }
    return code;
  }

  /** A short link drop (the orphan-tabs design, section 8): the daemon's side of the native host's socket closes; the host connects again 1 s later. */
  dropLink(): void { this.host?.destroy(); }

  /** The link is up and the receiver's latest set_scopes answered (or `ms` passed). */
  async linkUp(ms = 15_000): Promise<boolean> {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (this.bridgeUp && this.speaksScopes && !this.scopesReqs.size) return true;
    return false;
  }

  /** A line to the relay as it is (for example an allowlist line with session roots, which only a daemon with the peer check writes). */
  rawLine(msg: object): void { this.toRelay(msg); }

  /** The agentwatch session `scope` ended (C10's end_scope line). */
  endScope(scope: string): void { this.toRelay({ t: "end_scope", scope }); }

  /** The requests that still wait for their answer: op and age. */
  waiting(): string[] { return [...this.sent.entries()].map(([id, s]) => `${id} ${s.op} for ${Date.now() - s.at} ms`); }

  /** End the relay (its standard input ends) and the socket. */
  async stop(): Promise<number | null> {
    const exited = new Promise<number | null>((r) => { if (this.relay.exitCode !== null) r(this.relay.exitCode); else this.relay.once("exit", (code) => r(code)); });
    const within = (ms: number) => Promise.race([exited, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
    this.pointer?.world.kill("daemonStop");
    this.relay.stdin!.end();
    let code = await within(5000);
    // A relay that does not end with its standard input: SIGTERM, then SIGKILL.
    if (code === undefined) {
      this.note("the relay did not exit 5 s after its standard input ended");
      this.relay.kill("SIGTERM");
      if ((await within(2000)) === undefined) { this.relay.kill("SIGKILL"); await within(2000); }
      code = null;
    }
    this.host?.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
    return code;
  }
}
