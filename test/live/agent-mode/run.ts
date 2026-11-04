// The live test of agent mode (board ab-v16.6, part B; the two-modes design, section 12, stage 3). Not part of
// `npm test`. In a private Xvfb it starts a Chromium of its own with chrome-extension's agent package (Linux Chromium
// takes --load-extension), the native host of chrome-extension's live test, a stand-in for the daemon's bridge side
// (daemon.ts) and `agent-browser relay` from a scratch install. Then it runs the probe's Playwright, MCP and
// concurrency cases against the endpoint, with the refusals of contract C11, popups many times, the operator's
// tab-switch condition (ab-vsm Q4: a client switches tabs and drives a tab that is not in front), and agent-browser's
// own commands over the endpoint (--cdp-url).
//
//   CHROME_EXTENSION=<a detached worktree of chrome-extension> npm run test:live:agent
//
// Environment: CHROME_EXTENSION (required: its agent/ and test/live/host.py are used; the agent folder is copied,
// because Chromium writes _metadata/ into the folder that it loads), CHROMIUM (default /usr/bin/chromium),
// DISPLAY_N (default 118), RUN (an empty folder; default a new one in the temp folder), CASES (default all:
// playwright,marks,switch,create,concurrency,mcp,agent-browser) runs some groups only. The agent package must be
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
const CASES = (process.env.CASES ?? "playwright,marks,switch,create,concurrency,mcp,agent-browser").split(",");
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
function start(bin: string, args: string[], opts: { env?: NodeJS.ProcessEnv; log: string }): ChildProcess {
  const fd = openSync(join(RUN, "logs", opts.log), "a");
  const child = spawn(bin, args, { env: opts.env ?? process.env, stdio: ["ignore", fd, fd] });
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

// The scratch install: this checkout as a package, and the clients that the probe used.
const INSTALL = join(RUN, "install");
mkdirSync(INSTALL);
const npm = (args: string[], cwd: string) => execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const tarball = join(RUN, npm(["pack", "--silent", "--pack-destination", RUN], ROOT).split("\n").pop()!);
npm(["init", "-y"], INSTALL);
npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball, "playwright-core@1.64.1", "@playwright/mcp@0.0.84"], INSTALL);
const RELAY_BIN = join(INSTALL, "node_modules/agent-browser/bin/agent-browser.js");

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

let daemon: StandInDaemon | undefined, chromium: ChildProcess | undefined;
try {
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
    "--window-position=0,0", "--window-size=1280,900", "about:blank"],
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
  record({ group: "browser", case: "the agent Chromium still runs after every client left", status: chromium.exitCode === null ? "pass" : "fail", ms: 0 });
} finally {
  const relayExit = daemon ? await daemon.stop() : null;
  if (daemon) record({ group: "relay", case: "the relay ends with its standard input and removes its socket", status: relayExit === 0 && !existsSync(RELAY_SOCK) ? "pass" : "fail", ms: 0, detail: { exit: relayExit } });
  for (const c of children.reverse()) if (c.exitCode === null) c.kill("SIGTERM");
  if (daemon) writeFileSync(join(RUN, "logs/daemon.log"), [...daemon.log, ...daemon.waiting().map((w) => `still waiting: ${w}`)].join("\n") + "\n");
  const count = (s: Result["status"]) => results.filter((r) => r.status === s).length;
  writeFileSync(join(RUN, "results.json"), JSON.stringify({ env, results }, null, 2) + "\n");
  console.log(`\n${results.length} cases: ${count("pass")} pass, ${count("fail")} fail; ${join(RUN, "results.json")}`);
  process.exitCode = count("fail") ? 1 : 0;
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
  await step(G, "page.goto an allowlisted page", async () => { const r = await page.goto(A + "/"); return { status: r.status(), title: await page.title() }; }, { want: (d) => d.status === 200 && d.title === "probe a" });
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
    await p.waitForTimeout(1000);
    const f = p.frames().find((x: any) => x.url().includes("c.localhost"));
    return Boolean(f && (await f.locator("#fbtn").count().catch(() => 0)));
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
  // The operator's condition for dropping the timer flags (ab-vsm Q4): a client drives a tab that is not in front, and
  // switches tabs. Playwright turns focus emulation on, so its pages always report "visible": which tab is in front
  // comes from the receiver (tabs.query), and the raw client's case below reads the page's own visibility.
  await step(G, "Playwright drives a tab that is not in front, then brings it to the front", async () => {
    await page.goto(A + "/");
    const front = await context.newPage();
    await front.goto(A + "/m");
    const activeTab = async () => (await daemon!.ask("tabs.query", [{ active: true }])).map((t: any) => t.id);
    const tabOf = async (p: any) => { const id = (await (await context.newCDPSession(p)).send("Target.getTargetInfo")).targetInfo.targetId; return (await daemon!.ask("debugger.getTargets")).find((t: any) => t.id === id)?.tabId; };
    const [mine, other] = [await tabOf(page), await tabOf(front)];
    const before = await activeTab();
    await page.locator("#name").fill("Back");
    await page.locator("#go").click();
    const driven = await page.locator("#out").textContent();
    await page.bringToFront();
    const after = await activeTab();
    await front.close();
    return { inFrontBefore: before.includes(other) && !before.includes(mine), driven, inFrontAfter: after.includes(mine) };
  }, { want: (d) => d.inFrontBefore && d.driven === "Hello, Back" && d.inFrontAfter });
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
  await step(G, "a raw client drives a tab that is not in front (hidden), then switches tabs (Target.activateTarget)", async () => {
    const c = await rawClient(WebSocket, "switch");
    const open = async (u: string) => {
      const { targetId } = await c.send("Target.createTarget", { url: u });
      const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
      for (let i = 0; i < 50 && (await c.value(sessionId, "document.readyState + location.href")) !== `complete${u}`; i++) await sleep(100);
      return { targetId, sessionId };
    };
    const behind = await open(A + "/"), front = await open(A + "/m");
    const before = { behind: await c.value(behind.sessionId, "document.visibilityState"), front: await c.value(front.sessionId, "document.visibilityState") };
    // CDP input to the hidden tab: type a name and click the button at its place.
    await c.value(behind.sessionId, "document.getElementById('name').value = ''; document.getElementById('name').focus()");
    await c.send("Input.insertText", { text: "Hidden" }, behind.sessionId);
    const box = await c.value(behind.sessionId, "(() => { const r = document.getElementById('go').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()");
    for (const type of ["mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, x: box[0], y: box[1], button: "left", clickCount: 1 }, behind.sessionId);
    const driven = await c.value(behind.sessionId, "document.getElementById('out').textContent");
    await c.send("Target.activateTarget", { targetId: behind.targetId });
    await sleep(500);
    const after = { behind: await c.value(behind.sessionId, "document.visibilityState"), front: await c.value(front.sessionId, "document.visibilityState") };
    for (const t of [behind, front]) await c.send("Target.closeTarget", { targetId: t.targetId });
    c.close();
    return { before, driven, after };
  }, { want: (d) => d.before.behind === "hidden" && d.before.front === "visible" && d.driven === "Hello, Hidden" && d.after.behind === "visible" && d.after.front === "hidden" });
}

// ---------------------------------------------------------------- Target.createTarget with a URL (C10: about:blank, then the URL)

async function createWithUrlCases(WebSocket: any) {
  const G = "createTarget with a URL";
  await step(G, "a raw client's Target.createTarget({url}) opens that page", async () => {
    const c = await rawClient(WebSocket, "rawurl");
    await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const { targetId } = await c.send("Target.createTarget", { url: A + "/m?direct" });
    const { params } = await c.event("Target.attachedToTarget");
    let at = "";
    for (let i = 0; i < 50 && (at = await c.value(params.sessionId, "document.readyState + ' ' + location.href")) !== `complete ${A}/m?direct`; i++) await sleep(100);
    await c.send("Target.closeTarget", { targetId });
    c.close();
    return at;
  }, { want: (d) => d === `complete ${A}/m?direct` });
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
  const cases: [string, (ctx: any, p: any) => Promise<unknown>][] = [
    ["context.addInitScript", (ctx) => ctx.addInitScript(() => { (window as any).__probeInit = 1; })],
    ["context.exposeFunction", (ctx) => ctx.exposeFunction("__probeExposed", (x: number) => x * 2)],
    ["page.exposeFunction", (_ctx, p) => p.exposeFunction("__probePageExposed", (x: number) => x * 2)],
    ["tracing with snapshots", (ctx) => ctx.tracing.start({ snapshots: true })],
    ["page.clock.install", (_ctx, p) => p.clock.install()],
  ];
  for (const [i, [name, use]] of cases.entries()) {
    const browser = await pw.chromium.connectOverCDP(url(`marks${i}`), { timeout: 20_000 });
    const ctx = browser.contexts()[0], p = await ctx.newPage();
    await p.goto(A + "/m");
    await step(G, `${name} is refused`, () => use(ctx, p), { refused: MAIN_WORLD });
    await step(G, `after ${name}: a new page of that connection`, async () => {
      const q = await ctx.newPage().then((x: any) => x.goto(A + "/m").then(() => "works"), (e: Error) => e.message.split("\n")[0]);
      return { page: q, globals: await p.evaluate(() => Object.keys(window).filter((k) => k.startsWith("__playwright") || k.startsWith("__probe"))) };
    }, { want: (d) => d.globals.length === 0 });
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
    execFile(process.execPath, [RELAY_BIN, ...args, "--cdp-url", url("ab-cli"), "--state-dir", state, "--allowlist", allow, "--json"], { encoding: "utf8" }, (e, stdout) => {
      try { resolve(JSON.parse(stdout)); } catch { resolve({ ok: false, error: { message: e?.message ?? "no output" } }); }
    });
  });
  const run = (name: string, args: string[], want: (r: any) => boolean) => step(G, name, async () => cli(...args), { want: (r) => r.ok !== false && want(r) });
  await run("open", ["open", A + "/", "--name", "main"], (r) => r.tab.name === "main");
  await run("text", ["text", "main"], (r) => r.text.includes("Greet"));
  await run("eval", ["eval", "main", "document.title"], (r) => r.value === "probe a");
  await run("outline", ["outline", "main"], (r) => r.elements.some((e: any) => e.label === "Greet"));
  await run("shot", ["shot", "main", join(RUN, "ab-shot.png")], () => statSync(join(RUN, "ab-shot.png")).size > 1000);
  await run("tabs", ["tabs"], (r) => r.tabs.length === 1);
  await run("status", ["status"], (r) => r.connected === true && r.proxy === null);
  await run("close", ["close", "main"], (r) => r.ok === true);
  await step(G, "quit refuses: agentwatch owns the agent browser", async () => cli("quit"), { want: (r) => r.ok === false && r.error.code === "usage" });
  await step(G, "no proxy socket in the state folder", async () => existsSync(join(state, "chrome-proxy.sock")), { want: (d) => d === false });
}
