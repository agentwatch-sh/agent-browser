# Per-scope allowlists in agent mode — design

Date: 2026-11-04. Status: **DRAFT for review.** Author: taylor session `allowlist`, a subagent of
`ab-lead` (board task ab-v16.23, under goal ab-v16). Branch `ab-v16.23-per-scope-allowlist` in
agent-browser and in chrome-extension. Evidence: the probe in
[2026-11-04-per-scope-allowlist-probe/](2026-11-04-per-scope-allowlist-probe/README.md), run on
taylor with Debian Chromium 156.0.8078.79 in a private Xvfb.

This design builds on the two-modes design
([2026-11-03-two-modes-playwright-design.md](2026-11-03-two-modes-playwright-design.md), sections 4,
7, 8, 10 to 13) and on the contracts C4, C5, C10 and C11 in chrome-extension `docs/protocol.md`
(main `ffaf794`). The contract text of the target is in that file, on the chrome-extension branch of
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
   needs the retry; a popup with an opener needs it rarely.
4. **The service-worker hole (section 6).** Measured: a worker of a scope-A site serves its page in
   a scope-B tab with no request. The guard: the relay refuses a client's navigation to a host off
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
   token per session is a choice for the operator (section 13, choice 1).
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
| the import's restore tab | session | 6 | 2 | allow | `requestDomains` = [the sent `domain`], `resourceTypes: ["main_frame"]`, `tabIds` = [the restore tab], during the import only |

- A list with no tab, or with no entry, has no rule: the session-rule API refuses an empty `tabIds`,
  and an empty list allows nothing.
- Dynamic rules 2 and 4 go. With them, every tab would get the union of the lists. An older package
  leaves them in the profile (measured: dynamic rules stay after a browser restart, session rules do
  not), so the receiver removes ids 2 and 4 at each start and at each `set_scopes`.
- One `updateSessionRules` call replaces every scope rule at once. So no moment exists in which a
  tab has the rules of two lists, or a list has a rule without its frame rule.
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
- One assignment (the replace of a list's two rules for one more tab) took 11 to 15 ms, median 13
  ms, with small lists.
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

The cost that matters is the time of one assignment (a tab joins a list: one list's two rules are
replaced), because a relay's new tab waits for it and it decides how often a popup needs the retry.
Chrome indexes all session rules again at each update, so the time grows with the entries of all
lists in use, not with the one list (results/limits.json, `sets`, five assignments each):

| Lists in use | Entries per list | One assignment |
| --- | --- | --- |
| 2 | 10 | 0 to 1 ms |
| 20 | 100 | 5 to 6 ms |
| 20 | 1,000 | 45 to 48 ms |
| 100 | 1,000 | 234 to 256 ms |
| 2,400 | 10 | 118 to 145 ms |

So a box with tens of repos and lists of tens to hundreds of hosts stays near 5 ms. Lists of
thousands of hosts make more popups need the retry (section 5.2).

## 5. A tab gets its scope before its first navigation (question 2)

**The receiver keeps the tab-to-scope map.** It sets a tab's scope in these cases, and in no other:

| Tab | Who names the scope | When the rule is in force |
| --- | --- | --- |
| A tab that the relay opens (`Target.createTarget`) | The relay: a new required arg of `tabs.create` and `windows.create` | Before the op answers; the tab is still at `about:blank`, which makes no request |
| A popup (`window.open`, `target=_blank`, `rel=opener`, `noopener`, a form with a target) | The receiver: the scope of `sourceTabId` in `webNavigation.onCreatedNavigationTarget` | 2 to 47 ms after that event (section 5.2) |
| A tab that replaces another (`tabs.onReplaced`) | The receiver: the removed tab's scope | At once after the event |
| Any other tab (the operator's live-view tab, the restore tab, a tab from before the link) | Nobody | Never: the tab fails closed |

- The relay creates a tab only at `about:blank` (it does so today, C11), so `newTab.url` and
  `newWindow.url` become `about:blank` only.
- The receiver puts a popup's scope in its map in the event handler itself, before it calls
  `updateSessionRules`, so the guard of section 6 and the retry judge the popup by its scope at once.
- The receiver reports each scope that it sets itself (popups, replaced tabs) with a new bridge event,
  `bridge.tabScope` (`"tabId"`, `"scope"`). The relay takes a tab that it did not create into a scope
  only on that event. The reason: the receiver enforces the scope. If the relay computed a popup's
  scope itself and got another answer, a client of one scope would drive a tab under another scope's
  list.
- An argument of `tabs.create`, not a separate op: with an op, a tab would exist for a moment with no
  scope while the relay knows it, and the relay would have to wait for the op's answer before each
  navigation. The argument makes the scope a part of the tab's creation.
- The relay keeps Chrome's `openerId` for the popup's **owner** (C11: the owner of the opener takes
  the popup), only when the opener is in the same scope.
- At each link change and at its worker's start the receiver forgets every tab's scope and removes
  every scope rule. The relay forgets its tabs at a link change too (C11). So a tab from before the
  link is in no scope on both sides, and fails closed.

### 5.1 Which source names the opener

Measured (results/popups-*.json, 520 popups): `sourceTabId` named the right opener in every popup of
every kind, also with the opener in the background behind a tab of another scope. Chrome's
`openerId` (the relay's source today, read with `Target.getTargetInfo` on the attached popup) was
right in every held popup too (120 of 120, `noopener` popups included). `chrome.tabs`'
`openerTabId` named the active tab: with the opener in the background it was wrong in every trial
(0 of 220), and it named the tab of the other scope. Measured with `openerTabId` as the source
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
| `<a target=_blank rel=opener>` | 20 of 20 | 18 of 20 | 2 to 14 ms, median 4 to 5 | 10 to 27 ms, median 14 |
| `window.open(url, "_blank", "noopener")` | 0 of 20 | 0 of 20 | 15 to 47 ms, median 19 to 22 | 8 to 21 ms, median 9 to 10 |
| `<a target=_blank>` (`noopener` by default) | 0 of 20 | 0 of 20 | 15 to 38 ms, median 20 to 23 | 8 to 16 ms, median 9 |
| `<form target=_blank method=post>` | 0 of 20 | 0 of 20 | 14 to 44 ms, median 21 to 22 | 7 to 19 ms, median 9 to 10 |

A `noopener` popup starts in a new process: its request leaves about 10 ms after the event, and the
rule comes later. A popup with an opener starts in the opener's process: its request leaves later,
and the rule wins nearly always.

**The retry.** When a tab's main-frame navigation fails with `net::ERR_BLOCKED_BY_CLIENT` before the
tab's rule is in force, and the rule then covers the URL's host, the receiver reloads the tab once
(`tabs.reload`), after the rule is in force and the error page committed. A blocked request never
left Chrome, so the site sees one request. Measured (results/popups-nav-retry.json,
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
- The retry runs once per tab and only for a host that the tab's list covers. A tab of no scope
  never gets one. The receiver sends no `blocked` notice for a first request that it retries.

**What a client sees.** The eager attach and the hold (C10) stay. A popup that needs the retry shows
Chrome's error page for about 60 to 100 ms, then the retry's request, which the hold keeps until the
client's `Runtime.runIfWaitingForDebugger`. Not measured with Playwright: whether `waitForEvent
("popup")` and `waitForLoadState()` can resolve on the error page before the retry. The build's live
test runs the popup kinds many times through Playwright and the MCP (section 12). If Playwright
resolves on the error page, the receiver holds the popup's `tabs.onCreated` event until the retry's
request is in the hold; that is a change in the receiver only.

## 6. The service-worker hole (question 3)

**Measured: the hole exists across scopes** (results/sw-hole.json). Scope A's tab opened a page of
`a.localhost` that registers a worker for the whole host. Then a scope-B tab (list: `b.localhost`)
navigated to `a.localhost`, by a client's `Page.navigate` and by a page script. In 20 of 20 trials the
page committed in the scope-B tab (27 to 43 ms after the navigation started) with no network request
and no DNR match, and the worker's page ran its script (its beacon reached the site 62 to 87 ms after
the navigation started). The frame inside the worker's page was blocked (B's frame rule, 0 of 20
reached the site). DNR cannot see a navigation that a worker answers.

The hole matters because the worker's page is a first-party page of A's site in B's tab: its
same-site requests carry all of A's cookies, and its storage is A's storage. B's client can read
that page while it lives.

**The guards measured:**

| Guard | Result | What a site can see |
| --- | --- | --- |
| The receiver sends the tab to `about:blank` at `onCommitted` | The worker's page committed and its script ran in 20 of 20; the tab was at `about:blank` 50 to 75 ms after the navigation started | Its page unloads at once |
| The receiver closes the tab at `onCommitted` | The same, 20 of 20; the tab closed 59 to 137 ms after the start | The same |
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
2. The receiver, at `webNavigation.onBeforeNavigate` of a main frame whose `http:`/`https:` host the
   tab's list does not cover (for a tab of no scope: the union of the lists; for the restore tab:
   its `domain`), sends the tab to `about:blank` (`tabs.update`) and sends `blocked`. That stops a
   page's own navigation (a link, a script) before a worker can answer, when the receiver wins.
3. The receiver does the same at `webNavigation.onCommitted` of such a page: a worker's page that
   won the race, or a page from the back/forward cache (section 7), leaves the tab at once.

**Why not the full block now.** It closes the hole, but every site in the agent browser then fails
to register a service worker. Sites lose offline pages and push, and a site that tests for a worker
sees the failure, which is rare in real Chrome. The operator's top goal is that a site sees nothing
unusual (two-modes design, section 7). And the scope is advisory (section 9): a session that wants
another repo's sites can name that repo's scope. So the guard closes the hole for an honest agent
and for a page's own links, at no cost to sites; the full block is the operator's choice.

**What the guard leaves open:** a page's navigation that the receiver does not win at
`onBeforeNavigate` commits; the worker's page then runs its scripts for some tens of ms before the
receiver sends the tab away, and a client attached to the tab can read it during that time.

## 7. When a scope's list loses a site (question 4)

- **Which tabs close.** At each `set_scopes` the receiver closes every tab whose `http:`/`https:`
  host its own list does not cover: for a tab of a scope, the scope's list (after `scopes` and
  `default`); for a tab of no scope, the union of the lists (so a page of a finished import and an
  operator's tab stay while some list covers them); the restore tab of a running import is never
  closed (C6). A tab of another scope on the same host stays when its own list covers the host. The
  about:blank guard of C5 stays: the last tab of a window is replaced, not closed.
- **The worker removal.** The receiver calls `browsingData.remove({}, {serviceWorkers: true})`
  after the rule update and before the tabs close, when the list of a scope that is in the old and
  the new map, or the default list, lost an entry, and at the first `set_scopes` after its worker
  starts. A new scope, or a scope that leaves the map, does not remove the workers. The removal is
  coarse (every site's workers go), as today.
- **The back/forward cache.** A page in the cache comes back with no request, so DNR does not block
  it. In the probe, Back after a list change started a network navigation, and rule 1 blocked it
  (`net::ERR_BLOCKED_BY_CLIENT`, 6 of 6, no request reached the site); the probe's pages did not
  enter the cache (its tabs had `chrome.debugger` attached), so a restore from the cache was not
  measured. The guard of
  section 6 (layer 3) sends a tab to `about:blank` when Chrome reports the restore with
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
 "default":"marketdata"}
```

- `lists`: list name to entries. A name matches the scope pattern
  (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`); a list with another name applies as absent. Each entry is
  a C5 entry; an entry that is not normalized is refused and counted, and the other entries apply.
- `scopes`: scope to list name. A scope that names no list of `lists` has no list.
- `default`: a list name or `null`: the list of a scope that `scopes` does not name. With `null`, such
  a scope has no list: its tabs fail closed, and the relay refuses its connections.
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
`set_scopes` that the receiver confirmed on the current connection, with only the entries that the
daemon sent (the daemon sends only normalized entries, so both sides have the same lists). It comes
after each such answer.

### 8.4 The relay per scope (C11)

- **Readiness.** The relay admits a connection of scope S while the link is up, `bridge.info`
  answered with `bridge` 1 or more, and the last `allowlist` line gives S a list (`scopes`, else
  `default`). Else 503 with the new text `The agent browser is not ready: the allowlist has no list
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

### 8.5 The start: fail closed

Session rules go at a browser restart and at an extension reload or update (measured: none left
after a restart; dynamic rules stay). Until the first `set_scopes`, every main frame and every frame
is blocked (static rules 1 and 3), and the relay is not ready (no `allowlist` line). At its start the
receiver removes dynamic rules 2 and 4. An import that runs before the first `set_scopes` still works:
its restore tab has its own rule 6.

### 8.6 The import (C6)

Step 2 adds the restore tab's rule 6 after `tabs.create` (`about:blank`) and before `tabs.update(R)`.
Step 4's `location.replace(state.url)` is covered by it. The import's cleanup removes rule 6. The
restore tab is in no scope, as today; after the import its page stays while a list covers it
(section 7), and it cannot navigate further.

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
- The page of a worker that wins the guard's race (section 6), unless the operator chooses the full
  block.
- A process that reads the profile's files (the cookie store) directly, as today.
- A content setting that another scope granted for a host that both lists hold (section 8.4).

**A cheap fix exists: a scope token** (section 13, choice 1). The daemon makes a random token for each
scope and gives it only to that session's processes; the endpoint path carries it
(`/devtools/browser/<scope>/<token>`, not measured with Playwright); the daemon sends the relay a hash
of each token in the `allowlist` line; the relay admits a connection only with the scope's token. A
session then cannot take another list by naming a scope. It still can by reading another session's
environment or memory (same OS user), so the token stops a mistake and a simple injected
instruction, not a hostile process. It changes C11's rule "every process of the user may connect
with any scope", and "the URL contains no secret": the URL then must stay out of logs. It works only
if agentwatch can tell which session calls `agentwatch browser endpoint` by its process, not by an
environment variable that any process can set.

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
- A popup that needs the retry shows Chrome's error page for about 50 to 120 ms. Whether Playwright
  can resolve on it is not measured (section 5.2).
- The guard is not a block for a worker's page (section 6) or a back/forward-cache page (section 7).
- Tabs of no scope fail closed: the operator's tabs in agentwatch's live view (no mark today,
  agentwatch design §5.15) can no longer browse any list. When the live view gets its mark, agentwatch
  can open those tabs through the relay with a scope of its own (aw-lead's part).
- A daemon restart (a link change) leaves the open tabs in no scope: they fail closed and close at
  the next `set_scopes` when no list covers them (section 7). Today they stay open but no connection
  sees them.
- Prerendered pages (speculation rules) were not measured: if Chrome gives their requests no tab
  id, they are blocked (fail closed), and the site's prerender does not happen.
- A large list makes each assignment slower, so more popups need the retry (section 4).
- Content settings and the sent sign-ins are shared by every scope (sections 8.4 and 10).

## 12. The build split

Contracts first: the target blocks in chrome-extension `docs/protocol.md` (this task) become the
contract text, with new vectors, in the first build PR. Then:

| Part | Repo | What | Depends on |
| --- | --- | --- | --- |
| 1. The receiver | chrome-extension (`agent/`) | `set_scopes` in place of `set_allowlist`; the scope rules as session rules, the removal of dynamic rules 2 and 4; the tab-to-scope map; `tabs.create` and `windows.create` with the scope arg (`about:blank` only); popups from `onCreatedNavigationTarget`; `tabs.onReplaced`; the event `bridge.tabScope`; the retry; the guard (layers 2 and 3); the closing rule per list; the worker removal per section 7; the import's rule 6; `blocked` with the scope; `contentDetails` against the union; the reset of the map at each link change; unit tests with the fake chrome; the live test with two scopes and two lists (popups of every kind many times, the worker hole with the guard, the retry, frames, a list change) | the contract PR |
| 2. The relay | agent-browser (`src/relay/`) | The `allowlist` line with lists, scopes and default; readiness and the 503 text per scope; the closing of connections whose scope lost its list; `tabs.create` and `windows.create` with the scope; a tab's scope from `bridge.tabScope` only; the refusal of off-list navigations (layer 1); grants and the content-setting rebuild per scope; unit tests with the fake bridge; the live test with two scopes through Playwright and the MCP, popups of every kind many times | the contract PR; runs at the same time as part 1 |
| 3. agentwatch | agentwatch (aw-lead) | Lists per repo in the web viewer; the scope of each session (session to repo to list) and the default; `set_scopes` after each link up, list change, session start and end; the `allowlist` line; `blocked` with the scope in the Browser page; the send and which list a sent site joins; the skill text (a refused `goto` gives `Not allowed: <host> is not on the allowlist`, no error page); the live test on taylor with two repos and two lists; with choice 1, the token | parts 1 and 2 |

Each part: test first, a fresh reviewer per PR, no tag or publish. The choices of section 13 change
parts 1 to 3 only where they say.

## 13. Choices for the operator

**Choice 1. Should each agent session get a scope token, so that a session cannot take another repo's
list by naming that repo's scope?** Today any process of your OS user can connect to the agent
browser with any session's name and get that session's list.

- a. Keep the scope advisory. The per-repo list keeps an honest agent and a page inside the repo's
  sites. A session that names another repo's scope gets that list. No more work.
- **b. A token per session (recommended).** agentwatch gives each session a secret and gives it only
  to that session's processes; the agent browser admits a connection only with the scope's secret.
  A session can no longer take another repo's list by naming it. A process that reads another
  session's environment or memory still can. More work in agentwatch: it must tell which session
  calls by its process.
- Recommendation: b, because without it the per-repo list is one name away for any session, and a
  simple injected instruction can use it.
- No answer: a (no token); the rest of the design does not depend on it.

**Choice 2. Should the agent browser block service workers, so that a site's worker never shows its
page in another repo's tab?**

- **a. Keep service workers; the guard stops most such pages (recommended).** Sites work as in a
  normal Chrome. A page's link to another repo's site that has a worker can still show that page for
  some tens of ms before the agent browser sends the tab away.
- b. Block service workers. No site's worker can serve another repo's tab. Every site in the agent
  browser fails to register a worker, as with an ad blocker that blocks worker scripts: no offline
  pages and no push, and a site that tests for workers sees it.
- Recommendation: a, because site visibility is your top goal and the scope is advisory unless choice
  1 is b.
- No answer: a.

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
| The worker hole and the guards | as section 6 | sw-*.json |
| Worker scripts in DNR | `tabId` -1, type `script`; a block fails registration only | sw-script.json |
| Back after a list change | a network navigation, blocked by rule 1, 6 of 6; no cache restore seen | bfcache.json |
| Session rules after a browser restart | none; dynamic rules 2 and 5 stay | restart.json |
| The rule limits | 5000 session rules; 100,000 hosts in one rule; one assignment grows with all lists' entries | limits.json |

**Not measured:** Playwright and the MCP on the target (no relay change exists yet), so also whether
Playwright resolves a popup on the error page before the retry; a page from the back/forward cache;
prerendered pages; whether Chrome reports a cache restore in `webNavigation.onCommitted`; the
session rules after a service-worker restart alone (no link change); the relay's refusal of
off-list navigations (design only); the token through Playwright's `ws+unix:` URL; Google Chrome
stable (the probe used Chromium 156; the agent Chrome on taylor will be Chrome stable); the Mac.
