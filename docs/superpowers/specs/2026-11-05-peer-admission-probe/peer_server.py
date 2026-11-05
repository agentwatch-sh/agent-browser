"""A probe endpoint (board ab-v16.47): it logs who connects, and refuses every upgrade.

    python3 peer_server.py <socket path> <roots.json> <log.jsonl>

For each connection, at once after accept (as a relay would), it reads SO_PEERCRED (pid, uid, gid)
and SO_PEERPIDFD (Linux 6.5 and later) and walks from the peer pid to a root of roots.json (scope ->
[pane pid, pane start, optional pane cgroup], read again for each connection), and compares the
peer's cgroup (/proc/<pid>/cgroup) with each root's cgroup. Then it reads the request head (its path
labels the shape) and writes one JSON line to the log. It answers each request with 503 and the result as the body, so a CDP client fails at once. The
socket is 0600, as the relay's.
"""
from __future__ import annotations

import json
import os
import select
import socket
import struct
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from walk import read_stat, walk  # noqa: E402

SO_PEERPIDFD = 77


def pidfd_pid(fd: int) -> int | None:
    """The pid that a pidfd names now: /proc/self/fdinfo's Pid line (-1 after the exit)."""
    try:
        with open(f"/proc/self/fdinfo/{fd}") as f:
            for line in f:
                if line.startswith("Pid:"):
                    return int(line.split()[1])
    except OSError:
        return None
    return None


def pidfd_exited(fd: int) -> bool:
    p = select.poll()
    p.register(fd, select.POLLIN)
    return bool(p.poll(0))


def main() -> None:
    path, roots_path, log_path = sys.argv[1:4]
    if os.path.exists(path):
        sys.exit(f"peer_server: {path} exists; pass a new path")
    old = os.umask(0o077)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(path)
    os.umask(old)
    os.chmod(path, 0o600)
    srv.listen(64)
    log = open(log_path, "a", buffering=1)
    print(f"peer_server: ready on {path} (pid {os.getpid()})", flush=True)
    while True:
        conn, _ = srv.accept()
        t_accept = time.perf_counter()
        rec: dict = {"t": time.time()}
        t0 = time.perf_counter()
        pid, uid, gid = struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        rec["peercred_us"] = round((time.perf_counter() - t0) * 1e6, 1)
        rec.update(peer_pid=pid, peer_uid=uid, peer_gid=gid)
        pidfd = None
        t0 = time.perf_counter()
        try:
            pidfd = struct.unpack("i", conn.getsockopt(socket.SOL_SOCKET, SO_PEERPIDFD, 4))[0]
            rec["peerpidfd_us"] = round((time.perf_counter() - t0) * 1e6, 1)
            rec["pidfd_pid_at_accept"] = pidfd_pid(pidfd)
        except OSError as e:
            rec["peerpidfd_error"] = f"{e.errno} {e.strerror}"
        try:
            with open(roots_path) as f:
                roots = {k: tuple(v) for k, v in json.load(f).items()}
        except (OSError, ValueError):
            roots = {}
        st = read_stat(pid)
        rec["peer_comm_now"] = st.comm if st else None
        w = walk(pid, roots)
        try:
            with open(f"/proc/{pid}/cgroup") as f:
                cg = f.read().strip().split("::", 1)[-1]
        except OSError:
            cg = None
        rec["cgroup"] = cg
        rec["cgroup_scope"] = next((s for s, r in roots.items() if len(r) > 2 and cg and (cg == r[2] or cg.startswith(r[2] + "/"))), None)
        rec.update(scope=w.scope, why=w.why, hops=w.hops, walk_us=round(w.micros, 1),
                   chain=[f"{p}:{c}" for p, c, _ in w.chain])
        if pidfd is not None:
            rec["pidfd_exited_after_walk"] = pidfd_exited(pidfd)
            rec["pidfd_pid_after_walk"] = pidfd_pid(pidfd)
            os.close(pidfd)
        rec["check_us"] = round((time.perf_counter() - t_accept) * 1e6, 1)
        conn.settimeout(3)
        head = b""
        try:
            while b"\r\n\r\n" not in head and len(head) < 65536:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                head += chunk
        except socket.timeout:
            rec["head_timeout"] = True
        line = head.split(b"\r\n", 1)[0].decode("latin-1")
        rec["request"] = line[:120]
        body = json.dumps({"scope": w.scope, "why": w.why}).encode()
        try:
            conn.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nContent-Length: "
                         + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body)
        except OSError:
            pass
        conn.close()
        log.write(json.dumps(rec) + "\n")


if __name__ == "__main__":
    main()
