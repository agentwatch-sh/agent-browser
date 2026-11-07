// The live size-override check (Linux, ab-b84.18): what Chrome does with a capture that went out under a device
// metrics override (Emulation.setDeviceMetricsOverride, as `shot --size` sets it) and was still in flight when the
// override was cleared, or when the session ended. Chrome's PageHandler::ScreenshotCaptured restores the emulation
// and the view size that a capture found; review-41d saw a view left at the shot's size for good. Not part of
// `npm test`: the fake Chrome (test/fake-chrome.ts, FakePage.metrics and capture) models what this check measures,
// and test/hidden-tab.test.ts runs that model.
//
//   node test/live/background-tabs/override.ts --out-dir DIR [--chrome /usr/bin/chromium] [--display 96] [--trials 3]
//
// It measures Chrome itself, with no agent-browser command: it starts a private Xvfb (with -auth) and a Chromium on
// a new profile (DIR/run-XXXXXX/profile) with AGENT_ARGS, a fixed window and a debugging port on 127.0.0.1 that
// only this check uses, opens a still local page (127.0.0.1, no network) in a background tab, and drives it over
// CDP. It ends only its own Xvfb and Chromium, by their pids: it never quits, kills or connects to a Chrome that
// it did not start. Each run leaves its DIR/run-XXXXXX behind (the profile and results.json).
//
// In each trial a new background tab gets a session that sets an 800x600 override, waits 1 s, and sends one cheap
// capture: on a still page it waits (Tab.whileDrawn: how a capture ends). Then, by the variant:
//   none    no capture (the control): clear, end the session.
//   same    clear, then the same session sends later captures, which end the held one.
//   cross   clear, end the session, then a new session sends the later captures.
//   leave   no clear: end the session with the override set, then a new session sends the later captures.
// Each variant runs with no focus emulation (the page "hidden", as with --hidden-drive) and with it (the default
// mode: "visible"). The trial reads innerWidth x innerHeight after the later captures (afterEnd), in a fresh session
// (fresh), and with the tab in front (front); and when the held capture ended, against the clear.
//   exit 0  the trials ran; the summary (stdout, results.json) gives each trial and the counts of "stuck" trials:
//           afterEnd or fresh at 800x600. It is a measurement: no rule decides the exit.
//   exit 2  nothing ran: a usage error, not Linux, a display in use, or Xvfb or Chromium did not start.
//
// Measured 2026-11-06 on taylor (Chromium 156.0.8078.79, Debian 13; shot-tidy, ab-b84.18), 3 trials of each
// variant in each mode: none 0 of 6 stuck; same 6 of 6 stuck (hidden: the held capture ended 33 to 43 ms after the
// clear, with no later capture: the clear's own relayout ended it; visible: the later capture ended it); cross:
// hidden 3 of 3 stuck (the clear had ended it, in the first session), visible 0 of 3, and the held capture got no
// reply; leave 0 of 6: the new session's view had its own size at once, and the held capture got no reply. A tab
// in front showed its own size in every trial: a tab switch undoes a stuck view.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AGENT_ARGS } from "../../../src/agent.ts";
import { CDPConnection } from "../../../src/cdp.ts";
import { harnessGuard, reservedDisplay } from "../guard.ts";

const { values } = parseArgs({ options: { "out-dir": { type: "string" }, chrome: { type: "string" }, display: { type: "string" }, trials: { type: "string" } } });
const usage = "usage: node test/live/background-tabs/override.ts --out-dir DIR [--chrome /usr/bin/chromium] [--display 96] [--trials 3]";
/** A start that the check refuses: one line, exit 2. The exit handler ends the check's own children. */
function refuse(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
if (!values["out-dir"]) refuse(usage);
if (process.platform !== "linux") refuse(`the size-override check runs on Linux only, in a private Xvfb (this is ${process.platform})`);
const DISPLAY = Number(values.display ?? 96), TRIALS = Number(values.trials ?? 3), CHROME = values.chrome ?? "/usr/bin/chromium";
if (!Number.isInteger(DISPLAY) || DISPLAY < 1) refuse(`--display is a whole display number: ${values.display}`);
const reserved = reservedDisplay(DISPLAY, "--display");
if (reserved) refuse(reserved);
if (!Number.isInteger(TRIALS) || TRIALS < 1 || TRIALS > 20) refuse(`--trials is a whole number from 1 to 20: ${values.trials}`);
const OUT = resolve(values["out-dir"]!);
mkdirSync(OUT, { recursive: true });
const RUN = mkdtempSync(join(OUT, "run-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Only the check's own: its Xvfb and its Chromium.
const children: ChildProcess[] = [];
process.on("exit", () => { for (const c of children.reverse()) c.kill("SIGTERM"); });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(130));

// The X authority file (FamilyWild, MIT-MAGIC-COOKIE-1), as check.ts writes it.
const field = (b: Buffer) => { const n = Buffer.alloc(2); n.writeUInt16BE(b.length); return Buffer.concat([n, b]); };
const xauth = join(RUN, "Xauthority");
writeFileSync(xauth, Buffer.concat([Buffer.from([0xff, 0xff]), field(Buffer.alloc(0)), field(Buffer.from(String(DISPLAY))),
  field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(randomBytes(16))]), { mode: 0o600 });
// One live harness at a time, and nothing of this check after its end, also after a kill -9 (test/live/README.md).
const harness = await harnessGuard("background-tabs override");
const socket = `/tmp/.X11-unix/X${DISPLAY}`;
if (existsSync(socket)) refuse(`display :${DISPLAY} is in use; pass --display N`);
const xvfb = spawn("Xvfb", [`:${DISPLAY}`, "-auth", xauth, "-nolisten", "tcp", "-screen", "0", "1280x800x24"], { stdio: "ignore" });
children.push(xvfb);
harness.track(xvfb.pid, "Xvfb");
for (let i = 0; i < 50 && !existsSync(socket) && xvfb.exitCode === null; i++) await sleep(100);
await sleep(200);
if (!existsSync(socket) || xvfb.exitCode !== null) refuse(`Xvfb did not start on :${DISPLAY}; pass another --display N`);

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><title>still</title><body style="margin:0;background:#4a7"><p>a still page</p>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const PAGE = `http://127.0.0.1:${(server.address() as { port: number }).port}/still`;

const profile = join(RUN, "profile");
const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: `:${DISPLAY}`, XAUTHORITY: xauth };
delete env.WAYLAND_DISPLAY;
delete env.XDG_SESSION_TYPE;
const chrome = spawn(CHROME, [...AGENT_ARGS, `--user-data-dir=${profile}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
  "--ozone-platform=x11", "--password-store=basic", "--window-position=0,0", "--window-size=1200,760", "about:blank"], { env, stdio: "ignore" });
children.push(chrome);
harness.track(chrome.pid, "Chromium");
const portFile = join(profile, "DevToolsActivePort");
for (let i = 0; i < 100 && !existsSync(portFile) && chrome.exitCode === null; i++) await sleep(100);
if (!existsSync(portFile)) refuse(`Chromium (${CHROME}) did not start`);
const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
const conn = await CDPConnection.connect(`ws://127.0.0.1:${port}${path}`, 10_000);
const product = (await conn.send("Browser.getVersion")).product as string;
const front = ((await conn.send("Target.getTargets")).targetInfos as { type: string; targetId: string }[]).find((t) => t.type === "page")!.targetId;

const HOLD = { format: "jpeg", quality: 1, optimizeForSpeed: true };
async function late(p: Promise<unknown>, ms: number): Promise<boolean> {
  let t: NodeJS.Timeout | undefined;
  try { return await Promise.race([p.then(() => false, () => false), new Promise<boolean>((r) => { t = setTimeout(() => r(true), ms); })]); } finally { clearTimeout(t); }
}

type Variant = "none" | "same" | "cross" | "leave";
async function trial(variant: Variant, focus: boolean) {
  const { targetId } = await conn.send("Target.createTarget", { url: PAGE, background: true });
  await sleep(1000);
  const attach = async () => {
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
    await conn.send("Page.enable", {}, sessionId);
    if (focus) await conn.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
    return sessionId as string;
  };
  const size = (sid: string): Promise<string> => conn.send("Runtime.evaluate", { expression: "`${innerWidth}x${innerHeight}`", returnByValue: true }, sid, 10_000)
    .then((r: { result: { value: string } }) => r.result.value, (e: Error) => `error ${e.message}`);
  const t0 = Date.now(), at: Record<string, number> = {}, mark = (k: string) => { at[k] = Date.now() - t0; };
  const s1 = await attach();
  const before = await size(s1);
  await conn.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }, s1);
  await sleep(1000);
  let held = "none";
  if (variant !== "none") {
    held = "pending";
    void conn.send("Page.captureScreenshot", HOLD, s1, 20_000).then(() => { held = "ended"; mark("heldEnded"); }, (e: Error) => { held = `failed (${e.message})`; });
  }
  await sleep(1500);
  const heldBeforeClear = held;
  mark("clear");
  if (variant !== "leave") await conn.send("Emulation.clearDeviceMetricsOverride", {}, s1);
  await sleep(300);
  let s2 = s1;
  if (variant !== "same") { mark("sessionEnd"); await conn.send("Target.detachFromTarget", { sessionId: s1 }); s2 = await attach(); }
  const later: string[] = [];
  for (let i = 0; i < 4; i++) {
    const p = conn.send("Page.captureScreenshot", HOLD, s2, 5000).then(() => "ended", (e: Error) => `failed (${e.message})`);
    if (!(await late(p, 400))) { later.push(await p); break; }
    later.push("late");
  }
  await sleep(1000);
  const afterEnd = await size(s2);
  await conn.send("Target.detachFromTarget", { sessionId: s2 }).catch(() => {});
  await sleep(300);
  const s3 = await attach();
  const fresh = await size(s3);
  await conn.send("Target.activateTarget", { targetId });
  await sleep(700);
  const inFront = await size(s3);
  await conn.send("Target.activateTarget", { targetId: front });
  await sleep(300);
  await conn.send("Target.detachFromTarget", { sessionId: s3 }).catch(() => {});
  await conn.send("Target.closeTarget", { targetId });
  return { variant, mode: focus ? "visible" : "hidden", before, heldBeforeClear, held, later, afterEnd, fresh, front: inFront, at,
    stuck: afterEnd === "800x600" || fresh === "800x600" };
}

const trials: Awaited<ReturnType<typeof trial>>[] = [];
for (let i = 0; i < TRIALS; i++)
  for (const focus of [false, true])
    for (const variant of ["none", "same", "cross", "leave"] as const) {
      const r = await trial(variant, focus);
      trials.push(r);
      process.stderr.write(`${JSON.stringify(r)}\n`);
    }
const counts: Record<string, string> = {};
for (const v of ["none", "same", "cross", "leave"]) for (const m of ["hidden", "visible"]) {
  const of = trials.filter((t) => t.variant === v && t.mode === m && (v === "none" || t.heldBeforeClear === "pending"));
  counts[`${v} ${m}`] = `${of.filter((t) => t.stuck).length} of ${of.length} stuck`;
}
const summary = { product, run: RUN, counts, trials };
writeFileSync(join(RUN, "results.json"), JSON.stringify(summary, null, 2));
process.stdout.write(`${JSON.stringify({ product, run: RUN, counts }, null, 2)}\n`);
await conn.close();
server.close();
process.exit(0);
