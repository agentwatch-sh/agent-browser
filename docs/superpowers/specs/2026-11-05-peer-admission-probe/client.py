"""A probe client (board ab-v16.47): one upgrade request to the probe endpoint.

    python3 client.py <socket path> <label> [--hold SECONDS] [--wait SECONDS] [--double-fork]

It connects, sends GET /devtools/browser/<label> as a WebSocket upgrade, and prints the answer's body
(the server's walk result). --wait sleeps before the connect (so that a parent can exit first);
--hold sleeps after the answer (so that a child stays alive); --double-fork connects from a
grandchild whose parent has exited (a daemon's double fork).
"""
from __future__ import annotations

import os
import socket
import sys
import time


def request(path: str, label: str) -> str:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(path)
    s.sendall(f"GET /devtools/browser/{label} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
              "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n".encode())
    data = b""
    while True:
        chunk = s.recv(4096)
        if not chunk:
            break
        data += chunk
    s.close()
    return data.split(b"\r\n\r\n", 1)[-1].decode()


def main() -> None:
    path, label = sys.argv[1], sys.argv[2]
    args = sys.argv[3:]
    hold = float(args[args.index("--hold") + 1]) if "--hold" in args else 0.0
    wait = float(args[args.index("--wait") + 1]) if "--wait" in args else 0.0
    if "--double-fork" in args:
        if os.fork() > 0:
            os.wait()
            print(f"{label}: double fork started", flush=True)
            return
        os.setsid()
        if os.fork() > 0:
            os._exit(0)
        time.sleep(0.3)  # the middle process has exited: this one is re-parented
        wait = max(wait, 0.0)
    if wait:
        time.sleep(wait)
    print(f"{label}: pid {os.getpid()} ppid {os.getppid()}: {request(path, label)}", flush=True)
    if hold:
        time.sleep(hold)


if __name__ == "__main__":
    main()
