# Per-repo connection tokens for the agent browser's MCP — design

**Status: Proposed. It waits for the operator's answers to section 17 (one board item). Nothing that fixes
the MCP transport merges before those answers and this design's merge (the manager's rule).**

Date: 2026-11-10. Author: a taylor contributor, a design subagent of the lead (board task ab-v16.94.10, epic
ab-v16.94). Branch `ab-v16.94.10-mcp-tokens-design` in agent-browser, from main `3fe1427`. No product code and
no contract file changes in this task: section 13 names each sentence that a later task changes.

Evidence:

- the installed clients on taylor: Claude Code 2.1.286 and Codex 0.159.3 (their help texts, the text in their
  binaries, Codex's source at its tag `rust-v0.159.3`), and the public documentation of both;
- agentwatch's code on taylor, read only (commit `6fead11c`);
- a small local probe with fake tokens (section 15).

No claude or codex session ran. Nothing ran on the Mac.

This design builds on the service design
([2026-11-09-self-contained-agent-browser-design.md](2026-11-09-self-contained-agent-browser-design.md),
"the service design" below) and on the contracts `docs/contracts/C11.md` and `docs/contracts/C12.md`. It keeps
every decided rule of those documents, except the rules that the operator's answer to board item ab-6ng
changes (section 2).

## 1. The answer in short

1. **Each repo gets one connection token on each box** (a "token" below). It is 32 random bytes with the
   prefix `abt1_`. It lives in one 0600 file under agentwatch's tokens folder. Every session of that repo on
   that box uses it.
2. **The split (question A).** The recommendation: agentwatch's daemon makes, holds, rotates and revokes each
   token, always at an act of the operator. The service holds only the token's SHA-256, which the daemon sends
   on the control door in a new op, `mcp_tokens`. The service checks each MCP request against the hashes.
3. **The operator alone issues and revokes (question B).** The recommendation: the repo's list is the allow.
   The first site in a repo's list issues its token. The removal of the last site revokes it. The Browser
   pane, with a password login, has "New token" and "Remove token" for each repo. The pane never shows a token.
4. **The entry (question C).** Both clients can now read a header from a short local command: Claude Code's
   `headersHelper` and Codex's `http_headers_helper` (Codex 0.159.3; the daemon lead's constraint 3 does not
   name this form). The recommendation: the session's MCP entry holds the URL and agentwatch's header helper.
   The client sends the token only in the `Authorization` header. No stdio bridge runs, and no token is in an
   argv, the environment, the entry or the URL. The bridge stays an option, with its cost stated.
5. **Rotation in a running session.** The service accepts the old hash for 60 s after a rotation. After that,
   the old token gets a 401. Both clients then run the helper again and send the call again, so the session
   needs no restart.
6. **The checks that stay.** On this box the token adds to today's checks: the uid check and the walk before
   any byte, `Origin`, `Host`, the path's scope, the held port. A new rule: the token's repo must be the walk's
   repo. So a token that one repo's agent copies from another repo fails from its own session.
7. **The same-uid fact.** Every session of one OS user runs as one uid, so it can read every token file of that
   user. A per-repo token adds authentication and a revocation lever. It does not isolate repos on one box. The
   uid check, the walk and the repo match keep the isolation.
8. **Another box (question D).** The recommendation: a token works only on its own box. A session on taylor
   reaches the Mac's browser through the agentwatch link (the service design, section 9). The HTTPS of that
   path is the link's: TLS ends at Cloudflare's edge, and the link's signature and seal end at the Mac's
   daemon. The Mac checks the browser grant (Q3: one grant per box). No token crosses to another box.
9. **The secret rules.** No token in an argv, the environment, a log line, a pane, the terminal, a URL, git,
   the control door or a status. Tests scan every recorded spawn, environment, log line, configuration file
   and control line for a canary token, and a mutation of each scan shows that it finds a planted token.
10. **Questions.** Four questions (section 17) cover the manager's four choices: the split with who mints and
    where a token lives (A), issue and rotation (B), the entry form (C) and the reach of a token (D).

## 2. The operator's words and the rules

The operator, board item ab-6ng, 2026-11-10, confirmed:

> "let's have agentwatch connect the mcp for sessions that are allowed to use the agentbrowser on startup. i
> want to reverse the 'no token' guidance i gave earlier. each repo gets its own connection token to
> authenticate over http/https. we need to figure out how to split the auth surface between agentwatch and
> the agentbrowser."

Earlier words that this design keeps:

- On the transport (2026-11-09): "can we use http instead of stdio?"; for a session on taylor that uses the
  browser on the operator's Mac: "isn't http better for that?"; on the shape: "i prefer the agentbrowser is
  more self-contained. seems like a lot of moving parts."
- On start and stop (board item ab-1n8, 2026-11-10): "starts/stops should be automatic. when all agents stop
  using the browser it stops. when at least 1 agent uses it, it starts. the control plane layer is always
  active to receive data from any agent at all times. but chrome can start/stop at will." The service runs at
  all times (board ab-v16.94.11).
- Q2 (board item ab-bi3): "An agent with at least one site in the allowlist."
- Q3 (board item ab-bi3): one grant per box, one Mac site list.
- age-4ks: "env: no" (no endpoint and no secret in a session's environment).
- The earlier "no token" answer (ab-dm6, 2026-11-05): "see if we can solve it without adding a whole new key
  system." The operator reversed it in ab-6ng. The walk of that time stays.

The manager's rules (they count as the operator's):

- The token choices are the operator's design choices: how a token is issued and rotated, where a token lives,
  who may mint one, and the split of the auth surface between agentwatch and the agent browser. This design
  asks them (section 17) and does not decide them.
- A token is a secret: never in an argv, a log line, git, the terminal or a URL; only in 0600 files or
  agentwatch's secret store. The operator alone issues and revokes a token.
- No merge that fixes the MCP transport before this design has the operator's answers and is merged.

The daemon lead's input (board task ab-v16.94.10, its comments; data for the design, not a decision):

- The same-uid fact (item 7 of section 1).
- The constraints: no secret in an argv, the environment, a log line, the terminal, a pane or a URL; token
  files only under `~/.config/agentwatch/tokens/` (0600 files, 0700 folders, modes applied again at each
  write); for Codex, a `-c` override with a header puts the token in an argv, `bearer_token_env_var` puts it
  in the environment, and a per-session `CODEX_HOME` was rejected; Claude Code's `--mcp-config` with
  `headers` works, but the agent can read that file; the root gateway never reads a user's token files.
- The preferred split: the daemon mints and holds; the service sees only a hash; a local stdio bridge of
  agentwatch in every session's MCP entry; the checks of C3 stay; tests of the secret rules on the daemon's
  side.

This design keeps every constraint. It finds one fact that changes constraint 3's result: Codex 0.159.3 has a
header helper (section 4). So the bridge is an option (question C), not a need.

## 3. Words

- **The service**: `agent-browser service`, the agent browser's one process for each OS user and box.
- **The daemon**: agentwatch's per-user daemon.
- **A repo key**: the name of a repo's list (agentwatch's `browser_lists.py` today; the service's list rule
  from stage 1c): `o.r` for the GitHub repo `o/r`, or `r-` and 16 hex digits, or `no-repo` for the sessions
  outside a GitHub repo. It matches C11's scope pattern, so it is a safe file name.
- **A token**: a repo's connection token on one box: `abt1_` and 43 base64url characters (32 random bytes).
- **To issue**: to make a repo's first token. **To rotate**: to make a new token for a repo that has one.
  **To revoke**: to remove a repo's token, so that it stops at once.
- **A generation**: the number of a repo's token: 1 at the issue, one more at each rotation. A new issue after
  a revoke goes on from the last number.
- **The overlap**: the 60 s after a rotation in which the service accepts the previous token too.
- **The header helper** ("the helper"): agentwatch's small command that prints the repo's header,
  `{"Authorization":"Bearer <token>"}`, for the client. Claude Code calls it `headersHelper`; Codex calls it
  `http_headers_helper`.
- **The entry**: a session's MCP server entry, which agentwatch writes at the launch.
- **The walk**, **a root**, **a scope**: as in C11.

## 4. What the two clients can carry

### 4.1 The facts

**Claude Code 2.1.286.**

- `--mcp-config <configs...>` loads MCP servers from JSON files or strings. agentwatch passes a file today
  (`daemon/spawner.py`, `_question_mcp_args`).
- An HTTP server entry can have `headers` (static values) and `headersHelper` (a command). The documentation:
  "Claude Code runs the helper fresh on each connection, at session start and on reconnect". "If a tool call
  returns `401 Unauthorized` or `403 Forbidden`, Claude Code automatically re-runs the helper under the same
  rule, reconnects with the fresh headers, and retries the call once." The command runs in a shell and must
  print a JSON object of strings. Claude Code stops it after 10 s. "When the helper's output includes an
  `Authorization` header, Claude Code uses that credential as the server's authentication and doesn't fall
  back to OAuth for the server."
- A trust rule applies to the helper of a project or local-scope server. A server from `--mcp-config` has the
  scope `dynamic` in the binary's code. Stage 2's live check confirms that the helper of an unattended
  session's `--mcp-config` server runs with no prompt.
- The binary's code gives the helper the server's name in its environment (`CLAUDE_CODE_MCP_SERVER_NAME`). This
  design does not use it: the helper takes the repo key from its own command (section 9.2).
- `${VAR}` in a header reads the environment (forbidden here). `claude mcp add --header` and a JSON string to
  `--mcp-config` put a header in an argv (forbidden here).
- A precedent in agentwatch: an OpenRouter key reaches Claude Code through `apiKeyHelper` ("cat <key file>"),
  which Claude's own process runs, "never through `ANTHROPIC_AUTH_TOKEN`, which every shell command inherits"
  (`accounts/open_model.py`).

**Codex 0.159.3.**

- `codex mcp add --url <url>` takes `--bearer-token-env-var` (the environment, forbidden here).
- The configuration of a Streamable HTTP server has `url`, `bearer_token` and `http_headers` (static values in
  `config.toml`), `env_http_headers` and `bearer_token_env_var` (the environment), and `http_headers_helper`.
  The installed binary has the key and its texts: "http_headers_helper is only supported for local MCP
  servers", "http_headers_helper must not be empty".
- Codex's source at the tag `rust-v0.159.3` (`codex-rs/rmcp-client/src/http_headers.rs`): Codex runs the
  helper with `sh -c <command>`, with stdin and stderr closed, a cleared environment (Codex's default
  environment for MCP servers), a 10 s limit and at most 64 KiB of output. It keeps the headers for the
  connection. "After a same-origin POST returns 401/403, it refreshes the headers once and retries only if the
  helper returns changed values." It sends the headers only to the server's origin and follows no redirect.
  Its comment: "credentials belong in the JSON output rather than in the command text."
- agentwatch writes its own question MCP into the shared `config.toml` with `enabled = false`, and each
  managed launch turns it on with `-c mcp_servers.agentwatch.enabled=true` (`mcp_config.py`,
  `daemon/spawner.py`). The agent browser's entry can use the same form, with no secret in the `-c` values.
- OAuth (`codex mcp login`) stores credentials for each Codex home; the service would have to be an OAuth
  server. Not used here.

**taylor.** `/proc` is mounted with no `hidepid`, so every OS user can read every process's command line. A
token in an argv is a token for every user of the box.

### 4.2 The entry forms for each client

| Form | Claude Code 2.1.286 | Codex 0.159.3 | Where the token lives | A rotation in a running session | "http instead of stdio" | Moving parts | The secret rules |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1. Direct HTTP, the header from a helper (recommended, question C a) | `type: http`, `url`, `headersHelper` in a per-session `--mcp-config` file | a managed `[mcp_servers.agent-browser]` stanza with `url` and `http_headers_helper`, turned on by `-c` at each launch | its 0600 file only; the client holds it in memory | the helper runs again after a 401 or 403, and the call goes again: no restart | kept for both clients | no new process; one short helper run at each connect and each refusal (36 ms p50 in the probe) | kept |
| 2. Direct HTTP, a static header in the entry | `headers` in the per-session file | `http_headers` or `bearer_token` in the shared `config.toml` | a second copy in the client's configuration; Codex's file is shared by every repo and account home | the session needs a restart | kept | no new process; the config writer writes a secret | breaks "token files only under the tokens folder" |
| 3. Direct HTTP, the header from an environment variable | `${VAR}` in `headers` | `bearer_token_env_var` or `env_http_headers` | the session's environment, which every shell command of the agent inherits | the session needs a restart | kept | no new process | breaks "env: no" (age-4ks) |
| 4. Direct HTTP, the header in an argv | `claude mcp add --header`, or a JSON string to `--mcp-config` | `-c mcp_servers.<name>.http_headers...` | every process's command line, readable by every OS user | the session needs a restart | kept | no new process | breaks the argv rule |
| 5. A local stdio bridge (question C b) | `type: stdio`, `agentwatch browser mcp --repo <key>` | `command` and `args` of a stdio stanza | its 0600 file; the bridge reads it | the bridge reads the file again at a 401: no restart | lost on the client's side (stdio), kept between the bridge and the service | one more process for each session (a Node stdio shim measured 62.7 MiB; a Python bridge is not measured) | kept |
| 6. OAuth of the client | `/mcp` login | `codex mcp login` | the client's own credential store (Claude: the keychain or a credentials file; Codex: its home) | the client's refresh | kept | the service becomes an OAuth server; one browser login for each client home | outside agentwatch's tokens folder |
| 7. No token, the walk alone | the URL only | the URL only | nowhere | not needed | kept | the fewest | reverses ab-6ng |

## 5. The threat model

Each row names a threat, what it could do, and the check that stops it. "Steps" are the admission steps of
section 11.

| Threat | What it could do | The checks that stop it | Result |
| --- | --- | --- | --- |
| T1. Another OS user on the box (taylor has three human users) | connect to `127.0.0.1:<port>`; read a token file; read an argv; listen on the port and take the header | the uid check (step 1), before any byte; the 0600 file in 0700 folders (the kernel); no token in any argv (an argv is readable by every user on taylor); the socket unit holds the port at all times; agentwatch writes the entry only when the port's `LISTEN` line has the user's uid; the helper checks that uid again before it prints the header | stopped |
| T2. Another repo's agent of the same OS user (the same-uid fact) | read every token file of the user, also another repo's; use repo B's token | the walk (step 2) gives the connection its own session's scope and repo; the repo match (step 7) refuses repo B's token from a session of repo A (403); the path's scope (step 6) refuses another session's scope | an honest agent, a mistake and an injected instruction: stopped. A hostile program of the same user: not stopped, as today (C11's limit: `cgroup.procs`, `tmux send-keys`, a passed connection). The token does not change this limit |
| T3. A token copied into a transcript, a screenshot, a pane or a commit | give the token to a reader of that text, also on the Internet | on the box: the copy works only from a session of its own repo (steps 2 and 7), where the agent can read the token anyway; off the box: the port listens on `127.0.0.1` only, no gateway route takes a token, and no link path carries one (question D a); fewer copies: no command and no pane shows a token, agentwatch's redactor knows the prefix `abt1_`, the tokens folder is outside every repo; the recovery: "New token" or "Remove token" | no use off the box; no new right on the box |
| T4. A process that is not an agent session (the operator's own shell, a cron job outside agentwatch, `systemd-run`, a web page, Chrome) | connect with a token that it found | the walk (step 2): no root; a web page: the `Origin` 403 (step 3) and the `Host` 403 (step 4); the walk refuses a browser process | stopped, also with the token |
| T5. Another box over the link | reach the service; use a taylor token on the Mac | the port listens on `127.0.0.1` only; over the link the Mac's daemon checks the signature with the pinned key, the nonce, the seal, the browser grant that the operator approved, the quiet times, the size and the rate; the token never crosses (question D a) | stopped; the grant is the other box's right |
| T6. The Mac before its peer reader exists | connect to the Mac's MCP port with a token | the Mac's MCP port refuses every connection until the `libproc` reader is built and measured (the operator's Q1 rule 3, kept); a token does not open it | stopped (fail closed) |
| T7. A token that stays valid after the operator's act | a running session keeps using a revoked or replaced token | the check runs for each request (not once for each connection); a revoke closes the repo's MCP connections at once; the overlap of a rotation ends after 60 s | stopped at the next request |
| T8. A copy of the token in a program's state | a log, a status, a crash report or a heap of the service gives the token | the service never gets a token, only its SHA-256 (question A a); its log and its `status` name a repo and a generation only; the daemon checks the service's pid before its hello, so only the real service gets the hashes | no token to give |

The limit stays as C11 says: the checks stop mistakes, an agent that names another session or repo, and an
injected instruction. They do not stop a hostile program of the same OS user. A per-repo token cannot change
that on one box, because every program of that user can read every token file.

## 6. The split of the auth surface

### 6.1 Who does what (question A, option a)

| Act | agentwatch (the daemon, the gateway, the pane) | The service |
| --- | --- | --- |
| Take the operator's act | the gateway, after its password-login check, adds `"operator":{"user":...,"login":"password"}`; the daemon refuses an issue, a rotation or a revoke without it | nothing |
| Mint | the daemon: 32 bytes from `secrets.token_bytes`, `abt1_` and base64url | never |
| Hold | `~/.config/agentwatch/tokens/agent-browser/repos/<repo key>`: one line, mode 0600; the folders `tokens/`, `tokens/agent-browser/` and `repos/` mode 0700; modes applied again at each write and at each daemon start (`service/permissions.py`); an atomic write (a temp file in the same folder, `fchmod` 0600, then a rename) | only `{repo, generation, sha256, previous}` in memory; nothing on disk |
| Record | `tokens/agent-browser/state.json` (0600): for each repo key, the generation, the time and the user of the last issue or rotation; no token and no hash | nothing |
| Rotate | the daemon, at the operator's act or at the operator's schedule (question B c) | applies the snapshot |
| Revoke | the daemon, at the operator's act and at the acts that follow from it (section 7.3) | applies the snapshot; closes the repo's MCP connections |
| Send | `mcp_tokens`, a complete snapshot of the hashes, at each connect and at each change (section 6.3) | answers it |
| Check | the daemon checks the token itself on its own remote MCP socket (stage 5, section 10) | checks each MCP request (section 11) |
| Give the token to the client | the header helper reads the file and prints the header (section 9) | never |

Why this split (the recommendation of question A):

- The operator's act, the password login and its provenance are agentwatch's. The repos and the launches are
  agentwatch's. The minting sits next to them.
- The service never holds a token. A fault in the service (a log line, a `status` field, a crash report)
  cannot give a token away.
- Section 10's remote path needs the token on the socket of taylor's daemon, which only agentwatch can check.
- agentwatch already holds the user's other secrets in the same folder (the API token, account logins), with
  the same rules. The root gateway never reads a user's token file: the user's daemon reads it.

The other options (question A): option b, the service makes, holds and checks the token, and agentwatch only
passes the operator's act. It is more self-contained, and agentwatch then holds no browser secret. But the
service writes a secret file of its own (outside agentwatch's tokens folder, against the daemon lead's
constraint 2), it must keep the hashes over its own restart, and stage 5's daemon socket must ask the service
to check a token.

### 6.2 What the service holds

- A map from each repo key to its token's generation, its SHA-256, and, during an overlap, the previous
  generation and SHA-256. In memory only.
- The check: the SHA-256 of the request's bearer, compared with every hash of the map in constant time
  (`crypto.timingSafeEqual`). The probe measured 17.8 µs for each request with 50 repos and two hashes for
  each repo.
- Why a hash is enough: a token has 256 random bits, so nobody can find a token from its hash. A slow hash
  adds nothing.
- `status` gives, in `mcp`, `tokens_read` (true after the first snapshot) and `tokens`: for each repo, its key
  and its generation. It gives no hash.

### 6.3 The control door: the op `mcp_tokens`

A new request of C12, from the daemon to the service:

```json
{"t":"req","id":"7","op":"mcp_tokens","by":{"kind":"daemon","user":"<user>","via":"daemon"},
 "tokens":[{"repo":"o.repo-a","generation":3,"sha256":"<64 hex>","previous":{"generation":2,"sha256":"<64 hex>"}},
           {"repo":"o.repo-b","generation":1,"sha256":"<64 hex>","previous":null}]}
```

- **A complete snapshot**, as `set_sessions` is. The service replaces its map with it. A repo that the snapshot
  does not name has no token. The service answers `{"repos":<count>}`.
- **Provenance: `kind: daemon`, `via: daemon`.** The service applies the op only with `kind: daemon` (as
  `config` and `set_sessions`). The operator's act reaches the daemon with `kind: operator` from the gateway,
  and the daemon logs that act. The snapshot itself is the daemon's state, which it also sends at each connect
  with no operator act.
- **The generation** is each repo's token number. It is not a number of the snapshot: the snapshot is complete,
  and the lines of one connection arrive in order. The service logs each repo's generation at each snapshot.
- **The field rules**: `tokens` is a list; `repo` matches C11's scope pattern and is not `unread-repo`; a repo
  appears once; `generation` is an integer from 1 to 2^53 - 1; `sha256` is 64 lowercase hex digits;
  `previous` is `null` or an object with a lower `generation` and a `sha256`. A request that breaks a rule gets
  `bad request`, and the service keeps its old map.
- **The feature name** `mcp_tokens` goes into the service's hello. The daemon sends the op only to a service
  with the feature. A service with the MCP port always has it (stage 1d builds both).
- **The order at each connect**: `config`, `set_sessions`, then `mcp_tokens`.
- **What the snapshot does at once**:
  - a repo that the snapshot drops: the service closes that repo's MCP connections and ends their MCP
    sessions, as at `session_ended`;
  - a changed hash (a rotation): the service closes nothing; the old token works while it is `previous`;
  - a snapshot with no `previous` for a repo ends that repo's overlap.
- **The log rule**: no line of the door holds a token. The daemon logs no hash either; the service logs a repo
  key, a generation and a count.
- The daemon checks the service before its hello (C12: the peer of `control.sock` must be the MainPID of
  `agent-browser.service`). So only the real service gets the hashes.

### 6.4 At the service's restart, and at the daemon's

- **The service's restart.** The service starts with no map. Until the first `mcp_tokens` of the daemon, each
  MCP request gets the 503 `The agent browser is not ready: it has not read the connection tokens yet. Connect
  again in a few seconds.` (fail closed). The daemon reconnects and sends the snapshot again from its files.
  Claude Code tries a dropped remote server again up to five times, with a delay that starts at 1 s and doubles
  each time. Codex's behaviour is a stage 2 live check.
- **The daemon's restart.** The service keeps its last map, as it keeps the last `set_sessions` (C12, "when the
  daemon drops"). Admitted sessions go on. At the reconnect the daemon sends the full snapshot again. A revoke
  cannot happen while the daemon is down, because only the daemon revokes.

### 6.5 A rotation while a session runs

The daemon's steps:

1. It mints the new token, in memory.
2. It sends `mcp_tokens` with the new hash and, as `previous`, the old hash. It waits for the answer.
3. It writes the new token file (the atomic write), and `state.json`.
4. After the overlap (60 s, a first value), it sends `mcp_tokens` with no `previous` for that repo.

What a running session does:

- During the overlap, the old and the new token both work.
- After the overlap, the session's next request with the old token gets a 401.
- Claude Code then runs `headersHelper` again, connects again and sends the call once more. Codex runs
  `http_headers_helper` again and sends the call once more, because the value changed.
- The probe ran this order with a client that behaves as both clients do (section 15): 200, then 401, then
  the helper, then 200.

Why step 2 comes before step 3: a client that reads the new file must find its hash already in the service.
Why the overlap: a request in flight with the old token, and a client that read the old file just before step
3, keep working.

- When no service is connected, the daemon does steps 1 and 3, and it sends the snapshot at the next connect.
- A daemon restart during an overlap ends the overlap early, because the daemon keeps the old hash in memory
  only. A client with the old token then gets a 401 and runs its helper again.

## 7. The operator's acts

### 7.1 Where

The Browser pane of the web viewer, with a password login. The gateway adds the operator provenance only after
its password-login check. A link login is a test login, and agentwatch treats its acts as an agent's
(`auth_link.py`): it cannot issue, rotate or revoke. No CLI command, no API-token call, no agent and no other
box can issue, rotate or revoke. `agentwatch browser tokens` may show each repo key with its generation and its
date, and never a token.

### 7.2 Issue, rotate, revoke (question B, option a)

- **Issue**: the operator adds the first site to a repo's list. The pane then says: "This repo's agents get the
  agent browser's MCP from their next start. agentwatch made the repo's connection token."
- **Rotate**: "New token" on the repo's row. The pane says: "The old token works for 60 more seconds. Running
  sessions switch to the new token by themselves."
- **Revoke**: "Remove token" on the repo's row. The repo's MCP stops at once. The repo's list stays.
- The pane shows each repo's generation and the date and user of its last issue or rotation. It never shows a
  token, so no screenshot of the pane holds one.

### 7.3 What agentwatch does at a revoke

The causes of a revoke:

- the operator's "Remove token";
- the repo's list loses its last site, or the operator removes the list (question B a);
- the operator removes the repo's access (question B b);
- the uninstall of the agent browser (all tokens).

`browser.enabled: false` and `browser.control: false` revoke nothing: they stop the browser or close it (C11's
503), and the tokens stay for the next start.

The daemon's steps:

1. It sends `mcp_tokens` without the repo. The service refuses the repo's requests at once and closes the
   repo's MCP connections.
2. It removes the token file, and it writes `state.json`.
3. It logs one line: the user, the act, the repo key and the generation.
4. The next launch of a session of that repo gets no MCP entry.

### 7.4 What an agent sees after a revoke

- Its open MCP connection closes. Its next call fails.
- The helper finds no file. It prints nothing, writes one line on its stderr ("this repo has no connection
  token: the operator removed it"), and exits with 1. Claude Code shows that the helper did not give a valid
  value; Codex shows a failed connection.
- A request with the old token gets the 401 `The agent browser does not know this connection token. The token
  changed or was removed: connect again.` No text names a stop or a start (I2).
- The skill text tells the agent what to do: ask the operator to give the repo access in the Browser pane, then
  ask for a restart of the session.

## 8. Which sessions are allowed

- **Q2's answer stays the allow** (question B a): a session gets the entry when its scope has a list with at
  least one site. With tokens, the repo also has a token, because the first site issued it.
- **A per-repo allow** (question B b): a switch in the Browser pane for each repo, "This repo's agents may use
  the agent browser's MCP". A repo with sites but with the switch off gets no entry and no token.
- **Sessions outside a GitHub repo** use the list `no-repo` (agentwatch's rule). If that list has a site, those
  sessions (for example a cron job of agentwatch) share the token of `no-repo`.
- **A session whose repo is not known** (the list `unread-repo`) never gets a token or an entry: that list
  fails closed.
- **What an agent of a repo that is not allowed gets**: no entry at its launch, so it sees no browser tools.
  A request to the MCP port by hand gets the 401 (no token), the walk's 403, or the repo match's 403 (another
  repo's token).
- **A list change during a session** does not rewrite that session's entry (the decided rule). A repo whose
  list gets its first site after a launch: that session gets the MCP at its next launch.

## 9. How agentwatch connects the MCP at a session's start

### 9.1 The rule

At each launch, agentwatch adds the agent browser's entry only when all of these hold:

1. agentwatch launches the session, and `browser.enabled` is on with the switch on for the box;
2. the session's scope has a list with at least one site (Q2);
3. the session's repo has a token, and its file passes the mode checks;
4. the `LISTEN` line of `127.0.0.1:<port>` in `/proc/net/tcp` has the user's uid (else `agentwatch health`
   shows red);
5. the client has a header helper: Claude Code at or after the first version that stage 2's live check
   passes, Codex 0.159.3 or later. An older client gets no entry, and `agentwatch health` says why.

The entry never goes into the user's global files and never into the environment (age-4ks).

### 9.2 The header helper

`agentwatch browser mcp-header --repo <repo key> --port <port>`:

- It is a small entry point with standard-library imports only, as `secret_common.py` is, so it starts fast.
  The probe's helper of the same kind took 36 ms p50 (50.9 ms at most) through `sh -c`. The clients allow
  10 s.
- It opens `tokens/agent-browser/repos/<repo key>` with no link followed (`O_NOFOLLOW`), and it checks the open
  file: a regular file of the user, mode 0600, in folders of the user with mode 0700.
- It checks that the `LISTEN` line of `127.0.0.1:<port>` has the user's uid. So it never gives the header to
  another user's program on that port.
- It prints `{"Authorization":"Bearer <token>"}` on its stdout, which is a pipe to the client, and exits 0.
- On any failure it prints nothing on stdout, writes one line with the reason and no token on its stderr, and
  exits 1.
- Its argv holds the repo key and the port, which are not secrets.

### 9.3 Claude Code

agentwatch writes a file for the session, `CACHE_DIR/mcp/sessions/<scope>.json` (0600, in a 0700 folder; it
holds no secret), and passes it with `--mcp-config`, beside agentwatch's own question MCP:

```json
{"mcpServers":{"agent-browser":{"type":"http",
  "url":"http://127.0.0.1:<port>/mcp/<scope>",
  "headersHelper":"<agentwatch's path> browser mcp-header --repo <repo key> --port <port>"}}}
```

agentwatch removes the file at the session's end. A session that runs with `--strict-mcp-config` (an
open-model profile) gets the entry in the same way, because `--mcp-config` carries it.

### 9.4 Codex

agentwatch keeps a managed stanza in the Codex home's `config.toml`, as it does for its question MCP
(`ensure_codex_mcp`, between its own markers), turned off:

```toml
[mcp_servers.agent-browser]
url = "http://127.0.0.1:<port>/mcp"
http_headers_helper = "<agentwatch's path> browser mcp-header"
enabled = false
tool_timeout_sec = 120
```

Each allowed launch turns it on and gives the session's values, with no secret in these `-c` values:

```
-c mcp_servers.agent-browser.enabled=true
-c 'mcp_servers.agent-browser.url="http://127.0.0.1:<port>/mcp/<scope>"'
-c 'mcp_servers.agent-browser.http_headers_helper="<agentwatch's path> browser mcp-header --repo <repo key> --port <port>"'
```

Codex runs the helper with a cleared environment, so the helper takes the repo key from its argv, not from the
environment.

### 9.5 The other forms (question C)

- **b. A local stdio bridge for both clients** (the daemon lead's proposal). The entry names `agentwatch
  browser mcp --repo <repo key>`. The bridge reads the file at its start and at each 401, and speaks HTTP to the
  service with the header. Its effects: one form that works with any MCP client; one more process for each
  session; the client speaks stdio, so the operator's "http instead of stdio" holds only between the bridge and
  the service; the C11 rule "No stdio shim runs for it" changes.
- **c. Claude Code direct, Codex through the bridge.** The fallback if stage 2's live check shows that Codex's
  helper does not work.
- **d. The token in the environment.** Both clients can read a header from an environment variable. It lifts
  "env: no" (age-4ks): every shell command of the agent then has the token, and one `printenv` writes it into
  the transcript.

### 9.6 What a running session does at a change

| Change | Form 1 (the helper) | Form 5 (the bridge) |
| --- | --- | --- |
| A rotation | after the overlap: a 401, the helper again, the call again; no restart | a 401, the bridge reads the file again, the call again; no restart |
| A revoke | its connection closes; the helper fails; the MCP's calls fail until the operator gives access and the session starts again | the same |
| The service's restart | a 503 or a dropped connection; the client connects again; the helper runs again | the bridge connects again |
| The list's first site after the launch | no entry until the next launch (the decided rule) | the same |

## 10. HTTP on this box, HTTPS to another box

**On this box: plain HTTP on `127.0.0.1`, no TLS.** Loopback traffic stays in the kernel. Another OS user can
read it only with root's rights, and root can read every token file too. A TLS layer on loopback would need a
certificate that both clients trust: a change of the system's trust store, or an environment variable for Node
(`NODE_EXTRA_CA_CERTS`). It adds no check. The token travels only in the `Authorization` header, never in the
URL.

**To another box: the agentwatch link's HTTPS (question D a).** The path of the service design's section 9
stays: a session on taylor, agentwatch's stdio program `agentwatch browser mcp --box <box>`, the remote MCP
socket of taylor's daemon (a 0600 Unix socket with the kernel's peer check and the Python walk), the link, the
Mac's daemon, the Mac service's agent door on the MCP path only.

- **The token on taylor.** The stdio program reads the session repo's token, as the helper does, and sends it
  with each request on the socket of taylor's daemon. The daemon checks the peer, the walk, and the token's repo
  against the walk's repo. Then it sends the request over the link without the token.
- **Where TLS ends.** The link calls `https://<label>.agentwatch.sh/...` (agentwatch's rule for outbound link
  calls: verified TLS, no redirects, no proxy environment). TLS ends at Cloudflare's edge, which holds the
  public certificate of `agentwatch.sh`. The system's root certificates check it. Cloudflare's tunnel then
  carries the request to the Mac gateway's tunnel-origin socket.
- **What the link adds.** Each request is signed with taylor's gateway key, which the Mac pinned at the link's
  approval, with a timestamp and a nonce. The MCP request and its answer are sealed to the other daemon's mail
  key, so Cloudflare sees no page text and no tool argument. The link's route refuses a request with an
  `Authorization` header or a cookie.
- **The grant.** The Mac's daemon checks the browser grant, `browser.use`, which the operator approves on the
  Mac's Links page (Q3: one grant per box, one Mac list), the quiet times, the size limit and the rate limit.
- **The clients do no TLS for the browser.** They speak to a local program or to `127.0.0.1`.
- **The Mac opens no port**, as section 9 says.

Options b and c of question D:

- b: the sealed request carries taylor's repo token too, and the Mac checks its hash. The operator could then
  cut one taylor repo on the Mac without the whole grant. More parts: the Mac's daemon must learn taylor's
  hashes over the link, and Q3's "one grant per box" becomes a grant with per-repo cuts.
- c: direct HTTPS from the taylor session's client to the Mac's `agentwatch.sh` address with the token. No
  stdio program on the remote path. But a copy of the token then works from any computer on the Internet until
  the operator removes it. agentwatch refuses its own API token through the tunnel for this reason (the links
  design, part 1). It also needs a route on the Mac's gateway that takes a bearer.

**Stage 5** (ab-v16.94.7 and agentwatch's age-q8t.5) builds the token check on the socket of taylor's daemon
and a test that no link request holds `abt1_`. The Mac service's remote MCP path refuses a request that carries an
`Authorization` header, so a token never reaches the Mac by mistake.

## 11. The checks that stay, and the admission order

**What stays**: the uid check and the walk before any byte (C3's conditions); the `Origin` 403; the `Host`
check against DNS rebinding; the walk's refusal of a browser process; the port held by the socket unit; the
Mac's port closed until its reader exists; the path's scope as a label that must equal the walk's scope.

**What the token adds**: a check for each request, a revocation lever for each repo, and the repo match.

**The agent door** (CDP, the Unix socket) takes no token. The operator's answer names the MCP over HTTP or
HTTPS. The agent door keeps the kernel's peer check, and C11's sentence "No key, no token file and no
environment variable take part" stays true for it.

The admission of the MCP port, with the new step 7 (C11's list, renumbered):

1. The uid (before any byte).
2. The walk (before any byte). The connection's scope gives its session. `set_sessions` gives the session's
   repo, and the list rule (`browser_lists.py` today, the service from stage 1c) gives its repo key.
3. An `Origin` header: 403.
4. The `Host` header: 403.
5. The path: 404.
6. The path's scope against the connection's scope: the session's 403.
7. **The token** (new):
   - before the service's first `mcp_tokens`: the 503 of section 6.4;
   - no `Authorization: Bearer <token>` header: 401 `The agent browser needs this repo's connection token.
     agentwatch adds it to the sessions that it starts for a repo with access.`;
   - a token whose hash the map does not hold: 401 `The agent browser does not know this connection token. The
     token changed or was removed: connect again.`;
   - a token of another repo than the session's repo: 403 `This connection token belongs to another repo than
     this session's repo.`;
   - each 401 carries `WWW-Authenticate: Bearer realm="agent-browser"`, with no `resource_metadata`, so no
     client starts an OAuth login (stage 2's live check confirms).
8. The readiness and the scope's list: the 503s of C11's step 7 today.

Steps 1 and 2 run once for each connection. Steps 3 to 8 run for each request, so a revoke and the end of an
overlap act on the next request. A refused request never has its header in a log line or in an answer.

**Why the repo match.** Without it, any repo's token would pass from any session. With it, a token that one
repo's agent copies from another repo's file fails from its own session. Sessions of one repo share one token,
and the walk still keeps each session in its own scope.

## 12. The secret rules and the log rule

A token is never:

- in an argv: not of the client, the helper, the bridge, the service, the daemon or a test;
- in an environment: not of the session, its shell commands, the helper or the service;
- in a log line: not of the daemon, the gateway, the service, the helper or the clients' own logs;
- in a pane or the terminal: no command prints it, and the Browser pane never shows it;
- in a URL: not in a path and not in a query;
- in git: the tokens folder is outside every repo, and the per-session entry holds only the helper's command;
- on the control door: only its SHA-256 crosses; and not in a `status`, an error text or a 401 body;
- on the link: question D a.

The service's log of the MCP path holds a user, a scope, a repo key, a method and a result. It never holds an
`Authorization` header, a token or a hash (C11's log rule, extended). agentwatch's redactor
(`secret_patterns.py`) gets the prefix `abt1_` as a kind of token, so a transcript hit is redacted before it
leaves the daemon.

How tests prove the rules (section 14 has the list):

- A canary token: the test store mints a known fake token, for example `abt1_` and 43 `C` characters.
- The scans: every recorded spawn's argv and environment (the spawner tests already read the launch argv), the
  per-session `--mcp-config` file and Codex's `config.toml`, every log record of the test (Python's `caplog`,
  the service's log sink), every C12 line that the daemon sends, the service's answers and `status`, and the
  helper's stderr. Each scan must find the canary nowhere. The scans use plain string search (`grep -F` in
  live checks).
- The mutations: each scan has a twin test that plants the canary in the scanned text and must find it. So a
  scan that reads nothing fails.
- The modes: a test sets a token file to 0644 and its folder to 0755; the daemon's next write and its start
  set 0600 and 0700 again; the helper refuses the file before that.

## 13. The changes to other documents

A later task makes these changes, after the operator's answers. The quoted sentences are today's.

**The service design (2026-11-09).**

- The status block: "A new design (board ab-v16.94.10) replaces the MCP's admission of section 8.3 and C11, and
  stage 1d waits for it." becomes a reference to this design and the date of the operator's answers.
- Section 1, item 5: "A local session reaches the MCP with its client's HTTP configuration,
  `http://127.0.0.1:<port>/mcp/<scope>`: no stdio shim runs, and no key (the operator's answer Q1, section
  19)." becomes: the client's HTTP configuration with the repo's token in the `Authorization` header, from a
  header helper (or the bridge, if question C b).
- Section 1, item 9: add the operator's answers to this design's questions.
- Section 4.3, the row "Processes for the MCP of each session": it stays with question C a. With C b, it
  becomes one bridge process for each session.
- Section 8.3, the decision paragraph: "a per-session MCP configuration; and no secret. No stdio shim runs."
  becomes: "a per-session MCP configuration with no secret in it; the repo's token in the `Authorization`
  header, whose repo must equal the walk's repo (the token design)". The sentences "Board ab-v16.94.10 designs it
  before stage 1d builds the MCP; until then, this section is the record of the earlier reading." become a
  reference to this design.
- Section 8.4, "A key per session: not needed. ... and the operator rejected keys (ab-dm6)." becomes: "A token
  per repo: the operator's answer to ab-6ng, designed in the token design; the walk stays."
- Section 8.5: "The entry holds the URL with the session's scope (a label: the walk decides the scope) and no
  secret." becomes: the entry holds the URL and the header helper's command, and no secret. Add rule 3 and 5
  of section 9.1.
- Section 9, the bullet of the daemon's new socket: after "A peer whose walk reaches no session is refused"
  add "then the session repo's token, which the stdio program sends; its repo must equal the walk's repo (the
  token design, question D)".
- Section 11, the row "Secrets": add "each repo's token lives only in its 0600 file under agentwatch's tokens
  folder; the service holds only its SHA-256". The row "Another OS user": add "the token files are 0600 in
  0700 folders; the helper checks the port's listener".
- Section 12, the row C3: "...a per-session MCP configuration; no secret." becomes "...a per-session MCP
  configuration with no secret in it; the repo's token in the `Authorization` header only, checked against a
  hash for each request, whose repo must equal the walk's repo."
- Section 19, Q1 condition 5: "No secret is in the URL or in the configuration. The scope in the path is a
  label: the walk decides the scope." becomes "No secret is in the URL or in the configuration; the token
  travels only in the `Authorization` header. The scope in the path is a label: the walk decides the scope."
- Section 19: a new paragraph with the operator's answers to this design.

**C11 (`docs/contracts/C11.md`).**

- "Board item ab-6ng asks the operator to check this reading of the answer "HTTP". If the operator picks HTTP on
  the private socket with a helper instead, this part changes before stage 1d builds it." becomes: the operator
  confirmed HTTP and added per-repo tokens (ab-6ng); the token design gives the rules.
- "No secret is in the URL or in a session's MCP configuration: no key and no token." becomes "No secret is in
  the URL or in a session's MCP configuration. Each request carries the repo's connection token in its
  `Authorization` header (`Bearer abt1_...`), and only there."
- "A local session reaches the MCP only through this URL. No stdio shim runs for it." stays with question C a.
  With C b it becomes "A local session reaches the MCP through agentwatch's stdio bridge, which ...".
- The admission: the new step 7 of section 11, with its four texts and the `WWW-Authenticate` header; the old
  step 7 becomes step 8.
- "Steps 3 to 7 run for each request on the connection." becomes "Steps 3 to 8 ...".
- A new bullet: "At a C12 `mcp_tokens` snapshot that drops a repo, the service closes that repo's MCP
  connections and ends their MCP sessions."
- The limits: after "As on the endpoint, the check does not stop a hostile process of the same OS user." add:
  "The token does not change this: a process of the user can read every token file. The token's repo must equal
  the walk's repo, so a copied token works only from a session of its own repo."
- The log rule: "No log line of the MCP path holds a tool argument, page content, a cookie, a URL path or a
  payload" gains "an `Authorization` header, a token or a token's hash".
- "How a session gets the MCP": "only when the session's scope has a list with at least one site" gains "and
  the session's repo has a token (the token design)". New bullets: the header helper and its command; the
  client version rule; Codex's managed stanza and its three `-c` values; no token in the entry.
- The table of parts at the top: a new row "The per-repo tokens: the daemon mints and holds, the service checks
  a hash (the token design)", from stage 1d (the service) and stage 2 (agentwatch).

**C12 (`docs/contracts/C12.md`).**

- The requests table: a new row `mcp_tokens` (section 6.3).
- The field rules: the rules of `tokens` (section 6.3).
- Provenance: "`kind: daemon` for the daemon's own requests: `config`, `set_sessions`, `session_ended`,
  `launch_check`, and the daemon's own reads." gains `mcp_tokens`. "the daemon's own requests (`config`,
  `set_sessions`, `session_ended`, `launch_check`) only with `kind: daemon`" gains `mcp_tokens`.
- The hello's feature names: `mcp_tokens`.
- The data of `status`: "`mcp` is the MCP's state, for `agentwatch health`: `{"state":"<state>","address":<text
  or null>}`." gains `tokens_read` and `tokens` (a list of `{repo, generation}`).
- "No side logs page content, a cookie, a URL path or a payload in any log line." gains "a token or a token's
  hash".
- The vectors (`test/vectors/control.json`): an `mcp_tokens` line with fake hashes and its answer; bad lines (63
  hex digits, `unread-repo`, a repo twice, `kind: token`, a `previous` with a higher generation).
- The fake (`--fake`) has the op, as it has every op of the table.

**Stage 1d (ab-v16.94.5).** "no secret anywhere" becomes "the token step of the token design (step 7): the
`Authorization` header checked for each request against the hashes of C12's `mcp_tokens`, in constant time;
the token's repo equal to the walk's repo; the texts; the 503 before the first snapshot; the close of a dropped
repo's connections; no token or hash in a log". It also waits for the operator's answers to this design.

**Stage 4, the Mac (ab-v16.94.6).** No change to "the Mac's TCP peer reader (libproc) for the MCP, measured":
the Mac's MCP port stays closed until then. Add: the Mac's daemon mints the Mac's own repo tokens; the helper on
the Mac checks the port's listener with the same reader.

**Stage 5 (ab-v16.94.7).** Add: the Mac service's remote MCP path refuses a request with an `Authorization`
header (a test). agentwatch's side (age-q8t.5): the stdio program reads the repo's token, and the daemon's
remote MCP socket checks it with the repo match; no link request holds `abt1_` (a test).

**agentwatch's side (the daemon lead's tasks; their texts are on agentwatch's board).**

- age-q8t.1 (stage 2, the client and the switch): the token store, the operator's acts and their provenance,
  the automatic revokes, `mcp_tokens` at each connect and each change, the overlap timer, `agentwatch health`'s
  token lines.
- age-q8t.7 (the MCP entry writer): the header helper in the entry, the five conditions of section 9.1, the
  per-session file and its removal, Codex's stanza and its `-c` values.
- age-q8t.5 (stage 5): section 10.
- age-q8t.6 (stage 6, cleanup) and the uninstall: remove `tokens/agent-browser/`.
- The redactor (`secret_patterns.py`): the prefix `abt1_`.
- The skill text: what an agent does at a 401 or after a revoke.

## 14. Tests

### 14.1 Unit tests, agent-browser (stage 1d)

- The admission vectors (the daemon lead's F11 list, plus the token cases): no header; an unknown token; another
  repo's token; the previous token during the overlap and after it; a dropped repo; the 503 before the first
  snapshot; each with the peer and a fake process table, so both sides test with a fake reader.
- `mcp_tokens`: its shape step, each bad line of section 13's C12 list, `kind: token` refused, the old map kept
  after a bad request.
- A revoke closes an open MCP connection of that repo, and no connection of another repo.
- No byte of a request is read before steps 1 and 2 pass (a refused peer that sends a header gets closed with
  its 403 and no read).
- The constant-time compare: a spy shows that each request compares against every hash.
- The secret scans of section 12 over the service's log sink, its answers and its `status`, with their
  mutations.

### 14.2 Unit tests, agentwatch (the daemon lead)

- The store: the token's form (`abt1_`, 43 base64url characters, from `secrets.token_bytes(32)`); the modes,
  also after a test changes them; the atomic write; no link followed; `state.json` holds no token and no hash.
- The acts: a password login issues, rotates and revokes; a test login, the API token, an `operator` key in an
  HTTP body and a remote box get a refusal; each act sends the right snapshot; the order of a rotation (the
  hash first, then the file, then the end of the overlap); the order of a revoke.
- The automatic revokes: the last site removed, the list removed, the switch off (question B b), the uninstall.
- The helper: each refusal (no file, a link, mode 0644, a folder of mode 0755, another uid's file, no
  listener, another uid's listener in a fake `/proc/net/tcp`); its output's form; no token on its stderr; its
  start time below 1 s.
- The entry writer: an entry only when all five conditions of section 9.1 hold; the recorded launch argv and
  environment hold no canary; the per-session file and `config.toml` hold no canary and no `Bearer`; the file
  is removed at the session's end.
- The C12 lines: the daemon's `mcp_tokens` line holds the canary's SHA-256 and never the canary.

### 14.3 The mutation for each rule

| Rule | The mutation | The test that fails |
| --- | --- | --- |
| Each request needs a token | step 7 removed | "no header" gets 200, not 401 |
| The repo match | the repo compare removed | "another repo's token" gets 200, not 403 |
| The overlap ends | `previous` kept after the snapshot without it | "previous after the overlap" gets 200, not 401 |
| Fail closed at the start | requests served before the first snapshot | the 503 vector gets 401 or 200 |
| A revoke acts at once | the close of the repo's connections removed | the open connection stays open |
| Only the daemon sends tokens | `mcp_tokens` accepted with `kind: token` | the bad-request vector gets `ok: true` |
| The uid check and the walk first | the token read before steps 1 and 2 | the no-read test reads a byte |
| No token in a log | the header logged at a refusal | the log scan finds the canary |
| No token in an answer | the 401 echoes the header | the answer scan finds the canary |
| The file modes | the store writes 0644 | the mode test |
| No token in an argv or an environment | the entry writer passes the header in a `-c` value or an environment variable | the spawn scan finds the canary |
| No token on the door | the daemon sends the token, not its hash | the C12 line scan finds the canary |
| The operator alone issues | a test login may issue | the provenance test |
| The helper checks the listener | the uid check of the `LISTEN` line removed | the helper prints for another uid's listener |
| Each scan reads its text | a scan that returns no hit at all | its twin test with the planted canary |

### 14.4 The live check plan (local, on taylor)

It runs after stage 2, with the service in its `--test` mode on a free port and a free display, a test repo,
a test list with one site on a local test server, and a canary token that the daemon's test path mints. It
does not touch the operator's agent browser. Stage 3 runs it again on the real path with the operator's
approval.

1. agentwatch launches one Claude Code session and one Codex session of the test repo, unattended, each with a
   short task: navigate to the test site and report its title.
2. Both sessions reach the MCP. The service's log shows each admitted request with the repo key.
3. A plain string search (`grep -F`) for the canary finds nothing in: the launch argv and environment that
   agentwatch recorded; `/proc/<pid>/cmdline` and `/proc/<pid>/environ` of each client and of its shell
   commands; the daemon's, the gateway's and the service's logs; the sessions' transcripts (Claude's JSONL,
   Codex's rollout); the pane captures; Claude Code's debug log; `git status` and `git diff` of the test repo.
4. "New token" from a test login gets a refusal (only a password login rotates). The check then rotates the
   token through the daemon's test hook. A call after 61 s works, and the service's log shows a 401 and then an
   admitted request with the new generation.
5. A revoke: the next call fails; the client's text is recorded for the skill; the token file is gone.
6. A second test repo's session runs `curl` with the first repo's token: 403 (the repo match). A command under
   `systemd-run --user --scope`, outside every session, with the token: the walk's 403.
7. The measures: the helper's time at each connect, and the cost of the check for each request.

Another OS user is not used. The uid check stops that case, by the reasons of C11 (M2 reasoned it).

## 15. The probe

A small local probe ran on taylor (Node v26.12.0, Python 3.13.5) with fake tokens only, in a scratch folder.
Its code is not part of this design: stage 1d's tests replace it.

- `mint.py` makes a fake token for a repo key in a 0600 file in a 0700 folder, and writes the hash snapshot in
  the order of section 6.5 (the hash first, then the file).
- `server.mjs` serves `127.0.0.1:<free port>`, holds only hashes (it reads the snapshot again at `SIGHUP`, as a
  C12 snapshot arrives), and checks `Origin`, `Host`, the path's scope, the bearer in constant time and the
  repo match (the walk is simulated with a scope-to-repo map). Its log holds no header.
- `helper.py` is the header helper of section 9.2: the file checks, the `LISTEN` line's uid, the header on
  stdout.
- `drive.py` runs the cases through `sh -c` (as both clients run a helper), also with a cleared environment
  (as Codex does), simulates a client that runs the helper again at a 401 and sends once more, and scans 75
  texts for the fake tokens: every argv and environment that the probe passed to a process, the server's
  `/proc` command line and environment, its log and its output, and the helper's stderr.

The result: 21 of 21 cases pass.

| Case | Result |
| --- | --- |
| A's header on A's scope; on A's other session | 200; 200 |
| No header; a wrong token | 401; 401 |
| B's token on A's scope (the repo match) | 403 |
| An `Origin` header; a bad `Host`; an unknown scope | 403; 403; 403 |
| The helper with a cleared environment; for a repo with no token; with no listener on the port | the same header; no output, exit 1; no output, exit 1 |
| A client before a rotation; the old and the new token during the overlap | 200; 200 and 200 |
| The old token after the overlap; the client after it (401, the helper again, the call again) | 401; 200 |
| The client after a revoke; repo B after A's revoke | 401; 200 |
| The secret scan of 75 texts | no token found |
| The mutations: a token planted in an argv; in a log line | found; found |

The measures: the helper took 36.2 ms p50 and 50.9 ms at most (20 runs, `sh -c` and a standard-library Python
script). The hash check took 17.8 µs for each request with 50 repos and two hashes for each (100,000 runs).

Not probed: the real clients (no claude or codex session ran), the real walk (stage 1d has M2's code), the Mac.

## 16. The build tasks, in order

Each task is a branch, a pull request with its tests, and a fresh review. None starts before the operator's
answers and this design's merge.

| # | Side | Task | Tests | Waits for |
| --- | --- | --- | --- | --- |
| 1 | agent-browser | The contract texts: C11, C12 and the service design's sentences of section 13, for the answers; the vectors (C12's `mcp_tokens` lines; the MCP admission vectors with the token cases) | the vector files' own tests; the fake runs the new C12 vectors | the answers |
| 2 | agentwatch | The token store: mint, the files and their modes, `state.json`, the atomic write, the redactor's `abt1_` | section 14.2, the store; the mode mutations | task 1 |
| 3 | agent-browser | Stage 1d (ab-v16.94.5) with the token step: the map from `mcp_tokens`, step 7, the texts, the 503, the revoke close, the overlap, the log rule; the fake's op | section 14.1; the mutations of section 14.3; `npm test` under the heavy lock | task 1, stage 1a to 1c |
| 4 | agentwatch | The header helper `agentwatch browser mcp-header` | section 14.2, the helper | task 2 |
| 5 | agentwatch | The operator's acts and the snapshot: the gateway's routes (password login only), the Browser pane's rows and texts, the automatic revokes, `mcp_tokens` at each connect and change, the overlap timer, `agentwatch health` | section 14.2, the acts; against `agent-browser service --fake` | tasks 2 and 3 |
| 6 | agentwatch | The MCP entry writer (age-q8t.7): section 9's rule, the per-session file, Codex's stanza and `-c` values, the client version rule | section 14.2, the entry writer; the spawn scans | tasks 4 and 5 |
| 7 | both | The live check of section 14.4 (stage 2), then stage 3 with the operator's approval | section 14.4 | task 6 |
| 8 | agent-browser, agentwatch | Stage 4, the Mac (ab-v16.94.6, age-q8t.4): the `libproc` reader, then the Mac's MCP port opens; the Mac's tokens; the helper's listener check on the Mac | the Mac checks, through the manager with the operator | task 7 |
| 9 | both | Stage 5 (ab-v16.94.7, age-q8t.5): the token on the socket of taylor's daemon; the Mac's refusal of an `Authorization` header on the remote path; no `abt1_` in a link request | the Python walk's cases; the token cases; the two-box live check with the operator | task 8 |
| 10 | agentwatch | Stage 6 and the uninstall: remove `tokens/agent-browser/` | the uninstall test | task 9 |

With question C b (the bridge), task 4 becomes the bridge (`agentwatch browser mcp --repo <key>`: stdio lines
to HTTP requests and back, the file read at the start and at each 401), and section 14.2 gains its tests.

## 17. Questions for the operator

Four questions, for one board item. They cover the manager's four choices:

- the split of the auth surface: question A;
- who may mint a token: question A (which side's code makes it; the act is always yours, by the manager's
  rule);
- where a token lives: question A (it follows the side that keeps it); question C decides that it never goes
  into a client's own configuration;
- issue and rotation: question B.

Until you answer, nothing that fixes the MCP transport merges (the manager's rule), and no session gets the
agent browser's MCP. If you answer some questions and leave one open, its recommendation holds.

**A. Which side makes, keeps and checks each repo's connection token?**

A fact first, in plain words. Every agent session of your OS user runs as that same user. So an agent can read
every token file of that user, also another repo's file. A token cannot keep repo A's agent out of repo B's
browser on one box. What keeps it out: the agent browser's check of which session's program connects (the
walk), and a new rule that a token works only from a session of its own repo.

- **a. agentwatch makes and keeps the token; the agent browser checks only its hash (recommended).** At your act
  in the Browser pane, agentwatch makes the token and keeps it in a 0600 file in its tokens folder, beside its
  other secrets. It sends only a fingerprint of the token (its SHA-256) to the agent browser, which checks each
  request against it. The agent browser never holds a token, so a fault in it cannot leak one. agentwatch gets
  one more small store of secrets.
- **b. The agent browser makes, keeps and checks the token.** agentwatch only passes your act (with your
  password login) and writes the session's MCP entry. The agent browser is more self-contained, and agentwatch
  holds no browser secret. But the agent browser then writes a secret file of its own, and in stage 5
  agentwatch's daemon on taylor must ask the agent browser to check a token. It goes against the daemon lead's
  rule that token files stay in agentwatch's tokens folder.

Recommendation: a. No answer: a.

**B. When does a repo get its token, and when does it change?**

- **a. The list is the allow (recommended).** When you add the first site to a repo's list in the Browser pane,
  agentwatch makes the repo's token. When you remove the last site or the list, agentwatch removes it. Each
  repo's row has "New token" (the old one works 60 more seconds, and running sessions switch by themselves)
  and "Remove token" (the repo's MCP stops at once). No schedule. Your list stays the only place that allows a
  repo, as in your Q2 answer.
- **b. A separate switch for each repo.** A switch "This repo's agents may use the agent browser's MCP" in the
  Browser pane. On makes the token; off removes it. A repo with sites but with the switch off gets no MCP. One
  more act for each repo, and a second place that decides.
- **c. As a (or b), and also a new token at a fixed interval** that agentwatch makes by itself (first value:
  every 30 days). You set the interval once. A copied token then stops after at most 30 days with no act of
  yours. Running sessions switch by themselves. One more timer.

Recommendation: a. No answer: a.

**C. How does a session send its repo's token?**

- **a. Direct HTTP with a header helper, for Claude Code and for Codex (recommended).** The session's MCP entry
  holds the address and a short agentwatch command. The client runs the command at each connection and after a
  refused request, and it sends the token only in the request's `Authorization` header. The token is in no
  command line, no environment, no entry and no address. No extra program runs for the session's MCP. Your
  "http instead of stdio" holds for both clients, with the fewest parts. Both clients have this feature now
  (Claude Code `headersHelper`; Codex 0.159.3 `http_headers_helper`). Stage 2 checks it live; a client without
  it gets no MCP entry.
- **b. A small local program between the client and the agent browser, for both clients (a stdio bridge; the
  daemon lead's proposal).** The entry names an agentwatch program. The program reads the token and speaks HTTP
  to the agent browser. One form that works with any MCP client. But each session runs one more program (a
  similar Node program used 62.7 MiB), and the client speaks stdio again, against your "http instead of stdio".
- **c. a for Claude Code, b for Codex.** Only if stage 2 shows that Codex's helper does not work.
- **d. The token in the session's environment.** Both clients can read a header from an environment variable.
  It lifts your "env: no": every shell command of the agent then has the token, and one `printenv` writes it
  into the transcript.

Recommendation: a (with c as the fallback that stage 2's check can need). No answer: a.

**D. Where does a repo's token work?**

- **a. Only on its own box (recommended).** On this box the token adds to today's checks, and it works only from
  a session of its own repo. A session on taylor that uses your Mac's browser goes through the agentwatch link,
  as the service design's section 9 says: taylor's daemon checks the session and its repo's token; the link
  carries the request over HTTPS, signed with taylor's link key and sealed for the Mac's daemon; the Mac checks
  your browser grant (one for each box, your Q3 answer). The token never leaves taylor, so a copy works
  nowhere else. That path keeps agentwatch's small stdio program on taylor, because the Mac opens no port. The
  Mac's own MCP port stays closed until its peer reader exists.
- **b. Also on the other box.** The sealed request carries taylor's repo token too, and the Mac checks it. You
  can then cut one taylor repo on the Mac without the whole grant. More parts: the Mac must learn the
  fingerprints of taylor's tokens, and your "one grant per box" gets per-repo cuts.
- **c. Direct HTTPS to the other box.** A taylor session's client calls the Mac's agentwatch.sh address with the
  token, with no program between. But a copy of the token then works from any computer on the Internet until
  you remove it. agentwatch refuses its own API token through the tunnel for this reason.

Recommendation: a. No answer: a.

## 18. Limits and open points

- **The same-uid limit** stays (section 5). This design does not claim repo isolation from the token.
- **The clients' helpers are new features.** The design relies on Claude Code's `headersHelper` and Codex's
  `http_headers_helper`, read from the documentation, the binaries' text and Codex's source. Stage 2's live
  check proves them. Question C c is the fallback.
- **The agent door (CDP)** takes no token (section 11). If the operator wants a token there too, that is a
  later design.
- **The remote path keeps a stdio program** on taylor (question D a). An HTTP door in taylor's daemon would
  remove it, at the cost of a TCP port and a TCP walk in agentwatch. That is a later design.
- **First values**: the overlap (60 s), question B c's interval (30 days), the helper's time limit (the clients'
  10 s). The build measures and records them.
