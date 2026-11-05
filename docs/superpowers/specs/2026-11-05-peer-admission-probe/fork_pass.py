"""Whose pid does SO_PEERCRED give? (board ab-v16.47 probe)

    python3 fork_pass.py <scratch folder>

Five cases, each with its own listening socket in the scratch folder:
  1. fork-then-exit: P connects, forks C, and exits; C sends the request. The server accepts after
     P has gone.
  2. pass-fd: X connects and passes the connected socket to Y with SCM_RIGHTS; Y sends the request and
     X stays alive. (Y stands for a process of another session.)
  3. connect-then-exec: Z connects and execs another program (same pid, new comm).
  4. fork-then-parent-lives: P connects and forks C; P stays; C sends. (A shell's job with a shared fd.)
  5. exit-not-reaped: as 1, but the server reads before anybody reaps P (P is a zombie).
For each: SO_PEERCRED, SO_PEERPIDFD and the pidfd's pid (/proc/self/fdinfo), and whether the pid is
still alive.
"""
from __future__ import annotations

import array
import json
import os
import socket
import struct
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from peer_server import SO_PEERPIDFD, pidfd_exited, pidfd_pid  # noqa: E402
from walk import read_stat  # noqa: E402


def listen(path: str) -> socket.socket:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(path)
    s.listen(4)
    return s


def creds(conn: socket.socket) -> dict:
    pid, uid, gid = struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    out: dict = {"peercred_pid": pid, "alive": read_stat(pid) is not None,
                 "comm_now": (read_stat(pid).comm if read_stat(pid) else None)}
    try:
        fd = struct.unpack("i", conn.getsockopt(socket.SOL_SOCKET, SO_PEERPIDFD, 4))[0]
        out.update(pidfd_pid=pidfd_pid(fd), pidfd_exited=pidfd_exited(fd))
        os.close(fd)
    except OSError as e:
        out["pidfd_error"] = f"errno {e.errno} ({e.strerror})"
    return out


def case_fork_then_exit(folder: str) -> dict:
    path = os.path.join(folder, f"f1-{os.getpid()}.sock")
    srv = listen(path)
    p = os.fork()
    if p == 0:  # P
        c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        c.connect(path)
        if os.fork() == 0:  # C
            time.sleep(0.4)
            c.sendall(b"GET / HTTP/1.1\r\n\r\n")
            time.sleep(0.5)
            os._exit(0)
        os._exit(0)
    os.waitpid(p, 0)  # P has exited and is reaped: its pid is free
    time.sleep(0.1)
    conn, _ = srv.accept()
    out = {"case": "fork-then-exit", "connecter": p, **creds(conn), "sender": "the child of the connecter"}
    conn.recv(100)
    conn.close()
    return out


def case_pass_fd(folder: str) -> dict:
    path = os.path.join(folder, f"f2-{os.getpid()}.sock")
    srv = listen(path)
    a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    y = os.fork()
    if y == 0:  # Y: gets the socket, sends on it
        a.close()
        msg, anc, _, _ = b.recvmsg(10, socket.CMSG_LEN(4))
        fds = array.array("i")
        fds.frombytes(anc[0][2][:4])
        s = socket.socket(fileno=fds[0])
        s.sendall(b"GET / HTTP/1.1\r\n\r\n")
        time.sleep(0.5)
        os._exit(0)
    x = os.fork()
    if x == 0:  # X: connects, passes the socket to Y, stays alive
        b.close()
        c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        c.connect(path)
        a.sendmsg([b"fd"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [c.fileno()]))])
        c.close()
        time.sleep(1.0)
        os._exit(0)
    a.close(); b.close()
    time.sleep(0.2)
    conn, _ = srv.accept()
    out = {"case": "pass-fd", "connecter": x, "sender": y, **creds(conn)}
    conn.recv(100)
    conn.close()
    os.waitpid(x, 0); os.waitpid(y, 0)
    return out


def case_connect_then_exec(folder: str) -> dict:
    path = os.path.join(folder, f"f3-{os.getpid()}.sock")
    srv = listen(path)
    z = os.fork()
    if z == 0:
        c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        c.connect(path)
        os.set_inheritable(c.fileno(), True)
        os.execvp("sleep", ["sleep", "1"])
    time.sleep(0.3)
    conn, _ = srv.accept()
    out = {"case": "connect-then-exec", "connecter": z, **creds(conn)}
    conn.close()
    os.waitpid(z, 0)
    return out


def case_fork_parent_lives(folder: str) -> dict:
    path = os.path.join(folder, f"f4-{os.getpid()}.sock")
    srv = listen(path)
    p = os.fork()
    if p == 0:
        c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        c.connect(path)
        ch = os.fork()
        if ch == 0:
            c.sendall(b"GET / HTTP/1.1\r\n\r\n")
            time.sleep(0.5)
            os._exit(0)
        time.sleep(1.0)
        os.waitpid(ch, 0)
        os._exit(0)
    time.sleep(0.2)
    conn, _ = srv.accept()
    out = {"case": "fork-parent-lives", "connecter": p, **creds(conn)}
    conn.recv(100)
    conn.close()
    os.waitpid(p, 0)
    return out


def case_exit_not_reaped(folder: str) -> dict:
    path = os.path.join(folder, f"f5-{os.getpid()}.sock")
    srv = listen(path)
    p = os.fork()
    if p == 0:  # P connects, forks C, and exits; nobody reaps P yet (a zombie)
        c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        c.connect(path)
        if os.fork() == 0:
            time.sleep(0.4)
            c.sendall(b"GET / HTTP/1.1\r\n\r\n")
            time.sleep(0.5)
            os._exit(0)
        os._exit(0)
    time.sleep(0.2)
    conn, _ = srv.accept()
    st = read_stat(p)
    out = {"case": "exit-not-reaped", "connecter": p, **creds(conn), "state_now": st.state if st else None}
    conn.recv(100)
    conn.close()
    os.waitpid(p, 0)
    return out


if __name__ == "__main__":
    folder = sys.argv[1]
    for case in (case_fork_then_exit, case_pass_fd, case_connect_then_exec, case_fork_parent_lives,
                 case_exit_not_reaped):
        print(json.dumps(case(folder)), flush=True)
