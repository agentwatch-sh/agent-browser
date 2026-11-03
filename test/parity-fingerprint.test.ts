// The parity probe's server-side fingerprints (test/live/parity/fingerprint.ts): JA4 against the
// worked example of the FoxIO JA4 specification, and the parsers against real bytes from Node's own
// TLS and HTTP/2 clients. The probe itself (a real Chrome) is not part of `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { connect as tlsConnect } from "node:tls";
import { connect as http2Connect } from "node:http2";
import { createServer } from "node:net";
import { akamaiH2, isGrease, ja4, ja4CipherHash, ja4ExtensionHash, parseClientHello, parseH2Start } from "./live/parity/fingerprint.ts";

const u16 = (v: number) => Buffer.from([v >> 8, v & 0xff]);
const u24 = (v: number) => Buffer.from([v >> 16, (v >> 8) & 0xff, v & 0xff]);
const vec16 = (b: Buffer) => Buffer.concat([u16(b.length), b]);
const vec8 = (b: Buffer) => Buffer.concat([Buffer.from([b.length]), b]);
const list16 = (l: number[]) => Buffer.concat(l.map(u16));

// The JA4 specification's example (technical_details/JA4.md): its cipher, extension and signature
// algorithm lists in their original order, plus GREASE where Chrome puts it.
const SPEC_CIPHERS = [0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8, 0xc013, 0xc014, 0x009c, 0x009d, 0x002f, 0x0035];
const SPEC_EXTS = [0x001b, 0x0000, 0x0033, 0x0010, 0x4469, 0x0017, 0x002d, 0x000d, 0x0005, 0x0023, 0x0012, 0x002b, 0xff01, 0x000b, 0x000a, 0x0015];
const SPEC_SIGALGS = [0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601];

function clientHello(o: { sni?: boolean; alpn?: Buffer[] | null } = {}): Buffer {
  const alpn = o.alpn === undefined ? [Buffer.from("h2"), Buffer.from("http/1.1")] : o.alpn;
  const extData = (t: number): Buffer => {
    switch (t) {
      case 0x0000: { const name = Buffer.from("probe.localhost"); return vec16(Buffer.concat([Buffer.from([0]), vec16(name)])); }
      case 0x0010: return vec16(Buffer.concat((alpn ?? []).map(vec8)));
      case 0x000d: return vec16(list16(SPEC_SIGALGS));
      case 0x002b: return vec8(list16([0x7a7a, 0x0304, 0x0303]));
      case 0x000a: return vec16(list16([0x2a2a, 0x001d, 0x0017]));
      case 0x000b: return vec8(Buffer.from([0]));
      case 0x0033: return vec16(Buffer.concat([u16(0x2a2a), vec16(Buffer.from([0])), u16(0x001d), vec16(Buffer.alloc(32, 7))]));
      default: return Buffer.alloc(0);
    }
  };
  const types = SPEC_EXTS.filter((t) => !(t === 0x0000 && o.sni === false) && !(t === 0x0010 && alpn === null));
  const exts = [0x0a0a, ...types, 0xfafa].map((t) => Buffer.concat([u16(t), vec16(extData(t))]));
  const body = Buffer.concat([
    u16(0x0303), Buffer.alloc(32, 1), vec8(Buffer.alloc(32, 2)),
    vec16(list16([0x3a3a, ...SPEC_CIPHERS])), vec8(Buffer.from([0])), vec16(Buffer.concat(exts)),
  ]);
  const hs = Buffer.concat([Buffer.from([0x01]), u24(body.length), body]);
  // Two records, as a large ClientHello can be: the parser must join them.
  const cut = 100;
  const rec = (b: Buffer) => Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(b.length), b]);
  return Buffer.concat([rec(hs.subarray(0, cut)), rec(hs.subarray(cut))]);
}

test("JA4 of the specification's example is t13d1516h2_8daaf6152771_e5627efa2ab1", () => {
  const ch = parseClientHello(clientHello())!;
  assert.equal(ch.sni, "probe.localhost");
  assert.deepEqual(ch.alpn, ["h2", "http/1.1"]);
  assert.deepEqual(ch.sigAlgs, SPEC_SIGALGS);
  assert.deepEqual(ch.keyShares, [0x2a2a, 0x001d]);
  assert.equal(ja4(ch), "t13d1516h2_8daaf6152771_e5627efa2ab1");
  // The spec's intermediate values.
  assert.equal(ja4CipherHash(SPEC_CIPHERS), "8daaf6152771");
  assert.equal(ja4ExtensionHash(SPEC_EXTS, []), "6d807ffa2a79");
});

test("JA4 part a: no SNI gives i, no ALPN gives 00, a non-alphanumeric ALPN gives its first and last hex digit", () => {
  const a = (o: Parameters<typeof clientHello>[0]) => ja4(parseClientHello(clientHello(o))!).split("_")[0];
  assert.equal(a({ sni: false }), "t13i1515h2");
  assert.equal(a({ alpn: null }), "t13d151500");
  assert.equal(a({ alpn: [Buffer.from([0xab, 0xcd])] }), "t13d1516ad");
  assert.equal(a({ alpn: [Buffer.from([0x30, 0xab, 0xcd, 0x31])] }), "t13d151601");
  assert.equal(a({ alpn: [Buffer.from("http/1.1")] }), "t13d1516h1");
  // The parts b and c leave SNI and ALPN out, so they stay the specification's values.
  assert.equal(ja4(parseClientHello(clientHello({ sni: false, alpn: null }))!).slice(-25), "8daaf6152771_e5627efa2ab1");
});

test("a ClientHello cut short is not parsed yet, and a non-TLS start is refused", () => {
  const full = clientHello();
  assert.equal(parseClientHello(full.subarray(0, 50)), undefined);
  assert.equal(parseClientHello(full.subarray(0, full.length - 1)), undefined);
  assert.throws(() => parseClientHello(Buffer.from("GET / HTTP/1.1\r\n")), /not a TLS handshake/);
});

test("GREASE values are the sixteen 0x?a?a codes", () => {
  const all = Array.from({ length: 0x10000 }, (_, i) => i).filter(isGrease);
  assert.deepEqual(all, Array.from({ length: 16 }, (_, i) => (i << 12) | 0x0a00 | (i << 4) | 0x0a));
});

/** The first bytes that a real client sends to a raw TCP listener, until `done` says enough. */
async function capture(start: (port: number) => { destroy(): void }, done: (b: Buffer) => boolean): Promise<Buffer> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      server.once("connection", (sock) => {
        let buf = Buffer.alloc(0);
        sock.on("data", (b) => { buf = Buffer.concat([buf, b]); if (done(buf)) { sock.destroy(); resolve(buf); } });
        sock.on("error", reject);
      });
      const client = start(port);
      setTimeout(() => { client.destroy(); reject(new Error("no bytes")); }, 5_000).unref();
    });
  } finally {
    server.close();
  }
}

test("a real ClientHello from Node's TLS client parses: its SNI, its ALPN and a TLS 1.3 JA4", async () => {
  const bytes = await capture(
    (port) => { const s = tlsConnect({ host: "127.0.0.1", port, servername: "probe.localhost", ALPNProtocols: ["h2", "http/1.1"] }); s.on("error", () => {}); return s; },
    (b) => { try { return !!parseClientHello(b); } catch { return true; } },
  );
  const ch = parseClientHello(bytes)!;
  assert.equal(ch.sni, "probe.localhost");
  assert.deepEqual(ch.alpn, ["h2", "http/1.1"]);
  assert.ok(ch.supportedVersions.includes(0x0304));
  assert.match(ja4(ch), /^t13d\d{4}h2_[0-9a-f]{12}_[0-9a-f]{12}$/);
});

test("the first HTTP/2 frames from Node's HTTP/2 client parse into an Akamai fingerprint", async () => {
  const bytes = await capture(
    (port) => {
      const s = http2Connect(`http://127.0.0.1:${port}`, { settings: { headerTableSize: 65536, enablePush: false, initialWindowSize: 6291456, maxHeaderListSize: 262144 } });
      s.on("error", () => {});
      const req = s.request({ ":path": "/" });
      req.on("error", () => {});
      return { destroy: () => s.destroy() };
    },
    (b) => { try { return !!parseH2Start(b); } catch { return true; } },
  );
  const start = parseH2Start(bytes)!;
  const settings = new Map(start.settings);
  assert.equal(settings.get(1), 65536);
  assert.equal(settings.get(2), 0);
  assert.equal(settings.get(4), 6291456);
  assert.equal(settings.get(6), 262144);
  assert.ok(start.firstHeaders);
  const fp = akamaiH2(start, [":method", ":authority", ":scheme", ":path", "user-agent"]);
  assert.match(fp, /^[0-9:;]+\|(\d+|00)\|0\|m,a,s,p$/);
});

test("the Akamai fingerprint of hand-made Chrome-like frames", () => {
  const frame = (type: number, flags: number, stream: number, payload: Buffer) =>
    Buffer.concat([u24(payload.length), Buffer.from([type, flags]), Buffer.from([stream >> 24, stream >> 16, stream >> 8, stream].map((x) => x & 0xff)), payload]);
  const setting = (id: number, v: number) => { const b = Buffer.alloc(6); b.writeUInt16BE(id); b.writeUInt32BE(v, 2); return b; };
  const wu = Buffer.alloc(4); wu.writeUInt32BE(15663105);
  const prio = Buffer.from([0x80, 0, 0, 0, 255]);
  const bytes = Buffer.concat([
    Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", "latin1"),
    frame(4, 0, 0, Buffer.concat([setting(1, 65536), setting(2, 0), setting(4, 6291456), setting(6, 262144)])),
    frame(8, 0, 0, wu),
    frame(1, 0x24, 1, Buffer.concat([prio, Buffer.from([0x82])])),
  ]);
  const start = parseH2Start(bytes)!;
  assert.deepEqual(start.firstHeaders, { stream: 1, flags: 0x24, exclusive: true, dependsOn: 0, weight: 256 });
  assert.equal(akamaiH2(start, [":method", ":authority", ":scheme", ":path"]), "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p");
  assert.equal(parseH2Start(bytes.subarray(0, bytes.length - 2)), undefined);
  assert.throws(() => parseH2Start(Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n\r\n")), /no HTTP\/2 client preface/);
});
