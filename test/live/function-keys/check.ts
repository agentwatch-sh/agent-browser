// The live function-key check (Linux, #7): a key event that the page does not handle never reaches
// Chrome's own shortcuts. It starts a real, headful Chromium of its own in a private Xvfb (with -auth),
// on a throwaway profile, with one local probe.localhost page and no network: every other host fails
// to resolve and goes to a dead proxy. Each trial opens a new window, sends one key, and records what
// the page saw and what Chrome did: a reload, a closed tab or window, a new target (DevTools, a help
// tab, a new tab), full screen, a page blur (the focus went to Chrome's UI) and a contextmenu event.
// Not part of `npm test`.
//
//   node test/live/function-keys/check.ts --out-dir DIR [--chrome /usr/bin/chromium] [--display 97]
//     [--wait-ms 1200] [--only before:F5,record:Shift+F11,press:F12]
//
// Three ways to send each key:
//   before  agent-browser before #7: keyFields plus nativeVirtualKeyCode, as rawKeyDown. Chrome's
//           shortcuts must fire here (F5, F11, F12, Control+W), else the check cannot see them.
//   record  record's press step: the real sendKey and parseKey, F1 to F12 with eight modifier sets.
//   press   the press command (Tab.press): keyDown with keyFields, F1 to F12 alone.
// It writes DIR/results.jsonl (new for each run) and prints a JSON summary with "ok". It exits 1 when a
// record or press trial had an effect outside the page (Shift+F10, which record refuses, must open the
// context menu), when a key did not reach the page, or when the before controls show nothing; and 2
// when an --only entry names no trial.
//
// Measured 2026-11-03 (Chromium 156.0.8078.73, Debian 13, Xvfb; 207 trials, exit 0): before: F1 (a
// help tab), F3, Shift+F3, F6, Shift+F6, F7, F10 (the focus left the page), Control+F4, Alt+F4 (the
// tab and its window closed), F5, Shift+F5, Control+F5 (reload), Shift+F10 (contextmenu), F11 (full
// screen), F12 (DevTools), Control+L, Control+T and Control+W. record: only Shift+F10 (contextmenu).
// press: none. Every record and press key reached the page.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { keyFields, type Tab } from "../../../src/browser.ts";
import { parseKey, sendKey } from "../../../src/record.ts";

const { values } = parseArgs({ options: { "out-dir": { type: "string" }, chrome: { type: "string" }, display: { type: "string" }, "wait-ms": { type: "string" }, only: { type: "string" } } });
if (!values["out-dir"]) {
  process.stderr.write("usage: node test/live/function-keys/check.ts --out-dir DIR [--chrome /usr/bin/chromium] [--display 97] [--wait-ms 1200] [--only record:F5,...]\n");
  process.exit(2);
}
if (process.platform !== "linux") {
  process.stderr.write("Linux only: the check needs a private Xvfb, so that no Chrome window, full screen or dialog reaches a person's screen\n");
  process.exit(2);
}
const OUT = resolve(values["out-dir"]);
const CHROME = values.chrome ?? "/usr/bin/chromium";
const DISPLAY = Number(values.display ?? 97);
const WAIT_MS = Number(values["wait-ms"] ?? 1200);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Way = "before" | "record" | "press";
const MODS = ["", "Shift+", "Control+", "Alt+", "Meta+", "Control+Shift+", "Alt+Shift+", "Control+Alt+"];
const F = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);
const CONTROLS = ["Control+L", "Control+T", "Control+W"]; // Chrome shortcuts outside the function keys
let trials: { way: Way; spec: string }[] = [
  ...[...F.flatMap((k) => MODS.map((m) => m + k)), ...CONTROLS].map((spec) => ({ way: "before" as Way, spec })),
  ...F.flatMap((k) => MODS.map((m) => ({ way: "record" as Way, spec: m + k }))),
  ...F.map((spec) => ({ way: "press" as Way, spec })),
];
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
writeFileSync(xauth, Buffer.concat([Buffer.from([0xff, 0xff]), field(Buffer.alloc(0)), field(Buffer.from(String(DISPLAY))),
  field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(randomBytes(16))]), { mode: 0o600 });

const children: ChildProcess[] = [];
process.on("exit", () => { for (const c of children.reverse()) c.kill("SIGTERM"); });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));

const socket = `/tmp/.X11-unix/X${DISPLAY}`;
if (existsSync(socket)) throw new Error(`display :${DISPLAY} is in use; pass --display N`);
const xvfb = spawn("Xvfb", [`:${DISPLAY}`, "-auth", xauth, "-nolisten", "tcp", "-screen", "0", "1280x800x24"], { stdio: "ignore" });
children.push(xvfb);
for (let i = 0; i < 50 && !existsSync(socket) && xvfb.exitCode === null; i++) await sleep(100);
await sleep(200);
// The socket must be our Xvfb's: another X server that took the display between the check and the spawn
// makes ours exit, and Chromium must never open its windows there.
if (!existsSync(socket) || xvfb.exitCode !== null) throw new Error(`Xvfb did not start on :${DISPLAY}; pass another --display N`);

// The page logs its key, focus and context-menu events and handles (prevents) none of them.
const PAGE = `<!doctype html><title>function keys</title><input id="f" autofocus><script>
window.__log = [];
for (const t of ["keydown", "keyup", "contextmenu", "blur"]) window.addEventListener(t, (e) => __log.push({ t, key: e.key }), true);
</script>`;
const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const URL_ = `http://probe.localhost:${(server.address() as { port: number }).port}/`;

/** Our Xvfb only: without the Wayland variables of a desktop session, Chromium cannot open a window there. */
function chromeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: `:${DISPLAY}`, XAUTHORITY: xauth };
  delete env.WAYLAND_DISPLAY;
  delete env.XDG_SESSION_TYPE;
  return env;
}

const profile = join(OUT, "profile");
mkdirSync(profile, { recursive: true });
rmSync(join(profile, "DevToolsActivePort"), { force: true }); // a run before in this --out-dir left its own
children.push(spawn(CHROME, [
  "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "--remote-debugging-port=0",
  "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps", "--password-store=basic",
  "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE probe.localhost", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=probe.localhost",
  "--ozone-platform=x11", "--window-position=0,0", "--window-size=1100,700", "about:blank",
], { env: chromeEnv(), stdio: "ignore" }));
let active = "";
for (let i = 0; i < 100 && !active; i++) { try { active = readFileSync(join(profile, "DevToolsActivePort"), "utf8"); } catch { await sleep(100); } }
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
  const base = { ...keyFields(k.key, k.code, k.keyCode, k.modifiers), nativeVirtualKeyCode: k.keyCode };
  await tab.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function trial(way: Way, spec: string) {
  const before = new Set((await send("Target.getTargets")).targetInfos.map((x: any) => x.targetId));
  const { targetId } = await send("Target.createTarget", { url: URL_, newWindow: true });
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
  await send("Page.bringToFront", {}, sessionId);
  await sleep(300);
  const { windowId } = await send("Browser.getWindowForTarget", { targetId });
  const stateBefore = (await send("Browser.getWindowBounds", { windowId })).bounds.windowState;
  const mark = randomBytes(6).toString("hex");
  const focused = await evaluate(`window.__mark = "${mark}"; document.hasFocus() && document.activeElement?.id === "f"`);
  let navigated = false;
  const onNav = (m: any) => { if (m.sessionId === sessionId && m.method === "Page.frameNavigated" && !m.params.frame.parentId) navigated = true; };
  listeners.push(onNav);
  created.length = 0;
  let sendError: string | undefined;
  await press(way, spec, sessionId).catch((e: Error) => { sendError = e.message; });
  await sleep(WAIT_MS);
  listeners.splice(listeners.indexOf(onNav), 1);
  const alive = (await send("Target.getTargets")).targetInfos.some((x: any) => x.targetId === targetId);
  const page = alive ? await evaluate(`({ log: window.__log ?? [], focus: document.hasFocus(), kept: window.__mark === "${mark}" })`).catch(() => null) : null;
  const stateAfter = await send("Browser.getWindowBounds", { windowId }).then((r) => r.bounds.windowState, () => "gone");
  const key = parseKey(spec).key;
  const newTargets = created.filter((c) => !before.has(c.id) && c.id !== targetId);
  const effects = [
    ...(navigated || (page && !page.kept) ? ["reload"] : []),
    ...(alive ? [] : ["closed"]),
    ...newTargets.map((c) => `new ${c.type} ${c.url.split("?")[0]}`),
    ...(stateAfter !== stateBefore ? [`window ${stateBefore} -> ${stateAfter}`] : []),
    ...(page?.log.some((e: any) => e.t === "blur") || (focused && page && !page.focus) ? ["page blur"] : []),
    ...(page?.log.some((e: any) => e.t === "contextmenu") ? ["contextmenu"] : []),
  ];
  for (const c of newTargets) await send("Target.closeTarget", { targetId: c.id }).catch(() => {});
  return { way, spec, focused, reachedPage: !!page?.log.some((e: any) => e.t === "keydown" && e.key === key), effects, ...(sendError ? { sendError } : {}) };
}

const results = [];
for (const t of trials) {
  const r = await trial(t.way, t.spec).catch((e: Error) => ({ way: t.way, spec: t.spec, focused: false, reachedPage: false, effects: [`trial error: ${e.message}`] }));
  results.push(r);
  writeFileSync(RESULTS, JSON.stringify(r) + "\n", { flag: "a" });
  process.stderr.write(`${r.way.padEnd(6)} ${r.spec.padEnd(18)} ${r.reachedPage ? "page" : "    "} ${r.effects.join(", ")}\n`);
}
const of = (way: Way) => results.filter((r) => r.way === way);
const failures = [
  ...[...of("record"), ...of("press")].filter((r) => r.spec !== "Shift+F10" && (r.effects.length || !r.reachedPage)).map((r) => `${r.way} ${r.spec}: ${r.effects.join(", ") || "never reached the page"}`),
  ...of("record").filter((r) => r.spec === "Shift+F10" && !r.effects.includes("contextmenu")).map(() => "record Shift+F10: no context menu (record refuses it for that)"),
  ...of("before").filter((r) => ["F5", "F11", "F12", "Control+W"].includes(r.spec) && !r.effects.length).map((r) => `before ${r.spec}: no effect, so the check cannot see Chrome's shortcuts`),
  ...results.filter((r) => !r.focused).map((r) => `${r.way} ${r.spec}: the page had no focus before the key`),
];
const summary = {
  ok: failures.length === 0, chrome: product, trials: results.length,
  before: of("before").filter((r) => r.effects.length).map((r) => `${r.spec}: ${r.effects.join(", ")}`),
  record: of("record").filter((r) => r.effects.length).map((r) => `${r.spec}: ${r.effects.join(", ")}`),
  press: of("press").filter((r) => r.effects.length).map((r) => `${r.spec}: ${r.effects.join(", ")}`),
  failures,
};
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
ws.close();
server.close();
process.exit(failures.length ? 1 : 0);
