// CLI full-page screenshot check in default mode. Linux, headless, local *.localhost pages.
// Run under the box's shared heavy-job lock, if it has one: node test/live/shot-full-size-default.ts
// Uses its own Chromium, profile, pipe endpoint, proxy and harness guard. No external mode.
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { resolveOptions } from "../../src/options.ts";
import { proxyInfo, stopProxy } from "../../src/proxy.ts";
import { harnessGuard, reservedDisplay } from "./guard.ts";
import { shotSite, shotFullSizeChecks } from "./shot-full-size.ts";

if (process.platform !== "linux") throw new Error("This check runs on Linux only");
const display = Number(process.env.DISPLAY_N ?? 165);
if (!Number.isInteger(display) || display < 1) throw new Error("DISPLAY_N needs a positive integer");
const reserved = reservedDisplay(display, "DISPLAY_N");
if (reserved) throw new Error(reserved);
const guard = await harnessGuard("shot-full-size");
const run = mkdtempSync(join(tmpdir(), "ab-shot-full-size-"));
const site = await shotSite();
const env = { ...process.env };
delete env.DISPLAY; delete env.WAYLAND_DISPLAY;
const chrome = spawn(process.env.CHROMIUM ?? "/usr/bin/chromium", [
  "--headless=new", "--remote-debugging-pipe", `--user-data-dir=${join(run, "profile")}`,
  "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
  "--disable-sync", "--disable-default-apps", "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE a.localhost",
  "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=a.localhost", "about:blank",
], { env, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
guard.track(chrome.pid, "Chromium");
console.error(`driver=${process.pid} guard=${guard.pid} chromium=${chrome.pid} profile=${run}`);
const pending = new Map<number, (message: any) => void>();
let next = 0, buffer = "", bridge: WebSocketServer | undefined;
(chrome.stdio[4] as Readable).setEncoding("utf8").on("data", (chunk: string) => {
  buffer += chunk;
  for (let i; (i = buffer.indexOf("\0")) >= 0;) {
    const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
    pending.get(msg.id)?.(msg);
    if (msg.id === undefined) for (const client of bridge?.clients ?? []) if (client.readyState === 1) client.send(JSON.stringify(msg));
  }
});
function send(method: string, params: object = {}, sessionId?: string): Promise<any> {
  const id = ++next;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: timeout`)); }, 15000);
    pending.set(id, (msg) => { clearTimeout(timer); pending.delete(id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); });
    (chrome.stdio[3] as Writable).write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });
}
const state = join(run, "state"), allow = join(run, "allow.json");
writeFileSync(allow, JSON.stringify({ allow: ["a.localhost"] }));
let settings: ReturnType<typeof resolveOptions> | undefined;
try {
  const product = (await send("Browser.getVersion")).product;
  bridge = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(bridge, "listening");
  bridge.on("connection", (client) => client.on("message", (raw) => {
    const request = JSON.parse(String(raw));
    void send(request.method, request.params, request.sessionId).then(
      (result) => client.send(JSON.stringify({ id: request.id, result })),
      (e) => client.send(JSON.stringify({ id: request.id, error: { code: -32000, message: e.message } })),
    );
  }));
  const endpoint = `ws://127.0.0.1:${(bridge.address() as { port: number }).port}`;
  settings = resolveOptions({ stateDir: state, allowlistFile: allow, endpoint, noLaunch: true });
  const bin = fileURLToPath(new URL("../../bin/agent-browser.js", import.meta.url));
  const cli = (...args: string[]) => new Promise<any>((resolve, reject) => {
    const child = execFile(process.execPath, [bin, ...args, "--state-dir", state, "--allowlist", allow, "--endpoint", endpoint, "--no-launch", "--json"], { encoding: "utf8", timeout: 60000 }, (error, stdout, stderr) => {
      guard.track(proxyInfo(settings!)?.pid, "shot-proxy");
      if (error) reject(new Error(stdout + stderr)); else resolve(JSON.parse(stdout));
    });
    guard.track(child.pid, "shot-cli");
  });
  const results = await shotFullSizeChecks(cli, run, site.base);
  console.log(JSON.stringify({ mode: "default", product, results }, null, 2));
} finally {
  if (settings) {
    guard.track(proxyInfo(settings)?.pid, "shot-proxy");
    const closed = [...(bridge?.clients ?? [])].filter((c) => c.readyState !== 3).map((c) => once(c, "close"));
    stopProxy(settings); await Promise.all(closed);
  }
  if (bridge) { for (const client of bridge.clients) client.terminate(); await new Promise<void>((resolve) => bridge!.close(() => resolve())); }
  if (chrome.exitCode === null && chrome.signalCode === null) { const exited = once(chrome, "exit"); chrome.kill("SIGTERM"); await exited; }
  await site.close();
  rmSync(run, { recursive: true });
}
