// Probe only: a prototype of the agent-mode CDP endpoint (the design's
// "browser model"). CDP clients (Playwright connectOverCDP, the Playwright
// MCP's --cdp-endpoint, Puppeteer, agent-browser) connect to
//   ws://127.0.0.1:<port>/devtools/browser/<scope>        (loopback TCP)
//   ws+unix://<socket>:/devtools/browser/<scope>          (Unix socket)
// The relay answers the browser-level domains (Browser, Target, Storage)
// itself from chrome.* calls, and forwards every page-session command to
// chrome.debugger.sendCommand in the extension. The extension is a thin
// bridge (ext/sw.js). Each connection belongs to a scope: it sees only the
// tabs of that scope, and the tabs it opens (and their popups) join it.
//
// Sessions: a client may hold several sessions on one tab (auto-attach,
// Target.attachToTarget, Playwright's newCDPSession). All of them share the
// one chrome.debugger attachment of that tab, so a tab belongs to one client
// connection at a time (its owner): another connection of the scope sees the
// tab but cannot attach. When the owner leaves, the relay detaches, so no
// domain state (Fetch, Emulation, the file chooser) stays behind.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(path.join(process.env.PW_DIR, "package.json"));
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.RELAY_PORT || 8790);
const SOCK = process.env.RELAY_SOCK || "";
const ALLOW = (process.env.ALLOWLIST || "a.localhost").split(",");
const LOGFILE = process.env.RELAY_LOG || "relay-log.jsonl";
// A CDP client over loopback TCP must send this token in the x-probe-token header
// (every local user can reach the port). The Unix socket (0600) needs none.
const TOKEN = process.env.RELAY_TOKEN || "";
// Playwright needs a non-empty browserContextId on each target; one stable id names the one profile.
const DEFAULT_CONTEXT = "agentwatch-default";

const log = (o) => fs.appendFileSync(LOGFILE, JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");
const covers = (host) => ALLOW.some((d) => host === d || host.endsWith("." + d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- extension
let ext = null;
let extInfo = null;
let nextExtId = 1;
const extPending = new Map();

function extCall(method, ...params) {
  if (!ext) return Promise.reject(new Error("the agent-mode extension is not connected"));
  const id = nextExtId++;
  ext.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!extPending.has(id)) return;
      extPending.delete(id);
      log({ t: "ext-timeout", method, cdp: method === "debugger.sendCommand" ? params[1] : undefined });
      reject(new Error(`the extension did not answer ${method} in 15 s`));
    }, 15000);
    extPending.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
  });
}

// -------------------------------------------------------------------- model
// tabId -> { tabId, targetId, scope, opener, attached, attaching, sessions: Map<sessionId, client>, pending }
const tabs = new Map();
// child CDP session id (an OOPIF or a worker, from Chrome) -> tabId
const childSessions = new Map();
const clients = new Set();
let nextClient = 1;
let nextSession = 1;
// download guid -> { client, url }
const downloads = new Map();
// Target.createTarget calls in flight: a new tab with no opener waits for them,
// so that only its creator takes a tab that createTarget opened.
const creating = new Set();

function tabByTarget(targetId) {
  for (const t of tabs.values()) if (t.targetId === targetId) return t;
  return null;
}

async function targetIdOf(tabId) {
  for (let i = 0; i < 40; i++) {
    const list = await extCall("debugger.getTargets");
    const hit = list.find((t) => t.tabId === tabId);
    if (hit) return hit.id;
    await sleep(50);
  }
  return null;
}

async function targetInfo(tab) {
  const t = await extCall("tabs.get", tab.tabId).catch(() => null);
  const opener = tab.opener !== null && tabs.get(tab.opener) ? tabs.get(tab.opener).targetId : undefined;
  return {
    targetId: tab.targetId, type: "page", title: t ? t.title || "" : "", url: t ? t.pendingUrl || t.url || "" : "",
    attached: Boolean(tab.owner), canAccessOpener: false, browserContextId: DEFAULT_CONTEXT,
    ...(opener ? { openerId: opener } : {}),
  };
}

// One chrome.debugger attach per tab, also when two callers ask at once.
function ensureDebugger(tab) {
  if (tab.attached) return Promise.resolve();
  if (!tab.attaching) {
    tab.attaching = extCall("debugger.attach", tab.tabId)
      .then(() => {
        tab.attached = true;
      })
      .finally(() => {
        tab.attaching = null;
      });
  }
  return tab.attaching;
}

// A new session of client on tab. eventSession is the session that carries
// the Target.attachedToTarget event: undefined for the root, or a browser session.
async function newSession(client, tab, eventSession) {
  if (tab.owner && tab.owner !== client) throw new Error("The tab is in use by another connection of this scope");
  tab.owner = client;
  try {
    await ensureDebugger(tab);
  } catch (e) {
    // A failed attach leaves the tab free again.
    if (tab.sessions.size === 0) tab.owner = null;
    throw e;
  }
  const sessionId = `AB${client.id}S${nextSession++}`;
  const info = await targetInfo(tab);
  tab.sessions.set(sessionId, client);
  client.sessions.set(sessionId, tab.tabId);
  client.parents.set(sessionId, eventSession);
  client.event(eventSession, "Target.attachedToTarget", { sessionId, targetInfo: { ...info, attached: true }, waitingForDebugger: false });
  return sessionId;
}

// The auto-attach session: one per client and tab, also when Target.createTarget
// and the tabs.onCreated event both ask for it.
function autoAttach(client, tab) {
  if (client.auto.has(tab.tabId)) return Promise.resolve(client.auto.get(tab.tabId));
  if (tab.owner && tab.owner !== client) return Promise.resolve(null);
  if (tab.pending.has(client)) return tab.pending.get(client);
  const p = newSession(client, tab, undefined)
    .then((sid) => {
      client.auto.set(tab.tabId, sid);
      return sid;
    })
    .finally(() => tab.pending.delete(client));
  tab.pending.set(client, p);
  return p;
}

async function endSession(client, sessionId, notify = true) {
  const tabId = client.sessions.get(sessionId);
  const tab = tabs.get(tabId);
  // Chrome sends Target.detachedFromTarget on the session that attached it (the root or a browser session).
  const parent = client.parents.get(sessionId);
  client.parents.delete(sessionId);
  client.sessions.delete(sessionId);
  if (client.auto.get(tabId) === sessionId) client.auto.delete(tabId);
  if (!tab) return;
  tab.sessions.delete(sessionId);
  if (notify) client.event(parent, "Target.detachedFromTarget", { sessionId, targetId: tab.targetId });
  // The owner's last session leaves: the tab is free again, and the relay
  // detaches, so no domain state (Fetch, Emulation) stays behind.
  if (tab.sessions.size === 0) {
    tab.owner = null;
    if (tab.attached) {
      tab.attached = false;
      await extCall("debugger.detach", tab.tabId).catch(() => {});
    }
  }
}

function scopeTabs(scope) {
  return [...tabs.values()].filter((t) => t.scope === scope && t.targetId);
}

async function addTab(chromeTab, scope) {
  let tab = tabs.get(chromeTab.id);
  if (!tab) {
    tab = { tabId: chromeTab.id, targetId: null, scope, opener: chromeTab.openerTabId ?? null, attached: false, attaching: null, owner: null, sessions: new Map(), pending: new Map() };
    tabs.set(chromeTab.id, tab);
  }
  if (tab.scope === null && scope !== null) tab.scope = scope;
  if (!tab.targetId) tab.targetId = await targetIdOf(chromeTab.id);
  return tab;
}

async function announce(tab) {
  const opener = tab.opener !== null ? tabs.get(tab.opener) : null;
  const heir = opener && opener.owner ? opener.owner : null;
  for (const c of clients) {
    if (c.scope !== tab.scope) continue;
    if (c.discover) c.event(undefined, "Target.targetCreated", { targetInfo: await targetInfo(tab) });
  }
  // A popup belongs to the connection that holds its opener.
  const takers = heir ? [heir] : [...clients].filter((c) => c.scope === tab.scope && c.autoAttach);
  for (const c of takers) {
    if (!c.autoAttach || tab.owner) continue;
    await autoAttach(c, tab).catch((e) => log({ t: "attach-failed", tab: tab.tabId, error: e.message }));
  }
}

// ------------------------------------------------------------ cookie mapping
const SAME_SITE = { strict: "Strict", lax: "Lax", no_restriction: "None" };
function cdpCookie(c) {
  return {
    name: c.name, value: c.value, domain: c.hostOnly ? c.domain : c.domain.startsWith(".") ? c.domain : "." + c.domain,
    path: c.path, expires: c.session ? -1 : c.expirationDate, size: c.name.length + c.value.length,
    httpOnly: c.httpOnly, secure: c.secure, session: c.session,
    ...(SAME_SITE[c.sameSite] ? { sameSite: SAME_SITE[c.sameSite] } : {}),
    priority: "Medium", sourceScheme: c.secure ? "Secure" : "NonSecure",
  };
}

// The CDP permission names (as Playwright sends them) that chrome.contentSettings can grant.
const CONTENT = {
  geolocation: "location", notifications: "notifications", videoCapture: "camera", audioCapture: "microphone",
  clipboardReadWrite: "clipboard", clipboardSanitizedWrite: "clipboard",
};
// Content settings are profile-wide; each connection's grants are kept apart, and a
// type is rebuilt from the grants that remain when a connection resets or leaves.
async function rebuildGrants(types) {
  for (const type of types) {
    await extCall("contentSettings.clear", type);
    const patterns = new Set();
    for (const c of clients) for (const g of c.grants) if (g.type === type) patterns.add(g.pattern);
    for (const pattern of patterns) await extCall("contentSettings.set", type, { primaryPattern: pattern, setting: "allow" });
  }
}

// A window call acts only on a window that holds a tab of the client's scope.
async function windowInScope(client, windowId) {
  const inWindow = await extCall("tabs.query", { windowId });
  if (!inWindow.some((t) => tabs.has(t.id) && tabs.get(t.id).scope === client.scope)) throw new Error("Browser window not found");
}

// --------------------------------------------------------- browser commands
// Each handler gets (client, params, ctx); ctx.tab is the tab of the page
// session it came on, ctx.browserSession the browser session it came on.
const BROWSER = {
  async "Browser.getVersion"() {
    const product = "Chrome/" + (extInfo && extInfo.fullVersion ? extInfo.fullVersion : "0");
    return { protocolVersion: "1.3", product, revision: "", userAgent: extInfo ? extInfo.userAgent : "", jsVersion: "" };
  },
  async "Browser.setDownloadBehavior"(client, p) {
    client.download = { behavior: p.behavior, downloadPath: p.downloadPath, eventsEnabled: Boolean(p.eventsEnabled) };
    return {};
  },
  async "Browser.close"(client) {
    // A client never ends the shared agent browser: Browser.close ends this connection only.
    setTimeout(() => client.ws.close(1000, "Browser.close ends this connection; the agent browser keeps running"), 50);
    return {};
  },
  async "Browser.getWindowForTarget"(client, p, ctx) {
    const tab = ctx.tab || tabByTarget(p.targetId);
    if (!tab || tab.scope !== client.scope) throw new Error("No target with given id found");
    const t = await extCall("tabs.get", tab.tabId);
    const w = await extCall("windows.get", t.windowId);
    return { windowId: t.windowId, bounds: { left: w.left, top: w.top, width: w.width, height: w.height, windowState: w.state } };
  },
  async "Browser.getWindowBounds"(client, p) {
    await windowInScope(client, p.windowId);
    const w = await extCall("windows.get", p.windowId);
    return { bounds: { left: w.left, top: w.top, width: w.width, height: w.height, windowState: w.state } };
  },
  async "Browser.setWindowBounds"(client, p) {
    await windowInScope(client, p.windowId);
    const b = p.bounds || {};
    const props = {};
    for (const k of ["left", "top", "width", "height"]) if (b[k] !== undefined) props[k] = b[k];
    if (b.windowState) props.state = b.windowState;
    await extCall("windows.update", p.windowId, props);
    return {};
  },
  async "Browser.grantPermissions"(client, p) {
    const origin = p.origin || "";
    if (origin && !covers(new URL(origin).hostname)) throw new Error(`Not allowed: ${new URL(origin).hostname} is not on the allowlist`);
    // No origin means every origin: the relay grants it for each allowlisted domain only.
    const patterns = origin ? [origin.replace(/\/$/, "") + "/*"] : ALLOW.map((d) => `*://*.${d}/*`);
    for (const name of p.permissions || []) if (!CONTENT[name]) throw new Error(`Not available in the agent browser: the permission ${name}`);
    for (const name of p.permissions || []) {
      for (const pattern of patterns) {
        await extCall("contentSettings.set", CONTENT[name], { primaryPattern: pattern, setting: "allow" });
        client.grants.push({ type: CONTENT[name], pattern });
      }
    }
    return {};
  },
  async "Browser.resetPermissions"(client) {
    const types = new Set(client.grants.map((g) => g.type));
    client.grants = [];
    await rebuildGrants(types);
    return {};
  },
  async "Browser.cancelDownload"(client, p) {
    const d = downloads.get(p.guid);
    if (!d) return {};
    const items = await extCall("downloads.search", { url: d.url, state: "in_progress" });
    for (const item of items) await extCall("downloads.cancel", item.id).catch(() => {});
    return {};
  },
  async "Target.attachToBrowserTarget"(client) {
    const sessionId = `AB${client.id}B${nextSession++}`;
    client.browserSessions.add(sessionId);
    return { sessionId };
  },
  async "Target.setAutoAttach"(client, p) {
    client.autoAttach = Boolean(p.autoAttach);
    if (client.autoAttach) for (const tab of scopeTabs(client.scope)) await autoAttach(client, tab);
    return {};
  },
  async "Target.setDiscoverTargets"(client, p) {
    client.discover = Boolean(p.discover);
    if (client.discover) for (const tab of scopeTabs(client.scope)) client.event(undefined, "Target.targetCreated", { targetInfo: await targetInfo(tab) });
    return {};
  },
  async "Target.getTargets"(client) {
    const infos = [];
    for (const tab of scopeTabs(client.scope)) infos.push(await targetInfo(tab));
    return { targetInfos: infos };
  },
  async "Target.getTargetInfo"(client, p) {
    if (p && p.targetId) {
      const tab = tabByTarget(p.targetId);
      if (!tab || tab.scope !== client.scope) throw new Error("No target with given id found");
      return { targetInfo: await targetInfo(tab) };
    }
    return { targetInfo: { targetId: "agentwatch-browser", type: "browser", title: "", url: "", attached: true, canAccessOpener: false } };
  },
  async "Target.getBrowserContexts"() {
    return { browserContextIds: [] };
  },
  async "Target.createBrowserContext"() {
    throw new Error("Not available in the agent browser: a new browser context (Target.createBrowserContext). Use the default context: browser.contexts()[0].");
  },
  async "Target.createTarget"(client, p) {
    if (p.browserContextId && p.browserContextId !== DEFAULT_CONTEXT) throw new Error("No browser context with given id found");
    const url = p.url || "about:blank";
    let done;
    const flight = new Promise((r) => (done = r));
    creating.add(flight);
    try {
      const created = p.newWindow ? (await extCall("windows.create", { url, focused: false })).tabs[0] : await extCall("tabs.create", { url, active: !p.background });
      const tab = await addTab(created, client.scope);
      tab.claimed = true;
      // The creator owns the new tab. Playwright expects Target.attachedToTarget before the answer.
      if (client.autoAttach) await autoAttach(client, tab);
      return { targetId: tab.targetId };
    } finally {
      creating.delete(flight);
      done();
    }
  },
  async "Target.closeTarget"(client, p) {
    const tab = tabByTarget(p.targetId);
    if (!tab || tab.scope !== client.scope) throw new Error("No target with given id found");
    await extCall("tabs.remove", tab.tabId);
    return { success: true };
  },
  async "Target.activateTarget"(client, p) {
    const tab = tabByTarget(p.targetId);
    if (!tab || tab.scope !== client.scope) throw new Error("No target with given id found");
    await extCall("tabs.update", tab.tabId, { active: true });
    return {};
  },
  async "Target.attachToTarget"(client, p, ctx) {
    const tab = tabByTarget(p.targetId);
    if (!tab || tab.scope !== client.scope) throw new Error("No target with given id found");
    return { sessionId: await newSession(client, tab, ctx.browserSession) };
  },
  async "Target.detachFromTarget"(client, p) {
    if (!client.sessions.has(p.sessionId)) throw new Error("No session with given id");
    await endSession(client, p.sessionId);
    return {};
  },
  async "Storage.getCookies"() {
    const all = await extCall("cookies.getAll", {});
    return { cookies: all.filter((c) => covers(c.domain.replace(/^\./, ""))).map(cdpCookie) };
  },
  async "Storage.setCookies"(client, p) {
    for (const c of p.cookies || []) {
      // Both the cookie's domain and its URL must be on the list.
      const hosts = [c.domain ? c.domain.replace(/^\./, "") : null, c.url ? new URL(c.url).hostname : null].filter(Boolean);
      for (const h of hosts) if (!covers(h)) throw new Error(`Not allowed: ${h} is not on the allowlist`);
      const host = hosts[0];
      const d = { url: c.url || `${c.secure ? "https" : "http"}://${host}${c.path || "/"}`, name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly };
      if (c.domain && c.domain.startsWith(".")) d.domain = c.domain;
      if (c.expires && c.expires > 0) d.expirationDate = c.expires;
      if (c.sameSite) d.sameSite = { Strict: "strict", Lax: "lax", None: "no_restriction" }[c.sameSite];
      await extCall("cookies.set", d);
    }
    return {};
  },
  async "Storage.clearCookies"() {
    const all = await extCall("cookies.getAll", {});
    for (const c of all.filter((x) => covers(x.domain.replace(/^\./, "")))) {
      await extCall("cookies.remove", { url: `${c.secure ? "https" : "http"}://${c.domain.replace(/^\./, "")}${c.path}`, name: c.name });
    }
    return {};
  },
};
// Browser-domain calls that Playwright sends on a page session; the relay answers them too.
const ON_PAGE = new Set(["Browser.getWindowForTarget", "Browser.getWindowBounds", "Browser.setWindowBounds"]);

// -------------------------------------------------------------- CDP clients
class Client {
  constructor(ws, scope) {
    this.id = nextClient++;
    this.ws = ws;
    this.scope = scope;
    this.sessions = new Map(); // our page session id -> tabId
    this.auto = new Map(); // tabId -> the auto-attach session id
    this.browserSessions = new Set();
    this.parents = new Map(); // page session id -> the session that attached it (undefined: the root)
    this.autoAttach = false;
    this.discover = false;
    this.download = null;
    this.grants = []; // { type, pattern } content settings this connection granted
  }
  send(msg) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }
  event(sessionId, method, params) {
    this.send(sessionId ? { sessionId, method, params } : { method, params });
  }
}

async function onClientMessage(client, msg) {
  const { id, method, params, sessionId } = msg;
  log({ t: "cdp", c: client.id, method, s: sessionId ? 1 : 0 });
  const reply = (result) => client.send(sessionId ? { id, sessionId, result } : { id, result });
  const fail = (message) => client.send(sessionId ? { id, sessionId, error: { code: -32000, message } } : { id, error: { code: -32000, message } });
  try {
    if (!sessionId || client.browserSessions.has(sessionId)) {
      if (!Object.hasOwn(BROWSER, method)) return fail(`Not available in the agent browser: ${method}`);
      return reply(await BROWSER[method](client, params || {}, { browserSession: sessionId }));
    }
    let tabId = client.sessions.get(sessionId);
    let target;
    if (tabId !== undefined) {
      if (ON_PAGE.has(method)) return reply(await BROWSER[method](client, params || {}, { tab: tabs.get(tabId) }));
      target = { tabId };
    } else if (childSessions.has(sessionId)) {
      tabId = childSessions.get(sessionId);
      const tab = tabs.get(tabId);
      if (!tab || ![...tab.sessions.values()].includes(client)) return fail("Session not found");
      target = { tabId, sessionId };
    } else {
      log({ t: "no-session", c: client.id, method });
      return fail("Session not found");
    }
    // A CDP mouse press reports pointer pressure 0, a real mouse 0.5 (ab-v16.2 interim finding 5).
    const sent = params || {};
    if (method === "Input.dispatchMouseEvent" && sent.force === undefined && (sent.type === "mousePressed" || (sent.type === "mouseMoved" && sent.buttons))) sent.force = 0.5;
    reply(await extCall("debugger.sendCommand", target, method, sent));
  } catch (e) {
    fail(String(e && e.message ? e.message : e));
  }
}

// ------------------------------------------------------- extension events
async function onDownloadEvent(tab, method, params) {
  const owners = new Set(tab.sessions.values());
  if (method === "Page.downloadWillBegin") {
    for (const c of owners) {
      if (!c.download || !c.download.eventsEnabled) continue;
      downloads.set(params.guid, { client: c, url: params.url });
      c.event(undefined, "Browser.downloadWillBegin", params);
    }
  }
  if (method === "Page.downloadProgress") {
    const d = downloads.get(params.guid);
    if (!d) return;
    if (params.state !== "completed") return d.client.event(undefined, "Browser.downloadProgress", params);
    // Chrome saved the file in its own download folder; Playwright reads <downloadPath>/<guid>.
    for (let i = 0; i < 50; i++) {
      const [item] = await extCall("downloads.search", { url: d.url, orderBy: ["-startTime"], limit: 1 });
      if (item && item.state === "complete" && item.filename) {
        fs.copyFileSync(item.filename, path.join(d.client.download.downloadPath, params.guid));
        break;
      }
      await sleep(100);
    }
    d.client.event(undefined, "Browser.downloadProgress", params);
    downloads.delete(params.guid);
  }
}

async function onExtEvent(m) {
  if (m.ev === "hello") {
    extInfo = m.info;
    log({ t: "ext-hello", info: m.info });
    const open = await extCall("tabs.query", {});
    for (const t of open) await addTab(t, null);
    return;
  }
  if (m.ev === "debugger.onEvent") {
    const tab = tabs.get(m.source.tabId);
    if (!tab) return;
    const p = m.params || {};
    if (m.method === "Target.attachedToTarget") childSessions.set(p.sessionId, tab.tabId);
    if (m.method === "Target.detachedFromTarget") childSessions.delete(p.sessionId);
    if (m.method === "Page.downloadWillBegin" || m.method === "Page.downloadProgress") await onDownloadEvent(tab, m.method, p);
    if (m.source.sessionId) {
      // An event of a child session (a frame or a worker): once to each client on the tab.
      for (const c of new Set(tab.sessions.values())) c.event(m.source.sessionId, m.method, p);
    } else {
      for (const [sid, c] of tab.sessions) c.event(sid, m.method, p);
    }
    return;
  }
  if (m.ev === "debugger.onDetach") {
    const tab = tabs.get(m.source.tabId);
    log({ t: "debugger-detach", tab: m.source.tabId, reason: m.reason, sessions: tab ? tab.sessions.size : 0 });
    if (!tab) return;
    tab.attached = false;
    for (const [sid, c] of [...tab.sessions]) await endSession(c, sid);
    return;
  }
  if (m.ev === "tabs.onCreated") {
    const known = tabs.has(m.tab.id);
    const tab = await addTab(m.tab, null);
    if (m.eager === "attached") tab.attached = true;
    // A tab that Target.createTarget opened goes to its creator only.
    if (known) return;
    await Promise.allSettled([...creating]);
    if (tab.claimed || tab.owner) return;
    // The opener comes from Chrome's own target info: chrome.tabs' openerTabId can
    // name the active tab instead of the tab that called window.open (measured).
    tab.opener = null;
    try {
      await ensureDebugger(tab);
      const { targetInfo: ti } = await extCall("debugger.sendCommand", { tabId: tab.tabId }, "Target.getTargetInfo");
      const opener = ti && ti.openerId ? tabByTarget(ti.openerId) : null;
      if (opener) {
        tab.opener = opener.tabId;
        tab.scope = opener.scope;
      }
    } catch (e) {
      log({ t: "opener-unknown", tab: tab.tabId, error: e.message });
    }
    log({ t: "tab-created", tab: m.tab.id, chromeOpener: m.tab.openerTabId ?? null, opener: tab.opener, scope: tab.scope });
    await announce(tab);
    // Nobody took it: detach again, so the tab carries no debugger.
    if (!tab.owner && tab.attached) {
      tab.attached = false;
      await extCall("debugger.detach", tab.tabId).catch(() => {});
    }
    return;
  }
  if (m.ev === "tabs.onRemoved") {
    const tab = tabs.get(m.tabId);
    if (!tab) return;
    for (const [sid, c] of [...tab.sessions]) {
      const parent = c.parents.get(sid);
      c.parents.delete(sid);
      c.sessions.delete(sid);
      if (c.auto.get(tab.tabId) === sid) c.auto.delete(tab.tabId);
      c.event(parent, "Target.detachedFromTarget", { sessionId: sid, targetId: tab.targetId });
    }
    for (const c of clients) if (c.discover && c.scope === tab.scope) c.event(undefined, "Target.targetDestroyed", { targetId: tab.targetId });
    tabs.delete(m.tabId);
    return;
  }
  if (m.ev === "webNavigation.onErrorOccurred") {
    let host = "";
    try {
      host = new URL(m.details.url).host;
    } catch {}
    log({ t: "nav-error", tabId: m.details.tabId, host, error: m.details.error });
  }
}

// ------------------------------------------------------------------ servers
function scopeOf(pathname) {
  const m = /^\/devtools\/browser\/([A-Za-z0-9._-]{1,64})$/.exec(pathname);
  return m ? m[1] : null;
}

function onHttp(req, res, viaUnix) {
  const url = new URL(req.url, "http://relay");
  if (req.method === "POST" && url.pathname === "/control" && viaUnix) {
    // Probe control only (the matrix, a plain tab for the baseline). Not part of the design.
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      try {
        const { method, params } = JSON.parse(body);
        const result = await extCall(method, ...(params || []));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ result }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  const m = /^\/scope\/([A-Za-z0-9._-]{1,64})\/json\/version\/?$/.exec(url.pathname);
  if (m) {
    const body = { Browser: "Chrome/" + (extInfo ? extInfo.fullVersion : ""), "Protocol-Version": "1.3", "User-Agent": extInfo ? extInfo.userAgent : "", webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/browser/${m[1]}` };
    return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  }
  if (url.pathname === "/status") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ extension: Boolean(ext), tabs: tabs.size, clients: clients.size }));
  res.writeHead(404).end();
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
function onUpgrade(req, socket, head, viaUnix) {
  const url = new URL(req.url, "http://relay");
  // The extension may connect over loopback only, from its own origin.
  if (url.pathname === "/extension") {
    const origin = req.headers.origin || "";
    if (viaUnix || !origin.startsWith("chrome-extension://")) return socket.destroy();
    return wss.handleUpgrade(req, socket, head, (ws) => {
      ext = ws;
      ws.on("message", (data) => {
        const m = JSON.parse(data.toString());
        if (m.id !== undefined && extPending.has(m.id)) {
          const p = extPending.get(m.id);
          extPending.delete(m.id);
          if (m.error !== undefined) p.reject(new Error(m.error));
          else p.resolve(m.result);
          return;
        }
        if (m.ev) onExtEvent(m).catch((e) => log({ t: "ext-event-failed", ev: m.ev, error: e.message }));
      });
      ws.on("close", () => {
        if (ext === ws) ext = null;
      });
    });
  }
  const scope = scopeOf(url.pathname);
  if (!scope) return socket.destroy();
  // A page's script cannot reach this endpoint: a browser WebSocket carries an Origin header.
  if (req.headers.origin) return socket.destroy();
  if (!viaUnix && (!TOKEN || req.headers["x-probe-token"] !== TOKEN)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    const client = new Client(ws, scope);
    clients.add(client);
    log({ t: "client-open", c: client.id, scope, via: viaUnix ? "unix" : "tcp" });
    ws.on("message", (data) => onClientMessage(client, JSON.parse(data.toString())));
    ws.on("close", async () => {
      clients.delete(client);
      log({ t: "client-close", c: client.id });
      for (const sid of [...client.sessions.keys()]) await endSession(client, sid, false).catch(() => {});
      const types = new Set(client.grants.map((g) => g.type));
      client.grants = [];
      await rebuildGrants(types).catch(() => {});
    });
  });
}

const tcp = http.createServer((req, res) => onHttp(req, res, false));
tcp.on("upgrade", (req, socket, head) => onUpgrade(req, socket, head, false));
tcp.listen(PORT, "127.0.0.1", () => log({ t: "listen", port: PORT }));
if (SOCK) {
  const unix = http.createServer((req, res) => onHttp(req, res, true));
  unix.on("upgrade", (req, socket, head) => onUpgrade(req, socket, head, true));
  unix.listen(SOCK, () => {
    fs.chmodSync(SOCK, 0o600);
    log({ t: "listen", sock: SOCK });
  });
  // The server closes its own socket when it stops; close() removes the socket file.
  process.on("SIGTERM", () => {
    unix.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
