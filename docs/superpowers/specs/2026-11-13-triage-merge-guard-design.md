# The agent browser refuses to merge a PR that agentwatch's issue triage opened — design

Date: 2026-11-13. Board: ab-v16.99 (P2), parent ab-v16 (the two modes). Source: the operator's answer on agentwatch's
board (item age-zbo, 2026-11-12 16:52Z; issue triage age-36g), passed on by the daemon lead. Contract: C11, "The merge
guard" (`docs/contracts/C11.md`); the receiver's part: chrome-extension C10 (`bridge.mergeGuard`) and C5 (the merge
guard's floor).

## 1. The rule

> No PR from automatic issue triage is allowed to be merged, even if i've already given agents authorization to merge
> to staging.

> Turn triage on only after the browser path is closed: triage waits until the agent browser refuses triage PRs (after
> stage 3).

agentwatch's hook guard stops an agent's `gh` and API merge commands (agentwatch's issue triage design, section 10.3).
An agent in the agent browser, with the operator's GitHub sign-in in its profile, could still merge such a PR on its
page. This design closes that path: the browser path only (an agent's input, and the page's own requests); agentwatch's
hook covers `gh` and the API from a shell. The refused actions are the same as agentwatch's own merge hook's: merge (each
method), Ready for review, auto-merge (enable) and approve.

**The marker** (the lead's message of 2026-11-13: the manager's decision, with the daemon lead's strings; agentwatch's
merge hook uses the same definition). A PR is marked when any one holds:

- one of its labels equals `agentwatch-triage` or `triage`, compared without case (GitHub compares label names without
  case);
- its title starts with `[agentwatch triage]` or `[triage]`, compared without case, with no trailing space needed;
- its head branch starts with `agentwatch-triage/` (an extra sign).

The bare forms `triage` and `[triage]` are there because hand-started triage PRs carry them; agentwatch's built feature
uses `agentwatch-triage` and `[agentwatch triage]` (its issue triage design, branch `spec/36g-issue-triage`, section 10.2,
also makes every triage PR a draft whose body's first line is "Opened by agentwatch issue triage for #<n>. Only the
operator merges this PR."). A false match only refuses a merge, the safe side of the operator's rule. The code keeps the
strings in one definition, `TRIAGE_MARKER` in `src/relay/merge-guard.ts`, and each form has its own test and its own
mutation row.

## 2. How the browser knows that a PR is marked

The browser never asks GitHub on its own and holds no token. It reads GitHub's own answers that pass through an agent's
tab: the model keeps `Fetch` on in each tab that a client holds, and at Fetch's response stage it reads the body
(`Fetch.getResponseBody`) of each 2xx answer of a PR's URL:

- the web: `/<owner>/<repo>/pull/<n>` and each sub-path (`files`, `commits`, `checks`, a page's JSON parts), and
  `/<owner>/<repo>/issues/<n>` (the same number space);
- the API host `api.<host>`: `/repos/<owner>/<repo>/pulls/<n>` and `/repos/<owner>/<repo>/issues/<n>`.

The verdicts:

- **Marked.** The text shows a form of the marker (`MARKER_FORMS`): a label as its own link (`/labels/<name>`), its
  `data-name`, its JSON `"name"` or a search's `label:<name>`, with the name ending there (so `needs-triage` and
  `triaged` are no label `triage`); a title prefix at the start of the page's `<title>`, of an element's text, of a
  `title` attribute or of a JSON `"title"`; the head branch's prefix anywhere; each also with its characters escaped
  (`%2D`, `%20`, `%2F`, `%5B`, `&#45;`, `&nbsp;`, or a JSON unicode escape). A bare word "triage" in a text is no marker:
  it is only one as a label's name. A PR's page shows its title, its labels and its head branch in its header. A marked
  PR stays marked for the model's life: an edit of the label or the title later cannot unmark it in the browser.
- **Unmarked.** Only the PR's own page (the conversation, `files`, `commits` or `checks`: they all show the header),
  as HTML that names the PR's own path, or the API's object of the PR (JSON with its `number`), with no marker. A part
  of a page (JSON of one box) can mark, never unmark: it may not show the header.
- **Unknown.** Every other PR.

The model also keeps the GraphQL node ids (`PR_...`, and the legacy `MDExOlB1bGxSZXF1ZXN0...`) of each marked PR's
answers, because GitHub's own pages name a PR by its node id in their GraphQL requests.

The verdicts are browser-wide (a PR is the same for every scope). They are keyed by host, so a page of the test host
(the stand-in of section 9) can mark or unmark only a PR of the test host, never one of GitHub.

**When the browser cannot tell, it refuses** (it fails closed, to the operator's rule's side). The rule allows no
agent's merge of a triage PR; a merge that went cannot be undone by the browser; and a refused merge of another PR costs
the agent one more step: load the PR's page, then try again. The same side holds for a false marker: a PR whose page
names a marker for another reason (a PR about the triage feature itself) counts as marked, and its merge in the agent
browser is refused; the operator, or an agent with `gh` under agentwatch's own guard, merges it.

**The Playwright pairing** (measured in the live check's first runs): a client that intercepts (Playwright's
`page.route`) pairs each `Network.requestWillBeSent` with a `Fetch.requestPaused` before it makes a request object. A guard
that kept GitHub's pauses from the client stalled Playwright's navigation on a GitHub page. So the model judges (and, for a
PR's answer, reads) each paused request of a guarded host first, and then gives it to a client whose own patterns ask for
it: an allowed request may go on or be answered, but not be changed (`url`, `method`, `postData`, `headers`); a refused
write's `continueRequest` becomes the model's 403.

## 3. What a write is, and the judge

A **write** is a request to a guarded host whose method is not `GET`, `HEAD` or `OPTIONS` (GitHub changes nothing on a
GET). Every merge-type action ends in a write: the classic merge box's form `POST /<o>/<r>/pull/<n>/merge`, its Ready for
review and auto-merge actions, the React merge box's `POST /_graphql`, a script's `fetch`, an XHR or a beacon, a REST
call to `api.github.com`, a GraphQL mutation to `api.github.com/graphql`. The model judges each write, in this order:

1. **The page.** The tab's page (its last top URL: `tabs.onUpdated`, or the top frame's document request) or the
   request's `Referer` is a PR page that is marked or unknown: refused. So on a triage PR's page no write leaves the tab:
   no merge, Ready for review, auto-merge, comment, review, label or title edit, close. This also stops the browser path
   that would unmark a PR first (remove its label, edit its title) and then merge it.
2. **The PR that the request names.** Its URL names a marked PR (web or API, also by its issue number), or its URL or
   body names a node id of a marked PR: refused.
3. **A merge of branches or a write of a ref** (`/repos/<o>/<r>/merges`, `/repos/<o>/<r>/git/...`, `git-receive-pack`,
   GraphQL `mergeBranch`, `updateRef`, `updateRefs`): refused; it never names a PR, so it cannot be tied to an unmarked
   one.
4. **A merge-type action of a PR** (a path segment after `/pull/<n>/`, or the API's `/pulls/<n>/`, that holds `merge`,
   `ready`, `queue` or `review`: `merge`, `merge_queue`, `auto_merge`, `ready_for_review`, `enqueue`, `reviews` (an
   approve); the API's `/pulls/<n>/merge` and `/pulls/<n>/reviews`): it goes only when the PR is known unmarked. **A merge on no PR** (a path segment that holds `merge` or `enqueue`, for example a fork's
   `fetch_and_merge`): it goes only from a known-unmarked PR's page.
5. **A GraphQL write** (a path whose last segment holds `graphql`): refused when Chrome did not give its body (or the
   body is larger than 1 MiB); when its body names `mergePullRequest`, `enablePullRequestAutoMerge`,
   `enqueuePullRequest`, `markPullRequestReadyForReview`, `addPullRequestReview`, `submitPullRequestReview`,
   `mergeMethod` or `APPROVE` (a persisted query keeps its variables), it goes only from a known-unmarked PR's page.
6. Every other write goes.

## 4. Every path, and what stops it

| Path | Layer 1 (the model's `Fetch`) | Layer 2 (the receiver's floor) |
| --- | --- | --- |
| The merge box's buttons and forms (merge, squash, rebase; Ready for review; auto-merge; the merge queue) and the review's approve: their form POSTs | the page rule (1), and the PR rule (2, 4) | blocks every write of a tab where layer 1 is off |
| A page script's `fetch`, XHR, beacon to a github.com endpoint | the same | the same |
| The React merge box's GraphQL (`/_graphql`, a persisted query) | the page rule (1); the node id (2); the GraphQL rule (5) | the same |
| GraphQL mutations `mergePullRequest`, `markPullRequestReadyForReview`, `enablePullRequestAutoMerge`, `enqueuePullRequest`, `addPullRequestReview`, `submitPullRequestReview` (also on `api.github.com/graphql`) | 1, 2, 5 | the same |
| REST: `PUT /repos/<o>/<r>/pulls/<n>/merge`, `POST /repos/<o>/<r>/pulls/<n>/reviews`, `POST /repos/<o>/<r>/merges`, ref writes | 2, 3, 4 (the API needs a token, which the browser does not hold) | the same |
| A keyboard shortcut of the page | it makes one of the requests above | the same |
| A client's input (clicks and keys of Playwright, the MCP, the CLI, raw CDP; the input stage) | the request that the page makes | the same |
| A client's `Runtime.evaluate` or `callFunctionOn` (a script in the page or an isolated world) | the request that the script makes, in the tab's session | the same |
| A client's own `Fetch` (Playwright's `page.route`, `route.continue({url})`, `route.fulfill`, raw `Fetch.*`) | a client gets a request of a guarded host only after the judge; its continue of a refused write becomes the 403; a change of a guarded request, and a rewrite of another request to a guarded host, are refused; a client cannot act on a request that the model holds; a redirect to a guarded host is a new request at the request stage, which the model judges | — |
| A client's `Fetch.disable` or a new `Fetch.enable` | the model keeps its own patterns on | — |
| A worker of the page that the client's auto-attach brings (Playwright and the MCP attach workers and hold them at their start) | the model turns its `Fetch` on in that child session before the client lets it run | — |
| A dedicated worker that no client attaches | its request goes through the tab's own session (measured in the live check, with a raw client and no auto-attach): judged | — |
| A shared or a service worker; `Page.setBypassCSP` | `Page.setBypassCSP` with `enabled` true is refused, so GitHub's `worker-src` stays in force: only GitHub's own worker scripts run there (a limit, section 8) | blocks every write of a request with no tab |
| A popup that the page opens; another tab of the scope; a tab with no client (the CLI between its commands; a popup that no client took; a page's script after its client left) | a tab that a client holds | blocks every write of every tab where layer 1 is off |
| A request from another tab or another site (a cross-site form, a 307 redirect of a POST) | judged in the tab that makes it; a redirect is a new request | the same |
| The MCP tools (`browser_click`, `browser_type`, `browser_press_key`, `browser_evaluate`, ...) | the MCP is a Playwright client of the agent door: the rows above | the same |
| agent-browser's CLI | a client of the agent door: the rows above | its tab between commands |
| `Page.navigate`, `Target.createTarget`, a new tab | a GET: it changes nothing on GitHub; its answer gives a verdict | — |
| An event too large for the link (C10's `bridge.tooLarge`) of a GitHub page's request | it fails | — |

Each scope and each client meets the same model, in the service (from stage 3) and in the relay of the old path.

## 5. Where each refusal sits

- **Layer 1, the model** (`src/relay/merge-guard.ts`, in `src/relay/model.ts`): its own `Fetch` in each tab that a client
  holds, turned on before the client gets its first session of the tab, and in each child session that Chrome attaches in
  that tab. The precise judge of section 3 lives here, because only the model reads GitHub's answers and the request's
  body. A client's `Fetch` shares the tab's one chrome.debugger session with the model's: the model sends Chrome the
  union of the patterns, judges every request of a guarded host before a client gets it, and gives a client only the
  pauses that its own patterns ask for.
- **Layer 2, the receiver's floor** (chrome-extension `agent/`, C5 and C10): a session rule that blocks each write to a
  guarded host from every tab except the tabs where layer 1 is on, the operator's marked tabs and the act tabs of the
  sign-in act, and from each request with no tab. The model names its tabs with `bridge.mergeGuard`
  `[{"hosts":[...],"tabs":[...]}]` after each tab that it turns on; the receiver takes a tab back into the floor at its
  detach, before it detaches it, and every tab at a link change and at its start. Layer 1's interception exists only while
  the model holds a tab's debugger; Chrome lets a paused request go at a detach, and a page's script can send a write at
  any time (a click's request after the CLI's command ended, a timer, a popup that no client took). So the floor is
  needed: DNR applies to every request, also with no debugger, and from Chrome's own side.
- A tab whose `Fetch.enable` fails is not turned on, so the floor keeps blocking its writes.
- A receiver before the floor (0.3.7 and older) answers `unknown op`: the model logs it once at the link up, and only the
  tabs that a client holds are guarded until the pin names a receiver with the floor.

## 6. What the agent sees

The model answers a refused write itself (`Fetch.fulfillRequest`), so the request never reaches GitHub: HTTP 403,
`Cache-Control: no-store`; for a document (a form's POST) a `text/plain` page of the text; for any other request
`{"message":"<text>","errors":[{"type":"FORBIDDEN","message":"<text>"}]}`, with `Access-Control-Allow-Origin` of the
request's `Origin` (so the page's script, and a client's `evaluate`, read the text). The texts:

- marked: "The agent browser refused this request: the pull request came from agentwatch issue triage. No agent merges
  such a pull request, marks it ready for review, turns on its auto-merge, approves it or changes it in the agent browser;
  only the operator does, on GitHub (the operator's rule, 2026-11-12)."
- unknown: "The agent browser refused this request: it could not tell whether the pull request came from agentwatch issue
  triage, and no agent merges such a pull request (the operator's rule, 2026-11-12). Load the pull request's own page in
  this tab, then try again."
- untied: "The agent browser refused this request: it cannot tie the request to a pull request that did not come from
  agentwatch issue triage (a merge of branches, a write of a branch, or a GraphQL request that it cannot read), and no
  agent merges such a pull request (the operator's rule, 2026-11-12)."

A client's refused `Fetch` command gets a CDP error: `Invalid InterceptionId.` (a request that the model holds), or "Not
available in the agent browser: a request to <host> that a client changes (Fetch.continueRequest). The agent browser judges
each request to GitHub itself (the merge guard of pull requests from agentwatch issue triage)." The floor's block is a failed
request (`net::ERR_BLOCKED_BY_CLIENT`), with no text: DNR has none.

## 7. The counts and the log line

The model counts the writes that it judged, the refusals by reason (marked, unknown, untied), the clients' Fetch commands
that it refused, the answers that it read and the reads that failed; it keeps the number of marked and unmarked PRs and of
marked node ids (`model.guard.state()`, for the tests and the harness). A log line names each reason and host at most once
in 5 minutes: `merge guard: refused a write to <host> (<method>, tab <id>): <reason>; refused so far: <n>`. No log line
holds a URL path, a query, a header, a body, a cookie or a page's text (a token in a URL, a CSRF value or a PR's title
never reaches the journal).

## 8. What it cannot stop

- A raw API call with a token outside the agent browser: agentwatch's own merge guard and its limits (its design,
  section 10.4).
- A PR whose markers somebody removed outside the agent browser (its label, its title, its body's line and its head
  branch's name, for example with `gh`) before the model ever saw it marked. The browser has no copy of agentwatch's PR
  registry (`CACHE_DIR/issue-triage/prs.json`); a later C12 field could give it one.
- A GraphQL request whose operation the model cannot read (a persisted query id), from a page that is no PR page, that
  names a marked PR only by a node id that the model never saw in a marked PR's answer.
- A request of a shared worker or a service worker of a GitHub page (no tab's session sees it). With
  `Page.setBypassCSP` refused, GitHub's `worker-src` lets only GitHub's own worker scripts run there; the floor blocks the
  writes of a worker with no tab. A dedicated worker's request goes through the tab's own session, also when the client
  attaches no worker (measured in the live check).
- A write of a tab with no client while the receiver has no floor (receiver 0.3.7 and older), for example the request
  of a click that a page sends after the CLI's command ended.
- A write whose pause comes in the moment of a link drop or of Chrome's own detach, before the model's answer (Chrome lets
  a paused request go at a detach). The floor takes such a tab back only after the detach.
- A message on a WebSocket (none of GitHub's sockets merges a PR).
- GitHub Enterprise hosts and any other host of GitHub's code: only `github.com` and its subdomains are guarded.
- The operator's own tabs (the live view's marked tabs), which no client reaches: there the operator merges, as the
  rule says.

## 9. The test host, the tests and the live check

- The stand-in: `agent-browser service --test --test-merge-guard-host <host>`, a normalized host under `.localhost` (a
  loopback name in Chrome), beside GitHub's hosts. The service refuses the flag without `--test`, and any host that is not
  under `.localhost`. The production list is GitHub's alone; the relay of the old path never has a test host.
- Unit tests (`test/merge-guard.test.ts`): the PR of a URL, the markers, the classes of a write, the body, the judge, the
  verdicts, CDP's patterns, the answers, the clients' Fetch, the floor's op, the event too large.
- Model tests (`test/relay-merge-guard.test.ts`): a client's session turns the tab on first; a marked PR's paths get 403
  and no client sees a request to GitHub; an unmarked PR's paths go; a held request and a rewrite are refused; the
  client's disable keeps the guard's Fetch; `Page.setBypassCSP`; an older receiver; the event too large; the hosts; a
  worker of the client's auto-attach.
- The live check (`test/live/merge-guard/check.ts`, section 10 of the PR): the real service in `--test` mode with the
  stand-in host and the receiver 0.3.7, a real Playwright client and a raw CDP client, a stand-in of a PR page on
  `*.localhost` hosts only.

## 10. The release, and the stages

- Layer 1 comes with this repository's commit that merges board ab-v16.99. It works on every path of the model: in the
  service, which serves sessions from stage 3, and in the relay of the old path.
- Layer 2 comes with the chrome-extension receiver version that adds `bridge.mergeGuard` (the next repack after its PR,
  0.3.8 if no other release comes first), and with the agent-browser pin that names that receiver (the service checks
  the pinned CRX). The relay of the old path gets the floor only when agentwatch's daemon carrier passes the op on.
- agentwatch's `triage enable` can require: the service's commit (C12's hello) at or after the merge of ab-v16.99, and the
  receiver's version (C12 `status`, `extension_version`) at or after the floor's release. Both hold only on the agent
  mode path of the service, from stage 3 on.
