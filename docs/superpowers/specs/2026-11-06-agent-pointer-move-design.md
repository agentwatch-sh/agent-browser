# The agent display's pointer, moved by the daemon at the relay's request — design

Date: 2026-11-06. Status: **DRAFT** (waits for a fresh reviewer and for aw-lead's agreement on the daemon
side). Author: taylor session `pointer-design`, a subagent of `ab-lead` (board task ab-v16.37, goal
ab-v16). Sources: agent-browser main `6e51439` (`src/input.ts`, `src/display.ts`, `src/relay/`, README
"The pointer when a window comes forward"), chrome-extension main `37b5647` (`docs/protocol.md` C4, C10,
C11), agentwatch main `18609d80` (read only: `agentwatch/daemon/browser/`, `docs/internals/agent-browser.md`,
the agent-browser design's section 5.6). No browser ran for this task. The numbers are those of ab-v16.26
(PR #47) and ab-v16.28 (PR #44).

**The problem.** When a window comes forward, the X server gives its page a real pointer event, with no
movement, at the X pointer. CDP input never moves the X pointer. Where agent-browser owns the display,
ab-v16.26 moves the X pointer (`xdotool mousemove`) as the last step of each path, so the next activation
enters where the page last saw the pointer: `run.ts design` measured 0 jumps over 100 px and 0 position
changes that the movement does not explain (4 runs, 2 after review-47, one after each later review).
Through agentwatch's relay no process has the Xvfb's `DISPLAY`, and the fallback runs: `design-no-x`
measured 5 unexplained position changes in 6 activations. aw-lead (mail m4f38c16) refused `DISPLAY` and
`XAUTHORITY` for agents and proposed the narrow way that this design settles: the daemon, which owns the
Xvfb, moves the pointer itself on a small request from the relay.

## 1. The answer in short

1. **The message:** a C10 op that the daemon answers itself, `daemon.movePointer {x, y, width, height,
   notAfter}`: the end point of the page's last pointer path in display pixels, the screen size the relay
   used, and a deadline. Not C4: the receiver has no part in it (section 2).
2. **Who and when:** the relay, for every client (agent-browser's commands over `--cdp-url`, Playwright,
   any CDP client), once in each activation step, before the page comes forward and so before the input
   that needed the activation (section 3).
3. **The checks:** only from the relay's pipe, only on the unit's Xvfb, the right screen size, inside the
   display, at most 10 moves a second, no move after the deadline. A refusal moves nothing, and the
   activation goes on as today (section 4).
4. **What a site sees:** the page that comes forward enters at its own last point (no jump, no
   unexplained change, also with two agents); the page that leaves sees one real move, explained by its
   movement, before its blur. The fallback is today's behaviour. On the Mac nothing moves (section 5).
5. **No raw X** for any agent; a raw-X way would be an operator decision, and this design needs none
   (section 6).

## 2. The message

**It belongs to C10, "The daemon and the relay".** C4 is the daemon's link to the receiver (native
messages). The receiver has no X access, and a pointer move has nothing to do with it. C10 already holds
the relay's requests on its standard output, the daemon's own answers (`not connected`, `timeout`, ...)
and lines (`link`, `allowlist`, `end_scope`), and the daemon already reads each relay line (the flag of
`bridge.attachNew`). So the move is one more op on that pipe that the daemon answers itself: no new
channel or socket, and only the relay, the daemon's own child, writes there. C11 gets one paragraph
(section 3).

```json
{"t":"req","id":"5f3a9c01-42","op":"daemon.movePointer","args":[{"x":812,"y":431,"width":1280,"height":900,"notAfter":1794312000300}],"wait":500}
```

- The prefix `daemon.` is reserved for ops that the daemon answers itself. The daemon never sends one to
  the receiver, and the receiver never implements one.
- The one arg has exactly these keys, each an integer. `x`, `y`: the point in the agent display's pixels
  (X root coordinates). `width`, `height`: the page's `screen.width` and `screen.height`, so the daemon can
  check that the page is on its display. `notAfter`: epoch ms on the box's wall clock (shared by the relay
  and the daemon); the daemon starts no move after it. Without it, a daemon that read the line late could
  move the pointer after the relay stopped waiting and raised the window: a real jump in the page that
  just came forward.
- The relay sets `notAfter` to its clock plus `POINTER_MOVE_MS = 300` and `wait` to
  `POINTER_WAIT_MS = 500`. The in-flight key is the shared key.

**The answer:** `{"t":"res","ch":"bridge","id":"<id>","ok":true,"data":{"x":<int>,"y":<int>}}`, the
pointer's position read after the move. The errors, in the order of the checks, each with no move:

| Text | When |
| --- | --- |
| `bad args` | the arg is not exactly that object of integers |
| `no display` | no unit Xvfb runs (also on the Mac), or the X call failed |
| `wrong display` | `width` and `height` are not the Xvfb's screen size |
| `out of bounds` | `x` outside `0..width-1` or `y` outside `0..height-1` |
| `not now` | only if aw-lead takes question 4: recent operator input in the live view |
| `too many moves` | 10 moves were made in the last second |
| `too late` | the daemon's clock is past `notAfter` when the move would start |
| `unknown op` | an older daemon passed the op to the receiver, whose first check refuses it (C10) |

The last row needs no code and no version flag: the request never reaches Chrome, and the relay falls
back.

## 3. Who sends it, and when

The relay sends it, only where it opens a window per page (`windowPerPage`, Linux), for every client: it
sees the `Input.dispatchMouseEvent` of agent-browser's commands and of Playwright alike.

**The page's last point.** For each tab the relay keeps, in memory, the `x` and `y` of the last
`Input.dispatchMouseEvent` (any type) on the tab's own session, in client CSS px. A child session's input
changes nothing. The entry goes at `tabs.onRemoved`; a relay restart starts with none.

**The activation step** (`src/relay/model.ts`, `activate`; one step at a time for all connections):

1. Read the tab (`tabs.get`) and its window (`windows.get`), as today.
2. If the page will come forward (its tab is not active or its window has no focus), its last point is
   known and the move is on: read its geometry, compute the display point, send `daemon.movePointer`, and
   wait for the answer or until `notAfter + POINTER_SLACK_MS` (200 ms). Send nothing when the point is
   the one that the last answered move gave.
3. Bring the page forward: `tabs.update` and `windows.update` as today, or the client's own
   `Page.bringToFront`, or the `tabs.update` of `Target.activateTarget`.
4. The input that needed the activation goes. After a `Page.bringToFront`, the client sends its input
   after the answer.

So the pointer is at the page's last point before its window comes forward, and the activation's real
event comes there. A client's `Page.bringToFront` (agent-browser's `Hands.begin` and `Tab.toFront`) and
`Target.activateTarget` join the activation chain; today they go at once. The step stays inside
`ACTIVATE_MAX_MS` (2 s), and a step that gave up sends no move (a geometry read can wait behind a page's
dialog). Today's step took a median of 16 ms, plus 29 ms for a raise (C11); the read
and the move add one round trip each.

**The display point.** The relay maps as `src/input.ts` (`origin`) does, from the same values: `screenX`,
`screenY`, `outerWidth`, `outerHeight`, `innerWidth`, `innerHeight`, `devicePixelRatio`,
`visualViewport.scale`, `screen.width` and `screen.height`, read by one `Runtime.evaluate` in the relay's
own isolated world (`Page.createIsolatedWorld` on the main frame, again after a navigation). This is the
mapping with which `run.ts design` measured 0 unexplained changes; behind `cdpUrl` ab-v16.26 checks it at
each activation (the real event within 3 px of the X pointer). With `side = round((outerWidth -
innerWidth) / 2)`: `x = round(screenX + side + px)`, `y = round(screenY + outerHeight - innerHeight - side
+ py)`, after `px`, `py` are clamped into the viewport. So the point is inside the page's own viewport,
never on its window's UI. No request when the ratio or the scale is not 1, the window is minimized, or the
point is off the screen. The relay drops its world's `Runtime.executionContextCreated` and
`executionContextDestroyed` events, so no client sees the world, and no page script sees its reads. Not
taken: `windows.get` with `Page.getLayoutMetrics` and no page read. Those metrics leave out the
scrollbars (about 7 px off on a page with a vertical scrollbar), unless the live check shows 0 px.

**C11's new paragraph** (in "One window per page"): this step; no client method reaches the op; the relay
sends it only from its own last points.

## 4. The daemon's checks, and what a refusal does

- **Only the relay's link.** The daemon takes the op only from its relay's standard output (the carrier's
  `from_relay`); no gateway route, CLI verb, socket or receiver message reaches it, and the relay maps no
  client method to it. The daemon answers it before the link checks and outside the queue and
  `MAX_BYTES_IN_FLIGHT`, because it never goes to the receiver.
- **Only the agent display.** Only the unit's own Xvfb (the display of `unit.json`, with the unit's X
  auth file), only while the unit runs, never a display of the daemon's own environment. `width` and
  `height` must equal the Xvfb's `-screen` size (`browser.display_size`).
- **The bounds:** `0 <= x < width`, `0 <= y < height`.
- **The rate:** at most `POINTER_MOVES_PER_S = 10` moves in any second; a refused one does not count. The
  relay sends at most one per activation, and the activations of agents and of a person come far less
  often, so the limit only bounds a fault.
- **The deadline**, checked right before the move.
- **The move:** one absolute pointer move on that display, the X request of `xdotool mousemove X Y` that
  ab-v16.26 measured; no button, no key, no read of pixels; then a read of the pointer for the answer.
- **A refusal** moves nothing. The daemon logs the op, the text and a count (at most one line for each
  text in a minute; never the point, C10's log rule). The relay logs each text at most once in 5 minutes,
  does not try again, and goes on without the move (the fallback). After `unknown op` it sends no more
  requests until the next `link` up line. No answer by `notAfter + POINTER_SLACK_MS` counts as a refusal,
  and no move can start after `notAfter`.

## 5. What a site sees

| | agent-browser's own display (ab-v16.26) | through the relay, this design | the fallback (the relay today) |
| --- | --- | --- | --- |
| the entry of the page that comes forward | at the X pointer: where the last path of any page ended | at this page's own last point, movement 0 | at the X pointer, wherever it is |
| unexplained position changes there | 0 (`design`); 1 with two agents (`design-two`) | 0 expected, also with two agents (to measure) | 5 in 6 activations (`design-no-x`) |
| the page that leaves (in front at the move) | nothing: the X move was its own path's last step | one real `mousemove` from its last point to the moved point, expected with the movement that explains it (over 100 px when the points are far apart), a hover there, then its `blur` | nothing |

- agent-browser's own paths start at the entry (`input.ts`), now the page's last point, so they show no
  jump. `input.ts` needs no new logic; its log line "the X-pointer method is off ... over agentwatch's
  relay" changes to say that the relay moves the pointer at each activation.
- For Playwright and other clients the entry now matches the page's last point. Their own raw input (one
  move, no path) stays a listed signal, and so does their input while another client's activation moves
  the pointer (no input lock across clients).
- Chrome gives a real move its movement from the page's last point (ab-v16.26: a move to the point where
  a CDP path ended had movement 0), so the leaving page's move should be explained, not a position
  change; only one point of that rule was measured, so the live check measures it. The trade against
  ab-v16.26: the residue moves from the page that gets the input to the page that leaves. The live check
  counts both.
- Not covered: a window that comes to the top with no activation step (a new window, a site's popup, a
  close that shows the window below). Its page enters at the X pointer, as today.
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
per-scope lists). Here no agent makes an X call: the daemon makes one kind of X request, a pointer move to
a point that the relay computed from the page's own input and clamped into that page's viewport, checked
and rate-limited; never a click, a key or a read.

A raw-X way (the Xvfb's `DISPLAY` and `XAUTHORITY` for agent-browser's commands in agent sessions) would
change the trust boundary, and only the operator can decide it: each program of each agent session could
read the whole display and send any input to Chrome's UI, outside the relay. Its reason would be the
measured 5 unexplained position changes in 6 activations. This design is expected to remove them with no
raw X, so ab-lead asks the operator only if the live check of section 7 fails.

## 7. The tests that the build needs

**Unit (agent-browser, test first, `test/fake-bridge.ts`):** the last point (each event type, the tab's
own session only, gone at `tabs.onRemoved`); the order (the op before `tabs.update`, `windows.update`, a
client's `Page.bringToFront` and `Target.activateTarget`, the input after them, no interleaved moves of two
activations); the mapping with fake geometry and the clamp; no request with no last point, a ratio or a
scale that is not 1, a minimized window, a point off the screen, the last answered point, or
`windowPerPage` false; the exact arg keys and integers; each answer (`ok`; each error goes on with no move
and one log line in 5 minutes; `unknown op` stops until the next link up; no answer goes on at
`notAfter + POINTER_SLACK_MS`); a client with `Runtime.enable` sees no context of the relay's world; no
client method becomes the op.

**Contract vectors (chrome-extension `test/vectors/bridge.json`):** a valid request and answer; `bad args`
(a missing key, an extra key, a float, a negative value, a string); `out of bounds`; `wrong display`;
`too late`; 11 moves in a second (the 11th gets `too many moves`); a `daemon.*` op at the receiver gets
`unknown op`. The relay's tests and aw-lead's daemon tests use the same vectors.

**Live (taylor, in the harness's own private Xvfb; never the operator's agent browser, never the live
suite's external mode):** the stand-in daemon (`test/live/agent-mode/daemon.ts`) gets the op, with the
checks of section 4 and `xdotool` on the run's display. Through the real relay, run the anti-detect
probe's `design` and `design-two` with agent-browser's commands over `--cdp-url`, and a Playwright case
with two pages in two windows in turn. Count, in the page that comes forward and in the page that leaves:
jumps over 100 px, unexplained position changes, entries at an earlier entry's point, zero-movement
moves, and the size of the leaving page's move. Check the mapping (entry at the last point, 0 px) on a
page with a vertical scrollbar, one with a horizontal scrollbar, and a site's popup of another size. Pass:
0 jumps and 0 unexplained changes in the page that comes forward, for both kinds of client, and
`test/live/agent-mode/` in full. Then agentwatch's live test with the real daemon (aw-lead).

## 8. Open questions for aw-lead (the daemon side)

1. Do you agree to a C10 op of the daemon's own on the relay's pipe, with the reserved prefix `daemon.`,
   answered before the link checks and outside the queue and `MAX_BYTES_IN_FLIGHT`?
2. The X call: the request of `xdotool mousemove` (measured in ab-v16.26), by `xdotool` on the unit's
   display or by the same request from Python? The live view (design section 5.6) plays the operator's
   input with `xdotool` too. Another way needs the live check again.
3. The values: 10 moves a second, `notAfter` on the wall clock, the answer with the position read after
   the move. Do they suit the daemon?
4. The live view: should the daemon refuse (`not now`) while the operator's input in the live view is
   recent, and for how many seconds? A move pulls the pointer that the operator sees.
5. Is the Xvfb's `-screen` size fixed for the unit's life (the `wrong display` check)?
6. The log: one line for each refusal text a minute, with no point. Is that enough?
7. Which agentwatch task builds the daemon side, and does its pin move with the relay change? No backward
   compatibility is needed: an older daemon gives `unknown op`, and the relay falls back.

## 9. The build split and the limits

The build: (1) chrome-extension, the C10 text, C11's paragraph and the vectors, after aw-lead agrees;
(2) agent-browser, the relay (last points, the step, the world, the mapping, the fallback), the stand-in
daemon's op, `input.ts`'s log line, the README rows, and the live check; (3) agentwatch (aw-lead), the
daemon's op, its checks, its tests on the vectors, and its live test.

The limits:

- The page that leaves sees one real move and a hover before its blur. When the front window is smaller
  or placed elsewhere, the point can be over its tab strip or toolbar: a hover there, never a click.
- A move can give a page of another scope a real `mousemove` at a point that a client's input chose: one
  point per activation, at most 10 a second, no click, key or read.
- The last points live in the relay's memory, so after a relay restart a page's first activation has no
  move (the fallback).
