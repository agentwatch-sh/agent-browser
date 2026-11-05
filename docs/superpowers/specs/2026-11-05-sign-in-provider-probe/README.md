# The probe of the sign-in provider design

The evidence of [2026-11-05-sign-in-provider-design.md](../2026-11-05-sign-in-provider-design.md) (board task
ab-v16.45). No file here is part of `npm test`.

## What it runs

- `site.ts`: one HTTPS server on 127.0.0.1 for four fake hosts, with a certificate that the probe makes for each
  run (openssl, in the run folder). Chromium maps the names to 127.0.0.1 (`--host-resolver-rules`) and trusts that
  certificate only (`--ignore-certificate-errors-spki-list`). No real account and no real provider.
  - `site.test`: the listed site. An OIDC client (`/login` gives a 302 to the provider's `/authorize`; `/callback`
    sets `site_session` and goes to `/app`), a link that goes straight to the provider, a sign-in popup as
    auth0-spa-js opens it (`window.open("")`, then the popup's `location`, `prompt=select_account`,
    `response_mode=web_message`; the opener closes the popup at the message), a popup with `window.open(url)`, a
    hidden frame for the silent renew (`prompt=none`, `web_message`), a SAML service provider (an auto-submitted
    form POST to the provider; `/acs` takes the provider's POST), an open redirect (`/redirect?to=`), and a link to
    `other.test`.
  - `tenant.auth0.test`: the provider. `/authorize` answers at once with its session (`auth0_session`,
    `SameSite=None; Secure; HttpOnly`), else it sends the tab to `/u/login`, the "choose an account" page: a click
    on the account, a password typed, a click on Continue (a form POST, then a 303 to `/authorize` and a 302 back
    to the site). The page has links to `other.test` and `manage.auth0.test` and a frame from `other.test` (as a
    captcha). `/samlp/probe` takes the site's SAML POST and answers with a form POST to the site's `/acs`.
  - `manage.auth0.test`: a sibling host of the provider (an entry `auth0.test` covers it).
  - `other.test`: a host on no list.
- `common.ts`: the run folder, a private Xvfb (an auth file with one random MIT-MAGIC-COOKIE-1 entry, `-nolisten
  tcp`), and Chromium with the agent unit's argv (agentwatch `daemon/browser/unit.py`, as the agent-mode live
  test) plus the two flags above. It stops only the processes that it started, by the pids that it recorded
  (`results.json`: `pids`). It deletes nothing.
- Part "initiator" (`initiator.ts`, with `ext/`): a probe extension, not the agent package, in a Chromium with
  `--remote-debugging-pipe` (no port), so the probe can call the extension's worker. For 24 kinds of navigation it
  logs webRequest's `initiator` of each main-frame and frame request (also over redirects), the DNR rule that
  matched (`onRuleMatchedDebug`), the webNavigation transition, and the `chrome.debugger` Page events that the
  relay would see. It runs every kind under six rule sets: today's rules (C5 as agent package 0.2.0 writes them,
  rules 1 to 4 with the list `[site.test]`), the candidate rules of options a (two forms), b (two forms) and c.
  The typed URL uses xdotool on the probe's own display (ctrl+L, the URL, Return).
- Part "agent" (`agent.ts`): the receiver (`agent/` of a detached chrome-extension worktree of main `230f381`,
  agent package 0.2.0, copied and unchanged), chrome-extension's live-test native host (`test/live/host.py`), a
  stand-in daemon (as the orphan-tabs probe's) and the relay of this checkout (`bin/agent-browser.js relay`). The
  clients: Playwright 1.64.1 (`connectOverCDP` over the relay's socket) and agent-browser of this checkout with
  `--cdp-url`. Lists: L1 `[site.test]`, L2 `[site.test, tenant.auth0.test]` (option c), L3 `[site.test,
  auth0.test]`. The group "beam" sends C2 payloads through the receiver's `import` (C6).
- Part "plain" (`plain.ts`): agent-browser of this checkout without agent mode: no receiver, no relay. It drives
  the probe's own Chromium through its proxy (`--endpoint`); that Chromium has a debugging port on 127.0.0.1 in
  place of the operator's approval at chrome://inspect. The transport changes no guard of agent-browser.
- Part "cookies" (`cookies.ts`): the probe extension signs in at the provider at the top level, then runs the
  site's silent renew in a frame, with Chromium's default settings and with each way that an extension can allow
  the provider's cookie in a frame.
- `tables.ts`: the tables of the design's section 4 from `results/initiator.json`.
- `review-53-extra.ts` (ab-lead's fresh reviewer, review-53): navigations to the provider from a `data:` page, from
  an `about:blank` tab and window that the extension made, a `meta` refresh, a sandboxed frame's top navigation,
  the retry's `chrome.tabs.reload` of a blocked popup, and the content setting patterns of choice 2. review-53 ran
  it from its own worktree of this folder; the copy here takes the folder from its own path, and nothing else
  differs.

```sh
RUN=<empty folder> node initiator.ts                       # REPS=2: 3 trials of each kind under today's rules, 2 under each other set
CHROME_EXTENSION=<a detached chrome-extension worktree> PLAYWRIGHT=<a folder with node_modules/playwright-core@1.64.1> \
  RUN=<empty folder> DISPLAY_N=146 PORT=8462 node agent.ts  # CASES=pw,ab,beam
RUN=<empty folder> DISPLAY_N=148 PORT=8464 DEBUG_PORT=9462 node plain.ts
RUN=<empty folder> DISPLAY_N=147 PORT=8463 node cookies.ts
node tables.ts results/initiator.json
RUN=<empty folder> DISPLAY_N=... PORT=... node review-53-extra.ts
```

## The runs of record

taylor (Debian 13), Debian Chromium 156.0.8078.79 (the agent unit's `/usr/bin/chromium`), 2026-11-05.
agent-browser: this branch from main `87be973`. The receiver: chrome-extension main `230f381` (agent package 0.2.0,
ID `ifhfjdmdbgbnmllffiadajepajbcdnai`). `results/` holds each run's `results.json`.

| Run | Part | File |
| --- | --- | --- |
| initiator1 | "initiator", 24 kinds, 6 rule sets (its copy of `ext/` had no `privacy` and `contentSettings` permissions and no helpers of part "cookies" yet; nothing else differs) | `results/initiator.json` |
| agent1 | "agent", groups pw, ab, beam (its beam group had restore tabs that started sign-ins; see beam2) | `results/agent.json` |
| beam2 | "agent", group beam, with sign-out pages as the imports' `url` | `results/beam.json` |
| ab4 | "agent", group ab, with tab names that match no URL | `results/ab.json` |
| plain6 | "plain", with tab names that match no URL, and every page closed before each list | `results/plain.json` |
| cookies1 | "cookies" | `results/cookies.json` |
| review-53 extra1 | `review-53-extra.ts`, one trial of each case (review-53 also ran parts "initiator" and "cookies" again, with the same results) | `results/review-53-extra.json` |

Earlier runs (smoke runs, agent1's beam and ab groups, plain1 to plain5) found the probe's own mistakes: an
import's restore tab that went to `/app` and signed the site in again, an agent-browser tab name (`s`) that matched
other tabs by URL substring, a popup of the list before that matched the popup's URL substring, and the wait for the
debugging port. Their results are not used.

## Not measured

Google Chrome stable (agentwatch's stage 4 step C moves the agent unit to it; aw-lead checks its third-party cookie
default in step C's live run); a person's click (the probe's clicks are CDP clicks); the Mac; a real provider (Auth0, Okta, Google, Microsoft) and its own scripts, captchas and
bot checks; FedCM and the Storage Access API; a provider's service worker; the per-scope build itself (no code of
it exists yet: the candidate rules of part "initiator" have no `tabIds`).
