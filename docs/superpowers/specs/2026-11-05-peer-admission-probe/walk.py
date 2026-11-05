"""The walk from a connecting pid to a session root (board ab-v16.47 probe).

A root is a pair (pid, start): the pid of the session's tmux pane process and its start time, field 22
of /proc/<pid>/stat (clock ticks after boot). The walk reads /proc/<pid>/stat of the peer and of each
parent, and stops at the first pid whose (pid, start) is a root. It refuses at pid 1 (init), at a pid
that has gone, at a root pid whose start time differs (a reused pid), and after MAX_HOPS.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

MAX_HOPS = 32


@dataclass
class Stat:
    pid: int
    comm: str
    state: str
    ppid: int
    pgrp: int
    sid: int
    start: int  # field 22: clock ticks after boot


def read_stat(pid: int) -> Optional[Stat]:
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            raw = f.read().decode("utf-8", "replace")
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return None
    # comm is in parentheses and can hold spaces and ')': split at the last ')'.
    lpar, rpar = raw.index("("), raw.rindex(")")
    comm = raw[lpar + 1:rpar]
    rest = raw[rpar + 2:].split()
    # rest[0] is field 3 (state); field n is rest[n - 3].
    return Stat(pid=pid, comm=comm, state=rest[0], ppid=int(rest[1]), pgrp=int(rest[2]), sid=int(rest[3]), start=int(rest[19]))


@dataclass
class Walk:
    scope: Optional[str]
    why: str
    chain: List[Tuple[int, str, int]] = field(default_factory=list)  # (pid, comm, start)
    hops: int = 0
    micros: float = 0.0


def walk(pid: int, roots: Dict[str, Tuple]) -> Walk:
    """roots: scope -> (pane pid, pane start[, pane cgroup])."""
    t0 = time.perf_counter()
    by_pid = {r[0]: (scope, r[1]) for scope, r in roots.items()}
    w = Walk(scope=None, why="")
    cur = pid
    for hops in range(MAX_HOPS):
        st = read_stat(cur)
        if st is None:
            w.why = f"pid {cur} has gone"
            break
        w.chain.append((cur, st.comm, st.start))
        if cur in by_pid:
            scope, start = by_pid[cur]
            if st.start == start:
                w.scope, w.why, w.hops = scope, "root", hops
                break
            w.why = f"pid {cur} is a root pid with another start time ({st.start}, not {start})"
            break
        if st.ppid <= 1:
            w.why = f"reached pid {st.ppid} (init) from pid {cur} ({st.comm})"
            break
        cur = st.ppid
    else:
        w.why = f"more than {MAX_HOPS} hops"
    w.micros = (time.perf_counter() - t0) * 1e6
    return w


if __name__ == "__main__":
    import json, sys
    roots = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    w = walk(int(sys.argv[1]), {k: tuple(v) for k, v in roots.items()})
    print(json.dumps(w.__dict__))
