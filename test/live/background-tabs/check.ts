// The live background-tab check (Linux, ab-v16.13): agent-browser starts its agent Chrome without the two
// timer flags (--disable-background-timer-throttling, --disable-renderer-backgrounding), so a hidden tab's
// timers slow down as in plain Chrome, and it still switches tabs and drives a tab that is not in front.
// The operator's condition for the drop (ab-vsm, 2026-11-04): "As long as the agentbrowser can swap tabs
// i'm OK with dropping timers." Not part of `npm test`; its pure parts (rules.ts) are, in
// test/background-tabs.test.ts.
//
//   node test/live/background-tabs/check.ts --out-dir DIR [--chrome /usr/bin/chromium] [--display 98]
//     [--before] [--hidden-ms 6000] [--hidden-drive | --window-drive] [--new-tabs 5]
//
// --window-drive runs Linux's default open, without --tab: each page has its own window. All pages
// stay visible before, during and after a drive, even when another window is in front. Their timers
// run at full rate and their animation frames continue. The shot pixel rules stay the same: the
// box, button and status line must be drawn. visibleMs includes a window's existing visible span,
// clipped to the drive or recording; it measures continuous visibility, not a command's focus span.
// p5 opens new visible windows, rather than tabs that never drew. --hidden-drive cannot be combined
// with --window-drive. The phase descriptions below describe the two tab modes.
//
// It goes through agent-browser's own launch, as an agent's first command does: launchAgentChrome
// starts the Chrome with AGENT_ARGS, no debugging port and remote debugging seeded on, and the proxy
// answers Chrome's "Allow remote debugging?" prompt with the xdotool approver (approve: "xdotool"), the
// README's recipe for a Linux box with no screen. All of it runs in a private Xvfb that the check starts
// (with -auth), on a new state folder and profile (DIR/run-XXXXXX), with one local page server
// (probe.localhost) and no network: every other host fails to resolve and goes to a dead proxy. The
// check ends only its own children and the agent Chrome on its own profile: it never quits, kills or
// connects to a Chrome that it did not start. Each run leaves its DIR/run-XXXXXX behind (the shots, the
// recordings, summary.json).
//
// The page logs its 50 ms interval timer, its animation frames, its trusted clicks and its visibility
// changes into the DOM, where agent-browser's commands read them. A tab's visibility comes from that log
// at a time when no command is attached. In agent-browser's default mode a background tab's page is
// visible for the length of each command, from its attach to its detach, and hidden again after it: in
// the logs of the runs on taylor 5 to 40 ms for eval, text, type and most clicks, about 1 s for some
// first clicks in a hidden tab, 0.6 to 3 s for a shot, and 5 s for a 3 s recording. With the
// hiddenDrive option (ab-v16.15) it stays hidden during a command, and only a recording makes it
// visible, for its run. This check runs the default mode, or with --hidden-drive the hidden drive;
// visibility.ts beside this file measures both modes, per command. The summary gives these spans
// ("visibleMs") and the state during a command ("during"), as information. agent-browser opens
// tabs a and b in the background with `open --tab` (on Linux every other page gets a window of its own,
// ab-v16.26; the explicit tab keeps these modes) (the chrome://inspect tab of the launch stays in front), and the check
// drives each tab by its name with the library's commands (`commands.click`, `type`, `eval`, `text`,
// `shot`, as the CLI runs them):
//   p1  front: chrome://inspect. Both timers over --hidden-ms, hidden. Drive a, then b, both hidden.
//   p2  front: a. a's timer (visible) and b's (hidden). Drive b (hidden), then a (in front).
//   p3  front: b. Drive a (hidden).
//   p4  front: a again. Drive b (hidden).
//   p5  front: a. --new-tabs new tabs n1, n2, ..., each opened in the background, then eval, text and
//       shot at once (ab-b84.17): a shot of a new tab whose page never drew a frame (with --hidden-drive,
//       where eval and text draw nothing; in the default mode the open draws it). The eval gives the
//       page's state during the drive ("during"). Each new tab is closed after its drive.
//   record a (in front) and b (hidden) for 3 s each: frames from Chrome (information only).
// agent-browser never brings a tab to the front (the operator's focus rule): the check switches the
// front tab itself, as the operator does with a click on a tab (Target.activateTarget through the
// check's own connection to agent-browser's proxy). Each drive clicks the page's button (a trusted
// click that changes the page's colour box and its "clicks: N" line), types into its field, evaluates
// its title, reads its text, and takes a shot whose colour box must show the click, with the button and
// the "clicks: N" line below y=256 in their own colours (rules.ts, shotProblem). 500 ms after each drive
// the check reads 500 ms of each page's log: the driven tab must be hidden again (unless it is in front)
// with no animation frame, and the front tab visible with frames.
// --before adds the two timer flags back (chromeArgs), to measure the launch of release v0.2.9.
// It prints a JSON summary with "ok", and writes it to DIR/run-XXXXXX/summary.json; "shots" lists each
// shot's time and its problem (rules.ts, shotProblem), if any.
//   exit 0  every step worked, each page was hidden or visible as its phase expects (right before each
//           drive, all through each timer window, and after each drive), a hidden tab drew no animation
//           frame and a visible one drew some, both tabs were listed, a visible tab's timer ran at full
//           rate (median at most 100 ms), and a hidden tab's timer was throttled (median at least
//           500 ms; with --before, at most 100 ms). The recordings must not fail.
//           With --window-drive, every page stays visible throughout each drive and afterward,
//           draws frames, and runs its timer at full rate, in every window.
//   exit 1  a failure in the summary, or an error with a stack trace and no summary.
//   exit 2  nothing was driven, and stderr says why in one line: a usage error, not Linux, a display in
//           use, Xvfb did not start, or agent-browser could not start its Chrome or connect to it.
//
// Measured 2026-11-04 on taylor (Chromium 156.0.8078.79, Debian 13), on Linux only: 4 runs without
// --before and 4 with it of an earlier version of the check, and one of each of this version, all
// exit 0. Every step worked in every hidden tab, also after the front tab changed, and each driven tab
// was hidden again after its drive, with no animation frame. A hidden tab's 50 ms timer: a median of
// 1000 ms (6 ticks in 6 s, no animation frames); with --before, 50 ms (120 ticks, no animation
// frames). A visible tab: 50 ms (120 ticks, about 360 frames) in both. A shot of a hidden tab took 0.7
// to 3.1 s in both (0.1 s in front); a recording of a hidden tab got 60 fps in both. In the earlier
// version, whose shot step read only the box, 1 of 30 shots of a hidden tab without --before lacked
// everything below y=256 (0 of 25 with --before: too few to compare). With the hidden drive (one run
// without --before, of a version of ab-v16.15 in which it was the default, exit 0): each drive of a
// hidden tab read "hidden" during its commands, with no visible span; a shot of a hidden tab took 0.14
// to 0.19 s; the 3 s recording of hidden tab b got 60 fps, with one visible span of 4.6 s.
// With ab-b84.17 (a shot keeps a capture in flight and waits for two frames, in both modes), 4 runs of
// each mode, exit 0 all: 44 shots per mode (20 of hidden tabs, 20 of new tabs in p5, 4 in front), none
// incomplete. The default mode: a shot of a hidden tab took 0.6 to 3.0 s (median 1.7 s), of a new tab
// 0.1 to 1.3 s (median 0.4 s), in front 0.1 s. --hidden-drive: 84 to 121 ms for a hidden tab, 85 to
// 115 ms for a new tab, 55 to 68 ms in front. On 2026-11-05, after review-41 (a frame limit of 5 s, and
// one more capture when the shot's own capture is late), 4 more runs of each mode, exit 0 all: 44 shots
// per mode, none incomplete, and no limit or extra capture in the log. The default mode: a hidden tab
// 0.6 to 3.0 s (median 1.8 s), a new tab 0.1 to 1.8 s (median 0.7 s), in front 0.1 s. --hidden-drive:
// 84 to 133 ms, 89 to 118 ms, 53 to 64 ms. p5's "during": "visible" in the default mode, else "hidden".

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
import {
  BOX_COLOURS, chromeArgs, expectedVisibility, failures, LAYOUT, shotProblem, startMode, TIMER_FLAGS, TIMER_MS, timerStats, visibilityIn, visibleSpans,
  type Drive, type Idle, type Recording, type Run, type Step, type StepName, type Timer,
} from "./rules.ts";
import { harnessGuard } from "../guard.ts";

const { values } = parseArgs({ options: { "out-dir": { type: "string" }, chrome: { type: "string" }, display: { type: "string" }, before: { type: "boolean" },
  "hidden-ms": { type: "string" }, "hidden-drive": { type: "boolean" }, "window-drive": { type: "boolean" }, "new-tabs": { type: "string" } } });
if (!values["out-dir"]) {
  process.stderr.write("usage: node test/live/background-tabs/check.ts --out-dir DIR [--chrome /usr/bin/chromium] [--display 98] [--before] [--hidden-ms 6000] [--hidden-drive | --window-drive] [--new-tabs 5]\n");
  process.exit(2);
}
/** A start that the check refuses: one line, exit 2. The exit handler ends the check's own children. */
function refuse(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
const start = startMode(process.platform, { chrome: values.chrome, display: values.display, before: values.before, hiddenMs: values["hidden-ms"], hiddenDrive: values["hidden-drive"], windowDrive: values["window-drive"], newTabs: values["new-tabs"] });
if ("error" in start) refuse(start.error);
const mode = start;
const OUT = resolve(values["out-dir"]);
mkdirSync(OUT, { recursive: true });
const RUN = mkdtempSync(join(OUT, "run-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The X authority file (FamilyWild, MIT-MAGIC-COOKIE-1), written here: xauth is not always installed.
const field = (b: Buffer) => { const n = Buffer.alloc(2); n.writeUInt16BE(b.length); return Buffer.concat([n, b]); };
const xauth = join(RUN, "Xauthority");
writeFileSync(xauth, Buffer.concat([Buffer.from([0xff, 0xff]), field(Buffer.alloc(0)), field(Buffer.from(String(mode.display))),
  field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(randomBytes(16))]), { mode: 0o600 });

// The consumer: its own state folder, the agent Chrome's profile in it, and a socket path that fits.
const sock = join(RUN, "chrome-proxy.sock");
const o: BrowserOptions = {
  stateDir: RUN, socketPath: Buffer.byteLength(sock) <= MAX_SOCKET_PATH_BYTES ? sock : join(mkdtempSync(join(tmpdir(), "ab-bt-")), "proxy.sock"),
  allow: ["probe.localhost"], chromeBin: mode.chrome, chromeArgs: chromeArgs(mode.before), approve: "xdotool", proxyIdleMs: 120_000,
  hiddenDrive: mode.hiddenDrive, commandName: "background-tabs check", log: (line) => process.stderr.write(`${line}\n`),
};
const s = resolveOptions(o);

// Only the check's own: its Xvfb, the proxy of its state folder, the agent Chrome on its profile.
const children: ChildProcess[] = [];
process.on("exit", () => {
  try { stopProxy(s); } catch { /* not started */ }
  try { const pid = agentChromePid(s); if (pid) process.kill(pid, "SIGTERM"); } catch { /* not started */ }
  for (const c of children.reverse()) c.kill("SIGTERM");
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(130));

// One live harness at a time, and nothing of this check after its end, also after a kill -9 (test/live/README.md).
const harness = await harnessGuard("background-tabs check");
const socket = `/tmp/.X11-unix/X${mode.display}`;
if (existsSync(socket)) refuse(`display :${mode.display} is in use; pass --display N`);
const xvfb = spawn("Xvfb", [`:${mode.display}`, "-auth", xauth, "-nolisten", "tcp", "-screen", "0", "1280x800x24"], { stdio: "ignore" });
children.push(xvfb);
harness.track(xvfb.pid, "Xvfb");
for (let i = 0; i < 50 && !existsSync(socket) && xvfb.exitCode === null; i++) await sleep(100);
await sleep(200);
// The socket must be our Xvfb's: another X server that took the display between the check and the spawn
// makes ours exit, and Chromium must never open its windows there.
if (!existsSync(socket) || xvfb.exitCode !== null) refuse(`Xvfb did not start on :${mode.display}; pass another --display N`);
// The agent Chrome (launchAgentChrome) and the proxy with its xdotool approver inherit this process's
// environment: our Xvfb only. Without the Wayland variables of a desktop session, Chromium cannot open a window elsewhere.
process.env.DISPLAY = `:${mode.display}`;
process.env.XAUTHORITY = xauth;
delete process.env.WAYLAND_DISPLAY;
delete process.env.XDG_SESSION_TYPE;

// The page logs its timer ticks, animation frames, clicks and visibility changes (Date.now() times) into
// a hidden element, which agent-browser's isolated world reads: it shares the DOM, not the page's globals.
// Its parts and colours are LAYOUT's (rules.ts): the button and the status line have colours of their own.
const placed = (r: { x: number; y: number; width?: number; height?: number }) =>
  `position:absolute;left:${r.x}px;top:${r.y}px;${r.width ? `width:${r.width}px;height:${r.height}px;` : ""}margin:0`;
const { box, field: fieldBox, button, status: statusBox } = LAYOUT;
const PAGE = (name: string) => `<!doctype html><title>tab ${name}</title>
<style>body{margin:0;font:16px sans-serif}#box{${placed(box)};position:fixed;background:rgb(${BOX_COLOURS[0]})}#f{${placed(fieldBox)}}
#b{${placed(button)};appearance:none;padding:0;border:0;border-radius:0;background:rgb(${button.colour});color:#000;font:16px sans-serif}
#status{${placed(statusBox)};line-height:${statusBox.height}px;background:rgb(${statusBox.colour});color:#fff}</style>
<div id="box"></div><input id="f" autocomplete="off"><button id="b">Click</button><p id="status">clicks: 0</p><pre id="state" hidden></pre>
<script>
const ticks = [], frames = [], clicks = [], vis = [[Date.now(), document.visibilityState]], colours = ${JSON.stringify(BOX_COLOURS.map((c) => `rgb(${c})`))};
const state = document.getElementById("state"), box = document.getElementById("box"), status = document.getElementById("status");
const write = () => { state.textContent = JSON.stringify({ ticks, frames, clicks, vis }); };
document.addEventListener("visibilitychange", () => { vis.push([Date.now(), document.visibilityState]); if (vis.length > 1000) vis.shift(); write(); });
setInterval(() => { ticks.push(Date.now()); if (ticks.length > 1000) ticks.shift(); write(); }, ${TIMER_MS});
(function frame() { frames.push(Date.now()); if (frames.length > 2000) frames.shift(); requestAnimationFrame(frame); })();
document.getElementById("b").addEventListener("click", (e) => {
  clicks.push(e.isTrusted);
  box.style.background = colours[clicks.length % 2 ? 1 : 2];
  status.textContent = "clicks: " + clicks.length;
  write();
});
write();
</script>`;
const server = createServer((req, res) => {
  const m = /^\/([ab]|n\d+)$/.exec(req.url ?? "");
  if (!m) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGE(m[1]));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://probe.localhost:${(server.address() as { port: number }).port}`;

type PageState = { visibility: string; focus: boolean; title: string; dpr: number; field: string; ticks: number[]; frames: number[]; clicks: boolean[]; vis: [number, string][] };
const STATE_JS = `({ visibility: document.visibilityState, focus: document.hasFocus(), title: document.title, dpr: devicePixelRatio,
  field: document.getElementById("f").value, ...JSON.parse(document.getElementById("state").textContent || "{}") })`;
const pageState = async (tab: string) => (await commands.eval(o, { tab, expression: STATE_JS })).value as PageState;

// The first command launches the agent Chrome and starts the proxy, as an agent's first command does.
const launchStart = Date.now();
let ids: Record<string, string>;
try {
  const a = await commands.open(o, { url: `${BASE}/a`, name: "a", tab: !mode.windowDrive });
  ids = { a: a.tab.targetId };
} catch (e) { refuse(`agent-browser could not start its Chrome or connect to it: ${(e as Error).message.split("\n")[0]} (see ${RUN})`); }
const launchMs = Date.now() - launchStart;
ids.b = (await commands.open(o, { url: `${BASE}/b`, name: "b", tab: !mode.windowDrive })).tab.targetId;
const listed = (await commands.tabs(o)).tabs.map((t) => t.name ?? t.id);
// The check's own connection, through agent-browser's approved proxy: it only switches the front tab.
const browser = await AgentBrowser.connect(o);
const product = browser.product;
async function toFront(tab: string): Promise<void> {
  await browser.conn.send("Target.activateTarget", { targetId: ids[tab] });
  await sleep(1000);
}

const timers: Timer[] = [], drives: Drive[] = [], idles: Idle[] = [], recordings: Recording[] = [];
/** Each shot step's time (ms) and its problem (shotProblem), if any: information, the steps' own failures say the rest. */
const shots: { phase: string; tab: string; front: string; ms: number; problem?: string }[] = [];
const expect = (tab: string, front: string) => expectedVisibility(tab, front, mode.windowDrive);

/** Each tab's timer over the next --hidden-ms, with no command in between. */
async function measure(phase: string, front: string, tabs: string[]): Promise<void> {
  const from = Date.now();
  await sleep(mode.hiddenMs);
  const to = Date.now();
  for (const tab of tabs) {
    const st = await pageState(tab);
    timers.push({ phase, tab, front, visibility: visibilityIn(st.vis, from, to), expected: expect(tab, front), stats: timerStats(st.ticks, st.frames, from, to) });
  }
}

/**
 * Click, type, eval, text and shot in one tab, by its name; each step checks its effect in the page.
 * The page's own state right before the first command comes from its visibility log, after a pause in
 * which no command is attached. `only` runs only those steps (a new tab: eval, text and shot).
 */
async function drive(phase: string, front: string, tab: string, only?: readonly StepName[]): Promise<void> {
  const steps: Step[] = [];
  let during = "unknown";
  await sleep(500);
  const t0 = Date.now();
  const step = async (name: StepName, run: () => Promise<string | undefined>) => {
    if (only && !only.includes(name)) return;
    const t0 = Date.now();
    let detail: string | undefined;
    try { detail = await run(); } catch (e) { detail = `error: ${(e as Error).message.split("\n")[0]}`; }
    steps.push({ step: name, ok: detail === undefined, ms: Date.now() - t0, ...(detail === undefined ? {} : { detail }) });
  };
  const first = await pageState(tab), visibility = visibilityIn(first.vis, t0, t0);
  const n = first.clicks.length + (!only || only.includes("click") ? 1 : 0), text = `${phase}-${tab}-typed`;
  await step("click", async () => {
    await commands.click(o, { tab, target: "#b" });
    const { clicks } = await pageState(tab);
    return clicks.length === n && clicks.every(Boolean) ? undefined : `the page saw clicks ${JSON.stringify(clicks)}, expected ${n} trusted`;
  });
  await step("type", async () => {
    await commands.eval(o, { tab, expression: `document.getElementById("f").value = ""` });
    await commands.type(o, { tab, text, into: "#f" });
    const { field } = await pageState(tab);
    return field === text ? undefined : `the field holds ${JSON.stringify(field)}`;
  });
  await step("eval", async () => {
    const v = (await commands.eval(o, { tab, expression: "({ title: document.title, visibility: document.visibilityState })" })).value as { title: string; visibility: string };
    during = v.visibility;
    return v.title === `tab ${tab}` ? undefined : `eval gave ${JSON.stringify(v)}`;
  });
  await step("text", async () => {
    const t = (await commands.text(o, { tab })).text;
    return t.includes(`clicks: ${n}`) ? undefined : `the text is ${JSON.stringify(t.slice(0, 80))}`;
  });
  await step("shot", async () => {
    const t0 = Date.now(), path = (await commands.shot(o, { tab, path: join(RUN, "shots", `${phase}-${tab}.png`) })).path, ms = Date.now() - t0;
    const problem = shotProblem(pngPixels(readFileSync(path)), n, (await pageState(tab)).dpr);
    shots.push({ phase, tab, front, ms, ...(problem ? { problem } : {}) });
    return problem;
  });
  const end = Date.now(), logs = await idle(phase, front, tab);
  drives.push({ phase, tab, front, visibility, during, ...(mode.windowDrive ? { throughout: visibilityIn(logs[tab], t0, end) } : {}),
    visibleMs: visibleSpans(logs[tab], t0, end, mode.windowDrive), expected: expect(tab, front), steps });
}

/**
 * The 500 ms that start 500 ms after a drive of tab `driven`, with no command attached: each page's
 * own visibility and animation frames then (a, b and the driven tab). Returns each page's visibility log.
 */
async function idle(phase: string, front: string, driven: string): Promise<Record<string, [number, string][]>> {
  await sleep(500);
  const from = Date.now();
  await sleep(500);
  const to = Date.now(), logs: Record<string, [number, string][]> = {};
  for (const tab of new Set(["a", "b", driven])) {
    const st = await pageState(tab);
    logs[tab] = st.vis;
    idles.push({ phase, driven, tab, front, visibility: visibilityIn(st.vis, from, to), expected: expect(tab, front), frames: timerStats(st.ticks, st.frames, from, to).frames });
  }
  return logs;
}

/** A 3 s recording of the tab: Chrome's frames for it (information only; a failure is a failure). `visibility` as in drive. */
async function record(front: string, tab: string, ffmpeg: string | undefined): Promise<void> {
  if (!ffmpeg) { recordings.push({ tab, front, skipped: "no ffmpeg with libx264" }); return; }
  try {
    const script = join(RUN, "record-steps.json");
    writeFileSync(script, JSON.stringify([{ wait: 3000 }]));
    await sleep(500);
    const t0 = Date.now(), visibility = visibilityIn((await pageState(tab)).vis, t0, t0);
    const r = await commands.record(o, { tab, out: join(RUN, `record-${tab}.mp4`), script, size: "640x360", fps: 30, ffmpeg });
    const end = Date.now();
    await sleep(500);
    const visibleMs = visibleSpans((await pageState(tab)).vis, t0, end, mode.windowDrive);
    recordings.push({ tab, front, visibility, visibleMs, frames: r.frames, seconds: r.seconds, fps: +(r.frames / r.seconds).toFixed(1), maxFrameGapMs: r.maxFrameGapMs });
  } catch (e) { recordings.push({ tab, front, error: (e as Error).message.split("\n")[0] }); }
}

// p1: both tabs in the background, behind the launch's chrome://inspect tab.
await sleep(1000);
await measure("p1", "chrome://inspect", ["a", "b"]);
await drive("p1", "chrome://inspect", "a");
await drive("p1", "chrome://inspect", "b");
// p2: a in front; b hidden behind it.
await toFront("a");
await measure("p2", "a", ["a", "b"]);
await drive("p2", "a", "b");
await drive("p2", "a", "a");
// p3: the front tab switches to b; a is hidden.
await toFront("b");
await drive("p3", "b", "a");
// p4: and back to a; b is hidden again.
await toFront("a");
await drive("p4", "a", "b");
// p5: new tabs, opened in the background behind a, read and shot at once; each closed after its drive.
for (let i = 1; i <= mode.newTabs; i++) {
  const tab = `n${i}`;
  ids[tab] = (await commands.open(o, { url: `${BASE}/${tab}`, name: tab, tab: !mode.windowDrive })).tab.targetId;
  await drive("p5", "a", tab, ["eval", "text", "shot"]);
  await commands.close(o, { tab });
}
let ffmpeg: string | undefined;
try { ffmpeg = findFfmpeg(); } catch { ffmpeg = undefined; }
await record("a", "a", ffmpeg);
await record("a", "b", ffmpeg);

const run: Run = { before: mode.before, windowDrive: mode.windowDrive, tabs: listed, drives, timers, idles, recordings };
const failed = failures(run);
const ms = (d: Drive) => Object.fromEntries(d.steps.map((x) => [x.step, x.ms]));
const summary = {
  ok: failed.length === 0, chrome: product, launch: "agent-browser's own (launchAgentChrome, the proxy, approve: xdotool)", launchMs,
  flags: [...AGENT_ARGS, ...(mode.before ? TIMER_FLAGS : [])], hiddenDrive: mode.hiddenDrive, windowDrive: mode.windowDrive, tabs: listed,
  timers: timers.map((t) => ({ phase: t.phase, tab: t.tab, front: t.front, visibility: t.visibility, ...t.stats, windowMs: mode.hiddenMs, askedMs: TIMER_MS })),
  drives: drives.map((d) => ({ phase: d.phase, tab: d.tab, front: d.front, visibility: d.visibility, during: d.during, ...(mode.windowDrive ? { throughout: d.throughout } : {}), visibleMs: d.visibleMs, ok: d.steps.every((x) => x.ok), ms: ms(d) })),
  idles: idles.map((i) => `${i.phase} after ${i.driven}: ${i.tab} ${i.visibility}, ${i.frames} frames`),
  recordings, shots, failures: failed, run: RUN,
};
// summary.json also has each step's detail and each page's whole visibility log.
const visibilityLogs = { a: (await pageState("a")).vis, b: (await pageState("b")).vis };
writeFileSync(join(RUN, "summary.json"), JSON.stringify({ ...summary, drives, timers, idles, visibilityLogs }, null, 2) + "\n");
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
await browser.disconnect();
await commands.quit(o).catch(() => {});
server.close();
process.exit(failed.length ? 1 : 0);
