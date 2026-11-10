# What a click-box check can measure of input

Board task ab-t30.1, epic ab-t30. Measured on taylor (Linux) on 2026-11-09 (UTC), offline, with local pages
only. No browser in this work opened a public site. The live test on a real site (ab-t30.5) comes last, and only
from the operator's Mac Chrome.

The operator's words on the epic: "cloudflare click boxes ... it needs to be perfect first.... random mouse trails,
real keyboard patterns, etc", and on 2026-11-09: "ideally a consumer writes vanilla playwright and our system
transliates the clicks and types into a human version. i.e. the caller doesn't worry about it", and "don't do this
half baked".

This doc is the ground for the design ab-t30.6 (agent mode turns a vanilla Playwright client's input into a person's
input) and for the builds ab-t30.3 (pointer trails) and ab-t30.4 (keyboard patterns). The folder
[`2026-11-09-click-box-input-signals/`](2026-11-09-click-box-input-signals/) holds the recorder page, the probe, the
analysis and the results (section 10).

## The answer

1. **A click box is a cross-origin frame. It sees only its own part of the input.** It sees the pointer only while the
   pointer is over its 300 x 65 px box: the entry point at the box's edge, the moves inside the box, the press, and
   keys only after it has the focus. It can also read the screen, the top window's position and outer size, the
   pointer media queries, and whether the box is covered (IntersectionObserver v2). The top page sees the rest of the
   path, and it sees a `blur` when the box takes the focus. A check page that the vendor serves as the top page (an
   interstitial) sees all of it. Section 1.
2. **No field of a single event tells CDP input from real X input (XTEST).** `isTrusted`, `pointerId`,
   `pointerType`, `pressure`, `width`, `height`, tilt, `movementX/Y`, the screen offset, the event order, the key codes
   and the `keypress` events are the same. Section 6.
3. **Timing and rate tell them apart by default, and CDP can match both (measured).** On X11 a real event's
   `timeStamp` falls on a whole millisecond: in 100% of the sample gaps (XTEST on Xvfb). CDP events do so in 0% to 75%
   of the gaps, where the check gives about 30% by chance (section 2), and in 100% when the sender sets the
   `timestamp` parameter. X input at 125 Hz gives about 2 samples in each `pointermove` (`getCoalescedEvents()`) and
   1.86 to 2.71 predicted points on average. agent-browser and Playwright give 1 sample and 0 or 1 predicted point,
   because they send about one move a frame. CDP moves that are sent faster coalesce too. NumLock is a third signal
   by inference only (CDP has no NumLock modifier; not measured with NumLock on). Section 6.
4. **Vanilla Playwright input is far from a person's.** A click is one jump to the target (one move), then a press of
   0 to 0.5 ms; the `focus` comes after the `click`, not between the press and the release. `keyboard.type` holds
   each key 1.4 to 2.9 ms and types a key every 2.4 to 5.8 ms, and it types capitals and `!` with no Shift key and
   `shiftKey` false. `fill` gives one `input` event with the whole text and no key events. `mouse.wheel` gives one
   wheel event of 600 px. `scrollIntoViewIfNeeded` and a click below the fold scroll with no wheel.
   `selectOption` and `setInputFiles` give `input` and `change` events with `isTrusted` false, and `dispatchEvent`
   gives an untrusted `click`. `focus`, `selectText`, and `fill`, `pressSequentially`, `type` and `press` into a field
   without the focus give it the focus from a script (a `focusin` with no press). Sections 4.3 and 5.
5. **agent-browser's own input (ab-v16.26) closes the coarse gaps, not the fine ones.** It sends a curved path of 26
   to 58 moves, a press of 73 to 94 ms with `pressure` 0.5, one key at a time and wheel notches. The remaining gaps:
   one sample a frame (a 60 Hz mouse), key holds of 22 to 52 ms (a person: about 116 ms on average), no key overlap
   (a person: about 25% of keys), no Shift key for capitals, and wheel notches of 100 px where Linux gives 120 px.
   Section 4.2.
6. **The relay sees every Playwright input action as plain `Input.*` calls,** after Playwright's own checks in its
   isolated world (section 5). The click's press and release arrive together, before the relay answers the press. A
   click with `modifiers` puts the modifier's key events around them. `fill`, `selectOption`, `setInputFiles`,
   `focus`, `blur`, `selectText`, `dispatchEvent`, and the focus before `pressSequentially`, `type` and `press`,
   arrive as script calls, not input. A click in a cross-origin frame checks the element on the frame's own session
   and sends the input on the top page's session.

The gaps that ab-t30.3, ab-t30.4 and ab-t30.6 must close, and how the harness (ab-t30.2) measures each one, are in
section 7. A person's recordings (part B) are planned in section 8: until they exist, the person column of the table
comes from the literature and the specifications, and says "not measured".

## 1. Where the check runs, and what each place can read

Cloudflare describes two forms: the Turnstile widget in a site's page, and the challenge page. The widget is a frame
of Cloudflare's origin. Its script `api.js` runs in the site's own top page and puts the frame there. The challenge
page is a page that Cloudflare serves in place of the site's page, with its own script. Cloudflare says that Turnstile
runs "a series of small non-interactive JavaScript challenges to gather signals about the visitor or browser
environment" and challenges "for detecting browser-quirks and human behavior" [22, 24]. It also says: "The actual act
of checking a box isn't important, it's the background data we're analyzing while the box is checked that matters"
[23]. Cloudflare does not publish which input signals it reads. So this section lists what a script **can** read in
each place, measured with the recorder's stand-in box: a frame of another origin (`box.localhost`), 300 x 65 px, in
its own renderer process (Chromium lists it as a target of type `iframe`).

| What a script can read | In the top page | In the box (a cross-origin frame) |
| --- | --- | --- |
| Pointer and mouse events | every event over the page, outside the box | only while the pointer is over the box. The box's first event is `pointerover` at its edge (in the path runs: within 7 px of an edge), then its own moves (4 to 16 of the 20 to 40 moves of a path). Its first move has `movementX/Y` 0 |
| While the pointer is in the box | `pointerover` on the frame element, at most one move with the frame as target, then nothing until the pointer leaves | every move, the press and the release |
| `getCoalescedEvents()`, `getPredictedEvents()`, `pointerrawupdate` | yes (secure context) | yes (secure context) |
| Keyboard events | while the top page has the focus | only after the box has the focus (a press in the box; or Tab, not measured) |
| `focus`, `blur`, `document.hasFocus()` | its own; a `blur` of the window when the box takes the focus (measured in each box click) | its own: false until the box has the focus |
| `visibilityState` | yes | yes (the same value as the top page) |
| `screen.*`, `devicePixelRatio`, `matchMedia('(pointer: fine)')`, `(hover: hover)`, `navigator.maxTouchPoints` | yes | yes (the same values) |
| `window.screenX/Y`, `outerWidth/outerHeight` | yes | yes: the top window's values (0 while the frame loads) |
| `innerWidth/innerHeight` | the viewport | the box: 300 x 65 |
| The top page's scroll position and DOM | yes | no |
| `location.ancestorOrigins` | empty | the top page's origin |
| `navigator.keyboard.getLayoutMap()` (the keyboard layout) | yes | no: "getLayoutMap() must be called from a top-level browsing context or allowed by the permission policy" |
| IntersectionObserver v2 (`isVisible`: the box is not covered or faded) | yes | yes; `rootBounds` is null |
| Timer resolution (`performance.now()`, `event.timeStamp`) | 0.1 ms | 0.1 ms |
| A wheel event over the box | no (the page scrolls; the top page sees the `scroll`) | yes (not measured: from the specification of event targets) |

What follows from it: in the widget form, the box's own script sees a short part of the path: 4 to 16 moves and
56 to 242 ms before the press, in the measured paths. A script in the top page (the widget's `api.js`, or the
challenge page's own script) can see the whole path. The build must make both parts right: the long path in the top
page, and the entry, the last moves and the press in the box.

## 2. How it was measured

- **Where.** taylor (Debian 13), Chromium 156.0.8078.79 (`/usr/bin/chromium`), in a private Xvfb (display 168,
  1920 x 1080 x 24, no window manager, its own X authority file). Each scenario starts its own Chromium on a new
  profile (removed at the scenario's end), in a window of 1280 x 1000 at 0,0. The host resolver maps every host but
  `rec.localhost` and `box.localhost` to nothing, and the proxy is a closed local port: no page of the network is
  reachable. Each run held the shared heavy-job lock and the repository's harness guard.
- **The recorder** ([`recorder.html`](2026-11-09-click-box-input-signals/recorder.html)). One self-contained page. It
  logs every input event that a page script can read, in the top page and in its stand-in box, with the event's
  time (`performance.timeOrigin + event.timeStamp`) and the handler's time: pointer events (with
  `getCoalescedEvents()` and `getPredictedEvents()`, their points, and the `pointerrawupdate` count), mouse, click,
  wheel, key, `beforeinput`, `input`, composition, focus, blur, visibility, scroll, drag and change events, each
  frame's time, and the state that a page can query (the media queries, `maxTouchPoints`, the screen and window
  sizes, `navigator.webdriver`, the timer resolution, the keyboard layout map, IntersectionObserver v2). The box is a
  frame of `box.localhost` with a 24 px check box at 16,20 ("Verify you are human").
- **The paths** ([`probe.ts`](2026-11-09-click-box-input-signals/probe.ts)), each in its own Chromium:
  - **xinput**: real X input through the X server with xdotool (XTEST), as a mouse and a keyboard give it. No CDP
    session is attached to the page. A path is one xdotool process with exact sleeps: minimum-jerk speed, a bend,
    and moves at 60 Hz, 125 Hz or as fast as xdotool can (about 400 Hz). The press is held 80 to 100 ms. The keys are
    `xdotool type --delay 120`, a scripted rollover and a scripted Shift. The wheel is button 5 (what a wheel gives on
    X11). These are a script's shapes, not a person's: this path measures what the page sees of real X input.
  - **cdp-raw**: CDP `Input.*` calls of the probe's own: what CDP can and cannot set.
  - **agent-browser**: agent-browser's own commands (`click`, `hover`, `type --into`, `press`, the library's
    `Tab.clickAt` on the box, `click` below the fold) through `cdpUrl`, in a window of its own (ab-v16.26), with the X
    pointer (the method of `src/input.ts`). Another window covers the page first, so the first input brings it
    forward. **agent-browser-no-x**: the same without the X pointer, as over agentwatch's relay.
  - **playwright**: Playwright (playwright-core 1.65.0, installed in a scratch folder, not in `package.json`) with
    `connectOverCDP` to the same kind of bridge, and 30 input actions and one script scroll (section 5).
    **playwright-extra**: 18 more actions and options in the same way (`mouse.dblclick`, modifiers, the right and
    middle buttons, `clickCount`, a locator click's `delay`, `focus`, `blur`, `dispatchEvent`, `selectText`,
    `touchscreen.tap`, the old `locator.type`, and the typing actions into a field without the focus).
- **The transport.** Chromium runs with `--remote-debugging-pipe`. A small bridge serves the pipe as a WebSocket on a
  Unix socket and records every CDP message with its time: this gives the CDP calls of each action (section 5). The
  pipe sets `navigator.webdriver` to true in every page here, also in the xinput runs. That is the probe's transport,
  not input (the earlier report, [`2026-11-05-anti-detect-drive.md`](2026-11-05-anti-detect-drive.md), section 2).
- **The analysis** ([`analyze.ts`](2026-11-09-click-box-input-signals/analyze.ts)) takes the records of each step and
  computes the counts of section 4. It reads a person's saved recording too (part B).
- **The whole-millisecond check.** A gap between two samples counts as a whole millisecond when it is within 0.15 ms
  of a whole number. The page's clock has a step of 0.1 ms, so a gap of a random length passes in about 3 of 10 cases
  (30%) by chance. Read the CDP shares (0% to 75%) against that 30%: CDP times are not on whole milliseconds, but a
  sender whose own timers tick in whole milliseconds pushes the share above chance. 100% for X input is far above
  chance.
- **The runs.** Two final runs (23:15 to 23:17 and 23:17 to 23:19 UTC), about 2 minutes each, after three trial runs
  that fixed the probe. Where the runs differ, a value is a range over both runs. Run 3 (23:54 to 23:55 UTC, after
  the first review) ran `playwright-extra` and the file-mode check once: its values are of one run. The results are in
  `results/`. Two later changes of the page do not change the probe's layout: the box's `z-index` (task 1 of part B
  moves the box over the task area), and task 5's Start button before the box in the Tab order. In probe mode only, the
  page also stops the native context menu of a right click (it would take the X input of the probe's display).

## 3. The signals, path by path

"Person" values come from the sources of section 11 and from the specifications. They are **not measured** here
(part B, section 8, measures them). "Same" means the same value in all measured paths. The table gives the values at a
click, a hover, typing "Hello world, 42!" and the wheel.

| Signal | Person (not measured) | agent-browser, window drive | vanilla Playwright via CDP | xdotool XTEST |
| --- | --- | --- | --- | --- |
| `isTrusted` | true | true | true; but `selectOption` and `setInputFiles` give `input` and `change` with false (2 events each), and `dispatchEvent('click')` gives a `click` with false | true |
| `pointerType`, `pointerId`, `isPrimary` | `mouse`, 1, true (a Mac trackpad in Chrome: not measured) | same | same | same |
| `pressure` down / up | 0.5 / 0 for a mouse [1] | 0.5 / 0 | 0.5 / 0 | 0.5 / 0 |
| `width`, `height`, tilt, `twist`, `tangentialPressure`, `altitudeAngle` | 1, 1, 0, 0, 0, pi/2 [1] | same | same | same |
| `screenX - clientX`, `screenY - clientY` | the content's offset on the screen | [0, 87] (its own window, no info bar) | [0, 143] | [0, 143] |
| Fractional coordinates | integer on X11 at a pixel ratio of 1 (XTEST); the Mac: not measured | 0 (it rounds) | when the element's middle is fractional: 1 of 1 for `check()` and for `mouse.click` at .5 | 0 |
| Moves before a click | a path of many samples | 26 to 58 | 1 (one jump to the target) | as scripted (25 to 40) |
| Pointer jumps (one move of more than 100 px) | 0 | 0 | 1 at each click from another point | 1 only for a scripted jump |
| Samples in each `pointermove` (`getCoalescedEvents()`) | more than 1 when the device reports faster than the frame rate (60 Hz here); the device rate: not measured (part B); "Mice deliver input typically at 100Hz" [7]; a rate of 125 to 1000 Hz: no source | 1 | 1 | 125 Hz: mean 1.85 to 2.0, max 3; about 400 Hz: mean 5.3 to 5.5, max 10; 60 Hz: 1 |
| Predicted points (`getPredictedEvents()`) | not measured | mean 0.8 to 0.95, max 1 or 2 | 0 for a click; 0.85 for `steps` | 125 Hz: mean 1.86 to 2.71, max 3; about 400 Hz: 8; 60 Hz: 0.9 |
| Gap between samples | the device's report interval | 16 to 17 ms | `steps`: 16.4 to 16.9 ms | as scripted: 8 ms (125 Hz), 2 to 3 ms, 17 ms |
| Sample gaps on a whole millisecond (chance: about 30%, section 2) | X11: 100% with XTEST (X server time is in ms); a hardware mouse through Xorg: not measured; the Mac: not measured | 31% to 75% | 16% to 47% | 100% |
| Frame phase: handler time minus event time (`handlerLagMs`), median per step | not measured | 4.1 to 14.8 ms (most steps 10 to 15) | `steps`: 15.0 to 15.3 ms; one move alone: 7.9 to 11.8 ms; a click's move: 0.4 to 1.7 ms (its press dispatches it at once) | 125 Hz: 1.8 to 8.7 ms; 60 Hz: 7.4 to 13.4 ms; about 400 Hz: 2.4 to 2.6 ms |
| Path shape (straightness = chord / length) | curved, bell-shaped speed [17]; 28.6% of human moves above 0.94 [13] | 0.72 to 0.97 (ghost-cursor), deviation 27 to 120 px; 0.98 to 1.0 in the box | 1.0 (`steps`), or one jump | as scripted |
| Speed | at most about 3500 px/s; mean 427 px/s in [13] | peak 0.7 to 2.6 px/ms | `steps` 20: constant, about 2.3 px/ms; a click: one jump | as scripted |
| Pause from the last move to the press | not measured | 96 to 183 ms | 0.1 to 0.6 ms | as scripted (134 to 175 ms) |
| Press (`pointerdown` to `pointerup`) | not measured | 73 to 94 ms | 0 to 0.5 ms (`delay` sets it: 82 to 84 ms with 80) | as scripted; `xdotool click`: 0 ms |
| `focus` at a click | between `mousedown` and `pointerup` | same as a person | after the `click` | between `mousedown` and `pointerup` |
| The box: where the pointer enters it | its edge | its edge (x 0 to 6 in box px), then 7 to 10 moves | at the check box itself (29,33), 1 move, no entry | its edge (3,15), then 16 moves |
| Key events for a typed character | `keydown`, `keypress`, `beforeinput`, `input`, `keyup` [3] | same | same for `type` and `pressSequentially`; none for `fill` and `insertText` | same |
| Key hold (`keydown` to `keyup`) | mean 116 ms, SD 24 [19] | 22 to 52 ms (median 35 to 38) | 1.4 to 2.9 ms; with `delay: 100`: 102 to 103 ms | `xdotool type`: 30 to 31 ms |
| `keydown` to the next `keydown` | mean 239 ms, SD 112; fast typists about 120 ms [19] | 90 to 148 ms (median 106 to 128) | 2.4 to 5.8 ms; with `delay: 100`: 104 to 105 ms | `xdotool type`: 60 to 61 ms |
| Key overlap (rollover) | 25% of keys on average, 50% for fast typists [19] | 0 | 0 | 0 for `type`; 1 when scripted |
| Shift for capitals and symbols | a Shift `keydown` (location 1 or 2) before, `shiftKey` true | no Shift `keydown`; `shiftKey` true (2 of 2) | `type`: no Shift `keydown`, `shiftKey` false (2 of 2); `press('Shift+A')`: a Shift `keydown` | a Shift `keydown`, `shiftKey` true (2 of 2) |
| `key`, `code`, `keyCode`, `which`, `location` of a character | consistent with the layout | same | same | same |
| `repeat`, `isComposing` | true when a key is held; true with an IME | false | false | false |
| `getModifierState('NumLock')` | the keyboard's state | false (measured; with NumLock on, inferred: CDP has no NumLock modifier) | false (the same) | the X server's state (off on this Xvfb) |
| Text with no key events | none (except paste and IME) | none, except characters with no US key | `fill`, `insertText`: one `input` with the whole text (16 characters) | none |
| A field gets the focus with no press | no | 0 | 1 for each of `fill`, `pressSequentially`, `type`, `press`, `focus` and `selectText` on a field without the focus | 0 |
| Modifiers at a click | a modifier key held from before the press to after the release | not measured (no modifier click) | `click({ modifiers })`: the modifier's `keydown`, then the click with the modifier flag, then its `keyup`, 6 ms in all | not measured |
| Other buttons and clicks | `contextmenu` and `auxclick` for the right button, `auxclick` for the middle one | not measured | the right button: `pointerdown`, `mousedown`, `contextmenu`, `pointerup`, `mouseup`, `auxclick`; the middle one: the same without `contextmenu`; `clickCount: 3` and `dblclick`: 3 and 2 clicks 0.1 ms apart | not measured |
| Wheel notch on X11 | `deltaY` 120, `wheelDeltaY` -120, `deltaMode` 0 (measured with XTEST button 5); a Mac trackpad: many small deltas (not measured) | `deltaY` 100, `wheelDeltaY` -120, 20 notches, gaps 35 to 86 ms (median 55 to 65 ms) | `mouse.wheel(0, 600)`: one event, `deltaY` 600, `wheelDeltaY` -120 | `deltaY` 120, `wheelDeltaY` -120 |
| A scroll with no wheel or key | no | 0 | 1 for `scrollIntoViewIfNeeded` and for a click below the fold | 0 |
| Drag | pointer moves with the button down, then the drop | not measured (no drag command) | one move with the button down; `dragstart`, `pointercancel`, `dragend`; the drop goes by `Input.dispatchDragEvent` | not measured |
| Event time later than the handler's time (raw CDP with a `timestamp` in the future: every event, 12 to 304 ms later, median 123 and 130 ms in the two runs) | never | never | never | never |
| The page's own state (`pointer: fine`, `hover`, `maxTouchPoints` 0) | the machine's | same in all paths (the Chromium and Xvfb of the run) | same | same |

## 4. What each path shows

### 4.1 xdotool XTEST: real X input

- Every field of the events is the default of a mouse and a keyboard (section 3). The events have the X server's
  timestamps: each sample gap is a whole number of milliseconds (100% of the gaps, all steps, both runs).
- The X server reports each move at once. At 125 Hz, Chromium puts about 2 samples into each `pointermove` (mean 1.85
  to 2.0, max 3), with 1.86 to 2.71 predicted points. At about 400 Hz: 5.3 to 5.5 samples (max 10) and 8 predicted
  points. At 60 Hz: 1 sample and 0.9 predicted points. `pointerrawupdate` comes once for each sample.
- The press: as scripted (80 to 101 ms). The `focus` comes between `mousedown` and `pointerup`. `xdotool click`
  gives a press of 0 ms, and `xdotool type` gives a fixed rhythm (a hold of 30 to 31 ms, a key every 60 to 61 ms),
  with a Shift key for each capital and for `!`.
- The wheel: one wheel event of `deltaY` 120 and `wheelDeltaY` -120 for each notch, `deltaMode` 0.

### 4.2 agent-browser, window drive (ab-v16.26)

- Click, hover and clickAt: a ghost-cursor path of 26 to 58 moves in about 0.4 to 1.1 s, at 60 Hz (gaps 16 to 17
  ms), straightness 0.72 to 0.97, peak 0.7 to 2.6 px/ms. A pause of 96 to 183 ms, then a press of 73 to 94 ms with
  `pressure` 0.5. The `focus` comes between the press and the release, as for a person. No pointer jump, with and
  without the X pointer.
- Each `pointermove` has 1 sample and 0 or 1 predicted point. 31% to 75% of the sample gaps fall on a whole
  millisecond (chance: about 30%), where real X input gives 100%. The handler time minus the event time has a
  median of 10 to 15 ms in most steps: each move comes just after a frame (gap P8).
- In the box: the path enters at the box's edge and makes 7 to 10 moves inside it. Those last moves are almost
  straight (straightness 0.98 to 1.0, deviation 0.3 to 2 px): the end of ghost-cursor's curve.
- `type --into`: a click on the field, then one key at a time: hold 22 to 52 ms (32 of 34 holds below 50 ms in each
  run), a key every 90 to 148 ms, no overlap. The two capitals ("H", "!") have `shiftKey` true but no Shift `keydown`.
- The wheel: notches of `deltaY` 100 with `wheelDeltaY` -120, 35 to 86 ms apart (median 55 to 65 ms; the setting is
  30 to 70 ms plus the time of each call). Real X11 wheel notches are `deltaY` 120 with `wheelDeltaY` -120, so a
  notch of 100 px differs from a Linux wheel. Other platforms' notch sizes: not measured, no source here.
- With the X pointer and without it: the same, except the last move of each path, which is a real X move when
  agent-browser has the X pointer.

### 4.3 Vanilla Playwright via CDP

- A click (`page.click`, `locator.click`, `dblclick`, `check`, `setChecked`, the box through `frameLocator`, a click
  below the fold): one `mouseMoved` straight to the element's middle, then `mousePressed` and `mouseReleased` sent
  together. The page sees one move (a jump of more than 100 px from the last point), a press of 0 to 0.5 ms, and the
  `focus` after the `click`. In the box, the pointer appears at the check box with a `pointerover` and one move: no
  entry at the edge.
- `hover` and `mouse.move(x, y)`: one move. `mouse.move(x, y, { steps: 20 })`: 20 moves on a straight line at a
  constant speed, one each frame (16 to 17 ms apart).
- `keyboard.type` and `pressSequentially`: a key every 2.4 to 5.8 ms, each held 1.4 to 2.9 ms. With `delay: 100`:
  hold 102 to 103 ms and a key every 104 to 105 ms, the same each time. Capitals and `!` come with no Shift and `shiftKey`
  false. The Playwright documentation says the same: "Modifier keys DO NOT effect keyboard.type" [26].
- `fill` and `insertText`: one `beforeinput` and one `input` with the whole text, no key events. A `fill` into a field
  that does not have the focus gives it the focus from a script (a `focusin` with no press). So do
  `pressSequentially`, the old `type`, `press`, `focus` and `selectText` (run 3: 1 `focusin` with no press for each).
  `blur` takes the focus away from a script.
- `selectOption` and `setInputFiles`: no input at all; the page gets `input` and `change` events with `isTrusted`
  false. `dispatchEvent('click')`: one `click` with `isTrusted` false and no pointer events.
- Modifiers (`click({ modifiers: ['Shift'] })`, `dblclick({ modifiers: ['Alt'] })`): the modifier's `keydown`, the
  click's events with the modifier flag, then the modifier's `keyup`, 6 ms after the `keydown`.
- The right and middle buttons: `contextmenu` (right only) and `auxclick`, with a press of 0.1 ms. `clickCount: 3`,
  `dblclick` and `mouse.dblclick`: two or three clicks 0.1 ms apart (a person's double click: not measured). A locator
  click with `delay: 80`: a press of 83.6 ms.
- `mouse.wheel(0, 600)`: one wheel event of 600 px. `scrollIntoViewIfNeeded` and the scroll before a click below the
  fold: a scroll with no wheel.
- `tap`: refused ("The page does not support tap. Use hasTouch context option to enable touch support.").
  `touchscreen.tap`: refused too ("hasTouch must be enabled on the browser context before using the touchscreen.").
- Fractional points: Playwright clicks the middle of the element's box, so a box of an odd size gives `x.5`
  coordinates in the pointer events (X11 gives whole pixels).

### 4.4 CDP calls of our own: what CDP can set

- `Input.dispatchMouseEvent` with `tiltX`, `tiltY`, `twist` and `tangentialPressure` gives those values to the page,
  also with `pointerType` "mouse": a mouse with a tilt, which a real mouse never has. `pointerType: "pen"` gives a pen
  with `pointerId` 2 and the `force` as `pressure`.
- Fractional `x` and `y` reach the pointer events (5 of 5); the mouse events get whole numbers.
- Moves that are awaited one by one take one frame each (33 ms with a 16 ms sleep): 1 sample and 0 predicted points.
  Moves that are sent without waiting coalesce: 40 moves in 50 ms gave 22 to 23 `pointermove` events with 1.7 to 1.8
  samples each (max 3) and 7 to 9 predicted points.
- The `timestamp` parameter sets `event.timeStamp`: moves with timestamps 8 ms apart gave sample gaps of 7.9 to 8.1
  ms (100% on a whole millisecond). Sent all at once with times up to 312 ms in the future, every `pointermove`
  (10 and 19 in the two runs) reached its handler before its own `timeStamp`: 12 to 304 ms before, median 123 and
  130 ms. A page can see an event from the future.
- A Shift `rawKeyDown` with location 1, a `keyDown` with `modifiers` 8, and the two `keyUp` give a person's capital.
  Two overlapping key pairs give a rollover. `autoRepeat` gives `repeat` true. So CDP can make every key signal of
  section 3 except NumLock and CapsLock.
- A `mouseWheel` gives any `deltaY`, but `wheelDeltaY` is always -120 or 120 (for 100, 53, 120, -273 and 600).

## 5. Playwright's CDP calls for each input action (what the relay sees)

Playwright 1.65.0 through the bridge, run 1 (`results/run-1-cdp.json` has every call with its time and parameters).
"U" is a `Runtime.callFunctionOn` into Playwright's utility world (an isolated world that Playwright makes at the
connection with `Page.createIsolatedWorld`). The page does not see those calls, but it sees what they do.

| Action | CDP calls, in order |
| --- | --- |
| `page.click`, `locator.click` | U x5 (find the element; wait until it is visible, enabled and stable over two frames: 20 to 31 ms), `DOM.scrollIntoViewIfNeeded`, `DOM.getContentQuads`, U (`innerWidth`, `innerHeight`), U (`setupHitTargetInterceptor`), `mouseMoved {x, y, button: none, buttons: 0, force: 0}`, `mousePressed {button: left, buttons: 1, clickCount: 1, force: 0.5}`, `mouseReleased {clickCount: 1}`, U (the hit-target check), `Page.enable` |
| `dblclick` | the same, with `mousePressed`/`mouseReleased` with `clickCount` 1, then 2 |
| `click({ clickCount: 3 })` | the same, with three press-and-release pairs, `clickCount` 1, 2 and 3 (run 3) |
| `click({ modifiers: ['Shift'] })`, `dblclick({ modifiers: ['Alt'] })` | the click's checks, then `rawKeyDown {key: Shift, code: ShiftLeft, location: 1, modifiers: 8}` (Alt: `modifiers: 1`), the move, the press and the release with the same `modifiers`, then the modifier's `keyUp` (run 3) |
| `click({ button: 'right' })`, `click({ button: 'middle' })` | the click's calls with `button: right, buttons: 2` or `button: middle, buttons: 4` (run 3) |
| `click({ delay: 80 })` (locator) | the click's calls, with the delay between `mousePressed` and `mouseReleased` (run 3: a press of 83.6 ms) |
| `page.mouse.dblclick(x, y)` | `mouseMoved`, then two press-and-release pairs, `clickCount` 1 and 2, with no checks (run 3) |
| `check`, `setChecked` | the same as a click, with two more U calls before (the state) and after (the new state) |
| `hover` | the same as a click up to `mouseMoved`, no press |
| `frameLocator(...).locator(...).click()` | the element's checks (U, `DOM.scrollIntoViewIfNeeded`, `DOM.getContentQuads`: 14 calls) on the box frame's own CDP session (the frame is a target of its own); the frame's owner and box on the top page's session (`DOM.getFrameOwner`, `DOM.getBoxModel`, `DOM.resolveNode`, `DOM.describeNode`); then the move, the press and the release on the top page's session, in top-page coordinates |
| `mouse.move(x, y)` | one `mouseMoved` |
| `mouse.move(x, y, { steps: n })` | n `mouseMoved` on a straight line, each one awaited |
| `mouse.down()`, `mouse.up()` | `mousePressed`, `mouseReleased` at the last point |
| `mouse.click(x, y)` | `mouseMoved`, `mousePressed`, `mouseReleased`; with `delay`, a wait between the last two |
| `mouse.wheel(dx, dy)` | one `mouseWheel {x, y, deltaX, deltaY}` at the last point |
| `keyboard.type`, `pressSequentially` | (`pressSequentially`: U x5 first; into a field without the focus, the last U calls the element's `focus()`: run 3) then for each character `keyDown {key, code, windowsVirtualKeyCode, text, unmodifiedText, modifiers: 0, location: 0, autoRepeat: false, isKeypad: false, commands: []}` and `keyUp`; a capital is `key: "H", text: "H", modifiers: 0`. Characters with no key in Playwright's US layout go as `Input.insertText` [26] |
| `press('Enter')` (locator) | U x5 (into a field without the focus, the last U calls its `focus()`: run 3), `keyDown {key: Enter, text: "\r"}`, `keyUp` |
| `keyboard.press('Shift+A')`, `down('Shift')` | `rawKeyDown {key: Shift, code: ShiftLeft, location: 1, modifiers: 8}`, `keyDown {key: A, text: A, modifiers: 8}`, `keyUp A`, `keyUp Shift` |
| `fill`, `clear` | U x5 (focus, select all), then `Input.insertText {text}`; `clear`: `rawKeyDown Delete`, `keyUp Delete` |
| `keyboard.insertText` | `Input.insertText` |
| `selectOption`, `setInputFiles` | U calls only: the page's own events come from a script (`isTrusted` false) |
| `dragTo` | the click's checks on both elements, `mouseMoved` and `mousePressed` at the source, `Input.setInterceptDrags {enabled: true}`, one `mouseMoved {buttons: 1}` to the target, `Input.setInterceptDrags {enabled: false}`, `Input.dispatchDragEvent` `dragEnter` and `drop`. No `mouseReleased`: the drop takes its place |
| `scrollIntoViewIfNeeded` | U and `DOM` calls, then `DOM.scrollIntoViewIfNeeded` |
| `focus`, `blur` | U calls only: the element's `focus()` or `blur()` in the utility world (run 3) |
| `selectText` | U, `DOM.describeNode` and `DOM.resolveNode` calls only: the focus and the selection come from a script (run 3) |
| `dispatchEvent('click')` | `Runtime.evaluate` x2 and one U: the event comes from a script (run 3) |
| `locator.type` (the old name) | as `pressSequentially`: U x4, U (`focus`), then `keyDown` and `keyUp` for each character (run 3) |
| `tap`, `touchscreen.tap` | none: refused without `hasTouch` (run 3 for `touchscreen.tap`) |

What it means for the relay (ab-t30.6):

- Each pointer action reaches the relay as raw `Input.dispatchMouseEvent` calls with page coordinates. The relay does
  not get the element; it gets the point. The press and the release of a click are sent together: the release
  arrives before the relay answers the press, so the relay must keep the order and put the hold time between them.
- Playwright's checks run before the input (actionability, the hit-target interceptor set up just before the move)
  and after it (the interceptor's result). A translated click must end with the press and the release on the
  point that Playwright chose, or the hit-target check fails.
- `scrollIntoViewIfNeeded`, `fill`, `selectOption`, `setInputFiles`, `focus`, `blur`, `selectText` and `dispatchEvent`
  do not reach the relay as input at all: they are `DOM.*`, `Runtime.*` or `Input.insertText` calls. The focus of
  `pressSequentially`, `type` and `press` into a field without the focus is a `Runtime.callFunctionOn` too, before
  the keys.
- A click with `modifiers` sends the modifier's key events around the mouse events: the relay must keep that order
  and hold the modifier for the whole translated click.
- A click in a cross-origin frame uses two sessions: the frame's own session for the element's checks, and the top
  page's session for the input. The relay must route the sessions of cross-origin frames (Playwright attaches to
  them itself), and it must translate the input on the top page's session, where the points are top-page points.
- `dragTo` ends with `Input.dispatchDragEvent` `drop` and no `mouseReleased`: a translated drag must keep the drop
  as its end.

## 6. Can a page tell CDP input from XTEST input?

Measured in the same Chromium, in the same kind of window, for the same steps:

- **The same in both:** `isTrusted`, `pointerType`, `pointerId`, `isPrimary`, `pressure`, `width`, `height`, tilt,
  `twist`, `altitudeAngle`, `azimuthAngle`, `sourceCapabilities` (null in both), the screen offset, `movementX/Y`
  (it matched the change of the screen point in every move of every path), the boundary events, the order of
  `pointerdown`, `mousedown`, `focus`, `pointerup`, `mouseup`, `click`, the key events and their `key`, `code`,
  `keyCode`, `which`, `location` and `keypress`. No field of one event tells them apart.
- **The timestamps.** X11 events carry the X server's time, in milliseconds: every sample gap was a whole millisecond
  (XTEST on Xvfb; a hardware mouse through Xorg and libinput: not measured). CDP events carry the time when Chromium
  got the call: 0% to 75% of the gaps were whole milliseconds, against about 30% by chance (section 2). CDP's
  `timestamp` parameter makes them whole (100%, measured). A time in the future is a new signal (section 4.4). The
  Mac's event times: not measured, so the rule is per platform.
- **The rate.** The number of samples and predicted points in each `pointermove` follows the rate of the sender:
  X input at 125 Hz gave about 2 samples a frame, at about 400 Hz 5.3 to 5.5 (max 10); one awaited CDP call a frame
  gives 1. A faster mouse gives more (extrapolated, not measured: xdotool reached about 400 Hz). CDP calls sent
  without waiting coalesce too (measured), so the rate is the sender's choice, not the source's.
- **The phase of the times against the frames.** One awaited CDP move a frame arrives just after a frame and waits
  almost a whole frame (handler time minus event time, median: 15.5 to 15.8 ms for the probe's awaited moves, 10 to
  15 ms in most of agent-browser's steps). Real moves at 125 Hz gave 1.8 to 8.7 ms. But real moves at 60 Hz gave 7.4
  and 13.4 ms in the two runs, near the CDP values: the phase depends on the rate, so it is a signal of a low rate
  more than of CDP. A sender that does not wait for each answer, at a device's rate, removes it (gap P8).
- **NumLock and CapsLock.** CDP has no modifier for them, so `getModifierState('NumLock')` is false for CDP keys
  (inferred from the CDP modifier list). Real keys carry the X server's state. It was off on this Xvfb, so the runs
  show no difference; NumLock on was not measured.
- **The X pointer.** XTEST moves the real pointer; CDP does not. When Chrome brings a window forward, the page gets
  a real event at the X pointer (the earlier report, section 5). agent-browser handles it; a relay must too.

So a page can tell them apart by timing and rate (measured), and perhaps by NumLock (inferred), not by fields; CDP
can match the timing and the rate (measured). The design
ab-t30.6 can keep CDP as the source if it sets `timestamp`, sends at a device's rate without waiting for each answer,
and keeps NumLock and the X pointer in mind. Real X input through the daemon gives the timestamps and the X pointer for
free, but only on Linux, one input at a time for the display, and never on the Mac.

## 7. Gaps for ab-t30.3, ab-t30.4 and ab-t30.6

Each gap names the signal, what agent input shows today, the target, and how the scoring harness (ab-t30.2)
measures it against a person's recordings (section 8). The harness can compute every count of `analyze.ts` from the
recorder's records.

### ab-t30.3: pointer trails

| # | Signal | Today (agent-browser) | Target | Harness measure |
| --- | --- | --- | --- | --- |
| P1 | Report rate: samples per `pointermove` and predicted points | 60 Hz: 1 sample, 0 or 1 predicted point | the person's device rate (part B measures it; [7] says "typically at 100Hz"; 125 to 1000 Hz: no source) | the distributions of `nc` and `np`, and of the sample gaps, against the person's |
| P2 | Sample times | 31% to 75% on a whole millisecond (chance: about 30%) | whole milliseconds on Linux (X11); the Mac's pattern from part B; never later than the handler's time | the share of whole-millisecond gaps; the count of events with a time after the handler's time |
| P3 | Path shape | ghost-cursor: straightness 0.72 to 0.97, 0.4 to 1.1 s for each measured path (its settings: a Fitts time of 300 to 1000 ms, and an overshoot for a move over 500 px) | a person's curvature, speed profile, sub-movements and end corrections; a person's spread, not one model | straightness, maximum deviation, peak and mean speed, duration against Fitts's index of difficulty, the number of speed peaks; distance between distributions (for example a Kolmogorov-Smirnov statistic) |
| P4 | The end of the path in the box | 7 to 10 moves inside the box, almost straight (0.98 to 1.0) | a person's approach to a 24 px target in a 300 x 65 box | the box frame's own view: entry point, moves inside, straightness, time from entry to press |
| P5 | Pause before the press, and the press | pause 96 to 183 ms, press 73 to 94 ms (uniform, fixed ranges) | the person's distributions (part B) | the pause and press distributions |
| P6 | The pointer between commands | no movement at all between commands | a person's idle hand (part B: task 6 measures it) | moves per second between steps; time from the page's load to the first move |
| P7 | Wheel | notches of 100 px with `wheelDeltaY` -120, 35 to 86 ms apart (median 55 to 65 ms) | the platform's notch (X11: 120 px, measured) or the Mac trackpad's small deltas (part B) | `deltaY` values, `wheelDeltaY / deltaY`, gaps between wheel events, wheel events per scroll |
| P8 | Frame phase: handler time minus event time | median 10 to 15 ms in most steps (4.1 to 14.8): one move just after each frame | a person's phase at the person's rate (X input at 125 Hz: 1.8 to 8.7 ms; at 60 Hz: 7.4 to 13.4 ms) | `handlerLagMs` (`analyze.ts`): its distribution per step against the person's, read together with P1's rate |

### ab-t30.4: keyboard patterns

| # | Signal | Today (agent-browser) | Target | Harness measure |
| --- | --- | --- | --- | --- |
| K1 | Key hold | 22 to 52 ms; 32 of 34 holds (94%) below 50 ms in each run, where 5.82% of human keystrokes are below 0.05 s [13] | about 116 ms on average, SD 24 [19], per key | the hold distribution, per key and overall |
| K2 | Time between keys | 90 to 148 ms, uniform | about 239 ms on average (SD 112), per letter pair, longer at word and line ends [19, 20] | the down-to-down distribution, per digraph; pauses at spaces and punctuation |
| K3 | Rollover | 0 | about 25% of keys overlap the next on average [19] | the share of keys whose `keydown` comes before the last key's `keyup` |
| K4 | Shift | capitals with `shiftKey` true and no Shift `keydown` | a Shift `keydown` (location 1 or 2) before the key, its `keyup` after; CDP can do it (measured) | the share of shifted characters with a Shift `keydown` before them |
| K5 | Corrections | none | a person's typing errors and Backspace (part B) | Backspace per 100 characters |
| K6 | NumLock and CapsLock | off in the runs; always off with CDP (inferred: CDP has no modifier for them) | the platform's normal state | `getModifierState` values |

### ab-t30.6: the relay translates vanilla Playwright

| # | Playwright action | What the page sees today | What the relay must do | Harness measure |
| --- | --- | --- | --- | --- |
| R1 | click, dblclick, check, setChecked, hover, frame clicks | one jump, a press of 0 to 0.5 ms, `focus` after `click`, entry at the target | turn `mouseMoved` into a path from the page's last point (P1 to P4), hold the release 70 to 120 ms (P5), keep the order, answer each call after its events, and end on Playwright's point | the click metrics of P1 to P5; `focus` between press and release; the box entry |
| R2 | `mouse.move`, `steps` | one jump, or a straight line at a constant speed | a path, as R1 | as P3 |
| R3 | `keyboard.type`, `pressSequentially`, the old `type`, `press` | hold 1.4 to 2.9 ms, a key every 2.4 to 5.8 ms, capitals with no Shift and `shiftKey` false; into a field without the focus, a focus from a script first (a `focusin` with no press: 1 for each, run 3) | a person's timing (K1 to K3), a Shift `keydown` and `modifiers` 8 for shifted characters (K4); a click on the field in place of the script's focus (as `src/input.ts` does for `type --into`) | as K1 to K4; `focusin` with no press: 0 |
| R4 | `fill`, `insertText`, `clear` | one `input` with the whole text, no keys; a focus from a script | the design decides where typed keys can stand in for inserted text (not for a date input, a value with no US key, or a contenteditable that the page handles itself) | key events per character; `focusin` with no press |
| R5 | `mouse.wheel` | one wheel event of 600 px | notches of the platform's size at a person's rate (P7) | as P7 |
| R6 | `scrollIntoViewIfNeeded`, the scroll before a click below the fold | a scroll with no wheel (`DOM.scrollIntoViewIfNeeded`) | answer the call with wheel notches that bring the element into view, as `src/input.ts` does | scrolls with no wheel or key: 0 |
| R7 | `selectOption`, `setInputFiles` | script events with `isTrusted` false; no input | the design decides: for example a click and keys for a `select`, a click that opens the file chooser for a file input (as `setFiles` does) | untrusted events: 0 |
| R8 | `dragTo` | one move with the button down; the drop by protocol | a path with the button down at a person's rate | moves with `buttons` 1 between `pointerdown` and the drop |
| R9 | all pointer actions | `x.5` points from element middles | whole device pixels on Linux; the Mac's pattern from part B | fractional coordinate count |
| R10 | all input | CDP times, one call a frame | the `timestamp` parameter at the real send time, rounded to a whole millisecond on Linux (P2), never in the future; moves sent without waiting for each answer, at the device rate (P1, P8) | as P1, P2 and P8 |
| R11 | all input | the X pointer stays where it was | the X pointer at each activation (the earlier report, section 5; ab-v16.71) | pointer jumps at an activation: 0 |
| R12 | `tap`, `touchscreen.tap` | refused (no touch) | nothing: a desktop page has no touch | none |
| R13 | click options: `modifiers`, `button: 'right'` and `'middle'`, `clickCount`, `delay`; `mouse.dblclick` | the modifier key 6 ms around the click; two or three clicks 0.1 ms apart; `delay` gives an exact hold | keep the modifier key from before the path's last part to after the release, at a person's timing; space the clicks of a double or triple click as a person does (part B: not measured yet); keep each button's events | modifier hold around the press; the gap between the clicks of a double click; `contextmenu` and `auxclick` present |
| R14 | `focus`, `blur`, `selectText` | a focus or a blur from a script (`focus`, `selectText`: a `focusin` with no press); `selectText` selects from a script | the design decides: a click on the element in place of `focus` and `selectText` (and keys such as Shift+Home for a selection), or the call goes through and the signal stays | `focusin` with no press: 0 |
| R15 | `dispatchEvent` | an event with `isTrusted` false, from a script; no input reaches the relay | nothing can make a script's event trusted; the design decides whether the relay turns a `dispatchEvent('click')` into a click, or lets it go through as it is | untrusted events: 0 |

## 8. Part B: a person's recordings (plan; not run)

A person moves, clicks and types on the recorder page: the operator, at the Mac, in Google Chrome. It runs later,
through the manager, when the operator is at the Mac, under the Mac rules. No agent runs anything on the Mac for it.

**What the operator does** (about 8 minutes; 12 with the second device):

1. Get `recorder.html` from the repository (or from the manager) and open it in Chrome as a file (drag it onto a
   Chrome window). Use a normal window at its normal size and zoom. The page uses no network.
2. In "Device", choose the device: trackpad or mouse.
3. Run the tasks in order. Each task button shows its steps in the dashed area:
   - **1 Click box** (about 1.5 minutes): 10 times, click "Start", then tick the box's square, which appears at a new
     place each time.
   - **2 Targets** (about 1 minute): click 20 blue dots of 16 to 64 px.
   - **3 Typing** (about 2 minutes): type three lines into the text field, each followed by Enter: "The quick brown fox
     jumps over the lazy dog.", "Meet me at 10:45 on Friday, OK?", "jane.doe@example.com". Type as usual, and correct
     mistakes as usual.
   - **4 Scroll** (about 1 minute): twice, scroll down to "Far button" and click it, then scroll up and click "Back at
     top".
   - **5 Keys to box** (about 30 s): twice, click "Start" (it appears right of the box), press Tab once, and the box's
     square has a focus ring; then press Space. The page puts "Start" just before the box in its Tab order and gives
     it the focus at the click, so one Tab reaches the square. If the ring is not on the square, press Tab again. If
     Tab never reaches it (a macOS or Chrome keyboard-navigation setting can stop Tab at buttons and check boxes; not
     checked on the Mac), go to task 6: the recording keeps what came before.
   - **6 Rest** (10 s): keep the hand on the device and keep still.
   - **7 Switch away** (about 15 s): switch to another app or tab, wait about 3 s, come back, click "Button".
4. Press "Save JSON". Chrome saves `input-recording-<device>-<time>.json` in Downloads.
5. If the operator uses both a trackpad and a mouse: choose the other device, run tasks 1, 2 and 4 again, and save
   again.

**What the page saves:** every record of section 2 (pointer, mouse, key, wheel, text, focus, visibility, scroll and
drag events with their times; the coalesced and predicted points; each frame's time), a record at the start and end
of each task and trial (with the target's place), the state of both frames (the user agent, the platform, the screen,
the window's place and size, the media queries, the timer resolution, the keyboard layout's answer), the device, and
the save time. The keys are only those typed into the page while it has the focus: the three task lines, Tab, Space
and Enter. The file also holds the name of any file chosen in the page's file input (no task uses it).

**Checked on taylor** (`probe.ts --only file-mode`): the page opened as a file, task 1 and task 5 by X input, "Save
JSON", and `analyze.ts` on the saved file. Run 3 (23:55 UTC) ran all 10 trials of task 1 and 2 rounds of task 5
(one Tab, then Space): the file held 2081 records (568 from the box) with 12 checks of the box, and the analysis gave
one step for each of the 12 trials. The first check (two trials of task 1, 23:27 UTC) found that the task area
covered the moved box; the fix is in the committed page.

**How the results join this doc:**

1. The operator (or the manager) sends the JSON file to taylor. It goes into a folder of its own in the agent's home
   on taylor, outside every checkout (for example `~/research-data/ab-t30/`), never into a repository. The
   repository's `.gitignore` also refuses `input-recording-*.json`.
2. An agent runs `node docs/research/2026-11-09-click-box-input-signals/analyze.ts <file> --numbers <out>`, with the
   output in the same folder: each trial is a step. `--numbers` keeps only the step metrics. `--summary` also copies
   the state record (user agent, platform, screen, window place) and the change values, so its file is never
   committed as it is.
3. The person column of section 3 gets selected numbers (medians, ranges, distributions) in place of "not
   measured", and section 7's targets get the person's distributions. A follow-up commit updates this doc with those
   numbers only.
4. The harness (ab-t30.2) takes the person's records as its reference distributions, from the folder of step 1.
5. The raw file stays out of the public repository: it holds the operator's own typing and pointing rhythm.

## 9. What this did not measure

- A person's input (part B, section 8): every "person" value in section 3 comes from a source, not from a run.
- The Mac: its event times, its trackpad (deltas, momentum, `pointerType`), fractional points on a Retina screen, and
  Google Chrome stable. Only Chromium 156 on Linux ran.
- The relay with the extension's `chrome.debugger` (agent mode's real transport): the probe drove Chromium through a
  pipe. The `Input` domain is the same; the relay's own handling is not measured.
- A real window manager, a hardware mouse through Xorg and libinput (only XTEST on Xvfb ran), a mouse faster than
  about 400 Hz (the rate that xdotool reached), and NumLock on.
- The box's frame type in part B: there the box is a sandboxed `srcdoc` frame with an opaque origin, in the page's
  own file. In the probe it is a cross-site frame (`box.localhost`) in its own renderer process, as a real click box
  is. Its process, and so its event timing, can differ in part B on the Mac.
- What Cloudflare's scripts read: this doc lists what a script can read in each place, not what one does.
- Touch, pen and IME input from a person; `dragTo` against a page that accepts the drop.
- agent-browser's `setFiles` and `record` (not input actions of a click box).
- Playwright options that the probe did not trace, with their expected CDP path (from the traced actions and [26]):
  `click({ trial: true })` (the checks only, no `Input` call: nothing for the relay to translate); `click({ force:
  true })` (no actionability checks, the same `Input` calls: the relay translates them as R1); `click({ position })`
  (the same calls at another point: as R1); `hover({ modifiers })` (the modifier's key events around one
  `mouseMoved`: as R13); `keyboard.type` of a character with no key in Playwright's US layout (`Input.insertText`
  [26]: as R4); `mouse.wheel` with a `deltaX` (one `mouseWheel` with `deltaX`: as R5).

## 10. Reproduce

On a Linux box with Xvfb, xdotool and Chromium, under the box's heavy-job lock:

```sh
npm ci
mkdir -p /tmp/pw && (cd /tmp/pw && npm init -y >/dev/null && npm install --ignore-scripts playwright-core@1.65.0)
node docs/research/2026-11-09-click-box-input-signals/probe.ts --out-dir /tmp/click-box --playwright /tmp/pw [--display 168] [--only xinput,cdp-raw,agent-browser,agent-browser-no-x,playwright,playwright-extra,file-mode]
node docs/research/2026-11-09-click-box-input-signals/analyze.ts /tmp/click-box/run-*/results.json --summary summary.json --traces cdp.json [--numbers numbers.json]
```

The probe takes the harness guard (one harness at a time, nothing left after its end), refuses a reserved display,
ends only its own processes by their pids, and removes each scenario's profile. A run takes about 2 minutes. The
folder holds:

- `recorder.html`: the recorder page (part A's probe page and part B's page).
- `probe.ts`: the probe (part A), and with `--only file-mode` the check of part B's use of the page.
- `analyze.ts`: the analysis of a probe run or of a person's recording.
- `results/run-1.json`: run 1's records, marks and CDP requests (the Chromium events of the trace are left out).
- `results/run-1-summary.json`, `results/run-2-summary.json`: the metrics of each step of each run.
- `results/run-1-cdp.json`: the CDP calls of each step of run 1, with their times and parameters (long strings cut).
- `results/run-3.json`, `results/run-3-summary.json`, `results/run-3-cdp.json`: run 3 (`playwright-extra`) in the same
  forms.

## 11. Sources

Read over HTTP with a fetch tool; no browser opened them. No dataset and no code of these sources is used here.

Specifications:

1. Pointer Events Level 3, W3C Recommendation (P. H. Lauke, R. Flack, eds.). https://www.w3.org/TR/pointerevents3/ .
   A mouse's `pressure` "MUST be 0.5 when in the active buttons state and 0 otherwise"; `width` and `height` default to
   1; tilt and twist 0, `altitudeAngle` pi/2; `pointerrawupdate` only in a secure context; coordinates are `double`.
2. Pointer Events, Editor's Draft. https://w3c.github.io/pointerevents/ . `getCoalescedEvents()` gives "the raw,
   un-coalesced position changes"; predicted events let an app "draw ahead".
3. UI Events, W3C Working Draft (X. Wu, ed.). https://www.w3.org/TR/uievents/ . Key event order (`keydown`,
   `beforeinput`, `input`, `keyup`), `repeat`, `isComposing`, `location`.
4. UI Events split drafts: Keyboard Events and Wheel Events. https://w3c.github.io/uievents/split/keyboard-events.html ,
   https://w3c.github.io/uievents/split/wheel-events.html . `deltaMode` 0 is pixels.
5. UI Events KeyboardEvent code Values and key Values. https://www.w3.org/TR/uievents-code/ ,
   https://www.w3.org/TR/uievents-key/ .
6. High Resolution Time. https://www.w3.org/TR/hr-time-3/ . A resolution of 100 microseconds, 5 when cross-origin
   isolated.

Chrome and Chromium:

7. D. Tapuska, "Aligning Input Events with Frame Updates", Chrome for Developers.
   https://developer.chrome.com/blog/aligning-input-events . Continuous events (`pointermove`, `mousemove`, `wheel`)
   are dispatched "right before the requestAnimationFrame() callback"; "Mice deliver input typically at 100Hz".
8. E. Ge, "Intent to Ship: getPredictedEvents", blink-dev, 2019.
   https://groups.google.com/a/chromium.org/g/blink-dev/c/emvtXAXtqWs
9. M. Ahmed, "Intent to Ship: pointerrawupdate only in secure contexts", blink-dev, 2025.
   https://groups.google.com/a/chromium.org/g/blink-dev/c/KLXAD2tozQY
10. M. Ahmed, "PSA: coalesced and predicted events in untrusted PointerEvents", blink-dev, 2024.
    https://groups.google.com/a/chromium.org/g/blink-dev/c/5UbeICCy4wY
11. Y. Weiss, E. Kitamura, "Aligning timers with cross origin isolation restrictions", Chrome for Developers.
    https://developer.chrome.com/blog/cross-origin-isolated-hr-timers
12. Chrome DevTools Protocol, Input domain. https://chromedevtools.github.io/devtools-protocol/tot/Input/ (the
    protocol source: https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Input.pdl).
    `timestamp`: "Time at which the event occurred", UTC seconds; `force`, `tangentialPressure`, `tiltX`, `tiltY`,
    `twist`, `pointerType` (`mouse`, `pen`); `dispatchKeyEvent` `type` (`keyDown`, `keyUp`, `rawKeyDown`, `char`),
    `autoRepeat`, `location`, `commands`; `insertText`.

Mouse and keyboard behaviour, and bot detection:

13. Z. Chu, S. Gianvecchio, A. Koehl, H. Wang, S. Jajodia, "Blog or block: Detecting blog bots through behavioral
    biometrics", Computer Networks 57 (2013). https://www.eecis.udel.edu/~hnw/paper/comnet13.pdf . "Point-and-Click: A
    point followed by a click within 0.4 s"; bot mean speed 1520.83 px/s against 427.43 for people, "human speed is
    limited within 3500 pixels per second"; "59.23% of bot movements achieve efficiency greater than 0.94, while only
    28.60% of human movements"; "21.49% of bot keystrokes are less than 0.05 second, and only 5.82% of human".
14. A. Acien, A. Morales, J. Fierrez, R. Vera-Rodriguez, "BeCAPTCHA-Mouse: Synthetic mouse trajectories and improved
    bot detection", Pattern Recognition 127 (2022). https://arxiv.org/abs/2005.00890 . 93% accuracy from one
    trajectory; features: duration, distance, displacement, angle, velocity, efficiency; the Sigma-Lognormal model.
15. C. Iliou et al., "Detection of Advanced Web Bots by Combining Web Logs with Mouse Behavioural Biometrics", Digital
    Threats: Research and Practice 2(3) (2021). https://zenodo.org/record/5549439 (abstract only).
16. A. A. E. Ahmed, I. Traore, "A New Biometric Technology Based on Mouse Dynamics", IEEE TDSC 4(3) (2007),
    doi:10.1109/TDSC.2007.70207 (abstract only).
17. T. Flash, N. Hogan, "The coordination of arm movements: an experimentally confirmed mathematical model", J.
    Neurosci. 5(7) (1985) (the Europe PMC record). Point-to-point motions are "approximately straight with bell-shaped
    tangential velocity profiles".
18. I. S. MacKenzie, "Fitts' Law as a Research and Design Tool in Human-Computer Interaction", HCI 7 (1992).
    https://www.yorku.ca/mack/hci1992.pdf
19. V. Dhakal, A. M. Feit, P. O. Kristensson, A. Oulasvirta, "Observations on Typing from 136 Million Keystrokes", CHI
    2018. https://www.pokristensson.com/pubs/DhakalEtAlCHI2018.pdf . Inter-key interval 238.656 ms on average (SD
    111.6), about 120 ms for fast typists; key hold 116.24 ms (SD 23.88); rollover 25% on average (SD 17), 49.9% for
    fast typists and 7.6% for slow ones.
20. A. M. Feit, D. Weir, A. Oulasvirta, "How We Type", CHI 2016.
    https://userinterfaces.aalto.fi/how-we-type/resources/HowWeType_CHI16.pdf . 34 to 79 WPM; inter-key interval 168.91
    to 176.39 ms on average.
21. K. S. Killourhy, R. A. Maxion, "Comparing Anomaly-Detection Algorithms for Keystroke Dynamics", DSN 2009.
    https://www.cs.cmu.edu/~keystroke/ . Hold, down-down and up-down times; up-down "can be negative" (overlap).

Cloudflare:

22. Cloudflare blog, "Announcing Turnstile, a user-friendly, privacy-preserving alternative to CAPTCHA" (2022).
    https://blog.cloudflare.com/turnstile-private-captcha-alternative/ . "proof-of-work, proof-of-space, probing for
    web APIs, and various other challenges for detecting browser-quirks and human behavior."
23. Cloudflare blog, "Cloudflare is free of CAPTCHAs; Turnstile is free for everyone" (2023).
    https://blog.cloudflare.com/turnstile-ga/ . "Bots definitely can check a box, and they can even mimic the erratic
    path of human mouse movement while doing so." "The actual act of checking a box isn't important, it's the
    background data we're analyzing while the box is checked that matters."
24. Cloudflare docs: Turnstile overview, widget types, challenge pages. https://developers.cloudflare.com/turnstile/ ,
    https://developers.cloudflare.com/turnstile/concepts/widget/ ,
    https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/ . Managed mode "chooses
    between non-interactive or checkbox challenge based on visitor risk level".
25. Cloudflare blog, "Private Access Tokens: eliminating CAPTCHAs on iPhones and Macs with open standards" (2022).
    https://blog.cloudflare.com/eliminating-captchas-on-iphones-and-macs-using-new-standard/

Playwright:

26. Playwright API: Mouse and Keyboard. https://playwright.dev/docs/api/class-mouse ,
    https://playwright.dev/docs/api/class-keyboard . Click `delay` "Defaults to 0"; move `steps` "Defaults to 1";
    "Modifier keys DO NOT effect keyboard.type"; `insertText` "Dispatches only input event".

Left out: vendor blog posts that say CDP mouse events "arrive with an empty or trivial coalesced list". They are not
primary sources, and section 4.4 measured the opposite for CDP moves that are sent fast. The full texts of [15] and
[16] were not readable, so only their abstracts are used.
