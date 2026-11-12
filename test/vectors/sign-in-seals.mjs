// The pane's seals of test/vectors/control.json (contract C12, "The stored sign-ins"; board ab-v16.97.2, open point 1 of
// PR #112): each `sealed` of a request is a real seal of agentwatch's Secret box seal, screen-seal.js (sealPayload), to the
// vectors' test pane key, with the binding of its request and fixed test keys. So the real service opens them, as it
// opens the pane's seals, and the fake takes them as it takes any seal.
//
// Run from this repository's root, with the path of agentwatch's screen-seal.js (read only; nothing of agentwatch changes):
//
//   node test/vectors/sign-in-seals.mjs <agentwatch>/agentwatch/server/static/modules/screen-seal.js
//
// It rewrites control.json in place: the `sealed` of each request whose binding is text, the scripted seal texts of the
// fake (`wrong_passphrase`, `short_passphrase`, `short_rekey`, `stale_seal`), the test pane key (`pane_key` everywhere)
// and `paneSeal`, the shared vector. Every key and every value here is a TEST value, made up and named so; the
// canaries are the vectors' own (`signInScan`), and no line of the vectors holds them in plain text.

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const sealPath = process.argv[2];
if (!sealPath) { console.error("usage: node test/vectors/sign-in-seals.mjs <path of agentwatch's screen-seal.js>"); process.exit(2); }
const { sealPayload, bindingInfo } = await import(pathToFileURL(sealPath).href);

const FILE = new URL("./control.json", import.meta.url);
const v = JSON.parse(readFileSync(FILE, "utf8"));

/** 32 test bytes from a label: SHA-256 of "test, not a key: <label>". */
const testBytes = (label) => createHash("sha256").update(`test, not a key: ${label}`).digest();
const PANE_SECRET = testBytes("the pane key of the stored sign-ins' vectors");
const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), PANE_SECRET]);
const PANE_KEY = createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" }).subarray(12).toString("base64");

// The test values that the seals hold: the canaries of the scan (signInScan), so the scan proves that no line holds them.
const [USER, PASS, PASSPHRASE, NEW_PASSPHRASE, WRONG, SHORT] = [
  "canary.user@staging.example.test", "Canary-Pass-5Qv!9-x", "canary passphrase of the scan 2026",
  "canary new passphrase of the scan 2026", "wrong canary passphrase 2026", "short canary",
];
for (const c of [USER, PASS, PASSPHRASE, NEW_PASSPHRASE, WRONG, SHORT]) if (!v.signInScan.canaries.includes(c)) throw new Error(`not a canary of signInScan: ${c}`);
if (SHORT.length >= 16 || NEW_PASSPHRASE.length < 16 || PASSPHRASE.length < 16 || WRONG.length < 16) throw new Error("the passphrases' lengths");

/** The sealed object of each request, by its op, and the requests that seal other values. */
function payload(req) {
  switch (req.id) {
    case "s5": return { passphrase: SHORT };
    case "s28": return { passphrase: WRONG };
    case "s30": return { old: WRONG, new: SHORT };
    case "s31": return { old: PASSPHRASE, new: NEW_PASSPHRASE };
    // After the rekey (s31) the store's passphrase is the new one.
    case "s47": case "s49": case "s51": case "s59": return { passphrase: NEW_PASSPHRASE };
  }
  switch (req.op) {
    case "sign_ins_setup": case "sign_ins_unlock": return { passphrase: PASSPHRASE };
    case "sign_ins_rekey": return { old: PASSPHRASE, new: NEW_PASSPHRASE };
    case "sign_in_seal": return { username: USER, password: PASS };
  }
  throw new Error(`no payload for ${req.id}`);
}

/** The binding of a request (C12, the pane's seal), or null when one of its values is not text (a bad request's shape). */
function binding(req) {
  const fields = { op: req.op, rid: req.sealed.rid, at: req.sealed.at };
  if (req.op === "sign_in_seal") {
    const r = req.record;
    if (!r || typeof r !== "object" || typeof req.offer !== "boolean" || !Array.isArray(r.send_to)) return null;
    Object.assign(fields, { name: r.name, origin: r.origin, path: r.path, send_to: r.send_to.join(" "), offer: String(req.offer) });
  }
  return Object.values(fields).every((x) => typeof x === "string") ? { purpose: "browser-sign-in", fields } : null;
}

const keysOf = (id) => ({ ephemeral: new Uint8Array(testBytes(`ephemeral ${id}`)), sender: new Uint8Array(testBytes(`sender ${id}`)) });
async function reseal(req) {
  const s = req.sealed;
  if (!s || typeof s !== "object" || typeof s.rid !== "string" || typeof s.at !== "string") return false;
  const b = binding(req);
  if (!b) return false;
  const out = await sealPayload(payload(req), b, PANE_KEY, keysOf(req.id));
  s.text = out.sealed;
  s.sender = out.senderPublicB64;
  return true;
}

let n = 0;
for (const x of [...v.requests, ...v.badRequests, ...v.unprotected.cases.flatMap((c) => c.requests), ...v.busy.first, ...v.busy.pipelined]) if (await reseal(x.req)) n++;
const text = (id) => v.requests.find((x) => x.req.id === id).req.sealed.text;
// The busy case's running unlock is s28's seal itself (the vectors' wrong_passphrase), so the fake takes it as wrong too.
v.busy.pipelined.find((x) => x.req.id === "busy-5").req.sealed = { ...v.requests.find((x) => x.req.id === "s28").req.sealed };
const S = v.state.sign_ins;
S.pane_key = PANE_KEY;
S.wrong_passphrase = text("s28");
S.short_passphrase = text("s5");
S.short_rekey = text("s30");
S.stale_seal = text("s11");
for (const x of v.requests) if (x.res.ok && x.res.data?.sign_ins) x.res.data.sign_ins.pane_key = PANE_KEY;
for (const c of v.unprotected.cases) c.sign_ins.pane_key = PANE_KEY;
for (const e of v.events) if (e.ev.ev === "sign_ins") e.ev.pane_key = PANE_KEY;

// The shared vector: one seal with its binding, the binding's bytes, its test keys and its payload, for both sides' tests.
const fields = { op: "sign_in_seal", rid: "VGhlU2hhcmVkVmVjdG9yMQ", at: "2026-11-10T20:00:00Z", name: "staging", origin: "https://staging.example.com", path: "/login", send_to: "https://staging.example.com https://login.staging.example.com", offer: "false" };
const shared = { purpose: "browser-sign-in", fields };
const sharedPayload = { username: "fixture-user-not-a-secret@example.test", password: "pässwörd \"q\" \\ 😀-fixture-not-a-secret" };
const sk = keysOf("paneSeal");
const out = await sealPayload(sharedPayload, shared, PANE_KEY, sk);
v.paneSeal = {
  note: "TEST keys and values only, never a real key or secret. The test pane key: its private half is SHA-256 of \"test, not a key: the pane key of the stored sign-ins' vectors\", its public half is state.sign_ins.pane_key. Each pane's seal of the requests is a seal of agentwatch's screen-seal.js (sealPayload) to it, with the binding of its request and the test keys SHA-256 of \"test, not a key: ephemeral <request id>\" and \"test, not a key: sender <request id>\"; test/vectors/sign-in-seals.mjs writes them. vector is one seal with its binding, the binding's bytes, its test keys and its payload.",
  pane_secret_hex: PANE_SECRET.toString("hex"),
  pane_key: PANE_KEY,
  vector: {
    purpose: shared.purpose,
    fields,
    info_hex: Buffer.from(bindingInfo(shared.purpose, fields)).toString("hex"),
    ephemeral_secret_hex: Buffer.from(sk.ephemeral).toString("hex"),
    sender_secret_hex: Buffer.from(sk.sender).toString("hex"),
    payload: sharedPayload,
    sealed: out.sealed,
    sender_public_b64: out.senderPublicB64,
  },
};
writeFileSync(FILE, JSON.stringify(v, null, 1));
console.log(`sealed ${n} requests; the pane key ${PANE_KEY}`);
