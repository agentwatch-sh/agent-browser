// The unpack of Google Chrome's .deb into the tools folder (the self-contained design, section 5.1, the row "Google
// Chrome stable"; board ab-v16.94.3; a port of extract_chrome() of agentwatch's tools/google_chrome.py). No dpkg, no
// apt, no root and no maintainer script: only the member data.tar.xz of the ar archive is read, through `xz -dc`, and
// only its members under opt/google/chrome/ are written. The control part is never read.
//
// The tar reader takes the formats that a .deb uses: ustar (with its prefix field), GNU (long names and long link
// names in 'L' and 'K' members, sizes in base 256) and pax ('x' members with `path`, `linkpath` and `size`; 'g'
// members are skipped). It refuses an absolute name, '..', a device, a FIFO, a hard link, a member under a symbolic
// link, a name given twice, and a symbolic link whose target leaves the copy. Files keep `mode & 0o755`.

import { spawn } from "node:child_process";
import { closeSync, constants, createReadStream, fchmodSync, lstatSync, mkdirSync, openSync, readlinkSync, readSync, realpathSync, symlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, posix, resolve, sep } from "node:path";

export class ToolsError extends Error {}

export const BINARY_REL = join("opt", "google", "chrome", "chrome");
const PREFIX = ["opt", "google", "chrome"];

/** (offset, size) of the member `wanted` of the ar archive at `deb`. */
export function arMember(deb: string, wanted: string): { offset: number; size: number } {
  const fd = openSync(deb, "r");
  try {
    const read = (at: number, n: number) => { const b = Buffer.alloc(n); const got = readSync(fd, b, 0, n, at); return b.subarray(0, got); };
    if (!read(0, 8).equals(Buffer.from("!<arch>\n"))) throw new ToolsError("the Google Chrome package is not a .deb (no ar archive)");
    for (let at = 8; ;) {
      const h = read(at, 60);
      if (h.length === 0) throw new ToolsError(`the Google Chrome package has no ${wanted}`);
      if (h.length !== 60 || h[58] !== 0x60 || h[59] !== 0x0a) throw new ToolsError("the Google Chrome package is damaged (an ar header)");
      const name = h.subarray(0, 16).toString("latin1").replace(/ +$/, "").replace(/\/$/, "");
      const sizeText = h.subarray(48, 58).toString("latin1").trim();
      if (!/^[0-9]{1,19}$/.test(sizeText)) throw new ToolsError("the Google Chrome package is damaged (an ar size)");
      const size = Number(sizeText);
      if (!Number.isSafeInteger(size)) throw new ToolsError("the Google Chrome package is damaged (an ar size)");
      if (name === wanted) return { offset: at + 60, size };
      at += 60 + size + (size & 1);
    }
  } finally { closeSync(fd); }
}

/** The parts of a member name under the copy: an absolute name and '..' are refused; '' and '.' parts drop. */
export function memberParts(name: string): string[] {
  if (name.startsWith("/")) throw new ToolsError("the Google Chrome package has a member with an absolute name");
  const parts = name.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) throw new ToolsError("the Google Chrome package has a member that leaves its folder ('..')");
  return parts;
}

const inside = (path: string, root: string) => path === root || path.startsWith(root.replace(/\/+$/, "") + sep);

/**
 * The real path of `p` as Python's os.path.realpath (not strict) gives it: each link resolved, also a dangling one,
 * and the parts that do not exist kept as they are. At most 40 links (a loop resolves to where it stops).
 */
export function looseRealpath(p: string, depth = 0): string {
  try { return realpathSync(p); } catch {}
  const parent = dirname(p);
  if (parent === p) return p;
  const base = join(looseRealpath(parent, depth), basename(p));
  let to: string;
  try { to = readlinkSync(base); } catch { return base; }
  if (depth >= 40) return base;
  return looseRealpath(resolve(dirname(base), to), depth + 1);
}
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const exists = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };

type Entry = { name: string; type: string; size: number; mode: number; linkname: string };

/** A number of a tar header field: octal text, or GNU's base 256 (the high bit of the first byte set). */
function tarNumber(b: Buffer): number {
  if (b[0] & 0x80) {
    let n = 0n;
    for (let i = 0; i < b.length; i++) n = (n << 8n) | BigInt(i === 0 ? b[i] & 0x7f : b[i]);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new ToolsError("the Google Chrome package is damaged (a tar size)");
    return Number(n);
  }
  const t = b.toString("latin1").replace(/\0.*$/s, "").trim();
  if (t === "") return 0;
  if (!/^[0-7]+$/.test(t)) throw new ToolsError("the Google Chrome package is damaged (a tar number)");
  return parseInt(t, 8);
}
const cstr = (b: Buffer) => { const z = b.indexOf(0); return (z < 0 ? b : b.subarray(0, z)).toString("utf8"); };

/** The pax records of an 'x' member: `path`, `linkpath` and `size` (the others are ignored). */
function paxRecords(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < body.length) {
    const sp = body.indexOf(0x20, at);
    if (sp < 0) break;
    const len = Number(body.subarray(at, sp).toString("latin1"));
    if (!Number.isSafeInteger(len) || len <= 0 || at + len > body.length) throw new ToolsError("the Google Chrome package is damaged (a pax header)");
    const rec = body.subarray(sp + 1, at + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    at += len;
  }
  return out;
}

/**
 * A streaming tar reader that writes the members under opt/google/chrome/ into `dest`. Feed it the bytes of the tar
 * (`push`), then call `end`. The symbolic links that it made are in `links`, for the check of their real targets.
 */
export class ChromeTar {
  readonly links: string[] = [];
  private readonly dest: string;
  private buf: Buffer = Buffer.alloc(0);
  /** The member whose body comes now: its bytes left, its padding, the fd it writes (or -1: skipped), a body that it keeps (pax, GNU long names). */
  private body: { left: number; pad: number; fd: number; mode: number; keep: Buffer[] | null; kind: string } | null = null;
  private longName: string | null = null;
  private longLink: string | null = null;
  private pax: Record<string, string> = {};
  private ended = false;

  constructor(dest: string) { this.dest = dest; }

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.ended) { this.buf = Buffer.alloc(0); return; }
      if (this.body) {
        const b = this.body;
        if (b.left > 0) {
          const n = Math.min(b.left, this.buf.length);
          if (n === 0) return;
          const part = this.buf.subarray(0, n);
          if (b.fd >= 0) writeSync(b.fd, part);
          if (b.keep) b.keep.push(Buffer.from(part));
          b.left -= n; this.buf = this.buf.subarray(n);
          if (b.left > 0) return;
        }
        if (this.buf.length < b.pad) return;
        this.buf = this.buf.subarray(b.pad);
        this.body = null;
        this.finishBody(b);
        continue;
      }
      if (this.buf.length < 512) return;
      const h = this.buf.subarray(0, 512);
      this.buf = this.buf.subarray(512);
      if (h.every((x) => x === 0)) { this.ended = true; continue; }
      this.header(h);
    }
  }

  private finishBody(b: NonNullable<ChromeTar["body"]>): void {
    if (b.fd >= 0) { fchmodSync(b.fd, b.mode & 0o755); closeSync(b.fd); }
    if (b.keep) {
      const data = Buffer.concat(b.keep);
      if (b.kind === "L") this.longName = cstr(data);
      else if (b.kind === "K") this.longLink = cstr(data);
      else if (b.kind === "x") this.pax = { ...this.pax, ...paxRecords(data) };
    }
  }

  private header(h: Buffer): void {
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (tarNumber(h.subarray(148, 156)) !== sum) throw new ToolsError("the Google Chrome package is damaged (a tar checksum)");
    const magic = h.subarray(257, 263).toString("latin1");
    let name = cstr(h.subarray(0, 100));
    const prefix = magic === "ustar\0" ? cstr(h.subarray(345, 500)) : "";
    if (prefix) name = `${prefix}/${name}`;
    const type = String.fromCharCode(h[156] || 0x30);
    let size = tarNumber(h.subarray(124, 136));
    const mode = tarNumber(h.subarray(100, 108));
    let linkname = cstr(h.subarray(157, 257));
    if (type === "L" || type === "K" || type === "x" || type === "g") {
      if (size > 1 << 20) throw new ToolsError("the Google Chrome package is damaged (a long header)");
      this.body = { left: size, pad: (512 - (size % 512)) % 512, fd: -1, mode: 0, keep: type === "g" ? null : [], kind: type };
      return;
    }
    if (this.longName !== null) name = this.longName;
    if (this.longLink !== null) linkname = this.longLink;
    if (this.pax.path !== undefined) name = this.pax.path;
    if (this.pax.linkpath !== undefined) linkname = this.pax.linkpath;
    if (this.pax.size !== undefined) {
      if (!/^[0-9]{1,15}$/.test(this.pax.size)) throw new ToolsError("the Google Chrome package is damaged (a pax size)");
      size = Number(this.pax.size);
    }
    this.longName = null; this.longLink = null; this.pax = {};
    const e: Entry = { name, type, size, mode, linkname };
    const fd = this.take(e);
    const data = type === "0" || type === "7" ? size : 0;
    this.body = data > 0 || fd >= 0 ? { left: data, pad: (512 - (data % 512)) % 512, fd, mode, keep: null, kind: type } : null;
    if (this.body && this.body.left === 0 && this.body.pad === 0) { const b = this.body; this.body = null; this.finishBody(b); }
  }

  /** Write the member (a folder, a link) or open its file; the fd of its body, or -1 (skipped, or no body). */
  private take(e: Entry): number {
    const parts = memberParts(e.name);
    if (parts.length < PREFIX.length || PREFIX.some((p, i) => parts[i] !== p)) return -1; // outside opt/google/chrome/: never written
    const dir = e.type === "5";
    if (parts.length === PREFIX.length) {
      if (!dir) throw new ToolsError("the Google Chrome package has no opt/google/chrome folder");
    }
    // The parent folders, made as needed, never through a link.
    let here = this.dest;
    for (const p of parts.slice(0, -1)) {
      here = join(here, p);
      if (isLink(here)) throw new ToolsError("the Google Chrome package writes through a symbolic link");
      if (!exists(here)) mkdirSync(here, { mode: 0o755 });
      else if (!lstatSync(here).isDirectory()) throw new ToolsError("the Google Chrome package has a file where it needs a folder");
    }
    const target = join(here, parts[parts.length - 1]);
    if (dir) {
      if (isLink(target) || (exists(target) && !lstatSync(target).isDirectory())) throw new ToolsError("the Google Chrome package has a folder where it has a file or link");
      if (!exists(target)) mkdirSync(target, { mode: 0o755 });
      return -1;
    }
    if (exists(target)) throw new ToolsError("the Google Chrome package names a member twice");
    if (e.type === "0" || e.type === "7") {
      return openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    }
    if (e.type === "2") {
      const to = e.linkname;
      const lexical = to ? posix.normalize(posix.join(...parts.slice(0, -1), to)) : "..";
      if (to.startsWith("/") || lexical === ".." || lexical.startsWith("../")) throw new ToolsError("the Google Chrome package has a symbolic link that leaves its folder");
      symlinkSync(to, target);
      this.links.push(target);
      return -1;
    }
    const kind = e.type === "1" ? "a hard link" : e.type === "6" ? "a FIFO" : e.type === "3" || e.type === "4" ? "a device" : "a member of an unknown type";
    throw new ToolsError(`the Google Chrome package has ${kind} under opt/google/chrome`);
  }

  end(): void {
    if (this.body) { const b = this.body; this.body = null; if (b.fd >= 0) closeSync(b.fd); throw new ToolsError("the Google Chrome package is damaged (a cut member)"); }
  }

  /** Close an open member file after an error. */
  abort(): void { if (this.body && this.body.fd >= 0) { try { closeSync(this.body.fd); } catch {} } this.body = null; }
}

/**
 * Unpack the members under opt/google/chrome/ of the data.tar.xz of `deb` into `dest`, through `xz` (its path). After
 * the unpack, each link's real target must stay in `dest` (a chain of links can leave where each one alone stays
 * inside), and opt/google/chrome/chrome must be a file.
 */
export async function extractChrome(deb: string, dest: string, xz: string): Promise<void> {
  const { offset, size } = arMember(deb, "data.tar.xz");
  const tar = new ChromeTar(dest);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(xz, ["-dc"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" } });
    let failed: Error | null = null, stderr = "";
    const fail = (e: Error) => { if (failed) return; failed = e; tar.abort(); child.kill("SIGKILL"); };
    child.stderr!.on("data", (d) => { if (stderr.length < 400) stderr += d; });
    child.stdout!.on("data", (d: Buffer) => { if (failed) return; try { tar.push(d); } catch (e) { fail(e instanceof ToolsError ? e : new ToolsError(`the Google Chrome package could not be unpacked: ${(e as NodeJS.ErrnoException).code ?? (e as Error).name}`)); } });
    child.stdin!.on("error", () => {});
    child.once("error", (e) => fail(new ToolsError(`the Google Chrome package could not be unpacked: xz: ${(e as NodeJS.ErrnoException).code ?? e.message}`)));
    child.once("close", (code) => {
      if (failed) return reject(failed);
      if (code !== 0) return reject(new ToolsError(`the Google Chrome package is damaged: xz: ${stderr.trim().split("\n")[0]?.slice(0, 200) || `exit status ${code}`}`));
      try { tar.end(); } catch (e) { return reject(e); }
      resolve();
    });
    if (size === 0) { child.stdin!.end(); return; }
    createReadStream(deb, { start: offset, end: offset + size - 1 }).on("error", (e) => fail(new ToolsError(`the Google Chrome package could not be read: ${(e as NodeJS.ErrnoException).code ?? e.message}`))).pipe(child.stdin!);
  });
  const real = realpathSync(dest);
  for (const link of tar.links) {
    if (!inside(looseRealpath(link), real)) throw new ToolsError("the Google Chrome package has a symbolic link that leaves its folder");
  }
  const binary = join(dest, BINARY_REL);
  if (isLink(binary) || !exists(binary) || !lstatSync(binary).isFile()) throw new ToolsError("the Google Chrome package has no opt/google/chrome/chrome");
}
