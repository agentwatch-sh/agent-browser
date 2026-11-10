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
| Profile 3 disk (saving, leak check and autofill off, the act only) | no file held the password or the username; Chromium kept the two preferences as the probe wrote them |

Not probed: the act through `chrome.debugger` (the receiver) instead of a CDP pipe; Chrome stable; a saved password
in Chrome's own password manager (the probe never clicked a save prompt); a site's service worker; the Mac.

A separate check, with no browser: Node v26.12.0 started with `--disable-sigusr1` kept running when it got
`SIGUSR1`. Each process was the check's own and was stopped by its pid.
