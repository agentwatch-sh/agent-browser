# Why a Chrome update turned off the Mac's agent extension

Board: ab-v16.117 (this note), ab-v16.116 (the service names the state, PR #234), ab-sw1 (the operator's reload),
ab-v16.9.2 (the task that hit it). Date: 2026-11-24. Times are UTC.

## The answer

On the Mac, the agent browser's Chrome loads the agent extension (the receiver) through the operator's one-time
"Load unpacked" of `<state>/agent-package`, with developer mode on. On 2026-11-24 the first start of the agent Chrome
under Chrome 158 (the profile was last used by Chrome 157) **reset Chrome's guarded settings in the agent profile**:

- developer mode went off;
- the receiver's settings entry became a stub with `disable_reasons: [16777216]` (1 << 24, Chrome's reason for an
  unpacked extension while developer mode is off) and no `path`, `location` or `manifest`.

So no receiver ran, agent uses and sign-in sends failed, and the extension stays off until the operator loads it
again. The service's own write into the profile is **not** the cause (a test under Chrome 158, below). The Chrome
update is the most likely cause; it cannot be replayed now, so it is not proven.

What it means: **on the Mac, expect the agent extension to turn off after a Chrome update.** Linux is not affected.
Since ab-v16.116 the Browser pane and a failed send say so (section 5).

## 1. What happened

| Time (UTC) | Event | Source |
| --- | --- | --- |
| 2026-11-17 | The operator's "Load unpacked" in the agent profile (its `Extension Rules` folders date from then). | profile folder dates |
| before 2026-11-23 13:11 | The last receiver hello: receiver 0.3.13, Chrome 157.0.8103.79. | service log |
| between | Google Chrome on disk updates to 158.0.8127.37. The operator's own Chrome kept running 157 (not relaunched). | `Last Version`, process list |
| 2026-11-24 12:19:40 | An operator's sign-in send starts the agent Chrome (its first start under 158). Before it, the service writes the new pinned package (0.3.15) into `agent-package` and its settings into `Default/Preferences`. | gateway, service and launch logs |
| 12:19:45 | Chrome records `prefs.preference_reset_time`. | `Default/Secure Preferences` |
| 12:19 | Chrome writes its indexed rulesets into the new `agent-package` (`_metadata/generated_indexed_rulesets`): it read the folder at that start. | folder dates |
| 12:21:25 | The send fails: "the agent extension of the agent browser did not connect in 45 s" (HTTP 502). | gateway and daemon logs |
| 12:24:41 | The service's watch stops the Chrome after 301 s with no receiver; Chrome writes its pref files at exit. | service log, file dates |

The native link was whole (the host manifest, its wrapper, the Node binary, the agent-browser folder and `link.sock`
all present), and the service log has no `link:` line after the start: the receiver never ran, so nothing called
`connectNative`.

## 2. The state after the start (agent profile, read only)

| Key | `Default/Secure Preferences` | `Default/Preferences` |
| --- | --- | --- |
| `prefs.preference_reset_time` | 13439996385877204 = 2026-11-24T12:19:45Z | absent |
| `extensions.ui` (developer mode) | absent | absent |
| `protection.macs.extensions.ui` | keys `developer_mode`, `developer_mode_encrypted_hash` | — |
| `protection` | `macs`, `super_mac`, `super_encrypted_hash` | — |
| the receiver's `extensions.settings` entry | keys `content_settings`, `disable_reasons`; `disable_reasons [16777216]`; no `path`, `location`, `state` or `manifest` | none (Chrome dropped the service's `incognito` / `newAllowFileAccess` stub) |
| `Last Version` (profile root) | 158.0.8127.37 | |

A fresh Chrome 158 profile also holds the `developer_mode` MAC keys and no `extensions.ui` value, and it has no
`preference_reset_time`. So the MAC keys alone are normal; the reset time is the sign of a reset.

## 3. How a reset turns the extension off

Chromium's design (not measured here): Chrome keeps a MAC of each guarded setting in `Secure Preferences`
(`protection.macs`, with `*_encrypted_hash` companions and a `super_mac` over all of them). At the profile's load it
checks each guarded value against its MAC. A value that fails goes back to its default, and Chrome records the time in
`prefs.preference_reset_time`. Developer mode (`extensions.ui.developer_mode`) and the extensions' settings
(`extensions.settings`) are guarded on macOS: `protection.macs.extensions` holds `ui` (with `developer_mode`) and
`settings` (with `settings_encrypted_hash`) in the agent profile and in a fresh Chrome 158 profile. The 2026-11-03
research measured the rest: with developer mode off,
Chrome disables an unpacked extension at once with reason 16777216, also after a relaunch. With its entry reset, no
later start finds the folder; only a new "Load unpacked" brings the extension back.

## 4. What was tested and ruled out

| Suspect | How it was checked | Result |
| --- | --- | --- |
| The service's write into `Default/Preferences` before each Chrome start (downloads folder, password and autofill off, the receiver's `incognito` and `newAllowFileAccess`) | A throwaway profile under Chrome 158 with developer mode turned on (through chrome://extensions' own `developerPrivate` API), then 2 control starts and 2 starts right after the exact write, each a windowed start with the service's Mac flags | Developer mode stayed on and no `preference_reset_time` appeared at any step. **Not the cause** under 158. Limit: no receiver was installed in that profile. |
| The native link (host manifest, wrapper, Node, the agent-browser folder, `link.sock`) | read on the Mac | all present; not the cause |
| agentwatch's cleanup of old agent-browser builds at its restart | its code keeps the pinned build that the service runs | not the cause |
| A Node upgrade under the running service | the Homebrew Node folders | unchanged since 2026-11-09; not the cause |
| The new receiver package (0.3.15) and its folder swap | Chrome indexed the new folder's rulesets at the failed start | Chrome read the folder; **not tested alone** (it needs a person's "Load unpacked" in a test profile) |
| The Chrome update 157 -> 158 | the reset time is the first 158 start; the 2026-11-03 research saw Beta 158 lose a "Load unpacked" extension of a stable 156 profile on this Mac in 3 of 3 runs, while relaunches under one version kept it | **most likely cause; not replayable** (the Mac has no Chrome 157 binary now) |

Still unknown:
- why the check fails on a profile that the earlier version wrote (for example a change in 158's guarded settings or
  in its `*_encrypted_hash` values; a fresh 158 profile has these hashes, and it is not known whether 157 wrote them);
- whether every Chrome update does this, or only some;
- the service's write with an installed receiver, and the folder swap alone.

## 5. What to do

- **After a Chrome update on the Mac**, the operator loads the extension again, with the agent Chrome running (the
  Browser pane's Start): open chrome://extensions, turn on Developer mode, click Load unpacked, press Command-Shift-G,
  enter `<state>/agent-package`, click Select, keep Developer mode on, then Details and Allow in Incognito. With no
  receiver, the service stops the agent Chrome after about 5 minutes, so the steps fit in that time.
- **The service says so** (ab-v16.116, PR #234): it reads the receiver's entry (read only) and, when Chrome lists a
  disable reason, the Browser pane adds "Chrome turned the agent extension off in the agent Chrome (Developer mode is
  off, or a Chrome update removed the extension). Do these Load unpacked steps again, and keep Developer mode on." A
  send that fails then says "the agent extension of the agent browser is turned off in the agent Chrome".
- **Linux** is not affected: there the receiver is a packed CRX from Chrome's external extensions file, with no
  developer mode.

## 6. How to confirm the cause at the next Chrome update

1. While the agent Chrome still runs the current version (before its first start under the new one), read the agent
   profile with the script below. Expect developer mode true, the receiver's entry with a path, and no new
   `preference_reset_time`.
2. After the first agent Chrome start under the new version, read again. A `preference_reset_time` at that start,
   with developer mode gone, confirms the update as the cause. No reset means that the cause needs a new look; then
   also run the test-profile steps with an installed receiver (one "Load unpacked" by a person).

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
    try: d = json.load(open(p))
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

## 7. Ways to remove the dependency (not decided)

| Way | What is known |
| --- | --- |
| Keep "Load unpacked" and the pane's guidance (today) | works; one reload by the operator after an update that resets |
| A packed CRX through the external extensions file (as on Linux) | on macOS Chrome installs it and disables it at once with reason 256 (not from the Chrome Web Store): measured 2026-11-03 |
| An enterprise policy that force-installs the receiver from a self-hosted update URL | not measured; on macOS Chrome takes such a policy only from a managed configuration profile, a system change on the operator's Mac |
| Chromium or Chrome for Testing as the Mac's agent browser (`--load-extension` works there, no developer mode) | measured on Linux for Chromium (2026-11-03); changes what a site sees against the operator's own Chrome, the reason the design chose Google Chrome |
