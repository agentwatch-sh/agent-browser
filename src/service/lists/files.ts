// The small file rules of the service's lists, ended scopes, list copies and dismissals (stage 1c, board ab-v16.94.4),
// as agentwatch's statefiles.py has them: a JSON file is replaced whole (a new file of mode 0600, then a rename), in a
// folder of mode 0700, so a reader sees one version and a stop never leaves half a file.

import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

/** Make `path` a folder of mode 0700, with each missing parent (a parent that exists keeps its mode). */
export function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!statSync(path).isDirectory()) throw Object.assign(new Error(`not a folder: ${path}`), { code: "ENOTDIR" });
  chmodSync(path, 0o700);
}

/** Replace `path` with `value` as JSON (two-space indent and a newline, as agentwatch writes it): mode 0600, folder 0700. */
export function writeJson(path: string, value: unknown): void {
  const dir = dirname(path);
  privateDir(dir);
  const data = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

/** Deeper than this, a JSON file is damaged, as Python's json.loads refuses it (RecursionError) in agentwatch. */
export const MAX_JSON_DEPTH = 1000;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A JSON file's bytes as Python's json.loads reads them: strict UTF-8 (a byte order mark is dropped), and not too deep; else a throw. */
export function parseJsonBytes(bytes: Uint8Array): unknown {
  const value: unknown = JSON.parse(utf8.decode(bytes));
  const todo: [unknown, number][] = [[value, 1]];
  while (todo.length) {
    const [v, depth] = todo.pop()!;
    if (v === null || typeof v !== "object") continue;
    if (depth > MAX_JSON_DEPTH) throw new SyntaxError("the JSON is nested too deep");
    for (const x of Array.isArray(v) ? v : Object.values(v)) if (x !== null && typeof x === "object") todo.push([x, depth + 1]);
  }
  return value;
}

/** The kind of a file error for a text: its code (ENOSPC, EACCES), else its name; never its message (which holds a path). */
export const errorKind = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.name ?? "Error";

/** An own property of a plain object (a scope named `constructor` is a scope, not Object's). */
export const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);
