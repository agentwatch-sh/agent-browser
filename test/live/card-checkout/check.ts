// The live check of the card payment on the Linux server (board ab-sta.8, the plan's Task 6; contract C11, the card
// payment; C12, the card payments; the secure card checkout design, sections 7, 8 and 11). It runs the real service
// (`agent-browser service --test --card-pay`, with its pinned agent package: the receiver 0.3.15) in temp folders only,
// on display :171, with /usr/bin/chromium (the Chromium tree in the service's Chrome copy, as the sign-in act's check
// does), under the harness guard, and it is the service's daemon on the control door. NEVER a real purchase: the payment
// goes to the local test merchant (test/fixtures/pay-merchant/, *.localhost hosts of a server of this process) with the
// payment providers' published test card numbers only (test/pay-test-cards.ts), and every other value of the card is
// made up and named so. `--test-provider-origin` gives the run the test merchant's provider origin (pay.localhost).
//
//   1. the run: the service with --card-pay, the test merchant, Chrome with the pinned receiver, the lists, the agent's
//      CDP client of the scope live-1 (its tab is the agent's tab) and a real MCP client of live-1 (a local admission);
//   2. the store: the set-up with the pane's seal of a test passphrase, two cards sealed through card_seal from the pane's
//      seals of test values (the published success and decline test numbers), the daemon's snapshot with both;
//   3. the base case: the agent's tab shows the shop's checkout, the agent calls browser_pay; the check reads pay_request
//      (the order lines, the total, the currency, no card value, no URL path or query), seals the approval to the pane key
//      (the purpose browser-pay and C12's binding) and sends pay_approve with kind operator; the act pays; the answer, one
//      pay_result, browser_pay_status and the keep (pay-results.json, mode 0600) hold the result;
//   4. the test merchant's variants, each a step of its own: the decline (the decline test number), the bank step, the fee
//      at the press, the last four digits on the confirmation (on a line of their own, and in the order number), a total
//      change before the press, card fields on the shop's own page and in a frame of another origin, two totals, the
//      save-card box that cannot be unticked, the checkout in sessionStorage;
//   5. the attacks of the design's section 11 that a local check can make: the agent's cart change during the wait (rule
//      90), its reads of every tab and frame it can reach during the act (Runtime.evaluate, DOMSnapshot, a screenshot, the
//      accessibility tree, the targets, the windows, the CLI), its own service worker and BroadcastChannel on the shop's
//      origin; an approval of kind token (and daemon); a replayed approval; approvals of another request and another
//      order hash; a cancelled call, then a new request whose `earlier` holds its result;
//   6. what Chrome must confirm (Task 5b): the provider frame out of process, the click and the keys in it; Fetch in the
//      frame's own session (the guard fails its request); the act's rules after the press (the bank's frame); a reload of
//      the provider frame during the fill; windows.get with populate; the merchant's domain of a *.localhost host;
//   7. the secret scan: no MCP answer, event, control line, log line, CLI output, agent read, keep entry or profile file
//      holds a test value in any of its forms; its twin finds a planted one;
//   8. stop: Chrome, Xvfb and the test merchant end; the temp folders go.
//
// Each numbered step from 3 on is a step of its own: a failed check stops that step only, the run goes on, and it exits 1.
// It signals only the pids that its run started, and it never touches another Chrome, Xvfb, profile or folder.
//   flock <heavy.lock> timeout -k 60 1800 node test/live/card-checkout/check.ts --display 171 [--chrome-extension <checkout>] [--only <step>,<step>]

import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CDPConnection } from "../../../src/cdp.ts";
import { AGENT_CRX, AGENT_CRX_SHA256, AGENT_VERSION, CHROME_EXTENSION_COMMIT } from "../../../src/service/package/pins.ts";
import { GOOGLE_SOURCE, GoogleChromeTools } from "../../../src/service/unit/google-chrome.ts";
import { makeChromeRepo } from "../../chrome-fixture.ts";
import { startMerchant, type MerchantHit } from "../../fixtures/pay-merchant/server.ts";
import { TEST_CARDS } from "../../pay-test-cards.ts";
import { paneSeal } from "../../sign-in-seal.ts";
import { harnessGuard, reservedDisplay } from "../guard.ts";
import { AGENT_SW_PATH, agentRoute, approvalSeal, isoNow, orderHashOf, Scan, xWindows, type XWindow } from "./agent.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BIN = join(ROOT, "bin", "agent-browser.js");
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const display = Number(arg("--display") ?? "171");
// This check runs on :171 only (the brief of board ab-sta.8); the guard's reserved list holds too.
const refused = reservedDisplay(display, "--display") ?? (display !== 171 ? `--display names :${display}: this check runs on :171 only` : null);
if (!Number.isSafeInteger(display) || refused) { process.stderr.write(`card-checkout: ${refused ?? "--display must be a number"}\n`); process.exit(2); }
if (existsSync(`/tmp/.X11-unix/X${display}`) || existsSync(`/tmp/.X${display}-lock`)) { process.stderr.write(`card-checkout: :${display} is in use; this check runs on a free display only\n`); process.exit(2); }
const CE = arg("--chrome-extension");
const ONLY = arg("--only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const CHROMIUM_TREE = "/usr/lib/chromium";
if (!existsSync("/usr/bin/chromium") || !existsSync(join(CHROMIUM_TREE, "chromium"))) { process.stderr.write("card-checkout: /usr/bin/chromium (its tree /usr/lib/chromium) is missing\n"); process.exit(2); }

// The test values: the published test numbers, made-up other values named as test values (a provider's test mode takes
// any future expiry, any security code and any postal code). The security code has four digits so that the scan can tell
// it from the text around it (C12: 3 or 4 digits).
const CARDS = { ok: { name: "test-visa", number: TEST_CARDS.visa }, decline: { name: "test-decline", number: TEST_CARDS.visaDeclined } } as const;
const VALUES = { holder: "Test Holder Livecheck", expiry: "08/39", csc: "0719", postal: "LC4Z9" } as const;
const PASSPHRASE = "test passphrase of the card live check 2026";
const DESCRIPTION = "Two adult and one child test tickets (the card payment's live check)";
const scan = new Scan({ numbers: { "success test": CARDS.ok.number, "decline test": CARDS.decline.number }, ...VALUES });
const TOKEN_L = `abt1_${randomBytes(32).toString("base64url")}`;
const fp = (t: string) => createHash("sha256").update(t, "ascii").digest("hex");
const sdk = createRequire(import.meta.url)(join(ROOT, "node_modules", "playwright-core", "lib", "utilsBundle.js"));

const t0 = Date.now();
const log = (s: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${scan.redact(s)}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { step: string; ok: boolean; note: string }[] = [];
const check = (what: string, ok: boolean, note = "") => { results.push({ step: what, ok, note }); log(`${ok ? "PASS" : "FAIL"} ${what}${note ? `: ${note}` : ""}`); if (!ok) throw new Error(`${what} failed${note ? `: ${note}` : ""}`); };
const verify = (what: string, ok: boolean, note = "") => { results.push({ step: what, ok, note }); log(`${ok ? "PASS" : "FAIL"} ${what}${note ? `: ${note}` : ""}`); return ok; };
const steps: { name: string; ok: boolean | null; note: string }[] = [];
/** One step of the brief (3 to 7): a failed check stops this step only; the run goes on, and it exits 1. */
const step = async (name: string, f: () => Promise<void>) => {
  if (ONLY && !ONLY.some((o) => name.startsWith(o))) { steps.push({ name, ok: null, note: "not run (--only)" }); return; }
  log(`STEP ${name}: begins`);
  const n0 = results.length;
  let stop = "";
  try { await f(); } catch (e) { stop = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300); }
  const mine = results.slice(n0), bad = mine.filter((r) => !r.ok).length;
  const ok = !stop && bad === 0;
  const note = `${mine.length - bad} of ${mine.length} checks pass${stop ? `; stopped: ${stop}` : ""}`;
  steps.push({ name, ok, note });
  log(`STEP ${name}: ${ok ? "PASS" : "FAIL"} (${note})`);
};
const notes: string[] = [];
const note = (s: string) => { notes.push(s); log(`NOTE ${s}`); };
const until = async (what: string, f: () => boolean, ms: number) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error(`${what}: not in ${ms / 1000} s`); await sleep(100); } };
function proc(pid: number): { start: number; ppid: number } | null {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, "latin1");
    const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
    if (["Z", "X"].includes(f[0])) return null;
    return { start: Number(f[19]), ppid: Number(f[1]) };
  } catch { return null; }
}

const guard = await harnessGuard("card-checkout");
const dir = mkdtempSync(join(tmpdir(), "ab-card-live-"));
const run = join(dir, "run"), state = join(dir, "state"), tools = join(dir, "tools"), lists = join(dir, "lists"), cliState = join(dir, "cli");
for (const d of [run, lists, cliState]) mkdirSync(d, { mode: 0o700 });
const started = new Map<number, number>();
let service: ChildProcess | null = null;
let serviceErr = "";
let repo: ReturnType<typeof makeChromeRepo> | null = null;
/** Every text that the scan reads: control lines, MCP answers, CLI outputs, the agent's reads. */
const seen: string[] = [];
const track = (pid: number | null | undefined, name: string) => { if (!pid) return; const p = proc(pid); if (p) { started.set(pid, p.start); guard.track(pid, name); } };

// ---- the test merchant (a server of this process) and what reached it
const hits: MerchantHit[] = [];
const merchant = await startMerchant({ seen: (h) => hits.push(h), route: agentRoute });
const PORT = merchant.port;
const SHOP = `http://shop.localhost:${PORT}`, PAYO = `http://pay.localhost:${PORT}`;
const BLOCK = "Your tabs could not reach shop.localhost from the copy of the checkout to the end of the payment.";
const page = (variant: string) => `${SHOP}/checkout${variant === "base" ? "" : `-${variant}`}.html`;

// ---- the control door: the check is the service's daemon
type Door = { s: Socket; lines: any[]; after: (n0: number, want: (l: any) => boolean, ms?: number) => Promise<any>; send: (o: object) => void };
function door(): Promise<Door> {
  return new Promise((resolve, reject) => {
    const s = connect(join(run, "control.sock"));
    const lines: any[] = [];
    let buf = "";
    const waiters: { n0: number; want: (l: any) => boolean; done: (l: any) => void }[] = [];
    s.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 1);
        seen.push(raw);
        const l = JSON.parse(raw);
        lines.push(l);
        for (const w of [...waiters]) if (w.want(l)) { waiters.splice(waiters.indexOf(w), 1); w.done(l); }
      }
    });
    s.on("error", reject);
    s.once("connect", () => resolve({
      s, lines, send: (o) => s.write(JSON.stringify(o) + "\n"),
      after: (n0, want, ms = 30_000) => {
        const hit = lines.slice(n0).find(want);
        if (hit) return Promise.resolve(hit);
        return new Promise((done, fail) => {
          const w = { n0, want, done: (l: any) => { clearTimeout(t); done(l); } };
          waiters.push(w);
          const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); fail(new Error(`no such line in ${ms} ms`)); }, ms);
        });
      },
    }));
  });
}
let n = 0;
let d!: Door;
const req = async (op: string, by: object, fields: object = {}, ms = 30_000) => { const id = `q${++n}`; const n0 = d.lines.length; d.send({ t: "req", id, op, by, ...fields }); return d.after(n0, (l) => l.t === "res" && l.id === id, ms); };
const TOKEN = { kind: "token", user: "live", via: "cli" }, DAEMON = { kind: "daemon", user: "live", via: "daemon" }, OPERATOR = { kind: "operator", user: "live", via: "web" };
const me = proc(process.pid)!;
const LIVE_1 = { scope: "live-1", repo: "local/test", roots: [{ pid: process.pid, start: me.start }], cgroup: null, lifetime_id: "lt-card-live", mcp_token: fp(TOKEN_L) };
const BOX = { hosts: ["box.localhost"], cookie_names: [] };

async function startService(): Promise<void> {
  service = spawn(process.execPath, ["--disable-sigusr1", BIN, "service", "--test", "--test-display", String(display), "--agent-door", join(run, "cdp.sock"), "--control-door", join(run, "control.sock"),
    "--daemon-command", join(dir, "daemon-command.json"), "--lists-folder", lists, "--state-folder", state, "--tools-dir", tools, "--test-chrome-source", join(dir, "source.json"),
    "--test-mcp-port", "0", "--card-pay", "--test-provider-origin", PAYO], { stdio: ["ignore", "ignore", "pipe"] });
  guard.track(service.pid, "service");
  started.set(service.pid!, proc(service.pid!)?.start ?? -1);
  service.stderr!.on("data", (x) => { serviceErr += x; });
  for (let i = 0; i < 300 && !serviceErr.includes("service: ready"); i++) { if (service.exitCode !== null) break; await sleep(50); }
  if (!serviceErr.includes("service: ready")) throw new Error(`the service did not start: ${serviceErr.slice(-800)}`);
  d = await door();
  const hello = await d.after(0, (l) => l.t === "hello");
  check("the service's hello lists the stored sign-ins and the card payment (sign_ins, card_pay)", hello.side === "service" && hello.features.includes("sign_ins") && hello.features.includes("card_pay"), JSON.stringify(hello.features));
  d.send({ t: "hello", v: 1, side: "daemon", version: "live", features: [] });
  const cfg = await req("config", { kind: "daemon", user: "live", via: "config" }, { enabled: true, control: true, chrome_bin: null, chrome_args: [], display_size: "1280x900" });
  if (!cfg.ok) throw new Error(`config: ${JSON.stringify(cfg)}`);
  const ss = await req("set_sessions", DAEMON, { sessions: [LIVE_1], remote: [], box: BOX });
  if (!ss.ok) throw new Error(`set_sessions: ${JSON.stringify(ss)}`);
}
async function stopService(): Promise<void> {
  const s = service;
  if (!s || s.exitCode !== null || s.signalCode !== null) return;
  const exited = new Promise<void>((r) => s.once("exit", () => r()));
  s.kill("SIGTERM");
  await Promise.race([exited, sleep(15_000).then(() => { s.kill("SIGKILL"); })]);
}
/** The CLI as a child (the agent's own CLI reads), with no block of this process's event loop. */
const cli = (args: string[], url: string) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
  execFile(process.execPath, [BIN, ...args, "--state-dir", cliState, "--cdp-url", url], { encoding: "utf8", timeout: 120_000 }, (e, stdout, stderr) => {
    seen.push(stdout, stderr);
    resolve({ status: e ? (typeof (e as any).code === "number" ? (e as any).code : null) : 0, stdout, stderr });
  });
});

// ---- the X windows of the run's display: the act window must be outside the screen at each look
const SCREEN_W = 1280;
const xauth = () => join(state, "xauth");
/** The agent's own X windows (each look with no act): their ids. */
const agentX = new Set<string>();
const xLooks: { at: number; w: XWindow }[] = [];
let xWatch = false;
const PAGE_NAME = /Test Shop|aw-act-/;
const markAgentWindows = () => { for (const w of xWindows(display, xauth())) if (PAGE_NAME.test(w.name) && w.x < SCREEN_W) agentX.add(w.id); };
const xLoop = async () => { while (xWatch) { for (const w of xWindows(display, xauth())) if (PAGE_NAME.test(w.name) || /Test Pay|Test Bank|Not a provider/.test(w.name)) xLooks.push({ at: Date.now(), w }); await sleep(400); } };

let code = 0;
process.on("unhandledRejection", (e) => { code = 1; results.push({ step: "an unhandled rejection", ok: false, note: String((e as Error)?.message ?? e).slice(0, 200) }); log(`FAIL: an unhandled rejection: ${String((e as Error)?.message ?? e).slice(0, 200)}`); });
let c!: CDPConnection;
let mcp: any = null;
let paneKey = "";
let url = "";
const A = { targetId: "", sessionId: "" };
/** Step 3's evidence for step 6: the charge of the base case carried the typed values. */
let baseCharge: boolean | null = null;
const xLoopDone: Promise<void>[] = [];
try {
  // ---------------------------------------------------------------- 1. the run
  const crx = readFileSync(AGENT_CRX);
  check(`the service's agent package is the pinned CRX of receiver ${AGENT_VERSION} (SHA-256 ${AGENT_CRX_SHA256.slice(0, 8)}...)`, createHash("sha256").update(crx).digest("hex") === AGENT_CRX_SHA256 && AGENT_VERSION === "0.3.15", `${crx.length} bytes`);
  if (CE) {
    const fromGit = execFileSync("git", ["-C", CE, "show", `${CHROME_EXTENSION_COMMIT.slice(0, 7)}:release/agent.crx`], { maxBuffer: 1 << 24 });
    check(`git show ${CHROME_EXTENSION_COMMIT.slice(0, 7)}:release/agent.crx gives the same bytes as the service's copy`, fromGit.equals(crx));
  }
  const argv = readFileSync("/proc/self/cmdline", "utf8").split("\0").filter((x, i, a) => i < a.length - 1 || x !== "");
  writeFileSync(join(dir, "daemon-command.json"), JSON.stringify({ v: 1, interpreter: realpathSync(process.execPath), args: argv.slice(1) }), { mode: 0o600 });
  repo = makeChromeRepo({ version: "158.0.7100.1-1", chrome: `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Google Chrome 158.0.7100.1 "; exit 0; fi\nexec "$(dirname "$0")/chromium" "$@"\n` });
  writeFileSync(join(dir, "source.json"), JSON.stringify({ repo: repo.repo, key: repo.keyFile, fingerprints: [repo.fingerprint] }));
  chmodSync(dir, 0o700);
  const installer = new GoogleChromeTools({ tools, source: { ...GOOGLE_SOURCE, repo: repo.repo, keyFile: repo.keyFile, fingerprints: [repo.fingerprint] }, log: (l) => log(`installer: ${l}`) });
  const copy = await installer.ensure();
  for (const e of readdirSync(CHROMIUM_TREE)) cpSync(join(CHROMIUM_TREE, e), join(copy.binary, "..", e), { recursive: true, force: true });
  writeFileSync(join(lists, "local.test.json"), JSON.stringify({ allow: ["shop.localhost", "pay.localhost", "bank.localhost", "other.localhost"], repo: "local/test" }), { mode: 0o600 });
  log(`the test merchant: ${SHOP} and ${PAYO} (127.0.0.1:${PORT})`);
  await startService();

  // ---------------------------------------------------------------- 2. the store and the two cards
  check("the snapshot of an empty store", (await req("sign_ins", DAEMON, { key: null, records: [] })).ok === true);
  paneKey = (await req("status", DAEMON)).data.sign_ins.pane_key as string;
  const setup = await req("sign_ins_setup", OPERATOR, { sealed: paneSeal(paneKey, { passphrase: PASSPHRASE }, { op: "sign_ins_setup" }, { at: isoNow() }) }, 60_000);
  check("sign_ins_setup with the pane's seal of a test passphrase opens the store", setup.ok === true && !!setup.data.key, setup.ok === true ? "" : JSON.stringify(setup).slice(0, 200));
  check("the snapshot with the key", (await req("sign_ins", DAEMON, { key: setup.data.key, records: [] })).ok === true);
  const files: Record<string, unknown>[] = [];
  for (const k of ["ok", "decline"] as const) {
    const form = { name: CARDS[k].name, holder: VALUES.holder, number: CARDS[k].number, expiry: VALUES.expiry, csc: VALUES.csc, postal: VALUES.postal };
    const a = await req("card_seal", OPERATOR, { sealed: paneSeal(paneKey, form, { op: "card_seal" }, { at: isoNow() }) });
    check(`card_seal seals the card ${CARDS[k].name} (a published test number, made-up test values): a record of kind card with no digit of the number in a plain field`,
      a.ok === true && a.data.record.kind === "card" && a.data.record.name === CARDS[k].name && a.data.record.brand === "visa" && !/\d{4}/.test(JSON.stringify(a.data.record).replace(/"(?:id|gen|v)":[^,}]*/g, "")), JSON.stringify(a.data?.record ?? a).slice(0, 200));
    files.push({ ...a.data.record, state: "usable", added: null, changed: null, sealed: a.data.sealed });
  }
  check("the daemon's snapshot with the two cards", (await req("sign_ins", DAEMON, { key: setup.data.key, records: files })).ok === true);
  check("status: the store is open", (await req("status", DAEMON)).data.sign_ins.state === "open");

  // Chrome with the pinned receiver; the lists; the agent's CDP client and its tab; the MCP client.
  const a1 = await req("start", TOKEN, {}, 120_000);
  check("start answers ok", a1.ok === true, JSON.stringify(a1));
  const ready = await d.after(0, (l) => l.t === "ev" && l.ev === "ready", 120_000);
  track(ready.chrome_pid, "chrome");
  track(JSON.parse(readFileSync(join(state, "unit.json"), "utf8")).xvfb_pid, "xvfb");
  check(`the ready event carries the pinned receiver ${AGENT_VERSION}`, ready.extension_version === AGENT_VERSION, JSON.stringify(ready));
  await until("the receiver confirms the lists", () => /lists: the receiver took the lists of 1 scopes/.test(serviceErr), 60_000);
  // The receiver's features act and pay show in the act itself: the act window opens only with both (act.ts, openWindow).
  check(`the receiver ${AGENT_VERSION} said hello on the link`, serviceErr.includes(`link: the receiver ${AGENT_VERSION} said hello (bridge, scopes)`), serviceErr.match(/link: the receiver.*/)?.[0] ?? "");
  url = (await req("endpoint", DAEMON, { scope: "live-1" })).data.url as string;
  let cdp: CDPConnection | null = null;
  for (let i = 0; i < 50 && !cdp; i++) { try { cdp = await CDPConnection.connect(url, 5000); } catch (e) { if (i === 49) throw e; await sleep(200); } }
  c = cdp!;
  const created = await c.send("Target.createTarget", { url: `${SHOP}/index.html` });
  A.targetId = created.targetId;
  A.sessionId = (await c.send("Target.attachToTarget", { targetId: A.targetId, flatten: true })).sessionId;
  for (const m of ["Page.enable", "Runtime.enable"]) await c.send(m, {}, A.sessionId);
  const mcpAddress = (await req("status", DAEMON)).data.mcp.address as string;
  check("status: the MCP path is ready on 127.0.0.1", typeof mcpAddress === "string" && mcpAddress.startsWith("127.0.0.1:"), String(mcpAddress));
  mcp = new sdk.Client({ name: "card-live", version: "0" });
  await mcp.connect(new sdk.StreamableHTTPClientTransport(new URL(`http://${mcpAddress}/mcp/live-1`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN_L}` } } }));
  const toolNames = ((await mcp.listTools()).tools as { name: string }[]).map((t) => t.name);
  check("the local MCP client (scope live-1) lists browser_pay and browser_pay_status", toolNames.includes("browser_pay") && toolNames.includes("browser_pay_status"), `${toolNames.length} tools`);
  xWatch = true;
  xLoopDone.push(xLoop());

  // ---------------------------------------------------------------- the agent's tab, the payment, its checks
  const evalA = async (expression: string, sid = A.sessionId): Promise<any> => {
    const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid, 20_000);
    return r?.result?.value;
  };
  /** The agent's tab shows `to` (loaded), and the agent's X windows are known again (no act runs). */
  const agentGoto = async (to: string) => {
    await c.send("Page.navigate", { url: to }, A.sessionId);
    for (let i = 0; i < 150; i++) {
      const s = await evalA(`location.href + " " + document.readyState`).catch(() => "");
      if (s === `${to} complete`) break;
      await sleep(100);
    }
    await sleep(1200);
    markAgentWindows();
  };
  type Answer = { text: string; isError: boolean; items: number } | { error: string };
  const mcpCall = async (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Answer> => {
    try {
      const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 900_000, ...(signal ? { signal } : {}) });
      seen.push(JSON.stringify(r));
      return { text: (r.content as { type: string; text?: string }[]).filter((x) => x.type === "text").map((x) => x.text).join("\n"), isError: r.isError === true, items: (r.content as unknown[]).length };
    } catch (e) { const m = String((e as Error)?.message ?? e); seen.push(m); return { error: m }; }
  };
  const approve = (ev: any, answer = "approve", o: { by?: object; fields?: Record<string, string>; request?: string } = {}) =>
    req("pay_approve", o.by ?? OPERATOR, { request: o.request ?? ev.id, sealed: approvalSeal(paneKey, ev, answer, o.fields) });
  type Paid = { answer: Answer; req: any | null; result: any[]; pays: any[]; n0: number; h0: number; tReq: number; tEnd: number; approval: any | null };
  /**
   * One payment of the agent: its tab shows the variant's checkout, it calls browser_pay over the MCP client; at the
   * pay_request, `onRequest` runs (the attacks of the wait), then the operator's approval (or refusal, or none).
   */
  const pay = async (o: { variant?: string; card?: string; goto?: boolean; answer?: "approve" | "refuse" | "none"; onRequest?: (ev: any) => Promise<void>; signal?: AbortSignal }): Promise<Paid> => {
    if (o.goto !== false) await agentGoto(page(o.variant ?? "base"));
    const n0 = d.lines.length, h0 = hits.length, start = Date.now();
    const call = mcpCall("browser_pay", { card: o.card ?? CARDS.ok.name, origin: SHOP, amount: "51.00", currency: "USD", description: DESCRIPTION }, o.signal);
    let request: any = null, approval: any = null, tReq = 0;
    const stopWait = new AbortController();
    const got = await Promise.race([call.then(() => "answer" as const), new Promise<"request">((resolve) => {
      const tick = () => { const l = d.lines.slice(n0).find((x) => x.t === "ev" && x.ev === "pay_request"); if (l) { request = l; tReq = Date.now(); resolve("request"); } else if (!stopWait.signal.aborted) setTimeout(tick, 50); };
      tick();
    })]);
    stopWait.abort();
    if (got === "request") {
      if (o.onRequest) await o.onRequest(request);
      const answer = o.answer ?? "approve";
      if (answer !== "none") approval = await approve(request, answer);
    }
    const ans = await call;
    const tEnd = Date.now();
    if (request) await d.after(n0, (l) => l.t === "ev" && l.ev === "pay_result" && l.id === request.id, 10_000).catch(() => null);
    const result = d.lines.slice(n0).filter((l) => l.t === "ev" && l.ev === "pay_result");
    const pays = d.lines.slice(n0).filter((l) => l.t === "ev" && l.ev === "pay");
    log(`payment ${o.variant ?? "base"} (${o.card ?? CARDS.ok.name}): ${"error" in ans ? `error ${ans.error}` : JSON.stringify(ans.text)} in ${((tEnd - start) / 1000).toFixed(1)} s${request ? `, request ${request.id}` : ", no pay_request"}`);
    return { answer: ans, req: request, result, pays, n0, h0, tReq, tEnd, approval };
  };
  /** C12's pay_request: its keys, the order of the test merchant's checkout, no card value, no URL path or query. */
  const checkRequest = (ev: any, card: string) => {
    const keys = Object.keys(ev).sort().join(",");
    verify("pay_request has C12's keys (no provider_origin: the card fields are in a frame of the merchant's page)", keys === "card,description,earlier,expires,ev,id,order,origin,scope,t", keys);
    verify("pay_request: its id (16 hex), the scope, the origin, the card's name, the agent's description", /^[0-9a-f]{16}$/.test(ev.id) && ev.scope === "live-1" && ev.origin === SHOP && ev.card === card && ev.description === DESCRIPTION);
    const lines: string[] = Array.isArray(ev.order?.lines) ? ev.order.lines : [];
    const want = ["Adult ticket × 2: $40.00", "Child ticket × 1: $8.00", "Subtotal: $48.00", "Tax (6.25%): $3.00"];
    verify("pay_request's order: the order lines of the page (the tickets, the subtotal, the tax), the total 51.00 and the currency USD of the request, the delivery name and email",
      want.every((l) => lines.includes(l)) && ev.order.total === "51.00" && ev.order.currency === "USD" && ev.order.delivery?.name === "Ann Example" && ev.order.delivery?.email === "ann@example.com" && Object.keys(ev.order).sort().join(",") === "currency,delivery,lines,total",
      JSON.stringify(ev.order));
    verify("pay_request holds no card value and no URL path or query", !scan.holds(JSON.stringify(ev)) && !/\.html|\?|\/[a-z0-9-]+\//i.test(JSON.stringify(ev.order)) && !/^https?:\/\/[^/]+\//.test(ev.origin));
    const ex = Date.parse(ev.expires);
    verify("pay_request's expires: 10 minutes after the request, in UTC (ISO 8601)", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(ev.expires) && Math.abs(ex - (Date.now() + 600_000)) < 120_000, ev.expires);
  };
  const keepFile = () => join(state, "pay-results.json");
  /** The end of a payment: the agent's text (with the block's line), one pay_result, the pay events, the status and the keep. */
  const expectEnd = async (r: Paid, want: { state: string; text: string; alert?: boolean; keys: boolean; request: boolean }) => {
    const head = want.state === "stopped" ? `Not paid: ${want.text}` : want.text;
    const a = r.answer;
    verify(`the agent's answer: "${head}", with the block's line, ${want.state === "paid" ? "a tool result" : "a tool error"}`, !("error" in a) && a.text === `${head}\n${BLOCK}` && a.isError === (want.state !== "paid") && a.items === 1, JSON.stringify(a));
    verify(want.request ? "the request sent a pay_request" : "no pay_request (the stop came before the approval)", (r.req !== null) === want.request);
    if (want.request) {
      const mine = r.result.filter((l) => l.id === r.req.id);
      const x = mine[0] ?? {};
      verify("pay_result comes once, with C12's fields only, the state, the text and alert", mine.length === 1 && Object.keys(x).sort().join(",") === "alert,at,ev,id,origin,scope,state,t,text" && x.state === want.state && x.text === want.text && x.alert === (want.alert ?? false) && x.scope === "live-1" && x.origin === SHOP, JSON.stringify(mine));
    } else verify("no pay_result", r.result.length === 0, JSON.stringify(r.result));
    const starts = r.pays.filter((p) => p.state === "start").length, ends = r.pays.filter((p) => p.state === "end").length;
    verify(want.keys ? "C12's pay: one start before the first key, one end at the act's end" : "C12's pay: none (no key)", want.keys ? starts === 1 && ends === 1 && r.pays[0]?.state === "start" : r.pays.length === 0, JSON.stringify(r.pays));
    const st = await mcpCall("browser_pay_status", {});
    const top = "error" in st ? null : JSON.parse(st.text).results?.[0];
    verify("browser_pay_status: the newest result is this one (state, text, origin, at), compact JSON", top !== null && Object.keys(top).sort().join(",") === "at,origin,state,text" && top.state === want.state && top.text === want.text && top.origin === SHOP, "error" in st ? st.error : st.text.slice(0, 300));
    const mode = statSync(keepFile()).mode & 0o777;
    const kept = JSON.parse(readFileSync(keepFile(), "utf8"));
    seen.push(JSON.stringify(kept));
    const e = r.req ? kept.results.find((x: any) => x.id === r.req.id) : kept.results.at(-1);
    verify("the keep (pay-results.json, mode 0600) holds the result with C12's fields only", mode === 0o600 && !!e && e.state === want.state && e.text === want.text && Object.keys(e).sort().join(",") === "alert,at,id,origin,scope,state,text", `mode ${mode.toString(8)}; ${JSON.stringify(e)}`);
    const card = r.req?.card ?? (want.text.startsWith("Declined") ? CARDS.decline.name : CARDS.ok.name);
    const line = new RegExp(`pay: request ${e?.id}: user [^,]+, scope live-1, repo local/test, card ${card}, origin ${SHOP.replace(/[.:/]/g, "\\$&")}, amount 51\\.00 USD, state ${want.state}, \\d+ ms, \\d+ blocked, \\d+ guarded`);
    verify("the service's one log line of the request (C11: the user, the scope, the repo, the request id, the card's name, the origin, the amount, the state, the time, the counts)", line.test(serviceErr), serviceErr.split("\n").find((l) => l.includes(`pay: request ${e?.id}: user`)) ?? "no line");
  };
  const charges = (r: Paid) => hits.slice(r.h0).filter((h) => h.host === "pay.localhost" && h.path === "/charge");
  const fieldsTyped = (h: MerchantHit | undefined) => !!h?.charge && h.charge.get("number") !== null && [h.charge.get("exp") === VALUES.expiry, h.charge.get("csc") === VALUES.csc, h.charge.get("name") === VALUES.holder, h.charge.get("postal") === VALUES.postal].every(Boolean);

  // ---------------------------------------------------------------- 3. the base case
  await step("3 the base case: Paid", async () => {
    const r = await pay({ variant: "base" });
    check("the agent's browser_pay sent a pay_request", r.req !== null, JSON.stringify(r.answer));
    checkRequest(r.req, CARDS.ok.name);
    verify("the operator's approval (kind operator, the pane's seal of browser-pay with C12's binding) applies", r.approval?.ok === true && JSON.stringify(r.approval.data) === "{}", JSON.stringify(r.approval));
    await expectEnd(r, { state: "paid", text: `Paid: 51.00 USD to ${SHOP}, order SHOP-1001`, keys: true, request: true });
    const ch = charges(r);
    baseCharge = ch.length === 1 && ch[0].charge?.get("number") === CARDS.ok.number && fieldsTyped(ch[0]);
    verify("the test provider's API got one charge, with the published test number and each typed test value (the keys reached the provider frame's fields)", baseCharge, `${ch.length} charges`);
    verify("the save-card box was unticked before the press (the charge says save=0)", ch[0]?.charge?.get("save") === "0", `save=${ch[0]?.charge?.get("save")}`);
    verify("the merchant's confirmation page loaded after the charge", hits.slice(r.h0).some((h) => h.host === "shop.localhost" && h.path === "/confirmation.html" && h.at >= (ch[0]?.at ?? Infinity)));
    verify("the provider frame's own requests reached the provider (fields.html, fields.js, the charge): Fetch held none of them", ["/fields.html", "/fields.js", "/charge"].every((p) => hits.slice(r.h0).some((h) => h.host === "pay.localhost" && h.path === p && h.at >= r.tReq - 60_000)));
  });

  // ---------------------------------------------------------------- 4. the test merchant's variants
  await step("4 decline: the decline test number", async () => {
    const r = await pay({ variant: "base", card: CARDS.decline.name });
    if (r.req) checkRequest(r.req, CARDS.decline.name);
    await expectEnd(r, { state: "declined", text: "Declined by the card's bank or the merchant", keys: true, request: true });
    const ch = charges(r);
    verify("the provider's API got the decline test number (and declined it)", ch.length === 1 && ch[0].charge?.get("number") === CARDS.decline.number, `${ch.length} charges`);
  });
  let bankEvidence: string | null = null;
  await step("4 bank: the bank's second step after the press (and 6: the act's rules grow after the press)", async () => {
    const r = await pay({ variant: "bank" });
    await expectEnd(r, { state: "unknown", text: "The card's bank asked for a second step. The payment's result is unknown: check the merchant's account before you buy by hand.", alert: true, keys: true, request: true });
    const ch = charges(r), bank = hits.slice(r.h0).filter((h) => h.host === "bank.localhost" && h.path === "/3ds.html");
    bankEvidence = `${ch.length} charge, ${bank.length} bank page loads`;
    verify("6: after the press the bank's frame (bank.localhost, outside the act's rules before the press) reached its host: the held request waited for the second act_rules, which the receiver took, and went on",
      ch.length === 1 && bank.length >= 1 && bank[0].at >= ch[0].at && !/the act's rules did not grow after the press/.test(serviceErr), bankEvidence);
  });
  await step("4 fee: the fee at the press", async () => {
    const r = await pay({ variant: "fee" });
    await expectEnd(r, { state: "paid", text: "Paid, but the merchant's confirmation shows 54.00 USD", alert: true, keys: true, request: true });
  });
  const last4 = CARDS.ok.number.slice(-4);
  await step("4 last4: the last four digits on a line of the confirmation", async () => {
    const r = await pay({ variant: "last4" });
    await expectEnd(r, { state: "paid", text: `Paid: 51.00 USD to ${SHOP}, order SHOP-1004`, keys: true, request: true });
    verify("no text of the result holds the card's last four digits (the reader refused that line and took the order number of another line)", !("error" in r.answer) && !r.answer.text.includes(last4) && !r.result.some((l) => String(l.text).includes(last4)));
  });
  await step("4 last4-order: the last four digits in the order number", async () => {
    const r = await pay({ variant: "last4-order" });
    await expectEnd(r, { state: "paid", text: `Paid: 51.00 USD to ${SHOP}, order number not found`, keys: true, request: true });
    verify("no text of the result holds the card's last four digits", !("error" in r.answer) && !r.answer.text.includes(last4) && !r.result.some((l) => String(l.text).includes(last4)));
  });
  await step("4 total-change: a total change before the press", async () => {
    const r = await pay({ variant: "total-change" });
    await expectEnd(r, { state: "stopped", text: "The checkout's total changed before the payment.", keys: true, request: true });
    verify("no charge reached the provider", charges(r).length === 0);
  });
  await step("4 own-fields: card fields on the shop's own page", async () => {
    const r = await pay({ variant: "own-fields" });
    await expectEnd(r, { state: "stopped", text: "This checkout's card fields are not in a known payment provider's frame", keys: false, request: false });
  });
  await step("4 other-frame: card fields in a frame that is not on the list", async () => {
    const r = await pay({ variant: "other-frame" });
    await expectEnd(r, { state: "stopped", text: "This checkout's card fields are not in a known payment provider's frame", keys: false, request: false });
  });
  await step("4 two-totals: two totals", async () => {
    const r = await pay({ variant: "two-totals" });
    await expectEnd(r, { state: "stopped", text: "The agent browser cannot read the total of this checkout.", keys: false, request: false });
  });
  await step("4 keep: a save-card box that cannot be unticked", async () => {
    const r = await pay({ variant: "keep" });
    await expectEnd(r, { state: "stopped", text: "The checkout keeps the card, and the agent browser cannot turn that off.", keys: false, request: true });
    verify("no charge reached the provider", charges(r).length === 0);
  });
  await step("4 session: the checkout bound to sessionStorage", async () => {
    await agentGoto(`${SHOP}/index-session.html`);
    await agentGoto(page("session"));
    const shown = await evalA(`document.body.innerText.includes("Total: $51.00")`);
    check("the agent's own tab shows the cart of its sessionStorage", shown === true);
    const r = await pay({ variant: "session", goto: false });
    await expectEnd(r, { state: "stopped", text: "This checkout cannot move to the payment act", keys: false, request: false });
  });

  // ---------------------------------------------------------------- 5. the attacks
  await step("5a the agent during a payment: its cart change, its reads of each tab and frame, its service worker and channel", async () => {
    await agentGoto(page("base"));
    const own = new Set<string>(((await c.send("Target.getTargets")).targetInfos as any[]).map((t) => t.targetId));
    // The agent's own frames of its tab (the provider frame out of process): Target.setAutoAttach on its tab's session.
    const frames: { sessionId: string; url: string; targetId: string }[] = [];
    const offAttach = c.on("Target.attachedToTarget", (p: any, sid?: string) => { if (sid === A.sessionId && p?.targetInfo?.type === "iframe") frames.push({ sessionId: p.sessionId, url: p.targetInfo.url, targetId: p.targetInfo.targetId }); });
    await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, A.sessionId);
    await sleep(500);
    for (const f of frames) own.add(f.targetId);
    // Its service worker and its listener of the shop's channel, before the request (rule 90 blocks the script later).
    const set = await evalA(`(async () => {
      window.__awHeard = [];
      const ch = new BroadcastChannel("shop-sync");
      ch.onmessage = (e) => window.__awHeard.push({ at: Date.now(), data: JSON.stringify(e.data) });
      await navigator.serviceWorker.register(${JSON.stringify(AGENT_SW_PATH)}, { scope: "/" });
      for (let i = 0; i < 100 && !navigator.serviceWorker.controller; i++) await new Promise((t) => setTimeout(t, 100));
      return navigator.serviceWorker.controller ? "controlled" : "not controlled";
    })()`);
    check("the agent's own service worker on the shop's origin controls its tab", set === "controlled", String(set));
    await evalA(`fetch("/index.html?aw-twin=1").then((r) => r.status, (e) => e.message)`);
    await evalA(`(new BroadcastChannel("shop-sync").postMessage({ op: "twin" }), 1)`);
    await sleep(800);
    const twin = String(await evalA(`JSON.stringify(window.__awHeard)`));
    check("twin: the agent's listener hears its own post and its worker's note of its own fetch (the channel and the worker are live in its context)", twin.includes("twin") && twin.includes("aw-twin=1"), twin.slice(0, 200));
    const reads: { what: string; at: number; out: string }[] = [];
    const record = (what: string, out: unknown) => { const s = typeof out === "string" ? out : JSON.stringify(out) ?? "undefined"; seen.push(s); reads.push({ what, at: Date.now(), out: s }); return s; };
    const tryRead = async (what: string, f: () => Promise<unknown>) => record(what, await f().catch((e: Error) => `error: ${e.message}`));
    const readJs = `JSON.stringify({ inputs: [...document.querySelectorAll("input")].map((i) => [i.value, i.getAttribute("value")]), local: Object.entries(localStorage), session: Object.entries(sessionStorage), heard: window.__awHeard || [], text: document.body ? document.body.innerText : "" })`;
    const windowsSeen: { id: number; left: number; top: number; state: string }[] = [];
    let P: { targetId: string; sessionId: string } | null = null;
    let going = true, rounds = 0, cart = "", cliTabs = "", cliText = "";
    let loop: Promise<void> = Promise.resolve();
    const r = await pay({ variant: "base", goto: false, onRequest: async () => {
      // The agent's cart change during the wait: rule 90 blocks each request of its tabs to the shop's domain.
      cart = record("the cart change", await evalA(`fetch("/aw-cart-change?qty=9", { method: "POST", body: "qty=9" }).then((x) => "reached " + x.status, (e) => "failed: " + e.message)`));
      // Its own tab of the provider's fields page (another tab it can reach).
      const t = await c.send("Target.createTarget", { url: `${PAYO}/fields.html` });
      P = { targetId: t.targetId, sessionId: (await c.send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId };
      own.add(t.targetId);
      await c.send("Runtime.enable", {}, P.sessionId).catch(() => {});
      // Its CLI reads.
      const tabs = await cli(["tabs", "--json"], url);
      cliTabs = tabs.stdout;
      const id = (() => { try { const j = JSON.parse(tabs.stdout); const list = Array.isArray(j) ? j : j.tabs ?? []; return String(list.find((x: any) => String(x.url ?? "").startsWith(SHOP))?.id ?? list[0]?.id ?? ""); } catch { return ""; } })();
      if (id) cliText = (await cli(["text", id], url)).stdout;
      loop = (async () => {
        while (going) try {
          await tryRead("A Runtime.evaluate (its fields, storage, channel, text)", () => evalA(readJs));
          for (const f of frames) await tryRead("A's provider frame Runtime.evaluate (its fields)", () => evalA(readJs, f.sessionId));
          await tryRead("A DOMSnapshot.captureSnapshot", () => c.send("DOMSnapshot.captureSnapshot", { computedStyles: [] }, A.sessionId, 10_000));
          await tryRead("A Page.captureScreenshot", () => c.send("Page.captureScreenshot", {}, A.sessionId, 10_000));
          await tryRead("A Accessibility.getFullAXTree", () => c.send("Accessibility.getFullAXTree", {}, A.sessionId, 10_000));
          if (P) {
            const p = P as { sessionId: string };
            await tryRead("P Runtime.evaluate (its fields)", () => evalA(readJs, p.sessionId));
            await tryRead("P DOMSnapshot.captureSnapshot", () => c.send("DOMSnapshot.captureSnapshot", { computedStyles: [] }, p.sessionId, 10_000));
            await tryRead("P Page.captureScreenshot", () => c.send("Page.captureScreenshot", {}, p.sessionId, 10_000));
          }
          await tryRead("Target.getTargets", () => c.send("Target.getTargets", {}, undefined, 10_000));
          await tryRead("Target.getBrowserContexts", () => c.send("Target.getBrowserContexts", {}, undefined, 10_000));
          const w = await c.send("Browser.getWindowForTarget", { targetId: A.targetId }, undefined, 10_000).catch(() => null);
          record("Browser.getWindowForTarget of A", w);
          if (w?.windowId) for (let id = Math.max(1, w.windowId - 5); id <= w.windowId + 30 && going; id++) {
            const b = await c.send("Browser.getWindowBounds", { windowId: id }, undefined, 5000).catch(() => null);
            if (b?.bounds) { record(`Browser.getWindowBounds ${id}`, b); windowsSeen.push({ id, left: b.bounds.left, top: b.bounds.top, state: b.bounds.windowState }); }
          }
          rounds++;
          await sleep(200);
        } catch (e) { record("the read loop", `error: ${(e as Error).message}`); await sleep(300); }
      })();
      await sleep(1500);
    } });
    going = false;
    await loop;
    offAttach();
    await expectEnd(r, { state: "paid", text: `Paid: 51.00 USD to ${SHOP}, order SHOP-1001`, keys: true, request: true });
    verify("the agent's cart change during the wait failed (rule 90), and the merchant got no request of it during the payment", /^failed: /.test(cart) && !hits.some((h) => h.path === "/aw-cart-change" && h.at >= r.tReq && h.at <= r.tEnd), cart);
    const during = reads.filter((x) => x.at >= r.tReq && x.at <= r.tEnd);
    const kinds = [...new Set(during.map((x) => x.what.replace(/ \d+$/, "")))];
    verify(`the agent read each tab and frame that it can reach during the payment (${rounds} rounds, ${during.length} reads): its checkout tab, the provider frame of that tab (${frames.length} frame), its own tab of the provider's page, the targets, the contexts, the windows`, rounds > 0 && frames.length > 0 && P !== null, kinds.join("; "));
    verify("no read of the agent during the payment holds a test value (Runtime.evaluate, DOMSnapshot, a screenshot, the accessibility tree, the targets, the windows)", !during.some((x) => scan.holds(x.out)), during.filter((x) => scan.holds(x.out)).map((x) => x.what).join(", "));
    verify("the agent's CLI reads (tabs --json, text) answered and hold no test value", cliTabs.length > 0 && !scan.holds(cliTabs) && !scan.holds(cliText), `${cliTabs.length} and ${cliText.length} bytes`);
    const ids = during.filter((x) => x.what === "Target.getTargets" && !x.out.startsWith("error")).flatMap((x) => (JSON.parse(x.out).targetInfos as any[]).map((t) => t.targetId));
    verify("the agent saw no target of the act: each target of Target.getTargets during the payment is its own", ids.length > 0 && ids.every((id) => own.has(id)), `${ids.length} ids; not its own: ${[...new Set(ids.filter((id) => !own.has(id)))].join(", ")}`);
    verify("the agent's window search (Browser.getWindowBounds of the ids around its own window) found no window outside the screen", !windowsSeen.some((w) => w.left >= SCREEN_W), JSON.stringify([...new Map(windowsSeen.map((w) => [w.id, w])).values()]));
    // Its service worker and its channel: nothing of the act's context.
    const swLog = String(await evalA(`(async () => { const c = await caches.open("aw-sw-log"); const out = []; for (const k of await c.keys()) out.push(await (await c.match(k)).text()); return JSON.stringify(out); })()`));
    seen.push(swLog);
    const swDuring = (JSON.parse(swLog) as string[]).map((x) => JSON.parse(x)).filter((x) => x.at >= r.tReq && x.at <= r.tEnd);
    verify("the agent's service worker saw no request of the act during the payment (only the agent's own blocked cart change)", swDuring.every((x) => new URL(x.url).pathname === "/aw-cart-change") && !scan.holds(swLog), JSON.stringify(swDuring.map((x) => new URL(x.url).pathname)));
    const heard = (JSON.parse(String(await evalA(`JSON.stringify(window.__awHeard)`))) as { at: number; data: string }[]);
    seen.push(JSON.stringify(heard));
    const heardDuring = heard.filter((x) => x.at >= r.tReq && x.at <= r.tEnd && !x.data.includes("aw-cart-change"));
    verify("the agent's listener of the shop's channel heard nothing of the act page (its steps typed and charged) during the payment", heardDuring.length === 0 && !scan.holds(JSON.stringify(heard)), JSON.stringify(heardDuring).slice(0, 300));
    const after = await evalA(`fetch("/aw-cart-change?after=1").then((x) => "reached " + x.status, (e) => "failed: " + e.message)`);
    verify("after the payment the agent's tab reaches the shop again (rule 90 is gone)", /^reached \d+$/.test(String(after)) && hits.some((h) => h.path === "/aw-cart-change" && h.query === "?after=1"), String(after));
    // The act window: at each look of the X windows it was outside the screen.
    // The act page's title (the shop's): the title marker of the act window before its move shows about:blank only.
    const act = xLooks.filter((l) => l.at >= r.tReq && l.at <= r.tEnd && /Test Shop/.test(l.w.name) && !agentX.has(l.w.id));
    verify("the act window was outside the screen at each look of the display's X windows during the payment (to the right of the 1280 px screen)", act.length > 0 && act.every((l) => l.w.x >= SCREEN_W), `${act.length} looks; ${JSON.stringify(act.slice(0, 2).map((l) => [l.w.name, l.w.x, l.w.y]))}`);
    await evalA(`navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((x) => x.unregister()))).then(() => caches.delete("aw-sw-log")).then(() => "gone")`);
    await c.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }, A.sessionId).catch(() => {});
    if (P) await c.send("Target.closeTarget", { targetId: (P as { targetId: string }).targetId }).catch(() => {});
  });

  let replay: { request: string; sealed: unknown } | null = null;
  await step("5b approvals: kind token and daemon, then the operator's, then its replay", async () => {
    let tok: any = null, dmn: any = null, ok: any = null;
    const r = await pay({ variant: "base", answer: "none", onRequest: async (ev) => {
      tok = await approve(ev, "approve", { by: TOKEN });
      dmn = await approve(ev, "approve", { by: DAEMON });
      const sealed = approvalSeal(paneKey, ev, "approve");
      ok = await req("pay_approve", OPERATOR, { request: ev.id, sealed });
      replay = { request: ev.id, sealed };
    } });
    verify("pay_approve with kind token gets \"not the operator\" (a program can seal to the public pane key)", tok?.ok === false && tok.error === "not the operator", JSON.stringify(tok));
    verify("pay_approve with kind daemon gets \"not the operator\"", dmn?.ok === false && dmn.error === "not the operator", JSON.stringify(dmn));
    verify("the operator's approval applies after them (the request still waited)", ok?.ok === true, JSON.stringify(ok));
    await expectEnd(r, { state: "paid", text: `Paid: 51.00 USD to ${SHOP}, order SHOP-1001`, keys: true, request: true });
    const nR = d.lines.length;
    const again = await req("pay_approve", OPERATOR, replay!);
    await sleep(1000);
    verify("the replayed approval gets \"this payment request is gone\", and no act starts (no pay event, no charge)", again.ok === false && again.error === "this payment request is gone" && !d.lines.slice(nR).some((l) => l.t === "ev" && /^pay/.test(l.ev)) && charges({ h0: hits.length } as Paid).length === 0, JSON.stringify(again));
  });

  await step("5c approvals that do not match: another request, another order hash, an unknown request", async () => {
    const unknown = await req("pay_approve", OPERATOR, { request: randomBytes(8).toString("hex"), sealed: approvalSeal(paneKey, { id: "0".repeat(16), origin: SHOP, order: { lines: [], total: "51.00", currency: "USD" }, card: CARDS.ok.name }, "approve") });
    verify("pay_approve of a request id that the service does not know gets \"this payment request is gone\"", unknown.ok === false && unknown.error === "this payment request is gone", JSON.stringify(unknown));
    for (const [label, fields] of [["another request's binding (its id)", { request: randomBytes(8).toString("hex") }], ["another order hash", { order: createHash("sha256").update("another order").digest("hex") }]] as const) {
      let a: any = null, replayed: any = null;
      const r = await pay({ variant: "base", answer: "none", onRequest: async (ev) => {
        if (replay && label.startsWith("another request")) replayed = await req("pay_approve", OPERATOR, { ...replay, request: ev.id });
        a = replayed ?? await approve(ev, "approve", { fields });
      } });
      verify(`an approval sealed with ${replayed ? "5b's seal (another request's binding)" : label} gets "this approval does not match the payment request"`, a?.ok === false && a.error === "this approval does not match the payment request", JSON.stringify(a));
      await expectEnd(r, { state: "stopped", text: "This approval does not match the payment request", keys: false, request: true });
      verify("no charge reached the provider", charges(r).length === 0);
    }
  });

  await step("5d a cancelled call, then a new request: its earlier holds the result", async () => {
    const ac = new AbortController();
    const r1 = await pay({ variant: "base", answer: "none", signal: ac.signal, onRequest: async () => { ac.abort(new Error("the agent's cancel of the live check")); } });
    verify("the cancelled call ends at the client", "error" in r1.answer, JSON.stringify(r1.answer));
    const res = r1.req ? await d.after(r1.n0, (l) => l.t === "ev" && l.ev === "pay_result" && l.id === r1.req.id, 30_000).catch(() => null) : null;
    verify("pay_result of the cancelled request: stopped, \"The agent cancelled the payment request.\"", res?.state === "stopped" && res.text === "The agent cancelled the payment request." && res.alert === false, JSON.stringify(res));
    await sleep(1500);
    let earlier: any[] = [];
    const r2 = await pay({ variant: "base", answer: "refuse", onRequest: async (ev) => { earlier = ev.earlier; } });
    verify("the next pay_request's earlier holds the cancelled request's result first (state, text, at; the newest first)", earlier.length >= 1 && earlier[0].state === "stopped" && earlier[0].text === "The agent cancelled the payment request." && earlier[0].at === res?.at && Object.keys(earlier[0]).sort().join(",") === "at,state,text", JSON.stringify(earlier.slice(0, 2)));
    verify("earlier holds the earlier results of the origin (the base case's Paid among them)", earlier.some((e) => e.state === "paid" && e.text === `Paid: 51.00 USD to ${SHOP}, order SHOP-1001`) || (ONLY !== null), `${earlier.length} results`);
    await expectEnd(r2, { state: "stopped", text: "The operator refused this payment.", keys: false, request: true });
  });

  // ---------------------------------------------------------------- 6. what Chrome must confirm (Task 5b)
  await step("6 the provider frame out of process: the click and the keys reach its fields", async () => {
    await agentGoto(page("base"));
    const frames: any[] = [];
    const off = c.on("Target.attachedToTarget", (p: any, sid?: string) => { if (sid === A.sessionId) frames.push(p.targetInfo); });
    await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, A.sessionId);
    await sleep(800);
    off();
    await c.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }, A.sessionId).catch(() => {});
    verify("this Chrome runs the provider frame (pay.localhost in shop.localhost's page) out of process: a frame target of its own", frames.some((t) => t?.type === "iframe" && String(t.url).startsWith(`${PAYO}/fields.html`)), JSON.stringify(frames.map((t) => [t?.type, t?.url])));
    verify("the base case's charge carried the published test number and each typed value: the act's clicks landed on the fields of that frame and its keys reached them", baseCharge === true, baseCharge === null ? "the base case did not run" : "");
  });
  await step("6 the guard in the provider frame's own session (Fetch): the frame's request with the number fails", async () => {
    const r = await pay({ variant: "leak" });
    await expectEnd(r, { state: "stopped", text: "The checkout tried to send the card's number to a place where it does not belong.", keys: true, request: true });
    const leaked = hits.slice(r.h0).filter((h) => h.host === "pay.localhost" && h.path === "/collect");
    verify("no request of the frame with the number reached the provider's host, and no charge", leaked.length === 0 && charges(r).length === 0, `${leaked.length} requests`);
    verify("the service logged the guard's one line for the act", /pay: request [0-9a-f]{16}: the guard failed a request that held the card's number/.test(serviceErr));
  });
  await step("6 a reload of the provider frame during the fill stops the act", async () => {
    const r = await pay({ variant: "reload" });
    await expectEnd(r, { state: "stopped", text: "The payment provider's frame loaded again during the fill.", keys: true, request: true });
    verify("no charge reached the provider", charges(r).length === 0);
    verify("the provider's frame loaded again (the page asked for fields.html twice)", hits.slice(r.h0).filter((h) => h.host === "pay.localhost" && h.path === "/fields.html").length >= 2);
  });
  await step("6 windows.get with populate, and the merchant's domain of a *.localhost host", async () => {
    note("windows.get with populate: the act's check before the first key (pay-act.ts, otherTab) counts a window answer with no tab list as no other tab, so a Paid does not show that populate gave the act window's tabs (defect D1 of the phase-A note; PR #228's files)");
    const tree = await c.send("Page.getFrameTree", {}, A.sessionId);
    const dr = tree?.frameTree?.frame?.domainAndRegistry;
    note(`Chrome's domainAndRegistry of the agent's tab (${new URL(tree?.frameTree?.frame?.url ?? "about:blank").host}): ${JSON.stringify(dr)}; the act takes a *.localhost host as its own domain`);
    const blocks = d.lines.filter((l) => l.t === "ev" && l.ev === "pay_result").length;
    verify("each payment that got past the session copy answered with the block's line of the domain shop.localhost (the merchant's domain of the *.localhost host)", results.filter((x) => x.step.includes("with the block's line")).every((x) => x.ok), `${blocks} pay_result lines`);
  });

  // ---------------------------------------------------------------- 7. the secret scan, with its twin
  await step("7 the secret scan", async () => {
    const groups = CARDS.ok.number.match(/.{4}/g)!;
    const twins = [`x ${groups.join("%20")} y`, `{"csc":"${VALUES.csc}"}`, `exp ${VALUES.expiry.replace("/", "%2F")}`, `${groups.join("+")}`, `holder ${VALUES.holder}`];
    verify("the scan's twin finds each planted test value (the number in groups with %20 and +, the security code, the expiry, the holder)", twins.every((t) => scan.holds(t)) && !scan.holds(`order SHOP-1001, 51.00 USD, ${SHOP}, pid 40719, 07:19, 0719x`));
    const hitsOf = (texts: string[]) => [...new Set(texts.flatMap((t) => scan.hits(t)))];
    verify(`no control line, MCP answer, CLI output or agent read holds a test value (${seen.length} texts)`, hitsOf(seen).length === 0, hitsOf(seen).join(", "));
    verify("no log line of the service holds a test value", !scan.holds(serviceErr), scan.hits(serviceErr).join(", "));
    const payLines = serviceErr.split("\n").filter((l) => /\bpay:|act_/.test(l));
    verify(`no payment log line of the service holds a URL path or a query, the page's order or the agent's description (${payLines.length} lines)`, payLines.length > 0 && !payLines.some((l) => /\.html|\?|\/[a-z0-9-]+\/|Adult ticket|Ann Example|ann@example|test tickets/i.test(l)),
      payLines.filter((l) => /\.html|\?|\/[a-z0-9-]+\/|Adult ticket|Ann Example|ann@example|test tickets/i.test(l)).slice(0, 3).join(" | "));
    const keep = existsSync(keepFile()) ? readFileSync(keepFile(), "utf8") : "";
    verify("no keep entry holds a test value", keep.length > 0 && !scan.holds(keep));
    const profileHits: string[] = [];
    let files = 0;
    const walk = (p: string) => {
      for (const e of readdirSync(p, { withFileTypes: true })) {
        const f = join(p, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.isFile() && statSync(f).size < 64 << 20) { files++; const h = scan.holdsBytes(readFileSync(f)); if (h.length) profileHits.push(`${f.slice(state.length)} (${h.join(", ")})`); }
      }
    };
    walk(join(state, "profile"));
    verify(`no file of the profile holds a test value (${files} files)`, profileHits.length === 0, profileHits.join("; "));
  });

  // ---------------------------------------------------------------- 8. stop
  xWatch = false;
  await Promise.all(xLoopDone);
  await mcp.close().catch(() => {});
  mcp = null;
  await c.close();
  const st = await req("stop", TOKEN, {}, 30_000);
  check("stop answers ok", st.ok === true);
  d.s.end();
  await stopService();
} catch (e) {
  code = 1;
  log(`FAIL: ${(e as Error).message}`);
  if (serviceErr) log(`the service's log (end):\n${serviceErr.slice(-4000)}`);
} finally {
  xWatch = false;
  await Promise.all(xLoopDone).catch(() => {});
  for (const s of steps) log(`step ${s.name}: ${s.ok === null ? "NOT RUN" : s.ok ? "PASS" : "FAIL"} (${s.note})`);
  for (const x of notes) log(`note: ${x}`);
  if (steps.some((s) => s.ok === false)) {
    code = 1;
    log(`the service's payment lines (the evidence):\n${serviceErr.split("\n").filter((l) => /pay|act_|card/.test(l)).slice(-80).join("\n")}`);
  }
  await mcp?.close().catch(() => {});
  await c?.close().catch(() => {});
  await stopService();
  await merchant.close();
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    for (const [pid, start] of started) if (proc(pid)?.start === start) { try { process.kill(pid, sig); } catch {} }
    await sleep(2000);
  }
  const left = [...started].filter(([pid, start]) => proc(pid)?.start === start).map(([pid]) => pid);
  repo?.close();
  rmSync(dir, { recursive: true, force: true });
  log(`cleanup: ${left.length ? `still running: ${left.join(", ")}` : "no process of this run runs"}; the temp folder is ${existsSync(dir) ? "still there" : "removed"}; the test merchant is closed`);
  if (left.length) code = 1;
  if (results.some((r) => !r.ok)) code = 1;
  process.stdout.write(`${JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, steps: steps.filter((s) => s.ok !== null).length, stepsFailed: steps.filter((s) => s.ok === false).length, seconds: Math.round((Date.now() - t0) / 1000) })}\n`);
  process.exit(code);
}
