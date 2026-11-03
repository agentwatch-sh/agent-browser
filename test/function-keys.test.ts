// The pure parts of the live function-key check (test/live/function-keys/trials.ts): the start guard,
// the trials and the Chrome switches of each platform, the "before" key events and the failure rules.
// The check itself (a real Chrome) is not part of `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKey } from "../src/record.ts";
import { beforeFields, chromeArgs, failures, MAC_KEY_CODES, requiredControls, startMode, trialTable, type Mode, type Result } from "./live/function-keys/trials.ts";

const MODS = ["", "Shift+", "Control+", "Alt+", "Meta+", "Control+Shift+", "Alt+Shift+", "Control+Alt+"];
const F = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);
const linux = startMode("linux", {}) as Mode;
const mac = startMode("darwin", { onMyScreen: true, chrome: "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta" }) as Mode;
const ok = (way: Result["way"], spec: string, o: Partial<Result> = {}): Result => ({ way, spec, focused: true, reachedPage: true, effects: [], ...o });

test("start guard: Linux runs in its private Xvfb, as before", () => {
  assert.deepEqual(startMode("linux", {}), { platform: "linux", chrome: "/usr/bin/chromium", display: 97 });
  assert.deepEqual(startMode("linux", { chrome: "/opt/c/chrome", display: "42" }), { platform: "linux", chrome: "/opt/c/chrome", display: 42 });
  for (const flag of ["onMyScreen", "background", "fullScreen"] as const) {
    const r = startMode("linux", { [flag]: true });
    assert.ok("error" in r && /for macOS/.test(r.error) && /private Xvfb/.test(r.error), `${flag}: ${JSON.stringify(r)}`);
  }
});

test("start guard: macOS refuses to start without --on-my-screen, and names that flag", () => {
  const r = startMode("darwin", { chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  assert.ok("error" in r, JSON.stringify(r));
  assert.match(r.error, /--on-my-screen/);
  assert.match(r.error, /no private Xvfb/);
  assert.match(r.error, /keyboard focus/);
  // The same refusal without --chrome: the screen comes first.
  const bare = startMode("darwin", {});
  assert.ok("error" in bare && /--on-my-screen/.test(bare.error), JSON.stringify(bare));
});

test("start guard: the macOS mode needs --chrome and takes no --display", () => {
  const noChrome = startMode("darwin", { onMyScreen: true });
  assert.ok("error" in noChrome && /--chrome/.test(noChrome.error) && /Google Chrome Beta\.app\/Contents\/MacOS/.test(noChrome.error), JSON.stringify(noChrome));
  const display = startMode("darwin", { onMyScreen: true, chrome: "/x", display: "97" });
  assert.ok("error" in display && /--display/.test(display.error), JSON.stringify(display));
  assert.deepEqual(mac, { platform: "darwin", chrome: "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta", front: true, fullScreen: false });
  assert.deepEqual(startMode("darwin", { onMyScreen: true, chrome: "/x", background: true, fullScreen: true }), { platform: "darwin", chrome: "/x", front: false, fullScreen: true });
});

test("start guard: other platforms stay refused", () => {
  const r = startMode("win32", { onMyScreen: true, chrome: "C:/chrome.exe" });
  assert.ok("error" in r && /Linux or macOS only/.test(r.error), JSON.stringify(r));
});

test("Linux trials: the 207 trials of PR #18, in the same order", () => {
  const want = [
    ...[...F.flatMap((k) => MODS.map((m) => m + k)), "Control+L", "Control+T", "Control+W"].map((spec) => ({ way: "before", spec })),
    ...F.flatMap((k) => MODS.map((m) => ({ way: "record", spec: m + k }))),
    ...F.map((spec) => ({ way: "press", spec })),
  ];
  assert.deepEqual(trialTable(linux), want);
  assert.equal(want.length, 207);
  assert.deepEqual(requiredControls(linux), ["F5", "F11", "F12", "Control+W"]);
});

test("macOS trials: the same record and press trials, the Cmd controls, no full screen by default", () => {
  const t = trialTable(mac);
  const specs = (way: string) => t.filter((x) => x.way === way).map((x) => x.spec);
  assert.deepEqual(specs("record"), F.flatMap((k) => MODS.map((m) => m + k)));
  assert.deepEqual(specs("press"), F);
  assert.deepEqual(specs("before"), [...F.flatMap((k) => MODS.map((m) => m + k)), "Meta+R", "Meta+W", "Meta+T", "Meta+L", "Meta+Alt+I"]);
  assert.ok(!t.some((x) => /Meta\+Control\+F$|Control\+Meta\+F$/.test(x.spec)), "Meta+Control+F takes the screen: only with --full-screen");
  assert.deepEqual(requiredControls(mac), ["Meta+R", "Meta+W", "Meta+Alt+I"]);
  const full: Mode = { ...mac, fullScreen: true } as Mode;
  assert.deepEqual(trialTable(full).filter((x) => x.way === "before").slice(-1), [{ way: "before", spec: "Meta+Control+F" }]);
  assert.deepEqual(requiredControls(full), ["Meta+R", "Meta+W", "Meta+Alt+I", "Meta+Control+F"]);
  for (const x of t) parseKey(x.spec); // every spec parses
});

test("before fields on Linux: keyFields plus the Windows key code as native code, as before #7", () => {
  assert.deepEqual(beforeFields(parseKey("F5"), "linux"), { key: "F5", code: "F5", windowsVirtualKeyCode: 116, modifiers: 0, nativeVirtualKeyCode: 116 });
  assert.deepEqual(beforeFields(parseKey("Control+W"), "linux"), { key: "w", code: "KeyW", windowsVirtualKeyCode: 87, modifiers: 2, nativeVirtualKeyCode: 87 });
});

test("before fields on macOS: the Mac key code and the characters that Chrome's menu shortcuts match", () => {
  assert.deepEqual(beforeFields(parseKey("Meta+R"), "darwin"), { key: "r", code: "KeyR", windowsVirtualKeyCode: 82, modifiers: 4, nativeVirtualKeyCode: 0x0f, text: "r" });
  assert.deepEqual(beforeFields(parseKey("Meta+Alt+I"), "darwin"), { key: "i", code: "KeyI", windowsVirtualKeyCode: 73, modifiers: 5, nativeVirtualKeyCode: 0x22, text: "i" });
  // A function key: kVK_F5 and NSF5FunctionKey, as a Mac keyboard sends them.
  assert.deepEqual(beforeFields(parseKey("Shift+F5"), "darwin"), { key: "F5", code: "F5", windowsVirtualKeyCode: 116, modifiers: 8, nativeVirtualKeyCode: 0x60, text: "\uf708" });
  assert.equal(beforeFields(parseKey("F1"), "darwin").text, "\uf704");
  assert.equal(beforeFields(parseKey("F12"), "darwin").text, "\uf70f");
  // Chrome passes a key to its shortcuts only with a non-zero native code (kVK_ANSI_A is 0).
  for (const x of trialTable({ ...mac, fullScreen: true } as Mode).filter((t) => t.way === "before")) {
    assert.ok(beforeFields(parseKey(x.spec), "darwin").nativeVirtualKeyCode > 0, x.spec);
  }
  assert.deepEqual(Object.fromEntries(F.map((k) => [k, MAC_KEY_CODES[k]])),
    { F1: 0x7a, F2: 0x78, F3: 0x63, F4: 0x76, F5: 0x60, F6: 0x61, F7: 0x62, F8: 0x64, F9: 0x65, F10: 0x6d, F11: 0x67, F12: 0x6f });
});

test("Chrome switches: Linux unchanged; macOS has a mock keychain and no X11 switches", () => {
  assert.deepEqual(chromeArgs(linux, "/o/profile"), [
    "--no-first-run", "--no-default-browser-check", "--user-data-dir=/o/profile", "--remote-debugging-port=0",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps", "--password-store=basic",
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE probe.localhost", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=probe.localhost",
    "--ozone-platform=x11", "--window-position=0,0", "--window-size=1100,700", "about:blank",
  ]);
  const m = chromeArgs(mac, "/o/profile-x");
  assert.ok(m.includes("--use-mock-keychain") && m.includes("--user-data-dir=/o/profile-x"), m.join(" "));
  assert.ok(!m.some((a) => /ozone|password-store/.test(a)), m.join(" "));
  assert.ok(m.includes("--proxy-server=http://127.0.0.1:9") && m.includes("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE probe.localhost"));
});

test("failures on Linux: the rules of PR #18", () => {
  const base = [ok("before", "F5", { effects: ["reload"] }), ok("before", "F11", { effects: ["window normal -> fullscreen"] }), ok("before", "F12", { effects: ["new page devtools://x"] }),
    ok("before", "Control+W", { effects: ["closed"] }), ok("record", "Shift+F10", { effects: ["contextmenu"] }), ok("record", "F5"), ok("press", "F5")];
  assert.deepEqual(failures(base, linux), []);
  assert.deepEqual(failures([...base.slice(0, 4), ok("record", "Shift+F10"), ok("record", "F5", { effects: ["reload"] }), ok("press", "F5", { reachedPage: false })], linux), [
    "record F5: reload", "press F5: never reached the page", "record Shift+F10: no context menu (record refuses it for that)",
  ]);
  assert.deepEqual(failures([ok("before", "F5"), ok("record", "F1", { focused: false })], linux), [
    "before F5: no effect, so the check cannot see Chrome's shortcuts", "record F1: the page had no focus before the key",
  ]);
});

test("failures on macOS: the Cmd controls must show an effect; Shift+F10 opens no context menu there", () => {
  const base = [ok("before", "Meta+R", { effects: ["reload"] }), ok("before", "Meta+W", { effects: ["closed"] }), ok("before", "Meta+Alt+I", { effects: ["new page devtools://x"] }),
    ok("before", "F11"), ok("record", "Shift+F10"), ok("record", "Meta+F5"), ok("press", "F12")];
  assert.deepEqual(failures(base, mac), []);
  assert.deepEqual(failures([ok("before", "Meta+R"), ...base.slice(1), ok("record", "F11", { effects: ["window normal -> fullscreen, left at once"] })], mac), [
    "record F11: window normal -> fullscreen, left at once", "before Meta+R: no effect, so the check cannot see Chrome's shortcuts",
  ]);
});
