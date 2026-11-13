# Live harnesses: two rules

Every live, probe or dry-run harness here that starts Xvfb or Chromium on Linux follows two rules
(board ab-v16.78; taylor ran out of memory on 2026-11-06 with an orphan Xvfb and Chromium after a
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
- A harness that a harness starts (the stable part of `anti-detect/mac.ts --dry-run`) runs under its
  parent's lock: `HARNESS_GUARD_HELD` names the holder, and the guard checks that the holder's driver
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

No harness takes the X displays 0, 90 (agentwatch's agent browser on taylor, the operator's), 147,
190, 191 or 192, whatever its setting is: `RESERVED_DISPLAYS` in `harness_guard.py` and `guard.ts`
(and chrome-extension's `run.sh`; the tests compare the lists). When such a display stops, its socket
and lock file go, so a free test alone would take it. The parity probe's display search (from 90 on)
skips them. Every other harness refuses a reserved display that `--display` or `DISPLAY_N` names
(exit 2, before it makes or starts anything), and the dry run of `anti-detect/mac.ts` also refuses a
display whose next one (its stable part's) is reserved: `--display 89`, `146` or `189`.

## Which harnesses

The guard: `agent-mode/run.ts` (its own mode; the pointer group is part of it), `background-tabs/`
(`check.ts`, `visibility.ts`, `override.ts`), `anti-detect/` (`run.ts`, `extra.ts`, `mac.ts
--dry-run`, whose `mac-standin.ts` is a child of it), `function-keys/check.ts`, `input-harness/run.ts`,
`parity/probe.ts` on Linux, `service-unit/check.ts` (board ab-v16.94.3: the service that it starts with `--test`
starts Xvfb and Chrome, and the check gives each of their pids to `track()` and signals only those pids), and
`service-link/check.ts` (board ab-v16.94.9: the same, with the native link, the real agent package and the host shim,
whose pid it tracks too; `--display 174`, and `--chrome-extension <checkout>` to compare the CRX with `git show`), and
`service-use/check.ts` (board ab-v16.94.11: the same service, with no start op: a first use starts Chrome, the grace
time of the stop by use stops it, and a new use starts it again; `--display 171`), and `sign-in-act/check.ts` (board
ab-v16.97.4: the same service through `sign-in-act/service.ts`, with the run's copy of the receiver 0.3.7 that it reads
with `git show` from `--chrome-extension <checkout>`; a sign-in with test values on a local login page, the act window
outside the screen and hidden from the client, the block, the move, the CLI and the secret scan; `--display 171`).

No guard: the macOS checks (`takeover/`, `anti-detect/mac.ts` without `--dry-run`,
`function-keys/check.ts --on-my-screen`, `parity/probe.ts` on macOS): they run on the person's own
screen, with no Xvfb, and the guard is Linux only. `sheets.ts` starts no Xvfb and drives a running
agent browser. The agent-mode run's external mode starts no Xvfb or Chromium.
Before it connects, ends scopes or restarts a relay, the external mode compares CONTROL status's socket with RELAY_SOCK using realpathSync.
The run exits 2 for different paths, missing files or socket fields, invalid JSON, a failed status or a status timeout.

Environment: `HARNESS_LOCK_WAIT` (seconds), `HARNESS_LOCK` (another lock file: for the tests only).

## CLI click downloads

`click-download.ts` uses a headless Chromium with its own profile, pipe endpoint, proxy and harness guard.
It clicks a local `a.localhost` button that serves a CSV attachment.
It then clicks a button that creates a blob download.
Both results must name a file with the expected contents, name, URL and size.

Run each check under the box's shared heavy-job lock, if it has one.

```sh
node test/live/click-download.ts
```

The agent-mode harness runs the same checks through its stand-in daemon, receiver and relay.
Use its own mode only. The downloads group refuses external mode.

```sh
CHROME_EXTENSION=/absolute/path/to/chrome-extension CASES=downloads DISPLAY_N=124 \
  node test/live/agent-mode/run.ts
```

Both harnesses use `harnessGuard` and check `reservedDisplay` before they start Chromium.
The default check starts no Xvfb and uses no display.

## The input stage's live rows

The group `stage` of `agent-mode/run.ts` (board ab-t30.9) runs alone, in the own mode, with the relay's input stage on
(the build switch's door for the live rows: `AGENT_BROWSER_INPUT_STAGE=test` in the relay's environment; nothing else
turns the stage on until boards ab-t30.9 to ab-t30.12 are all merged). Its scope `stage` has the list `a.localhost` and
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
the server (and once more at `pagehide`), and the row passes when the last one is the text's.

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
`STAGE_PERSON` when it names a reference of the operator's published numbers (a report: the Mac's wheel model is board
ab-t30.13), and two reports give the wheel calls that went with the rest as one event (`wheelRestAsOne / wheelCalls`), in
the harness and in the whole run. It writes `stage-scroll-live.json`, `stage-scroll-harness-results.json` and
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
node test/live/input-harness/run.ts --rescore $S/out/run-XXXXXX/results.json [--reference FILE]
```

The run writes `results.json` (the page's records, which hold its state: keep them out of the
repository), `reference.json`, `report.json` and `report.txt`, and prints the table.

The cleanup (`cleanup.ts`): at its exit, and on SIGINT, SIGTERM and SIGHUP, the run stops the processes
that it started by their pids, then removes its Chromium profiles, agent-browser's state folder, its
socket folder, its run folder when it holds no `results.json` (a refusal or an interruption), and the out
folder when the run made it and it is empty. A bridge that does not start stops its own Chromium and
removes its profile.

The reference: until part B (board ab-t30.7) exists, the run builds it from its own XTEST steps, and
takes the values that XTEST cannot give from the literature (`LITERATURE` in `reference.ts`). Part B's
numbers replace it through one file: `--reference FILE`. The file holds numbers only, in the fields of
format 1 (the head of `reference.ts`; the fixture is `reference.fixture.json`). `checkReference` refuses
any other field, by its own name (so also `constructor`, `toString` and `__proto__`), and any value that
is not a number, so no user agent, screen or text can be in it. The only names that are not fields are
the letter pairs of the optional `keys.downToDownByPairMs` (two characters each) and the keys of the optional
`keys.holdByKeyMs` (one character each), with numbers as values.

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
  build's own replay: `human-same`). The range row over all paths is information with an XTEST
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
- P6's load to the first move (board ab-t30.3): the time from the top page's load to its first trusted
  pointer move, on the step that holds that move; measured, not scored (Q4; part B's task 6).
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
