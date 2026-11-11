// The MCP port and its admission with the token step (contract C11, "The MCP path" and "The admission of the MCP path";
// stage 1d part 2a, board ab-v16.94.5; the token design, board ab-v16.94.10, sections 11, 12 and 14.1). The shared vectors
// (test/vectors/endpoint.json: mcpChecks, mcpCloses, mcpSnapshots, mcpLists, mcpTokens, mcpSessionIds, mcpAnswers) run
// through the real port, over real loopback TCP, with a fake reader of /proc behind the port's reader interface; one test
// connects from this test's own process with the real reader. The handler behind the admission is a stub here (part 2b's
// transport has its own tests: test/service-mcp-server.test.ts). The last tests are part 2b's rules of an admitted
// connection, from the review of part 2a. Every token in this file is a made-up test value in the vectors' abt1_ form.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NOT_READY } from "../src/relay/model.ts";
import { parseStat, PEER_UNREAD, sessionRefusal } from "../src/relay/peer.ts";
import { ControlDoor, encodeLine } from "../src/service/control.ts";
import { bearerOf, MCP_TEXT, rawPath, WWW_AUTHENTICATE, type McpReadiness } from "../src/service/mcp/admission.ts";
import { LISTEN_FDS_START, listenFd, MCP_SOCKET_UNIT, takeMcpSocket } from "../src/service/mcp/listen-fds.ts";
import { MCP_FAILED, MCP_HEADERS_MS, MCP_IDLE_MS, McpPort, type McpHandler } from "../src/service/mcp/port.ts";
import { parseTcp, procReader, type McpReader, type TcpLine } from "../src/service/mcp/proc.ts";
import { Stage1a } from "../src/service/service.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const V = JSON.parse(readFileSync(new URL("./vectors/endpoint.json", import.meta.url), "utf8"));
const ANSWERS: Record<string, { status: number; body: string | null; headers?: Record<string, string> }> = Object.fromEntries([...V.mcpAnswers, ...V.upgradeAnswers].map((a: any) => [a.id, a]));
const VPORT: number = V.mcpService.port, UID: number = V.mcpService.uid;
const VCLIENT = "127.0.0.1:52100";
const T = V.mcpTokens;
const linux = process.platform === "linux";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (t: string) => createHash("sha256").update(t, "latin1").digest("hex");

// ------------------------------------------------------------------ the fakes

type P = { pid: number; ppid: number; start: number; state: string; cgroup: string | null; gone?: boolean };
/** The process table of a world, with a case's own entries in place of the world's. */
function worldOf(world: string, replace: P[] = []): Map<number, P> {
  const w = new Map<number, P>(V.procs.filter((p: any) => p.world === world).map((p: any) => [p.pid, p]));
  for (const p of replace) { if (p.gone) w.delete(p.pid); else w.set(p.pid, p); }
  return w;
}

/** The lines of /proc/net/tcp of a check vector at its first read (or its second: tcpAgain), with the note's default. */
function vectorLines(c: any, again: boolean): TcpLine[] | null {
  if (again && Object.hasOwn(c.connection, "tcpAgain")) return c.connection.tcpAgain;
  if (Object.hasOwn(c.connection, "tcp")) return c.connection.tcp;
  const srv = `127.0.0.1:${VPORT}`, cl = c.connection.client;
  return [{ local: srv, remote: "0.0.0.0:0", uid: UID, inode: 80000 }, { local: srv, remote: cl, uid: UID, inode: 81002 }, { local: cl, remote: srv, uid: UID, inode: 81001 }];
}

/**
 * The fake reader of one check vector: its tables at the first and the second read, with the vector's addresses put on
 * the real ones (the test's client and the port), the holders of the client line's inode, and the world's processes.
 */
function vectorReader(c: any, real: { client: string; port: number }): McpReader & { reads: number } {
  const w = worldOf(c.world, c.procs);
  const at = (a: string) => (a === VCLIENT ? real.client : a === `127.0.0.1:${VPORT}` ? `127.0.0.1:${real.port}` : a);
  const clientInodes = new Set((vectorLines(c, false) ?? []).filter((l) => l.local === c.connection.client).map((l) => l.inode));
  const r = {
    reads: 0,
    tcp(): TcpLine[] | null {
      const lines = vectorLines(c, r.reads++ > 0);
      return lines === null ? null : lines.map((l) => ({ ...l, local: at(l.local), remote: at(l.remote) }));
    },
    holders: (inode: number) => (clientInodes.has(inode) ? [...c.connection.holders] : []),
    proc: (pid: number) => { const p = w.get(pid); return p ? { ppid: p.ppid, start: p.start, state: p.state } : null; },
    cgroup: (pid: number) => w.get(pid)?.cgroup ?? null,
  };
  return r;
}

/** A fake reader of the linux world for many connections: each client gets its line, its inode and its holders. */
class WorldReader implements McpReader {
  readonly w: Map<number, P>;
  service = "";
  private readonly conns = new Map<string, { inode: number; holders: number[] }>();
  private next = 90000;
  /** The holders of the next connections, in order. */
  readonly pending: number[][] = [];
  constructor(replace: P[] = []) { this.w = worldOf("linux", replace); }
  accepted(client: string): void { this.conns.set(client, { inode: (this.next += 10), holders: this.pending.shift() ?? [] }); }
  tcp(): TcpLine[] {
    const out: TcpLine[] = [{ local: this.service, remote: "0.0.0.0:0", uid: UID, inode: 80000 }];
    for (const [client, c] of this.conns) out.push({ local: this.service, remote: client, uid: UID, inode: c.inode + 1 }, { local: client, remote: this.service, uid: UID, inode: c.inode });
    return out;
  }
  holders(inode: number): number[] { for (const c of this.conns.values()) if (c.inode === inode) return [...c.holders]; return []; }
  proc(pid: number) { const p = this.w.get(pid); return p ? { ppid: p.ppid, start: p.start, state: p.state } : null; }
  cgroup(pid: number) { return this.w.get(pid)?.cgroup ?? null; }
}

/** The stub transport behind the admission: 200 for a request of a known MCP session of its scope (or none), else the 404 of an unknown session. */
const STUB_OK = "the stub transport admits this request";
const STUB_UNKNOWN = "the stub transport does not know this MCP session";
function stub(): McpHandler & { requests: string[]; ended: string[] } {
  const h = {
    requests: [] as string[], ended: [] as string[],
    request(req: IncomingMessage, res: ServerResponse, scope: string) {
      h.requests.push(scope);
      const sid = req.headers["mcp-session-id"];
      const [status, body] = sid !== undefined && V.mcpSessionIds[sid as string] !== scope ? [404, STUB_UNKNOWN] : [200, STUB_OK];
      res.writeHead(status, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(body) }).end(body);
    },
    endSessions(scope: string) { h.ended.push(scope); },
  };
  return h;
}

const READY: McpReadiness = { controlOff: false, notReady: null, sites: 2 };

// ------------------------------------------------------------------ a raw HTTP client

type Response = { status: number; headers: Record<string, string>; head: string; body: string };
/** A raw client: it writes requests byte for byte, and reads each answer (its Content-Length) and the close. */
function rawClient(sock: Socket) {
  let buf = Buffer.alloc(0), closed = false, all = "";
  let wake: (() => void) | null = null;
  const poke = () => { const w = wake; wake = null; w?.(); };
  sock.on("data", (d: Buffer) => { buf = Buffer.concat([buf, d]); all += d.toString("latin1"); poke(); });
  sock.on("close", () => { closed = true; poke(); });
  sock.on("error", () => {});
  const parse = (): Response | null => {
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return null;
    const head = buf.subarray(0, end).toString("latin1");
    const headers: Record<string, string> = {};
    for (const line of head.split("\r\n").slice(1)) { const i = line.indexOf(":"); headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim(); }
    // An interim answer (100 Continue) has no body.
    const n = /^HTTP\/1\.1 1\d\d /.test(head) ? 0 : Number(headers["content-length"]);
    assert.ok(Number.isSafeInteger(n), `an answer with a Content-Length: ${head}`);
    if (buf.length < end + 4 + n) return null;
    const body = buf.subarray(end + 4, end + 4 + n).toString("utf8");
    buf = buf.subarray(end + 4 + n);
    return { status: Number(head.split(" ")[1]), headers, head, body };
  };
  const until = async <X>(f: () => X | null, what: string, ms = 5000): Promise<X> => {
    const limit = Date.now() + ms;
    for (;;) {
      const x = f();
      if (x !== null) return x;
      if (Date.now() > limit) throw new Error(`no ${what} in ${ms} ms`);
      await Promise.race([new Promise<void>((r) => { wake = r; }), sleep(50)]);
    }
  };
  return {
    sock,
    /** Every byte that the client read. */
    get all() { return all; },
    get closed() { return closed; },
    send(path: string, headers: [string, string][], method = "GET") {
      sock.write(`${method} ${path} HTTP/1.1\r\n${headers.map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`);
    },
    response: () => until(() => parse() ?? (closed ? (() => { throw new Error("the connection closed before an answer"); })() : null), "answer"),
    closes: () => until(() => (closed ? true : null), "close"),
  };
}
const dial = (port: number) => new Promise<Socket>((resolve, reject) => { const s = connect({ host: "127.0.0.1", port }, () => resolve(s)); s.once("error", reject); });

/** The port of a test, with its log and the server side of each accepted socket (in order). */
async function openPort(o: { reader: McpReader | ((port: McpPort) => McpReader); handler?: McpHandler; readiness?: (scope: string) => McpReadiness; platform?: NodeJS.Platform; compare?: (a: Buffer, b: Buffer) => boolean; onAccept?: (s: Socket) => void }) {
  const log: string[] = [];
  let reader: McpReader | null = typeof o.reader === "function" ? null : o.reader;
  const handler = o.handler ?? stub();
  const port = await McpPort.open({ listen: { port: 0 }, handler, readiness: o.readiness ?? (() => READY), log: (l) => log.push(l), reader: { tcp: () => reader!.tcp(), holders: (i) => reader!.holders(i), proc: (p) => reader!.proc(p), cgroup: (p) => reader!.cgroup(p) }, uid: UID, platform: o.platform, compare: o.compare });
  if (typeof o.reader === "function") reader = o.reader(port);
  const servers: Socket[] = [];
  port.listener.prependListener("connection", (s: Socket) => { servers.push(s); o.onAccept?.(s); });
  return { port, log, servers, handler };
}

// ------------------------------------------------------------------ the check vectors through the real port

/** The expected answer of a vector's request: status, body (the session's 403 with its pid), and the 401's header. */
function expected(r: any): { status: number; body: string; www: string | undefined } {
  if (r.answer === "pass") return { status: 200, body: STUB_OK, www: undefined };
  if (r.answer === "unknownSession") return { status: 404, body: STUB_UNKNOWN, www: undefined };
  const a = ANSWERS[r.answer];
  assert.ok(a && a.body !== null, r.answer);
  return { status: a.status, body: r.answer === "session" ? a.body!.replace("<pid>", String(r.pid)) : a.body!, www: a.headers?.["www-authenticate"] };
}
/** The vector's host values on the real port (another port stays another port). */
const onPort = (v: string, port: number) => v.replace(/:(\d+)$/, (_, n) => `:${Number(n) - VPORT + port}`);

async function runCheck(c: any): Promise<{ log: string[]; answers: string }> {
  const real = { client: "", port: 0 };
  const reader = vectorReader(c, real);
  const snap = c.service.snapshot === null ? null : V.mcpSnapshots[c.service.snapshot];
  const readiness = (scope: string): McpReadiness => ({
    controlOff: c.service.ready === "controlOff",
    notReady: c.service.ready === "ready" || c.service.ready === "controlOff" ? null : ANSWERS[c.service.ready].body,
    sites: snap === null || snap.lists[scope] == null ? null : V.mcpLists[snap.lists[scope]].length,
  });
  const { port, log, servers } = await openPort({ reader, readiness, onAccept: (s) => { real.client = `127.0.0.1:${s.remotePort}`; } });
  real.port = port.port;
  try {
    if (snap) port.setSessions({ sessions: snap.sessions } as any);
    const cl = rawClient(await dial(port.port));
    for (const r of c.requests) {
      cl.send(r.path.replace(`:${VPORT}/`, `:${port.port}/`), r.headers.map(([k, v]: [string, string]) => [k, k === "host" ? onPort(v, port.port) : v]));
      const got = await cl.response();
      const want = expected(r);
      assert.equal(got.status, want.status, `${c.note}: the status`);
      assert.equal(got.body, want.body, `${c.note}: the text`);
      assert.equal(got.headers["www-authenticate"], want.www, `${c.note}: WWW-Authenticate`);
      if (r.answer === "pass" || r.answer === "unknownSession") continue;
      // The first refusal closes the connection.
      await cl.closes();
      const early = log.some((l) => /^mcp: connection 1 refused at step [12] /.test(l));
      assert.equal(early, !log.includes("mcp: connection 1 admitted for scope md-lead") && !log.some((l) => /^mcp: connection 1 admitted/.test(l)), `${c.note}: refused at the accept, or admitted`);
      if (r.answer === "peerUnread") assert.ok(early, `${c.note}: the peer's 403 comes at step 1 or 2`);
      // A refusal at step 1 or 2 reads no byte of the request (C11: before the service reads any byte).
      if (early) assert.equal(servers[0].bytesRead, 0, `${c.note}: no byte read before steps 1 and 2`);
    }
    return { log, answers: cl.all };
  } finally { await port.stop(); }
}

test("each mcpChecks vector gets its answers through the real port: steps 1 and 2 at the accept, steps 3 to 8 for each request, then the handler", { timeout: 120_000 }, async () => {
  assert.ok(V.mcpChecks.length >= 80, "the vectors with the open points' cases");
  for (const c of V.mcpChecks) await runCheck(c);
});

// ------------------------------------------------------------------ steps 1 and 2: details

test("steps 1 and 2 run before any byte: a refused peer that sends its whole request with a token and an Origin gets the peer's 403 and the close, with no read", async () => {
  const c = V.mcpChecks.find((x: any) => /Step 1 comes before any byte/.test(x.note));
  const real = { client: "", port: 0 };
  const reader = vectorReader(c, real);
  const { port, servers, log } = await openPort({ reader, onAccept: (s) => { real.client = `127.0.0.1:${s.remotePort}`; } });
  real.port = port.port;
  try {
    const sock = await dial(port.port);
    const cl = rawClient(sock);
    cl.send("/mcp/md-lead", [["host", `127.0.0.1:${port.port}`], ["origin", "https://a.example"], ["authorization", `Bearer ${T.leadRun2.token}`]]);
    const got = await cl.response();
    assert.deepEqual([got.status, got.body], [403, PEER_UNREAD]);
    await cl.closes();
    assert.equal(servers[0].bytesRead, 0, "the service read no byte of the request");
    assert.equal(reader.reads, 1, "one read of /proc/net/tcp: the uid check stops before the walk");
    assert.ok(log.includes("mcp: connection 1 refused at step 1 (403)"), log.join("\n"));
  } finally { await port.stop(); }
});

test("OP1: before the first set_sessions no root counts, so md-lead's own process gets the session's 403 with its pid (its text says to connect again in a few seconds)", async () => {
  const r = new WorldReader();
  const { port } = await openPort({ reader: (p) => { r.service = `127.0.0.1:${p.port}`; return r; }, onAccept: (s) => r.accepted(`127.0.0.1:${s.remotePort}`) });
  try {
    r.pending.push([3102]);
    const cl = rawClient(await dial(port.port));
    cl.send("/mcp/md-lead", [["host", `127.0.0.1:${port.port}`], ["authorization", `Bearer ${T.leadRun2.token}`]]);
    const got = await cl.response();
    assert.deepEqual([got.status, got.body], [403, sessionRefusal(3102)]);
    assert.match(got.body, /If this session started or restarted just now, connect again in a few seconds\.$/);
  } finally { await port.stop(); }
});

test("OP3: a socket that no process holds gets the peer's 403, which names no pid", async () => {
  const r = new WorldReader();
  const { port, log } = await openPort({ reader: (p) => { r.service = `127.0.0.1:${p.port}`; return r; }, onAccept: (s) => r.accepted(`127.0.0.1:${s.remotePort}`) });
  try {
    port.setSessions({ sessions: V.mcpSnapshots.tokens.sessions } as any);
    r.pending.push([]);
    const cl = rawClient(await dial(port.port));
    cl.send("/mcp/md-lead", [["host", `127.0.0.1:${port.port}`]]);
    const got = await cl.response();
    assert.deepEqual([got.status, got.body], [403, PEER_UNREAD]);
    assert.doesNotMatch(got.body, /pid/);
    assert.ok(log.includes("mcp: connection 1 refused at step 2 (403)"), log.join("\n"));
  } finally { await port.stop(); }
});

test("the walk of a holder is the endpoint's session check: a holder whose process has gone or is a zombie is refused, a holder of a root that two scopes name is refused", async () => {
  const cases: { replace: P[]; holders: number[]; sessions: any[]; want: number | "ok" }[] = [
    // md-lead's Bash tool command, a zombie now: refused (the session check's item 1).
    { replace: [{ pid: 3102, ppid: 3101, start: 6050, state: "Z", cgroup: null }], holders: [3102], sessions: V.mcpSnapshots.tokens.sessions, want: 3102 },
    // md-lead's pane named by two scopes: the root counts for neither (the defensive root rules).
    { replace: [], holders: [3102], sessions: [...V.mcpSnapshots.tokens.sessions.filter((s: any) => s.scope !== "md-worker"), { ...V.mcpSnapshots.tokens.sessions.find((s: any) => s.scope === "md-worker"), roots: [{ pid: 3100, start: 6000 }] }], want: 3102 },
    // A holder whose stat cannot be read (it exited after the scan).
    { replace: [{ pid: 3102, ppid: 0, start: 0, state: "S", cgroup: null, gone: true }], holders: [3102], sessions: V.mcpSnapshots.tokens.sessions, want: 3102 },
    // The same holder, alive: admitted.
    { replace: [], holders: [3102], sessions: V.mcpSnapshots.tokens.sessions, want: "ok" },
  ];
  for (const k of cases) {
    const r = new WorldReader(k.replace);
    const { port } = await openPort({ reader: (p) => { r.service = `127.0.0.1:${p.port}`; return r; }, onAccept: (s) => r.accepted(`127.0.0.1:${s.remotePort}`) });
    try {
      port.setSessions({ sessions: k.sessions } as any);
      r.pending.push(k.holders);
      const cl = rawClient(await dial(port.port));
      cl.send("/mcp/md-lead", [["host", `127.0.0.1:${port.port}`], ["authorization", `Bearer ${T.leadRun2.token}`]]);
      const got = await cl.response();
      if (k.want === "ok") assert.equal(got.status, 200);
      else assert.deepEqual([got.status, got.body], [403, sessionRefusal(k.want)]);
    } finally { await port.stop(); }
  }
});

test("the reader of /proc/net/tcp: the addresses in the host's byte order, the uid and the inode; a line that does not parse is left out", () => {
  const text = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:B8CF 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 80000 1 0000000000000000 100 0 0 10 0",
    "   1: 0100007F:CB24 0100007F:B8CF 01 00000000:00000000 00:00000000 00000000  1002        0 81001 1 0000000000000000 20 4 30 10 -1",
    "   2: garbage",
  ].join("\n");
  assert.deepEqual(parseTcp(text, "LE"), [
    { local: "127.0.0.1:47311", remote: "0.0.0.0:0", uid: 1001, inode: 80000 },
    { local: "127.0.0.1:52004", remote: "127.0.0.1:47311", uid: 1002, inode: 81001 },
  ]);
  assert.equal(parseTcp(text, "BE")[0].local, "1.0.0.127:47311", "the big-endian order reads the bytes as they stand");
});

test("the real reader, from this test's own process: its line by the full tuple, this process as the holder, the walk to its root; another root refuses it with its pid", { skip: !linux }, async () => {
  const self = parseStat(readFileSync(`/proc/${process.pid}/stat`, "latin1"))!;
  const token = "abt1_" + Buffer.from("test, not a token: the real port", "latin1").toString("base64url");
  const handler = stub();
  const log: string[] = [];
  const port = await McpPort.open({ listen: { port: 0 }, handler, readiness: () => READY, log: (l) => log.push(l), reader: procReader() });
  // A process that is no ancestor of this test: its root admits nothing of this test.
  const other = spawn(process.execPath, ["--disable-sigusr1", "-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    const ask = (path: string, auth?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: port.port, path, method: "POST", headers: { ...(auth ? { Authorization: auth } : {}), "Content-Type": "application/json" }, agent: false }, (res) => {
        let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => resolve({ status: res.statusCode!, body }));
      });
      req.on("error", reject);
      req.end("{}");
    });
    // OP1, real: no set_sessions yet.
    assert.deepEqual(await ask("/mcp/t-real", `Bearer ${token}`), { status: 403, body: sessionRefusal(process.pid) });
    port.setSessions({ sessions: [{ scope: "t-real", repo: null, roots: [{ pid: process.pid, start: self.start }], cgroup: null, lifetime_id: "lt-test-real", mcp_token: sha256(token) }] } as any);
    assert.deepEqual(await ask("/mcp/t-real", `Bearer ${token}`), { status: 200, body: STUB_OK });
    assert.deepEqual(await ask("/mcp", `Bearer ${token}`), { status: 200, body: STUB_OK });
    assert.deepEqual(await ask("/mcp/t-real"), { status: 401, body: MCP_TEXT.needsToken });
    await sleep(100);
    const otherStart = parseStat(readFileSync(`/proc/${other.pid}/stat`, "latin1"))!.start;
    port.setSessions({ sessions: [{ scope: "t-real", repo: null, roots: [{ pid: other.pid!, start: otherStart }], cgroup: null, lifetime_id: "lt-test-real", mcp_token: sha256(token) }] } as any);
    assert.deepEqual(await ask("/mcp/t-real", `Bearer ${token}`), { status: 403, body: sessionRefusal(process.pid) });
    assert.deepEqual(handler.requests, ["t-real", "t-real"]);
    assert.ok(!log.join("\n").includes(token) && !log.join("\n").includes(sha256(token)), "no token and no fingerprint in the log");
  } finally { other.kill("SIGKILL"); await port.stop(); }
});

// ------------------------------------------------------------------ steps 3 to 8: details

test("step 7 compares two 32-byte SHA-256 digests with timingSafeEqual for each request that has a bearer, also for a bearer of another length", async () => {
  const calls: [number, number][] = [];
  const compare = (a: Buffer, b: Buffer) => { calls.push([a.length, b.length]); return timingSafeEqual(a, b); };
  const r = new WorldReader();
  const { port } = await openPort({ reader: (p) => { r.service = `127.0.0.1:${p.port}`; return r; }, onAccept: (s) => r.accepted(`127.0.0.1:${s.remotePort}`), compare });
  try {
    port.setSessions({ sessions: V.mcpSnapshots.tokens.sessions } as any);
    const bearers = [T.leadRun2.token, "x", T.leadRun2.fingerprint, ` ${T.leadRun2.token}`, `${T.leadRun2.token} extra`, T.worker.token];
    const statuses: number[] = [];
    for (const b of bearers) {
      r.pending.push([3102]);
      const cl = rawClient(await dial(port.port));
      cl.send("/mcp/md-lead", [["host", `127.0.0.1:${port.port}`], ["authorization", `Bearer ${b}`]]);
      statuses.push((await cl.response()).status);
      cl.sock.destroy();
    }
    assert.deepEqual(statuses, [200, 401, 401, 401, 401, 401]);
    assert.deepEqual(calls, bearers.map(() => [32, 32]), "one compare of two 32-byte digests for each request");
  } finally { await port.stop(); }
});

test("OP5 and OP7: the raw Authorization header lines are counted (Node's req.headers keeps the first of two), the raw path is read up to its first ?, and the token is every character after the one space", () => {
  assert.equal(bearerOf(["Authorization", `Bearer ${T.leadRun2.token}`, "authorization", `Bearer ${T.leadRun2.token}`]), null, "two lines, whatever the case of their name");
  assert.equal(bearerOf(["AUTHORIZATION", `bEaReR ${T.leadRun2.token}`]), T.leadRun2.token, "the name and the scheme in any case");
  assert.equal(bearerOf(["Authorization", `Bearer  ${T.leadRun2.token}`]), ` ${T.leadRun2.token}`, "two spaces: the token starts with a space");
  assert.equal(bearerOf(["Authorization", "Bearer"]), null, "Bearer alone");
  assert.equal(bearerOf(["Authorization", `Bearer\t${T.leadRun2.token}`]), null, "a tab is not the one space");
  assert.equal(rawPath("/mcp/md-lead?access_token=x"), "/mcp/md-lead");
  assert.equal(rawPath("/mcp/./md-lead"), "/mcp/./md-lead", "no normalization");
});

test("each refusal of steps 3 to 8 carries a fixed text, a Content-Length and Connection: close; only a 401 has WWW-Authenticate, with no resource_metadata", async () => {
  const r = new WorldReader();
  const { port } = await openPort({ reader: (p) => { r.service = `127.0.0.1:${p.port}`; return r; }, onAccept: (s) => r.accepted(`127.0.0.1:${s.remotePort}`) });
  try {
    port.setSessions({ sessions: V.mcpSnapshots.tokens.sessions } as any);
    for (const [headers, status] of [[[["host", "x:1"]], 403], [[["host", `127.0.0.1:${port.port}`]], 401]] as [[string, string][], number][]) {
      r.pending.push([3102]);
      const cl = rawClient(await dial(port.port));
      cl.send("/mcp/md-lead", headers);
      const got = await cl.response();
      assert.equal(got.status, status);
      assert.equal(got.headers.connection, "close");
      assert.equal(got.headers["www-authenticate"], status === 401 ? WWW_AUTHENTICATE : undefined);
      assert.doesNotMatch(got.head, /resource_metadata/i);
      await cl.closes();
    }
  } finally { await port.stop(); }
});

test("OP2: step 8's order on the MCP path: control off, then the endpoint's not-ready text, then the no-list 503 for no list and for a list with no site", async () => {
  const want: [McpReadiness, number, string][] = [
    [{ controlOff: true, notReady: NOT_READY.link, sites: null }, 503, MCP_TEXT.controlOff],
    [{ controlOff: false, notReady: NOT_READY.old, sites: null }, 503, NOT_READY.old],
    [{ controlOff: false, notReady: null, sites: null }, 503, NOT_READY.noList],
    [{ controlOff: false, notReady: null, sites: 0 }, 503, NOT_READY.noList],
    [{ controlOff: false, notReady: null, sites: 1 }, 200, STUB_OK],
  ];
  for (const [readiness, status, body] of want) {
    const r = new WorldReader();
    const { port } = await openPort({ reader: (p) => { r.service = `127.0.0.1:${p.port}`; return r; }, onAccept: (s) => r.accepted(`127.0.0.1:${s.remotePort}`), readiness: () => readiness });
    try {
      port.setSessions({ sessions: V.mcpSnapshots.tokens.sessions } as any);
      r.pending.push([3102]);
      const cl = rawClient(await dial(port.port));
      cl.send("/mcp/md-lead", [["host", `127.0.0.1:${port.port}`], ["authorization", `Bearer ${T.leadRun2.token}`]]);
      const got = await cl.response();
      assert.deepEqual([got.status, got.body], [status, body], JSON.stringify(readiness));
    } finally { await port.stop(); }
  }
});

// ------------------------------------------------------------------ the close at a change, session_ended

/** A port with one admitted connection of `scope` from `holders`, after the snapshot `first`. */
async function admittedOne(first: string, holders: number[], replace: P[] = []) {
  const r = new WorldReader(replace);
  const handler = stub();
  const o = await openPort({ reader: (p) => { r.service = `127.0.0.1:${p.port}`; return r; }, onAccept: (s) => r.accepted(`127.0.0.1:${s.remotePort}`), handler });
  o.port.setSessions({ sessions: V.mcpSnapshots[first].sessions } as any);
  r.pending.push(holders);
  const cl = rawClient(await dial(o.port.port));
  for (let i = 0; i < 100 && o.port.connections() === 0; i++) await sleep(10);
  return { ...o, r, cl, handler };
}

test("each mcpCloses vector: at set_sessions the port closes a connection whose session the snapshot drops, whose mcp_token changed, or whose admitting root no longer counts; the handler ends that session's MCP sessions", async () => {
  const holderOf: Record<string, number> = { "md-lead": 3102, "md-worker": 3202 };
  for (const v of V.mcpCloses) {
    const { port, cl, handler, log } = await admittedOne(v.connection.snapshot, [holderOf[v.connection.scope]]);
    try {
      assert.equal(port.connections(v.connection.scope), 1, `${v.note}: admitted`);
      port.setSessions({ sessions: V.mcpSnapshots[v.snapshot].sessions } as any);
      if (v.close === null) {
        await sleep(100);
        assert.equal(cl.closed, false, `${v.note}: the connection stays`);
        assert.equal(port.connections(v.connection.scope), 1, v.note);
        assert.ok(!handler.ended.includes(v.connection.scope), `${v.note}: its MCP sessions stay`);
        continue;
      }
      await cl.closes();
      assert.equal(port.connections(v.connection.scope), 0, v.note);
      assert.ok(handler.ended.includes(v.connection.scope), `${v.note}: the handler ends the scope's MCP sessions (OP4)`);
      const why = { dropped: "the snapshot drops its session", token: "its session's connection token changed", root: "a root that admitted it no longer counts" }[v.close as string];
      assert.ok(log.includes(`mcp: connection 1 (scope ${v.connection.scope}) closed: ${why}`), `${v.note}: ${log.join("\n")}`);
    } finally { await port.stop(); }
  }
});

test("the close at a change: a root that the snapshot still names but that no longer counts (its pane has gone) closes the connection", async () => {
  const { port, cl, r } = await admittedOne("tokens", [3102]);
  try {
    r.w.delete(3100); // md-lead's pane ends; the same snapshot comes again
    port.setSessions({ sessions: V.mcpSnapshots.tokens.sessions } as any);
    await cl.closes();
  } finally { await port.stop(); }
});

test("OP4: a snapshot that changes a session's mcp_token or drops it ends that session's MCP sessions also with no open connection; an unchanged session's stay", async () => {
  const handler = stub();
  const r = new WorldReader();
  const { port } = await openPort({ reader: (p) => { r.service = `127.0.0.1:${p.port}`; return r; }, handler });
  try {
    port.setSessions({ sessions: V.mcpSnapshots.leadRun1.sessions } as any);
    port.setSessions({ sessions: V.mcpSnapshots.tokens.sessions } as any);
    assert.deepEqual(handler.ended, ["md-lead"], "md-lead's new run");
    port.setSessions({ sessions: V.mcpSnapshots.workerDropped.sessions } as any);
    assert.deepEqual(handler.ended, ["md-lead", "md-worker"], "md-worker dropped");
    port.setSessions({ sessions: V.mcpSnapshots.workerDropped.sessions } as any);
    assert.deepEqual(handler.ended, ["md-lead", "md-worker"], "the same snapshot again ends nothing");
  } finally { await port.stop(); }
});

test("session_ended through the service's handler: the scope's connections close, its MCP sessions end, its fingerprint goes; set_sessions reaches the port too", async () => {
  const { port, cl, handler, r } = await admittedOne("tokens", [3102]);
  try {
    const state = new Stage1a({ agentDoor: { url: (s) => `ws+unix:///x:/devtools/browser/${s}`, state: () => ({ form: "stat" }) }, parts: [port.part()] });
    const by = { kind: "daemon", user: "ann", via: "daemon" } as const;
    state.handle({ t: "req", id: "1", op: "set_sessions", by, sessions: V.mcpSnapshots.tokens.sessions, remote: [], box: { hosts: [], cookie_names: [] } });
    assert.equal(cl.closed, false, "the same snapshot: the connection stays");
    state.handle({ t: "req", id: "2", op: "session_ended", by, scope: "md-lead" });
    await cl.closes();
    assert.deepEqual(handler.ended, ["md-lead"]);
    assert.equal(port.connections("md-lead"), 0);
    // The ended session's process connects again: its scope has no root in the port's snapshot any more.
    r.pending.push([3102]);
    const again = rawClient(await dial(port.port));
    again.send("/mcp/md-lead", [["host", `127.0.0.1:${port.port}`], ["authorization", `Bearer ${T.leadRun2.token}`]]);
    assert.deepEqual(await again.response().then((x) => [x.status, x.body]), [403, sessionRefusal(3102)]);
  } finally { await port.stop(); }
});

// ------------------------------------------------------------------ the log rule and the secret scans (the token design, section 12)

/** The canary of section 12: a made-up test token, abt1_ and 43 C characters. */
const CANARY = "abt1_" + "C".repeat(43);
const CANARY_PRINT = sha256(CANARY);
const CANARY_LIFETIME = "lt-canary-test-value";
/** A scan: each secret that a text holds (plain string search, as grep -F). */
const scan = (text: string, secrets: string[]) => secrets.filter((s) => text.includes(s));

test("the secret scans of section 12: the port's and the door's log sink, the port's answers and status hold no token, no fingerprint, no lifetime id and no scope from the request; each scan finds its planted twin", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-scan-"));
  const log: string[] = [];
  const r = new WorldReader();
  const handler = stub();
  const port = await McpPort.open({ listen: { port: 0 }, handler, readiness: () => READY, log: (l) => log.push(l), reader: { tcp: () => r.tcp(), holders: (i) => r.holders(i), proc: (p) => r.proc(p), cgroup: (p) => r.cgroup(p) }, uid: UID });
  r.service = `127.0.0.1:${port.port}`;
  port.listener.prependListener("connection", (s: Socket) => r.accepted(`127.0.0.1:${s.remotePort}`));
  const state = new Stage1a({ agentDoor: { url: (s) => `ws+unix:///x:/devtools/browser/${s}`, state: () => ({ form: "stat" }) }, parts: [port.part()] });
  const door = await ControlDoor.open({ path: join(dir, "control.sock"), admit: async () => ({ ok: true }), handler: state, log: (l) => log.push(l) });
  let answers = "";
  try {
    // set_sessions over the control door: md-lead's item carries the canary's fingerprint and a lifetime id.
    const sessions = V.mcpSnapshots.tokens.sessions.map((s: any) => (s.scope === "md-lead" ? { ...s, lifetime_id: CANARY_LIFETIME, mcp_token: CANARY_PRINT } : s));
    const ctl = rawClient(await new Promise<Socket>((res) => { const s = connect(join(dir, "control.sock"), () => res(s)); }));
    const line = async (o: unknown) => { ctl.sock.write(encodeLine(o)); };
    await line({ t: "hello", v: 1, side: "daemon", version: "0", features: [] });
    const by = { kind: "daemon", user: "ann", via: "daemon" };
    await line({ t: "req", id: "s1", op: "set_sessions", by, sessions, remote: [], box: { hosts: [], cookie_names: [] } });
    // A bad snapshot that carries the canary's fingerprint twice: bad request, which echoes nothing.
    await line({ t: "req", id: "s2", op: "set_sessions", by, sessions: [...sessions, { ...sessions[0], scope: "md-twice" }], remote: [], box: { hosts: [], cookie_names: [] } });
    await line({ t: "req", id: "s3", op: "status", by: { kind: "operator", user: "ann", via: "web" } });
    for (let i = 0; i < 200 && !ctl.all.includes('"id":"s3"'); i++) await sleep(10);
    const statusText = ctl.all.split("\n").find((l) => l.includes('"id":"s3"'))!;
    assert.ok(statusText && /"mcp_token":true/.test(statusText), "status says that md-lead has a token");
    // Requests on the port: the canary admitted, refused in each way, in the query and the path, a header too large for the parser.
    const tries: [string, [string, string][]][] = [
      ["/mcp/md-lead", [["host", `127.0.0.1:${port.port}`], ["authorization", `Bearer ${CANARY}`]]],
      ["/mcp/md-lead", [["host", `127.0.0.1:${port.port}`], ["authorization", `Bearer ${CANARY}x`]]],
      ["/mcp/md-lead", [["host", `127.0.0.1:${port.port}`], ["authorization", `Bearer ${CANARY}`], ["authorization", `Bearer ${CANARY}`]]],
      ["/mcp/md-lead", [["host", `127.0.0.1:${port.port}`], ["origin", "https://a.example"], ["authorization", `Bearer ${CANARY}`]]],
      ["/mcp/md-lead", [["host", `${CANARY}:${port.port}`], ["authorization", `Bearer ${CANARY}`]]],
      [`/mcp/md-lead?access_token=${CANARY}`, [["host", `127.0.0.1:${port.port}`]]],
      [`/mcp/${CANARY}`, [["host", `127.0.0.1:${port.port}`], ["authorization", `Bearer ${CANARY}`]]],
      ["/mcp/md-scope-from-the-request", [["host", `127.0.0.1:${port.port}`], ["authorization", `Bearer ${CANARY}`]]],
      ["/mcp/md-lead", [["host", `127.0.0.1:${port.port}`], ["authorization", `Bearer ${CANARY}`], ["x-big", "C".repeat(20000) + CANARY]]],
    ];
    for (const [path, headers] of tries) {
      r.pending.push([3102]);
      const cl = rawClient(await dial(port.port));
      // Connection: close, so that the stub's 200 closes its connection too.
      cl.send(path, [...headers, ["connection", "close"]]);
      await cl.closes();
      answers += cl.all;
    }
    // A refusal at step 2 (no holder) with the canary sent.
    r.pending.push([]);
    const c2 = rawClient(await dial(port.port));
    c2.send("/mcp/md-lead", [["host", `127.0.0.1:${port.port}`], ["authorization", `Bearer ${CANARY}`]]);
    await c2.closes();
    answers += c2.all + ctl.all.split("\n").filter((l) => !l.includes('"id":"s3"')).join("\n");
    const secrets = [CANARY, CANARY_PRINT, CANARY_LIFETIME];
    assert.ok(answers.includes(STUB_OK) && answers.includes("401 Unauthorized") && answers.includes("431"), "the scan reads the answers");
    assert.deepEqual(scan(log.join("\n"), secrets), [], "the log sink holds no secret");
    assert.deepEqual(scan(answers, [...secrets, "md-scope-from-the-request"]), [], "the answers hold no secret and no scope from the request");
    assert.deepEqual(scan(statusText, secrets), [], "status holds no secret");
    assert.ok(!log.some((l) => /x-big|431/.test(l)), "a request that the parser refuses for its size is never logged");
    // The twins: each scan finds the canary, its fingerprint and the lifetime id when they are planted.
    for (const [name, text] of [["log", log.join("\n")], ["answers", answers], ["status", statusText]]) {
      for (const s of secrets) assert.deepEqual(scan(`${text}\n${s}`, secrets), [s], `the ${name} scan finds a planted ${s === CANARY ? "token" : s === CANARY_PRINT ? "fingerprint" : "lifetime id"}`);
    }
  } finally { await door.stop(); await port.stop(); rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ the Mac, the address, the takeover

test("on the Mac the port accepts and closes each connection with no answer and no read (fail closed until its TCP peer reader exists)", async () => {
  let reads = 0;
  const reader: McpReader = { tcp: () => { reads++; return []; }, holders: () => [], proc: () => null, cgroup: () => null };
  const { port, servers } = await openPort({ reader, platform: "darwin" });
  try {
    const cl = rawClient(await dial(port.port));
    cl.send("/mcp/md-lead", [["host", `127.0.0.1:${port.port}`], ["authorization", `Bearer ${T.leadRun2.token}`]]);
    await cl.closes();
    assert.equal(cl.all, "", "no answer");
    assert.equal(reads, 0, "no read of /proc");
    assert.equal(servers[0].bytesRead, 0);
  } finally { await port.stop(); }
});

test("the port listens on 127.0.0.1 only", async () => {
  const { port } = await openPort({ reader: new WorldReader() });
  try {
    const a = port.listener.address() as { address: string; family: string };
    assert.deepEqual([a.address, a.family], ["127.0.0.1", "IPv4"]);
  } finally { await port.stop(); }
});

test("sd_listen_fds: the fd of agent-browser-mcp.socket only for this pid, with a name for each fd", () => {
  const ok = { LISTEN_PID: "4242", LISTEN_FDS: "2", LISTEN_FDNAMES: `other.socket:${MCP_SOCKET_UNIT}` };
  assert.deepEqual(listenFd(ok, 4242), { fd: LISTEN_FDS_START + 1, count: 2 });
  assert.deepEqual(listenFd({ LISTEN_PID: "4242", LISTEN_FDS: "1", LISTEN_FDNAMES: MCP_SOCKET_UNIT }, 4242), { fd: 3, count: 1 });
  for (const [env, why] of [
    [{}, /no LISTEN_PID/],
    [{ ...ok, LISTEN_PID: "4243" }, /for pid 4243, not for this process/],
    [{ ...ok, LISTEN_FDS: "0" }, /not a count/],
    [{ ...ok, LISTEN_FDS: "x" }, /not a count/],
    [{ ...ok, LISTEN_FDS: "3" }, /does not name each fd/],
    [{ LISTEN_PID: "4242", LISTEN_FDS: "1" }, /does not name each fd/],
    [{ ...ok, LISTEN_FDNAMES: "a.socket:b.socket" }, /no socket named agent-browser-mcp.socket/],
    [{ ...ok, LISTEN_FDNAMES: `${MCP_SOCKET_UNIT}:${MCP_SOCKET_UNIT}` }, /no socket named/],
  ] as [Record<string, string>, RegExp][]) {
    const got = listenFd(env, 4242);
    assert.ok("none" in got && why.test(got.none), `${JSON.stringify(env)}: ${JSON.stringify(got)}`);
  }
});

test("sd_listen_fds: the take sets FD_CLOEXEC on every passed fd and removes the three variables; a failed fcntl fails closed", async () => {
  const env: Record<string, string | undefined> = { LISTEN_PID: "4242", LISTEN_FDS: "2", LISTEN_FDNAMES: `${MCP_SOCKET_UNIT}:other.socket`, KEEP: "1" };
  const calls: [number, number, number][] = [];
  const fd = await takeMcpSocket(env, { pid: 4242, fcntl: (f, cmd, arg) => { calls.push([f, cmd, arg]); return cmd === 1 ? 2 : 0; } });
  assert.equal(fd, 3);
  assert.deepEqual(calls, [[3, 1, 0], [3, 2, 3], [4, 1, 0], [4, 2, 3]], "F_GETFD, then F_SETFD with FD_CLOEXEC, for fds 3 and 4");
  assert.deepEqual(env, { KEEP: "1" });
  const env2: Record<string, string | undefined> = { LISTEN_PID: "4242", LISTEN_FDS: "1", LISTEN_FDNAMES: MCP_SOCKET_UNIT };
  await assert.rejects(takeMcpSocket(env2, { pid: 4242, fcntl: () => -1 }), /cannot be marked close-on-exec/);
  await assert.rejects(takeMcpSocket({}, { pid: 4242, fcntl: () => 0 }), /systemd passed no socket/);
});

/** A child that takes fd 3 by the sd_listen_fds protocol (its environment says LISTEN_PID is its own pid) and serves the port on it. */
const TAKER = `
const { takeMcpSocket } = await import(process.argv[1] + "/src/service/mcp/listen-fds.ts");
const { McpPort } = await import(process.argv[1] + "/src/service/mcp/port.ts");
const { procReader } = await import(process.argv[1] + "/src/service/mcp/proc.ts");
const { readFileSync } = await import("node:fs");
process.env.LISTEN_PID = String(process.pid); // the fake environment: systemd sets it after its fork
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
try {
  const fd = await takeMcpSocket(process.env);
  const flags = parseInt(/^flags:\\s*([0-7]+)$/m.exec(readFileSync("/proc/self/fdinfo/" + fd, "utf8"))[1], 8);
  const port = await McpPort.open({ listen: { fd }, readiness: () => ({ controlOff: false, notReady: null, sites: 1 }), log: () => {}, reader: procReader(),
    handler: { request: (req, res, scope) => res.writeHead(200, { "Content-Length": 9 + scope.length }).end("admitted " + scope), endSessions: () => {} } });
  const parent = Number(process.argv[2]);
  const start = Number(readFileSync("/proc/" + parent + "/stat", "latin1").slice(readFileSync("/proc/" + parent + "/stat", "latin1").lastIndexOf(")") + 2).split(" ")[19]);
  port.setSessions({ sessions: [{ scope: "t-taken", repo: null, roots: [{ pid: parent, start }], cgroup: null, lifetime_id: "lt-test", mcp_token: process.argv[3] }] });
  out({ fd, port: port.port, cloexec: (flags & 0o2000000) !== 0, env: ["LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES"].filter((k) => k in process.env) });
} catch (e) { out({ error: e.message }); }
`;

test("the service takes the socket unit's fd by the sd_listen_fds protocol: a listening socket that the test makes, as fd 3 of a child; the child serves the port on it, with FD_CLOEXEC set", { skip: !linux, timeout: 30_000 }, async () => {
  const token = "abt1_" + Buffer.from("test, not a token: the taken fd..", "latin1").toString("base64url");
  const runChild = async (fds: number[], names: string) => {
    const child = spawn(process.execPath, ["--disable-sigusr1", "--no-warnings", "--input-type=module", "-e", TAKER, ROOT, String(process.pid), sha256(token)], {
      stdio: ["ignore", "pipe", "pipe", ...fds], env: { PATH: process.env.PATH, LISTEN_FDS: String(fds.length), LISTEN_FDNAMES: names },
    });
    let out = "", err = "";
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (err += d));
    for (let i = 0; i < 300 && !out.includes("\n"); i++) await sleep(20);
    return { child, got: JSON.parse(out.split("\n")[0] || JSON.stringify({ error: `no line: ${err}` })) };
  };
  // A listening TCP socket on 127.0.0.1 that this test makes; its handle closes here once the child holds it.
  const tcp = createServer();
  await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
  const portNo = (tcp.address() as { port: number }).port;
  const tcpFd = (tcp as unknown as { _handle: { fd: number } })._handle.fd;
  const { child, got } = await runChild([tcpFd], MCP_SOCKET_UNIT);
  await new Promise<void>((r) => tcp.close(() => r()));
  try {
    assert.deepEqual(got, { fd: 3, port: portNo, cloexec: true, env: [] }, JSON.stringify(got));
    // This test process is the client: its walk reaches its own root (the child's set_sessions names it).
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: portNo, path: "/mcp/t-taken", headers: { Authorization: `Bearer ${token}` }, agent: false }, (r) => {
        let body = ""; r.on("data", (d) => (body += d)); r.on("end", () => resolve({ status: r.statusCode!, body }));
      });
      req.on("error", reject);
      req.end();
    });
    assert.deepEqual(res, { status: 200, body: "admitted t-taken" });
  } finally { child.kill("SIGKILL"); }
  // A Unix socket as the unit's fd: the port refuses to listen on it (127.0.0.1 only).
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-fd-"));
  const unix = createServer();
  try {
    await new Promise<void>((r) => unix.listen(join(dir, "u.sock"), r));
    const second = await runChild([(unix as unknown as { _handle: { fd: number } })._handle.fd], MCP_SOCKET_UNIT);
    second.child.kill("SIGKILL");
    assert.match(second.got.error ?? "", /listens on 127\.0\.0\.1 only, not on a socket that is not TCP/);
  } finally { await new Promise<void>((r) => unix.close(() => r())); rmSync(dir, { recursive: true, force: true }); }
});

test("the real service opens the MCP port only with systemd's socket or --test's --test-mcp-port; with neither it has no port, no feature mcp_token and the mcp state none", () => {
  const main = readFileSync(join(ROOT, "src/service/main.ts"), "utf8");
  assert.ok(/await mcpListen\(\{ test, testPort: test && testPort !== undefined \? testMcpPort\(testPort\) : undefined \}\)/.test(main), "systemd's socket or --test's port, through mcpListen (listen-fds.ts)");
  assert.ok(/"test-mcp-port"/.test(main), "--test-mcp-port only with --test");
  assert.ok(!/--mcp-port|"mcp-port"/.test(main), "no other MCP flag, no default port");
  const state = new Stage1a({ agentDoor: { url: (s) => s, state: () => ({ form: "stat" }) } });
  assert.deepEqual((state.hello as { features: string[] }).features, []);
  assert.deepEqual(state.status().mcp, { state: "none", address: null });
});

// ------------------------------------------------------------------ the review of part 2a: notes 1, 2, 8 and 10 (stage 1d part 2b)

test("review-114 note 1: FD_CLOEXEC goes on each passed fd as soon as LISTEN_PID and LISTEN_FDS are valid, before the name check; the three variables go in every path", async () => {
  const fcntls: number[] = [];
  const fcntl = (f: number, cmd: number) => { if (cmd === 2) fcntls.push(f); return cmd === 1 ? 0 : 0; };
  const base = { LISTEN_PID: "4242", LISTEN_FDS: "2", KEEP: "1" };
  for (const names of ["other.socket:more.socket", undefined, "x"]) {
    const env: Record<string, string | undefined> = { ...base, ...(names === undefined ? {} : { LISTEN_FDNAMES: names }) };
    fcntls.length = 0;
    await assert.rejects(takeMcpSocket(env, { pid: 4242, fcntl }), /does not name each fd|no socket named/);
    assert.deepEqual(fcntls, [3, 4], `${names}: FD_CLOEXEC on fds 3 and 4 before the name check`);
    assert.deepEqual(env, { KEEP: "1" }, `${names}: the variables are gone`);
  }
  for (const env of [{ LISTEN_PID: "4243", LISTEN_FDS: "1", LISTEN_FDNAMES: MCP_SOCKET_UNIT }, { LISTEN_PID: "4242", LISTEN_FDS: "0", LISTEN_FDNAMES: MCP_SOCKET_UNIT }, { LISTEN_FDS: "1" }] as Record<string, string | undefined>[]) {
    fcntls.length = 0;
    await assert.rejects(takeMcpSocket(env, { pid: 4242, fcntl }));
    assert.deepEqual(fcntls, [], "fds that are not this process's are not touched");
    assert.deepEqual(Object.keys(env), [], "the variables are gone also when they are not this process's");
  }
  const failing: Record<string, string | undefined> = { LISTEN_PID: "4242", LISTEN_FDS: "2", LISTEN_FDNAMES: `${MCP_SOCKET_UNIT}:x` };
  fcntls.length = 0;
  await assert.rejects(takeMcpSocket(failing, { pid: 4242, fcntl: (f, cmd) => { if (cmd === 2) fcntls.push(f); return f === 3 && cmd === 2 ? -1 : 0; } }), /fd 3 cannot be marked/);
  assert.deepEqual(fcntls, [3, 4], "a failed fcntl on fd 3 does not skip fd 4");
  assert.deepEqual(failing, {});
});

/** The port of one admitted md-lead connection (the linux world, the tokens snapshot), with a handler of the test. */
async function onePort(o: { handler?: McpHandler; readiness?: (scope: string) => McpReadiness; headersMs?: number; idleMs?: number } = {}) {
  const r = new WorldReader();
  const log: string[] = [];
  const handler = o.handler ?? stub();
  const port = await McpPort.open({ listen: { port: 0 }, handler, readiness: o.readiness ?? (() => READY), log: (l) => log.push(l), reader: { tcp: () => r.tcp(), holders: (i) => r.holders(i), proc: (p) => r.proc(p), cgroup: (p) => r.cgroup(p) }, uid: UID, headersMs: o.headersMs, idleMs: o.idleMs });
  r.service = `127.0.0.1:${port.port}`;
  const servers: Socket[] = [];
  port.listener.prependListener("connection", (s: Socket) => { servers.push(s); r.accepted(`127.0.0.1:${s.remotePort}`); });
  port.setSessions({ sessions: V.mcpSnapshots.tokens.sessions } as any);
  const open = async () => { r.pending.push([3102]); return rawClient(await dial(port.port)); };
  const host = (): [string, string] => ["host", `127.0.0.1:${port.port}`];
  const auth = (): [string, string] => ["authorization", `Bearer ${T.leadRun2.token}`];
  return { port, log, handler, servers, open, host, auth };
}

test("review-114 note 2: after a refusal of steps 3 to 8, a pipelined request on the connection is dropped with no handler call", async () => {
  const p = await onePort();
  try {
    const cl = await p.open();
    // Two requests in one write: the first has no token (401), the second has the session's own token.
    cl.sock.write(`GET /mcp/md-lead HTTP/1.1\r\nhost: 127.0.0.1:${p.port.port}\r\n\r\nGET /mcp/md-lead HTTP/1.1\r\nhost: 127.0.0.1:${p.port.port}\r\nauthorization: Bearer ${T.leadRun2.token}\r\n\r\n`);
    const got = await cl.response();
    assert.equal(got.status, 401);
    await cl.closes();
    assert.deepEqual((p.handler as any).requests, [], "the handler never saw the pipelined request");
    assert.equal(cl.all.split("HTTP/1.1 ").length - 1, 1, "one answer only");
  } finally { await p.port.stop(); }
});

test("review-114 note 2: a request with Expect runs steps 3 to 8 before any 100 or 417; CONNECT stays refused with no handler call", async () => {
  const p = await onePort();
  try {
    // 100-continue with no token: the 401, never a 100.
    const a = await p.open();
    a.send("/mcp/md-lead", [p.host(), ["expect", "100-continue"], ["content-length", "2"]], "POST");
    const ra = await a.response();
    assert.equal(ra.status, 401);
    assert.ok(!a.all.includes("100 Continue"), "no 100 before the token step");
    // 100-continue with the session's token: the 100, then the handler's answer.
    const b = await p.open();
    b.send("/mcp/md-lead", [p.host(), p.auth(), ["expect", "100-continue"], ["content-length", "2"]], "POST");
    for (let i = 0; i < 100 && !b.all.includes("100 Continue"); i++) await sleep(20);
    assert.ok(b.all.includes("100 Continue"), "the 100 after steps 3 to 8");
    b.sock.write("{}");
    const rb = await b.response();
    assert.equal(rb.status, 100);
    const rb2 = await b.response();
    assert.equal(rb2.status, 200);
    // Another expectation: the steps first (no token: 401), then with the token the 417, with no handler call.
    const c = await p.open();
    c.send("/mcp/md-lead", [p.host(), ["expect", "something-else"]]);
    assert.equal((await c.response()).status, 401);
    const before = (p.handler as any).requests.length;
    const d = await p.open();
    d.send("/mcp/md-lead", [p.host(), p.auth(), ["expect", "something-else"]]);
    assert.equal((await d.response()).status, 417);
    await d.closes();
    // CONNECT: Node closes it, with no handler call.
    const e = await p.open();
    e.send("127.0.0.1:1", [p.host(), p.auth()], "CONNECT");
    await e.closes();
    assert.equal((p.handler as any).requests.length, before, "neither the 417 nor the CONNECT reached the handler");
  } finally { await p.port.stop(); }
});

test("review-114 note 8: an exception in the readiness or the handler gives the fixed 500, which echoes nothing, and the port goes on", async () => {
  let mode: "readiness" | "sync" | "async" | "ok" = "readiness";
  const handler: McpHandler = {
    request(_req, res) {
      if (mode === "sync") throw new Error(`a handler failure with ${T.leadRun2.token}`);
      if (mode === "async") return Promise.reject(new Error("an async handler failure"));
      res.writeHead(200, { "Content-Length": 2 }).end("ok");
    },
    endSessions() {},
  };
  const p = await onePort({ handler, readiness: () => { if (mode === "readiness") throw new Error("a readiness failure"); return READY; } });
  try {
    for (const m of ["readiness", "sync", "async"] as const) {
      mode = m;
      const cl = await p.open();
      cl.send("/mcp/md-lead?q=secret-query", [p.host(), p.auth()]);
      const got = await cl.response();
      assert.deepEqual([got.status, got.body], [500, MCP_FAILED], m);
      assert.ok(!cl.all.includes(T.leadRun2.token) && !cl.all.includes("secret-query"), `${m}: the 500 echoes nothing`);
      await cl.closes();
    }
    mode = "ok";
    const cl = await p.open();
    cl.send("/mcp/md-lead", [p.host(), p.auth()]);
    assert.equal((await cl.response()).status, 200, "the port goes on");
    assert.equal(p.log.filter((l) => /a GET request failed \(500\)$/.test(l)).length, 3);
    assert.ok(!p.log.join("\n").includes("secret-query") && !p.log.join("\n").includes(T.leadRun2.token));
  } finally { await p.port.stop(); }
});

test("review-114 note 10: an admitted connection that sends nothing, a header that comes slowly and an idle keep-alive connection close after the header time; a body that pauses closes after the idle time; a long answer is not cut", { timeout: 30_000 }, async () => {
  assert.equal(MCP_HEADERS_MS, 10_000);
  assert.equal(MCP_IDLE_MS, 30_000);
  let wait = 0;
  const handler: McpHandler = {
    async request(req, res) {
      for await (const _ of req) { /* the body */ }
      if (wait) await sleep(wait);
      res.writeHead(200, { "Content-Length": 2 }).end("ok");
    },
    endSessions() {},
  };
  const p = await onePort({ handler, headersMs: 300, idleMs: 300 });
  try {
    assert.equal((p.port as any).http.keepAliveTimeout, 0, "Node's own keep-alive timeout (5 s) is off: the header time governs an idle connection");
    const t0 = Date.now();
    const silent = await p.open();
    await silent.closes();
    assert.ok(Date.now() - t0 >= 250, "nothing sent: closed after the header time");
    assert.equal(silent.all, "", "with no answer");
    const slow = await p.open();
    slow.sock.write(`GET /mcp/md-lead HTTP/1.1\r\nhost: 127.0.0.1:${p.port.port}\r\n`);
    await slow.closes();
    assert.equal(slow.all, "", "a header that never ends");
    const keep = await p.open();
    keep.send("/mcp/md-lead", [p.host(), p.auth()]);
    assert.equal((await keep.response()).status, 200);
    await keep.closes();
    const body = await p.open();
    body.sock.write(`POST /mcp/md-lead HTTP/1.1\r\nhost: 127.0.0.1:${p.port.port}\r\nauthorization: Bearer ${T.leadRun2.token}\r\ncontent-length: 10\r\n\r\n{`);
    await body.closes();
    assert.equal(body.all, "", "a body that pauses: closed with no answer");
    wait = 900;
    const long = await p.open();
    long.send("/mcp/md-lead", [p.host(), p.auth()]);
    assert.equal((await long.response()).status, 200, "a long answer (900 ms, past both times) is not cut");
    assert.ok(p.log.some((l) => l.endsWith("closed: no request header in time")) && p.log.some((l) => l.endsWith("closed: the request body paused too long")));
  } finally { await p.port.stop(); }
});

test("review-114 note 5: a connection that a root's cgroup admitted closes when only that root's cgroup stops counting; one that the walk admitted stays", async () => {
  const r = new WorldReader();
  const handler = stub();
  const log: string[] = [];
  const port = await McpPort.open({ listen: { port: 0 }, handler, readiness: () => READY, log: (l) => log.push(l), reader: { tcp: () => r.tcp(), holders: (i) => r.holders(i), proc: (p) => r.proc(p), cgroup: (p) => r.cgroup(p) }, uid: UID });
  r.service = `127.0.0.1:${port.port}`;
  port.listener.prependListener("connection", (s: Socket) => r.accepted(`127.0.0.1:${s.remotePort}`));
  try {
    port.setSessions({ sessions: V.mcpSnapshots.tokens.sessions } as any);
    // 3110: a nohup job of md-lead, re-parented: the walk meets no root, and md-lead's pane cgroup admits it.
    r.pending.push([3110]);
    const byCgroup = rawClient(await dial(port.port));
    byCgroup.send("/mcp/md-lead", [["host", `127.0.0.1:${port.port}`], ["authorization", `Bearer ${T.leadRun2.token}`]]);
    assert.equal((await byCgroup.response()).status, 200);
    // 3102: a tool command of md-lead under its pane: the walk admits it.
    r.pending.push([3102]);
    const byWalk = rawClient(await dial(port.port));
    byWalk.send("/mcp/md-lead", [["host", `127.0.0.1:${port.port}`], ["authorization", `Bearer ${T.leadRun2.token}`]]);
    assert.equal((await byWalk.response()).status, 200);
    assert.equal(port.connections("md-lead"), 2);
    // The pane 3100 moves into its parent's cgroup: the root still counts for the walk, but its cgroup no longer counts.
    r.w.set(3100, { ...r.w.get(3100)!, cgroup: r.w.get(3000)!.cgroup });
    port.setSessions({ sessions: V.mcpSnapshots.tokens.sessions } as any);
    await byCgroup.closes();
    assert.equal(port.connections("md-lead"), 1, "the walk's connection stays");
    assert.ok(log.some((l) => /^mcp: connection 1 \(scope md-lead\) closed: a root that admitted it no longer counts$/.test(l)), log.join("\n"));
    assert.deepEqual(handler.ended, ["md-lead"], "its MCP sessions end with it (OP4)");
  } finally { await port.stop(); }
});

test("review-115 note 1: the service removes LISTEN_PID, LISTEN_FDS and LISTEN_FDNAMES in every path (also in --test mode and when only LISTEN_FDNAMES is set), and sets FD_CLOEXEC where the fds are its own", async () => {
  const { mcpListen } = await import("../src/service/mcp/listen-fds.ts");
  const fcntls: number[] = [];
  const fcntl = (f: number, cmd: number) => { if (cmd === 2) fcntls.push(f); return 0; };
  const own = (): Record<string, string | undefined> => ({ LISTEN_PID: "4242", LISTEN_FDS: "1", LISTEN_FDNAMES: MCP_SOCKET_UNIT, KEEP: "1" });
  // --test with the flag: its port; systemd's fd is not taken, but it is marked and the variables go.
  let env = own(); fcntls.length = 0;
  assert.deepEqual(await mcpListen({ test: true, testPort: 0, env, pid: 4242, fcntl }), { port: 0 });
  assert.deepEqual([env, fcntls], [{ KEEP: "1" }, [3]]);
  // --test with no flag: no port, and the same clean.
  env = own(); fcntls.length = 0;
  assert.equal(await mcpListen({ test: true, env, pid: 4242, fcntl }), null);
  assert.deepEqual([env, fcntls], [{ KEEP: "1" }, [3]]);
  // Only LISTEN_FDNAMES: the take fails (failed), and the variable goes.
  env = { LISTEN_FDNAMES: MCP_SOCKET_UNIT, KEEP: "1" }; fcntls.length = 0;
  const got = await mcpListen({ test: false, env, pid: 4242, fcntl });
  assert.ok(got !== null && "failed" in got && /no LISTEN_PID or LISTEN_FDS/.test(got.failed), JSON.stringify(got));
  assert.deepEqual([env, fcntls], [{ KEEP: "1" }, []]);
  // The service's own socket: taken.
  env = own(); fcntls.length = 0;
  assert.deepEqual(await mcpListen({ test: false, env, pid: 4242, fcntl }), { fd: 3 });
  assert.deepEqual(env, { KEEP: "1" });
  // No variable: no port, nothing touched.
  env = { KEEP: "1" }; fcntls.length = 0;
  assert.equal(await mcpListen({ test: false, env, pid: 4242, fcntl }), null);
  assert.deepEqual([env, fcntls], [{ KEEP: "1" }, []]);
  // main.ts takes its listen from mcpListen only.
  assert.match(readFileSync(join(ROOT, "src/service/main.ts"), "utf8"), /await mcpListen\(/);
});
