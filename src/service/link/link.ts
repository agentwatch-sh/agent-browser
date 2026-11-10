// The native link of `agent-browser service` (stage 1b part 2 of the self-contained agent browser, board ab-v16.94.9;
// the design, sections 5.1 "The native link", 5.3 and 5.4; contract C4 in chrome-extension's docs/protocol.md; a port
// of agentwatch's daemon/browser/link.py, ReceiverLink). The host shim (host.ts) connects to the link socket, a Unix
// socket of mode 0600 in the service's run folder. The link admits one peer: the peer check (peer.ts of this folder)
// says that the shim's parent is the service's Chrome, by pid and start time, on the agent profile. A new valid
// connection replaces the old one.
//
// The link carries C4's two channels:
// - channel main: the service's own requests (set_scopes and import), one at a time, as parts with no `ch`; the wait
//   counts from the send, and a timeout before the last part is written drops the connection;
// - channel bridge: the model's bridge (C10, carrier.ts), only to a receiver whose latest hello on the connection lists
//   `bridge` in `channels`.
// One writer per connection sends the queued parts of both channels in turn, main first, so an import that runs for
// 120 s never holds a bridge message back, and a large bridge message never holds a main request back. The parts of
// one channel never interleave.
//
// The reader reads each line itself, at most MAX_TO_DAEMON bytes without the newline (C4); a longer line, or a line
// that is not a JSON object, drops the connection. A res, ev or part with "ch":"bridge" goes to the carrier. A
// `blocked` notice goes to the service's prompts with its scope and from. The hello's `features` say what the receiver
// takes: `scopes` is set_scopes (the receiver port's up). No log line holds a message's body.

import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { ReceiverError, type Blocked, type ReceiverEvents, type ReceiverPort } from "../receiver.ts";
import type { AllowlistLine } from "../lists/scopes.ts";
import type { Carrier } from "./carrier.ts";
import { splitParts, type Part } from "./parts.ts";

/** C4's MAX_TO_DAEMON: a receiver line holds at most this many bytes without its newline; a longer line drops the link. */
export const MAX_TO_DAEMON = 8 * 1024 * 1024;
export const SCOPES_FEATURE = "scopes";
const MAX_HOST_CHARS = 253;
const MAX_ERROR_CHARS = 500;
const RESERVED = new Set(["t", "id", "op"]);
const REFUSED_LOG_MS = 60_000;
const BRIDGE_KINDS = new Set(["res", "ev", "part"]);
export const NOT_CONNECTED_TEXT = "the agent extension is not connected";
export const DISCONNECTED_TEXT = "the agent extension disconnected";
export const NO_RESULT_TEXT = "the receiver sent no result object";

/** The link's peer check at each accept: ok with the shim's pid, or the reason of a refusal (logged at most once a minute). */
export type LinkPeerCheck = (socket: Socket) => Promise<{ ok: true; pid: number } | { ok: false; reason: string }>;

type Msg = { lines: string[]; next: number; done: boolean };
type Conn = {
  socket: Socket; bridge: boolean; features: ReadonlySet<string>; scopesUp: boolean; version: string | null;
  mainOut: Msg[]; bridgeOut: Msg[]; wake: (() => void) | null; closed: boolean;
};
type Pending = { id: string; op: string; conn: Conn; resolve: (d: Record<string, unknown>) => void; reject: (e: ReceiverError) => void; settled: boolean };

const bounded = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= MAX_HOST_CHARS ? v : null);
const lineOf = (p: Part) => `${JSON.stringify(p)}\n`;

export type LinkOptions = {
  /** The link socket's path. */
  path: string;
  peer: LinkPeerCheck;
  log: (line: string) => void;
  /** The model's bridge (C10): the link's channel bridge goes to it. */
  carrier?: Carrier;
  clock?: () => number;
  /** A new id of channel main (tests give a fixed one). */
  newId?: () => string;
};

export class NativeLink {
  private readonly o: LinkOptions;
  private readonly clock: () => number;
  private server: Server | null = null;
  private conn: Conn | null = null;
  private pending: Pending | null = null;
  /** Channel main runs one request at a time: each request waits for the one before. */
  private mainChain: Promise<unknown> = Promise.resolve();
  private events: ReceiverEvents | null = null;
  private refused = 0;
  private lastRefusedLog: number | null = null;
  private inode: number | null = null;
  private nextId = 1;
  private lastSendEnd = -Infinity;
  private readonly accepted = new Set<Socket>();

  constructor(o: LinkOptions) {
    this.o = o;
    this.clock = o.clock ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  }

  /** The receiver port's handlers (stage 1c's lists, scopes, prompts and sign-ins). */
  attach(events: ReceiverEvents): void { this.events = events; }

  // ------------------------------------------------------------------ the life

  /** Listen on the link socket: mode 0600, created private (no moment in which another user could connect). */
  async start(): Promise<void> {
    const dir = dirname(this.o.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    rmSync(this.o.path, { force: true });
    const server = createServer((s) => void this.onConnect(s));
    const umask = process.umask(0o077);
    try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.o.path, () => { server.off("error", reject); resolve(); }); }); }
    finally { process.umask(umask); }
    chmodSync(this.o.path, 0o600);
    this.inode = statSync(this.o.path).ino;
    this.server = server;
  }

  /** Close the socket and the connection; remove the socket file only while it is still this link's. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (this.conn) this.drop(this.conn);
    for (const s of this.accepted) s.destroy();
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (this.inode !== null && statSync(this.o.path, { throwIfNoEntry: false })?.ino === this.inode) rmSync(this.o.path, { force: true });
  }

  /** Wait at most `ms` until the writer has sent every queued part (the service's stop, before the link closes). */
  async flush(ms: number): Promise<void> {
    const end = this.clock() + ms;
    while (this.conn && (this.conn.mainOut.length || this.conn.bridgeOut.length) && this.clock() < end) await new Promise((r) => setTimeout(r, 10));
  }

  // ------------------------------------------------------------------ the state

  /** A shim holds a connection. */
  connected(): boolean { return this.conn !== null; }
  /** The receiver's version of the current connection's latest hello, or null. */
  version(): string | null { return this.conn?.version ?? null; }
  /** A receiver holds a linked connection: its hello came on it. */
  ready(): boolean { return this.conn !== null && this.conn.version !== null; }
  bridgeReady(): boolean { return this.conn?.bridge ?? false; }
  features(): ReadonlySet<string> { return this.conn?.features ?? new Set(); }
  /** The current connection's latest hello lists `scopes` (a receiver that takes set_scopes, C4). */
  scopesReady(): boolean { return this.features().has(SCOPES_FEATURE); }
  /** A main request runs on a live link (the fail-closed watch does not count that time). */
  busy(): boolean { return this.pending !== null && !this.pending.settled && this.conn !== null; }
  /** An import runs. */
  importing(): boolean { return this.busy() && this.pending!.op === "import"; }
  /** ms since the last import ended (the Chrome move waits a while after a send). */
  sinceSend(): number { return this.clock() - this.lastSendEnd; }

  // ------------------------------------------------------------------ channel main

  /**
   * One request of channel main: `{t:"req",id,op,...body}` in parts with no `ch`, after the request before it, with its
   * wait counted from the send. It resolves with the res's data (an object); it rejects with a ReceiverError: `refused`
   * (ok:false, with the receiver's text), `timeout` (no answer in the wait; a timeout before the last part is written
   * drops the connection), `dropped` (the connection dropped while it ran) or `down` (no connection: nothing went).
   */
  request(op: string, body: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>> {
    for (const k of Object.keys(body)) if (RESERVED.has(k)) return Promise.reject(new Error("a request's body may not use the keys t, id or op"));
    if (!this.conn) return Promise.reject(new ReceiverError("down", NOT_CONNECTED_TEXT));
    const run = () => this.requestNow(op, body, waitMs);
    const p = this.mainChain.then(run, run);
    this.mainChain = p.catch(() => {});
    return p;
  }

  private requestNow(op: string, body: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>> {
    const conn = this.conn;
    if (!conn) return Promise.reject(new ReceiverError("down", NOT_CONNECTED_TEXT));
    const id = this.o.newId?.() ?? `m${process.pid.toString(36)}-${(this.nextId++).toString(36)}`;
    const msg: Msg = { lines: splitParts(id, { t: "req", id, op, ...body }).map(lineOf), next: 0, done: false };
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const end = () => {
        if (timer) clearTimeout(timer);
        if (this.pending === p) this.pending = null;
        if (!msg.done) { const i = conn.mainOut.indexOf(msg); if (i >= 0) conn.mainOut.splice(i, 1); }
        if (op === "import") this.lastSendEnd = this.clock();
      };
      const p: Pending = {
        id, op, conn, settled: false,
        resolve: (d) => { if (p.settled) return; p.settled = true; end(); resolve(d); },
        reject: (e) => { if (p.settled) return; p.settled = true; end(); reject(e); },
      };
      this.pending = p;
      conn.mainOut.push(msg);
      conn.wake?.();
      timer = setTimeout(() => {
        const sent = msg.done;
        p.reject(new ReceiverError("timeout", "timeout"));
        // The receiver would otherwise hold a half-sent request: a timeout before the last part drops the connection.
        if (!sent) this.drop(conn);
      }, waitMs);
    });
  }

  // ------------------------------------------------------------------ channel bridge

  /** Queue one bridge message (its parts, each with "ch":"bridge"); false when no connection's latest hello lists `bridge`. */
  sendBridge(parts: Part[]): boolean {
    if (!parts.length || parts.some((p) => p.ch !== "bridge")) throw new Error('a bridge message is one or more parts with "ch":"bridge"');
    const c = this.conn;
    if (!c || !c.bridge) return false;
    c.bridgeOut.push({ lines: parts.map(lineOf), next: 0, done: false });
    c.wake?.();
    return true;
  }

  /** Write the queued parts of both channels in turn: one part of each channel's head message, main first. */
  private async writeLoop(c: Conn): Promise<void> {
    try {
      while (!c.closed) {
        let wrote = false;
        for (const q of [c.mainOut, c.bridgeOut]) {
          if (!q.length || c.closed) continue;
          const m = q[0];
          const line = m.lines[m.next++];
          const last = m.next === m.lines.length;
          if (last) q.shift();
          if (!c.socket.write(line)) await new Promise<void>((r) => { const done = () => { c.socket.off("drain", done); c.socket.off("close", done); r(); }; c.socket.once("drain", done); c.socket.once("close", done); });
          if (last) m.done = true;
          wrote = true;
        }
        if (!wrote && !c.closed) await new Promise<void>((r) => { c.wake = () => { c.wake = null; r(); }; });
      }
    } catch { this.drop(c); }
  }

  // ------------------------------------------------------------------ connections

  private drop(c: Conn): void {
    if (c.closed) return;
    c.closed = true;
    const wasCurrent = this.conn === c;
    if (wasCurrent) this.conn = null;
    c.socket.destroy();
    c.mainOut.length = 0; c.bridgeOut.length = 0;
    c.wake?.();
    const p = this.pending;
    if (p && p.conn === c) p.reject(new ReceiverError("dropped", DISCONNECTED_TEXT));
    if (c.bridge) { c.bridge = false; this.safe(() => this.o.carrier?.linkDown()); }
    if (c.scopesUp) { c.scopesUp = false; this.safe(() => this.events?.down()); }
  }

  private noteRefused(reason: string): void {
    this.refused++;
    const now = this.clock();
    if (this.lastRefusedLog === null || now - this.lastRefusedLog >= REFUSED_LOG_MS) {
      this.o.log(`link: refused ${this.refused} peer(s) since the last line (${reason})`);
      this.refused = 0;
      this.lastRefusedLog = now;
    }
  }

  private async onConnect(socket: Socket): Promise<void> {
    // No byte is read before the peer check: the socket stays paused until it admits the peer.
    socket.pause();
    this.accepted.add(socket);
    socket.on("error", () => {});
    let verdict: Awaited<ReturnType<LinkPeerCheck>>;
    try { verdict = await this.o.peer(socket); } catch (e) { verdict = { ok: false, reason: `the peer check failed (${(e as Error).name})` }; }
    this.accepted.delete(socket);
    if (!this.server || socket.destroyed) { socket.destroy(); return; }
    if (!verdict.ok) { this.noteRefused(verdict.reason); socket.destroy(); return; }
    const c: Conn = { socket, bridge: false, features: new Set(), scopesUp: false, version: null, mainOut: [], bridgeOut: [], wake: null, closed: false };
    if (this.conn) this.drop(this.conn);
    this.conn = c;
    this.o.log(`link: the host shim connected (pid ${verdict.pid})`);
    void this.writeLoop(c);
    // The chunks of the line that has no end yet: they are joined once, when its newline comes.
    let chunks: Buffer[] = [], have = 0;
    const tooLong = () => { this.o.log(`link: a receiver line above ${MAX_TO_DAEMON} bytes; the link drops`); this.drop(c); };
    socket.on("data", (d: Buffer) => {
      for (let at = 0; !c.closed;) {
        const i = d.indexOf(10, at);
        if (i < 0) {
          const rest = d.subarray(at);
          if (rest.length) { chunks.push(rest); have += rest.length; }
          if (have > MAX_TO_DAEMON) tooLong();
          return;
        }
        const tail = d.subarray(at, i);
        const raw = chunks.length ? Buffer.concat([...chunks, tail]) : tail;
        chunks = []; have = 0; at = i + 1;
        if (raw.length > MAX_TO_DAEMON) { tooLong(); return; }
        let msg: unknown = null;
        try { msg = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch {}
        if (msg === null || typeof msg !== "object" || Array.isArray(msg)) { this.o.log(`link: a receiver line of ${raw.length} bytes is not a JSON object; the link drops`); this.drop(c); return; }
        this.handle(c, msg as Record<string, unknown>);
      }
    });
    socket.once("close", () => this.drop(c));
    socket.resume();
  }

  private safe(f: () => void): void {
    try { f(); } catch (e) { this.o.log(`link: a handler failed (${(e as Error).name})`); }
  }

  private handle(c: Conn, msg: Record<string, unknown>): void {
    if (c !== this.conn) return; // a replaced connection's lines
    const kind = msg.t;
    if (typeof kind !== "string") return;
    if ("ch" in msg && msg.ch !== "main") {
      if (msg.ch === "bridge" && c.bridge && BRIDGE_KINDS.has(kind)) this.safe(() => this.o.carrier?.message(msg));
      return; // any other channel is ignored
    }
    if (kind === "hello") this.hello(c, msg);
    else if (kind === "res") {
      const p = this.pending;
      if (!p || p.conn !== c || msg.id !== p.id || p.settled) return;
      if (msg.ok === true) {
        const data = msg.data;
        if (data !== null && typeof data === "object" && !Array.isArray(data)) p.resolve(data as Record<string, unknown>);
        else p.reject(new ReceiverError("refused", NO_RESULT_TEXT));
      } else {
        const text = typeof msg.error === "string" && msg.error ? msg.error : "the request failed";
        p.reject(new ReceiverError("refused", text.slice(0, MAX_ERROR_CHARS)));
      }
    } else if (kind === "blocked") {
      const host = bounded(msg.host);
      // scope: the tab's scope, null for a tab of no scope; from: the tab's last listed host, null for none (C4).
      if (host !== null) { const b: Blocked = { host, scope: bounded(msg.scope), from: bounded(msg.from) }; this.safe(() => this.events?.blocked(b)); }
    }
  }

  private hello(c: Conn, msg: Record<string, unknown>): void {
    const version = msg.version;
    if (typeof version !== "string") return;
    c.version = version;
    const features = msg.features;
    c.features = new Set(Array.isArray(features) ? features.filter((f): f is string => typeof f === "string") : []);
    const bridge = Array.isArray(msg.channels) && msg.channels.includes("bridge");
    if (bridge !== c.bridge) {
      c.bridge = bridge;
      if (!bridge) c.bridgeOut.length = 0; // the receiver no longer takes the bridge: nothing more of it goes
      this.safe(() => (bridge ? this.o.carrier?.linkUp(version) : this.o.carrier?.linkDown()));
    }
    // Each hello that lists `scopes` is a new link for stage 1c (its push goes again); one without it ends the last.
    if (c.features.has(SCOPES_FEATURE)) { c.scopesUp = true; this.safe(() => this.events?.up()); }
    else if (c.scopesUp) { c.scopesUp = false; this.safe(() => this.events?.down()); }
    this.o.log(`link: the receiver ${version} said hello (${bridge ? "bridge" : "no bridge"}, ${c.features.has(SCOPES_FEATURE) ? "scopes" : "no scopes"})`);
  }
}

/** Stage 1c's receiver port on the real link: set_scopes and import on channel main, the allowlist and end_scope lines to the model. */
export class LinkReceiverPort implements ReceiverPort {
  private readonly link: NativeLink;
  private readonly carrier: Carrier | null;
  private events: ReceiverEvents | null = null;
  constructor(link: NativeLink, carrier: Carrier | null) { this.link = link; this.carrier = carrier; }
  attach(events: ReceiverEvents): void { this.events = events; this.link.attach(events); }
  isUp(): boolean { return this.link.connected() && this.link.scopesReady(); }
  request(op: "set_scopes" | "import", body: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>> {
    if (!this.isUp()) return Promise.reject(new ReceiverError("down", NOT_CONNECTED_TEXT));
    return this.link.request(op, body, waitMs);
  }
  allowlist(line: AllowlistLine): void { this.carrier?.allowlist(line as unknown as Record<string, unknown>); }
  endScope(scope: string): void { this.carrier?.endScope(scope); }
  /** The model's daemon.blocked (C10): the same handler as the receiver's notice. */
  blocked(b: Blocked): void { this.events?.blocked(b); }
}
