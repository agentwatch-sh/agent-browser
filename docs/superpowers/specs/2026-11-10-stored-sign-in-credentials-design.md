# Agents sign in from credentials that the operator stores — design

**Status: Decided: the operator's answers of 2026-11-10 to section 14 (board item ab-8w8; section 14, "The
answers"): Q1 a, Q2 b, Q3 b, Q4 a. The operator answered all the questions of the token design too (A, B1, B2, C, D
and the address list; section 5.7), and this design builds on those answers. Revised after one fresh review
(review-104, one fix round) and a narrow re-check (review-104b).**

Date: 2026-11-10. Author: a taylor contributor, a design subagent of the lead (board task ab-v16.95, goal ab-v16).
Branch `ab-v16.95-stored-credentials-design` in agent-browser, from main `3fe1427`. No product code and no
contract file changes in this task: section 10 names each sentence that a later task changes.

Evidence:

- a local probe on taylor with fake values only (section 12 and
  [2026-11-10-stored-sign-in-credentials-probe/](2026-11-10-stored-sign-in-credentials-probe/README.md));
- agentwatch's code on taylor, read only (commit `a98d60e6`): `accounts/store.py`, `daemon/secret_store.py`,
  `auth_link.py`, `server/login.py`, `daemon/browser/relay.py`, and its first agent-browser design (the operator's
  decisions O1 to O19);
- Chromium's public documentation and source: `docs/linux/password_storage.md` and
  `components/os_crypt/async/browser/posix_key_provider.cc`;
- the token design, PR #103 at `4ddae4f` (not merged):
  [2026-11-10-mcp-connection-tokens-design.md](2026-11-10-mcp-connection-tokens-design.md) on its branch, "the
  token design" below. The operator answered its questions on the board items ab-0wv, ab-sxg, ab-ufy and ab-5t3
  (2026-11-10), and its revision to those answers runs in the same PR. This design uses the answers, not the
  text of `4ddae4f` where the two differ (section 5.7);
- agentwatch's Secret box seal (`server/static/modules/screen-seal.js`) and its caller check
  (`daemon/screen_op.py`), read only at commit `ca56fb4e`, for the pane's seal of section 5.2 and the offer of
  section 6.3.

Nothing ran on the Mac. No browser in this work opened a public site.

This design builds on the service design
([2026-11-09-self-contained-agent-browser-design.md](2026-11-09-self-contained-agent-browser-design.md), "the
service design" below), on the input design
([2026-11-10-vanilla-playwright-human-input-design.md](2026-11-10-vanilla-playwright-human-input-design.md)), and
on the contracts `docs/contracts/C11.md`, `docs/contracts/C12.md` and `docs/contracts/mcp-allow-list.md`. It keeps
every decided rule of those documents.

## 1. The answer in short

1. **An agent never fills a password into a tab that it can reach (section 4).** The probe shows why. After a
   fill in a tab where the agent has a CDP session, the agent reads the value in seven ways: `Runtime.evaluate`,
   `DOMSnapshot`, the submit's network event, its own interception of the submit (which can also send the body to
   another host), the back-forward cache after `history.back()`, a failed sign-in that leaves the value, and a
   script that it put in first. A tab of the agent on the same origin also reaches a sign-in tab of the same
   browser context: in the round-1 probe, the agent's service worker served the agent's own page at the sign-in
   path, and the agent's tab got each typed value by `BroadcastChannel` and by the `storage` event (review-104 B1).
   So the fill must happen where no agent session and no agent page is.
2. **The sign-in act in its own browser context (section 7).** The agent asks for a sign-in by the credential's
   name. The receiver opens a new incognito window for the act: an off-the-record browser context that shares no
   cookie, storage, Cache Storage, service worker, `BroadcastChannel` or history with the agent's tabs. The
   receiver's `chrome.debugger` cannot make a browser context (`Target.createBrowserContext`: "Not allowed",
   measured), so an incognito window is the way that agent mode has. No client sees, attaches or gets an event of
   the act's tab. The service loads the credential's sign-in page there, checks the origin and the form, types
   with the person's input of the input design, submits, and reads the result.
3. **The move (section 7.8).** After a good sign-in, the service takes the site's cookies and its `localStorage`
   from the act's context and moves them into the agent browser's default context through stage 1c's import path
   (the C2 rules and the box's own sign-in rule apply). Then the act's window closes, and its context goes with
   it. The agent's tabs then load signed-in pages (measured: by a cookie, and by a token that the site keeps in
   `localStorage`).
4. **The block and the guard (section 7.6).** From the first key to the end of the act, the receiver blocks every
   request except a top-level GET, of the act's tab, of its popups and of the site's workers, to a host outside the
   origins that may receive the password (`send_to`): every resource type, the WebSocket included. In the probe a page script sent each typed value
   through six channels; with the block, the other host got nothing, and the sign-in worked. Without it (the
   earlier design's guard alone), the other host got the whole password three ways and parts of it in each way.
5. **The screen (section 7.3).** The live view sends no frame of the display to any viewer during an act. The
   service also moves the act's window outside the screen's area at the X level (measured: the framebuffer that
   the live view reads then holds no pixel of it, and the sign-in still worked). The act watches the password
   field's `type`, and it empties the field and stops when the type changes (measured). A program of the user with
   the display's X authority can still reach the window: the same-uid limit.
6. **What the agent sees (section 7.9).** "Signed in to `<origin>`", or a refusal from a fixed list of texts. No
   answer, log line, event or status holds a username, a password or a form value.
7. **Where the credentials live (section 5, question Q1).** The same-uid fact of the token design holds here too:
   every agent of the operator's OS user can read every 0600 file of that user. So only a key that is not on disk
   stops a shell read of a password. The recommendation: each credential is a sealed record in agentwatch's token
   store (the token design's answer A), and only the agent-browser service holds the key that opens the records,
   in its memory, after the operator unlocks the store in the Browser pane. Other programs of the user cannot read
   the service's memory on taylor (`ptrace_scope` 1, and the service makes itself non-dumpable). The service's
   start holds board ab-v16.96 (hold SIGUSR1 at start; disable the inspector signal).
8. **No plain value in agentwatch (section 5.2).** The pane seals each typed password and passphrase to a key of
   the service in the operator's browser tab, with agentwatch's own Secret box seal. The gateway, the daemon and
   Cloudflare's edge get only sealed text (review-104 B4). The daemon is also non-dumpable, with no core dumps.
9. **Who adds, changes and removes a credential (section 6, question Q3).** The operator alone, in the Browser
   pane, with the password login, as for the lists. Q3 b is a change of that rule, and the question says so: an
   agent that holds a password in a file today may put it into the store once, and only its use waits for the
   operator's approval. The approval is in the seal, so no edit of a file can make an offer usable.
10. **Which scopes may use one (section 8, question Q2).** The operator's answer (Q2 b): every repo whose list covers
    the credential's host (and each host of `send_to`) may use it; no repos are named on a credential. Only a local session uses a
    credential: a request that a remote token admits (the token design's answer D c) never reaches the act.
11. **A second factor (section 9, question Q4).** The operator's answer (Q4 a): not in the first build. The act stops at a
    second-factor page and says so.
12. **Chrome's own password manager is not the store (section 5.4).** Its "basic" store on Linux has no
    encryption, and it fills saved passwords into pages that an agent drives.
13. **When it can be live on taylor (section 13).** After stage 1b part 2 and stage 1c (the model and the lists in
    the service), the new stage 1e (the store and the act in the service), the receiver's act window and rules (a
    chrome-extension task), stage 2 (agentwatch's client and the pane) and stage 3 (the switch on taylor, with the
    operator's approval). The MCP tool comes with stage 1d. No safe way exists on today's path: it would change the
    old path, which stays unchanged until stage 6.

## 2. The operator's ask and the rules

The ask, as the manager passed it (mail of 2026-11-10, recorded on board task ab-v16.95):

> "the operator asked when the agent browser has native username/password storage (agents sign in from stored
> credentials, no file)."

The board task's result line: "an agent signs in to a site from a credential that the operator stored, with no
file and with no way for the agent to read the password." The first user is a staging login of one of the
operator's sites. This design calls it `https://staging.example.com`. Today the agent of the repo that uses it
keeps it in a file.

This is not stage 1c's sign-in import. The import sends the cookies and the page storage of the operator's own
Chrome (C2 to C6). This design stores a username and a password, and the agent browser signs in with them.

Earlier words that this design keeps:

- The operator's top goal (2026-11-03): "Fully drivable browser for agents that isn't subject to automation
  blocks, so agents can do whatever I ask them to do." and "Ideal world: no prompts necessary."
- O9: one browser profile; the allowlist is always on. O14 to O19: the sign-in send from the operator's Chrome.
- The skill text of agentwatch's first browser design: "the operator signs in (an agent never types a
  password)". This design keeps it: the service types, never the agent.
- The service design's Q5 answer (board item ab-1n8): the service runs at all times, and Chrome starts and stops
  by use.
- The input design's answers (board item ab-0z5): a fill of a text field uses the person's input (typed keys when
  every character has a US key and the plan fits in 10 s).

The manager's rules for secrets (they count as the operator's):

- A secret never goes into an argv, a log line, git, the terminal or a URL; only into 0600 files or agentwatch's
  secret store.
- The operator alone adds, changes and removes a credential. (Option b of question Q3 changes the part "adds"; the
  question says so, section 6.3.)
- The operator's choices (where the credentials live, who may add them, which scopes may use them, a second
  factor) are questions with options (section 14), not decisions of this design.

The token design's rules, with the operator's answers to it, that this design takes as they are:

- agentwatch's daemon holds the secrets of the browser in its token store, `~/.config/agentwatch/tokens/` (0600
  files in 0700 folders, the permissions sweep at each write and each daemon start); the root gateway never reads
  a user's file.
- The operator's acts go through the Browser pane with the password login. The gateway builds the operator field
  from the credential and drops any `operator` key from the request body. A link login is a test login: its acts
  are an agent's.
- The daemon mints a connection token only for a session at its start (answers A and B2 of the token design). It
  makes no secret of a stored sign-in by itself: the store key comes only from the operator's set-up.
- The same-uid fact, in its words: "Every session of one OS user runs as one uid, so it can read every token file
  of that user." The limit of C11 stays: the checks stop mistakes, an agent that names another session or repo,
  and an injected instruction; they do not stop a hostile program of the same OS user.

## 3. Words

- **A credential**: one stored sign-in. It has a name (for example `staging`), an exact origin (scheme, host and
  port, for example `https://staging.example.com`), a sign-in path on that origin, a username, a password, the
  repos that may use it, and the origins that may receive the password (by default only its own origin).
- **The store**: all the credentials of one OS user on one box.
- **A sealed record**: one credential as it is on disk. Its username and password are encrypted to the store's
  public key. Its other fields are plain and hold no secret.
- **The store key**: the key pair that seals and opens the records. Its private half is on disk only wrapped
  (encrypted) with a key that the passphrase gives.
- **The passphrase**: a phrase that the operator chooses and types in the Browser pane to unlock the store
  (question Q1 a).
- **Locked**, **open**: the store is open while the service holds the store key's private half in its memory. It
  is locked after each start of the service, until the operator unlocks it, and after the operator's "Lock".
- **The pane key**: an X25519 key pair that the service makes at each start. The pane and the offer command seal
  each typed value to its public half (section 5.2).
- **The act**: the sign-in act of section 7.
- **The act window**, **the act tab**, **the act's context**: the incognito window that the receiver opens for one
  act, its tab, and the off-the-record browser context that the window has. No client sees them.
- **The default context**: the agent browser's one browser context of C11, where every client's tab is.
- **The move**: the import of the sign-in's cookies and `localStorage` from the act's context into the default
  context (section 7.8).
- **The block**: the receiver's rules that stop the act tab's requests to hosts outside `send_to` (section 7.6).
- **The guard**: the service's check of each request of the act tab that reaches it (section 7.6).
- **The service**, **the daemon**, **the walk**, **a scope**, **a repo key**: as in the token design.

## 4. The threat model

### 4.1 In plain words

The agent browser has one profile. An agent drives it through CDP (Playwright, the MCP, agent-browser's own CLI).
C11 sends every page-level call of a client to Chrome. So an agent can run its own script in any page of its
scope, read the page's DOM, watch the page's network, and change the page's requests. Every agent of the
operator's OS user also runs as that user, so it can read every file of that user and send a signal to each
process of that user.

A credential is worth more than a site's session: the session ends, and a password does not. So the design keeps
three rules:

1. The password is never in a page that an agent can reach, at any time (section 7).
2. The password is never on disk in a form that a program of the user can open by itself (section 5, Q1 a).
3. The password is never in an answer, a log line, an event, a status, an argv, an environment, a URL or git
   (section 8).

What the design cannot stop, stated plainly:

- a hostile program of the operator's OS user that replaces the service's code or its unit file, and then waits
  for the operator's next unlock;
- a site that sends the password away itself in a way that the block does not see: to its own origin or another
  origin of `send_to` (a hash, an encryption, a compression, a part of the value, a WebSocket), or by WebRTC;
- a site that sends the password back in a page or keeps it in its storage (the act finds the plain cases and
  refuses the move, section 7.8);
- a program of the user with the display's X authority (a 0600 file of the same user): it can read the display
  and the act window's title, move the window back onto the screen, and send it input (the same-uid limit,
  T16);
- after the sign-in, the site's own pages: a greeting or a profile page can show the username to the agent. The
  design keeps the password from the agent, not the username that the site shows.

### 4.2 What a CDP client can read after a fill (the probe)

Two CDP sessions on one tab of Chromium 156: one types (as the act does), and one plays the agent. Section 12 has
the run.

| What the agent does | What it got |
| --- | --- |
| `Runtime.evaluate` of the field's `value` | the password |
| `DOMSnapshot.captureSnapshot` | the password, in its strings |
| `DOM.getOuterHTML` of the field, on a page with no script | no password |
| the same, on a page whose script copies the value into the `value` attribute (some frameworks do) | the password, also in `DOM.attributeModified` events |
| `Accessibility.getFullAXTree` | no password |
| the submit's `Network.requestWillBeSent` | the password, in the event itself |
| its own `Fetch.enable` on the submit | the body, and `Fetch.continueRequest` sent it to another host, which got the password |
| `history.back()` after the sign-in | the sign-in page from the back-forward cache, with the password in its field |
| a failed sign-in on a page that echoes the values, or a sign-in by `fetch` in one document | the password stays in the field |
| a main-world listener, an isolated-world init script, or a window reference to the tab, made before the fill | the password, in each of the three |

Each of these needs only the agent's normal tools. So a fill in a tab that an agent can reach gives the password
to that agent. This is why the act uses a tab, a window and a browser context of its own.

### 4.3 The table

"Stopped" means the design's rule stops the threat for an honest agent, a mistake and an injected instruction.
"Q1 a" names the store's recommended option. "Round 1" names the probe of the fix round (section 12).

| # | Threat | What stops it | Result |
| --- | --- | --- | --- |
| T1 | The agent reads the field after a fill (`Runtime.evaluate`, `DOMSnapshot`, the DOM, its events) | The act fills only the act tab. No client sees, attaches or gets an event of the act tab (section 7.3). The agent's own tabs never hold the password | stopped (the hiding of the act tab from clients is designed; the build's tests prove it) |
| T2 | The agent watches the network or intercepts the submit, reads the body, or sends it to another host | No client session exists on the act tab, so no client's `Network` or `Fetch` acts on it. Only the service has a session there | stopped |
| T3 | The agent puts a script in first (a main-world listener, an isolated-world init script, a window reference: C7), or uses its own tab of the same origin: the origin's storage, Cache Storage, a service worker, `BroadcastChannel` (review-104 B1; round 1, case K1: in one context the agent's service worker served the agent's page at the sign-in path, and the agent's tab got the typed value by `BroadcastChannel` and by the `storage` event) | The act runs in a new incognito window: a browser context of its own, new for each act, that no client can make or reach (C11 refuses every other context). Round 1: in the act's context, the agent's page was not served, the agent's storage and caches were not visible, no worker controlled the page, and no broadcast or `storage` event reached the agent's tab. The act tab has no opener and no window name | stopped. If the incognito window cannot be had (section 7.3, the fallback): the service worker is bypassed, and the same-origin channels stay a stated limit |
| T4 | The agent changes the form's action to another host | The agent cannot reach the act tab. The form rules (section 7.4) refuse a form that sends to another origin, and the block stops a request to another host | stopped |
| T5 | The site's own page sends the password away (a third-party script, or a script of the site that a change of its storage steers) | The block: from the first key, the receiver blocks every request except a top-level GET, of the act tab, of its popups, of its dedicated workers and of the site's service workers, to a host outside `send_to`, every resource type (WebSocket, beacon, image, fetch included). Before the first key, an open WebSocket to another host stops the act. The guard fails a request whose URL holds the password in five forms. Round 1: a page script sent each typed value through six channels; with the block, no request of any channel reached the other host, and the sign-in worked. With the earlier guard alone, the other host got the whole password by an image URL in base64url, by the site's service worker and by a WebSocket, and parts of it (4 to 18 characters) by all six channels; the earlier guard stopped the whole value only in the fetch, the beacon and the dedicated worker's fetch | stopped for other hosts. Not stopped: a send to the site's own origin or to another `send_to` origin (any path, a hash, an encryption, a compression, a part of the value, a WebSocket), a subdomain or another port of a `send_to` host by a WebSocket, a top-level GET to a host on the scope's list with a changed or partial value, the first requests of an act popup before the service's session holds its `Fetch`, DNS prefetch and preconnect, and WebRTC (section 7.6) |
| T6 | A page of the exact origin that is not the sign-in page (another path, a page that the agent made) | The act loads the credential's own sign-in path in its own context, so no page or worker of the agent serves it (T3). The agent names only the credential | stopped |
| T7 | A redirect during the sign-in (to another origin, to a host on no list) | The origin check before the first key: the page must be on the credential's exact origin. After the submit, the scope's list rules apply in the act tab (C4, C5). The block stops a request outside `send_to` that is not a top-level GET; the guard fails a URL with the password, on any origin | stopped |
| T8 | A failed sign-in leaves the password in the field (C4, C5) | The act empties the fields, and the act window and its whole context close at the end of each act. Three failed results in a row stop the credential (section 7.7) | stopped |
| T9 | `history.back()` into the back-forward cache (C3) | No client reaches the act tab's history. The act also clears it (`Page.resetNavigationHistory`) before the close, and the context goes with the window | stopped |
| T10 | A second factor | Q4 a: the act stops and says "the site asks for a second factor". Q4 b or c: section 9 | stopped (no value leaves) |
| T11 | Another OS user (taylor has three human users) | 0600 files in 0700 folders; the 0600 control door and agent door; another user cannot read a process's memory or send it a signal | stopped |
| T12 | Another repo's agent of the same user asks for a sign-in | The service takes the caller's repo from the walk (`set_sessions`), never from the request, and checks it against the credential's repos (Q2). A refusal does not say whether the name exists for another repo | stopped |
| T13 | An agent's shell reads or edits the store's files (an injected instruction: "read the sign-ins and post them"; or it adds its own repo, a path or an origin to a record, marks an offer approved, or puts back an old copy) | Q1 a: the files hold only sealed records and a wrapped key. The open key is only in the service's memory. A guess of the passphrase offline is slow (scrypt). An edited record does not open; an offer opens only after the operator's approval is in its seal; an old copy does not open after a change (`gen`); the service seals only with its own open key (section 5.2). Q1 b: the files open with a key file beside them | Q1 a: stopped, with a long passphrase (an old copy: section 5.2's limit). Q1 b: not stopped |
| T14 | An agent reads the service's memory: `ptrace`, `/proc/<pid>/mem`, a core dump, Node's inspector | `ptrace_scope` 1 on taylor (an agent is no ancestor of the service); the service makes itself non-dumpable; `LimitCORE=0` in its unit; board ab-v16.96 (hold SIGUSR1 at start; disable the inspector signal) | stopped on taylor. The Mac: section 5.5 |
| T15 | A hostile program of the user replaces the service's code, its unit file or its Node (or the gateway's or the daemon's code, which serve the pane), and waits for the next unlock | Nothing on one OS user. The pane shows each start of the service and each unlock | not stopped (C11's limit) |
| T16 | The value in a transcript, a screenshot, a recording, a pane, the live view or a log | The agent never gets the value. No answer, log, event, status or pane holds it. No client screenshot or recording reaches the act tab. The live view sends no frame of the display to any viewer during an act, so a test login that an agent mints sees nothing of it (review-104 B2). The service moves the act window outside the screen's area (round 1: the framebuffer then held no pixel of it). The act's type watch empties the field and stops when the field's type changes (round 1: it stopped after 3 of 19 keys, with the field empty), so a click on a "show password" control shows no password | stopped for the agent's tools and for every viewer of the live view. Not stopped: a program of the user with the display's X authority. It can read the display, read the window's title, move the window back onto the screen (round 1: an X client did that), send input, and read the username in plain text; a site's own reveal control that shows the value in another element passes the type watch (the same-uid limit) |
| T17 | Chrome's own stores keep a value on disk (the password manager, autofill, the HTTP cache, the history, the session restore) | The act's context is off the record: round 1 found no row of the act's pages or titles in the profile's `History` file (one row of the agent's own page was there), and no profile file held the username or the password. The service also turns off password saving, the leak check and autofill in the profile's preferences before each Chrome start | stopped for the probes' cases |
| T18 | The operator's backup, and a move to a new box | Q1 a: a backup holds only sealed records and the wrapped key; the move copies them, and the operator unlocks on the new box. Q1 b: a backup holds the key file too | Q1 a: stopped. Q1 b: not stopped |
| T19 | An agent in a loop signs in again and again: the site locks the operator's account, or sends many codes to the operator | One act at a time; three results in a row of "not accepted", "timeout" or "a second factor" stop the credential until the operator acts in the pane; at most 6 acts of one credential in an hour (section 7.7) | stopped |
| T20 | A web page asks for a sign-in | The method exists only on the agent door and the MCP port, with their `Origin` 403s and the walk | stopped |
| T21 | A session of another box, or a copy of a token used from another computer (the token design's answer D c: direct HTTPS with a token, no walk) | The act refuses every request that the MCP admits by a remote token, and that request's `tools/list` has no sign-in tool (section 7.2, check 1) | stopped. A remote session never uses a stored credential in the first build (section 5.7) |
| T22 | The session after the sign-in | The move puts the cookies into the one default context, so every scope whose list covers the host gets the signed-in pages (C11, "What one profile shares between scopes"). Q2 decides who may start a sign-in, not who rides its session | not a leak of the password; stated as a limit |
| T23 | The plain values in agentwatch's memory: an agent sends a signal to the daemon and gets a core file (review-104 B4) | The pane and the offer command seal each value to the service's pane key, so the gateway and the daemon get only sealed text; the daemon is non-dumpable and its unit has `LimitCORE=0` (section 5.2) | stopped. Not stopped: a changed gateway, daemon or edge that serves the pane other code or another key (T15) |
| T24 | A forged offer: an agent names another session or repo as the offer's source, or edits an offered record to make it usable (review-104 B5) | The daemon takes the source from its walk of the caller's pid from the kernel; the seal holds `by` and `approved`, and the service seals an offer with `approved: false`, `repos: []` and `send_to: [origin]` | stopped |

The result in short: the design keeps the password from every agent that uses its normal tools (the browser, the
MCP, the CLI, its own tabs of the site, and its shell with Q1 a), on taylor, and from every viewer of the live
view. It does not stop a hostile program of the same OS user that replaces the service and waits, or that uses the
display's X authority; a site that sends the password to its own origins in a form that the guard cannot see, or
by WebRTC; or the username that the site's own pages show. It does not claim more.

## 5. Where the credentials live

### 5.1 The options

| | a. Sealed records, and the key only in the service's memory (recommended, Q1 a) | b. Records that a key file on disk opens (Q1 b) | c. Chrome's own password manager in the agent profile (Q1 c) |
| --- | --- | --- | --- |
| On disk | sealed records and the wrapped store key, in agentwatch's token store | the records, and the key file beside them (or plain 0600 files, as the tokens are) | Chrome's `Login Data` in the profile |
| What an agent's shell gets with one read | sealed records only | the passwords (a read of two files, or of one) | the passwords: the "basic" store has no encryption |
| What opens a record | the service, while the store is open | any program of the user | Chrome, at a page of the origin |
| After a restart of the service | locked until the operator's unlock | open | open |
| A backup | holds nothing that opens without the passphrase | holds the passwords | holds the passwords |
| Who adds | the operator in the Browser pane (section 6) | the same | the operator in Chrome's own settings page, in the agent browser's live view |
| Fits the token design's answer A (agentwatch keeps the browser's secrets) | yes | yes | no: the store is in the profile, outside agentwatch |

The fact behind row 2 is the token design's same-uid fact: a 0600 file of the user is open to every program of
the user. A key file beside the records does not change that; it only stops a copy of the records alone.

### 5.2 The recommendation (Q1 a)

**The split** (it follows the token design's answer A: agentwatch's daemon keeps the browser's secrets):

| Part | agentwatch (the daemon, the gateway, the pane) | The service |
| --- | --- | --- |
| The files | writes the sealed records and the key file in `tokens/agent-browser/sign-ins/` (0700): an atomic write, mode 0600, the permissions sweep | never writes a secret file |
| The operator's acts | takes them in the Browser pane with the password login; builds the operator field; passes them on the control door | applies them only with `kind: operator` |
| The pane's seal | the pane (the operator's browser tab) seals each typed password, username and passphrase to the service's pane key before it sends anything; the gateway and the daemon pass only the sealed text | makes the pane key at each start, holds its private half in memory only, and opens the pane's seals |
| The record's seal | passes the pane's sealed text to the service in `sign_in_seal` (section 6.2) | opens it, seals the values to the store's public key, and answers the sealed record; keeps no copy |
| The store key | keeps the wrapped key in its file; never holds the open key | makes the key pair at the set-up; holds the open private half in memory while the store is open |
| The snapshot | sends the sealed records (`sign_ins`) at each connect and each change | keeps the last snapshot in memory, as `set_sessions` |
| The act | nothing | opens one record at the act, types its values, and drops them |

So neither side holds a password at rest, and agentwatch never holds a plain value. The daemon holds sealed text
and no open key. The service holds the open key and no file. A plain password, username or passphrase exists only
in the pane (the operator's own browser tab, while the operator types it), and in the service's memory during an
open, a seal and an act.

**The pane's seal (review-104 B4).** Python cannot clear a string, and every agent of the user can send a signal to
the daemon. So the design keeps every plain value out of the daemon's and the gateway's memory:

- At each start the service makes a pane key: an X25519 key pair (Node's `crypto`). The private half is only in
  the service's memory. The public half is no secret: the service gives it in `status` and in each `sign_ins`
  event, and the pane gets it from the gateway with the store's state.
- The pane seals with agentwatch's Secret box seal (`screen-seal.js`: HPKE base mode, DHKEM(X25519, HKDF-SHA256),
  ChaCha20-Poly1305, a fresh sender key for each seal, the JSON padded to a multiple of 256 bytes so the length of
  a value does not show). The HPKE info binds the purpose `browser-sign-in`, the op, the record's plain fields of
  the seal's additional data (below), a random request id and the time. The pane clears the typed field before it
  posts, as the Secret box page does.
- The service opens the seal, checks that the info matches the request's op and plain fields, refuses a time more
  than 120 s from its clock (before or after it) and a request id that it keeps, and only then uses the values. It keeps
  the request id of each seal that it takes until that seal can no longer open: until its time is more than 120 s in the
  past and at least 120 s after the service first saw the id (review-118 B2; C12 is the master).
- The same seal covers the passphrase at the set-up, at each unlock and at a change of the passphrase, and the
  values of an agent's offer (section 6.3: the CLI seals on the agent's side).
- So Cloudflare's edge also gets only sealed text when the operator uses the pane from another place (review-104
  note 7: TLS ends at the edge).
- What the seal does not stop, as agentwatch's own seal says: a changed gateway or daemon process, or an edge,
  that serves the pane other code or another public key. That is an active change by a hostile program of the
  user (T15) or by the edge, not a passive read of memory, a log or a core file.

**The daemon's memory, as a second guard (review-104 B4).** The daemon calls `prctl(PR_SET_DUMPABLE, 0)` at its
start (Python's `ctypes`), and agentwatch's unit has `LimitCORE=0`; a test proves both. One interaction: C12's door
check reads the daemon's `/proc/<pid>/exe` (the daemon's command, rule 3), and a non-dumpable process closes that
link to other processes of the user. So the daemon is dumpable only from its connect to the control door until
the service admits it, and non-dumpable at all other times. With the pane's seal, no plain value of a sign-in is in
the daemon's memory in that time. On a box where any process of the user may attach another (`ptrace_scope` 0), an
attach in that window stays after the daemon is non-dumpable again, so the daemon checks that `TracerPid` in
`/proc/self/status` is 0 after it sets non-dumpable again, and it stops when the check fails (review-104b).

**The unlock.**

- The set-up: the operator chooses a passphrase in the Browser pane before the first credential (at least 16
  characters; the pane says why: a program of the user can guess offline against the wrapped key). The service
  makes the store key: an X25519 key pair (Node's `crypto`, no new package). It wraps the private half with
  AES-256-GCM under a key from scrypt (first values: N = 2^17, r = 8, p = 1, a 16-byte salt). It answers the
  public half and the wrapped private half, and the daemon writes them into `key.json`.
- The scrypt bounds (review-104 note 3). N = 2^17 and r = 8 need 128 MiB, and Node's `crypto.scrypt` allows 32
  MiB by default, so the service passes `maxmem` = 257 MiB: scrypt needs 128 times r times (N + 2) bytes and more, so N =
  2^18 does not derive under 256 MiB (measured; board ab-v16.97.2). The service takes the KDF values from `key.json` only
  within fixed bounds: `name` `scrypt`, N a power of two from 2^15 to 2^18, r = 8, p = 1, a salt of 16 bytes.
  Any other value gets "the store's key file is not valid", and no derivation runs. So a planted N = 2^30 cannot
  make the service take gigabytes of memory (taylor has no guard against that).
- The unlock: after each start of the service, the pane shows "The stored sign-ins are locked". The operator types
  the passphrase. The pane seals it to the service's pane key, and the daemon passes the sealed text in
  `sign_ins_unlock`. The service opens it, unwraps the private half and holds it in memory. A wrong passphrase gets
  "the passphrase does not open the store", and the service waits 2 s before it takes the next unlock.
- The service sends a `sign_ins` event at each change of the state (`locked`, `open`). The daemon sends one Web
  Push to the operator when an agent asks for a sign-in while the store is locked (at most one in an hour).
- The operator's "Lock" in the pane locks the store at once. The uninstall removes the folder.
- A new passphrase: "Change the passphrase" takes the old one and the new one; the service wraps the same
  private half again. A lost passphrase: "Remove all stored sign-ins" (the daemon removes the folder), then a new
  set-up.

When the store is open, Chrome's stop and start by use (Q5) do not lock it. A restart of the daemon does not lock
it: the service keeps its key and its last snapshot. A restart of the service locks it. The service restarts at a
pin change of agent-browser, at a reboot and at a crash. During the build months, pin changes come often (several
a week), and each one locks the store until the operator's next unlock.

**The seal.** For each record: an ephemeral X25519 key pair, two shared secrets (the ephemeral key's with the store's
public key, and the store's private key's with the store's public key, as HPKE's auth mode does, so only the open store
key makes a seal that opens: review-118 B1), HKDF-SHA256 to a 32-byte key, and AES-256-GCM over the JSON
`{"username":...,"password":...,"totp":null}`. The additional data is every field that decides where the password goes,
who may use it and whether the operator approved it: `v`, `id`, `gen`, `name`, `origin`, `path`, `send_to`, `repos`,
`by` and `approved`. The service checks the tag at each open. So a program of the user that edits a record's file (adds
its own repo, changes the sign-in path to a page that it controls, adds an origin to `send_to`, marks an offer as
approved) or moves the sealed part to another record breaks the record: the service refuses it ("the stored sign-in
cannot be opened"). The plain `state` field is not in it, and no decision of the act reads it (section 5.3).

- **`by` and `approved` (review-104 B5).** `by` is `operator` for a credential that the operator added and
  `offer` for an agent's offer (Q3 b). `approved` is `true` only in a seal that an operator act made: an add, a
  change, or the approval of an offer (`sign_in_seal` or `sign_in_reseal` with `kind: operator`). The service seals
  an offer with `by: "offer"`, `approved: false`, `repos: []` and `send_to: [origin]`, whatever the request holds.
  The act opens only a record whose additional data has `approved: true` (section 7.2).
- **`gen`, against an old copy (review-104 note 4).** `gen` is a whole number that each seal of a record raises by
  one. The service keeps the highest `gen` of each `id`, and the ids of removed credentials, in a small file of its
  own state folder (no secret: ids and numbers only). It refuses a record whose `gen` is lower than the highest
  that it saw, and a removed id: "the stored sign-in cannot be opened". So an old copy of a record file, with older
  repos or an older `send_to`, does not open after a change. The limit: a program of the user that also edits the
  service's state file can put back an old copy. It then gets an older version that the operator sealed, never a
  value or a field that the operator did not seal.

**The service seals only while the store is open**, with the public half that it derives from the open private
half. It never takes a public half from a file. So a program of the user that replaces the public half in
`key.json` with its own does not get the next credential sealed to its key.

### 5.3 The record and the key file

`tokens/agent-browser/sign-ins/<id>.json`, mode 0600, one for each credential:

```json
{"v":1,"id":"c-3f9a2b7c","gen":1,"name":"staging","origin":"https://staging.example.com","path":"/login",
 "send_to":["https://staging.example.com"],"repos":["example-org.site-a"],"by":"operator","approved":true,
 "state":"usable","added":{"at":"2026-11-10T14:00:00Z","by":"<user>","via":"web"},"changed":null,
 "sealed":{"epk":"<base64url>","iv":"<base64url>","ct":"<base64url>","tag":"<base64url>"}}
```

- `gen`, `by` and `approved` are in the seal's additional data (section 5.2).
- `id` is a random id that the daemon makes (`c-` and 8 hex digits). `name` is the operator's short name, unique
  in the store, and it matches C11's scope pattern. The agent asks by `name`.
- `origin` is `https:` and a host, with a port only when it is not 443. `http:` is allowed only for a loopback
  host (`localhost`, `*.localhost`, `127.0.0.1`), for tests.
- `path` is a path on the origin, with no query and no fragment.
- `send_to` lists the origins that may receive the password (section 7.6). It always holds `origin`.
- `repos` is the list of repo keys (Q2 a). With Q2 b the field is absent from the record, and the seal's
  additional data holds `repos: null`.
- `state` is `usable`, `offered` (Q3 b) or `stopped` (section 7.7). It is only for the pane: it is outside the
  seal's additional data, so a program of the user can change it on disk. The act never reads it to allow a use.
  The service keeps the stopped state and the count of each credential's results in its own memory and its state
  file (section 7.7), and it opens only a record whose seal holds `approved: true`. So a program that marks an
  `offered` record `usable` gets nothing, with Q2 a and with Q2 b: the seal still says `approved: false`.

`tokens/agent-browser/sign-ins/key.json`, mode 0600:
`{"v":1,"public":"<base64url>","kdf":{"name":"scrypt","n":131072,"r":8,"p":1,"salt":"<base64url>"},"wrapped":{"iv":...,"ct":...,"tag":...}}`.

The uses (the audit of section 8) are in the daemon's own state, outside the token store: they hold no secret.

### 5.4 Chrome's own password manager (Q1 c), and why it is not the store

- **On Linux, the "basic" store has no encryption.** Chromium's documentation: "Passwords stored in plain text are
  not encrypted." Chromium's source gives the "v10" key as a fixed value: "PBKDF2-HMAC-SHA1(1 iteration, key =
  "peanuts", salt = "saltysalt")". The agent browser on taylor runs under Xvfb with no keyring, and Chromium
  "will fall back to `basic` if a requested or autodetected store is not available" (the documentation).
- **`gnome-libsecret` and `kwallet`** need a keyring program in the user's session on the box, unlocked with a
  password. Any program of the user can then ask that keyring over the session bus. (Reasoned from the Secret
  Service model; not measured here.)
- **Chrome fills a saved password into pages of its origin.** An agent drives those pages, and a click through
  CDP counts as a person's click. So the agent reads the filled value, as in section 4.2. (Not measured: the probe
  never saved a password in Chrome.)
- **There is no extension API to add a password**, so the Browser pane cannot manage Chrome's store. The operator
  would add each credential in Chrome's own settings page, in the live view of the agent browser.
- **On the Mac**, Chrome keeps its key in the login Keychain ("Chrome Safe Storage"), so a shell read of the file
  gives no password. The fill rule above stays.

What the agent profile needs in any case: Chromium's defaults write the username of a sign-in into the profile
(probe, profile 2: in `Login Data`, outside its `logins` table, and in `Web Data`'s `autofill` table). So the
service writes these preferences into the profile's `Preferences` before each Chrome start (Chrome rewrites the
file while it runs): `credentials_enable_service: false`, `profile.password_manager_enabled: false`,
`profile.password_manager_leak_detection: false`, `autofill.enabled: false`, `autofill.profile_enabled: false`,
`autofill.credit_card_enabled: false`. Probe, profile 3: with them, no profile file held the username or the
password. That probe read back only 2 of the 6 preferences, and Chromium kept both (review-104 note 12). The
round-1 probe read back all 6 after its run: Chromium kept 5, and it removed `autofill.enabled` from the file. So
the build writes the 5 that Chromium keeps and checks them after each start; `autofill.enabled` stays out. The leak
check is off also because it sends a hash of the username and the password to Google at a sign-in. The act itself
runs off the record (section 7.3), so these preferences guard the default context, where an agent's own pages
run.

### 5.5 What protects the service's memory

The open key lives only in the service's memory. These rules keep other programs of the user out of it:

- **`ptrace` and `/proc/<pid>/mem`.** taylor has `kernel.yama.ptrace_scope` 1: a process can trace only its own
  descendants. The service runs under its own systemd user unit, so no agent is its ancestor. The service also
  calls `prctl(PR_SET_DUMPABLE, 0)` at its start (`node:ffi`, as the peer check uses). Then a process of the user
  without `CAP_SYS_PTRACE` cannot attach it or read its memory, also on a box with `ptrace_scope` 0. The
  service's checks of other processes read their `/proc` files, not its own, so this changes none of them. The
  service refuses to open the store when the call fails, and `status` says why.
- **Node's inspector signal.** Board ab-v16.96 (hold SIGUSR1 at start; disable the inspector signal) covers the
  service's start. The service opens the store only in a process where that protection holds, and a test proves
  it. No inspector flag and no `NODE_OPTIONS` reach the unit.
- **Core dumps.** `LimitCORE=0` in the service's unit, and the non-dumpable state, so no crash writes the memory to
  disk. Chrome and its children inherit the limit.
- **The plain values.** The act holds the username and the password in Buffers where it can, and fills them with
  zeros after the act. JavaScript strings cannot be cleared, so a copy can stay in the heap until the next
  garbage collection; the rules above keep the heap closed.
- **Chrome's memory during an act.** The password passes through Chrome's processes. Chrome runs detached under
  the service's unit, so no agent is its ancestor either (`ptrace_scope` 1).
- **agentwatch's memory.** The daemon and the gateway never hold a plain value (the pane's seal), and the daemon
  is non-dumpable with `LimitCORE=0` (section 5.2).
- **The Mac (stage 4).** macOS has no `ptrace_scope`. The design keeps the store and the act off on the Mac until
  stage 4 measures whether a program of the same user can read the service's memory (`task_for_pid` against the
  Node that the service runs), and the Mac's Keychain as a place for the store key.

### 5.6 Backups and a move to a new box

- With Q1 a, a backup of the token store holds sealed records and the wrapped key. Without the passphrase they do
  not open.
- The move to a new box: the operator copies the `sign-ins` folder with the token store, and unlocks it on the new
  box with the same passphrase. The records keep their ids and origins, so they open there. The new box's service
  has no generation file yet (section 5.2), so it takes the copied records as they are. Or the operator adds the
  credentials again.
- The uninstall of the agent browser removes `tokens/agent-browser/sign-ins/` (with the token design's rule: a
  normal uninstall, not only `--purge`). An update keeps it. No vault or config sync copies the token store.
- With Q1 b, a backup holds the key file and the records, so a backup is as secret as the passwords.

### 5.7 The token design's answers, and what they change here

The operator answered every question of the token design on 2026-11-10 (the lead's readings are on board task
ab-v16.94.10). This table uses the answers.

| The answer (board item) | What it changes here |
| --- | --- |
| A (ab-0wv): "agentwatch mints the token and inserts it into the mcp configuration"; agentwatch's daemon keeps the browser's secrets in its token store | nothing: section 5.2 is this split. The sealed records and `key.json` live in agentwatch's token store |
| B1 a (ab-0wv): the repo's list is the allow | nothing: a token gates the MCP port only. The act's own right is Q2's rule, checked by the walk |
| B2 (ab-0wv): "mint the token when the agentwatch session begins": a fresh token for each session, from its start to its end | nothing for the act: the walk names the session and its repo key, and the act takes both from the walk (section 7.2) |
| C (ab-sxg, ab-ufy): a fixed token header in each session's own MCP entry, a 0600 file for that session; no helper | nothing: the MCP tools of section 7.1 are two more tools on the same entry |
| D c (ab-sxg): direct HTTPS from a session of one box to the other box's address, with the token; the address list of ab-5t3 (the IPv4 and the IPv6 address of each calling daemon) | a request that the MCP admits by a remote token has no local walk. The act refuses every such request, and its `tools/list` holds neither `browser_sign_in` nor `browser_sign_ins` (section 7.2, check 1). So a session of another box never uses a stored credential in the first build |

**Why a remote request never reaches the act.** With D c, the serving box's gateway passes `/mcp/<scope>` with a
token to the service, and the service checks the token's hash. No walk runs: the caller is on another box. A copy
of that token works from every address on the address list until the operator removes it, and the address list
names boxes, not sessions. Q2's rule (section 8) needs the walk's session and repo key. So the act keys its
refusal to the admission itself, not to a scope name.

**What a later design needs for a remote use.** A credential that names a repo of another box (`<box>/<repo>`); a
proof at each act that the request comes from a live session of that repo on that box, more than a bearer token
(for example a request that the calling box's daemon signs with its link key, from its own walk); the serving
operator's allow for that box; and the audit line with the calling box. None of this is in the first build
(section 15).

## 6. Who adds, changes and removes a credential

### 6.1 The acts in the Browser pane

All acts are in the Browser pane of the web viewer, with a password login. The gateway builds the operator field
from the credential, after its password-login check, and drops any `operator` key from the request body. A link
login, the API token, the CLI, an agent and another box cannot do any of these acts (except the offer of Q3 b).

- **Set up the store**: the passphrase (section 5.2).
- **Unlock**, **Lock**, **Change the passphrase**, **Remove all stored sign-ins**.
- **Add** (the store must be open, because only the open key seals): the name, the origin, the sign-in path, the
  username, the password (typed twice; the pane never shows it again), the repos (Q2 a: the pane offers the repos
  whose lists cover the origin's host, none ticked), and "more origins that may receive the password" (empty by
  default).
- **Change**: any field. A change of the username or the password is a new seal (the operator types them). A
  change of the name, the origin, the sign-in path, the origins of `send_to` or the repos is a seal again with the
  new fields (`sign_in_reseal`), so it needs the store open; while it is locked, the pane says "Unlock the store
  to change this credential". A change of the origin needs the password again.
- **Remove**: the daemon removes the record's file, then sends the snapshot without it. The service adds the id
  to its list of removed ids (section 5.2, `gen`).
- **Start again** for a credential in the state `stopped` (section 7.7).
- **Approve an offer** or **Remove an offer** (Q3 b, section 6.3).
- The pane seals every typed value (the passphrase, the username and the password) to the service's pane key in
  the operator's browser tab before it sends anything (section 5.2). The gateway and the daemon get only the
  sealed text.
- The pane shows each credential's name, origin, repos, state, its dates, and its last 20 uses (section 8). It
  never shows a username or a password, so a screenshot of the pane holds neither.

### 6.2 The C12 ops and their provenance

"The pane's seal" below is the sealed text of section 5.2; the service opens it with its pane key and checks that
its info names the op and the request's plain fields.

| Op | Fields | Provenance | What the service does |
| --- | --- | --- | --- |
| `sign_ins_setup` | `sealed` (the pane's seal of the passphrase) | `kind: operator` | makes the store key, wraps it, opens the store; answers `{"key":{...}}` for `key.json`; refuses when the snapshot already has a key |
| `sign_ins_unlock` | `sealed` (the pane's seal of the passphrase) | `kind: operator` | unwraps the wrapped key of the last snapshot and opens the store; answers `{}` or `the passphrase does not open the store` |
| `sign_ins_lock` | none | `kind: operator`, or `kind: daemon` (the uninstall) | drops the open key |
| `sign_ins_rekey` | `sealed` (the pane's seal of the old and the new passphrase) | `kind: operator` | checks the old one against the wrapped key, wraps the open private half again with the new one; answers the new `key` |
| `sign_in_seal` | the record's plain fields of the seal's additional data (section 5.2), `sealed` (the pane's seal of the username and the password, or the CLI's seal of an offer) | `kind: operator`, or `kind: token` with `offer: true` (Q3 b) | seals with the public half of its open key; with `kind: operator`: `by: "operator"`, `approved: true`; with an offer: `by: "offer"`, `approved: false`, `repos: []`, `send_to: [origin]`, whatever the request holds; answers `{"sealed":{...}}`; keeps no copy; while the store is locked: `the store is locked`; with no store key: `the store is not set up` |
| `sign_in_reseal` | `id`, the record's new plain fields (the approval of an offer included) | `kind: operator` | opens the record of the last snapshot and seals its values again with the new fields, `gen` + 1 and `approved: true`; answers `{"sealed":{...}}`; while the store is locked: `the store is locked` |
| `sign_ins` | `key` (the public part and the wrapped part), `records` (each record of section 5.3) | `kind: daemon` | a complete snapshot, as `set_sessions`; replaces the service's map; answers `{"records":<count>}` |
| `sign_in_start_again` | `credential` (the credential's id; C12 names the field `credential`, because `id` is a line key) | `kind: operator` | clears the credential's stop and its count of results in a row (section 7.7: the operator's "Start again"); the times of its acts in the last hour stay; answers `{}`. The contract added this op (review-112 B4): this table had no op for "Start again" |

- The daemon applies an operator act only with the gateway's field (C12's rule for `kind: operator`), and logs the
  act with its user, the credential's id and name, and the op. It never logs a field that holds a secret or a
  seal.
- The service applies `sign_ins_setup`, `sign_ins_unlock`, `sign_ins_rekey`, `sign_in_reseal` and `sign_in_seal`
  (without `offer`) only with `kind: operator`; any other kind gets `not the operator`.
- The order at each connect: `config`, `set_sessions`, `mcp_tokens` (the token design), then `sign_ins`.
- The feature name `sign_ins` goes into the service's hello.
- No line of the control door holds a plain passphrase, username or password. Only the request lines of
  `sign_ins_setup`, `sign_ins_unlock`, `sign_ins_rekey` and `sign_in_seal` hold a seal of them (these four are "the
  four ops" below). Section 11's scan proves both.
- The daemon checks the service before its hello (C12), so only the real service gets the sealed text.

### 6.3 An agent's offer (Q3 b)

**Q3 b changes the manager's rule "the operator alone adds"** (review-104 B5). With b, an agent puts a record into
the store. Only its use waits for the operator's approval. A change and a removal stay the operator's alone.

- The agent runs `agentwatch browser sign-in-offer --name <name> --origin <origin> --path <path>`, and gives the
  username and the password on stdin (two lines). The command refuses a terminal on stdin, and it refuses any
  secret in its argv. It seals the two values to the service's pane key on the agent's side (as the pane does), so
  the daemon gets only sealed text.
- The command sends the offer over the daemon's 0600 Unix socket. The daemon takes the peer's pid from the kernel
  (`SO_PEERCRED`), walks it to its session (agentwatch's `session_of_pid`, as `screen_op.py` does for the screen
  ops), and takes the session's name and repo key from that walk. No name, repo or pid in the request plays a
  part. A peer that the walk does not name gets "Offers work only from a session that agentwatch started".
- The daemon sends `sign_in_seal` with `kind: token` and `offer: true`. The service seals it with `by: "offer"`,
  `approved: false`, `repos: []` and `send_to: [origin]` (section 6.2). The daemon writes the record in the state
  `offered` with its own new id, and records the walk's session and repo for the pane.
- The answer does not tell the agent whether a name exists (review-104 note 6). Every offer that the store keeps
  gets "Offered. The operator approves it in the Browser pane." An offer whose name a credential already has is
  kept like any other; the pane shows the clash, and the operator gives it another name at the approval or
  removes it. An offer never changes or replaces a credential.
- At most 5 offers of one repo wait at one time (a first value); the sixth gets "Five offers of this repo wait for
  the operator." While the store is locked, the offer gets "The store is locked: offer it again after the
  operator's unlock", and nothing is kept.
- The pane shows "An agent offered a stored sign-in: <name>, <origin>, from the session <session> of the repo
  <repo>", with the session and the repo from the daemon's walk. The operator approves it (a `sign_in_reseal`:
  the store must be open; the operator ticks the repos with Q2 a, and may add origins to `send_to`) or removes it.
- No act opens an offered record: its seal holds `approved: false`, also when a program of the user changes its
  `state` on disk (section 5.3). This holds with Q2 a and with Q2 b. The skill text tells the agent to remove its
  own file after the operator's approval.

An offer gives no agent a new right to the value: the agent already holds it. The approval stays the operator's
act.

## 7. How an agent uses one: the sign-in act

### 7.1 The entry: one method, three clients

- **CDP**: `AgentBrowser.signIn {"name":"<name>"}` and `AgentBrowser.signIns {}` on the root session or a browser
  session of the agent door. The model answers both; on a page session they are refused, as every call outside
  the model's set. Playwright sends them through a browser CDP session:
  `const s = await browser.newBrowserCDPSession(); await s.send("AgentBrowser.signIn", { name: "staging" })`.
- **The CLI**: `agent-browser sign-in <name>` and `agent-browser sign-ins` (and `agentwatch browser sign-in
  <name>`, the thin wrapper). They send the method over the agent door, so the walk gives the scope.
- **The MCP**: two tools of the service's own, `browser_sign_in {name}` and `browser_sign_ins {}`. The service's
  transport adds them to `tools/list` and runs them as the method for the MCP session's scope, only for a request
  that the MCP port admitted locally (the uid, the walk, then the session's token). A request that a remote token
  admitted (the token design's answer D c) gets a `tools/list` without them, and a call of either name gets the
  refusal of section 7.2, check 1.

`AgentBrowser.signIns` answers the names and origins that the caller's repo may use, and the store's state:
`{"state":"open"|"locked"|"none","signIns":[{"name","origin"}]}`. Names and origins are not secrets.

### 7.2 The checks before the act

In this order. The first check that fails gives its text (section 7.9).

1. The request came in by a local admission: the agent door (the kernel's peer check and the walk), or the MCP
   port with the uid check and the walk. A request that the MCP admitted by a remote token, with no walk, never
   reaches a later check (review-104 B6). The agent browser is ready (C11's readiness).
2. The store has a credential of that name whose seal holds `approved: true`, and the caller's repo (the walk's
   session, its `repo_key` in `set_sessions`) is in its `repos` (Q2 a), or its list covers the host (Q2 b). Else:
   "no stored sign-in of that name for this repo", the same text in each case (no such name, another repo's name,
   an offer that waits).
3. The scope's list covers the credential's host, and each host of `send_to`.
4. The store is open.
5. The record opens: its seal's tag holds with its fields as the additional data, and its `gen` is not lower than
   the highest that the service saw (section 5.2). Else: "the stored sign-in cannot be opened".
6. The credential is not stopped, and it had fewer than 6 acts in the last hour (section 7.7).
7. No other act runs. An act waits for the one before it, at most 60 s.

The act counts as a use for the automatic start and stop (board ab-v16.94.11): an act that finds Chrome down
starts it, as any request that needs the browser does, and Chrome does not stop while an act runs (review-104 note
9).

### 7.3 The act window and its context

- **A context of its own (review-104 B1).** The receiver opens the act window with C10's `windows.create` and
  `incognito: true`, with the caller's scope for the list rules (C4, C5), at `about:blank`, held as C10 says. An
  incognito window has an off-the-record browser context of its own: no cookie, storage, Cache Storage, service
  worker, `BroadcastChannel`, HTTP cache or history of the default context (round 1, section 12). Chrome drops the
  context when its last window closes (round 1: after each act's close, only the default cookie store was left,
  and the next act's store was empty). The act tab also bypasses service workers (`Network.setBypassServiceWorker`),
  as round 1 ran: two of round 1's isolation results (the agent's page was not served, and no worker controlled
  the page) come from that bypass (review-104b F2).
- **Why not `Target.createBrowserContext`.** Agent mode has no remote-debugging port and no pipe, so the service
  reaches Chrome only through the receiver's `chrome.debugger`. There, `Target.createBrowserContext` answers "Not
  allowed" (round 1). An incognito window is the context that an extension can make.
- **The receiver's allow.** An extension reaches an incognito window only when it is allowed in incognito: without
  the allow, `windows.create` with `incognito: true` gave the extension no window (round 1). The receiver's
  manifest keeps `"incognito": "spanning"` (one worker for both contexts, so the session rules apply there too).
  The service writes the allow into the profile's `Preferences` before each Chrome start
  (`extensions.settings.<receiver id>.incognito: true`): round 1 measured it with Chromium 156 and an unpacked
  extension. Chrome stable with the receiver's CRX is not measured: the build's live check proves it there first.
- **One act context at a time.** All incognito windows of a profile share one context. No client can make one: C11
  refuses `Target.createBrowserContext` and every other context. Before an act, the receiver closes an act window
  that a crash left (its own mark), and it refuses the act while any other incognito window is open (one that the
  operator opened in the live view): "Another private window is open in the agent browser."
- **Hidden from clients.** The model marks the act tab. No client sees it: `Target.getTargets` leaves it out, no
  `Target.targetCreated` or `Target.attachedToTarget` goes to any client, and each call with its id gets "No
  target with given id found". The act window is outside every scope's window lookups: `Browser.getWindowForTarget`
  gives no window for it, and `Browser.getWindowBounds` and `Browser.setWindowBounds` with its id get "Browser
  window not found" (review-104 note 10). A popup of the act tab is an act tab too, and the act closes it at its
  end. C10's eager attach, its sweep and the receiver's maps leave every incognito tab out, except the act tab for
  the list rules.
- **The service's session.** The service attaches its own session to the act tab, inside its process (as the MCP's
  ticket connection is inside it). No socket carries that session.
- **The tab is new**: a new document in a new context, no opener, no window name. No client has a script, a
  binding or an init script in it.
- **Outside the screen (review-104 B2).** The receiver cannot place a window outside the screen: `windows.update`
  with bounds outside it, or more than half outside it, answers "Bounds must be at least 50% within visible screen
  space", `chrome.debugger` has no `Browser.setWindowBounds`, and a minimized state changes nothing on an Xvfb
  with no window manager (all round 1). The service runs Xvfb and holds its X authority, so it moves the act window
  at the X level to the right of the screen's area (as `xdotool windowmove` did in round 1). Round 1: the
  framebuffer then held no pixel of the window, Chrome reported the new bounds, and the sign-in worked there. The
  act types no key until `windows.get` reports the window outside the screen; else it ends with "The agent browser
  could not move the sign-in window off the screen."
- **The live view (review-104 B2).** From the act's start to its end, agentwatch's live view sends no frame of the
  display to any viewer (a fixed frame "A stored sign-in runs" in its place) and plays no input from it. The
  service sends the act's start and end as a `sign_in` event with `phase` (section 8). So a test login, which any
  agent can mint and which may view the display (agentwatch's first browser design, 5.6), sees nothing of the act.
- **The fallback.** If the incognito window cannot be had (for example Chrome stable refuses the allow), the act
  runs in a window of the default context, as the earlier design did, with two more rules from the review: the
  act tab bypasses service workers (`Network.setBypassServiceWorker`; round 1: the agent's page was then not
  served), and the model freezes every client tab of the credential's site during the act
  (`Page.setWebLifecycleState frozen`; not measured). The residual limit, stated plainly: an agent's tab of the
  same origin still shares storage, Cache Storage and `BroadcastChannel` with the act tab, and a frozen page gets
  its messages when it runs again. The fallback is a build decision only for the case where the incognito window
  fails, and the pane says so.

### 7.4 The form rules

The service reads the page only in an isolated world of its own (`Page.createIsolatedWorld`), so the page's
scripts cannot change the service's reads.

1. The service navigates the act tab to `origin` + `path`. After the load, the main frame's origin must be the
   credential's exact origin. Else: "the sign-in page is on another origin".
2. The main frame has exactly one visible, enabled password field. Two or more (a sign-up page, a change of
   password): "the page has more than one password field". None, and exactly one visible username field: a
   two-step sign-in (step 5).
3. The username field: in the password field's form, the visible text, email or tel field before it, with
   `autocomplete="username"` or `type="email"` first. A credential with an empty username skips it.
4. When the password field is in a `<form>`: its method must be `post`, and its action's origin must be in
   `send_to`. Else: "the sign-in form sends to another place than the stored sign-in names". This check comes
   before the first key, so a form that would put the password into a URL never gets it. A password field with no
   `<form>` (a sign-in by script) goes on; the block and the guard are then its checks.
5. A two-step sign-in: the act fills the username, submits, waits for the next page, and applies rules 1 to 4
   again. At most one such step.
6. **No open connection to another host.** The act tab's `Network` domain is on from the navigation. At the first
   key, a WebSocket or a WebTransport session of the page to a host outside `send_to` that is still open
   (`Network.webSocketCreated` with no `webSocketClosed`; round 1: the act saw the WebSocket that a page opened at
   its load) stops the act: "The sign-in page keeps a connection to another site open." A rule of the block stops
   only new requests, so this check covers the ones that the page opened before it.
7. **The type watch (review-104 B2).** Before the first key, the service puts a `MutationObserver` on the password
   field's `type` attribute in its isolated world. When the type changes (a click on a "show password" control),
   the observer empties the field in its own callback, before the page paints again, and the act ends with "The page
   showed the password field as text, so the agent browser ended the sign-in." (C11's text: it names no stop, I2) Round 1: the observer saw the change
   after 3 of 19 keys, the field was empty, and the act stopped.

The first build reads only the main frame. A sign-in form in a frame gets "no sign-in form that the agent browser
can fill". Field hints (CSS selectors for an odd page) are a later option, when a site needs them.

### 7.5 The fill and the submit

- The service takes the input lock of the browser (the input design, section 4.4) for its clicks and keys. An
  agent's own input calls wait for it, as for any other client.
- It clicks each field, then types its value with the person's input of the input design: the generator's keys
  when every character has a key on the US layout and the plan fits in 10 s, else `Input.insertText` (the input
  design, section 7.2). Through CDP, so no key passes through X.
- It submits as a person does: a click on the form's visible submit button, else Enter in the password field.
- The values go to Chrome only in the act tab's `Input` calls, over the native link (C10's `debugger.sendCommand`).
  The receiver logs no command parameters (it logs only fixed texts, read at chrome-extension `3d84667`).

### 7.6 The block and the guard

**The block (review-104 B3).** From the first key to the end of the act, the receiver holds these session rules
(`updateSessionRules`). Their priority 4 is above the scope rules (2) and the navigation-header rule 5 (3) of C5.
They are all `block` rules, except the one `allow` rule below, which never matches a main frame, so rule 5 still
sets the act's own navigations as typed ones.

| Rule | Matches | Why |
| --- | --- | --- |
| A | the act tab (`tabIds`), every resource type except `main_frame`, a host outside the hosts of `send_to` (`excludedRequestDomains`) | every subresource, beacon, WebSocket, WebTransport and the requests of the tab's dedicated workers |
| B | the act tab, `main_frame`, every method except GET, a host outside the hosts of `send_to` | a form or a script that posts to another site after the form check |
| C | every tab (no `tabIds`), the credential's host as the initiator, a host outside the hosts of `send_to` | the requests of the act's popups (an `about:blank` popup has the opener's origin) and of the site's service workers and shared workers, which no tab rule matches (review-104b F1) |
| D | the act tab, every resource type except `main_frame`, the hosts of `send_to` and their subdomains | DNR matches hosts, not origins: this blocks a subdomain, another scheme or another port of a `send_to` host |
| E (`allow`, priority 5) | the act tab, every resource type except `main_frame`, a URL of exactly a `send_to` origin (and `wss:` to the same host and port) | the site's own requests to its exact origins |

The receiver adds the rules after the form rules pass and before the first key; the act types no key until the
receiver confirms them, and a failed update ends the act ("The agent browser could not hold the sign-in's
rules."). It removes them at the act's end, also after a failure. A top-level GET to another host stays open: a
sign-in often ends with a redirect to another host of the site, and the scope's list (C4, C5) and the guard still
judge it. Rule C matches by the initiator's host in every context, so for the act's few seconds a worker of the
site in the default context (an agent's) reaches no other host either.

**Why rules of the receiver, not `Fetch` on each worker.** A rule acts in Chrome's network code on every resource
type, before the request leaves, and it needs no CDP session. `Fetch` does not pause a WebSocket, and a tab's
`Fetch` never sees the request of a service worker (round 1: with the earlier guard, the WebSocket and the service
worker each sent the whole password to the other host, and `Fetch` paused neither). Rule C covers the service
worker with no attach of it. Round 1 measured rules A, B and C: with them, no request of any channel reached the
other host. Rules D and E are designed, not measured.

**The guard.** The service also keeps `Fetch` on in the act tab for every URL, at the request stage. For each paused
request:

- When its URL holds the password (plain, URL-encoded, JSON-escaped, base64 or base64url), on any origin: it fails
  (`Fetch.failRequest`, `BlockedByClient`). A URL with the password would go into the server's logs.
- When its origin is not in `send_to`, and its body holds the password in those forms, or Chrome does not give its
  body: it fails (this covers a request that rule D lets pass by its host but whose origin is not exact).
- Every other request continues unchanged.

A blocked or failed request is no reason to end the act: a third-party script's request fails, and the sign-in goes on
(round 1). No event, prompt, report or log line names the host of a blocked or failed request, because a host that the
page chooses can carry the password (contract C11 and C12, review-112 B1; board ab-v16.97.4 brings this section to the
contract): the act's `end` event and its log line give only the number of requests that the block stopped (`blocked`)
and the number that the guard failed (`guarded`). When the site's own sign-in request goes to another origin, the
sign-in fails, and the operator finds the origin to add to `send_to` from the site's own page, not from the act. A
paused request whose event is too large for the link fails: the guard cannot read it.

**What the block and the guard do not stop**, stated plainly: a send to the site's own origin or to another origin
of `send_to`, at any path (the site's own endpoints); a hash, an encryption or a compression of the password; a
part of the value (the person's input types a key at a time, about 5 characters a second, so a script can send
each prefix to a `send_to` origin); a WebSocket to a `send_to` origin; a WebSocket to a subdomain or another port
of a `send_to` host from a service worker (rule C is by host); a top-level navigation by GET of the act tab to a host
on the scope's list, with a changed or partial value (the guard finds only the whole value); the requests of an act
popup before the service's session holds its `Fetch` (its first navigation among them), so a popup that the page opens
after the act's last key, or in the moment before the service learns of it, can send a GET with the whole value (board
ab-v16.97.4, review-124 B2: the act ends at an act popup that opens before its last key); DNS prefetch and
preconnect (`<link rel=dns-prefetch>`), which make no request that a rule sees; and WebRTC (a STUN or TURN request,
or a data channel), which no rule and no `Fetch` sees (not measured).

### 7.7 The outcome

The act watches the act tab for at most 30 s (a first value) after the submit:

- **Signed in**: the main frame commits a new page, or its URL changes, and after 1 s with no navigation it has no
  visible password field. The final origin is on the scope's list; an origin off the list is blocked by C4 and
  C5, and the act ends "the site went to a host on no list after the sign-in".
- **Not accepted**: a visible password field is still there after the settle.
- **A second factor**: a visible field for a code and no password field: `autocomplete="one-time-code"`, or an
  input whose name or id holds `otp`, `totp`, `2fa`, `mfa` or `code` and whose `maxlength` is 4 to 10. Section 9.
- **Timeout**: none of these in 30 s.

**The lockout guard (review-104 note 5).** Three results in a row of "not accepted", "timeout" or "a second factor"
for one credential stop it, so a loop cannot lock the operator's account or send the operator many codes. A
"signed in" result sets the count to zero. Also, at most 6 acts of one credential start in one hour (a first
value), whatever their results: the seventh gets "This stored sign-in was used often in the last hour. Try again
later." The service keeps the count, the stopped state and the hour's acts in its own state file (no secret), so
a restart of the service does not clear them; the pane's `state` shows them. The operator's "Start again" in the
pane clears the stop.

### 7.8 The clean end and the move

In this order, also after a refusal in the middle of the act:

1. It empties every input of the main frame.
2. **Only after "signed in": the leak check and the move.** The service reads, in its isolated world and through
   the receiver, the act context's cookies of the credential's host and its subdomains (`cookies.getAll` with the
   act context's cookie store) and the origin's `localStorage`.
   - When a cookie value or a `localStorage` value holds the password (the five forms of section 7.6), the site
     keeps the password where its pages can read it. The act makes no move and ends with "The site keeps the
     password where its pages can read it, so the agent browser did not keep the sign-in." The service sends the
     operator an event. (Designed, not measured.)
   - Else the service builds a C2 payload: `domain` = the credential's host, `origin` = the credential's origin,
     `url` = the origin with the path `/`, the cookies whose domain is the host or a subdomain of it (C2 refuses
     other cookies), and `storage.local` = the `localStorage` items; `storage.session` and `storage.idb` stay empty
     in the first build (a site that keeps its sign-in in IndexedDB or in one tab's `sessionStorage` gets no
     signed-in pages: section 15). The service checks it as stage 1c checks an import (`checkPayload`: the C2
     rules, and the box's own sign-in rule that refuses a box host and drops the box's cookies) and gives it to the
     receiver's `import` (C4, C6), as stage 1c's import does. This is the import's code path inside the service, not the C12 op `import`: the op's rule (`kind:
     operator` only) stays, and the operator's consent for the move is the credential and its repos (Q2).
   - C6's import closes every tab of the default context whose origin is the credential's origin, and replaces the
     cookies of the host, so an agent's open tab of the site closes at the move, and an old session of the site
     ends. The act's answer says so.
   - Round 1 measured the move with a stand-in of C6 (the cookies set with `cookies.set` in the default store, the
     `localStorage` items written by a tab of the origin): before the act the agent's pages showed "not signed
     in"; after the move, "signed in", by the cookie and by the token that the site kept in `localStorage`.
3. It clears the tab's history (`Page.resetNavigationHistory`).
4. It turns `Fetch` off and sends the receiver's `act_end` (C4): the receiver closes each tab of the act (the act
window and its popups) first, then removes the block's rules, so no page of the act is left when the rules go
(chrome-extension's order, board ab-v16.97.3); the service closes no window itself. An act whose rules request failed
or came late sends `act_end` too. Chrome drops the
   act's context with its last window: its cookies, its storage, its HTTP cache and its history (round 1: no row of
   the act's pages in the profile's `History` file; no profile file held the username or the password).
5. It fills the Buffers of the values with zeros, and drops the opened record.

A failed move (a C2 refusal, an `import` that fails) ends the act with "The sign-in worked, but the agent browser
could not move it to your tabs." The act's context still closes.

### 7.9 What the agent sees

The answer of `AgentBrowser.signIn`, the CLI's output and the MCP tool's text:

- success: `{"signedIn":true,"name":"staging","origin":"https://staging.example.com"}`, and the text "Signed in to
  https://staging.example.com. Your tabs of this site were closed for the sign-in; open the site again: it loads
  signed in."
- a refusal: the CDP error `{"code":-32000,"message":"Not signed in: <text>"}` (the CLI's exit 1; the MCP tool's
  error), with one text of this list:

| Cause | The text |
| --- | --- |
| a remote admission | `Stored sign-ins work only for sessions of this box.` |
| not ready | C11's readiness text |
| no such name for this repo (also an offer that waits) | `There is no stored sign-in named <name> for this repo.` |
| the list | `Not allowed: <host> is not on the allowlist` (C11's text) |
| locked | `The stored sign-ins are locked. The operator unlocks them in the Browser pane.` |
| the record | `The stored sign-in cannot be opened. The operator adds it again.` |
| stopped | `The site did not accept this stored sign-in three times. The operator checks it in the Browser pane.` |
| the hour's limit | `This stored sign-in was used often in the last hour. Try again later.` |
| busy for 60 s | `Another sign-in runs now. Try again in a minute.` |
| another private window | `Another private window is open in the agent browser.` |
| another origin | `The sign-in page is on another origin than the stored sign-in names.` |
| the form | `The sign-in form sends to another place than the stored sign-in names.` / `The page has more than one password field.` / `There is no sign-in form that the agent browser can fill.` |
| an open connection | `The sign-in page keeps a connection to another site open.` |
| the rules | `The agent browser could not hold the sign-in's rules.` |
| the window | `The agent browser could not move the sign-in window off the screen.` |
| no act window (board ab-v16.97.4: a receiver with no feature `act`, no incognito window) | `The agent browser could not open the sign-in window.` |
| an act popup before the last key (board ab-v16.97.4, review-124 B2) | `The sign-in page opened another window, so the agent browser ended the sign-in.` |
| the type watch | `The page showed the password field as text, so the agent browser ended the sign-in.` |
| not accepted | `The site did not accept the stored sign-in.` |
| a second factor | `The site asks for a second factor. The agent browser cannot answer it: ask the operator.` |
| a host on no list | `The site went to a host on no list after the sign-in.` |
| timeout | `The site did not finish the sign-in in 30 s.` |
| a lost act tab (board ab-v16.97.4: its session ended, it closed, or a call of the act failed) | `The agent browser lost the sign-in window before the sign-in finished.` |
| a leak of the site | `The site keeps the password where its pages can read it, so the agent browser did not keep the sign-in.` |
| the move | `The sign-in worked, but the agent browser could not move it to your tabs.` |

No text holds a value of the page: a site's own error text can name the username, so the act never passes it on.
No text names a stop or a start (I2).

### 7.10 What the agent's CDP access may do during and after the act

- **During the act**: every call on the agent's own tabs works as before. Its input calls wait for the input lock
  while the act types and clicks (a few seconds; the input design's typing is about 5 characters a second). It
  cannot see, attach, screenshot, record or close the act tab, and it cannot find its window. A
  `Target.setAutoAttach` of the agent attaches nothing of the act. Its own tabs of the site, in the default
  context, share nothing with the act's context.
- **After the act**: the move closed the agent's tabs of the credential's origin; the agent opens them again, and
  they load signed-in pages. The act window, its context and its history are gone.
- A site that keeps its sign-in in one tab's `sessionStorage` or in IndexedDB gives the agent's tabs nothing in the
  first build. A later option can move IndexedDB too (C2 has `storage.idb`).

## 8. Which scopes may use a credential; the log and the audit

**The rule.** The operator chose Q2 b (board item ab-8w8): every repo whose list covers the credential's host and
each host of `send_to` may start a sign-in with it, and a credential names no repos. The text below keeps Q2 a's rule
as the record of the other option. With Q2 a, a scope may start a sign-in with a credential when both hold:

- the scope's repo (the walk's session, its `repo_key`) is in the credential's `repos`;
- the scope's list covers the credential's host and each host of `send_to`.

With Q2 b, the first condition goes: every repo whose list covers the host may use it.

- A session outside a GitHub repo has the repo key `no-repo` (agentwatch's rule), and the operator can name it.
- A session whose repo is not known (`unread-repo`) never uses a credential.
- Only a local session: a request that a remote token admits never reaches the act (section 7.2, check 1).
- **Stated plainly:** the profile is one (O9), so the session that a sign-in makes is open to every scope whose list
  covers the host: the move puts its cookies into the default context for every scope (C11). Q2 decides who may start
  a sign-in (who can cause a sign-in, which account the session gets, and who can trigger "not accepted" results), not
  who rides the session after it.

**The log rule.**

- No log line of either side holds a username, a password, a passphrase, a sealed record, a pane's seal, a form
  value, a page's text, a URL path or a query. The C12 log rule gains these words (section 10).
- The service logs one line for each request of `AgentBrowser.signIn` (C11): the user, the scope, the session's `repo`
(no repo key: the answer Q2 b needs none, and the token design's revision removed it), the act id, the credential's id
and name (none for a refusal by check 1 or 2), the origin, the result's code, the time it took, and the number of
requests that the block stopped and the number that the guard failed; never their hosts. The move logs stage 1c's
import line (counts only).
- The daemon logs one line for each operator act: the user, the op, the credential's id and name.

**The audit.**

- The service sends a `sign_in` event at each act's start (`phase: "start"`: `act`, an id of 16 hex digits for the
request, `scope`, `repo`, `id`, `name`, `origin`, `at`), so the daemon blanks the live view, and at its end
(`phase: "end"`: the same, and `result` (the code of section 7.9), `ms`, `blocked` and `guarded` (the numbers of the
requests that the block and the guard stopped, never their hosts) and `stopped_now`). A request that a check refuses
is no act: one `end` with its own `act` and no `start`, at most 10 of them for one scope in any 60 s, then one a
minute with `dropped`, the number that did not go (C12). The daemon also ends the blank 60 s after a start with no
end.
- The daemon keeps the last 200 events in its own state (no secret), and the pane shows the last 20 of each
  credential: which scope and repo used it, when, and with which result.
- `status` gives `sign_ins`:
`{"state":"none"|"locked"|"open","records":<count>,"acts":<count since the start>,"pane_key":"<the public half>","stopped":[<ids>],"unprotected":null|"dumpable"|"signal"}`
(C12): the ids of the stopped credentials and the reason of a protection of the service's memory that does not hold,
with no name and no origin of a credential.

## 9. A second factor

- **Q4 a (recommended): not in the first build.** The act sees the code field (section 7.7) and ends with "The site
  asks for a second factor". It fills nothing there. The operator can sign in by hand in the live view, or send
  the sign-in from the operator's own Chrome (stage 1c's import).
- **Q4 b: a stored TOTP seed.** The operator adds the seed (the text or the QR code's secret) to the credential.
  The record's sealed JSON holds it (`totp`). The act makes the 6-digit code (RFC 6238, SHA-1, 30 s, the first
  form) and types it into the code field with the person's input, then reads the outcome again. Effect: agents
  sign in with no person. Cost: the second factor is then in the same store as the password, so it no longer
  guards against a reader of the store.
- **Q4 c: the operator types the code.** The act waits at most 3 minutes. The daemon sends a Web Push. The
  operator types the code in the Browser pane; the pane seals it (section 5.2), it goes to the service as an
  operator act (`sign_in_code`), and the act types it. Effect: the second factor stays with the operator. Cost: a
  prompt for each such sign-in, and an agent waits.

A code that an agent reads is short-lived (30 s). The act still types it only in the act tab.

## 10. The contract changes and agentwatch's side

A later task (section 13, task 1) makes these changes, after the answers. The quoted sentences are today's.

**C11 (`docs/contracts/C11.md`).**

- The part table at the top gains a row: "The sign-in act (`AgentBrowser.signIn`, `AgentBrowser.signIns`), the act
  window and its context | agent-browser's service | stage 1e builds it, off by default; it serves sessions from
  stage 3".
- "Where each call goes": "The model answers the calls of its set (two-modes design, section 4.3) on the root
  session and on a browser session (`Target.attachToBrowserTarget`)." gains: "and `AgentBrowser.signIn` and
  `AgentBrowser.signIns` (the sign-in act, below)". The table gains their two rows (the model; refused on a page
  session).
- "There is one browser context. Every target has `"browserContextId":"agentwatch-default"`, also in the answers
  and events from Chrome that the model passes on." gains: "The sign-in act's window is in an incognito context of
  its own; no answer and no event of any client holds it or its tab."
- "The scope, and one connection per tab": "Every other tab is in no scope, and no connection sees it: the
  operator's tabs, the restore tab of an import, a tab that the receiver's map does not hold." gains: "An act tab
  of the sign-in act is in its caller's scope for the list rules, but no connection sees it, attaches it or gets
  an event of it; a popup of an act tab is an act tab."
- The refusals table's row "A window with no tab of the scope | `Browser.getWindowBounds`,
  `Browser.setWindowBounds` | `Browser window not found`" gains "or the sign-in act's window", and the row of
  `Browser.getWindowForTarget` with an act tab's id gives "No target with given id found" (review-104 note 10).
- "What one profile shares between scopes, stated plainly: ... the sent sign-ins (cookies, storage, workers) are in
  the profile for every scope" gains "and the sessions that the sign-in act moves into it".
- A new part, "The sign-in act (from stage 1e)": sections 7.2 to 7.9 as rules, with the texts of section 7.9.
- "The MCP inside the service": "Tools and argument keys pass only through the allow list" gains "and the service's
  own tools of the allow list's `service_tools`, only for a request that the MCP port admitted with the walk".
  "No log line of the MCP path holds a tool argument, page content, a cookie, a URL path or a payload" gains "a
  username, a password or a form value".
- The limits: after "As on the endpoint, the check does not stop a hostile process of the same OS user." add: "The
  stored sign-ins do not change this: such a process can replace the service and wait for the operator's next
  unlock, or use the display's X authority during an act."

**The MCP's allow list (`docs/contracts/mcp-allow-list.md`).**

- The file gains a field `service_tools`: the service's own tools, `browser_sign_in` (`name`) and
  `browser_sign_ins` (no argument), each with its schema.
- "`tools/list`: the service drops each tool that `tools` does not name." gains "and adds each tool of
  `service_tools` for a request with a local admission; a request that a remote token admitted gets no tool of
  `service_tools`".
- The test gains: no name of `service_tools` is a tool of the pinned version's `tools/list`.

**C12 (`docs/contracts/C12.md`).**

- The requests table gains the seven ops of section 6.2. The field rules gain their fields (`sealed` holds the
  pane's seal, section 5.2).
- Provenance: "The service applies an operator act (`list_set`, `prompt_allow`, `prompt_dismiss`, `import`) only
  with `kind: operator`" gains `sign_ins_setup`, `sign_ins_unlock`, `sign_ins_rekey`, `sign_in_reseal` and
  `sign_in_seal` (except an offer, Q3 b, which the service seals with `approved: false`). "the daemon's own
  requests (`config`, `set_sessions`, `session_ended`, `launch_check`) only with `kind: daemon`" gains `sign_ins`.
- `set_sessions`: this design reads each session's `repo_key`, the field that the token design adds (the daemon
  lead's change 4; C12 has only `repo` today). Task 3 waits for it (review-104 note 2).
- The event table gains `sign_in` (with `phase`, section 8) and `sign_ins` (the store's state and the pane key's
  public half).
- "No side logs page content, a cookie, a URL path or a payload in any log line." gains "a username, a password, a
  passphrase, a sealed record, a pane's seal or a form value".
- The data of `status` gains `sign_ins` (section 8).
- The feature names gain `sign_ins`.
- The vectors (`test/vectors/control.json`) gain each op with fake values, a refused kind for each, and a scan
  vector: no line holds a plain canary, and a line of each op except the four of section 6.2 holds no seal.
- The fake (`--fake`) has the ops.

**The service design (2026-11-09).** Section 5.1's table gains the row "Stored sign-ins | none | section 5 of the
sign-in design". Section 7.1's two tables gain the ops and events. Section 11's table gains the rows "Stored
sign-ins" (sealed records, the open key only in the service's memory, the pane key) and "The service's memory"
(board ab-v16.96 (hold SIGUSR1 at start; disable the inspector signal), non-dumpable, `LimitCORE=0`). Section
13.1's stage 1 gains stage 1e.

**C4, C5, C6 and C10 (chrome-extension `docs/protocol.md`)** (review-104 B1, B3; the earlier design said no
change):

- C10's `windows.create` gains `incognito: true` for an act window, with the caller's scope and a mark "act". The
  receiver's eager attach, its sweep, its closing rule and its maps leave every incognito tab out, except an act
  tab for its scope's list rules. Before an act window, the receiver closes a marked act window that is left, and
  it refuses while another incognito window is open.
- The receiver's manifest keeps `"incognito": "spanning"`; the service's start writes the allow into the profile
  (section 7.3).
- C5 gains the act's rules A to E of section 7.6 (session rules, ids that the receiver picks, priorities 4 and 5),
  their add before the first key with a confirmation, and their removal at the act's end and at the worker's
  start.
- C4 gains a request that reads the cookies of a host from an act window's cookie store (for the move), and
  `windows.get` of an act window (for the check that it is outside the screen).
- C6: no change of its steps; the move is one more caller of `import`.

**agentwatch's side (the daemon lead's tasks).**

- The store: the folder `tokens/agent-browser/sign-ins/`, the atomic writes, the permissions sweep, the uninstall,
  no sync, the snapshot at each connect and each change.
- The gateway's routes for the acts of section 6.1 (password login only; the operator field built from the
  credential). They pass only sealed text.
- The pane's seal: the Browser pane seals each typed value with `screen-seal.js` to the service's pane key, and
  clears the field before it posts (section 5.2).
- The daemon's memory: `prctl(PR_SET_DUMPABLE, 0)` at its start (dumpable only during the control door's check of
  it), `LimitCORE=0` in its unit, with a test (section 5.2).
- The offer (Q3 b): the command's seal on the agent's side, the daemon's 0600 Unix socket, the walk of the
  kernel's peer pid, the limit of 5 offers, the answer that names no existing name (section 6.3).
- The Browser pane: the store's state, the set-up, the unlock, the lock, the credentials, the uses, the blocked
  hosts, the offers and their source from the walk, the "stopped" state.
- The live view: no frame and no input from a `sign_in` start to its end (or 60 s), for every viewer (section
  7.3).
- The Web Push "an agent waits for a locked sign-in" (at most one in an hour).
- The service's unit: `LimitCORE=0`, no `NODE_OPTIONS` (with age-q8t.2, the unit task); the service's start holds
  board ab-v16.96 (hold SIGUSR1 at start; disable the inspector signal).
- The skill text: how an agent signs in (by name; never ask for a password; never read a file of the store), and
  what each refusal means.

## 11. Tests

**Unit tests, agent-browser (stage 1e, `npm test`, no browser):**

- The seal: a round trip; a wrong passphrase; a record whose file a test changes (its repos, its path, its
  `send_to`, its origin, its id, its `gen`, its `by`, its `approved`) does not open; a changed byte of `ct` or
  `tag` does not open; a public half in `key.json` that a test replaces changes no seal; no seal while locked; a
  store with no key.
- The KDF: the first values; `maxmem`; each value outside the bounds of section 5.2 refused before any derivation.
- The generation: a lower `gen` than the highest seen does not open; a removed id does not open; the high-water
  file holds no secret.
- The pane's seal: a round trip with a seal made by agentwatch's `screen-seal.js` (a shared vector of fake
  values); an info that does not match the op or the plain fields is refused; a time more than 120 s from the clock
  (before or after it), and a request id seen twice while its seal can still open, are refused; a new start of the
  service gives a new pane key.
- The lock: locked at the start; the unlock; the lock; the rekey; a refused unlock waits 2 s; no open key after a
  lock (a test hook reads the state).
- The ops: each op of section 6.2 with each kind; `not the operator` for each other kind; an offer sealed with
  `by: "offer"`, `approved: false`, `repos: []` and `send_to: [origin]` whatever the request holds; the snapshot
  replaces the map; a bad record breaks no other record.
- The checks before the act (section 7.2), each with its text; the same text for "no such name", "not for this
  repo" and "an offer that waits"; a request with a remote admission refused, and its `tools/list` without the two
  tools.
- The act with the model's fake bridge: the act window is incognito; the act tab is in no answer of
  `Target.getTargets`, gets no event to a client, and refuses each client call with its id; its window is in no
  window lookup; a popup of it is hidden too; a left act window is closed and another incognito window refuses the
  act; no key before the receiver confirms the block's rules and the window's place outside the screen.
- The form rules (section 7.4) with the open connection and the type watch; the block's rules as the receiver gets
  them; the guard (each of the five forms, an unknown body, a same-origin request, `send_to`, the password in a
  URL); the outcome and the lockout guard (section 7.7: the three kinds of failed results, the hour's limit, the
  state file); the order of the clean end, the leak check before the move, and the payload of the move (section
  7.8); the input lock; the `sign_in` events with their `phase`.
- The answers: each text of section 7.9 holds no value of the page.
- The process: the service refuses to open the store when the protection of board ab-v16.96 (hold SIGUSR1 at
  start; disable the inspector signal) does not hold, or when `PR_SET_DUMPABLE` cannot be set.

**The mutation for each rule:**

| Rule | The mutation | The test that fails |
| --- | --- | --- |
| The act tab is hidden | the act tab in `Target.getTargets` | the hidden-tab test |
| No client attaches it | `Target.attachToTarget` with its id passes | the attach test |
| Its window is hidden | `Browser.getWindowForTarget` answers for the act tab | the window-lookup test |
| A context of its own | the act window without `incognito: true` | the fake bridge's context test |
| One act context | an act while another incognito window is open | the other-window test |
| The origin check | the check removed | the redirect-to-another-origin case types a key |
| A GET form gets no key | the method check removed | the GET case types a key |
| The block | rule A or C left out of the receiver's request | the block vector |
| The block before the first key | the keys before the receiver's confirmation | the order test |
| An open connection | the WebSocket check removed | the open-WebSocket case types a key |
| The type watch | the observer removed | the type-change case keeps typing |
| The window off the screen | the place check removed | the window case types a key while on the screen |
| The guard | a request with the password in a base64url URL continues | the guard case reaches the fake tracker |
| The leak check | the move with a `localStorage` value that holds the password | the leak case moves |
| The clean end | `Page.resetNavigationHistory` removed | the history case finds the sign-in page |
| The remote refusal | check 1 passes a request that a remote token admitted | the remote case signs in, and its `tools/list` holds `browser_sign_in` |
| The repo check | the repo compared with the request's field, not the walk's | the other-repo case signs in |
| The lock | an act while locked | the locked case signs in |
| The seal's data | `repos` left out of the additional data | the case with an added repo on disk signs in |
| The approval | the act opens a record whose seal holds `approved: false` | the case with an offer marked `usable` on disk signs in |
| An offer's fields | the request's `repos` used in an offer's seal | the offer vector |
| The generation | the `gen` check removed | the old-copy case signs in |
| The seal's key | the public half taken from `key.json` | the replaced-key case seals to the test's key |
| The KDF bounds | the bounds check removed | the planted-N case derives |
| The pane's seal | a replayed request id accepted | the replay case unlocks |
| The lockout guard | timeouts not counted | the fourth act after three timeouts runs |
| The hour's limit | the limit removed | the seventh act in an hour runs |
| Operator only | `sign_in_seal` with `kind: token` and no offer passes | the provenance vector |
| No value in an answer | a site's error text passed on | the answer scan finds the canary |
| No value in a log | the username logged at an act | the log scan finds the canary |
| No inspector | the store's check of board ab-v16.96's protection removed | the open-store test without it passes |
| Each scan reads its text | a scan that returns no hit at all | its twin test with the planted canary |

**The secret scan.** A test store holds canary values (a username, a password, a passphrase, and a TOTP seed, each
a fixed fake string). A plain string search (as `grep -F`, in the five forms of section 7.6) finds none of them in:

- every argv and environment that the service, the daemon or a test starts (Chrome, the host shim, `xdotool`, the
  CLI);
- every log line of the service and the daemon (the service's log sink, Python's `caplog`);
- every event, every `status`, every answer, every pane API answer;
- every C12 line and every gateway request body (only the pane's seals hold them, and only in the four ops of
  section 6.2);
- the daemon's memory after an add and an unlock (a test reads the daemon process's heap through a test hook of
  its own and finds no canary, because only sealed text came in);
- the profile folder after a live act (as the probe did), the act's output, and a test session's transcript.

Each scan has a twin test that plants a canary in its text and must find it.

**agentwatch's tests (the daemon lead):** the store's files and modes; the permissions sweep; the uninstall; the
routes refuse a link login, the API token and an `operator` key in a body; the routes take only sealed text; the
pane's seal with a vector that the service's tests share; the daemon is non-dumpable after the door's check and its
unit holds `LimitCORE=0`; the offer's command refuses a terminal and an argv secret and seals on its side; the
offer's source comes from the walk of the kernel's peer pid (a request with another session's name gets the walk's
session); the live view sends no frame and plays no input between a `sign_in` start and its end, and ends the blank
after 60 s; the scans above on the daemon's side.

**The live check plan (local pages only, on taylor):** after stage 2, with the service in its `--test` mode, on a
free display (175, or another free one that is not reserved), with its own Chromium, a test store with fake values,
and a local test site on `*.localhost` (a form that posts, a sign-in by `fetch` with a token in `localStorage`, a
two-step sign-in, a second-factor page, a page that echoes the values, a page that flips the field's type, a
third-party script on another `*.localhost` host with the six channels of round 1, a cache-first service worker
of the agent):

1. The act from the CLI, from the MCP tool, and from Playwright's `newBrowserCDPSession`, through the real
   receiver's `chrome.debugger`: signed in; the agent's own tab loads the signed-in page after the move.
2. A test agent session tries each read of section 4.2 on its own tabs during and after the act, and the same-origin
   channels of round 1's case K1: none gets a value; it cannot see the act tab or its window.
3. Each refusal of section 7.9 that a local page can make.
4. The block and the guard against the third-party script; the echo page; the type watch.
5. The framebuffer during the act holds no pixel of the act window, and the live view sends no frame.
6. The scan of section 11 over the logs, the profile folder (its `History` file included), the session's
   transcript and the pane captures.
7. A restart of the test service: the store is locked; the test unlock opens it.
8. With Chrome stable and the receiver's CRX: the incognito allow from the profile's preferences (section 7.3).

Stage 3 repeats steps 1 and 6 on the real path with the operator's approval and the operator's first credential.

## 12. The probe

The probe ran on taylor with fake values only (the folder
[2026-11-10-stored-sign-in-credentials-probe/](2026-11-10-stored-sign-in-credentials-probe/README.md) has its code,
its run and its results). Debian Chromium 156.0.8078.79 with `--remote-debugging-pipe` and `--password-store=basic`
on temp profiles, a private Xvfb on display 175, local pages on `login.localhost` and `tracker.localhost` only,
under the heavy-job lock and the harness guard. It printed no value.

| Question | Result |
| --- | --- |
| What can a CDP client read after a fill by `Input` events? | the value through `Runtime.evaluate`, `DOMSnapshot` and the submit's network event; through `DOM.getOuterHTML` only when a page script copies the value into the attribute; nothing through the accessibility tree (section 4.2) |
| Can the agent's interception send the submit elsewhere? | yes: `Fetch.continueRequest` with another host's URL; that host got the body |
| Does a fill and submit leave the value after a navigation? | yes, in the back-forward cache: `history.back()` brought the sign-in page back with its value. After `Page.resetNavigationHistory`, no. A page with `Cache-Control: no-store` did not enter the cache |
| After a failed sign-in? | a server form sent empty again: no value; a form that echoes, or a sign-in by `fetch`: the value stays |
| Does a script put in first see the keys? | yes: a main-world listener, an isolated-world init script, and a window reference |
| Does the act work in a tab of its own, with the guard? | yes: signed in in 1.6 to 1.7 s (keys 8 ms apart; the person's input is slower); the guard failed both requests of the page's script to another host, which got nothing; the agent's own tab then loaded the signed-in page |
| What does Chromium write to the profile? | with its defaults: the username in `Login Data` and in `Web Data`'s `autofill` table, and an echoed value in the HTTP cache; with password saving, the leak check and autofill off: no file held the username or the password. In no run did a profile file hold the password |

This first probe drove the act over a CDP pipe, not through the receiver. The round-1 probe below drove it
through an extension's `chrome.debugger`. In both, the hiding of the act tab from clients is designed, not
measured: it is the model's code (section 7.3), and the build's tests prove it.

**The round-1 probe (fix round 1 of review-104).** `probe-round1.ts` in the same folder, with its results in
`results/results-round1.json`. The same Chromium, display 175, the heavy-job lock and the harness guard, fake
values, `login.localhost` and `tracker.localhost` only. A small extension that the probe writes into its run
folder (`--load-extension`) plays the receiver: it uses only extension APIs (`chrome.debugger`, `chrome.windows`,
`chrome.cookies`, `chrome.declarativeNetRequest`). The pipe plays the harness and the agent. Xvfb wrote its
framebuffer into a file (`-fbdir`), as the live view reads it. It printed no value.

| Question | Result |
| --- | --- |
| Can the receiver's `chrome.debugger` make a browser context? | no: `Target.createBrowserContext` answered "Not allowed", and `Browser.setWindowBounds` "wasn't found" |
| Can an extension open an incognito window and drive its tab? | without the allow, `windows.create` with `incognito: true` gave the extension no window; with `extensions.settings.<id>.incognito: true` in the profile's `Preferences` before the start, yes: it got the window and attached its tab |
| In one context, does an agent's tab of the origin reach a sign-in tab? (case K1) | yes: the agent's cache-first service worker served the agent's page at the sign-in path, and the agent's tab got the typed value (a contrast value) by `BroadcastChannel` and by the `storage` event. With `Network.setBypassServiceWorker`, the agent's page was not served |
| In the act's incognito context? | no: the agent's page was not served; the agent's `localStorage` marker and its Cache Storage were not visible; no worker controlled the page; no broadcast and no `storage` event reached the agent's tab; the act's marker was not in the default context; the act's target had another `browserContextId` |
| Is each act's context new? | yes: at the start of each of the three acts, the act's cookie store was empty; after each close, only the default store was left |
| Does the move sign in the agent's tabs? | yes: 1 cookie and 2 `localStorage` items moved (with a stand-in of C6); the agent's pages went from "not signed in" to "signed in", by the cookie and by the token in `localStorage` |
| Does the act write the profile's `History` file? | no: no row of the act's paths and no title with the username; one row of the agent's own page |
| What reaches another host from a page script that sends each typed value through six channels (fetch, image, beacon, WebSocket, a dedicated worker, a service worker)? | with the earlier guard alone (`Fetch`, four forms): the whole password by the image URL (base64url), the service worker and the WebSocket; parts of 4 to 18 characters by all six; the guard failed the whole value in the fetch, the beacon and the dedicated worker's fetch; `Fetch` paused no WebSocket. With rules A, B and C of section 7.6: no request reached the other host, and the sign-in worked |
| Does the act see a WebSocket that the page opened at its load? | yes: `Network.webSocketCreated`, before the first key |
| Does the type watch work? | yes: a page script changed the type after 3 of 19 keys; the field was empty, and the act stopped |
| Can the act window sit outside the screen? | by the extension, no: "Bounds must be at least 50% within visible screen space", for a window wholly outside and for one more than half outside; a minimized state stayed "normal" (no window manager). By browser-level CDP (the pipe; agent mode has none), yes. At the X level (`xdotool windowmove`), yes, and Chrome reported the new bounds. Outside the screen, the framebuffer held 0 pixels of the act page's colour (about 895,000 on the screen), and the sign-in worked there. An X client moved the window back onto the screen (the same-uid limit). The pointer stopped at the screen's edge |
| Which of the six preferences does Chromium keep? | 5 of 6; it removed `autofill.enabled` from the file |
| Did a profile file hold a value? | no file held the username or the password. The contrast value that the agent's page wrote into the default context's `localStorage` (case K1) was in its LevelDB log: the scan finds what is there |
| How long? | the act with the block, the window cases and the move's read: 11 s; the other two acts: 4.5 and 5.6 s (keys 40 ms apart) |

Not probed: the real receiver and its CRX in Chrome stable (the incognito allow there included), rules D and E,
the leak check before the move, the fallback's freeze, WebRTC, a password saved in Chrome's own manager, and the
Mac.

## 13. The build tasks, in order, and when the first credential is live on taylor

Each task is a branch, a pull request with its tests, and a fresh review. None starts before the operator's answers
(section 14) and this design's merge. Board ab-v16.96 (hold SIGUSR1 at start; disable the inspector signal) is
merged (PR #105).

| # | Side | Task | Waits for |
| --- | --- | --- | --- |
| 1 | agent-browser | The contract texts of section 10 (C11, C12, the allow list, the service design) and their vectors | the answers |
| 2 | agent-browser | Stage 1e part 1: the store in the service: the seal and the key (Node's `crypto`), the KDF bounds, the generation file, the pane key and the open of the pane's seal, the lock, the ops of section 6.2, `status`, the events, the non-dumpable start and the check of board ab-v16.96's protection, the fake's ops | task 1; stage 1a (done) |
| 3 | chrome-extension | The receiver's part (C4, C5, C10 of section 10): the incognito act window with its mark and its exclusions, the block's rules A to E with their confirmation, the read of the act store's cookies, `windows.get` of the act window | task 1 |
| 4 | agent-browser | Stage 1e part 2: the act in the model: the act window and the hiding of its tab and window, the internal session, the checks (the local admission first), the form rules with the open connection and the type watch, the move outside the screen at the X level, the fill with the input design's generator (`src/human/` from ab-t30.3 and ab-t30.4, or `src/input.ts` until then), the block's request, the guard, the outcome and the lockout guard, the clean end, the leak check and the move through stage 1c's import path, the answers, the log and the events; `AgentBrowser.signIn` and `signIns`; the CLI commands; Chrome's preferences and the receiver's incognito allow before each start | tasks 2 and 3; stage 1b part 2 (ab-v16.94.9: the model and the native link in the service); stage 1c (ab-v16.94.4, done: the lists, the scopes and the import); the token design's `repo_key` in `set_sessions` (the daemon lead's change 4, in the token design's build) |
| 5 | agent-browser | The MCP tools `browser_sign_in` and `browser_sign_ins` in stage 1d's transport, for a local admission only | task 4; stage 1d (ab-v16.94.5, which follows the token design) |
| 6 | agentwatch (with age-q8t.1) | The store's files, the snapshot, the ops' client, the gateway's routes (sealed text only), the Browser pane with the pane's seal, the live view's blank during an act, the Web Push, the offer (Q3 b: the command's seal, the socket, the walk) | task 2; stage 2's client |
| 7 | agentwatch (with age-q8t.2) | The units: the service's `LimitCORE=0` and no `NODE_OPTIONS`; the daemon non-dumpable, with `LimitCORE=0` in its unit | task 2 |
| 8 | agentwatch | The skill text | task 6 |
| 9 | both | The live check of section 11 with the test service (stage 2) | tasks 3, 4, 6, 7 and 8 |
| 10 | both | Stage 3 on taylor (the switch, with the operator's approval); then the operator sets up the store, unlocks it and adds the first credential; the agent of that repo removes its file | task 9; stage 3 |
| 11 | both | The Mac (stage 4): the memory check of section 5.5; until then the store and the act stay off on the Mac | stage 4 |
| later | agent-browser | Q4 b or c, if chosen; field hints; IndexedDB in the move; a use from another box (section 5.7) | an operator's word |

**When the first credential can be live on taylor.** After task 10: stage 3 on taylor, with tasks 1 to 9 done. The
CLI and Playwright path (tasks 2, 3, 4, 6 and 7) does not wait for stage 1d; the MCP tool (task 5) comes with stage
1d. So stage 3 can bring the first credential to the repo's agent through the CLI, also when stage 1d is not done.

**No safe way on today's path.** Today the daemon runs the Chrome unit, and the relay (the daemon's child) is the
model. A build there would need the act in the relay, a new line from the daemon to the relay, and the pane. That
breaks the daemon lead's first condition (the old path stays unchanged until stage 6), and every part would move
again at the switch. So the first credential waits for stage 3.

## 14. Questions for the operator

Four questions, for one board item. You answered the token design's questions (board items ab-0wv, ab-sxg,
ab-ufy and ab-5t3), and these four build on those answers: the stored sign-ins live in agentwatch's token store,
and only sessions of this box use them.

**The answers (board item ab-8w8, 2026-11-10, confirmed, with a web login, with no note).** The build follows them:

- **Q1: a.** A locked store that the operator unlocks in the Browser pane (section 5.2).
- **Q2: b.** Every repo whose list covers the credential's host may use it; a credential names no repos, and the
  pane offers no repo choice (section 8). This is not the recommendation; the design holds with it as written
  (sections 5.3, 6.3 and 7.2 state both options).
- **Q3: b.** An agent that holds a credential today may also put it into the store once, for the operator's
  approval (section 6.3). This changes the manager's rule "the operator alone adds", as the question said. With
  Q2 b, the approval has no repo choice: the operator approves or removes the offer.
- **Q4: a.** No second factor in the first build (section 9).

The questions below stay as the operator read them.

Until you answer, nothing of this design is built. If you answer some questions and leave one open, its no-answer
choice holds.

**Q1. What keeps the stored passwords closed when no sign-in runs?**

Context: you asked that agents sign in from usernames and passwords that you store, with no file in an agent's hands,
and with no way for an agent to read a password. The agent browser types the password itself, in a private window of
its own that no agent can reach (the design's section 7). A fact first, in plain words: every agent runs as your OS
user, so it can read every file that your user can read. So only a key that is not in any file keeps an agent's shell
command from reading a stored password.

- **a. A locked store that you unlock (recommended).** Each password is encrypted on disk. Only the agent browser's
  service holds the key to open it, in its memory, after you type the store's passphrase in the Browser pane. Your
  browser encrypts the passphrase and each password before they leave it, so agentwatch itself never holds them in
  plain text. Other programs of your user cannot read the agent browser's memory on taylor. An agent's shell command,
  a backup or a copied folder gets only encrypted data. After each restart of the agent browser's service (an update
  of agent-browser, a reboot, a crash), agents cannot sign in until you unlock again; agentwatch sends you one notice
  when an agent waits. During the build months, agent-browser updates come several times a week. A hostile program of
  your user that replaces the agent browser's code could still wait for your next unlock.
- **b. An always-open store.** The passwords are in files of your user (in agentwatch's token store, where agentwatch
  also keeps each session's connection token), and the agent browser opens them at any time. No unlock, no notice. But
  any agent of your user can read every stored password with one shell command, also after a web page's injected
  instruction, and a backup holds them.
- **c. Chrome's own password manager in the agent browser.** On taylor it keeps passwords with no encryption, it
  fills them into pages that agents drive (so an agent can read them there), and you add each one in Chrome's own
  settings in the live view. Not recommended.

Recommendation: a. No answer: a.

**Q2. Which agents may sign in with a stored credential?**

Context: a stored credential is for one site (for example a staging login). An agent asks for a sign-in by the
credential's name, and the agent browser checks the agent's repo. A fact in plain words: the agent browser has one
profile, so after a sign-in every repo whose site list has that site sees the signed-in pages. This question
decides who may start a sign-in (which account the session gets, and who can cause failed sign-ins), not who sees
the session after it.

- **a. The repos that you tick on each credential (recommended).** When you add a credential, the Browser pane
  shows the repos whose lists have its site, none ticked. Only a ticked repo's agents may use it, and only while
  their list has the site. A new repo gets no credential by itself. One more choice for each credential. Two
  credentials for one site (for example a user account and an admin account) can go to different repos.
- **b. Every repo whose list has the site.** No choice per credential: your list is the only place that decides,
  as for the site itself. A repo that you add a site to (only to read a public page) also gets the sign-in.

Recommendation: a. No answer: a.

**Q3. Who may put a credential into the store?**

Context: the manager's rule today: you alone add, change and remove a stored credential, in the Browser pane
with your password login. The first user is a staging login that the agent of one repo keeps in a file today.
With option a, you type that username and password into the Browser pane, and the agent then removes its file.

- **a. Only you, in the Browser pane (as the rule says today).** No agent can add one. You need the username and
  the password at hand to type them.
- **b. Also an agent that holds one today, once, for your approval (recommended).** This changes the manager's
  rule "you alone add": with b, an agent puts a credential into the store, and only its use waits for you. The
  agent hands the value to the store one way: it can never read it back, and the value never shows on a screen.
  The Browser pane then shows "An agent offered a stored sign-in", with the site, and with the session and the repo
  that agentwatch itself finds for that agent (not what the agent says). No agent can use it until you approve it,
  whichever repos may use credentials: your approval is part of the credential's encryption, so a changed file
  cannot make an offer usable. At the approval you choose its repos. A change or a removal stays yours alone. This
  moves today's files out of agents' hands with no copy on your screen. An offer gives no agent a new right to the
  password, because that agent already holds it.

Recommendation: b. No answer: a (the rule as it is today).

**Q4. What does the agent browser do when a site asks for a second factor?**

Context: some sites ask for a code after the password (from an authenticator app). The first user may not need
one.

- **a. Not in the first build (recommended).** The sign-in stops at the code page, and the agent gets "The site
  asks for a second factor". You sign in by hand in the live view, or send the sign-in from your own Chrome.
- **b. Store the authenticator's secret with the credential.** The agent browser makes the code and types it.
  Agents then sign in with no person. But the second factor is then in the same store as the password, so it no
  longer protects you against a reader of the store.
- **c. You type the code when a sign-in asks.** agentwatch sends you a notice; you type the code in the Browser
  pane within 3 minutes; the agent waits. The second factor stays with you, at the cost of a prompt for each such
  sign-in.

Recommendation: a, with b or c as a later task when a site needs it. No answer: a.

## 15. Limits and open points

- **The same-uid limit** stays (section 4.3, T15). The design does not claim more.
- **The block and the guard** stop every request except a top-level GET to a host outside `send_to`, and the guard sees five forms of the
  password. Not stopped: the site's own origins of `send_to` (a hash, an encryption, a compression, a part of the
  value, a WebSocket), a service worker's WebSocket to a subdomain or another port of a `send_to` host, a top-level
  GET of the act tab to a host on the scope's list with a changed or partial value, the first requests of an act popup
  before the service's session holds its `Fetch` (a popup after the act's last key), DNS prefetch and preconnect, and
  WebRTC
  (section 7.6).
- **The display**: a program of the user with the display's X authority can read the display and the act window's
  title, move the window back onto the screen and send it input (T16). A site's own reveal control that shows the
  value in another element passes the type watch.
- **The username after the sign-in**: the site's own pages can show it to the agent (section 4.1).
- **One tab's storage and IndexedDB**: a site that keeps its sign-in in `sessionStorage` or in IndexedDB gives the
  agent's tabs nothing in the first build (section 7.10).
- **The move closes the agent's tabs of the origin** and replaces the host's cookies (C6), so an old session of the
  site ends at each act.
- **A sign-in cookie on a parent domain** (for example `Domain=example.com` for `staging.example.com`) is not in
  the move's payload, whose `domain` is the credential's host. A later option: a parent domain that the operator
  sets on the credential.
- **The incognito allow with Chrome stable** is not measured: the live check proves it first (section 11, step 8).
  If it fails, the fallback of section 7.3 holds, with its stated limit.
- **Another box**: a session of another box never uses a stored credential in the first build (section 5.7, which
  also says what a later design needs).
- **Frames and odd forms**: the first build fills only the main frame's form, by the rules of section 7.4.
- **Designed, not measured**: the leak check before the move, rules D and E, the fallback's freeze, and the hiding of
  the act tab and its window from clients (the model's code).
- **Through the receiver**: round 1 drove the act through an extension's `chrome.debugger` with Chromium 156. The
  build's live check proves it with the real receiver.
- **The Mac**: the store and the act stay off until stage 4 measures section 5.5.
- **First values**: the act's limit (30 s), the settle (1 s), the wait for a busy act (60 s), three failed results,
  6 acts in an hour, 5 waiting offers, the scrypt values and their bounds, the pane seal's 120 s, the live view's
  60 s, the passphrase's 16 characters, the Web Push's one in an hour, the audit's 200 and 20. The build measures
  and records them.
