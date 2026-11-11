// The relay's peer check (board ab-v16.51; contract C11 of chrome-extension's docs/protocol.md at main 40c2d93, "The
// scope's session (the peer check)"; the design: docs/superpowers/specs/2026-11-05-peer-admission-design.md). The
// shared vectors (copies of chrome-extension's test/vectors/ at 40c2d93) give the peer and a fake process table, so the
// relay runs here with a fake reader behind the same reader interface as Linux and the Mac: the roots in the line, the
// order of the checks before the upgrade, and the 1008 close at a root change. On Linux the real reader runs too: the
// self-test (from a child process, its kernel branch, its compares and its time limit), and the relay with
// --peer-check against real processes of this test. node:ffi loads only for --peer-check.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { startRelay } from "../src/relay/endpoint.ts";
import { CLOSE, NOT_READY } from "../src/relay/model.ts";
import { LinuxReader, parseCgroup, parseStat, PEER_UNREAD, PeerGate, readPeer, selfTest, sessionRefusal, type Form, type PeerReader } from "../src/relay/peer.ts";
import { parseRoots } from "../src/relay/scopes.ts";
import { harness, raw, until, type Harness } from "./fake-bridge.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const vectors = (name: string) => JSON.parse(readFileSync(new URL(`./vectors/chrome-extension-40c2d93/${name}.json`, import.meta.url), "utf8"));
const scopesV = vectors("scopes"), endpointV = vectors("endpoint");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const answer = (id: string) => endpointV.upgradeAnswers.find((a: any) => a.id === id);
const closeOf = (id: string) => { const c = endpointV.closes.find((x: any) => x.id === id); return [c.code, c.reason]; };
/** The vectors' uid of the relay (procsNote). */
const UID = 1001;
const linux = process.platform === "linux";

// ------------------------------------------------------------------ the fake reader of the vectors

type FakeProc = { pid: number; ppid: number; start: number; state: string; cgroup: string | null };
type FakePeer = { read: boolean; pid: number; uid: "own" | "other"; pidfd?: { poll: number; fdinfoPid: number } | null; start?: number | null };

/** A reader of the vectors' world: the process table (with the case's replaced entries) and the peer as data. */
function fakeReader(form: Form, world: string, first: FakePeer, replace: any[] = []) {
  let peer = first;
  const table = new Map<number, FakeProc>(endpointV.procs.filter((p: any) => p.world === world).map((p: any) => [p.pid, p]));
  for (const p of replace) { if (p.gone) table.delete(p.pid); else table.set(p.pid, { ...table.get(p.pid), ...p }); }
  const closed: number[] = [];
  let next = 100;
  const reader: PeerReader & { closed: number[]; table: Map<number, FakeProc>; setPeer: (p: FakePeer) => void } = {
    form, closed, table, setPeer: (p) => { peer = p; },
    // A new pidfd number at each read, from 100 on.
    peer: () => (peer.read ? { pid: peer.pid, uid: peer.uid === "own" ? UID : UID + 1, pidfd: form === "pidfd" && peer.pidfd ? next++ : null, start: form === "pidfd" ? null : peer.start ?? null } : null),
    proc: (pid) => { const p = table.get(pid); return p ? { ppid: p.ppid, start: p.start, state: p.state } : null; },
    cgroup: (pid) => (world === "mac" ? null : table.get(pid)?.cgroup ?? null),
    poll: (fd) => { assert.ok(!closed.includes(fd), "a poll of a closed pidfd"); return peer.pidfd!.poll; },
    fdinfoPid: (fd) => { assert.ok(!closed.includes(fd), "a read of a closed pidfd"); return peer.pidfd!.fdinfoPid; },
    close: (fd) => { closed.push(fd); },
  };
  return reader;
}

const gateFor = (selfTest: string, reader: PeerReader) => (selfTest === "failed" ? new PeerGate({ failed: "the vector's self-test failed" }) : new PeerGate({ reader, uid: UID }));

/** A relay in the state of an upgradeChecks vector: the link, bridge.info and the last allowlist line (as relay-scopes.test.ts). */
async function inState(h: Harness, relay: { link: boolean; bridge: number | null; line: string | null }): Promise<void> {
  if (relay.bridge === null) h.fake.op = ({ op }) => (op === "bridge.info" ? new Promise(() => {}) : undefined);
  if (relay.bridge === 0) h.fake.info = { ...(h.fake.info as object), bridge: 0 };
  if (!relay.link) return;
  h.fake.line({ t: "link", up: true, version: "0.3.2" });
  if (relay.line) h.fake.line(endpointV.lines[relay.line]);
  if (relay.bridge === null) await until(() => h.fake.sent("bridge.info").length, "bridge.info");
  else if (relay.bridge === 0) await until(() => h.relay.model.notReady() === NOT_READY.old, "the too-old answer");
  else await until(() => h.fake.sent("debugger.getTargets").length && (relay.line ? h.relay.model.notReady() !== NOT_READY.link : true), "the steps of the link up");
  await sleep(10);
}

// ------------------------------------------------------------------ the roots in the line (scopes.json)

test("the roots in the line (scopes.json lines with the peer check): what applies of roots, by C11's rules", () => {
  const peerLines = scopesV.lines.filter((x: any) => x.peerCheck);
  assert.ok(peerLines.length >= 10);
  for (const v of peerLines) assert.deepEqual(Object.fromEntries(parseRoots(v.line)), v.roots, v.note);
  // A line of no object, or with no roots field: no scope has a root.
  for (const line of [null, 5, "x", [], { t: "allowlist" }]) assert.equal(parseRoots(line).size, 0, JSON.stringify(line));
  // A root that one scope names twice is one root.
  assert.deepEqual(parseRoots({ roots: { s: [{ pid: 2, start: 0 }, { pid: 2, start: 0 }] } }).get("s"), [{ pid: 2, start: 0 }]);
});

test("a relay with --peer-check applies the lists of every line, with or without roots; one with no roots field gives no scope a root (the session's 403)", async () => {
  for (const v of scopesV.lines.filter((x: any) => x.peerCheck && x.line.scopes["md-lead"] !== undefined)) {
    const reader = fakeReader("pidfd", "linux", { read: true, pid: 3102, uid: "own", pidfd: { poll: 0, fdinfoPid: 3102 } });
    const h = await harness({ peerCheck: gateFor("pidfd", reader) });
    try {
      await h.ready(v.line);
      assert.equal(h.relay.model.notReady(), null, v.note);
      assert.equal(h.relay.model.noList("md-lead"), false, `${v.note}: md-lead has its list`);
      // md-lead's process 3102 is admitted only when the line gives md-lead its root 3100 (6000).
      const admitted = (v.roots["md-lead"] ?? []).some((r: any) => r.pid === 3100 && r.start === 6000) && !Object.entries(v.roots).some(([s, l]: [string, any]) => s !== "md-lead" && l.some((r: any) => r.pid === 3100));
      const got = await raw(h.url("md-lead"));
      got.ws?.close();
      assert.deepEqual(got.ws ? 101 : [got.status, got.body], admitted ? 101 : [403, sessionRefusal(3102)], v.note);
    } finally { await h.close(); }
  }
});

// ------------------------------------------------------------------ the order of the checks (upgradeChecks)

test("the order of the checks before the upgrade with the peer check (upgradeChecks): each vector's answer, and each pidfd closed once", { timeout: 120_000 }, async () => {
  const cases = endpointV.upgradeChecks.filter((x: any) => x.peerCheck);
  assert.ok(cases.length >= 80);
  for (const v of cases) {
    const form = v.relay.selfTest === "failed" ? "pidfd" : v.relay.selfTest;
    const reader = fakeReader(form, v.world, v.peer, v.procs);
    const h = await harness({ peerCheck: gateFor(v.relay.selfTest, reader) });
    try {
      await inState(h, v.relay);
      const got = await raw(`ws+unix://${h.socket}:${v.request.path}`, v.request.headers);
      got.ws?.close();
      if (typeof v.answer === "object") assert.equal(got.ws ? 101 : got.status, v.answer.status, `${v.note}: ${got.body}`);
      else {
        const a = answer(v.answer);
        assert.deepEqual([got.status, got.body], [a.status, a.body.replace("<pid>", String(v.peer.pid))], v.note);
      }
      // The relay closes the peer's pidfd in every path, once (C11, the session check, item 4).
      const pidfd = v.relay.selfTest !== "failed" && form === "pidfd" && v.peer.read && v.peer.pidfd;
      await until(() => reader.closed.length >= (pidfd ? 1 : 0), "the pidfd's close");
      await sleep(5);
      assert.deepEqual(reader.closed, pidfd ? [100] : [], `${v.note}: the pidfd closes once`);
    } finally { await h.close(); }
  }
});

test("a plain request gets the same answers, and the peer of a connection that sends two requests stays until it closes", async () => {
  const reader = fakeReader("pidfd", "linux", { read: true, pid: 3102, uid: "own", pidfd: { poll: 0, fdinfoPid: 3102 } });
  const h = await harness({ peerCheck: gateFor("pidfd", reader) });
  try {
    await h.ready(endpointV.lines.peer);
    const { request } = await import("node:http");
    const agent = new (await import("node:http")).Agent({ keepAlive: true, maxSockets: 1 });
    const get = (path: string) => new Promise<[number, string]>((resolve, reject) => {
      request({ socketPath: h.socket, path, agent }, (res) => { let b = ""; res.setEncoding("utf8"); res.on("data", (d) => (b += d)).on("end", () => resolve([res.statusCode!, b])); }).on("error", reject).end();
    });
    // The scope's own process: its plain request gets the 404 (only the upgrade gets a connection).
    assert.equal((await get("/devtools/browser/md-lead"))[0], 404);
    assert.deepEqual(await get("/devtools/browser/md-worker"), [403, sessionRefusal(3102)]);
    assert.equal((await get("/devtools/browser/md-lead"))[0], 404, "the second request on one connection");
    assert.deepEqual(reader.closed, []);
    agent.destroy();
    await until(() => reader.closed.length === 1, "the close of the pidfd with its socket");
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ the 1008 close at a root change (lineCloses)

test("the 1008 closes of the peer check (lineCloses): a root that left its scope's roots, after the no-list close", async () => {
  const cases = endpointV.lineCloses.filter((x: any) => x.peerCheck);
  assert.ok(cases.length >= 10);
  for (const v of cases) {
    // A child of the connection's root (in the linux world) connects while the line gives md-lead both panes.
    const child = endpointV.procs.find((p: any) => p.world === "linux" && p.ppid === v.connection.root.pid).pid;
    const reader = fakeReader("pidfd", "linux", { read: true, pid: child, uid: "own", pidfd: { poll: 0, fdinfoPid: child } });
    const h = await harness({ peerCheck: gateFor("pidfd", reader) });
    try {
      await h.ready(endpointV.lines.peerTwoPanes);
      const conn = await raw(h.url(v.connection.scope));
      assert.ok(conn.ws, `${v.note}: ${conn.body}`);
      h.fake.line(endpointV.lines[v.line]);
      const closed = await Promise.race([conn.closed, sleep(150).then(() => null)]);
      if (v.close === null) { assert.equal(closed, null, v.note); conn.ws!.close(); }
      else assert.deepEqual(closed, closeOf(v.close), v.note);
    } finally { await h.close(); }
  }
  assert.deepEqual(CLOSE.root, closeOf("root"));
});

test("an end_scope with the peer check: the scope's new connections are refused until a line names it again; a process of the ended session gets the session's 403 first", async () => {
  const reader = fakeReader("pidfd", "linux", { read: true, pid: 3102, uid: "own", pidfd: { poll: 0, fdinfoPid: 3102 } });
  const h = await harness({ peerCheck: gateFor("pidfd", reader) });
  try {
    await h.ready(endpointV.lines.peer);
    const c = await raw(h.url("md-lead"));
    assert.ok(c.ws);
    h.fake.line({ t: "end_scope", scope: "md-lead" });
    assert.deepEqual(await c.closed, [1000, "The agentwatch session ended"]);
    // The pane still lives here: the session check passes, and the ended scope has no list (step 7).
    assert.deepEqual(await raw(h.url("md-lead")).then((r) => [r.status, r.body]), [503, NOT_READY.noList]);
    // The pane has ended (the usual case): its nohup job gets the session's 403, which comes before step 7.
    reader.table.delete(3100); reader.table.delete(3101);
    reader.setPeer({ read: true, pid: 3110, uid: "own", pidfd: { poll: 0, fdinfoPid: 3110 } });
    assert.deepEqual(await raw(h.url("md-lead")).then((r) => [r.status, r.body]), [403, sessionRefusal(3110)]);
    // A later line names the scope again: its ended mark goes (here its root is gone, so the job stays refused).
    h.fake.line(endpointV.lines.peer);
    await until(() => !h.relay.model.noList("md-lead"), "the line that names md-lead again");
    assert.deepEqual(await raw(h.url("md-lead")).then((r) => [r.status, r.body]), [403, sessionRefusal(3110)]);
  } finally { await h.close(); }
});

test("the link drops the line's roots with the line: after a link change the relay is not ready until a line comes", async () => {
  const reader = fakeReader("pidfd", "linux", { read: true, pid: 3102, uid: "own", pidfd: { poll: 0, fdinfoPid: 3102 } });
  const h = await harness({ peerCheck: gateFor("pidfd", reader) });
  try {
    await h.ready(endpointV.lines.peer);
    const peer = readPeer(reader, 0, UID)!;
    assert.deepEqual(h.relay.peer?.check("md-lead", peer), { pid: 3100, start: 6000 });
    assert.deepEqual(reader.closed, [], "a check alone closes no pidfd");
    h.fake.line({ t: "link", up: false });
    await until(() => h.relay.model.notReady() === NOT_READY.link, "the link down");
    assert.equal(h.relay.peer?.check("md-lead", peer), null, "no root after the link change");
    await h.ready(endpointV.lines.peerNoRoots);
    assert.equal(h.relay.peer?.check("md-lead", peer), null);
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ four rules of the check (ab-v16.61)

test("the session check asks twice whether the peer lives: a process that exits during the walk is refused, by its poll and by its fdinfo pid (ab-v16.61)", () => {
  // md-lead's process 3102 is admitted by the line `peer`. The reader answers by call number: the check polls once
  // before the walk (the first alive check) and once after it (the last one).
  const run = (poll: number[], pids: number[]) => {
    const reader = fakeReader("pidfd", "linux", { read: true, pid: 3102, uid: "own", pidfd: { poll: 0, fdinfoPid: 3102 } });
    let p = 0, f = 0;
    reader.poll = () => poll[Math.min(p++, poll.length - 1)];
    reader.fdinfoPid = () => pids[Math.min(f++, pids.length - 1)];
    const gate = new PeerGate({ reader, uid: UID });
    gate.setRoots(parseRoots(endpointV.lines.peer));
    const peer = readPeer(reader, 0, UID)!;
    return { root: gate.check("md-lead", peer), polls: p, infos: f };
  };
  assert.deepEqual(run([0, 0], [3102, 3102]), { root: { pid: 3100, start: 6000 }, polls: 2, infos: 2 }, "the baseline: admitted, two alive checks");
  assert.equal(run([1, 0], [3102, 3102]).root, null, "dead at the first alive check (poll)");
  assert.equal(run([0, 0], [-1, 3102]).root, null, "dead at the first alive check (fdinfo pid)");
  assert.equal(run([0, 1], [3102, 3102]).root, null, "exited during the walk (poll)");
  assert.equal(run([0, 0], [3102, -1]).root, null, "exited during the walk (fdinfo pid: reaped)");
  assert.equal(run([0, 0], [3102, 4242]).root, null, "the pidfd names another pid at the last check");
});

test("the self-test compares the pid that the peer's pidfd names with the child's, and the child's parent with the relay's pid (ab-v16.61)", { skip: !linux, timeout: 60_000 }, async () => {
  const { dir, socket } = endpointPath();
  const { createServer, connect } = await import("node:net");
  // A connection from this process to itself: SO_PEERPIDFD on its accepted end gives a pidfd that names this process.
  const own = join(dir, "own.sock");
  let ownFd = -1;
  const server = createServer((s) => { ownFd = (s as any)._handle.fd; });
  await new Promise<void>((r) => server.listen(own, r));
  const self = connect(own);
  await until(() => ownFd >= 0, "the self connection");
  try {
    const other = await selfTest(socket, { wrapLibc: (l) => ({ ...l, getsockopt: (fd, level, name, v, len) => l.getsockopt(name === 77 ? ownFd : fd, level, name, v, len) }) });
    assert.ok("failed" in other && /^the pidfd names pid \d+, not the child's \d+$/.test(other.failed) && other.failed.includes(`pid ${process.pid},`), JSON.stringify(other));
    // The child's parent is the relay: with another pid for the relay, the compare fails.
    const real = Object.getOwnPropertyDescriptor(process, "pid")!;
    Object.defineProperty(process, "pid", { value: process.pid + 1, configurable: true });
    let moved;
    try { moved = await selfTest(socket); } finally { Object.defineProperty(process, "pid", real); }
    assert.ok("failed" in moved && /^the child's parent is \d+, not the relay's \d+$/.test(moved.failed), JSON.stringify(moved));
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith(".peer-test-")), [], "the self-test's folder is gone");
  } finally { self.destroy(); server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a relay with the peer check closes a connection of a scope that the line no longer names with 1008, while the line's default has a list (namedOnly) (ab-v16.61)", async () => {
  const reader = fakeReader("pidfd", "linux", { read: true, pid: 3102, uid: "own", pidfd: { poll: 0, fdinfoPid: 3102 } });
  const h = await harness({ peerCheck: gateFor("pidfd", reader) });
  try {
    await h.ready(endpointV.lines.peer);
    const c = await raw(h.url("md-lead"));
    assert.ok(c.ws, c.body);
    // The scope has gone from the line (and its root); the default names a list. With the peer check a default counts for no scope.
    h.fake.line({ t: "allowlist", lists: { md: ["a.example"] }, scopes: {}, default: "md", roots: {} });
    assert.deepEqual(await Promise.race([c.closed, sleep(500).then(() => null)]), CLOSE.noList, "the no-list close, not the root's");
    assert.equal(h.relay.model.noList("md-lead"), true);
    assert.deepEqual(await raw(h.url("md-lead")).then((r) => [r.status, r.body]), [503, NOT_READY.noList]);
  } finally { await h.close(); }
});

test("an admitted connection holds no pidfd after its upgrade: the relay closes it at the upgrade, once, while the connection stays open (ab-v16.61)", async () => {
  const reader = fakeReader("pidfd", "linux", { read: true, pid: 3102, uid: "own", pidfd: { poll: 0, fdinfoPid: 3102 } });
  const h = await harness({ peerCheck: gateFor("pidfd", reader) });
  try {
    await h.ready(endpointV.lines.peer);
    const c = await raw(h.url("md-lead"));
    assert.ok(c.ws, c.body);
    await until(() => reader.closed.length === 1, "the close of the pidfd at the upgrade");
    await sleep(50);
    assert.deepEqual(reader.closed, [100], "closed while the connection is open");
    c.ws!.close();
    await c.closed;
    await sleep(50);
    assert.deepEqual(reader.closed, [100], "closed once: its socket's close adds none");
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ the readers

test("the stat and cgroup parsers: a process name with spaces and parentheses, field 22, the 0:: line", () => {
  assert.deepEqual(parseStat("4242 (a (b) c) S 4000 4242 4242 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 98765 1 2 3"), { state: "S", ppid: 4000, start: 98765 });
  assert.equal(parseStat("garbage"), null);
  assert.equal(parseCgroup("12:cpu:/x\n0::/user.slice/a.scope\n"), "/user.slice/a.scope");
  assert.equal(parseCgroup("12:cpu:/x\n"), null);
});

test("the peer read: no pid, another uid, a failed SO_PEERPIDFD or an unreadable start give the peer's 403, and a pidfd of a refused read closes", () => {
  const peer = (o: Partial<{ pid: number; uid: number; pidfd: number | null; start: number | null }>, form: Form = "pidfd") => {
    const closed: number[] = [];
    const r = { form, peer: () => ({ pid: 5, uid: UID, pidfd: 9, start: 1, ...o }), close: (fd: number) => closed.push(fd) } as unknown as PeerReader;
    return [readPeer(r, 3, UID) !== null, closed] as const;
  };
  assert.deepEqual(peer({}), [true, []]);
  assert.deepEqual(peer({ pid: 0 }), [false, [9]]);
  assert.deepEqual(peer({ uid: UID + 1 }), [false, [9]]);
  assert.deepEqual(peer({ pidfd: null }), [false, []]);
  assert.deepEqual(peer({ pidfd: null, start: null }, "stat"), [false, []]);
  assert.deepEqual(peer({ pidfd: null }, "stat"), [true, []]);
  assert.deepEqual(peer({ pidfd: null, start: null }, "mac"), [false, []]);
});

test("the Linux reader's poll tries EINTR again and counts only a real error as -1 (review-19b)", () => {
  let calls = 0, errno = 0;
  const libc = { getsockopt: () => -1, close: () => 0, errno: () => errno, poll: (fds: Buffer) => { calls++; if (calls < 3) { errno = 4; return -1; } fds.writeInt16LE(0, 6); return 0; } };
  assert.equal(new LinuxReader(libc, "pidfd").poll(7), 0);
  assert.equal(calls, 3);
  const bad = { ...libc, poll: () => { errno = 9; return -1; } };
  assert.equal(new LinuxReader(bad, "pidfd").poll(7), -1);
  const readable = { ...libc, poll: () => 1 };
  assert.equal(new LinuxReader(readable, "pidfd").poll(7), 1);
});

// ------------------------------------------------------------------ the self-test (Linux)

/** A socket path in a fresh folder of this test, as the endpoint's. */
function endpointPath(): { dir: string; socket: string } {
  const dir = mkdtempSync(join(tmpdir(), "ab-peer-"));
  return { dir, socket: join(dir, "cdp.sock") };
}
const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };

test("the self-test passes on this box from a child process: the pidfd form, the child stopped, its folder removed", { skip: !linux, timeout: 60_000 }, async () => {
  const { dir, socket } = endpointPath();
  try {
    let child: ChildProcess | undefined, folder: string | undefined;
    const r = await selfTest(socket, { onChild: (c) => { child = c; }, onFolder: (d) => { folder = d; } });
    assert.ok("reader" in r, JSON.stringify(r));
    assert.equal(r.reader.form, "pidfd", "taylor runs Linux 6.12: SO_PEERPIDFD");
    assert.equal(child!.spawnargs[1], "--disable-sigusr1", "the child holds SIGUSR1 too (board ab-v16.96)");
    assert.ok(folder && folder.startsWith(join(dir, ".peer-test-")) && !existsSync(folder), "the 0700 folder next to the endpoint socket is gone");
    await until(() => child!.exitCode !== null || child!.signalCode !== null, "the child's end");
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the self-test's kernel branch: ENOPROTOOPT (a kernel before 6.5) selects the stat form; another error of SO_PEERPIDFD fails it", { skip: !linux, timeout: 60_000 }, async () => {
  const { dir, socket } = endpointPath();
  try {
    const withPidfdErrno = (n: number) => ({ wrapLibc: (l: any) => {
      let fake = 0;
      return { ...l, getsockopt: (fd: number, level: number, name: number, v: Buffer, len: Buffer) => (name === 77 ? ((fake = n), -1) : ((fake = 0), l.getsockopt(fd, level, name, v, len))), errno: () => fake || l.errno() };
    } });
    const stat = await selfTest(socket, withPidfdErrno(92));
    assert.ok("reader" in stat && stat.reader.form === "stat", JSON.stringify(stat));
    const other = await selfTest(socket, withPidfdErrno(22));
    assert.deepEqual(other, { failed: "SO_PEERPIDFD failed (errno 22)" });
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the self-test compares the peer with the child: a reader that gives the relay's own pid (as a read of the listening fd does) fails it", { skip: !linux, timeout: 60_000 }, async () => {
  const { dir, socket } = endpointPath();
  try {
    const own = await selfTest(socket, { wrapLibc: (l) => ({ ...l, getsockopt: (fd, level, name, v, len) => { const r = l.getsockopt(fd, level, name, v, len); if (name === 17) v.writeInt32LE(process.pid, 0); return r; } }) });
    assert.ok("failed" in own && /^the peer's pid is \d+, not the child's \d+$/.test(own.failed), JSON.stringify(own));
    const uid = await selfTest(socket, { wrapLibc: (l) => ({ ...l, getsockopt: (fd, level, name, v, len) => { const r = l.getsockopt(fd, level, name, v, len); if (name === 17) v.writeUInt32LE(4242, 4); return r; } }) });
    assert.ok("failed" in uid && /^the peer's uid is 4242/.test(uid.failed), JSON.stringify(uid));
    const poll = await selfTest(socket, { wrapLibc: (l) => ({ ...l, poll: () => 1 }) });
    assert.deepEqual(poll, { failed: "the poll of the child's pidfd returned 1, not 0" });
    const cred = await selfTest(socket, { wrapLibc: (l) => ({ ...l, getsockopt: (fd, level, name, v, len) => (name === 17 ? -1 : l.getsockopt(fd, level, name, v, len)) }) });
    assert.deepEqual(cred, { failed: "SO_PEERCRED failed" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the self-test's time limit: a child that never connects fails it, and the child stops and the folder goes", { skip: !linux, timeout: 60_000 }, async () => {
  const { dir, socket } = endpointPath();
  try {
    let child: ChildProcess | undefined;
    const t0 = Date.now();
    const r = await selfTest(socket, { timeoutMs: 400, childScript: "setInterval(() => {}, 1000)", onChild: (c) => { child = c; } });
    assert.deepEqual(r, { failed: "the self-test took more than 400 ms" });
    assert.ok(Date.now() - t0 < 2000);
    await until(() => child!.signalCode === "SIGKILL", "the child's stop");
    assert.deepEqual(readdirSync(dir), []);
    // A path longer than 103 bytes fails before any child starts.
    const long = join(dir, "x".repeat(90), "cdp.sock");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "x".repeat(90)));
    const l = await selfTest(long);
    assert.ok("failed" in l && /longer than 103 bytes/.test(l.failed), JSON.stringify(l));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ the relay with --peer-check and real processes (Linux)

const WS = join(ROOT, "node_modules/ws/index.js");
/** A client process: it connects to its URL, prints one JSON line per event (open, close, refused) with its pid, and holds the connection. */
const CLIENT = `const WebSocket = require(${JSON.stringify(WS)}); const out = (o) => process.stdout.write(JSON.stringify({ pid: process.pid, ...o }) + "\\n");
const ws = new WebSocket(process.argv[1]); ws.on("open", () => out({ open: true }));
ws.on("close", (code, reason) => out({ close: [code, String(reason)] }));
ws.on("unexpected-response", (_q, res) => { let b = ""; res.on("data", (d) => (b += d)).on("end", () => { out({ status: res.statusCode, body: b }); process.exit(0); }); });
ws.on("error", () => {}); setInterval(() => {}, 1000);`;
/**
 * A pane-like process (the root of a scope): it prints its pid, then for each line on its standard input starts a
 * client as its own child (`<url>`), or as a job whose shell exits at once, so that it is re-parented (`detach <url>`).
 */
const PANE = `const { spawn } = require("node:child_process"); process.stdout.write(JSON.stringify({ pane: process.pid }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (l) => {
  const [what, url] = l.startsWith("detach ") ? ["detach", l.slice(7)] : ["child", l];
  if (what === "child") spawn(process.execPath, ["-e", process.argv[1], url], { stdio: ["ignore", "inherit", "inherit"] });
  else spawn("/bin/sh", ["-c", 'exec 0</dev/null; "$0" -e "$1" "$2" & exit 0', process.execPath, process.argv[1], url], { stdio: ["ignore", "inherit", "inherit"] });
});`;

type Proc = { child: ChildProcess; lines: any[]; next: (want: (l: any) => boolean, ms?: number) => Promise<any> };
function run(args: string[]): Proc {
  const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "inherit"] });
  const lines: any[] = [], waiters: { want: (l: any) => boolean; done: (l: any) => void }[] = [];
  createInterface({ input: child.stdout! }).on("line", (s) => {
    const l = JSON.parse(s);
    lines.push(l);
    for (const w of [...waiters]) if (w.want(l)) { waiters.splice(waiters.indexOf(w), 1); w.done(l); }
  });
  const next = (want: (l: any) => boolean, ms = 5000) => {
    const hit = lines.find(want);
    if (hit) return Promise.resolve(hit);
    return new Promise((done, fail) => { waiters.push({ want, done }); setTimeout(() => fail(new Error(`no such line in ${ms} ms: ${JSON.stringify(lines)}`)), ms); });
  };
  return { child, lines, next };
}
const startOf = (pid: number) => parseStat(readFileSync(`/proc/${pid}/stat`, "latin1"))!.start;
const rootOf = (pid: number) => ({ pid, start: startOf(pid) });

test("the relay with --peer-check and real processes: a client under its scope's root is admitted, others get the session's 403, a re-parented job is refused when the root has no cgroup of its own, and a root change closes the connection (1008)", { skip: !linux, timeout: 60_000 }, async () => {
  const h = await harness({ peerCheck: true });
  const procs: Proc[] = [];
  const clients: number[] = [];
  const pane = async () => { const p = run(["-e", PANE, CLIENT]); procs.push(p); return { p, pid: (await p.next((l) => l.pane)).pane as number }; };
  /** A client of `p` for `url`: the first line that the new client prints. */
  const client = async (p: Proc, url: string) => {
    const known = new Set(p.lines.map((l) => l.pid));
    p.child.stdin!.write(`${url}\n`);
    const l = await p.next((x) => x.pid !== undefined && !known.has(x.pid) && (x.open || x.status));
    clients.push(l.pid);
    return l;
  };
  try {
    assert.ok(h.logs.includes("relay: the peer check runs (pidfd)"), h.logs.join("\n"));
    const a = await pane(), b = await pane();
    const line = (sa: number[]) => ({ t: "allowlist", lists: { l: ["a.example"] }, scopes: { sa: "l", sb: "l" }, default: null, roots: { sa: sa.map(rootOf), sb: [rootOf(b.pid)] } });
    await h.ready(line([a.pid]));
    const admitted = await client(a.p, h.url("sa"));
    assert.equal(admitted.open, true, JSON.stringify(admitted));
    // A process under sa's root that names sb: its walk reaches sa's root.
    const crossed = await client(a.p, h.url("sb"));
    assert.deepEqual([crossed.status, crossed.body], [403, sessionRefusal(crossed.pid)]);
    // A process of sb's root that names sa.
    const other = await client(b.p, h.url("sa"));
    assert.deepEqual([other.status, other.body], [403, sessionRefusal(other.pid)]);
    // The test process is in no session of the line.
    assert.deepEqual(await raw(h.url("sa")).then((r) => [r.status, r.body]), [403, sessionRefusal(process.pid)]);
    // A job whose shell exits at once: re-parented, its walk reaches no root, and sa's root has the cgroup of its parent
    // (this test's), so the cgroup does not count either.
    const known = new Set(a.p.lines.map((l) => l.pid));
    a.p.child.stdin!.write(`detach ${h.url("sa")}\n`);
    const job = await a.p.next((x) => x.pid !== undefined && !known.has(x.pid) && x.status);
    assert.deepEqual([job.status, job.body], [403, sessionRefusal(job.pid)]);
    // A respawn: sa's root changes. The open connection closes with the root's 1008; a client of the new root is admitted.
    const a2 = await pane();
    h.fake.line(line([a2.pid]));
    assert.deepEqual((await a.p.next((x) => x.pid === admitted.pid && x.close)).close, closeOf("root"));
    assert.equal((await client(a2.p, h.url("sa"))).open, true);
    // Two panes of one session: a line that adds a pane keeps the open connection of the first.
    h.fake.line(line([a2.pid, a.pid]));
    const back = await client(a.p, h.url("sa"));
    assert.equal(back.open, true);
    h.fake.line(line([a.pid, a2.pid]));
    await sleep(100);
    assert.equal(a.p.lines.some((x) => x.pid === back.pid && x.close), false, "the connection stays");
  } finally {
    for (const pid of clients) try { process.kill(pid, "SIGKILL"); } catch {}
    for (const p of procs) p.child.kill("SIGKILL");
    await h.close();
  }
});

test("a relay with --peer-check whose self-test fails (node:ffi off) logs why and answers every upgrade with the 503 of step 3", async () => {
  const { dir, socket } = endpointPath();
  try {
    const relay = spawn(process.execPath, ["--no-experimental-ffi", join(ROOT, "bin/agent-browser.js"), "relay", "--socket", socket, "--peer-check"], { stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    relay.stderr!.on("data", (d) => (err += d));
    await until(() => err.includes("relay: ready on"), "the ready line");
    assert.match(err, /^relay: the peer check cannot run: node:ffi does not load \(ERR_UNKNOWN_BUILTIN_MODULE\)$/m);
    relay.stdin!.write(`${JSON.stringify({ t: "link", up: true, version: "0.3.2" })}\n${JSON.stringify(endpointV.lines.peer)}\n`);
    await sleep(100);
    assert.deepEqual(await raw(`ws+unix://${socket}:/devtools/browser/md-lead`).then((r) => [r.status, r.body]), [503, answer("cannotRead").body]);
    relay.stdin!.end();
    await new Promise((r) => relay.once("exit", r));
    assert.equal(existsSync(socket), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ node:ffi loads only with --peer-check

const runNode = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
  execFile(process.execPath, args, { cwd: ROOT, timeout: 30_000 }, (e, stdout, stderr) => resolve({ code: e ? (e as any).code ?? 1 : 0, stdout, stderr }));
});

test("no other agent-browser command loads node:ffi: only the relay's self-test, the service's control door (board ab-v16.94.2: the pidfd of the MainPID), the service's tools lock (board ab-v16.94.3: flock of the Google Chrome install), the service's link (board ab-v16.94.9: the pidfd that ends an old host) and the MCP port's socket take (board ab-v16.94.5: FD_CLOEXEC on systemd's fds) import it, dynamically", async () => {
  // The source: no static import or require of node:ffi; one dynamic import is in src/relay/peer.ts, one in
  // src/service/admission.ts (pidfd_open, which only `agent-browser service` loads, at its start), one in
  // src/service/unit/google-chrome.ts (flock, which only the service's install and prune of Google Chrome load), and one
  // in src/service/link/old-host.ts (pidfd_open and pidfd_send_signal, which only the service with its link loads), and one
  // in src/service/mcp/listen-fds.ts (fcntl, which only the service that takes the MCP port's socket from systemd loads).
  const files = (d: string): string[] => readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : /\.(ts|js|mjs)$/.test(e.name) ? [join(d, e.name)] : []));
  const code = (f: string) => readFileSync(join(ROOT, f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
  const all = [...files("src"), ...files("bin"), "index.js", "loader.js"];
  assert.deepEqual(all.filter((f) => /from\s*["']node:ffi["']|require\(\s*["'](node:)?ffi["']\s*\)|import\s*["']node:ffi["']/.test(code(f))), [], "no static import or require of node:ffi");
  assert.deepEqual(all.filter((f) => /import\(\s*["']node:ffi["']\s*\)/.test(code(f))).sort(), ["src/relay/peer.ts", "src/service/admission.ts", "src/service/link/old-host.ts", "src/service/mcp/listen-fds.ts", "src/service/unit/google-chrome.ts"], "a dynamic import in the peer reader, in the control door's admission, in the link's old-host end, in the MCP port's socket take and in the tools lock");
  assert.equal(code("src/service/mcp/listen-fds.ts").match(/import\(\s*["']node:ffi["']\s*\)/g)?.length, 1);
  assert.equal(code("src/service/link/old-host.ts").match(/import\(\s*["']node:ffi["']\s*\)/g)?.length, 1);
  assert.equal(code("src/service/unit/google-chrome.ts").match(/import\(\s*["']node:ffi["']\s*\)/g)?.length, 1);
  assert.equal(code("src/service/admission.ts").match(/import\(\s*["']node:ffi["']\s*\)/g)?.length, 1);
  assert.equal(code("src/relay/peer.ts").match(/import\(\s*["']node:ffi["']\s*\)/g)?.length, 1);
  // On a Node without node:ffi a static import anywhere would fail every command at load (ERR_UNKNOWN_BUILTIN_MODULE).
  const off = await runNode(["--no-experimental-ffi", "bin/agent-browser.js", "commands", "--json"]);
  assert.equal(off.code, 0, off.stderr);
  assert.ok(JSON.parse(off.stdout).length > 10 || JSON.parse(off.stdout).commands, off.stdout.slice(0, 200));
  const lib = await runNode(["--no-experimental-ffi", "--input-type=module", "-e", `const m = await import(${JSON.stringify(join(ROOT, "index.js"))}); console.log(typeof m.AgentBrowser);`]);
  assert.deepEqual([lib.code, lib.stdout.trim()], [0, "function"], lib.stderr);
  // With node:ffi on, no command prints its ExperimentalWarning: none loads it.
  const on = await runNode(["bin/agent-browser.js", "commands", "--json"]);
  assert.equal(on.code, 0);
  assert.doesNotMatch(on.stderr, /ExperimentalWarning|FFI/);
  // The relay without --peer-check never loads it either.
  const { dir, socket } = endpointPath();
  try {
    const relay = spawn(process.execPath, ["bin/agent-browser.js", "relay", "--socket", socket], { cwd: ROOT, stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    relay.stderr!.on("data", (d) => (err += d));
    await until(() => err.includes("relay: ready on"), "the ready line");
    relay.stdin!.end();
    await new Promise((r) => relay.once("exit", r));
    assert.doesNotMatch(err, /ExperimentalWarning|FFI|peer check/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--peer-check is a flag of the relay only", async () => {
  const r = await runNode(["bin/agent-browser.js", "commands", "--peer-check", "--json"]);
  assert.equal(r.code, 2);
});
