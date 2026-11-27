// The address proxy of the blanket Chrome (board ab-4wh.6; C11, the blanket profile: the address proxy; C12, the blanket
// profile: the start at a use; the design docs/superpowers/specs/2026-11-25-blanket-profile-design.md, section 12).
//
// The blanket Chrome reaches the network only through this proxy: a SOCKS5 server of the service on 127.0.0.1, on a port
// that the kernel picks at each start. It listens from right before the blanket Chrome's start until that Chrome's stop,
// its end or a failed start, and at most WATCH_MS (chrome.ts) after the Chrome exits by itself. Chrome sends each host to
// a SOCKS5 proxy unresolved (address type 3, also an IP literal), so the proxy makes the one lookup of a connection:
//
// - It takes only CONNECT, with the method "no authentication" (Chrome's SOCKS5 client offers only that one, so no secret
//   can go to the proxy). A greeting of another SOCKS version gets no reply, and a method list without "no
//   authentication" the answer FF; in the request, BIND, UDP ASSOCIATE and an unknown command get 07, an unknown address
//   type 08, and another SOCKS version, a reserved byte that is not 0, an empty or unprintable host or port 0 get 01. Each
//   of these closes the connection.
// - It admits only a client of the service's uid, by the client's line of /proc/net/tcp (the full tuple; as the MCP
//   port's step 1, C11; on the Mac the blanket Chrome's own sockets: mac.ts, macTreeTcpReader). A line of another uid
//   is refused at once. A client with no line (also a line with no holder: inode 0, on the Mac a handle of 0) is read
//   once more at its first bytes or after PEER_WAIT_MS, and a client that ends before that decision (a socket that Chrome
//   closed in the accept queue: its process holds it no more) is refused as closed, never as a stranger (board
//   ab-4wh.22). At most PEER_WAITING clients wait so at a time, and one more is refused at once as a stranger; on Linux a
//   /proc/net/tcp that cannot be read refuses at once too (board ab-4wh.23). No byte goes to a client before its
//   admission.
// - It applies PageFetch's address rule (../fetch/address.ts) to the host: an IP literal by its range; a name by its name,
//   then by every address that the box's resolver gives for it (one refused address refuses the host, and a name with no
//   address is refused); and no address of the box's own network interfaces, read at each connection.
// - It connects only to the addresses that it checked (an IP literal, with no lookup), in the resolver's order, so a name
//   whose address changes after the check (DNS rebinding) never reaches another address.
// - The resources are bounded: at most MAX_CONNECTIONS client connections (one more is closed at once), the handshake in
//   HANDSHAKE_MS (its bytes at most MAX_HANDSHAKE_BYTES), at most LOOKUPS_AT_ONCE lookups at a time (the box's resolver
//   runs on libuv's small pool, which the service's own work shares) and at most WAITING_LOOKUPS waiting ones (a
//   connection whose client ends, fails or closes leaves its lookup at once: board ab-4wh.14), a lookup's answer in
//   LOOKUP_MS, the connect in CONNECT_MS, and the other side's end in HALF_CLOSE_MS after one side ended. After the reply the two sockets are piped (with their back pressure): no buffer grows.
// - A refusal answers the SOCKS reply 02 (not allowed by the rule set), so Chrome fails the request with
//   net::ERR_SOCKS_CONNECTION_FAILED (a network error to the page), and the log gets one line with the kind of host and
//   the reason: never a host, an address, a URL path or a query (at most LOG_LINES lines in LOG_WINDOW_MS, then one line
//   with the count).

import { BlockList, connect as netConnect, createServer, isIP, type AddressInfo, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { chromeSwitchName } from "../../agent.ts";
import { refusedIp, refusedName, systemResolve, type Resolve } from "../fetch/address.ts";
import { clientLine } from "../mcp/admission.ts";
import { procReader, type TcpLine } from "../mcp/proc.ts";

/** At most this many client connections at a time (Chrome's own limit per proxy: 128 sockets, and 128 more for WebSockets). */
export const MAX_CONNECTIONS = 256;
/** The greeting and the request must come within this time of the accept (the peer check's wait included). */
export const HANDSHAKE_MS = 10_000;
/**
 * The peer check's wait (board ab-4wh.22): a client that the first read does not show is read once more at its first
 * bytes, or after this time when no byte came; a client that ends within it is refused as closed.
 */
export const PEER_WAIT_MS = 250;
/**
 * At most this many clients are in the peer check's wait at a time (board ab-4wh.23): one more that the first read does
 * not show is refused at once as a stranger, so the processes that the read does not show hold at most this many of the
 * MAX_CONNECTIONS slots (on the Mac any local process can connect to the proxy's port).
 */
export const PEER_WAITING = 64;
/**
 * The texts of the peer check's refusals: a stranger's names the read of its system (Linux's /proc/net/tcp; the Mac's
 * read of the blanket Chrome's own processes); a client that ended before the decision has its own.
 */
export const PEER_TEXT = {
  linux: "a client: it is not a process of the service's user, or /proc/net/tcp does not show it",
  mac: "a client: it is not a process of the service's user, or the blanket Chrome's processes do not hold it",
  closed: "a client: it closed before its peer check",
} as const;
/** The greeting and the request together hold at most this many bytes (a greeting has at most 257, a request at most 262). */
export const MAX_HANDSHAKE_BYTES = 600;
/** At most this many lookups of the box's resolver at a time. */
export const LOOKUPS_AT_ONCE = 2;
/** A connection's lookup must answer within this time (its wait for a free lookup included); else the connection is refused. */
export const LOOKUP_MS = 10_000;
/**
 * At most this many lookups wait for a free one (board ab-4wh.6, the review's I1): a connection whose lookup would be one
 * more is refused at once. A waiting lookup whose connections all gave up or closed leaves the queue (board ab-4wh.14:
 * at the client's end, error or close, not at the lookup's limit), and a stop drops the queue.
 */
export const WAITING_LOOKUPS = 64;
/** The connect to the checked addresses must succeed within this time; else the connection fails. */
export const CONNECT_MS = 15_000;
/**
 * When one side of a tunnel ends (its FIN), the other side must end within this time, else the proxy closes both (board
 * ab-4wh.6, the review's I2). An open tunnel has no idle limit: a quiet WebSocket stays.
 */
export const HALF_CLOSE_MS = 30_000;
/** The next checked address is tried this long after the last one started, while that one has not connected. */
export const NEXT_ADDRESS_MS = 250;
/** At most this many addresses of one name are tried. */
export const MAX_ADDRESSES = 8;
/** A name's checked addresses are kept this long (the time of Chrome's own host cache), at most CACHE_NAMES names. */
export const CACHE_MS = 60_000;
export const CACHE_NAMES = 256;
/** The refusal log: at most LOG_LINES lines in LOG_WINDOW_MS, then one line with the count of the others. */
export const LOG_LINES = 20;
export const LOG_WINDOW_MS = 10_000;

/** The flags of the blanket Chrome for a proxy on `port` (they go before the config's chrome_args: unit.ts, chromeLaunch). */
export function proxyFlags(port: number): string[] {
  return [`--proxy-server=socks5://127.0.0.1:${port}`, "--proxy-bypass-list=<-loopback>", "--webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-quic"];
}

/**
 * The switches that the config's chrome_args may not hold for the blanket Chrome: each one would change its proxy or
 * WebRTC's UDP (--no-proxy-server, --proxy-pac-url and --proxy-auto-detect win over --proxy-server in Chrome), or would
 * load an unpacked extension, whose `proxy` permission wins over the command line (--load-extension and
 * --disable-extensions-except both load the folders that they name in Chromium; Google Chrome ignores both; board
 * ab-4wh.6, the review's M4). The blanket Chrome's receiver comes from the external extensions file, never from them.
 */
export const PROXY_SWITCHES: readonly string[] = ["no-proxy-server", "proxy-server", "proxy-pac-url", "proxy-auto-detect", "proxy-bypass-list", "webrtc-ip-handling-policy", "load-extension", "disable-extensions-except"];

/**
 * The reason that the blanket Chrome refuses `args` (the config's chrome_args), or null. Each element's switch name is
 * read as assertSafeChromeArgs reads it (agent.ts, chromeSwitchName: whitespace trimmed, the leading "-", "--" or "/"
 * gone, the name ending at the first "=", any case), so "-Proxy-Server=..." or "/proxy-server" is refused too.
 */
export function proxySwitchRefusal(args: readonly string[]): string | null {
  for (const a of args) {
    const name = chromeSwitchName(a);
    if (name !== undefined && PROXY_SWITCHES.includes(name)) return `the config's chrome_args hold --${name}, which would take the blanket Chrome past its address proxy`;
  }
  return null;
}

/** The kind of a host in a refusal's log line: never the host itself. */
export type HostKind = "a name" | "an IPv4 address" | "an IPv6 address";
/** The check of a connection's target: the addresses to connect to (each one checked), or the kind and the reason. */
export type TargetCheck = { ok: true; addresses: string[] } | { ok: false; kind: HostKind; why: string };

/** SOCKS5's reply codes (RFC 1928). */
export const REPLY = { ok: 0, failure: 1, notAllowed: 2, unreachable: 4, refused: 5, command: 7, addressType: 8 } as const;

/** A parsed greeting: the bytes that it used; or its error (with the reply that goes before the close, if any); or null (more bytes). */
export type Greeting = { used: number } | { error: string; reply: Buffer | null } | null;

/** Parse the client's greeting (VER, NMETHODS, METHODS). Only SOCKS5 with the method 00 (no authentication) passes. */
export function parseGreeting(b: Buffer): Greeting {
  if (b.length < 1) return null;
  if (b[0] !== 5) return { error: "it is no SOCKS5 greeting", reply: null };
  if (b.length < 2) return null;
  const n = b[1];
  if (b.length < 2 + n) return null;
  if (!b.subarray(2, 2 + n).includes(0)) return { error: "its greeting offers no method without authentication", reply: Buffer.from([5, 0xff]) };
  return { used: 2 + n };
}

/** A parsed request: the host and port of a CONNECT; or its error with its reply code; or null (more bytes). */
export type Request = { host: string; port: number; used: number } | { error: string; code: number } | null;

/** Parse the client's request (VER, CMD, RSV, ATYP, DST.ADDR, DST.PORT). Only CONNECT passes. */
export function parseRequest(b: Buffer): Request {
  if (b.length < 4) return null;
  if (b[0] !== 5 || b[2] !== 0) return { error: "it is no SOCKS5 request", code: REPLY.failure };
  if (b[1] !== 1) return { error: b[1] === 2 ? "it asks for BIND" : b[1] === 3 ? "it asks for UDP ASSOCIATE" : "it asks for an unknown command", code: REPLY.command };
  let host: string, at: number;
  if (b[3] === 1) {
    if (b.length < 10) return null;
    host = `${b[4]}.${b[5]}.${b[6]}.${b[7]}`; at = 8;
  } else if (b[3] === 4) {
    if (b.length < 22) return null;
    const g: string[] = [];
    for (let i = 0; i < 8; i++) g.push(b.readUInt16BE(4 + 2 * i).toString(16));
    host = g.join(":"); at = 20;
  } else if (b[3] === 3) {
    if (b.length < 5) return null;
    const n = b[4];
    if (b.length < 5 + n + 2) return null;
    const raw = b.subarray(5, 5 + n);
    if (n === 0 || raw.some((c) => c < 0x21 || c > 0x7e)) return { error: "its host is empty or not printable ASCII", code: REPLY.failure };
    host = raw.toString("latin1"); at = 5 + n;
  } else return { error: "its address type is unknown", code: REPLY.addressType };
  const port = b.readUInt16BE(at);
  if (port === 0) return { error: "it names port 0", code: REPLY.failure };
  return { host, port, used: at + 2 };
}

/** The reply of a CONNECT (the bound address 0.0.0.0:0: Chrome reads none of it). */
const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

/** The addresses of the box's own network interfaces, now (os.networkInterfaces: getifaddrs). */
export const boxAddresses = (): string[] => Object.values(networkInterfaces()).flat().filter((a) => a !== undefined).map((a) => a!.address);

export type AddressProxyOptions = {
  log: (line: string) => void;
  /** The box's resolver (getaddrinfo, as Chrome's own on Linux). */
  resolve?: Resolve;
  /**
   * The lines of /proc/net/tcp (the peer check), or null when they cannot be read. On the Mac (board ab-4wh.16) the
   * sockets of the blanket Chrome's own processes (mac.ts, macTreeTcpReader).
   */
  tcp?: () => readonly TcpLine[] | null;
  /** The system of `tcp`'s read, for the stranger's text (PEER_TEXT); by default the platform's. */
  system?: "linux" | "mac";
  /**
   * The closed mode (board ab-4wh.16: the blanket template's set-up Chrome on the Mac): each CONNECT gets the reply 02
   * after its request, with no lookup and no connect. Nothing passes, so no peer check runs.
   */
  closed?: boolean;
  /** The service's uid: the only uid whose client the proxy admits. */
  uid?: number;
  /** The box's own addresses, read at each connection (an address can change). */
  ownAddresses?: () => readonly string[];
  /**
   * Tests only (the blanket live check's local stand-in of a public host; no CLI flag sets it): an address of a host that
   * passes before the address rule.
   */
  admit?: (host: string, address: string, port: number) => boolean;
  /** Tests only: the connect to a checked address (an IP literal). */
  connect?: (address: string, port: number) => Socket;
  clock?: () => number;
  /** Tests only: the limits above. */
  limits?: Partial<Limits>;
};

type Limits = { connections: number; handshakeMs: number; peerMs: number; peerWaiting: number; lookupMs: number; connectMs: number; lookupsAtOnce: number; waitingLookups: number; halfCloseMs: number };
type Cached = { all: string[]; at: number };
/**
 * One lookup of a name, shared by the connections that wait for it: `users` counts them. A lookup that waits for a free
 * slot leaves the queue when its last user gives up or its client goes; one in getaddrinfo holds its slot until it ends,
 * and its answer reaches only its own run of the proxy.
 */
type Lookup = { key: string; host: string; run: number; users: number; started: boolean; p: Promise<string[]>; settle: (all: string[]) => void };

/** The address proxy: start() before the blanket Chrome, stop() after it. */
export class AddressProxy {
  private readonly o: AddressProxyOptions;
  private readonly resolve: Resolve;
  private readonly tcp: () => readonly TcpLine[] | null;
  private readonly stranger: string;
  private readonly system: "linux" | "mac";
  private readonly uid: number;
  private readonly own: () => readonly string[];
  private readonly clock: () => number;
  private readonly lim: Limits;
  private server: Server | null = null;
  private portNow: number | null = null;
  /** Every socket of the proxy (clients and their upstream sockets): stop() destroys them. */
  private readonly sockets = new Set<Socket>();
  private clients = 0;
  /** The clients of this run in the peer check's wait now. */
  private peerWaiting = 0;
  /** A start's number: an answer that comes after a stop finds another number and closes its sockets. */
  private run = 0;
  private readonly cache = new Map<string, Cached>();
  /** The lookups of this run that wait or run, by name. */
  private readonly flying = new Map<string, Lookup>();
  /** The lookups in getaddrinfo now, of any run (each holds a thread of libuv's pool until it ends). */
  private lookups = 0;
  /** The lookups of this run that wait for a free slot, in order. */
  private waiting: Lookup[] = [];
  private passedN = 0;
  private refusedN = 0;
  private logAt = -Infinity;
  private logLines = 0;
  private logDropped = 0;

  constructor(o: AddressProxyOptions) {
    this.o = o;
    this.resolve = o.resolve ?? systemResolve;
    this.tcp = o.tcp ?? procReader().tcp;
    this.system = o.system ?? (process.platform === "darwin" ? "mac" : "linux");
    this.stranger = PEER_TEXT[this.system];
    this.uid = o.uid ?? process.getuid?.() ?? -1;
    this.own = o.ownAddresses ?? boxAddresses;
    this.clock = o.clock ?? (() => performance.now());
    this.lim = { connections: MAX_CONNECTIONS, handshakeMs: HANDSHAKE_MS, peerMs: PEER_WAIT_MS, peerWaiting: PEER_WAITING, lookupMs: LOOKUP_MS, connectMs: CONNECT_MS, lookupsAtOnce: LOOKUPS_AT_ONCE, waitingLookups: WAITING_LOOKUPS, halfCloseMs: HALF_CLOSE_MS, ...o.limits };
  }

  /** The port while the proxy listens, or null. */
  port(): number | null { return this.portNow; }
  listening(): boolean { return this.server !== null; }
  /**
   * The counts since the last start, the clients in the peer check's wait now (`peer`), and the lookups now: waiting and
   * of this run (`flying`), and in getaddrinfo (any run).
   */
  counts(): { passed: number; refused: number; open: number; peer: number; waiting: number; flying: number; lookups: number } {
    return { passed: this.passedN, refused: this.refusedN, open: this.clients, peer: this.peerWaiting, waiting: this.waiting.length, flying: this.flying.size, lookups: this.lookups };
  }

  /** Listen on 127.0.0.1 on a port that the kernel picks; the port. A proxy that listens keeps its port. */
  async start(): Promise<number> {
    if (this.server && this.portNow !== null) return this.portNow;
    const run = ++this.run;
    this.passedN = 0; this.refusedN = 0;
    const server = createServer({ allowHalfOpen: true, noDelay: true }, (s) => this.accept(s, run));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => { server.off("error", reject); resolve(); });
    });
    server.unref();
    server.on("error", (e) => this.o.log(`blanket: the address proxy's listener failed (${(e as NodeJS.ErrnoException).code ?? "error"})`));
    if (run !== this.run) { server.close(); throw new Error("the address proxy was stopped during its start"); }
    this.server = server;
    this.portNow = (server.address() as AddressInfo).port;
    this.o.log(`blanket: the address proxy listens on 127.0.0.1:${this.portNow}`);
    return this.portNow;
  }

  /** Close the listener and every connection; nothing listens after it. */
  async stop(): Promise<void> {
    this.run++;
    const server = this.server;
    this.server = null; this.portNow = null;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.clients = 0;
    this.peerWaiting = 0;
    this.cache.clear();
    // The lookups of the old run: the waiting ones go (no getaddrinfo starts for them); one in getaddrinfo ends there and
    // frees its slot, and its answer reaches no new run.
    const old = [...this.flying.values()];
    this.waiting = [];
    this.flying.clear();
    for (const l of old) if (!l.started) l.settle([]);
    this.flushLog();
    if (!server) return;
    await new Promise<void>((r) => server.close(() => r()));
    this.o.log(`blanket: the address proxy stopped (${this.passedN} connection(s) passed, ${this.refusedN} refused)`);
  }

  // ------------------------------------------------------------------ the log

  private flushLog(): void {
    if (this.logDropped > 0) this.o.log(`blanket: the address proxy refused ${this.logDropped} more connection(s) (at most ${LOG_LINES} log lines in ${LOG_WINDOW_MS / 1000} s)`);
    this.logDropped = 0;
  }

  /** One refusal: its count, and its log line (`text` names no host, address, path or query). */
  private refusal(text: string): void {
    this.refusedN++;
    const now = this.clock();
    if (now - this.logAt >= LOG_WINDOW_MS) { this.flushLog(); this.logAt = now; this.logLines = 0; }
    if (this.logLines < LOG_LINES) { this.logLines++; this.o.log(`blanket: the address proxy refused ${text}`); }
    else this.logDropped++;
  }

  // ------------------------------------------------------------------ a connection

  private keep(s: Socket): void {
    this.sockets.add(s);
    s.once("close", () => this.sockets.delete(s));
    s.on("error", () => {});
  }

  /** Close a client after its SOCKS reply (or none). */
  private refuse(client: Socket, answer: Buffer | null): void {
    if (client.destroyed) return;
    if (answer) client.end(answer); else client.destroy();
    setTimeout(() => client.destroy(), 1_000).unref?.();
  }

  private accept(client: Socket, run: number): void {
    if (run !== this.run || this.server === null) { client.destroy(); return; }
    this.keep(client);
    if (this.clients >= this.lim.connections) {
      this.refusal(`a connection: it already holds ${this.lim.connections} connections`);
      client.destroy();
      return;
    }
    this.clients++;
    client.once("close", () => { if (run === this.run) this.clients--; });
    const at = performance.now();
    // The closed mode refuses every request: no peer check.
    if (this.o.closed) { this.handshake(client, run, null, at); return; }
    // The peer check: the client's line by the full tuple, with the service's uid. A client that the first read does not
    // show waits for a second read, while fewer than peerWaiting others wait (board ab-4wh.23).
    const first = this.peer(client);
    if (first === "admit") { this.handshake(client, run, null, at); return; }
    if (this.atOnce(first) || this.peerWaiting >= this.lim.peerWaiting) { this.refusal(this.stranger); client.destroy(); return; }
    this.awaitPeer(client, run, at);
  }

  /**
   * One read of the peer check: "admit" for the client's line (the full tuple) with the service's uid, "stranger" for its
   * line with another uid, "none" for no line, "unread" when the read fails. A line with no holder (inode 0) counts as no
   * line: on Linux a socket that its process has closed (a FIN or time-wait state) shows uid 0 and inode 0 until it goes.
   * On the Mac a socket's handle number stands for the inode, and a handle of 0 counts as no line too (fail closed).
   */
  private peer(client: Socket): "admit" | "stranger" | "none" | "unread" {
    let lines: readonly TcpLine[] | null;
    try { lines = this.tcp(); } catch { lines = null; }
    if (lines === null) return "unread";
    let line: TcpLine | null = null;
    try { line = clientLine(lines.filter((l) => l.inode !== 0), `${client.remoteAddress}:${client.remotePort}`, `127.0.0.1:${this.portNow}`); } catch {}
    return line === null ? "none" : line.uid === this.uid ? "admit" : "stranger";
  }

  /**
   * A read that refuses at once, with no wait (board ab-4wh.23): a line of another uid; and on Linux a /proc/net/tcp that
   * cannot be read (a second read gives no more). On the Mac a failed read waits: the read of the blanket Chrome's tree
   * fails while the service does not hold that Chrome's main process yet.
   */
  private atOnce(p: "admit" | "stranger" | "none" | "unread"): boolean {
    return p === "stranger" || (p === "unread" && this.system === "linux");
  }

  /**
   * The peer check's wait for a client that the first read does not show (board ab-4wh.22). Its first bytes (kept for the
   * handshake), or PEER_WAIT_MS with no byte, bring the second read: a line with the service's uid admits the client, a
   * line of another uid refuses it at once, and with no line again it is refused as a stranger when the wait ends. A
   * client that ends (its end, an error or its close) before the decision is refused as closed. The client gets no byte
   * before its admission, and no third read runs. The client counts in `peerWaiting` until the decision.
   */
  private awaitPeer(client: Socket, run: number, at: number): void {
    const got: Buffer[] = [];
    let read = false, over = false;
    this.peerWaiting++;
    const finish = () => {
      if (over) return;
      over = true;
      if (run === this.run) this.peerWaiting--;
      clearTimeout(timer); client.off("data", onData); client.off("end", onEnd); client.off("error", onEnd); client.off("close", onEnd);
    };
    const stranger = () => { finish(); this.refusal(this.stranger); client.destroy(); };
    const second = (last: boolean) => {
      read = true;
      const p = this.peer(client);
      if (p === "admit") { finish(); this.handshake(client, run, Buffer.concat(got), at); }
      else if (this.atOnce(p) || last) stranger();
    };
    // The bytes after the second read are dropped: that client is never admitted.
    const onData = (d: Buffer) => { if (over || read) return; got.push(d); second(false); };
    const onEnd = () => {
      if (over) return;
      finish();
      if (run === this.run) this.refusal(PEER_TEXT.closed);
      client.destroy();
    };
    const timer = setTimeout(() => {
      if (over) return;
      if (run !== this.run || client.destroyed) { finish(); client.destroy(); return; }
      if (read) stranger(); else second(true);
    }, this.lim.peerMs);
    timer.unref?.();
    client.on("data", onData);
    client.once("end", onEnd);
    client.once("error", onEnd);
    client.once("close", onEnd);
  }

  /**
   * Read the greeting and the request (bounded in time and bytes), then serve the CONNECT. `first`: the bytes that the
   * peer check's wait read; `at`: the accept's time (the handshake's limit counts from it).
   */
  private handshake(client: Socket, run: number, first: Buffer | null, at: number): void {
    let buf = Buffer.alloc(0);
    let greeted = false;
    const timer = setTimeout(() => { done(); this.refusal(`a malformed request: it did not come in ${this.lim.handshakeMs / 1000} s`); this.refuse(client, null); }, Math.max(0, this.lim.handshakeMs - (performance.now() - at)));
    timer.unref?.();
    const done = () => { clearTimeout(timer); client.off("data", onData); client.off("end", onEnd); };
    const bad = (why: string, answer: Buffer | null) => { done(); this.refusal(`a malformed request: ${why}`); this.refuse(client, answer); };
    const onEnd = () => { done(); client.destroy(); };
    // The handshake's bytes: a parse that needs more bytes keeps at most MAX_HANDSHAKE_BYTES (a greeting needs at most
    // 257 and a request at most 262, so a valid one never reaches it); the bytes after the request (at most one read's
    // chunk) go upstream after the connect.
    const more = () => { if (buf.length > MAX_HANDSHAKE_BYTES) bad(`it is longer than ${MAX_HANDSHAKE_BYTES} bytes`, null); };
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!greeted) {
        const g = parseGreeting(buf);
        if (g === null) return more();
        if ("error" in g) return bad(g.error, g.reply);
        greeted = true;
        buf = buf.subarray(g.used);
        client.write(Buffer.from([5, 0]));
      }
      const r = parseRequest(buf);
      if (r === null) return more();
      if ("error" in r) return bad(r.error, reply(r.code));
      done();
      client.pause();
      void this.serve(client, r.host, r.port, buf.subarray(r.used), run);
    };
    client.on("data", onData);
    client.once("end", onEnd);
    client.once("close", () => clearTimeout(timer));
    if (first !== null && first.length > 0) onData(first);
  }

  private async serve(client: Socket, host: string, port: number, rest: Buffer, run: number): Promise<void> {
    if (this.o.closed) { this.refusal("a connection: the closed proxy of the blanket template's set-up passes none"); this.refuse(client, reply(REPLY.notAllowed)); return; }
    // The client's end, error or close during the check ends its use of the lookup at once (board ab-4wh.14): a waiting
    // lookup whose clients all went leaves the queue then, so no getaddrinfo starts for a closed connection. The client is
    // paused, but its stream still sees its end and a reset (its bytes after the request stay in the stream for the pipe;
    // an end behind such bytes shows only after the check).
    const gone = new AbortController();
    const onGone = () => gone.abort();
    client.once("end", onGone); client.once("error", onGone); client.once("close", onGone);
    let check: TargetCheck;
    try { check = await this.check(host, port, gone.signal); }
    catch { check = { ok: false, kind: "a name", why: "its addresses cannot be read" }; }
    finally { client.off("end", onGone); client.off("error", onGone); client.off("close", onGone); }
    if (run !== this.run || client.destroyed || gone.signal.aborted) { client.destroy(); return; }
    if (!check.ok) { this.refusal(`a connection to ${check.kind}: ${check.why}`); this.refuse(client, reply(REPLY.notAllowed)); return; }
    const up = await this.dial(check.addresses, port, run);
    if (run !== this.run || client.destroyed) { up?.destroy(); client.destroy(); return; }
    if (up === null) { this.refuse(client, reply(REPLY.unreachable)); return; }
    this.passedN++;
    // The half-close limit: once one side has ended, the other side must end within halfCloseMs (an upstream that ignores
    // the FIN would hold the pair and its slot). An open pair has no idle limit.
    let half: ReturnType<typeof setTimeout> | undefined;
    const close = () => { clearTimeout(half); client.destroy(); up.destroy(); };
    const ended = () => { if (half === undefined) { half = setTimeout(close, this.lim.halfCloseMs); half.unref?.(); } };
    client.once("end", ended); up.once("end", ended);
    client.once("close", close); up.once("close", close);
    client.once("error", close); up.once("error", close);
    client.write(reply(REPLY.ok));
    if (rest.length) up.write(rest);
    client.pipe(up); up.pipe(client);
    client.resume();
  }

  // ------------------------------------------------------------------ the rule

  /** Why `address` is refused (a range of address.ts, or an address of the box's own interfaces), or null. */
  private refusedAddress(address: string): string | null {
    const why = refusedIp(address);
    if (why) return why;
    const list = new BlockList();
    for (const a of this.own()) {
      const f = isIP(a.split("%")[0]);
      try { if (f === 4) list.addAddress(a, "ipv4"); else if (f === 6) list.addAddress(a.split("%")[0], "ipv6"); } catch {}
    }
    const f = isIP(address.split("%")[0]);
    try { if (f !== 0 && list.check(address.split("%")[0], f === 4 ? "ipv4" : "ipv6")) return "an address of this box"; } catch { return "no IP address"; }
    return null;
  }

  /**
   * The check of a CONNECT's host (the address rule): an IP literal by its range and the box's own addresses; a name by its
   * name, then by every address of the box's resolver (one refused address refuses it; no address refuses it). `gone`:
   * the connection's client went (its lookup ends at once).
   */
  async check(host: string, port: number, gone?: AbortSignal): Promise<TargetCheck> {
    const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    const family = isIP(literal.split("%")[0]);
    if (family !== 0) {
      const kind: HostKind = family === 4 ? "an IPv4 address" : "an IPv6 address";
      if (this.o.admit?.(host, literal, port)) return { ok: true, addresses: [literal] };
      const why = this.refusedAddress(literal);
      return why ? { ok: false, kind, why: `it is ${why}` } : { ok: true, addresses: [literal] };
    }
    const byName = refusedName(host);
    if (byName) return { ok: false, kind: "a name", why: `it is ${byName}` };
    const all = await this.lookup(host, gone);
    if (all === "gone") return { ok: false, kind: "a name", why: "its client went during its lookup" };
    if (all === "late") return { ok: false, kind: "a name", why: `its lookup did not answer in ${this.lim.lookupMs / 1000} s` };
    if (all === "full") return { ok: false, kind: "a name", why: `${this.lim.waitingLookups} lookups already wait` };
    if (all.length === 0) return { ok: false, kind: "a name", why: "it has no address in the box's resolver" };
    for (const a of all) {
      if (this.o.admit?.(host, a, port)) continue;
      const why = this.refusedAddress(a);
      if (why) return { ok: false, kind: "a name", why: `it has ${why}` };
    }
    return { ok: true, addresses: all };
  }

  /** Start `l` in getaddrinfo: it holds a slot until it ends; then the next waiting lookup of the current run starts. */
  private startLookup(l: Lookup): void {
    l.started = true;
    this.lookups++;
    let p: Promise<string[]>;
    try { p = this.resolve(l.host); } catch (e) { p = Promise.reject(e); }
    void p.then((all) => all, () => [] as string[]).then((all) => {
      this.lookups--;
      if (this.flying.get(l.key) === l) this.flying.delete(l.key);
      if (all.length > 0 && l.run === this.run) {
        this.cache.delete(l.key);
        this.cache.set(l.key, { all: [...all], at: this.clock() });
        while (this.cache.size > CACHE_NAMES) this.cache.delete(this.cache.keys().next().value!);
      }
      l.settle(l.run === this.run ? all : []);
      this.nextLookup();
    });
  }

  /** Start waiting lookups while a slot is free. */
  private nextLookup(): void {
    while (this.lookups < this.lim.lookupsAtOnce && this.waiting.length > 0) this.startLookup(this.waiting.shift()!);
  }

  /**
   * Every address of `host` (cached for CACHE_MS); "late" when no answer came in lookupMs; "full" when the lookup would
   * wait behind waitingLookups others; "gone" when `gone` aborts first (the connection's client went).
   */
  private async lookup(host: string, gone?: AbortSignal): Promise<string[] | "late" | "full" | "gone"> {
    const key = host.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && this.clock() - hit.at < CACHE_MS) return hit.all;
    if (gone?.aborted) return "gone";
    let l = this.flying.get(key);
    if (!l) {
      const free = this.lookups < this.lim.lookupsAtOnce && this.waiting.length === 0;
      if (!free && this.waiting.length >= this.lim.waitingLookups) return "full";
      let settle!: (all: string[]) => void;
      const p = new Promise<string[]>((r) => { settle = r; });
      l = { key, host, run: this.run, users: 0, started: false, p, settle };
      this.flying.set(key, l);
      if (free) this.startLookup(l); else this.waiting.push(l);
    }
    const mine = l;
    mine.users++;
    // This connection's use ends once: at the answer, at the limit, or at once when its client goes (board ab-4wh.14). A
    // lookup that waits and whose connections all left leaves the queue: no getaddrinfo starts for it.
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      if (--mine.users === 0 && !mine.started) {
        this.waiting = this.waiting.filter((w) => w !== mine);
        if (this.flying.get(key) === mine) this.flying.delete(key);
        mine.settle([]);
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onGone: (() => void) | undefined;
    const late = new Promise<"late">((r) => { timer = setTimeout(() => r("late"), this.lim.lookupMs); timer.unref?.(); });
    const went = new Promise<"gone">((r) => { onGone = () => { r("gone"); leave(); }; gone?.addEventListener("abort", onGone, { once: true }); });
    try {
      const got = await Promise.race([mine.p.then((all) => [...all]), late, went]);
      leave();
      return got;
    } finally { clearTimeout(timer); if (onGone) gone?.removeEventListener("abort", onGone); }
  }

  // ------------------------------------------------------------------ the connect

  private connectTo(address: string, port: number): Socket {
    if (this.o.connect) return this.o.connect(address, port);
    // An IP literal: node makes no lookup; the lookup function fails, so a name could never be resolved here.
    return netConnect({ host: address, port, allowHalfOpen: true, noDelay: true, lookup: (_h, _o, cb) => (cb as (e: Error) => void)(new Error("no lookup in the address proxy")) });
  }

  /** Connect to the first of `addresses` that answers (the next one starts NEXT_ADDRESS_MS later), within connectMs; or null. */
  private dial(addresses: readonly string[], port: number, run: number): Promise<Socket | null> {
    const list = addresses.slice(0, MAX_ADDRESSES);
    return new Promise((resolve) => {
      const tries: Socket[] = [];
      let next = 0, failed = 0, over = false;
      let stagger: ReturnType<typeof setTimeout> | undefined;
      const finish = (s: Socket | null) => {
        if (over) return;
        over = true;
        clearTimeout(stagger); clearTimeout(limit);
        for (const t of tries) if (t !== s) t.destroy();
        resolve(run === this.run ? s : (s?.destroy(), null));
      };
      const limit = setTimeout(() => finish(null), this.lim.connectMs);
      limit.unref?.();
      const attempt = () => {
        if (over || next >= list.length) return;
        const address = list[next++];
        let s: Socket;
        try { s = this.connectTo(address, port); } catch { failed++; if (failed === list.length) finish(null); else attempt(); return; }
        this.keep(s);
        tries.push(s);
        let connected = false;
        s.once("connect", () => { connected = true; finish(s); });
        s.once("close", () => {
          if (connected || over) return;
          failed++;
          if (failed === list.length) finish(null);
          else if (next < list.length) { clearTimeout(stagger); attempt(); }
        });
        if (next < list.length) { clearTimeout(stagger); stagger = setTimeout(attempt, NEXT_ADDRESS_MS); stagger.unref?.(); }
      };
      attempt();
    });
  }
}
