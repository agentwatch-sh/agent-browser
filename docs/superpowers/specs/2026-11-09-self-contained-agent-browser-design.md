# A self-contained agent browser with the fewest moving parts — design

Date: 2026-11-09. Status: **DRAFT for the operator's review.** Author: a taylor contributor, a design
subagent of the lead (board task ab-v16.93, under goal ab-v16). Branch `ab-v16.93-self-contained-design`
in agent-browser, from main `dc2431b`. Evidence: the probe in
[2026-11-09-self-contained-agent-browser-probe/](2026-11-09-self-contained-agent-browser-probe/README.md)
(M1 to M3), run on taylor (Debian 13, Linux 6.12.115, Node v26.12.0, Debian Chromium 156.0.8078.79,
`@playwright/mcp` 0.0.85). Nothing ran on the Mac. No product code changes in this task.

The design builds on the two-modes design
([2026-11-03-two-modes-playwright-design.md](2026-11-03-two-modes-playwright-design.md)). It also builds on
the per-scope allowlist, peer admission, orphan tabs, sign-in provider and agent pointer designs of
2026-11-04 to 2026-11-06, and on chrome-extension's `docs/protocol.md` (C1 to C11). It keeps every
operator decision of those designs. Section 14 lists what it changes in them. The daemon lead sent ten constraints and an
interface proposal for this design (2026-11-09). Section 12 shows how the design keeps each constraint.

## 1. The answer in short

1. **One process (section 5).** The **agent-browser service** (`agent-browser service`) runs once for each
   OS user on each box. It has its own lifetime: a systemd user unit (`agent-browser.service`) on Linux, a
   launchd agent on the Mac. agentwatch installs and pins it. The service holds all of the browser:
   - Google Chrome and its updates, Xvfb, and the agent extension's install;
   - the link to the extension, the browser model (today's relay) and the CDP endpoint;
   - the MCP server, the X pointer, the lists and scopes, the sign-in import and the blocked-site events.

   Chrome survives a restart of the service and of agentwatch. The service adopts a running Chrome, as the
   daemon does today.
2. **Two doors and one link (sections 5 and 7).**
   - The **agent door** is a 0600 Unix socket for CDP and MCP clients. It keeps the peer check of today's
     relay.
   - The **control door** is a 0600 Unix socket for agentwatch's daemon only. Operator acts (a list
     change, an allow, start and stop, a sign-in import) arrive only there, with the daemon's provenance.
   - The **native link** joins the service and the agent extension. Chrome starts a small **host shim**
     for the extension's native port, and the shim connects to the service. The shim must stay, because
     only Chrome can start a native host (M1).
3. **agentwatch keeps no browser logic (section 7).** It keeps these parts:
   - the web viewer and the Browser pane, which call the control door through the daemon;
   - the password login and the provenance of operator acts;
   - the gateway routes, as a pass-through;
   - the sessions: the scope, the repo and the roots of each session;
   - the links between boxes and the new browser grant;
   - the install, pin, update and uninstall of the service.

   All of `agentwatch/daemon/browser/` (9,437 lines) and `agentwatch/tools/google_chrome.py` (915 lines) go
   away or move to agent-browser (section 7.4).
4. **Fewer parts (section 4).**
   - An agent's CDP call crosses 3 process boundaries in place of 4. An MCP tool call crosses 4 in place
     of 5.
   - The bridge contract C10 no longer binds three repositories. Its ops join the native link contract
     (C4) of chrome-extension and agent-browser.
   - agentwatch gets one new contract with agent-browser, the control door (C12). It keeps C9.
   - A change to a bridge op or a list rule touches two repositories in place of three.
   - The receiver's code does not change for the move.
5. **The MCP (section 8).** The standard Playwright MCP runs from code inside the service. It serves its
   usual tools over Streamable HTTP on the agent door, at `/mcp/<scope>`. M3 started it from code and
   called `initialize`, `tools/list` (25 tools), `browser_navigate` and `browser_snapshot` with plain HTTP
   requests on a Unix socket. The service refuses one tool, `browser_run_code_unsafe`, which runs client
   JavaScript in the server's process. A local session reaches the MCP through a stdio shim,
   `agent-browser mcp`, which is a child of the session. So the kernel check of the Unix socket holds on
   Linux and on the Mac, with no TCP port and no key.
6. **Loopback TCP (section 8.3).** The peer check over loopback TCP works on Linux. M2 gave the right
   decision in each case, at 10.4 ms p50 per new connection (a scan of the session's processes) or 23.1 ms
   p50 (a scan of every process). `SO_PEERCRED` on a Unix socket takes 0.02 ms. The design does not use
   TCP by default, for three reasons:
   - another OS user can take the port while the service is down (taylor has three human users);
   - the check finds the holders of the socket, not the process that connected;
   - the Mac has no `/proc`.

   Question Q1 asks the operator.
7. **Another box (section 9).** A session on taylor uses the agent browser on the Mac through the
   agentwatch link. taylor's daemon names the session. The link carries the MCP's HTTP requests under a new
   browser grant, which the operator approves on the Mac's Links page. The Mac's daemon opens the Mac
   service's agent door for the scope `taylor/<session>`. The Mac never opens a port. The grant's list on
   the Mac and the Mac rules apply: the operator's consent, the quiet times, no focus taken.
8. **The move (section 13).** Six stages. Each stage is a pull request with tests and a pin bump, and has
   a rollback. The service first runs beside today's path, off by default. The switch adopts the running
   Chrome (its pid stays) and keeps the sessions' tabs in their scopes.

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
| Long-lived processes in the browser path (one OS user, one box) | 5: agentwatch daemon (carrier), relay, native host, Chrome, Xvfb | 4: service, host shim, Chrome, Xvfb (the daemon leaves the path) |
| Processes for the MCP of each session | 1 Playwright MCP per session (Node and Playwright, its own CDP connection) | 1 stdio shim per session (no Playwright; 62.7 MiB of memory, M3), or none for a remote session |
| Sockets and pipes in the browser path | 5: `browser-cdp.sock`, the relay's stdin and stdout, `browser.sock`, the native stdio, the X display | 5: the agent door, the control door, the link socket, the native stdio, the X display |
| TCP ports | 0 | 0 (1 only with Q1 b) |
| Contracts that bind agentwatch | 6: C1 (pins), C2, C4, C9, C10, C11 | 3: C2 (agentwatch only passes the bytes), C9, C12 (new) |
| Contracts that bind three repositories | C10 (also C4 and C11 name the daemon) | none |
| Repositories that one bridge op change touches | 3 (receiver, relay, daemon carrier) | 2 (receiver, service) |
| Repositories that one list rule change touches | 3 (receiver DNR, relay, daemon `ScopeBook`) | 2 (receiver, service) |
| Repositories that a Chrome start flag or update rule touches | 2 (agentwatch `unit.py` and its twin check `chrome_args.py`, agent-browser `assertSafeChromeArgs`) | 1 (agent-browser) |
| Rules written twice, in Python and TypeScript | the Chrome flag check, the scope pattern, C4's list rules (`ScopeBook` and `scopes.ts`), the version order | none (TypeScript, and the receiver's JavaScript) |
| Hops of an agent's CDP call to Chrome | 4: client, relay, daemon, host, Chrome | 3: client, service, shim, Chrome |
| Hops of an MCP tool call to Chrome | 5: agent, MCP, relay, daemon, host, Chrome | 4: agent, shim, service, host shim, Chrome |
| Hops of a pointer path (X) | 2: relay, daemon, xdotool | 1: service, xdotool |
| Hops of an operator act (a list change, a sign-in send) to Chrome | 3: gateway, daemon, host, Chrome | 4: gateway, daemon, service, shim, Chrome (one more, on a rare path) |
| Browser code in agentwatch | 9,437 lines in `daemon/browser/`, 915 in `tools/google_chrome.py`, parts of `commands/browser.py` and `server/routes/browser.py` | a control door client and the UI (section 7.4) |

The hot path (an agent's calls, thousands a minute) loses one hop. The operator's acts (a few a day) gain
one. The relay's stdio pipes, the daemon's carrier and its limits (`MAX_BYTES_IN_FLIGHT`, parts, waits)
and the `daemon.*` ops leave the wire: they become calls inside one process.

## 5. The service (task item 1)

### 5.1 What it holds

| Part | Today | In the service |
| --- | --- | --- |
| Google Chrome stable in a tools folder, its signed index and its updates | agentwatch `tools/google_chrome.py`, `daemon/browser/updates.py`, `versions.py` | the same rules: the `.deb` from Google's signed index (checked with `gpgv` against the pinned key), unpacked into the service's tools folder with no system install; the update move when idle (no request, no client, no send for an hour), forced after a day |
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
| The lists and the scopes | `lists.py`, `allowlist.py`, `scopes.py` (`ScopeBook`, the ended file) | the service keeps the list files (same format), builds `set_scopes` and the model's lines from the sessions that agentwatch sends |
| The sign-in import (C2 to C6) | `payload.py`, `service._import` | the service checks the payload (C2), applies the box's own sign-in rule with the hosts that agentwatch gives, and sends `import` to the receiver; payloads stay in memory only |
| The blocked-site events | the receiver's `blocked`, the relay's `daemon.blocked`, `service.on_blocked` | one event stream on the control door |
| The person's input (ab-t30.6) | `src/input.ts` in agent-browser's own commands; the relay does not shape a client's input | section 5.5 |

### 5.2 One process

The service is one Node process. The model, the endpoint, the link, the unit and the lists share one event
loop, as the relay's model does today. The MCP's Playwright code runs in a worker thread of the service.
Then a long Playwright step never holds the model's loop. (This is a build choice; M3 ran it on the main
thread.) Chrome, Xvfb, the host shim and `xdotool` stay separate processes: Chrome must be a process, and
Chrome starts the shim.

The service's own unit is outside every session's pane scope. So the daemon's memory guard never caps the
browser for all sessions (the daemon lead's C9). Chrome and Xvfb run detached, in their own sessions. At a
restart the unit stops only the service (`KillMode=process` on Linux, as in agentwatch's own unit). So
Chrome survives a restart of the service.

The folders:

- The service takes its state folder from its unit, which agentwatch writes at the install. The default is
  today's folder, `~/.local/share/agentwatch-browser/`, with its profile. So the switch moves no file and
  keeps every sent sign-in.
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
- When the service drops the link (a restart of the service, or the switch from agentwatch's host),
  Chrome keeps running, the extension connects again after its 1 s delay, and Chrome starts a new shim.
  Chrome reads the manifest again at that connect, so a new host path takes effect with no Chrome
  restart. Measured: the link was back after 1,065 ms. Chromium's pid and start time stayed, and the new
  shim ran the new host path.

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
| `daemon.blocked` | a C10 op to the daemon (250 ms) | an event on the control door's stream; the refusal text stays |
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

- **Status**: `status` on the control door gives these facts, and the Browser pane shows them:
  - the state: off, starting, ready, or failed closed;
  - Chrome's kind, version, pid and update state, and the extension's version;
  - the agent door's state: the peer check's form, or why it cannot run;
  - the sessions and lists that the service has.
- **Start and stop** of the agent browser (Chrome and Xvfb) are operator acts: only the control door
  takes them, with the daemon's provenance. The service process itself starts with its unit at login.
- **Update**: the service checks Google's index every 12 hours and moves Chrome when idle (today's rule).
  It reports each step on the event stream. agentwatch updates the service itself by its pin (the daemon
  lead's C7).
- **`browser.control: false`**: an operator act on the control door. The agent door then refuses every
  connection with a 503 that says that the operator turned agent control off. (Today the endpoint does
  not exist then.)

## 6. The extension (task item 2)

The receiver stays thin. It is Chrome's only door to the `chrome.*` calls (`chrome.debugger`, `tabs`,
`windows`, `downloads`, `contentSettings`, DNR). It keeps its jobs: the bridge ops, the DNR block per scope,
the guard, the sweep, the hold, the import, the tab-to-scope map.

**The receiver's code does not change for the move.** The receiver connects to the host name
`sh.agentwatch.browser` (`agent/link.js`). The service writes the same name into the agent profile's host
manifest, with the same `allowed_origins`. The shim sends the same `link` message. The frames, channels,
parts and messages stay as they are. So the receiver cannot tell the service from the daemon, and the move
needs no extension release.

**The contract text changes** (chrome-extension `docs/protocol.md`, the master of C1, C4, C5, C10, C11):

- **C1**: the native host name stays. agent-browser, not agentwatch, pins the chrome-extension commit, the
  receiver ID and the CRX's SHA-256. agentwatch pins only agent-browser.
- **C4**: the party on the host's far side is the service, not the daemon. The rules of C4 that name the
  daemon (`set_scopes` after each link up, its 10 s wait, the ended scopes, the restart gate, the
  rollout) name the service.
- **C10**: the bridge ops stay. "The path of a message" changes: the relay's model and the carrier are one
  process, so the relay's stdio lines and the daemon's carrier go. "The daemon's own ops"
  (`daemon.pointerAt`, `daemon.movePointer`, `daemon.blocked`) leave the wire: they become calls inside the
  service, with the same checks. C10 then binds two repositories. It can join C4 as C4's bridge channel:
  one contract for the native link.
- **C11**: the endpoint's socket path comes from the service, `browser.control` from the control door, the
  roots from `set_sessions`; the MCP path `/mcp/<scope>` joins it (section 8); a remote scope
  `<box>/<session>` joins the scope pattern (section 9; this one needs a small receiver change in
  `agent/scopes.js`, in the cross-box stage).

**The operator package does not change.** It holds no `debugger` and no `nativeMessaging` permission
(`operator/manifest.json`; `test/manifests.test.mjs` fails the build otherwise). It talks only to the
gateway (C9), with the login cookie and its `Origin`, and nothing in it depends on which process is the
receiver's host.

## 7. The interface with agentwatch (task item 3)

### 7.1 The control door (C12, new; agent-browser and agentwatch only)

The control door follows the daemon lead's proposal.

- **Transport**: a 0600 Unix socket in the service's 0700 run folder, one JSON object per line, requests
  with an `id` and answers, plus one event stream.
- **Who connects**: only agentwatch's daemon. On Linux the service reads the peer with `SO_PEERCRED`. It
  admits the peer only when the peer is the daemon: a process in the daemon unit's cgroup (the unit file
  names it), with the daemon's main pid. On the Mac it uses `LOCAL_PEERPID` and the daemon's launchd job.
  A session's process never passes, because it is in its pane's scope. A hostile process of the same OS
  user can join another cgroup with one write. That is the same-user limit of the peer admission design
  (section 11) and of today's daemon socket.
- **The hello**: each side sends `{"t":"hello","v":1,"version":...,"features":[...]}` first. Fields are
  only added, never changed. A side that lacks a feature answers `unsupported`. So an older service and a
  newer daemon (or the reverse) degrade, with no lock-step bump (the daemon lead's C7).
- **Provenance**: an operator act carries `"by":{"operator":true,"user":...,"via":"web"|"send"}`, which
  the daemon sets after the gateway's password login. The service takes provenance from the door, never
  from a client request. The agent door has no operator act at all.

| Daemon to service | What the service does |
| --- | --- |
| `set_sessions {sessions:[{scope, repo, roots:[{pid,start}], cgroup}], remote:[{scope, box, list}], box:{hosts, cookie_names}}` | A complete snapshot. The service builds the scopes, the list of each scope (by repo), the `set_scopes` object and the model's line. No scope object goes out before the first complete snapshot (the daemon lead's C4). |
| `session_ended {scope}` | Ends the scope: closes its tabs (`end_scope`, the receiver's sweep), drops its roots. |
| `list_set {list, allow, providers}` (operator) | Writes the list file; the next `set_scopes` carries it. |
| `prompt_allow {host, scope, list}`, `prompt_dismiss {id}` (operator) | The allow adds the host to the scope's list, as a `list_set`. |
| `import {payload}` (operator, `via: send`) | Checks the payload (C2), drops the box's own sign-in cookies (the hosts and names of `set_sessions`), sends `import` to the receiver, answers the counts. Nothing is written to disk. |
| `start`, `stop` (operator) | Starts or stops Chrome and Xvfb. |
| `control {on}` (operator) | `browser.control`. |
| `status`, `lists_get` | The status of section 5.6; the lists for the Browser pane (read only). |

| Service to daemon (the event stream) | Fields |
| --- | --- |
| `ready` | Chrome's pid and version, the extension's version, the agent door's state |
| `blocked` | host, scope, from (one event for the receiver's and the model's refusals; the per-host limit of once in 10 s stays) |
| `stopped` | a reason: `receiver_missing`, `sessions_unread`, a failed start, an operator stop (the daemon lead's C4: the daemon sees each fail-closed stop) |
| `chrome` | the version and the update state |
| `error` | a user, a domain and counts only, never a page, a cookie or a URL path |

### 7.2 What agentwatch keeps

- The web viewer and the Browser pane, with its texts (the agent-versus-operator texts can stay in the
  pane; the service gives the facts).
- The password login and the provenance of operator acts.
- The gateway routes as a pass-through: `GET /api/browser`, `POST /api/browser/start`, `/stop`,
  `/allowlist`, `/prompts/{id}/dismiss` and C9's `GET /api/browser/targets` and `POST /api/browser/send`.
  The gateway is root and never reads a user's file (the daemon lead's C1). It passes each request to the
  user's daemon. The daemon passes it to that user's service.
- The sessions: the scope (the launch name, never an alias), the repo, the roots (pane pid and start
  time, `panes.py`), and the pane's cgroup.
- The links between boxes and the new browser grant (section 9).
- The install, pin, update and uninstall of the service (the unit file, `AGENT_BROWSER_COMMIT`), and the
  Web Push of a blocked-site prompt (`gateway/browser_events.py`, `browser_prompts.py`).
- `agentwatch browser <command>`: it stays a wrapper of agent-browser's CLI (a child of the session, so the
  peer check admits it). `endpoint` and `env` ask the service.

### 7.3 Start, stop, and the tests

- agentwatch's install writes the service's unit (Linux) or launchd agent (Mac), with the state folder
  and the daemon's cgroup, and enables it.
- agentwatch's uninstall runs `agent-browser service stop --all`, which stops Chrome and Xvfb of the
  profile, as `stop_unit.py` does today. Then it removes the unit (the daemon lead's C10).
- `agent-browser service --fake` serves the control door with a scripted state and no Chrome, so
  agentwatch's `make check` stays hermetic (C10). Its hello lists the feature `fake`.

### 7.4 The daemon code that goes away or moves, by file

Under the operator's decision ("all the browser code to move into the browser"), every file of
`agentwatch/daemon/browser/` leaves agentwatch, except the session facts in `panes.py`.

| File (lines) | Where its logic goes |
| --- | --- |
| `allowlist.py` (62) | Moves: the old single list becomes one list of the service (a one-time copy). |
| `bridge.py` (721) | Goes away as a hop: the carrier's rules (waits, parts, joins, in-flight bytes, `end_scope`, `daemon.*` routing) move into the service's link. `SCOPE_RE` comes from the service. |
| `chrome_args.py` (32) | Goes away: agent-browser's `assertSafeChromeArgs` is the one check. |
| `crx.py` (234) | Moves: the CRX checks, its staging, the external extensions file. |
| `ext_id.py` (42) | Moves. |
| `host_files.py` (76) | Moves: the service writes the host manifest and the shim's wrapper. |
| `link.py` (552) | Moves: the link socket, the peer check of the host's parent, the channels. |
| `lists.py` (185) | Moves: the list files (same format); agentwatch keeps the pane's editor only. |
| `native_host.py` (288) | Moves: it becomes the host shim, `agent-browser host`. |
| `panes.py` (93) | Stays: it reads session facts (pane pid, start time, cgroup) that the sessions, the memory guard and cgroup accounting also use. Its browser use becomes `set_sessions`. |
| `parts.py` (48) | Moves. |
| `paths.py` (81) | Moves: the unit's paths become the service's; agentwatch keeps none. |
| `payload.py` (381) | Moves: the C2 check and the box-host rule, with the hosts and cookie names that agentwatch gives. |
| `pointer.py` (407) | Moves: `xdotool` in the service. |
| `relay.py` (390) | Goes away: no relay child process. |
| `scopes.py` (442) | Moves: `ScopeBook`, the ended file, the roots line. |
| `service.py` (3,143) | Splits: the gateway's `handle` (status, start, stop, allowlist, import) becomes a pass-through to the control door (a small client); the session feed (`set_sessions`, `session_ended`, `launch_refusal`, `pane_counts`) stays as the sender of `set_sessions`; the rest moves (the boot, the receiver watch and the fail-closed stop, the push of `set_scopes`, the unit control, the Chrome move and probation, the relay control, the endpoint state). |
| `stop_unit.py` (275) | Goes away: `agent-browser service stop --all` does it. |
| `unit.py` (1,447) | Moves. |
| `updates.py` (459) | Moves. |
| `versions.py` (44) | Moves. |
| `xauth.py` (34) | Moves. |
| Outside the folder | `tools/google_chrome.py` (915) and the Google signing key file move; `tools/pins.py` keeps only `AGENT_BROWSER_COMMIT` (the receiver, CRX, host name and Google pins move); `runtime_paths.browser_socket_path` and `browser_cdp_socket_path` go; `commands/browser.py` (1,023) shrinks to the wrapper and the control calls; `server/routes/browser.py` (751) becomes a pass-through; `browser_lists.py` (the scope pattern, the list names) moves. |

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
measured before: the two-modes probe (13 MCP calls and two checks of what the site saw, 15 of 15), and the
live runs of 2026-11-05, where the Playwright MCP passed the peer check and drove pages with one window per
page. Inside the service the MCP is the same CDP client.

How the service runs it:

- The service makes one Playwright MCP server object for each MCP session, with `createConnection(config)`
  from `@playwright/mcp`'s public entry. The configuration is fixed:
  - the scope's CDP endpoint;
  - the default context (no isolated context: the model refuses a new context anyway);
  - an output folder for each scope, in the state folder;
  - no tool that installs a browser.
- Its Playwright connects back to the agent door with the MCP session's scope. The agent door admits the
  service's own pid only on a path with a one-time ticket that the admitted MCP session holds in memory.
  So the MCP's connection is a client of the model like any other: every refusal and the peer check's
  scope apply to it. The control door refuses the service's own pid.
- **The service refuses `browser_run_code_unsafe`.** This tool of the standard tool set runs a client's
  JavaScript in the MCP server's process. Its own description says: "Unsafe: executes arbitrary
  JavaScript in the Playwright server process and is RCE-equivalent." Inside the service that process
  holds the lists, the native link and the control door's state. So the service's transport drops the tool
  from `tools/list` and answers its `tools/call` with "Not available in the agent browser" before the call
  reaches the MCP code (M3, part C: 24 tools in place of 25, and the refusal). Its tool set is `core`, so a
  setting of the MCP cannot turn it off alone. Every other tool acts through Playwright, so through the
  model and its refusals.
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
  dependencies. If the operator does not want them (Q4 b), the alternative is today's shape: a Playwright
  MCP for each session (stdio, `--cdp-endpoint`), as a client of the agent door.

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
door and writes each answer line (M3: the same calls through the shim). The service takes the scope from
the walk of the shim's process: the first root that the walk reaches names the scope, and a walk that
reaches no root gets the session's 403 (the peer admission design's "path with no scope", section 7). So
one MCP configuration serves every session. The kernel check holds on both systems. A session on another box uses
HTTP over the agentwatch link (section 9). This keeps the daemon lead's C3 and the operator's HTTP. HTTP is
the MCP's transport inside the service and across boxes. Only the last step, inside the session, is
stdio. Option b stays a later option for Linux, behind a setting, if a client must have a URL (Q1).

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
 taylor                                                      the operator's Mac
 session --stdio--> agentwatch browser mcp --box <mac>       Mac agentwatch daemon --agent door--> Mac service --> Mac agent Chrome
                    (a child of the session)                   ^ checks: the link's machine key,
                         | unix socket (agentwatch's)          |   the browser grant, the Mac rules
                         v                                     |   (consent, quiet times)
                    taylor agentwatch daemon ----agentwatch link (MCP HTTP requests)----+
                    names the session (its own peer check: the pane walk)
```

- **taylor**: the session's MCP configuration names `agentwatch browser mcp --box <mac>`, a stdio shim of
  agentwatch's that talks to taylor's daemon. The daemon names the session with its own peer check
  (`peer_pid`, the pane walk), and sends each MCP request over the agentwatch link with the session's name.
  No browser logic runs on taylor for this path.
- **The link**: the machine keys, and a new grant, `browser.use`, that a box asks for (`agentwatch link
  request`) and that the operator approves on the Mac's Links page (password login). Today the link has no
  browser grant (`agentwatch/linkmail/grants.py`).
- **The Mac's daemon**: it checks the link and the grant, applies the Mac rules (below), and lists each
  remote session in its `set_sessions` as `{"scope":"taylor/<session>","box":"taylor","list":<the grant's
  list>}`. It opens the Mac service's agent door for that scope and carries the bytes.
- **The Mac's service**: it admits the daemon's connection on the agent door only for a remote scope that
  the last `set_sessions` lists. A local scope always needs a local walk. The remote scope gets the grant's
  list, never a local repo's list.
- **The scope name**: `<box>/<session>`, for example `taylor/web-1`. A local scope has no `/`, so a remote
  scope never meets a local one. The scope pattern of C4 and C11 gains one optional `<box>/` part (a small
  change in the receiver's `agent/scopes.js` and the model's `SCOPE`).
- **The Mac's allowlist**: the operator fills the grant's list on the Mac's Browser pane. A remote session
  cannot change it (no door for it).
- **The Mac rules**:
  - the operator's consent: the grant, which the operator can revoke at any time on the Links page;
  - the quiet times of the Mac: in a quiet window the Mac's daemon refuses a remote session's new MCP
    session, with a clear text;
  - no window focus taken: the Mac service's rules of section 10.
- **Why MCP and not raw CDP across boxes**: one tool call runs many CDP calls next to Chrome, so the link
  carries one request and one answer per step. Raw CDP across the link is not in this design.
- **Files**: a tool argument that names a file acts on the Mac's disk, with the Mac user's rights. So for
  a remote scope the Mac service refuses every such argument: the paths of `browser_file_upload` (else a
  remote session could send a file of the Mac to a site) and the `filename` arguments of the snapshot and
  screenshot tools. Tools that return their data inline work.

| Part | Whose |
| --- | --- |
| The session's identity on taylor, the stdio shim to the daemon, the link, the machine keys, the grant and its approval, the Mac rules, the remote session in `set_sessions` | agentwatch |
| The remote scope in the model, the grant's list in the Mac service, the MCP, the agent door's rule for remote scopes, the Mac's Chrome rules | agent-browser |
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
| Per-scope allowlists that only the operator edits | lists in agentwatch's config folder, edited in the web viewer (password login), pushed by the daemon | the list files in the service, changed only by `list_set` and `prompt_allow` on the control door with the daemon's provenance (after the password login); no op on the agent door or in the MCP changes a list |
| The lists' enforcement | the receiver's DNR rules, guard and sweep; the relay's navigation refusal (layer 1) | the same: the receiver, and the model in the service |
| The peer check (the scope is the session's) | the relay (`src/relay/peer.ts`), roots from the daemon's `allowlist` line | the same code in the service, roots from `set_sessions`; the MCP shim and the MCP's own connection under the same check (section 8.2) |
| No cookie calls; cookie headers masked | the relay's model | the model in the service; the MCP's tools reach the browser only through the model |
| The refused page marks (main-world init scripts and bindings) | the model | the model |
| The world refusal (the relay's own isolated world) | the model | the model |
| No prompt, no remote-debugging port | the daemon's flags and `chrome_args.py`; agent-browser's `assertSafeChromeArgs` | `assertSafeChromeArgs` in the service, on every Chrome start |
| The operator's own Chrome is never reachable | the operator package has no `debugger`; the host manifest only in the agent profile; the host checks its parent's profile; the daemon checks the host's parent is the unit's Chrome | the same package rule; the service writes the manifest only in its agent profile; the shim checks its parent's profile; the service checks that the shim's parent is its own Chrome, by pid and start time (M1); on the Mac the service never writes the default folders |
| Fail closed: no confirmed receiver, Chrome stops after 60 s; no scope object before the first complete read of the sessions | the daemon (`check_receiver`, `_fail_closed`) | the service, with the `stopped` event to the daemon |
| Operator-only acts | the daemon's ops, after the gateway's login | the control door only, with provenance from the door; the agent door has no such op |
| A web page cannot connect | the `Origin` 403 of the endpoint | the same on CDP and MCP paths (M3); a Unix socket is out of a web page's reach |
| Secrets | no secret in argv or a log; payloads in memory | the same; the service gets a payload on the control door and keeps it in memory only; logs carry a user, a domain and counts |
| The extension signing key | agentwatch keeps the private key (0600) and pins the CRX | the service never holds the key: it checks the CRX against the pinned hash; the key stays where the release flow keeps it |
| The box's own sign-in never moves | `payload.py` (box hosts, `BOX_COOKIE_NAMES`) | the service, with the hosts and cookie names that agentwatch gives in `set_sessions` |
| No raw X for an agent | only the daemon runs `xdotool`, only for the relay's checked paths | only the service runs `xdotool`, only for its own model's paths |
| No client code in the browser's process | the relay runs no client code; a session's Playwright MCP runs in the session's own process | the service refuses `browser_run_code_unsafe` at its MCP transport (M3), so no client JavaScript runs in the service; the other tools act only through the model |
| A remote session | no path | the agentwatch link with a browser grant that the operator approves on the Mac; the grant's list; no port on the Mac; no tool argument that names a file on the Mac |

The limit stays as today: the check stops mistakes, an agent that names another session's scope, and an
injected instruction. It does not stop a hostile process of the same OS user (the peer admission design,
section 11).

## 12. The daemon lead's constraints

| Constraint | How the design keeps it |
| --- | --- |
| C1. Per user, never root; the gateway reads no user file | One service per OS user; the gateway passes requests to the user's daemon, which passes them to the user's service. |
| C2. Operator-only acts only through a control door, provenance from the credential | Section 7.1: the control door, the provenance field from the daemon; no such op on the agent door or in the MCP. |
| C3. The scope binding stays kernel-checked; no open TCP port, no bearer secret | The agent door is a Unix socket with the peer check; the MCP's local path is the stdio shim (Q1 a); cross-box through the link. Loopback TCP only if the operator picks Q1 b, with the M2 check and its limits. |
| C4. Fail closed; the daemon sees the stop | Section 11; the `stopped` event. |
| C5. Chrome survives restarts; the service has its own lifetime and adopts a running Chrome | Sections 5.2 and 13 (the switch keeps Chrome's pid; M1: the link comes back with no Chrome restart). |
| C6. Secrets | Section 11. |
| C7. The version pin, a hello with features | Section 7.1. One agentwatch release drives both today's relay path and the service during the move. |
| C8. One event stream | Section 7.1. |
| C9. The memory guard's cgroups | Section 5.2: the service's own unit, outside the session scopes. |
| C10. Hermetic tests; the uninstall removes the service | Section 7.3: `--fake`, `stop --all`, the unit's removal. |

## 13. The move from today (task item 8)

Each stage is a branch, a pull request with its own tests and a fresh review, and a pin bump in
agentwatch. No stage changes how the operator uses the browser without the operator's approval (Tier 2 of
agentwatch's `SECURITY.md`). Each stage is live-checked on taylor first.

| Stage | Repository | What | Tests | Rollback |
| --- | --- | --- | --- | --- |
| 0. Contracts | chrome-extension (`docs/protocol.md`), agent-browser (C12 in its docs) | C1, C4, C10, C11 texts of section 6; C12 (the control door) | the vectors (`test/vectors/`) gain the control door's lines | a text revert |
| 1. The service, off by default | agent-browser | `agent-browser service` with both doors, the hello, the host shim, the model in-process, the Chrome unit with adoption, Xvfb, the pointer, the lists and scopes, the import, the events, the MCP; `--fake`; `stop --all` | unit tests with fakes (the model's tests stay); a live test in the harness (its own Xvfb, its own Chromium with the agent package, no stand-in daemon: the service is the carrier) | nothing uses it yet |
| 2. The client in agentwatch, off by default | agentwatch (the daemon lead) | a thin control door client behind the hello's features; the session feed as `set_sessions`; a config switch per box; the old path stays the default | `make check` with `--fake`; the live suite with the test browser: the switch adopts the running Chrome (the pid stays), the lists keep working, the sessions' tabs stay in their scopes | the switch off: the daemon takes Chrome back (its own host manifest again, the link dropped, the extension connects to the daemon's host) |
| 3. Switch taylor | agentwatch config, with the operator's approval | the switch on for the operator's agent browser on taylor; the endpoint keeps today's socket path (the service listens at the path that the daemon gives) | the live check: Chrome's pid stays, every session's endpoint works, a sign-in send works, a blocked prompt reaches the pane | the switch off (stage 2's rollback) |
| 4. The Mac | agent-browser, agentwatch | the Mac paths of section 10 (ab-v16.8, age-0kh.23 go straight to the service) | the Mac checks of section 10, through the manager with the operator | the Mac stays without agent mode |
| 5. Another box | agentwatch (the grant, the link path), agent-browser (remote scopes), chrome-extension (the scope pattern) | section 9 | a two-box live check (taylor to the Mac), with the operator | the grant revoked |
| 6. Cleanup | agentwatch | delete `daemon/browser/` and the browser parts of section 7.4, after both boxes ran on the service for a while | `make check` | the pin before the cleanup |

**The daemon lead's order.** The daemon lead proposed to move the parts by least coupling, one pin bump
each:

- (a) the Chrome installs and updates;
- (b) the unit, Xvfb, the flags and the pointer;
- (c) the native host, the link, the bridge and the relay;
- (d) the scope book and the lists;
- (e) the sign-in import.

Each of these steps needs a temporary interface between a half-moved service and the daemon. For example,
(b) without (c) needs two: the daemon's host must accept a Chrome that the service started, and the
daemon's pointer ops must call the service. This design builds the whole service beside today's path in
stage 1. Stages 2 and 3 turn it on behind one switch per box, with a rollback that keeps Chrome. This
needs no temporary interface, and it keeps the same rule: never all at once on a live box, and one live
check per stage. If the daemon lead keeps the part-by-part order, (b) and (c) must go together, because
the host's parent check and the carrier tie the Chrome unit to the link.

**No outage.** The switch on a box, in order:

1. The daemon stops its relay (today's relay restart: clients see one close).
2. The service adopts the running Chrome and Xvfb from the unit record (their pids stay), and writes its
   host shim's path into the agent profile's host manifest.
3. The daemon ends its own native host process (it knows the pid from its link's peer read). Today's host
   does not exit when the daemon's socket closes: it tries the socket again every second while Chrome's
   port is open.
4. The receiver's port closes; the receiver connects again after 1 s; Chrome reads the new manifest and
   starts the service's shim (M1: 1,065 ms, Chrome's pid kept).
5. The service sends `set_scopes` from the daemon's first `set_sessions`, reads the receiver's
   tab-to-scope map (`bridge.tabScopes`), and only then admits a connection, at the endpoint path that
   sessions already use. A client connects again, and its tabs are still in its scope.

The rollback does the same steps the other way. The daemon writes its own host path into the manifest. The
service closes its link, and its shim exits. The receiver connects to the daemon's host.

**What the daemon lead must agree to.**

1. The control door of section 7.1 (C12) as the only interface, with `set_sessions` as a complete
   snapshot and the event stream.
2. The order of this section (the service whole, then one switch per box), or the part-by-part order with
   (b) and (c) together.
3. The move of every file of section 7.4, including the lists (`lists.py`, `allowlist.py`), the scope book
   and the sign-in import, which the daemon lead's proposal also moves.
4. The pins: agentwatch pins only agent-browser; agent-browser pins chrome-extension and the CRX.
5. The unit: agentwatch installs `agent-browser.service` (launchd on the Mac) with the daemon's cgroup, and
   the service's state folder stays today's folder.
6. The MCP: the stdio shim and the scope from the walk (Q1 a), with `agentwatch browser mcp` as a wrapper;
   the cross-box path of section 9 (the grant, `set_sessions` with remote sessions, the Mac rules in the
   Mac's daemon).
7. The live checks of stages 2, 3 and 5 on taylor with the test browser, and the operator's approval at
   stage 3.

## 14. What changes in earlier designs

- The two-modes design, section 4.2: the daemon no longer carries the bridge; the relay is no longer a
  child of the daemon. Section 11: `agentwatch browser endpoint` asks the service.
- The peer admission design, section 10: the roots come in `set_sessions`, not in an `allowlist` line.
  Section 7's "path with no scope" becomes the MCP's path.
- The agent pointer design: `daemon.pointerAt` and `daemon.movePointer` become calls inside the service.
- The per-scope allowlist and orphan tabs designs: the daemon's rules (the push, the ended scopes, the
  restart gate) move to the service with their texts.
- No operator decision changes.

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
  runs one small shim process with no Playwright in it. HTTP is still the transport across boxes (section 9).
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
  the operator fills it on the Mac's Browser pane. The Mac's quiet times refuse a new remote MCP session.
  A revoked grant ends that box's scopes and closes their tabs. Effect: one approval and one list per box.
- b. One grant per box and repo: the Mac keeps a list for each remote repo. More lists to keep; a finer
  limit.
- c. The grant of a, and the operator also approves each new remote session on the Mac (a prompt in the
  Mac's web viewer). The finest control; a remote session waits for the operator.
- No answer: a.

**Q4. Does the standard Playwright MCP run inside the service?** (section 8.2)

- **a. Yes (recommended).** The service serves the MCP's usual tools over HTTP (M3), less
  `browser_run_code_unsafe`. Local and remote sessions share one MCP code path, and no session runs
  Playwright. agent-browser gains three runtime packages (`@playwright/mcp`, `playwright`,
  `playwright-core`: 19 MB, no other package; today it has two), each pinned and vetted as the README's
  supply-chain section says. The service uses a small transport of its own, not the MCP SDK package.
- b. No: each session runs today's Playwright MCP as a stdio child with `--cdp-endpoint`. No new package
  in agent-browser. Each session runs Playwright in a process of its own. A remote session has no MCP on
  the Mac until the Mac starts a Playwright MCP for it.
- No answer: a, after the vetting.

## 17. The measurements

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
