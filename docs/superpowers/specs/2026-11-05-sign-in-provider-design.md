# Sign-in through an external provider — design

Date: 2026-11-05. Status: **DRAFT for review.** Author: taylor session `auth-design`, a subagent of `ab-lead`
(board task ab-v16.45, under goal ab-v16). Branch `ab-v16.45-auth-provider-design` in agent-browser. Evidence: the
probe in [2026-11-05-sign-in-provider-probe/](2026-11-05-sign-in-provider-probe/README.md), run on taylor with
Debian Chromium 156.0.8078.79 (the agent unit's `/usr/bin/chromium`) in private Xvfb displays, with local fake
hosts only.

This design builds on the per-scope allowlist design
([2026-11-04-per-scope-allowlist-design.md](2026-11-04-per-scope-allowlist-design.md), sections 4 to 8 and 12), the
orphan agent tabs design ([2026-11-05-orphan-agent-tabs-design.md](2026-11-05-orphan-agent-tabs-design.md)), and the
contracts C4, C5, C6, C10 and C11 of chrome-extension `docs/protocol.md` (main `aa809ed`, with the orphan-tabs rules
of PR #17, merged at `052c15c`; this design's changes apply on top of them). The code that it measured:
agent-browser main `87be973` (`src/allowlist.ts`, `src/browser.ts`, `src/relay/`; main is now `19397f1`, and this
branch does not change those files), and the receiver of chrome-extension main `230f381` (agent package 0.2.0:
`agent/dnr.js`, `agent/importer.js`; `agent/` is the same at `052c15c` and at `aa809ed`). ab-lead's fresh reviewer
(review-53) ran the probe again with the same results, and ran extra cases (`review-53-extra.ts`), which sections 4,
5 and 7 cite. No product code changes in this task.

## 1. The answer in short

The operator (board item ab-8zv, confirmed, 2026-11-05): "we control direct agent navigation. i.e. we don't let an
agent navigate outside the allowlist, but if a site uses an external auth provider (auth0 for example) we need to
allow those things."

1. **Today (section 3).** In agent mode the receiver's static rule 1 blocks every top-level step to a provider that
   is on no list: the site's redirect to `/authorize`, a link straight to the provider, both kinds of sign-in
   popup, the SAML form POST, and the agent's own `goto` of a listed URL that the site redirects to the provider.
   Only the frame's silent renew loads (rule 4), and it then fails for another reason (item 4). With the provider
   as a normal entry of the list, every flow works today, the agent's clicks and typing on the provider's page
   too. In plain agent-browser (no receiver, no relay) Chrome follows every site navigation, and agent-browser
   refuses each command on a tab that is on the provider's page.
2. **Who started a navigation (section 4).** DNR can tell the agent's own navigation from a site's for the
   requests that agent mode makes: a relay `Page.navigate` and `tabs.update` carry the receiver's ID as their
   `initiator`, also on every redirect hop; a typed URL, `tabs.create` and the browser's own CDP
   (`Target.createTarget`, `Page.navigate` in plain agent-browser) carry none; a link, a page script, a form, a
   popup and a frame carry the page's origin. DNR cannot tell the agent's own click or the agent's own script in
   the page (`Runtime.evaluate`) from the site's: they carry the page's origin too. The relay sees the client's
   `Page.navigate` calls, and `Page.frameRequestedNavigation` (with `reason` and `disposition`) only for a
   navigation that the page starts, with the same values for the agent's CDP click and the site's own link (a
   person's click was not measured).
3. **The recommendation: option a (section 6).** A per-list "sign-in provider" entry. A site's navigation may reach
   a provider of its list; the agent's own navigation may not open a provider URL. One more DNR allow rule per list:
   `requestDomains` = the list's providers, `initiatorDomains` = the list's sites, its providers and the receiver's
   ID, for main frames; and the frame rule covers the providers' pages too. The relay refuses a client's
   `Page.navigate` and `Target.createTarget` to a provider URL, and agent-browser refuses its own `open` and `goto`
   there: the agent cannot open a provider URL directly. (An open redirect on a listed site, and the site's own
   sign-in URL such as `site.test/login`, still take it there.) Every other check (the closing rule, the guard,
   agent-browser's input guard) treats a provider's page as a page of the list. Measured with the candidate rules
   (section 4.2): every sign-in step loads, a typed URL, `tabs.create` and the browser's own CDP are blocked, and the
   provider's links to other hosts are blocked. The relay's own `Page.navigate` to a provider passes DNR (it carries
   the receiver's ID). In agent mode `Target.createTarget` opens `about:blank` and then sends `Page.navigate` (C11),
   so it carries the receiver's ID too. So the relay's refusal is the only guard for both.
   Option b (any navigation that a listed page starts) lets every link and every agent script leave the list, and
   it breaks the provider's own form POST in its strict form. Option c (the provider as a normal entry) works today
   and is the stopgap until a is built, with the narrowest provider host. A shared host such as
   `accounts.google.com` has no tenant host: as a provider entry, every page of it is open to the agent's click or
   script in a listed page, with the operator's sign-in there; the web viewer warns (section 7.5).
4. **The sign-in beam (section 5).** With the site's cookies only, the agent is signed in until the site's session
   ends; then the site sends the tab to the provider, which asks for the account and the password: a person must
   act. With the provider's own cookies too (a second send, of the provider's host), the redirect chain signs the
   site in again with no input. The frame's silent renew needs the provider's cookie in a third-party context:
   Chromium 156's default blocks third-party cookies (`thirdPartyCookiesAllowed: false`, measured), so the silent
   renew fails even with the provider's cookie. A content setting per provider and site fixes it (measured): a
   choice for the operator (section 10, choice 2). The agent unit moves to Google Chrome stable in agentwatch's
   stage 4 step C; that Chrome's default for third-party cookies is not measured yet.
5. **Contracts and build (sections 7 to 9).** C4 gets a `providers` field (in `set_allowlist` for today's one list,
   and per list in `set_scopes`), and `blocked` gets a `from` host so that the web viewer can offer "add as a
   sign-in provider". C5 gets the provider rule, and the providers join the covered set of the closing rule and the
   guard. C11 gets `providers` in the `allowlist` line and a refusal text for a provider. The build: the contract
   PR, the receiver (in parts 1a and 1c of the per-scope build), the relay (part 2), agent-browser's own guard, and
   agentwatch's web viewer (aw-lead).

## 2. Words

- A **provider** is the host of an external sign-in service that a listed site sends its users to: an OIDC or OAuth
  `/authorize` page, a SAML identity provider, an account chooser. For example `tenant.auth0.com`.
- A **sign-in provider entry** (option a) is a host on a list's second part, `providers`. It follows the C5 entry
  rules and covers itself and its subdomains.
- The **agent's own navigation**: agent-browser's `open` and `goto`, a client's `Page.navigate` (Playwright's
  `goto`), `Target.createTarget` with a URL (Playwright's `newPage` and then `goto`, agent-browser's `open`),
  `tabs.create` with a URL, and a typed URL.
- A **site's navigation**: a navigation that a page starts: a link, a script, a form, a `meta` refresh, a popup, a
  frame, and the server redirects of each of these. The agent's own click on a link (a CDP click) and the agent's
  own script in the page (`Runtime.evaluate`) are site's navigations to Chrome (section 4). A person's click was not
  measured.
- The **initiator** is the origin that Chrome gives a request (`webRequest`'s `initiator`, DNR's
  `initiatorDomains`): the origin of the document that started the navigation, or the extension's origin, or none.
  A server redirect keeps the initiator of the request that it answers (measured, section 4).
- L1, L2 and L3 are the probe's lists: L1 = `[site.test]` (the provider on no list), L2 = `[site.test,
  tenant.auth0.test]` (the provider as a normal entry, option c), L3 = `[site.test, auth0.test]` (a broad entry).

## 3. Where today's guards block each flow (question 1)

The probe's parts "agent" and "plain" (one trial of each flow for each list; part "initiator" repeats the DNR
results, section 4). The fake provider follows the shapes of Auth0's hosted login and of a SAML POST binding
(probe README).

The guards today:

- **The receiver's DNR rules** (C5 as agent package 0.2.0 writes them; the per-scope build replaces rules 2 and 4
  with session rules of the same shape). Static rule 1 blocks every main frame; dynamic rule 2 allows the list
  (`requestDomains`). Static rule 3 blocks every frame; dynamic rule 4 allows frames under a top-level page on the
  list (`topDomains`), from any host (O11).
- **The relay** (agent-browser `src/relay/`). Today it refuses no navigation by host: it refuses only schemes
  (`policy.ts`, `urlRefusal`), and DNR blocks the rest. The per-scope target (C11, "Refusals") adds the refusal of a
  main-frame `Page.navigate` and of `Target.createTarget` off the scope's list (layer 1 of the per-scope design,
  section 6). Its popup rule: a new tab joins its opener's scope (Chrome's `openerId`), else no connection sees it
  (`model.ts`, `onCreated`).
- **agent-browser's own guard** (`src/allowlist.ts`, `src/browser.ts`): `open` and `goto` refuse a URL off its list
  before the navigation; each command first checks the tab's URL (`assertAllowed`; a tab off the list does not
  resolve: `no allowlisted tab matches`); a `goto` that a redirect takes off the list gives `redirectError`.
- **PR #47's input guard** (`byHand` in `src/browser.ts`): the input lock, the check of the tab's URL inside the
  lock, and a stop of the command's further input events once the main frame starts or asks for a navigation off
  the list.

| Flow | Agent mode, L1 (today) | Agent mode, L2 (option c, today) | Plain agent-browser, L1 | Plain agent-browser, L2 |
| --- | --- | --- | --- | --- |
| A click on the site's sign-in link: `/login`, a 302 to `/authorize`, then `/u/login` (or back with a code) | Rule 1 blocks `/authorize`; the tab shows Chrome's error page; `blocked` names `tenant.auth0.test`. agent-browser's click succeeds, then the tab does not resolve | Loads the provider's "choose an account" page, and its frame from `other.test` (rule 4 now covers the provider's page) | Chrome follows the redirect: the tab is on the provider's page, and agent-browser refuses every command on it. With the provider's session the chain ends signed in at `site.test/app` with no command on the provider's page | Works, with agent-browser's input |
| A sign-in link that goes straight to the provider | Rule 1 blocks it | Works | As the row above | Works |
| A sign-in popup: `window.open("")`, then the popup's `location` (auth0-spa-js), and `window.open(url)` | Rule 1 blocks the popup's `/authorize`. The relay announces the popup (Playwright gets it, on Chrome's error page); the opener gets no message | Works: Playwright and agent-browser drive the provider's page in the popup; the provider posts the code to the opener, and the opener closes the popup | The popup loads the provider's page; agent-browser cannot drive it (`no allowlisted tab matches`). With the provider's session the popup posts back and closes by itself | Works |
| The frame's silent renew (`prompt=none`, `web_message`) | Rule 4 loads the frame. It answers `login_required`: the provider's cookie does not go with a third-party request (section 5) | The same | Not run in this part; part "cookies" (no frame block) gives the same `login_required` | The same as the cell to the left |
| A SAML sign-in: the site's form POST to the provider, the provider's form POST to the site's `/acs` | Rule 1 blocks the POST to the provider | Works, also with the account chooser and the password between the two POSTs | The POST loads the provider's page; agent-browser refuses the tab | Works |
| "Choose an account": a click on the account, a typed password, a click on Continue | Not reachable | Works with Playwright (`click`, `pressSequentially`) and agent-browser (`click`, `type --into`) | Refused: the tab does not resolve, so no input starts | Works |
| The agent's `goto` of a listed URL (`site.test/app`) that the site redirects to the provider | Rule 1 blocks the redirect. Playwright: `net::ERR_BLOCKED_BY_CLIENT at https://site.test/app`; agent-browser: `navigation failed: net::ERR_BLOCKED_BY_CLIENT` | The tab is on the provider's page | `refusing: site.test redirected the tab to tenant.auth0.test, which is not on the allowlist. The tab stays open there` (no sign-in hint: `tenant.auth0.test` is not a known sign-in host) | Works |
| The agent's own `goto` or `open` of the provider | Playwright: rule 1 blocks it. agent-browser: `refusing: tenant.auth0.test is not on the allowlist`, before the navigation | **Works: the agent can open the provider itself** | agent-browser refuses it before the navigation | **Works** |
| The provider's page links to `other.test` and to `manage.auth0.test` | Not reachable | Rule 1 blocks both | Not reachable | Chrome follows; agent-browser refuses the tab |
| The agent's goto of `manage.auth0.test` with the entry `auth0.test` (L3) | | Works: a broad entry covers the provider's other hosts | | |

So in agent mode only DNR blocks a flow today; the relay never does, and agent-browser's guard adds its refusal of
the tab after DNR. In plain agent-browser no guard stops a site's own navigation: a flow that needs no input (a
redirect chain or a popup with the provider's session) completes, and agent-browser only refuses to touch the
provider's page. The same holds for the agent's own script: in plain mode `eval location.href = <other.test>`
takes the tab off the list (agent-browser then refuses the tab); in agent mode DNR blocks it.

## 4. Can the agent's own navigation be told from a site's? (question 2)

Part "initiator": a probe extension (not the agent package) with the same DNR rule shapes, `webRequest` (to read
each request's `initiator`), `onRuleMatchedDebug`, `webNavigation` and `chrome.debugger` (to read the Page events
that the relay would see). 24 kinds of navigation, each from a fresh tab on `site.test/`, under six rule sets: 3
trials under today's rules and 2 under each other set, 312 trials in all (`results/initiator.json`; the tables
come from `tables.ts`). Each trial started with no cookie.

### 4.1 Who Chrome names as the initiator

| Kind | Who | Main-frame requests (initiator) | The relay's Page events of the tab | webNavigation transition |
| --- | --- | --- | --- | --- |
| `Page.navigate` over `chrome.debugger` (the relay's path) to `site.test/app`, which redirects twice | the agent | `site.test/app` (receiver) -> `site.test/login` (receiver) -> `tenant.auth0.test/authorize` (receiver) | `frameStartedNavigating` only | (blocked, no commit) |
| `Page.navigate` over `chrome.debugger` straight to the provider | the agent | `tenant.auth0.test/authorize` (receiver) | `frameStartedNavigating` only | |
| `Page.navigate` over `chrome.debugger` to the site's open redirect (`/redirect?to=other.test`) | the agent | `site.test/redirect` (receiver) -> `other.test/x` (receiver) | `frameStartedNavigating` only | |
| `chrome.tabs.update(tab, {url})` | the agent (the receiver itself) | `tenant.auth0.test/authorize` (receiver) | `frameStartedNavigating` only | |
| `chrome.tabs.create({url})` | the agent | `tenant.auth0.test/authorize` (none, a new tab) | none | |
| `Target.createTarget` with a URL on the browser's own CDP (plain agent-browser; a Playwright with its own Chrome) | the agent | `tenant.auth0.test/authorize` (none, a new tab) | none | |
| `Page.navigate` on the browser's own CDP | the agent | `tenant.auth0.test/authorize` (none) | `frameStartedNavigating` only | |
| A typed URL (xdotool: ctrl+L, the URL, Return) | the agent | `tenant.auth0.test/authorize` (none) | `frameStartedNavigating` only | |
| A CDP click on the site's link to the provider | the agent, in the page | `tenant.auth0.test/authorize` (site.test) | `frameRequestedNavigation` `anchorClick`/`currentTab`, then `frameStartedNavigating` | |
| A CDP click on the site's link to `/login` (a 302 to the provider) | the agent, in the page | `site.test/login` (site.test) -> `tenant.auth0.test/authorize` (site.test) | `anchorClick`/`currentTab` | |
| `Runtime.evaluate` `location.href = <provider>` | the agent, in the page | `tenant.auth0.test/authorize` (site.test) | `scriptInitiated`/`currentTab` | |
| `Runtime.evaluate` `location.href = <other.test>` | the agent, in the page | `other.test/eval` (site.test) | `scriptInitiated`/`currentTab` | |
| A CDP click on the site's link through its open redirect | the agent, in the page | `site.test/redirect` (site.test) -> `other.test/via-redirect` (site.test) | `anchorClick`/`currentTab` | |
| The site's SAML form (auto-submitted after a click on its link) | the site | `site.test/saml/login` (site.test) -> `tenant.auth0.test/samlp/probe` (site.test, POST) | `anchorClick`, then `formSubmissionPost`/`currentTab` | `link` |
| A popup: `window.open("")`, then `location` | the site | `tenant.auth0.test/authorize` (site.test, a new tab) | (the popup is not attached in this part) | `link` (its `about:blank`) |
| A popup: `window.open(url)` | the site | `tenant.auth0.test/authorize` (site.test, a new tab) | | |
| The site's hidden frame to `/authorize?prompt=none` | the site | frame `tenant.auth0.test/authorize` (site.test) | `frameRequestedNavigation` `initialFrameNavigation` on the frame | frame `auto_subframe` |
| The provider's own form POST (choose an account, a password), its 303 and the 302 back to the site (run under set a) | the provider | `tenant.auth0.test/u/login` (tenant.auth0.test, POST) -> `tenant.auth0.test/authorize` (tenant.auth0.test) -> `site.test/callback` (tenant.auth0.test) -> `site.test/app` (tenant.auth0.test) | `formSubmissionPost`/`currentTab` | `form_submit` + `server_redirect` |
| A CDP click on the provider page's link to `other.test` or to `manage.auth0.test` (set a) | the agent, in the page | `other.test/privacy` or `manage.auth0.test/` (tenant.auth0.test) | `anchorClick`/`currentTab` | |
| `Page.reload` of the provider's page that the site's sign-in link opened (set a) | the agent | `tenant.auth0.test/u/login` (**site.test**: the reload keeps the initiator of the entry) | `frameStartedNavigating` `reload` | `reload` |
| `Page.navigateToHistoryEntry` back to the provider's page from the site (set a) | the agent | no request (the page came back with no network request; DNR saw nothing) | `frameStartedNavigating` `historyDifferentDocument` | `link` + `forward_back` |
| review-53: a `meta` refresh that a script adds to the listed page | the site | `tenant.auth0.test/authorize` (site.test) | | `link` (under a_ext) |
| review-53: a script on a `data:` page (a client's `Page.navigate` to `data:`, then `Runtime.evaluate`) | the agent, in the page | `tenant.auth0.test/authorize` (none) | | |
| review-53: a script in an `about:blank` tab and in an `about:blank` window that the extension made (as the relay's `Target.createTarget` makes them) | the agent, in the page | `tenant.auth0.test/authorize` (none) | | |
| review-53: the top navigation of a sandboxed frame (`allow-scripts allow-top-navigation`) on the listed page | the site | `tenant.auth0.test/authorize` (none) | | |
| review-53: `chrome.tabs.reload` of a popup whose first request rule 1 blocked (the retry of C10), after the rules changed to a_ext; both popup kinds | the receiver, for the site | `tenant.auth0.test/authorize` (site.test: the reload keeps the opener's initiator) -> `tenant.auth0.test/u/login` (site.test) | | `reload` |

What this means:

- **Every redirect hop keeps its first request's initiator.** The site's redirect of an agent `Page.navigate` is
  "the receiver" to DNR, not "the site"; the provider's redirect back to the site is "the provider".
- **The agent's own navigations in agent mode carry the receiver's ID** (`Page.navigate` and `tabs.update`; the
  relay's `Target.createTarget` is an `about:blank` tab and a `Page.navigate`), and the others carry none (a typed
  URL, `tabs.create`, the browser's own CDP). A site's navigation from a page with a host (a link, a script, a form, a
  `meta` refresh, a popup, a frame) carries that page's origin. A navigation from a page with no host carries none
  (review-53: a `data:` page, a sandboxed frame's top navigation, a script in an `about:blank` tab or window that the
  extension made): DNR then blocks it under every rule with `initiatorDomains`, also the agent's own script in the
  relay's new `about:blank` page. So DNR can let a site's navigation through by `initiatorDomains` and keep every
  agent's own navigation out, except the relay's `Page.navigate`, which the relay must refuse itself.
- **The agent's click on a link and the agent's script in the page are a site's navigation** to DNR and to the relay:
  the same initiator (the page's origin) and the same `frameRequestedNavigation` reasons as the site's own script and
  the site's own link (a person's click was not measured). So no rule can keep the agent from following a link or from
  setting `location` in a listed page. The list can only bound where such a navigation goes.
- **The relay sees less than DNR.** It knows the calls that it sends (`Page.navigate`, `Target.createTarget`), and
  it gets `Page.frameRequestedNavigation` (`reason`, `disposition`) only for a navigation that the page starts, and
  only on an attached tab whose client enabled the Page domain. A redirect gives no Page event before its commit.
  So the relay can refuse a client's own navigation to a host (layer 1), but it cannot judge a page's navigation.
- A reload and a back to the provider's page are no new "direct" navigation: the reload keeps the site's
  initiator, and the back made no request. The retry of C10 (`chrome.tabs.reload` of a blocked popup) keeps the
  opener's initiator too, so a sign-in popup that the retry loads again reaches the provider (review-53, both popup
  kinds, one trial each).

### 4.2 The candidate rules

The rule sets (ids as in part "initiator"; priority 1 blocks, priority 2 allows; the probe extension's ID stands in
for the receiver's):

- **today**: rules 1 and 3 block; rule 2 allows `requestDomains: [site.test]`; rule 4 allows frames under
  `topDomains: [site.test]`.
- **a**: today's rules, plus rule 10 (main frames, `requestDomains: [tenant.auth0.test]`, `initiatorDomains:
  [site.test, tenant.auth0.test]`) and rule 11 (frames, `topDomains: [tenant.auth0.test]`).
- **a_ext**: as a, and rule 10's `initiatorDomains` also holds the extension's ID.
- **b**: today's rules, plus rule 12 (main frames, any host, `initiatorDomains: [site.test]`): "any navigation that
  a listed page starts".
- **b_any**: today's rules, plus rule 13 (main frames, any host, `excludedInitiatorDomains: [<extension ID>]`): any
  navigation that the extension did not start.
- **c**: rules 2 and 4 with `[site.test, tenant.auth0.test]`: the provider as a normal entry.

T is `tenant.auth0.test`, O is `other.test`, M is `manage.auth0.test`. Each cell holds every trial of its set (3 of
3 under today's rules, 2 of 2 under the others). "Setup blocked": the kind starts on the provider's page, which
that set does not reach.

| Kind | today | a | a_ext | b | b_any | c |
| --- | --- | --- | --- | --- | --- | --- |
| relay `Page.navigate` to `site.test/app` (the site redirects to T) | blocked T | blocked T | **loads T**, its frame from O | blocked T | blocked T | loads T, its frame |
| relay `Page.navigate` straight to T | blocked | blocked | **loads** (the relay must refuse it) | blocked | blocked | loads |
| relay `Page.navigate` through the site's open redirect to O | blocked O | blocked O | blocked O | blocked O | blocked O | blocked O |
| `tabs.update` to T (the receiver's own) | blocked | blocked | loads | blocked | blocked | loads |
| `tabs.create` with T | blocked | blocked | **blocked** | blocked | loads | loads |
| `Target.createTarget` with T (browser CDP) | blocked | blocked | **blocked** | blocked | loads | loads |
| `Page.navigate` to T (browser CDP) | blocked | blocked | **blocked** | blocked | loads | loads |
| a typed URL of T | blocked | blocked | **blocked** | blocked | loads | loads |
| a click on the site's link to T | blocked | loads, its frame | loads, its frame | loads T, frame blocked | loads T, frame blocked | loads, its frame |
| a click on the site's link to `/login` (302 to T) | blocked | loads, its frame | loads, its frame | loads T, frame blocked | loads T, frame blocked | loads, its frame |
| the agent's script: `location = T` | blocked | loads | loads | loads | loads | loads |
| the agent's script: `location = O` | blocked | blocked | blocked | **loads O** | **loads O** | blocked |
| a click on the site's open redirect to O | blocked | blocked | blocked | **loads O** | **loads O** | blocked |
| a click on the site's link to O | blocked | blocked | blocked | **loads O** | **loads O** | blocked |
| the site's SAML POST to T | blocked T | loads, its frame | loads, its frame | loads T, frame blocked | loads T, frame blocked | loads, its frame |
| popup `window.open("")`, then `location` | blocked | loads | loads | loads | loads | loads |
| popup `window.open(url)` | blocked | loads | loads | loads | loads | loads |
| the site's frame to T | loads | loads | loads | loads | loads | loads |
| the provider's own form POST, its 303 and the 302 back | setup blocked | ends at `site.test/app` | ends at `site.test/app` | **blocked T** (its POST) | ends at `site.test/app` | ends at `site.test/app` |
| a click on the provider page's link to O | setup blocked | blocked | blocked | blocked | **loads O** | blocked |
| a click on the provider page's link to M | setup blocked | blocked | blocked | blocked | **loads M** | blocked |
| `Page.reload` of T's page | setup blocked | loads | loads | loads | loads | loads |
| back to T's page | setup blocked | loads (no request) | loads | loads | loads | loads |
| review-53 (one trial each): a `meta` refresh on the listed page to T | blocked | | loads | | | |
| review-53: a script on a `data:` page, in an extension-made `about:blank` tab or window, or a sandboxed frame's top navigation, to T | blocked | | blocked | | | |
| review-53: the retry (`tabs.reload`) of a popup blocked under today's rules, after a change to a_ext | | | loads T (rule 10) | | | |

What the sets show:

- **a_ext is the only set in which every sign-in step loads and every navigation of the agent's own that the relay
  does not send stays blocked.** Its cost: the relay's own `Page.navigate` to the provider passes DNR, so the
  relay must refuse it (C11 layer 1 already refuses every host off the scope's list in the per-scope target; a
  provider stays "off the list" there). In agent mode a client's `Target.createTarget` with a URL is the relay's
  `about:blank` tab and its `Page.navigate` (C11), so the browser-CDP rows of this table do not apply to it: the
  relay's refusal is its only guard too. The receiver's `tabs.update` with a URL is not a bridge op (C10's
  `tabUpdate` takes only `active`), so no client can use it.
- **a without the receiver's ID** keeps even the relay's navigation to the provider out, but it also blocks the
  agent's `goto` of a listed page that the site sends to the provider (the first row), a common case: the agent
  opens the app, and the app sends it to sign in.
- **b** lets every link and every agent script on a listed page go to any host (`other.test` loaded), and it blocks
  the provider's own form POST, because the provider's page is not a listed page: no flow with an account chooser or
  a password works. **b_any** fixes the provider's POST but also lets the provider's links go anywhere, and a
  request with no initiator matches `excludedInitiatorDomains`, so a typed URL, `tabs.create` and the browser's
  own CDP all loaded.
- **c** works for every flow and is the same as a for the sites' navigations, but every agent's own navigation to
  the provider loads too.
- Under b and b_any the provider page's frame (a captcha from `other.test`) was blocked: rule 4 allows frames only
  under the list's pages. Option a needs its rule 11 (or the providers in rule 4's `topDomains`).

## 5. The sign-in beam and a provider (question 3)

Part "agent", group "beam" (`results/beam.json`): C2 payloads sent through the receiver's `import` (C6) on channel
`main`, then Playwright over the relay. One trial of each step. The site's cookie `site_session` is `SameSite=Lax`;
the provider's `auth0_session` is `SameSite=None; Secure; HttpOnly`. Part "cookies" (`results/cookies.json`): the
provider's cookie in a frame.

| Step | L1 (the provider on no list) | L2 (the provider as an entry) |
| --- | --- | --- |
| Neither sign-in; the agent's `goto site.test/app` | The site redirects to the provider; rule 1 blocks it | The provider's "choose an account" page: a person must choose the account and type the password |
| The site's sign-in sent (one send of `site.test`), then `goto site.test/app` | Signed in | Signed in |
| The same, then the frame's silent renew | `login_required` | `login_required` |
| The site's session ends; the provider's sign-in sent (a second send, of `tenant.auth0.test`) | The import answers `ok: false`, `restore page`: rule 1 blocks its restore tab. Its cookie step ran first, so the provider's cookie is in the profile anyway (the next row) | `ok: true`, 1 cookie set |
| Then `goto site.test/app` | Rule 1 blocks the redirect to the provider | **Signed in with no input**: `/app`, `/login`, `/authorize` (with `auth0_session`), `/callback`, `/app` |
| After the L1 import that failed, the list changes to L2, then `goto site.test/app` | | Signed in with no input: the failed import had set the provider's cookie |
| Then the frame's silent renew | `login_required` | `login_required` |

The frame's silent renew (part "cookies", one trial each; the provider's cookie set at the top level first):

| Setting | The frame's request to `/authorize` | The answer |
| --- | --- | --- |
| Chromium 156's defaults (`chrome.privacy.websites.thirdPartyCookiesAllowed`: `false`, `controllable_by_this_extension`) | no cookie | `login_required` |
| `chrome.contentSettings.cookies.set({primaryPattern: "https://tenant.auth0.test/*", secondaryPattern: "https://site.test/*", setting: "allow"})` | `auth0_session` | a code |
| The same with `primaryPattern: "<all_urls>"` (the site may use every third-party cookie) | `auth0_session` | a code |
| `thirdPartyCookiesAllowed` set to `true` (needs the `privacy` permission, which the receiver does not have) | `auth0_session` | a code |
| `thirdPartyCookiesAllowed` set to `false` again | no cookie | `login_required` |
| review-53: `primaryPattern: "https://[*.]tenant.auth0.test/*"`, `secondaryPattern: "https://[*.]site.test/*"` | the call fails: `Invalid host.` | `login_required` |
| review-53: `primaryPattern: "https://*.tenant.auth0.test/*"`, `secondaryPattern: "https://*.site.test/*"` (the form of C5's target, section 8: it covers each host itself, and the probe's port) | `auth0_session` | a code |
| review-53: `primaryPattern: "https://*.auth0.test/*"`, the same `secondaryPattern` | `auth0_session` | a code |

What a provider flow needs in the agent browser:

- **The site's cookies only** (today's beam: C2 sends the cookies of one `domain`, and the provider's host is never
  covered by the site's `domain`). The agent works while the site's own session lasts. When it ends, the site sends
  the tab to the provider. With the provider reachable (a or c), the provider asks for the account and the password
  (and with a real provider often a second factor or a captcha): a person must act there, in the agent browser's
  live view or by sending the site's sign-in again. With the provider unreachable (today's L1), the tab shows
  Chrome's error page and `blocked` names the provider.
- **The provider's own cookies too** (a second send, from a tab on the provider's host). The site's redirect
  through the provider then signs the site in again with no input, as often as the provider's session lasts. The
  sender extension can send it today (C2: any `domain` that is not a box's). The per-scope target's import rules 6
  and 7 load its restore page whatever the lists hold; today's receiver fails that send's restore page when the
  provider is on no list, after it set the cookies (a finding: the import answers `ok: false` after a change).
  Which list a sent provider joins follows choice 6 of the per-scope design (b: no list); the operator adds it as a
  provider entry.
- **The frame's silent renew** needs both the provider's cookie and a third-party cookie that Chromium sends. The
  agent unit on taylor runs `/usr/bin/chromium` today (agentwatch `daemon/browser/unit.py`, `DEFAULT_CHROME`), which
  blocks them by default. The unit moves to Google Chrome stable in agentwatch's stage 4 step C; that Chrome's default
  is not measured yet (aw-lead checks it in step C's live run). Google Chrome stable may allow third-party cookies by
  default; then the frame's silent renew works there with no change. The receiver has the `contentSettings`
  permission, so it can allow the provider's cookies in frames under the list's sites only (the `*.` rows). Without
  that, a site whose script falls back to a top-level redirect still signs in (the redirect chain above); a site that
  only renews in a frame loses its token when it expires. Choice 2 (section 10).
- **The risk of a provider's sign-in.** It is the most sensitive cookie on the box: one provider session signs in to
  every site that uses that provider, and the agent browser has one profile for every scope (per-scope design,
  section 10). Option a keeps the top-level redirect back to an off-list site blocked (rule 1), but an allowlisted
  page's frames still load any host with the cookies that Chrome sends there (O11), and with choice 2 a that
  includes the provider's cookie under the list's own sites. A tenant host (`tenant.auth0.com`, a company's Okta)
  is a small risk; a shared consumer provider (`accounts.google.com`) is the operator's whole account.

## 6. The options (question 4)

| | a. A per-list sign-in provider entry (recommended) | b. Any navigation that a listed page starts may go anywhere | c. The provider as a normal entry (works today) |
| --- | --- | --- | --- |
| What a site's sign-in can do | Every measured flow: the redirect chain, a link to the provider, both popups and the `postMessage`, the SAML POSTs, the account chooser with the agent's click and typing, the provider page's frames | Strict form (`initiatorDomains` = the list): the redirect and the popups, but not the provider's own form POST, so no account chooser and no password (measured). `excludedInitiatorDomains` form: every flow | Every measured flow |
| The agent's own navigation | Stays on the list's sites: the agent cannot open a provider URL directly. The relay refuses `Page.navigate` and `Target.createTarget` to a provider (its only guard for both in agent mode), agent-browser refuses `open` and `goto`, and DNR blocks a typed URL, `tabs.create` and the browser's own CDP. An open redirect on a listed site and the site's own sign-in URL still reach the provider | Stays on the list (strict form). The `excludedInitiatorDomains` form lets a typed URL, `tabs.create` and the browser's own CDP through | **Leaves the list's sites for the provider: the agent can open the provider's every page itself** |
| The agent's click and the agent's script in a listed page | Can reach the list's providers only | **Can reach any host**: the list no longer bounds a page's links, also not the agent's `evaluate` | Can reach the list's entries only |
| An open redirect on a listed site | Takes the agent's own `goto` to any page of the list's providers (the redirect keeps the receiver's initiator), never to another host | Takes a click to any host | The same as a |
| A provider's page that links anywhere | Its links reach only the list's sites and providers; its frames load from any host (as a listed page's, O11) | Its links reach any host (the `excludedInitiatorDomains` form), or its own POST fails (strict form) | As a |
| A provider shared by many sites | Its other pages (account settings, a dashboard on the same host) are open to the agent's click or script, not to its `goto`. A broad entry (`auth0.com`) covers every tenant and the provider's own site: the viewer warns. A provider that serves every customer on one host (`accounts.google.com`, `login.microsoftonline.com`, `login.live.com`, `appleid.apple.com`) has no tenant host: with such an entry the agent's own script in a listed page can use every page of that host with the operator's provider sign-in (for Google, the account's own settings). The viewer warns for these hosts too | The same, and every other host too | Its every page is open to the agent's `goto`; a broad entry covers the provider's other hosts (measured: `manage.auth0.test` under `auth0.test`) |
| Input on the provider's page | Allowed (agent-browser's guard accepts a provider's page): the agent can choose an account, type, consent, or sign the operator out | Allowed anywhere: the input guard can no longer use the list | Allowed |
| The build | Medium: the contract, one more DNR rule per list and the covered set (receiver), the relay's refusal text and line field (relay), agent-browser's list file and guard, the web viewer's provider entries (aw-lead) | Small in DNR (one rule), but the closing rule, the guard and agent-browser's input guard must stop using the list for pages: the list then bounds only the agent's `goto` | None |

**Recommendation: a.** It is the operator's rule in a precise form: the agent cannot open a provider URL directly,
and a listed site's sign-in reaches its provider and works in every measured flow, the agent's input included. Its
risk is bounded to the hosts that the operator names for that list, and for a shared host such as
`accounts.google.com` that host is all of the operator's account there. b gives away the list for every
link and every agent script (measured: `other.test` loaded), and in its strict form it does not even sign in. c
works now and needs no build: use it until a is built, with the narrowest provider host (the tenant host, never
`auth0.com` or `google.com`), and accept that the agent can open the provider itself meanwhile.

The limit of a, stated plainly: a determined agent can still reach a provider's other pages through a click or its
own script in a listed page (section 4.1), and through an open redirect or the site's own sign-in URL with its
`goto`. a stops the honest mistake and the plain `goto` of a provider URL, as the per-scope list does for its
sites; it does not stop an agent that wants to reach the provider. With a shared host such as
`accounts.google.com` as a provider entry, that reach covers every page of the host with the operator's sign-in.

## 7. The design of option a

### 7.1 The rules (C5)

For each list L with at least one provider (its providers P(L)):

- **The provider rule**: priority 2, `{"type":"allow"}`, `resourceTypes: ["main_frame"]`, `requestDomains` =
  P(L), `initiatorDomains` = L, P(L) and the receiver's own ID (`chrome.runtime.id`). A site's navigation from a
  page of L or of P(L) may reach P(L); a redirect of the relay's `Page.navigate` may reach P(L); a typed URL and
  `tabs.create` (no initiator) may not.
- **The frame rule of L** covers the providers' pages too: `topDomains` = L and P(L). So a provider page's captcha
  frame loads, as a listed page's frames do (O11). No new frame rule.
- **The main-frame rule of L** stays `requestDomains` = L.
- A provider that L also covers (an entry of L, or a subdomain of one) changes nothing: the main-frame rule of L
  already allows it to every initiator.

For today's one list (agent package 0.2.0, `set_allowlist`): dynamic rule 9 is the provider rule; dynamic rule 4's
`topDomains` gets the providers. Rule 9 has no `tabIds` (dynamic rules cannot have them), so it holds in every tab,
as rules 2 and 4 do today: also in an import's restore tab and in the operator's own tabs. So in today's form a
restore tab whose `state.url` the site redirects to a provider reaches the provider (the restore page's origin is
the sent site, a site of the list). The receiver writes rules 2, 4, 5 and 9 in one `updateDynamicRules` call, and
removes id 9 when there is no provider. Part 1a of the per-scope build removes dynamic id 9 at the worker's start,
as it removes ids 2 and 4.

For the per-scope build (session rules): three rules per list in place of two (100 and up): the main-frame rule,
the frame rule (with the providers), and the provider rule, each with the same `tabIds`. A list with no provider has
no provider rule. So with a provider on every list about 1,660 lists fit in the 5,000 session rules (two per list:
about 2,490); C5's limit text says so (section 8). Each change still
replaces a list's rules in one `updateSessionRules` call; a failed call still fails closed (C5). The marked-tab rule
(8) and the import's rules (6, 7) do not change: a marked tab with `"*"` may open any site anyway, and a restore tab
has no list, so its redirect to a provider stays blocked.

### 7.2 The covered set

A tab's **covered hosts** replace its list's entries wherever C5 judges a tab by host:

- a tab of a scope whose list is L: L and P(L);
- a marked tab (choice 3 of the per-scope design): with `"*"` every host; with a list name, that list's sites and
  providers; with `null` none;
- any other tab of no scope (the operator's unmarked tab, the page of a finished import, a tab whose entry was
  lost): the union of every list's sites and providers, as C5 uses the union of the lists for it today;
- an import's restore tab, while its import runs: its `domain` only (rules 6 and 7), no provider;
- a tab of the orphan set (C5, the sweep): none; it fails closed, as C5 says.

The receiver uses the covered hosts, not the list's sites alone, in:

- the closing rule (a tab on a provider's page stays while its list keeps the provider);
- the guard, layers 2 and 3 (C5's `onBeforeNavigate` and `onCommitted` check): webNavigation gives no initiator, so
  the guard cannot tell who started a navigation to a provider. DNR decides that for each network request; the
  guard only stops a worker's page or a cache page on a host that the tab may not show at all;
- the retry of a popup's first request (C10): a sign-in popup (`window.open("")`, then `location`) needs the retry
  in a part of the trials under load (per-scope design, section 5.2); its host is a provider. `chrome.tabs.reload`
  of the blocked request keeps the opener's initiator, and the provider rule then allows it (review-53, both popup
  kinds, one trial each; without `tabIds`). The build's live test runs it many times with the per-scope rules;
- the worker removal: a list that loses a provider entry removes the workers, as for a lost entry.

The relay's layer 1 (C11) and agent-browser's `open` and `goto` use L only: a provider is off the list for the
agent's own navigation.

### 7.3 The relay (C11)

- The `allowlist` line carries the providers (today: `"providers":[...]`; per-scope: `"providers":{"<list>":[...]}`),
  with the same rules as the receiver's (a shared vector).
- A main-frame `Page.navigate` and a `Target.createTarget` with a URL whose host is a provider of the scope's list
  and that the list does not cover: refused, with the new text `Not allowed: <host> is a sign-in provider of this
  allowlist. Open the site, and its sign-in goes there.` This refusal is the only guard for both: the relay sends
  `Target.createTarget` as an `about:blank` tab and a `Page.navigate` (C11), and both carry the receiver's ID, which
  the provider rule allows (section 4.2). Today's relay refuses no host at all (section 3), so for today's one list
  this refusal comes first; in the per-scope build it is a part of layer 1.
- No other change: `Page.reload`, `Page.navigateToHistoryEntry`, input and `Runtime.evaluate` on a provider's page
  go to Chrome as on a listed page. `Browser.grantPermissions` for a provider's origin stays refused (L only), and
  `automaticDownloads` covers L only.

### 7.4 agent-browser's own guard

- The list file gets a second array: `{"allow": [...], "providers": [...]}` (C5's `allowlist.json` too). Its
  entries follow `validateAllowlist`.
- `open` and `goto` refuse a provider host that `allow` does not cover, before the navigation: `refusing:
  tenant.auth0.com is a sign-in provider, not a site of the allowlist; open the site and start its sign-in there`.
- Every check of the tab's own page accepts a provider's page: `assertAllowed` before each command, the tab lists
  (`tabs`, the resolve of `<tab>`, attach), PR #47's input guard (the URL inside the lock, the stop at a navigation
  off the list), the capture of `outline` and `net`, and the document check of `shot` and of the file input. So the
  agent can choose an account and type on the provider's page, and the click on the site's sign-in button does not
  stop at the navigation to the provider.
- `fetch` and `download` keep L only for the URL that they fetch: that request is the agent's own, as a `goto` is.
- `redirectError` no longer calls a redirect to a provider an error; its sign-in hint names the provider entry:
  `...; add <host> as a sign-in provider of the list, or ...`. `isSignInHost` learns the common tenant domains
  (`*.auth0.com`, `*.okta.com`, `*.onelogin.com`; a hint only).
- In plain agent-browser (no DNR) this is the whole guard: Chrome still follows every site navigation anywhere
  (section 3), as today.
- Behind `--cdp-url` agent-browser reads the list file that agentwatch gives it. For the per-scope build that file
  must hold the session's scope's list and providers: aw-lead's part (section 9).

### 7.5 The web viewer and `blocked` (C4)

- Each list in the viewer has two parts: its sites and its **sign-in providers**. A provider entry follows the C5
  entry rules. The viewer's hint: "The host that this list's sites send you to for their sign-in, for example
  tenant.auth0.com. A site's sign-in can open it; an agent cannot open a URL of it directly." The viewer warns in
  two cases:
  - an entry of two labels whose provider serves many customers (for example `auth0.com`, `okta.com`,
    `google.com`, `microsoftonline.com`): "This covers every customer of the provider and its own site. Use your
    tenant's host.";
  - an entry that is, or covers, a host on which one provider serves every customer, so that there is no tenant
    host (a named list; agent-browser's `SIGN_IN_HOSTS` in `src/errors.ts` is a start: `accounts.google.com`,
    `login.microsoftonline.com`, `login.live.com`, `appleid.apple.com`, `signin.aws.amazon.com`,
    `id.atlassian.com`; the build adds others, for example `github.com` for a GitHub sign-in): "This host serves
    every account of the provider. With it, an agent's script on this list's sites can use every page of it with
    your sign-in there, for example your account's settings."
- `blocked` gets the host of the page that the tab showed before the blocked request, `"from":"<host>"` (or `null`):
  the tab's last committed `http:`/`https:` main-frame host, and for a new popup with no commit its opener's host
  (`sourceTabId`). `from` does not say who started the blocked navigation: the site, a click or a script of the
  agent, or the agent's own `goto` from that page all give the same `from`. When `from` is a site of a list and
  `host` is on no list, the viewer can show "A tab on <from> was blocked at <host>" with the offer "Add <host> as a
  sign-in provider of <list>". It never says that the site sent the tab there. The operator decides; nothing is
  added by itself.

## 8. The contract changes

Today's one list: these change the text of `set_allowlist` (before ab-v16.30, main `27543ce`) only if the operator
needs option a before part 1a merges. The per-scope build: the text of `set_scopes` in force (since ab-v16.30).

### C4

- Today: `{"t":"req","id":"<id>","op":"set_allowlist","domains":["a.example"],"providers":["tenant.auth0.com"]}`.
  A `providers` that is not an array applies as empty and counts 1 in `refused`; each entry follows C5, and an entry
  that is not normalized counts 1 and the others apply. The answer's `rules` counts rule 9 too.
- Per-scope: `set_scopes` gets `"providers":{"<list>":["tenant.auth0.com"]}`, with the counts of C4's `lists` and
  of its valid names (C4 at main):
  - A key that is not a valid name applies as absent: it counts 1 in `refused`, and each entry of its array counts
    1 more (as a list whose name does not match).
  - A key that is a valid name but names no list that applies (it is not in `lists`, or its list applies as absent)
    applies as absent with no count (as C4's valid name that is not in `lists`; the list's own refusal is counted
    already). Its entries do not count.
  - A value that is not an array applies as absent and counts 1 (as a list whose value is not an array).
  - Each entry of a value that applies follows C5: an entry that is not a normalized entry counts 1, and the others
    apply.
  - A `providers` that is not an object counts 1 and applies as `{}`. A missing `providers` applies as `{}` with no
    count, as a missing `operator` applies as `null` with no count. The reason: `lists` and `scopes` are required
    (a missing one counts 1, because every `set_scopes` has them), but `providers` is optional, and a daemon with no
    provider entry may leave it out.
  - The object replaces the last one in full with the rest of `set_scopes`. `rules` in the answer counts the
    provider rules too.
- `blocked`: `{"t":"blocked","tab":<tab id>,"host":"<host>","scope":"<scope>"|null,"from":"<host>"|null}`.
- The vectors: `test/vectors/scopes.json` gets objects with `providers` (valid, a key with no list, a value that is
  not an array, a refused entry) and what applies.

### C5

- The provider rule and the frame rule's `topDomains` of section 7.1 (today: dynamic rule 9 and rule 4, with no
  `tabIds`, so in every tab; per-scope: three session rules per list).
- The limits text: a list with providers has three session rules, so with a provider on every list about 1,660
  lists can be in use at once (two rules per list: about 2,490).
- A tab's covered hosts (section 7.2: a tab of a scope, a marked tab, any other tab of no scope by the union, the
  restore tab, the orphan set) in the closing rule, the guard, the retry and the worker removal; the list's sites
  alone in the relay's and agent-browser's refusals.
- `allowlist.json`: `{"allow": [...], "providers": [...]}`.
- With choice 2 a: at each `set_allowlist` / `set_scopes`, the receiver clears the cookie content settings that it
  wrote and writes, for each list L, each provider p of P(L) and each entry e of L,
  `contentSettings.cookies.set({primaryPattern: "https://*.<p>/*", secondaryPattern: "https://*.<e>/*", setting:
  "allow"})`. Measured (review-53, Chromium 156): Chrome refuses the `[*.]` form (`Invalid host.`); the `*.` form
  covers each host itself and its subdomains, it matches URLs with a port (the probe's), and the frame's silent
  renew then got a code. A
  content setting acts on the whole profile, so it holds in every scope's tab on a site of L (as the grants of C11
  do). C10 needs no change: the receiver writes them itself, not through a bridge op.

### C10

- No new op. The retry's trigger uses the covered hosts (section 7.2).

### C11

- The `allowlist` line: today `{"t":"allowlist","domains":[...],"providers":[...]}`; per-scope the `providers`
  object of `set_scopes`. The relay applies the C4 rules to it (the shared vector).
- The refusal table gets a row: "A navigation to a sign-in provider: `Page.navigate` of a tab's main frame, or
  `Target.createTarget`, with an `http:`/`https:` URL whose host is a provider of the scope's list and that the
  list does not cover" -> `Not allowed: <host> is a sign-in provider of this allowlist. Open the site, and its
  sign-in goes there.` The row "A navigation off the scope's list" keeps its text for every other host.
- `test/vectors/endpoint.json`: the new refusal.

## 9. The build tasks

| Task | Repo | What | Depends on |
| --- | --- | --- | --- |
| 1. The contract | chrome-extension | C4, C5, C10, C11 of section 8 for the per-scope build, the vectors (`scopes.json`, `endpoint.json`); ab-lead mails the commit to aw-lead before it merges (C4 and C5 bind agentwatch). Into the open contract work of the per-scope build if it is still open, else a small PR before part 1a | the operator's answer (choice 1) |
| 2. The receiver | chrome-extension (`agent/`) | Part 1a: the provider rule per list, the frame rule with the providers, the covered set in the closing rule and the worker removal, the removal of dynamic id 9 at the start, `blocked`'s `from`. Part 1b: the retry with the covered set. Part 1c: the guard with the covered set. With choice 2 a, the cookie content settings. Unit tests with the fake chrome; the live test of the six flows of section 3 with a provider on a list's `providers`, many times for the popups | 1; parts 1a to 1c of the per-scope build |
| 3. The relay | agent-browser (`src/relay/`) | Part 2: `providers` in the `allowlist` line, the provider refusal of `Page.navigate` and `Target.createTarget` (in layer 1), unit tests with the fake bridge, the live test through Playwright and the MCP (the agent's `goto` of the provider refused; a site's sign-in through it works) | 1; part 2 of the per-scope build |
| 4. agent-browser's own guard | agent-browser (`src/allowlist.ts`, `src/browser.ts`, `src/errors.ts`) | The `providers` array of the list file, the refusal of `open` and `goto`, the covered set in every other check (section 7.4), `redirectError` and the sign-in hint, README; unit tests; the live test in plain mode and over `--cdp-url` | 1 (the file format) |
| 5. agentwatch | agentwatch (aw-lead) | The provider entries per list in the web viewer, the two warnings of section 7.5 (a broad entry; a shared host of the named list), the offer from `blocked`'s `from` (with its wording); `providers` in `set_scopes` and in the `allowlist` line; the list file of each session's agent-browser with its scope's list and providers; the send of a provider's sign-in (which list: choice 6 of the per-scope design); the skill text (a refused `goto` of a provider; how a sign-in reaches it) | 1 to 4 |
| (Today's one list, only if the operator needs a before part 1a merges) | chrome-extension, agent-browser, agentwatch | Dynamic rule 9 and rule 4 with the providers; the relay's provider refusal (today's relay has none); task 4; `set_allowlist`'s `providers` | the contract text of section 8 for `set_allowlist` |

Each task: test first, a fresh reviewer per PR, no tag or publish. Option c needs none of them: the operator adds
the provider's tenant host to the list in the web viewer today.

## 10. Choices for the operator

ab-lead asked these in the Needs You question ab-pbk before any build (the task's check); the text below says
the same as that question.

**Choice 1. How should a listed site's sign-in reach its external provider (for example Auth0), while the agent's
own navigation stays on the list?**

- **a. A sign-in provider entry per list (recommended).** You name the provider's host in the list's second part. A
  site's sign-in (its redirect, a popup, a SAML form, the account chooser with the agent's clicks and typing)
  reaches it. The agent cannot open a provider URL directly; an open redirect on a listed site, the site's own
  sign-in URL, a link or the agent's own script in a listed page still reach the provider. A shared host such as
  `accounts.google.com` has no tenant host: as an entry it opens all of it, every page with your sign-in there. A
  medium build in three repos.
- b. Any navigation that a listed page starts may go anywhere. The list then no longer bounds a page's links or the
  agent's own scripts. In its strict form the provider's own login form fails.
- c. The provider as a normal entry. It works today with no build. The agent can also open the provider's pages by
  itself.
- Recommendation: a, with c meanwhile, using the provider's tenant host only.
- No answer: c (no build; you add the provider's tenant host to the list when a sign-in needs it).

**Choice 2. Should the agent browser let a provider's own cookie go to its frame on the list's sites, so that a
silent renew in a frame works?** The agent browser's Chromium today (Debian Chromium 156) blocks third-party
cookies by default (measured), so a site that renews its sign-in in a hidden frame loses it when the token
expires. The agent unit moves to Google Chrome stable in agentwatch's stage 4 step C. Google Chrome stable may
allow third-party cookies by default; aw-lead checks it in step C's live run. If it does, this choice changes
nothing there.

- **a. Yes, for each list's providers on that list's sites only (recommended).** A small part of the receiver's
  build: one content setting per provider and site (`https://*.<provider>/*` under `https://*.<site>/*`, measured
  by review-53). Every other third-party cookie stays as the browser's default has it.
- b. No. A site that falls back to a top-level redirect still signs in; a site that renews only in a frame does not.
- Recommendation: a, because the silent renew is one of the flows that you named, and the exception is narrow.
- No answer: b. (Only with choice 1 a or c.)

The sign-in beam needs no choice: the operator sends the provider's own sign-in as a second send when unattended
sign-ins must work (section 5), and choice 6 of the per-scope design decides which list it joins.

## 11. The limits and what is not measured

- The agent's click on a link and its own script in a listed page are a site's navigation to DNR and to the relay
  (section 4.1). With option a such a navigation can reach the list's providers, never another host.
- An open redirect on a listed site, and the site's own sign-in URL, take the agent's own `goto` to any page of the
  list's providers (option a; measured with `other.test` for another host: blocked).
- A shared provider host with no tenant host (`accounts.google.com`, `login.microsoftonline.com`, `login.live.com`,
  `appleid.apple.com`): as a provider entry, every page of it is open to the agent's click or script in a listed
  page, with the operator's provider sign-in when it was sent (section 7.5: the viewer warns).
- The relay's refusal is the only guard of a client's `Page.navigate` and `Target.createTarget` to a provider URL in
  agent mode (section 7.3): both carry the receiver's ID, which the provider rule allows.
- A back to a provider's page made no network request (section 4.1): only the guard (C5) sees such a page, and it
  counts the providers as covered.
- Third-party cookies (section 5) and choice 2.
- A finding outside this design: today's receiver answers an import `ok: false` (`restore page`) after it has set
  the cookies (section 5). The per-scope import rules remove that case for a domain on no list; a failure after
  step 1 for another reason still leaves the new cookies.
- **Not measured:** Google Chrome stable (the agent unit runs Debian Chromium, `/usr/bin/chromium`, until agentwatch's
  stage 4 step C moves it to Google Chrome stable) and its default for third-party cookies (aw-lead checks it in step
  C's live run); a person's click (the probe's clicks are CDP clicks); the Mac; a real provider (Auth0, Okta, Google,
  Microsoft) with its own scripts, captchas, bot checks and second factors; FedCM, the Storage Access API and
  passkeys; a provider's service worker; the candidate rules with `tabIds` (the per-scope build), and the retry of a
  sign-in popup to a provider many times under load (review-53 ran it once for each popup kind, without `tabIds`);
  Playwright's `waitForEvent("popup")` on a provider popup under the per-scope rules; the provider refusal in the
  relay (design only).

## 12. The evidence

[2026-11-05-sign-in-provider-probe/README.md](2026-11-05-sign-in-provider-probe/README.md), its source (`site.ts`,
`common.ts`, `initiator.ts` with `ext/`, `agent.ts`, `plain.ts`, `cookies.ts`, `tables.ts`) and its results.

| What | Result | File |
| --- | --- | --- |
| Where today's guards block each flow, agent mode, L1 and L2, Playwright | Rule 1 blocks every top-level provider step; the frame loads; with L2 every flow works, the agent's input included | `results/agent.json` (group pw) |
| The same with agent-browser over the relay | The click works, then the tab does not resolve (L1); every step works (L2) | `results/ab.json` |
| The same in plain agent-browser | Chrome follows every site navigation; agent-browser refuses the provider's tab (L1) | `results/plain.json` |
| Who starts each navigation; the six rule sets | Section 4 | `results/initiator.json` |
| The beam with and without the provider's sign-in | Section 5 | `results/beam.json` |
| The provider's cookie in a frame | Blocked by Chromium's default; a content setting allows it | `results/cookies.json` |
| review-53's extra cases: a `meta` refresh, a `data:` page, an extension-made `about:blank`, a sandboxed frame's top navigation, the retry's `tabs.reload`, the content setting patterns | Sections 4, 5 and 7.2 | `review-53-extra.ts`, `results/review-53-extra.json` |
