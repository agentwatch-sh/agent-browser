# Chrome stable or Chrome Beta as the agent browser

Board task ab-v16.2, goal ab-v16. Measured on taylor (Linux) on 2026-11-03. The probe is in
[`test/live/parity/`](../../test/live/parity/), and its tables are in
[the appendix](#appendix-the-probes-tables).

The operator's words (2026-11-03): "i want a comparison of chrome vs chrome beta with the extension.
the idea is that i can beam my state to the agentbrowser and as long as its the same OS, the website
in question can't figure out that its not the same browser." The top goal: "Fully drivable browser
for agents that isn't subject to automation blocks, so agents can do whatever I ask them to do."
"Ideal world: no prompts necessary."

This report assumes that the operator's own Chrome is **Google Chrome stable**. If the operator uses
another channel, read "stable" as "the operator's channel".

## The answer

**Use Google Chrome stable at the operator's version, on the same kind of machine as the operator's
Chrome. Do not use Chrome Beta.**

1. **Beta is a different browser to a site.** Beta sends a different major version in the
   User-Agent, in the version client hints (`Sec-CH-UA`, `Sec-CH-UA-Full-Version`,
   `Sec-CH-UA-Full-Version-List`) and in `navigator.userAgentData`, and it uses a different GREASE
   brand. Today Beta is 158 and the operator's stable is 156. Over the last 172 days, Beta was one
   major version ahead of stable on 137 days, two ahead on 32 days, and equal on 3 days. Beta also
   has web features that stable does not have, and it lacks some that stable has. One line of page
   script finds them (section 2.1). A site that sees one sign-in from Chrome 156 and from Chrome 158
   at the same time sees two browsers.
2. **Stable at the same version sends the same identity.** The User-Agent, the client hints, the
   header order, the JA4 TLS fingerprint and the HTTP/2 fingerprint are the operator's own. This is
   inferred from the measurements: these values changed only with the version and the brand, and
   JA4 and HTTP/2 did not change even between the two versions. The Mac's check 5 is to confirm it.
   One limit: Chrome turns some web features on through field trials, and each profile draws its
   own trial groups. So two stable profiles of one version can still differ in a few features. The
   probe ran with no field trials (section 1), so it cannot measure that.
3. **The extension works the same in both channels (measured on Linux).** Both ignore
   `--load-extension`. Both install the receiver persistently from Chrome's external extensions
   file (no developer mode, no prompt), and both keep an extension that "Load unpacked" installed
   with developer mode on. Both drive a tab through `chrome.debugger` with
   `--silent-debugger-extension-api`: no banner, no prompt, `navigator.webdriver` false.

Two limits stay with either channel:

- **"Same OS" must mean the same kind of machine.** On taylor the agent browser is a Linux Chrome
  with no GPU: no WebGL at all, Linux fonts, 32 CPUs, a 1920x1080 screen at device pixel ratio 1,
  and taylor's time zone and IP address. A site compares these with the operator's Mac. A beam does
  not carry them. Only an agent browser on the operator's Mac, or on a Mac like it, can match.
- **Some signals come from how the agent drives, not from the channel.** Agent mode can remove
  most of them (section 3).

## 1. What was measured, and how

| | Version | Source |
| --- | --- | --- |
| Google Chrome stable | 156.0.8078.79 | `google-chrome-stable_current_amd64.deb`, unpacked into a worker folder |
| Google Chrome Beta | 158.0.8127.2 | `google-chrome-beta_current_amd64.deb`, unpacked into a worker folder |
| Chromium (control) | 156.0.8078.73 | Debian's `/usr/bin/chromium` on taylor |

Channel versions on 2026-11-03 (Google's public version history API): Mac stable 156.0.8078.80 for
99% of users and 157.0.8103.26 for 0.5% (the early stable rollout); Linux stable 156.0.8078.79;
Beta 158.0.8127.2 on Mac, Linux and Windows. The gap count in "The answer" comes from the same API:
`https://versionhistory.googleapis.com/v1/chrome/platforms/mac/channels/{stable,beta}/versions/all/releases?filter=starttime>2026-05-01T00:00:00Z`.
For each day from 2026-05-15 to 2026-11-02, it compares the highest major version of the releases
that served at least half of the users of each channel that day.

The probe (`test/live/parity/probe.ts`) runs each browser on throwaway profiles with
agent-browser's own launch flags (`AGENT_ARGS` in `src/agent.ts`). On Linux the browsers run on one
private Xvfb display with a random `-auth` cookie, and `HOME` is a folder of the run. A local site
at `probe.localhost` records what a site sees:

- the request headers in order, and the client hints after `Accept-CH`;
- a page fingerprint: navigator, screen, fonts, canvas, audio, WebGL, WebGPU, media, permissions,
  voices, and every window global, prototype member and CSS property;
- the TLS ClientHello (JA4) and the first HTTP/2 frames (the Akamai fingerprint);
- traps for known automation signals.

A stand-in for the receiver extension (the same permissions) drives the tab the way agent mode
would: `chrome.debugger`, CDP mouse and key input, an isolated world, `Runtime.enable`, a new tab.

Each browser runs with `--proxy-server` pointed at a local proxy that refuses every connection and
logs only the host. `*.localhost` does not use a proxy. So no browser reached a real site.

Limits of the method:

- taylor is Linux, and the operator's Chrome is on a Mac. Section 8 lists the checks that only the
  Mac can run. The probe runs there unchanged.
- The proxy also blocks Chrome's own background traffic, for example the variations seed and the
  component updates. So each browser ran with no field trials. A real Chrome gets the seed of its
  channel and draws trial groups for each profile, so a real profile can show features that this
  probe did not see. Beta's seed serves experiments that stable's does not; that is Google's
  channel design, not measured here. The probe's `--serve` mode records a browser that a person
  opens, with its own seed, for example the operator's own Chrome (the Mac's check 5).
- The probe turned developer mode on and clicked "Load unpacked" through the page's own API, then
  answered Chrome's folder dialog with xdotool. That makes the same install as a person. In Chrome
  stable the click worked. In Chrome Beta 158 and in Chromium the dialog kept its Open button
  greyed out under Xvfb, so the probe could not finish the dialog there. For Beta there is partial
  evidence: Beta 158 loaded, at start, an extension that "Load unpacked" had put into a stable 156
  profile (the `update` runs), and it disabled that extension when developer mode went off. Beta's
  driven tabs (section 3) are the `external-crx-relaunch` and `external-crx-banner` runs.

## 2. Can a site tell the agent browser from the operator's Chrome after a beam?

### 2.1 The channel: Beta is a different browser

The values that differ between stable 156 and Beta 158 on the same machine:

| What a site reads | Chrome stable 156 | Chrome Beta 158 |
| --- | --- | --- |
| User-Agent | `... Chrome/156.0.0.0 Safari/537.36` | `... Chrome/158.0.0.0 Safari/537.36` |
| `Sec-CH-UA` | `"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"` | `"Chromium";v="158", "Not.A/Brand";v="24", "Google Chrome";v="158"` |
| `Sec-CH-UA-Full-Version-List` | `... "Google Chrome";v="156.0.8078.79"` | `... "Google Chrome";v="158.0.8127.2"` |
| `navigator.userAgentData` | the same values as the headers | the same values as the headers |
| Window globals only in this one | `XSLTProcessor` | `CanvasPaintEvent`, `ElementGeometryUpdateEvent`, `ElementImage`, `TrustedHTMLParserOptions` |
| `Element.prototype` only in this one | none | 22 methods: `appendHTML`, `streamHTML`, `beforeHTML`, ... and their `Unsafe` forms |
| `Navigator.prototype` only in this one | 13 Protected Audience members (`joinAdInterestGroup`, `runAdAuction`, ...) | none |
| CSS properties only in this one | none | `text-decoration-inset` |

Every other measured value was the same in both, also below the page:

- JA4 `t13d1517h2_8daaf6152771_cb7bf5808d99` (with a resumed session:
  `t13d1518h2_8daaf6152771_e2d80978ab2e`), the same cipher, group, key share and extension lists,
  ECH GREASE and ALPS in both.
- The Akamai HTTP/2 fingerprint `1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p`.
- The order of the request headers, `Accept`, `Accept-Language`.
- Canvas, audio, fonts, plugins, media codecs, Widevine, voices and storage quota.

Two values change for each connection and are not a channel signal: the ClientHello's length (its
GREASE parts vary) and `navigator.connection.downlink`.

So the TLS and HTTP/2 layers cannot tell the two channels apart. The page and the request headers
can, from the first request.

The same check also shows what a site sees of Chromium: `Sec-CH-UA` has no `"Google Chrome"`
brand, Widevine is absent and there are no speech voices. Chromium is not an option for parity
with the operator's Chrome.

The patch number can differ between platforms too: the Mac's stable is 156.0.8078.80, Linux's is
156.0.8078.79. A site sees that in `Sec-CH-UA-Full-Version-List` (when it asks for the hint) and in
`navigator.userAgentData.getHighEntropyValues()`.

### 2.2 The machine: a beam carries no machine

A beam carries cookies and storage, not the machine. These values come from the machine, and they
were the same in all three browsers on taylor:

| What a site reads | On taylor | On the operator's Mac (expected) |
| --- | --- | --- |
| Platform (User-Agent, `Sec-CH-UA-Platform`) | `X11; Linux x86_64`, `"Linux"` | `Macintosh; Intel Mac OS X 10_15_7`, `"macOS"` |
| WebGL | none: Chrome blocks WebGL with no GPU | ANGLE on the Mac's Apple GPU |
| WebGPU | the API is there, with no adapter | an Apple adapter |
| Fonts (of 65 probed) | 14: DejaVu, Liberation, Noto Color Emoji, FreeSans, and Arial, Helvetica, Times, Courier (fontconfig aliases of the Liberation fonts) | the Mac's fonts |
| CPUs and memory | `hardwareConcurrency` 32, `deviceMemory` 32 | the Mac's values |
| Screen | 1920x1080, device pixel ratio 1; window 945x1060 at (10, 10) | the Mac's display, ratio 2 |
| Time zone | `America/New_York` (taylor's clock) | the Mac's time zone |
| Network | taylor's IP address | the operator's IP address |
| Speech voices | 19 Google network voices | the macOS voices and the Google voices |

`--enable-unsafe-swiftshader` can turn WebGL on without a GPU. Then the renderer names SwiftShader,
Chrome's software renderer, which a site does not expect on a desktop (not measured here).

## 3. Automation signals while an agent drives through the extension

Measured in a tab that the stand-in extension drove through `chrome.debugger`: in Chrome stable 156
after "Load unpacked" and after the external extensions file, in Chrome Beta 158 after the external
extensions file, and in Chromium after `--load-extension`. Each result was the same in every browser
in which it was measured; the banner itself was measured in stable and Beta only. Each signal is
something a page can read.

| Signal | What a page sees | Cause | How agent mode avoids it |
| --- | --- | --- | --- |
| `navigator.webdriver` | `false` while attached | — | Keep it so: no `--remote-debugging-*`, no `--enable-automation`. With `--remote-debugging-pipe` it is `true` (measured). |
| The debugging banner ([screenshot](2026-11-03-chrome-vs-chrome-beta/debugging-banner.png)) | the page shrinks by 56 px (`innerHeight` 973 to 917) at attach, in stable and Beta | `chrome.debugger.attach` without `--silent-debugger-extension-api` | Start Chrome with `--silent-debugger-extension-api`: no banner, no resize (measured in all three). |
| Mouse pressure | `pointerdown` with `pressure` 0 and `buttons` 1; a real mouse gives 0.5 | CDP `Input.dispatchMouseEvent` without `force` | Send `force: 0.5` on the press (measured: then `pressure` is 0.5). |
| `Runtime.enable` | `console.debug` of a 2 MB string takes 41.6–49.5 ms while the Runtime domain is on, against 19.6–31.9 ms before the attach (the final run: 16 and 24 samples over the driven runs; the first full run gave up to 58.5 ms) | the inspector copies console arguments while the Runtime domain is on | Never enable the Runtime domain; evaluate in an isolated world, as agent-browser does today. The older `Error.stack` getter trap stayed silent in all three browsers. |
| Hidden-tab timers | a 50 ms timer in a hidden tab keeps 50 ms; in plain Chrome it slows to about 1000 ms | agent-browser's `--disable-background-timer-throttling` (with `--disable-renderer-backgrounding` and `--disable-backgrounding-occluded-windows`) | Drop the three flags, or accept the signal. Without them a hidden tab of the agent also runs slowly. The plain-flag value comes from a run with no extension; a run without the flags and with `chrome.debugger` attached was not made. |
| Focus and visibility | under Xvfb the agent's window always had the focus (`document.hasFocus()` true) | — | On the Mac the agent window usually sits behind the operator's windows (`src/agent.ts`): then a page can see no focus while it gets input, and without `--disable-backgrounding-occluded-windows` also `visibilityState` hidden. Not measured: the Mac's check 9. |
| The rhythm of input | the stand-in sends one `mouseMoved` and then the press at the same point, and keys 40 ms apart | the stand-in's own simple input | Use paths and timings like a person's (agent-browser's `record` uses ghost-cursor paths). Not measured as a detection here. |
| Key events | the same fields as real keys (`key`, `code`, `keyCode`, `charCode`, `isTrusted`) | — | — |
| Mouse position | `screenX`/`screenY` match the window position, as for real input | — | — |
| The extension | no web-accessible resource (`fetch` of its manifest fails), no `chrome.runtime` on the page | the receiver has no content script and no `externally_connectable` | Keep it so. |
| An isolated world | nothing: `Page.createIsolatedWorld` and `Runtime.evaluate` in it tripped no trap | — | — |

Two more signals come from ab-v16.1's own probe (branch `ab-v16.1-design-the-two-modes-and-how-agent-mode`,
`docs/superpowers/specs/2026-11-03-two-modes-probe/results/summary.md`, "Navigation headers"); this
probe did not measure them:

- `Page.navigate` through `chrome.debugger` sends `Sec-Fetch-Site: cross-site`, also when it names
  the `typed` or `address_bar` transition. A URL that a person types sends the value `none`. A
  `declarativeNetRequest` rule for the extension's own navigations gives `none`, and so does
  `chrome.tabs.create`; `chrome.tabs.update` gives `cross-site`.
- Playwright's `addInitScript`, `exposeFunction` and tracing snapshots put `__playwright__binding__`
  and related names on the page's `window`. Plain `goto`, `click`, `type` and `screenshot` add none.

agent-browser's `outline` also writes a `data-agent-browser-idx` attribute into the page's DOM
(`README.md`, "Isolated world"). A page script can see that attribute.

## 4. Every prompt each browser shows

Here a prompt is anything that Chrome shows and that a person could have to answer or close: a
dialog, a bar or a toolbar chip.

| Prompt | Chrome stable 156 | Chrome Beta 158 | When, and how often | How to avoid it |
| --- | --- | --- | --- | --- |
| "Allow remote debugging?" with Cancel focused ([screenshot](2026-11-03-chrome-vs-chrome-beta/allow-remote-debugging.png)) | yes | yes | at each new DevTools connection, on the chrome://inspect path that agent-browser uses today | Drive through the extension: `chrome.debugger` raises no such prompt. |
| `"<extension>" started debugging this browser` with Cancel ([screenshot](2026-11-03-chrome-vs-chrome-beta/debugging-banner.png)) | yes | yes | at each `chrome.debugger.attach` | `--silent-debugger-extension-api` |
| "You are using an unsupported command-line flag" bar ([screenshot](2026-11-03-chrome-vs-chrome-beta/unsupported-flag-bar.png)) | yes | yes | at start, for `--ignore-certificate-errors-spki-list` (the probe's TLS run only) | Do not use the flag. `--silent-debugger-extension-api` and `--enable-unsafe-extension-debugging` showed no bar. |
| "Sign in to Chrome?" chip in the toolbar | yes | yes | on a new profile; later starts show only the avatar. Not modal, and a page cannot see it | — |
| Developer mode switch and the folder dialog of "Load unpacked" | yes | yes | once per profile, by a person | on Linux, the external extensions file (section 5) |
| The external extension's confirmation dialog | none on Linux | none on Linux | macOS and Windows: once, to enable an extension from the external file (Google's documentation; not measured) | an enterprise policy (MDM) |
| A bar or bubble about developer-mode or external extensions at start | none | none | measured on Linux after relaunches | — (the Mac: check 2) |
| "Chrome is being controlled by automated test software" | no | no | only with `--enable-automation`, which agent-browser refuses | — |
| First-run, default-browser and keyring dialogs | none | none | `--no-first-run` and `--no-default-browser-check`; no keyring on taylor | — |
| "Restore pages?" after Chrome did not exit cleanly | not measured | not measured | after a crash or a kill | quit Chrome cleanly |

With the network blocked, no ad-privacy notice or search-engine choice appeared. With a network,
Chrome can show them on a new profile (the Mac: check 7). On the Mac, the agent-browser code notes
one more prompt for Beta: macOS asks once to let Chrome Beta use the "Chrome Safe Storage" keychain
item (`src/agent.ts`). macOS can also ask a new app for the Local Network permission; not measured.

So with the extension path, an agent browser on Linux can run with **no prompt at all** (measured):
install the receiver through the external extensions file, start Chrome with
`--silent-debugger-extension-api`, and drive through `chrome.debugger`. On the Mac the same is
expected for the run itself if the Mac's checks 2 and 4 pass, and the install then needs one step
per profile (section 5), unless an MDM policy installs the receiver.

## 5. How each browser loads the extension

| Path | Chrome stable 156 | Chrome Beta 158 | Chromium 156 |
| --- | --- | --- | --- |
| `--load-extension=<folder>` | ignored | ignored | loads (location 8, command line) |
| the same with `--disable-features=DisableLoadExtensionCommandLineSwitch` | ignored | ignored | loads |
| CDP `Extensions.loadUnpacked` (needs `--remote-debugging-pipe` and `--enable-unsafe-extension-debugging`) | loads for that session only; the next start removes it, also with developer mode on | the same | the same |
| "Load unpacked", developer mode on | loads, and stays across relaunches and across a start of the same profile under the 158 binary (as an update does) | loads at start an extension that stable installed (the `update` run; the probe could not click Beta's dialog) | (the probe could not click the dialog) |
| then developer mode off | disabled at once (reason code 16777216, that is 1 << 24), also after a relaunch | the same: Beta 158 disabled it too (the `update-devmode-off` runs; the appendix lists them under stable, because they used stable's profile) | — |
| external extensions file `<id>.json` with `external_crx` | loads at the first start and after a relaunch; location 2, installType `sideload`, no developer mode, no prompt | the same | not measured (Debian reads a system folder) |
| `--policy='{"ExtensionInstallForcelist": [...]}'` | ignored: no update check | ignored | not measured |

What each path needs, per OS:

- **External extensions file (recommended).** Chrome reads `<id>.json` at its start. The JSON names
  a CRX: `{"external_crx": "/abs/path/receiver.crx", "external_version": "0.1.0"}`. Chrome packs the
  CRX itself: `chrome --pack-extension=<receiver folder>` writes `<folder>.crx` and a `.pem` key. The
  extension ID comes from the key, so agentwatch keeps the key to keep the ID.
  - Linux: the folder is `<Chrome's folder>/extensions`. For a system install that is
    `/opt/google/chrome/extensions` (Beta: `/opt/google/chrome-beta/extensions`), owned by root: one
    system change, done once by the operator. Google's documentation also names
    `/usr/share/google-chrome/extensions/`. For a Chrome that agentwatch unpacks into its own
    folder, as this probe did, it needs no system change. The file applies to every profile of
    that Chrome installation, so on a box with a system Chrome it also installs the receiver into a
    person's own profile there. Google's documentation agrees: on Linux the file can name a local
    CRX, and "Linux users won't be prompted to enable the extension".
  - macOS: Google's documentation names `~/Library/Application Support/Google/Chrome/External
    Extensions/` (one user) and `/Library/Application Support/Google/Chrome/External Extensions/`
    (all users). There the update URL "must point to the Chrome Web Store", so the receiver must be a
    store item, and the user must enable it once in a confirmation dialog. The folder also applies
    to the operator's own Chrome. Not measured: the Mac, check 3.
- **"Load unpacked" by a person.** Once per agent profile: chrome://extensions, developer mode on,
  "Load unpacked", pick the receiver folder. Developer mode must stay on. It works on both OSes. It
  is one prompt per profile, and the folder must stay where it is.
- **Enterprise policy `ExtensionInstallForcelist`.** It needs a system policy: on Linux a JSON file
  in `/etc/opt/chrome/policies/managed/` (root), on macOS a managed profile (MDM). The entry is
  `<id>;<update URL>`, and the update URL serves an update manifest that points at the CRX, for
  example from the agentwatch daemon. The command-line `--policy` switch does not replace it (both
  channels ignored it). Chrome shows that a policy manages it ("Managed by your organization" in its
  menu); a page does not see that. Not measured, because it needs a system change. The policy's definition in Chromium
  (`components/policy/resources/templates/policy_definitions/Extensions/ExtensionInstallForcelist.yaml`)
  says that on macOS an extension from outside the Chrome Web Store "can only be force installed if
  the instance is managed via MDM, joined to a domain via MCX or enrolled in Chrome Enterprise
  Core".
- **Chrome Web Store (unlisted).** One click on "Add to Chrome" per profile; updates come from the
  store. Not measured.

## 6. What the beam carries, and what it cannot

No beam ran in this probe. The sender and the receiver read and write through Chrome's extension
APIs, and these APIs are the same in stable and Beta, so the channel is not expected to change what
the beam carries. The table takes the chrome-extension repository's `README.md` ("What it reads",
"What is not moved", "Limits"); the rows marked * are this report's own additions, not measured:

| Carried | Not carried |
| --- | --- |
| every cookie of the domain and its subdomains, also `httpOnly`, `SameSite`, partitioned | service workers (the site registers them again on its next visit) |
| localStorage and sessionStorage of the tab's origin | page storage of other origins and other subdomains of the site |
| every IndexedDB database of the origin, with typed values | third-party (partitioned) storage of embedded frames |
| Cache Storage (not opaque entries) | values that the codec cannot carry, for example a `CryptoKey` |
| | device-bound sign-ins (for example device-bound session credentials) |
| | session cookies after an agent Chrome restart |
| | * passkeys and client certificates: their keys stay on the operator's device |
| | * the machine (section 2.2) and the IP address |

Device Bound Session Credentials: the probe sent a registration header
(`Sec-Session-Registration` and `Secure-Session-Registration`) on its TLS page. No browser on
taylor answered it. Whether the operator's Chrome on the Mac answers is the Mac's check 8. Where a
site binds a session to such a key, the beamed cookie stops working when it expires, in either
channel.

A version difference also matters for the beam: a site that stores the browser's version with a
session sees the beamed session come back from Chrome 158 (Beta) while the operator's Chrome still
sends 156.

## 7. The cost of each

| | Chrome stable as the agent browser | Chrome Beta as the agent browser |
| --- | --- | --- |
| On the Mac | a second instance of the operator's own `Google Chrome.app` with its own profile. The Dock icon, Cmd-Tab and `open -a "Google Chrome"` can bring the agent's window forward instead of the operator's (`src/agent.ts`). | its own app with its own Dock icon. macOS asks once to let it use the "Chrome Safe Storage" keychain item (`src/agent.ts`). |
| Version | the operator's version, from the same app and updater. A running Chrome keeps its old version until it restarts (Chrome's "Relaunch to update"; not measured here, the Mac's check 6), so agentwatch must restart the agent Chrome when the app's version changes. | usually one or two majors ahead of the operator (equal on 3 of the 172 days) |
| Field trials | stable's seed | Beta's seed, with more experiments |
| On Linux | no auto-update for a Chrome that agentwatch unpacks; agentwatch must fetch each new stable `.deb`. A system install updates through apt. | the same, on a weekly cycle |
| Profile separation | `--user-data-dir`, the same in both | the same |
| The extension | the same paths (section 5) | the same paths |

## 8. Checks that only the Mac can run

Run the probe on the Mac with no `--browser`: it takes Google Chrome and Google Chrome Beta from
`/Applications`. It opens visible Chrome windows, so run it when the operator does not use the Mac.
Screenshots need the Screen Recording permission. In the `ui-install` runs a person picks the
folder that the log names in Chrome's dialog. On macOS the probe's browsers run with
`--use-mock-keychain`, so they never ask for, or read, the login keychain's "Chrome Safe Storage";
so the probe does not show Beta's keychain prompt. The real-input parts of the `site` and
`site-plain` runs are Linux-only, so their rows stay empty on the Mac.

```sh
node test/live/parity/probe.ts --out <dir>
node test/live/parity/probe.ts --out <dir> --serve operator     # then open the two URLs it prints in the operator's own Chrome
node test/live/parity/compare.ts <dir> > <dir>/report.md
```

`--serve` records the operator's own Chrome, with its own profile and field trials, as one more
column. It needs the operator's consent: the page reads only properties of the browser and the
machine, and sends them only to the probe server on 127.0.0.1. The TLS page shows a certificate
warning (Advanced, then Proceed).

1. `--load-extension` and the CDP install on macOS: the same as on Linux?
2. "Load unpacked" on macOS stable and Beta: does it stay across a relaunch, and does Chrome show a
   developer-mode warning at start?
3. The external extensions file on macOS: Google documents only a Web Store update URL there and a
   confirmation dialog. Does Chrome refuse a local `external_crx`? Use a test macOS user, because
   the per-user folder also applies to the operator's own Chrome. The probe's `--external-dir`
   takes the folder.
4. `--silent-debugger-extension-api` on macOS: no banner and no resize?
5. Parity on one Mac: the `--serve operator` column (the operator's own Chrome) against the probe's
   `stable` column (a new profile of the same app), and Beta against stable. Expected: identical
   except the window, the profile's state and some field-trial features.
6. Two instances of `Google Chrome.app`: the Dock, Cmd-Tab and the Google updater with a running
   agent instance.
7. First-run notices with a network: the ad-privacy notice and the search-engine choice on a new
   profile.
8. Device Bound Session Credentials: does the operator's Chrome answer the probe's registration
   header on the TLS page (`--serve`; a `dbsc` record)?
9. Focus and visibility of an agent window behind the operator's windows, with and without
   `--disable-backgrounding-occluded-windows`, while the agent drives it.

## 9. Recommendation and reasons

Use **Google Chrome stable** for the agent browser, at the operator's version:

- Same identity: the version, the brands, the features and the network fingerprints are the
  operator's own. Beta differs in the version, the brands and the features; the version and the
  brands show in the first request.
- Same extension paths: the channel adds nothing for the extension. Beta has no path that stable
  lacks.
- No second channel to track. On the Mac the agent browser uses the operator's own app, so it has
  the operator's version after each restart.

And, for either channel:

- Run the agent browser on the operator's kind of machine when parity matters. A Linux box cannot
  look like the operator's Mac.
- Install the receiver on Linux through the external extensions file with a packed CRX. On the Mac,
  use "Load unpacked" once per agent profile with developer mode on, if the Mac's check 2 passes,
  until the operator chooses a store item or an MDM policy. Keep the `--load-extension` start only
  for Chromium.
- Start Chrome with `--silent-debugger-extension-api`, drive through `chrome.debugger`, never enable
  the Runtime domain, send mouse presses with `force: 0.5`, and set `Sec-Fetch-Site` for the
  agent's navigations.
- Reconsider the three background flags of `AGENT_ARGS`: they make hidden-tab timers a visible
  signal.

## 10. Open questions for the operator

1. Where does the agent browser run when a site must not tell it from your Chrome: on your Mac (or a
   Mac like it), or on a box such as taylor? On a Linux box a site sees Linux, no GPU and another IP
   address, in either channel.
2. How does the receiver get into the agent's Chrome? (a) On Linux, the external extensions file:
   no prompt; with a system Chrome it needs one root step, and it then installs the receiver into
   every profile of that Chrome on the box. (b) "Load unpacked" by you, once per agent
   profile, with developer mode on (both OSes). (c) An enterprise policy: root on Linux, MDM on the
   Mac. (d) An unlisted Chrome Web Store item: one click per profile, or on the Mac the external
   file plus one confirmation.
3. On the Mac, is a second instance of your own `Google Chrome.app` acceptable (the Dock and Cmd-Tab
   behaviour in section 7)? Beta avoids that, at the cost of a different identity.
4. Drop agent-browser's three background flags (no timer signal, but slow hidden tabs), or keep them?

## Appendix: the probe's tables

The output of `compare.ts` for the final run on taylor, 2026-11-03 17:30 to 17:47 UTC, with worker
folder paths shortened. The screenshots stay in the run folder, except the three in
[`2026-11-03-chrome-vs-chrome-beta/`](2026-11-03-chrome-vs-chrome-beta/). Two earlier full runs
(16:20 and 16:45 UTC) gave the same identity and feature tables.

Platform linux, started 2026-11-03T17:30:45.676Z.

- **stable**: Google Chrome 156.0.8078.79 (`<worker folder>/chrome-stable/opt/google/chrome/google-chrome`)
- **beta**: Google Chrome 158.0.8127.2 beta (`<worker folder>/chrome-beta/opt/google/chrome-beta/google-chrome-beta`)
- **chromium**: Chromium 156.0.8078.73 built on Debian GNU/Linux 13 (trixie) (`/usr/bin/chromium`)

### Identity: what a site reads (plain agent flags, fresh profile)

| | stable | beta | chromium |
| --- | --- | --- | --- |
| User-Agent header | Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 | Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36 | Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 |
| Sec-CH-UA | "Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156" | "Chromium";v="158", "Not.A/Brand";v="24", "Google Chrome";v="158" | "Not:A-Brand";v="8", "Chromium";v="156" |
| Sec-CH-UA-Full-Version-List (after Accept-CH) | "Not:A-Brand";v="8.0.0.0", "Chromium";v="156.0.8078.79", "Google Chrome";v="156.0.8078.79" | "Chromium";v="158.0.8127.2", "Not.A/Brand";v="24.0.0.0", "Google Chrome";v="158.0.8127.2" | "Not:A-Brand";v="8.0.0.0", "Chromium";v="156.0.8078.73" |
| Sec-CH-UA-Platform | "Linux" | "Linux" | "Linux" |
| Accept-Language | en-US,en;q=0.9 | en-US,en;q=0.9 | en-US,en;q=0.9 |
| Accept (navigation) | text/html,application/xhtml+xml,application/xml;q=0.9,image/jxl,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7 | text/html,application/xhtml+xml,application/xml;q=0.9,image/jxl,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7 | text/html,application/xhtml+xml,application/xml;q=0.9,image/jxl,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7 |
| header order (first page request) | host,connection,sec-ch-ua,sec-ch-ua-mobile,sec-ch-ua-platform,upgrade-insecure-requests,user-agent,accept,sec-fetch-site,sec-fetch-mode,sec-fetch-user,sec-fetch-dest,accept-encoding,accept-language | host,connection,sec-ch-ua,sec-ch-ua-mobile,sec-ch-ua-platform,upgrade-insecure-requests,user-agent,accept,sec-fetch-site,sec-fetch-mode,sec-fetch-user,sec-fetch-dest,accept-encoding,accept-language | host,connection,sec-ch-ua,sec-ch-ua-mobile,sec-ch-ua-platform,upgrade-insecure-requests,user-agent,accept,sec-fetch-site,sec-fetch-mode,sec-fetch-user,sec-fetch-dest,accept-encoding,accept-language |
| userAgentData.brands | Not:A-Brand 8, Chromium 156, Google Chrome 156 | Chromium 158, Not.A/Brand 24, Google Chrome 158 | Not:A-Brand 8, Chromium 156 |
| uaFullVersion | 156.0.8078.79 | 158.0.8127.2 | 156.0.8078.73 |
| platform / platformVersion | Linux  | Linux  | Linux  |
| navigator.webdriver | false | false | false |
| navigator.plugins | 5 | 5 | 5 |
| window.chrome keys | app,csi,loadTimes | app,csi,loadTimes | app,csi,loadTimes |
| languages | en-US,en | en-US,en | en-US,en |
| time zone | America/New_York | America/New_York | America/New_York |
| hardwareConcurrency / deviceMemory | 32 / 32 | 32 / 32 | 32 / 32 |
| screen / window | 1920x1080 dpr 1 / 945x1060 | 1920x1080 dpr 1 / 945x1060 | 1920x1080 dpr 1 / 945x1060 |
| fonts found (of 65) | 14 | 14 | 14 |
| canvas hash | e443888765e62ce8 | e443888765e62ce8 | e443888765e62ce8 |
| audio sum | 172.67164876164316 | 172.67164876164316 | 172.67164876164316 |
| WebGL renderer | null | null | null |
| WebGPU | API present, no adapter | API present, no adapter | API present, no adapter |
| speech voices | 19 | 19 | 0 |
| Widevine (EME) | true | true | {"error":"NotSupportedError: Unsupported keySystem or supportedConfigurations."} |
| H.264 / HEVC / AV1 canPlayType | probably / no / probably | probably / no / probably | probably / no / probably |
| storage quota (bytes) | 10737418240 | 10737418240 | 10737418240 |
| window globals | 1226 | 1229 | 1226 |
| CSS properties | 479 | 480 | 479 |
| hash: globals / CSS / prototypes | 115e73eccc28a152 / 022e05acbe3ae6d0 / 42434f7b2bfc8411 | 4b448994afff23bf / 93570e22b4007500 / a7605eca19450156 | 115e73eccc28a152 / 022e05acbe3ae6d0 / 42434f7b2bfc8411 |
| JA4 (full handshake) | t13d1517h2_8daaf6152771_cb7bf5808d99 | t13d1517h2_8daaf6152771_cb7bf5808d99 | t13d1517h2_8daaf6152771_cb7bf5808d99 |
| JA4 (resumed, with PSK) | t13d1518h2_8daaf6152771_e2d80978ab2e | t13d1518h2_8daaf6152771_e2d80978ab2e | t13d1518h2_8daaf6152771_e2d80978ab2e |
| TLS groups / key shares | grease,11ec,001d,0017,0018 / grease,11ec,001d | grease,11ec,001d,0017,0018 / grease,11ec,001d | grease,11ec,001d,0017,0018 / grease,11ec,001d |
| TLS extensions (sorted) | 0000,0005,000a,000b,000d,0010,0012,0017,001b,0023,002b,002d,0033,44cd,ca34,fe0d,ff01 | 0000,0005,000a,000b,000d,0010,0012,0017,001b,0023,002b,002d,0033,44cd,ca34,fe0d,ff01 | 0000,0005,000a,000b,000d,0010,0012,0017,001b,0023,002b,002d,0033,44cd,ca34,fe0d,ff01 |
| ALPS / ECH GREASE | h2 / true | h2 / true | h2 / true |
| Akamai HTTP/2 | 1:65536;2:0;4:6291456;6:262144\|15663105\|0\|m,a,s,p | 1:65536;2:0;4:6291456;6:262144\|15663105\|0\|m,a,s,p | 1:65536;2:0;4:6291456;6:262144\|15663105\|0\|m,a,s,p |
| HTTP/2 first HEADERS priority | {"stream":1,"flags":37,"exclusive":true,"dependsOn":0,"weight":256} | {"stream":1,"flags":37,"exclusive":true,"dependsOn":0,"weight":256} | {"stream":1,"flags":37,"exclusive":true,"dependsOn":0,"weight":256} |
| DBSC registration call | none | none | none |

### Features of one version only (window globals, prototypes, CSS properties)

#### stable vs beta

- globals: only in stable: XSLTProcessor; only in beta: CanvasPaintEvent, ElementGeometryUpdateEvent, ElementImage, TrustedHTMLParserOptions
- CSS: only in stable: none; only in beta: text-decoration-inset
- Navigator.prototype: only in stable: adAuctionComponents, canLoadAdAuctionFencedFrame, clearOriginJoinedAdInterestGroups, createAuctionNonce, deprecatedReplaceInURN, deprecatedRunAdAuctionEnforcesKAnonymity, deprecatedURNToURL, getInterestGroupAdAuctionData, joinAdInterestGroup, leaveAdInterestGroup, protectedAudience, runAdAuction, updateAdInterestGroups; only in beta: none
- Element.prototype: only in stable: none; only in beta: afterHTML, afterHTMLUnsafe, appendHTML, appendHTMLUnsafe, beforeHTML, beforeHTMLUnsafe, prependHTML, prependHTMLUnsafe, replaceWithHTML, replaceWithHTMLUnsafe, streamAfterHTML, streamAfterHTMLUnsafe, streamAppendHTML, streamAppendHTMLUnsafe, streamBeforeHTML, streamBeforeHTMLUnsafe, streamHTML, streamHTMLUnsafe, streamPrependHTML, streamPrependHTMLUnsafe, streamReplaceWithHTML, streamReplaceWithHTMLUnsafe

#### stable vs chromium

- no difference

#### beta vs chromium

- globals: only in beta: CanvasPaintEvent, ElementGeometryUpdateEvent, ElementImage, TrustedHTMLParserOptions; only in chromium: XSLTProcessor
- CSS: only in beta: text-decoration-inset; only in chromium: none
- Navigator.prototype: only in beta: none; only in chromium: adAuctionComponents, canLoadAdAuctionFencedFrame, clearOriginJoinedAdInterestGroups, createAuctionNonce, deprecatedReplaceInURN, deprecatedRunAdAuctionEnforcesKAnonymity, deprecatedURNToURL, getInterestGroupAdAuctionData, joinAdInterestGroup, leaveAdInterestGroup, protectedAudience, runAdAuction, updateAdInterestGroups
- Element.prototype: only in beta: afterHTML, afterHTMLUnsafe, appendHTML, appendHTMLUnsafe, beforeHTML, beforeHTMLUnsafe, prependHTML, prependHTMLUnsafe, replaceWithHTML, replaceWithHTMLUnsafe, streamAfterHTML, streamAfterHTMLUnsafe, streamAppendHTML, streamAppendHTMLUnsafe, streamBeforeHTML, streamBeforeHTMLUnsafe, streamHTML, streamHTMLUnsafe, streamPrependHTML, streamPrependHTMLUnsafe, streamReplaceWithHTML, streamReplaceWithHTMLUnsafe; only in chromium: none


### Loading the extension: did its service worker start? (and the profile afterwards)

| | stable | beta | chromium |
| --- | --- | --- | --- |
| cmdline-ext | not loaded; not in prefs; developer mode false | not loaded; not in prefs; developer mode false | **loaded**; in prefs (location 8); developer mode false |
| cmdline-ext-feature | not loaded; not in prefs; developer mode false | not loaded; not in prefs; developer mode false | **loaded**; in prefs (location 8); developer mode false |
| cdp-install | **loaded**; in prefs (location 4); developer mode false | **loaded**; in prefs (location 4); developer mode false | **loaded**; in prefs (location 4); developer mode false |
| relaunch-cdp-flag | not loaded; not in prefs; developer mode false | not loaded; not in prefs; developer mode false | not loaded; not in prefs; developer mode false |
| relaunch-cdp | not loaded; not in prefs; developer mode false | not loaded; not in prefs; developer mode false | not loaded; not in prefs; developer mode false |
| cdp-install-devmode | **loaded**; in prefs (location 4); developer mode true | **loaded**; in prefs (location 4); developer mode true | **loaded**; in prefs (location 4); developer mode true |
| relaunch-cdp-devmode | not loaded; not in prefs; developer mode true | not loaded; not in prefs; developer mode true | not loaded; not in prefs; developer mode true |
| ui-install | **loaded**; in prefs (location 4); developer mode true | not loaded; not in prefs; developer mode true | not loaded; not in prefs; developer mode true |
| relaunch-silent | **loaded**; in prefs (location 4); developer mode true | not loaded; not in prefs; developer mode true | not loaded; not in prefs; developer mode true |
| relaunch-banner | **loaded**; in prefs (location 4); developer mode true | not loaded; not in prefs; developer mode true | not loaded; not in prefs; developer mode true |
| update | **loaded**; in prefs (location 4); developer mode true | – | – |
| update-devmode-off | **loaded**; in prefs (location 4, disabled 16777216); developer mode false | – | – |
| update-devmode-off-relaunch | not loaded; in prefs (location 4, disabled 16777216); developer mode false | – | – |
| ui-install-2 | **loaded**; in prefs (location 4); developer mode true | not loaded; not in prefs; developer mode true | not loaded; not in prefs; developer mode true |
| devmode-off | **loaded**; in prefs (location 4, disabled 16777216); developer mode false | not loaded; not in prefs; developer mode false | not loaded; not in prefs; developer mode false |
| devmode-off-relaunch | not loaded; in prefs (location 4, disabled 16777216); developer mode false | not loaded; not in prefs; developer mode false | not loaded; not in prefs; developer mode false |
| external-crx | **loaded**; in prefs (location 2); developer mode false | **loaded**; in prefs (location 2); developer mode false | – |
| external-crx-relaunch | **loaded**; in prefs (location 2); developer mode false | **loaded**; in prefs (location 2); developer mode false | – |
| external-crx-banner | **loaded**; in prefs (location 2); developer mode false | **loaded**; in prefs (location 2); developer mode false | – |

The update rows of stable ran beta (a newer browser of the same product) on stable's "Load unpacked" profile.

### While the agent drives through chrome.debugger (relaunch-silent; Chromium: cmdline-ext)

| | stable | beta | chromium |
| --- | --- | --- | --- |
| extension installType | development | sideload | development |
| page can fetch the extension's manifest / chrome.runtime on page | TypeError: Failed to fetch / undefined | TypeError: Failed to fetch / undefined | TypeError: Failed to fetch / undefined |
| navigator.webdriver while attached | false | false | false |
| the run | stable/relaunch-silent (this browser) | beta/external-crx-relaunch (this browser) | chromium/cmdline-ext (this browser) |
| page resize at attach (silent flag) | none | none | none |
| page resize at attach (no silent flag) | 973 -> 917 | 973 -> 917 | – |
| Error.stack trap after Runtime.enable | silent | silent | silent |
| console.debug(2 MB) ms: before / Runtime on / after | 20.3 / 43.4 / 21 | 21.4 / 46.4 / 20.5 | 19.3 / 43.5 / 19.1 |
| CDP click: pointerdown | pressure 0, width 1, screenY-clientY 97 | pressure 0, width 1, screenY-clientY 97 | pressure 0, width 1, screenY-clientY 97 |
| CDP click with force 0.5: pointerdown | pressure 0.5, width 1, screenY-clientY 97 | pressure 0.5, width 1, screenY-clientY 97 | pressure 0.5, width 1, screenY-clientY 97 |
| real click (xdotool, site run): pointerdown | pressure 0.5, width 1, screenY-clientY 97 | pressure 0.5, width 1, screenY-clientY 97 | pressure 0.5, width 1, screenY-clientY 97 |
| CDP keys | keydown key=a code=KeyA keyCode=65 charCode=0; keypress key=a code=KeyA keyCode=97 charCode=97 | keydown key=a code=KeyA keyCode=65 charCode=0; keypress key=a code=KeyA keyCode=97 charCode=97 | keydown key=a code=KeyA keyCode=65 charCode=0; keypress key=a code=KeyA keyCode=97 charCode=97 |
| real keys (xdotool, site run) | keydown key=a code=KeyA keyCode=65 charCode=0; keypress key=a code=KeyA keyCode=97 charCode=97 | keydown key=a code=KeyA keyCode=65 charCode=0; keypress key=a code=KeyA keyCode=97 charCode=97 | keydown key=a code=KeyA keyCode=65 charCode=0; keypress key=a code=KeyA keyCode=97 charCode=97 |
| hidden tab timers, agent flags (extension's new tab) | median 50 ms, max 104 ms (119 ticks in 6024 ms; 50 ms asked) | median 50 ms, max 92 ms (121 ticks in 6025 ms; 50 ms asked) | median 50 ms, max 91 ms (121 ticks in 6029 ms; 50 ms asked) |
| hidden tab timers, agent flags (real Ctrl+T) | median 50 ms, max 86 ms (120 ticks in 6016 ms; 50 ms asked) | median 50 ms, max 91 ms (121 ticks in 6024 ms; 50 ms asked) | median 50 ms, max 88 ms (121 ticks in 6032 ms; 50 ms asked) |
| hidden tab timers, plain flags (real Ctrl+T) | median 1000 ms, max 1000 ms (6 ticks in 6021 ms; 50 ms asked) | median 1000 ms, max 1000 ms (6 ticks in 6025 ms; 50 ms asked) | median 1000 ms, max 1000 ms (6 ticks in 6036 ms; 50 ms asked) |


### Outside hosts each browser tried at start (all refused by the probe's proxy; site-plain run)

- **stable**: accounts.google.com, clients2.google.com, clientservices.googleapis.com, content-autofill.googleapis.com, optimizationguide-pa.googleapis.com, redirector.gvt1.com, update.googleapis.com, www.google.com, www.gstatic.com
- **beta**: accounts.google.com, clients2.google.com, clientservices.googleapis.com, content-autofill.googleapis.com, optimizationguide-pa.googleapis.com, redirector.gvt1.com, update.googleapis.com, www.google.com, www.gstatic.com
- **chromium**: accounts.google.com, clients2.google.com, content-autofill.googleapis.com, optimizationguide-pa.googleapis.com, redirector.gvt1.com, start.duckduckgo.com, update.googleapis.com
