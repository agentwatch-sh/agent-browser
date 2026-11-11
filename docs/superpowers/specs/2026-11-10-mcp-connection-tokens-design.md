# Connection tokens for the agent browser's MCP: one for each session — design

**Status: Decided: the operator's answers of 2026-11-10 (section 17).** The operator answered this design's
questions (A, B1, B2, C, D and E), the address question and the Cloudflare question on five board items
(ab-0wv, ab-sxg, ab-ufy, ab-5t3, ab-h93) on 2026-11-10. The design records the answers and fits them. Nothing that
fixes the MCP transport merges before this design's merge (the manager's rule).

Date: 2026-11-10. Author: a taylor contributor, a design subagent of the lead (board task ab-v16.94.10, epic
ab-v16.94). Branch `ab-v16.94.10-mcp-tokens-design` in agent-browser, from main `3fe1427`. Revisions: the first
design; one fix round after a fresh review (review-103) and the daemon lead's read; a narrow re-check
(review-103b); a revision after the operator's answers; and the last text round after a fresh review of that
revision (review-103c), the daemon lead's read of it and the answers to ab-h93. The file name keeps the first
title ("per-repo"):
by the answers, each session gets its own token. No product code and no contract file changes in this task:
section 13 names each sentence that a later task changes.

Evidence:

- the installed clients on taylor: Claude Code 2.1.286 and Codex 0.159.3 (their help texts, the text in their
  binaries, Codex's source at its tag `rust-v0.159.3`), and the public documentation of both;
- agentwatch's code on taylor, read only (commit `6fead11c` for the first revision; commit `3efa2cc7` for this
  revision: the Codex launch shape, the Codex homes and the lifetime id);
- the earlier revision's local probe with fake tokens (section 15).

No claude or codex session ran. Nothing ran on the Mac. Section 4.1 marks each client claim that only
documentation or a source reading supports. Stage 2's live check proves them (section 14.4).

This design builds on the service design
([2026-11-09-self-contained-agent-browser-design.md](2026-11-09-self-contained-agent-browser-design.md),
"the service design" below) and on the contracts `docs/contracts/C11.md` and `docs/contracts/C12.md`. It keeps
every decided rule of those documents, except the rules that the operator's answers to board items ab-6ng,
ab-0wv, ab-sxg, ab-ufy, ab-5t3 and ab-h93 change (section 2).

## 1. The answer in short

1. **A token for each session.** agentwatch's daemon mints a fresh token for each session that it launches
   while the session's repo's list has a site (the operator's answers A and B2). A token is `abt1_` and 43
   base64url characters (32 random bytes). It ends with its session. There is no long-lived repo token, no
   schedule and no rotation.
2. **The list is the allow (B1, option a).** A session gets the agent browser's MCP only while its repo's list
   has at least one site. A site from a blocked-site prompt counts. The operator's act is the list, and
   agentwatch mints at each start. By the operator's own answers, this replaces the manager's earlier rule "the
   operator alone issues and revokes a token" (section 2). The Browser pane has no token buttons. It shows which
   live sessions have the MCP (section 7.5).
3. **The token is in the header of the session's own MCP entry (C and ab-ufy).** No header command, no bridge,
   and no token in an argv or an environment. Each run of a session gets a new random name (32 hex digits).
   Claude Code: `--mcp-config` names the session's file `tokens/agent-browser/sessions/<random name>.json`
   (0600). Codex: `-p aw-<random name>` selects a profile whose file in the Codex home is a symbolic link to
   `tokens/agent-browser/sessions/<random name>.toml` (0600). The file holds the URL, the `Authorization` header
   and the run's lifetime id, so no command line holds a lifetime id. agentwatch writes the file before the
   launch, and it removes the file and the link at the session's end. A sweep removes what a crash leaves.
4. **A fact for Codex (question E, answered a).** agentwatch runs most Codex sessions with a per-session Codex
   app server, and the app server makes the session's MCP connections. Codex 0.159.3 refuses `--profile` for its
   app server, and its terminal program does not pass a profile's MCP servers to the app server. So the profile
   gives the MCP only to a Codex session that runs without the app server. By the operator's answer E a, a Codex
   session with the app server gets no agent browser MCP until a Codex release lets the app server read a
   profile. Until then it keeps the browser through Playwright, and nothing new is built.
5. **The service sees only a fingerprint.** The fingerprint is the SHA-256 of the token. It rides in C12's
   `set_sessions`, on the session's own item (a new field `mcp_token`). The earlier op `mcp_tokens` goes. The
   service checks each MCP request: the SHA-256 of its bearer must equal the fingerprint of the walk's session,
   in constant time.
6. **The checks that stay.** The uid check and the walk before any byte, `Origin`, `Host`, the path's scope and
   the held port stay. The token adds to them. A token works only from its own session, and only while that
   session runs.
7. **The same-uid fact.** Every session of one OS user runs as one uid. So an agent can read its own entry file
   and every other session's entry file of that user. The token then goes into its transcript and the model's
   context. The copy gives that agent no new right: the walk and the token bind the token to one session, and the
   token ends with that session.
8. **Another box (D, option c, and the address check of ab-5t3).** A session's client calls the serving box's
   `agentwatch.sh` address directly over HTTPS, with a remote token of its own in the header. The serving box's
   gateway takes the token only on `/mcp/<box>/<session>`, only from the calling box's known IPv4 and IPv6
   addresses, and passes it unread to its service. The service checks the fingerprint. The calling box's daemon
   mints the remote token at the session's start and sends only the fingerprint over the link (the
   recommendation of section 10). The serving daemon takes the box of each list from the link's peer identity,
   and it checks each calling box's list before it uses it: a bad list drops all fingerprints of that box alone.
   TLS ends at Cloudflare's edge, so Cloudflare sees each remote MCP request in clear: the token, the tool
   arguments and the page text. The operator chose this route with that fact (ab-h93), and the address check
   stays.
9. **The secret rules.** A token is never in an argv, an environment, a log line, a URL, git, a status, or a
   pane or a terminal that agentwatch writes. Only its fingerprint crosses the control door and the link. The
   token lives only in the session's entry file and in the client's memory. Tests scan for a canary token and its
   fingerprint, also in both clients' MCP and debug logs. A mutation of each scan shows that the scan finds a
   planted token.
10. **Questions.** All questions have the operator's answers (section 17): A, B1, B2, C, D, E, the address
    question and the Cloudflare question. No question is open.

## 2. The operator's words and the rules

The operator, board item ab-6ng, 2026-11-10, confirmed:

> "let's have agentwatch connect the mcp for sessions that are allowed to use the agentbrowser on startup. i
> want to reverse the 'no token' guidance i gave earlier. each repo gets its own connection token to
> authenticate over http/https. we need to figure out how to split the auth surface between agentwatch and
> the agentbrowser."

The operator's answers to this design's questions (2026-11-10, each confirmed on its board item):

- **A, who keeps the token** (ab-0wv, 13:24Z), free text: "agentwatch mints the token and inserts it into the mcp
  configuration i think. can we do that? so it gets generated when the session starts." The reading: yes.
  agentwatch's daemon mints the token and writes it into the session's MCP entry.
- **B1, what allows a repo** (ab-0wv): option a. The repo's list is the allow. Its first site, also a site from a
  blocked-site prompt, allows the repo.
- **B2, a schedule** (ab-0wv), free text: "mint the token when the agentwatch session begins." The reading: each
  session gets a fresh token when it starts, and the token ends with the session. No long-lived repo token, no
  schedule and no "New token".
- **C, how a session sends its token** (ab-sxg, 13:12Z), free text: "can't we put the token in the MCP call in the
  header? i think mcp protocol supports this. so it would be no extra command. it would just be in the headers."
  The lead's reading, on board item ab-ufy: a fixed `Authorization` header in each session's own MCP entry, and
  no header command. The operator (ab-ufy, 13:27Z): "keep it. token goes in the mcp header."
- **D, where a token works** (ab-sxg): option c, "Direct HTTPS to the other box" ("No program between, but a copy
  of the token then works from any computer on the Internet until you remove it.").
- **The address check** (ab-5t3, 13:26Z), free text: "you can use an IP allowlist as long as you have the ipv4
  and ipv6 of each daemon." The reading: the serving box takes a remote token only from the calling box's known
  addresses, IPv4 and IPv6 both. A second reading: a family in the state "none" (the box reports that it has no
  global address of that family) counts as known. This reading adds no address that can match (section 10).
- **E, Codex's app server** (ab-h93, 18:06Z): option a, "Wait for a Codex release that lets the app server read a
  profile" ("Those sessions keep the browser through Playwright, with no MCP, until then. Nothing new is built,
  and your "no extra command" stays.").
- **The Cloudflare question** (ab-h93, 18:06Z): option "Keep direct HTTPS through Cloudflare" ("No program
  between. Cloudflare sees the token, the tool arguments and the page text of each request. The address check
  stays."). The operator chose it against the recommended link path, with the fact that the earlier text of D c
  left out (section 10).

"each repo gets its own connection token" (ab-6ng) holds in this form: each session's token is its own, so no two
repos, and no two sessions, share a token.

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
- Codex notice parity (agentwatch's board age-ggp): "The app server first". It matters for question E.

The manager's rules (they count as the operator's):

- The token choices were the operator's design choices: how a token is issued and rotated, where a token lives,
  who may mint one, and the split of the auth surface. The operator answered them (above).
- A token is a secret: never in an argv, a log line, git, the terminal or a URL; only in 0600 files or
  agentwatch's secret store. This rule stays.
- "The operator alone issues and revokes a token": the operator's own answers change it. The operator's act is
  now the allow, the repo's list. agentwatch mints at each session's start ("so it gets generated when the
  session starts", "mint the token when the agentwatch session begins"), and the token ends with the session.
  No other act mints, and no agent, no CLI call, no API-token call and no other box can mint a token for a
  session that agentwatch does not launch.
- No merge that fixes the MCP transport before this design has the operator's answers and is merged.
- The address check changes what the operator chose for D, so it went to the operator as a question (ab-5t3),
  after the daemon lead confirmed that the serving box can see the caller's address through the tunnel. The
  operator answered it.

**The token store.** The tokens folder (0600 files in 0700 folders, `~/.config/agentwatch/tokens/`) is
agentwatch's token store for durable credentials: the API token, the account logins and the Codex account
homes are there. The session entry files go into it, in `tokens/agent-browser/sessions/`. It is the place that
the manager's rule allows ("only in 0600 files"). It is not the mail secret store (`daemon/secret_store`).

The daemon lead's input (board task ab-v16.94.10, its comments; data for the design, not a decision):

- The same-uid fact (item 7 of section 1).
- The first constraints: no secret in an argv, the environment, a log line, the terminal, a pane or a URL;
  token files only under `~/.config/agentwatch/tokens/` (0600 files, 0700 folders, modes applied again at each
  write); Claude Code's `--mcp-config` with `headers` works, but the agent can read that file; the root gateway
  never reads a user's token files.
- The read of the first revision: six changes. What stays of them after the answers: the fingerprint input
  (change 3), the permissions sweep and the uninstall (change 6), the plain statement of what an agent can copy
  (change 1), and the answer check at a failure (change 2, now on `set_sessions`). The answers remove the
  rest: the "Issue token" health line and the upgrade rule (change 5) and `repo_key` (change 4, see section 11).
- The constraints for this revision (the mail of 08:15, seven points). Points 1 and 2 (the entry files, the
  Codex profile link, the cleanup and the sweep) are sections 9 and 6.5. Point 3 (the leak scan of both clients'
  logs) is section 14.4. Point 4 ("New token" stops running sessions) falls away: there is no "New token". Points
  5 and 6 (the gateway route; who mints a remote token) are section 10, with this design's recommendation for
  point 6. Point 7 (the address check) is section 10.
- The read of the revision (1dc6e66): the daemon lead agrees with `mcp_token` on `set_sessions` and takes (i),
  the calling box mints (section 10). Three additions: the service's `bad request` answer never echoes the
  snapshot (sections 6.3 and 13); the serving daemon takes each remote item's box from the link's peer identity
  (section 10); and a random name for each run in the entry file's name and the Codex profile's name (sections 3
  and 9.2).

## 3. Words

- **The service**: `agent-browser service`, the agent browser's one process for each OS user and box.
- **The daemon**: agentwatch's per-user daemon.
- **A lifetime id**: agentwatch's id of one run of a session (a UUID from `uuid4`), which C12's `set_sessions`
  already carries. A new run of a session gets a new lifetime id (C12: "A new run of a session comes with a new
  `set_sessions` that carries its new `lifetime_id`"). No file name, no profile name and no command line holds
  it (the daemon lead's addition).
- **The random name**: a new random name for each run of a session, 32 lowercase hex digits
  (`secrets.token_hex(16)`). It names the run's entry file and its Codex profile (`aw-<random name>`). The map
  from each random name to its run's lifetime id is in the daemon's own index file, `tokens/agent-browser/sessions/index.json` (0600,
  written atomically), and in the daemon's memory; no client file holds a lifetime id (the daemon lead's
  recommendation, section 9.2).
- **A token**: a session's connection token: `abt1_` and 43 base64url characters (32 random bytes). A session
  has a local token, and one remote token for each serving box whose entry it gets.
- **A fingerprint**: the lowercase hex SHA-256 of the token's ASCII bytes, with the `abt1_` prefix (the daemon
  lead's change 3).
- **The entry**: a session's MCP server entry, which agentwatch writes before the launch, with the token in its
  `Authorization` header.
- **The entry file**: the 0600 file that holds a session's entries (no lifetime id; the index holds the map):
  `~/.config/agentwatch/tokens/agent-browser/sessions/<random name>.json` for Claude Code and
  `.../<random name>.toml` for Codex.
- **The profile link** (Codex): `$CODEX_HOME/aw-<random name>.config.toml`, a symbolic link to the session's
  `.toml` entry file, in the session's own Codex home.
- **The app-server launch** (Codex): agentwatch's usual Codex launch, a per-session `codex app-server` with the
  Codex terminal program (the TUI) connected to it by `--remote` (`daemon/spawner.py`, `_wrap_codex_app_server`).
  **The standalone launch**: the TUI alone, which agentwatch uses for an open-model session and for a resume in a
  mode that the remote TUI cannot carry (`_CODEX_STANDALONE_MODES`).
- **The calling box** and **the serving box**: on the remote path, the box whose session calls, and the box whose
  agent browser serves.
- **The walk**, **a root**, **a scope**: as in C11. A remote scope is `<box>/<session>` (the service design,
  section 9).

## 4. What the two clients can carry

### 4.1 The facts

Each claim names its source. "Documented, not proven" means that only the client's documentation supports it.
"Source, not proven" means that only a reading of the client's source at its tag supports it. Stage 2's live
check proves both kinds (section 14.4).

**Claude Code 2.1.286.**

- `--mcp-config <configs...>` loads MCP servers from JSON files or strings (the help text). agentwatch passes a
  file today (`daemon/spawner.py`, `_question_mcp_args`). The file's path in the argv holds no secret.
- An HTTP server entry can have `headers`, static values (the documentation and the binary's text).
- `${VAR}` in a header reads the environment (forbidden here). A token never holds `$`, so a literal token is
  never read as a variable. `claude mcp add --header` and a JSON string to `--mcp-config` put a header in an
  argv (forbidden here).
- Documented, not proven: Claude Code tries a dropped remote server again up to five times, with a delay that
  starts at 1 s and doubles each time.
- A server from `--mcp-config` has the scope `dynamic` in the binary's code. A session that runs with
  `--strict-mcp-config` (an open-model profile) gets the entry in the same way.
- Not known yet: whether Claude Code writes an `--mcp-config` server's headers into a log, its `--debug` file,
  its transcript or its `/mcp` view; whether it tries an OAuth login at a 401 when a static `Authorization`
  header is present; which server wins when a user's own configuration has a server of the same name; and
  whether it takes the entry file's top-level key `agentwatch` beside `mcpServers` (section 9.2). Stage 2 checks
  each one.

**Codex 0.159.3.**

- The configuration of a Streamable HTTP server has `url`, `http_headers` (static values),
  `env_http_headers` and `bearer_token_env_var` (the environment), and `http_headers_helper` (a command). A
  `bearer_token` key is refused for a Streamable HTTP server: the source at the tag
  (`codex-rs/config/src/mcp_types.rs`) throws "streamable_http ... bearer_token". So the entry uses
  `http_headers`. A `-c` value holds its text in the argv (forbidden for the header).
- **The profile (profile v2).** `-p, --profile <name>`: "Layer $CODEX_HOME/<name>.config.toml on top of the base
  user config" (the help text). From the source at the tag:
  - a profile name has only ASCII letters, digits, `_` and `-` (`ProfileV2Name`), so `aw-<random name>` passes;
  - a profile file that does not exist reads as an empty layer, with no error (`config/src/loader/mod.rs`);
  - Codex refuses the launch when the base `config.toml` has a legacy `[profiles.<name>]` table or
    `profile = "<name>"` with the same name;
  - Codex writes its own config edits of the session (for example a model choice) into the selected profile
    file (`ConfigEditsBuilder::for_config`, the user config file of the layer stack);
  - its writer follows a link chain to the link's target (`resolve_symlink_write_paths`), and it writes the
    target through a temp file in the target's folder and a rename (`write_atomically`, `NamedTempFile`). So the
    link stays, the token stays under the tokens folder, and a crash during such a write can leave a temp file
    (`.tmp` and random characters) beside the entry file. The temp file's mode is the tempfile crate's 0600
    (stage 2 checks the mode after a write);
  - the writer parses the file into a `toml_edit` document, applies its edits and writes the document back
    (`core/src/config/edit.rs`, `apply_blocking_to_resolved_file`). One edit replaces the whole `mcp_servers`
    table (`replace_mcp_servers`). Source, not proven: a comment at the document's end stays after such a write
    (section 9.2);
  - a key that Codex does not know in a user file gives a startup warning (`ignored_config_warning`), and
    Codex's strict mode refuses it (`config/src/loader/mod.rs`, `strict_config`). So the `.toml` entry file holds
    no key of agentwatch's own;
  - Source, not proven: Codex reads a linked profile file (the reader opens the path, which follows the link).
    The daemon lead's words: "If Codex refuses a symlinked profile file, say so and we re-decide."
- **Which commands take a profile.** The source at the tag (`cli/src/main.rs`, `profile_v2_for_subcommand`)
  allows `--profile` for the TUI, `exec`, `review`, `resume`, `queue`, `archive`, `delete`, `unarchive`, `fork`,
  `mcp`, `sandbox` and `debug prompt-input`. For every other command it stops with "--profile only applies to
  runtime commands and `codex mcp`". `app-server` is not in the list. The designer's own reading, not in the
  evidence that the review had: the installed binary's text holds the same refusal, with the same list of
  commands, and the `app-server` command's help shows no `--profile` option.
- **The app-server launch** (Source, not proven):
  - the app server builds its configuration with the default loader (`LoaderOverrides::default()`), so its only
    user layer is `$CODEX_HOME/config.toml`. A test hook for another user file exists only in a debug build
    (`app-server/src/lib.rs`, `debug_assertions`). The designer's own reading, not in the evidence that the review
    had: the installed binary's text does not hold that hook's warning;
  - the TUI with `--remote` sends to the app server only a fixed list of its session-flag keys
    (`tui/src/app_server_session.rs`, `config_request_overrides_from_config`: `allow_login_shell`,
    `default_permissions`, `features`, `network`, `permissions`, `sandbox_workspace_write`,
    `shell_environment_policy`, `suppress_unstable_features_warning`, and the model settings). It sends no
    `mcp_servers` key from the profile, and a profile is a user layer, not a session flag;
  - `thread/start` takes an MCP entry for each thread: its `config` map takes any config key
    (`app-server-protocol/src/protocol/v2/thread.rs`), and in remote mode the TUI sends its own task-tools server
    there (`mcp_servers.codex_tui`, `tui/src/app_server_session.rs`). Only the program that starts the thread can
    use that map, and that program is the TUI, not agentwatch;
  - so a `-p` on the TUI gives the app server no agent browser entry. agentwatch's own question MCP shows the same
    shape: agentwatch passes its `-c mcp_servers.agentwatch.enabled=true` "on both the TUI and its app server"
    (`_question_mcp_args`).
- agentwatch uses the app-server launch for each Codex session when the Codex binary supports it, except for an
  open-model session and a resume in a standalone mode (`daemon/sessions.py`). The app server carries Codex
  notice parity ("The app server first").
- A `-p` and a `-c` key outside a short list both keep Codex off its shared background server
  (`tui/src/daemon_startup.rs`). agentwatch's launches already pass such `-c` values, so a profile changes
  nothing there.
- Codex's default shell environment policy removes variables whose names match `*KEY*`, `*SECRET*` or `*TOKEN*`
  from the agent's shell commands. This design does not use it: the token stays out of every environment
  (age-4ks).
- OAuth (`codex mcp login`) stores credentials for each Codex home; the service would have to be an OAuth
  server. Not used here.

**The Codex homes.** A Codex session runs with `CODEX_HOME` at `~/.codex` or at an account home,
`~/.config/agentwatch/tokens/codex/<name>/`, which links a fixed list of entries (`config.toml` among them) to
`~/.codex` (`accounts/codex_home.py`). A profile link goes into the session's own home. An account home does not
share the `aw-<32 hex digits>.config.toml` links, because they are not in its list of shared entries.

**taylor.** `/proc` is mounted with no `hidepid`, so every OS user can read every process's command line. A
token in an argv is a token for every user of the box. The entry file's path and the profile name show the run's
random name to every OS user, and no lifetime id (section 5, the small leaks).

### 4.2 The entry forms for each client

| Form | Claude Code 2.1.286 | Codex 0.159.3, standalone launch | Codex 0.159.3, app-server launch | Where the token lives | The operator's answers and the rules | State |
| --- | --- | --- | --- | --- | --- | --- |
| 1. A static header in the session's own entry file under the tokens folder (chosen) | `--mcp-config <sessions>/<random name>.json`, `type: http`, `url`, `headers` | `-p aw-<random name>`; the profile link to `<sessions>/<random name>.toml`, with `url` and `http_headers` | does not reach the MCP: the app server takes no profile, and the TUI passes no `mcp_servers` from the profile (by the answer E a: no entry until a Codex release lets the app server read a profile) | the entry file (0600 in 0700 folders) and the client's memory | the answers C and ab-ufy; "http instead of stdio" kept; no new process | chosen (Claude Code, Codex standalone) |
| 2. A header from a command (the earlier recommendation) | `headersHelper` | `http_headers_helper` | `http_headers_helper` in a `-c` value of the app server | a token file; the command prints it | against "no extra command" (C) | not chosen; question E b offered it for Codex's app server only, and the operator chose E a |
| 3. A static header in the shared Codex `config.toml` | — | `http_headers` in `~/.codex/config.toml` | the same | a shared file outside the tokens folder, read by every Codex session | breaks "token files only under the tokens folder"; one file for all sessions | rejected |
| 4. The environment | `${VAR}` in `headers` | `bearer_token_env_var`, `env_http_headers` | the same | every shell command of the agent | breaks "env: no" (age-4ks) | rejected (C d not chosen) |
| 5. An argv | `claude mcp add --header`, or a JSON string to `--mcp-config` | `-c mcp_servers.<name>.http_headers...` | the same | every process's command line, readable by every OS user | breaks the argv rule | rejected |
| 6. A local stdio bridge | `type: stdio` | `command`, `args` | the same, by `-c` | a token file; the bridge reads it | against "http instead of stdio"; one more process for each session | not chosen (C b) |
| 7. A per-session `CODEX_HOME` | — | its own `config.toml` | the app server reads it | a second Codex home | splits the login (the daemon lead's rejection) | rejected |
| 8. OAuth of the client | `/mcp` login | `codex mcp login` | the same | the client's own credential store | outside agentwatch's tokens folder; the service becomes an OAuth server | not used |

## 5. The threat model

Each row names a threat, what it could do, and the check that stops it. "Steps" are the admission steps of
section 11. The token rule is for the MCP only: the local MCP port and the remote MCP route. The CDP path of the
agent door takes no token (section 11).

| Threat | What it could do | The checks that stop it | Result |
| --- | --- | --- | --- |
| T1. Another OS user on the box (taylor has three human users) | connect to `127.0.0.1:<port>`; read an entry file; read an argv; listen on the port and take the header | the uid check (step 1), before any byte; the entry files are 0600 in 0700 folders (the kernel); no token in any argv; the socket unit holds the port at all times, so no other user can listen on it; agentwatch writes the entry only when the port's `LISTEN` line has the user's uid. A token that another user takes gives that user nothing: the uid check refuses that user's connections, and the token ends with its session | stopped |
| T2. Another session's agent of the same OS user, also of another repo (the same-uid fact) | read every entry file of the user; use session B's token from session A; name session B's scope | the walk (step 2) gives the connection its own session; the path's scope (step 6) refuses another scope; the token (step 7) must be the walk's session's token, so B's token from A gets the 401 | an honest agent, a mistake and an injected instruction: stopped. A hostile program of the same user: not stopped, as today (C11's limit: `cgroup.procs`, `tmux send-keys`, a passed connection). The token does not change this limit |
| T3. A token copied into a transcript, a screenshot, a pane or a commit | give the token to a reader of that text, also on the Internet | on the box: the copy works only from its own session, while it runs (steps 2 and 7); off the box: the port listens on `127.0.0.1` only; a remote token works only from the calling box's known addresses (the address check), until its session ends; fewer copies: agentwatch prints no token in any pane, terminal or answer, the entry files live outside every repo, the redactor masks `abt1_` in what the daemon forwards | no use off the box, except a remote token from the calling box's own addresses until its session ends; no new right on the box. An agent can still copy a token into its own transcript (T9) |
| T4. A process that is not an agent session (the operator's own shell, a cron job outside agentwatch, `systemd-run`, a web page, Chrome) | connect with a token that it found | the walk (step 2): no root; a web page: the `Origin` 403 (step 3) and the `Host` 403 (step 4); the walk refuses a browser process | stopped, also with the token |
| T5. Another box, or any computer on the Internet, on the remote route | use a remote token on the serving box; use a local token on another box | the local port listens on `127.0.0.1` only; the serving box's gateway takes a bearer only on `/mcp/<box>/<session>`, only when Cloudflare's `CF-Connecting-IP` is one of that box's known addresses, IPv4 and IPv6 (section 10); the service checks the fingerprint of that remote session; the serving daemon takes each remote item's box from the link's peer identity, refuses a list that names another box, and checks each calling box's list before the merge (section 10); the browser grant (Q3) must be active and its list must have a site; the serving box's rules (quiet times, size, rate) | stopped from every other address. From the calling box's own address with a leaked remote token: admitted until the session ends (the operator accepted this risk for D c, and ab-5t3 bounds it to the calling box) |
| T6. The Mac before its peer reader exists | connect to the Mac's local MCP port with a token | the Mac's local MCP port refuses every connection until the `libproc` reader is built and measured (the operator's Q1 rule 3, kept); a token does not open it. The remote route does not use that port (section 10) | stopped (fail closed) |
| T7. A token that stays valid after its session ends | a process uses an ended session's token; a daemon crash leaves an entry file | at the session's end the daemon removes the link and the entry file, then sends `set_sessions` without the session; `session_ended` closes the scope's MCP connections; the walk refuses a root that is gone, so an ended session's token has no session to work from; the sweep removes what a crash leaves (section 6.5); on the remote route, the serving box drops the fingerprints of a calling box whose list is more than 15 minutes old, all of them when the grant ends, and all of them at once when the box's list fails the serving daemon's checks (a bad list never reaches `set_sessions`, section 10); a `set_sessions` that drops a session or a remote fingerprint and fails (`bad request`, or no answer in 5 s) goes again after 1 s, then with a delay that doubles up to 60 s, and at each reconnect, and a `bad request` on it turns the health line red (section 6.3) | stopped locally at once (while the daemon is down, C11's cgroup fallback keeps its limit of today, section 6.5); on the remote route at the latest 15 minutes after the last list, and at once at a bad list or at the grant's end, as soon as the service takes the snapshot |
| T8. A copy of the token in a program's state | a log, a status, a crash report or a heap of the service, or the serving box's gateway, gives the token | the service gets only fingerprints; its log and its `status` name a scope and say whether it has a token, never a fingerprint; the gateway passes the header unread, logs no header and reads no token file; the daemon checks the service's pid before its hello, so only the real service gets the fingerprints | no token to give |
| T9. An agent that reads an entry file itself | put a token into its tool output, its transcript and the model's context (which the client sends to its model provider) | not stopped: the same uid allows it, and the entry file's path is in the agent's own command line. The skill text tells agents never to read the tokens folder or a profile link. The copy works only from its own session while it runs (steps 2 and 7) | no new right for that agent; the copy is in its transcript |
| T10. Cloudflare's edge on the remote route | read or keep a remote token, a tool argument or a page's text | not stopped for what it sees: TLS ends at Cloudflare's edge (D c has no seal of its own), so Cloudflare sees the token, the tool arguments and the page text of each request; the operator chose this route with that fact (ab-h93, "Keep direct HTTPS through Cloudflare"). For the token's use: a remote token works only from the calling box's addresses (the address check stays), and it ends with its session | Cloudflare sees the remote MCP traffic in clear (the operator's choice); the token gives Cloudflare no use from another address |
| T11. A shared or changed address on the remote route | another computer behind the calling box's address (a NAT) uses a leaked remote token; the calling box's address changes | the address check matches the exact addresses of the box's last status report; a request from a new address gets the gateway's 403 until the next report | a shared address admits only a leaked token; a changed address stops the box's remote sessions until the next report (section 10) |

The small leaks:

- every OS user on taylor sees each run's random name in the client's command line (the entry file's path, and
  Codex's `-p aw-<random name>`). Only the daemon's memory and the 0600 entry file map it to the run's lifetime
  id, so no command line holds a lifetime id (the daemon lead's addition). A random name gives no right by
  itself;
- the serving box's gateway logs the address of a refused remote request (an address is not a secret).

The limit stays as C11 says: the checks stop mistakes, an agent that names another session, and an injected
instruction. They do not stop a hostile program of the same OS user. A token cannot change that on one box,
because every program of that user can read every entry file. The list is the allow (B1 a), and a program of the
same user can change a list file by hand, as it can today (the lists' own limit). So the MCP's allow has the
lists' limit too.

## 6. The split of the auth surface

### 6.1 Who does what (the operator's answer A)

| Act | agentwatch (the daemon, the gateway, the pane) | The service |
| --- | --- | --- |
| Allow (the operator's act) | the repo's list in the Browser pane with a password login: the gateway builds `"operator":{"user":...,"login":"password"}` from the credential and drops any `operator` key from the request body, on each route that adds a site (the list edit, the prompt's allow and its confirm path, the sign-in targets path); the daemon reads the list's state from the service (`lists_get`), not from the files | owns the lists (C12, unchanged) |
| Mint | the daemon, at each launch of an allowed session (section 9.1), never at another time: 32 bytes from `secrets.token_bytes`, `abt1_` and base64url. One local token; one remote token for each serving box whose entry the session gets (section 10) | never |
| Hold | the entry file only: `tokens/agent-browser/sessions/<random name>.json` or `.toml`, mode 0600, and the daemon's index `tokens/agent-browser/sessions/index.json` (0600) that maps each random name to its run's lifetime id (section 9.2); the folders `tokens/`, `tokens/agent-browser/` and `sessions/` mode 0700; an atomic write (a temp file in the same folder, `fchmod` 0600, then a rename), opened with no link followed. The daemon keeps each fingerprint and the map from each random name to its lifetime id in memory, and it reads the files again at its own restart. No other file holds a token or a fingerprint | only the fingerprints of the last `set_sessions`, in memory; nothing on disk |
| Harden | the permissions sweep (`service/permissions.py`) covers `tokens/agent-browser/`, `sessions/` and each entry file, at each write and at each daemon start (today it covers only the tokens folder itself) | nothing |
| Send | `set_sessions` carries each session's fingerprint in its item (`mcp_token`); the daemon waits for the answer before it launches a session with the entry, and it sends a failed drop again (section 6.3) | answers it, and never echoes a refused snapshot |
| Check | the serving box's gateway on the remote route: the route, the address check (section 10) | each request on the local MCP port and on the remote route (section 11) |
| End | at the session's end: the link, then the entry file, then `set_sessions` without the session (section 6.5) | drops the fingerprint; closes the scope's MCP connections |
| Sweep | at each daemon start (after it has adopted the live sessions) and every hour: each entry file (a name of 32 hex digits and `.json` or `.toml` in `sessions/`) whose random name maps in the index (in memory while the daemon runs, read from the index at its start) to a lifetime id that is not live, or that the index does not name; every other file in `sessions/` only by the temp-file age rule below; each profile link named `aw-<32 hex digits>.config.toml` in each Codex home that agentwatch uses, whose random name is not the name of a live run (by the map); each temp file in `sessions/` older than 10 minutes (a younger one can be a Codex write in progress). In a Codex home it touches only a link whose name is `aw-`, 32 hex digits and `.config.toml`: never another file (for example a person's own `aw-notes.config.toml`), and never a link's target | nothing |
| Remove at the uninstall | a normal uninstall (not only `--purge`) removes `tokens/agent-browser/` and each `aw-<32 hex digits>.config.toml` link, on Linux and the Mac; an update (`install.sh --update`) keeps them; no vault or config sync copies the tokens folder | nothing |

Why this split (the operator's answer A, and the reasons of the first revision that still hold):

- The launches are agentwatch's, so the mint sits next to them, as the operator asked.
- The service never holds a token. A fault in the service (a log line, a `status` field, a crash report)
  cannot give a token away.
- agentwatch already holds the user's other durable secrets in the same token store, with the same rules. The
  root gateway never reads a user's token file.

### 6.2 What the service holds

- For each session of the last `set_sessions`: its fingerprint, or `null`. For each remote session (the
  serving box, stage 5): its fingerprint. In memory only.
- The check: the SHA-256 of the request's bearer, compared with the fingerprint of the walk's session (locally)
  or of the path's remote session (remotely), in constant time (`crypto.timingSafeEqual` of two 32-byte
  digests). The service hashes the bearer first, so both inputs always have the same length. One compare for
  each request. (The earlier probe measured 17.8 µs for 100 compares for each request, section 15.)
- Why a hash is enough: a token has 256 random bits, so nobody can find a token from its fingerprint. A slow hash
  adds nothing.
- `status` gives, in each item of `sessions`, `mcp_token: true` or `false` (whether the session has a
  fingerprint). It gives no fingerprint.

### 6.3 The control door: the fingerprint rides on `set_sessions`

The revision asks: do the per-session fingerprints ride on `set_sessions`, which already lists each session
with its lifetime id, or on the earlier op `mcp_tokens`?

- **On `set_sessions` (recommended).**
  - A session and its fingerprint arrive in one complete snapshot and leave in one. No state can have a session
    with no fingerprint while a second op is on its way, or a fingerprint with no session.
  - The daemon sends `set_sessions` at each session change, which is exactly when a token starts or ends.
  - `remote` (stage 5) carries the remote sessions' fingerprints in the same way.
  - No new op, no new provenance and no generation. The vectors gain one field.
  - Its cost: each snapshot carries every live fingerprint (64 hex digits for each session), and the
    `set_sessions` code must keep the field out of every log line.
- **On `mcp_tokens`** (a separate complete snapshot, keyed by lifetime id).
  - It keeps the tokens apart from the sessions.
  - Its cost: two snapshots that must agree; two answers before each launch; a fingerprint for a lifetime id
    that `set_sessions` does not name is dead state that needs its own rule; more code and vectors.

The rules of the recommended form:

- **The field.** Each item of `sessions` gains `mcp_token`: `null`, or 64 lowercase hex digits (the
  fingerprint). Each item of `remote` gains the same field (stage 5).
- **The field rules.** One fingerprint appears at most once in the whole snapshot. One scope appears at most once
  in `sessions`, and one remote scope at most once in `remote` (review-103c note 2): so the item of the walk's
  scope, and its `mcp_token`, are one item. An item with `"lifetime_id":null` has `"mcp_token":null`. A snapshot
  that breaks a rule gets `bad request`, and the service keeps its old snapshot (C12's rule for a daemon
  snapshot).
- **The `bad request` answer** never echoes the snapshot or any field of it (the daemon lead's addition): it is
  C12's fixed answer, with no scope, no lifetime id and no fingerprint in it. The daemon puts the error text into
  its health line and its log.
- **Provenance**: no change. `set_sessions` stays `kind: daemon`.
- **The feature name** `mcp_token` goes into the service's hello: the service checks tokens. The daemon writes
  no entry for a service without it. A service with the MCP port always has it (stage 1d builds both).
- **What a change does at once.** The service closes each MCP connection of a session that the snapshot drops
  (as at `session_ended`), and of a session whose `mcp_token` changed.
- **The answer and its failure** (the daemon lead's change 2, now on `set_sessions`). `set_sessions` answers
  `data: {}`. Before a launch with the entry, the daemon waits for that answer. A failure is `bad request` or no
  answer in 5 s. At a failure:
  - the daemon writes no entry file, and it launches the session without the entry;
  - the Browser pane's session row and `agentwatch health` say why: "the agent browser did not take this
    session's connection token: <reason>";
  - its next snapshot carries `"mcp_token":null` for that session.
- **A failed drop is sent again** (review-103c B1). When a `set_sessions` that drops a session or a remote
  fingerprint fails (`bad request`, or no answer in 5 s), the daemon sends its current snapshot again after 1 s,
  then with a delay that doubles up to 60 s, and at each reconnect. A `bad request` on such a snapshot is a
  fault: the health line is red. "Drops" compares with the last snapshot that the service took, so the resend
  goes on until the service takes a snapshot without the session or the fingerprint. Each resend is the current
  snapshot, so it also carries each later change. The drops of the remote route (the 15-minute end, the grant's
  end, a bad list: section 10) are such snapshots too.
- **The log rule**: no log line of either side holds a token, a fingerprint or a lifetime id (C12 already keeps a
  lifetime id out of every log line). The service logs a scope and whether it has a token.
- The daemon checks the service before its hello (C12: the peer of `control.sock` must be the MainPID of
  `agent-browser.service`). So only the real service gets the fingerprints.

### 6.4 At the service's restart, and at the daemon's

- **The service's restart.** The service starts with no sessions. Until the daemon's first `set_sessions`, no root
  counts, so each MCP connection gets the session's 403 of step 2: C11's order holds, and the 403's text says to
  connect again in a few seconds. The daemon reconnects and sends the snapshot with the fingerprints from its memory.
  - Claude Code: documented, not proven: it tries a dropped remote server again, and its header is static, so
    the same token works.
  - Codex: its header is static too. The service no longer knows the old MCP session id. Whether Codex then
    opens a new MCP session by itself is a stage 2 check.
- **The daemon's restart.** The service keeps its last `set_sessions` (C12, "when the daemon drops"). Admitted
  sessions go on. At its start the daemon adopts the live sessions, reads the map from each random name to its
  lifetime id from its index (section 9.2), reads each live session's
  fingerprint from its file (it parses its own file and logs nothing of it), runs the sweep, and sends the full
  snapshot. An entry file that the daemon cannot parse, that fails its checks, or that the index does not name (or
  an index entry with a lifetime id that is not a UUID): the daemon removes it (and the link), sends `"mcp_token":null`
  for its session when it knows the session, and `agentwatch health` says why. That session's MCP then gets the
  401 until the session restarts.

### 6.5 A session's life

**At the launch**, when the rule of section 9.1 holds. agentwatch creates the session's pane before it sends the
launch line (`daemon/sessions.py`), so the pane's root is known.

1. The daemon mints the session's token (and each remote token) and the run's random name, in memory.
2. It sends `set_sessions` with the session's item, its root and its `mcp_token`, and it waits for the answer
   (section 6.3). At a failure it stops here: no file, a launch without the entry. For each remote token it
   sends the fingerprint over the link and waits for the serving box's answer (section 10). Without that answer,
   the entry file gets no remote entry for that box.
3. It writes the entry file (the atomic write). For Codex it then makes the profile link in the session's Codex
   home: a `symlink()` that fails when the name exists, with the absolute path of the entry file as its target.
4. It sends the launch line, with `--mcp-config <entry file>` (Claude Code) or `-p aw-<random name>` (Codex).

Why the fingerprint comes first: a client that reads the new file must find its fingerprint already in the
service. A daemon crash between steps 2 and 3 leaves a fingerprint with no file. At its restart the daemon finds
no file for that lifetime id and sends `"mcp_token":null`. The client never got the token, so nothing leaks.

**A relaunch in the same run** (a launch line for a lifetime id that already has a token, for example a swap
that keeps the lifetime id) reuses the token, the random name and the entry file, and the launch line carries the
entry again. A
swap to another Codex home moves the profile link: the daemon makes it in the new home and removes it from the
old home.

**At the session's end** (the run ends, also by a kill or a crash of the client):

1. The daemon removes the profile link (Codex), then the entry file.
2. It sends `set_sessions` without the session, and `session_ended`, as today. The service drops the
   fingerprint, closes the scope's MCP connections and ends its MCP sessions.

A daemon crash during these steps leaves a file, a link, or a fingerprint in the service. The walk refuses the
ended session's root. One limit stays, as C11 has it today (review-103c note 3): while the daemon is down, the
service keeps its last snapshot, and on Linux C11's cgroup fallback (the walk's step 3) can admit a job that the
session left in the pane's cgroup, as long as that snapshot lists the session's root and the root still counts.
Such a job can use the token from the entry file until the daemon restarts and its snapshot drops the session.
That is the walk's limit today; the token does not widen it. The sweep at the daemon's next start removes the
file and the link, and the next snapshot drops the session (and goes again until the service takes it, section
6.3).

**During the session:**

- the repo's list loses its last site: the session's entry stays (the decided rule: agentwatch does not rewrite
  a running session's configuration), and the service's no-list 503 (step 8) stops the session's MCP at once;
- the repo's list gets its first site after the launch: no entry until the session's next launch (the decided
  rule);
- `browser.enabled: false` or `browser.control: false`: the service's 503 (C11); the tokens stay until their
  sessions end;
- a long session keeps its token for its whole life (B2: no schedule). The walk binds the token to that session,
  and the address check binds a remote token to the calling box.

## 7. The operator's acts

### 7.1 Where

The Browser pane of the web viewer, with a password login, as for every list act (C12's provenance). The gateway
builds the operator provenance from the credential, only after its password-login check, and it drops any
`operator` key from the request body. A link login is a test login, and agentwatch treats its acts as an
agent's (`auth_link.py`). No token act exists: no "Issue token", no "New token", no "Remove token".

### 7.2 The allow (question B1, option a)

The repo's list is the allow. Each of these paths, with a password login, is an act of the operator:

1. the Browser pane's list edit (`list_set`);
2. the allow of a blocked-site prompt (`prompt_allow`, also its confirm path in the gateway);
3. the sign-in send (`import`). Today a sent site joins no list (the allowlist design's choice 6), so a send
   allows nothing. If a later change lets a send add its site to a repo's list (its targets path), that send
   allows the repo as an operator act, and the same test covers it.

On each path, the gateway builds the operator field from the credential and drops any `operator` key from the
body (the daemon lead's build item).

- **A first site**: the repo's next sessions get the MCP, each with its own token. The pane says: "This repo's
  agents get the agent browser's MCP from their next start." Running sessions of the repo get it at their next
  launch.
- **The last site removed, or the list removed**: the service's no-list 503 stops the MCP of the repo's running
  sessions at once, and the repo's next sessions get no entry. The pane says: "This repo's agents no longer get
  the agent browser's MCP."
- **The switch-on and the upgrade**: a repo whose list already has sites needs no act. Its sessions get the MCP
  from their next launch (the answers B1 a and B2). A running session gets no entry until it restarts.
- **A list file changed by hand** is no operator act, but the list is the allow, whatever wrote it. A hand edit
  is the lists' own same-uid limit (section 5).

### 7.3 What ends a session's MCP

- the session's end: the token ends (section 6.5);
- an operator act that removes the repo's last site or its list: the no-list 503 at once;
- the end of the browser grant (the remote route): the serving box drops all fingerprints of that box;
- a calling box's list that fails the serving daemon's checks (the remote route): the serving daemon drops all
  fingerprints of that box, and the bad list never reaches `set_sessions` (section 10);
- each of these ends acts through a `set_sessions` that drops a session or a fingerprint. When such a snapshot
  fails (`bad request`, or no answer in 5 s), the daemon sends its current snapshot again (after 1 s, then with
  a delay that doubles up to 60 s, and at each reconnect), and a `bad request` on it is a fault with a red health
  line (section 6.3);
- `browser.enabled: false` and `browser.control: false`: the service's 503; the tokens stay for their sessions;
- the uninstall of the agent browser: it removes the entry files and the links, then stops the service. Any agent
  of the user can run the uninstall (the same uid). Its effect only removes access, so it gives nobody a right.

There is no separate revoke: a token has no life outside its session.

### 7.4 What an agent sees

- A session that has no entry sees no browser tools. A request to the MCP port by hand gets the 401 (no token)
  or the walk's 403.
- After the last site's removal: its next call gets the no-list 503 of C11.
- A request with a token that is not its session's: the 401 `The agent browser does not know this connection
  token for this session.` No text names a stop or a start (I2).
- The skill text tells the agent what to do: at the no-list 503, ask the operator for a site in the repo's list;
  at a 401, ask for a restart of the session (a new run gets a new token).

### 7.5 What the Browser pane shows

- For each repo's list: its sites, and one line: "Agents of this repo get the agent browser's MCP from their
  next start" while the list has a site, or "No site: this repo's agents get no MCP".
- A sessions part: each live session that agentwatch launched, with its repo, its client, and its MCP state:
  "connected", "has its token, not connected yet", or "no MCP: <reason>". The reasons: the repo's list has no
  site; the client is too old; the agent browser did not take the session's token; a Codex session with the app
  server (the answer E a: until a Codex release lets the app server read a profile); the port's listener is not
  the user's. For a remote entry: the same, for each serving box.
- On the serving box: the calling boxes' sessions that hold a remote token, the address check's state for each
  calling box ("both addresses known", or why not, section 10), and a calling box whose list the daemon refused,
  with the reason.
- Never a token and never a fingerprint, so no screenshot of the pane holds one.
- `agentwatch health` has a line for each session whose entry the daemon could not write, for each failure of
  the address check and for each refused list of a calling box. A `bad request` on a snapshot that drops a
  session or a fingerprint gives a red line (section 6.3).

## 8. Which sessions are allowed

A session gets the local entry when all of these hold (the conditions of section 9.1):

- agentwatch launches it, with a lifetime id;
- `browser.enabled` is on, with the switch on for the box;
- the session's scope has a list with at least one site (Q2 and B1 a);
- its client takes the entry form (section 9.1, rule 5).

Notes:

- **No per-repo switch** (B1 b was not chosen).
- **Sessions outside a GitHub repo** use the list `no-repo` (agentwatch's rule). If that list has a site, those
  sessions (for example a cron job of agentwatch) get the MCP, each with its own token. Such a session is often
  rooted at the home folder; stage 2 proves that Claude Code takes the entry there.
- **A session whose repo is not known** (the list `unread-repo`) never gets an entry: that list fails closed.
- **A session that agentwatch did not launch** has no lifetime id in `set_sessions` and gets no token.
- **The remote route** has its own rule (section 10).

## 9. How agentwatch connects the MCP at a session's start

### 9.1 The rule

At each launch, agentwatch adds the agent browser's local entry only when all of these hold:

1. agentwatch launches the session, it has a lifetime id, and `browser.enabled` is on with the switch on for
   the box;
2. the session's scope has a list with at least one site (Q2, B1 a), by the service's `lists_get`;
3. the service's hello has the feature `mcp_token`;
4. the `LISTEN` line of `127.0.0.1:<port>` in `/proc/net/tcp` has the user's uid (else `agentwatch health` shows
   red);
5. the client takes the form: Claude Code at or after the first version that stage 2's live check passes; Codex
   0.159.3 or later on the standalone launch. A Codex app-server launch gets no entry (the operator's answer E
   a) until a Codex release lets the app server read a profile and the check of section 14.4, point 3, passes
   for it. An older client gets no entry, and `agentwatch health` says why;
6. the service answered the `set_sessions` that carries the session's fingerprint (section 6.3).

The entry never goes into the user's global files and never into the environment (age-4ks). agentwatch does not
rewrite a running session's entry.

### 9.2 The entry file

- The path: `~/.config/agentwatch/tokens/agent-browser/sessions/<random name>.json` (Claude Code) or `.toml`
  (Codex). The daemon makes a new random name for each run (`secrets.token_hex(16)`, 32 lowercase hex digits),
  and it checks that form before it uses the name in a path. No path and no profile name holds a lifetime id (the
  daemon lead's addition).
- The index (the daemon lead's recommendation): the map from each random name to its run's lifetime id is in the
  daemon's own file `tokens/agent-browser/sessions/index.json`, mode 0600, written atomically (a temp file, `fchmod` 0600, then a rename), and in
  the daemon's memory. No client file holds a lifetime id, so no client write can lose it, and no client sees a
  field that it does not know. The index maps each random name to one lifetime id and each lifetime id to at most
  one random name; at its start the daemon reads the index, checks each lifetime id against the UUID pattern, and
  a second name for one lifetime id fails the check for both names (review-103d), so the daemon removes both entry
  files and sends `"mcp_token":null` for that session. The sweep, the restart and the uninstall take as an entry
  file only a name of 32 hex digits and `.json` or `.toml` in `sessions/`; the index itself and every other file
  there go only by their own rules (the index stays; a temp file goes by its age).
- The modes: the file 0600; the folders `tokens/`, `tokens/agent-browser/` and `sessions/` 0700, made with those
  modes and set again at each write and by the permissions sweep.
- The write: a temp file in `sessions/`, `fchmod` 0600, the content, then a rename to the final name; the open
  follows no link (`O_NOFOLLOW`), and the temp file's open fails when the name exists (`O_EXCL`).
- The content: the local entry and each remote entry (section 10), with the token only in the `Authorization`
  header's value. The writer builds the text with a JSON or TOML writer, never by joining strings, and a test
  proves the escaping of each value.
- One file for each session and client. No log line names the file's path or its random name, because the name
  links the line to one session's entry file.

### 9.3 Claude Code

agentwatch passes the session's entry file with `--mcp-config`, beside agentwatch's own question MCP file:

```json
{"mcpServers":{"agent-browser":{"type":"http",
  "url":"http://127.0.0.1:<port>/mcp/<scope>",
  "headers":{"Authorization":"Bearer abt1_<43 base64url characters>"}}}}
```

- A session that runs with `--strict-mcp-config` (an open-model profile) gets the entry in the same way, because
  `--mcp-config` carries it.
- The argv holds the file's path: no secret and no lifetime id, only the random name (section 5, the small
  leaks).
- Stage 2 checks that no Claude Code log, `--debug` file, transcript or `/mcp` view shows the header's value, and
  that a server of the same name in the user's own configuration does not replace the entry.

### 9.4 Codex

**The standalone launch.** The daemon writes the session's `.toml` entry file and the profile link, and the
launch passes `-p aw-<random name>`:

```toml
# agentwatch: the agent browser's MCP for one session; removed at the session's end
[mcp_servers.agent-browser]
url = "http://127.0.0.1:<port>/mcp/<scope>"
http_headers = { Authorization = "Bearer abt1_<43 base64url characters>" }
tool_timeout_sec = 120
```

- The profile link: `$CODEX_HOME/aw-<random name>.config.toml`, in the session's own Codex home (`~/.codex` or
  its account home), an absolute link to the entry file. The link holds no secret. `-p aw-<random name>` holds
  no secret and no lifetime id.
- The profile layer merges over the base `config.toml`. So the writer refuses the entry when the base
  `config.toml` of the session's home already defines `mcp_servers.agent-browser`, or has a legacy
  `[profiles.aw-<random name>]` table (Codex would then refuse the launch). `agentwatch health` says why.
- Codex writes its own config edits of the session into the entry file, through the link (section 4.1). The
  token stays under the tokens folder. Those edits end with the session. A temp file that a crash leaves in
  `sessions/` goes at the first sweep after it is 10 minutes old.
- The other `-c` values of agentwatch's launch stay. They are a higher layer than the profile, and none of them
  names `mcp_servers.agent-browser`.
- Stage 2 proves that Codex reads the linked profile file, starts the MCP from it and sends the header, and that
  a Codex write keeps the link, writes the target with mode 0600 and keeps the token under the tokens folder. If Codex refuses a linked profile file, that goes back to the operator (the daemon
  lead: "we re-decide").

**The app-server launch (the operator's answer E a).** The profile does not reach the app server (section 4.1).
agentwatch writes no entry for such a session until a Codex release lets the app server read a profile. Until
then the session keeps the browser through `agentwatch browser` and Playwright, and the pane's session row says
"no MCP: a Codex session with the app server cannot take the token in its entry yet". Nothing new is built.
Stage 2 confirms the source reading, and each new Codex version gets the same check (section 14.4, point 3).

### 9.5 The other forms

The forms that the answers did not choose stay in the table of section 4.2 for the record:

- **a header command** (`headersHelper`, `http_headers_helper`): the earlier recommendation, against the
  operator's "no extra command". Question E b offered it for Codex's app server only, and the operator chose E
  a. Its earlier specification is in this design's revision 4ddae4f, section 9.2;
- **a local stdio bridge**: against "http instead of stdio" (C b, not chosen);
- **the environment**: against "env: no" (C d, not chosen).

### 9.6 What a running session does at a change

| Change | Claude Code | Codex (standalone launch) |
| --- | --- | --- |
| The repo's list loses its last site | the next call gets the no-list 503 | the same |
| The repo's list gets its first site after the launch | no entry until the next launch (the decided rule) | the same |
| The service's restart | a dropped connection; it connects again with the same header (documented, not proven) | the same header; whether it opens a new MCP session is a stage 2 check |
| The daemon's restart | nothing: the service keeps its last snapshot | the same |
| A relaunch in the same run | the same token and file | the same; the link moves with a swap to another home |
| `browser.control: false` | the 503 of C11 | the same |
| The session's end | the token ends | the token ends |

## 10. HTTP on this box, HTTPS to another box

**On this box: plain HTTP on `127.0.0.1`, no TLS.** Loopback traffic stays in the kernel. Another OS user can
read it only with root's rights, and root can read every entry file too. A TLS layer on loopback would need a
certificate that both clients trust: a change of the system's trust store, or an environment variable for Node
(`NODE_EXTRA_CA_CERTS`). It adds no check. The token travels only in the `Authorization` header, never in the
URL.

**To another box: direct HTTPS (the operator's answer D c).** For example, a session on taylor uses the agent
browser on the operator's Mac. The path:

```
 calling box (taylor)                                serving box (the Mac)
 session's client --HTTPS, Authorization: Bearer abt1_...-->  Cloudflare's edge (TLS ends)
                                                               --tunnel--> the Mac's gateway (tunnel-origin socket)
                                                               the route and the address check
                                                               --unread--> the Mac service (remote scope, MCP path only)
                                                               the fingerprint check
```

- **The entry.** The session's entry file gets a second server, `agent-browser-<serving box>`, with the URL
  `https://<serving box's label>.agentwatch.sh/mcp/<calling box>/<session>` and the session's remote token in
  its `Authorization` header. The remote token is not the local token, so the token that crosses Cloudflare never
  works on the calling box's own port. For a Codex session the same holds as in section 9.4 (the answer E a for the
  app-server launch).
- **Which sessions of the calling box get it.** Every session that agentwatch launches on the calling box while
  the browser grant is active and the grant's list on the serving box has at least one site (Q3: one grant and
  one list for the whole box). The calling box's own lists play no part. The calling box learns the state of the
  grant and of its list over the link (stage 5).
- **Where TLS ends.** At Cloudflare's edge, which holds the public certificate of `agentwatch.sh`. Each client
  checks it with its own root store (Node's for Claude Code; Codex's for Codex). Cloudflare's tunnel then carries
  the request to the serving gateway's tunnel-origin socket. The serving box opens no port.
- **What Cloudflare sees.** TLS ends at its edge, so Cloudflare sees each remote MCP request and answer in clear:
  the token, the tool arguments and the page text that the tools give back. The link path of the earlier option
  D a sealed these bytes to the other daemon's key. agentwatch's web viewer crosses Cloudflare in the same way as
  D c. The text of D c on ab-sxg stated only the copy risk. So the question came back on ab-h93 with this fact,
  and the operator chose "Keep direct HTTPS through Cloudflare" ("No program between. Cloudflare sees the token,
  the tool arguments and the page text of each request. The address check stays."), against the recommended link
  path. This route stays, and the address check stays.

**The serving box's gateway** (the daemon lead's point 5):

- It routes only `/mcp/<calling box>/<session>` with an `Authorization: Bearer abt1_...` header to its service,
  unread.
- It never takes an `abt1_` token on any other route. It never takes agentwatch's API token on the `/mcp` route
  (the tunnel's rule "The API token works only on its own box" stays). It refuses a request with a cookie or an
  `Origin` header on `/mcp`.
- It never reads a user's token file, and it logs no header.
- It answers `/mcp` with no redirect.
- It applies the serving box's rules: the quiet times (a new MCP session in a quiet window gets a clear refusal),
  the rate limit for each remote session (first values: 10 requests a second, 4 at once). The service applies
  the answer size limit (first value 16 MiB), with the clear refusal of the service design's section 9.

**The address check** (the operator's answer ab-5t3; the daemon lead's point 7):

- The gateway takes a bearer on `/mcp` only when Cloudflare's `CF-Connecting-IP` equals one of the known
  addresses of the box that the path names: its IPv4 address or its IPv6 address. An exact match, as the
  operator's words say.
- The gateway reads `CF-Connecting-IP` only on its tunnel-origin socket, where only Cloudflare's tunnel
  connects. Cloudflare sets the header, and a client cannot set it through Cloudflare.
- The addresses come from the calling box's regular status report (the provisioner's heartbeat, as the daemon
  lead names it). The report must give both families. How the report learns each address (for example one report
  over each family) is the daemon lead's build detail (age-q8t.5).
- Each family is in one of three states: an address; "none" (the box reports that it has no global address of
  that family); "not known" (no report yet, or a report that does not give that family).
- **One address not known: fail closed for the whole box.** The gateway takes no remote token from that box,
  because the operator's condition is "as long as you have the ipv4 and ipv6 of each daemon". The serving box's
  Browser pane says, for example, "taylor's IPv6 address is not known yet: taylor's sessions cannot use this
  browser until taylor's next status report gives it". `agentwatch health` says the same on both boxes.
- **A family in the state "none" counts as known.** This is the design's reading of "the ipv4 and ipv6 of each
  daemon" (sections 2 and 17). It adds no address that can match: a box with no global IPv6 address sends no
  request from an IPv6 address.
- **An address change.** A request from the box's new address gets the gateway's 403 `This box's address is not
  the one that its last status report gave. Try again after its next report.` The box's sessions lose the remote
  browser until the serving box learns the new address from the box's next report. That is the failure mode of
  the address check. The calling box can send a report at once when it sees a change (the daemon lead's build
  detail).
- **IPv6 temporary addresses.** A box whose outbound IPv6 address changes often (for example a Mac with privacy
  addresses, its default) fails often. A match on a `/64` prefix would change the operator's rule, so this design
  does not build it.
- **A shared address** (a NAT, a shared IPv4 address) admits every computer behind it, but only with a leaked
  token (T11).

**Who mints a remote session's token.** Both options, as the design gave them for the daemon lead's read. The
daemon lead takes (i) in the read of the revision, and withdraws point 6 (the grant is the act):

- **(i) The calling box's daemon mints at the session's start (recommended; chosen).** It mints the remote token
  with the local one, writes it into the session's entry file, and sends only the fingerprint over the link
  (signed and sealed, as every link message). The serving box's daemon lists the remote session in its service's
  `set_sessions`: `{"scope":"taylor/<session>","box":"taylor","list":<the grant's list>,"mcp_token":"<64 hex>"}`.
  The calling daemon sends the box's complete list of remote sessions at each change and every 5 minutes. The
  serving box drops a box's remote fingerprints 15 minutes after its last list (fail closed), and all of them at
  once when the grant ends. At a launch, the calling daemon waits for the serving box's answer that the
  fingerprint is in force (first value 5 s). With no answer, the session launches without the remote entry, and
  the pane says why.
  - **The box comes from the link** (the daemon lead's addition). The serving daemon sets each remote item's
    `box`, and the box part of its scope, from the link's peer identity, never from the message body. It refuses
    a list that names another box, whole: such a list fails the check below.
  - **The check of each list before the merge** (review-103c B1). The serving daemon checks each calling box's
    list before it merges it into its service's `set_sessions`: the form of each fingerprint (64 lowercase hex
    digits), each fingerprint once (in the list, against the other boxes' lists and against the local sessions),
    each session once in the list (C12's rule of one remote scope once), and the limit of 64. A list that fails
    these checks is refused for that box alone. The daemon then drops all fingerprints of that box (fail closed),
    and the serving box's Browser pane and `agentwatch health` say why. Its answer to the calling box says that
    the list was refused, and holds no fingerprint. A bad list never reaches `set_sessions`, so the other boxes'
    fingerprints and the serving box's own sessions stay in force.
  - Each of these drops is a snapshot that drops a remote fingerprint. When it fails, the daemon sends its
    current snapshot again (section 6.3).
- **(ii) The serving box mints and sends the token sealed over the link** (the daemon lead's point 6, written for
  per-repo tokens). The serving box keeps only the fingerprint, and the calling daemon writes the token into the
  session's entry file.

Why (i):

- one mint path for local and remote tokens: one code path and one test set;
- the token never crosses the link. In (ii) the token crosses the link (sealed, but one more copy in transit and
  in the serving daemon's memory);
- the serving box holds no token, only fingerprints, as its service does;
- the calling box knows each session's start and end, so the token's life follows the session with no extra
  request. In (ii) each start needs a request to the serving box and a sealed answer, and the serving box must
  still learn each end;
- point 6 came from the per-repo design, in which the serving box's operator act issued a token. With one token
  for each session, the serving box's operator act is the grant, and no act happens at a session's start.

What (i) costs: the serving box takes the calling box's word that a fingerprint belongs to one of its sessions.
The link's signature and the grant already give that box the browser, so a fingerprint gives it nothing more. A
limit of remote fingerprints for each box (first value 64) stops a flood. The check of each list keeps a bad list
of one box (a bug, or a hostile box) away from the other boxes and the serving box's own sessions.

**What the remote route takes from the earlier path, and what goes.** Stage 5 builds no remote stdio program
(`agentwatch browser mcp --box`), no remote MCP socket in the daemon and no Python walk. The link no longer
carries MCP bytes. The link keeps the grant, the fingerprint lists and the state of the grant's list. The remote
route does not use the serving box's local MCP port, so it does not wait for the Mac's TCP peer reader: each
admitted request goes, unread, to the service's agent door, a Unix socket with the kernel's peer check. Stage 5
decides the carrier on that door: the gateway itself, or the serving box's daemon, which section 9 of the service
design already names.

**Stage 5** (ab-v16.94.7 and agentwatch's age-q8t.5) builds this section. Its tests include: no `abt1_` token in
a link message (only fingerprints), the gateway's route rules, the address check's cases, the box from the
link's peer identity, and the check of each list before the merge.

## 11. The checks that stay, and the admission order

**What stays**: the uid check and the walk before any byte (C3's conditions); the `Origin` 403; the `Host`
check against DNS rebinding; the walk's refusal of a browser process; the port held by the socket unit; the
Mac's local port closed until its reader exists; the path's scope as a label that must equal the walk's scope.

**What the token adds**: each request must carry its own session's token. A process in the session that does not
have the entry (for example a `curl` that an agent runs without the entry file) fails. A token copied out of a
session works nowhere else, and it ends with the session.

**The CDP path of the agent door** (the Unix socket) takes no token. The operator's answer names the MCP over
HTTP or HTTPS. The CDP path keeps the kernel's peer check, and C11's sentence "No key, no token file and no
environment variable take part" stays true for it. Remote MCP requests reach the agent door through the carrier,
and the service checks their bearer (the remote route's admission, below).

**No repo key on `set_sessions`.** The first revision added `repo_key` to `set_sessions` for the repo match (the
daemon lead's change 4). The answers bind a token to one session, so the repo match goes, and this design needs
no `repo_key`. The list of each scope comes from `repo`, as C12 has it today.

The admission of the local MCP port, with the new step 7 (C11's list, renumbered):

1. The uid (before any byte).
2. The walk (before any byte). The connection's scope gives its session, and `set_sessions` gives the
   session's `mcp_token` (from the one item of that scope: C12's rule of one scope once).
3. An `Origin` header: 403.
4. The `Host` header: 403.
5. The path: 404.
6. The path's scope against the connection's scope: the session's 403.
7. **The token** (new):
   - no `Authorization: Bearer <token>` header: 401 `The agent browser needs this session's connection token.
     agentwatch adds it to the sessions that it starts while the repo's list has a site.`;
   - a session whose `mcp_token` is `null`: 401 `This session has no connection token. agentwatch adds one
     when it starts a session while the repo's list has a site: restart the session.`;
   - a token whose fingerprint is not the session's: 401 `The agent browser does not know this connection token
     for this session.` The text does not say whether the token belongs to another session;
   - each 401 carries `WWW-Authenticate: Bearer realm="agent-browser"`, with no `resource_metadata`, so no
     client starts an OAuth login (stage 2's live check proves it).
8. The readiness and the scope's list: the 503s of C11's step 7 today.

Steps 1 and 2 run once for each connection. Steps 3 to 8 run for each request. A refused request never has its
header in a log line or in an answer.

**The remote route's admission** (stage 5), on the serving box:

1. The gateway: the route (`/mcp/<box>/<session>` only), no cookie, no `Origin`, no API token; the address check
   against the path's box; the quiet times and the rate limit.
2. The service: the carrier (identified on the agent door by the rule of the service design's section 7.1;
   stage 5 extends that rule if the carrier is the gateway); the remote scope that the last
   `set_sessions` lists (in one item); the token against that remote session's `mcp_token`, with the texts of
   step 7; the
   grant's list (the 503s); the MCP path only; no path argument (the service design, section 9).

## 12. The secret rules and the log rule

**What the rules cover.** The rules cover every path that agentwatch or a client takes without being asked. On
those paths a token is never:

- in an argv: not of the client, the service, the daemon, the gateway or a test;
- in an environment: not of the session, its shell commands or the service;
- in a log line: not of the daemon, the gateway, the service or the clients' own logs (stage 2 checks the
  clients' logs);
- in a pane or a terminal: agentwatch prints it in no pane, terminal or answer, and the Browser pane never shows
  it;
- in a URL: not in a path and not in a query;
- in git: the entry files live under the tokens folder, outside every repo;
- on the control door or the link: only its fingerprint crosses; and not in a `status`, an error text or a 401
  body.

**Where a token lives**: the session's entry file, the client's memory, and, for a remote token, the HTTPS
request (and Cloudflare's edge, in clear: the operator's choice on ab-h93).

**The limit (the same-uid fact).** Every session of one OS user runs as one uid. An agent can read its own entry
file (its path is in its own command line: `--mcp-config` or `-p`) and every other session's entry file. The
token then goes into the tool's output, the transcript, and the model's context, which the client sends to its
model provider. The rules cannot stop this. What keeps it small:

- a copied token works only from its own session, while that session runs (the walk and the token), so the copy
  gives that agent no new right;
- a remote copy works only from the calling box's addresses, until its session ends;
- the token ends with its session;
- the skill text tells agents never to read the tokens folder or a profile link, and never to print a client's
  server configuration.

**Codex's own writes.** Codex writes its config edits of the session into the entry file through the link. The
token stays under the tokens folder, in a 0600 file.

**The redactor.** agentwatch's redactor (`secret_patterns.py`) gets the prefix `abt1_` as a kind of token. It
covers what the daemon forwards: for example each hit of a transcript search, which the daemon redacts before
the hit leaves it. It does not cover a transcript file on disk, a client's own log, a pane on the screen, or the
copy at the model provider.

**The log rule.** The service's log of the MCP path holds a user, a scope, a method and a result. It never holds
an `Authorization` header, a token, a fingerprint or a lifetime id (C11's log rule, extended). The serving box's
gateway logs no header; it may log a refused address.

How tests prove the rules (section 14 has the list):

- A canary token: the test path mints a known fake token, for example `abt1_` and 43 `C` characters.
- The scans look for the canary and for its fingerprint (the daemon lead's change 3) in: every recorded spawn's
  argv and environment (the spawner tests already read the launch argv), the Codex `-c` values, every log record
  of the test (Python's `caplog`, the service's log sink), every C12 line that the daemon sends (the fingerprint
  may appear there, and only in `mcp_token`), every link message of stage 5 (the fingerprint only), the service's
  answers and `status`, the Browser pane's API answers, and `agentwatch health`'s output. Each scan must find the
  canary nowhere. The entry file is the one place on disk that holds it. The scans use plain string search
  (`grep -F` in live checks).
- The mutations: each scan has a twin test that plants the canary in the scanned text and must find it. So a
  scan that reads nothing fails.
- The modes: a test sets an entry file to 0644 and its folder to 0755; the daemon's next write and its start set
  0600 and 0700 again.

## 13. The changes to other documents

A later task makes these changes (build task 1). The quoted sentences are today's.

**The service design (2026-11-09).**

- The status block: "A new design (board ab-v16.94.10) replaces the MCP's admission of section 8.3 and C11, and
  stage 1d waits for it." becomes a reference to this design and the date of the operator's answers.
- Section 1, item 5: "A local session reaches the MCP with its client's HTTP configuration,
  `http://127.0.0.1:<port>/mcp/<scope>`: no stdio shim runs, and no key (the operator's answer Q1, section
  19)." becomes: "... `http://127.0.0.1:<port>/mcp/<scope>`, with the session's own connection token in the
  `Authorization` header of its MCP entry: no stdio shim runs (the operator's answer Q1, section 19, and the token
  design)."
- Section 1, item 9: add the operator's answers to the token design (section 2 of this design).
- Section 4.3, the row "Processes for the MCP of each session": no change (no bridge, no command).
- Section 7.1, the table "Daemon to service": the row `set_sessions` gains `mcp_token` for each session and each
  remote session. Provenance: no change (no new op).
- Section 8.3, the decision paragraph: "a per-session MCP configuration; and no secret. No stdio shim runs."
  becomes: "a per-session MCP configuration in a 0600 file under agentwatch's tokens folder, with the session's
  own token in its `Authorization` header, which must be the token of the walk's session (the token design). No
  stdio shim runs." The sentences "Board ab-v16.94.10 designs it before stage 1d builds the MCP; until then, this
  section is the record of the earlier reading." become a reference to this design.
- Section 8.4: "A key per session: not needed. ... and the operator rejected keys (ab-dm6)." becomes: "A token
  for each session: the operator's answers to ab-6ng and ab-0wv, designed in the token design; the walk stays."
- Section 8.5: "The entry holds the URL with the session's scope (a label: the walk decides the scope) and no
  secret." becomes: "The entry holds the URL with the session's scope (a label: the walk decides the scope) and
  the session's own token in its `Authorization` header. agentwatch writes it into a 0600 file under its tokens
  folder before the launch, and it removes the file at the session's end." The parenthesis "(Claude Code: a
  generated file with `--mcp-config`; Codex: a `-c` override for each launch)" becomes "(Claude Code: the
  session's file with `--mcp-config`; Codex: the session's profile `aw-<random name>` with `-p`, a link in the
  Codex home to the session's file; Codex with agentwatch's app server gets no entry until a Codex release lets
  the app server read a profile, by the operator's answer E a)".
  Add rules 3 and 6 of section 9.1. "Nothing goes into the session's environment" stays.
- Section 9: the path becomes this design's section 10 (D c). The diagram changes. "**taylor.** The session's MCP
  configuration names `agentwatch browser mcp --box <mac>`, a stdio shim of agentwatch's." becomes "The
  session's MCP configuration names `https://<label>.agentwatch.sh/mcp/<box>/<session>`, with the session's
  remote token in its `Authorization` header." The bullets on the new daemon socket and the Python walk go. "Each
  request and each answer travels sealed, as the link's seal rule says for every link message." becomes "The link
  carries the grant, the fingerprint lists of the calling box's sessions and the state of the grant's list. The
  MCP requests go by direct HTTPS; TLS ends at Cloudflare's edge, so they are not sealed, by the operator's
  choice (ab-h93; the token design, section 10)." "It connects to the Mac service's agent door for that scope and
  carries the bytes." becomes "Each admitted request goes, unread, to the Mac service's agent door for that scope
  (stage 5 decides the carrier: the Mac's gateway or the Mac's daemon)." The remote `set_sessions` item gains
  `mcp_token`. The address check, the gateway's route rules, the box from the link's peer identity and the check
  of each calling box's list before the merge are new bullets. The
  table "Part / Whose" changes: the gateway route, the address check and the fingerprint lists are agentwatch's;
  the remote token check is agent-browser's; the remote stdio shim and the remote MCP socket go.
- Section 11, the row "Secrets": add "each session's token lives only in its 0600 entry file under agentwatch's
  tokens folder and in its client's memory; the service holds only its SHA-256". The row "Another OS user": add
  "the entry files are 0600 in 0700 folders".
- Section 12, the row C3: "...a per-session MCP configuration; no secret." becomes "...a per-session MCP
  configuration in a 0600 file under agentwatch's tokens folder; the session's own token in the `Authorization`
  header only, checked against its fingerprint for each request."
- Section 19, Q1 condition 4: "for Codex a `-c` override for each launch (the daemon lead's change D19)" becomes
  "for Codex the session's profile (`-p aw-<random name>`), whose file is a link to the session's 0600 file under
  agentwatch's tokens folder (the operator's answers C and ab-ufy, the daemon lead's form); Codex with
  agentwatch's app server gets no entry until a Codex release lets the app server read a profile (the answer E a
  of the token design)".
- Section 19, Q1 condition 5: "No secret is in the URL or in the configuration. The scope in the path is a label:
  the walk decides the scope." becomes "No secret is in the URL. The session's own token is in its MCP entry's
  `Authorization` header, in a 0600 file under agentwatch's tokens folder (the operator's answers C and ab-ufy).
  The scope in the path is a label: the walk decides the scope."
- Section 19: "Q1 is about a local session. Section 9's path for a session of another box does not change by it."
  gains "The token design's answer D c changes section 9."
- Section 19: a new paragraph with the operator's answers to this design.

**C11 (`docs/contracts/C11.md`).**

- "Board item ab-6ng asks the operator to check this reading of the answer "HTTP". If the operator picks HTTP on
  the private socket with a helper instead, this part changes before stage 1d builds it." becomes: the operator
  confirmed HTTP and added connection tokens (ab-6ng), one for each session (ab-0wv); the token design gives the
  rules.
- "No secret is in the URL or in a session's MCP configuration: no key and no token." becomes "No secret is in
  the URL. A session's own MCP configuration holds the session's connection token in the `Authorization` header
  (`Bearer abt1_...`), in a 0600 file under agentwatch's tokens folder, and each request carries it only there."
- "A local session reaches the MCP only through this URL. No stdio shim runs for it." stays.
- The admission: the new step 7 of section 11, with its three texts and the `WWW-Authenticate` header; the old
  step 7 becomes step 8; step 2 takes the session's `mcp_token` from `set_sessions`.
- "Steps 3 to 7 run for each request on the connection." becomes "Steps 3 to 8 ...".
- "At each C12 `set_sessions`, the service closes each MCP connection whose admitting root is no longer a root of
  its scope that counts" gains "and each MCP connection of a session that the snapshot drops or whose `mcp_token`
  changed".
- The limits: after "As on the endpoint, the check does not stop a hostile process of the same OS user." add:
  "The token does not change this: a process of the user can read every session's entry file. A token works only
  from its own session, and it ends with the session."
- The log rule: "No log line of the MCP path holds a tool argument, page content, a cookie, a URL path or a
  payload" gains "an `Authorization` header, a token, a token's fingerprint or a lifetime id".
- "How a session gets the MCP": "only when the session's scope has a list with at least one site" stays, and
  gains "agentwatch mints the session's token at the launch, sends its fingerprint in `set_sessions`, writes the
  entry file before the launch and removes it at the session's end". "For Claude Code it writes a file for the
  session, which the launch passes with `--mcp-config`." becomes "For Claude Code it writes a file for the session
  under its tokens folder (`tokens/agent-browser/sessions/<random name>.json`, 0600, with a new random name for
  each run), which the launch passes with `--mcp-config`." "For Codex it uses a `-c` override for each launch."
  becomes "For Codex it writes the session's profile file under its tokens folder and a link to it in the
  session's Codex home (`aw-<random name>.config.toml`), and the launch passes `-p aw-<random name>`; a Codex
  session with agentwatch's app server gets no entry until a Codex release lets the app server read a profile
  (the token design's answer E a). No command line holds a lifetime id." "Nothing goes into the session's
  environment" stays.
- The table of parts at the top: the row "The remote MCP path for a session of another box" becomes "stage 5:
  direct HTTPS with a remote token and the address check (the token design, section 10)"; a new row "The
  per-session tokens: the daemon mints and holds; the service checks a fingerprint from `set_sessions` (the token
  design)", from stage 1d (the service) and stage 2 (agentwatch).

**C12 (`docs/contracts/C12.md`).**

- The row `set_sessions`: each item of `sessions` gains `mcp_token` (`null` or 64 lowercase hex digits: the
  fingerprint of the session's token); each item of `remote` gains the same (stage 5). The service drops a
  session's fingerprint with the session, and closes the MCP connections of a session that the snapshot drops or
  whose `mcp_token` changed.
- The field rules: `mcp_token` is `null` or 64 lowercase hex digits; one fingerprint appears at most once in a
  snapshot; one scope appears at most once in `sessions`, and one remote scope at most once in `remote` (stage
  5); an item with `"lifetime_id":null` has `"mcp_token":null`.
- The answer: "The `bad request` answer to `set_sessions` never echoes the snapshot or any field of it: no scope,
  no lifetime id and no fingerprint." (the daemon lead's addition).
- The resend: "When a `set_sessions` that drops a session or a remote fingerprint fails (`bad request`, or no
  answer in 5 s), the daemon sends its current snapshot again after 1 s, then with a delay that doubles up to
  60 s, and at each reconnect. A `bad request` on such a snapshot is a fault: the daemon's health line is red."
- No new op and no provenance change.
- The hello's feature names: `mcp_token`.
- The data of `status`: each item of `sessions` gains `mcp_token: true|false`, never the fingerprint.
- "No side logs page content, a cookie, a URL path or a payload in any log line." gains "a token or a token's
  fingerprint".
- The vectors (`test/vectors/control.json`): `set_sessions` lines with `mcp_token`; bad lines (63 hex digits,
  uppercase hex, one fingerprint in two items, one scope in two items, a fingerprint with `"lifetime_id":null`),
  each with the fixed `bad request` answer.
- The fake (`--fake`) keeps the field, as it keeps every field of the table.

**Stage 1d (ab-v16.94.5).** "no secret anywhere" becomes "the token step of the token design (step 7): the
bearer's SHA-256 against the walk's session's `mcp_token` from `set_sessions`, in constant time; the texts; the
close of a dropped or changed session's connections; no token, fingerprint or lifetime id in a log". It waits for
this design's merge.

**Stage 4, the Mac (ab-v16.94.6).** No change to "the Mac's TCP peer reader (libproc) for the MCP, measured":
the Mac's local MCP port stays closed until then. Add: the Mac's daemon mints the tokens of the Mac's own
sessions, with the same entry files and links.

**Stage 5 (ab-v16.94.7).** It builds section 10: the serving service's remote admission (the carrier, the remote
scope with `<box>/`, `remote[].mcp_token`, the token texts, the grant's list, the answer size limit), and the
tests. agentwatch's side (age-q8t.5): the gateway route and its rules, the address check with both families and
its texts, both addresses in the status report, the fingerprint lists over the link and their 15-minute end, the
box of each remote item from the link's peer identity, the check of each calling box's list before the merge
(fail closed for that box alone), the remote entry for every session of the calling box while the grant is
active and its list has a site, the quiet times and the rate limit. The remote stdio program, the remote MCP
socket and the Python walk go from stage 5.

**agentwatch's side (the daemon lead's tasks; their texts are on agentwatch's board).**

- A new task (the daemon lead creates it when this design merges): the token store: the mint and the
  fingerprint, the run's random name, the folder `tokens/agent-browser/sessions/` and its modes, the permissions
  sweep, the uninstall, the update, no sync copy, the redactor's `abt1_`.
- age-q8t.1 (stage 2, the client and the switch): `mcp_token` in `set_sessions`, the wait for its answer before a
  launch with the entry, the failure path, the resend of a failed drop and its red health line, the feature
  check.
- age-q8t.7 (the MCP entry writer): the entry files with their random names and the lifetime id in each file,
  the map and its rebuild at the start, the Codex profile link, the removal at the end, the relaunch and swap
  rules, the sweep at each start and every hour (`aw-<32 hex digits>.config.toml` only; temp files older than 10
  minutes only), the pane's session rows and health lines, the gateway's operator field on each route that adds a
  site.
- age-q8t.5 (stage 5): the gateway route and section 10, with the box from the link's peer identity and the
  check of each calling box's list before the merge.
- age-q8t.6 (stage 6, cleanup): remove `tokens/agent-browser/` and every `aw-<32 hex digits>.config.toml` link.
- The skill text: what an agent does at a 401 or at the no-list 503, and that it never reads the tokens folder or
  a profile link.

## 14. Tests

### 14.1 Unit tests, agent-browser (stage 1d)

- The admission vectors (the daemon lead's F11 list, plus the token cases): no header; a session with
  `"mcp_token":null`; another session's token; the walk's session's own token (admitted); a snapshot that drops
  the session (its connection closed, then the walk's refusal); a changed `mcp_token` (its connection closed;
  the old token then gets the 401); the no-list 503 with a valid token; each with the peer and a fake process
  table, so both sides test with a fake reader.
- `set_sessions`' `mcp_token`: each bad line of section 13's C12 list (also one scope in two items); the old
  snapshot kept after a bad request; the `bad request` answer holds no field of the refused snapshot (a scan of the
  answer for the canary's fingerprint, the scopes and the lifetime ids of the line).
- No byte of a request is read before steps 1 and 2 pass (a refused peer that sends a header gets closed with its
  403 and no read).
- The constant-time compare: a spy shows `timingSafeEqual` on two 32-byte digests for each request, also for a
  bearer of another length.
- The secret scans of section 12 over the service's log sink, its answers and its `status`, with their mutations.
- Stage 5 adds the remote vectors: the carrier, a remote scope that the snapshot does not list, another remote
  session's token, the grant's list.

### 14.2 Unit tests, agentwatch (the daemon lead)

- The mint: the token's form (`abt1_`, 43 base64url characters, from `secrets.token_bytes(32)`); the fingerprint
  input (lowercase hex SHA-256 of the ASCII bytes with the prefix); a new token and a new random name (32
  lowercase hex digits) for each run; the same token and name for a relaunch in the same run; a local token and a
  remote token that differ.
- The order at the start: the fingerprint in `set_sessions` and its answer before the file, and the file before
  the launch line; at `bad request` and at no answer in 5 s: no file, a launch without the entry, the pane's row
  and the health line, and `"mcp_token":null` in the next snapshot.
- The resend of a failed drop (review-103c B1): a snapshot that drops a session or a remote fingerprint gets
  `bad request`, or no answer in 5 s: the daemon sends its current snapshot again after 1 s, then after 2 s, 4 s
  and on up to 60 s, and at each reconnect; at a `bad request` the health line is red; the first answer
  `data: {}` to a snapshot without the session ends the resend.
- The entry files: Claude Code's JSON (the token only in `headers.Authorization`; no lifetime id); Codex's TOML
  (`http_headers`, never `bearer_token`; no lifetime id); the index maps each random name to its lifetime id; the
  file's name is the run's random name, never its lifetime id; the modes 0600 and 0700, also after a
  test changes them; the atomic write; no link followed; a lifetime id that is not a UUID gets no file; the
  escaping of each value (a test with a URL and a scope that hold each character that the rules allow).
- No lifetime id in a command line: the recorded launch argv holds the random name, and it holds no lifetime id.
  Today's launch arguments (for example the question MCP's arguments) may already hold a lifetime id: the build
  removes it there, or narrows the scan to the agent browser's arguments and records why (review-103d).
- The Codex profile link: in the session's own Codex home (`~/.codex` or an account home), named
  `aw-<random name>.config.toml`, an absolute link to the entry file; no other file under the Codex home changes;
  the link moves at a swap to another home; the launch line has `-p aw-<random name>`; no entry for an app-server
  launch (the answer E a); the refusal when the base `config.toml` defines `mcp_servers.agent-browser` or a
  legacy `[profiles.aw-<random name>]` table.
- The end: the link removed, then the file, then `set_sessions` without the session; a crash test after each step
  (the sweep at the next start removes what is left).
- The sweep: at the start (after the adoption) and every hour, it removes each entry file (32 hex digits and
  `.json` or `.toml`) whose random name the index maps to a lifetime id that is not live, or that the index does not
  name; it keeps the index and a live session's file also when a client rewrote that file; each `aw-<32 hex digits>.config.toml` link whose random name is
  not a live run's, and each temp file in `sessions/` older than 10 minutes; it keeps a younger temp file (a Codex
  write in progress); it covers each Codex home that agentwatch uses; it never touches a planted
  `aw-notes.config.toml`, a profile file whose name does not start with `aw-`, a file outside `sessions/`, or a
  live session's file; it removes a planted `aw-<32 hex digits>.config.toml` link whose target is outside
  `sessions/`, and not that target.
- The daemon's restart: it reads the map from the index and gets each live session's fingerprint from its entry
  file again; a file that it cannot parse, or that the index does not name, is removed, and the snapshot carries
  `null`; two names for one lifetime id in the index fail both; the index itself is written atomically with mode
  0600 and is never removed by the sweep.
- The permissions sweep covers `tokens/agent-browser/`, `sessions/` and each entry file.
- The uninstall: a normal uninstall (not only `--purge`) removes `tokens/agent-browser/` and each
  `aw-<32 hex digits>.config.toml` link in each Codex home, on Linux and on the Mac, and never a planted
  `aw-notes.config.toml`; `install.sh --update` keeps them; the file list of each vault or config sync leaves out
  the tokens folder.
- The redactor: a text with the canary comes out with the canary masked (kind `token`).
- The allow paths: the pane's list edit and `prompt_allow` (also its confirm path) are operator acts only with a
  password login; a sign-in send allows nothing while a send joins no list; on each route the gateway drops an
  `operator` key from the body; a test login, the API token and a remote box get a refusal.
- The entry rule: an entry only when all six conditions of section 9.1 hold; the recorded launch argv and
  environment hold no canary; the Codex `-c` values hold no canary.
- The C12 lines: the daemon's `set_sessions` holds the canary's fingerprint only in `mcp_token`, and never the
  canary.
- The Browser pane's API: its answers (the session rows, the reasons) hold no canary and no fingerprint.
- Stage 5 (age-q8t.5): the gateway's route rules (`abt1_` only on `/mcp/<box>/<session>`; the API token refused
  on `/mcp`; a cookie or an `Origin` refused; no header logged; no token file read; no redirect); the address
  check (both known: admitted; one not known: refused with its pane text; "none" counts as known; a changed
  address: refused until the next report; `CF-Connecting-IP` read only on the tunnel-origin socket); the
  fingerprint lists over the link (only fingerprints; the 5-minute send; the 15-minute end; the end at the
  grant's end; the limit of 64); the remote entry only while the grant is active and its list has a site.
- Stage 5, the serving daemon's check of each list (review-103c B1, and the daemon lead's addition): a duplicate
  fingerprint in one box's list: that box's fingerprints are dropped; the snapshot of the serving service is
  applied. The same for a fingerprint of another box or of a local session in a list, a session twice in a list,
  a fingerprint of the wrong form and a list of 65; each time the serving box's pane and `agentwatch health` say
  why, and the calling box gets the refusal with no fingerprint. A list that names another box is refused whole,
  and each remote item's box and the box part of its scope come from the link's peer identity, never from the
  body.

### 14.3 The mutation for each rule

| Rule | The mutation | The test that fails |
| --- | --- | --- |
| Each request needs its session's token | step 7 removed | "no header" gets 200, not 401 |
| A token works only for its own session | the service compares the bearer with every fingerprint of the snapshot | "another session's token" gets 200, not 401 |
| A session with no fingerprint gets no MCP | `"mcp_token":null` treated as "no check" | the null vector gets 200 |
| A changed or dropped session loses its connections | the close at a change removed | the open connection stays open |
| The fingerprint before the file | the file written before the answer | the failure test finds a file |
| The sweep removes what a crash leaves | the sweep skips entry files | the crash test finds the file after the restart |
| One fingerprint once | a fingerprint in two items accepted | its bad-request vector gets `ok: true` |
| One scope once | two items with one scope accepted | its bad-request vector gets `ok: true` |
| The `bad request` answer echoes nothing | the answer holds the refused field | the answer scan finds the fingerprint |
| A failed drop goes again | the daemon sends a failed drop once | the resend test finds no second snapshot |
| No lifetime id in a command line | the writer names the file and the profile by the lifetime id | the argv scan finds the lifetime id |
| The uid check and the walk first | the token read before steps 1 and 2 | the no-read test reads a byte |
| No token in a log | the header logged at a refusal | the log scan finds the canary |
| No token in an answer | the 401 echoes the header | the answer scan finds the canary |
| The file modes | the writer writes 0644, or the permissions sweep leaves out `sessions/` | the mode test |
| No token in an argv or an environment | the entry writer passes the header in a `-c` value or an environment variable | the spawn scan finds the canary |
| No token on the door | `set_sessions` carries the token, not its fingerprint | the C12 line scan finds the canary |
| The entry only for an allowed session | the writer ignores the list's site count | the no-site test finds an entry file |
| No entry for a Codex app-server launch (E a) | the writer adds `-p` to an app-server launch | the app-server test finds a link |
| The sweep never touches another profile | the sweep removes every `*.config.toml` | the planted profile that is not `aw-*` is gone |
| The sweep matches only `aw-<32 hex digits>.config.toml` | the sweep matches `aw-*` | the planted `aw-notes.config.toml` is gone |
| The sweep keeps a young temp file | the sweep removes each temp file, whatever its age | the young temp file is gone |
| The sweep keeps a live session's file | the sweep takes the lifetime id from the file, not from the index | a live session's file that a client rewrote is gone |
| The uninstall matches only `aw-<32 hex digits>.config.toml` | the uninstall removes `aw-*` | the planted `aw-notes.config.toml` is gone |
| The sweep removes a link, never its target | it removes the resolved target | the planted target is gone |
| The uninstall removes the tokens | the normal uninstall keeps `tokens/agent-browser/` or the links | the uninstall test |
| The redactor knows `abt1_` | the prefix removed from the list | the redactor test |
| Each scan reads its text | a scan that returns no hit at all | its twin test with the planted canary |
| The address check fails closed (stage 5) | the gateway skips the check for a family that is not known | the one-not-known test is admitted |
| A bearer only on the MCP route (stage 5) | the gateway passes a bearer on another route | the route test |
| No API token on `/mcp` (stage 5) | the gateway takes the API token there | the API-token test is admitted |
| Only fingerprints on the link (stage 5) | the calling daemon sends the token | the link scan finds the canary |
| A bad list stays with its box (stage 5) | the serving daemon merges a list without its check | the duplicate-fingerprint test: the serving service refuses the merged snapshot, so the serving box's own new snapshot is not applied |
| The box comes from the link (stage 5) | the serving daemon takes the box from the message body | the other-box test: the list is applied |

### 14.4 The live check plan (local, on taylor)

It runs after stage 2, with the service in its `--test` mode on a free port and a free display, a test repo, a
test list with one site on a local test server, and a canary token that the daemon's test path mints. It does
not touch the operator's agent browser. Stage 3 runs it again on the real path with the operator's approval.

**What it must prove** (the claims of section 4.1 that only documentation or a source reading supports):

1. Claude Code reads the session's `--mcp-config` file with `headers` and the top-level key `agentwatch`, and
   sends the header, with no prompt in an unattended session, also in a session rooted at the home folder.
2. Codex on the standalone launch reads the linked profile file `aw-<random name>.config.toml`, starts the MCP
   from it with `http_headers`, and sends the header to `http://127.0.0.1`.
3. Codex on the app-server launch: the profile gives the app server no agent browser entry (the source reading
   of section 4.1). By the answer E a, each new Codex version gets this check; the entry for such sessions comes
   only when a Codex release passes it.
4. A Codex config write in the session (for example a model change) keeps the link, writes the target with mode
   0600 and keeps the token under the tokens folder (the lifetime id is in the daemon's index, so no Codex write
   can lose it).
5. No client starts an OAuth login at a 401.
6. No client shows the header's value in its `/mcp` view, its logs or its transcript (with point 3 of the steps).
7. Each client's behaviour after a service restart.

**The steps:**

1. agentwatch launches one Claude Code session and one standalone Codex session of the test repo, unattended,
   each with a short task: navigate to the test site and report its title.
2. Both sessions reach the MCP. The service's log shows each admitted request with its scope.
3. A plain string search (`grep -F`) for the canary and its fingerprint finds nothing in: the launch argv and
   environment that agentwatch recorded; `/proc/<pid>/cmdline` and `/proc/<pid>/environ` of each client and of
   its shell commands; the daemon's, the gateway's and the service's logs; the sessions' transcripts; the pane
   captures; Claude Code's per-server MCP logs and its `--debug` file; Codex's trace log and its rollout files;
   the Codex home, except the link's target; `git status` and `git diff` of the test repo. The fingerprint may
   appear only in the C12 lines. The token is only in the entry file. The scan of the Codex home stays, because
   Codex has a config edit that replaces the MCP servers (`replace_mcp_servers`, section 4.1): this scan finds a
   token that Codex writes outside the entry file. The same search for the session's lifetime id finds it in no
   `/proc/<pid>/cmdline`.
4. An agent reads its entry file: in one session, the task tells the agent to print the file with its shell tool.
   The case records where the canary then appears (the tool output, the transcript), as the limit of section 12
   says.
5. A second session of the test repo runs `curl` with the first session's token: the 401. A command under
   `systemd-run --user --scope`, outside every session, with the token: the walk's 403.
6. The test list loses its site: each session's next call gets the no-list 503. The site comes back: a new session
   gets the MCP, and the running ones get it at their next launch.
7. A session ends: its entry file and its link are gone, and `status` shows no session for it. The test daemon
   stops after step 1 of the end (a test hook): at its restart the sweep removes the rest.
8. A service restart: each client's behaviour is recorded (point 7 above).
9. The measures: the time from the launch to the first admitted request, and the cost of the check for each
   request.

Another OS user is not used. The uid check stops that case, by the reasons of C11 (M2 reasoned it). The remote
route has its own two-box live check in stage 5, with the operator.

## 15. The probe

A small local probe ran on taylor (Node v26.12.0, Python 3.13.5) for the revision before the answers, with fake
tokens only, in a scratch folder. It tested per-repo hashes and a header command. Its code is not part of this
design: stage 1d's tests replace it. No new probe ran for this revision.

What still applies:

- the server (`server.mjs`) on `127.0.0.1:<free port>` held only hashes, checked `Origin`, `Host`, the path's
  scope and the bearer in constant time, and its log held no header;
- the scan of 75 texts (every argv and environment that the probe passed to a process, the server's `/proc`
  command line and environment, its log and its output) found no fake token, and its mutations (a token planted
  in an argv, in a log line) found the planted token;
- the hash check took 17.8 µs for each request with 100 compares (100,000 runs). A check against one session's
  fingerprint costs less.

What no longer applies: the header command's cases and its time (36.2 ms p50), the rotation and the overlap
cases, and the repo match.

Not probed: the real clients (no claude or codex session ran), the real walk (stage 1d has M2's code), the Mac.

## 16. The build tasks, in order

Each task is a branch, a pull request with its tests, and a fresh review. None starts before this design's merge.
Each named requirement has its test in section 14.

| # | Side | Task and its named requirements | Tests | Waits for |
| --- | --- | --- | --- | --- |
| 1 | agent-browser | The contract texts: C11, C12 and the service design's sentences of section 13; `mcp_token` in `set_sessions` (sessions, and remote for stage 5); the hello's `mcp_token`; the vectors (C12's `set_sessions` lines with `mcp_token`, the MCP admission vectors with the token cases) | the vector files' own tests; the fake runs the new C12 vectors | this design's merge |
| 2 | agentwatch (the new token store task) | The mint and the fingerprint; the run's random name; `tokens/agent-browser/sessions/` and its modes; the permissions sweep over `tokens/agent-browser/`, `sessions/` and each entry file; a normal uninstall (not only `--purge`) removes `tokens/agent-browser/` and each `aw-<32 hex digits>.config.toml` link on Linux and the Mac, from this task on; `install.sh --update` keeps them; no vault or config sync copies the tokens folder; the redactor's `abt1_` | section 14.2: the mint, the uninstall, the redactor; the mode and sweep mutations | task 1 |
| 3 | agent-browser | Stage 1d (ab-v16.94.5) with the token step: `mcp_token` from `set_sessions` and its field rules, step 7 and its texts, the close at a change, the log rule; the fake's field | section 14.1; the mutations of section 14.3; `npm test` under the heavy lock | task 1, stages 1a to 1c |
| 4 | agentwatch (age-q8t.1) | `set_sessions` with `mcp_token`; the wait for its answer before a launch with the entry; the failure path (no file, a launch without the entry, the health line, `null` in the next snapshot); the resend of a failed drop (1 s, doubling to 60 s, at each reconnect; red at a `bad request`); the feature check | section 14.2: the order, the failure, the resend; against `agent-browser service --fake` | tasks 2 and 3 |
| 5 | agentwatch (age-q8t.7) | The MCP entry writer and the sweep: section 9's rule; the random name of each run, the lifetime id in each file, and the map with its rebuild at the start; the Claude Code entry file; the Codex entry file and profile link (the standalone launch only, by the answer E a); the removal at the end; the relaunch and swap rules; the sweep at each start (after the adoption) and every hour, with `aw-<32 hex digits>.config.toml` links only, each Codex home, and temp files older than 10 minutes only; the Browser pane's session rows and health lines; the gateway's operator field on each route that adds a site | section 14.2: the entry files, the link, the end, the sweep, the pane, the allow paths; the spawn scans | task 4 |
| 6 | agentwatch | The skill text: what an agent does at a 401 and at the no-list 503; never read the tokens folder or a profile link; never print a client's server configuration | a review of the text against sections 7.4 and 12 | task 5 |
| 7 | both | The live check of section 14.4 (stage 2), with its proofs and its leak scan; then stage 3 with the operator's approval. A Codex refusal of a linked profile goes back to the operator (section 9.4) | section 14.4 | tasks 5 and 6 |
| 8 | agentwatch (age-q8t.7) | The Codex app-server entry, by the operator's answer E a: nothing to build until a Codex release lets the app server read a profile. Each new Codex version gets the check of section 14.4, point 3; when a release passes it, the entry for those sessions follows section 9.4 | the check of section 14.4, point 3, for each new Codex version | task 7; a Codex release that passes the check |
| 9 | agent-browser, agentwatch | Stage 4, the Mac (ab-v16.94.6, age-q8t.4): the `libproc` reader, then the Mac's local MCP port opens; the Mac's daemon mints for the Mac's sessions | the Mac checks, through the manager with the operator | task 7 |
| 10 | both | Stage 5 (ab-v16.94.7, age-q8t.5), section 10: agent-browser: the serving service's remote admission (the carrier, the remote scope with `<box>/`, `remote[].mcp_token`, the texts, the grant's list, the answer size limit); agentwatch: the gateway route and its rules, the address check with both families and its texts, both addresses in the status report, the fingerprint lists over the link and their end, the box of each remote item from the link's peer identity, the check of each calling box's list before the merge, the remote entry while the grant is active and its list has a site, the quiet times and the rate limit | sections 14.1 and 14.2, the stage 5 cases; no `abt1_` in a link message; the two-box live check with the operator | task 7; with a Linux serving box only, the lead may run it before task 9 (a Mac serving box needs task 9: the Mac service comes from stage 4) |
| 11 | agentwatch (age-q8t.6) | Stage 6: remove `tokens/agent-browser/` and every `aw-<32 hex digits>.config.toml` link with the old path's cleanup | the uninstall test | task 10 |

The answers remove these tasks of the earlier revision: the header command (its refusals, its tests and its run
again at a 401), the operator's token acts ("Issue token", "New token", "Remove token"), the rotation and its
overlap timer, the pending revoke, the `mcp_tokens` op, `repo_key`, `state.json`, and the later "command over the
daemon's socket".

## 17. Questions for the operator

Every question has the operator's answer (section 2): the five questions of the earlier revision and the address
question (ab-0wv, ab-sxg, ab-ufy, ab-5t3), and question E and the Cloudflare question (ab-h93). No question is
open.

**A. Which side makes, keeps and checks each token? Answered** (ab-0wv, 2026-11-10 13:24Z): "agentwatch mints
the token and inserts it into the mcp configuration i think. can we do that? so it gets generated when the
session starts." The design: agentwatch's daemon mints at each session's start, writes the token into the
session's own entry, and sends only its fingerprint to the agent browser (sections 6 and 9).

**B1. What allows a repo? Answered** (ab-0wv): option a, the repo's list (section 7.2).

**B2. A schedule? Answered** (ab-0wv): "mint the token when the agentwatch session begins." The design: a fresh
token for each session, which ends with the session; no schedule and no rotation (sections 1 and 6.5).

**C. How does a session send its token? Answered** (ab-sxg, 13:12Z): "can't we put the token in the MCP call in
the header? i think mcp protocol supports this. so it would be no extra command. it would just be in the
headers." The lead's reading on ab-ufy, confirmed (13:27Z): "keep it. token goes in the mcp header." The design:
a fixed `Authorization` header in each session's own entry file, no command (section 9).

**D. Where does a token work? Answered** (ab-sxg): option c, direct HTTPS to the other box (section 10). The
Cloudflare question (below) asked it again with the fact that its text left out.

**The address check. Answered** (ab-5t3, 13:26Z): "you can use an IP allowlist as long as you have the ipv4 and
ipv6 of each daemon." The design: the serving box's gateway takes a remote token only from the calling box's
known IPv4 and IPv6 addresses, and fails closed when one is not known (section 10). The design's reading: a
family in the state "none" (the box reports no global address of that family) counts as known. It adds no
address that can match.

**E. How does a Codex session that agentwatch runs with its app server get its token? Answered** (ab-h93,
2026-11-10 18:06Z): option a, "Wait for a Codex release that lets the app server read a profile" ("Those
sessions keep the browser through Playwright, with no MCP, until then. Nothing new is built, and your "no extra
command" stays."). The design: no entry for a Codex session with the app server until a Codex release lets the
app server read a profile; each new Codex version gets the check of section 14.4, point 3; nothing new is built
(sections 9.4 and 16, task 8). The question as the design asked it stays below, for the record.

**The Cloudflare question. Answered** (ab-h93, 18:06Z). The question: "A taylor session that uses your Mac's
agent browser: keep direct HTTPS through Cloudflare, or use the agentwatch link?" The board item said that the
earlier text of D c left out a fact: on that route the encryption ends at Cloudflare's edge, so Cloudflare sees
each request in clear (the token, the tool arguments and the page text). The recommendation was the agentwatch
link. The operator chose "Keep direct HTTPS through Cloudflare" ("No program between. Cloudflare sees the token,
the tool arguments and the page text of each request. The address check stays."). The design: section 10 stays
(direct HTTPS, the address check), and section 10 and T10 state what Cloudflare sees.

The record of question E, as the design asked it:

Context: you chose the token in each session's own MCP entry, with no extra command (ab-sxg, ab-ufy). For Codex,
agentwatch writes the entry into a profile file for the session. Codex 0.159.3 reads a profile only in its
terminal program, not in its app server. agentwatch runs most Codex sessions with an app server of their own,
which makes the session's MCP connections and carries agentwatch's notices into Codex (your Codex notice parity:
"The app server first"). So for those sessions the profile never reaches the MCP connection. A Codex session
without the app server (an open-model session, or a resume in a mode that the app server cannot carry) can use
the profile now. Claude Code sessions are not affected.

Every agent session of your OS user runs as that same user. So an agent can read its own session's token file,
and any other session's. A copied token works only from its own session, and only while that session runs.

- **a. Wait for Codex (recommended).** A Codex session with the app server gets no agent browser MCP until a
  Codex release lets the app server read the session's profile. Such a session still uses the agent browser
  through `agentwatch browser` and Playwright. Codex sessions without the app server get the MCP now. Nothing that
  you declined is built, and nothing new is built. agentwatch checks each new Codex version for this.
- **b. A short header command for Codex's app server only.** The app server runs an agentwatch command at each
  connection; the command reads the session's token file and gives the header. All Codex sessions get the MCP
  now. It goes against your "no extra command", for Codex only, and it adds a command and its checks.
- **c. Run an allowed Codex session without the app server.** The session's terminal program reads the profile
  and sends the header, as you asked. But such a session loses what the app server gives agentwatch: its notices
  come as typed text again (against your Codex notice parity), and agentwatch reads the session only from the
  screen.

The recommendation was a: it keeps your answers, it builds nothing new, and those sessions keep the agent browser
through Playwright. The no-answer behaviour was a. The operator chose a.

## 18. Limits and open points

- **A resend that cannot succeed** (review-103d): C12 keeps the old snapshot at a refusal. A snapshot can fail for
  a reason that the resend cannot clear (for example a daemon fault that puts one bad local item into each
  snapshot). Then the service keeps the last fingerprints that it took, also remote ones, and only the red health
  line shows the fault.
- **The same-uid limit** stays (section 5). This design does not claim isolation between sessions of one OS user
  from the token. The walk gives it, for every program that is not hostile.
- **An agent can copy a token** (T9, section 12): it can read its own entry file, or another session's. The token
  then goes into its transcript and the model's context. The copy gives no new right.
- **The list is the allow** (B1 a), and a program of the same user can change a list file by hand. The MCP's
  allow has the lists' own limit.
- **Codex with agentwatch's app server**: by the answer E a, no MCP for such a session until a Codex release lets
  the app server read a profile; it keeps the browser through Playwright. The claims about the app server are
  source readings at the tag; stage 2 confirms them, and each new Codex version gets the same check (section
  14.4, point 3).
- **Codex's own config edits** in a session go into the session's entry file, and they end with it. A person who
  changes a Codex setting in such a session does not keep the change.
- **A linked profile file** is a source reading; stage 2 proves it. A refusal goes back to the operator.
- **The random name in an argv** (a small leak): every OS user on taylor sees each run's random name in the
  client's command line, and no lifetime id (the daemon lead's addition). A random name gives no right.
- **The lifetime id in the entry file**: Claude Code's acceptance of the top-level key `agentwatch` and the stay
  of the TOML comment after a Codex write are not proven; stage 2 checks both (section 14.4, points 1 and 4). A
  refusal goes to the daemon lead, who chooses another place for the lifetime id with no secret and no command
  line.
- **Cloudflare sees the remote MCP traffic in clear** (D c): the remote token, the tool arguments and the page
  text. The operator chose this route with that fact (ab-h93, "Keep direct HTTPS through Cloudflare"), against
  the recommended link path. The address check stays.
- **The address check's failure modes** (section 10): a changed address stops the box's remote sessions until
  its next report; a box with IPv6 temporary addresses fails often; a shared address admits a leaked token.
- **The remote route** no longer needs a stdio program, a daemon socket or a Python walk. Stage 5 gets smaller on
  agentwatch's side, and it adds the gateway route and the address check.
- **A long session** keeps its token for its whole life (B2: no schedule).
- **The CDP path of the agent door** takes no token (section 11). If the operator wants a token there too, that
  is a later design.
- **First values**: the answer's wait (5 s), the resend of a failed drop (after 1 s, doubling up to 60 s), the
  remote fingerprint list's interval (5 minutes) and its end (15 minutes), the remote fingerprint limit for each
  box (64), the sweep's interval (1 hour), the sweep's age for a temp file (10 minutes), the remote rate limit (10
  a second, 4 at once) and the answer size limit (16 MiB). The build measures and records them.
- **The title** of this file still says "per-repo" in its file name: by the answers, each session gets its own
  token.
