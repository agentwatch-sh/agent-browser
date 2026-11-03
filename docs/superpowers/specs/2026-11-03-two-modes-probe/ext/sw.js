// Probe only. The agent-mode extension as the design draws it: a thin bridge.
// It runs a fixed list of chrome.* calls for the relay and forwards chrome
// events; the browser model (Target, Browser, sessions, scopes) lives in the
// relay. The production link is the native messaging link of stage 1; this
// probe uses a loopback WebSocket to the probe relay instead, so it needs no
// native host. The relay port is fixed for the probe.
const RELAY = "ws://127.0.0.1:8790/extension";

let ws = null;
// When true, a new tab gets chrome.debugger at once, before the relay hears of it.
let eagerAttach = false;
const attached = new Set();

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function info() {
  let fullVersion = "";
  try {
    const hv = await navigator.userAgentData.getHighEntropyValues(["fullVersionList"]);
    const b = hv.fullVersionList.find((x) => x.brand === "Chromium" || x.brand === "Google Chrome");
    fullVersion = b ? b.version : "";
  } catch {
    fullVersion = "";
  }
  return { userAgent: navigator.userAgent, fullVersion, id: chrome.runtime.id };
}

const attaching = new Map();
async function attach(tabId) {
  if (attached.has(tabId)) return { already: true };
  if (!attaching.has(tabId)) {
    attaching.set(tabId, chrome.debugger.attach({ tabId }, "1.3").then(() => attached.add(tabId)).finally(() => attaching.delete(tabId)));
  }
  await attaching.get(tabId);
  return { already: false };
}

async function detach(tabId) {
  attached.delete(tabId);
  await chrome.debugger.detach({ tabId });
  return {};
}

// The fixed list of calls the relay may make. Nothing else runs.
const CALLS = {
  "debugger.attach": (tabId) => attach(tabId),
  "debugger.detach": (tabId) => detach(tabId),
  "debugger.sendCommand": (target, method, params) => chrome.debugger.sendCommand(target, method, params || {}),
  "debugger.getTargets": () => chrome.debugger.getTargets(),
  "tabs.create": (props) => chrome.tabs.create(props),
  "tabs.remove": (tabId) => chrome.tabs.remove(tabId),
  "tabs.update": (tabId, props) => chrome.tabs.update(tabId, props),
  "tabs.get": (tabId) => chrome.tabs.get(tabId),
  "tabs.query": (q) => chrome.tabs.query(q || {}),
  "windows.get": (windowId) => chrome.windows.get(windowId),
  "windows.update": (windowId, props) => chrome.windows.update(windowId, props),
  "windows.create": (props) => chrome.windows.create(props),
  "cookies.getAll": (q) => chrome.cookies.getAll(q || {}),
  "cookies.set": (d) => chrome.cookies.set(d),
  "cookies.remove": (d) => chrome.cookies.remove(d),
  "downloads.search": (q) => chrome.downloads.search(q || {}),
  "downloads.cancel": (id) => chrome.downloads.cancel(id),
  "contentSettings.set": (type, details) => chrome.contentSettings[type].set(details),
  "contentSettings.clear": (type) => chrome.contentSettings[type].clear({}),
  "dnr.getMatchedRules": (q) => chrome.declarativeNetRequest.getMatchedRules(q || {}),
  "dnr.updateSessionRules": (o) => chrome.declarativeNetRequest.updateSessionRules(o),
  "bridge.info": () => info(),
  "bridge.eagerAttach": (on) => {
    eagerAttach = Boolean(on);
    return {};
  },
  "bridge.matrix": (tabId, cases) => matrix(tabId, cases),
};

async function call(method, params) {
  if (!Object.hasOwn(CALLS, method)) throw new Error("unknown call " + method);
  return await CALLS[method](...(Array.isArray(params) ? params : []));
}

// The capability matrix: each CDP command on an attached tab, ok or the error.
// Values that later cases need (a node id, a window id) are kept in ctx.
async function matrix(tabId, cases) {
  await attach(tabId).catch(() => {});
  const ctx = {};
  const rows = [];
  for (const c of cases) {
    const params = JSON.parse(JSON.stringify(c.params || {}).replace(/"\$(\w+)"/g, (_, k) => JSON.stringify(ctx[k] ?? null)));
    const target = c.session === "child" ? { tabId, sessionId: ctx.childSession } : { tabId };
    const t0 = performance.now();
    try {
      const result = await chrome.debugger.sendCommand(target, c.method, params);
      const ms = Math.round((performance.now() - t0) * 10) / 10;
      if (c.keep) for (const [k, p] of Object.entries(c.keep)) ctx[k] = p.split(".").reduce((o, x) => (o == null ? o : o[x]), result);
      rows.push({ label: c.label || c.method, method: c.method, ok: true, ms, note: c.show ? c.show.map((p) => p.split(".").reduce((o, x) => (o == null ? o : o[x]), result)) : undefined });
    } catch (e) {
      rows.push({ label: c.label || c.method, method: c.method, ok: false, error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
    if (c.waitMs) await new Promise((r) => setTimeout(r, c.waitMs));
  }
  return rows;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  send({ ev: "debugger.onEvent", source, method, params });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== undefined) attached.delete(source.tabId);
  send({ ev: "debugger.onDetach", source, reason });
});
chrome.tabs.onCreated.addListener(async (tab) => {
  let eager = null;
  if (eagerAttach && tab.id !== undefined) {
    try {
      await attach(tab.id);
      eager = "attached";
    } catch (e) {
      eager = String(e && e.message ? e.message : e);
    }
  }
  send({ ev: "tabs.onCreated", tab, eager });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  send({ ev: "tabs.onRemoved", tabId });
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url || change.title || change.status) send({ ev: "tabs.onUpdated", tabId, tab });
});
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  send({ ev: "webNavigation.onCreatedNavigationTarget", details: d });
});
chrome.webNavigation.onErrorOccurred.addListener((d) => {
  if (d.frameId === 0) send({ ev: "webNavigation.onErrorOccurred", details: { tabId: d.tabId, url: d.url, error: d.error } });
});
chrome.downloads.onCreated.addListener((item) => send({ ev: "downloads.onCreated", item }));
chrome.downloads.onChanged.addListener((delta) => send({ ev: "downloads.onChanged", delta }));

function connect() {
  ws = new WebSocket(RELAY);
  ws.onopen = async () => send({ ev: "hello", info: await info() });
  ws.onmessage = async (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    try {
      const result = await call(m.method, m.params);
      send({ id: m.id, result: result === undefined ? null : result });
    } catch (err) {
      send({ id: m.id, error: String(err && err.message ? err.message : err) });
    }
  };
  ws.onclose = () => setTimeout(connect, 500);
  ws.onerror = () => {};
}

connect();
