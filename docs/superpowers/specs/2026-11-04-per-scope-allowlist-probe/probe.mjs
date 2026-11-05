// The per-scope allowlist probe's driver. It starts its own Xvfb (a private display with an auth
// file), the test sites (site.py) and its own Chromium (a throwaway profile, the probe extension
// ext/ loaded unpacked), runs the cases, writes results/<case>.json and stops what it started.
//
//   node probe.mjs [case ...]       cases: limits rules dnrfetch frames popups popupslate sw bfcache restart
//
// Environment: CHROMIUM (default /usr/bin/chromium), RUN (a scratch folder; default a new folder
// under the system temp folder), SITE_PORT (default 8795), TRIALS (default 10).
//
// It uses a remote-debugging port of its own Chromium only to call the probe extension's worker
// (Runtime.evaluate of the functions of P in ext/sw.js); every tab and rule action runs in the
// extension, as in the agent package. It never touches another Chrome.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROMIUM = process.env.CHROMIUM ?? "/usr/bin/chromium";
const PORT = Number(process.env.SITE_PORT ?? 8795);
const TRIALS = Number(process.env.TRIALS ?? 10);
const RUN = process.env.RUN ?? mkdtempSync(join(tmpdir(), "per-scope-probe-"));
const RESULTS = join(HERE, "results");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];

const A = `http://a.localhost:${PORT}`, B = `http://b.localhost:${PORT}`, C = `http://c.localhost:${PORT}`;

function freeDisplay() {
  for (let n = 150; n < 190; n++) if (!existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`)) return n;
  throw new Error("no free display");
}

// An Xauthority file (0600) with one FamilyWild MIT-MAGIC-COOKIE-1 entry; the cookie never enters an argv.
function writeXauth(display, path) {
  execFileSync("python3", ["-c", `
import os, struct, sys
d, p = sys.argv[1], sys.argv[2]
f = lambda b: struct.pack(">H", len(b)) + b
e = struct.pack(">H", 0xFFFF) + f(b"") + f(d.encode()) + f(b"MIT-MAGIC-COOKIE-1") + f(os.urandom(16))
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
os.write(fd, e); os.close(fd)`, String(display), path]);
}

function start(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  p.stdout.on("data", () => {});
  p.stderr.on("data", () => {});
  procs.push(p);
  return p;
}

function stopAll() {
  for (const p of procs.reverse()) if (p.exitCode === null) p.kill("SIGTERM");
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.next = 1;
    this.wait = new Map();
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const w = this.wait.get(msg.id);
      if (!w) return;
      this.wait.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message)); else w.resolve(msg.result);
    };
  }
  open() { return new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; }); }
  send(method, params = {}, sessionId) {
    const id = this.next++;
    this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise((resolve, reject) => this.wait.set(id, { resolve, reject }));
  }
}

let cdp, sid;

async function attachWorker() {
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    for (const w of targetInfos.filter((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"))) {
      seen.add(w.url);
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: w.targetId, flatten: true });
      const r = await cdp.send("Runtime.evaluate", { expression: "typeof P", returnByValue: true }, sessionId);
      if (r.result?.value === "object") { sid = sessionId; return; }
      await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
    await sleep(100);
  }
  throw new Error(`the probe extension's worker did not start (workers seen: ${[...seen].join(", ")})`);
}

// P.<fn>(...args) in the extension's worker.
async function call(fn, ...args) {
  const r = await cdp.send("Runtime.evaluate", { expression: `P.${fn}(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(`${fn}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function serverLog() {
  return (await fetch(`http://127.0.0.1:${PORT}/__log`)).json();
}

let chromeEnv;

async function startChromium() {
  const { display, xauth, profile } = chromeEnv;
  // A restart finds the port file of the last start: wait for a new one.
  let old = null;
  try { old = readFileSync(join(profile, "DevToolsActivePort"), "utf8"); } catch {}
  const proc = start(CHROMIUM, [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--password-store=basic",
    `--load-extension=${join(HERE, "ext")}`, "--silent-debugger-extension-api", "--remote-debugging-port=0",
    "--window-size=1200,900", "about:blank"], { env: { ...process.env, DISPLAY: `:${display}`, XAUTHORITY: xauth, HOME: join(RUN, "home") } });
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    try {
      const text = readFileSync(join(profile, "DevToolsActivePort"), "utf8");
      const lines = text.split("\n");
      if (lines[1] && text !== old) port = lines;
    } catch {}
  }
  if (!port) throw new Error("Chromium did not start");
  cdp = new Cdp(`ws://127.0.0.1:${port[0]}${port[1]}`);
  await cdp.open();
  await attachWorker();
  return proc;
}

// Stops this probe's own Chromium (the process that startChromium started) and waits for its end.
async function stopChromium(proc) {
  const ended = new Promise((r) => proc.once("exit", r));
  proc.kill("SIGTERM");
  await ended;
}

async function up() {
  mkdirSync(RUN, { recursive: true });
  const display = freeDisplay();
  const xauth = join(RUN, "xauth");
  writeXauth(display, xauth);
  start("Xvfb", [`:${display}`, "-nolisten", "tcp", "-auth", xauth, "-screen", "0", "1280x1000x24"]);
  start("python3", [join(HERE, "site.py"), String(PORT)]);
  for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${display}`); i++) await sleep(100);
  mkdirSync(join(RUN, "home"), { recursive: true });
  chromeEnv = { display, xauth, profile: join(RUN, "profile") };
  chromeEnv.proc = await startChromium();
  return { display, run: RUN };
}

const save = (name, data) => {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
};

async function waitFor(pred, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (await pred()) return true;
  return false;
}

// ---------------------------------------------------------------- the cases

const TRUSTWORTHY = "^(https://|http://(localhost|[^/:]+\\.localhost|127\\.[0-9]+\\.[0-9]+\\.[0-9]+|\\[::1\\])(:[0-9]+)?/)";

const LISTS = { LA: ["a.localhost"], LB: ["b.localhost"] };
const SCOPES = { A: "LA", B: "LB" };

async function caseRules() {
  await call("reset");
  const ext = await call("limits");
  // The navigation-header rule of the agent package (rule 5) stays dynamic, above the session allow rules.
  await call("dynamic", [{ id: 5, priority: 3, action: { type: "modifyHeaders", requestHeaders: [{ header: "sec-fetch-site", operation: "set", value: "none" }] },
    condition: { resourceTypes: ["main_frame"], initiatorDomains: [ext.id], regexFilter: TRUSTWORTHY } }], [5]);
  await call("setLists", LISTS, SCOPES);
  await serverLog();
  const out = { trials: [], ruleMs: [] };
  for (let i = 0; i < TRIALS * 2; i++) {
    const scope = i % 2 ? "B" : "A";
    const own = scope === "A" ? A : B, other = scope === "A" ? B : A;
    // The relay's path: a new tab at about:blank gets its scope (the rule is in force when this answers), then the navigation.
    const tab = await call("newTab", scope);
    await call("nav", tab, `${own}/page?id=own${i}`);
    await call("nav", tab, `${other}/page?id=other${i}`).catch(() => {});
    await call("nav", tab, `${own}/page?id=sub${i}`.replace("://", "://www."));
    const none = await call("newTab", null);
    await call("nav", none, `${own}/page?id=none${i}`).catch(() => {});
    await sleep(400);
    const log = await serverLog();
    const evs = await call("log");
    const got = (id) => log.some((r) => r.path === "/page" && r.q.id === id);
    out.ruleMs.push(...evs.filter((e) => e.kind === "ruled").map((e) => e.total));
    out.trials.push({
      scope, ownLoaded: got(`own${i}`), subdomainLoaded: got(`sub${i}`), otherReached: got(`other${i}`), noScopeReached: got(`none${i}`),
      otherBlockedByRule1: evs.some((e) => e.kind === "match" && e.tabId === tab && e.ruleId === 1 && e.url.includes(`other${i}`)),
      noScopeBlockedByRule1: evs.some((e) => e.kind === "match" && e.tabId === none && e.ruleId === 1),
      secFetchSite: log.find((r) => r.q.id === `own${i}`)?.sfs ?? null,
    });
    await call("close", tab);
    await call("close", none);
  }
  const t = out.trials;
  out.summary = {
    trials: t.length,
    ownLoaded: t.filter((x) => x.ownLoaded).length,
    subdomainLoaded: t.filter((x) => x.subdomainLoaded).length,
    otherScopeReached: t.filter((x) => x.otherReached).length,
    otherBlockedByRule1: t.filter((x) => x.otherBlockedByRule1).length,
    noScopeReached: t.filter((x) => x.noScopeReached).length,
    noScopeBlockedByRule1: t.filter((x) => x.noScopeBlockedByRule1).length,
    secFetchSiteNone: t.filter((x) => x.secFetchSite === "none").length,
    ruleMs: { min: Math.min(...out.ruleMs), max: Math.max(...out.ruleMs), median: out.ruleMs.sort((a, b) => a - b)[out.ruleMs.length >> 1] },
  };
  save("rules", out);
  return out.summary;
}

// Does DNR decide before the hold's Fetch pause? A tab with no rule, its document requests held:
// Page.navigate; then the rule comes while the request would be paused; then the release.
async function caseDnrFetch() {
  await call("reset");
  await call("setLists", LISTS, SCOPES);
  await serverLog();
  const out = [];
  for (let i = 0; i < TRIALS; i++) {
    const tab = await call("newTab", null);
    await call("hold", tab);
    const nav = call("nav", tab, `${A}/page?id=df${i}`).catch((e) => ({ error: e.message }));
    await sleep(300);
    const before = await call("log");
    await call("assign", tab, "A");
    const released = await call("release", tab);
    await nav;
    await sleep(400);
    const after = await call("log");
    const log = await serverLog();
    out.push({
      pausedBeforeRule: before.some((e) => e.kind === "paused" && e.tabId === tab),
      blockedBeforeRule: before.some((e) => e.kind === "match" && e.tabId === tab && e.ruleId === 1),
      errorBeforeRule: before.find((e) => e.kind === "error" && e.tabId === tab)?.error ?? null,
      released,
      reached: log.some((r) => r.q.id === `df${i}`),
    });
    await call("close", tab);
  }
  const summary = {
    trials: out.length,
    pausedBeforeRule: out.filter((x) => x.pausedBeforeRule).length,
    blockedBeforeRule: out.filter((x) => x.blockedBeforeRule).length,
    reachedAfterRuleAndRelease: out.filter((x) => x.reached).length,
  };
  save("dnrfetch", { summary, trials: out });
  return summary;
}

const KINDS = {
  open: (url) => `window.open(${JSON.stringify(url)}); 1`,
  // The sign-in popup pattern: an empty popup first, then the opener sets its location.
  open_then_nav: (url) => `(() => { const w = window.open(""); w.location.href = ${JSON.stringify(url)}; return 1; })()`,
  open_noopener: (url) => `window.open(${JSON.stringify(url)}, "_blank", "noopener"); 1`,
  blank: (url) => `(() => { const a = document.getElementById("blank"); a.href = ${JSON.stringify(url)}; a.click(); return 1; })()`,
  relopener: (url) => `(() => { const a = document.getElementById("opener"); a.href = ${JSON.stringify(url)}; a.click(); return 1; })()`,
  formpost: (url) => `(() => { const f = document.getElementById("post"); f.action = ${JSON.stringify(url)}; f.submit(); return 1; })()`,
};

// Popups of a scope-A tab: which source names the opener, whether the popup's rule beats its first
// request, and what the page sees.
async function popupRun(name, cfg, kinds = Object.keys(KINDS), background = [false, true]) {
  await call("reset");
  await call("setLists", LISTS, SCOPES);
  await call("config", cfg);
  await serverLog();
  const rows = [];
  for (const kind of kinds) for (const bg of background) for (let i = 0; i < TRIALS; i++) {
    const id = `${name}-${kind}-${bg ? "bg" : "fg"}-${i}`;
    const opener = await call("newTab", "A");
    await call("nav", opener, `${A}/page?id=op-${id}`);
    await waitFor(async () => (await call("tabs")).some((t) => t.id === opener && t.url.includes("op-")), 2000);
    let other = null;
    if (bg) other = await call("newTab", "B"); // another scope's tab in front: chrome.tabs' openerTabId may name it
    await call("log");
    const t0 = Date.now();
    await call("eval", opener, KINDS[kind](`${A}/page?id=${id}`));
    await sleep(cfg.retry ? 1200 : 700);
    const evs = await call("log");
    const log = await serverLog();
    const created = evs.find((e) => e.kind === "created");
    const popup = created?.tabId;
    const of = (k) => evs.filter((e) => e.kind === k && e.tabId === popup);
    const beacon = log.filter((r) => r.path === "/beacon" && r.q.kind === "page" && r.q.id === id);
    const first = of("match")[0];
    const nav = of("navtarget")[0], ruled = of("ruled")[0];
    rows.push({
      kind, bg, popup: popup ?? null,
      openerTabIdRight: created ? created.openerTabId === opener : null,
      sourceTabIdRight: nav ? nav.sourceTabId === opener : null,
      cdpOpenerRight: of("cdpopener")[0] ? of("cdpopener")[0].openerTab === opener : null,
      firstMatch: first ? first.ruleId : null, // 1: blocked by the static block; 100: allowed by the scope's rule
      requests: log.filter((r) => r.path === "/page" && r.q.id === id).length,
      methods: log.filter((r) => r.path === "/page" && r.q.id === id).map((r) => r.m),
      loaded: beacon.length > 0,
      page: beacon[0] ? { h: beacon[0].q.h, opener: beacon[0].q.op, referrer: beacon[0].q.ref } : null,
      retried: of("retried").length,
      ms: {
        created: created ? created.t - t0 : null,
        navtarget: nav ? nav.t - t0 : null,
        ruled: ruled ? ruled.t - t0 : null,
        firstMatch: first ? first.t - t0 : null,
        request: log.find((r) => r.path === "/page" && r.q.id === id)?.t - t0 || null,
      },
    });
    if (popup) await call("close", popup);
    if (other) await call("close", other);
    await call("close", opener);
  }
  const groups = {};
  for (const r of rows) {
    const g = (groups[`${r.kind}${r.bg ? " (opener in the background)" : ""}`] ??= { trials: 0, popupSeen: 0, openerTabIdRight: 0, sourceTabIdRight: 0, cdpOpenerRight: 0, firstAllowed: 0, firstBlocked: 0, loaded: 0, retried: 0, pages: {} });
    g.trials++;
    if (r.popup !== null) g.popupSeen++;
    if (r.openerTabIdRight) g.openerTabIdRight++;
    if (r.sourceTabIdRight) g.sourceTabIdRight++;
    if (r.cdpOpenerRight) g.cdpOpenerRight++;
    if (r.firstMatch === 100) g.firstAllowed++;
    if (r.firstMatch === 1) g.firstBlocked++;
    if (r.loaded) g.loaded++;
    if (r.retried) g.retried++;
    for (const m of r.methods) g[`requests ${m}`] = (g[`requests ${m}`] ?? 0) + 1;
    if (r.page) { const k = `history.length ${r.page.h}, opener ${r.page.opener}, referrer ${r.page.referrer}`; g.pages[k] = (g.pages[k] ?? 0) + 1; }
  }
  save(`popups-${name}`, { config: cfg, groups, rows });
  return groups;
}

async function casePopups() {
  return {
    // The receiver gives a popup its opener's scope from webNavigation.onCreatedNavigationTarget.
    nav: await popupRun("nav", { inherit: "nav" }),
    // The same, with the agent package's eager attach and hold on.
    navHold: await popupRun("nav-hold", { inherit: "nav", hold: true }),
    // The same, with a reload of a popup whose first request came before its rule.
    navRetry: await popupRun("nav-retry", { inherit: "nav", retry: true }),
    // chrome.tabs' openerTabId as the source (the relay found it wrong).
    tabs: await popupRun("tabs", { inherit: "tabs" }, ["open"]),
    // The late rule and the form POST (casePopupsLate).
    ...(await casePopupsLate()),
    // The control: no inheritance, every popup is in no scope and must fail closed.
    none: await popupRun("none", { inherit: "none" }, ["open", "blank"], [false]),
  };
}

async function caseFrames() {
  await call("reset");
  await call("setLists", LISTS, SCOPES);
  await serverLog();
  const tA = await call("newTab", "A");
  await call("nav", tA, `${A}/frame?id=fa&to=${encodeURIComponent(`${C}/page?id=fa-c`)}`);
  const tB = await call("newTab", "B");
  await call("nav", tB, `${B}/frame?id=fb&to=${encodeURIComponent(`${C}/page?id=fb-c`)}`);
  const blankA = await call("newTab", "A");
  await call("eval", blankA, `document.body.innerHTML = '<iframe src="${C}/page?id=fblank-c"></iframe>'; 1`);
  const none = await call("newTab", null);
  await call("eval", none, `document.body.innerHTML = '<iframe src="${C}/page?id=fnone-c"></iframe>'; 1`);
  await sleep(800);
  const log = await serverLog();
  const evs = await call("log");
  const got = (id) => log.some((r) => r.path === "/page" && r.q.id === id);
  const out = {
    frameUnderScopeAPage: got("fa-c"),
    frameUnderScopeBPage: got("fb-c"),
    frameUnderScopeAAboutBlank: got("fblank-c"),
    frameUnderNoScopeAboutBlank: got("fnone-c"),
    rule3Blocks: evs.filter((e) => e.kind === "match" && e.ruleId === 3).map((e) => (e.tabId === blankA ? "scope A about:blank" : e.tabId === none ? "no scope about:blank" : String(e.tabId))),
  };
  save("frames", out);
  return out;
}

async function swRun(name, cfg) {
  await call("reset");
  await call("removeWorkers");
  await call("setLists", LISTS, SCOPES);
  await serverLog();
  const tA = await call("newTab", "A");
  await call("nav", tA, `${A}/swreg?id=reg-${name}`);
  const registered = await waitFor(async () => {
    const l = await fetch(`http://127.0.0.1:${PORT}/__log`).then((r) => r.json());
    swRun.held = (swRun.held ?? []).concat(l);
    return swRun.held.some((r) => r.q.kind === "swreg");
  }, 5000);
  const reg = (swRun.held ?? []).find((r) => r.q.kind === "swreg")?.q.r ?? null;
  swRun.held = [];
  await call("config", cfg);
  const rows = [];
  for (let i = 0; i < TRIALS; i++) for (const how of ["client", "page"]) {
    const id = `${name}-${how}-${i}`;
    const tB = await call("newTab", "B");
    await call("nav", tB, `${B}/page?id=bp-${id}`);
    await waitFor(async () => (await call("tabs")).some((t) => t.id === tB && t.url.includes("bp-")), 2000);
    await call("log");
    await serverLog();
    const t0 = Date.now();
    if (how === "client") await call("nav", tB, `${A}/page?id=${id}`).catch(() => {});
    else await call("eval", tB, `location.href = ${JSON.stringify(`${A}/page?id=${id}`)}; 1`).catch(() => {});
    await sleep(800);
    const evs = await call("log");
    const log = await serverLog();
    const commit = evs.find((e) => e.kind === "commit" && e.tabId === tB && e.url.includes(id));
    const guarded = evs.find((e) => e.kind === "guarded" && e.tabId === tB);
    const swpage = log.find((r) => r.q.kind === "swpage" && r.q.id === id);
    rows.push({
      how,
      networkRequest: log.some((r) => r.path === "/page" && r.q.id === id),
      rule1Match: evs.some((e) => e.kind === "match" && e.tabId === tB && e.ruleId === 1),
      committedInScopeB: !!commit,
      swPageScriptRan: !!swpage,
      frameOfSwPageReached: log.some((r) => r.q.id === `swframe-${id}`),
      guarded: !!guarded,
      ms: { commit: commit ? commit.t - t0 : null, guarded: guarded ? guarded.t - t0 : null, swpageBeacon: swpage ? Math.round(swpage.t - t0) : null },
    });
    await call("close", tB);
  }
  const s = { registered: reg, trials: rows.length };
  for (const k of ["networkRequest", "rule1Match", "committedInScopeB", "swPageScriptRan", "frameOfSwPageReached", "guarded"]) s[k] = rows.filter((r) => r[k]).length;
  const ms = (k) => rows.map((r) => r.ms[k]).filter((x) => x !== null).sort((a, b) => a - b);
  s.ms = { commit: ms("commit"), guarded: ms("guarded"), swpageBeacon: ms("swpageBeacon") };
  save(`sw-${name}`, { config: cfg, summary: s, rows });
  return s;
}

// The service-worker hole across two scopes, and the guards.
async function caseSw(only) {
  const out = {};
  if (only !== "script") {
  out.hole = await swRun("hole", {});
  out.guardCommitClose = await swRun("guard-commit-close", { guard: "commit", guardAction: "close" });
  out.guardCommitBlank = await swRun("guard-commit-blank", { guard: "commit", guardAction: "blank" });
  out.guardBeforeBlank = await swRun("guard-before-blank", { guard: "before", guardAction: "blank" });
  }
  // What DNR sees of a worker's script: an allow rule for requests of no tab (tabIds [-1]) reports them.
  await call("reset");
  await call("removeWorkers");
  await call("setLists", LISTS, SCOPES);
  await call("session", [{ id: 8000, priority: 1, action: { type: "allow" }, condition: { tabIds: [-1] } }]);
  const tA = await call("newTab", "A");
  await serverLog();
  await call("nav", tA, `${A}/swreg?id=seen`);
  await sleep(1500);
  const seen = (await call("log")).filter((e) => e.kind === "match" && e.ruleId === 8000).map((e) => ({ tabId: e.tabId, type: e.type, path: new URL(e.url).pathname }));
  const regSeen = (await serverLog()).find((r) => r.q.kind === "swreg")?.q.r ?? null;
  // A block of the worker scripts of no tab: does registration fail, and what does the page see?
  await call("reset");
  await call("removeWorkers");
  await call("setLists", LISTS, SCOPES);
  const type = seen.find((s) => s.path === "/sw.js")?.type ?? "script";
  await call("session", [{ id: 8001, priority: 9, action: { type: "block" }, condition: { tabIds: [-1], resourceTypes: [type] } }]);
  const tA2 = await call("newTab", "A");
  await serverLog();
  await call("nav", tA2, `${A}/swreg?id=blocked`);
  await sleep(1500);
  const regBlocked = (await serverLog()).find((r) => r.q.kind === "swreg")?.q.r ?? null;
  // The same block: do a dedicated worker and a shared worker still start?
  await call("nav", tA2, `${A}/workers?id=wb`);
  await sleep(2500);
  const wb = (await serverLog()).find((r) => r.q.kind === "workers")?.q ?? null;
  await call("session", [], [8001]);
  await call("nav", tA2, `${A}/workers?id=wf`);
  await sleep(2500);
  const wf = (await serverLog()).find((r) => r.q.kind === "workers")?.q ?? null;
  const workerTypes = (await call("log")).filter((e) => e.kind === "match" && e.ruleId === 8001).map((e) => ({ tabId: e.tabId, type: e.type, path: new URL(e.url).pathname }));
  await call("reset");
  out.workerScript = { seen, registeredWithObserver: regSeen, blockType: type, registrationWithBlock: regBlocked,
    workersWithBlock: wb && { dedicated: wb.dedicated, shared: wb.shared }, workersWithoutBlock: wf && { dedicated: wf.dedicated, shared: wf.shared }, blockedByTheRule: workerTypes };
  save(only === "script" ? "sw-script" : "sw", out);
  return out;
}

// A page in the back/forward cache: Back with no request after its host left the list.
async function caseBfcache() {
  await call("reset");
  await call("removeWorkers");
  const lists = { LA: ["a.localhost", "b.localhost"] };
  await call("setLists", lists, { A: "LA" });
  await call("config", { guard: "none" });
  const rows = [];
  for (const guard of ["none", "commit"]) for (let i = 0; i < 3; i++) {
    await call("setLists", { LA: ["a.localhost", "b.localhost"] }, { A: "LA" });
    await call("config", { guard: "none" });
    const tab = await call("newTab", "A");
    await call("eval", tab, `location.href = ${JSON.stringify(`${A}/page?id=bf-${guard}-${i}&cache=1`)}; 1`);
    await sleep(500);
    await call("eval", tab, `location.href = ${JSON.stringify(`${B}/page?id=bf2-${guard}-${i}`)}; 1`);
    await sleep(500);
    await call("setLists", { LA: ["b.localhost"] }, { A: "LA" });
    await call("config", { guard });
    await call("log");
    await serverLog();
    await call("eval", tab, "history.back(); 1").catch(() => {});
    await sleep(800);
    const evs = await call("log");
    const log = await serverLog();
    const commit = evs.find((e) => e.kind === "commit" && e.tabId === tab);
    if (process.env.DEBUG) console.log(JSON.stringify(evs.filter((e) => e.tabId === tab).map((e) => [e.kind, e.url, e.tq])));
    rows.push({
      guard, backRequestReachedSite: log.some((r) => r.path === "/page"),
      backBlockedByRule1: evs.some((e) => e.kind === "match" && e.tabId === tab && e.ruleId === 1),
      backError: evs.find((e) => e.kind === "error" && e.tabId === tab)?.error ?? null,
      backCommit: commit ? { host: new URL(commit.url).hostname, tq: commit.tq } : null, guarded: evs.some((e) => e.kind === "guarded"),
    });
    await call("close", tab);
  }
  save("bfcache", rows);
  return rows;
}

async function caseLimits() {
  await call("reset");
  const limits = await call("limits");
  const counts = [];
  for (const n of [4999, 5000, 5001]) counts.push(await call("ruleCount", n));
  const sizes = [];
  for (const [d, t] of [[100, 10], [1000, 100], [10000, 1000], [100000, 1000], [1000, 10000]]) sizes.push(await call("ruleSize", d, t));
  const sets = [];
  for (const [l, d] of [[2, 10], [20, 100], [20, 1000], [100, 1000], [2400, 10]]) sets.push(await call("ruleSet", l, d));
  const out = { limits, counts, sizes, sets };
  save("limits", out);
  return out;
}

// Session rules after a browser restart (the same profile); dynamic rules stay.
async function caseRestart() {
  await call("reset");
  await call("setLists", LISTS, SCOPES);
  await call("newTab", "A");
  await call("dynamic", [{ id: 2, priority: 2, action: { type: "allow" }, condition: { requestDomains: ["a.localhost"], resourceTypes: ["main_frame"] } }], [2]);
  const before = await call("rules");
  await stopChromium(chromeEnv.proc);
  chromeEnv.proc = await startChromium();
  const after = await call("rules");
  await call("dynamic", [], [2, 5]);
  const out = {
    before: { session: before.session.map((r) => r.id), dynamic: before.dynamic.map((r) => r.id) },
    afterBrowserRestart: { session: after.session.map((r) => r.id), dynamic: after.dynamic.map((r) => r.id) },
  };
  save("restart", out);
  return out;
}

async function casePopupsLate() {
  return {
    // A late rule on purpose (40 ms), then the reload: what a popup with an opener sees after the retry.
    lateRetry: await popupRun("late-retry", { inherit: "nav", retry: true, inheritDelay: 40 }, ["open", "relopener", "formpost"], [false]),
    // A form POST into a new tab, with the rule as fast as it can be and the retry.
    formRetry: await popupRun("form-retry", { inherit: "nav", retry: true }, ["formpost"], [false]),
  };
}

const CASES = { limits: caseLimits, rules: caseRules, dnrfetch: caseDnrFetch, frames: caseFrames, popups: casePopups, popupslate: casePopupsLate, sw: caseSw, swscript: () => caseSw("script"), bfcache: caseBfcache, restart: caseRestart };

async function main() {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CASES);
  const env = await up();
  console.log(`probe: run ${env.run}, display :${env.display}, Chromium ${(await call("limits")).version}`);
  const all = {};
  try {
    for (const n of names) {
      const t0 = Date.now();
      try {
        all[n] = await CASES[n]();
      } catch (e) {
        all[n] = { error: String(e.stack ?? e) };
      }
      console.log(`== ${n} (${Date.now() - t0} ms)\n${JSON.stringify(all[n], null, 1)}`);
    }
  } finally {
    stopAll();
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); stopAll(); process.exit(1); });
