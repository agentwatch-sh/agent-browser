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
| Never launch Chrome with `--remote-debugging-port`. That flag sets `navigator.webdriver`, and Cloudflare, hCaptcha and Google then block every page. The operator turns remote debugging on in `chrome://inspect/#remote-debugging` and approves once for each proxy. | `assertSafeChromeArgs` in `src/agent.ts` refuses every `--remote-debugging-*` switch and `--enable-automation` before any spawn, in every dash, slash and case form. | `test/agent.test.ts`, `test/cli.test.ts`, `test/package.test.ts` |
| The agent Chrome always runs with a window and on its own profile. `--headless` lets every page tell that the browser is headless. A caller's flags come after agent-browser's own `--user-data-dir`, so a `--user-data-dir` or `--profile-directory` among them would point the agent Chrome at another profile, for example the operator's. | `assertSafeChromeArgs` also refuses `--headless` in every form (`--headless=new`, `--headless=old`, ...), `--user-data-dir` and `--profile-directory`, in `chromeArgs`, `--chrome-args` and a library caller's launch flags, before any spawn. | `test/agent.test.ts`, `test/cli.test.ts` |
| Every connection goes through the local proxy socket. | `AgentBrowser.connect` connects only to the proxy socket (`src/proxy.ts`); there is no direct mode. | `test/browser.test.ts` ("one upstream connection"), `test/proxy.test.ts` |
| Only allowlisted hosts can be opened, attached, read or clicked. An agent never widens the list. | `src/allowlist.ts`; every `Tab` action re-reads the live URL first (`assertAllowed`). A `fetch` or `download` URL must be allowlisted too (it carries the profile's cookies). A redirect off the list is refused by host, and `net` stops recording when the tab leaves the list. The package reads the allowlist file and never writes it. No command or flag adds a host. The operator's list alone decides: there is no built-in denylist, so an entry may name a mail, account or admin host, and a broad entry such as `google.com` covers all its subdomains, `mail.google.com` included. | `test/allowlist.test.ts`, `test/browser.test.ts`, `test/cli.test.ts` (the file is unchanged, and an off-list tab gets no CDP call) |
| Never drive the operator's own Chrome unless asked. In that mode, use one pinned window and keep off mail, banking and admin tabs. | Personal mode needs `mode: "personal"`. It acts only in a pinned window, and its first `open` makes and pins a window of its own. `launch` and `quit` refuse personal mode. | `test/browser.test.ts`, `test/cli.test.ts`, Python `test_personal_mode_needs_its_own_pinned_window` |
| Read pages with `outline` or `text` before screenshots. | `shot` refuses (`read_first`) until `outline` or `text` has read that tab at its current URL. `record` is not under this rule: it makes a video for people, not a page read for an agent. | `test/cli.test.ts`, Python `test_a_full_session_returns_typed_results` |
| Never take the operator's focus, Space, pointer or clipboard: the operator shares the machine. | `open` makes background tabs (a foreground tab activated Chrome); `record` sends no `Page.bringToFront`; a Chrome start uses `open -n -g` on macOS (except `launch --login`, where the operator signs in); input is CDP input inside the tab, which never moves the real pointer; `record` refuses copy, cut and paste chords. | `test/record.test.ts`, `test/agent.test.ts`, `test/cli.test.ts`; live: `test/live/takeover/` (measured 2026-10-30: no command changed the frontmost app or moved the pointer) |
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
| State folder | `stateDir` | `--state-dir` | `state_dir` | **Required**, absolute. It holds `tabs.json`, `window.json`, `reads.json`, `chrome-proxy.json`, `chrome-proxy.log`, `launches.log`, `shots/` and `recordings/` (the frames of a recording in progress, removed after each run). Created with mode 0700. One folder for each consumer. |
| Allowlist | `allowlistFile` (or `allow`) | `--allowlist` | `allowlist` | **Required** for every command that touches tabs. JSON: `{"allow": ["suno.com", "midjourney.com"]}`. A host matches itself and its subdomains. Entries are lowercase host names with a dot (or `localhost`). The list alone decides: no built-in list refuses a host. |
| Profile | `profileDir` | `--profile` | `profile` | Default `<stateDir>/profile`. Its cookies are this consumer's logins. |
| Proxy socket | `socketPath` | `--socket` | `socket` | Default `<stateDir>/chrome-proxy.sock`, mode 0600, at most 103 bytes. |
| Notify hook | `notify` (callback or `{ command }`) | `--notify-command '["prog","arg","{message}"]'` | `notify_command=["prog", ...]` | Used only by `status --notify`. An argv list, never a shell string. The message goes on stdin, and `{message}` in an argument is replaced with it. Example for agentwatch: `["agentwatch", "session", "inbox", "--text", "{message}"]`. |
| Approve dialog | `approve` (`true`/`"osascript"`/`"xdotool"`/`{ command }`) | `--approve auto\|osascript\|xdotool` or `--approve-command '[...]'` | `approve=True` / `approve="xdotool"` / `approve_command=[...]` | Unattended only. Answers Chrome's per-connection "Allow remote debugging?" dialog once per proxy. Default off (the operator clicks). See **Unattended approval**. |
| Node | | | `node` (default `node` on PATH) | Node 26 or later. |
| Package folder | | | `package_dir` | The agent-browser folder with `bin/agent-browser.js`. Default: the checkout that holds the adapter. |

Optional: `mode` (`agent` by default, or `personal`), `chromeBin` (default Google Chrome Beta when it
is installed, else Google Chrome), `chromeArgs` (extra Chrome flags at launch, e.g.
`["--enable-unsafe-swiftshader", "--lang=en-US"]`; `--remote-debugging-*`, `--enable-automation`,
`--headless`, `--user-data-dir` and `--profile-directory` are refused before any spawn, in every dash,
slash and case form; only the switch name is checked, never its value, so `--user-agent=...` passes; the
profile comes from `profileDir`; no secrets belong here because Chrome flags show in `ps`), `endpoint` (a known `ws://` endpoint, still
used through the proxy), `personalUserDataDir`, `noLaunch` (fail with the launch command instead of starting Chrome), `noPrompt` (never open a new
connection, so never a new approval prompt: with no approved proxy up, fail at once with `approval_needed`),
`proxyIdleMs` (default 12 hours), `commandName` (how hints name the command line, for example
`vedlo browser`) and `log` (progress lines; default standard error).

## How it works

- **The agent browser** is a regular Chrome on the consumer's profile. Any command that needs Chrome
  starts it if it is not running (`noLaunch` turns that off). On macOS that start goes through
  `open -n -g`, so Chrome does not take the operator's focus; `launch --login` starts it in front,
  because the operator signs in there. Tip: only agent browsers use Chrome Beta, so assigning Google
  Chrome Beta to a desktop of its own (Dock, Options, Assign To) keeps every agent browser there. This is an agent browser, so it comes up
  ready: before it starts Chrome, `launch` writes `devtools.remote_debugging.user-enabled: true` into
  the profile's `Local State` (`seedRemoteDebugging`), so remote debugging is on without a
  `chrome://inspect` click. That setting is a plain, unsigned value (not the HMAC-signed "Secure
  Preferences"), so Chrome keeps it; `launch` merges it in and never overwrites other keys or a corrupt
  file. The launch still opens `chrome://inspect/#remote-debugging` as a visible fallback. `launch`
  waits up to 10 minutes for the endpoint; other commands wait 30 s.
- **The approval prompt still applies.** Seeding removes the toggle click, not Chrome's own per-connection
  approval dialog. On first connect Chrome asks the operator to allow it, once per proxy (below). On a
  headless server with no one to click, set the `approve` option so agent-browser answers that one dialog
  itself (see **Unattended approval**); do not fall back to `--remote-debugging-port`, which sets `navigator.webdriver`.
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
    and which browser asks (pid and profile).
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
  always among allowlisted tabs only.
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
| `{"press": key, "repeat": n, "delay": ms}` | a key or a chord: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, the arrows, `Home`, `End`, `PageUp`, `PageDown`, `F2`, one character, or chords such as `Shift+ArrowDown`, `Meta+A`, `Meta+C`, `Control+Home`. `delay` (default 150) follows each press. |
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
  `--seed` (default 1): a retake with the same seed and steps moves the same way.
- **The overlay** (cursor, ripple, ring, repaint pixel) is built with DOM calls only (`createElement`,
  `setAttribute`, `element.style`, `element.animate`) inside a closed shadow root, in agent-browser's
  isolated world, and removed afterwards. Google Sheets enforces Trusted Types and a strict style-src,
  which refuse `innerHTML` and a `<style>` element. `--no-cursor` hides the cursor and the ripple; a
  `highlight` step still draws its ring.
- **The window.** `record` never raises a window or switches the operator's Space: it sends no
  `Page.bringToFront`, which activates Chrome. The agent browser can stay minimized, hidden (Cmd-H),
  covered or on another Space during a take (see **Measured**). Only a Chrome start, its one
  "Allow remote debugging?" prompt and a sign-in (`launch --login`) need the window. Start the agent
  browser, click Allow, then hide it: takes run in the background.
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

### Measured (2026-10-30, macOS, Chrome Beta, the public Sheets sample)

| Window state of the agent browser | Frames (agent flags) | Frames (no flags) |
| --- | --- | --- |
| In front | 54 fps | 56 fps |
| Background tab in its window | 57 fps | 28 fps, gaps of 0.63 s |
| The same tab after `Page.bringToFront` | 59 fps | 59 fps |
| Covered by another window | 60 fps | 47 fps, gaps of 0.23 s |
| Minimized | 60 fps | 55 fps |
| App hidden (Cmd-H) | 60 fps | 60 fps |

"Agent flags" are the agent browser's own launch flags (`--disable-backgrounding-occluded-windows`,
`--disable-renderer-backgrounding`, `--disable-background-timer-throttling`), which `launch` always
sets: no `--chrome-args` are needed. The screencast itself keeps a minimized or hidden tab painting.
So the operator can work in another window during a recording, and `record` does not bring the
tab forward (`Page.bringToFront` would activate Chrome and switch the operator's Space). A recording at 1920x1080 and
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
`status(o, { notify })`, `connect(o, { endpoint })`, `stop(o)`, `window(o, { pin, unpin })`,
`tabs(o)`, `open(o, { url, name, tab })`, `goto(o, { tab, url })`, `outline(o, { tab, all })`,
`click(o, { tab, target, text })`, `hover(o, { tab, target })`, `type(o, { tab, text, into })`,
`press(o, { tab, key })`, `text(o, { tab, selector })`, `eval(o, { tab, expression })`,
`shot(o, { tab, path, full, size, scale })`, `fetch(o, { tab, url, path })`, `download(o, { tab, url, path })`,
`close(o, { tab })`, `net(o, { tab, seconds, match, max }, { onEntry })`,
`record(o, { tab, out, script, setup, size, fps, scale, noCursor, settle, seed, ffmpeg })`, `commands()`.
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
`press(key)`, `setFiles(selector, paths)`, `text(selector?)`, `screenshot(path, { fullPage, viewport })`,
`fetchToFile(url, path)`, `download(url, path)`, `expectDownload(action, dir)` (a download that a
click starts), `expectResponse(match, action)` (capture an API response body; a CORS preflight's
response is never it), `watchResponses(match)`, `interceptRequest(urlPattern, transform, action)`
(rewrite a request body in flight; a CORS preflight is continued untouched), `close()`.
`Tab.screenshot` is the low-level primitive; the read-first rule is in `commands.shot` and the CLI.

**Lower level:** `launchAgentChrome`, `agentEndpoint`, `agentChromePid`, `agentChromeBin`,
`findAgentPid`, `parsePs`, `processTree` (a Chrome's process tree, for example to record its audio),
`restoresOnStartup`, `startProxy`, `stopProxy`, `proxyInfo`, `browserTarget`, `localBrowserStatus`,
`notifyBrowserStatus`, `outline`, `redact`, `netLog`, `isAllowedUrl`, `recordTab`,
`planRecording`, `parseSteps`, `parseKey`, `parseSize`, `planMove`, `pointAt`, `fittsMs`, `seededRandom`,
`findFfmpeg`, `runCleanup`, `withCleanupErrors`,
`loadAllowlist`, `resolveOptions`, `CDPConnection`, `main` (the CLI in-process). Errors:
`AgentBrowserError` (with a stable `code`) and `UsageError`, `NotAllowedError`, `PinRequiredError`,
`ReadFirstError`, `TabNotFoundError`, `ChromeUnreachableError`, `ApprovalNeededError`.

## CLI

```
agent-browser <command> [args] --state-dir DIR --allowlist FILE [--json]
              [--profile DIR] [--socket PATH] [--mode agent|personal] [--chrome-bin PATH]
              [--chrome-args JSON] [--endpoint WS] [--personal-user-data-dir DIR] [--no-launch] [--no-prompt]
              [--notify-command JSON] [--approve auto|osascript|xdotool] [--approve-command JSON]
              [--proxy-idle-ms N] [--command-name NAME]
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
`unreachable`, `approval_needed` (`--no-prompt` and no approved proxy), `error` (exit 1).

Two messages name their cause and fix. When `open` or `goto` lands on another host (a redirect), the
`not_allowed` message names both hosts and says that the tab stays open there; for a sign-in page
(`accounts.google.com` and similar) it says to run `launch --login` and sign in by hand. When Chrome
answers the connection with `403 Connection rejected` at once and shows no prompt, this Chrome run
holds an earlier refusal (a cancelled, closed or unanswered prompt): the `unreachable` message says to
`quit` and `launch` the agent browser again and click Allow, and the proxy log records the approval
as "refused".

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
| `type <tab> (<text> \| --stdin) [--into S]` | `tab`, `into` string\|null, `length` int (never the text). Into an input or a textarea it types inserted text, and key events when the field ignores that. Into an editable element (an app's own editor, such as the Google Sheets cell editor) it types one key event per character at once: inserted text can reach that DOM and never reach the app. When no text field has the focus, or the field's text did not change, it fails instead of reporting success. A tab or a newline in the text is a Tab or an Enter key: only the text before the first one is checked, so `type sheet $'a\tb\tc\n'` fills a row of cells in a spreadsheet without the clipboard. |
| `press <tab> <key>` | `tab`, `key` (Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, F2) |
| `text <tab> [selector\|#N]` | `tab`, `selector` string\|null, `text` |
| `eval <tab> (<js> \| --stdin)` | `tab`, `value` (the JSON value; `undefined` becomes `null`) |
| `shot <tab> [path] [--full] [--size WxH] [--scale N]` | `tab`, `path`, `fullPage` bool. Refused with `read_first` until `outline` or `text` read the tab at its current URL. Default path `<state-dir>/shots/<time>.png`. `--size`/`--scale` lay the page out at exactly that size for the shot only (the PNG is W x N by H x N pixels); a failure to restore the tab is an error that names the saved file. |
| `fetch <tab> <url> <path>` | `tab`, `url`, `path`, `bytes` int, `contentType` |
| `download <tab> <url> <path>` | `tab`, `url`, `path`, `bytes` int, `status` int |
| `close <tab>` | `tab` |
| `net <tab> [--seconds N] [--match S] [--max N]` | `tab`, `seconds` (at most 3600), `entries`: `{kind: "http", method, url, body, status, mime, resp}` or `{kind: "ws", direction: "recv"\|"sent", data}` (redacted, clipped at `--max`, never headers; nothing after the tab leaves the allowlist) |
| `record <tab> --out clip.mp4 [--script S] [--setup S] [--size WxH] [--fps N] [--scale N] [--no-cursor] [--settle MS] [--seed N] [--ffmpeg PATH]` | `tab`, `path`, `provenance` (the JSON beside the MP4), `width`, `height`, `scale`, `fps`, `videoWidth`, `videoHeight`, `frames` (screencast frames kept), `seconds`, `maxFrameGapMs`, `steps` int, `events` (see **Recording**), `warnings` string[] |
| `commands` | `commands`: the command list (`name`, `summary`, `usage`, `params`) |

`fetch` and `download` act through an allowlisted tab and send the profile's cookies, so their URL
must be allowlisted too. A media CDN on another host (for example Suno's `cdn1.suno.ai`) needs its
own entry in the consumer's allowlist file. `fetch` follows the page's same-origin and CORS rules;
`download` uses Chrome's network stack.

## Python adapter (`python/agent_browser`)

Python 3.10+, standard library only, full type annotations (`mypy --strict` is clean), `py.typed`.

```python
AgentBrowser(state_dir, allowlist=None, *, profile=None, socket=None, mode="agent", chrome_bin=None,
             endpoint=None, personal_user_data_dir=None, no_launch=False, no_prompt=False, notify_command=None,
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
| `shot(tab, path=None, full=False, size=None, scale=None)` | `ShotResult(tab, path, full_page)` |
| `fetch(tab, url, path)` | `FetchResult(tab, url, path, bytes, content_type)` |
| `download(tab, url, path)` | `DownloadResult(tab, url, path, bytes, status)` |
| `close(tab)` | `CloseResult(tab)` |
| `net(tab, seconds=None, match=None, max=None)` | `NetResult(tab, seconds, entries: list[NetHttp \| NetWs])` |
| `record(tab, out, script=None, setup=None, size=None, fps=None, scale=None, no_cursor=False, settle=None, seed=None, ffmpeg=None)` | `RecordResult(tab, path, provenance, width, height, scale, fps, video_width, video_height, frames, seconds, max_frame_gap_ms, steps, events: list[RecordEvent(step, kind, start, end, press, keys, first, last)], warnings)` |
| `commands()` | `CommandsResult(commands: list[CommandSpec])` |

`TabRef(id, target_id, name, url, title)`. `node_version()` returns the node version as a tuple.

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
- `test/cli.test.ts`: the JSON contract of every command, and the safety rules through the CLI.
- `test/record.test.ts`: `record` and `shot --size` through the CLI. The fake screencasts real JPEG
  frames and, like Google Sheets, refuses `innerHTML`, `<style>` and inline style attributes. The tests
  that encode need ffmpeg and ffprobe on `PATH` (skipped without them).
- `test/live/takeover/` (macOS; see the head of `check.ts`): drives one `about:blank` tab of a running
  agent browser while a monitor logs the frontmost app and the pointer, then names any command that
  changed either. Not part of `npm test`.
- `test/live/sheets.ts` (`npm run test:live -- --state-dir DIR --allowlist FILE`): not part of
  `npm test`, because it contacts Google. It records the public Sheets sample in a running agent browser
  (an allowlist with `docs.google.com`) and checks the MP4, the events, `shot` sizes and that the tab
  is restored.
- `test/package.test.ts`: the dependency rule, the exports, an install under `node_modules`, no
  consumer paths, no CI workflow.
- `python/tests/test_adapter.py`: the adapter against the real CLI; missing or old Node; bad output.
- `python/tests/test_parity.py`: fails when a CLI or library command has no Python method with the
  same parameters.

There is no CI workflow; the tests run locally.

## Supply chain

The runtime dependencies are `ws` (8.21.0, the version vedlo vetted and ships) and `ghost-cursor`
(1.4.2, the cursor paths of `record`; it brings `bezier-js` 6.1.4, `debug` 4.4.3, `ms` 2.1.3 and
`@types/bezier-js` 4.1.3). All are pinned exactly in `package.json` and `package-lock.json`, and
`test/package.test.ts` fails on any other package. ghost-cursor is loaded only when a recording runs.
See `docs/supply-chain/ghost-cursor-1.4.2.md` for its vetting. `ignore-scripts=true` stays on. The
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
| `src/proxy.ts` | the multiplexing CDP proxy |
| `src/diagnostics.ts` | proxy attempt log, local status, notify hook |
| `src/allowlist.ts` | the allowlist: entry checks and host matching |
| `src/outline.ts` | `outline`, `redact`, `net` |
| `src/record.ts` | `record`: steps, keys, cursor paths, overlay, screencast, encoder |
| `src/options.ts` | consumer options and their checks |
| `src/cdp.ts` | minimal CDP client on `ws` (Node's built-in WebSocket caps messages at 4 MB) |
| `index.js`, `loader.js`, `bin/agent-browser.js` | JavaScript entry points (see "Why there is a `loader.js`") |
| `python/agent_browser/` | the Python adapter |
