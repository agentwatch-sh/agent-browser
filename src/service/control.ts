// The control door of `agent-browser service` (contract C12, docs/contracts/C12.md, the master; board ab-v16.94.2,
// stage 1a of the self-contained agent browser). A Unix socket, control.sock, with mode 0600 in a folder of mode 0700.
// Only the agentwatch daemon process connects (the admission: admission.ts). After the admission each side sends its
// hello; then the daemon sends requests, and the service sends one answer for each request and the events. One JSON
// object per line, in compact UTF-8, of at most CONTROL_MAX_LINE bytes with its newline.
//
// This file holds the door and the rules of its lines; it knows no op's work. A Handler (the stage 1a service in
// service.ts, the fake in fake.ts) does each op after the door's checks, in C12's order: the op (`unsupported`), the
// shape of `by` and of the fields (`bad request`), then the kind (`not the operator`, else `bad request`).
//
// The log rule (C12): no log line holds page content, a cookie, a URL path, a payload, a token or a token's fingerprint
// (`mcp_token` of set_sessions, the token design). The door logs the admission's
// result, each act with its provenance (the op, the kind, the user and the via; never a field), and the closes. A line
// that the door refuses for its size or its shape is never logged.

import { chmodSync, lstatSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { socketAlive } from "../proxy.ts";
import { SCOPE } from "../relay/scopes.ts";

/** The longest line, with its newline: the 33,554,432 bytes of a C2 payload and 64 KiB more (C12, the door). */
export const CONTROL_MAX_LINE = 33_619_968;

export const KINDS = ["operator", "token", "daemon"] as const;
export const VIAS = ["web", "send", "cli", "config", "daemon"] as const;
export type By = { kind: (typeof KINDS)[number]; user: string; via: (typeof VIAS)[number] };
export type Req = { t: "req"; id: string; op: string; by: By; [field: string]: unknown };
export const ERR = { unsupported: "unsupported", bad: "bad request", notOperator: "not the operator", gone: "this prompt is gone", noSession: "no such session" } as const;
/** agentwatch's user pattern (C12, provenance): no newline and no control character reaches a log line from `user`. */
export const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
/** At most this many admissions run at a time (C12, who connects); one more connection is refused. */
export const MAX_ADMISSIONS = 4;
export const admissionLimitText = (n: number) => `The control door checks ${n} other connections now, so it refuses this one: connect again.`;

const OWN = ["daemon"] as const, ACT = ["operator"] as const, START = ["operator", "token"] as const;
/** Each op of C12's table: its fields (the shape step) and the kinds that it takes (null: any kind, the reads). */
export const OPS: Readonly<Record<string, { readonly fields: readonly string[]; readonly kinds: readonly string[] | null }>> = {
  config: { fields: ["enabled", "control", "chrome_bin", "chrome_args"], kinds: OWN },
  set_sessions: { fields: ["sessions", "remote", "box"], kinds: OWN },
  session_ended: { fields: ["scope"], kinds: OWN },
  launch_check: { fields: ["scope"], kinds: OWN },
  list_set: { fields: ["list", "add", "remove"], kinds: ACT },
  prompt_allow: { fields: ["prompt", "host", "list"], kinds: ACT },
  prompt_dismiss: { fields: ["prompt"], kinds: ACT },
  import: { fields: ["payload"], kinds: ACT },
  start: { fields: [], kinds: START },
  stop: { fields: [], kinds: START },
  status: { fields: [], kinds: null },
  lists_get: { fields: [], kinds: null },
  prompts_get: { fields: [], kinds: null },
  endpoint: { fields: ["scope"], kinds: null },
  sender: { fields: [], kinds: null },
};
/** The reads: no act, so the door does not log them. */
export const READS: ReadonlySet<string> = new Set(["status", "lists_get", "prompts_get", "endpoint", "sender"]);

/** Each event of C12's event table and its fields (`stopped` with the reason `stop` also has `by`). */
export const EVENTS: Readonly<Record<string, readonly string[]>> = {
  ready: ["chrome_pid", "chrome_version", "extension_version", "endpoint"],
  prompt: ["id", "state", "host", "scope", "list", "from", "warnings"],
  stopped: ["reason"],
  chrome: ["version", "update"],
  error: ["op", "user", "domain", "counts"],
};

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");
const text1 = (x: unknown) => typeof x === "string" && x.length > 0;
const scope = (x: unknown) => typeof x === "string" && SCOPE.test(x);
const strOrNull = (x: unknown) => x === null || typeof x === "string";
const isRoot = (r: unknown) => isObj(r) && Number.isSafeInteger(r.pid) && (r.pid as number) >= 2 && Number.isSafeInteger(r.start) && (r.start as number) >= 0;
/** `mcp_token` (the token design): null, or the fingerprint of a connection token, the 64 lowercase hex digits of a SHA-256. */
export const FINGERPRINT = /^[0-9a-f]{64}$/;
const fingerprintOrNull = (x: unknown) => x === null || (typeof x === "string" && FINGERPRINT.test(x));

/** C12's field rules (the shape step), one field at a time: false when the field breaks its rule. */
export function fieldFits(f: string, v: unknown): boolean {
  switch (f) {
    case "scope": case "list": return scope(v);
    case "sessions": return Array.isArray(v) && v.every((s) => isObj(s) && scope(s.scope) && strOrNull(s.repo) && Array.isArray(s.roots) && s.roots.every(isRoot) && strOrNull(s.cgroup) && strOrNull(s.lifetime_id) && fingerprintOrNull(s.mcp_token));
    case "remote": return Array.isArray(v) && v.every((x) => isObj(x) && typeof x.scope === "string" && typeof x.box === "string" && typeof x.list === "string" && fingerprintOrNull(x.mcp_token));
    case "box": return isObj(v) && strings(v.hosts) && strings(v.cookie_names);
    case "enabled": case "control": return typeof v === "boolean";
    case "chrome_bin": return strOrNull(v);
    case "chrome_args": case "add": case "remove": return strings(v);
    case "prompt": case "host": return text1(v);
    case "payload": return isObj(v);
    default: return true;
  }
}

/**
 * C12's rules of a whole snapshot (the token design): one fingerprint at most once in `sessions` and `remote` together,
 * one scope at most once in `sessions` and one remote scope at most once in `remote`, and no fingerprint on an item whose
 * `lifetime_id` is null. Only for a request whose fields passed fieldFits.
 */
export function snapshotFits(req: Record<string, unknown>): boolean {
  const sessions = req.sessions as Record<string, unknown>[], remote = req.remote as Record<string, unknown>[];
  const once = (xs: unknown[]) => new Set(xs).size === xs.length;
  const prints = [...sessions, ...remote].map((x) => x.mcp_token).filter((t) => t !== null);
  return once(prints) && once(sessions.map((s) => s.scope)) && once(remote.map((x) => x.scope)) && sessions.every((s) => s.lifetime_id !== null || s.mcp_token === null);
}

/** The shape of provenance (R7): exactly `kind`, `user` and `via`, each of its set. */
export function byFits(by: unknown): by is By {
  return isObj(by) && Object.keys(by).length === 3 && (KINDS as readonly unknown[]).includes(by.kind) && typeof by.user === "string" && USER.test(by.user) && (VIAS as readonly unknown[]).includes(by.via);
}

/** C12's order of the checks: the op (`has`: the ops that this service has), the shape, then the kind; null passes. */
export function checkRequest(req: Record<string, unknown>, has: (op: string) => boolean): string | null {
  const op = typeof req.op === "string" && Object.hasOwn(OPS, req.op) && has(req.op) ? OPS[req.op] : null;
  if (!op) return ERR.unsupported;
  if (!byFits(req.by) || !op.fields.every((f) => Object.hasOwn(req, f) && fieldFits(f, req[f]))) return ERR.bad;
  if (req.op === "set_sessions" && !snapshotFits(req)) return ERR.bad;
  if (op.kinds !== null && !op.kinds.includes((req.by as By).kind)) return op.kinds === ACT ? ERR.notOperator : ERR.bad;
  return null;
}

/** An event of C12's table with exactly its fields, and a `by` of the right shape for a stop (the fake's standard input). */
export function eventFits(ev: unknown): boolean {
  if (!isObj(ev) || ev.t !== "ev" || typeof ev.ev !== "string" || !Object.hasOwn(EVENTS, ev.ev)) return false;
  const want = ["t", "ev", ...EVENTS[ev.ev], ...(ev.ev === "stopped" && ev.reason === "stop" ? ["by"] : [])].sort();
  const keys = Object.keys(ev).sort();
  return keys.length === want.length && keys.every((k, i) => k === want[i]) && (ev.by === undefined || byFits(ev.by));
}

/** One line: compact JSON (JSON.stringify writes each character that UTF-8 holds as it is) and a newline. */
export const encodeLine = (o: unknown) => `${JSON.stringify(o)}\n`;

/** The service's hello (C12, the hello). `commit` is for the daemon's pin check only. */
export const serviceHello = (version: string, commit: string | null, features: readonly string[]) =>
  ({ t: "hello", v: 1, side: "service", version, commit, features: [...features] });

/** The answer of an op that passed the door's checks: its data, or an error of C12 (`this prompt is gone`). */
export type Answer = { data: Record<string, unknown> } | { error: string };

/** What a service does with each op (the stage 1a service, the fake). */
export interface Handler {
  readonly hello: Record<string, unknown>;
  /** The ops that this service has; each other op gets `unsupported`. */
  has(op: string): boolean;
  /** An op that passed the door's checks; an op that waits (stage 1c's import) answers with a promise. */
  handle(req: Req): Answer | Promise<Answer>;
  /** The door gives the handler its event stream at the open. */
  attach?(emit: (ev: Record<string, unknown>) => void): void;
}

/** The admission of one accepted socket: it reads the peer at once (before any await), then decides. */
export type Admit = (socket: Socket) => Promise<{ ok: true; pid?: number } | { ok: false; reason: string }>;

export type ControlDoorOptions = { path: string; admit: Admit; handler: Handler; log: (line: string) => void; maxLine?: number; maxAdmissions?: number };

/** One line reader with C12's limit: `onLine` gets each line's bytes (no newline); `onTooLong` ends the reading. */
export class LineReader {
  private parts: Buffer[] = [];
  private size = 0;
  private done = false;
  private readonly max: number;
  private readonly onLine: (line: Buffer) => boolean;
  private readonly onTooLong: () => void;
  /** `onLine` returns false to stop the reading (the connection closes). */
  constructor(max: number, onLine: (line: Buffer) => boolean, onTooLong: () => void) { this.max = max; this.onLine = onLine; this.onTooLong = onTooLong; }

  push(chunk: Buffer): void {
    let at = 0;
    while (!this.done && at < chunk.length) {
      const nl = chunk.indexOf(10, at);
      const end = nl < 0 ? chunk.length : nl;
      // A line holds at most max - 1 bytes before its newline.
      if (this.size + (end - at) > this.max - 1) { this.done = true; this.parts = []; this.onTooLong(); return; }
      if (nl < 0) { this.parts.push(chunk.subarray(at)); this.size += chunk.length - at; return; }
      const line = this.parts.length ? Buffer.concat([...this.parts, chunk.subarray(at, nl)]) : chunk.subarray(at, nl);
      this.parts = []; this.size = 0; at = nl + 1;
      if (!this.onLine(line)) { this.done = true; return; }
    }
  }
}

/** Strict UTF-8 (C12, the lines): bytes that are not UTF-8 throw, and a byte order mark stays in the text (so JSON.parse refuses it). */
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `pending`: the answers that the connection still waits for; `ended`: the peer ended its side, and the door closes after them. */
type Conn = { n: number; socket: Socket; ready: boolean; pending: number; ended: boolean };

export class ControlDoor {
  readonly path: string;
  private readonly server: Server;
  private readonly o: ControlDoorOptions;
  private readonly conns = new Set<Conn>();
  /** Every socket that is still open, also a refused one that waits for its close. */
  private readonly sockets = new Set<Socket>();
  private readonly inode: number;
  private count = 0;
  /** The admissions that run now (MAX_ADMISSIONS). */
  private checking = 0;
  private stopping: Promise<void> | undefined;
  /** Events emitted while an op runs go out after its answer. */
  private handling: Record<string, unknown>[] | null = null;

  private constructor(o: ControlDoorOptions, server: Server, inode: number) {
    this.o = o; this.path = o.path; this.server = server; this.inode = inode;
  }

  /**
   * Listen on `path`: its folder is created with mode 0700, or it must be a folder of this user that no other user can
   * enter; a socket that another process serves stops the open; the socket is created private (mode 0600).
   */
  static async open(o: ControlDoorOptions): Promise<ControlDoor> {
    if (Buffer.byteLength(o.path) > 103) throw new Error(`the control door's path is longer than 103 bytes: ${o.path}`);
    const dir = dirname(o.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.uid !== process.getuid!() || (st.mode & 0o077) !== 0) throw new Error(`the control door's folder must be a folder of this user with mode 0700: ${dir}`);
    if (await socketAlive(o.path)) throw new Error(`a service already serves ${o.path}`);
    rmSync(o.path, { force: true });
    let door!: ControlDoor;
    // allowHalfOpen: a peer that ends its side still gets the answers that the door owes it (the door ends its side after them).
    const server = createServer({ pauseOnConnect: true, allowHalfOpen: true }, (socket) => door.accept(socket));
    const umask = process.umask(0o077);
    try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(o.path, resolve); }); }
    finally { process.umask(umask); }
    chmodSync(o.path, 0o600);
    door = new ControlDoor(o, server, statSync(o.path).ino);
    o.handler.attach?.((ev) => { door.emit(ev); });
    o.log(`control: ready on ${o.path}`);
    return door;
  }

  /** Send an event to each connection past the hellos; the number of connections that got it. No event is kept. */
  emit(ev: Record<string, unknown>): number {
    if (this.handling) { this.handling.push(ev); return 0; }
    let n = 0;
    for (const c of this.conns) if (c.ready && !c.socket.destroyed) { c.socket.write(encodeLine(ev)); n++; }
    return n;
  }

  private close(c: Conn, why: string): void {
    if (!this.conns.has(c)) return;
    this.conns.delete(c);
    c.socket.destroy();
    this.o.log(`control: connection ${c.n} closed: ${why}`);
  }

  /** The peer's end of the stream, with no answer owed: end the socket, so that the answers already written still go
   * out whole (a destroy drops the bytes that the socket has not sent yet; review-102 B1). */
  private finish(c: Conn): void {
    if (!this.conns.has(c)) return;
    this.conns.delete(c);
    c.socket.end();
    this.o.log(`control: connection ${c.n} closed: the end of the stream`);
  }

  private accept(socket: Socket): void {
    const c: Conn = { n: ++this.count, socket, ready: false, pending: 0, ended: false };
    this.conns.add(c);
    this.sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => { this.conns.delete(c); this.sockets.delete(socket); });
    // At most maxAdmissions checks at a time: one more connection gets the refused line with its reason.
    const limit = this.o.maxAdmissions ?? MAX_ADMISSIONS;
    let admission: ReturnType<Admit>;
    if (this.checking >= limit) admission = Promise.resolve({ ok: false, reason: admissionLimitText(limit) });
    else {
      this.checking++;
      // The admission reads the peer now, at the accept, before the door reads any byte.
      try { admission = this.o.admit(socket); } catch (e) { admission = Promise.resolve({ ok: false, reason: `The control door cannot check the program that connects (${(e as Error).message}), so it admits no connection.` }); }
      admission = admission.finally(() => { this.checking--; });
    }
    void admission.then((r) => {
      if (!this.conns.has(c)) return;
      if (!r.ok) {
        this.conns.delete(c);
        socket.end(encodeLine({ t: "refused", reason: r.reason }));
        setTimeout(() => socket.destroy(), 1000).unref();
        this.o.log(`control: connection ${c.n} refused: ${r.reason}`);
        return;
      }
      this.o.log(`control: connection ${c.n} admitted${r.pid !== undefined ? ` (pid ${r.pid})` : ""}`);
      socket.write(encodeLine(this.o.handler.hello));
      this.read(c);
    }, (e) => { this.close(c, `the admission failed (${(e as Error).message})`); });
  }

  private read(c: Conn): void {
    let helloRead = false;
    const reader = new LineReader(this.o.maxLine ?? CONTROL_MAX_LINE, (bytes) => {
      // A CR (a line that ends in CR LF, say) breaks the compact-line rule.
      if (bytes.includes(13)) { this.close(c, "a line that is not compact (it holds a CR)"); return false; }
      let msg: unknown;
      try { msg = JSON.parse(utf8.decode(bytes)); } catch { this.close(c, "a line that is not a JSON object"); return false; }
      if (!isObj(msg)) { this.close(c, "a line that is not a JSON object"); return false; }
      if (!helloRead) {
        if (msg.t === "hello") {
          if (msg.v !== 1) { this.close(c, "a hello whose v is not 1"); return false; }
          if (msg.side !== "daemon") { this.close(c, "a hello whose side is not daemon"); return false; }
          helloRead = true; c.ready = true;
          return true;
        }
        if (msg.t === "req") { this.close(c, "a request before the daemon's hello"); return false; }
        return true;
      }
      if (msg.t !== "req") return true; // a line whose t the door does not take (a newer side's line, a res, an ev)
      if (typeof msg.id !== "string") { this.close(c, "a request with no string id"); return false; }
      this.request(c, msg);
      return true;
    }, () => { this.close(c, `a line longer than ${this.o.maxLine ?? CONTROL_MAX_LINE} bytes`); });
    c.socket.on("data", (d: Buffer) => reader.push(d));
    // Bytes after the last newline are not a line: at the end of the stream the door drops them and closes, after the
    // answers that it still owes (a peer that half-closes after its request still gets its answer).
    c.socket.on("end", () => {
      if (c.pending === 0) { this.finish(c); return; }
      c.ended = true;
    });
    c.socket.resume();
  }

  private request(c: Conn, req: Record<string, unknown>): void {
    const id = req.id as string;
    const error = checkRequest(req, (op) => this.o.handler.has(op));
    if (error) { this.answer(c, req, { t: "res", id, ok: false, error }, error, []); return; }
    const events: Record<string, unknown>[] = [];
    this.handling = events;
    let a: Answer | Promise<Answer>;
    try { a = this.o.handler.handle(req as Req); }
    catch (e) { a = { error: ERR.bad }; this.o.log(`control: ${req.op} failed: ${(e as Error).name}`); }
    finally { this.handling = null; }
    const res = (x: Answer) => ("error" in x ? { t: "res", id, ok: false, error: x.error } : { t: "res", id, ok: true, data: x.data });
    if (!(a instanceof Promise)) { this.answer(c, req, res(a), null, events); return; }
    // An op that waits answers later; the other requests of the connection get their answers meanwhile (by their id).
    c.pending++;
    void a.catch((e) => { this.o.log(`control: ${req.op} failed: ${(e as Error).name}`); return { error: ERR.bad } as Answer; }).then((x) => {
      c.pending--;
      this.answer(c, req, res(x), null, events);
      if (c.ended && c.pending === 0) this.finish(c);
    });
  }

  /** Log an act with its provenance (a read and a request that the shape step refused are not), write the answer, then the op's events. */
  private answer(c: Conn, req: Record<string, unknown>, answer: Record<string, unknown>, error: string | null, events: Record<string, unknown>[]): void {
    if (error !== ERR.unsupported && error !== ERR.bad && !READS.has(req.op as string)) {
      const by = req.by as By;
      this.o.log(`control: ${req.op} by ${by.kind} ${by.user} via ${by.via}: ${answer.ok ? "ok" : answer.error}`);
    }
    if (!c.socket.destroyed) c.socket.write(encodeLine(answer));
    for (const ev of events) this.emit(ev);
  }

  /** Close the door: each connection, the server, and the socket while it is still this door's. */
  stop(): Promise<void> {
    return this.stopping ??= (async () => {
      for (const s of [...this.sockets]) s.destroy();
      this.conns.clear();
      await new Promise<void>((r) => this.server.close(() => r()));
      if (statSync(this.path, { throwIfNoEntry: false })?.ino === this.inode) rmSync(this.path, { force: true });
      this.o.log("control: stopped");
    })();
  }
}
