# The blanket profile: one session opens any public host, in a Chrome of its own with no cookies

**Status: the design of board task ab-4wh.1 (goal ab-4wh), today's cut for Linux.** aw-lead and ab-lead agreed this cut
on 2026-11-25 at 13:20Z: the operator wants the blanket mode today, on Linux only. The Mac follows later (the Mac: a
second profile with the operator's one Load unpacked). The contract texts (chrome-extension `docs/protocol.md` C4; this
repository's `docs/contracts/C11.md` and `docs/contracts/C12.md`) merge only after aw-lead's explicit OK. The facts
below come from the code at agent-browser main `aacd9bd` and chrome-extension main `9962e11`. Section 13 adds the
Mac's design (board ab-4wh.16, 2026-11-26), from agent-browser main `cfcd86c` and chrome-extension main `4a4eb50`.

## 1. The answer in short

1. **The operator's ask (2026-11-25, through the manager and aw-lead, agentwatch item age-qolw):** "i would do it for a
   session. a blanket approval for a specific session and that session gets its own profile with no cookies."
2. **A second agent Chrome on an empty folder.** The service starts a second agent Chrome from the same Chrome copy,
   with an empty folder as its user-data-dir. The service makes the folder new at the blanket scope's first start,
   keeps it over a stop by use (the session's cookies stay for the session's life), and deletes it at the scope's end,
   at the daemon's `stop`, at `enabled: false` and at the service's start, so a crash leaves nothing. The same display.
   The receiver
   comes by the external extensions file, as in the main Chrome. Its own native link to the service.
3. **The routing.** The blanket scope's CDP (the same endpoint URL, `ws+unix://<socket>:/devtools/browser/<scope>`,
   with the peer check unchanged) and its MCP go to that Chrome only.
4. **Any public host.** The blanket scope's list is `"*"`: the receiver lets its tabs open any `http(s)` host of the
   public host class (no IP literal, no `localhost` or name under it, no single-label name, no name under `.local`,
   `.internal`, `.home.arpa` or `.localdomain`, and none of the box's own names). Chrome's own Local Network Access check covers the subresources.
5. **No import, no sign-in send, no stored sign-in, no card pay and no PageFetch,** each with its own text.
6. **One blanket scope per box; local scopes only.** A second blanket item runs as a normal scope with its repo's list;
   a `remote` item's `blanket` is ignored. `status` says why.
7. **The address proxy (board ab-4wh.6, section 12):** on Linux the blanket Chrome reaches the network only through a
   SOCKS5 proxy of the service that applies PageFetch's address rule, with DNS, to every connection. The Mac: section 13.

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
  Chrome, with no change. Today's cut makes the folder new at each blanket scope's first start, so it needs no wipe
  step.

## 3. Words

- **The shared profile**: today's agent profile, `<state>/profile`. **The main Chrome** and **the main link** are
  today's Chrome and native link on it.
- **The blanket folder**: `<state>/blanket/`, with the user-data-dir `<state>/blanket/profile` and Chrome's `HOME`
  `<state>/blanket/home` (its downloads). **The blanket Chrome** and **the blanket link** are the second Chrome and its
  native link.
- **A blanket item**: an item of C12's `set_sessions` with `"blanket": true`, from the operator's switch.
- **The blanket scope**: the scope of the one blanket item that has the blanket Chrome (section 6).
- **The public host class**: a host name with two labels or more that is no IP literal (IPv4 or IPv6, in each form of
  Chrome's URL parser), not `localhost` and no name under it, and no name under `local`, `internal`, `home.arpa` or `localdomain`,
  and none of the box's own names (C4, `exclude`).

## 4. The parts

### 4.1 The blanket Chrome (board ab-4wh.3)

- **The folder.** At the blanket scope's first start the service deletes `<state>/blanket/` when it is there, and
  makes it new and empty (mode 0700). A start after a stop by use reuses it: the session lives, so its cookies stay
  for the session's life. The service deletes the folder at the scope's end, at the daemon's `stop`, at
  `enabled: false` and at the service's start. So no cookie, storage or worker of a blanket scope reaches the next
  one, also after a crash.
- **The Chrome.** The same Google Chrome copy of the tools folder as the main Chrome, on the unit's Xvfb (the same
  display). The unit keeps Xvfb up while either Chrome runs. The arguments are the main Chrome's (`AGENT_ARGS`,
  `--password-store=basic`, the window, the language and the config's `chrome_args`, with the same refused switches)
  with its own `--user-data-dir`, and the address proxy's flags before `chrome_args` (section 12).
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
  public host class as a main frame, and frames and `<object>`/`<embed>` documents of such a host (the frame rule judges the frame's own
  host, which is stricter than a list's frame rule). A host outside the class stays blocked, as a host off a list.
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
- **The client.** agentwatch's CLI writes `{"allow":["*"]}` into the blanket scope's list copy
  (`<state>/session-lists/<scope>/allowlist.json`), as it writes every list copy on its path, and passes `--allowlist`
  as today. The service writes no list copy for the blanket scope (on the service path it writes every other scope's
  copy at each list change, `src/service/lists/copies.ts`), so it never overwrites the CLI's `"*"`; it still removes
  the scope's folder at the scope's end. agent-browser's client treats `"*"` as every host of the public host class.
- **Prompts.** No list exists to allow a host into, so the service makes no allow prompt from the blanket link.
- **Permissions.** A blanket scope gets no permission grant (the receiver's content settings check reads the lists,
  and the blanket Chrome has none); a later step.
- **Downloads.** As for a local scope. Chrome's own copy lands in the `Downloads` folder of the blanket Chrome's
  `HOME`, which goes with the folder. The MCP's copies stay in `<state>/mcp/<scope>/` and go at the scope's end, as today.
- **The input stage.** The two Chromes share one display, one X pointer and one clipboard. So the blanket model takes
  the same input lock as the main model: a paste's text on the clipboard never meets a key of the other Chrome.

## 5. The texts

| Where | The text |
| --- | --- |
| Layer 1 (CDP error) | `Not allowed: <host> is not a public host name. A session with a blanket approval opens public host names only: no IP address, no localhost, no single-label name, no name under .local, .internal, .home.arpa or .localdomain, and no name of this box.` |
| Each permission grant | `Not available in the agent browser: permission grants in a session with a blanket approval.` |
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
  blanket scope starts only the blanket Chrome. The steps: the new folder (at the scope's first start only); Xvfb when
  it is down; the manifest, the
  wrapper and the Preferences; the Chrome; the receiver's hello on the blanket link (at most 30 s), with the feature
  `blanket`; the `set_scopes` that gives the scope `"*"`; then the scope is ready.
- **The stop.** The blanket Chrome stops by use after the same grace time (`idle_stop_minutes`), and the folder
  stays: the next use starts the blanket Chrome again on it, with the session's cookies. The daemon's `stop` and
  `enabled: false` stop the blanket Chrome and delete the folder.
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
| An earlier blanket scope's data | No | The folder is new at each blanket scope's first start, and it goes at the scope's end, at the daemon's `stop`, at `enabled: false` and at the service's start. |
| The box's local services and the LAN, by an IP literal, a local name or the box's own names (`localhost.localdomain`, the box's full name in `/etc/hosts`) | No | The public host class at the top level (the receiver and layer 1), and Chrome's Local Network Access check for a public page's subresources. |
| The box's local services and the LAN, by a public name that resolves to a private address, or by the box's own public address | No (Linux) | The address proxy checks every address of each connection and connects only to a checked one (section 12). |
| The operator's signed-in sites | Only their public face | No cookies, no import, no sign-in send, no stored sign-in, no card pay. The agent can still sign in with a credential that it has; those cookies go with the folder. |
| PageFetch's and the sign-in act's private windows | No | They run in the main Chrome, and the blanket scope cannot call them. |

The same-uid limit stays: a program of the operator's user can read the files of both profiles on disk. The agent's
shell can reach local services by itself; this guard is about the browser path (a hostile page, or an agent that a
page steers).

## 8. Limits of today's cut, stated plainly

- **A public name that resolves to a private address** passes the host class: the class judges the name, not its
  address. **The DNS-rebinding race**: a name that resolves to a public address first and to a private one later.
  Chrome's Local Network Access check covers a public page's subresources to loopback and private ranges, not a
  top-level navigation, and not every kind of request (a WebSocket, a service worker's request). On Linux the address
  proxy (section 12, board ab-4wh.6) closes these three; its own limits are in section 12.
- One blanket scope per box at a time; local scopes only.
- The blanket Chrome's windows show in the operator's live view with the main Chrome's, and the X pointer is shared.
- The daemon's memory guard does not follow the blanket Chrome's pid: no event names it.

**The next step** was PageFetch's address rule with the model's own `Fetch` in each tab and a receiver floor. Board
ab-4wh.6 chose the address proxy in its place (section 12): it covers more, and it closes the rebinding race.

**Later (the Mac):** a second profile with the operator's one Load unpacked. The Mac's profile keeps the operator's
load, so it needs a wipe in place of a new folder: the receiver removes all browsing data at each session's start and
end, and the service checks its answer. Section 13 (board ab-4wh.16) replaces this plan: a new folder per blanket
scope on the Mac too, with a copy of a template's two preference files that hold the one Load unpacked, and no wipe
(13.4 says why).

## 9. Tests and live checks

- **The contract tests (this task):** `test/contracts-c11.test.ts`, `test/contracts-c12.test.ts` and chrome-extension's
  `test/contracts.test.mjs` check the new texts.
- **T2 (the receiver, 0.3.16):** `"*"` with and without the feature, the public host class (each excluded form: IPv4
  and IPv6 literals, `localhost`, `a.localhost`, a single label, `.local`, `.internal`, `home.arpa`), the frame rule,
  and the shared vectors.
- **T3 (the service):** the new folder, the second manifest and wrapper, the peer check of each link (a shim of the
  wrong Chrome is refused), the one-scope rule, the remote rule, the start and each stop and end, the deletes at the
  service's start, no list copy for the blanket scope (the CLI writes it), status.
- **T4 (the relay):** the routing, layer 1 with the class, the refusals of section 5, and the client's `"*"`.
- **T5, the live checks on the Linux server:** a public site opens; an IP literal, a `.localhost` name and a single
  label are refused; the shared profile's cookies are not in the blanket Chrome; the folder is gone after the end;
  another session of the same repo keeps its list.

## 10. The build split (board goal ab-4wh)

1. **ab-4wh.1** (this task): the design note and the contract texts (C4, C11, C12), merged after aw-lead's OK.
2. **ab-4wh.2**: the receiver: `"*"`, the feature `blanket`, the public host class (release 0.3.16).
3. **ab-4wh.3**: the service's blanket Chrome: the folder, the start and the stop, the second link, one blanket scope
   per box, local scopes only, no list copy for the blanket scope, status.
4. **ab-4wh.4**: the relay: the routing to the blanket link, layer 1 with the class, the refusals.
5. **ab-4wh.5**: the live checks on Linux; the Mac and the next step later.

agentwatch's side (aw-lead) follows these contracts: the switch on `/browser/<session>` (the password login), the
field in `set_sessions`, at most one blanket session per box, local sessions only, the end rule, status, health, the
CLI and the skill text.

## 11. Decisions and open points

The decisions (this task):

- The profile of a link comes from the kernel (the socket and the shim's parent), not from the receiver (4.2).
- No wipe step today: the folder is new at the blanket scope's first start and goes at the scope's end, at the
  daemon's `stop`, at `enabled: false` and at the service's start.
- The start at the first use; the stop by use with the same grace time, with the folder kept for the session (6).
- The list copy: agentwatch's CLI writes `{"allow":["*"]}`; the service writes none for the blanket scope (4.4).
- A second blanket item runs as a normal scope; a remote item's `blanket` is ignored; `status` says why (6).
- The input lock is shared on one display (4.4).

Open points for ab-lead and aw-lead:

- The address rule on every connection: the address proxy on Linux (section 12, board ab-4wh.6); the Mac's part (13).
- The memory guard of the blanket Chrome (an event with its pid).

## 12. The address proxy (board ab-4wh.6, part 1: Linux)

**The decision.** The service runs a small SOCKS5 proxy of its own for the blanket Chrome only, and the blanket Chrome
reaches the network only through it. The proxy applies PageFetch's address rule (`src/service/fetch/address.ts`) to
each connection, with its own lookup, and connects only to an address that it checked. The model's own `Fetch` in each
tab (section 8's earlier "next step") is not built, and no receiver floor is needed.

**Why the proxy, and not a `Fetch` step in each tab.**

1. It covers every connection of the blanket Chrome's network stack: each request of a tab, a frame, a dedicated,
   shared or service worker, each WebSocket, WebRTC's TCP sockets, the receiver's own requests and Chrome's own
   traffic. CDP's `Fetch` pauses no WebSocket and no WebTransport, and a service worker or a shared worker is not
   always a child of the tab (C11, PageFetch's stated limits); Chrome's own traffic reaches no session at all.
2. It closes the rebinding race. With `Fetch`, Chrome resolves the name again after the service's check. The proxy
   resolves the name once and connects to that checked address.
3. It touches no CDP: no `Fetch.enable` next to a client's own `Fetch` (a Playwright route) and the merge guard's
   lines of the model, no pause of each request on the link.
4. It fails closed. The flags name one proxy and no `direct://`: when the proxy is down, every request fails.
5. The same flags work on the Mac (part 2).

**The Chrome facts (Chromium's source and `net/docs/proxy.md`, read 2026-11-26).**

- With a `socks5://` proxy Chrome always resolves the target's name at the proxy: its SOCKS5 client sends the host as
  a domain name (address type 3), also for an IP literal (`net/socket/socks5_client_socket.cc`). It offers only "no
  authentication" (`05 01 00`), so a per-start secret cannot go to the proxy. The proxy admits only a client of the
  service's uid, by its line of `/proc/net/tcp` (as the MCP port's step 1). A Unix socket is no proxy of Chrome.
- The implicit bypass rules send `localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`, `169.254.0.0/16`, `[fe80::]/10`,
  `0.0.0.0` and `[::]` direct. `--proxy-bypass-list=<-loopback>` subtracts them, so they go through the proxy too.
- Proxy fallback goes only to the next entry of the proxy list. A refusal of the proxy is
  `net::ERR_SOCKS_CONNECTION_FAILED`, with no next entry: no direct request follows.
- `--no-proxy-server`, `--proxy-pac-url` and `--proxy-auto-detect` win over `--proxy-server`
  (`chrome_command_line_pref_store.cc`). So the service puts its flags before the config's `chrome_args` (a `--` there
  ends Chrome's switches), and a blanket start fails when `chrome_args` holds `--no-proxy-server`, `--proxy-server`,
  `--proxy-pac-url`, `--proxy-auto-detect`, `--proxy-bypass-list` or `--webrtc-ip-handling-policy`, or
  `--load-extension` or `--disable-extensions-except` (Chromium loads an unpacked extension from both, and its `proxy`
  permission would win over the command line; Google Chrome ignores both, and the blanket Chrome's receiver comes from
  the external extensions file). The main Chrome keeps its `chrome_args` as today. With `chrome_bin` set to Chromium and
  the receiver through `--load-extension` (the way back), every blanket start fails with this reason (fail closed).
- QUIC is never spoken to a SOCKS proxy (`ERR_NO_SUPPORTED_PROXIES`; the job falls back to TCP through the proxy).
  WebTransport over HTTP/3 fails with any proxy (`ERR_TUNNEL_CONNECTION_FAILED`). `--disable-quic` is defence in depth.
- WebRTC: Chrome reads `--webrtc-ip-handling-policy` (the pref `webrtc.ip_handling_policy`; the switch
  `--force-webrtc-ip-handling-policy` is content_shell's only). `disable_non_proxied_udp` turns off UDP, STUN and UDP
  relays; WebRTC's TCP sockets go through the proxy (`services/network/p2p/socket_tcp.cc`).
- Chrome's Local Network Access check gives a proxied response the address space `unknown`, which it treats as public.
  So the check no longer sees a name's private address; the proxy refuses that connection before. The check by the URL
  (an IP literal, `.local`, `localhost`) stays.
- The command line's proxy applies to the profile and to Local State, so Chrome's own traffic (updates, Safe Browsing,
  push) goes through the proxy too. Only an enterprise policy or an extension with the `proxy` permission would win
  over it; the box has no policy file, and the receiver has no `proxy` or `privacy` permission.

**The proxy (`src/service/blanket/proxy.ts`).** It listens on `127.0.0.1`, on a port that the kernel picks, from right
before the blanket Chrome's start until its stop, its end or a failed start, and at most 2 s after the Chrome exits by
itself. It admits only a client of the service's uid. It takes only `CONNECT` with the method "no authentication":
`BIND`, `UDP ASSOCIATE` and an unknown command get `07`, an unknown address type `08`, another version in the request,
a reserved byte that is not 0, an empty or unprintable host or port 0 `01`, a method list without "no authentication" `FF`, another SOCKS version in
the greeting no reply; each closes. The host: an IP literal by its range; a name by
its name, then by every address of the box's resolver (one refused address refuses it; no address refuses it); and no
address of the box's own interfaces, read at each connection (this box has a public address on `eth0`, so the box's
services on `0.0.0.0` must not be reachable by it). It connects only to the checked addresses, in the resolver's order.
A refusal answers `02` (not allowed by the rule set), and the log gets one line with the kind of host and the reason,
with no host, no address, no path and no query (at most 20 lines in 10 s, then one line with the count). A client
cannot give a browser context a proxy of its own: the model refuses `Target.createBrowserContext` and the `Extensions`
domain (C11's refusals).

**The limits** (so that no page stops the service or the main Chrome): at most 256 client connections (Chrome's own
limit per proxy is 128 sockets and 128 more for WebSockets; one more closes at once); the greeting and the request
within 10 s and 600 bytes; at most 2 lookups at a time (the resolver shares libuv's small pool with the service) and at
most 64 that wait (one more is refused at once; a waiting lookup whose connections gave up starts none; a stop drops the
waiting ones), and a connection whose lookup gives no answer in 10 s is refused; the connect within 15 s, else the
reply `04`; a name's checked addresses kept 60 s (Chrome's own host cache time); after the reply the two sockets are
piped, with their back pressure; when one side has ended, the other must end within 30 s, else both close (an upstream
that ignores the FIN would hold a slot); an open pair has no idle limit, so a quiet WebSocket stays.

**The address rule** gained, for the proxy and for PageFetch (the review of board ab-4wh.6): a 6to4 address
(`2002::/16`) by its IPv4 address, Teredo (`2001::/32`) and local-use NAT64 (`64:ff9b:1::/48`) as a whole, and no
IPv4 address with a zone.

**The flags of the blanket Chrome** (before the config's `chrome_args`):
`--proxy-server=socks5://127.0.0.1:<port>`, `--proxy-bypass-list=<-loopback>`,
`--webrtc-ip-handling-policy=disable_non_proxied_udp`, `--disable-quic`. The main Chrome's argv stays the same.

**What a page can see.** A refused connection is a network error, as a refusal of Local Network Access is. Three more
differences come with the proxy: no HTTP/3 (`nextHopProtocol` is never `h3`), no WebTransport over HTTP/3, and no
WebRTC UDP candidates (only TCP through a TURN server). A bot check can read them.

**What stays open.**

- Chrome's Cast discovery (SSDP and mDNS multicast, and DIAL's fetch of a device's description with
  `LOAD_BYPASS_PROXY`) and Chrome's DNS-over-HTTPS requests bypass the proxy. A page does not choose their addresses.
  The policy `EnableMediaRouter: false` stops the first; not in this cut.
- Chrome's own lookups (a page's `dns-prefetch`) still reach the box's resolver. They open no connection.
- A process of the operator's uid can use the proxy. It gains nothing: it reaches the network and the box by itself
  (section 7's same-uid limit).
- After a crash of the service (SIGKILL, the out-of-memory killer), agentwatch runs
  `agent-browser service stop --blanket` (board ab-4wh.17; C12): the unit's `ExecStopPost` on Linux, and the daemon
  after a door drop that it did not ask for. It stops the blanket Chrome (the unit has `KillMode=process`) and deletes
  its folder, unless a service runs on the state folder or it cannot tell (then the service's next start stops it).
  Open: the time to that run and up to 7 s of its stop, with no listener on the proxy's port: each request fails,
  unless another process, also of another uid, listens there first and gets the blanket Chrome's connections.
- The Mac (part 2): the same proxy and flags; the peer check reads the Mac's TCP table (`src/service/mac.ts`); the
  blanket profile must be its own Chrome process, because the proxy flags hold for every profile of one process (13).
- PageFetch's address rule does not refuse the box's own public address (the proxy does); a later task.

## 13. The Mac (board ab-4wh.16)

**The design check of board ab-4wh.16 (2026-11-26), no code yet.** The full text, with the Chromium facts and their
files, the Mac measurements M1 to M5, the old and new contract texts and the build, is the companion note
`docs/superpowers/specs/2026-11-26-blanket-profile-mac-design.md` (its 13.1 to 13.10).

1. **A new folder per blanket scope, as on Linux.** Google Chrome on the Mac loads the receiver only by a person's
   Load unpacked: it ignores `--load-extension`, it deletes a CDP load at its next start, and it turns off a packed CRX
   from outside the Chrome Web Store. So the operator loads it once into a **blanket template** (the op
   `blanket_setup`; the status key `blanket_template`), whose set-up Chrome's proxy passes no request. Each blanket folder
   starts with a copy of the template's `Default/Preferences` and `Default/Secure Preferences`: their MACs cover the
   machine's id, a key's name and its value, not the folder's path, so a copy keeps the load (M2 measures it).
2. **No wipe.** `chrome.browsingData` misses site settings, engagement, Private State Tokens and the Privacy Sandbox's
   storage, a crash leaves data on disk until the next wipe, and the op would sit in the package that the shared
   profile runs too. No receiver change and no release.
3. **Its own Chrome process:** `open -n -g` of the operator's `Google Chrome.app` on `<state>/blanket/profile`, held by
   pid and start time as the agent Chrome there. The service checks that its arguments hold this start's proxy flags.
4. **The same address proxy.** Its Mac peer check reads only the blanket Chrome's own sockets (an exact match of both
   addresses and ports, the holders' real uid). The Mac's system proxy and PAC do not apply. Cast discovery and the
   home router's public address (hairpin NAT) stay open.
