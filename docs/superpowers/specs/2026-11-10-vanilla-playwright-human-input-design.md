# Vanilla Playwright input becomes a person's input in agent mode — design

**Status: proposed. It waits for a fresh read-only review and for the operator's answers to Q1 to Q4
(section 15). Nothing is built before that.**

Date: 2026-11-10. Author: a taylor contributor, a design subagent of the lead (board task ab-t30.6, epic
ab-t30). Branch `ab-t30.6-input-translation-design` in agent-browser, from main `d0e8acf`. No product code
changes in this task.

Sources:

- the input research of ab-t30.1
  ([2026-11-09-click-box-input-signals.md](../../research/2026-11-09-click-box-input-signals.md), "the
  research" below): its signal table (section 3), the Playwright CDP traces (section 5), the gaps P1 to P8,
  K1 to K6 and R1 to R15 (section 7), and what it did not measure (section 9);
- the self-contained agent browser design
  ([2026-11-09-self-contained-agent-browser-design.md](2026-11-09-self-contained-agent-browser-design.md),
  "the service design"), sections 5, 5.5 and 8;
- the agent pointer design ([2026-11-06-agent-pointer-move-design.md](2026-11-06-agent-pointer-move-design.md));
- agent-browser main `d0e8acf`: `src/input.ts`, `src/record.ts`, `src/relay/` (the model, `pointer.ts`);
- the earlier research [2026-11-05-anti-detect-drive.md](../../research/2026-11-05-anti-detect-drive.md);
- chrome-extension main `66078cd`, `docs/protocol.md` (C10, C11);
- the code of `playwright-core` 1.65.0 and `@playwright/mcp` 0.0.85 (read in a scratch folder, not added
  to `package.json`).

Evidence: the probe in
[2026-11-10-vanilla-playwright-human-input-probe/](2026-11-10-vanilla-playwright-human-input-probe/README.md)
(section 17). It ran on taylor with a private Xvfb, its own Chromium and local pages only. No browser in this
work opened a public site.

## 1. The answer in short

1. **One input stage in the service (section 4).** It runs between the model's per-tab gate and the
   bridge, at the plug point of the service design (section 5.5). Every client of agent mode goes through
   it: vanilla Playwright, the Playwright MCP inside the service, and agent-browser's own CLI over the agent
   door. The client sets nothing. The stage keeps what each call asks for (the point, the button, the keys,
   the text, the element to scroll to). It changes how the call reaches the page: a curved path from the
   page's last point, a pause, a press of a person's length, keys with a person's holds, gaps, rollover and
   a real Shift key, and wheel notches. Where Playwright uses a script effect that a person cannot make (its
   focus call, a protocol scroll), the stage uses the person's way when that gives the same result.
2. **Every input path is in one table (section 5).** For each Playwright call: the CDP calls that the model
   sees, what the stage sends, and what the page sees. The page's result is the same as with Playwright's
   own input.
3. **Playwright's checks keep working (section 6).** A click's hit-target check reads the press, so a path
   that crosses other elements does not matter. A hover's check reads the first move, so the stage plays a
   hover's path before Playwright sets the check up. Measured (section 17): 8 of 8 translated clicks
   passed the check at the first try, in each of two runs; a hover with the path after the setup needed a
   retry, and a page listener then got 73 `pointermove` and 0 `mousemove` events. Each answer comes after
   its events. A translated click from a far point took 1.0 to 1.6 s, and 2.6 s with a scroll of 17
   notches, inside Playwright's 30 s default. The service sets its own MCP's action timeout to 30 s (its
   default is 5 s).
4. **Text (section 7).** For `fill` and `insertText` into a text field, typed keys take the place of the
   inserted text when every character has a key on the US layout and the typing plan fits in 10 s (about 40
   to 80 characters). Else the text goes as Playwright sends it (Q2). A date, color or range input gets no
   input at all from Playwright (a script sets it). A contenteditable keeps the inserted text, because a
   page's editor can change typed text.
5. **Scrolling (section 8).** Wheel notches of 120 px (X11) for `mouse.wheel` and in place of
   `DOM.scrollIntoViewIfNeeded`. On the Mac the wheel waits for part B (ab-t30.7).
6. **The source (section 9): CDP input on every platform**, with a `timestamp` in whole milliseconds a few
   ms before the send (Linux), sent at a mouse's rate (125 Hz) without a wait for each answer. Measured
   against real X input (XTEST) on the same paths (M1): the same samples per `pointermove` (1.7 to 1.9
   against 1.9 to 2.0), 100% whole-ms gaps in both, the same frame phase (5.4 to 5.6 ms against 2.3 to
   8.1 ms), and no event from the future. One difference stays: 2.3 to 2.8 predicted points against 1.8 to
   2.1. Real X input stays only for the X pointer at an activation (the agent pointer design). The Mac: CDP
   only, and never the operator's own pointer.
7. **One generator (sections 10 and 11).** A pure, seeded module (`src/human/`) plans paths, presses, keys
   and notches. A CDP player and an X player send the plans. The stage and agent-browser's own commands
   (`src/input.ts`) use the same generator. Until part B records the operator, the parameters come from the
   literature; a script then fits them from part B's numbers.
8. **Contracts (section 12).** C11 gets a new section, "The input stage", and three changed rules. C10 and
   C4 do not change. The text is named against chrome-extension `docs/protocol.md` at `66078cd`.
9. **Tests (section 13).** Every row of the table runs with real Playwright (two pinned versions) against
   local pages and the research's recorder. The harness (ab-t30.2) scores each gap. Each rule has a mutation
   that turns a test red.
10. **Build tasks (section 14)** in order: the harness, the pointer model, the keyboard model, the stage in
    three parts, the contract text, then the part B parameters. **Four questions** for the operator
    (section 15).

## 2. The operator's words

- 2026-11-05, on the epic: "add a new epic. cloudflare click boxes. you can test this on forum.bearchive.com
  only when everything else is done on the agentbrowser. it needs to be perfect first.... random mouse
  trails, real keyboard patterns, etc"
- 2026-11-05: "only test from mac chrome. don't try on the datacenter IP"
- 2026-11-09: "ok, don't do this half baked. ideally a consumer writes vanilla playwright and our system
  transliates the clicks and types into a human version. i.e. the caller doesn't worry about it"
- 2026-11-09, on the service: "so let's build a single self-contained process/wrapper that includes the
  relay/browser/extension/etc and everything communicates over that."

What this design takes from them:

- "the caller doesn't worry about it": no client option, no new API, no setting in the client. The stage
  is on for every client of agent mode.
- "don't do this half baked": every Playwright input path has a row in section 5, with its translation or
  the reason that none is possible. No part of the stage ships before the whole table is covered.
- "it needs to be perfect first": the live test (ab-t30.5) comes after the builds, the harness and part B's
  parameters (section 14).
- "random mouse trails, real keyboard patterns": the models of section 10.

## 3. Words

- **The stage**: the input stage of this design, a part of the model.
- **The model**: the browser model (`src/relay/model.ts`), today in the relay, after the service design's
  stage 1 in the service.
- **A client call**: one CDP message of a client (Playwright, the MCP, the CLI).
- **A translated action**: the events that the stage sends for one or more client calls that belong
  together, for example the move, the press and the release of one click.
- **A plan**: the list of timed events that the generator makes for one translated action.
- **The generator**: the code that makes plans. It has no I/O and no clock of its own.
- **A player**: the code that sends a plan's events: the CDP player (all platforms) or the X player (Linux,
  the activation path only).
- **The page's last point**: the point of the last pointer event that the page got, in the page's CSS px.
- **A held answer**: an answer of a client call that the stage sends only after the events of that call.
- **An early answer**: an answer of a key release that the stage sends before it sends the release (section
  4.5).
- **A utility call**: a `Runtime.callFunctionOn` of Playwright's utility script. Its fourth argument holds
  the text of Playwright's function (section 5.2).
- **A recognizer**: a rule of the stage that finds one kind of utility call by its function text.
- **A person**: the parameters of one simulated person (speeds, spreads). Each scope gets its own person
  (section 10.4).
- **Part A**, **part B**: the research's own runs (part A, done) and the operator's recordings at the Mac
  (part B, board ab-t30.7, not run yet).

## 4. Where the stage runs and how it works

### 4.1 The place

```
 client CDP call --> agent door --> model.onMessage --> the tab's gate --> THE STAGE --> bridge --> receiver --> chrome.debugger
                                     (refusals, scopes)    (order)          |  reads: the page's last point, its geometry,
                                                                            |         the focused element, element boxes
                                                                            |  plays: CDP plans (all platforms)
                                                                            |  calls: the X player at an activation (Linux)
                                                                            +-- one input lock for the agent browser
```

The stage is a module of the model (`src/relay/stage.ts`), so it works in today's relay and in the service
with no change. The model's refusals (policy.ts) run first: the stage sees only calls that the model sends
to Chrome. The stage needs only facts that the model already has, or that it reads with its own calls on
the tab's session in its own isolated world (as the geometry read does).

### 4.2 Which calls the stage takes

On a page session of a tab (not on a child session of a frame or a worker), the stage takes these calls:

- `Input.dispatchMouseEvent` (all types), `Input.dispatchKeyEvent`, `Input.insertText`;
- `Input.dispatchDragEvent` while a drag of the stage runs (section 5, `dragTo`);
- `DOM.scrollIntoViewIfNeeded`;
- the utility calls of its recognizers (section 5.2).

It passes every other call to the bridge as today. It also passes each of these calls unchanged when one of
its own rules says so (section 4.7). On a child session of a frame, the stage takes only the recognized
utility calls (the hover check of a frame, section 5.3) and `DOM.scrollIntoViewIfNeeded` (section 8.3).
Playwright sends the input of a frame on the top page's session (the research, section 5), so the stage
plays it there.

### 4.3 The gate and the order

The model already orders a tab's calls through the tab's gate (C11, "the order and the limit"). The stage
is a step of that gate:

- A tab's calls reach Chrome in the client's order. A call that comes after an input call waits until the
  stage has sent the events of that input. So a `Runtime.evaluate` after a click sees the page after the
  click.
- The stage's own reads (an element's box, the focused element) go to Chrome inside the step. A client
  never sees them.
- An ordinary call that the stage passes leaves the gate when the model sends it, not when Chrome answers
  (today's rule). A dialog can still get its `Page.handleJavaScriptDialog`.

### 4.4 The one input lock

A person has one hand on the mouse and one keyboard. The operator chose one input lock for all pages of the
agent browser (board ab-v16.46, after ab-1bi). Today `src/input.ts` holds it as a file (`input.lock`) for
agent-browser's own commands. The stage holds the same rule in memory:

- A translated action holds the lock from its first event to its last. A pointer action is a path, its
  press and its release. A key run is the keys of one tab with no other call between them; it ends at the
  tab's next call that is not a key, or 1 s after its last key.
- Another tab's input waits for the lock, in order of arrival. Its later calls wait behind it in its own
  gate.
- With one window per page (Linux), the activation step of C11 already runs one at a time. The lock adds
  the rest of the action (the path, the hold, the keys), so that no page gets input while another page's
  action runs.
- In the service, agent-browser's CLI commands reach Chrome through the agent door and the stage, so they
  share the lock. `input.lock` stays only for agent-browser's own direct mode (its own Chrome, no agent
  door).
- A lock hold has a limit, `STAGE_ACTION_MAX_MS` (first value 25 s; section 6.3). At the limit the stage
  sends the rest of the action at once and logs it.

### 4.5 Answers

- **A held answer for each call.** The stage answers a client call after it has sent that call's events and
  Chrome has answered them: a move after the last move of its path, a press after the pause and the press,
  a release after the hold and the release, a wheel call after its last notch, a key press after the key's
  `keyDown`. Playwright sends a click's move, press and release together (`Promise.all`; the research,
  section 5). So the release arrives before the press is answered, and the stage keeps the order.
- **The early answer of a key release.** Playwright's `keyboard.type` sends each key's press and release
  and waits for each answer. Rollover needs the next key's press before this key's release. So the stage
  answers a release before it sends it when its plan says that the next key can overlap (section 10.2). The
  release then goes at its planned time. Every later call of the tab that is not a key press waits until
  the release has gone.
- **No answer before its events in any other case.** A client can trust an answer: the page has the
  events.
- **The error of an event.** When Chrome refuses an event of a plan, the stage stops the plan, answers the
  client call with that error, and sends no more events of the plan. When the plan held a button or a key,
  the stage sends its release first.

### 4.6 The clock, the timestamps and the rate

- Each event that the stage sends has a CDP `timestamp` a person's input latency before its send time:
  `(Date.now() - latency) / 1000`, in whole milliseconds on Linux, where X11 event times are whole
  milliseconds (the research, section 6). The latency is a first value of 3 to 5 ms (the time from a
  device to the browser; part B measures the operator's frame phase). The time comes from the send, never
  from the plan, so no event has a time in the future (the research, section 4.4, measured events from the
  future with planned times). Measured (M1): with the send time itself, the frame phase (handler time minus
  event time) was 1.2 to 1.5 ms, below XTEST's 2.3 to 8.1 ms; 4 ms before the send gave 5.4 to 5.6 ms.
- On the Mac the stage sends the time with its fraction (`performance.timeOrigin + performance.now()`),
  because the Mac's event times are not measured (part B).
- Pointer moves go at the person's device rate (first value 125 Hz: 8 ms apart), each move sent at its
  time without a wait for the answer of the move before it. Chromium then puts the moves of one frame into
  one `pointermove` with their samples (`getCoalescedEvents()`), as for a real mouse (the research, section
  4.4; probe M1).
- At most `STAGE_MOVES_IN_FLIGHT` (first value 8) moves of a tab are without an answer. When a move is due
  while 8 wait (a page with an open dialog, a busy renderer), the stage stops the path, sends the client's
  own event, and logs it. This is C11's catch-up rule (`CATCH_UP_MAX_UNANSWERED`) for paths at a device
  rate.
- The stage rounds each point to a whole CSS px on Linux, as X11 gives them (R9). Playwright's points can
  have a fraction (the middle of an element of an odd size).

### 4.7 When the stage passes a call unchanged

The stage sends a call as the client sent it, with the stage's timestamp and in the gate's order, in these
cases, and the harness counts them:

- a call of a kind that the table of section 5 does not name (for example `Input.synthesizeTapGesture`, or
  `Input.dispatchTouchEvent` from a client that enabled touch itself);
- a utility call that no recognizer knows (a Playwright version with other internal names: section 5.2);
- a text that the typing rule of section 7 refuses (Q2);
- a script call that a person cannot make, by Q3's answer;
- a wheel or a scroll on the Mac until part B (section 8.5);
- a drag event of a drag that the stage did not start.

## 5. Every input path

### 5.1 The table

"U" is a utility call. The CDP column comes from the research's traces (Playwright 1.65.0, section 5 and
`results/run-1-cdp.json`, `results/run-3-cdp.json`), checked against the code of `playwright-core` 1.65.0.
"The path" is a path of the pointer model (section 10.1) from the page's last point to the named point, at
the device rate, with whole-ms timestamps. "A press" is the pause before a press, a `mousePressed` with
`force` 0.5, a hold, and a `mouseReleased` (section 10.1). "Measured" names a probe step of section 17.

| Playwright call | CDP that the model sees | What the model sends (its stage) | What the page sees (the result is the same as Playwright's own) |
| --- | --- | --- | --- |
| `locator.click()`, `page.click()` | U x5 (find, visible, enabled, stable), `DOM.scrollIntoViewIfNeeded`, `DOM.getContentQuads`, U (viewport size), U (`setupHitTargetInterceptor`, action `mouse`), then together `mouseMoved`, `mousePressed`, `mouseReleased`, then U (the check's stop) | notches in place of the protocol scroll when the element is out of view (section 8); the path to Playwright's point (whole px); a press there; the answers held | a curved path with many samples per frame, entry at the edges of the elements on the way, a pause, a press of about 100 ms, the `focus` between `mousedown` and `pointerup`, the `click` on the element. Playwright's check passes (measured: M3) |
| `dblclick()`, `mouse.dblclick()` | as a click, with two press-and-release pairs (`clickCount` 1 and 2) | the path; a press; a person's gap (first value 90 to 150 ms from the release); the second press with `clickCount` 2 | two clicks with a person's gap, then `dblclick` (measured: M3) |
| `click({ clickCount: 3 })` | three pairs (`clickCount` 1, 2, 3) | as `dblclick`, three presses | three clicks with a person's gaps |
| `click({ button: 'right' })`, `'middle'` | the click's calls with `button: right, buttons: 2` or `middle, 4` | as a click, with the client's button | `contextmenu` (right) and `auxclick`, after a press of a person's length |
| `click({ delay })`, `mouse.click(x, y, { delay })` | the move, the press, Playwright's own wait, the release (each awaited) | the path; a press; the release at the later of Playwright's release and the press time plus a person's hold | a hold of at least the client's delay |
| `click({ modifiers })`, `hover({ modifiers })` | the modifier's `rawKeyDown` (`modifiers` 1, 2, 4 or 8) before the move, the move and the press with the flag, the modifier's `keyUp` after (the research, R13) | the modifier key 40 to 120 ms before the path's end; the path and the press with the flag; the modifier's release 60 to 200 ms after the release | a modifier held from before the press to after the release (measured: M3, Shift) |
| `click({ position })`, `click({ force })` | the same input at another point; with `force`, no checks before it | as a click | as a click |
| `click({ trial })` | the checks only, no `Input` call | nothing | nothing (Playwright's own trial) |
| `click({ steps })` (new in 1.65), `mouse.move(x, y, { steps })` | n `mouseMoved` on a straight line, each one awaited, then for a click the press | each short move (at most 50 px from the last point) as samples at the device rate at a person's speed (0.5 to 1.5 px/ms) with 0 to 1 px of jitter across the line; a longer move as a path | the client's line at a person's speed and rate, not 20 jumps one frame apart |
| `locator.hover()` | as a click up to the move, with U (`setupHitTargetInterceptor`, action `hover`, with the hit point); then one `mouseMoved`; no press | the path to the hit point **before** the stage sends the check's setup; then Playwright's move, which is at the pointer's point, gets its answer with no event | a path that ends on the element, no move after it; Playwright's check passes (measured: M4) |
| `mouse.move(x, y)` | one `mouseMoved` | the path (a short move as in the `steps` row) | a path |
| `mouse.down()`, `mouse.up()` | `mousePressed`, `mouseReleased` at the last point | a pause when the press follows a path; the press; the release at the later of its arrival and a person's hold | a press of a person's length |
| `mouse.click(x, y)` | `mouseMoved`, `mousePressed`, `mouseReleased`, no checks | the path; a press | as a click |
| `mouse.wheel(dx, dy)` | one `mouseWheel` at the last point | notches of 120 px with a person's gaps (section 8.2) | wheel events of `deltaY` 120 and `wheelDeltaY` -120, as a Linux mouse wheel (measured: M6) |
| `locator.scrollIntoViewIfNeeded()`, the scroll of an action | U and `DOM` calls, then `DOM.scrollIntoViewIfNeeded` | notches until the element is in view, then the answer `{}` (section 8.3) | wheel events and the scroll that they cause; no scroll with no wheel (measured: M6) |
| `check()`, `setChecked()`, `uncheck()` | as a click, with a state read before and after | as a click | as a click; Playwright reads the new state (measured: M3) |
| frame clicks: `frameLocator(...).locator(...).click()` | the element's checks on the frame's own session; the frame's owner and box on the top page's session; the move, the press and the release on the top page's session, in top-page points | as a click, on the top page's session | the top page sees the path up to the frame; the frame sees the entry at its edge, its own moves, the press (measured: M3) |
| frame hovers | the hover's setup on the frame's session, with the hit point in the frame's own points | the stage maps the hit point to the top page (section 5.3), then as `hover` | as `hover` (designed; not measured) |
| `tap()`, `touchscreen.tap()` | nothing: Playwright refuses without `hasTouch`, and a context from `connectOverCDP` has none | nothing | nothing (R12) |
| `keyboard.type(text)`, `pressSequentially(text)`, the old `type()` | `pressSequentially` and `type`: U x5, then U (`focusNode` with the caret reset) when the field has no focus; then for each character a `keyDown` with its text (a capital: `modifiers` 0) and a `keyUp`, each awaited; a character with no US key: `Input.insertText` | for the focus call: a click on the field when it does not have the focus (section 5.2); for each key: a person's timing (section 10.2), a Shift `rawKeyDown` before a shifted character and its release after, the release answered early for rollover; an `insertText` with a person's gap before it | the field gets the focus from a press; keys with a person's holds and gaps, about 25% overlap, a Shift key for each capital and symbol; the same text (measured: M5) |
| `press(key)` (locator), `keyboard.press(key)`, `keyboard.down()`, `keyboard.up()` | U x5 and U (`focusNode`) for the locator; then the chord's `rawKeyDown` events, the key, and the releases in reverse order | the focus click as above; the chord with a person's timing: each modifier 40 to 120 ms before the key, the key's hold, the releases 20 to 80 ms apart | a person's chord; the same effect |
| `fill(text)`, `clear()` | U x5 (`fill`: the state checks, then the focus and the select-all by script), then `Input.insertText` with the whole text; `clear`: `rawKeyDown Delete` and `keyUp` | a click on the field when it has no focus, before the U call; typed keys in place of the `insertText` when section 7's rule allows it, else the text as it is; `clear`: the Delete key with a person's hold | typed keys (measured: M5), or one `input` with the whole text above the limit (Q2) |
| `fill()` of a date, time, month, week, color or range input | U only: a script sets the value and sends `input` and `change` with `isTrusted` false | nothing reaches the stage as input; the U call passes | the script's events (Q3) |
| `keyboard.insertText(text)` | `Input.insertText` | as `fill`'s text (section 7) | typed keys or the inserted text |
| `selectOption()` | U only: a script selects and sends `input` and `change` (`isTrusted` false) | the U call passes, or by Q3 | the script's events (Q3) |
| `setInputFiles(paths)` with a local browser | U, then `DOM.setFileInputFiles` | a click on the input with the file chooser intercepted (`Page.setInterceptFileChooserDialog`, as `src/input.ts` `setFiles`), then the client's files to the input that the chooser names | a click on the input, then `input` and `change` from the browser |
| `setInputFiles(payloads)` (a remote client, or buffers) | U only: a script makes the files and sends untrusted `input` and `change` | the U call passes, or by Q3 | the script's events (Q3) |
| `dragTo(target)` | the click's checks on both elements; `mouseMoved` and `mousePressed` at the source; `Input.setInterceptDrags {enabled: true}`; one `mouseMoved {buttons: 1}` to the target; `setInterceptDrags {enabled: false}`; `Input.dispatchDragEvent` `dragEnter`; `drop` | the path to the source; a press; a person's wait before the drag (100 to 300 ms); for the move with the button down: a short path with the button down until Chrome reports `Input.dragIntercepted`, then the rest of the path to the target as `dispatchDragEvent` `dragOver` events at the device rate; the client's `dragEnter` at the pointer's point gets its answer with no event; a pause before the `drop` | `dragstart`, drag events along a path, the drop at the target (designed; not measured: the research measured no page that accepts the drop) |
| `locator.drop(payload)` (new in 1.65) | a script in the page's main world makes `dragenter`, `dragover`, `drop` with `isTrusted` false | the call passes, or by Q3 | the script's events (Q3) |
| `focus()` | U (`focusNode`, no caret reset) | on a text field (an input of a text type, a textarea, a contenteditable): a click, then the U call; on another element: the U call passes, or by Q3 | a focus from a press, or from a script (Q3) |
| `blur()` | U (`blurNode`) | the U call passes, or by Q3 | a blur from a script (Q3) |
| `selectText()` | U (`selectText`) | on an input or a textarea: a click on it and the select-all chord (Control+A, on the Mac Meta+A), then the U call; on another element: the U call passes, or by Q3 | a selection made with keys, or from a script (Q3) |
| `dispatchEvent(type)` | `Runtime.evaluate` and U: a script's event (`isTrusted` false) | the call passes, or by Q3 (R15) | the script's event |

### 5.2 Playwright's utility calls and the recognizers

Playwright runs its element code in a utility world of its own. Each call is a `Runtime.callFunctionOn` of
`(utilityScript, ...args) => utilityScript.evaluate(...args)`. Its arguments are, in order: the utility
script, two flags, the text of Playwright's function, the count of arguments, Playwright's serialized
argument, and then the handles (measured in the research's trace and read in `playwright-core` 1.65.0,
`serializeAsCallArgument`). The serialized argument holds a string, a number or a boolean as itself,
`undefined` and `null` as `{"v": ...}`, a handle as `{"h": <index into the handles>}`, an array as
`{"a": [...]}`, and an object as `{"o": [{"k": key, "v": value}]}`. So the stage can read the node and the
values of a call with no code of its own in the page. (The probe's first run read numbers and strings in
another form, `{"n": ...}` and `{"s": ...}`, so its hover recognizer missed every call; the second run
fixed it. A test of the decoder against captured calls is part of the build: section 13.1.)

C11 already has one recognizer of this kind: `PLAYWRIGHT_FOCUS`, which finds `injected.focusNode(...)` for
the activation (C11, "Playwright's focus call"). The stage adds these:

| Recognizer | The function text (Playwright 1.65.0) | What the stage reads | What the stage does first |
| --- | --- | --- | --- |
| hover check | `([injected, node, { actionType, hitPoint, trial }]) => injected.setupHitTargetInterceptor(...)` | `actionType`, `hitPoint` | for `hover`: the path to the hit point (section 6.2) |
| focus | `([injected, node, resetSelectionIfNotFocused]) => injected.focusNode(...)` | the node | a click on a text field that does not have the focus (section 5.4) |
| fill | `async ([injected, node, { value, force, frameVisible }]) => { ... injected.fill(node, value) }` | the node | a click on the field when it does not have the focus |
| select text | `... injected.selectText(node)` | the node | for an input or a textarea: a click and the select-all chord |
| retry scroll | `([injected, node, options]) => { ... node.scrollIntoView({ ...options, behavior: "instant" }) ... }` | the node | nothing in the first build: it comes only in a retry (section 6.5) |
| blur, select option, set files, drop | `injected.blurNode`, `injected.selectOptions`, `injected.setInputFiles`, the drop's script | the node | by Q3 |

The rules of a recognizer:

- It matches the whole function text with a pattern that names Playwright's internal names, as
  `PLAYWRIGHT_FOCUS` does. A text that only contains the name (a client's own function) does not match.
- A test pins the function texts of each Playwright version that the tests run (section 13.1). A new
  Playwright version with other texts makes that test fail, so a release can add the new texts.
- A call that no recognizer matches passes unchanged (section 4.7). Then the page sees Playwright's script
  effect for that one call, at a person's timing for the input around it. The harness counts it. No
  client's action fails because of it.
- The stage never answers a utility call itself and never changes its arguments. It only puts its own
  input before the call.

### 5.3 A hover in a frame

Playwright sends a frame element's hover check on the frame's own session, with the hit point in the
frame's points, and the move on the top page's session (the research, section 5). The stage maps the hit
point to the top page before it plays the path:

1. It finds the frame's owner element on the parent's session (`DOM.getFrameOwner` with the frame's id).
2. It reads the owner's content box (`DOM.getContentQuads`).
3. The top page's point is the content box's corner plus the frame's point, for each frame level up to the
   top page.

When a read fails or the frame has a transform (the quad is not a rectangle), the stage plays no path
before the check, and the hover goes as the naive way of M4 (a retry of Playwright's, and the check blocks
the path's `mousemove` events). The harness counts it. This is designed, not measured.

### 5.4 The focus click

Playwright gives a field the focus by a script before `pressSequentially`, `type`, `press` and `fill`, when
the field does not have it (the research, run 3: a `focusin` with no press for each). A person clicks the
field. The stage does the same, by the rules of `src/input.ts` `focusField`:

- The stage reads the node's state with one call in Playwright's utility world on the node's own handle:
  whether it has the focus, its kind, and the length of its text. A field with the focus gets no click.
- The click goes where the script focus puts the caret: the left end of an input with text (Playwright's
  caret reset puts the caret at 0), else any point of the middle 40%. When the caret is not where the script
  focus would put it after the click, the stage sends Home (an input) or Control+Home (a textarea), as
  `focusField` does.
- A field that has no box, or that another element covers at the click's point (the stage's own hit test),
  gets no click: the utility call alone gives the focus, and the harness counts it.
- Only text fields get the click. A click on a button, a link or a check box has its own effect, so the
  focus of another element is by Q3.

## 6. Playwright's own checks

### 6.1 The actionability waits

Playwright checks that an element is visible, enabled, stable over two frames and not covered, in its
utility world, before it sends input (the research, section 5; `checkElementStates`). The stage passes
these calls at once. It changes only the input after them. So the waits stay as they are: their own time
(20 to 31 ms in the research's trace) and their own retries.

### 6.2 The hit-target check

Read in `playwright-core` 1.65.0 (`setupHitTargetInterceptor`):

- Playwright first checks the hit point itself (`expectHitTarget`: the element at the point is the target
  or inside it). On a miss it retries the whole action.
- Then it listens, in its utility world, on the window in the capture phase, for one set of events: for a
  click (`mouse`): `mousedown`, `mouseup`, `pointerdown`, `pointerup`, `click`, `auxclick`, `dblclick`,
  `contextmenu`; for a hover: `mousemove`; for a tap: `pointerdown`, `pointerup` and the touch events; for
  the drop of a drag: none.
- **The first event of the set decides.** Playwright checks its point against the target. After a miss,
  Playwright stops every later event of the set (`preventDefault`, `stopPropagation`,
  `stopImmediatePropagation`), and the action retries after 0, 20, 100, 100 and 500 ms, with a script
  scroll (`scrollIntoView` with `block` end, center, start) in each retry.
- When no event of the set came, the check passes.

What it means for the stage:

- **A click.** The path's moves are not in the click's set. Only the press decides, and it is at
  Playwright's point. So the path can cross any element. Measured (M3): in each of two runs, 8 of 8
  clicks, checks, double clicks, frame clicks and clicks with a modifier passed at the first try (one
  hit-target setup each). A path that opens a hover menu over the target makes the press miss, as a
  person's would. Playwright then retries, and the second path is short.
- **A hover.** The first `mousemove` after the setup decides. If the stage played the path after the setup,
  its first move would be far from the target, so the check would miss and stop every later `mousemove` of
  the path: the page would get `pointermove` events with no `mousemove`, which no mouse gives. Measured
  (M4): a listener of the page on the document got 73 `pointermove` and 0 `mousemove` events, and
  Playwright retried the hover once.
  So the stage plays a hover's path when it sees the setup (the hover check recognizer), before it sends
  the setup to Chrome. Playwright's move then comes at the point where the pointer is, and the stage
  answers it with no event (a mouse that does not move sends no move; M2: Chromium gives the page a
  `pointermove` and a `mousemove` with movement 0 for each CDP move to the same point). No `mousemove`
  comes after the setup, so the check passes (M4: at the first try, and the page's listener got 33
  `mousemove` and 33 `pointermove` events).
- **The press point.** The stage presses at Playwright's point, rounded to a whole px (at most 0.5 px from
  it, inside the element). A person's press spreads around a target's middle. The pointer model (section
  10.1) can aim at another point of the same element. The stage then checks the point with its own hit test
  in its own isolated world (in the frame's own session for a frame), and keeps the point only when the hit
  element is the same as at Playwright's point. Else it uses Playwright's point. This keeps the check and
  gives the spread. (Designed; the build measures it.)

### 6.3 The timeouts and the budget

Read in `playwright-core` 1.65.0 and `@playwright/mcp` 0.0.85:

| Client call | Its timeout by default |
| --- | --- |
| `page.mouse.*`, `page.keyboard.*` | none (the client sends no timeout: `kNoTimeout`) |
| locator and page actions: `click`, `hover`, `fill`, `type`, `pressSequentially`, `press`, `check`, `dragTo` | the action timeout: 30 000 ms in the library (`DEFAULT_PLAYWRIGHT_TIMEOUT`); `@playwright/test`: no action timeout by default, inside a 30 s test timeout |
| the Playwright MCP's tools | 5 000 ms for an action (`--timeout-action`), 60 000 ms for a navigation |

The budget of a translated action, in the normal case (first values of section 10):

| Action | Stage time | Measured |
| --- | --- | --- |
| a click, hover or check | path 0.3 to 1.5 s (Fitts's time 300 to 1000 ms, plus an overshoot leg over 500 px), pause 0.09 to 0.25 s, press 0.075 to 0.125 s: at most about 2.0 s | M3, M4: a click from 900 px away 1.4 to 1.6 s in all, a check 1.4 s, a hover 0.6 s, a frame click 1.0 to 1.1 s |
| a double click | a click plus a gap and a press: at most about 2.3 s | M3: 1.1 to 1.2 s |
| the activation step before it, when the page is not in front (C11) | 30 to 60 ms plus the X path (0.3 to 1.5 s); worst case 11.4 s (C11) | the pointer design's build |
| a scroll into view | 1 to 4 rounds of notches, each up to 0.9 s with its wait | M6: a click 2,400 px below the fold, 17 notches, 2.6 s in all |
| typed text | about 0.12 to 0.3 s for each character | M5: about 0.2 s a character (16 to 20 characters in about 3.3 to 4.1 s after the focus click) |

The stage's limits, so that a translated action ends inside the defaults:

- A pointer action ends in about 2.5 s at most, plus the activation step. Inside 30 s, and inside the MCP's
  5 s in the normal case.
- The Playwright MCP inside the service gets `timeouts.action: 30000` in its `createConnection`
  configuration (the service design, section 8.2), not the MCP's 5 s default. Then a long fill or an
  activation's worst case does not end an MCP action that a person's input would finish.
- `fill` and `insertText`: typed keys only when the plan fits in `STAGE_TYPE_MAX_MS` (first value 10 s);
  the stage first moves the plan to the fast end of the person's spread when that makes it fit (section 7).
- A key run of `pressSequentially` or `type`: the stage does not know the run's length in advance. It types
  at the person's speed for the first `STAGE_RUN_SLOW_MS` (first value 12 s) of the run, then at the fast
  end of the person's spread (about 100 to 120 ms a key). At `STAGE_ACTION_MAX_MS` (first value 25 s) the
  rest of the run goes at Playwright's own speed, with no person's timing, and the harness counts it. With
  an average typist's speed, about 50 characters go at the person's speed and about 170 in all inside the
  25 s. So no client action reaches the 30 s timeout because of the stage (Q2).
- `STAGE_ACTION_MAX_MS` ends any lock hold in the same way (section 4.4).

### 6.4 The order of the answers

Playwright sends a click's move, press and release together and waits for all three (`Mouse.click`, with
no `delay`). It sends `dblclick`'s five calls together. The stage keeps them in order in the tab's gate and
holds each answer (section 4.5). Playwright's `Promise.all` ends when the release's answer comes, which is
after the hold. Measured (M3): for a click from 900 px away, the stage answered the move 1,100 ms after it
came, the press 1,305 ms and the release 1,429 ms after; Playwright's click ended with no error.

### 6.5 Retries

A retry of Playwright's comes after a miss of the hit-target check or after "not in the viewport". Its
scroll is a script (`scrollIntoView` with a `block` option, in a utility call), not
`DOM.scrollIntoViewIfNeeded`. The first build passes that call unchanged, and the harness counts the scroll
with no wheel. A later build can put notches before it (the retry scroll recognizer) when the harness shows
retries in normal use.

## 7. `fill` and `insertText`

### 7.1 What reaches the stage

Playwright's `fill` (`injected.fill`, `playwright-core` 1.65.0) works by the element's kind:

| Element | What Playwright does | What the stage gets |
| --- | --- | --- |
| an input of type text, search, email, url, tel, password, number, or with no type | a script gives it the focus and selects all its text; then `Input.insertText` with the value (`clear`: a Delete key) | the U call, then `Input.insertText` |
| a textarea | the same | the same |
| a contenteditable | the same, with a script selection of its content | the same |
| an input of type date, time, datetime-local, month, week, color, range | a script sets the value and sends `input` and `change` with `isTrusted` false | the U call only |

### 7.2 When typed keys take the place of the inserted text

The stage types the text as keys when all of these are true. Else it sends the `Input.insertText` as it is.

1. The focused element (the stage's own read at the call) is an input of a text type (the first row above)
   or a textarea.
2. Each character has a key on the US layout (`src/record.ts` `charKey`), or it is a line feed into a
   textarea (the Enter key). Playwright's `keyboard.type` uses the same US layout.
3. The plan at the person's speed fits in `STAGE_TYPE_MAX_MS` (10 s). When it does not, the stage plans at
   the fast end of the person's spread (about 100 to 120 ms a key); when that fits, it types at that speed.
   With the first values, about 40 to 60 characters fit at a person's mean speed, and about 80 at the fast
   end.
4. On the Mac, the same, with the Mac's editing commands for keys such as Backspace (`src/record.ts`
   `macCommands`).

The first typed key replaces the selection that Playwright's script made, as a person's typing replaces a
selection. The text in the field is the same as with `Input.insertText`, with one known difference: a page
that changes each typed key (an input mask, a key handler) sees keys, as from a person, where Playwright's
own `fill` gives it one `input`. The stage reads the field's value after the last key. When the value is
not the text, it logs the difference; it does not repair the field.

### 7.3 When typed keys cannot take its place

- **A date, time, color or range input**: no input reaches the stage (section 7.1). A person types the
  parts of a date into Chrome's date field, or picks it in a popup. Q3 covers it.
- **A contenteditable**: a page's editor (a rich text or code editor) can change typed keys: it can close a
  bracket, make a list, or accept a suggestion at Enter. Then the result is not the client's text. The
  stage sends the inserted text there. A later task can measure typed keys in common editors.
- **A value that a person cannot type on the US layout** (an accented letter, a script with no US key, an
  emoji): the inserted text, as Playwright sends it. A person types such text with an input method or
  pastes it.
- **An input method (IME)**: not in this design. CDP has `Input.imeSetComposition`; a page sees composition
  events only from an input method. The first build sends no composition events.
- **A very long text**: above the limit of rule 3. Q2 asks the operator. The first build (no answer) types
  up to the limit at the fast end and sends the whole text as one `Input.insertText` above it.

### 7.4 `clear`

`clear()` is `fill('')`: Playwright's script selects all, then it sends the Delete key. The stage gives the
Delete key a person's hold. The click before the U call (section 5.4) gives the focus.

## 8. Scrolling

### 8.1 What a page can tell apart

From the research (sections 3, 4.4, 7): a mouse wheel on X11 gives one wheel event of `deltaY` 120 and
`wheelDeltaY` -120 for each notch, `deltaMode` 0. A CDP `mouseWheel` gives any `deltaY`, but `wheelDeltaY`
is always -120 or 120. So a CDP notch of 120 px matches X11 in both fields; agent-browser's notch of 100 px
does not (P7). Playwright's `mouse.wheel(0, 600)` gives one event of 600 px (no mouse gives that), and
`DOM.scrollIntoViewIfNeeded` gives a scroll with no wheel at all. A page can count wheel events per scroll,
read their deltas and gaps, and see a scroll with no wheel or key before it.

### 8.2 `mouse.wheel`

- The stage sends notches of 120 px in the asked direction, on each axis, at the page's last point (where
  Playwright's wheel is), with a person's gaps (first value 35 to 90 ms; part B measures them).
- The count: `n = max(1, round((|delta| + residual) / 120))`, where `residual` is what the page's earlier
  wheel calls asked for and did not get. So a series of wheel calls scrolls the asked total to within one
  notch, and a call with a delta that is not 0 always gives at least one wheel event.
- Playwright's `mouse.wheel` does not wait for the scroll and does not check it (its documentation). So a
  scroll that differs from the asked delta by less than one notch keeps the client's result.

### 8.3 `DOM.scrollIntoViewIfNeeded`

Playwright sends it before each pointer action and for `scrollIntoViewIfNeeded()`. The stage:

1. reads the element's box (`DOM.getContentQuads` with the call's node) and the viewport
   (`Page.getLayoutMetrics`);
2. answers `{}` with no scroll when the element is in view: all of it inside the viewport on an axis, or its
   middle in the middle 60% (vertical) or 80% (horizontal) of the viewport (the rule of `src/input.ts`
   `view()`);
3. else finds the element's scroller and a point over it, in its own isolated world (`src/input.ts`
   `view()`: the pointer's point when the element under it scrolls the same scroller, else a point of the
   scroller's visible part), moves the pointer there with a path when it is not there, and sends the
   notches that bring the element's middle to the middle of the viewport;
4. waits for the smooth scroll to end (first value 350 ms), reads again, and repeats, at most 4 rounds;
5. when the element is still not in view (a scroller that the wheel does not move, or a page that stops the
   wheel), sends the client's `DOM.scrollIntoViewIfNeeded` as it is (a script scroll) and logs it.

Measured: M6. For an element in a cross-origin frame, the frame's session sends the call. The stage reads
the box there and sends the notches on the top page's session at a point over the frame: a wheel over a
frame scrolls the frame's scroller first, then its parents.

### 8.4 Script scrolls

A retry's scroll (section 6.5) and a client's own `scrollTo` in `evaluate` are scripts. The stage cannot
see a client's script, and it passes a retry's scroll in the first build.

### 8.5 The Mac

A Mac trackpad gives many small deltas with momentum; a Mac mouse wheel's deltas are not measured (the
research, section 9). Until part B measures them, the stage on the Mac sends `mouse.wheel` and
`DOM.scrollIntoViewIfNeeded` as the client sent them, with the stage's timestamp, and the harness marks the
Mac's wheel as "not measured". Part B's task 4 records the operator's scrolls on the Mac, and build task 9
(section 14) adds the Mac's wheel model.

## 9. The source of the events

### 9.1 What a page can tell apart

The research found no field of one event that tells CDP input from real X input (XTEST): `isTrusted`, the
pointer's fields, `movementX/Y`, the event order and the key fields are the same (section 6). It found three
differences in timing and rate, and this probe measured whether CDP can match them:

| Signal | XTEST at 125 Hz | CDP, `timestamp` 4 ms before the send, in whole ms | CDP, `timestamp` of the send, in whole ms | CDP, fractional `timestamp` | CDP, no `timestamp` |
| --- | --- | --- | --- | --- | --- |
| samples per `pointermove`, mean (max) | 1.87 to 1.97 (3) | 1.73 to 1.86 (2) | 1.78 to 1.88 (2) | 1.65 to 1.86 (2) | 1.63 to 1.88 (2) |
| predicted points, mean (max) | 1.80 to 2.11 (3) | 2.32 to 2.67 (3) | 2.38 to 2.84 (3) | 2.37 to 2.69 (3) | 2.58 to 2.73 (3) |
| sample gaps on a whole millisecond (chance: about 30%) | 100% | 100% | 100% | 3% to 7% | 2% to 8% |
| frame phase: handler time minus event time, median | 2.3 to 8.1 ms | 5.4 to 5.6 ms | 1.2 to 1.5 ms | 0.7 to 0.8 ms | 0.4 to 0.5 ms |
| events with a time later than their handler's time | 0 | 0 | 0 | 0 | 0 |
| fractional points, jumps over 100 px, movement that does not match the point | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 |

M1 (section 17) ran the same three planned paths in each column, with a press at the end, in two runs (the
column of 4 ms in the second run only). So the CDP form of the design (the second column) matches XTEST on
every measured signal except the count of predicted points: 2.3 to 2.7 against 1.8 to 2.1 here. The
research measured 1.86 to 2.71 for XTEST at 125 Hz, so the two ranges overlap, but in this probe CDP's
mean is higher in each step. Chromium predicts points from the samples and their times; the cause of the
difference is not known. A page can read it. The harness scores it (P1), and the pointer build (ab-t30.3)
tries the rate, the latency and the sample times against XTEST and then against part B.

Two more differences need no probe:

- **NumLock and CapsLock.** CDP has no modifier for them, so `getModifierState("NumLock")` is false for CDP
  keys (inferred in the research). The agent's own Xvfb has both off too, so the agent display matches
  itself. A desktop with NumLock on would differ; the agent display has no such desktop.
- **The X pointer.** CDP input does not move the X pointer. When a window comes forward, Chrome gives its
  page a real event at the X pointer. The agent pointer design handles it: the X player moves the X pointer
  along a person's path before each activation (C10, C11). The stage keeps it.

### 9.2 The cost of real X input for every event

- **One pointer and one keyboard focus for the display.** With real X input, a page gets pointer events only
  while its window is in front and under the pointer. The agent display has no window manager, and every
  page has a window of its own at the same place. So every move, hover and wheel of every agent needs its
  window raised first, and the operator's live view and the agents share the one pointer (C10's `not now`
  rule kills a path at the operator's input).
- **Several agents on one display.** Every agent's pointer input waits for the display, also a hover or a
  wheel that CDP could send to a page in the background. The input lock (section 4.4) already serializes
  actions, but X input would also need the raise for every action, which costs an activation step (30 to 60
  ms plus an X path) each time.
- **Keys.** XTEST types keysyms through the X keyboard map. A character with no keysym in the map needs a
  remap of a spare key code, which changes the key codes that the page sees. CDP sends the key fields that
  the stage chooses.
- **Processes and time.** Each X path is one `xdotool` script (20 to 26 ms to start, the pointer design's
  measurement), and each key or press would be one more X call. The daemon's X calls run one at a time.
- **The Mac.** No X; the operator's own pointer is never used. CDP is the only source there.

### 9.3 The choice

**CDP input on every platform, with the person's timing, timestamps and rate set by the stage. Real X input
only for the X pointer's path at an activation (the agent pointer design, unchanged).**

The reasons:

1. With whole-ms timestamps a few ms before the send and moves at 125 Hz with no wait for each answer, CDP
   matches real X input on the measured signals (M1), except the count of predicted points, which the
   pointer build must close or show to be within a person's range. No field of one event differs (the
   research).
2. One source for Linux and the Mac, so one stage and one set of tests. The Mac cannot use X.
3. No raise for every action, no shared X pointer for hovers and wheels, and no X keyboard map.
4. The plans of the generator do not depend on the source. If the harness ever finds a signal that CDP
   cannot match, an X player for whole paths can play the same plans on Linux, as a later task. Section 14
   does not plan it.

## 10. The models

### 10.1 Pointer trails (ab-t30.3)

The model plans one path from a start point to a target. Each value below is a first value from the
literature or from the research; part B replaces them (section 10.3).

| Part | The rule | First values (source) |
| --- | --- | --- |
| The start | the page's last point; never a fixed point. A page with no last point: the X pointer's place mapped into the page (Linux, at an activation), else a random point of the viewport's middle 30% to 70% | `src/input.ts` |
| The time | Fitts's law: `a + b * log2(1 + D / W)`, with W the target's smaller side, times a factor from a lognormal spread | a = 250 ms, b = 110 ms a bit, from 300 to 1000 ms (`fittsMs`); spread sigma 0.2 [18] |
| The shape | one main sub-movement with a bell speed (minimum jerk), along an arc to one side with a deviation of 2% to 10% of the distance | [17]; the research: 28.6% of human moves have a straightness above 0.94 [13] |
| End corrections | 0 to 2 small corrective sub-movements in the last 10% of the time; for a move of more than 500 px, an overshoot of 2% to 8% past the target in about 30% of moves, then the way back | first values; today ghost-cursor overshoots each move past 500 px (`planMove`); [14] models sub-movements; part B |
| Jitter | a small noise across the direction of the path, 0.3 to 1.2 px, at 8 to 12 Hz (a hand's tremor) | first value (no source here); part B |
| The speed | from the shape and the time; at most 3.5 px/ms | [13] |
| The rate | one sample each 8 ms (125 Hz), whole px, no sample that does not move | first value: the rate of the research's X input; [7]: mice report "typically at 100Hz"; part B measures the operator's device |
| The approach to a small target | the speed falls in the last part, so a 24 px box in a 300 x 65 px frame sees an entry at its edge and 8 to 20 samples inside it before the press | the research, P4 |
| The pause before a press | a lognormal, median 140 ms, from 80 to 400 ms | first value; [13] counts a click within 0.4 s of a point as one action; part B |
| The press | a lognormal hold, median 100 ms, from 60 to 180 ms; `force` 0.5 | first value (a person's press is not measured; the research, P5); `force` 0.5 [1]; part B |
| A double click's gap | 90 to 150 ms from the first release to the second press | not measured; part B |
| The press point | an offset from the target's middle, a normal with a standard deviation of 1/8 of the target's smaller side, at most 1/4 of it; kept only by the hit test of section 6.2 | first value; part B's tasks 1 and 2 record the press points |
| The idle hand | none in the first build (Q4) | part B, task 6 |

### 10.2 Keyboard patterns (ab-t30.4)

| Part | The rule | First values (source) |
| --- | --- | --- |
| The hold | a lognormal per key, mean 116 ms, standard deviation 24 ms, from 50 to 250 ms | [19] |
| The time from one press to the next | a lognormal with the person's mean (an average typist: 239 ms, standard deviation 112 ms; a fast one: about 120 ms), with a part for each letter pair | [19], [20]; the letter-pair part from part B |
| Pauses | after a space: 20 to 120 ms more; after a mark (`.,;:!?`): 80 to 250 ms more; at a line's end: 200 to 600 ms more | first values; the research's K2 target (longer at word and line ends [19], [20]); part B |
| The speed in a session | the person's base speed times a slow drift from word to word (a factor from 0.85 to 1.15) | first value; ab-t30.4's "a speed that varies within a session"; part B |
| Rollover | when the next press comes before this key's release; with the holds and gaps above, about 25% of keys for an average typist and about 50% for a fast one | [19] |
| Shift | a Shift `rawKeyDown` 45 to 95 ms before a shifted character (`modifiers` 8 on it), and the Shift release 15 to 60 ms after the last held key's release; a run of capitals keeps Shift down; the left Shift (`location` 1) for a key of the right hand, the right Shift (`location` 2) for a key of the left hand, in about 70% of cases | first values; the research (K4: CDP can send it); part B |
| Corrections | none in the first build (K5); a later task can add a wrong key, a pause, Backspace and the right key, with the same final text | part B |
| NumLock, CapsLock | off | the agent display |

How the stage gets rollover from Playwright's sequential calls (section 4.5): at a key's release, the stage
draws the next interval's base part (the interval without the part of the letter pair). When it is shorter
than this key's hold, the stage answers the release early and sends it at its planned time. The next press
then goes at its own time, which can come before the release.

### 10.3 Parameters until part B, and after

- The parameters are a file for each platform, `src/human/params/linux.json` and `mac.json`, with each
  distribution (its kind, its values, its bounds) and its source. The first files hold the literature values
  above and the research's measured values.
- Part B (ab-t30.7) records the operator at the Mac. `analyze.ts --numbers` gives the step metrics (the
  research, section 8). A script, `src/human/fit.ts`, fits the parameters from those numbers. A new
  parameter file then goes through review. Only fitted values (medians and spreads) are committed, never a
  recording (the research's rule; the manager's rule on ab-t30.7: the JSON stays on the Mac until the
  operator says where it goes).
- The harness (ab-t30.2) then compares the stage's output with the person's numbers (section 13.3).
- A later recording (another device, another person) gives a new fit, not a new model.

### 10.4 One person for each scope

If every agent typed and moved with one fixed rhythm, a site could link the sessions by it. So each scope
gets one person, drawn once from the population's spread (seeded by the scope's name and a random seed
that the service keeps for the scope's life). Within the scope the person's values stay, with the
per-event spread of the tables above. Part B sets the population's centre and spread, not one fixed person.

## 11. One generator

### 11.1 The modules

| Module | What it holds | I/O |
| --- | --- | --- |
| `src/human/random.ts` | the seeded random source (today's `seededRandom`), lognormal and normal draws | none |
| `src/human/person.ts` | the parameter files, the draw of one person for a scope | reads the parameter file once |
| `src/human/path.ts` | the pointer plan: points with times at the device rate, from a start to a target with a width | none |
| `src/human/press.ts` | the pause, the hold, the double-click gap, the press point | none |
| `src/human/keys.ts` | the key plan: a stream API, `next(key)` and `release(key)`, that gives timed events (Shift presses, presses, releases) and the early-answer decision | none |
| `src/human/wheel.ts` | the notches, their gaps, the residual | none |
| `src/human/cdp-player.ts` | sends a plan's events over a `send` function, each at its time with its timestamp, with the in-flight bound | a `send` function and a clock |
| `src/human/x-player.ts` | plays a path on the X display as one `xdotool -` script (today the daemon's part; in the service, in-process: the service design, section 5.4) | `xdotool` |

The generator modules take a clock and a random source as arguments, so every test runs with a fake clock
and a seed.

### 11.2 Who uses it

- **The stage** (`src/relay/stage.ts`): every translation of section 5.
- **The activation path** (`src/relay/pointer.ts`): `planPath` uses `src/human/path.ts`, sampled for the X
  player within C10's limits (each `dt` 16 to 250 ms, steps of at most 50 px). The X path keeps its 16 ms
  samples, because C10's `POINTER_DT_MIN_MS` is 16. The catch-up of C11 becomes a stage path (section
  12.1).
- **agent-browser's own commands** (`src/input.ts` `Hands`): `moveTo`, `press`, `key`, `typeChar` and the
  notches of `intoView` use the generator and the CDP player. `Hands` keeps its own element finding, its
  scroll rule, its focus rule and its X pointer's last step. Through the agent door in the service, the CLI
  sends plain CDP input (the service design, section 5.5), and the stage shapes it; so in agent mode the CLI
  uses `Hands` only for its element finding, and its input calls go plain to the agent door. In direct mode
  (agent-browser's own Chrome), `Hands` plays the plans itself.
- **`record`**: its cursor overlay uses `src/human/path.ts`, so a recording shows the same path that the
  page gets.

## 12. The contracts

C11's master text is in chrome-extension `docs/protocol.md` today. The service design's stage 0 (board
ab-v16.94) moves it to agent-browser. The changes below are named against chrome-extension main `66078cd`;
the build writes them wherever C11's master text is at that time.

### 12.1 C11 (the endpoint)

1. **A new section, "The input stage (board ab-t30.6)"**, after "The pointer at an activation". It holds the
   rules of sections 4 to 8 of this design as contract text:
   - which calls the stage takes (section 4.2), the gate and the lock (4.3, 4.4), the answers and the early
     answer of a key release (4.5), the timestamps and the rate (4.6), the cases of no change (4.7);
   - each translation of the table of section 5, by CDP method and type;
   - the recognizers with their patterns, as `PLAYWRIGHT_FOCUS` is written today (section 5.2);
   - the constants: `STAGE_MOVE_MS = 8`, `STAGE_LATENCY_MS` = 3 to 5, `STAGE_MOVES_IN_FLIGHT = 8`,
     `STAGE_NOTCH_PX = 120` (Linux), `STAGE_TYPE_MAX_MS = 10000`, `STAGE_RUN_SLOW_MS = 12000`,
     `STAGE_ACTION_MAX_MS = 25000`, `STAGE_SCROLL_ROUNDS = 4`;
   - the rule that the stage is on for every client on Linux and on the Mac, with no client setting.
2. **"The window comes forward for input"**: on Linux with one window per page, the first move of a
   translated pointer action on a page that is not the front page is an input that starts an action too. So
   the activation step comes before the path, not only before the press: a person brings a window forward
   before the hand moves in it. The stage's own focus click is an input that starts an action.
3. **"The pointer at an activation"**: the catch-up is the stage's path. After an X record or a cover mark,
   the stage's next path starts at the recorded point, and the catch-up's own rules (the 50 px and 2 px
   thresholds, the 16 ms samples, `CATCH_UP_MAX_UNANSWERED`) give way to the stage's rules (every path
   starts at the page's last point; the in-flight bound of 4.6). "Each page's last point" is set by the
   events that the stage sent, not by the client's points.
4. **Refusals**: no new refusal, unless Q3's answer is c.
5. **The Mac**: the wheel and the scroll pass (section 8.5) until the Mac's wheel model exists.
6. **Vectors**: new `stageVectors` in `test/vectors/`: for each row of section 5, the client calls in, the
   events out (method, type, key fields; times as ranges), and the order of the answers, with a seed and a
   fake clock. The model's tests and the contract's tests read the same vectors.

### 12.2 C10 (the bridge) and C4

- No change of the bridge ops. The stage sends its events with `debugger.sendCommand`, as the client's calls
  went before.
- The bridge's in-flight limits (C10: `MAX_BYTES_IN_FLIGHT`, 64 requests per tab) are far above a path's 8
  moves in flight.
- The daemon's pointer ops (`daemon.pointerAt`, `daemon.movePointer`) do not change. In the service they
  become calls inside one process (the service design, section 5.4), with the same checks.
- C4: no change.

### 12.3 The service design

- Section 5.5's stage is this design. The service holds the stage, the input lock and the X player.
- Section 8.2: the MCP's configuration gets `timeouts.action: 30000` (section 6.3).
- agentwatch: no change for the stage. No setting of the operator is needed (Q1 a), so no new op on the
  control door.

## 13. Tests

### 13.1 Unit tests (`npm test`, no browser)

- **The generator**, with a seed and a fake clock: a path never starts at a fixed point; its samples are
  whole px, 8 ms apart, with no sample that does not move; its time follows Fitts's law within the spread;
  overshoots come only past 500 px and in the planned share; its end is the target. Keys: holds and gaps in
  their spreads; the overlap share; a Shift press before each shifted character and its release after the
  last held key; a run of capitals keeps Shift; the same text. Notches: the count with the residual.
- **The stage**, with a fake bridge and a fake clock, for each row of section 5: the client calls in, the
  events out, the order of the answers, from `stageVectors`. Also: the gate (a `Runtime.evaluate` after a
  click waits for the release), the lock (two tabs' actions never interleave), the in-flight bound, the
  early answer (a later non-key call waits for the release), an error of an event (the plan stops, a held
  button is released).
- **The recognizers**: fixtures of Playwright's utility calls for each pinned version (taken from the
  research's traces and from this probe's run), and a changed fixture that must pass unchanged.

### 13.2 Live tests with real Playwright (`test/live/`, local pages only)

- They run on the harness's own Xvfb and Chromium with the real receiver package, under the harness guard,
  as the agent-mode live tests do today, with `*.localhost` pages only. Playwright is installed in the run's
  scratch folder, not in `package.json`, for two pinned versions: the oldest that the C11 text names
  (1.64.1) and the newest (1.65.0 today).
- For each row of section 5: the action passes in Playwright with its default timeout, and the page's state
  is the same as with Playwright's own input on a second Chromium with no stage (the value of a field, the
  checked state, the count of clicks, the element in view, the files of an input). The recorder page
  (`recorder.html`) records the page's view for the harness.
- The cross-cases: a click whose path crosses a hover menu; a hover in a cross-origin frame; a click below
  the fold inside an inner scroller; a fill of exactly the limit and one character more; a `dblclick` on a
  word in a text; a press of Enter that submits a form; a dialog that opens at a click (the in-flight bound
  and the dialog's answer).

### 13.3 The harness (ab-t30.2) and its measure for each gap

The harness scores the recorder's records of a live test run against a reference: until part B, real X
input on the same Xvfb (XTEST at 125 Hz, the probe's `source` scenario) and the literature's ranges; after
part B, the person's numbers.

| Gap | The measure | The bar (first values; the harness task sets them) |
| --- | --- | --- |
| P1 rate | samples per `pointermove` and predicted points | within the reference's range (M1) |
| P2 times | the share of whole-ms sample gaps; events later than their handler | 100% on Linux; 0 |
| P3 shape | straightness, maximum deviation, peak and mean speed, time against Fitts's index, speed peaks | a Kolmogorov-Smirnov statistic against the reference below a bound |
| P4 the box | the frame's entry point, its moves inside, the time from entry to press | the entry at an edge; moves inside in the reference's range |
| P5 pause, press | their distributions | as P3 |
| P6 idle | moves between steps | by Q4 |
| P7 wheel | `deltaY`, `wheelDeltaY / deltaY`, gaps, events per scroll | 120 and -1 on Linux; gaps in range |
| P8 phase | handler time minus event time | within the reference's range (M1) |
| K1 to K3 | holds, press-to-press times per letter pair, pauses, the overlap share | as P3; overlap 15% to 50% |
| K4 Shift | shifted characters with a Shift press before them | 100% |
| K5 corrections | Backspace per 100 characters | not scored in the first build |
| K6 NumLock | `getModifierState` | off |
| R1, R2 | the click and move metrics of P1 to P5; `focus` between press and release; no jump over 100 px | as P1 to P5; 0 jumps |
| R3, R14 | a `focusin` with no press | 0 for text fields |
| R4 | key events for each typed character; texts with no key events | 1 or more below the limit; counted above it |
| R5, R6 | as P7; scrolls with no wheel or key | 0, except the counted fallbacks |
| R7, R15 | untrusted events | by Q3 |
| R8 | moves or drag events with the button down between the press and the drop | more than 5 |
| R9 | fractional points | 0 on Linux |
| R10 | as P1, P2, P8 | as there |
| R11 | jumps at an activation | 0 |
| R12 | touch events | 0 |
| R13 | the modifier's hold around the press; the gap of a double click | the modifier down before and up after; the gap in range |

### 13.4 A mutation for each rule

Each rule has a mutation that must turn at least one test red (the repo's habit for its rules). The build
runs each mutation once and records the red test in its pull request.

| Mutation | The test that must fail |
| --- | --- |
| no `timestamp` on the stage's events | P2 (the whole-ms share falls to chance) |
| a `timestamp` from the plan, not the send | P2 (events later than their handler) |
| no input latency in the `timestamp` | P8 (the frame phase below the reference: M1) |
| each move awaited before the next | P1 (one sample per `pointermove`) |
| the hover path after the setup | the hover row (blocked `mousemove` events, a retry) |
| the press answered before the path ends | the order test of the gate |
| no early answer of a key release | K3 (no overlap) |
| no Shift key for capitals | K4 |
| notches of 100 px | P7 |
| `DOM.scrollIntoViewIfNeeded` passed | R6 |
| no focus click | R3 |
| a same-point move sent | the hover row (a move after the setup) |
| typed keys above `STAGE_TYPE_MAX_MS` | the fill row's timeout case |
| points not rounded | R9 |
| no input lock | the two-tab lock test |
| no in-flight bound | the dialog case |
| a recognizer that matches a part of the text | the client-function fixture |

## 14. The build tasks, in order

Each task is a branch and a pull request with its tests, a fresh review, and no merge without the lead.
Each one builds on the one before.

1. **ab-t30.2, the harness** (on the board). It scores the recorder's records against a reference
   (section 13.3), with XTEST at 125 Hz as the reference until part B. Tests: `npm test` for its
   statistics; one live run on the probe's scenarios. It comes first, because each later task measures
   against it.
2. **ab-t30.3, the pointer model** (on the board). `src/human/random.ts`, `person.ts`, `path.ts`,
   `press.ts`, `wheel.ts`, the CDP player and the X player, with the literature parameters; `src/input.ts`
   and `src/relay/pointer.ts` move onto them. Tests: the generator's unit tests (13.1); the existing tests
   of `input.ts` and `pointer.ts`; the harness on agent-browser's own commands (P1 to P5, P7, P8, R9);
   the mutations of its rules.
3. **ab-t30.4, the keyboard model** (on the board). `src/human/keys.ts` with the stream API and the early
   answer decision; `src/input.ts` `key` and `typeChar` move onto it. Tests: unit tests; the harness on
   `type --into` (K1 to K4, K6); mutations.
4. **A new task, the stage's pointer part.** `src/relay/stage.ts`: the gate step, the lock, the held
   answers, the timestamps and the rate, the in-flight bound, the paths for `mouseMoved`, the presses, the
   double clicks, the buttons, the modifiers, `delay` and `steps`, the hover recognizer and the frame
   mapping, the press point's hit test, the catch-up's merge, the activation before a path (C11 change 2).
   Tests: the stage's unit tests and vectors for the pointer rows; the live rows with Playwright 1.64.1 and
   1.65.0; the harness for R1, R2, R9 to R13; the mutations.
5. **A new task, the stage's keys and text.** The key runs, the Shift key, the early answer of a release,
   the typing rule of section 7 with its limits, the focus and fill recognizers and the focus click, `clear`,
   chords. Tests: as task 4, for the key and text rows; R3, R4, K1 to K4.
6. **A new task, the stage's scroll and wheel.** The notches with the residual, the translation of
   `DOM.scrollIntoViewIfNeeded` with the scroller check, the frame case, the Mac's pass. Tests: as task 4;
   R5, R6, P7.
7. **A new task, the script calls.** By Q3's answer: the select-text and focus translations, the file
   chooser click for `DOM.setFileInputFiles`, the drag path for `dragTo` (with a probe step on a page that
   accepts the drop), and the pass or refusal of the other script calls. Tests: as task 4; R7, R8, R14, R15.
8. **A new task, the contract text.** C11's changes of section 12.1 and `stageVectors`, in the repository
   that holds C11's master text at that time. It merges before task 4's merge, so the build follows a
   reviewed text.
9. **A new task, part B's parameters** (after ab-t30.7). `src/human/fit.ts`, the new parameter files, the
   harness's bars against the person, and the Mac's wheel model (section 8.5). Tests: the fit's unit tests;
   the harness against the person's numbers.
10. **ab-t30.5, the live test** on forum.bearchive.com from the operator's Mac Chrome, last, under its own
    rules. The design recommends to the lead that ab-t30.5 also waits for task 9, so that the input is
    measured against the operator's own recording before the live test.

The stage's tasks 4 to 7 merge together or not at all into the default path: until all four are merged,
the stage stays off behind a build switch, so that no partial translation reaches a client ("don't do this
half baked").

## 15. Questions for the operator

Each question gives its options, their effects, a recommendation, and what the build does with no answer.

**Q1. Does the stage shape the input of every client and every site in agent mode?**

- **a. Yes, always, for every client and every site (recommended).** A click takes about 1 to 1.6 s (2.6 s
  with a long scroll; M3) and typed text about 5 characters a second (M5), so a long agent task takes longer
  than with plain Playwright.
  No site and no client needs a setting, as "the caller doesn't worry about it" says. A check like a click
  box can appear on any site, so the agent never knows in advance where it matters.
- b. Only for the sites of a list that the operator keeps on the Browser pane; plain Playwright speed on
  other sites. Faster on most sites; a check on a site that is not on the list sees plain Playwright input.
- c. Always, with a switch for each scope on the Browser pane that the operator can turn off (for example,
  for a test run). The default stays a.
- No answer: a.

**Q2. What does the stage do with a long text for `fill`, `insertText` or `pressSequentially`?** (section
7.3) A person types about 4 to 8 characters a second, and Playwright's default action timeout is 30 s.

- **a. Type a text that fits in 10 s (at the person's speed, or else at the fast end of the person's
  spread), and insert a longer text as one text (recommended).** `fill` types up to about 80 characters; a
  longer text goes as one `input` event with no keys (as a paste with no paste event). `pressSequentially`
  goes to the fast end after 12 s; after 25 s (about 170 characters) the rest goes at Playwright's own
  speed. No client action reaches its timeout.
- b. Always type every character. A `fill` of 500 characters takes about 1 to 2 minutes: with the default
  30 s timeout it fails, so clients must set longer timeouts. The page always sees keys.
- c. Insert every text of more than 20 characters as one text. Fast; a page sees text with no keys more
  often.
- No answer: a.

**Q3. What does the stage do with the calls that a person cannot make?** These are Playwright's script
calls: `selectOption`, `setInputFiles` with file buffers, `locator.drop`, `dispatchEvent`, `blur`, `focus`
and `selectText` on an element that is not a text field, and `fill` of a date, time, color or range input.
The page sees an event with `isTrusted` false or a focus or a change with no input before it.

- **a. Translate where a person's input gives the same result, and pass the rest (recommended).** A select
  gets a click and the arrow keys and Enter (when a probe shows that Chrome's popup takes CDP keys; else it
  passes); a date input gets a click and typed digits; files from buffers get a click on the input, and the
  service writes them to the scope's own folder for the file chooser. `dispatchEvent`, `drop` and `blur`
  pass, and the harness counts them. The client's result stays.
- b. Pass all of them as they are. The least code; the page sees the script's events.
- c. Refuse them in agent mode, with an error that names the person's way (for example "use click and type
  in agent mode"). The page never sees an untrusted event from a client, but vanilla Playwright scripts that
  use these calls fail, against "the caller doesn't worry about it".
- No answer: a, with the parts that need a probe passed until the probe is done.

**Q4. Does the pointer move by itself between a client's actions (a resting hand)?** (P6)

- a. No, until part B shows how the operator's hand moves at rest (task 6 of part B). Then the operator
  decides again with the numbers.
- **b. No, not in this design (recommended).** A move that no client asked for can open a hover menu or start
  a page's own handlers, so the client's next action can meet a changed page; a person's resting hand on a
  desk mouse makes few or no moves. The harness measures P6 against part B; if part B shows a gap, a later
  task can add small moves that stay over a part of the page with no handlers.
- c. Yes: small moves at rest from the first build. A page sees a living hand; a client's next action can
  meet a changed page.
- No answer: b.

## 16. What this design does not cover

- The Mac's own numbers: event times, the trackpad, the wheel, fractional points on a Retina screen (part B;
  the research, section 9).
- An input method, dead keys, and typed keys in a contenteditable (section 7.3).
- Typing errors and their corrections (K5).
- Touch and pen input.
- A hover in a cross-origin frame (section 5.3) and `dragTo` against a page that accepts the drop (section
  5.1): designed, not measured. Tasks 4 and 7 measure them.
- Internal names of Playwright versions other than 1.64.1 and 1.65.0 (section 5.2).
- What a click box's scripts read: this design matches what a script can read (the research, section 1).

## 17. The measurements

The probe ran on taylor (Debian 13, Linux 6.12.115, Node v26.12.0, Debian Chromium 156.0.8078.79,
playwright-core 1.65.0 in a scratch folder) in a private Xvfb on display 169 (1920 x 1080 x 24, no window
manager, its own X authority file), under the box's shared heavy lock and the repository's harness guard.
Each scenario started its own Chromium on a new profile, which the probe removed at the scenario's end.
Only `rec.localhost` and `box.localhost` were reachable. The probe's README gives the files and the
command; `results/` holds the runs.

Two runs: run 1 (02:15 to 02:16 UTC on 2026-11-10) and run 2 (02:33 to 02:35 UTC). Run 1's stage had two
faults of the probe, which run 2 fixed: its decoder read Playwright's argument in a wrong form, so its hover
recognizer missed and both of its hovers went the naive way; and its events carried the send time with no
latency. The folder holds run 2's code. Where both runs measured the same thing, a value is a range over both
runs. Each step's numbers come from the input research's `analyze.ts` (`results/run-2-summary.json`) and from
the probe's own counts (`results/run-2-extra.json`).

**M1. The event source** (scenario `source`). Three planned paths (`planMove`, 105 to 120 samples, 0.9 to 1.04
s, straightness 0.75 to 0.99) to three targets, each with a press of 90 ms after a pause of 150 ms, in five
forms: XTEST (one `xdotool -` script for each path, with no CDP session on the page) and four CDP forms, sent
at 125 Hz with no wait for each answer. The table of section 9.1 gives the results. In short: CDP with
whole-ms timestamps 4 ms before the send matched XTEST on samples per `pointermove`, whole-ms gaps (100%) and
frame phase (5.4 to 5.6 ms against 2.3 to 8.1 ms), with no event from the future, no fractional point, no
jump and no movement that does not match the point. The mean count of predicted points stayed higher (2.3 to
2.7 against 1.8 to 2.1).

**M2. A move to the point where the pointer is.** Two CDP `mouseMoved` to the pointer's own point gave the
page one `pointermove` and one `mousemove` each, with movement 0 (2 of 2, in both runs). A mouse that does not
move sends no move. So the stage answers such a move with no event.

**M3. Clicks through the stage** (scenario `stage`; Playwright 1.65.0, `connectOverCDP`, default options and
an 8 s timeout).

| Step | Result | Time | Hit-target setups | What the page saw |
| --- | --- | --- | --- | --- |
| `locator('#b').click()` from 900,700 | passed | 1.4 to 1.5 s | 1 | 68 to 75 moves (124 samples in 1.04 s, straightness 0.83), a pause of 112 to 216 ms, a press of 112 to 125 ms; `pointerdown mousedown focus focusin pointerup mouseup click`. The stage answered the move 1,086 to 1,100 ms after it came, the press 1,198 to 1,305 ms, the release 1,310 to 1,429 ms |
| `locator('#chk').check()` | passed; checked | 1.4 s | 1 | a pause of 180 to 191 ms, a press of 126 to 127 ms |
| `locator('#b').dblclick()` | passed | 1.1 to 1.2 s | 1 | two presses; run 2's answers came 610, 784, 899, 1,037 and 1,138 ms after the calls (the move, the presses and the releases) |
| `frameLocator('#box').locator('#cb').click()` | passed | 1.05 to 1.08 s | 1 | the box frame's first point at (2, 16) and (3, 22), 2 to 3 px from its left edge, then 9 moves inside it; the focus in the box |
| `locator('#b').click({ modifiers: ['Shift'] })` | passed | 1.0 s | 1 | a Shift `keydown` before the path, the press with the flag |
| `locator('#far').click()`, 2,400 px below the fold | passed | 2.6 to 2.7 s | 1 | 17 wheel notches (`deltaY` 120), 15 scroll events, none with no wheel; then the path and the press |
| `mouse.move(900, 700)`, then `click({ timeout: 3000 })` | passed | 2.35 to 2.41 s with the move's path | 1 | as the first row |

In every step of the stage: 100% of the sample gaps on a whole millisecond, no fractional point, no jump over
100 px, no movement that does not match the point, no event later than its handler, no untrusted event; 1.65
to 1.88 samples per `pointermove`.

**M4. Hovers** (`locator('#hov').hover()` from 900,700).

| The way | Result | Time | Hit-target setups | A listener of the page on the document (added after Playwright's) |
| --- | --- | --- | --- | --- |
| the path before the setup (run 2) | passed | 0.58 s | 1 | 33 `mousemove`, 33 `pointermove` |
| the path after the setup, the naive way (run 2) | passed after one retry with a script scroll | 1.16 s | 2 | 0 `mousemove`, 73 `pointermove` |
| run 1, both hovers (the recognizer missed) | passed after one retry each | 0.62 s and 1.13 s | 2 each | not counted |

The recorder's own listeners (on the window, added before Playwright's) saw every `mousemove` in both ways,
so only a listener that comes after Playwright's sees the block. A page's own scripts often listen on the
document or on elements, after Playwright's listener on the window.

**M5. Keys and text.**

| Step | Result | Keys | What the page saw |
| --- | --- | --- | --- |
| `locator('#f').click(); keyboard.type('Hello World, OK!')` | the value is the text | 16 | holds of 81 to 135 ms (median 101 to 110), press to press 98 to 322 ms (median 184 to 188); 3 Shift `keydown` events for the 5 shifted characters (Shift stayed down for "OK!"), each shifted character with a Shift `keydown` before it; the key gaps 100% on whole milliseconds |
| `locator('#ta').pressSequentially('Meet me at 10:45.')`, the field with no focus | the value is the text | 17 | the stage's focus click, then keys: holds of 71 to 146 ms (median 100 to 106), press to press median 173 to 198 ms, 2 of 2 shifted characters with Shift; a `focusin` with no press: 0 (Playwright alone gave 1 in the research's run 3) |
| `locator('#f').fill('jane.doe@example.com')`, the field with no focus and with text in it | the value is the text | 20 typed keys in place of one `insertText` | the focus click at the field's left end, then keys that replaced the selection: holds median 101 to 113 ms, press to press median 171 to 175 ms; the `@` with Shift; 4.2 to 4.8 s in all |

Rollover: run 1 answered 30% of the releases early at random, which gave overlaps of 0, 0 and 3 keys in the
three steps (18 early answers in all). Run 2 follows the design's rule (an early answer only when the next
interval is shorter than the hold): 1 early answer and 1 overlap. With the prototype's intervals (a median of
150 ms times 0.85 to 1.15, plus the pauses) few intervals are shorter than a hold of about 105 ms. So the
early answer gives real overlap with Playwright's one-key-at-a-time calls, and the share comes from the
model's parameters; ab-t30.4 sets them. In every case the text was right.

**M6. Wheel and scroll.** `mouse.wheel(0, 600)` gave 5 wheel events of `deltaY` 120 and `wheelDeltaY` -120,
69 to 88 ms apart (median), and `scrollY` 600; `mouse.wheel(0, -600)` gave 5 the other way and `scrollY` 0;
`mouse.wheel(0, -2400)` gave 20. Playwright's own `mouse.wheel(0, 600)` gives one event of 600 px (the
research). The click below the fold is in M3.

**The limits of the measurements.** The design rests on these numbers only within these limits:

- One Chromium (Debian Chromium 156) on Linux, in an Xvfb with no window manager; XTEST, not a hardware mouse
  (the research's limit); nothing on the Mac.
- The prototype is not the stage: it had no input lock, no activation step, no in-flight bound and no model.
  Its bridge was Chromium's pipe, not `chrome.debugger` through the agent extension. The stage's build
  measures these in the live tests (section 13.2).
- The prototype's model parameters are its own (M5), not all of the first values of section 10.
- Not run: `dragTo`, a hover in a frame, the press point's spread and its hit test, `setInputFiles`,
  `selectText`, `focus` on a text field, Playwright 1.64.1, and the MCP inside the service.

## 18. Sources

The numbered sources [7], [13], [14], [17], [18], [19], [20] are those of the research
([2026-11-09-click-box-input-signals.md](../../research/2026-11-09-click-box-input-signals.md), section 11).
The Playwright facts come from the code of `playwright-core` 1.65.0 (`setupHitTargetInterceptor`,
`_retryAction`, `_performPointerAction`, `Mouse`, `Keyboard`, `RawMouseImpl`, `RawKeyboardImpl`, the drag
manager, `fill`, `TimeoutSettings`) and from the README of `@playwright/mcp` 0.0.85 (`--timeout-action`),
read in a scratch folder.
