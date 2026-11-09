# The probe of the self-contained agent browser design

The evidence of [2026-11-09-self-contained-agent-browser-design.md](../2026-11-09-self-contained-agent-browser-design.md)
(board task ab-v16.93). Run on taylor on 2026-11-09: Debian 13, Linux 6.12.115, Node v26.12.0, Debian
Chromium 156.0.8078.79 (`/usr/bin/chromium`, headless), `@playwright/mcp` 0.0.85 with `playwright-core`
1.66.0-alpha-2026-11-09, `@modelcontextprotocol/sdk` 1.32.2. Nothing ran on the Mac. None of these files is
part of `npm test`, and none is product code.

Each probe uses only its own processes, sockets, temp profile and local pages (`a.localhost` on
127.0.0.1). M1 and M3 start Chromium: they ran under the box's shared heavy lock and under the repository's
harness guard (`test/live/guard.ts`: the harness lock, and no Chromium or Xvfb after the driver ends). M2
starts no browser. No probe opens a remote-debugging port: M3's CDP endpoint is Chromium's
`--remote-debugging-pipe` behind a WebSocket on a Unix socket of the probe's own.

## The files

| File | What it does |
| --- | --- |
| `m1-native-host.ts` | M1. A "service" on a 0600 Unix socket, the probe's own unpacked extension (`m1-ext/`, only the `nativeMessaging` permission) in a temp profile, and the host manifest in `<user-data-dir>/NativeMessagingHosts/`. It checks that Chrome starts the host shim, that the service can tell its Chrome's shim from another process (`SO_PEERCRED` through the repository's own reader in `src/relay/peer.ts`, then the shim's parent by pid and start time, and the parent's `--user-data-dir`), the round trip service, shim, extension, shim, service, the shim's memory, and the link after the service drops it (with a new host path in the manifest). |
| `m1-host.mjs` | The host shim: Chrome's 4-byte length and JSON frames to one JSON line on the service's socket, and back. No logic, no state. |
| `m1-ext/` | The test extension: it connects to its native host and answers each ping. |
| `m2-tcp-peer.ts` | M2. An HTTP server on 127.0.0.1:0. At each accepted connection: the client's socket in `/proc/net/tcp` (and `tcp6`), its uid (another uid is refused first), the holders of its inode (a scan of `/proc/<pid>/fd`: every process, or only the processes of the claimed session's cgroup), the walk of each holder to a root, and the client's line again. Two roots (stand-ins for two sessions' pane processes), clients under each root and under no root, a forked holder, a client that exits at once, and 200 connections per timing case. Then the same 200 connections on a Unix socket with `SO_PEERCRED` (the repository's reader), for comparison. |
| `m3-mcp-http.ts` | M3. `createConnection` of `@playwright/mcp` from code, one server object per MCP session, behind the MCP SDK's Streamable HTTP server transport on a Unix socket at `/mcp/<scope>`. Part A: plain HTTP requests (`curl --unix-socket`): `initialize`, `tools/list`, `browser_navigate` and `browser_snapshot` to a local page, 10 more navigations, a request with an `Origin` header, an unknown session, the session's `DELETE`. Part B: the same through the stdio shim, and a `browser_click`. Part C: the same server object behind a small transport of the probe's own (no MCP SDK package), which drops `browser_run_code_unsafe` from `tools/list` and refuses its call. Each part gets a new Chromium. |
| `m3-shim.mjs` | The stdio shim of a local MCP client: each JSON-RPC line on stdin as one HTTP POST to the Unix socket, each answer as one line on stdout. |
| `results/m1.json`, `results/m2.json`, `results/m3.json` | The results of the runs that the design cites. |

## How to run

```sh
cd docs/superpowers/specs/2026-11-09-self-contained-agent-browser-probe
# M1 (starts Chromium): under the box's heavy lock
flock <heavy.lock> timeout 1500 node --disable-warning=ExperimentalWarning m1-native-host.ts   # add --xvfb for Xvfb :168
# M2 (no browser)
node --disable-warning=ExperimentalWarning m2-tcp-peer.ts 200
# M3 (starts Chromium twice): the packages go into a scratch folder, never into package.json
S=<a scratch folder>; (cd $S && npm init -y && npm install @playwright/mcp@0.0.85 @modelcontextprotocol/sdk@1.32.2 ws@8.21.0)
PW_MCP_DIR=$S flock <heavy.lock> timeout 1500 node --disable-warning=ExperimentalWarning m3-mcp-http.ts
```

`--disable-warning=ExperimentalWarning` hides the one warning of `node:ffi`, which the repository's peer
reader loads (M1 and M2).

## The results

M1 and M2 ran once. `results/m3.json` is M3's fourth run. Its first three runs had faults of the probe
itself, which the code here fixes: an option that `ws` 8.21.0 does not have (the run stopped before any
MCP call), a click with a wrong argument name, and no part C yet.

### M1: the host shim and the native link

- Chrome (`--headless=new`) started the host from `<user-data-dir>/NativeMessagingHosts/` of the temp
  profile. The predicted ID of the unpacked extension (the SHA-256 of its path) was right. The first link
  came 509 ms after the Chromium start.
- The shim's parent was the Chromium that the probe started (pid and start time), on the temp profile.
  A process of the probe's own driver that connected to the service's socket was refused: "its parent is
  not the service's Chrome".
- The round trip service, shim, extension, shim, service: 0.79 ms p50, 1.05 ms p90, 1.97 ms p99, 4.3 ms
  max (1000 pings); with 64 KiB of payload 2.66 ms p50, 5.5 ms p99 (200); 100 pings at once took 14 ms in
  all (11.2 ms p50 each).
- The shim (Node) used 49.5 MiB of memory (VmRSS: 50,648 KiB).
- The service dropped the link after the manifest named a second host path. Chromium kept running (the
  same pid and start time). The extension connected again after its 1 s delay, and Chromium started the
  new host path: the link was back in 1,065 ms, with the new shim's parent checked again. The round trip
  after it: 0.82 ms p50.

### M2: the peer check over loopback TCP (Linux)

| Case | Every process scanned | The session's cgroup scanned |
| --- | --- | --- |
| A client under the scope's root | admitted | admitted |
| A client under another session's root | refused (its holder walks to the other root) | refused |
| A client under no root (the probe's driver) | refused | refused |
| The client forks after the connect; both hold the socket | admitted, 2 holders | admitted, 2 holders |
| The client writes its request and exits at once (50 tries) | refused 50 of 50 at the accept: no holder; 50 ms later its line is gone | not run |
| A client of another OS user | not run (the probe changes no user): the uid column refuses it before any scan; `/proc/1/fd` gave `EACCES`, and each full scan met 393 processes whose `fd` folder it could not read | |

The cost per connection (200 connections each, ms):

| Step | Every process: p50 / p90 / p99 / max | The session's cgroup: p50 / p90 / p99 / max |
| --- | --- | --- |
| The client's line in `/proc/net/tcp` | 3.52 / 3.98 / 5.24 / 5.31 | 4.13 / 4.79 / 6.76 / 7.04 |
| The holders of the inode | 15.9 / 18.9 / 25.9 / 28.2 (91 processes and 1,316 fds read) | 2.07 / 2.49 / 3.61 / 3.70 (23 processes, 263 fds) |
| The walk | 0.13 / 0.19 / 0.26 / 0.37 | 0.11 / 0.17 / 0.46 / 0.52 |
| The line again | 3.53 / 4.07 / 5.67 / 6.04 | 4.07 / 4.61 / 6.78 / 6.96 |
| In all | **23.1** / 26.8 / 34.3 / 38.7 | **10.4** / 11.7 / 17.0 / 17.4 |

`/proc/net/tcp` had 44 lines at rest and 139 to 443 lines during the runs (the probe's own closed
connections in `TIME_WAIT`), so the line's cost grows with the box's connections. On a Unix socket the same
200 connections took 0.022 ms p50 (0.10 ms p99) for `SO_PEERCRED` (the pidfd form), and 0.10 ms p50 for the
walk (two walks of 200 took about 38 ms; the TCP runs show no such case).

### M3: the Playwright MCP from code, over HTTP

Versions: `@playwright/mcp` 0.0.85, `playwright-core` 1.66.0-alpha-2026-11-09, `@modelcontextprotocol/sdk` 1.32.2 (part A only),
Chromium as above, a new Chromium for each part.

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

- `createConnection` took 13.8, 6.9, 3.7 ms (one per MCP session).
- The 10 more navigations of part A: 111, 100, 103, 101, 93, 90, 89, 98, 90, 89 ms.
- The probe's process: 150 MiB at the start (the packages loaded), 154 MiB after `initialize`, 179 MiB after part A,
  182 MiB at the end. The stdio shim: 64,168 KiB.
- Part C's transport dropped 1 message of the server that answered no request (a notification).
- `tools/list` of part A: `browser_close`, `browser_resize`, `browser_console_messages`, `browser_handle_dialog`, `browser_emulate_media`, `browser_evaluate`, `browser_file_upload`, `browser_drop`, `browser_find`, `browser_fill_form`, `browser_press_key`, `browser_type`, `browser_navigate`, `browser_navigate_back`, `browser_network_requests`, `browser_network_request`, `browser_run_code_unsafe`, `browser_take_screenshot`, `browser_snapshot`, `browser_click`, `browser_drag`, `browser_hover`, `browser_select_option`, `browser_tabs`, `browser_wait_for`.
- In this version the click tool's element argument is `target` (the snapshot's ref), not `ref`.
- `browser_run_code_unsafe` is in the `core` tool set; its description in `playwright-core` reads "Unsafe: executes
  arbitrary JavaScript in the Playwright server process and is RCE-equivalent". Part C's transport refuses it.
- The probe's endpoint is a plain bridge to Chromium, for one client at a time, not the relay's model.
