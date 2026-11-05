"""The cost of the walk and of the cgroup read in Python (board ab-v16.47 probe): 2000 walks from this
process to init (its real ancestry: this shell, claude, the pane, tmux, systemd --user)."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from walk import walk
N = 2000
t = time.perf_counter()
for _ in range(N):
    w = walk(os.getpid(), {})
walk_us = (time.perf_counter() - t) / N * 1e6
t = time.perf_counter()
for _ in range(N):
    open(f"/proc/{os.getpid()}/cgroup").read()
cg_us = (time.perf_counter() - t) / N * 1e6
print(json.dumps({"python": sys.version.split()[0], "hops": len(w.chain), "walk_us": round(walk_us, 1), "per_hop_us": round(walk_us / len(w.chain), 1), "cgroup_read_us": round(cg_us, 1)}))
