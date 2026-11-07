#!/usr/bin/env python3
"""The live harnesses' guard (board ab-v16.78): one harness at a time for each user, and no Xvfb, Chromium or other
process of a harness after its driver ends, also after a kill -9 of the driver. The same file is
test/live/harness_guard.py in agent-browser and in chrome-extension. Linux only. Python 3 standard library only.

A harness (the driver) starts the guard before it starts Xvfb or Chromium, and starts nothing until the guard says
"locked" (or "nested"):

  python3 -I harness_guard.py --name NAME --driver PID [--wait SECONDS] [--channel-fd N]   (the pipe form)
  python3 -I harness_guard.py --name NAME --driver PID --pid-dir DIR     (a shell driver: the pid-file form)
  python3 -I harness_guard.py --name NAME --driver 0 --pid-dir DIR --limit SECONDS   (no driver: run.sh up)

The guard first leaves the driver's process tree (a fork whose parent exits at once, then setsid): a signal to the
driver's process group or session, or a kill of the driver's tree, does not reach it. It ignores SIGINT and SIGHUP.

The lock: flock(LOCK_EX) on one file for each user, <home>/.cache/agent-harness/harness.lock (<home> from the
password database, not from HOME; HARNESS_LOCK names another file, for the tests). The guard waits for it at most
--wait seconds (default: HARNESS_LOCK_WAIT, else 1200), and writes one line on stderr when it has to wait, with the
holder's line from the file. Then it writes "locked <guard pid> <lock file>" on stdout and closes stdout. If the time
runs out, it writes "refused <reason>" on stdout and exits 75: the driver must start nothing. The lock is the guard's
own open file: it goes only when the guard ends, and the guard ends only after the driver's processes are gone.

A harness that a harness started (for example the second part of anti-detect/mac.ts) does not wait for the lock that
its parent holds: the client sets HARNESS_GUARD_HELD=<guard pid> after "locked", and a guard whose environment names
the lock's holder, while the holder's driver is an ancestor of its own driver, does not take the lock ("nested").

The agents' outer lock (/home/selden/.cache/ab-lead/heavy.lock, taken by hand around a whole job) is always the outer
one: no harness and no guard takes it, so a process that holds the harness lock never waits for heavy.lock, and the
two locks cannot deadlock.

While the driver runs, the guard records each process of the driver's tree every 0.5 s (its pid and its start time
from /proc), and each pid that the driver names: "track PID NAME" lines on a pipe from the driver (the pipe form: fd 0,
or --channel-fd N; Node's client uses fd 3, because Node closes a child's stdin when that child exits, and the guard's
first process exits at once), or one pid in each file of --pid-dir (the pid-file form). The driver's end: that pipe
closes (the kernel closes it also at a kill -9 of the driver), the driver's pid is gone or has a new start time, a
SIGTERM to the guard, or the --limit. Then the guard sends SIGTERM to each recorded process that still runs with its
recorded start time (a reused pid is never signalled), and to their children; after 5 s it sends SIGKILL to those
still there; it waits until they are gone (at most 20 s in all), names them on stderr, and only then ends, which frees
the lock. It signals no process other than those records and their children.

The clients: test/live/guard.ts (agent-browser's Node harnesses), start_guard() below (a Python driver), and the
pid-file form (chrome-extension's run.sh).
"""

import argparse
import fcntl
import os
import pwd
import select
import signal
import subprocess
import sys
import time

POLL_S = 0.5
TERM_S = 5.0
GONE_S = 20.0
DEFAULT_WAIT_S = 1200
REFUSED = 75


def lock_path():
    """The harness lock file: HARNESS_LOCK, else <home of this uid>/.cache/agent-harness/harness.lock."""
    if os.environ.get("HARNESS_LOCK"):
        return os.path.abspath(os.environ["HARNESS_LOCK"])
    return os.path.join(pwd.getpwuid(os.getuid()).pw_dir, ".cache", "agent-harness", "harness.lock")


def say(name, text):
    try:
        sys.stderr.write("harness-guard: %s: %s\n" % (name, text))
        sys.stderr.flush()
    except (OSError, ValueError):
        pass


def stat_of(pid):
    """(ppid, start time, state, comm) of a process from /proc, or None."""
    try:
        with open("/proc/%d/stat" % pid, "rb") as f:
            s = f.read().decode("utf-8", "replace")
    except OSError:
        return None
    r = s.rfind(")")
    rest = s[r + 2:].split()
    return int(rest[1]), int(rest[19]), rest[0], s[s.find("(") + 1:r]


def table():
    """{pid: (ppid, start time, state, comm)} of every process."""
    t = {}
    for n in os.listdir("/proc"):
        if n.isdigit():
            st = stat_of(int(n))
            if st:
                t[int(n)] = st
    return t


def same(pid, start):
    """True while the process `pid` runs with the start time `start` (a zombie has ended)."""
    st = stat_of(pid)
    return st is not None and st[1] == start and st[2] not in ("Z", "X")


def tree(t, roots):
    """The pids of the processes below `roots` in the table `t` (not the roots)."""
    kids = {}
    for pid, st in t.items():
        kids.setdefault(st[0], []).append(pid)
    out, todo = set(), list(roots)
    while todo:
        for c in kids.get(todo.pop(), []):
            if c not in out:
                out.add(c)
                todo.append(c)
    return sorted(out)


def ancestors(t, pid):
    """The parent, its parent and so on, of `pid` in the table `t`."""
    out = []
    while pid in t and pid > 1:
        pid = t[pid][0]
        if pid in out:
            break
        out.append(pid)
    return out


def holder_line(fd):
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        return os.read(fd, 400).decode("utf-8", "replace").strip()
    except OSError:
        return ""


def held_by_parent(fd, driver):
    """True when HARNESS_GUARD_HELD names the lock's holder and the holder's driver is an ancestor of `driver`."""
    held = os.environ.get("HARNESS_GUARD_HELD", "")
    fields = dict(p.split("=", 1) for p in holder_line(fd).split() if "=" in p)
    if not held.isdigit() or fields.get("guard") != held or not fields.get("driver", "").isdigit():
        return False
    try:
        with open("/proc/%s/cmdline" % held, "rb") as f:
            if b"harness_guard.py" not in f.read():
                return False
    except OSError:
        return False
    return int(fields["driver"]) in ancestors(table(), driver)


class Guard:
    def __init__(self, a):
        self.a = a
        self.name = a.name
        self.rec = {}  # pid -> (start time, name)
        self.reason = None
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, self.on_term)
        self.buf = b""
        self.stdin_open = a.pid_dir is None

    def on_term(self, *_):
        self.reason = self.reason or "the guard got SIGTERM"

    def record(self, pid, name=None):
        st = stat_of(pid)
        if pid == os.getpid() or st is None or st[2] in ("Z", "X"):
            return
        if pid not in self.rec or self.rec[pid][0] != st[1]:
            self.rec[pid] = (st[1], name or st[3])

    def driver_gone(self):
        return self.a.driver and not same(self.a.driver, self.driver_start)

    def lock(self):
        path = lock_path()
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
        if self.a.driver and held_by_parent(fd, self.a.driver):
            os.close(fd)
            return "nested %d" % os.getpid()
        t0, said = time.monotonic(), False
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                pass
            if self.driver_gone():
                sys.exit(0)
            waited = time.monotonic() - t0
            if waited >= self.a.wait:
                msg = "the harness lock %s is still held after %d s (%s); the harness starts nothing" % (path, self.a.wait, holder_line(fd) or "no holder line")
                say(self.name, msg)
                print("refused " + msg, flush=True)
                sys.exit(REFUSED)
            if not said:
                say(self.name, "waits for the harness lock %s (%s); it waits at most %d s (HARNESS_LOCK_WAIT)" % (path, holder_line(fd) or "no holder line", self.a.wait))
                said = True
            time.sleep(0.25)
        if said:
            say(self.name, "has the harness lock after %d s" % (time.monotonic() - t0))
        os.ftruncate(fd, 0)
        os.pwrite(fd, ("guard=%d driver=%d name=%s since=%s\n" % (os.getpid(), self.a.driver, self.name, time.strftime("%Y-%m-%dT%H:%M:%S%z"))).encode(), 0)
        self.fd = fd  # held until the process ends
        return "locked %d %s" % (os.getpid(), path)

    def read_input(self, timeout):
        """The pipe form: "track PID NAME" lines on the channel fd; EOF is the driver's end."""
        if not self.stdin_open:
            time.sleep(timeout)
            return
        try:
            r, _, _ = select.select([self.a.channel_fd], [], [], timeout)
        except InterruptedError:
            return
        if not r:
            return
        try:
            chunk = os.read(self.a.channel_fd, 4096)
        except OSError:
            chunk = b""
        if not chunk:
            self.stdin_open = False
            self.reason = self.reason or "the driver %d ended (its pipe closed)" % self.a.driver
            return
        self.buf += chunk
        while b"\n" in self.buf:
            line, self.buf = self.buf.split(b"\n", 1)
            parts = line.decode("utf-8", "replace").split()
            if len(parts) >= 2 and parts[0] == "track" and parts[1].isdigit():
                self.record(int(parts[1]), parts[2] if len(parts) > 2 else None)

    def read_pid_dir(self):
        try:
            names = os.listdir(self.a.pid_dir)
        except OSError:
            return
        for n in names:
            try:
                with open(os.path.join(self.a.pid_dir, n)) as f:
                    v = f.read().strip()
            except OSError:
                continue
            if v.isdigit() and int(v) not in self.rec:
                self.record(int(v), n)

    def watch(self):
        t0 = time.monotonic()
        while self.reason is None:
            self.read_input(POLL_S)
            if self.a.pid_dir:
                self.read_pid_dir()
            if self.a.driver:
                for pid in tree(table(), [self.a.driver]):
                    self.record(pid)
                if self.driver_gone():
                    self.reason = self.reason or "the driver %d is gone" % self.a.driver
            if self.a.limit and time.monotonic() - t0 >= self.a.limit:
                self.reason = self.reason or "the run reached its limit of %d s" % self.a.limit

    def alive(self):
        return {p: v for p, v in self.rec.items() if same(p, v[0])}

    def add_children(self):
        """The children that the recorded processes started since the last record."""
        t = table()
        for pid in tree(t, list(self.alive())):
            self.record(pid)

    def stop(self):
        self.add_children()
        left = self.alive()
        if not left:
            return
        names = ", ".join("%s %d" % (v[1], p) for p, v in sorted(left.items()))
        say(self.name, "%s; it stops %d processes of the harness: %s" % (self.reason, len(left), names))
        t0, sent, killed = time.monotonic(), {}, False
        while self.alive() and time.monotonic() - t0 < GONE_S:
            self.add_children()
            want = signal.SIGKILL if time.monotonic() - t0 >= TERM_S else signal.SIGTERM
            for pid, (start, _) in self.alive().items():
                if sent.get(pid) not in (want, signal.SIGKILL) and same(pid, start):
                    try:
                        os.kill(pid, want)
                        sent[pid] = want
                        killed = killed or want == signal.SIGKILL
                    except OSError:
                        pass
            time.sleep(0.1)
        left = self.alive()
        if left:
            say(self.name, "%d processes still run after %d s: %s; the lock is free now" % (len(left), GONE_S, ", ".join("%s %d" % (v[1], p) for p, v in sorted(left.items()))))
        else:
            say(self.name, "every process of the harness is gone after %.1f s%s; the lock is free" % (time.monotonic() - t0, " (SIGKILL after %d s)" % TERM_S if killed else ""))


def main(argv):
    if not sys.platform.startswith("linux"):
        print("refused the harness guard runs on Linux only", flush=True)
        return 2
    p = argparse.ArgumentParser(description="the live harnesses' guard: the harness lock and no process after the driver")
    p.add_argument("--name", required=True)
    p.add_argument("--driver", type=int, required=True, help="the driver's pid; 0: no driver (with --pid-dir and --limit)")
    p.add_argument("--wait", type=int, default=int(os.environ.get("HARNESS_LOCK_WAIT") or DEFAULT_WAIT_S))
    p.add_argument("--pid-dir", help="the pid-file form: one pid in each file; stdin is not read")
    p.add_argument("--channel-fd", type=int, default=0, help="the pipe form's fd (default 0, stdin)")
    p.add_argument("--limit", type=int, default=0, help="the run's limit in seconds (0: none)")
    a = p.parse_args(argv)
    a.name = "".join(c if c.isalnum() or c in "-_.:/" else "-" for c in a.name)[:60] or "harness"
    if a.driver == 0 and not (a.pid_dir and a.limit):
        print("refused --driver 0 needs --pid-dir and --limit", flush=True)
        return 2
    st = stat_of(a.driver) if a.driver else (0, 0, "R", "")
    if st is None:
        print("refused the driver %d does not run" % a.driver, flush=True)
        return 2
    # Leave the driver's tree: the parent ends at once, and the child gets a session of its own.
    if os.fork():
        os._exit(0)
    os.setsid()
    g = Guard(a)
    g.driver_start = st[1]
    print(g.lock(), flush=True)
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 1)
    if a.pid_dir:
        os.dup2(devnull, 0)
    g.watch()
    g.stop()
    return 0


class Client:
    """A Python driver's guard: start_guard() below."""

    def __init__(self, proc, line):
        self.proc = proc
        self.mode, self.pid = line.split()[0], int(line.split()[1])

    def track(self, pid, name="process"):
        try:
            self.proc.stdin.write(("track %d %s\n" % (pid, "".join(c for c in name if c.isalnum() or c in "-_.") or "process")).encode())
            self.proc.stdin.flush()
        except (OSError, ValueError):
            pass


def start_guard(name, wait=None):
    """For a Python driver (chrome-extension's workers.py): call it before the first Xvfb or Chromium, and pass each
    pid that the driver starts to track(). It returns when the guard holds the lock (or is nested); on a refusal it
    writes the reason and exits 2: nothing started. Keep the returned client while the driver runs: its stdin pipe
    is the driver's end for the guard."""
    args = [sys.executable, "-I", "-B", os.path.abspath(__file__), "--name", name, "--driver", str(os.getpid())]
    if wait is not None:
        args += ["--wait", str(int(wait))]
    proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    line = proc.stdout.readline().decode("utf-8", "replace").strip()
    proc.stdout.close()
    proc.wait()
    if not (line.startswith("locked ") or line.startswith("nested ")):
        sys.stderr.write("%s: %s\n" % (name, line or "the harness guard did not start"))
        sys.exit(2)
    os.environ["HARNESS_GUARD_HELD"] = line.split()[1]
    return Client(proc, line)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
