# PageFetch: the agent browser fetches a page that blocks agents (design)

Board task: ab-v16.102. Status: approved by the operator (board answer ab-1wu, 2026-11-15).

## 1. The answer in short

PageFetch is a new tool of the agent browser's MCP. An agent calls it with one URL when Claude's WebFetch fails on
that page (a 401, a 403, a bot check, a page that needs JavaScript, or a PDF). The service opens a clean private window
of the agent Chrome, which the operator does not see. The page loads there with no sign-ins and no cookies of the
profile. When the page has rendered, the Defuddle library converts the live DOM to markdown, in a separate script
world of the tab. For a PDF, Mozilla's pdf.js reads the text. The window closes, and the agent gets the markdown.
PageFetch needs no allowlist, because it never clicks, types or sends a form, and it refuses local and private
addresses.

Every agent gets the agent browser's MCP: PageFetch, and also the browser tools. The allowlist still guards the browser
tools, and a request for a page off the list goes to the operator for approval (section 5.13).

## 2. The operator's words (2026-11-15)

- "i want the agentbrowser needs to offer a tool similar to claude's webfetch where it obtains a page and a model
  converts / summariezes the page to markdown. this can be used without any allowlist because no interaction is
  allowed on the page, only strict fetching, no forms, no interaction."
- "the idea would be to use this tool if webfetch returns a 401"
- "see what exists already for HTML to markdown conversion. we don't want to roll our own for this."
- "the idea is to convert the fully rendered DOM to markdown, not just the HTML returned by the page... but the DOM
  itself after full rendering"
- "no sign-in. uses a clean window. and we offer this as an MCP option. PageFetch... build it as an alternative to
  webfetch, but for pages that block agent fetching"
- Board answer ab-20v (confirmed): the page loads in "A clean private window of the agent Chrome", and PageFetch
  returns the text of a PDF "with Mozilla's PDF library (pdf.js)".
- "every agent gets the mcp for PageFetch"
- "let's also give it the navigation mcp. when the agent requests a page that's not on the allowlist, it goes to the
  operator for approval."

The first user is a research agent of the operator. It reads public pages for citations, and WebFetch fails on
nine of them: a 401, three 403s, two Anubis bot checks (one of them a PDF), one page that needs
JavaScript, and two Cambridge PDFs. A Cambridge chapter PDF matters most to it. The board task lists the URLs. No
test fetches them.

## 3. Goals, non-goals and anti-goals

Goals:
- An agent gets the readable content of a public page that blocks plain HTTP clients, as markdown, with one tool
  call and no allowlist.
- The content is the page after it renders: the text that its JavaScript makes, without the parts that CSS hides.
- A PDF gives its text.
- The page sees the agent Chrome that the project made to look like a person's browser.

Non-goals (not in this design):
- A model in the service. The tool returns markdown, and the calling agent's own model reads it (section 6). The
  service needs no API key, and a call costs no money.
- A command line command or a Playwright API for the fetch. PageFetch is an MCP tool only.
- Pages that need a sign-in. A real 401 of a site that needs a login stays a refusal.
- A bot check that needs a click (for example Cloudflare's check box). PageFetch reports it; it never clicks.
- Images, video, audio and files other than HTML and PDF.

Anti-goals (a result that works but fails the goal):
- Any interaction with the page: a click, a key, a form submit, a file chooser.
- Any sign-in, cookie, storage or cache of the agent profile in the fetch window.
- A fetch that reaches an address on the box or in a private network.
- A converter that we write ourselves.
- A browser that bot checks find more easily than the agent Chrome (approach B, section 4).

## 4. Approaches

| | A. A private window of the agent Chrome (chosen, ab-20v) | B. A separate Chromium with an empty profile |
| --- | --- | --- |
| What the page sees | The agent Chrome, driven through the extension, with no remote-debugging marks | A Chromium driven over a debugging pipe: what bot checks catch |
| Isolation | Chrome's incognito context: no cookie, storage, cache or history of the profile | A new profile for each fetch |
| Parallel fetches | One at a time: all incognito windows of a Chrome share one cookie jar | Many |
| Cost to build | A new receiver release and contract changes with the agentwatch lead | No extension change |

The model: the service could run a small model on the markdown, as WebFetch does. It would need an API key and money
for each call, and the calling agent already has a model. So PageFetch returns the markdown (the lead's call, not
refused by the operator).

The converter: four libraries were compared (2026-11-15, npm registry and download counts).

| Library | Use | Rendered DOM | Weekly downloads |
| --- | --- | --- | --- |
| Defuddle (chosen) | Finds the main content, removes menus, ads and footers, and gives markdown through Turndown. The engine of the Obsidian Web Clipper. | Yes: it runs on the live `document` and reads the real CSS | 1.55 M |
| Turndown | HTML or a DOM node to markdown, the whole page, no extraction. Reports say that WebFetch uses it. | Yes | 17.4 M |
| Mozilla Readability | Firefox's Reader View: the article, as HTML | Yes, on a copy | 4.3 M |
| mdream | A fast converter of an HTML string | No: no CSS | 67 K |

Defuddle is chosen because it is made for this exact job on a live document, and its markdown step is Turndown.

## 5. How it works

### 5.1 The tool

- Name: `PageFetch` (the operator's name). The service's other tools have snake_case names (`browser_sign_in`); the
  operator's name stays.
- Input: `url` (required: an absolute `http:` or `https:` URL), `mode` (optional: `main`, the default, gives the main
  content; `whole` gives the whole rendered page, for lists, tables and pages that are not articles), and `offset`
  (optional: the character position to read from, as WebFetch's `offset`).
- Output: one text result. A short header, then the markdown:
  - the final URL after redirects, the page's title, the HTTP status of the main document, the kind (`html` or
    `pdf`), the length of the whole markdown, and, when the result is cut, the `offset` of the next part;
  - then the markdown (for a PDF, the text of each page under a `## Page N` line).
- Size: at most 100,000 characters in one result (the lead's call). The service keeps the whole markdown of a fetch
  in memory for 15 minutes for the scope that fetched it, so a call with `offset` reads on with no second fetch.
- Errors, each a tool error with one plain sentence and a code:
  - `refused`: the URL is not `http(s)`, or its address is local or private (5.4);
  - `blocked`: the page shows a check that needs a click, or it stays on a check page until the time limit;
  - `timeout`: the page did not load in time;
  - `too_large`: the PDF is larger than the limit;
  - `busy`: the queue is full (5.6);
  - `unavailable`: the receiver has no `fetch` feature, or Chrome could not start.
- A PageFetch call is a use (C12): when Chrome is stopped (for example after its idle stop), the call starts it, as
  every other tool call does. The start's own wait comes first; the fetch's limits (5.5) start when the fetch gets the
  window (the lead's call).
  An HTTP status of 400 or more is not an error: PageFetch returns the page's text with its status, because an error
  page can say why.

### 5.2 Who can call it

PageFetch is one of the service's own MCP tools, as the stored sign-ins' tools are (`SERVICE_TOOLS`,
`docs/contracts/mcp-allow-list.md`; the transport answers it itself). It does not need the stored sign-ins part.

Today two rules keep it from a session whose repo has no site on its list:
1. agentwatch adds the MCP entry to a session's configuration only when the session's scope has a list with at least
   one site (the operator's answer Q2 of the self-contained design, section 16).
2. The MCP path refuses a scope whose list has no site with the no-list 503 (C11).

The first user's repo has an empty list. The operator decided (O1, 2026-11-15): "every agent gets the mcp for
PageFetch". So:
- agentwatch adds the MCP entry to every agent session's configuration, also when the scope's list is empty or the
  scope has no list (a change of the answer Q2, by the operator);
- the MCP path admits such a scope, and in it PageFetch works; the browser tools of such a scope keep the list's
  rule (section 5.13).
- This changes C11's step 8 of the MCP path (the no-list 503 of a scope whose list has no site), C12's checks at a use
  for such a scope, the token texts that name a list with a site, and agentwatch's rule that mints an `mcp_token`
  only for a session whose list has a site. Each sentence needs the agentwatch lead's explicit OK.

### 5.3 The fetch window

- The receiver opens it with C10's `windows.create`, `incognito: true`, `focused: false`, a new mark `fetch`, and the
  caller's scope, at `about:blank`, the same way as the sign-in act's window. A receiver whose hello's `features` hold
  `fetch` has it (C4); the service tests for membership.
- The fetch tab's main frame may load any `http(s)` host: a rule of the kind of the marked-tab rule 8 (C5), and the
  guard skips the tab. The scope's list does not apply to it. The merge guard's floor (C5 rule 9) blocks every write
  to GitHub's hosts from it, as from every tab that agent-browser's model does not judge.
- No client connection sees the tab, attaches to it or gets its events (the model's hidden tabs, as for the act).
- One private window at a time on the box. The fetch and the sign-in act share one lock in the service, so neither
  starts while the other runs. A waiting sign-in act gets the lock before every queued fetch, and the act's wait for
  the lock (C11's check 7) covers one running fetch to its limit, so an act never fails behind a fetch (the lead's
  call; the numbers are the builder's). Both refuse while the operator has a private window open in the agent Chrome (the
  receiver's existing check).
- The service ends the window at the end of each fetch, also after an error. Chrome then drops the incognito context
  with its cookies, storage and cache. The receiver ends a fetch window that a crash left before the next one opens.
- On Linux the window stays off the operator's screen as the act's window does (the Linux server's private X screen). The Mac is
  section 5.10.

### 5.4 Local and private addresses

PageFetch has no allowlist, so it must never reach the box itself or a private network.

- Only `http:` and `https:` URLs. Others get `refused`.
- Refused addresses: loopback, private (RFC 1918), link-local (with 169.254.169.254), carrier-grade NAT, unique local
  and link-local IPv6, IPv4-mapped forms of these, multicast, `0.0.0.0` and `::`, and every name that ends in
  `.localhost`, `.local` or `.internal`.
- The service checks the URL before it opens the window: an IP literal by its range, a name by all the addresses that
  the box's resolver gives for it. One refused address refuses the URL.
- Every request of the fetch tab, its frames and its dedicated workers goes through the same check before Chrome
  sends it (the debugger's request interception, with the workers attached). Redirects and navigations that the page
  makes are requests too.
- A service worker or a shared worker of the page is not always a child of the tab, so its requests can pass outside
  that interception. For them the guard is Chrome's Local Network Access (next point) and a receiver rule that blocks
  every request to a refused IP literal from the fetch window; the window's end drops each such worker with the
  incognito context (the lead's call). A live test has a page whose service worker and shared worker try a refused
  address.
- Chrome's Local Network Access check stays on as one more layer: a public page cannot reach the local network in a
  context with no permission, and nobody grants one in the fetch window.
- A stated limit: Chrome resolves the name again when it sends the request. A name whose address changes between the
  two lookups (DNS rebinding) can pass the service's check. Local Network Access stops such a request to loopback and
  to private ranges.

### 5.5 The load and the wait

- The service attaches, enables the page and network domains, bypasses service workers, and navigates.
- The page's own scripts run. A proof-of-work check (for example Anubis) or a JavaScript check that ends with a new
  navigation passes with no input. The service follows the page's own navigations, each checked by 5.4, up to 10.
- The page is ready when its load event has come, no navigation has started for 2 s, and no network request has been
  open for 500 ms. The longest wait for ready is 30 s. The whole fetch has a limit of 60 s.
- A check page that needs a click (the service recognizes the known challenge frames and texts) gives `blocked` at
  once. A page that is still a check page at the limit gives `blocked`.
- No input: the service sends no `Input.*` event and no key. A dialog (`alert`, `confirm`, `prompt`, `beforeunload`)
  is dismissed. A popup closes. Downloads are denied. Permission requests are denied.

### 5.6 The conversion

- Defuddle runs in a new isolated world of the tab (`Page.createIsolatedWorld`, `grantUniversalAccess: false`), so
  the page's scripts cannot see it or change its result. The service carries the library as one script string, built
  from the pinned package.
- Options: `url` (the final URL), `markdown: true`, `useAsync: false` (no call to a third party). `mode: whole` turns
  off the removal of low-scoring blocks; the removal of hidden elements stays on in both modes.
- The result: the title and the markdown. When `main` gives almost nothing (fewer than 200 characters), PageFetch
  converts the whole page instead and says so in the header.

### 5.7 PDFs

- A main document whose type is `application/pdf` is a PDF. The service takes its bytes from the debugger's network
  domain, at most 25 MB (`too_large` above that).
- pdf.js (the `pdfjs-dist` package) reads the text of each page in the service, with no script of the PDF run.
- A PDF with no text (a scan) gives a result that says so. There is no text recognition.

### 5.8 Limits

- One fetch at a time on the box (5.3). A queue holds at most 8 waiting fetches; past that, `busy`.
- At most 30 fetches in any 10 minutes for one scope; past that, `busy` with the time to wait.
- The 15-minute memory of results (5.1) is per scope and holds at most 20 results.

### 5.9 Logs

The service writes one line for each fetch: the scope, the host, the result code, the HTTP status, the time and the
size. It writes no path, query or page text, because a URL can hold a token.

### 5.10 Platforms

- The Linux server first, where the agents run. The fetch comes from a datacenter IP, so some sites still refuse it.
- The Mac follows with the Mac service (stage 4 of the self-contained design). There the window must take no focus
  and stay out of the operator's view without the Linux server's X screen. That part is designed and checked with the Mac
  service, through the manager.

### 5.11 Contracts

- chrome-extension: C10 (the `fetch` mark of `windows.create`), C4 (the `fetch` feature and the end of a fetch
  window), C5 (the any-host rule for the fetch tab, the guard's exception, the floor).
- agent-browser: C11 (the PageFetch tool, its address rule, its window and lock), `docs/contracts/mcp-allow-list.md`
  (the new service tool), and C12 if the status reports fetches.
- agentwatch: the MCP entry rule (O1) and the skill text that tells agents to use PageFetch when WebFetch fails with a
  401, a 403 or a bot check.
- The agentwatch lead gives an explicit OK of each changed sentence before its merge.

### 5.12 Dependencies

- `defuddle` (with `turndown`, which its markdown step uses) and `pdfjs-dist`.
- Each pinned at its newest version that is at least 30 days old (the repo's release-age rule), with
  `ignore-scripts` on, and each with a technical vetting record in `docs/supply-chain/`, as ghost-cursor has. The
  legal team does any licence check; this design does none.

### 5.13 The navigation tools for every agent

The operator (2026-11-15): "let's also give it the navigation mcp. when the agent requests a page that's not on the
allowlist, it goes to the operator for approval."

So every agent gets the whole MCP (5.2), with its browser tools, not only PageFetch. The allowlist keeps guarding
those tools: an agent opens only a host that its repo's list covers. A request for another host goes to the operator.

What exists today:
- A navigation off the scope's list gets `Not allowed: <host> is not on the allowlist` (C11), and the refusal makes a
  blocked report (`daemon.blocked`).
- The service makes an operator prompt from a blocked report (C12, stage 1c). The operator allows the host in the
  web viewer (`prompt_allow`), and the host goes onto the repo's list. The agent's next try passes.

What changes:
- The MCP path admits a scope whose list has no site, and a scope with no list, instead of the no-list 503 (5.2).
- A blocked report of a scope with no list also makes a prompt. The prompt names the repo's list, and the operator's
  allow makes that list with the host as its first site. Today a report makes a prompt only when the scope has a list.
- The refusal tells the agent that the operator was asked, and that the agent can try again after the operator allows
  the host. The navigation does not wait for the answer.
- The lead's proposal: the same admission for the CDP endpoint (vanilla Playwright), so that both doors of the agent
  browser have one rule. The operator named the MCP.

Not changed: the prompt's channel (the web viewer, as today), the dismissal rule (24 hours), the limit of 20 open
prompts, and the per-repo lists.

## 6. Tests

- Unit tests on fakes for the tool's input, output, paging, errors, the queue, the rate, the memory and the logs.
- The address rule: each refused range, a name that resolves to a refused address, a redirect to one, a subrequest to
  one, and a public address that passes.
- The receiver: the `fetch` window, its rule, the guard's exception, the hiding, the lock with the act, the end after
  a crash.
- Live tests on local pages only, never a public site: a page that its JavaScript renders; a page with text hidden by
  CSS; a page that runs a proof-of-work and then navigates; a page with a check that needs a click (`blocked`); a PDF
  with text and a PDF with none; a page that tries a dialog, a popup, a download and a request to a refused address.
  The address rule refuses the test server's loopback address, so the tests start the service with a test-only
  setting that admits that one server; the setting does not exist in a production build.

## 7. Stages

1. The receiver: the `fetch` window, its rule, the guard's exception and the feature; a receiver release and the
   lead's repack; the agentwatch lead's pin.
2. The service: the tool, the lock, the address rule, the load and wait, Defuddle, the limits and the logs.
3. PDFs with pdf.js.
4. agentwatch: the MCP entry (O1) and the skill text (the agentwatch lead).
5. The navigation tools for every agent (5.13): the admission of a scope with an empty list or no list, the prompt
   for a scope with no list, and the refusal's text. It can be built at the same time as stage 2.
6. The Mac, with the Mac service.

Stages 1 and 2 can be built at the same time on the contract text. The first user can use PageFetch after stages 1, 2
and 4; its PDFs after stage 3.

Outside this design: agentwatch writes the MCP entry only while its switch to the self-contained service acts (its
stage 3 on the Linux server). So no agent gets PageFetch before that switch, whatever the order of the stages above. The change
of agentwatch's entry rule (O1) also goes on agentwatch's own board for the operator's word (the agentwatch lead asks
for it when the contract sentences come).

## 8. Left to the builder

- The exact list of challenge frames and texts for `blocked`, from public documentation, not from live probes.
- How the service carries the Defuddle script string into the tab (a build step or a file read at the start).
- The exact interception method for every request of the tab, its frames and its workers.
- The markdown header's exact format.

## 9. The operator's answers to the open questions

- **O1. The MCP for every session.** Decided by the operator (2026-11-15): "every agent gets the mcp for PageFetch"
  (section 5.2).
- **O2. A real-site check.** Answered by the operator (ab-1wu): "I said no cloudflare bot test from [the Linux server]. I.e. we
  don't try to click the box from there. But we can start fetching pages right away." So the release check fetches
  the first user's nine pages from the Linux server, and no check clicks a check box from there.