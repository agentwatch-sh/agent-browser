# agent-browser

agent-browser drives allowlisted tabs in Chrome over the Chrome DevTools Protocol (CDP). It came out
of vedlo's `tools/browser/` (vedlo commit `a107f03e8`). vedlo and agentwatch both use it.

Each consumer has its own **agent browser**: a separate Chrome on the consumer's own profile. It does
not share the operator's Chrome, and it holds none of the operator's logins except a sign-in that the
operator sends to it on purpose (with the operator extension, below). The operator signs in to the
allowlisted sites once inside that profile (`launch --login`), and those logins stay in that profile
only. So each consumer has its own cookies and logins, its own tab names and its own proxy socket.
Behind agent mode's endpoint (`cdpUrl`, see **Agent mode's endpoint**) there is no proxy socket:
agentwatch owns the agent browser and `launch` refuses, so the operator signs in to a site in their
own Chrome and sends that site's sign-in to the agent browser with the operator extension
(agentwatch — operator mode). The operator's own Chrome (mail, banking, admin) is not reachable from
the tooling. A consumer uses the operator's Chrome only in personal mode, only when the operator asks,
and then only in one pinned window of its own. Several callers of one consumer (for example
agentwatch's agent sessions) can share its agent browser, each in a tab scope of its own (see
**Tab scopes**).

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
| Never launch Chrome with `--remote-debugging-port`. That flag sets `navigator.webdriver`, and Cloudflare, hCaptcha and Google then block every page. The operator turns remote debugging on in `chrome://inspect/#remote-debugging` and approves once for each proxy. | `assertSafeChromeArgs` in `src/agent.ts` refuses every `--remote-debugging-*` switch and `--enable-automation` before any spawn, in every dash, slash and case form. | `test/agent.test.ts`, `test/cli.test.ts`, `test/package.test.ts` |
| The agent Chrome always runs with a window and on its own profile. `--headless` lets every page tell that the browser is headless. A caller's flags come after agent-browser's own `--user-data-dir`, so a `--user-data-dir` or `--profile-directory` among them would point the agent Chrome at another profile, for example the operator's. | `assertSafeChromeArgs` also refuses `--headless` in every form (`--headless=new`, `--headless=old`, ...), `--user-data-dir` and `--profile-directory`, in `chromeArgs`, `--chrome-args` and a library caller's launch flags, before any spawn. | `test/agent.test.ts`, `test/cli.test.ts` |
| Every connection goes through the local proxy socket. | `AgentBrowser.connect` connects only to the proxy socket (`src/proxy.ts`); there is no direct mode. | `test/browser.test.ts` ("one upstream connection"), `test/proxy.test.ts` |
| Only allowlisted hosts can be opened, attached, read or clicked. An agent never widens the list. | `src/allowlist.ts`; every `Tab` action re-reads the live URL first (`assertAllowed`), from Chrome's lists, with no code in the page: the tab's URL in Chrome's target list, then its document's URL in Chrome's frame tree; both must be on the list. A blank document's HTTP(S) `securityOrigin` must also be on the list. An opaque blank passes only for an initial blank that this connection creates, including its pinned-window path. Every other opaque blank is refused. A blank from an earlier CLI or Python command accepts no input or shot; `goto` can still leave it. On Chromium 156, a blank popup accepts no input until it navigates to an allowlisted URL. The target list shows a browser-started navigation before it commits, and an error page's failed URL. A `fetch` or `download` URL must be allowlisted too (it carries the profile's cookies). A redirect off the list is refused by host, and `net` stops recording when the tab leaves the list. The package reads the allowlist file and never writes it. No command or flag adds a host. The operator's list alone decides: there is no built-in denylist, so an entry may name a mail, account or admin host, and a broad entry such as `google.com` covers all its subdomains, `mail.google.com` included. | `test/allowlist.test.ts`, `test/browser.test.ts`, `test/cli.test.ts` (the file is unchanged, and an off-list tab gets no CDP call) |
| Never drive the operator's own Chrome unless asked. In that mode, use one pinned window. Keep off mail, banking and admin tabs: that is the operator's rule, kept by what the operator puts on the allowlist, not a check in this package. | Personal mode needs `mode: "personal"`. It acts only in a pinned window, and its first `open` makes and pins a window of its own. `launch` and `quit` refuse personal mode. No code refuses a mail, banking or admin host: there is no built-in denylist, and an allowlisted host is reachable. | `test/browser.test.ts`, `test/cli.test.ts`, Python `test_personal_mode_needs_its_own_pinned_window` |
| Read pages with `outline` or `text` before screenshots. | `shot` refuses (`read_first`) until `outline` or `text` has read that tab at its current URL. `record` is not under this rule: it makes a video for people, not a page read for an agent. | `test/cli.test.ts`, Python `test_a_full_session_returns_typed_results` |
| Never take the operator's focus, Space, pointer or clipboard: the operator shares the machine. | On macOS in agent mode each agent page gets a window of its own that comes behind the front window, and no command activates a window (no `Page.bringToFront`, no `Target.activateTarget`; a foreground tab activated Chrome), and a give-back watcher gives the front back each time the agent Chrome takes it, for as long as the agent Chrome runs, except when the operator brought it to the front (`src/watchback.ts`; **One window per agent page on the Mac**); on Linux, where the agent browser runs on a display of its own (agentwatch's Xvfb on taylor), each agent page gets a window of its own, which comes above the other windows of that display, and each input command and `record` bring that window forward with `Page.bringToFront`, also a window page behind another tab of its window before a wait or a read (**One window per agent page**); all of this only where the agent Chrome runs on a display of its own (agentwatch's Xvfb, or a display with no other program's window: `src/display.ts`), else the old rule (background tabs) holds there; on macOS `record` sends no `Page.bringToFront`; a Chrome start uses `open -n -g` on macOS (except `launch --login`, where the operator signs in). Chrome still activates itself at its first window, so `launch` on macOS can take the front for a moment, and then agent-browser gives it back: before `open` it records the app in front, and when the new Chrome takes the front from that app, it asks macOS to activate that app again (`src/giveback.ts`; the agent Chrome was in front for 79 and 132 ms in the two Mac checks of 2026-11-05, and neither start of 2026-11-06 took the front; keys typed in that time go to Chrome). The start that another command makes has no give-back: it leaves the agent Chrome in front (its first window takes the front), so Chrome's approval prompt shows in front until the operator answers it. On macOS `front` is the one command that brings the agent window forward on purpose: a person runs it to answer Chrome's prompt, no other command calls it, and the give-back watcher leaves the agent Chrome in front for it. Input is CDP input inside the tab, which never moves the real pointer (on macOS each input path starts at the page's last point, never at the real pointer), except on Linux, where agent-browser moves the X pointer to the end of each input path only on a display that holds the agent browser and no other program's window (**The pointer when a window comes forward**); `record` refuses copy, cut and paste chords. | `test/record.test.ts`, `test/agent.test.ts`, `test/giveback.test.ts`, `test/cli.test.ts`, `test/front.test.ts`; live: `test/live/takeover/` (measured 2026-10-30: no command changed the frontmost app or moved the pointer); the Chrome start: `test/live/takeover/start.ts` (measured 2026-11-04 through `launch`: with `open -n -g` alone, 12 of 12 starts on Chrome Beta and Google Chrome took the front; with the same give-back from a Swift helper, 3 of 3 starts on Chrome Beta, macOS granted each request and the operator's app was back after 83, 43 and 36 ms; the built-in give-back: `test/live/anti-detect/mac.ts` on 2026-11-05, 2 starts on Chrome Beta 158: the agent Chrome was in front for 79 and 132 ms, then the operator's app was back, and the Space did not change; in that check a site's popup from a page in a window of its own took the front until the check's watcher gave it back, 5 to 25 ms; on 2026-11-06 no start and no popup took the front: **One window per agent page on the Mac**); the give-back watcher: `test/watchback.test.ts` |
| A recording shows only an allowlisted tab. | `record` acts only on an allowlisted tab (in personal mode, only in the pinned window). When the tab navigates off the list it stops at once and writes nothing, and it never runs code in the off-list page. | `test/record.test.ts` |

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
| State folder | `stateDir` | `--state-dir` | `state_dir` | **Required**. An absolute path; the CLI and Python also take a relative one (see **Paths** below). It holds the tab record: `tabs.json`, `tab-scopes.json`, `tabs.lock` (while the tab record changes), `window.json`, `reads.json` and `tab-pages.json` (the tabs of `open --tab` on Linux); behind agent mode's endpoint (`cdpUrl`) each endpoint scope keeps that record in `endpoint-scopes/<coded-scope>/` instead (`Work-One` uses `+work-+one`) (see **The record of each endpoint scope**). It also holds `input.lock` (while an input command runs on Linux) and `pointer.json` (where each page last saw the pointer), `chrome-proxy.json`, `chrome-proxy.log`, `launches.log`, `shots/` and `recordings/` (the frames of a recording in progress, removed after each run): one of each for the agent browser, also for every endpoint scope. Created with mode 0700. One folder for each consumer. |
| Allowlist | `allowlistFile` (or `allow`) | `--allowlist` | `allowlist` | **Required** for every command that touches tabs. JSON: `{"allow": ["suno.com", "midjourney.com"]}`. A host matches itself and its subdomains. Entries are lowercase host names with a dot (or `localhost`). The list alone decides: no built-in list refuses a host. |
| Profile | `profileDir` | `--profile` | `profile` | Default `<stateDir>/profile`. Its cookies are this consumer's logins. |
| Proxy socket | `socketPath` | `--socket` | `socket` | Default `<stateDir>/chrome-proxy.sock`, mode 0600, at most 103 bytes (for a long state folder, see **A long state folder** below). |
| Notify hook | `notify` (callback or `{ command }`) | `--notify-command '["prog","arg","{message}"]'` | `notify_command=["prog", ...]` | Used only by `status --notify`. An argv list, never a shell string. The message goes on stdin, and `{message}` in an argument is replaced with it. Example for agentwatch: `["agentwatch", "session", "inbox", "--text", "{message}"]`. |
| Approve dialog | `approve` (`true`/`"osascript"`/`"xdotool"`/`{ command }`) | `--approve auto\|osascript\|xdotool` or `--approve-command '[...]'` | `approve=True` / `approve="xdotool"` / `approve_command=[...]` | Unattended only. Answers Chrome's per-connection "Allow remote debugging?" dialog once per proxy. Default off (the operator clicks). See **Unattended approval**. |
| Node | | | `node` (default `node` on PATH) | Node 26 or later. |
| Package folder | | | `package_dir` | The agent-browser folder with `bin/agent-browser.js`. Default: the checkout that holds the adapter. |

**Paths.** The paths in the Node options (`stateDir`, `allowlistFile`, `profileDir`, `socketPath`,
`chromeBin`, `personalUserDataDir`) must be absolute; a relative one is a usage error. Their CLI
flags (`--state-dir`, `--allowlist`, `--profile`, `--socket`, `--chrome-bin`,
`--personal-user-data-dir`) also take a relative path, and the CLI resolves it from its current
folder. The path of `shot`, `fetch` and `download`, `click`'s `--download` directory, and `record`'s `--out`, `--script` and `--setup`,
resolve from the current folder in the CLI and in the library alike. `--ffmpeg` is the exception: it
must be absolute. An empty path is a usage error, never the current folder: in the Node options, the
CLI flags, the command paths and the `Tab` methods that take a path. In the Python constructor an
empty string raises `ValueError`; a `Path("")` is already `Path(".")`, the current folder, so the
adapter cannot refuse it. `Tab.setFiles` and `Tab.expectDownload` give their paths to Chrome as they
are, so give them absolute paths. The Python adapter passes its paths to the CLI as they are, and runs
the CLI in the caller's current folder. Neither the CLI nor the adapter expands `~`: the shell does so
only at the start of a word (`--state-dir ~/s`, not `--state-dir=~/s`), and Python's `Path("~/s")`
keeps it. The 103-byte limit of the socket path applies to the resolved path. Give the state folder as
an absolute path: a relative one names another folder, so another profile with other logins, when the
current folder changes.

**A long state folder.** The default socket `<stateDir>/chrome-proxy.sock` must fit in 103 bytes (the
macOS limit, kept on every system). A deep state folder, for example an agent session's scratchpad on
macOS, can pass it. Then the command fails with a usage error that gives the length and names the way
out: `--socket PATH` (library option `socketPath`, Python `socket=`) with a short path in a folder that
only you can write (mode 0700). The error gives an example path that fits:
`<dir>/ab-<first 8 hex digits of the sha256 of the state folder's real path>.sock`, where `<dir>` is
the real path of `$XDG_RUNTIME_DIR`, else of `$TMPDIR`. Each folder is used only when it is this user's
and has no group or other write bit, so the shared `/tmp` is never the example; with no such folder,
the error gives no example. Every caller of that state folder must give the same `--socket`, or it
starts a second proxy. A `socketPath` that you give is used as it is; one longer than 103 bytes is
refused with the same way out and example.

Optional: `mode` (`agent` by default, or `personal`), `chromeBin` (default Google Chrome Beta when it
is installed, else Google Chrome), `chromeArgs` (extra Chrome flags at launch, e.g.
`["--enable-unsafe-swiftshader", "--lang=en-US"]`; `--remote-debugging-*`, `--enable-automation`,
`--headless`, `--user-data-dir` and `--profile-directory` are refused before any spawn, in every dash,
slash and case form; only the switch name is checked, never its value, so `--user-agent=...` passes; the
profile comes from `profileDir`; no secrets belong here because Chrome flags show in `ps`), `endpoint` (a known `ws://` endpoint, still
used through the proxy), `cdpUrl` (CLI `--cdp-url`, Python `cdp_url`: agent mode's endpoint,
`ws+unix://<socket>:/devtools/browser/<scope>` from `agentwatch browser endpoint`; each connection goes to it in place of the
proxy socket, nothing is launched, and `launch` and `quit` refuse; the proxy stays the default), `personalUserDataDir`, `noLaunch` (fail with the launch command instead of starting Chrome), `noPrompt` (never open a new
connection, so never a new approval prompt: with no approved proxy up, fail at once with `approval_needed`),
`proxyIdleMs` (default 12 hours), `commandName` (how hints name the command line, for example
`vedlo browser`), `tabScope` (CLI `--tab-scope NAME`, Python `tab_scope=`: work only in the tabs of
this scope; see **Tab scopes**), `hiddenDrive` (CLI `--hidden-drive`, Python `hidden_drive=True`: keep a
background tab's page hidden while a command drives it; default off; in agent mode on Linux only for a
tab of `open --tab`; see **A command on a background tab: two modes**), `inputTiming` (CLI `--input-timing JSON`, Python `input_timing=`: the shape of a
person's input in a window of its own (Linux and macOS), in parts, for example `{"pressMs": [70, 90], "keyMs": [90, 150]}`; see **A
person's input**) and `log` (progress lines; default standard error).

## How it works

- **The agent browser** is a regular Chrome on the consumer's profile. Any command that needs Chrome
  starts it if it is not running (`noLaunch` turns that off). On macOS that start goes through
  `open -n -g`, so Launch Services does not bring Chrome to the front. But Chrome activates itself
  when it shows its first window: Chromium's window `Show()` on macOS calls
  `[NSApp activateIgnoringOtherApps:YES]`, and `test/live/takeover/start.ts` measured it on
  2026-11-04 (12 of 12 starts took the front). So on macOS `launch` can take the front for a moment,
  and then agent-browser gives it back (`src/giveback.ts`). Before `open`, a small guard records the
  app in front. It is JavaScript for Automation, run by `/usr/bin/osascript`, and it uses AppKit only:
  no Apple Event, no System Events, no input, and no new macOS permission. When the new agent Chrome
  takes the front from that app, the guard asks macOS to activate that app again
  (`NSRunningApplication.activateWithOptions`). With the same call from a Swift helper, macOS granted
  3 of 3 requests on 2026-11-04, and the operator's app was back after 83, 43 and 36 ms. The guard
  itself ran in the Mac check of 2026-11-05 (2 starts on Chrome Beta 158; **One window per agent page
  on the Mac**): the agent Chrome was in front for 79 and 132 ms, and `launches.log` gave
  `give-back back=<pid> after-ms=121` and `after-ms=159`. So a take can last more than 0.1 s. Keys
  typed in that time go to Chrome, and macOS can refuse the request. When a full-screen app is in
  front, or when Google Chrome Beta is assigned to a desktop of its own, the take can also switch the
  Space and back, which can take longer than these takes and is not measured. The guard activates
  only the app that was in front just before the take: when you bring another app to the front while
  the new Chrome is not in front, that app takes the place of the first one. The guard watches
  until `launch` ends it, 1 s after Chrome's endpoint is up (its own limit is 15 s), so a second take
  by the same Chrome (a session restore activates its last window at its end) is given back too. It
  asks macOS at most 3 times in all for one `launch`. It cannot tell your own switch to the new
  Chrome from Chrome's activation, so in that time it can send you back to your app; after its 3
  asks, or once `launch` has ended it, it never does. `launch` waits up to 3 s for the guard to
  record the app in front, and the guard never makes `launch` fail. `launches.log` says how it went:
  `give-back=on front=<pid>/<bundle id>` on the Chrome line, then lines such as
  `give-back took=<pid> from=<pid>`, `give-back back=<pid> after-ms=<n>` and
  `give-back end=stopped by=launch`. From the end of `launch` on, the give-back watcher of the Mac takes
  over for as long as the agent Chrome runs (**One window per agent page on the Mac**). The start that
  another command makes has no give-back: it
  leaves the agent Chrome in front (its first window takes the front), so Chrome's approval prompt
  shows in front until the operator answers it. `launch --login` starts it in front,
  because the operator signs in there. Tip: only agent
  browsers use Chrome Beta, so assigning Google Chrome Beta to a desktop of its own (Dock, Options,
  Assign To) keeps every agent browser there. This is an agent browser, so it comes up
  ready: before it starts Chrome, `launch` writes `devtools.remote_debugging.user-enabled: true` into
  the profile's `Local State` (`seedRemoteDebugging`), so remote debugging is on without a
  `chrome://inspect` click. That setting is a plain, unsigned value (not the HMAC-signed "Secure
  Preferences"), so Chrome keeps it; `launch` merges it in and never overwrites other keys or a corrupt
  file. The launch still opens `chrome://inspect/#remote-debugging` as a visible fallback. `launch`
  waits up to 10 minutes for the endpoint; other commands wait 30 s.
- **Launch flags and background tabs.** A launch starts Chrome with `--no-first-run`,
  `--no-default-browser-check` and `--disable-backgrounding-occluded-windows` (`AGENT_ARGS`). The
  last one keeps an agent window behind the operator's windows visible. Without it, macOS marks the
  covered page hidden while the agent's clicks and typing still reach it, and a site can see that
  (`docs/research/2026-11-03-chrome-vs-chrome-beta.md`, section 8, check 9). The launch has no timer
  flag any more (`--disable-background-timer-throttling`, `--disable-renderer-backgrounding`; release
  v0.2.9 had both). With them a hidden tab ran a 50 ms timer at 50 ms, unlike the operator's Chrome,
  and a site can measure that. Now a tab that is not in front is hidden between commands, as in plain
  Chrome: a 50 ms timer ticks once a second, and the page gets no animation frames. After about 5
  minutes in the background, Chrome's intensive wake-up throttling can slow chained timers in a hidden
  tab to one wake-up a minute (from Chrome's documentation; not measured here). agent-browser still
  drives the tab (see the next item). A caller that needs the old timers can pass the two flags in
  `chromeArgs` (`--chrome-args`). `test/live/background-tabs/` ran on Linux only (taylor, 2026-11-04,
  Chromium 156, Xvfb): click, type, eval, text, shot and record worked in a background tab,
  also after the front tab changed, with the one flag and with all three. A hidden tab's 50 ms timer
  had a median of 1000 ms (6 ticks in 6 s); with the two timer flags, 50 ms (120 ticks). In the default
  mode a shot of a background tab took 0.2 to 3.1 s with either set (0.1 s in front), and 1 of 30 such
  shots with the one flag showed only the top 256 px of the page (0 of 25 with all three; too few to
  compare); the check now fails on such a shot. Since ab-b84.17 a shot waits for two frames before its
  capture (see the next item): 0 of 88 shots per mode were incomplete in 8 runs of each mode. On macOS
  the Mac check of 2026-11-05 (Chrome Beta 158, the one flag, the default mode) ran `text`, `click`,
  `type`, `press End`, one `shot` (274 ms) and a 3 s `record` (60 fps) in a background tab whose
  window was 100% covered, and each one worked (**One window per agent page on the Mac**;
  **Measured** under **Recording**). A hidden tab's timer rate and the share of incomplete shots are
  not measured on macOS.
- **One window per agent page (Linux; ab-v16.26).** In agent mode on Linux, `open` gives each page a
  window of its own (`Target.createTarget` with `newWindow: true, background: true`), and no command
  sends focus emulation to it. This is the design of `docs/research/2026-11-05-anti-detect-drive.md`
  ("The answer"), which measured what a site sees of each way to drive a page that is not in front,
  against a person (board task ab-v16.21). On Linux a new window from that call comes above the
  other windows without the focus. With `--disable-backgrounding-occluded-windows` (a launch flag,
  above) its page is `visible` and draws at 60 frames a second, also when another window covers it,
  as a person's window that is not in front (or on a second screen). It gets the focus only with the
  agent's input: each input command brings its window forward first (next items), and the page in
  front of the other window gets a `blur`, as when a person switches windows. Reads, clicks, typing, shots, `record`, a library
  session that waits for content that only an animation frame writes, a lazy image and an
  `IntersectionObserver` callback work with no help (the research measured 56 to 97 ms for a shot).
  The page's `Tab.drive` is `"window"`.
  - **Only on a display of its own.** The design applies where the agent Chrome runs on a display of its
    own, so that it never puts windows on a person's screen or takes their focus: behind agent mode's
    endpoint (`--cdp-url`: agentwatch's agent unit runs its Chromium on a private Xvfb), and for an agent
    Chrome that agent-browser started when every visible window on the chosen display belongs to that
    Chrome's pid. The gate checks windows through xdotool. It also requires no `WAYLAND_DISPLAY`, no
    `_NET_SUPPORTING_WM_CHECK` on the root (xprop), and no `XWAYLAND` extension (xdpyinfo).
    The extension identifies XWayland even when the compositor sets no window-manager property.
    The gate first tries `/proc/<pid>/environ`. Chromium 156 clears that environment, so the gate normally
    uses agent-browser's `DISPLAY`, `XAUTHORITY` and `WAYLAND_DISPLAY` instead. An older XWayland server
    without the extension can still pass if the command has no `WAYLAND_DISPLAY`, the compositor sets
    no `_NET_SUPPORTING_WM_CHECK`, and Chrome owns every visible X window. The server's vendor and client
    list cannot reliably distinguish that case. Use a private display for agent Chrome. That check holds
    for a minute for the same Chrome pid (`display.json` in the state folder); in that minute
    `/proc/<pid>/cmdline` of the kept pid stands in for `ps`. Elsewhere (another program's window on
    the display, a window manager, a Wayland session, XWayland, no xdotool, no xprop or no xdpyinfo,
    an endpoint that another program started, a check that fails) every page opens and is driven as
    before, in a background tab, and a log line says why, at most once in 5 minutes, at the first command
    that opens or attaches a page (`tabs`, `status` and `window` give none). No test runner skips the
    check: a test gives its
    own answer (the internal `display` option).
    **Linux requirements:** The display gate needs `xdotool`, `xprop` and `xdpyinfo`.
    Debian/Ubuntu provides `xprop` and `xdpyinfo` in `x11-utils`. Missing tools keep background tabs.
  - **A window page behind another tab of its window** is hidden, as a person's background tab: the
    opener behind a site's popup tab, an older tab of a pinned window (`open` puts each new tab there),
    a tab that an older agent-browser opened in the background, a sign-in tab of `launch --login`.
    Chrome draws nothing of it there: a click stalled for 5 s, a wait for content that a frame writes
    and `record` timed out, and after the click the page reported `hidden` with the focus (review-45,
    measured on taylor). So before input, a wait (`Tab.waitFor`), a read (`text`, `outline`, `eval`: a
    person who reads a tab switches to it, and an eval that waits for a frame, or lazy content, needs the
    page drawn) and `record`, such a page comes in front of its window with `Page.bringToFront`, as a
    person's tab switch does (`Tab.toFront`; on Linux it also activates the window). No tab ever moves to
    another window.
  - **A page that a site opens** (a `target=_blank` link, `window.open()`) stays where the site put
    it: a tab in the opener's window, in front, or a window of its own for `window.open(url, "",
    "popup,...")`. agent-browser drives it there with no focus emulation and never moves a tab into
    another window: a person cannot do that with one click, and a site sees the opener's window change.
    A sized popup (`window.open(url, "", "popup,width=500,height=400")`) does not get the size that the
    site asked for: with `--window-size=1100,700` it opened at an outer size of 1100x734 (and at 500x434
    without `--window-position` and `--window-size`). A site can compare the two sizes. agentwatch's
    agent unit passes `--window-size` (`agentwatch/daemon/browser/unit.py`, lines 542 and 543), so the
    fix of that signal is agentwatch's.
  - **`open --tab`** keeps the old modes for its tab (next item): a background tab in the current
    window, with focus emulation while a command is attached, or with `--hidden-drive` none. Use it only
    when a window is not possible: **a site can detect a background tab** that agent-browser drives in
    either mode (the research's section 4: two `visible` tabs in one window, two focused pages, input
    while `hidden`). The tab record's `tab-pages.json` lists these tabs, so that each later command
    drives them in the old mode too, also a tab that `open --tab` opened while the display was not the
    agent browser's own (the item above) and the display is its own later. A plain `open` there opens a
    background tab too, with no entry: once the display is the agent browser's own, that tab is a window
    page (a tab switch in its window before input, no focus emulation). `--hidden-drive` changes only
    such tabs. Over agent mode's endpoint
    (`--cdp-url`) the exception does not apply: agentwatch's relay opens a window for every new page
    (board task ab-v16.28).
  - **One input at a time, after the window comes forward** (`src/input.ts`). In a window of its own,
    `click`, `click --text`, `hover`, `type`, `press`, `Tab.clickAt`, `Tab.setFiles` and `record` hold the
    agent browser's input lock (`input.lock` in the state folder) from the activation to the end of the
    input, across processes. So two agents never give two pages the focus at the same time. The lock is
    one for the pages of every site (the next item). Without the lock, two agents that typed at once gave
    two focused pages for 9.6 to 12.4 s of 12.5 to 14.8 s (the research). Every caller of one agent browser must use one state folder (with tab scopes, as
    agentwatch does). Behind agent mode's endpoint the lock stays the state folder's one `input.lock` for
    every endpoint scope: only the tab record is per endpoint scope (see **The record of each endpoint scope**). A command waits for the lock up to `lockWaitMs` (10 minutes); `record` holds it
    for its take, not for the encode. A take can last up to 30 minutes (`record`'s limit), longer than
    that wait: where takes run beside other agents' input, give those agents a longer `lockWaitMs`
    (`--input-timing '{"lockWaitMs": 2000000}'`), or their input commands fail with the lock's timeout. The lock is reentrant within one call chain of one process:
    `Tab.withInput(fn)` around a caller's own `Tab.click` does not wait for itself. The wait can take
    minutes, and the page can go to a host off the allowlist meanwhile: so the allowlist is read again
    inside the lock, before any code of agent-browser runs in the page for the input, a guard stops
    every input event once the main frame has gone off the list, or has started or asked for a
    navigation to a host off it (`Page.frameNavigated`, `Page.frameStartedNavigating`,
    `Page.frameRequestedNavigation`, review-47c; also before each key's release: a keydown can take the
    page off the list, review-47b), and the list is read again
    before each press, before the first key and every 16th, and before `setFiles` gives its files
    (review-47). When the page has no focus, or is hidden behind another tab of its window, the
    command first sends `Page.bringToFront`: on
    Linux that selects the page's tab and activates its window, as a person's switch to the window does
    (measured on taylor: the same result as `Target.activateTarget`; `Page.bringToFront` also passes
    through agentwatch's relay). A page that has the focus gets none. A read (`text`, `eval`, `outline`,
    `Tab.waitFor`) of a visible window page never brings a window forward; a read of a hidden window page
    (behind another tab of its window) brings its tab in front first, inside the input lock, so that read
    waits for another agent's input command (review-47c: a tab switch during another agent's typing gave
    two focused pages). `shot` and `fetch` never bring a tab or window forward.
    `Tab.waitFor` reads its condition while the lock is busy and ends as soon as the condition holds.
    Its `timeoutMs` includes that wait; on timeout, the page stays hidden (review-47d, review-52).
    A page that a site opened in the opener's window is in front of that window; to go back to the opener, the next command on the
    opener brings it forward: a tab switch, as a person makes. Keys need this activation: keys into a
    window that is not active gave its page the focus with no switch, so two pages had the focus (the
    research's `window-keys-inactive`).
  - **One lock for the pages of every site** (board task ab-v16.46). The operator first chose one lock
    per site (ab-hbt: "Agents on one site wait; agents on different sites work at full speed"). The build
    of it (PR #55 at `e52de19`) measured on taylor that the display has one X focus: the windows of two
    sites then come forward in turn inside one command, and each page alone sees signals that a
    person's page does not show. After that measurement the operator chose one lock per browser again
    (ab-1bi, 2026-11-05: "Go back to one lock per browser"). The measurement (`run.ts --only
    design-two,design-two-sites`, 5 runs each; two agents, 6 typings of "hello" each):

    | | one lock, one site (`design-two`) | one lock per site, two sites (`design-two-sites` at `e52de19`) |
    | --- | --- | --- |
    | the work of both agents at once | 9.8 to 10.5 s | 8.2 to 8.5 s |
    | against one agent alone | 40 to 68 % longer | 20 to 28 % longer |
    | both pages focused | 0 to 100 ms | 4.4 to 4.8 s |
    | `blur` events inside a page's own commands (6 commands) | 0 | 6 or 7 |
    | a page's sequence during one command (F `focus`, B `blur`, k a key) | `[F k k k k k B]` | `[F k k B F k k k]` |

    With one lock per site each page alone saw a `blur` and then a `focus` with no press in the middle of
    its own typing (a key gave the focus back with no window switch), and the X pointer at the same
    point at each activation (10 or 11 entries at an earlier entry's point in each page): any site can
    see that in its own page, with no second page and no vendor that links sites. And a page that keys
    left with the focus behind another window kept that focus beside a later page of its own site (two
    focused pages of one site for 3.4 to 3.6 s of 3.5 to 3.7 s) until a rule brought its window forward at
    its command's end. With one lock, agents on two sites wait for each other as agents on one site do,
    and these signals do not come. Measured with one lock again (one run each, at `cb95a91`): `design`
    as before (no jump, no position change that the movement does not explain, both pages focused 0
    ms, a click in 1.28 s); `design-two` both pages focused 200 ms, 53 % longer than one agent alone;
    `design-two-sites` both pages focused 100 ms, 47 % longer, no `blur` inside a page's own commands,
    no jump, and a third agent on the first site 0 ms with two focused pages of that site.
  - **A person's input.** A pointer path of the generator in `src/human/` (board ab-t30.3; the input
    design `docs/superpowers/specs/2026-11-10-vanilla-playwright-human-input-design.md`, section 10.1):
    a time of 300 to 1000 ms by Fitts's law with a person's spread, one main sub-movement with a bell
    speed along an arc (2% to 10% of the distance), 0 to 2 end corrections, an overshoot past 500 px in
    about 30% of moves, a tremor of 0.3 to 1.2 px, a slow approach to a small target, at most 3.5 px/ms;
    one sample each 8 ms in whole pixels (no move without movement), sent at its time with no wait for
    each answer, each event with a timestamp 3 to 5 ms before its send (whole ms on Linux). It ends at a
    person's spread around the element's middle (a standard deviation of 1/8 of its smaller side, at
    most 1/4 of it, where a hit test finds the element), then a pause of 80 to 400 ms (median 140) and
    a press of 60 to 180 ms (median 100) with `force: 0.5`. Each endpoint scope moves as one person of
    its own (`pointer.json` keeps the seed). The keys follow a person's keyboard patterns
    (`src/human/keys.ts`, the design's section 10.2): each key held 50 to 250 ms (mean 116), the time
    from one press to the next with a part for each letter pair (two hands fastest), 20 to 120 ms more
    after a space, 80 to 250 ms more after a mark and 200 to 600 ms more after Enter, a speed that drifts
    from word to word, rollover (the next key down before this one is up, in about 25% of keys), a real
    Shift key (location 1 or 2) 45 to 95 ms before a capital and up 15 to 60 ms after it (a run of
    capitals keeps it down), Control and its key as a chord, the fast end (100 to 120 ms a key) after 12 s
    of typing, each event with a timestamp; in place of `Input.insertText` (a character with no US-keyboard key still goes
    as inserted text). An element out of view comes into view by the wheel (120 px a notch, 35 to 90 ms
    apart, with the pointer over the element's scroller), in place of `scrollIntoView`. `type --into` clicks the
    field in place of `el.focus()`, and `setFiles` clicks the file input (or its label) so that Chrome
    opens its file chooser, which agent-browser intercepts (`Page.setInterceptFileChooserDialog`: no
    dialog opens); the files go to the input that the chooser names only when it is the named input
    (review-47b: a frame off the list that covers the input would get them). When another element covers
    the click's point, after the path or just before the press (a second hit test, review-47c), there is
    no click; when the click opens no chooser in 2 s, or the chooser is
    another input's, the files go to the named input with no click (only when the document that holds it
    is on the allowlist). Each of these says so in a log line. agent-browser's own page code
    (reads, the input's helpers) runs with no user gesture there: a gesture makes
    `navigator.userActivation` active with no press and no key (measured: each read did). `eval` runs
    as a gesture, as before, so that an agent's expression can open a popup.
  - **The caret of `type --into`** stays where it was before this change: where `el.focus()` puts it.
    Chromium puts it at the start of a field whose text came with the page, at the end after a script
    set the value, and where it was after an earlier focus (measured, `extra.ts --exp caret`). So the
    click goes to the field's left end for the start and to its right end for the end, and keys put the
    caret right when the click did not (Home, End, the arrows; Control+Home and Control+End in a
    textarea). A field that has the focus gets no click. An editable element gets its click at the
    start of its text. These ways out leave a signal, with a log line each: a field with no box, or one
    that another element covers, gets `el.focus()`; a caret in the middle of a text of more than 64
    characters is set by `setSelectionRange`; an element that the wheel cannot bring into view is
    scrolled by a script; a file input with no box and no label gets its files with no click.
  - **The pointer when a window comes forward.** The X server then gives the page a real pointer event
    at the X pointer. Each path starts at that event's point (a listener in agent-browser's isolated
    world reads it), else at the page's last point (`pointer.json`). Where agent-browser can reach the X
    pointer, the last step of each path is a move of the X pointer (`xdotool mousemove`, inside the
    lock; Chrome gives the page that real move with its movement from the path's last point), so the
    pointer is one pointer for all the windows, as a person's mouse is: the next activation enters
    where the last path ended. It does so only when xdotool is on `PATH`, the display is the agent
    browser's (the activation's real event came where xdotool says the pointer is) and the display holds
    no other program's window (checked for each command): agentwatch's Xvfb when agent-browser's
    commands have its `DISPLAY` and `XAUTHORITY`, or the display of an agent Chrome that agent-browser
    started. When the method is off for any reason (no `DISPLAY` over the relay, no xdotool, a device
    pixel ratio that is not 1, a display that cannot be verified, another program's window), a log line
    says why, at most once in 5 minutes for each reason. Over agentwatch's relay agent-browser reaches no X:
    there the relay has agentwatch's daemon move the X pointer at each activation (**The pointer at an
    activation**, under agent mode's endpoint). The two ways of the research, measured on taylor (`extra.ts --exp pointer`: three windows
    at one place, two agents and the operator's page in turn, 3 activations of each agent window):

    | the pointer at each activation | jumps over 100 px | position changes that the movement does not explain |
    | --- | --- | --- |
    | a person (the stand-in window manager raises the window; the pointer does not move) | 0 | 0 |
    | each path starts at the page's last point | 3 in each window | 2 in each window |
    | each path starts at the X pointer, which never moves (also when the page's real event gives its place) | 0 | 2 in each window |
    | each path starts at the page's last point, and the X pointer moves to each path's end | 1 in each window, at its first activation only (this build starts that path at the real event) | 0 |

    So this build takes the first way of the research (move the X pointer to the end of each path) where it
    can, and the second way (start each path at the X pointer, never move it) where it cannot.
  - **Measured with the whole design** on taylor (`run.ts --only person-window,person-window-multi,design,
    design-no-x,design-two`, 2 runs on 2026-11-05 after review-47, and 4 runs before it with the same
    results except where named; Chromium 156 in a private Xvfb; agent-browser's own commands; F's window
    takes the focus after each input step, so T's window comes forward 6 times). Against the person
    baselines, `design` showed no pointer jump, no position change that the movement does not explain,
    no scroll with no wheel or key, no field focus with no press, no user activation with no input, no
    action while `hidden`, no untrusted event, pressure 0.5, a press of 86 to 88 ms (the person's 76 to
    77), 5 `keydown` for 5 characters, and both pages focused for at most one 100 ms sample at a switch.
    Each step had the person's sequence: the window's `focus`, the real event where the window came
    forward (no movement, at the page's last point), then moves that each move, the press and the
    release; 50 to 55 moves before a press (the xdotool person: 20). Before review-47 one more move with no
    movement came after each press, from the X pointer's move after the path; now the X pointer's move
    is the path's last step. Every step worked: a shot in 99 to 108 ms, a `record` with no visibility
    change, a library session that waits for content that a frame writes (0.83 s), a lazy image 119 to
    130 ms after End. `design-no-x` (no X pointer, as over agentwatch's relay today) entered at the X
    pointer's one point at each activation: 5 position changes that the movement does not explain and 5
    entries at an earlier entry's point in 6 activations, and a jump at the start of `record` (its cursor
    starts inside the recorded size). `design-two` (two agents at once, one input lock, 6 typings each):
    both pages focused for 0 to 200 ms (one or two 100 ms samples at a switch; review-47c's runs); no jump; 1 position change in one page that the movement does not
    explain, where its window came forward under the pointer that the other agent's path left (one
    pointer for both windows, as for a person who switches windows); every typing arrived whole ("hello"
    12 times in each field).
  - **The cost.** Input: a click took 1.20 to 1.33 s with an activation and a path of some hundred
    pixels (the research's estimate, with fixed paths of 0.3 s: 0.5 to 0.9 s; the path here takes 300 to
    1000 ms by Fitts's law, as `record`'s cursor), `type --into` with 5 characters 1.25 to 1.30 s, a click
    below the fold 1.34 to 1.44 s (with the wheel), and each further character about 0.12 s (measured before the
keyboard model of board ab-t30.4; with it, about 0.2 to 0.3 s for the first 12 s of a run). The lock: two
    agents that type at once took 39 to 57% longer than one agent alone (3 runs after review-47; before it:
    46 to 56%; the research: 28 to 55%). Windows: in the research's check, 8 probe pages as 8 windows used 608 to 775 MB
    (PSS) and 5.3 to 6.8 CPU-seconds in 10 s, against 355 to 404 MB and 1.0 to 2.4 CPU-seconds as 8
    background tabs: 32 to 46 MB more for each window, and every agent page draws at full rate, also
    behind another window. The input timing is the `inputTiming` option (CLI `--input-timing JSON`,
    Python `input_timing=`), in parts: `pressMs` [60, 180], `keyMs` [20, 3000], `holdMs` [50, 250],
    `settleMs` [80, 400], `wheelMs` [35, 90] (ranges in ms: they bound the person's draws; `keyMs`, the
    time from one key press to the next, does not bind the keyboard model by default), `moveScale` 1 (a factor on each path's time), `activateMs` 1000 (the wait for the focus after `Page.bringToFront`), `showMs` 2500 (on macOS, the wait
    for a hidden window page to show again: **One window per agent page on the Mac**) and `lockWaitMs`
    600000.
  - **What a site can still see** (the research's section 8, and the runs of this build): the pace and
    the patterns of an agent (no idle pointer, no behaviour model; not measured); a covered agent window
    that draws at 60 frames a second, where a person's covered window is `hidden`; over agentwatch's
    relay, the pointer at each activation (above), and for a Playwright client also its raw input and
    two focused pages with two agents at once (the relay passes raw `Input.*` calls: board task
    ab-v16.28); the window geometry of Xvfb with no window manager, and a sized popup at
    `--window-size`'s size; `history.length` 2 for a page that agent-browser opens (`about:blank`, then
    the URL); `record`'s device metrics override and its overlay in the DOM (see **Recording**), and
    its cursor's first move when the page last saw the pointer outside the recorded size, its own
    input (its presses have `force: 0.5` and 70 to 90 ms, but its cursor's path has no X-pointer step, and
    it types at its script's pace: 55 ms a character by default, faster than a person's `type`),
    the user activation of its `eval` steps, and one move with no movement at the pointer's place when
    its size override takes effect (Chrome's own); `eval`'s user activation (an agent's
    expression runs as a user gesture, so that it can open a popup); the ways out of the caret item above, each with a log line; `outline`'s
    `data-agent-browser-idx` attribute; and the identity of the machine (the earlier report).
  - **The Mac** has its own variant of this design (next item, board task ab-v16.27). Personal mode keeps
    its own pinned window with focus emulation on both systems.
- **One window per agent page on the Mac (ab-v16.27).** In agent mode on the Mac (not behind agent mode's
  endpoint: the relay keeps its tabs there), `open` gives each page a window of its own with
  `Target.createTarget` and `newWindow: true, background: true`, and no command sends focus emulation to
  it, as on Linux. Unlike Linux, no command ever activates a window on the Mac: no `Page.bringToFront`, no
  `Target.activateTarget`, no `chrome.windows.update({ focused: true })` (on the Mac each of them brings
  the agent Chrome to the front, over the operator's app). The Mac runs of 2026-11-05 and 2026-11-06
  (below) measured what this gives:
  - **The windows.** Each new agent window comes behind the front app's window, on the current Space,
    and draws at 60 frames a second with `--disable-backgrounding-occluded-windows` (a launch flag).
    A CDP click does not bring its window forward, and it gives the page the focus with no activation:
    the front app stays the operator's. Keys reach a window that is not active. So input needs no
    activation: each input command sends its CDP input to the page as it is (`src/input.ts`).
  - **A person's input**, as on Linux (**A person's input**; the same `inputTiming`), with one
    difference: each pointer path starts at the page's last point (`pointer.json`), and never at the
    real pointer, which agent-browser never reads or moves on the Mac. The fixed start point of the Mac
    check of 2026-11-05 gave the probe page a jump of 553 px; a path from the page's last point gave
    none in the dry run on taylor (the Mac run of this build measures it on the Mac). The first path in a
    page starts at a point in its middle (the page saw no pointer before).
  - **Two agent windows can both have the focus** (the operator's answer ab-or9, 2026-11-06: "Accept it
    and write it down"). A click in one agent window gives its page the focus, and the page that had it
    gets no `blur`: no activation sends one on the Mac. In the Mac runs two agent pages had the focus at
    once for 1.2 to 3.8 s, the whole time that the check watched. One site sees this only in two of its
    own pages at once (`BroadcastChannel`, `localStorage`, its servers), or an anti-bot vendor across
    sites, and only while two agents work at once. The input lock (one input at a time) stays.
  - **The popup rule.** A `target=_blank` link or `window.open()` with no features opens a tab in the
    opener's window, in front, with no focus; the opener goes `hidden` (on 2026-11-06 it kept its focus
    behind a `target=_blank` tab, with no `blur`, and got a `blur` behind a `window.open()` tab).
    agent-browser drives the new tab where the site put it. The way back to the opener is only
    the popup's close (`close`, or the page's own `window.close()`): CDP has no tab switch without an
    activation on the Mac, so agent-browser never switches tabs there. After the close the opener shows
    `visible` again about 1.0 s later (1006 to 1012 ms in the run of 2026-11-06). So an input command, a
    `record` and a wait on a hidden window page first wait, with no activation, until it shows again,
    at most `showMs` (2.5 s; `Tab.waitShown`). Input to a page that stays hidden (its popup tab is still
    open) fails with an error that says to close the tab in front of it; a read (`text`, `outline`,
    `eval`) goes on in the hidden page, with a log line. `window.open()` with
    `popup,width=500,height=400` opens a window of its own, and its opener stays `visible`.
  - **The give-back watcher** (`src/watchback.ts`; the operator's answer ab-or9: "Give the front back
    at once"). Chrome can make the agent Chrome the front app by itself: a site's popup took the front on
    2026-11-05 until the check gave it back (5 to 25 ms), and the start's take has its own guard
    (`src/giveback.ts`). While the agent Chrome is the front app, the operator's keys go to it. So for as
    long as the agent Chrome runs, a watcher records the operator's front app and asks macOS to activate
    it again each time the agent Chrome takes the front, as the start's guard does (`osascript`,
    JavaScript for Automation, AppKit's `activateWithOptions`: no Apple Event, no System Events and no
    input; 3 asks 250 ms apart for each take). A take still lasts some milliseconds
    (the start guard's takes ended after 79 and 132 ms), and a key typed in it can still reach the agent
    Chrome. When another app comes to the front, that app is the one to give the front back to: the
    watcher gives the front back to the app that was in front before the take, which is not always the
    operator's own app: it can be a system prompt (for example a permission dialog), `loginwindow` (the
    lock screen) or any other app that was in front then (review-69c N3).
    - **It never fights the operator.** A take of the front is the operator's own, and the watcher
      leaves the agent Chrome in front until another app comes to the front, when at the take: a mouse
      button was down less than 1 s before (a click on an agent window, on its Dock icon or in its Dock
      menu, Mission Control, App Exposé; AppKit's pressed buttons, sampled every 25 ms, and CoreGraphics'
      time since the last mouse press, for a quick tap); the Command key was down less than 1 s before
      (Cmd-Tab); `front` asked for the front (a hold file that `front` writes, `give-back-hold-front.json`:
      3 s ahead, renewed each second while `front` runs and for 3 s after it, so a killed `front` leaves it
      at most 3 s; at a caller's stop, the Mac check's, `front` removes it within a second, also while its
      request still runs, review-69d and review-69e);
      a proxy of this state folder waits for Chrome's "Allow remote debugging?" answer (a hold for its
      handshake, `give-back-hold-approval.json`), so the prompt can stay in front; or the agent Chrome was
      the front app when the watcher started (a start with no give-back, or `launch --login`). A click or
      the Command key during a take that the watcher is giving back makes that take the operator's too.
      Keys alone do not count: a person who types in their own app while a popup takes the front gets the
      front back at once (else their next keys go to the agent Chrome). So a switch to the agent Chrome by
      keys alone other than Cmd-Tab (Spotlight or a launcher with Return) is given back once; Cmd-Tab, a
      click and `front` reach it. With no reading of the person's input (the JavaScript bridge has
      neither AppKit's state nor CoreGraphics' time) the watcher does not watch.
    - **When it runs.** `launch` starts it at its end (after the start's own guard), and each command
      that connects on the Mac makes sure that it runs (after the proxy is up: after an approval that a
      new connection needed): a detached node process, `agent-browser give-back-watch`, with `osascript`
      as its child, one for each agent Chrome of a state folder (`give-back-watch.json`). It ends when
      the agent Chrome quits: it checks the pid every 250 ms (a signal 0) and every 5 s that `ps` shows
      that pid as the agent Chrome on this profile, and the script looks the pid up again every second
      (in the run of 2026-11-06 the prototype's own check, AppKit's `isTerminated`, missed the quit of a
      second Google Chrome instance for 3.8 s). The script ends when its node process is gone (its parent
      pid, used only when its first value is that process, and a beat every 250 ms on a pipe that only
      that process reads). `quit` stops it at once. A watcher that could not watch (its script ended while
      the agent Chrome runs: no reading of the person's input, an error) is not started again for that
      agent Chrome for 10 minutes (`give-back-watch-failed.json`). Its lines go to `launches.log`:
      `watch-back watch agent=PID before=PID ... input=nsevent+cg`, `took=PID from=PID [own=click|command|front|approval|start]`,
      `asked=PID n=N sent=BOOL`, `back=PID after-ms=N asks=N`, `refused=PID asks=N`, `before=PID`,
      `end=WHY` (the script's) and `end=WHY by=node` (its node process's). It starts about 2 to 3 s after
      a `launch` (after the start guard's end and the starts of node and osascript); in that time only the
      start guard (until about 1 s after the endpoint is up) gives the front back.
    - **Not measured yet**: the watcher as built runs on the Mac only in the next Mac check (`mac.ts`
      runs it; ab-v16.27's Mac run). Its rule is tested against a fake AppKit bridge
      (`test/watchback.test.ts`); whether the JavaScript bridge gives AppKit's input state and
      CoreGraphics' time on the Mac is not measured (its `watch` line says which it has), nor whether
      macOS asks for a permission for them (the check's own watcher, a compiled Swift program, reads the
      same CoreGraphics time with no prompt; the start guard and `front` need none).
  - **What a site can still see** on the Mac: two focused agent pages (above), a covered agent window that
    draws at 60 frames a second, and the items of Linux's list that do not depend on Xvfb (the pace,
    `history.length` 2 for a page that `open` opened, `record`'s and `eval`'s signals).
- **The Mac runs (ab-v16.44, ab-v16.68).** The Mac check
  (`test/live/anti-detect/mac.ts`; see **Tests**) ran on the operator's Mac on 2026-11-05, in Google
  Chrome Beta 158.0.8127.18 as the agent Chrome, on a new profile, with today's start and flags
  (`open -n -g`, the give-back, `--disable-backgrounding-occluded-windows`) and nobody at the Mac.
  The check adds its own flags (`MEASURE_ARGS` in `test/live/anti-detect/mac.ts`):
  `--remote-debugging-port=0`, `--disable-background-networking`, `--disable-component-update`,
  `--disable-sync`, `--disable-default-apps`, `--host-resolver-rules`, `--proxy-server` and
  `--proxy-bypass-list` (no network but its probe pages), and `--use-mock-keychain`. The operator's
  Google Chrome was in front. Run 2 ran every step in 78 s and gave exit 1, the expected result: its
  only problems were popup takes of the front that came back. Run 1 stopped after 25 s, when the
  operator used the Mac. These runs measured the Mac before the build (ab-v16.27, the item above): agent
  mode then opened background tabs.
  - **Where each new agent window comes.** The start's first window, two windows from
    `Target.createTarget` with `newWindow: true, background: true` (WA and WB), and the window of
    `window.open(url, "", "popup,width=500,height=400")` each came behind the front app's window, 100%
    covered, on the current Space (CGWindowList order). The start's first window and the sized popup
    came directly behind the front window (above 7 of the operator's 8 windows, below 1). WA and WB
    came behind all 8 of the operator's windows. A CDP click did not bring its window forward: WA
    stayed above WB through every step.
  - **The front app.** The agent Chrome's start made it the front app for 79 ms (run 1) and 132 ms
    (run 2), and agent-browser's give-back gave the front back to the operator's Google Chrome. Each
    popup step made the agent Chrome the front app until the check's watcher gave the front back: the
    `target=_blank` link after 25 ms, `window.open()` after 9 ms, the sized popup after 7 and 5 ms.
    These times end at the give-back: they do not say how long Chrome keeps the front. With no
    give-back the length of a take is not measured, and agent-browser's own give-back ends with
    `launch`. Keys typed during a take go to the agent Chrome: that is the macOS rule for the front
    app, and this check did not measure it. No other step changed the front app. The operator's
    Google Chrome was in front at the start and at the end.
  - **The Space.** No step changed it.
  - **Drive and record in a covered window of its own** (no focus emulation, no activation). The page
    stayed `visible` and drew 60 frames a second. `text` took 11 ms, `click` 24 ms, `type` 12 ms,
    `press End` 8 ms and `shot` 85 ms; a 3 s `record` got 60 fps (largest gap 18 ms).
  - **A background tab** (agent mode on the Mac before the build, the default mode, in the covered first
    window). The page was `visible` only while a command ran: 9 to 23 ms for `text`, `click`, `type` and
    `press End`, 269 ms for `shot` (274 ms in all), and 5.2 s for a 3 s `record` (60 fps, largest gap
    18 ms; **Measured** under **Recording**).
  - **Two agent windows.** A CDP click gives its page the focus with no activation: the front app stays
    the operator's. The other agent page gets no `blur`. After the first click in WB, WA and WB both had
    the focus for the whole time that the check watched each step (1.2 to 3.7 s). Keys sent into WA with
    no click, while WB had the last click, arrived in WA's field. On Linux a window comes forward for
    input, and the other page gets a `blur` (above).
  - **Person-shaped input** (the check's own CDP input, in WA): 20 moves, a press of 72 ms, pressure
    0.5, 5 `keydown` for 5 characters, and 1 pointer jump. The jump is the path's first move: the path
    started at a fixed point of the page, 553 px from the page's last point, because the real pointer
    was not over the page.
  - **Popups** (from WA, a page in a window of its own). A `target=_blank` link and `window.open()`
    with no features opened a tab in WA's window. The popup tab was `visible` with no focus (PA got a
    `blur` at its load). The opener WA went `hidden` (47 ms and 23 ms after the step began, with the
    check's click) and kept the focus, with no `blur`, until the check closed the popup.
    `window.open(url, "", "popup,width=500,height=400")` opened a window of its own: its page had no
    focus, and WA stayed `visible` with the focus. That popup asked for 500x400 and got an inner size
    of 500x399 and an outer size of 500x466. Each popup page had `history.length` 1. On Linux (the
    research's section 6) the popup tab comes in front with the focus, and the opener gets a `blur`;
    the sized popup's window gets the focus, and the opener gets a `blur` too.
  - **The real pointer.** No probe page got an event at its point. The check never moves it.
  - **What an API gives.** The agent Chrome had 3 windows, all on the current Space (CGWindowList), so
    Mission Control can show them, and App Exposé and the Dock menu of its icon can list them. It is a
    regular app with a Dock icon and a Cmd-Tab entry of its own
    (`docs/research/2026-11-03-chrome-vs-chrome-beta.md`, section 8, check 6), and it was not active
    when the check read it (before the popups). Cmd-` goes through the windows of the front app only,
    so in the operator's app it does not reach an agent window (from that check; not seen in this
    one).
  - **Not measured.** Mission Control, App Exposé, the Dock menu and Cmd-` as the operator sees them:
    that needs the check's `--look 60` with the operator at the Mac. Window activation
    (`Target.activateTarget`, `Page.bringToFront`, the relay's
    `chrome.windows.update({ focused: true })`): the Mac design never sends it. Google Chrome
    (stable) as the agent Chrome. The relay and the agent extension
    (`chrome.windows.create({ focused: false })`): Google Chrome on macOS does not load the extension
    from the command line. The way back to an opener behind a popup tab with no activation: the check
    closed each popup with `Target.closeTarget`. A popup from a background tab, a full-screen app in
    front, Chrome Beta assigned to a desktop of its own, and a second display. (The run of 2026-11-06,
    next item, measured Google Chrome stable, the way back to an opener and a popup from a background
    tab.)
  - **The run of 2026-11-06 (ab-v16.68).** The check of PR #66 (at dc54cb1) ran on the operator's
    Mac on 2026-11-06 with nobody at the Mac: the way back to the opener with no activation, popups
    from a background tab, agent-browser's give-back watcher (a prototype in the check), and Google
    Chrome (stable) as a second part (see **Tests**). It ran every step in 132 s and gave exit 0 in
    both parts: no step took the front, and the Space did not change. The first part ran in Google
    Chrome Beta 158.0.8127.18 (about 100 s); the second part ran in Google Chrome 156.0.8078.81 (32 s),
    as a second instance beside the operator's own Google Chrome. The operator's Google Chrome was in
    front at the start and at the end of each part. An earlier run
    that day refused before anything started (exit 2): the screen was locked.
    - **The way back to the opener, with no activation** (from WA, a page in a window of its own; the
      same in both Chromes). Each of the four ways ran without a failure; each step took 518 to 809 ms,
      with the check's wait of 0.5 s (after the click) or 0.7 s (after the target was gone), and the
      close itself about 70 to 110 ms: a CDP click in the `target=_blank` popup tab PA (518 and 536 ms),
      `Target.closeTarget` of PA (809 ms), `window.close()` in PB, the `window.open()` popup (796 and
      769 ms), and `Target.closeTarget` of the sized popup window PC (809 and 808 ms). The front app and the Space did not change, and
      WA's window stayed behind the front app's window, 100% covered. A popup tab made WA `hidden`
      24 to 46 ms after the click. WA kept `document.hasFocus()` true behind PA; behind PB it got a
      `blur` and lost the focus. After PB closed itself, WA got a `focus` event 5 to 11 ms after the
      step began, while it was still `hidden`. After PA or PB closed, WA came back `visible` about
      1.0 s after the close request (1006 to 1012 ms after the step began), with `document.hasFocus()`
      true. The check's own read, 0.7 s after the popup's target was gone, still gave `hidden`. The
      sized popup window did not hide WA.
    - **Popups from a background tab** (agent mode before the build, with agent-browser's `click`). Both
      `target=_blank` links opened a tab in the opener's window, `visible` with the focus, and neither
      took the front. So this run has no sample for the step with no give-back (2 s) and none for the
      give-back watcher's times per take. In this run no popup took the front in either part; on
      2026-11-05 each popup step took it until the check gave it back, 5 to 25 ms. This run does not
      tell why.
    - **agent-browser's give-back watcher** (the prototype in the check: `osascript`, JavaScript for
      Automation). It was ready in 79 ms in both parts, and named the operator's app as the app to
      give the front back to. JavaScript for Automation can call `getppid` on the Mac (`ppid=yes` in
      `watch-back.log`). It saw no take. In the first part it ended 304 ms after the quit of the agent
      Chrome began (`end=agent-gone`). In the second part it did not see the quit of its agent Chrome
      (a second instance of Google Chrome), and the check ended it 3.8 s after that quit began
      (`end=stopped by=check`).
    - **The starts.** Neither agent Chrome took the front at its start in this run (on 2026-11-05:
      79 and 132 ms); agent-browser's give-back guard watched each start and asked nothing. The first
      window of the Google Chrome stable instance was not on screen.
    - **The rest, as on 2026-11-05** (Chrome Beta). The start window, WA, WB and the sized popup came
      behind the front app's window, 100% covered, on the current Space; `target=_blank` and
      `window.open()` with no features opened tabs. Each 3 s `record` got 60 fps (254 frames in 4.23 s,
      largest gap 18 ms), in a background tab and in a window of its own. Two agent pages had the focus
      at once for 1.2 to 3.8 s. No probe page got an event at the real pointer's point.
- **A command on a background tab: two modes** (personal mode, and an explicit `open --tab` in agent
  mode; before ab-v16.27 also every page of agent mode on the Mac). Chrome draws no frame of a tab that is not in front,
  and its page reports `hidden`. There a page that never drew a frame (it loaded in the background, or
  after a `goto` there) drops clicks and keys, a mouse move waits up to 5 s for a frame, and a shot
  can wait for ever.
  - **A shot, in both modes** (ab-b84.17). Chrome ends a `Page.captureScreenshot` only when the frame
    that it forces is presented, and a frame of a background tab is never on screen: it counts only
    when a later frame replaces it. A page that changes by itself (a caret, an animation) draws one. On
    a page that does not change, only a later capture does, and Chrome then ends every earlier capture
    with it. But two captures sent before Chrome draws a frame share the frame that they force, and
    nothing replaces it: then both wait. So a lone capture waits for ever, also in the default mode,
    where the page is `visible`. A shot therefore keeps one capture in flight (`Tab.whileDrawnForShot`), waits
    for two frames, and then takes its own capture: the frame between the two captures is what ends
    both. Without the wait, 8 of 8 default-mode shots and 4 of 4 `--hidden-drive` shots failed after
    30 s (review-41 on taylor). The second frame also makes the picture complete: a frame that Chrome
    draws just after it starts to draw a page can lack the tiles below the first row. In the default
    mode Chrome draws a background tab about once a second, so the wait takes up to 2 s there. Its
    limit is 5 s. When the limit comes first, a log line says so: with one frame the shot goes on, and
    with none it fails at once with a clear error (Chrome would end neither capture). The first
    capture can end before the shot's own goes out: `shot --size` and `shot --full` lay the page out
    again, and with `--hidden-drive` that relayout ended the first capture of a still page in the 0.5 s
    settle. So before the own capture of such a shot, when no capture is in flight, the shot sends a
    new first capture and waits for two frames. Any other shot's own capture that has not ended after
    3 s gets one more capture to end it, with a log line, and the shot waits until all of them ended.
    No capture goes out while a full-page capture waits, because it would set that capture's emulation
    again when it ends. When the tab goes to a new page during the shot, Chrome may not end a capture
    of the old page (in the default mode the shot's own capture waited 30 s; after a same-site
    navigation one ended 50 ms after the shot failed): the shot fails at once with a clear error. After
    its own capture, the shot checks the allowlist again, and it writes no file for a tab that left it.
    `shot --size` clears its size override only when none of its captures sent under the override is
    still in flight: such a capture sets the override again when it ends, and one that ends after the
    clear leaves the view at the shot's size (measured on taylor with Chromium 156 on 2026-11-06 with
    `test/live/background-tabs/override.ts`, a tab with a capture under the override in flight: 3 of
    3 when a later capture of the same session ended it after the clear, and 6 of 6 with the page
    hidden, where the clear's own relayout ended it). So after a failure its last captures go out under the override, before the clear. When they
    do not end either (Chrome draws nothing), the override stays set, with a log line, until the
    command ends: Chrome then clears it at the end of the command's session and drops those captures
    (6 of 6: the view had its own size again, and their late end changed nothing). On a `Tab` that a
    program keeps attached, the tab's next input, shot, record or `goto` ends them under the
    override, then clears it (one at a time); a read before that (`text`, `outline`, `eval`,
    `waitFor`) sees the shot's size. Input, a shot and record first check the page, and refuse a page
    off the allowlist or out of the pinned window with no capture. `goto` does not check the page that
    it leaves (only the URL that it goes to), so it can still leave such a page: there only those
    captures and the clear go before the navigation, and no code of agent-browser's. The page's own
    code can still run for them: a capture makes Chrome draw the page, so its `requestAnimationFrame`
    callbacks run, and the clear can fire its `resize` handlers.
    In the default mode every page is `visible`, so a tab in front gets the capture
    in flight too; there it ends after a frame. Measured on taylor on 2026-11-05 (12 shots of a still background page per
    mode): the two frames came in 0.02 to 2.03 s in the default mode (2 of 12 after the old limit of
    2 s) and in 0.02 s with `--hidden-drive`; the shot's own capture then ended in 1.07 to 2.10 s and
    in 0.07 s. No run of the live checks logged a limit or an extra capture. With no wait (a mutation
    check), 9 plain and `--size` shots waited alone, and the extra capture ended each at 3.1 to 4.1 s;
    a default-mode `--full` shot failed after 30 s with the clear error.
  - **Default.** A command turns on focus emulation (`Emulation.setFocusEmulationEnabled`) when it
    attaches. Then the page is `visible`, and Chrome draws it, until the detach. A site sees a
    `visibilitychange` to `visible` and one back for each command, and a `focus` and a `blur`.
    Measured on taylor in 3 runs of `test/live/background-tabs/visibility.ts` (main before ab-v16.15,
    and 2 of this release): 9 to 26 ms for eval, text, outline, type and press; about 1 s for a hover
    or the first click in a tab; 3.1 to 4.1 s for a shot, 2.6 to 3.1 s for `shot --size` and 0.25 to
    0.5 s for `shot --full`; 5 s for a 3 s recording. Before ab-b84.17, in all 4 runs (one more on
    2026-11-04), a shot of a new background tab failed after 30 s, and the page was visible for those
    30 s. Since ab-b84.17 (on 2026-11-05, 4 runs of `check.ts` and 2 of `visibility.ts`): a shot of
    a background tab took 0.6 to 4.1 s (median 1.8 s; the page is visible for that time), of a new tab
    0.1 to 1.8 s in `check.ts` (median 0.7 s) and 1.1 to 4.1 s in `visibility.ts`, of a tab in front
    0.1 s; `shot --size` 1.1 s and `shot --full` 0.1 s. That time is Chrome's: in this mode Chrome
    draws a background tab about once a second, and the shot waits for two frames (up to 2 s), then
    for its own capture (1 to 2 s). A second shot right after the first one took 0.1 s (2026-11-04).
  - **`hiddenDrive`** (CLI `--hidden-drive`, Python `hidden_drive=True`; ab-v16.15). No focus
    emulation. For `click`, `hover`, `type`, `press`, `Tab.clickAt` and `shot` in a background tab,
    agent-browser keeps one `Page.captureScreenshot` in flight (`Tab.whileDrawn`; for a shot
    `Tab.whileDrawnForShot`): while it waits, Chrome draws the tab, and the page stays `hidden` (a
    hidden capture). A last capture ends them
    all, and after it Chrome draws nothing again. A tab in front needs none. `record` turns focus
    emulation on for its run only. Measured on taylor in 7 runs: eval, text, outline, hover, click,
    type, press, shot, `shot --size`, `shot --full`, open and goto (also in a new tab and after a
    goto) had no visible time and no `visibilitychange`, and the page drew no frame in the second
    after; each took 18 to 140 ms (0.9 s for `shot --size`, with its 0.5 s settle); a shot of a new
    tab took 0.1 s. On a still page, `shot --size` took 3.6 s at f18805e (its first capture ended in
    the settle, and the 3 s fallback ended the shot's own), and 0.6 s with the new first capture
    (review-41b, 5 of 5). In 8 runs of `check.ts` (ab-b84.17), a shot of a background tab took 84 to
    133 ms, and of a new tab whose page never drew a frame 85 to 118 ms. What a site can still see:
    (1) `record` makes the page `visible` for its run, 4.6 s for a 3 s script: Chrome sends no
    screencast frame of a hidden page, and with a hidden capture in flight it sends half of them (90 in
    3 s, not 180), unevenly. (2) While an input command or a shot runs (0.1 s; 0.9 s for
    `shot --size`), the hidden page draws frames and runs `requestAnimationFrame`, as a tab that is
    shared or captured does; it reports `hidden` all the time. (3) The page gets trusted input while it
    is `hidden`. A person cannot do that, and the launch flag above prevents the same signal for a
    covered window. Chrome's input focuses the page: two `focus` events, then `document.hasFocus()` is
    `true`, and no `blur` follows until the operator changes tabs. Without focus emulation no CDP call
    takes the focus back. (4) Between those commands, and during `open`, `goto`, `text`, `outline`,
    `eval` and `waitFor`, a background page draws nothing: `requestAnimationFrame`,
    `IntersectionObserver` and CSS transitions wait. Content that appears only on a frame does not
    appear, a `waitFor` for it times out, and `transitionend` does not fire. A library session (one
    `AgentBrowser`, several `Tab` calls) that waits for such content in a background tab needs the
    default mode, or the tab in front. This mode is measured on Linux only.
  - Both modes leave signals that a person's page never shows. The measured comparison with a
    person, and the recommended design (one window per agent page, no focus emulation, input in a
    person's shape), are in `docs/research/2026-11-05-anti-detect-drive.md` (board task ab-v16.21). On
    Linux that design is built (the item before this one; ab-v16.26).
- **The approval prompt still applies.** Seeding removes the toggle click, not Chrome's own per-connection
  approval dialog. On first connect Chrome asks the operator to allow it, once per proxy (below). On a
  headless server with no one to click, set the `approve` option so agent-browser answers that one dialog
  itself (see **Unattended approval**); do not fall back to `--remote-debugging-port`, which sets `navigator.webdriver`.
- **Which window asks.** Several agent browsers can run on one machine, and their windows look the
  same. So a launch gives the window a name after the consumer (Chrome's `--window-name`): its command
  name and its state folder, for example `agent-browser: /Users/me/.vedlo/agent-browser/marketdata`.
  It is the name that Chrome's "Name window…" gives, and it is the window's title. Chrome gives it
  only to a window that it makes new at its start. A profile that restores its last session
  ("Continue where you left off", which agent-browser asks for) keeps the restored window's old name,
  so a launch of such a profile logs one line that asks you to name the window once in Chrome
  ("Name window…" in the tab strip's menu, or the Window menu on macOS) with that exact name. A
  restored window keeps its name at each restart. (Measured on Chromium 156 on Linux, and on macOS
  on 2026-11-03 with Chrome Beta 158: there the name shows in the Dock menu and the Window menu, and
  a restored window keeps its old name, as on Linux.) While a command waits for the prompt, its
  notice names the Chrome pid and the profile, and the window too when there is evidence for its
  name: agent-browser started that Chrome with the name, and the profile does not restore its
  session. Chrome shows the prompt over the profile's last active window, so with a second window
  open the prompt can be on the other one.
- **Every agent browser on the machine:** `agent-browser chromes` lists each agent-browser Chrome of
  this user: its pid, profile, state folder, window name, the consumer's command name, and whether
  an approved proxy of that state folder is up. It needs no `--state-dir`.
  - It is read-only. It reads the process table (this user's rows only) and this user's own
    state-folder and profile files; it checks the owner of each file before it reads it. It never
    connects to a Chrome, so it raises no "Allow remote debugging?" prompt. It signals no process.
  - An agent Chrome is a Chrome main process: the Chrome or Chromium binary, on a `--user-data-dir`,
    with no `--type=`. Also, agent-browser's launch flags are right in front of that profile (today's,
    or those of release v0.2.9 and builds before this change, with the two timer flags), or an
    agent-browser proxy of this user drives that profile. A process that only names a profile in its
    arguments is not one.
  - Not listed: a `chromeBin` of another Chromium browser (for example Brave), a Linux Chrome binary
    in a folder whose name has a space, and a macOS app path that holds " -".
  - The state folder and the command name come from the window name of agent-browser's launch. A
    Chrome without one was started before window names, or by hand. For it, they come from its
    proxy. Without a proxy, the state folder is the profile's parent when that folder holds a
    `launches.log`. ps joins the arguments with spaces, so a folder whose name holds " -" and a
    letter is read short there.
  - The window name is given only when the profile does not restore its session.
  - A proxy is up when the state folder's `chrome-proxy.json` names a live agent-browser proxy of
    that state folder and profile, with the same upstream. The proxy writes that file only once
    Chrome accepted its connection.
- **Bringing the asking window to the front (macOS):** `agent-browser front --state-dir DIR` brings
  this consumer's agent Chrome to the front, so that you find its "Allow remote debugging?" prompt.
  It takes the operator's focus, so a person runs it. An agent never runs it on its own. On macOS the
  notice of a command that waits for the prompt names it (`<command name> front`, with "a person
  runs it; an agent never runs it"). The notice does not name it when the `approve` option answers
  the prompt, in personal mode, or with an `endpoint` override.
  - It finds the agent Chrome that holds this consumer's profile: the pid in the profile's
    `SingletonLock`, which Chrome makes at its start. `chromes` must list that pid as an agent
    Chrome of this user on this profile: agent-browser started it, or an agent-browser proxy of this
    user drives it. The lock must not be older than that process. So it refuses every other Chrome:
    a Chrome on that profile that agent-browser did not start and that no agent-browser proxy of
    this user drives, another consumer's agent Chrome (also one whose profile `ps` reads short at a
    " -"), and the operator's own Chrome. It never connects to a Chrome, so it raises no new prompt.
    It signals no process.
  - It asks macOS to unhide and activate that one instance by its pid: AppKit's
    `NSRunningApplication unhide` and `activateWithOptions:` with all the windows of that instance,
    through `osascript -l JavaScript`. The agent browser can be a second instance of the operator's
    own Google Chrome.app, with the same bundle id, so `open -a` cannot choose it. A pid can. Before
    the request, the script checks the pid again, so a pid that another program has now is refused:
    its executable must be the agent Chrome's binary, and its launch date (from Launch Services) must
    be within 5 s of the start time that `ps` gives. Apple gives no launch date for an app that did not
    start through Launch Services (`launch --login` starts Chrome without `open`); then only the
    executable is checked.
  - A minimized window stays in the Dock: activation does not bring it back. Then `front` still
    succeeds, and its text says so: click the window in the Dock, or the agent browser's Chrome icon.
  - It needs no new permission. The script addresses no app by name and sends no Apple Event. macOS
    asks for the Automation permission only for an Apple Event to another app (Apple:
    `NSAppleEventsUsageDescription` is "required if your app uses APIs that send Apple events"). It
    uses no Accessibility API and no System Events. (The `--approve osascript` way needs
    Accessibility; `front` does not use it.) Apple's documentation of the activation methods of
    `NSRunningApplication` names no permission.
  - macOS 14 and later can refuse the request. There activation is a request, and "only the active
    app can influence the activation context" (Apple: cooperative activation). `osascript` is not the
    active app; your terminal is. So `front` reads the front app (`lsappinfo front`) for 1.5 s after
    the request. If the agent Chrome is not in front, on macOS 14 and later it asks once more with
    `activateFromApplication:options:`, which names the app in front. That app (your terminal) did
    not yield its activation, so macOS probably refuses this request too; the Mac check measures it.
    If the agent Chrome is still not in front, `front` fails (exit 1). The message names the macOS
    version, the pids, the requests that it sent, and the way by hand: Control-click the Dock icon of
    the agent's Chrome, and choose the window by its name. `front` stops after 60 s in all.
  - Linux and other systems: `front` refuses with a usage error before anything runs. On a Linux
    server the agent browser runs on a display of its own (on taylor, a private Xvfb), and no person
    watches that display.
  - Not measured on a Mac yet. The Mac check, in your own terminal, while your own Google Chrome is
    open:
    1. Start an agent Chrome on a second instance of Google Chrome.app:
       `S=$(mktemp -d /tmp/ab-front.XXXXXX)/state; node bin/agent-browser.js launch --state-dir "$S" --chrome-bin "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --json`.
       Then `ls -l "$S/profile/SingletonLock"` must point at `<host>-<pid>`, with the pid that
       `node bin/agent-browser.js chromes` gives: `front` finds the Chrome by this link (Chromium's
       POSIX lock, not yet seen on this Mac).
    2. Click your terminal.
    3. Run this one line:
       `lsappinfo info -only pid "$(lsappinfo front)"; node bin/agent-browser.js front --state-dir "$S" --json; echo "exit $?"; lsappinfo info -only pid "$(lsappinfo front)"`.
    4. Pass: the first `lsappinfo` names your terminal's pid, `front` exits 0, the second `lsappinfo`
       names its `chromePid`, the agent window is in front, your own Chrome stays behind, and macOS
       shows no permission dialog.
    5. Hidden and minimized: hide the agent Chrome (Cmd-H), click your terminal, and run the line
       again (pass: the window shows). Minimize the agent window (Cmd-M), click your terminal, and run
       it again (record whether the window shows; the text names the Dock).
    6. `node bin/agent-browser.js quit --state-dir "$S" --json`.
- **Finding it:** the endpoint comes from `DevToolsActivePort` in the profile. The port must be
  listening and owned by the Chrome main process whose `--user-data-dir` is exactly this profile.
  A stale file is ignored. No WebSocket is opened to probe, because that would raise the approval prompt.
- **The proxy:** one background Node process (`agent-browser proxy`, started by the first command that
  needs Chrome) holds the single upstream connection and shares it over the consumer's Unix socket.
  So the operator approves once for each proxy, not once for each command. Request ids are remapped
  for each client. Session events go only to the client that attached the session (also for a session
  that Chrome attaches through that one, such as a page's worker); browser events go to every client.
  A departed client's sessions are detached. A start lock next to the socket lets
  simultaneous callers elect one proxy, and a live socket is never removed. The proxy exits after
  `proxyIdleMs` with no clients, when Chrome closes the connection, or on `stop`. Its log records
  Chrome's close code and reason.
- **A Mac sleep ends the approval.** Chrome closes the approved connection when the Mac goes to sleep
  (measured 2026-10-30: two agent Chromes closed theirs 4 ms after macOS sent `kIOMessageSystemWillSleep`
  for a lid close, before the screen lock and 5 s before the sleep). So the proxy exits, and the first
  command after the wake opens a new connection, which waits for a new Allow click. agent-browser does
  not bypass that prompt. Chrome's approval mode asks for each new connection.
  - That command says so on standard error: no approved connection, when and why the last one ended,
    and which browser asks (pid and profile, and its window name when there is evidence for it: see
    **Which window asks**).
  - A prompt that nobody answers can leave that Chrome refusing every later connection (an instant 403)
    until it restarts. So an unattended caller sets `noPrompt` (`--no-prompt`). With no approved proxy
    up, it then fails at once with `approval_needed` and starts nothing. `status` also opens nothing.
  - A power assertion does not prevent a lid-close sleep: a `PreventUserIdleSystemSleep` assertion
    (what `caffeinate -i` holds) was active at that lid close. `caffeinate -s` acts only on AC power. To
    keep the approval through an absence, keep the lid open, or use the Mac on power with an external
    display.
- **Diagnostics:** `status` reuses an existing proxy only. It never starts Chrome or a proxy. Without a
  proxy it reports local evidence and the last attempt from `chrome-proxy.log`. A pending handshake does
  not prove that Chrome shows a prompt, so the approval status is always "unknown".
- **Tab references:** `<tab>` is a name from `open --name`, a target-id prefix, or a URL substring,
  always among allowlisted tabs only. With a tab scope, among the scope's tabs only (see **Tab scopes**).
- **Cheap reading:** `outline` numbers the interactive elements on screen; `click <tab> #N` clicks one.
  Read with `outline` and `text`; take a screenshot last.
- **Isolated world:** every `evaluate` (and so `outline`, `text`, `click`, `fetch` and the rest) runs
  in a private isolated world created with `Page.createIsolatedWorld`, not in the page's main world.
  Our functions and temporaries never touch the page's own `window`, and the page cannot replace the
  globals we use. The Runtime CDP domain is never enabled. A navigation destroys the world; the next
  `evaluate` makes a new one and retries. `outline` still marks elements with a `data-agent-browser-idx`
  attribute, because the DOM is shared and a later `click #N` must find them across separate calls.

### Unattended approval (headless server)

Because agent-browser enables remote debugging the `chrome://inspect` way (never
`--remote-debugging-port`, which sets `navigator.webdriver`), Chrome shows a native "Allow remote
debugging?" dialog for each new DevTools connection, and the grant is not remembered. The proxy holds
one upstream connection per Chrome start, so one approval per Chrome start is enough. Where a person
can click (a normal Mac), they click. For unattended use, set `approve` and agent-browser answers that
one dialog itself, and only the connection the proxy opened — it never answers a dialog it did not cause. It is
refused in personal mode: there the dialog guards the operator's own Chrome, and a person must answer it.

The click is a real OS input event (CDP cannot dismiss a native dialog, and we are not connected yet),
so it needs an OS tool, which is a documented prerequisite, not an npm dependency:

- **macOS** (`approve: "osascript"` / `approve: true`): clicks the button **named "Allow"** through the
  accessibility tree on the agent Chrome addressed **by its pid** (so it never touches another Chrome that
  shares the binary name, e.g. the operator's), so it can never hit "Cancel" or the left "Turn off in
  settings"; if it cannot find "Allow" it clicks nothing. It needs **Accessibility permission** (System
  Settings → Privacy & Security → Accessibility) for the process that runs `osascript`. Without the grant
  it fails safe with `-25211` and approves nothing. In a headless `tmux`/`launchd` session there may be no
  terminal app to grant, so the macOS approver suits an attended Mac or a session launched under a granted app.
- **Linux** (`approve: "xdotool"` / `approve: true`): sends `Tab` then `Return` (the dialog opens with
  focus on "Cancel"; one `Tab` moves it to "Allow"). Needs `xdotool` and a display. This relies on the
  dialog's focus order, so pin the Chrome/Chromium version. Verified on Chromium 156.
- **Custom** (`approve: { command: [...] }`, CLI `--approve-command`): runs your own argv at connect — for
  a different mechanism (VNC, a verify-by-pixel clicker). It runs only when the proxy connects.

Headless Linux server recipe: a private virtual display `Xvfb :N -nolisten tcp -auth <cookie>` (the
cookie matters — without it the X socket is open to every local user), the seeded throwaway profile,
headed Chromium with `chromeBin=/usr/bin/chromium` and **no** port flag, one long-lived proxy, and
`approve: "xdotool"`. On Debian/Ubuntu `/usr/bin/chromium` (and `google-chrome`) is a wrapper script
that execs a different real binary (for example `/usr/lib/chromium/chromium`); agent-browser finds the
running browser by its profile, not by the launch path, so the wrapper path works. Do not fall back to
`--remote-debugging-port` or headless: the first sets `navigator.webdriver`, the second adds the
`HeadlessChrome` UA token. agent-browser refuses both flags in `chromeArgs`.

Auto-approve removes Chrome's one safeguard against an external app taking full control of the profile,
so it is opt-in: keep the display private and the profile throwaway. The real click is not exercised by
the test suite (the fake Chrome raises no native dialog); the suite covers the orchestration and the
fail-safe button-name targeting, and the Linux mechanism was verified on a live Chromium 156.

## Agent mode's endpoint (`agent-browser relay`)

The agentwatch daemon starts `agent-browser relay --socket <path> [--peer-check]` with the agent Chrome's unit. The relay
serves agent mode's CDP endpoint (contract C11, `docs/contracts/C11.md`; its master moved here from
chrome-extension's `docs/protocol.md` in board task ab-v16.94.1) to Playwright, the
Playwright MCP and agent-browser's commands with `--cdp-url`. It drives the agent Chrome through the agent
extension's bridge (contract C10).

**One allowlist per scope** (board task ab-v16.35, part 2 of the per-scope build; the design:
`docs/superpowers/specs/2026-11-04-per-scope-allowlist-design.md`, section 8.4, and
`2026-11-05-orphan-agent-tabs-design.md`, section 8). The scope is the name in the endpoint's path
(`/devtools/browser/<scope>`), the agentwatch session's name at its launch. Each scope has its own list.
The relay needs the agent extension of chrome-extension 0.3.1 or later (parts 1a and 1b), and agentwatch's
daemon must send `set_scopes` (part 3): there is no backward compatibility.

- The allowlist line. After each `set_scopes` that the extension confirms, the daemon writes its object
  to the relay: `{"t":"allowlist","lists":{...},"scopes":{...},"default":...}`. The relay applies C4's
  rules to it (`src/relay/scopes.ts`), as the extension applies them to `set_scopes`: a scope's list is
  the list of its `scopes` entry when it has one (`null`, or a list that is not in `lists`, gives no
  list, with no fall-back), else the `default` list. An entry that is not a normalized host name (C5)
  does not apply. An old line (`{"domains": [...]}`) gives no scope a list.
- Readiness. A connection of a scope whose list the last line does not give gets the 503
  `The agent browser is not ready: the allowlist has no list for this scope.`, after the other 503s. A
  scope with an empty list is admitted: it can open `about:blank` only.
- A scope that loses its list. At each line the relay closes the connections of each scope that has no
  list any more (1008, `The allowlist has no list for this scope any more`). At a line whose `scopes` and
  `lists` are objects it also drops each tab of such a scope from its model, so a later session of the
  same name never sees one (the extension's sweep closes the tab).
- The relay's own tabs. `Target.createTarget` names the connection's scope as the second arg of
  `windows.create` (Linux) or `tabs.create` (the Mac). The extension's `no list for this scope` reaches the
  client as a CDP error (-32000).
- Other tabs. A popup or a replaced tab joins a scope only when the extension reports it
  (`bridge.tabScope`); the relay never takes a tab's scope from its opener. A new tab with no report waits
  500 ms in no scope (attached and held), and is then released and detached; a later report still puts it
  in its scope, free. The owner of a popup's opener (Chrome's `openerId`) still owns the popup, when both
  are in one scope.
- The tabs of before. At each link up (and each relay start) the relay reads the extension's map of the
  tabs' scopes (`bridge.tabScopes`) and takes those tabs back into their scopes, free, before it admits a
  connection. So after a link drop or a relay restart a client of the scope sees its pages again
  (`context.pages()`). Its CDP sessions do not stay. A failed `bridge.info` (its 30 s deadline, say) is
  tried again, three tries in all; then the relay waits for the next link up.
- A bridge answer and a line in one read. The extension's answer (`bridge.tabScopes`, `windows.create`,
  `tabs.create`) and a line that gives the scope no list can come in one read of the relay's standard
  input; the line then applies first. So before the relay gives a tab the scope of such an answer, it
  checks the scope again: no tab joins a scope that the last line (whose `scopes` and `lists` are objects)
  gives no list, or a scope of an `end_scope`. Such a `Target.createTarget` gets `no list for this scope`.
- A closed connection. A connection that the relay closed (an `end_scope`, a line without its list, a link
  change) can still send until its close handshake ends: the relay ignores it (no answer, no bridge
  request). A tab whose creator left before its `Runtime.runIfWaitingForDebugger` stays at `about:blank`:
  the relay sends no navigation for it. Before the navigation of a new tab the relay checks its URL again
  against the last line, which can have changed the scope's list during the hold.
- Layer 1 of the guard. The relay refuses a `Page.navigate` of a tab's main frame and a
  `Target.createTarget` whose `http:`/`https:` host (or a `blob:` URL's inner host) the scope's list does
  not cover: `Not allowed: <host> is not on the allowlist`, before any request reaches Chrome.
  The relay reports each refusal through C10 `daemon.blocked`, including the delayed `Target.createTarget`
  after a list change. It checks the host and scope before sending the report. It waits at most 250 ms,
  including time in its separate `blocked` queue. Only the carrier's `ok` answer adds this text:
  `The operator has a Browser permission prompt in the agentwatch web viewer. Tell the operator; after the notice that the operator added <host>, start the step again.`
  An older carrier, a failed args check, an error, or a timeout keeps the existing error text.
  Permission-grant refusals make no navigation prompt. A frame's navigation is not refused.
  The extension blocks links, redirects, page scripts and popups with its rules per tab.
- Grants. `Browser.grantPermissions` with no origin covers the scope's own list; one with an origin needs
  a host of that list. At each line the relay sets again the grants that each connection's own list still
  covers, and allows automatic downloads for each entry of every list. A content setting acts on the whole
  profile: a grant of one scope also applies to another scope's tab on the same host.
- The end of a scope. From an `end_scope` on, a new connection of that scope gets the no-list 503 until
  a later line names the scope again (in `scopes`), also over a link change and also when the `default`
  list would cover it. This is stricter than the contract text of chrome-extension main c99bebb; board
  task ab-v16.55 adds the matching C11 sentence.
- A line with `roots`. A relay that runs without `--peer-check` applies no list of a line that has a
  `roots` field (any value), as if no line had come: every open connection closes (1008), and each upgrade
  gets the 503 `The agent browser is not ready: the allowlist has session roots, but the relay was started
  without --peer-check.`, until a line without `roots` comes. So a daemon and a relay that disagree fail
  closed.
- Closes. The extension keeps the browser's last window for every close (its removal queue). So the
  relay sends `end_scope`'s `tabs.remove`, `Target.closeTarget` (as `tabs.remove`: the extension's close,
  with no `beforeunload`) and a client's `Page.close` as they are, with no query, window or queue of its
  own. A late `end_scope`, whose tab the extension's sweep took out of its scope, gets `not an agent tab`:
  for the relay that removal is done.
- Without `--peer-check` the scope is advisory: any process of the daemon's user can connect with any
  scope and get that scope's list.

**The peer check** (`--peer-check`; board task ab-v16.51; C11, "The scope's session (the peer check)"; the
design: `docs/superpowers/specs/2026-11-05-peer-admission-design.md`). With it the relay admits a connection
of a scope only from a process of the agentwatch session of that scope. There is no key, no token file and
no secret in the URL: the relay asks the kernel which process connected, and walks from that process through
its parents to the session's **root**, its tmux pane's process, by pid and start time
(`src/relay/peer.ts`).

- The roots. The daemon puts each live session's roots into every `allowlist` line:
  `"roots":{"<scope>":[{"pid":<pane pid>,"start":<pane start>}]}` (Linux: field 22 of `/proc/<pid>/stat`;
  the Mac: `pbi_start_tvsec * 1000000 + pbi_start_tvusec`). A `roots` that is not an object applies as an
  empty object, an entry of a bad scope or with a value that is not a list as absent, and an item that is
  not an object with an integer `pid` from 2 to 2^53 - 1 and an integer `start` from 0 to 2^53 - 1 is
  dropped. A line with no `roots` field gives every scope no root. With the peer check, a scope that the
  line does not name has no list, whatever `default` says.
- The self-test. At its start, before its socket listens, the relay loads its reader (a dynamic
  `import("node:ffi")`, then libc's `getsockopt`, `poll` and `close`), listens on a socket in a 0700 folder
  of its own next to the endpoint socket, and starts a child process that connects to it. It compares the
  peer with the child's pid, its own uid, the child's parent (the relay) and start time, and with a pidfd
  the pid that the pidfd names and a poll of 0. The whole test has 5 s (`SELF_TEST_MS`), and the child
  stops and the folder goes in every path. The relay logs `relay: the peer check runs (pidfd)` (or
  `(stat)` on a Linux kernel before 6.5, `(mac)` on the Mac), or `relay: the peer check cannot run:
  <reason>`. Then it admits no connection, and every upgrade gets the 503 `The agent browser is not ready:
  the relay cannot read the program of a connection.` `node:ffi` is experimental in Node 26: its import
  prints one `ExperimentalWarning` on the relay's standard error (`--disable-warning=ExperimentalWarning`
  hides it). No other command loads it, so none prints the warning or fails on a Node without it.
- The peer read, at each accept: `SO_PEERCRED` (pid and uid) and `SO_PEERPIDFD` (a pidfd of the same
  process) on Linux; in the stat form the peer's start time instead of the pidfd. Every read that fails, no
  pid, or another uid gives the 403 `The agent browser cannot tell which program connects, so it refuses
  the connection.` The relay closes each pidfd once: after the upgrade's check, or with the socket.
- The order of the checks: the `Origin` 403, the 404, the self-test's 503 or the peer's 403, the "not
  ready" 503s, the no-list 503 of a scope that the line does not name (a just-launched session connects
  again), the session check, then the no-list 503 of a named scope with no list.
- The session check. The peer must be alive (a pidfd that does not poll readable, whose `fdinfo` pid is
  the peer's, and a state that is not `Z`; in the stat form the start time of the accept). The walk goes
  from the peer to its parent, and on: it stops at the first process that matches a root of the line, of
  any scope, at pid 1, at a pid that has gone, at a parent that started after its child, or after 32
  parents. It admits only at a root of the scope that counts. When it stops at no root, on Linux, the
  peer's cgroup may count: it must be the pane's own systemd scope (`tmux-spawn-<uuid>.scope`) of a root of
  the scope, or under it. So a `nohup` job whose shell exited and a double-forked job of the session are
  admitted while the session lives (the operator's ab-6gs answer). The peer must still be alive after the
  walk. Else: the 403 `The agent browser admits a connection only from a program of the agentwatch session
  of its scope. This program (pid <pid>) is not in it: ...`.
- The defensive root rules, at each line: a root counts only while its process lives with its start time;
  a root that two scopes name counts for neither; a root that is an ancestor of another root (the tmux
  server, say) counts for neither the walk nor the cgroup; a root's cgroup counts only when it is not its
  parent's cgroup, no live root of another scope has it, and no other root's cgroup is under it. At a
  check the relay reads only the scope's own roots again. These rules catch the usual mistakes of a line,
  not every wrong line.
- A root change. At each line the relay closes every connection of a scope whose root (the one that
  admitted it) is no longer one of the scope's roots (a respawned pane), with 1008 `The session of this
  scope has a new process: connect again.` A connection whose scope loses its list gets the no-list 1008
  first. A connection stays while its root stays, also when another scope names the same root.
- The session's end. The pane ends first, so its jobs (a `nohup` job, a double fork, a command through a
  tmux server that the session started) match no live root and its cgroup counts for no one: for their own
  scope they get the session's 403 until the line that drops the scope, and the no-list 503 after it
  (with choice 5 b, the session's 403); their open connections close at that line (1008), or at the
  `end_scope` (1000). An `end_scope` keeps a new connection of the scope out until a line names the scope
  again; with the peer check that refusal comes after the session check (the session's 403 first).
- A session that agentwatch only stops (its agent ends, its pane stays) keeps its pane and its root until
  agentwatch ends the session: its jobs can still connect until then.
- The limit. The check stops mistakes, an agent that names another session's scope, and an injected
  instruction that only names a scope. It does not stop a hostile process of the same OS user: such a
  process can join another session's cgroup with one write, or run a command through a server that another
  session left running (`tmux -L <server> run-shell`: by the server's cgroup it counts as that session;
  measured live, below), and it can type into another session's pane. A process that no agentwatch session
  started (a plain terminal, `systemd-run --user`, cron outside agentwatch) cannot connect.
- The Mac reader (`LOCAL_PEERPID`, `LOCAL_PEERCRED` and `proc_pidinfo`) is built from the documentation and
  has not run yet (board task ab-v16.52). The Mac has no cgroups: there the walk alone decides, so a job
  that leaves the tool's shell is refused.

Measured live on taylor on 2026-11-05 (Linux 6.12.115, Node 26.12.0, tmux 3.5a, Chromium 156 with the agent
package of chrome-extension main 40c2d93, 0.3.2; `CASES=peer` of `test/live/agent-mode/run.ts`, two runs, 30
of 30 cases each). The relay's self-test chose the pidfd form. Each pane of the run's own tmux server got its
own `tmux-spawn-<uuid>.scope`. Under pane A a Playwright script, `agent-browser tabs --cdp-url` and the
Playwright MCP (a stdio child of an agent-like process, with `--cdp-endpoint`) were admitted to scope `pa`
(the walk), and so were pane A's background job (the walk), its `nohup` job whose shell exited and its
double-forked job (both re-parented to `systemd --user`: the pane's cgroup). Pane B's Playwright script and
agent-browser that named `pa` got the session's 403, and the test's own process (in no pane) too. A
`tmux -L <server> run-shell` from pane B through a tmux server that pane A started was admitted to `pa` (the
stated limit of the pane's cgroup), and refused for `pb`. After session A's end (its pane ended) its jobs got
the session's 403 for `pa` and `pb`, and their open connections stayed open; at the line that dropped `pa`
(5 a) those connections closed with the no-list 1008, and the jobs got the no-list 503 for `pa` and the
session's 403 for `pb`. After `tmux respawn-pane -k` of pane B the old pane's `nohup` job's open connection
closed with `The session of this scope has a new process: connect again.`, its new connection got the
session's 403, and a Playwright script in the new pane was admitted. Codex was not run.

**On Linux, one window per page** (board task ab-v16.28; the anti-detect design of
`docs/research/2026-11-05-anti-detect-drive.md`, "The answer" steps 1, 2 and 5):

- Every `Target.createTarget` opens a new window that does not take the focus
  (`chrome.windows.create({ focused: false })`), also when the client asks for a tab or a background tab.
  Playwright's `newPage`, the MCP's first page, and agent-browser's `open` and `open --tab` with `--cdp-url`
  each get a window. So the `open --tab` exception (a background tab with focus emulation or
  `--hidden-drive`) does not apply over the endpoint.
- The relay answers `Emulation.setFocusEmulationEnabled` on a page session itself, with `{}`, and never
  sends it to Chrome. A page in a window draws without it. With it, a page reports the focus while another
  page has it. Playwright sends it for each page unless it connects with `noDefaults: true`; the
  Playwright MCP connects with `noDefaults`.
- Before an input that starts an action (`Input.dispatchMouseEvent` `mousePressed`,
  `Input.dispatchKeyEvent` `keyDown`, `rawKeyDown` or `char`, `Input.insertText`,
  `Input.dispatchTouchEvent` `touchStart`, and Playwright's focus of an element, below), the relay
  brings the page forward, as a person does. When
  another tab is in front in the page's window (a popup tab that the site opened there), it selects the
  page's tab (`chrome.tabs.update`). When the window does not have the focus, it focuses the window
  (`chrome.windows.update({ focused: true })`). The page's later calls wait behind that input, and the
  relay brings one page forward at a time. Moves, wheel events, releases and key-ups go at once. On Linux
  Chrome raises a window for a press in it, but not for keys: a key into a window that does not have the
  focus gives its page the focus while another page keeps it. `Target.activateTarget` still only selects
  the tab in its window. `Page.bringToFront` goes to Chrome, which selects the tab and focuses its window.
- A popup stays where the site opened it: a tab in the opener's window (`target=_blank`, `window.open`
  with no features), or a window of its own. The relay never moves a tab to another window.
- The agent Chrome needs `--disable-backgrounding-occluded-windows`. Without it a window under another
  window is `hidden` and draws nothing, and a Playwright click waits for a frame that does not come
  (the research, step 3).
- The cost: about 32 to 46 MB of memory for each window over a tab, and every page draws at full rate,
  also under another window (the research). Each input that starts an action also reads the page's tab
  and window through the bridge first: two requests, a median of 16 ms in the live run (`tabs.get` 3 ms,
  `windows.get` 13 ms), and `windows.update` (29 ms) when the window comes forward. So typing with key
  events takes about 16 ms more for each character.

Measured on taylor with Chromium 156 and chrome-extension main 7e36332 (`CASES=windows` of
`test/live/agent-mode/run.ts`, eight runs on 2026-11-05, including the reviews' runs): with Playwright's
defaults, with `noDefaults` and with the Playwright MCP, every step passed while another window had the
focus. The page stayed `visible`, drew 55 to 67 frames a second in each step of 100 ms or more
(60 in each 3 s idle step), got no action while it was hidden or did not have the focus, and got the
focus only with the input, while the other page got a `blur`. Both pages had the focus at the same time only
at a switch of the window: the new page's `focus` came 4 to 32 ms before the old page's `blur` (7 to 9
switches in each drive, 200 in the eight runs, measured from the pages' `focus` and `blur` events; a
person's switch was not measured that way). No `Emulation.setFocusEmulationEnabled` reached Chrome.
What a site can still see of a Playwright client (section 8 of the research):

- Playwright's own input: a click with one or two moves and no path, a press of 0 to 2 ms (a person's
  takes 70 to 90 ms), `fill` as one `insertText` with no key event, a field's focus with no press
  (`el.focus()`), and a scroll with no wheel or key (`scrollIntoViewIfNeeded`). The relay does not shape
  a client's input.
- The pointer at each activation: with an agentwatch daemon that has the pointer ops, see **The pointer at
  an activation** below. With an older daemon: when the relay focuses a window, the page gets a real pointer
  event at the X pointer's point, and the next CDP move starts at another point (a jump).
- The first activation of a new window gives the page two `focus` events (a person's click gives one).
- Two agents at once. The relay brings one page forward for each press or key, but it cannot lock a
  client's whole action. Two Playwright clients that typed 43 characters each at the same time had the
  focus together for 400 to 1200 ms of 7.3 to 8.5 s (100 ms samples, six runs; from the `focus` and
  `blur` events of one run: 87 overlaps of at most 41 ms, 540 ms in all), and their pages got 177 `focus`
  and `blur` events: the focus went back and forth at almost each key. A site that has both pages open
  can see it.
- A covered window draws at 60 frames a second; a person's covered window is `hidden`. Every window opens
  at the same place and size (the unit's `--window-position` and `--window-size`). At its load a page in a
  new window can report `outerWidth` and `outerHeight` 0 (6 of 9 pages in three runs): it loads before
  Chrome shows the window. `history.length` is 2 for a page that `Target.createTarget` opened with a URL
  (C10: the relay opens it at `about:blank` and navigates it after the hold).
- A site's popup window does not get the size that it asked for: with the unit's `--window-size`,
  `window.open(url, "", "popup,width=500,height=400")` opens as large as the other windows (1100x734 in
  the research, section 6). The fix can need a change of agentwatch's agent unit.

Playwright's focus of an element: `pressSequentially`, `press` and `type` on a locator first call
Playwright's injected `focusNode` with a caret reset (Playwright 1.64.1).
The MCP uses `playwright-core` 1.65.0-alpha-2026-10-30, with the same focus function text.
The function moves the caret of an input to its start when `document.hasFocus()` is false.
So in a window that lost the focus Playwright would type at
the start of the field (`def` after `abc` gives `defabc`, and Backspace deletes nothing). With focus
emulation every page had the focus. So the relay also brings the window forward before a
`Runtime.callFunctionOn` with a string argument that is Playwright's utility-script function
`([injected, node, ...]) => injected.focusNode(...)` (the whole string; Playwright sends the function's text
that way). A client's own function or string that only mentions `focusNode` does not count. `focus()` on a
locator calls `focusNode` too, without the caret reset, and its window comes forward as well. Then the
caret stays where it was (measured live with Playwright's defaults, `noDefaults` and the MCP's
`browser_type` with `slowly`). The rule depends on Playwright's internal names `injected` and `focusNode`.
A minified bundle that renames `injected` does not match the rule.
If Playwright renames either name, the caret moves to the start again, and nothing else breaks.

Playwright's `expect(locator).toBeFocused()` also reads `document.hasFocus()`. After another window took
the focus, it fails for a field that is the page's active element, until the page's window has the focus
again (with focus emulation every page had the focus). The relay cannot see such a check.

**The pointer at an activation** (board task ab-v16.71; the agent pointer design,
`docs/superpowers/specs/2026-11-06-agent-pointer-move-design.md`; C10 "The daemon's own ops" and C11 "The
pointer at an activation"). When a window comes forward, the X server gives its page a real pointer event at
the X pointer, and CDP input never moves the X pointer. The agentwatch daemon owns the agent display (its
Xvfb), so on Linux the relay asks it to move the X pointer: `daemon.pointerAt` reads the pointer, and
`daemon.movePointer` plays a person-shaped path with `xdotool` (C10: the daemon checks each point, each step
of at most 50 px and 16 to 250 ms, at most 1500 ms, the display, the pointer's place before the play, 5 paths
a second; no client method reaches these ops). The relay (`src/relay/model.ts`, `src/relay/pointer.ts`):

- At each link up it sends `daemon.pointerAt` as a probe. Its answer turns the paths on; `unknown op`
  (an agentwatch daemon from before these ops), `wrong display` and `not connected` turn them off until the
  next link up, `no display` for 60 s. While the paths are off the relay is as before (no read, no path, no
  catch-up), also on the Mac, where it sends no `daemon.` op.
- It keeps each page's last point (the point that Chrome last saw: each client's `Input.dispatchMouseEvent`
  and `Input.dispatchDragEvent` on the page's own session), the page under the pointer (the front page:
  the page of the last activation step whose raise the relay sent, or a new window), and each page's held
  button (a press on any session of the page). A client's `Browser.setWindowBounds` waits for the step that
  runs and the window's catch-ups.
- The activation step, one at a time for all clients, also for a client's `Page.bringToFront` and
  `Target.activateTarget`: when a page comes under the pointer and both last points are known, the relay
  waits for the front page's release (at most 2 s), holds the front page's later calls, reads both pages'
  geometry (one `Runtime.evaluate` in the relay's own isolated world, which it makes before each read; no
  client or page script sees it, and the relay refuses a client's call that names it: its context id, or an
  object id or a call-frame id in it; for a front page that no client holds, as after each command of
  agent-browser's CLI, the last usable geometry of the relay's own reads, which goes at every window event
  that the relay sees and at each read that is not usable), plans a path with `src/input.ts`'s generator
  from the front page's last point to the entering page's, clamped 2 px inside the front page's content box
  (the viewport less its scrollbars: a page gets no mouse event over its scrollbars), and has the daemon play
  it before the window comes forward. The entering page then
  enters at its own last point; the leaving page sees real moves of at most 50 px, 16 ms apart.
- The relay protects its world after a back-forward cache restore, before the next geometry read.
  It retains up to 128 context ids per tab and checks a suspected call with a native world lookup.
  At the limit, it checks every context-bearing call. A reused client context stays usable.
  The design states the remaining race between the lookup and a navigation.
- The catch-up: after a path, a client's next pointer event far from the page's recorded point (a move more
  than 50 px away, a press or a wheel more than 2 px away) gets CDP moves along a path of the same generator
  first (clamped to the page's content box too), so Playwright's next raw move after an activation is no
  jump. At most 4 of a tab's catch-up moves
  wait for an answer; then the catch-up stops (a page with an open dialog), and the relay logs it.
- With `AGENT_BROWSER_POINTER_LOG=1` the relay logs each step and catch-up (times and counts, never a
  point; the live check uses it).

Measured on taylor (Chromium 156, chrome-extension main 8a3b66f, the live group `pointer` of
`test/live/agent-mode/run.ts` in the harness's own Xvfb, with the stand-in daemon's ops on that Xvfb; two runs
on 2026-11-06 with the final code, the group alone and the whole suite; the design's section 7.1 has the
details). Counted from the end of each page's first activation:

| case | steps with a path | jumps / unexplained changes |
| --- | --- | --- |
| agent-browser's own commands over `--cdp-url` (`design`, `design-two`) | 3 of 8, 1 of 6 (the others needed none: the pointer was at the page's own last point) | 0 / 0 in each page |
| Playwright, two pages in two windows in turn, 3 rounds | 5 of 6 | 0 / 0 in both pages |
| two clients: A clicks while B activates another page | 5 of 8 | 0 / 0 and 0 presses away from the last move in both pages (Playwright's own raw moves apart: 1 or 2 per page) |
| a catch-up in the front page while the other client activates | 1 of 1 | 0 / 0 |
| a press held 3 s, and 0.5 s, while the other client activates | 0 of 1 (step 3's limit, 2.04 s), 1 of 1 | no real move between `mousedown` and `mouseup`; 1 jump at the entry with no path (3 s) |
| a page whose `mousemove` handler opens a dialog | no path: the step ends at its limit (2.04 s) | the client closes the dialog |
| scrollbars, targets 3 px inside the display's edge, a popup of another size | 7 of 9 | 0 / 0 |
| a moved window (`Browser.setWindowBounds`) | 3 of 4 | 1 jump at the first entry after it (no path) |
| a device-metrics override | 0: no path into or out of that page | as before |

The leaving page's moves: each with a movement, at most 76 px (two steps in one frame). `xdotool sleep` kept
the planned `dt` to within 1 ms in the page (p90 of 1843 pairs; at most 2 ms). A step with a path took 0.41 to
0.79 s (median), at most 1.21 s; a catch-up 0.28 to 1.11 s.

What a site can still see over the relay (the design, section 5): an activation with no path enters at the X
pointer (the first activation after the relay's start, a link change or a client's `Browser.setWindowBounds`;
a front page that holds its button for 2 s; a page whose pointer input waits for an answer; a geometry that is
not usable: a device-metrics override, a ratio or a scale that is not 1); its entry then has the movement from
the page's last point, a jump when that is more than 100 px away. The page that leaves sees a path to the
point where another scope's page last saw the pointer (a position only). Each activation that brings a page
under the pointer costs its path, and a catch-up costs as long once after it. A client's raw move into a page
that lost the pointer to another window (Chrome then reports a movement of 0) is the client's own (board task
ab-v16.76). A window that moves with no event that the relay sees gives a wrong mapping of a front page that
no client holds (on the agent browser's Xvfb only the relay and the extension place windows).

**On the Mac** the relay keeps its tabs: `Target.createTarget` opens a tab (a window only for
`newWindow: true`), focus emulation goes to Chrome, and no window comes forward for input. The Mac build
(board task ab-v16.27, **One window per agent page on the Mac**) is for agent-browser's own commands: the
relay's `chrome.windows.create({ focused: false })` is not measured on the Mac (Google Chrome on macOS does
not load the agent extension from the command line), and the relay's activation for input
(`chrome.windows.update({ focused: true })`) would bring the agent Chrome to the front there.

**The record of each endpoint scope** (board task ab-v16.58). The relay answers an endpoint scope's
`Target.getTargets` (`/devtools/browser/<scope>`) with that scope's own tabs only, and a change of the tab
record drops the entries of every tab that its connection does not list (see **Several processes** under
**Tab scopes**). So with `cdpUrl` each endpoint scope keeps its tab record in a folder of its own, and the
files of the agent browser stay one of each in the state folder:

```text
<stateDir>/
  endpoint-scopes/          mode 0700
    my-repo/                the tab record of the endpoint scope my-repo:
                            tabs.json, tab-scopes.json, reads.json, window.json, tab-pages.json, tabs.lock
    +my-+repo/              the tab record of the endpoint scope My-Repo
  input.lock                one input lock for every endpoint scope
  pointer.json              one pointer for every endpoint scope
  display.json, launches.log, shots/, recordings/, ...
```

- The folder name is the scope, with each capital letter written as `+` and its small letter (`My-Repo`
  gives `+my-+repo`). So two scopes that differ only in case get two folders, also on a disk that ignores
  case (the Mac's), and no two scopes get one folder (a scope holds no `+`). agent-browser refuses a
  scope outside the relay's pattern (1 to 64 letters, digits, `.`, `_` or `-`, the first a letter or a
  digit) before it makes a folder: `cdpUrl` with such a scope is a usage error.
- With no endpoint scope (the proxy, or `endpoint`: a Chrome that agent-browser reaches itself), the tab
  record stays in the state folder, as before.
- A record from before this change, in the state folder, is not moved: a record holds only live tabs, so
  each endpoint scope starts with an empty record, and the old files stay unused. The old record's tabs
  stay open: in the new record each one has no name and no tab scope, so under a tab scope only
  `--any-scope` reaches it.
- The input lock and the pointer stay one per agent browser (the operator's choice on ab-1bi): the input
  commands of two sessions over two endpoint scopes wait for each other, as on one scope.
- Inside an endpoint scope's record the tab scope (`tabScope`, `--tab-scope`) still applies. agentwatch
  passes the session's name as both.
- `window pin` pins a window for the callers of one endpoint scope.
- A scope's folder stays after its session ends: a few small files, with the entries of the tabs that
  were open at its last change.

## The self-contained agent browser's service (`agent-browser service`, off by default)

Stage 1a of the self-contained agent browser (board task ab-v16.94.2; the design:
`docs/superpowers/specs/2026-11-09-self-contained-agent-browser-design.md`, sections 5, 7.1 and 13.1). Nothing starts
it yet: agentwatch's unit starts it from stage 2, and no install step of this repository writes a unit for it. Its
contract is C12, `docs/contracts/C12.md` (the command, the doors, the admission, the hello, the data of the reads, the
ops of stage 1a and the fake).

- `agent-browser service --agent-door <address> [--control-door <path>] [--daemon-unit <unit>] [--daemon-command <file>]`:
  one process with two doors. The agent door is today's CDP endpoint with today's peer check (the relay's code,
  `src/service/agent-door.ts`). The control door, `control.sock`, admits only the agentwatch daemon process: the
  MainPID of agentwatch's unit or its direct child, with the command of the file that agentwatch's daemon writes at
  its start (`src/service/admission.ts`). Stage 1a has no Chrome: it answers `config`, `set_sessions`, `session_ended`,
  `status` and `endpoint`, and each other op `unsupported`.
- `agent-browser service --hello [--fake]` prints the hello and exits.
- `agent-browser service --fake --control-door <path> [--refuse]`: the fake for agentwatch's hermetic tests, with the
  scripted state of `test/vectors/control.json` and no Chrome (`src/service/fake.ts`). It prints `{"t":"listening"}`
  when its socket listens, and each event line on its standard input goes to the connected daemon. It never listens
  in the service's run folder.

## Tab scopes

One agent browser can serve several callers at the same time, for example the agent sessions of one
agentwatch box. Each caller passes its own tab scope (`tabScope`, `--tab-scope NAME`,
`tab_scope=`); agentwatch passes the calling session's name. A scope name is 1 to 64 letters, digits,
`.`, `_` or `-`, and starts with a letter or a digit (`TAB_SCOPE_RE`). It goes into
`tab-scopes.json`, error messages and the text output, so it is one plain word: no space, quote,
slash, colon or control character, and it never looks like a flag. agentwatch's session names all
fit. The scope keeps the callers apart. It is advisory: the callers run as one OS user and share one
state folder, and any caller can pass `--any-scope`. The allowlist is the security boundary, not
the scope.

With a scope:

- `open` records the new tab under the scope, also a tab without `--name`.
- A `<tab>` resolves only among the scope's tabs, in all three forms: a name, a target-id prefix and
  a URL substring. Every command that takes a `<tab>`, and `window pin <tab>`, uses the same resolver.
  A tab of another scope, a tab opened with no scope and a tab opened by hand are not visible.
- When a name or a target-id prefix matches only a tab outside the scope, the command fails with
  `tab_not_found`. The message says that a tab outside this scope matches, and names `--any-scope`. It
  never shows that tab's URL or title. A URL substring that matches only outside the scope gets the
  plain `tab_not_found` message, with no hint: else a caller could test the other scopes' URLs one
  substring at a time.
- `tabs` lists the scope's tabs and adds `scope` and `outOfScope`: the number of allowlisted tabs
  outside the scope. Of those tabs it gives the count only: no URL, title or name.
- `--any-scope` (`anyScope`, `any_scope=True`) on a command reaches every allowlisted tab. `tabs
  --any-scope` lists every allowlisted tab, each with its `scope` (none for a tab with no scope), and
  `outOfScope` keeps its meaning. `window --any-scope` lists every tab of the pinned window.
- `close` removes the tab from the scope's record, also when another scope closes it with `--any-scope`.
- `window pin <tab>` and `window unpin` fail with a usage error unless `--any-scope` is given: the pin
  belongs to the state folder, so it changes the tabs of every scope (see **Limits** below).
- `status` counts the tabs of the whole browser, also with a scope.

With no scope, nothing changes for a consumer that does not use scopes: every tab is visible, every
result document has the same fields as before, and `tabs.json` keeps its format. A tab that another
caller opened under a scope shows its `scope` in a `TabRef`. `--any-scope` has no effect without a scope.

**Names are kept per scope.** Two scopes can each name a tab `main`, and each finds its own. A new
tab takes a name only from an older tab of the same scope (the older tab stays in the scope without
a name), as `open --name` always did without a scope. With no scope, or with `--any-scope`, a name
resolves in this order: the caller's own scope, the tabs with no scope (`tabs.json`), then another
scope when only one scope uses the name. When two other scopes use it, the command fails and asks for
the target-id prefix: it never guesses. After the names come the target-id prefix and the URL
substring, as before.

**The record.** `tabs.json` keeps its format, `{"<name>": "<targetId>"}`, and holds only the tabs
opened with no scope. `tab-scopes.json` holds each tab opened under a scope, by target id, so a tab
is in one scope at most:

```json
{
  "8C1F0A2B...": { "scope": "session-a", "name": "main" },
  "77AB12CD...": { "scope": "session-a", "name": null },
  "91DE34EF...": { "scope": "session-b", "name": "main" }
}
```

**Several processes.** Each CLI call is a process, and several sessions call at the same time, so
several processes write the record: `tabs.json`, `tab-scopes.json`, the read-first marks
(`reads.json`) and the pinned window (`window.json`). Each change (`open`, `close`, the read mark of
`outline` and `text`, `window pin` and `unpin`) takes the lock file `tabs.lock` beside the record
(in the state folder, or in the endpoint scope's folder: see **The record of each endpoint scope**):
an exclusive create that holds the pid, like the proxy's start lock (`src/lock.ts`). A crashed
holder's lock is cleared; a live holder's lock is never cleared. Under the lock the change reads the
files, changes them, and writes each changed file to a temporary file that it renames over the old
one. So no change is lost, and a reader, which takes no lock, never sees half a file. Under the lock,
the entries of tabs that Chrome no longer has (closed by hand, or by another caller) are dropped from
the names, the scopes and the read marks. Such a tab is gone from every list before that. When `open`
cannot record its new tab (the lock timed out after 10 s), it closes that tab again and fails: no tab
stays behind that nobody recorded.

**Limits.**

- The pinned window (`window pin`) and the read-first record (`reads.json`) belong to the tab record
  (the state folder; behind agent mode's endpoint, the endpoint scope's folder), not to a tab scope: a
  pin confines every caller of that record. So under a scope,
  `window pin` and `unpin` need `--any-scope`. In personal mode, the first `open` with no pin still
  pins its own new window, also under a scope.
- With a pinned window, `open` makes its tab with `window.open` from a tab that is already in that
  window (CDP cannot create a tab in a chosen window). It uses a tab of this scope first. When this
  scope has no tab in the pinned window, it uses a tab of another scope, or one with no scope: the
  call runs in that tab's page (it opens `about:blank` only, and reads nothing there).
- The lock can, in theory, be broken twice. When a holder crashes and two waiters see its dead pid
  in the same few milliseconds, the first one clears the lock and takes it, and the second one can
  then remove that live lock and take its own: for that one change, two holders run at the same time.
  For the tab record, one of their changes (a tab's name, scope or read mark, or the pin) can be lost;
  each file is still written whole. For the input lock (`input.lock`, the same kind of lock), two
  input commands can overlap: two pages with the focus at the same time. A waiter that clears a
  crashed holder's lock tries again only after 50 ms (review-55: when it took the lock at once, 6
  waiters gave two holders in 20 of 1500 rounds), so the second waiter's removal must come more than
  50 ms after its read of the dead pid. It needs a crashed holder and two waiters at the same moment.

## Recording (`record`)

`record` films one allowlisted tab of the agent browser while a step script drives it, and writes an
MP4 and a provenance JSON beside it. It records the agent browser itself, so a site that refuses
automation-flagged Chrome (Google sign-in) can be filmed signed in, for example Google Sheets with an
add-on whose custom functions fill on screen.

```sh
agent-browser record sheet --out /abs/clip.mp4 --script steps.json --size 1920x1080 --scale 2 \
  --state-dir DIR --allowlist FILE --json
```

Needs ffmpeg with libx264 on `PATH`, or `--ffmpeg /abs/path` (not an npm dependency). Everything is
checked before the tab is touched: the steps, the paths and ffmpeg.

### Steps

`--script` is a JSON array, the step format of vedlo capture plus targets and keys for canvas apps:

| Step | Does |
| --- | --- |
| `{"wait": ms}` | pause |
| `{"goto": url}` | navigate (an allowlisted URL), wait for `load`, then 300 ms |
| `{"click": target, "duration": ms}` | move the cursor to the target, dwell 80-150 ms, press, 60-90 ms, release (the ripple shows at the press) |
| `{"hover": target, "duration": ms}` | move only |
| `{"type": "text", "into": target, "delay": ms}` | optional click into `target`, then one key event with text per character (`\n` is Enter, `\t` is Tab), each `delay` x 0.6-1.4 ms (default 55). A canvas app such as Sheets reads these key events, so its formula autocomplete shows as a person sees it. A character with no US-keyboard key is inserted as text. |
| `{"press": key, "repeat": n, "delay": ms}` | a key or a chord: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, the arrows, `Home`, `End`, `PageUp`, `PageDown`, `F1` to `F12`, one character, or chords such as `Shift+ArrowDown`, `Meta+A`, `Meta+C`, `Control+Home`, `Shift+F11`. A function key goes to the page only: Chrome never runs it as its own shortcut (on Linux: F5 reload, F11 full screen, F12 DevTools; live check: `test/live/function-keys/`, measured on Linux with Chromium 156 on 2026-11-03, and on macOS with Chrome Beta 158 and Google Chrome 156 on 2026-11-04, in a run with no full-screen trial). The page's own controls still act on it: F4 opens a focused `<select>` or date field. `Shift+F10` is refused: on Windows and Linux it opens Chrome's context menu. `delay` (default 150) follows each press. |
| `{"scroll": px, "duration": ms, "at": target}` | a mouse wheel with an eased total of `px`, at the cursor, or first move the cursor to `at` (a point in the Sheets grid, for example): it scrolls what is under the cursor, the page or an inner pane. The wheel follows the clock, so the step keeps its duration. When nothing under the cursor moved, the take gets a warning that names the step. |
| `{"scroll": selector, "duration": ms}` | smooth `scrollIntoView` to the centre |
| `{"highlight": target-or-box, "duration": ms}` | a ring around an element or `{"x", "y", "width", "height"}`, dimming the rest (default 1600 ms) |
| `{"waitFor": selector, "text": "...", "timeoutMs": ms}` | wait until the element is visible (and its text or value contains `text`); default 30 s, then the run fails |
| `{"waitIdle": {"match": "...", "quietMs": 1500, "timeoutMs": 60000}}` (or `{"waitIdle": "..."}`) | wait until the network goes quiet: a request whose URL contains `match` (default: any) was active since the step before began, none is in flight, and none has been active for `quietMs`. It watches the tab and its dedicated workers (Google Sheets computes in one). It fails at `timeoutMs` when it saw no such request (it cannot tell a finished fill from traffic it cannot see) or when they are still busy. Its event has `requests`, how many it saw. |
| `{"waitStill": {"box": {"x", "y", "width", "height"}, "quietMs": 1500, "timeoutMs": 60000, "allowNoChange": false}}` (or `"selector": "..."` for an element's box; `"w"`/`"h"` are accepted) | wait until the pixels of the box (CSS px at the recorded size) stop changing for `quietMs`: for a value drawn on a canvas, such as an add-on's fill in the Sheets grid. The box is pictured before the step before it begins, so a fill that starts at the Enter press counts. It fails when the box never changed since then (did the fill start?), unless `allowNoChange`, and when it is still changing at `timeoutMs`. The demo cursor, its click ripple and the repaint pixel never count as a change. Its event has `changes` and `settled` (the video time of the last change). |
| `{"waitChange": {"box": {...} \| "selector": "...", "timeoutMs": 60000}}` | wait until the pixels of the box differ from their look at the start of this step (the cursor masked out, as in `waitStill`); it fails at `timeoutMs`. Its event has `changed`. For a value that shows a placeholder first, chain them: an add-on's cell shows "Loading..." and then its values, so `press Enter`, `waitChange` ("Loading..." appears), `waitChange` (the values replace it), `waitStill` (they settle). |
| `{"eval": "js"}` | escape hatch: runs in agent-browser's isolated world (the page's own globals are not visible there) |

A target is a CSS selector, `#N` from `outline`, or `{"x": .., "y": ..}` in CSS pixels of the recorded
size. The Sheets grid is a canvas without selectors: go to a cell with the Name Box
(`{"click": "#t-name-box"}`, `{"type": "C5"}`, `{"press": "Enter"}`), then type into the grid and use
the arrow keys. A missing element fails the run with the step's number in the message.

`--setup` takes steps in the same format that run **before** the recording starts, at the recorded
size (for example, clear a cell off camera so a retake starts on a settled page).

### What it does

- **Exact size.** `Emulation.setDeviceMetricsOverride` lays the page out at `--size` CSS pixels and
  `--scale` (device pixel ratio) for the run only; the override is cleared afterwards, so the window is
  left as it was. The video is exactly size x scale pixels (default 1920x1080 at scale 1; scale 2 gives
  3840x2160). The window itself can be smaller: Chrome still renders the full emulated size. A leading
  frame of the window's own size, which Chrome can send before the override takes effect, is dropped.
- **Frames.** `Page.startScreencast` through the consumer's proxy, each frame acknowledged. A 1x1 pixel
  of the overlay changes every animation frame, so a still page still delivers frames. The frames sit in
  `<state-dir>/recordings/` (mode 0700) and are removed after every run, good or failed.
- **Encoding.** For each tick of the constant-rate MP4, the frame nearest that moment (by Chrome's own
  frame times) is piped to ffmpeg: H.264, CRF 16, `preset medium`, yuv420p, limited range, `+faststart`,
  no audio. (ffmpeg's concat demuxer, which vedlo capture uses, put each JPEG on a 1/25 s grid: frames
  shifted by up to 40 ms and collided. Measured on ffmpeg 9.)
- **Still handles.** `--settle` ms (default 600) of the page with no input are recorded before the first
  step, counted from the first frame of the video, and after the last step. Use `--settle 400` for
  0.4 s handles.
- **The cursor.** The path is ghost-cursor's (`path()`: a Bezier curve with its spread; past 500 px an
  overshoot to a point near the target, then a tight correction, as ghost-cursor's `move()` does). The
  timing is agent-browser's: a Fitts's-law duration (about 250 ms + 110 ms x log2(1 + D/W), W the
  target's smaller side, from 300 to 1000 ms; a step's `duration` overrides it) with a minimum-jerk
  speed profile (slow start, fast middle, slow arrival) along the curve. ghost-cursor's own timestamps
  move at one constant speed (0.2 to 0.3 px/ms). The page draws every frame of a move from one call
  (`requestAnimationFrame`), and the real mouse (for hover effects) follows every 16 ms on its own. The
  cursor aims at a point in the middle 40% of an element's box, and its tip is that point. It is still
  while typing and scrolling. All randomness (paths, aim points, dwell, typing pace) comes from
  `--seed` (default 1): a retake with the same seed and steps moves the same way. In a window of its
  own (Linux, ab-v16.26) a take is an input command: its window comes forward first, it holds the input
  lock for the whole take, and its cursor starts where the page last saw the pointer when that is
  known and inside `--size` (so its first move is no jump); a retake with the same seed then moves the
  same way from that start.
- **The overlay** (cursor, ripple, ring, repaint pixel) is built with DOM calls only (`createElement`,
  `setAttribute`, `element.style`, `element.animate`) inside a closed shadow root, in agent-browser's
  isolated world, and removed afterwards. Google Sheets enforces Trusted Types and a strict style-src,
  which refuse `innerHTML` and a `<style>` element. `--no-cursor` hides the cursor and the ripple; a
  `highlight` step still draws its ring.
- **The window.** On the Mac `record` never raises a window or switches the operator's Space: it sends no
  `Page.bringToFront`, which activates Chrome. On Linux, on a display of the agent browser's own, a window
  page that is hidden behind another tab of its window comes in front first (`Tab.toFront`, a tab switch
  with `Page.bringToFront`; **One window per agent page**): a hidden page sends no screencast frame. The
  agent browser can stay minimized, hidden (Cmd-H), covered or on another Space during a take (see
  **Measured**). Only a Chrome start, its one
  "Allow remote debugging?" prompt and a sign-in (`launch --login`) need the window. Start the agent
  browser, click Allow, then hide it: takes run in the background. Chrome sends no screencast frame
  of a background tab's hidden page, so `record` needs focus emulation (`Emulation.setFocusEmulationEnabled`).
  In the default mode the attach turns it on for every command; with `hiddenDrive`, `record` turns it
  on for its run and off when the screencast stops. So in a background tab the page reports `visible`
  for the run in both modes, and a site can see that (see **A command on a background tab: two modes**).
  A page in a window of its own (Linux; **One window per agent page**) is visible and draws without
  it, so `record` sends none there. Two parts of a take stay that a site can see in such a window too,
  because `record` needs them for what it makes: the device metrics override (the page is laid out
  at `--size` inside its window, and gets a `resize` at the start and at the end of the run), and the
  overlay in the DOM (the 1x1 repaint pixel, and the cursor unless `--no-cursor`; in a closed shadow
  root, but a page that walks the DOM finds its host element). Without the override the video would
  have the window's size, not `--size`; without the repaint pixel a still page sends no frames.
- **Allowlist.** Only an allowlisted tab; a `goto` off the list is refused before the run. When the
  tab's main frame navigates off the list, the run stops at once, writes no MP4 and no JSON, and runs
  no code in the off-list page (the screencast is stopped and the size override cleared).
- **Nothing runs in the tab after the run.** The final URL and title are read while the navigation
  guard is still on; the encode (which can take minutes) and the result never touch the tab again.
- **Errors are never hidden.** Every cleanup step runs (stop the screencast, remove the overlay, clear
  the override, remove the frames). A cleanup failure is added to the run's own error, which keeps its
  code; after a good run it is a `warnings` entry and a line on standard error.
- Not under the read-first rule (`shot`'s): a recording is a video for people, not a page read.
- At most 30 minutes per recording.

### The provenance JSON

`clip.mp4` gets `clip.json` beside it, mode 0600 (a run whose `--script` or `--setup` is that file
is refused before it starts). The recorded steps are kept as written (their typed text is on camera);
a setup step's typed text is not on camera, so only its length is kept (`"<10 characters>"`). An
error message shows a `type` step's text only as its length too, as the `type` command does. Facts only: `service` ("agent-browser"), `generator`, `version`, `url`, `finalUrl`,
`title`, `script`, `steps`, `setupScript`, `setup`, `width`, `height`, `scale`, `fps`, `video`
(`path`, `width`, `height`, `codec`), `cursor`, `seed`, `settleMs`, `createdAt`, `startedAt`,
`endedAt`, `seconds`, `frames`, `maxFrameGapMs`, `events`, `mode`, `chrome`, `warnings`.

`events` (also in the result) says when each recorded step ran, in seconds from the first frame of
the MP4, on the frames' own clock (so it matches the video within a frame):
`{"step": 3, "kind": "type", "start": 4.21, "end": 6.03, "first": 4.25, "last": 5.98}`. A `click`
has `press` (the moment of the press), a `press` step has `keys` (each key), a `type` step has
`first` and `last` (characters). Setup steps are not in it.

### Measured (macOS, Chrome Beta: 2026-10-30 on the public Sheets sample, 2026-11-05 on a probe page)

| Window state of the agent browser | Frames (agent flags, 2026-10-30) | Frames (no flags, 2026-10-30) | Frames (today's flag, 2026-11-05) |
| --- | --- | --- | --- |
| In front | 54 fps | 56 fps | not measured |
| Background tab in its window | 57 fps | 28 fps, gaps of 0.63 s | 60 fps, largest gap 18 ms (its window 100% covered) |
| The same tab after `Page.bringToFront` | 59 fps | 59 fps | not measured |
| Covered by another window | 60 fps | 47 fps, gaps of 0.23 s | not measured |
| A window of its own, covered (no focus emulation) | not measured | not measured | 60 fps, largest gap 18 ms (100% covered) |
| Minimized | 60 fps | 55 fps | not measured |
| App hidden (Cmd-H) | 60 fps | 60 fps | not measured |

"Agent flags" are the agent browser's launch flags of 2026-10-30:
`--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding` and
`--disable-background-timer-throttling`. After release v0.2.9 the two timer flags were dropped, and a
launch sets only the first (see **Launch flags and background tabs**). "Today's flag" is that one flag:
the Mac check of 2026-11-05 (`test/live/anti-detect/mac.ts`, Chrome Beta 158.0.8127.18, its own agent
Chrome behind the operator's Google Chrome; **One window per agent page on the Mac**) recorded 3 s at
60 fps of a probe page, and each take had 254 frames in 4.23 s with its settle time. With the one flag
a background tab got 60 fps, not the 28 fps of the "no flags" column: in this one take the two timer
flags were not needed for 60 fps. On Linux (taylor, 2026-11-04, Chromium 156, Xvfb) a 3 s recording of
a background tab got 60 fps with the one flag and with all three. On macOS the screencast kept a
minimized window and a hidden app painting at 55 to 60 fps also without the flags, and a covered window
at 47 fps; a background tab without the flags painted at 28 fps. In all the measurements of 2026-10-30,
and in the background tab of 2026-11-05, focus emulation was on, as `record` still has it for a
background tab (personal mode, `open --tab`). A window page has none: it draws without it (on
Linux, **The window**; on macOS, the row of the covered window of its own).
So the operator can work in another window during a recording, and on the Mac `record` does not bring the
tab forward (`Page.bringToFront` would activate Chrome and switch the operator's Space; on Linux see
**The window**). A recording at 1920x1080 and
`--scale 2` (3840x2160 frames) got 58.8 fps from Chrome. A cursor move, tracked frame by frame in a
60 fps recording, has a smooth bell-shaped speed with no repeated or skipped frame.

### Limits

- `waitIdle` cannot see a Google Sheets add-on's fill: the add-on runs on Google's servers, and its calls
  never reach the tab. Measured on a signed-in sheet (2026-10-30): after Enter it saw 3 requests (Sheets'
  own "Saving..." traffic) and passed while the cell still showed "Loading...". In vedlo's production
  takes the same day, the fills came 2.0-3.9 s after Enter. Use `waitChange` and `waitStill` on the
  cell's box for such a fill.
- `waitIdle` watches the tab and its dedicated workers only (not other frames). A worker is attached
  through the tab's session for the run only, and only on an allowlisted URL; Chrome's other targets are
  detached at once. On the public sample sheet signed out, the tab and its calc worker sent one request
  in 20 s (a log ping), even with input: a view-only sheet has no sync traffic.
- A long-poll request (open for minutes) that matches keeps `waitIdle` busy until `timeoutMs`: use a
  `match` that names the calls you wait for.
- `waitStill` pictures its box with `Page.captureScreenshot` about every 100 ms (a PNG decoded with
  Node's zlib; no dependency). A box that keeps changing for a reason other than the fill (a blinking
  caret, an animation) keeps it busy until `timeoutMs`: choose a box around the cells only.
- No clipboard: copy, cut and paste chords (`Meta`/`Control` + `C`, `X`, `V`, and `Shift+Delete`) are
  refused, because they use the machine's shared clipboard, which belongs to the person at the machine.
  Type the text: a `type` step with `\t` and `\n` fills cells and rows.
- No audio. Timing is real time: page loads vary between takes.
- `eval` steps run in the isolated world, not the page's.

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
`status(o, { notify })`, `connect(o, { endpoint })`, `stop(o)`, `window(o, { pin, unpin, anyScope })`,
`tabs(o, { anyScope })`, `open(o, { url, name, tab })`, `goto(o, { tab, url })`, `outline(o, { tab, all })`,
`click(o, { tab, target, text, download, timeout })`, `hover(o, { tab, target })`, `type(o, { tab, text, into })`,
`press(o, { tab, key })`, `text(o, { tab, selector })`, `eval(o, { tab, expression })`,
`shot(o, { tab, path, full, size, scale })`, `fetch(o, { tab, url, path })`, `download(o, { tab, url, path })`,
`close(o, { tab })`, `net(o, { tab, seconds, match, max }, { onEntry })`,
`record(o, { tab, out, script, setup, size, fps, scale, noCursor, settle, seed, ffmpeg })`, `chromes()`
(no options: every agent-browser Chrome of this user), `front(o)` (macOS; for a person only: it takes
the focus), `commands()`.
Each one that takes a `tab` also takes `anyScope` (see **Tab scopes**).
`COMMAND_SPECS` describes them (names, parameters, CLI usage).

**`AgentBrowser`** (one connection for multi-step work):

- `AgentBrowser.connect(options, { existingOnly? })`: connect through the proxy (see above).
- `allowedPages({ anyScope? })`, `otherPageCount()`, `open(url, { name?, newWindow?, timeoutMs? })`,
  `resolve(ref, { anyScope? })` (find a tab without attaching), `find(ref, { anyScope? })`,
  `attach(targetId)`, `windowOf(targetId)`, `pinnedWindow()`, `pinWindow(id | undefined)`,
  `forget(targetId)` (drop a closed tab from the record), `markRead(targetId, url)` and
  `readMark(targetId)` (the read-first record of `shot`), `disconnect()`. Properties: `conn`,
  `settings`, `allow`, `product`, `mode`, `tabScope`. The tab scope applies to `allowedPages`,
  `resolve`, `find` and `open`; `attach(targetId)` is the low-level call by exact target id, and it
  checks the allowlist and the pin only. `pinWindow`, `forget` and `markRead` are async (they change
  the record under its lock): await them. `pinWindow` and `forget` were synchronous before tab scopes.

**`Tab`**: `goto(url)`, `url()`, `assertAllowed()`, `evaluate(fn | expression, ...args)`,
`evaluateAsUser(fn | expression, ...args)` (as a user gesture; in a window of its own `evaluate` is none),
`withInput(fn)` (the input lock and the window's activation around a caller's own input; Linux),
`waitFor(fn, { timeoutMs, intervalMs, args, what })`, `waitForSelector(selector)`, `click(selector)`,
`clickText(text, { within })`, `clickAt(x, y)`, `hover(selector)`, `type(text, selector?)`,
`press(key)`, `setFiles(selector, paths)`, `text(selector?)`, `screenshot(path, { fullPage, viewport })`,
`fetchToFile(url, path)`, `download(url, path)`, `expectDownload(action, dir, timeoutMs=120000)` (agent mode only; a main-frame download;
allowlist checks, input lock, staging folder, one timeout and `bytes` in the result; see **Downloads that a click starts**), `expectResponse(match, action)` (capture an API response body; a CORS preflight's
response is never it), `watchResponses(match)`, `interceptRequest(urlPattern, transform, action)`
(rewrite a request body in flight; a CORS preflight is continued untouched), `close()`. Property
`drive`: `"window"` (a page in a window of its own, Linux), `"focus-emulation"` or `"hidden"` (the
two modes of a background tab; see **One window per agent page**).
`Tab.screenshot` is the low-level primitive; the read-first rule is in `commands.shot` and the CLI.

**Lower level:** `launchAgentChrome`, `agentEndpoint`, `agentChromePid`, `agentChromeBin`,
`findAgentPid`, `parsePs`, `processTree` (a Chrome's process tree, for example to record its audio),
`listAgentChromes` (what `chromes` lists), `parseUserPs`, `chromeMainProfile`, `isChromeBinary`,
`bringToFront` (what `front` does), `agentChromeFor`, `osascriptFront`, `FRONT_JXA`,
`restoresOnStartup`, `startProxy`, `stopProxy`, `proxyInfo`, `browserTarget`, `localBrowserStatus`,
`notifyBrowserStatus`, `outline`, `redact`, `netLog`, `isAllowedUrl`, `recordTab`,
`planRecording`, `parseSteps`, `parseKey`, `parseSize`, `planMove`, `pointAt`, `fittsMs`, `seededRandom`,
`findFfmpeg`, `runCleanup`, `withCleanupErrors`,
`loadAllowlist`, `resolveOptions`, `TAB_SCOPE_RE`, `CDPConnection`, `main` (the CLI in-process). Errors:
`AgentBrowserError` (with a stable `code`) and `UsageError`, `NotAllowedError`, `PinRequiredError`,
`ReadFirstError`, `TabNotFoundError`, `ChromeUnreachableError`, `ApprovalNeededError`.

## CLI

```
agent-browser <command> [args] --state-dir DIR --allowlist FILE [--json]
              [--profile DIR] [--socket PATH] [--mode agent|personal] [--chrome-bin PATH]
              [--chrome-args JSON] [--endpoint WS] [--cdp-url URL] [--personal-user-data-dir DIR] [--no-launch] [--no-prompt]
              [--notify-command JSON] [--approve auto|osascript|xdotool] [--approve-command JSON]
              [--proxy-idle-ms N] [--command-name NAME] [--tab-scope NAME] [--hidden-drive] [--input-timing JSON]
```

`chromes` and `commands` need no `--state-dir`.

`--any-scope` goes on `tabs`, `window` and every command that takes a `<tab>`; under a tab scope,
`window pin` and `window unpin` need it. See **Tab scopes**.

With `--json`, each call prints exactly **one JSON document** on standard output, success or failure.
Progress and warnings go to standard error. Exit status: 0 success, 1 failure, 2 usage error. Without
`--json`, the output is for people (as `vedlo browser` printed it). `agent-browser --help` lists
everything; `agent-browser commands --json` prints the machine-readable list.

A failure:

```json
{"ok": false, "command": "goto", "error": {"code": "not_allowed", "message": "refusing: example.com is not on the allowlist"}}
```

Error codes: `usage` (exit 2), `not_allowed`, `pin_required`, `read_first`, `tab_not_found`,
`unreachable`, `approval_needed` (`--no-prompt` and no approved proxy), `error` (exit 1).

When agentwatch manages the browser (`mode: "agent"` with `cdpUrl`), `open`, `goto`, and recording
navigation steps let the relay enforce navigation. A refused navigation reports its host and scope
to the carrier. The carrier creates a **Browser permission** prompt in the agentwatch web viewer.
Only an acknowledged report lets the error name that prompt:

```text
Not allowed: <host> is not on the allowlist. The operator has a Browser permission prompt in the agentwatch web viewer. Tell the operator; after the notice that the operator added <host>, start the step again.
```

The agent tells the operator: "You have a Browser permission prompt in the web viewer for <host>."
The agent waits for this notice: "The operator added <host> to your browser list. Start the blocked browser step again."
Then the agent starts the blocked step again. The agent must never work around a block.
The carrier shares its host limit with the extension's block notices. Repeated blocks can share an existing prompt.
An older carrier or a report without an acknowledgement keeps the existing refusal text.

Fetches and downloads keep their local checks. In agentwatch, their errors say:
`Ask the operator to add <host> to your browser list.` They do not create a navigation prompt.
Standalone agent-browser keeps its existing refusal text and local navigation checks.
Both modes keep the prior local scheme rules, including refusals of `data:`, `javascript:`, and `file:` URLs.
Managed navigation leaves HTTP, HTTPS, and web blob host decisions to the relay.
Relay host refusals keep the `not_allowed` error code and the complete relay message.
The Python adapter raises `NotAllowedError` for that code.
An extension block during a redirect can still report `navigation failed: net::ERR_BLOCKED_BY_CLIENT`.
That error has no reliable destination host; the extension sends the prompt event separately.

Two messages name their cause and fix. When `open` or `goto` lands on another host (a redirect), the
`not_allowed` message names both hosts and says that the tab stays open there; for a sign-in page
(`accounts.google.com` and similar) it says to run `launch --login` and sign in by hand. With
`--cdp-url` (`cdpUrl`), where `launch` refuses, it says instead to ask the operator to sign in to the
requested site in their own Chrome and to send that site's sign-in to the agent browser with the
operator extension (agentwatch — operator mode). `record` gives the same hint when the tab goes to a
sign-in page, with the site that the take was on last (the start page, a `goto` step's site, or an
allowlisted page that the tab went to). These sign-in hints stay separate from acknowledged relay refusals.
An acknowledged relay refusal names the prompt; a later local redirect or recording refusal keeps its existing sign-in hint.
With `--cdp-url`, `launch --login` refuses with the same
step. When Chrome
answers the connection with `403 Connection rejected` at once and shows no prompt, this Chrome run
holds an earlier refusal (a cancelled, closed or unanswered prompt): the `unreachable` message says to
`quit` and `launch` the agent browser again and click Allow, and the proxy log records the approval
as "refused".

Every success document has `"ok": true` and `"command": "<name>"`, plus the fields below. A `TabRef`
is `{"id": "<first 8 of targetId>", "targetId", "name": string|null, "url", "title"}`, plus `"scope"` for a tab
opened under a tab scope.

| Command | Result fields |
| --- | --- |
| `launch [--login]` | `started` bool, `endpoint`, `profileDir`, `login` bool, `opened` string[], `errors` `[{url, error}]` |
| `quit` | `proxyStopped` bool, `chromePid` int\|null, `closed` bool |
| `status [--notify]` | `connected` bool, `mode`, `target`, `detail` string\|null (why not connected), `product`\|null, `proxy` `{pid, upstream}`\|null, `profileDir`\|null, `allowedTabs` int\|null, `otherTabs` int\|null (a count only; never their URLs), `allowlist` string[], `window` int\|null, `notification` `{delivery: "queued"\|"unconfirmed", detail}`\|null |
| `connect <ws-url>` (personal) | `endpoint`, `product` |
| `stop` | `stopped` bool |
| `window [pin <tab> \| unpin]` | `window` int\|null, `tabs` TabRef[] (the pinned window's) |
| `tabs [--any-scope]` | `tabs` TabRef[], `window` int\|null; with a tab scope also `scope` and `outOfScope` int (the allowlisted tabs outside the scope: a count only) |
| `open <url> [--name N] [--tab]` | `tab` TabRef, `window` int\|null |
| `goto <tab> <url>` | `tab` TabRef (live URL and title) |
| `outline <tab> [--all]` | `tab`, `elements` `[{index, role, type: string\|null, label, href: string\|null}]` |
| `click <tab> <selector\|#N>` or `click <tab> --text LABEL`, with `[--download DIR] [--timeout MS]` for either form (agent mode only: personal mode refuses `--download`) | `tab`, `target` string\|null, `text` string\|null; with `--download`, also `download: {path, suggestedFilename, url, bytes}` |
| `hover <tab> <selector\|#N>` | `tab`, `target` |
| `type <tab> (<text> \| --stdin) [--into S]` | `tab`, `into` string\|null, `length` int (never the text). Into an input or a textarea it types inserted text, and key events when the field ignores that. Into an editable element (an app's own editor, such as the Google Sheets cell editor) it types one key event per character at once: inserted text can reach that DOM and never reach the app. When no text field has the focus, or the field's text did not change, it fails instead of reporting success. A tab or a newline in the text is a Tab or an Enter key: only the text before the first one is checked, so `type sheet $'a\tb\tc\n'` fills a row of cells in a spreadsheet without the clipboard. |
| `press <tab> <key>` | `tab`, `key` (Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, F1 to F12; a function key goes to the page only, never to Chrome's own shortcuts) |
| `text <tab> [selector\|#N]` | `tab`, `selector` string\|null, `text` |
| `eval <tab> (<js> \| --stdin)` | `tab`, `value` (the JSON value; `undefined` becomes `null`) |
| `shot <tab> [path] [--full] [--size WxH] [--scale N]` | `tab`, `path`, `fullPage` bool. Refused with `read_first` until `outline` or `text` read the tab at its current URL. Default path `<state-dir>/shots/<time>.png`. `--size`/`--scale` set the layout and pixel ratio for the shot only. The viewport PNG is W x N by H x N pixels. With `--full`, agent-browser measures the content through Chrome at width W. It uses that height for the expanded override and clip. Pages whose height depends on the viewport height can be cut at the bottom, as with plain `--full`. A failure to restore the tab is an error that names the saved file. |
| `fetch <tab> <url> <path>` | `tab`, `url`, `path`, `bytes` int, `contentType` |
| `download <tab> <url> <path>` | `tab`, `url`, `path`, `bytes` int, `status` int |
| `close <tab>` | `tab` |
| `net <tab> [--seconds N] [--match S] [--max N]` | `tab`, `seconds` (at most 3600), `entries`: `{kind: "http", method, url, body, status, mime, resp}` or `{kind: "ws", direction: "recv"\|"sent", data}` (redacted, clipped at `--max`, never headers; nothing after the tab leaves the allowlist) |
| `record <tab> --out clip.mp4 [--script S] [--setup S] [--size WxH] [--fps N] [--scale N] [--no-cursor] [--settle MS] [--seed N] [--ffmpeg PATH]` | `tab`, `path`, `provenance` (the JSON beside the MP4), `width`, `height`, `scale`, `fps`, `videoWidth`, `videoHeight`, `frames` (screencast frames kept), `seconds`, `maxFrameGapMs`, `steps` int, `events` (see **Recording**), `warnings` string[] |
| `chromes` | `chromes`: one entry for each agent-browser Chrome of this user on the machine, by pid: `{pid, profileDir, stateDir: string\|null, windowName: string\|null, commandName: string\|null, proxy: {pid, upstream}\|null}` (`proxy` is the state folder's approved proxy when it is up; see **Every agent browser on the machine**). Read-only; no `--state-dir`. |
| `front` | `chromePid`, `profileDir`, `stateDir` string\|null, `windowName` string\|null, `via`: `"activate"`\|`"activate-from"` (the request that brought it to the front). macOS only; elsewhere a `usage` error. For a person only, because it takes the focus; see **Bringing the asking window to the front**. |
| `commands` | `commands`: the command list (`name`, `summary`, `usage`, `params`) |

`fetch` and `download` act through an allowlisted tab and send the profile's cookies, so their URL
must be allowlisted too. A media CDN on another host (for example Suno's `cdn1.suno.ai`) needs its
own entry in the consumer's allowlist file. `fetch` follows the page's same-origin and CORS rules;
`download` uses Chrome's network stack.

### Downloads that a click starts

Use `click TAB SELECTOR --download DIR` or `click TAB --text LABEL --download DIR` in agent mode.
The option uses the same trusted click and the same allowlist checks as a normal click.
This option keeps the command list small.
The CLI resolves `DIR` from its current folder, like the path of `shot`.
An empty directory is a usage error.

```sh
agent-browser click exports --text 'Export to CSV' --download /tmp/exports --timeout 120000 --json
# {"ok":true,"command":"click",...,"download":{"path":"/tmp/exports/export.csv","suggestedFilename":"export.csv","url":"blob:https://example.org/...","bytes":1234}}
```

The JSON result includes the saved path, Chrome's suggested filename, the download URL, and the file size in bytes.
The text result prints these four fields too.
A later download keeps an existing file and uses a unique filename.
Without `--download`, the click result stays the same.

Personal mode refuses a download capture with a usage error.
The `click` command refuses it before it connects to Chrome or attaches a tab.
The library's `Tab.expectDownload` refuses it before any lock, directory change or CDP call.
A capture changes download behavior for the whole Chrome default context.
Personal mode uses the operator's own Chrome, so a capture could affect downloads in other windows.
Use agent mode for a capture.

Only a download that the tab's main frame starts counts.
Downloads from a child frame (iframe) or a new tab that the click opens are ignored.
A capture that gets only those downloads ends at the timeout.

`--timeout MS` takes a positive integer in milliseconds and requires `--download`.
The default is 120000 ms.
The timeout starts before the click, after the input lock becomes available.
The capture lets the click finish before it restores Chrome's download behavior.
The total time can exceed `--timeout` because the click finishes first.
The click retains its input timing and input limits.
The timeout error states the main-frame limit and explains that Chrome can wait for a person to approve a dangerous file.
Agent mode never approves these files.
The relay can also cancel a file that Chrome marks as dangerous.

`Tab.expectDownload(action, dir, timeoutMs=120000)` checks the allowlist before it acts and after it gets the input lock.
The checks precede download behavior changes, captures and size clears.
The library now holds the input lock during the action and the download wait.
Other input commands that share its state folder wait while the capture holds the lock.
This wait can last for the capture timeout, or longer if the click finishes later.
`timeoutMs` now covers both the start and completion of the download.
Earlier versions use a separate 30-second wait for the start.
The library result now includes `bytes` with `path`, `suggestedFilename` and `url`.

The capture checks the download URL when it starts, against the allowlist loaded for that connection.
Chrome reports the URL after every redirect, so the check uses the final URL.
A probe on Chromium 156 measured this for a link and for a `download` link that an allowlisted host redirects to another host.
The capture refuses a redirect from an allowlisted host to an off-list host.
It accepts a redirect chain that passes through an off-list host and ends on the list; Chrome has already sent those requests.
It accepts `data:` URLs.
For a `blob:` URL with an HTTP(S) inner origin, that origin must be on the allowlist.
An opaque blob origin has no HTTP(S) host to check.
The capture refuses an off-list HTTP(S) URL or blob origin, reports the full URL, and removes its output.
It refuses a URL that does not parse in the same way, with the `not_allowed` code and the full URL.
Chrome has already fetched an HTTP(S) URL with the profile's cookies by then.
This refusal stops the saved file, not the request.
The operator must add a download host to the allowlist if the export uses another host.

The library saves into a private staging folder under `DIR` and moves a completed file to its final path.
It removes the staging folder and unfinished output after success, refusal or timeout, unless the cleanup fails.
It restores Chrome's default download behavior.
A cleanup error is logged and preserves the original capture error.
When the cleanup fails, the staging folder `DIR/.download-XXXXXX` stays, and it can hold an unfinished or refused file.
The log line names the folder and gives the error code and message.
Remove that folder by hand.
This cleanup applies to `DIR` and its staging folder only.
In agent mode through the relay, Chrome's own download folder in the agent profile retains every file that Chrome finishes.
The relay copies those files to the caller's directory; it never moves them.
That behavior predates this CLI option.

## Python adapter (`python/agent_browser`)

Python 3.10+, standard library only, full type annotations (`mypy --strict` is clean), `py.typed`.

```python
AgentBrowser(state_dir, allowlist=None, *, profile=None, socket=None, mode="agent", chrome_bin=None,
             chrome_args=None, endpoint=None, cdp_url=None, personal_user_data_dir=None, no_launch=False, no_prompt=False,
             notify_command=None, approve=None, approve_command=None, proxy_idle_ms=None, command_name=None,
             tab_scope=None, hidden_drive=False, input_timing=None, node="node", package_dir=None, timeout=120.0, env=None)
```

Each argument from `state_dir` to `input_timing` is the CLI flag of the same name (`chrome_args` is
`--chrome-args`, `tab_scope` is `--tab-scope`, `hidden_drive=True` is `--hidden-drive`, `input_timing`
a mapping that goes as the JSON of `--input-timing`). `node`,
`package_dir`, `timeout` and `env` tell the adapter how to run the CLI. `timeout` (120 s) is the limit of
each call; `launch`, `net` and `record` add their own wait, and `click`, `hover`, `press` and `type` add the
input lock's wait (`lockWaitMs` of `input_timing`, 600 s by default) and, for `type`, 0.35 s for each
character of the text (in agent mode on Linux a person's typing takes about 0.2 to 0.3 s a character for the
first 12 s of a run, then about 0.12 s), so a long
text and a wait for another agent's input fit. `text`, `outline` and `eval` wait for the input lock inside
their `timeout`, as the Node client's `Tab.waitFor` does (review-52): a read of a hidden window page brings
its tab in front inside the lock (**One window per agent page**), and that wait may take all of the timeout
but 30 s, and at least half of it (90 s of 120 s; the adapter passes it as `lockWaitMs`, never more than
the caller's). A longer wait fails with the lock's own error, and a read that hangs for another reason
fails at the timeout, not 600 s later. Give a read a longer `timeout` where it can wait for another agent's
long typing or `record` take.
`chrome_args` is a list of Chrome flags, `["--lang=en-US"]`. `approve` is `True` (the same as
`"auto"`), `"osascript"` or `"xdotool"`. `approve_command` is a custom approver as an argv list, in place
of `approve` (give one of the two, not both). `notify_command` and `approve_command` are argv lists, never shell strings. The adapter
sends `chrome_args`, `notify_command` and `approve_command` to the CLI as one JSON array each, and
raises `ValueError` for a value of the wrong type and for an empty path argument (`""`).

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
| `tabs(any_scope=False)` | `TabsResult(tabs, window, scope, out_of_scope)`; `scope` and `out_of_scope` are None with no tab scope |
| `open(url, name=None, tab=False)` | `OpenResult(tab: TabRef, window)` |
| `goto(tab, url)` | `GotoResult(tab)` |
| `outline(tab, all=False)` | `OutlineResult(tab, elements: list[OutlineElement(index, role, type, label, href)])` |
| `click(tab, target=None, text=None, *, download=None, timeout=None)` (agent mode only for `download`: personal mode raises `UsageError`) | `ClickResult(tab, target, text, download)`; `download` is `CapturedDownload(path, suggested_filename, url, bytes)` or `None` |
| `hover(tab, target)` | `HoverResult(tab, target)` |
| `type(tab, text, into=None)` | `TypeResult(tab, into, length)`; the text goes on stdin |
| `press(tab, key)` | `PressResult(tab, key)` |
| `text(tab, selector=None)` | `TextResult(tab, selector, text)` |
| `eval(tab, expression)` | `EvalResult(tab, value)`; the expression goes on stdin |
| `shot(tab, path=None, full=False, size=None, scale=None)` | `ShotResult(tab, path, full_page)` |
| `fetch(tab, url, path)` | `FetchResult(tab, url, path, bytes, content_type)` |
| `download(tab, url, path)` | `DownloadResult(tab, url, path, bytes, status)` |
| `close(tab)` | `CloseResult(tab)` |
| `net(tab, seconds=None, match=None, max=None)` | `NetResult(tab, seconds, entries: list[NetHttp \| NetWs])` |
| `record(tab, out, script=None, setup=None, size=None, fps=None, scale=None, no_cursor=False, settle=None, seed=None, ffmpeg=None)` | `RecordResult(tab, path, provenance, width, height, scale, fps, video_width, video_height, frames, seconds, max_frame_gap_ms, steps, events: list[RecordEvent(step, kind, start, end, press, keys, first, last)], warnings)` |
| `chromes()` | `ChromesResult(chromes: list[AgentChrome(pid, profile_dir, state_dir, window_name, command_name, proxy: ProxyInfo \| None)])`: every agent-browser Chrome of this user, not only this consumer's |
| `front()` | `FrontResult(chrome_pid, profile_dir, state_dir, window_name, via)`: macOS only (elsewhere `UsageError`); for a person only |
| `commands()` | `CommandsResult(commands: list[CommandSpec])` |

`click` keeps `any_scope` in its existing fourth positional slot. Its new `download` and `timeout` options are keyword-only.
A `download` capture is for agent mode only: in personal mode, `click` raises `UsageError` before the CLI connects.

Each method that takes a `tab`, and `window`, also takes `any_scope=False` (see
**Tab scopes**). `TabRef(id, target_id, name, url, title, scope)`; `scope` is None for a tab with no
scope. `tab_scope` must be a `str` or None: any other type raises `ValueError` in the constructor,
before any call (the CLI checks the name itself). `node_version()` returns the node version as a tuple.

Errors (all `AgentBrowserError`):

- `NodeNotFoundError`: `node` is missing or cannot run.
- `NodeVersionError`: `node` is older than 26.
- `PackageNotFoundError`: no `bin/agent-browser.js` in `package_dir`.
- `ProtocolError`: the output is not one JSON document of the expected shape, or the call timed out.
- `CLIError`, with `code`, `message`, `command`, `exit_status` and `stderr`. Its subclasses follow
  the code: `UsageError`, `NotAllowedError`, `PinRequiredError`, `ReadFirstError`,
  `TabNotFoundError`, `ChromeUnreachableError`, `ApprovalNeededError`.

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
- `test/allowlist.test.ts`: matching, the file, and no built-in denylist.
- `test/giveback.test.ts`: the give-back guard of a macOS start (`src/giveback.ts`). Its script runs in
  a `vm` context with a fake AppKit bridge (a scripted front app and clock), and the start of the
  guard runs a stand-in for `osascript`. No real `osascript` runs, and no app is activated.
- `test/watchback.test.ts`: the Mac's give-back watcher (`src/watchback.ts`). Its script runs in a `vm`
  context with a fake AppKit bridge (a scripted front app, mouse buttons, Command key, HID time, hold
  files and clock): it gives each take back, and it leaves a take to the operator after a click, a tap,
  Cmd-Tab, during `front` or an approval, and at a start in front, but not after keys alone. Its node
  process runs with a stand-in for `osascript` and a stand-in agent Chrome: it ends with that Chrome
  (also when only `ps` shows another program at that pid), at SIGTERM and at `quit`, keeps reading the
  script's pipe, and runs once for each Chrome. `launch` and the commands start it on the Mac only. No
  real `osascript` runs, and no app is activated. On the Mac's window design (`open`, no activation, the
  paths from the page's last point, the wait for a hidden opener): `test/window-per-page.test.ts`
  against the fake Chrome's Mac model.
- `test/cli.test.ts`: the JSON contract of every command, and the safety rules through the CLI.
- `test/chromes.test.ts`: `chromes` on crafted `ps` rows of Linux (procps) and macOS (BSD ps).
  Skipped: other users' rows, Chrome's helpers, the crashpad handler, `open`, `timeout`, other app
  bundles, and processes that only name a profile. Covered: a state folder with and without an
  approved proxy, a pid file that names another state folder's, profile's, mode's or upstream's
  proxy, a stale pid file, a restoring profile, the last `--user-data-dir`, and another user's
  files (never read). Through the CLI with a stand-in `ps`, it proves that the listing connects to
  nothing and signals nothing: stand-in processes own the profile's debugging port and the proxy
  socket, and log each connection and signal. They end by themselves with the test.
- `test/front.test.ts`: `front` with crafted macOS `ps` rows, real `SingletonLock` links in the temp
  folder, and a stand-in for `osascript`, `lsappinfo` and `sw_vers`, so nothing is activated.
  Covered: the request names only the agent Chrome's pid, never the operator's own Chrome of the same
  app or another consumer's (also one whose profile `ps` reads short at a " -"); a Chrome that an
  agent-browser proxy drives; the refusals (no lock, a stale lock, a lock that names no agent Chrome,
  a pid that another program has now by its executable or its launch date, a pid that this login
  session has no app for, a Chrome that quit, a reply that cannot be read); the second request on
  macOS 14 and later only; the failure text with the macOS version; the time limit; personal mode and
  Linux. The JXA script runs in a stand-in of the ObjC bridge (`node:vm`): the names that it uses, the
  unhide before the activation, the 5 s launch-date window. Also the CLI on Linux, and the notice.
- `test/tab-scope.test.ts`: tab scopes, through the library and the CLI: each form of `<tab>`, every
  command that takes one, the count of the others, `--any-scope`, names per scope, the record and its
  lock (parallel CLI calls of two scopes lose no record and no read mark; `open` closes a tab that it
  cannot record), `window pin` and `unpin` under a scope, and no change without a scope.
- `test/endpoint-scope.test.ts`: the record of each endpoint scope (ab-v16.58; vedlo-codex's
  reproduction): against a fake endpoint whose two scopes each list only their own tabs, two connections
  with one state folder keep each scope's read marks and pin; the folder names (capital letters, refused
  scopes, no endpoint scope); over the relay, two sessions' commands with one state folder, as agentwatch
  runs them, keep their names, tab scopes and read marks, in one process and in two; and two endpoint
  scopes' input commands share the state folder's one `input.lock` and `pointer.json` and never overlap.
- `test/record.test.ts`: `record` and `shot --size` through the CLI. The fake screencasts real JPEG
  frames and, like Google Sheets, refuses `innerHTML`, `<style>` and inline style attributes. The tests
  that encode need ffmpeg and ffprobe on `PATH` (skipped without them).
- `test/shot-full-size.test.ts`: both CLI paths measure the content after the requested width override.
  The tests check the full-height override, capture parameters, cleanup, Chrome errors, and allowlist refusal.
- `test/live/shot-full-size-default.ts`: a headless Chromium checks full-page PNGs at three requested sizes.
  The agent-mode own harness runs the same check with `CASES=shot-full-size`.
  Both checks use local pages and compare bands for exact copies of the first screen.
  `SHOT_BASELINE=1` reports the copies without failing, for comparison with an older revision.
- `test/live/takeover/` (macOS; see the head of `check.ts`): drives one `about:blank` tab of a running
  agent browser while a monitor logs the frontmost app and the pointer, then names any command that
  changed either. Not part of `npm test`.
- `test/live/takeover/start.ts` (macOS; see its head): starts the agent Chrome N times with `launch`
  while the same monitor logs the frontmost app before, during and after each start; then it quits
  only that Chrome. By default each start gets a fresh state folder of its own, so it measures the
  first start of a profile; with `--same-profile` all starts share one new folder, so starts 2 to N
  measure the restart of a used profile. With `--same-profile --restore`, Chrome also gets
  `--restore-last-session` (what "Continue where you left off" does), so starts 2 to N restore the
  session before, and the restore activates its last window at its end: a second take of the front.
  It runs only with `--on-my-screen` and opens no debugging
  WebSocket (`launch` makes only a TCP probe of the port), so Chrome shows no approval prompt. It
  exits 1 when a start broke its variant's rule (below) or could not be measured (for example, the
  monitor stopped). It does not measure the Space. Not part of `npm test`; `test/takeover-start.test.ts` tests
  its argument guard, its variants, its analysis and its flow with a fake Chrome. Before start 1 it
  compares the monitor's front app with `lsappinfo front`, and it stops when they differ. Compile the
  monitor with `swiftc -swift-version 5 -O test/live/takeover/monitor.swift -o /tmp/abfs-monitor`.
  `--variant` changes one thing of each start, so that one run measures one way to start with the
  same monitor and analysis: `launch` (the default: `open -n -g` with the built-in give-back), and
  for comparison, with the built-in give-back off, the two candidates of 2026-11-04: `hidden`
  (`open -n -g -j`) and `give-back` (`open -n -g`, while `giveback.swift`, given with `--giveback`,
  asks macOS to activate the app that was in front again; no Chrome starts unless the helper names
  the front app that the monitor and `lsappinfo` name). The comparison variants run `launch` through
  `launch-variant.ts`, with measurement hooks that the CLI never sets. No variant opens a debugging
  WebSocket. Each result has `awayMs`: how long the front was away from the app in front before the
  start. Under `launch` and `give-back` a start passes when the front came back within 250 ms, went
  to no other app, and the pointer did not move. Under `hidden` a start passes only when the front
  never changed. The output folder keeps each start's `launches.log` lines (`launches-N.log`). A
  failed launch ends the run (exit 1), so that a run stays short.
- `test/live/function-keys/` (Linux, in a private Xvfb; macOS only with `--on-my-screen`, because
  its windows reach the person's screen and take the keyboard focus; see the head of `check.ts`): the
  function-key check of #7. Its own Chrome, on a throwaway profile, with one local page, gets each key
  three ways (as before #7 on Linux, through `record`'s press step, through `press`), and the check
  records what the page saw and what Chrome did. Not part of `npm test`. Measured on macOS on
  2026-11-04 (`--on-my-screen`, Chrome Beta 158.0.8127.2 and Google Chrome 156.0.8078.81, 209 trials
  each, exit 0): every `record` and `press` key reached the page, and none had an effect outside the
  page. The before controls (on macOS real Mac key events, not a replay of agent-browser before #7)
  showed Chrome's shortcuts: F7 and Meta+L (the focus left the page), F12 and Meta+Alt+I (DevTools),
  Meta+R (reload), Meta+W (the window closed) and Meta+T (a new tab). A `--background` run (Chrome
  Beta) exited 1, as expected: its `record` and `press` trials were not measured. The head of
  `check.ts` gives these results and the Linux results of 2026-11-03.
- `test/relay-policy.test.ts`, `test/relay.test.ts`, `test/relay-scopes.test.ts`, `test/relay-link-up.test.ts`,
  `test/relay-commands.test.ts`, `test/relay-windows.test.ts`, `test/relay-pointer.test.ts`,
  `test/relay-pointer-model.test.ts`: agent mode's relay (`agent-browser relay`,
  contracts C4, C10 and C11 of chrome-extension's `docs/protocol.md`) with a fake receiver and daemon
  (`test/fake-bridge.ts`, which also models windows, their focus, each window's active tab and each tab's
  scope): the policy and the allowlist line against the contracts' vectors (copied in
  `test/vectors/chrome-extension-40c2d93/`), the model through real CDP clients on the socket, one allowlist per scope, the steps of the
  link up, one window per page on Linux and the Mac's tabs, and agent-browser's own commands over the
  endpoint (`--cdp-url`) with the fake Chrome behind the fake receiver. Over the endpoint the fixture site
  is `fixture.localhost` (a list entry is never an IP address; the fake Chrome reaches it on 127.0.0.1).
- `test/contracts-c11.test.ts`, `test/contracts-c12.test.ts`: the contracts in `docs/contracts/` (board task
  ab-v16.94.1): C11 (the endpoint; its text and its tests moved here from chrome-extension, with its vectors
  `test/vectors/endpoint.json`; its part "The input stage" of board ab-t30.6, with `test/vectors/stage.json`, the
  contract that the stage's build follows), C12 (the control door of the self-contained agent browser, with
  `test/vectors/control.json`) and the format of the MCP's allow list (`test/vectors/mcp-allow-list.json`).
  Each test asserts the exact sentences of the text, and small reference rules check each vector.
- `test/relay-peer.test.ts`: the peer check (`--peer-check`). The contract's peer vectors (`upgradeChecks`,
  `lineCloses` and `lines` with the peer check: each gives the peer and a fake process table) run through
  the relay with a fake reader behind the reader interface. On Linux the real reader runs too: the
  self-test from a child process, its kernel branch (`ENOPROTOOPT` selects the stat form), its compares and
  its time limit; the relay with real processes of the test (a client under its scope's root admitted,
  others refused, a re-parented job refused where the root has no cgroup of its own, the 1008 of a root
  change); and a check that no other command loads `node:ffi` (they run with `--no-experimental-ffi`).
- `test/live/README.md`: the two rules of every live harness that starts Xvfb or Chromium on Linux
  (board ab-v16.78): no Xvfb, Chromium or other process of the harness after its driver ends, also
  after a `kill -9` of the driver (a guard process outside the driver's tree records the driver's
  processes and stops them), and one harness at a time on the box (the guard's `flock` on
  `~/.cache/agent-harness/harness.lock`, at most `HARNESS_LOCK_WAIT` s, default 1200, then exit 2).
  The guard is `test/live/harness_guard.py` (the same file in chrome-extension) with its Node client
  `test/live/guard.ts`; `test/harness-guard.test.ts` kills a stand-in driver with `kill -9` and checks
  with ps that none of its processes is left after 10 s, that a second harness waits for the lock
  until then, that the wait has its limit, that a harness that a harness starts does not wait (and an
  unrelated one does), that a reused pid gets no signal, that a pid that is not the driver's is left
  alone, that a child started after the driver's end is stopped too, that the guard keeps no inherited
  fd, and that no harness takes a reserved display (0, 90, 147, 190-192).
- `test/live/agent-mode/` (Linux, in a private Xvfb; see the head of `run.ts`): agent mode live. A
  Chromium of its own loads chrome-extension's agent package; a stand-in for the daemon's bridge side
  and `agent-browser relay` from a scratch install serve the endpoint; the probe's Playwright, MCP and
  concurrency cases run against it, with the C11 refusals, the tab switch of the timer answer (ab-vsm
  Q4) and agent-browser's commands with `--cdp-url`. The stand-in daemon sends `set_scopes` (list a,
  `a.localhost`, as the default; list b, `b.localhost`, for the group `scopes`). Its group `windows`
  drives the anti-detect probe's page (`test/live/anti-detect/probe.ts`) in its own window with
  Playwright (with and without `noDefaults`) and the Playwright MCP while another window has the focus,
  and checks that the page shows no background-tab signal; it also measures two Playwright clients that
  type at once. Its group `scopes` drives two scopes with two lists through Playwright, the Playwright MCP
  and agent-browser: each scope's own list loads, the other's is refused or blocked, popups of eight kinds
  ten times each keep their opener's scope, and `end_scope` and a `set_scopes` without the scope close
  its tabs and connections while the browser's last window stays. Its group `link-up` checks a relay
  restart, a session that ends while no relay runs, a link drop, and the closes of the browser's only
  tabs. Its group `pointer` (board ab-v16.71) is the agent pointer design's live check: the stand-in daemon
  answers `daemon.pointerAt` and `daemon.movePointer` itself with xdotool on the run's own Xvfb only
  (`test/live/agent-mode/pointer-ops.ts`; `test/pointer-daemon.test.ts` runs every contract vector p1-p108
  against it), and the group counts jumps, unexplained position changes, zero-movement path moves and the
  `xdotool sleep` dt in both pages of each activation (`pointer-live.ts`, `pointer-measure.ts`;
  `POINTER_DAEMON=old` runs the stand-in as a daemon from before those ops).
  Chromium gets `--disable-backgrounding-occluded-windows`. Its group `peer` (`CASES=peer`, alone)
  runs the relay with `--peer-check` and two panes of the run's own tmux server as the roots (see **The
  peer check**). `CHROME_EXTENSION=<a detached worktree of chrome-extension at main c99bebb (0.3.1) or
  later> npm run test:live:agent`. Not part of `npm test`. At its end it removes the large parts that it
  made in its run folder (the scratch install, the tarball, Chromium's home and profile, the agent copy),
  and the whole folder when it made that folder itself and no case failed; `KEEP_RUN=1` keeps everything
  (`test/live/agent-mode/run-folder.ts`, checked by `test/agent-live-run-folder.test.ts`).
- `test/function-keys.test.ts`: the function-key check's pure parts (`test/live/function-keys/trials.ts`):
  the start guard, the trials and Chrome switches of each platform, the "before" key events and the
  failure rules.
- `test/live/background-tabs/` (`node test/live/background-tabs/check.ts --out-dir DIR [--before]`;
  Linux only, in a private Xvfb; see the head of `check.ts`): agent-browser still drives background
  tabs without the two timer flags. It goes through agent-browser's own launch, with the xdotool
  approver of **Unattended approval**, on a new state folder, with one local page and no network. agent-browser opens two tabs in the background, and
  the check drives each one by its name (click, type, eval, text, shot) while the other tab, or the
  launch's `chrome://inspect` tab, is in front; it switches the front tab and back, and records each
  tab for 3 s. It measures each tab's 50 ms timer while no command is attached, and after each drive
  it checks that the driven tab is hidden again (no animation frame) and the front tab visible. A
  shot must show the page's colour box, button and status line in their own colours. `--before` adds
  the two timer flags back. Not part of `npm test`. Measured on taylor on 2026-11-04 (Chromium
  156.0.8078.79), with and without `--before`, all exit 0; see **Launch flags and background tabs**
  and the head of `check.ts`.
- `test/background-tabs.test.ts`: the background-tab check's pure parts
  (`test/live/background-tabs/rules.ts`): the start guard, the Chrome switches, the timer statistics,
  the visibility log, the shot's pixels (a full picture, and one drawn only above y=256) and the
  failure rules.
- `test/live/background-tabs/visibility.ts` (`node test/live/background-tabs/visibility.ts --out-dir DIR
  [--hidden-drive]`; Linux only, in a private Xvfb, through agent-browser's own launch as `check.ts`;
  see its head): what a command on a background tab shows a site, in the default mode or with
  `--hidden-drive`. Each probe page reports its `visibilitychange`, `focus`, `blur`, input and animation
  frames to the check's server with `navigator.sendBeacon`, so the log needs no CDP call. The check runs
  eval, text, outline, hover, click, type, press, shot, `shot --size` and `shot --full` in a background
  tab, a click and a shot in a new background tab, a goto then input, a record, and a click and a shot
  in front, and gives each command's visible time. Each command must work. With `--hidden-drive`, in a
  background tab the page must also have no visible time and no `visibilitychange` (a record's span is
  reported), and no frame in the second after the command. Not part of `npm test`. Measured on taylor on
  2026-11-04; see **A command on a background tab: two modes**.
- `test/live/background-tabs/override.ts` (`node test/live/background-tabs/override.ts --out-dir DIR
  [--display 96] [--trials 3]`; Linux only, in a private Xvfb, with its own Chromium and a debugging
  port that only it uses; see its head): what Chrome does with a capture sent under a size override that
  is still in flight at the clear or at the end of its session, with the page hidden and visible. It
  gives the trials whose view kept the override's size. Not part of `npm test`; the fake Chrome models
  what it measured (`FakePage.metrics`). Measured on taylor on 2026-11-06; see **A shot, in both modes**.
- `test/display.test.ts`: the display gate (`src/display.ts`) against a fake xdotool, xprop, xdpyinfo, pid and
  clock: the windows check, a Wayland session and a window manager (not own), the answer of one minute
  for the same Chrome pid (with `/proc/<pid>/cmdline` in place of `ps`), the log line at most once in 5
  minutes, a check that fails (not own, with a clear line), `cdpUrl`, and the real check under the test
  runner.
- `test/window-per-page.test.ts`: one window per agent page on Linux, against the fake Chrome's model
  of a window that is not in front (`FakeChrome.focusedWindow`: the page is visible and draws, and gets
  the focus at its first press, which activates its window; keys into an inactive window give the page
  the focus with no switch). `open` sends `newWindow: true, background: true`, no command sends focus
  emulation (also `record`, also with `hiddenDrive`), and a page that a site opens is driven where it
  opened. `open --tab` keeps the old default (and the hidden drive) for its tab, also in later
  commands, through `tab-pages.json`, also after the gate's fallback. The gate's log line comes at a
  command that opens or attaches a page, not at `tabs`. Through `bin/agent-browser.js` (Linux only),
  `open` and `click` with the real display check and stand-ins for `ps`, xdotool, xprop and xdpyinfo. On the Mac
  and in personal mode, `open` and focus emulation stay as before.
- `test/person-input.test.ts`: a person's input in a window of its own on Linux, against the fake
  Chrome (its windows, the X pointer's event when a window comes forward, a page that scrolls, the
  caret of a field, the file chooser): `Page.bringToFront` before the first input event of a page with
  no focus, never for a read; a path of 12 or more moves from the pointer's place (the activation's
  real event, else the page's last point, also in a later process), a press with force 0.5 of 70 to
  90 ms with the default timing; the X pointer moves to each path's end only through xdotool on a
  display that holds the agent browser only; `type --into` clicks the field where `el.focus()` puts
  the caret (keys correct it; a field that the click does not focus gets `el.focus()` with a log
  line), and types with a person's keyboard patterns (holds, rollover, a real Shift key); the wheel brings an element into
  view (no `scrollIntoView`); `setFiles` clicks the input or its label and fills the chooser's input;
  two processes' input commands never overlap (`input.lock`); a popup is driven in its tab, and the
  opener comes back with a tab switch; `open --tab`, the Mac and personal mode keep today's input.
- `test/input-lock.test.ts`: the input lock stays one per agent browser (ab-v16.46, the operator's
  ab-1bi), against the fake Chrome: pages of two sites share the one `input.lock` and their input never
  overlaps, in one process and in two, as on one site; another process's lock makes input on any site
  wait; reentrance in one call chain; after two sites typed at once no page holds the focus behind
  another window, and a later page of the first site is its only focused page; the X pointer moves only
  over the window in front; `Tab.waitFor` reads its condition during the wait for the lock (review-52
  note 3), waits for a tab switch that its timeout interrupts and reads once more, and ends the switch's
  wait for the page to show when its condition holds (review-55); `withFileLock` takes a crashed
  holder's lock in its last try (note 4), never in the same few milliseconds as its clear (a second
  waiter that read the same dead pid never removes its live lock, review-55), and stops its wait at a
  signal.
- `test/hidden-tab.test.ts`: the CDP calls that each command sends to a background tab in both modes,
  against the fake Chrome's model of one (`FakePage.background`: the page is hidden, Chrome draws no
  frame of it, a page that never drew drops a press or a key, a mouse move waits for a frame, a capture
  sent while Chrome draws nothing waits for a later one). The default mode sends focus emulation on
  attach, as before. With `hiddenDrive` no command but `record` sends it; click, click --text, hover,
  type (also key events into an app's own editor), press and `Tab.clickAt` work as the first command
  on a new tab that never drew; a page that draws by itself gets a new capture each time one ends;
  every capture ends; a shot sends no capture while it changes the device emulation; `record` turns
  focus emulation on for its run only. Also the pure parts of `visibility.ts` (`spans.ts`).
- `test/live/sheets.ts` (`npm run test:live -- --state-dir DIR --allowlist FILE`): not part of
  `npm test`, because it contacts Google. It records the public Sheets sample in a running agent browser
  (an allowlist with `docs.google.com`) and checks the MP4, the events, `shot` sizes and that the tab
  is restored.
- `test/live/parity/` (Linux or macOS; see the head of `probe.ts`): the parity probe of
  `docs/research/2026-11-03-chrome-vs-chrome-beta.md`. It runs Chrome stable, Chrome Beta or
  Chromium on throwaway profiles against a local `probe.localhost` site that records what a site
  sees, and a stand-in extension that drives the tab through `chrome.debugger`. A local proxy
  refuses all other traffic. Not part of `npm test`.
- `test/live/anti-detect/` (Linux, in a private Xvfb; see the head of `run.ts`): the measurement of
  `docs/research/2026-11-05-anti-detect-drive.md`. Each scenario starts a Chromium of its own on a
  pipe (no debugging port) and drives a probe page that is not in front: agent-browser's default and
  `--hidden-drive` modes, one window per page, a tab switch or focus emulation for input only,
  Playwright behind a bridge with and without its focus emulation, and a person (xdotool) as the
  baseline. The page logs every visibility, focus, frame, timer, observer and input signal with
  timestamps; `report.ts` prints the tables; `extra.ts` holds the review's checks (window order, two
  agents with and without an input lock, popups, the pointer at an activation, memory and CPU), and
  since ab-v16.26 `--exp pointer` (each way to treat the X pointer, against a person) and `--exp caret`.
  The `design`, `design-no-x`, `design-two` and `design-two-sites` scenarios run the whole design with
  agent-browser's own commands, with several activations of one window and with two agents at once (on
  one site, and since ab-v16.46 on two sites, `probe.localhost` and `other.localhost`; then a third
  agent on the first site; each page's own sequence of `focus`, `blur` and keys during its commands),
  against the person baselines `person-window` and `person-window-multi`. Since ab-v16.26 the probe also counts position
  changes that the movement does not explain, entries at an earlier entry's point, and a user
  activation with no input. Not part of `npm test`.
- `test/live/anti-detect/mac.ts` (macOS, with the operator's consent and nobody at the keyboard; see
  its head): `node test/live/anti-detect/mac.ts --on-my-screen --out-dir DIR`, about 2.5 minutes. In
  its own agent Chrome (today's flags, `open -n -g` and the give-back) it runs agent-browser's Mac design
  as built (ab-v16.27; before it, ab-v16.16, ab-v16.44 and ab-v16.68 measured the Mac with background
  tabs and a prototype watcher): where each new agent window of `open` comes in the window order, the
  Space, the front app, agent-browser's commands and a 3 s `record` in a window of its own, the focus
  between agent windows, keys into an inactive window, agent-browser's person-shaped click and typing
  (a path from the page's last point), popups and the real pointer's events. And:
  - **agent-browser's give-back watcher** (`src/watchback.ts`), which `AgentBrowser.connect` starts as on
    the Mac for each command: the check waits for its `watch` line in `launches.log`. From then on it
    gives the front back, and the check's own watcher only logs (it arms again only when a take is still
    open after 800 ms, `FALLBACK_MS`). The summary gives each take as both saw it, and who gave the front
    back. At its end the watcher must end within 2 s of its agent Chrome's quit (`WATCH_END_MS`), else
    the check names a problem. `stop-chrome.txt` names it.
  - **The popup rule as built**, from the page in a window of its own: agent-browser's click opens each
    popup; its click in the `target=_blank` popup tab (drive the new tab); the way back only by the
    popup's close (agent-browser's `close`, or the `window.open()` popup's own `window.close()`); and
    agent-browser's next click in the opener, which waits until the opener shows again. For each: the
    opener's visibility, its `focus` and `blur` events and `document.hasFocus()`, the front app, the
    Space and the opener window's place.
  - **agent-browser's `front`** (`--skip front` leaves it out): the agent Chrome comes to the front on
    purpose for about 2 s; the watcher must leave it there (`own=front`), and then the check gives the
    front back itself.
  - **Google Chrome (stable)**, when it is installed in `/Applications` and is not the first part's
    agent Chrome: after the first agent Chrome quit, a short second run of the check in it (`--part
    stable`, in its own run folder `run-XXXXXX/stable/`, with a new empty profile): its start, the
    give-back watcher, one window and the popups from it with the popup rule. It runs only when the
    first part ran to its end, and not after `--look`; `--skip stable` leaves it out. No watcher runs
    between the two parts, so the first part hands the stable part its watcher's last look at the input,
    the pointer's point, its Space and a monotonic lower limit of the gap (`--quiet-since`, `--pointer`,
    `--space`, `--gap-ms`), and the stable part refuses before its Chrome starts when its own watcher's
    HID readings, pointer or Space show a person in that gap, or when the wall clock went back. When
    Google Chrome is not installed, the summary says so: the check installs nothing.

  As `test/live/function-keys/` is, it is an exception to the rule against `--remote-debugging-port`
  (Hard rules): its agent Chrome gets
  `--remote-debugging-port=0`, so that no "Allow remote debugging?" prompt needs a person, on an
  empty throwaway profile in its run folder, with no network, on 127.0.0.1 only, for the few minutes
  of the run; the check quits that Chrome at its end (SIGKILL when it must) and removes the profile.
  Its watcher (`mac-watch.swift`, compiled by the check) gives the front back, and stops doing so at
  the first sign of a person (a pointer move, or a key press, a click or a scroll of the hardware);
  the check then ends the step in progress at once (it reads its stop rules every 100 ms) and quits
  its Chrome. It refuses before its Chrome starts when a HID reading of the watcher is 0 or less, or
  when a person used the Mac after the watcher's start. Apps that post keyboard or mouse events
  (remote-desktop apps, Karabiner, a mouse jiggler, Universal Control) look like a person to it and
  stop it: quit them first. Its `results.json` keeps no key values (only event types and counts).
  The check exits 0 only when it never took the operator's focus or Space. It needs ffmpeg with
  libx264 (or `--skip record`). No other agent session may use the Mac's agent browser during the
  run. At a stop no agent-browser command starts, a command that is in progress sends no more input event
  and no request of `front` (the internal `stopped` option), no give-back watcher starts, and agent-browser's
  watcher keeps running until the agent Chrome quits (review-69c B1). `--dry-run` runs it on Linux in a private Xvfb with agent-browser's Mac design (the internal
  `platform` option), a stand-in watcher and a stand-in for the give-back watcher's `osascript`
  (`mac-standin-watchback.ts`), and its second part with the same Chromium on the next display;
  `test/live/anti-detect/mac-dry.ts` runs the dry runs of a review one after the other (plain, a key, a key
  between the parts, a refusal, a stop in `front`, a stop in a popup's click, a `kill -9` of node) and stops
  what each one left, by pid. Not
  part of `npm test`; `test/mac-measure.test.ts` tests its pure parts (`mac-rules.ts`),
  `test/watchback.test.ts` the give-back watcher (its script against a fake AppKit bridge, its node
  process with the stand-in), and `test/mac-watchback.test.ts` the prototype of 2026-11-06. It ran on the
  operator's Mac on 2026-11-05 (main 87be973, Chrome Beta 158), before the ab-v16.68 steps, and on
  2026-11-06 with them (PR #66 at dc54cb1, Chrome Beta 158 and Google Chrome 156; 132 s, exit 0 in both
  parts), both before the Mac build. The results: **The Mac runs** under **One window per agent page on
  the Mac**.
- `test/parity-fingerprint.test.ts`: the probe's JA4 and HTTP/2 fingerprints, against the JA4
  specification's worked example and real bytes from Node's own TLS and HTTP/2 clients.
- `test/parity-server.test.ts`: the probe's server against Node's own clients: a TLS client that ends
  the handshake with alert 46 (a person's certificate warning), and `stop()` while a browser keeps its
  connections open. The TLS tests need openssl on `PATH` (skipped without it).
- `test/parity-files.test.ts`: the probe's files: developer mode and the probe extension in a
  profile's preference files on Linux and macOS, `summary.json` across a `--serve` run and a full
  run, and the note of `compare.ts` for a column from another run.
- `test/package.test.ts`: the dependency rule, the exports, an install under `node_modules`, no
  consumer paths, no CI workflow.
- `python/tests/test_adapter.py`: the adapter against the real CLI; the argv of each option; missing or
  old Node; bad output.
- `python/tests/test_tab_scope.py`: `tab_scope` and `any_scope` through the adapter, the argv, a
  `tab_scope` that is not a string, and the shape checks of the scope fields.
- `python/tests/test_parity.py`: fails when a CLI or library command has no Python method with the
  same parameters, or when a CLI option (from `agent-browser --help`) has no `AgentBrowser` argument.

There is no CI workflow; the tests run locally.

## Supply chain

The runtime dependencies are `ws` (8.21.0, the version vedlo vetted and ships), `ghost-cursor`
(1.4.2, the cursor paths of `record`; it brings `bezier-js` 6.1.4, `debug` 4.4.3, `ms` 2.1.3 and
`@types/bezier-js` 4.1.3), and the Playwright MCP of the service: `@playwright/mcp` 0.0.83 with the
`playwright` and `playwright-core` (1.64.0-alpha-1790635538000) that it names. All are pinned exactly in
`package.json` and `package-lock.json`, and `test/package.test.ts` fails on any other package.
ghost-cursor is loaded only when a recording runs; the Playwright MCP only in the service's MCP worker
of a scope, at its first MCP session, and it never launches or downloads a browser (it connects to the
agent door over CDP). See `docs/supply-chain/ghost-cursor-1.4.2.md` and
`docs/supply-chain/playwright-mcp-0.0.83.md` for their vetting. `ignore-scripts=true` stays on. The
Python adapter has no dependencies. Vet any new dependency the way vedlo's `docs/supply-chain.md` says;
prefer none.

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
| `src/chromes.ts` | `chromes`: every agent-browser Chrome of this user, from the process table |
| `src/front.ts` | `front`: bring the agent Chrome to the front by its pid (macOS) |
| `src/giveback.ts` | the give-back guard of a macOS start |
| `src/watchback.ts` | the give-back watcher of the Mac, for as long as the agent Chrome runs |
| `src/proxy.ts` | the multiplexing CDP proxy |
| `src/diagnostics.ts` | proxy attempt log, local status, notify hook |
| `src/allowlist.ts` | the allowlist: entry checks and host matching |
| `src/outline.ts` | `outline`, `redact`, `net` |
| `src/record.ts` | `record`: steps, keys, cursor paths, overlay, screencast, encoder |
| `src/options.ts` | consumer options and their checks |
| `src/lock.ts` | the lock file of the proxy start and of the tab record |
| `src/cdp.ts` | minimal CDP client on `ws` (Node's built-in WebSocket caps messages at 4 MB) |
| `src/service/` | `agent-browser service` (off by default): the control door, its admission, the agent door, stage 1a's ops and the fake (C12) |
| `index.js`, `loader.js`, `bin/agent-browser.js` | JavaScript entry points (see "Why there is a `loader.js`") |
| `python/agent_browser/` | the Python adapter |
