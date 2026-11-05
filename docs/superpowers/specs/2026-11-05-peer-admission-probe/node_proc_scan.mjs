// The relay finds the peer without SO_PEERCRED, Linux only (board ab-v16.47 probe): the peer's inode
// from `ss -x` (sock_diag; /proc/net/unix has no peer column), then the processes that hold that
// inode, from a scan of /proc/<pid>/fd. Also `ss -xp`, which does both.
//   node node_proc_scan.mjs <scratch folder>
import net from "node:net";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { readdirSync, readlinkSync, readlinkSync as rl } from "node:fs";

const [folder] = process.argv.slice(2);
const sock = join(folder, `scan-${process.pid}.sock`);
const results = [];
const server = net.createServer(async (s) => {
  const fd = s._handle.fd;
  const own = readlinkSync(`/proc/self/fd/${fd}`); // socket:[inode]
  const ownIno = own.slice(8, -1);
  let t = process.hrtime.bigint();
  const ssx = execFileSync("ss", ["-x", "-n", "-H"], { encoding: "utf8" });
  const ssUs = Number(process.hrtime.bigint() - t) / 1000;
  // ss -x: Netid State Recv-Q Send-Q Local-Address Port Peer-Address Port
  const row = ssx.split("\n").find((l) => l.split(/\s+/)[5] === ownIno);
  const peerIno = row ? row.trim().split(/\s+/).pop() : null;
  t = process.hrtime.bigint();
  const holders = [];
  let fds = 0, pids = 0;
  for (const p of readdirSync("/proc")) {
    if (!/^\d+$/.test(p)) continue;
    pids++;
    let list;
    try { list = readdirSync(`/proc/${p}/fd`); } catch { continue; }
    for (const f of list) {
      fds++;
      try { if (rl(`/proc/${p}/fd/${f}`) === `socket:[${peerIno}]`) holders.push(Number(p)); } catch {}
    }
  }
  const scanUs = Number(process.hrtime.bigint() - t) / 1000;
  t = process.hrtime.bigint();
  execFileSync("ss", ["-x", "-p", "-n", "-H"], { encoding: "utf8" });
  const sspUs = Number(process.hrtime.bigint() - t) / 1000;
  results.push({ ssx_us: Math.round(ssUs), scan_us: Math.round(scanUs), ssxp_us: Math.round(sspUs), pids, fds, holders });
  s.end();
});
await new Promise((r) => server.listen(sock, r));
for (let i = 0; i < 5; i++) {
  const client = spawn("python3", ["-c", `import socket,time,os\ns=socket.socket(socket.AF_UNIX);s.connect(${JSON.stringify(sock)})\nif os.fork()==0:\n  time.sleep(1);os._exit(0)\ns.recv(10)`], { stdio: "inherit" });
  await new Promise((r) => client.on("exit", r));
  results[results.length - 1].client = client.pid;
}
server.close();
for (const r of results) console.log(JSON.stringify(r));
