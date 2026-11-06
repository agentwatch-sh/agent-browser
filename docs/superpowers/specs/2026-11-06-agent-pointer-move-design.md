# The agent display's pointer, moved by the daemon at the relay's request — design

Date: 2026-11-06. Status: **DRAFT, revision 2** (after review-63 at `b340c26` and aw-lead's answers, mail
mb5c6cbf; waits for a fresh review). Author: taylor session `pointer-design`, a subagent of `ab-lead`
(board task ab-v16.37, goal ab-v16). Sources: agent-browser main `6e51439` (`src/input.ts`,
`src/record.ts`, `src/display.ts`, `src/relay/`, README "The pointer when a window comes forward"),
chrome-extension main `37b5647` (`docs/protocol.md` C4, C10, C11), agentwatch main `18609d80` (read only:
`agentwatch/daemon/browser/`, `docs/internals/agent-browser.md`, the agent-browser design's section 5.6).
No browser ran for this task. The numbers are those of ab-v16.26 (PR #47) and ab-v16.28 (PR #44).

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

Two facts carry the design. (1) The activation's real event has no movement and comes at the X pointer
(ab-v16.26: "the real event where the window came forward (no movement, at the page's last point)").
(2) Chrome gives a real move under the pointer its movement from the page's last point, not from the X
pointer's last place (ab-v16.26: a move to the point where a CDP path ended had movement 0).

## 1. The answer in short

1. **The messages (section 2):** two C10 ops that the daemon answers itself. `daemon.movePointer`
   carries a person-shaped path in display pixels (`from`, up to 120 points with their times, the screen
   size, a deadline); the daemon plays it with one chained `xdotool` call and answers the pointer's
   position after the last point. `daemon.pointerAt` reads the pointer's position. Not C4: the receiver
   has no part in them.
2. **The path (section 3):** at each activation step that brings a page forward, the relay plans a path
   with `src/input.ts`'s generator from the last point of the page under the pointer (the page that
   leaves) to the last point of the page that comes forward, and waits for it to end before the window
   comes forward. Then it records the path's end as the leaving page's last point.
3. **The checks (section 4):** only from the relay's pipe, only the unit's Xvfb, the screen size of the
   running Xvfb, each point inside it, each step at most 100 px, path limits, one X call at a time, 5
   paths a second, a deadline. A refusal moves nothing.
4. **What a site sees (section 5):** both pages see a person's input: the leaving page a path of real
   moves, then its blur; the entering page its entry at its own last point. When the relay cannot know a
   page's point, it sends no path, and that one activation is as today (no jump; one unexplained change
   at most). On the Mac nothing moves.
5. **No raw X (section 6)** for any agent.

## 2. The messages (C10)

**They belong to C10, "The daemon and the relay".** C4 is the daemon's link to the receiver (native
messages); the receiver has no X access. C10 already holds the relay's requests on its standard output,
the daemon's own answers and lines, and the daemon already reads each relay line. So these are two more
ops on that pipe that the daemon answers itself: no new channel or socket, and only the relay, the
daemon's own child, writes there. C11 gets one paragraph (section 3).

**The daemon side (aw-lead's answers 1, 2, 6).** The prefix `daemon.` is reserved. The daemon handles a
`daemon.` op in `from_relay` after the parse and the duplicate-id check, before the link checks, outside
the queue and `MAX_BYTES_IN_FLIGHT`; it never forwards any `daemon.` op, and it answers an unknown one
`unknown op` itself. The X call runs in its own task, one at a time, off the carrier's read lock (so no
bridge line waits for it). It runs `xdotool` by absolute path, with an argv and no shell, with an
environment of only `DISPLAY=:N` and `XAUTHORITY=<the unit's X auth file>`, with no `--sync`. A missing
`xdotool` is `no display`; a failure is read from the exit code, not from standard error.

**`daemon.pointerAt`**, args `[]`: `{"x":<int>,"y":<int>,"width":<int>,"height":<int>,"views":<int>}`. One
`xdotool getmouselocation` (1 s timeout). `width` and `height` are the running Xvfb's size; `views` is
the count of the operator's live-view inputs (0 while there is no live view).

**`daemon.movePointer`**, one arg:

```json
{"from":{"x":640,"y":410},"path":[{"x":652,"y":405,"dt":16},{"x":671,"y":398,"dt":16},{"x":700,"y":402,"dt":33}],
 "width":1280,"height":900,"notAfter":5839201300,"views":0}
```

- `from`: the path's start, the point where the page under the pointer last saw it (section 3). It is
  not played; the first step is measured from it.
- `path`: 1 to `POINTER_PATH_MAX_POINTS = 120` points `{x, y, dt}`, integers. `dt` is the wait in ms
  before that point's move, `POINTER_DT_MIN_MS = 4` to `POINTER_DT_MAX_MS = 250`; the sum of the `dt`
  is at most `POINTER_PATH_MAX_MS = 1500`. Each step (from `from` to the first point, then point to
  point) is at most `POINTER_STEP_MAX_PX = 100` px (the probe's jump rule), and every point is inside
  the display.
- `width`, `height`: the screen size that the relay used (the pages' `screen.width`, `screen.height`).
- `notAfter`: ms on `CLOCK_MONOTONIC` (Node's `process.hrtime`, Python's `time.monotonic`; one clock for
  every process of the box, so a wall-clock step does not change it). The daemon starts no path after
  it; one more than 2000 ms ahead is `bad args`.
- `views`: the `views` that the relay last read (see `not now`).

The daemon plays it as one call, `xdotool sleep <dt1> mousemove <x1> <y1> sleep <dt2> mousemove <x2>
<y2> ... getmouselocation` (each `sleep` in seconds with 3 decimals), with a timeout of the path's total
time plus `POINTER_KILL_MS = 1000`; at the timeout it kills the call and answers `no display`. It
answers after the last point: `{"x":<int>,"y":<int>,"views":<int>}`, the pointer's position read at the
end. The ops' answers and errors have C10's `res` shape. The errors, in the order of the checks, each
with no X call except `no display` (an X call that failed can have moved the pointer in part):

| Text | Op | When |
| --- | --- | --- |
| `bad args` | both | not exactly the fields above, a limit above broken, `notAfter` more than 2000 ms ahead |
| `no display` | both | no unit Xvfb (also on the Mac), no `xdotool`, or the X call failed or timed out (a path can have run in part) |
| `wrong display` | move | `width`, `height` are not the running Xvfb's size |
| `out of bounds` | move | a point or `from` outside `0..width-1`, `0..height-1` |
| `busy` | both | another X call of the daemon runs |
| `not now` | move | when the live view exists: `views` is not the current count, or the operator's last live-view input is less than 10 s old |
| `too many moves` | both | 5 paths (move) or 10 reads (read) started in the last second; refusals do not count |
| `too late` | move | the clock is past `notAfter` when the call would start |
| `unknown op` | both | a daemon from before this change (its receiver answers it), or an unknown `daemon.` op |

**The ops table rows and the waits.** C10 says that the relay sends each op's default wait; these two
ops are the exception. `daemon.pointerAt` has the wait 1200 ms. `daemon.movePointer` has, per request,
`POINTER_START_MS` (300, the lead of `notAfter`) plus the path's total time plus `POINTER_KILL_MS` plus
`POINTER_SLACK_MS = 200`. Both have the in-flight key `pointer` of their own, so the shared key's queue
never holds them back. `Bridge.call` gets a per-call wait, and for these ops a timer of the relay: at the
wait it goes on and drops a late answer. No path can still play then: it started at the latest at
`notAfter`, and the daemon killed it `POINTER_KILL_MS` after its total time.

## 3. The relay

The relay does this only where it opens a window per page (`windowPerPage`, Linux), for every client: it
sees every client's input. No client method reaches a `daemon.` op.

**What it keeps** (in memory):

- **The pages' last points**, in client CSS px, keyed by target id. A client's `Input.dispatchMouseEvent`
  and `Input.dispatchDragEvent` (every type) on the tab's own session set it when the call is sent to
  Chrome; a child session's input changes nothing. Section 3's records below set it too. A point goes at
  `tabs.onRemoved` and `tabs.onReplaced`; a link change keeps the points of the targets that step 3 of
  the link up lists again (a Chrome restart gives new target ids).
- **The front page:** the page under the pointer. It is the page of the relay's last activation step. A
  new tab that opens a window, or that becomes the active tab of the front page's window, is the front
  page then (it comes on top), with no last point. The front page is unknown at the relay's start, at a
  link change, at `tabs.onRemoved` or `tabs.onReplaced` of the front page, and after a refusal or a
  failed path.
- **The held buttons:** a tab holds a CDP button from a `mousePressed` until Chrome answered its
  `mouseReleased`; the hold goes at `tabs.onRemoved`, at a link change, and when the client's connection
  closes.
- **On or off:** at each link up the relay sends `daemon.pointerAt`. An answer turns the paths on, and
  gives the display's size and `views`. `no display` turns them off until the first activation 60 s
  later, which sends `daemon.pointerAt` again; `unknown op`, `wrong display` and any other error of the
  probe (an older daemon's `not connected`, say) turn them off until the next link up. While they are off, the relay makes no world, reads no geometry and sends
  nothing.

**The activation step** (`src/relay/model.ts`, `activate`; one step at a time for all connections).
Today it reads and acts in turn: `tabs.get`, `tabs.update`, `windows.get`, `windows.update`. The new step
reads first:

1. **Wait for the buttons.** While a tab holds a CDP button, wait, at most `ACTIVATE_MAX_MS` (2 s). At
   the limit: no path in this step, and the step goes on as today. The wait also keeps today's raise
   from blurring a page during its press.
2. **Read** the tab (`tabs.get`) and its window (`windows.get`).
3. **Decide.** The page comes forward when its tab is not active or its window has no focus (for the
   relay's own activation and a client's `Page.bringToFront`). For `Target.activateTarget` it comes
   forward only when its tab is not active and its window has the focus: a tab switch behind another
   window puts nothing under the pointer. A page that does not come forward gets no path. Nor does a
   page that is the front page already (a new window on top, with no focus).
4. **Plan.** Read the geometry of the entering page and of the front page (one `Runtime.evaluate` each,
   in parallel, below). The path goes from the front page's last point S to the entering page's last
   point T, both in display px. With the generator of `src/input.ts`'s CDP paths (`planMove` and its
   sampling: ghost-cursor's curve, Fitts's-law time of 300 to 1000 ms per leg, an overshoot leg past
   500 px, 12 to 60 moves one each 16 to 25 ms, whole pixels, no move without movement), with the
   default target width 24. A step over 100 px gets the curve's point at its middle time (`pointAt`)
   until none is over. When S equals T, the path is a short out-and-back of 2 to 4 px, so that no move
   is without movement. A path that does not fit section 2's limits (only on a very large display) is
   not sent.
5. **Play.** Hold every client's `Input.dispatchMouseEvent` and `Input.dispatchDragEvent` (any tab) while
   the path plays. Send `daemon.movePointer` and wait for its answer, at most its wait. In a step with no
   path (below) and paths on, read the pointer with `daemon.pointerAt` instead: the entering page's entry
   comes at that position.
6. **Record**, on `ok` only (aw-lead: `no display` can come after a part of a path): the answered position,
   mapped into the leaving page's viewport, is its last point (unknown when it is outside that
   viewport); when it is not T, log it once. The answered or read position, mapped into the entering
   page's viewport, is the entering page's last point (unknown when the read failed or its geometry is not
   usable), and the entering page is the front page.
7. **Bring the page forward:** `tabs.update` and `windows.update`, or the client's own
   `Page.bringToFront`, or the `tabs.update` of `Target.activateTarget`. Today's 2 s limit applies to
   steps 2 and 7.
8. The input that needed the activation goes (after a `Page.bringToFront`, the client sends its input
   after the answer), and sets the entering page's last point again when it is a pointer input.

**When the relay sends no path** (the fallback: the activation goes on as today): the paths are off; the
front page is unknown, or its last point and the pointer are both unknown; the entering page has no last
point (its entry is then its first pointer event, so it is no position change); a geometry is not usable
(below); the buttons' wait reached its limit; or the daemon refused. The front page's last point, when
unknown, is the pointer's position (`daemon.pointerAt`): a page that came on top with no path entered
there. The first activation after the relay's start or a link change has no path, because the front page
is unknown; from its record on, the front page is known.

**Why the path starts at the leaving page's last point**, and not at the pointer's last answered
position: the leaving page usually got CDP input after it came forward, so its last point is no longer
where the pointer is. By fact (2), its first real move would then have the movement from its own last
point to the pointer's place, often over 100 px. From S, each real move is one step of the path for that
page. The X pointer's own place does not show (fact 2), so the path's first move may warp it from
wherever it is.

**The geometry.** The mapping of `src/input.ts` (`origin`) uses 7 values: `screenX`, `screenY`,
`outerWidth`, `outerHeight`, `innerWidth`, `innerHeight`, `devicePixelRatio`. The relay reads them and 3
more (`visualViewport.scale`, `screen.width`, `screen.height`) in its own isolated world
(`Page.createIsolatedWorld` on the main frame, again after a navigation). With `side = round((outerWidth
- innerWidth) / 2)`: display `x = round(screenX + side + px)`, `y = round(screenY + outerHeight -
innerHeight - side + py)`, after `px`, `py` are clamped into the viewport; the inverse maps a display
point into a page. The read uses C10's default wait for `debugger.sendCommand` (a short C10 wait would
end in a timeout, and C10 then detaches the tab and ends its client sessions); the relay stops waiting
after `GEOMETRY_WAIT_MS = 200` (a page can hold a dialog) and drops the late answer. The relay drops its
world's `Runtime.executionContextCreated` and `executionContextDestroyed` events, so no client sees it,
and no page script sees its reads. A geometry is not usable when the ratio or the scale is not 1, the
window is minimized, the screen size is not the display's, or a device-metrics override is in force on
the tab (a client's `Emulation.setDeviceMetricsOverride` until its `clearDeviceMetricsOverride`:
Playwright's `setViewportSize`, agent-browser's `record`), because `innerWidth` and `innerHeight` then do
not give the window's real viewport. Without an override, each point is inside the page's own viewport,
never on its window's UI. Not taken: `windows.get` with `Page.getLayoutMetrics` and no page read: those
metrics leave out the scrollbars (about 7 px off with a vertical scrollbar).

**The cost.** The path takes 0.3 to 1.5 s at each activation that brings a page forward, also for the
reads of agent-browser that bring a hidden window page forward (`Tab.toFront` for `text`, `outline`,
`eval` and waits). Other activations and the held input wait behind it. The live check measures it.

**C11's new paragraph** (in "One window per page"): the steps above; no client method reaches a `daemon.`
op; the relay holds the clients' pointer input while a path plays.

## 4. The daemon's checks, and what a refusal does

- **Only the relay's link** (section 2): no gateway route, CLI verb, socket or receiver message reaches
  the ops.
- **Only the agent display:** the unit's own Xvfb (the display of `unit.json`, with the unit's X auth
  file), only while the unit runs. The size is the running Xvfb's: the daemon records it in `unit.json`
  when it starts the Xvfb, and reads it from X once for an adopted unit; never the current config
  (`browser.display_size` can differ from an adopted Xvfb's size). No "only the agent Chrome's windows"
  check is needed: the Xvfb is private (`-nolisten tcp`, a cookie of its own in a 0600 file), so only the
  unit's Chrome and the daemon put windows on it.
- **The path's limits** (section 2), each point inside the display, each step at most 100 px.
- **One X call at a time** (`busy`), **5 paths and 10 reads a second**, and **the deadline**, checked right
  before the call starts.
- **The call:** absolute pointer moves and one read of the pointer; no button, no key, no read of pixels.
- **The live view** (when it exists; aw-lead's answer 4): `not now` for 10 s after the operator's last
  live-view input, and when the request's `views` is old.
- **A refusal** makes no X call (`no display` can follow a failed call). The daemon logs the op, the text and a count (one line for each text a
  minute; never a point, C10's log rule). The relay logs each text at most once in 5 minutes, does not try
  again in that step, and goes on with no path. After `not now` the front page is unknown (the operator
  may have raised a window), and the relay reads `daemon.pointerAt` again.

## 5. What a site sees

| | agent-browser's own display (ab-v16.26) | through the relay, this design | the fallback (the relay today) |
| --- | --- | --- | --- |
| the page that comes forward | its entry at the X pointer: where the last path of any page ended | its entry at its own last point, movement 0 | its entry at the X pointer, wherever it is |
| unexplained position changes there | 0 (`design`); 1 with two agents (`design-two`) | 0 expected, with two agents too, after each page's first activation | 5 in 6 activations (`design-no-x`) |
| the page that leaves (under the pointer during the path) | nothing: the X move was its own path's last step | a path of 12 to 60 real moves (more after a split), each at most 100 px, from its own last point, then its `blur` | nothing |

- **agent-browser's commands:** the path of `Hands` starts at the entry (`input.ts`), now the page's last
  point: 0 jumps and 0 unexplained changes expected in both pages. `input.ts` needs no new logic; its log
  line "the X-pointer method is off ... over agentwatch's relay" changes to say that the relay moves the
  pointer at each activation.
- **Playwright and other clients:** the entry and the leaving page's path are as above. Playwright keeps
  its own mouse position per page, so its next raw move goes from the page's last point (now the path's
  end, when the page left in between) to its target in one move: a jump when they are far apart. That is
  Playwright's own raw input, a listed signal (README, "What a site can still see"), with no path.
- **Two clients at once:** the button wait (step 1) and the held input (step 5) keep a path out of another
  page's press and out of its CDP moves. Their input in the same page at once stays a listed signal (no
  input lock across clients).
- **Not covered:** a window that comes on top with no activation step (a new window, a site's popup, a
  close that shows the window below, the live view's click). Its page enters at the X pointer, as today;
  the relay marks the front page as section 3 says.
- **The Mac: no move.** The agent browser runs on the operator's screen and its pages are background tabs
  (`windowPerPage` is false until ab-v16.27): the relay has no activation step and sends nothing, and a
  Mac daemon has no unit Xvfb (`no display`). agent-browser keeps its rule "never take the operator's
  pointer": input is CDP input inside the tab, and a background tab is under no pointer, so it gets no
  entry event. ab-v16.27 measures the Mac; the pointer there stays the operator's.
- On Linux, where agent-browser started its agent Chrome on a display of its own, ab-v16.26's way stays.

## 6. Why no agent gets raw X

aw-lead's reasons (mail m4f38c16): raw X input reaches Chrome's UI and `chrome://extensions` (an agent
could switch the agent extension off, and its allowlist rules with it), and X access allows raw
screenshots of the whole display (other scopes' pages, the operator's tabs). Both break the rule that
agents reach the agent browser only through the relay and its refusals (C11, the peer check, the
per-scope lists). Here no agent makes an X call: the daemon moves the pointer along a path that the relay
computed from the pages' own input, inside the display, checked and rate-limited, and reads the pointer's
position; never a click, a key or a read of pixels.

A raw-X way (the Xvfb's `DISPLAY` and `XAUTHORITY` for agent-browser's commands in agent sessions) would
change the trust boundary, and only the operator can decide it: each program of each agent session could
read the whole display and send any input to Chrome's UI, outside the relay. Its reason would be the
measured 5 unexplained position changes in 6 activations. This design is expected to remove them with no
raw X, so ab-lead asks the operator only if the live check of section 7 fails.

## 7. The tests that the build needs

**Unit (agent-browser, test first, `test/fake-bridge.ts`):**

- the last points (both methods, every type, set when sent to Chrome, the own session only, kept over a
  link change for listed targets, gone at `tabs.onRemoved` and `tabs.onReplaced`); the front page (each
  rule of section 3); the held buttons;
- the step's order: button wait, reads, path, record, `tabs.update`, `windows.update` or the client's
  call, input; no path for an active tab's `Target.activateTarget`, for the front page itself, at the
  button limit, with paths off, with an unknown front page, with no last point, with an unusable geometry;
- the path: the generator's points, no step over 100 px after the split, the out-and-back, the limits
  of section 2, `from`, `notAfter`, the per-request wait and the key `pointer`;
- the answers: `ok` records both pages; each error goes on with no record; `unknown op`, `wrong display`
  and the probe's other errors turn the paths off until the next link up, `no display` for 60 s; a late
  answer is dropped; the clients' pointer input waits during a path and then goes in order;
- the world: a client with `Runtime.enable` sees no context of it; the geometry read's own 200 ms.

**Contract vectors (chrome-extension `test/vectors/bridge.json`):** both ops, valid; `bad args` for each
limit (points, `dt`, total, a step over 100 px, `notAfter` too far, a missing or extra key, a float);
`out of bounds`; `wrong display`; `too late`; `busy`; 6 paths and 11 reads in a second; an unknown
`daemon.` op; a `daemon.` op at the receiver gets `unknown op`. The relay's tests and aw-lead's daemon
tests use the same vectors.

**Live (taylor, in the harness's own private Xvfb; never the operator's agent browser, never the live
suite's external mode).** The stand-in daemon (`test/live/agent-mode/daemon.ts`) gets both ops with the
checks of section 4 and the chained `xdotool` call. Through the real relay:

- the anti-detect probe's `design` and `design-two` with agent-browser's commands over `--cdp-url`, and
  a Playwright case; each with two pages in two windows in turn for at least two rounds;
- two clients: one holds a press (and once a 3 s press, for the limit) while the other activates: no
  real move between its `mousedown` and `mouseup`; an active tab's `Target.activateTarget`: no path;
- the mapping on a page with a vertical scrollbar, one with a horizontal scrollbar, a popup of another
  size, and a device-metrics override (no path);
- counted in both pages: jumps over 100 px, unexplained position changes, zero-movement moves, entries
  at an earlier entry's point, the path's moves and speed against the probe's person baseline, the
  `dt` that the page saw, and the activation's time.

The pass mark: after each page's first activation, the activation's events (the path and the entry) show
0 jumps, 0 unexplained changes and 0 zero-movement moves in both pages, for agent-browser's commands and
for Playwright, and the leaving page's moves look like the person's; Playwright's own raw moves are
counted apart. `test/live/agent-mode/` passes in full. Then agentwatch's live test with the real daemon
(aw-lead's task age-0kh.28, on the age-cqd test browser).

## 8. The build split and the limits

The build: (1) chrome-extension: the C10 text (the two ops, their rows and waits, the daemon's checks)
and C11's paragraph, with the vectors; their commit goes to aw-lead. (2) agentwatch (aw-lead, task
age-0kh.28 after age-0kh.27): the daemon side; it can ship first. (3) agent-browser: the relay, the
stand-in daemon's ops, the shared generator, `input.ts`'s log line, the README rows, and the live check;
agentwatch's relay pin moves after this merges and its live check passes.

The limits:

- Each activation that brings a page forward costs a path of 0.3 to 1.5 s.
- A path gives the page under the pointer, which can be another scope's page or an operator tab, real
  moves and hovers at points that the pages' input chose: at most 5 paths a second, no click, key or read.
  When the front window is smaller or placed elsewhere, a point can be over its tab strip or toolbar: a
  hover there, never a click.
- Where the relay cannot know a page's point (section 3), that one activation is as today.

## 9. Open questions for aw-lead (the daemon side)

1. The path form and its limits: `{from, path: [{x, y, dt}], width, height, notAfter, views}`, 1 to 120
   points, `dt` 4 to 250 ms, at most 1500 ms in all, each step at most 100 px, every point inside the
   display, one X call at a time (`busy`), 5 paths a second.
2. The chained call `xdotool sleep s mousemove x y ... getmouselocation` (one process, up to about 600
   argv words), its timeout of the path's time plus 1000 ms, the kill and `no display` at the timeout.
   Does `xdotool`'s `sleep` keep `dt` to a few ms? The live check measures it.
3. The new read op `daemon.pointerAt` (`getmouselocation`, 1 s timeout, 10 a second), also used at each
   link up to tell whether the daemon serves the ops.
4. `notAfter` on `CLOCK_MONOTONIC`, injected, in place of the wall clock (review-63 note 12); still
   `bad args` more than 2000 ms ahead.
5. When the live view exists: the `views` count in both answers, `not now` for an old count; and should
   the operator's input stop a path that plays (kill the call, answer `not now`)?
6. The per-request waits of the two ops and the key `pointer` in C10 (the exception to "each op's default
   wait"); the daemon answers both itself, so its own `timeout` never applies to them.
