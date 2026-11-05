# Drive a page that is not in front, as a person does

Board task ab-v16.21, goal ab-v16. Measured on taylor (Linux) on 2026-11-04 and 2026-11-05 (UTC),
with Chromium 156.0.8078.79 in a private Xvfb. Nothing ran on the Mac: section 7 collects the Mac
facts of earlier reports. The script is [`test/live/anti-detect/`](../../test/live/anti-detect/)
(section 10), and its tables for the final runs are in [the appendix](#appendix-the-tables-of-the-final-runs).

The operator's goal: "Fully drivable browser for agents that isn't subject to automation blocks, so
agents can do whatever I ask them to do." The operator's answer to board item ab-bup (2026-11-04,
confirmed): "I want the proper solution for anti-detect. I'm not sure which." So this report does not
choose between agent-browser's two current modes. It measures what a site can see of each way to
drive a page that is not in front, against what the same site sees of a person, and recommends one
design.

## The answer

**Give every agent page a window of its own, and drive it as a person drives a window: Chrome draws
it as a normal window, the agent's input makes Chrome activate that window, and the input has a
person's shape. Never send focus emulation, and never drive a hidden page.**

In detail (section 8):

1. **One window per agent page.** agent-browser's `open` and the relay's `Target.createTarget` open a
   new window (`Target.createTarget` with `newWindow: true, background: true`; in the relay
   `chrome.windows.create({ focused: false })`), also for a Playwright client's `newPage`. Never a
   background tab.
2. **No focus emulation.** agent-browser stops sending `Emulation.setFocusEmulationEnabled` on
   attach, and the relay answers a client's `Emulation.setFocusEmulationEnabled` without sending it to
   Chrome. A page in its own window draws without it, so Playwright works: in `pw-window-filtered`
   every Playwright step passed, and its shot took 72 ms.
3. **Keep `--disable-backgrounding-occluded-windows`, also on taylor.** Without it a covered window is
   `hidden` on Linux too, and the agent's press reaches the hidden page before Chrome raises the
   window (`window-no-flag`).
4. **A person's input.** A curved pointer path of about 20 moves from the last pointer point, a press
   of about 70 ms with `force: 0.5`, and one key-event pair per character at a person's interval, in
   place of `Input.insertText`. In a window that Chrome has shown, CDP input of that shape matched the
   person's input in every field that the probe records (`window-human-cdp` against `person-window`).
5. **The window comes forward for input, on taylor only.** On Linux the agent's first press in a
   window makes Chrome activate that window, as a person's click does: the other window's page gets a
   `blur`. An explicit `Target.activateTarget` (in the relay `chrome.windows.update({ focused: true })`)
   before the input gives the same switch for keys and for the first press. Never on the Mac: there it
   takes the operator's focus.

With this design (the `window-human-cdp` and `pw-window-filtered` scenarios) the driven page was
`visible`, drew 60 frames a second and ran its 50 ms timer at full rate, got the focus only with the
agent's input while the other page got a `blur`, got no action while `hidden`, and two pages never
had the focus at the same time. Everything worked: reads, clicks, typing, a library session that
waits for content that only an animation frame writes, a lazy image, a shot (60 to 80 ms) and a
record.

Each other way leaves a signal that a person's page never shows (section 4):

- **Today's default** (focus emulation while a command is attached) makes a background tab
  `visible` for each command (12 ms to 1 s; 30 s for a shot of a new tab on main) while the front tab
  of the same window stays `visible` too. After a click the hidden page keeps `document.hasFocus()`
  true, and both pages report the focus at once (52 s in a 60 s run).
- **`--hidden-drive`** gives the page 36 actions (presses, clicks, keys, text changes) while it reports
  `hidden`, and the focus while `hidden`.
- **A tab switch for each input command** shows the front page a `blur` and a `hidden` for each
  command, and the driven tab is in front for 44 to 129 ms only.
- **Focus emulation for input only** still makes the tab `visible` beside the front tab, and leaves
  both pages focused.
- **Playwright** sends its own focus emulation (2 calls for 2 pages), so its background page is
  `visible` and focused for the whole connection (40 s), and a shot of it hangs. Without that
  emulation (`noDefaults: true`, or a relay that drops the call) its clicks in a background tab hang.

In every way where the page sits in a tab that Chrome never showed, CDP mouse events have
`screenX == clientX` and `screenY == clientY`. A person's events, and CDP events in a shown window,
have the window's content offset (87 or 143 px in `screenY - clientY`). This one comes from the tab,
not from the input.

The cost of the design is modest. agent-browser and the relay already have the new-window path
(personal mode's `open`, and the relay's `newWindow` branch). The input shape costs time: about
0.5 s for a click and about 0.1 s for each typed character. Section 8 lists the build steps and the
signals that stay.

## 1. What a site can see

A page can read these signals of its own tab, window and input. The probe records each one with a
timestamp (section 2):

| Signal | What a person's page shows |
| --- | --- |
| `document.visibilityState`, `visibilitychange` | `visible` in the front tab of a window that nothing covers; `hidden` in a background tab and in a covered window (Linux and macOS, plain Chrome) |
| `document.hasFocus()`, `focus`, `blur` | true only in the front tab of the active window: at most one page at a time; a `blur` in the old page when the person switches |
| `requestAnimationFrame` | 60 a second while `visible`; none while `hidden` |
| timers | a 50 ms `setInterval` ticks 20 times a second while `visible`, once a second while `hidden` |
| `IntersectionObserver`, `loading=lazy` | callbacks and loads come with frames, so they wait while `hidden` |
| input | only while `visible` and focused, except `pointerout` and `pointerleave` when a window covers it; a pointer path before each press, a press of 70 to 90 ms with `pressure` 0.5, `screenX - clientX` and `screenY - clientY` equal to the content's offset on the screen, one `keydown` per typed character |
| geometry | `outerWidth`, `outerHeight`, `screenX`, `screenY`, `screen.*`; a tab that loads before Chrome shows it reports `outerWidth` and `outerHeight` 0 until it is shown, for a person too |
| other tabs of the same site | each page's state, through `BroadcastChannel` or `localStorage`: a site with two tabs sees both pages' focus and visibility |

## 2. How it was measured

- **Where.** taylor (Debian 13), Chromium 156.0.8078.79 (`/usr/bin/chromium`), in a private Xvfb
  (display 121, 1600x1000, its own X authority file). Each scenario starts its own Chromium on a new
  profile in the run folder. No other Chrome was touched.
- **The pages.** Two probe pages of a local server (`probe.localhost`, no network): F, the page in
  front (the operator's tab, or the page of another agent), and T, the page that is driven. The page
  (`test/live/anti-detect/probe.ts`) sends each signal of section 1 to the server with
  `navigator.sendBeacon` and a `Date.now()` timestamp: `visibilitychange`, `focus`, `blur`,
  `pagehide`, `pageshow`, `freeze`, `resume` (each with `document.visibilityState` and
  `document.hasFocus()`); every `requestAnimationFrame` call; every tick of a 50 ms `setInterval`;
  each `IntersectionObserver` callback of a sentinel at the bottom of the page; the request of a
  `loading=lazy` image 6000 px down the page; every pointer, mouse, key, `beforeinput`, `input`,
  `wheel`, `focusin` and `focusout` event, with `isTrusted`, client and screen coordinates,
  `movementX/Y`, `pressure`, `buttons`, `key`, `code`, `inputType` and `navigator.userActivation`;
  the geometry at load and at each resize; and a `BroadcastChannel` message between the two pages at
  each change of state.
- **The transport.** Chromium runs with `--remote-debugging-pipe` (no debugging port). A small bridge
  in `run.ts` serves the pipe as a WebSocket on a Unix socket in the run folder. It detaches the
  sessions of a client when the client leaves, as agent-browser's proxy and the relay do, so focus
  emulation ends at the detach, as in production. agent-browser's own commands (`commands.text`,
  `click`, `type`, `press`, `shot`, `record`, and a library session with `Tab.clickAt` and
  `Tab.waitFor`) reach the bridge through `cdpUrl`, so they send the CDP calls that they send through
  the proxy or the relay. Playwright 1.64.1 connects to the same kind of bridge with `connectOverCDP`.
  The bridge counts every CDP method. In two scenarios it changes one call (section 6).
- **The person.** A person is xdotool: XTest input through the X server, as from a real mouse and
  keyboard: a curved path of 20 moves in about 300 ms, a press of 70 ms, typing at 90 ms a key. In the
  person scenarios no CDP message reaches Chromium. Xvfb has no window manager. Where a person's window
  manager raises and focuses a window that the person clicks, the script raises it and gives it the
  keyboard focus with xdotool (`windowraise`, `windowfocus`).
- **The drive.** Every agent scenario runs the same steps on T: 3 s idle; `text`; `click #b`;
  `type hello --into #f`; a library session (`Tab.clickAt` on a button whose click asks for a frame,
  then `Tab.waitFor` for the content that only that frame writes, 5 s limit); `press End` (the page
  scrolls to its bottom, to the lazy image and the sentinel); `shot`; `record` of 1 s; 3 s idle. After
  each step the script waits 1.6 s, so that the frames of the second after it are counted. A person's
  drive has the same steps where a person can do them: bring T to the front, click, type, click the
  frame button, End, send T back.
- **What the transport adds.** `--remote-debugging-pipe` sets `navigator.webdriver` to true in every
  page of these runs, also in the person scenarios. agent-browser's real transports do not: the proxy
  uses Chrome's own remote-debugging approval, and agent mode uses `chrome.debugger` through the
  extension, where the earlier report measured `navigator.webdriver` false
  ([`2026-11-03-chrome-vs-chrome-beta.md`](2026-11-03-chrome-vs-chrome-beta.md), section 3). Every
  other signal here comes from the CDP calls and the window state, not from the transport. The first
  window of each Chromium also gets an infobar after its load (56 px; Chromium's own, not Google
  Chrome's), so its `innerHeight` changes from 613 to 557.

## 3. A person: the baselines

No CDP message at all reached Chromium in these three scenarios.

| | idle | input | when the person switches |
| --- | --- | --- | --- |
| `person-front`: T is the front tab of the focused window | `visible`, 60 frames/s, 20 ticks/s, focus | 20 moves (all with movement), press 77 ms, `pressure` 0.5, `screenY - clientY` 143 (the window's top bar and the infobar), 5 `keydown` for 5 characters | — |
| `person-tab`: T is a background tab beside F | `hidden`, 0 frames/s, 1 tick/s, no focus | the same shape (offset 87: no infobar in that tab) | Ctrl+2: T `visible` and two `focus` events, F `blur` and `hidden`; Ctrl+1: the reverse |
| `person-window`: T's window is behind F's window | `hidden`, 0 frames/s, 1 tick/s, no focus | the same shape | the stand-in window manager raises and focuses T's window: F `hidden` and `blur`, T `visible` and `focus`; back: the reverse |

So on Linux, in plain Chromium, **a covered window is `hidden`**, as on the Mac. A person's page never
had a press, a key or a text change while it was `hidden`, and two pages never had the focus at the
same time. The only input that a `hidden` page of a person got was `pointerout` and `pointerleave`,
when a window covered it under the pointer.

## 4. The candidates

Each row is one scenario of `run.ts`. "A site sees" lists only what a person's page in the same
place (section 3) does not show. "Breaks" lists the steps of the drive that failed or waited. The
appendix has every value.

| Candidate (scenario) | A site sees, unlike a person | Breaks | Cost |
| --- | --- | --- | --- |
| **4a. Today's default** (`default`): focus emulation while a command is attached, T a background tab | T is `visible` for each command (text 14 ms, click 1021 ms, type 20 ms, library 1035 ms, End 12 ms, shot 30 s, record 2.9 s) while F stays `visible` in the same window: two visible tabs in one window. A `focus` for each command; after the first click T keeps the focus while `hidden`, and F and T both report the focus (52 s of 60 s). CDP mouse events with `screenX == clientX`, `screenY == clientY`. At load, T reports `outerHeight == innerHeight` (557) | a shot of the new background tab hangs until agent-browser's 30 s limit (main; PR #41 fixes it); the lazy image loads only at the next command (2.0 s after End) | none: today |
| **4b. `--hidden-drive`** (`hidden-drive`) | 36 actions while `hidden` (presses, clicks, keys, text changes); 2 `focus` events while `hidden` and the focus kept after them (F and T both focused 20 s); `record` makes T `visible` for 2.7 s; `screenX == clientX` | between commands the page draws nothing: rAF, `IntersectionObserver` and transitions wait (README) | none: today |
| **1. One window per page** (`window`), with `--disable-backgrounding-occluded-windows`, F's window over T's | T is `visible`, 60 frames/s and 20 ticks/s while covered (a person's covered window is `hidden`; a person's uncovered window that is not in front looks the same as this). The first press activates T's window: T `focus`, F `blur`, as for a person's click. The input's shape (section 5) | nothing: text 21 ms, click 62 ms, library 290 ms, lazy image 23 ms, shot 81 ms, record 3.1 s with no visibility change | one window per page |
| **1'. Without the flag** (`window-no-flag`) | covered, T is `hidden` (as a person's). The agent's press reaches the hidden page (14 actions while `hidden`), and then Chrome activates and raises the window, and T becomes `visible` | nothing | as 1 |
| **1''. With focus emulation on attach** (`window-default`) | as 1, plus a `focus` and a `blur` for a read (`text`) with no window switch | nothing | as 1 |
| **1+2. One window per page, `Target.activateTarget` on it for each input command, then on F's** (`window-activate`) | per input command F `blur` and `focus`, T `focus` and `blur`, as a person who clicks a window and clicks back; T is in front for 0.1 to 0.4 s each time. The input's shape | nothing (lazy image 120 ms) | on the Mac it takes the operator's focus |
| **2. Activate the tab for each input command, then go back** (`activate`) | per input command F `blur` and `hidden`, T `visible` and `focus`, then the reverse: 4 tab switches that F sees; T in front for 44 to 129 ms each time | nothing | the other tab of the window sees every switch: the operator's tab in personal mode, or another agent's page |
| **3. Focus emulation for input commands only** (`emulate-input`) | T `visible` during each input command (24 to 56 ms; 2.0 s for the library session) beside a `visible` F; focus kept after the first click (both focused 25 s); `screenX == clientX` | a shot takes 3.1 s (the hidden drive's capture) | small |
| **5a. Playwright as it is** (`pw-default`) | T is `visible` and focused for the whole connection while it is a background tab, beside a `visible`, focused F (both focused 40 s); after the disconnect T is `hidden`; `screenX == clientX`; a press of 0 ms | `page.screenshot` of the background tab hangs (8 s limit) | none: today's relay |
| **5b. Playwright without focus emulation** (`pw-no-defaults`: `connectOverCDP(url, { noDefaults: true })`; `pw-filtered`: the bridge answers the call itself) | T stays `hidden`; `fill` and `press` reach the hidden page (4 actions while `hidden`) | `page.click` hangs (8 s limit): Playwright waits for frames that a hidden page never draws; the lazy image loads 2 s late | unusable alone |
| **5+1. Playwright without focus emulation, every page in a window of its own** (`pw-window-filtered`) | as 1; the input's shape | nothing: click 105 ms, `waitForFunction` 100 ms, lazy image 7 ms, shot 72 ms | as 1, in the relay |
| **6a. One window per page, the X focus moved to it, CDP input** (`xfocus-cdp`) | as 1+2; the input's shape | nothing | Linux only |
| **6b. One window per page, the X focus moved to it, X input** (`xfocus-xinput`) | nothing that the probe records: the same events as `person-window` | nothing (no shot or record in this drive) | Linux only; one pointer for the whole display (a lock), the window must be raised and not covered at the point, and the agent must map page points to screen points |
| **6c. One window per page, `Target.activateTarget`, person-shaped CDP input** (`window-human-cdp`) | nothing that the probe records: the same input as `person-window` (20 moves with movement, press 75 ms, `pressure` 0.5, the right screen offset, 5 `keydown`) and the same window switch | nothing | a click takes about 0.5 s, 5 characters about 0.5 s |

What breaks in each, for the features the board task names:

- **rAF, IntersectionObserver, lazy load.** In a window of its own the page draws all the time, so
  these work as for a person. In a background tab they wait until a command makes the page draw (the
  default: during each command; the hidden drive: during input commands and shots only).
- **Shots.** In a window: 60 to 81 ms. In a background tab: the default mode on main hangs on a new
  tab (PR #41 fixes it: 0.1 to 3 s), the hidden drive takes about 0.1 s, focus emulation for input
  only about 3 s, Playwright hangs.
- **record.** It works in every candidate. It turns focus emulation on for its run (in a window that
  emulation changes only the focus), and after it the page keeps the focus with no `blur`. In a
  window the build can leave it out (section 8).
- **`Tab.clickAt` and library sessions.** `Tab.waitFor` for content that only a frame writes worked
  in every agent-browser candidate. In a background tab it worked only because the click or the
  emulation made the page draw at that time. In a window it works with no such help.

## 5. Input: what CDP input shows, and what it can match

Measured at the click of each scenario (appendix, third table):

| | moves before the press (with movement) | `screen - client` at the press | `pressure` | press | keys for "hello" |
| --- | --- | --- | --- | --- | --- |
| a person (`person-*`, `xfocus-xinput`) | 20 (19 or 20) | the content's offset: [0,87] or [0,143] | 0.5 | 77 to 79 ms | 5 `keydown`, 5 `keypress`, 5 `keyup`, `inputType` `insertText` |
| agent-browser today, in a tab that Chrome never showed | 1 (0) | [0,0] | 0 | 3 to 5 ms | none: `Input.insertText` gives one `beforeinput` and one `input` only |
| agent-browser today, in a shown window | 2 (1) | [0,87] | 0 | 3 to 12 ms | none |
| Playwright 1.64.1 | 1 or 2 | [0,0] in a tab, [0,87] in a window | 0.5 | 0 to 3 ms | none (`fill` uses `Input.insertText`) |
| person-shaped CDP input (`window-human-cdp`) | 20 (20) | [0,87] | 0.5 | 75 ms | 5 of each, as a person |

So CDP input can match every input field that a page reads, with two conditions: the page is in a
window that Chrome has shown (else `screenX == clientX`), and the agent sends the person's shape. A
press with no move before it, a press of a few milliseconds, `pressure` 0 and text with no key events
are what agent-browser sends today. The repo already has the parts: ghost-cursor's path (used by
`record`), `typeChar` (key events per character), and `force: 0.5` (the earlier report's advice).

## 6. Playwright behind the relay (candidate 5)

- Playwright 1.64.1 sends `Emulation.setFocusEmulationEnabled { enabled: true }` once for each page's
  main frame (2 calls for 2 pages here; the probe log of the relay counted 39). It skips the call only
  with `connectOverCDP(url, { noDefaults: true })`. Playwright's own MCP server connects with
  `noDefaults: true`.
- Playwright needs frames: its click waits for the element to be stable over animation frames, and
  `waitForFunction` polls on frames. In a background tab without focus emulation the click hangs
  (`pw-no-defaults`, `pw-filtered`).
- With its own emulation the background page is `visible` and focused for the whole connection, and
  `page.screenshot` of it hangs (`pw-default`), for the cause that PR #41 found: Chrome ends a capture
  only when its frame is shown, and a background tab's frame never is.
- So the relay must not choose between "allow" and "refuse" alone. **Answer the call without sending
  it, and open every page in a window of its own** (`pw-window-filtered`): every Playwright step
  passed, with no visibility signal. A client that sends `noDefaults: true` gets the same.
- Popups that a page opens with `target=_blank` or `window.open` come as tabs in the opener's window
  (not measured here). Then the opener is a background tab. The relay can move such a tab into its own
  window (`chrome.windows.create({ tabId })`), or drive the opener only after a tab switch
  (candidate 2). This needs a measurement in the build.

## 7. macOS

Nothing ran on the Mac for this report. These facts come from the earlier Mac checks
([`2026-11-03-chrome-vs-chrome-beta.md`](2026-11-03-chrome-vs-chrome-beta.md), section 8, check 9)
and from the README's measured rows:

- **A window behind the operator's windows.** With `--disable-backgrounding-occluded-windows` (in
  `AGENT_ARGS`), an agent window behind the operator's full-size Chrome window stayed `visible`, drew
  121 frames in 2 s and ran a 10 ms timer 200 times in 2 s. Without the flag the page was `hidden`
  (0 frames, 24 ticks), and CDP clicks and typing still reached it. Linux shows the same (section 4,
  `window-no-flag`).
- **Focus.** `document.hasFocus()` was false while idle and true after CDP input, and the front app
  stayed the operator's Chrome during that input. So on the Mac CDP input gives the page the focus
  without bringing the agent's app to the front. A site sees a focused page, not the app that is in
  front. Not measured on the Mac: whether another agent window then gets a `blur`, as on Linux.
- **The start takes the front, then gives it back.** Chrome activates itself when it shows its first
  window: with `open -n -g` alone, 12 of 12 starts took the front. agent-browser's give-back
  (`src/giveback.ts`) asks macOS to activate the operator's app again; with the same call from a
  helper, the operator's app was back after 36, 43 and 83 ms.
- **A new window opens behind the operator's windows.** In personal mode agent-browser already opens
  a window of its own behind the operator's windows, and that window "renders normally without
  stealing focus" (`src/browser.ts`, `open`). The agent-mode path (`Target.createTarget` with
  `newWindow`, or the relay's `chrome.windows.create({ focused: false })`) is not measured on the
  Mac.
- **What the Mac forbids.** The operator shares the screen, the pointer and the keyboard. So on the
  Mac the agent never activates its windows (`Target.activateTarget` and
  `chrome.windows.update({ focused: true })` bring the agent's app to the front), and it never sends
  OS-level input (that moves the operator's pointer). Step 5 of the design, `window-activate`, `xfocus-*`
  and `activate` through Chrome's own CDP are for taylor only. On the Mac the design is steps 1 to 4:
  a window of its own behind the operator's windows, the flag, no focus emulation, and person-shaped
  CDP input. The page then gets the focus at the agent's first press, with no visible change of the
  app in front.

## 8. The recommended design, and its remaining signals

**The build** (a follow-up task; nothing here is built):

1. agent-browser `open` in agent mode: `Target.createTarget` with `newWindow: true` and
   `background: true` (`src/browser.ts`). `open --tab` stays for a caller that asks for a tab, and
   keeps `Tab.whileDrawn`.
2. agent-browser `attach`: no `Emulation.setFocusEmulationEnabled` for a page in a window of its own.
   `record` needs no focus emulation there either. The default mode and `--hidden-drive` stay for a
   tab (`open --tab`, and a tab that a site opened), until the popup rule of item 4 covers them.
3. The relay (`src/relay/model.ts`): every `Target.createTarget` opens a window
   (`chrome.windows.create({ focused: false })`); `Emulation.setFocusEmulationEnabled` is answered
   with `{}` and never reaches Chrome (`src/relay/policy.ts`). A test with the probe's Playwright
   cases in agent mode (`test/live/agent-mode/`).
4. Popups: measure `target=_blank` and `window.open` in agent mode, then move a popup tab into a
   window of its own, or switch tabs for it.
5. Input shape (`Tab.click`, `clickText`, `clickAt`, `hover`, `type`, `press`): a pointer path from
   the last pointer point (ghost-cursor, as `record` uses), a press of 50 to 120 ms with `force: 0.5`,
   and key events per character (`typeChar`) at 60 to 150 ms in place of `Input.insertText`. For a
   Playwright client the relay can shape the same input: moves before a `mousePressed`, a held
   `mouseReleased`, key events for `Input.insertText`. That is a second step, after a measurement of
   its latency for Playwright's own timeouts.
6. On taylor, before an input command in a window that is not active: activate it
   (`Target.activateTarget`, or `chrome.windows.update({ focused: true })` in the relay), as the
   person's click does. Never on the Mac.
7. Keep `--disable-backgrounding-occluded-windows`. The agent-mode unit on taylor today passes none
   of the three old flags (the two-modes design, section 7): it needs this one.
8. The fake Chrome (`test/fake-chrome.ts`) models a window that is not in front: `visible`, drawing,
   focus at the first press.

**What a site can still see** with this design:

- **Pace and patterns.** The agent acts fast and with no idle pointer movement between commands. The
  probe records no behaviour model, so this is not measured.
- **A covered window that draws.** With the flag, an agent window under another window draws at 60
  frames a second. A person's covered window is `hidden`. A site cannot tell a covered window from an
  uncovered one, so it sees a window that is not in front, as on a second screen. On taylor the
  windows can also be placed side by side in a larger Xvfb screen, so that no window covers another.
- **Window geometry.** On taylor's Xvfb, with no window manager, every new window opens at the same
  place and size (0,0 and 1100x700 here), with no window-manager frame. A person's windows differ. The
  earlier report found that a Linux box cannot look like the operator's Mac (its section 2.2).
- **`history.length` 2** for a page that agent-browser opens at `about:blank` and then navigates
  (`open`, and the relay's hold of contract C10), where a person's new page has 1. Known since board
  task ab-v16.6.
- **On the Mac only:** the agent page gets the focus without its app coming to the front.
- **record** keeps the page's focus after its run, with no `blur` (it enables focus emulation; item 2
  removes it in a window).
- **The page of a site's popup** (item 4), until the build measures it.
- Signals outside this report: the identity and machine of the earlier report, `outline`'s
  `data-agent-browser-idx` attribute, and a site's own behaviour checks.

## 9. What this did not measure

- Anything on the Mac (section 7).
- Google Chrome: only Chromium 156 ran. The window, focus and input code is the same, but Chrome
  stable was not run.
- agent mode's real transport: the relay with the extension's `chrome.debugger`. The probe drove
  Chromium through a pipe; the relay's own changes (a window for each `createTarget`, the dropped
  call) ran as a bridge rule, not in `src/relay/`.
- A real window manager: Xvfb on taylor has none. A window manager can place, frame and focus windows
  in its own way.
- Page freezing and intensive timer throttling of a tab that is hidden for more than 5 minutes.
  The runs keep T hidden for at most about 60 s. No `freeze`, `resume` or `pagehide` came in any run.
- Popups (`target=_blank`, `window.open`) in each design.
- Behaviour checks of real anti-bot services. The probe records the signals that a page can read; it
  does not run a vendor's script.
- Typing and pointer shapes of a person other than xdotool's, and the input shape inside the relay.

## 10. Reproduce

On a Linux box with Xvfb, xdotool and Chromium (and ffmpeg for `record`):

```sh
npm ci
mkdir -p /tmp/pw && (cd /tmp/pw && npm init -y >/dev/null && npm install --ignore-scripts playwright-core@1.64.1)
node test/live/anti-detect/run.ts --out-dir /tmp/anti-detect --playwright /tmp/pw [--display 121] [--only default,window]
node test/live/anti-detect/report.ts /tmp/anti-detect/run-*/results.json
```

`run.ts` prints the three tables of the appendix for its run, writes every record and every step to
`results.json` and `steps.md` in its run folder, and exits 0 when every scenario ran (a failed step is
a measurement, not a failure of the script). It ends only its own children, and it never connects to
a Chrome that it did not start. It is not part of `npm test`. The final runs took about 11 minutes
each.

## Appendix: the tables of the final runs

APPENDIX
