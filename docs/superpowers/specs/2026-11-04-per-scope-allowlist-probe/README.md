# The per-scope allowlist probe (2026-11-04)

This probe is the evidence for
[2026-11-04-per-scope-allowlist-design.md](../2026-11-04-per-scope-allowlist-design.md) (board task
ab-v16.23). It measures what the design depends on: DNR session rules with `condition.tabIds` per
scope, the opener of a popup, the race between a popup's first request and its rule, the retry, the
frame rule, the service-worker hole across two scopes and its guards, and the DNR limits. It is
probe code, not production code. Nothing in `src/` or `test/` uses it, and `npm test` does not run it.

## What it is

| File | What it does |
| --- | --- |
| `ext/` | A small probe extension (not the agent package). Static rules 1 and 3 of the agent package (`rules/`, copied); the design's scope rules as session rules (two per list, `tabIds` per list); a popup's scope from `webNavigation.onCreatedNavigationTarget` (or from `chrome.tabs`' `openerTabId`, to compare); the eager attach and the hold of a new tab (as the agent package does them, with Chrome's `openerId` read on the way); the retry; the guard at `onBeforeNavigate` or `onCommitted`; `onRuleMatchedDebug` to see which rule matched each request. The driver calls the functions of `P` in `ext/sw.js`. |
| `site.py` | Local test sites on 127.0.0.1 (default port 8795), routed by the Host header: `a.localhost` (scope A's list), `b.localhost` (scope B's list), `c.localhost` (on no list). Pages report what their own script sees (`history.length`, `window.opener`, `document.referrer`, whether a worker controls them) with a beacon; `/swreg` registers a service worker that answers every navigation itself; `/workers` starts a dedicated and a shared worker. The server keeps a request log in memory (host, path, query, method, the `Sec-Fetch-*` headers, `Cache-Control`, `Pragma`, whether a `Referer` came). |
| `probe.mjs` | The driver. It starts its own Xvfb (a free display from 150 up, `-nolisten tcp`, an auth file with a random cookie that never enters an argv), `site.py`, and its own Chromium with a throwaway profile and `--load-extension=ext`. It calls the extension's worker through a remote-debugging port of that Chromium only, runs the cases, writes `results/<case>.json` and stops what it started. |

The cases: `limits`, `rules`, `dnrfetch`, `frames`, `popups` (with `popupslate`), `retryheaders`,
`retrycontrol`, `sw`, `swscript`, `swpass`, `bfcache`, `restart`. Each one writes its own files in
`results/`. `site.py` serves three workers: one that makes each navigation's page itself (any host),
one that passes each navigation on with `fetch(event.request)` (`pass.<host>`), and one with
navigation preload (`pre.<host>`).

## How to run it

On a Linux box with Debian Chromium, Xvfb, Python 3 and Node 26 (no npm package is needed):

```sh
cd docs/superpowers/specs/2026-11-04-per-scope-allowlist-probe
TRIALS=10 RUN="$SCRATCH/run" node probe.mjs            # every case
TRIALS=5 RUN="$SCRATCH/run2" node probe.mjs popups sw   # some cases
```

`RUN` is a scratch folder for the profile, the HOME and the auth file (default: a new folder under
the system temp folder). `CHROMIUM` sets another Chromium, `SITE_PORT` another port. The probe
deletes nothing; remove the run folder by hand. Chromium writes `ext/_metadata/` (its indexed rules)
into the extension folder; it is not part of the probe.

It never starts or stops another Chrome, never contacts a real site and never uses the agent
package, its packed CRX or its key.

## The run of record

`results/` holds the runs of 2026-11-04 and 2026-11-05 on taylor (Chromium 156.0.8078.79,
`TRIALS=10`): every case once, then `limits` and `bfcache` again (with the `sets` measure and the
rule-1 match of Back), then `swpass` and `retryheaders` after the first review, and `retrycontrol`
after the second. The design's section 14 reads them.
