# Live harnesses: two rules

Every live, probe or dry-run harness here that starts Xvfb or Chromium on Linux follows two rules
(board ab-v16.78; the Linux server ran out of memory on 2026-11-06 with an orphan Xvfb and Chromium after a
`kill -9` of a driver, beside several heavy jobs at once). chrome-extension's `test/live/` follows
the same two rules with the same guard and the same lock file.

## 1. No orphans: nothing of a harness runs after its driver ends

A harness starts its guard, `harness_guard.py` (through `guard.ts`), before its first Xvfb or
Chromium. The guard is a process of its own, outside the driver's process tree and session, so a
`kill -9` of the driver, or a signal to its process group, does not reach it.

- While the driver runs, the guard records every process of the driver's tree every 0.5 s (from one
  `/proc` snapshot: pid, start time, and a pidfd that it checks against that start time), and each
  process that the harness gives to `track()` at once (its Xvfb, its Chromium, the agent-mode run's
  tmux servers), if that process is in the driver's tree or started after the guard. It leaves any
  other pid alone and names it on stderr.
- The driver's end: the pipe from the driver to the guard closes (the kernel closes it at any end of
  the driver, also at a `kill -9`), or the driver's pid is gone. A SIGTERM to the guard
  (chrome-extension's `run.sh down`) also ends the run. After the SIGTERM, the guard takes a new
  process of the driver's tree into its records only if that process started before the SIGTERM (by
  its start time): the process that asks for the stop can run in that tree, and its own processes,
  which start after the SIGTERM, are not the run's (board ab-v16.89).
- Then the guard sends SIGTERM to each recorded process that still runs with its recorded start time,
  and to their children; SIGKILL after 5 s; it waits until all are gone (at most 20 s), and names them
  on stderr. It signals through the record's pidfd, so a process that took a recorded pid later gets
  no signal. Only when `pidfd_open` fails with an error other than ESRCH (for example no fd left)
  does it check the start time right before the signal, which leaves a short gap.
- The guard closes every fd that it inherited, from 3 up, but its pipe from the driver: it holds no
  outer lock (heavy.lock's fd under `flock`) and no pipe of its caller. A caller that closed fd 0, 1
  or 2 gets `/dev/null` there in the guard first, so the lock's fd is 3 or higher and stays open
  (board ab-v16.78, review-71c R3).

So after a `kill -9` of a driver, ps shows no recorded Xvfb, Chromium, stand-in daemon, relay or proxy
of that harness within about 5 s (at most 20 s). `test/harness-guard.test.ts` checks it with
stand-ins, and the live runs of board ab-v16.78 checked it with the real harnesses.

The limit: a process that leaves the driver's tree within 0.5 s of its start (a double fork: the
server of a daemon, or a crash handler such as Chromium's crashpad when crash reports are on) and
that the harness does not give to `track()` is not recorded, and can outlive the harness. So can a
process of the driver's tree that started less than about 0.03 s before a SIGTERM to the guard, if no
poll recorded it and the harness does not give it to `track()` (board ab-v16.89).

## 2. One at a time: the harness lock

The guard takes an exclusive lock, `flock` on `~/.cache/agent-harness/harness.lock` (the home of the
user from the password database; one file for each user, the same file in both repositories), before
the harness starts Xvfb or Chromium.

- It waits at most `HARNESS_LOCK_WAIT` seconds (default 1200), and writes one line on stderr while it
  waits, with the holder's line from the file (guard pid, driver pid, harness name, since when). When
  the time runs out, the harness writes the reason and exits 2: it started nothing.
- The guard holds the lock until the harness's processes are gone (rule 1): the next harness starts
  only after them.
- A harness that a harness starts runs under its parent's lock: `HARNESS_GUARD_HELD` names the holder, and the guard checks that the holder's driver
  is an ancestor.
- The agents' outer lock is a file (`heavy.lock`), taken by hand with `flock` around a whole heavy
  job. It is always the outer one. No harness takes it, so a process that holds
  the harness lock never waits for heavy.lock, and the two locks cannot deadlock. A harness under
  heavy.lock waits only for a harness that runs without it.
- `HARNESS_LOCK` names another lock file, for the tests only. A guard with it says so on stderr: that
  harness waits only for harnesses with the same `HARNESS_LOCK`, so rule 2 does not hold for it.
- This repository has no fuzz or mutation runner. The agents' runners outside it keep the manager's
  cap: at most 2 fuzz runs at once, each under heavy.lock.

## Reserved displays

No harness takes the X displays 0, 90 (agentwatch's agent browser on the Linux server, the operator's), 147,
190, 191 or 192, whatever its setting is: `RESERVED_DISPLAYS` in `harness_guard.py` and `guard.ts`
(and chrome-extension's `run.sh`; the tests compare the lists). When such a display stops, its socket
and lock file go, so a free test alone would take it. The parity probe's display search (from 90 on)
skips them. Every other harness refuses a reserved display that `--display` or `DISPLAY_N` names
(exit 2, before it makes or starts anything).

## Which harnesses

The guard: `agent-mode/run.ts` (its own mode; the pointer group is part of it), `anti-detect/` (`run.ts`,
`extra.ts`), `function-keys/check.ts`, `input-harness/run.ts`,
`parity/probe.ts` on Linux, `service-unit/check.ts` (board ab-v16.94.3: the service that it starts with `--test`
starts Xvfb and Chrome, and the check gives each of their pids to `track()` and signals only those pids), and
`service-link/check.ts` (board ab-v16.94.9: the same, with the native link, the real agent package and the host shim,
whose pid it tracks too, and the merge guard's floor of the pinned receiver 0.3.8 (board ab-v16.97.10); `--display 172`,
and `--chrome-extension <checkout>` to compare the CRX with `git show`), and `service-link/receiver-move.ts` (board
ab-v16.81: the service of an older pin, `--old-root <checkout>`, installs its receiver into a new profile, then this
checkout's service on the same folders gives the newer receiver after one start op; `--display <n> --dir <folder>`), and
`service-use/check.ts` (board ab-v16.94.11: the same service, with no start op: a first use starts Chrome, the grace
time of the stop by use stops it, and a new use starts it again; `--display 171`), and `sign-in-act/check.ts` (board
ab-v16.97.4: the same service with its pinned agent package, the receiver 0.3.8 (board ab-v16.97.10), and
`--chrome-extension <checkout>` to compare the CRX with `git show`; a sign-in with test values on a local login page,
the act window outside the screen and hidden from the client, the block, the move, the CLI and the secret scan;
and the design's live steps 2, 3, 5 and 7 (board ab-v16.97.6, with the pages of `sign-in-act/cases.ts`): the agent's
reads of the design's section 4.2 and round 1's case K1 during and after an act, each refusal of section 7.9 that the
local site can make, frames of the display's root window (ffmpeg's x11grab) with no pixel of the act window, and a
restart of the service that locks the store until the test unlock; `--display 171`), and
`merge-guard/check.ts` (board ab-v16.99: the same service through `merge-guard/service.ts`, with `--test`'s stand-in host
`github-standin.localhost` and the run's copy of the receiver 0.3.7; a real Playwright client and a raw CDP client on a
stand-in of a GitHub PR page on `*.localhost` hosts only: a marked PR's merge, Ready for review, auto-merge and approve get
the guard's 403 and the stand-in gets no write, an unmarked PR's go, and the log names no URL path; `--display 171` or
`172`), and `mcp-live/check.ts` (board ab-v16.94.13: the same service with `--test-mcp-port 0`, and the MCP SDK's own
client in the check's process with a test token of the run: a real page through the MCP (navigate, snapshot, click, type,
screenshot, file and folder upload in the scope's folder), the ticket's connection on the agent door, a page off the list,
the reconnect after a close, the limit of 4 MCP sessions for each scope, the roots, the service's memory, the restart on the
same port, and what is left after the session; `--serve MINUTES --root PID` serves the same service for real clients by
hand and prints the MCP URL, the path of the token's 0600 file and the test page; `--display 171`), and
`mac-input-probe/dry-run.ts` (board ab-t30.32: the same service with `--test`, one session, the Mac input probe once
against the session's endpoint, and the probe's three stops; `--display 171`), and `card-checkout/check.ts` (board
ab-sta.8: the same service with `--card-pay`, `--test-provider-origin` and `--test-provider-api` (the test merchant's
provider, `pay.localhost`, and its API, `payapi.localhost`), its pinned agent package (the receiver 0.3.16), the test merchant of `test/fixtures/pay-merchant/` on
`*.localhost` hosts of the check's own server, and the payment providers' published test card numbers only, never a real
purchase: the store and two cards sealed through `card_seal`, a payment through a real MCP client with the operator's
approval (`kind: operator`) on the control door, each variant of the test merchant, the attacks of the design's section
11 that a local check can make (the agent's cart change, its reads of each tab and frame, its service worker and
BroadcastChannel, approvals of another kind, request or order, a replay, a cancel), what Chrome must confirm for the act,
and the secret scan; `--display 171`, `--only <step>` for single steps while it is built; and only with
`--provider-page <URL>` (board ab-sta.13), never in the default run, which stays loopback only: the opt-in step P on a
payment provider's public test page, with the service's shipped list of providers, the lists set to the page's host
(and `--provider-allow host,host`), a stop before `browser_pay` unless the page holds a provider's test key or test
session and no live key, the published test number 4242424242424242 only, and steps 1, 2, P, 7 and 8 only), and
`press-hold/check.ts` (board ab-t30.34: the same service with `--test-mcp-port 0`, and the MCP SDK's own client: the
MCP's `browser_press_hold` on the local test page of `press-hold/page.ts`, a button with a random fill of 1 to 10 s on the
page, in a cross-origin frame of a second local site (`hold-frame.test`, which the config's `--host-resolver-rules` maps to
the check's own server) and in a closed shadow root, and a Playwright client's own hold of 3.5 s; the page's log of each
event; `--display 173`).

No guard: the macOS checks (`function-keys/check.ts --on-my-screen`, `parity/probe.ts` on macOS): they run on
the person's own screen, with no Xvfb, and the guard is Linux only. The agent-mode run's external mode starts no
Xvfb or Chromium. The Mac input probe (`mac-input-probe/probe.ts`) starts no Xvfb and no Chromium: it is a client of an
agent browser that runs. The Mac peer probe (`mac-peer-probe/probe.ts`) starts no Xvfb, no Chromium and no browser: it
reads sockets and processes only. The Mac memory probe (`mac-memory-probe/probe.ts`) starts no Xvfb, no Chromium and no
browser either: it reads the memory of its own child processes with Apple's tools. The Mac sign-in window probe
(`mac-signin-window-probe/probe.ts`) starts its own Google Chrome on the Mac's screen, with no Xvfb; its Linux twin seam
(`AB_SIGNIN_PROBE_TWIN_DISPLAY`) starts Xvfb and Chromium under the guard. (Board ab-v16.9.3 removed the
harnesses of the CDP proxy and of the agent Chrome that agent-browser started itself: `takeover/`, `background-tabs/`,
`anti-detect/mac.ts` and its parts, `sheets.ts`, `blank-origin.ts`, `click-download.ts` and `shot-full-size-default.ts`.)
Before it connects, ends scopes or restarts a relay, the external mode compares CONTROL status's socket with RELAY_SOCK using realpathSync.
The run exits 2 for different paths, missing files or socket fields, invalid JSON, a failed status or a status timeout.

Environment: `HARNESS_LOCK_WAIT` (seconds), `HARNESS_LOCK` (another lock file: for the tests only).

## CLI click downloads

The agent-mode harness clicks a local `a.localhost` button that serves a CSV attachment, then a button that creates a
blob download, through its stand-in daemon, receiver and relay. Both results must name a file with the expected
contents, name, URL and size.

Use its own mode only. The downloads group refuses external mode.

```sh
CHROME_EXTENSION=/absolute/path/to/chrome-extension CASES=downloads DISPLAY_N=124 \
  node test/live/agent-mode/run.ts
```

The harness uses `harnessGuard` and checks `reservedDisplay` before it starts Chromium.

## The input stage's live rows

The group `stage` of `agent-mode/run.ts` (board ab-t30.9) runs alone, in the own mode, with the relay's input stage on
(the build switch is on since board ab-t30.24; `AGENT_BROWSER_INPUT_STAGE=test` in the relay's environment opens the
live rows' doors: a test clipboard and a test folder of files). Its part `switch` (`STAGE_PARTS=switch`, board
ab-t30.24) runs alone and sets no variable of the stage's tests, so the relay runs as the daemon starts it. Its scope `stage` has the list `a.localhost` and
`b.localhost` (a cross-site frame). It installs `playwright-core` 1.65.0 and 1.66.0-alpha-2026-11-09 (the
playwright-core of `@playwright/mcp` 0.0.85) in folders of the run, beside the install's 1.64.1, and never downloads a
browser: the second Chromium (Playwright's own input, with no stage) is the same Chromium binary, launched by each
Playwright version with a profile folder of the run.

```sh
CHROME_EXTENSION=<a chrome-extension checkout> DISPLAY_N=169 CASES=stage STAGE_REFERENCE=<reference.json> \
  flock <heavy.lock> timeout 1500 node test/live/agent-mode/run.ts
```

Each row passes when the action passes through the stage with Playwright's default timeout, and the page's state is the
same as with Playwright's own input (M8, a hover layer over the card's middle, is the design's named better case:
Playwright's own hover fails there). The group also measures open points 4 and 5 of the input design, and scores the
recorder page's records through the stage (the rows R1, R2 and R9 to R13) against `STAGE_REFERENCE`, a `reference.json`
of `input-harness/run.ts --only source`. It writes `stage-live.json`, `stage-harness-results.json` and
`stage-harness-report.txt` in the run folder.

The keys and the text (board ab-t30.10, `stage-keys-live.ts`) are a part of the same group. `STAGE_PARTS=keys` runs
this part alone (the default is `pointer,keys`), and `STAGE_KEY_ROWS=<a regular expression>` only its rows whose names
match (with no harness rows; `STAGE_HARNESS=1` adds them). Its page on `a.localhost` holds the fields of the key and text rows
(an input, a textarea, a number and an email input, a contenteditable, a form, a field whose `keydown` opens an alert, a
field whose `blur` opens an alert, and a field in a cross-origin frame on `b.localhost`) and the widgets of the input
design's open points 1 and 2 (a date picker and a combobox that open at a click, a tag input and an input mask). Each
row passes when the action passes through the stage with Playwright's default timeout and the page's state is the same
as with Playwright's own input; the widgets' rows are measures. The harness rows R3, R4 and K1 to K4 score the
recorder's keys through the stage against `STAGE_REFERENCE`, and against `STAGE_PERSON` when it names a reference of
the operator's published numbers (a report, not a bar, until board ab-t30.13 fits the parameters). It writes
`stage-keys-live.json`, `stage-keys-harness-results.json` and `stage-keys-harness-report.txt` in the run folder.
The paste rows (board ab-t30.19) check that a long `fill` and `pressSequentially` go as one person's paste (the page sees
one trusted `paste` of the whole text and one `insertFromPaste`), that a short text is typed, that a field that refuses a
paste gets the client's text, and that the CLIPBOARD selection of the run's display has no owner after each row. For
them the run gives the relay `AGENT_BROWSER_STAGE_CLIPBOARD=<DISPLAY_N>:<the run's X authority file>` (the relay's door
of the live rows, only with `AGENT_BROWSER_INPUT_STAGE=test`), so that its stage has the X selection owner of the run's
own Xvfb; the relay of the daemon has none. The flush rows (review-126 B3) type with `pressSequentially` and then close
the page, or a second `connectOverCDP`, at once: the page sends the length and a hash of each value of its textarea to
the server (and once more at `pagehide`), and the row passes when the last one is the text's. The row of the paste at a
navigation (board ab-t30.21, probe 3's case) gives tab 1 a long `fill` into a page whose keydown handler of Control+V
runs 3 s and starts a navigation of the same site (the server answers it 500 ms later), and tab 2, a page of another
site whose handler of Control+V runs 2.5 s before the page's first input event, a long `fill` 300 ms after tab 1's V
reached its page: the row passes when tab 1's page never pastes tab 2's text, tab 2's first text goes as Playwright's
own input (the stage's line `no paste: vPending`) before tab 1's page reads the selection, and tab 2's long `fill` after
tab 1's navigation is one paste of the whole text. The row of the client's Shift+Insert (review-131b N1) sends a raw CDP
Shift+Insert from the client's CDP session into tab 1's textarea, whose keydown handler of Shift+Insert runs 5 s, and
gives tab 2 a long `fill` 300 ms after the key reached tab 1's page: the row passes when tab 1's page gets a paste event
with no text of tab 2, tab 2's first text goes as Playwright's own input (`no paste: vPending`), and tab 2's next long
`fill` is one paste.

The scroll and the wheel (board ab-t30.11, `stage-scroll-live.ts`) are a part of the same group. `STAGE_PARTS=scroll`
runs this part alone (the default is `pointer,keys,scroll`), and `STAGE_SCROLL_ROWS=<a regular expression>` only its rows
whose names match (with no harness rows, unless `STAGE_SCROLL_HARNESS=1`). Its page on `a.localhost` is taller and wider than the viewport. It holds a
button and two fields below the fold, an inner scroller below the fold, a same-origin frame and a cross-origin frame on
`b.localhost` whose own documents scroll, and in the first screen an element with a wheel listener that is not passive, a
canvas with a wheel handler and a number input. Its variants add a listener of the window that prevents the wheel, or an
inner scroller, a number input or a canvas across the page that the page's content moves under the wheel point (also a
canvas inside an open shadow root), a carousel with `overflow: hidden`, a focused number input as the click's target,
a card to drag to a zone below the fold, a scroller in a shadow root around a slot, and a fixed header of the page's
scroll-padding (review 122). Each row passes when the action passes through the stage with Playwright's default
timeout, the page's state is the same as with Playwright's own input (a wheel's scroll within one notch; an element in
view where Playwright's own scroll centers it), and the stage's trace shows the row's notches or its counted fallback.
The rows of `mouse.wheel`'s column (also in quirks mode) require the same state: Playwright's own input sends one wheel
event (the list does not move, the canvas gets no wheel event, the page moves the asked total), and the stage's notches
stop before the element that would come under the point, with the rest as one event. The harness rows R5, R6 and P7
score the recorder's wheel calls and clicks below the fold through the stage against `STAGE_REFERENCE`, and against
`STAGE_PERSON` when it names a reference of the operator's published numbers (a report: since board ab-t30.32 the Mac
gets Linux's notches, not the person's trackpad trains), and two reports give the wheel calls that went with the rest
as one event (`wheelRestAsOne / wheelCalls`), in the harness and in the whole run. It writes `stage-scroll-live.json`, `stage-scroll-harness-results.json` and
`stage-scroll-harness-report.txt` in the run folder.

## Input harness

`input-harness/run.ts` (board ab-t30.2) scores agent input against a reference input, gap by gap, by the
table of section 13.3 of `docs/superpowers/specs/2026-11-10-vanilla-playwright-human-input-design.md`.
It runs on its own Xvfb (display 169 by default) with its own Chromium on a temporary profile, under the
harness guard. The page is the input research's recorder on `rec.localhost`, with its box on
`box.localhost`. No other host is reachable.

The scenarios:

- `source`: the reference, real X input (XTEST) at 125 Hz, then the design's M1 paths as CDP moves in
  four forms of the `timestamp`, the design's form on XTEST's own paths (`cdp-4ms-same`), the
  generator's CDP player (`src/human/cdp-player.ts`, board ab-t30.3) on XTEST's own paths
  (`human-same`), and a drag with XTEST.
- `agent-browser`: the input of `src/input.ts` (the generator of `src/human/` since board ab-t30.3),
  through agent-browser's commands.
- `playwright`: plain Playwright. It needs `playwright-core` in a scratch folder, never in `package.json`.
  Without it, the run skips this scenario and says so.

```sh
S=<a scratch folder>; (cd $S && npm init -y && npm install --ignore-scripts playwright-core@1.65.0)
flock <heavy.lock> timeout 1500 node test/live/input-harness/run.ts --out-dir $S/out --playwright $S
node test/live/input-harness/run.ts --rescore $S/out/run-XXXXXX/results.json [--reference FILE] [--os linux|mac]
```

The run writes `results.json` (the page's records, which hold its state: keep them out of the
repository), `reference.json`, `report.json` and `report.txt`, and prints the table.

The cleanup (`cleanup.ts`): at its exit, and on SIGINT, SIGTERM and SIGHUP, the run stops the processes
that it started by their pids, then removes its Chromium profiles, agent-browser's state folder, its
socket folder, its run folder when it holds no `results.json` (a refusal or an interruption), and the out
folder when the run made it and it is empty. A bridge that does not start stops its own Chromium and
removes its profile.

The reference: without a file, the run builds it from its own XTEST steps, and takes the values that
XTEST cannot give from the literature (`LITERATURE` in `reference.ts`; since board ab-t30.13, part B's pause, press
and key hold, which the generator draws). Part B's numbers (board ab-t30.7,
the operator's recording) replace it through one file from outside the checkout: `--reference FILE`. The file holds numbers only, in the fields of
format 1 (the head of `reference.ts`; the fixture is `reference.fixture.json`). `checkReference` refuses
any other field, by its own name (so also `constructor`, `toString` and `__proto__`), and any value that
is not a number, so no user agent, screen or text can be in it. The only names that are not fields are
the letter pairs of the optional `keys.downToDownByPairMs` (two characters each) and the keys of the optional
`keys.holdByKeyMs` (one character each), with numbers as values.

The bars of each platform (board ab-t30.13): the values of the hand (P3, P4, P5, K1 to K4) score
against the reference on both platforms, and the values of the device differ. A live run is Linux's: its
device rows (P1, P8) score against the run's own XTEST steps, also with a person's reference, and P2, R9,
M1 and R1/R2 have a bar of 0. `--os mac` (with `--rescore` only) scores a Mac run's records against the
person's: P1 with no margin, P2's share as information, a fractional point on every pointer event and on
no mouse event (R9), the person's share of moves whose movement does not match the point (M1,
`pointer.movementMismatchShare`), a jump over 100 px only inside a fast move (R1/R2), every sample in the
box (P4; on Linux only the samples that move 1 px or more), the pause from the last pointermove (P5; on
Linux the pause from the last move of 1 px or more, `pointer.pause1PxMs`), and a trackpad's wheel trains
(P7, `wheel.deltaPx`, `wheel.ratio`, `wheel.eventsPerScroll`). A row whose optional field the file does
not hold has no data.

How the rows read:

- A row is `pass`, `fail`, `not scored` (measured; its bar waits for a decision, or it is information)
  or `no data`. No row passes on records that are not there: a step that failed is left out (the row
  "failed steps left out" counts it), a row with no event records has no data, and a scenario that lost
  a beacon batch (the recorder numbers its batches) has no data in every row.
- P1, P2 and P8 need 30 pointermoves (P2: 30 sample gaps); below that, they have no data.
- A KS row (P3, P5, K1, K2) needs at least 2 values; one value has no data. (The exact one-sample bound at
  n = 1 is 0.975, below 1, so without this count one value could pass.)
- P1's predicted points: the bar of design 9.1 is XTEST's per-path range on the same paths, with no
  margin: the row "predicted points on XTEST's same paths" (the `cdp-4ms-same` source now, the pointer
  build's own replay: `human-same`). The row is the bar only for a source at XTEST's period (the mean of
  its sample gaps from 5 to 12 ms, within 0.1 ms; board ab-t30.13: the predicted points follow the
  period, so `human-same-120` is the bar's source, and a source at 8 ms is information). The range row over all paths is information with an XTEST
  reference, and the bar (with no margin) with a person's reference. P1's samples: XTEST's per-path
  range widened by 0.15 (the lead's choice; design section 16, point 6). Two information rows give the
  numbers of that point's options b (the range with no margin) and c (a two-sample KS of the counts on
  XTEST's same paths).
- P1's distributions (board ab-t30.3): each pointermove's samples (`nc`) and each sample gap, by a
  two-sample KS against the reference's values (`samplesEach`, `sampleGapsMs`: every pointermove and
  gap of XTEST's paths); the predicted points (`np`) likewise, as information with an XTEST reference
  and the bar with a person's. They need 30 pointermoves, as the other P1 rows. R10 counts them.
- P4's straightness inside the box (board ab-t30.3): the box frame's samples from the entry to the
  press. With an XTEST reference it is information: XTEST's box paths are planned by the old
  generator, whose almost straight end is the research's gap P4 itself. With a person's reference it is
  the bar (the reference's range).
- R11's jump at an activation (board ab-t30.15): the change from the page's last pointer position before the
  activation to the first pointer event after it, less that event's movement (or the movement of the move at its time
  and point: Chrome sends a pointerover first, with movement 0). A path's first step from the X pointer is no jump. A
  change over 100 px on either axis (R1/R2's bound), or over 64 px in all (a path's largest first step: C11's 8 px/ms
  for 8 ms; boards ab-t30.26 and ab-t30.13), is a jump, also when the movement explains it.
- P6: the idle moves have a bar of 0 (the answer Q4 a; part B's task 6: no move in 10 s; board ab-t30.13). Its load
  to the first move (board ab-t30.3): the time from the top page's load to its first trusted pointer move, on the
  step that holds that move; measured, not scored.
- K1 per key (board ab-t30.4): a KS test of each key's holds (5 values or more, the key's character in
  lower case) against the key's own reference (`keys.holdByKeyMs`, part B), else against the reference of
  all holds. The agent-browser scenario types a second, longer text into the text area for it.
- K4's Shift (board ab-t30.4): the Shift keydowns with a location of 1 or 2 (CDP's default is 0), and the
  shifted characters whose Shift goes up after their own keyup (bars: every one); the share of Shift
  presses on the other hand's side of their first character (design 10.2: about 70%) is information.
- K2: the design's measure is per letter pair. The per-pair row runs a KS test for each pair with 5
  values or more in both the source and the reference. Until part B gives values for each pair, it has
  no data, and the pooled row counts: the literature's value (a mean of 239 ms and an SD of 112 ms)
  pools all pairs. With part B's values, both rows count.
- R8 counts the pointer moves and the `drag` and `dragover` events with the button down between the
  press and the drop (Chromium sends no pointer event after `dragstart`; a real drag's drag events have
  `buttons` 1, a protocol drag's have 0). A drag step counts in R8 only: its pointer stream is cut by the
  drag, so the first move after the drop jumps.
- R11 is the jump from the page's last pointer position to the first pointer event after an activation
  of its window (bar 0). M1's check, the position changes that the movement does not explain, is its
  own row ("M1").

`test/input-harness.test.ts` (in `npm test`) tests the statistics, the measures, the reference file,
each bar and the cleanup (with stand-in children and real signals) with no browser.

## The Mac input probe

`mac-input-probe/probe.ts` (board ab-t30.32, part 1; step B of the input fit) is one run against the Mac's agent browser
through agent mode's endpoint (the URL that `agentwatch browser endpoint` prints). A Mac session that the manager starts
runs it once. It answers three questions about the input stage's device values on the Mac:

- Q1: do fractional CDP points reach the page's pointer events (clientX/clientY, offsetX, the coalesced events), for a
  move that ends at 300.37, 200.61? Board ab-t30.32 part 2 found that this move cannot answer it: on the Mac the
  stage's path is in whole px too (`mac.json` `device.wholePx`), so its last move goes to 300, 201 (the run of
  2026-11-24 got 300, 201, and 0 of 59 `pointermove` events with a fraction).
- Q2: which wheel values (deltaY, deltaMode, wheelDeltaY, the count of wheel events) does the page see for a CDP
  `mouseWheel` of deltaY 13, and of 120? At the probe's commit (7988db0) the stage passed the wheel on the Mac; since
  board ab-t30.32 part 2 it sends notches there (C11). So through the stage on the Mac a new run can no longer ask Q2:
  the call of deltaY 13 gets one notch of 120 px, and the call of deltaY 120 then gets no event (the residual is -107,
  so n is 0 with r below 0).
- Q3: how wide is the spread of the stage's sample gaps on one path of about 600 px (count, median, p10, p90, min, max)?

What it does, and what it does not do:

- One agent use: one new background tab at about:blank in the probe's own endpoint scope, the recorder written into it
  with `Runtime.evaluate` (no navigation), synthetic CDP input only (`Input.dispatchMouseEvent`: the move of Q1, the path
  of Q3, then the two wheel calls of Q2), the records read, and only that tab closed. It never lists, reads, focuses or
  closes another tab. It takes no screenshot, moves no window, and takes no keyboard, mouse or screen. As Playwright does
  for each page, it sends `Emulation.setFocusEmulationEnabled` for its page (the relay answers it itself on Linux): with
  it a background tab draws and takes input, and no window or focus of the operating system changes. It also sends
  `Page.setInterceptFileChooserDialog` for its page, so that a file chooser would come as an event (a stop) and not as a
  dialog of the operating system. The probe sends no press, so no chooser should open.
- Stops: an endpoint that is not ready, a JavaScript dialog or a file chooser on its page, the end of its tab or of the
  connection, a failed call, an uncaught error, or 60 s for the whole run. The probe then closes its tab when it knows
  the tab and prints `{ok: false, stage, reason}` with a fixed reason, never a stack trace or a path (exit 1).
  `tabClosed` false or null says that the tab can stay (a closed connection, or a `Target.createTarget` answer that came
  too late): the end of the session's scope removes it. The result goes out before the connection's own close ends (at
  most 1 s later).
- Output: one JSON document of numbers only on stdout, and with `--out FILE` the same document in a new 0600 file outside
  every git checkout: the probe's version and commit, the platform, the Chrome version, the page's size and state, and
  each question's values and summaries. It holds no page text, no URL, no cookie, no token and no path of the box
  (`checkResult` in `parts.ts` refuses every other string).
- The coalesced events: Chrome gives `getCoalescedEvents` in a secure context only. The agent browser's about:blank tab
  is not one on the Linux server (`page.secure` false). Q3 then takes each pointermove's own timeStamp: a pointermove goes
  at the page's next frame with the time of its last sample, so its gap is one sample gap or more. Beside it Q3 gives the
  page's frames during the path (`q3.frames` and `q3.framesMs`, requestAnimationFrame from the start of the part to the
  stage's answer of the path's move, not the wait after it), and `q3.fromCoalesced` says which source the gaps have.

```sh
node test/live/mac-input-probe/probe.ts --cdp-url URL [--out FILE] [--seed N]
```

`mac-input-probe/dry-run.ts` is its dry run on the Linux server: the service of this checkout with `--test`, as
`service-use/check.ts` starts it (temp folders, the pinned agent package, a copy of the box's Chromium), one session,
the session's endpoint, the probe once, then the probe's three stops (a scope with no session: the endpoint's 503; `--out`
inside this checkout: exit 2; a stand-in endpoint that answers with a text that is not JSON: the stop of an uncaught
error). The numbers are Linux's: there the stage rounds to a whole px and sends the wheel as notches.

```sh
flock <heavy.lock> timeout -k 60 600 node test/live/mac-input-probe/dry-run.ts --display 171
```

`test/mac-input-probe.test.ts` (in `npm test`) tests the pure parts (`parts.ts`) with made-up numbers: the arguments, the
`--out` check, the points, the recorder's scripts in a stand-in window, the statistics, the three questions' values and
the check of numbers only.

## The Mac peer probe

`mac-peer-probe/probe.ts` (board ab-v16.52, part 1; the T4 row of section 12 of
`docs/superpowers/specs/2026-11-05-peer-admission-design.md`) is one read-only run on the Mac. A Mac session that the
manager starts runs it once. It measures the Mac side of the relay's peer check (`src/relay/peer.ts`, `MacReader`)
through `node:ffi` into libSystem, as the relay calls it, and it uses the relay's own code where it can (`MacReader`,
`readPeer`, `RootState`, `selfTest`):

- Q1: `LOCAL_PEERPID` and the `cr_uid` of `LOCAL_PEERCRED` for an accepted socket, at the accept and after each step,
  for four connecters. (a) A child connects. (b) A child connects and starts a grandchild with the socket as its fd 3,
  then the child exits, and the orphan grandchild writes one byte: reads at the accept, after the grandchild's start,
  after the child's exit and after the byte. (c) A child passes the socket with SCM_RIGHTS to its own child, the
  receiver, which writes one byte: reads at the accept, after the pass and after the byte. (d) A child starts a sender
  with the socket as its stdout, and the sender writes one byte: reads at the accept, after the sender's start and after
  the byte. Case a also runs the relay's own check (`readPeer`, then the walk and the check of `RootState`) with one
  root: the pane of the probe's chain, or the probe itself when the chain has no tmux server. Each case's
  `holderCalls` names the calls that the new holder makes on the socket before the read between the accept and the
  byte (from the Node and libuv source, not measured): none in case b before `afterFork`; `getsockname`, `getsockopt`
  `SO_TYPE` and on the Mac `setsockopt` `SO_OOBINLINE` in case c (libuv's handle-type calls), then the start of a read,
  which adds the socket to the receiver's kqueue (Node closes the connecter's copy at the receiver's
  `NODE_HANDLE_ACK`); `fstat`, `fcntl` and `uv_guess_handle` on fd 1 in case d (the start of Node). In the xnu source a
  poll or a kqueue add of the socket (`sopoll`, `soo_kqfilter`) sets `last_pid`, as a send does; the other calls do
  not. So in case c, `afterPass` can name the receiver before its byte: that comes from its kqueue add, not from the
  pass itself.
- Q2: `LOCAL_PEERTOKEN` at each read of Q1: the pid (`val[5]`) and the pid version (`val[7]`) of the audit token,
  against `LOCAL_PEERPID`; against the `p_idversion` that `PROC_PIDUNIQIDENTIFIERINFO` gives for that pid right after
  (`layoutVersionMatches`: it reads one live process twice, so it checks the layout of `val[7]`, not a reuse); and
  against the `p_idversion` of the role's process as the probe read it at that process's start
  (`sameProcessAsStarted`: the connecter right after its spawn, before its connect; a helper at its ready file, before
  its byte). A pid that came back between that start and the read gives false. `q2.acceptNamesConnecter` gives, for
  each case, whether the token at the accept names the connecter as it started (its pid and its `p_idversion`). A
  wrong layout of `val[7]` or of `p_idversion` also gives false there: read it beside `layoutVersionMatches`.
- Q3: `node:ffi` on the Mac's Node: each symbol (`getsockopt`, `proc_pidinfo`, `proc_pid_rusage`,
  `mach_absolute_time`, `mach_timebase_info`), the relay's own self-test, the timebase and `mach_absolute_time` beside
  the wall clock, and for the probe and each helper: `PROC_PIDTBSDINFO` (`pbi_start`), `PROC_PIDT_SHORTBSDINFO`,
  `PROC_PIDUNIQIDENTIFIERINFO` (`p_uniqueid`, `p_puniqueid`, `p_idversion`) and `ri_proc_start_abstime` of
  `proc_pid_rusage` (`RUSAGE_INFO_V2`). Each row has `clocksAgree`: a process of the run (younger than 30 s) has the
  same age by `pbi_start` and by `ri_proc_start_abstime`, within 1000 ms. That is a coarse check of the offsets of
  both starts and of the timebase (a wrong `pbi_start` µs field or a wrong timebase can still pass it: read
  `wallMinusAbsMs`, which is a few ms when both are right); false can also come from a step of the clock or a sleep
  during the run. `q3.clocks` counts the rows.
- Q4: the walk from the probe's process to launchd (pid 1): for each ancestor its pid, ppid, name (`pbi_comm`, else
  `pbsi_comm`), uid, start by each clock, unique ids and age by each clock; for each child, whether it starts at or after
  its parent by `pbi_start`, by `ri_proc_start_abstime` and by `p_uniqueid`; whether a tmux server is in the chain and
  whether its parent is launchd.

What it does, and what it does not do:

- It is read only. It changes no clock, no setting and no file outside its own temp folder (`mkdtemp` in the temp
  folder of the system, mode 0700, with its socket in it: at most 103 bytes). It opens no browser, takes no keyboard,
  mouse or screen, and does not touch the agent browser.
- Its helpers (`helper.ts`) are node processes. Their argv holds fixed words, the path of the probe's socket and the
  probe's temp folder (the JSON holds neither). Each helper ends itself after 20 s. The
  probe ends the helpers of each case at the end of the case, and then kills each helper that is left (a tracked pid only
  while its start time is the same). At its end, after an error, at its time limit (30 s) and at a SIGTERM, SIGINT or
  SIGHUP (`test/temp-dirs.ts`), it removes its folder and its helpers. `cleanup` in the JSON counts them.
- SCM_RIGHTS: Node's own IPC channel passes the socket (`send` with a socket: the `sendmsg` of libuv with SCM_RIGHTS).
  The probe needs no helper program (no python3) and no native code other than `node:ffi`.
- Output: one JSON document on stdout. It holds pids, process names (for example `zsh`, `tmux`, `node`), uids, start
  times and fixed texts. It holds no argv, no environment, no path and no secret: its check refuses each `/`, `\` and
  `@`, and its scrub takes out the home folder, the login name and the temp folders (`redacted` counts the strings that
  it changed). Node writes the ExperimentalWarning of `node:ffi` on stderr.
- Exit: 0 when it ran and printed (`ok` true or false inside; `ok` is true only when every case ran and nothing of the
  probe stayed); 1 at its time limit or at an uncaught error (the JSON still prints), and when the result fails its own
  check (`stage` `output`: the JSON then holds the stop and `cleanup`, and no part); 2 for an argument (it takes none).
- A sandbox of the shell (for example a sandbox of the session's Bash tool on the Mac) can block the connect to the
  probe's socket and `proc_pidinfo` of processes outside the sandbox. Then the cases stop at a `q1-*` stage, the relay's
  self-test fails (`q3.selfTest.ok` false), and an EPERM in Q4 can come from the sandbox, not from another user. So the
  seat reports whether its shell runs in a sandbox, and it reports such a stop as it is; it does not run the probe
  again.
- Time: about 1 s on the Linux server, and a few seconds on the Mac.

On the Mac, in a temp checkout at the pushed commit, after `npm ci --ignore-scripts` (Node 26.1 or later: `node:ffi`
is in Node since 26.1.0):

```sh
node test/live/mac-peer-probe/probe.ts
```

The Linux dry run is the same command on the Linux server. It runs only the parts that have a Linux twin: the four
cases of Q1 with `SO_PEERCRED` (it names the connecter for the life of the socket, so each read gives the connecter),
the relay's self-test (the pidfd form) and the relay's check of case a with the probe as the root. It answers `ok` false
with the reason `not the Mac (linux): ...`, `q2` and `q4` null, and exit 0. On each other platform the probe answers `ok`
false at once.

`test/mac-peer-probe.test.ts` (in `npm test`) tests the pure parts (`parts.ts`) with made-up kernel structs: each field
read, the facts of a process, the order checks of the walk (a step back of the wall clock, a re-parented process, a pid
that came back), the reads of Q1 and Q2, and the keys, the check and the scrub of the result. On Linux it also runs the
probe once (the dry run above) and checks that the probe leaves no helper and no folder.

What the probe cannot measure:

- A step of the clock: the probe never changes the clock. It gives the start of each process by both clocks and their
  difference (`wallMinusAbsMs`: the time asleep plus each step of the wall clock since the start), and the order that
  each clock gives.
- A pid that comes back: a reuse needs about 100000 new processes. The probe gives the pid versions and the unique ids
  that a reuse-proof check can compare.
- A bare `fork()`: Node has none. The grandchild of case b starts with Node's spawn (fork and exec, or posix_spawn).
  In the xnu source, `last_pid` changes only at a call on the socket, so a bare fork is expected to give the same answer.
- launchd and the processes of other users: `PROC_PIDTBSDINFO` and `proc_pid_rusage` need the same user (xnu's
  CHECK_SAME_USER), so the probe expects EPERM for them, and the edge to launchd has no start by either clock.
  `PROC_PIDT_SHORTBSDINFO` and `PROC_PIDUNIQIDENTIFIERINFO` need no permission.

Measured on the Mac, 2026-11-25 (one run of the probe at 92ea894 in a Mac session: Darwin 27.0.0 arm64, Node 26.13.0;
exit 0, `ok` true, about 1.1 s). `LOCAL_PEERPID` is the last process that used the client's socket: the connecter at
the accept, still the connecter's pid after it exited (case b), then the next holder that used the socket (in case c
the receiver by its kqueue add at `afterPass`, before its write). The token's `val[5]` was that pid and its `val[7]`
the `p_idversion` of that process in 10 of 10 reads; after the connecter's exit the token's read failed with `EINVAL`.
`p_uniqueid` ordered each edge from the probe to launchd (whose `p_uniqueid` is 1) child after parent. By
`ri_proc_start_abstime` tmux was 1337 s younger than by the wall clock (it stops while the Mac sleeps). So the relay's
Mac reader (board ab-v16.52, part 2) reads the peer with `LOCAL_PEERTOKEN` and the `p_idversion` of its pid, and
orders the walk by `p_uniqueid`, with no clock; since then the probe's `relay` field is that token read.

## The Mac memory probe

`mac-memory-probe/probe.ts` (board ab-v16.97.8, part 1; section 5.5 and section 13 row 11 of
`docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md`) is one read-only run on the Mac. A Mac session
that the manager starts runs it once. The stored sign-ins hold the store's open key in the service's memory. On Linux
the service starts non-dumpable (`prctl` through `node:ffi`), so another program of the same user cannot read its
memory. The probe measures whether a program of the same user can read the memory of a Node process on the Mac, and
which protection stops which reader. Its run of 2026-11-25 (at aacd9bd) is in the design's section 5.5. Part 2 of the
board task built the Mac's protected start from that JSON (`src/service/signins/protect.ts`; the parsers of
DevToolsSecurity, csrutil and the entitlements moved to `src/service/signins/mac-tools.ts`, and `parts.ts` imports
them). The store and the sign-in act stay off on the Mac until board ab-v16.97.14.

- Q1, the environment (read-only commands): the Darwin release, the arch, Node's version; `DevToolsSecurity -status`
  (`devToolsSecurity`: enabled, disabled or unknown); whether the user is in the group `_developer` (`id -Gn`:
  `developerGroup`); `csrutil status` (`sip`: enabled, disabled or unknown); whether developer tools are present
  (`xcode-select -p` exits 0: `developerTools`; the path is not read). `q1.reads` gives each command's class and exit.
- Q2, the code signatures (`codesign -d --verbose=4` and `codesign -d --entitlements - --xml`) of the probe's own Node
  (`q2.probeNode`) and of the program of the service's launchd job (`q2.service`: `launchctl print
  gui/<uid>/com.agentwatch.agent-browser`, its `program` line or else the first of its `arguments`; `job` is `not
  loaded` when launchd has no such job). For each: `kind` (none, ad hoc, Developer ID, Apple, other), `runtime` (the
  hardened runtime flag), `flags` (the flag names of the CodeDirectory line), and `entitlements` (`getTaskAllow`,
  `debugger`, `allowJit`, `allowUnsignedExecutableMemory`, `disableLibraryValidation`: true or false). No identifier,
  no team id and no path goes into the JSON. `sameFileAsProbeNode` compares the job's program and the probe's Node by
  device and inode. A Node with `getTaskAllow` true (the official build can have it) is debuggable by design: root, or
  a debugger of the same user (with `cs.debugger`, under DevToolsSecurity or the group `_developer`), can get its task
  port; a program with no entitlement gets EPERM from taskgated (xnu, `task_read_for_pid`). The probe never reads a
  file in `~/Desktop`, `~/Documents`, `~/Downloads` or `~/Library/Mobile Documents`, where a read can make macOS ask
  for access: such a Node or program gets the class `skipped` ("a folder that can ask for access"), with no stat, no
  codesign and no copy.
- Q3, three throwaway targets, children of the probe (`helper.ts`), each with a random marker of 32 bytes
  (`crypto.randomBytes`), alive until the probe ends it. Each target holds the marker in three places: the 32-byte
  Buffer of `randomBytes` (V8 can keep so small a typed array on its own heap), a `Buffer.alloc` of 64 KiB that holds
  the marker repeated (off V8's heap: a malloc block of Node's allocator), and the marker's hex form in a JS string (on
  V8's heap). T0 is the probe's Node, plain. T1 is the probe's Node after `ptrace(PT_DENY_ATTACH, 0, 0, 0)` through
  `node:ffi` (`deny` gives its return and errno). T2 is a copy of the probe's Node in the probe's temp folder, signed ad
  hoc with the hardened runtime and the entitlements allow-jit, allow-unsigned-executable-memory and
  disable-library-validation, with no get-task-allow (`prepare` gives the free disk, the copy's size, the sign's class
  and the copy's signature as Q2 reads it). A failed copy, sign or start of T2 is recorded (T2's `start`: for example
  `killed` when AMFI or dyld ends it) and skips T2's reads; the run goes on. For each target, in this order, each read
  with its own time limit of 20 s, and only while the target still runs (else the read's class is `target ended`):
  - a: `task_for_pid(mach_task_self(), pid, &port)` (a Mach trap: a `kern_return_t`) and `task_read_for_pid` (a BSD
    system call: 0, or -1 and an errno, read through `__error`) through `node:ffi`, in a port reader (`helper.ts port`:
    the probe's own Node, a sibling of the target, so that a call that hangs ends at the time limit): each `ret` with
    its `name` (the `kern_return_t`'s name, or the errno's name for -1), whether the kernel gave a port (a port name
    that is not 0), and whether `mach_port_deallocate` freed it. A symbol that does not load gives its dlopen error's
    `code`. The port reader never reads memory with the port.
  - b: `vmmap --summary <pid>`: `ok` (exit 0, some output, no refusal note), `limited` (exit 0 with `not debuggable`
    or `restricted`), the class of another refusal note (also at exit 0), or `no output`, `killed` or `failed`.
  - c: `leaks --outputGraph=<temp folder>/<target>.memgraph <pid>`: `graph` (it ended by itself with exit 0 or 1, and
    the file was written; leaks exits 1 when it finds leaks), `graph limited` (the same, with `not debuggable` or
    `restricted`), `graph with a refusal note` (the same, with another refusal note: neither readable nor refused),
    `partial graph` (a file, but leaks did not end by itself with 0 or 1), or the class of its refusal. Only a whole
    graph is searched for the marker (`Buffer.indexOf` of the raw bytes and of the hex form, chunk by chunk; no regex):
    `markerFound` true or false, else null; `forms` says which form. After each leaks run every file of the folder but
    T2's copy goes, also a partial graph and a graph of another name (`otherGraphs`, `otherFiles`). When a graph
    ended whole with no marker, the probe runs leaks once more with `--fullContent` (`cFull`), because a memory graph
    can hold only the pointers and not the contents.
  - d: `lldb --batch --no-lldbinit -p <pid> -o "process status" -o "detach"`: `attached` or the class of its refusal.
    lldb detaches; the probe kills its process group at its time limit. d never runs on T1: xnu sends SIGSEGV to a
    process that tries to attach a process with PT_DENY_ATTACH, so debugserver would crash and macOS would write a
    crash report (the class is `skipped` with "PT_DENY_ATTACH (xnu sends SIGSEGV to the attacher)").
  `notes` gives the fixed words that the probe found in the first 8 KB of a tool's stdout and in the first 8 KB of its
  stderr, each read apart (for example `not debuggable`, `restricted`, `cannot examine`, `sudo`, `not allowed`, `lost
  connection`, `password`), never the text itself.
- `summary` gives each target's verdict, reader by reader (`taskPort`, `readPort`, `vmmap`, `leaksGraph`,
  `leaksMarker`, `lldbAttached`), and `readable`:
  - true when a reader got the target's memory or its task port (`by` names them): read a got a port; vmmap ran with
    no restriction (`ok`: it got the task read port); leaks wrote a whole graph with no restriction (`graph`); a graph
    held the marker; or lldb attached.
  - false only for a refusal that protects (`refusedBy`): vmmap or leaks `limited`, `graph limited`, `not debuggable` or
    `restricted`, or lldb `not allowed`, and no reader got the memory.
  - null for every other class: a timeout, a kill, the probe's own stop, a usage error, a missing tool, `password`,
    another refusal note (also at exit 0), vmmap `no output`, leaks `graph with a refusal note`, lldb `failed` or `lost
    connection`, no graph, a partial graph, a skipped read, an ended target. A port that the kernel refuses to the
    port reader is no protection either: the probe's Node has no debugger entitlement.
  - `leaksMarker`: true when a graph held the marker; false when a restricted graph ended whole with no marker; for a
    graph with no restriction and no marker, cFull's definite answer, else null (a failed or skipped cFull never falls
    back to c's false).
  - The control: T0 has no protection, so it must be readable true. When it is not, each false of T1 and T2 becomes
    null (`controlled` true), and `summary.control` is `failed` with `controlWhy`; else `control` is `ok`. The lead
    reads which protection (none, PT_DENY_ATTACH, the hardened runtime) stops which reader from the three rows.

The guards (`q3.guards`), so that no dialog asks for a password or offers an install:

- a runs when the probe's Node has no `com.apple.security.cs.debugger` entitlement, or DevToolsSecurity is enabled.
  With the entitlement, `task_for_pid` can ask taskgated, which can show the Developer Tools Access dialog.
- b and c run only with developer tools present, in case `vmmap` or `leaks` is an xcrun shim on this macOS.
- d runs only when DevToolsSecurity is enabled, developer tools are present, and the user is in the group
  `_developer`. Else lldb's debugserver can show the Developer Tools Access dialog, or `/usr/bin/lldb` can offer to
  install the tools. Never on T1 (above).

An open point: read a measures a caller with no debugger entitlement, and read d measures Apple's debugserver (Apple
signed, with the debugger entitlement). An ad hoc tool of the user with `cs.debugger` is not measured; it is at most as
strong as debugserver.

What it does, and what it does not do:

- It reads only, outside its own temp folder (`mkdtemp` in the temp folder of the system, mode 0700). It changes no
  setting (no DevToolsSecurity change, no keychain, no sudo, no clock, no service or launchd change: only `launchctl
  print`), opens no browser, takes no keyboard, mouse or screen, and does not touch the agent browser. It writes no
  file outside its folder. If AMFI or dyld ends T2's copy at its start, macOS can write a crash report of the copy.
- It reads no process that is not its own child. The service's job is only read with `launchctl print`, and its program
  file with `codesign -d`.
- Each tool runs in its own process group with stdin from `/dev/null` and is killed at its time limit. lldb starts
  debugserver in a session of its own (`--setsid`), so the kill of lldb's group does not reach it and the cleanup does
  not count it: debugserver ends with its connection to lldb, or with its target. A read that would end after 170 s is
  `skipped` ("the run's time limit is near"). At its end, after an error, at its time limit (180 s) and at a SIGTERM,
  SIGINT or SIGHUP (`test/temp-dirs.ts`) the probe kills each target, port reader and tool that is left and removes its
  folder (the copy of Node, the memory graphs). Each target also ends itself after 170 s, and at the end of its IPC
  channel. `cleanup` in the JSON counts them.
- Disk: the temp folder holds a plain copy of the probe's Node (about 150 MB on the Linux server: a copy of its bytes,
  so that no extended attribute such as the quarantine comes with it) and one memory graph at a time. The copy and each
  leaks run need 1.5 GB free (`statfs` of the folder), else they are `skipped`. While leaks runs, the probe reads the
  size of the folder's graphs and the free disk every 250 ms, and kills leaks when the graphs grow above 1 GB (`graph
  too large`) or the free disk falls below 500 MB (`disk nearly full`); that graph is not searched and goes at once.
  The seat brief asks for 2 GB free.
- Output: one JSON document on stdout. It holds classes, exit codes, return values, pids, sizes and fixed texts. It
  holds no path, no argv, no environment, no login name, no marker and no secret: no tool's text goes into it; its
  check refuses each `/`, `\` and `@` and each run of 41 or more letters and digits (a marker's hex form is 64), and
  its scrub takes out the home folder, the login name, the temp folders and the markers (`redacted` counts the strings
  that it changed). The probe itself loads no `node:ffi` (its helpers do, with their stderr closed).
- Exit: 0 when it ran and printed (`ok` true or false inside). `ok` is true when T0 and T1 started, no target, helper,
  tool or folder of the probe stayed, and the run was on the Mac; a skipped read, an ended target, a failed T2 and a
  failed control leave `ok` true (the reads and `summary` say so). 1 at its time limit or at an uncaught error (the JSON
  still prints), and when the result fails its own check (`stage` `output`); 2 for an argument (it takes none).
- A sandbox of the shell can block the tools' reads of the targets. Then the classes say so; the seat reports whether
  its shell runs in a sandbox, and it does not run the probe again.
- Time: about 2 s on the Linux server. On the Mac about 30 s to 2 min (leaks and lldb on a Node process take some
  seconds each); at most 180 s.

On the Mac, in a temp checkout at the pushed commit (no `npm ci`: the probe and its helpers import only `node:` modules
and files of the repo; Node 26.1 or later: `node:ffi` is in Node since 26.1.0):

```sh
node test/live/mac-memory-probe/probe.ts
```

The Linux dry run is the same command on the Linux server. It makes the folder, starts and ends T0 and T1 (T1 with
`prctl(PR_SET_DUMPABLE, 0)` in place of PT_DENY_ATTACH: `deny.after` 0 says that T1 is not dumpable), and runs the
Linux twin of the marker search (`q3.linuxTwin`): the probe reads each target's writable anonymous memory through
`/proc/<pid>/maps` and `/proc/<pid>/mem` and searches it for the marker as it searches a memory graph. T0 shows the
marker (the probe is its parent, and Yama's `ptrace_scope` is 1), and T1 refuses (`EACCES`: it is not dumpable). That
proves that the marker is in a live Node target and that the search finds it. The dry run also checks the tool runner
(an exit 0, a time limit that kills the tool's group, a missing tool: `q3.runnerCheck`) and cleans up. It answers `ok`
false with the reason `not the Mac (linux): ...`, `q2` and `summary` null, and exit 0. On each other platform the probe
answers `ok` false at once.

A test seam, on Linux only: `AB_MEMORY_PROBE_STANDIN=<a folder of stand-in tools>` makes the probe run the Mac's flow
with those tools in place of Apple's (each by its base name). The run answers `ok` false with the reason `stand-in tools
on Linux (the test seam) ...` and `q3.standin` true: it is never a measure. The seam has no effect on the Mac.

`test/mac-memory-probe.test.ts` (in `npm test`) tests the pure parts (`parts.ts`) with made-up outputs of Apple's tools
(they are not measured: the Mac run checks them): the parsers of Q1 and Q2, the folders that ask for access, the
`kern_return_t` and errno names, the readers' classes and notes, the byte search across chunks, the guards, the verdicts
and the control, the parse of `/proc/<pid>/maps`, and the result's keys, check and scrub. On Linux it also runs the
probe twice: the dry run above (with the twin: T0 shows the marker, T1 refuses), and the Mac's flow with stand-in
tools (the cFull path, a graph of another name, a graph above 1 GB that the watch kills, a refusal on stderr, no d on
T1, the summary and its control), and checks that each run leaves no target, no tool and no folder.

## The Mac sign-in window probe

`mac-signin-window-probe/probe.ts` (board ab-v16.97.14, part 1; the design note
`docs/superpowers/specs/2026-11-26-stored-sign-ins-mac-design.md`, D1, D2 and D4) is one on-screen run on the Mac,
with the operator at the Mac. A seat session that the manager starts runs it once. On Linux the sign-in act moves its
window outside the screen at the X level; the Mac has no X, and the receiver cannot place a window outside the screen
(the 50% rule). The probe measures, for each way to keep the act window off the screen, what the site sees and whether
the act's input arrives, and it reads the taskport right and two TCC rights.

- `taskport`: `security authorizationdb read system.privilege.taskport` (read only). The class, the rule names (known
  ones by name, else `other`), the group (`_developer`, `admin`, `staff`, `wheel`, else `other`), `authenticateUser`,
  `shared`, `timeout`, `allowRoot`, `sessionOwner`, `tries`, and `meaning` (parts.ts, `taskportMeaning`: for example "a
  password once, shared for its timeout"). No comment, date or path.
- `rights`: `screenRecording` and `accessibility` of a program that the seat's shell runs (`helper.ts`:
  `CGPreflightScreenCaptureAccess` and `AXIsProcessTrusted` through `node:ffi`, the two reads that Apple documents as
  reads with no prompt; the calls that can prompt are never made). TCC gives a process its responsible process's
  rights, so an agent's program of a session gets the same answer.
- `runs.A` and `runs.B`: the probe's own Google Chrome (`/Applications/Google Chrome.app`'s binary, a second instance on
  a new temp profile: never the operator's Chrome, the agent profile or the service), started on the CDP pipe
  (`--remote-debugging-pipe`; no port) with Chrome's mock keychain and no crash reporter (`--disable-breakpad`). Run A
  has the agent's flags (`AGENT_ARGS`); run B, the sensor, has them without `--disable-backgrounding-occluded-windows`,
  so its page's visibility gives macOS's own occlusion: whether the window is on the screen for a person. In each run:
  - `front0` and `giveBack`: the app in front before the start (`chrome`, `other` or `none`: never a name), and after
    the start, when the probe's Chrome took the front, one ask to give it back (the service's give-back calls,
    `src/giveback.ts`: NSWorkspace's `frontmostApplication` and NSRunningApplication's `activateWithOptions(0)` through
    osascript's JavaScript bridge; no Apple Event, no input, no System Events). The same ask follows each window's
    create (Chrome's Show() activates Chrome). At most 12 asks in a run.
  - `crashpad`: the crash handlers of the probe's Chrome that ps found (its children, not older than it: a handler calls
    setsid, so the group kill does not reach it), how many ended with Chrome, and how many the probe stopped.
  - `screen`: the main screen's size and work area, and `extended` (more than one screen).
  - `extension`: the test extension (parts.ts, `EXTENSION_SW`: `chrome.windows` only): `devMode` (the probe turns
    developer mode on in its own temp profile through chrome://extensions' own call), `load` (CDP's
    `Extensions.loadUnpacked`, Chrome's documented path with `--enable-unsafe-extension-debugging` and the pipe),
    `idMatch`, `worker`, `prefsWrite` (run A's profile holds the Linux service's pre-start write of the incognito allow;
    run B's none), `allowedAtLoad` (the allow at the load: in run A, whether that write held: D3), `switch` (with no allow
    at the load, the operator's switch through chrome://extensions' own call,
    `developerPrivate.updateExtensionConfiguration` with `incognitoAccess: true`: `ok`, `refused`, `not needed`, ...),
    `allowedAfterSwitch` (the reloaded extension's allow) and `allowedIncognito` (the allow that the api options use).
    When it does not load, the `api` options are `skipped` and the CDP options still run.
  - `options`: run A the six options of parts.ts (`OPTIONS`, `RUN_OPTIONS.A`), in this order: `front` (the baseline: a
    normal window at 100,100, 800 by 600), `apiMinimized` (`windows.create` with `state: "minimized"`, `focused: false`,
    `incognito: true`: the act window's own form, by the receiver's own call), `minimized` (a CDP view of the same; no
    pick), `apiOverCover` (a cover window over the work area first, then `windows.create` with `focused: false` and
    `incognito: true`), `behind` (a CDP cover window over the baseline's window) and `edge` (half of the window outside
    the right edge); run B the four whose sensor facts the summary reads (`RUN_OPTIONS.B`: `apiMinimized`, `front`,
    `apiOverCover`, `behind`). Each: `made`, `window` (Chrome's state and bounds), `ext` (the extension's view of its
    window: its state, focus and own incognito flag), `front` (for the api
    options: who was in front before and after the create, and `took`), `measure` (the page's `vis`, `focus`, animation
    frames and 10 ms timer ticks in 1.2 s, an IntersectionObserver's callbacks, the window's and screen's numbers),
    `typed` (after a CDP click on the field, the plain test text "probe text 42" as key events and " xyz" by
    `Input.insertText`: whether the field holds the whole text, the counts of each event, untrusted events, and the
    visibility and focus at each key: `keysHidden` counts the keys that came while the page was hidden), `hangs`
    (input calls with no answer in 2 s; after 2 the option types no more) and `after`.
  - `apiRule`: `windows.create` with half of the window outside the right edge, with three quarters outside, and
    minimized with a place: each one's class (`ok`, `the 50% rule`, `a state that does not combine`, ...) and, when
    made, where Chrome put it.
  - `stopped` and `profile` (in which file Chrome kept the extension's entry after the run, and its `incognito`).
- `summary`: for each option `siteVisible` (run A: visible, frames, timers, the observer), `input` (run A),
  `incognito`, `state`, `keysHidden`, `seen` (run B: the page visible), `tookFront` (run A) and `tookFrontB`; `facts`
  (each fact of the design note's rule, 4.4, for `apiMinimized`: true, false, or null for not measured), `failed`,
  `notMeasured`, and `pick`: `minimized` only when every fact is measured and holds (both runs started, the window
  incognito by its own flag and `minimized` by `windows.get`, visible to the site, the input, no key on a hidden page,
  no front taken in run A and in run B, not seen in run B); `not measured` when no fact fails and one or more are null
  (an unmeasured fact never counts as a pass); when a fact fails, `on the screen` if a baseline holds (`front`, or
  `apiOverCover`: `windows.create` with `focused: false`, the fallback's own call), `none` if both fail, else `not
  measured`.

What it does, and what it does not do:

- It writes no file outside its temp folder (`mkdtemp`, mode 0700), and it changes no setting: no DevToolsSecurity
  change, no sudo, no keychain, no TCC change, and no call that can prompt. Developer mode, the extension and its
  incognito allow are only in its own temp profiles. What Chrome itself can write outside its profile is not the probe's
  (assumed, not measured): its macOS defaults (shared with the operator's Chrome), and a crash database under the default
  user-data folder if its crash reporter runs in spite of `--disable-breakpad`. Its pages are its own, on 127.0.0.1 only
  (a wrong Host gets 421): no public site. It types only the plain test text: no secret.
- The operator sees a Chrome window at each start (it may take the front for a moment; the probe gives the front back),
  the probe's blue test page in windows that open and close, a grey cover window over the screen for a few seconds, and
  minimized windows in the Dock. The operator types and clicks nothing until the probe ends.
- At its end, after an error, at its time limit (120 s) and at a SIGTERM, SIGINT or SIGHUP (`test/temp-dirs.ts`) it stops
  its Chrome (`Browser.close`, then SIGTERM and SIGKILL of its process group), its crash handler (when ps shows it as the
  same process), each tool and its page server, and removes its folder. `cleanup` counts them.
- Output: one JSON document on stdout, with classes, numbers and fixed words only: no path, argv, environment, login
  name, URL or title of another app's window; its check refuses each `/`, `\` and `@`, and its scrub takes out the home
  folder, the login name and the temp folders. A value that still fails the check is masked (`<masked>`, or null), and
  `detail` names each place: one bad value does not cost the run's data.
- Exit: 0 when it ran and printed (`ok` true when both runs started on the Mac and nothing of the probe stayed); 1 at
  its time limit or an uncaught error (the JSON still prints), and when the result fails its own check; 2 for an
  argument (it takes none) or a refused seam.
- Time: about 50 to 80 s on the Mac; at most 120 s. An option that would end after the reserve of 15 s is `skipped`.

On the Mac, in a temp checkout at the pushed commit (no `npm ci`: the probe imports only `node:` modules and files of
the repo; Node 26.1 or later for the rights helper's `node:ffi`):

```sh
node test/live/mac-signin-window-probe/probe.ts
```

The Linux dry run is the same command on the Linux server: it makes the folder, the extension (its id from its key) and
the page server, checks the server (the two pages, a missing path, a wrong Host), runs the pipe client against a
stand-in browser (a Node script on the pipe's fds 3 and 4) and stops it both ways (`Browser.close`, and the kill of one
that stays), cleans up, and answers `ok` false with the reason `not the Mac (linux): ...` (`dry` holds the checks).

The Linux twin, a seam on Linux only: `AB_SIGNIN_PROBE_TWIN_DISPLAY=<n>` runs the Mac's Chrome flow with
`/usr/bin/chromium` on a private Xvfb of display `<n>` (a reserved display, or one in use, is refused before it starts
anything), under the harness guard and its lock (rules 1 and 2 above): both runs, the extension and the switch of run
B, the options and the rule check. It answers `ok` false with the reason `the Linux twin ...`: it checks the flow, it measures nothing of
the Mac (Xvfb has no window manager: a minimized window stays normal). Run it under heavy.lock:

```sh
flock <heavy.lock> timeout -k 60 400 env AB_SIGNIN_PROBE_TWIN_DISPLAY=176 node test/live/mac-signin-window-probe/probe.ts
```

`test/mac-signin-window-probe.test.ts` (in `npm test`) tests the pure parts with made-up outputs of Apple's tools (not
measured: the Mac run checks them) and runs the Linux dry run, the refusal of an argument and of a reserved twin
display, the rights helper off the Mac, and the cleanup seam: `AB_SIGNIN_PROBE_DRY_HOLD=<ms>` (Linux only, never with
the twin) sets the time limit to `<ms>` and holds the dry run with a stand-in that stays, and the test checks that the
time limit, SIGTERM and SIGHUP each stop the stand-in and remove the folder. It starts no Chrome, Chromium or Xvfb.

## The Mac blanket check

`service-blanket-mac/check.ts` (board ab-4wh.16; C12, the blanket profile on the Mac) is the Mac twin of
`service-blanket/check.ts`. The manager runs it on the Mac, as the operator's user, from a checkout of the build: `node
test/live/service-blanket-mac/check.ts --state ~/ab-blanket-live`. The first run needs the operator at the Mac for one
step: the check sends `blanket_setup`, the set-up Chrome opens on the Mac's screen, and the check prints the steps (in
chrome://extensions: Developer mode, Load unpacked, Command-Shift-G, the folder `<state>/agent-package-blanket`). The
template stays in the `--state` folder, so a later run with the same folder needs no operator. The service is
`service-blanket-mac/blanket-mac-service.ts` (startService on the Mac, with the address proxy's test resolver and the
local stand-in hook of `service-blanket/blanket-service.ts`, and no Chrome update check). Every page is local: the
stand-in is a server of the check on 127.0.0.1, and the names public.test and private.test resolve only in the proxy's
test resolver. The check tests the hello's features, status's `blanket_template` and its sentences, the set-up and its
end, the start of only the blanket Chrome through `open -n -g` with the proxy's four flags in its arguments, the copy of
the template's files, the receiver's hello on the blanket link, the public host class, the address proxy with the Mac's
peer check (public.test passes; private.test and 127.0.0.1 fail for a fetch, a WebSocket, a worker and a navigation),
the end (the blanket folder and the proxy go, the template stays) and the service's stop. It stops only the processes
that it started, by pid and start time, and removes its temp folder; the `--state` folder stays until the manager
deletes it. It takes a `--state` folder only when it is new or empty, or holds the check's own mark file from an
earlier run, and never the folders of agentwatch's agent browser. On another system it exits at once with `the Mac only`.
