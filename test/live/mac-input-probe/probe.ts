// The Mac input probe (board ab-t30.32, part 1; step B of the input fit in the planner's report for board ab-t30.13). ONE
// run against agent mode's endpoint (the URL that `agentwatch browser endpoint` prints) answers three questions about the
// input stage's device values on the Mac:
//
//   Q1. Do fractional CDP x/y reach the page's pointer events (clientX/clientY, offsetX, the coalesced events), for a
//       move that ends at a fractional point (300.37, 200.61)? On the Mac the stage does not round: its path ends at the
//       client's point.
//   Q2. Which wheel values does the page see for a CDP mouseWheel of deltaY 13, and of 120 (deltaY, deltaMode,
//       wheelDeltaY, the count of wheel events)? On the Mac the stage passes the wheel as the client sends it.
//   Q3. How wide is the spread of the stage's sample gaps: for one stage path of about 600 px, the gaps between the
//       coalesced events' timeStamps (count, median, p10, p90, min, max)?
//
// One agent use: the probe opens ONE new background tab at about:blank in its own endpoint scope, writes the recorder
// into it with Runtime.evaluate (no navigation), sends synthetic CDP input only (Input.dispatchMouseEvent: the move of Q1,
// the path of Q3, then the two wheel calls of Q2, last because a wheel can scroll the page) through the relay as any
// client's input goes, reads the records and closes only that tab. It never lists, reads, focuses or closes another tab,
// takes no screenshot and moves no window. As Playwright does for each page, it sends Emulation.setFocusEmulationEnabled
// for its page (the relay answers it itself on Linux): with it, a background tab draws and takes input, and no window and
// no focus of the operating system changes.
//
// Stops: an endpoint that is not ready, a JavaScript dialog or a file chooser on the probe's page, the end of its tab or
// of the connection, a failed call, or the time limit of 60 s for the whole run. The probe then stops at once, closes its
// tab when it can, and prints {ok: false, stage, reason}.
//
// Output: one JSON document of numbers only on stdout (parts.ts: the probe's version and commit, the platform, the Chrome
// version, the page's size, and each question's values and summaries), and with --out FILE the same document in a new
// file (mode 0600) outside every git checkout.
//
//   node test/live/mac-input-probe/probe.ts --cdp-url URL [--out FILE] [--seed N]
//
// Exit: 0 with ok true, 1 with ok false, 2 for a refused argument or --out. This is a live file: `npm test` does not run
// it, and test/mac-input-probe.test.ts tests its pure parts (parts.ts).

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CDPConnection, CDPError } from "../../../src/cdp.ts";
import { CDP_URL_RE } from "../../../src/options.ts";
import {
  CALL_MAX_MS, CLOSE_RESERVE_MS, CONNECT_MAX_MS, FRAMES, PAGE_INFO, PROBE_VERSION, READ, RECORDER, SETTLE_MS, TIME_LIMIT_MS, USAGE, WHEEL_DELTAS,
  checkResult, chromeVersion, clean, failResult, inside, okResult, outPath, parseArgs, pathEnd, phase, q1Of, q1Point, q2Of, q3Of, readPage, readRecords,
  type Meta, type PageInfo, type Platform,
} from "./parts.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const t0 = Date.now();
const elapsed = () => Date.now() - t0;

/** The probe's commit: its checkout's HEAD, and whether a tracked file differs from it. Read only. */
function meta(seed: number | null): Meta {
  const git = (args: string[]) => {
    try { return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
  };
  const head = git(["rev-parse", "HEAD"]), status = git(["status", "--porcelain", "--untracked-files=no"]);
  return { version: PROBE_VERSION, commit: head && /^[0-9a-f]{40}$/.test(head) ? head : "unknown", dirty: status === null ? null : status.length > 0, seed };
}

let done = false;
/** Print the result (once), after its check of numbers only; with --out also into the new file. Then exit. */
function finish(result: Record<string, unknown>, out: string | null, code: number, m: Meta): never {
  if (done) process.exit(code);
  done = true;
  const bad = checkResult(result);
  const final = bad ? failResult({ meta: m, stage: "output", reason: "the result failed its check of numbers only", detail: `the value at ${bad}`.replace(/[^A-Za-z0-9 .<>\[\]]/g, ""), ms: elapsed() }) : result;
  const text = `${JSON.stringify(final)}\n`;
  process.stdout.write(text);
  if (out) {
    try { writeFileSync(out, text, { mode: 0o600, flag: "wx" }); }
    catch (e) { process.stderr.write(`mac-input-probe: --out: the file could not be written (${clean((e as Error).message)})\n`); code = code || 1; }
  }
  process.exit(bad ? 1 : code);
}

const args = parseArgs(process.argv.slice(2));
const m0 = meta("error" in args ? null : args.seed);
if ("error" in args) {
  process.stderr.write(`mac-input-probe: ${args.error}\n${USAGE}\n`);
  finish(failResult({ meta: m0, stage: "args", reason: args.error, ms: elapsed() }), null, 2, m0);
}
let out: string | null = null;
if (args.out !== null) {
  const o = outPath(args.out, process.cwd(), {
    realDir: (p) => { try { const r = realpathSync(p); return statSync(r).isDirectory() ? r : null; } catch { return null; } },
    exists: (p) => existsSync(p),
  });
  if ("error" in o) { process.stderr.write(`mac-input-probe: ${o.error}\n`); finish(failResult({ meta: m0, stage: "out", reason: o.error, ms: elapsed() }), null, 2, m0); }
  out = o.path;
}

/** A stop of the run: its stage, a fixed reason, and the code and cleaned text of the error when there is one. */
class Stop extends Error {
  readonly stage: string;
  readonly reason: string;
  readonly code?: number;
  readonly detail?: string;
  constructor(stage: string, reason: string, code?: number, detail?: string) {
    super(reason);
    this.stage = stage; this.reason = reason; this.code = code; this.detail = detail;
  }
}

const [, socket, scope] = CDP_URL_RE.exec(args.cdpUrl)!;
const redact = [args.cdpUrl, socket, scope];
/** The deadline of the work; the rest of the time limit is for the close of the tab. */
const deadline = t0 + TIME_LIMIT_MS - CLOSE_RESERVE_MS;
let stage = "connect";
let halted: Stop | null = null;
let dialog = false, closing = false;
let rejectHalt: (s: Stop) => void = () => {};
const haltP = new Promise<never>((_, reject) => { rejectHalt = reject; });
haltP.catch(() => {});
/** Stop the run (the first stop counts): every call and wait in flight ends with it. */
function halt(reason: string, code?: number, detail?: string): Stop {
  if (!halted) { halted = new Stop(stage, reason, code, detail); rejectHalt(halted); }
  return halted;
}
const timeLimit = `the time limit of ${TIME_LIMIT_MS / 1000} s for the whole run`;
const workTimer = setTimeout(() => halt(timeLimit), deadline - Date.now());
// The hard end: whatever runs, the probe prints its stop and exits at the time limit.
const hardTimer = setTimeout(() => {
  finish(failResult({ meta: m0, stage: halted?.stage ?? stage, reason: halted?.reason ?? timeLimit, tabClosed: null, ms: elapsed() }), out, 1, m0);
}, TIME_LIMIT_MS);
hardTimer.unref();

const errorCode = (e: unknown) => (e instanceof CDPError && typeof e.code === "number" ? e.code : undefined);
const errorText = (e: unknown) => clean(e instanceof Error ? e.message : String(e), redact);

let conn: CDPConnection | null = null;
let targetId: string | null = null;
let sessionId: string | null = null;

/** One CDP call of the run, within the deadline; a failure stops the run. */
async function call<T = any>(method: string, params: object = {}, session?: string): Promise<T> {
  if (halted) throw halted;
  const left = deadline - Date.now();
  if (left <= 0) throw halt(timeLimit);
  try {
    return await Promise.race([conn!.send<T>(method, params, session, Math.min(CALL_MAX_MS, left)), haltP]);
  } catch (e) {
    if (e instanceof Stop) throw e;
    throw halt(`${method} failed`, errorCode(e), errorText(e));
  }
}
/** A Runtime.evaluate on the probe's page, by value. */
async function evaluate<T = unknown>(expression: string, awaitPromise = false): Promise<T> {
  const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, sessionId!);
  if (r.exceptionDetails) throw halt("a script of the probe failed on its page");
  return r.result?.value as T;
}
const sleep = (ms: number) => Promise.race([new Promise<void>((r) => setTimeout(r, ms)), haltP]);
const move = (x: number, y: number) => call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0, modifiers: 0, pointerType: "mouse" }, sessionId!);
const wheel = (x: number, y: number, deltaY: number) => call("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY, modifiers: 0, pointerType: "mouse" }, sessionId!);

/** Close the probe's own tab (and nothing else), within the rest of the time limit. After a dialog, its answer first. */
async function closeTab(): Promise<boolean | null> {
  if (!conn || !targetId) return null;
  closing = true;
  const left = () => Math.max(500, t0 + TIME_LIMIT_MS - 500 - Date.now());
  if (dialog && sessionId) await conn.send("Page.handleJavaScriptDialog", { accept: false }, sessionId, Math.min(2000, left()), { through: true }).catch(() => {});
  return conn.send("Target.closeTarget", { targetId }, undefined, Math.min(5000, left())).then(() => true, () => false);
}

let platform: Platform | undefined;
let page: PageInfo | undefined;
try {
  // The endpoint: an agent Chrome that the stop by use stopped starts at this use.
  try {
    conn = await Promise.race([CDPConnection.connect(args.cdpUrl, Math.min(CONNECT_MAX_MS, deadline - Date.now())), haltP]);
  } catch (e) {
    if (e instanceof Stop) throw e;
    const http = /HTTP ([0-9]{3})/.exec(e instanceof Error ? e.message : "");
    throw halt("the endpoint is not ready", http ? Number(http[1]) : undefined, errorText(e));
  }
  void conn.closedPromise.then(() => { if (!closing) halt("the endpoint closed the connection"); });
  // The stops of the probe's own page: a dialog or a file chooser (a prompt), its crash, or the end of its session.
  conn.on("Page.javascriptDialogOpening", (_p, sid) => { if (sid === sessionId) { dialog = true; halt("a JavaScript dialog opened on the probe's page"); } });
  conn.on("Page.fileChooserOpened", (_p, sid) => { if (sid === sessionId) halt("a file chooser opened on the probe's page"); });
  conn.on("Inspector.targetCrashed", (_p, sid) => { if (sid === sessionId) halt("the probe's page crashed"); });
  conn.on("Inspector.detached", (_p, sid) => { if (sid === sessionId && !closing) halt("the probe's tab left the connection"); });
  conn.on("Target.detachedFromTarget", (p: { sessionId?: string }) => { if (p?.sessionId === sessionId && !closing) halt("the probe's tab left the connection"); });

  stage = "version";
  const v = await call("Browser.getVersion");
  platform = { os: process.platform, arch: process.arch, node: process.versions.node, chrome: chromeVersion(v?.product) };

  stage = "tab";
  targetId = (await call<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true })).targetId;
  stage = "attach";
  sessionId = (await call<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })).sessionId;
  stage = "page";
  await call("Page.enable", {}, sessionId);
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
  stage = "recorder";
  if ((await evaluate<boolean>(RECORDER)) !== true) throw halt("the probe's page held a recorder already");
  const frames = await evaluate<boolean>(FRAMES, true);
  const info = readPage(await evaluate(PAGE_INFO), frames);
  if (!info) throw halt("the page's size did not read");
  page = info;
  const view = { width: info.width, height: info.height };
  const p1 = q1Point(args.seed);
  const end = pathEnd(p1, view, args.seed);
  if (!inside(p1, view) || !end) throw halt("the page's viewport is too small for the probe's points");

  // Q1: one move that ends at the fractional point.
  stage = "q1";
  await evaluate(phase("q1"));
  await move(p1.x, p1.y);
  await sleep(SETTLE_MS);
  // Q3: one stage path of about 600 px, from Q1's point.
  stage = "q3";
  await evaluate(phase("q3"));
  await move(end.to.x, end.to.y);
  await sleep(SETTLE_MS);
  // Q2: the wheel calls at the page's last point.
  stage = "q2";
  for (let i = 0; i < WHEEL_DELTAS.length; i++) {
    await evaluate(phase(`q2-${i}`));
    await wheel(end.to.x, end.to.y, WHEEL_DELTAS[i]);
    await sleep(SETTLE_MS);
  }
  stage = "read";
  const records = readRecords(await evaluate(READ));
  if (!records) throw halt("the page's records were not in their shape");
  const parts = { q1: q1Of(records, p1), q2: q2Of(records, WHEEL_DELTAS), q3: q3Of(records, p1, end.to) };
  clearTimeout(workTimer);
  stage = "close";
  const tabClosed = await closeTab();
  await conn.close();
  const result = okResult({ meta: m0, platform, page: info, parts, ms: elapsed(), tabClosed: tabClosed === true });
  if (tabClosed !== true) finish({ ...result, ok: false, stage: "close", reason: "Target.closeTarget of the probe's tab failed" }, out, 1, m0);
  finish(result, out, 0, m0);
} catch (e) {
  clearTimeout(workTimer);
  const s = e instanceof Stop ? e : halt("the probe failed", undefined, errorText(e));
  const tabClosed = await closeTab().catch(() => false);
  await conn?.close().catch(() => {});
  finish(failResult({ meta: m0, platform, page, stage: s.stage, reason: s.reason, code: s.code, detail: s.detail, tabClosed, ms: elapsed() }), out, 1, m0);
}
