// The relay reads the peer through a helper process that inherits the accepted socket as fd 3
// (board ab-v16.47 probe). Node core has no SO_PEERCRED, but child_process.spawn can pass a
// net.Socket in stdio.
//   node node_helper_peercred.mjs <scratch folder> <connections> <helper argv...>
import net from "node:net";
import { join } from "node:path";
import { spawn } from "node:child_process";

const [folder, nArg, ...helper] = process.argv.slice(2);
const N = Number(nArg);
const sock = join(folder, `helper-${process.pid}.sock`);
const times = [];
let wrong = 0, seen = 0;
let expect = null;
const server = net.createServer((s) => {
  const t = process.hrtime.bigint();
  s.pause();
  const h = spawn(helper[0], helper.slice(1), { stdio: ["ignore", "pipe", "inherit", s] });
  let out = "";
  h.stdout.on("data", (d) => { out += d; });
  h.on("close", () => {
    times.push(Number(process.hrtime.bigint() - t) / 1000);
    seen++;
    if (Number(out.split(" ")[0]) !== expect) wrong++;
    s.end();
  });
});
await new Promise((r) => server.listen(sock, r));
const client = spawn(process.execPath, ["-e", `
  const net = require("node:net"); let i = 0;
  const one = () => { const c = net.connect(${JSON.stringify(sock)}); c.on("close", () => (++i < ${N} ? one() : process.exit(0))); c.on("data", () => {}); c.on("error", () => {}); };
  one();`], { stdio: "inherit" });
expect = client.pid;
await new Promise((r) => client.on("exit", r));
await new Promise((r) => setTimeout(r, 100));
server.close();
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]?.toFixed(0); };
console.log(JSON.stringify({ helper: helper.join(" ").replace(/^.*\//, ""), connections: seen, wrongPid: wrong, per_connection_us: { p50: q(times, 0.5), p99: q(times, 0.99) } }));
