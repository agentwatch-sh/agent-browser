# The MCP's allow list (a part of C11)

**The master of this format (board task ab-v16.94.1).** This file is the master for the format of the MCP's
allow list. It is a part of C11 (`docs/contracts/C11.md`, the MCP inside the service). Its source is the design
`docs/superpowers/specs/2026-11-09-self-contained-agent-browser-design.md`, section 8.2, and the operator's
answer Q4 of 2026-11-10 (the standard Playwright MCP, pinned, under the allow list; the design's section 19).
Stage 1d (board ab-v16.94.5) writes the first list for the pinned version of `@playwright/mcp`, and its test.
Stage 0 adds no package. The vectors of the format: `test/vectors/mcp-allow-list.json`.

**Why an allow list.** The service serves only the tools and the argument keys that the list names, not every
tool except some. So a new tool or a new argument in a newer `@playwright/mcp` reaches no client until a review
adds it to the list.

**The file.** One JSON file for the one pinned version of `@playwright/mcp`, in this repository. Its fields:

```json
{"package":"@playwright/mcp","version":"<the pinned version>","capabilities":["<capability>"],
 "tools":{"<tool>":{"keys":["<key>"],"paths":["<key>"],"schema":{}}},
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

**What the service does with it (stage 1d).**

- `tools/list`: the service drops each tool that `tools` does not name.
- `tools/call` of a tool that `tools` does not name: the service refuses it before the call reaches the MCP's
  code, with the JSON-RPC error `-32601` and the message `Not available in the agent browser: <tool>`.
- `tools/call` with an argument key that the tool's `keys` does not name: the service refuses it before the
  call reaches the MCP's code, with the JSON-RPC error `-32602` and the message `Not available in the agent browser: the argument <key> of <tool>`.
- An argument whose key is in the tool's `paths`: the service refuses it when the path is outside the scope's
  folder, `<state>/mcp/<scope>/`, after `realpath` (C11), with the JSON-RPC error `-32602` and the message
  `Not available in the agent browser: <key> must name a file in the session's folder <folder>`.

**The test (stage 1d, in `npm test`, with no browser).** The MCP answers `initialize` and `tools/list` with no
CDP connection (the design, section 18), so the test needs no Chrome. It fails when any of these is false:

- each tool of the pinned version's `tools/list` is in `tools` or in `refused`, once;
- each `schema` equals that tool's input schema in the pinned version, so any change of a tool fails the test,
  and each bump of the pin needs a new review of the list;
- each key of `keys` is a property of its tool's `schema`, and each key of `paths` is a key of `keys`;
- each string property whose schema speaks of a file or a path (its name or its description) is in `paths`, or
  is left out of `keys`;
- `browser_run_code_unsafe` is in `refused`;
- `capabilities` names none of `core-install`, `storage`, `devtools`, `testing` and `config`.
