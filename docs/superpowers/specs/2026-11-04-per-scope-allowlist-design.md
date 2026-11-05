# Per-scope allowlists in agent mode — design

Date: 2026-11-04. Status: **DRAFT for review.** Author: taylor session `allowlist`, a subagent of
`ab-lead` (board task ab-v16.23, under goal ab-v16). Branch `ab-v16.23-per-scope-allowlist` in
agent-browser and in chrome-extension. Evidence: the probe in
[2026-11-04-per-scope-allowlist-probe/](2026-11-04-per-scope-allowlist-probe/README.md), run on
taylor with Debian Chromium 156.0.8078.79 in a private Xvfb.

This design builds on the two-modes design
([2026-11-03-two-modes-playwright-design.md](2026-11-03-two-modes-playwright-design.md), sections 4,
7, 8, 10 to 13) and on the contracts C4, C5, C10 and C11 in chrome-extension `docs/protocol.md`
(main `7e36332`; since board task ab-v16.24 that file is the master for C1 and C5 too). The contract text of the target is in that file, on the chrome-extension branch of
the same name, in blocks marked "Target (board ab-v16.23)" in C4, C5, C6, C10 and C11. No code
changes in this task.

## 1. The answer in short

The operator (agentwatch board, through aw-lead, 2026-11-04): "ideally i can give each repo its own
allowlist." agentwatch keeps a list per repo and edits it in its web viewer (aw-lead's part). Each
decision below has its reason in the section that the line names.

1. **The block (section 4).** DNR session rules with `condition.tabIds`: per list, one `allow` rule
   for main frames (`requestDomains` = the list) and one for frames (`topDomains` = the list), each
   for the tabs of the scopes that use the list. Static rules 1 and 3 stay; dynamic rules 2 and 4
   go. A tab of no scope matches no allow rule, so it fails closed.
2. **A tab's scope (section 5).** The receiver keeps the scope of each tab. A tab that the relay
   opens gets its scope as an argument of `tabs.create` or `windows.create`, and its rule is in force
   before the answer. A popup takes its opener's scope from `webNavigation.onCreatedNavigationTarget`
   (`sourceTabId`), never from `chrome.tabs`' `openerTabId`. The receiver reports each popup's scope
   to the relay in a new event, `bridge.tabScope`, and the relay never puts a tab in a scope that the
   receiver did not report.
3. **The race (section 5).** DNR decides before the hold's `Fetch` pause, so a rule must be in force
   before a request starts. A popup whose first request comes before its rule fails closed. The
   receiver then reloads it once when the rule is in force (the retry). A `noopener` popup always
   needs the retry; a popup with an opener needs it rarely. The site sees one request, with
   `Cache-Control: max-age=0` more than a normal popup sends. A form that posts into a new tab fails
   closed.
4. **The service-worker hole (section 6).** Measured: a worker of a scope-A site serves its page in
   a scope-B tab, a page that it makes or one that it passes on from the network, and DNR sees
   neither. In its own scope no worker breaks. The guard: the relay refuses a client's navigation to a host off
   the scope's list; the receiver sends a tab to `about:blank` at `onBeforeNavigate` and at
   `onCommitted` of an off-list page. The guard is not a full block. A full block (no service
   workers in the agent browser) is a choice for the operator (section 13, choice 2).
5. **A list loses a site (section 7).** Only the tabs whose own list no longer covers their host
   close. The receiver removes every service worker when a scope's list loses an entry. The
   back/forward-cache limit stays; the guard covers a restore that Chrome reports.
6. **The messages (section 8).** The daemon sends `set_scopes` (lists by name, the list of each
   scope, a default list) in place of `set_allowlist`. The relay gets the same object in its
   `allowlist` line, is ready per scope, refuses per scope, and grants content settings per scope.
   Session rules go at a browser restart or an extension reload: the start fails closed.
7. **The scope is advisory (section 9).** The per-repo list keeps an honest agent and a page inside
   its repo's sites. It does not stop a process that connects with another session's scope. A scope
   token per session is a choice for the operator (section 13, choice 1). Section 13 holds six
   choices: the token, service workers, the operator's own tabs, the retry, the default list, and
   which list a sent site joins.
8. **One profile (section 10).** The operator-mode send stays one profile. A sent site's cookies are
   in the profile for every scope. Only navigation is guarded.

## 2. Words

- A **scope** is the name in the endpoint path (`/devtools/browser/<scope>`), today the agentwatch
  session's name (C11).
- A **list** is a named allowlist, for example one repo's list. Several scopes can use one list.
- A **tab's list** is the list of its scope. A tab of no scope has no list.
- A **scope rule** is one of the two session rules of a list (main frames, frames).
- The **receiver** is the agent package (`agent/` in chrome-extension). The **relay** is
  agent-browser's `agent-browser relay` (C11). The **daemon** is agentwatch's daemon.

## 3. What changes, from today

Today (C5): one list for the whole agent browser. Static rule 1 blocks every main frame; dynamic rule
2 allows the list. Static rule 3 blocks every frame and `<object>`/`<embed>`; dynamic rule 4 allows
them under a top-level page on the list. Dynamic rule 5 sets `Sec-Fetch-Site: none` on the
navigations that the receiver starts. The relay knows each tab's scope, but the block does not.

The target: each tab is blocked by its own list. The relay's scope becomes a part of the block. The
receiver, which runs the block, keeps the tab-to-scope map, because only the receiver sees a new tab
early enough (section 5).

## 4. Where the per-scope block lives (question 1)

**Decision: DNR session rules with `condition.tabIds`, two per list.**

| Rule | Kind | Id | Priority | Action | Condition |
| --- | --- | --- | --- | --- | --- |
| 1 | static, stays | 1 | 1 | block | `resourceTypes: ["main_frame"]` |
| 3 | static, stays | 3 | 1 | block | `resourceTypes: ["sub_frame", "object"]` |
| 5 | dynamic, stays | 5 | 3 | `modifyHeaders` (C5) | as today |
| main frames of list L | session | 100 and up | 2 | allow | `requestDomains` = L, `resourceTypes: ["main_frame"]`, `tabIds` = the tabs of every scope whose list is L |
| frames of list L | session | the next id | 2 | allow | `topDomains` = L, `resourceTypes: ["sub_frame", "object"]`, `tabIds` = the same tabs |
| the import's restore tab, main frame | session | 6 | 2 | allow | `requestDomains` = [the sent `domain`], `resourceTypes: ["main_frame"]`, `tabIds` = [the restore tab], during the import (section 8.6) |
| the import's restore tab, frames | session | 7 | 2 | allow | `topDomains` = [the sent `domain`], `resourceTypes: ["sub_frame", "object"]`, the same `tabIds`, the same time |

- A list with no tab, or with no entry, has no rule: the session-rule API refuses an empty `tabIds`,
  and an empty list allows nothing.
- Dynamic rules 2 and 4 go. With them, every tab would get the union of the lists. An older package
  leaves them in the profile (measured: dynamic rules stay after a browser restart, session rules do
  not), so the receiver removes ids 2 and 4 at each start and at each `set_scopes`.
- Each change is one `updateSessionRules` call, and the changes run one after the other. A
  `set_scopes` replaces every scope rule. A tab that joins or leaves a list replaces only that list's
  two rules (a tab that changes lists, only the two lists' rules). So no moment exists in which a
  tab has the rules of two lists, or a list has a rule without its frame rule.
- A failed update fails closed. When `updateSessionRules` fails (the rule limit, a Chrome error),
  the receiver removes every scope rule with a remove-only call and keeps its map: every tab of a
  scope is then blocked until the next update that succeeds, and that next update is a full replace
  from the map (not only one list's rules). A failed `set_scopes` answers `ok: false` after the tabs
  close (the closing rule runs with the new lists). A failed `tabs.create` or `windows.create`
  closes its new tab and answers with the error. If the remove-only call fails too, old rules can
  stay in force: the guard (section 6) still judges each navigation by the new lists of the map, the
  closing rule still closes the tabs off their new list, and every later change is a full replace
  until one succeeds.
- Rule 5 stays dynamic and global: it names no list. Measured: with a session allow rule at
  priority 2, rule 5 at priority 3 still sets `Sec-Fetch-Site: none` on a `Page.navigate` (20 of 20).

**Why.** DNR acts in Chrome's network stack before the request leaves, whatever the client or the
page does. `tabIds` is the only DNR condition that names a tab, and it exists only for session
rules. Allow rules per tab fail closed: a tab that the receiver has not put under a rule yet is
blocked by rule 1, not allowed.

**Measured** (results/rules.json, frames.json, limits.json):

- A tab that gets its scope at `about:blank`, and then a `Page.navigate`: its own list loaded 20 of
  20 (a subdomain of an entry too, 20 of 20); the other scope's host was blocked by rule 1 20 of 20
  and got no request; a tab of no scope was blocked 20 of 20.
- One assignment in the probe (a tab joins its scope; the probe replaces all its 2 to 4 scope rules
  and waits for the call) took 11 to 15 ms, median 13 ms, with small lists and the probe's tabs open.
  The `limits` case measures the index cost alone (no open tab under the rules): 0 to 1 ms for the
  same lists. Not found: which part of Chrome's work takes the other 10 ms.
- Frames: under a scope-A page a frame of an off-list host loads (O11 stays); under `about:blank` of
  a scope-A tab and of a tab of no scope it is blocked by rule 3. The frame of a worker's page in a
  scope-B tab (section 6) was blocked 20 of 20: B's frame rule does not cover A's host.

**The other ways, and why not:**

- *One union allow rule plus per-scope block rules with `tabIds`.* A tab that has no rule yet (a new
  popup) gets the union: it fails open. Rejected.
- *One union allow rule plus a check in the receiver (`webNavigation.onBeforeNavigate`).* An
  extension cannot stop a request from an event; the request leaves before the receiver acts.
  Rejected as the block. Kept as the guard for navigations with no request (section 6).
- *A check in the relay only* (refuse `Page.navigate` off the scope's list). It sees only the
  client's navigations, not links, redirects, page scripts or popups. Kept as a second layer
  (section 6), not as the block.
- *A rule that allows a new tab by its initiator* (`initiatorDomains` = L with `excludedTabIds` =
  the known tabs). A scope-B page on a host that is on both lists could open a popup to a host on A's
  list only, and its first request would reach that host with its cookies. Rejected.
- *One Chrome profile (or one Chrome) per repo.* Real isolation of cookies, workers and content
  settings, but one extension load, one send target and one native link per profile. It changes the
  operator-mode send and the agentwatch unit. Out of scope here; section 10 states what one profile
  shares.

**The limits** (measured, Chromium 156): `MAX_NUMBER_OF_SESSION_RULES` = 5000 (5000 rules added;
the 5001st refused with "Session rule count exceeded."); `MAX_NUMBER_OF_UNSAFE_SESSION_RULES` = 5000
(the design has no unsafe session rule). One rule took 100,000 hosts (added in 228 ms) and 10,000 tab
ids. At two rules per list, about 2,490 lists can be in use at once.

The cost that matters is the time of one assignment (a tab joins a list: that list's two rules are
replaced), because a relay's new tab waits for it and it decides how often a popup needs the retry.
Chrome indexes all session rules again at each update, so the time grows with the entries of all
lists in use, not with the one list (results/limits.json, `sets`: the index cost, with no open tab
under the rules):

| Lists in use | Entries per list | One assignment (replace one list's two rules, 5 times) | `set_scopes` (add every rule, once) |
| --- | --- | --- | --- |
| 2 | 10 | 0 to 1 ms | 1 ms |
| 20 | 100 | 5 to 6 ms | 10 ms |
| 20 | 1,000 | 45 to 48 ms | 78 ms |
| 100 | 1,000 | 234 to 256 ms | 386 ms |
| 2,400 | 10 | 118 to 145 ms | 241 ms |

So a box with tens of repos and lists of tens to hundreds of hosts stays near 5 ms. Lists of
thousands of hosts make more popups need the retry (section 5.2).

## 5. A tab gets its scope before its first navigation (question 2)

**The receiver keeps the tab-to-scope map.** It sets a tab's scope in these cases, and in no other:

| Tab | Who names the scope | When the rule is in force |
| --- | --- | --- |
| A tab that the relay opens (`Target.createTarget`) | The relay: a new required arg of `tabs.create` and `windows.create` | Before the op answers; the tab is still at `about:blank`, which makes no request |
| A popup (`window.open`, `target=_blank`, `rel=opener`, `noopener`, a form with a target) | The receiver: the scope of `sourceTabId` in `webNavigation.onCreatedNavigationTarget` | 2 to 47 ms after that event (section 5.2) |
| A tab that replaces another (`tabs.onReplaced`) | The receiver: the removed tab's scope | After its rule update |
| Any other tab (the operator's live-view tab, the restore tab, a tab from before the link) | Nobody | Never: the tab fails closed |

- The relay creates a tab only at `about:blank` (it does so today, C11), so `newTab.url` and
  `newWindow.url` become `about:blank` only. With one window per page (agent-browser PR #43) the
  relay opens each page with `windows.create`, which takes the scope arg the same way. If that build
  also moves a popup into a window of its own (`windows.create` with a `tabId`), the move takes no
  `url`, the scope arg must be the moved tab's own scope (else `bad args`), and the tab keeps its
  scope and rules.
- The receiver puts a popup's scope in its map in the event handler itself, before it calls
  `updateSessionRules`, so the guard of section 6 and the retry judge the popup by its scope at once.
- The receiver reports each scope that it sets itself (popups, replaced tabs) with a new bridge event,
  `bridge.tabScope` (`"tabId"`, `"scope"`), and gets a row in C10's event table. For a popup it
  comes before the popup's `tabs.onCreated` (the navigation-target event comes before the eager
  attach ends; with the eager attach off, the receiver sends `tabs.onCreated` after that event, or
  after 50 ms when none comes). The relay takes a tab that it did not create into a scope
  only on that event. The reason: the receiver enforces the scope. If the relay computed a popup's
  scope itself and got another answer, a client of one scope would drive a tab under another scope's
  list.
- An argument of `tabs.create`, not a separate op: with an op, a tab would exist for a moment with no
  scope while the relay knows it, and the relay would have to wait for the op's answer before each
  navigation. The argument makes the scope a part of the tab's creation.
- The relay keeps Chrome's `openerId` for the popup's **owner** (C11: the owner of the opener takes
  the popup), only when the opener is in the same scope.
- At each link change and at its worker's start the receiver forgets every tab's scope and removes
  every session rule (rules 6 and 7 too, at the worker's start). The relay forgets its tabs at a link
  change too (C11). So a tab from before the link is in no scope on both sides, and fails closed.
- The map takes no stale entry. The receiver writes a popup's scope only while the tab exists, and
  drops a write that an op started before a reset (the epoch check that `attach.js` uses for its
  attaches).

### 5.1 Which source names the opener

Measured (results/popups-*.json, 440 popups in the run of record): `sourceTabId` named the right opener in every popup of
every kind, also with the opener in the background behind a tab of another scope. Chrome's
`openerId` (the relay's source today, read with `Target.getTargetInfo` on the attached popup) was
right in every held popup too (120 of 120, `noopener` popups included). `chrome.tabs`'
`openerTabId` named the active tab: with the opener in the background it was wrong in every trial
(0 of 190), and it named the tab of the other scope. Measured with `openerTabId` as the source
(results/popups-tabs.json): such a popup got the other scope and was blocked 10 of 10. A design that
used `openerTabId` would put a popup of scope A under scope B's list. The control with no
inheritance (results/popups-none.json): every popup was blocked (20 of 20), so a popup of no scope
fails closed.

### 5.2 The race, and the retry

**DNR decides before the hold.** Measured (results/dnrfetch.json): a tab with no rule and the hold's
`Fetch` pattern on; a `Page.navigate`; then the rule; then the release. The request was blocked by
rule 1 at once in 10 of 10 trials and was never paused. So the hold cannot give the receiver time to
add a rule for a request that already started. The rule must be in force before the request starts.

**A popup's first request** starts a few ms after Chrome creates the tab. Measured, with the scope
set in `webNavigation.onCreatedNavigationTarget` (the event comes 0 to 1 ms after `tabs.onCreated`),
small lists, 20 popups of each kind in each run (10 with the opener in front, 10 behind a tab of the
other scope); times from that event (results/popups-nav.json, popups-nav-hold.json):

| Kind | First request allowed, no hold | First request allowed, with the eager attach and the hold | The rule in force | DNR saw the first request |
| --- | --- | --- | --- | --- |
| `window.open(url)` | 19 of 20 | 20 of 20 | 4 to 39 ms, median 5 | 9 to 35 ms, median 12 to 21 |
| `window.open("")`, then the opener sets its `location` (the sign-in pattern) | 20 of 20 | 20 of 20 | 2 to 20 ms, median 5 | 17 to 48 ms, median 23 to 26 |
| `<a target=_blank rel=opener>` | 20 of 20 | 18 of 20 | 2 to 14 ms, median 3.5 to 5 | 10 to 27 ms, median 14 |
| `window.open(url, "_blank", "noopener")` | 0 of 20 | 0 of 20 | 15 to 47 ms, median 19 to 22 | 8 to 21 ms, median 9 to 10 |
| `<a target=_blank>` (`noopener` by default) | 0 of 20 | 0 of 20 | 15 to 38 ms, median 20 to 23 | 8 to 16 ms, median 9 |
| `<form target=_blank method=post>` | 0 of 20 | 0 of 20 | 14 to 44 ms, median 21 to 22 | 7 to 19 ms, median 9 to 10 |

The "rule in force" and "DNR saw" times are the times at which the extension got the answer and the
`onRuleMatchedDebug` event; the order of the two is what matters.

A `noopener` popup starts in a new process: its request leaves about 10 ms after the event, and the
rule comes later. A popup with an opener starts in the opener's process: its request leaves later,
and the rule wins nearly always.

**The retry.** The trigger, exactly: the tab's first main-frame `webNavigation.onErrorOccurred` with
`net::ERR_BLOCKED_BY_CLIENT`, whose URL's host the tab's list covers when the rule update that put
the tab under its list ends. (A covered host can only be blocked when its rule was late.) The
receiver then calls `tabs.reload` once, at the later of the end of that rule update and the error
event plus 50 ms (so the error page has committed). A blocked request never left Chrome, so the
site sees one request. The `blocked` notice of the first request waits for this decision: none for
a retried request; one when the list does not cover the host or the tab gets no scope. Measured (results/popups-nav-retry.json,
popups-late-retry.json, popups-form-retry.json):

- `noopener` popups and `target=_blank` links: 40 of 40 loaded after the retry, each with one GET at
  the site. The page saw `history.length` 1, no `window.opener` (as a `noopener` popup always has),
  and its `document.referrer`. The retried request reached the site 62 to 95 ms (median 70) after
  the block, 86 to 139 ms after the click (a popup with no retry: 27 to 73 ms).
- Popups with an opener (`window.open`, `rel=opener`), with the rule made late on purpose (40 ms):
  20 of 20 loaded after the retry, with `window.opener` (a sign-in popup can still post back to its
  opener), `history.length` 1 and the referrer. In the run with the retry and no delay, the one
  sign-in-pattern popup that missed its first request loaded after the retry too.
- A form POST into a new tab: the retry did not load it (0 of 40): Chrome does not send a POST again
  on a reload without a prompt. Such a form fails closed (section 11).
- What the site sees of the retry (results/retry-control.json, with rule 5 on): the control is a
  `target=_blank` popup that loaded at once under an allow rule with no `tabIds` (as today's rule
  2). The retried `target=_blank` popup's request has the same `Sec-Fetch-Site` (`same-origin`),
  `Sec-Fetch-User` (`?1`), `Sec-Fetch-Mode`, `Sec-Fetch-Dest` and `Referer` as the control (10 of
  10 each), and one header more: `Cache-Control: max-age=0` (10 of 10), as on any reload. The first
  runs (results/popups-retry-*.json, rule 5 off) gave the same for `noopener` popups. The headers
  differ by the kind of popup: the sign-in pattern (`window.open("")`, then the opener sets
  `location`) sends no `Sec-Fetch-User` when it needs no retry (results/popups-nav.json: 20 of 20),
  and a retried one sends `Sec-Fetch-User: ?1` and `Cache-Control: max-age=0` (ab-lead's reviewer,
  review-42). A retry with `tabs.update(url)` in place of the reload was worse: no
  `Referer`, `Sec-Fetch-Site: cross-site`, no `Sec-Fetch-User`, and `history.length` 2. So the retry
  is a reload. A one-shot session rule that removes `Cache-Control` from the retried request did
  not remove it (20 of 20, ab-lead's reviewer). So the retry stays visible to a site that compares
  a popup's first request with a normal one: an operator choice (section 13, choice 4).
- The retry runs once per tab and only for a host that the tab's list covers. A tab of no scope
  never gets one. The receiver sends no `blocked` notice for a first request that it retries; it
  sends one when the rule is in force and does not cover the host, when the tab gets no scope, and
  when the retried request is blocked again (no second retry).

**How often a popup with an opener needs the retry** depends on the load of the box. In this
probe: 1 of 60 with no hold, 2 of 60 with the hold (the table above). ab-lead's reviewer (review-42,
the same probe) measured more: 3 to 4 of 20 with the hold, 2 of 10 for the sign-in pattern, and 8
of 10 with one window per page (agent-browser PR #43) and the opener behind another window. The
time of one assignment also grows with the tabs open under the rules: median 9 ms with none, 13 ms
with 50, 25 ms with 100 (the reviewer). So the retry is a normal path, not a rare one.

**What a client sees.** The eager attach and the hold (C10) stay. A popup that needs the retry shows
Chrome's error page for about 60 to 100 ms, then the retry's request. The hold keeps that request
until the client's `Runtime.runIfWaitingForDebugger`, while the hold is still on (it ends by itself
after `HOLD_MAX_MS` = 5 s; the retry comes about 70 ms after the block). **Decision:** while the
eager attach is on, the receiver also holds a popup's `tabs.onCreated` event until the popup's
first request is allowed or the retry's request is in the hold. So a client attaches to a popup
whose real document is still to come, and never takes Chrome's error page for the popup's page.
This is a part of the build (part 1b, section 12), not a later fix. Not measured with Playwright:
how `waitForEvent("popup")` and `waitForLoadState()` behave on such a popup; the build's live test
runs the popup kinds many times through Playwright and the MCP.

## 6. The service-worker hole (question 3)

**Measured: the hole exists across scopes** (results/sw-hole.json). Scope A's tab opened a page of
`a.localhost` that registers a worker for the whole host. Then a scope-B tab (list: `b.localhost`)
navigated to `a.localhost`, by a client's `Page.navigate` and by a page script. In 20 of 20 trials the
page committed in the scope-B tab (27 to 43 ms after the navigation started) with no network request
and no DNR match, and the worker's page ran its script (its beacon reached the site 62 to 87 ms after
the navigation started). The frame inside the worker's page was blocked (B's frame rule, 0 of 20
reached the site). DNR cannot see a navigation that a worker answers.

**Workers that pass a navigation on** (results/sw-pass.json, 5 trials each). Many real workers answer
a navigation with `fetch(event.request)`; some use navigation preload. Measured on `pass.a.localhost`
and `pre.a.localhost` (both on A's list):

| Worker | In a scope-A tab (its own scope) | In a scope-B tab |
| --- | --- | --- |
| `respondWith(fetch(event.request))` | Loaded 5 of 5; DNR matched no rule (the worker's request is not a `main_frame` request of the tab) | Loaded 5 of 5: the page came from the network, through the worker, with A's cookies; DNR matched no rule |
| Navigation preload, `respondWith(preloadResponse)`, no fall-back to `fetch()` | Loaded 5 of 5; the preload request is a `main_frame` request of the tab, allowed by A's rule | Blocked 5 of 5 by rule 1 (`net::ERR_FAILED` in the tab) |

So no site breaks in its own scope: the per-scope rules need no rule for the requests of no tab (a
candidate rule for them, `tabIds: [-1]`, changed nothing). But the hole has two forms across scopes:
a page that the worker makes, and a page from the network that the worker passes on. For the second
form the guard stops the page, not the request: with both receiver layers on, no page committed in
the scope-B tab (0 of 10), but the worker's request reached the site in 10 of 10, with scope A's
site's cookies, and the answer came back to the worker (ab-lead's reviewer). A page of scope B can
so make A's site act on one navigation request with A's sign-in (a GET, as for a link). Navigation
preload alone is blocked; a worker that falls back to `fetch()` after a failed preload (as Workbox
does) loads the page in the pass-on form (not measured).

The hole matters because the worker's page is a first-party page of A's site in B's tab: its
same-site requests carry all of A's cookies, and its storage is A's storage. B's client can read
that page while it lives.

**The guards measured:**

| Guard | Result | What a site can see |
| --- | --- | --- |
| The receiver sends the tab to `about:blank` at `onCommitted` | The worker's page committed and its script ran in 20 of 20; `tabs.update` answered 50 to 75 ms after the navigation started | Its page unloads at once |
| The receiver closes the tab at `onCommitted` | The same, 20 of 20; `tabs.remove` answered 59 to 137 ms after the start | The same |
| The receiver sends the tab to `about:blank` at `onBeforeNavigate` | A page script's navigation: stopped before its commit in 10 of 10. A client's `Page.navigate`: stopped in 0 of 10; all 10 committed and ran. (An earlier run of 5 trials each: 5 of 5 and 1 of 5.) | Nothing (no request, no page) when it wins |
| The relay refuses a client's navigation to a host off the scope's list (design, not measured) | The client's navigation never reaches Chrome | Nothing |
| A session rule that blocks the scripts of requests of no tab (`tabIds: [-1]`, `resourceTypes: ["script"]`) | Registration failed (`TypeError`); dedicated and shared workers still started (results/sw-script.json) | `navigator.serviceWorker.register()` fails, as with an ad blocker that blocks a worker script |
| The worker removal of C5 at each change of a list | Removes the workers that exist; a site registers its worker again on its next visit | A site's worker is gone after a list change |

**Decision (the default, the operator can choose otherwise in section 13, choice 2): keep service
workers, and guard in three layers.**

1. The relay refuses a main-frame `Page.navigate` (no `frameId`, or the `frameId` of the tab's own
   target, which Playwright's `goto` sends) and `Target.createTarget` with a URL, when the URL's host
   (for a `blob:` URL, its inner origin's host) is off the connection's scope's list: `Not allowed:
   <host> is not on the allowlist` (the C11 text that `Browser.grantPermissions` uses today). A
   frame's navigation is not refused (O11). So an agent's own `goto` never reaches a worker of
   another scope's site. It also gives the agent a clear error in place of Chrome's error page.
   Other client actions still navigate as the page does (`Runtime.evaluate`, input on a link,
   `Page.reload`, `Page.navigateToHistoryEntry`): layers 2 and 3 and DNR cover them.
2. The receiver, at `webNavigation.onBeforeNavigate` of a main frame whose `http:`/`https:` host the
   tab's list does not cover (for a tab of no scope: the union of the lists; for the restore tab:
   its `domain`), sends the tab to `about:blank` (`tabs.update`) and sends `blocked`. That stops a
   page's own navigation (a link, a script) before a worker can answer, when the receiver wins. For
   a `blob:` URL the host is its inner origin's host.
3. The receiver does the same at `webNavigation.onCommitted` of such a page: a worker's page that
   won the race, a redirect from a host of the list to a worker's host (a redirect fires no new
   `onBeforeNavigate`), or a page from the back/forward cache (section 7), leaves the tab at once.
- One navigation sends at most one `blocked` notice (the guard and `onErrorOccurred` can both see
  it). The probe measured each layer alone, not the two receiver layers together, and it measured a
  tab of no scope with no list, not with the union.

**Why not the full block now.** It closes the hole, but every site in the agent browser then fails
to register a service worker. Sites lose offline pages and push, and a site that tests for a worker
sees the failure, which is rare in real Chrome. The operator's top goal is that a site sees nothing
unusual (two-modes design, section 7). And the scope is advisory (section 9): a session that wants
another repo's sites can name that repo's scope. So the guard closes the hole for an honest agent
and for a page's own links, at no cost to sites; the full block is the operator's choice.

**What the guard leaves open:** a page's navigation that the receiver does not win at
`onBeforeNavigate` commits; the worker's page then runs its scripts for some tens of ms before the
receiver sends the tab away, and a client attached to the tab can read it during that time. And a
worker that passes navigations on sends each such navigation to its site with the site's cookies,
also when the guard stops the page.

## 7. When a scope's list loses a site (question 4)

- **Which tabs close.** At each `set_scopes` the receiver closes every tab whose `http:`/`https:`
  host its own list does not cover: for a tab of a scope, the scope's list (after `scopes` and
  `default`); for a tab of no scope, the union of the lists (so a page of a finished import and an
  operator's tab stay while some list covers them); the restore tab of a running import is never
  closed (C6). A tab of another scope on the same host stays when its own list covers the host. The
  about:blank guard of C5 changes: with one window per page (agent-browser PR #43, the relay's
  `Target.createTarget` opens a window for each page), replacing the last tab of every window would
  leave an `about:blank` window for each closed page. So the receiver lets a window close with its
  last tab, and keeps only the browser's last window (an `about:blank` tab there), so that Chrome
  does not end.
- **The worker removal.** The receiver calls `browsingData.remove({}, {serviceWorkers: true})`
  after the rule update and before the tabs close, when a scope that has a list in the last and in
  the new `set_scopes` lost an entry, and at the first `set_scopes` after its worker starts. A scope
  whose new list is none (an ended session's `null`, a list that is gone) does not remove the
  workers: its tabs are blocked and close, so no tab of it can reach a worker. Else every session's
  end would remove every site's workers. "Lost an entry" compares the entries (after `scopes` and `default`), not the list names;
  "the last" is the last `set_scopes` that applied in full. A new scope, or a scope that leaves the map, does not remove the workers. The removal is
  coarse (every site's workers go), as today.
- **The back/forward cache.** A page in the cache comes back with no request, so DNR does not block
  it. In the probe, Back after a list change started a network navigation, and rule 1 blocked it
  (`net::ERR_BLOCKED_BY_CLIENT`, 6 of 6, no request reached the site); the probe's pages did not
  enter the cache (its tabs had `chrome.debugger` attached), so a restore from the cache was not
  measured; that `chrome.debugger` kept them out is a guess. The guard of section 6 (layer 3) sends a tab to `about:blank` when Chrome reports the restore with
  `webNavigation.onCommitted`. Whether Chrome reports every restore there is not measured. This stays
  a stated limit, as in C5.
- **The relay.** At each `allowlist` line, the relay rebuilds the content settings (section 8.4) and
  closes the connections of a scope that no list covers any more (1008, `The allowlist has no list
  for this scope any more`).

## 8. The messages (question 5)

No backward compatibility (the operator: "No backward compat"). agentwatch pins the receiver and the
relay and moves both at once.

### 8.1 What agentwatch sends (C4, channel `main`)

`set_allowlist` goes. In its place:

```json
{"t":"req","id":"<id>","op":"set_scopes",
 "lists":{"marketdata":["marketdata.app","github.com"],"vedlo":["vedlo.example"]},
 "scopes":{"md-lead":"marketdata","md-worker-2":"marketdata","vedlo-cron":"vedlo"},
 "default":null}
```

- `lists`: list name to entries. A name matches the scope pattern
  (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`); a list with another name applies as absent, and each of its
  entries counts as refused; a list whose value is not an array applies as absent and counts 1. Each entry is a C5 entry; an entry
  that is not normalized is refused and counted, and the other entries apply.
- `scopes`: scope to list name, or `null`. A scope with `null`, or whose list is not in `lists`, has
  no list; it does not fall back to `default`. A scope that does not match the scope pattern, or
  whose value is neither a string nor `null`, applies as absent and counts as refused.
- `default`: a list name or `null` (the recommended value, choice 5 a): the list of a scope that
  `scopes` does not name. Any other value
  counts as refused and applies as `null`. With `null`, such a scope has no list: its tabs fail
  closed, and the relay refuses its connections.
- The daemon names a session's scope in `scopes` before it gives the session its endpoint
  (`agentwatch browser endpoint` waits for the receiver's answer and the `allowlist` line). Else a
  new session could connect in the moment before, and get the default list, which can be another
  repo's list. This also holds for `agentwatch browser env`, and for an endpoint URL that the daemon
  puts into a session's environment at its launch: the daemon names the scope before the launch. The
  URL is easy to guess (the socket path and the session name), so with a default list any scope name
  that `scopes` does not name gets the default list.
- At a session's end the daemon keeps the scope in `scopes` with `null` (no list), and writes
  `end_scope` to the relay. So the ended scope's tabs and connections never fall back to the default
  list: the receiver blocks its tabs, and the relay closes its connections (section 7) and removes
  its tabs. `scopes` then grows with each ended session until the next link up (the receiver empties
  its map then, and the daemon sends the live sessions only). With `default` `null` (choice 5 a),
  the daemon can drop an ended scope as soon as `end_scope` has removed its tabs: an unnamed scope
  has no list anyway.
- The object replaces the last one in full. The daemon sends it after each link up (as it sends the
  list today), when a list changes, and when a session starts or ends.
- The answer: `{"rules":<scope rules in force>,"closed":<tabs closed>,"refused":<entries, list
  names and scope names refused>}`. The daemon waits 10 s, as for `set_allowlist`.
- The answer comes after the rules are in force, the workers are removed (when section 7 needs it)
  and the tabs are closed. A failed worker removal fails the call after the tabs closed, as today.

The agentwatch side (aw-lead): which repo each session belongs to, the lists per repo, the default,
where the lists live (the proxy path's `allowlist.json` of C5 stays for the CDP proxy), and the web
viewer's editing. A send of the operator mode no longer implies "add to the one list": agentwatch
decides which list a sent site joins.

### 8.2 What the receiver answers and tells

- The `set_scopes` answer above.
- `blocked` gets the scope: `{"t":"blocked","tab":<tab id>,"host":"<host>","scope":"<scope>"|null}`.
  So the web viewer can name the repo whose list lacks the host.
- On the bridge: `tabs.create [createProperties, scope]` and `windows.create [createData, scope]`
  (the new arg kind `scope`: a string that matches the scope pattern); the new event
  `bridge.tabScope` (section 5).
- `contentDetails` (C10): the host must be covered by a list of the last applied `set_scopes` (any
  list): the receiver does not know which scope calls.

### 8.3 The `allowlist` line to the relay (C10)

`{"t":"allowlist","lists":{...},"scopes":{...},"default":"<list>"|null}`, the object of the
`set_scopes` that the receiver confirmed on the current connection. It comes after each such answer.
The daemon sends only valid objects (normalized entries, valid names), and the relay applies the
same rules of section 8.1 to the line as the receiver does, so both sides have the same lists. A
shared vector in the build checks both.

### 8.4 The relay per scope (C11)

- **Readiness.** The relay admits a connection of scope S while the link is up, `bridge.info`
  answered with `bridge` 1 or more, and the last `allowlist` line gives S a list (its `scopes` entry
  when it has one, else `default`; section 8.1). Else 503 with the new text `The agent browser is not ready: the allowlist has no list
  for this scope.` (the other 503 texts stay). A scope whose list is empty is admitted: it can open
  `about:blank` only.
- **Refusals.** `Not allowed: <host> is not on the allowlist` for `Browser.grantPermissions` with an
  origin off the scope's list (today: off the one list), and for the navigations of section 6
  layer 1.
- **Content settings.** A grant with no origin covers the scope's list. At each `allowlist` line the
  relay sets again the grants of the open connections that their own scope's list still covers, and
  `automaticDownloads` for each entry of every list (the union).
- **What leaks between scopes.** A content setting is per origin pattern and acts on the whole
  profile. A grant of scope A for `x.example` applies to a scope-B tab on `x.example` when B's list
  also holds it, and `automaticDownloads` holds for the union. A grant never reaches a host that no
  list of its own scope covers.
- `end_scope` stays: the relay closes the scope's connections and removes its tabs.
- **New tabs.** The relay keeps a new tab that it did not create, and whose scope it does not know
  yet, in its model with no scope (attached and held as the receiver gave it) for up to 500 ms. On
  `bridge.tabScope` it announces the tab to the scope (C11, as a popup today). At the end of the
  wait it releases and detaches the tab, as for a tab of no scope today; a later `bridge.tabScope`
  still puts the tab in its scope, as a free tab. With the eager attach on, the event comes before
  `tabs.onCreated` in practice (the receiver sends it at `onCreatedNavigationTarget`, 0 to 1 ms after
  Chrome creates the tab, and `tabs.onCreated` after the attach). The relay's own handling of
  `tabs.onReplaced` (today it copies the scope itself) follows `bridge.tabScope` too.

### 8.5 The start: fail closed

Session rules go at a browser restart and at an extension reload or update (measured: none left
after a restart; dynamic rules stay). Until the first `set_scopes`, every main frame and every frame
is blocked (static rules 1 and 3), except the restore tab of an import (rules 6 and 7), and the
relay is not ready (no `allowlist` line). At its start the receiver removes dynamic rules 2 and 4
and every session rule, as the first thing that its worker does. In the moment between an update of
the agent package and that removal, the old dynamic rules 2 and 4 still allow the old one list in
every tab (the upgrade window); it ends before the first `set_scopes`.

### 8.6 The import (C6)

Step 2 adds the restore tab's rules 6 and 7 after `tabs.create` (`about:blank`) and before
`tabs.update(R)`. They allow the sent `domain` whatever the lists hold, so the restore page loads and
step 4's `location.replace(state.url)` is covered. Step 4 starts that navigation in a timer after the
script returns, so the rules cannot go at the end of the step: the receiver removes them at the
restore tab's first main-frame `webNavigation.onCommitted` or `onErrorOccurred` after step 4 (not
matched to `state.url`: a redirect commits another URL), at most 4 s after step 4, and in every
failure cleanup. The import ends (its answer, and the next import of the queue) only after the rules
are gone, so two imports never share rules 6 and 7; the 4 s fit in the time budget (100 s + 4 s +
two cleanups of 4 s = 112 s, below the link's 115 s). Until the rules go, the guard judges the tab
by `domain`, so the sent page is not sent to `about:blank` at its own commit. The restore tab is in
no scope, as today; after the import its page stays while a list covers it (section 7), and it
cannot navigate further or load new frames.

## 9. The scope is advisory (question 6)

Any process of the daemon's OS user can open the 0600 socket and connect with any scope name (C11,
agent-browser #14). A scope name is a session name, which `agentwatch` lists. So a session of repo B
can connect with the scope of a session of repo A and get A's list.

**What the per-repo list protects against:**

- An honest agent of repo B that goes to a site of repo A by mistake: its `goto` is refused by the
  relay, a link or redirect is blocked by DNR (0 of 20 requests reached the other scope's host), and a
  worker's page is sent away by the guard.
- A page in B's tab that tries to take the tab to A's sites: links, redirects, popups (they inherit
  B's scope, measured right in every trial) and page scripts.
- An agent of B that follows an injected instruction with its own endpoint.

**What it does not protect against:**

- A process that connects with another session's scope (the advisory scope).
- Frames and subresources: an allowlisted page of B loads frames and requests from any host, with
  that host's cookies that Chrome sends in a third-party context, and B's client can read them (O11,
  two-modes design section 8). This is the same for the one list today.
- The page of a worker that wins the guard's race (section 6), and the request of a worker that
  passes a navigation on: it reaches the site with the site's cookies also when the guard stops the
  page (10 of 10). Only the full block (choice 2 b) stops both.
- A scope name that `scopes` does not name, while a default list exists (section 8.1): it gets the
  default list.
- A process that reads the profile's files (the cookie store) directly, as today.
- A content setting that another scope granted for a host that both lists hold (section 8.4).

**A fix exists: a scope token** (section 13, choice 1). The daemon makes a random token for each
scope; the endpoint path carries it (`/devtools/browser/<scope>/<token>`, not measured with
Playwright); the daemon sends the relay a hash of each token in the `allowlist` line; the relay
admits a connection only with the scope's token. A session then cannot take another list by naming
a scope. It changes C11's rule "every process of the user may connect with any scope", and "the URL
contains no secret". With the token, `default` must be `null`: a scope that `scopes` does not name
has no token.

How a session gets its token (aw-lead's facts, mail m0ba5897, 2026-11-05; agentwatch #563): today a
session names itself, and the CLI reaches the gateway over TCP localhost with one Bearer token, so
`agentwatch browser endpoint` cannot tell which session calls. Two ways:

- **In the session's environment at its launch.** agentwatch starts each session, so it puts the
  token (or the full endpoint URL) into that session's environment. No process check is needed.
  This is the cheap way.
- **By a process check.** `agentwatch browser endpoint` over a per-user 0600 Unix socket; the daemon
  reads the caller's pid (`SO_PEERCRED` on Linux, `LOCAL_PEERPID` on the Mac) and maps it to the
  session by its process tree. About one task of the size of stage 4. A process that leaves the
  session's tree (`setsid`, `nohup`, `systemd-run`) is refused, a cron job is a session of its own,
  the token belongs to the session's stable identity (not its display name), and a failed `/proc`
  or tmux read refuses the call.

The limits of either way, stated plainly: the token stops a mistake and a prompt-injected agent that
only names another scope. It does not stop a process of the same OS user that looks for the token:
`/proc/<pid>/environ` of another session's process is readable by the same user; a session's
transcript holds what the session printed; tmux keys sent to another session's pane run there. So
the token must never be in an argv (`/proc/<pid>/cmdline` is readable by every user on taylor):
agent-browser and the Playwright MCP take the endpoint from an environment variable or a 0600 file,
not from `--cdp-url` with the token in it. It must never be in a transcript either: the output of
`agentwatch browser endpoint` becomes a secret, and the skill tells agents not to print it.

## 10. The operator-mode send stays one profile (question 7)

The agent browser has one profile. A sent site's cookies, storage and service workers are in that
profile for every scope. A scope whose list lacks the sent site cannot open its pages at the top
level (DNR, the relay and the guard), but:

- its allowlisted pages can still make requests to the sent site, and Chrome sends the site's cookies
  that are allowed in a third-party context (`SameSite=None`) with them;
- a worker of the sent site can serve its page in that scope's tab until the guard acts (section 6);
- a content setting that another scope granted for the sent site applies there too.

Only navigation is guarded. Separate sign-ins per repo need a profile per repo (section 4, the
rejected ways).

## 11. The remaining limits

- A form POST into a new tab (`<form target=_blank method=post>`) fails closed: its first request
  comes before its rule, and the retry cannot send the POST again (measured 0 of 40).
- A popup that needs the retry shows Chrome's error page for about 60 to 100 ms, and its request has
  `Cache-Control: max-age=0` (section 5.2). Whether Playwright can resolve on the error page is not
  measured (section 5.2).
- The guard is not a block for a worker's page, also one that the worker passes on from the network
  (section 6), or a back/forward-cache page (section 7).
- With a default list, a scope name that `scopes` does not name gets that list (section 8.1).
- Tabs of no scope fail closed, and that includes the operator's own tabs. Today the operator can open
  a tab in the agent browser's live view (agentwatch design §5.15) and browse the one list. With this
  design such a tab has no scope, so it can open no site at all. The receiver can mark such a tab:
  a new tab that no page opened and that no bridge op created starts at Chrome's New Tab page
  (`chrome://newtab/`), which no agent tab ever does (the relay opens `about:blank` only). The
  options are in section 13, choice 3; the mark and the operator's list are a part-3 task (section
  12).
- A daemon restart (a link change) leaves the open tabs in no scope: they fail closed and close at
  the next `set_scopes` when no list covers them (section 7). Today they stay open but no connection
  sees them.
- Prerendered pages (speculation rules) were not measured: if Chrome gives their requests no tab
  id, they are blocked (fail closed), and the site's prerender does not happen.
- A large list makes each assignment slower, so more popups need the retry (section 4).
- Content settings and the sent sign-ins are shared by every scope (sections 8.4 and 10).

## 12. The build split

Contracts first: the target blocks in chrome-extension `docs/protocol.md` (this task) become the
contract text in the first build PR, with the shared vectors:

- `test/vectors/bridge.json`: the scope arg of `tabs.create` and `windows.create` (the new kind
  `scope`, `about:blank` only), the event `bridge.tabScope`.
- `test/vectors/endpoint.json`: the new 503 text, the 1008 close, the navigation refusals per scope.
- A new `test/vectors/scopes.json`: `set_scopes` objects and what applies (lists, scopes, `null`,
  default, the counts in `refused`), for the receiver and the relay alike (section 8.3).
- agent-browser copies them into `test/vectors/chrome-extension-<commit>/`, as today.

Then (the receiver in three PRs, so that each one stays small enough for one review):

| Part | Repo | What | Depends on |
| --- | --- | --- | --- |
| 1a. Rules and map | chrome-extension (`agent/`) | `set_scopes` in place of `set_allowlist`; the scope rules as session rules (a full replace for `set_scopes`, one list's rules for a tab); the removal of dynamic rules 2 and 4 and of every session rule at the worker's start; the tab-to-scope map, its reset at each link change and the epoch check of its writes; `tabs.create` and `windows.create` with the scope arg; `tabs.onReplaced`; the fail-closed path of a failed rule update; the closing rule per list and the window rule of section 7; the worker removal per section 7; the import's rules 6 and 7 and their end at the restore tab's last navigation; `contentDetails` against the union; unit tests with the fake chrome | the contract PR |
| 1b. Popups and the retry | chrome-extension | Popups from `onCreatedNavigationTarget`; `bridge.tabScope` before `tabs.onCreated`; the retry and its trigger; the hold of a popup's `tabs.onCreated` until its first request is allowed or the retry's request is held (section 5.2); unit tests; the live test of popups of every kind many times, also with one window per page | 1a |
| 1c. The guard and `blocked` | chrome-extension | The guard (layers 2 and 3), for `blob:` inner hosts too; `blocked` with the scope, once per navigation, and after a failed retry; with choice 2 b, the worker block instead; unit tests; the live test of the worker hole (both forms) and of a list change | 1a |
| 2. The relay | agent-browser (`src/relay/`) | The `allowlist` line with lists, scopes and default, and the rules of section 8.1 applied to it (the shared vector); readiness and the 503 text per scope; the closing of connections whose scope lost its list; `tabs.create` and `windows.create` with the scope; a tab's scope from `bridge.tabScope` only, with the 500 ms wait for a new tab; the refusal of off-list navigations (layer 1); grants and the content-setting rebuild per scope; with choice 1 b, the token; unit tests with the fake bridge; the live test with two scopes through Playwright and the MCP, popups of every kind many times | the contract PR; runs at the same time as part 1 |
| 3. agentwatch | agentwatch (aw-lead) | Lists per repo in the web viewer; the scope of each session (session to repo to list) and the default (choice 5); `set_scopes` after each link up, list change, session start and end, and before a session gets its endpoint; `null` for an ended scope; the `allowlist` line; `blocked` with the scope in the Browser page; which list a sent site joins (choice 6); the operator's own tabs (choice 3: the mark of section 11 and their list); with choice 1 b, the token in each session's environment and out of every argv and transcript; the skill text (a refused `goto` gives `Not allowed: <host> is not on the allowlist`, no error page); the live test on taylor with two repos and two lists | parts 1a to 1c and 2 |

Each part: test first, a fresh reviewer per PR, no tag or publish. The choices of section 13 change
parts 1 to 3 only where they say. Before the contract PR merges, ab-lead mails its commit to aw-lead
(C4 and C5 are rules that agentwatch must follow).

## 13. Choices for the operator

Six choices. The design works with the "No answer" of each; the build parts that each choice changes
are in section 12.

**Choice 1. Should each agent session get a scope token, so that a session cannot take another repo's
list by naming that repo's scope?** Today any process of your OS user can connect to the agent
browser with any session's name and get that session's list.

- a. Keep the scope advisory. The per-repo list keeps an honest agent and a page inside the repo's
  sites. A session that names another repo's scope gets that list. No more work.
- **b. A token per session, put into the session's environment when agentwatch starts it
  (recommended).** The agent browser admits a connection only with the scope's token. A session can
  no longer take another repo's list by naming it. A process of your user that looks for the token
  can still find it: in another session's environment (`/proc`), in a transcript, or by tmux keys to
  another session's pane. The token never goes into a command line or a transcript. A stronger
  check (the daemon tells the calling session by its process) is about one more stage of work in
  agentwatch.
- Recommendation: b, because without it the per-repo list is one name away for any session, and a
  simple injected instruction can use it.
- No answer: a (no token); the rest of the design does not depend on it.

**Choice 2. Should the agent browser block service workers, so that a site's worker never shows its
page in another repo's tab?**

- **a. Keep service workers; the guard stops most such pages (recommended).** Sites work as in a
  normal Chrome. A page's link to another repo's site that has a worker can still show that page for
  some tens of ms before the agent browser sends the tab away. A worker that passes navigations on
  still sends that one navigation request to the other repo's site with its sign-in, also when the
  page is stopped.
- b. Block service workers. No site's worker can serve another repo's tab. Every site in the agent
  browser fails to register a worker, as with an ad blocker that blocks worker scripts: no offline
  pages and no push, and a site that tests for workers sees it.
- Recommendation: a, because site visibility is your top goal and the scope is advisory unless choice
  1 is b.
- No answer: a.

**Choice 3. What can your own tabs in the agent browser's live view open?** Today a tab that you open
there can browse the one list. With per-repo lists it belongs to no repo, so it can open no site.

- **a. Every repo's sites (the union of the lists) (recommended).** The agent browser marks a tab
  that you open (it starts at Chrome's New Tab page, which no agent tab does). You can look at any
  site that any repo may use.
- b. A list of your own, edited in the web viewer as a repo's list.
- c. Nothing: your tabs stay blocked; you browse in your own Chrome.
- Recommendation: a, because you can already give any repo any site, and the mark is cheap.
- No answer: c (fail closed) until the answer.

**Choice 4. Is it acceptable that a site can see the retry of a popup?** A popup that opens a new
window process (a `target=_blank` link, `noopener`) always loads one moment too early for its repo's
rule, and the agent browser loads it once more.

- **a. Keep the retry (recommended).** The site gets one request, as normal, with one header more
  (`Cache-Control: max-age=0`, as when a person reloads a page); a sign-in popup that needed the
  retry also sends `Sec-Fetch-User: ?1`. An attempt to remove the extra header did not work.
- b. No retry. Such popups show Chrome's error page in agent mode: links that open a new tab, and
  many sign-in popups, fail.
- Recommendation: a, because b breaks common sites, and a site rarely compares these headers.
- No answer: a.

**Choice 5. What list does a scope get that no repo names (the default list)?** For example a
program that is not an agentwatch session, or a scope name that someone made up.

- **a. None (recommended).** Such a connection is refused. Each session and each other program gets
  its repo's list by name.
- b. A default list. Such a scope gets it, also a guessed or made-up name, and with choice 1 b a
  default list leaves that hole open.
- Recommendation: a, because b gives a list to any name.
- No answer: a.

**Choice 6. Which list does a site that you send to the agent browser join?** Today a send adds the
site to the one list.

- a. You choose the repo (or repos) when you send. The send dialog of the operator extension gets one
  more field.
- **b. No list (recommended).** The send only puts your sign-in into the agent browser. The web viewer
  shows the site as on no list, and you add it to the repos that need it.
- c. Every repo's list. As today, every agent can use the sent site.
- Recommendation: b, because a sign-in is the most sensitive thing on the box, and b makes each
  repo's access an explicit choice with no change to the operator extension.
- No answer: b.

## 14. The evidence

The probe: [2026-11-04-per-scope-allowlist-probe/README.md](2026-11-04-per-scope-allowlist-probe/README.md),
its source (`ext/`, `site.py`, `probe.mjs`) and its results (`results/*.json`). It ran on taylor in
its own Xvfb (an auth file, `-nolisten tcp`), with the system Chromium 156.0.8078.79, a throwaway
profile, the probe extension loaded unpacked, and `*.localhost` sites on 127.0.0.1 only. It used a
remote-debugging port of its own Chromium only to call the probe extension's worker; every tab and
rule action ran in the extension. It did not use the agent package, the packed CRX or its key.

| What | Result | File |
| --- | --- | --- |
| A tab's rule set at `about:blank` applies to its first navigation | 20 of 20 own list; 0 of 20 other list reached; 0 of 20 no-scope reached | rules.json |
| Rule 5 with session allow rules | `Sec-Fetch-Site: none` 20 of 20 | rules.json |
| DNR before the hold's `Fetch` | blocked at once 10 of 10, never paused | dnrfetch.json |
| Popups: the source of the opener, the race, the retry | see the tables in section 5 | popups-*.json |
| Frames with `tabIds` | as section 4 | frames.json |
| The worker hole and the guards | as section 6 | sw-hole.json, sw-guard-*.json |
| Workers that pass a navigation on, navigation preload | as section 6 | sw-pass.json |
| What a site sees of the retry | `Cache-Control: max-age=0` more; the other headers as a popup with no retry | retry-control.json, popups-retry-*.json |
| Worker scripts in DNR | `tabId` -1, type `script`; a block fails registration only | sw-script.json |
| Back after a list change | a network navigation, blocked by rule 1, 6 of 6; no cache restore seen | bfcache.json |
| Session rules after a browser restart | none; dynamic rules 2 and 5 stay | restart.json |
| The rule limits | 5000 session rules; 100,000 hosts in one rule; one assignment grows with all lists' entries | limits.json |

**Not measured:** Playwright and the MCP on the target (no relay change exists yet), so also whether
Playwright resolves a popup on the error page before the retry; a page from the back/forward cache;
prerendered pages; whether Chrome reports a cache restore in `webNavigation.onCommitted`; the
session rules after a service-worker restart alone (no link change); the relay's refusal of
off-list navigations (design only); the two receiver guard layers together; the guard for a tab of
no scope with the union of the lists; a failed rule update; a one-shot rule that removes
`Cache-Control` from the retry; the token through Playwright's `ws+unix:` URL; Google Chrome
stable (the probe used Chromium 156; the agent Chrome on taylor will be Chrome stable); the Mac.
