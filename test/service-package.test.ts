// The agent package of the service (stage 1b part 2, board ab-v16.94.9): the pinned CRX and its check, its staged copy
// and Chrome's external extensions file, the extension IDs, and the sender package of C12's `sender`. The cases of
// agentwatch's tests/daemon/browser/test_crx.py and test_ext_id.py, ported.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCrx, crxFiles, crxHeaderId, crxManifest, extensionFile, extensionId, folderExtensionId, MAX_MANIFEST, PackageError, pinnedLastFile, prepareAgentPackage, stageCrx, unpackAgentPackage, writeExtensionFile, zipMember } from "../src/service/package/crx.ts";
import { AGENT_CRX, AGENT_CRX_SHA256, AGENT_VERSION, CHROME_EXTENSION_COMMIT, OPERATOR_BLOBS, OPERATOR_DIR, RECEIVER_ID, SENDER_ID } from "../src/service/package/pins.ts";
import { filesOf, senderData, storedZip } from "../src/service/package/sender.ts";
import { FAKE_STATE } from "../src/service/fake.ts";
import { tempDir } from "./temp-dirs.ts";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const tmp = (t: { after: (f: () => void) => void }) => { const d = tempDir("ab-pkg-"); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const REAL = readFileSync(AGENT_CRX);
const RECEIVER_KEY = crxManifest(REAL).key as string;
const SENDER_KEY = JSON.parse(readFileSync(join(OPERATOR_DIR, "manifest.json"), "utf8")).key as string;

/** A varint of protobuf. */
function varint(n: number): Buffer { const out: number[] = []; while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } out.push(n); return Buffer.from(out); }
const field = (num: number, data: Buffer) => Buffer.concat([varint(num * 8 + 2), varint(data.length), data]);
/** The 16 bytes of an extension ID (a-p letters, two for each byte). */
const idBytes = (id: string) => Buffer.from([...Array(16)].map((_, i) => ((id.charCodeAt(2 * i) - 97) << 4) | (id.charCodeAt(2 * i + 1) - 97)));
/** A CRX3 file: the header's signed data names `ids`, and the ZIP holds `manifest` (an object, or raw bytes). */
function crx(o: { ids?: string[]; manifest?: unknown; magic?: string; version?: number; cut?: boolean; files?: [string, Buffer][] } = {}): Buffer {
  const ids = o.ids ?? [RECEIVER_ID];
  const signed = Buffer.concat(ids.map((id) => field(1, idBytes(id))));
  const header = field(10000, signed);
  const m = o.manifest === undefined ? { manifest_version: 3, name: "t", version: "0.3.6", key: RECEIVER_KEY } : o.manifest;
  const zip = storedZip([["manifest.json", Buffer.isBuffer(m) ? m : Buffer.from(JSON.stringify(m))], ...(o.files ?? [])]);
  const head = Buffer.alloc(12);
  head.write(o.magic ?? "Cr24", 0, "latin1"); head.writeUInt32LE(o.version ?? 3, 4); head.writeUInt32LE(o.cut ? header.length + 999 : header.length, 8);
  return Buffer.concat([head, header, zip]);
}
function writeCrx(dir: string, data: Buffer, name = "agent.crx"): string { const p = join(dir, name); writeFileSync(p, data); return p; }
/** A Google Chrome copy under <tools>/google-chrome/<version>/opt/google/chrome/chrome. */
function copyIn(tools: string, version = "158.0.7100.1-1") {
  const root = join(tools, "google-chrome", version), binary = join(root, "opt", "google", "chrome", "chrome");
  mkdirSync(join(root, "opt", "google", "chrome"), { recursive: true });
  writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
  return { version, root, binary };
}

// ------------------------------------------------------------------ the pins and the shipped files

test("the pins name the CRX of the pinned commit: its SHA-256, its header ID and its manifest key's ID, version 0.3.14", () => {
  assert.equal(CHROME_EXTENSION_COMMIT, "a25bfa81c454337acf784a3317271016abe7dd33");
  assert.equal(AGENT_CRX_SHA256, "66e866a94cf55f2229b7a5dabf350ee761c7bd3045f13e2820b6a3ed5d349ba9");
  assert.equal(AGENT_VERSION, "0.3.14");
  assert.equal(sha(REAL), AGENT_CRX_SHA256);
  assert.equal(REAL.length, 95511);
  assert.equal(crxManifest(REAL).version, "0.3.14");
  assert.equal(crxHeaderId(REAL), RECEIVER_ID);
  assert.equal(extensionId(RECEIVER_KEY), RECEIVER_ID);
  const info = checkCrx();
  assert.deepEqual({ id: info.extensionId, version: info.version, sha256: info.sha256 }, { id: RECEIVER_ID, version: AGENT_VERSION, sha256: AGENT_CRX_SHA256 });
});

test("the fake's extension_version and each extension_version of the vectors are the pinned receiver's version (review-127 N1)", () => {
  const control = JSON.parse(readFileSync(new URL("./vectors/control.json", import.meta.url), "utf8"));
  assert.equal(FAKE_STATE.extension_version, AGENT_VERSION);
  const found: unknown[] = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) { if (k === "extension_version") found.push(v); else walk(v); }
  };
  walk(control);
  // The state, the status answer and the two ready events.
  assert.deepEqual(found, [AGENT_VERSION, AGENT_VERSION, AGENT_VERSION, AGENT_VERSION]);
});

test("each file of the shipped operator/ folder is the pinned commit's file (its git blob id), and no other file is there", () => {
  const files = filesOf(OPERATOR_DIR);
  assert.deepEqual(files.map(([n]) => n), Object.keys(OPERATOR_BLOBS).sort());
  for (const [name, data] of files) {
    const blob = createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data])).digest("hex");
    assert.equal(blob, OPERATOR_BLOBS[name], name);
  }
});

test("the IDs come from the manifest keys (C1): the receiver's and the sender's", () => {
  assert.equal(extensionId(RECEIVER_KEY), "ifhfjdmdbgbnmllffiadajepajbcdnai");
  assert.equal(extensionId(SENDER_KEY), "bpfkgknpndlpkcffmaaelkfcbpackiip");
  assert.equal(folderExtensionId(OPERATOR_DIR), SENDER_ID);
  assert.throws(() => extensionId("not base64!"), PackageError);
  assert.throws(() => extensionId("abc"), PackageError);
});

test("a folder without a usable key has no ID; a folder with a key has its ID", (t) => {
  const d = tmp(t);
  assert.equal(folderExtensionId(d), null);
  writeFileSync(join(d, "manifest.json"), "[]");
  assert.equal(folderExtensionId(d), null);
  writeFileSync(join(d, "manifest.json"), JSON.stringify({ key: "%%%" }));
  assert.equal(folderExtensionId(d), null);
  writeFileSync(join(d, "manifest.json"), JSON.stringify({ key: SENDER_KEY }));
  assert.equal(folderExtensionId(d), SENDER_ID);
});

test("no code of the service names the signing key (a .pem file) or reads a private key", () => {
  const src = fileURLToPath(new URL("../src/service/", import.meta.url));
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []);
  // Board ab-v16.97.2: the stored sign-ins' crypto builds X25519 keys from bytes in its memory (the store key, the pane
  // key, an ephemeral key) with createPrivateKey; it reads no file and names no .pem or PEM key.
  const KEYS_IN_MEMORY = join(src, "signins", "seal.ts");
  for (const f of walk(src)) {
    const text = readFileSync(f, "utf8");
    if (f === KEYS_IN_MEMORY) {
      assert.doesNotMatch(text, /agent-extension\.pem|\.pem\b|PRIVATE KEY|readFile|node:fs|format: "pem"/, f);
      assert.match(text, /createPrivateKey\(\{ key: der, format: "der", type: "pkcs8" \}\)/, "a key from bytes in memory");
    } else assert.doesNotMatch(text, /agent-extension\.pem|PRIVATE KEY|createPrivateKey/, f);
  }
});

// ------------------------------------------------------------------ the CRX check

test("a CRX with another SHA-256, another header ID or another key is refused", (t) => {
  const d = tmp(t);
  const ok = writeCrx(d, crx());
  const s = sha(readFileSync(ok));
  assert.equal(checkCrx(ok, { sha256: s }).version, "0.3.6", "the version of the CRX's own manifest (the fixture's, not the pin's)");
  assert.throws(() => checkCrx(ok), { message: "the agent extension package does not match its pinned SHA-256" });
  const other = writeCrx(d, crx({ ids: [SENDER_ID] }), "b.crx");
  assert.throws(() => checkCrx(other, { sha256: sha(readFileSync(other)) }), { message: "the agent extension package header names another extension ID" });
  const key = writeCrx(d, crx({ manifest: { version: "1.0", key: SENDER_KEY } }), "c.crx");
  assert.throws(() => checkCrx(key, { sha256: sha(readFileSync(key)) }), { message: "the manifest key of the agent extension package gives another extension ID" });
  const nokey = writeCrx(d, crx({ manifest: { version: "1.0" } }), "d.crx");
  assert.throws(() => checkCrx(nokey, { sha256: sha(readFileSync(nokey)) }), { message: "the manifest key of the agent extension package gives another extension ID" });
});

test("a manifest without a string version is refused, and a version that is no plain text too", (t) => {
  const d = tmp(t);
  for (const [m, text] of [[{ key: RECEIVER_KEY }, "has no version"], [{ key: RECEIVER_KEY, version: 3 }, "has no version"], [{ key: RECEIVER_KEY, version: "../x" }, "is not a plain version text"], [{ key: RECEIVER_KEY, version: "1..2" }, "is not a plain version text"]] as const) {
    const p = writeCrx(d, crx({ manifest: m }));
    assert.throws(() => checkCrx(p, { sha256: sha(readFileSync(p)) }), (e: Error) => e instanceof PackageError && e.message.endsWith(text), JSON.stringify(m));
  }
});

test("a file that is not a CRX3 is refused, and a missing file names its error", (t) => {
  const d = tmp(t);
  for (const data of [Buffer.from("PK\x03\x04 not a crx"), crx({ magic: "Cr23" }), crx({ version: 2 }), crx({ cut: true }), Buffer.alloc(4)]) {
    const p = writeCrx(d, data);
    assert.throws(() => checkCrx(p, { sha256: sha(data) }), (e: Error) => e instanceof PackageError && e.message.startsWith("the agent extension package is not a CRX3 file ("));
  }
  assert.throws(() => checkCrx(join(d, "none.crx")), { message: "the agent extension package cannot be read: ENOENT" });
});

test("a malformed header or manifest is refused: no id, two ids, a short id, a manifest that is not JSON or not an object, no manifest", (t) => {
  const d = tmp(t);
  const cases: Buffer[] = [crx({ ids: [] }), crx({ ids: [RECEIVER_ID, RECEIVER_ID] }), crx({ manifest: Buffer.from("{not json") }), crx({ manifest: Buffer.from("[1]") })];
  // An id of 8 bytes, not 16.
  const short = crx(); const h = field(10000, field(1, Buffer.alloc(8))); const head = Buffer.alloc(12); head.write("Cr24", 0, "latin1"); head.writeUInt32LE(3, 4); head.writeUInt32LE(h.length, 8);
  cases.push(Buffer.concat([head, h, short.subarray(12 + (short.readUInt32LE(8)))]));
  const nozip = crx(); cases.push(Buffer.concat([nozip.subarray(0, 12 + nozip.readUInt32LE(8)), storedZip([["other.json", Buffer.from("{}")]])]));
  for (const data of cases) {
    const p = writeCrx(d, data);
    assert.throws(() => checkCrx(p, { sha256: sha(data) }), (e: Error) => e instanceof PackageError && e.message.startsWith("the agent extension package is not a CRX3 file"));
  }
});

test("a valid manifest over 1 MiB is refused", (t) => {
  const d = tmp(t);
  const data = crx({ manifest: { key: RECEIVER_KEY, version: "1.0", pad: "x".repeat(MAX_MANIFEST) } });
  const p = writeCrx(d, data);
  assert.throws(() => checkCrx(p, { sha256: sha(data) }), /the manifest is too large/);
  assert.throws(() => zipMember(storedZip([["manifest.json", Buffer.alloc(MAX_MANIFEST + 1, 32)]]), "manifest.json", MAX_MANIFEST), /too large/);
});

// ------------------------------------------------------------------ the staged copy and the external extensions file

test("the CRX is staged in the tools folder at 0600 in a 0700 folder, named by its version and SHA-256", (t) => {
  const tools = tmp(t);
  const info = checkCrx();
  const p = stageCrx(info, tools);
  assert.equal(p, join(tools, "agent-crx", `0.3.14-${AGENT_CRX_SHA256.slice(0, 12)}.crx`));
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.equal(statSync(join(tools, "agent-crx")).mode & 0o777, 0o700);
  assert.equal(sha(readFileSync(p)), AGENT_CRX_SHA256);
});

test("a file changed after its check is not staged, and a version that escapes the folder is refused", (t) => {
  const d = tmp(t), tools = join(d, "tools");
  const data = crx();
  const p = writeCrx(d, data);
  const info = checkCrx(p, { sha256: sha(data) });
  writeFileSync(p, Buffer.concat([data, Buffer.from(" ")]));
  assert.throws(() => stageCrx(info, tools), { message: "the agent extension package changed after its check" });
  assert.throws(() => stageCrx({ ...checkCrx(), version: "../../x" }, tools), { message: "the version of the agent extension package is not a plain version text" });
});

test("the staging folder is private and never a symlink", (t) => {
  const d = tmp(t), tools = join(d, "tools");
  mkdirSync(tools);
  mkdirSync(join(d, "elsewhere"));
  symlinkSync(join(d, "elsewhere"), join(tools, "agent-crx"));
  assert.throws(() => stageCrx(checkCrx(), tools), { message: "agent-crx is a symlink" });
  assert.deepEqual(readdirSync(join(d, "elsewhere")), []);
});

test("the extension file goes next to the copy's binary only: extensions/<receiver ID>.json, 0644 in a 0755 folder", (t) => {
  const tools = tmp(t);
  const copy = copyIn(tools);
  const version = prepareAgentPackage(copy, tools, join(tools, "google-chrome"));
  assert.equal(version, "0.3.14");
  const file = join(tools, "google-chrome", copy.version, "opt", "google", "chrome", "extensions", `${RECEIVER_ID}.json`);
  assert.equal(extensionFile(copy), file);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { external_crx: join(tools, "agent-crx", `0.3.14-${AGENT_CRX_SHA256.slice(0, 12)}.crx`), external_version: "0.3.14" });
  assert.equal(statSync(file).mode & 0o777, 0o644);
  assert.equal(statSync(join(file, "..")).mode & 0o777, 0o755);
  // A second start writes the same file again (a new file, then a rename).
  prepareAgentPackage(copy, tools, join(tools, "google-chrome"));
  assert.deepEqual(readdirSync(join(file, "..")), [`${RECEIVER_ID}.json`]);
});

test("the file of the last start is used only while its staged CRX has the pinned SHA-256 and is in agent-crx/ (review-110 B1)", (t) => {
  const tools = tmp(t);
  const copy = copyIn(tools);
  assert.equal(pinnedLastFile(copy, tools), null, "no file yet");
  prepareAgentPackage(copy, tools, join(tools, "google-chrome"));
  assert.equal(pinnedLastFile(copy, tools), "0.3.14", "the pinned staged CRX");
  assert.equal(pinnedLastFile(copy, tools, "0".repeat(64)), null, "another pin: the old package never starts");
  // The staged CRX changed on disk (another SHA-256): no fallback.
  const staged = JSON.parse(readFileSync(extensionFile(copy), "utf8")).external_crx;
  writeFileSync(staged, Buffer.concat([readFileSync(staged), Buffer.from([0])]));
  assert.equal(pinnedLastFile(copy, tools), null, "a staged CRX with another SHA-256");
  // A file that names a CRX outside agent-crx/: no fallback, also with the pinned bytes.
  const outside = writeCrx(tools, REAL, "elsewhere.crx");
  writeFileSync(extensionFile(copy), JSON.stringify({ external_crx: outside, external_version: "0.3.14" }));
  assert.equal(pinnedLastFile(copy, tools), null, "a CRX outside agent-crx/");
  // A relative path, also one that names the staged CRX from the service's own folder: no fallback (review-110b).
  writeFileSync(extensionFile(copy), JSON.stringify({ external_crx: "agent-crx/x.crx", external_version: "0.3.14" }));
  assert.equal(pinnedLastFile(copy, tools), null, "a relative CRX path");
});

test("a copy outside the tools folder, or whose root links outside it, is refused, and nothing is written", (t) => {
  const d = tmp(t), tools = join(d, "tools");
  mkdirSync(join(tools, "google-chrome"), { recursive: true });
  const outside = copyIn(join(d, "other"));
  const info = checkCrx();
  assert.throws(() => writeExtensionFile(outside, "/x.crx", info, join(tools, "google-chrome")), { message: "the Chrome copy is not inside the tools folder" });
  symlinkSync(outside.root, join(tools, "google-chrome", "158.0.7100.1-1"));
  const linked = { version: outside.version, root: join(tools, "google-chrome", outside.version), binary: join(tools, "google-chrome", outside.version, "opt", "google", "chrome", "chrome") };
  assert.throws(() => writeExtensionFile(linked, "/x.crx", info, join(tools, "google-chrome")), { message: "the Chrome copy is not inside the tools folder" });
  assert.equal(lstatSync(join(outside.root, "opt", "google", "chrome", "extensions"), { throwIfNoEntry: false }), undefined);
});

test("a symlinked tools folder does not refuse a valid copy, and a symlinked extensions folder is refused", (t) => {
  const d = tmp(t), real = join(d, "real-tools");
  mkdirSync(real);
  symlinkSync(real, join(d, "tools"));
  const copy = copyIn(join(d, "tools"));
  assert.equal(prepareAgentPackage(copy, join(d, "tools"), join(d, "tools", "google-chrome")), "0.3.14");
  const ext = join(real, "google-chrome", copy.version, "opt", "google", "chrome", "extensions");
  rmSync(ext, { recursive: true });
  mkdirSync(join(d, "x"));
  symlinkSync(join(d, "x"), ext);
  assert.throws(() => prepareAgentPackage(copy, join(d, "tools"), join(d, "tools", "google-chrome")), { message: "extensions is a symlink" });
  assert.deepEqual(readdirSync(join(d, "x")), []);
  chmodSync(d, 0o700);
});

// ------------------------------------------------------------------ the sender package

test("the sender package: the sender's ID, the operator manifest's version, and a zip of the operator/ folder that reads back", () => {
  const s = senderData();
  assert.equal(s.id, SENDER_ID);
  assert.equal(s.version, "0.2.1");
  assert.equal(s.package.name, "agentwatch-sender-0.2.1.zip");
  const zip = Buffer.from(s.package.base64, "base64");
  assert.equal(sha(zip), s.package.sha256);
  for (const [name, data] of filesOf(OPERATOR_DIR)) assert.ok(zipMember(zip, name, 1 << 20).equals(data), name);
  // The same bytes each time.
  assert.equal(senderData().package.sha256, s.package.sha256);
});

test("the sender zip has no folder entries and no member out of its root, and needs a manifest with a plain version", (t) => {
  const d = tmp(t);
  const zip = Buffer.from(senderData().package.base64, "base64").toString("latin1");
  assert.doesNotMatch(zip, /\.\.\/|operator\//);
  writeFileSync(join(d, "a.js"), "x");
  assert.throws(() => senderData(d), /no manifest\.json/);
  writeFileSync(join(d, "manifest.json"), JSON.stringify({ version: "../1" }));
  assert.throws(() => senderData(d), /no plain version/);
});

// ------------------------------------------------------------------ the Mac's folder for "Load unpacked" (board ab-v16.94.19)

/** Each file under `dir`, by its path inside it (no folder), with its bytes. */
function tree(dir: string, at = ""): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const e of readdirSync(join(dir, at), { withFileTypes: true })) {
    const rel = at ? `${at}/${e.name}` : e.name;
    if (e.isDirectory()) for (const [k, v] of tree(dir, rel)) out.set(k, v);
    else out.set(rel, readFileSync(join(dir, rel)));
  }
  return out;
}

test("the Mac's agent package folder: the pinned CRX unpacked, the same files and bytes as its ZIP, the receiver's ID from its key; written again only when a file differs, is missing or a link is there", (t) => {
  const d = tmp(t);
  const folder = join(d, "agent-package");
  const want = crxFiles(REAL);
  assert.equal(want.size, 26, "the pinned CRX's files (its ZIP has 28 entries: its two folder entries give no file)");
  assert.ok(want.has("manifest.json") && want.has("lib/codec.js") && want.has("rules/block-frames.json"));
  assert.deepEqual(unpackAgentPackage(folder), { version: AGENT_VERSION, written: true });
  const got = tree(folder);
  assert.deepEqual([...got.keys()].sort(), [...want.keys()].sort(), "the same files as the CRX, no other");
  for (const [name, bytes] of want) assert.ok(got.get(name)!.equals(bytes), name);
  assert.equal(folderExtensionId(folder), RECEIVER_ID, "Load unpacked gives the pinned receiver's ID");
  assert.equal(statSync(folder).mode & 0o777, 0o700);
  assert.equal(statSync(join(folder, "lib")).mode & 0o777, 0o700);
  assert.equal(statSync(join(folder, "manifest.json")).mode & 0o777, 0o600);
  // The same files: nothing is written; another file (the file dialog's .DS_Store) stays out of the compare.
  writeFileSync(join(folder, ".DS_Store"), "x");
  assert.deepEqual(unpackAgentPackage(folder), { version: AGENT_VERSION, written: false });
  assert.ok(lstatSync(join(folder, ".DS_Store")).isFile());
  // A changed file, a missing file: the folder is written again, as a whole.
  writeFileSync(join(folder, "receiver.js"), "changed");
  assert.equal(unpackAgentPackage(folder).written, true);
  assert.ok(readFileSync(join(folder, "receiver.js")).equals(want.get("receiver.js")!));
  rmSync(join(folder, "lib", "codec.js"));
  assert.equal(unpackAgentPackage(folder).written, true);
  assert.ok(readFileSync(join(folder, "lib", "codec.js")).equals(want.get("lib/codec.js")!));
  // A link in the folder's place, or a folder inside it that is a link: never followed; a plain folder takes the place.
  const other = join(d, "other");
  mkdirSync(join(other, "lib"), { recursive: true });
  for (const [name, bytes] of want) { mkdirSync(join(other, name, ".."), { recursive: true }); writeFileSync(join(other, name), bytes); }
  rmSync(folder, { recursive: true });
  symlinkSync(other, folder);
  assert.equal(unpackAgentPackage(folder).written, true);
  assert.ok(lstatSync(folder).isDirectory() && !lstatSync(folder).isSymbolicLink());
  assert.ok(tree(other).size === want.size, "the link's target is left as it was");
  rmSync(join(folder, "lib"), { recursive: true });
  symlinkSync(join(other, "lib"), join(folder, "lib"));
  assert.equal(unpackAgentPackage(folder).written, true);
  assert.ok(!lstatSync(join(folder, "lib")).isSymbolicLink());
  assert.deepEqual(readdirSync(d).sort(), ["agent-package", "other"], "no new or old folder is left next to it");
});

test("review-147 note 3 (board ab-v16.94.21): the swap's failure path moves the old folder back before it removes the new one; a remove of the old folder that fails after a good swap fails nothing and is named in `left`; each call removes the .tmp and .old folders that a swap or a crash left", (t) => {
  const d = tmp(t);
  const folder = join(d, "agent-package");
  const want = crxFiles(REAL);
  assert.equal(unpackAgentPackage(folder).written, true);
  writeFileSync(join(folder, "receiver.js"), "changed");
  // node:fs's own functions fail where a test says (crx.ts imports them by name: syncBuiltinESMExports moves its bindings).
  const real = { renameSync: fs.renameSync, rmSync: fs.rmSync };
  const fail = (code: string) => { throw Object.assign(new Error(`${code}: a test's failure`), { code }); };
  const patch = (p: Record<string, unknown>) => { Object.assign(fs, p); syncBuiltinESMExports(); };
  const restore = () => { Object.assign(fs, real); syncBuiltinESMExports(); };
  // 1. The new folder cannot take the name, and its remove fails too.
  patch({
    renameSync: (a: string, b: string) => (String(a).endsWith(".tmp") ? fail("EIO") : real.renameSync(a, b)),
    rmSync: (p: string, o: object) => (String(p).endsWith(".tmp") ? fail("EBUSY") : real.rmSync(p, o)),
  });
  try { assert.throws(() => unpackAgentPackage(folder), /^Error: EIO: a test's failure$/, "the rename's error (before the fix: the remove's EBUSY)"); } finally { restore(); }
  assert.equal(readFileSync(join(folder, "receiver.js"), "utf8"), "changed", "the old folder moved back: the folder is never missing");
  assert.equal(readdirSync(d).filter((n) => /^\.agent-package\.[0-9a-f]{16}\.tmp$/.test(n)).length, 1, "the new folder stays, for the next call");
  // 2. The next call removes that .tmp and writes; the remove of the old folder fails after the good swap.
  let r: ReturnType<typeof unpackAgentPackage>;
  patch({ rmSync: (p: string, o: object) => (String(p).endsWith(".old") ? fail("EBUSY") : real.rmSync(p, o)) });
  try { r = unpackAgentPackage(folder); } finally { restore(); }
  assert.equal(r.written, true, "no failure of the start (before the fix: it threw EBUSY)");
  assert.ok(readFileSync(join(folder, "receiver.js")).equals(want.get("receiver.js")!), "the swap worked");
  assert.equal(r.left?.length, 1);
  assert.match(r.left![0], /\/\.agent-package\.[0-9a-f]{16}\.old \(EBUSY\)$/);
  assert.deepEqual(readdirSync(d).filter((n) => n.endsWith(".tmp")), [], "the first call's .tmp is gone");
  // 3. The next call removes that .old and a crash's .tmp; a folder of another name stays; nothing is written.
  mkdirSync(join(d, ".agent-package.0123456789abcdef.tmp", "lib"), { recursive: true });
  mkdirSync(join(d, ".agent-package.keep"));
  assert.deepEqual(unpackAgentPackage(folder), { version: AGENT_VERSION, written: false });
  assert.deepEqual(readdirSync(d).sort(), [".agent-package.keep", "agent-package"]);
});

test("the Mac's agent package folder takes only the pinned CRX, and a member that leaves the folder, a name twice (in any case) or a folder entry out of it is refused, with nothing written", (t) => {
  const d = tmp(t);
  const folder = join(d, "agent-package");
  const bad = writeCrx(d, crx());
  assert.throws(() => unpackAgentPackage(folder, bad), (e: Error) => e instanceof PackageError && /pinned SHA-256/.test(e.message));
  const one = crx({ files: [["a.js", Buffer.from("1")]] });
  assert.deepEqual(unpackAgentPackage(folder, writeCrx(d, one, "one.crx"), { sha256: sha(one) }), { version: "0.3.6", written: true });
  assert.deepEqual([...tree(folder).keys()].sort(), ["a.js", "manifest.json"]);
  for (const [files, why] of [
    [[["../x.js", Buffer.from("1")]], /a ZIP member named "\.\.\/x\.js"/],
    [[["/x.js", Buffer.from("1")]], /a ZIP member named "\/x\.js"/],
    [[["a\\b.js", Buffer.from("1")]], /a ZIP member named/],
    [[["a//b.js", Buffer.from("1")]], /a ZIP member named/],
    [[["../", Buffer.alloc(0)]], /a ZIP member named "\.\."/],
    [[["A.js", Buffer.from("1")], ["a.js", Buffer.from("2")]], /twice/],
  ] as [[string, Buffer][], RegExp][]) {
    const data = crx({ files });
    assert.throws(() => unpackAgentPackage(folder, writeCrx(d, data, "bad.crx"), { sha256: sha(data) }), (e: Error) => e instanceof PackageError && /cannot be unpacked/.test(e.message) && why.test(e.message), String(why));
    assert.deepEqual([...tree(folder).keys()].sort(), ["a.js", "manifest.json"], "the folder of the last good write stays");
  }
  assert.deepEqual(readdirSync(d).filter((n) => n.startsWith(".")), [], "no new folder is left");
});
