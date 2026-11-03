# The two-modes probe (2026-11-03)

This probe is the evidence for
[2026-11-03-two-modes-playwright-design.md](../2026-11-03-two-modes-playwright-design.md). It shows
that Playwright and the Playwright MCP drive a Chromium through an extension with
`chrome.debugger`, with no WebDriver, no remote-debugging port and no prompt. It is probe code, not
production code. Nothing in `src/` or `test/` uses it, and `npm test` does not run it.

## What it is

| File | What it does |
| --- | --- |
| `ext/` | The agent-mode extension as the design draws it: a thin bridge. It runs a fixed list of `chrome.*` calls for the relay and forwards `chrome.debugger`, `chrome.tabs` and `chrome.downloads` events. Its DNR rules block every top-level page except `a.localhost`. |
| `relay.mjs` | The prototype of the browser model and the CDP endpoint. CDP clients connect to `ws://127.0.0.1:8790/devtools/browser/<scope>` or `ws+unix://<socket>:/devtools/browser/<scope>`. The relay answers the Browser, Target and Storage domains from `chrome.*` calls and forwards each page-session command to `chrome.debugger.sendCommand`. |
| `site.mjs` | Local test sites on 127.0.0.1:8781: `a.localhost` (on the allowlist), `b.localhost` (off the list), `c.localhost` (a cross-site frame). Each page reports what its own script can see; the server logs the headers of each request. |
| `matrix.mjs` | Sends 93 CDP commands to one tab through `chrome.debugger`, and records which ones Chrome refuses. |
| `pw-probe.mjs` | 42 Playwright cases through `chromium.connectOverCDP`, with no change to Playwright. |
| `mcp-probe.mjs` | The Playwright MCP over stdio, with the endpoint in `PLAYWRIGHT_MCP_CDP_ENDPOINT`. |
| `run.sh` | Starts everything in a private display and a throwaway profile, runs the four probes, stops everything. |
| `summarize.mjs` | Writes `results/summary.md` and the compact result files. |

The probe connects the extension to the relay with a loopback WebSocket. The design uses the native
messaging link of stage 1 instead (measured in the stage-1 probe and live test). The relay accepts
the extension's WebSocket only with an `Origin: chrome-extension://...` header, and refuses any CDP
client that sends an `Origin` header, so a page's script cannot connect.

## How to run it

On a Linux box with Debian Chromium, Xvfb and Node 26. Install the clients into a scratch folder
(not into this repo):

```sh
mkdir -p "$SCRATCH/pw" && cd "$SCRATCH/pw" && npm init -y >/dev/null
npm install --ignore-scripts --no-audit --no-fund playwright-core@1.64.1 @playwright/mcp@0.0.84 ws@8.21.0
cd <this folder> && PW_DIR="$SCRATCH/pw" RUN="$SCRATCH/run1" ./run.sh
```

`run.sh` uses display `:117` (`DISPLAY_N` changes it), ports 8781 and 8790, and a socket under
`$XDG_RUNTIME_DIR`. The X server has `-nolisten tcp` and a 0600 auth file with a random cookie. The
profile, the HOME and the downloads stay in `$RUN`. Only `*.localhost` sites on 127.0.0.1 are used.

## Results

The run of record is on taylor, 2026-11-03, Chromium 156.0.8078.73 (Debian 13), Playwright 1.64.1,
Playwright MCP 0.0.84 (it brings Playwright 1.65.0-alpha-2026-10-30). Read
[results/summary.md](results/summary.md).

- Playwright: 42 of 42 cases as expected, over loopback TCP and over the Unix socket. Five cases
  are refusals on purpose (an off-list cookie, an off-list page, an off-list document through
  `page.route`, a permission outside `chrome.contentSettings`, `browser.newContext`).
- The Playwright MCP: 10 tool calls; navigate, snapshot, type, click, screenshot and tabs work. The
  one error is the planned block of an off-list page (`net::ERR_BLOCKED_BY_CLIENT`).
- Seven runs (run 7, three runs of run 8, runs 9 to 11) gave the same Playwright and MCP result.
  Between them only the matrix got more cases. Run 6 hung once in a popup case: a command
  to a new popup got no answer. The cause is not known. The probe now has a time limit per case
  (20 s) and per bridge call (15 s); the hang did not come back in the later runs.
- The off-list host `b.localhost` got no request in any run.

Files kept in git: `summary.md`, `pw-tcp.json`, `pw-unix.json`, `mcp.json`, `matrix.json`,
`site-log.compact.jsonl` (each page report with only the globals that the baseline page did not
have) and `relay-events.json` (the relay's events and a count of each CDP method that the clients
sent). The raw logs stay out of git (`results/.gitignore`).
