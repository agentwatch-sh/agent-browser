# The probe of the vanilla Playwright input design

The evidence of
[2026-11-10-vanilla-playwright-human-input-design.md](../2026-11-10-vanilla-playwright-human-input-design.md)
(board task ab-t30.6). Not part of `npm test`, and not product code.

Run on taylor on 2026-11-10 (UTC): Debian 13, Linux 6.12.115, Node v26.12.0, Debian Chromium 156.0.8078.79
(`/usr/bin/chromium`), `playwright-core` 1.65.0 in a scratch folder (not in `package.json`), a private Xvfb on
display 169 (1920 x 1080 x 24, no window manager, its own X authority file). Each run held the box's shared
heavy-job lock and the repository's harness guard. Nothing ran on the Mac. No page of the network was
reachable.

## What it does

`probe.ts` starts a private Xvfb (display 169 by default; it refuses the reserved displays of
`test/live/guard.ts`), and for each scenario its own Chromium on a new profile with
`--remote-debugging-pipe`. A small bridge serves the pipe as a WebSocket on a Unix socket in a temporary
folder of its own and records each CDP message with its time. Chromium opens no debugging port. The page is
the input research's recorder (`docs/research/2026-11-09-click-box-input-signals/recorder.html`) on a local
server, with the click-box stand-in in a frame of `box.localhost`. No other host is reachable: the host
resolver maps every other host to nothing, and the proxy is a closed local port. The probe takes the
repository's harness guard, ends only the processes that it started (by their pids), and removes each
scenario's profile.

- **`source`**: the event source. The same planned paths (`src/record.ts` `planMove`, sampled every 8 ms,
  so a 125 Hz mouse) go to three targets, first as real X input (XTEST: one `xdotool -` script for each
  path and its press, with no CDP session on the page), then as CDP `mouseMoved` events sent at 125 Hz with
  no wait for each answer: with a `timestamp` of the send time in whole ms, with a fractional `timestamp`,
  and with none. Last, two CDP moves to the point where the pointer already is.
- **`stage`**: vanilla Playwright (`playwright-core`, `connectOverCDP`) through a prototype of the design's
  input stage in the bridge. For the page's own session the prototype keeps one gate for each session and
  turns Playwright's input calls into a person's input: paths at 125 Hz with whole-ms timestamps, a pause
  and a press with held answers, a person's gap between the presses of a double click, keys with a person's
  holds and gaps, a Shift key for shifted characters, rollover by an early answer of a key release, typed
  keys for a short `Input.insertText`, wheel notches of 120 px, notches in place of
  `DOM.scrollIntoViewIfNeeded`, a click before Playwright's focus and fill utility calls, and the hover's
  path before Playwright's hit-target setup (or, in one step, after it: the naive way). It passes every
  other call. Frame sessions pass unchanged.

`analyze.ts` of the input research reads `results.json` (the same form as that research's runs). The probe
also writes `extra.json`: for each step Playwright's result and time, the stage's counts, the `pointermove`
and `mousemove` counts of the top page, the events whose time is later than their handler's time, the
client's hit-target setup calls, and how long the stage held each `Input` answer.

## How to run

On a Linux box with Xvfb, xdotool and Chromium, under the box's heavy-job lock:

```sh
npm ci
S=<a scratch folder>; (cd $S && npm init -y && npm install --ignore-scripts playwright-core@1.65.0)
flock <heavy.lock> timeout 1500 node docs/superpowers/specs/2026-11-10-vanilla-playwright-human-input-probe/probe.ts \
  --out-dir $S/out --playwright $S [--display 169] [--only source,stage]
node docs/research/2026-11-09-click-box-input-signals/analyze.ts $S/out/run-*/results.json --summary summary.json
```

## The results

Two runs, about 1.5 minutes each: run 1 at 02:15 UTC and run 2 at 02:33 UTC. Run 1's prototype had two
faults, which run 2's code (the code in this folder) fixed:

- its decoder of Playwright's serialized argument read numbers and strings as `{"n": ...}` and `{"s": ...}`;
  Playwright's `serializeAsCallArgument` sends them as plain JSON values. So run 1's hover recognizer never
  matched, and both of run 1's hovers went the naive way (a retry each);
- its events carried the send time as their `timestamp`, with no input latency; run 2's stage dates each
  event 3 to 5 ms before its send, and run 2's `source` scenario adds the form "4 ms before the send".

| File | What it holds |
| --- | --- |
| `results/run-2.json` | run 2's records, marks and CDP messages (the input of `analyze.ts`) |
| `results/run-2-summary.json` | `analyze.ts --summary` of run 2: the metrics of each step |
| `results/run-2-cdp.json` | `analyze.ts --traces` of run 2: the client's CDP calls of each step, with their times (long strings cut) |
| `results/run-2-extra.json` | the probe's own counts of run 2 (see above) |
| `results/run-1-summary.json`, `results/run-1-extra.json` | the same for run 1 (its raw records are not kept) |

The design's section 17 (M1 to M6) and its section 9.1 give the numbers. In short:

- **M1, the source.** On the same planned paths at 125 Hz, CDP with a whole-ms `timestamp` 4 ms before the
  send gave 1.73 to 1.86 samples per `pointermove` (XTEST: 1.87 to 1.97), 100% of the sample gaps on a whole
  millisecond (XTEST: 100%; a fractional `timestamp` or none: 2% to 8%), a frame phase of 5.4 to 5.6 ms
  (XTEST: 2.3 to 8.1 ms; the send time itself: 1.2 to 1.5 ms), and no event from the future. The mean count
  of predicted points stayed higher: 2.3 to 2.8 for every CDP form against 1.8 to 2.1 for XTEST.
- **M2.** A CDP move to the pointer's own point gives the page a `pointermove` and a `mousemove` with
  movement 0 (2 of 2, both runs).
- **M3.** Through the stage, 8 of 8 clicks in each run (a click, a check, a double click, a click in the
  cross-origin box, a click with Shift, the field's click before typing, a click below the fold, a click with
  a 3 s timeout) passed with one hit-target setup each, in 1.0 to 1.6 s (2.6 s with 17 notches of scroll).
  The stage held a click's answers until its events: the move 1.1 s, the press 1.2 to 1.3 s, the release 1.3
  to 1.4 s after the calls.
- **M4.** A hover with its path before Playwright's hit-target setup passed at the first try (0.58 s); with
  the path after the setup it needed a retry (1.16 s), and a page listener on the document got 73
  `pointermove` and 0 `mousemove` events.
- **M5.** `keyboard.type`, `pressSequentially` and `fill` (typed keys in place of `insertText`) gave the
  right text, holds with a median of about 100 to 113 ms, press-to-press medians of about 171 to 198 ms, a
  Shift `keydown` before every shifted character, the stage's focus click in place of Playwright's script
  focus, and rollover through an early answer of a release (overlaps in 3 of 20 and 1 of 20 keys of the fill).
- **M6.** `mouse.wheel(0, 600)` gave 5 notches of `deltaY` 120 and `wheelDeltaY` -120; the click below the
  fold scrolled by 17 notches, with no scroll that had no wheel.

The probe ended its own Xvfb and Chromium processes by their pids, and it removed each profile and its socket
folder.
