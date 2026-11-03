// The parity probe extension: it says that it is loaded, then runs the probe's commands, the
// way an agent mode would drive a tab: chrome.debugger and CDP input, an isolated world, and the
// Runtime domain that Playwright enables. It talks only to the probe server on probe.localhost.
import config from "./config.js";

const S = config.server;
const post = (body) => fetch(`${S}/ext/report`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An MV3 service worker starts with the browser only when it listens to onStartup; without this
// listener an installed extension stays asleep after a relaunch and the probe would miss it.
chrome.runtime.onStartup.addListener(() => {});
chrome.runtime.onInstalled.addListener(() => {});
post({ kind: "alive", id: chrome.runtime.id, userAgent: navigator.userAgent, t: Date.now() });
chrome.debugger.onDetach.addListener((source, reason) => post({ kind: "detached", tabId: source.tabId, reason }));

let tabId;
const cb = (f) => new Promise((resolve, reject) => f((r) => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(r))));
const send = (method, params = {}) => cb((done) => chrome.debugger.sendCommand({ tabId }, method, params, done));

const ops = {
  async findTab({ urlPrefix }) {
    for (let i = 0; i < 40; i++) {
      const t = (await chrome.tabs.query({})).find((x) => x.url && x.url.startsWith(urlPrefix));
      if (t) { tabId = t.id; return { tabId, url: t.url, windowId: t.windowId }; }
      await sleep(250);
    }
    throw new Error("no tab");
  },
  async attach() { await cb((done) => chrome.debugger.attach({ tabId }, "1.3", done)); return { attached: true }; },
  async detach() { await cb((done) => chrome.debugger.detach({ tabId }, done)); return { detached: true }; },
  async cdp({ method, params }) { return await send(method, params); },
  // force: undefined gives CDP's default (a pointerdown with pressure 0); 0.5 is what a real mouse reports.
  async click({ x, y, force }) {
    const f = force === undefined ? {} : { force };
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, ...f });
    await sleep(60);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    return {};
  },
  async type({ text }) {
    for (const ch of text) {
      const code = `Key${ch.toUpperCase()}`, vk = ch.toUpperCase().charCodeAt(0);
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code, text: ch, windowsVirtualKeyCode: vk });
      await sleep(40);
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code, windowsVirtualKeyCode: vk });
      await sleep(40);
    }
    return {};
  },
  async isolatedEval({ expression }) {
    const { frameTree } = await send("Page.getFrameTree");
    const { executionContextId } = await send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "probe" });
    const r = await send("Runtime.evaluate", { expression, contextId: executionContextId, returnByValue: true });
    return { value: r.result && r.result.value };
  },
  async newTab({ url, active }) { const t = await chrome.tabs.create({ url, active }); return { id: t.id }; },
  async closeTab({ tab }) { await chrome.tabs.remove(tab); return {}; },
  async self() {
    let installType = null;
    try { installType = (await chrome.management.getSelf()).installType; } catch { /* no management API */ }
    return { id: chrome.runtime.id, installType };
  },
};

(async function loop() {
  for (;;) {
    let cmd;
    try {
      const r = await fetch(`${S}/ext/cmd`);
      if (r.status !== 200) continue;
      cmd = await r.json();
    } catch { await sleep(500); continue; }
    let result, error;
    try { result = await ops[cmd.op](cmd); } catch (e) { error = String((e && e.message) || e); }
    await post({ kind: "result", id: cmd.id, op: cmd.op, result, error, t: Date.now() });
  }
})();
