// The live check of the blanket profile on the Mac (board ab-4wh.16; C12, the blanket profile on the Mac; C11, the
// blanket profile: the address proxy). The manager runs it on the Mac, with the operator at the Mac for the one set-up
// (a Load unpacked in the set-up Chrome's window); a later run with the same --state skips the set-up. It runs the real
// service (blanket-mac-service.ts) with a temp run folder and lists folder and the check's own state folder, and it is
// the service's "daemon" on the control door. It starts Chrome only through the service, on the state folder's
// profiles, and it never touches the operator's Chrome, the agent browser of agentwatch, its folders or its service.
// Every page of the run is local: the stand-in is a server of this check on 127.0.0.1, and no name of the run resolves
// to a public address in the proxy's test resolver, so each other request of Chrome through the proxy is refused. Chrome's
// DNS-over-HTTPS requests and its Cast discovery bypass the proxy (C11's stated limits of the blanket profile).
//
//   1. the hello has the features blanket_scope and blanket_setup; set_sessions names one session with "blanket": true;
//      status has blanket_template, and with no template operator_text gives the steps with the real folder path;
//   2. with no template: the op blanket_setup (the operator's kind) answers ok at once; the set-up Chrome opens on the
//      Mac's screen, and the operator loads <state>/agent-package-blanket there (the check prints the steps); the
//      service reads the template, stops the set-up Chrome, and blanket_template is ready; the template's files hold
//      the load; no Chrome runs on the template's profile after it;
//   3. a CDP client's use of the blanket scope starts only the blanket Chrome, through open -n -g: a child of launchd,
//      on <state>/blanket/profile, whose arguments hold the address proxy's four flags with the port that the proxy
//      listens on; no agent Chrome runs on <state>/profile; the copy's Secure Preferences is there; the receiver's
//      hello on the blanket link; the client is admitted, and a local host is refused with the public host class's text;
//   4. the address proxy with the Mac's peer check: a tab of the blanket scope opens http://public.test:<port>/; from
//      that page a fetch, a WebSocket and a worker's fetch to public.test pass, and the same to private.test (a name that
//      resolves to 127.0.0.1) and to 127.0.0.1 fail, and a top-level navigation to private.test does not load; the
//      stand-in sees no request of them; no log line of the proxy names a host;
//   5. session_ended deletes the blanket folder and stops the proxy (nothing listens on its port); the template stays;
//      the service's stop removes its sockets; then the proxy's log of the whole run: no client of the blanket Chrome
//      refused as a stranger (a client that closed before its peer check has its own line, which passes).
//
// Run it (the Mac only, as the operator's user, from this checkout; node with node:ffi, as the service runs):
//   node test/live/service-blanket-mac/check.ts --state ~/ab-blanket-live
// `--state <dir>`: the state folder: a new or empty folder (made with mode 0700 when it is missing), or one that this
// check used before (its mark file, written at its first use). Any other folder is refused (the review's m6): the
// service's start deletes <state>/blanket there. Its blanket-template stays after the run, so the next run with the same
// --state needs no operator. Delete it when the checks end.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { CDPConnection } from "../../../src/cdp.ts";
import { AGENT_VERSION, RECEIVER_ID } from "../../../src/service/package/pins.ts";
import { checkLoad, TEMPLATE_TEXT } from "../../../src/service/blanket/template.ts";
import { PEER_TEXT } from "../../../src/service/blanket/proxy.ts";
import { loadMacLib, MacProcs } from "../../../src/service/mac.ts";
import { BLANKET_PACKAGE_FOLDER } from "../../../src/service/unit/mac-chrome.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SERVICE = join(ROOT, "test", "live", "service-blanket-mac", "blanket-mac-service.ts");
const MARK = ".ab-blanket-mac-check";
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
if (process.platform !== "darwin") { process.stderr.write("service-blanket-mac: the Mac only\n"); process.exit(2); }
const stateArg = arg("--state");
if (!stateArg) { process.stderr.write("service-blanket-mac: --state <dir> is required (a folder of this check)\n"); process.exit(2); }
const state = resolve(stateArg.replace(/^~(?=\/|$)/, homedir()));
for (const forbidden of [join(homedir(), ".local", "share", "agentwatch-browser"), join(homedir(), ".config", "agentwatch"), join(homedir(), "Library", "Application Support")]) {
  if (state === forbidden || state.startsWith(`${forbidden}/`)) { process.stderr.write(`service-blanket-mac: --state may not be in ${forbidden}\n`); process.exit(2); }
}
if (existsSync(state)) {
  const st = lstatSync(state);
  if (!st.isDirectory() || (!existsSync(join(state, MARK)) && readdirSync(state).length > 0)) {
    process.stderr.write("service-blanket-mac: --state must be a new or empty folder, or a folder that this check used before (its mark file)\n");
    process.exit(2);
  }
}
const TEXT_PUBLIC = "is not a public host name";

const t0 = Date.now();
const log = (s: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { step: string; ok: boolean; note: string }[] = [];
const check = (step: string, ok: boolean, note = "") => { results.push({ step, ok, note }); log(`${ok ? "PASS" : "FAIL"} ${step}${note ? `: ${note}` : ""}`); if (!ok) throw new Error(`${step} failed${note ? `: ${note}` : ""}`); };
const until = async (what: string, f: () => boolean, ms: number) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error(`${what}: not in ${ms / 1000} s`); await sleep(200); } };

// The Mac's process reads: libSystem (the service's own reader) for this process's start time, ps for the rest.
const lib = await loadMacLib();
if ("failed" in lib) { process.stderr.write(`service-blanket-mac: ${lib.failed}\n`); process.exit(2); }
const procs = new MacProcs(lib);
/** Every process of this user: pid, parent and arguments (ps joins the arguments with spaces). */
function table(): { pid: number; ppid: number; args: string }[] {
  const out = execFileSync("/bin/ps", ["-axww", "-o", "pid=,ppid=,args="], { encoding: "utf8", maxBuffer: 16 << 20 });
  return out.split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter((m) => m !== null).map((m) => ({ pid: Number(m![1]), ppid: Number(m![2]), args: m![3] }));
}
const startOf = (pid: number) => procs.bsd(pid)?.start ?? null;
/** The main processes (no --type=) on a profile. */
const mainsOn = (profile: string) => table().filter((p) => p.args.includes(`--user-data-dir=${profile}`) && !p.args.includes("--type="));

const created = !existsSync(state);
mkdirSync(state, { recursive: true, mode: 0o700 });
writeFileSync(join(state, MARK), "the state folder of test/live/service-blanket-mac/check.ts\n", { mode: 0o600 });
const dir = mkdtempSync("/tmp/ab-blanket-mac-");
const run = join(dir, "run"), lists = join(dir, "lists");
mkdirSync(run, { mode: 0o700 });
mkdirSync(lists, { mode: 0o700 });
const started = new Map<number, number | null>();
const track = (pid: number | undefined) => { if (pid && !started.has(pid)) started.set(pid, startOf(pid)); };
let service: ChildProcess | null = null;
let serviceErr = "";
let closeStandIn = () => {};
const blanketProfile = join(state, "blanket", "profile"), templateProfile = join(state, "blanket-template", "profile"), pkg = join(state, BLANKET_PACKAGE_FOLDER);

type Door = { s: Socket; lines: any[]; next: (want: (l: any) => boolean, ms?: number) => Promise<any>; send: (o: object) => void };
function door(): Promise<Door> {
  return new Promise((resolveDoor, reject) => {
    const s = connect(join(run, "control.sock"));
    const lines: any[] = [];
    let buf = "";
    const waiters: { want: (l: any) => boolean; done: (l: any) => void }[] = [];
    s.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); lines.push(l); for (const w of [...waiters]) if (w.want(l)) { waiters.splice(waiters.indexOf(w), 1); w.done(l); } } });
    s.on("error", reject);
    s.once("connect", () => resolveDoor({
      s, lines, send: (o) => s.write(JSON.stringify(o) + "\n"),
      next: (want, ms = 30_000) => { const hit = lines.find(want); if (hit) return Promise.resolve(hit); return new Promise((done, fail) => { const w = { want, done: (l: any) => { clearTimeout(t); done(l); } }; waiters.push(w); const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); fail(new Error(`no such line in ${ms} ms`)); }, ms); }); },
    }));
  });
}
let n = 0;
const req = async (d: Door, op: string, by: object, fields: object = {}, ms = 30_000) => { const id = `q${++n}`; d.send({ t: "req", id, op, by, ...fields }); return d.next((l) => l.t === "res" && l.id === id, ms); };
const OPERATOR = { kind: "operator", user: "live", via: "web" }, TOKEN = { kind: "token", user: "live", via: "cli" }, DAEMON = { kind: "daemon", user: "live", via: "daemon" };
async function stopService(): Promise<number | null> {
  const s = service;
  if (!s || s.exitCode !== null) return s?.exitCode ?? null;
  const exited = new Promise<number | null>((r) => s.once("exit", (c) => r(c)));
  s.kill("SIGTERM");
  return Promise.race([exited, sleep(20_000).then(() => { s.kill("SIGKILL"); return -1; })]);
}
const pidsOf = (re: RegExp) => [...serviceErr.matchAll(re)].map((m) => Number(m[1]));

let code = 0;
try {
  const myStart = startOf(process.pid);
  check("this check's start time reads through libSystem", myStart !== null);
  const SESSION = { scope: "live-bl", repo: "local/test", roots: [{ pid: process.pid, start: myStart }], cgroup: null, lifetime_id: "lt-live", mcp_token: null, blanket: true };
  // The control door compares the peer's arguments as the kernel holds them (KERN_PROCARGS2), exactly: node's
  // process.argv makes a relative script path absolute, so the expected command comes from this process's own read
  // through the service's reader (the first Mac run, 2026-11-26: a relative path failed rule 3).
  const argv = procs.cmdline(process.pid);
  check("this check's own arguments read through KERN_PROCARGS2", argv.length > 1, JSON.stringify(argv.length));
  writeFileSync(join(dir, "daemon-command.json"), JSON.stringify({ v: 1, interpreter: realpathSync(process.execPath), args: argv.slice(1) }), { mode: 0o600 });
  writeFileSync(join(lists, "local.test.json"), JSON.stringify({ allow: ["app.localhost"], repo: "local/test" }), { mode: 0o600 });
  // A blanket folder of an "earlier run": the service's start deletes it.
  mkdirSync(join(blanketProfile, "Default"), { recursive: true, mode: 0o700 });
  writeFileSync(join(blanketProfile, "Default", "earlier-run.txt"), "an earlier run");

  // The local stand-in of a public host: the address proxy's test hook counts public.test at this port as public.
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
  closeStandIn = () => { wss.close(); standIn.closeAllConnections(); standIn.close(); };

  // 1. The service, its hello, set_sessions with the blanket item, status.
  service = spawn(process.execPath, ["--disable-sigusr1", SERVICE, run, state, lists, String(P)], { stdio: ["ignore", "ignore", "pipe"] });
  track(service.pid);
  service.stderr!.on("data", (d) => { serviceErr += d; });
  await until("the control door", () => existsSync(join(run, "control.sock")) || service!.exitCode !== null, 30_000);
  check("the service runs on the Mac", service.exitCode === null, serviceErr.slice(-400));
  // The start deletes it after the control door is up (runs 3 and 4 of 2026-11-26 looked too early): wait for it.
  const earlierGone = await until("the delete of the earlier blanket folder", () => !existsSync(join(state, "blanket")) || service!.exitCode !== null, 10_000).then(() => !existsSync(join(state, "blanket")), () => false);
  check("the service's start deleted the blanket folder of an earlier run", earlierGone);
  const d = await door();
  const hello = await d.next((l) => l.t === "hello");
  check("the hello has the features blanket_scope and blanket_setup", hello.features?.includes("blanket_scope") && hello.features?.includes("blanket_setup"), JSON.stringify(hello.features));
  d.send({ t: "hello", v: 1, side: "daemon", version: "live", features: [] });
  const cfg = await req(d, "config", { kind: "daemon", user: "live", via: "config" }, { enabled: true, control: true, chrome_bin: null, chrome_args: [], display_size: "1280x900" });
  check("config answers ok", cfg.ok === true, JSON.stringify(cfg));
  const ss = await req(d, "set_sessions", DAEMON, { sessions: [SESSION], remote: [], box: { hosts: ["box.localhost"], cookie_names: [] } });
  check("set_sessions with a blanket item answers ok", ss.ok === true, JSON.stringify(ss));
  let st = (await req(d, "status", DAEMON)).data;
  check("status has blanket_template", ["none", "ready"].includes(st.blanket_template), String(st.blanket_template));

  // 2. The set-up, when the state folder has no template yet.
  if (st.blanket_template !== "ready") {
    check("with no template, operator_text gives the steps with the real folder path", st.operator_text.includes(TEMPLATE_TEXT.none(pkg)), st.operator_text);
    const refused = await req(d, "blanket_setup", TOKEN);
    check("an agent's token cannot set it up: not the operator", refused.ok === false && refused.error === "not the operator", JSON.stringify(refused));
    const set = await req(d, "blanket_setup", OPERATOR, {}, 5_000);
    check("the operator's blanket_setup answers ok at once", set.ok === true && JSON.stringify(set.data) === "{}", JSON.stringify(set));
    st = (await req(d, "status", DAEMON)).data;
    check("status: setting_up, with the set-up's steps", st.blanket_template === "setting_up" && st.operator_text.includes(TEMPLATE_TEXT.settingUp(pkg)), st.blanket_template);
    log("OPERATOR: in the Chrome window that opened on this Mac's screen (the set-up Chrome; it reaches no network):");
    log("  open chrome://extensions, turn on Developer mode, click Load unpacked, press Command-Shift-G, and enter:");
    log(`  ${pkg}`);
    log("  then click Select. The service closes that window when the extension is loaded (at most 10 minutes).");
    const end = Date.now() + 11 * 60_000;
    while (Date.now() < end) {
      st = (await req(d, "status", DAEMON)).data;
      for (const p of mainsOn(templateProfile)) track(p.pid);
      if (st.blanket_template !== "setting_up") break;
      await sleep(5_000);
    }
    check("the set-up ends with blanket_template ready", st.blanket_template === "ready", `${st.blanket_template}; ${st.operator_text}`);
    check("no Chrome runs on the template's profile after the set-up", mainsOn(templateProfile).length === 0);
  } else log("the state folder holds a ready template: no set-up in this run");
  const load = checkLoad(templateProfile, pkg);
  check("the template's files hold the load: the receiver's entry of agent-package-blanket, location 4, no disable reason, developer mode on", load.ok, JSON.stringify(load));

  // 3. The use: only the blanket Chrome, through open -n -g, with the proxy's flags.
  // The set-up's closed proxy listens and stops before this point (run 5 of 2026-11-26): count only a proxy that still listens.
  const count = (line: string) => serviceErr.split(line).length - 1;
  const listening = count("blanket: the address proxy listens") - count("blanket: the address proxy stopped");
  check("no address proxy listens before the blanket scope's first use", listening === 0, `${listening} listening`);
  const url = (await req(d, "endpoint", DAEMON, { scope: "live-bl" })).data.url as string;
  let cdp: CDPConnection | null = null;
  let refusal = "";
  const watcher = setInterval(() => { for (const p of mainsOn(blanketProfile)) track(p.pid); }, 200);
  try { cdp = await CDPConnection.connect(url, 120_000); } catch (e) { refusal = (e as Error).message; }
  clearInterval(watcher);
  const blanketPid = pidsOf(/blanket: (?:Google Chrome \S+|\S.*?) started on the blanket profile through open -n -g \(pid (\d+)\)/g).at(-1);
  check("the use started the blanket Chrome through open -n -g", blanketPid !== undefined, refusal || (serviceErr.match(/blanket: .*/g)?.slice(-6).join(" | ") ?? ""));
  track(blanketPid);
  check("the client is admitted to the blanket model", cdp !== null, refusal);
  const me = table().find((p) => p.pid === blanketPid);
  check("the blanket Chrome is a child of launchd on the blanket profile", me?.ppid === 1 && me.args.includes(`--user-data-dir=${blanketProfile}`), me?.args.slice(0, 200));
  const proxyPort = Number([...serviceErr.matchAll(/blanket: the address proxy listens on 127\.0\.0\.1:(\d+)/g)].at(-1)?.[1]);
  const flags = [`--proxy-server=socks5://127.0.0.1:${proxyPort}`, "--proxy-bypass-list=<-loopback>", "--webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-quic"];
  const words = me?.args.split(" ") ?? [];
  check("its arguments hold the address proxy's four flags with the listening port, once each", Number.isSafeInteger(proxyPort) && flags.every((f) => words.filter((w) => w === f).length === 1), words.filter((w) => /proxy|webrtc|quic/.test(w)).join(" "));
  check("only the blanket Chrome started: no agent Chrome runs on <state>/profile", mainsOn(join(state, "profile")).length === 0);
  check("the blanket folder is new (no file of the earlier run) and holds the copy's Secure Preferences", !existsSync(join(blanketProfile, "Default", "earlier-run.txt")) && existsSync(join(blanketProfile, "Default", "Secure Preferences")));
  const manifest = JSON.parse(readFileSync(join(blanketProfile, "NativeMessagingHosts", "sh.agentwatch.browser.json"), "utf8"));
  check("the blanket profile's host manifest names agent-browser-host-blanket and only the receiver", manifest.path === join(state, "agent-browser-host-blanket") && JSON.stringify(manifest.allowed_origins) === JSON.stringify([`chrome-extension://${RECEIVER_ID}/`]));
  check("the receiver said its hello on the blanket link", serviceErr.includes(`blanket: link: the receiver ${AGENT_VERSION} said hello`), serviceErr.match(/blanket: link: .*/g)?.join(" | ") ?? "");
  const local = await cdp!.send("Target.createTarget", { url: "http://app.localhost:9/" }).then(() => "no refusal", (e: Error) => e.message);
  check("a local host is refused with the public host class's text", local.includes(`app.localhost ${TEXT_PUBLIC}`), local);
  st = (await req(d, "status", DAEMON)).data;
  check("status: blanket_state ready", st.sessions.find((s: any) => s.scope === "live-bl")?.blanket_state === "ready", JSON.stringify(st.sessions));

  // 4. The address proxy with the Mac's peer check.
  const page = `http://public.test:${P}/`;
  const { targetId } = await cdp!.send("Target.createTarget", { url: page });
  const { sessionId } = await cdp!.send("Target.attachToTarget", { targetId, flatten: true });
  const ev = async (expression: string) => (await cdp!.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
  let title = "";
  for (let i = 0; i < 75 && title !== "stand-in"; i++) { title = await ev("document.title").catch(() => ""); if (title !== "stand-in") await sleep(200); }
  check("the blanket tab opens http://public.test:<port>/ through the proxy (its peer check admitted the blanket Chrome's own socket)", title === "stand-in", `${title}; ${seen.join(" | ")}`);
  const out = await ev(`(async () => {
    const P = ${P};
    const tryFetch = (u) => Promise.race([fetch(u, { mode: "no-cors", cache: "no-store" }).then(() => "reached", () => "failed"), new Promise((r) => setTimeout(() => r("timeout"), 8000))]);
    const tryWs = (u) => new Promise((r) => { let w; try { w = new WebSocket(u); } catch { r("failed"); return; } const t = setTimeout(() => { try { w.close(); } catch {} r("timeout"); }, 8000); w.onopen = () => { clearTimeout(t); w.close(); r("opened"); }; w.onerror = () => { clearTimeout(t); r("failed"); }; });
    const worker = () => new Promise((r) => { const w = new Worker("/worker.js"); const t = setTimeout(() => r({ timeout: true }), 12000); w.onmessage = (e) => { clearTimeout(t); r(e.data); w.terminate(); }; w.postMessage({ ok: "/ok", priv: "http://private.test:" + P + "/w" }); });
    return { ok: await tryFetch("/ok"), wsPub: await tryWs("ws://public.test:" + P + "/ws"), priv: await tryFetch("http://private.test:" + P + "/f"), wsPriv: await tryWs("ws://private.test:" + P + "/ws"),
      literal: await tryFetch("http://127.0.0.1:" + P + "/lit"), wsLit: await tryWs("ws://127.0.0.1:" + P + "/ws"), worker: await worker() };
  })()`);
  log(`the page's results: ${JSON.stringify(out)}`);
  check("the controls pass: the fetch of /ok, the WebSocket to public.test, the worker's fetch", out?.ok === "reached" && out?.wsPub === "opened" && out?.worker?.ok === "reached", JSON.stringify(out));
  check("a fetch, a WebSocket and a worker's fetch to private.test fail", out?.priv === "failed" && out?.wsPriv === "failed" && out?.worker?.priv === "failed", JSON.stringify(out));
  check("a fetch and a WebSocket to 127.0.0.1 fail", out?.literal !== "reached" && out?.wsLit !== "opened", JSON.stringify(out));
  await ev(`location.href = "http://private.test:${P}/top"; 1`).catch(() => null);
  await sleep(3_000);
  const after = await ev("document.title").catch((e: Error) => `(${e.message})`);
  check("a top-level navigation to private.test does not load", after !== "reached", String(after));
  check("the stand-in saw no request of private.test or of 127.0.0.1", seen.every((x) => x.startsWith(`public.test:${P} `) || x.startsWith(`ws public.test:${P} `)), seen.join(" | "));
  const proxyLines = serviceErr.split("\n").filter((l) => l.startsWith("blanket: the address proxy") && !l.startsWith("blanket: the address proxy listens on"));
  check("the proxy refused private.test with log lines that name no host", proxyLines.some((l) => l === "blanket: the address proxy refused a connection to a name: it has a loopback address") && !proxyLines.some((l) => /private\.test|public\.test|127\.0\.0\.1/.test(l)), proxyLines.slice(0, 4).join(" | "));
  await cdp!.close();

  // 5. The end: the blanket folder and the proxy go; the template stays; the stop.
  const e5 = await req(d, "session_ended", DAEMON, { scope: "live-bl" });
  await until("the blanket folder goes at the scope's end", () => !existsSync(join(state, "blanket")) && mainsOn(blanketProfile).length === 0, 30_000);
  check("session_ended: the blanket Chrome is gone and the blanket folder is deleted", e5.ok === true);
  await until("the address proxy stops", () => /blanket: the address proxy stopped \(\d+ connection\(s\) passed, \d+ refused\)/.test(serviceErr), 20_000);
  const answer = await new Promise<string>((r) => { const s = connect(proxyPort, "127.0.0.1"); s.on("connect", () => { s.destroy(); r("connected"); }); s.on("error", (e: NodeJS.ErrnoException) => r(e.code ?? "error")); });
  check("after the end nothing listens on the address proxy's port", answer === "ECONNREFUSED", answer);
  check("the template stays", checkLoad(templateProfile, pkg).ok);
  const stop = await req(d, "stop", TOKEN, {}, 30_000);
  check("stop answers ok", stop.ok === true, JSON.stringify(stop));
  d.s.end();
  const exit = await stopService();
  check("the service's stop removes its sockets, link-blanket.sock too", exit === 0 && !existsSync(join(run, "link.sock")) && !existsSync(join(run, "link-blanket.sock")) && !existsSync(join(run, "control.sock")) && !existsSync(join(run, "cdp.sock")));
  // The peer check's lines, read once after step 5 (board ab-4wh.22: a FAIL here no longer hides step 5's results). A
  // client that Chrome closed before the peer check (a cancelled connect) has its own line, which passes; a stranger's
  // line fails.
  const clientLines = serviceErr.split("\n").filter((l) => l.startsWith("blanket: the address proxy refused a client"));
  const CLOSED = `blanket: the address proxy refused ${PEER_TEXT.closed}`;
  const closedLines = clientLines.filter((l) => l === CLOSED);
  check("the proxy refused no client of the blanket Chrome as a stranger (the Mac's peer check admits its own sockets; a client that closed before its peer check has its own line)", !clientLines.some((l) => l.includes("it is not a process of the service's user")), `${closedLines.length} closed before the peer check; ${clientLines.filter((l) => l !== CLOSED).slice(0, 3).join(" | ")}`);
} catch (e) {
  code = 1;
  log(`FAIL: ${(e as Error).message}`);
  if (serviceErr) log(`the service's log (end):\n${serviceErr.slice(-4000)}`);
} finally {
  await stopService();
  closeStandIn();
  // Only the processes that this run started, by pid and start time (a pid that came back is left alone).
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    for (const [pid, start] of started) if (start !== null && startOf(pid) === start) { try { process.kill(pid, sig); } catch {} }
    await sleep(2000);
  }
  const left = [...started].filter(([pid, start]) => start !== null && startOf(pid) === start).map(([pid]) => pid);
  rmSync(dir, { recursive: true, force: true });
  log(`cleanup: ${left.length ? `still running: ${left.join(", ")}` : "no process of this run runs"}; the temp folder is ${existsSync(dir) ? "still there" : "removed"}; the state folder ${state} ${created ? "was made by this run and" : ""} stays with its template (delete it when the checks end)`);
  if (left.length) code = 1;
  process.stdout.write(`${JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length + (code && results.every((r) => r.ok) ? 1 : 0), seconds: Math.round((Date.now() - t0) / 1000) })}\n`);
  process.exit(code);
}
