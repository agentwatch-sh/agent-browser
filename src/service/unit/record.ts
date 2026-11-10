// The unit record, unit.json (the self-contained design, section 13.2, "The unit record"; board ab-v16.94.3). It keeps
// today's format (agentwatch's daemon/browser/unit.py) during the whole move, so a daemon at a switch-off, or an older
// daemon, adopts the right Chrome: `wanted`, `display`, `display_size`, `xvfb_pid`, `chrome_pid`, `receiver`,
// `chrome` ({kind, version}), `chrome_bin` and `started_at`. The service adds `xvfb_start` and `chrome_start` (the
// start times of /proc/<pid>/stat), which an older reader ignores. Only the owner writes it: a temp file in the same
// folder (mode 0600), its fsync, the rename, and the fsync of the folder. An unreadable record is not "no record".

import { closeSync, constants, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

export type RecordRead = { kind: "none" } | { kind: "unreadable"; why: string } | { kind: "ok"; record: Record<string, unknown> };

/** The record at `path`: none (no file), unreadable (with why: not JSON, not an object, a read error), or its object. */
export function readRecord(path: string): RecordRead {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { kind: "none" } : { kind: "unreadable", why: `it cannot be read (${code ?? "error"})` };
  }
  let o: unknown;
  try { o = JSON.parse(text); } catch { return { kind: "unreadable", why: "it is not JSON" }; }
  if (o === null || typeof o !== "object" || Array.isArray(o)) return { kind: "unreadable", why: "it is not a JSON object" };
  return { kind: "ok", record: o as Record<string, unknown> };
}

/** Write `data` as JSON to `path`: a temp file in the same folder (0600), fsync, rename, then fsync of the folder. */
export function writeJsonDurable(path: string, data: unknown): void {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeSync(fd, `${JSON.stringify(data, null, 2)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
  const dfd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
}

/** An integer of the record (not a boolean), or null. */
export const intOf = (x: unknown): number | null => (typeof x === "number" && Number.isSafeInteger(x) ? x : null);
