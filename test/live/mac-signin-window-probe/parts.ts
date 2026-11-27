// The pure parts of the Mac sign-in window probe (probe.ts; board ab-v16.97.14, part 1; the companion design note
// docs/superpowers/specs/2026-11-26-stored-sign-ins-mac-design.md, D2 and D4): the window options and the two Chrome
// runs, the probe's own Chrome flags, the test extension's files and id, the local page and its recorder, the key events
// of the plain test text, the JXA scripts of the front app (the service's give-back calls only), the parsers of
// `security authorizationdb read` and of the tools' short answers, the verdicts and the summary, the pipe's frames, the
// stand-in browser of the Linux dry run, and the result: its shape, its check (no path, no name) and its scrub. No
// process, no file and no network here, so that test/mac-signin-window-probe.test.ts runs them on Linux in `npm test`.
//
// The formats of Apple's tools here come from Apple's man pages and their usual output as known on the Linux server, not
// from a measure: the run on the Mac checks them. Each parser gives "unknown" or null for a text that it does not know.

import { createHash } from "node:crypto";
import { AGENT_ARGS } from "../../../src/agent.ts";
import { runClass, textOf, type ToolRun } from "../../../src/service/signins/mac-tools.ts";
import { clean, scrub, type Meta, type Platform } from "../mac-peer-probe/parts.ts";

export { clean, runClass, scrub, textOf, type Meta, type Platform, type ToolRun };

/** The probe's version: a change of the result's fields or of the probe's steps gives a new one. */
export const PROBE_VERSION = 1;
/** The time limit of the whole run. */
export const TIME_LIMIT_MS = 120_000;
/** The time that the run keeps for its cleanup: a step that would end later than TIME_LIMIT_MS - RESERVE_MS is skipped. */
export const RESERVE_MS = 15_000;
/** An option starts only when this much time is left before the reserve. */
export const OPTION_MIN_MS = 9_000;
/** A Chrome run starts only when this much time is left before the reserve. */
export const RUN_MIN_MS = 25_000;
/** The time limit of each short tool read (security, osascript, the rights helper). */
export const QUICK_MS = 5_000;
/** The longest wait for the probe's Chrome to answer on its pipe after its start. */
export const CHROME_START_MS = 20_000;
/** The time limit of each CDP call of the run; an input call has its own, shorter one. */
export const CALL_MS = 5_000;
export const INPUT_CALL_MS = 2_000;
/** After this many input calls that got no answer in time, the option types no more. */
export const HANGS_MAX = 2;
/** The wait after a window's place or state, before the reads. */
export const SETTLE_MS = 800;
/** The page's measure: its rAF calls, its 10 ms timer's ticks and an IntersectionObserver, in this time. */
export const MEASURE_MS = 1_200;
/** The gap between a key's down and its up, and between two keys. */
export const KEY_HOLD_MS = 15;
export const KEY_GAP_MS = 30;
/** The longest wait for the probe's Chrome to end after Browser.close; then SIGTERM, then SIGKILL. */
export const CLOSE_WAIT_MS = 5_000;
/** The longest wait for the page's recorder in a new window. */
export const PAGE_WAIT_MS = 5_000;
/** The most give-back asks of one Chrome run (one after each window's create, at most). */
export const GIVE_BACK_MAX = 12;
/** The pipe keeps at most this much of an unfinished message (Chrome's messages are far smaller). */
export const FRAME_MAX_BYTES = 16 << 20;
/** The result's largest size, as JSON. */
export const RESULT_MAX_BYTES = 128 * 1024;
/** The most text of a tool that the probe keeps for its parse, of stdout and of stderr each. */
export const TEXT_MAX = 64 * 1024;

/** The plain test text that the act's input path types (keys), and the short text of its Input.insertText. No secret. */
export const TEST_TEXT = "probe text 42";
export const INSERT_TEXT = " xyz";
export const EXPECTED_TEXT = TEST_TEXT + INSERT_TEXT;
/** The act window's place in the options that place it (CSS px of the screen). */
export const ACT_BOUNDS = { left: 100, top: 100, width: 800, height: 600 } as const;
/** The page's text field (CSS px of the viewport): the probe clicks its centre. */
export const FIELD = { x: 40, y: 60, w: 300, h: 30 } as const;
/** The verdict's floors in MEASURE_MS: rAF at 25 a second, the 10 ms timer at 50 a second. */
export const RAF_MIN = 30, TICKS_MIN = 60;

/** The programs (constants of the code: never a value of the result). */
export const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const LINUX_CHROMIUM = "/usr/bin/chromium";
export { SECURITY } from "../../../src/service/signins/mac-tools.ts";
export const OSASCRIPT = "/usr/bin/osascript";
export { TASKPORT_RIGHT } from "../../../src/service/signins/mac-tools.ts";
/** The Linux twin's seam (Linux only): the display of a private Xvfb on which the probe runs the Mac's Chrome flow with Chromium. */
export const TWIN_ENV = "AB_SIGNIN_PROBE_TWIN_DISPLAY";
/**
 * The cleanup test's seam (Linux only, never with the twin): AB_SIGNIN_PROBE_DRY_HOLD=<ms> sets the run's time limit to
 * <ms> (1000 to 30000), and the dry run then starts a stand-in browser that stays and waits: the time limit or a signal
 * ends the run through its synchronous cleanup (test/mac-signin-window-probe.test.ts).
 */
export const HOLD_ENV = "AB_SIGNIN_PROBE_DRY_HOLD";
/** The hold seam's time limit, or null when the text is not a whole number of ms from 1000 to 30000. */
export const holdMs = (text: string): number | null => (/^[0-9]{4,5}$/.test(text) && Number(text) >= 1000 && Number(text) <= 30_000 ? Number(text) : null);
/** The occlusion flag of AGENT_ARGS: run B drops it. */
export const OCCLUSION_FLAG = "--disable-backgrounding-occluded-windows";

/** The two Chrome runs, in their order. */
export const RUNS = {
  A: "the agent flags (AGENT_ARGS, with --disable-backgrounding-occluded-windows): what the site sees",
  B: "the sensor: the agent flags without --disable-backgrounding-occluded-windows, so the page's visibility gives macOS's own occlusion: whether the window is on the screen for a person",
} as const;
export type RunName = keyof typeof RUNS;

/**
 * The window options of the design's D2, in their order, and how each is made. The `cdp` options are made through the
 * probe's browser-level CDP (Target.createTarget in a browser context of the probe's own, Browser.setWindowBounds): the
 * receiver has no such call (agent mode has no browser-level CDP), so they stand in for the window's state. The `api`
 * options are made by the probe's test extension with chrome.windows, the receiver's own call (C10's windows.create).
 * The order puts the options that decide the design's pick first (the baseline, then the minimized window by the
 * receiver's call): a page that is hidden makes an option slower (its timers, an input call that waits), and an option
 * that would end after the run's reserve is skipped.
 */
export const OPTIONS = {
  front: "cdp: a normal window at 100,100 (800 by 600), nothing of the probe over it: the baseline",
  apiMinimized: "api: windows.create with state minimized, focused false and incognito true (the act window's own form)",
  minimized: "cdp: the baseline's window, then Browser.setWindowBounds windowState minimized (a second view; it gives no pick)",
  apiOverCover: "api: a cover window (focused) over the whole screen first, then windows.create with focused false and incognito true at 100,100: where Chrome puts a window that is not focused",
  behind: "cdp: the baseline's window, then a cover window of the default context over the whole screen",
  edge: "cdp: the baseline's window with half of it outside the screen's right edge (the most that chrome.windows allows)",
} as const;
export type OptionName = keyof typeof OPTIONS;
export const OPTION_NAMES = Object.keys(OPTIONS) as OptionName[];
/**
 * The options of each run, in their order. Run B (the sensor) measures only the options whose run-B facts the summary
 * reads, apiMinimized first (the pick needs its sensor and its front), so that one run of the probe holds both runs.
 */
export const RUN_OPTIONS: Record<RunName, readonly OptionName[]> = {
  A: ["front", "apiMinimized", "minimized", "apiOverCover", "behind", "edge"],
  B: ["apiMinimized", "front", "apiOverCover", "behind"],
};

/**
 * The probe's Chrome flags for run `run` on `profile`: the agent's flags, the pipe, the CDP load of an unpacked extension,
 * no keychain, and no crash reporter (`--disable-breakpad`, so that Chrome writes no crash database outside the profile:
 * assumed for Chrome stable on the Mac; the probe also stops a crash handler of its Chrome that is left: crashpadOf).
 */
export function chromeArgs(run: RunName, profile: string): string[] {
  const agent = run === "A" ? [...AGENT_ARGS] : AGENT_ARGS.filter((a) => a !== OCCLUSION_FLAG);
  return [`--user-data-dir=${profile}`, ...agent, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", "--use-mock-keychain",
    "--disable-breakpad", "--silent-debugger-extension-api", "--window-position=0,0", "--window-size=1000,700", "about:blank"];
}

// ------------------------------------------------------------------ the test extension

/** Chrome's id of an extension whose manifest `key` is the DER public key `der`: the first 16 bytes of its SHA-256, each hex digit as a to p. */
export function extensionIdOf(der: Buffer): string {
  return [...createHash("sha256").update(der).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

/**
 * The test extension's worker: chrome.windows only (the receiver's own calls of C10), each answer a plain object, and an
 * error as its message (the probe classes it; never its text into the JSON).
 */
export const EXTENSION_SW = `"use strict";
const winOf = (w) => ({ id: w.id, state: w.state, focused: w.focused, incognito: w.incognito, left: w.left, top: w.top, width: w.width, height: w.height, tab: w.tabs && w.tabs[0] ? w.tabs[0].id : null });
const wrap = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } };
self.probe = {
  allowed: () => wrap(() => chrome.extension.isAllowedIncognitoAccess()),
  create: (data) => wrap(async () => winOf(await chrome.windows.create(data))),
  get: (id) => wrap(async () => winOf(await chrome.windows.get(id, { populate: true }))),
  remove: (id) => wrap(() => chrome.windows.remove(id).then(() => true)),
};
`;

/** The test extension's manifest: MV3, the key that fixes its id, incognito spanning (as the receiver's), its worker. */
export function extensionManifest(keyB64: string): string {
  return JSON.stringify({ manifest_version: 3, name: "ab sign-in window probe", version: "1.0", key: keyB64, incognito: "spanning", background: { service_worker: "sw.js" } }, null, 2);
}

/** The profile's Preferences before a run: the extension allowed in incognito, as the Linux service writes the receiver's allow. */
export const prefsBefore = (id: string) => JSON.stringify({ extensions: { settings: { [id]: { incognito: true } } } });

/**
 * Where the profile keeps the extension's entry after a run, by a read of `Default/Secure Preferences` and
 * `Default/Preferences` (either may be null: missing or not readable): the file of the entry (Secure Preferences first,
 * as the service's access check reads them), and its `incognito`.
 */
export function entryFacts(secure: string | null, prefs: string | null, id: string): { entryIn: "Secure Preferences" | "Preferences" | "none" | "unknown"; incognito: boolean | null } {
  let unknown = false;
  for (const [name, text] of [["Secure Preferences", secure], ["Preferences", prefs]] as const) {
    if (text === null) { if (name === "Preferences") unknown = true; continue; }
    let o: any = null;
    try { o = JSON.parse(text); } catch { unknown = true; continue; }
    const e = o?.extensions?.settings?.[id];
    if (e && typeof e === "object" && !Array.isArray(e)) return { entryIn: name, incognito: typeof e.incognito === "boolean" ? e.incognito : null };
  }
  return { entryIn: unknown ? "unknown" : "none", incognito: null };
}

// ------------------------------------------------------------------ the local page

/**
 * The act window's page: a text field at FIELD, and a recorder in the page's own world (the probe's own page on
 * 127.0.0.1): rAF calls, a 10 ms timer's ticks, the visibility and focus events, and each key, input, mouse down and
 * click of the field. `__abProbe.measure(ms)` gives the counts of `ms`, an IntersectionObserver's callbacks on the field,
 * the visibility, the focus and the window's and screen's numbers; `start()` empties the field and the input counts;
 * `typed(expected)` gives whether the field holds `expected` (a flag and a length: never the text).
 */
export const ACT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>ab window probe</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#2a6f97;color:#fff;font:16px sans-serif}#f{position:fixed;left:${FIELD.x}px;top:${FIELD.y}px;width:${FIELD.w}px;height:${FIELD.h}px;border:0;margin:0;padding:0 6px;box-sizing:border-box;font-size:16px}p{position:fixed;left:40px;top:110px;margin:0}</style></head>
<body><input id="f" autocomplete="off" spellcheck="false"><p>agent-browser test page: a probe types plain test text here.</p><script>
(() => {
  const f = document.getElementById("f");
  const s = { raf: 0, ticks: 0, vis: 0, focus: 0, blur: 0, kd: 0, ku: 0, inp: 0, md: 0, clk: 0, untrusted: 0, kVis: 0, kHidden: 0, kFocus: 0, kNoFocus: 0 };
  const loop = () => { s.raf++; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  setInterval(() => { s.ticks++; }, 10);
  document.addEventListener("visibilitychange", () => { s.vis++; });
  addEventListener("focus", () => { s.focus++; });
  addEventListener("blur", () => { s.blur++; });
  const mark = (e) => { if (!e.isTrusted) s.untrusted++; };
  f.addEventListener("keydown", (e) => { s.kd++; mark(e); if (document.visibilityState === "visible") s.kVis++; else s.kHidden++; if (document.hasFocus()) s.kFocus++; else s.kNoFocus++; });
  f.addEventListener("keyup", (e) => { s.ku++; mark(e); });
  f.addEventListener("input", (e) => { s.inp++; mark(e); });
  f.addEventListener("mousedown", (e) => { s.md++; mark(e); });
  f.addEventListener("click", (e) => { s.clk++; mark(e); });
  let r0 = 0, t0 = 0;
  window.__abProbe = {
    measure(ms) {
      return new Promise((resolve) => {
        const a = s.raf, b = s.ticks, start = performance.now();
        let ioN = 0, io = null, ob = null;
        try { ob = new IntersectionObserver((es) => { ioN += es.length; io = es[es.length - 1].isIntersecting; }); ob.observe(f); } catch (e) {}
        setTimeout(() => {
          if (ob) ob.disconnect();
          resolve({ vis: document.visibilityState, focus: document.hasFocus(), raf: s.raf - a, ticks: s.ticks - b, ms: Math.round(performance.now() - start), ioN, io,
            sx: screenX, sy: screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight, sw: screen.width, sh: screen.height,
            aw: screen.availWidth, ah: screen.availHeight, al: screen.availLeft, at: screen.availTop, dpr: devicePixelRatio, visChanges: s.vis });
        }, ms);
      });
    },
    start() { f.value = ""; for (const k of ["kd", "ku", "inp", "md", "clk", "untrusted", "kVis", "kHidden", "kFocus", "kNoFocus"]) s[k] = 0; r0 = s.raf; t0 = performance.now(); return true; },
    typed(expected) {
      return { equal: f.value === expected, length: f.value.length, active: document.activeElement === f, keydown: s.kd, keyup: s.ku, input: s.inp, mousedown: s.md, click: s.clk,
        untrusted: s.untrusted, keysVisible: s.kVis, keysHidden: s.kHidden, keysFocus: s.kFocus, keysNoFocus: s.kNoFocus, raf: s.raf - r0, ms: Math.round(performance.now() - t0),
        vis: document.visibilityState, focus: document.hasFocus(), visChanges: s.vis, focusEvents: s.focus, blurEvents: s.blur };
    },
  };
})();
</script></body></html>`;

/** The cover window's page: a plain page of one colour. */
export const COVER_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>ab window probe cover</title><style>html,body{margin:0;height:100%;background:#444;color:#ddd;font:16px sans-serif}p{margin:40px}</style></head><body><p>agent-browser test page: a cover window of a probe.</p></body></html>`;

/** The page server's answer for a request: the page and its status, by the path (no query) and the Host header. */
export function pageFor(path: string, host: string | undefined, port: number): { status: number; body: string } {
  if (host !== `127.0.0.1:${port}`) return { status: 421, body: "" };
  const p = path.split("?")[0];
  if (p === "/act") return { status: 200, body: ACT_PAGE };
  if (p === "/cover") return { status: 200, body: COVER_PAGE };
  return { status: 404, body: "" };
}

// ------------------------------------------------------------------ the input

/** One CDP key event pair of a character of the test text (a to z, 0 to 9, space): keyDown with its text, keyUp. */
export function keyEvents(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const ch of text) {
    let code: string, vk: number;
    if (/^[a-z]$/.test(ch)) { code = `Key${ch.toUpperCase()}`; vk = ch.toUpperCase().charCodeAt(0); }
    else if (/^[0-9]$/.test(ch)) { code = `Digit${ch}`; vk = ch.charCodeAt(0); }
    else if (ch === " ") { code = "Space"; vk = 32; }
    else throw new Error("the test text holds only a to z, 0 to 9 and spaces");
    const base = { key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 0 };
    out.push({ type: "keyDown", ...base, text: ch, unmodifiedText: ch }, { type: "keyUp", ...base });
  }
  return out;
}

/** The centre of the text field, where the probe clicks. */
export const FIELD_CENTRE = { x: FIELD.x + FIELD.w / 2, y: FIELD.y + FIELD.h / 2 };

// ------------------------------------------------------------------ the front app (JXA, the give-back's calls only)

/**
 * The pid of the app in front (0: none). The same AppKit calls as the service's give-back guard (src/giveback.ts,
 * measured on the Mac with no prompt): NSWorkspace's frontmostApplication; no Apple Event, no input, no System Events.
 */
export const FRONT_JXA = `ObjC.import("AppKit");
function run(argv) {
  const a = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (a === undefined || a === null || (typeof a.isNil === "function" && a.isNil())) return "front=0";
  const p = a.processIdentifier;
  return "front=" + (typeof p === "number" && p > 0 ? p : 0);
}`;

/** Ask macOS to activate the app of pid argv[0] (activateWithOptions(0), as the give-back guard asks): "asked", "refused" or "gone". */
export const GIVE_BACK_JXA = `ObjC.import("AppKit");
function run(argv) {
  if (argv.length !== 1 || !/^[1-9][0-9]{0,8}$/.test(argv[0])) return "give-back=usage";
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
  if (app === undefined || app === null || (typeof app.isNil === "function" && app.isNil()) || app.isTerminated) return "give-back=gone";
  return "give-back=" + (app.activateWithOptions(0) ? "asked" : "refused");
}`;

/** osascript's argv for a constant JXA script and its arguments (numbers only). */
export const jxaArgs = (script: string, args: readonly string[] = []): string[] => ["-l", "JavaScript", "-e", script, ...args];

/** The front app's pid of a FRONT_JXA run, or null when it did not read. */
export function frontPid(r: ToolRun): number | null {
  if (runClass(r) !== "ok") return null;
  const m = /^front=([0-9]{1,9})$/m.exec(r.stdout.trim());
  return m ? Number(m[1]) : null;
}

/** A GIVE_BACK_JXA run's answer, or its run's class. */
export function giveBackOf(r: ToolRun): string {
  if (runClass(r) !== "ok") return runClass(r);
  const m = /^give-back=(asked|refused|gone|usage)$/m.exec(r.stdout.trim());
  return m ? m[1] : "an unknown text";
}

/** Who is in front, by pid: the probe's Chrome, another app, or none; null when it did not read. */
export const frontOf = (pid: number | null, chrome: number | null): "chrome" | "other" | "none" | null =>
  pid === null ? null : pid === 0 ? "none" : chrome !== null && pid === chrome ? "chrome" : "other";

/** Whether a window's creation took the front: from another app to the probe's Chrome; null when it cannot tell (Chrome was in front before, or a read failed). */
export function tookFront(before: "chrome" | "other" | "none" | null, after: "chrome" | "other" | "none" | null): boolean | null {
  if (before === null || after === null || before === "chrome") return null;
  return after === "chrome";
}

// ------------------------------------------------------------------ the rights helper (helper.ts)

/** The helper's answer: CGPreflightScreenCaptureAccess and AXIsProcessTrusted of a program that an agent's shell runs. */
export type Rights = { screenRecording: boolean | null; accessibility: boolean | null; failed: string | null };

/** The helper's stdout, as Rights; null when it is not the helper's one line. */
export function parseRights(text: string): Rights | null {
  let o: any;
  try { o = JSON.parse(text.trim()); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const tri = (v: unknown) => (typeof v === "boolean" ? v : null);
  return { screenRecording: tri(o.screenRecording), accessibility: tri(o.accessibility), failed: typeof o.failed === "string" ? clean(o.failed).slice(0, 120) : null };
}

// ------------------------------------------------------------------ the taskport right

// The parser of the right and its meaning moved into the service (src/service/signins/mac-tools.ts; board
// ab-v16.97.15, part 2): the protected start and its background reader read the right with it. The probe reads it the
// same way.
export { KNOWN_GROUPS, KNOWN_RULES, parseTaskport, plistDict, taskportMeaning, type PlistValue, type TaskportMeaning } from "../../../src/service/signins/mac-tools.ts";

// ------------------------------------------------------------------ the reads of a window

/** The page's measure, as JSON: numbers, the visibility word and flags only. */
export function measureJson(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const n = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? Math.round((o[k] as number) * 100) / 100 : null);
  const vis = o.vis === "visible" || o.vis === "hidden" ? o.vis : o.vis === undefined ? null : "other";
  return {
    vis, focus: typeof o.focus === "boolean" ? o.focus : null, raf: n("raf"), ticks: n("ticks"), ms: n("ms"), ioN: n("ioN"), io: typeof o.io === "boolean" ? o.io : null,
    screenX: n("sx"), screenY: n("sy"), outerWidth: n("ow"), outerHeight: n("oh"), innerWidth: n("iw"), innerHeight: n("ih"),
    screenWidth: n("sw"), screenHeight: n("sh"), availWidth: n("aw"), availHeight: n("ah"), availLeft: n("al"), availTop: n("at"), dpr: n("dpr"), visChanges: n("visChanges"),
  };
}

/** The page's record of the typing, as JSON (a flag and counts; never the field's text). */
export function typedJson(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const n = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : null);
  const b = (k: string) => (typeof o[k] === "boolean" ? (o[k] as boolean) : null);
  const vis = o.vis === "visible" || o.vis === "hidden" ? o.vis : null;
  return {
    equal: b("equal"), length: n("length"), active: b("active"), keydown: n("keydown"), keyup: n("keyup"), input: n("input"), mousedown: n("mousedown"), click: n("click"),
    untrusted: n("untrusted"), keysVisible: n("keysVisible"), keysHidden: n("keysHidden"), keysFocus: n("keysFocus"), keysNoFocus: n("keysNoFocus"), raf: n("raf"), ms: n("ms"),
    vis, focus: b("focus"), visChanges: n("visChanges"), focusEvents: n("focusEvents"), blurEvents: n("blurEvents"),
  };
}

/** Browser.getWindowForTarget's bounds, as JSON. */
export function boundsJson(v: unknown): Record<string, unknown> | null {
  const b = (v as { bounds?: Record<string, unknown> } | null)?.bounds;
  if (!b || typeof b !== "object") return null;
  const n = (k: string) => (typeof b[k] === "number" && Number.isFinite(b[k]) ? (b[k] as number) : null);
  const state = typeof b.windowState === "string" && ["normal", "minimized", "maximized", "fullscreen"].includes(b.windowState) ? b.windowState : null;
  return { state, left: n("left"), top: n("top"), width: n("width"), height: n("height") };
}

/** A chrome.windows window of the extension, as JSON (no tab id, no window id). */
export function extWindowJson(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const n = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : null);
  const b = (k: string) => (typeof o[k] === "boolean" ? (o[k] as boolean) : null);
  const state = typeof o.state === "string" && ["normal", "minimized", "maximized", "fullscreen", "locked-fullscreen"].includes(o.state) ? o.state : null;
  return { state, focused: b("focused"), incognito: b("incognito"), left: n("left"), top: n("top"), width: n("width"), height: n("height") };
}

/**
 * The class of a chrome.windows error (never its text), by Chrome's own error texts only: the 50% rule ("Invalid value
 * for bounds. Bounds must be at least 50% within visible screen space."), a state that does not combine ("Invalid value
 * for state"), incognito mode ("Incognito mode is disabled." or "... is forced."); every other text is "other".
 */
export function windowErrorClass(message: string): string {
  if (/Bounds must be at least 50% within visible screen space/.test(message)) return "the 50% rule";
  if (/^Invalid value for state\b/.test(message)) return "a state that does not combine";
  if (/^Incognito mode is (?:disabled|forced)\b/.test(message)) return "no incognito";
  return "other";
}

/** The class of a CDP error (never its text): a timeout, the pipe's end, or a short fixed word of the message. */
export function callErrorClass(message: string): string {
  if (message === "timeout") return "timeout";
  if (message === "the pipe closed") return "the pipe closed";
  if (/not allowed/i.test(message)) return "not allowed";
  if (/not found|no target|no such/i.test(message)) return "not found";
  if (/wasn't found|not supported|unknown method/i.test(message)) return "no such method";
  if (/invalid|expected/i.test(message)) return "invalid";
  return "other";
}

/** The version of Browser.getVersion's `product` ("Chrome/158.0.8127.37", "HeadlessChrome/..."), or null. */
export function chromeVersionOf(product: unknown): string | null {
  const m = typeof product === "string" ? /\/([0-9]{1,6}(?:\.[0-9]{1,6}){3})$/.exec(product) : null;
  return m ? m[1] : null;
}

// ------------------------------------------------------------------ the verdicts and the summary

/** One option's reads in a run (probe.ts fills it). */
export type OptionJson = {
  made: string; ms: number | null; window: Record<string, unknown> | null; ext: Record<string, unknown> | null; front: { before: string | null; after: string | null; took: boolean | null } | null;
  measure: Record<string, unknown> | null; typed: Record<string, unknown> | null; hangs: number; after: Record<string, unknown> | null;
};

/**
 * Whether the site sees a visible page (run A): visibilityState visible, rAF and the 10 ms timer at a page's rate, and
 * an IntersectionObserver that ran. False for a hidden page, or a visible one with no frames or slow timers (`why`).
 */
export function siteVisible(m: Record<string, unknown> | null): { visible: boolean | null; why: string | null } {
  if (!m || m.vis === null) return { visible: null, why: "not measured" };
  if (m.vis !== "visible") return { visible: false, why: "the page is hidden" };
  // A visible page with a read that is not a number is not measured: an unmeasured fact never counts as a pass.
  const missing = (["raf", "ticks", "ioN"] as const).filter((k) => typeof m[k] !== "number");
  if (missing.length) return { visible: null, why: `not measured: ${missing.join(", ")}` };
  const why = [
    ...(typeof m.raf === "number" && m.raf < RAF_MIN ? ["few animation frames"] : []),
    ...(typeof m.ticks === "number" && m.ticks < TICKS_MIN ? ["slow timers"] : []),
    ...(m.ioN === 0 ? ["no IntersectionObserver callback"] : []),
  ];
  return why.length ? { visible: false, why: why.join(", ") } : { visible: true, why: null };
}

/** Whether the act's input path arrived: the field holds the whole test text, each key came as a trusted event, and no call hung. */
export function inputArrived(t: Record<string, unknown> | null, hangs: number): { arrived: boolean | null; why: string | null } {
  if (!t) return { arrived: null, why: hangs > 0 ? "an input call got no answer in time" : "not measured" };
  const why = [
    ...(hangs > 0 ? ["an input call got no answer in time"] : []),
    ...(t.equal !== true ? ["the field does not hold the test text"] : []),
    ...(t.keydown !== TEST_TEXT.length ? ["not every key came"] : []),
    ...(t.untrusted !== 0 ? ["an event was not trusted"] : []),
  ];
  return why.length ? { arrived: false, why: why.join(", ") } : { arrived: true, why: null };
}

/** The sensor (run B): whether macOS shows the window on the screen (at least a part of it): its page is visible there. */
export const seenOf = (m: Record<string, unknown> | null): boolean | null => (!m || m.vis === null ? null : m.vis === "visible");

/** A run as the summary reads it: whether its Chrome started, and its options. */
export type RunJson = { started?: boolean; options?: Record<string, OptionJson | null> } | null | undefined;

/** One fact of the pick's rule: true passes, false fails, null is not measured. */
export type Fact = { name: string; value: boolean | null };

/** A flag that is a boolean, else null: an unmeasured fact never counts as a pass. */
const tri = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const not = (v: boolean | null): boolean | null => (v === null ? null : !v);

/**
 * The facts of the pick "minimized" (the design note's rule, 4.4), each one measured or null, of the act window's own
 * form (apiMinimized: windows.create with state minimized, focused false, incognito true): run B started; the window is
 * incognito in run A and in run B (its own flag of windows.get: a window that is not incognito measures another kind of
 * window, so it is not measured; run B gets no Preferences write, so its allow comes only by the switch); its state is
 * minimized (windows.get in run A and in run B, the state that the act checks); the page is visible to the
 * site and the input arrives (run A); no key came while the page was hidden (run A); the create took no front (run A and
 * run B); macOS does not show the window (run B, the sensor).
 */
export function minimizedFacts(runs: Partial<Record<RunName, RunJson>>): Fact[] {
  const oa = runs.A?.options?.apiMinimized ?? null, ob = runs.B?.options?.apiMinimized ?? null;
  const madeA = oa?.made === "ok", madeB = ob?.made === "ok";
  const hidden = typeof oa?.typed?.keysHidden === "number" ? (oa.typed.keysHidden as number) === 0 : null;
  const state = typeof oa?.ext?.state === "string" ? oa.ext.state === "minimized" : null;
  const stateB = typeof ob?.ext?.state === "string" ? ob.ext.state === "minimized" : null;
  return [
    { name: "run A started", value: runs.A?.started === true ? true : null },
    { name: "run B started", value: runs.B?.started === true ? true : null },
    { name: "apiMinimized made in run A", value: madeA ? true : null },
    { name: "apiMinimized made in run B", value: madeB ? true : null },
    { name: "an incognito window in run A", value: madeA && oa?.ext?.incognito === true ? true : null },
    { name: "an incognito window in run B", value: madeB && ob?.ext?.incognito === true ? true : null },
    { name: "the state minimized in run A", value: madeA ? state : null },
    { name: "the state minimized in run B", value: madeB ? stateB : null },
    { name: "visible to the site in run A", value: madeA ? siteVisible(oa!.measure).visible : null },
    { name: "the input in run A", value: madeA ? inputArrived(oa!.typed, oa!.hangs).arrived : null },
    { name: "no key on a hidden page in run A", value: madeA ? hidden : null },
    { name: "no front taken in run A", value: madeA ? not(tri(oa?.front?.took)) : null },
    { name: "no front taken in run B", value: madeB ? not(tri(ob?.front?.took)) : null },
    { name: "not seen in run B", value: madeB ? not(seenOf(ob!.measure)) : null },
  ];
}

/** Whether an option of run A holds as the fallback's baseline: the page visible to the site, the input, no key on a hidden page; null when not measured. */
export function baselineHolds(o: OptionJson | null | undefined): boolean | null {
  if (!o || o.made !== "ok") return null;
  const parts = [siteVisible(o.measure).visible, inputArrived(o.typed, o.hangs).arrived, typeof o.typed?.keysHidden === "number" ? (o.typed.keysHidden as number) === 0 : null];
  return parts.includes(false) ? false : parts.includes(null) ? null : true;
}

/**
 * The summary: for each option the site's view (run A), the input (run A), the window's own incognito flag and state,
 * the keys on a hidden page, the sensor (run B: whether macOS shows the window) and whether the create took the front;
 * and the pick of the design note's rule (4.4):
 * - `minimized` when every fact of minimizedFacts is measured and passes;
 * - else, when a fact is measured and fails, `on the screen` (the fallback: a normal window, focused false) when a
 *   baseline holds (`front`, made by CDP, or `apiOverCover`, made by windows.create with focused false: the fallback's
 *   own call), `none` when both baselines are measured and fail, else `not measured`;
 * - else (no fact fails, one or more are null) `not measured`, with the names of the facts that were not measured.
 * A fact that is not measured never counts as a pass.
 */
export function summaryOf(runs: Partial<Record<RunName, RunJson>>): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const name of OPTION_NAMES) {
    const oa = runs.A?.options?.[name] ?? null, ob = runs.B?.options?.[name] ?? null;
    const sv = siteVisible(oa?.measure ?? null), ia = inputArrived(oa?.typed ?? null, oa?.hangs ?? 0);
    options[name] = {
      made: oa?.made ?? null, siteVisible: sv.visible, siteWhy: sv.why, input: ia.arrived, inputWhy: ia.why,
      incognito: tri(oa?.ext?.incognito), state: typeof oa?.ext?.state === "string" ? oa.ext.state : typeof oa?.window?.state === "string" ? oa.window.state : null,
      keysHidden: typeof oa?.typed?.keysHidden === "number" ? oa.typed.keysHidden : null,
      seen: seenOf(ob?.measure ?? null), seenWhileTyping: typeof ob?.typed?.keysVisible === "number" ? (ob.typed.keysVisible as number) > 0 : null,
      tookFront: tri(oa?.front?.took), tookFrontB: tri(ob?.front?.took),
    };
  }
  const facts = minimizedFacts(runs);
  const failed = facts.filter((f) => f.value === false).map((f) => f.name), unknown = facts.filter((f) => f.value === null).map((f) => f.name);
  const bases = { front: baselineHolds(runs.A?.options?.front), apiOverCover: baselineHolds(runs.A?.options?.apiOverCover) };
  const base = bases.front === true ? "front" : bases.apiOverCover === true ? "apiOverCover" : null;
  let pick: "minimized" | "on the screen" | "none" | "not measured", why: string;
  if (!failed.length && !unknown.length) { pick = "minimized"; why = "apiMinimized: every fact of the rule is measured and holds"; }
  else if (failed.length && base) { pick = "on the screen"; why = `apiMinimized fails: ${failed.join(", ")}; the baseline ${base} holds`; }
  else if (failed.length && bases.front === false && bases.apiOverCover === false) { pick = "none"; why = `apiMinimized fails: ${failed.join(", ")}; both baselines fail`; }
  else if (failed.length) { pick = "not measured"; why = `apiMinimized fails: ${failed.join(", ")}; not measured: a baseline (front, apiOverCover)`; }
  else { pick = "not measured"; why = `not measured: ${unknown.join(", ")}`; }
  return { options, facts: Object.fromEntries(facts.map((f) => [f.name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32), f.value])), failed, notMeasured: unknown, pick, pickWhy: why.slice(0, 300) };
}

// ------------------------------------------------------------------ the pipe

/**
 * The pipe's frames (`--remote-debugging-pipe`: each message is JSON with a NUL after it): the whole messages of `rest`
 * and `chunk`, and the unfinished rest. A rest above FRAME_MAX_BYTES throws (no message of Chrome is so large).
 */
export function splitFrames(rest: Buffer, chunk: Buffer): { frames: string[]; rest: Buffer } {
  let buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
  const frames: string[] = [];
  for (let at = buf.indexOf(0); at >= 0; at = buf.indexOf(0)) { frames.push(buf.subarray(0, at).toString("utf8")); buf = buf.subarray(at + 1); }
  if (buf.length > FRAME_MAX_BYTES) throw new Error("a message of the pipe is too large");
  return { frames, rest: Buffer.from(buf) };
}

/**
 * The stand-in browser of the Linux dry run (`node -e`): it reads the pipe on fd 3 and writes on fd 4 as Chrome does.
 * Browser.getVersion answers a product, Browser.close answers and exits (unless argv[1] is "stay": then it ignores the
 * close and waits for its kill), every other method gets an error.
 */
export const STANDIN_BROWSER = `const fs = require("node:fs");
const stay = process.argv[1] === "stay";
let rest = Buffer.alloc(0);
const send = (m) => fs.writeSync(4, JSON.stringify(m) + "\\0");
fs.createReadStream(null, { fd: 3 }).on("data", (d) => {
  rest = Buffer.concat([rest, d]);
  for (let at = rest.indexOf(0); at >= 0; at = rest.indexOf(0)) {
    const m = JSON.parse(rest.subarray(0, at).toString("utf8"));
    rest = rest.subarray(at + 1);
    if (m.method === "Browser.getVersion") send({ id: m.id, result: { product: "StandIn/1.0.0.0" } });
    else if (m.method === "Browser.close") { send({ id: m.id, result: {} }); if (!stay) process.exit(0); }
    else send({ id: m.id, error: { code: -32601, message: "'" + m.method + "' wasn't found" } });
  }
});
setInterval(() => {}, 1000);
`;

// ------------------------------------------------------------------ the result

/** The top-level keys of every result, in their order. */
export const RESULT_KEYS = ["probe", "version", "commit", "dirty", "ok", "stage", "reason", "detail", "ms", "platform", "taskport", "rights", "chrome", "runs", "summary", "dry", "cleanup", "redacted"] as const;

/** The result, with its keys in a fixed order. `ok` is true only when every part ran on the Mac and nothing of the probe stayed. */
export function resultOf(o: {
  meta: Meta; platform: Platform | null; ok: boolean; stage: string; reason: string | null; detail?: string | null; ms: number;
  taskport?: unknown; rights?: unknown; chrome?: unknown; runs?: unknown; summary?: unknown; dry?: unknown; cleanup?: unknown;
}) {
  return {
    probe: "mac-signin-window-probe", version: o.meta.version, commit: o.meta.commit, dirty: o.meta.dirty,
    ok: o.ok, stage: o.stage, reason: o.reason, detail: o.detail ?? null, ms: o.ms, platform: o.platform,
    taskport: o.taskport ?? null, rights: o.rights ?? null, chrome: o.chrome ?? null, runs: o.runs ?? null, summary: o.summary ?? null, dry: o.dry ?? null,
    cleanup: o.cleanup ?? null,
    /** The count of strings that the scrub changed (the probe sets it). */
    redacted: 0,
  };
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The result's check: the top-level keys of resultOf; every value a finite number, a flag, null, or a string of at most
 * 300 printable ASCII characters with no `/`, `\` or `@` (so no path, URL or address) and no run of 41 or more letters
 * and digits (no long id, no key); every key a short word; at most RESULT_MAX_BYTES. Null when it passes, else the place
 * of the first value that fails.
 */
export function checkResult(result: unknown): string | null {
  const walk = (v: unknown, at: string): string | null => {
    if (v === null || typeof v === "boolean") return null;
    if (typeof v === "number") return Number.isFinite(v) ? null : at;
    if (typeof v === "string") return /^[\x20-\x7e]{0,300}$/.test(v) && !/[/\\@]/.test(v) && !/[A-Za-z0-9_+=-]{41,}/.test(v) ? null : at;
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const bad = walk(v[i], `${at}[${i}]`); if (bad) return bad; } return null; }
    if (obj(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (!/^[A-Za-z0-9_]{1,32}$/.test(k)) return `${at}.<key>`;
        const bad = walk(x, at ? `${at}.${k}` : k);
        if (bad) return bad;
      }
      return null;
    }
    return at || "<root>";
  };
  if (!obj(result)) return "<root>";
  const keys = Object.keys(result);
  if (keys.length !== RESULT_KEYS.length || keys.some((k, i) => k !== RESULT_KEYS[i])) return "<keys>";
  if (typeof result.ok !== "boolean") return "ok";
  const bad = walk(result, "");
  if (bad) return bad;
  return Buffer.byteLength(JSON.stringify(result)) <= RESULT_MAX_BYTES ? null : "<size>";
}

/**
 * The result with each value that fails the check's rules masked (a string as "<masked>", a number that is not finite
 * as null, a key that is not a short word dropped), and the places that it masked: one bad value then costs only that
 * value, not the run's data. The top-level keys and the size stay checkResult's (a result that still fails is replaced).
 */
export function maskResult(result: Record<string, unknown>): { value: Record<string, unknown>; masked: string[] } {
  const masked: string[] = [];
  const walk = (v: unknown, at: string): unknown => {
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") { if (Number.isFinite(v)) return v; masked.push(at); return null; }
    if (typeof v === "string") {
      if (/^[\x20-\x7e]{0,300}$/.test(v) && !/[/\\@]/.test(v) && !/[A-Za-z0-9_+=-]{41,}/.test(v)) return v;
      masked.push(at);
      return "<masked>";
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${at}[${i}]`));
    if (obj(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (!/^[A-Za-z0-9_]{1,32}$/.test(k)) { masked.push(`${at}.<key>`); continue; }
        out[k] = walk(x, at ? `${at}.${k}` : k);
      }
      return out;
    }
    masked.push(at || "<root>");
    return null;
  };
  return { value: walk(result, "") as Record<string, unknown>, masked };
}

// ------------------------------------------------------------------ the crash handler (m2)

/** One row of `ps -A -o pid=,ppid=,etime=,comm=`: its pid, its parent, its age in seconds, and its program's last name. */
export type PsRow = { pid: number; ppid: number; ageS: number; name: string };
/** The name of Chrome's crash handler (Linux's comm keeps its first 15 characters). */
export const CRASHPAD = "chrome_crashpad_handler";

/** ps's `etime`, [[dd-]hh:]mm:ss, in seconds; null for another form. */
export function etimeSeconds(t: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/** The rows of `ps -A -o pid=,ppid=,etime=,comm=` (comm can hold spaces: the rest of the line is its path or name). */
export function parsePs(text: string): PsRow[] {
  const out: PsRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const age = etimeSeconds(m[3]);
    if (age === null) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), ageS: age, name: m[4].slice(m[4].lastIndexOf("/") + 1) });
  }
  return out;
}

/**
 * The crash handlers of the probe's Chrome: a process whose parent is that Chrome's main process, whose name is
 * CRASHPAD (or its first 15 characters), and that is not older than that Chrome (its age, plus 2 s): the probe's own
 * child's child, never another Chrome's (the crash handler calls setsid, so the group kill does not reach it).
 */
export function crashpadOf(rows: readonly PsRow[], chromePid: number, chromeAgeS: number): number[] {
  return rows.filter((r) => r.ppid === chromePid && (r.name === CRASHPAD || r.name === CRASHPAD.slice(0, 15)) && r.ageS <= chromeAgeS + 2).map((r) => r.pid);
}

/** The same handler later (after its Chrome ended): the pid still runs CRASHPAD, and it is at least as old as at its find (a new process of that pid is younger). */
export const sameHandler = (rows: readonly PsRow[], pid: number, ageAtFind: number): boolean =>
  rows.some((r) => r.pid === pid && (r.name === CRASHPAD || r.name === CRASHPAD.slice(0, 15)) && r.ageS >= ageAtFind);

/** A skipped step, as JSON. */
export const skipped = (why: string) => ({ made: `skipped: ${why}` });
