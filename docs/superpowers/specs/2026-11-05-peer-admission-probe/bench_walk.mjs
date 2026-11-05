// The cost of the walk and of the cgroup read in Node (board ab-v16.47 probe): 2000 walks from this
// process to init, with readFileSync of /proc/<pid>/stat.
import { readFileSync } from "node:fs";
const N = 2000;
function walk(pid) {
  const chain = [];
  for (;;) {
    let raw;
    try { raw = readFileSync(`/proc/${pid}/stat`, "latin1"); } catch { return chain; }
    const rest = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    chain.push([pid, Number(rest[19])]);
    const ppid = Number(rest[1]);
    if (ppid <= 1) return chain;
    pid = ppid;
  }
}
let t = process.hrtime.bigint(), chain;
for (let i = 0; i < N; i++) chain = walk(process.pid);
const walkUs = Number(process.hrtime.bigint() - t) / 1000 / N;
t = process.hrtime.bigint();
for (let i = 0; i < N; i++) readFileSync(`/proc/${process.pid}/cgroup`, "utf8");
const cgUs = Number(process.hrtime.bigint() - t) / 1000 / N;
console.log(JSON.stringify({ node: process.version, hops: chain.length, walk_us: +walkUs.toFixed(1), per_hop_us: +(walkUs / chain.length).toFixed(1), cgroup_read_us: +cgUs.toFixed(1) }));
