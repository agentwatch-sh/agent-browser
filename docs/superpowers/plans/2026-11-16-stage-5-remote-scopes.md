# Stage 5, agent-browser's side: remote scopes for another box (plan)

Board task: ab-v16.94.7 (P2). It pairs with agentwatch's stage 5 task (age-q8t.5, which the daemon lead corrects to the
direct HTTPS path). The live part waits for stage 4 (ab-v16.94.6) and for agentwatch's gateway.

> For the builders: one task is one PR, one builder and one review. Write the tests that fail first, then the code.
> Each task's contract texts go to the daemon lead first: a C11 or C12 change merges only after the daemon lead's OK.

**The goal** (the self-contained design, section 9; the token design, sections 10 and 11). A session on the Linux server
uses the agent browser on the operator's Mac. The Mac opens no port. The session's client calls
`https://<label>.agentwatch.sh/mcp/<box>/<session>` with its remote token. Cloudflare's tunnel brings the request to the
Mac's gateway (agentwatch). The gateway checks the route and the address, and passes the request, unread, to the Mac
service's agent door. agent-browser builds the service's side: the carrier's identity, the remote admission, the limits of
a remote scope, and the scope pattern `<box>/<session>`.

**Words.** *Remote scope*: `<box>/<session>`, for example `linux/web-1`. *Carrier*: the Mac's gateway, the one peer of
the agent door that may name a remote scope. *Remote admission*: the transport's word `remote`.

## 1. What exists, and what is missing

What exists (main at `20c980e`):

- The admission word. The transport takes only `local` as a local admission; no word is remote
  (`src/service/mcp/transport.ts:273-274`; `src/service/mcp/port.ts:50-52`; `src/relay/model.ts:167-170`).
- The limits of a remote admission that exist: the sign-in tools are absent from `tools/list` and refused at check 1
  (`transport.ts:347-353`, `transport.ts:452`; `src/service/mcp/allow-list.ts:280-285`); PageFetch is refused
  (`transport.ts:466`; C11 lines 2945-2948).
- The stand-in. `--test-mcp-remote-scope <scope>` gives each request of one local scope on the MCP TCP port the word
  `remote`; steps 1 to 8 still run (`src/service/main.ts:99-113`, `main.ts:172-173`, `main.ts:222`, `main.ts:240`;
  `port.ts:93-96`, `port.ts:281`; C11 lines 3269-3273).
- `set_sessions` takes `remote` items `{"scope","box","list","mcp_token"}` with no pattern
  (`src/service/control.ts:98`; once rules at `control.ts:116-125`; C12 lines 167-181, 242, 504-505). The service keeps
  only their names, for the Mac's case rule and the MCP folders (`src/service/service.ts:268-274`;
  `src/service/mcp/part.ts:106`).
- The control door's peer rules 1 to 4 for a launchd job or a systemd unit with a command file
  (`src/service/admission.ts:165`, `admission.ts:237`). The carrier's rule can reuse them.
- The token check of the local port: SHA-256 of the bearer against the item's `mcp_token`, in constant time
  (`src/service/mcp/admission.ts:163-169`).

What is missing:

- A remote scope pattern. `SCOPE` is local only (`src/relay/scopes.ts:10`), and about 20 files test names with it.
- The carrier. The agent door has no carrier rule, and it answers each plain HTTP request with the 404
  (`src/relay/endpoint.ts:141-146`; C11 lines 2384-2385).
- A remote scope in the service: the MCP snapshot reads `sessions` only (`port.ts:315`); the scope book reads sessions
  only (`src/service/lists/scopes.ts:131`); the endpoint's path takes no `/` (`endpoint.ts:99-100`), so the MCP's own
  CDP connection with its ticket cannot reach a remote scope.
- The limits that are not built: every path argument refused (today a path inside the scope's folder passes:
  `allow-list.ts:234-258`); the 16 MiB answer limit; a remote scope's folder (`scopeFolder` joins the scope into the
  path: `transport.ts:209`, `transport.ts:223`).
- The receiver's pattern (chrome-extension `agent/scopes.js:8`).

## 2. The interface with agentwatch

### 2.1 Agreed with the daemon lead, 2026-11-16

- **A1. The carrier is the Mac's gateway** (not the daemon, not the MCP TCP port). The gateway is a plain HTTP reverse
  proxy onto the service's agent door Unix socket: streaming, the body unread, no redirect followed. It forwards the path
  `/mcp/<box>/<session>` and the `Authorization` header, and it drops the client's other headers (no `Cookie`, no
  `Origin`, no `CF-*`, no `X-Forwarded-*`). The path is the only claim: the gateway's address check tied its box to the
  caller's address. The service checks SHA-256 of the bearer against that remote item's `mcp_token`.
- **A2. The peer decides remote or local, never the request.** On the Mac the gateway runs as the logged-in user under its
  own launchd job. The carrier is that job's pid (`LOCAL_PEERPID`), or its direct child with the gateway's command line.
  A carrier connection may name only a remote scope of the last `set_sessions`, only on the MCP path, with the token
  match at each request. Every other peer is local and needs the walk; the carrier never gets a local scope. A Linux
  serving box (the gateway's systemd MainPID) comes later. The gateway's launchd label and plist path come from the daemon
  lead when the build needs them.
- **A3. The split of the texts.** agent-browser owns and writes the C11 and C12 texts of the remote scope in the model,
  the carrier's identity, the MCP path only, no path argument, the remote downloads, the 16 MiB refusal and the token
  step for a remote scope. agentwatch proposes, and agent-browser places, the sender's texts: the remote item
  `{"scope":"<box>/<session>","box","list","mcp_token":"<64 hex>"}` (its box from the link's peer identity; at most 64 for
  each box; each fingerprint once across boxes and local sessions), and the remote token: the `abt1_` form of the local
  token, minted by the calling daemon at the session's start, never on the link.
- **A4. agentwatch's side comes later** (after its current release; the heartbeat must report both address families). So
  each task here builds and tests with a fake carrier, behind a switch that stays off or the test stand-in.

### 2.2 The questions, answered by the daemon lead (2026-11-16)

The daemon lead read the plan whole against the split (A1 to A4 as agreed) and answered each question below: each
proposal is agreed, with the changes named here. Q1: the gateway forwards the method, the path, `Authorization`,
`Mcp-Session-Id`, `Content-Type` and the body framing, sends `Host: localhost`, and gives back the status,
`Content-Type`, `Mcp-Session-Id`, `WWW-Authenticate` and the body, streamed (no buffering of an SSE answer, no answer cap
below the service's 16 MiB plus framing); `Accept` and `MCP-Protocol-Version` stay out (the transport reads neither; if a
later transport reads one, the C11 text and the gateway's list change first). Q3: one list per grant (one per calling
box), its name in C4's list-name pattern, chosen by agentwatch apart from every repo list's name. Q4: agentwatch's
service unit passes `--gateway-label` and `--gateway-command` only when stage 5 is on; missing or wrong means no carrier
(fail closed). Q6: a request (or an SSE answer) that already runs finishes. Q7: also the 15-minute fail-closed drop and
the grant's end end a remote scope by its drop from `set_sessions`. The 16-of-32 limit: agreed; the 17th remote
session gets a clear tool error that names the limit and says to try again later, not a 503. The change to T4 check 1
is below (a GET by the carrier gets the local transport's 405).

The questions as asked, with their proposals:

- **Q1. The headers through the gateway.** A1 forwards only the path and `Authorization`. The transport also needs
  `Mcp-Session-Id` in each request after `initialize` and in the answer to it (`transport.ts:282`, `transport.ts:550`),
  and HTTP needs the method and the body's framing. *Proposal*: the gateway forwards the method, the path,
  `Authorization`, `Mcp-Session-Id`, `Content-Type` and `Content-Length` or `Transfer-Encoding`; it sends its own `Host`;
  it gives back the status, `Content-Type`, `Mcp-Session-Id`, `WWW-Authenticate` and the body. It drops all else.
- **Q2. The `Host` on the agent door.** *Proposal*: the gateway sends `Host: localhost`, and the service takes exactly
  that one `Host` line on the carrier's path.
- **Q3. What `list` of a remote item names.** *Proposal*: the name of a list file in the Mac's lists folder (C4's list
  name pattern, no `/`), the one list of the grant, which the Mac's Browser pane writes. The service reads it as it reads
  a repo's list. A remote item never gets a repo's list.
- **Q4. How the service learns the carrier.** *Proposal*: agentwatch's install gives the service
  `--gateway-label <label>` and `--gateway-command <file>`; the file has the form of `daemon-command.json` (C12, "The
  daemon's expected command"), and the gateway writes it at its start. With no `--gateway-label`, the service has no
  carrier: the switch is off.
- **Q5. When agentwatch sends `remote` items.** *Proposal*: a new hello feature `remote_scopes`, listed only while the
  carrier rule can run (the switch on and the peer reader ready). agentwatch sends `"remote":[]` to a service whose hello
  does not list it, and the browser grant's pane says why.
- **Q6. A quiet window's start.** The design ends an open remote MCP session after its running request. *Proposal*: the
  gateway refuses each request (not only `initialize`) from the window's start, with the design's text; a request that
  runs has passed the gateway already. The service gets no quiet-time rule.
- **Q7. A remote scope's end.** *Proposal*: no `session_ended` for a remote scope. A `set_sessions` that drops a remote
  item ends that scope as `session_ended` ends a local one (its tabs, its MCP sessions, its folder).
- **Q8. The service's own fence.** *Proposal*: the service also refuses (`bad request`) a remote item with a `null`
  token or a box part that is not its `box`, and more than 64 items of one box. agentwatch's check stays the first fence.

## 3. The build tasks of agent-browser's side, in order

"Before stage 4" means the PR can merge before stage 4's Mac checks pass: its code runs only behind the stand-in or a
switch that stays off. "After stage 4" means it waits for stage 4 and for agentwatch's gateway.

### T1. The remote scope pattern and the remote items of `set_sessions` (before stage 4)

- **Result.** `src/relay/scopes.ts` gets `REMOTE_SCOPE`, `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`,
  and `isAnyScope` (local or remote). `SCOPE` stays local, and each list, sign-in or file name keeps it. The shape step
  checks the remote items (Q8), and `status` lists them.
- **Files.** `src/relay/scopes.ts`, `src/service/control.ts:98` and `:116-125`, `src/service/service.ts:268-274`,
  `test/vectors/control.json`.
- **Tests that fail first.** New bad lines in `test/vectors/control.json`: a remote scope with no `/`, with two `/`, with
  a box part that is not `box`, a `list` with a `/`, a `null` token, 65 items of one box. A good line with two boxes. A
  `status` test: `remote` holds `{"scope","box","list","mcp_token":true}`, never a fingerprint.
- **Contract texts.**
  - C11 line 71. Old: "A scope matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Every agentwatch session name matches it."
    New: add "A remote scope (stage 5) is `<box>/<session>`: two names of that pattern with one `/`. A local scope has
    no `/`, so the two never meet."
  - C12 lines 167-169. Old: "`remote[].scope` and `remote[].list` are strings, and the shape step checks no pattern for
    them: `remote` stays empty until stage 5, ... and changes this rule first." New: "`remote[].scope` matches C11's
    remote scope pattern, and its box part is `remote[].box`; `remote[].list` matches the scope pattern. A remote item's
    `mcp_token` is 64 lowercase hex digits, never `null`. At most 64 items of `remote` have one `box`."
  - C12 line 242 and lines 504-505. Old: "`remote` (..., empty until stage 5)" and "`remote` stays empty until stage 5."
    New: "`remote` (the sessions of other boxes; non-empty only to a service whose hello lists `remote_scopes`)".
  - C12 line 313 (`status`). New: "`remote` holds each remote item of the last `set_sessions`, as
    `{"scope","box","list","mcp_token":true}`."
- **Done-when.** `npm test` is green; no file outside the scope and control code takes `REMOTE_SCOPE`.

### T2. The remote scope in the scope book, the model and the CDP path (before stage 4)

- **Result.** A remote item becomes a scope with no roots and its grant's list (Q3) in `set_scopes` (C4) and the
  model's allowlist line. The endpoint takes `/devtools/browser/<box>/<session>` only from the service's own pid with a
  live ticket of that scope (the MCP's browser); every other peer gets a new 403. A snapshot that drops a remote item ends
  the scope (Q7), with C4's rule 2 (the file of ended scopes).
- **Files.** `src/service/lists/scopes.ts:131`, `src/relay/model.ts:553`, `:652`, `:2132`, `src/relay/endpoint.ts:97-126`,
  `src/service/link/carrier.ts:177`, `:237`, `src/service/mcp/ticket.ts:51`, `src/service/service.ts:268-290`.
- **Tests that fail first.** Scope book: a remote row gets its `list`, never a repo's, and a drop ends it. Endpoint (in
  `test/vectors/endpoint.json`): the own pid with a ticket passes; the own pid with no ticket and a local peer get the
  403. The MCP TCP port gives `/mcp/<box>/<session>` its 404 at step 5. The Mac's case rule
  (`service.ts:270`) with box parts that differ only in case.
- **Contract texts.** C11, "The scope, and one connection per tab", new: "A remote scope has no CDP path. A request for
  `/devtools/browser/<box>/<session>` gets 403 `A session of another box reaches this agent browser only through its
  MCP.`, except the MCP's own connection with its ticket (the MCP inside the service)." C11, the scope's list, new: "A
  remote scope's list is the list that its item names, never a repo's list."
- **Done-when.** The tests pass; a remote scope with no receiver support applies as absent at the receiver (C4) and so
  opens no site (fail closed) until C1 below merges.

### T3. The limits of a remote admission in the transport (before stage 4)

- **Result.** For the admission `remote`: each argument that the allow list marks as a path is refused, wherever it
  points; an answer of more than 16 MiB is refused with the design's text; a remote scope's folder is
  `<state>/mcp-remote/<box>/<session>/` (mode 0700), so it never meets a local scope's folder, and it goes at the
  scope's end with its files. The model's download copy for the MCP lands there (the MCP's `outputDir`,
  `src/service/mcp/session.ts:45`).
- **Files.** `src/service/mcp/allow-list.ts:234` (`checkCall` takes the admission), `src/service/mcp/transport.ts:209`,
  `:223`, `:357`, `:425`, `:550`, `src/service/mcp/part.ts:106`, `docs/contracts/mcp-allow-list.md`.
- **Tests that fail first.** For each tool of `allow-list.json` with a `paths` key: a remote call with that key is
  refused, also with a path inside the folder; the same call with no path key passes. A transport test with a small
  limit seam: a larger answer gets the refusal as a tool error, and the MCP session stays open. Folder tests: `a/b` makes
  `mcp-remote/a/b/`, and `../x`, a link and a case twin are refused. The path and size tests also run through the
  stand-in (`--test-mcp-remote-scope`), so no carrier is needed.
- **Contract texts.**
  - C11 lines 2570-2571. Old: "The service refuses each argument that the allow list marks as a path when the path is
    outside the scope's folder, `<state>/mcp/<scope>/`, after `realpath`." New: add "For a remote admission it refuses
    each such argument, wherever it points: -32602 `Not available in the agent browser: <key> names a file, and a
    session of another box cannot name a file of this box.` Tools that give their data inline work."
  - C11, the transport, new: "For a remote admission an answer of more than 16777216 bytes (first value) is not sent:
    the call gets a tool error with `The answer is larger than the limit for a remote session; ask for a smaller part,
    for example one element's snapshot or a viewport screenshot.`"
  - C11 line 2583 (the scope's folder), new: "A remote scope's folder is `<state>/mcp-remote/<box>/<session>/`. No tool
    of a remote scope reads it. It goes at the scope's end, as a local scope's folder goes."
- **Done-when.** The tests pass; a live check on the Linux server with the stand-in shows a screenshot inline and a
  `filename` refused.

### T4. The carrier and the remote admission on the agent door (code before stage 4; its Mac check after stage 4)

- **Result.** At each accept the agent door reads the peer. With the switch on (Q4) a peer that passes the carrier rule
  (A2: the control door's rules 1 to 4 with the gateway's label and command file, and their own refusal texts) is the
  carrier. A carrier request goes through the remote admission, then to the transport with the word `remote`:
  1. only `POST` or `DELETE` to `/mcp/<box>/<session>` with a remote scope of the pattern; a `GET` for a listed remote
     scope gets the same 405 as the local transport (`transport.ts:88`, noStream: the daemon lead's change, since a 404
     on a request with `Mcp-Session-Id` reads to the client as "session expired" and can loop); a path that is not a
     listed remote scope gets the 404;
  2. no `Origin` header, exactly one `Host` (Q2); else the 403s of steps 3 and 4;
  3. the scope is a remote item of the last `set_sessions`, and the bearer's SHA-256 equals its `mcp_token` in constant
     time; a missing bearer gets the first 401, and an unknown scope or token gets the third 401;
  4. the readiness: the 503s of step 8.

  The checks of 1 to 4 run at each request, because one carrier connection carries the requests of many sessions. A
  carrier gets nothing else: its CDP upgrade gets a 403 (T2's text, or the session's 403 for a local scope), and its MCP
  request for a local scope gets the 404. Every other peer stays local, as today. Off by default: with no `--gateway-label` there is no carrier, and the hello has no `remote_scopes`. On Linux
  the rule runs only with `--test --test-gateway-unit <unit>` in stage 5.
- **Files.** New `src/service/mcp/remote.ts` (checks 1 to 4); `src/service/admission.ts:149-170` (a rule for a named job
  and command file); `src/service/agent-door.ts:52`; `src/relay/endpoint.ts:141-146` (a hook for the carrier's plain
  requests); `src/service/main.ts:45`, `:172`, `:222-241`; `src/service/service.ts:523`; `src/service/mcp/part.ts`
  (the feature).
- **Tests that fail first.** Unit tests with a fake carrier (an injected peer rule and the fake reader): the right token
  passes with `remote`; a wrong token, a token of another remote scope and a local scope's token get the 401; a local
  scope by the carrier and `/mcp` alone get the 404; a CDP upgrade by the carrier gets the 403; a non-carrier peer on `/mcp/<box>/<session>` keeps today's 404; two
  scopes on one connection each need their own token; a snapshot that drops an item or changes its token ends its MCP
  sessions, and the next request gets the 401. The vectors of the carrier rule: the job's pid, its direct child with
  the command line, a grandchild, a wrong command, no job.
- **Contract texts.**
  - C11 lines 2384-2385. Old: "On the endpoint's Unix socket the MCP path serves no local session: a request for `/mcp`
    there gets the 404 of step 2, as today." New: add "From stage 5 it serves the carrier, for a remote scope only (the
    remote MCP path, below)."
  - C11 line 3271. Old: "Until stage 5 the port admits no request by a remote token." New: "The MCP port admits no
    request by a remote token: a remote request comes only through the carrier (the remote MCP path), which gives the
    word `remote`."
  - C11, new part "The remote MCP path (stage 5)": A1, A2, checks 1 to 4 above, and the new first 401 text
    `The agent browser of this box needs the session's remote connection token. agentwatch adds it to each session that
    it launches while its box has the browser grant.`
  - C12, the hello: the feature `remote_scopes` (Q5); the usage line gains `--gateway-label` and `--gateway-command`.
- **Done-when.** The tests pass with the switch off and on; one live check on the Linux server in `--test` mode, with a
  fake gateway (a small reverse proxy in a transient user unit) and a local MCP client: `initialize`, `tools/list` with no
  sign-in tool and no PageFetch, a navigation, a refused path argument, and a wrong token's 401.

### T5. The Mac check (after stage 4 and agentwatch's gateway)

- **Result.** A session on the Linux server uses the Mac's agent browser through Cloudflare, the gateway and the
  carrier, with no Mac port. Files: none, or a fix PR. The gateway's label and command file come from the daemon lead.
- **Done-when.** The token design's live check (section 14.4) passes for the remote route: the token, the carrier's
  refusals, a path argument, the 16 MiB refusal, a quiet window (Q6) and the grant's end. It runs only through the
  manager with the operator.

## 4. The chrome-extension part

### C1. The scope pattern with `<box>/` in the receiver (before stage 4)

- **Result.** `agent/scopes.js:8` gets the remote form: a scope of `set_scopes`, of the tab map
  (`agent/tabmap.js:121`) and of the bridge (`agent/bridge.js:81`) may be `<box>/<session>`. A list name keeps the local
  pattern only.
- **Tests that fail first.** chrome-extension's `test/vectors/scopes.json`: a remote scope with a list applies; `a/b/c`,
  `/a`, `a/` and a list named `a/b` apply as absent and count 1 in `refused`.
- **Contract texts.** C4 (chrome-extension `docs/protocol.md` line 1555). Old: "`scope`: a scope of C11, a string that
  matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`." New: "`scope`: a scope of C11, local or remote (C11's two patterns)."
  Lines 310-311 (a list name) stay. The line at 2890 ("from stage 5 it gains an optional `<box>/` part") becomes
  present tense.
- **Done-when.** The receiver's tests pass; T2's remote scope opens its list's sites in a test browser.

**The order.** T1, then C1, T2 and T3 (in any order), then T4, then T5. T1 to T4 and C1 can merge before stage 4.

## 5. Risks

- Q1 open: with only `Authorization` forwarded, no MCP session works after `initialize`.
- One carrier connection serves many sessions: a scope or token check done once for each connection would mix them.
- The pattern change touches about 20 users of `SCOPE`: one that takes `/` for a folder or a file name opens a path.
- The Mac ignores case: two box parts that differ only in case must not share one folder.
- Chrome keeps its own copy of a remote download in the profile's shared downloads folder
  (`src/service/unit/unit.ts:589`); T3 removes it or C11 states it.
- 64 remote sessions of one box can fill the service's 32 MCP sessions (`transport.ts:65`), each with a worker.
  *Agreed*: remote scopes get at most 16 of them (first value), as part of T3; the 17th gets a clear tool error that
  names the limit and says to try again later, not a 503.
- A wrong gateway label or command file fails closed (no carrier), so the remote path is down, not open.
- agentwatch's side (the gateway, the heartbeat with both families) comes later: T5 waits for it.
- The stand-in `--test-mcp-remote-scope` must stay a `--test` flag only (`main.ts:172`).
- Each C11 and C12 text needs the daemon lead's explicit OK; a read receipt is not an OK.
