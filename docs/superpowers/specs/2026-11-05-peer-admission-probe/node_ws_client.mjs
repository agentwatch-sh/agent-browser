// The WebSocket client of the fd-passing probe (board ab-v16.47): N connections one after the other,
// then a burst of P at once. Each sends "ping" and waits for "pong <scope> <pid>".
//   node node_ws_client.mjs <endpoint socket> <ws module folder> <N> <P> <label>
import { createRequire } from "node:module";
const [endpoint, wsFolder, nArg, pArg, label] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const WebSocket = require(wsFolder);

function one() {
  return new Promise((resolve) => {
    const t = process.hrtime.bigint();
    const ws = new WebSocket(`ws+unix://${endpoint}:/devtools/browser/probe`);
    ws.on("open", () => ws.send("ping"));
    ws.on("message", (d) => { resolve({ ok: true, us: Number(process.hrtime.bigint() - t) / 1000, text: String(d) }); ws.close(); });
    ws.on("unexpected-response", (_req, res) => { resolve({ ok: false, status: res.statusCode }); ws.terminate(); });
    ws.on("error", (e) => resolve({ ok: false, error: e.message }));
  });
}
const seq = [];
for (let i = 0; i < Number(nArg); i++) seq.push(await one());
const burst = await Promise.all(Array.from({ length: Number(pArg) }, one));
const q = (a, p) => { const s = a.filter((r) => r.ok).map((r) => r.us).sort((x, y) => x - y); return s.length ? s[Math.floor(p * (s.length - 1))].toFixed(0) : null; };
const pids = new Set([...seq, ...burst].filter((r) => r.ok).map((r) => r.text.split(" ")[2]));
console.log(JSON.stringify({ label, client_pid: process.pid, sequential: { n: seq.length, ok: seq.filter((r) => r.ok).length, p50_us: q(seq, 0.5), p99_us: q(seq, 0.99) },
  burst: { n: burst.length, ok: burst.filter((r) => r.ok).length, p50_us: q(burst, 0.5), p99_us: q(burst, 0.99) },
  refused: [...seq, ...burst].filter((r) => !r.ok).slice(0, 1), pids_seen: [...pids], scope_seen: [...new Set([...seq, ...burst].filter((r) => r.ok).map((r) => r.text.split(" ")[1]))] }));
