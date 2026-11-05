# Admission by the connecting process, with no key — design

Date: 2026-11-05. Status: **DRAFT, fixed after review-54** (ab-lead's fresh reviewer). Author: taylor session `peer-design`, a subagent of
`ab-lead` (board task ab-v16.47, under goal ab-v16). Branch `ab-v16.47-peer-admission-design` in
agent-browser. Evidence: the probe in
[2026-11-05-peer-admission-probe/](2026-11-05-peer-admission-probe/README.md), run on taylor (Debian 13,
Linux 6.12.115, Node v26.12.0, Python 3.13.5, tmux 3.5a). Nothing ran on the Mac. No product code
changes in this task.

This design builds on the per-scope allowlist design
([2026-11-04-per-scope-allowlist-design.md](2026-11-04-per-scope-allowlist-design.md), sections 8.4,
9, 12 and 13 choice 1) and on the contract in chrome-extension `docs/protocol.md` (main `052c15c`,
which holds PR #17 of board ab-v16.41): C4 (`set_scopes`), C10 (the daemon and the relay) and C11
(the endpoint, its check order and "The scope's key"). It replaces the key of board task ab-v16.36.

The question (the operator, ab-dm6, question "Repo key", confirmed, 2026-11-05): "agentwatch knows
what repo launched the session. so it knows each claude / codex PID. can't we enforce this at the OS
level without a key? i.e. each process gets its socket, etc. if we do it via MCP then we can point the
mcp target at the right socket inside claude i think. see if we can solve it without adding a whole
new key system."

aw-lead's input (mail m6ea8936, 2026-11-05): the root is the session's tmux pane process, not the
claude or codex pid; the daemon can send `{scope: {pid, start}}`; a respawned pane changes the root;
aw-lead prefers that the relay reads the peer itself, and accepts as a second choice that the daemon
accepts and passes the socket to the relay with `SCM_RIGHTS`; the daemon must not forward CDP bytes;
the limit of section 11.

## 1. The answer in short

Yes. The relay can tell which process connects, and it can tell which agentwatch session that
process belongs to, with no key. Each decision has its reason in the section that the line names.

1. **The peer (section 3).** At each accept the relay reads the connecting process: `SO_PEERCRED`
   (its pid and uid) and `SO_PEERPIDFD` (a pidfd of that same process) on Linux, `LOCAL_PEERPID` on
   the Mac. The kernel records the process that called `connect()`. Measured: it stays that process
   after a fork, an exec and a socket passed on.
2. **Who reads it (section 3.3).** The relay itself, in its own process, with Node 26's `node:ffi`
   (libc `getsockopt` on the accepted socket's fd): 16 µs per connection, no helper, no daemon in
   the path. This is aw-lead's first preference. The relay loads `node:ffi` only with `--peer-check`,
   in its self-test, and the self-test connects from a child process (section 9.4). When `node:ffi`
   cannot run, the endpoint fails closed with a 503. Only if that happens on a box that we run, a
   later build adds W2: the relay sends a duplicate of the socket to the daemon over Node's IPC
   channel, and the daemon checks it (measured: 0.47 ms more per connection). Byte forwarding through
   the daemon is refused.
3. **The session (sections 4 and 5).** The **root** of a session is its tmux pane's process, by pid
   and start time (field 22 of `/proc/<pid>/stat`). The relay admits a connection of scope S when
   the walk from the peer through its parents reaches one of S's roots. On Linux it also admits a
   peer in the pane's own cgroup: tmux puts each pane into its own systemd scope, and every
   descendant stays in it, also a job that left the tool's shell (`nohup ... &`, `setsid -f`, a
   double fork). Measured: every shape of an agent (a Bash tool command, Claude Code's own command
   form, a `run_in_background` job, a Python script, a Playwright script, `agent-browser`, an
   `agentwatch browser`-like wrapper, an MCP server direct or under a wrapper) reaches its root; a
   process of another session that names this scope does not. The cost of the cgroup: a server that
   a session starts and that leaves the tree (a nested tmux server, `screen`, a build or test daemon)
   keeps that session's cgroup, so another session's process that runs through it (`tmux -L <server>
   run-shell`) counts as the first session (review-54 measured it). That is inside the limit of item
   7. The cgroup never overrides a walk that reaches a root of another scope.
4. **The contract (section 9).** C4's `set_scopes` does not change: the keys were never in it, and
   the receiver never sees pids. C10's `allowlist` line carries `"roots"` where the design had
   `"keys"`. The relay starts with `--peer-check` where it had `--keys`. C11's check order keeps its
   steps, with the peer read in place of the key read (step 3) and the peer check in place of the
   hash check (step 6). A program that no agentwatch session started gets a 403.
5. **Per-session sockets (section 7).** No. They route a session to its scope, but alone they stop
   no process of the same OS user: every socket is the user's own 0600 file. With the peer check
   they add only a second fact that the walk already gives. One socket stays, as today.
6. **The MCP target (section 7).** The URL holds no secret again, so the Playwright MCP that claude
   starts can get it as a plain argument, and the walk admits that MCP (measured). Whether agentwatch
   points every session's MCP at the agent browser by default stays the operator's answer age-4ks
   ("env: no"). This design does not change it.
7. **The limit (section 11).** The check stops mistakes, an agent that names another session's
   scope, and an injected instruction that only names a scope. It does not stop a hostile process of
   the same OS user: measured, such a process can join another session's cgroup with one write, run
   a command through a server that another session left running, and write into another session's
   MCP through `/proc/<pid>/fd/0`; it can also type into another session's pane with `tmux
   send-keys`. The key had the same limit (`/proc/<pid>/environ`). This is still much stronger than
   today's advisory scope.
8. **The build (section 12).** Three tasks replace ab-v16.36: the contract (chrome-extension), the
   relay's peer check (agent-browser, smaller than ab-v16.36: no secret to redact), and agentwatch's
   roots (aw-lead). A Mac measurement comes with the Mac stage.

## 2. Words

- The **peer** of a connection is the process that called `connect()` on the client side.
- A **root** is a pair `(pid, start)`: the pid of a session's tmux pane process and its start time.
  On Linux `start` is field 22 of `/proc/<pid>/stat` (clock ticks after boot; `CLK_TCK` is 100 on
  taylor). On the Mac it is `pbi_start_tvsec` and `pbi_start_tvusec` of `proc_pidinfo`'s
  `PROC_PIDTBSDINFO`, in microseconds.
- The **walk** goes from the peer's pid to its parent (field 4 of `/proc/<pid>/stat`, `pbi_ppid` on
  the Mac), and on, until it meets a root, init (pid 1), a pid that has gone, or 32 hops.
- The **pane's scope** is the systemd transient scope (`tmux-spawn-<uuid>.scope`) that tmux makes for
  each pane, on Linux. Its cgroup path is the `0::` line of `/proc/<pane pid>/cgroup`.
- **Re-parented**: a process whose parent exited. The kernel gives it the nearest ancestor that is a
  subreaper (`systemd --user`, pid 1144 on taylor), else init.

## 3. How the relay learns the connecting process (measured on taylor)

### 3.1 What the kernel gives

| Call | What it gives | Measured |
| --- | --- | --- |
| `getsockopt(SOL_SOCKET, SO_PEERCRED)` | `struct ucred`: pid, uid, gid of the process that called `connect()` | 10 to 34 µs in Python (with the `struct` unpack); 15.7 µs p50, 64 µs p99 in Node through `node:ffi` (1000 connections, the right pid each time) |
| `getsockopt(SOL_SOCKET, SO_PEERPIDFD)` (Linux 6.5 and later; taylor has 6.12) | A pidfd for the same process | 14.2 µs p50 in Node; an error (`EINVAL` on 6.12) when the connecter has exited and was reaped; a pidfd that polls "exited" when the connecter is a zombie |
| `/proc/<pid>/stat` | The parent (field 4) and the start time (field 22) | A pid read for the first time: 65.7 µs p50, 159 µs p99 in Node (one read per connection, 1000 connections); a file read again: 30 µs (the walk bench, which reads the same 6 pids 2000 times, 180 µs per walk) |
| `/proc/<pid>/cgroup` | The cgroup v2 path | 11 µs in Node, 37 µs in Python |

Whose pid `SO_PEERCRED` gives (`fork_pass.py`, `results/fork_pass.jsonl`):

| Case | `SO_PEERCRED` pid | `SO_PEERPIDFD` |
| --- | --- | --- |
| The connecter forks, exits and is reaped; its child sends the request | The connecter (gone) | `EINVAL` |
| The same, the connecter not yet reaped (a zombie) | The connecter (state `Z`) | A pidfd that polls "exited" |
| The connecter passes the socket to another process with `SCM_RIGHTS`; that process sends | The connecter, not the sender | The connecter |
| The connecter execs another program | The same pid, the new `comm` | The same process |
| The connecter forks and stays; the child sends | The connecter | The connecter |

So the check binds a connection to the process that connected, at the moment of `connect()`. A
connection that a session's process passes on stays that session's connection (section 11).

The rules for the pidfd (Linux):

- The relay does not rely on the error's code. Any error of `SO_PEERPIDFD` on a kernel that has it
  means "the peer cannot be named": the session's 403.
- A pidfd names a dead process when `poll` with `POLLIN` and a 0 ms timeout reports it readable (the
  process has exited, also a zombie), or when the `Pid:` line of `/proc/self/fdinfo/<pidfd>` is `-1`
  (it was reaped). Either is the session's 403. Node has no `poll` for a raw fd, so the relay calls
  libc `poll` with a one-entry `struct pollfd` buffer through `node:ffi`, reads the `fdinfo` file with
  `fs`, and closes the pidfd with libc `close` in every path.
- A kernel before 6.5 answers `SO_PEERPIDFD` with `ENOPROTOOPT`. There the relay reads the peer's
  `/proc/<pid>/stat` before and after the walk and refuses when the start time or the pid's presence
  changed or the state is `Z`. A reused pid in that window needs a full wrap (section 3.2). The
  self-test notes which form it uses.

### 3.2 Pid reuse and start times

A pid can come back after its process ends. taylor: `pid_max` 4194304; 847834 pids in 32823 s of
uptime (26 per second on average), and review-54 saw 210 per second over the next 21 minutes (pids
1116893 at 34103 s). At 210 per second the pid space wraps in about 5.5 hours. Three cases:

- **The root.** A pane that ended and a new process with its old pid: the start time differs (field
  22 is in ticks of 10 ms), so the walk does not take the new process as the root. The relay compares
  `(pid, start)`, never the pid alone.
- **The peer.** Between `connect()` and the walk (well below 1 ms) the peer can exit and its pid can
  come back only after a full wrap: not possible in practice. On Linux `SO_PEERPIDFD` closes it fully:
  the relay takes the pidfd at accept and checks after the walk that the pidfd has not exited, so the
  `/proc` entries that it read were that process's. A peer that has exited (the pidfd fails, polls
  "exited", or the state is `Z`) is refused.
- **An ancestor.** A parent that exits during the walk re-parents its children, and the walk then
  ends at a subreaper or init: it refuses, it never admits a wrong scope, because it admits only at a
  root whose pid and start match.

On the Mac `PID_MAX` is 99999, so a pid comes back after about 100000 new processes: at taylor's
busy rate (210 per second) that is about 8 minutes. The start time closes it for the root as on Linux.
For the peer the Mac has no pidfd, and its window starts at the peer's `connect()` (or its last send),
not at accept: `LOCAL_PEERPID` is a pid that the kernel recorded then (section 6). The relay reads
the peer's start time with `proc_pidinfo` before and after the walk, as on a Linux kernel before 6.5,
and refuses when it changed. A peer that exits and whose pid comes back between its `connect()` and
the relay's first read is not detected; that needs 100000 new processes in that time.

### 3.3 How Node can read it

Node core has no `SO_PEERCRED` and no `LOCAL_PEERPID`, and no `recvmsg` outside its child IPC
channel. Six ways, measured (`results/`):

| Way | How | Cost per connection | Risk |
| --- | --- | --- | --- |
| W1. `node:ffi` in the relay | libc `getsockopt` on `socket._handle.fd`; `/proc` reads with `fs` (Linux); `proc_pidinfo` from libproc with `node:ffi` (Mac) | 16 µs for the peer, 30 to 66 µs per hop | `node:ffi` is experimental in Node 26 (on by default; `--no-experimental-ffi` turns it off; one `ExperimentalWarning`, which `--disable-warning=ExperimentalWarning` hides). `socket._handle.fd` is an internal property (it was there for 1000 of 1000 connections). A change shows at the relay's self-test (section 9.4) and fails closed. |
| W2. The relay asks the daemon | Node's IPC channel (`NODE_CHANNEL_FD`): the relay sends a duplicate of the accepted socket (`process.send(msg, socket._handle)`, type `net.Native`, so its own socket stays open); the daemon (Python) does `SO_PEERCRED` and the walk and answers the scope | +0.47 ms (sequential p50 1.22 ms against 0.75 ms with no check; the daemon's part 0.14 ms) | Node's documentation calls an IPC channel with a program that is not Node "not supported"; the protocol (one JSON object per line, `NODE_HANDLE` with the fd in `SCM_RIGHTS`, `NODE_HANDLE_ACK`) is Node's internal `lib/internal/child_process.js`. The daemon must answer each check. |
| W3. The daemon accepts and passes the socket (aw-lead's second choice) | The daemon listens, checks, and sends the accepted socket to the relay as `NODE_HANDLE` type `net.Socket`; the relay feeds it to its HTTP server with `emit('connection', socket)`; no CDP byte goes through the daemon | +0.40 ms (sequential p50 1.15 ms) | The same unsupported protocol. The daemon owns the endpoint's listener. A refused connection must still go to the relay (with no scope), so that the relay sends the 403 text: an answer before the request reads gives the client `EPIPE` (measured in the first run). |
| W4. A helper per connection | `spawn(helper, [], {stdio: [..., socket]})`: the helper gets the socket as fd 3 and runs `getsockopt` | 2.2 ms p50 (a C helper), 28 ms p50 (a Python helper) | A compiled binary per platform in a package that has none today, or 28 ms per connection. |
| W5. `/proc` and `ss` (Linux only) | The peer inode from `ss -x` (sock_diag; `/proc/net/unix` has no peer column), then a scan of `/proc/<pid>/fd`; or `ss -xp` | 25 ms (`ss -x` 6 ms, the scan 19 to 34 ms over about 510 pids and 1300 fds) | It finds every holder of the socket, not the connecter: two holders after a fork, in 5 of 5 runs. It cannot tell them apart. Refused. |
| W6. The daemon forwards the bytes | The daemon accepts and copies CDP traffic both ways | Not measured | aw-lead refuses it: all CDP load on the daemon, and a daemon restart cuts every client. Refused. |

Each way that admits refused the re-parented client with 403 and admitted the 350 connections of
the root's own tree (300 one after the other, 50 at once) in W2 and W3. A burst of 50 at once took
about 60 ms in every mode, also with no check: the client's own connection setup, not the check.

**Decision: W1.** W1 keeps the relay alone in the CDP path, costs microseconds, and is one
mechanism on both systems. The relay loads `node:ffi` only when it starts with `--peer-check`, with a
dynamic `import("node:ffi")` in its self-test (section 9.4), never with a static import: a static
import would make every agent-browser command print the `ExperimentalWarning`, and on a Node with no
`node:ffi` every command would fail at load (review-54 measured `ERR_UNKNOWN_BUILTIN_MODULE`). An
import, `dlopen` or symbol that fails makes the self-test fail, and the endpoint fails closed.

W2 is not in this build. It is a later build only if W1 fails on a box that we run (aw-lead's plan).
Until then, on such a box, the relay answers each upgrade with the 503 `the relay cannot read the
program of a connection`, and the endpoint's state (`agentwatch browser status` and the Browser page)
says that the peer check cannot run: agents get the 503 and cannot use the agent browser there. W2
needs no `node:ffi`, but it needs a new walk in the daemon: `pane_of`
(`agentwatch/daemon/claude_names.py`) compares pids only, from one `ps` read, with no start time,
so it cannot close pid reuse; `peer_pid` (`agentwatch/proto/peercred.py`) reads the peer already. W3
works as well as W2, but it moves the listener into the daemon for no gain over W2.

## 4. The walk to the session's root (measured on taylor)

The probe started its own tmux server with two sessions (A and B, or C and D), took each pane's
process as the root of a scope, and ran in pane A an agent-like process (`fake_agent.mjs`) that
starts its children as Claude Code does: each Bash tool command is `/bin/bash -c` in its own process
group and session (read from this real session: `results/claude-code-tree.txt`), and Claude Code's own
form is `source <snapshot> && eval "<command>"`; an MCP server is a stdio child in the agent's process
group. Each shape connected to the probe endpoint. The Playwright MCP itself was not run: `mcp_like.mjs`
connects with playwright-core 1.64.1 as the MCP does, as a stdio child.

| Shape | The chain from the peer (run 2) | Walk | Pane cgroup (run 3) |
| --- | --- | --- | --- |
| A Bash tool command: a Python script | python3 > agent > pane | admitted (2 hops) | admitted |
| A Bash tool command: a Playwright script | node > agent > pane | admitted | admitted |
| `agent-browser tabs --cdp-url ws+unix://...` | node > bash > agent > pane | admitted | admitted |
| An `agentwatch browser <command>`-like wrapper (Python runs agent-browser, as `commands/browser.py` does with `Popen`) | node > sh > python3 > agent > pane | admitted | admitted |
| Claude Code's command form, a Python script | python3 > bash > agent > pane | admitted | admitted |
| A `run_in_background` job (the job's shell stays its parent; this real session showed the same shape) | python3 > bash > agent > pane | admitted | admitted |
| `nohup <job> & wait` (the shell lives) | python3 > bash > agent > pane | admitted | admitted |
| Claude Code's form with `setsid <job>` (the shell is not exec'd, so `setsid` does not fork) | python3 > bash > agent > pane | admitted | admitted |
| An MCP server, a direct stdio child | node > agent > pane | admitted | admitted |
| An MCP server under `sh -c` (as `npx`), or a Python MCP | node or python3 > sh > agent > pane | admitted | admitted |
| `<job> &` or `nohup <job> &` whose shell exits at once | python3 > systemd --user | refused | admitted |
| `setsid <job>` as the only command (bash execs `setsid`, which then leads its process group, so it forks) | python3 > systemd --user | refused | admitted |
| `setsid -f <job>`, also in Claude Code's form | python3 > systemd --user | refused | admitted |
| A double-forked daemon | python3 > systemd --user | refused | admitted |
| `tmux new-window` from the agent | python3 > bash > tmux server > systemd --user | refused | refused (another pane) |
| A process of session B that names scope A | python3 > pane B | refused (it reaches B's root) | refused (B's scope) |
| A process of session B run through a tmux server that session A started (`tmux -L <server> run-shell`; review-54) | python3 > sh > A's server (re-parented) > systemd --user | refused | admitted as A: the server keeps A's pane cgroup |
| A process of session B that joined A's cgroup (one write to `cgroup.procs`) | python3 > pane B | refused (it reaches B's root) | refused: the walk to B's root decides (section 5; the join is measured in `results/cgroup-join.txt`, this connection was not run) |

Each "refused" of the walk ended at `systemd --user` (pid 1144, a subreaper) and then at init. On a
box with no subreaper it ends at init at once. The `tmux new-window` row: tmux moves only the new
pane's own process into the new scope, after the fork; a child that the pane's command forked before
that move stays in the tmux server's cgroup for its life (the probe's client did). The run-shell row:
tmux moves only pane processes, so a `run-shell` command stays in its server's cgroup, and a server
that a session started is in that session's pane scope. `systemd-run --user` (not run) starts its command as a
child of `systemd --user` in a new unit, so both checks refuse it. A cron job of agentwatch is a
session of its own, with its own pane and root (aw-lead).

The walk costs 30 to 66 µs per hop (66 µs p50 for a pid read for the first time); agents are 2 to 4
hops below the pane, so the check takes well under 1 ms. Codex was not run: its tool commands and MCP servers are its children, so they have the same
shape under the pane (to check in the relay's live test).

## 5. The pane's cgroup (Linux)

tmux 3.5a on taylor is built with systemd. When its server can reach the user's D-Bus, it moves each
new pane into a transient scope of its own, `app.slice/tmux-spawn-<uuid>.scope`. agentwatch's tmux
server (in `app.slice/agentwatch.service`) does this today: this session's pane and its claude, Bash
commands and MCP servers are all in one such scope (`results/claude-code-tree.txt`). The probe's first
tmux server had no D-Bus address, and both of its panes stayed in the server's cgroup (runs 1 and 2);
the second had it, and each pane got its own scope (run 3).

A cgroup is inherited at fork, and a re-parent does not change it. So in run 3 every job that left
the tool's shell stayed in the pane's scope (the table above). A new pane (`tmux new-window`) gets
another scope. tmux moves only the pane's own process into it, after the fork: a child that the
pane's command forked before that move stays in the tmux server's cgroup for its life (measured: the
probe's new pane's child did). agentwatch starts the pane's shell first and types the agent's launch
line later (section 9.2), so the agent and its children are in the pane's scope.

The rules, so that a cgroup never admits the wrong session:

- The walk comes first. When it reaches a root, that root's scope decides: a walk that reaches a root
  of another scope refuses, whatever the cgroup says. The cgroup counts only for a peer whose walk
  reaches no root (it ended at init, a subreaper, or a gone pid).
- The relay reads a root's cgroup from `/proc/<root pid>/cgroup` at each line (for the rules below)
  and again at the check, and uses it only when the root's start time matches.
- It counts only when the pane has a scope of its own: the root's cgroup differs from its parent's
  (the tmux server's) cgroup, and no root of another scope has the same cgroup. Else that root counts
  for the walk only (as on a box where tmux cannot reach D-Bus).
- A root's cgroup with another root's cgroup under it does not count (a nested scope).
- The peer counts as in the root's scope when its cgroup is the root's cgroup or under it
  (`<root cgroup>/...`).

The cost (review-54, measured): a server that a session starts and that leaves the session's tree
keeps the session's pane cgroup, because a re-parent does not change a cgroup. A nested tmux server
(`tmux -L <server>`), `screen`, or a build or test daemon are such servers. A process of another
session that runs a command through such a server (`tmux -L <server> run-shell <command>`) gets the
server's cgroup, so with P2 it counts as the first session; its walk ends at `systemd --user`, so P1
refuses it. This is inside the limit of section 11: that other session can already type into the
first session's pane with `tmux send-keys`, and with the key it could read the first session's
environment. The first rule above keeps the narrower part: a process whose own walk reaches its own
session's root is never counted as another session, also when it joined another session's cgroup.

A respawned pane (`tmux respawn-pane -k`, which agentwatch can use at a restart, an account swap or a
resume) gets a new process and a new scope (review-54). The jobs of the old pane stay in the old
scope, and their walk reaches no live root, so they are refused after the respawn (section 9.2).

The limit: a process of the same user can join any of the user's scopes with one write to
`cgroup.procs` (measured, `results/cgroup-join.txt`: no privilege is needed, because the user manager
delegates its subtree to the user). So the cgroup is a fact about where a process came from, not a
barrier against a hostile process (section 11).

## 6. The Mac (from documentation; nothing ran on the Mac)

- **The peer.** `getsockopt(fd, SOL_LOCAL (0), LOCAL_PEERPID (0x002))` gives a pid (`bsd/sys/un.h`);
  agentwatch's `agentwatch/proto/peercred.py` reads it already, and `LOCAL_PEERCRED` (0x001,
  `struct xucred`) gives the uid with no pid. In the xnu source (apple-oss-distributions/xnu
  `f6217f8`, `bsd/kern/uipc_usrreq.c`, `uipc_ctloutput`) the value is the peer socket's `last_pid`,
  and `bsd/kern/uipc_socket.c` sets `last_pid` at each bind, listen, accept, connect, send and
  receive on that socket (`so_update_last_owner_locked`). So it is the last process that used the
  client's socket, not always the connecter: at accept, before the client sent its request, it is
  the connecter; when a process that got the socket passed on sends the request first, it is that
  process. Either way it is a process that holds the socket. `LOCAL_PEERTOKEN` (0x006) gives the audit
  token of the process that has `last_pid` at the moment of the call (`proc_find`), so it does not
  close the reuse window by itself. The build measures these on the Mac (task T4, section 12).
- **The parent and the start.** `proc_pidinfo(pid, PROC_PIDTBSDINFO (3), 0, &info, sizeof info)`
  gives `struct proc_bsdinfo` with `pbi_ppid`, `pbi_start_tvsec`, `pbi_start_tvusec` and `pbi_status`
  (`SZOMB` for a zombie; `bsd/sys/proc_info.h`). The Mac has
  no `/proc`: the relay calls `proc_pidinfo` from `libproc` (in libSystem) through `node:ffi`; the daemon
  can use `ctypes` or `ps -o ppid=` (its `pane_of` reads `ps -A -o pid=,ppid=` today).
- **Re-parenting.** The Mac has no subreaper: an orphan goes to `launchd` (pid 1). So a job that leaves
  the tool's shell is refused there, as with the walk on Linux.
- **No cgroups.** The Mac has the walk only. So on the Mac, `nohup <job> &` with an exiting shell,
  `setsid -f` and a double fork are refused; on Linux they are admitted (choice 1, section 13).
- **pid reuse.** `PID_MAX` 99999 (`bsd/sys/proc_internal.h`; section 3.2): the start time is
  necessary for the root.
- **The daemon.** agentwatch's daemon runs on the Mac too, and it knows each pane's pid (`tmux
  list-panes -F '#{pane_pid}'`), so it sends the same `roots` with the Mac's start time.

## 7. Per-session sockets and the MCP target

**What per-session sockets do.** A socket per session (for example
`/run/user/<uid>/agentwatch/browser/<scope>.sock`) routes a client to its scope by its path: a client
that the daemon points at its own session's socket reaches only that scope, so a misconfigured
client cannot reach another scope by mistake, unless it names another session's socket.

**What they do not do, said plainly.** Alone they do not stop another process of the same OS user.
Every socket is a 0600 file of that user (a folder mode does not help: the folder is the user's
too), and any process of the user can open any of them and get that session's scope. That is the
same advisory scope as today's one socket with a scope in the path.

**What they add with the peer check.** Only a second fact: the socket's scope must equal the scope
that the walk gives. The walk already gives it, so a per-session socket stops nothing more. It costs
one listener per session, their life cycle at each session start, end and daemon restart, and the
103-byte path limit on the Mac. **Decision: one socket, as today.** "Each process gets its socket"
(the operator) is what the peer check does without new sockets: each connection is bound to the
process that made it.

**The MCP target.** The Playwright MCP that claude starts is a stdio child of claude (or of a wrapper
such as `npx`), so it is under the pane, and the walk admits it (measured: `mcp-direct`, `mcp-wrapped`,
`mcp-python`). With the peer check the URL holds no secret, so agentwatch could give each session's
MCP its URL at launch, in its environment (`PLAYWRIGHT_MCP_CDP_ENDPOINT`) or as an argument in the MCP
configuration: a wrong or copied URL is refused for another session's process. That this happens by
default is the operator's question age-4ks ("env: no", 2026-11-04), which stands: today only
`agentwatch browser endpoint` and `agentwatch browser env` print the URL, on request, and an agent sets
it for its own MCP. With keys gone, `agentwatch browser env` prints
`PLAYWRIGHT_MCP_CDP_ENDPOINT=<url>` again, as C11 says for "without keys".

A later option, not in this build: a path with no scope (`/devtools/browser`), whose scope the relay
takes from the walk. Then one URL serves every session, and an MCP configuration can be the same for
all of them. Its cost: a just-launched session whose root is not in the line yet gets the 403 of
step 6, not the no-list 503 of step 5 that tells it to connect again.

## 8. The options

| Option | What a connection needs | Re-parented jobs | Hostile process of the same user | Build size |
| --- | --- | --- | --- | --- |
| Today: the advisory scope | Nothing | n/a | Not stopped; nor is an agent that names another scope | none |
| P1. The walk (both systems) | Its process under the scope's pane | Refused on both systems | Not stopped (section 11) | Relay: the peer read, the walk, the check order (about half of ab-v16.36). Daemon: roots in the line. Contract: the key texts replaced. |
| **P2. The walk, and on Linux the pane's scope (recommended)** | P1, or on Linux (when the walk reaches no root) its process in the pane's own scope cgroup | Admitted on Linux, refused on the Mac | Not stopped (one write joins a scope); and a server that a session leaves running (a nested tmux server, `screen`, a build daemon) lets another session's process count as that session | P1 and one cgroup read per root and one for the peer (11 µs each in Node), and the rules of section 5 |
| K. The key (ab-dm6's 1 b, ab-v16.36) | The scope's key from the session's environment | Admitted while they keep the environment | Not stopped (`/proc/<pid>/environ`) | Larger: token files, the launch lines, the variable, the redaction in agent-browser's errors and logs, `agentwatch browser env` changes, the restart rules |
| S. Per-session sockets only | The right socket | n/a | Not stopped; a misconfigured client is | One listener per session, in the relay and the daemon |

P1 and P2 need no secret: no token file, no environment variable, no redaction, nothing that a
transcript can leak. Their limit is the key's limit. P2 differs from P1 only for processes whose walk
reaches no root, on Linux: P2 admits the jobs that left the tool's shell, and also the commands that
another session runs through a server that this session left running (section 5). With P1 such a job
gets the 403 and the agent starts it again with `run_in_background` (Claude Code) or without leaving
the shell.

**Recommendation: P2, read by the relay with `node:ffi` (W1).** It solves the operator's question with
no key system, it costs well under a millisecond per connection, it keeps the daemon out of the CDP
path, and on taylor it also admits the background jobs that agents start with `nohup ... &`. Its cost,
the server path, is inside the same-user limit that every option here has.

## 9. The contract changes (chrome-extension `docs/protocol.md`, main `052c15c`)

The texts below replace the blocks of the key. Each line number is of main `052c15c`.

### 9.1 C4 (`set_scopes`)

No new field. The keys were never in `set_scopes`: C10's `allowlist` line carried them, and the
receiver never saw them. The roots take the keys' place in that line, so no pid reaches the
extension. (aw-lead's note names `set_scopes`. The line is the better place: the receiver has no use
for a pid, and the line is where the relay reads the scopes.) The intro's mention of
"choice 1, the scope's key" (line 29) and C4's "only when the operator allowed it: C11, the scope's
key" (line 289) name the peer check instead. Nothing in the receiver (parts 1a to 1d) changes.

### 9.2 C10 (the daemon and the relay)

- The relay's start (line 1034): `agent-browser relay --socket <path> --peer-check` when the peer
  check is on, in place of `--keys`.
- The `allowlist` line (line 1046): in place of `"keys":{...}`,
  `"roots":{"<scope>":[{"pid":<pane pid>,"start":<pane start>}]}`. `start` is an integer: on Linux
  field 22 of `/proc/<pid>/stat`, on the Mac `pbi_start_tvsec * 1000000 + pbi_start_tvusec`. A list,
  so that a session with more than one pane can name each. The receiver never sees it.
- The line's rules: `roots` that is not an object applies as an empty object; an entry whose scope
  does not match the scope pattern, or whose value is not a list, applies as absent; an item that is
  not an object with an integer `pid` above 1 and an integer `start` of 0 or more is dropped. A scope
  with no root that applies admits no connection (step 6).
- The defensive root rules. The relay applies them at each line, with the stat and cgroup of every
  root read then, so that a wrong line can never admit a wrong session:
  - a `(pid, start)` that two scopes name counts for neither scope;
  - a root that is an ancestor of another root (the walk from one root reaches the other) does not
    count, for the walk or the cgroup: a pane is never under another pane, so such a root is a wrong
    pid (for example the tmux server's);
  - a root's cgroup that has another root's cgroup under it, or that another scope's root shares, or
    that is its parent's cgroup, does not count (section 5); that root still counts for the walk.
  At a check the relay reads again only the scope's own roots (one stat and one cgroup read each).
- A relay started without `--peer-check` that gets a line with a `roots` field (any value) does what
  protocol.md lines 2001 to 2005 say for `keys`, in full: it applies no list of that line, as if no
  line had come; it closes the open connections (1008, `The allowlist has no list for this scope any
  more`); and it answers each upgrade with the 503 `the allowlist has session roots, but the relay was
  started without --peer-check`, until a line without `roots` comes. A relay with `--peer-check` that
  gets a line with no `roots` field applies the lists, and every scope has no root: step 6 refuses
  each connection.
- When a root changes (a respawned pane: a restart, an account swap, a resume; aw-lead), the daemon
  writes a line with the new root at once, with the last confirmed object, and does not wait for a
  `set_scopes` round trip: the receiver does not use the roots, so a root change needs no
  `set_scopes`. (A new `set_scopes` and its line, aw-lead's way, also works, but it leaves a longer
  window.) `tmux respawn-pane -k` gives the pane a new process and a new scope (review-54), so the
  old pane's jobs are refused after the respawn (section 5), also with P2.
- At a launch, the daemon reads the new pane's pid and start (after `tmux new-session`, before the
  launch line) before the scope enters its map, so the first line that names the scope carries its
  root. Else, in the moment between, a just-launched session would get the session's 403 (step 6) in
  place of the no-list 503 (step 5) that tells it to connect again. The same holds for a respawn: the
  new root is in the map before the agent starts in the new pane. So that an agent in such a window
  knows what to do, the session's 403 text ends with `If this session started or restarted just now,
  connect again in a few seconds.`
- The daemon starts the pane's shell first and types the agent's launch line into it after the pane's
  scope exists (it reads `/proc/<pane pid>/cgroup` and finds a `tmux-spawn-<uuid>.scope` that is not
  the tmux server's cgroup). tmux moves only the pane's own process into the scope, after the fork; a
  process that the pane's command forks before that move stays in the server's cgroup for its life
  (section 4, the `tmux new-window` row). agentwatch's launch does this today (`new-session -d` with
  the default shell, then the launch line), so this is a rule to keep.
- At a session's end the daemon drops the scope's roots in the line that drops the scope, as for
  `keys`. A later session of the same name has another pane, another root.

### 9.3 C11 (the endpoint)

"The socket and the URL" (lines 1442 to 1462): the URL contains no secret, with or without the peer
check. `agentwatch browser env` prints `PLAYWRIGHT_MCP_CDP_ENDPOINT=<url>` (no comment lines). With
the peer check, a connection needs its process in the session of its scope (below); without it, the
scope stays advisory.

"Before the upgrade" (lines 1470 to 1476), the answers:

- With the peer check, a peer that the relay cannot read (the read fails, or it gives no pid, or a
  uid other than the relay's): 403 `The agent browser cannot tell which program connects, so it refuses the connection.`
- With the peer check, a peer that is not in the session of its scope: 403
  `The agent browser admits a connection only from a program of the agentwatch session of its scope. This program (pid <pid>) is not in it: it is in another session, it was started outside agentwatch, or it left the session. If this session started or restarted just now, connect again in a few seconds.`
- The not-ready 503s get two texts in place of the key's one:
  `The agent browser is not ready: the allowlist has session roots, but the relay was started without --peer-check.`
  and `The agent browser is not ready: the relay cannot read the program of a connection.` (the
  self-test failed, below).

The order of the checks (lines 1488 to 1514), with the peer check in place of the key:

1. A request with an `Origin` header: its 403.
2. A path or scope that does not match: the 404.
3. With the peer check, the peer read (the relay's own read at accept: `SO_PEERCRED` and
   `SO_PEERPIDFD`, or `LOCAL_PEERPID`): a relay whose self-test failed (section 9.4) gives its 503;
   else a peer that it cannot read gets the peer's 403. Both at once, also while the relay is not
   ready.
4. The relay is not ready, in today's order; a relay without `--peer-check` whose last line has a
   `roots` field gets its 503.
5. With the peer check, a scope that the last `allowlist` line does not name: the no-list 503. A
   just-launched session connects again.
6. With the peer check, the session check: the peer must be alive (Linux: its pidfd is not readable
   and its `fdinfo` pid is not `-1`, and its state is not `Z`; a kernel before 6.5 and the Mac: its
   start time is the same before and after the walk, `proc_pidinfo` answers, and `pbi_status` is not
   `SZOMB`), and the walk from it must reach a root of the scope (pid and start, under the defensive
   root rules of section 9.2). A walk that reaches a root of another scope refuses. Only when the walk
   reaches no root, on Linux, may the peer's cgroup count: it must be in the scope of a root of the
   scope (section 5's rules). Else the session's 403. On Linux the relay checks the pidfd once more
   after the walk.
7. A scope with no list: the no-list 503.

As with the key, the relay never holds an upgrade for the daemon, and it reads the peer at accept.
Step 6 does the walk in the relay's event loop. At 66 µs p50 for each new pid and 32 hops at most, a
walk takes at most about 2.3 ms (71.5 µs p50 in review-54's run: the same order), plus one cgroup read
per root of the scope and one for the peer (11 µs each), with P2. An agent's walk is 2 to 4 hops.

"When a connection ends" (lines 1593 to 1596): with the peer check, at each `allowlist` line the relay
closes every connection of a scope whose root that admitted it (its pid and start) is no longer in
the scope's roots, with 1008, `The session of this scope has a new process: connect again.` A
connection keeps its scope while its root lives: the check runs once, at the upgrade.

"The scope's list" (lines 1925 to 1926): with the peer check, a scope that the line does not name has
no list, whatever `default` says (it has no root).

"The scope's key" (lines 1931 to 2022) goes. In its place, **"The scope's session (the peer
check)"**: the rules of sections 3 to 6 of this design for the relay (the peer read and the self-test,
the walk with `(pid, start)`, the defensive root rules, the pane's scope cgroup on Linux only when the
walk reaches no root, the alive checks), where the relay
learns that the check is on (its start flag, as for the key: it drops the line at each link change),
the roots' life (section 9.2), the limit (section 11), and what a program that no session started gets
(the session's 403 of step 6; a program started in a plain terminal, or by `systemd-run`, cron outside
agentwatch, or the operator's own shell outside an agentwatch pane, cannot connect).

### 9.4 The relay's self-test

At its start, with `--peer-check` only, the relay loads its peer reader: a dynamic
`import("node:ffi")`, then `dlopen` of libc (and of libproc on the Mac) and its symbols. Then, before
its endpoint socket listens, it listens on a temporary socket of its own (in a 0700 folder that it
makes with `mkdtemp` next to the endpoint socket, and removes after the test, so that no other
program can take part), and starts a child process (`process.execPath` with a few lines of script)
that connects to it and stays until the relay has read the connection. The relay reads the peer of the accepted
socket and compares it with the child's own facts: the pid (the child's pid), the uid (the relay's
uid), and on Linux the pid that the pidfd names (`/proc/self/fdinfo/<pidfd>`, the `Pid:` line). A
connection from the relay to itself would not do: the relay's pid is also what a reader of the wrong
fd gives (review-54 measured `SO_PEERCRED` on the listening fd: the relay's own pid). When the import,
the `dlopen`, a symbol, the read or a compare fails, the relay logs `relay: the peer check cannot run:
<reason>`, admits no connection, and answers each upgrade with the 503 `the relay cannot read the
program of a connection` (fail closed). A relay without `--peer-check` never loads `node:ffi`, so no
other agent-browser command prints the warning or depends on it.

### 9.5 The vectors

- `test/vectors/endpoint.json`: `upgradeChecks` gets the peer cases in place of the key cases. Each
  case gives the peer as data, so both sides test with a fake peer reader:
  `"peer":{"read":true,"uid":"own","alive":true,"chain":[[<pid>,<start>],...],"cgroup":"<path>"|null}`
  and the roots of the line. Cases: no read; another uid; a dead peer (a pidfd that polls readable,
  an `fdinfo` pid of `-1`, a state `Z`, a start that changed during the walk); a chain to the scope's
  root; a chain to another scope's root; a chain to init; a root pid with another start; the pane
  cgroup admits a re-parented peer; a chain to another scope's root with this scope's cgroup is
  refused (the walk decides); a cgroup shared by two scopes' roots, equal to the root's parent's, or
  with another root's cgroup under it, does not count; a `(pid, start)` that two scopes name counts
  for neither; a root that is an ancestor of another root does not count; the no-list 503 before the
  session's 403; a failed self-test's 503 at step 3; the order with `Origin` and the 404. `lineCloses`
  gets the root-change cases in place of the key changes.
- `test/vectors/scopes.json`: `lines` gets `roots` (valid, not an object, a bad scope, bad items) in
  place of `keys`; a relay without `--peer-check` that gets `roots` (no list applies, the 1008 closes,
  the 503); a relay with `--peer-check` that gets a line with no `roots` (the lists apply, every scope
  has no root).

## 10. What agentwatch's daemon must do (aw-lead)

1. For each live session, its pane's pid (`list-panes -F '#{pane_pid}'`, as `pane_of` reads today)
   and start time (Linux field 22; Mac `proc_pidinfo`), as `roots` in each `allowlist` line, from the
   session's first line on: the daemon reads the pane's pid and start before the scope enters its map
   (section 9.2).
2. At a respawn of the pane (a restart, an account swap, a resume), a line with the new root at once,
   with the last confirmed object, before the agent starts in the new pane (section 9.2). A connection
   whose walk ends at the old root is refused, and the relay closes the connections of the old root.
   `respawn-pane -k` gives the pane a new scope, so the old pane's jobs are refused too.
3. Start each pane's shell first, and type the agent's launch line only after the pane is in its own
   `tmux-spawn-<uuid>.scope` (section 9.2): a process that the pane forks before tmux's move stays in
   the tmux server's cgroup for life. agentwatch's launch does this today; keep it so.
4. Start the relay with `--peer-check` together with the pin of a relay that has it. When the relay's
   self-test fails (its log line `relay: the peer check cannot run: <reason>`, and the 503 `the relay
   cannot read the program of a connection`), show on the Browser page and in `agentwatch browser
   status` that the peer check cannot run on this box, so agents get the 503 (section 3.3).
5. Drop the key work of part 3: no token files under `~/.config/agentwatch/tokens/`, no
   `AGENTWATCH_BROWSER_CRED`, no hashes, no key in a launch line, no change to `agentwatch browser env`
   beyond its "without keys" form. `agentwatch browser <command>` stays: agent-browser runs as the CLI's
   child, so it is under the pane (measured with a wrapper of that form).
6. Keep each agentwatch pane in its own scope cgroup on Linux: tmux does it when its server has the
   user's D-Bus (`DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`), as agentwatch's server has today. If a
   box lacks it, P2 falls back to the walk (section 5) and nothing breaks; agentwatch can say so on the
   Browser page.
7. The skill text: the session's 403 means "connect from this session's own tools", or, just after a
   start or a restart, "connect again in a few seconds"; on the Mac (and on Linux with P1), start a
   long job with `run_in_background`, not with `nohup ... &` in a shell that exits; after a restart, an
   account swap or a resume, a job of the old pane cannot connect any more, so start it again.
8. Not needed: accepting the endpoint's connections, forwarding bytes, a per-session socket. Only in
   a later W2 build (if W1 fails on a box that we run): answer the relay's check requests on a Node IPC
   channel, with a new walk that compares start times (section 3.3).
9. The live test on taylor (with the relay's T2): two sessions, the agent's tools and its Playwright
   MCP admitted, another session's process that names the scope refused, a re-parented job admitted
   with P2.

## 11. The limits

- **A hostile process of the same OS user.** It can still act inside another session, so the check
  stops mistakes and casual crossing, not an attack (aw-lead's point 3). Measured on taylor: it can
  join another session's scope cgroup with one write (`results/cgroup-join.txt`); it can write a line
  into another process's stdin pipe through `/proc/<pid>/fd/0`, so into another session's MCP, which
  the check admits (`results/proc-fd-pipe.json`; Yama's `ptrace_scope` 1 does not stop it). It can
  send keys to another session's tmux pane. `ptrace` of another session's process is blocked by
  `ptrace_scope` 1 (only a parent may trace). The key had the same limit through
  `/proc/<pid>/environ`.
- **A server that a session leaves running (P2 only).** A nested tmux server, `screen`, or a build or
  test daemon that a session starts keeps that session's pane cgroup after it leaves the tree. A
  process of another session that runs a command through it (`tmux -L <server> run-shell`) counts as
  the first session (review-54, measured). It is inside the same-user limit above: the other session
  can already `tmux send-keys` into the first session's pane. A walk that reaches a root of another
  scope is never overridden by the cgroup.
- **The connecter, not the user.** A process of a session can pass an admitted connection on, or
  connect for another program (measured: the passed socket keeps the connecter's pid). The check
  binds the connection to the session that made it.
- **Once, at the upgrade.** A connection keeps its scope until it closes, its root changes (the 1008
  close) or the scope ends.
- **Jobs that leave the tree.** With P1 on both systems, and with P2 on the Mac, `nohup <job> &` in a
  shell that exits, `setsid -f`, a double fork and `systemd-run` are refused. With P2 on Linux only
  `systemd-run` and a new tmux pane are refused.
- **A respawn ends the old jobs' access.** After `tmux respawn-pane -k` (a restart, an account swap, a
  resume) the old pane's jobs are in the old scope and under no live root: they are refused, also with
  P2. A job that must outlive a restart starts again in the new pane.
- **Programs that agentwatch did not start.** A script in a plain terminal, a cron job outside
  agentwatch, an editor's terminal: refused, as with the key.
- **tmux's move race.** A new pane starts in the tmux server's cgroup for a moment. It does not touch
  an agentwatch pane (its shell starts first), and the relay never takes the server's cgroup as a
  root's cgroup (section 5).
- **`node:ffi` is experimental.** The self-test (section 9.4) fails closed: on a box where it cannot
  run, agents get the 503 until a later build adds W2 (section 3.3).
- **The Mac's `LOCAL_PEERPID` is the last user of the socket**, from the xnu source, not measured
  (T4).

## 12. The build split (it replaces ab-v16.36)

| Task | Repo | What | Depends on | Size |
| --- | --- | --- | --- | --- |
| T1. The contract | chrome-extension (`docs/protocol.md`, `test/vectors/`) | Section 9: the key texts replaced (intro line 29, C4 line 289, C10 lines 1034 and 1046, C11 lines 1442 to 1514, 1593 to 1596, 1922 to 2022), the 403 and 503 texts, the order, the vectors of 9.5. ab-lead mails the commit to aw-lead before the merge (C10 is a rule agentwatch follows). | this design merged | small |
| T2. The relay's peer check | agent-browser (`src/relay/endpoint.ts`, a new `src/relay/peer.ts`) | `--peer-check`; the peer reader behind one interface (Linux: `node:ffi` `getsockopt` `SO_PEERCRED` and `SO_PEERPIDFD`, libc `poll` and `close` on the pidfd, `fdinfo`, the form for a kernel before 6.5, `/proc` walk, cgroup; Mac: `LOCAL_PEERPID`, `proc_pidinfo`) with a fake for the tests; `node:ffi` loaded only with `--peer-check`, by a dynamic import in the self-test; the self-test from a child process (section 9.4); the order of 9.3 in `admit()`; the texts; the `roots` line rules and the defensive root rules; a relay without the flag that gets `roots`; the 1008 close at a root change; unit tests with the vectors; a test that no other agent-browser command loads `node:ffi`; the live test on taylor: two tmux panes of the test's own server, Playwright, agent-browser and an MCP-like child admitted, another pane's process refused, a double fork admitted (P2), a `run-shell` through the other session's nested tmux server admitted with P2 and refused with P1 (the cost, recorded) | T1; ab-v16.35 (the relay per scope) | about half of ab-v16.36: no key, no redaction of `src/options.ts` and `src/cdp.ts` |
| T3. agentwatch | agentwatch (aw-lead, an age- task) | Section 10 | T1; T2 for the live test | small (the daemon has `pane_of`) |
| T4. The Mac | agent-browser (with the Mac stage) | Measure on the Mac: `LOCAL_PEERPID` after a fork, a passed socket and a send by another process; `LOCAL_PEERTOKEN`; `node:ffi` with `getsockopt` and `proc_pidinfo` on the Mac's Node; the walk to a pane under `launchd`. Fix T2's Mac reader if needed. | T2; a Mac session | small |

ab-v16.36's build notes that name the key (review-42g notes 2, 3, 5, 6, 7, 11 and 12) do not carry
over. Note 4 (a relay without the flag that gets the field fails closed) becomes the 503 of a relay
without `--peer-check`; note 8 (open connections when an entry changes) becomes the 1008 close of
section 9.3.

## 13. Choices for the operator

One real choice remains; the rest are engineering choices that this design makes (W1, one socket,
`roots` in the line).

**Choice 1: background jobs that leave the tool's shell, on Linux.** (ab-lead's item ab-6gs asks
it, with the cost below.)

- a (recommended, P2): admit them when they stay in the session's pane scope. An agent's
  `nohup ... &` works on taylor. On the Mac such a job is refused (no cgroups). The cost: a server that
  a session starts and leaves running (a nested tmux server, `screen`, a build or test daemon) keeps
  the session's scope, so another session's process that runs a command through it counts as the
  first session. That is inside the same-user limit: another session can already type into a session
  through `tmux send-keys`, and with the key it could read the session's environment.
- b (P1): refuse them on both systems, so both behave the same. Agents start long jobs with
  `run_in_background`. A script that outlives its shell cannot use the agent browser.

No answer: a. It is one rule of the relay's step 6 (a few cgroup reads), so a change of mind later
changes only that rule. Both a and b keep the limit of section 11.

The operator's answer age-4ks ("env: no") is not asked again here: the peer check works with or
without a URL in the session's environment (section 7).

## 14. The evidence

All in [2026-11-05-peer-admission-probe/](2026-11-05-peer-admission-probe/README.md):

- `results/shapes-run2.jsonl` and `shapes-run2-agent.txt`, `shapes-run2-late.txt`: the walk for each
  shape (section 4). `shapes-run1*`: the same shapes and the other session's case.
- `results/shapes-run3*`: the walk and the pane cgroup side by side, each pane in its own scope.
- `results/claude-code-tree.txt`: this real Claude Code session's shapes, read only.
- `results/fork_pass.jsonl`: whose pid `SO_PEERCRED` and `SO_PEERPIDFD` give (section 3.1).
- `results/node_ffi_peercred.json`, `node_helper_peercred.jsonl`, `node_proc_scan.jsonl`,
  `node_ipc_fd.jsonl`: the ways of section 3.3.
- `results/bench_walk.jsonl`, `pid-space.txt`: the costs and the pid space (sections 3.1 and 3.2).
- `results/cgroup-join.txt`, `proc-fd-pipe.json`: the limit (section 11).
- `results/review-54-server-path.txt`: review-54's run of the server path (sections 5 and 11).
- `results/ffi-load-and-listen-fd.txt` (`ffi_static_import.mjs`, `ffi_dynamic_import.mjs`,
  `ffi_listen_fd.mjs`, from review-54): the static and the dynamic import, and the self-connect that
  cannot catch a reader of the listening fd (section 9.4).
