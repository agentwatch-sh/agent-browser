"""The daemon side of the fd-passing probe (board ab-v16.47).

    python3 node_ipc_fd.py <mode> <scratch folder> <ws module folder> [N] [P]

It starts node_ipc_relay.mjs with Node's IPC channel: a socketpair whose other end is the child's
NODE_CHANNEL_FD, with NODE_CHANNEL_SERIALIZATION_MODE=json. Node's channel carries one JSON object
per line; a handle goes as {"cmd":"NODE_HANDLE","type":...,"msg":<message>} with the fd in
SCM_RIGHTS on the same sendmsg, and the receiver answers {"cmd":"NODE_HANDLE_ACK"} (Node's
lib/internal/child_process.js; Node's documentation calls a channel with a program that is not Node
"not supported").

Modes (see node_ipc_relay.mjs): daemon-accepts, relay-asks, plain. The root of the walk is this
process (pid and start time), so the clients that it starts belong to the scope "probe"; a client
that `setsid -f` starts is re-parented and must be refused.
"""
from __future__ import annotations

import array
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from walk import read_stat, walk  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


class Channel:
    def __init__(self, sock: socket.socket):
        self.sock = sock
        self.buf = b""
        self.fds: list[int] = []
        self.ack = threading.Semaphore(0)
        self.ready = threading.Event()
        self.on_handle = None
        self.wlock = threading.Lock()
        threading.Thread(target=self.read, daemon=True).start()

    def send(self, obj: dict, fd: int | None = None) -> None:
        data = (json.dumps(obj) + "\n").encode()
        with self.wlock:
            if fd is None:
                self.sock.sendall(data)
            else:
                self.sock.sendmsg([data], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [fd]))])

    def read(self) -> None:
        while True:
            data, anc, _flags, _ = self.sock.recvmsg(65536, socket.CMSG_SPACE(16))
            if not data:
                return
            for level, kind, payload in anc:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    a = array.array("i")
                    a.frombytes(payload[: len(payload) - len(payload) % 4])
                    self.fds.extend(a)
            self.buf += data
            while b"\n" in self.buf:
                line, self.buf = self.buf.split(b"\n", 1)
                msg = json.loads(line)
                if msg.get("cmd") == "NODE_HANDLE_ACK":
                    self.ack.release()
                elif msg.get("cmd") == "NODE_HANDLE":
                    fd = self.fds.pop(0)
                    self.send({"cmd": "NODE_HANDLE_ACK"})
                    self.on_handle(msg["msg"], fd)
                elif msg.get("ready"):
                    self.ready.set()


def check(fd_or_sock, roots) -> dict:
    s = fd_or_sock if isinstance(fd_or_sock, socket.socket) else socket.socket(fileno=fd_or_sock)
    pid = struct.unpack("3i", s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[0]
    w = walk(pid, roots)
    if not isinstance(fd_or_sock, socket.socket):
        s.close()  # our duplicate only
    return {"scope": w.scope, "pid": pid, "why": w.why}


def main() -> None:
    mode, folder, ws_folder = sys.argv[1:4]
    n = int(sys.argv[4]) if len(sys.argv) > 4 else 300
    p = int(sys.argv[5]) if len(sys.argv) > 5 else 50
    me = read_stat(os.getpid())
    roots = {"probe": (me.pid, me.start)}
    endpoint = os.path.join(folder, f"ipc-{mode}-{os.getpid()}.sock")
    parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    env = {"PATH": os.environ["PATH"], "HOME": os.environ["HOME"], "NODE_CHANNEL_FD": str(child.fileno()),
           "NODE_CHANNEL_SERIALIZATION_MODE": "json"}
    relay = subprocess.Popen(["node", os.path.join(HERE, "node_ipc_relay.mjs"), mode, endpoint, ws_folder],
                             env=env, pass_fds=[child.fileno()])
    child.close()
    ch = Channel(parent)
    counts = {"checked": 0, "refused": 0, "check_us": []}

    def on_handle(msg: dict, fd: int) -> None:  # relay-asks
        t = time.perf_counter()
        who = check(fd, roots)
        counts["check_us"].append((time.perf_counter() - t) * 1e6)
        counts["checked"] += 1
        counts["refused"] += who["scope"] is None
        ch.send({"id": msg["id"], **who})

    ch.on_handle = on_handle
    if mode == "daemon-accepts":
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(endpoint)
        srv.listen(128)

        def accept_loop() -> None:
            while True:
                conn, _ = srv.accept()
                t = time.perf_counter()
                who = check(conn, roots)
                counts["checked"] += 1
                # A refused connection goes to the relay too, with no scope: the relay reads the request
                # and answers the 403 with its text (an answer before the request gives the client EPIPE).
                counts["refused"] += who["scope"] is None
                ch.send({"cmd": "NODE_HANDLE", "type": "net.Socket", "msg": who}, conn.fileno())
                ch.ack.acquire()  # Node's own rule: the next handle only after the ACK
                conn.close()  # our duplicate: the relay holds the connection now
                counts["check_us"].append((time.perf_counter() - t) * 1e6)

        threading.Thread(target=accept_loop, daemon=True).start()
    if not ch.ready.wait(10):
        sys.exit("the relay did not start")
    client = [os.path.join(HERE, "node_ws_client.mjs"), endpoint, ws_folder]
    inside = subprocess.run(["node", *client, str(n), str(p), f"{mode}: a child of the root"],
                            capture_output=True, text=True, timeout=120)
    print(inside.stdout.strip() or inside.stderr.strip(), flush=True)
    out = os.path.join(folder, f"stranger-{mode}-{os.getpid()}.json")
    subprocess.run(["setsid", "-f", "sh", "-c", f"exec node {' '.join(client)} 3 0 '{mode}: re-parented by setsid -f' > {out} 2>&1"])
    for _ in range(100):
        time.sleep(0.1)
        if os.path.exists(out) and os.path.getsize(out) > 0:
            break
    time.sleep(0.3)
    print(open(out).read().strip(), flush=True)
    cu = sorted(counts["check_us"])
    print(json.dumps({"mode": mode, "daemon_checked": counts["checked"], "daemon_refused": counts["refused"],
                      "daemon_check_us_p50": round(cu[len(cu) // 2], 1) if cu else None,
                      "daemon_check_us_p99": round(cu[int(len(cu) * 0.99)], 1) if cu else None}), flush=True)
    parent.shutdown(socket.SHUT_RDWR)  # the relay's lifeline ends: it exits
    parent.close()
    relay.wait(10)


if __name__ == "__main__":
    main()
