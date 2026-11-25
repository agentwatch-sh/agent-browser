# The MCP's allow list (a part of C11)

**The master of this format (board task ab-v16.94.1).** This file is the master for the format of the MCP's
allow list. It is a part of C11 (`docs/contracts/C11.md`, the MCP inside the service). Its source is the design
`docs/superpowers/specs/2026-11-09-self-contained-agent-browser-design.md`, section 8.2, and the operator's
answer Q4 of 2026-11-10 (the standard Playwright MCP, pinned, under the allow list; the design's section 19).
Stage 1d (board ab-v16.94.5) writes the first list for the pinned version of `@playwright/mcp`, and its test.
Stage 1d's first list, `src/service/mcp/allow-list.json`, is for `@playwright/mcp` 0.0.83: it holds the 24 tools of
that version's `tools/list` other than `browser_run_code_unsafe`, as M3's part C did for 0.0.85 (the self-contained
design, section 8.2). Stage 0 adds no package. The vectors of the format: `test/vectors/mcp-allow-list.json`.
The stored sign-ins design (`docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md`, board
ab-v16.95, section 10) adds the service's own tools, `service_tools`; their MCP build is board ab-v16.97.5, with stage
1d. The PageFetch design (`docs/superpowers/specs/2026-11-15-page-fetch-design.md`, board ab-v16.102) adds the service's
own tool `PageFetch`. The secure card checkout design (`docs/superpowers/specs/2026-11-21-secure-card-checkout-design.md`,
board goal ab-sta) adds the service's own tools `browser_pay` and `browser_pay_status`, which the service serves only
with the payment act (C11, the card payment).

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
  answers them itself (C11, the sign-in act, PageFetch and the card payment).
  They are exactly these five, in every list:

```json
{"browser_sign_in":{"keys":["name"],"description":"Sign in to a site with a credential that the operator stored. Give its name: browser_sign_ins lists the names. The agent never gets the password.","schema":{"type":"object","properties":{"name":{"type":"string","description":"The name of a stored sign-in"}},"required":["name"],"additionalProperties":false}},
 "browser_sign_ins":{"keys":[],"description":"List the stored sign-ins that this session may use, and the state of the store.","schema":{"type":"object","properties":{},"additionalProperties":false}},
 "PageFetch":{"keys":["url","mode","offset"],"description":"Fetch one web page or PDF that blocks plain HTTP clients (a 401, a 403, a bot check, a page that needs JavaScript) and get its rendered content as markdown, or the text of each page of a PDF. Use it when WebFetch fails on a page. The agent browser loads the page in a clean private window, and it never clicks, types or sends a form.","schema":{"type":"object","properties":{"url":{"type":"string","description":"The absolute http or https URL of the page"},"mode":{"type":"string","enum":["main","whole"],"description":"main (the default) gives the main content; whole gives the whole rendered page, for lists, tables and pages that are not articles"},"offset":{"type":"integer","minimum":0,"description":"The character position to read from: the header of a long result gives the next one"}},"required":["url"],"additionalProperties":false}},
 "browser_pay":{"keys":["card","origin","amount","currency","description","button"],"description":"Pay at a merchant's checkout with a card that the operator stored. First drive the checkout to its payment step in one tab, then give the card's name, the merchant's origin, the total and its currency, and what you buy. The operator approves each payment in the Browser pane, and the agent never gets a value of the card.","schema":{"type":"object","properties":{"card":{"type":"string","description":"The name of a stored card"},"origin":{"type":"string","description":"The merchant's origin, for example https://shop.example.com"},"amount":{"type":"string","pattern":"^(?!0+(\\.0{1,2})?$)(0|[1-9][0-9]*)(\\.[0-9]{1,2})?$","description":"The total to pay: a decimal number above 0 with at most two decimals, for example 12.50"},"currency":{"type":"string","pattern":"^[A-Z]{3}$","description":"The code of the total's currency: three capital letters, for example USD"},"description":{"type":"string","maxLength":500,"description":"What you buy, in your own words, for the operator's approval"},"button":{"type":"string","maxLength":100,"description":"A hint of the pay button's text"}},"required":["card","origin","amount","currency","description"],"additionalProperties":false}},
 "browser_pay_status":{"keys":[],"description":"List the results of this session's card payments of the last 24 hours.","schema":{"type":"object","properties":{},"additionalProperties":false}}}
```

**What the service does with it (stage 1d).**

- `tools/list`: the service drops each tool that `tools` does not name, and adds each tool of `service_tools` for a
  request with a local admission while the service has the part that serves it (the sign-in act for `browser_sign_in`
  and `browser_sign_ins`, PageFetch for `PageFetch`, the payment act for `browser_pay` and `browser_pay_status`); a
  request that a remote token admitted gets no tool of `service_tools`.
- In `tools/list` the input schema of each tool of `tools` holds only the keys of its `keys`: the service drops each
  other property and its entry in `required`.
- `tools/call` of a tool that neither `tools` nor `service_tools` names: the service refuses it before the call
  reaches the MCP's code, with the JSON-RPC error `-32601` and the message `Not available in the agent browser: <tool>`.
- `tools/call` with an argument key that the tool's `keys` does not name: the service refuses it before the
  call reaches the MCP's code, with the JSON-RPC error `-32602` and the message `Not available in the agent browser: the argument <key> of <tool>`.
- `tools/call` whose `arguments` is not a JSON object: the service refuses it before the call reaches the MCP's code,
  with the JSON-RPC error `-32602` and the message `Not available in the agent browser: the arguments of <tool> must be a JSON object`.
- The service's own tools are in a `tools/list` only for a request with a local admission while the service has the
  part that serves each of them (C11), after the tools of `tools`, each as `{"name","description","inputSchema"}` with
  its `description` and its `schema`. While the service does not have that part, a `tools/call` of the tool with a local
  admission gets the `-32601` answer of a tool that `tools` does not name.
- An argument whose key is in the tool's `paths`: the service refuses it when the path is outside the scope's
  folder, `<state>/mcp/<scope>/`, after `realpath` (C11), with the JSON-RPC error `-32602` and the message
  `Not available in the agent browser: <key> must name a file in the session's folder <folder>`. For a request that a
  remote token admitted, the service refuses each such argument, wherever it points, with the JSON-RPC error `-32602`
  and the message
  `Not available in the agent browser: <key> names a file, and a session of another box cannot name a file of this box.`;
  a call with no such argument passes.
- `tools/call` of a tool of `service_tools`: the service answers it itself, and the call never reaches the MCP's code.
  For a request that a remote token admitted, the answer of `browser_sign_in` and `browser_sign_ins` is the tool error
  of the sign-in act's check 1, a result with `isError: true` and the text
  `Not signed in: Stored sign-ins work only for sessions of this box.`, and the answer of `PageFetch` is the tool error
  `Not fetched (unavailable): PageFetch works only for sessions of this box.`, and the answer of `browser_pay` and
  `browser_pay_status` is the tool error `Not paid: Payments work only for sessions of this box.`, whatever its
  arguments. For a request with a local admission, `arguments` that is not a JSON object, or an argument key that the
  tool's `keys` does not name, gets its `-32602` answer above; else the service runs the sign-in act's method,
  PageFetch or the payment act for the MCP session's scope (C11, the sign-in act, PageFetch and the card payment).
- A blanket scope (C11, the blanket profile; board ab-4wh): its `tools/list` holds no tool of `service_tools`, also
  with a local admission, and a call of one gets the tool error of C11's part on the blanket profile, whatever its
  arguments.

**The test (stage 1d, in `npm test`, with no browser).** The MCP answers `initialize` and `tools/list` with no
CDP connection (the design, section 18), so the test needs no Chrome. It fails when any of these is false:

- each tool of the pinned version's `tools/list` is in `tools` or in `refused`, once;
- each `schema` equals that tool's input schema in the pinned version, so any change of a tool fails the test,
  and each bump of the pin needs a new review of the list;
- each key of `keys` is a property of its tool's `schema`, and each key of `paths` is a key of `keys`;
- each string property whose schema speaks of a file or a path (its name or its description) is in `paths`, or
  is left out of `keys`, with no exception for a string whose values an `enum` or a `const` fixes, with the `type`
  `string` or with no `type`; a schema speaks of a file or a path when its name or its description holds `file`, `path`,
  `folder` or `directory`, in any case, also inside a word (so `browser_take_screenshot`'s `type`, an `enum` string
  whose description names the file name's extension, is left out of `keys` in the first list); the test reads each
  string inside a key's schema too, in `anyOf`, `oneOf`, `allOf`, `items`, nested `properties`, `additionalProperties`
  and `propertyNames`, with the names and descriptions on its way, and a key whose schema has a shape that the test
  cannot read (no `type` and no `anyOf`, `oneOf`, `allOf`, `enum` or `const`, a `$ref`, or a keyword that the test does
  not know) fails the test;
- each key that a tool's `schema` requires is in its `keys`;
- no tool's `keys` names `_meta` (the package reads `arguments._meta` to change the base of relative file names);
- `browser_run_code_unsafe` is in `refused`;
- no name of `service_tools` is a tool of the pinned version's `tools/list`;
- `service_tools` is exactly the value that this file gives;
- `capabilities` names none of `core-install`, `storage`, `devtools`, `testing` and `config`.
