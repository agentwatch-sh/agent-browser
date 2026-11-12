// The tests' pane's seal (board ab-v16.97.2): what agentwatch's screen-seal.js (sealPayload) makes, written again for the
// tests of the stored sign-ins, so a test seals a value with the binding and the time that it needs. The vectors' shared
// seal (test/vectors/control.json, paneSeal: a seal that screen-seal.js made) proves that this one gives the same text
// with the same keys. TEST values only: every key here is a fixed or a new test key.

import { createCipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes } from "node:crypto";

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const hmac = (key: Buffer, ...data: Buffer[]) => { const h = createHmac("sha256", key.length ? key : Buffer.alloc(32)); for (const d of data) h.update(d); return h.digest(); };
function expand(prk: Buffer, info: Buffer, length: number): Buffer {
  const out: Buffer[] = [];
  let block = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(out).length < length; i++) { block = hmac(prk, block, info, Buffer.from([i])); out.push(block); }
  return Buffer.concat(out).subarray(0, length);
}
const V1 = Buffer.from("HPKE-v1");
const KEM = Buffer.concat([Buffer.from("KEM"), u16(0x20)]);
const SUITE = Buffer.concat([Buffer.from("HPKE"), u16(0x20), u16(1), u16(3)]);
const E = Buffer.alloc(0);
const lx = (suite: Buffer, salt: Buffer, label: string, ikm: Buffer) => hmac(salt, V1, suite, Buffer.from(label), ikm);
const le = (suite: Buffer, prk: Buffer, label: string, info: Buffer, n: number) => expand(prk, Buffer.concat([u16(n), V1, suite, Buffer.from(label), info]), n);

const priv = (secret: Buffer) => createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), secret]), format: "der", type: "pkcs8" });
const pubOf = (raw: Buffer) => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), raw]), format: "der", type: "spki" });
const rawOf = (secret: Buffer) => Buffer.from(createPublicKey(priv(secret)).export({ format: "der", type: "spki" }).subarray(12));

/** 32 test bytes from a label, as the vectors make their test keys: SHA-256 of "test, not a key: <label>". */
export const testBytes = (label: string) => createHash("sha256").update(`test, not a key: ${label}`).digest();
/** The public half (standard base64) of a test key's 32 secret bytes. */
export const publicB64 = (secret: Buffer) => rawOf(secret).toString("base64");

/** The binding's bytes (screen-seal.js's bindingInfo). */
export function info(purpose: string, fields: Record<string, string>): Buffer {
  const names = Object.keys(fields).sort();
  return Buffer.from(`agentwatch-${purpose}-v1\u0000{${names.map((n) => `${JSON.stringify(n)}:${JSON.stringify(fields[n])}`).join(",")}}`);
}

/** sealPayload: the seal of a JSON object to `recipient` (standard base64), with fixed test keys or new ones. */
export function sealPayload(payload: object, binding: { purpose: string; fields: Record<string, string> }, recipient: string, keys: { ephemeral?: Buffer; sender?: Buffer } = {}, pad = true): { sealed: string; senderPublicB64: string } {
  const pkR = Buffer.from(recipient, "base64");
  const bindingBytes = info(binding.purpose, binding.fields);
  const json = Buffer.from(JSON.stringify(payload));
  // screen-seal.js pads the JSON with spaces to a multiple of 256 bytes; mail_crypto.seal_payload does not (pad false).
  const plain = pad ? Buffer.alloc(Math.max(256, Math.ceil(json.length / 256) * 256), 0x20) : Buffer.alloc(json.length);
  json.copy(plain);
  const sender = keys.sender ?? randomBytes(32);
  const auth = Buffer.from(hkdfSync("sha256", diffieHellman({ privateKey: priv(sender), publicKey: pubOf(pkR) }), Buffer.alloc(32), Buffer.from("agentwatch-mail-auth-v1"), 32));
  const inner = Buffer.concat([hmac(auth, bindingBytes, plain), plain]);
  const eph = keys.ephemeral ?? randomBytes(32);
  const enc = rawOf(eph);
  const dh = diffieHellman({ privateKey: priv(eph), publicKey: pubOf(pkR) });
  const shared = le(KEM, lx(KEM, E, "eae_prk", dh), "shared_secret", Buffer.concat([enc, pkR]), 32);
  const context = Buffer.concat([Buffer.from([0]), lx(SUITE, E, "psk_id_hash", E), lx(SUITE, E, "info_hash", bindingBytes)]);
  const secret = lx(SUITE, shared, "secret", E);
  const c = createCipheriv("chacha20-poly1305", le(SUITE, secret, "key", context, 32), le(SUITE, secret, "base_nonce", context, 12), { authTagLength: 16 });
  c.setAAD(E, { plaintextLength: inner.length });
  const ct = Buffer.concat([c.update(inner), c.final(), c.getAuthTag()]);
  return { sealed: `aw1:${Buffer.concat([enc, ct]).toString("base64url")}`, senderPublicB64: rawOf(sender).toString("base64") };
}

/** A pane's seal of C12 (`sealed`) for a request: its op, a new rid (or `rid`), the time `at`, and the record's fields of a seal. */
export function paneSeal(paneKey: string, payload: object, req: { op: string; record?: { id: string; name: string; origin: string; path: string; send_to: string[] }; offer?: boolean }, o: { at: string; rid?: string; keys?: { ephemeral?: Buffer; sender?: Buffer }; pad?: boolean }) {
  const rid = o.rid ?? randomBytes(16).toString("base64url");
  const fields: Record<string, string> = { op: req.op, rid, at: o.at };
  // The credential's id is in the binding too (board ab-v16.97.4; review-118 note 6).
  if (req.op === "sign_in_seal") Object.assign(fields, { id: req.record!.id, name: req.record!.name, origin: req.record!.origin, path: req.record!.path, send_to: req.record!.send_to.join(" "), offer: String(req.offer) });
  const s = sealPayload(payload, { purpose: "browser-sign-in", fields }, paneKey, o.keys, o.pad ?? true);
  return { text: s.sealed, sender: s.senderPublicB64, rid, at: o.at };
}
