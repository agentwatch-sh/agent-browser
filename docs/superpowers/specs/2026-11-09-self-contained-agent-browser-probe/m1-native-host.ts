// M1 (board ab-v16.93): a native-messaging host shim that links a test extension to a separate long-running process
// (the "service") over a Unix socket. Linux only. The probe's own Chromium, its own temp profile, its own unpacked
// test extension (m1-ext/, only the nativeMessaging permission), no page at all. Run under the shared heavy lock:
//
//   flock <heavy.lock> timeout 1500 node m1-native-host.ts [--xvfb]
//
// It measures: whether Chrome starts the host from the per-profile folder <user-data-dir>/NativeMessagingHosts/,
// whether the service can tell its own Chrome's shim from another process (SO_PEERCRED through the repo's reader, then
// the shim's parent), the round-trip time service -> shim -> extension -> shim -> service, the shim's memory, and the
// time until the link is back after the service drops it (Chrome keeps running). It writes results/m1.json.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { harnessGuard, reservedDisplay } from "../../../../test/live/guard.ts";
import { parseStat, selfTest } from "../../../../src/relay/peer.ts";

if (process.platform !== "linux") throw new Error("M1 runs on Linux only");
const XVFB = process.argv.includes("--xvfb");
const DISPLAY_N = 168;
if (XVFB && reservedDisplay(DISPLAY_N, "display")) throw new Error(reservedDisplay(DISPLAY_N, "display")!);
const CHROMIUM = process.env.CHROMIUM ?? "/usr/bin/chromium";
const HOST = "probe.selfcontained.m1";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const OUT = new URL(`./results/m1${XVFB ? "-xvfb" : ""}.json`, import.meta.url);
const result: Record<string, unknown> = { chromium: execFileSync(CHROMIUM, ["--version"], { encoding: "utf8" }).trim(), node: process.version, mode: XVFB ? `Xvfb :${DISPLAY_N}` : "--headless=new" };

const guard = await harnessGuard("m1-native-host");
const run = mkdtempSync(join(tmpdir(), "ab-m1-"));
const profile = join(run, "profile"), svcDir = join(run, "svc"), ext = join(run, "ext");
mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });
mkdirSync(svcDir, { mode: 0o700 });
cpSync(join(HERE, "m1-ext"), ext, { recursive: true });
// An unpacked extension's ID: the first 16 bytes of the SHA-256 of its absolute path, each hex digit mapped to a-p.
const idOf = (p: string) => [...createHash("sha256").update(realpathSync(p)).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
const extId = idOf(ext);
const sockPath = join(svcDir, "service.sock");
const wrapper = join(run, "host.sh");
writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${join(HERE, "m1-host.mjs")}' --socket '${sockPath}'\n`);
chmodSync(wrapper, 0o700);
const writeManifest = (id: string) => writeFileSync(join(profile, "NativeMessagingHosts", `${HOST}.json`),
  JSON.stringify({ name: HOST, description: "M1 probe shim", path: wrapper, type: "stdio", allowed_origins: [`chrome-extension://${id}/`] }));
writeManifest(extId);
result.extensionId = extId;
let workingId = extId;

// ------------------------------------------------------------------ the service side

const st = await selfTest(sockPath);
if ("failed" in st) throw new Error(`the peer reader cannot run: ${st.failed}`);
const reader = st.reader as any;
const proc = (pid: number) => { try { return parseStat(readFileSync(`/proc/${pid}/stat`, "latin1")); } catch { return null; } };
const cmdline = (pid: number) => { try { return readFileSync(`/proc/${pid}/cmdline`, "latin1").split("\0"); } catch { return []; } };

type Link = { sock: Socket; pid: number; parentIsChrome: boolean; parentOnProfile: boolean; acceptedAt: number };
let chromePid = 0, chromeStart = 0;
const links: Link[] = [];
const refused: { pid: number; ppid: number | null; why: string }[] = [];
let onHello: ((l: Link) => void) | null = null;
const pending = new Map<number, (t: number) => void>();
const server = createServer((sock) => {
  const fd = (sock as any)._handle.fd as number;
  const c = reader.cred(fd) as { pid: number; uid: number } | null;
  const p = c ? proc(c.pid) : null;
  const parent = p ? proc(p.ppid) : null;
  // The service's rule: a bridge link only from a process whose parent is the Chrome that the service started (pid
  // and start time), and whose command line runs on the agent profile.
  const parentIsChrome = !!p && p.ppid === chromePid && parent?.start === chromeStart;
  const parentOnProfile = !!p && cmdline(p.ppid).includes(`--user-data-dir=${profile}`);
  if (!c || c.uid !== process.getuid!() || !parentIsChrome || !parentOnProfile) {
    refused.push({ pid: c?.pid ?? -1, ppid: p?.ppid ?? null, why: !c ? "no peer" : !parentIsChrome ? "its parent is not the service's Chrome" : "the parent is not on the agent profile" });
    sock.destroy();
    return;
  }
  const link: Link = { sock, pid: c.pid, parentIsChrome, parentOnProfile, acceptedAt: performance.now() };
  links.push(link);
  let buf = "";
  sock.setEncoding("utf8").on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0;) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.t === "hello") onHello?.(link);
      else if (m.t === "pong") pending.get(m.id)?.(performance.now());
    }
  });
  sock.on("error", () => {});
});
await new Promise<void>((r) => { const u = process.umask(0o077); server.listen(sockPath, () => { process.umask(u); r(); }); });
chmodSync(sockPath, 0o600);

let nextId = 1;
function ping(link: Link, pad = ""): Promise<number> {
  const id = nextId++;
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("ping timeout")); }, 10000);
    pending.set(id, (t) => { clearTimeout(timer); pending.delete(id); resolve(t - t0); });
    link.sock.write(JSON.stringify({ t: "ping", id, pad }) + "\n");
  });
}
const waitHello = (ms: number) => new Promise<Link | null>((resolve) => { const t = setTimeout(() => resolve(null), ms); onHello = (l) => { clearTimeout(t); onHello = null; resolve(l); }; });
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3); };
const stats = (a: number[]) => ({ n: a.length, p50: pct(a, 0.5), p90: pct(a, 0.9), p99: pct(a, 0.99), max: +Math.max(...a).toFixed(3) });

// ------------------------------------------------------------------ Chrome

const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(run, "home"), LANG: "C.UTF-8" };
mkdirSync(env.HOME!, { recursive: true });
if (XVFB) {
  const xvfb = spawn("Xvfb", [`:${DISPLAY_N}`, "-nolisten", "tcp", "-screen", "0", "1280x800x24"], { stdio: "ignore" });
  guard.track(xvfb.pid, "Xvfb");
  await new Promise((r) => setTimeout(r, 800));
  env.DISPLAY = `:${DISPLAY_N}`;
}
const t0 = performance.now();
const chrome = spawn(CHROMIUM, [
  ...(XVFB ? [] : ["--headless=new"]), `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
  "--password-store=basic", `--load-extension=${ext}`, "about:blank",
], { env, stdio: "ignore" });
guard.track(chrome.pid, "Chromium");
chromePid = chrome.pid!;
await new Promise((r) => setTimeout(r, 100));
chromeStart = proc(chromePid)?.start ?? 0;

try {
  let first = await waitHello(20000);
  if (!first) {
    // The predicted ID did not match: read the real one from the profile's preferences and write the manifest again.
    const prefs = JSON.parse(readFileSync(join(profile, "Default", "Secure Preferences"), "utf8"));
    const settings = prefs?.extensions?.settings ?? {};
    const ids = Object.keys(settings).filter((id) => settings[id]?.path === ext || settings[id]?.path === realpathSync(ext));
    result.predictedIdMissed = { predicted: extId, inProfile: ids };
    if (ids[0]) { workingId = ids[0]; writeManifest(workingId); }
    first = await waitHello(20000);
  }
  if (!first) throw new Error(`no link: ${JSON.stringify(refused)}`);
  result.firstLinkMs = +(first.acceptedAt - t0).toFixed(1);
  result.firstHelloMs = +(performance.now() - t0).toFixed(1);
  result.shim = { pid: first.pid, parentIsChrome: first.parentIsChrome, parentOnProfile: first.parentOnProfile, cmd: cmdline(first.pid).slice(0, 2).map((s) => s.replace(run, "<run>").replace(HERE, "<probe>/")) };
  const status = readFileSync(`/proc/${first.pid}/status`, "latin1");
  result.shimRssKiB = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1]);

  for (let i = 0; i < 20; i++) await ping(first); // warm-up
  const small: number[] = [];
  for (let i = 0; i < 1000; i++) small.push(await ping(first));
  result.rttSmall = stats(small);
  const pad = "x".repeat(64 * 1024);
  const big: number[] = [];
  for (let i = 0; i < 200; i++) big.push(await ping(first, pad));
  result.rtt64KiB = stats(big);
  const tb = performance.now();
  const burst = await Promise.all(Array.from({ length: 100 }, () => ping(first!)));
  result.burst100 = { wallMs: +(performance.now() - tb).toFixed(1), rtt: stats(burst) };

  // Another process of the same user that connects to the service socket: the parent rule refuses it.
  await new Promise<void>((r) => { const s = connect(sockPath); s.on("close", () => r()); s.on("error", () => r()); });
  result.strangerRefused = refused.at(-1) ?? null;

  // The service drops the link (as at a service restart, or at the switch from agentwatch's host to the service's
  // shim); Chrome keeps running. Before the drop the manifest names a second wrapper (host2.sh, the same shim with a
  // marker argument): Chrome reads the manifest again at the extension's next connectNative, so the switch of the host
  // needs no Chrome restart. The shim exits, the extension connects again after its 1 s, and Chrome starts the new one.
  const wrapper2 = join(run, "host2.sh");
  writeFileSync(wrapper2, `#!/bin/sh\nexec '${process.execPath}' '${join(HERE, "m1-host.mjs")}' --socket '${sockPath}' --marker switched\n`);
  chmodSync(wrapper2, 0o700);
  writeFileSync(join(profile, "NativeMessagingHosts", `${HOST}.json`), JSON.stringify({ name: HOST, description: "M1 probe shim 2", path: wrapper2, type: "stdio", allowed_origins: [`chrome-extension://${workingId}/`] }));
  const td = performance.now();
  first.sock.destroy();
  const again = await waitHello(20000);
  result.relink = again ? { ms: +(performance.now() - td).toFixed(1), newShim: again.pid !== first.pid, newManifestUsed: cmdline(again.pid).includes("switched"), parentIsChrome: again.parentIsChrome, chromePidSame: chrome.exitCode === null && proc(chromePid)?.start === chromeStart } : { ms: null };
  if (again) { const r2: number[] = []; for (let i = 0; i < 200; i++) r2.push(await ping(again)); result.rttAfterRelink = stats(r2); }
  result.ok = true;
} catch (e) {
  result.ok = false;
  result.error = (e as Error).message;
} finally {
  chrome.kill("SIGTERM");
  await new Promise((r) => { const t = setTimeout(r, 10000); chrome.once("exit", () => { clearTimeout(t); r(null); }); });
  if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL");
  server.close();
  writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  rmSync(run, { recursive: true, force: true });
  process.exit(result.ok ? 0 : 1);
}
