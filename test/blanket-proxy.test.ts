// The address proxy of the blanket Chrome (board ab-4wh.6; C11, the blanket profile: the address proxy; the design
// docs/superpowers/specs/2026-11-25-blanket-profile-design.md, section 12): a real proxy on 127.0.0.1 with a fake resolver,
// a fake /proc/net/tcp, fake box addresses and a connect hook that records each address and reaches a local upstream.
//
// - a public address passes, and the proxy connects only to the address that it checked (an IP literal);
// - each refused range refuses (IPv4, IPv6 and the mapped forms), as an IP literal of each address type and as a name's
//   address; a name with one bad address of several refuses; a name refused by its name, or with no address, refuses;
//   the box's own addresses refuse, read at each connection;
// - a name whose address changes at the second lookup never reaches the private address;
// - only SOCKS5 CONNECT with "no authentication" passes; each malformed request gets its reply and closes;
// - only a client of the service's uid passes; a client that the first read does not show is read once more (at its
//   first bytes or after the wait), and one that ended before the decision is refused as closed, never as a stranger;
// - the peer check's wait holds at most PEER_WAITING clients, and on Linux a failed read refuses at once (board ab-4wh.23);
// - the limits: the connections, the handshake's time (from the accept), the lookups at a time and a lookup's time, the
//   connect's time; a waiting lookup leaves the queue when its clients go or give up (board ab-4wh.14);
// - the lifecycle: nothing listens before the start or after the stop; the stop closes each tunnel;
// - the log: one line per refusal with the kind of host and the reason, never a host or an address; at most 20 lines in
//   10 s, then one line with the count.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { connect, createServer, Socket, type AddressInfo, type Server } from "node:net";
import { AddressProxy, CONNECT_MS, HALF_CLOSE_MS, HANDSHAKE_MS, LOG_LINES, LOOKUP_MS, LOOKUPS_AT_ONCE, MAX_CONNECTIONS, PEER_TEXT, PEER_WAIT_MS, PEER_WAITING, PROXY_SWITCHES, parseGreeting, parseRequest, proxyFlags, proxySwitchRefusal, REPLY, WAITING_LOOKUPS, type AddressProxyOptions } from "../src/service/blanket/proxy.ts";
import { procReader, type TcpLine } from "../src/service/mcp/proc.ts";

const UID = 4242;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = (c: { waiting: number; flying: number; lookups: number }) => ({ waiting: c.waiting, flying: c.flying, lookups: c.lookups });

/** The 16 bytes of an IPv6 address (with "::" and a dotted IPv4 tail). */
function v6Bytes(ip: string): number[] {
  let s = ip;
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) { const [a, b, c, d] = tail[2].split(".").map(Number); s = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`; }
  const [l, r] = s.split("::");
  const part = (x: string | undefined) => (x ? x.split(":").map((g) => parseInt(g, 16)) : []);
  const a = part(l), b = r === undefined ? [] : part(r);
  const g = [...a, ...Array(8 - a.length - b.length).fill(0), ...b];
  return g.flatMap((x) => [x >> 8, x & 255]);
}
const port2 = (p: number) => [p >> 8, p & 255];
const byName = (host: string, port = 443) => Buffer.from([5, 1, 0, 3, host.length, ...Buffer.from(host, "latin1"), ...port2(port)]);
const byV4 = (ip: string, port = 443) => Buffer.from([5, 1, 0, 1, ...ip.split(".").map(Number), ...port2(port)]);
const byV6 = (ip: string, port = 443) => Buffer.from([5, 1, 0, 4, ...v6Bytes(ip), ...port2(port)]);
const GREET = Buffer.from([5, 1, 0]);

type Rig = {
  proxy: AddressProxy; port: number; logs: string[]; dials: string[]; lookups: string[]; own: string[]; now: { t: number };
  tcpUid: { v: number | null }; clients: Set<Socket>; close: () => Promise<void>;
};

async function listen(s: Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return (s.address() as AddressInfo).port;
}

/**
 * A proxy with a fake world: `names` gives each name's addresses (a function gets the lookup's number); `tcp` wraps the
 * fake /proc/net/tcp (it gets the rig's own read).
 */
async function rig(o: { names?: Record<string, string[] | ((n: number) => string[] | Promise<string[]>)>; own?: string[]; real?: boolean; tcp?: (own: () => TcpLine[] | null) => () => readonly TcpLine[] | null; extra?: Partial<AddressProxyOptions> } = {}): Promise<Rig> {
  const upstream = createServer((s) => { s.on("error", () => {}); s.write("hello"); s.on("data", (d) => s.write(d)); });
  const upPort = await listen(upstream);
  const logs: string[] = [], dials: string[] = [], lookups: string[] = [];
  const own = [...(o.own ?? ["127.0.0.1", "::1"])];
  const now = { t: 1_000_000 };
  const tcpUid: { v: number | null } = { v: UID };
  const count = new Map<string, number>();
  // The fake /proc/net/tcp: one line for each open client socket of this rig (its local port to the proxy's port).
  const clients = new Set<Socket>();
  const fake = (): TcpLine[] | null => (tcpUid.v === null ? null : [...clients].filter((c) => !c.destroyed && c.localPort !== undefined).map((c) => ({ local: `127.0.0.1:${c.localPort}`, remote: `127.0.0.1:${proxy.port()}`, uid: tcpUid.v!, inode: 1 })));
  const proxy: AddressProxy = new AddressProxy({
    log: (l) => logs.push(l),
    system: "linux",
    resolve: async (h) => {
      lookups.push(h);
      count.set(h, (count.get(h) ?? 0) + 1);
      const v = o.names?.[h];
      if (v === undefined) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return typeof v === "function" ? v(count.get(h)!) : v;
    },
    tcp: o.tcp ? o.tcp(fake) : fake,
    uid: UID,
    ownAddresses: () => own,
    ...(o.real ? {} : { connect: (address: string, port: number) => { dials.push(`${address} ${port}`); return connect({ host: "127.0.0.1", port: upPort }); } }),
    clock: () => now.t,
    ...o.extra,
  });
  const port = await proxy.start();
  return { proxy, port, logs, dials, lookups, own, now, tcpUid, clients, close: async () => { await proxy.stop(); for (const c of clients) c.destroy(); await new Promise<void>((r) => upstream.close(() => r())); } };
}

/** A client of the rig: it sends `bytes`, and collects what comes back until the close or `ms`. */
async function talk(r: Rig, bytes: Buffer | null, o: { ms?: number; until?: (got: Buffer) => boolean; keep?: boolean } = {}): Promise<{ got: Buffer; closed: boolean; sock: Socket }> {
  const clients = r.clients;
  const sock = new Socket();
  clients.add(sock);
  let got = Buffer.alloc(0), closed = false;
  sock.on("data", (d: Buffer) => { got = Buffer.concat([got, d]); });
  sock.on("error", () => {});
  sock.on("close", () => { closed = true; clients.delete(sock); });
  await new Promise<void>((res) => sock.connect(r.port, "127.0.0.1", () => res()));
  if (bytes) sock.write(bytes);
  const end = Date.now() + (o.ms ?? 1_500);
  while (!closed && Date.now() < end && !(o.until?.(got) ?? false)) await sleep(5);
  if (!o.keep) sock.destroy();
  return { got, closed, sock };
}

/** A client of the rig that stays open: it sends `bytes` (none when empty); its bytes so far and its close, read at any time. */
async function opened(r: Rig, bytes: Buffer): Promise<{ sock: Socket; got: () => Buffer; closed: () => boolean }> {
  const sock = new Socket();
  r.clients.add(sock);
  let got = Buffer.alloc(0), closed = false;
  sock.on("data", (d: Buffer) => { got = Buffer.concat([got, d]); });
  sock.on("error", () => {});
  sock.on("close", () => { closed = true; r.clients.delete(sock); });
  await new Promise<void>((res) => sock.connect(r.port, "127.0.0.1", () => res()));
  sock.setNoDelay(true);
  if (bytes.length) sock.write(bytes);
  return { sock, got: () => got, closed: () => closed };
}
/** Wait until `f` holds, at most `ms`; whether it holds. */
async function waitFor(f: () => boolean, ms = 2_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await sleep(5);
  return f();
}

/** A CONNECT through the rig: the greeting, the request; the reply's code, the bytes after it, and whether it closed. */
async function via(r: Rig, request: Buffer, o: { keep?: boolean; ms?: number } = {}) {
  const t = await talk(r, Buffer.concat([GREET, request]), { until: (g) => g.length >= 2 + 10 + 5, keep: o.keep, ms: o.ms });
  assert.deepEqual([...t.got.subarray(0, 2)], [5, 0], "the greeting's answer: no authentication");
  return { reply: t.got.subarray(2, 12), after: t.got.subarray(12).toString(), closed: t.closed, sock: t.sock };
}

const REFUSED_V4 = ["127.0.0.1", "127.255.255.254", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.255", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", "0.0.0.0", "0.1.2.3"];
const REFUSED_V6 = ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:192.168.0.1", "::127.0.0.1", "::ffff:0:192.168.1.1", "64:ff9b::10.0.0.1", "64:ff9b::7f00:1"];
const PUBLIC = ["93.184.216.34", "172.32.0.1", "100.128.0.1", "11.0.0.1", "2606:2800:220:1:248:1893:25c8:1946", "::ffff:93.184.216.34"];

test("a public address passes, as a name and as an IP literal of each address type; the proxy connects only to the address that it checked, and the bytes pass both ways", async () => {
  const r = await rig({ names: { "example.com": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] } });
  try {
    const a = await via(r, byName("example.com", 8443), { keep: true });
    assert.equal(a.reply[1], REPLY.ok);
    assert.equal(a.after, "hello", "the upstream's bytes reach the client");
    a.sock.write("ping");
    const until = Date.now() + 1_000;
    let echoed = "";
    a.sock.on("data", (d) => { echoed += d; });
    while (!echoed.includes("ping") && Date.now() < until) await sleep(5);
    assert.ok(echoed.includes("ping"), "the client's bytes reach the upstream and back");
    a.sock.destroy();
    assert.deepEqual(r.dials, ["93.184.216.34 8443"], "the first checked address, an IP literal: no name goes to the connect");
    assert.deepEqual(r.lookups, ["example.com"], "one lookup");
    for (const ip of PUBLIC) {
      for (const req of ip.includes(":") ? [byName(ip), byV6(ip)] : [byName(ip), byV4(ip)]) {
        const x = await via(r, req);
        assert.equal(x.reply[1], REPLY.ok, ip);
      }
    }
    assert.ok(r.dials.every((d) => /^[0-9a-f.:]+ \d+$/.test(d)), r.dials.join(" | "));
    assert.equal(r.proxy.counts().refused, 0);
  } finally { await r.close(); }
});

test("each refused range refuses, IPv4 and IPv6 and the mapped forms, as an IP literal (the domain form that Chrome sends, and the IPv4 and IPv6 address types) and as a name's address: reply 02, no connect, one log line with the kind and the reason and no host or address", async () => {
  const names: Record<string, string[]> = {};
  for (const [i, ip] of [...REFUSED_V4, ...REFUSED_V6].entries()) names[`n${i}.example`] = [ip];
  const r = await rig({ names });
  try {
    for (const [i, ip] of [...REFUSED_V4, ...REFUSED_V6].entries()) {
      const v6 = ip.includes(":");
      const literal = v6 ? "an IPv6 address" : "an IPv4 address";
      const forms: [Buffer, string][] = [[byName(ip), literal], [v6 ? byV6(ip) : byV4(ip), literal], [byName(`n${i}.example`), "a name"]];
      if (v6) forms.push([byName(`[${ip}]`), literal]);
      for (const [req, kind] of forms) {
        r.now.t += 10_001; // a new window of the log's cap
        const before = r.logs.length;
        const x = await via(r, req);
        assert.equal(x.reply[1], REPLY.notAllowed, `${ip} as ${kind}`);
        assert.ok(x.closed, `${ip}: the connection closes`);
        const line = r.logs.slice(before).find((l) => l.includes("refused"));
        assert.ok(line?.startsWith(`blanket: the address proxy refused a connection to ${kind}: it `), `${ip}: ${line}`);
        assert.ok(!line!.includes(ip) && !line!.includes(`n${i}.example`), `no host or address in the log: ${line}`);
      }
    }
    assert.deepEqual(r.dials, [], "the proxy connected to none of them");
    assert.ok(r.logs.some((l) => l === "blanket: the address proxy refused a connection to an IPv4 address: it is a loopback address"));
    assert.ok(r.logs.some((l) => l === "blanket: the address proxy refused a connection to a name: it has a private address in an IPv6 form"));
  } finally { await r.close(); }
});

test("a name with one bad address of several refuses; a name refused by its name and a name with no address refuse; the box's own addresses refuse, read at each connection", async () => {
  const r = await rig({ names: { "mixed.example": ["93.184.216.34", "10.0.0.5", "8.8.8.8"], "empty.example": [], "self.example": ["2604:4300:a:a8:be24:11ff:fe13:7f64"], "later.example": ["198.51.100.7"] },
    own: ["127.0.0.1", "::1", "63.141.248.173", "2604:4300:a:a8:be24:11ff:fe13:7f64"] });
  try {
    const refused = async (req: Buffer, line: string) => {
      const before = r.logs.length;
      const x = await via(r, req);
      assert.equal(x.reply[1], REPLY.notAllowed, line);
      assert.deepEqual(r.logs.slice(before), [`blanket: the address proxy refused ${line}`]);
    };
    await refused(byName("mixed.example"), "a connection to a name: it has a private address");
    await refused(byName("app.localhost"), "a connection to a name: it is a name of the box itself");
    await refused(byName("printer.local"), "a connection to a name: it is a name of the local network");
    await refused(byName("db.internal"), "a connection to a name: it is a name of a private network");
    await refused(byName("localhost."), "a connection to a name: it is a name of the box itself");
    await refused(byName("unknown.example"), "a connection to a name: it has no address in the box's resolver");
    await refused(byName("empty.example"), "a connection to a name: it has no address in the box's resolver");
    await refused(byV4("63.141.248.173"), "a connection to an IPv4 address: it is an address of this box");
    await refused(byV6("::ffff:63.141.248.173"), "a connection to an IPv6 address: it is an address of this box");
    await refused(byName("2604:4300:a:a8:be24:11ff:fe13:7F64"), "a connection to an IPv6 address: it is an address of this box");
    await refused(byName("self.example"), "a connection to a name: it has an address of this box");
    assert.equal((await via(r, byName("later.example"))).reply[1], REPLY.ok);
    // An address of the box can change: the next connection reads the interfaces again.
    r.own.push("198.51.100.7");
    r.now.t += 120_000;
    await refused(byName("later.example"), "a connection to a name: it has an address of this box");
    await refused(byV4("198.51.100.7"), "a connection to an IPv4 address: it is an address of this box");
    assert.deepEqual(r.dials, ["198.51.100.7 443"]);
  } finally { await r.close(); }
});

test("a name that resolves to a public address and later to a private one never reaches the private address: the proxy connects only to the address that it checked, and it looks up once per connection", async () => {
  const r = await rig({ names: { "rebind.example": (n) => (n === 1 ? ["93.184.216.34"] : ["127.0.0.1"]) } });
  try {
    assert.equal((await via(r, byName("rebind.example", 80))).reply[1], REPLY.ok);
    assert.deepEqual(r.dials, ["93.184.216.34 80"]);
    // Within the cache time the checked address serves again (no second lookup, so no new answer to trust).
    r.now.t += 59_000;
    assert.equal((await via(r, byName("rebind.example", 80))).reply[1], REPLY.ok);
    assert.equal(r.lookups.length, 1);
    // After it, the second lookup gives the private address: refused, and no connect to it.
    r.now.t += 2_000;
    const x = await via(r, byName("rebind.example", 80));
    assert.equal(x.reply[1], REPLY.notAllowed);
    assert.equal(r.lookups.length, 2);
    assert.deepEqual(r.dials, ["93.184.216.34 80", "93.184.216.34 80"], "never 127.0.0.1");
  } finally { await r.close(); }
  // The real connect: the checked IP literal, with no lookup at the connect (a stand-in admitted as public by the test hook).
  const upstream = createServer((s) => { s.on("error", () => {}); s.end("real"); });
  const up = await listen(upstream);
  const r2 = await rig({ real: true, names: { "stand-in.test": ["127.0.0.1"] }, extra: { admit: (h, a, p) => h === "stand-in.test" && a === "127.0.0.1" && p === up } });
  try {
    const x = await via(r2, byName("stand-in.test", up));
    assert.equal(x.reply[1], REPLY.ok);
    assert.equal(x.after, "real");
    assert.equal((await via(r2, byName("stand-in.test", up + 1 === 65536 ? 1 : up + 1))).reply[1], REPLY.notAllowed, "the hook admits its one port only");
    assert.equal((await via(r2, byV4("127.0.0.1", up))).reply[1], REPLY.notAllowed, "and its one name only");
  } finally { await r2.close(); await new Promise<void>((res) => upstream.close(() => res())); }
});

test("only SOCKS5 CONNECT with no authentication passes: another version, a method list without 00, BIND, UDP ASSOCIATE, an unknown address type, an empty or unprintable host and port 0 get their replies and close; the log names no host", async () => {
  const r = await rig({ names: { "example.com": ["93.184.216.34"] } });
  try {
    const cases: [Buffer, number[] | null, string][] = [
      [Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n\r\n"), null, "a malformed request: it is no SOCKS5 greeting"],
      [Buffer.from([4, 1, 0, 80, 127, 0, 0, 1, 0]), null, "a malformed request: it is no SOCKS5 greeting"],
      [Buffer.from([5, 2, 1, 2]), [5, 0xff], "a malformed request: its greeting offers no method without authentication"],
      [Buffer.from([5, 0]), [5, 0xff], "a malformed request: its greeting offers no method without authentication"],
      [Buffer.concat([GREET, Buffer.from([5, 2, 0, 3, 11]), Buffer.from("example.com"), Buffer.from([0, 80])]), [5, 0, 5, REPLY.command], "a malformed request: it asks for BIND"],
      [Buffer.concat([GREET, Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0])]), [5, 0, 5, REPLY.command], "a malformed request: it asks for UDP ASSOCIATE"],
      [Buffer.concat([GREET, Buffer.from([5, 9, 0, 1, 8, 8, 8, 8, 0, 80])]), [5, 0, 5, REPLY.command], "a malformed request: it asks for an unknown command"],
      [Buffer.concat([GREET, Buffer.from([4, 1, 0, 1, 8, 8, 8, 8, 0, 80])]), [5, 0, 5, REPLY.failure], "a malformed request: it is no SOCKS5 request"],
      [Buffer.concat([GREET, Buffer.from([5, 1, 0, 2, 8, 8, 8, 8, 0, 80])]), [5, 0, 5, REPLY.addressType], "a malformed request: its address type is unknown"],
      [Buffer.concat([GREET, Buffer.from([5, 1, 0, 3, 0, 0, 80])]), [5, 0, 5, REPLY.failure], "a malformed request: its host is empty or not printable ASCII"],
      [Buffer.concat([GREET, Buffer.from([5, 1, 0, 3, 5]), Buffer.from("a b.c"), Buffer.from([0, 80])]), [5, 0, 5, REPLY.failure], "a malformed request: its host is empty or not printable ASCII"],
      [Buffer.concat([GREET, Buffer.from([5, 1, 0, 3, 4, 0x61, 0x00, 0x62, 0x63, 0, 80])]), [5, 0, 5, REPLY.failure], "a malformed request: its host is empty or not printable ASCII"],
      [Buffer.concat([GREET, byName("example.com", 0)]), [5, 0, 5, REPLY.failure], "a malformed request: it names port 0"],
    ];
    for (const [bytes, answer, line] of cases) {
      const before = r.logs.length;
      const t = await talk(r, bytes);
      assert.ok(t.closed, line);
      assert.deepEqual([...t.got.subarray(0, answer ? answer.length : 0)], answer ?? [], line);
      if (answer === null) assert.equal(t.got.length, 0, `${line}: no byte`);
      assert.deepEqual(r.logs.slice(before), [`blanket: the address proxy refused ${line}`]);
    }
    assert.deepEqual(r.dials, []);
    assert.ok(!r.logs.some((l) => l.includes("example.com")));
    // The parsers on their own: a partial greeting or request asks for more bytes.
    assert.equal(parseGreeting(Buffer.from([5, 2, 0])), null);
    assert.equal(parseRequest(Buffer.from([5, 1, 0, 3, 11, 0x65])), null);
    assert.deepEqual(parseRequest(byName("example.com", 443)), { host: "example.com", port: 443, used: 18 });
    assert.deepEqual(parseRequest(byV6("::1", 80)), { host: "0:0:0:0:0:0:0:1", port: 80, used: 22 });
  } finally { await r.close(); }
});

test("only a client of the service's uid passes: another uid's client, or one that /proc/net/tcp does not show, closes with no byte", async () => {
  const r = await rig({ names: { "example.com": ["93.184.216.34"] } });
  try {
    for (const uid of [UID + 1, null]) {
      r.tcpUid.v = uid;
      const before = r.logs.length;
      const t = await talk(r, Buffer.concat([GREET, byName("example.com")]));
      assert.ok(t.closed);
      assert.equal(t.got.length, 0, "not even the greeting's answer");
      assert.deepEqual(r.logs.slice(before), [`blanket: the address proxy refused ${PEER_TEXT.linux}`]);
    }
    assert.deepEqual(r.dials, []);
    r.tcpUid.v = UID;
    assert.equal((await via(r, byName("example.com"))).reply[1], REPLY.ok);
  } finally { await r.close(); }
});

// ------------------------------------------------------------------ the peer check's wait (board ab-4wh.22)

/** A counting wrap of the rig's read: `pick(n, own)` gives the n-th read (1 is the first). */
function reads(pick: (n: number, own: () => TcpLine[] | null) => readonly TcpLine[] | null) {
  const c = { n: 0, wrap: (own: () => TcpLine[] | null) => () => pick(++c.n, own) };
  return c;
}
/** The rig's line of a client with another uid and inode (Linux's form of a socket that its process has closed: uid 0, inode 0). */
const as = (own: () => TcpLine[] | null, uid: number, inode: number) => own()?.map((l) => ({ ...l, uid, inode })) ?? null;

test("the peer check's wait: a client that the first read does not show and the second read shows is admitted, at its first bytes or after the wait; the bytes of the wait go to the handshake", async () => {
  assert.equal(PEER_WAIT_MS, 250);
  const c = reads((n, own) => (n === 1 ? [] : own()));
  const r = await rig({ names: { "example.com": ["93.184.216.34"] }, tcp: c.wrap, extra: { limits: { peerMs: 5_000 } } });
  try {
    // The greeting and the request in one write: the second read at the first bytes admits it at once.
    const t0 = Date.now();
    const a = await via(r, byName("example.com"));
    assert.equal(a.reply[1], REPLY.ok, "admitted");
    assert.equal(a.after, "hello");
    assert.ok(Date.now() - t0 < 2_000, "at the first bytes, not at the end of the wait");
    assert.equal(c.n, 2, "two reads");
    assert.ok(!r.logs.some((l) => l.includes("a client")), r.logs.join(" | "));
  } finally { await r.close(); }
  // A client that sends nothing during the wait: the second read at its end admits it, and then its handshake runs. The
  // first read fails, as the Mac's read of the blanket Chrome's tree fails while the service does not hold that Chrome's
  // main process yet (on Linux a failed read refuses at once: board ab-4wh.23, below).
  const c2 = reads((n, own) => (n === 1 ? null : own()));
  const r2 = await rig({ names: { "example.com": ["93.184.216.34"] }, tcp: c2.wrap, extra: { system: "mac", limits: { peerMs: 80 } } });
  const sock = new Socket();
  try {
    r2.clients.add(sock);
    let got = Buffer.alloc(0);
    sock.on("data", (d: Buffer) => { got = Buffer.concat([got, d]); });
    sock.on("error", () => {});
    await new Promise<void>((res) => sock.connect(r2.port, "127.0.0.1", () => res()));
    await sleep(250);
    assert.equal(c2.n, 2, "the second read at the end of the wait");
    assert.equal(got.length, 0, "no byte before the client speaks");
    sock.write(Buffer.concat([GREET, byName("example.com")]));
    const until = Date.now() + 1_500;
    while (got.length < 12 && Date.now() < until) await sleep(5);
    assert.deepEqual([...got.subarray(0, 4)], [5, 0, 5, REPLY.ok], got.toString("hex"));
    assert.ok(!r2.logs.some((l) => l.includes("a client")), r2.logs.join(" | "));
  } finally { sock.destroy(); await r2.close(); }
});

test("the peer check's wait: a client that connects and closes at once is refused as closed, never as a stranger: no line (the Mac: its fd is gone), Linux's line with no holder (uid 0, inode 0), its end or its reset", async () => {
  for (const [what, pick, how] of [
    ["no line, the client's end", () => [] as TcpLine[], "end"],
    ["no line, the client's reset", () => [] as TcpLine[], "reset"],
    ["Linux's line of a closed socket (uid 0, inode 0)", (_n: number, own: () => TcpLine[] | null) => as(own, 0, 0), "end"],
  ] as const) {
    const c = reads(pick);
    const r = await rig({ names: { "example.com": ["93.184.216.34"] }, tcp: c.wrap, extra: { limits: { peerMs: 5_000 } } });
    const sock = new Socket();
    try {
      r.clients.add(sock);
      let got = 0;
      sock.on("data", (d: Buffer) => { got += d.length; });
      sock.on("error", () => {});
      await new Promise<void>((res) => sock.connect(r.port, "127.0.0.1", () => { if (how === "end") sock.end(); else sock.resetAndDestroy(); res(); }));
      const until = Date.now() + 2_000;
      while (!r.logs.some((l) => l.includes("a client")) && Date.now() < until) await sleep(5);
      assert.deepEqual(r.logs.filter((l) => l.includes("a client")), [`blanket: the address proxy refused ${PEER_TEXT.closed}`], what);
      assert.equal(got, 0, `${what}: no byte`);
      assert.equal(r.proxy.counts().refused, 1);
      assert.ok(c.n <= 2, `${what}: at most two reads`);
    } finally { sock.destroy(); await r.close(); }
  }
});

test("the peer check's wait on Linux's real /proc/net/tcp: a client that closed in the accept queue (its line: uid 0, inode 0) or reset there is refused as closed", { skip: process.platform !== "linux" }, async () => {
  for (const how of ["end", "resetAndDestroy"]) {
    const logs: string[] = [];
    const proxy = new AddressProxy({ log: (l) => logs.push(l), system: "linux", tcp: procReader().tcp, resolve: async () => { throw new Error("no lookup"); } });
    const port = await proxy.start();
    try {
      // The client is another process; this loop waits for it, so the client connects and closes before the accept runs.
      execFileSync(process.execPath, ["-e", `const s = require("node:net").connect(${port}, "127.0.0.1", () => { s.${how}(); setTimeout(() => process.exit(0), 50); }); s.on("error", () => {});`]);
      const until = Date.now() + 2_000;
      while (!logs.some((l) => l.includes("a client")) && Date.now() < until) await sleep(5);
      assert.deepEqual(logs.filter((l) => l.includes("a client")), [`blanket: the address proxy refused ${PEER_TEXT.closed}`], how);
    } finally { await proxy.stop(); }
  }
});

test("the peer check's wait: no line at both reads is the stranger's line at the end of the wait, with no reply byte and no third read", async () => {
  const c = reads(() => []);
  const r = await rig({ names: { "example.com": ["93.184.216.34"] }, tcp: c.wrap, extra: { limits: { peerMs: 300 } } });
  try {
    for (const bytes of [Buffer.concat([GREET, byName("example.com")]), null]) {
      const n0 = c.n, before = r.logs.length, t0 = Date.now();
      const t = await talk(r, bytes, { ms: 3_000 });
      const ms = Date.now() - t0;
      assert.ok(t.closed, "closed");
      assert.equal(t.got.length, 0, "no reply byte");
      assert.ok(ms >= 280, `at the end of the wait (${ms} ms)`);
      assert.equal(c.n - n0, 2, "two reads, no third");
      assert.deepEqual(r.logs.slice(before), [`blanket: the address proxy refused ${PEER_TEXT.linux}`]);
    }
    // Board ab-4wh.23: three chunks during the wait (the greeting, then the request in two parts): the second read at the
    // first chunk, and no read at the later ones.
    const n0 = c.n, before = r.logs.length, t0 = Date.now();
    const request = byName("example.com");
    const cl = await opened(r, GREET);
    await sleep(60);
    cl.sock.write(request.subarray(0, 5));
    await sleep(60);
    cl.sock.write(request.subarray(5));
    await waitFor(() => cl.closed(), 3_000);
    const ms = Date.now() - t0;
    assert.ok(cl.closed(), "closed");
    assert.equal(cl.got().length, 0, "no reply byte");
    assert.ok(ms >= 280, `at the end of the wait (${ms} ms)`);
    assert.equal(c.n - n0, 2, "two reads for three chunks, no third");
    assert.deepEqual(r.logs.slice(before), [`blanket: the address proxy refused ${PEER_TEXT.linux}`]);
    assert.deepEqual(r.dials, []);
    assert.deepEqual(r.lookups, []);
  } finally { await r.close(); }
});

test("the peer check's wait: a line of another uid is refused at once, at the first read and at the second read", async () => {
  const at1 = reads((_n, own) => as(own, UID + 1, 1));
  const at2 = reads((n, own) => (n === 1 ? [] : as(own, UID + 1, 1)));
  for (const [what, c] of [["the first read", at1], ["the second read (at the first bytes)", at2]] as const) {
    const r = await rig({ names: { "example.com": ["93.184.216.34"] }, tcp: c.wrap, extra: { limits: { peerMs: 5_000 } } });
    try {
      const t0 = Date.now();
      const t = await talk(r, Buffer.concat([GREET, byName("example.com")]), { ms: 3_000 });
      assert.ok(t.closed && t.got.length === 0, what);
      assert.ok(Date.now() - t0 < 2_000, `${what}: at once, not at the end of the wait`);
      assert.equal(c.n, c === at1 ? 1 : 2, what);
      assert.deepEqual(r.logs.filter((l) => l.includes("a client")), [`blanket: the address proxy refused ${PEER_TEXT.linux}`], what);
    } finally { await r.close(); }
  }
});

test("the peer check's wait ends with the stop: a waiting client is closed with no line, and the stop's count holds no refusal of it", async () => {
  const r = await rig({ tcp: () => () => [], extra: { limits: { peerMs: 5_000 } } });
  const sock = new Socket();
  try {
    sock.on("error", () => {});
    let closed = false;
    sock.on("close", () => { closed = true; });
    await new Promise<void>((res) => sock.connect(r.port, "127.0.0.1", () => res()));
    await sleep(50);
    await r.proxy.stop();
    const until = Date.now() + 1_000;
    while (!closed && Date.now() < until) await sleep(5);
    await sleep(20);
    assert.ok(closed, "the stop closed the waiting client");
    assert.equal(r.proxy.counts().peer, 0, "the stop empties the wait");
    assert.ok(!r.logs.some((l) => l.includes("a client")), r.logs.join(" | "));
    assert.ok(r.logs.includes("blanket: the address proxy stopped (0 connection(s) passed, 0 refused)"), r.logs.join(" | "));
  } finally { sock.destroy(); await r.close(); }
});

test("the peer check's wait (board ab-4wh.23): at most PEER_WAITING clients wait at a time; one more that the first read does not show is refused at once as a stranger, with no byte; a place comes free at a decision", async () => {
  assert.equal(PEER_WAITING, 64);
  const r = await rig({ names: { "example.com": ["93.184.216.34"] }, tcp: () => () => [], extra: { limits: { peerMs: 5_000, peerWaiting: 3 } } });
  try {
    const held = await Promise.all([1, 2, 3].map(() => opened(r, Buffer.alloc(0))));
    assert.ok(await waitFor(() => r.proxy.counts().peer === 3), `three wait: ${r.proxy.counts().peer}`);
    const t0 = Date.now();
    const t = await talk(r, Buffer.concat([GREET, byName("example.com")]), { ms: 3_000 });
    assert.ok(t.closed && t.got.length === 0, "the fourth: closed with no byte");
    assert.ok(Date.now() - t0 < 1_500, "at once, not at the end of the wait");
    assert.deepEqual(r.logs.filter((l) => l.includes("a client")), [`blanket: the address proxy refused ${PEER_TEXT.linux}`]);
    assert.equal(r.proxy.counts().peer, 3, "the three still wait");
    // One waiting client goes (the closed line): its place comes free, and a new client waits again.
    held[0].sock.destroy();
    assert.ok(await waitFor(() => r.proxy.counts().peer === 2), "the closed client left the wait");
    const next = await opened(r, Buffer.alloc(0));
    assert.ok(await waitFor(() => r.proxy.counts().peer === 3), "the new client waits");
    assert.ok(!next.closed());
    assert.deepEqual(r.logs.filter((l) => l.includes("a client")), [`blanket: the address proxy refused ${PEER_TEXT.linux}`, `blanket: the address proxy refused ${PEER_TEXT.closed}`]);
    for (const h of [...held, next]) h.sock.destroy();
    assert.ok(await waitFor(() => r.proxy.counts().peer === 0), "no client waits after their ends");
  } finally { await r.close(); }
});

test("the peer check on Linux (board ab-4wh.23): a /proc/net/tcp that cannot be read, or a read that throws, refuses at once as a stranger, with no wait and no byte (on the Mac a failed read waits: above)", async () => {
  const fails: [string, () => () => readonly TcpLine[] | null][] = [["no table", () => () => null], ["a throw", () => () => { throw new Error("EACCES"); }]];
  for (const [what, tcp] of fails) {
    for (const bytes of [Buffer.concat([GREET, byName("example.com")]), null]) {
      const r = await rig({ names: { "example.com": ["93.184.216.34"] }, tcp, extra: { limits: { peerMs: 5_000 } } });
      try {
        const t0 = Date.now();
        const t = await talk(r, bytes, { ms: 3_000 });
        assert.ok(t.closed && t.got.length === 0, `${what}: closed with no byte`);
        assert.ok(Date.now() - t0 < 1_500, `${what}: at once, not at the end of the wait`);
        assert.equal(r.proxy.counts().peer, 0, `${what}: it never waited`);
        assert.deepEqual(r.logs.filter((l) => l.includes("a client")), [`blanket: the address proxy refused ${PEER_TEXT.linux}`], what);
        assert.deepEqual(r.dials, []);
      } finally { await r.close(); }
    }
  }
});

test("the handshake's limit counts from the accept, the peer check's wait included (board ab-4wh.23): a client admitted at the end of the wait has only the rest of the limit", async () => {
  const c = reads((n, own) => (n === 1 ? [] : own()));
  const r = await rig({ tcp: c.wrap, extra: { limits: { peerMs: 1_000, handshakeMs: 1_300 } } });
  try {
    const t0 = Date.now();
    const t = await talk(r, null, { ms: 4_000 });
    const ms = Date.now() - t0;
    assert.equal(c.n, 2, "admitted at the second read, at the end of the wait");
    assert.ok(t.closed && t.got.length === 0, "closed with no byte");
    assert.ok(ms >= 1_250 && ms < 2_000, `closed at the limit from the accept (${ms} ms), not 1.3 s after the admission`);
    assert.deepEqual(r.logs.filter((l) => l.includes("refused")), ["blanket: the address proxy refused a malformed request: it did not come in 1.3 s"]);
  } finally { await r.close(); }
});

test("the limits: the connections (one more closes at once), the handshake's time, the lookups at a time and a lookup's time, and the connect's time", async () => {
  assert.deepEqual([MAX_CONNECTIONS, HANDSHAKE_MS, LOOKUPS_AT_ONCE, LOOKUP_MS, CONNECT_MS, LOG_LINES], [256, 10_000, 2, 10_000, 15_000, 20], "the values that C11 names");
  let gate: () => void = () => {};
  const gated = new Promise<void>((res) => { gate = res; });
  // The handshake's time: a client that says nothing, or only a part of its greeting.
  const r1 = await rig({ extra: { limits: { handshakeMs: 80 } } });
  try {
    for (const bytes of [null, Buffer.from([5, 1])]) {
      const t = await talk(r1, bytes, { ms: 1_000 });
      assert.ok(t.closed && t.got.length === 0);
    }
    assert.equal(r1.logs.filter((l) => l === "blanket: the address proxy refused a malformed request: it did not come in 0.08 s").length, 2);
  } finally { await r1.close(); }
  // The connections: three clients that wait; a fourth closes at once; after one goes, a new one passes.
  const r3 = await rig({ names: { "example.com": ["93.184.216.34"] }, extra: { limits: { connections: 3 } } });
  try {
    const held = await Promise.all([1, 2, 3].map(() => talk(r3, GREET, { keep: true, ms: 500, until: (g) => g.length >= 2 })));
    const t = await talk(r3, Buffer.concat([GREET, byName("example.com")]), { ms: 500 });
    assert.ok(t.closed && t.got.length === 0, "past the cap: closed with no byte");
    assert.ok(r3.logs.includes("blanket: the address proxy refused a connection: it already holds 3 connections"));
    held[0].sock.destroy();
    await sleep(50);
    assert.equal((await via(r3, byName("example.com"))).reply[1], REPLY.ok);
    for (const h of held) h.sock.destroy();
  } finally { await r3.close(); }
  const r = await rig({
    names: { "slow.example": () => new Promise(() => {}), "g1.example": async () => { await gated; return ["93.184.216.34"]; }, "g2.example": async () => { await gated; return ["93.184.216.35"]; }, "g3.example": async () => { await gated; return ["93.184.216.36"]; } },
    extra: { limits: { lookupMs: 500 } },
  });
  try {
    // Two lookups at a time: the third name waits for a free one.
    const flying = [talk(r, Buffer.concat([GREET, byName("g1.example")]), { keep: true, ms: 2_000, until: (g) => g.length >= 12 }),
      talk(r, Buffer.concat([GREET, byName("g2.example")]), { keep: true, ms: 2_000, until: (g) => g.length >= 12 })];
    await sleep(50);
    const third = talk(r, Buffer.concat([GREET, byName("g3.example")]), { keep: true, ms: 2_000, until: (g) => g.length >= 12 });
    await sleep(50);
    assert.deepEqual(r.lookups.filter((h) => h.startsWith("g")), ["g1.example", "g2.example"], "the third lookup waits");
    gate();
    for (const x of await Promise.all([...flying, third])) { assert.equal(x.got[3], REPLY.ok, x.got.toString("hex")); x.sock.destroy(); }
    assert.deepEqual(r.lookups.filter((h) => h.startsWith("g")).sort(), ["g1.example", "g2.example", "g3.example"]);
    // A lookup's time: refused at the limit.
    const s = await via(r, byName("slow.example"), { ms: 2_000 });
    assert.equal(s.reply[1], REPLY.notAllowed);
    assert.ok(r.logs.includes("blanket: the address proxy refused a connection to a name: its lookup did not answer in 0.5 s"));
  } finally { await r.close(); }
  // The connect's time: an address that never answers gets reply 04 at the limit.
  const r2 = await rig({ names: {}, extra: { limits: { connectMs: 100 }, connect: () => new Socket() } });
  try {
    const started = Date.now();
    const x = await via(r2, byV4("203.0.113.9"), { ms: 2_000 });
    assert.equal(x.reply[1], REPLY.unreachable);
    assert.ok(Date.now() - started < 1_500);
  } finally { await r2.close(); }
});

test("the lookup queue (the review's I1): at most 64 lookups wait and one more is refused at once; a waiting lookup whose connection gave up starts no getaddrinfo; a stop drops the queue", async () => {
  assert.equal(WAITING_LOOKUPS, 64);
  const started: string[] = [];
  const r = await rig({ extra: { resolve: (h) => { started.push(h); return new Promise<string[]>(() => {}); }, limits: { connections: 1_000, lookupMs: 300 } } });
  try {
    // The reviewer's probe, with 300 names whose resolver never answers.
    const all = await Promise.all(Array.from({ length: 300 }, (_, i) => via(r, byName(`n${i}.example`), { ms: 3_000 })));
    assert.ok(all.every((x) => x.reply[1] === REPLY.notAllowed && x.closed), "every connection is refused");
    const lines = r.logs.filter((l) => l.startsWith("blanket: the address proxy refused"));
    assert.ok(lines.includes("blanket: the address proxy refused a connection to a name: 64 lookups already wait"), lines.slice(0, 3).join(" | "));
    assert.equal(r.proxy.counts().refused, 300);
    assert.deepEqual(started.sort(), ["n0.example", "n1.example"].sort(), "only the two lookups that had a slot reached the resolver; no waiter started after its connection gave up");
    assert.deepEqual(pick(r.proxy.counts()), { waiting: 0, flying: 2, lookups: 2 }, "the queue is empty; the two lookups in getaddrinfo hold their slots");
    await r.proxy.stop();
    assert.deepEqual(pick(r.proxy.counts()), { waiting: 0, flying: 0, lookups: 2 }, "the stop drops the old run's lookups (the two in getaddrinfo still hold their threads)");
    assert.ok(r.logs.includes("blanket: the address proxy refused 280 more connection(s) (at most 20 log lines in 10 s)"), "the log's cap: 20 lines, then the count");
  } finally { await r.close(); }
  // A lookup in getaddrinfo at a stop: its answer reaches no new run (no cache), and it frees its slot.
  let release: (v: string[]) => void = () => {};
  let calls = 0;
  const r2 = await rig({ extra: { resolve: () => { calls++; return calls === 1 ? new Promise<string[]>((res) => { release = res; }) : Promise.resolve(["93.184.216.34"]); }, limits: { lookupMs: 5_000 } } });
  try {
    const first = via(r2, byName("late.example"), { ms: 2_000 });
    await sleep(50);
    await r2.proxy.stop();
    await r2.proxy.start();
    (r2 as { port: number }).port = r2.proxy.port()!;
    assert.equal(r2.proxy.counts().lookups, 1);
    release(["10.0.0.1"]);
    await first;
    await sleep(20);
    assert.deepEqual(pick(r2.proxy.counts()), { waiting: 0, flying: 0, lookups: 0 }, "the old lookup freed its slot");
    assert.equal((await via(r2, byName("late.example"))).reply[1], REPLY.ok, "the new run looks up again: the old answer is not in its cache");
    assert.equal(calls, 2);
  } finally { await r2.close(); }
});

test("the lookup queue (board ab-4wh.14): a waiting lookup whose clients all went (an end, a reset) leaves the queue at once, so no getaddrinfo starts for it when a slot comes free; a shared lookup stays while one of its clients waits", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => { release = res; });
  const started: string[] = [];
  const addresses: Record<string, string> = { "first.example": "93.184.216.34", "shared.example": "93.184.216.35", "ended.example": "93.184.216.36", "reset.example": "93.184.216.37" };
  const r = await rig({ extra: { resolve: async (h) => { started.push(h); if (h === "first.example") await gate; return [addresses[h]]; }, limits: { lookupsAtOnce: 1, lookupMs: 5_000 } } });
  try {
    // first.example holds the one slot; the others wait for it (each client has its greeting's answer, so the proxy has
    // its request).
    const first = await opened(r, Buffer.concat([GREET, byName("first.example")]));
    assert.ok(await waitFor(() => started.length === 1 && first.got().length >= 2));
    const waiters = await Promise.all(["ended.example", "reset.example", "shared.example", "shared.example"].map((h) => opened(r, Buffer.concat([GREET, byName(h)]))));
    assert.ok(await waitFor(() => waiters.every((w) => w.got().length >= 2)), "each waiter's greeting is answered");
    assert.deepEqual(pick(r.proxy.counts()), { waiting: 3, flying: 4, lookups: 1 }, "three lookups wait (shared.example once)");
    // ended.example's client ends (its FIN), reset.example's resets, and one client of shared.example ends.
    const [ended, reset, sharedA, sharedB] = waiters;
    ended.sock.end();
    reset.sock.resetAndDestroy();
    sharedA.sock.end();
    assert.ok(await waitFor(() => r.proxy.counts().waiting === 1), `the gone clients' lookups left the queue at once: ${JSON.stringify(pick(r.proxy.counts()))}`);
    assert.deepEqual(pick(r.proxy.counts()), { waiting: 1, flying: 2, lookups: 1 }, "shared.example still waits for its other client");
    // The slot comes free: shared.example starts and passes; no getaddrinfo starts for ended.example or reset.example.
    release();
    assert.ok(await waitFor(() => first.got().length >= 12 && sharedB.got().length >= 12), "the two clients that stay get their replies");
    assert.equal(first.got()[3], REPLY.ok);
    assert.equal(sharedB.got()[3], REPLY.ok);
    await sleep(50);
    assert.deepEqual(started, ["first.example", "shared.example"], "no lookup for a closed connection");
    assert.deepEqual(r.dials.sort(), ["93.184.216.34 443", "93.184.216.35 443"], "no connect for a closed connection");
    assert.deepEqual(pick(r.proxy.counts()), { waiting: 0, flying: 0, lookups: 0 });
    assert.ok(!r.logs.some((l) => l.includes("refused")), r.logs.join(" | "));
    for (const c of [first, ...waiters]) c.sock.destroy();
  } finally { await r.close(); }
});

test("the lookup queue (board ab-4wh.14): with a resolver that answers late, the waiters give up at the lookup's limit, and when the late answers free the slots no getaddrinfo starts for them", async () => {
  const started: string[] = [];
  const r = await rig({ extra: { resolve: async (h) => { started.push(h); if (h.startsWith("late")) await sleep(700); return ["93.184.216.34"]; }, limits: { lookupMs: 300 } } });
  try {
    // late0 and late1 take the two slots; late2 to late5 wait behind them.
    const slots = [0, 1].map((i) => via(r, byName(`late${i}.example`), { ms: 3_000 }));
    assert.ok(await waitFor(() => started.length === 2));
    const queued = [2, 3, 4, 5].map((i) => via(r, byName(`late${i}.example`), { ms: 3_000 }));
    const all = await Promise.all([...slots, ...queued]);
    assert.ok(all.every((x) => x.reply[1] === REPLY.notAllowed && x.closed), "each one is refused at the lookup's limit");
    assert.equal(r.logs.filter((l) => l === "blanket: the address proxy refused a connection to a name: its lookup did not answer in 0.3 s").length, 6);
    assert.deepEqual(pick(r.proxy.counts()), { waiting: 0, flying: 2, lookups: 2 }, "the waiters left the queue; the two late lookups hold their slots");
    // The late answers come (at 700 ms) and free the slots: the queue is empty, so no lookup starts.
    assert.ok(await waitFor(() => r.proxy.counts().lookups === 0, 2_000), "the late answers came");
    await sleep(100);
    assert.deepEqual(started, ["late0.example", "late1.example"], "no getaddrinfo for a waiter that gave up, after the slots came free");
    assert.deepEqual(pick(r.proxy.counts()), { waiting: 0, flying: 0, lookups: 0 });
    // The slots are free: a new name gets its lookup at once and passes.
    assert.equal((await via(r, byName("fresh.example"))).reply[1], REPLY.ok);
    assert.deepEqual(started, ["late0.example", "late1.example", "fresh.example"]);
  } finally { await r.close(); }
});

test("a half-closed tunnel (the review's I2): when one side ends and the other does not end within the limit, the proxy closes both; an open tunnel with no traffic stays", async () => {
  assert.equal(HALF_CLOSE_MS, 30_000);
  // An upstream that ignores the client's FIN: it never ends its side.
  const deafSockets = new Set<Socket>();
  const deaf = createServer({ allowHalfOpen: true }, (s) => { deafSockets.add(s); s.on("error", () => {}); s.write("hello"); });
  const deafPort = await listen(deaf);
  const r = await rig({ names: { "deaf.example": ["93.184.216.34"] }, extra: { limits: { halfCloseMs: 150 }, connect: () => connect({ host: "127.0.0.1", port: deafPort, allowHalfOpen: true }) } });
  try {
    const quiet = await via(r, byName("deaf.example"), { keep: true });
    const half = await via(r, byName("deaf.example"), { keep: true });
    assert.equal(quiet.reply[1], REPLY.ok);
    assert.equal(half.reply[1], REPLY.ok);
    half.sock.end();
    await sleep(600);
    assert.ok(half.sock.destroyed, "the half-closed pair is closed after the limit");
    assert.ok(!quiet.sock.destroyed, "the open pair with no traffic stays (no idle limit)");
    assert.equal(r.proxy.counts().open, 1, "the half-closed pair gave back its slot");
    quiet.sock.destroy();
  } finally { await r.close(); for (const x of deafSockets) x.destroy(); await new Promise<void>((res) => deaf.close(() => res())); }
});

test("the lifecycle: nothing listens before the start or after the stop; the stop closes each tunnel; a new start has a new port", async () => {
  const r = await rig({ names: { "example.com": ["93.184.216.34"] } });
  const a = await via(r, byName("example.com"), { keep: true });
  assert.equal(a.reply[1], REPLY.ok);
  const port = r.port;
  assert.equal(r.proxy.port(), port);
  assert.ok(r.proxy.listening());
  await r.proxy.stop();
  assert.equal(r.proxy.port(), null);
  assert.ok(!r.proxy.listening());
  const until = Date.now() + 1_000;
  while (!a.sock.destroyed && Date.now() < until) await sleep(5);
  assert.ok(a.sock.destroyed || a.sock.readableEnded, "the stop closed the tunnel");
  const refused = await new Promise<string>((res) => { const s = connect(port, "127.0.0.1"); s.on("connect", () => { s.destroy(); res("connected"); }); s.on("error", (e: NodeJS.ErrnoException) => res(e.code ?? "error")); });
  assert.equal(refused, "ECONNREFUSED", "nothing listens on the port after the stop");
  assert.ok(r.logs.some((l) => /^blanket: the address proxy stopped \(1 connection\(s\) passed, 0 refused\)$/.test(l)), r.logs.join(" | "));
  const again = await r.proxy.start();
  assert.ok(r.proxy.listening());
  assert.ok(r.logs.includes(`blanket: the address proxy listens on 127.0.0.1:${again}`));
  await r.close();
  assert.ok(!r.proxy.listening());
  // A proxy that never started: stop does nothing, and no port.
  const idle = new AddressProxy({ log: () => {} });
  assert.equal(idle.port(), null);
  await idle.stop();
});

test("the log: one line per refusal, at most 20 lines in 10 s, then one line with the count of the others", async () => {
  const r = await rig({ names: {} });
  try {
    for (let i = 0; i < 25; i++) await via(r, byV4("10.0.0.1"));
    const lines = () => r.logs.filter((l) => l.startsWith("blanket: the address proxy refused"));
    assert.equal(lines().length, 20);
    r.now.t += 10_001;
    await via(r, byV4("10.0.0.1"));
    assert.deepEqual(lines().slice(20), ["blanket: the address proxy refused 5 more connection(s) (at most 20 log lines in 10 s)", "blanket: the address proxy refused a connection to an IPv4 address: it is a private address"]);
    assert.equal(r.proxy.counts().refused, 26);
  } finally { await r.close(); }
});

test("the blanket Chrome's flags, and the switches of chrome_args that it refuses, read as assertSafeChromeArgs reads a switch", () => {
  assert.deepEqual(proxyFlags(41234), ["--proxy-server=socks5://127.0.0.1:41234", "--proxy-bypass-list=<-loopback>", "--webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-quic"]);
  assert.deepEqual(PROXY_SWITCHES, ["no-proxy-server", "proxy-server", "proxy-pac-url", "proxy-auto-detect", "proxy-bypass-list", "webrtc-ip-handling-policy", "load-extension", "disable-extensions-except"]);
  for (const a of ["--no-proxy-server", "-no-proxy-server", "/no-proxy-server", "--PROXY-SERVER=x", "-Proxy-Server=socks5://h:1", "  --proxy-pac-url=http://x/p  ", "---proxy-auto-detect", "--proxy-bypass-list", "--WebRTC-IP-Handling-Policy=default",
    "--load-extension=/tmp/x", "-Load-Extension=/a,/b", "/disable-extensions-except=/tmp/x"]) {
    assert.match(proxySwitchRefusal(["--lang=de", a]) ?? "", /^the config's chrome_args hold --[a-z-]+, which would take the blanket Chrome past its address proxy$/, a);
  }
  assert.equal(proxySwitchRefusal(["-Proxy-Server=x"]), "the config's chrome_args hold --proxy-server, which would take the blanket Chrome past its address proxy", "the name, never the value");
  for (const a of ["--force-dark-mode", "--proxy-serverx=1", "proxy-server", "--lang=--proxy-server", "--disable-quic", "--host-resolver-rules=MAP * 1.2.3.4"]) assert.equal(proxySwitchRefusal([a]), null, a);
});
