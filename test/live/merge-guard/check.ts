// The live check of the merge guard (board ab-v16.99; C11, the merge guard). It runs the real service
// (test/live/merge-guard/service.ts: `service --test` with the stand-in host github-standin.localhost and the run's copy of
// the receiver 0.3.7 from chrome-extension main eda8df0, read with `git show`, never packed) in temp folders only, on one
// free display, under the harness guard, and it is the service's "daemon" on the control door. The stand-in of a GitHub PR
// page is a local server of this process on *.localhost hosts (never github.com or another public site): a marked PR (#2:
// the title prefix, the label, the head branch and the body's line), a PR marked by its label only (#3) and an unmarked PR
// (#1), each with a merge form, a Ready for review form, an auto-merge button, a GraphQL merge, a REST merge on its API
// host, a keyboard shortcut and a worker's merge; a repo page and a page of another site.
//
//   1. Chrome with the receiver 0.3.7 (no floor yet: the service's log says so), the lists, the clients;
//   2. a real Playwright client (connectOverCDP, playwright-core of this install; no browser download): on the marked PR
//      every path gets HTTP 403 with the rule's text and the stand-in gets no write; its routes never see a request to the
//      stand-in, and a route that rewrites another site's request to the stand-in is refused; on the unmarked PR each
//      path goes;
//   3. a raw CDP client (src/cdp.ts): the form's submit, a click by Input events, a fetch, a worker's fetch, a page that
//      is no PR, another site's form and a redirect, Page.setBypassCSP; the unmarked PR's merge goes;
//   4. the counts and the log lines (no URL path, no page text);
//   5. stop: Chrome, Xvfb and the shim end; the temp folders go.
//
// It never touches another Chrome, Xvfb, profile or folder: it signals only the pids that its run started.
//   flock <heavy.lock> timeout 1500 node --disable-sigusr1 test/live/merge-guard/check.ts --display 171 --chrome-extension <checkout>

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CDPConnection } from "../../../src/cdp.ts";
import { GUARD_TEXT } from "../../../src/relay/merge-guard.ts";
import { GOOGLE_SOURCE, GoogleChromeTools } from "../../../src/service/unit/google-chrome.ts";
import { makeChromeRepo } from "../../chrome-fixture.ts";
import { harnessGuard, reservedDisplay } from "../guard.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const display = Number(arg("--display") ?? "171");
const refused = reservedDisplay(display, "--display") ?? (![171, 172].includes(display) ? `--display names :${display}: this check runs on :171 or :172 only` : null);
if (!Number.isSafeInteger(display) || refused) { process.stderr.write(`merge-guard: ${refused ?? "--display must be a number"}\n`); process.exit(2); }
if (existsSync(`/tmp/.X11-unix/X${display}`) || existsSync(`/tmp/.X${display}-lock`)) { process.stderr.write(`merge-guard: :${display} is in use; this check runs on a free display only\n`); process.exit(2); }
const CE = arg("--chrome-extension");
if (!CE) { process.stderr.write("merge-guard: --chrome-extension <checkout> is needed: the receiver 0.3.7 comes from its main (read only)\n"); process.exit(2); }
const CE_COMMIT = "eda8df0";
// review-125 note A: with --unpacked-receiver <a receiver folder of a chrome-extension checkout> (no pack, no key), the
// service's Chrome also loads that receiver unpacked (C12's chrome_args: --load-extension), which has the floor: then
// Page.setBypassCSP goes, and the run checks the paths that a bypassed policy could open.
const UNPACKED = arg("--unpacked-receiver");
// The lead's focused change: --measure-sw runs only the measures of a page's service worker (the stand-in's own, a pass-through
// of every request), then stops. On de5a7b0 (no bypass of the model's own) it gave the PR body's table; with the model's
// bypass, each case shows a client's tab that the worker does not control.
const MEASURE_SW = process.argv.includes("--measure-sw");
const CHROMIUM_TREE = "/usr/lib/chromium";
const S = "github-standin.localhost", API = `api.${S}`, OTHER = "other.localhost";

const t0 = Date.now();
const log = (s: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { step: string; ok: boolean; note: string }[] = [];
const check = (step: string, ok: boolean, note = "") => { results.push({ step, ok, note }); log(`${ok ? "PASS" : "FAIL"} ${step}${note ? `: ${note}` : ""}`); if (!ok) throw new Error(`${step} failed${note ? `: ${note}` : ""}`); };
/** A measure: recorded, never a failure (C11 states its result as a limit or a fact). */
const measure = (step: string, note: string) => { results.push({ step, ok: true, note }); log(`MEASURE ${step}: ${note}`); };
/** A step that must end in `ms`: a hang becomes a failure, so the run never holds the shared lock for long. */
function within<T>(what: string, p: Promise<T>, ms = 20_000): Promise<T> {
  const late = new Promise<T>((_, reject) => { setTimeout(() => { reject(new Error(`${what}: no answer in ${ms / 1000} s`)); }, ms).unref(); });
  return Promise.race([p, late]);
}
const until = async (what: string, f: () => boolean, ms: number) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error(`${what}: not in ${ms / 1000} s`); await sleep(100); } };
function proc(pid: number): { start: number; ppid: number } | null {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, "latin1");
    const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
    if (["Z", "X"].includes(f[0])) return null;
    return { start: Number(f[19]), ppid: Number(f[1]) };
  } catch { return null; }
}

const guard = await harnessGuard("merge-guard");
const dir = mkdtempSync(join(tmpdir(), "ab-mg-live-"));
const run = join(dir, "run"), state = join(dir, "state"), tools = join(dir, "tools"), lists = join(dir, "lists");
for (const d of [run, lists]) mkdirSync(d, { mode: 0o700 });
const started = new Map<number, number>();
let service: ChildProcess | null = null;
let serviceErr = "";
let repo: ReturnType<typeof makeChromeRepo> | null = null;

// ---- the stand-in: github-standin.localhost (the PR pages, the repo page, _graphql), its API host, and another site
/** Each write that reached the stand-in: its host, method and path. */
const writes: { host: string; method: string; path: string; body: string }[] = [];
let port = 0;
const NODE = (n: number) => `PR_kwDOstand000000${n}`;
/** The stand-in's PRs: #2 with every sign of agentwatch's feature, #3 with the bare label triage only, #4 with the bare title [triage] only, #5 with the head branch only, #1 and #6 unmarked. */
type Kind = "feature" | "label triage" | "title [triage]" | "head" | "none";
const KINDS: Record<number, Kind> = { 1: "none", 2: "feature", 3: "label triage", 4: "title [triage]", 5: "head", 6: "none" };
const prPage = (n: number, kind: Kind) => {
  const prefix = kind === "feature" ? "[agentwatch triage] " : kind === "title [triage]" ? "[triage] " : "";
  const head = kind === "feature" || kind === "head" ? "agentwatch-triage/issue-7" : `fix-typo-${n}`;
  const label = kind === "feature" ? "agentwatch-triage" : kind === "label triage" ? "triage" : "needs-review";
  return `<!doctype html><title>${prefix}Fix a typo by test-user · Pull Request #${n} · o/r</title>
<h1 id="title">${prefix}Fix a typo <a href="/o/r/pull/${n}">#${n}</a></h1>
<p>test-user wants to merge 1 commit into staging from <span id="head">${head}</span>; the triage team reviews it.</p>
<a href="/o/r/labels/${label}" data-name="${label}" class="IssueLabel">${label}</a>${kind === "feature" ? "<p>Opened by agentwatch issue triage for #7. Only the operator merges this PR.</p>" : ""}
<input type="hidden" id="node" value="${NODE(n)}">
<form id="merge" method="post" action="/o/r/pull/${n}/merge"><input type="hidden" name="authenticity_token" value="test-csrf-token-not-a-secret"><button id="merge-button" type="submit">Merge pull request</button></form>
<form id="ready" method="post" action="/o/r/pull/${n}/ready_for_review"><button id="ready-button" type="submit">Ready for review</button></form>
<form id="approve" method="post" action="/o/r/pull/${n}/reviews"><input type="hidden" name="pull_request_review[event]" value="approve"><button id="approve-button" type="submit">Approve</button></form>
<button id="auto-merge">Enable auto-merge</button><button id="gql-merge">Merge (GraphQL)</button><button id="gql-approve">Approve (GraphQL)</button><button id="api-merge">Merge (REST)</button><button id="worker-merge">Merge (worker)</button>
<pre id="out"></pre>
<script>
const out = (t) => { document.getElementById("out").textContent = t; };
const show = (r) => r.text().then((t) => out(r.status + " " + t), (e) => out("error " + e));
const fail = (e) => out("error " + e);
document.getElementById("auto-merge").onclick = () => fetch("/o/r/pull/${n}/auto_merge", { method: "POST", body: "merge_method=squash" }).then(show, fail);
document.getElementById("gql-merge").onclick = () => fetch("/_graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "mutation($id: ID!) { mergePullRequest(input: {pullRequestId: $id}) { clientMutationId } }", variables: { id: document.getElementById("node").value } }) }).then(show, fail);
document.getElementById("gql-approve").onclick = () => fetch("/_graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "0a1b2c3d", variables: { input: { pullRequestId: document.getElementById("node").value, event: "APPROVE" } } }) }).then(show, fail);
document.getElementById("api-merge").onclick = () => fetch("http://${API}:" + location.port + "/repos/o/r/pulls/${n}/merge", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" }).then(show, fail);
document.getElementById("worker-merge").onclick = () => {
  const w = new Worker(URL.createObjectURL(new Blob(["fetch(" + JSON.stringify(location.origin + "/o/r/pull/${n}/merge") + ", { method: 'POST', body: 'via=worker' }).then((r) => r.text().then((t) => postMessage(r.status + ' ' + t)), (e) => postMessage('error ' + e));"], { type: "text/javascript" })));
  w.onmessage = (e) => out(e.data);
  w.onerror = (e) => out("error " + (e.message || "worker"));
};
document.addEventListener("keydown", (e) => { if (e.key === "M" && e.shiftKey) fetch("/o/r/pull/${n}/merge", { method: "POST", body: "via=keyboard" }).then(show, fail); });
</script>`;
};
const repoPage = `<!doctype html><title>o/r</title><p id="repo">o/r</p><pre id="out"></pre>`;
const otherPage = `<!doctype html><title>other site</title>
<form id="cross" method="post" action="http://${S}:PORT/o/r/pull/2/merge"><button id="cross-button" type="submit">Merge from another site</button></form><pre id="out"></pre>`;
const http = createServer((req, res) => {
  const host = String(req.headers.host ?? "").split(":")[0];
  const path = req.url ?? "/";
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    const origin = req.headers.origin;
    const cors: Record<string, string> = origin ? { "Access-Control-Allow-Origin": String(origin), "Access-Control-Allow-Credentials": "true" } : {};
    if (req.method === "OPTIONS") { res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "PUT, POST", "Access-Control-Allow-Headers": "Content-Type" }).end(); return; }
    const html = (s: string, status = 200, extra: Record<string, string> = {}) => res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extra }).end(s);
    if (host === OTHER) {
      if (path === "/cross") { html(otherPage.replace("PORT", String(port))); return; }
      if (path === "/r307") { res.writeHead(307, { Location: `http://${S}:${port}/o/r/pull/2/merge`, ...cors }).end(); return; }
      if (path === "/frame") { html(`<!doctype html><title>frame</title><script>fetch("http://${S}:${port}/o/r/pull/2/merge", { method: "POST", body: "via=frame", mode: "no-cors" }).catch(() => {});</script>`); return; }
      if (req.method !== "GET") { res.writeHead(200, { "Content-Type": "text/plain", ...cors }).end("other: ok"); return; }
      html("<!doctype html><title>other</title><p>other</p>"); return;
    }
    if (host !== S && host !== API) { res.writeHead(404).end(); return; }
    if (req.method !== "GET" && req.method !== "HEAD") {
      writes.push({ host, method: String(req.method), path, body });
      if (/\/_graphql$|\/auto_merge$/.test(path) || host === API) { res.writeHead(200, { "Content-Type": "application/json", ...cors }).end(JSON.stringify({ merged: true })); return; }
      if (/via=(keyboard|worker)/.test(body)) { res.writeHead(200, { "Content-Type": "text/plain" }).end("merged"); return; }
      html(`<!doctype html><title>merged</title><p id="done">merged ${path}</p>`); return;
    }
    const m = /^\/o\/r\/pull\/(\d+)$/.exec(path);
    if (m) { const n = Number(m[1]); html(prPage(n, KINDS[n] ?? "none")); return; }
    if (path === "/o/r") { html(repoPage); return; }
    if (path === "/csp") { html(`<!doctype html><title>csp</title><p>a page with worker-src 'self'</p><pre id="out"></pre>`, 200, { "Content-Security-Policy": "worker-src 'self'; frame-src 'none'" }); return; }
    // The stand-in's own pass-through service worker (as GitHub's could be): each request of a page that it controls, GET and
    // POST, navigations too, goes through respondWith(fetch(event.request)).
    if (path === "/sw-proxy.js") { res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" }).end("self.addEventListener('install', (e) => self.skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim())); self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));"); return; }
    // The operator's marked tab (item 3 of the focused change): a page that posts the unmarked PR's merge through the stand-in's
    // worker, and one that removes every registration first and posts with no worker.
    if (path === "/op-sw") { html(`<!doctype html><title>op sw</title><p id="state">wait</p><script>navigator.serviceWorker.register("/sw-proxy.js", { scope: "/" }).then(() => navigator.serviceWorker.ready).then(() => { if (!navigator.serviceWorker.controller) { location.reload(); return; } return fetch("/o/r/pull/1/merge", { method: "POST", body: "via=operator-sw" }).then((r) => r.status, (e) => "error"); }).then((x) => { document.getElementById("state").textContent = "done " + x; });</script>`); return; }
    if (path === "/op-direct") { html(`<!doctype html><title>op direct</title><p id="state">wait</p><script>navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister()))).then(() => { if (navigator.serviceWorker.controller) { location.reload(); return; } return fetch("/o/r/pull/1/merge", { method: "POST", body: "via=operator-direct" }).then((r) => r.status, (e) => "error"); }).then((x) => { document.getElementById("state").textContent = "done " + x; });</script>`); return; }
    if (path === "/sw-setup") { html(`<!doctype html><title>sw setup</title><p id="state">setup</p><script>navigator.serviceWorker.register("/sw-proxy.js", { scope: "/" }).then(() => navigator.serviceWorker.ready).then(() => navigator.serviceWorker.controller ? 0 : new Promise((r) => { navigator.serviceWorker.addEventListener("controllerchange", r); setTimeout(r, 3000); })).then(() => { document.getElementById("state").textContent = navigator.serviceWorker.controller ? "controlled" : "registered"; }, (e) => { document.getElementById("state").textContent = "error " + e; });</script>`); return; }
    // A service worker script of the stand-in itself (as GitHub's own): at a message it posts the marked PR's merge.
    if (path === "/sw.js") { res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" }).end("self.addEventListener('message', (e) => { fetch('/o/r/pull/2/merge', { method: 'POST', body: 'via=sw' }).then((r) => e.source.postMessage('status ' + r.status), (err) => e.source.postMessage('error ' + err)); });"); return; }
    res.writeHead(404).end();
  });
});
const WEB = () => `http://${S}:${port}`;
const writesTo = (re: RegExp) => writes.filter((w) => re.test(w.path));

type Door = { s: Socket; lines: any[]; next: (want: (l: any) => boolean, ms?: number) => Promise<any>; send: (o: object) => void };
function door(): Promise<Door> {
  return new Promise((resolve, reject) => {
    const s = connect(join(run, "control.sock"));
    const lines: any[] = [];
    let buf = "";
    const waiters: { want: (l: any) => boolean; done: (l: any) => void }[] = [];
    s.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); lines.push(l); for (const w of [...waiters]) if (w.want(l)) { waiters.splice(waiters.indexOf(w), 1); w.done(l); } } });
    s.on("error", reject);
    s.once("connect", () => resolve({
      s, lines, send: (o) => s.write(JSON.stringify(o) + "\n"),
      next: (want, ms = 30_000) => { const hit = lines.find(want); if (hit) return Promise.resolve(hit); return new Promise((done, fail) => { const w = { want, done: (l: any) => { clearTimeout(t); done(l); } }; waiters.push(w); const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); fail(new Error(`no such line in ${ms} ms`)); }, ms); }); },
    }));
  });
}
let n = 0;
const req = async (d: Door, op: string, by: object, fields: object = {}, ms = 30_000) => { const id = `q${++n}`; d.send({ t: "req", id, op, by, ...fields }); return d.next((l) => l.t === "res" && l.id === id, ms); };
const TOKEN = { kind: "token", user: "live", via: "cli" }, DAEMON = { kind: "daemon", user: "live", via: "daemon" };
const me = proc(process.pid)!;
const track = (pid: number | null | undefined, name: string) => { if (!pid) return; const p = proc(pid); if (p) { started.set(pid, p.start); guard.track(pid, name); } };

async function startService(): Promise<Door> {
  service = spawn(process.execPath, ["--disable-sigusr1", join(ROOT, "test/live/merge-guard/service.ts"), run, state, tools, lists, String(display), join(dir, "agent.crx"), join(dir, "source.json"), S], { stdio: ["ignore", "ignore", "pipe"] });
  guard.track(service.pid, "service");
  started.set(service.pid!, proc(service.pid!)?.start ?? -1);
  service.stderr!.on("data", (d) => { serviceErr += d; });
  for (let i = 0; i < 300 && !serviceErr.includes("service: ready"); i++) { if (service.exitCode !== null) break; await sleep(50); }
  if (!serviceErr.includes("service: ready")) throw new Error(`the service did not start: ${serviceErr.slice(-800)}`);
  const d = await door();
  await d.next((l) => l.t === "hello");
  d.send({ t: "hello", v: 1, side: "daemon", version: "live", features: [] });
  const cfg = await req(d, "config", { kind: "daemon", user: "live", via: "config" }, { enabled: true, control: true, chrome_bin: null, chrome_args: UNPACKED ? [`--load-extension=${UNPACKED}`] : [], display_size: "1280x900" });
  if (!cfg.ok) throw new Error(`config: ${JSON.stringify(cfg)}`);
  const ss = await req(d, "set_sessions", DAEMON, { sessions: [{ scope: "live-1", repo: "local/test", roots: [{ pid: process.pid, start: me.start }], cgroup: null, lifetime_id: "lt-live", mcp_token: null }], remote: [], box: { hosts: ["box.localhost"], cookie_names: [] } });
  if (!ss.ok) throw new Error(`set_sessions: ${JSON.stringify(ss)}`);
  return d;
}
async function stopService(): Promise<void> {
  const s = service;
  if (!s || s.exitCode !== null) return;
  const exited = new Promise<void>((r) => s.once("exit", () => r()));
  s.kill("SIGTERM");
  await Promise.race([exited, sleep(15_000).then(() => { s.kill("SIGKILL"); })]);
}
/** The page's text: the 403 page's body, or a part of a PR page. */
const bodyText = (j: string) => { try { return JSON.parse(j.replace(/^\d{3} /, "")).message; } catch { return j; } };

/**
 * The measures of the lead's focused change: a page that the stand-in's own service worker controls. A raw client turns its own
 * Fetch on for every URL (the model gives it each request of the stand-in that the tab's session sees, after the judge) and
 * records each pause; each one goes on. For each case: which requests the tab's session saw, and whether the merge reached the
 * stand-in.
 */
async function measureServiceWorker(url: string): Promise<void> {
  const c = await CDPConnection.connect(url, 10_000);
  const seen: string[] = [];
  c.on("Fetch.requestPaused", (p: any, sid?: string) => { seen.push(`${p.request.method} ${new URL(p.request.url).pathname}`); void c.send("Fetch.continueRequest", { requestId: p.requestId }, sid).catch(() => {}); });
  const ev = async (sid: string, expression: string) => (await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid)).result.value;
  const text = async (sid: string, want: (t: string) => boolean) => { for (let i = 0; i < 80; i++) { const t = await ev(sid, "document.readyState === 'complete' && document.body ? document.body.innerText : ''").catch(() => ""); if (t && want(t)) return t; await sleep(150); } return ""; };
  const open = async (u: string) => {
    const { targetId } = await c.send("Target.createTarget", { url: u });
    const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
    await c.send("Runtime.enable", {}, sessionId);
    await c.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
    return sessionId as string;
  };
  const go = async (sid: string, u: string, want: (t: string) => boolean) => { await c.send("Page.navigate", { url: u }, sid); return text(sid, want); };
  const merges = () => writes.filter((w) => w.path === "/o/r/pull/2/merge").length;
  const round = async (sid: string, name: string) => {
    seen.length = 0;
    const m0 = merges();
    await go(sid, `${WEB()}/o/r/pull/2`, (t) => t.includes("Merge pull request"));
    const controlled = await ev(sid, "!!navigator.serviceWorker.controller");
    const getSeen = seen.includes("GET /o/r/pull/2");
    const fetchPost = await ev(sid, `fetch("/o/r/pull/2/merge", { method: "POST", body: "via=sw-fetch" }).then((r) => "status " + r.status, (e) => "error " + e)`);
    const fetchSeen = seen.includes("POST /o/r/pull/2/merge");
    seen.length = 0;
    await ev(sid, "document.getElementById('merge').submit(), 1");
    const formPage = (await text(sid, (t) => t.length > 0 && !t.includes("Merge pull request"))).trim().slice(0, 40);
    const formSeen = seen.includes("POST /o/r/pull/2/merge");
    measure(`service worker, ${name}`, `the page under the worker: ${controlled}; the tab's session saw the PR page's GET: ${getSeen}, the fetch() POST: ${fetchSeen} (${fetchPost}), the form's POST: ${formSeen} (the page: "${formPage}"); merges that reached the stand-in: ${merges() - m0}`);
    return { controlled, getSeen, fetchSeen, formSeen, reached: merges() - m0 };
  };
  // The stand-in's worker, registered on the stand-in's origin (scope "/").
  const setup = await open(`${WEB()}/sw-setup`);
  let st = await text(setup, (t) => /controlled|registered|error/.test(t));
  if (st.trim() !== "controlled") st = await go(setup, `${WEB()}/sw-setup`, (t) => /controlled|registered|error/.test(t));
  measure("the stand-in's own service worker (scope /, respondWith(fetch(event.request)))", st.trim());
  const sid = await open("about:blank");
  await round(sid, UNPACKED ? "the floor (the branch's receiver), no bypass" : "receiver 0.3.7 (no floor), no bypass");
  // Network.setBypassServiceWorker on the tab's session, with no Network.enable.
  const by = await c.send("Network.setBypassServiceWorker", { bypass: true }, sid).then(() => "ok", (e: Error) => e.message);
  measure("Network.setBypassServiceWorker {bypass: true} with no Network.enable", by);
  await round(sid, "with the bypass, no Network.enable");
  // With Network on (kept on), then the bypass again.
  await c.send("Network.enable", {}, sid);
  await c.send("Network.setBypassServiceWorker", { bypass: true }, sid);
  await round(sid, "with Network.enable kept on and the bypass");
  // The client's Network.disable: does the bypass end?
  await c.send("Network.disable", {}, sid);
  await round(sid, "after a Network.disable (the bypass was not set again)");
  // A tab that starts on another *.localhost site, with Network on and the bypass, then navigates into the stand-in.
  const other = await open(`http://${OTHER}:${port}/cross`);
  await text(other, (t) => t.includes("another site"));
  await c.send("Network.enable", {}, other);
  await c.send("Network.setBypassServiceWorker", { bypass: true }, other);
  await round(other, "Network on and the bypass set on another site, then a navigation into the stand-in");
  await operatorTab();
  await c.close();
}

/**
 * Item 3 of the lead's focused change: an operator's marked tab (a tab that starts at chrome://newtab/: Ctrl+T on the run's own
 * display), where no client has a session: a write of its page that the stand-in's worker passes on, and one with no worker
 * (the unmarked PR's merge, so that only the floor can block it).
 */
async function operatorTab(): Promise<void> {
  const env = { ...process.env, DISPLAY: `:${display}`, XAUTHORITY: join(state, "xauth") };
  const xdo = (args: string[]) => spawnSync("xdotool", args, { env, encoding: "utf8", timeout: 5000 });
  const win = xdo(["search", "--onlyvisible", "--name", ".*"]).stdout.split("\n").filter((l) => /^\d+$/.test(l)).at(-1);
  const typeUrl = async (u: string) => { xdo(["key", "--clearmodifiers", "ctrl+l"]); await sleep(300); xdo(["type", "--delay", "15", u]); xdo(["key", "Return"]); };
  const opWrites = (via: string) => writes.filter((w) => w.body === `via=${via}`).length;
  if (!win) { measure("an operator's marked tab", "no X window found on the run's display: not measured"); return; }
  const sw0 = opWrites("operator-sw"), direct0 = opWrites("operator-direct");
  xdo(["windowfocus", "--sync", win]);
  xdo(["key", "--clearmodifiers", "ctrl+t"]);
  await sleep(1500);
  await typeUrl(`${WEB()}/op-sw`);
  for (let i = 0; i < 60 && opWrites("operator-sw") === sw0; i++) await sleep(200);
  await sleep(1000);
  await typeUrl(`${WEB()}/op-direct`);
  for (let i = 0; i < 60 && opWrites("operator-direct") === direct0; i++) await sleep(200);
  measure(`an operator's marked tab (Ctrl+T on the run's display, ${UNPACKED ? "the floor" : "receiver 0.3.7"}), its page's write through the stand-in's worker`, `writes that reached the stand-in: ${opWrites("operator-sw") - sw0}`);
  measure("an operator's marked tab, its page's write with no worker", `writes that reached the stand-in: ${opWrites("operator-direct") - direct0}`);
}

let code = 0;
try {
  const crx = execFileSync("git", ["-C", CE, "show", `${CE_COMMIT}:release/agent.crx`], { maxBuffer: 1 << 24 });
  writeFileSync(join(dir, "agent.crx"), crx);
  check(`the receiver package is chrome-extension ${CE_COMMIT}'s release/agent.crx (SHA-256 ${createHash("sha256").update(crx).digest("hex").slice(0, 8)}...)`, crx.length > 0, `${crx.length} bytes`);
  const argv = readFileSync("/proc/self/cmdline", "utf8").split("\0").filter((x, i, a) => i < a.length - 1 || x !== "");
  writeFileSync(join(dir, "daemon-command.json"), JSON.stringify({ v: 1, interpreter: realpathSync(process.execPath), args: argv.slice(1) }), { mode: 0o600 });
  repo = makeChromeRepo({ version: "158.0.7100.1-1", chrome: `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Google Chrome 158.0.7100.1 "; exit 0; fi\nexec "$(dirname "$0")/chromium" "$@"\n` });
  writeFileSync(join(dir, "source.json"), JSON.stringify({ repo: repo.repo, key: repo.keyFile, fingerprints: [repo.fingerprint] }));
  chmodSync(dir, 0o700);
  const installer = new GoogleChromeTools({ tools, source: { ...GOOGLE_SOURCE, repo: repo.repo, keyFile: repo.keyFile, fingerprints: [repo.fingerprint] }, log: (l) => log(`installer: ${l}`) });
  const copy = await installer.ensure();
  for (const e of readdirSync(CHROMIUM_TREE)) cpSync(join(CHROMIUM_TREE, e), join(copy.binary, "..", e), { recursive: true, force: true });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  port = (http.address() as { port: number }).port;
  writeFileSync(join(lists, "local.test.json"), JSON.stringify({ allow: [S, OTHER], repo: "local/test" }), { mode: 0o600 });

  // 1. Chrome with the receiver 0.3.7; the lists; the endpoint.
  const d = await startService();
  const a1 = await req(d, "start", TOKEN, {}, 120_000);
  check("start answers ok", a1.ok === true, JSON.stringify(a1));
  const ready = await d.next((l) => l.t === "ev" && l.ev === "ready");
  track(ready.chrome_pid, "chrome");
  track(JSON.parse(readFileSync(join(state, "unit.json"), "utf8")).xvfb_pid, "xvfb");
  await until("the receiver confirms the lists", () => /lists: the receiver took the lists of 1 scopes/.test(serviceErr), 60_000);
  if (!UNPACKED) {
    await until("the guard's floor op at the link up", () => serviceErr.includes("merge guard: the receiver has no floor"), 30_000);
    check("the receiver 0.3.7 has no floor yet: the service's log says that only the tabs that a client holds are guarded", serviceErr.includes("merge guard: the receiver has no floor (bridge.mergeGuard: unknown op): only the tabs that a client holds are guarded"));
  } else {
    await sleep(2000);
    check("the unpacked receiver of the branch has the floor: no log line says that the receiver has no floor", !serviceErr.includes("merge guard: the receiver has no floor"));
  }
  const url = (await req(d, "endpoint", DAEMON, { scope: "live-1" })).data.url as string;

  if (MEASURE_SW) await measureServiceWorker(url);
  else {
  // 2. A real Playwright client.
  const browser = await chromium.connectOverCDP(url);
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  const outOf = async (sel: string) => { await within(`a click of ${sel}`, page.click(sel)); await page.waitForFunction(() => document.getElementById("out")!.textContent !== "", undefined, { timeout: 15_000 }); const t = await page.textContent("#out"); await page.evaluate(() => { document.getElementById("out")!.textContent = ""; }); return t ?? ""; };
  await page.goto(`${WEB()}/o/r/pull/2`);
  check("Playwright: the marked PR's page loads", (await page.textContent("#title"))?.includes("[agentwatch triage]") === true);
  for (const [sel, what] of [["#merge-button", "the merge form"], ["#ready-button", "the Ready for review form"], ["#approve-button", "the approve (review) form"]] as const) {
    await Promise.all([page.waitForNavigation(), page.click(sel)]);
    check(`Playwright: ${what} of the marked PR gets the 403 page with the rule's text`, (await page.textContent("body"))?.trim() === GUARD_TEXT.marked, (await page.textContent("body"))?.slice(0, 120));
    await page.goto(`${WEB()}/o/r/pull/2`);
  }
  for (const [sel, what] of [["#auto-merge", "the auto-merge fetch"], ["#gql-merge", "the GraphQL mergePullRequest"], ["#gql-approve", "a persisted GraphQL approve"], ["#api-merge", "the REST merge on the API host (CORS)"]] as const) {
    const t = await outOf(sel);
    check(`Playwright: ${what} of the marked PR gets 403 and the rule's text`, t.startsWith("403 ") && bodyText(t) === GUARD_TEXT.marked, t.slice(0, 120));
  }
  await page.keyboard.press("Shift+M");
  await page.waitForFunction(() => document.getElementById("out")!.textContent !== "", undefined, { timeout: 15_000 });
  const kb = (await page.textContent("#out")) ?? "";
  check("Playwright: the page's keyboard shortcut (Shift+M) gets 403 and the rule's text", kb.startsWith("403 ") && bodyText(kb) === GUARD_TEXT.marked, kb.slice(0, 120));
  await page.evaluate(() => { document.getElementById("out")!.textContent = ""; });
  const evalStatus = await within("page.evaluate's fetch", page.evaluate(() => fetch("/o/r/pull/2/merge", { method: "POST" }).then((r) => r.status)));
  check("Playwright: page.evaluate's own fetch of the merge gets 403", evalStatus === 403);
  const wk = await outOf("#worker-merge");
  check("Playwright: a worker's fetch of the merge (the client's auto-attach brings the worker) gets 403 and the rule's text", wk.startsWith("403 ") && bodyText(wk) === GUARD_TEXT.marked, wk.slice(0, 120));
  check("the stand-in got no write of the marked PR from the Playwright client", writesTo(/\/pull\/2\/|\/pulls\/2\/|_graphql/).length === 0, JSON.stringify(writes));
  // The client's own routes: they get the stand-in's requests after the judge; their continue of a refused write gets the
  // guard's 403; a change of a stand-in request, and a rewrite of another site's request to the stand-in, are refused.
  const routed: string[] = [];
  await page.route("**/*", async (r) => {
    routed.push(`${r.request().method()} ${r.request().url()}`);
    // Playwright drops a protocol error of route.continue: the guard answers a refused change itself, with the text.
    if (r.request().url().endsWith("/rewrite-me")) { await r.continue({ url: `${WEB()}/o/r/pull/2/merge`, method: "POST", postData: "via=rewrite" }); return; }
    if (r.request().url().endsWith("/o/r/pull/6")) { await r.continue({ method: "POST", postData: "via=change" }); return; }
    await r.continue();
  });
  await within("the routed page", page.goto(`${WEB()}/o/r/pull/2`));
  const status = (u: string, init?: object) => within(`a fetch of ${u}`, page.evaluate(([x, i]) => fetch(x as string, i as RequestInit).then((r) => r.text().then((t) => r.status + " " + t), (e) => "error " + e), [u, init ?? {}] as const));
  const routedMerge = await status("/o/r/pull/2/merge", { method: "POST" });
  const rewritten = await status(`http://${OTHER}:${port}/rewrite-me`);
  const changed = await status(`${WEB()}/o/r/pull/6`);
  check("Playwright with page.route('**/*') (its route continues every request): the marked PR's merge still gets 403 and the rule's text", routedMerge.startsWith("403 ") && bodyText(routedMerge) === GUARD_TEXT.marked, routedMerge.slice(0, 100));
  check("Playwright with page.route('**/*'): its route got the stand-in's page and the refused write after the judge, and the other site's request", routed.includes(`GET ${WEB()}/o/r/pull/2`) && routed.includes(`POST ${WEB()}/o/r/pull/2/merge`) && routed.some((u) => u.includes(OTHER)), routed.join(", ").slice(0, 300));
  check("Playwright: a route that rewrites another site's request to the stand-in's merge gets 403 and the text (the guard answers it)", rewritten.startsWith("403 ") && rewritten.includes(GUARD_TEXT.rewrite(S)), rewritten.slice(0, 200));
  check("Playwright: a route that changes a stand-in GET into a POST gets 403 and the text", changed.startsWith("403 ") && changed.includes(GUARD_TEXT.rewrite(S)), changed.slice(0, 200));
  await page.unroute("**/*");
  check("the stand-in got no rewritten or changed write", !writes.some((w) => /via=(rewrite|change)/.test(w.body)));
  // The unmarked PR: each path goes.
  await page.goto(`${WEB()}/o/r/pull/1`);
  for (const [sel, what] of [["#auto-merge", "auto-merge"], ["#gql-merge", "the GraphQL merge"], ["#gql-approve", "the GraphQL approve"], ["#api-merge", "the REST merge"]] as const) {
    const t = await outOf(sel);
    check(`Playwright: the unmarked PR's ${what} goes (200 from the stand-in)`, t.startsWith("200 "), t.slice(0, 120));
  }
  await Promise.all([page.waitForNavigation(), page.click("#merge-button")]);
  check("Playwright: the unmarked PR's merge form goes: the stand-in merged it", (await page.textContent("#done"))?.includes("/o/r/pull/1/merge") === true && writesTo(/^\/o\/r\/pull\/1\/merge$/).length === 1);
  await page.goto(`${WEB()}/o/r/pull/1`);
  await Promise.all([page.waitForNavigation(), page.click("#ready-button")]);
  check("Playwright: the unmarked PR's Ready for review goes", writesTo(/^\/o\/r\/pull\/1\/ready_for_review$/).length === 1);
  await page.goto(`${WEB()}/o/r/pull/1`);
  await Promise.all([page.waitForNavigation(), page.click("#approve-button")]);
  check("Playwright: the unmarked PR's approve goes", writesTo(/^\/o\/r\/pull\/1\/reviews$/).length === 1);
  // A PR with one form of the marker only: the bare label triage, the bare title [triage], the head branch.
  for (const [n, what] of [[3, "the bare label triage"], [4, "the bare title prefix [triage]"], [5, "the head branch agentwatch-triage/ only"]] as const) {
    await page.goto(`${WEB()}/o/r/pull/${n}`);
    await Promise.all([page.waitForNavigation(), page.click("#merge-button")]);
    check(`Playwright: a PR marked by ${what} gets the 403 page`, (await page.textContent("body"))?.trim() === GUARD_TEXT.marked && writesTo(new RegExp(`/pull/${n}/`)).length === 0);
  }
  await page.close();
  await browser.close();

  // 3. A raw CDP client.
  const c = await CDPConnection.connect(url, 10_000);
  const open = async (u: string) => {
    const { targetId } = await c.send("Target.createTarget", { url: u });
    const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
    await c.send("Runtime.enable", {}, sessionId);
    await c.send("Page.enable", {}, sessionId);
    return sessionId as string;
  };
  const ev = async (sid: string, expression: string) => (await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid)).result.value;
  const loaded = async (sid: string, want: (t: string) => boolean) => { for (let i = 0; i < 100; i++) { const t = await ev(sid, "document.readyState === 'complete' ? document.body ? document.body.innerText : '' : ''").catch(() => ""); if (t && want(t)) return t; await sleep(150); } return ""; };
  let sid = await open(`${WEB()}/o/r/pull/2`);
  check("raw CDP: the marked PR's page loads", (await loaded(sid, (t) => t.includes("Merge pull request"))) !== "");
  await ev(sid, "document.getElementById('merge').submit(), 1");
  check("raw CDP: the merge form's submit() gets the 403 page with the rule's text", (await loaded(sid, (t) => t.trim() === GUARD_TEXT.marked)).trim() === GUARD_TEXT.marked);
  await c.send("Page.navigate", { url: `${WEB()}/o/r/pull/2` }, sid);
  await loaded(sid, (t) => t.includes("Merge pull request"));
  const box = await ev(sid, "(() => { const r = document.getElementById('merge-button').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 }, sid);
  check("raw CDP: a click on the merge button by Input events gets the 403 page", (await loaded(sid, (t) => t.trim() === GUARD_TEXT.marked)).trim() === GUARD_TEXT.marked);
  await c.send("Page.navigate", { url: `${WEB()}/o/r/pull/2` }, sid);
  await loaded(sid, (t) => t.includes("Merge pull request"));
  const st = await ev(sid, "fetch('/o/r/pull/2/ready_for_review', { method: 'POST' }).then((r) => r.text().then((t) => r.status + ' ' + t))");
  check("raw CDP: a fetch of Ready for review gets 403 and the rule's text", String(st).startsWith("403 ") && bodyText(st) === GUARD_TEXT.marked, String(st).slice(0, 100));
  await ev(sid, "document.getElementById('out').textContent = '', document.getElementById('worker-merge').click(), 1");
  let wraw = "";
  for (let i = 0; i < 60 && !wraw; i++) { wraw = await ev(sid, "document.getElementById('out').textContent"); if (!wraw) await sleep(200); }
  const workerRefused = wraw.startsWith("403 ") && bodyText(wraw) === GUARD_TEXT.marked;
  const workerWrites = writes.filter((w) => w.body === "via=worker").length;
  measure("raw CDP with no auto-attach: a worker's fetch of the marked PR's merge", `${wraw.slice(0, 40)}; writes that reached the stand-in: ${workerWrites}`);
  check("raw CDP: the worker's write of the marked PR does not reach the stand-in", workerRefused && workerWrites === 0, wraw.slice(0, 120));
  const bypass = await c.send("Page.setBypassCSP", { enabled: true }, sid).then(() => "no error", (e: Error) => e.message);
  if (!UNPACKED) check("raw CDP: with no floor (the receiver 0.3.7), Page.setBypassCSP with enabled true is refused", bypass.includes("Not available in the agent browser: Page.setBypassCSP."), bypass);
  else {
    check("raw CDP: with the floor, Page.setBypassCSP with enabled true goes to Chrome", bypass === "no error", bypass);
    // The paths that a bypassed policy could open, on a page of the stand-in whose own policy names no worker or frame.
    await c.send("Page.navigate", { url: `${WEB()}/csp` }, sid);
    await loaded(sid, (t) => t.includes("worker-src"));
    const before = writes.length;
    const post = (via: string) => `fetch(${JSON.stringify(`${WEB()}/o/r/pull/2/merge`)}, { method: 'POST', body: 'via=${via}' }).then((r) => 'status ' + r.status, (e) => 'error ' + e)`;
    const dedicated = await ev(sid, `new Promise((done) => { const w = new Worker(URL.createObjectURL(new Blob(["${post("blob-worker").replace(/"/g, '\\"')}.then((t) => postMessage(t))"]))); w.onmessage = (e) => done(e.data); w.onerror = () => done('refused'); setTimeout(() => done('no answer'), 5000); })`);
    check("with the floor and the policy bypassed: a blob dedicated worker's merge gets the guard's 403", String(dedicated) === "status 403", String(dedicated));
    const shared = await ev(sid, `new Promise((done) => { const w = new SharedWorker(URL.createObjectURL(new Blob(["onconnect = (e) => { const p = e.ports[0]; ${post("shared-worker").replace(/"/g, '\\"')}.then((t) => p.postMessage(t)); };"]))); w.port.onmessage = (e) => done(e.data); w.onerror = () => done('refused'); setTimeout(() => done('no answer'), 5000); })`);
    check("with the floor and the policy bypassed: a blob shared worker's merge is blocked by the floor (no tab)", String(shared).startsWith("error"), String(shared));
    const sw = await ev(sid, "navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then((reg) => new Promise((done) => { navigator.serviceWorker.onmessage = (e) => done(e.data); reg.active.postMessage('go'); setTimeout(() => done('no answer'), 5000); }), (e) => 'error ' + e)");
    check("with the floor: a service worker's merge is blocked by the floor (no tab)", String(sw).startsWith("error"), String(sw));
    const own = await ev(sid, post("page"));
    check("with the floor and the policy bypassed: the page script's own merge gets the guard's 403", String(own) === "status 403", String(own));
    const frame = await ev(sid, `new Promise((done) => { const f = document.createElement('iframe'); f.src = 'http://${OTHER}:${port}/frame'; f.onload = () => done('loaded'); document.body.appendChild(f); setTimeout(() => done('no load'), 5000); })`);
    await sleep(1500);
    const frameWrites = writes.slice(before).filter((w) => w.body === "via=frame").length;
    measure("with the floor and the policy bypassed: a frame of another site that posts the marked PR's merge (no auto-attach of the client)", `${frame}; its writes that reached the stand-in: ${frameWrites} (a cross-site request; C11 names it as a limit)`);
    check("with the floor and the policy bypassed: no worker's or page's write reached the stand-in", writes.slice(before).filter((w) => /via=(blob-worker|shared-worker|sw|page)/.test(w.body)).length === 0, JSON.stringify(writes.slice(before)));
    await c.send("Page.setBypassCSP", { enabled: false }, sid);
  }
  // A page that is no PR page: a marked PR's merge by URL, and a PR with no verdict.
  await c.send("Page.navigate", { url: `${WEB()}/o/r` }, sid);
  await loaded(sid, (t) => t.includes("o/r"));
  const fromRepo = await ev(sid, "Promise.all(['/o/r/pull/2/merge', '/o/r/pull/9/merge'].map((u) => fetch(u, { method: 'POST' }).then((r) => r.text().then((t) => r.status + ' ' + t))))");
  check("raw CDP from the repo page: the marked PR's merge gets the marked text, a PR with no verdict the text that says to load it", fromRepo[0].startsWith("403 ") && bodyText(fromRepo[0]) === GUARD_TEXT.marked && fromRepo[1].startsWith("403 ") && bodyText(fromRepo[1]) === GUARD_TEXT.unknown, JSON.stringify(fromRepo).slice(0, 200));
  // A page of another site: its cross-site form, and a POST that its server redirects (307) to the stand-in's merge.
  await c.send("Page.navigate", { url: `http://${OTHER}:${port}/cross` }, sid);
  await loaded(sid, (t) => t.includes("another site"));
  const redirected = await ev(sid, "fetch('/r307', { method: 'POST', body: 'via=redirect' }).then((r) => r.status, (e) => 'error')");
  check("raw CDP from another site: a POST that its server redirects (307) to the stand-in's merge does not reach it", writes.filter((w) => w.body === "via=redirect").length === 0, `the page saw ${redirected}`);
  await ev(sid, "document.getElementById('cross').submit(), 1");
  check("raw CDP from another site: its form's POST to the marked PR's merge gets the 403 page", (await loaded(sid, (t) => t.trim() === GUARD_TEXT.marked)).trim() === GUARD_TEXT.marked);
  // A page with a policy like GitHub's (worker-src 'self'): no blob worker can start there.
  await c.send("Page.navigate", { url: `${WEB()}/csp` }, sid);
  await loaded(sid, () => true);
  const blob = await ev(sid, "new Promise((done) => { try { const w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)']))); w.onmessage = () => done('ran'); w.onerror = () => done('refused (an error event)'); setTimeout(() => done('no answer in 3 s'), 3000); } catch (e) { done('refused: ' + e.name); } })");
  measure("a page with worker-src 'self' (GitHub's own rule names only its own worker scripts): a blob worker", String(blob));
  // The unmarked PR: the raw client's merge goes.
  sid = await open(`${WEB()}/o/r/pull/1`);
  await loaded(sid, (t) => t.includes("Merge pull request"));
  const okMerge = await ev(sid, "fetch('/o/r/pull/1/merge', { method: 'POST', body: 'via=raw' }).then((r) => r.status)");
  check("raw CDP: the unmarked PR's merge goes", okMerge === 200 && writes.some((w) => w.path === "/o/r/pull/1/merge" && w.body === "via=raw"));

  // 3b. The page's service worker (the lead's focused change): the stand-in's own pass-through worker (scope "/", as GitHub's
  // could be) is registered from a client's tab. The guard's bypass keeps every request of a client's tab on its session.
  const mode = UNPACKED ? "the floor" : "receiver 0.3.7";
  sid = await open(`${WEB()}/sw-setup`);
  const reg = (await loaded(sid, (t) => /controlled|registered|error/.test(t))).trim();
  check(`the page's service worker (${mode}): the stand-in's pass-through worker is registered (scope /) from a client's tab`, reg === "registered" || reg === "controlled", reg);
  const swFrom = writes.length;
  // The worker's activation claims the open pages of its scope (clients.claim): the setup page itself, loaded with the bypass.
  if (reg === "controlled") {
    const claimed = String(await ev(sid, "fetch('/o/r/pull/2/merge', { method: 'POST', body: 'via=sw-claimed' }).then((r) => r.text().then((t) => r.status + ' ' + t), (e) => 'error ' + e)"));
    check(`the page's service worker (${mode}): a page that the worker claimed (clients.claim) while the bypass is on: its fetch() of the marked PR's merge still gets the guard's 403`, claimed.startsWith("403 ") && bodyText(claimed) === GUARD_TEXT.marked, claimed.slice(0, 80));
  } else measure(`the page's service worker (${mode}): the worker's claim of the setup page`, "the worker did not claim the page in 3 s");
  const swRound = async (s: string, via: string) => {
    await c.send("Page.navigate", { url: `${WEB()}/o/r/pull/2` }, s);
    await loaded(s, (t) => t.includes("Merge pull request"));
    const controlled = await ev(s, "!!navigator.serviceWorker.controller");
    const f = String(await ev(s, `fetch('/o/r/pull/2/merge', { method: 'POST', body: 'via=${via}' }).then((r) => r.text().then((t) => r.status + ' ' + t), (e) => 'error ' + e)`));
    await ev(s, "document.getElementById('merge').submit(), 1");
    const form = (await loaded(s, (t) => t.trim() === GUARD_TEXT.marked)).trim();
    return { controlled, f, form, ok: controlled === false && f.startsWith("403 ") && bodyText(f) === GUARD_TEXT.marked && form === GUARD_TEXT.marked };
  };
  let w = await swRound(sid, "sw-client");
  check(`the page's service worker (${mode}): a client's tab is not under it; the marked PR's fetch() merge and its form's POST get the guard's 403`, w.ok, JSON.stringify({ ...w, f: w.f.slice(0, 60) }));
  const off = await c.send("Network.setBypassServiceWorker", { bypass: false }, sid).then(() => "no error", (e: Error) => e.message);
  check("a client's Network.setBypassServiceWorker with bypass false is refused with the merge guard's text", off.includes(GUARD_TEXT.serviceWorker), off);
  const on = await c.send("Network.setBypassServiceWorker", { bypass: true }, sid).then(() => "no error", (e: Error) => e.message);
  check("a client's Network.setBypassServiceWorker with bypass true is answered", on === "no error", on);
  await c.send("Network.enable", {}, sid);
  await c.send("Network.disable", {}, sid);
  w = await swRound(sid, "sw-disable");
  check(`the page's service worker (${mode}): after the client's Network.enable and Network.disable the tab is still not under it, and the merge gets the 403`, w.ok, JSON.stringify({ ...w, f: w.f.slice(0, 60) }));
  const cross = await open(`http://${OTHER}:${port}/cross`);
  await loaded(cross, (t) => t.includes("another site"));
  w = await swRound(cross, "sw-cross");
  check(`the page's service worker (${mode}): a tab that starts on another site and navigates into the stand-in is not under it, and the merge gets the 403`, w.ok, JSON.stringify({ ...w, f: w.f.slice(0, 60) }));
  await c.close();
  // A Playwright client (it turns Network on in its pages) in a new page.
  const b2 = await chromium.connectOverCDP(url);
  const p2 = await b2.contexts()[0].newPage();
  await p2.goto(`${WEB()}/o/r/pull/2`);
  const p2Controlled = await p2.evaluate(() => !!navigator.serviceWorker.controller);
  const p2Merge = await p2.evaluate(() => fetch("/o/r/pull/2/merge", { method: "POST", body: "via=sw-playwright" }).then((r) => r.text().then((t) => r.status + " " + t), (e) => "error " + e));
  check(`the page's service worker (${mode}): a Playwright page is not under it, and the merge gets the 403`, p2Controlled === false && p2Merge.startsWith("403 ") && bodyText(p2Merge) === GUARD_TEXT.marked, `${p2Controlled} ${p2Merge.slice(0, 60)}`);
  await p2.close();
  await b2.close();
  check(`the page's service worker (${mode}): no merge of the marked PR reached the stand-in`, writes.slice(swFrom).filter((x) => x.path === "/o/r/pull/2/merge").length === 0, JSON.stringify(writes.slice(swFrom)));
  await operatorTab();

  }
  if (!MEASURE_SW) {
  // 4. The counts and the log lines.
  const lines = serviceErr.split("\n").filter((l) => l.startsWith("merge guard:"));
  log(`the service's merge guard lines:\n${lines.join("\n")}`);
  check("the log names a refusal of each reason once (marked, unknown) with a method, the host, a tab and the count", lines.some((l) => /^merge guard: refused a write to github-standin\.localhost \((POST|PUT), tab \d+\): marked; refused so far: \d+$/.test(l)) && lines.some((l) => /: unknown; refused so far: \d+$/.test(l)));
  check("no log line of the guard holds a URL path, a query or a page's text", !lines.some((l) => /\/o\/r|pull\/|_graphql|test-csrf|Fix a typo|via=/.test(l)));
  // The frame of another site with the policy bypassed (the floor mode only) is a measured limit that C11 states.
  const marked = writes.filter((w) => w.body !== "via=frame" && (/\/pull\/[2345]\/|\/pulls\/2\//.test(w.path) || (w.path === "/_graphql" && !w.body.includes(NODE(1)))));
  check("the stand-in got no write of a marked PR in the whole run (but the measured frame of another site in the floor mode)", marked.length === 0, JSON.stringify(marked));
  log(`the stand-in's writes: ${JSON.stringify(writes.map((w) => `${w.method} ${w.host === API ? "api " : ""}${w.path}`))}`);

  }
  // 5. Stop.
  const stp = await req(d, "stop", TOKEN, {}, 30_000);
  check("stop answers ok", stp.ok === true);
  d.s.end();
  await stopService();
} catch (e) {
  code = 1;
  log(`FAIL: ${(e as Error).message}`);
  if (serviceErr) log(`the service's log (end):\n${serviceErr.slice(-4000)}`);
} finally {
  await stopService();
  http.close();
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    for (const [pid, start] of started) if (proc(pid)?.start === start) { try { process.kill(pid, sig); } catch {} }
    await sleep(2000);
  }
  const left = [...started].filter(([pid, start]) => proc(pid)?.start === start).map(([pid]) => pid);
  repo?.close();
  rmSync(dir, { recursive: true, force: true });
  log(`cleanup: ${left.length ? `still running: ${left.join(", ")}` : "no process of this run runs"}; the temp folder is ${existsSync(dir) ? "still there" : "removed"}`);
  if (left.length) code = 1;
  process.stdout.write(`${JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length + (code && results.every((r) => r.ok) ? 1 : 0), seconds: Math.round((Date.now() - t0) / 1000) })}\n`);
  process.exit(code);
}
