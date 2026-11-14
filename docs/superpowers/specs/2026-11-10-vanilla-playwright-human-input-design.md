# Vanilla Playwright input becomes a person's input in agent mode — design

**Status: Decided: the operator's answers of 2026-11-10 to Q1 to Q4 (section 15, "The answers"). Two
read-only reviews ran (review-96 and its re-check review-96b), and their findings are fixed or in section 16
(open points). The build runs in the tasks of section 14.**

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
(section 18). It ran on taylor with a private Xvfb, its own Chromium and local pages only. No browser in this
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
   own input, with one named exception: a page's own key handler can act on typed keys where Playwright's
   own `fill` inserts the text in one step (section 7.2 says how the stage limits it). One case gives a
   better result: a `hover()` on an element whose own `:hover` layer covers its middle passes with the stage
   and fails with Playwright's own input (M8).
3. **Playwright's checks keep working (section 6).** A click's hit-target check reads the press, so a path
   that crosses other elements does not matter, unless the path opens an overlay over the target: then the
   stage leaves it and goes around (section 6.6; M7). A hover's check reads the first move, so the stage sends
   the hover path's samples outside the target before Playwright sets the check up, and the rest after it (M4,
   M8). A client's dialog answer never waits behind the stage (section 4.3a; M9). Measured (section 18): 8 of
   8 translated clicks passed the check at the first try, in each of two runs; a hover with the path after the
   setup needed a retry, and a page listener then got 73 `pointermove` and 0 `mousemove` events. Each answer
   comes after its events. A translated click from a far point took 1.0 to 1.6 s, and 2.6 s with a scroll of
   17 notches, inside Playwright's 30 s default. The service sets its own MCP's action timeout to 30 s (its
   default is 5 s).
4. **Text (section 7).** For `fill` and `insertText` into a text field, typed keys take the place of the
   inserted text when every character has a key on the US layout, the text has no line feed or tab, and the
   typing plan at the person's speed fits in 10 s (about 40 to 50 characters; no fast end, by the operator's answer
   on board item ab-2qb). A longer text goes as a person's paste: Control+V from
   the clipboard of the service's own display, which holds the text only for that paste (the operator's answer on
   board item ab-8fu; board ab-t30.19). Else the text goes as Playwright sends it (Q2). The printable keys of
   `pressSequentially` and `type` are collected, so that a long run is pasted too (section 7.5). A date, color or
   range input gets no input at all from Playwright (a script sets it). A contenteditable keeps the inserted text,
   because a page's editor can change typed text.
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
8. **Contracts (section 12).** C11 gets a new section, "The input stage", and changed rules (the window,
   the pointer at an activation, dialogs, the MCP's timeout). C10 and C4 do not change. From stage 0 (PR #95)
   C11's master is agent-browser `docs/contracts/C11.md`.
9. **Tests (section 13).** Every row of the table runs with real Playwright (two pinned versions) against
   local pages and the research's recorder. The harness (ab-t30.2) scores each gap. Each rule has a mutation
   that turns a test red.
10. **Build tasks (section 14)** in order: the harness, the pointer model, the keyboard model, the contract
    text, the stage in four parts, then the part B parameters. **Four questions** for the operator (section
    15) and **seven open points** (section 16).

## 2. The operator's words

- 2026-11-05, on the epic: "add a new epic. cloudflare click boxes. you can test this on forum.bearchive.com
  only when everything else is done on the agentbrowser. it needs to be perfect first.... random mouse
  trails, real keyboard patterns, etc"
- 2026-11-05: "only test from mac chrome. don't try on the datacenter IP"
- 2026-11-09: "ok, don't do this half baked. ideally a consumer writes vanilla playwright and our system
  transliates the clicks and types into a human version. i.e. the caller doesn't worry about it"
- 2026-11-09, on the service: "so let's build a single self-contained process/wrapper that includes the
  relay/browser/extension/etc and everything communicates over that."
- 2026-11-10, on board item ab-0z5: option a for each of Q1 to Q4 (section 15, "The answers").

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
- **A miss**: Playwright's hit-target check found another element at the point: in its setup (the setup's
  answer is a string) or at the first event (the stop's answer is not `"done"`). Section 6.6.
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
the tab's session in its own isolated world (as the geometry read does). Two reads are the exception: the
frame mapping (section 5.3) and the recovery's read at the hit point (section 6.6) run in Playwright's
utility world, because they start from the node handle of the client's own call, which lives there.

### 4.2 Which calls the stage takes

On a page session of a tab (not on a child session of a frame or a worker), the stage takes these calls:

- `Input.dispatchMouseEvent` (all types), `Input.dispatchKeyEvent`, `Input.insertText`;
- `Input.dispatchDragEvent` while a drag of the stage runs (section 5, `dragTo`);
- `DOM.scrollIntoViewIfNeeded`;
- the utility calls of its recognizers (section 5.2).

It passes every other call to the bridge as today. It also passes each of these calls unchanged when one of
its own rules says so (section 4.7). On a child session of a cross-origin frame, the stage takes only the
recognized utility calls (the hover check, the focus and the fill of a frame's element: sections 5.3 and
5.4) and `DOM.scrollIntoViewIfNeeded` (section 8.3). Playwright sends the input of a frame on the top page's
session (the research, section 5), so the stage plays it there. A same-origin frame has no session of its
own: its utility calls come on the top page's session, with the frame's own points (section 5.3).

### 4.3 The gate and the order

The model already orders a tab's calls through the tab's gate (C11, "the order and the limit"). The stage
is a step of that gate:

- A tab's calls reach Chrome in the client's order. A call that comes after an input call waits until the
  stage has sent the events of that input. So a `Runtime.evaluate` after a click sees the page after the
  click.
- The stage's own reads (an element's box, the focused element) go to Chrome inside the step. A client
  never sees them.
- An ordinary call that the stage passes leaves the gate when the model sends it, not when Chrome answers
  (today's rule).

### 4.3a Dialogs

Today's gate never waits for an answer of Chrome ("never wait for an ordinary CDP answer: a dialog or held
target must still accept its release command", `src/relay/model.ts` `send`). A stage step does wait for the
answers of its own events, and a page with an open dialog answers no input event. Example (review-96): field
A has `onblur="alert(...)"`; a client fills field B; the stage's focus click on B blurs A; the alert opens;
the press's answer does not come; Playwright's `Page.handleJavaScriptDialog` (its auto-dismiss) comes after
the fill's utility call, which waits behind the stage's step. Measured (M9): with the dialog's answer in the
gate, the fill's step did not end in 25 s, and every later call of the page waited until the probe itself
dismissed the dialog 25 s later (the probe's own log call waits behind the same gate, so the record cannot
show the fill's own error at its 6 s timeout). So these rules hold:

- **A client's `Page.handleJavaScriptDialog` never waits.** The model sends it to Chrome at once, before the
  tab's gate and before any stage step (M9: the fill then passed). This change of order is safe: a client
  sends that call only after `Page.javascriptDialogOpening`, so it expects no call of its own to go first.
- **A dialog ends the plan** (review-96b, F1). The stage watches `Page.javascriptDialogOpening` of the tab (it
  sees the events that go to the client; when no client has `Page` enabled, the wait limit below applies).
  When a dialog opens during a plan, the plan ends at once:
  1. The stage drops the plan's own events that no client call asked for (the rest of the path's samples,
     the pauses).
  2. It sends at once, in order, each event that a client call of the plan asked for and that has not gone
     (the move to the client's point, the press, the release), and the release of each button and key that
     the plan holds.
  3. Then it frees the input lock and opens the tab's gate.
  Chrome keeps these events until the dialog closes, as with Playwright's own input (open point 5). The stage
  never goes on with a plan after its dialog closes, so no event of a plan goes after a later client call.
- **Each client call of an ended plan gets Chrome's own answer to its event**, when that answer comes (after
  the dialog closes) or Chrome's error. The stage gives no answer of its own, so "a client can trust an
  answer" (section 4.5) still holds.
- **Each read of the stage has a limit.** An element's box, the focused element, a hit test, a frame's offset:
  each waits at most `GEOMETRY_WAIT_MS` (200 ms, C11's geometry wait) and then fails open (the stage sends
  the client's call as it is, and the harness counts it).
- **Each wait for an answer of the stage's own event has a limit**, `STAGE_EVENT_WAIT_MS` (first value
  2 s), counted from the oldest event of the plan that has no answer. At the limit the plan ends as at a
  dialog (above). This also covers a dialog that opens between two events of a plan when the stage sees no
  `Page` event. A late answer changes nothing.
- **A hold counts from the press's send**, not from its answer, so a `confirm()` in a `mousedown` handler
  does not make the hold longer. When the press's answer does not come, the plan ends by the rules above, and
  the release goes at once; Chrome keeps it until the dialog closes.

### 4.4 The one input lock

A person has one hand on the mouse and one keyboard. The operator chose one input lock for all pages of the
agent browser (board ab-v16.46, after ab-1bi). Today `src/input.ts` holds it as a file (`input.lock`) for
agent-browser's own commands. The stage holds the same rule in memory:

- A translated action holds the lock from its first event to its last. A pointer action is a path, its
  press and its release. A key run is the keys of one tab with no other call between them; it ends at the
  tab's next call that is not a key, or 1 s after its last key. A collected part of a key run (section 7.5) sends no
  event while it collects: it goes in the action that is open, else it takes the lock at its end.
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
- **The answer of a collected key at once** (board ab-t30.19, section 7.5). Each printable key call of a key run,
  its release and a text in the run get their answers at once, with no event; the run's text goes at the run's end,
  and the tab's next call waits for its events.
- **No answer before its events in any other case.** A client can trust an answer: the page has the
  events, and the events of a collected part reach it before the tab's next call.
- **The error of an event.** When Chrome refuses an event of a plan, the stage stops the plan, answers the
  client call with that error, and sends no more events of the plan. When the plan held a button or a key,
  the stage sends its release first.
- **Shift and rollover.** A key with no Shift that follows a shifted key waits for that key's planned
  release and for the Shift release; the stage never sends a release before its planned hold has passed.
  (The probe's run 1 broke this rule: it sent a pending release at once to put Shift up first, and the `@` of
  the fill got a hold of 2 ms: N6 of review-96.)

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
the device rate, with whole-ms timestamps, around a kept obstacle after a hit-target miss (section 6.6). "A
press" is the pause before a press, a `mousePressed` with `force` 0.5, a hold, and a `mouseReleased`
(section 10.1), at Playwright's point rounded to a whole px, except for the spread of section 6.2. "Measured"
names a probe step of section 18. The last column holds for every row except the named exception of
section 7.2 (a page's key handler and typed keys).

| Playwright call | CDP that the model sees | What the model sends (its stage) | What the page sees (the result is the same as Playwright's own) |
| --- | --- | --- | --- |
| `locator.click()`, `page.click()` | U x5 (find, visible, enabled, stable), `DOM.scrollIntoViewIfNeeded`, `DOM.getContentQuads`, U (viewport size), U (`setupHitTargetInterceptor`, action `mouse`), then together `mouseMoved`, `mousePressed`, `mouseReleased`, then U (the check's stop) | notches in place of the protocol scroll when the element is out of view (section 8); the path to Playwright's point (whole px); a press there; the answers held | a curved path with many samples per frame, entry at the edges of the elements on the way, a pause, a press of about 100 ms, the `focus` between `mousedown` and `pointerup`, the `click` on the element. Playwright's check passes (measured: M3) |
| `dblclick()`, `mouse.dblclick()` | as a click, with two press-and-release pairs (`clickCount` 1 and 2) | the path; a press; a person's gap (first value 90 to 150 ms from the release); the second press with `clickCount` 2 | two clicks with a person's gap, then `dblclick` (measured: M3) |
| `click({ clickCount: 3 })` | three pairs (`clickCount` 1, 2, 3) | as `dblclick`, three presses | three clicks with a person's gaps |
| `click({ button: 'right' })`, `'middle'` | the click's calls with `button: right, buttons: 2` or `middle, 4` | as a click, with the client's button | `contextmenu` (right) and `auxclick`, after a press of a person's length |
| `click({ delay })`, `mouse.click(x, y, { delay })` | the move, the press, Playwright's own wait, the release (each awaited) | the path; a press; the release at the later of Playwright's release and the press time plus a person's hold | a hold of at least the client's delay |
| `click({ modifiers })` | after the hit-target setup, the modifier's `rawKeyDown` (`modifiers` 1, 2, 4 or 8); Playwright waits for its answer, then sends the move and the press with the flag; the modifier's `keyUp` after the release (the research, R13; `ensureModifiers` in `playwright-core` 1.65.0) | the modifier's press as it comes (Playwright waits for its answer before the move, so the stage cannot put it later); the path and the press with the flag; the modifier's release 60 to 200 ms after the mouse release (the stage holds the `keyUp` until then, and answers it after it) | the modifier down for the whole path and the press, up after the release (M3: the Shift `keydown` came before the path) |
| `hover({ modifiers })` | the hit-target setup, then the modifier's `rawKeyDown`, then the move | the path's samples outside the target at the setup (section 6.2); the modifier's press as it comes; the last leg with the flag | the modifier goes down after the approach and before the last leg (designed; not measured) |
| `click({ position })`, `click({ force })` | the same input at another point; with `force`, no checks before it | as a click | as a click |
| `click({ trial })` | the checks only, no `Input` call | nothing | nothing (Playwright's own trial) |
| `click({ steps })` (new in 1.65), `mouse.move(x, y, { steps })` | n `mouseMoved` on a straight line, each one awaited, then for a click the press | each short move (at most 50 px from the last point) as samples at the device rate at a person's speed (0.5 to 1.5 px/ms) with 0 to 1 px of jitter across the line; a longer move as a path | the client's line at a person's speed and rate, not 20 jumps one frame apart |
| `locator.hover()`, `hover({ position })` | as a click up to the move, with U (`setupHitTargetInterceptor`, action `hover`, with the hit point; with `position`, the hit point is that point); then one `mouseMoved`; no press | the whole path is planned at the setup; its samples outside the target's box go **before** the stage sends the setup; the rest (from the first sample inside the box) goes at Playwright's move, after the setup | a path that ends on the element; the first move after Playwright's check setup is inside the element, as with Playwright's own move; the check passes (M4, M8) |
| `mouse.move(x, y)` | one `mouseMoved` | the path (a short move as in the `steps` row) | a path |
| `mouse.move(x, y)` with a held button over an HTML5 draggable (`mouse.down()` first) | Playwright's drag manager: `Input.setInterceptDrags`, the move with `buttons: 1`, then `Input.dispatchDragEvent` events | as `dragTo` | as `dragTo` |
| `mouse.down()`, `mouse.up()` | `mousePressed`, `mouseReleased` at the last point | a pause when the press follows a path; the press; the release at the later of its arrival and a person's hold | a press of a person's length |
| `mouse.click(x, y)` | `mouseMoved`, `mousePressed`, `mouseReleased`, no checks | the path; a press | as a click |
| `mouse.wheel(dx, dy)` | one `mouseWheel` at the last point | notches of 120 px with a person's gaps (section 8.2) | wheel events of `deltaY` 120 and `wheelDeltaY` -120, as a Linux mouse wheel (measured: M6) |
| `locator.scrollIntoViewIfNeeded()`, the scroll of an action | U and `DOM` calls, then `DOM.scrollIntoViewIfNeeded` | notches until the element is in view, then the answer `{}` (section 8.3) | wheel events and the scroll that they cause; no scroll with no wheel (measured: M6) |
| `check()`, `setChecked()`, `uncheck()` | as a click, with a state read before and after | as a click | as a click; Playwright reads the new state (measured: M3) |
| frame clicks: `frameLocator(...).locator(...).click()` | the element's checks on the frame's own session; the frame's owner and box on the top page's session; the move, the press and the release on the top page's session, in top-page points | as a click, on the top page's session | the top page sees the path up to the frame; the frame sees the entry at its edge, its own moves, the press (measured: M3) |
| frame hovers | the hover's setup on the frame's session (a cross-origin frame) or on the top page's session (a same-origin frame), with the hit point in the frame's own points | the stage maps the hit point to the top page (section 5.3), then as `hover` | as `hover` (designed; not measured) |
| `tap()`, `touchscreen.tap()` | nothing: Playwright refuses without `hasTouch`, and a context from `connectOverCDP` has none | nothing | nothing (R12) |
| `keyboard.type(text)`, `pressSequentially(text)`, the old `type()` | `pressSequentially` and `type`: U x5, then U (`focusNode` with the caret reset) when the field has no focus; then for each character a `keyDown` with its text (a capital: `modifiers` 0) and a `keyUp`, each awaited; a character with no US key: `Input.insertText` | for the focus call: a click on the field when it does not have the focus (section 5.2); for each key: a person's timing (section 10.2), a Shift `rawKeyDown` before a shifted character and its release after, the release answered early for rollover; an `insertText` with a person's gap before it | the field gets the focus from a press; keys with a person's holds and gaps, about 25% overlap, a Shift key for each capital and symbol; the same text (measured: M5) |
| `keyboard.type(text, { delay })`, `pressSequentially(text, { delay })` | for each character: `keyDown`, Playwright's own wait of `delay`, `keyUp` (each awaited); before an `insertText`, a wait of `delay` | as above; each release at the later of its arrival and the key's planned hold; each press at the later of its arrival and its planned time | a hold of at least the client's delay; the gaps of a person or longer |
| `press(key)` (locator), `keyboard.press(key)`, `keyboard.down()`, `keyboard.up()` | U x5 and U (`focusNode`) for the locator; then the chord's `rawKeyDown` events, the key, and the releases in reverse order | the focus click as above; the chord with a person's timing: each modifier 40 to 120 ms before the key, the key's hold, the releases 20 to 80 ms apart | a person's chord; the same effect |
| `fill(text)`, `clear()` | U x5 (`fill`: the state checks, then the focus and the select-all by script), then `Input.insertText` with the whole text (a line feed in it too: `"two\nlines"` in the research's run 1 trace); `clear`: `rawKeyDown Delete` and `keyUp` | a click on the field when it has no focus, before the U call (with notches first when the field is out of view: section 5.4); typed keys in place of the `insertText` when section 7.2's rule allows it, else the text as it is; `clear`: the Delete key with a person's hold | typed keys (M5), or one `input` with the whole text (a line feed, a tab, the limit: Q2) |
| `fill()` of a date, time, month, week, color or range input | U only: a script sets the value and sends `input` and `change` with `isTrusted` false | a date, time, datetime-local, month or week input: a click 2 to 5 px from its left edge and the value's digits field by field, in the order of the input's fields (ArrowRight after a year that is not the last field and after a month input's month); a range input: a click at the value's place on its track and the arrow keys for the rest; then the U call in `SKIP_EVENTS` (board ab-t30.12.1); a color input: the U call passes | the browser's trusted `input` and `change` of a person's typing or click (measured: probe of board ab-t30.12.1); for a color input, the script's events |
| `keyboard.insertText(text)` | `Input.insertText` | as `fill`'s text (section 7) | typed keys or the inserted text |
| `selectOption()` | U only: a script selects and sends `input` and `change` (`isTrusted` false) | on a select that is not a list box: a click on it (its popup opens), a person's pause, the shortest keys in the popup to the client's option (arrow keys, Home or End, or the start of its label) and Enter; then the U call in `SKIP_EVENTS` (board ab-t30.12.1); a list box, the option selected already and the rest: the U call passes, counted | one trusted `input` and `change` and Chrome's own `click` (measured: probe of board ab-t30.12.1); else the script's events |
| `setInputFiles(paths)` with a local browser | U, then `DOM.setFileInputFiles` | a click on the input with the file chooser intercepted (`Page.setInterceptFileChooserDialog`, as `src/input.ts` `setFiles`), then the client's files to the input that the chooser names | a click on the input, then `input` and `change` from the browser |
| `setInputFiles(payloads)` (a remote client, or buffers) | U only: a script makes the files and sends untrusted `input` and `change` | the U call passes, or by Q3 | the script's events (Q3) |
| `dragTo(target)`, `dragTo(target, { steps, sourcePosition, targetPosition })` | the click's checks on both elements (with the positions as their points); `mouseMoved` and `mousePressed` at the source; `Input.setInterceptDrags {enabled: true}`; one `mouseMoved {buttons: 1}` to the target; `setInterceptDrags {enabled: false}`; `Input.dispatchDragEvent` `dragEnter`; `drop` | the path to the source; a press; a person's wait before the drag (100 to 300 ms); for the move with the button down: a short path with the button down until Chrome reports `Input.dragIntercepted`, then the rest of the path to the target as `Input.dispatchDragEvent`: first a `dragEnter` of the stage's own at the first point (with the data of `Input.dragIntercepted`), then `dragOver` events at the device rate; the client's own `dragEnter` at the target goes as a `dragOver` at its point; with `steps`, the client's moves as in the `steps` row; a pause before the `drop` | `dragstart`, `dragenter`, `dragover` events along a path, the drop at the target. M12: Chromium needs the `dragEnter` (with it: `dragstart dragenter dragover x4 drop dragend`; with no `dragEnter`: `dragstart dragend`, no `dragover` and no drop). The whole `dragTo` through the stage: not measured |
| `locator.drop(payload)` (new in 1.65) | a script in the page's main world makes `dragenter`, `dragover`, `drop` with `isTrusted` false | the call passes, or by Q3 | the script's events (Q3) |
| `focus()` | U (`focusNode`, no caret reset) | on a text field (an input of a text type, a textarea, a contenteditable): a click, then the U call; on another element: the U call passes, counted (a click on a button, a link or a select has its own effect) | a focus from a press, or from a script (Q3) |
| `blur()` | U (`blurNode`) | the U call passes, counted (`blurs`; a person's blur is a click elsewhere, which has its own effect) | a blur from a script (Q3) |
| `selectText()` | U (`selectText`) | on an input of a text type or a textarea: a click on it (none when it has the focus), a person's pause and the select-all chord (Control+A, on the Mac Meta+A), then the U call (board ab-t30.12.1); on another element: the U call passes, counted | a selection made with keys and a trusted `select` (measured), or from a script (Q3) |
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
| hit-target check | `([injected, node, { actionType, hitPoint, trial }]) => injected.setupHitTargetInterceptor(...)` | `actionType`, `hitPoint`, the node; the setup's answer (a string: a miss of Playwright's first check) | for `hover`: the path's samples outside the target (section 6.2); after a miss: the recovery (section 6.6) |
| the check's stop | `(h) => h.stop()` | its answer (`"done"`, or a miss) | after a miss: the recovery at the next setup (section 6.6) |
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
- The stage never answers a utility call itself. It puts its own input before the call, and it changes the arguments of one
  kind of call only (board ab-t30.12.1): after its input of a `selectOption` or of the `fill` of a picker or a range input,
  the call goes with Playwright's function inside `SKIP_EVENTS`, which skips that function's own `input` and `change` on
  the field while the field keeps the value that the stage's input gave it (C11, the script calls).

### 5.3 A point in a frame

Playwright gives a frame element's hit point in the frame's own points, and it sends the move and the press
on the top page's session, in top-page points (the research, section 5; `_checkFrameIsHitTarget` in
`playwright-core` 1.65.0). A cross-origin frame's utility calls come on the frame's own session; a same-origin
frame has no session of its own, and its utility calls come on the top page's session (review-96, B6;
measured: M10). So the stage maps a point by the frame of the call's node, on every session:

1. **A same-origin frame.** One call in Playwright's utility world on the node's own handle adds up, for each
   frame level up to the top page, the frame element's box plus its border and padding (the same sum as
   Playwright's `_checkFrameIsHitTarget`: `box.x + style.left`), and gives the node's box in top-page points.
2. **A cross-origin frame** (a child session). The stage finds the frame's owner on the parent's session
   (`DOM.getFrameOwner` with the frame's id) and reads its content box (`DOM.getContentQuads`), level by
   level; within a level that is same-origin, rule 1 applies.
3. The top page's point is the hit point plus the sum; the target's box is the node's box plus the sum.

When a read fails or reaches its limit (section 4.3a), or a frame has a transform (a quad that is not a
rectangle; Playwright gives no hit point then: `framePoint: undefined`), the stage plays no path before the
setup, and the hover goes the naive way (a retry of Playwright's; the check blocks the path's `mousemove`
events). The harness counts it. Measured for a same-origin frame (M10); a cross-origin frame's hover is
designed, not measured.

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
- **A field out of view.** Playwright's script focus scrolls the field into view by itself (`focus()`
  scrolls). The stage first brings the field into view with notches (section 8.3), then clicks (review-96,
  N11).
- **A field in a cross-origin frame** (a payment field). The focus and fill recognizers also work on the
  frame's own session: the stage maps the click's point by section 5.3 and sends the click on the top page's
  session. Playwright's keys and `insertText` come on the top page's session (its keyboard is the page's),
  and the typing rule's read of the focused element (section 7.2) follows the focus into the frame on the
  frame's own session. Designed, not measured; build task 6 measures a field in a cross-origin frame
  (review-96, N2).
- **A click that opens a widget.** A field whose click (not its focus) opens a picker or a list can cover
  the next target, where Playwright's script focus opens nothing. The recovery of section 6.6 moves the
  pointer off a covering element, but a picker that stays open until Escape or an outside click is an open
  point (section 16, open point 1). The operator's answer (board item ab-pf8, 2026-11-12): such a field gets no click,
  by its signs (C11, the focus click; board ab-t30.18).


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
  `stopImmediatePropagation`), and the action retries after 0, 20, 100, 100 and then 500 ms
  (`_retryAction`). Each attempt's scroll comes from the list `[none, end, center, start]` by the attempt's
  number modulo 4 (`_retryPointerAction`): attempts 0, 4, 8 send `DOM.scrollIntoViewIfNeeded`; attempts
  1 to 3, 5 to 7 send a script `scrollIntoView` with that `block` (section 6.5).
- When no event of the set came, the check passes.
- **Each attempt checks the hit point first, before any input.** So when the stage's own input left an
  overlay open over the target, every later attempt fails in the setup and sends no input, until the
  action's timeout (review-96, B1; measured: M7).

What it means for the stage:

- **A click.** The path's moves are not in the click's set. Only the press decides, and it is at
  Playwright's point. Measured (M3): in each of two runs, 8 of 8 clicks, checks, double clicks, frame clicks
  and clicks with a modifier passed at the first try (one hit-target setup each). But a path that crosses a
  hover menu's trigger can open its panel over the target, and the panel stays open while the pointer is
  in it. Then the press hits the panel, Playwright retries, and each retry fails in its setup (the pointer
  is still in the panel), until the timeout. Playwright's own input jumps to the target and opens no panel.
  Section 6.6 gives the stage's recovery (measured: M7).
- **A hover.** The first `mousemove` after the setup decides. If the stage played the path after the setup,
  its first move would be far from the target, so the check would miss and stop every later `mousemove` of
  the path: the page would get `pointermove` events with no `mousemove`, which no mouse gives. Measured
  (M4): a listener of the page on the document got 73 `pointermove` and 0 `mousemove` events, and
  Playwright retried the hover once.
  A path that ends on the target **before** the setup has its own fault: a hover layer that the target's
  `:hover` shows over its middle (a "Quick view" layer) is then open at the setup, so the setup's first check
  misses at every attempt (review-96, B1 b; measured: M8, where Playwright's own hover failed on that card
  too, at its first event). So the stage plans the hover's whole path when it sees the setup (the hit-target
  check recognizer), sends the path's samples that are outside the target's box, then sends the setup, and
  sends the rest of the path (from its first sample inside the box) at Playwright's move. The first
  `mousemove` after the setup is then inside the target, as with Playwright's own move, and the check passes
  (M4; M8: it passed at the first try, where Playwright's own hover and the whole path before the setup both
  failed at the 6 s timeout). The pause between the two parts is the setup's round trip (a few ms) plus one
  sample time. When the pointer is inside the target's box already, the whole path goes after the setup. A
  move that does not move gets no event (a mouse that does not move sends none; M2: Chromium gives the page a
  `pointermove` and a `mousemove` with movement 0 for each CDP move to the same point).
- **The press point.** The stage presses at Playwright's point, rounded to a whole px (at most 0.5 px from
  it, inside the element). A person's press spreads around a target's middle, but for some targets the
  point is the client's result: `click({ position })`, `mouse.click(x, y)` on a canvas, a range input, the
  caret in a text field, a double click on a word (review-96, B3). So the spread (section 10.1) applies only
  when all of these hold; else the stage presses at Playwright's point, rounded:
  1. a locator click with a hit-target setup of action `mouse` and `clickCount` 1 (no `dblclick`, no
     `clickCount` 2 or 3, no `mouse.click`);
  2. no `position`: Playwright's point is within 1 px of the middle of the element's content quad (the
     answer of Playwright's own `DOM.getContentQuads`, which the stage sees);
  3. an element whose effect does not depend on the point: `button`, `a[href]`, `input` of type `button`,
     `submit`, `reset`, `checkbox` or `radio`, `label`, `summary`, or an element with the role `button`,
     `link`, `checkbox`, `radio`, `tab`, `menuitem` or `switch` (read in the stage's own world); never a
     `canvas`, an `img` with a map, an `svg`, a `video`, an `input` of another type, a `textarea` or a
     contenteditable;
  4. the stage's own hit test at the new point (in its own isolated world; in the frame's own session for a
     frame) gives the same element as at Playwright's point.
  Designed; build task 5 measures it.

### 6.3 The timeouts and the budget

Read in `playwright-core` 1.65.0 and `@playwright/mcp` 0.0.85:

| Client call | Its timeout by default |
| --- | --- |
| `page.mouse.*`, `page.keyboard.*` | none (the client sends no timeout: `kNoTimeout`) |
| locator and page actions: `click`, `hover`, `fill`, `type`, `pressSequentially`, `press`, `check`, `dragTo` | the action timeout: 30 000 ms in the library (`DEFAULT_PLAYWRIGHT_TIMEOUT`); `@playwright/test`: no action timeout by default, inside a 30 s test timeout for the whole test |
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

- A pointer action ends in about 2.5 s at most, plus the activation step and a scroll of up to 4 rounds.
  That is inside a 30 s action timeout. It is not always inside the MCP's default of 5 s (a 4-round scroll
  and a path can take more), so the next rule sets the service's own MCP to 30 s.
- The Playwright MCP inside the service gets `timeouts.action: 30000` in its `createConnection`
  configuration (the service design, section 8.2), not the MCP's 5 s default. Then a long fill or an
  activation's worst case does not end an MCP action that a person's input would finish.
- `fill` and `insertText`: typed keys only when the plan at the person's speed fits in `STAGE_TYPE_MAX_MS` (first
  value 10 s); the stage never moves the plan to the fast end of the person's spread (the operator's answer on board
  item ab-2qb, section 15; board ab-t30.20). A longer
  text goes as a person's paste (section 7.5): measured by board ab-t30.19, a `fill` of 2,500 characters took 1.4 to
  1.5 s through the stage with each of the three Playwright versions of section 13.2.
- A key run of `pressSequentially` or `type`: the stage collects the run's printable keys and answers each at once
  (section 7.5), and the run's text goes typed or pasted at its end. The run's time with a person's timing is at
  most `STAGE_TYPE_MAX_MS` in all (its typed parts, its pastes and its other keys); a part that does not fit in what
  is left is pasted, and at the end of that time the rest of the run goes with no person's timing, counted: its
  printable keys are still collected with their answers at once, and each part goes as the client's own keys at once
  (review-126 B5). So the stage adds at most about `STAGE_TYPE_MAX_MS` and one part to Playwright's own time of a
  run. Measured by board ab-t30.19: a `pressSequentially` of 2,500 characters took 1.8 to 2.1 s through the stage
  (Playwright's own: about 6 s; each key call has its answer at once, and the paste went before the client's next
  call), and one of 30 lines (1,229 characters with their Enter keys) 17 to 20 s, with each of the three versions;
  in the review-126 round 13.1 to 13.6 s, and one of 60 lines (2,459 characters) took 15.7 to 16.9 s (Playwright's
  own: 5.3 to 5.6 s). This takes the place of the rule of a key run before board ab-t30.19 (the person's speed for
  12 s, the fast end until 25 s, then Playwright's own speed), whose bound (about 850 characters reached
  Playwright's 30 s timeout: board ab-t30.18) the operator's answer on board item ab-8fu removed.
- `STAGE_ACTION_MAX_MS` ends any lock hold in the same way (section 4.4).
- **A whole test of `@playwright/test`.** Its default test timeout is 30 s for the whole test, and the
  stage's time adds up over the test's actions (review-96, B8). With M3 and M5's times, 15 to 20 translated
  clicks take about 15 to 32 s, and a 60-character `fill` about 10 to 12 s. So a vanilla test of that size
  that passes today in a few seconds fails at its 30 s test timeout through agent mode. A client that runs
  `@playwright/test` against agent mode must raise its test timeout (`test.setTimeout`, or `timeout` in its
  configuration), for example to 120 s. The stage cannot see a test's timeout. Q1 names this effect.

### 6.4 The order of the answers

Playwright sends a click's move, press and release together and waits for all three (`Mouse.click`, with
no `delay`). It sends `dblclick`'s five calls together. The stage keeps them in order in the tab's gate and
holds each answer (section 4.5). Playwright's `Promise.all` ends when the release's answer comes, which is
after the hold. Measured (M3): for a click from 900 px away, the stage answered the move 1,100 ms after it
came, the press 1,305 ms and the release 1,429 ms after; Playwright's click ended with no error.

### 6.5 Retries

A retry of Playwright's comes after a miss of the hit-target check or after "not in the viewport". Its
scroll comes from the cycle of section 6.2 (review-96, N12):

- attempts 1 to 3 (and 5 to 7): a script `scrollIntoView` with `block` end, center or start, in a utility
  call. The first build passes that call unchanged, and the harness counts the scroll with no wheel. A later
  build can put notches before it (the retry scroll recognizer) when the harness shows retries in normal use;
- attempts 4 and 8: `DOM.scrollIntoViewIfNeeded` again, which the stage translates as in section 8.3.

### 6.6 Overlays that the stage's own input opens

The stage's input crosses elements that Playwright's one jump never touches, and its focus click is a click
where Playwright uses a script. So the stage can open an overlay that Playwright's own input does not open
(review-96, B1). The rules:

1. **A hover's last leg after the setup** (section 6.2): a hover layer of the target opens only after the
   setup's first check, as with Playwright's own move (M8).
2. **The miss watch.** The stage reads the answer of each hit-target setup (a string is a miss of
   Playwright's first check) and of each stop (`"done"`, or a miss at the first event). A miss marks the
   tab.
3. **The recovery at the next setup.** Before it sends the next setup of a marked tab, the stage reads, in
   Playwright's utility world on the setup's node, the element at the hit point. When it is not the target
   or inside it, the stage takes that element's highest ancestor that does not hold the target (for example
   a menu's root, which holds the trigger and the panel), moves the pointer out of both boxes on the side
   away from the target (a path to a point 15 px outside), waits two frames, and reads the ancestor's box
   again (now the panel is closed: the trigger's box). Then it sends the setup.
4. **The way around.** The next path to the target goes around that box: when the straight way crosses
   the box (10 px wider on each side), the path goes through the corner of the wider box that gives the
   shortest way, as two paths. Measured (M7): Playwright's own click passed; the stage with no recovery
   failed at the 6 s timeout; the stage with the recovery passed in 2.4 s (rule 4 was not needed there).
5. **A limit.** At most two recoveries in one action. After them, the stage sends the rest of the action's
   input as Playwright sends it, with only the timestamps and the rate of section 4.6, and the harness
   counts it.
6. **A widget that a click opens** and that stays open (a date picker, a list): open point 1 (section 16), answered:
   no focus click on such a field (board item ab-pf8).

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
2. Each character has a key on the US layout (`src/record.ts` `charKey`); Playwright's `keyboard.type` uses
   the same US layout. The text has no line feed and no tab: a text with one goes as `Input.insertText`
   (review-96, B4: as Enter, a line feed sends a message in a chat field with Enter-to-send, and a tab moves
   the focus).
3. The plan at the person's speed fits in `STAGE_TYPE_MAX_MS` (10 s). With the first values, about 40 to 50
   characters fit at a person's mean speed. The stage never plans at the fast end of the person's spread
   (about 100 to 120 ms a key): the operator's answer on board item ab-2qb (section 15; board ab-t30.20). A
   longer text goes as a person's paste when the paste rule allows it (section 7.5). This holds for `fill`,
   `keyboard.insertText` and the collected parts of `pressSequentially`, `locator.type` and `keyboard.type`.
4. On the Mac, the same, with the Mac's editing commands for keys such as Backspace (`src/record.ts`
   `macCommands`).

The first typed key replaces the selection that Playwright's script made, as a person's typing replaces a
selection.

**The named exception to "the same result".** A page's own key handler can act on typed keys, where
Playwright's own `fill` inserts the text in one step: a tag input that makes a chip at a comma, an
autocomplete that takes a suggestion at a key, an input mask that changes each key. A person's typing gets
the same handling, but the field's value can then differ from Playwright's result. The stage limits it:

- no Enter and no tab are ever typed for a `fill` (rule 2);
- typed keys only into an input of a text type or a textarea, never into a contenteditable (rule 1);
- after the last key, the stage reads the field's value. When it is not the text (as `maxlength` would cut
  it), the stage logs the difference and the harness counts it. The stage does not repair the field: a
  second insert would be a second, visible input, and a chip or a sent message cannot be undone;
- the live tests (section 13.2) hold a tag input and a field with an input mask, and the build reports how
  their values differ.

`keyboard.type` and `pressSequentially` are not under this exception: Playwright itself sends keys there.

**Shift is a known difference too** (review-96, N10). The stage types a capital with a real Shift
`keydown` before it, where Playwright's own `keyboard.type` sends none. A page that acts on a lone Shift
press, or on `shiftKey` in a key handler, sees a person's Shift.

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
- **A very long text**: above the limit of rule 3. By the operator's answer to Q2 (a), the build typed up
  to the limit at the fast end and sent the whole text as one `Input.insertText` above it. By the operator's later
  answer on board item ab-8fu, a text above the limit goes as a person's paste (section 7.5). By the operator's
  answer on board item ab-2qb, the limit is the plan at the person's speed alone: a text that fits only at the fast
  end goes as a paste too.

### 7.4 `clear`

`clear()` is `fill('')`: Playwright's script selects all, then it sends the Delete key. The stage gives the
Delete key a person's hold. The click before the U call (section 5.4) gives the focus.

### 7.5 A long text as a person's paste (board ab-t30.19)

The operator answered board item ab-8fu on 2026-11-12: "can we do a simulated copy/paste for long text input? and we use a person typing for short input only?" So a long text goes
as a person's paste, and only a short text is typed. C11 (the collected keys, the paste, the time of a key run) is the
contract text.

- **The paste.** A text whose typing plan at the person's speed does not fit in what is left of the key run's
  `STAGE_TYPE_MAX_MS` goes as a person's paste (no fast end: the operator's answer on board item ab-2qb, section
  15): the stage's own Control, then V 40 to 120 ms after it (a `rawKeyDown` with `modifiers` 2 and no text), the
  releases with a person's timing. The text is on the CLIPBOARD selection of the service's own display only from V's
  time to the answer of V's keyDown: Chrome reads the selection in that key's default action. The owner is the
  service's own X client (`src/service/unit/clipboard.ts`, no package: a small client of the X11 core protocol). The
  probe of board ab-t30.19 (display 169, Chromium 156) measured it: a CDP Control+V, with or without `commands`,
  made Chrome paste the selection; the page got trusted `keydown` events of Control and v, a `paste` event with the
  text in `clipboardData`, `beforeinput` and `input` with `insertFromPaste`, and the `keyup` events; a page's
  `paste` or `beforeinput` handler that prevents it left the value unchanged; Chrome asked for the selection 2 to 17
  ms after V's send, never before it; a text of 300,000 bytes went as an incremental transfer.
- **When the paste does not go.** On the Mac (Chrome shares the operator's own clipboard: open point 7), with no
  clipboard (the daemon's relay: it has no display at all, so there a long text never pastes), while a connection
  holds a grant of the clipboard (from the grant's request until a reset or the connection's close has cleared the
  setting: review-126 note 2), while an earlier paste's V of any tab has no answer (review-126 B4, below), while the
  client holds a key, and into a field that is not an input of a text type or a textarea: Playwright's own input (the
  client's `Input.insertText`, or the client's own keys of a collected part). A page that refuses the paste (the
  field's value does not change) gets Playwright's own input of the text after it. A paste handler that inserts its own
  text is counted, with no repair.
- **A secret never goes through the clipboard (board ab-t30.22).** agentwatch's skill sends a secret with `type
  --stdin`, and Playwright clients fill passwords, while a page of the same site can read the selection in the open
  point of the pending V (below). So the stage never pastes into a field of a secret (an `input` of type `password`, or
  a field whose `autocomplete` has `current-password`, `new-password`, `one-time-code`, `cc-number` or `cc-csc`) or a
  text that the client
  marks as a secret (`AgentBrowser.setSecretInput` with `{"enabled":true}` on the tab's own session, until
  `{"enabled":false}` or the end of the client's last session on the tab; the model answers it, in the tab's gate).
  Such a text goes typed when its plan fits, else as one `Input.insertText`, as a password manager's fill does (a
  collected part too, in place of its key events, and as the client's own keys when the field did not take it). The
  stage reads the field of a collected part at the part's end, before its events go, and every field again at V's time,
  after the gap that follows Control and before the clipboard's hold (review-129b); a page can still change the field
  in that hold and in V's send. A contenteditable, a field that is no text field and a failed read keep Playwright's own input
  also while the mark holds. Other fields paste, also one that holds a secret with no sign of it (a text field that CSS
  masks, a "show password" toggle, another card field): the mark is the way for them. agent-browser's own `type
  --stdin` sets the mark, and it fails closed: an error answer that does not say "not known" or "not available" stops
  its text.
- **The collected keys.** A key run reaches the stage one key at a time, so the stage learns its length by
  collecting it: each printable key call, its release, and a text in the run get their answers at once (a new
  exception to "no answer before its events", section 4.5). The run's part ends at the tab's next call that does not
  join it (a key with no text, Enter, Tab, any other call) or 1 s after its last call; the tab's next call waits
  until the part's events have gone. The part goes typed when it fits at the person's speed, else pasted, else as
  the client's own keys; after the run's `STAGE_TYPE_MAX_MS` the run's printable keys are still collected, and each
  part goes as the client's own keys at once (review-126 B5). Every end of a part's plan (a dialog,
  `STAGE_EVENT_WAIT_MS`, `STAGE_ACTION_MAX_MS`, a navigation, the end of a session or of the tab, an error of an
  event) frees the lock and opens the gate, each wait has its limit (review-123b R1), and the part's ended or failed
  action is closed before the tab's next call, so that call never waits for its own tab's lock (review-126 B1).
  After a dialog the client's own keys of a part that Chrome dropped while the dialog was open go again, and after
  any end each wait for Chrome's answers of them has the limit `STAGE_EVENT_WAIT_MS` (review-126 B2). A part keeps
  its limit when `STAGE_ACTION_MAX_MS` ends the action that it is in (review-126 note 6).
- **The flush (review-126 B3).** The client has the answers of a part's calls before the part goes, so before a
  close of the tab (`Target.closeTarget`) and before the detach at the end of the client's last session on the tab
  (`Target.detachFromTarget`, the close of its connection: Playwright's `browser.close()` over `connectOverCDP`),
  the rest of the part goes first, in the tab's gate: one `Input.insertText` of a collected part's text, or the rest
  of a running part's text as one `Input.insertText` after its plan ends as at `STAGE_ACTION_MAX_MS`. One call goes
  within the limit also for a long text, where the client's own keys would take seconds. The close waits for it at
  most `STAGE_FLUSH_MS = 5000`. The flush takes no lock of its own and makes no activation, so it never waits for
  another tab's lock (review-126b R1): its `Input.insertText` uses no clipboard and no pointer. A part whose step
  waits for the lock goes as the flush and never types or pastes later. A running part keeps its lock until its rest
  has gone, so its rest keeps the focus check of an ended typed or pasted text; a text with no lock of the part's own
  has no focus check, because the check needs the window's focus, and the text goes where Playwright's own
  `Input.insertText` goes. The tabs of a closed connection flush at the same time, each within `STAGE_FLUSH_MS`.
- **The named exception, a second side.** A page's key handler that acts on typed keys (a tag input that makes a chip
  at a comma) sees a short text's keys, as before, but a long `pressSequentially` or `type` as a paste, where
  Playwright's own input sends keys. The live rows of board ab-t30.19 hold the tag input's short text (the person's
  chips, as before).
- **Why no page of another scope reads the text.** The one browser's clipboard serves the tabs of every scope. A page
  reads it only with the Clipboard API and a grant (with none, `navigator.clipboard.readText()` waits on a prompt
  that nobody answers, and `document.execCommand("paste")` is refused: the probe), and the stage pastes nothing while
  any connection holds a grant of the clipboard. The focus is no guard by itself: in the probe a page in a window
  that was not in front, with a grant, read the clipboard under Playwright's focus emulation; in agent mode with one
  window per page the model answers that emulation itself, so only the page in front has the focus, but no rule rests
  on it. The text is on the selection for one paste only, on the service's own display (its X server admits only the
  cookie of the service's own X authority file). No paste puts its text on the selection while an earlier paste's V
  has no answer (review-126 B4): Chrome reads the selection in V's default action, after the page's keydown handler,
  and the second probe (display 169, Chromium 156) measured it: with a handler of 3 s, Chrome asked for the selection
  3,004 to 3,016 ms after V's send, and a page whose V waited while the owner held another page's text pasted that
  text. An error answer of V keeps the path closed until V's tab ends or its main frame navigates (review-126b note
  2), because Chrome can still run V's paste after an error. The third probe (display 169, Chromium 156) measured that
  the start of a navigation of the main frame brings V's answer at once, and a page of the same site still read the
  selection 2.5 s later, before its Page.frameNavigated. So after V's answer V stays closed until the page answers one
  read that the stage sends at that answer, where V's default action runs (board ab-t30.21): the probes of that task
  (display 169, Chromium 156) measured that the page answers it only after V's default action, also at that start of a
  navigation. An error of the read and its limit `V_READ_MAX_MS` keep the paste path of every tab closed until V's tab
  ends or its main frame navigates (fail closed); Page.frameNavigated of the main frame and a close of the tab end the
  wait, and a tab's end where the page can still run (Chrome's detach of the debugger, an orphan) keeps the path
  closed for `V_READ_MAX_MS` (review-131 B1). The client's own paste keys (each key event that Chrome takes as a paste
  on Linux, by Chromium's editing key table) join the closed set as the stage's V does, with the read where their
  default action runs, by a focus read before the key (review-131 note 1, review-131b). No input event goes to any
  session with no lock while a text is on the selection (review-126b R2): a frame's own input calls take the input
  lock (review-126 note 3), also a call of an ended plan, and the events of an ended plan take the lock again after
  its limit; the second probe measured that Chrome takes a key, an `Input.insertText` and a Control+V on an
  out-of-process frame's own session. The one exception is the flush, whose `Input.insertText` and printable keys with
  no modifiers and no commands cannot paste.

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
  The contract changes this (C11, the input stage, from PR #107; review-107 reading 8): the two goals conflict (ten
  calls of 100 px would give 1200 px), so C11 keeps "the asked total within one notch" and counts with `max(0, ...)`,
  with one notch when the count is 0 and the residual is 0 or more. C11's rule is the one that the build follows.
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

**The wheel point** (review-96, B2). A notch has side effects that `DOM.scrollIntoViewIfNeeded` does not
have: it changes the value of a focused number input under the pointer (measured: M11), it zooms a map or a
canvas whose page handles the wheel, and it scrolls a frame under the pointer first. So a point is a wheel
point only when all of these hold (the stage's own read, in its own isolated world):

- the element under the point, and each ancestor of it up to the scroller, is not an `input`, `select`,
  `textarea`, contenteditable, `canvas`, `embed`, `object`, `video`, `audio` or `iframe`;
- no element on that chain has a wheel listener that is not passive (`wheel`, `mousewheel`; the stage
  reads them with `DOMDebugger.getEventListeners` on the chain's elements; listeners of the window and the
  document do not count, as they do not stop the scroll of a scroller under them by default);
- the element under the point scrolls the target scroller (today's rule).

When no point of the scroller's visible part (a 5 x 5 grid, as `view()` tries) passes, the stage sends the
client's call as it is. **A round that does not move the scroller ends the notches**: after each round the
stage reads the scroller's scroll position, and when it did not change, it sends the client's call as it is,
so no notch goes to a page that does not scroll with it.

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

M1 (section 18) ran the same three planned paths in each column, with a press at the end, in two runs (the
column of 4 ms in the second run only). So the CDP form of the design (the second column) matches XTEST on
every measured signal except the count of predicted points: 2.3 to 2.7 against 1.8 to 2.1 here. The
research measured 1.86 to 2.71 for XTEST at 125 Hz, so the two ranges overlap, but in this probe CDP's
mean is higher in each step. Chromium predicts points from the samples and their times; the cause of the
difference is not known. A page can read it. The bar (review-96, N1): before part B, the pointer build
(ab-t30.3) must bring CDP's mean count of predicted points into the range that XTEST gives on the same
harness run and the same paths (this probe: 1.80 to 2.11), by the rate, the latency and the sample times.
After part B, the bar is the person's range. If ab-t30.3 cannot reach the bar, the lead brings the numbers
to the operator with two options: keep CDP and accept the difference (it is inside the research's XTEST
range of 1.86 to 2.71), or plan the X player for whole paths on Linux (section 9.3, point 4). Open point 3
(section 16) holds it until then.

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
   pointer build must bring into XTEST's range (section 9.1's bar). No field of one event differs (the
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
| The press point | an offset from the target's middle, a normal with a standard deviation of 1/8 of the target's smaller side, at most 1/4 of it; only for the targets of section 6.2's four conditions, else Playwright's point rounded | first value; part B's tasks 1 and 2 record the press points |
| The idle hand | none in the first build (Q4) | part B, task 6 |

### 10.2 Keyboard patterns (ab-t30.4)

| Part | The rule | First values (source) |
| --- | --- | --- |
| The hold | a lognormal per key, mean 116 ms, standard deviation 24 ms, from 50 to 250 ms | [19] |
| The time from one press to the next | a lognormal with the person's mean (an average typist: 239 ms, standard deviation 112 ms; a fast one: about 120 ms), with a part for each letter pair | [19], [20]; the letter-pair part from part B |
| Pauses | after a space: 20 to 120 ms more; after a mark (`.,;:!?`): 80 to 250 ms more; at a line's end: 200 to 600 ms more | first values; the research's K2 target (longer at word and line ends [19], [20]); part B |
| The speed in a session | the person's base speed times a slow drift from word to word (a factor from 0.85 to 1.15) | first value; ab-t30.4's "a speed that varies within a session"; part B |
| Rollover | when the next press comes before this key's release. With the hold and the base interval above alone, the share is only about 10% (review-96, N5; the probe's run 2: 1 overlap in 54 keys). The person's share (about 25% of keys for an average typist and about 50% for a fast one [19]) comes from the letter-pair part: common pairs typed with the two hands have short intervals. ab-t30.4 fits the letter-pair part until the share reaches the target (K3) | [19]; part B |
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

The service design's stage 0 (board ab-v16.94.1, agent-browser PR #95) merges before this design. From
stage 0, C11's master is agent-browser `docs/contracts/C11.md`. Its sections "One window per page" with the
bullets "The window comes forward for input" and "The pointer at an activation" have the same text as
chrome-extension `docs/protocol.md` at `66078cd`, which this design read. So the changes below go into
`docs/contracts/C11.md`, the new vectors go beside `test/vectors/control.json`, and the contract task (build
task 4, section 14) is a pull request in agent-browser only.

### 12.1 C11 (the endpoint)

1. **A new section, "The input stage (board ab-t30.6)"**, after "The pointer at an activation". It holds the
   rules of sections 4 to 8 of this design as contract text:
   - which calls the stage takes (section 4.2), the gate and the lock (4.3, 4.4), the answers and the early
     answer of a key release (4.5), the timestamps and the rate (4.6), the cases of no change (4.7);
   - each translation of the table of section 5, by CDP method and type;
   - the recognizers with their patterns, as `PLAYWRIGHT_FOCUS` is written today (section 5.2);
   - the constants: `STAGE_MOVE_MS = 8`, `STAGE_LATENCY_MS` = 3 to 5, `STAGE_EVENT_WAIT_MS = 2000`,
     `STAGE_MOVES_IN_FLIGHT = 8`,
     `STAGE_NOTCH_PX = 120` (Linux), `STAGE_TYPE_MAX_MS = 10000`, `STAGE_ACTION_MAX_MS = 25000`,
     `STAGE_SCROLL_ROUNDS = 4`, `CLIPBOARD_HOLD_MS = 500` (board ab-t30.19, which removed the 12 s of a key run),
     `STAGE_FLUSH_MS = 5000` (the flush of a collected part, review-126 B3), `V_READ_MAX_MS = 10000` (the limit of
     the wait for the paste's read after V's answer, board ab-t30.21);
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
6. **Vectors**: a new `test/vectors/stage.json` beside `test/vectors/control.json`: for each row of section 5,
   the client calls in, the events out (method, type, key fields; times as ranges), and the order of the
   answers, with a seed and a fake clock. The model's tests and the contract's tests
   (`test/contracts-c11.test.ts` of stage 0) read the same vectors.
7. **Dialogs** (section 4.3a): a client's `Page.handleJavaScriptDialog` goes to Chrome before the tab's gate
   and before every stage step; the stage's waits and reads have their limits.
8. **The MCP inside the service** (C11's section of that name, from stage 0): its configuration gets
   `timeouts.action: 30000` (section 6.3).

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
  events out, the order of the answers, from `test/vectors/stage.json`. Also: the gate (a `Runtime.evaluate`
  after a click waits for the release), the lock (two tabs' actions never interleave), the in-flight bound,
  the early answer (a later non-key call waits for the release), an error of an event (the plan stops, a
  held button is released), a dialog at a press (a `confirm()` in `mousedown`) and at a focus click (an
  `alert()` at the blur of the field before), with the client's dialog answer passing the gate, the miss
  watch and the recovery of section 6.6, the press point's four conditions, the wheel point's rule.
- **The recognizers and the decoder**: fixtures of Playwright's utility calls, captured for each pinned
  version (from the research's traces and from this probe's runs), the decoder of Playwright's serialized
  argument against them (the probe's run 1 had a wrong decoder: section 5.2), and a changed fixture that
  must pass unchanged.

### 13.2 Live tests with real Playwright (`test/live/`, local pages only)

- They run on the harness's own Xvfb and Chromium with the real receiver package, under the harness guard,
  as the agent-mode live tests do today, with `*.localhost` pages only. Playwright is installed in the run's
  scratch folder, not in `package.json`, for three pinned versions: the oldest that the C11 text names
  (1.64.1), the newest release (1.65.0 today), and the `playwright-core` of the service's pinned
  `@playwright/mcp` (with 0.0.85: `1.66.0-alpha-2026-11-09`, read in the probe's scratch install; the
  service design's M3 ran it). The recognizer fixtures come from the same three. A pin bump of the MCP runs
  them again, as its allow-list test does (review-96, B9).
- For each row of section 5: the action passes in Playwright with its default timeout, and the page's state
  is the same as with Playwright's own input on a second Chromium with no stage (the value of a field, the
  checked state, the count of clicks, the element in view, the files of an input). The recorder page
  (`recorder.html`) records the page's view for the harness.
- The cross-cases: a click whose path crosses a hover menu whose panel covers the target (M7); a hover on
  a target with a hover layer (M8); a hover in a same-origin frame (M10) and in a cross-origin frame; a
  click below the fold inside an inner scroller, with a number input, a canvas with a wheel handler and a
  frame inside it (the wheel point's rule; M11); a fill of exactly the limit and one character more; a fill
  with a line feed; a tag input and a field with an input mask (the named exception of section 7.2); a field
  in a cross-origin frame; a `dblclick` on a word in a text (at Playwright's point); a press of Enter that
  submits a form; a dialog at a press and at a focus click (M9); a date-picker input that opens at a click
  (open point 1); `dragTo` onto a drop zone that accepts the drop (M12).

### 13.3 The harness (ab-t30.2) and its measure for each gap

The harness scores the recorder's records of a live test run against a reference: until part B, real X
input on the same Xvfb (XTEST at 125 Hz, the probe's `source` scenario) and the literature's ranges; after
part B, the person's numbers.

| Gap | The measure | The bar (first values; the harness task sets them) |
| --- | --- | --- |
| P1 rate | samples per `pointermove` and predicted points | samples: within XTEST's range on the same run (M1: met); predicted points: the bar of section 9.1 (M1: not met yet, 2.3 to 2.7 against 1.80 to 2.11) |
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
| the hover's whole path before the setup (not only its samples outside the target) | the hover-layer case (M8: every attempt misses) |
| no miss watch, or no recovery at the next setup | the hover-menu case (M7: the click times out) |
| the way around that crosses the kept box | the hover-menu case |
| no limit of two recoveries | a unit test with a target that is always covered (the action must end in Playwright's own timeout, with at most two recoveries) |
| the press point's spread on any target (no four conditions of section 6.2) | the `click({ position })`, range input and `dblclick`-on-a-word cases |
| no hit test of a spread press point | a unit test with a target whose edge is near the spread point |
| typed keys into a contenteditable | a unit test of the typing rule (rule 1) |
| typed keys for a character with no US key | a unit test of the typing rule (rule 2) |
| a line feed typed as Enter | the chat-field case (two messages) |
| no residual of the notches | a unit test: ten calls of 100 px scroll the total within one notch |
| no end of the notches after a round that does not move the scroller | a unit test: a scroller under a non-passive `wheel` listener on the window that calls `preventDefault` (the wheel-point rule does not count window listeners); the notches end after one round |
| a wheel point over a number input or a frame | the number-input case (M11: the value changes) |
| no fallback after 4 rounds | a unit test with a scroller that moves a small distance in each round but does not bring the target into view in 4 rounds |
| no frame mapping (the hit point in the frame's own points) | the same-origin frame case (M10) |
| no release of a held button or key at an event's error | a unit test: an error at the press, then no button is down |
| no `STAGE_ACTION_MAX_MS` | the long `pressSequentially` case (it must not reach 30 s) |
| the modifier's release with no delay after the mouse release | R13 (the modifier's hold after the release) |
| no person's gap between the presses of a double click | R13 (the gap of a double click) |
| a later non-key call that does not wait for an early-answered release | a unit test: a `Runtime.evaluate` after `keyboard.type` sees every `keyup` |
| a client's `Page.handleJavaScriptDialog` in the gate | the dialog-at-a-focus-click case (M9: the fill times out) |
| a hold that counts from the press's answer | the dialog-at-a-press case (the hold grows by the dialog's time) |
| the plan goes on after its dialog closes | a unit test: a dialog at a press, then a client call after the close; no event of the plan goes after that call |
| a dialog that does not end the plan | a unit test: a `mouseover` handler on the path opens an `alert()`; the client's press and release go at once and the lock is free |
| an ended plan's client calls answered by the stage, not by Chrome | a unit test: a dialog that the client answers after 20 s; each input call answers only after Chrome's answer |
| no `GEOMETRY_WAIT_MS` limit, or no fail-open at it | a unit test: a read that never answers; the client's call goes as it is after 200 ms |
| no `STAGE_EVENT_WAIT_MS` limit | a unit test: an event whose answer never comes; at 2 s the held button is released, the lock is free, and the client's next call goes |
| no notches before the focus click on a field out of view | a unit test: a field below the fold gets notches before its focus click, and no `DOM.scrollIntoViewIfNeeded` |
| the stage's own `dragEnter` left out | the `dragTo` case (M12: no `dragover` and no drop) |
| the client's `dragEnter` sent as a `dragEnter`, not as a `dragOver` | the `dragTo` case (the page gets two `dragenter` events) |
| a pending release sent before its hold (the probe's run 1 fault) | K1 (a hold below 50 ms) |

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
4. **A new task, the contract text.** C11's changes of section 12.1 in agent-browser
   `docs/contracts/C11.md`, and `test/vectors/stage.json` beside `test/vectors/control.json`: a pull request
   in agent-browser only (from stage 0, PR #95). It merges before task 5, so the build follows a reviewed
   text (review-96, B12).
5. **A new task, the stage's pointer part.** `src/relay/stage.ts`: the gate step, the lock, the held
   answers, the dialog rules (section 4.3a), the timestamps and the rate, the in-flight bound, the paths for
   `mouseMoved`, the presses, the double clicks, the buttons, the modifiers, `delay` and `steps`, the hover
   rule and the frame mapping, the miss watch and the recovery (section 6.6), the press point's conditions
   and hit test, the catch-up's merge, the activation before a path (C11 change 2). Tests: the stage's unit
   tests and vectors for the pointer rows; the live rows with the three Playwright versions of section 13.2;
   the harness for R1, R2, R9 to R13; the mutations.
6. **A new task, the stage's keys and text.** The key runs, the Shift key and its order (section 4.5), the
   early answer of a release, the typing rule of section 7 with its limits and the named exception, the focus
   and fill recognizers (also on a cross-origin frame's session) and the focus click with its scroll,
   `clear`, chords, `delay`. Tests: as task 5, for the key and text rows; R3, R4, K1 to K4.
7. **A new task, the stage's scroll and wheel.** The notches with the residual, the translation of
   `DOM.scrollIntoViewIfNeeded` with the wheel point's rule and the end after a round that does not move,
   the frame case, the Mac's pass. Tests: as task 5; R5, R6, P7.
8. **A new task, the script calls.** By Q3's answer: the select-text and focus translations, the file
   chooser click for `DOM.setFileInputFiles`, the drag path for `dragTo` (with a live case on a drop zone
   that accepts the drop), and the pass or refusal of the other script calls. Tests: as task 5; R7, R8, R14,
   R15.
9. **A new task, part B's parameters** (after ab-t30.7). `src/human/fit.ts`, the new parameter files, the
   harness's bars against the person, the Mac's wheel model (section 8.5), and Q4's choice. Tests: the
   fit's unit tests; the harness against the person's numbers.
10. **ab-t30.5, the live test** on forum.bearchive.com from the operator's Mac Chrome, last, under its own
    rules. The design recommends to the lead that ab-t30.5 also waits for task 9, so that the input is
    measured against the operator's own recording before the live test.

The stage's tasks 5 to 8 and board ab-t30.19 (section 7.5) merge together or not at all into the default path: until
all five are merged,
the stage stays off behind a build switch, so that no partial translation reaches a client ("don't do this
half baked").

## 15. Questions for the operator

Each question gives its options, their effects, a recommendation, and what the build does with no answer.

**The answers (board item ab-0z5, 2026-11-10).** The operator answered all four questions on 2026-11-10
(confirmed, with a web login), with no note. Each answer is option a, the recommendation. The build follows
these answers:

- **Q1: a.** The stage shapes the input of every client on every site in agent mode. No list, no switch and
  no new C12 op; no change in agentwatch for the stage (section 12.3).
- **Q2: a.** A text that fits in 10 s is typed; a longer text goes as one text with no keys (section 7.3).
  `pressSequentially` goes to the fast end after 12 s and to Playwright's own speed after 25 s.
- **Q3: a.** A script call is translated where a person's input gives the same result, and the rest pass and
  are counted (section 5.1 and build task 8). The parts that need a probe (a select's popup and CDP keys)
  pass until the probe is done. **Built** for a select, a picker input, a range input, selectText, focus and blur by board
  task ab-t30.12.1 (its probe: the popup takes CDP keys; section 5.1; C11, the script calls).
- **Q4: a.** No idle moves. The harness measures P6 against part B and reports it; a change needs a new
  decision of the operator (build task 9).
- **Board item ab-8fu: a paste for a long text.** The operator answered on 2026-11-12 (confirmed): "can we do a
  simulated copy/paste for long text input? and we use a person typing for short input only?" Board task
  ab-t30.19 builds it (a long text as a person's paste, a person's typing for a short text only). **Built** by board
  task ab-t30.19 (section 7.5; C11, the collected keys and the paste).
- **Board item ab-2qb: no fast end for a text.** The question: "A text that a person can type in 10 s only at their
  fastest speed: should the agent browser paste it instead?" The operator chose (2026-11-13, confirmed): "Paste it":
  "Only a text that fits in 10 s at a person's usual speed (about 40 to 50 characters) is typed. Every longer text
  goes as a person's paste. The key times look more like a person's (recommended)." Board task ab-t30.20 builds it
  in PR #126 (the review-126 round of board task ab-t30.19): a text is typed only when its plan at the person's
  speed fits in what is left of `STAGE_TYPE_MAX_MS`, and every longer text goes as a person's paste, with the
  fallbacks of section 7.5 (section 7.2, rule 3; C11, the typing rule's rule 3). The words of Q2 a and of board item
  ab-8fu above stay as they are.

The questions below stay as the operator read them.

**Q1. Does the stage shape the input of every client and every site in agent mode?**

- **a. Yes, always, for every client and every site (recommended).** A click takes about 1 to 1.6 s (2.6 s
  with a long scroll; M3) and typed text about 5 characters a second (M5), so a long agent task takes longer
  than with plain Playwright. A test of `@playwright/test` with 15 to 20 clicks and a 60-character fill
  can go over its default 30 s test timeout through agent mode; its owner must raise that timeout (for example to
  120 s; section 6.3). No site and no client needs a setting, as "the caller doesn't worry about it" says. A
  check like a click box can appear on any site, so the agent never knows in advance where it matters. No
  change in agentwatch.
- b. Only for the sites of a list that the operator keeps on the Browser pane; plain Playwright speed on
  other sites. Faster on most sites; a check on a site that is not on the list sees plain Playwright input.
  It needs a new op on the control door (C12) for the list and a change of agentwatch's Browser pane.
- c. Always, with a switch for each scope on the Browser pane that the operator can turn off (for example,
  for a test run). The default stays a. It needs a new C12 op and a change of agentwatch's Browser pane.
- No answer: a.

**Q2. What does the stage do with a long text for `fill`, `insertText` or `pressSequentially`?** (section
7.3) A person types about 4 to 8 characters a second, and Playwright's default action timeout is 30 s.

- **a. Type a text that fits in 10 s (at the person's speed, or else at the fast end of the person's
  spread), and insert a longer text as one text (recommended).** `fill` types up to about 80 characters; a
  longer text goes as one `input` event with no keys (as a paste with no paste event). `pressSequentially`
  goes to the fast end after 12 s; after 25 s (about 170 characters) the rest goes at Playwright's own
  speed. No client action reaches its timeout.
  (A note of board ab-t30.18, not the operator's words: measured, a `pressSequentially` of more than about
  850 characters still reached Playwright's 30 s timeout through the stage, fewer on a busy box; board task
  ab-t30.19 built the operator's later answer on board item ab-8fu, section 15: a long text goes as a person's paste,
  and that bound went away.)
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

- **a. No idle moves (recommended).** A move that no client asked for can open a hover menu or start a
  page's own handlers, so the client's next action can meet a changed page; a person's resting hand on a
  desk mouse makes few or no moves. The harness still measures P6 against part B and reports it; a change
  needs a new decision of the operator.
- b. Idle moves from the first build: small moves at rest, only over parts of the page with no hover
  handlers that the stage can see. A page sees a living hand; a client's next action can meet a changed
  page, and the stage needs a rule for that.
- c. No idle moves now; build task 9 adds them with no new question when part B shows that the operator's
  hand moves at rest (P6 above a bar that task 9 sets from part B's task 6). The build is a now, and b later
  if the numbers say so.
- No answer: a.

## 16. Open points

The review of this design (review-96) found points 1 to 5, which the fix round did not settle; the review of the
harness (review-97, ab-t30.2) found point 6, and board ab-t30.19 added point 7. Each names what the build must show. The operator sees them with the
questions.

1. **A widget that a click opens** (review-96, B1 c). The stage's focus click is a click, where Playwright
   uses a script focus. A text field whose click opens a picker or a list (a date-picker library, a
   combobox) can leave that widget over the next target, and Playwright's script focus would not open it.
   Section 6.6's recovery moves the pointer off a covering element, but a widget that stays open until
   Escape or an outside click stays. Build task 6 must show, on a date-picker input and a combobox of the
   live tests, whether the next action passes; if not, the options are: send Escape after a focus click that
   opened a new element over the page (an input of its own), click an empty part of the page (a click with
   its own effects), or use Playwright's script focus for such fields (the signal stays).
   **Answered** (board item ab-pf8, the operator, 2026-11-12: "Focus such fields without a click"): a field with a
   widget sign gets no focus click, and Playwright's script focus goes as the client sent it, as with Playwright's own
   input; after each focus click the stage counts the new elements that cover the area near the field (count only).
   Built by board ab-t30.18; C11, the focus click, names the signs.
2. **The named exception of section 7.2** (review-96, B4). A page's key handler can make the value differ
   from Playwright's `fill`. Build task 6 must report the tag input and the input mask of the live tests;
   if the operator wants "the same result" always, `fill` goes as one `insertText` (Q2 c's effect for every
   length).
   **Answered** (board item ab-pf8, the operator, 2026-11-12: "Keep typing, as a person does"): the typed keys stay
   (Q2 a), with the named exception and its value check; no change.
3. **Predicted points** (section 9.1; review-96, N1). CDP gives more predicted points than XTEST
   (2.3 to 2.7 against 1.80 to 2.11 here). Build task 2 (ab-t30.3) must reach the bar of section 9.1, or the
   lead brings the numbers and the two options to the operator.
4. **A hover or a click in a cross-origin frame, `dragTo` onto a drop zone that accepts the drop, and the
   press point's spread** are designed but not measured. Build tasks 5 and 8 measure them in the live tests
   before their merge.
5. **Dialogs during a plan** (review-96b, F1). Section 4.3a ends a plan at a dialog and at
   `STAGE_EVENT_WAIT_MS`, and sends the client's own events at once. It rests on one fact that the probe did
   not measure: Chrome keeps input events, and holds their answers, while a dialog is open, and then gives
   them to the page in order after the close. Build task 5 must measure this. Its unit tests must show a
   dialog at a press, a dialog between two moves of a path, and a dialog that a client answers after 20 s;
   in each, no event goes after a later client call. If Chrome drops input events during a dialog, the
   client's calls of the ended plan get an error that names the dialog.

   This rule is the lead's choice between the two rules that the fix round left in disagreement. The options:
   - **a. End the plan, and send the client's own events at once (kept in section 4.3a).** The page gets
     what the client asked for, in the client's order, as with Playwright's own input. The rest of the path
     and the person's timing of the press and the release are lost for that one action.
   - b. Pause the plan while the dialog is open, and go on after the close (the fix round's first text). The
     person's timing stays, but a client that keeps working during the dialog (the Playwright MCP waits for
     the model's dialog tool, often longer than 2 s) can then see the plan's old events after its later
     calls.
   - c. End the plan, send only the releases, and answer the client's open calls with an error that names
     the dialog. No old event can reach the page, but a click that a dialog interrupts fails where
     Playwright's own click goes on after the close.

6. **The bar of P1's samples per `pointermove`** (review-97 of the harness, ab-t30.2). Section 13.3 says "within
   XTEST's range on the same run". The harness scores the source's mean count against XTEST's per-path range widened
   by 0.15 (about three standard errors of one path's mean over about 60 moves). This is the lead's choice between rules
   that do not agree. The numbers of the harness's runs on taylor (2026-11-10):
   - One XTEST path's mean count varies by up to 0.06 between runs on the same planned path: M1's path to `#b` gave
     1.95, 1.89, 1.95 and 1.92 (M1's runs 1 and 2, the harness's runs 3 and 4). M1 run 2's range of three paths (1.89
     to 1.93) is narrower than that.
   - With no margin, XTEST fails against itself across runs: the harness's run 4 gives a mean of 1.931 over its six
     paths, above M1 run 2's range of 1.89 to 1.93.
   - On the same paths, the design's CDP form gives fewer samples per `pointermove` than XTEST: 1.81 to 1.83 against
     1.90 to 1.93 (run 4), and 1.83 to 1.84 against 1.87 to 1.97 (run 3). The share of moves with one sample is 0.16 to
     0.18 for CDP against 0.07 to 0.09 for XTEST. The margin of 0.15 passes this difference. The range with no margin
     does not.

   The options:
   - **a. XTEST's per-path range widened by 0.15 (the lead's choice; the harness uses it).** XTEST passes against
     itself across runs. CDP's lower count on the same paths also passes.
   - b. XTEST's per-path range with no margin. XTEST fails against itself across runs (above), and the design's CDP form
     fails in every run (M1: 1.73 to 1.86 against 1.87 to 1.97).
   - c. A two-sample KS test of the per-move counts (the distribution of `nc`) on the same paths. Runs 3 and 4: D 0.092
     and 0.089 against a bound of 0.141 on the same paths (pass); on M1's other CDP paths, D 0.136 and 0.159 against
     0.140 and 0.139 (one pass, one fail). The counts take only the values 1, 2 and 3, so the test is conservative with
     its ties.

   Build task 2 (ab-t30.3) reports this row with the bar in force, and the numbers of options b and c.

7. **The paste on the Mac, and a live view** (board ab-t30.19). Chrome on the Mac shares the operator's own clipboard
   (the system's pasteboard), so the stage never pastes there: a long text goes as Playwright's own input (the client's
   `Input.insertText`, or the client's own keys of a collected part), as before the paste. Stage 4 (the Mac) needs its
   own rule: for example a paste through a pasteboard of the agent browser's own, or no paste. And a live view of the
   service's display (none exists yet) must not carry the display's CLIPBOARD selection to a viewer (as a VNC server's
   clipboard sync does), or the operator's own clipboard would get each pasted text.

## 17. What this design does not cover

- The Mac's own numbers: event times, the trackpad, the wheel, fractional points on a Retina screen (part B;
  the research, section 9).
- An input method, dead keys, and typed keys in a contenteditable (section 7.3).
- Typing errors and their corrections (K5).
- Touch and pen input.
- The points of section 16 (open points).
- Internal names of Playwright versions other than the three of section 13.2 (section 5.2).
- What a click box's scripts read: this design matches what a script can read (the research, section 1).

## 18. The measurements

The probe ran on taylor (Debian 13, Linux 6.12.115, Node v26.12.0, Debian Chromium 156.0.8078.79,
playwright-core 1.65.0 in a scratch folder) in a private Xvfb on display 169 (1920 x 1080 x 24, no window
manager, its own X authority file), under the box's shared heavy lock and the repository's harness guard.
Each scenario started its own Chromium on a new profile, which the probe removed at the scenario's end.
Only `rec.localhost`, `box.localhost` and `cases.localhost` were reachable. The probe's README gives the files and the
command; `results/` holds the runs.

Four runs: run 1 (02:15 to 02:16 UTC on 2026-11-10), run 2 (02:33 to 02:35 UTC), and runs 3 and 4 (03:18 and
about 03:35 UTC) of the review's cases (scenarios `cases-raw` and `cases`, M7 to M12). Run 3's menu was
narrow, so the stage's random path missed its trigger in the step with the recovery; run 4 (the code in the
folder) has a wider menu, and its numbers are the ones below; run 3's other results were the same (run 3's files are not kept). Run 1's
stage had two faults of the probe, which run 2 fixed: its decoder read Playwright's argument in a wrong form,
so its hover recognizer missed and both of its hovers went the naive way; and its events carried the send time
with no latency. The folder holds run 4's code; its `stage` scenario sets run 2's options (the hover's whole
path before the setup, no recovery, no frame mapping), so it gives run 2's steps again. Where runs 1 and 2
measured the same thing, a value is a range over both runs. Each step's numbers come from the input
research's `analyze.ts` (`results/run-2-summary.json`) and from the probe's own counts
(`results/run-2-extra.json`, `results/run-4-extra.json`).

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
100 px, no movement that does not match the point, no event later than its handler, no untrusted event.
Samples per `pointermove`: 1.44 to 1.88 over both runs (run 1's double click 1.44; run 2 alone: 1.65 to
1.88).

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

**M7 to M12: the review's cases** (run 4; a page of the probe's own, `cases.localhost`; Playwright with a 6 s
timeout; the stage prototype with the rules of sections 4.3a, 5.3, 6.2 and 6.6, each one off in one step).

| Case | Playwright's own input | The stage with the rule off | The stage with the rule |
| --- | --- | --- | --- |
| M7: a click on a button under a hover menu's panel, from above the menu | passed, 0.10 s | failed at 6 s: the path opened the panel, the press hit it (a miss at the stop), and 13 more setups missed (the pointer stayed in the panel; no input) | passed, 2.4 s: one miss at the stop, then the recovery at the second setup moved the pointer out of the menu's root, and the second attempt's press hit the button |
| M8: `hover()` on a card whose `:hover` shows a layer over its middle | failed at 6 s (the layer covered the hit point at the first `mousemove`) | the whole path before the setup: failed at 6 s, 11 setups missed | the samples outside the card before the setup: passed, 0.58 s, one setup |
| M10: `hover()` on an element of a same-origin frame (no session of its own) | passed, 0.13 s | the hit point in the frame's own points: failed at 6 s (4 setups, 3 misses at the stop) | the hit point mapped to the top page: passed, 0.72 s, one setup |
| M9: `fill()` of a field while the field with the focus has `onblur="alert(...)"` | passed, 0.03 s (Playwright dismissed the alert) | the client's dialog answer in the gate: the fill's step did not end in 25 s (the record cannot show the fill's own 6 s error: the probe's log call waits behind the same gate), and the page's later calls waited until the probe dismissed the alert at 25 s | the dialog answer passes the gate: passed, 1.1 s, with the focus click and 3 typed keys |

In M7 the second attempt's path went straight from the exit point to the button, so the way around (rule 4
of section 6.6) did not come into play; its unit test is in build task 5.

M11, a wheel notch over a number input (`cases-raw`, CDP only): with no focus, the value stayed 5 and the page
scrolled 43 px; with the input focused (by a press), a notch down set the value to 4 and a notch up to 5,
each with a trusted `input` event, and the page did not scroll.

M12, the drag events (`cases-raw`, CDP only, `Input.setInterceptDrags`): with a `dragEnter` before the
`dragOver` events and the `drop`, the page got `dragstart`, `dragenter`, 4 `dragover`, `drop`, `dragend`; with
no `dragEnter`, it got only `dragstart` and `dragend`: no `dragover` and no `drop`.

**The facts of this design and how they were checked.** Facts from the code were read in `playwright-core`
1.65.0 (and 1.66.0-alpha-2026-11-09, the playwright-core of `@playwright/mcp` 0.0.85), in a scratch install:

| Fact | How it was checked |
| --- | --- |
| The hit-target event sets (click: `mousedown`, `mouseup`, `pointerdown`, `pointerup`, `click`, `auxclick`, `dblclick`, `contextmenu`; hover: `mousemove`); the first event decides; a miss stops later events | read: `setupHitTargetInterceptor`; probe: M4, M7, M8 |
| Each attempt checks the hit point in the setup before input; retries after 0, 20, 100, 100, 500 ms; the scroll cycle `[none, end, center, start]` by the attempt number modulo 4 | read: `_retryAction`, `_retryPointerAction`, `_performPointerAction`; probe: M7 (13 missed setups with no input) |
| A frame's hit point is in the frame's own points; a transformed frame gives none | read: `_checkFrameIsHitTarget`; probe: M10 |
| A same-origin frame's utility calls come on the top page's session | probe: M10 (the stage saw them on the page's session) |
| A click's move, press and release come together; `delay` and `steps` make them sequential | read: `Mouse.click`; probe: M3 |
| `ensureModifiers` presses a modifier after the setup and waits for its answer before the move | read: `_performPointerAction`, `Keyboard.ensureModifiers`; the research's run 3 trace; probe: M3 |
| `keyboard.type` presses each key and waits; `delay` is a wait between down and up | read: `Keyboard.type`, `Keyboard.press` |
| `fill` selects by script, then one `Input.insertText` with the whole text (a line feed too); date and similar inputs get a script value | read: `_fill`, `injected.fill`, the input type sets; the research's trace |
| The serialized argument's form (plain strings, numbers and booleans) | read: `serializeAsCallArgument`; probe: run 1's fault and run 2's fix |
| `page.mouse.*` and `page.keyboard.*` have no timeout; actions 30 s by default | read: the client's `kNoTimeout`, `TimeoutSettings`, `DEFAULT_PLAYWRIGHT_TIMEOUT` |
| The MCP's action timeout is 5 s by default | read: the `@playwright/mcp` 0.0.85 README (`--timeout-action`) |
| `dragTo` has `steps`, `sourcePosition`, `targetPosition`; the drop replaces the release | read: `dragAndDrop`, the drag manager's `drop` |
| Chromium needs a `dragEnter` before `dragOver` and `drop` | probe: M12 |
| A wheel notch changes a focused number input's value | probe: M11 |
| A dialog stops the answers of input events until it closes | probe: M9 |
| `@playwright/test`: no action timeout and a 30 s test timeout by default | not read in its code here (the `@playwright/test` package is not in the scratch install); its documented defaults |

**The limits of the measurements.** The design rests on these numbers only within these limits:

- One Chromium (Debian Chromium 156) on Linux, in an Xvfb with no window manager; XTEST, not a hardware mouse
  (the research's limit); nothing on the Mac.
- The prototype is not the stage: it had no input lock, no activation step, no in-flight bound and no model.
  Its bridge was Chromium's pipe, not `chrome.debugger` through the agent extension. The stage's build
  measures these in the live tests (section 13.2).
- The prototype's model parameters are its own (M5), not all of the first values of section 10.
- Not run: the whole `dragTo` through the stage (M12 sent the drag events by hand), a hover or a click in a
  cross-origin frame, the press point's spread and its hit test, the wheel point's rule, `setInputFiles`,
  `selectText`, `focus` on a text field, the two other Playwright versions of section 13.2, and the MCP
  inside the service.
- The review's cases (M7 to M12) ran in two runs (3 and 4) on pages of the probe's own; the numbers are run
  4's. The way around of section 6.6 rule 4 was not exercised.

## 19. Sources

The numbered sources [7], [13], [14], [17], [18], [19], [20] are those of the research
([2026-11-09-click-box-input-signals.md](../../research/2026-11-09-click-box-input-signals.md), section 11).
The Playwright facts come from the code of `playwright-core` 1.65.0 (`setupHitTargetInterceptor`,
`_retryAction`, `_performPointerAction`, `Mouse`, `Keyboard`, `RawMouseImpl`, `RawKeyboardImpl`, the drag
manager, `fill`, `TimeoutSettings`) and from the README of `@playwright/mcp` 0.0.85 (`--timeout-action`),
read in a scratch folder.
