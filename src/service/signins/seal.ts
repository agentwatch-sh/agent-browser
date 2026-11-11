// The stored sign-ins' crypto in the service (contract C12, "The stored sign-ins"; the design
// docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md, sections 5.2 and 5.3; board ab-v16.97.2). Node's
// crypto only, no package:
//
// - The pane's seal: agentwatch's Secret box seal (screen-seal.js's sealPayload; mail_crypto.open_payload opens it). HPKE
//   (RFC 9180) base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305, single shot, no additional data,
//   with the binding's bytes as the info; inside, a sender tag (HMAC-SHA256 over the info and the JSON, keyed by HKDF of
//   X25519(sender, pane key)), then the JSON, padded with spaces. The text is "aw1:" and base64url of enc || ciphertext.
// - The record's seal: an ephemeral X25519 key, the shared secret with the store's public half, HKDF-SHA256 to a 32-byte
//   key (salt: the ephemeral public half and the store's public half; info RECORD_LABEL), and AES-256-GCM over
//   {"username","password","totp":null} with the record's ten plain fields as the additional data (recordAd).
// - The store key's wrap: AES-256-GCM of the 32-byte private half under scrypt(passphrase, salt), with the key file's
//   plain fields (v, public, kdf) as the additional data, so a key file whose public half or KDF values a program
//   changed does not open.
//
// Every function throws on each failure, with no value in its message: the callers give C12's one text for each case.
// The buffers that hold a key or a plain value are filled with zeros where the code holds them; a JavaScript string
// cannot be (the design, section 5.5).

import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes, scrypt, timingSafeEqual, type KeyObject } from "node:crypto";

/** PKCS #8 and SPKI heads of an X25519 key (RFC 8410), before its 32 bytes. */
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const X25519_LEN = 32;

export const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
/** base64url in its one spelling (no padding, no other character), or null. */
export function fromB64u(text: unknown): Buffer | null {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const b = Buffer.from(text, "base64url");
  return b.toString("base64url") === text ? b : null;
}
/** Standard base64 of exactly `n` bytes in its one spelling (a public key of screen-seal.js), or null. */
function fromB64(text: unknown, n: number): Buffer | null {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  const b = Buffer.from(text, "base64");
  return b.length === n && b.toString("base64") === text ? b : null;
}
export const zero = (...bs: (Buffer | null | undefined)[]) => { for (const b of bs) b?.fill(0); };

// ---- X25519 ----

/** The private key of 32 secret bytes (the bytes are not changed; the caller zeros them). */
export function privateKeyOf(secret: Buffer): KeyObject {
  if (secret.length !== X25519_LEN) throw new Error("not a key");
  const der = Buffer.concat([PKCS8_X25519, secret]);
  try { return createPrivateKey({ key: der, format: "der", type: "pkcs8" }); } finally { der.fill(0); }
}
export const publicKeyOf = (raw: Buffer): KeyObject => {
  if (raw.length !== X25519_LEN) throw new Error("not a public key");
  return createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: "der", type: "spki" });
};
/** The 32 bytes of the public half of a private key. */
export const publicRaw = (priv: KeyObject): Buffer => Buffer.from(createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(SPKI_X25519.length));
/** X25519(priv, pub); a low-order public key (an all-zero result) throws, as mail_crypto refuses it. */
export function dh(priv: KeyObject, pub: Buffer): Buffer {
  const s = diffieHellman({ privateKey: priv, publicKey: publicKeyOf(pub) });
  if (s.every((b) => b === 0)) throw new Error("low-order key");
  return s;
}
/** A new X25519 key pair: its 32 secret bytes, the key and the public half. */
export function newKeyPair(random: (n: number) => Buffer = randomBytes): { secret: Buffer; key: KeyObject; pub: Buffer } {
  const secret = random(X25519_LEN);
  const key = privateKeyOf(secret);
  return { secret, key, pub: publicRaw(key) };
}

// ---- HKDF and HPKE's labeled forms (RFC 5869; RFC 9180, section 4) ----

const hmac = (key: Buffer, ...data: Buffer[]) => { const h = createHmac("sha256", key.length ? key : Buffer.alloc(32)); for (const d of data) h.update(d); return h.digest(); };
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
function expand(prk: Buffer, info: Buffer, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = Buffer.alloc(0);
  for (let i = 1, filled = 0; filled < length; i++) {
    block = hmac(prk, block, info, Buffer.from([i]));
    block.copy(out, filled, 0, Math.min(block.length, length - filled));
    filled += block.length;
  }
  zero(block);
  return out;
}
const HPKE_V1 = Buffer.from("HPKE-v1");
const KEM_SUITE = Buffer.concat([Buffer.from("KEM"), u16(0x0020)]);
const HPKE_SUITE = Buffer.concat([Buffer.from("HPKE"), u16(0x0020), u16(0x0001), u16(0x0003)]);
const EMPTY = Buffer.alloc(0);
const labeledExtract = (suite: Buffer, salt: Buffer, label: string, ikm: Buffer) => hmac(salt, HPKE_V1, suite, Buffer.from(label), ikm);
const labeledExpand = (suite: Buffer, prk: Buffer, label: string, info: Buffer, length: number) => expand(prk, Buffer.concat([u16(length), HPKE_V1, suite, Buffer.from(label), info]), length);

// ---- The pane's seal (screen-seal.js, mail_crypto) ----

const SEALED_PREFIX = "aw1:";
const AUTH_INFO = Buffer.from("agentwatch-mail-auth-v1");
const TAG_LEN = 32, AEAD_TAG_LEN = 16;
const PURPOSE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED_PURPOSES = new Set(["mail", "mail-auth", "email"]);
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
/** The purpose of the stored sign-ins' seals (C12, the pane's seal). */
export const SIGN_IN_PURPOSE = "browser-sign-in";

/**
 * The bytes of a binding (screen-seal.js's bindingInfo; mail_crypto.Binding.info): "agentwatch-<purpose>-v1", one NUL
 * byte, then the fields as JSON with sorted keys and no spaces. Each name and value is printable ASCII text, else it throws
 * (screen-seal.js refuses to make such a seal).
 */
export function bindingInfo(purpose: string, fields: Record<string, unknown>): Buffer {
  if (!PURPOSE_RE.test(purpose) || RESERVED_PURPOSES.has(purpose)) throw new Error("not a purpose");
  const names = Object.keys(fields).sort();
  for (const n of names) {
    const value = fields[n];
    if (typeof value !== "string" || !PRINTABLE_ASCII.test(n) || !PRINTABLE_ASCII.test(value)) throw new Error("not a binding");
  }
  return Buffer.from(`agentwatch-${purpose}-v1\u0000{${names.map((n) => `${JSON.stringify(n)}:${JSON.stringify(fields[n])}`).join(",")}}`);
}

/**
 * Open a pane's seal (`text`, from the sender key `sender`, standard base64) with the pane key and the binding's bytes:
 * the JSON object that it holds. Each failure throws: the form of the text or of the sender key, a low-order key, the
 * AEAD's tag (another binding, another pane key, a changed byte), the sender tag, a payload that is not a JSON object.
 */
export function openPaneSeal(text: string, sender: string, info: Buffer, pane: { key: KeyObject; pub: Buffer }): Record<string, unknown> {
  if (typeof text !== "string" || !text.startsWith(SEALED_PREFIX)) throw new Error("not sealed");
  const blob = fromB64u(text.slice(SEALED_PREFIX.length));
  const senderRaw = fromB64(sender, X25519_LEN);
  if (!blob || !senderRaw || blob.length < X25519_LEN + TAG_LEN + AEAD_TAG_LEN) throw new Error("not sealed");
  const enc = blob.subarray(0, X25519_LEN), ct = blob.subarray(X25519_LEN, blob.length - AEAD_TAG_LEN), aeadTag = blob.subarray(blob.length - AEAD_TAG_LEN);
  let dhBytes: Buffer | null = null, eae: Buffer | null = null, shared: Buffer | null = null, secret: Buffer | null = null, key: Buffer | null = null, nonce: Buffer | null = null, inner: Buffer | null = null, authIkm: Buffer | null = null, auth: Buffer | null = null;
  try {
    // Decap (DHKEM, RFC 9180 4.1), then the key schedule of mode_base (5.1): psk and psk_id are empty.
    dhBytes = dh(pane.key, enc);
    eae = labeledExtract(KEM_SUITE, EMPTY, "eae_prk", dhBytes);
    shared = labeledExpand(KEM_SUITE, eae, "shared_secret", Buffer.concat([enc, pane.pub]), 32);
    const context = Buffer.concat([Buffer.from([0]), labeledExtract(HPKE_SUITE, EMPTY, "psk_id_hash", EMPTY), labeledExtract(HPKE_SUITE, EMPTY, "info_hash", info)]);
    secret = labeledExtract(HPKE_SUITE, shared, "secret", EMPTY);
    key = labeledExpand(HPKE_SUITE, secret, "key", context, 32);
    nonce = labeledExpand(HPKE_SUITE, secret, "base_nonce", context, 12);
    const d = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: AEAD_TAG_LEN });
    d.setAAD(EMPTY, { plaintextLength: ct.length });
    d.setAuthTag(aeadTag);
    inner = Buffer.concat([d.update(ct), d.final()]);
    if (inner.length < TAG_LEN) throw new Error("no sender tag");
    // The sender tag (mail_crypto._auth_key and _tag): HKDF-SHA256 with no salt of X25519(pane key, sender).
    authIkm = dh(pane.key, senderRaw);
    auth = Buffer.from(hkdfSync("sha256", authIkm, Buffer.alloc(32), AUTH_INFO, 32));
    const plain = inner.subarray(TAG_LEN);
    const want = hmac(auth, info, plain);
    try { if (!timingSafeEqual(inner.subarray(0, TAG_LEN), want)) throw new Error("the sender is not proven"); } finally { zero(want); }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } finally { zero(dhBytes, eae, shared, secret, key, nonce, inner, authIkm, auth); }
}

// ---- The record's seal (the design, sections 5.2 and 5.3) ----

/** The label of a record's key derivation and of its additional data. */
export const RECORD_LABEL = "agentwatch-browser-sign-in-record-v1";
/** The ten plain fields that a record's seal binds (C12, the record). */
export type RecordFields = { v: number; id: string; gen: number; name: string; origin: string; path: string; send_to: string[]; repos: string[] | null; by: string; approved: boolean };
/** The additional data of a record's seal: its ten plain fields, in their order, as one JSON array. */
export const recordAd = (r: RecordFields): Buffer => Buffer.from(JSON.stringify([RECORD_LABEL, r.v, r.id, r.gen, r.name, r.origin, r.path, r.send_to, r.repos, r.by, r.approved]));
export type SealedPart = { epk: string; iv: string; ct: string; tag: string };

function recordKey(shared: Buffer, epk: Buffer, storePub: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([epk, storePub]), Buffer.from(RECORD_LABEL), 32));
}

/** Seal the plain JSON of a record's values to the store's public half, with the record's additional data. */
export function sealRecord(storePub: Buffer, ad: Buffer, plain: Buffer, random: (n: number) => Buffer = randomBytes): SealedPart {
  const e = newKeyPair(random);
  let shared: Buffer | null = null, key: Buffer | null = null;
  try {
    shared = dh(e.key, storePub);
    key = recordKey(shared, e.pub, storePub);
    const iv = random(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(ad);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return { epk: b64u(e.pub), iv: b64u(iv), ct: b64u(ct), tag: b64u(c.getAuthTag()) };
  } finally { zero(e.secret, shared, key); }
}

/** Open a record's sealed part with the store's open key: the plain JSON (the caller zeros it). Each failure throws. */
export function openRecord(store: { key: KeyObject; pub: Buffer }, ad: Buffer, s: unknown): Buffer {
  if (s === null || typeof s !== "object") throw new Error("not a sealed part");
  const p = s as Record<string, unknown>;
  const epk = fromB64u(p.epk), iv = fromB64u(p.iv), ct = fromB64u(p.ct), tag = fromB64u(p.tag);
  if (!epk || !iv || !ct || !tag || epk.length !== X25519_LEN || iv.length !== 12 || tag.length !== 16) throw new Error("not a sealed part");
  let shared: Buffer | null = null, key: Buffer | null = null;
  try {
    shared = dh(store.key, epk);
    key = recordKey(shared, epk, store.pub);
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAAD(ad);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  } finally { zero(shared, key); }
}

/** The plain JSON of a record's values (the design, section 5.2: no second factor with the answer Q4 a). */
export const recordPlain = (username: string, password: string): Buffer => Buffer.from(JSON.stringify({ username, password, totp: null }));
/** True when a record's plain JSON has its shape: a string username and password, and totp null. */
export function plainFits(plain: Buffer): boolean {
  try {
    const o = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
    return o !== null && typeof o === "object" && typeof o.username === "string" && typeof o.password === "string" && o.totp === null;
  } catch { return false; }
}

// ---- The store key's wrap (C12, `key`) ----

/**
 * scrypt's first values and bounds (C12: N 2^17 at a set-up; N a power of two from 2^15 to 2^18, r 8, p 1, a salt of 16
 * bytes). `maxmem` is 257 MiB: scrypt needs 128 * r * (N + 2) bytes and 128 * r * p more, so N = 2^18 does not derive
 * under 256 MiB (measured with Node's crypto.scrypt: "memory limit exceeded").
 */
export const KDF = { n: 131072, r: 8, p: 1, saltBytes: 16, minN: 32768, maxN: 262144, maxmem: 257 * 1024 * 1024 } as const;
export type Kdf = { name: "scrypt"; n: number; r: number; p: number; salt: string };
export type KeyFile = { v: 1; public: string; kdf: Kdf; wrapped: { iv: string; ct: string; tag: string } };

/** The KDF values of a key file within C12's bounds (checked before any derivation). */
export function kdfFits(kdf: unknown): kdf is Kdf {
  if (kdf === null || typeof kdf !== "object") return false;
  const k = kdf as Record<string, unknown>;
  const n = k.n as number;
  return k.name === "scrypt" && Number.isSafeInteger(n) && n >= KDF.minN && n <= KDF.maxN && (n & (n - 1)) === 0 && k.r === KDF.r && k.p === KDF.p
    && fromB64u(k.salt)?.length === KDF.saltBytes;
}
/** A key file that the service takes (C12): a string `public`, an object `wrapped` of the strings iv, ct and tag, and the KDF bounds. */
export function keyFits(key: unknown): key is KeyFile {
  if (key === null || typeof key !== "object") return false;
  const k = key as Record<string, any>;
  return typeof k.public === "string" && k.wrapped !== null && typeof k.wrapped === "object" && !Array.isArray(k.wrapped)
    && ["iv", "ct", "tag"].every((x) => typeof k.wrapped[x] === "string") && kdfFits(k.kdf);
}

/** The key that scrypt gives from a passphrase (async: the thread pool, not the event loop). Only for a kdf that fits. */
export function deriveKey(passphrase: string, kdf: Kdf): Promise<Buffer> {
  if (!kdfFits(kdf)) return Promise.reject(new Error("the KDF values are outside the bounds"));
  const pass = Buffer.from(passphrase, "utf8");
  return new Promise<Buffer>((resolve, reject) => scrypt(pass, fromB64u(kdf.salt)!, 32, { N: kdf.n, r: kdf.r, p: kdf.p, maxmem: KDF.maxmem }, (e, k) => { zero(pass); if (e) reject(e); else resolve(k); }));
}
const keyAd = (v: unknown, pub: string, kdf: Kdf) => Buffer.from(JSON.stringify(["agentwatch-browser-sign-ins-key-v1", v, pub, kdf.name, kdf.n, kdf.r, kdf.p, kdf.salt]));

/** A new key file: the private half wrapped under `kek` (derived with `kdf`), and the public half. */
export function wrapKey(secret: Buffer, pub: Buffer, kdf: Kdf, kek: Buffer, random: (n: number) => Buffer = randomBytes): KeyFile {
  const iv = random(12);
  const p = b64u(pub);
  const c = createCipheriv("aes-256-gcm", kek, iv);
  c.setAAD(keyAd(1, p, kdf));
  const ct = Buffer.concat([c.update(secret), c.final()]);
  return { v: 1, public: p, kdf: { ...kdf }, wrapped: { iv: b64u(iv), ct: b64u(ct), tag: b64u(c.getAuthTag()) } };
}
/** The private half of a key file, with the key that its passphrase gives; throws when it does not open. */
export function unwrapKey(key: KeyFile, kek: Buffer): Buffer {
  const iv = fromB64u(key.wrapped.iv), ct = fromB64u(key.wrapped.ct), tag = fromB64u(key.wrapped.tag);
  if (!iv || !ct || !tag || tag.length !== 16 || iv.length === 0) throw new Error("not a wrapped key");
  const d = createDecipheriv("aes-256-gcm", kek, iv);
  d.setAAD(keyAd((key as { v: unknown }).v, key.public, key.kdf));
  d.setAuthTag(tag);
  const secret = Buffer.concat([d.update(ct), d.final()]);
  if (secret.length !== X25519_LEN) { zero(secret); throw new Error("not a wrapped key"); }
  return secret;
}
/** A new salt and the first KDF values of a set-up or a new passphrase. */
export const newKdf = (n: number = KDF.n, random: (n: number) => Buffer = randomBytes): Kdf => ({ name: "scrypt", n, r: KDF.r, p: KDF.p, salt: b64u(random(KDF.saltBytes)) });
