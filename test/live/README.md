# Live harnesses: two rules

Every live, probe or dry-run harness here that starts Xvfb or Chromium on Linux follows two rules
(board ab-v16.78; taylor ran out of memory on 2026-11-06 with an orphan Xvfb and Chromium after a
`kill -9` of a driver, beside several heavy jobs at once). chrome-extension's `test/live/` follows
the same two rules with the same guard and the same lock file.

## 1. No orphans: nothing of a harness runs after its driver ends

A harness starts its guard, `harness_guard.py` (through `guard.ts`), before its first Xvfb or
Chromium. The guard is a process of its own, outside the driver's process tree and session, so a
`kill -9` of the driver, or a signal to its process group, does not reach it.

- While the driver runs, the guard records every process of the driver's tree every 0.5 s (pid and
  start time), and each process that the harness gives to `track()` at once (its Xvfb, its Chromium,
  the agent-mode run's tmux servers).
- The driver's end: the pipe from the driver to the guard closes (the kernel closes it at any end of
  the driver, also at a `kill -9`), or the driver's pid is gone.
- Then the guard sends SIGTERM to each recorded process that still runs with its recorded start time,
  and to their children; SIGKILL after 5 s; it waits until all are gone (at most 20 s), and names them
  on stderr. A pid that another process took since then is never signalled.

So after a `kill -9` of a driver, ps shows no Xvfb, Chromium, stand-in daemon, relay or proxy of that
harness within about 5 s (at most 20 s). `test/harness-guard.test.ts` checks it with stand-ins.

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
- This repository has no fuzz or mutation runner. The agents' runners outside it keep the manager's
  cap: at most 2 fuzz runs at once, each under heavy.lock.

## Which harnesses

The guard: `agent-mode/run.ts` (its own mode; the pointer group is part of it), `background-tabs/`
(`check.ts`, `visibility.ts`, `override.ts`), `anti-detect/` (`run.ts`, `extra.ts`, `mac.ts
--dry-run`, whose `mac-standin.ts` is a child of it), `function-keys/check.ts` and `parity/probe.ts` on
Linux.

No guard: the macOS checks (`takeover/`, `anti-detect/mac.ts` without `--dry-run`,
`function-keys/check.ts --on-my-screen`, `parity/probe.ts` on macOS): they run on the person's own
screen, with no Xvfb, and the guard is Linux only. `sheets.ts` starts no Xvfb and drives a running
agent browser. The agent-mode run's external mode starts no Xvfb or Chromium.

Environment: `HARNESS_LOCK_WAIT` (seconds), `HARNESS_LOCK` (another lock file: for the tests only).
