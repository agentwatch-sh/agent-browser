# The agent display's pointer, moved by the daemon at the relay's request — design

Date: 2026-11-06. Status: **reviewed and merged** (agent-browser PR #63, merge `6bb6838`): revision 5,
after five fresh reviews (review-63, 63b, 63c and 63d at `b340c26`, `1d29201`, `f42f714` and `19307c0`,
and review-63e at `cd415cb`) and the daemon lead's answers (mails mb5c6cbf, m98c6f1f, m2933af4 and md133a6e),
with the daemon lead's yes to sections 2 and 4 (mail mbf51aeb); review-63e's doc notes A to C are in the text. The
build (board ab-v16.71, agent-browser PR #68) added the lead's decisions on its five points: the cached
geometry of a front page that is no bridge tab, the content box as the clamp, the text on a jump with no path,
the limit of movement 0 (board ab-v16.76), the hover dialog's pass condition, and the gate rule's sentence;
then review-68's fixes (B1 a world before each read, B2 a held button on any session, B3 `Browser.setWindowBounds`
behind a running step, N1 a front page only by a raise that the relay sent, N2 and N3, a minimized or hidden page).
Its contract text is chrome-extension PR #29 (board ab-v16.70: C10 and C11, with the vectors); its build
is board ab-v16.71 (the relay), with agentwatch task age-0kh.28 (the daemon). Author: a taylor contributor, a subagent of the lead (board task ab-v16.37). Sources: agent-browser main `6e51439`
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
measured 5 unexplained position changes in 6 activations. The daemon lead (mail m4f38c16) refused `DISPLAY` and
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
   leaving page's content box (its viewport less its scrollbars), and waits for its end before the window comes forward. The end is both pages'
   last point.
3. **Continuity (section 3):** a path, an entry or a cover can require a catch-up.
   The client's next far pointer event gets a person-shaped CDP catch-up path first.
4. **The checks (section 4):** the relay's pipe, the unit's Xvfb and its size, each point inside it, steps
   of at most 50 px 16 ms apart, the pointer at `at`, one X call at a time, 5 paths a second, a deadline.
5. **What a site sees (section 5):** both pages see a person's input. When the relay cannot know a
   page's point, it sends no path, and that one activation is as today (one unexplained change or one
   jump at most: section 3, "When the relay sends no path"). With the paths off (an older daemon) the relay is exactly as today. On the Mac nothing moves.
6. **No raw X (section 6)** for any agent.

## 2. The messages (C10)

**They belong to C10, "The daemon and the relay".** C4 is the daemon's link to the receiver (native
messages); the receiver has no X access. C10 already holds the relay's requests on its standard output,
the daemon's own answers and lines, and the daemon already reads each relay line. So these are two more
ops on that pipe that the daemon answers itself: no new channel or socket, and only the relay, the
daemon's own child, writes there. C11 gets one paragraph (section 3).

**The daemon side (the daemon lead's answers).** The prefix `daemon.` is reserved. The daemon handles a `daemon.`
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
position read at the end. The live check measures how well `xdotool sleep` keeps `dt` (section 7.1, board
ab-v16.71): the leaving page's event times kept the planned `dt` to within 1 ms (median 0 ms, p90 1 ms over
5132 pairs of moves in six runs; at most 5 ms, except once 116 ms under the load of the whole live suite), and
one script's start on `xdotool -` costs 20 to 26 ms (median). Standard input works: no argv is needed.

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

**The ops table rows, the waits and the key** (the daemon lead's answer 6). C10 says that the relay sends each
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
- **The front page:** the page under the pointer. It is the page of the relay's last activation step whose
  raise the relay sent (review-68 N1, below in step 2). A new tab that opens a window, or that becomes the
  active tab of the front page's window, is the front page then (it comes on top), with no last point. The front page is unknown at the relay's start, at a
  link change, at `tabs.onRemoved` or `tabs.onReplaced` of the front page, after a step whose raise
  reached its limit, and after any client's `Browser.setWindowBounds` (a `"normal"` state can bring a
  minimized window on top).
- **The held buttons:** a tab holds a CDP button from a `mousePressed` until Chrome answered its
  `mouseReleased`, on any session of the tab: its own or a frame's (review-68 B2; a frame's pointer input
  still makes the page's point unknown). The hold also ends at `tabs.onRemoved`, at a link change, when the client's connection
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
   unknown, today's focus rule decides, and no path plays. Then a page becomes the front page (and step 6
   records it) only by a raise that the relay sends: `windows.update` for an input (its window does not
   have the focus), or the client's `Page.bringToFront`. A window that has the focus can lie under a newer
   window, and a tab switch (`tabs.update`, also `Target.activateTarget`'s) raises no window: then the
   front page stays unknown, and no record is made (review-68 N1). A path can play when a page comes under the
   pointer and the relay knows both last points: S of the front page and T of the entering page.
3. **Wait and hold** (only when a path can play), all within one `ACTIVATE_MAX_MS` (2 s); at the limit,
   no path. When the front page holds a button, wait for its release. The rule "no path when the front
   page's tab's next call waits in the activation chain (its gate is set, also when it becomes set during
   the wait)" applies only while the front page holds a button, because only then does the release wait
   behind this step (the lead's decision on PR #68). No other page's button counts: the X pointer reaches
   only the page under it. Wait for the end of a catch-up that runs in the front page. Then chain the front page's
   gate on its old gate (`behind()` alone would replace it), so that its later calls, its pointer input
   among them, wait behind the step in order (C10, the order of requests). Last, wait for the answers of
   the pointer input of both pages that already went to Chrome, so that S and T are Chrome's points (a
   page whose `mousemove` handler opens a dialog holds that answer up to 600 s; the limit keeps the chain
   going).
4. **Plan.** Read both geometries (below; at most `GEOMETRY_WAIT_MS = 200`). Map S and T to display px.
   Read `at` too when it is unknown. When S or T is outside the front page's content box (its viewport less
   its scrollbars, 2 px inside its edges; the lead's decision on point 5 of PR #68), no path. When `at` is T, no path is needed: the entry comes at T (step 6 records it). Take the
   legs of `src/input.ts`'s generator from S to T (`planMove`'s curve and times, an overshoot leg past
   500 px, the default target width 24) and sample them every 16 ms (`pointAt`; `input.ts` samples 12 to
   60 points). Clamp each point 2 px inside the front page's content box, in whole pixels (a page gets no
   mouse event over its scrollbars, so a path over one gave an unexplained change live); drop a point that
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
   a failed read leaves them unknown. The entering page is the front page when step 7's raise succeeds
   and either a page came under the pointer (the front page was known) or the relay sent the raise
   (step 2, review-68 N1). A new tab that comes on top is the front page with no raise (section 3, what
   the relay keeps). The front page is unknown after failed reads of step 1 and after a raise that reached
   its limit or failed for an input or a `Page.bringToFront`; a failed `tabs.update` of
   `Target.activateTarget` gives the client the error and keeps the front page as it was.
7. **Mark the leaving page for catch-up.** Then bring the page forward with the raise.
   The raise uses `tabs.update` and `windows.update`, the client's `Page.bringToFront`, or the `tabs.update` of `Target.activateTarget`.
   Then open the front page's gate.
   The mark applies even when no X path plays or `at` is T. It precedes the raise because a failed
   or late answer can still have raised the window. A new tab that comes on top also marks the old front
   page. The mark changes no last point.
   A raise with an unknown front page sets no cover mark.
   Each raise stays within one `ACTIVATE_MAX_MS`.
   This includes `Target.activateTarget`'s `tabs.update` after failed reads in steps 1 and 2 (review-68 N3).
8. The input that needed the activation goes (after a `Page.bringToFront`, the client sends its input
   after the answer). A press's catch-up (if any) then runs inside its chain step, from step 6's record.

The limits of the step: one `ACTIVATE_MAX_MS` for steps 1 and 2, one for step 3, 1.2 s for the reads of
step 4 (the geometry's 200 ms, and `daemon.pointerAt` when `at` is unknown), the path's wait (at most
3 s), 1.2 s for the read after a failed path, and one `ACTIVATE_MAX_MS` for step 7 (after it, no
`tabs.update` and no `windows.update`, as today). A client's `Browser.setWindowBounds` (with the paths on)
waits in the activation chain: behind every step already in the chain (one runs: its path plays at the
window's old place), and behind the catch-ups that run in that window's pages; then the front page is unknown,
the kept geometries go, and the window changes (review-68 B3). Later steps wait behind it. The window's scope
check (a window that holds no tab of the client's scope: `Browser window not found`) runs first, and a refused
call changes nothing. With the paths off or unknown it goes at once, as before. The worst case of faults is about 11.4 s (10.4 s when
`at` is known); the normal case is the path's time plus some 30 to 60 ms. A path takes 0.3 to 1.5 s at
each activation that brings a page under the pointer, also for agent-browser's reads that bring a hidden
window page forward (`Tab.toFront` for `text`, `outline`, `eval` and waits).

**The catch-up (continuity of each page's pointer events).** An X record or a cover can separate
a client's next event from the page's last point. A client's moves can wait behind a path in its page.
Playwright sends its next move from its own idea of the point.
Chrome measures movement from the X record (fact 2), but gives the covered page's next event movement 0.
When a client's next `Input.dispatchMouseEvent` or `Input.dispatchDragEvent` reaches such a page,
the relay checks the distance from its known point.
A move more than 50 px away, or a press or wheel more than 2 px away, first gets CDP `mouseMoved` events (no button) along a path of the same generator from the recorded point to
the event's point, with the path's limits (steps of at most 50 px, `dt` 16 to 250 ms, at most 1500 ms;
else no catch-up), each point clamped 2 px inside the page's content box as in step 4 (from the page's last
usable geometry, else a read; with neither, no clamp), except the event's own point, which stays where the
client sent it. The relay decides it when the event leaves the tab's gate, against the page's point at
that time, so a move that waited behind a step starts at that step's record. For a move, the client's
move is the path's last step; for another event, the path ends with a move at its point. Then the
client's event goes, and the page's point is the client's again, so the catch-up applies only once after
each X record or cover. The first pointer input consumes the cover mark; unrelated calls keep it.
Another record or cover is necessary for another catch-up between the client's events.
The relay sends no catch-up while the page holds a button. That rule
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
content box; the path does not fit the limits; step 3 found a gate or reached its limit; or the daemon
refused. A page
that never had a pointer event then enters with its first pointer event, which is no position change; a
page whose point was known or became unknown enters at the X pointer: one unexplained change at most, or
one jump. The entry carries the movement from the page's last point when Chrome still has that point as the
base of the movement (the page got pointer input since its window last lost the pointer), and so it is a
jump when the X pointer is more than 100 px from that point (measured, board ab-v16.71, section 7.1: a
press held 3 s, whose step ended at its limit with no path, gave the entering page a jump of 304 px; the
first step after a `Browser.setWindowBounds` gave one of 100.5 px; a step with no path in the first live run
gave A's page two jumps of 233 px). The first activation after the relay's start, after a link change, or after the paths
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
  would change the client's domain state). The relay keeps each page's last usable geometry from its own
  reads (the lead's decision on point 1 of PR #68): a front page that is no bridge tab (agent-browser's CLI
  ends its connection after each command, and the relay then detaches its page) uses it. The relay keeps a
  read only when it is usable as a front page's geometry (below: also not minimized, by step 1's
  `windows.get`, and not hidden); a read that is not usable, or that fails, drops the kept one (review-68
  N2), and a catch-up's own read keeps none. The relay drops the kept geometry at each of these events:
  any client's `Browser.setWindowBounds`; a call on the page's own session of
  `Emulation.setDeviceMetricsOverride`, `Emulation.clearDeviceMetricsOverride`, `Emulation.setVisibleSize`,
  `Emulation.setPageScaleFactor`, `Emulation.setScrollbarsHidden`, `Page.setDeviceMetricsOverride` or
  `Page.clearDeviceMetricsOverride`; the page's `Page.frameResized`; its `tabs.onReplaced` and
  `tabs.onRemoved` (the tab leaves the relay's model); and a link change. With no kept geometry, no path
  (as today). The limit is in section 8 (review-68 N9);
- one read in flight per tab (a page that holds a dialog keeps a read up to 600 s; more reads would fill
  its in-flight key in front of the client's `Page.handleJavaScriptDialog`);
- C10's default wait (a short one would time out, and C10 then detaches the tab); the relay stops waiting
  after 200 ms and drops the late answer;
- each read first sends `Page.createIsolatedWorld` on the main frame and evaluates in the context id that
  it returns (Chromium answers the same id while the world lives). An id kept from an earlier read can name
  another context: after a cross-site navigation Chromium reuses context ids in the new renderer process,
  and the relay sees no context event while no client has `Runtime` on (review-68 B1: an old id ran in a
  page's own world, which saw the read and gave its own values). When the evaluate names an unknown
  context (a navigation between the two calls), the relay tries once more. The relay retains the ids across
  documents, including documents in the back-forward cache. A restore can return the same world before the
  next geometry read. Navigation, context destruction and context clearing therefore keep these refusal
  candidates (ab-v16.84);
- on the tab's own session only, the relay drops the world's `Runtime.executionContextCreated` by its
  name. The event records the id. A separate set filters the current document's
  `Runtime.executionContextDestroyed`, `Debugger.scriptParsed` and `Debugger.scriptFailedToParse` events.
  A read replaces this event filter with its current world. A context of another name, or a client's
  `Page.createIsolatedWorld` answer, releases that id from the event filter only. A context clear or a
  main-frame navigation resets this filter and still reaches the client. These changes never remove a
  retained refusal candidate. Thus a client can see its own context's events after renderer reuse;
- a client's call into the world is refused with a clear error (`TEXT.relayWorld`), before it reaches Chrome (board
  ab-v16.80; review-68c note 3: a client could guess the id and change `screenX` there, which moved the
  clamp box). The relay checks a call on the tab's own session that names a candidate id: a `contextId` or
  an `executionContextId` (`Runtime.evaluate`, `Runtime.callFunctionOn`, `DOM.resolveNode`,
  `Runtime.compileScript`, ...), or an object id or a call-frame id of the world (`objectId`, a name that ends
  in `ObjectId`, `callFrameId`; also in a call's arguments, down to 3 levels). The relay reads the world of an
  object id and of a call-frame id from V8's form of both, `<isolate>.<context>.<n>` (measured on Chromium
  156: an object of context 6 had the id `-5135176979714057620.6.1`); it depends on that form. Another form
  names no context (the old JSON form, `{"injectedScriptId":...}`, is not parsed), so such an object id is
  not refused: the context-id refusals stay. The relay's own calls give no object (`returnByValue`), and
  their answers never go to a client. The check runs when the call goes to Chrome, so a call that waited
  behind a step is checked against the world that the step's read made. `Runtime.runIfWaitingForDebugger`
  is not checked: it runs no code in a context, and its release of a held tab must go (review-72 note 6).
  The relay retains at most 128 candidate ids per tab. It never evicts an id while the tab stays in the
  model. The tab's removal or a link reset ends that state. Before a call names a retained id, the relay
  sends `Page.createIsolatedWorld` with its private name on the current main frame. This native lookup
  runs no script and sends no enable. Chrome returns the existing world's id for that document. If the
  document has no world with that name, the lookup creates it. Its id joins the retained set, within the
  same bound. The relay refuses the call when it names that current id. Thus a numeric id reused for a
  client's context in another renderer stays usable. The cached renderer's world stays protected when it
  returns.
  A lookup error, an invalid answer, a lost frame, a removed tab, a detach or a wait beyond 200 ms refuses
  the call. A late lookup answer never forwards it.
  The tab's later calls wait behind this lookup, including calls with no context. The gate opens when
  the first command is sent or refused. It does not wait for an ordinary CDP answer: a dialog or held
  target must still accept its release command. Activation steps also wait for lookup and submission.
  A `Page.bringToFront` keeps its bounded reply wait, including when the tab read fails.
  A client's own world with a reused id pays one native lookup round trip on each call that names it.
  This cost can continue for the tab's lifetime. Each lookup can hold later calls for up to 200 ms.
  At 128 retained ids, the relay checks **every context-bearing call** by the same native lookup. It
  retains all 128 ids and allocates no more entries. Newly created or restored worlds therefore stay
  protected after the bound, without refusing a client's reused id forever. Calls with no context and
  `Runtime.runIfWaitingForDebugger` keep their existing paths. A child session numbers its contexts on
  its own, and its calls are not checked. With an old daemon, or on the Mac, the relay makes no world,
  and nothing is refused;
- the relay's evaluate sends `disableBreaks: true` (review-72 B1). The client and the relay share the tab's
  debugger session, so a client's breakpoint reaches the relay's evaluate, with no id named. A
  `Debugger.setBreakpointByUrl` by the `scriptHash` of `GEO_EXPRESSION` (its text is public; the client
  gets the hash from its own evaluate of the same text) runs its condition or logpoint in the relay's
  world before the read: such a condition can set `screenX` in the world, for this read and the later
  reads of the document. An instrumentation breakpoint (`beforeScriptExecution`) or `Debugger.pause` stops
  the read in the world (a paused frame there, whose call-frame id the relay refuses; the paused read
  could get a forged return value). Measured on taylor (Chromium 156, the live group `pointer`, 2026-11-07):
  without `disableBreaks`, both reads of a step paused in the relay's world, the hash breakpoint's
  condition ran there (the second read saw `screenX` 10000), and the step played no path; with it, no pause
  and no condition in the relay's reads, while both breakpoints reached the client's own evaluate in its
  own world (the controls). A breakpoint by `urlRegex: "^$"` reached not even the client's own evaluate:
  V8 sets no URL breakpoint on a script with no URL. The read throws no exception, so a pause on exceptions
  does not reach it;
- the limits of the refusal: a call can reach Chrome between the world's first `Page.createIsolatedWorld`
  in a document and its answer. A navigation can also commit between a native lookup and the client's
  forwarded command, just as it can commit between a world's creation and the geometry evaluate. These
  separate CDP commands are not atomic. Retention closes the restore gap between geometry reads; it does
  not close this navigation race. The object-id format dependency above also stays. The world's
  `uniqueContextId` and its name stay hidden from clients; the name has 32 random bits;
- a read keeps or drops the kept geometry only when it answers within `GEOMETRY_WAIT_MS` and no drop event of
  the page came after the read started (the relay counts the drop events of each page); a late answer is
  dropped and changes nothing (round 3 of PR #68).

The read also gives the content box: `visualViewport.width` and `height` (the viewport less its
scrollbars, at a scale of 1; else `documentElement.clientWidth` and `clientHeight`). A geometry is not usable
when the ratio or the scale is not 1, the window is minimized, the screen size is not the display's, a read
is in flight, the front page reports `document.visibilityState` "hidden" (a page under the pointer is
visible: a hidden front page is not on top), a width or a height of the viewport or of the content box is
4 px or less, the content box is wider or taller than the viewport, or a device-metrics override is in force
on the tab (a client's `Emulation.setDeviceMetricsOverride` or `Page.setDeviceMetricsOverride` until its
`Emulation.clearDeviceMetricsOverride` or `Page.clearDeviceMetricsOverride`: Page's old pair acts as Emulation's;
Playwright's `setViewportSize`, agent-browser's `record`: then `innerWidth` and `innerHeight` do not give the
window's real viewport). The minimized test is only for the entering page (step 1 reads its window); the hidden
test covers the front page. The catch-up's clamp uses only the read's own rules (the ratio, the scale, the
screen and the sizes), not the relay's (an override, a minimized window, a hidden page). Not taken: `windows.get` with `Page.getLayoutMetrics` and no page read: those metrics leave
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
- **The live view** (when it exists; the daemon lead's answers 4 and 5): `not now` for 10 s after the operator's
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
| the page that leaves (under the pointer during the path) | nothing: the X move was its own path's last step | a path of real moves from its own last point, inside its content box, at most 50 px and 16 ms apart, then its `blur`; when its own client goes on in it, a CDP catch-up path first | nothing |

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

The daemon lead's reasons (mail m4f38c16): raw X input reaches Chrome's UI and `chrome://extensions` (an agent
could switch the agent extension off, and its allowlist rules with it), and X access allows raw
screenshots of the whole display (other scopes' pages, the operator's tabs). Both break the rule that
agents reach the agent browser only through the relay and its refusals (C11, the peer check, the
per-scope lists). Here no agent makes an X call: the daemon moves the pointer along a checked path that
the relay computed from the pages' own input, inside a page's content box, and reads its position; never a
click, a key or a read of pixels. A raw-X way (the Xvfb's `DISPLAY` and `XAUTHORITY` for agent sessions)
would change the trust boundary, which only the operator can decide; its reason would be the measured 5
unexplained changes in 6 activations. This design is expected to remove them with no raw X, so the lead
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
  content box, the limits, `notAfter` from `process.hrtime.bigint()`, the per-request wait and the key
  `pointer`;
- the answers: each record of step 6; the probe's states (unknown before its first answer; `busy`, `too
  many moves`, `disconnected` and the timer leave it unknown); a late answer is dropped; any
  `Browser.setWindowBounds` makes the front page unknown;
- the catch-up: when (each event type and threshold, once after an X record, not between a client's own
  events, not while a button is held, decided when the event leaves the gate), its shape and limits, its
  order behind the gate, no overlap with a step; a page that does not answer: the catch-up stops at 4
  unanswered moves, and the client's `Page.handleJavaScriptDialog` reaches Chrome;
- the geometry read: one in flight per tab, bridge tabs only, no enables, a world before each read and its
  new id only (review-68 B1), the kept geometry and its drops, no client sees
  its context or `Debugger.scriptParsed` events, its own 200 ms.

**Contract vectors (chrome-extension `test/vectors/bridge.json`):** both ops, valid; `bad args` for each
limit (points, `dt`, total, a step over 50 px, a negative, non-integer or too far `notAfter`, a missing or
extra key, a float, a missing `at` or one outside the request's `width` and `height`, as in section 2);
`out of bounds` (a point or `from`);
`wrong display`; `too late`; `busy`; `pointer moved` (the read more than 2 px from `at`, with `data`; a
read 1 px from `at` and far from `from` plays); 6 paths and 11 reads in a second; an unknown `daemon.`
op; a `daemon.` op at the receiver gets `unknown op`. The relay's tests and the daemon lead's daemon tests use
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
  (over 700 px) into it lets the client close the dialog (the pass condition: the client closes the dialog
  and the page answers; measured, board ab-v16.71: Chromium answers the moves after the one whose handler
  opened the dialog, so the catch-up never had 4 unanswered moves and did not stop; the bound of 4 stays as
  the guard for a page that answers none); an active tab's
  `Target.activateTarget`: no path;
- a focused window under a newer unfocused window: the raise brings it up (and a CDP press into it: does
  Chrome raise it?);
- the mapping and the clamp: a page with a vertical scrollbar, one with a horizontal scrollbar, a target
  near the display's edge, a popup of another size, a moved window, and a device-metrics override (no
  path);
- counted in both pages: jumps over 100 px (also of moves that Chrome merged into one frame, fact 3),
  unexplained position changes, zero-movement moves of the path, entries at an earlier entry's point, the
  path's moves and speed against the probe's person baseline, the `dt` that the page saw against the
  planned `dt` (`xdotool sleep`, the daemon lead's answer 2), and the time of the step and of a catch-up.

The pass mark: after each page's first activation, 0 jumps and 0 unexplained changes in both pages of
each activation, 0 zero-movement moves in each path, the leaving page's moves like the person's, and in
review-63b's two-client case 0 jumps and 0 presses away from the last move in A's page; Playwright's own
raw moves are counted apart. `test/live/agent-mode/` passes in full. Then agentwatch's live test with the
real daemon (the daemon lead's task age-0kh.28, on the age-cqd test browser).

### 7.1 Measured by the build (board ab-v16.71)

On taylor, Chromium 156 in the live test's own Xvfb (1280 x 900), chrome-extension main `8a3b66f`, through the
real relay and the stand-in daemon, whose `daemon.movePointer` plays each path on `xdotool -` on that Xvfb only
(the live group `pointer` of `test/live/agent-mode/run.ts`). Runs 1 to 3 (2026-11-06, PR #68's first head) found
the five points of the lead's decisions; runs 4 to 6 are after them (run 4 before the live check's own targets
and its rule of the needed paths; runs 5 and 6 the final code: the group alone, then the whole suite).

**`xdotool sleep`.** For each played path, the moves that the leaving page saw (matched by their screen point
to the path's points; Chrome merges the moves of one frame, so some points have no event of their own), the
time between two seen moves against the sum of the planned `dt` between them:

| run | pairs | the error, median / p90 / max (ms) | the planned `dt`, median / max (ms) | one script's start (ms): median / p90 / max |
| --- | --- | --- | --- | --- |
| 1 (the group) | 697 | 0 / 1 / 1 | 16 / 96 | 20 / - / - |
| 2 (the group) | 821 | 0 / 1 / 1 | 16 / 64 | 20 / 28 / 30 |
| 3 (the whole suite) | 870 | 0 / 1 / 116 (one stall) | 16 / 64 | 25 / 50 / 149 |
| 4 (the group) | 901 | 0 / 1 / 5 (1 pair over 2 ms) | 16 / 80 | 21 / 31 / 41 |
| 5 (the group) | 922 | 0 / 1 / 2 | 16 / 96 | 26 / 36 / 40 |
| 6 (the whole suite) | 921 | 0 / 1 / 1 | 16 / 80 | 20 / 28 / 40 |
| 7 (the group, review-68's fixes) | 924 | 0 / 1 / 4 (1 pair over 2 ms) | 16 / 80 | - |
| 8 (the group, review-68's fixes, after the rebase) | 915 | 0 / 1 / 1 | 16 / 250 | 19 / 27 / 29 |
| 9 (the whole suite, the same code) | 939 | 0 / 1 / 1 | 16 / 48 | 19 / 27 / 28 |

**The pass mark** (runs 5 and 6; counted from the end of each page's first activation; a jump or an unexplained
change in the second after the page's own step with no path is as today and counted apart; Playwright's own raw
moves counted apart):

| case | steps with a path | jumps / unexplained changes | zero-movement path moves | other |
| --- | --- | --- | --- | --- |
| agent-browser over `--cdp-url`, `design` (two pages in two windows in turn, 3 rounds, and a typing in each) | 3 of 8 in each run; the other activations needed none (at was T) | 0 / 0 in both pages | 0 | the front page is no bridge tab: its cached geometry |
| agent-browser, `design-two` (two agents at once, one input lock) | 1 of 6; the others needed none | 0 / 0 | 0 | |
| Playwright, two pages in turn, 3 rounds | 5 of 6 | 0 / 0 | 0 | |
| review-63b's two clients | 5 of 8 | 0 / 0 in both pages; 0 presses away from the last move in A's page | 0 | own raw moves: 2 and 1 or 2 per page (board ab-v16.76) |
| a catch-up in the front page while the other client activates | 1 of 1 | 0 / 0 | 0 | the step waited for the catch-up (2.0 to 2.1 s) |
| a press held 3 s; held 0.5 s | 0 of 1 (step 3's limit, 2.04 s); 1 of 1 | 0 real moves between `mousedown` and `mouseup`; the entry with no path: 1 jump (as today) | 0 | |
| the hover dialog | B's step: no path at its limit (2.03 to 2.04 s) | the client closed the dialog, the page answered | | the far catch-up did not stop |
| scrollbars, targets 3 px inside the display's edge, a popup of 600 x 420 | 7 of 9 | 0 / 0 (runs 2 and 3 had 1 unexplained change before the content box) | 0 | own raw move: 1 (board ab-v16.76) |
| a moved window | 3 of 4 | the first entry after `Browser.setWindowBounds` (no path): 1 jump, as today; then 0 / 0 | 0 | |
| a device-metrics override | 0 of 3, as designed | | | |
| an active tab's `Target.activateTarget` | no path, as designed | | | |
| a focused window under a newer unfocused window | | `windows.update` with `{"focused":true}` raised it; a CDP press with no activation did not | | |

The leaving pages' path moves: each with a movement; a median of 33 to 62 moves per path for the Playwright and
mapping cases (the xdotool person of the research: 20; agent-browser's own CDP paths: 50 to 55), 11 to 20 for
agent-browser's short paths between its pages' near points; a median speed of 0.5 to 1.1 px/ms; the largest
movement 76 px (two steps that Chrome merged into one frame). A step with a path took 0.41 to 0.79 s (median of
each case; at most 1.21 s; 2.1 s when it waited for a catch-up), a catch-up 0.28 to 1.11 s. The whole suite in its
own mode (run 6): 198 of 198 cases pass. After review-68's fixes (runs 7 to 9): the same steps with a path and the
same counts in every case (0 jumps and 0 unexplained changes after each page's first activation, 0 zero-movement
path moves; the as-today entries: 1 jump after the 3 s press, 1 after the moved window); the group alone 16 of 16
twice, and the whole suite 198 of 198. Runs 1 to 3 had no path for agent-browser's own commands (each CLI command
ends its connection, so the front page was no bridge tab), and runs 2 and 3 one unexplained change from a
catch-up over a scrollbar: the lead's decisions on points 1 and 5.

**Covered client points (board ab-v16.76).** The own-mode pointer group passes all 19 cases.
The added case uses two clients and both pages, with no raw-move exclusions.
Each page has 0 jumps, 0 unexplained changes and 0 zero-movement path moves.
The case has 3 activation steps and 1 X path; both covers need no X path because `at` is T.
After review-83, the leaving page sees 58 moves in that X path, with a maximum movement of 30 px.
The whole group measures 987 timing pairs: error median 0 ms, p90 1 ms, maximum 2 ms.
The live check gives no fallback exemption to an `at`-is-T step. All 19 cases still pass.
The jump and unexplained-change counts stay unchanged in every case.
The 3 s held press and the moved window each retain one jump at an actual fallback activation.

## 8. The build split and the limits

The build: (1) chrome-extension: the C10 text (the two ops, their rows, waits and key, the clock, the
daemon's checks, the rule for `data` on an error) and C11's paragraph, with the vectors; their commit
goes to the daemon lead. (2) agentwatch (the daemon lead, task age-0kh.28 after age-0kh.27): the daemon side; it can ship
first. (3) agent-browser: the relay, the stand-in daemon's ops, the shared generator, the README rows and
the live check; agentwatch's relay pin moves after this merges and its live check passes. Two build
points: `Bridge.answer` drops `data` on an error answer today, and the relay needs `pointer moved`'s
`data`; and the "`at` is T, no path" rule sends no op, so the daemon's `pointer moved` and `not now`
checks do not run: once the live view exists, the relay reads the pointer first in that case.

The limits:

- Each activation that brings a page under the pointer costs a path of 0.3 to 1.5 s, and a catch-up costs
  as long once after it (section 3, the limits of the step).
- **A position across scopes** (review-63b note 17; the lead accepts it as a residue): the front page can
  be a page of another scope or an operator tab. It sees the path's end, which is the entering page's last
  point, and a page that enters with no path enters at the last path's end. So the pages of one scope can
  learn where a page of another scope last saw the pointer: a position only, no content. Today over the
  relay the X pointer never moves. Not taken: paths only between two pages of one scope.
- A path gives the page under the pointer real moves and hovers inside its own content box at points that
  the pages' input chose: at most 5 paths a second, no click, key or read.
- Where the relay cannot know a page's point (section 3), that one activation is as today.
- **Movement 0 after the page loses the pointer** (measured, board ab-v16.71; fixed for known raises
  by board ab-v16.76): Chrome gives the covered page's next event movement 0. The cover mark now
  applies the catch-up even when its point is a client point. The same thresholds, path limits, held-button
  rule and per-tab bound of 4 unanswered catch-up moves apply. An unknown point still has no catch-up.
  A window change that the relay cannot observe remains outside this rule.
- **A kept geometry** (section 3, the geometry; review-68 N9): a front page that is no bridge tab uses its
  kept geometry, which can be out of date when its window moves or changes its size, or its content box
  changes, with no event that the relay sees: a site popup's `window.moveTo` or `window.resizeTo`, the
  page's own fullscreen change, a scrollbar that the page got or lost after the read (with no client
  attached, no `Page.frameResized` reaches the relay). The path then follows the old rectangle (at most its
  area): real moves and hovers only, at points from the pages' input, at most 5 paths a second, over what
  lies there now. On the agent browser's Xvfb only the relay and the receiver place windows. A window that
  comes on top during a path with no step (a popup) is the same class (section 5, "Not covered").

## 9. Questions for the daemon lead (the daemon side)

None is open. The daemon lead answered questions 1 to 6 (mail m98c6f1f) and 7 to 9 (mail m2933af4: the kills,
the limits, the error with `data`), and chose form (a) for the place check (mail md133a6e: the relay
sends `at`, the daemon keeps no state). The answers are in sections 2 and 4. The build adds the measured
accuracy of `xdotool sleep` (section 7) to section 2.
