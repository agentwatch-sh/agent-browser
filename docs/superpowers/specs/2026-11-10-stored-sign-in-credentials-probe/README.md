# The probe of the stored sign-in credentials design

The evidence of
[2026-11-10-stored-sign-in-credentials-design.md](../2026-11-10-stored-sign-in-credentials-design.md) (board
task ab-v16.95). Not part of `npm test`, and not product code.

Run on taylor on 2026-11-10 (UTC): Debian 13, Linux 6.12.115, Node v26.12.0, Debian Chromium 156.0.8078.79
(`/usr/bin/chromium`), a private Xvfb on display 175 (its own X authority file, no window manager). The run held
the box's shared heavy-job lock and the repository's harness guard (`test/live/guard.ts`). Nothing ran on the Mac.
No page of the network was reachable: the host resolver maps every host to nothing except `login.localhost` and
`tracker.localhost`, and the proxy is a closed local port. No package was installed.

## What it does

`probe.ts` makes its own fake username, fake password and fake wrong password at its start. It never prints them:
it prints booleans, counts and file names only. It serves a local sign-in site on `login.localhost` (a form that
posts, a form that echoes the posted values after a failure, a form whose script copies each value into the
`value` attribute, a sign-in by `fetch` in one document, a page with `Cache-Control: no-store`, and a page whose
script sends the values to `tracker.localhost` at the submit). It starts Chromium with `--remote-debugging-pipe`
(no port) and `--password-store=basic` on a temp profile, and speaks CDP over the pipe with a small client of its
own.

Two CDP sessions attach to one tab: "S" types the values with `Input.dispatchKeyEvent` (as the design's act does),
and "G" plays the agent, with every read that a CDP client has. The cases:

- **C1**: after the fill, G reads the value with `Runtime.evaluate`, `DOM.getOuterHTML`, `DOMSnapshot`,
  `Accessibility.getFullAXTree`, a screenshot, and the submit's `Network.requestWillBeSent`.
- **C2**: G intercepts the submit with `Fetch.enable`, reads its body, and continues it to another host.
- **C3, C3b, C3c**: after the sign-in, G runs `history.back()`: with no other step, after
  `Page.resetNavigationHistory`, and for a page with `Cache-Control: no-store`.
- **C4**: a failed sign-in on a form that the server sends empty again, and on a form that echoes the values.
- **C5**: a sign-in by `fetch`: a failure, and a success in the same document.
- **C6**: a page script that copies the value into the `value` attribute.
- **C7**: scripts that G puts in first: a main-world listener, an isolated-world init script, and a window
  reference (G's page opened the sign-in page itself).
- **The act** (profiles 2 and 3): the design's sign-in act in a new tab that only S attaches, with the guard
  (`Fetch.enable` on every request; a request that holds the password in its URL, or a request to another origin
  whose body holds it or is not given, fails), the form checks, the fill, the submit, `Page.resetNavigationHistory`,
  the empty fields and the close. Then G's own tab loads a page of the site.
- **The disk**: after each profile's Chromium closes, the probe reads the profile's `Login Data` and `Web Data`
  (SQLite, read only) and searches every file of the profile for the fake values' plain bytes (also URL-encoded,
  JSON-escaped and base64). Profile 1 holds the threat cases with Chromium's defaults. Profile 2 holds only the act
  with Chromium's defaults. Profile 3 holds only the act, with password saving, the leak check and autofill off in
  the profile's `Preferences` before the start.

The probe stops its own processes by their pids, and it removes its own temp profiles and X authority file at its
end.

```
flock <the heavy lock> timeout 1500 node probe.ts --out-dir <dir> [--display 175]
```

## The results (`results/results.json`)

| Case | Result |
| --- | --- |
| C1 `Runtime.evaluate` of the field's value | the value |
| C1 `DOMSnapshot.captureSnapshot` | the value (in its strings) |
| C1 `DOM.getOuterHTML` of the field (no page script) | no value |
| C1 `Accessibility.getFullAXTree` | no value |
| C1 the submit's `Network.requestWillBeSent` | the value, in the event itself |
| C2 the agent's `Fetch.enable` on the submit | the body read, the request continued to another host, and that host got the value |
| C3 `history.back()` after the sign-in | the sign-in page came back from the back-forward cache, with the password in its field |
| C3b `Page.resetNavigationHistory`, then `history.back()` | the history length is 1; the tab stays on the signed-in page; no password field |
| C3c the same page with `Cache-Control: no-store` | not from the back-forward cache; no value |
| C4 a failed sign-in, a server form sent empty again | no value |
| C4 a failed sign-in, a server form that echoes the values | the value |
| C5 a sign-in by `fetch`: a failure; a success in the same document | the value in both (the form is hidden after the success) |
| C6 a page script that copies the value into the attribute | the value in `DOM.getOuterHTML` and in `DOM.attributeModified` |
| C7 a main-world listener; an isolated-world init script; a window reference | the value in all three |
| The act, profile 2 (the page's script sends the values to another host) | signed in; the form checks passed; 2 requests to the other host failed; that host got no value; 4 requests continued; 1.7 s with keys 8 ms apart; G's own tab then got the signed-in page |
| The act, profile 3 | signed in; 1.6 s |
| Profile 1 disk (defaults, all cases) | no file held the password; the username was in `Login Data` (not in its `logins` table), in 2 rows of `Web Data`'s `autofill` table, and in one HTTP cache file (the echo case) |
| Profile 2 disk (defaults, the act only) | no file held the password; the username was in `Login Data` (not in `logins`) and in 1 row of `Web Data`'s `autofill` table |
| Profile 3 disk (saving, leak check and autofill off, the act only) | no file held the password or the username. The probe wrote six preferences and read back only two of them (`credentials_enable_service` and `autofill.profile_enabled`); Chromium kept both. The round-1 probe below read back all six |

Not probed: the act through `chrome.debugger` (the receiver) instead of a CDP pipe; Chrome stable; a saved password
in Chrome's own password manager (the probe never clicked a save prompt); a site's service worker; the Mac.

A separate check, with no browser: board ab-v16.96 (hold SIGUSR1 at start; disable the inspector signal). Each
process was the check's own and was stopped by its pid.

A read, with no browser: `/proc/sys/kernel/yama/ptrace_scope` on taylor gave `1` (read again on 2026-11-10 in
fix round 1 of review-104; the design's section 5.5 rests on it).

This probe drove the act over a CDP pipe, not through the receiver's `chrome.debugger`. The hiding of the act tab
from clients is the model's code, so no probe measures it: the design calls it designed, not measured.

## Round 1 (fix round 1 of review-104): `probe-round1.ts`

Run on taylor on 2026-11-10 (UTC), with the same Chromium and Node, a private Xvfb on display 175 (its own X
authority, and its framebuffer in a file of the run folder with `-fbdir`, as agentwatch's live view reads it),
under the box's shared heavy-job lock and the harness guard. Fake values that the probe makes; it prints booleans,
counts, host names and error texts only. Local pages on `login.localhost` and `tracker.localhost` only. No package
was installed. The probe removes its own run folder (profile, extension, framebuffer, X authority) at its end.

The probe writes a small extension into its run folder and loads it with `--load-extension`. The extension plays
the receiver and uses only extension APIs: `chrome.debugger` (with the act's `Fetch` guard in its worker),
`chrome.windows`, `chrome.cookies` and `chrome.declarativeNetRequest`. The pipe plays the harness and the agent.
The profile's `Preferences` hold, before the start, the six preferences of the design's section 5.4 and the
extension's incognito allow (`extensions.settings.<id>.incognito: true`; the id is Chromium's id of the unpacked
path, which the probe computes and checks).

The cases:

- **E1**: what the extension's `chrome.debugger` may send on a tab: `Target.createBrowserContext`,
  `Browser.setWindowBounds`; and an incognito window from `windows.create`.
- **The agent's setup** in the default context: a page plants the agent's own sign-in page in Cache Storage for
  two sign-in paths, writes a `localStorage` marker, and registers a cache-first service worker of the site; a
  listener tab of the origin records each `BroadcastChannel` message and each `storage` event.
- **K1, the contrast**: a sign-in tab in the default context (the design before this round): which page it gets,
  and whether a typed contrast value reaches the listener tab; then the same with `Network.setBypassServiceWorker`.
- **The acts**, each in a new incognito window: "old" (the earlier `Fetch` guard alone), "main" (the isolation
  checks, the window cases, the block's rules A, B and C before the first key, the sign-in, the read for the move),
  and "flip" (a page that changes the password field's type after 3 keys, and opens a WebSocket at its load). The
  sign-in page is a sign-in by `fetch` that sets a cookie and keeps a token in `localStorage`. Its third-party
  script sends the field's value at each key through six channels: fetch, image (base64url in the URL), beacon,
  WebSocket, a dedicated worker's fetch, and a service worker's fetch. The tracker counts, for each channel, the
  requests, those with the whole password, and those with a part of 4 or more characters.
- **The window** (act "main"): the framebuffer's pixels of the act page's colour on the screen; `windows.update`
  wholly and more than half outside the screen; a minimized state; browser-level `Browser.setWindowBounds` (pipe
  only, for reference); `xdotool windowmove` outside the screen and back; the pointer moved past the screen's edge.
- **The move**: the act context's cookies (`cookies.getAll` with its store) and its `localStorage`, read before the
  close; then a stand-in of C6: `cookies.set` in the default store, and a tab of the origin writes the
  `localStorage` items. The agent's pages of the site before the act and after the move.
- **After the close**: the profile's `History` file (SQLite, read only), a scan of every profile file for the fake
  values (five forms), and the six preferences read back.

```
flock <the heavy lock> timeout 1500 node probe-round1.ts --out-dir <dir> [--display 175]
```

The results (`results/results-round1.json`; the fifth run, the first with every case complete: the runs before it
found two facts and two faults of the probe itself, an extension worker that did not come back after a toggle of
the allow, and a planted page whose `</script>` ended its own script):

| Case | Result |
| --- | --- |
| E1 `Target.createBrowserContext` by `chrome.debugger` | "Not allowed" |
| E1 `Browser.setWindowBounds` by `chrome.debugger` | "'Browser.setWindowBounds' wasn't found" |
| E1 incognito window, no allow (run 3) | `windows.create` gave the extension no window object |
| E1 incognito window, with the allow in `Preferences` | created; the extension saw its tab and attached it |
| K1 same context | the agent's service worker served the agent's page at the sign-in path; the listener tab got the typed contrast value by `BroadcastChannel` and by the `storage` event; with `Network.setBypassServiceWorker`, the agent's page was not served |
| Act "main", isolation | the agent's page not served; the agent's marker and Cache Storage not visible; no controlling worker; no broadcast and no `storage` event in the listener tab; the act's marker not in the default context; the act's target in another `browserContextId` |
| Each act's context | its cookie store empty at the start of each of the three acts; only the default store left after each close |
| Act "old" (the earlier guard alone) | signed in; the tracker got the whole password by the image (base64url), the service worker and the WebSocket, and parts of it (15 lengths, 4 to 18 characters) by all six channels; the guard failed 3 requests (the whole value in the fetch, the beacon and the dedicated worker's fetch); `Fetch` paused no WebSocket |
| Act "main" (rules A, B and C from the first key) | signed in; no request of any channel reached the tracker; 3 requests passed the `Fetch` guard (the site's own) |
| Act "flip" | the act saw the WebSocket of the page's load before the first key; the type watch saw the change after 3 of 19 keys, the field was empty, and the act stopped |
| The window | on the screen: 894,928 pixels of the act's colour; `windows.update` wholly outside and more than half outside: "Invalid value for bounds. Bounds must be at least 50% within visible screen space."; minimized: the state stayed "normal", 895,200 pixels; `Browser.setWindowBounds` (pipe) to x 1480: 0 pixels; back on the screen by `xdotool windowmove`: 895,200; outside the screen by `xdotool windowmove`: 0 pixels, and the extension saw left 1480; typed and signed in there: 0 pixels; moved back by an X client: 903,813; the pointer stopped at x 1279 |
| The move | 1 cookie and 2 `localStorage` items read; the agent's `/home` (cookie) and `/spa-home` (the token in `localStorage`) went from "not signed in" to "signed in" |
| `History` | 0 rows of the act's paths, 0 titles with the username, 1 row of the agent's own page |
| Profile files | no file held the password or the username; the contrast value was in `Default/Local Storage/leveldb/000003.log` (K1's agent page wrote it there: the scan's own check) |
| The six preferences read back | 5 kept as written; `autofill.enabled` was not in the file |
| Time | act "old" 5.6 s, "main" 11.0 s (with the window cases and the move's read), "flip" 4.5 s; keys 40 ms apart |

Not probed in round 1: the real receiver and its CRX in Chrome stable (the incognito allow there included), the
block's rules D and E, the leak check before the move, the fallback's freeze of client tabs, WebRTC, and the Mac.
