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
  the driver, also at a `kill -9`), or the driver's pid is gone.
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
that the harness does not give to `track()` is not recorded, and can outlive the harness.

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
- The agents' outer lock (`flock /home/selden/.cache/ab-lead/heavy.lock timeout 1200 <command>`, by
  hand, around a whole heavy job) is always the outer one. No harness takes it, so a process that holds
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
--dry-run`, whose `mac-standin.ts` is a child of it), `function-keys/check.ts` and `parity/probe.ts` on
Linux.

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
