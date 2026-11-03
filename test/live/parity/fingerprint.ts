// What a site's server sees below the page: the TLS ClientHello (JA4, JA3) and the first HTTP/2
// frames (the Akamai HTTP/2 fingerprint). Pure functions over captured bytes; the probe's server
// captures the bytes (server.ts). test/parity-fingerprint.test.ts checks them.

import { createHash } from "node:crypto";

/** A GREASE value (RFC 8701): both bytes equal, low nibble 0xA. */
export function isGrease(v: number): boolean {
  return (v & 0x0f0f) === 0x0a0a && v >> 8 === (v & 0xff);
}

const hex4 = (v: number) => v.toString(16).padStart(4, "0");
const sha12 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

export type ClientHello = {
  legacyVersion: number;
  ciphers: number[];             // in order, GREASE kept
  extensions: number[];          // in order, GREASE kept
  sni?: string;
  alpn: string[];
  supportedVersions: number[];
  groups: number[];
  pointFormats: number[];
  sigAlgs: number[];
  keyShares: number[];
  certCompression: number[];
  alps: string[];                // application_settings (0x4469 old, 0x44cd new)
  ech: boolean;                  // encrypted_client_hello (0xfe0d), GREASE ECH included
  bytes: number;                 // the ClientHello handshake message length
};

/**
 * The ClientHello from the first bytes a client sent on a TCP connection, or undefined while the
 * bytes hold less than one whole ClientHello. Throws when the bytes are not a TLS handshake.
 */
export function parseClientHello(buf: Buffer): ClientHello | undefined {
  // The handshake message can span several records: join their payloads.
  const parts: Buffer[] = [];
  let off = 0;
  let have = 0;
  let need = -1;
  while (off + 5 <= buf.length) {
    if (buf[off] !== 0x16) throw new Error(`not a TLS handshake record (type ${buf[off]})`);
    const len = buf.readUInt16BE(off + 3);
    if (off + 5 + len > buf.length) break;
    parts.push(buf.subarray(off + 5, off + 5 + len));
    have += len;
    off += 5 + len;
    const hs = Buffer.concat(parts);
    if (need < 0 && hs.length >= 4) {
      if (hs[0] !== 0x01) throw new Error(`not a ClientHello (handshake type ${hs[0]})`);
      need = 4 + hs.readUIntBE(1, 3);
    }
    if (need >= 0 && have >= need) return parseBody(hs.subarray(4, need));
  }
  if (buf.length && buf[0] !== 0x16) throw new Error(`not a TLS handshake record (type ${buf[0]})`);
  return undefined;
}

function parseBody(b: Buffer): ClientHello {
  let p = 0;
  const u16 = () => { const v = b.readUInt16BE(p); p += 2; return v; };
  const legacyVersion = u16();
  p += 32;                                   // random
  p += 1 + b[p];                             // session id
  const cs = u16();
  const ciphers: number[] = [];
  for (const end = p + cs; p < end;) ciphers.push(u16());
  p += 1 + b[p];                             // compression methods
  const ch: ClientHello = {
    legacyVersion, ciphers, extensions: [], alpn: [], supportedVersions: [], groups: [], pointFormats: [],
    sigAlgs: [], keyShares: [], certCompression: [], alps: [], ech: false, bytes: b.length + 4,
  };
  if (p >= b.length) return ch;
  const extEnd = p + 2 + u16();
  while (p + 4 <= extEnd) {
    const type = u16();
    const len = u16();
    const d = b.subarray(p, p + len);
    p += len;
    ch.extensions.push(type);
    // Each reader stops at the end of the extension's data: an empty or short body gives [].
    const list16 = (start: number, lenBytes: 1 | 2) => {
      if (d.length < start + lenBytes) return [];
      const n = lenBytes === 1 ? d[start] : d.readUInt16BE(start);
      const out: number[] = [];
      for (let i = start + lenBytes; i + 2 <= Math.min(start + lenBytes + n, d.length); i += 2) out.push(d.readUInt16BE(i));
      return out;
    };
    const strings = (start: number) => {
      const out: string[] = [];
      if (d.length < start + 2) return out;
      const end = Math.min(start + 2 + d.readUInt16BE(start), d.length);
      for (let i = start + 2; i < end;) { const n = d[i]; out.push(d.subarray(i + 1, i + 1 + n).toString("latin1")); i += 1 + n; }
      return out;
    };
    switch (type) {
      case 0x0000: if (len > 5) ch.sni = d.subarray(5, 5 + d.readUInt16BE(3)).toString("latin1"); break;
      case 0x0010: ch.alpn = strings(0); break;
      case 0x002b: ch.supportedVersions = list16(0, 1); break;
      case 0x000a: ch.groups = list16(0, 2); break;
      case 0x000b: ch.pointFormats = d.length ? [...d.subarray(1, 1 + d[0])] : []; break;
      case 0x000d: ch.sigAlgs = list16(0, 2); break;
      case 0x001b: ch.certCompression = list16(0, 1); break;
      case 0x0033: {
        if (d.length < 2) break;
        const end = Math.min(2 + d.readUInt16BE(0), d.length);
        for (let i = 2; i + 4 <= end;) { ch.keyShares.push(d.readUInt16BE(i)); i += 4 + d.readUInt16BE(i + 2); }
        break;
      }
      case 0x4469: case 0x44cd: ch.alps = strings(0); break;
      case 0xfe0d: ch.ech = true; break;
    }
  }
  return ch;
}

const VERSION_CODE: Record<number, string> = { 0x0304: "13", 0x0303: "12", 0x0302: "11", 0x0301: "10", 0x0300: "s3", 0x0002: "s2", 0xfeff: "d1", 0xfefd: "d2", 0xfefc: "d3" };

/** JA4 (FoxIO, TCP): `t<ver><d|i><ciphers><exts><alpn>_<sha cipher list>_<sha exts_sigalgs>`. */
export function ja4(ch: ClientHello): string {
  const ciphers = ch.ciphers.filter((c) => !isGrease(c));
  const exts = ch.extensions.filter((e) => !isGrease(e));
  const versions = ch.supportedVersions.filter((v) => !isGrease(v));
  const version = VERSION_CODE[versions.length ? Math.max(...versions) : ch.legacyVersion] ?? "00";
  const alpn = ch.alpn[0];
  let alpnCode = "00";
  if (alpn) {
    const first = alpn[0], last = alpn[alpn.length - 1];
    alpnCode = /[0-9A-Za-z]/.test(first) && /[0-9A-Za-z]/.test(last)
      ? first + last
      : Buffer.from(alpn, "latin1").toString("hex").at(0)! + Buffer.from(alpn, "latin1").toString("hex").at(-1)!;
  }
  const two = (n: number) => String(Math.min(n, 99)).padStart(2, "0");
  const a = `t${version}${ch.sni !== undefined ? "d" : "i"}${two(ciphers.length)}${two(exts.length)}${alpnCode}`;
  const b = ciphers.length ? ja4CipherHash(ciphers) : "000000000000";
  const c = exts.length ? ja4ExtensionHash(exts, ch.sigAlgs) : "000000000000";
  return `${a}_${b}_${c}`;
}

/** JA4 part b: the sorted cipher list (GREASE removed), as 4-hex codes, hashed. */
export function ja4CipherHash(ciphers: number[]): string {
  return sha12(ciphers.filter((c) => !isGrease(c)).map(hex4).sort().join(","));
}

/** JA4 part c: the sorted extensions without GREASE, SNI and ALPN, then the signature algorithms in order. */
export function ja4ExtensionHash(exts: number[], sigAlgs: number[]): string {
  const e = exts.filter((x) => !isGrease(x) && x !== 0x0000 && x !== 0x0010).map(hex4).sort().join(",");
  const s = sigAlgs.filter((x) => !isGrease(x)).map(hex4).join(",");
  return sha12(s ? `${e}_${s}` : e);
}

/** JA3 (in the client's extension order, so it changes each connection in Chrome) and JA3N (sorted). */
export function ja3(ch: ClientHello): { ja3: string; ja3n: string; ja3nString: string } {
  const ng = (l: number[]) => l.filter((v) => !isGrease(v));
  const exts = ng(ch.extensions);
  const str = (e: number[]) => [ch.legacyVersion, ng(ch.ciphers).join("-"), e.join("-"), ng(ch.groups).join("-"), ch.pointFormats.join("-")].join(",");
  const md5 = (s: string) => createHash("md5").update(s).digest("hex");
  const sorted = str([...exts].sort((x, y) => x - y));
  return { ja3: md5(str(exts)), ja3n: md5(sorted), ja3nString: sorted };
}

/** The ClientHello in names a person can diff: hex codes, GREASE shown as "grease". */
export function describeClientHello(ch: ClientHello) {
  const h = (l: number[]) => l.map((v) => (isGrease(v) ? "grease" : hex4(v)));
  return {
    ja4: ja4(ch), ...ja3(ch),
    sni: ch.sni, alpn: ch.alpn, alps: ch.alps, ech: ch.ech, bytes: ch.bytes,
    ciphers: h(ch.ciphers), extensionsSorted: h(ch.extensions).filter((x) => x !== "grease").sort(),
    supportedVersions: h(ch.supportedVersions), groups: h(ch.groups), keyShares: h(ch.keyShares),
    sigAlgs: h(ch.sigAlgs), certCompression: h(ch.certCompression), pointFormats: ch.pointFormats,
  };
}

export type H2Start = {
  settings: [number, number][];
  windowUpdate?: number;
  priorityFrames: { stream: number; exclusive: boolean; dependsOn: number; weight: number }[];
  firstHeaders?: { stream: number; flags: number; exclusive?: boolean; dependsOn?: number; weight?: number };
};

const PREFACE = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", "latin1");

/** The client's first HTTP/2 frames up to and including its first HEADERS frame. */
export function parseH2Start(buf: Buffer): H2Start | undefined {
  if (buf.length < PREFACE.length) return undefined;
  if (!buf.subarray(0, PREFACE.length).equals(PREFACE)) throw new Error("no HTTP/2 client preface");
  const out: H2Start = { settings: [], priorityFrames: [] };
  let p = PREFACE.length;
  while (p + 9 <= buf.length) {
    const len = buf.readUIntBE(p, 3), type = buf[p + 3], flags = buf[p + 4], stream = buf.readUInt32BE(p + 5) & 0x7fffffff;
    if (p + 9 + len > buf.length) break;
    const d = buf.subarray(p + 9, p + 9 + len);
    p += 9 + len;
    if (type === 0x4 && !(flags & 0x1)) for (let i = 0; i + 6 <= d.length; i += 6) out.settings.push([d.readUInt16BE(i), d.readUInt32BE(i + 2)]);
    else if (type === 0x8 && stream === 0 && out.windowUpdate === undefined) out.windowUpdate = d.readUInt32BE(0) & 0x7fffffff;
    else if (type === 0x2) {
      const dep = d.readUInt32BE(0);
      out.priorityFrames.push({ stream, exclusive: !!(dep >>> 31), dependsOn: dep & 0x7fffffff, weight: d[4] + 1 });
    } else if (type === 0x1) {
      let q = flags & 0x8 ? 1 : 0;                       // PADDED
      const h: H2Start["firstHeaders"] = { stream, flags };
      if (flags & 0x20) {                                // PRIORITY
        const dep = d.readUInt32BE(q);
        h.exclusive = !!(dep >>> 31); h.dependsOn = dep & 0x7fffffff; h.weight = d[q + 4] + 1;
        q += 5;
      }
      out.firstHeaders = h;
      return out;
    }
  }
  return undefined;
}

/** The Akamai HTTP/2 fingerprint `SETTINGS|WINDOW_UPDATE|PRIORITY|PSEUDO_HEADER_ORDER`. */
export function akamaiH2(start: H2Start, pseudoHeaders: string[]): string {
  const s = start.settings.map(([k, v]) => `${k}:${v}`).join(";");
  const w = start.windowUpdate === undefined ? "00" : String(start.windowUpdate);
  const pr = start.priorityFrames.length
    ? start.priorityFrames.map((f) => `${f.stream}:${f.exclusive ? 1 : 0}:${f.dependsOn}:${f.weight}`).join(",")
    : "0";
  const order = pseudoHeaders.filter((n) => n.startsWith(":")).map((n) => n[1]).join(",");
  return `${s}|${w}|${pr}|${order}`;
}
