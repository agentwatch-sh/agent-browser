// The parity probe: can a site tell the agent browser from the operator's Chrome? It runs each given
// Chrome (for example Google Chrome stable and Chrome Beta) through the same runs, on throwaway
// profiles, against a local test site (probe.localhost on 127.0.0.1) that records what a site sees.
// No real site: every browser runs with --proxy-server pointed at a local proxy that refuses all
// traffic and logs only the host (*.localhost bypasses a proxy). Not part of `npm test`.
//
//   node test/live/parity/probe.ts --out DIR --browser stable=PATH --browser beta=PATH [--browser chromium=PATH]
//   node test/live/parity/compare.ts DIR > DIR/report.md
//
// Linux: needs Xvfb, xdotool and ffmpeg; the probe gets one private display (-auth, a random cookie
// that never enters an argv) and HOME is a folder of the run. macOS: no Xvfb; Chrome windows open on
// the screen, screenshots use `screencapture` (Screen Recording permission), Chrome runs with
// --use-mock-keychain (so it never asks for, or reads, the login keychain's "Chrome Safe Storage"),
// and the real-input parts of site and site-plain do not run. With no --browser on macOS, it takes
// Google Chrome and Google Chrome Beta from /Applications.
//
//   node test/live/parity/probe.ts --out DIR --serve LABEL [--serve-ms 600000]
//
// --serve starts only the probe site and records what a browser that a person opens there shows,
// for example the operator's own Chrome (with its own field trials): http://probe.localhost:PORT/
// and https://probe.localhost:PORT+1/ (a certificate warning; Advanced, then Proceed). It writes
// DIR/LABEL/site.json and tls.json for compare.ts. The page reads only properties of the browser and
// the machine, and sends them only to the probe server on 127.0.0.1.
//
// The runs (each on a fresh profile unless it says otherwise):
//   site          the plain agent flags: the page fingerprint, then a real click and typing (Linux)
//   tls           https://probe.localhost with --ignore-certificate-errors-spki-list: JA4 and HTTP/2
//   cmdline-ext   --load-extension=<probe extension> --silent-debugger-extension-api
//   cmdline-ext-feature   the same plus --disable-features=DisableLoadExtensionCommandLineSwitch
//   site-plain    the same without the agent's three background flags: the operator's own Chrome
//   cdp-install   --remote-debugging-pipe --enable-unsafe-extension-debugging, then CDP
//                 Extensions.loadUnpacked: the programmatic "Load unpacked"
//   relaunch-cdp-flag, relaunch-cdp   that profile again, with and without the unsafe flag
//   cdp-install-devmode, relaunch-cdp-devmode   the same with developer mode on before the relaunch
//   ui-install    "Load unpacked": developer mode on and Chrome's folder dialog (xdotool on Linux, a
//                 person on macOS); profile kept as P
//   relaunch-silent   P with the plain flags and --silent-debugger-extension-api: still loaded? then
//                 the agent's controls through chrome.debugger
//   relaunch-banner   P without --silent-debugger-extension-api: the same controls, the banner
//   update        P under a newer browser of the same product (an update): does the extension
//                 survive? Then the agent's controls, in that newer browser
//   update-devmode-off(-relaunch)  developer mode off in that newer browser, then its relaunch
//   devmode-off(-relaunch)  a second "Load unpacked" profile, developer mode off, then a relaunch
//   external-crx, external-crx-relaunch, external-crx-banner   only with --external-dir LABEL=DIR: the probe extension
//                 packed into a CRX by the browser itself, and DIR/<id>.json with its external_crx
//                 path (Chrome's "external extensions" file), then a relaunch with the agent's controls,
//                 then one more without --silent-debugger-extension-api (the banner).
//                 DIR is the folder that this Chrome reads: on Linux <the binary's folder>/extensions.
//                 For an unpacked Chrome that folder is the worker's own. The probe refuses a system
//                 folder, and removes its JSON file after the runs, also when it is stopped.
//   inspect-approval  the chrome://inspect switch seeded in Local State, then one DevTools
//                 WebSocket: today's agent-browser path and its "Allow remote debugging?" prompt

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, createPublicKey, randomBytes, X509Certificate } from "node:crypto";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AGENT_ARGS } from "../../../src/agent.ts";
import { ProbeServer } from "./server.ts";

const HERE = new URL(".", import.meta.url).pathname;
const LINUX = process.platform === "linux";
const MAC = process.platform === "darwin";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    browser: { type: "string", multiple: true },
    port: { type: "string", default: "8941" },     // and the next two ports
    runs: { type: "string" },
    "external-dir": { type: "string", multiple: true },
    serve: { type: "string" },
    "serve-ms": { type: "string", default: "600000" },
  },
});
if (!values.out) { console.error("usage: probe.ts --out DIR --browser LABEL=PATH ..."); process.exit(2); }
const OUT = resolve(values.out);
mkdirSync(OUT, { recursive: true, mode: 0o700 });

let browsers: [string, string][] = (values.browser ?? []).map((b) => { const i = b.indexOf("="); return [b.slice(0, i), b.slice(i + 1)]; });
if (!browsers.length && MAC) {
  browsers = ([["stable", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"], ["beta", "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"]] as [string, string][]).filter(([, p]) => existsSync(p));
}
if (!browsers.length && !values.serve) { console.error("no --browser given"); process.exit(2); }
const RUNS = new Set((values.runs ?? "site,site-plain,tls,cmdline-ext,cmdline-ext-feature,cdp-install,relaunch-cdp-flag,relaunch-cdp,cdp-install-devmode,relaunch-cdp-devmode,ui-install,relaunch-silent,relaunch-banner,update,update-devmode-off,update-devmode-off-relaunch,devmode-off,devmode-off-relaunch,external-crx,external-crx-relaunch,external-crx-banner,inspect-approval").split(","));
const EXTERNAL_DIRS = new Map((values["external-dir"] ?? []).map((b) => { const i = b.indexOf("="); return [b.slice(0, i), resolve(b.slice(i + 1))] as [string, string]; }));
// A system folder would install the probe extension for every user of that Chrome: refuse it.
for (const [label, d] of EXTERNAL_DIRS) {
  if (/^\/(opt|usr|etc|Library|Applications|System)(\/|$)/.test(d)) { console.error(`--external-dir ${label}: ${d} is a system folder; the probe never writes there`); process.exit(2); }
}
let EXTERNAL_JSON: string | undefined;   // the external extensions file of the current runs, if any

const log = (...a: unknown[]) => console.error(new Date().toISOString().slice(11, 23), ...a);

// --- TLS certificate for probe.localhost, and its SPKI hash for Chrome's flag -----------------

const tlsDir = join(OUT, "tls");
mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
if (!existsSync(join(tlsDir, "cert.pem"))) {
  // A config file instead of -addext, and RSA instead of -pkeyopt: macOS ships LibreSSL.
  writeFileSync(join(tlsDir, "req.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=probe.localhost\n[ext]\nsubjectAltName=DNS:probe.localhost\n");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3", "-config", join(tlsDir, "req.cnf"),
    "-keyout", join(tlsDir, "key.pem"), "-out", join(tlsDir, "cert.pem")], { stdio: "ignore" });
}
const cert = readFileSync(join(tlsDir, "cert.pem"), "utf8");
const key = readFileSync(join(tlsDir, "key.pem"), "utf8");
const spki = createHash("sha256").update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" })).digest("base64");

// --- The display (Linux): a private Xvfb with a random MIT-MAGIC-COOKIE-1 ---------------------

type Display = { env: NodeJS.ProcessEnv; name: string; stop: () => void };

function xauthEntry(display: string, cookie: Buffer): Buffer {
  const s = (b: Buffer) => { const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
  const fam = Buffer.from([0xff, 0xff]);  // FamilyWild: any host, this display number
  return Buffer.concat([fam, s(Buffer.alloc(0)), s(Buffer.from(display)), s(Buffer.from("MIT-MAGIC-COOKIE-1")), s(cookie)]);
}

async function startDisplay(): Promise<Display> {
  if (!LINUX) return { env: {}, name: "screen", stop: () => {} };
  let n = 90;
  while (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) n++;
  const xauth = join(OUT, "xauth");
  writeFileSync(xauth, xauthEntry(String(n), randomBytes(16)), { mode: 0o600 });
  const xvfb = spawn("Xvfb", [`:${n}`, "-nolisten", "tcp", "-auth", xauth, "-screen", "0", "1920x1080x24"], { stdio: "ignore" });
  const env = { DISPLAY: `:${n}`, XAUTHORITY: xauth };
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { execFileSync("xdotool", ["getdisplaygeometry"], { env: { ...process.env, ...env }, stdio: "ignore" }); up = true; } catch { await sleep(100); }
  }
  if (!up) { xvfb.kill(); throw new Error(`display :${n} did not start`); }
  let open = false;
  try { execFileSync("xdotool", ["getdisplaygeometry"], { env: { ...process.env, DISPLAY: `:${n}`, XAUTHORITY: "/dev/null" }, stdio: "ignore" }); open = true; } catch { /* refused: good */ }
  if (open) { xvfb.kill(); throw new Error(`display :${n} accepts a client without the cookie`); }
  log(`display :${n} up; a client without the cookie is refused`);
  return { env, name: `:${n}`, stop: () => xvfb.kill() };
}

function screenshot(d: Display, file: string) {
  try {
    if (LINUX) execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-video_size", "1920x1080", "-i", d.name, "-frames:v", "1", file], { env: { ...process.env, ...d.env }, stdio: "ignore" });
    else if (MAC) execFileSync("screencapture", ["-x", file], { stdio: "ignore" });
    return file;
  } catch (e) { return `failed: ${e}`; }
}

// --- Chrome --------------------------------------------------------------------------------------

type Chrome = { proc: ChildProcess; exited: Promise<number | null>; cdp?: PipeCdp };

class PipeCdp {
  private buf = "";
  private id = 0;
  private pending = new Map<number, (m: any) => void>();
  private readonly w: NodeJS.WritableStream;
  constructor(w: NodeJS.WritableStream, r: NodeJS.ReadableStream) {
    this.w = w;
    r.on("data", (b: Buffer) => {
      this.buf += b.toString("utf8");
      let i;
      while ((i = this.buf.indexOf("\0")) >= 0) {
        const msg = JSON.parse(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
        if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)!(msg); this.pending.delete(msg.id); }
      }
    });
  }
  send(method: string, params: object = {}, ms = 30_000, sessionId?: string): Promise<any> {
    const id = ++this.id;
    this.w.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    return Promise.race([new Promise((r) => this.pending.set(id, r)), sleep(ms).then(() => ({ timeout: method }))]);
  }
}

function chromeEnv(d: Display, home: string): NodeJS.ProcessEnv {
  if (!LINUX) return process.env;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const keep = ["PATH", "LANG", "LC_ALL", "LANGUAGE", "TZ"];
  return { ...Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]])), HOME: home, ...d.env };
}

// The operator's own Chrome runs without the agent's three background flags: the "plain" runs.
const PLAIN_ARGS = AGENT_ARGS.filter((a) => a === "--no-first-run" || a === "--no-default-browser-check");
// macOS: a mock keychain, so the probe's browsers never ask for, or read, "Chrome Safe Storage".
const MAC_ARGS = MAC ? ["--use-mock-keychain"] : [];

const RUNNING = new Set<Chrome>();

function launch(server: ProbeServer, d: Display, bin: string, profile: string, extra: string[], url: string, logFile: string, pipe = false, plain = false): Chrome {
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const args = [...(plain ? PLAIN_ARGS : AGENT_ARGS), `--user-data-dir=${profile}`, `--proxy-server=${server.proxy}`, ...MAC_ARGS, ...extra, url];
  const proc = spawn(bin, args, { env: chromeEnv(d, join(profile, "..", "home")), stdio: pipe ? ["ignore", "pipe", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  proc.stdout!.on("data", (b) => chunks.push(b));
  proc.stderr!.on("data", (b) => chunks.push(b));
  const exited = new Promise<number | null>((r) => proc.once("exit", (code) => { writeFileSync(logFile, Buffer.concat(chunks)); r(code); }));
  const c: Chrome = { proc, exited };
  RUNNING.add(c);
  void exited.then(() => RUNNING.delete(c));
  if (pipe) c.cdp = new PipeCdp(proc.stdio[3] as NodeJS.WritableStream, proc.stdio[4] as NodeJS.ReadableStream);
  return c;
}

async function quit(c: Chrome) {
  if (c.cdp) await c.cdp.send("Browser.close", {}, 5000);
  else c.proc.kill("SIGTERM");
  const done = await Promise.race([c.exited.then(() => true), sleep(15_000).then(() => false)]);
  if (!done) { c.proc.kill("SIGKILL"); await c.exited; }
}

/** The extension ID of a CRX key: the first 32 hex digits of SHA-256 of the public key, as a-p. */
function extensionId(pem: string): string {
  const der = createPublicKey(pem).export({ type: "spki", format: "der" });
  return [...createHash("sha256").update(der).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

// The probe extension's entries: the unpacked copies by their folder, the packed one by its ID.
const OUR_IDS = new Set<string>();
function readPrefs(profile: string) {
  const read = (f: string) => { try { return JSON.parse(readFileSync(join(profile, "Default", f), "utf8")); } catch { return undefined; } };
  const prefs = read("Preferences"), secure = read("Secure Preferences");
  const settings = { ...(prefs?.extensions?.settings ?? {}), ...(secure?.extensions?.settings ?? {}) };
  const ours = Object.fromEntries(Object.entries(settings).filter(([id, v]: [string, any]) => OUR_IDS.has(id) || (typeof v?.path === "string" && v.path.includes("parity-ext"))).map(([id, v]: [string, any]) => [id, {
    location: v.location, state: v.state, disable_reasons: v.disable_reasons, creation_flags: v.creation_flags, from_webstore: v.from_webstore, path: v.path,
  }]));
  return { developerMode: prefs?.extensions?.ui?.developer_mode, ours };
}

function versionOf(bin: string): string {
  try { return execFileSync(bin, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch (e) { return `unknown: ${e}`; }
}

// --- One run ---------------------------------------------------------------------------------------

type RunOpts = { plain?: boolean; extra?: string[]; url?: string; pipe?: boolean; control?: boolean; realInput?: boolean; installExt?: string; devModeOn?: boolean; extAliveMs?: number; bin?: string };

async function main() {
  const server = new ProbeServer(Number(values.port), { key, cert });
  await server.start();
  if (values.serve) return serve(server, values.serve);
  const display = await startDisplay();
  // A stopped probe stops its display and its browsers too.
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => {
    for (const c of RUNNING) c.proc.kill("SIGKILL");
    if (EXTERNAL_JSON) rmSync(EXTERNAL_JSON, { force: true });
    display.stop();
    process.exit(130);
  });
  const summary: any = { started: new Date().toISOString(), platform: process.platform, spki, browsers: {} };
  try {
    for (let bi = 0; bi < browsers.length; bi++) {
      const [label, bin] = browsers[bi];
      const dir = join(OUT, label);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const version = versionOf(bin);
      summary.browsers[label] = { bin, version, runs: {} };
      log(`${label}: ${version}`);
      // The probe extension, copied into the run folder (Chrome writes into a loaded folder).
      const ext = join(dir, "parity-ext");
      cpSync(join(HERE, "ext"), ext, { recursive: true });
      writeFileSync(join(ext, "config.js"), `export default ${JSON.stringify({ server: server.origin, token: server.token })};\n`);

      const run = async (name: string, profile: string, o: RunOpts) => {
        if (!RUNS.has(name)) return;
        server.run = `${label}/${name}`;
        server.clearQueue();
        log(`${server.run}: start`);
        const started = Date.now();
        const url = o.url ?? `${server.origin}/?run=${encodeURIComponent(server.run)}`;
        const chrome = launch(server, display, o.bin ?? bin, profile, o.extra ?? [], url, join(dir, `${name}.chrome.log`), o.pipe, o.plain);
        const out: any = { flags: [...(o.plain ? PLAIN_ARGS : AGENT_ARGS), `--user-data-dir=<profile>`, `--proxy-server=<blocking proxy>`, ...MAC_ARGS, ...(o.extra ?? [])], bin: o.bin ?? bin, marks: [], shots: {} };
        const mark = (what: string, detail?: unknown) => { const m = { t: Date.now(), what, detail }; out.marks.push(m); server.record("mark", m); };
        try {
          if (o.installExt && chrome.cdp) mark("Extensions.loadUnpacked", await chrome.cdp.send("Extensions.loadUnpacked", { path: o.installExt }));
          if (o.devModeOn && chrome.cdp) {
            const t = (await chrome.cdp.send("Target.createTarget", { url: "chrome://extensions/" })).result?.targetId;
            const sid = (await chrome.cdp.send("Target.attachToTarget", { targetId: t, flatten: true })).result?.sessionId;
            await sleep(1500);
            mark("developer-mode-on", (await chrome.cdp.send("Runtime.evaluate", { expression: "chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true}).then(() => 'ok')", awaitPromise: true, returnByValue: true }, 30_000, sid)).result?.result?.value);
          }
          const fp = await server.waitFor("page-fp", 60_000);
          mark(fp ? "page-fp" : "no page-fp");
          const target = await server.waitFor("page-target", 5_000);
          await sleep(1500);
          out.shots.loaded = screenshot(display, join(dir, `${name}-loaded.png`));
          const alive = await server.waitFor("ext-alive", o.extAliveMs ?? 1);
          out.extAlive = !!alive;
          if (o.realInput && LINUX && target) {
            const w = target.window;
            const sx = Math.round(w.screenX + (w.outerWidth - w.innerWidth) / 2 + target.x + target.width / 2);
            const sy = Math.round(w.screenY + (w.outerHeight - w.innerHeight) + target.y + target.height / 2);
            mark("real-click", { sx, sy });
            execFileSync("xdotool", ["mousemove", "--sync", String(sx), String(sy), "click", "1"], { env: { ...process.env, ...display.env } });
            await sleep(800);
            mark("real-type");
            execFileSync("xdotool", ["type", "--delay", "80", "ab"], { env: { ...process.env, ...display.env } });
            await sleep(1500);
            // A real new tab hides the page for 6 s: do its timers slow down?
            mark("hidden-start");
            execFileSync("xdotool", ["key", "ctrl+t"], { env: { ...process.env, ...display.env } });
            await sleep(6000);
            execFileSync("xdotool", ["key", "ctrl+w"], { env: { ...process.env, ...display.env } });
            mark("hidden-end");
            await sleep(1500);
          }
          if (o.control && alive && target) {
            const x = Math.round(target.x + target.width / 2), y = Math.round(target.y + target.height / 2);
            mark("findTab", await server.ext("findTab"));
            mark("self", await server.ext("self"));
            await sleep(1500);
            mark("attach", await server.ext("attach"));
            await sleep(2500);
            out.shots.attached = screenshot(display, join(dir, `${name}-attached.png`));
            mark("cdp-click", await server.ext("click", { x, y }));
            await sleep(800);
            mark("cdp-click-force", await server.ext("click", { x, y, force: 0.5 }));
            await sleep(800);
            mark("cdp-type", await server.ext("type", { text: "ab" }));
            await sleep(800);
            mark("isolated-eval", await server.ext("isolatedEval", { expression: "document.title" }));
            await sleep(1500);
            mark("runtime-enable", await server.ext("cdp", { method: "Runtime.enable" }));
            await sleep(1500);
            mark("runtime-disable", await server.ext("cdp", { method: "Runtime.disable" }));
            await sleep(1000);
            const nt = await server.ext("newTab", { url: `${server.origin}/blank`, active: true });
            mark("hidden-start", nt);
            await sleep(6000);
            mark("hidden-end", await server.ext("closeTab", { tab: nt.result?.id }));
            await sleep(1500);
            mark("detach", await server.ext("detach"));
            await sleep(1500);
            out.shots.detached = screenshot(display, join(dir, `${name}-detached.png`));
          }
          await sleep(1000);
        } finally {
          await quit(chrome);
        }
        out.prefs = readPrefs(profile);
        out.ms = Date.now() - started;
        out.records = server.records.filter((r) => r.run === server.run);
        writeFileSync(join(dir, `${name}.json`), JSON.stringify(out, null, 1));
        summary.browsers[label].runs[name] = { extAlive: out.extAlive, records: out.records.length, ms: out.ms };
        log(`${server.run}: done, extension ${out.extAlive ? "loaded" : "not loaded"}, ${out.records.length} records`);
      };

      await run("site", join(dir, "site", "profile"), { realInput: true });
      await run("site-plain", join(dir, "site-plain", "profile"), { realInput: true, plain: true });
      await run("tls", join(dir, "tls", "profile"), { extra: [`--ignore-certificate-errors-spki-list=${spki}`], url: `${server.tlsOrigin}/?run=${encodeURIComponent(`${label}/tls`)}` });
      await run("cmdline-ext", join(dir, "cmdline-ext", "profile"), { extra: [`--load-extension=${ext}`, "--silent-debugger-extension-api"], control: true, extAliveMs: 15_000 });
      await run("cmdline-ext-feature", join(dir, "cmdline-ext-feature", "profile"), { extra: [`--load-extension=${ext}`, "--disable-features=DisableLoadExtensionCommandLineSwitch", "--silent-debugger-extension-api"], control: false, extAliveMs: 15_000 });
      // The programmatic install (CDP Extensions.loadUnpacked), then two relaunches of that profile.
      const PC = join(dir, "cdp-installed", "profile");
      await run("cdp-install", PC, { extra: ["--remote-debugging-pipe", "--enable-unsafe-extension-debugging"], pipe: true, installExt: ext, extAliveMs: 15_000 });
      await run("relaunch-cdp-flag", PC, { extra: ["--enable-unsafe-extension-debugging"], extAliveMs: 15_000 });
      await run("relaunch-cdp", PC, { extAliveMs: 15_000 });
      // The same with developer mode on before the relaunch: is developer mode what keeps it?
      const PD = join(dir, "cdp-devmode", "profile");
      await run("cdp-install-devmode", PD, { extra: ["--remote-debugging-pipe", "--enable-unsafe-extension-debugging"], pipe: true, installExt: ext, devModeOn: true, extAliveMs: 15_000 });
      await run("relaunch-cdp-devmode", PD, { extAliveMs: 15_000 });
      // "Load unpacked" by hand: developer mode on and the folder dialog, on chrome://extensions.
      const P = join(dir, "installed", "profile");
      if (RUNS.has("ui-install")) await extensionsPage(server, display, label, bin, dir, "ui-install", P, ext, "install");
      await run("relaunch-silent", P, { extra: ["--silent-debugger-extension-api"], control: true, extAliveMs: 15_000 });
      await run("relaunch-banner", P, { control: true, extAliveMs: 15_000 });
      // An update: the same profile under a newer browser of the list (Chrome refuses a downgrade).
      const major = (v: string) => Number(/(\d+)\.\d+\.\d+\.\d+/.exec(v)?.[1] ?? 0);
      const product = (v: string) => v.replace(/\s*\d.*$/, "");
      const newer = browsers.find(([, b]) => product(versionOf(b)) === product(version) && major(versionOf(b)) > major(version));
      // It also runs the agent's controls, in the newer browser.
      if (newer) await run("update", P, { bin: newer[1], extra: ["--silent-debugger-extension-api"], control: true, extAliveMs: 15_000 });
      // Developer mode off under the newer browser, then its relaunch: the same check as below, for a
      // browser whose folder dialog the probe cannot finish (measured: Chrome Beta 158 kept Open greyed).
      if (newer && RUNS.has("update-devmode-off")) {
        await extensionsPage(server, display, label, newer[1], dir, "update-devmode-off", P, ext, "devmode-off");
        await run("update-devmode-off-relaunch", P, { bin: newer[1], extAliveMs: 15_000 });
      }
      // Developer mode off again (as a person would turn it off), on a second installed profile.
      const P2 = join(dir, "installed-2", "profile");
      if (RUNS.has("devmode-off")) {
        await extensionsPage(server, display, label, bin, dir, "ui-install-2", P2, ext, "install");
        await extensionsPage(server, display, label, bin, dir, "devmode-off", P2, ext, "devmode-off");
        await run("devmode-off-relaunch", P2, { extAliveMs: 15_000 });
      }
      // Chrome's external extensions file: a packed CRX that the browser installs at its start.
      const externalDir = EXTERNAL_DIRS.get(label);
      if (externalDir && (RUNS.has("external-crx") || RUNS.has("external-crx-relaunch"))) {
        const src = join(dir, "parity-crx");
        cpSync(ext, src, { recursive: true });
        // Its own profile: without --user-data-dir the pack request could go to a Chrome that runs on
        // the default profile (the operator's own Chrome on a Mac).
        execFileSync(bin, [`--user-data-dir=${join(dir, "pack-profile")}`, `--proxy-server=${server.proxy}`, ...MAC_ARGS, `--pack-extension=${src}`, "--no-message-box"], { env: chromeEnv(display, join(dir, "pack-home")), stdio: "ignore" });
        const id = extensionId(readFileSync(`${src}.pem`, "utf8"));
        OUR_IDS.add(id);
        const json = join(externalDir, `${id}.json`);
        const version = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8")).version;
        EXTERNAL_JSON = json;
        writeFileSync(json, JSON.stringify({ external_crx: `${src}.crx`, external_version: version }));
        log(`${label}: external extensions file ${json} (ID ${id})`);
        try {
          const PE = join(dir, "external", "profile");
          await run("external-crx", PE, { extAliveMs: 30_000 });
          await run("external-crx-relaunch", PE, { extra: ["--silent-debugger-extension-api"], control: true, extAliveMs: 30_000 });
          await run("external-crx-banner", PE, { control: true, extAliveMs: 30_000 });
        } finally {
          rmSync(json);
          EXTERNAL_JSON = undefined;
        }
      }
      if (RUNS.has("inspect-approval")) await inspectApproval(server, display, label, bin, dir, summary);
    }
  } finally {
    summary.blockedEgress = server.records.filter((r) => r.kind === "blocked-egress").map((r) => ({ run: r.run, ...(r.data as object) }));
    writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
    display.stop();
    await server.stop();
  }
}

/**
 * chrome://extensions in a pipe session (the probe's hand only; the profile state is what counts):
 * "install" turns developer mode on and clicks "Load unpacked" through the page's own API, then
 * types the folder into Chrome's folder dialog with xdotool (on macOS a person picks the folder, as the
 * log says); "devmode-off" turns developer mode off.
 */
async function extensionsPage(server: ProbeServer, display: Display, label: string, bin: string, dir: string, name: string, profile: string, ext: string, action: "install" | "devmode-off") {
  server.run = `${label}/${name}`;
  const out: any = { marks: [], shots: {} };
  const mark = (what: string, detail?: unknown) => { const m = { t: Date.now(), what, detail }; out.marks.push(m); server.record("mark", m); };
  // Chrome does not open chrome://extensions from its command line, so the probe opens it over CDP.
  const chrome = launch(server, display, bin, profile, ["--remote-debugging-pipe"], "about:blank", join(dir, `${name}.chrome.log`), true);
  const env = { ...process.env, ...display.env };
  try {
    await sleep(1500);
    const targetId = (await chrome.cdp!.send("Target.createTarget", { url: "chrome://extensions/" })).result?.targetId;
    mark("extensions-page", { targetId });
    const att = await chrome.cdp!.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = att.result?.sessionId;
    const ev = async (expression: string) => (await chrome.cdp!.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, 60_000, sessionId)).result?.result?.value;
    await sleep(2000);
    const want = action === "install";
    mark(`developer-mode-${want ? "on" : "off"}`, await ev(`chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: ${want}}).then(() => 'ok', (e) => String(e))`));
    await sleep(1500);
    out.shots.devmode = screenshot(display, join(dir, `${name}-devmode.png`));
    if (want) {
      const loaded = ev(`chrome.developerPrivate.loadUnpacked({failQuietly: false, populateError: true}).then((r) => JSON.stringify(r ?? null), (e) => 'error: ' + e)`);
      if (!LINUX) {
        // macOS: a person answers the folder dialog, as in a real "Load unpacked".
        log(`${server.run}: in Chrome's folder dialog, pick this folder and click Select (3 minutes): ${ext}`);
      }
      await sleep(3000);
      out.shots.dialog = screenshot(display, join(dir, `${name}-dialog.png`));
      const windows = LINUX ? execFileSync("xdotool", ["search", "--onlyvisible", "--name", "."], { env, encoding: "utf8" }).trim().split("\n").filter(Boolean) : [];
      const named = windows.map((w) => { try { return [w, execFileSync("xdotool", ["getwindowname", w], { env, encoding: "utf8" }).trim()]; } catch { return [w, ""]; } });
      if (LINUX) mark("windows", named);
      const dialog = named.find(([, n]) => /select|open|folder|directory|extension/i.test(n) && !/Chrome$/.test(n));
      if (dialog) {
        // The GTK folder dialog: Ctrl+L, the folder's path, then a click on its Open button (Return
        // ends this dialog as "canceled"). Open sits 49 px left of and 24 px above its lower right corner.
        execFileSync("xdotool", ["windowfocus", "--sync", dialog[0]], { env });
        execFileSync("xdotool", ["key", "ctrl+l"], { env });
        await sleep(400);
        execFileSync("xdotool", ["type", "--delay", "20", ext], { env });
        await sleep(1000);
        out.shots.typed = screenshot(display, join(dir, `${name}-typed.png`));
        const g = execFileSync("xdotool", ["getwindowgeometry", "--shell", dialog[0]], { env, encoding: "utf8" });
        const v = Object.fromEntries(g.trim().split("\n").map((l) => l.split("=")).map(([k, x]) => [k, Number(x)]));
        // GTK can miss a click that arrives with the pointer: move, wait, click, and click again while
        // the dialog is still there.
        execFileSync("xdotool", ["mousemove", "--sync", String(v.X + v.WIDTH - 49), String(v.Y + v.HEIGHT - 24)], { env });
        for (let i = 0; i < 4; i++) {
          await sleep(500);
          execFileSync("xdotool", ["click", "1"], { env });
          await sleep(1500);
          let still = "";
          try { still = execFileSync("xdotool", ["search", "--onlyvisible", "--name", "^Select the extension directory"], { env, encoding: "utf8" }).trim(); } catch { /* gone */ }
          if (!still) break;
          mark("dialog still open after a click");
        }
        out.shots.afterOpen = screenshot(display, join(dir, `${name}-after-open.png`));
      }
      mark("loadUnpacked", await Promise.race([loaded, sleep(LINUX ? 10_000 : 180_000).then(() => "no answer in time")]));
      out.extAlive = !!(await server.waitFor("ext-alive", 10_000));
      mark("ext-alive", out.extAlive);
      out.shots.done = screenshot(display, join(dir, `${name}-done.png`));
    }
  } finally {
    await quit(chrome);
  }
  out.prefs = readPrefs(profile);
  out.records = server.records.filter((r) => r.run === server.run);
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(out, null, 1));
  log(`${server.run}: done, extension ${out.extAlive ? "loaded" : "not loaded"}, developer mode ${out.prefs.developerMode}`);
}

/** Only the probe site, for a browser that a person opens there; then DIR/LABEL/site.json and tls.json. */
async function serve(server: ProbeServer, label: string) {
  const dir = join(OUT, label);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  server.run = `${label}/tls`;   // TLS connections carry the current run; HTTP pages carry their own
  log(`open ${server.origin}/?run=${encodeURIComponent(`${label}/site`)} and ${server.tlsOrigin}/?run=${encodeURIComponent(`${label}/tls`)} (certificate warning: Advanced, then Proceed); stop with Ctrl+C`);
  await new Promise<void>((resolve) => { const t = setTimeout(resolve, Number(values["serve-ms"])); process.once("SIGINT", () => { clearTimeout(t); resolve(); }); });
  for (const name of ["site", "tls"]) {
    const records = server.records.filter((r) => r.run === `${label}/${name}`);
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ bin: `(${label}: a browser that a person opened)`, marks: [], shots: {}, records }, null, 1));
  }
  const file = join(OUT, "summary.json");
  const summary = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { started: new Date().toISOString(), platform: process.platform, browsers: {}, blockedEgress: [] };
  summary.browsers[label] = { bin: `(${label}: a browser that a person opened)`, version: "the browser's own", runs: {} };
  writeFileSync(file, JSON.stringify(summary, null, 1));
  log(`${label}: ${server.records.filter((r) => r.run.startsWith(`${label}/`)).length} records`);
  await server.stop();
}

/** Today's path: the chrome://inspect switch, then one DevTools WebSocket and Chrome's prompt. */
async function inspectApproval(server: ProbeServer, display: Display, label: string, bin: string, dir: string, summary: any) {
  const name = "inspect-approval";
  server.run = `${label}/${name}`;
  const profile = join(dir, name, "profile");
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  writeFileSync(join(profile, "Local State"), JSON.stringify({ devtools: { remote_debugging: { "user-enabled": true } } }));
  const chrome = launch(server, display, bin, profile, [], `${server.origin}/?run=${encodeURIComponent(server.run)}`, join(dir, `${name}.chrome.log`));
  const out: any = { marks: [], shots: {} };
  const mark = (what: string, detail?: unknown) => out.marks.push({ t: Date.now(), what, detail });
  try {
    await server.waitFor("page-fp", 60_000);
    let port = "", path = "";
    for (let i = 0; i < 100 && !port; i++) {
      try { [port, path] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").trim().split("\n"); } catch { await sleep(200); }
    }
    mark("DevToolsActivePort", { found: !!port });
    if (port) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      const state = { opened: false, closed: false, error: "" };
      ws.onopen = () => { state.opened = true; mark("ws-open"); };
      ws.onclose = (e) => { state.closed = true; mark("ws-close", { code: e.code, reason: e.reason }); };
      ws.onerror = () => { state.error = "error"; };
      await sleep(4000);
      out.shots.prompt = screenshot(display, join(dir, `${name}-prompt.png`));
      await sleep(6000);
      out.state = state;
      try { ws.close(); } catch { /* not open */ }
    }
  } finally {
    await quit(chrome);
  }
  out.records = server.records.filter((r) => r.run === server.run);
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(out, null, 1));
  summary.browsers[label].runs[name] = { state: out.state };
  log(`${server.run}: done ${JSON.stringify(out.state)}`);
}

await main();
