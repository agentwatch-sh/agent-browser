// The Mac sign-in window probe (test/live/mac-signin-window-probe/; board ab-v16.97.14, part 1): its pure parts
// (parts.ts) with made-up outputs of Apple's tools (security authorizationdb read, the JXA front reads, the rights
// helper), the probe's Chrome flags, the test extension, the local page, the key events, the verdicts, the summary and
// its pick, the pipe's frames, and the result's shape and check; and on Linux the probe itself: its dry run (the folder,
// the extension, the page server, the pipe client against a stand-in browser, the cleanup), its refusal of an argument
// and of a reserved twin display, and the rights helper's answer off the Mac.
//
// The tools' outputs here are NOT measured: they are written from Apple's man pages and the tools' usual output as known
// on the Linux server. The Mac run checks them. No test here starts Chrome, Chromium or Xvfb.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { AGENT_ARGS } from "../src/agent.ts";
import { extensionId } from "../src/service/package/crx.ts";
import { tempDir, done } from "./temp-dirs.ts";
import {
  ACT_BOUNDS, ACT_PAGE, COVER_PAGE, EXPECTED_TEXT, EXTENSION_SW, FIELD, FIELD_CENTRE, FRONT_JXA, GIVE_BACK_JXA, OCCLUSION_FLAG, OPTION_NAMES, OPTIONS,
  CRASHPAD, HOLD_ENV, RESULT_KEYS, RUN_OPTIONS, RUNS, STANDIN_BROWSER, TEST_TEXT, TIME_LIMIT_MS, TWIN_ENV,
  baselineHolds, crashpadOf, etimeSeconds, holdMs, maskResult, minimizedFacts, parsePs, sameHandler,
  boundsJson, callErrorClass, checkResult, chromeArgs, chromeVersionOf, entryFacts, extensionIdOf, extensionManifest, extWindowJson, frontOf, frontPid,
  giveBackOf, inputArrived, jxaArgs, keyEvents, measureJson, pageFor, parseRights, parseTaskport, plistDict, prefsBefore, resultOf, scrub, seenOf,
  siteVisible, splitFrames, summaryOf, taskportMeaning, tookFront, typedJson, windowErrorClass,
  type Meta, type OptionJson, type ToolRun,
} from "./live/mac-signin-window-probe/parts.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PROBE = fileURLToPath(new URL("./live/mac-signin-window-probe/probe.ts", import.meta.url));
const HELPER = fileURLToPath(new URL("./live/mac-signin-window-probe/helper.ts", import.meta.url));
const META: Meta = { version: 1, commit: "0123456789abcdef0123456789abcdef01234567", dirty: false };
const run = (text: string, exit: number | null = 0, more: Partial<ToolRun> = {}): ToolRun => ({ exit, signal: null, timedOut: false, stopped: null, spawnError: null, stdout: text, stderr: "", ms: 9, ...more });

// ------------------------------------------------------------------ the Chrome runs and the flags

test("the probe's Chrome: the agent's flags (run A) and the sensor without the occlusion flag (run B); the pipe, no port, no automation, no headless", () => {
  assert.deepEqual(Object.keys(RUNS), ["A", "B"]);
  assert.ok(AGENT_ARGS.includes(OCCLUSION_FLAG), "the agent's flags hold the occlusion flag");
  const a = chromeArgs("A", "/tmp/p"), b = chromeArgs("B", "/tmp/p");
  for (const f of AGENT_ARGS) assert.ok(a.includes(f), f);
  assert.ok(!b.includes(OCCLUSION_FLAG) && AGENT_ARGS.filter((f) => f !== OCCLUSION_FLAG).every((f) => b.includes(f)));
  for (const args of [a, b]) {
    assert.equal(args[0], "--user-data-dir=/tmp/p");
    for (const f of ["--remote-debugging-pipe", "--enable-unsafe-extension-debugging", "--use-mock-keychain", "--disable-breakpad"]) assert.ok(args.includes(f), f);
    assert.ok(!args.some((x) => /^--(remote-debugging-port|enable-automation|headless|load-extension|profile-directory)/.test(x)), args.join(" "));
    assert.equal(args.at(-1), "about:blank");
  }
});

test("the options: their order (the baseline and the minimized window first), each made by CDP or by the receiver's own call (api)", () => {
  assert.deepEqual(OPTION_NAMES, ["front", "apiMinimized", "minimized", "apiOverCover", "behind", "edge"], "the options that decide the pick come first; no option that no receiver call can make");
  for (const n of OPTION_NAMES) assert.match(OPTIONS[n], n.startsWith("api") ? /^api: / : /^cdp: /);
  assert.deepEqual(RUN_OPTIONS.A, OPTION_NAMES);
  assert.deepEqual(RUN_OPTIONS.B, ["apiMinimized", "front", "apiOverCover", "behind"], "run B: the options whose run-B facts the summary reads, apiMinimized first");
  assert.ok(TIME_LIMIT_MS <= 120_000);
});

// ------------------------------------------------------------------ the test extension

test("the test extension: its id is Chrome's id of its key (as crx.ts computes it); MV3, incognito spanning, chrome.windows only", () => {
  const der = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const id = extensionIdOf(der);
  assert.match(id, /^[a-p]{32}$/);
  assert.equal(id, extensionId(der.toString("base64")));
  const m = JSON.parse(extensionManifest(der.toString("base64")));
  assert.deepEqual([m.manifest_version, m.incognito, m.background.service_worker, m.key], [3, "spanning", "sw.js", der.toString("base64")]);
  assert.equal(m.permissions, undefined, "no permission: chrome.windows needs none");
  const calls = [...EXTENSION_SW.matchAll(/chrome\.([a-zA-Z]+)\.([a-zA-Z]+)/g)].map((x) => `${x[1]}.${x[2]}`);
  assert.deepEqual([...new Set(calls)].sort(), ["extension.isAllowedIncognitoAccess", "windows.create", "windows.get", "windows.remove"]);
});

test("the profile's Preferences before a run, and where the entry is after it (Secure Preferences first)", () => {
  const id = "a".repeat(32);
  assert.deepEqual(JSON.parse(prefsBefore(id)), { extensions: { settings: { [id]: { incognito: true } } } });
  const entry = (o: unknown) => JSON.stringify({ extensions: { settings: { [id]: o } } });
  assert.deepEqual(entryFacts(entry({ incognito: false, path: "x" }), entry({ incognito: true }), id), { entryIn: "Secure Preferences", incognito: false });
  assert.deepEqual(entryFacts(entry({ path: "x" }), null, id), { entryIn: "Secure Preferences", incognito: null });
  assert.deepEqual(entryFacts(null, entry({ incognito: true }), id), { entryIn: "Preferences", incognito: true });
  assert.deepEqual(entryFacts("{}", "{}", id), { entryIn: "none", incognito: null });
  assert.deepEqual(entryFacts(null, null, id), { entryIn: "unknown", incognito: null });
  assert.deepEqual(entryFacts("not json", "{}", id), { entryIn: "unknown", incognito: null });
});

// ------------------------------------------------------------------ the page and the input

test("the local page: the field at FIELD, the recorder, no other origin; the server's answers by path and Host", () => {
  assert.ok(ACT_PAGE.includes(`left:${FIELD.x}px;top:${FIELD.y}px;width:${FIELD.w}px;height:${FIELD.h}px`));
  for (const fn of ["measure(ms)", "start()", "typed(expected)", "IntersectionObserver", "requestAnimationFrame", "isTrusted"]) assert.ok(ACT_PAGE.includes(fn), fn);
  for (const p of [ACT_PAGE, COVER_PAGE]) assert.ok(!/https?:|src=|href=/.test(p), "no other origin, no resource");
  assert.deepEqual([...new Set(ACT_PAGE.match(/f\.value[^;,]*/g))].sort(), ['f.value = ""', "f.value === expected", "f.value.length"], "the recorder never gives the field's text, only a flag and a length");
  assert.deepEqual(FIELD_CENTRE, { x: FIELD.x + FIELD.w / 2, y: FIELD.y + FIELD.h / 2 });
  assert.deepEqual(pageFor("/act?w=A-front", "127.0.0.1:5000", 5000), { status: 200, body: ACT_PAGE });
  assert.deepEqual(pageFor("/cover", "127.0.0.1:5000", 5000), { status: 200, body: COVER_PAGE });
  assert.equal(pageFor("/x", "127.0.0.1:5000", 5000).status, 404);
  assert.equal(pageFor("/act", "localhost:5000", 5000).status, 421, "only the probe's own Host");
  assert.equal(pageFor("/act", undefined, 5000).status, 421);
});

test("the key events of the test text: a keyDown with its text and a keyUp for each character; only a to z, digits and space", () => {
  const evs = keyEvents(TEST_TEXT);
  assert.equal(evs.length, TEST_TEXT.length * 2);
  assert.deepEqual(evs[0], { type: "keyDown", key: "p", code: "KeyP", windowsVirtualKeyCode: 80, nativeVirtualKeyCode: 80, modifiers: 0, text: "p", unmodifiedText: "p" });
  assert.deepEqual(evs[1], { type: "keyUp", key: "p", code: "KeyP", windowsVirtualKeyCode: 80, nativeVirtualKeyCode: 80, modifiers: 0 });
  assert.deepEqual(keyEvents(" 4").map((e) => e.code), ["Space", "Space", "Digit4", "Digit4"]);
  assert.throws(() => keyEvents("A"), /only a to z/);
  assert.equal(EXPECTED_TEXT, `${TEST_TEXT} xyz`);
  assert.ok(/^[a-z0-9 ]+$/.test(TEST_TEXT), "plain test text: no secret");
});

// ------------------------------------------------------------------ the front app

test("the JXA scripts: the give-back's AppKit calls only (frontmostApplication, activateWithOptions(0)); no Apple Event, no System Events, no input", () => {
  for (const s of [FRONT_JXA, GIVE_BACK_JXA]) {
    assert.ok(s.startsWith('ObjC.import("AppKit");'));
    assert.ok(!/System Events|tell application|Application\(|keystroke|doShellScript|CGEvent|AXUIElement|screencapture/i.test(s), s);
  }
  assert.match(FRONT_JXA, /NSWorkspace\.sharedWorkspace\.frontmostApplication/);
  assert.match(GIVE_BACK_JXA, /runningApplicationWithProcessIdentifier\(Number\(argv\[0\]\)\)/);
  assert.match(GIVE_BACK_JXA, /activateWithOptions\(0\)/);
  assert.deepEqual(jxaArgs(GIVE_BACK_JXA, ["123"]), ["-l", "JavaScript", "-e", GIVE_BACK_JXA, "123"]);
});

test("the front reads: the pid, the give-back's answer, who is in front, and whether a window took the front", () => {
  assert.equal(frontPid(run("front=4321\n")), 4321);
  assert.equal(frontPid(run("front=0\n")), 0);
  assert.equal(frontPid(run("front=x\n")), null);
  assert.equal(frontPid(run("front=4321\n", 1)), null, "a failed run reads nothing");
  assert.equal(giveBackOf(run("give-back=asked\n")), "asked");
  assert.equal(giveBackOf(run("give-back=refused\n")), "refused");
  assert.equal(giveBackOf(run("x\n")), "an unknown text");
  assert.equal(giveBackOf(run("", null, { timedOut: true, signal: "SIGKILL" })), "timeout");
  assert.deepEqual([frontOf(7, 7), frontOf(8, 7), frontOf(0, 7), frontOf(null, 7), frontOf(8, null)], ["chrome", "other", "none", null, "other"]);
  assert.equal(tookFront("other", "chrome"), true);
  assert.equal(tookFront("other", "other"), false);
  assert.equal(tookFront("none", "chrome"), true);
  assert.equal(tookFront("chrome", "chrome"), null, "Chrome was in front already: it cannot tell");
  assert.equal(tookFront(null, "chrome"), null);
});

test("the rights helper's answer: two flags or null, and a short reason", () => {
  assert.deepEqual(parseRights('{"screenRecording":false,"accessibility":true,"failed":null}\n'), { screenRecording: false, accessibility: true, failed: null });
  assert.deepEqual(parseRights('{"screenRecording":"yes","failed":"a call did not load"}'), { screenRecording: null, accessibility: null, failed: "a call did not load" });
  assert.equal(parseRights("not json"), null);
  const code = readFileSync(HELPER, "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.ok(!/CGRequestScreenCaptureAccess|AXIsProcessTrustedWithOptions|kAXTrustedCheckOptionPrompt/.test(code), "the helper never calls a function that can prompt");
  assert.match(code, /"CGPreflightScreenCaptureAccess"/);
  assert.match(code, /"AXIsProcessTrusted"/);
});

test("the rights helper off the Mac: null, null and its reason; no other output", { skip: process.platform === "darwin" }, async () => {
  const r = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, ["--disable-sigusr1", "--no-warnings", HELPER, "rights"], { cwd: ROOT, timeout: 20_000 }, (e, stdout, stderr) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(parseRights(r.stdout), { screenRecording: null, accessibility: null, failed: `not the Mac (${process.platform})` });
});

// ------------------------------------------------------------------ the taskport right

/** The form of the right that the design expects on macOS (from Apple's authorization.plist as known; not measured). */
const TASKPORT = (extra = "") => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>allow-root</key>
	<false/>
	<key>authenticate-user</key>
	<true/>
	<key>class</key>
	<string>user</string>
	<key>comment</key>
	<string>Used by task_for_pid(...).
Task_for_pid is called by programs requesting full control over another program
for things like debugging or performance analysis. This authorization only applies
if the requesting and target programs are run by the same user; it will never
authorize access to the program of another user.  WARNING: administrators are advised not to modify this right.</string>
	<key>created</key>
	<real>694224000.5</real>
	<key>group</key>
	<string>_developer</string>
	<key>modified</key>
	<real>694224000.5</real>
	<key>session-owner</key>
	<false/>
	<key>shared</key>
	<true/>
	<key>timeout</key>
	<integer>36000</integer>
	<key>tries</key>
	<integer>10000</integer>
	<key>version</key>
	<integer>1</integer>${extra}
</dict>
</plist>
`;

test("the plist reader: the top-level keys only; strings, numbers, flags, lists of strings; a nested dict and a mixed list by kind; bad pairs give null", () => {
  const d = plistDict(TASKPORT(`\n\t<key>nested</key>\n\t<dict><key>a</key><dict><key>b</key><string>x</string></dict></dict>\n\t<key>rule</key>\n\t<array><string>is-developer</string><string>authenticate-developer</string></array>\n\t<key>mixed</key>\n\t<array><string>a</string><integer>1</integer></array>\n\t<key>empty</key>\n\t<string/>`))!;
  assert.deepEqual([d.class, d.group, d.shared, d.timeout, d["allow-root"], d.tries], ["user", "_developer", true, 36000, false, 10000]);
  assert.deepEqual(d.nested, { kind: "dict" });
  assert.deepEqual(d.rule, ["is-developer", "authenticate-developer"]);
  assert.deepEqual(d.mixed, { kind: "array" });
  assert.equal(d.empty, "");
  assert.equal(d.b, undefined, "a nested key is not a top-level key");
  assert.equal(plistDict("YES (0)"), null);
  assert.equal(plistDict("<plist><dict><key>a</key></dict></plist>"), null);
  assert.equal(plistDict('<plist version="1.0"><dict><string>x</string></dict></plist>'), null);
  assert.deepEqual(plistDict('<plist version="1.0"><dict><key>a&amp;b</key><string>&lt;x&gt;</string></dict></plist>'), { "a&b": "<x>" });
});

test("the taskport right: its fields (no comment, no date) and what they mean for a debugger of the same user", () => {
  const p = parseTaskport(run(TASKPORT(), 0, { stderr: "YES (0)\n" }));
  assert.deepEqual(p, {
    read: "ok", exit: 0, meaning: "a password once, shared for its timeout",
    right: { class: "user", rule: null, group: "_developer", authenticateUser: true, shared: true, timeout: 36000, allowRoot: false, sessionOwner: false, tries: 10000, kOfN: null, version: 1, mechanisms: null },
  });
  assert.ok(!JSON.stringify(p).includes("task_for_pid"), "no comment");
  const form = (o: string) => parseTaskport(run(`<plist version="1.0"><dict>${o}</dict></plist>`)).meaning;
  assert.equal(form("<key>class</key><string>allow</string>"), "allow: no password");
  assert.equal(form("<key>class</key><string>rule</string><key>rule</key><string>allow</string>"), "allow: no password");
  assert.equal(form("<key>class</key><string>rule</string><key>rule</key><array><string>is-developer</string></array>"), "a rule");
  assert.equal(form("<key>class</key><string>deny</string>"), "deny");
  assert.equal(form("<key>class</key><string>user</string><key>group</key><string>_developer</string><key>authenticate-user</key><false/>"), "a group member with no password");
  assert.equal(form("<key>class</key><string>user</string><key>authenticate-user</key><true/><key>shared</key><false/>"), "a password at each request");
  assert.equal(form("<key>class</key><string>user</string><key>authenticate-user</key><true/><key>shared</key><true/>"), "a password once, shared with no timeout");
  assert.equal(form("<key>class</key><string>user</string><key>shared</key><true/><key>timeout</key><integer>0</integer>"), "a password at each request");
  assert.equal(form("<key>class</key><string>evaluate-mechanisms</string>"), "another form");
  assert.equal(form("<key>k</key><string>v</string>"), "unknown");
  const other = parseTaskport(run(`<plist version="1.0"><dict><key>class</key><string>user</string><key>group</key><string>somebody</string><key>rule</key><array><string>my-rule</string></array></dict></plist>`));
  assert.deepEqual([other.right!.group, other.right!.rule], ["other", ["other"]], "no name but the known ones");
  assert.deepEqual(parseTaskport(run("", 1, { stderr: "NO (-60005)\n" })), { read: "exit", exit: 1, right: null, meaning: "no right" });
  assert.deepEqual(parseTaskport(run("YES (0)")), { read: "an unknown text", exit: 0, right: null, meaning: "unknown" });
  assert.deepEqual(parseTaskport(run("", null, { spawnError: "ENOENT" })), { read: "no tool", exit: null, right: null, meaning: "unknown" });
  assert.equal(taskportMeaning({ class: null, rule: null, authenticateUser: null, shared: null, timeout: null }), "unknown");
});

// ------------------------------------------------------------------ the reads and the verdicts

test("the reads as JSON: numbers, the visibility word and flags; an unknown word is 'other'; no text of the field", () => {
  const m = measureJson({ vis: "visible", focus: false, raf: 72, ticks: 118.4, ms: 1201, ioN: 1, io: true, sx: 100, sy: 125, ow: 800, oh: 600, iw: 800, ih: 520, sw: 1512, sh: 982, aw: 1512, ah: 945, al: 0, at: 37, dpr: 2, visChanges: 0 })!;
  assert.deepEqual([m.vis, m.raf, m.ticks, m.screenWidth, m.availTop, m.dpr], ["visible", 72, 118.4, 1512, 37, 2]);
  assert.equal(measureJson({ vis: "prerender" })!.vis, "other");
  assert.equal(measureJson(null), null);
  const t = typedJson({ equal: true, length: 17, keydown: 13, untrusted: 0, value: "probe text 42 xyz", vis: "hidden" })!;
  assert.deepEqual([t.equal, t.length, t.keydown, t.vis], [true, 17, 13, "hidden"]);
  assert.ok(!JSON.stringify(t).includes("probe"), "the field's text never comes into the JSON");
  assert.deepEqual(boundsJson({ windowId: 3, bounds: { left: 100, top: 100, width: 800, height: 600, windowState: "minimized" } }), { state: "minimized", left: 100, top: 100, width: 800, height: 600 });
  assert.equal(boundsJson({}), null);
  assert.deepEqual(extWindowJson({ id: 9, state: "minimized", focused: false, incognito: true, left: 0, top: 25, width: 800, height: 600, tab: 4 }), { state: "minimized", focused: false, incognito: true, left: 0, top: 25, width: 800, height: 600 });
});

test("the classes of an error: chrome.windows' 50% rule and state, a CDP timeout, the pipe's end; never the text", () => {
  assert.equal(windowErrorClass("Invalid value for bounds. Bounds must be at least 50% within visible screen space."), "the 50% rule");
  assert.equal(windowErrorClass("Invalid value for state"), "a state that does not combine");
  assert.equal(windowErrorClass("Incognito mode is disabled."), "no incognito");
  assert.equal(windowErrorClass("No window with id: 7."), "other");
  // m7: only Chrome's own texts; a text that holds "state", "50%" or "incognito" elsewhere is "other".
  for (const t of ["the state of the window", "The window's state is minimized", "50% done", "Cannot create incognito window", "an incognito tab"]) assert.equal(windowErrorClass(t), "other", t);
  assert.equal(callErrorClass("timeout"), "timeout");
  assert.equal(callErrorClass("the pipe closed"), "the pipe closed");
  assert.equal(callErrorClass("'Extensions.loadUnpacked' wasn't found"), "no such method");
  assert.equal(callErrorClass("Method not available. Not allowed."), "not allowed");
  assert.equal(callErrorClass("No target with given id found"), "not found");
  assert.equal(chromeVersionOf("Chrome/158.0.8127.37"), "158.0.8127.37");
  assert.equal(chromeVersionOf("HeadlessChrome/156.0.8078.108"), "156.0.8078.108");
  assert.equal(chromeVersionOf("Chrome"), null);
});

const M = (vis: string, raf = 70, ticks = 115, ioN = 1) => ({ vis, focus: false, raf, ticks, ioN });
const T = (equal = true, keydown = TEST_TEXT.length, untrusted = 0, keysVisible = keydown) => ({ equal, keydown, untrusted, keysVisible });
const opt = (measure: Record<string, unknown> | null, typed: Record<string, unknown> | null, more: Partial<OptionJson> = {}): OptionJson =>
  ({ made: "ok", ms: 3000, window: null, ext: null, front: null, measure, typed, hangs: 0, after: null, ...more });

test("the verdicts: the site's view (visible, frames, timers, the observer), the input, and the sensor", () => {
  assert.deepEqual(siteVisible(M("visible")), { visible: true, why: null });
  assert.deepEqual(siteVisible(M("hidden", 0, 2, 0)), { visible: false, why: "the page is hidden" });
  assert.deepEqual(siteVisible(M("visible", 0, 115, 0)), { visible: false, why: "few animation frames, no IntersectionObserver callback" });
  assert.deepEqual(siteVisible(M("visible", 70, 12)), { visible: false, why: "slow timers" });
  assert.deepEqual(siteVisible(null), { visible: null, why: "not measured" });
  assert.deepEqual(siteVisible({ vis: "visible", raf: null, ticks: 115 }), { visible: null, why: "not measured: raf, ioN" }, "a read that is not a number is no pass");
  assert.deepEqual(inputArrived(T(), 0), { arrived: true, why: null });
  assert.deepEqual(inputArrived(T(false, 5), 1), { arrived: false, why: "an input call got no answer in time, the field does not hold the test text, not every key came" });
  assert.deepEqual(inputArrived(T(true, TEST_TEXT.length, 1), 0), { arrived: false, why: "an event was not trusted" });
  assert.deepEqual(inputArrived(null, 2), { arrived: null, why: "an input call got no answer in time" });
  assert.deepEqual([seenOf(M("visible")), seenOf(M("hidden")), seenOf(null)], [true, false, null]);
});

/** A measured apiMinimized of run A that holds each fact of the rule, with `more` over it. */
const goodA = (more: Partial<OptionJson> = {}) => opt(M("visible"), { ...T(), keysHidden: 0 }, { ext: { state: "minimized", incognito: true, focused: false }, front: { before: "other", after: "other", took: false }, ...more });
/** Its run B: hidden to macOS (not seen), and no front taken. */
const goodB = (more: Partial<OptionJson> = {}) => opt(M("hidden", 0, 2, 0), { ...T(true, TEST_TEXT.length, 0, 0), keysHidden: 13 }, { ext: { state: "minimized", incognito: true, focused: false }, front: { before: "other", after: "other", took: false }, ...more });
/** Both runs, started, with apiMinimized as `a` and `b`, and the baselines (front, apiOverCover) of run A as `base`. */
function runsWith(a: OptionJson | null, b: OptionJson | null, base: OptionJson | null = opt(M("visible"), { ...T(), keysHidden: 0 }), started: { A?: boolean; B?: boolean } = {}) {
  return {
    A: { started: started.A ?? true, options: { front: base, apiMinimized: a, apiOverCover: base } },
    B: started.B === false ? { started: false } : { started: true, options: { apiMinimized: b } },
  };
}

test("the summary's pick: minimized only when every fact is measured and holds (I1, I2)", () => {
  const s = summaryOf(runsWith(goodA(), goodB()));
  assert.equal(s.pick, "minimized", String(s.pickWhy));
  assert.deepEqual([s.failed, s.notMeasured], [[], []]);
  assert.equal(minimizedFacts(runsWith(goodA(), goodB())).length, 14);
  const o = (s.options as Record<string, Record<string, unknown>>).apiMinimized;
  assert.deepEqual([o.siteVisible, o.input, o.incognito, o.state, o.keysHidden, o.seen, o.tookFront, o.tookFrontB], [true, true, true, "minimized", 0, false, false, false]);
  assert.equal(checkResult(resultOf({ meta: META, platform: null, ok: true, stage: "done", reason: null, ms: 1, summary: s })), null, "the summary passes the result's check");
});

test("the summary's pick: a fact that is not measured gives 'not measured' and no pick (I1; each case fails on 4fa51f9)", () => {
  const cases: [string, ReturnType<typeof runsWith>, string][] = [
    ["run B skipped by the time budget", runsWith(goodA(), null, undefined, { B: false }), "run B started"],
    ["run B started but apiMinimized skipped there", runsWith(goodA(), opt(null, null, { made: "skipped: the run's time limit is near" })), "apiMinimized made in run B"],
    ["the give-back refused (Chrome was in front before the create)", runsWith(goodA({ front: { before: "chrome", after: "chrome", took: null } }), goodB()), "no front taken in run A"],
    ["no front read in run B", runsWith(goodA(), goodB({ front: { before: null, after: null, took: null } })), "no front taken in run B"],
    ["the test extension not loaded (the CDP stand-in has no front measure)", runsWith(opt(null, null, { made: "skipped: the extension did not load" }), opt(null, null, { made: "skipped: the extension did not load" })), "apiMinimized made in run A"],
    ["a window that is not incognito (I2)", runsWith(goodA({ ext: { state: "minimized", incognito: false } }), goodB()), "an incognito window in run A"],
    ["a window of run B that is not incognito (its switch failed: the narrow re-check of I2)", runsWith(goodA(), goodB({ ext: { state: "minimized", incognito: false } })), "an incognito window in run B"],
    ["no windows.get of run B's window", runsWith(goodA(), goodB({ ext: null })), "the state minimized in run B"],
    ["a visible page with no frame count", runsWith(goodA({ measure: { vis: "visible", focus: false, raf: null, ticks: 115, ioN: 1 } }), goodB()), "visible to the site in run A"],
    ["no windows.get of the window", runsWith(goodA({ ext: null }), goodB()), "the state minimized in run A"],
    ["no sensor in run B", runsWith(goodA(), goodB({ measure: null })), "not seen in run B"],
    ["no record of the keys", runsWith(goodA({ typed: null }), goodB()), "no key on a hidden page in run A"],
  ];
  for (const [what, runs, fact] of cases) {
    const s = summaryOf(runs);
    assert.equal(s.pick, "not measured", `${what}: ${s.pickWhy}`);
    assert.ok((s.notMeasured as string[]).includes(fact), `${what}: ${JSON.stringify(s.notMeasured)}`);
    assert.match(String(s.pickWhy), /^not measured: /, what);
  }
});

test("the summary's pick: a fact that fails gives the fallback 'on the screen' when a baseline holds, 'none' when both fail, 'not measured' when neither is measured", () => {
  const fails: [string, ReturnType<typeof runsWith>, string][] = [
    ["Chrome did not minimize it", runsWith(goodA({ ext: { state: "normal", incognito: true } }), goodB()), "the state minimized in run A"],
    ["Chrome did not minimize run B's window", runsWith(goodA(), goodB({ ext: { state: "normal", incognito: true } })), "the state minimized in run B"],
    ["a key on a hidden page", runsWith(goodA({ typed: { ...T(), keysHidden: 3 } }), goodB()), "no key on a hidden page in run A"],
    ["the page hidden to the site", runsWith(goodA({ measure: M("hidden", 0, 2, 0) }), goodB()), "visible to the site in run A"],
    ["the create took the front", runsWith(goodA({ front: { before: "other", after: "chrome", took: true } }), goodB()), "no front taken in run A"],
    ["macOS shows it", runsWith(goodA(), goodB({ measure: M("visible") })), "not seen in run B"],
  ];
  for (const [what, runs, fact] of fails) {
    const s = summaryOf(runs);
    assert.equal(s.pick, "on the screen", `${what}: ${s.pickWhy}`);
    assert.ok((s.failed as string[]).includes(fact), what);
    assert.match(String(s.pickWhy), /the baseline front holds$/, what);
  }
  const hidden = opt(M("hidden", 0, 2, 0), { ...T(), keysHidden: 13 });
  assert.equal(summaryOf(runsWith(goodA({ measure: M("hidden", 0, 2, 0) }), goodB(), hidden)).pick, "none");
  const onlyOver = { ...runsWith(goodA({ measure: M("hidden", 0, 2, 0) }), goodB()), A: { started: true, options: { front: hidden, apiMinimized: goodA({ measure: M("hidden", 0, 2, 0) }), apiOverCover: opt(M("visible"), { ...T(), keysHidden: 0 }) } } };
  assert.match(String(summaryOf(onlyOver).pickWhy), /the baseline apiOverCover holds$/, "the fallback's own call is a baseline too");
  assert.equal(summaryOf(runsWith(goodA({ measure: M("hidden", 0, 2, 0) }), goodB(), null)).pick, "not measured");
  assert.equal(summaryOf({}).pick, "not measured");
  assert.equal(baselineHolds(opt(M("visible"), { ...T(), keysHidden: 2 })), false, "a baseline with a key on a hidden page does not hold");
  assert.equal(baselineHolds(opt(M("visible"), T())), null, "a baseline with no record of hidden keys is not measured");
});

// ------------------------------------------------------------------ the pipe, the result

test("the pipe's frames: whole messages split at the NUL, across chunks; a rest above the bound throws", () => {
  let s = splitFrames(Buffer.alloc(0), Buffer.from('{"id":1}\0{"id"'));
  assert.deepEqual(s.frames, ['{"id":1}']);
  s = splitFrames(s.rest, Buffer.from(':2}\0\0'));
  assert.deepEqual(s.frames, ['{"id":2}', ""]);
  assert.equal(s.rest.length, 0);
  assert.throws(() => splitFrames(Buffer.alloc(0), Buffer.alloc((16 << 20) + 1, 0x61)), /too large/);
  assert.match(STANDIN_BROWSER, /fd: 3/);
  assert.match(STANDIN_BROWSER, /writeSync\(4,/);
});

test("the result: its keys in order; the check refuses a path, an address, a long id and an unknown key; the scrub", () => {
  const r = resultOf({ meta: META, platform: { os: "darwin", arch: "arm64", node: "26.13.0", release: "27.0.0" }, ok: true, stage: "done", reason: null, ms: 61234, taskport: { read: "ok" }, runs: { A: { options: {} } } });
  assert.deepEqual(Object.keys(r), [...RESULT_KEYS]);
  assert.equal(checkResult(r), null);
  assert.equal(checkResult({ ...r, reason: "the profile at /var/folders/x" }), "reason");
  assert.equal(checkResult({ ...r, reason: "me@example.com" }), "reason");
  assert.equal(checkResult({ ...r, reason: "a".repeat(41) }), "reason");
  assert.equal(checkResult({ ...r, runs: { "A-1": 1 } }), "runs.<key>");
  assert.equal(checkResult({ ...r, ms: Infinity }), "ms");
  const { extra, ...noKey } = { ...r, extra: 1 };
  assert.equal(checkResult({ ...noKey, more: 1 }), "<keys>");
  void extra;
  assert.deepEqual(scrub({ a: "under the home folder hhh" }, ["hhh"]), { value: { a: "under the home folder <redacted>" }, count: 1 });
});

test("the mask of a result that fails the check (m7): only the bad values go, each place named; the rest of the run stays", () => {
  const r = { ...resultOf({ meta: META, platform: null, ok: true, stage: "done", reason: null, ms: 5, runs: { A: { version: "158.0.8127.37", bad: "under /var/folders/x", n: Infinity, list: ["ok", "me@example.com"], keep: 3 } } }) };
  (r.runs as Record<string, any>).A["bad-key"] = 1;
  assert.ok(checkResult(r) !== null);
  const m = maskResult(r);
  assert.deepEqual(m.masked, ["runs.A.bad", "runs.A.n", "runs.A.list[1]", "runs.A.<key>"]);
  assert.deepEqual((m.value.runs as Record<string, any>).A, { version: "158.0.8127.37", bad: "<masked>", n: null, list: ["ok", "<masked>"], keep: 3 });
  assert.equal(checkResult(m.value), null, "the masked result passes the check");
});

test("the crash handler (m2): ps's rows, etime, and only a handler that is the probe's Chrome's child and not older than it", () => {
  assert.deepEqual([etimeSeconds("05:07"), etimeSeconds("01:02:03"), etimeSeconds("2-00:00:01"), etimeSeconds("x")], [307, 3723, 172801, null]);
  const rows = parsePs([
    "  501   1 10-01:00:00 /sbin/launchd",
    "  900 501     00:09 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "  901 900     00:09 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/158.0.8127.37/Helpers/chrome_crashpad_handler",
    "  902 900     00:08 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/158.0.8127.37/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)",
    "  903 777  1-00:00:00 /Applications/Google Chrome.app/Contents/Frameworks/x/Helpers/chrome_crashpad_handler",
    "  904 900     40:00 chrome_crashpad",
    "  905 900     00:05 chrome_crashpad",
    "not a row",
  ].join("\n"));
  assert.equal(rows.length, 7);
  assert.deepEqual(rows[2], { pid: 901, ppid: 900, ageS: 9, name: CRASHPAD });
  assert.equal(rows[3].name, "Google Chrome Helper (Renderer)", "a name with spaces");
  assert.deepEqual(crashpadOf(rows, 900, 10), [901, 905], "the operator's Chrome's handler (903) and one older than the probe's Chrome (904) are not the probe's");
  assert.equal(sameHandler(rows, 901, 9), true);
  assert.equal(sameHandler(rows, 901, 20), false, "a younger process of that pid is another process");
  assert.equal(sameHandler(rows, 902, 1), false, "another program");
});

test("the hold seam's time limit: a whole number of ms from 1000 to 30000", () => {
  assert.deepEqual([holdMs("3000"), holdMs("1000"), holdMs("30000"), holdMs("999"), holdMs("30001"), holdMs("3e3"), holdMs("")], [3000, 1000, 30000, null, null, null, null]);
});

// ------------------------------------------------------------------ the probe on Linux

const probe = (args: string[], env: NodeJS.ProcessEnv) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
  execFile(process.execPath, [PROBE, ...args], { cwd: ROOT, env, timeout: 60_000 }, (e, stdout, stderr) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, stdout, stderr }));
});

test("the probe on Linux: the dry run (the extension, the page server, the pipe client against a stand-in browser, both stops), ok false: not the Mac; nothing stays", { skip: process.platform !== "linux" }, async () => {
  const tmp = tempDir("ab-swt-");
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
    delete env[TWIN_ENV];
    const r = await probe([], env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, "");
    const j = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(j), [...RESULT_KEYS]);
    assert.equal(checkResult(j), null);
    assert.deepEqual([j.probe, j.version, j.ok, j.stage, j.platform.os], ["mac-signin-window-probe", 1, false, "done", "linux"]);
    assert.match(j.reason, /^not the Mac \(linux\): the dry run made the folder, the extension and the page server/);
    assert.match(j.commit, /^([0-9a-f]{40}|unknown)$/);
    assert.deepEqual([j.taskport, j.rights, j.chrome, j.runs, j.summary], [null, null, null, null, null]);
    assert.deepEqual(j.dry, {
      extension: { idFromKey: true, worker: true },
      page: { act: { status: 200, recorder: true }, cover: { status: 200, recorder: false }, missing: { status: 404, recorder: false }, wrongHost: { status: 421, recorder: false } },
      pipe: { version: "1.0.0.0", unknown: "no such method", closes: { how: "closed", groupLeft: false }, stays: { how: "terminated", groupLeft: false }, late: "the pipe closed" },
    });
    assert.deepEqual(j.cleanup, { chromes: 2, tools: 0, killedGroups: 0, leftAtEnd: 0, folderRemoved: true });
    assert.ok(!r.stdout.includes(tmp) && !r.stdout.includes(homedir()), "no path of the box in the output");
    assert.deepEqual(readdirSync(tmp), [], "the probe's folder is gone");
    assert.ok(j.ms < 15_000, `${j.ms} ms`);
  } finally { rmSync(tmp, { recursive: true, force: true }); done(tmp); }
});

/** The probe with the hold seam: its exit, its JSON (null at a signal), the stand-in's pid from stderr; `signal` is sent once the stand-in holds. */
function hold(env: NodeJS.ProcessEnv, signal?: NodeJS.Signals) {
  return new Promise<{ code: number | null; signal: string | null; json: any; standin: number | null }>((resolve) => {
    const c = spawn(process.execPath, [PROBE], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", standin: number | null = null;
    const kill = setTimeout(() => c.kill("SIGKILL"), 30_000);
    c.stdout!.on("data", (d) => { out += d; });
    c.stderr!.on("data", (d) => {
      err += d;
      const m = /dry-hold: stand-in pid (\d+)/.exec(err);
      if (m && standin === null) { standin = Number(m[1]); if (signal) c.kill(signal); }
    });
    c.on("close", (code, sig) => { clearTimeout(kill); let json = null; try { json = JSON.parse(out); } catch {} resolve({ code, signal: sig, json, standin }); });
  });
}

/** The probe SIGKILLs the stand-in and exits at once; /proc/<pid> stays until init reaps the orphan (board ab-v16.97.18). */
async function gone(pid: number | null, ms = 5000): Promise<boolean> {
  if (pid === null) return false;
  const end = Date.now() + ms;
  while (existsSync(`/proc/${pid}`)) {
    if (Date.now() > end) return false;
    await new Promise((res) => setTimeout(res, 20));
  }
  return true;
}

test("the cleanup at the time limit (m3): the hold seam's limit stops the stand-in and removes the folder; exit 1 with the JSON", { skip: process.platform !== "linux" }, async () => {
  const tmp = tempDir("ab-swh-");
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, [HOLD_ENV]: "3000" };
    delete env[TWIN_ENV];
    const r = await hold(env);
    assert.equal(r.code, 1);
    assert.ok(Number.isInteger(r.standin), "the stand-in held");
    assert.deepEqual([r.json.ok, r.json.stage, r.json.reason], [false, "dry-hold", "the time limit of 3 s for the whole run"]);
    assert.deepEqual(r.json.cleanup, { atStop: true, leftAtStop: 1, folderRemoved: true });
    assert.equal(checkResult(r.json), null);
    assert.ok(await gone(r.standin), "the stand-in is gone");
    assert.deepEqual(readdirSync(tmp), [], "the folder is gone");
  } finally { rmSync(tmp, { recursive: true, force: true }); done(tmp); }
});

test("the cleanup at a signal (m3): SIGTERM and SIGHUP while the stand-in holds stop it and remove the folder; the exit is 128 + the signal", { skip: process.platform !== "linux" }, async () => {
  for (const [sig, code] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    const tmp = tempDir("ab-swh-");
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, [HOLD_ENV]: "20000" };
      delete env[TWIN_ENV];
      const r = await hold(env, sig);
      assert.equal(r.code, code, sig);
      assert.ok(Number.isInteger(r.standin), sig);
      assert.ok(await gone(r.standin), `${sig}: the stand-in is gone`);
      assert.deepEqual(readdirSync(tmp), [], `${sig}: the folder is gone`);
    } finally { rmSync(tmp, { recursive: true, force: true }); done(tmp); }
  }
});

test("the hold seam refuses a bad limit and the twin beside it: exit 2", { skip: process.platform !== "linux" }, async () => {
  for (const env of [{ [HOLD_ENV]: "50" }, { [HOLD_ENV]: "3000", [TWIN_ENV]: "176" }]) {
    const r = await probe([], { ...process.env, ...env });
    assert.equal(r.code, 2, JSON.stringify(env));
    assert.match(JSON.parse(r.stdout).reason, /names no time limit that the seam may take|names no display/);
  }
});

test("the probe takes no argument: exit 2, and the JSON says why", async () => {
  const r = await probe(["--x"], process.env);
  assert.equal(r.code, 2);
  const j = JSON.parse(r.stdout);
  assert.deepEqual([j.ok, j.stage, j.reason], [false, "args", "the probe takes no argument"]);
  assert.match(r.stderr, /usage: node test\/live\/mac-signin-window-probe\/probe\.ts/);
});

test("the Linux twin's seam refuses a reserved display before it makes or starts anything: exit 2", { skip: process.platform !== "linux" }, async () => {
  const tmp = tempDir("ab-swt-");
  try {
    for (const d of ["90", "0", "x"]) {
      const r = await probe([], { ...process.env, TMPDIR: tmp, [TWIN_ENV]: d });
      assert.equal(r.code, 2, d);
      assert.equal(JSON.parse(r.stdout).reason, `${TWIN_ENV} names no display that the twin may take`);
    }
    assert.deepEqual(readdirSync(tmp), [], "it made nothing");
  } finally { rmSync(tmp, { recursive: true, force: true }); done(tmp); }
});

test("the probe's own reads: its Chrome only on the pipe, never a port; no prompt's call, no setting change, no public site", () => {
  const src = readFileSync(PROBE, "utf8");
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.ok(!/remote-debugging-port|--load-extension|sudo|DevToolsSecurity|authorizationdb", "write|screencapture|tccutil|defaults write/.test(code));
  assert.match(code, /\["authorizationdb", "read", TASKPORT_RIGHT\]/);
  assert.ok(!/https:\/\//.test(code), "no public site");
  assert.equal((code.match(/spawn\(bin, args/g) ?? []).length, 1, "one spawn of a browser: on the pipe");
  assert.match(code, /stdio: \["ignore", "ignore", "ignore", "pipe", "pipe"\]/);
  assert.match(code, /server\.listen\(0, "127\.0\.0\.1"/);
  assert.ok(ACT_BOUNDS.width === 800 && ACT_BOUNDS.height === 600);
});
