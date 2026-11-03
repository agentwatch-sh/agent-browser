# Two modes: operator mode sends sign-ins, agent mode serves the Playwright APIs — design

Date: 2026-11-03. Status: **DRAFT for the operator's review.** Author: taylor session `ab-design`
(board task ab-v16.1, goal ab-v16). Branch `ab-v16.1-design-the-two-modes-and-how-agent-mode`.
Evidence: the probe in [2026-11-03-two-modes-probe/](2026-11-03-two-modes-probe/README.md), run on
taylor with Debian Chromium 156.0.8078.73, Playwright 1.64.1 and Playwright MCP 0.0.84.

This design builds on the agentwatch design `docs/superpowers/specs/2026-10-31-agent-browser-design.md`
(agentwatch main) and keeps its operator decisions O1 to O19. Section 13 names the two places where
this design changes a part of it; neither changes an operator decision.

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
- **Measured on taylor:** 42 of 42 Playwright cases and the Playwright MCP's navigate, snapshot, type,
  click, screenshot and tabs work through the extension, over a Unix socket and over loopback TCP.
  No prompt appears. The site saw `navigator.webdriver` false, no infobar, no resize, trusted input,
  no CDP console tell and no new page globals for normal use (section 5, section 7).
- **No prompt on any path that agentwatch uses.** Every feature that agentwatch offers goes through
  the extension. The few features that only Chrome's "Allow remote debugging?" connection gives
  (a new isolated context, service-worker targets, JS coverage, a few browser-wide domains) give a
  clear error in agent mode (section 6). Open question Q2 asks whether to offer them at all.
- **The allowlist holds for any CDP client:** the extension's DNR rules block every off-list
  top-level navigation in Chrome, whatever the client sends; the measured off-list host got no
  request in seven runs. The browser model adds a cookie and permission filter and the tab scope
  (section 8).
- **Which Chrome:** section 9 takes the result of the Chrome comparison (ab-v16.2).
- **Build:** six stages over three repos (section 12). Four open questions (section 14).

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
operator's own Chrome the `debugger` permission and an "it can read and change your data" install
warning, even if its code never used it. So the design keeps one product and one source tree, and
builds two packages from it:

| | Operator mode | Agent mode |
| --- | --- | --- |
| Today's folder | `sender/` | `receiver/` |
| New folder | `operator/` | `agent/` |
| Name in Chrome | agentwatch — operator mode | agentwatch — agent mode (agent browser only) |
| Extension ID | `bpfkgknpndlpkcffmaaelkfcbpackiip` (kept) | `dofdpnfachcncepdoondkeodcbnhipdc` (kept) |
| Who installs it | The operator, once, in their own Chrome (Load unpacked from the Browser pane's download; a Web Store listing is a later choice) | Linux: the daemon, at each Chromium start (`--load-extension`). Mac: the operator, once per agent profile (Load unpacked) |
| Permissions | `cookies`, `activeTab`, `scripting`, `storage`, optional host permissions | `debugger`, `tabs`, `webNavigation`, `declarativeNetRequest`, `cookies`, `scripting`, `nativeMessaging`, `browsingData`, `downloads`, `contentSettings`, `<all_urls>` |

The IDs stay, so agentwatch's pins (`tools/pins.py`) and the gateway's `Origin` check stay as they
are. Shared code (`shared/`: the codec, the cookie mapping, the domain rules) stays shared, as today.

### 3.2 How the mode is chosen

The package is the mode. Nothing switches a mode at run time:

- The **agent Chrome's launch sets agent mode**: on Linux the daemon starts Chromium with
  `--load-extension=<agent package>` (stage 1 does this today). The daemon never loads the operator
  package.
- The Browser pane offers only the operator package for download.
- The agent package works only where the daemon wrote its native host manifest into the profile
  (`<profile>/NativeMessagingHosts/`; measured in stage 1). In any other profile its native port does
  not connect, and an agent package without its link does nothing: it runs no call, opens no
  connection, and its DNR block still blocks every top-level page. The native host also checks that
  its parent Chrome runs on the agent profile (`--user-data-dir` in `/proc/<ppid>/cmdline` on Linux,
  `ps` on the Mac) and refuses otherwise.

### 3.3 What each mode does

| | Operator mode | Agent mode |
| --- | --- | --- |
| Read a site's cookies and the current tab's page storage | Yes, on the operator's click in its popup only | No |
| Send a site's state to a box (the "beam", O14, O15, O17) | Yes (the two gateway routes of contract C9) | No |
| Write a site's state (the import, O19) | No | Yes (stage 1) |
| Block off-list top-level pages (O13) | No | Yes (DNR, stage 1) |
| Control the browser (CDP) | **Never: it holds no `debugger` permission** | Yes, through `chrome.debugger` (O18) |
| Talk to the daemon | No | Yes, over native messaging only |
| Accept a connection or a message from outside | No: no `externally_connectable`, no content script, no web-accessible resource, no listener | Only from its own native host |

### 3.4 Why operator mode can never control the operator's Chrome

1. The operator package has no `debugger`, `nativeMessaging` or `declarativeNetRequest` permission.
   Chrome then gives the extension no `chrome.debugger` object at all. This is Chrome's rule, not our
   code's.
2. Operator mode has no inbound channel. It never polls, never holds a WebSocket and never listens. It
   sends a request only when the operator clicks Send in its popup. A box cannot reach it.
3. A test in chrome-extension (today's `test/manifests.test.mjs`) fails the build if the operator
   manifest gains one of those permissions, a content script, `externally_connectable` or
   `web_accessible_resources`.
4. If the operator loads the agent package into their own Chrome by mistake, it stays inert (3.2):
   the operator's profile holds no native host manifest for it, and the host refuses a parent Chrome
   that is not on an agent profile. Its name says "agent browser only".

## 4. How agent mode serves the Playwright APIs (task item 2)

### 4.1 The three options

| Option | What it is | Result |
| --- | --- | --- |
| (a) A local CDP endpoint, relayed through the extension | A process on the box speaks CDP to clients and drives Chrome through the extension | **Chosen.** Playwright, the Playwright MCP (`--cdp-endpoint` or `PLAYWRIGHT_MCP_CDP_ENDPOINT`) and agent-browser connect with no code change (measured) |
| (b) The Playwright MCP's extension mode | `@playwright/mcp --extension` talks to Microsoft's "Playwright Extension" | Not used. It needs Microsoft's extension ID (`playwrightExtensionId` in playwright-core), it starts its own browser to open a connect page, its relay serves one client, and it answers `Browser.setDownloadBehavior` with nothing, so downloads do not reach Playwright (playwright-core 1.65.0-alpha `cdpRelay.ts`, read, not run). Our extension cannot take that ID. (a) already serves the MCP |
| (c) Both | | Not needed: (a) covers the MCP |

Playwright's own relay (`cdpRelay.ts`, "protocol V2") is prior art for (a): a thin extension that
forwards `chrome.debugger` and `chrome.tabs` events, and a relay that holds the browser model. This
design takes the same shape and closes the gaps that the probe found (downloads, permissions, raw
CDP sessions, several clients, scopes).

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
  no CDP logic. A thin extension changes rarely, and that matters on the Mac, where each extension
  change is a manual reload per profile.
- **The browser model and the endpoint live in agent-browser** (TypeScript, O1: agent-browser owns
  the browser code). A new internal command, `agent-browser relay`, serves the endpoint and holds the
  model. Its bridge side is a JSON-lines stream on its standard input and output.
- **The daemon** starts the relay with the unit, and carries the bridge messages between the relay
  and the native link. The native link of stage 1 stays; contract C4 gets the bridge messages. A
  message from the host to the extension is at most about 1 MiB (measured in stage 1), so the daemon
  cuts large ones into C4 parts, as it does for an import.

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
| `Target.setAutoAttach` (root) | Attaches the client to each tab of its scope, then to each new tab of its scope; emits `Target.attachedToTarget` with `waitingForDebugger: false` |
| `Target.getTargets`, `setDiscoverTargets`, `getTargetInfo` | The tabs of the client's scope, from `chrome.debugger.getTargets` and `chrome.tabs` |
| `Target.createTarget` | `chrome.tabs.create` (or `chrome.windows.create` for `newWindow`); the tab joins the scope; the attach event goes out before the answer, as Playwright needs |
| `Target.closeTarget`, `activateTarget` | `chrome.tabs.remove`, `chrome.tabs.update` |
| `Target.attachToTarget`, `detachFromTarget`, `attachToBrowserTarget` | Sessions of the model. All sessions of one tab share its one `chrome.debugger` attachment; the last one to leave detaches it, so no domain state (Fetch, Emulation) stays behind |
| `Target.getBrowserContexts`, `createBrowserContext` | No contexts; a new context is refused (open question Q1) |
| `Browser.setDownloadBehavior` and the download events | Section 4.4 |
| `Browser.grantPermissions`, `resetPermissions` | `chrome.contentSettings` for geolocation, notifications, camera and microphone, for allowlisted origins only; other permissions are refused |
| `Browser.getWindowForTarget`, `getWindowBounds`, `setWindowBounds` | `chrome.windows` (also when they arrive on a page session) |
| `Storage.getCookies`, `setCookies`, `clearCookies` | `chrome.cookies`, for allowlisted domains only (section 8) |
| `Browser.close` | Ends that client's connection only. The agent browser keeps running for the other sessions (measured: Chromium alive after each client's `browser.close()`) |
| Any other root call | "Not available in the agent browser: <method>" |

Every other call on a page session goes to `chrome.debugger.sendCommand({tabId, sessionId?})`.
Frames and workers of a tab are flat child sessions of its attachment (measured with a cross-site
frame).

### 4.4 Downloads

`Browser.setDownloadBehavior` is refused to an extension, so Chrome saves a download in its own
download folder. The model takes Chrome's `Page.downloadWillBegin` and `Page.downloadProgress` events
of the tab session, sends Playwright the `Browser.downloadWillBegin` and `Browser.downloadProgress`
events it expects, and copies the finished file (found with `chrome.downloads.search`) to Playwright's
download folder under the download's guid. Measured: `page.waitForEvent("download")` and
`download.path()` return the file and its content. The daemon seeds the profile's download folder
under the state folder, so downloads never land in the user's own Downloads folder.

### 4.5 Speed

Measured on taylor, one tab, Unix socket and TCP alike: a `page.evaluate` round trip takes 3 ms
(20 in a row), a click 50 to 170 ms, a full page load of the test page about 100 ms. The native link
adds one more local hop than the probe's WebSocket; stage 3's live test measures it.

## 5. The feature table

Path: **1** = through the extension (`chrome.debugger` and `chrome.*`, no approval). **2** = only
through Chrome's own CDP connection, which needs the "Allow remote debugging?" approval. **3** = not
possible. Evidence: **P** a Playwright case and **MCP** an MCP call (`results/pw-*.json`,
`results/mcp.json`), **M** a matrix row (`results/matrix.json`), **S** the site's own report or the
server's request log (`results/site-log.compact.jsonl`), **D** documentation or source reading only,
**C** the probe relay's code, not run by a client. Prompts are none on path 1. A path-2 feature would
bring "Allow remote debugging?" at each new connection; agent mode does not offer path 2 (section 6).

| # | Feature (Playwright, MCP) | CDP behind it | Path | How in agent mode | What a site can detect | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Connect: `connectOverCDP`, MCP `PLAYWRIGHT_MCP_CDP_ENDPOINT` | `Browser.getVersion`, root `Target.setAutoAttach`, `Target.getTargetInfo` | 1 | The model answers | Nothing | P, MCP, M (refused to the extension) |
| 2 | The default context and its pages: `browser.contexts()[0]`, `context.pages()` | Target events | 1 | The scope's tabs | Nothing | P |
| 3 | New tab: `context.newPage()`, MCP `browser_tabs new` | `Target.createTarget` | 1 | `chrome.tabs.create` | Nothing | P, MCP |
| 4 | Navigation: `goto`, `reload`, back and forward, MCP `browser_navigate` | `Page.navigate` and history | 1 | Sent to `chrome.debugger` | `Sec-Fetch-Site: cross-site` on a `Page.navigate` (Chrome names the extension as the initiator); **fixed** by an agent-mode DNR rule that sets `none` for navigations the extension starts: then `none` + `?1`, as a typed URL; a page's own navigations keep their value | P, MCP, M, S |
| 5 | Input: click, fill, type, press, hover, selectOption, drag; MCP click and type | `Input.*`, `DOM.*`, `Runtime.callFunctionOn` | 1 | Sent | Events are trusted (`isTrusted` true); nothing else seen | P, MCP, S |
| 6 | Evaluate and locators: `evaluate`, `waitForFunction`, `locator.*` | `Runtime.*`, `Page.createIsolatedWorld` | 1 | Sent | `navigator.webdriver` false; the `Runtime.enable` console tell stayed at 0; Playwright's helpers run in an isolated world | P, S |
| 7 | Page reads: `ariaSnapshot`, MCP `browser_snapshot`, `textContent` | `Runtime` in the utility world | 1 | Sent | Nothing | P, MCP |
| 8 | Screenshot: `page.screenshot`, MCP `browser_take_screenshot` | `Page.captureScreenshot` | 1 | Sent | Nothing | P, MCP |
| 9 | Viewport: `setViewportSize` | `Emulation.setDeviceMetricsOverride` | 1 | Sent | The new size and one `resize` event, as with any Playwright | P, S |
| 10 | Window bounds (a context with a viewport, `page.windowBounds`) | `Browser.getWindowForTarget`, `set/getWindowBounds` | 1 | `chrome.windows` | Window size, by intent | M (refused to the extension), C |
| 11 | Popups: `page.on("popup")` for `window.open` and `target=_blank` | browser auto-attach with `openerId` | 1 | The model attaches on `chrome.tabs.onCreated` and sets `openerId` from `openerTabId` | Nothing. The attach comes just after the tab exists; an init script still ran in the popup in each run (it depends on timing; section 10) | P |
| 12 | Close: `page.close`, MCP `browser_close` | `Target.closeTarget` | 1 | `chrome.tabs.remove` | Nothing | P, MCP |
| 13 | Cross-site frames: `frameLocator`, frame clicks | page `Target.setAutoAttach`, flat child sessions | 1 | Sent | Nothing | P, M |
| 14 | Dialogs: `page.on("dialog")`, MCP `browser_handle_dialog` | `Page.handleJavaScriptDialog` | 1 | Sent | Nothing | P |
| 15 | Request interception: `page.route`, `fulfill`, `continue`, `abort` | `Fetch.*` | 1 | Sent | Nothing. DNR acts before Fetch: a `route.fulfill` of an off-list document is still blocked | P |
| 16 | Network events and bodies: `page.on("request"/"response")`, `response.body()`, MCP `browser_network_requests` | `Network.*` | 1 | Sent | Nothing | P (`Network.getResponseBody` in `relay-events.json`), M |
| 17 | File upload by path: `setInputFiles(path)`, MCP `browser_file_upload` | `DOM.setFileInputFiles` | 1 | Sent (an unpacked extension has file access) | Nothing | P, M |
| 18 | File upload by buffer | Playwright's page script | 1 | Sent | Nothing | P |
| 19 | Downloads: `waitForEvent("download")`, `download.path()` | `Browser.setDownloadBehavior`, `Browser.download*` | 1 | Section 4.4 | Nothing | P, M (refused to the extension) |
| 20 | Cookies: `context.cookies`, `addCookies`, `clearCookies` | `Storage.*` | 1 | `chrome.cookies`, allowlisted domains only | Nothing | P (an off-list cookie refused), M |
| 21 | Storage state: `context.storageState()` | rows 6 and 20 | 1 | From rows 6 and 20 | Nothing | D |
| 22 | Permissions: `grantPermissions`, `clearPermissions` | `Browser.grantPermissions` | 1 for geolocation, notifications, camera, microphone; 2 for the others (clipboard, MIDI, sensors and so on) | `chrome.contentSettings` | The permission state, by intent | P (geolocation "granted", then "prompt"; clipboard refused), M |
| 23 | Init scripts and bindings: `addInitScript`, `exposeFunction`, `exposeBinding` | `Page.addScriptToEvaluateOnNewDocument`, `Runtime.addBinding` | 1 | Sent | **Yes**: Playwright puts `__playwright__binding__` and `__playwright__binding__controller__` on the page's `window` (and the script's own globals). This is Playwright's own mark, on any transport (open question Q3) | P, S |
| 24 | Emulation: geolocation, timezone, locale, media, offline, extra headers | `Emulation.*`, `Network.emulateNetworkConditions`, `Network.setExtraHTTPHeaders` | 1 | Sent | The emulated values, by intent | M |
| 25 | Tracing: `context.tracing` with screenshots and snapshots | `Page.startScreencast`, `Runtime` | 1 | Sent | **Yes**, while it records snapshots: a `__playwright_snapshot_streamer_<id>` global (Q3) | P, S |
| 26 | PDF: `page.pdf` | `Page.printToPDF` | 1 | Sent | Nothing | P, M |
| 27 | Raw CDP: `context.newCDPSession`, `browser.newBrowserCDPSession` | `Target.attachToBrowserTarget` | 1 for page domains and the model's browser set; 2 for other browser domains | A model session | Nothing | P |
| 28 | Target discovery as Puppeteer and agent-browser use it | `Target.getTargets`, `setDiscoverTargets`, `attachToTarget` | 1 | The model | Nothing | M (refused to the extension), C |
| 29 | `browser.close()` | `Browser.close` | 1 | Ends the connection only | Nothing | P |
| 30 | An isolated context: `browser.newContext()`, MCP `--isolated` or a tab's `isolatedContext` | `Target.createBrowserContext` | 2 | Refused with a clear error (Q1) | — | P (refused), M |
| 31 | Video: `recordVideo` | needs a new context | 2 | Refused (the screencast of row 25 works) | — | D, M |
| 32 | Service workers: `context.serviceWorkers()`, `on("serviceworker")` | browser-level worker targets | 2 | The model reports none | — | P (none), D |
| 33 | `ignoreHTTPSErrors` | `Security.setIgnoreCertificateErrors` | 2 | Refused ("wasn't found") | — | M |
| 34 | JS coverage, `page.requestGC()` | `Profiler.*`, `HeapProfiler.*` | 2 | Refused ("wasn't found") | — | M |
| 35 | Browser-wide tracing: `browser.startTracing()` with no page | `Tracing` on the browser target | 2; with a page, 1 | `Tracing.start` on the tab session works | Nothing | M |
| 36 | `chrome://` pages and other extensions' pages | | 2 | Refused: "Cannot access a chrome:// URL" | — | M |
| 37 | `SystemInfo.*` (GPU data), `Extensions.*` | | 2; `Extensions.*` 3 for agentwatch | Refused ("wasn't found") | — | M |
| 38 | Any off-list top-level page: `goto`, link click, `window.open`, `route.fulfill`, `file://` | DNR | guard | Blocked in Chrome: `net::ERR_BLOCKED_BY_CLIENT`; the tab shows Chrome's blocked page and stays usable | The off-list site sees nothing (no request in seven runs) | P, MCP, M, S |

Setup actions (not prompts): on Linux, none. On the Mac, the operator loads the agent package once
per agent profile with developer mode on (section 10). Whether branded Chrome then shows a warning
at start is a question for the Chrome comparison (ab-v16.2) and Mac check 1.

## 6. How the two paths work together

- **When the approval path is needed at all.** Only for rows 30 to 37: an isolated context, video
  of a new context, service-worker targets, `ignoreHTTPSErrors`, JS coverage, browser-wide tracing,
  `chrome://` pages and a few browser domains. The Playwright MCP in its default mode needs none of
  them (measured). agent-browser's own commands need none of them (it uses `Browser.setDownloadBehavior`,
  `Browser.getWindowForTarget` and the Target calls, which the model serves).
- **Whether both can run at once.** Chrome allows several CDP clients on one target, so an approved
  connection could run next to the extension (documentation; not measured here). But the approval
  path costs what the extension path removes: Chrome then listens on a loopback TCP port (9222,
  measured on 2026-11-01) that every local user can reach; each new connection raises "Allow remote
  debugging?"; on Linux xdotool answers it blind and needs a version gate; on the Mac a person must
  click after each sleep (#9) and find the right window (#3). The design recommends that agentwatch
  never opens it (Q2). vedlo and marketdata-update keep agent-browser's CDP proxy (the approval path)
  until they choose to move.
- **What an agent sees.** One endpoint. Rows 1 to 29 work. A path-2 feature fails at once with a
  clear message, for example "Not available in the agent browser: a new browser context
  (Target.createBrowserContext). Use the default context: browser.contexts()[0]." No prompt, no
  window and no banner appears, and the agent never waits for a person.

## 7. What a site can see (the operator's top goal)

Measured with the probe's site script, which reports what a page can read, and the server log (the
first page is the baseline: a tab with no debugger and no client):

- The same as the baseline under Playwright and the MCP: `navigator.webdriver` false, `innerHeight`
  812 (no infobar; `--silent-debugger-extension-api`), no `resize` event at attach, the CDP console
  tell (a getter on `Error.stack` logged with `console.debug`) at 0, `document.hasFocus()` true,
  `visibilityState` visible, every input event trusted, the same user agent.
- No new page global under plain use (navigate, click, type, read, screenshot, the MCP's default
  tools).
- **Different from a person, and the fix:** a `Page.navigate` sends `Sec-Fetch-Site: cross-site`
  where a typed URL sends `none`. A DNR `modifyHeaders` rule in the agent package with
  `initiatorDomains` = its own ID sets `none` for the navigations that the extension starts and for
  no other navigation (measured: `Page.navigate` then sends `none` + `?1`; a page script's
  navigation keeps `same-origin`).
- **Different from a person, by Playwright's choice:** `addInitScript`, `exposeFunction`,
  `exposeBinding` and tracing snapshots put `__playwright__*` names on the page's `window` (rows 23
  and 25). Q3 asks what agent mode does about them.
- The identity of the browser after a send (the same OS, the same Chrome build as the operator's)
  and the machine's own tells (WebGL, timezone, fonts; agentwatch design §5.9) are the subject of
  ab-v16.2, not of this probe.

## 8. The allowlist and the tab scope with a raw CDP client (task item 3)

**What Chrome enforces, whatever the client sends.** The agent package's DNR rules (stage 1: block
every `main_frame`, allow the list) act in Chrome's network stack before any CDP interception.
Measured: `page.goto`, `Page.navigate`, a link click, `window.open`, `Target.createTarget` with a URL,
a `page.route` that fulfills an off-list document, and `file://` all end in
`net::ERR_BLOCKED_BY_CLIENT`; the off-list host received no request in seven runs. After a blocked
`goto`, Chrome commits its error page a moment later; the same page then goes on to an allowlisted
URL (measured; the skill tells agents to wait for the error page before the next `goto`). Frames and
subresources of an allowlisted page still load from any host (O11).

**What the browser model adds.**

- Cookies: `Storage.getCookies` on a tab session returns the cookies of other sites too (measured: a
  `c.localhost` cookie, from a page of `a.localhost`). So the model answers every cookie call itself
  and filters to allowlisted domains: `Storage.*` on any session, `Network.getAllCookies` and
  `Network.getCookies` (results filtered), `Network.setCookie(s)` and `deleteCookies` (an off-list
  domain refused), `Network.clearBrowserCookies` (only allowlisted cookies). Measured for
  `context.addCookies`.
- Permissions: only for allowlisted origins (row 22).
- `Extensions.*` and `Target.exposeDevToolsProtocol` are refused on every session.
- The model never attaches a client to a tab outside the client's scope, to a tab that the operator
  opened in the live view, or to a `chrome://` page (Chrome refuses the last one too, measured).

**The tab scope (agent-browser #14).** Each connection names its scope in the endpoint path
(`/devtools/browser/<scope>`). A client sees and attaches only the tabs of its scope; the tabs it
opens and their popups join the scope; another scope's tab answers "No target with given id found".
Measured: three clients (two Playwright runs and the MCP) each saw only their own tabs while other
tabs were open. As in #14, the scope is advisory: every agent runs as the same OS user.

**What stays open, stated plainly (as agentwatch design §5.4).** An allowlisted page loads frames
and subresources from any host, and a CDP client can read them (frame sessions,
`Network.getResponseBody`). Any process of the box's user can open the endpoint's 0600 socket: the
same limit as today's proxy socket. The allowlist keeps an honest agent and an injected page inside
the operator's choice; it is not a wall against a hostile process of the same user.

## 9. Which Chrome is the agent Chrome

This section takes the result of the Chrome comparison (ab-v16.2,
`docs/research/2026-11-03-chrome-vs-chrome-beta.md`), which runs at the same time as this design.
**It waits for that report;** this PR merges only after the comparison PR (manager's decision). The
facts this design adds to that choice:

- The extension path needs a Chrome that loads the agent package and honours
  `--silent-debugger-extension-api`. Debian Chromium 156 does both from the command line (stage 1).
  Branded Chrome Beta 158 on the Mac honours the flag but refuses `--load-extension` (Mac checks of
  2026-11-01), so a branded Chrome needs a one-time manual load per agent profile.
- Nothing in the browser model depends on the channel: it reads the product and the user agent from
  the running browser.

## 10. Linux and macOS (task item 4)

**Linux (taylor first).** The stage-1 unit stays: the daemon starts a private Xvfb (`-nolisten tcp`,
an auth file) and Chromium with `--load-extension=<agent package>` and
`--silent-debugger-extension-api`, no remote-debugging flag and no port. The relay starts with the
unit and stops with it. The fail-closed rule of stage 1 extends to the endpoint: while the receiver
has not confirmed the operator's list, the endpoint refuses connections. No prompt exists at any
step. agentwatch design §5.13 item 1 (the xdotool version gate) is not needed on this path.

**macOS.** The agent Chrome is the branded Chrome that section 9 names, on its own profile, started
with `open -n -g` (it never takes the operator's focus). Branded Chrome refuses `--load-extension`,
so the operator loads the agent package once per agent profile: chrome://extensions, developer mode
on, Load unpacked. Then:

- **No approval click.** `chrome.debugger.attach` needs no approval (measured on Linux; on the Mac the
  silent flag and the native host location passed Mac checks 2 and 3).
- **#9 (a sleep ends the approval) ends for agentwatch:** there is no approval to lose. Open: Mac
  check 4, whether `chrome.debugger` and the native port come back after a sleep with no prompt. If
  Chrome detaches the debugger at a sleep, the model sends each client `Target.detachedFromTarget`,
  attaches again after the wake (no prompt), and clients reconnect. A client loses its open page
  objects, not the tabs.
- **#3 (which window asks) ends for agentwatch:** no window asks.
- Open: Mac check 1, whether the manual load survives `quit` and `launch`, and whether Chrome shows a
  developer-mode warning at start.
- The notice of agentwatch design §5.8 still names the consumer, the profile and the box, for the
  cases where a person must act (a sign-in, a Chrome that does not start).

**Effect on the waiting tasks.** ab-b84.2 ("The operator can tell which agent Chrome window asks for
the debugging approval") and ab-b84.3 ("One debugging approval lasts through a Mac sleep") concern
the CDP proxy path. In agent mode neither prompt exists. They still apply to vedlo and
marketdata-update while those use the proxy. Their order is the manager's call after the operator
approves this design.

**One more measured limit.** A popup is a new tab that the model attaches just after Chrome creates
it, not before its first script as Chrome's own auto-attach does. In every run Playwright's init
script still ran in the popup, but over a fast network a popup's first script could run before the
attach. In one of eleven probe runs a command to a new popup got no answer; the probe now times out
a bridge call after 15 s. The build makes the extension attach a new tab of an attached scope at
once, in its `tabs.onCreated` handler, and gives each bridge call a deadline after which the model
detaches the tab and tells the client.

## 11. How agentwatch exposes the endpoint, and who may connect (task item 5)

- **The endpoint.** A Unix socket, 0600, in agentwatch's runtime folder:
  `/run/user/<uid>/agentwatch/browser-cdp.sock` on Linux, `~/.cache/agentwatch/run/browser-cdp.sock` on
  the Mac (a socket path holds at most 107 bytes; agent-browser checks 103). The CDP URL is
  `ws+unix://<socket>:/devtools/browser/<scope>`. Measured: Playwright's `connectOverCDP` and the
  Playwright MCP accept this form, because Playwright passes any `ws…` URL to its WebSocket library,
  which supports `ws+unix:`. No TCP port by default (Q4).
- **`agentwatch browser endpoint`** prints the URL for the calling session, with the session's name
  as the scope. It starts the unit first when it is down, as `agentwatch browser start` does.
  **`agentwatch browser env`** prints `PLAYWRIGHT_MCP_CDP_ENDPOINT=<url>` for an MCP configuration.
  The URL holds no secret.
- **Who may connect.** Every agentwatch session of the daemon's OS user, each in its own scope,
  exactly as every such session may run `agentwatch browser` today. The operator turns agent control
  off with `browser.control: false` in the config (the endpoint then does not exist); the allowlist
  stays the operator's, in the web viewer, with a password login (O9, §5.4).
- **"No change in the program."** A program that takes a CDP endpoint (the Playwright MCP, browser
  agent frameworks, a script that calls `connectOverCDP`) needs only the endpoint. A script that
  calls `chromium.launch()` itself needs one changed line, `connectOverCDP(endpoint)` and
  `browser.contexts()[0]`. Playwright Test's `connectOptions` speaks Playwright's own server
  protocol, not CDP; a small Playwright server in front of the endpoint is a later option (not
  measured).
- **The skill** (`agentwatch-browser`) tells agents: get the endpoint from `agentwatch browser
  endpoint`; use `browser.contexts()[0]`; never call `browser.newContext()`; wait for the error page
  after a blocked `goto`; avoid `addInitScript`, `exposeFunction` and tracing snapshots on a site
  that checks for automation (unless Q3 says otherwise); the allowlist is the operator's.

## 12. Build stages, in order (task item 6)

| Stage | Repo | What | Depends on |
| --- | --- | --- | --- |
| 1. Contracts | chrome-extension (`docs/protocol.md`) | C10: the bridge (the fixed call list, the events, the deadline, parts over the native link). C11: the endpoint path, the scope, the refusal texts. The agentwatch side reads the same file | — |
| 2. Two packages | chrome-extension | `sender/` becomes `operator/`, `receiver/` becomes `agent/` (IDs kept); the bridge in `agent/`; the DNR navigation-header rule; eager attach in `tabs.onCreated`; manifest tests (the operator package has no control permission); bridge unit tests with the fake chrome | 1 |
| 3. The relay | agent-browser | `src/relay/`: the browser model and the endpoint server (the `ws` dependency it already has); the internal command `agent-browser relay`; the cookie, permission and scope policy; unit tests with a fake bridge; a live test (outside `npm test`) that runs the probe's Playwright and MCP cases from a scratch install; agent-browser's own commands get an endpoint transport (a CDP URL in place of the proxy socket). The CDP proxy stays the default for vedlo and marketdata-update | 1 |
| 4. agentwatch | agentwatch | The unit starts the relay with Chromium and carries the bridge over the native link; `agentwatch browser endpoint` and `env`; `agentwatch browser <command>` through the endpoint; `browser.control`; the download folder in the profile; the skill; `docs/internals/agent-browser.md`; the live test on taylor | 2, 3 |
| 5. The Mac | agentwatch, chrome-extension | Mac checks 1 and 4 with the operator; the manual-load guide; the Mac launch path | 4 |
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
  `receiver/` to `agent/`), and the receiver gains the bridge.
- O1 to O19 stay as they are.

## 14. Open questions for the operator (task item 7)

**Q1. What does `browser.newContext()` do in agent mode?** Many programs that expect Playwright call
it. Chrome refuses a new context to an extension.
- **a. Refuse it with a clear error (recommended).** Programs use `browser.contexts()[0]`, as the
  Playwright MCP does by default. A program that calls `newContext()` needs one changed line.
- b. Give the default context under a new name. Such programs run unchanged, but they share the
  signed-in profile: their cookies and storage are the operator's sent sign-ins. The model would
  limit `context.close()` to the program's own tabs and `clearCookies()` to the allowlist.
- c. A real new context through the approval path (see Q2).
- No answer: a.

**Q2. Does agentwatch ever open Chrome's approval path (rows 30 to 37)?**
- **a. Never (recommended).** No prompt and no port. Those features give a clear error.
- b. As an opt-in per box on Linux: xdotool answers the prompt blind (with the version gate), and a
  loopback port opens to every local user while it runs.
- c. As an opt-in that a person approves with a click, each time.
- No answer: a.

**Q3. Playwright features that a site can see** (`addInitScript`, `exposeFunction`, `exposeBinding`,
tracing snapshots put `__playwright__*` names on the page's `window`; rows 23 and 25).
- **a. Allow them; the skill tells agents to avoid them on sites that check for automation
  (recommended).** Programs that use them keep working.
- b. The model refuses them. No such mark ever reaches a page, but programs that use them fail.
- c. Allow them only on sites that the operator marks in the Browser pane.
- No answer: a.

**Q4. How do programs reach the endpoint?**
- **a. A Unix socket only (recommended).** 0600, no port, no token. Measured with Playwright and the
  MCP.
- b. Also a loopback TCP endpoint with a secret token per session, for clients that cannot use a
  Unix socket (for example a Python CDP library). Every local user can reach the port, so the token
  must stay out of argv and logs.
- No answer: a; b can come later when a client needs it.

## 15. Calls made by the designer (not the operator's)

- Two packages from one source tree, IDs kept (section 3).
- Option (a), not the Playwright MCP's extension mode (section 4.1).
- A thin extension; the browser model in agent-browser as `agent-browser relay`; the daemon carries
  the bridge over the existing native link (section 4.2).
- `Browser.close` from a client ends its connection only (section 4.3).
- Cookies and permissions through the model, for allowlisted domains and origins only (section 8).
- The DNR navigation-header rule, so `Page.navigate` sends what a typed URL sends (section 7).
- The scope is the session's name in the endpoint path; every session of the OS user may connect;
  `browser.control: false` turns the endpoint off (section 11).
- Downloads copied from Chrome's download folder (under the state folder) to the client's folder
  (section 4.4).

## 16. The evidence

The probe: [2026-11-03-two-modes-probe/README.md](2026-11-03-two-modes-probe/README.md), its source
(`ext/`, `relay.mjs`, `site.mjs`, `matrix.mjs`, `pw-probe.mjs`, `mcp-probe.mjs`, `run.sh`) and its
results ([results/summary.md](2026-11-03-two-modes-probe/results/summary.md)). It ran in a private
Xvfb with an auth file, a throwaway HOME and profile, and `*.localhost` sites on 127.0.0.1 only. The
probe joins the extension and the relay with a loopback WebSocket; the design uses the native link.
Rows marked D or C in section 5 are not measured by a client.
