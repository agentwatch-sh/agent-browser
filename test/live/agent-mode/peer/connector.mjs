// The peer group's long-lived client (board ab-v16.51): a process of the live test that a tmux pane starts in some
// shape (a tool command, a nohup job whose shell exits, a double fork, a run-shell of a nested tmux server). It is the
// peer of every connection that it opens, so its place in the process tree and its cgroup decide. The live test drives
// it over its own control socket, one JSON line per command: {"connect": "<scope>"} opens a raw WebSocket to the
// endpoint and answers {open} or the HTTP refusal {status, body}; {"state": true} answers its pid, parent, cgroup and
// the close of each open connection; {"exit": true} ends it. It writes <control socket>.pid when it listens.
//   node connector.mjs <control socket> <ws module> <relay socket>
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";

const [ctl, wsModule, relaySocket] = process.argv.slice(2);
const WebSocket = createRequire(import.meta.url)(wsModule);
const conns = [];
const field = (n) => { const raw = readFileSync("/proc/self/stat", "latin1"); return raw.slice(raw.lastIndexOf(")") + 2).split(" ")[n - 3]; };

function connect(scope) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws+unix://${relaySocket}:/devtools/browser/${scope}`);
    ws.once("open", () => {
      const c = { scope, close: null, ws };
      conns.push(c);
      ws.on("close", (code, reason) => { c.close = [code, String(reason)]; });
      resolve({ open: true, n: conns.length - 1 });
    });
    ws.once("unexpected-response", (_req, res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d)).on("end", () => resolve({ status: res.statusCode, body }));
    });
    ws.on("error", (e) => resolve({ error: e.message }));
  });
}

async function handle(m) {
  if (m.connect) return connect(m.connect);
  if (m.state) {
    let cgroup = null;
    try { cgroup = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((l) => l.startsWith("0::"))?.slice(3) ?? null; } catch {}
    return { pid: process.pid, ppid: Number(field(4)), cgroup, conns: conns.map((c) => ({ scope: c.scope, close: c.close })) };
  }
  if (m.exit) { setTimeout(() => process.exit(0), 20); return { ok: true }; }
  return { error: "unknown command" };
}

createServer((s) => {
  let buf = "";
  s.setEncoding("utf8");
  s.on("data", async (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0;) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      s.write(`${JSON.stringify(await handle(JSON.parse(line)))}\n`);
    }
  });
  s.on("error", () => {});
}).listen(ctl, () => writeFileSync(`${ctl}.pid`, String(process.pid)));
