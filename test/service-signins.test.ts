// The stored sign-ins' store in the service (contract C12, "The stored sign-ins"; the design
// docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md, sections 5, 6, 8 and 11; board ab-v16.97.2,
// stage 1e part 1): the pane's seal with the vectors' seals of agentwatch's screen-seal.js, the record's seal, the key
// file and its KDF bounds, the generation, the lock, every op with its texts, status, the events, the offer, the
// protections of the service's memory, the replay of the vectors on the real store, and the scans. Each test keeps its
// store's state folder in a temp folder of its own and removes it. Every value here is a TEST value (the vectors'
// canaries and test keys).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, diffieHellman, hkdfSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlDoor, SIGN_IN_OPS, type Req } from "../src/service/control.ts";
import { Stage1a } from "../src/service/service.ts";
import { serviceFeatures } from "../src/service/main.ts";
import { SignInsPart, STAGE_1E1_OPS } from "../src/service/signins/part.ts";
import { nonDumpableStart, protectionReason, signalHeld, type Unprotected } from "../src/service/signins/protect.ts";
import {
  b64u, bindingInfo, deriveKey, KDF, kdfFits, keyFits, newKeyPair, openPaneSeal, openRecord, privateKeyOf, publicKeyOf, publicRaw, recordAd, recordPlain, sealRecord, unwrapKey, type RecordFields,
} from "../src/service/signins/seal.ts";
import { atFits, HOUR_MS, STATE_FILE, TEXT } from "../src/service/signins/store.ts";
import { DAEMON_HELLO, daemonClient } from "./fake-daemon.ts";
import { paneSeal, sealPayload, testBytes } from "./sign-in-seal.ts";

/**
 * review-118 B1: a record that a program of the user seals with key.json's public half alone (the first build's
 * construction: HKDF of DH(ephemeral, store public) and public values only). It must not open.
 */
function forgeRecord(storePub: Buffer, ad: Buffer, plain: Buffer) {
  const e = newKeyPair();
  const key = Buffer.from(hkdfSync("sha256", diffieHellman({ privateKey: e.key, publicKey: publicKeyOf(storePub) }), Buffer.concat([e.pub, storePub]), Buffer.from("agentwatch-browser-sign-in-record-v1"), 32));
  const iv = Buffer.alloc(12, 9);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(ad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { epk: b64u(e.pub), iv: b64u(iv), ct: b64u(ct), tag: b64u(c.getAuthTag()) };
}

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BIN = join(ROOT, "bin/agent-browser.js");
const control = JSON.parse(readFileSync(new URL("./vectors/control.json", import.meta.url), "utf8"));
const P = control.paneSeal;
const PANE_SECRET = Buffer.from(P.pane_secret_hex, "hex");
const S = control.state.sign_ins;
// The vectors' canaries (signInScan): the test values that their seals hold.
const [USER, PASS, PASSPHRASE, NEW_PASSPHRASE, WRONG, SHORT] = control.signInScan.canaries as string[];
const T0 = Date.parse("2026-11-10T20:00:00Z");
const ORIGIN = "https://staging.example.com";
const OP = { kind: "operator", user: "ann", via: "web" } as const, DAEMON = { kind: "daemon", user: "ann", via: "daemon" } as const, TOKEN = { kind: "token", user: "ann", via: "cli" } as const;
const hex = (h: string) => Buffer.from(h, "hex");
const FORMS = (s: string) => [s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1), Buffer.from(s).toString("base64"), Buffer.from(s).toString("base64url")];
const holdsCanary = (text: string, canaries: string[] = control.signInScan.canaries) => canaries.some((c) => FORMS(c).some((f) => text.includes(f)));

// ------------------------------------------------------------------ a store in a temp folder

type World = { dir: string; logs: string[]; part: SignInsPart; events: any[]; clock: { t: number }; ask: (op: string, fields?: Record<string, unknown>, by?: Req["by"]) => Promise<any>; close: () => void };
let ids = 0;
function world(o: { protections?: () => Unprotected | null; paneSecret?: Buffer; kdfN?: number; wrongWaitMs?: number; dir?: string } = {}): World {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "ab-signins-"));
  const logs: string[] = [], events: any[] = [];
  const clock = { t: T0 };
  const part = new SignInsPart({ stateFolder: join(dir, "state"), log: (l) => logs.push(l), protections: o.protections ?? (() => null), now: () => new Date(clock.t), paneSecret: o.paneSecret, kdfN: o.kdfN ?? KDF.minN, wrongWaitMs: o.wrongWaitMs });
  part.attach((ev) => events.push(ev));
  const ask = async (op: string, fields: Record<string, unknown> = {}, by: Req["by"] = op === "sign_ins" ? DAEMON : OP) => {
    const r = await part.ops[op]({ t: "req", id: `x${++ids}`, op, by, ...fields } as Req);
    await new Promise((res) => setImmediate(res));
    return r;
  };
  return { dir, logs, part, events, clock, ask, close: () => { part.stop(); if (!o.dir) rmSync(dir, { recursive: true, force: true }); } };
}
const at = (w: World) => new Date(w.clock.t).toISOString();
const paneKey = (w: World) => w.part.store.paneKey();
const passSeal = (w: World, op: string, payload: object, o: { rid?: string; at?: string } = {}) => paneSeal(paneKey(w), payload, { op }, { at: o.at ?? at(w), rid: o.rid });
const REC = { id: "c-0000000a", name: "staging", origin: ORIGIN, path: "/login", send_to: [ORIGIN] };
const sealReq = (w: World, record: typeof REC, offer = false, payload: object = { username: USER, password: PASS }, o: { rid?: string; at?: string } = {}) =>
  ({ record, offer, sealed: paneSeal(paneKey(w), payload, { op: "sign_in_seal", record, offer }, { at: o.at ?? at(w), rid: o.rid }) });
/** The set-up of a new store: the first snapshot, the set-up, and the snapshot with its key.json. */
async function setUp(w: World, records: object[] = []): Promise<any> {
  assert.deepEqual(await w.ask("sign_ins", { key: null, records: [] }), { data: { records: 0 } });
  const a = await w.ask("sign_ins_setup", { sealed: passSeal(w, "sign_ins_setup", { passphrase: PASSPHRASE }) });
  assert.ok(a.data?.key, JSON.stringify(a));
  assert.deepEqual(await w.ask("sign_ins", { key: a.data.key, records }), { data: { records: records.length } });
  return a.data.key;
}
/** A record file as the daemon writes it from an answer of sign_in_seal or sign_in_reseal. */
const fileOf = (a: any, extra: object = {}) => ({ ...a.data.record, state: a.data.record.approved ? "usable" : "offered", added: { at: "2026-11-10T20:00:00Z", by: "ann", via: "web" }, changed: null, sealed: a.data.sealed, ...extra });

// ------------------------------------------------------------------ the pane's seal (open point 1 of PR #112)

test("the pane's seal: the vectors' shared seal of screen-seal.js opens with its binding's bytes and the test pane key; the tests' sealer makes the same text; each other binding, byte, sender or pane key does not open", () => {
  const key = privateKeyOf(PANE_SECRET), pub = publicRaw(key);
  assert.equal(pub.toString("base64"), P.pane_key);
  assert.equal(P.pane_key, S.pane_key, "the vectors' pane key is the test pane key's public half");
  const v = P.vector;
  const info = bindingInfo(v.purpose, v.fields);
  assert.equal(info.toString("hex"), v.info_hex, "the binding's bytes");
  assert.equal(info.toString("latin1"), `agentwatch-browser-sign-in-v1\u0000${JSON.stringify(Object.fromEntries(Object.keys(v.fields).sort().map((k) => [k, v.fields[k]])))}`);
  assert.deepEqual(openPaneSeal(v.sealed, v.sender_public_b64, info, { key, pub }), v.payload, "the payload, with its UTF-8, its quote and its backslash");
  assert.deepEqual(sealPayload(v.payload, { purpose: v.purpose, fields: v.fields }, P.pane_key, { ephemeral: hex(v.ephemeral_secret_hex), sender: hex(v.sender_secret_hex) }), { sealed: v.sealed, senderPublicB64: v.sender_public_b64 }, "the tests' sealer is screen-seal.js's");
  for (const k of Object.keys(v.fields)) assert.throws(() => openPaneSeal(v.sealed, v.sender_public_b64, bindingInfo(v.purpose, { ...v.fields, [k]: `${v.fields[k]}x` }), { key, pub }), `another ${k}`);
  assert.throws(() => openPaneSeal(v.sealed, v.sender_public_b64, bindingInfo("browser-sign-ix", v.fields), { key, pub }), "another purpose");
  const raw = Buffer.from(v.sealed.slice(4), "base64url");
  for (const at of [0, 40, raw.length - 1]) { const b = Buffer.from(raw); b[at] ^= 1; assert.throws(() => openPaneSeal(`aw1:${b.toString("base64url")}`, v.sender_public_b64, info, { key, pub }), `a changed byte at ${at}`); }
  assert.throws(() => openPaneSeal(v.sealed, Buffer.from(testBytes("another sender")).toString("base64"), info, { key, pub }), "another sender key");
  assert.throws(() => openPaneSeal(v.sealed, Buffer.alloc(32).toString("base64"), info, { key, pub }), "a low-order sender key");
  assert.throws(() => openPaneSeal(v.sealed, v.sender_public_b64.replace(/=$/, ""), info, { key, pub }), "a sender key in another spelling");
  const other = newKeyPair();
  assert.throws(() => openPaneSeal(v.sealed, v.sender_public_b64, info, other), "another pane key (a new start)");
  assert.throws(() => bindingInfo("browser-sign-in", { ...v.fields, path: "/lögin" }), "a value that is not printable ASCII");
  assert.throws(() => bindingInfo("browser-sign-in", { ...v.fields, path: "/a\nb" }), "a control character");
  assert.throws(() => bindingInfo("mail", v.fields), "a reserved purpose");
});

test("each pane's seal of the vectors' lines is a seal of screen-seal.js that opens with its own request's binding (op, rid, at, and a seal's record and offer), and with no other", () => {
  const key = privateKeyOf(PANE_SECRET), pane = { key, pub: publicRaw(key) };
  const lines = [...control.requests, ...control.badRequests, ...control.unprotected.cases.flatMap((c: any) => c.requests)].map((v: any) => v.req)
    .filter((r: any) => r.sealed && typeof r.sealed === "object" && typeof r.sealed.rid === "string" && typeof r.sealed.at === "string" && (r.op !== "sign_in_seal" || typeof r.offer === "boolean"));
  assert.ok(lines.length >= 39, `${lines.length} seals`);
  const fieldsOf = (r: any) => ({ op: r.op, rid: r.sealed.rid, at: r.sealed.at, ...(r.op === "sign_in_seal" ? { name: r.record.name, origin: r.record.origin, path: r.record.path, send_to: r.record.send_to.join(" "), offer: String(r.offer) } : {}) });
  const want: Record<string, string[]> = { sign_ins_setup: ["passphrase"], sign_ins_unlock: ["passphrase"], sign_ins_rekey: ["new", "old"], sign_in_seal: ["password", "username"] };
  for (const r of lines) {
    const f = fieldsOf(r);
    const got = openPaneSeal(r.sealed.text, r.sealed.sender, bindingInfo("browser-sign-in", f), pane);
    assert.deepEqual(Object.keys(got).sort(), want[r.op], r.id);
    assert.ok(Object.values(got).every((x) => control.signInScan.canaries.includes(x)), `${r.id}: the canaries`);
    assert.throws(() => openPaneSeal(r.sealed.text, r.sealed.sender, bindingInfo("browser-sign-in", { ...f, op: r.op === "sign_ins_unlock" ? "sign_ins_setup" : "sign_ins_unlock" }), pane), `${r.id}: another op`);
    if (r.op === "sign_in_seal") assert.throws(() => openPaneSeal(r.sealed.text, r.sealed.sender, bindingInfo("browser-sign-in", { ...f, offer: String(!r.offer) }), pane), `${r.id}: an offer's seal never opens for the operator's request, and the reverse`);
  }
  // The fake's scripted texts are seals of the vectors too.
  const byId = (id: string) => control.requests.find((v: any) => v.req.id === id).req.sealed.text;
  assert.deepEqual([S.short_passphrase, S.short_rekey, S.wrong_passphrase, S.stale_seal], [byId("s5"), byId("s30"), byId("s28"), byId("s11")]);
});

test("the time of a pane's seal: the form of C12 and a real time in UTC (no February 30, no hour 24), with or without milliseconds", () => {
  for (const ok of ["2026-11-10T20:00:00Z", "2026-11-10T20:00:00.000Z", "2028-02-29T23:59:59.999Z"]) assert.equal(atFits(ok), true, ok);
  for (const bad of ["2026-02-30T20:00:00Z", "2027-02-29T20:00:00Z", "2026-11-10T24:00:00Z", "2026-11-10T20:60:00Z", "2026-13-01T00:00:00Z", "2026-11-10 20:00:00", "2026-11-10T20:00:00+00:00", "2026-11-10T20:00Z"]) assert.equal(atFits(bad), false, bad);
});

// ------------------------------------------------------------------ the record's seal and the key file

test("the record's seal: a round trip with the store's key; each of the ten plain fields, a changed byte of ct or tag, another store key, a moved sealed part, or a seal with the public half alone does not open", () => {
  const store = newKeyPair();
  const rec: RecordFields = { v: 1, id: "c-0000000a", gen: 1, name: "staging", origin: ORIGIN, path: "/login", send_to: [ORIGIN], repos: null, by: "operator", approved: true };
  const plain = recordPlain(USER, PASS);
  const s = sealRecord(store, recordAd(rec), plain);
  assert.deepEqual(Object.keys(s), ["epk", "iv", "ct", "tag"]);
  assert.equal(openRecord(store, recordAd(rec), s).toString("utf8"), JSON.stringify({ username: USER, password: PASS, totp: null }));
  for (const [k, x] of [["v", 2], ["id", "c-0000000b"], ["gen", 2], ["name", "other"], ["origin", "https://login.example.com"], ["path", "/elsewhere"], ["send_to", [ORIGIN, "https://tracker.example"]], ["repos", ["example-org.site-a"]], ["by", "offer"], ["approved", false]] as const) {
    assert.throws(() => openRecord(store, recordAd({ ...rec, [k]: x }), s), `a changed ${k}`);
  }
  for (const part of ["ct", "tag"] as const) { const b = Buffer.from(s[part], "base64url"); b[0] ^= 1; assert.throws(() => openRecord(store, recordAd(rec), { ...s, [part]: b64u(b) }), `a changed byte of ${part}`); }
  assert.throws(() => openRecord(newKeyPair(), recordAd(rec), s), "another store key");
  const other = sealRecord(store, recordAd({ ...rec, id: "c-0000000b" }), plain);
  assert.throws(() => openRecord(store, recordAd(rec), other), "a sealed part moved from another record");
  // review-118 B1: only the open store key seals: a seal with the public half alone does not open.
  assert.throws(() => openRecord(store, recordAd(rec), forgeRecord(store.pub, recordAd(rec), plain)), "a seal with the public half alone");
});

test("the KDF: the bounds of C12 (scrypt, N a power of two from 2^15 to 2^18, r 8, p 1, a salt of 16 bytes), checked before any derivation; maxmem lets N = 2^18 derive", { timeout: 60_000 }, async () => {
  const salt = b64u(Buffer.alloc(16, 7));
  const good = { name: "scrypt", n: 131072, r: 8, p: 1, salt };
  assert.equal(kdfFits(good), true);
  for (const n of [32768, 65536, 262144]) assert.equal(kdfFits({ ...good, n }), true, `N ${n}`);
  for (const bad of [{ n: 16384 }, { n: 524288 }, { n: 100000 }, { n: 2 ** 30 }, { n: "131072" }, { r: 7 }, { p: 2 }, { name: "pbkdf2" }, { salt: b64u(Buffer.alloc(15)) }, { salt: b64u(Buffer.alloc(17)) }, { salt: "not base64url!" }]) {
    assert.equal(kdfFits({ ...good, ...bad }), false, JSON.stringify(bad));
    // No derivation runs: a planted N of 2^30 is refused at once.
    const t = Date.now();
    await assert.rejects(deriveKey("x", { ...good, ...bad } as any), /outside the bounds/);
    assert.ok(Date.now() - t < 200, "refused before scrypt");
  }
  assert.equal(KDF.maxmem, 257 * 1024 * 1024, "maxmem 257 MiB");
  const k = await deriveKey(PASSPHRASE, { ...good, n: 262144 } as any);
  assert.equal(k.length, 32, "N = 2^18 derives within maxmem");
  assert.equal(keyFits({ v: 1, public: "x", kdf: good, wrapped: { iv: "a", ct: "b", tag: "c" } }), true);
  assert.equal(keyFits({ v: 1, kdf: good, wrapped: { iv: "a", ct: "b", tag: "c" } }), false, "no public");
  assert.equal(keyFits({ v: 1, public: "x", kdf: good }), false, "no wrapped");
  assert.equal(keyFits({ v: 1, public: "x", kdf: good, wrapped: { iv: "a", ct: 7, tag: "c" } }), false, "a wrapped part that is not text");
});

test("the set-up: key.json with v 1, the public half, scrypt with N 2^17, r 8, p 1 and a new salt of 16 bytes, and the wrapped private half that the passphrase opens; a changed public half or KDF value does not open", { timeout: 60_000 }, async () => {
  const w = world({ kdfN: KDF.n });
  try {
    const key = await setUp(w);
    assert.deepEqual(Object.keys(key), ["v", "public", "kdf", "wrapped"]);
    assert.equal(key.v, 1);
    assert.deepEqual({ ...key.kdf, salt: undefined }, { name: "scrypt", n: 131072, r: 8, p: 1, salt: undefined });
    assert.equal(Buffer.from(key.kdf.salt, "base64url").length, 16);
    assert.deepEqual(Object.keys(key.wrapped), ["iv", "ct", "tag"]);
    const secret = unwrapKey(key, await deriveKey(PASSPHRASE, key.kdf));
    assert.equal(b64u(publicRaw(privateKeyOf(secret))), key.public, "the public half of the wrapped private half");
    await assert.rejects(async () => unwrapKey(key, await deriveKey(WRONG, key.kdf)), "a wrong passphrase");
    await assert.rejects(async () => unwrapKey({ ...key, public: b64u(newKeyPair().pub) }, await deriveKey(PASSPHRASE, key.kdf)), "a replaced public half");
    const kek = await deriveKey(PASSPHRASE, key.kdf);
    assert.throws(() => unwrapKey({ ...key, kdf: { ...key.kdf, n: 65536 } }, kek), "a changed KDF value");
    // Another set-up of another store has another key and another salt.
    const w2 = world({ kdfN: KDF.n });
    try { const k2 = await setUp(w2); assert.notEqual(k2.public, key.public); assert.notEqual(k2.kdf.salt, key.kdf.salt); } finally { w2.close(); }
  } finally { w.close(); }
});

// ------------------------------------------------------------------ the state, the lock and the unlock

test("the lock: none at the start and before a snapshot, locked with a key, open after the set-up and the unlock; the lock and a snapshot with no key or another public half drop the open key; a new start is locked with a new pane key", { timeout: 60_000 }, async () => {
  const w = world();
  try {
    assert.equal(w.part.store.state(), "none");
    assert.deepEqual(await w.ask("sign_ins_lock"), { data: {} }, "a lock answers {} before a snapshot");
    const key = await setUp(w);
    assert.equal(w.part.store.state(), "open");
    assert.equal(w.part.store.holdsOpenKey(), true);
    assert.deepEqual(await w.ask("sign_ins_lock"), { data: {} });
    assert.equal(w.part.store.state(), "locked");
    assert.equal(w.part.store.holdsOpenKey(), false, "no open key after a lock (the test hook)");
    assert.deepEqual(await w.ask("sign_ins_unlock", { sealed: passSeal(w, "sign_ins_unlock", { passphrase: PASSPHRASE }) }), { data: {} });
    assert.equal(w.part.store.state(), "open");
    assert.deepEqual(await w.ask("sign_ins", { key: { ...key, public: b64u(newKeyPair().pub) }, records: [] }), { data: { records: 0 } });
    assert.equal(w.part.store.holdsOpenKey(), false, "another public half in key.json locks");
    assert.deepEqual(await w.ask("sign_ins", { key, records: [] }), { data: { records: 0 } });
    assert.equal(w.part.store.state(), "locked", "the file's public half opens nothing by itself");
    assert.deepEqual(await w.ask("sign_ins_unlock", { sealed: passSeal(w, "sign_ins_unlock", { passphrase: PASSPHRASE }) }), { data: {} });
    assert.deepEqual(await w.ask("sign_ins", { key: null, records: [] }), { data: { records: 0 } });
    assert.equal(w.part.store.state(), "none", "no key.json: none, and no open key");
    assert.equal(w.part.store.holdsOpenKey(), false);
    assert.deepEqual(w.events.map((e) => e.state), ["open", "locked", "open", "locked", "open", "none"], "a sign_ins event at each change of the state");
    assert.ok(w.events.every((e) => e.t === "ev" && e.ev === "sign_ins" && e.pane_key === paneKey(w) && Object.keys(e).length === 4));
    // A new start of the service (the same state folder): locked, with a new pane key.
    const again = world({ dir: w.dir });
    try {
      assert.notEqual(paneKey(again), paneKey(w), "a new pane key at each start");
      await again.ask("sign_ins", { key, records: [] });
      assert.equal(again.part.store.state(), "locked");
      const old = passSeal(w, "sign_ins_unlock", { passphrase: PASSPHRASE });
      assert.deepEqual(await again.ask("sign_ins_unlock", { sealed: old }), { error: TEXT.sealed }, "a seal to the older pane key does not open");
    } finally { again.part.stop(); }
  } finally { w.close(); }
});

test("the passphrase: fewer than 16 characters at the set-up and the rekey (the new one's length before the old one), a wrong one 2 s after the request, and one set-up, unlock or rekey at a time", { timeout: 60_000 }, async () => {
  const w = world();
  try {
    await w.ask("sign_ins", { key: null, records: [] });
    assert.deepEqual(await w.ask("sign_ins_setup", { sealed: passSeal(w, "sign_ins_setup", { passphrase: SHORT }) }), { error: TEXT.shortPassphrase });
    assert.deepEqual(await w.ask("sign_ins_setup", { sealed: passSeal(w, "sign_ins_setup", { passphrase: "fifteen chars.." }) }), { error: TEXT.shortPassphrase }, "15 characters");
    const key = (await w.ask("sign_ins_setup", { sealed: passSeal(w, "sign_ins_setup", { passphrase: "sixteen chars..." }) })).data.key;
    assert.ok(key, "16 characters");
    await w.ask("sign_ins", { key, records: [] });
    assert.deepEqual(await w.ask("sign_ins_rekey", { sealed: passSeal(w, "sign_ins_rekey", { old: WRONG, new: SHORT }) }), { error: TEXT.shortPassphrase }, "the new one's length first");
    const t = Date.now();
    assert.deepEqual(await w.ask("sign_ins_rekey", { sealed: passSeal(w, "sign_ins_rekey", { old: WRONG, new: NEW_PASSPHRASE }) }), { error: TEXT.wrongPassphrase });
    assert.ok(Date.now() - t >= 1990, "2 s after the request");
    await w.ask("sign_ins_lock");
    // Two unlocks with a wrong passphrase at once: one at a time, so the second answers 2 s after the first.
    const t2 = Date.now();
    const a = w.ask("sign_ins_unlock", { sealed: passSeal(w, "sign_ins_unlock", { passphrase: WRONG }) }).then((x) => ({ x, t: Date.now() - t2 }));
    const b = w.ask("sign_ins_unlock", { sealed: passSeal(w, "sign_ins_unlock", { passphrase: WRONG }) }).then((x) => ({ x, t: Date.now() - t2 }));
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual([ra.x, rb.x], [{ error: TEXT.wrongPassphrase }, { error: TEXT.wrongPassphrase }]);
    assert.ok(ra.t >= 1990 && rb.t >= 3980, `one at a time: ${ra.t} ms and ${rb.t} ms`);
    assert.equal(w.part.store.state(), "locked");
    assert.deepEqual(await w.ask("sign_ins_unlock", { sealed: passSeal(w, "sign_ins_unlock", { passphrase: "sixteen chars..." }) }), { data: {} });
    // The rekey: the same key pair, a new salt and a new wrap; the new passphrase opens it, the old one does not.
    const re = (await w.ask("sign_ins_rekey", { sealed: passSeal(w, "sign_ins_rekey", { old: "sixteen chars...", new: NEW_PASSPHRASE }) })).data.key;
    assert.equal(re.public, key.public);
    assert.notEqual(re.kdf.salt, key.kdf.salt);
    assert.equal(b64u(publicRaw(privateKeyOf(unwrapKey(re, await deriveKey(NEW_PASSPHRASE, re.kdf))))), key.public);
    await assert.rejects(async () => unwrapKey(re, await deriveKey("sixteen chars...", re.kdf)));
    assert.equal(w.part.store.state(), "open", "a rekey keeps the store open");
  } finally { w.close(); }
});

test("the pane's seal in the store: a replayed rid, an at more than 120 s from the clock (before or after), a rid or an at of the wrong form, an at that is no real time, another binding and a payload of another shape each get the one text", { timeout: 60_000 }, async () => {
  const w = world();
  try {
    await setUp(w);
    const rid = "UmVwbGF5ZWRSaWRUZXN0MQ";
    assert.equal((await w.ask("sign_in_seal", sealReq(w, REC, false, undefined, { rid }))).data.record.gen, 1);
    const cases: [string, any][] = [
      ["a replayed rid", sealReq(w, REC, false, undefined, { rid })],
      ["121 s old", sealReq(w, REC, false, undefined, { at: new Date(T0 - 121_000).toISOString() })],
      ["121 s ahead", sealReq(w, REC, false, undefined, { at: new Date(T0 + 121_000).toISOString() })],
      ["a short rid", sealReq(w, REC, false, undefined, { rid: "c2hvcnQ" })],
      ["a rid of another alphabet", sealReq(w, REC, false, undefined, { rid: "QUJDREVGR0hJSktMTU5PUFFS+w" })],
      ["an at with no Z", sealReq(w, REC, false, undefined, { at: "2026-11-10T20:00:00" })],
      ["February 30", sealReq(w, REC, false, undefined, { at: "2026-02-30T20:00:00Z" })],
      ["the payload of another op", sealReq(w, REC, false, { passphrase: PASSPHRASE })],
    ];
    const s = sealReq(w, REC);
    cases.push(["another name", { ...s, record: { ...REC, name: "staging-x" } }], ["another path", { ...s, record: { ...REC, path: "/other" } }], ["another send_to", { ...sealReq(w, REC), record: { ...REC, send_to: [ORIGIN, "https://login.example.com"] } }], ["an offer's seal", { ...sealReq(w, REC, true), offer: false }]);
    for (const [what, fields] of cases) assert.deepEqual(await w.ask("sign_in_seal", fields), { error: TEXT.sealed }, what);
    // An at that is no real time, whose lenient date (November 31 is December 1) is the clock's time: refused for its form.
    const clock = w.clock.t;
    w.clock.t = Date.parse("2026-12-01T20:00:00Z");
    assert.deepEqual(await w.ask("sign_in_seal", sealReq(w, REC, false, undefined, { at: "2026-11-31T20:00:00Z" })), { error: TEXT.sealed }, "November 31");
    assert.ok((await w.ask("sign_in_seal", sealReq(w, REC, false, undefined, { at: "2026-12-01T20:00:00Z" }))).data, "the same time, written as a real time");
    w.clock.t = clock;
    // 120 s exactly still opens; the rid of a refused seal is spent, and after 120 s a rid can come again.
    assert.ok((await w.ask("sign_in_seal", sealReq(w, REC, false, undefined, { at: new Date(T0 - 120_000).toISOString() }))).data);
    w.clock.t += 121_000;
    assert.ok((await w.ask("sign_in_seal", sealReq(w, REC, false, undefined, { rid }))).data, "a rid older than 120 s");
  } finally { w.close(); }
});

test("review-118 B2: the service keeps a seal's rid until that seal can no longer open: a seal whose at is 60 s ahead, opened at the clock, does not open again at the clock + 121 s", { timeout: 60_000 }, async () => {
  const w = world();
  try {
    await setUp(w);
    await w.ask("sign_ins_lock");
    const ahead = passSeal(w, "sign_ins_unlock", { passphrase: PASSPHRASE }, { at: new Date(T0 + 60_000).toISOString() });
    assert.deepEqual(await w.ask("sign_ins_unlock", { sealed: ahead }), { data: {} });
    await w.ask("sign_ins_lock");
    w.clock.t = T0 + 121_000;
    assert.deepEqual(await w.ask("sign_ins_unlock", { sealed: ahead }), { error: TEXT.sealed }, "the same line at the clock + 121 s");
    assert.equal(w.part.store.state(), "locked");
    w.clock.t = T0 + 179_000;
    assert.deepEqual(await w.ask("sign_ins_unlock", { sealed: ahead }), { error: TEXT.sealed }, "the same line at the clock + 179 s (its at is 119 s in the past)");
    // A seal whose at is 130 s ahead is refused for its time and its rid is not taken: it opens once when its time comes.
    w.clock.t = T0;
    const early = passSeal(w, "sign_ins_unlock", { passphrase: PASSPHRASE }, { at: new Date(T0 + 130_000).toISOString() });
    assert.deepEqual(await w.ask("sign_ins_unlock", { sealed: early }), { error: TEXT.sealed }, "130 s ahead");
    w.clock.t = T0 + 20_000;
    assert.deepEqual(await w.ask("sign_ins_unlock", { sealed: early }), { data: {} }, "within 120 s: it opens once");
    await w.ask("sign_ins_lock");
    w.clock.t = T0 + 200_000;
    assert.deepEqual(await w.ask("sign_ins_unlock", { sealed: early }), { error: TEXT.sealed }, "and not again");
  } finally { w.close(); }
});

test("review-118 notes 3 and 4: a lock that comes during the derivation of a set-up, an unlock or a rekey wins; a set-up and an unlock check the last snapshot again after their derivation; each answers C12's text", { timeout: 60_000 }, async () => {
  const w = world();
  const req = (op: string, fields: Record<string, unknown> = {}) => ({ t: "req", id: `y${++ids}`, op, by: op === "sign_ins" ? DAEMON : OP, ...fields }) as Req;
  const tick = () => new Promise((r) => setImmediate(r));
  try {
    await w.ask("sign_ins", { key: null, records: [] });
    // A lock during the set-up: the set-up answers its key (the daemon writes it), and the store stays closed.
    const setup = w.part.ops.sign_ins_setup(req("sign_ins_setup", { sealed: passSeal(w, "sign_ins_setup", { passphrase: PASSPHRASE }) }));
    await tick();
    assert.deepEqual(await w.part.ops.sign_ins_lock(req("sign_ins_lock")), { data: {} });
    const s1 = await setup as any;
    assert.ok(s1.data?.key, JSON.stringify(s1));
    assert.equal(w.part.store.holdsOpenKey(), false, "the lock won");
    const key = s1.data.key;
    await w.ask("sign_ins", { key, records: [] });
    assert.equal(w.part.store.state(), "locked");
    // A lock during the unlock: the unlock answers the store is locked.
    const unlock = w.part.ops.sign_ins_unlock(req("sign_ins_unlock", { sealed: passSeal(w, "sign_ins_unlock", { passphrase: PASSPHRASE }) }));
    await tick();
    await w.part.ops.sign_ins_lock(req("sign_ins_lock"));
    assert.deepEqual(await unlock, { error: TEXT.locked });
    assert.equal(w.part.store.state(), "locked");
    // A snapshot with no key, or with another public half, during the unlock.
    const u2 = w.part.ops.sign_ins_unlock(req("sign_ins_unlock", { sealed: passSeal(w, "sign_ins_unlock", { passphrase: PASSPHRASE }) }));
    await tick();
    await w.part.ops.sign_ins(req("sign_ins", { key: null, records: [] }));
    assert.deepEqual(await u2, { error: TEXT.notSetUp });
    await w.ask("sign_ins", { key, records: [] });
    const u3 = w.part.ops.sign_ins_unlock(req("sign_ins_unlock", { sealed: passSeal(w, "sign_ins_unlock", { passphrase: PASSPHRASE }) }));
    await tick();
    await w.part.ops.sign_ins(req("sign_ins", { key: { ...key, public: b64u(newKeyPair().pub) }, records: [] }));
    assert.deepEqual(await u3, { error: TEXT.locked });
    assert.equal(w.part.store.state(), "locked");
    assert.ok(!w.logs.includes("sign-ins: the store is open"), "no unlock logged the store open");
    // A rekey and a lock: the rekey gives no key.
    await w.ask("sign_ins", { key, records: [] });
    assert.deepEqual(await w.ask("sign_ins_unlock", { sealed: passSeal(w, "sign_ins_unlock", { passphrase: PASSPHRASE }) }), { data: {} });
    const rekey = w.part.ops.sign_ins_rekey(req("sign_ins_rekey", { sealed: passSeal(w, "sign_ins_rekey", { old: PASSPHRASE, new: NEW_PASSPHRASE }) }));
    await tick();
    await w.part.ops.sign_ins_lock(req("sign_ins_lock"));
    assert.deepEqual(await rekey, { error: TEXT.locked });
    // A set-up while a key.json comes: the set-up gives no key.
    const w2 = world();
    try {
      await w2.ask("sign_ins", { key: null, records: [] });
      const s2 = w2.part.ops.sign_ins_setup(req("sign_ins_setup", { sealed: passSeal(w2, "sign_ins_setup", { passphrase: PASSPHRASE }) }));
      await tick();
      await w2.part.ops.sign_ins(req("sign_ins", { key, records: [] }));
      assert.deepEqual(await s2, { error: TEXT.setUp });
      assert.equal(w2.part.store.holdsOpenKey(), false);
    } finally { w2.close(); }
  } finally { w.close(); }
});

test("review-118 notes 5, 7, 8 and 9: a seal with no padding opens; an unknown record field on an op that takes none is ignored; a path outside printable ASCII breaks the rule of path; a key with v 2 is not valid, and a wrap with another IV length does not open", { timeout: 60_000 }, async () => {
  const w = world();
  try {
    const key = await setUp(w);
    await w.ask("sign_ins_lock");
    const plain = paneSeal(paneKey(w), { passphrase: PASSPHRASE }, { op: "sign_ins_unlock" }, { at: at(w), pad: false });
    assert.deepEqual(await w.ask("sign_ins_unlock", { sealed: plain }), { data: {} }, "the service does not check the padding");
    assert.deepEqual(await w.ask("sign_ins_lock", { record: {} }), { data: {} }, "a field that the op does not take");
    assert.deepEqual(await w.ask("sign_ins_unlock", { record: { id: "x" }, sealed: passSeal(w, "sign_ins_unlock", { passphrase: PASSPHRASE }) }), { data: {} });
    const a = await w.ask("sign_in_seal", sealReq(w, REC));
    await w.ask("sign_ins", { key, records: [fileOf(a)] });
    assert.deepEqual(await w.ask("sign_in_reseal", { record: { ...REC, path: "/lögin" } }), { error: TEXT.record("path") });
    assert.deepEqual(await w.ask("sign_in_seal", sealReq(w, { ...REC, path: "/" })), { error: TEXT.record("path") });
    assert.equal(keyFits({ ...key, v: 2 }), false);
    await w.ask("sign_ins_lock");
    await w.ask("sign_ins", { key: { ...key, v: 2 }, records: [] });
    assert.deepEqual(await w.ask("sign_ins_unlock", { sealed: passSeal(w, "sign_ins_unlock", { passphrase: PASSPHRASE }) }), { error: TEXT.keyFile });
    const kek = await deriveKey(PASSPHRASE, key.kdf);
    assert.ok(unwrapKey(key, kek).length === 32);
    // A wrap that a program made with an IV of 8 bytes and the right key: only the IV's length refuses it.
    const secret = unwrapKey(key, kek);
    const iv8 = Buffer.alloc(8, 5);
    const c = createCipheriv("aes-256-gcm", kek, iv8);
    c.setAAD(Buffer.from(JSON.stringify(["agentwatch-browser-sign-ins-key-v1", 1, key.public, key.kdf.name, key.kdf.n, key.kdf.r, key.kdf.p, key.kdf.salt])));
    const ct = Buffer.concat([c.update(secret), c.final()]);
    assert.throws(() => unwrapKey({ ...key, wrapped: { iv: b64u(iv8), ct: b64u(ct), tag: b64u(c.getAuthTag()) } }, kek), "an IV of 8 bytes");
  } finally { w.close(); }
});

// ------------------------------------------------------------------ the ops of the records

test("sign_in_seal and sign_in_reseal: v 1, gen + 1, repos null, by and approved; the answer's record opens with the store's key; an offer is by offer, approved false and send_to [origin] whatever the request holds; the approval keeps by and seals approved true", { timeout: 60_000 }, async () => {
  const w = world();
  try {
    const key = await setUp(w);
    const kek = await deriveKey(PASSPHRASE, key.kdf);
    const secret = unwrapKey(key, kek);
    const open = { key: privateKeyOf(secret), pub: publicRaw(privateKeyOf(secret)) };
    const a = await w.ask("sign_in_seal", sealReq(w, { ...REC, send_to: [ORIGIN, "https://login.staging.example.com"] }));
    assert.deepEqual(a.data.record, { v: 1, id: REC.id, gen: 1, name: "staging", origin: ORIGIN, path: "/login", send_to: [ORIGIN, "https://login.staging.example.com"], repos: null, by: "operator", approved: true });
    assert.deepEqual(JSON.parse(openRecord(open, recordAd(a.data.record), a.data.sealed).toString()), { username: USER, password: PASS, totp: null });
    // The offer (Q3 b): whatever the request holds.
    const offerRec = { id: "c-0000000b", name: "staging", origin: ORIGIN, path: "/login", send_to: [ORIGIN, "https://tracker.example"], approved: true, by: "operator", repos: ["example-org.site-a"] } as any;
    const o = await w.ask("sign_in_seal", { ...sealReq(w, offerRec, true) }, TOKEN);
    assert.deepEqual(o.data.record, { v: 1, id: "c-0000000b", gen: 1, name: "staging", origin: ORIGIN, path: "/login", send_to: [ORIGIN], repos: null, by: "offer", approved: false });
    assert.ok(openRecord(open, recordAd(o.data.record), o.data.sealed));
    await w.ask("sign_ins", { key, records: [fileOf(a), fileOf(o)] });
    // An offered record that a program marked usable on disk, or approved, opens for no act: approved is in the seal.
    assert.deepEqual(w.part.store.openForUse(fileOf(o, { state: "usable" })), { refused: "cannot_open" });
    assert.deepEqual(w.part.store.openForUse(fileOf(o, { approved: true })), { refused: "cannot_open" });
    const use = w.part.store.openForUse(fileOf(a));
    assert.ok("username" in use && use.username.toString() === USER && use.password.toString() === PASS, "the act gets the values in buffers");
    // The approval (sign_in_reseal): by stays offer, approved true, gen 2.
    const ap = await w.ask("sign_in_reseal", { record: { id: "c-0000000b", name: "staging-2", origin: ORIGIN, path: "/login", send_to: [ORIGIN] } });
    assert.deepEqual(ap.data.record, { v: 1, id: "c-0000000b", gen: 2, name: "staging-2", origin: ORIGIN, path: "/login", send_to: [ORIGIN], repos: null, by: "offer", approved: true });
    await w.ask("sign_ins", { key, records: [fileOf(a), fileOf(ap)] });
    const used = w.part.store.openForUse(fileOf(ap));
    assert.ok("password" in used && used.password.toString() === PASS, "the approved offer opens for an act");
    assert.deepEqual(JSON.parse(openRecord(open, recordAd(ap.data.record), ap.data.sealed).toString()), { username: USER, password: PASS, totp: null }, "the reseal keeps the values");
    // The checks of the reseal: no such id, another origin, a record that does not open, a name in use.
    assert.deepEqual(await w.ask("sign_in_reseal", { record: { ...REC, id: "c-99999999" } }), { error: TEXT.noSuchId });
    assert.deepEqual(await w.ask("sign_in_reseal", { record: { ...REC, origin: "https://login.example.com", send_to: ["https://login.example.com"] } }), { error: TEXT.origin });
    assert.deepEqual(await w.ask("sign_in_reseal", { record: { ...REC, name: "staging-2" } }), { error: TEXT.nameTaken });
    for (const [what, bad] of [["an added repo", { repos: ["example-org.site-b"] }], ["another path", { path: "/phish" }], ["an added origin", { send_to: [ORIGIN, "https://tracker.example"] }], ["approved false", { approved: false }], ["by offer", { by: "offer" }], ["a moved sealed part", { sealed: o.data.sealed }], ["a changed ct", { sealed: { ...a.data.sealed, ct: b64u(Buffer.from(a.data.sealed.ct, "base64url").map((x: number, i: number) => (i ? x : x ^ 1))) } }], ["gen as text", { gen: "1" }], ["no repos", { repos: undefined }]] as const) {
      await w.ask("sign_ins", { key, records: [fileOf(a, bad), fileOf(ap)] });
      assert.deepEqual(await w.ask("sign_in_reseal", { record: REC }), { error: TEXT.cannotOpen }, what);
      assert.deepEqual(w.part.store.openForUse(fileOf(a, bad)), { refused: "cannot_open" }, `${what}: no act opens it`);
      // A bad record breaks only itself.
      assert.ok("password" in w.part.store.openForUse(fileOf(ap)), `${what}: the other record still opens`);
    }
  } finally { w.close(); }
});

test("review-118 B1: a record that a program seals with key.json's public half alone opens for no act and no reseal: the review's case (approved true, its own send_to), an agent's own offer sealed again with approved true, and a planted record of the same name", { timeout: 60_000 }, async () => {
  const w = world();
  try {
    const key = await setUp(w);
    const pub = Buffer.from(key.public, "base64url");
    const a = await w.ask("sign_in_seal", sealReq(w, REC));
    const o = await w.ask("sign_in_seal", sealReq(w, { ...REC, id: "c-0000000b" }, true), TOKEN);
    const plain = recordPlain("agent.user@attacker.example.test", "agent-pass-test-value");
    // The review's case: a new record with approved true and an origin of the program in send_to.
    const forged: RecordFields = { v: 1, id: "c-0badc0de", gen: 1, name: "staging2", origin: ORIGIN, path: "/login", send_to: [ORIGIN, "https://attacker.example"], repos: null, by: "operator", approved: true };
    const file = { ...forged, state: "usable", added: null, changed: null, sealed: forgeRecord(pub, recordAd(forged), plain) };
    // The variants: the agent's own offer sealed again with approved true (it knows the values), and a planted "staging".
    const offerAgain: RecordFields = { ...o.data.record, gen: 2, approved: true };
    const offerFile = { ...offerAgain, state: "usable", added: null, changed: null, sealed: forgeRecord(pub, recordAd(offerAgain), recordPlain(USER, PASS)) };
    const planted: RecordFields = { ...a.data.record };
    const plantedFile = { ...planted, state: "usable", added: null, changed: null, sealed: forgeRecord(pub, recordAd(planted), plain) };
    await w.ask("sign_ins", { key, records: [file, offerFile, plantedFile] });
    for (const [what, f] of [["the review's case", file], ["the offer sealed again", offerFile], ["a planted staging", plantedFile]] as const) {
      assert.deepEqual(w.part.store.openForUse(f), { refused: "cannot_open" }, what);
      assert.deepEqual(await w.ask("sign_in_reseal", { record: { id: f.id, name: `${f.name}-x`, origin: f.origin, path: f.path, send_to: [f.origin] } }), { error: TEXT.cannotOpen }, `${what}: no reseal`);
    }
    // The service's own seals still open.
    await w.ask("sign_ins", { key, records: [fileOf(a), fileOf(o)] });
    assert.ok("password" in w.part.store.openForUse(fileOf(a)));
  } finally { w.close(); }
});

test("the seal's key: the service seals with the public half that it derives from its open key, never key.json's (also before the daemon's snapshot); it seals only while the store is open", { timeout: 60_000 }, async () => {
  const w = world();
  try {
    await w.ask("sign_ins", { key: null, records: [] });
    assert.deepEqual(await w.ask("sign_in_seal", sealReq(w, REC)), { error: TEXT.notSetUp });
    const key = (await w.ask("sign_ins_setup", { sealed: passSeal(w, "sign_ins_setup", { passphrase: PASSPHRASE }) })).data.key;
    // Before the daemon's snapshot with the new key.json: the open key seals.
    const a = await w.ask("sign_in_seal", sealReq(w, REC));
    const secret = unwrapKey(key, await deriveKey(PASSPHRASE, key.kdf));
    assert.ok(openRecord({ key: privateKeyOf(secret), pub: publicRaw(privateKeyOf(secret)) }, recordAd(a.data.record), a.data.sealed), "sealed to the store key");
    // A key.json whose public half a program replaced: the store locks, and nothing is sealed to that half.
    const planted = newKeyPair();
    await w.ask("sign_ins", { key: { ...key, public: b64u(planted.pub) }, records: [] });
    assert.deepEqual(await w.ask("sign_in_seal", sealReq(w, { ...REC, id: "c-0000000c" })), { error: TEXT.locked });
    assert.deepEqual(await w.ask("sign_in_reseal", { record: REC }), { error: TEXT.locked });
  } finally { w.close(); }
});

test("names and ids: a name is unique among the approved records; an offer needs an id that the service never saw (the last snapshot's, or one that it sealed since: open point 10 of PR #112); a removed id is refused", { timeout: 60_000 }, async () => {
  const w = world();
  try {
    const key = await setUp(w);
    const a = await w.ask("sign_in_seal", sealReq(w, REC));
    // An offer with the id that the service just sealed, before any snapshot holds it.
    assert.deepEqual(await w.ask("sign_in_seal", sealReq(w, { ...REC, name: "staging-o" }, true), TOKEN), { error: TEXT.offerId });
    const o = await w.ask("sign_in_seal", sealReq(w, { ...REC, id: "c-0000000b" }, true), TOKEN);
    assert.equal(o.data.record.name, "staging", "an offer can have the name of a credential");
    await w.ask("sign_ins", { key, records: [fileOf(a), fileOf(o)] });
    assert.deepEqual(await w.ask("sign_in_seal", sealReq(w, { ...REC, id: "c-0000000d" })), { error: TEXT.nameTaken }, "a new id with an approved name");
    assert.deepEqual(await w.ask("sign_in_seal", sealReq(w, { ...REC, id: "c-0000000b" }, true), TOKEN), { error: TEXT.offerId }, "an offer with the id of the snapshot's offer");
    assert.equal((await w.ask("sign_in_seal", sealReq(w, REC))).data.record.gen, 2, "a new seal of a credential: gen + 1");
    await w.ask("sign_ins", { key, records: [fileOf(o)] });
    assert.deepEqual(await w.ask("sign_in_seal", sealReq(w, REC)), { error: TEXT.removed });
    assert.deepEqual(await w.ask("sign_in_seal", sealReq(w, REC, true), TOKEN), { error: TEXT.removed }, "an offer with a removed id: removed first");
    assert.ok(w.logs.some((l) => l === "sign-ins: sealed c-0000000a staging") && w.logs.some((l) => l === "sign-ins: sealed c-0000000b staging (an offer)"), w.logs.join("\n"));
  } finally { w.close(); }
});

test("the generation and the removed ids: an old copy does not open, a removed id does not open when its file comes back, a record that breaks its shape removes nothing; the state file keeps them over a new start, as ids and numbers only", { timeout: 60_000 }, async () => {
  const w = world();
  try {
    const key = await setUp(w);
    const g1 = await w.ask("sign_in_seal", sealReq(w, REC));
    await w.ask("sign_ins", { key, records: [fileOf(g1)] });
    const g2 = await w.ask("sign_in_reseal", { record: { ...REC, path: "/login2" } });
    assert.equal(g2.data.record.gen, 2);
    await w.ask("sign_ins", { key, records: [fileOf(g1)] });
    assert.deepEqual(await w.ask("sign_in_reseal", { record: REC }), { error: TEXT.cannotOpen }, "the old copy (gen 1 after gen 2)");
    assert.deepEqual(w.part.store.openForUse(fileOf(g1)), { refused: "cannot_open" });
    await w.ask("sign_ins", { key, records: [fileOf(g2)] });
    assert.ok("password" in w.part.store.openForUse(fileOf(g2)));
    // A record that breaks its shape for one snapshot keeps its id.
    await w.ask("sign_ins", { key, records: [fileOf(g2, { gen: "2" })] });
    await w.ask("sign_ins", { key, records: [fileOf(g2)] });
    assert.ok("password" in w.part.store.openForUse(fileOf(g2)), "not removed");
    // Removed, then back.
    await w.ask("sign_ins", { key, records: [] });
    await w.ask("sign_ins", { key, records: [fileOf(g2)] });
    assert.deepEqual(w.part.store.openForUse(fileOf(g2)), { refused: "cannot_open" }, "a removed id does not open");
    const file = readFileSync(join(w.dir, "state", STATE_FILE), "utf8");
    assert.deepEqual(JSON.parse(file), { v: 1, highest: { [REC.id]: 2 }, removed: [REC.id], credentials: {} });
    assert.ok(!holdsCanary(file) && !file.includes(key.wrapped.ct) && !file.includes(g2.data.sealed.ct) && !file.includes("staging"), "no secret, no seal, no name");
    assert.equal(statSync(join(w.dir, "state", STATE_FILE)).mode & 0o777, 0o600);
    assert.equal(statSync(join(w.dir, "state")).mode & 0o777, 0o700);
    // A new start reads its file: the removed id and the highest gen stay.
    w.part.stop();
    const again = world({ dir: w.dir });
    try {
      await again.ask("sign_ins", { key, records: [fileOf(g1), fileOf(g2, { id: "c-0000000e" })] });
      await again.ask("sign_ins_unlock", { sealed: passSeal(again, "sign_ins_unlock", { passphrase: PASSPHRASE }) });
      assert.deepEqual(again.part.store.openForUse(fileOf(g1)), { refused: "cannot_open" }, "the removed id after a new start");
      assert.deepEqual(await again.ask("sign_in_seal", sealReq(again, REC)), { error: TEXT.removed });
    } finally { again.part.stop(); }
  } finally { w.close(); }
});

test("the state file: one that cannot be read counts as no file and logs its kind; a write that fails keeps the state in memory and logs its kind; neither log line holds a value", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-signins-"));
  try {
    mkdirSync(join(dir, "state"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "state", STATE_FILE), "{not json");
    const w = world({ dir });
    assert.deepEqual(w.logs, ["sign-ins: the state file cannot be read (SyntaxError); the service starts with no gen and no removed id"]);
    const key = await setUp(w);
    // A folder in place of the file: each write fails.
    rmSync(join(dir, "state", STATE_FILE));
    mkdirSync(join(dir, "state", STATE_FILE));
    const a = await w.ask("sign_in_seal", sealReq(w, REC));
    assert.equal(a.data.record.gen, 1);
    assert.ok(w.logs.some((l) => /^sign-ins: the state file cannot be written \((EISDIR|ENOTDIR|EEXIST|EPERM|ENOTEMPTY)\); the service keeps its state in memory$/.test(l)), w.logs.join("\n"));
    await w.ask("sign_ins", { key, records: [fileOf(a)] });
    assert.equal((await w.ask("sign_in_reseal", { record: REC })).data.record.gen, 2, "the state in memory");
    w.part.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Start again: it clears the stop and the count of failed results in a row, the hour's acts stay; a removed id is no credential, not in stopped, and refused also when its file comes back (open point 9 of PR #112)", { timeout: 60_000 }, async () => {
  const w = world();
  try {
    const key = await setUp(w);
    const a = await w.ask("sign_in_seal", sealReq(w, REC));
    const b = await w.ask("sign_in_seal", sealReq(w, { ...REC, id: "c-0000000b", name: "staging-b" }));
    await w.ask("sign_ins", { key, records: [fileOf(a), fileOf(b)] });
    const s = w.part.store;
    // The lockout guard (C11): three failed results in a row stop the credential; a signed-in result sets the count to 0.
    for (const id of [REC.id, "c-0000000b"]) {
      for (const r of ["not_accepted", "signed_in", "timeout", "second_factor"]) { s.actStarted(id); assert.equal(s.actEnded(id, r), false, r); }
      s.actStarted(id);
      assert.equal(s.actEnded(id, "not_accepted"), true, "the third in a row stops it (stopped_now)");
      assert.equal(s.limit(id), "stopped");
    }
    assert.deepEqual(s.status().stopped, [REC.id, "c-0000000b"]);
    assert.equal(s.status().acts, 10);
    assert.deepEqual(await w.ask("sign_in_start_again", { credential: REC.id }), { data: {} });
    assert.deepEqual(s.status().stopped, ["c-0000000b"]);
    assert.equal(s.limit(REC.id), null, "five acts in the hour: under the limit of 6");
    s.actStarted(REC.id);
    assert.equal(s.limit(REC.id), "hour_limit", "the hour's acts stayed");
    w.clock.t += HOUR_MS;
    assert.equal(s.limit(REC.id), null, "an hour later");
    // The removed id: no longer in stopped, and Start again refuses it, also when its file comes back.
    await w.ask("sign_ins", { key, records: [fileOf(a)] });
    assert.deepEqual(s.status().stopped, []);
    assert.deepEqual(await w.ask("sign_in_start_again", { credential: "c-0000000b" }), { error: TEXT.noSuchId });
    await w.ask("sign_ins", { key, records: [fileOf(a), fileOf(b)] });
    assert.deepEqual(s.status().stopped, [], "a removed id is never stopped");
    assert.deepEqual(await w.ask("sign_in_start_again", { credential: "c-0000000b" }), { error: TEXT.noSuchId });
    const file = JSON.parse(readFileSync(join(w.dir, "state", STATE_FILE), "utf8"));
    assert.equal(Object.hasOwn(file.credentials, "c-0000000b"), false, "its stop, count and hour's acts left the file");
    assert.deepEqual(await w.ask("sign_in_start_again", { credential: "c-99999999" }), { error: TEXT.noSuchId });
    // The state survives a new start: the stop and the hour's acts are in the file.
    s.actStarted(REC.id); s.actEnded(REC.id, "timeout"); s.actEnded(REC.id, "timeout"); s.actEnded(REC.id, "timeout");
    w.part.stop();
    const again = world({ dir: w.dir });
    try {
      again.clock.t = w.clock.t;
      await again.ask("sign_ins", { key, records: [fileOf(a)] });
      assert.deepEqual(again.part.store.status().stopped, [REC.id]);
      assert.equal(again.part.store.status().acts, 0, "acts count since the service's start");
    } finally { again.part.stop(); }
    // A stop that the file holds for a removed id (a file of an older service, or one that a program wrote): the removed id
    // is no credential, also when the last snapshot holds its file.
    writeFileSync(join(w.dir, "state", STATE_FILE), JSON.stringify({ v: 1, highest: { "c-0000000f": 1 }, removed: ["c-0000000f"], credentials: { "c-0000000f": { fails: 3, stopped: true, hour: [] } } }));
    const third = world({ dir: w.dir });
    try {
      await third.ask("sign_ins", { key, records: [fileOf(a, { id: "c-0000000f" })] });
      assert.deepEqual(third.part.store.status().stopped, [], "stopped names no removed id");
      assert.deepEqual(await third.ask("sign_in_start_again", { credential: "c-0000000f" }), { error: TEXT.noSuchId });
    } finally { third.part.stop(); }
  } finally { w.close(); }
});

test("the order of the checks: the snapshot, the state, the protections (before the pane's seal; dumpable first), the seal, then the op's own; status gives the reason, and names no name and no origin", { timeout: 60_000 }, async () => {
  const fails = new Set<string>();
  const w = world({ protections: () => protectionReason(() => fails.has("dumpable"), () => !fails.has("signal")) });
  try {
    const seal = passSeal(w, "sign_ins_setup", { passphrase: PASSPHRASE });
    for (const op of ["sign_ins_setup", "sign_ins_unlock", "sign_ins_rekey"]) assert.deepEqual(await w.ask(op, { sealed: seal }), { error: TEXT.noSnapshot }, op);
    assert.deepEqual(await w.ask("sign_in_seal", sealReq(w, REC)), { error: TEXT.noSnapshot });
    assert.deepEqual(await w.ask("sign_in_reseal", { record: REC }), { error: TEXT.noSnapshot });
    assert.deepEqual(await w.ask("sign_in_start_again", { credential: REC.id }), { error: TEXT.noSnapshot });
    assert.deepEqual(await w.ask("sign_in_seal", sealReq(w, { ...REC, path: "/a?b" })), { error: TEXT.record("path") }, "the rules of record first");
    await w.ask("sign_ins", { key: null, records: [] });
    fails.add("dumpable"); fails.add("signal");
    const bad = passSeal(w, "sign_ins_setup", { passphrase: PASSPHRASE }, { rid: "c2hvcnQ" });
    assert.deepEqual(await w.ask("sign_ins_setup", { sealed: bad }), { error: TEXT.unprotected("dumpable") }, "dumpable first, before the seal");
    assert.equal(w.part.store.status().unprotected, "dumpable");
    fails.delete("dumpable");
    assert.deepEqual(await w.ask("sign_ins_setup", { sealed: bad }), { error: TEXT.unprotected("signal") });
    assert.equal(w.part.store.status().unprotected, "signal");
    fails.delete("signal");
    assert.deepEqual(await w.ask("sign_ins_setup", { sealed: bad }), { error: TEXT.sealed });
    assert.equal(w.part.store.status().unprotected, null);
    const key = (await w.ask("sign_ins_setup", { sealed: passSeal(w, "sign_ins_setup", { passphrase: PASSPHRASE }) })).data.key;
    await w.ask("sign_ins", { key, records: [] });
    await w.ask("sign_ins_lock");
    fails.add("signal");
    assert.deepEqual(await w.ask("sign_ins_unlock", { sealed: passSeal(w, "sign_ins_unlock", { passphrase: PASSPHRASE }) }), { error: TEXT.unprotected("signal") }, "the unlock");
    assert.deepEqual(await w.ask("sign_ins_setup", { sealed: passSeal(w, "sign_ins_setup", { passphrase: PASSPHRASE }) }), { error: TEXT.setUp }, "the state before the protections");
    fails.delete("signal");
    assert.deepEqual(await w.ask("sign_ins_unlock", { sealed: passSeal(w, "sign_ins_unlock", { passphrase: PASSPHRASE }) }), { data: {} });
    const a = await w.ask("sign_in_seal", sealReq(w, REC));
    await w.ask("sign_ins", { key, records: [fileOf(a)] });
    const st = w.part.store.status();
    assert.deepEqual(Object.keys(st), ["state", "records", "acts", "pane_key", "stopped", "unprotected"]);
    assert.deepEqual(st, { state: "open", records: 1, acts: 0, pane_key: paneKey(w), stopped: [], unprotected: null });
    assert.equal(Buffer.from(st.pane_key, "base64").length, 32);
    assert.ok(!JSON.stringify(st).includes("staging"), "no name and no origin");
    assert.deepEqual(w.part.status(), { sign_ins: st });
    assert.deepEqual(w.part.features(), ["sign_ins"]);
    assert.deepEqual([...STAGE_1E1_OPS].sort(), [...SIGN_IN_OPS].sort());
  } finally { w.close(); }
});

// ------------------------------------------------------------------ the protections of the service's memory

test("the protections: the signal check needs a SIGUSR1 listener or --disable-sigusr1, and no open inspector; dumpable comes first", () => {
  assert.equal(signalHeld({ listeners: () => 0, execArgv: [], inspector: () => undefined }), false, "no listener and no flag");
  assert.equal(signalHeld({ listeners: () => 1, execArgv: [], inspector: () => undefined }), true, "the bin's listener");
  assert.equal(signalHeld({ listeners: () => 0, execArgv: ["--disable-sigusr1"], inspector: () => undefined }), true, "Node's flag");
  assert.equal(signalHeld({ listeners: () => 1, execArgv: [], inspector: () => "ws://127.0.0.1:9229/x" }), false, "an open inspector");
  const had = process.listenerCount("SIGUSR1");
  const f = () => {};
  process.on("SIGUSR1", f);
  try { assert.equal(process.listenerCount("SIGUSR1"), had + 1); assert.equal(signalHeld(), true, "this process with a listener"); }
  finally { process.off("SIGUSR1", f); }
  if (had === 0 && !process.execArgv.includes("--disable-sigusr1")) assert.equal(signalHeld(), false, "this process with none");
  assert.equal(protectionReason(() => true, () => false), "dumpable");
  assert.equal(protectionReason(() => false, () => false), "signal");
  assert.equal(protectionReason(() => false, () => true), null);
});

/** A child process that runs the non-dumpable start, prints its result, and waits for its stdin to close. */
async function protectedChild(flags: string[]): Promise<{ pid: number; out: any; uid: number; exe: string; stop: () => Promise<void> }> {
  const script = `import { nonDumpableStart } from ${JSON.stringify(join(ROOT, "src/service/signins/protect.ts"))};
    const d = await nonDumpableStart(); process.stdout.write(JSON.stringify({ failed: d.failed, dumpable: d.dumpable() }) + "\\n"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`;
  const child = spawn(process.execPath, [...flags, "--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  for (let i = 0; i < 300 && !out.includes("\n"); i++) await new Promise((r) => setTimeout(r, 20));
  const pid = child.pid!;
  let exe = "";
  try { exe = readlinkSync(`/proc/${pid}/exe`); } catch (e) { exe = (e as NodeJS.ErrnoException).code ?? "error"; }
  return { pid, out: JSON.parse(out), uid: statSync(`/proc/${pid}/status`).uid, exe, stop: async () => { child.stdin!.end(); await new Promise((r) => child.once("exit", r)); } };
}

test("the non-dumpable start: prctl(PR_SET_DUMPABLE, 0) through node:ffi makes the process's /proc files the kernel's and its memory closed to the user's other processes; without node:ffi the process stays dumpable and says so", { skip: process.platform !== "linux", timeout: 60_000 }, async () => {
  const on = await protectedChild([]);
  try {
    assert.deepEqual(on.out, { failed: null, dumpable: false });
    assert.equal(on.uid, 0, "/proc/<pid>/status belongs to root: the process is not dumpable");
    assert.equal(on.exe, "EACCES", "another process of the user cannot read its /proc/<pid>/exe");
  } finally { await on.stop(); }
  const off = await protectedChild(["--no-experimental-ffi"]);
  try {
    assert.deepEqual(off.out, { failed: "node:ffi does not load (ERR_UNKNOWN_BUILTIN_MODULE)", dumpable: true });
    assert.equal(off.uid, process.getuid!(), "a dumpable process");
  } finally { await off.stop(); }
  assert.deepEqual(await nonDumpableStart(async () => ({ failed: "no prctl on darwin" })).then((d) => [d.failed, d.dumpable()]), ["no prctl on darwin", true]);
  assert.deepEqual(await nonDumpableStart(async () => ({ prctl: () => -1 })).then((d) => [d.failed, d.dumpable()]), ["prctl(PR_SET_DUMPABLE, 0) failed", true]);
});

test("the service as a process: its start makes it non-dumpable before its doors open, and its hello has the feature sign_ins on Linux (also --hello); with node:ffi off it stays dumpable and says so", { skip: process.platform !== "linux", timeout: 90_000 }, async () => {
  assert.deepEqual(serviceFeatures("linux"), ["sign_ins"]);
  assert.deepEqual(serviceFeatures("darwin"), [], "the Mac: no store until stage 4");
  for (const [flags, protectedRun] of [[[], true], [["--no-experimental-ffi"], false]] as const) {
    const dir = mkdtempSync(join(tmpdir(), "ab-svc-sign-"));
    const sock = join(dir, "control.sock"), cdp = join(dir, "cdp.sock");
    // --test with temp folders only and a display that no harness reserves; no config comes, so no Chrome and no Xvfb start.
    const child = spawn(process.execPath, [...flags, BIN, "service", "--test", "--test-display", "186", "--agent-door", cdp, "--control-door", sock,
      "--daemon-unit", "agent-browser-test-none.service", "--daemon-command", join(dir, "daemon-command.json"),
      "--lists-folder", join(dir, "config", "browser", "lists"), "--state-folder", join(dir, "state"), "--tools-dir", join(dir, "tools")], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr!.on("data", (d) => (err += d));
    try {
      for (let i = 0; i < 1000 && !err.includes("service: ready"); i++) await new Promise((r) => setTimeout(r, 20));
      assert.match(err, /service: ready/, err);
      const lines = err.split("\n");
      if (protectedRun) {
        const at = lines.indexOf("service: the process is not dumpable (prctl PR_SET_DUMPABLE 0)");
        assert.ok(at >= 0 && at < lines.findIndex((l) => l.startsWith("control: ready on")), `before the control door opens:\n${err}`);
        assert.equal(statSync(`/proc/${child.pid}/status`).uid, 0, "the service is not dumpable");
      } else {
        assert.ok(lines.includes("service: the process stays dumpable (node:ffi does not load (ERR_UNKNOWN_BUILTIN_MODULE)), so the stored sign-ins do not open"), err);
        assert.equal(statSync(`/proc/${child.pid}/status`).uid, process.getuid!());
      }
      child.kill("SIGTERM");
      assert.equal(await new Promise((r) => child.once("exit", (c) => r(c))), 0, err);
      assert.ok(!holdsCanary(err), "no canary in the log");
    } finally { if (child.exitCode === null) child.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
  }
});

// ------------------------------------------------------------------ the replay of the vectors on the real store

/** The real store behind the control door (its shape, kind and order checks), as the service has it; the door's log too. */
async function realDoor(o: { protections?: () => Unprotected | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ab-signins-door-"));
  const logs: string[] = [];
  const part = new SignInsPart({ stateFolder: join(dir, "state"), log: (l) => logs.push(l), protections: o.protections ?? (() => null), now: () => new Date(T0), paneSecret: PANE_SECRET });
  const state = new Stage1a({ agentDoor: { url: (s) => s, state: () => ({ form: "pidfd" }) }, parts: [part] });
  const door = await ControlDoor.open({ path: join(dir, "control.sock"), admit: async () => ({ ok: true }), handler: state, log: (l) => logs.push(l) });
  const c = await daemonClient(join(dir, "control.sock"));
  const hello = await c.next();
  c.send(DAEMON_HELLO);
  return { dir, logs, part, c, hello, close: async () => { c.end(); state.stopParts(); await door.stop(); rmSync(dir, { recursive: true, force: true }); } };
}
const isObj = (x: unknown): x is Record<string, any> => x !== null && typeof x === "object" && !Array.isArray(x);
const isB64u = (x: unknown, n?: number) => typeof x === "string" && /^[A-Za-z0-9_-]+$/.test(x) && (n === undefined || Buffer.from(x, "base64url").length === n);

test("the replay: the real store answers each vector of the stored sign-ins as the vectors say (s1 to s57 in their order, the bad requests b33 to b52, the unprotected cases), with its own key and sealed parts in the later snapshots as the daemon writes them; its events are the fake's; nothing that it sends or logs holds a canary", { timeout: 180_000 }, async () => {
  const d = await realDoor();
  const sent: string[] = [];
  try {
    assert.deepEqual(d.hello.features, ["sign_ins"], "the hello's feature");
    const q1 = control.requests.find((v: any) => v.req.id === "q1");
    d.c.send({ t: "req", id: "st0", op: "status", by: DAEMON });
    assert.deepEqual((await d.c.answer("st0")).data.sign_ins, q1.res.data.sign_ins, "status before the first snapshot: q1's");
    const run = [...control.requests, ...control.badRequests].filter((v: any) => (SIGN_IN_OPS as readonly string[]).includes(v.req.op));
    assert.ok(run.length >= 77, `${run.length} lines`);
    // The daemon writes the service's own answers: its key.json and its record files go into the later snapshots.
    let key: any = null, rekeyed: any = null, opened: { key: any; pub: Buffer } | null = null;
    const sealedOf = new Map<string, any>();
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const substitute = (req: any) => {
      if (req.op !== "sign_ins") return req;
      const r = structuredClone(req);
      for (const [vec, real] of [[S.key, key], [S.rekeyed, rekeyed]]) {
        if (!real || !r.key) continue;
        if (r.key.public === vec.public) r.key.public = real.public;
        if (same(r.key.kdf, vec.kdf)) r.key.kdf = real.kdf;
        if (same(r.key.wrapped, vec.wrapped)) r.key.wrapped = real.wrapped;
      }
      if (Array.isArray(r.records)) for (const x of r.records) { const s = sealedOf.get(`${x.id}:${Number(x.gen)}`); if (isObj(x) && s) x.sealed = s; }
      return r;
    };
    for (const v of run) {
      const line = substitute(v.req);
      sent.push(JSON.stringify(line));
      d.c.send(line);
      const got = await d.c.answer(v.req.id, 30_000);
      if (v.res.ok && ["sign_ins_setup", "sign_ins_rekey"].includes(v.req.op)) {
        assert.equal(got.ok, true, `${v.req.id}: ${JSON.stringify(got)}`);
        const k = got.data.key;
        assert.deepEqual(Object.keys(got.data), ["key"]);
        assert.ok(k.v === 1 && isB64u(k.public, 32) && same({ ...k.kdf, salt: 0 }, { name: "scrypt", n: 131072, r: 8, p: 1, salt: 0 }) && isB64u(k.kdf.salt, 16) && isB64u(k.wrapped.iv, 12) && isB64u(k.wrapped.ct) && isB64u(k.wrapped.tag, 16), `${v.req.id}: the form of key.json`);
        const secret = unwrapKey(k, await deriveKey(v.req.op === "sign_ins_setup" ? PASSPHRASE : NEW_PASSPHRASE, k.kdf));
        const pk = privateKeyOf(secret);
        assert.equal(b64u(publicRaw(pk)), k.public, `${v.req.id}: the passphrase opens it`);
        if (v.req.op === "sign_ins_setup") { key = k; opened = { key: pk, pub: publicRaw(pk) }; }
        else { assert.equal(k.public, key.public, "a rekey keeps the key pair"); rekeyed = k; }
      } else if (v.res.ok && ["sign_in_seal", "sign_in_reseal"].includes(v.req.op)) {
        assert.equal(got.ok, true, `${v.req.id}: ${JSON.stringify(got)}`);
        assert.deepEqual(got.data.record, v.res.data.record, `${v.note}: the record`);
        const s = got.data.sealed;
        assert.ok(isB64u(s.epk, 32) && isB64u(s.iv, 12) && isB64u(s.ct) && isB64u(s.tag, 16), `${v.req.id}: the form of the sealed part`);
        assert.deepEqual(JSON.parse(openRecord(opened!, recordAd(got.data.record), s).toString()), { username: USER, password: PASS, totp: null }, `${v.req.id}: it opens with the store key`);
        sealedOf.set(`${got.data.record.id}:${got.data.record.gen}`, s);
      } else assert.deepEqual(got, v.res, `${v.req.id}: ${v.note}`);
    }
    await new Promise((r) => setTimeout(r, 50));
    // The fake's events (test/service-control.test.ts): each change of the store's state (s6, s25, s29, s43, s52).
    assert.deepEqual(d.c.lines.filter((l) => l.t === "ev"), ["open", "locked", "open", "locked", "none"].map((state) => ({ t: "ev", ev: "sign_ins", state, pane_key: S.pane_key })));
    d.c.send({ t: "req", id: "st1", op: "status", by: DAEMON });
    const st = (await d.c.answer("st1")).data.sign_ins;
    assert.deepEqual(st, { state: "none", records: 0, acts: 0, pane_key: S.pane_key, stopped: [], unprotected: null });
    // The scans: no canary in any line that the service sent, its log, its status or its state folder's files; no seal
    // in its log. Each scan finds its planted twin.
    const out = d.c.bytes().toString("utf8");
    const files = readdirSync(join(d.dir, "state")).map((f) => readFileSync(join(d.dir, "state", f), "utf8")).join("\n");
    const logs = d.logs.join("\n");
    for (const [what, text] of [["the answers and events", out], ["the log", logs], ["the state folder", files], ["status", JSON.stringify(st)]] as const) {
      assert.equal(holdsCanary(text), false, `${what}: no canary`);
      for (const c of control.signInScan.canaries) for (const f of FORMS(c)) assert.equal(holdsCanary(`${text}x${f}x`), true, `${what}: the scan finds ${JSON.stringify(f)}`);
    }
    const seals = [key.wrapped.ct, rekeyed.wrapped.ct, ...[...sealedOf.values()].map((s) => s.ct), ...run.filter((v: any) => v.req.sealed?.text).map((v: any) => v.req.sealed.text.slice(4, 40))];
    for (const s of seals) assert.ok(!logs.includes(s) && !files.includes(s), "no wrapped key, sealed record or pane's seal in the log or the state folder");
    assert.ok(!logs.includes("aw1:") && !/"(epk|wrapped|sealed)"/.test(logs), "no seal's form in the log");
    assert.ok(seals.some((s) => sent.join("\n").includes(s)), "the scan of seals reads lines that hold seals (its twin)");
    // The log rule: each act with its provenance (the door), and the store's lines name an id and a name only.
    assert.ok(d.logs.includes("control: sign_in_seal by operator ann via web: ok") && d.logs.includes("control: sign_ins_setup by operator ann via web: ok"), logs);
    assert.ok(d.logs.filter((l) => l.startsWith("sign-ins: ")).every((l) => /^sign-ins: (the store is (set up and open|open)|the store has a new passphrase|sealed( again)? c-[0-9a-f]{8} [A-Za-z0-9._-]+( \(an offer\))?|start again c-[0-9a-f]{8})$/.test(l)), logs);
  } finally { await d.close(); }
  // The unprotected cases, each on a new store with its failing protections (the order of protect.ts: dumpable first).
  for (const k of control.unprotected.cases) {
    const failing = new Set<string>(k.failing);
    const u = await realDoor({ protections: () => protectionReason(() => failing.has("dumpable"), () => !failing.has("signal")) });
    try {
      for (const v of k.requests) { u.c.send(v.req); assert.deepEqual(await u.c.answer(v.req.id), v.res, `${k.note}: ${v.note}`); }
      u.c.send({ t: "req", id: "st", op: "status", by: DAEMON });
      assert.deepEqual((await u.c.answer("st")).data.sign_ins, k.sign_ins, `${k.note}: status`);
      assert.equal(holdsCanary(u.logs.join("\n") + u.c.bytes().toString("utf8")), false);
    } finally { await u.close(); }
  }
});

test("the service's start: with signIns the stored sign-ins' part, its feature and its status key; without it the eight ops get unsupported and no key sign_ins (the Mac)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-signins-st-"));
  try {
    const part = new SignInsPart({ stateFolder: join(dir, "state"), log: () => {}, protections: () => null });
    const withIt = new Stage1a({ agentDoor: { url: (s) => s, state: () => ({ form: "pidfd" }) }, parts: [part] });
    assert.deepEqual((withIt.hello as any).features, ["sign_ins"]);
    assert.ok(SIGN_IN_OPS.every((op) => withIt.has(op)));
    assert.deepEqual((withIt.status() as any).sign_ins.state, "none");
    const without = new Stage1a({ agentDoor: { url: (s) => s, state: () => ({ form: "pidfd" }) } });
    assert.ok(SIGN_IN_OPS.every((op) => !without.has(op)));
    assert.equal(Object.hasOwn(without.status(), "sign_ins"), false);
    part.stop();
    assert.equal(existsSync(join(dir, "state", STATE_FILE)), false, "no file before a change");
    chmodSync(dir, 0o700);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
