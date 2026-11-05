// The relay side of the fd-passing probe (board ab-v16.47). The Python parent (node_ipc_fd.py) starts
// it with Node's IPC channel (NODE_CHANNEL_FD), as the daemon could start the relay.
//   node node_ipc_relay.mjs <mode> <endpoint socket> <ws module folder>
// Modes:
//   daemon-accepts: the parent accepts each connection, checks it, and sends the accepted socket here
//     as a NODE_HANDLE (type net.Socket) with {scope, pid}. The relay feeds it to its HTTP server with
//     emit('connection'); no CDP byte goes through the parent.
//   relay-asks: the relay listens itself. At each upgrade it sends the socket's handle to the parent
//     (type net.Native, so the relay's own socket stays open), and waits for {id, scope, pid}.
//   plain: the relay listens itself and checks nothing (the baseline).
// Each admitted WebSocket answers a message with "pong <scope> <pid>".
import { createServer } from "node:http";
import { createRequire } from "node:module";

const [mode, endpoint, wsFolder] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const { WebSocketServer } = require(wsFolder);
const admitted = new WeakMap(); // socket -> {scope, pid}
const http = createServer((req, res) => res.writeHead(404).end());
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
let nextId = 1;
const waiting = new Map();

function finish(req, socket, head, who) {
  if (!who?.scope) {
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", () => ws.send(`pong ${who.scope} ${who.pid}`)));
}

http.on("upgrade", (req, socket, head) => {
  if (mode === "daemon-accepts") return finish(req, socket, head, admitted.get(socket));
  if (mode === "plain") return finish(req, socket, head, { scope: "unchecked", pid: 0 });
  // relay-asks: hand the parent a duplicate of the socket, keep ours.
  const id = nextId++;
  waiting.set(id, (who) => finish(req, socket, head, who));
  process.send({ id }, socket._handle);
});

process.on("message", (msg, handle) => {
  if (mode === "daemon-accepts" && handle) {
    admitted.set(handle, msg);
    http.emit("connection", handle);
  } else if (mode === "relay-asks" && msg && waiting.has(msg.id)) {
    const done = waiting.get(msg.id);
    waiting.delete(msg.id);
    done(msg);
  }
});

if (mode !== "daemon-accepts") await new Promise((r) => http.listen(endpoint, r));
process.send({ ready: true });
// The relay's lifeline: its IPC channel (as its standard input today).
process.on("disconnect", () => process.exit(0));
