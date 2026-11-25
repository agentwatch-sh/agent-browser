# The blanket profile: one session opens any public host, in a Chrome of its own with no cookies

**Status: the design of board task ab-4wh.1 (goal ab-4wh), today's cut for Linux.** aw-lead and ab-lead agreed this cut
on 2026-11-25 at 13:20Z: the operator wants the blanket mode today, on Linux only. The Mac follows later (the Mac: a
second profile with the operator's one Load unpacked). The contract texts (chrome-extension `docs/protocol.md` C4; this
repository's `docs/contracts/C11.md` and `docs/contracts/C12.md`) merge only after aw-lead's explicit OK. The facts
below come from the code at agent-browser main `aacd9bd` and chrome-extension main `9962e11`.

## 1. The answer in short

1. **The operator's ask (2026-11-25, through the manager and aw-lead, agentwatch item age-qolw):** "i would do it for a
   session. a blanket approval for a specific session and that session gets its own profile with no cookies."
2. **A second agent Chrome on an empty folder.** The service starts a second agent Chrome from the same Chrome copy,
   with an empty folder as its user-data-dir. The service makes the folder new at each start of that Chrome, and
   deletes it at the scope's end and at the service's start, so a crash leaves nothing. The same display. The receiver
   comes by the external extensions file, as in the main Chrome. Its own native link to the service.
3. **The routing.** The blanket scope's CDP (the same endpoint URL, `ws+unix://<socket>:/devtools/browser/<scope>`,
   with the peer check unchanged) and its MCP go to that Chrome only.
4. **Any public host.** The blanket scope's list is `"*"`: the receiver lets its tabs open any `http(s)` host of the
   public host class (no IP literal, no `localhost` or name under it, no single-label name, no name under `.local`,
   `.internal` or `.home.arpa`). Chrome's own Local Network Access check covers the subresources.
5. **No import, no sign-in send, no stored sign-in, no card pay and no PageFetch,** each with its own text.
6. **One blanket scope per box; local scopes only.** A second blanket item runs as a normal scope with its repo's list;
   a `remote` item's `blanket` is ignored. `status` says why.
7. **The next step (with the Mac):** PageFetch's address rule, with DNS, on every request of the scope.

## 2. The ask, the choice, and why

The fixed rules, from the ask:

- **R1.** A blanket session gets no cookie, storage, worker or sign-in of the shared profile, of another session or of
  an earlier blanket session.
- **R2.** It opens public hosts only: never the box itself or a private network (today with the known limits of
  section 8).
- **R3.** No import, no sign-in send, no stored sign-in, no card pay, no PageFetch.
- **R4.** The other sessions keep their lists and the shared profile, with no change.
- **R5.** The mode ends with the session, and its data goes then.

Three ways were considered (ab-lead's proposal, with aw-lead's OK of the choice, mail m508d4f8):

- **A CDP browser context: not possible.** The agent Chrome never runs with `--remote-debugging-*` (`src/agent.ts`: the
  switch makes `navigator.webdriver` true, and bot checks then block every page). So the service has no browser-level
  CDP. Its CDP goes through the receiver's `chrome.debugger`, which attaches to tabs, not to the browser target that
  owns browser contexts, and the relay refuses `Target.createBrowserContext` (`src/relay/policy.ts`, line 132).
- **An incognito window: not chosen.** All incognito windows of one Chrome share one cookie jar. PageFetch's window and
  the sign-in act's window are incognito windows of the agent Chrome, and one lock in the service already lets only one
  of them exist at a time (`src/service/fetch/lock.ts`). To keep a sign-in act's new cookies away from a blanket
  session, that session would hold the lock for its whole life: PageFetch and every sign-in act of the box would wait
  for hours.
- **A second agent Chrome on its own user-data-dir: the choice.** PageFetch and the sign-in acts stay in the main
  Chrome, with no change. Today's cut makes the folder new at each start, so it needs no wipe step.

## 3. Words

- **The shared profile**: today's agent profile, `<state>/profile`. **The main Chrome** and **the main link** are
  today's Chrome and native link on it.
- **The blanket folder**: `<state>/blanket/`, with the user-data-dir `<state>/blanket/profile` and Chrome's `HOME`
  `<state>/blanket/home` (its downloads). **The blanket Chrome** and **the blanket link** are the second Chrome and its
  native link.
- **A blanket item**: an item of C12's `set_sessions` with `"blanket": true`, from the operator's switch.
- **The blanket scope**: the scope of the one blanket item that has the blanket Chrome (section 6).
- **The public host class**: a host name with two labels or more that is no IP literal (IPv4 or IPv6, in each form of
  Chrome's URL parser), not `localhost` and no name under it, and no name under `local`, `internal` or `home.arpa` (C4).

## 4. The parts

### 4.1 The blanket Chrome (board ab-4wh.3)

- **The folder.** At each start the service deletes `<state>/blanket/` when it is there, and makes it new and empty
  (mode 0700). It deletes it again at the scope's end, at each stop of the blanket Chrome, and at the service's start.
  So no cookie, storage or worker of a run reaches the next run, also after a crash.
- **The Chrome.** The same Google Chrome copy of the tools folder as the main Chrome, on the unit's Xvfb (the same
  display). The unit keeps Xvfb up while either Chrome runs. The arguments are the main Chrome's (`AGENT_ARGS`,
  `--password-store=basic`, the window, the language and the config's `chrome_args`, with the same refused switches)
  with its own `--user-data-dir`.
- **The receiver.** Chrome's external extensions file next to the copy's binary (`src/service/package/crx.ts`)
  installs the receiver in every profile of that copy, so the empty profile gets it at its first start, with no hand
  step. The service writes the Preferences before the start, as for the shared profile: the downloads folder, no
  password saving, no leak check, no autofill, and the receiver's access to local files.
- **The process.** The service holds the blanket Chrome by pid and start time in memory. It adopts none: at its own
  start it stops each Chrome on the blanket profile (the unit's sweep by `--user-data-dir`) and deletes the folder. No
  supervisor restarts a blanket Chrome after a crash: the session's next use starts a new one. A move of Google Chrome
  to a new copy waits until no blanket Chrome runs. The fail-closed watch applies to it as to the main Chrome.

### 4.2 The second link: how the service knows the profile (board ab-4wh.3)

Today the service writes the host manifest of `sh.agentwatch.browser` into `<profile>/NativeMessagingHosts/`
(`src/service/link/manifest.ts`). The manifest names the wrapper `<state>/agent-browser-host`, which puts the link
socket and the agent profile into the shim's environment. The shim connects only when its parent runs Chrome on that
profile (`src/service/link/host.ts`). The link's peer check admits only a shim whose parent is the service's Chrome by
pid and start time, on the agent profile (`src/service/link/peer.ts`). Chrome reads a user-level native host's manifest
from `NativeMessagingHosts/` in the user-data-dir that it runs (the service relies on it today), so each profile can
name its own host.

The decision:

- Before each start the service writes a manifest with the same host name into
  `<state>/blanket/profile/NativeMessagingHosts/`. It names a wrapper of its own, `<state>/agent-browser-host-blanket`,
  which gives the shim the socket `link-blanket.sock` (in the folder of `link.sock`, mode 0600) and the blanket profile.
- The blanket link admits only a shim whose parent is the blanket Chrome, by pid and start time, on the blanket
  profile. The main link admits only the main Chrome's shim.
- So the service learns the profile of a link from facts of the kernel: the socket that the shim reached, and the pid,
  the start time and the `--user-data-dir` of the shim's parent. No claim of the receiver takes part. The receiver
  does not know which profile it runs in: it gets `"*"` only on the blanket link.

### 4.3 The receiver (board ab-4wh.2; C4; release 0.3.16)

- **`set_scopes`.** A scope's value may be `"*"`, only to a receiver whose hello has the new feature `blanket`. The
  service sends `"*"` only on the blanket link. The receiver then lets that scope's tabs load any `http(s)` host of the
  public host class as a main frame, and frames and `<object>`/`<embed>` documents under such a page, as a list's frame
  rule does. A host outside the class stays blocked, as a host off a list.
- An older receiver applies `"*"` as `null` (it is no valid list name): the scope has no list, and it fails closed.
- Today's lists cannot say "any host": an entry needs two labels, and `"*"` exists only for the operator's marked tabs
  (rule 8).

### 4.4 The relay's routing (board ab-4wh.4; C11)

- The service runs a second model (the relay's code) whose bridge goes on the blanket link, with its own carrier, tab
  map and readiness. The door routes by scope: the blanket scope's upgrade of `/devtools/browser/<scope>` and its MCP
  ticket connection go to that model, and every other scope goes to the main model. The blanket model's allowlist line
  names only the blanket scope, with `"*"`; the main model's line leaves it out.
- The scope sees only the blanket Chrome's tabs, windows, targets, downloads and events.
- The peer check, the walk, the token check and the MCP path's admission stay as they are.
- **Layer 1** of the model applies the public host class in place of a list: a client's call that loads a URL whose
  host is outside the class gets its text (section 5).
- **Every refusal of C11 stays,** `Target.createBrowserContext` too. No method opens.
- **The client.** The service writes `{"allow":["*"]}` into the blanket scope's list copy
  (`<state>/session-lists/<scope>/allowlist.json`). agent-browser's client treats `"*"` as every host of the public
  host class. agentwatch passes the same `--allowlist` path as today.
- **Prompts.** No list exists to allow a host into, so the service makes no allow prompt from the blanket link.
- **Permissions.** A grant needs an origin whose host is of the class; a grant with no origin is refused.
- **Downloads.** As for a local scope. Chrome's own copy lands in the `Downloads` folder of the blanket Chrome's
  `HOME`, which goes with the folder. The MCP's copies stay in `<state>/mcp/<scope>/` and go at the scope's end, as today.
- **The input stage.** The two Chromes share one display, one X pointer and one clipboard. So the blanket model takes
  the same input lock as the main model: a paste's text on the clipboard never meets a key of the other Chrome.

## 5. The texts

| Where | The text |
| --- | --- |
| Layer 1 (CDP error) | `Not allowed: <host> is not a public host name. A session with a blanket approval opens public host names only: no IP address, no localhost, no single-label name, and no name under .local, .internal or .home.arpa.` |
| `Browser.grantPermissions` with no origin | `Not available in the agent browser: a grant with no origin (Browser.grantPermissions) in a session with a blanket approval.` |
| PageFetch (tool error) | `Not fetched (unavailable): PageFetch does not work for a session with a blanket approval; open the page in this session's browser instead.` |
| Stored sign-ins: `browser_sign_in`, `browser_sign_ins` (tool error) | `Not signed in: Stored sign-ins do not work for a session with a blanket approval.` |
| Stored sign-ins: `AgentBrowser.signIn`, `AgentBrowser.signIns` (CDP error) | `Stored sign-ins do not work for a session with a blanket approval.` |
| Card pay: `browser_pay`, `browser_pay_status` (tool error) | `Not paid: Payments do not work for a session with a blanket approval.` |
| The blanket Chrome is not ready (503) | `The agent browser is not ready: the blanket profile's extension is not connected.` |
| The blanket Chrome's receiver has no feature `blanket` (503) | `The agent browser is not ready: the blanket profile's extension is too old for the blanket profile.` |

A failed start of the blanket Chrome gives the start at a use's 503 (C12): `The agent browser could not get ready: <reason>.`
A `tools/list` of a blanket scope holds none of the five service tools; a call of one gets its text
above. The import and the sign-in send: C12's `import` names no scope, and the service sends it only on the main link;
the sign-in act's move runs only in the main Chrome. So no import reaches the blanket Chrome.

## 6. Start, stop and the end (board ab-4wh.3; C12)

- **The feature.** The service's hello has the feature `blanket_scope`. agentwatch sends `"blanket": true` only to a
  service with it.
- **One blanket scope per box.** The blanket scope of the last `set_sessions` keeps the blanket Chrome. Each other
  blanket item runs as a normal scope with its repo's list in the shared profile, and `status` says why. When no item
  had it, the first blanket item in the order of `sessions` gets it.
- **Local scopes only.** A `remote` item's `blanket` is ignored: the remote scope runs as today with its own list, and
  `status` says why.
- **The start: at the blanket scope's first use,** as the start at a use (C12), not at the switch. A use of the
  blanket scope starts only the blanket Chrome. The steps: the new folder; Xvfb when it is down; the manifest, the
  wrapper and the Preferences; the Chrome; the receiver's hello on the blanket link (at most 30 s), with the feature
  `blanket`; the `set_scopes` that gives the scope `"*"`; then the scope is ready.
- **The stop.** The blanket Chrome stops by use after the same grace time (`idle_stop_minutes`), at the daemon's
  `stop` and at `enabled: false`. Each stop deletes the folder, so the next use starts on a new, empty one: the
  session's cookies do not survive a stop.
- **The end.** The scope leaves `set_sessions`, its item loses `"blanket": true`, or `session_ended` comes: the service
  closes the scope's connections and MCP sessions of the blanket Chrome, stops that Chrome, and deletes the folder.
- **The switch on during a session.** The main `set_scopes` leaves the scope out (the sweep closes its tabs in the
  shared profile), and its next use goes to the blanket Chrome. **The switch off:** the end's steps, then the scope
  gets its repo's list in the shared profile.
- **No event.** The blanket Chrome sends no `ready`, `stopped` or `chrome` event: those stay the main Chrome's.
- **Status.** Each item of `status`'s `sessions` gets `"blanket"`: `true` for the blanket scope, else `false`. The
  blanket scope's item also gets `"blanket_state"`: `starting`, `ready`, `stopped` or `failed`. `operator_text` gets a
  sentence for a failed start, for a second blanket item and for a remote item's `blanket`.

## 7. The threat model

| What | Can a blanket session reach it? | Why |
| --- | --- | --- |
| The shared profile's cookies | No | Another user-data-dir and another Chrome process. The model refuses `file:` URLs, and a file input from the state folder. |
| The shared profile's storage (`localStorage`, IndexedDB, caches) | No | The same. |
| The shared profile's service workers | No | Workers belong to a profile. |
| The receiver's state in the shared profile (tab map, rules, lists) | No | The blanket Chrome's receiver is another instance with its own storage. Its link goes to its own socket, and the main link's peer check refuses a shim of the blanket Chrome. |
| Other scopes' tabs | No | They live in the main Chrome. The door routes the blanket scope only to the blanket model. |
| An earlier blanket run's data | No | The folder is new at each start and goes at each stop and at the scope's end. |
| The box's local services and the LAN, by an IP literal or a local name | No | The public host class at the top level (the receiver and layer 1), and Chrome's Local Network Access check for a public page's subresources. |
| The box's local services and the LAN, by a public name that resolves to a private address | Yes, today | A known limit (section 8). The next step closes it. |
| The operator's signed-in sites | Only their public face | No cookies, no import, no sign-in send, no stored sign-in, no card pay. The agent can still sign in with a credential that it has; those cookies go with the folder. |
| PageFetch's and the sign-in act's private windows | No | They run in the main Chrome, and the blanket scope cannot call them. |

The same-uid limit stays: a program of the operator's user can read the files of both profiles on disk. The agent's
shell can reach local services by itself; this guard is about the browser path (a hostile page, or an agent that a
page steers).

## 8. Limits of today's cut, stated plainly

- **A public name that resolves to a private address** passes the host class: the class judges the name, not its
  address. A top-level navigation to such a name loads.
- **The DNS-rebinding race**: a name that resolves to a public address first and to a private one later passes too.
- Chrome's Local Network Access check covers a public page's subresources to loopback and private ranges, not a
  top-level navigation, and not every kind of request (a WebSocket, a service worker's request).
- One blanket scope per box at a time; local scopes only.
- The session's data does not survive a stop by use.
- The blanket Chrome's windows show in the operator's live view with the main Chrome's, and the X pointer is shared.
- The daemon's memory guard does not follow the blanket Chrome's pid: no event names it.

**The next step (with the Mac):** PageFetch's address rule (`src/service/fetch/address.ts`), with DNS, on every
request of the scope's tabs, frames and workers: the model's own `Fetch` in each tab, as PageFetch's fetch window and the
merge guard do, and a receiver floor for the requests that no session sees. It closes the first limit, and it narrows
the second one to the time between the service's lookup and Chrome's.

**Later (the Mac):** a second profile with the operator's one Load unpacked. The Mac's profile keeps the operator's
load, so it needs a wipe in place of a new folder: the receiver removes all browsing data at each session's start and
end, and the service checks its answer.

## 9. Tests and live checks

- **The contract tests (this task):** `test/contracts-c11.test.ts`, `test/contracts-c12.test.ts` and chrome-extension's
  `test/contracts.test.mjs` check the new texts.
- **T2 (the receiver, 0.3.16):** `"*"` with and without the feature, the public host class (each excluded form: IPv4
  and IPv6 literals, `localhost`, `a.localhost`, a single label, `.local`, `.internal`, `home.arpa`), the frame rule,
  and the shared vectors.
- **T3 (the service):** the new folder, the second manifest and wrapper, the peer check of each link (a shim of the
  wrong Chrome is refused), the one-scope rule, the remote rule, the start and each stop and end, the deletes at the
  service's start, the list copy `{"allow":["*"]}`, status.
- **T4 (the relay):** the routing, layer 1 with the class, the refusals of section 5, and the client's `"*"`.
- **T5, the live checks on the Linux server:** a public site opens; an IP literal, a `.localhost` name and a single
  label are refused; the shared profile's cookies are not in the blanket Chrome; the folder is gone after the end;
  another session of the same repo keeps its list.

## 10. The build split (board goal ab-4wh)

1. **ab-4wh.1** (this task): the design note and the contract texts (C4, C11, C12), merged after aw-lead's OK.
2. **ab-4wh.2**: the receiver: `"*"`, the feature `blanket`, the public host class (release 0.3.16).
3. **ab-4wh.3**: the service's blanket Chrome: the folder, the start and the stop, the second link, one blanket scope
   per box, local scopes only, the list copy, status.
4. **ab-4wh.4**: the relay: the routing to the blanket link, layer 1 with the class, the refusals.
5. **ab-4wh.5**: the live checks on Linux; the Mac and the next step later.

agentwatch's side (aw-lead) follows these contracts: the switch on `/browser/<session>` (the password login), the
field in `set_sessions`, at most one blanket session per box, local sessions only, the end rule, status, health, the
CLI and the skill text.

## 11. Decisions and open points

The decisions (this task):

- The profile of a link comes from the kernel (the socket and the shim's parent), not from the receiver (4.2).
- No wipe step today: the folder is new at each start and goes at each stop, at the end and at the service's start.
- The start at the first use; the stop by use with the same grace time, with the folder deleted (6).
- A second blanket item runs as a normal scope; a remote item's `blanket` is ignored; `status` says why (6).
- The input lock is shared on one display (4.4).

Open points for ab-lead and aw-lead:

- Whether the operator wants the session's data kept over a stop by use (today each stop deletes it).
- The next step: PageFetch's address rule with DNS on every request, and WebSockets in it.
- The memory guard of the blanket Chrome (an event with its pid).
