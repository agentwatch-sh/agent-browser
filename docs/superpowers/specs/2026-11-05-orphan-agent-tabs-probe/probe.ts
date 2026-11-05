// The probe of the orphan agent tabs design (board task ab-v16.39). Not part of `npm test`. It measures what the
// design depends on, against the relay of this checkout and the receiver of a chrome-extension checkout:
//
//   part "today" (no debugging pipe): what a link drop (the daemon side drops its socket; the native host lives on),
//   a native port drop (the host process ends), a relay restart with no link change, and `end_scope` after each of
//   them do to the agent tabs and to the receiver's attachments; whether today's end_scope can close the browser's
//   last window; what a browser restart (SIGTERM, SIGKILL, and with "continue where you left off") leaves open.
//   part "worker" (Chromium with --remote-debugging-pipe, so the probe can read the receiver's worker): whether
//   chrome.storage.session, a DNR session rule and the tab ids stay over a worker stop and over an extension reload,
//   whether the worker comes back by itself after a stop, and whether it stops when idle with its native port open.
//
//   CHROME_EXTENSION=<a detached chrome-extension worktree> PART=today|worker RUN=<empty folder> node probe.ts
//
// Environment: CHROMIUM (default /usr/bin/chromium), DISPLAY_N (default 137), PORT (default 8793), IDLE_S (default
// 360, part "worker"). It starts its own Xvfb and Chromium and stops only those, by the pids that it recorded. It
// uses *.localhost hosts on 127.0.0.1 only. It writes <RUN>/results.json and logs in <RUN>/logs. It deletes nothing.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer as httpServer, get } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const EXT = resolve(process.env.CHROME_EXTENSION ?? "");
const PART = process.env.PART ?? "today";
const RUN = resolve(process.env.RUN ?? "");
if (!process.env.CHROME_EXTENSION || !process.env.RUN || !existsSync(join(EXT, "agent/manifest.json"))) {
  process.stderr.write("usage: CHROME_EXTENSION=<chrome-extension checkout> PART=today|worker RUN=<empty folder> node probe.ts\n");
  process.exit(2);
}
const CHROMIUM = process.env.CHROMIUM ?? "/usr/bin/chromium";
const DISPLAY_N = Number(process.env.DISPLAY_N ?? 137);
const PORT = Number(process.env.PORT ?? 8793);
const IDLE_S = Number(process.env.IDLE_S ?? 360);
const A = `http://a.localhost:${PORT}`;
const RELAY_SOCK = join(RUN, "relay.sock"), DAEMON_SOCK = join(RUN, "daemon.sock");
const PROFILE = join(RUN, "profile");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const now = () => Date.now() - t0;

mkdirSync(join(RUN, "logs"), { recursive: true });
mkdirSync(join(RUN, "home"), { recursive: true });
chmodSync(RUN, 0o700);
const logLine = (file: string, text: string) => appendFileSync(join(RUN, "logs", file), `${new Date().toISOString()} ${text}\n`);
const results: Record<string, unknown> = { part: PART };
const note = (key: string, value: unknown) => { results[key] = value; console.log(`${key}: ${JSON.stringify(value)}`.slice(0, 600)); };

// ---------------------------------------------------------------- the test site (a.localhost only)

const hits: { at: number; path: string }[] = [];
const site = httpServer((req, res) => {
  hits.push({ at: now(), path: (req.url ?? "/").split("?")[0] });
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><title>probe</title><p>${(req.url ?? "/").split("?")[0]}</p>`);
});
await new Promise<void>((r) => site.listen(PORT, "127.0.0.1", r));

// ---------------------------------------------------------------- the stand-in daemon

/** The bridge side of the daemon (C4, C10), as test/live/agent-mode/daemon.ts, with a relay that can restart and a link that can drop. */
class Daemon {
  relay: ChildProcess | null = null;
  private server: Server | null = null;
  private host: Socket | null = null;
  bridgeUp = false;
  private nextId = 1;
  private readonly own = new Map<string, (m: any) => void>();
  private readonly toRelayPending = new Set<string>();
  private allowReq = "";
  hostConnects: number[] = [];
  hostCloses: number[] = [];
  events: { at: number; ev: string; tab?: number; method?: string }[] = [];
  private readonly allow: string[];
  private readonly withRelay: boolean;
  constructor(allow: string[], withRelay: boolean) { this.allow = allow; this.withRelay = withRelay; }

  listen(): Promise<void> {
    this.server = createServer((s) => this.onHost(s));
    const umask = process.umask(0o077);
    return new Promise<void>((r) => { try { this.server!.listen(DAEMON_SOCK, () => { chmodSync(DAEMON_SOCK, 0o600); r(); }); } finally { process.umask(umask); } });
  }

  /** The daemon side drops the link for `ms` (a daemon restart, as the receiver sees it: its native host lives on). */
  async dropSocket(ms: number): Promise<void> {
    // Node unlinks the socket path at the close, so the host's retries fail until the listen again.
    const closed = new Promise<void>((r) => this.server!.close(() => r()));
    this.host?.destroy();
    await closed;
    await sleep(ms);
    await this.listen();
  }

  startRelay(): void {
    if (!this.withRelay) return;
    const relay = spawn(process.execPath, [join(ROOT, "bin/agent-browser.js"), "relay", "--socket", RELAY_SOCK], { stdio: ["pipe", "pipe", "pipe"] });
    this.relay = relay;
    createInterface({ input: relay.stdout! }).on("line", (line) => this.fromRelay(line));
    createInterface({ input: relay.stderr! }).on("line", (l) => logLine("relay.log", l));
    // A new relay: the link-up line again when the link is up, then the list again (the real daemon's announce and push).
    if (this.bridgeUp) { this.toRelay({ t: "link", up: true }); this.pushAllowlist(); }
  }

  /** The relay ends with its standard input (C10); the real daemon then turns the eager attach off. */
  async stopRelay(): Promise<number | null> {
    const relay = this.relay!;
    const exited = new Promise<number | null>((r) => relay.once("exit", (c) => r(c)));
    relay.stdin!.end();
    const code = await Promise.race([exited, sleep(5000).then(() => -1)]);
    this.relay = null;
    if (this.bridgeUp) await this.ask("bridge.attachNew", [false]).catch(() => {});
    return code;
  }

  endScope(scope: string): void { this.toRelay({ t: "end_scope", scope }); }

  private toRelay(msg: object | string): void {
    if (this.relay?.stdin?.writable) this.relay.stdin.write(`${typeof msg === "string" ? msg : JSON.stringify(msg)}\n`);
  }

  private toReceiver(ch: "main" | "bridge", msg: { id: string }): boolean {
    if (!this.host) return false;
    const b64 = Buffer.from(JSON.stringify(msg)).toString("base64");
    this.host.write(`${JSON.stringify({ t: "part", ch, id: msg.id, seq: 0, n: 1, b64 })}\n`);
    return true;
  }

  private pushAllowlist(): void {
    this.allowReq = `m${this.nextId++}`;
    this.toReceiver("main", { t: "req", id: this.allowReq, op: "set_allowlist", domains: this.allow } as any);
  }

  private fromRelay(line: string): void {
    let req: any;
    try { req = JSON.parse(line); } catch { return; }
    if (req?.t !== "req") return;
    if (!this.bridgeUp || !this.toReceiver("bridge", req)) { this.toRelay({ t: "res", ch: "bridge", id: req.id, ok: false, error: "not connected" }); return; }
    this.toRelayPending.add(req.id);
  }

  private onHost(sock: Socket): void {
    if (this.host) { sock.destroy(); return; }
    this.host = sock;
    this.hostConnects.push(now());
    createInterface({ input: sock, crlfDelay: Infinity }).on("line", (line) => {
      let m: any;
      try { m = JSON.parse(line); } catch { return; }
      if (m.t === "hello") {
        if (!Array.isArray(m.channels) || !m.channels.includes("bridge")) return;
        this.bridgeUp = true;
        this.toRelay({ t: "link", up: true, version: m.version });
        this.pushAllowlist();
      } else if (m.t === "res" && m.ch === "bridge" && this.own.has(m.id)) { this.own.get(m.id)!(m); this.own.delete(m.id); }
      else if (m.t === "res" && m.ch === "bridge" && this.toRelayPending.delete(m.id)) this.toRelay(line);
      else if (m.t === "res" && m.id === this.allowReq) { if (m.ok) this.toRelay({ t: "allowlist", domains: this.allow }); }
      else if (m.t === "ev" && m.ch === "bridge") {
        this.events.push({ at: now(), ev: m.ev, tab: m.source?.tabId ?? m.tabId ?? m.tab?.id, method: m.method });
        this.toRelay(line);
      }
    });
    sock.on("close", () => {
      if (this.host !== sock) return;
      this.host = null;
      this.hostCloses.push(now());
      for (const id of this.toRelayPending) this.toRelay({ t: "res", ch: "bridge", id, ok: false, error: "disconnected" });
      this.toRelayPending.clear();
      for (const [id, done] of this.own) { done({ ok: false, error: "disconnected" }); this.own.delete(id); }
      if (this.bridgeUp) this.toRelay({ t: "link", up: false });
      this.bridgeUp = false;
    });
  }

  /** A bridge request of the probe itself: its answer comes here, not to the relay. */
  ask(op: string, args: unknown[] = []): Promise<any> {
    const id = `probe-${this.nextId++}`;
    return new Promise((res, rej) => {
      this.own.set(id, (m) => (m.ok ? res(m.data ?? null) : rej(new Error(m.error))));
      if (!this.toReceiver("bridge", { t: "req", id, op, args, wait: 30_000 } as any)) { this.own.delete(id); rej(new Error("not connected")); }
    });
  }
}

// ---------------------------------------------------------------- a CDP client of the relay

class Cdp {
  private next = 1;
  private readonly pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  readonly events: { method: string; params: any; sessionId?: string }[] = [];
  closed: { code: number; reason: string } | null = null;
  private readonly ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.id !== undefined) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p?.rej(new Error(m.error.message)); else p?.res(m.result); }
      else this.events.push(m);
    });
    ws.on("close", (code, reason) => { this.closed = { code, reason: String(reason) }; for (const p of this.pending.values()) p.rej(new Error("closed")); });
  }
  static open(scope: string): Promise<Cdp> {
    const ws = new WebSocket(`ws+unix://${RELAY_SOCK}:/devtools/browser/${scope}`);
    return new Promise((res, rej) => { ws.once("open", () => res(new Cdp(ws))); ws.once("error", rej); });
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = this.next++;
    this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  close(): void { this.ws.close(); }
}

// ---------------------------------------------------------------- Chromium, Xvfb and the CDP pipe (part "worker")

const manifest = JSON.parse(readFileSync(join(EXT, "agent/manifest.json"), "utf8"));
const hex = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
const EXT_ID = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
cpSync(join(EXT, "agent"), join(RUN, "agent"), { recursive: true });
// Part "worker" only: the copy gets the "storage" permission (the receiver has none today; chrome.storage is then
// absent). The key stays, so the ID stays. The checkout's agent/ is never changed.
if (PART === "worker") {
  const m = JSON.parse(readFileSync(join(RUN, "agent/manifest.json"), "utf8"));
  m.permissions = [...m.permissions, "storage"];
  writeFileSync(join(RUN, "agent/manifest.json"), JSON.stringify(m, null, 2));
}
mkdirSync(join(PROFILE, "NativeMessagingHosts"), { recursive: true });
const hostSh = join(RUN, "host.sh");
writeFileSync(hostSh, `#!/bin/sh\nexec /usr/bin/python3 ${join(EXT, "test/live/host.py")} --socket ${DAEMON_SOCK} --log ${join(RUN, "logs/host.log")} "$@"\n`, { mode: 0o700 });
writeFileSync(join(PROFILE, "NativeMessagingHosts/sh.agentwatch.browser.json"),
  JSON.stringify({ name: "sh.agentwatch.browser", description: "probe", path: hostSh, type: "stdio", allowed_origins: [`chrome-extension://${EXT_ID}/`] }));

const pids: Record<string, number[]> = { xvfb: [], chromium: [] };
const field = (b: Buffer) => Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]);
const xauth = join(RUN, "xauth");
writeFileSync(xauth, Buffer.concat([Buffer.from([0xff, 0xff]), field(Buffer.alloc(0)), field(Buffer.from(String(DISPLAY_N))), field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(randomBytes(16))]), { mode: 0o600 });
if (existsSync(`/tmp/.X11-unix/X${DISPLAY_N}`)) throw new Error(`display :${DISPLAY_N} is taken`);
const xvfb = spawn("Xvfb", [`:${DISPLAY_N}`, "-nolisten", "tcp", "-auth", xauth, "-screen", "0", "1280x900x24"], { stdio: ["ignore", openSync(join(RUN, "logs/xvfb.log"), "a"), openSync(join(RUN, "logs/xvfb.log"), "a")] });
pids.xvfb.push(xvfb.pid!);
for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${DISPLAY_N}`); i++) await sleep(200);

let chromium: ChildProcess | null = null;
let pipe: Pipe | null = null;

/** The unit's argv (agentwatch daemon/browser/unit.py), with the probe's profile and receiver copy. */
function startChromium(withPipe: boolean): ChildProcess {
  const out = openSync(join(RUN, "logs/chromium.log"), "a");
  const c = spawn(CHROMIUM, [`--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check", "--password-store=basic",
    `--load-extension=${join(RUN, "agent")}`, "--silent-debugger-extension-api", "--enable-unsafe-swiftshader", "--lang=en-US",
    "--window-position=0,0", "--window-size=1280,900", "--disable-backgrounding-occluded-windows", ...(withPipe ? ["--remote-debugging-pipe"] : []), "about:blank"],
  { env: { PATH: "/usr/bin:/bin", HOME: join(RUN, "home"), LANG: "en_US.UTF-8", DISPLAY: `:${DISPLAY_N}`, XAUTHORITY: xauth },
    stdio: withPipe ? ["ignore", out, out, "pipe", "pipe"] : ["ignore", out, out] });
  pids.chromium.push(c.pid!);
  chromium = c;
  if (withPipe) pipe = new Pipe(c);
  return c;
}

async function stopChromium(sig: "SIGTERM" | "SIGKILL"): Promise<number | string | null> {
  const c = chromium!;
  if (c.exitCode !== null || c.signalCode !== null) return c.exitCode ?? c.signalCode;
  const gone = new Promise<void>((r) => c.once("exit", () => r()));
  c.kill(sig);
  await Promise.race([gone, sleep(8000)]);
  if (c.exitCode === null && c.signalCode === null) { c.kill("SIGKILL"); await Promise.race([gone, sleep(3000)]); }
  chromium = null;
  return c.exitCode ?? c.signalCode;
}

/** CDP over --remote-debugging-pipe (fd 3 in, fd 4 out, NUL-terminated JSON): no port. */
class Pipe {
  private next = 1;
  private buf = "";
  private readonly pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  private readonly c: ChildProcess;
  constructor(c: ChildProcess) {
    this.c = c;
    (c.stdio[4] as NodeJS.ReadableStream).on("data", (d: Buffer) => {
      this.buf += d.toString("utf8");
      let i;
      while ((i = this.buf.indexOf("\0")) >= 0) {
        const m = JSON.parse(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
        if (m.id !== undefined) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p?.rej(new Error(m.error.message)); else p?.res(m.result); }
      }
    });
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = this.next++;
    (this.c.stdio[3] as NodeJS.WritableStream).write(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }) + "\0");
    return Promise.race([new Promise((res, rej) => this.pending.set(id, { res, rej })), sleep(15_000).then(() => { throw new Error(`no answer to ${method}`); })]);
  }
  async worker(): Promise<{ targetId: string; sessionId: string } | null> {
    const { targetInfos } = await this.send("Target.getTargets");
    const sw = targetInfos.find((t: any) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${EXT_ID}/`));
    if (!sw) return null;
    const { sessionId } = await this.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
    return { targetId: sw.targetId, sessionId };
  }
  async evaluate(sessionId: string, expression: string): Promise<any> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
}

// ---------------------------------------------------------------- helpers

const status = (path: string) => new Promise<number>((r) => { get({ socketPath: RELAY_SOCK, path }, (res) => { res.resume(); r(res.statusCode ?? 0); }).once("error", () => r(0)); });
async function relayReady(ms = 30_000): Promise<number> {
  const start = now();
  while (now() - start < ms) { if ((await status("/devtools/browser/probe")) === 404) return now() - start; await sleep(100); }
  throw new Error("the relay did not get ready");
}
async function linkUp(d: Daemon, ms = 30_000): Promise<void> {
  const start = now();
  while (now() - start < ms) { if (d.bridgeUp) { try { await d.ask("bridge.info"); return; } catch { /* not yet */ } } await sleep(100); }
  throw new Error("no link");
}
const tabs = async (d: Daemon) => (await d.ask("tabs.query", [{}])).map((t: any) => ({ id: t.id, window: t.windowId, url: t.pendingUrl || t.url }));
const attached = async (d: Daemon) => (await d.ask("debugger.getTargets")).filter((t: any) => t.type === "page").map((t: any) => ({ tab: t.tabId, attached: t.attached }));
const tabIdOf = async (d: Daemon, path: string) => (await tabs(d)).find((t: any) => t.url.endsWith(path))?.id;
const hostPid = () => { const lines = readFileSync(join(RUN, "logs/host.log"), "utf8").trim().split("\n"); return JSON.parse(lines[lines.length - 1]).pid as number; };

/** One client of `scope` opens pages at `paths` (Target.createTarget, as Playwright's newPage and goto). */
async function openPages(scope: string, paths: string[]): Promise<{ c: Cdp; targets: string[] }> {
  const c = await Cdp.open(scope);
  const targets: string[] = [];
  for (const p of paths) targets.push((await c.send("Target.createTarget", { url: `${A}${p}` })).targetId);
  return { c, targets };
}
/** What a new client of `scope` sees: Target.getTargets, and the targetCreated events of setDiscoverTargets. */
async function clientView(scope: string): Promise<{ getTargets: number; discovered: number; c: Cdp }> {
  const c = await Cdp.open(scope);
  const { targetInfos } = await c.send("Target.getTargets");
  await c.send("Target.setDiscoverTargets", { discover: true });
  await sleep(500);
  return { getTargets: targetInfos.length, discovered: c.events.filter((e) => e.method === "Target.targetCreated").length, c };
}

// ---------------------------------------------------------------- part "today"

async function partToday(): Promise<void> {
  const d = new Daemon(["a.localhost"], true);
  await d.listen();
  d.startRelay();
  startChromium(false);
  await linkUp(d);
  await relayReady();
  await sleep(1000);
  note("start.tabs", await tabs(d));

  // A. The daemon side drops its socket for 3 s; the native host retries every second (a daemon restart, as the receiver sees it).
  const s1 = await openPages("s1", ["/a1", "/a2"]);
  const s2 = await openPages("s2", ["/a3"]);
  await sleep(1500);
  const beforeA = { tabs: await tabs(d), attached: await attached(d), s1: (await s1.c.send("Target.getTargets")).targetInfos.length };
  note("A.before", beforeA);
  const dropAt = now();
  await d.dropSocket(3000);
  await linkUp(d);
  const readyIn = await relayReady();
  note("A.link", { downToReady_ms: now() - dropAt, readyAfterRelisten_ms: readyIn, s1Closed: s1.c.closed, s2Closed: s2.c.closed });
  note("A.after.tabs", await tabs(d));
  note("A.after.attached", await attached(d));
  const viewA = await clientView("s1");
  note("A.after.s1-client", { getTargets: viewA.getTargets, discovered: viewA.discovered });
  d.endScope("s1");
  await sleep(2000);
  note("A.after-end_scope-s1", { tabs: await tabs(d), clientClosed: viewA.c.closed });

  // A2. The native host process ends (the receiver's port drops; it connects again after its backoff).
  const s5 = await openPages("s5", ["/c1"]);
  await sleep(1000);
  const pid = hostPid();
  const before2 = { tabs: (await tabs(d)).length, pid, connects: d.hostConnects.length };
  process.kill(pid, "SIGTERM"); // the probe's own Chromium's child
  const killAt = now();
  while (d.hostConnects.length === before2.connects && now() - killAt < 30_000) await sleep(50);
  const reconnect = now() - killAt;
  await linkUp(d);
  await relayReady();
  note("A2.port-drop", { ...before2, reconnect_ms: reconnect, s5Closed: s5.c.closed, newPid: hostPid() });
  note("A2.after.tabs", await tabs(d));
  const viewA2 = await clientView("s5");
  note("A2.after.s5-client", { getTargets: viewA2.getTargets, discovered: viewA2.discovered });
  viewA2.c.close();

  // B. The relay restarts with no link change (the daemon's backoff restart after a relay crash).
  const s3 = await Cdp.open("s3");
  await s3.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await s3.send("Target.createTarget", { url: `${A}/b1` });
  await sleep(1500);
  const sid = s3.events.find((e) => e.method === "Target.attachedToTarget")?.params.sessionId;
  await s3.send("Fetch.enable", { patterns: [{ urlPattern: "*b-fetch*" }] }, sid);
  await s3.send("Emulation.setUserAgentOverride", { userAgent: "probe-old-client" }, sid);
  const b1 = await tabIdOf(d, "/b1");
  note("B.before", { b1, attached: await attached(d) });
  const exit = await d.stopRelay();
  d.startRelay();
  await relayReady();
  note("B.relay-restart", { oldRelayExit: exit, s3Closed: s3.closed });
  note("B.after.tabs", await tabs(d));
  note("B.after.attached", await attached(d));
  const viewB = await clientView("s3");
  note("B.after.s3-client", { getTargets: viewB.getTargets, discovered: viewB.discovered });
  // The old client's domain state: its Fetch pattern and its user agent, in the tab that nobody sees now.
  const evalB = await d.ask("debugger.sendCommand", [{ tabId: b1 }, "Runtime.evaluate", { returnByValue: true, awaitPromise: true,
    expression: "Promise.race([fetch('/b-fetch').then((r) => 'loaded ' + r.status), new Promise((r) => setTimeout(() => r('no answer in 5 s'), 5000))]).then((f) => ({ fetch: f, ua: navigator.userAgent }))" }])
    .then((r: any) => r.result.value, (e: Error) => `error: ${e.message}`);
  note("B.after.leftover", { evaluate: evalB, siteSawFetch: hits.some((h) => h.path === "/b-fetch"),
    pausedEventsOfB1: d.events.filter((e) => e.tab === b1 && e.method === "Fetch.requestPaused").length });
  d.endScope("s3");
  await sleep(2000);
  note("B.after-end_scope-s3", { b1Open: (await tabs(d)).some((t: any) => t.id === b1), clientClosed: viewB.c.closed });

  // F. Today's end_scope when the scope's window is the browser's last window.
  const s4 = await openPages("s4", ["/f1"]);
  await sleep(1000);
  const f1 = await tabIdOf(d, "/f1");
  for (const t of await tabs(d)) if (t.id !== f1) await d.ask("tabs.remove", [t.id]).catch(() => {});
  await sleep(500);
  note("F.before", { tabs: await tabs(d) });
  const exitWait = new Promise<string>((r) => chromium!.once("exit", (code, sig) => r(`exit ${code ?? sig}`)));
  d.endScope("s4");
  note("F.after-end_scope-s4", { chromium: await Promise.race([exitWait, sleep(5000).then(() => "still running after 5 s")]), s4Closed: s4.c.closed });
  if (chromium && (chromium as ChildProcess).exitCode === null) await stopChromium("SIGTERM");
  chromium = null;

  // E. Browser restarts: which tabs open again (the unit's argv opens about:blank; no restore flag).
  for (const [name, sig, restore] of [["E1.sigterm", "SIGTERM", false], ["E2.sigkill", "SIGKILL", false], ["E3.sigterm-restore-on", "SIGTERM", true]] as const) {
    if (restore) {
      const prefs = JSON.parse(readFileSync(join(PROFILE, "Default/Preferences"), "utf8"));
      prefs.session = { ...(prefs.session ?? {}), restore_on_startup: 1 };
      writeFileSync(join(PROFILE, "Default/Preferences"), JSON.stringify(prefs));
    }
    startChromium(false);
    await linkUp(d);
    await relayReady();
    await sleep(1000);
    const startTabs = await tabs(d);
    const e = await openPages("s9", ["/e1", "/e2"]);
    await sleep(1500);
    const beforeE = await tabs(d);
    e.c.close();
    const how = await stopChromium(sig);
    startChromium(false);
    await linkUp(d);
    await relayReady();
    await sleep(2500);
    note(name, { startTabs, before: beforeE, stopped: how, after: await tabs(d), siteHitsAfterRestart: hits.filter((h) => h.path.startsWith("/e")).length });
    hits.length = 0;
    await stopChromium("SIGTERM");
  }
  const code = d.relay ? await d.stopRelay() : null;
  note("relay.stopped", code);
}

// ---------------------------------------------------------------- part "worker"

async function partWorker(): Promise<void> {
  const d = new Daemon(["a.localhost"], false);
  await d.listen();
  startChromium(true);
  await linkUp(d);
  await sleep(1000);
  await d.ask("tabs.create", [{ url: `${A}/w1` }]);
  await sleep(1000);
  const p = pipe!;

  // C. A worker stop (Target.closeTarget on the worker, as Puppeteer's worker.close()).
  let w = (await p.worker())!;
  await p.evaluate(w.sessionId, `(async () => {
    self.__probe = "in-memory";
    await chrome.storage.session.set({ probe: { tab: 1, scope: "s1" } });
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: [{ id: 900, priority: 1, action: { type: "allow" }, condition: { requestDomains: ["x.example"], resourceTypes: ["main_frame"] } }] });
    return true; })()`);
  const tabsC0 = await tabs(d);
  const connectsC0 = d.hostConnects.length;
  await p.send("Target.closeTarget", { targetId: w.targetId });
  const stopAt = now();
  await sleep(10_000);
  const afterStop = { workerRunning: !!(await p.worker().then((x) => { if (x) void p.send("Target.detachFromTarget", { sessionId: x.sessionId }); return x; })),
    hostCloses: d.hostCloses.length, hostConnects: d.hostConnects.length - connectsC0 };
  note("C.after-stop-10s", afterStop);
  // An event of the extension's listeners (a new tab) starts the worker again.
  await p.send("Target.createTarget", { url: "about:blank" });
  const evAt = now();
  while (d.hostConnects.length === connectsC0 && now() - evAt < 15_000) await sleep(50);
  note("C.wake", { hostConnect_ms_after_event: now() - evAt, stopToEvent_ms: evAt - stopAt });
  await linkUp(d);
  w = (await p.worker())!;
  note("C.after-restart", { ...(await p.evaluate(w.sessionId, `(async () => ({ inMemory: self.__probe ?? null,
      session: (await chrome.storage.session.get("probe")).probe ?? null,
      sessionRules: (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id),
      dynamicRules: (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id) }))()`)),
    tabIdsKept: JSON.stringify((await tabs(d)).filter((t: any) => tabsC0.some((u: any) => u.id === t.id)).map((t: any) => t.id)) === JSON.stringify(tabsC0.map((t: any) => t.id)) });

  // G. Idle with the native port open: the worker keeps running (no new host connection, its in-memory value stays).
  await p.evaluate(w.sessionId, `self.__idle = "still here"; true`);
  await p.send("Target.detachFromTarget", { sessionId: w.sessionId });
  const connectsG0 = d.hostConnects.length, closesG0 = d.hostCloses.length;
  await sleep(IDLE_S * 1000);
  const g = await p.worker();
  if (g) w = g;
  note("G.idle", { idle_s: IDLE_S, workerRunning: !!g, inMemory: g ? await p.evaluate(g.sessionId, "self.__idle ?? null") : null,
    hostConnects: d.hostConnects.length - connectsG0, hostCloses: d.hostCloses.length - closesG0 });
  // D. An extension reload (chrome.runtime.reload in the worker: what the extensions page's reload does). Last: the
  // receiver may not come back.
  let wd = await p.worker();
  if (!wd) { await p.send("Target.createTarget", { url: "about:blank" }); await linkUp(d); wd = await p.worker(); }
  w = wd!;
  await p.evaluate(w.sessionId, `(async () => { await chrome.storage.session.set({ probe2: 2 }); await chrome.storage.local.set({ probe3: 3 });
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: [{ id: 901, priority: 1, action: { type: "allow" }, condition: { requestDomains: ["y.example"], resourceTypes: ["main_frame"] } }] });
    return true; })()`);
  const pageTabs = async () => (await p.send("Target.getTargets")).targetInfos.filter((t: any) => t.type === "page").map((t: any) => t.url);
  const extTargets = async () => (await p.send("Target.getTargets")).targetInfos.filter((t: any) => t.url.startsWith("chrome-extension://")).map((t: any) => `${t.type} ${t.url}`);
  const tabsD0 = await tabs(d);
  const connectsD0 = d.hostConnects.length;
  void p.evaluate(w.sessionId, "chrome.runtime.reload()").catch(() => {});
  const reloadAt = now();
  while (d.hostConnects.length === connectsD0 && now() - reloadAt < 10_000) await sleep(50);
  const byItself = d.hostConnects.length > connectsD0;
  const seen10s = await extTargets();
  let wake: number | null = null;
  if (!byItself) {
    // As after a stop: an event of the extension's listeners (a new tab with a page) should start the new worker.
    await p.send("Target.createTarget", { url: `${A}/d1` });
    const evAt = now();
    while (d.hostConnects.length === connectsD0 && now() - evAt < 15_000) await sleep(50);
    wake = d.hostConnects.length > connectsD0 ? now() - evAt : null;
  }
  note("D.reload", { connectedWithin10sByItself: byItself, extensionTargetsAt10s: seen10s, hostConnect_ms_after_event: wake,
    extensionTargetsAfterEvent: await extTargets(), pagesAfter: await pageTabs() });
  const w2 = await p.worker();
  if (w2) {
    note("D.after-reload", { ...(await p.evaluate(w2.sessionId, `(async () => ({
        session: chrome.storage ? await chrome.storage.session.get(null) : "no chrome.storage", local: chrome.storage ? await chrome.storage.local.get(null) : null,
        sessionRules: (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id),
        dynamicRules: (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id) }))()`)),
      tabsBefore: tabsD0.map((t: any) => t.id), link: d.bridgeUp ? (await tabs(d)).map((t: any) => t.id) : "no link" });
  } else note("D.after-reload", { worker: "none" });
  await stopChromium("SIGTERM");
}

// ---------------------------------------------------------------- part "ids"

/** Do the tab ids of a new browser run repeat ids of the run before it? Five runs ended by SIGKILL, five by SIGTERM. */
async function partIds(): Promise<void> {
  const d = new Daemon(["a.localhost"], false);
  await d.listen();
  const trials: unknown[] = [];
  for (const sig of ["SIGKILL", "SIGKILL", "SIGKILL", "SIGKILL", "SIGKILL", "SIGTERM", "SIGTERM", "SIGTERM", "SIGTERM", "SIGTERM"] as const) {
    startChromium(false);
    await linkUp(d);
    for (let i = 0; i < 3; i++) await d.ask("tabs.create", [{ url: `${A}/i${i}` }]);
    await sleep(800);
    const before = (await tabs(d)).map((t: any) => t.id);
    await stopChromium(sig);
    while (d.bridgeUp) await sleep(50);
    startChromium(false);
    await linkUp(d);
    await sleep(800);
    await d.ask("tabs.create", [{ url: `${A}/j` }]);
    await sleep(500);
    const after = (await tabs(d)).map((t: any) => t.id);
    trials.push({ sig, before, after, repeated: after.filter((id: number) => before.includes(id)) });
    await stopChromium("SIGTERM");
    while (d.bridgeUp) await sleep(50);
  }
  note("ids", trials);
}

let failed: string | undefined;
try {
  if (PART === "today") await partToday(); else if (PART === "ids") await partIds(); else await partWorker();
} catch (e) {
  failed = String((e as Error)?.stack ?? e);
  console.error(failed);
} finally {
  if (chromium) await stopChromium("SIGTERM");
  xvfb.kill("SIGTERM");
  site.close();
  results.pids = pids;
  results.chromiumVersion = readdirSync(join(PROFILE)).includes("Last Version") ? readFileSync(join(PROFILE, "Last Version"), "utf8").trim() : null;
  results.extension = { dir: EXT, id: EXT_ID, version: manifest.version };
  if (failed) results.failed = failed.split("\n")[0];
  writeFileSync(join(RUN, "results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(`results: ${join(RUN, "results.json")}${failed ? " (FAILED)" : ""}`);
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
}
