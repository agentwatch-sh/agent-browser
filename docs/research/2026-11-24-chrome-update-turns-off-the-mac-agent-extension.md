# Why a Chrome update turned off the Mac's agent extension

Board: ab-v16.117 (this note), ab-v16.116 (the service names the state, PR #234), ab-sw1 (the operator's reload),
ab-v16.9.2 (the task that hit it). Date: 2026-11-24. Times are UTC.

## The answer

On the Mac, the agent browser's Chrome loads the agent extension (the receiver) through the operator's one-time
"Load unpacked" of `<state>/agent-package`, with developer mode on. On 2026-11-24 the agent Chrome's first start
under Chrome 158 (its earlier starts ran 157) **reset Chrome's guarded settings in the agent profile**:

- developer mode went off;
- the receiver's settings entry became a stub with `disable_reasons: [16777216]` (1 << 24, Chrome's reason for an
  unpacked extension while developer mode is off) and no `path`, `location` or `manifest`.

So the receiver never ran: the operator's sign-in send failed, and the agent browser had no receiver for agents. The
extension stays off until the operator loads it again. In a test under Chrome 158, the service's own write into the
profile did not reset developer mode (limits in section 4). The Chrome update is the most likely cause; it cannot be
replayed now, so it is not proven.

What it means: **on the Mac, a Chrome update can turn the agent extension off.** Whether every update does this is not
known. Since ab-v16.116 the service says so (section 5), once agentwatch deploys an agent-browser build with it.

## 1. What happened

| Time (UTC) | Event | Source |
| --- | --- | --- |
| 2026-11-17 | The operator's "Load unpacked" in the agent profile (its `Extension Rules` folders date from then). | profile folder dates |
| before 2026-11-23 13:11 | The last receiver hello: receiver 0.3.13, Chrome 157.0.8103.79. | service log |
| not known | Google Chrome on disk updates to 158.0.8127.37. The operator's own Chrome kept running 157 (not relaunched), so the update came without a relaunch of it. | the Chrome app's version, the process list |
| 2026-11-24 12:19:40 | An operator's sign-in send starts the agent Chrome, its first start under 158. Before the start, the service writes its settings into `Default/Preferences` (`writeDownloadPrefs` in `src/service/unit/unit.ts`) and then the new pinned package (0.3.15, a new pin) into `agent-package`. | gateway and service logs, the code |
| 12:19:45 | Chrome records `prefs.preference_reset_time`. | `Default/Secure Preferences` |
| 12:19 | Chrome writes its indexed rulesets into the new `agent-package` (`_metadata/generated_indexed_rulesets`): it read the folder at that start. | folder dates |
| 12:21:25 | The send fails after 105 s (the Chrome start, then the 45 s receiver wait): "The sign-in for google.com was not sent: the agent extension of the agent browser did not connect in 45 s." (HTTP 502) | gateway, daemon and service logs |
| 12:24:41 | The service's watch stops the Chrome after 301 s with no receiver; Chrome writes its pref files at exit. | service log, file dates |

The native link was whole: the host manifest, its wrapper script, the Node binary, the agent-browser build's
`bin/agent-browser.js` and `link.sock` were all present. The service log has no `link:` line after the start: the
receiver never ran, so nothing called `connectNative`.

Other symptoms, before ab-v16.116: the agent browser's status said `ready` with no receiver, and a new session's scope
stayed `unconfirmed`, so the CLI told it "This session's repo has no sites on its list yet" although the list had
sites.

## 2. The state after the start (agent profile, read only)

| Key | `Default/Secure Preferences` | `Default/Preferences` |
| --- | --- | --- |
| `prefs.preference_reset_time` | 13439996385877204 = 2026-11-24T12:19:45Z | absent |
| `extensions.ui` (developer mode) | absent | absent |
| `protection.macs.extensions` | keys `install`, `settings`, `settings_encrypted_hash`, `ui`; `ui` holds `developer_mode`, `developer_mode_encrypted_hash` | — |
| `protection` | `macs`, `super_mac`, `super_encrypted_hash` | — |
| the receiver's `extensions.settings` entry | keys `content_settings`, `disable_reasons`; `disable_reasons [16777216]`; no `path`, `location`, `state` or `manifest` | none (Chrome dropped the service's `incognito` / `newAllowFileAccess` stub) |
| `Last Version` (profile root) | 158.0.8127.37 (the version of the 12:19 start) | |

A fresh Chrome 158 profile also holds the `developer_mode` MAC keys and no `extensions.ui` value, and it has no
`preference_reset_time`. So the MAC keys alone are normal; the reset time is the sign of a reset.

## 3. How a reset turns the extension off

Chromium's design (not measured here): Chrome keeps a MAC of each guarded setting in `Secure Preferences`
(`protection.macs`, with `*_encrypted_hash` companions and a `super_mac` over all of them). At the profile's load it
checks each guarded value against its MAC. A value that fails goes back to its default, and Chrome records the time in
`prefs.preference_reset_time`.

Measured: developer mode and the extensions' settings are guarded on macOS (their MAC keys are under
`protection.macs.extensions`, in the agent profile and in a fresh Chrome 158 profile). The 2026-11-03 research
measured that with developer mode off, Chrome disables an unpacked extension at once with reason 16777216, also after
a relaunch; in those runs the entry kept its location (4). Here the entry also lost its `path`, `location` and
`manifest`, so the reset hit the receiver's settings entry too, not only developer mode. Inferred from the entry (not
measured): with no path, Chrome has no folder to load at a later start, so only a new "Load unpacked" brings the
extension back.

## 4. What was tested and ruled out

| Suspect | How it was checked | Result |
| --- | --- | --- |
| The service's write into `Default/Preferences` before each Chrome start (downloads folder, password and autofill off, the receiver's `incognito` and `newAllowFileAccess`) | A throwaway profile under Chrome 158. Developer mode on through chrome://extensions' own `developerPrivate` API (that one start was headless), then 2 control starts and 2 starts right after a script that makes the same change as `writeDownloadPrefs`, each a windowed start with the service's Mac flags | Developer mode stayed on, and no `preference_reset_time` appeared at any step. Limits: no receiver was installed in that profile, and the test never changed the Chrome version, so the write at an update start is not tested. A part with an installed receiver (one "Load unpacked" by a person in a test profile) was prepared but did not run. |
| The native link (host manifest, wrapper, Node, the agent-browser build, `link.sock`) | read on the Mac | all present; not the cause |
| agentwatch's cleanup of old agent-browser builds at its restart (12:02Z) | agentwatch's prune code keeps the pinned build that the service runs; the build was present | not the cause |
| A Node upgrade under the running service | the Homebrew Node folders | unchanged since 2026-11-09; not the cause |
| The new receiver package (0.3.15) and its folder swap at the same start | Chrome indexed the new folder's rulesets at the failed start | Chrome read the folder; **not tested alone** |
| The Chrome update 157 -> 158 | the reset time is the first 158 start of the agent profile; the 2026-11-03 research saw a "Load unpacked" extension lost in 3 of 3 `update` runs on the Mac, while relaunches under one version kept it | **most likely cause; not replayable** (the Mac has no Chrome 157 binary now) |

The 2026-11-03 `update` runs differ from this case: they changed the channel too (stable 156.0.8078.80 to Beta
158.0.8127.2), the probe ran Chrome with `--use-mock-keychain` (which can matter for the `*_encrypted_hash` values),
it read developer mode from `Preferences` only, and Beta's first start on that profile never loaded the probe page.

Still unknown:
- why the check fails on a profile that the earlier version wrote (for example a change in 158's guarded settings or
  in its `*_encrypted_hash` values; a fresh 158 profile has these hashes, and it is not known whether 157 wrote them);
- whether every Chrome update does this, or only some;
- the service's write with an installed receiver or at an update start, and the folder swap alone.

## 5. What to do

- **After a Chrome update on the Mac**, check the Browser pane. If the agent extension is off, the operator loads it
  again: click Start in the Browser pane (the agent Chrome opens), open chrome://extensions in the agent Chrome, turn
  on Developer mode, click Load unpacked, press Command-Shift-G, enter `<state>/agent-package`, click Select (the
  macOS folder dialog's button), keep Developer mode on, then Details and Allow in Incognito. With no receiver, the
  service stops the agent Chrome after about 5 minutes, so do these steps in that time.
- **The service says so** (ab-v16.116, PR #234, merge 44aefa8; on the Mac only after agentwatch deploys a build with
  it). It reads the receiver's entry (read only). On the Mac, when Chrome lists disable reason 16777216, the Browser
  pane adds "Chrome turned the agent extension off in the agent Chrome (Developer mode is off, or a Chrome update
  removed the extension). Do these Load unpacked steps again, and keep Developer mode on."; for any other reason it
  adds "Chrome lists the agent extension as turned off in the agent Chrome (disable reason N): in chrome://extensions
  turn it on; if Chrome does not list it, do these Load unpacked steps again." A send that fails then says "The
  sign-in for <domain> was not sent: the agent extension of the agent browser is turned off in the agent Chrome; the
  Browser pane gives the steps to load it again." (on Linux without the last clause).
- **Linux** is not expected to be affected (an inference, not measured for an update): there the receiver is a
  packed CRX from Chrome's external extensions file, with no developer mode. The 2026-11-03 research saw a Linux
  "Load unpacked" extension stay across a start under the 158 binary.

## 6. How to confirm the cause at the next Chrome update

Chrome updates on disk without notice, and the next agent Chrome start runs the new version even while the
operator's own Chrome still runs the old one (as on 2026-11-24). So:

1. Compare the version of `/Applications/Google Chrome.app` (its `CFBundleShortVersionString`) with the agent
   profile's `Last Version`. When they differ, the next agent Chrome start is the update start. Before it, read the
   agent profile with the script below: expect developer mode true, the receiver's entry with a path, and no new
   `preference_reset_time`.
2. After that start, read again. A `preference_reset_time` at that start, with developer mode gone, confirms the
   update as the cause, but only if the same start did not also bring a new agent package: check the service log for
   "unit: the agent package ... is now in" at that start. No reset means that the cause needs a new look; then also
   run the test-profile steps with an installed receiver (one "Load unpacked" by a person).

The read prints only these keys (never a MAC value, a cookie or a storage value); its argument is the profile folder:

```python
import json, os, sys, time
prof = sys.argv[1]
RID = "ifhfjdmdbgbnmllffiadajepajbcdnai"  # the receiver's ID
def obj(x): return x if isinstance(x, dict) else {}
out = {}
try: out["Last Version"] = open(os.path.join(prof, "Last Version")).read().strip()
except OSError as e: out["Last Version"] = type(e).__name__
for name in ("Secure Preferences", "Preferences"):
    p = os.path.join(prof, "Default", name)
    try: d = obj(json.load(open(p)))
    except Exception as e: out[name] = {"error": type(e).__name__}; continue
    ext = obj(d.get("extensions")); s = obj(ext.get("settings")).get(RID)
    out[name] = {
        "mtime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(os.path.getmtime(p))),
        "developer_mode": obj(ext.get("ui")).get("developer_mode"),
        "preference_reset_time": obj(d.get("prefs")).get("preference_reset_time"),
        "receiver": None if not isinstance(s, dict) else {
            "keys": sorted(s), "disable_reasons": s.get("disable_reasons"),
            "has_path": isinstance(s.get("path"), str), "version": obj(s.get("manifest")).get("version")},
    }
print(json.dumps(out, indent=1, sort_keys=True))
```

`preference_reset_time` counts microseconds since 1601-01-01 (Windows file time): subtract 11644473600000000 and
divide by 10^6 for Unix seconds.

A later improvement could do step 1 in the service: it already compares Chrome versions on the Mac
(`src/service/unit/mac-chrome.ts`), so it could read and log these keys before a start whose version differs from
`Last Version`, and again after it.

## 7. Ways to remove the dependency (not decided)

| Way | What is known |
| --- | --- |
| Keep "Load unpacked" and the pane's guidance (today) | works; one reload by the operator after an update that resets |
| A packed CRX through the external extensions file (as on Linux) | on macOS Chrome installs it and disables it at once with reason 256 (not from the Chrome Web Store): measured 2026-11-03 |
| The Chrome Web Store, as an unlisted item | one "Add to Chrome" per profile, updates from the store (2026-11-03 research, section 5); not measured for this case |
| An enterprise policy that force-installs the receiver from a self-hosted update URL | not measured; Chromium's policy definition says that on macOS an extension from outside the Web Store is force-installed only when the Mac is managed through MDM, joined to a domain through MCX, or enrolled in Chrome Enterprise Core (2026-11-03 research, section 5) |
| Chromium as the Mac's agent browser (`--load-extension` works there, no developer mode) | measured on Linux for Chromium (2026-11-03); Chrome for Testing not measured; changes what a site sees against the operator's own Chrome, the reason the design chose Google Chrome |
