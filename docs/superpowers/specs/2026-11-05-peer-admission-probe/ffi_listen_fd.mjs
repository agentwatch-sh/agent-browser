// review-54's check (board ab-v16.47): with a connection from the relay to itself, SO_PEERCRED on the
// accepted fd and on the listening fd both give the relay's own pid, so a self-connect cannot catch a
// reader of the wrong fd. Hence the self-test connects from a child process (design section 9.4).
//   node --disable-warning=ExperimentalWarning ffi_listen_fd.mjs <new socket path>
import ffi from "node:ffi";
import net from "node:net";
const { getsockopt } = ffi.dlopen("libc.so.6", { getsockopt: { return: "int32", arguments: ["int32","int32","int32","buffer","buffer"] } }).functions;
const cred = (fd) => { const b = Buffer.alloc(12), l = Buffer.alloc(4); l.writeUInt32LE(12); return getsockopt(fd, 1, 17, b, l) === 0 ? b.readInt32LE(0) : null; };
const path = process.argv[2];
const srv = net.createServer((s) => { console.log(JSON.stringify({ self: process.pid, accepted_fd_pid: cred(s._handle.fd), listener_fd_pid: cred(srv._handle.fd) })); s.destroy(); srv.close(); });
srv.listen(path, () => net.connect(path).on("error", () => {}));
