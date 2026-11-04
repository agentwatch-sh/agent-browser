// The live test's stand-in for the agentwatch daemon's bridge side (stage 4 builds the real one). It listens on a
// Unix socket for chrome-extension's live-test native host (test/live/host.py), which carries the agent package's
// native messages as NDJSON lines (contract C4), and it runs `agent-browser relay` as its child, whose standard input
// and output carry the bridge (C10). It sends each request to the receiver in C4 parts (PART_BYTES), joins the
// receiver's result parts, answers `not connected`, `disconnected` and `timeout` itself, and writes the link and
// allowlist lines. It applies one allowlist (set_allowlist on channel main). It logs ops, ids and sizes only.

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";

const PART_BYTES = 700_000;
const WAIT_SLACK_MS = 2000;

export class StandInDaemon {
  readonly relay: ChildProcess;
  private readonly server: Server;
  private host: Socket | null = null;
  private bridgeUp = false;
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly sent = new Map<string, { op: string; at: number }>();
  private readonly parts = new Map<string, string[]>();
  private nextMain = 1;
  private readonly own = new Map<string, (m: any) => void>();
  private allowlistReq = "";
  readonly log: string[] = [];

  constructor(o: { daemonSocket: string; relaySocket: string; relayBin: string; allowlist: string[]; relayLog: (line: string) => void }) {
    rmSync(o.daemonSocket, { force: true });
    this.server = createServer((sock) => this.onHost(sock, o.allowlist));
    const umask = process.umask(0o077);
    try { this.server.listen(o.daemonSocket, () => chmodSync(o.daemonSocket, 0o600)); } finally { process.umask(umask); }
    this.relay = spawn(process.execPath, [o.relayBin, "relay", "--socket", o.relaySocket], { stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.relay.stdout! }).on("line", (line) => this.fromRelay(line));
    createInterface({ input: this.relay.stderr! }).on("line", o.relayLog);
  }

  private note(text: string): void { this.log.push(`${new Date().toISOString()} ${text}`); }
  private toRelay(msg: object | string): void { this.relay.stdin!.write(`${typeof msg === "string" ? msg : JSON.stringify(msg)}\n`); }

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
    if (!this.bridgeUp) { this.toRelay({ t: "res", ch: "bridge", id: req.id, ok: false, error: "not connected" }); return; }
    const what = req.op === "debugger.sendCommand" ? `${req.op} ${req.args?.[1]} tab ${req.args?.[0]?.tabId}` : `${req.op}`;
    this.sent.set(req.id, { op: what, at: Date.now() });
    this.note(`req ${req.id} ${what}`);
    this.pending.set(req.id, setTimeout(() => { this.note(`timeout ${req.op} ${req.id}`); this.answer(req.id, "timeout"); }, (req.wait ?? 30_000) + WAIT_SLACK_MS));
    this.toReceiver("bridge", req);
  }

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

  private onHost(sock: Socket, allowlist: string[]): void {
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
        this.toRelay({ t: "link", up: true, version: m.version });
        this.allowlistReq = `m${this.nextMain++}`;
        this.toReceiver("main", { t: "req", id: this.allowlistReq, op: "set_allowlist", domains: allowlist } as any);
      } else if (m.t === "res" && m.ch === "bridge" && this.own.has(m.id)) { this.own.get(m.id)!(m); this.own.delete(m.id); }
      else if (m.t === "res" && m.ch === "bridge") this.bridgeRes(line, m.id);
      else if (m.t === "res" && m.id === this.allowlistReq) {
        this.note(`set_allowlist ${m.ok ? "ok" : "failed"}`);
        if (m.ok) this.toRelay({ t: "allowlist", domains: allowlist });
      } else if (m.t === "part" && m.ch === "bridge") {
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
      for (const id of [...this.pending.keys()]) this.answer(id, "disconnected");
      if (this.bridgeUp) this.toRelay({ t: "link", up: false });
      this.bridgeUp = false;
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

  /** The requests that still wait for their answer: op and age. */
  waiting(): string[] { return [...this.sent.entries()].map(([id, s]) => `${id} ${s.op} for ${Date.now() - s.at} ms`); }

  /** End the relay (its standard input ends) and the socket. */
  async stop(): Promise<number | null> {
    const exited = new Promise<number | null>((r) => this.relay.once("exit", (code) => r(code)));
    this.relay.stdin!.end();
    const code = await Promise.race([exited, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
    this.host?.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
    return code;
  }
}
