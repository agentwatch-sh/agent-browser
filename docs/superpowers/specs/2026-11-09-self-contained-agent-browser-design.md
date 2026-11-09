# A self-contained agent browser with the fewest moving parts — design

**Status: proposed. It waits for the operator's answers to Q1-Q5 and to the open points in section 17.
Nothing is built before that.**

Date: 2026-11-09. Revised after four fresh reviews and the daemon lead's review and re-read; the
manager's bound ended the review rounds after the fourth review. Author: a taylor contributor, a
design subagent of the lead (board task ab-v16.93, under goal ab-v16). Branch
`ab-v16.93-self-contained-design` in agent-browser, from main `dc2431b`. Evidence: the probe in
[2026-11-09-self-contained-agent-browser-probe/](2026-11-09-self-contained-agent-browser-probe/README.md)
(M1 to M3), run on taylor (Debian 13, Linux 6.12.115, Node v26.12.0, Debian Chromium 156.0.8078.79,
`@playwright/mcp` 0.0.85). Nothing ran on the Mac. No product code changes in this task.

The design builds on the two-modes design
([2026-11-03-two-modes-playwright-design.md](2026-11-03-two-modes-playwright-design.md)). It also builds on
the per-scope allowlist, peer admission, orphan tabs, sign-in provider and agent pointer designs of
2026-11-04 to 2026-11-06, and on chrome-extension's `docs/protocol.md` (C1 to C11). It keeps every operator
decision of those designs. Section 14 lists what it changes in them. The daemon lead sent ten constraints
and an interface proposal for this design (2026-11-09). Section 12 shows how the design keeps each
constraint.

## 1. The answer in short

1. **One process (section 5).** The **agent-browser service** (`agent-browser service`) runs once for each
   OS user on each box. It has its own lifetime and its own cgroup: a systemd user unit
   (`agent-browser.service`) on Linux, a launchd agent on the Mac. agentwatch installs and pins it. The
   service holds all of the browser:
   - Google Chrome and its updates, Xvfb, and the agent extension's install;
   - the link to the extension, the browser model (today's relay) and the CDP endpoint;
   - the MCP server, the X pointer, the lists and scopes, the sign-in import, the blocked-site prompts and
     their dismissals, and the status texts.

   Chrome survives a restart of the service and of agentwatch. The service adopts a running Chrome, as the
   daemon does today. The state of the service's own unit decides who runs the Chrome unit: the service
   while its unit is active, the daemon while it is inactive or failed. The service runs only while it
   owns. So a hand-off ends with exactly one owner also when a step is slow or a side stops (section 13.2).
2. **Two doors and one link (sections 5 and 7).**
   - The **agent door** is a 0600 Unix socket for CDP and MCP clients. It keeps the peer check of today's
     relay.
   - The **control door** is a 0600 Unix socket. It admits only the agentwatch daemon process itself, by
     its pid and start time, read at each accept. Operator acts (a list change, an allow, a sign-in import)
     arrive only there, with the provenance that the gateway gives after a password login. No
     agent-browser CLI command is a control client.
   - The **native link** joins the service and the agent extension. Chrome starts a small **host shim**
     for the extension's native port, and the shim connects to the service. The shim must stay, because
     only Chrome can start a native host (M1).
3. **agentwatch keeps no browser logic (section 7).** It keeps these parts:
   - the web viewer and the Browser pane, which show what the service gives;
   - the password login, and the provenance field that the gateway adds to an operator's op;
   - the gateway routes, as a pass-through, with the `Origin` check of the sender (the service gives the
     sender's ID);
   - the sessions: the scope, the repo, the roots and the cgroup of each session, and the pane-scope wait
     at a launch;
   - the links between boxes, the new browser grant, and a new daemon socket for the remote MCP;
   - the install, pin, restart, update and uninstall of the service, and the Web Push of a prompt.

   Every file of `agentwatch/daemon/browser/` (9,437 lines), `tools/google_chrome.py` (915 lines),
   `gateway/browser_prompts.py`, `browser_hosts.py`, `browser_lists.py`, `browser_prompt_rules.py` and the
   list and refusal code of `commands/browser.py` go away or move to agent-browser. `panes.py` moves to
   `agentwatch/daemon/` (section 7.4).
4. **The parts (section 4).** Honestly counted:
   - processes in the browser path: 5 to 4, but one more lifetime unit (the service's);
   - sockets and pipes in the browser path: 5 to 5 (and from stage 5 agentwatch's remote MCP socket); TCP
     ports: 0 to 0;
   - contracts that bind agentwatch's code: 6 to 3 (C9, C11's remote path, C12); contracts that bind
     three repositories: 2 to 0 (from stage 5 one shared rule, the remote scope's pattern, binds three);
   - repositories that one bridge op or list rule change touches: 3 to 2;
   - process boundaries of an agent's CDP call: 4 to 3; of an MCP tool call: 5 to 4; of an operator act: 3
     to 4 (a rare path).

   The receiver's code does not change for the move.
5. **The MCP (section 8).** The standard Playwright MCP runs from code inside the service. It serves its
   usual tools over Streamable HTTP on the agent door, at `/mcp/<scope>`. M3 started it from code and
   called `initialize`, `tools/list` (25 tools), `browser_navigate` and `browser_snapshot` with plain HTTP
   requests on a Unix socket. The service passes only the tools and argument keys of an allow list, which
   is fixed for each pinned MCP version; a test fails when the pinned `tools/list` changes. The list leaves
   out `browser_run_code_unsafe`, which runs client JavaScript in the server's process. A local session
   reaches the MCP through a stdio shim, `agent-browser mcp`, which is a child of the session. So the kernel
   check of the Unix socket holds on Linux and on the Mac, with no TCP port and no key.
6. **Loopback TCP (section 8.3).** The peer check over loopback TCP works on Linux. M2 gave the right
   decision in each case, at 10.4 ms p50 per new connection (a scan of the session's processes) or 23.1 ms
   p50 (a scan of every process). `SO_PEERCRED` on a Unix socket takes 0.02 ms. The design does not use
   TCP by default, for three reasons:
   - another OS user can take the port while the service is down (taylor has three human users);
   - the check finds the holders of the socket, not the process that connected;
   - the Mac has no `/proc`.

   Question Q1 asks the operator.
7. **Another box (section 9).** A session on taylor uses the agent browser on the Mac through the
   agentwatch link. A new socket of taylor's daemon names the session with a kernel peer check. The link
   carries the MCP's HTTP requests, sealed, under a new browser grant that the operator approves on the
   Mac's Links page, with a size limit for each answer and a rate limit for each remote session. The Mac's
   daemon opens the Mac service's agent door for the scope `taylor/<session>`, on the MCP path only. The
   Mac never opens a port. The grant's list on the Mac and the Mac rules apply: the operator's consent, the
   quiet times, no focus taken, and no tool argument that names a file on the Mac.
8. **The move (section 13).** Six stages. Each stage is a pull request with tests and a pin bump, and has a
   rollback. The service first runs beside today's path, off by default, and the old path stays the
   default and unchanged until stage 6. The switch on a box moves every part at once; the tested rollback
   (switch-off, with the same Chrome and the same list files) is its safeguard. The move keeps today's
   rule for start and stop; Q5 asks the operator about a change.
9. **Open for the operator (sections 16 and 17).** Five questions (Q1 to Q5) and three open points at the
   edges of section 13.2's rule: a switch-on that the daemon gave up, a start of the service's unit from
   outside the switch-on, and the Mac after the daemon unloads the service's job. Nothing is built before
   the operator answers.

## 2. The operator's words

- 2026-11-09, on the board task: "i prefer the agentbrowser is more self-contained. seems like a lot of
  moving parts. why couldn't the mcp server be in the extension, for example?"
- 2026-11-09, on the MCP: "can we use http instead of stdio?"
- 2026-11-09, on another box: "ok but how would a session on taylor use the agentbrowser on my mac for
  example?" and "isn't http better for that?"
- 2026-11-09, the decision: "yes agreed. so let's build a single self-contained process/wrapper that
  includes the relay/browser/extension/etc and everything communicates over that. we need to organize
  things so the design doesn't have so many moving pieces."
- 2026-11-09, after that: "We need all the browser code to move into the browser." The lead's reading:
  all browser code moves out of agentwatch into agent-browser (its service and its extension), and
  agentwatch keeps no browser logic.
- 2026-11-09, on the input work (epic ab-t30): "ideally a consumer writes vanilla playwright and our system
  transliates the clicks and types into a human version. i.e. the caller doesn't worry about it", and
  "don't do this half baked".
- Earlier answers that this design keeps: no prompt and no remote-debugging port (ab-jzg Q2), no cookie
  calls (ab-8mf), the page marks refused (ab-jzg Q3), no key per session (ab-dm6), "env: no" for the
  endpoint in a session's environment (age-4ks), Google Chrome stable with the external extensions file
  on taylor (ab-32m), the operator's own `Google Chrome.app` with its own profile on the Mac (ab-9hj),
  background jobs of a session admitted on Linux (ab-6gs).

The measure of this design: fewer processes, sockets, contracts, repositories per change and hops per
call, with every security rule of today kept.

## 3. Words

- **The service**: the agent-browser service process, `agent-browser service`.
- **The agent door**: the service's Unix socket for clients: CDP at `/devtools/browser/<scope>`, MCP at
  `/mcp/<scope>`. A local client may send `/mcp` alone: the service then takes the scope from the walk.
- **The control door**: the service's Unix socket for agentwatch's daemon.
- **The host shim**: the process that Chrome starts when the agent extension opens its native port.
- **The native link**: extension, Chrome, host shim, service. Contract C4.
- **The agentwatch link**: agentwatch's link between two boxes (machine keys and grants).
- **The receiver**: the agent extension (chrome-extension `agent/`).
- **A scope**, **a root**, **the walk**: as in the peer admission design. A scope is the launch name of
  an agentwatch session. A root is the pid and start time of the session's tmux pane process.
- **A hop**: one process boundary that a message crosses.
- **The owner**: the one side, the daemon or the service, that runs the Chrome unit at a given moment.
  The service's unit state names it: the service while its unit is active, the daemon while it is
  inactive or failed (section 13.2).
- **The switch**: agentwatch's config key per box that gives the Chrome unit to the service (stages 2
  and 3).
- **The daemon lead**: the lead of agentwatch's daemon.

## 4. The shape, and the parts before and after

### 4.1 Today

```
 an agent session (tmux pane)                              the box (one OS user)
 +-----------------------------+  ws+unix   +-------+ stdio  +-------------------+ unix  +-------------+ native  +--------+
 | Playwright, agent-browser   |---CDP----->| relay |------->| agentwatch daemon |------>| native host |-------->| Chrome |--> receiver
 | Playwright MCP (stdio, one  |   (C11)    | (Node)| (C10)  | (Python): carrier,|  (C4) | (Python)    |  stdio  |        |    (agent/)
 |  Playwright per session)    |            +-------+        | Chrome unit, Xvfb,|       +-------------+         +--------+
 +-----------------------------+                             | X pointer, lists, |                                  ^ Xvfb
                                                             | scopes, sign-ins  |<-- gateway (C9) <-- web viewer,
                                                             +-------------------+                     operator extension
```

### 4.2 After

```
 an agent session (tmux pane)        the agent-browser service (one Node process per OS user and box)
 +--------------------------+ agent  +------------------------------------------------+ link  +-----------+ native  +--------+
 | Playwright, agent-browser|-door-->| agent door: CDP endpoint, MCP (Playwright MCP) |------>| host shim |-------->| Chrome |--> receiver
 | agent-browser mcp (stdio |  unix  | browser model (today's relay), peer check      |  (C4) +-----------+  stdio  |        |    (agent/)
 |  shim, no Playwright)    | socket | Chrome + Xvfb unit, updates, extension install |                          +--------+
 +--------------------------+        | X pointer, lists, scopes, sign-in import,      |                             ^ Xvfb
                                     | blocked events                                 |
                                     +------------------------------------------------+
                                        ^ control door (C12), unix socket
 agentwatch daemon (sessions, roots, provenance, links) ----+
   ^ gateway (C9, a pass-through) <-- web viewer (Browser pane), operator extension
   ^ agentwatch link <-- another box's daemon (browser grant): remote MCP to the agent door, scope <box>/<session>
```

### 4.3 The parts table

| Part | Today | After |
| --- | --- | --- |
| Lifetime units for the browser (systemd user units, launchd agents) | 1: agentwatch's own unit; Chrome and Xvfb run detached under it | 2: agentwatch's unit, and the new `agent-browser.service` with its own cgroup; Chrome and Xvfb run detached under the service's unit |
| Who owns the Chrome unit | the daemon, always (no arbiter) | the state of the service's unit, which systemd (launchd on the Mac) keeps: the service while it is active, the daemon while it is inactive or failed; no file or message of its own (section 13.2) |
| Long-lived processes in the browser path (one OS user, one box) | 5: agentwatch daemon (carrier), relay, native host, Chrome, Xvfb | 4: service, host shim, Chrome, Xvfb (the daemon leaves the path) |
| Processes for the MCP of each session | 1 Playwright MCP per session (Node and Playwright; its memory is not measured here) | 1 stdio shim per session (62.7 MiB, no Playwright, M3); the session's MCP work runs in a worker thread of the service, with a heap limit for each scope (section 8.2; its memory is not measured) |
| Connections of one session's MCP | its stdio pipe; its CDP connection to the relay | the shim's stdio pipe; the shim's HTTP connection to the agent door; inside the service, the MCP's CDP connection back to the agent door with a one-time ticket that never leaves the process (section 8.2) |
| Sockets and pipes in the browser path | 5: `browser-cdp.sock`, the relay's stdin and stdout, `browser.sock`, the native stdio, the X display | 5 on each box: the agent door, the control door, the link socket, the native stdio, the X display; from stage 5 one more, agentwatch's remote MCP socket, on a box whose sessions use another box's browser |
| TCP ports | 0 | 0 (1 only with Q1 b) |
| Contracts that bind agentwatch's code | 6: C1 (agentwatch pins the IDs), C2 (the daemon checks the payload), C4, C9, C10, C11 | 3: C9 (with the send's size limit), C11 (only the remote MCP path; until stage 6 also the endpoint path that the daemon gives), C12 (new). C1: agentwatch keeps no ID and no pin; it reads the sender's ID and package from the service. C2: agentwatch carries the bytes and checks none of them |
| Contracts that bind three repositories | 2: C10 and C11 (chrome-extension, agent-browser, agentwatch) | none until stage 5: C4 and C10 bind chrome-extension and agent-browser; C11 and C12 bind agent-browser and agentwatch, and their master text moves to agent-browser (stage 0); C9 binds chrome-extension and agentwatch, and it uses a sender ID that the service gives through C12. From stage 5, one shared rule binds three: the scope pattern with `<box>/` (C4 and C11), which agentwatch fills in `set_sessions`, the service passes on and the receiver checks |
| Repositories that one bridge op change touches | 3 (receiver, relay, daemon carrier) | 2 (receiver, service) |
| Repositories that one list rule change touches | 3 (receiver DNR, relay, daemon `ScopeBook`) | 2 (receiver, service) |
| Repositories that a Chrome start flag or update rule touches | 2 (agentwatch `unit.py` and its twin check `chrome_args.py`, agent-browser `assertSafeChromeArgs`) | 1 (agent-browser) |
| Rules written twice, in Python and TypeScript | the Chrome flag check, the scope pattern, C4's list rules (`ScopeBook` and `scopes.ts`), the version order, the host rules (`browser_hosts.py` and `allowlist.ts`) | none (TypeScript, and the receiver's JavaScript) |
| Process boundaries of an agent's CDP call to Chrome | 4: client, relay, daemon, host, Chrome | 3: client, service, host shim, Chrome |
| Process boundaries of an MCP tool call to Chrome | 5: agent, MCP, relay, daemon, host, Chrome | 4: agent, MCP shim, service, host shim, Chrome |
| Process boundaries of an MCP tool call from another box | no path | 6: agent, MCP shim on taylor, taylor's daemon, the Mac's daemon (over the agentwatch link), the Mac service, the host shim, Chrome |
| Process boundaries of a pointer path (X) | 2: relay, daemon, xdotool | 1: service, xdotool |
| Process boundaries of an operator act (a list change, a sign-in send) to Chrome | 3: gateway, daemon, host, Chrome | 4: gateway, daemon, service, host shim, Chrome (one more, on a rare path) |
| Browser code in agentwatch | 9,437 lines in `daemon/browser/`, 915 in `tools/google_chrome.py`, `gateway/browser_prompts.py`, `browser_hosts.py`, `browser_lists.py`, `browser_prompt_rules.py`, parts of `commands/browser.py` and `server/routes/browser.py` | a control door client, a remote MCP socket, the gateway pass-through and the UI (section 7.4) |

The hot path (an agent's calls, thousands a minute) loses one process boundary. The operator's acts (a few
a day) gain one. The relay's stdio pipes, the daemon's carrier and its limits (`MAX_BYTES_IN_FLIGHT`,
parts, waits) and the `daemon.*` ops leave the wire: they become calls inside one process. The new parts are
the service's unit, the control door, one shim for each session that uses the MCP, and the remote path's
parts (section 9).

## 5. The service (task item 1)

### 5.1 What it holds

| Part | Today | In the service |
| --- | --- | --- |
| Google Chrome stable in a tools folder, its signed index and its updates | agentwatch `tools/google_chrome.py`, `daemon/browser/updates.py`, `versions.py` | the same rules: the `.deb` from Google's signed index (checked with `gpgv` against the pinned key), unpacked into the service's tools folder with no system install; the move waits for an idle hour (no request and no send for an hour) and for the clients to leave; after 24 h only the clients rule goes, and the idle hour stays (today's rule) |
| The Chrome unit: start, adopt, supervise, stop | `unit.py` (`BrowserUnit`), `stop_unit.py` | the service starts Chrome detached in its own session, records it (`unit.json`), adopts it after its own restart, supervises it every 5 s; `agent-browser service stop --all` stops it for the uninstall |
| The Chrome flags | `unit.py` `AGENT_ARGS`, its twin check `chrome_args.py` | agent-browser's `assertSafeChromeArgs` alone: no `--remote-debugging-*`, no `--enable-automation`, no `--headless` |
| Xvfb and its auth file (Linux) | `unit.py`, `xauth.py` | the same: `-nolisten tcp`, a fresh cookie at each start, the first free display from 90 to 189 |
| The agent package and its install | `crx.py`, `ext_id.py`, the receiver pin in agentwatch `tools/pins.py` | agent-browser pins the chrome-extension commit and the CRX's SHA-256, checks the CRX and writes the external extensions file of its own Chrome copy; on the Mac, section 10 |
| The native link | `host_files.py`, `native_host.py`, `link.py`, `parts.py` | the host manifest in `<profile>/NativeMessagingHosts/`, the host shim (`agent-browser host`), the link socket and its peer check, the channels and parts of C4 |
| The bridge (C10) | the relay and the daemon's carrier (`bridge.py`) | inside the service: the model's bridge writes to the native link, with no stdio pipe and no carrier |
| The browser model | `agent-browser relay`, a child of the daemon (`relay.py`) | the same model code (`src/relay/model.ts`), in the service |
| The CDP endpoint | the relay's socket `browser-cdp.sock` | the agent door, path `/devtools/browser/<scope>` |
| The MCP | a Playwright MCP per session, outside | the agent door, path `/mcp/<scope>` (section 8) |
| The X pointer | `pointer.py` (`daemon.pointerAt`, `daemon.movePointer`) | in the service: the model plans the path (`src/relay/pointer.ts`) and plays it with `xdotool` on its own Xvfb |
| The lists and the scopes | `lists.py`, `allowlist.py`, `scopes.py` (`ScopeBook`, the ended file), `browser_lists.py`, `browser_hosts.py` (`normalize_entry`, `covers`) | the service reads and writes today's list files in today's folder, `CONFIG_DIR/browser/lists/`, in the same format (section 7.5); it builds `set_scopes` and the model's lines from the sessions that agentwatch sends; it owns the host rules and the ended scopes |
| The list copy of each scope for agent-browser's CLI | `commands/browser.py` writes `<state>/session-lists/<scope>/allowlist.json` before each command | the service writes it at each list change (it owns the state folder), and removes it at the scope's end |
| The sign-in import (C2 to C6) | `payload.py`, `service._import` | the service checks the payload (C2), applies the box's own sign-in rule with the hosts that agentwatch gives, and sends `import` to the receiver; payloads stay in memory only |
| The blocked-site prompts | the receiver's `blocked`, the relay's `daemon.blocked`, `service.on_blocked`; the gateway's `browser_prompts.py` (the list of a blocked host, whether a list covers it, the broad-provider and shared-host warnings with `SIGN_IN_HOSTS`, the dismissals) and `browser_prompt_rules.py` | the service: it makes each prompt (its list, its cover check, its warnings), keeps the dismissals, and sends one `prompt` event on the control door; the gateway only shows prompts and sends their Web Push |
| The status texts | the daemon's `_status_for` and the endpoint texts, with the I2 rule (no text that an agent reads names a stop or a start) | the service, with the I2 rule: `status` gives an agent's text and an operator's text, and the daemon shows the operator's text only to a password login |
| The person's input (ab-t30.6) | `src/input.ts` in agent-browser's own commands; the relay does not shape a client's input | section 5.5 |

### 5.2 One process

The service is one Node process. The model, the endpoint, the link, the unit and the lists share one event
loop, as the relay's model does today. The MCP's Playwright code runs in a worker thread of the service.
Then a long Playwright step never holds the model's loop. (This is a build choice; M3 ran it on the main
thread.) Chrome, Xvfb, the host shim and `xdotool` stay separate processes: Chrome must be a process, and
Chrome starts the shim.

The service has its own unit, `agent-browser.service`, and so its own cgroup
(`app.slice/agent-browser.service`), outside agentwatch's unit and outside every session's pane scope. It
runs only while it owns the Chrome unit (section 13.2). So the daemon's memory guard never caps the browser
for all sessions (the daemon lead's C9). The unit file names agentwatch's unit only for the control door's
check (section 7.1). Chrome and Xvfb run detached, in their own sessions. At a restart the unit stops only
the service (`KillMode=process` on Linux, as in agentwatch's own unit). So Chrome survives a restart of the
service.

The folders:

- The service takes its state folder from its unit, which agentwatch writes at the install. The default is
  today's folder, `~/.local/share/agentwatch-browser/`, with its profile. So the switch moves no file and
  keeps every sent sign-in.
- The lists stay in today's folder, `CONFIG_DIR/browser/lists/`, which the unit also gives the service
  (section 7.5).
- Its sockets are in `$XDG_RUNTIME_DIR/agent-browser/` on Linux (0700) and in `~/.cache/agent-browser/run/`
  on the Mac. Each path has at most 103 bytes.
- Section 13 keeps today's endpoint path during the move.

### 5.3 The host shim: why it stays, and what it does

An extension cannot listen on a socket, and it cannot start a process. Its only way out is
`chrome.runtime.connectNative`, and then Chrome itself starts the host program that the profile's
manifest names. So a process that Chrome starts must exist. The service cannot be that process. Chrome
would start it and end it with the port. But the service must own Chrome's life and survive Chrome's
restarts (the daemon lead's C5). So a small host shim stays. Measured (M1):

- Chrome starts the host from the per-profile folder `<user-data-dir>/NativeMessagingHosts/` (Chromium
  156 with `--headless=new` and a temp profile; the first link came 509 ms after the start).
- The shim relays frames in both directions: Chrome's 4-byte length and JSON, to one JSON line on the link
  socket. It holds no logic and no state. M1's shim has 32 lines; today's `native_host.py` has 288.
- The service tells its own shim from any other process: the kernel gives the shim's pid
  (`SO_PEERCRED`), and the shim's parent must be the Chrome that the service started, by pid and start
  time, on the agent profile. Measured: the shim's parent was the probe's Chromium on the temp profile. A
  process of the probe's driver connected to the same socket, and the service refused it ("its parent is
  not the service's Chrome").
- The round trip service, shim, extension, shim, service: 0.79 ms p50, 1.05 ms p90, 1.97 ms p99 (1000
  pings); 2.66 ms p50 with 64 KiB of payload; 100 pings at once in 14 ms in all.
- The shim's memory: 49.5 MiB of resident memory (Node). One shim runs for each Chrome, not for each
  session.
- When the host process ends (at a change of owner, section 13.2), Chrome keeps running, the extension
  connects again after its 1 s delay, and Chrome starts a new host. Chrome reads the manifest again at
  that connect, so a new host path takes effect with no Chrome restart. Measured: the link was back after
  1,065 ms. Chromium's pid and start time stayed, and the new shim ran the new host path. (M1's shim
  exited when the service closed its socket. The design's shim does not: as today's host, it tries the
  socket again every second while Chrome's port is open, so a restart of the service does not close the
  receiver's port. At a change of owner, the new owner ends the old host.)

The shim keeps today's host's own check too: its parent must run on the agent profile
(`--user-data-dir` in `/proc/<ppid>/cmdline`, `ps` on the Mac). It sends `{"t":"link","up":true}` to the
extension after each connect, as today. The host name stays `sh.agentwatch.browser`, so the receiver
needs no change (section 6).

### 5.4 The model, the endpoint and the bridge inside one process

The model (`src/relay/model.ts`) does not change its rules. Its inputs change their source:

| Model input | Today | In the service |
| --- | --- | --- |
| Bridge requests and answers | JSON lines on the relay's stdout and stdin, through the daemon | calls on the native link object |
| `link` up and down | lines from the daemon | the link socket's state |
| The `allowlist` line (lists, scopes, default, roots) | a line from the daemon after each confirmed `set_scopes` | a call after each confirmed `set_scopes`, which the service itself sends |
| `end_scope` | a line from the daemon | a call at `session_ended` on the control door |
| `daemon.blocked` | a C10 op to the daemon (250 ms) | a call to the service's own prompts, and a `prompt` event on the control door; the refusal text stays |
| `daemon.pointerAt`, `daemon.movePointer` | C10 ops to the daemon, which runs `xdotool` | calls inside the service, with the same checks (each step at most 50 px, 16 to 250 ms, at most 1500 ms, 5 paths a second) |

The C4 rules that the daemon applies today move with it:

- one main-channel request at a time;
- the bridge channel never waits behind an import;
- parts of at most 700,000 bytes to the receiver, and the joins of result parts;
- `MAX_BYTES_IN_FLIGHT`, the waits and the deadline answers (`timeout`, `disconnected`, `not connected`,
  `too large`).

### 5.5 Where the person's input plugs in (ab-t30.6)

ab-t30.6 designs how agent mode turns a vanilla Playwright client's input into a person's input. Its plug
point is in the service, between a client's input call and the bridge:

```
 client CDP call --> agent door --> model.onMessage --> input stage (ab-t30.6) --> bridge --> receiver --> chrome.debugger
                                                          |  reads: page geometry, last points, the front page
                                                          |  plays: X pointer paths (Linux), CDP paths and key events
                                                          +-- one input lock for the whole agent browser (in memory)
```

The service holds, in one process, every fact that such a stage needs:

- the pages' geometry and last points, and the window that is in front;
- the X pointer and its paths;
- the one input lock of the agent browser. Today agent-browser's input commands share a file lock in the
  state folder (`input.lock`), because each command is a process of its own.

The MCP's tools call Playwright, Playwright calls the model, and the model calls the input stage. So the
MCP gets the same input as any other client. agent-browser's own CLI commands over the agent door can
then send plain CDP input and get the same shape. This design does not design the stage. It only fixes
where the stage runs.

### 5.6 Status, start, stop, update, browser.control

- **Status**: `status` on the control door gives these facts, with an agent's text and an operator's text
  for each state (I2: no agent's text names a stop or a start). The Browser pane shows them:
  - the state: off, starting, ready, or failed closed;
  - Chrome's kind, version, pid and update state, and the extension's version;
  - the agent door's state: the peer check's form, or why it cannot run;
  - the sessions and lists that the service has.
- **Start and stop** of the agent browser (Chrome and Xvfb) keep today's rule during the move. The control
  door takes them from the daemon. The daemon takes them from a password login or from the API token, as
  today (an agent's `endpoint` wait sends a start). Each op names its caller's kind (section 7.1), so the
  service logs who asked. Q5 asks the operator whether start and stop become operator acts only (a Tier-2
  change). The service process itself starts with its unit at login.
- **Update**: the service checks Google's index every 12 hours and moves Chrome when idle (today's rule).
  It reports each step on the event stream. agentwatch updates the service itself by its pin (the daemon
  lead's C7).
- **`browser.control: false`**: a key of agentwatch's config file, as today. The daemon passes it in
  `config` (section 7.1). The agent door then refuses every connection with a 503 that says that the
  operator turned agent control off. Today the endpoint does not exist then (section 14).

## 6. The extension (task item 2)

The receiver stays thin. It is Chrome's only door to the `chrome.*` calls (`chrome.debugger`, `tabs`,
`windows`, `downloads`, `contentSettings`, DNR). It keeps its jobs: the bridge ops, the DNR block per scope,
the guard, the sweep, the hold, the import, the tab-to-scope map.

**The receiver's code does not change for the move.** The receiver connects to the host name
`sh.agentwatch.browser` (`agent/link.js`). The service writes the same name into the agent profile's host
manifest, with the same `allowed_origins`. The shim sends the same `link` message. The frames, channels,
parts and messages stay as they are. So the receiver cannot tell the service from the daemon, and the move
needs no extension release. (M1 used a test extension that copies the receiver's 1 s reconnect, not the
real receiver; stage 1's live test runs the real one.)

**The contract text changes** (chrome-extension `docs/protocol.md` is the master of C1, C4, C5, C10 and
C11). Stage 0 writes them; the texts that name the service as a party apply **from stage 3** on a box
whose switch is on, and until then the daemon stays the party:

- **C1**: the native host name stays. agent-browser, not agentwatch, pins the chrome-extension commit, the
  receiver ID and the CRX's SHA-256. agentwatch keeps no chrome-extension pin. The service gives the
  sender's ID, its version and the sender package (the zip of the pinned commit's `operator/` folder) on
  the control door. The gateway's `Origin` check (C9) uses that ID, and the Browser pane offers that zip.
- **C4** (from stage 3): the party on the host's far side is the service, not the daemon. The rules of C4
  that name the daemon (`set_scopes` after each link up, its 10 s wait, the ended scopes, the restart
  gate, the rollout) name the service.
- **C10** (from stage 3): the bridge ops stay. "The path of a message" changes: the relay's model and the
  carrier are one process, so the relay's stdio lines and the daemon's carrier go. "The daemon's own ops"
  (`daemon.pointerAt`, `daemon.movePointer`, `daemon.blocked`) leave the wire: they become calls inside the
  service, with the same checks. C10 then binds two repositories. It can join C4 as C4's bridge channel:
  one contract for the native link.
- **C11**: its parties become agent-browser (the endpoint) and agentwatch (only the remote MCP path of
  section 9, and until stage 6 the endpoint path that the daemon gives). Its master text moves to
  agent-browser, beside C12. The MCP path `/mcp/<scope>` joins it (section 8). A remote scope
  `<box>/<session>` joins the scope pattern of C4 and C11 (section 9); this one needs a small receiver
  change in `agent/scopes.js`, in the cross-box stage.

**The operator package does not change.** It holds no `debugger` and no `nativeMessaging` permission
(`operator/manifest.json`; `test/manifests.test.mjs` fails the build otherwise). It talks only to the
gateway (C9), with the login cookie and its `Origin`, and nothing in it depends on which process is the
receiver's host.

## 7. The interface with agentwatch (task item 3)

### 7.1 The control door (C12, new; agent-browser and agentwatch only)

The control door follows the daemon lead's proposal and review.

- **Transport**: a 0600 Unix socket in the service's 0700 run folder, one JSON object per line, requests
  with an `id` and answers, plus one event stream.
- **Who connects: only the agentwatch daemon process itself.** At each accept the service reads the peer
  (`SO_PEERCRED` and `SO_PEERPIDFD` on Linux) and admits it only when all of these hold:
  - the service gets the MainPID of agentwatch's unit from the user's systemd at this accept (a daemon
    restart changes it; a control connection is rare: one for each daemon start);
  - the peer is the MainPID itself, or a direct child of it: the peer's parent pid is the MainPID, and the
    parent's start time (field 22 of `/proc/<ppid>/stat`) equals the MainPID's start time, read in the
    same check;
  - the peer's command line (`/proc/<pid>/cmdline`) is the daemon's command, which the service's unit file
    names. The command line, not the executable, carries this check: a venv's `python` is a symbolic link,
    so `/proc/<pid>/exe` names the shared interpreter of every Python process;
  - the peer is the same process during the whole check: the service holds its pidfd, and the peer's start
    time is the same before and after the reads, and later than its parent's.

  Today agentwatch's MainPID is `uv run`, and the daemon that connects is its child, so the child case
  admits it (the daemon lead's facts). The rule does not rely on `uv run` not being a child subreaper:
  even if a double-forked helper became its child, the helper's command line is not the daemon's. A process
  in agentwatch's cgroup is not enough: agentwatch's tmux server, and the hooks and helpers that the daemon
  starts, are in that cgroup too. The kernel names the process that connected, so a connection that the
  daemon passes to a forked child stays the daemon's connection; the daemon must not pass it on (the
  daemon lead's rule for its own code). A child that the daemon forks and that connects itself has the
  daemon, not the MainPID, as its parent, and fails.
- **When the check cannot run, the door refuses** (the daemon lead's m1). If the systemd query fails, or
  the daemon runs with no systemd user unit (a daemon started by hand, a box with no user manager), the
  service refuses every control connection with one line that gives the reason, and closes it, and it logs
  the reason. The daemon shows that line in `agentwatch health`. The service never admits by a weaker rule.
  So the switch needs agentwatch to run as its user unit: the daemon checks this before a switch-on, and a
  control door that does not work within 30 s after the start makes the daemon run the switch-off
  (section 13.2).
- **On the Mac** the service reads `LOCAL_PEERPID`, gets the job's pid from `launchctl print
  gui/<uid>/<agentwatch's label>` (its `pid` line) at each accept, reads the parent and the start time
  with `proc_pidinfo` and the command line with `sysctl` (`KERN_PROCARGS2`), and applies the same rules
  (`proc_pidpath` names only the shared interpreter). Not run on the Mac.
- The service's own pid never passes. No agent-browser CLI command is a control client.
- **The hello**: each side sends `{"t":"hello","v":1,"version":...,"features":[...]}` first. Fields are
  only added, never changed. A side that lacks a feature answers `unsupported`. So an older service and a
  newer daemon (or the reverse) degrade, with no lock-step bump (the daemon lead's C7).
- **Provenance** (the daemon lead's R7): today the gateway refuses a caller with no password login before
  it sends an operator op, but the op itself carries no provenance. The gateway adds an additive field to
  the daemon op, `"operator":{"user":...,"login":"password"}`, only after its password-login check (no
  protocol version bump). Each op on the control door carries one shape of provenance:
  `"by":{"kind":"operator"|"token"|"daemon","user":...,"via":"web"|"send"|"cli"|"config"}`.
  - `kind: operator` only when the gateway's field is present. The daemon refuses a list change, an allow,
    a dismissal or an import without it. A caller with the API token (an agent, or `agentwatch browser ...`
    in a terminal) never produces it.
  - `kind: token` for a start or a stop with the API token (today's rule, section 5.6).
  - `kind: daemon` for the daemon's own ops: `config`, `set_sessions`, `session_ended` and
    `launch_check`. `browser.control` is a key of agentwatch's config file, as today, so it comes
    in `config` with `kind: daemon` and `via: config`: its provenance is the config file, as today (the
    same-user limit of section 11 applies to that file today too).

  The service takes provenance only from the control door, never from a client request.
- **When the daemon drops** (a daemon restart or stop): the service goes on. Chrome, the agent door and
  the last `set_sessions` stay, and the walk refuses each root that is gone. The event stream keeps no
  event for a later reader. At each connect the daemon reads `status`, which gives the state, the last
  stop with its reason and time, the open prompts and the update state, so a `stopped` event that the
  daemon missed is still seen. The next complete `set_sessions` is the truth again.

| Daemon to service | What the service does |
| --- | --- |
| `config {enabled, control, chrome_bin, chrome_args, ...}` | agentwatch's `browser.*` config keys, as data, at each connect and each change. The service applies them (`chrome_bin` keeps the way back to Chromium with `--load-extension`; `control: false` closes the agent door with its 503; `enabled: false` stops the browser). |
| `set_sessions {sessions:[{scope, repo, roots:[{pid,start}], cgroup}], remote:[{scope, box, list}], box:{hosts, cookie_names}}` | A complete snapshot. The service builds the scopes, the list of each scope (by repo), the `set_scopes` object and the model's line. No scope object goes out before the first complete snapshot (the daemon lead's C4). |
| `session_ended {scope}` | Ends the scope: closes its tabs (`end_scope`, the receiver's sweep), drops its roots, removes its list copy, records the ended scope. |
| `launch_check {scope}` | Today's `launch_refusal`: a refusal text while an ended scope of that name is held in memory only, else none. The daemon asks before each launch. If the service does not answer in 2 s, the daemon refuses only a name that ended since its own start, with a text that says to try again. |
| `list_set {list, allow, providers}` (operator) | Checks each entry with the host rules (`normalize_entry`), answers the refused entries, writes the list file; the next `set_scopes` carries it. |
| `prompt_allow {id}`, `prompt_dismiss {id}` (operator) | The service owns the prompts and their dismissals. The allow adds the host to the prompt's list, as a `list_set`. |
| `import {payload}` (operator, `via: send`) | Checks the payload (C2), drops the box's own sign-in cookies (the hosts and names of `set_sessions`), sends `import` to the receiver, answers the counts. Nothing is written to disk. |
| `start`, `stop` (`by.kind`: `operator` or `token`) | Starts or stops Chrome and Xvfb. Today's rule stays during the move (the API token may start and stop); Q5 asks about a change. |
| `status`, `lists_get`, `prompts_get`, `endpoint {scope}`, `sender` | The status of section 5.6, with an agent's text and an operator's text (I2); the lists and the old single list (read only); the open prompts; the agent door's URL for a scope (for `agentwatch browser endpoint` and `env`); the sender's ID, version and package (C1, C9). |

| Service to daemon (the event stream) | Fields |
| --- | --- |
| `ready` | Chrome's pid and version, the extension's version, the agent door's state |
| `prompt` | a new, changed or closed prompt: its id, host, scope, list, the `from` host, its warnings (the per-host limit of once in 10 s stays). No URL path. |
| `stopped` | a reason: `receiver_missing`, `sessions_unread`, a failed start, a stop with its caller's kind (the daemon lead's C4: the daemon sees each fail-closed stop) |
| `chrome` | the version and the update state |
| `error` | a user, a domain and counts only, never a page, a cookie or a URL path |

### 7.2 What agentwatch keeps

- The web viewer and the Browser pane. They show the service's facts and texts, and the gateway gives the
  operator's texts only to a password login.
- The password login and the provenance field of section 7.1 (R7).
- The gateway routes as a pass-through: `GET /api/browser`, `POST /api/browser/start`, `/stop`,
  `/allowlist`, `/prompts/{id}/dismiss` and C9's `GET /api/browser/targets` and `POST /api/browser/send`,
  with C9's `Origin` check against the sender ID that the service gives, and the send's size limit. The
  gateway is root and never reads a user's file (the daemon lead's C1). It passes each request to the
  user's daemon. The daemon passes it to that user's service.
- The Web Push of a prompt (`gateway/browser_events.py`), from the service's `prompt` events.
- The sessions: the scope (the launch name, never an alias), the repo, the roots (pane pid and start
  time), the pane's cgroup, and the pane-scope wait at a launch (`sessions.py`, `await_pane_scope`). The
  wait stays because the peer check and the memory guard both need each pane in its own scope.
- The links between boxes, the new browser grant and the remote MCP socket (section 9).
- The install, pin, restart, update and uninstall of the service, and its line in `agentwatch health`.
- `agentwatch browser <command>`: it stays a thin wrapper that runs agent-browser's CLI as the session's
  child (so the peer check admits it). `endpoint` and `env` ask the service for the URL. `start`, `stop`,
  `status` and `allowlist` call the gateway, as today.

### 7.3 The unit, the pin, restarts and the tests

- **The unit** (the daemon lead's R4): agentwatch's install writes `agent-browser.service` (Linux) or a
  launchd agent (Mac). Its command is the pinned agent-browser's `bin/agent-browser.js service`, with the
  state folder, the lists folder, agentwatch's unit name and the daemon's command line (for section 7.1's
  check). The service runs in its own cgroup, not in agentwatch's.
- **Only where the browser is on** (the daemon lead's m2): agentwatch writes the unit file only while
  `browser.enabled` is true, and it enables and starts the unit only at a switch-on. The service runs only
  while it owns (section 13.2), so a box or a user with the switch off, or the browser off, runs no extra
  Node process. When `browser.enabled` turns false and the service owns the unit, the daemon runs the
  switch-off first, then stops the browser as today, then removes the unit file.
- **A pin change** (R3): `agentwatch restart` does not touch the service (its own lifetime, C5). An
  agentwatch update or rollback that changes `AGENT_BROWSER_COMMIT` installs that commit beside the old
  one, and writes the unit's command again. Only when the unit is active (the service owns) does it
  restart the unit (`systemctl --user restart`, and `launchctl kickstart -k` on the Mac). The unit stays
  `activating` or has a job of systemd during the restart, so the service owns throughout (section
  13.2), and the new instance adopts Chrome. At each connect the daemon also compares the hello's version
  with its pin; on a mismatch it does the same restart once and reports it.
- **Health** (R3): `agentwatch health` shows the service: up or down, its version and whether it matches the
  pin, the owner (the service's unit state, section 13.2), Chrome's pid, the peer check's form, and a
  control door refusal with its reason (section 7.1).
- **The memory guard** (the daemon lead's m4) takes Chrome's pid (`browser_pid`) from the service's
  `ready` events and `status`, read off its own tick with a short time limit. When the service is down or
  slow, the guard keeps its last known pid, and its tick never waits for the service.
- **Hermetic tests** (C10): `agent-browser service --fake` serves the control door with a scripted state
  and no Chrome, so agentwatch's `make check` stays hermetic. Its hello lists the feature `fake`.
- **The uninstall** (C10): agentwatch's uninstall runs `agent-browser service stop --all`, which stops
  Chrome and Xvfb of the profile, as `stop_unit.py` does today. Then it removes the unit.
- **The live tests**: agentwatch's live tests that build on `daemon/browser/`
  (`tests/live/browser_test_unit.py`, `browser_test_control.sh`, `test_browser_live.py`,
  `test_browser_agent_mode_live.py`, `test_browser_pin_live.py`) get their replacement before stage 6:
  - agent-browser's live suite starts its own service with `--test` in a temp state folder (its own Xvfb,
    Chromium and agent package, under the harness guard) and drives that service's control door. `--test`
    refuses the default state folder and the operator's profile, so the operator's service never admits
    such a client;
  - agentwatch keeps live tests of its own control door client, in its suite mode, against such a test
    service;
  - stage 6 deletes the old files only after the new ones pass on taylor.

### 7.4 The browser code that goes away or moves, by file

Under the operator's decision ("all the browser code to move into the browser"), every piece of browser
logic leaves agentwatch. What stays is the UI, identity, transport and install of section 7.2.

| File (lines) | Where its logic goes |
| --- | --- |
| `daemon/browser/allowlist.py` (62) | Moves: the service reads the old single list read-only, to show it (section 7.5; Decision 4). |
| `daemon/browser/bridge.py` (721) | Goes away as a hop: the carrier's rules (waits, parts, joins, in-flight bytes, `end_scope`, `daemon.*` routing) move into the service's link. |
| `daemon/browser/chrome_args.py` (32) | Goes away: agent-browser's `assertSafeChromeArgs` is the one check. |
| `daemon/browser/crx.py` (234) | Moves: the CRX checks, its staging, the external extensions file. |
| `daemon/browser/ext_id.py` (42) | Moves. |
| `daemon/browser/host_files.py` (76) | Moves: the service writes the host manifest and the shim's wrapper. |
| `daemon/browser/link.py` (552) | Moves: the link socket, the peer check of the host's parent, the channels. |
| `daemon/browser/lists.py` (185) | Moves: the list files stay where they are (section 7.5); agentwatch keeps the pane's editor only. |
| `daemon/browser/native_host.py` (288) | Moves: it becomes the host shim, `agent-browser host`. |
| `daemon/browser/panes.py` (93) | Moves to `agentwatch/daemon/panes.py` in stage 2: it reads session facts (pane pid, start time, cgroup) that the sessions, the memory guard, cgroup accounting and the remote MCP socket use. Stage 6 deletes `daemon/browser/`. |
| `daemon/browser/parts.py` (48) | Moves. |
| `daemon/browser/paths.py` (81) | Moves: the unit's paths become the service's. |
| `daemon/browser/payload.py` (381) | Moves: the C2 check and the box-host rule, with the hosts and cookie names that agentwatch gives. |
| `daemon/browser/pointer.py` (407) | Moves: `xdotool` in the service. |
| `daemon/browser/relay.py` (390) | Goes away: no relay child process. |
| `daemon/browser/scopes.py` (442) | Moves: `ScopeBook`, the ended file, the roots line. |
| `daemon/browser/service.py` (3,143) | Splits. Stays: a small client of the control door; the session feed as `set_sessions` and `session_ended`; `pane_counts`. Moves: the boot, the receiver watch and the fail-closed stop, the push of `set_scopes`, the unit control, the Chrome move and probation, the relay control, the endpoint state, `launch_refusal` (as `launch_check`), the status texts (`_status_for`, the I2 rule), `send_text` and the `SEND_*` texts. |
| `daemon/browser/stop_unit.py` (275) | Goes away: `agent-browser service stop --all` does it. |
| `daemon/browser/unit.py` (1,447) | Moves. |
| `daemon/browser/updates.py` (459) | Moves. |
| `daemon/browser/versions.py` (44) | Moves. |
| `daemon/browser/xauth.py` (34) | Moves. |
| `gateway/browser_prompts.py` | Moves: the list of a blocked host, the cover check, the broad-provider and shared-host warnings (`SIGN_IN_HOSTS`), the dismissals. The gateway keeps the page and the Web Push (`gateway/browser_events.py`). |
| `browser_prompt_rules.py`, `browser_hosts.py` (`normalize_entry`, `covers`), `browser_lists.py` (the scope pattern, the list names) | Move: the service is the one checker of hosts, lists and scopes; the pane shows its answers. |
| `commands/browser.py` (1,023) | Shrinks to the thin wrapper of section 7.2. The list copy `session-lists/<scope>/allowlist.json` moves to the service. The refusals of agent-browser's internal commands (`proxy`, `relay`, `give-back-watch`) and flags (`--cdp-url`, `--tab-scope`, `--socket`, `--chrome-pid`, `--watch-back-command`) move into agent-browser: its CLI refuses them itself when it runs against the service. |
| `server/routes/browser.py` (751) | Becomes a pass-through, with the operator field of R7. |
| `tools/google_chrome.py` (915) and the Google signing key file | Move. |
| `tools/pins.py` | Keeps only `AGENT_BROWSER_COMMIT`: the receiver, sender, CRX, host name and Google pins move to agent-browser. |
| `runtime_paths.browser_socket_path`, `browser_cdp_socket_path` | Go after stage 6; until then the daemon gives the endpoint path (section 13). |
| The config keys `browser.enabled`, `browser.control`, `browser.chrome_bin`, `browser.chrome_args` and the other `browser.*` keys | Stay in agentwatch's config file, the operator's one place; the daemon passes them as data in `config` (section 7.1). |
| The memory guard's `browser_pid` (`daemon/main.py`) | Reads Chrome's pid from the service's events and status, off its tick; it keeps its last pid when the service is down or slow (section 7.3). |
| The live tests of section 7.3 | Replaced before stage 6. |

### 7.5 The lists, their path, and the rollback

- **The path**: today's folder, `CONFIG_DIR/browser/lists/<list>.json`, `{"allow":[...],"repo":...}`. The
  unit gives the path to the service. No copy and no migration of the files.
- **One writer**: the owner of the Chrome unit (section 13.2) writes the lists, the ended scopes and the
  list copies: the daemon while the service's unit is inactive or failed, the service while its unit is
  active. The other one does not write them.
- **The rollback keeps every list** (the daemon lead's R6): a list change made while the switch is on is in
  the same file. At a switch-off the daemon reads the list files and the ended scopes file again from disk,
  never a copy in memory from before the switch-on (section 13.2). No copy back is needed.
- **During a change of owner**: while the daemon waits for the service's unit to become active or inactive
  (at most 30 s), it holds list changes, prompt answers, session ends and launch checks, gives them to the
  owner, and refuses a held operator act after 30 s (section 13.2).
- **The old single list** (Decision 4): `CONFIG_DIR/browser/allowlist.json` stays read only. Nothing
  copies it, and no scope uses it. The service reads it only to show it in the pane, as today ("The old
  single list (agents no longer use it)"). The first draft of this design copied it into a list; that
  reversed Decision 4, and this version removes it.
- A later move of the list files into agent-browser's own folder is not in this design. It would need a
  one-time move with its own rollback.

## 8. Clients (task item 4)

### 8.1 The CLI and Playwright

- The CLI: `agent-browser <command> --cdp-url <url>`, or `agentwatch browser <command>`, as today.
- Playwright: `chromium.connectOverCDP("ws+unix://<agent door>:/devtools/browser/<scope>")`, then
  `browser.contexts()[0]`, as today. `agent-browser endpoint` (and `agentwatch browser endpoint`) prints the
  URL for the calling session. Every C11 rule stays: the `Origin` 403, the 404, the peer check, the
  readiness 503s, the refusals.

### 8.2 The MCP inside the service (M3)

M3 ran `@playwright/mcp` 0.0.85 (`playwright-core` 1.66.0-alpha-2026-11-09) from code in the probe's own
process. `createConnection({browser: {cdpEndpoint}})` took 14 ms for the first MCP session and
4 to 7 ms for the next ones. The endpoint was a `ws+unix://` socket in front of the probe's own Chromium
(its `--remote-debugging-pipe`; no port). The MCP served its usual tools over HTTP on a Unix socket at
`/mcp/<scope>`:

| Call | A: plain HTTP (`curl --unix-socket`), the MCP SDK's transport | B: the stdio shim | C: the probe's own transport, no SDK |
| --- | --- | --- | --- |
| `initialize` | 200, 55 ms, a session id | 104 ms | 200, 20 ms |
| `tools/list` | 25 tools, 28 ms | 25 tools, 15 ms | 24 tools (no `browser_run_code_unsafe`), 19 ms |
| `browser_navigate` to `a.localhost` | the page's title in the answer, 447 ms; 10 more: 89 ms to 111 ms | the title, 386 ms | the title, 387 ms |
| `browser_snapshot` | the page's heading, 29 ms | the button's ref, 14 ms | |
| `browser_click` on the snapshot's button | | no error, 617 ms (its answer holds no snapshot, so the probe did not read the page's change) | |
| `browser_run_code_unsafe` | | | refused by the transport: "Not available in the agent browser: browser_run_code_unsafe" |
| A request with an `Origin` header | 403 | | 403 |
| An unknown session; the session's `DELETE` | 404; 200 | | the `DELETE`: 200 |

The probe's process held the MCP server objects and the loaded `playwright-core`: 150 MiB at the start (after
the packages loaded), 182 MiB at the end. The stdio shim used 62.7 MiB (Node).

M3's endpoint is a plain bridge to Chromium, not the relay's model. The MCP's tools against the model were
measured before, in two places:

- the two-modes probe: 13 MCP calls and two checks of what the site saw, 15 of 15;
- the live runs of 2026-11-05: the Playwright MCP passed the peer check and drove pages with one window
  per page.

Inside the service the MCP is the same CDP client.

How the service runs it:

- The service makes one Playwright MCP server object for each MCP session, with `createConnection(config)`
  from `@playwright/mcp`'s public entry. The configuration is fixed:
  - the scope's CDP endpoint, and the default context (no isolated context: the model refuses a new
    context anyway);
  - the capabilities named explicitly, never the MCP's default set: the ones that give the allow list's
    tools for the pinned version (below), and never `core-install`, `storage`, `devtools`, `testing` or
    `config`;
  - `allowUnrestrictedFileAccess: false`, and an output folder for each scope, in the state folder.
- **The ticket** (C3): the MCP's Playwright connects back to the agent door with the MCP session's scope,
  on a path with a one-time ticket. The agent door takes the ticket only from a connection whose peer is
  the service's own pid, and the ticket never leaves the process. So it is no bearer secret in C3's sense:
  no other process can use it. Every refusal of the model and the scope of the peer check apply to that
  connection. The control door refuses the service's own pid.
- **An allow list of tools and argument keys** (for each pinned MCP version), not a deny list:
  - a file in agent-browser names each allowed tool, each allowed argument key, and each key that names a
    file or a path (for example `filename`, the paths of `browser_file_upload`);
  - the service's transport drops every other tool from `tools/list`, and refuses a `tools/call` of a tool
    or with an argument key that the list does not name, before the call reaches the MCP code;
  - the first list holds the 24 tools of M3's part C. It leaves out `browser_run_code_unsafe`, which runs a
    client's JavaScript in the MCP server's process. Its own description says: "Unsafe: executes arbitrary
    JavaScript in the Playwright server process and is RCE-equivalent." Inside the service that process
    holds the lists, the native link and the control door's state. M3's part C refused it in this way. Its
    tool set is `core`, so a capability setting cannot turn it off alone;
  - a test in `npm test` (no browser: `initialize` and `tools/list` need no CDP connection, as M3's dry run
    showed) compares the pinned version's `tools/list`, names and input schemas, with the list file. Any
    change fails the test, so each pin bump of `@playwright/mcp` needs a new review of the list. The test
    also fails when a string argument whose schema speaks of a file or a path is not marked as a path key.
- **Files.** The tools that act on a page go through Playwright and the model. A tool argument that names
  a file acts in the service's process, on the service's disk, outside every limit that confines a
  session today. The MCP's own guardrail (`allowUnrestrictedFileAccess: false`) depends on the client's
  MCP roots, and the service's JSON-only transport cannot carry the server's `roots/list` request to the
  client. So for every scope, local or remote, the service refuses each argument that the allow list
  marks as a path when the path is outside that scope's own folder, `<state>/mcp/<scope>/` (after
  `realpath`, so no link leaves the folder). A local agent copies a file into that folder before an
  upload, and finds a saved file there; `agent-browser mcp --folder` prints the folder for the calling
  session. For a remote scope the service refuses every path argument (section 9). A later build can carry
  the client's roots through the shim and measure them; this design does not rely on them.
- **A memory bound for each scope** (C9): the MCP code of each scope runs in one worker thread of the
  service, with a heap limit (`resourceLimits`; first value 512 MiB). A worker that passes it ends, with
  its MCP sessions: their clients get an error and can start a new session. The model, Chrome and the
  other scopes go on. At most 4 MCP sessions for each scope and 32 for each service (first values). The
  memory of a worker is not measured; the build measures it and sets the values. The daemon's memory
  guard no longer caps one session's MCP alone, because the MCP is no longer in the session's cgroup.
- **The transport** is a small Streamable HTTP transport of the service's own on the agent door, at
  `/mcp/<scope>`. The MCP server object needs only `start`, `send` and `close` from a transport, and M3's
  part C ran `initialize`, `tools/list` and `browser_navigate` through such a transport with no MCP SDK
  package. With Q1 a the service serves only its own shims and the agentwatch link, so it controls both
  ends, and JSON answers are enough. The MCP SDK's own transport also worked (part A), but its package
  brings 17 direct dependencies (among them `express`, `hono`, `ajv`, `zod`, `jose` and `cross-spawn`;
  96 packages in the probe's install). The service answers a request with an `Origin` header with the 403
  (M3), as C11 does for CDP.
- **The packages.** The build adds `@playwright/mcp`, `playwright` and `playwright-core` to agent-browser's
  dependencies (19 MB; the probe's install added these three packages and no other). Each is pinned
  exactly and vetted as the README's supply-chain section says. Today the package has two runtime
  dependencies. Q4 asks the operator about these packages. Its other option keeps the MCP in the service
  too, with a tool set of agent-browser's own over the model and no new package.

### 8.3 The MCP transport: a Unix socket with a stdio shim, or loopback TCP

The operator asked for HTTP. Claude Code (`claude mcp add --transport http <name> <url>`) and Codex
(`codex mcp add <name> --url <url>`) take an HTTP MCP by URL. Neither help text names a Unix-socket URL.
So a local client reaches HTTP on a Unix socket only through a stdio shim, or the service must open a
loopback TCP port. M2 measured the peer check over loopback TCP.

M2 ran on taylor (Linux 6.12.115, Node 26.12.0), with no browser and only the probe's own processes. At
each connection the server does these steps:

1. It finds the client's own socket in `/proc/net/tcp` by its port.
2. It refuses another uid, before any other step.
3. It finds the processes that hold the socket's inode, in `/proc/<pid>/fd`.
4. It walks each holder to a root.
5. It reads the client's line again.

| Case | Decision |
| --- | --- |
| A client under the scope's root | admitted |
| A client under another session's root, or under no root | refused |
| A client that forks after the connect (both hold the socket) | admitted: 2 holders, both under the root |
| A client that writes its request and exits at once | refused, 50 of 50: no process holds the socket at the accept |
| A client of another OS user | not run; refused by the uid column before any scan; another user's `/proc/<pid>/fd` cannot be read (M2 met 393 such processes in each scan) |

| Cost per new connection (200 each) | p50 | p99 | max |
| --- | --- | --- | --- |
| TCP, scan of the claimed session's cgroup (23 processes) | 10.4 ms | 17.0 ms | 17.4 ms |
| TCP, scan of every process that can be read (91 processes, 1,316 fds) | 23.1 ms | 34.3 ms | 38.7 ms |
| Unix socket, `SO_PEERCRED` and a pidfd (today's check) | 0.02 ms | 0.10 ms | 0.14 ms |

The two reads of `/proc/net/tcp` cost 7 to 8 ms of each TCP check. Their cost grows with the box's
connections: the file had 44 lines at rest and up to 443 during the runs (the probe's own connections in
`TIME_WAIT`). The check runs once for each connection. An HTTP client that keeps its connection open
pays it once.

| | a. HTTP on the agent door (Unix socket), a stdio shim for local clients | b. HTTP on a loopback TCP port |
| --- | --- | --- |
| The peer check | The kernel's: `SO_PEERCRED` and a pidfd on Linux, `LOCAL_PEERPID` on the Mac; the process that connected; 0.02 ms (M2) | Linux: the client's socket in `/proc/net/tcp`, its uid, the holders of its inode, the walk: 10.4 ms p50 (cgroup scan) to 23.1 ms p50 (every process); the Mac: no `/proc`, a `libproc` scan of every process's sockets or `lsof` (not measured: pending, a Mac run through the manager) |
| Which process | The connecter, also after a fork (the peer admission design) | Each process that holds the socket at the check; a forked child counts too (M2: 2 holders) |
| Another OS user | Cannot connect: the socket is 0600 in a 0700 folder | Can connect; the uid column refuses it before any scan (the daemon lead's rule); its `/proc/<pid>/fd` cannot be read either (M2: 393 such processes per scan) |
| Who serves | Only a process of the user can make the socket, in the user's 0700 run folder; no other user can | Any local user can listen on the port while the service is down (taylor has three human users). The client then sends its tool calls (page text, typed text) to that program. A client cannot tell. |
| A web page | Cannot open a Unix socket | Can send requests to the port; the `Origin` 403 and the walk (Chrome is no session's process) refuse them |
| The URL in a session's MCP configuration | None: `{"command":"agent-browser","args":["mcp"]}` | `http://127.0.0.1:<port>/mcp/<scope>` |
| A process per session | The shim (62.7 MiB, no Playwright) | None |
| The Mac | The same | A new reader, pending |

**Recommendation: a.** The agent door stays a Unix socket for CDP and MCP. A local session's MCP is the
stdio shim `agent-browser mcp`. It holds no MCP logic: it posts each JSON-RPC line to `/mcp` on the agent
door and writes each answer line (M3: the same calls through the shim). The service takes the scope from the
walk of the shim's process: the first root that the walk reaches names the scope, and a walk that reaches no
root gets the session's 403 (the peer admission design's "path with no scope", section 7). So one MCP
configuration serves every session. The kernel check holds on both systems. A session on another box uses
HTTP over the agentwatch link (section 9). This keeps the daemon lead's C3 and the operator's HTTP. HTTP is
the MCP's transport inside the service and across boxes. Only the last step, inside the session, is stdio.
Option b stays a later option for Linux, behind a setting, if a client must have a URL (Q1).

### 8.4 The fallbacks

- **stdio**: today's Playwright MCP keeps working as a stdio child of the session, with `--cdp-endpoint`
  (the URL of `agent-browser endpoint`). It is a CDP client of the agent door, and the walk admits it.
- **A key per session**: not needed. The peer check holds on the Unix socket, and the operator rejected
  keys (ab-dm6).

### 8.5 How a session gets the MCP

The operator's answer age-4ks ("env: no") keeps the endpoint out of a session's environment by default.
With the shim, the MCP configuration holds no URL, no scope and no secret, so the same line works for
every session: `{"command":"agent-browser","args":["mcp"]}` (or `agentwatch browser mcp`, a wrapper). What
the operator must decide (Q2) is whether agentwatch adds that line to the sessions it launches. Each
session that has it loads the MCP's tool list into its context, also when it never uses the browser.

## 9. Another box (task item 5)

A session on taylor uses the agent browser on the operator's Mac. The Mac opens no port.

```
 taylor                                                        the operator's Mac
 session --stdio--> agentwatch browser mcp --box <mac>         Mac agentwatch daemon --agent door, MCP path only--> Mac service --> host shim --> Chrome
                    (a child of the session)                     ^ checks: the link's machine key, the seal,
                         | the daemon's new remote MCP socket    |   the browser grant, the Mac rules (consent,
                         | (0600; kernel peer check, pane walk)  |   quiet times), the answer size, the rate
                         v                                       |
                    taylor agentwatch daemon ----agentwatch link (sealed MCP HTTP requests)----+
```

**taylor.** The session's MCP configuration names `agentwatch browser mcp --box <mac>`, a stdio shim of
agentwatch's. Today agentwatch has no socket from an agent to its daemon. The CLI talks to the gateway over HTTPS with
the API token. The daemon's sockets are the gateway hub, the browser link and the screen link (the daemon
lead's R5). So the remote path needs a new daemon socket:

- a 0600 Unix socket in the daemon's 0700 run folder, for the remote MCP only;
- at each accept, a kernel peer check (`SO_PEERCRED` and a pidfd on Linux, `LOCAL_PEERPID` on the Mac)
  and the walk to a session's pane root. The walk is new Python code in agentwatch, in stage 5 (the
  daemon lead's m3): today's walk is in agent-browser (`src/relay/peer.ts`) and moves with the service,
  and `panes.py` holds only the facts (pane pid, start time, cgroup). It follows the same rules: pid and
  start time to a pane root, the pane's cgroup only when the walk reaches no root, a peer that is alive
  through the check. Its tests are the same cases as the peer admission design's and M2's: a client in
  the session, a client of another session, a client of no session, a forked holder, a client that exits
  at once, a re-parented job. A peer whose walk reaches no session is refused;
- the daemon then knows the session's name, and it sends each MCP request over the agentwatch link with
  that name. No browser logic runs on taylor for this path.

**The link.**

- The machine keys, and a new grant, `browser.use`, that a box asks for (`agentwatch link request`) and
  that the operator approves on the Mac's Links page (password login). Today the link has no browser grant
  (`agentwatch/linkmail/grants.py`).
- Each request and each answer travels sealed, as the link's seal rule says for every link message.
- A size limit for each MCP answer (first value 16 MiB). An inline screenshot or a large snapshot can be
  large. Above the limit, the Mac's daemon sends a clear refusal ("the answer is larger than the link's
  limit; ask for a smaller part, for example one element's snapshot or a viewport screenshot"), not a cut
  answer.
- A rate limit for each remote session (first values: 10 requests a second, 4 at once). Above it, the Mac's
  daemon answers with a clear refusal and drops nothing silently.

**The Mac's daemon.** It checks the link, the seal and the grant, applies the Mac rules (below), and lists
each remote session in its `set_sessions` as `{"scope":"taylor/<session>","box":"taylor","list":<the
grant's list>}`. It connects to the Mac service's agent door for that scope and carries the bytes.

**The Mac's service.**

- It identifies the Mac's daemon on the agent door with the same rule as on the control door (section 7.1:
  the launchd job's pid, or its direct child with the daemon's command line).
- It admits the daemon only for a remote scope that the last `set_sessions` lists, and only on the MCP
  path. It refuses the CDP path for a remote scope. Raw CDP across boxes is not in this design: one tool
  call runs many CDP calls next to Chrome, so the link carries one request and one answer for each step.
- A local scope always needs a local walk; the daemon never gets a local scope.
- The remote scope gets the grant's list, never a local repo's list.
- It refuses every tool argument that the allow list marks as a path (section 8.2). Examples are the
  paths of `browser_file_upload` and the `filename` arguments of the snapshot, screenshot and network
  tools. Else a remote session could send a file of the Mac to a site. Tools that return their data inline
  work. A new pin of the MCP cannot add a path argument without the list's test failing first.
- The model refuses a navigation to a `file:` URL (`src/relay/policy.ts`), so a remote scope cannot read
  a file of the Mac through a URL either.
- A download of a remote scope stays on the Mac, in that scope's folder of the state folder. No tool of a
  remote scope reads it, and the service removes the folder at the scope's end.

**The scope name**: `<box>/<session>`, for example `taylor/web-1`. A local scope has no `/`, so a remote
scope never meets a local one. The scope pattern of C4 and C11 gains one optional `<box>/` part (a small
change in the receiver's `agent/scopes.js` and the model's `SCOPE`).

**The Mac's allowlist**: the operator fills the grant's list on the Mac's Browser pane. A remote session
cannot change it: no door for it.

**The Mac rules**:

- the operator's consent: the grant, which the operator can revoke at any time on the Links page;
- the quiet times of the Mac: in a quiet window the Mac's daemon refuses a remote session's new MCP
  session, with a clear text. At the start of a quiet window, an open remote MCP session may finish the
  request that it runs; then the Mac's daemon ends that session with the text "the Mac's quiet time
  began; try again after <time>";
- no window focus taken: the Mac service's rules of section 10.

| Part | Whose |
| --- | --- |
| The session's identity on taylor and the new remote MCP socket, the stdio shim to it, the link, the seal, the machine keys, the grant and its approval, the answer size and rate limits, the Mac rules, the remote session in `set_sessions` | agentwatch |
| The remote scope in the model, the grant's list in the Mac service, the MCP, the agent door's rules for remote scopes (the daemon's identity, the MCP path only, no path arguments), the remote downloads, the Mac's Chrome rules | agent-browser |
| The scope pattern with `<box>/` | chrome-extension (receiver) and agent-browser |

## 10. The Mac (task item 6)

The same service runs on the Mac as a launchd agent that agentwatch installs. It folds in what ab-v16.8
needs:

- **The agent Chrome**: the operator's own `Google Chrome.app`, started a second time with its own profile
  (`--user-data-dir`, ab-9hj), through `open -n -g`, with `--disable-backgrounding-occluded-windows`. Two
  Dock icons and two Cmd-Tab entries (measured 2026-11-03). The service never writes the default user-data
  folders or the all-users external extensions folder.
- **No focus taken**: the give-back at the start (`src/giveback.ts`) and the give-back watcher for as long
  as the agent Chrome runs (`src/watchback.ts`); on the Mac the model keeps tabs (no window comes forward
  for input), as today.
- **The version**: a new instance starts at the version on disk. The service restarts the agent instance
  when the operator's Chrome changes version (the Chrome comparison, section 7). No update of its own.
- **The install of the agent package**: "Load unpacked" by the operator, once per agent profile, until the
  operator chooses a store item or an MDM policy (the choice waits for the Mac stage, as the two-modes
  design says). The service writes the host manifest into the agent profile's `NativeMessagingHosts/`
  folder.
- **No Xvfb and no X pointer**: the model sends no pointer path on the Mac.
- **The peer check**: `LOCAL_PEERPID` and `proc_pidinfo` (built, not run yet: ab-v16.52). The stdio shim
  keeps the kernel check on the Mac with no port.
- **Open checks on the Mac** (through the manager, with the operator):
  - the host shim's start from the agent profile's folder in branded Chrome;
  - the sleep and wake of `chrome.debugger` and the native port (the agentwatch design's Mac check 4);
  - the peer reader;
  - the shim's `connectNative` after a relaunch;
  - a TCP peer reader, only if the operator picks Q1 b or c.

## 11. Security (task item 7)

Every rule of today holds. The table names where each rule lives after the change.

| Rule | Today | After |
| --- | --- | --- |
| Per-scope allowlists that only the operator edits | lists in agentwatch's config folder, edited in the web viewer (password login), pushed by the daemon | the same files in the same folder (section 7.5), changed only by `list_set` and `prompt_allow` on the control door with `by.kind: operator`, which the daemon sets only from the gateway's password-login field (R7); no op on the agent door or in the MCP changes a list |
| The lists' enforcement | the receiver's DNR rules, guard and sweep; the relay's navigation refusal (layer 1) | the same: the receiver, and the model in the service |
| The peer check (the scope is the session's) | the relay (`src/relay/peer.ts`), roots from the daemon's `allowlist` line | the same code in the service, roots from `set_sessions`; the MCP shim and the MCP's own connection under the same check (section 8.2) |
| Who may use the control door | the daemon's ops come from the gateway; the daemon's sockets take no agent | only the agentwatch daemon process itself, by pid, parent, command line and start time, read at each accept (section 7.1, R1); never a process of agentwatch's cgroup only, never the service's own pid, never an agent-browser CLI command |
| No cookie calls; cookie headers masked | the relay's model | the model in the service; the MCP's page tools reach the browser only through the model |
| The refused page marks (main-world init scripts and bindings) | the model | the model |
| The world refusal (the relay's own isolated world) | the model | the model |
| No prompt, no remote-debugging port | the daemon's flags and `chrome_args.py`; agent-browser's `assertSafeChromeArgs` | `assertSafeChromeArgs` in the service, on every Chrome start |
| The operator's own Chrome is never reachable | the operator package has no `debugger`; the host manifest only in the agent profile; the host checks its parent's profile; the daemon checks the host's parent is the unit's Chrome | the same package rule; the owner of the Chrome unit writes the manifest only in its agent profile; the shim checks its parent's profile; the service checks that the shim's parent is its own Chrome, by pid and start time (M1); on the Mac the service never writes the default folders |
| Fail closed: no confirmed receiver, Chrome stops after 60 s; no scope object before the first complete read of the sessions | the daemon (`check_receiver`, `_fail_closed`) | the owner of the Chrome unit only (section 13.2: the service's unit state); the daemon's watch reads the unit state again right before it stops Chrome; the `stopped` event to the daemon and the last stop in `status` |
| Start and stop | the API token or a web login (#643 open) | unchanged during the move; each op names its caller's kind; Q5 asks about a change |
| A web page cannot connect | the `Origin` 403 of the endpoint | the same on CDP and MCP paths (M3); a Unix socket is out of a web page's reach |
| Secrets | no secret in argv or a log; payloads in memory | the same; the service gets a payload on the control door and keeps it in memory only; logs carry a user, a domain and counts; the MCP's one-time ticket never leaves the service's process |
| The extension signing key | agentwatch keeps the private key (0600) and pins the CRX | the service never holds the key: it checks the CRX against the pinned hash; the key stays where the release flow keeps it |
| The box's own sign-in never moves | `payload.py` (box hosts, `BOX_COOKIE_NAMES`) | the service, with the hosts and cookie names that agentwatch gives in `set_sessions` |
| No raw X for an agent | only the daemon runs `xdotool`, only for the relay's checked paths | only the service runs `xdotool`, only for its own model's paths |
| No client code in the browser's process | the relay runs no client code; a session's Playwright MCP runs in the session's own process | the MCP's allow list of tools and argument keys for each pinned version (section 8.2): no `browser_run_code_unsafe`, a test that fails at any change of the pinned `tools/list`, explicit capabilities |
| A remote session | no path | the agentwatch link with sealed requests and a browser grant that the operator approves on the Mac; a kernel peer check on taylor's new socket; the grant's list; the MCP path only; no tool argument that names a file on the Mac; an answer size limit and a rate limit; no port on the Mac |

The limit stays as today: the check stops mistakes, an agent that names another session's scope, and an
injected instruction. It does not stop a hostile process of the same OS user (the peer admission design,
section 11).

## 12. The daemon lead's constraints

| Constraint | How the design keeps it |
| --- | --- |
| C1. Per user, never root; the gateway reads no user file | One service per OS user; the gateway passes requests to the user's daemon, which passes them to the user's service. The sender ID comes from the service through the daemon, not from a file. |
| C2. Operator-only acts only through a control door, provenance from the credential | Section 7.1: only the daemon process itself on the control door (R1); `by.kind: operator` only from the gateway's password-login field (R7); no such op on the agent door or in the MCP. Start and stop keep today's rule until the operator answers Q5. |
| C3. The scope binding stays kernel-checked; no open TCP port, no bearer secret | The agent door is a Unix socket with the peer check; the MCP's local path is the stdio shim (Q1 a); the MCP's own ticket is bound to the service's pid and never leaves the process; cross-box through the link and a new kernel-checked daemon socket. Loopback TCP only if the operator picks Q1 b, with the M2 check and its limits. |
| C4. Fail closed; the daemon sees the stop | Section 11; the `stopped` event, and the last stop in `status` for a daemon that was down. |
| C5. Chrome survives restarts; the service has its own lifetime and adopts a running Chrome | Sections 5.2, 7.3 and 13.2: one owner of the Chrome unit, named by the state of the service's unit (`KillMode=process`, so a stop or crash of the service keeps Chrome); a daemon restart and a service restart keep Chrome in both modes (tested in stage 2). |
| C6. Secrets | Section 11. |
| C7. The version pin, a hello with features | Sections 7.1 and 7.3: the hello; a pin change restarts the service's unit, which adopts Chrome; one agentwatch release carries both paths during the whole move. |
| C8. One event stream | Section 7.1. |
| C9. The memory guard's cgroups | Section 5.2: the service's own unit and cgroup, outside agentwatch's and the session scopes; section 8.2: a heap limit for the MCP of each scope. |
| C10. Hermetic tests; the uninstall removes the service | Section 7.3: `--fake`, `stop --all`, the unit's removal, the replacement of the live tests. |

## 13. The move from today (task item 8)

Each stage is a branch, a pull request with its own tests and a fresh review, and a pin bump in
agentwatch. No stage changes how the operator uses the browser without the operator's approval (Tier 2 of
agentwatch's `SECURITY.md`). Each stage is live-checked on taylor first.

### 13.1 The stages

| Stage | Repository | What | Tests | Rollback |
| --- | --- | --- | --- | --- |
| 0. Contracts | chrome-extension (`docs/protocol.md`), agent-browser | C1, C4 and C10 texts of section 6, the C4 and C10 parts marked "from stage 3"; C11's master text moves to agent-browser; C12 (the control door) and the format of the MCP's allow list in agent-browser | the vectors (`test/vectors/`) gain the control door's lines | a text revert |
| 1. The service, off by default | agent-browser | `agent-browser service`: both doors with the admission of section 7.1, the hello, the host shim, the model in-process, the Chrome unit, which the service runs only while its unit is active (section 13.2), with the end of the old owner's host, `--hello`, and a host shim that tries its socket again every second, Xvfb, the pointer, the lists in today's files, the prompts, the status texts (I2), `launch_check`, `sender`, `endpoint`, the import, the events, the MCP with its allow list and its worker limits; the CLI's refusals of the internal commands and flags; `--fake`, `--test`, `stop --all` | unit tests with fakes (the model's tests stay); the allow-list test; the control door's admission (the MainPID, its child with the daemon's command line and the parent's start time, a process of agentwatch's cgroup refused, a child of the daemon refused, a new pid after a restart, a failed systemd query refused); a live test in the harness with `--test` (its own Xvfb, its own Chromium with the real agent package, no stand-in daemon); a start, a crash and a stop of the service under a test systemd unit, with Chrome kept and a stand-in daemon host ended | nothing uses it yet |
| 2. The client in agentwatch, off by default | agentwatch (the daemon lead) | the control door client behind the hello's features; `config`, `set_sessions`, `launch_check`; the gateway's operator field (R7); the switch, a config key per box (`browser.service`, default off), with section 13.2's steps; `panes.py` to `agentwatch/daemon/`; the unit file (only while `browser.enabled` is true; `KillMode=process`, `Restart=on-failure`, the start limit, `Before` and `After`), the daemon's reads of the unit state, its health rule for a hung service, restart at a pin change, and its `agentwatch health` line; the memory guard's pid from the service; the update and rollback commands' refusal of a release from before stage 2 while the switch is on; the old path stays the default and unchanged | `make check` with `--fake`, in both unit states (no owner part of the daemon starts while the unit is active; a slow `launch_check`); the live suite with the test browser on taylor: every case of section 13.2's test list, a daemon restart in each mode keeps Chrome, and a pin change | the switch off; then, for the code, the previous agentwatch release with the service's unit removed (the update command switches off first, section 13.2 rule 6) |
| 3. Switch taylor | agentwatch config, with the operator's approval | the switch on for the operator's agent browser on taylor; the service listens at today's endpoint path, which the daemon gives | the live check: Chrome's pid stays, every session's endpoint works, a sign-in send works, a blocked prompt reaches the pane, start and stop behave as today | the switch off (stage 2's tested steps) |
| 4. The Mac | agent-browser, agentwatch | the Mac paths of section 10 (ab-v16.8, age-0kh.23 go straight to the service); the control door's admission for the launchd job | the Mac checks of section 10, through the manager with the operator | the Mac stays without agent mode |
| 5. Another box | agentwatch (the grant, the remote MCP socket and its new Python walk, the seal, the limits, the quiet times), agent-browser (remote scopes: the daemon's identity, the MCP path only, no path arguments), chrome-extension (the scope pattern) | section 9 | the Python walk's unit tests with the cases of M2 and the peer admission design; a two-box live check (taylor to the Mac), with the operator | the grant revoked |
| 6. Cleanup | agentwatch | delete `daemon/browser/` and the browser parts of section 7.4, after both boxes ran on the service for a while and the new live tests pass; the endpoint path becomes the service's own (agentwatch asks `endpoint`) | `make check`; the new live tests | the pin before the cleanup |

### 13.2 One owner of the Chrome unit: the service's unit state decides

**The owner's parts.** Only the owner runs these parts:

- the start and adoption of Chrome and Xvfb, the 5 s supervisor, the fail-closed watch (60 s), the Chrome
  updater and its move, and the boot sweep of orphans (`stop_orphans`);
- the host manifest, the native link's socket, and the endpoint (the relay, or the agent door);
- the writes of the lists, the ended scopes, the list copies and the unit record (section 7.5).

**The rule.** The state of the service's own unit decides who owns, and only systemd (launchd on the Mac)
changes that state:

- **The service owns while its unit is `active`, `activating` (also between automatic restarts) or
  `deactivating`.** The service runs only while it owns: it is never a passive process. At its start it
  adopts Chrome and Xvfb from the unit record (or starts them), writes its shim's path into the host
  manifest, ends every host process among Chrome's children whose command line is not its own shim's,
  opens its link socket and its agent door, and starts its supervisor, its updater and its watch with a
  new 60 s count.
- **The daemon owns while the service's unit is `inactive` or `failed`** (no restart pending), with no job
  queued for the unit (`systemctl --user list-jobs`): a restart of the unit (a pin change, or the operator's
  `systemctl --user restart`) is one job of systemd from its first moment to its end, so the daemon never
  takes the short gap of a restart. An automatic restart keeps the unit `activating` (sub-state
  `auto-restart`). It reads the unit state at its start, at each 5 s tick, and right before each owner part:
  before it starts a part, before a Chrome move, and before its watch stops Chrome. When it finds the unit
  active, it stops its owner parts at once. When it finds the unit inactive or failed, it adopts Chrome and
  Xvfb, writes its own host path into the manifest, ends every host process among Chrome's children whose
  command line is not its own host's, and starts its parts with a new 60 s count. A failed service unit
  counts as inactive, so one side always acts. While the daemon itself runs the steps of a switch-on or a
  switch-off, its tick does not act on the state; the steps do.
- **When the daemon starts a switch-on by itself.** The daemon starts the switch-on when the switch is on
  and the unit is `inactive`, for example after a daemon crash before step 3. It does not start it when
  the unit is `failed`: then it owns, and it waits for the operator (note 7).
- **A host retries; the new owner ends the old host.** The daemon's host and the service's shim both try
  their socket again every second while Chrome's port is open (today's host does so). A host never exits
  by itself, so a restart of its owner does not close the receiver's port. At a change of owner, the new
  owner ends the old owner's host after it wrote its manifest. The receiver's port closes, the receiver
  connects again after 1 s, and Chrome reads the new manifest (M1: the link was back in 1,065 ms, with the
  same Chrome). So the receiver reaches the new owner well before the new owner's 60 s watch ends, also
  when the old owner is down.
- **Chrome survives each change.** The service's unit has `KillMode=process`, as agentwatch's own unit:
  a stop or a crash of the service ends only its main process. Chrome, Xvfb and the hosts (Chrome's
  children) stay.
- **The endpoint socket.** During the move both owners serve the same endpoint path. Each side removes
  that socket at its stop only when the socket's inode is the one that it made, as today's relay does
  (`src/relay/endpoint.ts`), so it never removes the other owner's new socket.
- **The unit's settings bound a failure.** `Restart=on-failure` with a short delay, and a start limit
  (first values: 3 starts in 60 s). A service that crash-loops ends `failed`, and the daemon then owns. On
  the Mac, launchd has no `failed` state, so the daemon unloads the job (`launchctl bootout`) after 3 exits
  in 60 s. A service that hangs while systemd sees it `active`: the daemon reads `status` every 10 s, and
  after 3 missed answers in a row it restarts the unit once; after 3 more it stops the unit, and then it
  owns.
- **The order at login.** The service's unit says `Before=agentwatch.service`, and agentwatch's unit says
  `After=agent-browser.service`. So with the switch on, the service is `active` (or `failed`) before the
  daemon reads the state at its start. On the Mac the daemon waits at most 10 s for a loaded job to run
  before it decides.
- **The unit record** (`unit.json`) keeps today's format during the whole move: Chrome's and Xvfb's pids
  and start times, the display, the Chrome version. The owner writes it, with an `fsync` of the temp file
  and of the folder before the rename. The service's updater writes the moved Chrome there in that
  format, so a daemon at a switch-off, or an older daemon, adopts the right Chrome. An unreadable record
  is not "no record": the owner then finds Chrome by the profile in the process table, as today's adoption
  does, and it never runs `stop_orphans` on a record that it cannot read.
- **No version without the unit.** agentwatch reads the service's version and features with a one-shot
  `agent-browser service --hello` (it prints the hello and exits) or from the installed commit, with no
  service running. A service runs only to own.

**The switch-on** (the operator turns the switch on; the daemon owns):

1. The daemon checks that it runs as its own systemd unit (section 7.1, m1) and that `--hello` lists the
   features that it needs. Else it refuses the switch-on, and `agentwatch health` says why.
2. The daemon stops its updater, its watch, its supervisor, its relay and its link socket, and turns
   `stop_orphans` off. Clients see one close, as at a relay restart today. Chrome, Xvfb and the daemon's
   host keep running.
3. The daemon enables and starts the service's unit. From the moment that the unit is `activating`, the
   service owns.
4. The service does its start (above): it adopts Chrome, writes its manifest, ends the daemon's host, and
   opens its doors. The receiver connects to the service's shim.
5. The daemon connects to the control door and sends `config` and `set_sessions`. The service sends
   `set_scopes`, reads the receiver's tab-to-scope map (`bridge.tabScopes`), and only then admits a
   connection, at the endpoint path that sessions already use. A client connects again, and its tabs are
   still in its scope.
6. If the control door does not work within 30 s (a refusal, no hello, no answer), the daemon runs the
   switch-off. So the service never runs long with no sessions: with no `set_sessions` it sends no scope
   object, and its watch would stop Chrome at 60 s (`sessions_unread`).

**The switch-off** (the rollback; the service owns):

1. The daemon stops and disables the service's unit. systemd sends the service SIGTERM: the service closes
   its agent door and its link socket and exits, and Chrome stays. The daemon waits until the unit is
   `inactive` or `failed`: at most the unit's stop timeout, after which systemd kills the main process.
2. The daemon owns. It reads the list files and the ended scopes file again from disk (never a copy in
   memory from before the switch-on), adopts Chrome and Xvfb from the unit record, writes its host path
   into the manifest, ends the service's shim, opens its link socket, and starts its relay, its supervisor,
   its updater and its watch with a new 60 s count. The receiver connects to the daemon's host.

**Operator acts during a change.** While the daemon waits for the unit to become `active` or `inactive`
(at most 30 s), it holds an operator act (`list_set`, `prompt_allow`, `prompt_dismiss`, `import`, `start`,
`stop`) and session events (`session_ended`, `launch_check`) in memory, in order, and gives them to the
owner when the state settles. After 30 s it refuses the held operator acts with "the agent browser is
changing hands; try again", and the pane shows that no change was made. The daemon answers an operator's
act only after the owner applied it, so an act that a daemon crash loses was never confirmed to the
operator. A `prompt_allow` with an id that the new owner does not know gets "this prompt is gone", and the
pane reads the prompts again. A launch of a name that ended during the wait waits for the owner's
`launch_check`.

**The cases, with this rule.** Each case ends with exactly one owner:

| Case | How it ends |
| --- | --- |
| The fresh review's first case: a slow or lost answer at a switch-on | No answer decides anything. The unit is `activating` or `active`, so the service owns; the daemon runs no part. If the start fails for good, the unit is `failed`, and the daemon owns. |
| A service that crashes during its start, or after it | systemd restarts it (the unit stays `activating`): the service owns, and the new instance adopts Chrome. After the start limit the unit is `failed`, and the daemon owns. |
| The fresh review's second case: a daemon that stops in the middle of a switch-on | Before step 3 the unit is `inactive`: the new daemon owns, as today, and it runs the switch-on again because the switch is on and the unit is not `failed`. After step 3 the service owns, and the new daemon runs no part. |
| The fresh review's third case: a downgrade past stage 2 while the switch is on | Rule 6 below: the update and rollback commands refuse it until the switch-off has run. After the switch-off the unit is `inactive`, and the older daemon owns, as today. |
| F1 of the narrow re-check: a late `release` answer, or a yield | No such message and no yield exist. At a switch-off the daemon waits for `inactive` from systemd, which comes at the latest after the stop timeout, and then it owns. If the stop itself fails, the daemon reads the state at each tick and owns as soon as the unit is `inactive`. |
| F2: an old host that holds the receiver's port | The new owner ends the old owner's host after it wrote its manifest, also when the old owner is down. The receiver reaches the new owner within about 1 to 2 s. |
| Note 2: a lost record | No owner record exists. The unit state cannot be lost. A lost or unreadable `unit.json` makes the owner find Chrome in the process table; it never makes a second owner. |
| Note 3: a passive service with no timer | No passive service exists. |
| Note 6: a service that stays down | Its unit is `inactive` or `failed`, so the daemon owns. `agentwatch health` shows "the switch is on, but the service's unit failed; the daemon runs the agent browser". |
| Note 7: the switch is on, but the daemon owns | This is note 6's state. The daemon does not start the unit again by itself after a failure. The operator repairs it with a switch-off (which also clears the `failed` state) and a switch-on. |
| Note 8: no working control door | Step 1 checks the daemon's own unit and `--hello` before the start; step 6 runs the switch-off when the control door does not work within 30 s. |
| A daemon that is down while the service runs | The service owns, and it goes on (section 7.1, "when the daemon drops"). |
| A service that crash-loops | Each new instance starts a new 60 s count, so no watch stops Chrome in the loop. After the start limit the unit is `failed`, and the daemon owns at its next tick (at most 5 s), ends the service's shim, and starts its own watch with a new count. |
| A daemon that is down while the unit is `inactive` | The daemon owns while it is down, as today: no side runs a watch until it starts. |

**Rule 6: no downgrade past stage 2 while the switch is on.** An agentwatch release from before stage 2
does not know this rule, so it would adopt Chrome while the service owns. From stage 2 on, agentwatch's
update and rollback commands refuse a target release from before stage 2 while the service's unit is
enabled, and they offer the switch-off first. A manual install of an old release outside these commands
is not guarded: the runbook says "switch off first".

**What this rule removes** (from round 3's owner record): the owner file and its lock (`owner.json`,
`owner.lock`, `flock` in both languages), the epoch, the `handing` state and the table of allowed writes,
the `adopt n` and `release n` ops, the service's 30 s self-take, the yield to a foreign manifest, the
passive service process (one Node process on each box with the browser on), and the daemon's start rules
for each record state. In their place: the unit state, which systemd already keeps; a few lines of unit
settings (`KillMode`, `Restart`, the start limit, `Before` and `After`); the one-shot `--hello`; and one
rule for hosts (the new owner ends the old owner's host).

**The tests of stage 2** cover, with `--fake` and in the live suite with the test browser:

- a switch-on and a switch-off, each with Chrome's pid kept, the receiver on the new owner's host within
  5 s, the lists and tabs intact, a list change made while on that is there after, and a run of 5 minutes
  with no fail-closed stop and exactly one side with owner parts;
- a slow service start (a stand-in that waits 20 s before it adopts); a start that fails for good; a
  service killed during its start and after it; a crash loop up to the start limit, then the daemon's take
  over with no fail-closed stop;
- a daemon killed before and after step 3 of the switch-on, and kept down for 120 s while the service
  owns;
- a hung service (no `status` answer) up to the daemon's restart and stop;
- the receiver's port held by the old owner's host at each change (the new owner ends it);
- a login with the switch on (the order of the two units);
- a control door that refuses after the start (step 6);
- operator acts and a session end during the wait, given on at the end and refused after 30 s;
- a stop of the unit that fails, with the daemon's take-over at its next tick;
- an unreadable `unit.json` at each side's start;
- the update command's refusal of a release from before stage 2 while the unit is enabled.

### 13.3 The order, and the daemon lead's conditions

The daemon lead first proposed to move the parts one at a time, by least coupling:

- (a) the Chrome installs and updates;
- (b) the unit, Xvfb, the flags and the pointer;
- (c) the native host, the link, the bridge and the relay;
- (d) the scope book and the lists;
- (e) the sign-in import.

Each of these steps needs a temporary interface between a half-moved service and the daemon. For example,
(b) without (c) needs two: the daemon's host must accept a Chrome that the service started, and the daemon's
pointer ops must call the service. So this design builds the whole service beside today's path in stage 1,
and stages 2 and 3 turn it on behind one switch per box.

The switch moves every part at once on one box. Its safeguard is the tested rollback of section 13.2,
which keeps the same Chrome and the same list files, not a move of one part at a time.

The daemon lead agreed to this order (review of 2026-11-09), with four conditions, which this design
takes:

1. The old daemon path stays the default, and unchanged, until stage 6.
2. Stage 2 live-tests the switch-off on taylor with the test browser (the Chrome pid stays, the daemon's
   host connects again, the lists and tabs are intact) before stage 3 asks the operator.
3. One agentwatch release carries both paths during the whole move, on both boxes.
4. A daemon restart in either mode keeps Chrome, and stage 2 tests it in both modes.

### 13.4 The daemon lead's review

The daemon lead's answers to the list of what the daemon lead must agree to (review of 2026-11-09):

| Item | Answer | In this version |
| --- | --- | --- |
| 1. The control door (C12) as the only interface | yes, with R1 and R7 | section 7.1: the daemon process itself by pid, parent, command line and start time (R1); the gateway's operator field (R7) |
| 2. The order | yes, this order, with four conditions | section 13.3 |
| 3. The move of every file | yes | section 7.4, with the files that the fresh review added |
| 4. The pins | yes: agentwatch pins only agent-browser; the service checks the CRX hash | section 7.4; the sender's ID and package come from the service (section 6) |
| 5. The unit | yes, with R4: its own unit and cgroup | sections 5.2 and 7.3 |
| 6. The MCP | yes, Q1 a; the cross-box path with R5 | sections 8.3 and 9 |
| 7. The live checks | yes | sections 13.1 and 13.3 |

In the agree list the daemon lead's conditions were R1, R4, R5 and R7. R2 (start and stop), R3 (the pin
change, health) and R6 (lists through the same files) were points that the design should say: R2 is Q5 and
section 5.6, R3 is section 7.3, R6 is section 7.5. Q2 to Q5 are the operator's.

The daemon lead's re-read of round 2 had no must-change and agreed with round 2 for the operator's
decision. Its four notes are in this version: m1, no systemd user unit (section 7.1); m2, the unit only
where the browser is on (section 7.3); m3, the remote walk as new Python code in stage 5 (section 9); m4,
the memory guard's last pid (section 7.3).

### 13.5 Build notes from the last review

These notes come from the last fresh review. They are not decisions; the build takes them into account.

1. During a switch-on, a `failed` unit ends steps 4 to 6 at once, so the daemon takes over without the 30 s
   wait.
2. The switch-off runs `systemctl --user reset-failed` for the unit: `stop` does not clear `failed`, and a
   hit start limit refuses a start for the rest of its interval.
3. A reboot or a new login clears `failed` and starts an enabled unit again: the daemon disables the unit
   when it takes over a failed unit, or the text says that each login tries again.
4. An adopted Chrome stays in the cgroup of the side that started it (agentwatch's unit after a switch-on,
   the service's unit after a switch-off), so a limit or a kill of that unit still reaches it; consider a
   scope unit of Chrome's own (`systemd-run --user --scope`), and set a short `TimeoutStopSec` (the user
   default is 90 s, and the switch-off waits for it).
5. A crash loop slower than the start limit (one crash each 31 s or more) never ends `failed`, and each
   instance starts a new 60 s count: count from the last confirm on this Chrome pid, kept on disk.
6. A service that restarts while the daemon is down has no `set_sessions`, so it stops Chrome with
   `sessions_unread` after 60 s; this is correct for C4, and the text and stage 2's tests say it.
7. The new owner finds the old host by one rule: a direct child of the recorded Chrome pid, with no
   `--type=` in its command line and the receiver's `chrome-extension://<receiver ID>/` origin in its
   arguments; it ends that host through a pidfd, and never ends another child of Chrome (a renderer, say).
8. The service opens its control door first, before any Chrome start (a start can take up to 2 × 45 s), so
   step 6's 30 s does not end early; and "or starts them" respects the unit record's `wanted`, so a
   switch-on or a crash restart never starts a browser that the operator stopped.
9. agentwatch writes the service's unit file again whenever the daemon's command line changes, not only at a
   pin change; else the control door refuses the new daemon, and the hung-service rule follows.
10. The unit names its `Type=`: with `Type=notify` and a ready signal after the doors open, `active` means
    "ready", and the order at login waits for it (Node has no built-in ready signal, so the build adds a
    small one or uses `Type=exec`).
11. The Mac (stage 4, not measured): the service owns while its job is loaded, also while launchd waits its
    10 s `ThrottleInterval`; the daemon counts exits from `launchctl print`'s run count and last exit code;
    `bootout` ends the job's process group, and the agent Chrome from `open -n -g` is outside it (open point
    3 of section 17).
12. `agentwatch health` says "failed" only for a `failed` unit, and an `inactive` unit gets a text of its
    own.

## 14. What changes in earlier designs

- The two-modes design, section 4.2: the daemon no longer carries the bridge; the relay is no longer a
  child of the daemon. Section 11: `agentwatch browser endpoint` asks the service.
- The peer admission design, section 10: the roots come in `set_sessions`, not in an `allowlist` line.
  Section 7's "path with no scope" becomes the MCP's path.
- The agent pointer design: `daemon.pointerAt` and `daemon.movePointer` become calls inside the service.
- The per-scope allowlist and orphan tabs designs: the daemon's rules (the push, the ended scopes, the
  restart gate) move to the service with their texts.
- The agent door answers a 503 while `browser.control` is false, with a text that says that the operator
  turned agent control off. Today the endpoint does not exist then, so a client got a connection error.
  This is a small change of what a client sees, not of what it may do.
- No operator decision changes. Decision 4 stays: nothing copies the old single list, and no scope uses it
  (section 7.5). The rule for start and stop stays as today during the move; Q5 asks the operator about a
  change.

## 15. Other shapes (notes only)

- **The MCP in the extension** (the operator's question). An extension cannot listen on a socket, and an
  MCP client cannot start an extension. An MCP always needs a process on the box. In this design the MCP is
  in the service, and the extension stays thin.
- **The browser model in the extension.** It would move the model into the receiver, but a process must
  still serve CDP and MCP to clients, so the bridge only changes its place. An extension change is a manual
  reload on the Mac, so a thin extension changes less often. Not chosen.
- **No extension (Chrome with a private debugging pipe).** It removes the receiver, but the DNR block per
  scope, the import and the tab map live in the receiver, and the operator chose the extension path for the
  agent browser (ab-v16). Not chosen.
- **The service as the native host.** Chrome would own the service's life (section 5.3). Not chosen.

## 16. Questions for the operator

Each question gives its options, their effects and a recommendation. "No answer" names what the build
does when the operator gives none.

**Q1. How does a local session reach the MCP?** (section 8.3)

- **a. HTTP inside the service, on its Unix socket; a local session runs the stdio shim
  `agent-browser mcp` (recommended).** No URL, no port and no key. The kernel check holds on Linux and on
  the Mac (0.02 ms per connection, M2). No other user can serve the socket. Each session that uses the MCP
  runs one small shim process with no Playwright in it (62.7 MiB in M3, a Node shim). HTTP is still the
  transport across boxes (section 9).
- b. HTTP on a loopback TCP port, `http://127.0.0.1:<port>/mcp/<scope>`, with the TCP peer check of M2.
  No process per session. Linux only until a Mac reader is built and measured. 10 to 35 ms per new
  connection. Another OS user can listen on the port while the service is down, and an agent's tool calls
  then go to that program. The check sees the holders of the socket, not the process that connected.
- c. Both: a by default, b as a per-box setting on Linux.
- No answer: a.

**Q2. Which sessions get the MCP in their configuration?** (section 8.5; the answer age-4ks, "env: no",
stays: nothing goes into a session's environment)

- **a. None by default; a per-repo switch on the Browser pane (recommended).** agentwatch adds
  `agent-browser mcp` to the MCP configuration of each session that it launches for a marked repo. The
  MCP's tool list costs context only in those sessions.
- b. Every session that agentwatch launches. Every session can use the browser at once; every session
  carries the tool list in its context.
- c. None: an agent adds the MCP for its own session when it needs the browser (the skill tells how).
- No answer: a.

**Q3. What does the browser grant for another box give?** (section 9)

- **a. One grant per box (recommended).** The operator approves the grant, `browser.use`, on the Mac's
  Links page. The grant names one Mac list for all sessions of that box. The list is new and empty until
  the operator fills it on the Mac's Browser pane. The Mac's quiet times refuse a new remote MCP session,
  and at the start of a quiet window they end an open one after its current request (section 9). A
  revoked grant ends that box's scopes and closes their tabs. Effect: one approval and one list per box.
- b. One grant per box and repo: the Mac keeps a list for each remote repo. More lists to keep; a finer
  limit.
- c. The grant of a, and the operator also approves each new remote session on the Mac (a prompt in the
  Mac's web viewer). The finest control; a remote session waits for the operator.
- No answer: a.

**Q4. Which code serves the MCP's tools inside the service?** (section 8.2; in both options the MCP runs
in the service, as the operator's "single self-contained process" asks)

- **a. The standard Playwright MCP, from three pinned packages (recommended).** The usual tools that
  agents and their clients know (M3), under the allow list of section 8.2 (24 tools today, no
  `browser_run_code_unsafe`). agent-browser gains three runtime packages (`@playwright/mcp`,
  `playwright`, `playwright-core`: 19 MB, no other package; today it has two), each pinned and vetted as
  the README's supply-chain section says. Each pin bump needs a new review of the allow list: its test
  fails at any change of the tools. The service uses a small transport of its own, not the MCP SDK
  package.
- b. A tool set of agent-browser's own, over the model. No new package. Fewer tools, with other names and
  shapes than the standard ones, so agents and skills must learn them. More code to write and keep in
  agent-browser.
- No answer: a, after the vetting.

**Q5. Who may start and stop the agent browser?** (section 5.6; a Tier-2 change; agentwatch issue #643)

Today the API token may start and stop the agent browser, and an agent's `endpoint` wait sends a start
(which also installs agent-browser). The Browser pane's texts tell the operator to run `agentwatch browser
stop` and `start` in a terminal. That command uses the same token, so the gateway cannot tell the
operator's terminal from an agent. The move keeps today's rule. This question is about a change after
stage 3.

- **a. Start by any caller, stop by the operator only (recommended).** An agent's `endpoint` wait still
  starts a stopped browser, and a start harms no session. A stop ends the browser for every session, so it
  needs a password login: the Browser pane's Stop. The pane's texts then name the pane's buttons, not the
  terminal. This closes the stop half of #643.
- b. Both by the operator only. An agent's `endpoint` wait no longer starts the browser: the agent gets
  "the agent browser is stopped; tell the operator", and it waits for the operator. This closes #643.
- c. Today's rule: the API token may start and stop. #643 stays open.
- No answer: c. The behavior does not change without the operator's answer.

## 17. Open points for the operator

The last fresh review found three points at the edges of section 13.2's rule. The manager's bound ended
the review rounds, so they go to the operator here. Section 13.2's rule stays as it is until the operator
answers. Each point gives the open point, the reviewer's proposed fix, and a recommendation.

**Open point 1. A switch-on that the daemon gave up.**

- The open point: after step 6 of the switch-on (the control door did not work) or after the stop of a
  hung service, the switch stays on and the unit is `inactive`, so the daemon can start the switch-on
  again. The result is a loop of about 35 s: in each turn every client sees two closes, and for up to 30 s
  the service sends no scope object; with a hung service, Chrome has a hung owner for about 60 s in each
  turn. The operator decides how a given-up switch-on is kept (a mark on disk, or a switch-off of the
  config key) before stage 2 is built.
- The reviewer's proposed fix: step 6 and the hung-service rule end in a "gave up" state that the daemon
  keeps on disk and that `agentwatch health` shows. The daemon starts a switch-on by itself only when no
  such mark exists, as it does for `failed`. A stage 2 test: step 6, then 2 minutes with no new
  switch-on.
- The options:
  - a. A "gave up" mark on disk. The config key stays as the operator wrote it. `agentwatch health` shows
    the mark, and the operator clears it with a switch-off and a switch-on.
  - b. The daemon turns the config key off itself. No new mark, but the daemon then writes the operator's
    config file, and the file no longer says what the operator wrote.
- Recommendation: a. It needs one small file and keeps the operator's config file the operator's own.

**Open point 2. A start of the service's unit that the switch-on did not make.**

- The open point: a start of the service's unit that the daemon's switch-on does not make (a tool's
  restart, a start by hand) can give two owners until the daemon's next 5 s tick. For example, the update
  command reads `active`, the hung-service rule then stops the unit and the daemon takes over, and the
  update command's `systemctl --user restart` starts the unit again. Or a start job is queued between the
  daemon's read of the state and its read of the jobs. For up to 5 s both sides run supervisors and write
  `unit.json` and the lists.
- The reviewer's proposed fix: the build uses `systemctl --user try-restart` everywhere (systemd restarts
  only a running unit; on the Mac `kickstart -k` already fails for a job that is not loaded), and one read
  of the unit's state and job (`ActiveState`, `SubState` and the job in one D-Bus property read, or a
  second read that must agree with the first). The runbook forbids a start by hand. A stage 2 test: a
  start of the unit while the daemon owns.
- Recommendation: take the reviewer's fix as written. It changes no part of the rule; it closes the paths
  that start the unit from outside the switch-on, and the one that stays open (a start by hand) is in the
  runbook.

**Open point 3. The Mac after the daemon unloads the service's job.**

- The open point: on the Mac the daemon has no owner parts, so after it unloads the service's job (after 3
  exits in 60 s, or the stop of a hung service) the agent Chrome runs with no watch and no endpoint. It was
  started through `open -n -g`, so launchd does not end it, and its host shim tries a closed socket. The
  operator decides at stage 4 whether the daemon then stops the agent Chrome, or the Mac gets a daemon
  owner path.
- The reviewer's proposed fix: on the Mac, after the `bootout` or the stop of a hung service, the daemon
  runs `agent-browser service stop --all`. The agent Chrome stops (fail closed), and `agentwatch health`
  says why.
- The options:
  - a. The daemon stops the agent Chrome. No browser runs with no watch; the operator starts it again on
    the Mac.
  - b. The Mac gets a daemon owner path. The Mac's agent browser keeps running after a service failure,
    but agentwatch gets browser code again, against "all the browser code moves into the browser".
- Recommendation: a (the reviewer's recommendation too). The Mac runs the agent browser only for difficult
  sites, so a stop there costs little, and a Chrome with no watch is the worse state.

## 18. The measurements

All three ran on taylor on 2026-11-09 (Debian 13, Linux 6.12.115, Node v26.12.0). M1 and M3 used Debian
Chromium 156.0.8078.79 (`/usr/bin/chromium`, `--headless=new`) with a temp profile of their own, under the
box's shared heavy lock and the repository's harness guard. M2 started no browser. Only local pages
(`a.localhost`) and the probes' own processes and sockets took part. No probe opened a remote-debugging
port. The probe's README gives the files, the commands and every number; `results/` holds the runs.

| | Question | Result |
| --- | --- | --- |
| M1 | Does a host shim in the per-profile `NativeMessagingHosts/` folder link a test extension to a separate long-running process over a Unix socket, and how fast? | Yes. First link 509 ms after the start; round trip 0.79 ms p50, 1.97 ms p99 (1000); 2.66 ms p50 with 64 KiB; the shim's parent is the service's Chrome (a stranger refused); the link back in 1,065 ms after a drop, with a new host path and the same Chrome; the shim 49.5 MiB |
| M2 | The peer check over loopback TCP, on Linux | Right in each case (in scope, another session, no session, a forked holder, an exit at once); 10.4 ms p50 / 17.0 ms p99 with the session's cgroup, 23.1 ms p50 / 34.3 ms p99 with every process, against 0.02 ms for `SO_PEERCRED` on a Unix socket; another OS user refused by the uid column (reasoned, not run) |
| M3 | Can `@playwright/mcp` start from code with a given CDP endpoint and serve its tools over HTTP? | Yes. From code, against a `ws+unix://` CDP endpoint: `initialize`, `tools/list` (25 tools), `browser_navigate` (447 ms; then 89 ms to 111 ms) and `browser_snapshot` over plain HTTP (`curl --unix-socket`); the same and `browser_click` (no error) through the stdio shim (62.7 MiB); the same through a small transport with no MCP SDK package, which also refused `browser_run_code_unsafe`; an `Origin` header got the 403 |

**The limits of the measurements.** The design rests on these numbers only within these limits:

- M1 used a test extension of the probe's own, which copies the receiver's 1 s reconnect. It did not use
  the real receiver, branded Google Chrome or the CRX install. Stage 1's live test runs the real receiver
  package; the branded Chrome and the Mac wait for stages 3 and 4.
- M2 did not test a client of another OS user (the probe changes no user). The Mac's TCP reader is not
  built or measured.
- M3 drove a plain bridge to Chromium, not the relay's model. The MCP against the model was measured
  before (section 8.2).
- M3 had no peer check, and its shim posted to `/mcp/<scope>`, not to `/mcp` alone: the scope from the
  walk is not measured for the MCP (the relay's walk itself is measured, in the peer admission design).
- The memory of today's Playwright MCP for each session, and of the service's MCP worker for each scope,
  is not measured. So the parts table gives no number for them.
- A dry run of M3 with a stand-in Chromium that answered nothing (not in `results/`) answered
  `initialize` and `tools/list`, and its `browser_navigate` waited: the MCP connects to the browser only at
  its first browser tool. Section 8.2's allow-list test relies on this.
- No fix of this version needed a new measurement.
