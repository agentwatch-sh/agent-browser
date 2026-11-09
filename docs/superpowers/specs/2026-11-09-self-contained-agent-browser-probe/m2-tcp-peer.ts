// M2 (board ab-v16.93): the peer check over loopback TCP, on Linux, with no SO_PEERCRED.
//
// A small HTTP server on 127.0.0.1:0. At each accepted connection it finds the client's process:
//   1. the client's socket in /proc/net/tcp (its local port is the connection's remote port): its uid and inode;
//   2. another uid: refused at once, before any walk (a loopback port is open to every local user);
//   3. the holders of that inode: a scan of /proc/<pid>/fd ("full": every process; "cgroup": only the processes of
//      the claimed session's pane cgroup, here this probe's own cgroup as the stand-in);
//   4. the walk from each holder through its parents to a root (pid, start time), as src/relay/peer.ts does;
//   5. the client's line again after the walk (the client still holds its socket).
// It compares the cost with SO_PEERCRED on a Unix socket (the repo's own reader, src/relay/peer.ts).
//
// Roots: two processes of the probe's own (root-a.mjs-like inline scripts), each the "pane" of a scope. Clients are
// children of a root (in scope), of the other root (another session), or of the driver (no session). No Chrome, no
// display, no tmux; only processes that this probe starts. It writes results/m2.json.
//
// Run: node m2-tcp-peer.ts [N]   (N connections per timing case, default 200)

import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { createServer as netServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseStat, selfTest, type PeerReader } from "../../../../src/relay/peer.ts";

if (process.platform !== "linux") throw new Error("M2 runs on Linux only");
const N = Number(process.argv[2] ?? 200);
const UID = process.getuid!();
const OUT = new URL("./results/m2.json", import.meta.url);

// ------------------------------------------------------------------ the check's parts

type Line = { uid: number; inode: number; state: string; file: string; lines: number };
const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
const LOOP4 = "0100007F";
const LOOP6 = ["00000000000000000000000001000000", "0000000000000000FFFF00000100007F"];

/** The client's own socket: local = 127.0.0.1:<clientPort>, remote = 127.0.0.1:<serverPort> (tcp, then tcp6). */
function lookup(clientPort: number, serverPort: number): Line | null {
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const rows = readFileSync(file, "latin1").split("\n");
    for (let i = 1; i < rows.length; i++) {
      const f = rows[i].trim().split(/\s+/);
      if (f.length < 10) continue;
      const [la, lp] = f[1].split(":"), [ra, rp] = f[2].split(":");
      const loop = file.endsWith("6") ? LOOP6 : [LOOP4];
      if (lp === hex4(clientPort) && rp === hex4(serverPort) && loop.includes(la) && loop.includes(ra))
        return { uid: Number(f[7]), inode: Number(f[9]), state: f[3], file, lines: rows.length - 2 };
    }
  }
  return null;
}

type Scan = { holders: number[]; pids: number; fds: number; denied: number };
/** The processes that hold socket:[inode], among `pids` (every process when null). */
function holders(inode: number, pids: number[] | null): Scan {
  const want = `socket:[${inode}]`;
  const list = pids ?? readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map(Number);
  const out: Scan = { holders: [], pids: 0, fds: 0, denied: 0 };
  for (const pid of list) {
    if (pid === process.pid) continue;
    let fds: string[];
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch { out.denied++; continue; }
    out.pids++;
    for (const fd of fds) {
      out.fds++;
      try { if (readlinkSync(`/proc/${pid}/fd/${fd}`) === want) { out.holders.push(pid); break; } } catch { /* gone */ }
    }
  }
  return out;
}

/** The pids of a cgroup and of the cgroups under it. */
function cgroupPids(path: string): number[] {
  const dir = `/sys/fs/cgroup${path}`;
  const out: number[] = [];
  const visit = (d: string) => {
    for (const l of readFileSync(join(d, "cgroup.procs"), "latin1").split("\n")) if (l) out.push(Number(l));
    for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) visit(join(d, e.name));
  };
  visit(dir);
  return out;
}

const proc = (pid: number) => { try { return parseStat(readFileSync(`/proc/${pid}/stat`, "latin1")); } catch { return null; } };
const cgroupOf = (pid: number) => { try { return /^0::(.*)$/m.exec(readFileSync(`/proc/${pid}/cgroup`, "latin1"))?.[1] ?? null; } catch { return null; } };

/** The walk of src/relay/peer.ts: up the parents to the first root of any scope, at most 32 hops. */
function walk(pid: number, roots: Map<string, string>): { scope: string | null; hops: number } {
  let p = pid;
  for (let hops = 0; hops <= 32; hops++) {
    const s = proc(p);
    if (!s) return { scope: null, hops };
    const scope = roots.get(`${p}:${s.start}`);
    if (scope) return { scope, hops };
    if (s.ppid <= 1) return { scope: null, hops };
    p = s.ppid;
  }
  return { scope: null, hops: 33 };
}

type Decision = { admit: boolean; why: string; holders?: number[]; ms: Record<string, number>; scan?: Omit<Scan, "holders">; lines?: number; family?: string };

/** The TCP check, in the order of the design: line, uid, inode, holders, walk, line again. */
function checkTcp(clientPort: number, serverPort: number, scope: string, roots: Map<string, string>, scanMode: "full" | "cgroup", cgroup: string): Decision {
  const ms: Record<string, number> = {};
  let t = performance.now();
  const line = lookup(clientPort, serverPort);
  ms.lookup = performance.now() - t;
  if (!line) return { admit: false, why: "no line: the client's socket is gone", ms };
  if (line.uid !== UID) return { admit: false, why: `another user (uid ${line.uid})`, ms, lines: line.lines };
  if (line.inode === 0) return { admit: false, why: "inode 0: no process holds the client's socket", ms, lines: line.lines };
  t = performance.now();
  const scan = holders(line.inode, scanMode === "full" ? null : cgroupPids(cgroup));
  ms.scan = performance.now() - t;
  const base = { ms, lines: line.lines, family: line.file.endsWith("6") ? "tcp6" : "tcp", scan: { pids: scan.pids, fds: scan.fds, denied: scan.denied } };
  if (!scan.holders.length) return { admit: false, why: "no holder found: the client has gone", holders: [], ...base };
  t = performance.now();
  const scopes = scan.holders.map((h) => walk(h, roots).scope);
  ms.walk = performance.now() - t;
  t = performance.now();
  const again = lookup(clientPort, serverPort);
  ms.again = performance.now() - t;
  ms.total = Object.values(ms).reduce((a, b) => a + b, 0);
  if (!again || again.inode !== line.inode) return { admit: false, why: "the client's socket changed during the check", holders: scan.holders, ...base };
  if (scopes.some((s) => s !== scope)) return { admit: false, why: `a holder is not in scope ${scope}: ${JSON.stringify(scopes)}`, holders: scan.holders, ...base };
  return { admit: true, why: "every holder walks to a root of the scope", holders: scan.holders, ...base };
}

// ------------------------------------------------------------------ the processes of the probe

/** A root: a process that starts clients as its children on request (one JSON line per client on stdin). */
const ROOT = `
const { spawn } = require("node:child_process");
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (l) => {
  const { argv } = JSON.parse(l);
  const c = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "inherit"] });
  let out = ""; c.stdout.on("data", (d) => (out += d));
  c.on("close", (code) => process.stdout.write(JSON.stringify({ code, out }) + "\\n"));
});
rl.on("close", () => process.exit(0));
`;

/** A client: mode "one" (one GET), "many" (N GETs, one connection each), "exit" (write the request, exit at once). */
const CLIENT = `
const net = require("node:net");
const [port, path, mode, n] = process.argv.slice(1);
const one = () => new Promise((resolve) => {
  const s = net.connect(Number(port), "127.0.0.1", () => {
    s.write("GET " + path + " HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n");
    if (mode === "exit") process.exit(0);
  });
  let got = ""; s.on("data", (d) => (got += d)); s.on("close", () => resolve(got.split("\\r\\n\\r\\n")[1] ?? "")); s.on("error", () => resolve("error"));
});
(async () => {
  if (mode === "many") { for (let i = 0; i < Number(n); i++) await one(); console.log("done"); }
  else console.log(await one());
})();
`;

/** A forked holder: the connecter forks, and both hold the socket while the parent sends the request. */
const FORKED = `
import os, socket, sys, time
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])))
pid = os.fork()
if pid == 0:
    time.sleep(1.5); os._exit(0)
s.sendall(("GET " + sys.argv[2] + " HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n").encode())
data = b""
while True:
    b = s.recv(65536)
    if not b: break
    data += b
os.waitpid(pid, 0)
print(data.split(b"\\r\\n\\r\\n", 1)[1].decode())
`;

const started: ChildProcess[] = [];
function startRoot(): Promise<{ child: ChildProcess; pid: number; start: number; ask: (argv: string[]) => Promise<{ code: number; out: string }> }> {
  const child = spawn(process.execPath, ["-e", ROOT], { stdio: ["pipe", "pipe", "inherit"], detached: true });
  started.push(child);
  const waiting: ((v: any) => void)[] = [];
  let buf = "";
  child.stdout!.on("data", (d) => { buf += d; for (let i; (i = buf.indexOf("\n")) >= 0;) { const l = buf.slice(0, i); buf = buf.slice(i + 1); waiting.shift()?.(JSON.parse(l)); } });
  const ask = (argv: string[]) => new Promise<{ code: number; out: string }>((r) => { waiting.push(r); child.stdin!.write(JSON.stringify({ argv }) + "\n"); });
  return new Promise((resolve) => setTimeout(() => resolve({ child, pid: child.pid!, start: proc(child.pid!)!.start, ask }), 200));
}
function runHere(argv: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "inherit"] });
    started.push(c);
    let out = ""; c.stdout!.on("data", (d) => (out += d)); c.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

// ------------------------------------------------------------------ the run

const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3) : null; };
const stats = (a: number[]) => ({ n: a.length, p50: pct(a, 0.5), p90: pct(a, 0.9), p99: pct(a, 0.99), max: a.length ? +Math.max(...a).toFixed(3) : null });

const rootA = await startRoot(), rootB = await startRoot();
const roots = new Map([[`${rootA.pid}:${rootA.start}`, "sa"], [`${rootB.pid}:${rootB.start}`, "sb"]]);
const cgroup = cgroupOf(process.pid)!;
const records: { case: string; scope: string; scanMode: string; d: Decision; later?: Decision }[] = [];
let current = { name: "", scanMode: "full" as "full" | "cgroup", later: false };

const http = createServer((req, res) => {
  const d = (req.socket as any).__decision as Decision;
  res.writeHead(d.admit ? 200 : 403, { "Content-Type": "text/plain" }).end(d.admit ? "admitted" : `refused: ${d.why}`);
});
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const PORT = (http.address() as { port: number }).port;
http.on("connection", (sock: Socket) => {
  // The check runs at the accept, before the request is read (as the relay's peer read does).
  const scope = "sa"; // every client below asks for /mcp/sa
  const clientPort = sock.remotePort!;
  const d = checkTcp(clientPort, PORT, scope, roots, current.scanMode, cgroup);
  (sock as any).__decision = d;
  const rec: (typeof records)[number] = { case: current.name, scope, scanMode: current.scanMode, d };
  records.push(rec);
  // For the "exit at once" case: the same check 50 ms later, when the client is surely gone.
  if (current.later) setTimeout(() => { rec.later = checkTcp(clientPort, PORT, scope, roots, current.scanMode, cgroup); }, 50);
});

const node = process.execPath;
const summary: Record<string, unknown> = { port: PORT, roots: { sa: [rootA.pid, rootA.start], sb: [rootB.pid, rootB.start] }, cgroup: cgroup.replace(/tmux-spawn-[0-9a-f-]+\.scope/, "tmux-spawn-<uuid>.scope"), kernel: readFileSync("/proc/sys/kernel/osrelease", "latin1").trim(), node: process.version };

async function phase(name: string, scanMode: "full" | "cgroup", fn: () => Promise<unknown>, later = false) {
  current = { name, scanMode, later };
  const before = records.length;
  const out = await fn();
  await new Promise((r) => setTimeout(r, later ? 120 : 20));
  return { out, recs: records.slice(before) };
}

const cases: Record<string, unknown> = {};
for (const scanMode of ["full", "cgroup"] as const) {
  const inScope = await phase(`in-scope (${scanMode})`, scanMode, () => rootA.ask([node, "-e", CLIENT, String(PORT), "/mcp/sa", "one"]));
  const other = await phase(`other session (${scanMode})`, scanMode, () => rootB.ask([node, "-e", CLIENT, String(PORT), "/mcp/sa", "one"]));
  const none = await phase(`no session (${scanMode})`, scanMode, () => runHere([node, "-e", CLIENT, String(PORT), "/mcp/sa", "one"]));
  const forked = await phase(`forked holders (${scanMode})`, scanMode, () => rootA.ask(["python3", "-c", FORKED, String(PORT), "/mcp/sa"]));
  cases[scanMode] = Object.fromEntries([inScope, other, none, forked].map((p) => [p.recs[0]?.case, { admit: p.recs[0]?.d.admit, why: p.recs[0]?.d.why, holders: p.recs[0]?.d.holders?.length, client: String((p.out as any).out).trim().slice(0, 160) }]));
  // Timing: N connections from a client of root A.
  const many = await phase(`timing (${scanMode})`, scanMode, () => rootA.ask([node, "-e", CLIENT, String(PORT), "/mcp/sa", "many", String(N)]));
  const ok = many.recs.filter((r) => r.d.admit).length;
  const key = (k: string) => stats(many.recs.map((r) => r.d.ms[k]).filter((v) => v !== undefined));
  cases[`timing-${scanMode}`] = { connections: many.recs.length, admitted: ok, lookup: key("lookup"), scan: key("scan"), walk: key("walk"), again: key("again"), total: key("total"),
    tcpLines: stats(many.recs.map((r) => r.d.lines ?? 0)), pidsScanned: stats(many.recs.map((r) => r.d.scan?.pids ?? 0)), fdsScanned: stats(many.recs.map((r) => r.d.scan?.fds ?? 0)), denied: stats(many.recs.map((r) => r.d.scan?.denied ?? 0)) };
}
// The client that writes its request and exits at once: 50 tries, the check at the accept and again 50 ms later.
{
  const tries: { atAccept: string; later: string }[] = [];
  for (let i = 0; i < 50; i++) {
    const p = await phase("exit at once", "full", () => rootA.ask([node, "-e", CLIENT, String(PORT), "/mcp/sa", "exit"]), true);
    const r = p.recs[0];
    tries.push({ atAccept: r ? (r.d.admit ? "admitted" : r.d.why) : "no accept", later: r?.later ? (r.later.admit ? "admitted" : r.later.why) : "none" });
  }
  const count = (k: "atAccept" | "later") => tries.reduce<Record<string, number>>((m, t) => ((m[t[k]] = (m[t[k]] ?? 0) + 1), m), {});
  cases["exit at once (50 tries)"] = { atAccept: count("atAccept"), fiftyMsLater: count("later") };
}

// The comparison: SO_PEERCRED on a Unix socket with the repo's reader (node:ffi), then the same walk.
{
  const dir = mkdtempSync(join(tmpdir(), "m2-unix-"));
  const sockPath = join(dir, "e.sock");
  const st = await selfTest(sockPath);
  if ("failed" in st) cases["unix SO_PEERCRED"] = { failed: st.failed };
  else {
    const reader = st.reader as PeerReader & { cred(fd: number): { pid: number; uid: number } | null };
    const times: number[] = [], walks: number[] = [];
    let admitted = 0;
    const srv = netServer((s) => {
      const t0 = performance.now();
      const fd = (s as any)._handle.fd as number;
      const c = (reader as any).cred(fd) as { pid: number; uid: number } | null;
      const t1 = performance.now();
      const w = c ? walk(c.pid, roots) : { scope: null };
      const t2 = performance.now();
      times.push(t1 - t0); walks.push(t2 - t1);
      if (c && c.uid === UID && w.scope === "sa") admitted++;
      s.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    await new Promise<void>((r) => srv.listen(sockPath, r));
    const UCLIENT = `const net=require("node:net");(async()=>{for(let i=0;i<${N};i++)await new Promise((r)=>{const s=net.connect(process.argv[1],()=>s.write("GET /mcp/sa HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n"));s.resume();s.on("close",r);s.on("error",r);});console.log("done")})()`;
    await rootA.ask([node, "-e", UCLIENT, sockPath]);
    srv.close();
    cases["unix SO_PEERCRED"] = { form: reader.form, connections: times.length, admitted, peercred: stats(times), walk: stats(walks) };
  }
  rmSync(dir, { recursive: true, force: true });
}

// Another OS user: not run (the probe changes no user). The facts the check relies on:
let rootFd = "readable";
try { readdirSync("/proc/1/fd"); } catch (e) { rootFd = (e as NodeJS.ErrnoException).code ?? "error"; }
summary.anotherUser = { procOneFd: rootFd, rule: "the uid column of the client's /proc/net/tcp line is the socket's owner (set at socket creation); a line with another uid is refused before any scan; another user's /proc/<pid>/fd cannot be read either (denied count in the scans)" };
summary.cases = cases;
writeFileSync(OUT, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));

http.close();
for (const c of started) if (c.exitCode === null && c.signalCode === null) { try { c.stdin?.end(); } catch { /* */ } c.kill("SIGTERM"); }
process.exit(0);
