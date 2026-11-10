# Agents sign in from credentials that the operator stores — design

**Status: Proposed. It waits for the operator's answers to section 14 (four questions, one board item). The token
design's five questions (A, B1, B2, C and D) go to the operator first; this design builds on their
recommendations, and section 5.7 says what changes with each of their other options. No build starts before
both sets of answers and this design's merge.**

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
- the token design, PR #103 at `051eeef` (not merged, not answered):
  [2026-11-10-mcp-connection-tokens-design.md](2026-11-10-mcp-connection-tokens-design.md) on its branch, "the
  token design" below.

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
   script that it put in first. So the fill must happen where no agent session is.
2. **The sign-in act (section 7).** The agent asks for a sign-in by the credential's name. The service opens a new
   tab of its own in the caller's scope. No client sees that tab, attaches it or gets an event of it. The service
   loads the credential's sign-in page there, checks the origin and the form, types the username and the password
   with the person's input of the input design, submits, and reads the result. Then it empties the fields, clears
   the tab's history, and closes the tab. The cookies of the sign-in stay in the profile, so the agent's own tabs
   then load signed-in pages (measured).
3. **The guard (section 7.6).** During the act, the service sees each request of its tab. A request that holds the
   password in its URL, or a request to another origin whose body holds the password, fails. In the probe the
   page's own script sent the values to another host twice, both requests failed, and the sign-in worked.
4. **What the agent sees (section 7.9).** "Signed in to `<origin>`", or a refusal from a fixed list of texts. No
   answer, log line, event or status holds a username, a password or a form value.
5. **Where the credentials live (section 5, question Q1).** The same-uid fact of the token design holds here too:
   every agent of the operator's OS user can read every 0600 file of that user. So only a key that is not on disk
   stops a shell read of a password. The recommendation: each credential is a sealed record in agentwatch's token
   store (the token design's question A, option a), and only the agent-browser service holds the key that opens
   the records, in its memory, after the operator unlocks the store in the Browser pane. Other programs of the
   user cannot read the service's memory on taylor (`ptrace_scope` 1, and the service makes itself non-dumpable).
   The service starts Node with `--disable-sigusr1` (it disables the inspector signal).
6. **Who adds, changes and removes a credential (section 6, question Q3).** The operator alone, in the Browser
   pane, with the password login, as for the lists. The gateway builds the operator provenance; the service
   applies the acts only with `kind: operator` (C12). The operator may also allow an agent that holds a password
   in a file today to hand it over once, write-only, for the operator's approval (Q3 b).
7. **Which scopes may use one (section 8, question Q2).** The recommendation: the repos that the operator names on
   each credential, and only when the scope's list covers the credential's host. One fact stays plain: the
   profile is one, so the session that a sign-in makes is open to every scope whose list covers the host (C11).
8. **A second factor (section 9, question Q4).** The recommendation: not in the first build. The act stops at a
   second-factor page and says so.
9. **Chrome's own password manager is not the store (section 5.4).** Its "basic" store on Linux has no
   encryption, and it fills saved passwords into pages that an agent drives. The probe also shows that Chromium's
   defaults write the username into the profile (`Login Data` and `Web Data`). With password saving, the leak
   check and autofill off in the profile's preferences, no profile file held either value.
10. **When it can be live on taylor (section 13).** After stage 1b part 2 and stage 1c (the model and the lists in
    the service), the new stage 1e (the store and the act in the service), stage 2 (agentwatch's client and the
    pane) and stage 3 (the switch on taylor, with the operator's approval). The MCP tool comes with stage 1d. No
    safe way exists on today's path: it would change the old path, which stays unchanged until stage 6.

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
- The operator alone adds, changes and removes a credential.
- The operator's choices (where the credentials live, who may add them, which scopes may use them, a second
  factor) are questions with options (section 14), not decisions of this design.

The token design's rules that this design takes as they are:

- agentwatch's daemon holds the secrets of the browser in its token store, `~/.config/agentwatch/tokens/` (0600
  files in 0700 folders, the permissions sweep at each write and each daemon start); the root gateway never reads
  a user's file.
- The operator's acts go through the Browser pane with the password login. The gateway builds the operator field
  from the credential and drops any `operator` key from the request body. A link login is a test login: its acts
  are an agent's.
- The daemon never makes a secret by itself, at a switch-on or an upgrade.
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
- **The act**: the sign-in act of section 7.
- **The act tab**: the tab that the service opens for one act. No client sees it.
- **The guard**: the service's check of each request of the act tab (section 7.6).
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
- a site that sends the password away itself, in a form that the guard cannot see (a hash, an encryption, a
  compression, or a request of the site's own service worker);
- a site that sends the password back in a page or keeps it in the page storage of its origin (the act finds the
  plain cases and clears them, section 7.8);
- a program of the user that reads the Xvfb display during an act: it sees the username in plain text (the
  password field shows dots).

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
to that agent. This is why the act uses a tab of its own.

### 4.3 The table

"Stopped" means the design's rule stops the threat for an honest agent, a mistake and an injected instruction.
"Q1 a" names the store's recommended option.

| # | Threat | What stops it | Result |
| --- | --- | --- | --- |
| T1 | The agent reads the field after a fill (`Runtime.evaluate`, `DOMSnapshot`, the DOM, its events) | The act fills only the act tab. No client sees, attaches or gets an event of the act tab (section 7.3). The agent's own tabs never hold the password | stopped |
| T2 | The agent watches the network or intercepts the submit, reads the body, or sends it to another host | No client session exists on the act tab, so no client's `Network` or `Fetch` acts on it. Only the service's guard has `Fetch` there | stopped |
| T3 | The agent puts a script in first: a main-world listener, an isolated-world init script, a window reference (C7) | The act tab is new: a new document, no opener, no window name, no client registration. No page of the agent holds a reference to it | stopped |
| T4 | The agent changes the form's action to another host | The agent cannot reach the act tab. The form rules (section 7.4) refuse a form that sends to another origin, and the guard fails a request to another origin that holds the password | stopped |
| T5 | The site's own page sends the password to another origin (a third-party script, or a script that page storage changed by the agent steers) | The guard fails each such request when it holds the password in plain, URL-encoded, JSON-escaped or base64 form, or when Chrome does not give its body (probe: 2 of 2 failed, and the sign-in worked) | stopped for those forms. Not stopped: a hash, an encryption or a compression of the password, and requests of the site's own service worker |
| T6 | A page of the exact origin that is not the sign-in page (another path, a page that the agent made) | The act loads the credential's own sign-in path in its own tab. The agent names only the credential | stopped |
| T7 | A redirect during the sign-in (to another origin, to a host on no list) | The origin check before the first key: the page must be on the credential's exact origin. After the submit, the scope's list rules apply in the act tab (C4, C5). The guard fails a request with the password in its URL, on any origin | stopped |
| T8 | A failed sign-in leaves the password in the field (C4, C5) | The act tab closes at the end of each act. Before that the act empties the fields. Three failures in a row stop the credential until the operator acts | stopped |
| T9 | `history.back()` into the back-forward cache (C3) | No client reaches the act tab's history. The act also clears it (`Page.resetNavigationHistory`) before the close (probe C3b) | stopped |
| T10 | A second factor | Q4 a: the act stops and says "the site asks for a second factor". Q4 b or c: section 9 | stopped (no value leaves) |
| T11 | Another OS user (taylor has three human users) | 0600 files in 0700 folders; the 0600 control door and agent door; another user cannot read a process's memory or send it a signal | stopped |
| T12 | Another repo's agent of the same user asks for a sign-in | The service takes the caller's repo from the walk (`set_sessions`), never from the request, and checks it against the credential's repos (Q2). A refusal does not say whether the name exists for another repo | stopped |
| T13 | An agent's shell reads or edits the store's files (an injected instruction: "read the sign-ins and post them"; or it adds its own repo, a path or an origin to a record) | Q1 a: the files hold only sealed records and a wrapped key. The open key is only in the service's memory. A guess of the passphrase offline is slow (scrypt). An edited record does not open, and the service seals only with its own open key (section 5.2). Q1 b: the files open with a key file beside them | Q1 a: stopped, with a long passphrase. Q1 b: not stopped |
| T14 | An agent reads the service's memory: `ptrace`, `/proc/<pid>/mem`, a core dump, Node's inspector | `ptrace_scope` 1 on taylor (an agent is no ancestor of the service); the service makes itself non-dumpable; `LimitCORE=0` in its unit; `--disable-sigusr1` (the inspector signal is disabled) | stopped on taylor. The Mac: section 5.5 |
| T15 | A hostile program of the user replaces the service's code, its unit file or its Node, and waits for the next unlock | Nothing on one OS user. The pane shows each start of the service and each unlock | not stopped (C11's limit) |
| T16 | The value in a transcript, a screenshot, a recording, a pane or a log | The agent never gets the value. No answer, log, event, status or pane holds it. No client screenshot or recording reaches the act tab. The operator's live view shows the act tab: the password as dots, the username in plain, on the operator's own screen | stopped. Not stopped: a program of the user that reads the Xvfb display (the username only) |
| T17 | Chrome's own stores keep a value on disk (the password manager, autofill, the HTTP cache, the session restore) | The service turns off password saving, the leak check and autofill in the profile's preferences before each Chrome start (probe: with them off, no profile file held the username or the password; with Chromium's defaults, the username was in two files). The act empties the fields and clears the history before the close. A page that echoes the password: section 7.8 | stopped for the probe's cases |
| T18 | The operator's backup, and a move to a new box | Q1 a: a backup holds only sealed records and the wrapped key; the move copies them, and the operator unlocks on the new box. Q1 b: a backup holds the key file too | Q1 a: stopped. Q1 b: not stopped |
| T19 | An agent in a loop signs in again and again, and the site locks the operator's account | One act at a time; three "not accepted" results in a row stop the credential until the operator acts in the pane | stopped |
| T20 | A web page asks for a sign-in | The method exists only on the agent door and the MCP port, with their `Origin` 403s and the walk | stopped |
| T21 | A session of another box (stage 5) | The first build refuses the act for a remote scope (section 5.7, the token design's D) | stopped |
| T22 | The session after the sign-in | The cookies are in the one profile, so every scope whose list covers the host gets the signed-in pages (C11, "What one profile shares between scopes"). Q2 decides who may start a sign-in, not who rides its session | not a leak of the password; stated as a limit |

The result in short: the design keeps the password from every agent that uses its normal tools (the browser, the
MCP, the CLI, and its shell with Q1 a), on taylor. It does not stop a hostile program of the same OS user that
replaces the service and waits, a site that leaks the password itself in a form that the guard cannot see, or a
read of the display. It does not claim more.

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
| Fits the token design's A a | yes | yes | no: the store is in the profile, outside agentwatch |

The fact behind row 2 is the token design's same-uid fact: a 0600 file of the user is open to every program of
the user. A key file beside the records does not change that; it only stops a copy of the records alone.

### 5.2 The recommendation (Q1 a)

**The split** (it follows the token design's question A, option a):

| Part | agentwatch (the daemon, the gateway, the pane) | The service |
| --- | --- | --- |
| The files | writes the sealed records and the key file in `tokens/agent-browser/sign-ins/` (0700): an atomic write, mode 0600, the permissions sweep | never writes a secret file |
| The operator's acts | takes them in the Browser pane with the password login; builds the operator field; passes them on the control door | applies them only with `kind: operator` |
| Seal | passes the operator's username and password to the service once, in `sign_in_seal` (section 6.2) | seals them to the store's public key and answers the sealed bytes; keeps no copy |
| The store key | keeps the wrapped key in its file; never holds the open key | makes the key pair at the set-up; holds the open private half in memory while the store is open |
| The snapshot | sends the sealed records (`sign_ins`) at each connect and each change | keeps the last snapshot in memory, as `set_sessions` |
| The act | nothing | opens one record at the act, types its values, and drops them |

So neither side holds a password at rest. The daemon holds sealed bytes and no open key. The service holds the
open key and no file. The plain password exists in the daemon's memory only during an add, and in the service's
memory only during a seal and an act.

**The unlock.**

- The set-up: the operator chooses a passphrase in the Browser pane before the first credential (at least 16
  characters; the pane says why: a program of the user can guess offline against the wrapped key). The service
  makes the store key: an X25519 key pair (Node's `crypto`, no new package). It wraps the private half with
  AES-256-GCM under a key from scrypt (first values: N = 2^17, r = 8, p = 1, a 16-byte salt). It answers the
  public half and the wrapped private half, and the daemon writes them into `key.json`.
- The unlock: after each start of the service, the pane shows "The stored sign-ins are locked". The operator types
  the passphrase. The daemon passes it in `sign_ins_unlock`, and forgets it. The service unwraps the private half
  and holds it in memory. A wrong passphrase gets "the passphrase does not open the store", and the service waits
  2 s before it takes the next unlock.
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

**The seal.** For each record: an ephemeral X25519 key pair, the shared secret with the store's public key,
HKDF-SHA256 to a 32-byte key, and AES-256-GCM over the JSON `{"username":...,"password":...,"totp":null}`. The
additional data is every field that decides where the password goes and who may use it: `v`, `id`, `name`,
`origin`, `path`, `send_to` and `repos`. The service checks the tag at each open. So a program of the user that
edits a record's file (adds its own repo, changes the sign-in path to a page that it controls, adds an origin to
`send_to`) or moves the sealed part to another record breaks the record: the service refuses it ("the stored
sign-in cannot be opened"). The plain `state` field is not in it (section 5.3).

**The service seals only while the store is open**, with the public half that it derives from the open private
half. It never takes a public half from a file. So a program of the user that replaces the public half in
`key.json` with its own does not get the next credential sealed to its key.

### 5.3 The record and the key file

`tokens/agent-browser/sign-ins/<id>.json`, mode 0600, one for each credential:

```json
{"v":1,"id":"c-3f9a2b7c","name":"staging","origin":"https://staging.example.com","path":"/login",
 "send_to":["https://staging.example.com"],"repos":["example-org.site-a"],"state":"usable",
 "added":{"at":"2026-11-10T14:00:00Z","by":"<user>","via":"web"},"changed":null,
 "sealed":{"epk":"<base64url>","iv":"<base64url>","ct":"<base64url>","tag":"<base64url>"}}
```

- `id` is a random id that the daemon makes (`c-` and 8 hex digits). `name` is the operator's short name, unique
  in the store, and it matches C11's scope pattern. The agent asks by `name`.
- `origin` is `https:` and a host, with a port only when it is not 443. `http:` is allowed only for a loopback
  host (`localhost`, `*.localhost`, `127.0.0.1`), for tests.
- `path` is a path on the origin, with no query and no fragment.
- `send_to` lists the origins that may receive the password (section 7.6). It always holds `origin`.
- `repos` is the list of repo keys (Q2 a). With Q2 b the field is absent.
- `state` is `usable`, `offered` (Q3 b) or `stopped` (after three "not accepted" results in a row). It is outside
  the seal's additional data, so a program of the user can change it on disk; at worst that starts a stopped
  credential again (section 7.7) or stops one. An offer's approval changes `repos`, so it needs a new seal (section
  6.2), and an `offered` record that a program marks `usable` has no repos in its seal.

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
password, and Chromium kept the values. The leak check is off also because it sends a hash of the username and
the password to Google at a sign-in.

### 5.5 What protects the service's memory

The open key lives only in the service's memory. These rules keep other programs of the user out of it:

- **`ptrace` and `/proc/<pid>/mem`.** taylor has `kernel.yama.ptrace_scope` 1: a process can trace only its own
  descendants. The service runs under its own systemd user unit, so no agent is its ancestor. The service also
  calls `prctl(PR_SET_DUMPABLE, 0)` at its start (`node:ffi`, as the peer check uses). Then a process of the user
  without `CAP_SYS_PTRACE` cannot attach it or read its memory, also on a box with `ptrace_scope` 0. The
  service's checks of other processes read their `/proc` files, not its own, so this changes none of them. The
  service refuses to open the store when the call fails, and `status` says why.
- **Node's inspector signal.** The service's unit starts Node with `--disable-sigusr1`, and the service refuses to
  open the store when `process.execArgv` lacks it. No other inspector flag and no
  `NODE_OPTIONS` reach the unit.
- **Core dumps.** `LimitCORE=0` in the service's unit, and the non-dumpable state, so no crash writes the memory to
  disk. Chrome and its children inherit the limit.
- **The plain values.** The act holds the username and the password in Buffers where it can, and fills them with
  zeros after the act. JavaScript strings cannot be cleared, so a copy can stay in the heap until the next
  garbage collection; the rules above keep the heap closed.
- **Chrome's memory during an act.** The password passes through Chrome's processes. Chrome runs detached under
  the service's unit, so no agent is its ancestor either (`ptrace_scope` 1).
- **The Mac (stage 4).** macOS has no `ptrace_scope`. The design keeps the store and the act off on the Mac until
  stage 4 measures whether a program of the same user can read the service's memory (`task_for_pid` against the
  Node that the service runs), and the Mac's Keychain as a place for the store key.

Today's path: board task ab-v16.96 holds SIGUSR1 at start and disables the inspector signal, on both sides
(section 13, task 0).

### 5.6 Backups and a move to a new box

- With Q1 a, a backup of the token store holds sealed records and the wrapped key. Without the passphrase they do
  not open.
- The move to a new box: the operator copies the `sign-ins` folder with the token store, and unlocks it on the new
  box with the same passphrase. The records keep their ids and origins, so they open there. Or the operator adds
  the credentials again.
- The uninstall of the agent browser removes `tokens/agent-browser/sign-ins/` (with the token design's rule: a
  normal uninstall, not only `--purge`). An update keeps it. No vault or config sync copies the token store.
- With Q1 b, a backup holds the key file and the records, so a backup is as secret as the passwords.

### 5.7 What changes with the token design's other options

| The token design's question and option | What changes here |
| --- | --- |
| A a (recommended): agentwatch makes and keeps | nothing: section 5.2 is this split |
| A b: the agent browser makes, keeps and checks | the sealed records and `key.json` live in the service's state folder, and the service writes them; `sign_ins` (the snapshot) goes away; the add and the other acts still come through the pane, the gateway and the daemon, with `kind: operator` |
| B1 a (recommended) or b; B2 a or b | nothing: a token gates the MCP port only. The act's own right is Q2's rule, checked by the walk. With B1 b, a repo whose switch is off gets no MCP, so its agents reach the act only through the agent door and the CLI |
| C a (recommended), b, c or d | nothing: the MCP tool of section 7.1 is one more tool on the same entry. With C b (the bridge), the bridge carries it as any tool |
| D a (recommended): no token on the remote path | the first build refuses the act for a remote scope ("Stored sign-ins work only for sessions of this box"). A remote scope has no repo on the Mac, so Q2's rule cannot name it |
| D b: the remote path carries the taylor repo's token | a later design can let a Mac credential name a taylor repo; the first build still refuses |
| D c: direct HTTPS with the token | as D a for the act |

## 6. Who adds, changes and removes a credential

### 6.1 The acts in the Browser pane

All acts are in the Browser pane of the web viewer, with a password login. The gateway builds the operator field
from the credential, after its password-login check, and drops any `operator` key from the request body. A link
login, the API token, the CLI, an agent and another box cannot do any of these acts (except the offer of Q3 b).

- **Set up the store**: the passphrase (section 5.2).
- **Unlock**, **Lock**, **Change the passphrase**, **Remove all stored sign-ins**.
- **Add** (the store must be open, because only the open key seals): the name, the origin, the sign-in path, the
  username, the password (typed twice; the pane never shows it again), the repos (Q2 a: the pane offers the repos whose lists cover the origin's host, none ticked), and
  "more origins that may receive the password" (empty by default).
- **Change**: any field. A change of the username or the password is a new seal (the operator types them). A
  change of the name, the origin, the sign-in path, the origins of `send_to` or the repos is a seal again with the
  new fields (`sign_in_reseal`), so it needs the store open; while it is locked, the pane says "Unlock the store
  to change this credential". A change of the origin needs the password again.
- **Remove**: the daemon removes the record's file, then sends the snapshot without it.
- **Start again** for a credential in the state `stopped` (section 7.7).
- The pane shows each credential's name, origin, repos, state, its dates, and its last 20 uses (section 8). It
  never shows a username or a password, so a screenshot of the pane holds neither.

### 6.2 The C12 ops and their provenance

| Op | Fields | Provenance | What the service does |
| --- | --- | --- | --- |
| `sign_ins_setup` | `passphrase` | `kind: operator` | makes the store key, wraps it, opens the store; answers `{"key":{...}}` for `key.json`; refuses when the snapshot already has a key |
| `sign_ins_unlock` | `passphrase` | `kind: operator` | unwraps the wrapped key of the last snapshot and opens the store; answers `{}` or `the passphrase does not open the store` |
| `sign_ins_lock` | none | `kind: operator`, or `kind: daemon` (the uninstall) | drops the open key |
| `sign_ins_rekey` | `old`, `new` | `kind: operator` | checks `old` against the wrapped key, wraps the open private half again with `new`; answers the new `key` |
| `sign_in_seal` | the record's fields of the seal's additional data (section 5.2), `username`, `password` | `kind: operator`, or `kind: token` with `offer: true` (Q3 b) | seals with the public half of its open key; answers `{"sealed":{...}}`; keeps no copy; while the store is locked: `the store is locked`; with no store key: `the store is not set up` |
| `sign_in_reseal` | `id`, the record's new fields | `kind: operator` | opens the record of the last snapshot and seals its values again with the new fields; answers `{"sealed":{...}}`; while the store is locked: `the store is locked` |
| `sign_ins` | `key` (the public part and the wrapped part), `records` (each record of section 5.3) | `kind: daemon` | a complete snapshot, as `set_sessions`; replaces the service's map; answers `{"records":<count>}` |

- The daemon applies an operator act only with the gateway's field (C12's rule for `kind: operator`), and logs the
  act with its user, the credential's id and name, and the op. It never logs a field that holds a secret.
- The service applies `sign_ins_setup`, `sign_ins_unlock`, `sign_ins_rekey`, `sign_in_reseal` and `sign_in_seal`
  (without `offer`) only with `kind: operator`; any other kind gets `not the operator`.
- The order at each connect: `config`, `set_sessions`, `mcp_tokens` (the token design), then `sign_ins`.
- The feature name `sign_ins` goes into the service's hello.
- No line of the control door except the request lines of `sign_ins_setup`, `sign_ins_unlock`, `sign_ins_rekey` and
  `sign_in_seal` holds a passphrase, a username or a password (these four are "the four ops" below). Section 11's
  scan proves it.
- The daemon checks the service before its hello (C12), so only the real service gets a passphrase or a password.

### 6.3 An agent's offer (Q3 b)

With Q3 b, an agent that holds a credential in a file today can hand it to the store once, and the operator then
approves it. It never reads it back.

- The agent runs `agentwatch browser sign-in-offer --name <name> --origin <origin> --path <path>`, and gives the
  username and the password on stdin (two lines). The command refuses a terminal on stdin, and it refuses any
  secret in its argv.
- The daemon takes it with the API token (the agent's kind). It sends `sign_in_seal` with `kind: token` and
  `offer: true`, writes a record in the state `offered`, with no repos, and records the offering session's name
  and repo. While the store is locked, the offer gets "The store is locked: offer it again after the operator's
  unlock", and nothing is kept.
- The operator's approval ticks the repos, so it is a `sign_in_reseal` (the store must be open).
- The pane shows "An agent offered a stored sign-in: <name>, <origin>, from the session <name> of the repo <repo>".
  The operator approves it (the state becomes `usable`, and the operator ticks the repos) or removes it.
- An offer never changes or replaces a credential: a name that exists gets the refusal "a stored sign-in of that
  name exists".
- No act uses an `offered` record. The skill text tells the agent to remove its own file after the operator's
  approval.

An offer gives no agent a new right: the agent already holds the value. The approval stays the operator's act.

## 7. How an agent uses one: the sign-in act

### 7.1 The entry: one method, three clients

- **CDP**: `AgentBrowser.signIn {"name":"<name>"}` and `AgentBrowser.signIns {}` on the root session or a browser
  session of the agent door. The model answers both; on a page session they are refused, as every call outside
  the model's set. Playwright sends them through a browser CDP session:
  `const s = await browser.newBrowserCDPSession(); await s.send("AgentBrowser.signIn", { name: "staging" })`.
- **The CLI**: `agent-browser sign-in <name>` and `agent-browser sign-ins` (and `agentwatch browser sign-in
  <name>`, the thin wrapper). They send the method over the agent door, so the walk gives the scope.
- **The MCP**: two tools of the service's own, `browser_sign_in {name}` and `browser_sign_ins {}`. The service's
  transport adds them to `tools/list` and runs them as the method for the MCP session's scope.

`AgentBrowser.signIns` answers the names and origins that the caller's repo may use, and the store's state:
`{"state":"open"|"locked"|"none","signIns":[{"name","origin"}]}`. Names and origins are not secrets.

### 7.2 The checks before the act

In this order. The first check that fails gives its text (section 7.9).

1. The caller's scope is a local scope (not a remote one, section 5.7), and the agent browser is ready (C11's
   readiness).
2. The store has a credential of that name in the state `usable`, and the caller's repo (the walk's session,
   `repo_key` of `set_sessions`) is in its `repos` (Q2 a), or its list covers the host (Q2 b). Else: "no stored
   sign-in of that name for this repo", the same text in both cases.
3. The scope's list covers the credential's host, and each host of `send_to`.
4. The store is open.
5. The record opens: its seal's tag holds with its fields as the additional data. Else: "the stored sign-in cannot
   be opened".
6. No other act runs. An act waits for the one before it, at most 60 s.

### 7.3 The act tab

- The model opens a new window (on the Mac a tab) with C10's `windows.create` and the caller's scope, at
  `about:blank`, held as C10 says. So the receiver's list rules of that scope apply to it (C4, C5).
- The model marks it an act tab. No client sees it: `Target.getTargets` leaves it out, no `Target.targetCreated`
  or `Target.attachedToTarget` goes to any client, and each call with its id gets "No target with given id
  found". A popup whose opener is an act tab is an act tab too, and the act closes it at its end.
- The service attaches its own session to the tab, inside its process (as the MCP's ticket connection is inside
  it). No socket carries that session.
- The tab is new: a new document, no opener, no window name. No client has a script, a binding or an init script
  in it.

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
   `<form>` (a sign-in by script) goes on; the guard is then its check.
5. A two-step sign-in: the act fills the username, submits, waits for the next page, and applies rules 1 to 4
   again. At most one such step.

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

### 7.6 The guard on the act tab's requests

Before the navigation, the service turns on `Fetch` in the act tab for every URL, at the request stage. For each
paused request:

- When its URL holds the password (plain, URL-encoded or base64), on any origin: it fails (`Fetch.failRequest`,
  `BlockedByClient`). A URL with the password would go into the profile's history file and the server's logs.
- When its origin is not in `send_to`, and its body holds the password in plain, URL-encoded, JSON-escaped or
  base64 form, or Chrome does not give its body: it fails.
- Every other request continues unchanged.

A failed request is no reason to stop the act: a third-party script's request fails, and the sign-in goes on
(probe: 2 requests failed, the sign-in worked). The service sends the operator an event with the host of each
failed request (not its path); the pane shows it on the credential's row. When the site's own sign-in request
fails (its API is on another origin), the act ends with "the site sends the password to another origin; the
operator can allow that origin in the Browser pane", and the operator adds it to `send_to`.

The limits of the guard: it sees only these four forms; it does not see a request of the site's service worker
(the worker's own `fetch` is the worker's target, which the act does not attach).

### 7.7 The outcome

The act watches the act tab for at most 30 s (a first value) after the submit:

- **Signed in**: the main frame commits a new page, or its URL changes, and after 1 s with no navigation it has no
  visible password field. The final origin is on the scope's list; an origin off the list is blocked by C4 and
  C5, and the act ends "the site went to a host on no list after the sign-in".
- **Not accepted**: a visible password field is still there after the settle.
- **A second factor**: a visible field for a code and no password field: `autocomplete="one-time-code"`, or an
  input whose name or id holds `otp`, `totp`, `2fa`, `mfa` or `code` and whose `maxlength` is 4 to 10. Section 9.
- **Timeout**: none of these in 30 s.

Three "not accepted" results in a row for one credential set its state to `stopped`, so a loop cannot lock the
operator's account. The operator's "Start again" in the pane clears it.

### 7.8 The clean end

In this order, also after a refusal in the middle of the act:

1. The service looks for two leaks of the site itself, in the four forms of section 7.6. (Designed, not measured:
   the probe's echo case ran in a tab of the agent, not in the act.)
   - A page that the server sent after the submit holds the password in its HTML before the act types into it
     (the site echoes it). Chromium keeps such a page in its HTTP cache on disk (probe, profile 1: the echoed
     username was in a cache file). The service clears the browser's HTTP cache (`Network.clearBrowserCache`).
   - The origin's `localStorage` holds the password (the service reads it in its isolated world). The service
     clears that origin's site data (`Storage.clearDataForOrigin`, all types; this also undoes the sign-in).

   In both cases the act ends with "the site keeps the password where its pages can read it", and the service
   sends the operator an event. The value that the act itself typed into a field, and a value that a page script
   copied into an attribute of the act tab, are no leak: the tab closes.
2. It empties every input of the main frame.
3. It clears the tab's history (`Page.resetNavigationHistory`; probe C3b).
4. It turns `Fetch` off and closes the act tab and its popups.
5. It fills the Buffers of the values with zeros, and drops the opened record.

### 7.9 What the agent sees

The answer of `AgentBrowser.signIn`, the CLI's output and the MCP tool's text:

- success: `{"signedIn":true,"name":"staging","origin":"https://staging.example.com"}`, and the text "Signed in to
  https://staging.example.com. Your tabs of this site load signed-in pages from now on."
- a refusal: the CDP error `{"code":-32000,"message":"Not signed in: <text>"}` (the CLI's exit 1; the MCP tool's
  error), with one text of this list:

| Cause | The text |
| --- | --- |
| a remote scope | `Stored sign-ins work only for sessions of this box.` |
| not ready | C11's readiness text |
| no such name for this repo | `There is no stored sign-in named <name> for this repo.` |
| the list | `Not allowed: <host> is not on the allowlist` (C11's text) |
| locked | `The stored sign-ins are locked. The operator unlocks them in the Browser pane.` |
| busy for 60 s | `Another sign-in runs now. Try again in a minute.` |
| stopped | `The site did not accept this stored sign-in three times. The operator checks it in the Browser pane.` |
| another origin | `The sign-in page is on another origin than the stored sign-in names.` |
| the form | `The sign-in form sends to another place than the stored sign-in names.` / `The page has more than one password field.` / `There is no sign-in form that the agent browser can fill.` |
| not accepted | `The site did not accept the stored sign-in.` |
| a second factor | `The site asks for a second factor. The agent browser cannot answer it: ask the operator.` |
| the guard | `The site sends the password to another origin. The operator can allow that origin in the Browser pane.` |
| a leak of the site | `The site keeps the password where its pages can read it, so the agent browser removed the sign-in.` |
| a host on no list | `The site went to a host on no list after the sign-in.` |
| timeout | `The site did not finish the sign-in in 30 s.` |
| the record | `The stored sign-in cannot be opened. The operator adds it again.` |

No text holds a value of the page: a site's own error text can name the username, so the act never passes it on.
No text names a stop or a start (I2).

### 7.10 What the agent's CDP access may do during and after the act

- **During the act**: every call on the agent's own tabs works as before. Its input calls wait for the input lock
  while the act types and clicks (a few seconds; the input design's typing is about 5 characters a second). It
  cannot see, attach, screenshot, record or close the act tab. A `Target.setAutoAttach` of the agent attaches
  nothing of the act.
- **After the act**: the agent's tabs of the site load signed-in pages: the cookies are in the profile (probe: the
  agent's own tab got the signed-in page). A tab that was open before the act shows the signed-in page at its
  next load. The act tab and its history are gone.
- A site that keeps its sign-in in one tab's own storage (`sessionStorage`) gives the agent's tabs nothing. The act
  cannot tell. A later option can hand the act tab to the caller after a new load and a history reset; this design
  does not build it.

## 8. Which scopes may use a credential; the log and the audit

**The rule (Q2 a, recommended).** A scope may start a sign-in with a credential when both hold:

- the scope's repo (the walk's session, its `repo_key`) is in the credential's `repos`;
- the scope's list covers the credential's host and each host of `send_to`.

With Q2 b, the first condition goes: every repo whose list covers the host may use it.

- A session outside a GitHub repo has the repo key `no-repo` (agentwatch's rule), and the operator can name it.
- A session whose repo is not known (`unread-repo`) never uses a credential.
- **Stated plainly:** the profile is one (O9), so the session that a sign-in makes is open to every scope whose
  list covers the host: its cookies are in the profile for every scope (C11). Q2 decides who may start a sign-in
  (who can cause a sign-in, which account the session gets, and who can trigger "not accepted" results), not who
  rides the session after it.

**The log rule.**

- No log line of either side holds a username, a password, a passphrase, a sealed record, a form value, a page's
  text, a URL path or a query. The C12 log rule gains these words (section 10).
- The service logs one line for each act: the user, the scope, the repo key, the credential's id and name, the
  origin, the result's code, the time it took. For each failed request of the guard: the host only.
- The daemon logs one line for each operator act: the user, the op, the credential's id and name.

**The audit.**

- The service sends a `sign_in` event for each act: `scope`, `repo`, `id`, `name`, `origin`, `result` (the code of
  section 7.9), `ms`, `at`, and `blocked` (the hosts of the guard's failed requests).
- The daemon keeps the last 200 events in its own state (no secret), and the pane shows the last 20 of each
  credential: which scope and repo used it, when, and with which result.
- `status` gives `sign_ins`: `{"state":"none"|"locked"|"open","records":<count>,"acts":<count since the
  start>}`, with no name of a credential.

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
  operator types the code in the Browser pane; it goes to the service as an operator act (`sign_in_code`), and
  the act types it. Effect: the second factor stays with the operator. Cost: a prompt for each such sign-in, and
  an agent waits.

A code that an agent reads is short-lived (30 s). The act still types it only in the act tab.

## 10. The contract changes and agentwatch's side

A later task (section 13, task 1) makes these changes, after the answers. The quoted sentences are today's.

**C11 (`docs/contracts/C11.md`).**

- The part table at the top gains a row: "The sign-in act (`AgentBrowser.signIn`, `AgentBrowser.signIns`) and the
  act tab | agent-browser's service | stage 1e builds it, off by default; it serves sessions from stage 3".
- "Where each call goes": "The model answers the calls of its set (two-modes design, section 4.3) on the root
  session and on a browser session (`Target.attachToBrowserTarget`)." gains: "and `AgentBrowser.signIn` and
  `AgentBrowser.signIns` (the sign-in act, below)". The table gains their two rows (the model; refused on a page
  session).
- "The scope, and one connection per tab": "Every other tab is in no scope, and no connection sees it: the
  operator's tabs, the restore tab of an import, a tab that the receiver's map does not hold." gains: "An act tab
  of the sign-in act is in its caller's scope for the list rules, but no connection sees it, attaches it or gets
  an event of it; a popup of an act tab is an act tab."
- "What one profile shares between scopes, stated plainly: ... the sent sign-ins (cookies, storage, workers) are in
  the profile for every scope" gains "and the sessions that the sign-in act makes".
- A new part, "The sign-in act (from stage 1e)": sections 7.2 to 7.9 as rules, with the texts of section 7.9.
- "The MCP inside the service": "Tools and argument keys pass only through the allow list" gains "and the service's
  own tools of the allow list's `service_tools`". "No log line of the MCP path holds a tool argument, page content,
  a cookie, a URL path or a payload" gains "a username, a password or a form value".
- The limits: after "As on the endpoint, the check does not stop a hostile process of the same OS user." add: "The
  stored sign-ins do not change this: such a process can replace the service and wait for the operator's next
  unlock."

**The MCP's allow list (`docs/contracts/mcp-allow-list.md`).**

- The file gains a field `service_tools`: the service's own tools, `browser_sign_in` (`name`) and
  `browser_sign_ins` (no argument), each with its schema.
- "`tools/list`: the service drops each tool that `tools` does not name." gains "and adds each tool of
  `service_tools`".
- The test gains: no name of `service_tools` is a tool of the pinned version's `tools/list`.

**C12 (`docs/contracts/C12.md`).**

- The requests table gains the seven ops of section 6.2. The field rules gain their fields.
- Provenance: "The service applies an operator act (`list_set`, `prompt_allow`, `prompt_dismiss`, `import`) only
  with `kind: operator`" gains `sign_ins_setup`, `sign_ins_unlock`, `sign_ins_rekey`, `sign_in_reseal` and
  `sign_in_seal` (except an offer, Q3 b). "the daemon's own requests (`config`, `set_sessions`, `session_ended`, `launch_check`) only with
  `kind: daemon`" gains `sign_ins`.
- The event table gains `sign_in` (section 8) and `sign_ins` (the store's state).
- "No side logs page content, a cookie, a URL path or a payload in any log line." gains "a username, a password, a
  passphrase, a sealed record or a form value".
- The data of `status` gains `sign_ins` (section 8).
- The feature names gain `sign_ins`.
- The vectors (`test/vectors/control.json`) gain each op with fake values, a refused kind for each, and a scan
  vector: a line of each op except the four of section 6.2 holds no canary.
- The fake (`--fake`) has the ops.

**The service design (2026-11-09).** Section 5.1's table gains the row "Stored sign-ins | none | section 5 of the
sign-in design". Section 7.1's two tables gain the ops and events. Section 11's table gains the rows "Stored
sign-ins" (sealed records, the open key only in the service's memory) and "The service's memory"
(`--disable-sigusr1`, non-dumpable, `LimitCORE=0`). Section 13.1's stage 1 gains stage 1e.

**C4 and C10 (chrome-extension `docs/protocol.md`).** No change: the act tab comes from `windows.create` and
`tabs.create` with a scope, and the act uses `debugger.sendCommand` as any client.

**agentwatch's side (the daemon lead's tasks).**

- The store: the folder `tokens/agent-browser/sign-ins/`, the atomic writes, the permissions sweep, the uninstall,
  no sync, the snapshot at each connect and each change.
- The gateway's routes for the acts of section 6.1 (password login only; the operator field built from the
  credential), and the offer's route (Q3 b) with the API token.
- The Browser pane: the store's state, the set-up, the unlock, the lock, the credentials, the uses, the guard's
  hosts, the offers, the "stopped" state.
- The Web Push "an agent waits for a locked sign-in" (at most one in an hour).
- The service's unit: `--disable-sigusr1` in the command, `LimitCORE=0`, no `NODE_OPTIONS` (with age-q8t.2, the
  unit task).
- Today's relay: task 0 (board ab-v16.96).
- The skill text: how an agent signs in (by name; never ask for a password; never read a file of the store), and
  what each refusal means.

## 11. Tests

**Unit tests, agent-browser (stage 1e, `npm test`, no browser):**

- The seal: a round trip; a wrong passphrase; a record whose file a test changes (its repos, its path, its
  `send_to`, its origin, its id) does not open; a changed byte of `ct` or `tag` does not open; a public half in
  `key.json` that a test replaces changes no seal; no seal while locked; the scrypt values; a store with no key.
- The lock: locked at the start; the unlock; the lock; the rekey; a refused unlock waits 2 s; no open key after a
  lock (a test hook reads the state).
- The ops: each op of section 6.2 with each kind; `not the operator` for each other kind; the snapshot replaces the
  map; a bad record breaks no other record.
- The checks before the act (section 7.2), each with its text; the same text for "no such name" and "not for this
  repo".
- The act with the model's fake bridge: the act tab is in no answer of `Target.getTargets`, gets no event to a
  client, and refuses each client call with its id; a popup of it is hidden too.
- The form rules (section 7.4), the guard (each form, an unknown body, a same-origin request, `send_to`, the
  password in a URL), the outcome (section 7.7), the order of the clean end (section 7.8), the input lock.
- The answers: each text of section 7.9 holds no value of the page.
- The process: the service refuses to open the store when `--disable-sigusr1` is not in `process.execArgv`, or
  when `PR_SET_DUMPABLE` cannot be set.

**The mutation for each rule:**

| Rule | The mutation | The test that fails |
| --- | --- | --- |
| The act tab is hidden | the act tab in `Target.getTargets` | the hidden-tab test |
| No client attaches it | `Target.attachToTarget` with its id passes | the attach test |
| The origin check | the check removed | the redirect-to-another-origin case types a key |
| A GET form gets no key | the method check removed | the GET case types a key |
| The guard | a request to another origin with the password continues | the guard case reaches the fake tracker |
| The clean end | `Page.resetNavigationHistory` removed | the history case finds the sign-in page |
| The repo check | the repo compared with the request's field, not the walk's | the other-repo case signs in |
| The lock | an act while locked | the locked case signs in |
| The seal's data | `repos` left out of the additional data | the case with an added repo on disk signs in |
| The seal's key | the public half taken from `key.json` | the replaced-key case seals to the test's key |
| Three failures stop | the count removed | the fourth act runs |
| Operator only | `sign_in_seal` with `kind: token` and no offer passes | the provenance vector |
| No value in an answer | a site's error text passed on | the answer scan finds the canary |
| No value in a log | the username logged at an act | the log scan finds the canary |
| No inspector | the `execArgv` check removed | the open-store test with no flag passes |
| Each scan reads its text | a scan that returns no hit at all | its twin test with the planted canary |

**The secret scan.** A test store holds canary values (a username, a password, a passphrase, and a TOTP seed, each
a fixed fake string). A plain string search (as `grep -F`, in the four forms of section 7.6) finds none of them in:

- every argv and environment that the service, the daemon or a test starts (Chrome, the host shim, `xdotool`, the
  CLI);
- every log line of the service and the daemon (the service's log sink, Python's `caplog`);
- every event, every `status`, every answer, every pane API answer;
- every C12 line, except the request lines of the four ops of section 6.2 (the scan proves that only those hold
  them);
- the profile folder after a live act (as the probe did), the act's output, and a test session's transcript.

Each scan has a twin test that plants a canary in its text and must find it.

**agentwatch's tests (the daemon lead):** the store's files and modes; the permissions sweep; the uninstall; the
routes refuse a link login, the API token and an `operator` key in a body; the offer's route refuses a terminal
and an argv secret; the unit file holds `--disable-sigusr1` and `LimitCORE=0`; the relay: task 0 (board
ab-v16.96); the scans above on the daemon's side.

**The live check plan (local pages only, on taylor):** after stage 2, with the service in its `--test` mode, on a
free display (175, or another free one that is not reserved), with its own Chromium, a test store with fake values,
and a local test site on `*.localhost` (a form that posts, a sign-in by `fetch`, a two-step sign-in, a second-factor
page, a page that echoes the values, a third-party script on another `*.localhost` host):

1. The act from the CLI, from the MCP tool, and from Playwright's `newBrowserCDPSession`: signed in; the agent's
   own tab loads the signed-in page.
2. A test agent session tries each read of section 4.2 on its own tabs during and after the act: none gets a value;
   it cannot see the act tab.
3. Each refusal of section 7.9 that a local page can make.
4. The guard against the third-party script; the echo page's clean end.
5. The scan of section 11 over the logs, the profile folder, the session's transcript and the pane captures.
6. `SIGUSR1` sent to the test service: no inspector line, the store stays open, the service keeps running.
7. A restart of the test service: the store is locked; the test unlock opens it.

Stage 3 repeats steps 1 and 5 on the real path with the operator's approval and the operator's first credential.

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
| Does `--disable-sigusr1` keep a process running at `SIGUSR1`? | yes, on Node v26.12.0 |

Not probed: the act through the receiver's `chrome.debugger` (the build's live check does it), Chrome stable, a
password saved in Chrome's own manager, a site's service worker, and the Mac.

## 13. The build tasks, in order, and when the first credential is live on taylor

Each task is a branch, a pull request with its tests, and a fresh review. None starts before the operator's answers
(section 14 and the token design's) and this design's merge, except task 0.

| # | Side | Task | Waits for |
| --- | --- | --- | --- |
| 0 | both (small, now) | board ab-v16.96: hold SIGUSR1 at start; disable the inspector signal | nothing: it is not part of this design's answers |
| 1 | agent-browser | The contract texts of section 10 (C11, C12, the allow list, the service design) and their vectors | the answers |
| 2 | agent-browser | Stage 1e part 1: the store in the service: the seal and the key (Node's `crypto`), the lock, the ops of section 6.2, `status`, the events, the non-dumpable start and the `execArgv` check, the fake's ops | task 1; stage 1a (done) |
| 3 | agent-browser | Stage 1e part 2: the act in the model: the act tab, the internal session, the checks, the form rules, the fill with the input design's generator (`src/human/` from ab-t30.3 and ab-t30.4, or `src/input.ts` until then), the guard, the outcome, the clean end, the answers, the log and the events; `AgentBrowser.signIn` and `signIns`; the CLI commands; Chrome's preferences before each start | task 2; stage 1b part 2 (ab-v16.94.9: the model and the native link in the service); stage 1c (ab-v16.94.4: the lists, the scopes and `repo_key`) |
| 4 | agent-browser | The MCP tools `browser_sign_in` and `browser_sign_ins` in stage 1d's transport | task 3; stage 1d (ab-v16.94.5, which waits for the token design) |
| 5 | agentwatch (with age-q8t.1) | The store's files, the snapshot, the ops' client, the gateway's routes, the Browser pane, the Web Push, the offer (Q3 b) | task 2; stage 2's client |
| 6 | agentwatch (with age-q8t.2) | The unit: `--disable-sigusr1`, `LimitCORE=0`, no `NODE_OPTIONS` | task 2 |
| 7 | agentwatch | The skill text | task 5 |
| 8 | both | The live check of section 11 with the test service (stage 2) | tasks 3, 5, 6 and 7 |
| 9 | both | Stage 3 on taylor (the switch, with the operator's approval); then the operator sets up the store, unlocks it and adds the first credential; the agent of that repo removes its file | task 8; stage 3 |
| 10 | both | The Mac (stage 4): the memory check of section 5.5; until then the store and the act stay off on the Mac | stage 4 |
| later | agent-browser | Q4 b or c, if chosen; field hints; the hand-over of the act tab (section 7.10) | an operator's word |

**When the first credential can be live on taylor.** After task 9: stage 3 on taylor, with tasks 1 to 8 done. The
CLI and Playwright path (tasks 2, 3, 5 and 6) does not wait for stage 1d; the MCP tool (task 4) comes with stage
1d. So stage 3 can bring the first credential to the repo's agent through the CLI, also when stage 1d is not done.

**No safe way on today's path.** Today the daemon runs the Chrome unit, and the relay (the daemon's child) is the
model. A build there would need the act in the relay, a new line from the daemon to the relay, and the pane. That
breaks the daemon lead's first condition (the old path stays unchanged until stage 6), and every part would move
again at the switch. So the first credential waits for stage 3.

## 14. Questions for the operator

Four questions, for one board item. They do not ask again what the token design asks (A: which side keeps the
secrets; B1, B2: the tokens' issue and rotation; C: the entry form; D: the other box). Where a stored sign-in's
files live follows your answer to A.

Until you answer, nothing of this design is built (except task 0, which fixes today's path). If you answer some
questions and leave one open, its no-answer choice holds.

**Q1. What keeps the stored passwords closed when no sign-in runs?**

Context: you asked that agents sign in from usernames and passwords that you store, with no file in an agent's
hands, and with no way for an agent to read a password. The agent browser types the password itself, in a tab
that no agent can reach (the design's section 7). A fact first, in plain words: every agent runs as your OS user,
so it can read every file that your user can read. So only a key that is not in any file keeps an agent's shell
command from reading a stored password.

- **a. A locked store that you unlock (recommended).** Each password is encrypted on disk. Only the agent
  browser's service holds the key to open it, in its memory, after you type the store's passphrase in the Browser
  pane. Other programs of your user cannot read that memory on taylor. An agent's shell command, a backup or a
  copied folder gets only encrypted data. After each restart of the agent browser's service (an update of
  agent-browser, a reboot, a crash), agents cannot sign in until you unlock again; agentwatch sends you one
  notice when an agent waits. During the build months, agent-browser updates come several times a week. A hostile
  program of your user that replaces the agent browser's code could still wait for your next unlock.
- **b. An always-open store.** The passwords are in files of your user (in agentwatch's token store, as the
  per-repo tokens are), and the agent browser opens them at any time. No unlock, no notice. But any agent of your
  user can read every stored password with one shell command, also after a web page's injected instruction, and
  a backup holds them.
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
- **b. Also an agent that holds one today, once, for your approval (recommended).** The agent hands the value to
  the store one way: it can never read it back, and the value never shows on a screen. The Browser pane then
  shows "An agent offered a stored sign-in", with the site and the repo. Nothing uses it until you approve it and
  tick its repos. A change or a removal stays yours alone. This moves today's files out of agents' hands with no
  copy on your screen. An offer gives no agent a new right, because that agent already holds the value.

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
- **The guard** sees four forms of the password and the requests of the act tab only (section 7.6).
- **One tab's storage**: a site that keeps its sign-in in `sessionStorage` gives the agent's tabs nothing
  (section 7.10).
- **The display**: a program of the user that reads the Xvfb display during an act sees the username.
- **Frames and odd forms**: the first build fills only the main frame's form, by the rules of section 7.4.
- **The clean end's leak check** (section 7.8) is designed, not measured.
- **Through the receiver**: the probe used a CDP pipe. The build's live check proves the act, the guard and
  `Page.resetNavigationHistory` through `chrome.debugger`.
- **The Mac**: the store and the act stay off until stage 4 measures section 5.5.
- **First values**: the act's limit (30 s), the settle (1 s), the wait for a busy act (60 s), three failures, the
  scrypt values, the passphrase's 16 characters, the Web Push's one in an hour, the audit's 200 and 20. The build
  measures and records them.
- **Task 0** fixes a gap of today's path that this design found (section 5.5). It needs the lead's own board item.
