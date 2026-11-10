// Google Chrome stable in the service's tools folder, from Google's signed apt index (the self-contained design,
// section 5.1, the row "Google Chrome stable"; board ab-v16.94.3; a port of agentwatch's tools/google_chrome.py). No
// apt, no root, no system install and no maintainer script. The steps:
//
// 1. <repo>/dists/stable/InRelease is checked with `gpgv` against the pinned key (google-linux-signing-key.asc, next
//    to this file, de-armored into a 0600 keyring in a work folder). gpgv gets its own new 0700 home there, so it
//    never reads or writes the user's ~/.gnupg. Only a VALIDSIG whose last field is a pinned primary fingerprint
//    passes, and only the text that gpgv verified is parsed.
// 2. main/binary-amd64/Packages (or Packages.gz) must match the SHA-256 and the size that the verified text lists.
// 3. The .deb of the newest google-chrome-stable must match the SHA-256 and the size of its entry.
// 4. Only data.tar.xz of the .deb is read (deb.ts), and only its members under opt/google/chrome/, into
//    <tools>/google-chrome/.<version>.<random>.tmp.
// 5. The copy's `chrome --version` must answer with its version; then the folder moves to <tools>/google-chrome/<version>.
//
// Everything runs under the lock <tools>/.google-chrome.lock (flock, the same lock as agentwatch's install), and
// prune() removes the copies that no process runs and the leftovers of an install that a restart cut.
//
// The source of the index is GOOGLE_SOURCE: Google's repository and the pinned key. Only a test (and `--test` with
// its test-only option) gives another source: a local folder and a test key, so no test reaches Google.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, createReadStream, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statfsSync, statSync, writeSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { delimiter, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BINARY_REL, extractChrome, ToolsError } from "./deb.ts";
import { newer, pickVersion, VERSION_RE, versionKey, compareKeys } from "./versions.ts";

export { ToolsError };

/** The pinned public key of Google's Linux packages (a copy of agentwatch's tools/keys/google-linux-signing-key.asc). */
export const KEY_FILE = fileURLToPath(new URL("./google-linux-signing-key.asc", import.meta.url));

export type ChromeSource = {
  /** The repository: Google's https URL, or (tests only) an absolute local folder. */
  repo: string;
  keyFile: string;
  /** The primary key fingerprints that may sign the index (40 hex digits). */
  fingerprints: readonly string[];
  origin: string;
  suite: string;
  package: string;
  arch: string;
};

/** Google Chrome stable from Google's signed index, with the pinned key (agentwatch's tools/pins.py, GOOGLE_*). */
export const GOOGLE_SOURCE: ChromeSource = Object.freeze({
  repo: "https://dl.google.com/linux/chrome/deb",
  keyFile: KEY_FILE,
  fingerprints: Object.freeze(["EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796"]),
  origin: "Google LLC",
  suite: "stable",
  package: "google-chrome-stable",
  arch: "amd64",
});

export const INDEX_FETCH_TIMEOUT_MS = 120_000;
export const DEB_FETCH_TIMEOUT_MS = 900_000;
export const VERSION_TIMEOUT_MS = 30_000;
export const GPGV_TIMEOUT_MS = 60_000;
export const MIN_FREE_BYTES = 2 ** 30;
export const MAX_INRELEASE_BYTES = 2 ** 20;
export const MAX_PACKAGES_BYTES = 64 * 2 ** 20;
/** How long an install waits for the lock (an install of another process holds it). */
export const LOCK_WAIT_MS = 20 * 60_000;

/** The text when the index is signed by a key that the pinned file lacks (Google rotates its signing subkeys). */
export const UNKNOWN_KEY = "Google's Chrome index is signed by a Google key that this agent-browser does not have yet; update agent-browser";

const NUMBER = /^[0-9]{1,19}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._+~-]*(\/[A-Za-z0-9][A-Za-z0-9._+~-]*)*\.deb$/;
const V = "[0-9]{1,19}(\\.[0-9]{1,19}){3}-[0-9]{1,19}";
/** What an install that a restart cut leaves in the copies' folder: its package and its work folders. */
const LEFTOVER_DEB = new RegExp(`^\\.${V}\\.[A-Za-z0-9_]+\\.deb$`);
const LEFTOVER_TMP = new RegExp(`^\\.(index|${V}|${V}\\.home)\\.[A-Za-z0-9_]+\\.tmp$`);
/** gpgv status keywords that refuse the index whatever else it says. */
const BAD_STATUS = ["BADSIG", "ERRSIG", "EXPSIG", "EXPKEYSIG", "REVKEYSIG", "NO_PUBKEY"];
const ARMOR_BEGIN = "-----BEGIN PGP PUBLIC KEY BLOCK-----", ARMOR_END = "-----END PGP PUBLIC KEY BLOCK-----";
const SIGNED_BEGIN = "-----BEGIN PGP SIGNED MESSAGE-----", SIGNATURE_BEGIN = "-----BEGIN PGP SIGNATURE-----", SIGNATURE_END = "-----END PGP SIGNATURE-----";

export type DebEntry = { version: string; filename: string; sha256: string; size: number };
export type ChromeCopy = { version: string; root: string; binary: string };

/** `fetch(url, dest, timeoutMs, limit)`: write the body of `url` to `dest`; throw when it is slower or larger. */
export type Fetch = (url: string, dest: string, timeoutMs: number, limit: number) => Promise<void>;
/** `run(argv, env, timeoutMs)`: the finished process with its text output; a non-zero exit is a result. */
export type Run = (argv: string[], env: Record<string, string>, timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut?: boolean }>;
/** An exclusive lock on a file; null when `wait` is false and another process holds it. */
export type Locker = (path: string, wait: boolean) => Promise<(() => void) | null>;

// ------------------------------------------------------------------ the parts that read the index

/** The SHA256: section of a verified Release text: path -> [hex, size]. A malformed line is skipped. */
export function parseInreleaseSha256(text: string): Map<string, [string, number]> {
  const out = new Map<string, [string, number]>();
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s/.test(line.slice(0, 1))) { inSection = line.trimEnd() === "SHA256:"; continue; }
    if (!inSection) continue;
    const f = line.trim().split(/\s+/);
    if (f.length !== 3 || !NUMBER.test(f[1])) continue;
    const digest = f[0].toLowerCase();
    if (SHA256.test(digest)) out.set(f[2], [digest, Number(f[1])]);
  }
  return out;
}

/** The stanzas of a Debian control text (continuation lines skipped). */
export function stanzas(text: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  let fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) { if (Object.keys(fields).length) out.push(fields); fields = {}; continue; }
    if (/^\s/.test(line)) continue;
    const i = line.indexOf(":");
    if (i >= 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (Object.keys(fields).length) out.push(fields);
  return out;
}

export function entryOk(e: DebEntry): boolean {
  return VERSION_RE.test(e.version) && FILENAME.test(e.filename) && !e.filename.split("/").includes("..") && SHA256.test(e.sha256) && e.size > 0;
}

/** The newest entry of the package in a Packages text, by the numbers of its version; a malformed entry is skipped. */
export function parsePackages(text: string, source: Pick<ChromeSource, "package" | "arch"> = GOOGLE_SOURCE): DebEntry | null {
  let best: DebEntry | null = null;
  for (const st of stanzas(text)) {
    if (st.Package !== source.package || (st.Architecture ?? source.arch) !== source.arch) continue;
    const size = st.Size ?? "";
    if (!NUMBER.test(size) || !Number.isSafeInteger(Number(size))) continue;
    const e: DebEntry = { version: st.Version ?? "", filename: st.Filename ?? "", sha256: (st.SHA256 ?? "").toLowerCase(), size: Number(size) };
    if (!entryOk(e)) continue;
    if (best === null || newer(e.version, best.version)) best = e;
  }
  return best;
}

/** The index must be one clear-signed message: one of each mark, in order, and nothing but blank lines around it. */
export function checkClearsigned(bytes: Buffer): void {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new ToolsError("Google's Chrome index cannot be read: UnicodeError"); }
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  const notOne = "Google's Chrome index is not one clear-signed message";
  if ([SIGNED_BEGIN, SIGNATURE_BEGIN, SIGNATURE_END].map((m) => lines.filter((l) => l === m).length).join() !== "1,1,1") throw new ToolsError(notOne);
  const first = lines.indexOf(SIGNED_BEGIN), sig = lines.indexOf(SIGNATURE_BEGIN), end = lines.indexOf(SIGNATURE_END);
  if (lines.slice(0, first).some(Boolean) || lines.slice(end + 1).some(Boolean) || !(first < sig && sig < end)) throw new ToolsError(notOne);
}

function crc24(data: Buffer): number {
  let crc = 0xb704ce;
  for (const byte of data) {
    crc ^= byte << 16;
    for (let i = 0; i < 8; i++) { crc <<= 1; if (crc & 0x1000000) crc ^= 0x1864cfb; }
  }
  return crc & 0xffffff;
}

/** The binary key of an ASCII-armored public key block (RFC 4880, section 6), with its CRC-24 checked. */
export function dearmor(text: string): Buffer {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const start = lines.indexOf(ARMOR_BEGIN);
  const blank = start < 0 ? -1 : lines.indexOf("", start + 1);
  if (start < 0 || blank < 0) throw new ToolsError("the Google signing key file is not an armored public key");
  const body: string[] = [];
  let checksum = "", ended = false;
  for (const line of lines.slice(blank + 1)) {
    if (line === ARMOR_END) { ended = true; break; }
    if (line.startsWith("=")) { checksum = line.slice(1); continue; }
    body.push(line);
  }
  if (!ended) throw new ToolsError("the Google signing key file is not an armored public key");
  const b64 = /^[A-Za-z0-9+/]*={0,2}$/;
  const joined = body.join("");
  if (!b64.test(joined) || joined.length % 4 !== 0 || (checksum && !b64.test(checksum))) throw new ToolsError("the Google signing key file is damaged");
  const data = Buffer.from(joined, "base64");
  const crc = checksum ? Buffer.from(checksum, "base64") : null;
  if (!data.length || (crc && crc.readUIntBE(0, crc.length) !== crc24(data))) throw new ToolsError("the Google signing key file is damaged");
  return data;
}

/** The v4 fingerprint of the first (primary) public key packet of a binary key (RFC 4880, 12.2), in upper hex. */
export function primaryFingerprint(key: Buffer): string | null {
  if (!key.length || !(key[0] & 0x80)) return null;
  const tag = key[0] & 0x40 ? key[0] & 0x3f : (key[0] >> 2) & 0x0f;
  if (tag !== 6) return null;
  let len: number, at: number;
  if (key[0] & 0x40) {
    const o = key[1];
    if (o < 192) { len = o; at = 2; }
    else if (o < 224) { len = ((o - 192) << 8) + key[2] + 192; at = 3; }
    else if (o === 255) { len = key.readUInt32BE(2); at = 6; }
    else return null;
  } else {
    const lt = key[0] & 3;
    if (lt === 0) { len = key[1]; at = 2; } else if (lt === 1) { len = key.readUInt16BE(1); at = 3; } else if (lt === 2) { len = key.readUInt32BE(1); at = 5; } else return null;
  }
  const body = key.subarray(at, at + len);
  if (body.length !== len || body[0] !== 4) return null;
  const head = Buffer.from([0x99, (len >> 8) & 0xff, len & 0xff]);
  return createHash("sha1").update(head).update(body).digest("hex").toUpperCase();
}

/**
 * Check the clear-signed index `signed` with gpgv against `keyring`; the verified text (also in `out`). gpgv runs with a
 * new 0700 home next to `out` (--homedir and GNUPGHOME), so the user's ~/.gnupg is never read or written. The index
 * passes only with exit 0, a GOODSIG, no bad status and a VALIDSIG whose last field is a pinned fingerprint; and its
 * Origin and Suite are the source's.
 */
export async function verifyInrelease(signed: string, keyring: string, out: string, o: { run: Run; gpgv: string; source: ChromeSource }): Promise<string> {
  checkClearsigned(readFileSync(signed));
  const home = join(out, "..", `gnupg.${randomBytes(6).toString("hex")}`);
  mkdirSync(home, { mode: 0o700 });
  let r: Awaited<ReturnType<Run>>;
  try {
    const argv = [o.gpgv, "--homedir", home, "--status-fd", "1", "--keyring", keyring, "--output", out, signed];
    try { r = await o.run(argv, { PATH: process.env.PATH ?? "/usr/bin:/bin", GNUPGHOME: home, LC_ALL: "C" }, GPGV_TIMEOUT_MS); }
    catch (e) { throw new ToolsError(`Google's Chrome index failed its signature check: gpgv: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`); }
  } finally { rmSync(home, { recursive: true, force: true }); }
  if (r.timedOut) throw new ToolsError("Google's Chrome index failed its signature check: gpgv gave no answer");
  const status = r.stdout.split("\n").filter((l) => l.startsWith("[GNUPG:] ")).map((l) => l.slice(9).split(/\s+/).filter(Boolean));
  const kinds = new Set(status.map((f) => f[0]).filter(Boolean));
  const pinned = new Set(o.source.fingerprints.map((f) => f.toUpperCase()));
  if (kinds.has("NO_PUBKEY")) throw new ToolsError(UNKNOWN_KEY);
  const bad = BAD_STATUS.filter((k) => kinds.has(k)).sort();
  if (r.code !== 0 || bad.length) throw new ToolsError(`Google's Chrome index failed its signature check (${bad[0] ?? `gpgv exit status ${r.code}`})`);
  if (!kinds.has("GOODSIG")) throw new ToolsError("Google's Chrome index failed its signature check (no good signature)");
  if (!status.some((f) => f[0] === "VALIDSIG" && f.length >= 11 && pinned.has(f[f.length - 1].toUpperCase()))) throw new ToolsError("Google's Chrome index failed its signature check (not signed by a pinned Google key)");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(out)); }
  catch (e) { throw new ToolsError(`Google's Chrome index could not be read after its check: ${(e as Error).name}`); }
  const head = stanzas(text)[0] ?? {};
  for (const [field, want] of [["Origin", o.source.origin], ["Suite", o.source.suite]] as const) {
    if (head[field] !== want) throw new ToolsError(`Google's Chrome index has the wrong ${field} (not '${want}')`);
  }
  return text;
}

// ------------------------------------------------------------------ the real fetch, runner and lock

/** Download `url` (https only; a redirect only to https) into `dest` (0600), at most `limit` bytes, within `timeoutMs`. */
export const httpsFetch: Fetch = async (url, dest, timeoutMs, limit) => {
  if (!url.startsWith("https://")) throw new ToolsError("a Google Chrome download must use https");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let at = url, res: Response;
    for (let hops = 0; ; hops++) {
      res = await fetch(at, { redirect: "manual", signal: ac.signal, headers: { "User-Agent": "agent-browser-tools" } });
      if (res.status < 300 || res.status >= 400) break;
      const next = res.headers.get("location");
      await res.body?.cancel();
      if (!next || hops >= 5) throw new ToolsError(`it was redirected too often (${res.status})`);
      at = new URL(next, at).toString();
      if (!at.toLowerCase().startsWith("https://")) throw new ToolsError("it was redirected away from https");
    }
    if (!res.ok || !res.body) throw new ToolsError(`HTTP ${res.status}`);
    const fd = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try {
      let total = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.length;
        if (total > limit) { ac.abort(); throw new ToolsError(`it has more than the ${limit} bytes it should have`); }
        writeSync(fd, chunk);
      }
    } finally { closeSync(fd); }
  } catch (e) {
    if (e instanceof ToolsError) throw e;
    if (ac.signal.aborted) throw new ToolsError(`it took longer than ${Math.round(timeoutMs / 1000)} s`);
    throw e;
  } finally { clearTimeout(timer); }
};

/**
 * The fetch of a local folder that stands in for the repository (tests and `--test` only): `url` is under `repo`
 * (an absolute folder), and the file is copied with the same size limit. Nothing leaves the box.
 */
export function folderFetch(repo: string): Fetch {
  return async (url, dest, _timeoutMs, limit) => {
    if (!url.startsWith(`${repo}/`)) throw new ToolsError("the test repository names a file outside its folder");
    const src = url;
    const st = lstatSync(src);
    if (!st.isFile()) throw new ToolsError("the test repository's file is not a regular file");
    if (st.size > limit) throw new ToolsError(`it has more than the ${limit} bytes it should have`);
    const fd = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, readFileSync(src)); } finally { closeSync(fd); }
  };
}

/** The fetch of a source: https for Google's repository, a folder copy for a test's absolute folder. */
export const fetchFor = (source: ChromeSource): Fetch => (source.repo.startsWith("https://") ? httpsFetch : isAbsolute(source.repo) ? folderFetch(source.repo) : async () => { throw new ToolsError("the repository is neither https nor a local folder"); });

/** Run a program with its own environment, no stdin, its text output, and a timeout (then SIGKILL). */
export const runProgram: Run = (argv, env, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn(argv[0], argv.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout!.on("data", (d) => { if (stdout.length < 1 << 20) stdout += d; });
  child.stderr!.on("data", (d) => { if (stderr.length < 1 << 16) stderr += d; });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  child.once("error", (e) => { clearTimeout(timer); reject(e); });
  child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
});

/** The first program named `name` on PATH (an executable file), or null. */
export function which(name: string, path = process.env.PATH ?? ""): string | null {
  if (name.includes("/")) return isAbsolute(name) && isExecutable(name) ? name : null;
  for (const dir of path.split(delimiter)) if (dir && isAbsolute(dir) && isExecutable(join(dir, name))) return join(dir, name);
  return null;
}
function isExecutable(p: string): boolean { try { const st = statSync(p); return st.isFile() && (st.mode & 0o111) !== 0; } catch { return false; } }

let flockFn: ((fd: number, op: number) => number) | null | undefined;
/** flock(2) through node:ffi (the same lock as agentwatch's Python install); null when it does not load. */
async function loadFlock(): Promise<((fd: number, op: number) => number) | null> {
  if (flockFn !== undefined) return flockFn;
  try {
    const mod: any = await import("node:ffi");
    const ffi = mod.default ?? mod;
    flockFn = ffi.dlopen("libc.so.6", { flock: { return: "int32", arguments: ["int32", "int32"] } }).functions.flock;
  } catch { flockFn = null; }
  return flockFn ?? null;
}
const LOCK_EX = 2, LOCK_NB = 4;
/** The real lock: flock with LOCK_NB, again every 100 ms while `wait` (at most LOCK_WAIT_MS). Closing the fd releases it. */
export const flockLocker: Locker = async (path, wait) => {
  const flock = await loadFlock();
  if (!flock) throw new ToolsError("the tools lock cannot be taken (node:ffi does not load)");
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  const t0 = Date.now();
  for (;;) {
    if (flock(fd, LOCK_EX | LOCK_NB) === 0) return () => closeSync(fd);
    if (!wait) { closeSync(fd); return null; }
    if (Date.now() - t0 > LOCK_WAIT_MS) { closeSync(fd); throw new ToolsError("another install holds the Google Chrome lock of the tools folder"); }
    await new Promise((r) => setTimeout(r, 100));
  }
};

// ------------------------------------------------------------------ the tools

/** What the Chrome unit and its updater need of the tools folder (a test gives a fake). */
export interface ChromeTools {
  /** Whether this box can run the tools copy: null, else why not. */
  unsupported(): string | null;
  /** The newest installed copy whose version is not in `skip` and, with `upto`, not newer than `upto`; or null. */
  newest(skip?: ReadonlySet<string>, upto?: string | null): ChromeCopy | null;
  /** Read Google's signed index: its newest stable entry. */
  latestEntry(): Promise<DebEntry>;
  /** Install `entry` (default the newest stable); never a downgrade. */
  ensure(entry?: DebEntry): Promise<ChromeCopy>;
  /** Remove the copies not in `keep` that no process runs, and the leftovers of a cut install; the removed paths. Never throws. */
  prune(keep: ReadonlySet<string>): Promise<string[]>;
}

export type GoogleChromeOptions = {
  /** The tools folder. */
  tools: string;
  source?: ChromeSource;
  fetch?: Fetch;
  run?: Run;
  lock?: Locker;
  which?: (name: string) => string | null;
  procRoot?: string;
  freeBytes?: (path: string) => number;
  platform?: NodeJS.Platform;
  arch?: string;
  uid?: number;
  log?: (line: string) => void;
};

/** The real ChromeTools: Google Chrome stable in <tools>/google-chrome/<version>/. */
export class GoogleChromeTools implements ChromeTools {
  readonly root: string;
  private readonly o: GoogleChromeOptions;
  readonly source: ChromeSource;
  constructor(o: GoogleChromeOptions) {
    this.o = o;
    this.root = join(o.tools, "google-chrome");
    this.source = o.source ?? GOOGLE_SOURCE;
  }
  private get which() { return this.o.which ?? ((n: string) => which(n)); }
  private get run() { return this.o.run ?? runProgram; }
  private get fetch() { return this.o.fetch ?? fetchFor(this.source); }
  private get lock() { return this.o.lock ?? flockLocker; }
  private log(line: string) { this.o.log?.(line); }

  copyOf(version: string): ChromeCopy { const root = join(this.root, version); return { version, root, binary: join(root, BINARY_REL) }; }

  private copyOk(root: string): boolean {
    try {
      const st = lstatSync(root), b = lstatSync(join(root, BINARY_REL));
      return st.isDirectory() && !st.isSymbolicLink() && b.isFile() && !b.isSymbolicLink();
    } catch { return false; }
  }

  unsupported(): string | null {
    const platform = this.o.platform ?? process.platform, arch = this.o.arch ?? process.arch;
    if (platform !== "linux") return `Google Chrome in the tools folder needs Linux (this box runs ${platform})`;
    if (arch !== "x64") return `Google Chrome in the tools folder needs an x86_64 box (this box is ${arch})`;
    if (!this.which("gpgv")) return "gpgv is not installed (it checks the signature of Google's Chrome index)";
    if (!this.which("xz")) return "xz is not installed (it unpacks the Google Chrome package)";
    return null;
  }

  /** The complete copies, oldest first (by the numbers of the version). */
  installed(): ChromeCopy[] {
    let names: string[];
    try { names = readdirSync(this.root); } catch { return []; }
    return names.filter((n) => VERSION_RE.test(n) && this.copyOk(join(this.root, n))).map((n) => this.copyOf(n))
      .sort((a, b) => compareKeys(versionKey(a.version)!, versionKey(b.version)!));
  }

  newest(skip: ReadonlySet<string> = new Set(), upto: string | null = null): ChromeCopy | null {
    const v = pickVersion(this.installed().map((c) => c.version), skip, upto);
    return v === null ? null : this.copyOf(v);
  }

  private refuseRoot(): void {
    if ((this.o.uid ?? process.getuid?.() ?? -1) === 0) throw new ToolsError("the tools folder is never written as root");
  }

  private async locked<T>(f: () => Promise<T>): Promise<T> {
    mkdirSync(this.o.tools, { recursive: true, mode: 0o700 });
    const release = await this.lock(join(this.o.tools, ".google-chrome.lock"), true);
    try { return await f(); } finally { release?.(); }
  }

  private distUrl(path: string) { return `${this.source.repo}/dists/${this.source.suite}/${path}`; }

  private async fetchTo(url: string, dest: string, timeout: number, limit: number, what: string): Promise<void> {
    try { await this.fetch(url, dest, timeout, limit); }
    catch (e) {
      if (e instanceof ToolsError) throw new ToolsError(`${what} could not be downloaded: ${e.message}`);
      const err = e as NodeJS.ErrnoException;
      throw new ToolsError(`${what} could not be downloaded: ${err.name}: ${String(err.code ?? err.message).slice(0, 200)}`);
    }
  }

  private checkFile(path: string, sha256: string, size: number, what: string): Promise<void> {
    const actual = statSync(path).size;
    if (actual !== size) throw new ToolsError(`${what} failed its size check (expected ${size} bytes, got ${actual})`);
    return new Promise((resolve, reject) => {
      const h = createHash("sha256");
      createReadStream(path).on("data", (d) => h.update(d)).on("error", reject).on("end", () => {
        const got = h.digest("hex");
        if (got !== sha256) reject(new ToolsError(`${what} failed its SHA-256 check (expected ${sha256}, got ${got})`));
        else resolve();
      });
    });
  }

  private workDir(prefix: string): string {
    mkdirSync(this.root, { recursive: true, mode: 0o755 });
    const p = join(this.root, `.${prefix}.${randomBytes(6).toString("hex")}.tmp`);
    mkdirSync(p, { mode: 0o700 });
    return p;
  }

  async latestEntry(): Promise<DebEntry> {
    this.refuseRoot();
    return this.locked(() => this.latestEntryLocked());
  }

  private async latestEntryLocked(): Promise<DebEntry> {
    const gpgv = this.which("gpgv");
    if (!gpgv) throw new ToolsError("gpgv is not installed (it checks the signature of Google's Chrome index)");
    const work = this.workDir("index");
    try {
      let armored: string;
      try { armored = readFileSync(this.source.keyFile, "ascii"); } catch (e) { throw new ToolsError(`the Google signing key file cannot be read: ${(e as NodeJS.ErrnoException).code ?? "error"}`); }
      const keyring = join(work, "google-linux-signing-key.gpg");
      writeFileSync(keyring, dearmor(armored), { mode: 0o600, flag: "wx" });
      const signed = join(work, "InRelease");
      await this.fetchTo(this.distUrl("InRelease"), signed, INDEX_FETCH_TIMEOUT_MS, MAX_INRELEASE_BYTES, "Google's Chrome index");
      const listed = parseInreleaseSha256(await verifyInrelease(signed, keyring, join(work, "InRelease.verified"), { run: this.run, gpgv, source: this.source }));
      const plain = `main/binary-${this.source.arch}/Packages`;
      const path = listed.has(plain) ? plain : `${plain}.gz`;
      const item = listed.get(path);
      if (!item) throw new ToolsError(`Google's Chrome index lists no Packages file for ${this.source.arch}`);
      const [digest, size] = item;
      if (size > MAX_PACKAGES_BYTES) throw new ToolsError("Google's Chrome package list is too large");
      const packages = join(work, path.split("/").pop()!);
      await this.fetchTo(this.distUrl(path), packages, INDEX_FETCH_TIMEOUT_MS, size, "Google's Chrome package list");
      await this.checkFile(packages, digest, size, "Google's Chrome package list");
      let data = readFileSync(packages);
      if (path.endsWith(".gz")) {
        try { data = gunzipSync(data, { maxOutputLength: MAX_PACKAGES_BYTES }); }
        catch (e) { throw new ToolsError((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? "Google's Chrome package list is too large" : `Google's Chrome package list is damaged: ${(e as Error).name}`); }
      }
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { throw new ToolsError("Google's Chrome package list is damaged: not UTF-8"); }
      const entry = parsePackages(text, this.source);
      if (!entry) throw new ToolsError(`Google's Chrome package list has no ${this.source.package} entry`);
      return entry;
    } finally { rmSync(work, { recursive: true, force: true }); }
  }

  /**
   * Install `entry` (default: the newest stable of the signed index). No downgrade: when `entry` is the same as or
   * older than the newest copy, that copy comes back and no .deb is fetched.
   */
  async ensure(entry?: DebEntry): Promise<ChromeCopy> {
    this.refuseRoot();
    const why = this.unsupported();
    if (why) throw new ToolsError(why);
    return this.locked(async () => {
      const e = entry ?? await this.latestEntryLocked();
      if (!entryOk(e)) throw new ToolsError("the Google Chrome entry is malformed");
      const newest = this.newest();
      if (newest && !newer(e.version, newest.version)) return newest;
      mkdirSync(this.root, { recursive: true, mode: 0o755 });
      const free = (this.o.freeBytes ?? ((p) => { const s = statfsSync(p); return s.bavail * s.bsize; }))(this.o.tools);
      if (free < MIN_FREE_BYTES) throw new ToolsError("not enough free disk space for Google Chrome (1 GiB needed)");
      const deb = join(this.root, `.${e.version}.${randomBytes(6).toString("hex")}.deb`);
      closeSync(openSync(deb, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
      let work: string | null = null;
      try {
        await this.fetchTo(`${this.source.repo}/${e.filename}`, deb, DEB_FETCH_TIMEOUT_MS, e.size, "the Google Chrome package");
        await this.checkFile(deb, e.sha256, e.size, "the Google Chrome package");
        work = this.workDir(e.version);
        await extractChrome(deb, work, this.which("xz")!);
        rmSync(deb, { force: true });
        await this.checkRuns(join(work, BINARY_REL), e.version);
        const final = join(this.root, e.version);
        rmSync(final, { recursive: true, force: true }); // a broken leftover: copyOk() was false
        renameSync(work, final);
        work = null;
      } finally {
        if (work) rmSync(work, { recursive: true, force: true });
        rmSync(deb, { force: true });
      }
      this.log(`tools: Google Chrome ${e.version} installed`);
      return this.copyOf(e.version);
    });
  }

  /** `<binary> --version` must start with "Google Chrome " and hold the version's four numbers; a new empty HOME. */
  private async checkRuns(binary: string, version: string): Promise<void> {
    const home = this.workDir(`${version}.home`);
    const env: Record<string, string> = { HOME: home };
    for (const k of ["PATH", "LANG"]) if (process.env[k] !== undefined) env[k] = process.env[k]!;
    const prefix = "Google Chrome does not run on this box: ";
    let r: Awaited<ReturnType<Run>>;
    try { r = await this.run([binary, "--version"], env, VERSION_TIMEOUT_MS); }
    catch (e) { throw new ToolsError(prefix + `${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`.slice(0, 200)); }
    finally { rmSync(home, { recursive: true, force: true }); }
    if (r.timedOut) throw new ToolsError(prefix + `no answer to --version within ${VERSION_TIMEOUT_MS / 1000} s`);
    const numbers = version.split("-")[0];
    const words = r.stdout.split(/\s+/).filter(Boolean);
    if (r.code === 0 && r.stdout.startsWith("Google Chrome ")) {
      if (words.includes(numbers)) return;
      throw new ToolsError(`Google Chrome reports version ${(words[2] ?? "nothing").slice(0, 40)}, not ${numbers}`);
    }
    if (r.code === 0) throw new ToolsError(`the unpacked binary reports '${(r.stdout.trim().split("\n")[0] ?? "").slice(0, 100)}', not Google Chrome ${numbers}`);
    const lines = r.stderr.split("\n").map((l) => l.trim()).filter(Boolean);
    let detail = lines[0] ?? (r.stdout.trim().split("\n")[0] || `exit status ${r.code}`);
    if (detail.startsWith(`${binary}: `)) detail = detail.slice(binary.length + 2);
    throw new ToolsError(prefix + detail.slice(0, 200));
  }

  /** The binaries that processes run (their exe links and absolute argv[0]), or null when /proc cannot be listed. */
  private runningBinaries(): Set<string> | null {
    const proc = this.o.procRoot ?? "/proc";
    let names: string[];
    try { names = readdirSync(proc); } catch { return null; }
    const out = new Set<string>();
    for (const n of names) {
      if (!/^[0-9]+$/.test(n)) continue;
      try { const t = readlinkSync(join(proc, n, "exe")); out.add(t.endsWith(" (deleted)") ? t.slice(0, -" (deleted)".length) : t); } catch {}
      try {
        const raw = readFileSync(join(proc, n, "cmdline"));
        const z = raw.indexOf(0);
        const argv0 = (z < 0 ? raw : raw.subarray(0, z)).toString("utf8");
        if (argv0.startsWith("/")) { try { out.add(realpathSync(argv0)); } catch { out.add(argv0); } }
      } catch {}
    }
    return out;
  }

  async prune(keep: ReadonlySet<string>): Promise<string[]> {
    const removed: string[] = [];
    try {
      if ((this.o.uid ?? process.getuid?.() ?? -1) === 0) return removed;
      let st;
      try { st = lstatSync(this.root); } catch { return removed; }
      if (st.isSymbolicLink() || !st.isDirectory()) return removed;
      const release = await this.lock(join(this.o.tools, ".google-chrome.lock"), false);
      if (!release) { this.log("tools prune: a Google Chrome install runs; its folder waits"); return removed; }
      try {
        const binaries = this.runningBinaries();
        const newest = this.newest();
        const kept = new Set([...keep, ...(newest ? [newest.version] : [])]);
        for (const name of readdirSync(this.root)) {
          const path = join(this.root, name);
          let s;
          try { s = lstatSync(path); } catch { continue; }
          if (s.isSymbolicLink()) continue;
          if (s.isDirectory() && (VERSION_RE.test(name) || LEFTOVER_TMP.test(name))) {
            if (kept.has(name) || binaries === null) continue;
            const real = realpathSync(path);
            if ([...binaries].some((b) => b === real || b.startsWith(real + sep))) continue;
          } else if (!(s.isFile() && LEFTOVER_DEB.test(name))) continue;
          rmSync(path, { recursive: true, force: true });
          if (!existsSync(path)) removed.push(path);
        }
      } finally { release(); }
    } catch (e) { this.log(`tools prune: Google Chrome: ${(e as Error).name}`); }
    return removed;
  }
}
