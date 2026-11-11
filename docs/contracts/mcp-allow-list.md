# The MCP's allow list (a part of C11)

**The master of this format (board task ab-v16.94.1).** This file is the master for the format of the MCP's
allow list. It is a part of C11 (`docs/contracts/C11.md`, the MCP inside the service). Its source is the design
`docs/superpowers/specs/2026-11-09-self-contained-agent-browser-design.md`, section 8.2, and the operator's
answer Q4 of 2026-11-10 (the standard Playwright MCP, pinned, under the allow list; the design's section 19).
Stage 1d (board ab-v16.94.5) writes the first list for the pinned version of `@playwright/mcp`, and its test.
Stage 1d's first list holds the 24 tools of M3's part C (the self-contained design, section 8.2), and no
`browser_run_code_unsafe`. Stage 0 adds no package. The vectors of the format: `test/vectors/mcp-allow-list.json`.
The stored sign-ins design (`docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md`, board
ab-v16.95, section 10) adds the service's own tools, `service_tools`; their MCP build is board ab-v16.97.5, with stage
1d.

**Why an allow list.** The service serves only the tools and the argument keys that the list names, not every
tool except some. So a new tool or a new argument in a newer `@playwright/mcp` reaches no client until a review
adds it to the list.

**The file.** One JSON file for the one pinned version of `@playwright/mcp`, in this repository. Its fields:

```json
{"package":"@playwright/mcp","version":"<the pinned version>","capabilities":["<capability>"],
 "tools":{"<tool>":{"keys":["<key>"],"paths":["<key>"],"schema":{}}},
 "service_tools":{"<tool>":{"keys":["<key>"],"description":"<text>","schema":{}}},
 "refused":{"<tool>":"<why>"}}
```

- `package` is `@playwright/mcp`. `version` is the exact pinned version, the same as the pin in
  `package.json`.
- `capabilities` names the MCP's capabilities that the service turns on, explicitly: the ones that give the
  tools of `tools`. It never names `core-install`, `storage`, `devtools`, `testing` or `config`.
- `tools` maps each allowed tool to its rule. `keys` lists each argument key that the service passes.
  `paths` lists each key of `keys` that names a file or a path. `schema` is the tool's input schema in the
  pinned version's `tools/list`, as it is.
- `refused` maps each other tool of the pinned version's `tools/list` to the reason why the service never
  serves it. `browser_run_code_unsafe` is always in `refused`: it runs a client's JavaScript in the MCP server's
  process, which inside the service holds the lists, the native link and the control door's state.
- Each tool of the pinned version's `tools/list` is in `tools` or in `refused`, and in only one of them.
- `service_tools` maps each of the service's own tools to its rule: `keys` (each argument key that the service takes),
  a `description` and a `schema` (the tool's input schema). They are no tools of `@playwright/mcp`: the service
  answers them itself (C11, the sign-in act). They are exactly these two, in every list:

```json
{"browser_sign_in":{"keys":["name"],"description":"Sign in to a site with a credential that the operator stored. Give its name: browser_sign_ins lists the names. The agent never gets the password.","schema":{"type":"object","properties":{"name":{"type":"string","description":"The name of a stored sign-in"}},"required":["name"],"additionalProperties":false}},
 "browser_sign_ins":{"keys":[],"description":"List the stored sign-ins that this session may use, and the state of the store.","schema":{"type":"object","properties":{},"additionalProperties":false}}}
```

**What the service does with it (stage 1d).**

- `tools/list`: the service drops each tool that `tools` does not name, and adds each tool of `service_tools` for a
  request with a local admission; a request that a remote token admitted gets no tool of `service_tools`.
- `tools/call` of a tool that neither `tools` nor `service_tools` names: the service refuses it before the call
  reaches the MCP's code, with the JSON-RPC error `-32601` and the message `Not available in the agent browser: <tool>`.
- `tools/call` with an argument key that the tool's `keys` does not name: the service refuses it before the
  call reaches the MCP's code, with the JSON-RPC error `-32602` and the message `Not available in the agent browser: the argument <key> of <tool>`.
- An argument whose key is in the tool's `paths`: the service refuses it when the path is outside the scope's
  folder, `<state>/mcp/<scope>/`, after `realpath` (C11), with the JSON-RPC error `-32602` and the message
  `Not available in the agent browser: <key> must name a file in the session's folder <folder>`.
- `tools/call` of a tool of `service_tools`: the service answers it itself, and the call never reaches the MCP's code.
  For a request that a remote token admitted, the answer is the tool error of the sign-in act's check 1, a result with
  `isError: true` and the text `Not signed in: Stored sign-ins work only for sessions of this box.`, whatever its
  arguments. For a request with a local admission, an argument key that the tool's `keys` does not name gets the
  `-32602` answer above; else the service runs the sign-in act's method for the MCP session's scope (C11, the sign-in
  act).

**The test (stage 1d, in `npm test`, with no browser).** The MCP answers `initialize` and `tools/list` with no
CDP connection (the design, section 18), so the test needs no Chrome. It fails when any of these is false:

- each tool of the pinned version's `tools/list` is in `tools` or in `refused`, once;
- each `schema` equals that tool's input schema in the pinned version, so any change of a tool fails the test,
  and each bump of the pin needs a new review of the list;
- each key of `keys` is a property of its tool's `schema`, and each key of `paths` is a key of `keys`;
- each string property whose schema speaks of a file or a path (its name or its description) is in `paths`, or
  is left out of `keys`;
- `browser_run_code_unsafe` is in `refused`;
- no name of `service_tools` is a tool of the pinned version's `tools/list`;
- `service_tools` is exactly the value that this file gives;
- `capabilities` names none of `core-install`, `storage`, `devtools`, `testing` and `config`.
