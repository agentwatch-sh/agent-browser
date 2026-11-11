// The bridge carrier inside `agent-browser service` (stage 1b part 2 of the self-contained agent browser, board
// ab-v16.94.9; the design, sections 5.1 "The bridge" and 5.4; contract C10 in chrome-extension's docs/protocol.md, "From
// stage 3"; a port of agentwatch's daemon/browser/bridge.py, BridgeCarrier). The model (src/relay/model.ts, the relay's
// code with no change of its rules) runs in the service's process: its requests come here as calls (no standard output
// line and no daemon), and its answers, its events and the daemon's lines go to it as calls. The carrier keeps C10's
// rules of the daemon's side:
//
// - The waits. The carrier counts from the model's send. A request that waited q ms in the carrier's queue goes to the
//   receiver with `wait` minus q; when that is 0 or less, the carrier answers `timeout` and never sends it. With no res
//   `wait` + WAIT_SLACK_MS ms after the send, the carrier answers `timeout` (expire(), each second) and drops the late res.
// - The bytes bound. A request goes when the bytes of the requests in flight plus its own bytes are at most
//   MAX_BYTES_IN_FLIGHT, or when none is in flight; the next ones wait, in order.
// - The join of result parts: up to MAX_RESULT_PARTS parts of RESULT_PART_BYTES; the joined res goes to the model in
//   the place of its last part. Another message before the last part makes the request's `timeout`.
// - The carrier's answers: `not connected`, `disconnected`, `timeout` and `too large`.
// - The daemon's lines to the model: `link` up and down, `allowlist` (the confirmed set_scopes object with the roots,
//   which stage 1c builds) and `end_scope`.
// - The daemon's own ops leave the wire (C10, "From stage 3"): daemon.pointerAt and daemon.movePointer go to the X
//   pointer (pointer-ops.ts) and daemon.blocked to the service's prompts, before the link checks and outside the queue.
// - Whether a client holds a connection: the model's last bridge.attachNew on the current link (C10: on while one is).
//
// No log line holds a request's args, a result, an event's params or a page: a log line holds an op, a size, a count
// or a time. The host of daemon.blocked is logged by the prompts (C12's log rule), never its scope.

import { randomBytes } from "node:crypto";
import type { BridgeRequest } from "../../relay/bridge.ts";
import { SCOPE } from "../../relay/scopes.ts";
import { normalizeHost } from "../lists/hosts.ts";
import type { Blocked } from "../receiver.ts";
import { splitParts, type Part } from "./parts.ts";

export const WAIT_DEFAULT_MS = 30_000;
export const WAIT_MAX_MS = 600_000;
export const WAIT_SLACK_MS = 2000;
export const MAX_REQUEST = 134_217_728;
export const MAX_RESULT = 134_217_728;
export const RESULT_PART_BYTES = 4_194_304;
export const MAX_RESULT_PARTS = 32;
export const MAX_BYTES_IN_FLIGHT = 268_435_456;
/** The carrier's answers (C10). */
export const NOT_CONNECTED = "not connected";
export const DISCONNECTED = "disconnected";
export const TIMEOUT = "timeout";
export const TOO_LARGE = "too large";
/** The prefix of the carrier's own request ids: the model's ids are 8 hex digits, a `-` and a count. */
export const OWN_ID_PREFIX = "aw-";
const MAX_B64 = 4 * Math.ceil(RESULT_PART_BYTES / 3);

/** The model's side: the relay's Bridge.answer for a res, and Model.onDaemon for an event or a daemon line. */
export type ModelSink = { answer(msg: Record<string, unknown>): void; daemon(msg: Record<string, unknown>): void };
/** The X pointer's ops (pointer-ops.ts): an answer, or null when none comes (the service stops). */
export type PointerPort = { answer(req: BridgeRequest): Promise<Record<string, unknown> | null>; pending(id: string): boolean; busy?(): boolean; kill?(reason: "linkChange" | "unitStop" | "daemonStop"): void };

type Req = { id: string; op: string; request: BridgeRequest | null; line: string | null; size: number; wait: number; keep: boolean; readAt: number; sent: boolean };
type Own = { done: (ok: boolean) => void; readAt: number; wait: number };

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** The carrier's wait of a request and whether it goes unchanged (a wait that is not an integer from 1 to WAIT_MAX_MS goes as it is, and the receiver answers `bad wait`). */
export function waitOf(req: { op?: unknown; wait?: unknown }): [number, boolean] {
  const dflt = req.op === "debugger.sendCommand" ? WAIT_MAX_MS : WAIT_DEFAULT_MS;
  if (!("wait" in req)) return [dflt, false];
  return isInt(req.wait) && req.wait >= 1 && req.wait <= WAIT_MAX_MS ? [req.wait, false] : [dflt, true];
}

/** The bytes of one result part, or null (bad base64, or too long). */
function b64Of(v: unknown): Buffer | null {
  if (typeof v !== "string" || v.length > MAX_B64 || v.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) return null;
  const b = Buffer.from(v, "base64");
  return b.length > RESULT_PART_BYTES ? null : b;
}

export type CarrierOptions = {
  /** The native link's bridge send (link.ts): false when no receiver with channel bridge is connected. */
  send: (parts: Part[]) => boolean;
  log: (line: string) => void;
  /** The monotonic clock in ms. */
  clock?: () => number;
  maxBytes?: number;
  pointer?: PointerPort;
  /** A valid daemon.blocked report: the service's prompts (stage 1c), with `from` null. */
  blocked?: (b: Blocked) => void;
};

export class Carrier {
  private readonly o: CarrierOptions;
  private readonly clock: () => number;
  private readonly max: number;
  private sink: ModelSink | null = null;
  private upFlag = false;
  private version: string | null = null;
  private readonly waiting = new Map<string, Req>();
  private queue: Req[] = [];
  private queuedBytes = 0;
  private flight = 0;
  private flightBytes = 0;
  private readonly own = new Map<string, Own>();
  private readonly ownPrefix = randomBytes(4).toString("hex");
  private ownCount = 0;
  private join: { id: string; n: number; slices: Buffer[] } | null = null;
  private last: number | null = null;
  private gen = 0;
  private clientsFlag = false;
  private stopped = false;
  private readonly logged = new Map<string, number>();

  constructor(o: CarrierOptions) {
    this.o = o;
    this.clock = o.clock ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
    this.max = o.maxBytes ?? MAX_BYTES_IN_FLIGHT;
  }

  /** The model's side, once (the relay's endpoint binds it at its start). */
  bind(sink: ModelSink): void {
    this.sink = sink;
    if (this.upFlag) this.toModel(this.linkUpLine());
  }

  // ------------------------------------------------------------------ the state for the service

  up(): boolean { return this.upFlag; }
  /** Requests to the receiver that wait for their answer, plus a running X call. */
  inFlight(): number { return this.flight + (this.o.pointer?.busy?.() ? 1 : 0); }
  /** ms since the last request was read or answered; Infinity before one. */
  idleFor(): number { return this.last === null ? Infinity : this.clock() - this.last; }
  /** Counts link changes: each link up, and each link down of an up link. */
  linkGen(): number { return this.gen; }
  /** A client holds a connection: the model's last bridge.attachNew on the current link said [true]. */
  clients(): boolean { return this.clientsFlag; }

  // ------------------------------------------------------------------ the model's requests

  /** One request of the model (the relay's Bridge): `line` is its compact JSON, `msg` the same request. */
  fromModel(line: string, msg: BridgeRequest): void {
    if (this.stopped) return;
    const readAt = this.clock();
    if (!msg || msg.t !== "req" || typeof msg.id !== "string" || typeof msg.op !== "string") { this.o.log(`bridge: dropped a request of ${line.length} bytes`); return; }
    const size = Buffer.byteLength(line);
    if (size > MAX_REQUEST) { this.o.log(`bridge: dropped a request of ${size} bytes (above MAX_REQUEST)`); return; }
    const id = msg.id;
    if (this.waiting.has(id) || this.own.has(id) || this.o.pointer?.pending(id)) { this.o.log(`bridge: dropped a request of ${size} bytes (its id waits already)`); return; }
    this.last = this.last === null ? readAt : Math.max(this.last, readAt);
    if (msg.op.startsWith("daemon.")) { this.daemonOp(msg); return; }
    if (!this.upFlag) { this.answer(id, NOT_CONNECTED); return; }
    if (msg.op === "bridge.attachNew" && Array.isArray(msg.args) && typeof msg.args[0] === "boolean") this.clientsFlag = msg.args[0];
    const [wait, keep] = waitOf(msg);
    const req: Req = { id, op: msg.op.slice(0, 64), request: msg, line, size, wait, keep, readAt, sent: false };
    this.waiting.set(id, req);
    this.queue.push(req);
    this.queuedBytes += size;
    this.pump();
  }

  /** The daemon's own ops (C10): answered here, before the link checks, outside the queue and the bytes bound. */
  private daemonOp(msg: BridgeRequest): void {
    if (msg.op === "daemon.blocked") { this.daemonBlocked(msg); return; }
    if ((msg.op === "daemon.pointerAt" || msg.op === "daemon.movePointer") && this.o.pointer) {
      void this.o.pointer.answer(msg).then((res) => {
        if (res === null || this.stopped) return;
        if (res.ok === false) this.logOnce(`pointer: ${msg.op}: ${String(res.error)}`);
        this.last = this.clock();
        this.toModel(res, true);
      }, () => { this.toModel({ t: "res", ch: "bridge", id: msg.id, ok: false, error: "no display" }, true); });
      return;
    }
    this.toModel({ t: "res", ch: "bridge", id: msg.id, ok: false, error: msg.op === "daemon.pointerAt" || msg.op === "daemon.movePointer" ? "no display" : "unknown op" }, true);
  }

  /** daemon.blocked, args [block] with exactly host (a normalized host) and scope (a scope or null): the prompts' handler, then ok {} (also when its limit drops the report). */
  private daemonBlocked(msg: BridgeRequest): void {
    const args = msg.args;
    const block = Array.isArray(args) && args.length === 1 ? args[0] : null;
    const keys = block && typeof block === "object" && !Array.isArray(block) ? Object.keys(block).sort() : null;
    let valid = keys !== null && keys.length === 2 && keys[0] === "host" && keys[1] === "scope";
    const { host, scope } = (block ?? {}) as { host?: unknown; scope?: unknown };
    if (valid) { try { valid = typeof host === "string" && normalizeHost(host) === host; } catch { valid = false; } }
    if (valid && scope !== null && !(typeof scope === "string" && SCOPE.test(scope))) valid = false;
    if (!valid) { this.answer(msg.id, "bad args"); return; }
    try { this.o.blocked?.({ host: host as string, scope: scope as string | null, from: null }); } catch { this.o.log("bridge: daemon.blocked: the prompts' handler failed"); }
    this.last = this.clock();
    this.toModel({ t: "res", ch: "bridge", id: msg.id, ok: true, data: {} }, true);
  }

  // ------------------------------------------------------------------ the receiver's side (the native link)

  /** A receiver whose hello lists `bridge` is connected (a new one replaces the last). */
  linkUp(version: string): void {
    this.o.pointer?.kill?.("linkChange");
    if (this.upFlag) this.linkDown();
    this.gen++;
    this.upFlag = true;
    this.clientsFlag = false; // the model closes every connection at a link up
    this.version = version;
    this.toModel(this.linkUpLine());
  }

  /** The link dropped: `disconnected` for each request in its order, the own requests fail, the join goes, then the link-down line. */
  linkDown(): void {
    this.o.pointer?.kill?.("linkChange");
    if (!this.upFlag) return;
    this.gen++;
    this.upFlag = false;
    this.clientsFlag = false;
    this.version = null;
    this.join = null;
    const all = [...this.waiting.values()];
    this.forget();
    for (const r of all) this.answer(r.id, DISCONNECTED);
    const own = [...this.own.values()];
    this.own.clear();
    for (const x of own) x.done(false);
    this.toModel({ t: "link", up: false });
  }

  /** A res, ev or part of channel bridge. */
  message(msg: Record<string, unknown>): void {
    if (!this.upFlag || this.stopped) return;
    const kind = msg.t, id = msg.id;
    const j = this.join;
    if (j && !(kind === "part" && id === j.id)) {
      this.join = null;
      this.o.log(`bridge: ${this.opOf(j.id)}: a message came before the last result part; timeout`);
      this.fail(j.id, TIMEOUT);
    }
    if (kind === "res") { if (typeof id === "string") this.res(id, msg); }
    else if (kind === "ev") this.toModel(msg);
    else if (kind === "part") this.part(msg);
    this.pump();
  }

  // ------------------------------------------------------------------ the daemon's lines to the model

  /** The receiver confirmed a set_scopes object on the current link: its allowlist line (with the roots), while the link is up. */
  allowlist(line: Record<string, unknown>): void { if (this.upFlag) this.toModel({ ...line, t: "allowlist" }); }

  /** The session of `scope` ended (a name that is not a scope is skipped). */
  endScope(scope: string): void { if (typeof scope === "string" && SCOPE.test(scope)) this.toModel({ t: "end_scope", scope }); }

  // ------------------------------------------------------------------ the carrier's own request

  /** bridge.attachNew [false]; true on an ok answer, false with no link, at a drop and at the carrier's timeout. Its answer never goes to the model. */
  attachNewOff(): Promise<boolean> {
    if (!this.upFlag) return Promise.resolve(false);
    const id = `${OWN_ID_PREFIX}${this.ownPrefix}-${++this.ownCount}`;
    return new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => { this.own.delete(id); resolve(ok); };
      this.own.set(id, { done, readAt: this.clock(), wait: WAIT_DEFAULT_MS });
      if (!this.sendParts(id, JSON.stringify({ t: "req", id, op: "bridge.attachNew", args: [false], wait: WAIT_DEFAULT_MS }))) done(false);
    });
  }

  // ------------------------------------------------------------------ deadlines and the stop

  /** `timeout` for each request past its deadline: a sent one at wait + WAIT_SLACK_MS after its send, a queued one whose wait is used up. The service calls it each second. */
  expire(): void {
    const now = this.clock();
    const late = [...this.waiting.values()].filter((r) => (r.sent && now - r.readAt >= r.wait + WAIT_SLACK_MS) || (!r.sent && r.wait - (now - r.readAt) <= 0));
    if (late.length) {
      const gone = new Set(late.filter((r) => !r.sent).map((r) => r.id));
      if (gone.size) this.queue = this.queue.filter((r) => !gone.has(r.id));
      for (const r of late) { this.o.log(`bridge: ${r.op}: no answer in ${r.wait} ms; timeout`); this.fail(r.id, TIMEOUT); }
    }
    for (const [id, x] of [...this.own]) if (now - x.readAt >= x.wait + WAIT_SLACK_MS) { this.own.delete(id); x.done(false); }
    this.pump();
  }

  /** The service stops: no more answers go to the model; a playing path is killed with no answer. */
  stop(): void {
    this.stopped = true;
    this.o.pointer?.kill?.("daemonStop");
    this.forget();
    this.join = null;
    for (const x of this.own.values()) x.done(false);
    this.own.clear();
  }

  // ------------------------------------------------------------------ inside

  private linkUpLine() { return { t: "link", up: true, version: this.version }; }

  /** One message to the model: a res to the Bridge, anything else to the model's daemon lines. */
  private toModel(msg: Record<string, unknown>, isRes = msg.t === "res"): void {
    if (this.stopped || !this.sink) return;
    try { if (isRes) this.sink.answer(msg); else this.sink.daemon(msg); }
    catch (e) { this.o.log(`bridge: the model failed on a ${String(msg.t)} message (${(e as Error).name})`); }
  }

  private answer(id: string, error: string): void {
    this.last = this.clock();
    this.toModel({ t: "res", ch: "bridge", id, ok: false, error }, true);
  }

  /** One log line for each text a minute (C10: the daemon's log of its own ops; never a point). */
  private logOnce(text: string): void {
    const now = this.clock(), at = this.logged.get(text);
    if (at !== undefined && now - at < 60_000) return;
    this.logged.set(text, now);
    this.o.log(text);
  }

  private sendParts(id: string, json: string): boolean {
    try { return this.o.send(splitParts(id, json, "bridge")); }
    catch (e) { this.o.log(`bridge: a message did not go to the link (${(e as Error).name})`); return false; }
  }

  private opOf(id: string): string { return this.waiting.get(id)?.op ?? (this.own.has(id) ? "bridge.attachNew" : "?"); }

  private forget(): void { this.waiting.clear(); this.queue = []; this.queuedBytes = 0; this.flight = 0; this.flightBytes = 0; }

  /** Take a request out of the books. */
  private take(id: string): Req | undefined {
    const r = this.waiting.get(id);
    if (!r) return undefined;
    this.waiting.delete(id);
    if (r.sent) { this.flight--; this.flightBytes -= r.size; } else this.queuedBytes -= r.size;
    return r;
  }

  private waitsFor(id: string): boolean { const r = this.waiting.get(id); return (r !== undefined && r.sent) || this.own.has(id); }

  /** The carrier answers `id` with `error` (an own request gets false). */
  private fail(id: string, error: string): void {
    if (this.join?.id === id) this.join = null;
    if (this.take(id)) { this.answer(id, error); return; }
    const x = this.own.get(id);
    if (x) { this.own.delete(id); x.done(false); }
  }

  private res(id: string, msg: Record<string, unknown>): void {
    const r = this.waiting.get(id);
    if (r && r.sent) { this.take(id); this.last = this.clock(); this.toModel(msg, true); return; }
    const x = this.own.get(id);
    if (!x) return; // an id that the carrier does not wait for (a late answer)
    this.own.delete(id);
    x.done(msg.ok === true);
  }

  private badPart(id: string): void { this.o.log(`bridge: ${this.opOf(id)}: a bad result part; timeout`); this.fail(id, TIMEOUT); }

  private part(msg: Record<string, unknown>): void {
    const id = msg.id;
    if (typeof id !== "string" || !this.waitsFor(id)) return; // the parts of an answer that nobody waits for
    const seq = msg.seq, n = msg.n;
    let j = this.join;
    if (!j) {
      if (isInt(n) && n > MAX_RESULT_PARTS) { this.o.log(`bridge: ${this.opOf(id)}: a result of ${n} parts (above ${MAX_RESULT_PARTS}); too large`); this.fail(id, TOO_LARGE); return; }
      if (!(isInt(n) && n >= 1 && seq === 0)) { this.badPart(id); return; }
      j = this.join = { id, n, slices: [] };
    } else if (!(isInt(seq) && seq === j.slices.length && n === j.n)) { this.badPart(id); return; }
    const piece = b64Of(msg.b64);
    if (!piece) { this.badPart(id); return; }
    j.slices.push(piece);
    if (j.slices.length < j.n) return;
    this.join = null;
    const bytes = Buffer.concat(j.slices);
    let res: unknown = null;
    if (!bytes.includes(10) && bytes[0] === 0x7b && bytes[bytes.length - 1] === 0x7d) { try { res = JSON.parse(bytes.toString("utf8")); } catch { res = null; } }
    if (res === null || typeof res !== "object" || Array.isArray(res)) {
      this.o.log(`bridge: ${this.opOf(id)}: a joined result of ${bytes.length} bytes is not one JSON object line; timeout`);
      this.fail(id, TIMEOUT);
      return;
    }
    this.res(id, res as Record<string, unknown>);
  }

  /** Send the queue's head while the bytes bound allows it, in order. */
  private pump(): void {
    if (!this.upFlag) return;
    while (this.queue.length) {
      const r = this.queue[0];
      // The clock at each step: a send takes time, and the next request's q counts it.
      const left = r.wait - (this.clock() - r.readAt);
      if (left <= 0) { this.queue.shift(); this.o.log(`bridge: ${r.op}: its wait ran out in the queue; timeout`); this.fail(r.id, TIMEOUT); continue; }
      if (this.flight && this.flightBytes + r.size > this.max) break;
      this.queue.shift();
      const json = r.keep || left === r.request!.wait ? r.line! : JSON.stringify({ ...r.request!, wait: left });
      r.request = null; r.line = null;
      this.queuedBytes -= r.size;
      r.sent = true;
      this.flight++;
      this.flightBytes += r.size;
      if (!this.sendParts(r.id, json)) this.fail(r.id, DISCONNECTED);
    }
  }
}
