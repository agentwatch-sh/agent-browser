// The live check of the blanket profile on Linux (board ab-4wh.3; C12 and C11, the blanket profile): the real service in
// `--test` mode (temp folders only: state, tools, run, lists), on one display, under the harness guard
// (test/live/README.md), with the real pinned agent package and a copy of the box's Chromium in the temp tools folder
// (the same setup as test/live/service-link/check.ts; nothing is downloaded). It is the service's "daemon" on the control
// door. It never touches another Chrome, Xvfb, profile or folder.
//
//   1. the hello has the feature blanket_scope; set_sessions names one session with "blanket": true;
//   2. a CDP client's use of the blanket scope starts the unit's Xvfb alone and the blanket Chrome (board ab-4wh.8: no
//      main Chrome; `state` off), with --user-data-dir=<state>/blanket/profile, a new empty folder; the op `start`
//      later starts the main Chrome of the same copy on the same Xvfb;
//   3. Chrome installs the receiver in the new profile from the external extensions file, starts the host shim from
//      the blanket profile's own host manifest, and the shim reaches link-blanket.sock, whose peer check admits it (its
//      parent is the blanket Chrome); the main link never sees it;
//   4. the pinned receiver (0.3.15) has no feature `blanket` (C4's "*" comes with 0.3.16): the use gets the too-old
//      503, no "*" goes, the blanket Chrome stops, and status says why. With a receiver that has the feature, the
//      client is admitted to the blanket model, and a local host is refused with the public host class's text;
//   5. the address proxy (board ab-4wh.6; C11, the blanket profile): no proxy listens before the use; the blanket
//      Chrome's argv holds the proxy's flags before the chrome_args, and the main Chrome's argv holds none; a tab of the
//      blanket scope opens http://public.test:<port>/ (Chrome cannot resolve .test: only the proxy can, and its test hook
//      counts the check's local stand-in as public); from that page a fetch, a WebSocket, a worker's fetch and a
//      top-level navigation to private.test (a name that resolves to 127.0.0.1) fail, and so do a fetch and a WebSocket
//      to 127.0.0.1; the stand-in sees no request of them; the proxy logs each refusal with no host; WebRTC (the flag
//      --webrtc-ip-handling-policy=disable_non_proxied_udp, board ab-4wh.14): the page's RTCPeerConnection with a STUN
//      and a TURN server (UDP) and a TURN server (TCP) of this check on 127.0.0.1 gathers no UDP candidate, the UDP
//      stand-in gets no packet, and WebRTC's TCP does not reach the TCP stand-in;
//   6. session_ended deletes the blanket folder and stops the proxy (nothing listens on its port); the main Chrome and
//      Xvfb stay while the main Chrome runs, else Xvfb stops with the blanket Chrome; stop ends every process; the
//      service's stop removes its sockets.
//
// The service is blanket-service.ts (`service --test` with the address proxy's test resolver and stand-in hook). Every
// row is local: the stand-ins are servers of this check on 127.0.0.1 (HTTP and WebSocket, and WebRTC's UDP and TCP), and
// no name of the run resolves to a public address.
//
// Run it under the box's heavy lock:
//   flock <heavy.lock> timeout 1500 node test/live/service-blanket/check.ts --display 172

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createSocket } from "node:dgram";
import { connect, createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { WebSocketServer } from "ws";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CDPConnection } from "../../../src/cdp.ts";
import { AGENT_VERSION, RECEIVER_ID } from "../../../src/service/package/pins.ts";
import { PEER_TEXT } from "../../../src/service/blanket/proxy.ts";
import { GOOGLE_SOURCE, GoogleChromeTools } from "../../../src/service/unit/google-chrome.ts";
import { makeChromeRepo } from "../../chrome-fixture.ts";
import { harnessGuard, reservedDisplay } from "../guard.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SERVICE = join(ROOT, "test", "live", "service-blanket", "blanket-service.ts");
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
// :172 by default (as service-link/check.ts); :169 and :173 to :175 are other harnesses' displays on the Linux server.
const display = Number(arg("--display") ?? "172");
const refused = reservedDisplay(display, "--display") ?? ([169, 173, 174, 175].includes(display) ? `--display names :${display}, another harness's display` : null);
if (!Number.isSafeInteger(display) || refused) { process.stderr.write(`service-blanket: ${refused ?? "--display must be a number"}\n`); process.exit(2); }
if (existsSync(`/tmp/.X11-unix/X${display}`) || existsSync(`/tmp/.X${display}-lock`)) { process.stderr.write(`service-blanket: :${display} is in use; this check runs on a free display only\n`); process.exit(2); }
const CHROMIUM_TREE = "/usr/lib/chromium";
const TOO_OLD = "The agent browser is not ready: the blanket profile's extension is too old for the blanket profile.";

const t0 = Date.now();
const log = (s: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { step: string; ok: boolean; note: string }[] = [];
const check = (step: string, ok: boolean, note = "") => { results.push({ step, ok, note }); log(`${ok ? "PASS" : "FAIL"} ${step}${note ? `: ${note}` : ""}`); if (!ok) throw new Error(`${step} failed${note ? `: ${note}` : ""}`); };
const until = async (what: string, f: () => boolean, ms: number) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error(`${what}: not in ${ms / 1000} s`); await sleep(100); } };

function proc(pid: number): { start: number; ppid: number; argv: string[] } | null {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, "latin1");
    const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
    if (["Z", "X"].includes(f[0])) return null;
    return { start: Number(f[19]), ppid: Number(f[1]), argv: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean) };
  } catch { return null; }
}

const guard = await harnessGuard("service-blanket");
const dir = mkdtempSync(join(tmpdir(), "ab-blanket-live-"));
const run = join(dir, "run"), state = join(dir, "state"), tools = join(dir, "tools"), lists = join(dir, "lists");
mkdirSync(run, { mode: 0o700 });
mkdirSync(lists, { mode: 0o700 });
const started = new Map<number, number>();
let service: ChildProcess | null = null;
let serviceErr = "";
let repo: ReturnType<typeof makeChromeRepo> | null = null;
let closeStandIn = () => {};

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
      next: (want, ms = 30_000) => { const hit = lines.find(want); if (hit) return Promise.resolve(hit); return new Promise((done, fail) => { const w = { want, done: (l: any) => { clearTimeout(t); done(l); } }; waiters.push(w); const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); fail(new Error(`no such line in ${ms} ms: ${JSON.stringify(lines.slice(-5))}`)); }, ms); }); },
    }));
  });
}
let n = 0;
const req = async (d: Door, op: string, by: object, fields: object = {}, ms = 30_000) => { const id = `q${++n}`; d.send({ t: "req", id, op, by, ...fields }); return d.next((l) => l.t === "res" && l.id === id, ms); };
const TOKEN = { kind: "token", user: "live", via: "cli" }, DAEMON = { kind: "daemon", user: "live", via: "daemon" };
const me = proc(process.pid)!;
const SESSION = { scope: "live-bl", repo: "local/test", roots: [{ pid: process.pid, start: me.start }], cgroup: null, lifetime_id: "lt-live", mcp_token: null, blanket: true };
function track(pid: number | null | undefined, name: string): void {
  if (!pid) return;
  const p = proc(pid);
  if (p) { started.set(pid, p.start); guard.track(pid, name); }
}
async function stopService(): Promise<number | null> {
  const s = service;
  if (!s || s.exitCode !== null) return s?.exitCode ?? null;
  const exited = new Promise<number | null>((r) => s.once("exit", (c) => r(c)));
  s.kill("SIGTERM");
  return Promise.race([exited, sleep(15_000).then(() => { s.kill("SIGKILL"); return -1; })]);
}
/** The pids that the service's log names for a pattern with one number group, in order. */
const pidsOf = (re: RegExp) => [...serviceErr.matchAll(re)].map((m) => Number(m[1]));
const blanketProfile = join(state, "blanket", "profile");
/** The Chromes that run on `profile` now (their main process: the parent is not on the profile). */
const chromesOn = (profile: string) => {
  const on = readdirSync("/proc").filter((x) => /^\d+$/.test(x)).map(Number).filter((pid) => proc(pid)?.argv.includes(`--user-data-dir=${profile}`));
  return on.filter((pid) => !on.includes(proc(pid)?.ppid ?? -1));
};
/** The Chromes that run on the blanket profile now. */
const blanketChromes = () => chromesOn(blanketProfile);
/** The main Chromes that run on the agent profile now (board ab-4wh.8: none at a blanket use). */
const mainChromes = () => chromesOn(join(state, "profile"));

let code = 0;
/** The address proxy's port while the blanket Chrome ran (row 6 checks that nothing listens on it after the end). */
let proxyAt: number | null = null;
try {
  const argv = readFileSync("/proc/self/cmdline", "utf8").split("\0").filter((x, i, a) => i < a.length - 1 || x !== "");
  writeFileSync(join(dir, "daemon-command.json"), JSON.stringify({ v: 1, interpreter: realpathSync(process.execPath), args: argv.slice(1) }), { mode: 0o600 });
  repo = makeChromeRepo({ version: "158.0.7100.1-1", chrome: `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Google Chrome 158.0.7100.1 "; exit 0; fi\nexec "$(dirname "$0")/chromium" "$@"\n` });
  writeFileSync(join(dir, "source.json"), JSON.stringify({ repo: repo.repo, key: repo.keyFile, fingerprints: [repo.fingerprint] }));
  chmodSync(dir, 0o700);
  const installer = new GoogleChromeTools({ tools, source: { ...GOOGLE_SOURCE, repo: repo.repo, keyFile: repo.keyFile, fingerprints: [repo.fingerprint] }, log: (l) => log(`installer: ${l}`) });
  const copy = await installer.ensure();
  for (const e of readdirSync(CHROMIUM_TREE)) cpSync(join(CHROMIUM_TREE, e), join(copy.binary, "..", e), { recursive: true, force: true });
  check("the copy of Google Chrome in the temp tools folder holds the Chromium tree", existsSync(join(copy.binary, "..", "chromium")) && statSync(copy.binary).isFile());
  writeFileSync(join(lists, "local.test.json"), JSON.stringify({ allow: ["app.localhost"], repo: "local/test" }), { mode: 0o600 });
  // A blanket folder of an "earlier run": the service's start deletes it.
  mkdirSync(join(blanketProfile, "Default"), { recursive: true, mode: 0o700 });
  // (a file name of its own: Chrome writes its own Cookies file in a new profile)
  writeFileSync(join(blanketProfile, "Default", "earlier-run.txt"), "an earlier run");

  // The local stand-in of a public host (board ab-4wh.6): the address proxy's test hook counts public.test at this port as
  // public; private.test and 127.0.0.1 reach the same server only if the proxy let them through. It keeps each Host.
  const seen: string[] = [];
  const WORKER = `onmessage = async (e) => { const out = {}; for (const [k, u] of Object.entries(e.data)) { try { await fetch(u, { mode: "no-cors", cache: "no-store" }); out[k] = "reached"; } catch { out[k] = "failed"; } } postMessage(out); };`;
  const standIn = createHttpServer((q, s) => {
    const host = String(q.headers.host ?? "");
    seen.push(`${host} ${q.url}`);
    if (!host.startsWith("public.test:")) { s.writeHead(200, { "content-type": "text/html" }); s.end("<!doctype html><title>reached</title>reached"); return; }
    if (q.url === "/") { s.writeHead(200, { "content-type": "text/html" }); s.end("<!doctype html><title>stand-in</title><p>stand-in</p>"); return; }
    if (q.url === "/ok") { s.writeHead(200, { "content-type": "text/plain" }); s.end("ok"); return; }
    if (q.url === "/worker.js") { s.writeHead(200, { "content-type": "text/javascript" }); s.end(WORKER); return; }
    s.writeHead(404); s.end();
  });
  const wss = new WebSocketServer({ server: standIn });
  wss.on("connection", (ws, q) => { seen.push(`ws ${q.headers.host} ${q.url}`); ws.send("hi"); });
  await new Promise<void>((r) => standIn.listen(0, "127.0.0.1", () => r()));
  const P = (standIn.address() as AddressInfo).port;
  // WebRTC's stand-ins (board ab-4wh.14): a UDP socket for the STUN and the TURN-over-UDP server, and a TCP server for
  // the TURN-over-TCP server, each on 127.0.0.1. They count what reaches them and answer nothing.
  const rtcUdp = createSocket("udp4");
  let rtcPackets = 0, rtcConnections = 0;
  rtcUdp.on("message", () => { rtcPackets++; });
  await new Promise<void>((r) => rtcUdp.bind(0, "127.0.0.1", () => r()));
  const rtcTcp = createTcpServer((c) => { rtcConnections++; c.destroy(); });
  await new Promise<void>((r) => rtcTcp.listen(0, "127.0.0.1", () => r()));
  const U = rtcUdp.address().port, T = (rtcTcp.address() as AddressInfo).port;
  closeStandIn = () => { wss.close(); standIn.closeAllConnections(); standIn.close(); try { rtcUdp.close(); } catch {} rtcTcp.close(); };

  // 1. The service, its hello, set_sessions with the blanket item.
  service = spawn(process.execPath, ["--disable-sigusr1", SERVICE, run, state, tools, lists, String(display), join(dir, "source.json"), String(P)], { stdio: ["ignore", "ignore", "pipe"] });
  guard.track(service.pid, "service");
  started.set(service.pid!, proc(service.pid!)?.start ?? -1);
  service.stderr!.on("data", (d) => { serviceErr += d; });
  for (let i = 0; i < 300 && !serviceErr.includes("service: ready"); i++) { if (service.exitCode !== null) break; await sleep(50); }
  check("the service starts in --test mode with the native link", /service: ready \(pid \d+; the Chrome unit runs, with the native link\)/.test(serviceErr), serviceErr.slice(-300));
  check("the service's start deleted the blanket folder of an earlier run", !existsSync(join(state, "blanket")));
  const d = await door();
  const hello = await d.next((l) => l.t === "hello");
  check("the hello has the feature blanket_scope", Array.isArray(hello.features) && hello.features.includes("blanket_scope"), JSON.stringify(hello.features));
  d.send({ t: "hello", v: 1, side: "daemon", version: "live", features: [] });
  const cfg = await req(d, "config", { kind: "daemon", user: "live", via: "config" }, { enabled: true, control: true, chrome_bin: null, chrome_args: [], display_size: "1280x900" });
  check("config answers ok", cfg.ok === true, JSON.stringify(cfg));
  const ss = await req(d, "set_sessions", DAEMON, { sessions: [SESSION], remote: [], box: { hosts: ["box.localhost"], cookie_names: [] } });
  check("set_sessions with a blanket item answers ok", ss.ok === true, JSON.stringify(ss));
  const url = (await req(d, "endpoint", DAEMON, { scope: "live-bl" })).data.url as string;
  check("the blanket scope's endpoint is the same URL form as any scope's", url === `ws+unix://${join(run, "cdp.sock")}:/devtools/browser/live-bl`, url);

  // 2. and 3. The use: the unit's Xvfb alone, the blanket Chrome, its receiver and its shim on the blanket link.
  check("no address proxy listens before the blanket scope's first use", !serviceErr.includes("blanket: the address proxy listens"));
  let cdp: CDPConnection | null = null;
  let refusal = "";
  const watcher = setInterval(() => { for (const pid of blanketChromes()) if (!started.has(pid)) track(pid, "blanket chrome"); const rec = existsSync(join(state, "unit.json")) ? JSON.parse(readFileSync(join(state, "unit.json"), "utf8")) : null; if (rec) { track(rec.chrome_pid, "chrome"); track(rec.xvfb_pid, "xvfb"); } }, 100);
  try { cdp = await CDPConnection.connect(url, 120_000); } catch (e) { refusal = (e as Error).message; }
  clearInterval(watcher);
  const blanketPid = pidsOf(/blanket: (?:Google Chrome \S+|Chromium) started on the blanket profile \(pid (\d+)\)/g).at(-1);
  check("the use started the blanket Chrome", blanketPid !== undefined, serviceErr.match(/blanket: .*/g)?.slice(-6).join(" | ") ?? "");
  track(blanketPid, "blanket chrome");
  const rec = JSON.parse(readFileSync(join(state, "unit.json"), "utf8"));
  check("the unit's Xvfb runs alone: the use started no main Chrome (board ab-4wh.8)", rec.wanted === false && rec.chrome_pid === null && !!proc(rec.xvfb_pid) && mainChromes().length === 0, JSON.stringify({ wanted: rec.wanted, chrome_pid: rec.chrome_pid, main: mainChromes() }));
  check("the blanket Chrome's folder was made new: no file of the earlier run", existsSync(join(blanketProfile, "Default", "Preferences")) && !existsSync(join(blanketProfile, "Default", "earlier-run.txt")));
  const manifest = JSON.parse(readFileSync(join(blanketProfile, "NativeMessagingHosts", "sh.agentwatch.browser.json"), "utf8"));
  check("the blanket profile's host manifest names agent-browser-host-blanket and only the receiver", manifest.path === join(state, "agent-browser-host-blanket") && JSON.stringify(manifest.allowed_origins) === JSON.stringify([`chrome-extension://${RECEIVER_ID}/`]));
  check("the wrapper gives the shim link-blanket.sock and the blanket profile", readFileSync(join(state, "agent-browser-host-blanket"), "utf8").includes(`'${join(run, "link-blanket.sock")}'`) && readFileSync(join(state, "agent-browser-host-blanket"), "utf8").includes(`'${blanketProfile}'`));
  const blanketShims = pidsOf(/blanket: link: the host shim connected \(pid (\d+)\)/g);
  check("the blanket Chrome's shim reached link-blanket.sock and its peer check admitted it (its parent is the blanket Chrome)", blanketShims.length >= 1, serviceErr.match(/blanket: link: .*/g)?.join(" | ") ?? "no blanket link line");
  check("the receiver said its hello on the blanket link", serviceErr.includes(`blanket: link: the receiver ${AGENT_VERSION} said hello`), serviceErr.match(/blanket: link: the receiver.*/)?.[0] ?? "");
  const exts = existsSync(join(blanketProfile, "Default", "Extensions")) ? readdirSync(join(blanketProfile, "Default", "Extensions")) : [];
  check("Chrome installed the receiver into the new blanket profile from the external extensions file", exts.includes(RECEIVER_ID), exts.join(" "));
  const mainShims = pidsOf(/(?<!blanket: )link: the host shim connected \(pid (\d+)\)/g).filter((p) => !blanketShims.includes(p));
  check("the main link saw no shim (no main Chrome runs)", mainShims.length === 0 && !/(?<!blanket: )link: refused/.test(serviceErr), `main ${mainShims.join(",")}; blanket ${blanketShims.join(",")}`);

  // 4. The receiver's feature decides.
  const st = (await req(d, "status", DAEMON)).data;
  const item = st.sessions.find((s: any) => s.scope === "live-bl");
  check("status: the main Chrome's state is off and chrome_pid null while only Xvfb and the blanket Chrome run", st.state === "off" && st.chrome_pid === null, JSON.stringify({ state: st.state, chrome_pid: st.chrome_pid }));
  if (cdp === null) {
    check("the pinned receiver has no feature blanket: the use gets the too-old 503", refusal.includes(TOO_OLD), refusal);
    check("no \"*\" went: the service sent no set_scopes on the blanket link", !/blanket: link: .*set_scopes/.test(serviceErr) && !serviceErr.includes("blanket: the blanket Chrome of the session live-bl is ready"));
    await until("the blanket Chrome stops", () => blanketChromes().length === 0, 20_000);
    check("status: blanket true, blanket_state failed, list null, and the operator's sentence", item.blanket === true && item.blanket_state === "failed" && item.list === null && st.operator_text.includes("The blanket Chrome of the session live-bl could not start: the blanket profile's extension is too old for the blanket profile."), JSON.stringify(item));
  } else {
    check("the receiver has the feature blanket: the blanket model admits the client", (await cdp.send("Browser.getVersion")).product.length > 0);
    const local = await cdp.send("Target.createTarget", { url: "http://app.localhost:9/" }).then(() => "no refusal", (e: Error) => e.message);
    check("a local host is refused with the public host class's text", local.includes("app.localhost is not a public host name"), local);
    check("status: blanket_state ready", item.blanket_state === "ready", JSON.stringify(item));

    // Board ab-4wh.8: the op `start` starts the main Chrome on the blanket Chrome's Xvfb.
    const s5 = await req(d, "start", TOKEN, {}, 120_000);
    const rec2 = JSON.parse(readFileSync(join(state, "unit.json"), "utf8"));
    track(rec2.chrome_pid, "chrome");
    check("the op start starts the main Chrome on the same Xvfb as the blanket Chrome", s5.ok === true && !!proc(rec2.chrome_pid) && rec2.xvfb_pid === rec.xvfb_pid && !!proc(rec.xvfb_pid) && blanketChromes().length === 1, JSON.stringify(s5));

    // 5. The address proxy (board ab-4wh.6).
    const bArgv = proc(blanketPid!)?.argv ?? [], mArgv = proc(rec2.chrome_pid)?.argv ?? [];
    const flag = bArgv.find((a) => a.startsWith("--proxy-server="));
    const proxyPort = Number(/^--proxy-server=socks5:\/\/127\.0\.0\.1:(\d+)$/.exec(flag ?? "")?.[1]);
    const flags = [`--proxy-server=socks5://127.0.0.1:${proxyPort}`, "--proxy-bypass-list=<-loopback>", "--webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-quic"];
    const at = bArgv.indexOf(flags[0]);
    check("the blanket Chrome's argv holds the address proxy's flags, before the config's chrome_args (none here) and about:blank", Number.isSafeInteger(proxyPort) && at > 0 && JSON.stringify(bArgv.slice(at, at + 5)) === JSON.stringify([...flags, "about:blank"]), bArgv.slice(at).join(" "));
    check("the main Chrome's argv holds none of them", mArgv.length > 0 && !mArgv.some((a) => /proxy|webrtc|quic/i.test(a)), mArgv.filter((a) => /proxy|webrtc|quic/i.test(a)).join(" "));
    const listens = [...serviceErr.matchAll(/blanket: the address proxy listens on 127\.0\.0\.1:(\d+)/g)].map((m) => Number(m[1]));
    check("the address proxy listens on 127.0.0.1 at the flag's port, started once for this blanket Chrome", JSON.stringify(listens) === JSON.stringify([proxyPort]), listens.join(","));
    const page = `http://public.test:${P}/`;
    const { targetId } = await cdp.send("Target.createTarget", { url: page });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const ev = async (expression: string) => (await cdp!.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
    let title = "";
    for (let i = 0; i < 75 && title !== "stand-in"; i++) { title = await ev("document.title").catch(() => ""); if (title !== "stand-in") await sleep(200); }
    check("a public-form request passes through the proxy: the blanket tab opens http://public.test:<port>/ (only the proxy resolves .test; its test hook counts the local stand-in as public)", title === "stand-in" && seen.some((x) => x.startsWith(`public.test:${P} / `) || x === `public.test:${P} /`), `${title}; ${seen.join(" | ")}`);
    const out = await ev(`(async () => {
      const P = ${P};
      const tryFetch = (u) => Promise.race([fetch(u, { mode: "no-cors", cache: "no-store" }).then(() => "reached", () => "failed"), new Promise((r) => setTimeout(() => r("timeout"), 8000))]);
      const tryWs = (u) => new Promise((r) => { let w; try { w = new WebSocket(u); } catch { r("failed"); return; } const t = setTimeout(() => { try { w.close(); } catch {} r("timeout"); }, 8000); w.onopen = () => { clearTimeout(t); w.close(); r("opened"); }; w.onerror = () => { clearTimeout(t); r("failed"); }; });
      const worker = () => new Promise((r) => { const w = new Worker("/worker.js"); const t = setTimeout(() => r({ timeout: true }), 12000); w.onmessage = (e) => { clearTimeout(t); r(e.data); w.terminate(); }; w.postMessage({ ok: "/ok", priv: "http://private.test:" + P + "/w" }); });
      return { ok: await tryFetch("/ok"), wsPub: await tryWs("ws://public.test:" + P + "/ws"), priv: await tryFetch("http://private.test:" + P + "/f"), wsPriv: await tryWs("ws://private.test:" + P + "/ws"),
        literal: await tryFetch("http://127.0.0.1:" + P + "/lit"), wsLit: await tryWs("ws://127.0.0.1:" + P + "/ws"), worker: await worker() };
    })()`);
    log(`the page's results: ${JSON.stringify(out)}`);
    check("the controls pass through the proxy: the page's fetch of /ok and its WebSocket to public.test", out?.ok === "reached" && out?.wsPub === "opened" && out?.worker?.ok === "reached", JSON.stringify(out));
    check("a fetch to private.test (a name that resolves to 127.0.0.1) fails", out?.priv === "failed", JSON.stringify(out));
    check("a WebSocket to private.test fails", out?.wsPriv === "failed", JSON.stringify(out));
    check("a worker's fetch to private.test fails", out?.worker?.priv === "failed", JSON.stringify(out));
    check("a fetch and a WebSocket to 127.0.0.1 fail", out?.literal !== "reached" && out?.wsLit !== "opened", JSON.stringify(out));
    // The WebRTC flag (board ab-4wh.14): with --webrtc-ip-handling-policy=disable_non_proxied_udp the blanket Chrome sends
    // no UDP of WebRTC (its only way is TCP through the proxy).
    const refusedV4 = () => serviceErr.split("\n").filter((l) => l === "blanket: the address proxy refused a connection to an IPv4 address: it is a loopback address").length;
    const v4Before = refusedV4();
    const rtc = await ev(`(async () => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${U}" }, { urls: "turn:127.0.0.1:${U}?transport=udp", username: "live", credential: "live" }, { urls: "turn:127.0.0.1:${T}?transport=tcp", username: "live", credential: "live" }] });
      const cands = [];
      pc.onicecandidate = (e) => { if (e.candidate && e.candidate.candidate) cands.push(e.candidate.candidate); };
      pc.createDataChannel("live");
      await pc.setLocalDescription(await pc.createOffer());
      const state = await new Promise((r) => { if (pc.iceGatheringState === "complete") return r("complete"); const t = setTimeout(() => r("timeout"), 10000); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); r("complete"); } }; });
      const sdp = pc.localDescription ? pc.localDescription.sdp : "";
      pc.close();
      const all = [...cands, ...sdp.split(/\\r?\\n/).filter((l) => l.startsWith("a=candidate:")).map((l) => l.slice(2))];
      const proto = (c) => (c.split(" ")[2] || "").toLowerCase();
      return { state, candidates: cands.length, udp: all.filter((c) => proto(c) === "udp").length, kinds: [...new Set(all.map((c) => ((/ typ (\\w+)/.exec(c) || [])[1]) + "/" + proto(c)))] };
    })()`);
    await sleep(500);
    log(`the page's WebRTC gathering: ${JSON.stringify(rtc)}; the UDP stand-in got ${rtcPackets} packet(s), the TCP stand-in ${rtcConnections} connection(s); the proxy refused ${refusedV4() - v4Before} more connection(s) to a loopback IPv4 address`);
    check("WebRTC (--webrtc-ip-handling-policy=disable_non_proxied_udp): the page's RTCPeerConnection with a STUN and a TURN server on 127.0.0.1 gathers no UDP candidate, and the local UDP stand-in gets no packet", rtc?.state !== undefined && rtc.udp === 0 && rtcPackets === 0, `${JSON.stringify(rtc)}; ${rtcPackets} packet(s)`);
    check("WebRTC's TCP to a TURN stand-in on 127.0.0.1 does not reach it (TCP goes through the proxy, whose rule refuses a loopback address)", rtcConnections === 0, `${rtcConnections} connection(s)`);
    await ev(`location.href = "http://private.test:${P}/top"; 1`).catch(() => null);
    await sleep(3_000);
    const after = await ev("document.title").catch((e: Error) => `(${e.message})`);
    check("a top-level navigation of the page to private.test does not load it", after !== "reached", String(after));
    check("the stand-in saw no request of private.test or of 127.0.0.1: each one stopped before it (the proxy, or for 127.0.0.1 Chrome's own check)", seen.every((x) => x.startsWith(`public.test:${P} `) || x.startsWith(`ws public.test:${P} `)), seen.join(" | "));
    const refusals = serviceErr.split("\n").filter((l) => l.startsWith("blanket: the address proxy refused"));
    const byName = refusals.filter((l) => l === "blanket: the address proxy refused a connection to a name: it has a loopback address").length;
    check("the proxy refused private.test at least 4 times (the fetch, the WebSocket, the worker's fetch, the navigation), each with one log line", byName >= 4, `${byName}; ${refusals.slice(0, 8).join(" | ")}`);
    const proxyLines = serviceErr.split("\n").filter((l) => l.startsWith("blanket: the address proxy") && !l.startsWith("blanket: the address proxy listens on"));
    check("no log line of the proxy holds a host or an address of the run", proxyLines.length > 0 && !proxyLines.some((l) => /private\.test|public\.test|127\.0\.0\.1/.test(l)), proxyLines.slice(0, 4).join(" | "));
    log(`note: the proxy's refusals of an IPv4 address: ${refusals.filter((l) => l.includes("to an IPv4 address")).length} (0 means Chrome's own check stopped the requests to 127.0.0.1 first)`);
    log(`note: the proxy's refusals of a client: ${refusals.filter((l) => l === `blanket: the address proxy refused ${PEER_TEXT.closed}`).length} closed before its peer check, ${refusals.filter((l) => l.includes("it is not a process of the service's user")).length} as a stranger`);
    await cdp.close();
    proxyAt = proxyPort;
  }

  // 6. The end, the stop, the sockets.
  const e5 = await req(d, "session_ended", DAEMON, { scope: "live-bl" });
  await until("the blanket folder goes at the scope's end", () => !existsSync(join(state, "blanket")) && blanketChromes().length === 0, 20_000);
  check("session_ended: the blanket Chrome is gone and the blanket folder is deleted", e5.ok === true);
  // Board ab-4wh.8: Xvfb runs while either Chrome runs.
  const latest = JSON.parse(readFileSync(join(state, "unit.json"), "utf8"));
  if (latest.chrome_pid !== null && proc(latest.chrome_pid)) check("the main Chrome and Xvfb stay after the blanket Chrome's end", !!proc(latest.xvfb_pid));
  else {
    await until("Xvfb stops with the blanket Chrome (no main Chrome runs)", () => !proc(rec.xvfb_pid), 15_000);
    check("Xvfb stops with the blanket Chrome when no main Chrome runs", true);
  }
  if (proxyAt !== null) {
    await until("the address proxy stops", () => /blanket: the address proxy stopped \(\d+ connection\(s\) passed, \d+ refused\)/.test(serviceErr), 20_000);
    const answer = await new Promise<string>((r) => { const s = connect(proxyAt!, "127.0.0.1"); s.on("connect", () => { s.destroy(); r("connected"); }); s.on("error", (e: NodeJS.ErrnoException) => r(e.code ?? "error")); });
    check("after the end nothing listens on the address proxy's port", answer === "ECONNREFUSED", answer);
  }
  const b6 = await req(d, "stop", TOKEN, {}, 30_000);
  await until("Chrome and Xvfb end", () => (latest.chrome_pid === null || !proc(latest.chrome_pid)) && !proc(latest.xvfb_pid) && !proc(rec.xvfb_pid), 15_000);
  check("stop: the main Chrome and Xvfb end", b6.ok === true);
  d.s.end();
  const exit = await stopService();
  check("the service's stop removes its sockets, link-blanket.sock too", exit === 0 && !existsSync(join(run, "link.sock")) && !existsSync(join(run, "link-blanket.sock")) && !existsSync(join(run, "control.sock")) && !existsSync(join(run, "cdp.sock")));
  check("the display is free again", !existsSync(`/tmp/.X11-unix/X${display}`));
} catch (e) {
  code = 1;
  log(`FAIL: ${(e as Error).message}`);
  if (serviceErr) log(`the service's log (end):\n${serviceErr.slice(-4000)}`);
} finally {
  await stopService();
  closeStandIn();
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
