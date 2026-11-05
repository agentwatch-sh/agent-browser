# The probe of the orphan agent tabs design

The evidence of [2026-11-05-orphan-agent-tabs-design.md](../2026-11-05-orphan-agent-tabs-design.md) (board
task ab-v16.39). `probe.ts` is not part of `npm test`.

## What it runs

- Its own Xvfb (an auth file with one random MIT-MAGIC-COOKIE-1 entry, as the agent-mode live test) and
  its own Chromium with the unit's argv (agentwatch `daemon/browser/unit.py`: `--no-first-run`,
  `--no-default-browser-check`, `--password-store=basic`, `--load-extension`,
  `--silent-debugger-extension-api`, `--disable-backgrounding-occluded-windows`, `about:blank`). It stops
  only those, by the pids that it recorded (`results.json`: `pids`).
- A copy of the receiver `agent/` of a chrome-extension checkout, with chrome-extension's live-test
  native host (`test/live/host.py`). Part "worker" adds the `storage` permission to the copy (the
  receiver has none today); the key stays, so the ID stays.
- A stand-in daemon (as `test/live/agent-mode/daemon.ts`) that can drop its socket, restart the relay
  (standard input ends; the new relay gets the link-up line and the list again, as agentwatch's
  `announce()` and `_push_allowlist()`), write `end_scope`, and send its own bridge requests.
- The relay of this checkout (`bin/agent-browser.js relay`), and raw CDP clients over its socket.
- A site on `127.0.0.1` for `a.localhost` only, the one allowlisted host.
- Part "worker" only: `--remote-debugging-pipe` (no port), to read and stop the receiver's worker.

```sh
CHROME_EXTENSION=<a detached chrome-extension worktree> PART=today  RUN=<empty folder> node probe.ts
CHROME_EXTENSION=<...> PART=worker RUN=<empty folder> DISPLAY_N=138 PORT=8794 node probe.ts
CHROME_EXTENSION=<...> PART=ids    RUN=<empty folder> DISPLAY_N=139 PORT=8795 node probe.ts
```

## The runs of record

taylor (Debian 13), Chromium 156.0.8078.79, 2026-11-05. The receiver: chrome-extension main `27543ce`
(agent package 0.2.0, ID `ifhfjdmdbgbnmllffiadajepajbcdnai`). The relay: agent-browser main `b81dd4e`
(one window per page). `results/` holds each run's `results.json`.

| Run | Part | File |
| --- | --- | --- |
| today2, today3 | "today", two runs | `results/today2.json`, `results/today3.json` |
| ids1 | "ids" | `results/ids1.json` |
| worker4 | "worker": cases C, G and D | `results/worker4.json` |
| worker2, worker3 | "worker", earlier forms of case D (worker2: a 20 s wait; worker3: 10 s, then 15 s after a new `about:blank` tab); both ended there with "no link". Their case C counts. | `results/worker2.json`, `results/worker3.json` |

### Part "today"

| Case | What the probe does | Result (both runs) |
| --- | --- | --- |
| A | Scope s1 opens 2 pages, s2 one (`Target.createTarget`). The daemon side closes its socket for 3 s; the host retries every second and connects again. Then a new client of s1, then `end_scope` s1. | Both clients close with 1011. The 4 tabs stay, with the same ids and URLs, detached. The new s1 client: 0 targets from `Target.getTargets`, 0 `Target.targetCreated` after `setDiscoverTargets`. `end_scope` closes that client (1000) and no tab. From the drop to a ready relay: 4111 and 3105 ms. |
| A2 | Scope s5 opens a page. The probe ends the native host process (the probe's own Chromium's child). | The receiver connects again after 1108 and 1105 ms. The client closed with 1011; the tabs stay; a new s5 client sees 0 targets. |
| B | Scope s3 opens a page with `setAutoAttach`, then sends `Fetch.enable` (pattern `*b-fetch*`) and `Emulation.setUserAgentOverride` on it. The relay restarts with no link change. | The client closes with 1001. The tab stays open and attached (`debugger.getTargets`). A new s3 client sees 0 targets. In the tab, `fetch('/b-fetch')` gets no answer in 5 s, the site sees no request, the receiver sends 1 `Fetch.requestPaused` for the tab (the new relay drops it), and `navigator.userAgent` is still `probe-old-client`. `end_scope` s3 closes no tab. |
| F | Scope s4 opens a page; the probe closes every other tab; then `end_scope` s4. | Chromium ends, exit 0 (the relay's `tabs.remove` closed the last window). |
| E1 | Two pages of scope s9, then SIGTERM, then a start with the same profile. | Only the argv's `about:blank` opens; the site sees no request again. |
| E2 | The same with SIGKILL. | The same: only `about:blank`. Its tab id equals the killed run's first tab id. |
| E3 | `"session": {"restore_on_startup": 1}` in `Default/Preferences`, then as E1. | The two pages open again in new tabs with new ids, and load again (2 more requests). |

### Part "ids"

Ten browser runs: each makes 3 tabs, ends (5 by SIGKILL, 5 by SIGTERM), starts again and makes 1 tab.

| End | Runs whose new tabs repeat ids of the run before |
| --- | --- |
| SIGKILL | 4 of 5 (the first 2 tab ids; the first trial followed a clean exit) |
| SIGTERM | 0 of 5 |

So `chrome.storage.local`, keyed by tab id, could give a tab of a new run the scope of an old tab.

### Part "worker"

| Case | What the probe does | Result |
| --- | --- | --- |
| C | In the receiver's worker: a value in memory, `chrome.storage.session.set`, a session rule (id 900). Then `Target.closeTarget` on the worker; 10 s; then a new tab. | After the stop: no worker, the host's port closed, no connection in 10 s. After the new tab: the host connects 100 to 151 ms later (three runs: worker2, worker3, worker4). In the new worker: the memory value is gone; `storage.session` and session rule 900 stay; the dynamic rules 2, 4 and 5 stay; the tab ids are the same. |
| G | A value in the worker's memory; the probe detaches; 360 s with no event. | The worker still runs, the memory value is still there, and the host neither closed nor connected again. So with its native port open the receiver's worker does not stop when idle. |
| D | `storage.session`, `storage.local`, session rule 901; then `chrome.runtime.reload()` in the worker. | The receiver did not come back: no extension target in 10 s, none after a new page, no host connection (worker4; worker2 and worker3, with the earlier forms of the case, saw no host connection either). The profile's preferences then held the receiver with `disable_reasons` `[16777216]`. So whether `storage.session` stays over a reload is not measured. The receiver's code never calls `chrome.runtime.reload()`. |

## Not measured

The target itself (no code of the per-scope build exists yet); a real agentwatch daemon (the stand-in
writes the same lines); Google Chrome stable; the Mac.
