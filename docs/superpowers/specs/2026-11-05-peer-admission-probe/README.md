# The probe of the peer admission design

The evidence of [2026-11-05-peer-admission-design.md](../2026-11-05-peer-admission-design.md) (board
task ab-v16.47). Run on taylor (Debian 13, Linux 6.12.115, Node v26.12.0, Python 3.13.5, tmux 3.5a,
playwright-core 1.64.1 of the global `playwright` package) on 2026-11-05. Nothing ran on the Mac. None
of these files is part of `npm test`.

Every probe uses its own sockets in a scratch folder, its own tmux servers (`tmux -L peer-design`,
`tmux -L peer-design2`) and its own processes. It reads the process table of this session's own
processes only (`results/claude-code-tree.txt`), and it sends keys only to its own tmux panes. The
operator's Chrome, the agent browser and agentwatch's tmux server were not touched.

## The files

| File | What it does |
| --- | --- |
| `walk.py` | The walk: from a pid through the parents in `/proc/<pid>/stat` (field 4) to a root `(pid, start)`, start = field 22. It refuses at init, at a pid that has gone, at a root pid with another start time, after 32 hops. |
| `peer_server.py` | A probe endpoint on a 0600 Unix socket. At each accept: `SO_PEERCRED`, `SO_PEERPIDFD`, the walk, the peer's cgroup; then it reads the upgrade request, answers 503 with the result as the body, and logs one JSON line. |
| `client.py` | A raw upgrade client (`--wait`, `--hold`, `--double-fork`). |
| `pw_client.mjs` | `chromium.connectOverCDP("ws+unix://<socket>:/devtools/browser/<label>")`, as a script of an agent. |
| `mcp_like.mjs` | A stdio server that connects with playwright-core at each input line, as the Playwright MCP does at its first browser tool. |
| `fake_agent.mjs` | An agent-like process for a tmux pane. It starts the shapes that Claude Code starts: a Bash tool command (`/bin/bash -c`, detached: its own process group and session, as this session's own Bash commands), Claude Code's own form (`source <snapshot> && eval "<command>"`), background jobs, and MCP servers (stdio children, direct or under `sh -c`). |
| `fork_pass.py` | Whose pid `SO_PEERCRED` gives: a fork after the connect, a socket passed with `SCM_RIGHTS`, an exec after the connect, a zombie connecter. |
| `node_ffi_peercred.mjs` | The relay reads the peer in-process with Node 26's `node:ffi`: libc `getsockopt` on `socket._handle.fd`. 1000 connections. |
| `peercred.c`, `peercred_helper.py`, `node_helper_peercred.mjs` | The relay reads the peer through a helper process that inherits the accepted socket as fd 3 (`spawn` with the socket in `stdio`). |
| `node_proc_scan.mjs` | Linux only, with no `SO_PEERCRED`: the peer inode from `ss -x`, then a scan of `/proc/<pid>/fd`; and `ss -xp`. |
| `node_ipc_fd.py`, `node_ipc_relay.mjs`, `node_ws_client.mjs` | fd passing between a Python parent (the daemon's place) and a Node relay over Node's IPC channel (`NODE_CHANNEL_FD`): `daemon-accepts` (the parent accepts, checks, and sends the socket to the relay), `relay-asks` (the relay accepts and sends a duplicate to the parent for the check), `plain` (no check). A WebSocket client in the root's tree (300 one after the other, 50 at once) and one that `setsid -f` re-parents. |
| `bench_walk.py`, `bench_walk.mjs` | The cost of the walk (6 hops) and of a cgroup read. |
| `proc_fd_pipe.py` | A process of the same user writes into another process's stdin pipe through `/proc/<pid>/fd/0`. |

## How to run

```sh
S=<an empty scratch folder>
# the shapes: an endpoint, two tmux sessions, the roots, the agent in pane A
python3 peer_server.py $S/probe.sock $S/roots.json $S/shapes.jsonl &
env -i HOME=$HOME PATH=$PATH TERM=xterm-256color LANG=C.UTF-8 SHELL=/bin/bash \
  XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus \
  tmux -L peer-design2 new-session -d -s C /bin/bash        # with D-Bus: tmux gives each pane a scope
tmux -L peer-design2 new-session -d -s D /bin/bash
# roots.json: {"scopeC": [<pane pid>, <field 22>, "<pane cgroup>"], "scopeD": [...]}
tmux -L peer-design2 send-keys -t C "node fake_agent.mjs $S/probe.sock <agent-browser>/bin/agent-browser.js $S/late.txt" Enter
tmux -L peer-design2 send-keys -t D "python3 client.py $S/probe.sock scopeC-named-from-D" Enter
python3 fork_pass.py $S
node --disable-warning=ExperimentalWarning node_ffi_peercred.mjs $S 1000
cc -O2 -o $S/peercred peercred.c && node node_helper_peercred.mjs $S 300 $S/peercred
node node_helper_peercred.mjs $S 100 python3 -I -S $PWD/peercred_helper.py
node node_proc_scan.mjs $S
for m in plain daemon-accepts relay-asks; do python3 node_ipc_fd.py $m $S <agent-browser>/node_modules/ws 300 50; done
python3 bench_walk.py; node bench_walk.mjs; python3 proc_fd_pipe.py
```

## The runs of record (`results/`)

- `shapes-run1*.jsonl|txt`, `shapes-run2*`: tmux server `peer-design` started with no D-Bus
  address, so tmux could not give its panes a scope: both panes stayed in the server's cgroup. The
  walk results. Run 1 holds the other session's case (pane B names scope A).
- `shapes-run3*`: tmux server `peer-design2` with the user's D-Bus: each pane in its own
  `tmux-spawn-<uuid>.scope`. The walk and the cgroup results side by side.
- `claude-code-tree.txt`: the shapes of this real Claude Code session (read only).
- `fork_pass.jsonl`, `node_ffi_peercred.json`, `node_helper_peercred.jsonl`, `node_proc_scan.jsonl`,
  `node_ipc_fd.jsonl`, `bench_walk.jsonl`, `pid-space.txt`, `cgroup-join.txt`, `proc-fd-pipe.json`.
