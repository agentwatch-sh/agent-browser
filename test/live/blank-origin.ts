// ab-b84.24: measure an iframe's window.open() with no URL, using browser metadata only.
// Run on Linux under the shared heavy-job lock:
// flock /home/selden/.cache/ab-lead/heavy.lock timeout 1200 node test/live/blank-origin.ts
// Optional: --chrome /usr/bin/chromium --display 122. Headless: no Xvfb or display connection.
// All pages are local *.localhost. The proxy blocks other requests. No Runtime command runs.
// The probe removes its temporary profile after Chromium ends. The guard ends its tree if the driver dies.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { harnessGuard, reservedDisplay } from "./guard.ts";

const { values } = parseArgs({ options: { chrome: { type: "string" }, display: { type: "string" } } });
if (process.platform !== "linux") throw new Error("This probe runs on Linux only");
const display = Number(values.display ?? 122);
if (!Number.isInteger(display) || display < 1) throw new Error("--display needs a positive whole number");
const reserved = reservedDisplay(display, "--display");
if (reserved) throw new Error(reserved);
const guard = await harnessGuard("blank-origin");
const run = mkdtempSync(join(tmpdir(), "ab-blank-origin-"));
const opened = new Map<string, () => void>();
const server = createServer((req, res) => {
  const url = new URL(req.url!, "http://a.localhost");
  const id = url.searchParams.get("id")!;
  const mode = url.searchParams.get("mode") ?? "keep";
  res.writeHead(200, { "content-type": "text/html" });
  if (url.pathname === "/opened") { res.end("ok"); opened.get(id)?.(); return; }
  if (url.pathname === "/frame") {
    const open = "window.open();";
    if (mode === "navigate-top")
      res.end(`<button onclick="${open} top.location = 'about:blank'">open and navigate</button><script>fetch('/opened?id=${id}-ready')</script>`);
    else res.end(`<script>${open} fetch('/opened?id=${id}'); ${mode === "remove-frame" ? "parent.postMessage('remove', '*');" : ""}</script>`);
    return;
  }
  res.end(`<script>addEventListener('message', e => { if (e.data === 'remove') { document.querySelector('iframe').remove(); fetch('/opened?id=${id}-removed'); } });</script>
    <iframe style="position:fixed;left:0;top:0;border:0" src="http://${url.searchParams.get("opener")}:${port}/frame?id=${id}&mode=${mode}"></iframe>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const chromeEnv = { ...process.env };
delete chromeEnv.DISPLAY;
delete chromeEnv.WAYLAND_DISPLAY;
const chrome = spawn(values.chrome ?? "/usr/bin/chromium", [
  "--headless=new", "--remote-debugging-pipe", `--user-data-dir=${join(run, "profile")}`,
  "--no-first-run", "--no-default-browser-check", "--disable-popup-blocking",
  "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
  "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE a.localhost , EXCLUDE b.localhost",
  "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=a.localhost;b.localhost", "about:blank",
], { env: chromeEnv, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
guard.track(chrome.pid, "Chromium");
process.stderr.write(`driver=${process.pid} guard=${guard.pid} chromium=${chrome.pid} profile=${run}\n`);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => process.exit(130));
process.on("exit", () => { if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGTERM"); });

let next = 0, buffer = "";
const sentMethods: string[] = [];
const pending = new Map<number, (message: any) => void>();
const output = chrome.stdio[4] as Readable;
output.setEncoding("utf8");
output.on("data", (chunk: string) => {
  buffer += chunk;
  for (let i; (i = buffer.indexOf("\0")) >= 0;) {
    const message = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    pending.get(message.id)?.(message);
  }
});
function send(method: string, params: object = {}, sessionId?: string): Promise<any> {
  const id = ++next;
  sentMethods.push(method);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: timeout`)); }, 15_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      pending.delete(id);
      message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result);
    });
    (chrome.stdio[3] as Writable).write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });
}
async function metadata(targetId: string) {
  const { targetInfo } = await send("Target.getTargetInfo", { targetId });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  try {
    await send("Page.enable", {}, sessionId);
    const { frameTree } = await send("Page.getFrameTree", {}, sessionId);
    return { targetUrl: targetInfo.url, openerId: targetInfo.openerId ?? null, openerFrameId: targetInfo.openerFrameId ?? null, frameUrl: frameTree.frame.url, securityOrigin: frameTree.frame.securityOrigin };
  } finally { await send("Target.detachFromTarget", { sessionId }); }
}

try {
  const version = await send("Browser.getVersion");
  const { targetId: empty } = await send("Target.createTarget", { url: "about:blank" });
  const opaque = await metadata(empty);
  assert.equal(opaque.targetUrl, "about:blank");
  assert.equal(opaque.frameUrl, "about:blank");
  await send("Target.closeTarget", { targetId: empty });
  const trials = [];
  for (const opener of ["b.localhost", "a.localhost"]) {
    for (let trial = 1; trial <= 3; trial++) {
      const id = `${opener}-${trial}`;
      const before = new Set((await send("Target.getTargets")).targetInfos.map((t: any) => t.targetId));
      let timer: NodeJS.Timeout;
      const ready = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`No popup from ${id}`)), 15_000);
        opened.set(id, resolve);
      });
      // Attach the rejection handler before navigation, which can itself fail.
      void ready.catch(() => {});
      let root: string;
      try {
        ({ targetId: root } = await send("Target.createTarget", { url: `http://a.localhost:${port}/?id=${id}&opener=${opener}` }));
        await ready;
      } finally { clearTimeout(timer!); opened.delete(id); }
      const fresh = (await send("Target.getTargets")).targetInfos.filter((t: any) => !before.has(t.targetId) && t.type === "page");
      const popup = fresh.find((t: any) => t.targetId !== root);
      assert.ok(popup, `The ${opener} iframe opened a popup`);
      const result = await metadata(popup.targetId);
      assert.equal(result.targetUrl, "about:blank");
      assert.equal(result.frameUrl, "about:blank");
      // Record Chrome's origin exactly, including an opaque origin.
      trials.push({ opener, trial, ...result });
      for (const target of fresh) await send("Target.closeTarget", { targetId: target.targetId });
    }
  }
  // Destroying the opener must not turn an inherited-origin document into a trusted new blank.
  const extra = [];
  for (const mode of ["close-opener", "remove-frame", "navigate-top"]) {
    const id = mode;
    const marker = mode === "remove-frame" ? `${id}-removed` : mode === "navigate-top" ? `${id}-ready` : id;
    let timer: NodeJS.Timeout;
    const ready = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`No marker from ${id}`)), 15_000);
      opened.set(marker, resolve);
    });
    void ready.catch(() => {});
    const before = new Set((await send("Target.getTargets")).targetInfos.map((t: any) => t.targetId));
    let root: string;
    try {
      ({ targetId: root } = await send("Target.createTarget", { url: `http://a.localhost:${port}/?id=${id}&opener=b.localhost&mode=${mode}` }));
      await ready;
    } finally { clearTimeout(timer!); opened.delete(marker); }
    if (mode === "close-opener") await send("Target.closeTarget", { targetId: root });
    if (mode === "navigate-top") {
      const { sessionId } = await send("Target.attachToTarget", { targetId: root, flatten: true });
      try {
        await send("Page.enable", {}, sessionId);
        await send("Page.bringToFront", {}, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 25, y: 20 }, sessionId);
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 25, y: 20, button: "left", clickCount: 1 }, sessionId);
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 25, y: 20, button: "left", clickCount: 1 }, sessionId);
      } finally { await send("Target.detachFromTarget", { sessionId }); }
    }
    // One bounded settle after the frame destruction or user-activated navigation; no polling loop.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const fresh = (await send("Target.getTargets")).targetInfos.filter((t: any) => !before.has(t.targetId) && t.type === "page");
    assert.ok(fresh.some((target: any) => target.targetId !== root), `${mode}: the iframe opened its popup`);
    const results = [];
    for (const target of fresh) results.push({ kind: target.targetId === root ? "top" : "popup", ...await metadata(target.targetId) });
    extra.push({ mode, results });
    for (const target of fresh) await send("Target.closeTarget", { targetId: target.targetId });
  }
  console.log(JSON.stringify({ product: version.product, port, opaque, trials, extra,
    runtimeCalls: sentMethods.filter((method) => method.startsWith("Runtime.")).length }, null, 2));
} finally {
  if (chrome.exitCode === null && chrome.signalCode === null) {
    const exited = once(chrome, "exit");
    chrome.kill("SIGTERM");
    await exited;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(run, { recursive: true });
}
