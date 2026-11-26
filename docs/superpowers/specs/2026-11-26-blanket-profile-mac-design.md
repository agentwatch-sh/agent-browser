# The blanket profile on the Mac (board ab-4wh.16)

This note is section 13 of the blanket profile design (`docs/superpowers/specs/2026-11-25-blanket-profile-design.md`)
in full; that design's section 13 gives its short form. A section number below 13 names a section of that design.

**Status: the design check of board ab-4wh.16 (part A), 2026-11-26.** No code yet. The contract texts of 13.9 merge
only after aw-lead's OK, and the build (part B) waits for the Mac measurements of 13.8. The Chromium facts were read
at Chromium main `c37b0690` (160.0.8186.0); the Mac runs Google Chrome 158, so M2 measures the facts that the design
depends on.

## 13.1 The answer in short

1. **A new folder per blanket scope, as on Linux.** Each blanket folder starts with a copy of two preference files of
   a **blanket template**: a profile that holds the operator's one "Load unpacked" of the receiver and nothing else.
   The template's set-up Chrome's proxy passes no request of a page, so the template holds no site data (13.3).
2. **No wipe.** The receiver's `chrome.browsingData` wipe of section 8 is not built: it misses some data, it leaves
   data on disk between sessions after a crash, and it puts a destructive op into the package that also runs in the
   shared profile (13.4). No receiver change and no receiver release.
3. **Its own Chrome process.** `open -n -g` of the operator's `Google Chrome.app`, as the Mac's agent Chrome, with
   `--user-data-dir=<state>/blanket/profile` and the address proxy's flags. The service checks that the process got
   the flags.
4. **The same address proxy.** On the Mac its peer check reads only the sockets of the blanket Chrome's own processes.
5. **One new op, `blanket_setup`,** for the operator's set-up of the template (the Browser pane's button), and one
   status key, `blanket_template`.

## 13.2 The blanket Chrome on the Mac

- **The start.** The same steps as the agent Chrome on the Mac (`src/service/unit/unit.ts`, `startMacChrome`):
  `open -n -g -a <app> --args --user-data-dir=<state>/blanket/profile`, `AGENT_ARGS`, `--silent-debugger-extension-api`,
  `--lang`, the window flags, then the address proxy's four flags, then the config's `chrome_args` (with the refusals
  of section 12), then `about:blank`. The give-back guard runs around the start, and a second give-back watcher runs
  for as long as the blanket Chrome runs. On the Mac a use of the blanket scope starts only the blanket Chrome: the
  Mac has no Xvfb, so the main agent Chrome need not run.
- **Its own process.** Chrome's single-instance lock is per user-data-dir (`process_singleton_posix.cc`: the lock,
  the socket and the cookie are files in the user-data-dir; the Mac uses this file). So a Chrome on another folder
  (the operator's Chrome, the agent Chrome) never takes the blanket Chrome's start, and the blanket Chrome's flags
  never reach those processes. The Mac's agent Chrome already runs this way as a second instance (measured
  2026-11-03, `src/agent.ts`). A Chrome that already runs on the blanket folder would take the start's arguments and
  keep its own flags; the sweep before each start stops such a Chrome (`chrome.ts`, `stopOthers`).
- **The flags arrive: a check, not a hope.** `open --args` gives the arguments to the new process's `argv`. After the
  find (below) the service reads the main process's arguments (KERN_PROCARGS2, `src/service/mac.ts`) and checks that
  they hold each of the four proxy flags of this start exactly, the port too. Else it stops that process, and the
  start fails with `the blanket Chrome did not get its address proxy's flags`. So a lost flag fails closed.
- **The find, the pid and the start time.** As for the agent Chrome: within 15 s, the one process on the blanket
  profile (the whole argument `--user-data-dir=<state>/blanket/profile`) with no `--type=`, whose executable is inside
  the app (`proc_pidpath`). Its parent is launchd. The service holds its pid and its start time (proc_pidinfo, in
  microseconds) in memory. It adopts none: at the service's start it stops each Chrome on the blanket profile and on
  the template's profile (13.3), and it deletes the blanket folder.
- **The stop.** As for the agent Chrome on the Mac: SIGTERM to its process group when the group is its own, else to
  its pid, then SIGKILL after the grace; before each signal the service reads the start time and the
  `--user-data-dir=` argument again (`chrome.ts`, `stopChild`). The stop by use, the end, the daemon's `stop` and
  `enabled: false` are as on Linux (section 6).
- **The versions (a fix).** `chromeVersions` (`mac-chrome.ts`) takes each main process of the app that is not on the
  agent profile as the operator's Chrome. A blanket Chrome or a set-up Chrome would pass that test. Part B makes the
  test exclude each process whose `--user-data-dir=` is inside the state folder. The blanket Chrome follows the agent
  Chrome's rule: when the operator's running Chrome is newer than the blanket Chrome and the app on disk is newer too,
  the service stops the blanket Chrome at a moment with no client of its scope and no request in flight. Its folder
  stays, and the next use starts the new version.
- **What the operator sees.** The blanket Chrome's windows are on the operator's screen, behind the front app, with
  their own Dock icon, as the agent Chrome's. The Mac has no X pointer and no paste (C11, the paste): every input goes
  to Chrome at once, as in the main model on the Mac. The shared input lock stays (it costs nothing).

## 13.3 The receiver: the blanket template and its one Load unpacked

**Why a template.** Google Chrome on the Mac has no way to load the receiver into a new folder without a person:

| Way | Why not | Where verified |
| --- | --- | --- |
| `--load-extension` | Google Chrome ignores it: "--load-extension is not allowed in Google Chrome, ignoring." | `chrome/browser/extensions/extension_service.cc` (`GOOGLE_CHROME_BRANDING && !IS_CHROMEOS`) |
| `--disable-extensions-except` | Ignored by default in Google Chrome | `extensions/common/extension_features.cc` (`kDisableDisableExtensionsExceptCommandLineSwitch`, on for branded builds) |
| CDP `Extensions.loadUnpacked` | Only a CDP client of the browser target can call it, and the agent browser never runs with remote debugging (section 2). Also the load is temporary: Chrome marks it `INSTALLED_VIA_CDP` and deletes it at the next start. | `chrome/browser/devtools/protocol/extensions_handler.cc`; `extensions/browser/extension_prefs.cc` (`CleanUpCdpInstalledExtensions`, in `Init`) |
| The external extensions file (a packed CRX) | Chrome on the Mac installs a CRX from outside the Chrome Web Store and turns it off (reason 256) | measured 2026-11-03 (`docs/research/2026-11-24-chrome-update-turns-off-the-mac-agent-extension.md`, section 7) |
| A force-install policy | Needs a managed Mac | the same research note, section 7 |

A copy of a profile that holds a load works without a person, by Chromium's source: Chrome protects
`extensions.settings` and `extensions.ui.developer_mode` with a MAC, and the MAC covers only the build's seed, the
machine's id, the preference's name and its value (`services/preferences/tracked/pref_hash_calculator.cc`). The Mac's
machine id is the IOPlatformUUID (`device_id_mac.cc`, `pref_hash_store_impl.cc`). The encrypted hashes use OSCrypt,
whose Mac key is the product's Keychain item "Chrome Safe Storage" (`keychain_password_mac.mm`). No folder path takes
part, so a copy on the same Mac, for the same user and app, passes the check. M2 measures it.

**The folders.**

- `<state>/agent-package-blanket/`: the pinned agent package, unpacked, the same bytes as `agent-package/`
  (`package/crx.ts`, `unpackAgentPackage`). Its own folder, because Chrome writes into a loaded folder
  (`_metadata/generated_indexed_rulesets`, research note section 1), and the service must be able to write
  `agent-package/` while the blanket Chrome runs. The service writes it before each set-up and each blanket start,
  while no blanket Chrome and no set-up Chrome runs. Chrome reads an unpacked extension's folder at each start, so a
  new pin needs no new load. The manifest's `key` gives the receiver's ID, so the host manifest's
  `allowed_origins` stays the same.
- `<state>/blanket-template/profile`: the template's user-data-dir.

**The set-up (`blanket_setup`, the operator's button on the Browser pane, behind the password login).**

1. The service stops a blanket Chrome that runs (its folder stays) and a set-up Chrome that runs. It writes
   `agent-package-blanket/`. It deletes `<state>/blanket-template/` and makes it new (mode 0700), with the blanket
   folder's Preferences keys (section 4.1) and no extension key.
2. It starts the address proxy in a closed mode: each `CONNECT` gets `02`, with no lookup.
3. It starts the set-up Chrome: `open -n -a <app> --args --user-data-dir=<state>/blanket-template/profile`,
   `AGENT_ARGS`, the closed proxy's flags, the config's `chrome_args`, `about:blank`. No `-g`: its window comes to the
   front. As at a blanket start (the fix round, 13.11), a config whose `chrome_args` hold a switch of the proxy, of
   WebRTC's UDP or of an unpacked extension fails the set-up (before the start and at the late read), and a found
   set-up Chrome whose arguments do not hold the closed proxy's four flags exactly, or hold another such switch, stops.
   So no request of a page passes the proxy, also when a person browses in it, and no site data comes into the
   template. Chrome's DNS-over-HTTPS requests and its Cast discovery bypass the proxy, as for the blanket Chrome
   (section 12, what stays open). It has no host manifest: the receiver there connects to no link.
4. The answer comes at once. `status` says `setting_up`, and `operator_text` gives the steps (13.9).
5. Every 5 s the service reads the template's two files (as C12's access check reads them: the receiver's entry from
   `Default/Secure Preferences` when that file holds it, else from `Default/Preferences`). Chrome writes them some
   seconds after a change. The set-up is done when the entry has a `path` whose real path is that of
   `agent-package-blanket/`, `location` 4 (unpacked), no disable reason, `extensions.ui.developer_mode` is `true`, and
   either file holds no entry of another extension but Chrome's own (`location` 5 or 10). Another extension's entry
   (another location, or none) refuses the template with the reason `the template holds an extension that is not the
   agent extension; set it up again and load only the folder agent-package-blanket`: its copy would load that
   extension in each blanket Chrome (an extension's `proxy` permission wins over the command line), and the service
   cannot change Secure Preferences (its MACs). A read that fails (Chrome writes the file then) reads again 5 s later.
6. Then the service stops the set-up Chrome (SIGTERM; Chrome writes its files at a clean exit), stops the closed
   proxy, and reads the two files again. They pass: `ready`. They fail, or 10 minutes pass first, or the set-up Chrome
   closes first: one more read decides, else `failed`, with the reason. The copy at each blanket start reads the
   template again in the same way and copies no template that fails.

The service never starts a Chrome on the template after the set-up. "Allow in Incognito" is not needed: the blanket
scope has no PageFetch and no sign-in act. An unpacked receiver gets access to local files by itself (C12).

**The copy (each blanket scope's first start).** After the service makes `<state>/blanket/` new (section 4.1), it
copies the template's `Default/Preferences` and `Default/Secure Preferences` into `<state>/blanket/profile/Default/`:
no link followed on either side, each file a JSON object of at most 8 MiB. Then it writes the blanket folder's keys
(the downloads folder in the blanket `HOME`, no password saving, no leak check, no autofill) into the copy's
`Preferences`. These keys have no MAC (`chrome_pref_service_factory.cc`, the tracked list). It writes no extension key
and no key of the tracked list. Then it writes the blanket host manifest and wrapper (section 4.2), so the receiver
reaches the blanket link: Chrome on the Mac reads a user-level host manifest from `<user-data-dir>/NativeMessagingHosts/`
(`chrome/common/chrome_paths.cc`, `DIR_USER_NATIVE_MESSAGING`), as the agent Chrome there relies on. Nothing else of the template is copied: no `Local State`, no `Last Version`, no storage of
the receiver's set-up run. The copy has no `Service Worker` folder; Chrome then registers the receiver's worker again
(`service_worker_task_queue.cc`, `DidVerifyRegistration`). A template that is not `ready` fails the start with
`the blanket profile is not set up on this Mac; the Browser pane gives the steps`; a set-up that runs fails it with
`the blanket profile's set-up runs`.

**A Chrome update.** The research note saw a Chrome update turn the unpacked receiver off in the agent profile, with
developer mode gone; the cause is not proven. The same can happen to a copy (its first start runs the app on disk).
So with no hello on the blanket link in 30 s, the service reads the copy's receiver entry, as C12's off read of the
agent Chrome. When Chrome turned the receiver off, or the copy holds no entry, the service deletes the template folder
(so the state survives a restart of the service), `blanket_template` becomes `none`, and the start fails with
`Chrome turned the agent extension off in the blanket profile; the Browser pane gives the steps to set it up again`.
The operator then does the set-up again (one Load unpacked). M4 measures whether a template made under one version
still works under the next.

## 13.4 The wipe: why not

**What `chrome.browsingData.remove({since: 0}, ...)` removes (Chromium's source).** The extension API has ten types:
`cache`, `cookies`, `downloads`, `fileSystems`, `formData`, `history`, `indexedDB`, `localStorage`, `serviceWorkers`,
`cacheStorage` (`chrome/browser/extensions/api/browsing_data/browsing_data_api.cc`, `MaskForKey`). `passwords` and
`pluginData` remove nothing now. Inside them:

- `cookies` removes partitioned cookies too (a whole removal has no partition filter:
  `browsing_data_filter_builder_impl.h`, `ContainsAll`), and with them the interest groups
  (`browsing_data_remover_impl.cc`) and the client hints (`browsing_data_helper.cc`, `RemoveEmbedderCookieData`).
- `cache` removes the HTTP cache, the code caches and the shader cache, and the HSTS state and HTTP server properties
  (`ClearNetworkingHistoryBetween`), and the CORS preflight cache.
- `downloads` removes the list, not the files.

**What it cannot remove.** No type of the API reaches site settings and permissions (the remover's
`DATA_TYPE_CONTENT_SETTINGS`), site engagement (`DATA_TYPE_SITE_USAGE_DATA`), zoom levels, Private State Tokens,
the Privacy Sandbox's storage (`DATA_TYPE_PRIVACY_SANDBOX`: shared storage, attribution), media licenses, device-bound
sessions, saved passwords, or Chrome's own account and sync state.

**The decision.**

- The receiver's wipe is not enough: it misses the data above, and between two sessions (a crash, a power loss, the
  service down) the earlier session's data stays on disk until the next start's wipe. It also needs a running Chrome.
- Deleting files in place, with the folder kept for its load, is not enough either: the load lives in `Preferences`
  and `Secure Preferences`, and those files also hold the site settings, client hints, zoom and engagement of the
  earlier session. Chrome protects some of those keys with a MAC (the file system access grants are on the tracked
  list), so the service cannot strip them.
- The template copy (13.3) is safer: each blanket folder is new, as on Linux, and its only old part is the two files
  of a profile that never reached the network.
- No wipe op exists, so none can run in the shared profile. The receiver already holds `browsingData` (it removes the
  service workers of off-list sites, `agent/workers.js`); the design gives it no new op. The service's file acts of
  this part touch only `<state>/blanket/` and `<state>/blanket-template/`, and they read `agent-package-blanket/`; no
  act names `<state>/profile`. The receiver still does not know its profile: `"*"` goes only on the blanket link,
  whose peer is the blanket Chrome by pid, start time and profile (section 4.2). No receiver change, no release.

## 13.5 The address proxy on the Mac

- **The same proxy, flags and rules** (section 12). Chrome's command-line proxy wins over the Mac's system proxy
  settings and PAC: the command line's proxy preference has the state `CONFIG_OTHER_PRECEDE`, which precedes the
  system's configuration (`components/proxy_config/pref_proxy_config_tracker_impl.cc`, `PrefPrecedes`). Only a Chrome
  policy or an extension's proxy setting wins over it, and a policy's `ProxyOverrideRules` are added to it
  (`SetProxyOverrideRules`). M1 reads whether the Mac has a managed Chrome policy.
- **The peer check.** The Mac has no `/proc/net/tcp`. On the Mac the proxy reads only the sockets of the blanket
  Chrome's own processes: its main process (by the pid and start time that the service holds) and the processes whose
  parent it is (Chrome's helpers on the Mac are its children: `chromeVersions` relies on it). It reads them as
  `macTcpReader` reads a socket (PROC_PIDLISTFDS, PROC_PIDFDSOCKETINFO): IPv4 TCP only, which fits, because Chrome
  connects to `127.0.0.1`. A client passes only with an exact match of its local address and port to the client's,
  and of its remote address and port to the proxy's, and the real uid of each holder is the service's. This is
  stricter than Linux (another program of the operator's uid is refused), and it scans a few processes, not every
  process of the user, at each connection. M3 measures the cost of a full scan.
- **Its life.** As on Linux: from right before `open` until the blanket Chrome's stop, its end or a failed start, and
  at most 2 s after the Chrome exits by itself. The blanket Chrome is a child of launchd, not of the service. After a
  crash of the service it runs on, with no listener on the proxy's port, until the service's next start stops it;
  launchd starts the service's job again after at least 10 s (agentwatch's plist: `KeepAlive` on a failed exit,
  `ThrottleInterval` 10). The same squatter limit as on Linux holds in that time.
- **The main Chrome never gets the flags.** They are only in the blanket Chrome's `open` arguments; the start of the
  agent Chrome on the Mac is unchanged, and the lock per user-data-dir keeps the processes apart (13.2). Part B tests
  that the agent Chrome's arguments hold no proxy flag.
- **Mac-only paths, checked.**
  - The system proxy and PAC: no effect (above).
  - iCloud Private Relay: not a Chrome path. Chrome's every connection goes to `127.0.0.1`, and the proxy's own
    connects go to an address that it checked. A resolver of Private Relay can only change the answers that the proxy
    checks.
  - Chrome's network service on the Mac: the same code and the same command-line proxy as on Linux.
  - Cast discovery (SSDP, mDNS, DIAL) bypasses the proxy, as on Linux; on the Mac it reaches the operator's home LAN
    when Chrome has the Mac's local network permission (one permission for the app, so for each instance).
    `--disable-features=MediaRouter` turns the Media Router off (`media_router_feature.cc`, `MediaRouterEnabled`).
    Not in this cut: a `--disable-features` of the config's `chrome_args` would replace it, and that merge is not
    checked. A later task.
  - The router's public address (hairpin NAT): the Mac sits behind a home router, whose public address is on no
    interface of the Mac. A connection to it can reach the router and its forwarded ports. The proxy does not know
    that address. A limit, stated in C11.
  - A tunnel app's fake-address mode (some answer each name with an address of `198.18.0.0/15` and resolve the name
    again inside the tunnel) would pass the address rule and then reach any address. M5 reads whether the Mac has
    such a resolver. If it has, part B adds `198.18.0.0/15` (benchmarking, never a public host) to the refused ranges
    of the address rule, for PageFetch too; the blanket scope then fails closed on that Mac.

## 13.6 Status, the op and the operator's text

- The service's hello on the Mac has the feature `blanket_setup`. On Linux the op `blanket_setup` gets `unsupported`.
- `status` gets `blanket_template`: `none` (no template that passes the check), `setting_up`, `ready` or `failed` (the
  last set-up failed). The service reads the template's files at its start and before each copy, so the state
  survives its restart; `setting_up` and `failed` live in memory.
- `operator_text` sentences: 13.9 (C12). The agent's text gets none: the agent sees the start's 503 with the reason.

## 13.7 What stays open

- M2 decides the design: if a copy of the two files does not keep the load on the real Mac, the template copy fails,
  and ab-lead and aw-lead decide again (the fallback would be a fixed blanket profile with the service's file deletes
  in place, with the weaker R1 of 13.4).
- Whether a Chrome update turns the load off in each copy (M4). If yes, the operator sets the template up again after
  each such update; a later step could make the service ask for it at a version change.
- Cast discovery and the router's public address (13.5).
- The memory guard of the blanket Chrome (section 11), as on Linux.

## 13.8 The Mac measurements for the manager (before the build)

All steps run as the operator's user on the Mac. `<state>` is the service's state folder there, and `<build>` the
agent-browser build folder that the service runs. Nothing here writes into `<state>`.

**M1 (read-only, no operator): versions and a managed Chrome.**

```sh
sw_vers -productVersion
/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "/Applications/Google Chrome.app/Contents/Info.plist"
ls -la "/Library/Managed Preferences" 2>&1
profiles status -type enrollment 2>&1
```

Expected: no `com.google.Chrome.plist` in a managed folder, and no MDM enrollment. Else report the policy names only.

**M2 (on screen, with the operator for one Load unpacked, about 5 minutes): the template copy and the flags.**

1. `mkdir -m 700 ~/ab-blanket-m2`, then `ditto "<state>/agent-package" ~/ab-blanket-m2/pkg` (a copy; the live folder
   is not touched).
2. Start a template Chrome that reaches no network (nothing listens on port 9):
   `open -n -a "/Applications/Google Chrome.app" --args --user-data-dir="$HOME/ab-blanket-m2/template" --no-first-run --no-default-browser-check --proxy-server=socks5://127.0.0.1:9 "--proxy-bypass-list=<-loopback>" about:blank`
3. The operator, in that window: open chrome://extensions, turn on Developer mode, click Load unpacked, press
   Command-Shift-G, enter `~/ab-blanket-m2/pkg`, click Select. The card shows the ID
   `ifhfjdmdbgbnmllffiadajepajbcdnai`. Then quit that Chrome with Command-Q.
4. Read the template with the script of the research note (section 6):
   `python3 <script> ~/ab-blanket-m2/template`. Expected: `developer_mode` true, the receiver with `has_path` true and
   no `disable_reasons`, no `preference_reset_time`.
5. `mkdir -p ~/ab-blanket-m2/copy1/Default`, then
   `cp ~/ab-blanket-m2/template/Default/Preferences "$HOME/ab-blanket-m2/template/Default/Secure Preferences" ~/ab-blanket-m2/copy1/Default/`
6. While the operator's Chrome and the agent Chrome run:
   `open -n -g -a "/Applications/Google Chrome.app" --args --user-data-dir="$HOME/ab-blanket-m2/copy1" --no-first-run --no-default-browser-check --proxy-server=socks5://127.0.0.1:9 "--proxy-bypass-list=<-loopback>" --disable-quic about:blank`
7. After 20 s: `pgrep -f "user-data-dir=$HOME/ab-blanket-m2/copy1"` gives its processes; for the one with no
   `--type=`: `ps -ww -o pid=,ppid=,args= -p <pid>`. Expected: parent 1, and each flag of step 6. Also
   `ls ~/ab-blanket-m2/copy1/Default/` shows a `Service Worker` folder (the receiver's worker registered again).
   Then `kill -TERM <pid>` (that test Chrome only), wait 5 s, and read the copy with the script. Expected: as in
   step 4.
8. Steps 5 to 7 again with `copy2`.
9. Keep `~/ab-blanket-m2/template` and `pkg` for M4; delete the copies.

**M3 (read-only, no operator): the cost of a full socket scan.**

```sh
cd <build>
node --input-type=module -e 'const m = await import("./src/service/mac.ts"); const lib = await m.loadMacLib(); if (lib.failed) throw new Error(lib.failed); const p = new m.MacProcs(lib); const r = m.macTcpReader(p); for (let i = 0; i < 5; i++) { const t = performance.now(); const n = r.tcp().length; console.log(n, "lines", (performance.now() - t).toFixed(1), "ms"); } console.log(p.allPids().length, "pids");'
```

Report the line count, the times and the pid count (no address).

**M4 (at the next Chrome update, no operator): a template of the earlier version.** After the app's version on disk
changes (M1's second line), do M2's steps 5 to 7 with `copy3` from the kept template. Expected if the design holds:
as in step 4. A `preference_reset_time` or a disable reason answers the open point of 13.7.

**M5 (read-only, no operator): the Mac's resolvers and tunnels.**

```sh
scutil --proxy
ifconfig -l
scutil --dns | grep -E '^resolver|nameserver\[' | head -20
```

Report whether a nameserver of `198.18.0.0/15` shows, and whether a `utun` interface belongs to a VPN or tunnel app
(its name only).

## 13.9 The contract texts (old and new), for aw-lead's OK

**C11.**

1. The row of the table. Its first cell: old "in a second agent Chrome on an empty folder", new "in a second agent
   Chrome on a new folder". Its last cell: old "board goal ab-4wh builds it on Linux; the Mac later", new "board goal
   ab-4wh builds it on Linux, board ab-4wh.16 on the Mac".
2. The lead of the blanket profile. Old: "A blanket scope opens any public host, but only in the blanket Chrome: a
   second agent Chrome on an empty folder, with its own receiver and its own native link (C12, the blanket profile;
   C4, the blanket profile). Board ab-4wh.4 builds this part in the service, on Linux. The Mac comes later (a second
   profile with the operator's one Load unpacked)." New: "A blanket scope opens any public host, but only in the
   blanket Chrome: a second agent Chrome on a new folder, with its own receiver and its own native link (C12, the
   blanket profile; C4, the blanket profile). Board ab-4wh.4 builds this part in the service on Linux, and board
   ab-4wh.16 on the Mac, where each new folder starts with a copy of the blanket template's two preference files,
   which hold the operator's one Load unpacked of the receiver (C12, the blanket profile on the Mac)."
3. The input stage: one sentence at its end. New: "On the Mac (board ab-4wh.16) the blanket Chrome's windows are on
   the operator's screen, as the agent Chrome's are: there is no X pointer, no pointer path and no paste (the paste,
   above), and every input goes to Chrome at once, as in the main model on the Mac."
4. The address proxy, its first sentence. Old: "On Linux the blanket Chrome reaches the network only through the
   service's address proxy: a SOCKS5 proxy on `127.0.0.1`, on a port that the kernel picks at each start, that admits
   only a client of the service's uid (its line of `/proc/net/tcp`)." New: "On Linux and on the Mac the blanket Chrome
   reaches the network only through the service's address proxy: a SOCKS5 proxy on `127.0.0.1`, on a port that the
   kernel picks at each start, that admits only a client of the service's uid (on Linux its line of `/proc/net/tcp`;
   on the Mac a socket of the blanket Chrome's own processes, its main process and that process's children, read with
   libSystem as the MCP path reads a socket there, with the same exact match of both addresses and ports, and the real
   uid of each holder)."
5. The limits. Old: "An enterprise policy of the box (`ProxySettings`, `WebRtcIPHandling`) would override the flags;
   the service writes none." New: "An enterprise policy of the box (`ProxySettings`, `ProxyOverrideRules`,
   `WebRtcIPHandling`) would override the flags or add rules to them; the service writes none." Old: "that process
   then gets the blanket Chrome's connections. The Mac comes later." New: "that process then gets the blanket
   Chrome's connections. On the Mac (board ab-4wh.16) the blanket Chrome is a child of launchd, not of the service, so
   it also runs on after a crash of the service until the service's next start stops it, and launchd starts the
   service's job again after at least 10 s. The Mac's system proxy settings and its PAC do not apply to the blanket
   Chrome: the command line's proxy wins over them. On the Mac a connection to the public address of the operator's
   router can reach the router and its forwarded ports (hairpin NAT): that address is on no interface of the Mac, so
   the proxy does not know it."

**C12.**

1. The lead of the blanket profile. Old: "a second agent Chrome on an empty folder, with its own receiver and native
   link." New: "a second agent Chrome on a new folder, with its own receiver and native link." Old: "Board ab-4wh.3
   builds this part of the service, on Linux. The Mac comes later (a second profile with the operator's one Load
   unpacked)." New: "Board ab-4wh.3 builds this part of the service on Linux, and board ab-4wh.16 on the Mac (the
   blanket profile on the Mac, below)."
2. The feature, one sentence at its end. New: "On the Mac the hello also has the feature `blanket_setup` (the blanket
   profile on the Mac, below)."
3. The blanket folder. Old: "and makes it new and empty (mode 0700)." New: "and makes it new and empty (mode 0700);
   on the Mac it then copies the blanket template's two preference files into it (the blanket profile on the Mac,
   below)."
4. The start at a use. Old: "starts the blanket Chrome from the same Google Chrome copy on the unit's Xvfb (the unit
   keeps Xvfb up while either Chrome runs), with the external extensions file, so with no hand step, with its address
   proxy" New: "starts the blanket Chrome (on Linux from the same Google Chrome copy on the unit's Xvfb, which the unit
   keeps up while either Chrome runs, with the external extensions file, so with no hand step; on the Mac as the
   blanket profile on the Mac says, below), with its address proxy". Old: "the start of Xvfb alone comes later." New:
   "the start of Xvfb alone comes later. On the Mac a use of the blanket scope starts only the blanket Chrome."
5. The service's start. Old: "The service stops each Chrome on the blanket profile that runs (it adopts none), and
   it deletes the folder." New: "The service stops each Chrome on the blanket profile that runs (it adopts none), and
   it deletes the folder. On the Mac it also stops a Chrome on the blanket template's profile; the template stays."
6. A new bullet after "The import and the send":
   "- The blanket profile on the Mac (board ab-4wh.16; the design's section 13). Google Chrome on the Mac loads the
   receiver only through a person's Load unpacked, so the operator loads it once into the blanket template, a profile
   at `<state>/blanket-template/profile`, and each blanket folder starts with a copy of two of its files. The pinned
   agent package, unpacked, is in `<state>/agent-package-blanket/`: the service writes it as it writes
   `agent-package/` (the Mac, below), before each set-up and each blanket start, while no blanket Chrome and no set-up
   Chrome runs. The op `blanket_setup` stops a blanket Chrome that runs (its folder stays), makes the template folder
   new (mode 0700), and starts the set-up Chrome: `open -n -a <app>` on the template's profile, with the agent
   Chrome's flags and an address proxy that refuses every connection (`02`), so it reaches no network; its window
   comes to the front. Every 5 s the service reads the template's receiver entry, from `Default/Secure Preferences`
   when that file holds it, else from `Default/Preferences`. When the entry has a `path` whose real path is that of
   `agent-package-blanket/`, `location` 4 and no disable reason, and `extensions.ui.developer_mode` is `true`, the
   service stops the set-up Chrome and reads the files again: the template is ready. With no such entry in 10
   minutes, or a read that fails, it stops the set-up Chrome, and the set-up has failed. At the blanket scope's first
   start the service copies the template's `Default/Preferences` and `Default/Secure Preferences` into
   `<state>/blanket/profile/Default/` (no link followed, each a JSON object of at most 8 MiB), writes the keys of the
   blanket folder (the downloads folder, no password saving, no leak check, no autofill) into the copy's
   `Preferences`, and writes no extension key. It starts the blanket Chrome with `open -n -g -a <app> --args`, the
   agent Chrome's flags on the Mac (the Mac, below), `--user-data-dir=<state>/blanket/profile` and the address proxy's
   flags before the config's `chrome_args`, with the give-back guard and a give-back watcher. It finds the blanket
   Chrome's main process as it finds the agent Chrome's, within 15 s, and checks that its arguments hold each flag of
   the address proxy of this start exactly; else it stops that process. It holds the process by pid and start time.
   With no hello on the blanket link in 30 s, it reads the copy's receiver entry as the off read of the agent Chrome
   (the Mac, below); when Chrome turned the receiver off, or the copy holds no entry, it deletes the template folder.
   The operator's Chrome (the Mac, below) is never a Chrome on a profile in the state folder; the blanket Chrome
   stops for a newer version of the operator's Chrome as the agent Chrome starts again for it, at a moment with no
   client of its scope and no request in flight, and its folder stays. The reasons of a failed start on the Mac are
   `the blanket profile is not set up on this Mac; the Browser pane gives the steps`,
   `the blanket profile's set-up runs`, `the blanket Chrome did not come up on its profile within 15 s after open`,
   `the blanket Chrome did not get its address proxy's flags` and
   `Chrome turned the agent extension off in the blanket profile; the Browser pane gives the steps to set it up again`.
   With the feature `blanket_setup`, `status` has the key `blanket_template`: `none`, `setting_up`, `ready` or
   `failed`. `operator_text` gets, while `blanket_template` is `none` and a local item of `set_sessions` has
   `"blanket": true`: "The blanket profile is not set up on this Mac. Click Set up blanket profile in the Browser pane;
   in the Chrome window that opens, open chrome://extensions, turn on Developer mode, click Load unpacked and choose
   the folder `<state folder>/agent-package-blanket` (Command-Shift-G in that dialog takes a path). The service closes
   that window when the extension is loaded." After an off read of a copy that sentence starts with "Chrome turned the
   agent extension off in the blanket profile (a Chrome update can do this). " While `setting_up`: "The set-up Chrome
   of the blanket profile is open: in it, open chrome://extensions, turn on Developer mode, click Load unpacked and
   choose the folder `<state folder>/agent-package-blanket` (Command-Shift-G in that dialog takes a path). It closes
   when the extension is loaded, or after 10 minutes." While `failed`: "The set-up of the blanket profile did not
   finish: <reason>. Click Set up blanket profile in the Browser pane to try again.", where `<reason>` is
   `the extension was not loaded in 10 minutes`, `the extension was not loaded from the folder agent-package-blanket`,
   `Developer mode is off`, `Chrome turned the extension off (disable reason <n>)` or
   `the template's preference files cannot be read`. The template stays at the daemon's `stop` and at
   `enabled: false`: it holds no site data. `agent-browser service stop --all` also stops a set-up Chrome."
7. The requests' table, one more row. Op: `blanket_setup` (`kind: operator`; the Mac, with the feature
   `blanket_setup`). Fields: none. What the service does: "Starts the set-up of the blanket template (the blanket
   profile on the Mac, below). On Linux the answer is `unsupported`. `data`: `{}`." The status row of the data table
   gets the key `blanket_template`.

**C4** (chrome-extension `docs/protocol.md`, the blanket profile). Old: "a second agent Chrome on an empty folder".
New: "a second agent Chrome on a new folder". Old: "The Mac comes later (a second profile with the operator's one Load
unpacked)." New: "On the Mac (board ab-4wh.16) the blanket Chrome's receiver is the same package, loaded unpacked from
a folder of its own: the operator loads it once into the blanket template, and each blanket folder starts with a copy
of the template's preference files. The receiver needs no change for the Mac." **No receiver change and no release.**

## 13.10 Part B: the build

- `src/service/blanket/template.ts` (new): the template folder, the op `blanket_setup`, the set-up Chrome, the read
  of the two files, the state of `blanket_template`, the copy.
- `src/service/blanket/chrome.ts`: the Mac start (`MacStart.open`, the find, the flags check, the copy in place of
  the empty Preferences), the off read, the version stop.
- `src/service/blanket/proxy.ts`: the closed mode; a `tcp` dep for the Mac's reader.
- `src/service/mac.ts`: `macTreeTcpReader`, the sockets of one Chrome's processes.
- `src/service/unit/unit.ts` and `mac-chrome.ts`: a Mac form of `blanketLaunch` (the app and the arguments, no
  environment), `chromeVersions` that excludes the state folder's profiles, `agentPackage` for a second folder.
- `src/service/blanket/part.ts`: the Mac reasons, the op, the status key and sentences.
- `src/service/unit/stop-all.ts`: the set-up Chrome; the state folder's test also takes a Mac state folder with no
  unit record (the blanket Chrome on the Mac starts without the unit).
- The contract texts of 13.9, after aw-lead's OK; `test/vectors/control.json` lines for `blanket_setup`.
- Tests, each with fakes (no `open`, no osascript under `node --test`): the copy (no link followed, the size limit, a
  file that is no JSON object, no tracked key written); the template read (each failure reason); the flags check (a
  missing or other port stops the process and fails the start); the tree reader (a socket of another process is
  refused, a socket of a helper passes); `chromeVersions` with a blanket Chrome running; the set-up's steps and its
  10 minutes; the off read and the template's delete; the version stop; the service's start sweep of both profiles;
  `stop --all`; the agent Chrome's arguments hold no proxy flag.
- The live check on the Mac (through the manager; the operator at the Mac for the one set-up): the set-up gives
  `ready`; a blanket session opens a public site; an IP literal, a `.local` name and a public name with a private
  address are refused; the shared profile's cookies are not in the blanket Chrome; `ps` shows the proxy flags on the
  blanket Chrome only; the folder is gone after the end; the agent Chrome and the operator's Chrome run on unchanged.

## 13.11 The build (part B, 2026-11-26)

The Mac measurements: M2 yes (Chrome 158.0.8127.37: two copies of the template's two files kept the load after an
`open -n -g` start with every proxy flag; the receiver's entry and developer mode live only in `Secure Preferences`;
the receiver's worker registered again). M1: no Chrome policy and no MDM. M3: a full socket scan takes 5 to 9 ms (1390
pids). M5: no system proxy, no resolver of `198.18.0.0/15` and no tunnel, so no `198.18.0.0/15` rule in this task.

The build follows 13.1 to 13.10, with these changes (the contracts hold the final texts):

- aw-lead's early read: `operator_text` names the real absolute path of `agent-package-blanket`, the set-up window
  "opens on this Mac's screen", and the button's label is exactly `Set up blanket profile`.
- The op `blanket_setup` is apart from C12's requests' table, as the card payments' ops are
  (`src/service/control.ts`, `BLANKET_OPS`): only a service whose hello lists `blanket_setup` has it, and every other
  service (Linux, the fake, stage 1a) answers it `unsupported`. The status key `blanket_template` is stated in C12's
  item, not in the data table of the reads.
- One more reason of a failed set-up: `the set-up Chrome closed before the extension was loaded`. A second
  `blanket_setup` while one runs changes nothing.
- The code: `src/service/blanket/template.ts` (the template, the set-up, the copy, the off read),
  `src/service/blanket/mac-start.ts` (the find, the flags check, the stop), the Mac start in `chrome.ts`, the closed mode
  in `proxy.ts`, `macTreeTcpReader` in `src/service/mac.ts`, `macBlanketLaunch` and `macChromeArgs` in `unit.ts`,
  `chromeVersions` with the state folder in `mac-chrome.ts`, the op, the feature, the key, the off read and the version
  stop in `part.ts`, the template in `stop-all.ts`. The Mac live check is `test/live/service-blanket-mac/check.ts`.

The review's fix round (2026-11-26): the set-up Chrome now gets the blanket start's checks (the config's `chrome_args`
and the flags in its arguments; C1); a template that holds another extension than the receiver and Chrome's own is
refused at the set-up and at each copy (I1); the flags check refuses every other proxy switch (m1); the state folder's
mark `agent-package-blanket/` counts on the Mac only (m3); C12 states the reads that fail (m4), the two feature names
(m5), and C11 who can use the proxy on each system (m7); the Mac live check takes only a new, empty or its own
`--state` folder (m6).
