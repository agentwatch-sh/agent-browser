// The live test of agent mode (board ab-v16.6, part B; the two-modes design, section 12, stage 3). Not part of
// `npm test`. In a private Xvfb it starts a Chromium of its own with chrome-extension's agent package (Linux Chromium
// takes --load-extension), the native host of chrome-extension's live test, a stand-in for the daemon's bridge side
// (daemon.ts) and `agent-browser relay` from a scratch install. Then it runs the probe's Playwright, MCP and
// concurrency cases against the endpoint, with the refusals of contract C11, popups many times, the operator's
// tab-switch condition (ab-vsm Q4: a client switches tabs and drives a tab that is not in front), and agent-browser's
// own commands over the endpoint (--cdp-url). On Linux the relay opens every page in a window of its own and brings
// that window forward for input (ab-v16.28), so the group `windows` drives the anti-detect probe's page
// (test/live/anti-detect/probe.ts) with Playwright, with and without noDefaults, and with the Playwright MCP, and
// checks that the page shows no background-tab signal. Chromium gets --disable-backgrounding-occluded-windows, as
// the anti-detect design needs (docs/research/2026-11-05-anti-detect-drive.md, step 3): without it a covered window
// is hidden and draws nothing.
//
//   CHROME_EXTENSION=<a detached worktree of chrome-extension> npm run test:live:agent
//
// Environment: CHROME_EXTENSION (required: its agent/ and test/live/host.py are used; the agent folder is copied,
// because Chromium writes _metadata/ into the folder that it loads), CHROMIUM (default /usr/bin/chromium),
// DISPLAY_N (default 118), RUN (an empty folder; default a new one in the temp folder), CASES (default all:
// playwright,marks,switch,create,concurrency,mcp,agent-browser,windows) runs some groups only. The agent package must be
// chrome-extension main b82c65d or later: the popup cases, the hold of a new tab and the off-list frame need its
// eager attach, its hold and its DNR frame rule (ab-v16.17). It uses port 8781 (the probe's site) and *.localhost
// hosts only. It never drives or stops a Chrome that it did not start, opens no debugging port, and no prompt can
// appear. It prints one line per case and writes <RUN>/results.json; it exits 1 when a case fails. It deletes nothing.

import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TEXT } from "../../../src/relay/policy.ts";
import { bothFocusedMs, rates, startServer, stepSignals, type Rec } from "../anti-detect/probe.ts";
import { StandInDaemon } from "./daemon.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PROBE = join(ROOT, "docs/superpowers/specs/2026-11-03-two-modes-probe");
const EXT = process.env.CHROME_EXTENSION ? resolve(process.env.CHROME_EXTENSION) : "";
if (!EXT || !existsSync(join(EXT, "agent/manifest.json")) || !existsSync(join(EXT, "test/live/host.py"))) {
  process.stderr.write("usage: CHROME_EXTENSION=<a chrome-extension checkout (a detached worktree)> npm run test:live:agent\n");
  process.exit(2);
}
const CHROMIUM = process.env.CHROMIUM ?? "/usr/bin/chromium";
const DISPLAY_N = Number(process.env.DISPLAY_N ?? 118);
const RUN = resolve(process.env.RUN ?? mkdtempSync(join(tmpdir(), "ab-agent-live-")));
const CASES = (process.env.CASES ?? "playwright,marks,switch,create,concurrency,mcp,agent-browser,windows").split(",");
const A = "http://a.localhost:8781", B = "http://b.localhost:8781";
const RELAY_SOCK = join(RUN, "relay.sock"), DAEMON_SOCK = join(RUN, "daemon.sock");
const url = (scope: string) => `ws+unix://${RELAY_SOCK}:/devtools/browser/${scope}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const COOKIES = /Not available in the agent browser: cookies \(/;
const BLOCKED = /ERR_BLOCKED_BY_CLIENT/;

type Result = { group: string; case: string; status: "pass" | "fail"; ms: number; detail?: unknown; error?: string; why?: string };
const results: Result[] = [];
const say = (r: Result) => console.log(`${r.status.padEnd(7)} ${r.group}: ${r.case} (${r.ms} ms)${r.why ? ` [${r.why}]` : ""}: ${r.error ?? JSON.stringify(r.detail ?? null)}`.slice(0, 400));
function record(r: Result) { results.push(r); say(r); }

/** One case: it passes when its value is the wanted one, or, for a refusal, when the error matches. */
async function step(group: string, name: string, fn: () => Promise<unknown>, o: { want?: (d: any) => boolean; refused?: RegExp; ms?: number } = {}) {
  const t0 = Date.now();
  let detail: unknown, error: string | undefined;
  try {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${(o.ms ?? 20_000) / 1000} s`)), o.ms ?? 20_000); });
    detail = await Promise.race([fn(), limit]).finally(() => clearTimeout(timer));
  } catch (e) { error = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300); }
  const ok = o.refused ? error !== undefined && o.refused.test(error) : error === undefined && (!o.want || o.want(detail));
  record({ group, case: name, status: ok ? "pass" : "fail", ms: Date.now() - t0, ...(error === undefined ? { detail } : { error }),
    ...(!ok && error === undefined ? { why: "value not as expected" } : {}) });
}

const children: ChildProcess[] = [];
/** A child of this run, its output in <RUN>/logs/<log>; with `pipe`, its standard input and output are pipes (an MCP server). */
function start(bin: string, args: string[], opts: { env?: NodeJS.ProcessEnv; log: string; pipe?: boolean }): ChildProcess {
  const fd = openSync(join(RUN, "logs", opts.log), "a");
  const child = spawn(bin, args, { env: opts.env ?? process.env, stdio: opts.pipe ? ["pipe", "pipe", fd] : ["ignore", fd, fd] });
  children.push(child);
  return child;
}
const portFree = (port: number) => new Promise<boolean>((r) => { const s = connect(port, "127.0.0.1"); s.once("connect", () => { s.destroy(); r(false); }); s.once("error", () => r(true)); });
const status = (path: string) => new Promise<number>((r) => { get({ socketPath: RELAY_SOCK, path }, (res) => { res.resume(); r(res.statusCode ?? 0); }).once("error", () => r(0)); });

/** The extension ID that Chrome derives from the manifest's key. */
function extensionId(manifest: { key: string }): string {
  const hex = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

// ---------------------------------------------------------------- setup

mkdirSync(join(RUN, "logs"), { recursive: true });
mkdirSync(join(RUN, "home"), { recursive: true });
chmodSync(RUN, 0o700);
if (existsSync(`/tmp/.X11-unix/X${DISPLAY_N}`) || existsSync(`/tmp/.X${DISPLAY_N}-lock`)) throw new Error(`display :${DISPLAY_N} is taken; set DISPLAY_N`);
if (!(await portFree(8781))) throw new Error("port 8781 is taken (the probe's site needs it)");
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const env = { run: RUN, extension: { dir: EXT, commit: git(EXT, "rev-parse", "HEAD") }, agentBrowser: git(ROOT, "rev-parse", "HEAD"),
  chromium: execFileSync(CHROMIUM, ["--version"], { encoding: "utf8" }).trim() };
console.log(`run ${RUN}\n${JSON.stringify(env)}`);

const INSTALL = join(RUN, "install");
const RELAY_BIN = join(INSTALL, "node_modules/agent-browser/bin/agent-browser.js");
let daemon: StandInDaemon | undefined, chromium: ChildProcess | undefined, aborted: string | undefined, cleaning: Promise<void> | undefined;

/** A child of this run: SIGTERM, then SIGKILL when it is still there after 3 s. */
async function stopChild(c: ChildProcess): Promise<void> {
  if (c.exitCode !== null || c.signalCode !== null) return;
  const gone = new Promise<boolean>((r) => c.once("exit", () => r(true)));
  c.kill("SIGTERM");
  if (await Promise.race([gone, sleep(3000).then(() => false)])) return;
  c.kill("SIGKILL");
  await Promise.race([gone, sleep(2000)]);
}

/** Stop everything that this run started, once (also at a signal), and write the results. */
function cleanup(): Promise<void> {
  return cleaning ??= (async () => {
    const relayExit = daemon ? await daemon.stop() : null;
    if (daemon) record({ group: "relay", case: "the relay ends with its standard input and removes its socket", status: relayExit === 0 && !existsSync(RELAY_SOCK) ? "pass" : "fail", ms: 0, detail: { exit: relayExit } });
    for (const c of [...children].reverse()) await stopChild(c);
    if (daemon) writeFileSync(join(RUN, "logs/daemon.log"), [...daemon.log, ...daemon.waiting().map((w) => `still waiting: ${w}`)].join("\n") + "\n");
    const count = (st: Result["status"]) => results.filter((r) => r.status === st).length;
    writeFileSync(join(RUN, "results.json"), JSON.stringify({ env, ...(aborted ? { aborted } : {}), results }, null, 2) + "\n");
    console.log(`\n${aborted ? `ABORTED (${aborted}): ` : ""}${results.length} cases: ${count("pass")} pass, ${count("fail")} fail; ${join(RUN, "results.json")}`);
    process.exitCode = aborted || count("fail") ? 1 : 0;
  })();
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(sig, () => { aborted ??= `signal ${sig}`; void cleanup().then(() => process.exit(1)); });

try {
  // The scratch install: this checkout as a package, and the clients that the probe used.
  mkdirSync(INSTALL);
  const npm = (args: string[], cwd: string) => execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
  const tarball = join(RUN, npm(["pack", "--silent", "--pack-destination", RUN], ROOT).split("\n").pop()!);
  npm(["init", "-y"], INSTALL);
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball, "playwright-core@1.64.1", "@playwright/mcp@0.0.84"], INSTALL);

  // The agent package, its native host and the profile.
  cpSync(join(EXT, "agent"), join(RUN, "agent"), { recursive: true });
  const id = extensionId(JSON.parse(readFileSync(join(RUN, "agent/manifest.json"), "utf8")));
  const PROFILE = join(RUN, "profile");
  mkdirSync(join(PROFILE, "NativeMessagingHosts"), { recursive: true });
  const hostSh = join(RUN, "host.sh");
  writeFileSync(hostSh, `#!/bin/sh\nexec /usr/bin/python3 ${join(EXT, "test/live/host.py")} --socket ${DAEMON_SOCK} --log ${join(RUN, "logs/host.log")} "$@"\n`, { mode: 0o700 });
  writeFileSync(join(PROFILE, "NativeMessagingHosts/sh.agentwatch.browser.json"),
    JSON.stringify({ name: "sh.agentwatch.browser", description: "live test", path: hostSh, type: "stdio", allowed_origins: [`chrome-extension://${id}/`] }));
  writeFileSync(join(RUN, "upload.txt"), "probe upload body\n");

  start(process.execPath, [join(PROBE, "site.mjs")], { env: { ...process.env, SITE_LOG: join(RUN, "site-log.jsonl") }, log: "site.log" });
  daemon = new StandInDaemon({ daemonSocket: DAEMON_SOCK, relaySocket: RELAY_SOCK, relayBin: RELAY_BIN, allowlist: ["a.localhost"],
    relayLog: (l) => appendFileSync(join(RUN, "logs/relay.log"), `${l}\n`) });
  // A private display: one MIT-MAGIC-COOKIE-1 entry from randomBytes in a 0600 file; the cookie never enters an argv.
  const field = (b: Buffer) => Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]);
  const xauth = join(RUN, "xauth");
  writeFileSync(xauth, Buffer.concat([Buffer.from([0xff, 0xff]), field(Buffer.alloc(0)), field(Buffer.from(String(DISPLAY_N))), field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(randomBytes(16))]), { mode: 0o600 });
  start("Xvfb", [`:${DISPLAY_N}`, "-nolisten", "tcp", "-auth", xauth, "-screen", "0", "1280x900x24"], { log: "xvfb.log" });
  for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${DISPLAY_N}`); i++) await sleep(200);
  chromium = start(CHROMIUM, [`--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check", "--password-store=basic",
    `--load-extension=${join(RUN, "agent")}`, "--silent-debugger-extension-api", "--enable-unsafe-swiftshader", "--lang=en-US",
    "--disable-backgrounding-occluded-windows", "--window-position=0,0", "--window-size=1280,900", "about:blank"],
  { env: { PATH: "/usr/bin:/bin", HOME: join(RUN, "home"), LANG: "en_US.UTF-8", DISPLAY: `:${DISPLAY_N}`, XAUTHORITY: xauth }, log: "chromium.log" });
  // Ready: a plain request gets 404 once the endpoint takes connections (503 before).
  let ready = 0;
  for (let i = 0; i < 120 && (ready = await status("/devtools/browser/probe")) !== 404; i++) await sleep(500);
  if (ready !== 404) throw new Error(`the endpoint did not get ready (HTTP ${ready}); see ${RUN}/logs`);

  const pw = createRequire(join(INSTALL, "package.json"))("playwright-core");
  if (CASES.includes("playwright")) await playwrightCases(pw);
  if (CASES.includes("marks")) await refusedFeatureCases(pw);
  if (CASES.includes("switch")) await tabSwitchCase(createRequire(join(INSTALL, "package.json"))("ws"));
  if (CASES.includes("create")) await createWithUrlCases(createRequire(join(INSTALL, "package.json"))("ws"));
  if (CASES.includes("concurrency")) await probeScript("concurrency", "concurrency.mjs", { RELAY_SOCK, OUT: join(RUN, "concurrency.json") }, (r) =>
    /storageState/.test(r.case) ? { refused: COOKIES } : {});
  mkdirSync(join(RUN, "mcp-out"));
  if (CASES.includes("mcp")) await probeScript("mcp", "mcp-probe.mjs", { ENDPOINT: url("mcp"), OUT: join(RUN, "mcp.json"), MCP_OUT_DIR: join(RUN, "mcp-out"), SITE_LOG: join(RUN, "site-log.jsonl") }, () => ({}));
  if (CASES.includes("agent-browser")) await agentBrowserCases();
  if (CASES.includes("windows")) await windowCases(pw);
  record({ group: "browser", case: "the agent Chromium still runs after every client left", status: chromium.exitCode === null ? "pass" : "fail", ms: 0 });
} catch (err) {
  aborted = String((err as Error)?.message ?? err).split("\n")[0];
} finally {
  await cleanup();
}
await sleep(500);
process.exit(process.exitCode);

// ---------------------------------------------------------------- the probe's Playwright cases

async function playwrightCases(pw: any) {
  const G = "playwright";
  let browser: any, context: any, page: any;
  await step(G, "connectOverCDP over the Unix socket", async () => {
    browser = await pw.chromium.connectOverCDP(url("pw"), { timeout: 20_000 });
    context = browser.contexts()[0];
    return { version: browser.version(), contexts: browser.contexts().length };
  }, { want: (d) => /^\d+\./.test(d.version) && d.contexts === 1 });
  if (!browser) return;
  const onPage = async (fn: (p: any) => Promise<unknown>) => { const p = await context.newPage(); try { return await fn(p); } finally { await p.close().catch(() => {}); } };
  await step(G, "context.newPage (Target.createTarget)", async () => { page = await context.newPage(); return context.pages().length; }, { want: (d) => d === 1 });
  await step(G, "page.goto an allowlisted page", async () => {
    const r = await page.goto(A + "/");
    return { status: r.status(), title: await page.title(), history: await page.evaluate(() => history.length) };
  }, { want: (d) => d.status === 200 && d.title === "probe a" });
  await step(G, "response.body()", async () => { const r = await page.goto(A + "/m"); const b = (await r.body()).toString(); await page.goto(A + "/"); return b.includes("<p id='m'>m</p>"); }, { want: (d) => d === true });
  await step(G, "navigator.webdriver", () => page.evaluate(() => navigator.webdriver), { want: (d) => d === false });
  await step(G, "locator.fill + click + read text", async () => { await page.locator("#name").fill("Ada"); await page.locator("#go").click(); return page.locator("#out").textContent(); }, { want: (d) => d === "Hello, Ada" });
  await step(G, "keyboard.type + press", async () => {
    await page.locator("#name").fill(""); await page.locator("#name").click(); await page.keyboard.type("Grace"); await page.keyboard.press("Enter");
    return page.locator("#name").inputValue();
  }, { want: (d) => d === "Grace" });
  await step(G, "mouse press pressure (the relay sets force 0.5)", async () => { await page.locator("#report").click(); return page.evaluate(() => (window as any).__siteSignals().pressure); },
    { want: (d) => d.includes("mouse:0.5") && !d.includes("mouse:0,") });
  await step(G, "hover", async () => { await page.locator("#hov").hover(); return page.locator("#hov").textContent(); }, { want: (d) => d === "hovered" });
  await step(G, "selectOption", async () => { await page.locator("#sel").selectOption("y"); return page.locator("#sel").inputValue(); }, { want: (d) => d === "y" });
  await step(G, "ariaSnapshot (the MCP's page read)", async () => (await page.locator("body").ariaSnapshot()).includes('button "Greet"'), { want: (d) => d === true });
  await step(G, "screenshot", async () => (await page.screenshot()).length, { want: (d) => d > 10_000 });
  await step(G, "a cross-site frame: click and read (c.localhost)", async () => { const f = page.frameLocator("#frame"); await f.locator("#fbtn").click(); return f.locator("#fout").textContent(); },
    { want: (d) => d === "frame clicked" });
  await step(G, "a dialog (confirm), accepted", async () => { page.once("dialog", (d: any) => d.accept()); await page.locator("#alert").click(); return page.locator("#alertout").textContent(); },
    { want: (d) => d === "true" });
  await step(G, "page.route (Fetch interception, fulfill)", async () => {
    await page.route("**/api/data", (r: any) => r.fulfill({ body: "mocked", contentType: "text/plain" }));
    await page.locator("#fetch").click();
    await page.waitForFunction(() => document.getElementById("fetchout")!.textContent !== "");
    const t = await page.locator("#fetchout").textContent();
    await page.unroute("**/api/data");
    return t;
  }, { want: (d) => d === "mocked" });
  await step(G, "setInputFiles (a path)", async () => { await page.locator("#file").setInputFiles(join(RUN, "upload.txt")); return page.locator("#fileout").textContent(); }, { want: (d) => d === "upload.txt:18" });
  await step(G, "setInputFiles (a buffer)", async () => {
    await page.locator("#file").setInputFiles({ name: "buf.txt", mimeType: "text/plain", buffer: Buffer.from("buffer upload") });
    return page.locator("#fileout").textContent();
  }, { want: (d) => d === "buf.txt:13" });
  await step(G, "a download (Browser.download* from the model, the file copied)", async () => {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15_000 }), page.locator("#dl").click()]);
    return { name: dl.suggestedFilename(), body: readFileSync(await dl.path(), "utf8").trim() };
  }, { want: (d) => d.name === "probe.txt" && d.body === "probe download body" });
  await step(G, "a popup (window.open)", async () => {
    const [pop] = await Promise.all([page.waitForEvent("popup", { timeout: 8000 }), page.locator("#winopen").click()]);
    await pop.waitForLoadState("load");
    const t = await pop.locator("#p").textContent();
    await pop.close();
    return t;
  }, { want: (d) => d === "Popup open" });
  await step(G, "a popup (target=_blank link)", async () => {
    const [pop] = await Promise.all([page.waitForEvent("popup", { timeout: 8000 }), page.locator("#blank").click()]);
    await pop.waitForLoadState("load");
    const u = pop.url();
    await pop.close();
    return u;
  }, { want: (d) => d === A + "/popup?via=blank" });
  await step(G, "popups many times (10 x window.open, each closed)", async () => {
    let n = 0;
    for (let i = 0; i < 10; i++) {
      const [pop] = await Promise.all([page.waitForEvent("popup", { timeout: 8000 }), page.locator("#winopen").click()]);
      await pop.waitForLoadState("load");
      if ((await pop.locator("#p").textContent()) === "Popup open") n++;
      await pop.close();
    }
    return n;
  }, { want: (d) => d === 10, ms: 60_000 });
  await step(G, "an off-list popup is blocked (DNR)", () => onPage(async (p) => {
    await p.goto(A + "/");
    const [pop] = await Promise.all([p.waitForEvent("popup", { timeout: 8000 }), p.locator("#winopenoff").click()]);
    await pop.waitForTimeout(800);
    const r = { url: pop.url(), title: await pop.title().catch(() => "") };
    await pop.close().catch(() => {});
    return r;
  }), { want: (d) => d.url.startsWith("chrome-error:") && d.title !== "probe b" });
  await step(G, "a dedicated worker (page.on worker)", () => onPage(async (p) => {
    const [w] = await Promise.all([p.waitForEvent("worker", { timeout: 10_000 }), p.goto(A + "/worker")]);
    return w.evaluate(() => 6 * 7);
  }), { want: (d) => d === 42 });
  await step(G, "setViewportSize (Emulation)", async () => { await page.setViewportSize({ width: 900, height: 700 }); return page.evaluate(() => [innerWidth, innerHeight]); },
    { want: (d) => d[0] === 900 && d[1] === 700 });
  await step(G, "page.goto an off-list host (DNR)", () => onPage(async (p) => { await p.goto(B + "/"); return p.url(); }), { refused: BLOCKED });
  await step(G, "after a blocked goto, the same page goes on", () => onPage(async (p) => {
    await p.goto(B + "/").catch(() => {});
    await p.waitForURL(/^chrome-error:/, { timeout: 3000 }).catch(() => {});
    await p.goto(A + "/m");
    return p.title();
  }), { want: (d) => d === "probe m" });
  await step(G, "an off-list link click stays blocked (DNR)", () => onPage(async (p) => {
    await p.goto(A + "/");
    await p.locator("#off").click();
    await p.waitForTimeout(1000);
    return { url: p.url(), title: await p.title() };
  }), { want: (d) => d.url.startsWith("chrome-error:") && d.title !== "probe b" });
  await step(G, "page.route fulfill of an off-list document", () => onPage(async (p) => {
    await p.route(B + "/**", (r: any) => r.fulfill({ body: "<title>fulfilled</title>", contentType: "text/html" }));
    await p.goto(B + "/x");
    return p.title();
  }), { refused: BLOCKED });
  await step(G, "an off-list frame in a page that is not on the list (setContent)", () => onPage(async (p) => {
    await p.setContent(`<iframe id="f" src="http://c.localhost:8781/frame"></iframe>`);
    // Blocked, not slow: the same frame in an allowlisted page loads in well under a second here; this waits 5 s.
    for (let i = 0; i < 25; i++) {
      const f = p.frames().find((x: any) => x.url().includes("c.localhost"));
      if (f && (await f.locator("#fbtn").count().catch(() => 0))) return true;
      await p.waitForTimeout(200);
    }
    return false;
  }), { want: (d) => d === false });
  await step(G, "Page.navigate to a data: URL with an off-list frame", () => onPage(async (p) => {
    await p.goto(`data:text/html,<iframe src="http://c.localhost:8781/frame"></iframe>`).catch(() => {});
    await p.waitForTimeout(1000);
    return { url: p.url().slice(0, 20), frame: p.frames().some((x: any) => x.url().includes("c.localhost")) };
  }), { want: (d) => d.url === "about:blank" && !d.frame });
  const permission = (name: string) => onPage(async (p) => { await p.goto(A + "/geo"); return p.evaluate(async (n: any) => (await navigator.permissions.query({ name: n })).state, name); });
  await step(G, "grantPermissions geolocation for one origin", async () => { await context.grantPermissions(["geolocation"], { origin: A }); return permission("geolocation"); }, { want: (d) => d === "granted" });
  await step(G, "grantPermissions clipboard-read with no origin (the allowlisted domains)", async () => { await context.grantPermissions(["clipboard-read"]); return permission("clipboard-read"); },
    { want: (d) => d === "granted" });
  await step(G, "grantPermissions midi is refused", () => context.grantPermissions(["midi"], { origin: A }), { refused: /Not available in the agent browser: the permission midi/ });
  await step(G, "clearPermissions", async () => { await context.clearPermissions(); return permission("geolocation"); }, { want: (d) => d === "prompt" });
  await step(G, "newCDPSession on a page", async () => { const s = await context.newCDPSession(page); const r = await s.send("Runtime.evaluate", { expression: "6*7", returnByValue: true }); await s.detach(); return r.result.value; },
    { want: (d) => d === 42 });
  await step(G, "tracing with screenshots and no snapshots", async () => {
    await context.tracing.start({ screenshots: true, snapshots: false });
    await page.goto(A + "/m");
    await context.tracing.stop({ path: join(RUN, "trace.zip") });
    return statSync(join(RUN, "trace.zip")).size;
  }, { want: (d) => d > 1000 });
  await step(G, "page.pdf", async () => (await page.pdf()).length, { want: (d) => d > 1000 });
  await step(G, "browser.newContext is refused", () => browser.newContext(), { refused: new RegExp(escape(TEXT.newContext)) });
  await step(G, "browser.newBrowserCDPSession: Browser.getVersion", async () => (await (await browser.newBrowserCDPSession()).send("Browser.getVersion")).product, { want: (d) => /^Chrome\/\d/.test(d) });
  await step(G, "context.serviceWorkers() is empty", async () => context.serviceWorkers().length, { want: (d) => d === 0 });
  // No cookies by default (board ab-8mf): each of these reads or sets the context's cookies.
  await step(G, "context.cookies() is refused", () => context.cookies(A), { refused: COOKIES });
  await step(G, "context.addCookies() is refused", () => context.addCookies([{ name: "pw", value: "1", domain: "a.localhost", path: "/" }]), { refused: COOKIES });
  await step(G, "context.clearCookies() is refused", () => context.clearCookies(), { refused: COOKIES });
  await step(G, "context.storageState() is refused", () => context.storageState(), { refused: COOKIES });
  await step(G, "context.request (reads the cookies first) is refused", () => context.request.get(A + "/m"), { refused: COOKIES });
  // The operator's condition for dropping the timer flags (ab-vsm Q4): a client drives a page that is not in front.
  // On Linux each page has a window of its own (ab-v16.28): the other page's window has the focus, the page's input
  // brings its own window forward, and page.bringToFront (Page.bringToFront) focuses it too. Playwright's focus
  // emulation never reaches Chrome, so document.hasFocus() is the real focus.
  await step(G, "Playwright drives a page whose window is behind another one: its input and bringToFront focus its window", async () => {
    await page.goto(A + "/");
    const front = await context.newPage();
    await front.goto(A + "/m");
    const tabOf = async (p: any) => { const id = (await (await context.newCDPSession(p)).send("Target.getTargetInfo")).targetInfo.targetId; return (await daemon!.ask("debugger.getTargets")).find((t: any) => t.id === id)?.tabId; };
    const winOf = async (p: any) => (await daemon!.ask("tabs.get", [await tabOf(p)])).windowId as number;
    const focused = async (w: number) => (await daemon!.ask("windows.get", [w])).focused as boolean;
    const [mine, other] = [await winOf(page), await winOf(front)];
    await daemon!.ask("windows.update", [other, { focused: true }]);
    await sleep(300);
    const before = { mine: await focused(mine), other: await focused(other), visible: await page.evaluate(() => document.visibilityState), hasFocus: await page.evaluate(() => document.hasFocus()) };
    await page.locator("#name").fill("Back");
    await page.locator("#go").click();
    const driven = await page.locator("#out").textContent();
    const after = { mine: await focused(mine), other: await focused(other), hasFocus: await page.evaluate(() => document.hasFocus()), otherHasFocus: await front.evaluate(() => document.hasFocus()) };
    await daemon!.ask("windows.update", [other, { focused: true }]);
    await sleep(300);
    await page.bringToFront();
    await sleep(300);
    const brought = await focused(mine);
    await front.close();
    return { separate: mine !== other, before, driven, after, brought };
  }, { want: (d) => d.separate && !d.before.mine && d.before.other && d.before.visible === "visible" && !d.before.hasFocus && d.driven === "Hello, Back" &&
    d.after.mine && !d.after.other && d.after.hasFocus && !d.after.otherHasFocus && d.brought });
  await step(G, "round trip: 20 x page.evaluate", async () => { const s = Date.now(); for (let i = 0; i < 20; i++) await page.evaluate(() => 1); return Math.round((Date.now() - s) / 20); },
    { want: (d) => d < 50 });
  await step(G, "page.close", async () => { await page.close(); return context.pages().length; }, { want: (d) => d === 0 });
  await step(G, "browser.close (ends Playwright's connection only)", () => browser.close());
}

function escape(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// ---------------------------------------------------------------- the tab switch with a raw CDP client (ab-vsm Q4)

/** A raw CDP client on the endpoint: no Playwright, so no focus emulation and no setup calls of its own. */
async function rawClient(WebSocket: any, scope: string) {
  const ws = new WebSocket(url(scope));
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let next = 1;
  const waits = new Map<number, (m: any) => void>(), events: any[] = [];
  ws.on("message", (raw: Buffer) => { const m = JSON.parse(String(raw)); if (m.id === undefined) events.push(m); else { waits.get(m.id)?.(m); waits.delete(m.id); } });
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((resolve, reject) => {
    const id = next++;
    waits.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const value = async (s: string, expression: string) => (await send("Runtime.evaluate", { expression, returnByValue: true }, s)).result.value;
  const event = async (method: string, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) { const i = events.findIndex((e) => e.method === method); if (i >= 0) return events.splice(i, 1)[0]; }
    throw new Error(`no ${method} in ${ms} ms`);
  };
  return { send, value, event, close: () => ws.close() };
}

async function tabSwitchCase(WebSocket: any) {
  const G = "tab switch (ab-vsm Q4)";
  // On Linux (ab-v16.28) each page has a window of its own, so a page that is not in front is a window behind another
  // one: it is visible (--disable-backgrounding-occluded-windows) and gets the focus with its input. The client can
  // switch tabs in a window itself (Target.activateTarget, the operator's condition: a client can swap tabs). A tab
  // that a popup tab hides in its window gets a tab switch before its input, as a person does; no tab moves to
  // another window.
  await step(G, "a raw client drives a page whose window is behind another one, switches tabs, and drives a page that a popup tab hides (the relay's tab switch)", async () => {
    const c = await rawClient(WebSocket, "switch");
    const open = async (u: string) => {
      const { targetId } = await c.send("Target.createTarget", { url: u });
      const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
      for (let i = 0; i < 50 && (await c.value(sessionId, "document.readyState + location.href")) !== `complete${u}`; i++) await sleep(100);
      return { targetId, sessionId };
    };
    const state = (s: string) => c.value(s, "[document.visibilityState, document.hasFocus()].join(' ')");
    const windowOf = async (targetId: string) => (await daemon!.ask("tabs.get", [(await daemon!.ask("debugger.getTargets")).find((t: any) => t.id === targetId).tabId])).windowId;
    const behind = await open(A + "/"), front = await open(A + "/m");
    const [wb, wf] = [await windowOf(behind.targetId), await windowOf(front.targetId)];
    await daemon!.ask("windows.update", [wf, { focused: true }]);
    await sleep(300);
    const before = { behind: await state(behind.sessionId), front: await state(front.sessionId) };
    // CDP input to the page behind: type a name and click the button at its place.
    await c.value(behind.sessionId, "document.getElementById('name').value = ''; document.getElementById('name').focus()");
    await c.send("Input.insertText", { text: "Behind" }, behind.sessionId);
    const box = async (id: string) => c.value(behind.sessionId, `(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    const click = async (at: number[]) => { for (const type of ["mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, x: at[0], y: at[1], button: "left", clickCount: 1 }, behind.sessionId); };
    await click(await box("go"));
    const driven = await c.value(behind.sessionId, "document.getElementById('out').textContent");
    await sleep(300);
    const after = { behind: await state(behind.sessionId), front: await state(front.sessionId) };
    // window.open with no features: a popup tab in front in the opener's window; the opener is hidden behind it.
    await click(await box("winopen"));
    await sleep(800);
    const popup = (await c.send("Target.getTargets")).targetInfos.find((t: any) => t.url.includes("/popup?via=open"));
    const hidden = await state(behind.sessionId);
    // The client's own tab switch (Target.activateTarget selects a tab in its window), to the opener and back.
    let clientSwitch: Record<string, string> = {};
    if (popup) {
      await c.send("Target.activateTarget", { targetId: behind.targetId });
      await sleep(300);
      clientSwitch.toOpener = await state(behind.sessionId);
      await c.send("Target.activateTarget", { targetId: popup.targetId });
      await sleep(300);
      clientSwitch.toPopup = await state(behind.sessionId);
    }
    // The click left the focus on the button: the field gets it back first (a script's focus, in the hidden page).
    await c.value(behind.sessionId, "document.getElementById('name').focus()");
    await c.send("Input.insertText", { text: "!" }, behind.sessionId);
    await sleep(300);
    const back = { opener: await state(behind.sessionId), name: await c.value(behind.sessionId, "document.getElementById('name').value"),
      popupWindow: popup ? await windowOf(popup.targetId) : null };
    for (const t of (await c.send("Target.getTargets")).targetInfos) await c.send("Target.closeTarget", { targetId: t.targetId });
    c.close();
    return { separate: wb !== wf, before, driven, after, popup: !!popup, hidden, clientSwitch, back, openerWindow: wb };
  }, { want: (d) => d.separate && d.before.behind === "visible false" && d.before.front === "visible true" && d.driven === "Hello, Behind" &&
    d.after.behind === "visible true" && d.after.front === "visible false" && d.popup && d.hidden.startsWith("hidden") &&
    d.clientSwitch.toOpener === "visible true" && d.clientSwitch.toPopup.startsWith("hidden") &&
    d.back.opener === "visible true" && d.back.name === "Behind!" && d.back.popupWindow === d.openerWindow });
}

// ---------------------------------------------------------------- Target.createTarget with a URL (C10: about:blank, then the URL)

async function createWithUrlCases(WebSocket: any) {
  const G = "createTarget with a URL";
  // What the client sees, against a direct create of Chrome: the same page, no referrer, the URL in Target.getTargets.
  // Two differences (C10 opens the tab at about:blank): Target.attachedToTarget names about:blank, where the tab is at
  // the attach, and history.length is 2, because the about:blank entry stays (a direct create gives 1; measured).
  await step(G, "a raw client's Target.createTarget({url}) opens that page (with the about:blank entry in its history)", async () => {
    const c = await rawClient(WebSocket, "rawurl");
    await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const want = `${A}/m?direct`;
    const { targetId } = await c.send("Target.createTarget", { url: want });
    const { params } = await c.event("Target.attachedToTarget");
    let at = "";
    for (let i = 0; i < 50 && (at = await c.value(params.sessionId, "document.readyState + ' ' + location.href")) !== `complete ${want}`; i++) await sleep(100);
    const page = await c.value(params.sessionId, "({ history: history.length, referrer: document.referrer })");
    const listed = (await c.send("Target.getTargets")).targetInfos.find((t: any) => t.targetId === targetId)?.url;
    await c.send("Target.closeTarget", { targetId });
    c.close();
    return { at, ...page, listed, attachedUrl: params.targetInfo.url };
  }, { want: (d) => d.at === `complete ${A}/m?direct` && d.history === 2 && d.referrer === "" && d.listed === `${A}/m?direct` && d.attachedUrl === "about:blank" });
  await step(G, "its first request reaches the client's Fetch interception (the hold)", async () => {
    const c = await rawClient(WebSocket, "rawhold");
    await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const created = c.send("Target.createTarget", { url: A + "/m?first" });
    const { params } = await c.event("Target.attachedToTarget");
    await c.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, params.sessionId);
    await c.send("Runtime.runIfWaitingForDebugger", {}, params.sessionId);
    const paused = await c.event("Fetch.requestPaused").catch(() => null);
    if (paused) await c.send("Fetch.continueRequest", { requestId: paused.params.requestId }, params.sessionId);
    await c.send("Target.closeTarget", { targetId: (await created).targetId });
    c.close();
    return { waiting: params.waitingForDebugger, first: paused?.params.request.url ?? null };
  }, { want: (d) => d.waiting === true && d.first === `${A}/m?first` });
}

// ---------------------------------------------------------------- the refused page marks (board ab-jzg Q3)

// Playwright keeps a refused feature in its context, so each runs on a connection of its own, and each case also
// records what a later page of that connection does (C11: a later page fails too).
async function refusedFeatureCases(pw: any) {
  const G = "page marks", MAIN_WORLD = /Not available in the agent browser: (init scripts|bindings) in the page's main world/;
  // later: what a new page of that connection does after the refusal (measured with Playwright 1.64.1): it works with
  // no mark, or it fails with the binding refusal (Playwright sends Runtime.addBinding again for each new page).
  const cases: [string, (ctx: any, p: any) => Promise<unknown>, "works" | "fails"][] = [
    ["context.addInitScript", (ctx) => ctx.addInitScript(() => { (window as any).__probeInit = 1; }), "works"],
    ["context.exposeFunction", (ctx) => ctx.exposeFunction("__probeExposed", (x: number) => x * 2), "fails"],
    ["page.exposeFunction", (_ctx, p) => p.exposeFunction("__probePageExposed", (x: number) => x * 2), "fails"],
    ["tracing with snapshots", (ctx) => ctx.tracing.start({ snapshots: true }), "works"],
    ["page.clock.install", (_ctx, p) => p.clock.install(), "works"],
  ];
  const marks = () => Object.keys(window).filter((k) => k.startsWith("__playwright") || k.startsWith("__probe"));
  for (const [i, [name, use, later]] of cases.entries()) {
    const browser = await pw.chromium.connectOverCDP(url(`marks${i}`), { timeout: 20_000 });
    const ctx = browser.contexts()[0], p = await ctx.newPage();
    await p.goto(A + "/m");
    await step(G, `${name} is refused`, () => use(ctx, p), { refused: MAIN_WORLD });
    await step(G, `after ${name}: a new page of that connection ${later === "works" ? "works, with no mark" : "fails too"}`, async () => {
      let q: any;
      try { q = await ctx.newPage(); } catch (e) { return { page: "fails", error: (e as Error).message.split("\n")[0] }; }
      await q.goto(A + "/m");
      return { page: "works", title: await q.title(), marks: await q.evaluate(marks), oldPageMarks: await p.evaluate(marks) };
    }, { want: (d) => later === "works" ? d.page === "works" && d.title === "probe m" && d.marks.length === 0 && d.oldPageMarks.length === 0
      : d.page === "fails" && MAIN_WORLD.test(d.error) });
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- the probe's MCP and concurrency scripts

async function probeScript(group: string, script: string, vars: Record<string, string>, expect: (r: any) => { refused?: RegExp }) {
  const out = vars.OUT;
  const child = start(process.execPath, [join(PROBE, script)], { env: { ...process.env, PW_DIR: INSTALL, ...vars }, log: `${group}.log` });
  const code = await new Promise<number | null>((r) => child.once("exit", r));
  if (!existsSync(out)) { record({ group, case: `${script} ran`, status: "fail", ms: 0, error: `exit ${code}; see ${RUN}/logs/${group}.log` }); return; }
  for (const r of JSON.parse(readFileSync(out, "utf8")).results) {
    const e = expect(r), name = r.case ?? r.tool;
    const ok = e.refused ? !r.ok && e.refused.test(r.error ?? "") : r.ok;
    record({ group, case: name, status: ok ? "pass" : "fail", ms: r.ms, ...(r.error ? { error: r.error } : { detail: r.detail ?? r.saw }) });
  }
}

// ---------------------------------------------------------------- agent-browser's own commands over the endpoint

async function agentBrowserCases() {
  const G = "agent-browser --cdp-url", state = join(RUN, "ab-state"), allow = join(RUN, "allow.json");
  writeFileSync(allow, JSON.stringify({ allow: ["a.localhost"] }));
  // Not execFileSync: the stand-in daemon runs in this process, and a blocked event loop would hold every bridge message.
  const cli = (...args: string[]) => new Promise<any>((resolve) => {
    execFile(process.execPath, [RELAY_BIN, ...args, "--cdp-url", url("ab-cli"), "--state-dir", state, "--allowlist", allow, "--no-launch", "--json"], { encoding: "utf8" }, (e, stdout) => {
      try { resolve(JSON.parse(stdout)); } catch { resolve({ ok: false, error: { message: e?.message ?? "no output" } }); }
    });
  });
  const run = (name: string, args: string[], want: (r: any) => boolean) => step(G, name, async () => cli(...args), { want: (r) => r.ok !== false && want(r) });
  await run("open", ["open", A + "/", "--name", "main"], (r) => r.tab.name === "main");
  await run("text", ["text", "main"], (r) => r.text.includes("Greet"));
  await run("eval", ["eval", "main", "document.title"], (r) => r.value === "probe a");
  await run("outline", ["outline", "main"], (r) => r.elements.some((e: any) => e.label === "Greet"));
  await run("shot", ["shot", "main", join(RUN, "ab-shot.png")], () => statSync(join(RUN, "ab-shot.png")).size > 1000);
  // On Linux a page in a window of its own gets a person's input (ab-v16.26): the window comes forward, a path, a press, keys.
  await run("type --into (a click on the field, then keys)", ["type", "main", "Lin", "--into", "#name"], (r) => r.length === 3);
  await run("click (a path and a press)", ["click", "main", "#go"], () => true);
  await run("the click and the keys arrived", ["eval", "main", "document.getElementById('out').textContent"], (r) => r.value === "Hello, Lin");
  await run("tabs", ["tabs"], (r) => r.tabs.length === 1);
  await run("status", ["status"], (r) => r.connected === true && r.proxy === null);
  await run("close", ["close", "main"], (r) => r.ok === true);
  await step(G, "quit refuses: agentwatch owns the agent browser", async () => cli("quit"), { want: (r) => r.ok === false && r.error.code === "usage" });
  await step(G, "no proxy socket in the state folder", async () => existsSync(join(state, "chrome-proxy.sock")), { want: (d) => d === false });
}

// ---------------------------------------------------------------- one window per page, on the anti-detect probe's page (ab-v16.28)

type StepFn = (label: string, fn: () => Promise<unknown>, want?: (v: any) => boolean) => Promise<void>;

/** The times in [from, to] in which a page had the focus, from its own focus and blur events (a page whose first event
 *  there is a blur had the focus from `from`; one whose last event is a focus keeps it to `to`). */
function focusSpans(log: Rec[], tab: string, from: number, to: number): [number, number][] {
  const evs = log.filter((e) => e.tab === tab && e.t >= from && e.t <= to && (e.ev === "focus" || e.ev === "blur")).sort((x, y) => x.t - y.t);
  const out: [number, number][] = [];
  let start: number | null = evs[0]?.ev === "blur" ? from : null;
  for (const e of evs) {
    if (e.ev === "focus" && start === null) start = e.t;
    else if (e.ev === "blur" && start !== null) { out.push([start, e.t]); start = null; }
  }
  if (start !== null) out.push([start, to]);
  return out;
}

/** Each time in [from, to] in which pages a and b both had the focus, in ms, measured from their focus and blur events
 *  (the 100 ms samples of bothFocusedMs count a short overlap at a switch as 100 ms or nothing). */
function focusOverlaps(log: Rec[], a: string, b: string, from: number, to: number): number[] {
  const sa = focusSpans(log, a, from, to), sb = focusSpans(log, b, from, to);
  return sa.flatMap(([a0, a1]) => sb.map(([b0, b1]) => Math.min(a1, b1) - Math.max(a0, b0)).filter((ms) => ms > 0));
}

/**
 * The anti-detect design over the relay (docs/research/2026-11-05-anti-detect-drive.md, "The answer" steps 1, 2 and
 * 5, sections 6 and 8; board task ab-v16.28). Playwright with and without noDefaults, and the Playwright MCP, drive
 * the probe's page T in a window of its own, while the probe's page F has the focused window in front of it (the
 * operator's, or another agent's). Before some steps F's window takes the focus again, so the relay must bring T's
 * window forward again. Each step must pass, and T must show no background-tab signal: "visible" all the time, about
 * 60 frames a second after each step, no action while it is hidden or not focused, no untrusted event. For the whole
 * drive: F and T have the focus at the same time only for less than 100 ms at each switch (measured from their focus
 * and blur events: the new page's focus comes a few ms before the old page's blur), F gets a blur, and no
 * Emulation.setFocusEmulationEnabled reaches Chrome. The other signals (the press time, the pointer path, the
 * typing, the geometry) are in <RUN>/windows.json for the report: they still differ from a person's.
 */
async function windowCases(pw: any) {
  const G = "one window per page";
  const log: Rec[] = [];
  const { server, port } = await startServer(log);
  const P = `http://probe.a.localhost:${port}`;
  const pageUrl = (tab: string) => `${P}/p?tab=${tab}`;
  const loaded = async (tab: string) => {
    for (const end = Date.now() + 15_000; Date.now() < end; await sleep(100)) if (log.some((e) => e.tab === tab && e.ev === "load")) return;
    throw new Error(`page ${tab} did not load`);
  };
  const tabIdOf = async (tab: string) => (await daemon!.ask("debugger.getTargets")).find((t: any) => String(t.url).includes(`tab=${tab}`))?.tabId as number | undefined;
  const out: any[] = [];
  let n = 0;
  const variant = async (name: string, drive: (T: string, front: () => Promise<void>, stepOf: StepFn) => Promise<void>) => {
    n++;
    const F = `F${n}`, T = `T${n}`, from = daemon!.log.length, t0 = Date.now();
    const fw = (await daemon!.ask("windows.create", [{ url: pageUrl(F), focused: true }])).id;
    await loaded(F);
    // The operator (or another agent) has the focus in F's window, in front of T's.
    const front = async () => { await daemon!.ask("windows.update", [fw, { focused: true }]); await sleep(500); };
    const steps: any[] = [];
    const stepOf: StepFn = async (label, fn, want) => {
      await sleep(400);
      const s0 = Date.now();
      let error: string | undefined, value: unknown, timer: NodeJS.Timeout | undefined;
      try { value = await Promise.race([fn(), new Promise((_, j) => { timer = setTimeout(() => j(new Error("no end in 20 s")), 20_000); })]); }
      catch (e) { error = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300); }
      finally { clearTimeout(timer); }
      const s1 = Date.now();
      await sleep(1600); // the frames in the second after the step
      const sig = stepSignals(log, T, s0, s1);
      const background = [sig.visBefore !== "visible" && "visBefore", sig.visChanges.length && "visChanges", sig.inputHidden && "inputHidden",
        sig.inputUnfocused && "inputUnfocused", sig.untrusted && "untrusted", sig.framesAfter < 30 && "framesAfter"].filter(Boolean);
      const ok = !error && !background.length && (!want || want(value));
      steps.push({ label, ok, ms: s1 - s0, ...(error ? { error } : {}), ...(background.length ? { background } : {}), ...rates(log, T, s0, s1), ...sig });
      const shown = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value).slice(0, 80) : undefined;
      record({ group: G, case: `${name}: ${label}`, status: ok ? "pass" : "fail", ms: s1 - s0, ...(error ? { error } : {}),
        detail: { ...(shown !== undefined ? { value: shown } : {}), vis: sig.visBefore, focus: sig.focusEvents, focusAfter: sig.focusAfter, framesAfter: sig.framesAfter, input: sig.inputSeq.slice(0, 120), background },
        ...(!ok && !error ? { why: background.length ? `background-tab signal: ${background.join(", ")}` : "value not as expected" } : {}) });
    };
    let t1 = Date.now();
    try { await drive(T, front, stepOf); t1 = Date.now(); }
    finally {
      for (const tab of [T, F]) { const id = await tabIdOf(tab); if (id !== undefined) await daemon!.ask("tabs.remove", [id]).catch(() => {}); }
    }
    const sorted = log.slice().sort((x, y) => x.t - y.t);
    const tLoad = log.find((e) => e.tab === T && e.ev === "load");
    const ops = daemon!.log.slice(from);
    const count = (re: RegExp) => ops.filter((l) => / req /.test(l) && re.test(l)).length;
    const v = {
      name, steps,
      hiddenAfterLoad: log.filter((e) => e.tab === T && e.ev === "visibilitychange" && e.vis === "hidden" && e.t <= t1).length,
      bothFocusedMs: bothFocusedMs(sorted, F, T, t0, t1),
      overlaps: focusOverlaps(log, F, T, t0, t1),
      fEvents: log.filter((e) => e.tab === F && e.t >= t0 && e.t <= t1 && ["visibilitychange", "focus", "blur"].includes(e.ev)).map((e) => `${e.ev}${e.ev === "visibilitychange" ? `:${e.vis}` : ""}@${e.t - t0}`),
      tFocus: log.filter((e) => e.tab === T && e.t >= t0 && e.t <= t1 && (e.ev === "focus" || e.ev === "blur")).map((e) => `${e.ev}@${e.t - t0}`),
      geometry: tLoad && { iw: tLoad.iw, ih: tLoad.ih, ow: tLoad.ow, oh: tLoad.oh, sx: tLoad.sx, sy: tLoad.sy, historyLength: tLoad.hl, webdriver: tLoad.webdriver },
      bridge: { focusEmulation: count(/Emulation\.setFocusEmulationEnabled/), windowsCreate: count(/ windows\.create$/), windowsUpdate: count(/ windows\.update$/),
        tabsCreate: count(/ tabs\.create$/), tabsUpdate: count(/ tabs\.update$/) },
    };
    out.push(v);
    // At each window switch the new page's focus comes a few ms before the old page's blur: each such overlap is short.
    const ok = v.hiddenAfterLoad === 0 && v.overlaps.every((ms) => ms < 100) && v.fEvents.some((e) => e.startsWith("blur")) && v.bridge.focusEmulation === 0 && v.bridge.windowsCreate >= 1 && v.bridge.tabsCreate === 0;
    record({ group: G, case: `${name}: T never hidden, F and T both focused only for less than 100 ms at a switch, no focus emulation in Chrome, a window per page`,
      status: ok ? "pass" : "fail", ms: t1 - t0, detail: { hiddenAfterLoad: v.hiddenAfterLoad, overlaps: v.overlaps, bothFocusedMs: v.bothFocusedMs, fEvents: v.fEvents, tFocus: v.tFocus, bridge: v.bridge } });
  };

  // Playwright: connectOverCDP with its defaults (it sends focus emulation, which the relay answers) and with noDefaults.
  const playwright = (noDefaults: boolean) => async (T: string, front: () => Promise<void>, stepOf: StepFn) => {
    const browser = await pw.chromium.connectOverCDP(url(noDefaults ? "win-nodefaults" : "win-pw"), { noDefaults, timeout: 20_000 });
    try {
      const page = await browser.contexts()[0].newPage();
      await page.goto(pageUrl(T));
      await loaded(T);
      await front();
      const t = { timeout: 8000 };
      await stepOf("idle before", () => sleep(3000));
      await stepOf("textContent", () => page.textContent("#s", t), (v) => v === "clicks: 0");
      await stepOf("click", async () => { await page.click("#b", t); return page.textContent("#s", t); }, (v) => v === "clicks: 1");
      await front();
      await stepOf("fill", async () => { await page.fill("#f", "hello", t); return page.inputValue("#f", t); }, (v) => v === "hello");
      // Playwright puts the caret at the start of an input that does not have the focus before it types (its injected
      // focusNode, resetSelectionIfNotFocused; document.hasFocus() is false while another window has the focus). The
      // relay brings the window forward before that focus call, so the caret stays at the end.
      await front();
      await stepOf("pressSequentially after another window took the focus: the caret stays at the end", async () => {
        await page.locator("#f").pressSequentially(" world", t);
        return page.inputValue("#f", t);
      }, (v) => v === "hello world");
      // A person's way: a click on the field (the caret where the click puts it, after the text), then the keys.
      await front();
      await stepOf("click the field, then pressSequentially", async () => {
        await page.click("#f", t);
        await page.locator("#f").pressSequentially("!", t);
        return page.inputValue("#f", t);
      }, (v) => v === "hello world!");
      await stepOf("click, waitForFunction a frame's content", async () => {
        await page.click("#r", t);
        await page.waitForFunction(() => document.getElementById("rd")!.textContent === "frames: 1", undefined, { timeout: 5000 });
      });
      await stepOf("click below the fold", () => page.click("#far", t));
      await front();
      await stepOf("keyboard.press End", () => page.keyboard.press("End"));
      await stepOf("screenshot", async () => (await page.screenshot(t)).length, (v) => v > 1000);
      await stepOf("idle after", () => sleep(3000));
    } finally { await browser.close().catch(() => {}); }
  };

  // The Playwright MCP (it connects with noDefaults), as an MCP client over its standard input and output.
  const mcp = async (T: string, front: () => Promise<void>, stepOf: StepFn) => {
    const child = start(process.execPath, [join(INSTALL, "node_modules/@playwright/mcp/cli.js"), "--output-dir", join(RUN, "mcp-out")],
      { env: { ...process.env, PLAYWRIGHT_MCP_CDP_ENDPOINT: url("win-mcp") }, log: "mcp-windows.log", pipe: true });
    let buf = "", next = 1;
    const waiting = new Map<number, (m: any) => void>();
    child.stdout!.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0;) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); }
    });
    const rpc = (method: string, params: object) => new Promise<any>((resolve) => { const id = next++; waiting.set(id, resolve); child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
    const text = (r: any) => (r.result?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    try {
      await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ab-v16.28-live", version: "0" } });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const tools = (await rpc("tools/list", {})).result.tools as any[];
      // The element reference is "target" in @playwright/mcp 0.0.84 ("ref" in some other versions).
      const refKey = "target" in (tools.find((x) => x.name === "browser_click")?.inputSchema?.properties ?? {}) ? "target" : "ref";
      const call = async (name: string, args: object) => {
        const r = await rpc("tools/call", { name, arguments: args });
        if (r.error || r.result?.isError) throw new Error(`${name}: ${r.error?.message ?? text(r)}`.split("\n").slice(0, 2).join(" "));
        return r;
      };
      await call("browser_navigate", { url: pageUrl(T) });
      await loaded(T);
      await front();
      await stepOf("idle before", () => sleep(3000));
      let snap = "";
      await stepOf("browser_snapshot", async () => (snap = text(await call("browser_snapshot", {}))), (v) => /button "Click"/.test(v));
      const ref = (re: RegExp) => (re.exec(snap) ?? [])[1];
      const [button, field, frame] = [ref(/button "Click" \[ref=(\w+)\]/), ref(/textbox[^\n]*\[ref=(\w+)\]/), ref(/button "Frame" \[ref=(\w+)\]/)];
      await stepOf("browser_click", async () => { await call("browser_click", { element: "Click button", [refKey]: button }); return text(await call("browser_snapshot", {})); }, (v) => v.includes("clicks: 1"));
      await front();
      await stepOf("browser_type", () => call("browser_type", { element: "text field", [refKey]: field, text: "hello" }));
      await front();
      // As with Playwright's pressSequentially (above): the caret stays at the end of the field.
      await stepOf("browser_type slowly after another window took the focus: the caret stays at the end", async () => {
        await call("browser_type", { element: "text field", [refKey]: field, text: " world", slowly: true });
        return text(await call("browser_evaluate", { function: "() => document.getElementById('f').value" }));
      }, (v) => v.includes('"hello world"'));
      await stepOf("browser_click, browser_wait_for a frame's content", async () => {
        await call("browser_click", { element: "Frame button", [refKey]: frame });
        await call("browser_wait_for", { text: "frames: 1" });
      });
      await front();
      await stepOf("browser_press_key End", () => call("browser_press_key", { key: "End" }));
      await stepOf("browser_take_screenshot", async () => (await call("browser_take_screenshot", {})).result.content.some((c: any) => c.type === "image"), (v) => v === true);
      await stepOf("idle after", () => sleep(3000));
    } finally { await stopChild(child); }
  };

  // Two agents at once (the design's step 6): two Playwright clients, each in its own window, type at the same time.
  // The relay focuses a page's window before each key down, one activation at a time, but it cannot lock a whole
  // action: the measure is how long both pages had the focus and how often the focus went back and forth.
  const twoAtOnce = async () => {
    const tabs = ["TA", "TB"], words = "the quick brown fox jumps over the lazy dog";
    const browsers = await Promise.all(["win-two-a", "win-two-b"].map((scope) => pw.chromium.connectOverCDP(url(scope), { timeout: 20_000 })));
    try {
      const pages = await Promise.all(browsers.map((b: any) => b.contexts()[0].newPage()));
      await Promise.all(pages.map((p: any, i: number) => p.goto(pageUrl(tabs[i]))));
      for (const tab of tabs) await loaded(tab);
      await sleep(1000);
      const s0 = Date.now();
      const values = await Promise.all(pages.map(async (p: any) => { await p.click("#f"); await p.keyboard.type(words); return p.inputValue("#f"); }));
      const s1 = Date.now();
      await sleep(1000);
      const sorted = log.slice().sort((x, y) => x.t - y.t);
      const switches = log.filter((e) => tabs.includes(e.tab) && e.t >= s0 && e.t <= s1 + 200 && (e.ev === "focus" || e.ev === "blur")).length;
      const overlaps = focusOverlaps(log, tabs[0], tabs[1], s0, s1);
      const detail = { ms: s1 - s0, bothFocusedMs: bothFocusedMs(sorted, tabs[0], tabs[1], s0, s1),
        overlaps: { n: overlaps.length, totalMs: overlaps.reduce((x, y) => x + y, 0), longestMs: Math.max(0, ...overlaps) }, focusAndBlurEvents: switches, values,
        hidden: log.filter((e) => tabs.includes(e.tab) && e.ev === "visibilitychange" && e.vis === "hidden" && e.t >= s0 && e.t <= s1).length };
      out.push({ name: "two Playwright clients type at once", ...detail });
      record({ group: G, case: "two Playwright clients type at once, each page in its own window (a measure of the focus)", ms: s1 - s0,
        status: values.every((v: string) => v === words) && detail.hidden === 0 ? "pass" : "fail", detail });
    } finally {
      for (const b of browsers) await b.close().catch(() => {});
      for (const tab of tabs) { const id = await tabIdOf(tab); if (id !== undefined) await daemon!.ask("tabs.remove", [id]).catch(() => {}); }
    }
  };

  try {
    await variant("Playwright (connectOverCDP)", playwright(false));
    await variant("Playwright (connectOverCDP, noDefaults)", playwright(true));
    await variant("the Playwright MCP", mcp);
    await twoAtOnce();
  } finally {
    server.close();
    writeFileSync(join(RUN, "windows.json"), JSON.stringify({ variants: out, log }, null, 2) + "\n");
  }
}
