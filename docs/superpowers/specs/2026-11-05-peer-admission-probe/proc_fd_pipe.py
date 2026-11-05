"""A process of the same user writes into another process's standard-input pipe through
/proc/<pid>/fd/0 (board ab-v16.47 probe), as a program of session B could write a JSON-RPC line into
the Playwright MCP of session A, which the peer check admits. Yama's ptrace_scope 1 does not stop it:
/proc/<pid>/fd needs only PTRACE_MODE_READ.

    python3 proc_fd_pipe.py
"""
import os, subprocess, sys, time, json
# X: a reader whose stdin is a pipe from this process (as an MCP server's stdin from claude).
x = subprocess.Popen([sys.executable, "-c", "import sys; print('X got: ' + sys.stdin.readline().strip(), flush=True)"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
time.sleep(0.2)
# Y: an unrelated process (started by setsid -f, so not a child of this one) opens /proc/<X>/fd/0 and writes.
subprocess.run(["setsid", "-f", sys.executable, "-c", f"open('/proc/{x.pid}/fd/0','w').write('a line from another process\\n')"])
out = x.stdout.readline().strip()
x.stdin.close(); x.wait()
print(json.dumps({"reader": x.pid, "result": out, "ptrace_scope": open('/proc/sys/kernel/yama/ptrace_scope').read().strip()}))
