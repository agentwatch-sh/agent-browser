# The two-modes probe (2026-11-03)

This probe is the evidence for
[2026-11-03-two-modes-playwright-design.md](../2026-11-03-two-modes-playwright-design.md). It shows
that Playwright and the Playwright MCP drive a Chromium through an extension with
`chrome.debugger`, with no WebDriver, no remote-debugging port and no prompt. It is probe code, not
production code. Nothing in `src/` or `test/` uses it, and `npm test` does not run it.

## What it is

| File | What it does |
| --- | --- |
| `ext/` | The agent-mode extension as the design draws it: a thin bridge. It runs a fixed list of `chrome.*` calls for the relay and forwards `chrome.debugger`, `chrome.tabs`, `webNavigation` and `chrome.downloads` events. Its DNR rules block every top-level page except `a.localhost` (rules 1 and 2), and every frame of a tab whose top-level page is not on the list (rule 3). |
| `relay.mjs` | The prototype of the browser model and the CDP endpoint. CDP clients connect to `ws+unix://<socket>:/devtools/browser/<scope>` or, with the run's token in an `x-probe-token` header, to `ws://127.0.0.1:8790/devtools/browser/<scope>`. The relay answers the Browser, Target and Storage domains from `chrome.*` calls and forwards each page-session command to `chrome.debugger.sendCommand`. A tab belongs to one connection at a time. |
| `site.mjs` | Local test sites on 127.0.0.1:8781: `a.localhost` (on the allowlist), `b.localhost` (off the list), `c.localhost` (a cross-site frame). Each page reports what its own script can see (`navigator.webdriver`, size, focus, event kinds, pointer pressure, key and input counts, globals); the server logs the headers of each request. |
| `matrix.mjs` | Sends 93 CDP commands to one tab through `chrome.debugger` and records which ones Chrome refuses; then the navigation-header variants. |
| `pw-probe.mjs` | 49 Playwright cases through `chromium.connectOverCDP`, with no change to Playwright. Each case checks its value; six cases check a refusal that the design wants. |
| `mcp-probe.mjs` | The Playwright MCP over stdio, with the endpoint in `PLAYWRIGHT_MCP_CDP_ENDPOINT`. 13 tool calls. |
| `concurrency.mjs` | 13 cases with several connections at the same time: two in one scope, one in another scope, and a raw CDP client. |
| `run.sh` | Starts everything in a private display and a throwaway profile, runs the five probes, stops everything. `NO_FRAME_GUARD=1` is the control run without rule 3. |
| `summarize.mjs` | Writes `results/summary.md` and the compact result files. |

The probe connects the extension to the relay with a loopback WebSocket. The design uses the native
messaging link of stage 1 instead (measured in the stage-1 probe and live test). The relay accepts
the extension's WebSocket only with an `Origin: chrome-extension://...` header. It refuses a CDP
client that sends an `Origin` header (a page's script) and a TCP client without the run's token. The
probe's control calls (`/control`) go over the 0600 Unix socket only. A limit of the probe: while it
runs, a local process that sends a forged `Origin` header could take the extension's place on port
8790. The probe browser holds test values only, and the design uses the native link, not a port.

## How to run it

On a Linux box with Debian Chromium, Xvfb and Node 26. Install the clients into a scratch folder
(not into this repo):

```sh
mkdir -p "$SCRATCH/pw" && cd "$SCRATCH/pw" && npm init -y >/dev/null
npm install --ignore-scripts --no-audit --no-fund playwright-core@1.64.1 @playwright/mcp@0.0.84 ws@8.21.0
cd <this folder> && PW_DIR="$SCRATCH/pw" RUN="$SCRATCH/run1" ./run.sh
```

`run.sh` uses display `:117` (`DISPLAY_N` changes it), ports 8781 and 8790, and a socket under
`$XDG_RUNTIME_DIR`. It refuses to start when the display or a port is taken. The X server has
`-nolisten tcp` and a 0600 auth file with a random cookie. The TCP token comes from `/dev/urandom`
and goes in the environment, never in argv. The profile, the HOME, the downloads, the trace and the
MCP's log stay in `$RUN`. Only `*.localhost` sites on 127.0.0.1 are used.

## Results

The run of record is run 18 on taylor, 2026-11-03: Chromium 156.0.8078.73 (Debian 13), Playwright
1.64.1, Playwright MCP 0.0.84 (it brings Playwright 1.65.0-alpha-2026-10-30). Read
[results/summary.md](results/summary.md).

- Playwright: 49 of 49 cases as expected, over loopback TCP and over the Unix socket. Six of them
  are refusals that the design wants: an off-list cookie, an off-list page, an off-list document
  through `page.route`, a permission outside `chrome.contentSettings`, `browser.newContext`, and
  `storageState()` after a page with an off-list frame.
- The Playwright MCP: 13 of 13 tool calls as expected; the off-list navigation is refused.
- Several clients at the same time: 13 of 13.
- The off-list host `b.localhost` got no request in any run.
- The control run (run 17, `NO_FRAME_GUARD=1`) loads the off-list frame in a page that is not on
  the list (`results/control-no-frame-guard-pw-tcp.json`, `frameLoaded: true`); with rule 3 the frame
  does not load.

The runs: runs 1 to 5, 12 and 13 failed on probe bugs that later runs fixed (they are not results).
In the 18 runs from run 6 on (run 8, run 15 and run 16 ran several times), a popup case hung twice
(run 6 and the third run of run 15): a popup's `waitForLoadState` or `evaluate` got no answer. The
cause is not found; design section 10 names the suspected race and the fix. The probe has a time
limit per case (20 s) and per bridge call (15 s), so a hang shows as a failed row. Only the run of
record keeps its files.

Files kept in git: `summary.md`, `pw-tcp.json`, `pw-unix.json`, `mcp.json`, `concurrency.json`,
`matrix.json`, `control-no-frame-guard-pw-tcp.json`, `site-log.compact.jsonl` (each page report
with only the globals that the baseline page did not have) and `relay-events.json` (the relay's
events and a count of each CDP method that the clients sent). The raw logs stay out of git
(`results/.gitignore`).
