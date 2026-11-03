// The probe's local servers, all on 127.0.0.1 and reached only as probe.localhost:
// - HTTP (port P): the site page and its script, the page's reports, and the probe extension's
//   command channel (long poll /ext/cmd, results to /ext/report).
// - HTTPS (port P+1): the same site over TLS with HTTP/2. A raw TCP listener keeps the ClientHello
//   (JA4) and the first decrypted HTTP/2 frames (Akamai) before Node's TLS and HTTP/2 take over.
// - A blocking proxy (port P+2): the browsers run with --proxy-server pointed here, so every request
//   to a host that is not localhost ends here with a 403 and only its host is logged. *.localhost
//   bypasses a proxy in Chrome, so the probe pages load directly.

import { EventEmitter } from "node:events";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttp2Server, type Http2ServerRequest, type Http2ServerResponse } from "node:http2";
import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Duplex } from "node:stream";
import { TLSSocket, createSecureContext } from "node:tls";
import { akamaiH2, describeClientHello, parseClientHello, parseH2Start } from "./fingerprint.ts";

const HERE = new URL(".", import.meta.url);
const SITE_JS = readFileSync(new URL("site.js", HERE), "utf8");

const ACCEPT_CH = "Sec-CH-UA-Full-Version-List, Sec-CH-UA-Full-Version, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Model, Sec-CH-UA-WoW64, Sec-CH-UA-Form-Factors";

export type Record = { t: number; run: string; kind: string; data: unknown };

type Req = IncomingMessage | Http2ServerRequest;
type Res = ServerResponse | Http2ServerResponse;

export class ProbeServer extends EventEmitter {
  run = "";                          // the label of the current run, stamped on every record
  records: Record[] = [];
  private queue: { id: number; op: string; [k: string]: unknown }[] = [];
  private waiters: ((cmd: unknown) => void)[] = [];
  private nextId = 1;
  private servers: Server[] = [];
  private conns = new Set<Socket>();   // the open connections of all three servers
  private h2Conn = new Map<number, unknown>();
  private connSeq = 0;
  readonly port: number;
  private readonly tls: { key: string; cert: string };
  // Each command carries this token; the stand-in extension runs no command without it.
  readonly token = randomBytes(16).toString("hex");
  constructor(port: number, tls: { key: string; cert: string }) { super(); this.port = port; this.tls = tls; }

  get origin() { return `http://probe.localhost:${this.port}`; }
  get tlsOrigin() { return `https://probe.localhost:${this.port + 1}`; }
  get proxy() { return `http://127.0.0.1:${this.port + 2}`; }

  record(kind: string, data: unknown) {
    const r = { t: Date.now(), run: this.run, kind, data };
    this.records.push(r);
    this.emit("record", r);
  }

  /** The first record of a kind in the current run that passes the test, waiting up to ms. */
  waitFor(kind: string, ms: number, test: (d: any) => boolean = () => true): Promise<any> {
    const run = this.run;
    const hit = this.records.find((r) => r.run === run && r.kind === kind && test(r.data));
    if (hit) return Promise.resolve(hit.data);
    return new Promise((resolve) => {
      const on = (r: Record) => { if (r.run === run && r.kind === kind && test(r.data)) { done(); resolve(r.data); } };
      const timer = setTimeout(() => { done(); resolve(undefined); }, ms);
      const done = () => { clearTimeout(timer); this.off("record", on); };
      this.on("record", on);
    });
  }

  /** Send one command to the probe extension and wait for its result. */
  async ext(op: string, args: { [k: string]: unknown } = {}, ms = 15_000): Promise<{ result?: any; error?: string; timeout?: true }> {
    const id = this.nextId++;
    const cmd = { ...args, id, op, token: this.token };
    const w = this.waiters.shift();
    if (w) w(cmd); else this.queue.push(cmd);
    const r = await this.waitFor("ext-result", ms, (d) => d.id === id);
    return r ?? { timeout: true };
  }

  clearQueue() { this.queue = []; }

  async start() {
    const http = createHttpServer((req, res) => this.handle(req, res, "http/1.1"));
    const h2 = createHttp2Server();
    h2.on("request", (req, res) => this.handle(req, res, "h2"));
    h2.on("stream", (stream, headers, _flags, raw) => this.h2Stream(stream, headers, raw as unknown as string[]));
    const tlsRaw = createNetServer((sock) => this.tlsConnection(sock, h2));
    const proxy = createNetServer((sock) => this.proxyConnection(sock));
    for (const [srv, port] of [[http, this.port], [tlsRaw, this.port + 1], [proxy, this.port + 2]] as const) {
      await new Promise<void>((resolve, reject) => { srv.once("error", reject); srv.listen(port, "127.0.0.1", () => resolve()); });
      srv.on("connection", (c: Socket) => { this.conns.add(c); c.once("close", () => this.conns.delete(c)); });
      this.servers.push(srv);
    }
  }

  /** Close the servers. A browser that a person opened (--serve) keeps its connections open: end them. */
  async stop() {
    const closed = this.servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve())));
    for (const c of this.conns) c.destroy();
    for (const w of this.waiters) w(undefined);
    await Promise.all(closed);
  }

  private handle(req: Req, res: Res, proto: string) {
    const url = new URL(req.url ?? "/", "http://x");
    const run = url.searchParams.get("run") ?? this.run;
    const send = (status: number, type: string, body: string, headers: { [k: string]: string } = {}) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
      res.end(body);
    };
    const body = () => new Promise<any>((resolve) => {
      let b = "";
      req.on("data", (c: Buffer) => (b += c));
      req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
    });
    // Every page request: its headers in the order they came (pseudo-headers first on HTTP/2).
    if (!url.pathname.startsWith("/ext/") && !url.pathname.startsWith("/page/")) {
      this.recordFor(run, "request", { proto, path: url.pathname, connection: (req.socket as any)?.__probeConn, rawHeaders: pairs(req.rawHeaders) });
    }
    if (url.pathname === "/" || url.pathname === "/site") {
      const page = `<!doctype html><html><head><meta charset="utf-8"><title>parity probe</title>
<style>body{font:16px sans-serif;margin:0}#target{position:fixed;left:100px;top:120px;width:300px;height:40px;font-size:18px}#links{position:fixed;left:100px;top:200px}</style></head>
<body><input id="target" placeholder="click and type here"><div id="links"><a id="go" href="/blank?from=link">a link</a></div>
<script>window.PROBE={run:${JSON.stringify(run)},origin:location.origin}</script><script src="/site.js?run=${encodeURIComponent(run)}"></script></body></html>`;
      return send(200, "text/html; charset=utf-8", page, {
        "accept-ch": ACCEPT_CH,
        "critical-ch": "Sec-CH-UA-Full-Version-List",
        // Device Bound Session Credentials: a browser that supports them answers at /dbsc/start.
        "sec-session-registration": `(ES256 RS256);path="/dbsc/start";challenge="probe-challenge"`,
        "secure-session-registration": `(ES256 RS256);path="/dbsc/start";challenge="probe-challenge"`,
      });
    }
    if (url.pathname === "/site.js") return send(200, "text/javascript", SITE_JS);
    if (url.pathname === "/blank") return send(200, "text/html", "<!doctype html><title>blank</title><p>blank</p>");
    if (url.pathname.startsWith("/dbsc/")) { this.recordFor(run, "dbsc", { path: url.pathname, rawHeaders: pairs(req.rawHeaders) }); return send(200, "application/json", "{}"); }
    if (url.pathname === "/page/report" && req.method === "POST") {
      // Answer after the body: on HTTP/2 an early answer ends the stream before the body arrives.
      void body().then((b) => { for (const e of Array.isArray(b) ? b : [b]) this.recordFor(run, `page-${e.kind}`, { ...e.data, pageT: e.t }); send(204, "text/plain", ""); });
      return;
    }
    if (url.pathname === "/page/extid") {
      const alive = [...this.records].reverse().find((r) => r.run === run && r.kind === "ext-alive");
      return send(200, "application/json", JSON.stringify({ id: (alive?.data as any)?.id ?? null }));
    }
    if (url.pathname === "/ext/report" && req.method === "POST") {
      void body().then((b) => { this.record(b.kind === "result" ? "ext-result" : `ext-${b.kind}`, b); send(204, "text/plain", ""); });
      return;
    }
    if (url.pathname === "/ext/cmd") {
      const cmd = this.queue.shift();
      if (cmd) return send(200, "application/json", JSON.stringify(cmd));
      let answered = false;
      const reply = (c: unknown) => { if (answered) return; answered = true; c ? send(200, "application/json", JSON.stringify(c)) : send(204, "text/plain", ""); };
      this.waiters.push(reply);
      res.on("close", () => { const i = this.waiters.indexOf(reply); if (i >= 0) this.waiters.splice(i, 1); answered = true; });
      setTimeout(() => { const i = this.waiters.indexOf(reply); if (i >= 0) this.waiters.splice(i, 1); reply(undefined); }, 20_000).unref();
      return;
    }
    return send(404, "text/plain", "not found");
  }

  private recordFor(run: string, kind: string, data: unknown) {
    const r = { t: Date.now(), run, kind, data };
    this.records.push(r);
    this.emit("record", r);
  }

  /** TLS: keep the ClientHello, then TLS with ALPN h2, then keep the first HTTP/2 frames. */
  private tlsConnection(sock: Socket, h2: ReturnType<typeof createHttp2Server>) {
    const conn = ++this.connSeq;
    const run = this.run;
    let head = Buffer.alloc(0);
    const onData = (b: Buffer) => {
      head = Buffer.concat([head, b]);
      let hello;
      try { hello = parseClientHello(head); } catch (e) { this.record("tls-error", { conn, error: String(e) }); sock.destroy(); return; }
      if (!hello) return;
      sock.off("data", onData);
      sock.pause();
      this.recordFor(run, "tls-hello", { conn, ...describeClientHello(hello) });
      const tls = new TLSSocket(replay(sock, head), {
        isServer: true,
        secureContext: createSecureContext({ key: this.tls.key, cert: this.tls.cert }),
        ALPNProtocols: ["h2", "http/1.1"],
      });
      tls.on("error", (e) => { this.recordFor(run, "tls-error", { conn, error: String(e) }); sock.destroy(); });
      let plain = Buffer.alloc(0);
      let done = false;
      const tapped = replay(tls, Buffer.alloc(0), (b) => {
        if (done) return;
        plain = Buffer.concat([plain, b]);
        try {
          const start = parseH2Start(plain);
          if (start) { done = true; this.h2Conn.set(conn, start); this.recordFor(run, "h2-start", { conn, alpn: tls.alpnProtocol, start }); }
        } catch (e) { done = true; this.recordFor(run, "h2-start", { conn, alpn: tls.alpnProtocol, error: String(e) }); }
      });
      // replay() passes the TLSSocket's errors on, for example the alert that ends the handshake at a
      // certificate warning: without a listener here, Node throws.
      tapped.on("error", () => {});
      (tapped as any).__probeConn = conn;
      tls.once("secure", () => {
        if (tls.alpnProtocol === "h2") h2.emit("connection", tapped);
        else { this.recordFor(run, "tls-alpn", { conn, alpn: tls.alpnProtocol }); tapped.destroy(); }
      });
    };
    sock.on("data", onData);
    sock.on("error", () => {});
  }

  /** The first stream of each HTTP/2 connection: its pseudo-header order completes the fingerprint. */
  private h2Stream(stream: any, headers: any, raw: string[]) {
    // session.socket is Node's proxy of a JSStreamSocket that wraps our tapped Duplex (.stream).
    const sock = stream.session?.socket;
    const conn = (sock?.__probeConn ?? sock?.stream?.__probeConn) as number | undefined;
    const start = conn === undefined ? undefined : this.h2Conn.get(conn) as Parameters<typeof akamaiH2>[0] | undefined;
    if (!start || conn === undefined) return;
    this.h2Conn.delete(conn);
    const names = raw.filter((_, i) => i % 2 === 0);
    this.record("h2-fingerprint", { conn, akamai: akamaiH2(start, names), headerOrder: names, firstHeaders: start.firstHeaders, path: headers[":path"] });
  }

  /** The blocking proxy: log the host of each CONNECT or absolute-URL request, answer 403. */
  private proxyConnection(sock: Socket) {
    let buf = "";
    sock.on("error", () => {});
    sock.on("data", (b) => {
      buf += b.toString("latin1");
      const end = buf.indexOf("\r\n");
      if (end < 0) return;
      const [method, target] = buf.slice(0, end).split(" ");
      let host = target ?? "";
      try { if (!/^[^/]+:\d+$/.test(host)) host = new URL(host).host; } catch { /* keep as is */ }
      this.record("blocked-egress", { method, host });
      sock.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
  }
}

function pairs(raw: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) out.push([raw[i], raw[i + 1]]);
  return out;
}

/** A Duplex over `sock` that first yields `head` (bytes already read), and taps what it reads. */
function replay(sock: Duplex, head: Buffer, tap?: (b: Buffer) => void): Duplex {
  const d = new Duplex({
    read() { sock.resume(); },
    write(chunk, _enc, cb) { sock.write(chunk, cb); },
    final(cb) { sock.end(); cb(); },
    destroy(err, cb) { sock.destroy(err ?? undefined); cb(err); },
  });
  if (head.length) { tap?.(head); d.push(head); }
  sock.on("data", (b: Buffer) => { tap?.(b); if (!d.push(b)) sock.pause(); });
  sock.on("end", () => d.push(null));
  sock.on("error", (e) => d.destroy(e));
  sock.on("close", () => d.destroy());
  return d;
}
