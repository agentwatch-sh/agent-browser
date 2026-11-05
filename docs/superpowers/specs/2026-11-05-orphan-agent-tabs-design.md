# Orphan agent tabs — design

Date: 2026-11-05. Status: **DRAFT for review.** Author: taylor session `orphan`, a subagent of `ab-lead`
(board task ab-v16.39, under goal ab-v16). Branch `ab-v16.39-orphan-tabs` in agent-browser. Evidence: the
probe in [2026-11-05-orphan-agent-tabs-probe/](2026-11-05-orphan-agent-tabs-probe/README.md), run on taylor
with Debian Chromium 156.0.8078.79 in a private Xvfb, against the receiver of chrome-extension main
`27543ce` (agent package 0.2.0) and the relay of agent-browser main `b81dd4e`.

This design builds on the per-scope allowlist design
([2026-11-04-per-scope-allowlist-design.md](2026-11-04-per-scope-allowlist-design.md), sections 5, 7, 8
and 12) and on the blocks marked "Target (board ab-v16.23)" in C4, C5, C10 and C11 of chrome-extension
`docs/protocol.md` (main `27543ce`). A given, from ab-lead (2026-11-05): aw-lead agrees with option a, and
a short link drop must not close the tabs of live sessions. No code changes in this task.

## 1. The answer in short

The gap (aw-lead, mail m3230a3a, from its stage-4 B5 review): agentwatch writes `end_scope` with every
name of a session at the session's end. When no relay runs at that moment (the link is down, or the
relay restarts), the session's tabs stay open and nobody owns them. The relay's tab map is in memory
only, and `reset()` and `onLinkUp()` empty it, so a later `end_scope` closes nothing. Section 2 gives the
measurements. The decisions, each with its reason in the section that the line names:

1. **Who closes an orphan (section 4).** The receiver, at each `set_scopes`: it closes every tab whose
   scope the new object gives no list (the **sweep**). After the sweep, a new tab of such a scope closes
   at once, and `tabs.create` and `windows.create` refuse such a scope. This is option a, with the
   receiver as the sweeper in place of the relay. Option b (close the agent tabs at a link drop) is
   refused.
2. **Which tabs are agent tabs (section 5).** A tab that has a scope in the receiver's tab-to-scope map
   (the per-scope design, section 5). Two changes: the map stays at a link change, and the receiver
   keeps a copy of it in `chrome.storage.session`, so it also stays over a worker restart. Not the
   tab's opener, not a page's `sessionStorage`, not `chrome.storage.local`.
3. **Which scopes are live (section 6).** The `scopes` of `set_scopes` (the per-scope build). Today's
   `allowlist` line names no scope. So no fix comes before the per-scope build.
4. **What never closes (section 7).** Every tab of no scope: the operator's own tabs, an import's
   restore tab, the `about:blank` tab of the closing rule, a tab whose scope was lost. Also the
   browser's last window: before the receiver closes the browser's last tab, it opens an `about:blank`
   tab in that window, and it does one such removal at a time (measured: today an `end_scope` that
   removed the last tab ended Chromium, and two guarded removals at the same time did too).
5. **A short link drop (section 8).** The map and the scope rules stay. At each link up the relay reads
   the map (a new op, `bridge.tabScopes`), adds its entries to its model at once, and takes the tabs
   back into their scopes. A client that connects again sees its pages. Today it sees none (measured).
6. **A relay restart (section 9).** The new relay reads the map too, and it detaches every attached
   tab before it admits a client (measured: today the old client's `Fetch` pattern still holds a page's
   request, and its user-agent override stays).
7. **A daemon restart (section 10).** The receiver sees a link change, so section 8 applies. The
   daemon's first `set_scopes` names every live session, so the tabs of the others close.
8. **A browser restart, an extension reload, a worker restart (section 11).** With the unit's argv no
   tab of an earlier run opens again (measured), and the copy starts empty: nothing to close. With the
   operator's "Continue where you left off", the earlier pages open again as tabs of no scope: they
   fail closed and stay (a limit).
9. **A scope name that comes back (section 12).** The daemon leaves a scope that ended out of one
   answered `set_scopes` before it names that scope again.
10. **The build (section 14).** The work goes into part 1a (receiver, ab-v16.31) and part 2 (relay,
    ab-v16.35). The contract text of section 13 goes into the contract PR (ab-v16.30) while it is open,
    else into a small contract PR before part 1a. The relay's detach at each link up (decision 6) and
    a last-window guard need no new op and go into today's relay now (board ab-v16.40). aw-lead: three
    daemon rules (section 15).

## 2. Today, measured

The probe (part "today", two runs; part "worker", three runs; part "ids") drives the relay of this
checkout through a stand-in daemon, and the receiver 0.2.0 in its own Chromium. Each line names its
probe case. ab-lead's reviewer ran the probe again (review-48: the same results) and two checks of its
own (its rows name "review-48").

| What | Today | Case |
| --- | --- | --- |
| A link drop as at a daemon restart (the daemon side drops its socket for 3 s; the native host lives on and connects again) | Every client connection closes with 1011. The tabs stay open (4 of 4, the same ids and URLs) and detached. A new client of the same scope sees 0 targets and gets no `Target.targetCreated`. An `end_scope` of that scope then closes its connection and no tab. From the drop to a ready relay: 3.1 and 4.1 s. | A |
| A native port drop (the host process ends) | The receiver connects again after 1.1 s (its 1 s backoff; both runs). The same result as A: the tabs stay, a new client sees 0 targets. | A2 |
| A relay restart with no link change (the old relay's standard input ends; a new relay gets the link-up line and the list again) | The old client closes with 1001. Its tab stays open and **attached**. The new relay's client sees 0 targets. The old client's `Fetch` pattern still pauses the page's request: a `fetch()` got no answer in 5 s, the site saw no request, and the receiver sent `Fetch.requestPaused` to the new relay, which dropped it. The old client's user-agent override stays. An `end_scope` closes no tab. | B |
| `end_scope` when the scope's window is the browser's last window | The relay's `tabs.remove` closes the last window, and Chromium ends (exit 0). | F |
| The last-window guard with today's ops (`tabs.query`, then `windows.create` before `tabs.remove`) | One removal at a time: Chromium runs on. Two removals at the same time (two scopes end together): each read two tabs, neither opened a window, and Chromium ended (exit 0). | review-48 X2, X2b |
| `tabs.onRemoved` and the end of `chrome.tabs.remove` | The event comes before the call ends, 20 of 20. | review-48 X4 |
| A browser restart with the unit's argv (`about:blank`, no restore flag), after SIGTERM and after SIGKILL | No tab of the earlier run opens again; only the argv's `about:blank`. The site sees no request again. | E1, E2 |
| The same with `"session": {"restore_on_startup": 1}` in the profile (the "Continue where you left off" setting) | The earlier run's pages open again, in new tabs with new ids, and load again (2 more requests). | E3 |
| Tab ids of a new browser run | After SIGKILL, the new run's first tabs had the ids of the killed run's first tabs in 4 of 5 runs. After SIGTERM, no id came back (0 of 5). | ids |
| A worker stop (`Target.closeTarget` on the receiver's worker, as Puppeteer's `worker.close()`) | `chrome.storage.session` keeps its value. A DNR session rule stays. A value in the worker's memory is gone. The tab ids stay. The native port closes, and the receiver stays down: no connection in 10 s. A new tab (an extension event) starts the worker, and it connects 100 to 151 ms later (three runs). | C |
| An extension reload (`chrome.runtime.reload()` in the receiver's worker) | The receiver did not come back (no worker, no host connection, also after a new page; three runs, two of them with earlier forms of the case), and the profile held it with a disable reason. So the copy over a reload is not measured. | D |
| The worker idle for 6 min with its native port open | The worker keeps running: its memory value stays, and the host neither closes nor connects again. | G |
| `chrome.storage` in the receiver today | Absent: the manifest has no `storage` permission. The probe's copy of `agent/` adds it. | worker |

## 3. The options

- **a. The relay sweeps at its start or at a link up** (the task's option a). The relay closes the
  agent tabs that no live scope owns. It needs two facts that it does not have across its own restart:
  which tabs agents opened (its model is in memory only), and which scopes are live (today's `allowlist`
  line names none).
- **b. The receiver closes the agent tabs at a link drop.** Simple, but a short link drop then closes
  the pages of every live session. Refused (section 4; aw-lead agrees).
- **a′. The receiver sweeps at each `set_scopes` (chosen).** The receiver has both facts in the
  per-scope build: the map, and the live scopes of `set_scopes`.
- **c. The daemon keeps `end_scope` lines for the next relay.** Refused: the next relay's model has no
  tab after a link change or a restart (measured, A and B), so a kept line closes nothing.
- **d. A launch epoch per scope in `set_scopes`, kept with each tab.** Not chosen: section 12 orders the
  one case that needs it in the daemon, with no new field.

## 4. Who closes: the receiver, at each `set_scopes`

**Decision.** At each `set_scopes` the receiver closes every tab whose scope the new object gives no
list (C5's target: the scope's `scopes` entry is `null` or names a list that is not in `lists`, or the
scope has no entry and `default` gives no list), whatever its URL, `about:blank` too. It is a part of
C5's closing rule: the same `tabs.query`, the same window rule, the same queue (section 7), the same
count in `closed`, before the answer. The receiver does not sweep at a `set_scopes` whose `scopes` or
`lists` is not an object. After the sweep, the receiver checks each new entry of the map in the same
way (section 4.1).

Reasons:

- The receiver holds both facts: the map (which tab is in which scope) and `set_scopes` (which scopes
  have a list). The relay holds neither across its own restart.
- It works when no relay runs. Channel `main` does not need the relay. A session that ends while the
  relay is down loses its tabs at that `set_scopes`. A session that ends while the link is down loses
  them at the first `set_scopes` of the next connection.
- It needs no new message from the daemon. The daemon already sends `set_scopes` at each session start
  and end and after each link up (C4's target), and it sends the list again at each relay start
  (agentwatch `daemon/browser/service.py`: `announce()`, then `_push_allowlist()`).
- The answer comes after the tabs closed, and the daemon writes the `allowlist` line after the answer.
  The relay's snapshot of the map (section 8) comes either after the sweep, and then it lacks the
  closed tabs, or before it, and then the bridge is open on that link, so each `tabs.onRemoved` of the
  sweep reaches the relay before the answer, and so before the `allowlist` line. Chrome fires
  `tabs.onRemoved` before the `tabs.remove` call ends (measured by ab-lead's reviewer, review-48 check
  X4: 20 of 20), so the receiver drops the entry and sends the event before it counts the tab. In both
  orders the relay knows that the tabs are gone before it admits a client of the new lists.
- **"No list", not "not named".** With choice 5 b (a default list), a scope that `scopes` does not name
  has the default list and can be live (a program that agentwatch did not start). A rule "not named in
  `scopes`" would close its tabs at each `set_scopes`. With choice 5 a (assumed, ab-8zv) the two rules
  give the same result for every scope that has tabs.
- A live scope whose list is gone (its entry names a list that is not in `lists`) has no list either,
  so its tabs close. The relay closes its connections already (1008), and the closing rule closes its
  `http:`/`https:` pages already. The sweep also closes its `about:blank` tabs, so none of its tabs
  stays blocked with no owner.
- The relay's `end_scope` stays as it is: it closes the scope's connections and removes its tabs at
  once. The sweep is the guarantee; `end_scope` is the fast path.
- **No sweep at a `set_scopes` whose `scopes` or `lists` is not an object.** The contract applies such
  a field as an empty object and counts it in `refused` (C4, chrome-extension PR #15). Every scope then
  has no list, and a sweep would close every agent tab for one bad message. The rest of that
  `set_scopes` applies as the contract says, so the tabs fail closed until a valid one comes. The sweep
  and the check of section 4.1 use the last `set_scopes` whose `scopes` and `lists` are objects.

**Why not option b.** Link drops are short and frequent: a daemon restart (3.1 to 4.1 s from the drop to a
ready relay with a 3 s gap, case A), a native host that ends (1.1 s, case A2). Option b would close the
pages of every live session at each of them and lose their state: a filled form, a sign-in that runs, a
page that took many steps to reach. aw-lead agrees that a short link drop must not close them.

**Why not the relay as the sweeper.** The relay would need the receiver's map anyway, and the live
scopes from its `allowlist` line, and it sweeps only while it runs. The receiver needs neither.

### 4.1 A new entry after the sweep

A tab can get a scope after the sweep ran, and then no later sweep comes until the next `set_scopes`:

- a popup of a tab that the sweep closes (the page opens it while the sweep runs);
- a `tabs.create` or `windows.create` of a relay that has not handled `end_scope` yet;
- a `tabs.onReplaced` of a tab of such a scope.

**Decision.** The receiver checks each new entry against the last applied `set_scopes` (section 4):

- `tabs.create` and `windows.create` with a scope that it gives no list answer `ok:false` with the new
  error text `no list for this scope`, and create no tab. Until the first `set_scopes` after the
  worker's start every scope has no list, so the relay gets this error then too; it admits no client
  before its `allowlist` line anyway.
- A popup or a replaced tab whose scope it gives no list closes at once (in the queue of section 7,
  with the window rule), and the receiver sends no `bridge.tabScope` for it. Until the first
  `set_scopes` after the worker's start such an entry stays: the lists are not known yet, and that
  `set_scopes` sweeps it when its scope has no list.
- **A popup whose opener is not in the map.** The receiver keeps each entry that leaves the map for
  `TOMBSTONE_MS = 10000` ms, in memory (with choice 3, a mark too). A popup whose `sourceTabId` has
  such an entry takes its scope (or mark), as if the opener were still open, and the check above
  applies. So a popup of a tab that the sweep closed a moment before closes too, and a popup of a
  page that closes itself right after `window.open` keeps its scope. A popup whose opener has neither
  an entry nor such a kept entry gets no scope, as in the per-scope design: it fails closed, no
  connection sees it, and the sweep never closes it; C5's closing rule closes its `http:`/`https:`
  page when no list covers its host (a limit, section 16). Measured in the per-scope probe:
  `webNavigation.onCreatedNavigationTarget` comes 0 to 1 ms after Chrome creates the tab, so 10 s is a
  wide margin.

Reasons: without the check such a tab stays blocked and unowned until the next `set_scopes`, which can
be hours later. A refusal of the op keeps the tab from being made at all.

## 5. Which tabs are agent tabs: the map, kept

**Decision.** A tab is an agent tab when it has a scope in the receiver's map: the relay opened it with
a scope (`tabs.create`, `windows.create`), or it is a popup or a replacement of such a tab (the
per-scope design, section 5). The map holds the same entries as in that design. It changes in two ways:

1. **The map stays at each disconnect and each new daemon connection.** The scope rules stay with it
   (section 8 gives the reason). Only a tab's close, the sweep and the worker's start remove entries,
   besides the ops and events of the per-scope design.
2. **The receiver keeps a copy in `chrome.storage.session`**, one key per tab (`tab:<id>`, the scope as
   its value). It writes a tab's entry at the same time as the rule update that the new entry starts,
   not before it. The op that gives the tab its scope (`tabs.create`, `windows.create`) answers when
   both ended. The `bridge.tabScope` event of a popup or a replaced tab goes as soon as the entry is in
   the map, as in the per-scope design. The receiver removes the key when the tab leaves the map.
   **The order at the worker's start:** the receiver removes every session rule (as the per-scope
   design says), reads the copy, keeps the entries of the tabs that exist (`chrome.tabs.query`) and
   drops the others, and only then connects its native port (its hello). Every handler that reads or
   writes the map (the popup's `webNavigation.onCreatedNavigationTarget`, `tabs.onReplaced`,
   `tabs.onRemoved`, the ops) waits for the restore to end. The reason: Chrome starts a stopped worker
   for an event (measured, case C: a new tab), and that event's handler would otherwise run before the
   read ends. The kept tabs fail closed until the next `set_scopes`. That comes soon: a worker's start
   is a link change, and the daemon sends `set_scopes` after each link up.

Reasons:

- The scope is the mark. The receiver already sets it at the only moments when it knows that a tab is
  an agent's: when the relay opens the tab, and when an agent tab opens a popup.
- `chrome.storage.session` stays over a worker stop (measured, case C) and starts empty at a browser
  restart (Chrome's rule for the area). It needs the `storage` permission: the receiver has none today
  (measured: `chrome.storage` is absent). Chrome shows no install warning for `storage`, and agentwatch
  loads the receiver with `--load-extension`, so no prompt comes. Its default access level,
  `TRUSTED_CONTEXTS`, keeps it from content scripts: a script that the import injects cannot read it.
  An entry is about 40 bytes; the area holds 10 MB.
- **The epoch check of the map's writes.** The per-scope design drops a map write of an op or an
  event that started before the last reset. With the map kept, a link change is no reset of the map:
  a `tabs.create` of the old relay that ends after the link change still puts its tab into its scope.
  The old relay never gets the answer (C10 drops it), but the next relay gets the tab in its snapshot,
  as a free tab of the scope, and the sweep closes it when the scope ends. If the write were dropped,
  the tab would have no scope: blocked, seen by no connection, never closed. So the check drops only
  a write for a tab that no longer exists, and a write from before the worker's start (that worker
  is gone).
- A worker stop between a change and the end of its write loses at most that one change. A tab with
  no entry is a tab of no scope after the restart: it fails closed and never closes by the sweep
  (section 16). An entry of a tab that closed meanwhile goes at the restore. Part 1b's live test
  measures the delay of `bridge.tabScope` with the write in place (it must still come before the
  popup's `tabs.onCreated`).
- **Not `chrome.storage.local`.** It stays over a browser restart, and the tab ids of a new run can
  repeat the ids of a run that Chrome did not end cleanly (measured, case ids: 4 of 5 runs after
  SIGKILL). A new tab would then get an old tab's scope.
- **Not the tab's opener.** A tab that the relay opens has no opener (an extension's `tabs.create` and
  `windows.create` set none), and the operator's own tab has none either. Only popups have one, and
  their opener can close first.
- **Not a page's `sessionStorage`.** The site can read, change and clear it. It belongs to the page's
  origin, not to the tab, so a navigation to another origin loses it. A value there also shows the
  agent browser to the site, against the anti-detect goal.

## 6. Which scopes are live

**Decision.** In the per-scope build, the `scopes` of `set_scopes`, with `default` (C4's target). The
receiver gets the object on channel `main`; the relay gets the same object in its `allowlist` line.
Before the per-scope build, nothing: the gap stays documented (agentwatch) until parts 1a, 2 and 3 are
pinned together.

Reasons:

- `set_scopes` already holds only the live sessions (C4's target: "So `scopes` holds only the live
  sessions"). The daemon sends it at each change.
- Today the `allowlist` line names no scope, and `end_scope` is the only signal of a session's end. The
  daemon drops `end_scope` when no relay runs (agentwatch `service.py`: "the lines are not kept"). A
  fix before the per-scope build would need a new daemon line and a map in the receiver: most of parts
  1a and 2, built twice.
- A new receiver refuses the old `set_allowlist`, so agentwatch pins parts 1a, 2 and 3 at once anyway
  (the board's rule for every receiver part).

## 7. What never closes

**Decision.** The sweep closes only tabs that have a scope. And no closing path of the receiver closes
the browser's last window.

- Tabs of no scope never close by the sweep: the operator's own tabs, marked or not (choice 3); an
  import's restore tab (C6: it has no scope); the `about:blank` tab that the closing rule opens; a tab
  from before the worker's start whose entry the copy does not hold (section 11). C5's closing rule
  still closes such a tab when its `http:`/`https:` host is off its list (the union of the lists for a
  tab of no scope), as in the per-scope design.
- **The browser's last window.** Measured (case F): today's `end_scope` removed the only tab of the
  browser's last window, and Chromium ended (exit 0). With one window per page (ab-v16.28) the agent's
  windows are the only ones once the operator closes the start window. So the receiver's `tabs.remove`
  op follows the window rule of C5's target: when the tab is the browser's last tab, the receiver first
  opens an `about:blank` tab in that window (not active, no scope), as C5's closing rule does. That
  covers the relay's `end_scope`, a client's `Target.closeTarget` (Playwright's `page.close()`), and
  the sweep, which is a part of the closing rule.
- **One removal at a time.** The `tabs.remove` op, the closing rule and the sweep run in one queue in
  the receiver: one query and its removals at a time. Measured by ab-lead's reviewer (review-48, check
  X2b): two guarded removals at the same time each read two tabs, neither opened a tab first, and
  Chromium ended (exit 0); one at a time kept it running (X2).
- Before part 1a, today's relay keeps the last window with today's ops (board ab-v16.40,
  chrome-extension PR #16): before each `tabs.remove` (`end_scope`, `Target.closeTarget`) it sends
  `tabs.query` with `{}`, and when the tab is the browser's only tab it first opens a window with
  `windows.create` and `{"url":"about:blank","focused":false}`; it does one such query and removal at
  a time. In the per-scope build that guard moves into the receiver, because `windows.create` then
  needs a scope and would put the new window into it.

## 8. A short link drop

**Decision.** The receiver keeps the map and the scope rules over a link drop. At each link up the
relay reads the map and takes the tabs back into their scopes before it admits a connection.

The receiver:

- keeps the map, the scope rules, the marks, the last `operator` value and rule 8 at each disconnect
  and each new daemon connection;
- still does the rest of C10's cleanup: it drops the answers of the old link, turns the eager attach
  off, releases every hold and detaches every bridge tab. So no domain state of an old client stays.

The relay, at each link up, in this order, before it admits a connection:

1. `bridge.info`, as today.
2. The new op `bridge.tabScopes`: args `[]`, the result `[{"tabId":<id>,"scope":"<scope>"}]` (every
   entry of the map), the default wait, the shared in-flight key. When it answers, the relay adds each
   entry to its model at once: its scope, no owner, not attached, not held, no target id yet. Every
   later event applies at once (a `tabs.onRemoved` drops an entry; a `bridge.tabScope` adds one).
3. `debugger.getTargets`: the relay gives each entry of step 2 its target id, and drops each entry of
   step 2 whose tab the answer does not list (the tab closed).
4. `debugger.detach` of every tab that step 3 reports attached (section 9). It ignores the errors (the
   restore tab answers `not an agent tab`).

Then it waits for the `allowlist` line, as today. The 503 text stays "its extension is not connected"
until step 4 ends. A tab with no target id yet is in no client's view (as in the model today).

Reasons:

- A page can navigate by itself while the link is down: a redirect, the callback of a sign-in, a
  `meta refresh`. With its rules kept it stays under its own list. With the rules removed it would fail
  closed and show an error page. The daemon's first `set_scopes` after the link up replaces the rules
  in full, so a list that changed during the drop applies then. A daemon that knows nothing new sends
  the same lists.
- The client's connection still closes at the drop (1011). The relay cannot keep a CDP session over the
  receiver's detach. Playwright's `connectOverCDP` and the Playwright MCP connect again, and then
  `Target.getTargets`, `Target.setDiscoverTargets` and `Target.setAutoAttach` give them the tabs of
  their scope (`context.pages()`). Today they see none (measured, cases A and A2).
- The snapshot needs no merge logic. The receiver answers from its map at the moment of the answer, and
  it sends its events in order. An event that came before the answer is already in the snapshot; every
  later event applies on top of it, at once. If the relay added the entries only after step 3, a
  `tabs.onRemoved` between the two steps would find no entry, and a closed tab would enter the model.
- An op, not a burst of `bridge.tabScope` events: with an op the relay knows when it has the whole map.

## 9. A relay restart

**Decision.** The relay detaches every attached tab at each link up (steps 3 and 4 of section 8). It
reads the map as at any link up.

Reasons:

- The daemon restarts a relay that ended (its backoff), with the link up. It turns the eager attach off
  (agentwatch `service.py`), but the receiver sees no link change, so C10's cleanup does not run.
- Measured (case B): the old relay's tab stayed attached, and the old client's domain state stayed. Its
  `Fetch` pattern paused the page's next request, which never reached the site (the new relay dropped
  the `Fetch.requestPaused` of a tab that it did not know). Its user-agent override stayed. A page
  of a live session would hang after each relay restart.
- The relay cannot tell a restart from a link change: the daemon writes the link-up line to each new
  relay. It does not need to. After a real link change the receiver has already detached every tab,
  and `debugger.detach` of a tab that is not a bridge tab answers `null`.
- Steps 3 and 4 use existing ops (`debugger.getTargets`, `debugger.detach`), so they need no new op and
  can go into today's relay before the per-scope build (section 14).
- The sweep: the daemon sends the list again at each relay start, so a session that ended while the
  relay was down loses its tabs then.

## 10. A daemon restart

**Decision.** For the receiver a daemon restart is a new daemon connection (its native host lives on
and connects again), so section 8 applies. The daemon's first `set_scopes` on each connection names
every live session.

Reasons:

- A scope that this `set_scopes` leaves out loses its tabs. So the daemon sends it only after it has
  read its sessions (aw-lead, section 15).
- A session that ended while the daemon was down is not in that `set_scopes`, so its tabs close then.
  It needs no `end_scope`, and the daemon's rule "the lines are not kept" stays right.

## 11. A browser restart, an extension reload, a worker restart

- **A browser restart.** With the unit's argv (`about:blank` and no restore flag), no tab of an earlier
  run opens again, after SIGTERM or SIGKILL (measured, E1, E2). The copy starts empty. Nothing is left
  to close.
- **"Continue where you left off".** The operator can turn it on in the live view's settings. Then the
  earlier run's pages open again, in new tabs with new ids, and load again (measured, E3). They are
  tabs of no scope: blocked, not seen by any connection, never closed by the sweep. C5's closing rule
  closes those whose host no list covers. A limit (section 16). If agentwatch wants none of them, the
  unit can write `"session": {"restore_on_startup": 5}` into the profile's preferences at each start,
  as it writes the download preferences today (an option for aw-lead, section 15).
- **An extension reload.** Not measured: `chrome.runtime.reload()` left the receiver disabled in the
  probe (case D), so it never came back to read its copy. The design does not depend on it. If the
  copy goes at a reload, the earlier tabs are tabs of no scope: they fail closed and stay (a limit).
  agentwatch loads a new receiver with a browser restart ("`agentwatch browser stop` and `start` load
  the new one"), so a reload comes only from the operator's extensions page.
- **A worker restart.** It is rare: with its native port open the worker does not stop when idle
  (measured, G: 6 min). The copy and the session rules stay over a stop (measured, C). The receiver
  removes every session rule at its start anyway (the per-scope design), restores the map from the copy
  before it connects its native port (section 5), and the next `set_scopes` puts the rules back. A side
  fact, outside this design: after a worker stop the receiver stays down until an extension event comes
  (measured, C: no connection in 10 s; 100 to 151 ms after a new tab), so that link drop can last long
  in an idle browser.

## 12. A scope name that comes back

**Decision.** A scope that ended stays out of at least one `set_scopes` that the receiver answered `ok`
(with a default list, choice 5 b: it is `null` there) before any `set_scopes` names it again.

Reasons:

- Scopes are session names, and a later session of the same name is a new session (C11's target: "A
  later session of the same name never gets an old key").
- With the map kept, a session that ended while the link was down, and a new session of the same name
  that the first `set_scopes` after the link up names, would share the old tabs. The new session would
  see the pages of the old one.
- In the normal flow each session's end sends a `set_scopes` without it, so the rule asks for nothing
  more. Only when an end and a new launch of the same name fall into one link-down gap, or into one
  merged update, does the daemon send one more `set_scopes` (without the scope) and wait for its
  answer first.
- Not an epoch in `set_scopes` (option d): a new field, its vectors, and a stamp on each tab of the map,
  for a case that the daemon can order away.

## 13. The contract change

Each change goes into chrome-extension `docs/protocol.md`. The per-scope parts go into the blocks
marked "Target (board ab-v16.23)" (so into the contract PR, ab-v16.30, while it is open; in its PR #15
those blocks become the contract text); the first three items change today's text. The shared vectors
change with them.

**Today's text (board ab-v16.40, chrome-extension PR #16, already holds the first two).**

- C10, "The daemon and the relay": at each link up, before it admits a connection, the relay sends
  `debugger.getTargets` and `debugger.detach` for each tab that the answer reports attached, and
  ignores the errors. The reason is case B (a relay that starts with no link change finds the tabs of
  the relay before it still attached, with the domain state of their clients).
- C11, "When a connection ends": the relay never closes the browser's last window. Before each
  `tabs.remove` (`end_scope`, `Target.closeTarget`) it sends `tabs.query` with `{}`; when the tab is
  the browser's only tab, it first opens a window with `windows.create` and
  `{"url":"about:blank","focused":false}`. It does one such query and removal at a time (measured,
  review-48 check X2b: two at the same time ended Chromium). In the per-scope build the receiver's
  `tabs.remove` does this (C10's target), and this bullet goes.
- C11, "Before the upgrade", readiness: "The relay is ready while the link is up, an `allowlist` line
  came after that, `bridge.info` answered with `bridge` 1 or more, and the detaches of the link up
  (C10) are done."

**C10's target, the map.** In place of the bullet "A tab leaves the map when it closes. At each
disconnect and each new daemon connection ... (the marks go).":

> - A tab leaves the map when it closes. The map stays at each disconnect and each new daemon
>   connection, with the scope rules, the marks, the last `operator` value and rule 8 (C5's target):
>   a link drop or a daemon restart does not take a live session's tabs out of their scope.
> - The receiver keeps a copy of the map in `chrome.storage.session` (permission `storage`, access
>   level `TRUSTED_CONTEXTS`), one key per tab (`tab:<id>`, the scope as its value). It writes a
>   tab's key at the same time as the rule update of the new entry; the op that gives the tab its
>   scope answers when both ended, and `bridge.tabScope` goes as soon as the entry is in the map. It
>   removes the key when the tab leaves the map. At its worker's start, in this order, it removes
>   every session rule (rule 8 too; the marks go), reads the copy, keeps the entries of the tabs that
>   exist and drops the others, and then connects its native port. Every handler that reads or writes
>   the map waits for that restore. The kept tabs fail closed until the next `set_scopes`. The copy
>   never goes to `chrome.storage.local`: the tab ids of a new browser run can repeat those of a run
>   that Chrome did not end cleanly (measured).
> - A new entry after the last applied `set_scopes` (the last one whose `scopes` and `lists` are
>   objects): `tabs.create` and `windows.create` with a scope that it gives no list answer `ok:false`
>   with `no list for this scope` and create no tab (also before the first `set_scopes` after the
>   worker's start); a popup or a replaced tab whose scope it gives no list closes at once (C5's
>   window rule and queue) and gets no `bridge.tabScope` (before the first `set_scopes` after the
>   worker's start it stays, and that `set_scopes` sweeps it).
> - The receiver keeps each entry that leaves the map for `TOMBSTONE_MS = 10000` ms, in memory. A
>   popup whose `sourceTabId` has such an entry takes its scope, as if the opener were still open. A
>   popup whose opener has neither gets no scope.

In the bullet "Every other tab has no scope", "a tab from before the link" becomes "a tab from before
the worker's start whose entry the copy does not hold". The bullet "No stale entry" becomes: "No stale
entry: the receiver writes a scope only for a tab that exists. A write of an op or an event that
started before a link change still applies (the map stays), so a tab that the old relay opened keeps
its scope and the next relay gets it from `bridge.tabScopes`."

**C10's target, a new op** (a row of the ops table, and a vector):

> | `bridge.tabScopes` | `[]` | `[{"tabId":<id>,"scope":"<scope>"}]` | `WAIT_DEFAULT_MS` | The receiver's own op: every entry of the map at the moment of the answer. |

and one bullet: "At each link up, after `bridge.info`, the relay calls `bridge.tabScopes` and adds
each entry to its model at once, with its scope and no owner; later events apply at once. Then
`debugger.getTargets` gives each of these entries its target id, and the relay drops each of them
whose tab the answer does not list. Then the detaches above. Only then does it admit a connection.
Its key in `MAX_IN_FLIGHT_PER_TAB` is the shared key."

**C10's target, `tabs.remove` and the error texts.** `tabs.remove`: "When the tab is the browser's
last tab, the receiver first opens an `about:blank` tab in that window (not active, no scope), as C5's
closing rule does, so that Chrome does not end (measured: an `end_scope` that removed the last tab
ended Chromium). The op runs in the queue of C5's closing rule: one query and its removals at a time."
The receiver's error texts get `no list for this scope` (`tabs.create`, `windows.create`).

**C5's target.** In the rules bullet "At each disconnect and each new daemon connection the receiver
removes the scope rules (C10's target) and keeps the marks ...": "At each disconnect and each new
daemon connection the receiver keeps every session rule, the map and the marks (C10's target); the
next `set_scopes` replaces the scope rules and rule 8 in full. At its worker's start every session rule
goes (rules 6, 7 and 8 too)." One bullet more after the closing rule:

> The sweep: on each `set_scopes` the receiver also closes every tab whose scope the new object gives
> no list (its `scopes` entry is `null` or names a list that is not in `lists`, or it has no entry and
> `default` gives no list), whatever its URL, with the same window rule and the same count in
> `closed`. With `default` `null` that is every tab of a session that ended, also of one that ended
> while the link was down or while no relay ran. A tab of no scope never closes by the sweep. The
> receiver does not sweep at a `set_scopes` whose `scopes` or `lists` is not an object. The closing
> rule, the sweep and `tabs.remove` (C10) run in one queue: one `tabs.query` and its removals at a
> time (measured: two guarded removals at the same time ended Chromium).

**C4's target.** In the `set_scopes` bullet "At a session's end the daemon writes `end_scope` ...":
"The receiver then closes the scope's tabs (C5's sweep), also when no relay runs. The daemon's first
`set_scopes` on each connection names every live session: a scope that it leaves out loses its tabs. A
scope that ended stays out of (with a `default` list: is `null` in) at least one `set_scopes` that the
receiver answered `ok` before a `set_scopes` names it again. With a `default` list, the daemon drops the
`null` entry after the receiver answered `ok` to a `set_scopes` that holds it (the tabs are closed
then), in place of the 60 s and the next link up." In the rollout bullet, after "until the receiver's
worker starts again": "The scope rules stay at a link change too, so after such a rollback the tabs of
the last scopes keep their lists, and nothing closes them, until the worker starts again."

**C11.** "When a connection ends", the link-drop bullet: "The model starts again at the next `link`
up" becomes, in the target: "The model starts again at the next `link` up with the tabs of the
receiver's map (C10's target): a scope's tabs stay open over a link drop and over a relay restart, and
a client of the scope that connects again sees them." The `end_scope` bullet, in the target: "The
receiver's sweep closes them too, at the daemon's next `set_scopes` (C5's target)." Readiness, in the
target: "... and the steps of the link up are done (C10's target: the detaches and
`bridge.tabScopes`)."

**Vectors.** `test/vectors/bridge.json`: the op `bridge.tabScopes` (its args and its result shape),
and the error `no list for this scope` of `tabs.create` and `windows.create`. `test/vectors/scopes.json`
(new in ab-v16.30): the sweep cases (a scope not named with `default` `null`; named `null`; a list that
is not in `lists`; a scope not named with a `default` list, which does not close; `scopes` or `lists`
not an object, which sweeps nothing).

## 14. The build split

The work fits into parts that exist; it adds no new part. Each row adds its lines to the part's task.

| Part | What this design adds | Tests |
| --- | --- | --- |
| Contract (ab-v16.30, open) | The text of section 13 and its vectors. If ab-v16.30 merges first: a small contract PR "ab-v16.39 contract" before part 1a. Before it merges, ab-lead mails aw-lead its commit (C4 is a daemon rule). | `npm test` (the vectors) |
| 1a. Rules and map (ab-v16.31) | The map and the scope rules kept at each link change (in place of "its reset at each link change"); the `storage` permission and the copy in `chrome.storage.session`, one key per tab, written with the rule update; its restore at the worker's start before the native port connects, and the handlers that wait for it; the sweep at `set_scopes` (none for a bad `scopes` or `lists`); the check of each new entry and the error `no list for this scope`; the kept entries of `TOMBSTONE_MS`; the window rule in `tabs.remove` and the one queue of removals; the op `bridge.tabScopes`. | Unit tests with the fake chrome (it needs `storage.session`), also: two removals at the same time keep the last window; an event that starts the worker waits for the restore. The live test: a tab of scope S stays over a link drop and keeps its rule; after a `set_scopes` without S it closes; then a `tabs.create` of S gets the error; a tab of no scope and the restore tab stay; the last window stays, also with two removals at the same time. |
| 1b. Popups and the retry (ab-v16.32) | A popup of a scope with no list closes at once; a popup of an opener that left the map takes the kept entry. | Its live test also measures the delay of `bridge.tabScope` with the write of the copy in place. |
| 2. The relay (ab-v16.35) | Steps 2 and 3 of section 8 (`bridge.tabScopes`, the entries added at once, the target ids, the drop of closed tabs) and readiness after them; the error `no list for this scope` passed to the client of `Target.createTarget`. | Unit tests with the fake bridge (a snapshot with events before, between and after the steps); the live test of the task: a session ends while the relay is down, the relay starts, and its tabs close; a live session's tabs survive a link drop, and a client that connects again sees them. |
| Today's relay (ab-v16.40, chrome-extension PR #16 for its text) | Steps 3 and 4 of section 8 without step 2: the detach of every attached tab at each link up; the last-window guard of section 7 with today's ops, one at a time; the three items of today's text. It matters when agentwatch's stage 4 (ab-v16.7) ships agent mode before the per-scope build. | Unit tests with the fake bridge; the probe's cases B and F, and review-48's X2b: after a relay restart the page's `fetch()` loads; after `end_scope` of the last window Chromium still runs, also with two removals at the same time. |

Folding into 1a costs less than a part of its own: 1a would otherwise build the map's reset at each
link change, and the next part would take it out again. If ab-lead wants 1a to stay as it is, the 1a
and 2 rows above make one small receiver part and one small relay part after them, with the same tests.

## 15. What needs aw-lead (the daemon)

1. **The first `set_scopes` on each connection names every live session.** After a daemon start, the
   daemon sends it only after it has read its sessions. A partial `scopes` closes the tabs of the
   sessions that it leaves out.
2. **A scope name that comes back.** A scope that ended stays out of (with choice 5 b: `null` in) at
   least one answered `set_scopes` before any `set_scopes` names it again (section 12). Only a session
   end and a new launch of the same name inside one link-down gap, or one merged update, need the extra
   `set_scopes`.
3. **Choice 5 b only.** The `null` entry of an ended scope drops after an `ok` answer to a
   `set_scopes` that holds it, not at the next link up: else a scope that ended while the link was down
   falls back to the default list, and its tabs stay.
4. `end_scope` stays as today; no queue for a relay that is not running.
5. The stage-4 note of the gap can go when the parts of section 14 are pinned.
6. An option, not a need: the unit writes `"session": {"restore_on_startup": 5}` at each start, so
   "Continue where you left off" cannot bring back tabs of no scope (section 11).

aw-lead's answer for a session that ended while the daemon was down (mail m1c19e2a, through ab-lead,
after review-48):

- **Rule 2 holds over a daemon restart, with no daemon memory.** No agentwatch session launches while
  the daemon is down: the daemon spawns them, and the CLI, the web viewer and cron go through the
  gateway to the daemon. A tmux session started by hand is no agentwatch session and has no scope.
  After its start the daemon sends its first `set_scopes` after its first complete read of the
  sessions, so it names only the live ones, and no launch's scope enters a `set_scopes` before that
  first one is answered `ok`.
- **Rule 3: the `null` entries live in the daemon's memory only** and do not survive a daemon
  restart. With choice 5 a (`default` `null`, as ab-8zv assumes) that does not matter: a scope that
  `set_scopes` does not name has no list, so the sweep closes its tabs. With choice 5 b the daemon
  would need the scopes of the receiver's map at each link up (from `bridge.tabScopes`, or a field in
  an answer) and would send `null` for each of them that is no live session. aw-lead prefers 5 a and
  no daemon file, and builds that read in part 3 only if the operator takes 5 b.

## 16. The limits

- A tab of no scope never closes by the sweep: a page of a restored session ("Continue where you left
  off"), a tab whose entry was lost at a worker stop or an extension reload. It fails closed and stays
  until the operator closes it, or C5's closing rule closes it (its host off the union of the lists).
- A tab of an ended session lives on until the next `set_scopes` that the receiver answers. While the
  link is down that is as long as the drop, and the tab keeps its rules: a page of it can navigate
  within its old list, with nobody to drive it.
- After a rollback to a daemon from before the per-scope build, no `set_scopes` comes, so the kept
  tabs keep their scopes and lists until the receiver's worker starts again.
- A worker stop between a map change and the end of its write to the copy loses that change
  (section 5).
- With choice 5 b (a default list), a scope that ended while the daemon was down is not named after
  the restart, so it falls back to the default list, and the sweep does not close its tabs. Only the
  map read of section 15 closes that gap, and aw-lead builds it only if the operator takes 5 b. With
  choice 5 a (assumed, ab-8zv) the gap does not exist.
- A popup whose opener left the map more than `TOMBSTONE_MS` before, or whose opener the map never
  held, gets no scope: it fails closed, no connection sees it, and the sweep never closes it (section
  4.1).
- The relay still closes every client connection at a link drop (1011). A client must connect again to
  get its pages back; its CDP sessions do not stay.

## 17. The evidence

The probe and its results: [2026-11-05-orphan-agent-tabs-probe/README.md](2026-11-05-orphan-agent-tabs-probe/README.md).
Not measured: the target itself (no receiver or relay code of the per-scope build exists yet); Google
Chrome stable (the agent Chrome on taylor will be Chrome stable); the Mac.
