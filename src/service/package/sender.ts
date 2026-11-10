// The sender package of C12's `sender` (stage 1b part 2, board ab-v16.94.9; chrome-extension docs/protocol.md, C1 and
// C9; agent-browser docs/contracts/C12.md): the sender's ID, its version, and the zip of the pinned commit's operator/
// folder, which the Browser pane offers. The zip is made the same way each time (stored members in name order, the
// DOS time of 1980-01-01 00:00, no folder entries), so its SHA-256 depends only on the files. The service makes it once.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { crc32 } from "node:zlib";
import { OPERATOR_DIR, SENDER_ID } from "./pins.ts";

export type SenderData = { id: string; version: string; package: { name: string; sha256: string; base64: string } };

/** Every file of `dir` (its relative path with `/`, sorted) and its bytes. */
export function filesOf(dir: string): [string, Buffer][] {
  const out: [string, Buffer][] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push([relative(dir, p).split(sep).join("/"), readFileSync(p)]);
    }
  };
  walk(dir);
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A ZIP of stored members, in the given order, with a fixed time (1980-01-01 00:00): the same bytes for the same files. */
export function storedZip(files: [string, Buffer][]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name, "utf8"), crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26); h.writeUInt16LE(0, 28);
    locals.push(h, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
    c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28); c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32); c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36);
    c.writeUInt32LE(0, 38); c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** C12's `sender` data from the operator/ folder `dir`: the ID, the manifest's version, and the zip as `agentwatch-sender-<version>.zip`. */
export function senderData(dir: string = OPERATOR_DIR, id: string = SENDER_ID): SenderData {
  const files = filesOf(dir);
  const manifest = files.find(([n]) => n === "manifest.json");
  if (!manifest) throw new Error("the sender package has no manifest.json");
  const version = JSON.parse(manifest[1].toString("utf8")).version;
  if (typeof version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(version)) throw new Error("the sender package's manifest has no plain version");
  const zip = storedZip(files);
  return { id, version, package: { name: `agentwatch-sender-${version}.zip`, sha256: createHash("sha256").update(zip).digest("hex"), base64: zip.toString("base64") } };
}
