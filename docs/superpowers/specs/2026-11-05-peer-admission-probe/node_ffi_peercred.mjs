// The relay reads the peer itself, in-process, with Node 26's node:ffi (board ab-v16.47 probe).
//   node node_ffi_peercred.mjs <scratch folder> [connections]
// A net server on a Unix socket; at each 'connection' it calls libc getsockopt(SO_PEERCRED) and
// getsockopt(SO_PEERPIDFD) on socket._handle.fd, and reads /proc/<pid>/stat. A client loop in this
// process connects N times. It prints the pid that each call gave against the client's pid, and
// the cost per connection.
import ffi from "node:ffi";
import net from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const [folder, nArg] = process.argv.slice(2);
const N = Number(nArg ?? 1000);
const SOL_SOCKET = 1, SO_PEERCRED = 17, SO_PEERPIDFD = 77;
const libc = ffi.dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
  getsockopt: { return: "int32", arguments: ["int32", "int32", "int32", "buffer", "buffer"] },
  close: { return: "int32", arguments: ["int32"] },
});
const { getsockopt, close } = libc.functions;

function peercred(fd) {
  const buf = Buffer.alloc(12), len = Buffer.alloc(4);
  len.writeUInt32LE(12);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, buf, len) !== 0) return null;
  return { pid: buf.readInt32LE(0), uid: buf.readInt32LE(4), gid: buf.readInt32LE(8) };
}
function peerpidfd(fd) {
  const buf = Buffer.alloc(4), len = Buffer.alloc(4);
  len.writeUInt32LE(4);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERPIDFD, buf, len) !== 0) return null;
  return buf.readInt32LE(0);
}
function stat(pid) {
  const raw = readFileSync(`/proc/${pid}/stat`, "latin1");
  const rest = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  return { ppid: Number(rest[1]), start: Number(rest[19]) };
}

const sock = join(folder, `ffi-${process.pid}.sock`);
const times = { cred: [], pidfd: [], stat: [] };
let wrong = 0, seen = 0, fdMissing = 0;
let expect = null;
const server = net.createServer((s) => {
  const fd = s._handle?.fd;
  if (typeof fd !== "number" || fd < 0) { fdMissing++; s.destroy(); return; }
  let t = process.hrtime.bigint();
  const c = peercred(fd);
  times.cred.push(Number(process.hrtime.bigint() - t) / 1000);
  t = process.hrtime.bigint();
  const pfd = peerpidfd(fd);
  times.pidfd.push(Number(process.hrtime.bigint() - t) / 1000);
  if (pfd !== null && pfd >= 0) close(pfd);
  t = process.hrtime.bigint();
  stat(c.pid);
  times.stat.push(Number(process.hrtime.bigint() - t) / 1000);
  seen++;
  if (expect !== null && c.pid !== expect) wrong++;
  s.end();
});
await new Promise((r) => server.listen(sock, r));

// The client: a separate process, so the peer pid differs from ours.
const client = spawn(process.execPath, ["-e", `
  const net = require("node:net"); let i = 0;
  const one = () => { const c = net.connect(${JSON.stringify(sock)}); c.on("close", () => (++i < ${N} ? one() : process.exit(0))); c.on("data", () => {}); c.on("error", () => {}); };
  one();`], { stdio: "inherit" });
expect = client.pid;
await new Promise((r) => client.on("exit", r));
await new Promise((r) => setTimeout(r, 100));
server.close();
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]?.toFixed(1); };
console.log(JSON.stringify({ node: process.version, connections: seen, fdMissing, wrongPid: wrong, clientPid: expect,
  peercred_us: { p50: q(times.cred, 0.5), p99: q(times.cred, 0.99) },
  peerpidfd_us: { p50: q(times.pidfd, 0.5), p99: q(times.pidfd, 0.99) },
  proc_stat_us: { p50: q(times.stat, 0.5), p99: q(times.stat, 0.99) } }));
