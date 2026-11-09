#!/usr/bin/env python3
"""The live harnesses' guard (board ab-v16.78): one harness at a time for each user, and no Xvfb, Chromium or other
process of a harness after its driver ends, also after a kill -9 of the driver. The same file is
test/live/harness_guard.py in agent-browser and in chrome-extension. Linux only. Python 3 standard library only.

A harness (the driver) starts the guard before it starts Xvfb or Chromium, and starts nothing until the guard says
"locked" (or "nested"):

  python3 -I harness_guard.py --name NAME --driver PID [--wait SECONDS] [--channel-fd N]   (the pipe form)
  python3 -I harness_guard.py --name NAME --driver PID --pid-dir DIR --log FILE   (a shell driver: the pid-file form)
  python3 -I harness_guard.py --name NAME --driver 0 --pid-dir DIR --log FILE --limit SECONDS   (no driver: run.sh up)

The guard first leaves the driver's process tree (a fork whose parent exits at once, then setsid): a signal to the
driver's process group or session, or a kill of the driver's tree, does not reach it. It ignores SIGINT and SIGHUP. It
closes every inherited fd from 3 up but its pipe from the driver (an inherited heavy.lock fd, a caller's pipe), and in
the pid-file form its stderr after the lock goes to --log, so that a run of `run.sh up` alone holds nothing of its
caller. A caller that closed fd 0, 1 or 2 (`run.sh up <&-`) gets /dev/null there first, so the lock's fd is 3 or
higher and no later dup2 onto 0 or 2 closes it.

The lock: flock(LOCK_EX) on one file for each user, <home>/.cache/agent-harness/harness.lock (<home> from the
password database, not from HOME). HARNESS_LOCK names another file, for the tests only: the guard then says on stderr
that this harness waits only for harnesses with the same HARNESS_LOCK. The guard waits for the lock at most --wait
seconds (default: HARNESS_LOCK_WAIT, else 1200), and writes one line on stderr when it has to wait, with the holder's
line from the file. Then it writes "locked <guard pid> <lock file>" on stdout and closes stdout. If the time runs out,
it writes "refused <reason>" on stdout and exits 75: the driver must start nothing. The lock is the guard's own open
file: it goes only when the guard ends, and the guard ends only after the driver's processes are gone.

A harness that a harness started (for example the second part of anti-detect/mac.ts) does not wait for the lock that
its parent holds: the client sets HARNESS_GUARD_HELD=<guard pid> after "locked", and a guard whose environment names
the lock's holder, while the holder's driver is an ancestor of its own driver, does not take the lock ("nested").

The agents' outer lock (the box's shared heavy-job lock, if it has one, taken by hand around a whole job) is always the outer
one: no harness and no guard takes it, so a process that holds the harness lock never waits for heavy.lock, and the
two locks cannot deadlock.

While the driver runs, the guard records each process of the driver's tree every 0.5 s (from one /proc snapshot: its
pid and its start time, and a pidfd that it opens and checks against that start time), and each pid that the driver
names, if that process is in the driver's tree or started after the guard: "track PID NAME" lines on a pipe from the
driver (the pipe form: fd 0, or --channel-fd N; Node's client uses fd 3, because Node closes a child's stdin when that
child exits, and the guard's first process exits at once), or one pid in each file of --pid-dir (the pid-file form).
The driver's end: that pipe closes (the kernel closes it also at a kill -9 of the driver) or is missing, the driver's
pid is gone or has a new start time, a SIGTERM to the guard, or the --limit. Then the guard sends SIGTERM to each
recorded process that still runs with its recorded start time, and to their children; after 5 s it sends SIGKILL to
those still there; it waits until they are gone (at most 20 s in all), names them on stderr, and only then ends,
which frees the lock. It signals through the record's pidfd, so a process that took a recorded pid later gets no
signal; only when pidfd_open fails with an error other than ESRCH (for example no fd left) does it check the start
time right before the signal. After a SIGTERM, the guard takes a new process of the driver's tree into its records
only if that process started before the SIGTERM (its start time, with TERM_EARLY_S of margin): the process that asks for
the stop can run in that tree (run.sh down in the EXIT trap of its all mode), and its own processes (down's sleep) are
not the run's (board ab-v16.89). The processes that it recorded before, the pids that the driver names, and the
children of recorded processes are still the run's.

The limit: a process that leaves the driver's tree within 0.5 s of its start (a double fork, for example a daemon's
server or a crash handler such as crashpad) and that the driver does not name escapes the records. So does a process
of the driver's tree that started less than about 0.03 s before a SIGTERM, if no poll recorded it and the driver does
not name it.

The clients: test/live/guard.ts (agent-browser's Node harnesses), start_guard() below (a Python driver), and the
pid-file form (chrome-extension's run.sh). RESERVED_DISPLAYS below: the X displays that no harness takes.
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
# After a SIGTERM, a new process of the driver's tree is the run's only if it started before the SIGTERM. on_term()
# takes the moment this much early: Python runs the handler a little after the signal, and a process that the stop's
# caller starts right after its kill (run.sh down's sleep) must not count as started before it.
TERM_EARLY_S = 0.02
TICK_NS = 10 ** 9 // os.sysconf("SC_CLK_TCK")  # the unit of a /proc start time, in ns
# The X displays that no harness takes, whatever its own setting is: 0 (a desktop), 90 (agentwatch's agent browser on
# taylor, the operator's), 147, 190, 191, 192 (other programs' displays on taylor). chrome-extension's run.sh and
# agent-browser's guard.ts keep the same list (their tests compare it with this one).
RESERVED_DISPLAYS = (0, 90, 147, 190, 191, 192)


def default_lock_path():
    """<home of this uid>/.cache/agent-harness/harness.lock (the home from the password database, not from HOME)."""
    return os.path.join(pwd.getpwuid(os.getuid()).pw_dir, ".cache", "agent-harness", "harness.lock")


def lock_path():
    """The harness lock file: HARNESS_LOCK (for the tests), else the default."""
    if os.environ.get("HARNESS_LOCK"):
        return os.path.abspath(os.environ["HARNESS_LOCK"])
    return default_lock_path()


def say(name, text):
    """One line on fd 2 (also when Python started with fd 2 closed and sys.stderr is None)."""
    try:
        os.write(2, ("harness-guard: %s: %s\n" % (name, text)).encode("utf-8", "replace"))
    except OSError:
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
    """{pid: (ppid, start time, state, comm)} of every process: one snapshot."""
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


def close_inherited(keep):
    """Close every fd from 3 up but `keep`: an inherited fd (for example heavy.lock's, or a caller's pipe) must not
    stay open as long as the guard runs."""
    for n in os.listdir("/proc/self/fd"):
        fd = int(n)
        if fd >= 3 and fd not in keep:
            try:
                os.close(fd)
            except OSError:
                pass


class Guard:
    def __init__(self, a):
        self.a = a
        self.name = a.name
        self.rec = {}  # pid -> [start time, name, pidfd or None]
        self.reason = None
        self.term_start = None  # after a SIGTERM: the start time before which a tree process is the run's
        self.my_start = stat_of(os.getpid())[1]
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, self.on_term)
        self.buf = b""
        # main() checks the pipe fd before anything opens an fd: a missing fd 3 must not become the lock's fd 3.
        self.missing = getattr(a, "channel_missing", False)
        self.stdin_open = a.pid_dir is None and not self.missing

    def on_term(self, *_):
        if self.term_start is None:
            # The clock of a /proc start time: CLOCK_BOOTTIME, in clock ticks.
            self.term_start = (time.clock_gettime_ns(time.CLOCK_BOOTTIME) - int(TERM_EARLY_S * 10 ** 9)) // TICK_NS
        self.reason = self.reason or "the guard got SIGTERM"

    def record(self, pid, st, name=None):
        """Record `pid` with the start time of the snapshot `st`, and a pidfd of it: the pidfd is opened, then the
        start time is read again, so the pidfd is of the process of the snapshot, and a signal through it cannot reach
        a process that took the pid later."""
        if pid == os.getpid() or st is None or st[2] in ("Z", "X"):
            return
        old = self.rec.get(pid)
        if old and old[0] == st[1]:
            return
        if old and old[2] is not None:
            os.close(old[2])
        try:
            fd = os.pidfd_open(pid)
        except ProcessLookupError:
            self.rec.pop(pid, None)
            return
        except OSError:
            fd = None  # any other error (for example no fd left): the start time is checked again right before each signal
        if fd is not None and not same(pid, st[1]):
            os.close(fd)
            self.rec.pop(pid, None)
            return
        self.rec[pid] = [st[1], name or st[3], fd]

    def accept(self, pid, name):
        """A pid that the driver names (a track line, a pid file): only a process of the driver's tree, or one that
        started after the guard, as the harness's own processes did; another pid is named on stderr and left alone."""
        t = table()
        st = t.get(pid)
        if st is None:
            return
        if (self.a.driver and pid in tree(t, [self.a.driver])) or st[1] >= self.my_start:
            self.record(pid, st, name)
        else:
            say(self.name, "leaves pid %d (%s) alone: it is not in the driver's tree and it started before the guard" % (pid, name))

    def prune(self):
        """Drop the records of processes that ended (and close their pidfds), so that the fds stay few."""
        for pid, v in list(self.rec.items()):
            if not same(pid, v[0]):
                if v[2] is not None:
                    os.close(v[2])
                del self.rec[pid]

    def driver_gone(self):
        return self.a.driver and not same(self.a.driver, self.driver_start)

    def lock(self):
        path = lock_path()
        if path != default_lock_path():
            say(self.name, "HARNESS_LOCK names %s, not the harness lock %s: this harness waits only for harnesses with the same HARNESS_LOCK (for the tests)" % (path, default_lock_path()))
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
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
        except (OSError, ValueError):
            # No such fd (EBADF): the driver gave no pipe, so the guard cannot see its end there.
            self.stdin_open = False
            self.reason = self.reason or "the driver's pipe (fd %d) is missing" % self.a.channel_fd
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
                self.accept(int(parts[1]), parts[2] if len(parts) > 2 else "process")

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
            if v.isdigit() and int(v) not in self.rec and int(v) not in self.seen:
                self.seen.add(int(v))
                self.accept(int(v), n)

    def watch(self):
        t0 = time.monotonic()
        self.seen = set()
        while True:
            self.read_input(POLL_S)
            if self.a.pid_dir:
                self.read_pid_dir()
            if self.a.driver:
                # The driver's start time from the same snapshot first: the pid of a driver that ended can belong to
                # another process now, whose tree is not the harness's.
                t = table()
                d = t.get(self.a.driver)
                if d is None or d[1] != self.driver_start or d[2] in ("Z", "X"):
                    self.reason = self.reason or "the driver %d is gone" % self.a.driver
                else:
                    # After a SIGTERM, only a process that started before it: the stop's own processes (run.sh
                    # down's) can be in the driver's tree. The check comes after the snapshot: a process that started
                    # after the SIGTERM is in the snapshot only if /proc was read after the SIGTERM, and on_term() runs
                    # before table() returns.
                    for pid in tree(t, [self.a.driver]):
                        if self.term_start is None or t[pid][1] < self.term_start:
                            self.record(pid, t[pid])
            if self.missing:
                self.reason = self.reason or "the driver's pipe (fd %d) is missing" % self.a.channel_fd
            if self.a.limit and time.monotonic() - t0 >= self.a.limit:
                self.reason = self.reason or "the run reached its limit of %d s" % self.a.limit
            self.prune()
            if self.reason is not None:
                return

    def alive(self):
        return {p: v for p, v in self.rec.items() if same(p, v[0])}

    def add_children(self):
        """The children that the recorded processes started since the last record (also of a recorded process that
        left the driver's tree when the driver ended)."""
        t = table()
        for pid in tree(t, list(self.alive())):
            self.record(pid, t[pid])

    def send(self, pid, v, sig):
        """A signal through the record's pidfd; with no pidfd, only while the pid has the recorded start time."""
        try:
            if v[2] is not None:
                signal.pidfd_send_signal(v[2], sig)
            elif same(pid, v[0]):
                os.kill(pid, sig)
            return True
        except OSError:
            return False

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
            for pid, v in self.alive().items():
                if sent.get(pid) not in (want, signal.SIGKILL) and self.send(pid, v, want):
                    sent[pid] = want
                    killed = killed or want == signal.SIGKILL
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
    p.add_argument("--log", help="the pid-file form: the guard's stderr after the lock (the run's log file)")
    p.add_argument("--channel-fd", type=int, default=0, help="the pipe form's fd (default 0, stdin)")
    p.add_argument("--limit", type=int, default=0, help="the run's limit in seconds (0: none)")
    a = p.parse_args(argv)
    a.name = "".join(c if c.isalnum() or c in "-_.:/" else "-" for c in a.name)[:60] or "harness"
    if a.driver == 0 and not (a.pid_dir and a.limit):
        print("refused --driver 0 needs --pid-dir and --limit", flush=True)
        return 2
    if a.pid_dir and not a.log:
        print("refused --pid-dir needs --log", flush=True)
        return 2
    st = stat_of(a.driver) if a.driver else (0, 0, "R", "")
    if st is None:
        print("refused the driver %d does not run" % a.driver, flush=True)
        return 2
    # Leave the driver's tree: the parent ends at once, and the child gets a session of its own.
    if os.fork():
        os._exit(0)
    os.setsid()
    a.channel_missing = False
    if not a.pid_dir:
        try:
            os.fstat(a.channel_fd)
        except OSError:
            a.channel_missing = True  # the guard stops the driver's processes at once (see watch())
    # A caller with fd 0, 1 or 2 closed (for example `run.sh up <&-`): /dev/null there, so that the lock's fd is 3 or
    # higher, and the later dup2 of /dev/null onto 0 or of the log onto 2 cannot close the lock.
    for std in (0, 1, 2):
        try:
            os.fstat(std)
        except OSError:
            n = os.open(os.devnull, os.O_RDWR)
            if n != std:
                os.dup2(n, std)
                os.close(n)
    close_inherited(set() if a.pid_dir or a.channel_missing else {a.channel_fd})
    g = Guard(a)
    g.driver_start = st[1]
    print(g.lock(), flush=True)
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 1)
    if a.pid_dir:
        os.dup2(devnull, 0)
        # The caller's stderr goes: `run=$(run.sh up 2>&1)` returns, and an up-alone run holds no pipe of its caller.
        log = os.open(a.log, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_CLOEXEC, 0o600)
        os.dup2(log, 2)
        os.close(log)
    os.close(devnull)
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
