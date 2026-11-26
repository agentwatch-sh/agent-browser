# The stored sign-ins and the sign-in act on the Mac — design note

**Status: part 1 of board ab-v16.97.14 (the design and the Mac probe). No product code and no contract text change in
part 1: section 7 holds the proposed contract sentences, and section 8 the build of part 2.** Part 2 starts after board
ab-4wh.16 (the blanket profile on the Mac) merges, because both change `src/service/mac.ts`, `src/service/service.ts`
and the status.

Date: 2026-11-26. Author: a contributor, a builder subagent of the lead. Branch `ab-v16.97.14-signins-mac` in
agent-browser, from main `30b3efe`.

This note is a companion of the stored sign-ins design
([2026-11-10-stored-sign-in-credentials-design.md](2026-11-10-stored-sign-in-credentials-design.md), "the design"
below): its sections 4, 5.5, 7.3, 10, 13 (row 11) and 15 point here. It keeps every rule of the design, of C11 ("The
sign-in act") and of C12 ("The stored sign-ins"), except where section 7 names a sentence.

## 1. The evidence and its marks

Each fact below has one mark:

- **(M)** measured: by a run that this note names;
- **(C)** from the code: read in this repository at `30b3efe`, in chrome-extension at `4a4eb50` (read only), or in
  agentwatch at `ed582dc2` (read only);
- **(A)** assumed: from Apple's or Chromium's documentation or source as known on the Linux server, not measured. The
  Mac run of the probe (section 9) measures the ones that it can.

The runs that this note uses:

- the Chrome comparison of 2026-11-03 on the operator's Mac (`docs/research/2026-11-03-chrome-vs-chrome-beta.md`,
  section 8, check 9; Chrome stable 156): an agent window behind the operator's window;
- the give-back measure of 2026-11-04 (`src/giveback.ts`): Chrome activates itself at its first window (12 of 12
  starts), and NSRunningApplication's `activateWithOptions` gives the front back with no prompt;
- the Mac memory probe of 2026-11-25 (board ab-v16.97.8, part 1; the design, section 5.5): DevToolsSecurity disabled,
  SIP enabled, the user in the group `_developer`, Darwin 27.0.0 arm64;
- board ab-v16.94.34 (the daemon lead's Mac measure) and the blanket design's M2 on the Mac (Chrome 158.0.8127.37): the
  receiver's entry and developer mode live only in `Default/Secure Preferences`, and Chrome drops the service's write of
  `Default/Preferences`;
- the design's round 1 (Linux, Chromium 156): the 50% rule of `windows.update`, the X move;
- this probe's Linux twin (section 9.3; Chromium 156 on a private Xvfb with no window manager): a check of the probe's
  flow, never a measure of the Mac.

## 2. The answers in short

- **D1, the threat.** The Mac has no live view (C), so the main reason of the Linux hiding (frames of the display to a
  test login, T16) does not exist there. Agents' clients do not reach the act tab on either system (C11's hiding, the
  model's code). A program of the same user with the Screen Recording right or the Accessibility right reaches any
  window; the hiding does not stop it, macOS's privacy control (TCC) does (A). What the hiding does on the Mac: it keeps
  the sign-in page out of the screen image (a person at the Mac, a screen share or a recording that the operator runs),
  and it keeps the operator's focus and keys out of the act window.
- **D2, the act window.** Recommended: the receiver opens the act window **minimized** (`windows.create` with
  `state: "minimized"`, `focused: false`, `incognito: true`), which the receiver passes today (C); the act types no key
  until `windows.get` reports `minimized`. The act's input is CDP input to the renderer, so it needs no focus (C); that it
  needs no window on the screen is assumed for a minimized window (A; M behind a window, 2026-11-03). The fallback, when the Mac run shows that a minimized page is
  hidden to the site or loses the input: a normal window with `focused: false` and no hiding, with the limit stated. The
  Mac run must confirm: the page stays visible to the site while minimized, the input arrives, the create takes no
  front, and macOS does not show the window.
- **D3, the incognito allow.** The operator's one switch "Allow in Incognito" at the Load unpacked. It is already the
  last step of the Mac's load sentence and of the access check (C); the service's write cannot give it on the Mac (M).
  Not the fallback of the design's 7.3.
- **D4 a, the taskport right.** The protected start reads the right and fails closed unless a debugger needs the
  user's password (each time, or once with a bounded timeout); the shared credential after one password is a stated
  limit that the service cannot see. **D4 b, the latch.** A cached reading, refreshed in the background every 10 s by
  asynchronous runs; no op and no status read blocks; a failed or late read of either tool, or a reading older than
  25 s, fails closed with no latch; a read of a weak state (DevToolsSecurity enabled, a weak taskport form) locks the
  store at once and latches until the service starts again.
- **D5, the hello and the ops on the Mac.** This side: the Mac's protected start returns its reader, so the store part
  and the act exist on the Mac and the hello lists `sign_ins`; the act gets a Mac screen (the minimized window). aw-lead's
  side: the Mac's browser front builds the stored sign-ins' part, the pane, and the offer socket; the Mac's units keep
  no core and no `NODE_OPTIONS`. No receiver change; one C10 sentence in chrome-extension's protocol. Each contract
  sentence of section 7 needs aw-lead's OK.
- **D6, part 2.** Six build steps, each with a test that fails on today's code (section 8), and a Mac live check through
  the manager with a test credential on a local page: a new Mac harness, because `test/live/sign-in-act` cannot run on
  the Mac (C).

## 3. D1: what can see the act window on the Mac

| Viewer | How it sees a window | On Linux | On the Mac |
| --- | --- | --- | --- |
| agentwatch's live view | Linux: frames of the Xvfb framebuffer to a viewer, a test login among them | the blank of C12 and the X move (T16) | **none exists** (C): agentwatch's first browser design, 5.6: "On the Mac there is no live view: the operator uses the window"; its internals: "No live view exists yet", and `BrowserFront.view_blank()` has no consumer. A later Mac live view reads C12's blank. |
| an agent's client (CDP, MCP, CLI) | its own sessions; `Page.captureScreenshot` is per tab | C11's hiding: no target, no event, no window lookup of the act tab | the same (C: the model's code has no platform branch) |
| another program of the same user | Linux: the display's X authority | the same-uid limit (T16) | the **Screen Recording** right (capture of the screen or of one window) and the **Accessibility** right (read a window's controls, move it, send it input), both TCC rights (A). A program with Screen Recording can capture a window that is behind others or off the screen (A: ScreenCaptureKit captures a window by its own buffer; a minimized window is not measured). So the hiding does not stop such a program; TCC does. The probe reads whether a program of an agent's shell holds either right (`rights`). |
| a person at the Mac, a screen share, a recording | the screen | none (Xvfb has no screen) | the window on the screen shows the site's page: the username in plain text, the password as dots, for the act's seconds. The type watch ends the act when the field shows text (C). |
| the operator's own keys | the front window | none | a window that comes to the front with the focus gets the operator's keys: a key typed into another app could go into the sign-in page and fail the sign-in (the lockout guard counts it). Chrome activates itself when it shows a window with the focus (M, 2026-11-04). |

So on the Mac the hiding is not a guard against agents. Its jobs are two: keep the sign-in page out of the screen image,
and keep the operator's focus. The act's security rules are the same on both systems: C11's hiding of the act tab from
clients, the block, the guard, the type watch and the clean end. The same-uid limit stays, with TCC rights in place of
the X authority (section 7, C11 limits).

## 4. D2: the act window on the Mac

### 4.1 The act's input path on the Mac

The act types with `Input.dispatchKeyEvent`, `Input.dispatchMouseEvent` and `Input.insertText` on its own session of the
act tab, through the receiver's `chrome.debugger.sendCommand` (C: `act.ts`, `fill`, `click`, `pressEnter`). Chrome gives
these events to the renderer of the tab; they do not pass through macOS's event queue, so they need no focus and no
front window, and they never reach another app (C). That they need no window on the screen is not in the code: a page
that Chrome does not draw can hold its input back (A; the Linux twin saw an input call wait more than 2 s on a hidden
page). Measured on the Mac for a window behind the operator's window (M, 2026-11-03, check 9): "CDP click and typing
worked", with and without the occlusion flag. Not measured: a minimized window (the probe's `apiMinimized` and
`minimized`, with `hangs` and `keysHidden`).

### 4.2 The flags of the Mac start

The Mac's agent Chrome starts with `AGENT_ARGS` (C: `src/agent.ts`, `mac-chrome.ts`), among them
`--disable-backgrounding-occluded-windows`, and with no timer flag (dropped in ab-v16.13). With the flag, a window behind
the operator's window kept its page visible: `visible`, 121 animation frames and 200 ticks of a 10 ms timer in 2 s;
without it the page was `hidden`, 0 frames and 24 ticks (M, 2026-11-03, check 9). Chromium maps an occluded window to
visible under the flag, but not a hidden one (A: Chromium's `WebContentsImpl::UpdateWebContentsVisibility`, as known).
Whether macOS's minimized state reaches Chrome 158 as occluded or as hidden is the probe's main question (run A,
`apiMinimized`).

### 4.3 The options

| Option | Can the receiver do it? | On the screen? | Page visible to the site, input |
| --- | --- | --- | --- |
| a. bounds at the edge | yes: `left`, `top`, `width`, `height` pass the receiver's check of the createData (C: chrome-extension `bridge.js`, `newWindow`) | at least half of it: `windows.create` refuses a window with less than half inside the screens (M: round 1 for `windows.update`; the twin for `windows.create`: half passes, three quarters gets the 50% rule) | visible with the flag (the probe: `edge`). The twin measured that Chromium 156 did not apply the createData's place at all (with `--window-position` and `--window-size`): the probe's `apiRule` records where Chrome stable puts it. |
| b. `state: "minimized"` | yes: `state` passes the receiver's check, and the receiver gives the createData to `chrome.windows.create` unchanged (C: `bridge.js`, `act.js`). Only at the create: `windows.update` refuses an incognito window (C: `bridge.js`), and `minimized` does not combine with a place (M: the twin, "a state that does not combine") | no: a tile in the Dock (A) | **the Mac run** (`apiMinimized` and its CDP stand-in `minimized`) |
| c. behind the operator's windows | no call: `focused: false` orders a new window above every window of its level (A: Chromium's `NativeWidgetNSWindowBridge`, show inactive, as known) | yes, unless another window covers it | visible with the flag and the input works (M, 2026-11-03); the probe's `apiOverCover` (run B) shows where Chrome puts a window that is not focused |
| d. the agent Chrome app hidden | no: only the service could (NSRunningApplication's `hide`) | no | not measured. It hides every agent window, and on the Mac the operator uses the agent window (no live view); whether macOS asks for a right is not known (A). Not taken. |
| e. a move by another macOS API | no | — | a move of another app's window needs the Accessibility right (A: AXUIElement), so a new permission and its dialog: out. No other public call moves another app's window (A). |
| f. no hiding beyond D1's rules | yes: `focused: false` | yes, for the act's seconds | visible, the input works (M: the twin's and 2026-11-03's; the probe: `front`) |

### 4.4 The recommendation, and what the Mac run must confirm

**Option b**: the receiver opens the act window minimized from its start, with `focused: false` and `incognito: true`,
and no place. The act types no key until `windows.get` reports the window `minimized`; else it ends with `window` (C11's
text, unchanged). The probe's summary computes the rule (`summary.pick`, parts.ts `summaryOf` and `minimizedFacts`):
`minimized` only when each of these facts of the act window's own form (`apiMinimized`: `windows.create` with
`state: "minimized"`, `focused: false` and `incognito: true`) is **measured** and holds:

1. run A and run B started, and `apiMinimized` was made in both;
2. the window is incognito by its own flag (`windows.get`), as the act window always is (C: `act.ts`); a window that is
   not incognito measures another kind of window, so it counts as not measured;
3. its state is `minimized` by `windows.get` in run A: the state that part 2's act checks before its first key;
4. it keeps the page visible to the site in run A: `visibilityState` visible, animation frames and the 10 ms timer at a
   page's rate (`RAF_MIN`, `TICKS_MIN`), and an IntersectionObserver callback;
5. it gets the act's input in run A: the field holds the whole test text, each key is a trusted event, no input call
   waits more than 2 s, and no key came while the page was hidden (`keysHidden` 0);
6. its create took no front from another app, measured in run A and in run B (a refused give-back, or Chrome in front
   before the create, is not measured);
7. macOS does not show it (run B, the sensor: its page is hidden there).

A fact that is not measured never counts as a pass: with no fact that fails and one or more not measured, the pick is
`not measured`, and the summary names the facts (`notMeasured`). The CDP stand-in (`minimized`) is a second view only:
it has no front measure and no incognito flag, so it gives no pick.

**The fallback, option f**: a normal window with `focused: false` and no hiding, when the rule fails and a baseline
holds (`pick` "on the screen"): a fact of the rule is measured and fails, and `front` (made by CDP) or `apiOverCover`
(made by `windows.create` with `focused: false`, the fallback's own call) keeps the page visible to the site, gets the
input and gets no key on a hidden page (`none` when both are measured and fail; `not measured` when neither is
measured). Then C11 states that on the Mac the act
window is on the screen for the act's seconds, and the Browser pane says so. Option a is not the fallback: half of the window stays on the screen, and Chrome's own
flags can place it elsewhere. Options c, d and e have no call that the service may use.

A minimized page that is hidden to the site while the act types is not accepted: a site then sees input on a hidden page,
the signal that the occlusion flag exists to avoid (`src/agent.ts`).

**Act popups.** An act popup that opens in a window of its own cannot be minimized by today's receiver:
`windows.update` refuses an incognito window, and the service has no X on the Mac. The Mac's rule for a popup's window is the act window's rule
(minimized within 2 s), so such a popup ends the act with `window`, as Linux ends a popup window that does not move off
the screen. A popup that opens as a tab of the act window stays in the minimized window. A later chrome-extension change
can minimize an act popup's window (`windows.update` with `state: "minimized"` for an act popup's window only); part 2
does not need it.

**Limits.** The Dock holds a tile of the minimized window for the act's seconds, which can show a small image of the
page (A, not measured). The window can flash on the screen at its create (A; the probe cannot see it: the seat brief
asks the operator).

## 5. D3: the incognito allow on the Mac

- The facts. On the Mac, Chrome keeps the receiver's settings entry in `Default/Secure Preferences` and drops the
  service's write of `extensions.settings.<receiver ID>.incognito` into `Default/Preferences` (M: board ab-v16.94.34;
  the blanket design's M2 on Chrome 158.0.8127.37). The access check reads the entry and names the operator's step
  (C: `src/service/unit/access.ts`), and the Mac's load sentence ends with "click Details of the agent extension and
  turn on 'Allow in Incognito'" (C: `src/service/unit/part.ts`, `loadNote`). The probe adds a second view on fresh
  profiles: run A's profile holds the Linux service's pre-start write of `Preferences`, and `extension.allowedAtLoad`
  says whether that write gave the newly loaded unpacked extension the allow (D3's question: does it hold?); run B's
  profile holds no write. With no allow at the load, the probe gives it as the operator's switch does
  (chrome://extensions' `developerPrivate.updateExtensionConfiguration` with `incognitoAccess: true`: its schema is in
  Chromium 156's own binary (C); its effect in Chrome stable 158 is assumed (A)), and reads it again
  (`allowedAfterSwitch`), so that its api options measure an incognito window, the act window's own form.
  `profile.entryIn` says in which file Chrome keeps the entry after the run. The Linux twin (Chromium 156) kept the
  write in run A (`Preferences`, allowed), and in run B the switch gave the allow; the Mac is expected to drop the
  write.
- The recommendation: **the operator's one switch at the Load unpacked**, as today. On the Mac the service writes
  nothing for it. Without the allow the receiver answers "no incognito", and the act ends with `no_window` (C:
  `act.js`, `act.ts`); the status's operator text names the switch (C: `access.ts`). The fallback of the design's 7.3
  (a window of the default context) is not taken: it shares the origin's storage, Cache Storage and `BroadcastChannel`
  with the agent's tabs (T3), for no gain over one click.
- A Chrome update can turn the receiver off or reset its settings (boards ab-v16.116 and ab-v16.118); the operator then
  does the Load unpacked and the switch again, and the status says so (C).

## 6. D4: the taskport right and the latch

### 6.1 (a) The taskport right

`security authorizationdb read system.privilege.taskport` prints the rule that authd applies when taskgated asks
whether a debugger may take the task port of another process of the same user. The probe keeps its class, rule names,
group, `authenticate-user`, `shared`, `timeout`, `allow-root`, `session-owner` and `tries`, and parts.ts
(`taskportMeaning`) names what they mean for a debugger of the same user. The form that this note expects (A: Apple's
`authorization.plist` as known, not measured): class `user`, group `_developer`, `authenticate-user` true, `shared`
true, `timeout` 36000 (10 hours): "a password once, shared for its timeout". authd puts a shared credential into the
session's cache, so after one password another process of the session gets the right with no new prompt until the
timeout passes (A: authd's semantics as `man security` and the plist's comments give them).

What the store's start does with it (part 2), at the protected start and at each later read (6.2):

| Meaning | The protection |
| --- | --- |
| "a password at each request", "deny" | holds |
| "a password once, shared for its timeout", with a timeout of at most `TASKPORT_TIMEOUT_MAX` | holds, with the stated limit below. `TASKPORT_TIMEOUT_MAX` is 36000 s until the Mac run gives the real default; part 2 sets it to that value |
| "a password once, shared for its timeout" above the bound, "a password once, shared with no timeout", "a group member with no password", "allow: no password", "a rule", "another form", "no right" | does not hold, and it latches (6.2): `dumpable` until the service starts again; the log line names "the taskport right" and the meaning |
| "unknown": a read that failed or came late | does not hold for that reading: `dumpable` until a read that holds, with no latch (6.2: the same rule as a failed read of DevToolsSecurity) |

Assumptions for the Mac run to settle (A):

- `TASKPORT_TIMEOUT_MAX` is the measured default, so the bound never refuses the default form: it refuses only a longer
  timeout, that is a change of the right. The bound is no protection against the default's own limit below.
- authd's shared cache may also fill from the password of another shared right of the same user (another prompt of
  macOS that asks for the user's password), not only from a Developer Tools Access prompt; the probe reads the rule, not
  the cache, so this stays open after the Mac run too.

The limit, stated plainly: after the operator types the password at a Developer Tools Access prompt (Xcode, Instruments,
lldb), for the right's timeout a debugger of the same user can take the service's task port with no new prompt and read
the open key. The service cannot see authd's cache, and `DevToolsSecurity -status` still says disabled then (the design,
5.5). The Mac's Browser pane says: "Lock the stored sign-ins before you type your password for Developer Tools Access
(and, until the Mac live check settles it, at another password prompt of macOS), and keep them locked for <timeout> after
it." (aw-lead's text; the timeout from the status, section 7.) The text names Developer Tools Access first because it is
the prompt that a debugger shows; the other prompts are the open assumption above.

### 6.2 (b) The latch

Today (C: `protect.ts`, `store.ts`): `dumpable()` runs `DevToolsSecurity -status` synchronously (`spawnSync`, at most
1.5 s) at each `status()` and each `sign_ins_setup` and `sign_ins_unlock`; one read of enabled latches until the service
starts again; an open store stays open after the latch, because the store checks its protections only at the set-up,
at the unlock and in `status`.

The decision: **a cached reading with a time limit, refreshed in the background.**

- A background reader on the Mac: every 10 s, one asynchronous run (`execFile`, 1.5 s limit, killed after it) of
  `DevToolsSecurity -status` and one of `security authorizationdb read system.privilege.taskport`. No op and no status
  path spawns a tool synchronously.
- `status()` and the act read the cached reading, with no block. `sign_ins_setup` and `sign_ins_unlock` wait for one fresh
  read first (they are asynchronous already: scrypt).
- The reading holds only while its last read of DevToolsSecurity is `disabled`, the right holds (6.1), and the read is
  at most 25 s old.
- One rule for both tools: a read that fails or comes late (of either tool), and a reading older than 25 s, give
  `dumpable` for as long as they last, with no latch: the next read that holds clears it. Such a read says nothing
  about the Mac's state, only about the reader, and a latch on it would refuse every unlock until a restart after one
  slow second of a busy Mac. A read that shows a weak state, DevToolsSecurity `enabled` or a taskport form that does not hold (6.1),
  latches `dumpable` until the service starts again: a task port that a debugger took then stays good.
- A latch, and a reading that does not hold, lock an open store at once: the open key's buffer is zeros, the state goes
  to `locked`, and the `sign_ins` event goes. A running act ends at its next key check with `locked`.
- Why not only at the start: an enable during the service's life would stay unseen, with the store open, until the
  next start.
- Why not at each op and each status read: each read blocks the whole service (the doors, the MCP path, a running act)
  for up to 1.5 s, and the daemon reads the status often.
- Why 10 s: each tool run took 6 to 10 ms on the Mac (M: ab-v16.97.8), so two runs every 10 s cost nothing, and the
  window is short.
- The stated gap: an enable, an attach and a disable within one period stay unseen; the shared credential of 6.1 is not
  seen at all.

## 7. D5: the hello, the store's ops through the daemon, and the contract sentences

### 7.1 This side (agent-browser, part 2)

- `memoryStart` on the Mac returns the Mac's protection (today: `null`), so `service.ts` builds the stored sign-ins'
  part there: the eight ops, the `sign_in` and `sign_ins` events, the key `sign_ins` of `status`, and the feature
  `sign_ins` in the hello.
- The Mac's protected start (6.1) and the background reader (6.2), in `protect.ts`; the taskport parser moves from the
  probe's `parts.ts` into `src/service/signins/mac-tools.ts`, as ab-v16.97.8 part 2 moved its parsers.
- The act on the Mac: the act screen of the Mac (no X): the act window's createData gains `state: "minimized"`; the
  place check is `state === "minimized"`; an act popup's window ends the act with `window` (4.4). PageFetch and the
  card payment stay Linux only (C: `service.ts`).
- The access check's Mac sentence (C: `access.ts`, `ACCESS_NEEDS.mac`) names the sign-in act as a user of the incognito
  access now.

### 7.2 aw-lead's side (agentwatch)

- The Mac's browser front builds the stored sign-ins' part (C: today `build_browser_front` returns the Mac's front
  before it builds `SignInPart`, and the plan of 2026-11-16 says "the Mac's front has none"): the store's files, the
  snapshot at each connect, the ops' client, the gateway's routes and the Browser pane, behind the gate
  `browser.sign_ins`.
- The offer socket on the Mac (C: `sign_in_offer_socket_path` says "no Mac binds it"), with the walk of the kernel's
  peer pid on the Mac (agentwatch's Mac peer reads exist).
- The pane's Mac texts: the limit of 6.1 (the shared taskport credential) and, with the fallback of 4.4, the window on
  the screen.
- The units: the service's launchd job keeps no core (`HardResourceLimits` and `SoftResourceLimits` with `Core` 0) and
  no `NODE_OPTIONS`; the daemon on the Mac keeps no core either (C: `daemon/no_dump.py` is a no-op off Linux; the
  daemon holds only sealed text, the design's 5.2, so a core limit is enough there).
- The live view: nothing to do while none exists on the Mac; a later Mac live view reads C12's blank.

### 7.3 The receiver

No change for the act window: `state` passes the receiver's check and goes to `chrome.windows.create` unchanged (C:
chrome-extension `4a4eb50`, `bridge.js` `newWindow`, `act.js` `create`). One documentation sentence in chrome-extension's
`docs/protocol.md` (C10, the act window) names it. A later, optional chrome-extension change can minimize an act popup's
window (4.4).

### 7.4 The proposed sentences

Each sentence below **needs aw-lead's OK** before it merges (the manager's rule of 2026-11-14 for a C11, C12, C4, C5 or
C10 change). Part 1 changes none of them.

**C11, "The sign-in act".**

1. Today: "On the Mac the store and the act stay off until stage 4 (board ab-v16.97.14)." and "On the Mac the service
   makes its protected start (C12, the stored sign-ins: the protections) and only logs the result." Proposed: "On the
   Mac (stage 4, board ab-v16.97.14) the store and the act run as on Linux, with the Mac's protected start (C12, the
   stored sign-ins: the protections) and the Mac's act window (below)."
2. The bullet "Before the sign-in page loads, the service moves the act window at the X level ..." gains: "On the Mac
   the receiver opens the act window minimized (C10's `windows.create` with `state: "minimized"`, `focused: false` and
   `incognito: true`, and no place), and the service moves no window: the act types no key until `windows.get` reports
   the window `minimized`, else it ends with `window`. An act popup in a window of its own ends the act with `window`
   on the Mac: today's receiver cannot minimize it (`windows.update` refuses an incognito window)."
3. "While the service has no act (the Mac until stage 4, and a service with no store, native link, lists or Chrome
   unit)" becomes "While the service has no act (a service with no store, native link, lists or Chrome unit)".
4. The limits gain, after "A program of the user with the display's X authority can read the display and the act
   window's title, move the window back onto the screen, and send it input.": "On the Mac a program of the user with
   the Screen Recording right can capture the act window, and one with the Accessibility right can read its controls
   and send it input; the act window is minimized, so it is not on the screen, but the Dock holds a tile of it for the
   act's seconds, which can show a small image of the page, and the window can show on the screen for a moment at its
   create."

If the Mac run picks the fallback (4.4), sentence 2 becomes: "On the Mac the receiver opens the act window with
`focused: false` and no place, and the service moves no window: the act window is on the screen for the act's seconds.
An act popup in a window of its own is on the screen too." and sentence 4's last clause becomes "the act window is on
the screen for the act's seconds".

**C12, "The stored sign-ins".**

5. Today: "From stage 1e part 1 the service's hello on Linux has the feature `sign_ins`, also the hello of
   `agent-browser service --hello`. On the Mac its hello has no `sign_ins` until stage 4 (board ab-v16.97.14; C11, the
   sign-in act)." Proposed: "From stage 1e part 1 the service's hello on Linux has the feature `sign_ins`, also the hello
   of `agent-browser service --hello`, and from stage 4 (board ab-v16.97.14) the Mac's hello has it too."
6. The protections, today from "The check is DevToolsSecurity's state only: ..." to "... before the store turns on."
   Proposed: "It also reads the right `system.privilege.taskport` (`security authorizationdb read`): the protection holds
   only when a debugger of the same user needs the user's password, at each request or once with a shared timeout of
   at most `TASKPORT_TIMEOUT_MAX` seconds. A background reader on the Mac reads DevToolsSecurity and the right again
   every 10 s with no block of an op or of `status`; `sign_ins_setup` and `sign_ins_unlock` wait for one fresh read. The
   protection does not hold while the last read of either tool failed, came late or is older than 25 s; the next read
   that holds clears it. A read of enabled, or a form of the right that does not hold, makes `dumpable` hold until the
   service starts again. A reading that does not hold locks an open store at once (the `sign_ins` event goes). Not seen, stated plainly: an enable, an attach and a disable within one period of 10 s, and the shared
   credential after the operator typed the password for a debugger: for the right's timeout a debugger of the same user
   can then attach with no new prompt."
7. The status: "`sign_ins` in `status` is `{"state","records","acts","pane_key","stopped","unprotected"}`" gains, on the
   Mac only, the key `taskport_shared_s`: the right's shared timeout in seconds, or `null` when the right is not shared.
   (The pane's text of 6.1 reads it.)
8. The receiver's access check: the Mac's `<needs>` "PageFetch and the sign-in act need incognito access when they come
   to the Mac; a file input needs access to local files" becomes "the sign-in act needs incognito access; PageFetch
   needs it when it comes to the Mac; a file input needs access to local files".

**C10 (chrome-extension `docs/protocol.md`, the act window).**

9. The act window's createData gains: "On the Mac the service adds `state: "minimized"` (and no place); the receiver
   passes it to `chrome.windows.create` as it is."

No new op, event or result code: the vectors (`test/vectors/control.json`, `act.json`) keep their cases, and C12's
`status` vector gains the Mac key of sentence 7.

## 8. D6: part 2's build, in order, and its tests

Each step is a commit of one branch after ab-4wh.16 merges. Each test fails on today's code.

| # | Step | Test (fails on today's code because ...) |
| --- | --- | --- |
| 1 | The contract sentences of 7.4 (after aw-lead's OK), the status vector's Mac key | `test/contracts-c11.test.ts` and `contracts-c12.test.ts` pin the new sentences (today's text lacks them) |
| 2 | `mac-tools.ts`: the taskport parser and its meaning (from the probe's `parts.ts`); `protect.ts`: the right in the protected start, the background reader, the cached reading with its age bound, the latch that locks the store | with a fake runner that answers after 1.4 s, `status()` answers in under 50 ms (today `dumpable()` blocks 1.4 s); a read of enabled locks an open store and refuses the next unlock (today the store stays open); a stuck reader gives `dumpable` after 25 s; each taskport form holds or fails by 6.1 (today no right is read) |
| 3 | `main.ts`: `memoryStart("darwin")` returns the protection; `service.ts` builds the store part on the Mac | `memoryStart("darwin", ...)` gives a protection (today `null`); the Mac's hello (a darwin service with a stand-in Chrome unit) lists `sign_ins` (today it does not) |
| 4 | `screen.ts`: the Mac's act screen; `act.ts`: the createData of the screen, the place check by the screen, the popup's window rule | with a fake receiver on the Mac's screen: `windows.create` gets `state: "minimized"` and no place, and the act signs in when `windows.get` answers `minimized` (today: `window` at once, no X display); a `windows.get` of `normal` ends the act with `window` before any key; an act popup in a window of its own ends it with `window` |
| 5 | `access.ts`: the Mac's sentence (sentence 8) | the operator text on the Mac names the sign-in act's need now (today: "when they come to the Mac") |
| 6 | `test/live/sign-in-act-mac/`: the Mac live check (below) | it runs once on the Mac; a Linux dry run of its pure parts runs in `npm test` |

**The Mac live check (through the manager, with a test credential on a local page).** `test/live/sign-in-act` cannot
run on the Mac (C): it runs `agent-browser service --test`, which needs Xvfb and a test display, installs Chrome from a
Debian repository fixture, uses xdotool and ffmpeg's x11grab, and its harness guard is Linux only. So part 2 builds a
small Mac harness for one on-screen run by a seat session that the manager starts, after aw-lead's side (7.2) and the
switch of the gate `browser.sign_ins` on the Mac:

1. The harness serves a local login site on `login.localhost` (loopback only, a port of its own): a form that posts to
   its own origin, and a page script that records what the site sees during the act (`visibilityState`, `hasFocus`,
   animation frames, the timer, each key's `isTrusted`) and sends the record with the form to its own origin (allowed
   by `send_to`).
2. The operator adds the scope's list entry `login.localhost` and one credential in the Browser pane: name
   `mac-live-test`, the harness's origin and path, and the made-up test username and password that the harness prints
   (no real credential).
3. The seat runs `agentwatch browser sign-in mac-live-test` once. The harness checks: the answer is signed in; the
   site's record shows the page visible with frames and every key trusted; the post holds the test values; the seat's
   own tab of the site loads signed in; no output, log line or event of the act holds a test value; the operator says
   whether a window showed on the screen and whether the front app changed.
4. The operator removes the credential and the list entry.

## 9. The Mac probe (part 1)

### 9.1 The files

- `test/live/mac-signin-window-probe/probe.ts`: the run (one JSON object on stdout).
- `test/live/mac-signin-window-probe/parts.ts`: the pure parts (the options, the flags, the extension, the page, the
  key events, the JXA scripts, the parsers, the verdicts and the summary, the result's check).
- `test/live/mac-signin-window-probe/helper.ts`: the rights read (`CGPreflightScreenCaptureAccess`,
  `AXIsProcessTrusted`), in a child process.
- `test/mac-signin-window-probe.test.ts`: the pure parts and the Linux dry run, in `npm test`.
- `test/live/README.md`, "The Mac sign-in window probe": what it does and how to read its JSON.

### 9.2 What it does on the Mac

It reads the taskport right and the two rights; it starts its own Google Chrome (the app's binary, a second instance on
a new temp profile, never the operator's Chrome or the agent profile) twice: run A with the agent's flags, run B (the
sensor) without the occlusion flag, each with no crash reporter (`--disable-breakpad`). In each run it loads a test
extension by CDP (`Extensions.loadUnpacked`, after it turns developer mode on in its own temp profile); run A's profile
holds the pre-start write of the incognito allow and run B's none, and with no allow at the load the probe gives it as
the operator's switch does (section 5). Run A measures six options of parts.ts and run B the four whose sensor facts
the summary reads (`RUN_OPTIONS`; the option wholly outside the screen is gone: no receiver call can make it), on its
own page on 127.0.0.1: the window's state, place and incognito flag, what the page sees, and the act's input path with
the plain test text "probe text 42". It gives the front back to the app that was in front after its Chrome takes it,
after its start and after each window's create (the service's give-back calls, M with no prompt), at most 12 times in a
run. It calls no API that prompts, uses no keychain (Chrome's mock keychain), and opens no public site. It writes no file
outside its temp folder; what Chrome itself can write outside its profile is not the probe's (A, not measured): its
macOS defaults (shared with the operator's Chrome), and a crash database under the default user-data folder if its crash
reporter runs in spite of `--disable-breakpad`. A crash handler of the probe's Chrome calls setsid, so the group kill does
not reach it. The probe looks for one by ps as a child of its Chrome (not older than that Chrome) and stops it after its
Chrome when it is still the same process. On the Mac, Crashpad starts its handler through a second fork, so its parent is
launchd (pid 1) and that find sees none (Crashpad's source, not measured). With `--disable-breakpad` no handler is
expected; if one runs on the Mac, the probe leaves it (a stated limit). Its time limit is 120 s; a run takes about 50 to
80 s.

### 9.3 The Linux dry run and the twin

`npm test` runs the probe on Linux: it makes its folder, the extension and its page server, checks the server, runs its
pipe client against a stand-in browser and stops it both ways, and answers `ok: false`, "not the Mac". It also runs the
dry run with the seam `AB_SIGNIN_PROBE_DRY_HOLD=<ms>` (a short time limit, and a stand-in that stays): the time limit,
SIGTERM and SIGHUP each end the run through its synchronous cleanup, with no stand-in and no folder left. The seam
`AB_SIGNIN_PROBE_TWIN_DISPLAY=<n>` runs the Mac's Chrome flow with `/usr/bin/chromium` on a private Xvfb under the
harness guard: on 2026-11-26 (the fix round) it ran the whole flow in 39 s: both runs, the extension loaded by CDP, run
A's pre-start write kept (`allowedAtLoad` true), run B's switch gave the allow (`allowedAtLoad` false, `switch` ok,
`allowedAfterSwitch` true), every api window incognito, the rule check (half passes, three quarters gets the 50% rule,
minimized with a place does not combine), no crash handler found by ps, and nothing left. On Xvfb with no window manager
a minimized window stays normal, so the twin's pick is the fallback by a failed fact ("the state minimized"), and its
front facts are not measured (no front app on Linux): the twin checks the flow, it measures nothing of the Mac.

### 9.4 The seat

The seat brief is the lead's file `b-v16914-mac-signin-seat-brief.txt` (an on-screen run with the operator at the Mac;
one run; a stop at any dialog).

## 10. What stays open

- Every (A) of sections 3 to 6 that the probe does not measure: ScreenCaptureKit and a minimized or off-screen window;
  the Dock tile's image; a flash of the window at its create; NSRunningApplication's `hide` and its rights; authd's
  cache of a shared credential.
- The real default of the taskport right, and so `TASKPORT_TIMEOUT_MAX`: the Mac run.
- The pick of 4.4: the Mac run. With the fallback, the Mac's limits grow (the window on the screen). A pick of
  `not measured` (for example a refused give-back) needs the manager's decision about a second run.
- What Chrome writes outside the probe's profile (9.2): not measured.
- An act popup's window on the Mac ends the act (4.4) until a chrome-extension change can minimize it.
- aw-lead's OK of each sentence of 7.4.
