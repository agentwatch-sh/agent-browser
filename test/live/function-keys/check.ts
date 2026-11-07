// The live function-key check (Linux and macOS, #7): a key event that the page does not handle never
// reaches Chrome's own shortcuts. It starts a real, headful Chrome of its own on a throwaway profile,
// with one local probe.localhost page and no network: every other host fails to resolve and goes to a
// dead proxy. Each trial opens a new window, sends one key, and records what the page saw and what
// Chrome did, all through CDP: a reload (a main-frame navigation, or the page lost its mark), a closed
// tab or window, a new target (DevTools, a help tab, a new tab), the window state (full screen), a page
// blur (the focus went to Chrome's UI) and a contextmenu event. Not part of `npm test`; its pure parts
// (trials.ts) are, in test/function-keys.test.ts.
//
//   Linux:  node test/live/function-keys/check.ts --out-dir DIR [--chrome /usr/bin/chromium] [--display 97]
//             [--wait-ms 1200] [--only before:F5,record:Shift+F11,press:F12]
//   macOS:  node test/live/function-keys/check.ts --on-my-screen --chrome APP_BINARY --out-dir DIR
//             [--background] [--full-screen] [--wait-ms 1200] [--only before:Meta+R,record:Shift+F11]
//
// Linux: Chromium runs in a private Xvfb (with -auth), so no window reaches a person's screen.
// macOS has no Xvfb: the windows open on the person's screen, so the check refuses to start (exit 2)
// without --on-my-screen, the consent of the person at the Mac, who then does not type or click until
// it ends. --chrome is the app's binary, for example
// "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta". The check starts that binary
// as its own child, on a new profile DIR/profile-XXXXXX (with --use-mock-keychain), talks to it only
// when its browser pid is that child's, and on exit ends only that child: it never quits, kills or
// connects to a Chrome that it did not start. Each macOS run leaves its DIR/profile-XXXXXX behind.
// Each trial window comes to the front (Page.bringToFront) and takes the keyboard focus, as on Linux.
// On macOS a trial counts only when the check's Chrome is the front app before and after the key, and
// a key without an effect is followed by a Meta+L control that must move the focus to the address bar
// (then the window was key when the control ran). A trial that fails one of these is "not measured",
// a failure (see observe); for a before trial the control is information only (its "control" field,
// and the summary's beforeUnproven). --background drops the focus step: then the record and press
// trials are not measured, and the required before controls fail with no effect (when another app is
// in front, every trial is not measured). Full screen moves a window into its own Space, and the
// screen switches to it: Meta+Control+F runs only with --full-screen, and a trial that enters full
// screen leaves it at once and records it. A full screen that does not end in 10 s fails and stops the
// run; on macOS a trial error stops it too, because its window can stay on the screen.
//
// Three ways to send each key:
//   before  agent-browser before #7: keyFields plus nativeVirtualKeyCode, as rawKeyDown. Chrome's
//           shortcuts must fire here (Linux: F5, F11, F12, Control+W; macOS: Meta+R, Meta+W,
//           Meta+Alt+I, and Meta+Control+F with --full-screen), else the check cannot see them. Also
//           Control+L and Control+T on Linux, Meta+T and Meta+L on macOS. On macOS the before way is a
//           positive control with real Mac key events (the Mac key code and characters, beforeFields),
//           not a replay of agent-browser before #7, which sent the Windows key code as the native
//           code there.
//   record  record's press step: the real sendKey and parseKey, F1 to F12 with eight modifier sets.
//   press   the press command (Tab.press): keyDown with keyFields, F1 to F12 alone.
// It writes DIR/results.jsonl (new for each run) and prints a JSON summary with "ok".
//   exit 0  every trial passed.
//   exit 1  a failure in the summary: a record or press key with an effect outside the page, or that
//           never reached it (Shift+F10, which record refuses, must open the context menu on Linux;
//           macOS's Blink opens none); a required before control without an effect; a page without
//           focus before its key; on macOS a trial not measured, or a full screen not left. Also an
//           error with a stack trace and no summary (for example Xvfb did not start).
//   exit 2  no trial ran, and stderr says why in one line (the usage text has two): a usage error,
//           an --only entry that names no trial, a start that the platform refuses, a --chrome that
//           cannot start, a --chrome that runs but writes no DevTools port (it exits, or 10 s pass;
//           30 s on macOS), or (macOS) a DevTools port that is not the check's own Chrome.
//
// Measured 2026-11-03 (Chromium 156.0.8078.73, Debian 13, Xvfb; 207 trials, exit 0): before: F1 (a
// help tab), F3, Shift+F3, F6, Shift+F6, F7, F10 (the focus left the page), Control+F4, Alt+F4 (the
// tab and its window closed), F5, Shift+F5, Control+F5 (reload), Shift+F10 (contextmenu), F11 (full
// screen), F12 (DevTools), Control+L, Control+T and Control+W. record: only Shift+F10 (contextmenu).
// press: none. Every record and press key reached the page.
// Measured 2026-11-04 on macOS (--on-my-screen; Chrome Beta 158.0.8127.2 and Google Chrome
// 156.0.8078.81, the same results in both; 209 trials each, exit 0): before: F7, Meta+L (the focus
// left the page), F12, Meta+Alt+I (DevTools), Meta+R (reload), Meta+W (the window closed), Meta+T (a
// new tab). Every before trial without an effect had the Meta+L control blur (beforeUnproven empty).
// record: none (Shift+F10: no contextmenu event). press: none. Every record and press key reached
// the page. A --background run (Chrome Beta) exited 1, as expected: its record and press trials were
// not measured. --full-screen (210 trials): not measured yet.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { keyFields, type Tab } from "../../../src/browser.ts";
import { parseKey, sendKey } from "../../../src/record.ts";
import { beforeFields, chromeArgs, failures as failuresOf, fullScreenEnded, isAsn, lsappinfoPid, notMeasured, startMode, stopReason, trialTable, type Control, type Result, type Way } from "./trials.ts";
import { harnessGuard } from "../guard.ts";

const { values } = parseArgs({ options: { "out-dir": { type: "string" }, chrome: { type: "string" }, display: { type: "string" }, "wait-ms": { type: "string" }, only: { type: "string" },
  "on-my-screen": { type: "boolean" }, background: { type: "boolean" }, "full-screen": { type: "boolean" } } });
if (!values["out-dir"]) {
  process.stderr.write("usage: node test/live/function-keys/check.ts --out-dir DIR [--chrome /usr/bin/chromium] [--display 97] [--wait-ms 1200] [--only record:F5,...]\n" +
    "  macOS: node test/live/function-keys/check.ts --on-my-screen --chrome APP_BINARY --out-dir DIR [--background] [--full-screen] [--wait-ms 1200] [--only ...]\n");
  process.exit(2);
}
const start = startMode(process.platform, { onMyScreen: values["on-my-screen"], background: values.background, fullScreen: values["full-screen"], chrome: values.chrome, display: values.display });
/** A start that the check refuses: one line, exit 2. The exit handler ends the check's own children. */
function refuse(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
if ("error" in start) refuse(start.error);
const mode = start;
const MAC = mode.platform === "darwin";
const FRONT = mode.platform === "linux" || mode.front;
const OUT = resolve(values["out-dir"]);
const CHROME = mode.chrome;
const DISPLAY = mode.platform === "linux" ? mode.display : 0;
const WAIT_MS = Number(values["wait-ms"] ?? 1200);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let trials = trialTable(mode);
if (values.only) {
  const only = values.only.split(",");
  const unknown = only.filter((o) => !trials.some((t) => `${t.way}:${t.spec}` === o));
  if (unknown.length) { process.stderr.write(`--only names no trial: ${unknown.join(", ")} (a trial is before:SPEC, record:SPEC or press:SPEC)\n`); process.exit(2); }
  trials = trials.filter((t) => only.includes(`${t.way}:${t.spec}`));
}
mkdirSync(OUT, { recursive: true });
const RESULTS = join(OUT, "results.jsonl");
writeFileSync(RESULTS, "");

// The X authority file (FamilyWild, MIT-MAGIC-COOKIE-1), written here: xauth is not always installed.
const field = (b: Buffer) => { const n = Buffer.alloc(2); n.writeUInt16BE(b.length); return Buffer.concat([n, b]); };
const xauth = join(OUT, "Xauthority");
if (!MAC) {
  writeFileSync(xauth, Buffer.concat([Buffer.from([0xff, 0xff]), field(Buffer.alloc(0)), field(Buffer.from(String(DISPLAY))),
    field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(randomBytes(16))]), { mode: 0o600 });
}

// Only the check's own children: its Xvfb and its Chrome.
const children: ChildProcess[] = [];
process.on("exit", () => { for (const c of children.reverse()) c.kill("SIGTERM"); });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));

// Linux: one live harness at a time, and nothing of this check after its end, also after a kill -9 (test/live/README.md).
const harness = MAC ? undefined : await harnessGuard("function-keys");
if (!MAC) {
  const socket = `/tmp/.X11-unix/X${DISPLAY}`;
  if (existsSync(socket)) throw new Error(`display :${DISPLAY} is in use; pass --display N`);
  const xvfb = spawn("Xvfb", [`:${DISPLAY}`, "-auth", xauth, "-nolisten", "tcp", "-screen", "0", "1280x800x24"], { stdio: "ignore" });
  children.push(xvfb);
  harness?.track(xvfb.pid, "Xvfb");
  for (let i = 0; i < 50 && !existsSync(socket) && xvfb.exitCode === null; i++) await sleep(100);
  await sleep(200);
  // The socket must be our Xvfb's: another X server that took the display between the check and the spawn
  // makes ours exit, and Chromium must never open its windows there.
  if (!existsSync(socket) || xvfb.exitCode !== null) throw new Error(`Xvfb did not start on :${DISPLAY}; pass another --display N`);
}

// The page logs its key, focus and context-menu events and handles (prevents) none of them.
const PAGE = `<!doctype html><title>function keys</title><input id="f" autofocus><script>
window.__log = [];
for (const t of ["keydown", "keyup", "contextmenu", "blur"]) window.addEventListener(t, (e) => __log.push({ t, key: e.key }), true);
</script>`;
const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const URL_ = `http://probe.localhost:${(server.address() as { port: number }).port}/`;

/** Linux: our Xvfb only: without the Wayland variables of a desktop session, Chromium cannot open a window there. */
function chromeEnv(): NodeJS.ProcessEnv {
  if (MAC) return process.env;
  const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: `:${DISPLAY}`, XAUTHORITY: xauth };
  delete env.WAYLAND_DISPLAY;
  delete env.XDG_SESSION_TYPE;
  return env;
}

// macOS: a new profile for each run. A start on a profile that another Chrome holds goes to that
// Chrome, so only a new folder makes sure that the port file and the windows are our child's.
const profile = MAC ? mkdtempSync(join(OUT, "profile-")) : join(OUT, "profile");
mkdirSync(profile, { recursive: true });
rmSync(join(profile, "DevToolsActivePort"), { force: true }); // a run before in this --out-dir left its own
const chrome = spawn(CHROME, chromeArgs(mode, profile), { env: chromeEnv(), stdio: "ignore" });
children.push(chrome);
harness?.track(chrome.pid, "Chromium");
chrome.on("error", (e) => refuse(`--chrome ${CHROME} cannot start: ${e.message}`)); // for example a wrong path
const START_S = MAC ? 30 : 10;
const exited = () => chrome.exitCode !== null || chrome.signalCode !== null;
let active = "";
for (let i = 0; i < START_S * 10 && !active && !exited(); i++) { try { active = readFileSync(join(profile, "DevToolsActivePort"), "utf8"); } catch { await sleep(100); } }
if (!active) refuse(`--chrome ${CHROME} did not start: no DevTools port ${exited() ? `(it exited: ${chrome.exitCode ?? chrome.signalCode})` : `in ${START_S} s`}`);
const [port, path] = active.trim().split("\n");

// A small CDP client. Every call times out: a key such as Control+T can leave its own call unanswered.
const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 1;
const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
const listeners: ((m: any) => void)[] = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  const p = m.id ? pending.get(m.id) : undefined;
  if (p) { pending.delete(m.id); m.error ? p.fail(new Error(m.error.message)) : p.ok(m.result); } else for (const l of listeners) l(m);
};
function send(method: string, params: object = {}, sessionId?: string, ms = 8000): Promise<any> {
  return new Promise((ok, fail) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); fail(new Error(`${method}: no answer in ${ms} ms`)); }, ms);
    pending.set(id, { ok: (v) => { clearTimeout(timer); ok(v); }, fail: (e) => { clearTimeout(timer); fail(e); } });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
// macOS: before any other call, the browser process must be the check's own child (the app binary is
// the browser process). Else the check stops and sends it nothing more.
if (MAC) {
  const browser = ((await send("SystemInfo.getProcessInfo")).processInfo as { type: string; id: number }[]).find((p) => p.type === "browser");
  if (browser?.id !== chrome.pid) refuse(`the DevTools port in ${profile} is not the check's own Chrome (browser pid ${browser?.id}, child ${chrome.pid}); nothing more is sent to it`);
}
const product = (await send("Browser.getVersion")).product as string;
const created: { id: string; type: string; url: string }[] = [];
listeners.push((m) => { if (m.method === "Target.targetCreated") created.push({ id: m.params.targetInfo.targetId, type: m.params.targetInfo.type, url: m.params.targetInfo.url }); });
await send("Target.setDiscoverTargets", { discover: true, filter: [{ type: "browser", exclude: true }, { type: "tab", exclude: true }, {}] });

async function press(way: Way, spec: string, sessionId: string): Promise<void> {
  const k = parseKey(spec);
  const tab = { send: (method: string, params: object) => send(method, params, sessionId) } as unknown as Tab;
  if (way === "record") return sendKey(tab, k);
  if (way === "press") { // as Tab.press
    const base = keyFields(k.key, k.code, k.keyCode);
    await tab.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    return;
  }
  const base = beforeFields(k, mode.platform);
  await tab.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function trial(way: Way, spec: string) {
  const before = new Set((await send("Target.getTargets")).targetInfos.map((x: any) => x.targetId));
  // Without the focus step (macOS --background) the window opens inactive and never takes the focus.
  const { targetId } = await send("Target.createTarget", { url: URL_, newWindow: true, ...(FRONT ? {} : { background: true }) });
  try { return await observe(way, spec, targetId, before); } finally {
    // Every trial closes its window, also a failed one, so that it never takes the focus of the next trial.
    const open = await send("Target.getTargets").then((r) => r.targetInfos.some((x: any) => x.targetId === targetId), () => true);
    if (open) await send("Target.closeTarget", { targetId }).catch(() => {});
    await sleep(150);
  }
}

async function observe(way: Way, spec: string, targetId: string, before: Set<string>) {
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  const evaluate = async (expression: string) => (await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result.value;
  for (let i = 0; i < 100 && !(await evaluate("document.readyState === 'complete'").catch(() => false)); i++) await sleep(50);
  // The focus step, also on macOS, where it takes the person's keyboard focus: Chrome runs a shortcut
  // from a CDP key only in its key window (CommandDispatcher redispatchKeyEvent returns NO for a window
  // that is not key), so without it the before controls show nothing, and a record or press key
  // without an effect proves nothing. document.hasFocus() does not show that the window is key:
  // Page.bringToFront and CDP key input (InputInjector::InjectKeyboardEvent) call WebContents::Focus(),
  // which gives the page the focus also in a window that is not key. So on macOS the check waits up to
  // 2 s for its Chrome to be the front app (macOS activates an app asynchronously), checks that before
  // and after the key (lsappinfo), and after a record or press key without an effect sends the Meta+L
  // control: a trial that fails one of these is not measured (notMeasured). --background drops the
  // focus step: its windows open inactive, so its record and press trials are expected to be not
  // measured, and its required before controls to fail with no effect.
  if (FRONT) await send("Page.bringToFront", {}, sessionId);
  await sleep(300);
  for (let i = 0; i < 20 && MAC && FRONT && (await frontAppPid()) !== chrome.pid; i++) await sleep(100);
  const { windowId } = await send("Browser.getWindowForTarget", { targetId });
  const stateBefore = (await send("Browser.getWindowBounds", { windowId })).bounds.windowState;
  const mark = randomBytes(6).toString("hex");
  const ready = await evaluate(`window.__mark = "${mark}"; ({ focus: document.hasFocus(), field: document.activeElement?.id === "f" })`);
  const focused = ready.field && (ready.focus || !FRONT);
  let navigated = false;
  const onNav = (m: any) => { if (m.sessionId === sessionId && m.method === "Page.frameNavigated" && !m.params.frame.parentId) navigated = true; };
  listeners.push(onNav);
  created.length = 0;
  let sendError: string | undefined;
  const frontBefore = MAC ? await frontAppPid() : undefined;
  await press(way, spec, sessionId).catch((e: Error) => { sendError = e.message; });
  let full: FullScreen | undefined;
  if (MAC) full = await waitLeavingFullScreen(windowId, targetId); else await sleep(WAIT_MS);
  listeners.splice(listeners.indexOf(onNav), 1);
  const alive = (await send("Target.getTargets")).targetInfos.some((x: any) => x.targetId === targetId);
  const page = alive ? await evaluate(`({ log: window.__log ?? [], focus: document.hasFocus(), kept: window.__mark === "${mark}" })`).catch(() => null) : null;
  let stateAfter = await windowState(windowId);
  // macOS: a full screen that is on after --wait-ms (it started late, or came back) is left too.
  if (MAC && stateAfter === "fullscreen") { full = await leaveFullScreen(windowId, targetId); stateAfter = await windowState(windowId); }
  const key = parseKey(spec).key;
  const newTargets = created.filter((c) => !before.has(c.id) && c.id !== targetId);
  const effects = [
    ...(navigated || (page && !page.kept) ? ["reload"] : []),
    ...(alive ? [] : ["closed"]),
    ...newTargets.map((c) => `new ${c.type} ${c.url.split("?")[0]}`),
    ...(full ? [`window ${stateBefore} -> fullscreen, ${full.left ? `left in ${full.ms} ms` : "not left in 10 s"}`] : stateAfter !== stateBefore ? [`window ${stateBefore} -> ${stateAfter}`] : []),
    ...(page?.log.some((e: any) => e.t === "blur") || (ready.focus && ready.field && page && !page.focus) ? ["page blur"] : []),
    ...(page?.log.some((e: any) => e.t === "contextmenu") ? ["contextmenu"] : []),
  ];
  for (const c of newTargets) await send("Target.closeTarget", { targetId: c.id }).catch(() => {});
  let unmeasured: string | undefined, control: Control | undefined;
  if (MAC) {
    // A key without an effect gets the Meta+L control (information for a before trial). Events of the
    // key that come after the read above are its late effects, never the control's blur.
    if (!effects.length && alive && frontBefore === chrome.pid) {
      const c = await metaLControl(sessionId, evaluate, page?.log.length ?? 0);
      control = c.control;
      effects.push(...c.late.map((e) => `late ${e.t}`));
    }
    unmeasured = notMeasured({ way, effects, chromePid: chrome.pid ?? -1, frontBefore, frontAfter: await frontAppPid(), control });
  }
  return { way, spec, focused, reachedPage: !!page?.log.some((e: any) => e.t === "keydown" && e.key === key), effects, ...(sendError ? { sendError } : {}),
    ...(control ? { control } : {}), ...(unmeasured ? { notMeasured: unmeasured } : {}), ...(full && !full.left ? { fullScreenNotLeft: true } : {}) };
}

const execFileP = promisify(execFile);
/** macOS: the pid of the front app (`lsappinfo front`, then `lsappinfo info -only pid <ASN>`; read only), or undefined. */
async function frontAppPid(): Promise<number | undefined> {
  const lsappinfo = async (...args: string[]) => (await execFileP("/usr/bin/lsappinfo", args, { encoding: "utf8", timeout: 2000 })).stdout;
  try {
    const asn = (await lsappinfo("front")).trim();
    return isAsn(asn) ? lsappinfoPid(await lsappinfo("info", "-only", "pid", asn)) : undefined;
  } catch { return undefined; }
}

/**
 * macOS: the positive control after a key without an effect. The before way's Meta+L in the same
 * window must move the focus to the address bar (a page blur): then the window was key when the
 * control ran, and Chrome would have run a shortcut of the key under test. It runs only while the page
 * has the focus and its log is as the trial read it (`seen` events); newer events are the key's late
 * events, returned as such, and the control does not run.
 */
async function metaLControl(sessionId: string, evaluate: (expression: string) => Promise<any>, seen: number): Promise<{ control: Control; late: { t: string }[] }> {
  try {
    const start = await evaluate(`({ late: window.__log.slice(${seen}), focus: document.hasFocus() })`);
    if (start.late.length) return { control: "late events", late: start.late };
    if (!start.focus) return { control: "no page focus", late: [] };
    await press("before", "Meta+L", sessionId);
    for (const end = Date.now() + WAIT_MS; Date.now() < end;) {
      await sleep(100);
      if (await evaluate(`window.__log.slice(${seen}).some((e) => e.t === "blur") || !document.hasFocus()`)) return { control: "blur", late: [] };
    }
    return { control: "no blur", late: [] };
  } catch { return { control: "error", late: [] }; }
}

const windowState = (windowId: number): Promise<string> => send("Browser.getWindowBounds", { windowId }).then((r) => r.bounds.windowState, () => "gone");

type FullScreen = { left: boolean; ms: number };
/**
 * macOS: leaves full screen (a Space of its own, to which the screen switches). The transition takes
 * about a second, and a request during it can fail, so it asks again until it ends, for up to 10 s.
 */
async function leaveFullScreen(windowId: number, targetId: string): Promise<FullScreen> {
  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    await send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }).catch(() => {});
    await sleep(500);
    // windowState says "gone" for any error, a CDP timeout too: only a closed target counts then.
    const state = await windowState(windowId);
    const closed = state === "gone" && await send("Target.getTargets").then((r) => !r.targetInfos.some((x: any) => x.targetId === targetId), () => false);
    if (fullScreenEnded(state, closed)) return { left: true, ms: Date.now() - t0 };
  }
  return { left: false, ms: Date.now() - t0 };
}

/** macOS: waits --wait-ms, and a window that enters full screen in that time leaves it at once. */
async function waitLeavingFullScreen(windowId: number, targetId: string): Promise<FullScreen | undefined> {
  const end = Date.now() + WAIT_MS;
  let full: FullScreen | undefined;
  while (Date.now() < end) {
    await sleep(100);
    if (!full && (await windowState(windowId)) === "fullscreen") full = await leaveFullScreen(windowId, targetId);
  }
  return full;
}

const results: Result[] = [];
let stopped: string | undefined;
for (const t of trials) {
  const r: Result = await trial(t.way, t.spec).catch((e: Error) => ({ way: t.way, spec: t.spec, focused: false, reachedPage: false, effects: [`trial error: ${e.message}`], trialError: e.message }));
  results.push(r);
  writeFileSync(RESULTS, JSON.stringify(r) + "\n", { flag: "a" });
  process.stderr.write(`${r.way.padEnd(6)} ${r.spec.padEnd(18)} ${r.reachedPage ? "page" : "    "} ${r.effects.join(", ")}${r.control && r.control !== "blur" ? ` [Meta+L control: ${r.control}]` : ""}${r.notMeasured ? ` (not measured: ${r.notMeasured})` : ""}\n`);
  // A full screen that the check could not leave, or (macOS) a trial error, stops the run; trial() has closed its window.
  stopped = stopReason(r, mode);
  if (stopped) break;
}
const of = (way: Way) => results.filter((r) => r.way === way);
const failures = failuresOf(results, mode);
const summary = {
  ok: failures.length === 0, chrome: product, ...(MAC ? { mode: FRONT ? "macOS, each window to the front" : "macOS, --background" } : {}), trials: results.length,
  before: of("before").filter((r) => r.effects.length).map((r) => `${r.spec}: ${r.effects.join(", ")}`),
  record: of("record").filter((r) => r.effects.length).map((r) => `${r.spec}: ${r.effects.join(", ")}`),
  press: of("press").filter((r) => r.effects.length).map((r) => `${r.spec}: ${r.effects.join(", ")}`),
  // macOS: before keys without an effect whose window the Meta+L control did not show to be key: their "no shortcut" is unproven.
  ...(MAC ? { beforeUnproven: of("before").filter((r) => !r.effects.length && r.control !== "blur").map((r) => `${r.spec}: Meta+L control: ${r.control ?? "not run"}`) } : {}),
  failures,
  ...(stopped ? { stopped } : {}),
};
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
ws.close();
server.close();
process.exit(failures.length ? 1 : 0);
