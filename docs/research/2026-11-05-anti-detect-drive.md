# Drive a page that is not in front, as a person does

Board task ab-v16.21, goal ab-v16. Measured on taylor (Linux) on 2026-11-04 and 2026-11-05 (UTC),
with Chromium 156.0.8078.79 in a private Xvfb. Nothing ran on the Mac for this report: section 7
collects the Mac facts of earlier reports and, at its end, the later Mac check of 2026-11-05 (board
task ab-v16.44). The script is [`test/live/anti-detect/`](../../test/live/anti-detect/)
(section 10), and its tables for the final runs are in [the appendix](#appendix-the-tables-of-the-final-runs).

The operator's goal: "Fully drivable browser for agents that isn't subject to automation blocks, so
agents can do whatever I ask them to do." The operator's answer to board item ab-bup (2026-11-04,
confirmed): "I want the proper solution for anti-detect. I'm not sure which." So this report does not
choose between agent-browser's two current modes. It measures what a site can see of each way to
drive a page that is not in front, against what the same site sees of a person, and recommends one
design.

## The answer

**Give every agent page a window of its own, and drive it as a person drives a window: Chrome draws
it as a normal window, the agent activates that window for its input, one input at a time, and the
input has a person's shape. Never send focus emulation, and never drive a hidden page, except in a
tab that a caller asks for with an explicit `open --tab` (section 8, step 2). Build it for taylor
first. The Mac part waits for the Mac build (board task ab-v16.27); the Mac check of 2026-11-05 is
at the end of section 7.**

In detail (section 8):

1. **One window per agent page.** agent-browser's `open` and the relay's `Target.createTarget` open a
   new window (`Target.createTarget` with `newWindow: true, background: true`; in the relay
   `chrome.windows.create({ focused: false })`), also for a Playwright client's `newPage`. Never a
   background tab, except for an explicit `open --tab` (step 2). A popup that a site opens as a tab is driven in that tab, and the agent goes back
   to the opener with a tab switch, as a person does (section 6).
2. **No focus emulation.** agent-browser stops sending `Emulation.setFocusEmulationEnabled` on
   attach, and the relay answers a client's `Emulation.setFocusEmulationEnabled` without sending it to
   Chrome. A page in its own window draws without it, so Playwright works: in `pw-window-filtered`
   every Playwright step passed, and its shot took 60 to 68 ms. The exception: a tab from an explicit
   `open --tab` keeps today's default mode or `--hidden-drive`, with a README warning (section 8).
3. **Keep `--disable-backgrounding-occluded-windows`, also on taylor.** Without it a covered window is
   `hidden` on Linux too, and the agent's press reaches the hidden page before Chrome raises the
   window (`window-no-flag`).
4. **A person's input.** A curved pointer path of about 20 moves that starts at the real pointer's
   position at each activation, a press of 70 to 90 ms with `force: 0.5`, one key-event pair per
   character 90 to 150 ms apart in place of `Input.insertText`, a click on a field in place of
   `el.focus()` (one that leaves the caret where `type --into` puts it today), and wheel events in
   place of `scrollIntoView`. The X pointer at the next activation needs one of two ways, and neither
   is measured (section 5): move the X pointer to the end of each CDP path, or start each path at the
   X pointer and never move the X pointer. The build's live test decides. In a window that Chrome has shown, CDP input of that shape matched the person's input
   in every input field that the probe records (`window-human-cdp` against `person-window`), once its
   path started at the real pointer (section 5).
5. **The window comes forward for input, on taylor only.** On Linux the agent's press in a window
   makes Chrome activate and raise that window, as a person's click does: the other window's page gets
   a `blur`. Keys do not: typing into a window after another window took the focus gave the page the
   focus with no switch, and both pages had the focus for 8.6 s (`window-keys-inactive`). So the agent
   activates the window before its input (`Target.activateTarget`; the relay needs a new path for it,
   section 6), as `window-activate` and `window-human-cdp` do.
6. **One input at a time in each agent browser.** Two agents that each activate their own window and
   type at the same time give two focused pages: for 9.6 to 12.4 s of 12.5 to 14.8 s (`extra.ts
   --exp two`; three runs of the reviews of PR #43 and two more). With one lock around each activation
   and its input command, 0 to 0.3 s (at most three samples at a switch), and the work took 28 to 55 %
   longer (per pair of runs; 18.8 to 21.7 s). agent-browser's own commands take the lock. The relay
   gets raw `Input.*` calls from a Playwright client and cannot see where one action ends, so a
   Playwright client keeps this signal until the relay has a design for it. A site that has two of the
   pages open can see it, and so can an anti-bot vendor that serves several sites and links their
   pages on its server.

Measured with this design's parts (the `window-human-cdp` and `pw-window-filtered` scenarios): the
driven page was `visible`, drew 60 frames a second and ran its 50 ms timer at full rate, got the focus
only with the agent's input while the other page got a `blur`, got no action while `hidden`, and two
pages had the focus at the same time for at most one 100 ms sample. Everything worked: reads, clicks,
typing, a library session that waits for content that only an animation frame writes, a lazy image,
an `IntersectionObserver` callback, a shot (56 to 97 ms) and a record. No single scenario ran the
whole design (it is not built): the build's live test runs it as one scenario, also with two agents
(section 8).

Each other way leaves a signal that a person's page never shows (section 4):

- **Today's default** (focus emulation while a command is attached) makes a background tab
  `visible` for each command (11 ms to 1 s; 30 s for a shot of a new tab on main) while the front tab
  of the same window stays `visible` too. After a click the hidden page keeps `document.hasFocus()`
  true, and both pages report the focus at once (41 to 42 s, almost all the time after the first
  click).
- **`--hidden-drive`** gives the page 14 actions (presses, releases, clicks, keys, text changes) while
  it reports `hidden`, and the focus while `hidden`.
- **A tab switch for each input command** shows the front page a `blur` and a `hidden` for each
  command, and the driven tab is in front for 42 to 341 ms only.
- **Focus emulation for input only** still makes the tab `visible` beside the front tab, and leaves
  both pages focused.
- **Playwright** sends its own focus emulation (2 calls for 2 pages), so its background page is
  `visible` and focused for the whole connection (40 s), and a shot of it hangs. Without that
  emulation (`noDefaults: true`, or a relay that drops the call) its clicks in a background tab hang.

In every way where the page sits in a tab that Chrome never showed, CDP mouse events have
`screenX == clientX` and `screenY == clientY`. A person's events, and CDP events in a shown window,
have the window's content offset (87 or 143 px in `screenY - clientY`). This one comes from the tab,
not from the input.

**The cost.** Memory and CPU: 8 probe pages as 8 windows used 608 to 775 MB (PSS) and 5.3 to 6.8
CPU-seconds in 10 s, against 355 to 404 MB and 1.0 to 2.4 CPU-seconds as 8 background tabs
(`extra.ts --exp mem`, two runs; 32 to 46 MB more for each window). With the flag every agent page
draws at full rate, also behind another window. Time: person-shaped input takes 0.5 to 0.9 s for a
click (the path, the press and the window switch) and about 0.13 s for each typed character, and the
lock of step 6 makes the work of two agents at once 28 to 55 % longer. Code: agent-browser and the
relay already have a new-window path (personal mode's `open`, and the relay's `newWindow` branch).
Section 8 lists the build steps and the signals that stay.

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
| input | only while `visible` and focused, except `pointerout` and `pointerleave` when a window covers it; a pointer path before each press, a press of 75 to 81 ms here (xdotool) with `pressure` 0.5, `screenX - clientX` and `screenY - clientY` equal to the content's offset on the screen, one `keydown` per typed character |
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
  each scroll (in runs 6 and 7); the geometry at load and at each resize; and a
  `BroadcastChannel` message between the two pages at each change of state.
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
  `type hello --into #f`; in runs 6 and 7, `click #far` (a button below the fold); a library
  session (`Tab.clickAt` on a button whose click asks for a frame,
  then `Tab.waitFor` for the content that only that frame writes, 5 s limit); `press End` (the page
  scrolls to its bottom, to the lazy image and the sentinel); `shot`; `record` of 1 s; 3 s idle. After
  each step the script waits 1.6 s, so that the frames of the second after it are counted. A person's
  drive has the same steps where a person can do them: bring T to the front, click, type, scroll with
  the wheel and click the button below the fold, click the frame button, End, send T back.
- **What the transport adds.** `--remote-debugging-pipe` sets `navigator.webdriver` to true in every
  page of these runs, also in the person scenarios. agent-browser's real transports do not: the proxy
  uses Chrome's own remote-debugging approval, and agent mode uses `chrome.debugger` through the
  extension, where the earlier report measured `navigator.webdriver` false
  ([`2026-11-03-chrome-vs-chrome-beta.md`](2026-11-03-chrome-vs-chrome-beta.md), section 3). Every
  other signal here comes from the CDP calls and the window state, not from the transport. In the
  first window of each Chromium an infobar of 56 px appears after the first page's load, so that
  page's `innerHeight` changes from 613 to 557; later windows and tabs have no infobar.

## 3. A person: the baselines

No CDP message at all reached Chromium in these three scenarios.

| | idle | input | when the person switches |
| --- | --- | --- | --- |
| `person-front`: T is the front tab of the focused window | `visible`, 60 frames/s, 20 ticks/s, focus | 20 moves (19 with movement), press 77 ms, `pressure` 0.5, `screenY - clientY` 143 (the window's top bar and the infobar), 5 `keydown` for 5 characters | — |
| `person-tab`: T is a background tab beside F | `hidden`, 0 frames/s, 1 tick/s, no focus | the same shape (offset 87: no infobar in that tab) | Ctrl+2: T `visible` and two `focus` events, F `blur` and `hidden`; Ctrl+1: the reverse |
| `person-window`: T's window is behind F's window | `hidden`, 0 frames/s, 1 tick/s, no focus | the same shape | the stand-in window manager raises and focuses T's window: F `hidden` and `blur`, T `visible` and `focus`; back: the reverse |

So on Linux, in plain Chromium, **a covered window is `hidden`**, as on the Mac. A person's page never
had a press, a key or a text change while it was `hidden`, and two pages never had the focus at the
same time. The only input that a `hidden` page of a person got was `pointerout`, `pointerleave`,
`mouseout` and `mouseleave`, when a window covered it under the pointer.

## 4. The candidates

Each row is one scenario of `run.ts`. "A site sees" lists only what a person's page in the same
place (section 3) does not show. "Breaks" lists the steps of the drive that failed or waited. The
appendix has every value.

| Candidate (scenario) | A site sees, unlike a person | Breaks | Cost |
| --- | --- | --- | --- |
| **4a. Today's default** (`default`): focus emulation while a command is attached; T a background tab | T is `visible` for each command (text 13 to 16 ms, click 24 to 1032 ms, type 16 to 20 ms, library 1031 to 1044 ms, End 11 to 14 ms, shot 30 s, record 2.9 to 3.0 s) while F stays `visible` in the same window: two visible tabs in one window. A `focus` for each command. After the first click T keeps the focus while `hidden`, and F and T both report the focus (41 to 42 s). CDP mouse events with `screenX == clientX`, `screenY == clientY`. At load T reports `outerHeight == innerHeight` (557) | a shot of the new background tab hangs until agent-browser's 30 s limit (main; PR #41 fixes it); the lazy image and the `IntersectionObserver` callback come only at the next command (2.0 s after End) | none: today |
| **4b. `--hidden-drive`** (`hidden-drive`) | 14 actions while `hidden`; 2 `focus` events while `hidden`, and the focus kept after them (F and T both focused 10.5 s); `record` makes T `visible` for 2.6 s; `screenX == clientX` | between commands the page draws nothing: rAF, `IntersectionObserver` and transitions wait (README) | none: today |
| **1. One window per page** (`window`): with `--disable-backgrounding-occluded-windows`; F's window over T's | T is `visible`, 60 frames/s and 20 ticks/s while covered (a person's covered window is `hidden`, and a person's uncovered window that is not in front looks the same as this). The first press activates and raises T's window: T `focus`, F `blur`, as for a person's click. The input's shape (section 5) | nothing: text 20 to 39 ms, click 54 to 82 ms, library 278 to 312 ms, lazy image 20 to 44 ms, shot 56 to 84 ms, record 3.0 to 3.1 s with no visibility change | one window per page |
| **1'. Without the flag** (`window-no-flag`) | covered, T is `hidden` (as a person's). The agent's press reaches the hidden page; then Chrome activates and raises the window, and T becomes `visible` | nothing | as 1 |
| **1''. With focus emulation on attach** (`window-default`) | as 1, plus a `focus` and a `blur` for a read (`text`) with no window switch | nothing | as 1 |
| **1, keys into an inactive window** (`window-keys-inactive`) | after F's window took the focus back, `type` into T gave T the focus with no window switch: F and T both focused (8.6 s) | nothing | the reason for step 5 of the design |
| **1+2. One window per page; `Target.activateTarget` on it for each input command, then on F's** (`window-activate`) | per input command F `blur` and `focus`, T `focus` and `blur`, as a person who clicks a window and clicks back; T is the active window for 0.1 to 0.4 s each time. The input's shape | nothing (lazy image 131 to 149 ms) | on the Mac it takes the operator's focus |
| **2. Activate the tab for each input command, then go back** (`activate`) | per input command F `blur` and `hidden`, T `visible` and `focus`, then the reverse: 4 tab switches that F sees; T in front for 42 to 341 ms each time | nothing | the other tab of the window sees every switch: the operator's tab in personal mode, or another agent's page |
| **3. Focus emulation for input commands only** (`emulate-input`) | T `visible` during each input command (20 to 59 ms; 2.0 s for the library session) beside a `visible` F; the focus kept after the first click (both focused 15 to 16 s); `screenX == clientX` | a shot takes 3.1 to 4.2 s; the lazy image and the `IntersectionObserver` callback come 2.0 s late | small |
| **5a. Playwright as it is** (`pw-default`) | T is `visible` and focused for the whole connection while it is a background tab, beside a `visible`, focused F (both focused 40 s); after the disconnect T is `hidden`; `screenX == clientX`; a press of 0 ms | `page.screenshot` of the background tab hangs (8 s limit) | none: today's relay |
| **5b. Playwright without focus emulation** (`pw-no-defaults`: `connectOverCDP(url, { noDefaults: true })`; `pw-filtered`: the bridge answers the call itself) | T stays `hidden`; `fill` and `press` reach the hidden page (4 actions while `hidden`) | `page.click` hangs (8 s limit): Playwright waits for frames that a hidden page never draws; the lazy image loads 2 s late | unusable alone |
| **5+1. Playwright without focus emulation, every page in a window of its own** (`pw-window-filtered`) | as 1; the input's shape | nothing: click 95 to 123 ms, `waitForFunction` 101 to 106 ms, lazy image 15 to 17 ms, shot 60 to 68 ms | as 1, in the relay |
| **6a. One window per page, the X focus moved to it, CDP input** (`xfocus-cdp`) | as 1+2; the input's shape | nothing | Linux only |
| **6b. One window per page, the X focus moved to it, X input** (`xfocus-xinput`) | nothing that the probe records: the same events as `person-window` | nothing (no shot or record in this drive) | Linux only; one pointer for the whole display (a lock); the window must be raised and not covered at the point; the agent maps page points to screen points |
| **6c. One window per page, `Target.activateTarget`, person-shaped CDP input** (`window-human-cdp`) | the same input as `person-window` (20 moves with movement, a press of 87 to 93 ms, `pressure` 0.5, the right screen offset, 5 `keydown`), and the same window switch. One difference in runs 3 to 5: the activation raises the window under the real X pointer, so the page gets a real pointer event there, and a CDP path that starts elsewhere jumps (195 px in `extra.ts --exp jump`). The final runs start the path at the real pointer and scroll with the wheel: 0 pointer jumps, 0 scrolls with no wheel or key, 0 field focus with no press, as in the person rows (section 5) | nothing | a click takes about 0.9 s, the field click and 5 characters about 1.8 s |
| **6c with two agents at once** (`extra.ts --exp two`, `two-noact`): each agent activates its own window (or not) and types | the two pages have the focus at the same time: 9.6 to 12.4 s of 12.5 to 14.8 s (with no activation 11.5 to 11.7 s of 12.4 to 12.5 s). Each activation after the first also gives a pointer jump, because the X pointer does not follow the CDP path: 12 and 9 moves of more than 100 px in 6 activations of each window (one run) | nothing | — |
| **6c with two agents and one input lock** (`extra.ts --exp two-lock`) | 0 to 0.3 s of both pages focused (at a switch) | nothing | the work takes 28 to 55 % longer (per pair of runs; 18.8 to 21.7 s) |
| **Taylor without the flag, with activation before input and shots** (not run as one scenario) | between commands a covered agent window is `hidden`, as a person's covered window; the activation shows it, as a person's click does. It adds a switch for each shot, and for each read that needs frames | a read or a `waitFor` of content that only a frame writes (rAF, `IntersectionObserver`, lazy load) waits until the next activation; the page's own timers run at 1 tick/s | a switch (a `blur` in another page) for each such step |

Why the design keeps the flag on taylor, although the last row is closer to a person's covered window:
with the flag a read, a `waitFor`, a lazy image and the page's own timers work with no switch, so
other pages see fewer `blur` events; and the Mac, where the agent must not activate its windows, needs
the flag, so one rule holds for both. The cost is the full-rate drawing of every agent page (the CPU
numbers of the answer). The build can measure the last row as a scenario and change this choice.

What breaks in each, for the features the board task names:

- **rAF, IntersectionObserver, lazy load.** In a window of its own the page draws all the time, so
  these work as for a person. In a background tab they wait until a command makes the page draw (the
  default: during each command; the hidden drive: during input commands and shots only).
- **Shots.** In a window: 56 to 97 ms. In a background tab: the default mode on main hangs on a new
  tab (PR #41 fixes it: 0.1 to 3 s, measured there), the hidden drive takes about 0.1 s, focus
  emulation for input only 3.1 to 4.2 s, and Playwright's own shot hangs.
- **record.** It works in every candidate. It turns focus emulation on for its run (in a window that
  emulation changes only the focus), and after it the page keeps the focus with no `blur`. In a
  window the build can leave it out (section 8).
- **`Tab.clickAt` and library sessions.** `Tab.waitFor` for content that only a frame writes worked
  in every agent-browser candidate. In a background tab it worked only because the click or the
  emulation made the page draw at that time: in the default mode the session's focus emulation
  (1.0 s), with focus emulation for input only the emulation around the click (2.0 s). In a window it
  works with no such help (0.3 s). Content that a frame writes after the command ends does not appear
  in a background tab until the next command (the lazy image of `default` and `emulate-input`).

## 5. Input: what CDP input shows, and what it can match

Measured at the click of each scenario (appendix, third table):

| | moves before the press (with movement) | `screen - client` at the press | `pressure` | press | keys for "hello" |
| --- | --- | --- | --- | --- | --- |
| a person (`person-*`, `xfocus-xinput`) | 20 (19 or 20) | the content's offset: [0,87] or [0,143] | 0.5 | 75 to 81 ms | 5 `keydown`, 5 `keypress`, 5 `keyup`, `inputType` `insertText` |
| agent-browser today, in a tab that Chrome never showed | 1 (0) | [0,0] | 0 | 3 to 5 ms | none: `Input.insertText` gives one `beforeinput` and one `input` only |
| agent-browser today, in a shown window (`window`, `activate`, `xfocus-cdp`) | 2 (1) | [0,87] | 0 | 3 to 20 ms | none |
| Playwright 1.64.1 | 1 or 2 | [0,0] in a tab, [0,87] in a window | 0.5 | 0 to 3 ms | none (`fill` uses `Input.insertText`) |
| person-shaped CDP input (`window-human-cdp`) | 20 (20) | [0,87] | 0.5 | 87 to 93 ms | 5 of each, as a person |

Field by field, the `pointerdown`, `mousedown`, `pointerup`, `click`, `keydown`, `keypress`, `keyup`,
`beforeinput` and `input` events of `window-human-cdp` were the same as those of `xfocus-xinput` (a
person's XTest input into the same kind of window): `isTrusted`, the coordinates, `movementX/Y`,
`buttons`, `detail`, `pointerType`, `pressure`, `width`, `key`, `code`, `keyCode`, `inputType`,
`data`, `sourceCapabilities` and `navigator.userActivation`. Today's `Input.insertText` gives one
`input` event with `data` "hello": a person's typing gives 5, one character each.

So CDP input can match every input field that a page reads, with these conditions: the page is in a
window that Chrome has shown (else `screenX == clientX`), and the agent sends the person's shape. A
press with no move before it, a press of a few milliseconds, `pressure` 0 and text with no key events
are what agent-browser sends today. The repo already has the parts: ghost-cursor's path (used by
`record`), `typeChar` (key events per character), and `force: 0.5` (the earlier report's advice).

Three more conditions, from the review of PR #43:

- **The pointer's position at each activation.** When Chrome raises a window, the X server gives the
  page a real pointer event at the X pointer's position. A CDP path that starts at another point then
  jumps: in `extra.ts --exp jump` the first CDP move had `movementX` -195. CDP moves do not move the X
  pointer, so the same happens again at the second activation of the same window, after a CDP path
  that ended elsewhere (the second review of PR #43: a real move at the X pointer, then a jump of
  `movementX` -730). The pointer cannot be parked outside every window, because production windows
  fill the screen. Two ways remain for taylor, and neither is measured; the build's live test decides:
  - **Move the X pointer to the end of each CDP path** (agent-browser can read and move the X pointer
    through the X server, as `run.ts` and `extra.ts` do with xdotool). Risks: a real event's movement
    comes from the last real pointer point, not from the last point that the page saw (round 2 of the
    second review's run: `movementX` -730), so the move itself can give the page under the pointer a
    trusted `mousemove` with a movement of some hundred pixels at a point where the page already saw
    the pointer; with two agents the X pointer stays at the last agent's path end, so the real event
    of an activation comes at the page's last point only when the same window is driven again; and the
    move must be inside step 6's lock.
  - **Start each path at the X pointer and never move the X pointer.** The real event at each
    activation then has movement 0, and only its position differs from the page's last point (the
    page sees the pointer "enter" at the X pointer's point each time).
  The relay has no access to the X pointer, so for a Playwright client the real event at the X
  pointer's point, and the jump after it, stay a signal (section 8). `stepSignals` counts such a jump
  ("pointer jumps > 100 px"); in runs 6 and 7 `window-human-cdp` has one activation and starts its
  path at the X pointer.
- **Focus by a click, not by a script.** `type --into` focuses the field with `el.focus()`
  (`src/browser.ts`, line 750): the page gets a `focusin` with no press before it. A person clicks the
  field. A click also moves the caret to the point of the click: in the two-agent check each click in
  the middle of a field that already held text put the next "hello" into the middle
  ("hellohellohellohehellohellollo"). So the click that replaces `el.focus()` must leave the caret where
  `type --into` puts it today (for example, a click to the right of the text, or the End key after
  the click). `setFiles` sets the files with no click at all (line 796).
- **Scroll by the wheel, not by a script.** `click` and `clickText` bring the element into view with
  `scrollIntoView` (lines 686 and 712): the page scrolls with no wheel or key event. A person scrolls
  with the wheel (or a key). The probe now has a button below the fold, logs each scroll, and counts
  "scrolls with no wheel or key" and "field focus with no press" (appendix, third table).

Measured in the final runs:

| | pointer jumps > 100 px | scrolls with no wheel or key | field focus with no press |
| --- | --- | --- | --- |
| a person (`person-*`, `xfocus-xinput`) | 0 | 0 | 0 |
| agent-browser today (`default`, `hidden-drive`, `window*`, `activate`, `emulate-input`, `xfocus-cdp`) | 1 to 4 | 1 to 3 | 1 to 2 |
| Playwright 1.64.1 (`pw-*`; its drive has no click below the fold) | 0 to 2 | 0 to 2 | 1 |
| person-shaped CDP input from the real pointer, with the wheel (`window-human-cdp`) | 0 | 0 | 0 |

## 6. Playwright behind the relay (candidate 5)

- Playwright 1.64.1 sends `Emulation.setFocusEmulationEnabled { enabled: true }` once for each page's
  main frame (2 calls for 2 pages here; the two-modes probe's log counted 39). It skips the call only
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
- **Popups** (`extra.ts --exp popup`, first measured by the review of PR #43, on Linux). A click on a
  `target=_blank` link, and `window.open()` with no window features, open a new tab in the opener's
  window, in front and focused; the opener gets a `blur` and becomes `hidden`. `window.open(url, "",
  "popup,...")` opens a window of its own, focused, and the opener stays `visible` with a `blur`. In
  each case the new page has `history.length` 1. The popup window does not get the size that the site
  asked for: `window.open(url, "", "popup,width=500,height=400")` opened at an outer size of 1100x734
  with `--window-size=1100,700` (which `extra.ts`, `run.ts` and agentwatch's agent unit pass:
  `agentwatch/daemon/browser/unit.py`, lines 542 and 543), and at 500x434 without `--window-position`
  and `--window-size` (first in the second review's copy of `extra.ts`; `extra.ts --exp popup
  --no-window-size` gives the same, 2026-11-05 01:54 UTC). A site can compare the size that it asked for with the size that it got. The
  rule: drive the new tab or window where the site put it, and go back to the opener with a tab
  switch, as a person does. Do not move tabs between windows (a person cannot do that with one click,
  and a site sees the opener's window change). The fix for the popup size can need a change of
  agentwatch's `--window-size` flag (for example, a size from the first window in place of a flag).
- **Window activation in the relay.** The relay's `Target.activateTarget` only selects the tab
  (`chrome.tabs.update({ active: true })`, `src/relay/model.ts`, lines 758 to 760), and
  `chrome.tabs.update` does not focus the window. So step 5 of the design needs a new relay path
  (`chrome.windows.update(windowId, { focused: true })` for a page whose window is not active), on
  taylor only.
- **Input from a Playwright client.** The relay passes Playwright's raw `Input.*` calls. It cannot
  see where one action ends, so it cannot hold the lock of step 6 around an action, and it cannot
  shape the input without a design of its own. Until then a Playwright client keeps the input
  signals of section 5 and the two-agent focus signal of section 4.

## 7. macOS

**The design is for taylor first. Its Mac part waited for a measurement in the Mac's agent browser
(board task ab-v16.16). That check ran on 2026-11-05 (the end of this section), and the Mac build is
board task ab-v16.27.** Nothing ran on the Mac for this report. The measurement needed at least:

- **Window order.** On Linux a new window from `Target.createTarget` with `newWindow: true,
  background: true` comes above the other windows without the focus (`extra.ts --exp raise`; `run.ts`
  raises F's window again at once, so its scenarios do not show this). On the Mac a new agent window
  above the operator's windows covers their work.
- **Spaces, Mission Control, App Exposé, the Dock menu and Cmd+`**: where a new agent window goes,
  and what the operator sees of it there.
- **The reason for today's tabs.** agent mode opens background tabs because "a foreground tab
  activates Chrome, which takes the operator's focus and Space (measured 2026-10-30)"
  (`src/browser.ts`, `open`, lines 285 to 296), and a rule of the README says "Never take the
  operator's focus, Space, pointer or clipboard" (`README.md`, the rules table). A window per page
  must keep that rule.

Facts from the earlier Mac checks
([`2026-11-03-chrome-vs-chrome-beta.md`](2026-11-03-chrome-vs-chrome-beta.md), section 8, check 9)
and from the README's measured rows:

- **A window behind the operator's windows.** With `--disable-backgrounding-occluded-windows`, an
  agent window behind the operator's full-size Chrome window stayed `visible`, drew 121 frames in 2 s
  and ran a 10 ms timer 200 times in 2 s. Without the flag the page was `hidden` (0 frames, 24 ticks),
  and CDP clicks and typing still reached it. Linux shows the same (section 4, `window-no-flag`).
  Those runs had the two old timer flags (`--disable-background-timer-throttling`,
  `--disable-renderer-backgrounding`, dropped since): the timer numbers can be lower without them.
- **Focus.** `document.hasFocus()` was false while idle and true after CDP input, and the front app
  stayed the operator's Chrome during that input. So on the Mac CDP input gives the page the focus
  without bringing the agent's app to the front. A site sees a focused page, not the app that is in
  front. Not measured on the Mac: whether another agent window then gets a `blur`, as on Linux.
- **The start of Chrome.** Chrome activates itself when it shows its first window: with `open -n -g`
  alone, 12 of 12 starts took the front. agent-browser's give-back (`src/giveback.ts`) asks macOS to
  activate the operator's app again; with the same call from a helper, the operator's app was back
  after 36, 43 and 83 ms. This is about the app at the start, not about the order of later windows.
- **Personal mode** already opens a window of its own in the operator's Chrome. Its code comment says
  that this window opens behind the operator's windows and "renders normally without stealing focus"
  (`src/browser.ts`, `open`). The agent-mode path (`Target.createTarget` with `newWindow`, or the
  relay's `chrome.windows.create({ focused: false })`) is not measured on the Mac.
- **What the Mac forbids.** The operator shares the screen, the pointer and the keyboard. So on the
  Mac the agent never activates its windows: Chrome's window activation (`Target.activateTarget`,
  `chrome.windows.update({ focused: true })`) can bring the agent's app to the front (not measured on
  the Mac). And it never sends OS-level input, which moves the operator's pointer. Step 5 of the
  design, `window-activate` and `xfocus-*` are for taylor only. A tab switch (candidate 2) through the
  relay's `chrome.tabs.update({ active: true })` does not activate the window.

If the Mac measurement keeps the window order and the Space as they are, the Mac's design would be
steps 1 to 4 and 6, with no activation: a window of its own behind the operator's windows, the flag,
no focus emulation, person-shaped CDP input and one input at a time. The page then gets the focus at
the agent's first press with no change of the app in front, and a site that also has a page in
another agent window can see two focused pages.

**Measured on 2026-11-05** (board task ab-v16.44;
[`test/live/anti-detect/mac.ts`](../../test/live/anti-detect/mac.ts) at main 87be973 on the
operator's Mac, Google Chrome Beta 158.0.8127.18 as the agent Chrome, today's flags and the check's
own (`MEASURE_ARGS`: a debugging port, no network), nobody at the Mac; run 2 ran every step, run 1
stopped after 25 s when the operator used the Mac; the README item **One window per agent page on
the Mac** has the details). The measurement kept the window order and the Space: the start's first
window, two windows from `Target.createTarget` with `newWindow: true, background: true`, and a sized
popup window each came behind the operator's front window, 100% covered, on the current Space, and
no step changed the Space. A CDP click did not bring its window forward. In a covered window of its
own with no focus emulation the page stayed `visible` at 60 frames a second; text, click, type and
End took 8 to 24 ms, a shot 85 ms, and a 3 s `record` got 60 fps. The front app changed only at the
start (79 and 132 ms, then agent-browser's give-back) and at each popup, until the check's watcher
gave it back (5 to 25 ms; with no give-back the length of a take is not measured). A CDP click gives
its page the focus with no activation, and the other agent page gets no `blur`: after the first
click in WB, two pages had the focus at once for the whole time that the check watched each step
(1.2 to 3.7 s). Keys into an inactive window arrived. A popup tab (`target=_blank`, `window.open()`)
came `visible` with no focus, and the opener behind it went `hidden` and kept the focus with no
`blur`; the sized popup's page had no focus, and the opener kept it. On Linux (section 6) the popup
tab and the sized popup's window take the focus, and the opener gets a `blur`. The check's
person-shaped input had a press of 72 ms and one pointer jump, where its path started at a fixed
point, not at the page's last point. No page got an event at the real pointer. Not measured:
Mission Control, App Exposé, the Dock menu and Cmd-` as the operator sees them (`--look`, with the
operator), window activation, the way back to an opener behind a popup tab with no activation (the
check closed each popup with `Target.closeTarget`), Google Chrome stable, and the relay with the
agent extension.

## 8. The recommended design, and its remaining signals

**The build** (follow-up tasks; nothing here is built). Taylor first; the Mac waits for its build,
ab-v16.27, after the Mac check at the end of section 7. The steps have the numbers of "The answer".

1. **One window per agent page.** agent-browser `open` in agent mode: `Target.createTarget` with
   `newWindow: true` and `background: true` (`src/browser.ts`). The relay (`src/relay/model.ts`):
   every `Target.createTarget` opens a window (`chrome.windows.create({ focused: false })`). Popups:
   drive the new tab or window where the site opened it, and go back to the opener with a tab switch;
   never move a tab into another window (section 6).
2. **No focus emulation.** agent-browser `attach`: no `Emulation.setFocusEmulationEnabled` for a page
   in a window of its own; `record` needs no focus emulation there either. The relay answers
   `Emulation.setFocusEmulationEnabled` with `{}` and never sends it to Chrome
   (`src/relay/policy.ts`). The default mode and `--hidden-drive` stay only behind an explicit
   `open --tab`, and the README warns that a site can detect a background tab (the lead's decision for
   the build task, ab-v16.26). Personal mode keeps today's behaviour: it already opens a window of its
   own, but in the operator's own Chrome, which has no `--disable-backgrounding-occluded-windows`, so a
   covered window there is `hidden` (not measured here).
3. **Keep `--disable-backgrounding-occluded-windows`.** The agent-mode unit on taylor today passes
   none of the three old flags (the two-modes design, section 7): it needs this one.
4. **A person's input** (`Tab.click`, `clickText`, `clickAt`, `hover`, `type`, `press`, `setFiles`): a
   pointer path from the real pointer's position at each activation (ghost-cursor, as `record` uses),
   a press of 70 to 90 ms with `force: 0.5`, one key-event pair per character (`typeChar`) 90 to 150 ms
   apart in place of `Input.insertText`, a click on the field in place of `el.focus()` (`type --into`,
   and before `setFiles`) that leaves the caret where `type --into` puts it today, and wheel events in
   place of `scrollIntoView`. On taylor, the X pointer at each activation: either move it to the end
   of each CDP path (inside step 6's lock), or start each path at it and never move it; neither is
   measured, and the build's live test decides (section 5, with the risks of each). Cost: 0.5 to 0.9 s for each click and about 0.13 s for each character.
5. **The window comes forward for input, on taylor only.** Before each input command, activate the
   page's window if it is not active (`Target.activateTarget` for agent-browser; in the relay a new
   path, `chrome.windows.update({ focused: true })`, because its `Target.activateTarget` only selects
   the tab). Never on the Mac.
6. **One input at a time in each agent browser.** A lock around the activation and the input command,
   as one step, for agent-browser's commands (across processes: the agent browser's state folder can
   hold it). Cost: 28 to 55 % more time for two agents that type at once. The relay cannot lock a
   Playwright client's raw `Input.*` calls by action (section 6): that signal stays until the relay has
   a design.

Tests for all steps: the fake Chrome (`test/fake-chrome.ts`) models a window that is not in front
(`visible`, drawing, the focus at the first press). The build's live test runs the whole design as one
scenario on taylor, also with two agents at once and with several activations of one window, against
the person baselines of `run.ts`.

**What a site can still see** with this design:

- **Pace and patterns.** The agent acts fast and with no idle pointer movement between commands. The
  probe records no behaviour model, so this is not measured.
- **Two agents at once through Playwright** (step 6): two of the site's pages focused at the same
  time. A site that has two of the pages open can see it, and so can an anti-bot vendor that serves
  several sites and links their pages on its server.
- **The pointer at an activation** (step 4): the page gets a real pointer event at the X pointer's
  point. For agent-browser's commands one of the two ways of section 5 removes the jump after it or
  shrinks it to a change of position; neither is measured. For a Playwright client the jump stays:
  the relay cannot read or move the X pointer.
- **A covered window that draws.** With the flag, an agent window under another window draws at 60
  frames a second. A person's covered window is `hidden`. A site cannot tell a covered window from an
  uncovered one, so it sees a window that is not in front, as on a second screen.
- **Window geometry.** On taylor's Xvfb, with no window manager, every new window opens at the same
  place and size (0,0 and 1100x700 here), with no window-manager frame. A production agent browser
  fills the screen with its windows. A person's windows differ. With `--window-size`, a site's popup
  window opens at that size and not at the size that the site asked for (section 6); the fix can need
  a change in agentwatch's agent unit. The earlier report found that a Linux
  box cannot look like the operator's Mac (its section 2.2).
- **`history.length` 2** for a page that agent-browser opens at `about:blank` and then navigates
  (`open`, and the relay's hold of contract C10), where a person's new page has 1. Known since board
  task ab-v16.6.
- **record** keeps the page's focus after its run, with no `blur` (it enables focus emulation; step 2
  removes it in a window). For its run it also sets a device-metrics override (the page is resized to
  640x360 inside its 1100x700 window here, and gets a `resize`), and it puts its overlay into the DOM
  (a 1x1 pixel that changes each frame, and the cursor; `src/record.ts`).
- **On the Mac:** what the Mac check at the end of section 7 showed (two agent pages with the focus
  at once; the opener of a popup tab `hidden` with the focus), and what it did not measure.
- Signals outside this report: the identity and machine of the earlier report, `outline`'s
  `data-agent-browser-idx` attribute, Playwright's `Runtime.enable` (the earlier report: a page can
  time it) and its `page.bringToFront` (`Page.bringToFront` activates the window), and a site's own
  behaviour checks.

## 9. What this did not measure

- Anything on the Mac (section 7), except the Mac check of 2026-11-05 at the end of section 7.
- Google Chrome: only Chromium 156 ran. The window, focus and input code is the same, but Chrome
  stable was not run.
- agent mode's real transport: the relay with the extension's `chrome.debugger`. The probe drove
  Chromium through a pipe; the relay's own changes (a window for each `createTarget`, the dropped
  call) ran as a bridge rule, not in `src/relay/`.
- A real window manager: Xvfb on taylor has none. A window manager can place, frame and focus windows
  in its own way.
- Page freezing and intensive timer throttling of a tab that is hidden for more than 5 minutes.
  The runs keep T hidden for at most about 60 s. No `freeze`, `resume` or `pagehide` came in any run.
- Popups in each design: `extra.ts --exp popup` measured them only for a page in a window of its own.
- The whole design as one scenario: it is not built. The parts ran in separate scenarios.
- Either way for the X pointer at each activation (section 5): moving it to each path's end, or
  starting each path at it.
- "Taylor without the flag, with activation before input and shots" (section 4) as one scenario.
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
for e in raise two two-lock two-noact popup jump mem; do node test/live/anti-detect/extra.ts --out-dir /tmp/anti-detect/extra --exp $e; done
```

`extra.ts` holds the checks that the review of PR #43 first wrote (the window order, two agents with
and without the lock, popups, the pointer at an activation, and memory and CPU); each prints one JSON
object.

`run.ts` prints the three tables of the appendix for its run, writes every record and every step to
`results.json` and `steps.md` in its run folder, and exits 0 when every scenario ran (a failed step is
a measurement, not a failure of the script). It ends only its own children, and it never connects to
a Chrome that it did not start. It is not part of `npm test`. The final runs took about 11 minutes
each.

## Appendix: the tables of the final runs

The output of `report.ts` for runs 6 and 7 (2026-11-05, 01:02 to 01:13 and 01:13 to 01:25 UTC), the
two runs of the committed script. Where the two runs differ, a cell gives both values with " / "
between them. Runs 6 and 7 add the click below the fold, the scroll records and the three new input
counts, and start `window-human-cdp`'s path at the real pointer; their drive is one step longer, so
their focus times are a little longer. The ranges in the text are over runs 3, 4 and 5 (2026-11-04
23:51 to 2026-11-05 00:28 UTC: the same scenarios without that step; run 3 also without
`window-keys-inactive` and with the `IntersectionObserver` sentinel too high on the page), except
where the text names runs 6 and 7 or `extra.ts`. Runs 1 and 2 were earlier versions of the script
and gave the same results where they measured the same thing; the person-window baseline failed in
run 1 (a fault of the script, fixed). Each run exited 0. The `extra.ts` values come from one run of
each check on 2026-11-05 (00:59 to 01:02 UTC), a second run of `two` (about 01:41 UTC: both pages
focused 9.6 of 12.5 s, 12 and 9 pointer jumps of more than 100 px), a run of `popup --no-window-size`
(01:54 UTC), and the reviews' runs of the same checks.

How to read the tables:

- "visible ms": the time that T reported `visible` during the step and the 200 ms after it; "all"
  means that T was `visible` before the step and stayed so (a window).
- "actions while hidden": presses, releases, clicks, keys and text changes that T got while it
  reported `hidden`.
- "F and T focused, before record": the time in which both pages reported `document.hasFocus()` true,
  sampled each 100 ms, up to the record step. A value of 100 or 200 is one or two samples at a switch.
- "End: lazy image" and "End: IntersectionObserver": the time from the start of the End step to the
  image's request and to the observer's callback.
- "press ms": from `mousedown` to `mouseup`.
- "pointer jumps > 100 px", "scrolls with no wheel or key", "field focus with no press": section 5.

### What the driven page T showed
| scenario | idle | visible ms (text, click, type, library, End, shot, record) | T: vis changes / focus / blur | actions while hidden / unfocused | after: vis, focus, fps, tps | F saw | F and T focused, before record (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| person-front | visible 60 fps 20 tps, focus yes | -, all, all, -, all, -, - | 0 / 0 / 0 | 0 / 0 | visible, yes, 60, 20 | nothing | 0 |
| person-tab | hidden 0 fps 1 tps, focus no | -, all, all, -, all, -, - | 2 / 2 / 1 | 0 / 0 | hidden, no, 0, 1 | blur, visibilitychange:hidden, visibilitychange:visible, focus | 0 |
| person-window | hidden 0 fps 1 tps, focus no | -, all, all, -, all, -, - | 2 / 1 / 1 | 0 / 0 | hidden, no, 0, 1 | visibilitychange:hidden, blur, visibilitychange:visible, focus | 0 |
| default | hidden 0 fps 1 tps, focus no | 15, 23, 18, 1031, 11, 30010, 3050 / 15, 1035, 21, 1037, 16, 30011, 2979 | 16 / 2 / 1 | 0 / 0 | hidden, yes, 0, 1 | nothing | 43200 / 44200 |
| hidden-drive | hidden 0 fps 1 tps, focus no | 0, 0, 0, 0, 0, 0, 2644 / 0, 0, 0, 0, 0, 0, 2652 | 2 / 2 / 0 | 19 / 0 | hidden, yes, 0, 1 | nothing | 12700 / 12600 |
| window | visible 60 fps 20 tps, focus no | all, all, all, all, all, all, all | 0 / 2 / 0 | 0 / 0 | visible, yes, 60, 20 | blur | 0 / 100 |
| window-no-flag | hidden 0 fps 1 tps, focus no | 0, 263, all, all, all, all, all / 0, 275, all, all, all, all, all | 1 / 2 / 0 | 2 / 0 | visible, yes, 60, 20 | visibilitychange:hidden, visibilitychange:visible, visibilitychange:hidden, blur | 0 |
| window-default | visible 60 fps 20 tps, focus no | all, all, all, all, all, all, all | 0 / 3 / 1 | 0 / 0 | visible, yes, 60, 20 | blur | 100 |
| window-activate | visible 60 fps 20 tps, focus no | all, all, all, all, all, all, all | 0 / 7 / 5 | 0 / 0 | visible, yes, 60, 20 | blur, focus, blur, focus, blur, focus, blur, focus, blur, focus | 0 |
| activate | hidden 0 fps 1 tps, focus no | 0, 51, 47, 323, 42, 0, 2658 / 0, 64, 44, 302, 45, 0, 2652 | 12 / 7 / 5 | 0 / 0 | hidden, yes, 0, 1 | blur, visibilitychange:hidden, visibilitychange:visible, focus, blur, visibilitychange:hidden, visibilitychange:visible, focus, blur, visibilitychange:hidden, visibilitychange:visible, focus, blur, visibilitychange:hidden, visibilitychange:visible, focus, blur, visibilitychange:hidden, visibilitychange:visible, focus / blur, visibilitychange:hidden, visibilitychange:visible, focus, blur, visibilitychange:hidden, visibilitychange:visible, focus, blur, visibilitychange:hidden, visibilitychange:visible, focus, blur, visibilitychange:hidden, visibilitychange:visible, focus, blur, visibilitychange:hidden, focus, visibilitychange:visible | 0 |
| emulate-input | hidden 0 fps 1 tps, focus no | 0, 37, 25, 1038, 26, 0, 2642 / 0, 37, 28, 1037, 18, 0, 2644 | 12 / 2 / 0 | 0 / 0 | hidden, yes, 0, 1 | nothing | 17300 / 18300 |
| pw-default | visible 60 fps 20 tps, focus yes | all, all, all, all, all, all, - | 0 / 0 / 0 | 0 / 0 | visible, yes, 60, 20 | nothing | 39900 / 40300 |
| pw-no-defaults | hidden 0 fps 1 tps, focus no | 0, 0, 0, 0, 0, 0, - | 0 / 1 / 0 | 4 / 0 | hidden, yes, 0, 1 | blur, visibilitychange:hidden, visibilitychange:visible, focus | 27300 |
| pw-filtered | hidden 0 fps 1 tps, focus no | 0, 0, 0, 0, 0, 0, - | 0 / 1 / 0 | 4 / 0 | hidden, yes, 0, 1 | blur, visibilitychange:hidden, focus, visibilitychange:visible / blur, visibilitychange:hidden, visibilitychange:visible, focus | 27300 |
| pw-window-filtered | visible 60 fps 20 tps, focus no | all, all, all, all, all, all, - | 0 / 2 / 0 | 0 / 0 | visible, yes, 60, 20 | blur | 0 |
| xfocus-cdp | visible 60 fps 20 tps, focus no | all, all, all, all, all, all, all | 0 / 7 / 5 | 0 / 0 | visible, yes, 60, 20 | blur, focus, blur, focus, blur, focus, blur, focus, blur, focus | 0 |
| xfocus-xinput | visible 60 fps 20 tps, focus no | -, all, all, -, all, -, - | 0 / 2 / 1 | 0 / 0 | visible, no, 60, 20 | blur, focus | 0 |
| window-human-cdp | visible 60 fps 20 tps, focus no | -, all, all, -, all, -, - | 0 / 2 / 1 | 0 / 0 | visible, no, 60, 20 | blur, focus | 0 |
| window-keys-inactive | visible 60 fps 20 tps, focus no | -, all, all, -, all, -, - | 0 / 3 / 1 | 0 / 0 | visible, yes, 60, 20 | blur, focus | 8600 |

### What worked
| scenario | text | click | type | click below the fold | library (frame content) | End: lazy image | End: IntersectionObserver | shot | record |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| person-front | - | ok 613 ms / ok 637 ms | ok 1053 ms / ok 1049 ms | ok 2811 ms / ok 2834 ms | - | 22 ms / 23 ms | 18 ms / 31 ms | - | - |
| person-tab | - | ok 619 ms / ok 607 ms | ok 1032 ms / ok 1064 ms | ok 2771 ms / ok 2816 ms | - | 23 ms / 21 ms | 22 ms / 17 ms | - | - |
| person-window | - | ok 607 ms / ok 622 ms | ok 1050 ms / ok 1053 ms | ok 2869 ms / ok 2810 ms | - | 26 ms / 20 ms | 26 ms / 29 ms | - | - |
| default | ok 26 ms / ok 25 ms | ok 33 ms / ok 1044 ms | ok 26 ms / ok 30 ms | ok 38 ms / ok 32 ms | ok 1040 ms / ok 1047 ms | 2034 ms / 2040 ms | 2033 ms / 2037 ms | FAIL (Page.captureScreenshot: no response after 30000 ms) | ok 3221 ms / ok 3137 ms |
| hidden-drive | ok 16 ms / ok 17 ms | ok 122 ms / ok 102 ms | ok 122 ms / ok 115 ms | ok 118 ms / ok 116 ms | ok 119 ms / ok 120 ms | 68 ms / 54 ms | 68 ms / 54 ms | ok 109 ms / ok 122 ms | ok 3057 ms / ok 3085 ms |
| window | ok 21 ms / ok 19 ms | ok 52 ms / ok 53 ms | ok 29 ms / ok 25 ms | ok 39 ms / ok 48 ms | ok 284 ms / ok 312 ms | 19 ms / 30 ms | 35 ms / 39 ms | ok 70 ms / ok 87 ms | ok 3144 ms / ok 3103 ms |
| window-no-flag | ok 19 ms / ok 26 ms | ok 136 ms / ok 132 ms | ok 26 ms / ok 27 ms | ok 28 ms / ok 51 ms | ok 284 ms / ok 283 ms | 22 ms / 20 ms | 22 ms / 20 ms | ok 61 ms / ok 57 ms | ok 3078 ms / ok 3106 ms |
| window-default | ok 29 ms / ok 22 ms | ok 47 ms / ok 42 ms | ok 26 ms / ok 27 ms | ok 44 ms / ok 29 ms | ok 286 ms / ok 285 ms | 20 ms | 19 ms / 20 ms | ok 55 ms / ok 59 ms | ok 3061 ms / ok 3202 ms |
| window-activate | ok 21 ms / ok 20 ms | ok 149 ms / ok 142 ms | ok 130 ms | ok 134 ms / ok 138 ms | ok 384 ms / ok 381 ms | 121 ms / 124 ms | 136 ms / 128 ms | ok 67 ms / ok 71 ms | ok 3111 ms / ok 3076 ms |
| activate | ok 16 ms / ok 15 ms | ok 66 ms / ok 75 ms | ok 60 ms / ok 56 ms | ok 73 ms / ok 76 ms | ok 336 ms / ok 316 ms | 42 ms / 45 ms | 47 ms / 96 ms | ok 110 ms / ok 105 ms | ok 3128 ms / ok 3068 ms |
| emulate-input | ok 19 ms / ok 14 ms | ok 42 ms | ok 29 ms / ok 34 ms | ok 1029 ms / ok 1032 ms | ok 1043 ms / ok 1042 ms | 28 ms / 2041 ms | 28 ms / 2040 ms | ok 3111 ms / ok 4107 ms | ok 3039 ms / ok 3053 ms |
| pw-default | ok 56 ms / ok 59 ms | ok 80 ms | ok 24 ms / ok 22 ms | - | ok 2270 ms / ok 2697 ms | 37 ms / 32 ms | 37 ms / 32 ms | FAIL (page.screenshot: Timeout 8000ms exceeded.) | - |
| pw-no-defaults | ok 45 ms | FAIL (page.click: Timeout 8000ms exceeded.) | ok 22 ms / ok 19 ms | - | FAIL (page.click: Timeout 8000ms exceeded.), no frame content | 2026 ms / 2025 ms | 2025 ms / 2024 ms | ok 677 ms / ok 671 ms | - |
| pw-filtered | ok 44 ms / ok 49 ms | FAIL (page.click: Timeout 8000ms exceeded.) | ok 18 ms / ok 23 ms | - | FAIL (page.click: Timeout 8000ms exceeded.), no frame content | 2026 ms / 2028 ms | 2024 ms / 2026 ms | ok 667 ms / ok 670 ms | - |
| pw-window-filtered | ok 69 ms / ok 46 ms | ok 102 ms / ok 107 ms | ok 19 ms / ok 21 ms | - | ok 190 ms / ok 103 ms | 29 ms / 20 ms | 29 ms / 20 ms | ok 89 ms / ok 68 ms | - |
| xfocus-cdp | ok 21 ms / ok 19 ms | ok 671 ms / ok 659 ms | ok 658 ms / ok 656 ms | ok 656 ms / ok 661 ms | ok 904 ms / ok 917 ms | 347 ms | 342 ms / 343 ms | ok 64 ms / ok 65 ms | ok 3072 ms / ok 3049 ms |
| xfocus-xinput | - | ok 605 ms / ok 604 ms | ok 1064 ms / ok 1062 ms | ok 2816 ms / ok 2781 ms | - | 22 ms / 20 ms | 21 ms / 10 ms | - | - |
| window-human-cdp | - | ok 552 ms / ok 548 ms | ok 1446 ms / ok 1453 ms | ok 2485 ms / ok 2462 ms | - | 7 ms / 6 ms | 7 ms / 5 ms | - | - |
| window-keys-inactive | - | ok 74 ms / ok 67 ms | ok 25 ms / ok 31 ms | - | -, no frame content | 31 ms / 20 ms | 31 ms / 35 ms | - | - |

### The input events of the click and the typing
| scenario | moves before the press (with movement) | screen - client at the press | pressure | press ms | type: keydowns for 5 chars, inputType | untrusted | pointer jumps > 100 px | scrolls with no wheel or key | field focus with no press |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| person-front | 20 (19) | [0,143] | 0.5 | 78 / 76 | 5, insertText | 0 | 0 | 0 | 0 |
| person-tab | 20 (20) | [0,87] | 0.5 | 78 / 77 | 5, insertText | 0 | 0 | 0 | 0 |
| person-window | 20 (20) | [0,143] | 0.5 | 75 / 77 | 5, insertText | 0 | 0 | 0 | 0 |
| default | 1 (0) | [0,0] | 0 | 3 / 4 | 0, insertText | 0 | 1 | 3 | 1 |
| hidden-drive | 1 (0) | [0,0] | 0 | 4 | 0, insertText | 0 | 1 | 1 | 1 |
| window | 2 (1) | [0,87] | 0 | 8 / 9 | 0, insertText | 0 | 2 | 1 | 1 |
| window-no-flag | 2 (1) | [0,87] | 0 | 6 / 7 | 0, insertText | 0 | 2 | 1 | 1 |
| window-default | 2 (1) | [0,87] | 0 | 8 / 7 | 0, insertText | 0 | 2 | 1 | 1 |
| window-activate | 2 (1) | [0,87] | 0 | 3 | 0, insertText | 0 | 4 | 1 | 2 |
| activate | 2 (1) | [0,87] | 0 | 4 | 0, insertText | 0 | 3 | 1 | 2 |
| emulate-input | 1 (0) | [0,0] | 0 | 2 / 3 | 0, insertText | 0 | 1 | 1 / 3 | 1 |
| pw-default | 1 (0) | [0,0] | 0.5 | 0 | 0, insertText | 0 | 0 | 0 | 1 |
| pw-no-defaults | 0 (0) | null | - | - | 0, insertText | 0 | 0 | 2 | 1 |
| pw-filtered | 0 (0) | null | - | - | 0, insertText | 0 | 0 | 2 | 1 |
| pw-window-filtered | 2 (1) | [0,87] | 0.5 | 3 | 0, insertText | 0 | 2 | 0 | 1 |
| xfocus-cdp | 2 (1) | [0,87] | 0 | 4 | 0, insertText | 0 | 4 | 1 | 2 |
| xfocus-xinput | 20 (20) | [0,87] | 0.5 | 75 / 76 | 5, insertText | 0 | 0 | 0 | 0 |
| window-human-cdp | 20 (20) | [0,87] | 0.5 | 74 / 73 | 5, insertText | 0 | 0 | 0 | 0 |
| window-keys-inactive | 2 (1) | [0,87] | 0 | 10 / 11 | 0, insertText | 0 | 1 | 0 | 1 |
