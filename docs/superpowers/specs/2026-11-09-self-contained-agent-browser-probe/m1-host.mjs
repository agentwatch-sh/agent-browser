// Probe only (board ab-v16.93, M1): the small native host shim. Chrome starts it for the probe extension (the
// manifest in <profile>/NativeMessagingHosts/). It connects to the long-running service's Unix socket and relays:
// Chrome's stdio (a 4-byte little-endian length, then JSON) <-> the socket (one JSON object per line). It holds no
// logic and no state. It exits when Chrome closes its stdin or when the service closes the socket (the extension
// then connects again, and Chrome starts a new shim). It logs nothing.
import { connect } from "node:net";

const sock = process.argv[process.argv.indexOf("--socket") + 1];
const s = connect(sock);
let inBuf = Buffer.alloc(0), lineBuf = "";
process.stdin.on("data", (d) => {
  inBuf = Buffer.concat([inBuf, d]);
  while (inBuf.length >= 4) {
    const n = inBuf.readUInt32LE(0);
    if (inBuf.length < 4 + n) break;
    s.write(inBuf.subarray(4, 4 + n).toString("utf8") + "\n");
    inBuf = inBuf.subarray(4 + n);
  }
});
s.setEncoding("utf8").on("data", (d) => {
  lineBuf += d;
  for (let i; (i = lineBuf.indexOf("\n")) >= 0;) {
    const body = Buffer.from(lineBuf.slice(0, i), "utf8");
    lineBuf = lineBuf.slice(i + 1);
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    process.stdout.write(Buffer.concat([head, body]));
  }
});
process.stdin.on("end", () => process.exit(0));
s.on("close", () => process.exit(0));
s.on("error", () => process.exit(1));
