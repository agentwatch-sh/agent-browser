# agent-browser

agent-browser drives allowlisted tabs in Chrome over the Chrome DevTools Protocol (CDP). It came out
of vedlo's `tools/browser/` (vedlo commit `a107f03e8`). vedlo and agentwatch both use it.

Each consumer has its own **agent browser**: a separate Chrome on the consumer's own profile. It does
not share the operator's Chrome or the operator's logins. The operator signs in to the allowlisted
sites once inside that profile (`launch --login`), and those logins stay in that profile only. So
each consumer has its own cookies and logins, its own tab names and its own proxy socket. The
operator's own Chrome (mail, banking, admin) is not reachable from the tooling. A consumer uses the
operator's Chrome only in personal mode, only when the operator asks, and then only in one pinned
window of its own.

It has two surfaces, and both are tested:

- **Node** (TypeScript, no build step): a library that Node code imports in-process, and a CLI,
  `agent-browser <command> ... --json`, that prints one JSON document for each call.
- **Python** (`agent_browser`, standard library only): typed methods, one for each CLI command. Each
  method runs the CLI.

```ts
// Node 26+
import { AgentBrowser, commands } from "agent-browser";

const options = { stateDir: "/abs/vedlo/.state/browser", allowlistFile: "/abs/vedlo/config/sites.json", commandName: "vedlo browser" };
const { tabs } = await commands.tabs(options);                  // the same result as `agent-browser tabs --json`

const browser = await AgentBrowser.connect(options);            // multi-step work on one connection
try {
  const tab = await browser.open("https://suno.com/create", { name: "suno" });
  console.log(await tab.text());
  await tab.click('[aria-label="Create"]');
} finally {
  await browser.disconnect();                                   // the tabs stay open
}
```

```python
# Python 3.10+
from agent_browser import AgentBrowser, NotAllowedError

browser = AgentBrowser("/abs/agentwatch/state/browser", "/abs/agentwatch/config/browser-allow.json",
                       command_name="agentwatch browser")
tab = browser.open("https://example.org/", name="work").tab
for element in browser.outline("work").elements:
    print(f"#{element.index} {element.role} {element.label!r}")
browser.click("work", "#3")
print(browser.text("work").text)
```

## Hard rules

These rules come from vedlo and its incidents. Each rule is in the code, in the tests and here.

| Rule | In the code | In the tests |
| --- | --- | --- |
| Never launch Chrome with `--remote-debugging-port`. That flag sets `navigator.webdriver`, and Cloudflare, hCaptcha and Google then block every page. The operator turns remote debugging on in `chrome://inspect/#remote-debugging` and approves once for each proxy. | `assertNoDebuggingFlag` in `src/agent.ts` refuses `--remote-debugging-port`, `-pipe` and `-address` before any spawn. | `test/agent.test.ts`, `test/package.test.ts` |
| Every connection goes through the local proxy socket. | `AgentBrowser.connect` connects only to the proxy socket (`src/proxy.ts`); there is no direct mode. | `test/browser.test.ts` ("one upstream connection"), `test/proxy.test.ts` |
| Only allowlisted hosts can be opened, attached, read or clicked. An agent never widens the list. | `src/allowlist.ts`; every `Tab` action re-reads the live URL first (`assertAllowed`). A `fetch` or `download` URL must be allowlisted too (it carries the profile's cookies). A redirect off the list is refused by host, and `net` stops recording when the tab leaves the list. The package reads the allowlist file and never writes it. No command or flag adds a host. Mail, account and admin hosts are refused even when a broad entry covers them. | `test/allowlist.test.ts`, `test/browser.test.ts`, `test/cli.test.ts` (the file is unchanged, and an off-list tab gets no CDP call) |
| Never drive the operator's own Chrome unless asked. In that mode, use one pinned window and keep off mail, banking and admin tabs. | Personal mode needs `mode: "personal"`. It acts only in a pinned window, and its first `open` makes and pins a window of its own. `launch` and `quit` refuse personal mode. | `test/browser.test.ts`, `test/cli.test.ts`, Python `test_personal_mode_needs_its_own_pinned_window` |
| Read pages with `outline` or `text` before screenshots. | `shot` refuses (`read_first`) until `outline` or `text` has read that tab at its current URL. | `test/cli.test.ts`, Python `test_a_full_session_returns_typed_results` |

Other safety rules: the agent browser never runs from Chrome for Testing (a build for automated
tests). Under `node --test`, the state folder must be in the temp folder, and personal mode never
reads the real Chrome profile. Our injected page code runs in an isolated world (so it stays off the
page's own `window`), and the Runtime CDP domain is never enabled. A refusal names only the host,
never the full URL. `type` never echoes its text. `net` never records headers, and it redacts
tokens, keys and JWTs. `stop` and
`quit` signal only this consumer's own proxy (checked by its command line and socket, so a stale pid
file cannot hit another process) and the Chrome main process on this consumer's own profile.

## What a consumer provides

| Item | Node option | CLI flag | Python argument | Notes |
| --- | --- | --- | --- | --- |
| State folder | `stateDir` | `--state-dir` | `state_dir` | **Required**, absolute. It holds `tabs.json`, `window.json`, `reads.json`, `chrome-proxy.json`, `chrome-proxy.log`, `launches.log` and `shots/`. Created with mode 0700. One folder for each consumer. |
| Allowlist | `allowlistFile` (or `allow`) | `--allowlist` | `allowlist` | **Required** for every command that touches tabs. JSON: `{"allow": ["suno.com", "midjourney.com"]}`. A host matches itself and its subdomains. Entries are lowercase host names with a dot (or `localhost`). |
| Profile | `profileDir` | `--profile` | `profile` | Default `<stateDir>/profile`. Its cookies are this consumer's logins. |
| Proxy socket | `socketPath` | `--socket` | `socket` | Default `<stateDir>/chrome-proxy.sock`, mode 0600, at most 103 bytes. |
| Notify hook | `notify` (callback or `{ command }`) | `--notify-command '["prog","arg","{message}"]'` | `notify_command=["prog", ...]` | Used only by `status --notify`. An argv list, never a shell string. The message goes on stdin, and `{message}` in an argument is replaced with it. Example for agentwatch: `["agentwatch", "session", "inbox", "--text", "{message}"]`. |
| Node | | | `node` (default `node` on PATH) | Node 26 or later. |
| Package folder | | | `package_dir` | The agent-browser folder with `bin/agent-browser.js`. Default: the checkout that holds the adapter. |

Optional: `mode` (`agent` by default, or `personal`), `chromeBin` (default Google Chrome Beta when it
is installed, else Google Chrome), `endpoint` (a known `ws://` endpoint, still used through the proxy),
`personalUserDataDir`, `noLaunch` (fail with the launch command instead of starting Chrome),
`proxyIdleMs` (default 12 hours), `commandName` (how hints name the command line, for example
`vedlo browser`) and `log` (progress lines; default standard error).

## How it works

- **The agent browser** is a regular Chrome on the consumer's profile. Any command that needs Chrome
  starts it if it is not running (`noLaunch` turns that off). This is an agent browser, so it comes up
  ready: before it starts Chrome, `launch` writes `devtools.remote_debugging.user-enabled: true` into
  the profile's `Local State` (`seedRemoteDebugging`), so remote debugging is on without a
  `chrome://inspect` click. That setting is a plain, unsigned value (not the HMAC-signed "Secure
  Preferences"), so Chrome keeps it; `launch` merges it in and never overwrites other keys or a corrupt
  file. The launch still opens `chrome://inspect/#remote-debugging` as a visible fallback. `launch`
  waits up to 10 minutes for the endpoint; other commands wait 30 s.
- **The approval prompt still applies.** Seeding removes the toggle click, not Chrome's own per-connection
  approval dialog. On first connect Chrome asks the operator to allow it, once per proxy (below). On a
  headless server with no one to click, run headed Chrome under a virtual display (Xvfb) and accept that
  one dialog on it; do not fall back to `--remote-debugging-port`, which sets `navigator.webdriver`.
- **Finding it:** the endpoint comes from `DevToolsActivePort` in the profile. The port must be
  listening and owned by the Chrome main process whose `--user-data-dir` is exactly this profile.
  A stale file is ignored. No WebSocket is opened to probe, because that would raise the approval prompt.
- **The proxy:** one background Node process (`agent-browser proxy`, started by the first command that
  needs Chrome) holds the single upstream connection and shares it over the consumer's Unix socket.
  So the operator approves once for each proxy, not once for each command. Request ids are remapped
  for each client. Session events go only to the client that attached the session; browser events go
  to every client. A departed client's sessions are detached. A start lock next to the socket lets
  simultaneous callers elect one proxy, and a live socket is never removed. The proxy exits after
  `proxyIdleMs` with no clients, when Chrome closes the connection, or on `stop`.
- **Diagnostics:** `status` reuses an existing proxy only. It never starts Chrome or a proxy. Without a
  proxy it reports local evidence and the last attempt from `chrome-proxy.log`. A pending handshake does
  not prove that Chrome shows a prompt, so the approval status is always "unknown".
- **Tab references:** `<tab>` is a name from `open --name`, a target-id prefix, or a URL substring,
  always among allowlisted tabs only.
- **Cheap reading:** `outline` numbers the interactive elements on screen; `click <tab> #N` clicks one.
  Read with `outline` and `text`; take a screenshot last.
- **Isolated world:** every `evaluate` (and so `outline`, `text`, `click`, `fetch` and the rest) runs
  in a private isolated world created with `Page.createIsolatedWorld`, not in the page's main world.
  Our functions and temporaries never touch the page's own `window`, and the page cannot replace the
  globals we use. The Runtime CDP domain is never enabled. A navigation destroys the world; the next
  `evaluate` makes a new one and retries. `outline` still marks elements with a `data-agent-browser-idx`
  attribute, because the DOM is shared and a later `click #N` must find them across separate calls.

### Why there is a `loader.js`

Node 26 strips TypeScript types itself, but not for files under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). A consumer that pins this repo as a git dependency gets
it in `node_modules`. So the entry points `index.js` and `bin/agent-browser.js` are plain JavaScript.
There, `loader.js` registers one load hook that strips the types of this package's own `src/*.ts`
files and of nothing else (with `module.stripTypeScriptTypes`; it drops that function's one
ExperimentalWarning). From a checkout, Node strips the types natively and no hook is registered.
`test/package.test.ts` installs the package under `node_modules` and runs the library, the CLI and
the proxy from there.

TypeScript consumers get types from `src/index.ts` (the `types` condition in `package.json`).

## Node library API

`import { ... } from "agent-browser"`. Every function takes the consumer's options
(`BrowserOptions`, see above).

**`commands`**: one async function for each CLI command, with the same parameters and the same
result document (see the CLI section): `commands.launch(o, { login })`, `quit(o)`,
`status(o, { notify })`, `connect(o, { endpoint })`, `stop(o)`, `window(o, { pin, unpin })`,
`tabs(o)`, `open(o, { url, name, tab })`, `goto(o, { tab, url })`, `outline(o, { tab, all })`,
`click(o, { tab, target, text })`, `hover(o, { tab, target })`, `type(o, { tab, text, into })`,
`press(o, { tab, key })`, `text(o, { tab, selector })`, `eval(o, { tab, expression })`,
`shot(o, { tab, path, full })`, `fetch(o, { tab, url, path })`, `download(o, { tab, url, path })`,
`close(o, { tab })`, `net(o, { tab, seconds, match, max }, { onEntry })`, `commands()`.
`COMMAND_SPECS` describes them (names, parameters, CLI usage).

**`AgentBrowser`** (one connection for multi-step work):

- `AgentBrowser.connect(options, { existingOnly? })`: connect through the proxy (see above).
- `allowedPages()`, `otherPageCount()`, `open(url, { name?, newWindow?, timeoutMs? })`, `resolve(ref)`
  (find a tab without attaching), `find(ref)`, `attach(targetId)`, `windowOf(targetId)`,
  `pinnedWindow()`, `pinWindow(id | undefined)`, `disconnect()`. Properties: `conn`, `settings`,
  `allow`, `product`, `mode`.

**`Tab`**: `goto(url)`, `url()`, `assertAllowed()`, `evaluate(fn | expression, ...args)`,
`waitFor(fn, { timeoutMs, intervalMs, args, what })`, `waitForSelector(selector)`, `click(selector)`,
`clickText(text, { within })`, `clickAt(x, y)`, `hover(selector)`, `type(text, selector?)`,
`press(key)`, `setFiles(selector, paths)`, `text(selector?)`, `screenshot(path, { fullPage })`,
`fetchToFile(url, path)`, `download(url, path)`, `expectDownload(action, dir)` (a download that a
click starts), `expectResponse(match, action)` (capture an API response body; a CORS preflight's
response is never it), `watchResponses(match)`, `interceptRequest(urlPattern, transform, action)`
(rewrite a request body in flight; a CORS preflight is continued untouched), `close()`.
`Tab.screenshot` is the low-level primitive; the read-first rule is in `commands.shot` and the CLI.

**Lower level:** `launchAgentChrome`, `agentEndpoint`, `agentChromePid`, `agentChromeBin`,
`findAgentPid`, `parsePs`, `processTree` (a Chrome's process tree, for example to record its audio),
`restoresOnStartup`, `startProxy`, `stopProxy`, `proxyInfo`, `browserTarget`, `localBrowserStatus`,
`notifyBrowserStatus`, `outline`, `redact`, `netLog`, `isAllowedUrl`, `isDeniedHost`,
`loadAllowlist`, `resolveOptions`, `CDPConnection`, `main` (the CLI in-process). Errors:
`AgentBrowserError` (with a stable `code`) and `UsageError`, `NotAllowedError`, `PinRequiredError`,
`ReadFirstError`, `TabNotFoundError`, `ChromeUnreachableError`.

## CLI

```
agent-browser <command> [args] --state-dir DIR --allowlist FILE [--json]
              [--profile DIR] [--socket PATH] [--mode agent|personal] [--chrome-bin PATH]
              [--endpoint WS] [--personal-user-data-dir DIR] [--no-launch]
              [--notify-command JSON] [--proxy-idle-ms N] [--command-name NAME]
```

With `--json`, each call prints exactly **one JSON document** on standard output, success or failure.
Progress and warnings go to standard error. Exit status: 0 success, 1 failure, 2 usage error. Without
`--json`, the output is for people (as `vedlo browser` printed it). `agent-browser --help` lists
everything; `agent-browser commands --json` prints the machine-readable list.

A failure:

```json
{"ok": false, "command": "goto", "error": {"code": "not_allowed", "message": "refusing: example.com is not on the allowlist"}}
```

Error codes: `usage` (exit 2), `not_allowed`, `pin_required`, `read_first`, `tab_not_found`,
`unreachable`, `error` (exit 1).

Every success document has `"ok": true` and `"command": "<name>"`, plus the fields below. A `TabRef`
is `{"id": "<first 8 of targetId>", "targetId", "name": string|null, "url", "title"}`.

| Command | Result fields |
| --- | --- |
| `launch [--login]` | `started` bool, `endpoint`, `profileDir`, `login` bool, `opened` string[], `errors` `[{url, error}]` |
| `quit` | `proxyStopped` bool, `chromePid` int\|null, `closed` bool |
| `status [--notify]` | `connected` bool, `mode`, `target`, `detail` string\|null (why not connected), `product`\|null, `proxy` `{pid, upstream}`\|null, `profileDir`\|null, `allowedTabs` int\|null, `otherTabs` int\|null (a count only; never their URLs), `allowlist` string[], `window` int\|null, `notification` `{delivery: "queued"\|"unconfirmed", detail}`\|null |
| `connect <ws-url>` (personal) | `endpoint`, `product` |
| `stop` | `stopped` bool |
| `window [pin <tab> \| unpin]` | `window` int\|null, `tabs` TabRef[] (the pinned window's) |
| `tabs` | `tabs` TabRef[], `window` int\|null |
| `open <url> [--name N] [--tab]` | `tab` TabRef, `window` int\|null |
| `goto <tab> <url>` | `tab` TabRef (live URL and title) |
| `outline <tab> [--all]` | `tab`, `elements` `[{index, role, type: string\|null, label, href: string\|null}]` |
| `click <tab> <selector\|#N>` or `click <tab> --text LABEL` | `tab`, `target` string\|null, `text` string\|null |
| `hover <tab> <selector\|#N>` | `tab`, `target` |
| `type <tab> (<text> \| --stdin) [--into S]` | `tab`, `into` string\|null, `length` int (never the text) |
| `press <tab> <key>` | `tab`, `key` (Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown) |
| `text <tab> [selector\|#N]` | `tab`, `selector` string\|null, `text` |
| `eval <tab> (<js> \| --stdin)` | `tab`, `value` (the JSON value; `undefined` becomes `null`) |
| `shot <tab> [path] [--full]` | `tab`, `path`, `fullPage` bool. Refused with `read_first` until `outline` or `text` read the tab at its current URL. Default path `<state-dir>/shots/<time>.png`. |
| `fetch <tab> <url> <path>` | `tab`, `url`, `path`, `bytes` int, `contentType` |
| `download <tab> <url> <path>` | `tab`, `url`, `path`, `bytes` int, `status` int |
| `close <tab>` | `tab` |
| `net <tab> [--seconds N] [--match S] [--max N]` | `tab`, `seconds` (at most 3600), `entries`: `{kind: "http", method, url, body, status, mime, resp}` or `{kind: "ws", direction: "recv"\|"sent", data}` (redacted, clipped at `--max`, never headers; nothing after the tab leaves the allowlist) |
| `commands` | `commands`: the command list (`name`, `summary`, `usage`, `params`) |

`fetch` and `download` act through an allowlisted tab and send the profile's cookies, so their URL
must be allowlisted too. A media CDN on another host (for example Suno's `cdn1.suno.ai`) needs its
own entry in the consumer's allowlist file. `fetch` follows the page's same-origin and CORS rules;
`download` uses Chrome's network stack.

## Python adapter (`python/agent_browser`)

Python 3.10+, standard library only, full type annotations (`mypy --strict` is clean), `py.typed`.

```python
AgentBrowser(state_dir, allowlist=None, *, profile=None, socket=None, mode="agent", chrome_bin=None,
             endpoint=None, personal_user_data_dir=None, no_launch=False, notify_command=None,
             proxy_idle_ms=None, command_name=None, node="node", package_dir=None, timeout=120.0, env=None)
```

One method for each CLI command, with the same options (snake_case), each returning a frozen
dataclass:

| Method | Returns |
| --- | --- |
| `launch(login=False)` | `LaunchResult(started, endpoint, profile_dir, login, opened, errors: list[LaunchError])` |
| `quit()` | `QuitResult(proxy_stopped, chrome_pid, closed)` |
| `status(notify=False)` | `StatusResult(connected, mode, target, detail, product, proxy: ProxyInfo \| None, profile_dir, allowed_tabs, other_tabs, allowlist, window, notification: Notification \| None)` |
| `connect(endpoint)` | `ConnectResult(endpoint, product)` |
| `stop()` | `StopResult(stopped)` |
| `window(pin=None, unpin=False)` | `WindowResult(window, tabs: list[TabRef])` |
| `tabs()` | `TabsResult(tabs, window)` |
| `open(url, name=None, tab=False)` | `OpenResult(tab: TabRef, window)` |
| `goto(tab, url)` | `GotoResult(tab)` |
| `outline(tab, all=False)` | `OutlineResult(tab, elements: list[OutlineElement(index, role, type, label, href)])` |
| `click(tab, target=None, text=None)` | `ClickResult(tab, target, text)` |
| `hover(tab, target)` | `HoverResult(tab, target)` |
| `type(tab, text, into=None)` | `TypeResult(tab, into, length)`; the text goes on stdin |
| `press(tab, key)` | `PressResult(tab, key)` |
| `text(tab, selector=None)` | `TextResult(tab, selector, text)` |
| `eval(tab, expression)` | `EvalResult(tab, value)`; the expression goes on stdin |
| `shot(tab, path=None, full=False)` | `ShotResult(tab, path, full_page)` |
| `fetch(tab, url, path)` | `FetchResult(tab, url, path, bytes, content_type)` |
| `download(tab, url, path)` | `DownloadResult(tab, url, path, bytes, status)` |
| `close(tab)` | `CloseResult(tab)` |
| `net(tab, seconds=None, match=None, max=None)` | `NetResult(tab, seconds, entries: list[NetHttp \| NetWs])` |
| `commands()` | `CommandsResult(commands: list[CommandSpec])` |

`TabRef(id, target_id, name, url, title)`. `node_version()` returns the node version as a tuple.

Errors (all `AgentBrowserError`):

- `NodeNotFoundError`: `node` is missing or cannot run.
- `NodeVersionError`: `node` is older than 26.
- `PackageNotFoundError`: no `bin/agent-browser.js` in `package_dir`.
- `ProtocolError`: the output is not one JSON document of the expected shape, or the call timed out.
- `CLIError`, with `code`, `message`, `command`, `exit_status` and `stderr`. Its subclasses follow
  the code: `UsageError`, `NotAllowedError`, `PinRequiredError`, `ReadFirstError`,
  `TabNotFoundError`, `ChromeUnreachableError`.

The adapter runs `node <package_dir>/bin/agent-browser.js <command> ... --json` with
`subprocess.run` (an argv list, never a shell). Secrets never go into argv. Keep the adapter and the
CLI on the same commit.

## Pinning a commit

**npm (vedlo):**

```json
"dependencies": {
  "agent-browser": "git+ssh://git@github.com-AsyncAlchemist/agentwatch-sh/agent-browser.git#<sha>"
}
```

The host `github.com-AsyncAlchemist` is the SSH alias of the account that can read this private repo.
`npm install` then puts the package (with `python/agent_browser`) in `node_modules/agent-browser`, and
its dependency `ws@8.21.0` beside it. No `prepare` script runs, and none is needed.

**The npm release age.** The operator's global `~/.npmrc` sets `min-release-age=30` (2026-10-29):
npm installs only versions published more than 30 days ago. ws 8.21.0 was published on 2026-05-22,
so it passes. npm refuses `min-release-age` together with a `before=` line (even `before=null`), so a
consumer must not set `before=` in its own `.npmrc`; to opt out of the age rule, set
`min-release-age=0` instead (`null` does not clear the global value; tested with npm 11.12.1). Do not pin an older ws: 8.21.0 fixes a remote memory-exhaustion DoS
in 8.20.x.

**Python (agentwatch)**, one of:

1. **A pinned checkout** (the adapter finds the CLI next to itself):

   ```sh
   git clone git@github.com-AsyncAlchemist:agentwatch-sh/agent-browser.git vendor/agent-browser
   git -C vendor/agent-browser checkout <sha>
   npm ci --prefix vendor/agent-browser          # installs ws 8.21.0 from the lockfile
   ```

   Then put `vendor/agent-browser/python` on `sys.path` (or `pip install ./vendor/agent-browser/python`
   and pass `package_dir="vendor/agent-browser"`).

2. **The npm install above**: put `node_modules/agent-browser/python` on `sys.path`. The adapter finds
   the CLI next to itself there too.

3. **pip from git at a commit** (the adapter only):

   ```sh
   pip install "agent-browser @ git+ssh://git@github.com-AsyncAlchemist/agentwatch-sh/agent-browser.git@<sha>#subdirectory=python"
   ```

   pip installs only the Python files. Pass `package_dir=` to a checkout or an npm install of the
   **same** commit (for example `node_modules/agent-browser`), with `ws` installed there.

## Tests

One command runs everything:

```sh
npm ci && npm test
```

`npm test` runs `node --test 'test/**/*.test.ts'` and then
`python3 -m unittest discover -s python/tests -t python`. No real Chrome starts and no site is
contacted. `test/fake-chrome.ts` is a fake Chrome: a CDP endpoint on 127.0.0.1 with fixture pages
(a small DOM whose page code runs in `node:vm`), so the library's real page functions run against
it. Its page `fetch()` and downloads reach only the test's own fixture server on 127.0.0.1. It
records every CDP call, so a test can prove that a tab was never touched. The Python tests run the
real CLI against it (`test/fake-chrome-main.ts`). Launch tests use a fake `spawn`.

- `test/browser.test.ts`: the library through the real proxy (ported from vedlo's `chrome.test.ts`).
- `test/agent.test.ts`, `test/proxy.test.ts`, `test/diagnostics.test.ts`, `test/tab-intercept.test.ts`:
  ported from vedlo.
- `test/allowlist.test.ts`: matching, the file, the denylist.
- `test/cli.test.ts`: the JSON contract of every command, and the safety rules through the CLI.
- `test/package.test.ts`: the dependency rule, the exports, an install under `node_modules`, no
  consumer paths, no CI workflow.
- `python/tests/test_adapter.py`: the adapter against the real CLI; missing or old Node; bad output.
- `python/tests/test_parity.py`: fails when a CLI or library command has no Python method with the
  same parameters.

There is no CI workflow; the tests run locally.

## Supply chain

The only runtime dependency is `ws`, pinned exactly (8.21.0, the version vedlo vetted and ships) in
`package.json` and `package-lock.json`. The repo `.npmrc` clears the global `before=` date, as vedlo's
does, because 8.21.0 is newer than that date. `ignore-scripts=true` stays on. The Python adapter has
no dependencies. Vet any new dependency the way vedlo's `docs/supply-chain.md` says; prefer none.

## What stayed in vedlo

`launch.ts` (throwaway headless Chrome for vedlo's renderer and tests) and `orphans.ts` (the sweep
of vedlo's orphaned headless Chromes) serve vedlo's renderer, not the agent browser. They start
Chrome for Testing with `--remote-debugging-port=0`, which this repo forbids. vedlo-specific
discovery also stayed out: the `.vp` paths, the main-checkout lookup, `VP_*` variables and the
`~/.claude.json` endpoint. Each became an option above.

## Files

| | |
| --- | --- |
| `src/browser.ts` | `AgentBrowser`, `Tab`, personal-mode endpoint discovery |
| `src/commands.ts` | the operations, `COMMAND_SPECS`, result types |
| `src/cli.ts` | argument parsing, JSON and human output |
| `src/agent.ts` | the agent Chrome: binary, launch, endpoint check, pid lookup, process tree |
| `src/proxy.ts` | the multiplexing CDP proxy |
| `src/diagnostics.ts` | proxy attempt log, local status, notify hook |
| `src/allowlist.ts` | allowlist and denylist |
| `src/outline.ts` | `outline`, `redact`, `net` |
| `src/options.ts` | consumer options and their checks |
| `src/cdp.ts` | minimal CDP client on `ws` (Node's built-in WebSocket caps messages at 4 MB) |
| `index.js`, `loader.js`, `bin/agent-browser.js` | JavaScript entry points (see "Why there is a `loader.js`") |
| `python/agent_browser/` | the Python adapter |
