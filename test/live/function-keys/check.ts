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
// connects to a Chrome that it did not start. Each trial window comes to the front (Page.bringToFront)
// and takes the keyboard focus, as on Linux; --background drops that step (see observe). Full screen
// moves a window into its own Space, and the screen switches to it: Meta+Control+F runs only with
// --full-screen, and a trial that enters full screen leaves it at once and records it.
//
// Three ways to send each key:
//   before  agent-browser before #7: keyFields plus nativeVirtualKeyCode, as rawKeyDown; on macOS
//           with the Mac key code and characters (beforeFields). Chrome's shortcuts must fire here
//           (Linux: F5, F11, F12, Control+W; macOS: Meta+R, Meta+W, Meta+Alt+I, and Meta+Control+F
//           with --full-screen), else the check cannot see them. Also Control+L and Control+T on
//           Linux, Meta+T and Meta+L on macOS.
//   record  record's press step: the real sendKey and parseKey, F1 to F12 with eight modifier sets.
//   press   the press command (Tab.press): keyDown with keyFields, F1 to F12 alone.
// It writes DIR/results.jsonl (new for each run) and prints a JSON summary with "ok". It exits 1 when a
// record or press trial had an effect outside the page (Shift+F10, which record refuses, must open the
// context menu on Linux; macOS's Blink opens none), when a key did not reach the page, or when the
// before controls show nothing; and 2 for a usage error: an --only entry that names no trial, or a
// start that the platform refuses.
//
// Measured 2026-11-03 (Chromium 156.0.8078.73, Debian 13, Xvfb; 207 trials, exit 0): before: F1 (a
// help tab), F3, Shift+F3, F6, Shift+F6, F7, F10 (the focus left the page), Control+F4, Alt+F4 (the
// tab and its window closed), F5, Shift+F5, Control+F5 (reload), Shift+F10 (contextmenu), F11 (full
// screen), F12 (DevTools), Control+L, Control+T and Control+W. record: only Shift+F10 (contextmenu).
// press: none. Every record and press key reached the page. macOS (209 trials, 210 with --full-screen):
// not measured yet.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { keyFields, type Tab } from "../../../src/browser.ts";
import { parseKey, sendKey } from "../../../src/record.ts";
import { beforeFields, chromeArgs, failures as failuresOf, startMode, trialTable, type Result, type Way } from "./trials.ts";

const { values } = parseArgs({ options: { "out-dir": { type: "string" }, chrome: { type: "string" }, display: { type: "string" }, "wait-ms": { type: "string" }, only: { type: "string" },
  "on-my-screen": { type: "boolean" }, background: { type: "boolean" }, "full-screen": { type: "boolean" } } });
if (!values["out-dir"]) {
  process.stderr.write("usage: node test/live/function-keys/check.ts --out-dir DIR [--chrome /usr/bin/chromium] [--display 97] [--wait-ms 1200] [--only record:F5,...]\n" +
    "  macOS: node test/live/function-keys/check.ts --on-my-screen --chrome APP_BINARY --out-dir DIR [--background] [--full-screen] [--wait-ms 1200] [--only ...]\n");
  process.exit(2);
}
const start = startMode(process.platform, { onMyScreen: values["on-my-screen"], background: values.background, fullScreen: values["full-screen"], chrome: values.chrome, display: values.display });
if ("error" in start) {
  process.stderr.write(`${start.error}\n`);
  process.exit(2);
}
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

if (!MAC) {
  const socket = `/tmp/.X11-unix/X${DISPLAY}`;
  if (existsSync(socket)) throw new Error(`display :${DISPLAY} is in use; pass --display N`);
  const xvfb = spawn("Xvfb", [`:${DISPLAY}`, "-auth", xauth, "-nolisten", "tcp", "-screen", "0", "1280x800x24"], { stdio: "ignore" });
  children.push(xvfb);
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
let active = "";
for (let i = 0; i < (MAC ? 300 : 100) && !active; i++) { try { active = readFileSync(join(profile, "DevToolsActivePort"), "utf8"); } catch { await sleep(100); } }
if (!active) throw new Error(`${CHROME} did not start`);
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
  if (browser?.id !== chrome.pid) throw new Error(`the DevTools port in ${profile} is not the check's own Chrome (browser pid ${browser?.id}, child ${chrome.pid}); nothing more is sent to it`);
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
  // without an effect proves nothing. --background drops it to confirm that on a Mac (the before
  // controls are then expected to fail); the page still gets each key, because CDP key input focuses
  // its page (InputInjector::InjectKeyboardEvent), but has no focus before the key.
  if (FRONT) await send("Page.bringToFront", {}, sessionId);
  await sleep(300);
  // macOS activates the app and its window asynchronously: wait up to 2 s more for the focus.
  for (let i = 0; i < 20 && MAC && FRONT && !(await evaluate("document.hasFocus()").catch(() => false)); i++) await sleep(100);
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
  await press(way, spec, sessionId).catch((e: Error) => { sendError = e.message; });
  let fullScreen: string | undefined;
  if (MAC) fullScreen = await waitLeavingFullScreen(windowId); else await sleep(WAIT_MS);
  listeners.splice(listeners.indexOf(onNav), 1);
  const alive = (await send("Target.getTargets")).targetInfos.some((x: any) => x.targetId === targetId);
  const page = alive ? await evaluate(`({ log: window.__log ?? [], focus: document.hasFocus(), kept: window.__mark === "${mark}" })`).catch(() => null) : null;
  const stateAfter = await windowState(windowId);
  const key = parseKey(spec).key;
  const newTargets = created.filter((c) => !before.has(c.id) && c.id !== targetId);
  const effects = [
    ...(navigated || (page && !page.kept) ? ["reload"] : []),
    ...(alive ? [] : ["closed"]),
    ...newTargets.map((c) => `new ${c.type} ${c.url.split("?")[0]}`),
    ...(fullScreen ? [`window ${stateBefore} -> fullscreen, ${fullScreen}`] : stateAfter !== stateBefore ? [`window ${stateBefore} -> ${stateAfter}`] : []),
    ...(page?.log.some((e: any) => e.t === "blur") || (ready.focus && ready.field && page && !page.focus) ? ["page blur"] : []),
    ...(page?.log.some((e: any) => e.t === "contextmenu") ? ["contextmenu"] : []),
  ];
  for (const c of newTargets) await send("Target.closeTarget", { targetId: c.id }).catch(() => {});
  return { way, spec, focused, reachedPage: !!page?.log.some((e: any) => e.t === "keydown" && e.key === key), effects, ...(sendError ? { sendError } : {}) };
}

const windowState = (windowId: number): Promise<string> => send("Browser.getWindowBounds", { windowId }).then((r) => r.bounds.windowState, () => "gone");

/**
 * macOS: waits --wait-ms, and a window that enters full screen (its own Space, to which the screen
 * switches) leaves it at once. Says how it left, or undefined when it never entered full screen. The
 * transition takes about a second, and a request during it can fail, so it asks again until it ends.
 */
async function waitLeavingFullScreen(windowId: number): Promise<string | undefined> {
  const end = Date.now() + WAIT_MS;
  let left: string | undefined;
  while (Date.now() < end) {
    await sleep(100);
    if (left || (await windowState(windowId)) !== "fullscreen") continue;
    const t0 = Date.now();
    left = "full screen not left in 10 s";
    while (Date.now() - t0 < 10_000) {
      await send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }).catch(() => {});
      await sleep(500);
      if ((await windowState(windowId)) !== "fullscreen") { left = `left full screen at once (${Date.now() - t0} ms)`; break; }
    }
  }
  return left;
}

const results: Result[] = [];
for (const t of trials) {
  const r: Result = await trial(t.way, t.spec).catch((e: Error) => ({ way: t.way, spec: t.spec, focused: false, reachedPage: false, effects: [`trial error: ${e.message}`] }));
  results.push(r);
  writeFileSync(RESULTS, JSON.stringify(r) + "\n", { flag: "a" });
  process.stderr.write(`${r.way.padEnd(6)} ${r.spec.padEnd(18)} ${r.reachedPage ? "page" : "    "} ${r.effects.join(", ")}\n`);
}
const of = (way: Way) => results.filter((r) => r.way === way);
const failures = failuresOf(results, mode);
const summary = {
  ok: failures.length === 0, chrome: product, ...(MAC ? { mode: FRONT ? "macOS, each window to the front" : "macOS, --background" } : {}), trials: results.length,
  before: of("before").filter((r) => r.effects.length).map((r) => `${r.spec}: ${r.effects.join(", ")}`),
  record: of("record").filter((r) => r.effects.length).map((r) => `${r.spec}: ${r.effects.join(", ")}`),
  press: of("press").filter((r) => r.effects.length).map((r) => `${r.spec}: ${r.effects.join(", ")}`),
  failures,
};
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
ws.close();
server.close();
process.exit(failures.length ? 1 : 0);
