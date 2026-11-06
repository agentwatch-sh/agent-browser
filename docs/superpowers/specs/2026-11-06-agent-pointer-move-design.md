# The agent display's pointer, moved by the daemon at the relay's request — design

Date: 2026-11-06. Status: **reviewed and merged** (agent-browser PR #63, merge `6bb6838`): revision 5,
after five fresh reviews (review-63, 63b, 63c and 63d at `b340c26`, `1d29201`, `f42f714` and `19307c0`,
and review-63e at `cd415cb`) and aw-lead's answers (mails mb5c6cbf, m98c6f1f, m2933af4 and md133a6e),
with aw-lead's yes to sections 2 and 4 (mail mbf51aeb); review-63e's doc notes A to C are in the text.
Its contract text is chrome-extension PR #29 (board ab-v16.70: C10 and C11, with the vectors); its build
is board ab-v16.71 (the relay), with agentwatch task age-0kh.28 (the daemon). Author: taylor session
`pointer-design`, a subagent of `ab-lead` (board task ab-v16.37). Sources: agent-browser main `6e51439`
(`src/input.ts`, `src/record.ts`, `src/relay/`, the README), chrome-extension main `37b5647`
(`docs/protocol.md` C4, C10, C11), agentwatch main `18609d80` (read only: `agentwatch/daemon/browser/`,
the agent-browser design's section 5.6). No browser ran for this task. The numbers are those of
ab-v16.26 (PR #47) and ab-v16.28 (PR #44).

**The problem.** When a window comes forward, the X server gives its page a real pointer event, with no
movement, at the X pointer. CDP input never moves the X pointer. Where agent-browser owns the display,
ab-v16.26 moves the X pointer (`xdotool mousemove`) as the last step of each path, so the next activation
enters where the page last saw the pointer: `run.ts design` measured 0 jumps over 100 px and 0 position
changes that the movement does not explain (4 runs, then 2, 1 and 1 after the reviews of PR #47).
Through agentwatch's relay no process has the Xvfb's `DISPLAY`, and the fallback runs: `design-no-x`
measured 5 unexplained position changes in 6 activations. aw-lead (mail m4f38c16) refused `DISPLAY` and
`XAUTHORITY` for agents and proposed the narrow way that this design settles: the daemon, which owns the
Xvfb, moves the pointer itself on a small request from the relay. The Result of ab-v16.37: no pointer
jump at a window activation, in any page.

Three facts carry the design. (1) The activation's real event has no movement and comes at the X pointer
(ab-v16.26: "the real event where the window came forward (no movement, at the page's last point)").
(2) Chrome gives a real move under the pointer its movement from the page's last point, not from the X
pointer's last place (ab-v16.26: a move to the point where a CDP path ended had movement 0). (3) Chrome
merges the moves that come in one frame into one event and adds their movement (review-63b note 16; not
measured here), so the limit is on what one frame can hold, not only on one step.

## 1. The answer in short

1. **The messages (section 2):** two C10 ops that the daemon answers itself. `daemon.movePointer`
   carries a person-shaped path in display pixels; the daemon checks that nobody else moved the pointer
   from `at` (its last known place), plays the path with one `xdotool` script, and answers the pointer's
   position. `daemon.pointerAt` reads the pointer's position. Not C4: the receiver has no part in them.
2. **The path (section 3):** when a page comes under the pointer and a path can play, the relay holds
   the front page's input, plans a path with `src/input.ts`'s generator from the last point of the page
   under the pointer (the page that leaves) to the last point of the page that comes forward, inside the
   leaving page's viewport, and waits for its end before the window comes forward. The end is both pages'
   last point.
3. **Continuity (section 3):** after a path or an entry changed a page's point, a client's next pointer
   event far from that point gets a person-shaped CDP catch-up path first.
4. **The checks (section 4):** the relay's pipe, the unit's Xvfb and its size, each point inside it, steps
   of at most 50 px 16 ms apart, the pointer at `at`, one X call at a time, 5 paths a second, a deadline.
5. **What a site sees (section 5):** both pages see a person's input. When the relay cannot know a
   page's point, it sends no path, and that one activation is as today (no jump; one unexplained change
   at most). With the paths off (an older daemon) the relay is exactly as today. On the Mac nothing moves.
6. **No raw X (section 6)** for any agent.

## 2. The messages (C10)

**They belong to C10, "The daemon and the relay".** C4 is the daemon's link to the receiver (native
messages); the receiver has no X access. C10 already holds the relay's requests on its standard output,
the daemon's own answers and lines, and the daemon already reads each relay line. So these are two more
ops on that pipe that the daemon answers itself: no new channel or socket, and only the relay, the
daemon's own child, writes there. C11 gets one paragraph (section 3).

**The daemon side (aw-lead's answers).** The prefix `daemon.` is reserved. The daemon handles a `daemon.`
op in `from_relay` after the parse and the duplicate-id check, before the link checks, outside the queue
and `MAX_BYTES_IN_FLIGHT`; it never forwards any `daemon.` op, and it answers an unknown one `unknown op`
itself. The X calls run in their own task, one at a time, off the carrier's read lock (so no bridge line
waits for them). Each runs `xdotool` by absolute path, with no shell, with an environment of only
`DISPLAY=:N` and `XAUTHORITY=<the unit's X auth file>`, with no `--sync`; its commands come from the
checked integers only. A missing `xdotool` is `no display`; a failure is read from the exit code, not
from standard error. The daemon kills a playing path at a relay end (the relay's epoch changes; no
answer), a unit stop (`no display`; the kill comes before the unit's stop steps), a link change
(`disconnected`) and its own stop. After a kill or any failed X call the pointer's place is unknown.

**`daemon.pointerAt`**, args `[]`: `{"x":<int>,"y":<int>,"width":<int>,"height":<int>,"views":<int>}`. One
`xdotool getmouselocation` (1 s timeout, at most 10 a second, `busy` while a path plays). `width` and
`height` are the running Xvfb's size; `views` is the count of the operator's live-view inputs (0 while
there is no live view). The relay also sends it at each link up as a probe.

**`daemon.movePointer`**, one arg:

```json
{"at":{"x":812,"y":431},"from":{"x":640,"y":410},"path":[{"x":652,"y":405,"dt":16},{"x":671,"y":398,"dt":16},
 {"x":700,"y":402,"dt":33}],"width":1280,"height":900,"notAfter":5839201300,"views":0}
```

- `at` (required): the X pointer's place as the relay last learned it (its last `ok` answer, `pointer
  moved` data or `daemon.pointerAt` answer): integers in `0..width-1` and `0..height-1` of the request's
  `width` and `height`, else `bad args`. A relay that
  does not know the place (its start, a link change, a failed or killed path) sends `daemon.pointerAt`
  first.
- `from`: the path's start, the point where the page under the pointer last saw it (section 3). It is
  not played; the first step is measured from it. The first move warps the pointer from `at`, which no
  page sees (fact 2).
- `path`: 1 to `POINTER_PATH_MAX_POINTS = 120` points `{x, y, dt}`, integers (120 is the parse bound;
  with `dt` of 16 ms or more and 1500 ms at most, a path holds at most 93: 93 x 16 = 1488 ms). `dt` is
  the wait in ms before that point's move, `POINTER_DT_MIN_MS = 16` to `POINTER_DT_MAX_MS = 250`; the sum
  of the `dt` is at most `POINTER_PATH_MAX_MS = 1500`. Each step (from `from` to the first point, then
  point to point) is at most `POINTER_STEP_MAX_PX = 50` px, so that two steps that Chrome merges into one
  frame (fact 3) stay within the probe's jump rule (100 px). Every point is inside the display.
- `width`, `height`: the screen size that the relay used (the pages' `screen.width`, `screen.height`).
- `notAfter`: integer ms on `CLOCK_MONOTONIC`, which every process of the box shares, so a wall-clock
  step does not change it. The relay reads it with `process.hrtime.bigint()` (Linux), never
  `performance.now()`; the daemon with `time.monotonic_ns()` (injected for its tests). It is `bad args`
  when negative, not an integer, or more than 2000 ms ahead. The daemon starts no path after it.
- `views`: the `views` that the relay last read (see `not now`).

**The play.** The daemon first reads the pointer (`getmouselocation`). When it is more than 2 px from
`at`, someone else moved the pointer (the live view, another program on the display): it plays nothing
and answers `pointer moved` with the read position. The daemon keeps no state. Else it checks `notAfter`
and runs one script on `xdotool -` (standard input, one command a line; an argv only if the live check
finds that standard input fails): `sleep <dt1/1000>`, `mousemove <x1> <y1>`, ..., `getmouselocation`.
The timeout is the path's total time plus `POINTER_KILL_MS = 1000`; at the timeout the daemon kills the
call and answers `no display`. The operator's live-view input kills a playing path too, which answers
`not now`. The ok answer comes after the last point: `{"x":<int>,"y":<int>,"views":<int>}`, the pointer's
position read at the end. The live check measures how well `xdotool sleep` keeps `dt`, and the build adds
the numbers here.

The answers have C10's `res` shape. C10 gets a general rule: an error `res` of a `daemon.` op may carry
`data` (an object), and a reader ignores `data` on an error that it does not know; the daemon sends `data`
only with `pointer moved` (`{"x","y","views"}`). The errors, in the order of the checks:

| Text | Op | When | The pointer |
| --- | --- | --- | --- |
| `unknown op` | both | a daemon from before this change (its receiver answers it), or an unknown `daemon.` op | not moved |
| `bad args` | both | not exactly the fields above, a limit above broken, `at` outside the request's `width` and `height`, a bad `notAfter` | not moved |
| `no display` | both | no unit Xvfb (also on the Mac), no `xdotool`, or an X call failed or was killed | place unknown |
| `wrong display` | move | `width`, `height` are not the running Xvfb's size | not moved |
| `out of bounds` | move | a point or `from` outside `0..width-1`, `0..height-1` | not moved |
| `busy` | both | another X call of the daemon runs | not moved |
| `not now` | move | when the live view exists: `views` is not the current count, or the operator's last live-view input is less than 10 s old; or that input killed the playing path | not moved, or place unknown after a kill |
| `too many moves` | both | 5 paths (move) or 10 reads (read) started in the last second; refusals do not count | not moved |
| `pointer moved` | move | the read before the play is more than 2 px from `at` (with `data`) | not moved by the op |
| `too late` | move | the clock is past `notAfter` when the play would start | not moved |

**The ops table rows, the waits and the key** (aw-lead's answer 6). C10 says that the relay sends each
op's default wait; these two ops are the exception. `daemon.pointerAt` has the wait 1200 ms.
`daemon.movePointer` has, per request, `POINTER_START_MS` (300, the lead of `notAfter`) plus the path's
total time plus `POINTER_KILL_MS` plus `POINTER_SLACK_MS = 200`. Both have the in-flight key `pointer` of
their own, so the shared key's queue never holds them back. `Bridge.call` gets a per-call wait, and for
these ops a timer of the relay: at the wait it goes on and drops a late answer. No path can still play
then: it started at the latest at `notAfter`, and the daemon killed it `POINTER_KILL_MS` after its total
time.

## 3. The relay

The relay does this only where it opens a window per page (`windowPerPage`, Linux), for every client: it
sees every client's input. No client method reaches a `daemon.` op.

**What it keeps** (in memory):

- **The pages' last points**, in client CSS px, keyed by target id: the point that Chrome last saw in the
  page. A client's `Input.dispatchMouseEvent` and `Input.dispatchDragEvent` (every type but a wheel) on
  the tab's own session set it when the call is sent to Chrome. A wheel event more than 2 px from it, a
  child session's pointer input (a frame's own space) and touch input (`Input.dispatchTouchEvent`,
  `Input.emulateTouchFromMouseEvent`, `Input.synthesizeTapGesture`, whose mouse events the relay does not
  model) make it unknown. A catch-up move sets it when sent. The X records of the activation step set it
  too, and mark it as an X record (for the catch-up). A point goes at `tabs.onRemoved` and
  `tabs.onReplaced`; a link change keeps the points of the targets that step 3 of the link up lists
  again (a Chrome restart gives new target ids).
- **The pointer's place (`at`):** from the last `ok` answer, `pointer moved` data or `daemon.pointerAt`
  answer. It is unknown at the relay's start, at a link change, and after a failed or killed path or the
  relay's timer; a step that needs it then sends `daemon.pointerAt` first.
- **The front page:** the page under the pointer. It is the page of the relay's last activation step. A
  new tab that opens a window, or that becomes the active tab of the front page's window, is the front
  page then (it comes on top), with no last point. The front page is unknown at the relay's start, at a
  link change, at `tabs.onRemoved` or `tabs.onReplaced` of the front page, after a step whose raise
  reached its limit, and after any client's `Browser.setWindowBounds` (a `"normal"` state can bring a
  minimized window on top).
- **The held buttons:** a tab holds a CDP button from a `mousePressed` until Chrome answered its
  `mouseReleased`. The hold also ends at `tabs.onRemoved`, at a link change, when the client's connection
  closes, at `debugger.onDetach`, and at the relay's reattach after a timeout.
- **On, off or unknown:** the state is unknown until the first answer of the probe, `daemon.pointerAt`,
  which the relay sends at each link up. An answer turns the paths on, and gives `at`, the display's size
  and `views`. `unknown op`, `wrong display` and a link-down error of an older daemon (`not connected`)
  turn them off until the next link up; `no display` for 60 s. `busy`, `too many moves`, `disconnected`
  and the relay's own timer leave the state unknown, and the next step that needs the paths probes again
  (after a link drop the daemon can still play the last path while `Bridge.dropAll` answered it). Each
  time the paths turn on, the front page is unknown: while they were off or unknown, raises went as
  today. **While
  the paths are off, the relay is exactly as today**: no world, no geometry read, no wait, no catch-up, no
  path, and `Page.bringToFront` and `Target.activateTarget` go as they go today.

**The activation step** (`src/relay/model.ts`, `activate`; one step at a time for all connections).
Today it reads and acts in turn (`tabs.get`, `tabs.update`, `windows.get`, `windows.update`) for the
inputs that C11 names; a client's `Page.bringToFront` goes to Chrome as a page call, and
`Target.activateTarget` is a direct `tabs.update`. With the paths on, the build routes those two through
the step too: they wait for the chain and for their tab's gate, as `forward()` makes an input wait, and
answer after the step.

1. **Read** the tab (`tabs.get`) and its window (`windows.get`).
2. **Decide.** With the front page known, a page comes under the pointer when it is not the front page
   (the relay's own activation and `Page.bringToFront`), or, for `Target.activateTarget`, when its tab is
   not active and its window is the front page's window. A focused window can lie under a newer window
   that has no focus (`run.ts`, the note at line 636), so the front page decides, not the focus, and the
   raise sends `windows.update` with `{"focused":true}` also to a focused window (the live check measures
   that it raises; if it does not, the front page is unknown after each such step). With the front page
   unknown, today's focus rule decides, and no path plays. A path can play when a page comes under the
   pointer and the relay knows both last points: S of the front page and T of the entering page.
3. **Wait and hold** (only when a path can play), all within one `ACTIVATE_MAX_MS` (2 s); at the limit,
   no path. When the front page holds a button, wait for its release; no path when its tab's next call
   waits in the activation chain (its gate is set), also when the gate becomes set during the wait (its
   release then waits behind this step). No other page's button counts: the X pointer reaches only the
   page under it. Wait for the end of a catch-up that runs in the front page. Then chain the front page's
   gate on its old gate (`behind()` alone would replace it), so that its later calls, its pointer input
   among them, wait behind the step in order (C10, the order of requests). Last, wait for the answers of
   the pointer input of both pages that already went to Chrome, so that S and T are Chrome's points (a
   page whose `mousemove` handler opens a dialog holds that answer up to 600 s; the limit keeps the chain
   going).
4. **Plan.** Read both geometries (below; at most `GEOMETRY_WAIT_MS = 200`). Map S and T to display px.
   Read `at` too when it is unknown. When S or T is outside the front page's viewport (2 px inside its
   edges), no path. When `at` is T, no path is needed: the entry comes at T (step 6 records it). Take the
   legs of `src/input.ts`'s generator from S to T (`planMove`'s curve and times, an overshoot leg past
   500 px, the default target width 24) and sample them every 16 ms (`pointAt`; `input.ts` samples 12 to
   60 points). Clamp each point 2 px inside the front page's viewport, in whole pixels; drop a point that
   does not move, and cap each `dt` at 250 ms. While a step is over 50 px, stretch the time of all legs by
   one factor, and sample and clamp again. The first step of a path (and of a catch-up) is at least 2 px
   from the rounded start, so that no real move has movement 0. When S equals T and `at` does not, the
   path is a short out-and-back of 2 to 4 px. When the path does not fit section 2's limits (more than
   1500 ms: a far target on a large display), no path.
5. **Play.** Send `daemon.movePointer`, and wait for its answer, at most its wait.
6. **Record** (the X records). On `ok`: the answered position, mapped into the front page's viewport, is
   the front page's last point (unknown when outside it), and, mapped into the entering page's viewport,
   the entering page's last point; log once when it is not T. With no path because `at` is T: T. On
   `pointer moved`: the answered position is `at` and the entering page's last point, and the front
   page's point is unknown (it saw the other mover's moves). After a failed path (`no display`, `not
   now` after a kill, the relay's timer) and in every other step that brings a page under the pointer
   with no path (with the paths on): read the pointer (`daemon.pointerAt`) and record its position as
   `at`, for the entering page, and for the front page after a failed path (it saw a part of the path);
   a failed read leaves them unknown. The entering page is the front page now.
7. **Bring the page forward:** `tabs.update` and `windows.update`, or the client's own
   `Page.bringToFront`, or the `tabs.update` of `Target.activateTarget`; then open the front page's gate.
8. The input that needed the activation goes (after a `Page.bringToFront`, the client sends its input
   after the answer). A press's catch-up (if any) then runs inside its chain step, from step 6's record.

The limits of the step: one `ACTIVATE_MAX_MS` for steps 1 and 2, one for step 3, 1.2 s for the reads of
step 4 (the geometry's 200 ms, and `daemon.pointerAt` when `at` is unknown), the path's wait (at most
3 s), 1.2 s for the read after a failed path, and one `ACTIVATE_MAX_MS` for step 7 (after it, no
`tabs.update` and no `windows.update`, as today). The worst case of faults is about 11.4 s (10.4 s when
`at` is known); the normal case is the path's time plus some 30 to 60 ms. A path takes 0.3 to 1.5 s at
each activation that brings a page under the pointer, also for agent-browser's reads that bring a hidden
window page forward (`Tab.toFront` for `text`, `outline`, `eval` and waits).

**The catch-up (continuity of each page's pointer events).** After an X record set a page's point, the
client's next pointer event for that page may not start there: client A's moves that waited behind a path
in its page, or Playwright's next move, which goes from Playwright's own idea of the point. Chrome would
give that event its movement from the X record (fact 2): a jump, or a press away from the last move. So,
when a client's next `Input.dispatchMouseEvent` or `Input.dispatchDragEvent` for a page whose point is an
X record is a move more than 50 px from it, or a press or a wheel more than 2 px from it, the relay first
sends CDP `mouseMoved` events (no button) along a path of the same generator from the recorded point to
the event's point, with the path's limits (steps of at most 50 px, `dt` 16 to 250 ms, at most 1500 ms;
else no catch-up). The relay decides it when the event leaves the tab's gate, against the page's point at
that time, so a move that waited behind a step starts at that step's record. For a move, the client's
move is the path's last step; for another event, the path ends with a move at its point. Then the
client's event goes, and the page's point is the client's again, so the catch-up applies only once after
each X record: never between a client's own events, and never while the page holds a button. That rule
wins over a release far from the point: a release comes only while a button is held, and no path plays
under a page that holds a button (step 3); a page that comes forward while it holds one is as today
(step 6 can record it; review-63e note A). The catch-up is a step of the tab's gate: the client's event
and the tab's later calls wait behind it, in the client's order. It keeps at
most 4 of its moves without an answer: when a move is due while 4 wait (a page with an open dialog
answers none), it stops, and the client's event goes as it goes today, so the tab's 64 in-flight requests
(`MAX_IN_FLIGHT_PER_TAB`) never fill in front of the client's `Page.handleJavaScriptDialog`; the page's
point is then what the last sent move set. It never starts while a step holds its page (it waits behind
the gate), and a step waits for a catch-up that runs in its front page (step 3): the two never overlap on
one page. Its cost: 0.3 to 1.5 s before that one event. It removes review-63b's two-client jump and its
press away from the last move, and Playwright's jump at its next raw move after an activation.

**When the relay sends no path** (that activation is as today): the paths are off or unknown; the front
page, a last point or `at` is unknown; a geometry is not usable; S or T is outside the front page's
viewport; the path does not fit the limits; step 3 found a gate or reached its limit; or the daemon
refused. A page
that never had a pointer event then enters with its first pointer event, which is no position change; a
page whose point was known or became unknown enters at the X pointer: one unexplained change at most,
never a jump. The first activation after the relay's start, after a link change, or after the paths
turn on has no path, because the front page is unknown (review-63e note C); from its record on, the
front page is known.

**Why the path starts at S, not at `at`:** the leaving page usually got CDP input after it came forward,
so S is no longer where the pointer is. By fact (2) a first real move from `at` would have its movement
from S, often over 100 px; from S each real move is one step of the path, and the warp from `at` does not
show.

**The geometry.** The mapping of `src/input.ts` (`origin`) uses 7 values: `screenX`, `screenY`,
`outerWidth`, `outerHeight`, `innerWidth`, `innerHeight`, `devicePixelRatio`. The relay reads them and 3
more (`visualViewport.scale`, `screen.width`, `screen.height`) with one `Runtime.evaluate` in its own
isolated world (`Page.createIsolatedWorld` on the main frame). With `side = round((outerWidth -
innerWidth) / 2)`: display `x = round(screenX + side + px)`, `y = round(screenY + outerHeight -
innerHeight - side + py)`; the inverse maps a display point into a page. The rules of the read:

- only for a bridge tab, with no attach and no `Page.enable` or `Runtime.enable` of the relay's own (they
  would change the client's domain state);
- one read in flight per tab (a page that holds a dialog keeps a read up to 600 s; more reads would fill
  its in-flight key in front of the client's `Page.handleJavaScriptDialog`);
- C10's default wait (a short one would time out, and C10 then detaches the tab); the relay stops waiting
  after 200 ms and drops the late answer;
- the world again when its context is gone (an evaluate that names an unknown context);
- the relay drops the world's `Runtime.executionContextCreated`, `Runtime.executionContextDestroyed` and
  `Debugger.scriptParsed` events, so no client sees it; no page script sees its reads.

A geometry is not usable when the ratio or the scale is not 1, the window is minimized, the screen size is
not the display's, a read is in flight, or a device-metrics override is in force on the tab (a client's
`Emulation.setDeviceMetricsOverride` until its `clearDeviceMetricsOverride`: Playwright's
`setViewportSize`, agent-browser's `record`): then `innerWidth` and `innerHeight` do not give the window's
real viewport. Not taken: `windows.get` with `Page.getLayoutMetrics` and no page read: those metrics leave
out the scrollbars (about 7 px off with a vertical scrollbar).

**C11's new paragraph** (in "One window per page"): the steps above, with the paths on; the catch-up;
no client method reaches a `daemon.` op.

## 4. The daemon's checks, and what a refusal does

- **Only the relay's link** (section 2): no gateway route, CLI verb, socket or receiver message reaches
  the ops.
- **Only the agent display:** the unit's own Xvfb (the display of `unit.json`, with the unit's X auth
  file), only while the unit runs. The size is the running Xvfb's: the daemon records it in `unit.json`
  when it starts the Xvfb, and reads it from X once for an adopted unit; never the current config
  (`browser.display_size` can differ from an adopted Xvfb's size). No "only the agent Chrome's windows"
  check is needed: the Xvfb is private (`-nolisten tcp`, a cookie of its own in a 0600 file), so only the
  unit's Chrome and the daemon put windows on it.
- **The path's limits** (section 2): the points, `dt`, the total time, each step at most 50 px, each point
  (with `at` and `from`) inside the display; and the read pointer within 2 px of `at` before the play.
- **One X call at a time** (`busy`), **5 paths and 10 reads a second**, and **the deadline**, checked right
  before the play.
- **The call:** absolute pointer moves and reads of the pointer; no button, no key, no read of pixels.
- **The live view** (when it exists; aw-lead's answers 4 and 5): `not now` for 10 s after the operator's
  last live-view input and for an old `views`; the operator's input kills a playing path.
- **A refusal** moves nothing (`pointer moved` and `too late` follow a read; `no display` and `not now`
  can follow a call that was killed or failed, and the place is then unknown). The daemon logs the op,
  the text and a count (one line for each text a minute; never a point, C10's log rule). The relay logs
  each text at most once in 5 minutes, does not try again in that step, and goes on with no path
  (section 3, step 6).

## 5. What a site sees

| | agent-browser's own display (ab-v16.26) | through the relay, this design | the fallback (the relay today) |
| --- | --- | --- | --- |
| the page that comes forward | its entry at the X pointer: where the last path of any page ended | its entry at its own last point, movement 0 | its entry at the X pointer, wherever it is |
| unexplained position changes there | 0 (`design`); 1 with two agents (`design-two`) | 0 expected, with two agents too, after each page's first activation | 5 in 6 activations (`design-no-x`) |
| the page that leaves (under the pointer during the path) | nothing: the X move was its own path's last step | a path of real moves from its own last point, inside its viewport, at most 50 px and 16 ms apart, then its `blur`; when its own client goes on in it, a CDP catch-up path first | nothing |

- **agent-browser's commands:** the path of `Hands` starts at the entry (`input.ts`), now the page's last
  point, so it needs no catch-up: 0 jumps and 0 unexplained changes expected in both pages. Only
  `input.ts`'s log line "the X-pointer method is off ... over agentwatch's relay" changes.
- **Playwright and other clients:** the entry and the leaving page's path are as above, and the catch-up
  takes the place of the jump at the next raw move after an activation. Playwright's other raw moves keep
  their shape (one move each, a listed signal: README, "What a site can still see"); the catch-up does not
  apply between a client's own events.
- **Two clients at once:** step 3 keeps a path out of the front page's press and its catch-up, the gate
  keeps its later calls in order behind the path, and the catch-up joins its client's next event to the
  path's end. Two clients' input in one page at once, and a client's input to a page that is not in front,
  stay listed signals (no input lock across clients).
- **Not covered:** a window that comes on top with no activation step (a new window, a site's popup, a
  close that shows the window below, the live view's click). Its page enters at the X pointer, as today;
  the relay marks the front page as section 3 says.
- **The Mac: no move.** The agent browser runs on the operator's screen and its pages are background tabs
  (`windowPerPage` is false until ab-v16.27), so the relay sends nothing; a Mac daemon has no unit Xvfb
  (`no display`). agent-browser keeps its rule "never take the operator's pointer": CDP input inside a
  background tab, which is under no pointer and gets no entry event. ab-v16.27 measures the Mac.
- On Linux, where agent-browser started its agent Chrome on a display of its own, ab-v16.26's way stays.

## 6. Why no agent gets raw X

aw-lead's reasons (mail m4f38c16): raw X input reaches Chrome's UI and `chrome://extensions` (an agent
could switch the agent extension off, and its allowlist rules with it), and X access allows raw
screenshots of the whole display (other scopes' pages, the operator's tabs). Both break the rule that
agents reach the agent browser only through the relay and its refusals (C11, the peer check, the
per-scope lists). Here no agent makes an X call: the daemon moves the pointer along a checked path that
the relay computed from the pages' own input, inside a page's viewport, and reads its position; never a
click, a key or a read of pixels. A raw-X way (the Xvfb's `DISPLAY` and `XAUTHORITY` for agent sessions)
would change the trust boundary, which only the operator can decide; its reason would be the measured 5
unexplained changes in 6 activations. This design is expected to remove them with no raw X, so ab-lead
asks the operator only if the live check of section 7 fails.

## 7. The tests that the build needs

**Unit (agent-browser, test first, `test/fake-bridge.ts`):**

- the last points (both methods, set when sent to Chrome, the own session only; unknown after a far
  wheel, a child session's or a touch input; kept over a link change for listed targets; gone at
  `tabs.onRemoved` and `tabs.onReplaced`); the front page (each rule of section 3); the held buttons
  (each end);
- with the paths off: every input, `Page.bringToFront` and `Target.activateTarget` exactly as today (no
  wait, no read, no catch-up);
- the step: the decision by the front page; step 3 only when a path can play, one 2 s limit, the
  button of the front page only, no path when its gate is or becomes set (review-63b's two cases end at
  once), the wait for a running catch-up, the gate chained on the old gate, the in-flight answers of both
  pages (a page that holds an answer: no path at 2 s, and the chain goes on); `Page.bringToFront` and
  `Target.activateTarget` behind their tab's gate; the order of the steps;
- the path: `at` (known, read first, equal to T: no path), the 16 ms sampling, the clamp, the `dt` cap,
  the stretch, no step over 50 px, a first step of 2 px or more, the out-and-back, S or T outside the
  viewport, the limits, `notAfter` from `process.hrtime.bigint()`, the per-request wait and the key
  `pointer`;
- the answers: each record of step 6; the probe's states (unknown before its first answer; `busy`, `too
  many moves`, `disconnected` and the timer leave it unknown); a late answer is dropped; any
  `Browser.setWindowBounds` makes the front page unknown;
- the catch-up: when (each event type and threshold, once after an X record, not between a client's own
  events, not while a button is held, decided when the event leaves the gate), its shape and limits, its
  order behind the gate, no overlap with a step; a page that does not answer: the catch-up stops at 4
  unanswered moves, and the client's `Page.handleJavaScriptDialog` reaches Chrome;
- the geometry read: one in flight per tab, bridge tabs only, no enables, the world again, no client sees
  its context or `Debugger.scriptParsed` events, its own 200 ms.

**Contract vectors (chrome-extension `test/vectors/bridge.json`):** both ops, valid; `bad args` for each
limit (points, `dt`, total, a step over 50 px, a negative, non-integer or too far `notAfter`, a missing or
extra key, a float, a missing `at` or one outside the request's `width` and `height`, as in section 2);
`out of bounds` (a point or `from`);
`wrong display`; `too late`; `busy`; `pointer moved` (the read more than 2 px from `at`, with `data`; a
read 1 px from `at` and far from `from` plays); 6 paths and 11 reads in a second; an unknown `daemon.`
op; a `daemon.` op at the receiver gets `unknown op`. The relay's tests and aw-lead's daemon tests use
the same vectors.

**Live (taylor, in the harness's own private Xvfb; never the operator's agent browser, never the live
suite's external mode).** The stand-in daemon (`test/live/agent-mode/daemon.ts`) gets both ops with the
checks of section 4, the read before the play and the `xdotool -` script. Through the real relay:

- the anti-detect probe's `design` and `design-two` with agent-browser's commands over `--cdp-url`, and
  a Playwright case; each with two pages in two windows in turn for at least two rounds;
- review-63b's two-client case: client A runs a click in its page while client B activates another page;
  A's page is counted apart (jumps, and presses away from the last move); a catch-up that runs in the
  front page while another client activates (review-63c B2); one client holds a press (once for 3 s,
  for the limit) while the other activates: no real move between its `mousedown` and `mouseup`; a page
  whose `mousemove` handler opens a dialog: the step ends at its limit with no path, and a far catch-up
  (over 700 px) into it stops and lets the client close the dialog; an active tab's
  `Target.activateTarget`: no path;
- a focused window under a newer unfocused window: the raise brings it up (and a CDP press into it: does
  Chrome raise it?);
- the mapping and the clamp: a page with a vertical scrollbar, one with a horizontal scrollbar, a target
  near the display's edge, a popup of another size, a moved window, and a device-metrics override (no
  path);
- counted in both pages: jumps over 100 px (also of moves that Chrome merged into one frame, fact 3),
  unexplained position changes, zero-movement moves of the path, entries at an earlier entry's point, the
  path's moves and speed against the probe's person baseline, the `dt` that the page saw against the
  planned `dt` (`xdotool sleep`, aw-lead's answer 2), and the time of the step and of a catch-up.

The pass mark: after each page's first activation, 0 jumps and 0 unexplained changes in both pages of
each activation, 0 zero-movement moves in each path, the leaving page's moves like the person's, and in
review-63b's two-client case 0 jumps and 0 presses away from the last move in A's page; Playwright's own
raw moves are counted apart. `test/live/agent-mode/` passes in full. Then agentwatch's live test with the
real daemon (aw-lead's task age-0kh.28, on the age-cqd test browser).

## 8. The build split and the limits

The build: (1) chrome-extension: the C10 text (the two ops, their rows, waits and key, the clock, the
daemon's checks, the rule for `data` on an error) and C11's paragraph, with the vectors; their commit
goes to aw-lead. (2) agentwatch (aw-lead, task age-0kh.28 after age-0kh.27): the daemon side; it can ship
first. (3) agent-browser: the relay, the stand-in daemon's ops, the shared generator, the README rows and
the live check; agentwatch's relay pin moves after this merges and its live check passes. Two build
points: `Bridge.answer` drops `data` on an error answer today, and the relay needs `pointer moved`'s
`data`; and the "`at` is T, no path" rule sends no op, so the daemon's `pointer moved` and `not now`
checks do not run: once the live view exists, the relay reads the pointer first in that case.

The limits:

- Each activation that brings a page under the pointer costs a path of 0.3 to 1.5 s, and a catch-up costs
  as long once after it (section 3, the limits of the step).
- **A position across scopes** (review-63b note 17; ab-lead accepts it as a residue): the front page can
  be a page of another scope or an operator tab. It sees the path's end, which is the entering page's last
  point, and a page that enters with no path enters at the last path's end. So the pages of one scope can
  learn where a page of another scope last saw the pointer: a position only, no content. Today over the
  relay the X pointer never moves. Not taken: paths only between two pages of one scope.
- A path gives the page under the pointer real moves and hovers inside its own viewport at points that
  the pages' input chose: at most 5 paths a second, no click, key or read.
- Where the relay cannot know a page's point (section 3), that one activation is as today.

## 9. Questions for aw-lead (the daemon side)

None is open. aw-lead answered questions 1 to 6 (mail m98c6f1f) and 7 to 9 (mail m2933af4: the kills,
the limits, the error with `data`), and chose form (a) for the place check (mail md133a6e: the relay
sends `at`, the daemon keeps no state). The answers are in sections 2 and 4. The build adds the measured
accuracy of `xdotool sleep` (section 7) to section 2.
