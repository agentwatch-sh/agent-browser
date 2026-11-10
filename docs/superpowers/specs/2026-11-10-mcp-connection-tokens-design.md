# Per-repo connection tokens for the agent browser's MCP — design

**Status: Proposed. It waits for the operator's answers to section 17 (five questions on two board items).
Nothing that fixes the MCP transport merges before those answers and this design's merge (the manager's
rule).**

Date: 2026-11-10. Author: a taylor contributor, a design subagent of the lead (board task ab-v16.94.10, epic
ab-v16.94). Branch `ab-v16.94.10-mcp-tokens-design` in agent-browser, from main `3fe1427`. Revised after one
fresh review and the daemon lead's read (one fix round). No product code and no contract file changes in this
task: section 13 names each sentence that a later task changes.

Evidence:

- the installed clients on taylor: Claude Code 2.1.286 and Codex 0.159.3 (their help texts, the text in their
  binaries, Codex's source at its tag `rust-v0.159.3`), and the public documentation of both;
- agentwatch's code on taylor, read only (commit `6fead11c`);
- a small local probe with fake tokens (section 15).

No claude or codex session ran. Nothing ran on the Mac. Section 4.1 marks each client claim that only
documentation supports.

This design builds on the service design
([2026-11-09-self-contained-agent-browser-design.md](2026-11-09-self-contained-agent-browser-design.md),
"the service design" below) and on the contracts `docs/contracts/C11.md` and `docs/contracts/C12.md`. It keeps
every decided rule of those documents, except the rules that the operator's answer to board item ab-6ng
changes (section 2).

## 1. The answer in short

1. **Each repo gets one connection token on each box** (a "token" below). It is 32 random bytes with the
   prefix `abt1_`. It lives in one 0600 file in agentwatch's token store (its tokens folder). Every session of
   that repo on that box uses it.
2. **The split (question A).** The recommendation: agentwatch's daemon makes, holds, rotates and revokes each
   token. It mints only at an act of the operator, or at a rotation schedule that the operator chose
   (question B2). It never mints by itself at a switch-on or an upgrade. The service holds only the token's
   SHA-256, which the daemon sends on the control door in a new op, `mcp_tokens`. The service checks each MCP
   request against the hashes.
3. **The operator alone issues and revokes (questions B1 and B2).** The recommendation of B1: the repo's list
   is the allow. A site that an operator act adds to an empty list issues the repo's token. The removal of the
   last site revokes it. The Browser pane, with a password login, has "Issue token", "New token" and "Remove
   token" for each repo. The pane never shows a token. The recommendation of B2: no schedule.
4. **The entry (question C).** Both clients can read a header from a short local command: Claude Code's
   `headersHelper` and Codex's `http_headers_helper` (Codex 0.159.3; the daemon lead's constraint 3 does not
   name this form). The recommendation: the session's MCP entry holds the URL and agentwatch's header helper.
   For Codex the entry is only `-c` values at each launch, as the decided rule says. The client sends the token
   only in the `Authorization` header. No stdio bridge runs. The bridge stays an option, with its cost stated.
5. **Rotation in a running session.** The service accepts the old hash for 60 s after a rotation. After that,
   the old token gets a 401. Claude Code then runs its helper again and sends the call again. Codex does the
   same after a 401 on a POST. So the session needs no restart.
6. **The checks that stay.** On this box the token adds to today's checks: the uid check and the walk before
   any byte, `Origin`, `Host`, the path's scope, the held port. The walk alone keeps repo A's agent out of repo
   B's scope. A new rule, the repo match: the token's repo must be the walk's repo. It stops a repo with no
   access (never allowed, or revoked) from using a token copied from another repo.
7. **The same-uid fact.** Every session of one OS user runs as one uid, so it can read every token file of that
   user, and it can run the helper. An agent that does so puts the token into its transcript and the model's
   context. The rules cover every path that agentwatch or a client takes without being asked. A copied token
   works only from a session of its own repo on its own box, so the copy gives that agent no new right.
8. **Another box (question D).** The recommendation: the token rule is for the local MCP port only. The remote
   path needs no taylor token: the walk on the daemon's socket and the browser grant decide (Q3: one grant per
   box). The HTTPS of that path is the link's: TLS ends at Cloudflare's edge, and the link's signature and seal
   end at the Mac's daemon. No token crosses to another box.
9. **The secret rules.** No token in an argv, the environment, a log line, a URL, git, the control door or a
   status, and agentwatch prints none in a pane or a terminal. The helper refuses to print to a terminal. Tests
   scan every recorded spawn, environment, log line, configuration file, control line and pane answer for a
   canary token and its hash, and a mutation of each scan shows that it finds a planted token.
10. **Questions.** Five questions (section 17) cover the manager's four choices: the split with who mints and
    where a token lives (A), the allow and the issue (B1), the rotation schedule (B2), the entry form (C) and
    the reach of a token (D). Each question stands alone, so that the lead can put them on two board items.

## 2. The operator's words and the rules

The operator, board item ab-6ng, 2026-11-10, confirmed:

> "let's have agentwatch connect the mcp for sessions that are allowed to use the agentbrowser on startup. i
> want to reverse the 'no token' guidance i gave earlier. each repo gets its own connection token to
> authenticate over http/https. we need to figure out how to split the auth surface between agentwatch and
> the agentbrowser."

Board item ab-6ng offered two readings of the operator's earlier answer "HTTP": a loopback TCP port with the
peer check, and "HTTP on the private socket, with a small helper" for each agent. The operator chose neither
offered option there. The answer above adds tokens and asks for this design.

Earlier words that this design keeps:

- On the transport: "can we use http instead of stdio?" (2026-11-09, the operator's words in the lead's
  session, recorded in the service design's section 2). For a session on taylor that uses the browser on the
  operator's Mac: "isn't http better for that?". On the shape: "i prefer the agentbrowser is more
  self-contained. seems like a lot of moving parts."
- Q1 (board item ab-bi3, 2026-11-10, recorded in the service design's section 19): the answer "HTTP", in free
  text, not the recommended stdio shim.
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
- The operator's words do not clearly choose between a helper and a bridge, so the entry form is the
  operator's choice too (question C).

**The token store.** The tokens folder (0600 files in 0700 folders, `~/.config/agentwatch/tokens/`) is
agentwatch's token store for durable credentials: the API token and the account logins are there. It is the
place that the manager's rule allows ("only in 0600 files"). It is not the mail secret store
(`daemon/secret_store`), which keeps a secret for one session for a short time.

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
- The daemon lead's read of this design (2026-11-10): agrees with direct HTTP and the header helper, the
  minting only at the operator's password-login act, `mcp_tokens`, the repo match and the close on drop. Its
  six changes and its build items are in this revision (sections 6, 7, 9, 11, 12 and 16).

This design keeps every constraint. It finds one fact that changes constraint 3's result: Codex 0.159.3 has a
header helper (section 4). So the bridge is an option (question C), not a need.

## 3. Words

- **The service**: `agent-browser service`, the agent browser's one process for each OS user and box.
- **The daemon**: agentwatch's per-user daemon.
- **A repo key**: the name of a repo's list, by agentwatch's rule (`browser_lists.py`, `list_name_for`):
  - `o.r` for the GitHub repo `o/r` (lowercase), when `o.r` matches C11's scope pattern;
  - else `r-` and the first 16 hex digits of the SHA-256 of the whole `o/r`, for example when `o.r` is longer
    than 64 characters. A long name never shortens to a key that two repos share by a cut of the name;
  - `no-repo` for a session outside a GitHub repo (`repo: null`);
  - `unread-repo` for a session whose repo agentwatch cannot read yet. That list is always empty, and no token
    has this key.

  A repo key matches C11's scope pattern, so it is a safe file name. The daemon sends each session's key in
  `set_sessions` (section 11), so the service never computes a key a second way.
- **A token**: a repo's connection token on one box: `abt1_` and 43 base64url characters (32 random bytes).
- **To issue**: to make a repo's first token, or a token for a repo that has none now. **To rotate**: to make a
  new token for a repo that has one. **To revoke**: to remove a repo's token, so that it stops at once.
- **A generation**: the number of a repo's token: 1 at the first issue, one more at each rotation or issue. An
  issue after a revoke goes on from the last number.
- **The overlap**: the 60 s after a rotation in which the service accepts the previous token too.
- **The header helper** ("the helper"): agentwatch's small command that prints the repo's header,
  `{"Authorization":"Bearer <token>"}`, for the client. Claude Code calls it `headersHelper`; Codex calls it
  `http_headers_helper`.
- **The entry**: a session's MCP server entry, which agentwatch writes at the launch.
- **The walk**, **a root**, **a scope**: as in C11.

## 4. What the two clients can carry

### 4.1 The facts

Each claim names its source. "Documented, not proven" means that only the client's documentation supports it;
stage 2's live check proves it (section 14.4).

**Claude Code 2.1.286.**

- `--mcp-config <configs...>` loads MCP servers from JSON files or strings (the help text). agentwatch passes a
  file today (`daemon/spawner.py`, `_question_mcp_args`).
- An HTTP server entry can have `headers` (static values) and `headersHelper` (a command) (the documentation
  and the binary's text).
- Claude Code runs the helper again after a 401 or 403 of a tool call and sends the call once more. The
  binary's text: "re-running headersHelper and retrying once".
- When the helper gives `Authorization`, Claude Code does not fall back to OAuth. The binary's text: "OAuth
  fallback is disabled when the helper supplies Authorization."
- The binary's code gives the helper the server's name and URL in its environment
  (`CLAUDE_CODE_MCP_SERVER_NAME`, `CLAUDE_CODE_MCP_SERVER_URL`). The helper checks the URL (section 9.2).
- Documented, not proven: the helper runs "fresh on each connection, at session start and on reconnect"; it
  must print a JSON object of strings; Claude Code stops it after 10 s.
- Documented, not proven: Claude Code tries a dropped remote server again up to five times, with a delay that
  starts at 1 s and doubles each time.
- A trust rule applies to the helper of a repo-resident server (a project or local-scope server). The binary's
  text for a missing trust: "not available to a session rooted at the home directory without a person ...". A
  server from `--mcp-config` has the scope `dynamic` in the binary's code. Stage 2 proves that the helper of an
  unattended session's `--mcp-config` server runs with no prompt, also in a session rooted at the home folder
  (the `no-repo` sessions).
- `${VAR}` in a header reads the environment (forbidden here). `claude mcp add --header` and a JSON string to
  `--mcp-config` put a header in an argv (forbidden here).
- A precedent in agentwatch: an OpenRouter key reaches Claude Code through `apiKeyHelper` ("cat <key file>",
  with the path shell-quoted), which Claude's own process runs, "never through `ANTHROPIC_AUTH_TOKEN`, which
  every shell command inherits" (`accounts/open_model.py`).

**Codex 0.159.3.**

- `codex mcp add --url <url>` takes `--bearer-token-env-var` (the environment, forbidden here).
- The configuration of a Streamable HTTP server has `url`, `bearer_token` and `http_headers` (static values in
  `config.toml`), `env_http_headers` and `bearer_token_env_var` (the environment), and `http_headers_helper`
  (the documentation and the binary's text).
- Which servers can have a helper. The installed binary's text: "http_headers_helper is only supported for
  local MCP servers". The documentation: "Supported for HTTP MCP connections made from the local environment;
  not for stdio servers or connections made through a remote execution environment." So "local" names the
  local execution environment (the default `environment_id`), not a config layer. Stage 2 proves that a server
  that only `-c` values define, with a URL on `127.0.0.1`, counts as local.
- Codex's source at the tag `rust-v0.159.3` (`codex-rs/rmcp-client/src/http_headers.rs`):
  - Codex runs the helper with `sh -c <command>`, with stdin and stderr closed, a cleared environment (Codex's
    default environment for MCP servers, so `XDG_CONFIG_HOME` is gone), a 10 s limit and at most 64 KiB of
    output. Its comment: "credentials belong in the JSON output rather than in the command text."
  - Codex runs the helper once when it makes the server's client, and keeps the result for that server.
  - It runs the helper again only after a 401 or 403 to a POST, and it sends the POST once more only when the
    helper's values changed. A 401 to a GET (an event stream) gets no new run of the helper.
  - It keeps a failed first result. Then no request goes out, so no 401 comes back, and the helper does not run
    again until the session starts again.
  - A failed later run keeps the last good headers. The next POST gets its 401 again, and the helper runs again.
    So after a revoke and a new issue, the next POST recovers with no restart.
  - It sends the headers only to the server's origin and follows no redirect.
- The decided rule for the entry (the service design's Q1 condition 4, C11): "for Codex a `-c` override for
  each launch", never the user's global files. agentwatch's own question MCP uses a stanza in the shared
  `config.toml` (`mcp_config.py`); the agent browser's entry does not.
- OAuth (`codex mcp login`) stores credentials for each Codex home; the service would have to be an OAuth
  server. Not used here.

**taylor.** `/proc` is mounted with no `hidepid`, so every OS user can read every process's command line. A
token in an argv is a token for every user of the box.

### 4.2 The entry forms for each client

| Form | Claude Code 2.1.286 | Codex 0.159.3 | Where the token lives | A rotation in a running session | "http instead of stdio" | Moving parts | The secret rules |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1. Direct HTTP, the header from a helper (recommended, question C a) | `type: http`, `url`, `headersHelper` in a per-session `--mcp-config` file | `-c` values at each launch that define `mcp_servers.agent-browser` with `url` and `http_headers_helper` (no stanza) | its 0600 file only; the client holds it in memory | Claude Code: the helper runs again after a 401 or 403, and the call goes again. Codex: the same after a 401 or 403 to a POST. No restart | kept for both clients | no new process; one short helper run at each connect and each refusal (36 ms p50 in the probe) | kept for every path that agentwatch or a client takes; an agent can run the helper itself (section 12) |
| 2. Direct HTTP, a static header in the entry | `headers` in the per-session file | `http_headers` or `bearer_token` in a `config.toml` | a second copy in the client's configuration | the session needs a restart | kept | no new process; the config writer writes a secret | breaks "token files only under the tokens folder" |
| 3. Direct HTTP, the header from an environment variable | `${VAR}` in `headers` | `bearer_token_env_var` or `env_http_headers` | the session's environment, which every shell command of the agent inherits | the session needs a restart | kept | no new process | breaks "env: no" (age-4ks) |
| 4. Direct HTTP, the header in an argv | `claude mcp add --header`, or a JSON string to `--mcp-config` | `-c mcp_servers.<name>.http_headers...` | every process's command line, readable by every OS user | the session needs a restart | kept | no new process | breaks the argv rule |
| 5. A local stdio bridge (question C b) | `type: stdio`, `agentwatch browser mcp --repo <key>` | `-c` values that define `command` and `args` | its 0600 file; the bridge reads it | the bridge reads the file again at a 401: no restart | lost on the client's side (stdio), kept between the bridge and the service | one more process for each session (a Node stdio shim measured 62.7 MiB; a Python bridge is not measured) | as form 1 |
| 6. OAuth of the client | `/mcp` login | `codex mcp login` | the client's own credential store (Claude: the keychain or a credentials file; Codex: its home) | the client's refresh | kept | the service becomes an OAuth server; one browser login for each client home | outside agentwatch's tokens folder |
| 7. No token, the walk alone | the URL only | the URL only | nowhere | not needed | kept | the fewest | reverses ab-6ng |

## 5. The threat model

Each row names a threat, what it could do, and the check that stops it. "Steps" are the admission steps of
section 11. The token rule is for the local MCP port only; the agent door and the remote path take no token
(sections 10 and 11).

| Threat | What it could do | The checks that stop it | Result |
| --- | --- | --- | --- |
| T1. Another OS user on the box (taylor has three human users) | connect to `127.0.0.1:<port>`; read a token file; read an argv; listen on the port and take the header | the uid check (step 1), before any byte; the 0600 file in 0700 folders (the kernel); no token in any argv (an argv is readable by every user on taylor); the socket unit holds the port at all times; agentwatch writes the entry only when the port's `LISTEN` line has the user's uid; the helper checks the URL and that uid again before it prints the header | stopped. A small leak: the helper's command line shows the repo key and the port to every OS user |
| T2. Another repo's agent of the same OS user (the same-uid fact) | read every token file of the user, also another repo's; run the helper for another repo; use repo B's token; name repo B's scope | the walk (step 2) gives the connection its own session's scope; the path's scope (step 6) refuses another session's scope. The walk alone keeps repo A's agent out of repo B's scope. The repo match (step 7) stops repo A from using repo B's token, so a repo with no access gets none by a copy | an honest agent, a mistake and an injected instruction: stopped. A hostile program of the same user: not stopped, as today (C11's limit: `cgroup.procs`, `tmux send-keys`, a passed connection). The token does not change this limit |
| T3. A token copied into a transcript, a screenshot, a pane or a commit | give the token to a reader of that text, also on the Internet | on the box: the copy works only from a session of its own repo (steps 2 and 7); off the box: the port listens on `127.0.0.1` only, no gateway route takes a token, and no link path carries one (question D a); fewer copies: agentwatch prints no token in any pane, terminal or answer, the helper refuses a terminal, the redactor masks `abt1_` in what the daemon forwards, the tokens folder is outside every repo; the recovery: "New token" or "Remove token" | no use off the box; no new right on the box. An agent can still copy a token into its own transcript (T9) |
| T4. A process that is not an agent session (the operator's own shell, a cron job outside agentwatch, `systemd-run`, a web page, Chrome) | connect with a token that it found | the walk (step 2): no root; a web page: the `Origin` 403 (step 3) and the `Host` 403 (step 4); the walk refuses a browser process | stopped, also with the token |
| T5. Another box over the link | reach the service; use a taylor token on the Mac | the port listens on `127.0.0.1` only; over the link the Mac's daemon checks the signature with the pinned key, the nonce, the seal, the browser grant that the operator approved, the quiet times, the size and the rate; the remote path takes no token, and the Mac's remote MCP path refuses an `Authorization` header (question D a) | stopped; the grant is the other box's right |
| T6. The Mac before its peer reader exists | connect to the Mac's MCP port with a token | the Mac's MCP port refuses every connection until the `libproc` reader is built and measured (the operator's Q1 rule 3, kept); a token does not open it | stopped (fail closed) |
| T7. A token that stays valid after the operator's act | a running session keeps using a revoked or replaced token; a daemon crash during a revoke brings the token back | the check runs for each request (not once for each connection); a revoke closes the repo's MCP connections at once; the overlap of a rotation ends after 60 s; a revoke removes the file and records itself before it sends the snapshot, and it stays pending until the service acknowledges it (section 7.3) | stopped at the next request; a crash does not undo a revoke |
| T8. A copy of the token in a program's state | a log, a status, a crash report or a heap of the service gives the token | the service never gets a token, only its SHA-256 (question A a); its log and its `status` name a repo and a generation only; the daemon checks the service's pid before its hello, so only the real service gets the hashes | no token to give |
| T9. An agent that runs the helper or reads the token file itself | put the token into its tool output, its transcript and the model's context (which the client sends to its model provider) | not stopped: the same uid allows it. The helper refuses when its stdout or stderr is a terminal, so a print into a person's terminal or a pane is refused; an agent's shell tool gives the helper a pipe, so this refusal does not stop an agent. The skill text tells agents never to run the helper or read the file. The copy works only from a session of its own repo on its own box (steps 2 and 7) | no new right for that agent; the copy is in its transcript. Open point: the helper over the daemon's socket (section 18) |

Two more small leaks: the 403 of step 7 tells a caller that its token is valid for another repo (the caller
already holds that token); and the helper's command line names the repo key (T1).

The limit stays as C11 says: the checks stop mistakes, an agent that names another session or repo, and an
injected instruction. They do not stop a hostile program of the same OS user. A per-repo token cannot change
that on one box, because every program of that user can read every token file.

## 6. The split of the auth surface

### 6.1 Who does what (question A, option a)

| Act | agentwatch (the daemon, the gateway, the pane) | The service |
| --- | --- | --- |
| Take the operator's act | the gateway, after its password-login check, builds `"operator":{"user":...,"login":"password"}` from the credential, and drops any `operator` key from the request body; the daemon refuses an issue, a rotation or a revoke without it | nothing |
| Mint | the daemon: 32 bytes from `secrets.token_bytes`, `abt1_` and base64url; only at the operator's act (section 7.2) or the operator's schedule (question B2); never by itself at a switch-on, an upgrade or a restart | never |
| Hold | `~/.config/agentwatch/tokens/agent-browser/repos/<repo key>`: one line, mode 0600; the folders `tokens/`, `tokens/agent-browser/` and `repos/` mode 0700; an atomic write (a temp file in the same folder, `fchmod` 0600, then a rename) | only `{repo, generation, sha256, previous}` in memory; nothing on disk |
| Harden | the permissions sweep (`service/permissions.py`) covers `tokens/agent-browser/`, `repos/`, each token file and `state.json`, at each write and at each daemon start (today it covers only the tokens folder itself) | nothing |
| Record | `tokens/agent-browser/state.json` (0600): for each repo key, the generation, the time and the user of the last issue or rotation, and each revoke that the service has not acknowledged yet; no token and no hash | nothing |
| Rotate | the daemon, at the operator's act or at the operator's schedule (question B2) | applies the snapshot |
| Revoke | the daemon, at the operator's act and at the acts that follow from it (section 7.3) | applies the snapshot; closes the repo's MCP connections |
| Send | `mcp_tokens`, a complete snapshot of the hashes, at each connect and at each change; it checks each answer (section 6.3) | answers it |
| Check | nothing: the remote path takes no token (section 10) | checks each request to the local MCP port (section 11) |
| Give the token to the client | the header helper reads the file and prints the header (section 9) | never |
| Remove at the uninstall | a normal uninstall (not only `--purge`) removes `tokens/agent-browser/` on Linux and the Mac; an update (`install.sh --update`) keeps it; no vault or config sync copies the tokens folder | nothing |

Why this split (the recommendation of question A):

- The operator's act, the password login and its provenance are agentwatch's. The repos and the launches are
  agentwatch's. The minting sits next to them.
- The daemon sends each list op itself and reads its answer (section 7.2), so it sees each first site and each
  last site.
- The service never holds a token. A fault in the service (a log line, a `status` field, a crash report)
  cannot give a token away.
- agentwatch already holds the user's other durable secrets in the same token store (the API token, account
  logins), with the same rules. The root gateway never reads a user's token file: the user's daemon reads it.

The other option (question A): option b, the service makes, holds and checks the token, and agentwatch only
passes the operator's act. It is more self-contained, and agentwatch then holds no browser secret. But the
service writes a secret file of its own (outside agentwatch's tokens folder, against the daemon lead's
constraint 2), it must keep the hashes over its own restart, and agentwatch's helper or entry writer must read
a file of the service.

### 6.2 What the service holds

- A map from each repo key to its token's generation, its SHA-256, and, during an overlap, the previous
  generation and SHA-256. In memory only.
- The hash input: the lowercase hex SHA-256 of the token's ASCII bytes, with the `abt1_` prefix.
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
  does not name has no token. The service answers `{"repos":<count>}`, the number of repos that it applied.
- **Provenance: `kind: daemon`, `via: daemon`.** The service applies the op only with `kind: daemon` (as
  `config` and `set_sessions`). The operator's act reaches the daemon with `kind: operator` from the gateway,
  and the daemon logs that act. The snapshot itself is the daemon's state, which it also sends at each connect
  with no operator act.
- **The generation** is each repo's token number. It is not a number of the snapshot: the snapshot is complete,
  and the lines of one connection arrive in order. The service logs each repo's generation at each snapshot.
- **The field rules**:
  - `tokens` is a list; `repo` matches C11's scope pattern and is not `unread-repo`; a repo appears once;
  - `generation` is an integer from 1 to 2^53 - 1; `sha256` is 64 lowercase hex digits;
  - `previous` is `null` or an object with a lower `generation` and a `sha256`;
  - one hash appears once in the whole snapshot: not in two repos, and not as both a repo's current and its
    previous hash.

  A request that breaks a rule gets `bad request`, and the service keeps its old map.
- **A lower generation is allowed.** After a daemon crash between rotation steps 2 and 3 (section 6.5), the
  daemon sends the generation of its file, which is lower than the service's. The service applies it and logs
  "repo <key>: generation <n> after <m>".
- **The feature name** `mcp_tokens` goes into the service's hello. The daemon sends the op only to a service
  with the feature. A service with the MCP port always has it (stage 1d builds both).
- **The order at each connect**: `config`, `set_sessions`, then `mcp_tokens`.
- **The answer and its failure** (the daemon lead's change 2). The daemon checks each answer. A failure is
  `bad request`, an answer whose count is not the number of repos in the snapshot, or no answer in 5 s. At a
  failure:
  - the daemon writes no new token file, and it keeps the old token;
  - the Browser pane shows the failure on the repo's row, and `agentwatch health` shows it;
  - the daemon sends its current snapshot (the old tokens) again at once, and at each reconnect.
- **What the snapshot does at once**:
  - a repo that the snapshot drops: the service closes that repo's MCP connections and ends their MCP
    sessions, as at `session_ended` (section 7.3);
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
  - Claude Code: documented, not proven: it tries a dropped remote server again up to five times, with a delay
    that starts at 1 s and doubles each time, and it runs its helper at each new connection.
  - Codex: it keeps its headers, so the token is still right after the restart (no 401 comes, and none is
    needed). The service no longer knows the old MCP session id. Whether Codex then opens a new MCP session by
    itself is a stage 2 live check.
- **The daemon's restart.** The service keeps its last map, as it keeps the last `set_sessions` (C12, "when the
  daemon drops"). Admitted sessions go on. At the reconnect the daemon sends the full snapshot again, with each
  pending revoke (section 7.3).

### 6.5 A rotation while a session runs

The daemon's steps:

1. It mints the new token, in memory.
2. It sends `mcp_tokens` with the new hash and, as `previous`, the old hash. It waits for the answer (section
   6.3). At a failure it stops here: the new token is dropped, the old token stays, and the pane shows the
   failure.
3. It writes the new token file (the atomic write), and `state.json`.
4. After the overlap (60 s, a first value), it sends `mcp_tokens` with no `previous` for that repo.

What a running session does:

- During the overlap, the old and the new token both work.
- After the overlap, the session's next request with the old token gets a 401.
- Claude Code then runs `headersHelper` again, connects again and sends the call once more.
- Codex runs `http_headers_helper` again after the 401 to a POST, and it sends the POST once more, because the
  value changed. A 401 to its GET event stream gets no new run; its next POST gets one.
- The probe ran this order with a client that behaves in this way (section 15): 200, then 401, then the
  helper, then 200.

Why step 2 comes before step 3: a client that reads the new file must find its hash already in the service.
Why the overlap: a request in flight with the old token, and a client that read the old file just before step
3, keep working.

- When no service is connected, the daemon does steps 1 and 3, and it sends the snapshot at the next connect.
- A daemon crash between steps 2 and 3 leaves the old file. At its restart the daemon sends the old token as the
  current one, with a lower generation (allowed, section 6.3). The new token was never written, so nothing
  leaks.
- A daemon restart during an overlap ends the overlap early, because the daemon keeps the old hash in memory
  only. A client with the old token then gets a 401 and runs its helper again.

## 7. The operator's acts

### 7.1 Where

The Browser pane of the web viewer, with a password login. The gateway builds the operator provenance from the
credential, only after its password-login check, and it drops any `operator` key from the request body. A link
login is a test login, and agentwatch treats its acts as an agent's (`auth_link.py`): it cannot issue, rotate
or revoke. No CLI command, no API-token call, no agent and no other box can issue or rotate. `agentwatch
browser tokens` may show each repo key with its generation and its date, and never a token.

### 7.2 Issue, rotate, revoke (question B1, option a)

**The paths that add a site to a repo's list.** The daemon sends each list op on the control door itself and
reads its answer: the answer of `list_set` and of `prompt_allow` gives the list's entries after the change
(C12). So the daemon knows when a list gets its first site and when it loses its last site. Each of these
paths, with a password login, is an act of the operator:

1. the Browser pane's list edit (`list_set`);
2. the allow of a blocked-site prompt (`prompt_allow`, also its confirm path in the gateway);
3. the sign-in send (`import`). Today a sent site joins no list (the allowlist design's choice 6), so a send
   issues no token. If a later change lets a send add its site to a repo's list (its targets path), that send
   issues the token as an operator act, and the same test covers it.

On each path, the gateway builds the operator field from the credential and drops any `operator` key from the
body.

**The acts:**

- **Issue**: an operator act adds a site to a repo's empty list, and the repo has no token. The daemon issues
  the token. The pane then says: "This repo's agents get the agent browser's MCP from their next start.
  agentwatch made the repo's connection token."
- **Issue again**: "Issue token" on the row of a repo that has sites and no usable token. This is the act after
  "Remove token", after an upgrade or a switch-on (below), and after a list file changed by hand.
- **Rotate**: "New token" on the repo's row. The pane says: "The old token works for 60 more seconds. Running
  sessions switch to the new token by themselves."
- **Revoke**: "Remove token" on the repo's row. The repo's MCP stops at once. The repo's list stays.
- The pane shows each repo's generation and the date and user of its last issue or rotation. It never shows a
  token, so no screenshot of the pane holds one.

**No mint without an act.**

- At the switch-on (stage 3) and at the upgrade to this release, some lists already have sites. The daemon
  mints no token for them. Each such repo shows "Issue token" in the pane and gets no MCP entry until the
  operator acts.
- `agentwatch health` then says, in the daemon lead's words: "repo X has sites but no usable token: New token
  in the Browser pane". (The pane's button for a repo with no token is "Issue token"; the build gives the two
  texts one button name.)
- A list file changed by hand is no operator act. A hand edit issues no token and revokes none. The pane shows
  the repo's state: "Issue token" for sites with no token; a token with no sites gets no MCP entry (Q2) and the
  service's no-list 503 (step 8).

**A renamed repo.** A repo that GitHub renames gets a new repo key. Its old key's token stays valid, but no
session has that key, so no session can use it. The pane shows such a token as "not used: no session of this
repo key since <date>", with "Remove token".

### 7.3 What agentwatch does at a revoke

The causes of a revoke:

- the operator's "Remove token";
- an operator act removes the last site of the repo's list, or removes the list (question B1 a);
- the operator removes the repo's access (question B1 b);
- the uninstall of the agent browser (all tokens). Any agent of the user can run the uninstall (the same uid).
  Its effect only removes access, so it gives nobody a right.

`browser.enabled: false` and `browser.control: false` revoke nothing: they stop the browser or close it (C11's
503), and the tokens stay for the next start.

The daemon's steps, in this order, so that a crash cannot undo a revoke:

1. It removes the token file, and it records the revoke in `state.json` as pending.
2. It sends `mcp_tokens` without the repo. The service refuses the repo's requests at once, closes the repo's
   MCP connections and ends their MCP sessions.
3. At the service's answer (section 6.3), it marks the revoke done in `state.json`.
4. It logs one line: the user, the act, the repo key and the generation.
5. The next launch of a session of that repo gets no MCP entry.

- A crash after step 1: at its restart the daemon finds no file, so its snapshot has no hash for the repo. The
  revoke holds.
- A pending revoke: until the service acknowledges it, the pane shows "removal pending" on the repo's row,
  `agentwatch health` shows a line for it, and the daemon sends the snapshot again at each reconnect.
- The same order holds for the automatic revokes and the uninstall (the uninstall removes the files, then stops
  the service).
- A revoke during a tool call: the end of the repo's MCP sessions stops the running browser action with an
  error, as at `session_ended`. Unlike `session_ended`, a revoke does not close the scope's tabs, because the
  session still runs.

### 7.4 What an agent sees after a revoke

- Its open MCP connection closes. Its running call and its next call fail.
- The helper finds no file. It prints nothing on stdout, writes one line on its stderr ("this repo has no
  connection token: the operator removed it"), and exits with 1.
- Claude Code shows that the helper did not give a valid value. Codex's next POST gets a 401, its helper fails,
  and the call fails.
- A request with the old token gets the 401 `The agent browser does not know this connection token. The token
  changed or was removed: connect again.` No text names a stop or a start (I2).
- After a new issue: Codex recovers at its next POST with no restart (section 4.1). Claude Code runs its helper
  at its next connection (documented, not proven); stage 2 records when it does.
- The skill text tells the agent what to do: ask the operator for "Issue token" in the Browser pane, then ask
  for a restart of the session if the MCP does not come back.

## 8. Which sessions are allowed

- **Q2's answer stays the allow** (question B1 a): a session gets the entry when its scope has a list with at
  least one site and its repo has a usable token. The first site that an operator act adds issues the token.
- **A per-repo allow** (question B1 b): a switch in the Browser pane for each repo, "This repo's agents may use
  the agent browser's MCP". On issues the token; off revokes it. A repo with sites but with the switch off gets
  no entry and no token.
- **Sessions outside a GitHub repo** use the list `no-repo` (agentwatch's rule). If that list has a site, those
  sessions (for example a cron job of agentwatch) share the token of `no-repo`. Such a session is often rooted
  at the home folder; stage 2 proves that Claude Code runs its helper there (section 4.1).
- **A session whose repo is not known** (the list `unread-repo`) never gets a token or an entry: that list
  fails closed.
- **What an agent of a repo that is not allowed gets**: no entry at its launch, so it sees no browser tools.
  A request to the MCP port by hand gets the 401 (no token), the walk's 403, or the repo match's 403 (another
  repo's token).
- **A list change during a session** does not rewrite that session's entry (the decided rule). A repo whose
  list gets its first site after a launch: that session gets the MCP at its next launch.
- **The remote path** (a taylor session that uses the Mac's browser) has its own rule (section 10).

## 9. How agentwatch connects the MCP at a session's start

### 9.1 The rule

At each launch, agentwatch adds the agent browser's local entry only when all of these hold:

1. agentwatch launches the session, and `browser.enabled` is on with the switch on for the box;
2. the session's scope has a list with at least one site (Q2);
3. the session's repo has a usable token: its file exists and passes the mode checks;
4. the `LISTEN` line of `127.0.0.1:<port>` in `/proc/net/tcp` has the user's uid (else `agentwatch health`
   shows red);
5. the client has a header helper: Claude Code at or after the first version that stage 2's live check
   passes, Codex 0.159.3 or later. An older client gets no entry, and `agentwatch health` says why.

When rule 3 fails for a repo with sites, `agentwatch health` says "repo X has sites but no usable token: New
token in the Browser pane" (section 7.2).

The entry never goes into the user's global files and never into the environment (age-4ks).

### 9.2 The header helper

`agentwatch browser mcp-header --repo <repo key> --port <port> --tokens <tokens folder>`:

- It is a small entry point with standard-library imports only, as `secret_common.py` is, so it starts fast.
  The probe's helper of the same kind took 36 ms p50 (50.9 ms at most) through `sh -c`. Both clients give it
  10 s (Codex: its source; Claude Code: documented, not proven).
- `--tokens` names the absolute path of `tokens/agent-browser/`, because Codex runs the helper with a cleared
  environment (no `XDG_CONFIG_HOME`). A path is no secret. Stage 2 proves that the helper finds the folder in
  Codex's environment.
- It refuses when its stdout or its stderr is a terminal (`isatty`): it then writes one refusal line with no
  token ("this command gives a connection token only to an MCP client, not to a terminal") and exits 1. So a
  person or a pane never gets the token from it. An agent's shell tool gives it a pipe, so this rule does not
  stop an agent (section 12).
- It refuses with no `--repo`, and with a `--repo` that is not a repo key (exit 1).
- It opens `<tokens folder>/repos/<repo key>` with no link followed (`O_NOFOLLOW`), and it checks the open
  file: a regular file of the user, mode 0600, in folders of the user with mode 0700.
- It checks the URL that the header goes to. Claude Code gives it in `CLAUDE_CODE_MCP_SERVER_URL`: its origin
  must be `http://127.0.0.1:<port>`, with the port of `--port`. Codex gives no URL: there agentwatch writes the
  URL and the helper's command in the same launch, from one value of the port.
- It checks that the `LISTEN` line of `127.0.0.1:<port>` has the user's uid. So it never gives the header to
  another user's program on that port. On the Mac (stage 4) this check reads the sockets with `libproc`,
  through `ctypes` of the standard library.
- It prints `{"Authorization":"Bearer <token>"}` on its stdout, which is a pipe to the client, and exits 0.
- On any failure it prints nothing on stdout, writes one line with the reason and no token on its stderr, and
  exits 1.
- Its argv holds the repo key, the port and a folder path, which are not secrets. agentwatch writes each value
  shell-quoted (`shlex.quote`), as it does for `apiKeyHelper`, because both clients run the command in a shell.

### 9.3 Claude Code

agentwatch writes a file for the session, `CACHE_DIR/mcp/sessions/<scope>.json` (0600, in a 0700 folder; it
holds no secret), and passes it with `--mcp-config`, beside agentwatch's own question MCP:

```json
{"mcpServers":{"agent-browser":{"type":"http",
  "url":"http://127.0.0.1:<port>/mcp/<scope>",
  "headersHelper":"<helper command, shell-quoted>"}}}
```

agentwatch removes the file at the session's end. A session that runs with `--strict-mcp-config` (an
open-model profile) gets the entry in the same way, because `--mcp-config` carries it.

### 9.4 Codex

The decided rule (the service design's Q1 condition 4, C11) holds: Codex gets the entry by `-c` values for each
launch, never by a stanza in the user's `~/.codex/config.toml`. The `-c` values hold the helper's command,
which holds no token:

```
-c 'mcp_servers.agent-browser.url="http://127.0.0.1:<port>/mcp/<scope>"'
-c 'mcp_servers.agent-browser.http_headers_helper="<helper command, shell-quoted>"'
-c mcp_servers.agent-browser.tool_timeout_sec=120
```

Stage 2 must prove that `-c` values alone can define a new HTTP server with `http_headers_helper` (not only
change a server that a file defines), and that Codex counts it as local. If they cannot, the lead takes a new
question to the operator, with these options:

- the stdio bridge for Codex (question C c), if `-c` values can define a stdio server;
- a stanza in the user's `~/.codex/config.toml`, turned off and turned on by `-c` at each launch, as
  agentwatch's question MCP does: a change of the decided rule;
- no MCP for Codex sessions: they use the agent browser through `agentwatch browser` and the CDP endpoint.

### 9.5 The other forms (question C)

- **b. A local stdio bridge for both clients** (the daemon lead's first proposal). The entry names `agentwatch
  browser mcp --repo <repo key>`. The bridge reads the file at its start and at each 401, and speaks HTTP to the
  service with the header. Its effects: one form that works with any MCP client; one more process for each
  session; the client speaks stdio, so the operator's "http instead of stdio" holds only between the bridge and
  the service; the C11 rule "No stdio shim runs for it" changes.
- **c. The helper where stage 2 proves it, the bridge where it does not.** The fallback for either client: for
  Codex if its helper fails stage 2, for Claude Code if its trust rule stops the helper.
- **d. The token in the environment.** Both clients can read a header from an environment variable. It lifts
  "env: no" (age-4ks): every shell command of the agent then has the token, and one `printenv` writes it into
  the transcript.

### 9.6 What a running session does at a change

| Change | Claude Code (form 1) | Codex (form 1) | The bridge (form 5) |
| --- | --- | --- | --- |
| A rotation | after the overlap: a 401, the helper again, the call again; no restart | after the overlap: a 401 to a POST, the helper again, the POST again; no restart | a 401, the bridge reads the file again, the call again |
| A revoke | its connection closes; the helper fails; the calls fail | its connection closes; at each POST a 401, the helper fails; the calls fail | the same |
| A new issue after a revoke | its helper runs at its next connection (documented, not proven); stage 2 records it | its next POST gets a 401, the helper gives the new token, the POST goes again; no restart | the bridge reads the new file at the next 401 |
| The service's restart | a dropped connection; it connects again and runs its helper (documented, not proven) | its headers stay right; whether it opens a new MCP session is a stage 2 check | the bridge connects again |
| A failed first run of the helper | the connection fails; its later tries are a stage 2 check | the failure stays for the session's life: no request, no 401, no new run; a restart of the session is needed | the bridge tries at its next request |
| The list's first site after the launch | no entry until the next launch (the decided rule) | the same | the same |

Because a failed first run stays in Codex for the session's life, agentwatch writes no entry when rule 3 of
section 9.1 fails.

## 10. HTTP on this box, HTTPS to another box

**On this box: plain HTTP on `127.0.0.1`, no TLS.** Loopback traffic stays in the kernel. Another OS user can
read it only with root's rights, and root can read every token file too. A TLS layer on loopback would need a
certificate that both clients trust: a change of the system's trust store, or an environment variable for Node
(`NODE_EXTRA_CA_CERTS`). It adds no check. The token travels only in the `Authorization` header, never in the
URL.

**The token rule is for the local MCP port only.** The remote path takes no token.

**To another box: the agentwatch link's HTTPS (question D a).** The path of the service design's section 9
stays: a session on taylor, agentwatch's stdio program `agentwatch browser mcp --box <box>`, the remote MCP
socket of taylor's daemon (a 0600 Unix socket with the kernel's peer check and the Python walk), the link, the
Mac's daemon, the Mac service's agent door on the MCP path only.

- **Which taylor sessions get the remote entry.** Every session that agentwatch launches on taylor, while the
  browser grant is active and the grant's list on the Mac has at least one site (Q2 and Q3: one grant per box,
  one Mac list for all sessions of that box). taylor's own lists and tokens play no part.
- **On taylor.** The stdio program sends no token. The daemon's socket checks the peer and the walk: the walk
  names the session, and the daemon sends the request over the link with that name.
- **Where TLS ends.** The link calls `https://<label>.agentwatch.sh/...` (agentwatch's rule for outbound link
  calls: verified TLS, no redirects, no proxy environment). TLS ends at Cloudflare's edge, which holds the
  public certificate of `agentwatch.sh`. The system's root certificates check it. Cloudflare's tunnel then
  carries the request to the Mac gateway's tunnel-origin socket.
- **What the link adds.** Each request is signed with taylor's gateway key, which the Mac pinned at the link's
  approval, with a timestamp and a nonce. The MCP request and its answer are sealed to the other daemon's mail
  key, so Cloudflare sees no page text and no tool argument. The link's route refuses a request with an
  `Authorization` header or a cookie.
- **The grant.** The Mac's daemon checks the browser grant, `browser.use`, which the operator approves on the
  Mac's Links page, the quiet times, the size limit and the rate limit.
- **The clients do no TLS for the browser.** They speak to a local program or to `127.0.0.1`.
- **The Mac opens no port**, as section 9 says.

Options b and c of question D:

- b: the remote path also needs the session repo's taylor token. Then only a taylor repo with a site in
  taylor's own list (and so a token) can use the Mac's browser, and the Mac can cut one taylor repo. This turns
  Q3's "one grant per box" into a grant for each repo, and the Mac's daemon must learn taylor's hashes over the
  link.
- c: direct HTTPS from the taylor session's client to the Mac's `agentwatch.sh` address with the token. No
  stdio program on the remote path. But a copy of the token then works from any computer on the Internet until
  the operator removes it. agentwatch refuses its own API token through the tunnel for this reason
  (`server/auth.py`: "The API token works only on its own box."). It also needs a route on the Mac's gateway
  that takes a bearer.

**Stage 5** (ab-v16.94.7 and agentwatch's age-q8t.5) builds a test that no link request holds `abt1_`. The Mac
service's remote MCP path refuses a request that carries an `Authorization` header, so a token never reaches
the Mac by mistake.

## 11. The checks that stay, and the admission order

**What stays**: the uid check and the walk before any byte (C3's conditions); the `Origin` 403; the `Host`
check against DNS rebinding; the walk's refusal of a browser process; the port held by the socket unit; the
Mac's port closed until its reader exists; the path's scope as a label that must equal the walk's scope.

**What the token adds**: a check for each request, a revocation lever for each repo, and the repo match.

**The agent door** (CDP, the Unix socket) takes no token. The operator's answer names the MCP over HTTP or
HTTPS. The agent door keeps the kernel's peer check, and C11's sentence "No key, no token file and no
environment variable take part" stays true for it.

**The repo key of a session** (the daemon lead's change 4). `set_sessions` carries the daemon's repo key for
each session, in a new field `repo_key`. The service takes the key from there and never computes it a second
way: a key that the two sides computed apart would give a 403 on every request. A vector file of repo-to-key
pairs (for example `o/r`, a name whose `o.r` is longer than 64 characters, `null`) holds both sides to one
rule wherever the service names a list.

The admission of the MCP port, with the new step 7 (C11's list, renumbered):

1. The uid (before any byte).
2. The walk (before any byte). The connection's scope gives its session, and `set_sessions` gives the
   session's `repo_key`.
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
     client starts an OAuth login (stage 2's live check proves it).
8. The readiness and the scope's list: the 503s of C11's step 7 today.

Steps 1 and 2 run once for each connection. Steps 3 to 8 run for each request, so a revoke and the end of an
overlap act on the next request. A refused request never has its header in a log line or in an answer.

**What the repo match does.** The walk alone keeps repo A's agent out of repo B's scope: the walk gives each
connection its own session's scope, and step 6 refuses another scope. The repo match does a smaller thing: it
stops a repo with no access (one that the operator never allowed, or whose token the operator removed) from
using a token copied from another repo. Sessions of one repo share one token, and the walk keeps each session
in its own scope.

## 12. The secret rules and the log rule

**What the rules cover.** The rules cover every path that agentwatch or a client takes without being asked. On
those paths a token is never:

- in an argv: not of the client, the helper, the bridge, the service, the daemon or a test;
- in an environment: not of the session, its shell commands, the helper or the service;
- in a log line: not of the daemon, the gateway, the service, the helper or the clients' own logs;
- in a pane or a terminal: agentwatch prints it in no pane, terminal or answer, the Browser pane never shows
  it, and the helper refuses when its stdout or stderr is a terminal;
- in a URL: not in a path and not in a query;
- in git: the tokens folder is outside every repo, and the per-session entry holds only the helper's command;
- on the control door: only its SHA-256 crosses; and not in a `status`, an error text or a 401 body;
- on the link: question D a.

**The limit (the same-uid fact).** Every session of one OS user runs as one uid. An agent can read the token
file or run the helper with its own shell tool (it finds the command in its `--mcp-config` file or in its
command line). Then the token goes into the tool's output, the transcript, and the model's context, which the
client sends to its model provider. The rules cannot stop this. What keeps it small:

- a copied token works only from a session of its own repo on its own box (the walk and the repo match), so the
  copy gives that agent no new right;
- the helper's refusal of a terminal stops a print into a person's terminal or a pane, but an agent's shell
  tool gives the helper a pipe, so it does not stop an agent;
- the skill text tells agents never to run the helper and never to read the tokens folder;
- the operator's recovery: "New token" or "Remove token".

An open point for a later build (the daemon lead: "fine later"): the helper asks the daemon over its 0600
socket, the daemon walks the caller, and it gives only the walk's repo token, with no `--repo`. Its effect: it
stops the helper from giving another repo's token. It does not stop a read of the token file.

**The redactor.** agentwatch's redactor (`secret_patterns.py`) gets the prefix `abt1_` as a kind of token. It
covers what the daemon forwards: for example each hit of a transcript search, which the daemon redacts before
the hit leaves it. It does not cover a transcript file on disk, a client's own log, a pane on the screen, or
the copy at the model provider.

**The log rule.** The service's log of the MCP path holds a user, a scope, a repo key, a method and a result.
It never holds an `Authorization` header, a token or a hash (C11's log rule, extended).

How tests prove the rules (section 14 has the list):

- A canary token: the test store mints a known fake token, for example `abt1_` and 43 `C` characters.
- The scans look for the canary and for its SHA-256 (the daemon lead's change 3), in: every recorded spawn's
  argv and environment (the spawner tests already read the launch argv), the per-session `--mcp-config` file,
  the Codex `-c` values, every log record of the test (Python's `caplog`, the service's log sink), every C12
  line that the daemon sends (the hash may appear there, and only there), the service's answers and `status`,
  the Browser pane's API answers, and the helper's stderr. Each scan must find the canary nowhere. The scans
  use plain string search (`grep -F` in live checks).
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
- Section 7.1, provenance: "`kind: daemon` for the daemon's own ops: `config`, `set_sessions`, `session_ended`
  and `launch_check`." gains `mcp_tokens`. The table "Daemon to service" gains a row `mcp_tokens` (section 6.3),
  and its row `set_sessions` gains `repo_key`. The paragraph "When the daemon drops" gains "and the last
  `mcp_tokens` map".
- Section 8.3, the decision paragraph: "a per-session MCP configuration; and no secret. No stdio shim runs."
  becomes: "a per-session MCP configuration with no secret in it; the repo's token in the `Authorization`
  header, whose repo must equal the walk's repo (the token design)". The sentences "Board ab-v16.94.10 designs it
  before stage 1d builds the MCP; until then, this section is the record of the earlier reading." become a
  reference to this design.
- Section 8.4, "A key per session: not needed. ... and the operator rejected keys (ab-dm6)." becomes: "A token
  per repo: the operator's answer to ab-6ng, designed in the token design; the walk stays."
- Section 8.5: "The entry holds the URL with the session's scope (a label: the walk decides the scope) and no
  secret." becomes: the entry holds the URL and the header helper's command, and no secret. Add rules 3 and 5 of
  section 9.1. The sentence "(Claude Code: a generated file with `--mcp-config`; Codex: a `-c` override for each
  launch)" stays: this design keeps it.
- Section 9: after "the daemon then knows the session's name, and it sends each MCP request over the agentwatch
  link with that name." add "The remote path takes no repo token: the walk on taylor and the grant on the other
  box decide (the token design, question D)."
- Section 11, the row "Secrets": add "each repo's token lives only in its 0600 file under agentwatch's tokens
  folder; the service holds only its SHA-256". The row "Another OS user": add "the token files are 0600 in
  0700 folders; the helper checks the URL and the port's listener".
- Section 12, the row C3: "...a per-session MCP configuration; no secret." becomes "...a per-session MCP
  configuration with no secret in it; the repo's token in the `Authorization` header only, checked against a
  hash for each request, whose repo must equal the walk's repo."
- Section 19, Q1 condition 5: "No secret is in the URL or in the configuration. The scope in the path is a
  label: the walk decides the scope." becomes "No secret is in the URL or in the configuration; the token
  travels only in the `Authorization` header. The scope in the path is a label: the walk decides the scope."
- Section 19, Q1 condition 4: no change. Codex keeps "a `-c` override for each launch" (section 9.4).
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
  step 7 becomes step 8; step 2 takes the session's `repo_key` from `set_sessions`.
- "Steps 3 to 7 run for each request on the connection." becomes "Steps 3 to 8 ...".
- A new bullet: "At a C12 `mcp_tokens` snapshot that drops a repo, the service closes that repo's MCP
  connections and ends their MCP sessions; a running tool call stops with an error, and the scope's tabs stay."
- The limits: after "As on the endpoint, the check does not stop a hostile process of the same OS user." add:
  "The token does not change this: a process of the user can read every token file and run the header helper.
  The token's repo must equal the walk's repo, so a copied token works only from a session of its own repo."
- The log rule: "No log line of the MCP path holds a tool argument, page content, a cookie, a URL path or a
  payload" gains "an `Authorization` header, a token or a token's hash".
- "How a session gets the MCP": "only when the session's scope has a list with at least one site" gains "and
  the session's repo has a usable token (the token design)". New bullets: the header helper and its command; the
  client version rule; Codex's three `-c` values, with no stanza; no token in the
  entry. The sentence "For Codex it uses a `-c` override for each launch." stays.
- A new bullet: "The token rule is for the MCP port only. The remote MCP path takes no token."
- The table of parts at the top: a new row "The per-repo tokens: the daemon mints and holds, the service checks
  a hash (the token design)", from stage 1d (the service) and stage 2 (agentwatch).

**C12 (`docs/contracts/C12.md`).**

- The requests table: a new row `mcp_tokens` (section 6.3), with its answer `{"repos":<count>}`.
- The row `set_sessions`: each session gains `repo_key`, the daemon's repo key (section 11). The field rules:
  `repo_key` matches the scope pattern; the vectors gain it.
- The field rules: the rules of `tokens` (section 6.3), with one hash once in the snapshot and a lower
  generation allowed.
- Provenance: "`kind: daemon` for the daemon's own requests: `config`, `set_sessions`, `session_ended`,
  `launch_check`, and the daemon's own reads." gains `mcp_tokens`. "the daemon's own requests (`config`,
  `set_sessions`, `session_ended`, `launch_check`) only with `kind: daemon`" gains `mcp_tokens`.
- The hello's feature names: `mcp_tokens`.
- The data of `status`: "`mcp` is the MCP's state, for `agentwatch health`: `{"state":"<state>","address":<text
  or null>}`." gains `tokens_read` and `tokens` (a list of `{repo, generation}`).
- "When the daemon drops": "Chrome, the endpoint and the last `set_sessions` stay" gains "and the last
  `mcp_tokens` map".
- "No side logs page content, a cookie, a URL path or a payload in any log line." gains "a token or a token's
  hash".
- The vectors (`test/vectors/control.json`): an `mcp_tokens` line with fake hashes and its answer; bad lines (63
  hex digits, `unread-repo`, a repo twice, one hash in two repos, a hash both current and previous, `kind:
  token`, a `previous` with a higher generation); a lower generation that applies.
- The fake (`--fake`) has the op, as it has every op of the table.

**Stage 1d (ab-v16.94.5).** "no secret anywhere" becomes "the token step of the token design (step 7): the
`Authorization` header checked for each request against the hashes of C12's `mcp_tokens`, in constant time;
the token's repo (from `set_sessions`' `repo_key`) equal to the walk's repo; the texts; the 503 before the first
snapshot; the close of a dropped repo's connections; no token or hash in a log". It also waits for the
operator's answers to this design.

**Stage 4, the Mac (ab-v16.94.6).** No change to "the Mac's TCP peer reader (libproc) for the MCP, measured":
the Mac's MCP port stays closed until then. Add: the Mac's daemon mints the Mac's own repo tokens; the helper on
the Mac checks the port's listener with `libproc` through `ctypes`.

**Stage 5 (ab-v16.94.7).** Add: the Mac service's remote MCP path refuses a request with an `Authorization`
header (a test). agentwatch's side (age-q8t.5): the remote path takes no token; the remote entry goes to every
taylor session while the grant is active and its Mac list has a site; no link request holds `abt1_` (a test).

**agentwatch's side (the daemon lead's tasks; their texts are on agentwatch's board).**

- A new task (the daemon lead creates it when this design merges): the token store (mint, hold, rotate, revoke,
  the permissions sweep, the uninstall).
- age-q8t.1 (stage 2, the client and the switch): `mcp_tokens` in the client with its answer checks, the
  operator's acts and their provenance, the automatic revokes and the pending revoke, the overlap timer,
  `repo_key` in `set_sessions`, `agentwatch health`'s token lines.
- age-q8t.7 (the MCP entry writer and the helper): the header helper, the five conditions of section 9.1, the
  per-session file and its removal, Codex's `-c` values.
- age-q8t.5 (stage 5): section 10.
- age-q8t.6 (stage 6, cleanup): remove `tokens/agent-browser/`.
- The redactor (`secret_patterns.py`): the prefix `abt1_`.
- The skill text: what an agent does at a 401 or after a revoke, and that it never runs the helper or reads the
  tokens folder.

## 14. Tests

### 14.1 Unit tests, agent-browser (stage 1d)

- The admission vectors (the daemon lead's F11 list, plus the token cases): no header; an unknown token; another
  repo's token; the previous token during the overlap and after it; a dropped repo; the 503 before the first
  snapshot; each with the peer and a fake process table, so both sides test with a fake reader.
- `mcp_tokens`: its shape step, each bad line of section 13's C12 list (one hash in two repos, a hash both
  current and previous among them), `kind: token` refused, the old map kept after a bad request, a lower
  generation applied and logged, the answer's count.
- `set_sessions`' `repo_key`: the service uses it, and the repo-to-key vector passes on both sides.
- A revoke closes an open MCP connection of that repo, and no connection of another repo. A tool call that runs
  during the revoke stops with an error, and the scope's tabs stay.
- No byte of a request is read before steps 1 and 2 pass (a refused peer that sends a header gets closed with
  its 403 and no read).
- The constant-time compare: a spy shows that each request compares against every hash.
- The secret scans of section 12 over the service's log sink, its answers and its `status`, with their
  mutations.

### 14.2 Unit tests, agentwatch (the daemon lead)

- The store: the token's form (`abt1_`, 43 base64url characters, from `secrets.token_bytes(32)`); the hash
  input (lowercase hex SHA-256 of the ASCII bytes with the prefix); the modes, also after a test changes them;
  the permissions sweep over `tokens/agent-browser/`, `repos/`, each file and `state.json`; the atomic write; no
  link followed; `state.json` holds no token and no hash.
- The uninstall: a normal uninstall (not only `--purge`) removes `tokens/agent-browser/`, on Linux and on the
  Mac; `install.sh --update` keeps it; the file list of each vault or config sync leaves out the tokens folder.
- The redactor: a text with the canary comes out with the canary masked (kind `token`).
- The acts: a password login issues, rotates and revokes; a test login, the API token, an `operator` key in an
  HTTP body and a remote box get a refusal; each act sends the right snapshot; the order of a rotation (the
  hash first, then the file, then the end of the overlap).
- The paths that add a first site: the pane's list edit and `prompt_allow` (also its confirm path) each issue
  the token with a password login; a sign-in send issues none while a send joins no list; on each route the
  gateway drops an `operator` key from the body; a hand edit of a list file issues and revokes nothing.
- No mint without an act: a switch-on and an upgrade with lists that have sites mint nothing; the pane shows
  "Issue token" and the health line; "Issue token" after "Remove token" issues the next generation.
- The revoke: the file removed and the pending revoke recorded before the snapshot goes; a crash test between
  steps 1 and 2 (the daemon stops after step 1; at its restart the snapshot has no hash for the repo); the
  pending revoke sent again at each reconnect until its answer; the same order for the automatic revokes and
  the uninstall.
- The answer's failure: `bad request`, a count that does not match, and no answer in 5 s each leave the old
  file, show the failure in the pane and in health, and send the old snapshot again.
- The automatic revokes: the last site removed by an operator act, the list removed, the switch off (question
  B1 b), the uninstall.
- A renamed repo: the pane shows the old key's token as not used.
- The helper: each refusal (no file, a link, mode 0644, a folder of mode 0755, another uid's file, no
  listener, another uid's listener in a fake `/proc/net/tcp`, no `--repo`, a stdout or a stderr that is a
  terminal (a pseudo-terminal in the test), a `CLAUDE_CODE_MCP_SERVER_URL` with another origin); its output's
  form; no token on its stderr; its start time below 1 s; its command shell-quoted (a tokens path with a space
  and a quote).
- The entry writer: an entry only when all five conditions of section 9.1 hold; Codex's entry is only `-c`
  values, and no file under `~/.codex/` changes; the recorded launch argv and environment hold no canary; the
  per-session file holds no canary and no `Bearer`; the file is removed at the session's end.
- The C12 lines: the daemon's `mcp_tokens` line holds the canary's SHA-256 and never the canary; `set_sessions`
  holds each session's `repo_key`.
- The Browser pane's API: its answers (the rows, the generations, the failures) hold no canary and no hash.

### 14.3 The mutation for each rule

| Rule | The mutation | The test that fails |
| --- | --- | --- |
| Each request needs a token | step 7 removed | "no header" gets 200, not 401 |
| The repo match | the repo compare removed | "another repo's token" gets 200, not 403 |
| The overlap ends | `previous` kept after the snapshot without it | "previous after the overlap" gets 200, not 401 |
| Fail closed at the start | requests served before the first snapshot | the 503 vector gets 401 or 200 |
| A revoke acts at once | the close of the repo's connections removed | the open connection stays open |
| A crash does not undo a revoke | the snapshot sent before the file is removed | the crash test finds the hash after the restart |
| A failed answer keeps the old token | the new file written before the answer | the failure test finds the new file |
| Only the daemon sends tokens | `mcp_tokens` accepted with `kind: token` | the bad-request vector gets `ok: true` |
| One hash once | a hash in two repos accepted | its bad-request vector gets `ok: true` |
| The uid check and the walk first | the token read before steps 1 and 2 | the no-read test reads a byte |
| One repo key rule | the service computes the key itself | the repo-to-key vector fails for the long name |
| No token in a log | the header logged at a refusal | the log scan finds the canary |
| No token in an answer | the 401 echoes the header | the answer scan finds the canary |
| The file modes | the store writes 0644, or the sweep leaves out `state.json` | the mode test |
| No token in an argv or an environment | the entry writer passes the header in a `-c` value or an environment variable | the spawn scan finds the canary |
| No token on the door | the daemon sends the token, not its hash | the C12 line scan finds the canary |
| The operator alone issues | a test login may issue, or an `operator` key in a body counts | the provenance tests |
| No mint without an act | the daemon mints at the switch-on | the switch-on test finds a token file |
| The helper refuses a terminal | the `isatty` check removed | the pseudo-terminal test gets the header |
| The helper checks the listener and the URL | the uid check of the `LISTEN` line or the URL check removed | the helper prints for another uid's listener or another origin |
| The uninstall removes the tokens | the normal uninstall keeps `tokens/agent-browser/` | the uninstall test |
| The redactor knows `abt1_` | the prefix removed from the list | the redactor test |
| Each scan reads its text | a scan that returns no hit at all | its twin test with the planted canary |

### 14.4 The live check plan (local, on taylor)

It runs after stage 2, with the service in its `--test` mode on a free port and a free display, a test repo,
a test list with one site on a local test server, and a canary token that the daemon's test path mints. It
does not touch the operator's agent browser. Stage 3 runs it again on the real path with the operator's
approval.

**What it must prove** (the claims of section 4.1 that only documentation or source reading supports):

1. Claude Code runs the helper of a `--mcp-config` server with no prompt in an unattended session, also in a
   session rooted at the home folder.
2. Codex accepts `-c` values alone that define the server with `http_headers_helper`, counts it as local, and
   runs the helper for `http://127.0.0.1`.
3. The helper finds the tokens folder in Codex's cleared environment.
4. Each client's behaviour after a failed first run of the helper, after a service restart, and after a revoke
   followed by a new issue (section 9.6).
5. No client starts an OAuth login at the 401.

**The steps:**

1. agentwatch launches one Claude Code session and one Codex session of the test repo, unattended, each with a
   short task: navigate to the test site and report its title.
2. Both sessions reach the MCP. The service's log shows each admitted request with the repo key.
3. A plain string search (`grep -F`) for the canary and its hash finds nothing in: the launch argv and
   environment that agentwatch recorded; `/proc/<pid>/cmdline` and `/proc/<pid>/environ` of each client and of
   its shell commands; the daemon's, the gateway's and the service's logs; the sessions' transcripts; the pane
   captures; Claude Code's per-server MCP logs and its `--debug` file; Codex's trace log and its rollout files;
   `git status` and `git diff` of the test repo. (The hash may appear only in the C12 lines.)
4. An agent runs the helper: in one session, the task tells the agent to run the helper's command with its
   shell tool. The case records where the canary then appears (the tool output, the transcript), as the limit
   of section 12 says. The same command in a pane, with a terminal, gets the helper's refusal and no token.
5. "New token" from a test login gets a refusal (only a password login rotates). The check then rotates the
   token through the daemon's test hook. A call after 61 s works, and the service's log shows a 401 and then an
   admitted request with the new generation.
6. A revoke: the next call fails; the client's text is recorded for the skill. Then "Issue token" through the
   test hook: each client's recovery is recorded (point 4 above).
7. A second test repo's session runs `curl` with the first repo's token: 403 (the repo match). A command under
   `systemd-run --user --scope`, outside every session, with the token: the walk's 403.
8. A service restart and a failed first run of the helper (a token file with mode 0644 at the launch): each
   client's behaviour is recorded (point 4 above).
9. The measures: the helper's time at each connect, and the cost of the check for each request.

Another OS user is not used. The uid check stops that case, by the reasons of C11 (M2 reasoned it).

## 15. The probe

A small local probe ran on taylor (Node v26.12.0, Python 3.13.5) with fake tokens only, in a scratch folder.
Its code is not part of this design: stage 1d's tests replace it.

- `mint.py` makes a fake token for a repo key in a 0600 file in a 0700 folder. At an issue and a rotation it
  writes the hash snapshot first, then the file (the order of section 6.5). At a revoke it sent the snapshot
  before it removed the file: the old order, which section 7.3 changes. The probe tested no crash.
- `server.mjs` serves `127.0.0.1:<free port>`, holds only hashes (it reads the snapshot again at `SIGHUP`, as a
  C12 snapshot arrives), and checks `Origin`, `Host`, the path's scope, the bearer in constant time and the
  repo match (the walk is simulated with a scope-to-repo map). Its log holds no header.
- `helper.py` is the header helper of section 9.2 without the terminal and URL checks: the file checks, the
  `LISTEN` line's uid, the header on stdout.
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
answers and this design's merge. Each named requirement has its test in section 14.

| # | Side | Task and its named requirements | Tests | Waits for |
| --- | --- | --- | --- | --- |
| 1 | agent-browser | The contract texts: C11, C12 and the service design's sentences of section 13, for the answers; `repo_key` in `set_sessions`; the vectors (C12's `mcp_tokens` lines, the MCP admission vectors with the token cases, the repo-to-key vector) | the vector files' own tests; the fake runs the new C12 vectors | the answers |
| 2 | agentwatch (a new task) | The token store: mint and the hash input; the files, the atomic write and `state.json`; the permissions sweep over `tokens/agent-browser/`, `repos/`, each file and `state.json`; a normal uninstall (not only `--purge`) removes `tokens/agent-browser/` on Linux and the Mac, from this task on; `install.sh --update` keeps the tokens; no vault or config sync copies the tokens folder; the redactor's `abt1_` | section 14.2: the store, the uninstall, the redactor; the mode and sweep mutations | task 1 |
| 3 | agent-browser | Stage 1d (ab-v16.94.5) with the token step: the map from `mcp_tokens` and its field rules, step 7, `repo_key`, the texts, the 503, the revoke close (a running call stops, the tabs stay), the overlap, the log rule; the fake's op | section 14.1; the mutations of section 14.3; `npm test` under the heavy lock | task 1, stage 1a to 1c |
| 4 | agentwatch (age-q8t.7) | The header helper `agentwatch browser mcp-header`: the terminal refusal, the URL check, the listener check, `--tokens`, exit 1 with no `--repo`, the command shell-quoted | section 14.2, the helper | task 2 |
| 5 | agentwatch (age-q8t.1) | The operator's acts and the snapshot: the gateway builds the operator field from the credential and drops any `operator` key from the body on every route that adds a first site (the list edit, the prompt's allow and its confirm path, the sign-in targets path); "Issue token", "New token", "Remove token"; no mint at a switch-on or an upgrade, with the health line; the revoke order and the pending revoke; the answer's checks and failure; the automatic revokes; `mcp_tokens` at each connect and change; `repo_key` in `set_sessions`; the overlap timer; the renamed repo's row | section 14.2, the acts, the paths, the revoke, the failure; against `agent-browser service --fake` | tasks 2 and 3 |
| 6 | agentwatch (age-q8t.7) | The MCP entry writer: section 9's rule, the per-session file, Codex's `-c` values only (no stanza), the client version rule | section 14.2, the entry writer; the spawn scans | tasks 4 and 5 |
| 7 | agentwatch | The skill text: what an agent does at a 401 and after a revoke; never run the helper and never read the tokens folder | a review of the text against sections 7.4 and 12 | task 6 |
| 8 | both | The live check of section 14.4 (stage 2), with its five proofs and its leak scan; then stage 3 with the operator's approval. A failed proof of `-c` for Codex goes back to the operator (section 9.4) | section 14.4 | tasks 6 and 7 |
| 9 | agent-browser, agentwatch | Stage 4, the Mac (ab-v16.94.6, age-q8t.4): the `libproc` reader, then the Mac's MCP port opens; the Mac's tokens; the helper's listener check on the Mac through `ctypes` | the Mac checks, through the manager with the operator | task 8 |
| 10 | both | Stage 5 (ab-v16.94.7, age-q8t.5): no token on the remote path; the remote entry for every taylor session while the grant is active and its Mac list has a site; the Mac's refusal of an `Authorization` header on the remote path; no `abt1_` in a link request | the Python walk's cases; the remote cases; the two-box live check with the operator | task 9 |
| 11 | agentwatch (age-q8t.6) | Stage 6: remove `tokens/agent-browser/` with the old path's cleanup | the uninstall test | task 10 |
| later | agentwatch | The helper over the daemon's 0600 socket: the daemon walks the caller and gives only the walk's repo token; no `--repo` (section 12's open point) | the helper's cases with a fake walk | after task 8 |

With question C b (the bridge), task 4 becomes the bridge (`agentwatch browser mcp --repo <key>`: stdio lines
to HTTP requests and back, the file read at the start and at each 401), and section 14.2 gains its tests.

## 17. Questions for the operator

Five questions. The lead puts them on two board items (a board item holds at most four), so each question
stands alone. They cover the manager's four choices:

- the split of the auth surface: question A;
- who may mint a token: question A (which side's program makes it; the act is always yours, by the manager's
  rule);
- where a token lives: question A (it follows the side that keeps it); question C decides that it never goes
  into a client's own configuration;
- issue and rotation: questions B1 (what allows a repo and issues its token) and B2 (a rotation schedule).

Until you answer, nothing that fixes the MCP transport merges (the manager's rule), and no session gets the
agent browser's MCP. If you answer some questions and leave one open, its recommendation holds.

**A. Which side makes, keeps and checks each repo's connection token?**

Context: each repo gets its own connection token for the agent browser's MCP on each box, as you asked on
ab-6ng. A token is a secret.

Two facts first, in plain words:

- Every agent session of your OS user runs as that same user. So an agent can read every token file of that
  user, also another repo's file, and it can run the small command that gives a token. If an agent does that,
  the token goes into its transcript and into what the model sees. A copied token works only from a session
  of its own repo on its own box, so the copy gives that agent no new right.
- What keeps repo A's agent out of repo B's browser tabs is the agent browser's check of which session's
  program connects (the walk). The token adds a second rule: a token works only from a session of its own
  repo. That rule stops a repo that has no access (never allowed, or its token removed) from using a token
  copied from another repo.

- **a. agentwatch makes and keeps the token; the agent browser checks only its fingerprint (recommended).** At
  your act in the Browser pane, agentwatch makes the token. It keeps it in a file that only your OS user can
  read and write (mode 0600), in agentwatch's token store beside its other secrets. It sends only a fingerprint
  of the token (its SHA-256) to the agent browser, which checks each request against it. The agent browser
  never holds a token, so a fault in it cannot leak one. agentwatch gets one more small store of secrets.
- **b. The agent browser makes, keeps and checks the token.** agentwatch only passes your act (with your
  password login) and writes the session's MCP entry. The agent browser is more self-contained, and agentwatch
  holds no browser secret. But the agent browser then writes a secret file of its own, it must keep the
  fingerprints over its own restart, and agentwatch's programs must read a file of the agent browser. It goes
  against the daemon lead's rule that token files stay in agentwatch's token store.

Recommendation: a. No answer: a.

**B1. What allows a repo to use the agent browser's MCP, and so issues its token?**

Context: each repo gets its own connection token for the agent browser's MCP on each box. You alone issue and
remove a token, in the Browser pane with your password login. agentwatch never makes a token by itself: a repo
that has sites before this ships shows "Issue token" until you act.

- **a. The repo's list is the allow (recommended).** When you add a site to a repo's empty list in the Browser
  pane (also by the allow of a blocked-site prompt), agentwatch makes the repo's token. When you remove the
  last site or the list, agentwatch removes it. Each repo's row has "Issue token", "New token" (the old one
  works 60 more seconds, and running sessions switch by themselves) and "Remove token" (the repo's MCP stops at
  once). Your list stays the only place that allows a repo, as in your Q2 answer.
- **b. A separate switch for each repo.** A switch "This repo's agents may use the agent browser's MCP" in the
  Browser pane. On makes the token; off removes it. A repo with sites but with the switch off gets no MCP. One
  more act for each repo, and a second place that decides.

Recommendation: a. No answer: a.

**B2. Does agentwatch also make a new token on a schedule?**

Context: each repo has its own connection token for the agent browser's MCP. You can always make a new one with
"New token" in the Browser pane; the old one then works 60 more seconds, and running sessions switch by
themselves.

- **a. No schedule (recommended).** A token changes only when you act. No timer. A token that an agent copies
  into its transcript works, only from a session of its own repo, until you act.
- **b. A new token every 30 days** (a first value), which agentwatch makes by itself. Each such change is your
  choice by this policy, not a click. A copied token stops after at most 30 days. Running sessions switch by
  themselves. One more timer, and one more path that makes a token.

Recommendation: a, because a copied token gives no new right (it works only from its own repo's sessions on its
own box). No answer: a.

**C. How does a session send its repo's token to the agent browser?**

Context: each repo has its own connection token for the agent browser's MCP. agentwatch adds the MCP to an
allowed session when the session starts. Your words that this question rests on: "can we use http instead of
stdio?" (2026-11-09, recorded in the service design's section 2), your answer "HTTP" to ab-bi3 Q1 (2026-11-10,
recorded in its section 19), and "i prefer the agentbrowser is more self-contained. seems like a lot of moving
parts." Board item ab-6ng offered "HTTP on the private socket, with a small helper"; you chose neither offered
option there and asked for tokens. Your words do not clearly choose between the options below, so this is your
choice.

- **a. Direct HTTP with a header helper, for Claude Code and for Codex (recommended).** The session's MCP entry
  holds the address and a short agentwatch command. The client runs the command at the start and after a
  refused request, and it sends the token only in the request's Authorization header (the part of each request
  that carries a credential). The token is in no command line, no environment, no entry and no address. No
  extra program runs for the session. The fewest moving parts: one short command run at each connection, and
  no process for each session. Both clients have this feature now (Claude Code `headersHelper`; Codex 0.159.3
  `http_headers_helper`). Stage 2 checks it live; a client without it gets no MCP entry.
- **b. A small local program between the client and the agent browser, for both clients (a stdio bridge; the
  daemon lead's first proposal).** The entry names an agentwatch program. The program reads the token and
  speaks HTTP to the agent browser. One form that works with any MCP client. More moving parts: each session
  runs one more program (a similar Node program used about 66 MB of memory), and the client speaks stdio
  again, against your "http instead of stdio".
- **c. a where stage 2 proves it, b where it does not.** The fallback for either client: Codex if its command
  does not work, Claude Code if its trust rule stops the command. Moving parts as b, but only for that client.
- **d. The token in the session's environment.** Both clients can read a header from an environment variable.
  It lifts your "env: no": every shell command of the agent then has the token, and one `printenv` writes it
  into the transcript. Moving parts as a.

Recommendation: a (with c as the fallback that stage 2's check can need). No answer: a.

**D. Where does a repo's token work, and how does a session on taylor use your Mac's browser?**

Context: each repo has its own connection token for the agent browser's MCP on each box. A session on taylor can
use your Mac's agent browser through the agentwatch link, under one browser grant for the whole box and one Mac
list (your Q3 answer).

- **a. The token works only for the local MCP on its own box; the other box needs no token (recommended).** On
  this box the token adds to today's checks, and it works only from a session of its own repo. A session on
  taylor that uses your Mac's browser goes through the agentwatch link, as the service design's section 9
  says: taylor's daemon checks which session's program connects; the link carries the request over HTTPS,
  signed with taylor's link key and sealed for the Mac's daemon; the Mac checks your browser grant. Every
  taylor session gets the Mac's MCP while the grant is active and its Mac list has a site; taylor's own lists
  and tokens play no part. No token leaves taylor, so a copy works nowhere else. That path keeps agentwatch's
  small stdio program on taylor, because the Mac opens no port. The Mac's own MCP stays closed until the Mac's
  code that tells which program connects (its peer reader) is built and measured.
- **b. The remote path needs the taylor repo's token too.** Then only a taylor repo with a site in taylor's own
  list can use your Mac's browser, and you can cut one taylor repo on the Mac. This turns your "one grant per
  box" into a grant for each repo, and the Mac must learn the fingerprints of taylor's tokens.
- **c. Direct HTTPS to the other box.** A taylor session's client calls the Mac's agentwatch.sh address with the
  token, with no program between. But a copy of the token then works from any computer on the Internet until
  you remove it. agentwatch refuses its own API token through the tunnel for this reason.

Recommendation: a. No answer: a.

## 18. Limits and open points

- **The same-uid limit** stays (section 5). This design does not claim repo isolation from the token.
- **An agent can copy its own token** (T9, section 12): it can run the helper or read the file, and the token
  then goes into its transcript and the model's context. The copy gives no new right. Open point: the helper
  over the daemon's socket (section 16, the later task) stops the helper from giving another repo's token, but
  not a read of the file.
- **The clients' helpers are new features.** Section 4.1 marks each claim with its source. Stage 2's live check
  proves the five points of section 14.4. Question C c is the fallback. A failed proof of `-c` for Codex goes
  back to the operator (section 9.4).
- **The agent door (CDP)** takes no token (section 11). If the operator wants a token there too, that is a
  later design.
- **The remote path keeps a stdio program** on taylor (question D a). An HTTP door in taylor's daemon would
  remove it, at the cost of a TCP port and a TCP walk in agentwatch. That is a later design.
- **Small leaks** (section 5): the step 7 403 tells a caller that its token is valid for another repo; the
  helper's command line names the repo key to every OS user on taylor.
- **Two texts to agree** (section 7.2): the health line keeps the daemon lead's "New token"; the pane's button
  for a repo with no token is "Issue token". The build gives them one name.
- **First values**: the overlap (60 s), the answer's limit (5 s), question B2 b's interval (30 days), the
  helper's time limit (the clients' 10 s). The build measures and records them.
