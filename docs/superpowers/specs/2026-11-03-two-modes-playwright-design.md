# Two modes: operator mode sends sign-ins, agent mode serves the Playwright APIs — design

Date: 2026-11-03. Status: **DRAFT for the operator's review.** Author: taylor session `ab-design`
(board task ab-v16.1, goal ab-v16). Branch `ab-v16.1-design-the-two-modes-and-how-agent-mode`.
Evidence: the probe in [2026-11-03-two-modes-probe/](2026-11-03-two-modes-probe/README.md), run on
taylor with Debian Chromium 156.0.8078.73, Playwright 1.64.1 and Playwright MCP 0.0.84.

Updated on 2026-11-04 (board task ab-v16.14). This version holds the operator's answers of
2026-11-04 to the design's questions (ab-jzg, section 14), to the Chrome comparison's questions
(ab-vsm, section 9) and to the follow-up items ab-32m, ab-8mf and ab-9hj. It also holds the Mac
facts of 2026-11-03 (the comparison's Mac checks) and of 2026-11-04 (the focus result of board task
ab-b84.11). No question of the operator from these items stays open. The choice of the Mac's
install waits for the Mac stage (ab-v16.8).

This design builds on the agentwatch design `docs/superpowers/specs/2026-10-31-agent-browser-design.md`
(agentwatch main) and keeps its operator decisions O1 to O19. Section 13 names the places where this
design changes a part of it; none changes an operator decision.

## 1. The answer in short

- **One extension, two packages.** One product, one repo (agentwatch-sh/chrome-extension), one source
  tree. The **operator-mode package** goes into the operator's own Chrome; the **agent-mode package**
  goes into the agent Chrome. The package fixes the mode. Chrome grants permissions per package, so
  the operator-mode package holds no `debugger` permission at all: Chrome itself makes control of the
  operator's Chrome impossible (section 3).
- **Agent mode serves a local CDP endpoint (option a).** Any program that speaks CDP connects to it
  with no WebDriver and no change in its code: Playwright `chromium.connectOverCDP(endpoint)`, the
  Playwright MCP with `PLAYWRIGHT_MCP_CDP_ENDPOINT`, and agent-browser itself. A **browser model**
  behind the endpoint answers the browser-level CDP calls (Browser, Target, Storage) from `chrome.*`
  APIs and sends every page-level call to `chrome.debugger` in the agent-mode extension (section 4).
- **Measured on taylor:** 49 of 49 Playwright cases (six of them are refusals that the design wants)
  over a Unix socket and over loopback TCP; 13 Playwright MCP calls and two checks of what the site
  saw (15 of 15), and 14 of 14 cases on several connections and scopes, over the Unix socket. No
  prompt appears (sections 5 and 4.4). The probe ran before the operator's answers. With the
  answers on the page marks (refuse them) and the sign-ins (no cookie calls), five of the 49
  Playwright cases and one of the 14 concurrency cases now get a refusal (section 5).
- **No prompt on any path that agentwatch uses.** Every feature that agentwatch offers goes through
  the extension. The few features that only Chrome's "Allow remote debugging?" connection gives (a
  new isolated context, service-worker targets, JS coverage, a few browser-wide domains) give a clear
  error in agent mode (section 6). The operator chose "Never" for that path (ab-jzg Q2).
- **What a site can see:** no `navigator.webdriver`, no banner, no resize, and no new page globals
  for normal use. The probe found four marks. Two are fixed in the model: the navigation header
  `Sec-Fetch-Site` and the pointer pressure of a click. `fill` types with no key events (the skill
  tells agents how to type). Playwright's own globals for init scripts, bindings and tracing
  snapshots never reach a page: the operator chose "Refuse them" (ab-jzg Q3), so the model refuses
  those calls, and a program that uses them gets a clear error. The Chrome comparison measured a
  timing mark of Playwright's Runtime domain, which this design does not hide (section 7).
- **The allowlist holds for any CDP client:** DNR blocks every off-list top-level navigation in
  Chrome, and a new DNR rule blocks every frame of a tab whose top-level page is not on the list. The
  off-list host got no request in any run. The browser model adds a permission filter, one
  connection per tab, and the tab scope (section 8). **No cookie calls:** the operator chose "No
  cookies by default" (ab-jzg Q4 and the follow-up item ab-8mf). The endpoint refuses every cookie
  call, so programs that read or set cookies through Playwright fail. The browser still uses its
  cookies, so the sent sign-ins work on the sites. A later cookie grant can add cookie calls if a
  use case needs them.
- **Which Chrome:** Google Chrome stable at the operator's version, on the operator's kind of
  machine, not Beta (the Chrome comparison, ab-v16.2). The operator's answer to ab-vsm Q1: taylor
  runs most browser work, and the Mac runs the agent browser only for a new site, a Cloudflare box
  and other difficult sites. On taylor the agent package installs with no prompt through the
  external extensions file of agentwatch's own Chrome copy (the operator's answer to ab-32m). On the
  Mac that file gives no working extension from a local CRX (measured), so the Mac needs one "Load
  unpacked" per agent profile, a store item or an MDM policy; that choice waits for the Mac stage.
  On the Mac the agent Chrome is the operator's own `Google Chrome.app`, started a second time with
  its own profile (the operator's answer to ab-9hj). Sections 9 and 10.
- **Build:** six stages over three repos (section 12). The operator answered the design's four
  questions on 2026-11-04 (section 14, ab-jzg; the sign-ins through ab-8mf).

## 2. The operator's words and the measure

- 2026-11-02: "i want our chrome extension to work with playwright APIs. i.e. it allows the same APIs
  to control the browser via our extension, but no webdriver. so apps that already expect playwright
  or the playwright mcp, etc, all connect with no changes needed."
- 2026-11-03: "agentbrowser gets two modes: operator mode + agentmode. so i install in my own browser
  and it is in operator mode. i use it to "beam" the cookies and localstorage , etc to the
  independent agent browser. and then the other is agent mode. and there the agent can control it
  totally as if it was playwright."
- 2026-11-03: "so basically we need to know which control features can flow through the extension,
  which ones go to the debugging approval, and how it all works together."
- 2026-11-03, the top goal: "Fully drivable browser for agents that isn't subject to automation
  blocks, so agents can do whatever I ask them to do." "Ideal world: no prompts necessary."

This design measures each choice against three things: full Playwright-level control, no automation
signal that a site can see, and no prompt.

## 3. The two modes (task item 1)

### 3.1 One extension, two packages

The operator's words read as one extension with two modes. Chrome cannot give one package two
permission sets: `debugger` and `declarativeNetRequest` cannot be optional permissions (Chrome's
`chrome.permissions` documentation; not measured). One package with control in it would give the
operator's own Chrome the `debugger` permission and its install warning, even if its code never used
it. So the design keeps one product and one source tree, and builds two packages from it:

| | Operator mode | Agent mode |
| --- | --- | --- |
| Today's folder | `sender/` | `receiver/` |
| New folder | `operator/` | `agent/` |
| Name in Chrome | agentwatch — operator mode | agentwatch — agent mode (agent browser only) |
| Extension ID | `bpfkgknpndlpkcffmaaelkfcbpackiip` (kept) | `dofdpnfachcncepdoondkeodcbnhipdc` (kept for an unpacked load; a packed CRX gets a new ID, section 10) |
| Who installs it | The operator, once, in their own Chrome (Load unpacked from the Browser pane's download; a Web Store listing is a later choice) | The daemon (section 10), or on the Mac the operator once per agent profile |
| Permissions | `cookies`, `activeTab`, `scripting`, `storage`, optional host permissions | `debugger`, `tabs`, `webNavigation`, `declarativeNetRequest`, `cookies`, `scripting`, `nativeMessaging`, `browsingData`, `downloads`, `contentSettings`, `<all_urls>` |

The operator-mode ID stays, so the gateway's `Origin` check stays as it is. Shared code (`shared/`:
the codec, the cookie mapping, the domain rules) stays shared, as today.

### 3.2 How the mode is chosen

The package is the mode. Nothing switches a mode at run time:

- The **agent Chrome's launch sets agent mode**: the daemon gives the agent Chrome the agent package
  (section 10). The daemon never gives it the operator package.
- The Browser pane offers only the operator package for download.
- The agent package works only where the daemon wrote its native host manifest into the profile
  (`<profile>/NativeMessagingHosts/`; measured in stage 1). Without its link it runs no call and
  opens no connection.
- New in stage 2: the native host checks that its parent Chrome runs on the agent profile
  (`--user-data-dir` in `/proc/<ppid>/cmdline` on Linux, `ps` on the Mac) and refuses otherwise.
  Today stage 1 checks only, in the daemon, that the host's parent is the unit's Chromium (Linux).

### 3.3 What each mode does

| | Operator mode | Agent mode |
| --- | --- | --- |
| Read a site's cookies and the current tab's page storage | Yes, on the operator's click in its popup only | No |
| Send a site's state to a box (the "beam", O14, O15, O17) | Yes (the two gateway routes of contract C9) | No |
| Write a site's state (the import, O19) | No | Yes (stage 1) |
| Block off-list top-level pages (O13) and frames under an off-list top page | No | Yes (DNR) |
| Control the browser (CDP) | **Never: it holds no `debugger` permission** | Yes, through `chrome.debugger` (O18) |
| Talk to the daemon | No | Yes, over native messaging only |
| Accept a connection or a message from outside | No: no `externally_connectable`, no content script, no web-accessible resource, no listener | Only from its own native host |

### 3.4 Why operator mode can never control the operator's Chrome

1. The operator package has no `debugger`, `nativeMessaging` or `declarativeNetRequest` permission.
   Chrome then gives the extension no `chrome.debugger` API at all. This is Chrome's rule, not our
   code's.
2. Operator mode has no inbound channel. It never polls, never holds a WebSocket and never listens. It
   sends a request only when the operator clicks Send in its popup. A box cannot reach it.
3. A test in chrome-extension (today's `test/manifests.test.mjs`) fails the build if the operator
   manifest gains one of those permissions, a content script, `externally_connectable` or
   `web_accessible_resources`.
4. If the operator loads the agent package into their own Chrome by mistake, its DNR block stops all
   browsing at once, which shows the mistake. It never controls that Chrome: the profile holds no
   native host manifest for it, and (from stage 2) the host refuses a parent Chrome that is not on an
   agent profile. Its name says "agent browser only".

## 4. How agent mode serves the Playwright APIs (task item 2)

### 4.1 The three options

| Option | What it is | Result |
| --- | --- | --- |
| (a) A local CDP endpoint, relayed through the extension | A process on the box speaks CDP to clients and drives Chrome through the extension | **Chosen.** Playwright, the Playwright MCP (`--cdp-endpoint` or `PLAYWRIGHT_MCP_CDP_ENDPOINT`) and agent-browser connect with no code change (measured) |
| (b) The Playwright MCP's extension mode | `@playwright/mcp --extension` talks to Microsoft's "Playwright Extension" | Not used. It is tied to Microsoft's extension ID (`playwrightExtensionId` in playwright-core); our extension must not take that ID. It starts its own browser to open a connect page, its relay serves one client, and it answers `Browser.setDownloadBehavior` with nothing, so downloads do not reach Playwright (playwright-core 1.65.0-alpha `cdpRelay.ts`, read, not run). (a) already serves the MCP |
| (c) Both | | Not needed: (a) covers the MCP |

Playwright's own relay (`cdpRelay.ts`, "protocol V2") is prior art for (a): a thin extension that
forwards `chrome.debugger` and `chrome.tabs` events, and a relay that holds the browser model. This
design takes the same shape and closes the gaps that the probe found (downloads, permissions, raw
CDP sessions, several clients, scopes, popups).

### 4.2 The parts

```
 Playwright script ─┐                    the box (one OS user)                      the agent Chrome
 Playwright MCP  ───┼─ CDP over ws ──► endpoint + browser model ◄─ bridge ─► daemon ◄─ native link ─► agent-mode extension
 agent-browser CLI ─┘   (Unix socket)   (agent-browser "relay")    (JSON)    (link)    (stage 1, C4)     chrome.debugger, chrome.tabs,
                                                                                                         chrome.cookies, chrome.downloads,
                                                                                                         chrome.contentSettings, DNR
```

- **The agent-mode extension is a thin bridge.** It runs a fixed list of `chrome.*` calls for the
  browser model and forwards events (`chrome.debugger.onEvent` and `onDetach`, `chrome.tabs`,
  `webNavigation`, `chrome.downloads`). It keeps the stage-1 jobs (the import, the DNR block). It holds
  no CDP logic. A thin extension changes rarely, and that matters on the Mac, where an extension
  change is a manual reload per profile.
- **The browser model and the endpoint live in agent-browser** (TypeScript, O1: agent-browser owns
  the browser code). A new internal command, `agent-browser relay`, serves the endpoint and holds the
  model. Its bridge side is a JSON-lines stream on its standard input and output.
- **The daemon** starts the relay with the unit, and carries the bridge messages between the relay
  and the native link. The new contract C10 defines the bridge messages. They travel over the stage-1
  link as a second channel: C4 today sends one request at a time, an import can take 120 s, and a
  part with a new ID drops an unfinished one. So C4 changes (section 13): a bridge message never
  waits behind an import, and each part names its channel, so a bridge part never drops an import
  part. A message from the host to the extension is at most about 1 MiB (measured in stage 1), so the
  daemon cuts a large one into parts.
- An import closes the tabs of the sent site's origin (contract C6). A client that held such a tab
  sees it close (`Target.detachedFromTarget`), as when a person closes a tab.

The probe joins the relay and the extension with a loopback WebSocket in place of the native link.
That changes the transport only, not what the extension and the model do.

### 4.3 What the browser model answers itself

`chrome.debugger` refuses the browser-level domains to an extension. Measured (the matrix,
`results/matrix.json`): `Browser.*` answers "'Browser.getVersion' wasn't found";
`Target.getTargets`, `setDiscoverTargets`, `attachToTarget`, `attachToBrowserTarget`,
`createBrowserContext`, `getBrowserContexts` and `activateTarget` answer "Not allowed";
`Page.setDownloadBehavior` answers "Cannot not access browser-level commands". So the model answers
these itself:

| CDP call | The model's answer |
| --- | --- |
| `Browser.getVersion` | The agent Chrome's real product and user agent (from the extension) |
| `Target.setAutoAttach` (root) | Attaches the client to each free tab of its scope, then to each tab that it opens and their popups; emits `Target.attachedToTarget` with `waitingForDebugger: false` |
| `Target.getTargets`, `setDiscoverTargets`, `getTargetInfo` | The tabs of the client's scope, from `chrome.debugger.getTargets` and `chrome.tabs`; a held tab shows `attached: true` |
| `Target.createTarget` | `chrome.tabs.create` (or `chrome.windows.create` for `newWindow`); the tab joins the scope and belongs to its creator; the attach event goes out before the answer, as Playwright needs |
| `Target.closeTarget`, `activateTarget` | `chrome.tabs.remove`, `chrome.tabs.update` |
| `Target.attachToTarget`, `detachFromTarget`, `attachToBrowserTarget` | Sessions of the model (section 4.4) |
| `Target.getBrowserContexts`, `createBrowserContext` | No contexts; a new context is refused with a clear error (ab-jzg Q1: the operator chose "Refuse it with a clear error") |
| `Browser.setDownloadBehavior`, `cancelDownload` and the download events | Section 4.5 |
| `Browser.grantPermissions`, `resetPermissions` | `chrome.contentSettings` for geolocation, notifications, camera, microphone and the clipboard, for allowlisted origins only; a grant with no origin covers the allowlisted domains; other permissions are refused. The model records each connection's grants and rebuilds a type from the remaining ones when a connection resets or leaves. Content settings act on the whole profile, so one connection's grant also applies to another connection's pages (the rebuild ran with one connection only) |
| `Browser.getWindowForTarget`, `getWindowBounds`, `setWindowBounds` | `chrome.windows` (also when they arrive on a page session) |
| `Storage.*` and the Network cookie calls | Refused: no cookie calls by default (the operator's answer to ab-8mf; section 8) |
| `Browser.close` | Ends that client's connection only; the agent browser keeps running (measured with a raw client). Playwright's own `browser.close()` sends no `Browser.close`: it closes its connection |
| Any other root call | "Not available in the agent browser: <method>" |

Every other call on a page session goes to `chrome.debugger.sendCommand({tabId, sessionId?})`.
Frames and workers of a tab are flat child sessions of its attachment (measured with a cross-site
frame and a dedicated worker). Two changes on the way:

- A mouse press with no `force` gets `force: 0.5`, because a CDP press reports pointer pressure 0
  where a real mouse reports 0.5 (the Chrome comparison, section 3; measured here: the page sees
  0.5).
- The model refuses the calls that put a name on the page's own `window` (ab-jzg Q3: the operator
  chose "Refuse them"): `Page.addScriptToEvaluateOnNewDocument` unless its `worldName` names an
  isolated world (with no `worldName` the script runs in the page's main world), and
  `Runtime.addBinding` unless its `executionContextName` names an isolated world (with no name the
  binding goes on the page's main world too). The answer is a clear error that names the call, in
  the form of section 6 (contract C11 fixes the text). So `addInitScript`, `exposeFunction`,
  `exposeBinding` and tracing snapshots fail at once, and no `__playwright__*` name reaches a
  page. The rule must let Playwright's own setup pass: for each
  frame, Playwright sends `Page.addScriptToEvaluateOnNewDocument` with an empty source and the
  `worldName` of its utility world, which a page cannot see. A refusal of every
  `Page.addScriptToEvaluateOnNewDocument` would break every Playwright connection (read in
  playwright-core 1.64.1, not run). The same rule also refuses other Playwright features that put
  a script in the main world, for example `page.clock` (read, not run). One more effect to test in
  stage 3: after a refused `exposeFunction` or `exposeBinding`, Playwright still marks its binding
  as needed and sends `Runtime.addBinding` again for each new page of the context, so a new page of
  that connection can then fail too (read, not run).

### 4.4 Several clients at the same time

All sessions of one tab share its one `chrome.debugger` attachment, so domain state (Fetch, dialogs,
the file chooser, emulation) is shared too. So **a tab belongs to one connection at a time**:

- A connection owns the tabs it opens and their popups. A free tab of its scope (one that nobody
  holds) goes to the first connection that attaches.
- Another connection of the same scope sees a held tab in `Target.getTargets` (`attached: true`) but
  cannot attach: "The tab is in use by another connection of this scope".
- One connection may hold several sessions on its tab (auto-attach, `Target.attachToTarget`,
  Playwright's `newCDPSession`).
- When the owner leaves, the model detaches the tab, so no domain state stays behind, and the tab is
  free for the next connection.
- The popup's owner comes from Chrome's own `openerId` (from `Target.getTargetInfo` of the new tab):
  `chrome.tabs`' `openerTabId` named the active tab instead of the tab that called `window.open`
  (measured). To read it, the model attaches `chrome.debugger` to each new tab that no
  `Target.createTarget` call claimed, and detaches again when no connection takes the tab. In the
  build the extension does this itself in `tabs.onCreated`, and skips the tabs that are not agent
  tabs: the operator's live-view tabs and the import's restore tab. One module of the extension owns
  every `chrome.debugger.attach`, so the import's own attach (contract C6 step 2) never collides with
  it.

Measured (`results/concurrency.json`, 14 of 14): two Playwright connections of one scope work at
the same time (interleaved evaluates); the second gets no page for the first's tab and cannot attach
to it; a popup and a dialog go to the tab's owner only; a connection's `page.route` is on (the
control) and, after that connection leaves, the next connection takes its tab and the interception
is gone; a second scope neither sees nor attaches the first scope's tab; a raw client's
`Browser.close` ends only its own connection.

### 4.5 Downloads

`Browser.setDownloadBehavior` is refused to an extension, so Chrome saves a download in its own
download folder. The model takes Chrome's `Page.downloadWillBegin` and `Page.downloadProgress` events
of the tab session, sends Playwright the `Browser.downloadWillBegin` and `Browser.downloadProgress`
events it expects, and copies the finished file (found with `chrome.downloads.search`) to Playwright's
download folder under the download's guid. `Browser.cancelDownload` becomes
`chrome.downloads.cancel` (probe code, not run by a client). Measured: `page.waitForEvent("download")`
and `download.path()` return the file and its content.

Chrome's own download prompts stay possible on this path. A site's second automatic download asks
"download multiple files" unless `chrome.contentSettings.automaticDownloads` allows it; the model
sets that for the allowlisted domains (not measured). A file that Chrome marks as dangerous waits for
a person's confirmation; agent mode does not confirm it. Not measured: the model must then report
the download as canceled, so that `download.path()` does not wait (stage 3). The daemon sets the profile's download folder to a folder in the state folder, so
downloads stay out of the user's own Downloads folder (Linux: the unit's HOME and the profile
preference; the Mac: the profile preference, not measured on branded Chrome).

### 4.6 Speed

Measured on taylor: a `page.evaluate` round trip takes 3 ms (20 in a row), a Playwright click with
its checks 50 to 170 ms, a load of the test page about 100 ms. The native link adds one more local
hop than the probe's WebSocket; stage 3's live test measures it.

## 5. The feature table

Path: **1** = through the extension (`chrome.debugger` and `chrome.*`, no approval). **2** = only
through Chrome's own CDP connection, which needs the "Allow remote debugging?" approval. **3** = not
possible. **refused** = possible through the extension, but the model refuses it by the operator's
choice. Prompts: what the operator or Chrome must answer for that feature. A path-2 feature would
bring "Allow remote debugging?" at each new connection; agent mode does not offer path 2 (section 6;
the operator chose "Never", ab-jzg Q2), so those rows say "not offered". Evidence: **P** a
Playwright case and **MCP** an MCP call
(`results/pw-*.json`, `results/mcp.json`), **K** a concurrency case (`results/concurrency.json`),
**M** a matrix row (`results/matrix.json`), **S** the site's own report or the server's request log
(`results/site-log.compact.jsonl`), **D** documentation or source reading only, **C** the probe
relay's code, not run by a client.

| # | Feature (Playwright, MCP) | CDP behind it | Path | How in agent mode | Prompts | What a site can detect | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Connect: `connectOverCDP`, MCP `PLAYWRIGHT_MCP_CDP_ENDPOINT` | `Browser.getVersion`, root `Target.setAutoAttach`, `Target.getTargetInfo` | 1 | The model answers | None | Nothing | P, MCP, M (refused to the extension) |
| 2 | The default context and its pages: `browser.contexts()[0]`, `context.pages()` | Target events | 1 | The scope's free tabs | None | Nothing | P, K |
| 3 | New tab: `context.newPage()`, MCP `browser_tabs new` | `Target.createTarget` | 1 | `chrome.tabs.create` | None | Nothing | P, MCP |
| 4 | Navigation: `goto`, `reload`, back and forward, MCP `browser_navigate` | `Page.navigate` and history | 1 | Sent to `chrome.debugger` | None | `Sec-Fetch-Site: cross-site` on a `Page.navigate` (Chrome names the extension as the initiator); **fixed** by an agent-mode DNR rule that sets `none` for navigations the extension starts: then `none` + `?1`, as a typed URL; a page's own navigations keep their value | P, MCP, M, S |
| 5 | Input: click, fill, type, press, hover, selectOption, drag; MCP click and type | `Input.*`, `DOM.*`, `Runtime.callFunctionOn` | 1 | Sent; a mouse press gets `force: 0.5` | None | Events are trusted (`isTrusted` true). Pointer pressure 0 on a CDP press, **fixed** (the page sees 0.5). `fill` (Playwright's `fill`, the MCP's default `browser_type`) gives `input` events and no key events, which a person never does; `keyboard.type`, `pressSequentially` and the MCP's `slowly: true` give key events (measured: 0 keydowns after `browser_type`, 4 after `slowly`) | P, MCP, S |
| 6 | Evaluate and locators: `evaluate`, `waitForFunction`, `locator.*` | `Runtime.*`, `Page.createIsolatedWorld` | 1 | Sent | None | `navigator.webdriver` false. Playwright enables the Runtime domain on each page; ab-v16.2 measured a timing mark of `Runtime.enable` (section 7). Playwright's helpers run in an isolated world | P, S |
| 7 | Page reads: `ariaSnapshot`, MCP `browser_snapshot`, `textContent` | `Runtime` in the utility world | 1 | Sent | None | Nothing | P, MCP |
| 8 | Screenshot: `page.screenshot`, MCP `browser_take_screenshot` | `Page.captureScreenshot` | 1 | Sent | None | Nothing | P, MCP |
| 9 | Viewport: `setViewportSize` | `Emulation.setDeviceMetricsOverride` | 1 | Sent | None | The new size and one `resize` event, as with any Playwright | P, S |
| 10 | Window bounds (a context with a viewport, `page.windowBounds`) | `Browser.getWindowForTarget`, `set/getWindowBounds` | 1 | `chrome.windows` | None | Window size, by intent | M (refused to the extension), C |
| 11 | Popups: `page.on("popup")` for `window.open` and `target=_blank` | browser auto-attach with `openerId` | 1 | The model attaches on `chrome.tabs.onCreated`, reads Chrome's `openerId`, and gives the popup to the opener's owner | None | Nothing. **Limit:** the attach comes just after the tab exists; a popup case hung in 2 of 21 runs (section 10) | P, K |
| 12 | Close: `page.close` | `Target.closeTarget` | 1 | `chrome.tabs.remove` | None | Nothing | P |
| 13 | MCP `browser_close` | no `Target.closeTarget` | 1 | The MCP closes no tab; its tabs stay open (measured). The daemon closes a session's scope tabs when the session ends (stage 4) | None | Nothing | MCP, C |
| 14 | Cross-site frames: `frameLocator`, frame clicks | page `Target.setAutoAttach`, flat child sessions | 1 | Sent | None | Nothing | P, M |
| 15 | Workers: `page.on("worker")`, `worker.evaluate` | flat child sessions | 1 | Sent | None | Nothing | P |
| 16 | Dialogs: `page.on("dialog")`, MCP `browser_handle_dialog` | `Page.handleJavaScriptDialog` | 1 | Sent; a dialog goes to the tab's owner only | None | Nothing | P, K |
| 17 | Request interception: `page.route`, `fulfill`, `continue`, `abort` | `Fetch.*` | 1 | Sent; cleared when the owner leaves | None | Nothing. DNR acts before Fetch: a `route.fulfill` of an off-list document is still blocked | P, K |
| 18 | Network events and bodies: `page.on("request"/"response")`, `response.body()`, MCP `browser_network_requests` | `Network.*` | 1 | Sent | None | Nothing | P, M |
| 19 | File upload by path: `setInputFiles(path)`, MCP `browser_file_upload` | `DOM.setFileInputFiles` | 1 | Sent (it works from an unpacked extension) | None | Nothing | P, M |
| 20 | File upload by buffer | Playwright's page script | 1 | Sent | None | Nothing | P |
| 21 | Downloads: `waitForEvent("download")`, `download.path()`, `cancel()` | `Browser.setDownloadBehavior`, `Browser.download*`, `cancelDownload` | 1 | Section 4.5 | None for one download (measured); a second automatic download would ask, unless the model's content setting allows it (not measured); a dangerous file waits for a person | Nothing | P, M (refused to the extension), C |
| 22 | Cookies: `context.cookies`, `addCookies`, `clearCookies`; also `context.request` and `page.request`, which read and write the context's cookies | `Storage.*`, `Network` cookie calls | refused | Refused with a clear error: no cookie calls by default (the operator's answer to ab-8mf; section 8). Before the answer the probe's relay served them through `chrome.cookies`, for allowlisted domains only | None | Nothing | P, M (served, before the answer); the refusal and `context.request`: D |
| 23 | Storage state: `context.storageState()` | rows 6 and 22, and one page per frame origin | refused | Its first call reads the cookies (row 22), so it fails. Before the answer: Playwright opens a page for each origin that a frame of the context showed; DNR blocks an off-list frame origin, so the call failed after such a page, and in a context that showed no off-list frame it worked (measured) | None | Nothing | P, K (before the answer); the refusal: D |
| 24 | Permissions: `grantPermissions`, `clearPermissions` | `Browser.grantPermissions` | 1 for geolocation, notifications, camera, microphone and the clipboard; 2 for MIDI, sensors, background sync, payment handler, storage access, local fonts, wake lock and local network access | `chrome.contentSettings` (profile-wide; section 4.3) | None | The permission state, by intent | P for geolocation ("granted", then "prompt"), the clipboard with no origin ("granted") and MIDI (refused); C for notifications, camera and microphone; M |
| 25 | Init scripts and bindings: `addInitScript`, `exposeFunction`, `exposeBinding` | `Page.addScriptToEvaluateOnNewDocument` and `Runtime.addBinding` in the main world | refused | Refused with a clear error (ab-jzg Q3: the operator chose "Refuse them"; section 4.3). Playwright's own utility-world script passes | None | Nothing, because the call is refused. Measured before the answer, when the probe sent the calls: Playwright put `__playwright__binding__` and `__playwright__binding__controller__` on the page's `window` (and the script's own globals). Playwright's own mark, on any transport | P, S (sent, before the answer); the refusal: D |
| 26 | Emulation: geolocation, timezone, locale, media, offline, extra headers | `Emulation.*`, `Network.emulateNetworkConditions`, `Network.setExtraHTTPHeaders` | 1 | Sent | None | The emulated values, by intent | M |
| 27 | Tracing: `context.tracing` with screenshots and snapshots | `Page.startScreencast`, `Runtime`; snapshots add a main-world init script | 1 for screenshots with no snapshots; refused with snapshots | Screenshots: sent. Snapshots: refused, because their init script is (row 25; ab-jzg Q3) | None | Nothing with the refusal. Measured before the answer, with snapshots: a `__playwright_snapshot_streamer_<id>` global | P, S (with snapshots, before the answer); screenshots only and the refusal: D |
| 28 | PDF: `page.pdf` | `Page.printToPDF` | 1 | Sent | None | Nothing | P, M |
| 29 | Raw CDP: `context.newCDPSession`, `browser.newBrowserCDPSession` | `Target.attachToBrowserTarget` | 1 for page domains and the model's browser set; 2 for other browser domains | A model session | None | Nothing | P, K |
| 30 | Target discovery as Puppeteer and agent-browser use it | `Target.getTargets`, `setDiscoverTargets`, `attachToTarget` | 1 | The model | None | Nothing | K, M (refused to the extension), C for `setDiscoverTargets` |
| 31 | `browser.close()` | none from Playwright; `Browser.close` from a raw client | 1 | Playwright closes its connection; a raw `Browser.close` ends only its own connection | None | Nothing | P, K |
| 32 | An isolated context: `browser.newContext()`, MCP `--isolated` or a tab's `isolatedContext` | `Target.createBrowserContext` | 2 | Refused with a clear error (ab-jzg Q1: the operator chose this) | Not offered | — | P (refused), M |
| 33 | Video: `recordVideo` | needs a new context | 2 | Refused (the screencast of row 27 works) | Not offered | — | D, M |
| 34 | Service workers: `context.serviceWorkers()`, `on("serviceworker")` | browser-level worker targets | 2 | The model reports none | Not offered | — | P (none), D |
| 35 | `ignoreHTTPSErrors` | `Security.setIgnoreCertificateErrors` | 2 | Refused ("wasn't found") | Not offered | — | M |
| 36 | JS coverage, `page.requestGC()` | `Profiler.*`, `HeapProfiler.*` | 2 | Refused ("wasn't found") | Not offered | — | M |
| 37 | Browser-wide tracing: `browser.startTracing()` with no page | `Tracing` on the browser target | 2; with a page, 1 | `Tracing.start` on the tab session works | Not offered | Nothing | M |
| 38 | `chrome://` pages and other extensions' pages | | 2 | Refused: "Cannot access a chrome:// URL" | Not offered | — | M |
| 39 | `SystemInfo.*` (GPU data), `Extensions.*` | | 2; `Extensions.*` 3 for agentwatch | Refused ("wasn't found") | Not offered | — | M |
| 40 | Any off-list top-level page: `goto`, link click, `window.open`, `route.fulfill`, `file://` | DNR | guard | Blocked in Chrome: `net::ERR_BLOCKED_BY_CLIENT`; the tab shows Chrome's blocked page and stays usable | None | The off-list site sees nothing (no request in any run) | P, MCP, M, S |
| 41 | An off-list frame in a tab whose top page is not on the list (`setContent`, `about:blank`) | DNR | guard | Blocked by a DNR rule (`sub_frame`, `excludedTopDomains` = the list); frames of an allowlisted page still load from any host (O11) | None | Nothing | P, with a control run without the rule (the frame loads) |
| 42 | `Page.navigate` to a `data:` URL | | — | The tab stays on `about:blank` (measured with and without the frame rule; the cause was not checked) | None | — | P |

**The probe's cases after the operator's answers.** The probe ran before the operator's answers,
and its relay served every call. The refusal of the page marks (rows 25 and 27, ab-jzg Q3) and of
the cookie calls (rows 22 and 23, ab-8mf) changes these cases. The probe's results stay as they
were measured.

Five of the 49 Playwright cases (`pw-probe.mjs`, `results/pw-tcp.json` and `results/pw-unix.json`)
worked and now fail with the model's refusal, over both transports:

- `context.addInitScript, then a new page` (`addInitScript`).
- `init script in a popup (late attach)`. It calls nothing itself, but it reads the global of the
  init script of the case before it. Its measure, whether the model attaches a popup before its
  first script, needs another form in stage 3's live test, one that puts no name on the page.
- `page.exposeFunction` (`exposeFunction`).
- `context.tracing start/stop` (it records snapshots: `snapshots: true`).
- `context.cookies + addCookies (allowlisted)` (cookie calls).

Two more Playwright cases expected a refusal and still get one, but for another reason:
`context.addCookies (off-list domain)` (now the cookie refusal, not "not on the allowlist") and
`context.storageState() after a page with an off-list frame` (now the cookie refusal at its first
call, not the blocked frame). One of the 14 concurrency cases (`results/concurrency.json`) worked
and now fails: `context.storageState() in a context that showed no off-list frame`.

The other 42 Playwright cases, the other 13 concurrency cases and the 15 MCP cases
(`results/mcp.json`) use none of these features. In the MCP run the site saw no new global.

## 6. How the two paths work together

- **When the approval path is needed at all.** Only for rows 32 to 39: an isolated context, video
  of a new context, service-worker targets, `ignoreHTTPSErrors`, JS coverage, browser-wide tracing,
  `chrome://` pages and a few browser domains, and the permissions of row 24 that
  `chrome.contentSettings` does not cover. The Playwright MCP in its default mode needs none of them
  (measured). agent-browser's own commands need none of them (it uses `Browser.setDownloadBehavior`,
  `Browser.getWindowForTarget` and the Target calls, which the model serves).
- **Whether both can run at once.** Chrome allows several CDP clients on one target, so an approved
  connection could run next to the extension (documentation; not measured here). But the approval
  path costs what the extension path removes: Chrome then listens on a loopback TCP port (9222,
  measured on 2026-11-01) that every local user can reach; each new connection raises "Allow remote
  debugging?"; on Linux xdotool answers it blind and needs a version gate; on the Mac a person must
  click after each sleep (#9) and find the right window (#3). The operator chose that agentwatch
  never opens it (ab-jzg Q2: "Never"). vedlo and marketdata-update keep agent-browser's CDP proxy
  (the approval path) until they choose to move.
- **What an agent sees.** One endpoint. Rows 1 to 31 work, except the refused calls of rows 22
  and 23 (the cookie calls, ab-8mf) and of rows 25 and 27 (the page marks, ab-jzg Q3). A path-2
  feature or a refused call fails at once with a clear message, for example "Not available in the
  agent browser: a new browser context (Target.createBrowserContext). Use the default context:
  browser.contexts()[0]." No prompt, no window and no banner appears, and the agent never waits for
  a person.

## 7. What a site can see (the operator's top goal)

Measured with the probe's site script, which reports what a page can read, and the server log. The
first page is the baseline: a tab with no debugger and no client.

- **The same as the baseline** under Playwright and the MCP: `navigator.webdriver` false,
  `innerHeight` 812 (no banner, with `--silent-debugger-extension-api`), `document.hasFocus()` true,
  `visibilityState` visible, every input event trusted, the same user agent, and no new page global
  for plain use (navigate, click, type, read, screenshot, the MCP's default tools).
- No `resize` at attach and detach with the silent flag: measured in the stage-1 probe (agentwatch
  design §5.16) and in the Chrome comparison (section 3, in Chrome stable, Beta and Chromium); this
  probe's pages loaded after the attach, so it did not measure that event.
- The old CDP console mark (a getter on `Error.stack` logged with `console.debug`) stayed at 0 also
  under Playwright's `Runtime.enable`. That check has no positive control on Chromium 156, so it
  shows nothing either way. The Chrome comparison (section 3) measured a mark that does work: while
  the Runtime domain is on, `console.debug` of a 2 MB string takes 41.6 to 49.5 ms against 19.6 to
  31.9 ms before. Its advice is never to enable the Runtime domain. agent-browser's own commands
  never enable it, and they keep that rule through the endpoint. But Playwright enables the Runtime
  domain on every page and cannot work without it, so a site that times this can see a Playwright
  client. That is the cost of Playwright compatibility; the design does not hide it.
- The comparison also measured that agent-browser's three background flags
  (`--disable-background-timer-throttling` with `--disable-renderer-backgrounding` and
  `--disable-backgrounding-occluded-windows`) let a hidden tab run 50 ms timers (plain Chrome: about
  1000 ms). The operator's answer to ab-vsm Q4 (2026-11-04): "As long as the agentbrowser can swap
  tabs i'm OK with dropping timers." So agent-browser drops the two timer flags,
  `--disable-background-timer-throttling` and `--disable-renderer-backgrounding`, and keeps
  `--disable-backgrounding-occluded-windows` (board task ab-v16.13). The operator's condition is
  part of that task: a test shows that agent-browser still switches tabs and still drives a tab
  that is not in front. The last flag is not a timer flag for a hidden tab: it keeps an agent
  window behind other windows visible. Keeping it is the lead's reading of the answer; the operator
  can reverse it.
- Agent mode follows the same rule. The agent-mode unit on taylor passes none of the three flags
  (stage 1's flags), and agent mode passes no timer flag. The Mac stage starts the agent Chrome
  with `--disable-backgrounding-occluded-windows`, for the reason below. The operator's condition
  holds for agent mode too: stage 3's live test checks that a client switches tabs and drives a tab
  that is not in front.
- Focus and visibility on the Mac (measured: the comparison's Mac check 9). For an agent window
  behind the operator's windows, `document.hasFocus()` is false while idle and true after CDP
  input. With `--disable-backgrounding-occluded-windows` the page stays `visible` at full rate.
  Without it the page is hidden (`visibilityState` hidden, no animation frames, slow timers) while
  CDP clicks and typing still work, so a site can see input on a hidden page.
- agent-browser's `outline` writes a `data-agent-browser-idx` attribute into the page's DOM, which a
  page script can see (the comparison, section 3). A Playwright client writes no such attribute.
- **Fixed in the model:** the navigation header (row 4: a DNR `modifyHeaders` rule with
  `initiatorDomains` = the agent package's own ID sets `Sec-Fetch-Site: none` for the navigations
  the extension starts and for no other navigation; measured: `Page.navigate` then sends `none` +
  `?1`, a page script's navigation keeps `same-origin`) and the pointer pressure (row 5).
- **Different from a person, by the client's choice:** `fill` without key events (row 5).
- **Refused by the operator's choice:** Playwright's `__playwright__*` globals for init scripts,
  bindings and tracing snapshots (rows 25 and 27) never reach a page. The operator chose "Refuse
  them" (ab-jzg Q3), not the design's recommendation. So a program that uses these features gets a
  clear error (section 4.3).
- The identity of the browser after a send is the comparison's subject (section 9 here). A send
  carries no machine: on taylor a site sees Linux, no WebGL, Linux fonts, 32 CPUs and taylor's IP
  address, whatever the channel. The operator's answer to ab-vsm Q1 (2026-11-04): "I prefer most
  browser actions to happen on taylor. i'll use my mac only in very limited cases... i.e. when we're
  just starting to use a website. or if i need to click a cloudflare box, or things like that. for
  difficult sites." So on taylor, the default agent browser, a site that compares the machine can
  tell the agent browser from the operator's Chrome. The Mac runs the agent browser for a new site,
  a Cloudflare box and other difficult sites.

## 8. The allowlist and the tab scope with a raw CDP client (task item 3)

**What Chrome enforces, whatever the client sends.** The agent package's DNR rules act in Chrome's
network stack before any CDP interception:

- Top-level pages (stage 1: block every `main_frame`, allow the list). Measured: `page.goto`,
  `Page.navigate`, a link click, `window.open`, `Target.createTarget` with a URL, a `page.route` that
  fulfills an off-list document, and `file://` all end in `net::ERR_BLOCKED_BY_CLIENT`; the off-list
  host received no request in any run. After a blocked `goto`, Chrome commits its error page a moment
  later; the same page then goes on to an allowlisted URL (measured; the skill tells agents to wait
  for the error page before the next `goto`).
- **New: frames under an off-list top page.** A raw client can make a top-level document with no
  network request (`about:blank`, `page.setContent`) and put any host in a frame there. A new rule
  blocks every `sub_frame` request of a tab whose top-level domain is not on the list
  (`excludedTopDomains` = the list). Measured: a `setContent` page with an off-list frame does not
  load the frame; the control run without the rule loads it; frames of an allowlisted page still load
  from any host (O11, O13). A `Page.navigate` to a `data:` URL left the tab on `about:blank`.

**What the browser model adds.**

- Cookies: `Storage.getCookies` on a tab session returns the cookies of other sites too (measured: a
  `c.localhost` cookie, from a page of `a.localhost`). So the model answers every cookie call itself:
  `Storage.*` on any session, `Network.getAllCookies`, `Network.getCookies`,
  `Network.setCookie(s)`, `deleteCookies` and `Network.clearBrowserCookies`. **The operator chose
  "No cookies by default"** (ab-jzg Q4 and the follow-up item ab-8mf, section 14). So the model
  refuses every one of these calls with a clear error. Programs that read or set cookies through
  the endpoint fail (rows 22 and 23). The browser still sends its cookies to the sites, so the sent
  sign-ins work. The operator's words: "Make a note in the code to add a cookie grant in the future
  if we run into a use-case that needs cookie access." So stage 3 puts that note at the refusal in
  the relay's code. Such a grant can reuse the probe's filter, measured for `context.addCookies`:
  allowlisted domains only, an off-list domain refused, `clearBrowserCookies` for allowlisted
  cookies only.
- Not covered by the answer: the network events and the `Fetch` interception that the model passes
  on also carry `Cookie` and `Set-Cookie` header values, also of httpOnly cookies (for example
  `Network.requestWillBeSentExtraInfo`). Whether the model blanks them is a question for stage 3.
- Permissions: only for allowlisted origins (row 24).
- `Extensions.*` and `Target.exposeDevToolsProtocol` are refused on every session.
- The model never attaches a client to a tab outside its scope, to a tab that another connection
  holds, to a tab that the operator opened in the live view, or to a `chrome://` page (Chrome refuses
  the last one too, measured).

**The tab scope (agent-browser #14).** Each connection names its scope in the endpoint path
(`/devtools/browser/<scope>`). A client sees and attaches only the tabs of its scope; the tabs it
opens and their popups join the scope; another scope's tab answers "No target with given id found"
(measured, section 4.4). As in #14, the scope is advisory: every agent runs as the same OS user.

**What stays open, stated plainly (as agentwatch design §5.4).** An allowlisted page loads frames
and subresources from any host, and a CDP client can read them (frame sessions,
`Network.getResponseBody`). Any process of the box's user can open the endpoint's 0600 socket: the
same limit as today's proxy socket. The allowlist keeps an honest agent and an injected page inside
the operator's choice; it is not a wall against a hostile process of the same user.

## 9. Which Chrome is the agent Chrome

The Chrome comparison (ab-v16.2, `docs/research/2026-11-03-chrome-vs-chrome-beta.md`, merged in
b320d09; measured on taylor with Google Chrome stable 156.0.8078.79, Chrome Beta 158.0.8127.2 and
Chromium 156) decides: **Google Chrome stable at the operator's version, on the same kind of machine
as the operator's Chrome. Not Chrome Beta.**

- Beta is a different browser to a site: another major version in the User-Agent, the client hints
  and `navigator.userAgentData`, another GREASE brand, and web features that stable lacks or has
  (its section 2.1). Stable at the same version sends the operator's own identity, also the JA4 TLS
  and HTTP/2 fingerprints. Measured on the operator's Mac (its Mac check 5): the operator's Chrome
  and a new profile of the same app sent the same User-Agent, client hints, JA4 and HTTP/2
  fingerprints. The patch version differed, because the operator's running Chrome waited for
  "Relaunch to update".
- The extension works the same in both channels: both ignore `--load-extension`; on Linux both
  install the agent package from Chrome's external extensions file with no developer mode and no
  prompt; on the Mac both install a local CRX from that file and disable it at once (reason 256,
  not from the Chrome Web Store); both keep an extension that "Load unpacked" installed with
  developer mode on, also across a relaunch on the Mac; and both drive a tab through
  `chrome.debugger` with `--silent-debugger-extension-api` with no banner and
  `navigator.webdriver` false (its sections 3, 5 and 8).
- "Same OS" must mean the same kind of machine: a send carries cookies and page storage, not the
  machine. Only an agent browser on the operator's Mac, or on a Mac like it, can match the
  operator's Chrome. The operator's answer to ab-vsm Q1: taylor runs most browser work, and the Mac
  runs the agent browser only for a new site, a Cloudflare box and other difficult sites (section
  7). So taylor is the default agent browser, and this design builds taylor first (Linux) and the
  Mac second, as the agentwatch design does.
- The operator answered the comparison's four questions (ab-vsm) on 2026-11-04:
  - Q1, where the agent browser runs: taylor by default, the Mac for difficult sites (above).
  - Q2, how the agent package gets in: "I'm not sure yet." The follow-up item ab-32m asked about
    taylor only, and the operator chose "Yes, the external extensions file" (section 10). The Mac's
    install waits for the Mac stage.
  - Q3, a second instance of `Google Chrome.app` on the Mac: "I'm not sure yet. Do we get two icons
    and two tabs? Or one icon and 1 tab? I.e. the same window as my windows?" The Mac run answers
    the question: two Dock icons, two Cmd-Tab entries, and the agent's windows stay separate from
    the operator's windows. In ab-32m the operator asked: "is it the same binary with a totally
    separate chrome profile or two binaries?" The follow-up item ab-9hj gave the two choices, and
    the operator chose "The same binary: my Google Chrome, with its own profile" (section 10).
  - Q4, the three background flags: "As long as the agentbrowser can swap tabs i'm OK with dropping
    timers." agent-browser drops the two timer flags and keeps the occluded-windows flag (section 7,
    board task ab-v16.13).

Nothing in the browser model depends on the channel: it reads the product and the user agent from
the running browser.

## 10. Linux and macOS (task item 4)

**Linux (taylor first).** The stage-1 unit stays: the daemon starts a private Xvfb (`-nolisten tcp`,
an auth file) and the agent Chrome with `--silent-debugger-extension-api`, no remote-debugging flag
and no port. taylor is the default agent browser (the operator's answer to ab-vsm Q1, section 9).
The agent Chrome becomes Google Chrome stable (section 9), and the agent package gets in through
Chrome's external extensions file. The operator chose this in the follow-up item ab-32m (2026-11-04:
"Yes, the external extensions file"): agentwatch keeps its own Google Chrome copy, only that copy
reads the file, and the system's Chrome on taylor stays as it is. No prompt, no click and no root
step. The details (the comparison's sections 5 and 9):

- agentwatch keeps a Google Chrome stable build in its own tools folder (unpacked from Google's
  `.deb`, no system install) and writes `<id>.json` (`external_crx`, `external_version`) into the
  `extensions` folder next to its binary. That needs no root and installs the agent package with no
  developer mode and no prompt (measured by the comparison). The file applies to every profile of
  that Chrome build; only the agent profile uses this build.
- agentwatch never writes the system folders (`/opt/google/chrome/extensions`,
  `/usr/share/google-chrome/extensions/`): on a box with a system Chrome they would install the agent
  package into a person's own profile there too.
- A Chrome that agentwatch unpacks gets no automatic update. agentwatch fetches each new stable
  `.deb` and restarts the agent Chrome on it (stage 4).
- The CRX: Chrome packs it itself (`--pack-extension`), and its ID comes from its signing key.
  Stage 1 never wrote the agent package's private key, so the CRX gets a new key and a new agent-mode
  ID. agentwatch keeps the new key (0600) to keep that ID, and the pins and the native host's
  `allowed_origins` move to it.
- Chromium keeps the stage-1 `--load-extension` start, for a box where the operator chooses Chromium.

The relay starts with the unit and stops with it. The fail-closed rule of stage 1 extends to the
endpoint: while the extension has not confirmed the operator's list, the endpoint refuses
connections. No prompt exists at any step. agentwatch design §5.13 item 1 (the xdotool version gate)
is not needed on this path.

**macOS.** The Mac runs the agent browser only for a new site, a Cloudflare box and other
difficult sites (the operator's answer to ab-vsm Q1, section 9). The agent Chrome is the operator's
own `Google Chrome.app`, the same binary, started a second time with its own profile
(`--user-data-dir`). The operator chose this in the follow-up item ab-9hj (2026-11-04: "The same
binary: my Google Chrome, with its own profile"). A site then sees the operator's browser and
version. The agent's profile is separate from the operator's profile, sign-ins and windows.
What the Mac showed (the comparison's Mac checks 6 and 9, 2026-11-03, and board task ab-b84.11,
2026-11-04):

- **Two Dock icons and two Cmd-Tab entries.** The second instance shows its own Dock icon and its
  own Cmd-Tab entry, and Cmd-Tab goes between the two. The agent's windows stay separate from the
  operator's windows. `open -a "Google Chrome"`: not measured.
- **The version.** A new agent instance starts at the version on disk. While the operator's
  running Chrome waits for "Relaunch to update", the agent instance is ahead of it. So agentwatch
  must restart the agent Chrome when the operator's Chrome changes version (the comparison's
  section 7).
- **The focus.** agent-browser starts the agent Chrome with `open -n -g`, but that does not keep the
  operator's focus: on 2026-11-04 the new agent Chrome became the frontmost app at its first window
  in 12 of 12 starts (board task ab-b84.11, which works on a fix). The Mac stage needs a start that
  keeps the operator's focus.
- **Behind the operator's windows** the agent page stays `visible` only with
  `--disable-backgrounding-occluded-windows` (section 7). The Mac stage starts the agent Chrome with
  it.

Branded Chrome refuses `--load-extension`. On the Mac the external extensions file gives no
working extension from a local CRX: with `<user-data-dir>/External Extensions/<id>.json` and a
local `external_crx`, Chrome installed the extension and disabled it at once with reason 256
(`DISABLE_NOT_VERIFIED`: not from the Chrome Web Store), at the first start and after relaunches,
in stable and Beta (the comparison's Mac check 3). Whether Chrome shows a dialog or a notice for it
is not measured. Google's documentation names a Web Store update URL there and one confirmation.

Which folders a file reaches: Chrome reads the per-user folder at
`<user-data-dir>/External Extensions/` (Chromium's `DIR_USER_EXTERNAL_EXTENSIONS`). So a file in
the agent profile's own folder never reaches the operator's Chrome. The folder in Google's
documentation, `~/Library/Application Support/Google/Chrome/External Extensions/`, is the one of
the default user data folder, that is the operator's own Chrome. The all-users folder
(`/Library/Application Support/Google/Chrome/External Extensions/`) does not follow
`--user-data-dir`, so it reaches the operator's Chrome too (not measured). agentwatch never writes
these two default folders: a file there would put the agent package, with `debugger`, into the
operator's Chrome.

So on the Mac the agent package gets in one of three ways. The choice waits for the Mac stage
(ab-v16.8); the follow-up item ab-32m asked about taylor only. Until then this design uses "Load
unpacked":

- "Load unpacked" by the operator, once per agent profile, with developer mode on (developer mode
  must stay on). It stays across a relaunch on the Mac (below). Not measured: whether a real
  Chrome update keeps it.
- An unlisted Chrome Web Store item: one "Add to Chrome" click per agent profile, updates from the
  store (not measured).
- An enterprise policy (`ExtensionInstallForcelist`), which on the Mac needs MDM (not measured).

Then:

- **No approval click.** `chrome.debugger.attach` needs no approval (measured on Linux; on the Mac the
  silent flag and the native host location passed the agentwatch design's Mac checks 2 and 3 of
  2026-11-01).
- **#9 (a sleep ends the approval) ends for agentwatch:** there is no approval to lose. Open: the
  agentwatch design's Mac check 4, whether `chrome.debugger` and the native port come back after a sleep with no prompt. If
  Chrome detaches the debugger at a sleep, the model sends each client `Target.detachedFromTarget`,
  attaches again after the wake (no prompt), and clients reconnect. A client loses its open page
  objects, not the tabs.
- **#3 (which window asks) ends for agentwatch:** no window asks.
- **The manual load stays.** On the Mac a "Load unpacked" extension stayed across a relaunch in
  stable and Beta (the comparison's Mac check 2, 2026-11-03), as on Linux. A developer-mode warning
  at start is not measured on the Mac (no screenshots); the operator reported none.
- The notice of agentwatch design §5.8 still names the consumer, the profile and the box, for the
  cases where a person must act (a sign-in, a Chrome that does not start).

**Effect on the waiting tasks.** ab-b84.2 ("The operator can tell which agent Chrome window asks for
the debugging approval") and ab-b84.3 ("One debugging approval lasts through a Mac sleep") concern
the CDP proxy path. In agent mode neither prompt exists. They still apply to vedlo and
marketdata-update while those use the proxy. Their order is the manager's call after the operator
approves this design.

**A measured limit: popups.** The model attaches a popup just after Chrome creates it, not before its
first script as Chrome's own auto-attach (`waitForDebuggerOnStart`) does. Playwright's init script
still ran in the popup in every passing run (in the probe, before the operator refused init scripts;
section 5). But in 2 of 21 runs a popup case hung: the popup's
`waitForLoadState` or `evaluate` got no answer. The cause is not found; the suspected cause is a race
between the popup's load and Playwright's setup of its session. The build (stage 2 and 3) makes the
extension attach a new tab of an attached scope at once in its `tabs.onCreated` handler, holds the
tab's first document request with `Fetch` until the client sends `Runtime.runIfWaitingForDebugger`
(as `waitForDebuggerOnStart` does), gives each bridge call a deadline after which the model detaches
the tab and tells the client, and runs the popup cases many times in its live test.

## 11. How agentwatch exposes the endpoint, and who may connect (task item 5)

- **The endpoint.** A Unix socket, 0600, in agentwatch's runtime folder:
  `/run/user/<uid>/agentwatch/browser-cdp.sock` on Linux, `~/.cache/agentwatch/run/browser-cdp.sock` on
  the Mac (a socket path holds at most 107 bytes; agent-browser checks 103). The CDP URL is
  `ws+unix://<socket>:/devtools/browser/<scope>`. Measured: Playwright's `connectOverCDP` and the
  Playwright MCP accept this form, because Playwright passes any `ws…` URL to its WebSocket library,
  which supports `ws+unix:`. No TCP port: a loopback endpoint with a secret token per session can
  come later, when a client needs it (every local user can reach a port, so its token must stay out
  of argv and logs; the probe's TCP endpoint uses such a token).
- **`agentwatch browser endpoint`** prints the URL for the calling session, with the session's name
  as the scope. It starts the unit first when it is down, as `agentwatch browser start` does.
  **`agentwatch browser env`** prints `PLAYWRIGHT_MCP_CDP_ENDPOINT=<url>` for an MCP configuration.
  The URL holds no secret.
- **Who may connect.** Every agentwatch session of the daemon's OS user, each in its own scope,
  exactly as every such session may run `agentwatch browser` today. The operator turns agent control
  off with `browser.control: false` in the config (the endpoint then does not exist); the allowlist
  stays the operator's, in the web viewer, with a password login (O9, §5.4). When a session ends, the
  daemon closes the tabs of its scope.
- **"No change in the program."** A program that takes a CDP endpoint (the Playwright MCP, browser
  agent frameworks, a script that calls `connectOverCDP`) needs only the endpoint. A script that
  calls `chromium.launch()` itself needs one changed line, `connectOverCDP(endpoint)` and
  `browser.contexts()[0]`. Playwright Test's `connectOptions` speaks Playwright's own server
  protocol, not CDP; a small Playwright server in front of the endpoint is a later option (not
  measured).
- **The skill** (`agentwatch-browser`) tells agents: get the endpoint from `agentwatch browser
  endpoint`; use `browser.contexts()[0]`; never call `browser.newContext()`; wait for the error page
  after a blocked `goto`; type with `keyboard.type`, `pressSequentially` or the MCP's `slowly: true`
  on a site that checks for automation; the endpoint refuses `addInitScript`, `exposeFunction`,
  `exposeBinding` and tracing snapshots (ab-jzg Q3), and a trace with screenshots and no snapshots
  still works (playwright-core 1.64.1, read, not run); the endpoint refuses the cookie calls, so
  `context.cookies()`, `addCookies()`, `clearCookies()`, `storageState()` and `context.request`
  fail (ab-8mf); the allowlist is the operator's.

## 12. Build stages, in order (task item 6)

| Stage | Repo | What | Depends on |
| --- | --- | --- | --- |
| 1. Contracts | chrome-extension (`docs/protocol.md`) | C10: the bridge (the fixed call list, the events, the deadline, parts). The C4 change: a second channel for the bridge, never queued behind an import, parts that name their channel. C11: the endpoint path, the scope, one connection per tab, the refusal texts. The agentwatch side reads the same file | — |
| 2. Two packages | chrome-extension | `sender/` becomes `operator/`, `receiver/` becomes `agent/`; the bridge in `agent/`; the DNR navigation-header rule and the frame rule; the attach of a new tab in `tabs.onCreated` (not of the restore tab or an operator tab; one module owns every attach) and the hold of its first request; manifest tests (the operator package has no control permission); bridge unit tests with the fake chrome; the native host's parent check (with stage 4) | 1 |
| 3. The relay | agent-browser | `src/relay/`: the browser model and the endpoint server (the `ws` dependency it already has); the internal command `agent-browser relay`; one connection per tab; the cookie policy (no cookie calls by default, the operator's answer to ab-8mf, with a note in the code for a later cookie grant), the refusal of the page-mark calls (ab-jzg Q3, section 4.3), the permission and scope policy; the mouse `force`; downloads with cancel and the automatic-downloads setting; unit tests with a fake bridge; a live test (outside `npm test`) that runs the probe's Playwright, MCP and concurrency cases from a scratch install (with the refusals of section 5), popups many times, and the operator's timer condition: a client switches tabs and drives a tab that is not in front; agent-browser's own commands get an endpoint transport (a CDP URL in place of the proxy socket). The CDP proxy stays the default for vedlo and marketdata-update | 1 |
| 4. agentwatch | agentwatch | The unit starts the relay with the agent Chrome and carries the bridge over the native link; Google Chrome stable in the tools folder with the external extensions file, the CRX key and the version updates (section 10; the operator's answers to ab-vsm Q1 and ab-32m); `agentwatch browser endpoint` and `env`; `agentwatch browser <command>` through the endpoint; `browser.control`; closing a session's scope tabs at its end; the download folder; the skill; `docs/internals/agent-browser.md`; the live test on taylor | 2, 3 |
| 5. The Mac | agentwatch, chrome-extension | The agentwatch design's Mac check 4 with the operator (sleep and wake); the comparison's Mac checks are done (2026-11-03, its section 8; checks 2, 3, 4, 6 and 9 touch agent mode), and its check 2 answers the open part of the agentwatch design's Mac check 1 (the manual load stays across a relaunch); the Mac's install (the choice waits for this stage; the manual-load guide until then); the second instance of the operator's own `Google Chrome.app` with its own profile (the operator's answer to ab-9hj); the Mac launch path, with `--disable-backgrounding-occluded-windows` and a start that keeps the operator's focus (ab-b84.11) | 4 |
| 6. Consumers (their choice) | vedlo, marketdata-update | Move from the CDP proxy to the endpoint at a pin bump | 3 |

Stages 2 and 3 can run at the same time after stage 1. Each stage is a branch and a pull request
with its own tests and a fresh review; no tag, npm publish or extension release without taylor's
manager.

## 13. What changes in the agentwatch design

- **§5.13 item 12** ("the extension transport: CDP messages through a consumer-given socket to the
  receiver's `chrome.debugger`; browser-level calls mapped to `chrome.tabs` and `chrome.windows`")
  becomes stage 3 here: the mapping is a browser model in agent-browser that serves any CDP client,
  not only agent-browser's own commands.
- **§5.14 and §5.15** keep their function; the folders and names change (`sender/` to `operator/`,
  `receiver/` to `agent/`), and the receiver gains the bridge, the navigation-header rule and the
  frame rule.
- **Contract C4** (the native link) gains a second channel for the bridge (section 4.2).
- **§5.15 loading and the Chromium of §3:** the agent Chrome becomes Google Chrome stable (the Chrome
  comparison). On Linux the agent package comes from the external extensions file of a Chrome build
  in agentwatch's tools folder, not from `--load-extension`, and its ID changes (section 10).
- O1 to O19 stay as they are.

## 14. Questions for the operator, and the answers (task item 7)

On the board as ab-jzg. The operator answered all four on 2026-11-04 (confirmed). Q1 and Q2 took
the recommendation, Q3 did not, and Q4 was decided through the follow-up item ab-8mf. Each answer
follows its question; the rest of the design applies it. The Chrome comparison's own questions are
ab-vsm (section 9).

**Q1. What does `browser.newContext()` do in agent mode?** Many programs that expect Playwright call
it. Chrome refuses a new context to an extension.
- **a. Refuse it with a clear error (recommended).** Programs use `browser.contexts()[0]`, as the
  Playwright MCP does by default. A program that calls `newContext()` needs one changed line.
- b. Give the default context under a new name. Such programs run unchanged, but they share the
  signed-in profile: their cookies and storage are the operator's sent sign-ins. The model would
  limit `context.close()` to the program's own tabs and `clearCookies()` to the allowlist.
- c. A real new context through the approval path (see Q2).
- No answer: a.
- **Answer (2026-11-04): a**, "Refuse it with a clear error".

**Q2. Does agentwatch ever open Chrome's approval path (rows 32 to 39)?**
- **a. Never (recommended).** No prompt and no port. Those features give a clear error.
- b. As an opt-in per box on Linux: xdotool answers the prompt blind (with the version gate), and a
  loopback port opens to every local user while it runs.
- c. As an opt-in that a person approves with a click, each time.
- No answer: a.
- **Answer (2026-11-04): a**, "Never".

**Q3. Playwright features that a site can see** (`addInitScript`, `exposeFunction`, `exposeBinding`
and tracing snapshots put `__playwright__*` names on the page's `window`; rows 25 and 27).
- **a. Allow them; the skill tells agents to avoid them on sites that check for automation
  (recommended).** Programs that use them keep working.
- b. The model refuses them. No such mark ever reaches a page, but programs that use them fail.
- c. Allow them only on sites that the operator marks in the Browser pane.
- No answer: a.
- **Answer (2026-11-04): b**, "Refuse them" (not the recommendation). The model refuses the
  main-world init scripts and bindings (section 4.3; rows 25 and 27). Four of the probe's
  Playwright cases now get a refusal (section 5).

**Q4. Who may read and remove the sent sign-ins through the endpoint?** Through Playwright's cookie
calls (`context.cookies()`, `storageState()`), any agent session can read the cookie values of every
allowlisted site, the httpOnly sign-in cookies too, and `clearCookies()` removes them for every
session. O9 kept the allowlist because of the risk to the signed-in profile.
- a. Full access for allowlisted domains: Playwright compatible. Any session reads every sign-in
  value and can remove the sign-ins.
- **b. Hide the httpOnly sign-in values (recommended).** The cookie calls list every allowlisted
  cookie, but give the value of an httpOnly cookie only when an agent set it; `clearCookies()` removes
  only cookies that agents set. The model also blanks `Cookie` and `Set-Cookie` values in the network
  events and the `Fetch` interception that it passes on. Sites work as before, because Chrome itself
  sends the cookies. A page script, also one that an agent runs with `evaluate`, still reads the
  cookies that are not httpOnly (`document.cookie`) and the page storage, as any page script can;
  most sign-ins sit in httpOnly cookies. A program that copies cookies out (a `storageState` file)
  loses the httpOnly sign-in values.
- c. No cookie calls at all through the endpoint. The browser still uses its cookies; programs that
  read or set cookies fail.
- With any answer the limit of section 8 stays: a hostile process of the same OS user can read the
  profile directly. No answer: b.
- **Answer: c, by default.** On ab-jzg (2026-11-04) the operator asked: "I'm not sure about this. This is to
  prevent agents from making a mistake?" The follow-up item ab-8mf answered: yes, it prevents a
  mistake (one clear-cookies call logs every agent session out), and it also prevents a leak of the
  sign-in secrets. The operator's answer to ab-8mf (2026-11-04): "No cookies by default. Make a note
  in the code to add a cookie grant in the future if we run into a use-case that needs cookie
  access." So the endpoint offers no cookie calls (section 8; rows 22 and 23), and stage 3 puts the
  note in the relay's code. One more Playwright case and one concurrency case of the probe now get
  a refusal (section 5).

## 15. Calls made by the designer (not the operator's)

- Two packages from one source tree; the operator-mode ID kept (section 3).
- Option (a), not the Playwright MCP's extension mode (section 4.1).
- A thin extension; the browser model in agent-browser as `agent-browser relay`; the daemon carries
  the bridge over the native link on a second channel (section 4.2).
- One connection per tab; the popup's owner from Chrome's `openerId` (section 4.4).
- `Browser.close` from a client ends its connection only (section 4.3).
- Permissions through the model, for allowlisted origins only, per connection (sections 4.3, 8).
  The cookie calls are refused by the operator's choice (ab-8mf), not by the designer.
- The DNR navigation-header rule, the DNR frame rule and the mouse `force` (sections 7, 8).
- A Unix socket only for now; the scope is the session's name in the endpoint path; every session of
  the OS user may connect; `browser.control: false` turns the endpoint off; a session's scope tabs
  close when the session ends (section 11).
- Downloads copied from Chrome's download folder (in the state folder) to the client's folder; the
  automatic-downloads setting for allowlisted domains (section 4.5).

## 16. The evidence

The probe: [2026-11-03-two-modes-probe/README.md](2026-11-03-two-modes-probe/README.md), its source
(`ext/`, `relay.mjs`, `site.mjs`, `matrix.mjs`, `pw-probe.mjs`, `mcp-probe.mjs`, `concurrency.mjs`,
`run.sh`) and its results ([results/summary.md](2026-11-03-two-modes-probe/results/summary.md),
run 19, and its control run). It ran in a private Xvfb with an auth file, a throwaway HOME and profile, and `*.localhost`
sites on 127.0.0.1 only. The probe joins the extension and the relay with a loopback WebSocket; the
design uses the native link. Rows marked D or C in section 5 are not measured by a client. Two fresh
reviewers read the draft and the probe; this version takes their findings (the PR description lists
them). Sections 9 and 10 follow the Chrome comparison's final report (merged in b320d09) and its
Mac checks of 2026-11-03 (its section 8, board task ab-v16.11). The focus result of 2026-11-04 is on
board task ab-b84.11. The operator's answers are on the board items ab-vsm, ab-jzg, ab-32m, ab-8mf
and ab-9hj (2026-11-04). The notes "read, not run" on Playwright's own calls come from
playwright-core 1.64.1, the version of the probe.
