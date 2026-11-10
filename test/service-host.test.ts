// The host shim, `agent-browser host` (stage 1b part 2 of the self-contained agent browser, board ab-v16.94.9; the
// design, section 5.3): Chrome starts it for the receiver; it relays Chrome's native frames (a 4-byte little-endian
// length and JSON) to one JSON line on the service's link socket and back, says {"t":"link","up":true} after each
// connect, tries its socket again each second while Chrome's port is open, and keeps today's host's own parent check.
// The cases of agentwatch's tests/daemon/browser/test_native_host.py, ported.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { ENV_PROFILE, ENV_SOCKET, MAX_FROM_EXTENSION, namesProfile, parentRunsProfile, runHost } from "../src/service/link/host.ts";

const BIN = fileURLToPath(new URL("../bin/agent-browser.js", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PROFILE = "/p/profile";
const native = (o: object | Buffer) => { const b = Buffer.isBuffer(o) ? o : Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h, b]); };

/** A fake /proc whose pid 77 runs `cmdline`. */
function procRoot(dir: string, cmdline = Buffer.from(`chrome\0--user-data-dir=${PROFILE}\0--no-first-run\0`)): string {
  const root = join(dir, "proc");
  mkdirSync(join(root, "77"), { recursive: true });
  writeFileSync(join(root, "77", "cmdline"), cmdline);
  return root;
}

/** The link socket's side of a test: it takes each connection and reads its lines. */
class LinkServer {
  readonly server: Server;
  private readonly conns: Socket[] = [];
  private readonly waiting: ((s: Socket) => void)[] = [];
  readonly path: string;
  constructor(path: string) {
    this.path = path;
    this.server = createServer((s) => { const w = this.waiting.shift(); if (w) w(s); else this.conns.push(s); });
  }
  listen(): Promise<void> { return new Promise((r) => this.server.listen(this.path, () => r())); }
  accept(ms = 5000): Promise<Socket> {
    const s = this.conns.shift();
    if (s) return Promise.resolve(s);
    return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error("no connection")), ms); this.waiting.push((c) => { clearTimeout(t); resolve(c); }); });
  }
  close(): Promise<void> { for (const c of this.conns) c.destroy(); return new Promise((r) => this.server.close(() => r())); }
}
/** The next line on a socket. */
function readLine(s: Socket, ms = 5000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => { s.off("data", on); reject(new Error("no line")); }, ms);
    const on = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf(10);
      if (i < 0) return;
      clearTimeout(t); s.off("data", on);
      if (i + 1 < buf.length) s.unshift(buf.subarray(i + 1));
      resolve(buf.subarray(0, i + 1));
    };
    s.on("data", on);
  });
}
/** The host's frames to Chrome, read one at a time. */
class Frames {
  private buf = Buffer.alloc(0);
  private readonly waiters: (() => void)[] = [];
  constructor(stream: PassThrough | NodeJS.ReadableStream) { stream.on("data", (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); for (const w of this.waiters.splice(0)) w(); }); }
  async next(ms = 5000): Promise<any> {
    const end = Date.now() + ms;
    for (;;) {
      if (this.buf.length >= 4) {
        const n = this.buf.readUInt32LE(0);
        if (this.buf.length >= 4 + n) { const body = this.buf.subarray(4, 4 + n); this.buf = this.buf.subarray(4 + n); return JSON.parse(body.toString("utf8")); }
      }
      if (Date.now() > end) throw new Error("no frame");
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 50); });
    }
  }
}

/** A host in this process, with a parent that runs the agent profile in a fake /proc. */
function rig(t: { after: (f: () => Promise<void> | void) => void }, o: { listen?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ab-host-"));
  const path = join(dir, "link.sock");
  const server = new LinkServer(path);
  const stdin = new PassThrough(), stdout = new PassThrough();
  const frames = new Frames(stdout);
  const logs: string[] = [];
  const start = () => runHost({ env: { [ENV_SOCKET]: path, [ENV_PROFILE]: PROFILE }, stdin, stdout, ppid: 77, procRoot: procRoot(dir), platform: "linux", log: (l) => logs.push(l), retryMs: 100 });
  t.after(async () => { stdin.end(); await server.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
  return { dir, path, server, stdin, frames, logs, start, listen: o.listen === false ? null : server.listen() };
}

test("after its connect the host says link up, then relays a frame to one line and a line to one frame; stdin's end exits 0", async (t) => {
  const r = rig(t);
  await r.listen;
  const code = r.start();
  const conn = await r.server.accept();
  assert.deepEqual(await r.frames.next(), { t: "link", up: true });
  r.stdin.write(native({ t: "hello", v: 2, version: "0.3.6" }));
  assert.deepEqual(JSON.parse(String(await readLine(conn))), { t: "hello", v: 2, version: "0.3.6" });
  conn.write('{"t":"part","id":"a","seq":0,"n":1,"b64":"e30="}\n');
  assert.equal((await r.frames.next()).id, "a");
  r.stdin.end();
  assert.equal(await code, 0);
});

test("a message with a raw newline is made compact; a message that is not JSON then is dropped", async (t) => {
  const r = rig(t);
  await r.listen;
  void r.start();
  const conn = await r.server.accept();
  await r.frames.next();
  r.stdin.write(native(Buffer.from('{"t":"res",\n "id":"a"}')));
  assert.equal(String(await readLine(conn)), '{"t":"res","id":"a"}\n');
  r.stdin.write(native(Buffer.from('not\njson')));
  r.stdin.write(native({ t: "after" }));
  assert.equal(String(await readLine(conn)), '{"t":"after"}\n');
  assert.ok(r.logs.some((l) => l.includes("not JSON")));
});

test("the host connects again after the socket closes and says link up again", async (t) => {
  const r = rig(t);
  await r.listen;
  void r.start();
  const conn = await r.server.accept();
  assert.deepEqual(await r.frames.next(), { t: "link", up: true });
  conn.destroy();
  const conn2 = await r.server.accept();
  assert.deepEqual(await r.frames.next(), { t: "link", up: true });
  r.stdin.write(native({ t: "ping2" }));
  assert.deepEqual(JSON.parse(String(await readLine(conn2))), { t: "ping2" });
});

test("a line above 1,000,000 bytes is not forwarded, and the next line is", async (t) => {
  const r = rig(t);
  await r.listen;
  void r.start();
  const conn = await r.server.accept();
  await r.frames.next();
  const big = `{"t":"x","pad":"${"a".repeat(1_000_001 - 18)}"}`;
  assert.equal(Buffer.byteLength(big), 1_000_001);
  conn.write(`${big}\n{"t":"after"}\n`);
  assert.deepEqual(await r.frames.next(), { t: "after" });
});

test("a message that comes while the socket is down is dropped; later ones go", async (t) => {
  const r = rig(t, { listen: false });
  void r.start();
  r.stdin.write(native({ t: "lost" }));
  await sleep(200);
  await r.server.listen();
  const conn = await r.server.accept();
  assert.deepEqual(await r.frames.next(), { t: "link", up: true });
  r.stdin.write(native({ t: "kept" }));
  assert.deepEqual(JSON.parse(String(await readLine(conn))), { t: "kept" });
});

test("stdin's end while no socket listens exits 0", async (t) => {
  const r = rig(t, { listen: false });
  const code = r.start();
  await sleep(100);
  r.stdin.end();
  assert.equal(await code, 0);
});

test("a missing socket or profile variable is exit 2; a parent that does not run the agent profile is exit 3, with no connect", { timeout: 10_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ab-host-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const io = { stdin: new PassThrough(), stdout: new PassThrough(), log: () => {} };
  assert.equal(await runHost({ ...io, env: {}, ppid: 77 }), 2);
  assert.equal(await runHost({ ...io, env: { [ENV_SOCKET]: "/x/link.sock" }, ppid: 77 }), 2);
  const server = new LinkServer(join(dir, "link.sock"));
  await server.listen();
  t.after(() => server.close());
  assert.equal(await runHost({ ...io, env: { [ENV_SOCKET]: server.path, [ENV_PROFILE]: PROFILE }, ppid: 77, procRoot: procRoot(dir, Buffer.from("bash\0")), platform: "linux" }), 3);
  await assert.rejects(server.accept(300));
});

test("the parent check: the agent profile as a whole argument, or in a joined process title before the end or ' --'", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ab-host-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(await parentRunsProfile(77, PROFILE, { platform: "linux", procRoot: procRoot(dir) }), true);
  const d2 = mkdtempSync(join(dir, "b"));
  assert.equal(await parentRunsProfile(77, PROFILE, { platform: "linux", procRoot: procRoot(d2, Buffer.from("chrome\0--user-data-dir=/p/profile2\0")) }), false);
  assert.equal(await parentRunsProfile(77, PROFILE, { platform: "linux", procRoot: join(dir, "none") }), false);
  for (const [line, profile, want] of [
    ["/opt/chrome --user-data-dir=/p/profile --no-first-run", "/p/profile", true],
    ["/opt/chrome --user-data-dir=/p/profile2 --no-first-run", "/p/profile", false],
    ["/opt/chrome --user-data-dir=/p/profile", "/p/profile", true],
    ["/opt/chrome --user-data-dir=/U/a b/profile --x", "/U/a", false],
    ["/opt/chrome --user-data-dir=/U/a b/profile --x", "/U/a b/profile", true],
  ] as const) {
    assert.equal(namesProfile([line], profile), want, line);
    const d = mkdtempSync(join(dir, "c"));
    assert.equal(await parentRunsProfile(77, profile, { platform: "linux", procRoot: procRoot(d, Buffer.from(`${line}\0`)) }), want, line);
  }
});

test("the parent check on the Mac reads the ps line, and other platforms never match", async () => {
  const line = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/U/a b/profile --no-first-run";
  assert.equal(await parentRunsProfile(5, "/U/a b/profile", { platform: "darwin", psLine: async () => line }), true);
  assert.equal(await parentRunsProfile(5, "/U/a b/prof", { platform: "darwin", psLine: async () => line }), false);
  assert.equal(await parentRunsProfile(5, "/U/p", { platform: "darwin", psLine: async () => "chrome --user-data-dir=/U/p" }), true);
  assert.equal(await parentRunsProfile(5, "/U/p", { platform: "darwin", psLine: async () => null }), false);
  assert.equal(await parentRunsProfile(5, "/p", { platform: "win32", psLine: async () => "--user-data-dir=/p" }), false);
});

test("a line of more than 2 MiB with no end drops the socket, and the host connects again", async (t) => {
  const r = rig(t);
  await r.listen;
  void r.start();
  const conn = await r.server.accept();
  assert.equal((await r.frames.next()).up, true);
  conn.write(Buffer.alloc(2 * 1024 * 1024 + 10, 97));
  const conn2 = await r.server.accept();
  assert.deepEqual(await r.frames.next(), { t: "link", up: true });
  r.stdin.write(native({ t: "again" }));
  assert.deepEqual(JSON.parse(String(await readLine(conn2))), { t: "again" });
  conn.destroy();
});

test("a size header above 64 MiB ends the host with 0", async (t) => {
  const r = rig(t);
  await r.listen;
  const code = r.start();
  await r.server.accept();
  await r.frames.next();
  const h = Buffer.alloc(4);
  h.writeUInt32LE(MAX_FROM_EXTENSION + 1);
  r.stdin.write(h);
  assert.equal(await code, 0);
});

test("the host connects again after the socket file is removed and bound again (a restart of the service)", async (t) => {
  const r = rig(t);
  await r.listen;
  void r.start();
  const conn = await r.server.accept();
  await r.frames.next();
  conn.destroy();
  await r.server.close();
  const server2 = new LinkServer(r.path);
  await server2.listen();
  t.after(() => server2.close());
  const conn2 = await server2.accept();
  assert.deepEqual(await r.frames.next(), { t: "link", up: true });
  r.stdin.write(native({ t: "after" }));
  assert.deepEqual(JSON.parse(String(await readLine(conn2))), { t: "after" });
});

test("`agent-browser host` as a process under a parent on the agent profile: it relays, logs no message body, and exits 0 at stdin's end", { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ab-host-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const server = new LinkServer(join(dir, "link.sock"));
  await server.listen();
  t.after(() => server.close());
  const profile = join(dir, "profile");
  // The parent: a node process with --user-data-dir=<profile> on its command line, which starts the host as Chrome does.
  const child = `const { spawn } = require("node:child_process"); const p = spawn(process.execPath, [process.argv[1], "host", "chrome-extension://x/"], { stdio: "inherit" }); p.on("exit", (c) => process.exit(c ?? 1));`;
  const p = spawn(process.execPath, ["-e", child, BIN, `--user-data-dir=${profile}`], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", [ENV_SOCKET]: server.path, [ENV_PROFILE]: profile } });
  t.after(() => { if (p.exitCode === null) p.kill("SIGKILL"); });
  let err = "";
  p.stderr!.on("data", (d) => (err += d));
  const frames = new Frames(p.stdout!);
  const conn = await server.accept(10_000);
  assert.deepEqual(await frames.next(10_000), { t: "link", up: true });
  p.stdin!.write(native({ t: "hello", secret: "not-in-logs-123" }));
  assert.equal(JSON.parse(String(await readLine(conn))).t, "hello");
  p.stdin!.end();
  assert.equal(await new Promise((r) => p.once("exit", (c) => r(c))), 0);
  assert.doesNotMatch(err, /not-in-logs-123/);
});

test("`agent-browser host` under a parent that is not on the agent profile exits 3 and never connects", { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ab-host-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const server = new LinkServer(join(dir, "link.sock"));
  await server.listen();
  t.after(() => server.close());
  const p = spawn(process.execPath, [BIN, "host", "chrome-extension://x/"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", [ENV_SOCKET]: server.path, [ENV_PROFILE]: join(dir, "profile") } });
  let err = "";
  p.stderr!.on("data", (d) => (err += d));
  assert.equal(await new Promise((r) => p.once("exit", (c) => r(c))), 3);
  assert.match(err, /not the agent Chrome on its profile/);
  await assert.rejects(server.accept(200));
});
