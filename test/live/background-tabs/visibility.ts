// The live hidden-tab check (Linux, ab-v16.15): what a command on a background tab shows a site, in
// agent-browser's two modes. Not part of `npm test`; its pure parts (spans.ts) are, in
// test/hidden-tab.test.ts.
//
//   node test/live/background-tabs/visibility.ts --out-dir DIR [--hidden-drive] [--chrome /usr/bin/chromium] [--display 97]
//
// Without --hidden-drive the check runs agent-browser's default mode (focus emulation while a command
// is attached: the page is visible for the command); with it, the hiddenDrive option (the page stays
// hidden). Like check.ts beside it (ab-v16.13), it goes through agent-browser's own launch
// (launchAgentChrome, the proxy, approve: "xdotool") in a private Xvfb that it starts (with -auth), on
// a new state folder and profile (DIR/run-XXXXXX), with one local page server (probe.localhost) and no
// network. It ends only its own children and the agent Chrome on its own profile: it never quits,
// kills or connects to a Chrome that it did not start.
//
// Each probe page reports its events to the check's server with navigator.sendBeacon, out of band: a
// visibilitychange, focus and blur (with document.visibilityState and document.hasFocus()), each trusted
// click, key and input, a mouseenter, and its animation frames. agent-browser opens tabs a and b in the
// background (the launch's chrome://inspect tab stays in front) and the check runs each command as the
// CLI does (`commands.*`), 2.5 s apart:
//   on a, hidden:  eval, text, outline, hover, click, type, press, shot, shot --size, shot --full
//   c, new:        open c in the background, then click (a page that never drew a frame), text, shot
//   on b, hidden:  goto (a new page, hidden), then click and type
//   on a, hidden:  record 3 s (needs ffmpeg with libx264)
//   on a, front:   the check brings a to the front (Target.activateTarget on its own connection, as
//                  the operator clicks a tab), then click and shot: a front tab works as before
// Each command must work (its effect is in the page's log or in the shot's pixels). For each one the
// summary gives the page's visible time while it ran, its visibilitychange events, its focus and blur
// events, and the frames that a hidden page drew in the second after it (from 0.3 s to 1.3 s).
//   exit 0  every command worked. With --hidden-drive also: a command on a hidden tab left the page
//           hidden (no visible time and no visibilitychange), except record (its span is reported), and
//           a hidden page drew no frame after a command.
//   exit 1  a failure in the summary, or an error with a stack trace and no summary.
//   exit 2  nothing was driven: a usage error, not Linux, a display in use, Xvfb did not start, or
//           agent-browser could not start its Chrome or connect to it.
//
// Measured 2026-11-04 on taylor (Chromium 156.0.8078.79, Debian 13, the launch flags of ab-v16.13).
// The default mode, 2 runs (main at 143a556, and this check's tip), exit 1 both: the hidden page was
// visible for each command, with two visibilitychange events, and got a focus and a blur: eval 9 ms,
// text 13 to 14, outline 14 to 16, type 17, press 11 to 13, hover 1015 to 1028, click 1021 to 1025 (17
// to 34 in tabs c and b), shot 3082 to 4092, shot --size 2594 to 3136, shot --full 249 to 493, open 21
// to 46, goto 33 to 40, record 4964 to 4989. In both runs the shot of the new tab c failed after 30 s,
// visible all that time (the exit 1). With --hidden-drive, 6 runs (5 of them of a version in which it
// was the default), exit 0: no visible time and no visibilitychange for any command but record (4.6 s,
// two events), no frame after a command, 18 to 140 ms per command (0.9 s for shot --size); the shot of
// tab c took 0.1 s. In front, as before.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AGENT_ARGS, agentChromePid } from "../../../src/agent.ts";
import { AgentBrowser } from "../../../src/browser.ts";
import { commands } from "../../../src/commands.ts";
import { MAX_SOCKET_PATH_BYTES, resolveOptions, type BrowserOptions } from "../../../src/options.ts";
import { stopProxy } from "../../../src/proxy.ts";
import { findFfmpeg, pngPixels } from "../../../src/record.ts";
import { failures, visibleMs, visibleSpans, type Measured, type PageEvent } from "./spans.ts";

const { values } = parseArgs({ options: { "out-dir": { type: "string" }, chrome: { type: "string" }, display: { type: "string" }, "hidden-drive": { type: "boolean" } } });
/** A start that the check refuses: one line, exit 2. The exit handler ends the check's own children. */
function refuse(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
if (!values["out-dir"]) refuse("usage: node test/live/background-tabs/visibility.ts --out-dir DIR [--hidden-drive] [--chrome /usr/bin/chromium] [--display 97]");
if (process.platform !== "linux") refuse(`the hidden-tab check runs on Linux only, in a private Xvfb, so that no window reaches a person's screen (this is ${process.platform})`);
const DISPLAY = Number(values.display ?? 97), CHROME = values.chrome ?? "/usr/bin/chromium", hiddenDrive = !!values["hidden-drive"];
if (!Number.isInteger(DISPLAY) || DISPLAY < 1) refuse(`--display is a whole display number: ${values.display}`);
const OUT = resolve(values["out-dir"]!);
mkdirSync(OUT, { recursive: true });
const RUN = mkdtempSync(join(OUT, "run-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The X authority file (FamilyWild, MIT-MAGIC-COOKIE-1), written here: xauth is not always installed.
const field = (b: Buffer) => { const n = Buffer.alloc(2); n.writeUInt16BE(b.length); return Buffer.concat([n, b]); };
const xauth = join(RUN, "Xauthority");
writeFileSync(xauth, Buffer.concat([Buffer.from([0xff, 0xff]), field(Buffer.alloc(0)), field(Buffer.from(String(DISPLAY))),
  field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(randomBytes(16))]), { mode: 0o600 });

// The consumer: its own state folder, the agent Chrome's profile in it, a socket path that fits, and the
// switches of check.ts (an X11 window in the Xvfb, no keyring, no network but probe.localhost, a fixed window).
const sock = join(RUN, "chrome-proxy.sock");
const o: BrowserOptions = {
  stateDir: RUN, socketPath: Buffer.byteLength(sock) <= MAX_SOCKET_PATH_BYTES ? sock : join(mkdtempSync(join(tmpdir(), "ab-vis-")), "proxy.sock"),
  allow: ["probe.localhost"], chromeBin: CHROME, approve: "xdotool", proxyIdleMs: 120_000, commandName: "hidden-tab check", hiddenDrive,
  chromeArgs: ["--ozone-platform=x11", "--password-store=basic", "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--disable-default-apps", "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE probe.localhost", "--proxy-server=http://127.0.0.1:9",
    "--proxy-bypass-list=probe.localhost", "--window-position=0,0", "--window-size=1100,700"],
  log: (line) => process.stderr.write(`agent-browser: ${line}\n`),
};
const s = resolveOptions(o);

// Only the check's own: its Xvfb, the proxy of its state folder, the agent Chrome on its profile.
const children: ChildProcess[] = [];
process.on("exit", () => {
  try { stopProxy(s); } catch { /* not started */ }
  try { const pid = agentChromePid(s); if (pid) process.kill(pid, "SIGTERM"); } catch { /* not started */ }
  for (const c of children.reverse()) c.kill("SIGTERM");
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));

const socket = `/tmp/.X11-unix/X${DISPLAY}`;
if (existsSync(socket)) refuse(`display :${DISPLAY} is in use; pass --display N`);
const xvfb = spawn("Xvfb", [`:${DISPLAY}`, "-auth", xauth, "-nolisten", "tcp", "-screen", "0", "1280x800x24"], { stdio: "ignore" });
children.push(xvfb);
for (let i = 0; i < 50 && !existsSync(socket) && xvfb.exitCode === null; i++) await sleep(100);
await sleep(200);
if (!existsSync(socket) || xvfb.exitCode !== null) refuse(`Xvfb did not start on :${DISPLAY}; pass another --display N`);
process.env.DISPLAY = `:${DISPLAY}`;
process.env.XAUTHORITY = xauth;
delete process.env.WAYLAND_DISPLAY;
delete process.env.XDG_SESSION_TYPE;

// The probe page: a colour box that each trusted click changes, a field, a button, a "clicks: N" line.
const COLOURS = [[200, 0, 0], [0, 160, 0], [0, 0, 200]]; // before any click, after an odd click, after an even one
const PAGE = (name: string) => `<!doctype html><title>tab ${name}</title>
<style>body{margin:0;font:16px sans-serif}#box{position:fixed;left:0;top:0;width:200px;height:200px;background:rgb(${COLOURS[0]})}
#f{position:absolute;left:10px;top:220px}#b{position:absolute;left:10px;top:260px;width:120px;height:40px}#s{position:absolute;left:10px;top:310px}</style>
<div id="box"></div><input id="f" autocomplete="off"><button id="b">Click</button><p id="s">clicks: 0</p>
<script>
const colours = ${JSON.stringify(COLOURS.map((c) => `rgb(${c})`))};
const send = (ev, extra) => navigator.sendBeacon("/log", JSON.stringify({ t: Date.now(), tab: ${JSON.stringify(name)}, ev, vis: document.visibilityState, focus: document.hasFocus(), ...extra }));
document.addEventListener("visibilitychange", () => send("visibilitychange"));
addEventListener("focus", () => send("focus"));
addEventListener("blur", () => send("blur"));
addEventListener("keydown", (e) => send("keydown:" + e.key + ":" + e.isTrusted), true);
document.getElementById("box").addEventListener("mouseenter", () => send("mouseenter-box"));
document.getElementById("f").addEventListener("input", (e) => send("input", { value: e.target.value }));
let clicks = 0;
document.getElementById("b").addEventListener("click", (e) => {
  clicks++;
  document.getElementById("box").style.background = colours[clicks % 2 ? 1 : 2];
  document.getElementById("s").textContent = "clicks: " + clicks;
  send("click:" + e.isTrusted, { clicks });
});
let frames = [];
(function frame() { frames.push(Date.now()); requestAnimationFrame(frame); })();
setInterval(() => { if (frames.length) { send("frames", { list: frames }); frames = []; } }, 250);
send("load");
</script>`;
type Logged = PageEvent & { value?: string; clicks?: number; list?: number[] };
const log: Logged[] = [];
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/log") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { try { log.push(JSON.parse(body)); } catch { /* not ours */ } res.writeHead(204); res.end(); });
    return;
  }
  const m = /^\/([abc])(\?.*)?$/.exec(req.url ?? "");
  if (!m) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGE(m[1]));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://probe.localhost:${(server.address() as { port: number }).port}`;

// The first command launches the agent Chrome and starts the proxy, as an agent's first command does.
const ids: Record<string, string> = {};
try { ids.a = (await commands.open(o, { url: `${BASE}/a`, name: "a" })).tab.targetId; }
catch (e) { refuse(`agent-browser could not start its Chrome or connect to it: ${(e as Error).message.split("\n")[0]} (see ${RUN})`); }
ids.b = (await commands.open(o, { url: `${BASE}/b`, name: "b" })).tab.targetId;
// The check's own connection, through agent-browser's approved proxy: it only switches the front tab.
const browser = await AgentBrowser.connect(o);
const product = browser.product;
let ffmpeg: string | undefined;
try { ffmpeg = findFfmpeg(); } catch { ffmpeg = undefined; }

const run: Measured[] = [];
const events = (tab: string, from: number, to: number) => log.filter((e) => e.tab === tab && e.t >= from && e.t <= to);
const last = (tab: string, ev: (e: Logged) => boolean) => log.filter((e) => e.tab === tab && ev(e)).at(-1);
const clicksOf = (tab: string) => last(tab, (e) => e.ev.startsWith("click:"))?.clicks ?? 0;

/** Run one command; `check` returns undefined when its effect is there, else what is wrong. */
async function measure(command: string, tab: string, front: string, fn: () => Promise<unknown>, check: (r: unknown) => string | undefined | Promise<string | undefined>): Promise<void> {
  await sleep(500);
  const t0 = Date.now();
  let r: unknown, detail: string | undefined;
  try { r = await fn(); } catch (e) { detail = `error: ${(e as Error).message.split("\n")[0]}`; }
  const t1 = Date.now();
  await sleep(2500); // the page's last frames batch comes within a hidden page's 1 s timer
  if (detail === undefined) { try { detail = await check(r); } catch (e) { detail = `check: ${(e as Error).message.split("\n")[0]}`; } }
  const spans = visibleSpans(log, tab, t0, t1 + 200);
  const during = events(tab, t0, t1 + 200);
  const framesAfter = log.filter((e) => e.tab === tab && e.ev === "frames").flatMap((e) => e.list ?? []).filter((t) => t >= t1 + 300 && t <= t1 + 1300).length;
  run.push({ command, tab, front, ms: t1 - t0, ok: detail === undefined, ...(detail === undefined ? {} : { detail }),
    visibleMs: visibleMs(spans, t0, t1 + 200), visibilityChanges: during.filter((e) => e.ev === "visibilitychange").length,
    focusEvents: during.filter((e) => e.ev === "focus" || e.ev === "blur").map((e) => `${e.ev}@${e.t - t0}`), framesAfter });
  process.stderr.write(`${command} ${tab}: ${JSON.stringify(run.at(-1))}\n`);
}

/** A shot's box must show the page's clicks, with the button and the "clicks: N" line drawn below the first row of 256 px tiles. */
function shotDetail(path: string, clicks: number): string | undefined {
  const px = pngPixels(readFileSync(path)), want = COLOURS[clicks === 0 ? 0 : clicks % 2 ? 1 : 2];
  const at = (100 * px.width + 100) * px.channels, got = [px.data[at], px.data[at + 1], px.data[at + 2]];
  if (!got.every((v, i) => Math.abs(v - want[i]) <= 8)) return `the shot's box is rgb(${got}), expected rgb(${want}) after ${clicks} clicks`;
  let drawn = 0;
  for (let y = 256; y < Math.min(360, px.height); y++) for (let x = 0; x < Math.min(200, px.width); x++) {
    const i = (y * px.width + x) * px.channels;
    if (px.data[i] < 240 || px.data[i + 1] < 240 || px.data[i + 2] < 240) drawn++;
  }
  return drawn >= 1000 ? undefined : `the shot has ${drawn} drawn pixels below y=256, expected at least 1000`;
}
const shot = (tab: string, name: string, extra: { size?: string; full?: boolean } = {}) =>
  measure(`shot${extra.size ? " --size" : extra.full ? " --full" : ""}`, tab, front, () => commands.shot(o, { tab, path: join(RUN, "shots", `${name}.png`), ...extra }),
    (r) => shotDetail((r as { path: string }).path, clicksOf(tab)));
const click = (tab: string) => {
  let before = 0;
  return measure("click", tab, front, async () => { before = clicksOf(tab); return commands.click(o, { tab, target: "#b" }); },
    () => (last(tab, (e) => e.ev.startsWith("click:"))?.ev === "click:true" && clicksOf(tab) === before + 1 ? undefined : `the page saw ${clicksOf(tab) - before} trusted clicks, expected 1`));
};
const type = (tab: string, text: string) => measure("type", tab, front, () => commands.type(o, { tab, text, into: "#f" }),
  () => (last(tab, (e) => e.ev === "input")?.value?.endsWith(text) ? undefined : `the field holds ${JSON.stringify(last(tab, (e) => e.ev === "input")?.value)}`));

let front = "chrome://inspect";
await sleep(1500);
// a, hidden behind the launch's chrome://inspect tab.
await measure("eval", "a", front, () => commands.eval(o, { tab: "a", expression: "document.title" }), (r) => ((r as { value: unknown }).value === "tab a" ? undefined : `eval gave ${JSON.stringify(r)}`));
await measure("text", "a", front, () => commands.text(o, { tab: "a" }), (r) => ((r as { text: string }).text.includes("clicks: 0") ? undefined : "no clicks line"));
await measure("outline", "a", front, () => commands.outline(o, { tab: "a" }), (r) => ((r as { elements: unknown[] }).elements.length >= 2 ? undefined : "no elements"));
await measure("hover", "a", front, () => commands.hover(o, { tab: "a", target: "#box" }), () => (last("a", (e) => e.ev === "mouseenter-box") ? undefined : "the page saw no mouseenter"));
await click("a");
await type("a", "hello");
await measure("press", "a", front, () => commands.press(o, { tab: "a", key: "End" }), () => (last("a", (e) => e.ev === "keydown:End:true") ? undefined : "the page saw no End key"));
await shot("a", "a");
await shot("a", "a-size", { size: "800x600" });
await shot("a", "a-full", { full: true });
// c: a new background tab, whose page never drew a frame before the first command.
await measure("open", "c", front, async () => { ids.c = (await commands.open(o, { url: `${BASE}/c`, name: "c" })).tab.targetId; }, () => undefined);
await click("c");
await measure("text", "c", front, () => commands.text(o, { tab: "c" }), (r) => ((r as { text: string }).text.includes("clicks: 1") ? undefined : "no clicks line"));
await shot("c", "c");
// b: a new page in the hidden tab, then input.
await measure("goto", "b", front, () => commands.goto(o, { tab: "b", url: `${BASE}/b?again` }), () => undefined);
await click("b");
await type("b", "world");
// record a, hidden.
if (ffmpeg) {
  const script = join(RUN, "record-steps.json");
  writeFileSync(script, JSON.stringify([{ wait: 3000 }]));
  await measure("record", "a", front, () => commands.record(o, { tab: "a", out: join(RUN, "record-a.mp4"), script, size: "640x360", fps: 30, ffmpeg }),
    (r) => ((r as { frames: number }).frames >= 60 ? undefined : `${(r as { frames: number }).frames} frames`));
}
// a in front: as before.
await browser.conn.send("Target.activateTarget", { targetId: ids.a });
front = "a";
await sleep(1000);
await click("a");
await shot("a", "a-front");

const failed = failures(run, hiddenDrive);
const summary = {
  ok: failed.length === 0, chrome: product, flags: AGENT_ARGS, hiddenDrive, ffmpeg: !!ffmpeg,
  commands: run.map((m) => ({ command: m.command, tab: m.tab, front: m.front, ok: m.ok, ms: m.ms, visibleMs: m.visibleMs, visibilityChanges: m.visibilityChanges, focusEvents: m.focusEvents, framesAfter: m.framesAfter, ...(m.detail ? { detail: m.detail } : {}) })),
  failures: failed, run: RUN,
};
writeFileSync(join(RUN, "summary.json"), JSON.stringify({ ...summary, log }, null, 2) + "\n");
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
await browser.disconnect();
await commands.quit(o).catch(() => {});
server.close();
process.exit(failed.length ? 1 : 0);
