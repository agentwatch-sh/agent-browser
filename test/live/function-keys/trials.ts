// The pure parts of the live function-key check (check.ts): the start guard, the trials and Chrome
// switches of each platform, the "before" key events and the failure rules. No Chrome, no I/O, so that
// test/function-keys.test.ts runs them in `npm test`.

import { keyFields } from "../../../src/browser.ts";
import type { KeyEvent } from "../../../src/record.ts";
import { reservedDisplay } from "../guard.ts";

export type Way = "before" | "record" | "press";
export type Trial = { way: Way; spec: string };
/** The Meta+L control (macOS): "blur" shows that the trial window was key when the control ran. */
export type Control = "blur" | "no blur" | "no page focus" | "late events" | "error";
/**
 * control (macOS): the Meta+L control after a key without an effect; it decides a record or press
 * trial, and is information for a before trial. notMeasured (macOS): why the trial proves nothing.
 * fullScreenNotLeft (macOS) and trialError (macOS) stop the run after the trial.
 */
export type Result = { way: Way; spec: string; focused: boolean; reachedPage: boolean; effects: string[]; sendError?: string; control?: Control; notMeasured?: string;
  fullScreenNotLeft?: boolean; trialError?: string };
/** linux: a private Xvfb. darwin: the person's own screen; `front` brings each trial window to the front. */
export type Mode = { platform: "linux"; chrome: string; display: number } | { platform: "darwin"; chrome: string; front: boolean; fullScreen: boolean };
export type Flags = { onMyScreen?: boolean; background?: boolean; fullScreen?: boolean; chrome?: string; display?: string };

const MODS = ["", "Shift+", "Control+", "Alt+", "Meta+", "Control+Shift+", "Alt+Shift+", "Control+Alt+"];
const F = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);
const FKEYS = F.flatMap((k) => MODS.map((m) => m + k));
const LINUX_CONTROLS = ["Control+L", "Control+T", "Control+W"]; // Chrome shortcuts outside the function keys
// macOS Chrome's own Cmd shortcuts: reload, close the tab, a new tab, the address bar, DevTools.
const MAC_CONTROLS = ["Meta+R", "Meta+W", "Meta+T", "Meta+L", "Meta+Alt+I"];
// Full screen moves the window into its own Space and the screen switches to it: only with --full-screen.
const MAC_FULL_SCREEN = "Meta+Control+F";
const MAC_EXAMPLE = "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta";

/** The start guard: the mode to run in, or the usage error (exit 2). */
export function startMode(platform: string, f: Flags): Mode | { error: string } {
  if (platform === "linux") {
    const mac = f.onMyScreen ? "--on-my-screen" : f.background ? "--background" : f.fullScreen ? "--full-screen" : undefined;
    if (mac) return { error: `${mac} is for macOS: on Linux the check always runs in a private Xvfb, so that no window reaches a person's screen` };
    const display = Number(f.display ?? 97), reserved = reservedDisplay(display, "--display");
    if (!Number.isInteger(display) || display < 1) return { error: "--display is a positive whole number" };
    if (reserved) return { error: reserved };
    return { platform: "linux", chrome: f.chrome ?? "/usr/bin/chromium", display };
  }
  if (platform === "darwin") {
    if (!f.onMyScreen) {
      return { error: "macOS has no private Xvfb: the check's Chrome windows open on this screen, and each trial window takes the keyboard focus, " +
        "for several minutes. Start it only when the person at this Mac agrees: pass --on-my-screen, and do not type or click until it ends" };
    }
    if (f.display !== undefined) return { error: "--display is for Linux's private Xvfb; the macOS mode has none" };
    if (!f.chrome) return { error: `on macOS pass --chrome with the app's binary, for example --chrome "${MAC_EXAMPLE}"` };
    return { platform: "darwin", chrome: f.chrome, front: !f.background, fullScreen: !!f.fullScreen };
  }
  return { error: "Linux or macOS only: on Linux the check runs in a private Xvfb; on macOS it needs --on-my-screen" };
}

/**
 * Three ways to send each key: before (a key event that reaches Chrome's shortcuts, as agent-browser
 * sent them before #7), record (record's press step) and press (the press command). F1 to F12 with
 * eight modifier sets for before and record, F1 to F12 alone for press, and the platform's controls.
 */
export function trialTable(mode: Mode): Trial[] {
  const controls = mode.platform === "linux" ? LINUX_CONTROLS : [...MAC_CONTROLS, ...(mode.fullScreen ? [MAC_FULL_SCREEN] : [])];
  return [
    ...[...FKEYS, ...controls].map((spec) => ({ way: "before" as Way, spec })),
    ...FKEYS.map((spec) => ({ way: "record" as Way, spec })),
    ...F.map((spec) => ({ way: "press" as Way, spec })),
  ];
}

/** The before controls that must show a Chrome effect, else the check cannot see Chrome's shortcuts. */
export function requiredControls(mode: Mode): string[] {
  if (mode.platform === "linux") return ["F5", "F11", "F12", "Control+W"];
  return ["Meta+R", "Meta+W", "Meta+Alt+I", ...(mode.fullScreen ? [MAC_FULL_SCREEN] : [])];
}

/** macOS virtual key codes (Carbon's kVK_*) of the before trials' keys. kVK_ANSI_A is 0, so it is not here. */
export const MAC_KEY_CODES: Record<string, number> = {
  F1: 0x7a, F2: 0x78, F3: 0x63, F4: 0x76, F5: 0x60, F6: 0x61, F7: 0x62, F8: 0x64, F9: 0x65, F10: 0x6d, F11: 0x67, F12: 0x6f,
  KeyF: 0x03, KeyI: 0x22, KeyL: 0x25, KeyR: 0x0f, KeyT: 0x11, KeyW: 0x0d,
};

/**
 * The before way's key fields. Linux: keyFields plus nativeVirtualKeyCode, as agent-browser before #7.
 * macOS: Chrome builds an NSEvent from nativeVirtualKeyCode and text (native_input_event_builder_mac.mm),
 * and its menu shortcuts match that event's characters (cr_firesForKeyEquivalentEvent), so the before
 * way sends the Mac key code and the characters of a Mac keyboard: the letter, or NSF1FunctionKey
 * (U+F704) to NSF12FunctionKey. A key down without text matches no menu shortcut there.
 */
export function beforeFields(k: KeyEvent, platform: "linux" | "darwin"): ReturnType<typeof keyFields> & { nativeVirtualKeyCode: number; text?: string } {
  const base = keyFields(k.key, k.code, k.keyCode, k.modifiers);
  if (platform === "linux") return { ...base, nativeVirtualKeyCode: k.keyCode };
  const native = MAC_KEY_CODES[k.code];
  if (!native) throw new Error(`no macOS key code for ${k.code}`);
  const fn = /^F(\d+)$/.exec(k.code);
  return { ...base, nativeVirtualKeyCode: native, text: fn ? String.fromCharCode(0xf703 + Number(fn[1])) : k.key };
}

/** Chrome's switches: a throwaway profile, one local page, no network (every other host fails to resolve). */
export function chromeArgs(mode: Mode, profile: string): string[] {
  const linux = mode.platform === "linux";
  return [
    "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "--remote-debugging-port=0",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
    ...(linux ? ["--password-store=basic"] : []),
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE probe.localhost", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=probe.localhost",
    // macOS: a mock keychain, so Chrome never asks for, or reads, the login keychain's "Chrome Safe Storage".
    ...(linux ? ["--ozone-platform=x11"] : ["--use-mock-keychain"]),
    "--window-position=0,0", "--window-size=1100,700", "about:blank",
  ];
}

// The front app's pid from lsappinfo: the same parsers as agent-browser's own `front` (src/front.ts).
export { isAsn, lsappinfoPid } from "../../../src/front.ts";

/** macOS: a full screen has ended only at a real window state, or when its target is confirmed closed ("gone" alone can be a CDP timeout). */
export function fullScreenEnded(state: string, targetClosed: boolean): boolean {
  return ["normal", "maximized", "minimized"].includes(state) || (state === "gone" && targetClosed);
}

/**
 * macOS: why a trial measured nothing, or undefined. Chrome runs a shortcut only in its key window,
 * and document.hasFocus() does not show that, so the check's Chrome must be the front app before and
 * after the key, and a record or press key without an effect must be followed by a before-way Meta+L
 * that moves the focus to the address bar (control "blur": the window was key when the control ran).
 * A before trial's control is information only: its required controls fail by their own rule.
 */
export function notMeasured(t: { way: Way; effects: string[]; chromePid: number; frontBefore?: number; frontAfter?: number; control?: Control }): string | undefined {
  if (t.frontBefore !== t.chromePid) return `Chrome was not the front app before the key (front app pid ${t.frontBefore ?? "unknown"}, Chrome ${t.chromePid})`;
  if (t.frontAfter !== t.chromePid) return `Chrome was not the front app after the key (front app pid ${t.frontAfter ?? "unknown"}, Chrome ${t.chromePid})`;
  if (t.way !== "before" && !t.effects.length && t.control !== "blur") return t.control ? CONTROL_FAILS[t.control] : "the Meta+L control did not run";
  return undefined;
}
const CONTROL_FAILS: Record<Exclude<Control, "blur">, string> = {
  "no blur": "the Meta+L control showed no page blur, so the window was not key when the control ran",
  "no page focus": "the page had no focus when the Meta+L control was to run",
  "late events": "the key had late events, and the Meta+L control did not run",
  error: "the Meta+L control failed with an error",
};

/**
 * Why the run stops after this trial (its window is closed then), or undefined: a full screen that
 * the check could not leave; on macOS also a trial error, which can leave its window on the screen.
 */
export function stopReason(r: Result, mode: Mode): string | undefined {
  if (r.fullScreenNotLeft) return `after ${r.way}:${r.spec}: full screen not left in 10 s`;
  if (mode.platform === "darwin" && r.trialError) return `after ${r.way}:${r.spec}: trial error: ${r.trialError}`;
  return undefined;
}

/**
 * Exit 1 for each: a record or press key with an effect outside the page, or that never reached it
 * (Shift+F10 aside: record refuses it); on Linux a record Shift+F10 without the context menu (Blink
 * opens it on Windows and Linux only: WebFrameWidgetImpl::HandleKeyEvent has no Shift+F10 on macOS);
 * a required before control without an effect; a page without focus before its key; on macOS a trial
 * not measured, and a full screen not left.
 */
export function failures(results: Result[], mode: Mode): string[] {
  const of = (way: Way) => results.filter((r) => r.way === way);
  const required = requiredControls(mode);
  return [
    ...[...of("record"), ...of("press")].filter((r) => r.spec !== "Shift+F10" && (r.effects.length || !r.reachedPage)).map((r) => `${r.way} ${r.spec}: ${r.effects.join(", ") || "never reached the page"}`),
    ...(mode.platform === "linux" ? of("record").filter((r) => r.spec === "Shift+F10" && !r.effects.includes("contextmenu")).map(() => "record Shift+F10: no context menu (record refuses it for that)") : []),
    ...of("before").filter((r) => required.includes(r.spec) && !r.effects.length).map((r) => `before ${r.spec}: no effect, so the check cannot see Chrome's shortcuts`),
    ...results.filter((r) => !r.focused).map((r) => `${r.way} ${r.spec}: the page had no focus before the key`),
    ...results.filter((r) => r.notMeasured).map((r) => `${r.way} ${r.spec}: not measured: ${r.notMeasured}`),
    ...results.filter((r) => r.fullScreenNotLeft).map((r) => `${r.way} ${r.spec}: full screen not left in 10 s`),
  ];
}
