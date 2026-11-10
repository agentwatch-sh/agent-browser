// The agent CRX and Chrome's external extensions file (stage 1b part 2, board ab-v16.94.9; a port of agentwatch's
// daemon/browser/crx.py and ext_id.py; chrome-extension docs/protocol.md, C1). The trust is the pinned SHA-256 and the
// pinned extension ID: the CRX's own signature is Chrome's check, and the signing key is never read. Before each start
// of a Google Chrome copy of the tools folder, the service checks the pinned CRX, stages a copy of it in the tools
// folder (agent-crx/<version>-<sha12>.crx, mode 0600) and writes the external extensions file next to the copy's binary
// (extensions/<receiver ID>.json, mode 0644 in a 0755 folder), so Chrome installs the agent package at its start.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import type { ChromeCopy } from "../unit/google-chrome.ts";
import { AGENT_CRX, AGENT_CRX_SHA256, RECEIVER_ID } from "./pins.ts";

const MAGIC = Buffer.from("Cr24", "latin1");
const SIGNED_HEADER_DATA = 10000;
const CRX_ID_BYTES = 16;
/** A CRX above this is refused before its hash (agentwatch's _MAX_CRX). */
export const MAX_CRX = 16 << 20;
/** A manifest.json above this is refused. */
export const MAX_MANIFEST = 1 << 20;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;

/** A refusal of the agent package: its text is the start's reason (it names no key and no path of the box). */
export class PackageError extends Error { constructor(m: string) { super(m); this.name = "PackageError"; } }

export type CrxInfo = { path: string; extensionId: string; version: string; sha256: string };

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A Chromium extension ID from its base64 manifest key (C1): SHA-256 of the DER, the first 32 hex digits, 0-f to a-p. */
export function extensionId(keyB64: string): string {
  // Strict base64, as Python's b64decode(validate=True): no other character, and whole groups of four.
  if (typeof keyB64 !== "string" || !keyB64 || keyB64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(keyB64)) throw new PackageError("the key is not base64 text");
  const digest = sha256(Buffer.from(keyB64, "base64")).slice(0, 32);
  return [...digest].map((d) => String.fromCharCode(97 + parseInt(d, 16))).join("");
}

/** The ID of an unpacked extension folder from its manifest.json `key`, or null (no file, not an object, no usable key). */
export function folderExtensionId(folder: string): string | null {
  let m: unknown;
  try { m = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")); } catch { return null; }
  if (m === null || typeof m !== "object" || Array.isArray(m)) return null;
  const key = (m as Record<string, unknown>).key;
  if (typeof key !== "string" || !key) return null;
  try { return extensionId(key); } catch { return null; }
}

function varint(data: Buffer, pos: number): [number, number] {
  let value = 0, shift = 0;
  while (pos < data.length && shift < 64) {
    const b = data[pos++];
    value += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return [value, pos];
    shift += 7;
  }
  throw new Error("bad varint");
}

/** (number, bytes) of each length-delimited field of a protobuf message; other wire types are skipped. */
function* fields(data: Buffer): Generator<[number, Buffer]> {
  let pos = 0;
  while (pos < data.length) {
    let tag: number;
    [tag, pos] = varint(data, pos);
    const wire = tag % 8;
    if (wire === 2) {
      let size: number;
      [size, pos] = varint(data, pos);
      if (pos + size > data.length) throw new Error("short field");
      yield [Math.floor(tag / 8), data.subarray(pos, pos + size)];
      pos += size;
    } else if (wire === 0) [, pos] = varint(data, pos);
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else throw new Error("bad wire type");
  }
}

/** The header and the ZIP bytes of a CRX3 file. */
function split(data: Buffer): [Buffer, Buffer] {
  if (data.length < 12 || !data.subarray(0, 4).equals(MAGIC)) throw new Error("not a CRX file");
  if (data.readUInt32LE(4) !== 3) throw new Error("not a CRX3 file");
  const size = data.readUInt32LE(8);
  if (12 + size > data.length) throw new Error("the CRX header is cut off");
  return [data.subarray(12, 12 + size), data.subarray(12 + size)];
}

/** The extension ID that the CRX3 header names (its signed data's crx_id: 16 bytes, each nibble 0-f as a-p). */
export function crxHeaderId(data: Buffer): string {
  const [header] = split(data);
  const ids: Buffer[] = [];
  for (const [num, payload] of fields(header)) {
    if (num !== SIGNED_HEADER_DATA) continue;
    for (const [inner, value] of fields(payload)) if (inner === 1) ids.push(value);
  }
  if (!ids.length) throw new Error("the CRX header holds no id");
  if (ids.length !== 1) throw new Error("the CRX header holds more than one id");
  if (ids[0].length !== CRX_ID_BYTES) throw new Error("the CRX id is not 16 bytes");
  return [...ids[0]].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
}

/** One member of a ZIP file (stored or deflated, no encryption, no ZIP64), read through its central directory entry. */
export function zipMember(zip: Buffer, name: string, max: number): Buffer {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("no ZIP end record");
  const count = zip.readUInt16LE(eocd + 10), cdOffset = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("a ZIP64 file");
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) throw new Error("a bad ZIP directory");
    const flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10), crc = zip.readUInt32LE(at + 16);
    const csize = zip.readUInt32LE(at + 20), usize = zip.readUInt32LE(at + 24);
    const n = zip.readUInt16LE(at + 28), e = zip.readUInt16LE(at + 30), c = zip.readUInt16LE(at + 32), local = zip.readUInt32LE(at + 42);
    const entry = zip.subarray(at + 46, at + 46 + n).toString("utf8");
    at += 46 + n + e + c;
    if (entry !== name) continue;
    if (flags & 1) throw new Error("an encrypted ZIP member");
    if (usize > max) throw new Error("the manifest is too large");
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw new Error("a bad ZIP member");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (start + csize > zip.length) throw new Error("a ZIP member is cut off");
    const raw = zip.subarray(start, start + csize);
    let out: Buffer;
    if (method === 0) out = Buffer.from(raw);
    else if (method === 8) out = inflateRawSync(raw, { maxOutputLength: max + 1 });
    else throw new Error(`a ZIP member of method ${method}`);
    if (out.length > max) throw new Error("the manifest is too large");
    if (out.length !== usize || crc32(out) !== crc) throw new Error("a ZIP member with a bad CRC");
    return out;
  }
  throw new Error(`no ${name} in the ZIP`);
}

/** The manifest.json of the ZIP after the CRX3 header. */
export function crxManifest(data: Buffer): Record<string, unknown> {
  const [, body] = split(data);
  const raw = zipMember(body, "manifest.json", MAX_MANIFEST);
  const m: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (m === null || typeof m !== "object" || Array.isArray(m)) throw new Error("the manifest is not an object");
  return m as Record<string, unknown>;
}

function checkVersion(version: string): void {
  if (!VERSION_RE.test(version) || version.includes("..")) throw new PackageError("the version of the agent extension package is not a plain version text");
}

/** Check the CRX at `path` against the pins: its SHA-256, the header's ID and the manifest key's ID, a plain version. */
export function checkCrx(path: string = AGENT_CRX, o: { sha256?: string; extensionId?: string } = {}): CrxInfo {
  const want = o.sha256 ?? AGENT_CRX_SHA256, id = o.extensionId ?? RECEIVER_ID;
  let data: Buffer;
  try { data = readFileSync(path); }
  catch (e) { throw new PackageError(`the agent extension package cannot be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`); }
  if (data.length > MAX_CRX) throw new PackageError("the agent extension package is too large");
  const digest = sha256(data);
  if (digest !== want) throw new PackageError("the agent extension package does not match its pinned SHA-256");
  let headerId: string, manifest: Record<string, unknown>;
  try { headerId = crxHeaderId(data); manifest = crxManifest(data); }
  catch (e) { throw new PackageError(`the agent extension package is not a CRX3 file (${(e as Error).message})`); }
  if (headerId !== id) throw new PackageError("the agent extension package header names another extension ID");
  let keyId: string | null = null;
  try { keyId = typeof manifest.key === "string" && manifest.key ? extensionId(manifest.key) : null; } catch {}
  if (keyId !== id) throw new PackageError("the manifest key of the agent extension package gives another extension ID");
  const version = manifest.version;
  if (typeof version !== "string" || !version) throw new PackageError("the manifest of the agent extension package has no version");
  checkVersion(version);
  return { path, extensionId: id, version, sha256: digest };
}

/** Make `folder` with `mode`; refuse a link (also one that comes between the check and the use). */
function plainDir(folder: string, mode: number): void {
  const name = folder.split(sep).pop();
  const st = lstatSync(folder, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) throw new PackageError(`${name} is a symlink`);
  mkdirSync(folder, { recursive: true, mode });
  const after = lstatSync(folder);
  if (after.isSymbolicLink() || !after.isDirectory()) throw new PackageError(`${name} is not a plain folder`);
  chmodSync(folder, mode);
}

/** Replace `folder/name` with `data` (mode `mode`): a new file with no link followed, its fsync, then a rename. */
function writeAtomic(folder: string, name: string, data: Uint8Array, mode: number): string {
  const target = join(folder, name), tmp = join(folder, `.${name}.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    try { writeSync(fd, data); } finally { closeSync(fd); }
    chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
  return target;
}

/** Copy the checked CRX to <tools>/agent-crx/<version>-<sha12>.crx (0600; the bytes are hashed again: they must be the checked ones). */
export function stageCrx(info: CrxInfo, tools: string): string {
  checkVersion(info.version);
  const data = readFileSync(info.path);
  const digest = sha256(data);
  if (digest !== info.sha256) throw new PackageError("the agent extension package changed after its check");
  const folder = join(tools, "agent-crx");
  plainDir(folder, 0o700);
  return writeAtomic(folder, `${info.version}-${digest.slice(0, 12)}.crx`, data, 0o600);
}

/** Where the external extensions file of `copy` goes: extensions/<receiver ID>.json next to the copy's binary (after links). */
export function extensionFile(copy: ChromeCopy, id: string = RECEIVER_ID): string {
  return join(dirname(realpathSync(copy.binary)), "extensions", `${id}.json`);
}

/**
 * The version of the external extensions file of `copy` from an earlier start, when that file is still good for the
 * current pin: it names a staged CRX in <tools>/agent-crx/ whose bytes have the pinned SHA-256; else null (review-110
 * B1: after a pin change the old receiver never starts).
 */
export function pinnedLastFile(copy: ChromeCopy, tools: string, sha: string = AGENT_CRX_SHA256): string | null {
  try {
    const j = JSON.parse(readFileSync(extensionFile(copy), "utf8"));
    // An absolute path only: Chrome reads a relative one against the file's folder (review-110b).
    if (typeof j?.external_crx !== "string" || !isAbsolute(j.external_crx) || typeof j?.external_version !== "string") return null;
    const folder = realpathSync(join(tools, "agent-crx")), crx = realpathSync(j.external_crx);
    if (dirname(crx) !== folder || sha256(readFileSync(crx)) !== sha) return null;
    checkVersion(j.external_version);
    return j.external_version;
  } catch { return null; }
}

/** True when `child` is `root` or under it. */
const under = (child: string, root: string) => child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Write Chrome's external extensions file next to the binary of `copy`, a copy under `chromes` (the tools folder's
 * google-chrome/, after links): {"external_crx":"<staged CRX>","external_version":"<version>"}. A copy outside it is refused.
 */
export function writeExtensionFile(copy: ChromeCopy, crx: string, info: CrxInfo, chromes: string): string {
  let root: string, copyRoot: string, binary: string;
  try { root = realpathSync(chromes); copyRoot = realpathSync(copy.root); binary = realpathSync(copy.binary); }
  catch { throw new PackageError("the Chrome copy is not inside the tools folder"); }
  if (copyRoot === root || !under(copyRoot, root) || binary === copyRoot || !under(binary, copyRoot)) throw new PackageError("the Chrome copy is not inside the tools folder");
  checkVersion(info.version);
  const folder = join(dirname(binary), "extensions");
  plainDir(folder, 0o755);
  const body = Buffer.from(JSON.stringify({ external_crx: crx, external_version: info.version }), "utf8");
  return writeAtomic(folder, `${info.extensionId}.json`, body, 0o644);
}

/**
 * The agent package for one start of a Google Chrome copy: check the pinned CRX, stage it in the tools folder and write
 * the copy's external extensions file. Returns the staged CRX's version (the receiver that Chrome installs).
 */
export function prepareAgentPackage(copy: ChromeCopy, tools: string, chromes: string, crx: string = AGENT_CRX): string {
  const info = checkCrx(crx);
  writeExtensionFile(copy, stageCrx(info, tools), info, chromes);
  return info.version;
}
