// The probe's extension (not the agent package): the design's candidate block, DNR session rules
// with condition.tabIds per scope, plus the three sources of a new tab's opener, the hold, the
// guard and the retry. The driver (probe.mjs) calls the functions of P through CDP
// Runtime.evaluate on this worker. Every chrome event listener is registered while this file runs.
"use strict";

const P = {};
self.P = P;
let log = [];
const ev = (kind, data) => log.push({ t: Date.now(), kind, ...data });

const S = {
  lists: {}, // list name -> hosts
  scopes: {}, // scope -> list name
  def: null, // the list of a scope that the map does not name
  tabScope: new Map(), // tabId -> scope
  inherit: "none", // a popup's scope: "nav" (webNavigation sourceTabId), "tabs" (openerTabId) or "none"
  hold: false, // attach each new tab and hold its document requests (as the agent package does)
  guard: "none", // "commit": act on an off-list main-frame commit; "before": on its onBeforeNavigate
  guardAction: "close", // "close" or "blank"
  retry: false, // reload a tab whose first request was blocked before its rule
  inheritDelay: 0, // ms before a popup's scope is set (to make its rule late on purpose)
  chain: Promise.resolve(),
  ruleIds: [],
  attached: new Set(),
  held: new Map(), // tabId -> paused requestIds
  ruled: new Set(), // the tabs whose rule is in force
  blocked: new Map(), // tabId -> the URL of a first request that was blocked
  tried: new Set(), // the tabs that had their one retry chance
};

const listOf = (scope) => (scope === undefined ? null : S.scopes[scope] ?? S.def);
const covers = (list, host) => list !== null && (S.lists[list] || []).some((d) => host === d || host.endsWith("." + d));
const hostOf = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : null;
  } catch {
    return null;
  }
};

// Two rules per list: main frames (requestDomains) and frames (topDomains), each for the tabs of
// the scopes that use the list. A tab of no scope matches no allow rule: static rules 1 and 3 block it.
function buildRules() {
  const byList = new Map();
  for (const [tabId, scope] of S.tabScope) {
    const l = listOf(scope);
    if (l === null || !(S.lists[l] || []).length) continue;
    if (!byList.has(l)) byList.set(l, []);
    byList.get(l).push(tabId);
  }
  const rules = [];
  let id = 100;
  for (const [l, tabIds] of byList) {
    rules.push({ id: id++, priority: 2, action: { type: "allow" }, condition: { requestDomains: S.lists[l], resourceTypes: ["main_frame"], tabIds } });
    rules.push({ id: id++, priority: 2, action: { type: "allow" }, condition: { topDomains: S.lists[l], resourceTypes: ["sub_frame", "object"], tabIds } });
  }
  return rules;
}

// One updateSessionRules at a time, each from the state when it runs.
function apply() {
  const run = S.chain.then(async () => {
    const rules = buildRules();
    const t0 = Date.now();
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: S.ruleIds, addRules: rules });
    S.ruleIds = rules.map((r) => r.id);
    return Date.now() - t0;
  });
  S.chain = run.catch(() => {});
  return run;
}

async function assign(tabId, scope, why) {
  const t0 = Date.now();
  S.tabScope.set(tabId, scope);
  const ms = await apply();
  ev("ruled", { tabId, scope, why, ms, total: Date.now() - t0 });
  S.ruled.add(tabId);
  setTimeout(() => retry(tabId), 50);
}

async function attach(tabId) {
  if (S.attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  S.attached.add(tabId);
}

// ---- events ----

// A reload (chrome.runtime.reload) starts the worker again through this event.
chrome.runtime.onInstalled.addListener(() => {});

chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
  ev("match", { ruleId: info.rule.ruleId, rs: info.rule.rulesetId, tabId: info.request.tabId, type: info.request.type, url: info.request.url });
});

chrome.tabs.onCreated.addListener((tab) => {
  ev("created", { tabId: tab.id, openerTabId: tab.openerTabId ?? null, pendingUrl: tab.pendingUrl ?? null });
  if (S.inherit === "tabs" && S.tabScope.has(tab.openerTabId)) void assign(tab.id, S.tabScope.get(tab.openerTabId), "tabs");
  if (S.hold) {
    const tabId = tab.id;
    const attaching = chrome.debugger.attach({ tabId }, "1.3");
    const enabling = chrome.debugger.sendCommand({ tabId }, "Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] });
    S.held.set(tabId, []);
    attaching.then(() => {
      S.attached.add(tabId);
      return enabling;
    }).then(async () => {
      ev("held", { tabId });
      const info = await chrome.debugger.sendCommand({ tabId }, "Target.getTargetInfo", {});
      const opener = info && info.targetInfo && info.targetInfo.openerId;
      let openerTab = null;
      if (opener) {
        const targets = await chrome.debugger.getTargets();
        const t = targets.find((x) => x.id === opener);
        openerTab = t ? t.tabId ?? null : null;
      }
      ev("cdpopener", { tabId, openerTab, canAccess: !!(info && info.targetInfo && info.targetInfo.canAccessOpener) });
      // As the relay's release: once the tab has its scope (or after 300 ms), the held requests go on.
      for (let i = 0; i < 30 && !S.tabScope.has(tabId); i++) await new Promise((r) => setTimeout(r, 10));
      await S.chain;
      const n = await P.release(tabId);
      ev("released", { tabId, n, scoped: S.tabScope.has(tabId) });
    }).catch((e) => ev("holderr", { tabId, error: String(e && e.message) }));
  }
});

chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  ev("navtarget", { tabId: d.tabId, sourceTabId: d.sourceTabId, url: d.url, ts: d.timeStamp });
  if (S.inherit === "nav" && S.tabScope.has(d.sourceTabId)) {
    const scope = S.tabScope.get(d.sourceTabId);
    if (S.inheritDelay) setTimeout(() => void assign(d.tabId, scope, "nav"), S.inheritDelay);
    else void assign(d.tabId, scope, "nav");
  }
});

function guard(d, when) {
  if (d.frameId !== 0 || S.guard !== when) return;
  const host = hostOf(d.url);
  if (host === null) return;
  if (covers(listOf(S.tabScope.get(d.tabId)), host)) return;
  const t0 = Date.now();
  const act = S.guardAction === "close" ? chrome.tabs.remove(d.tabId) : chrome.tabs.update(d.tabId, { url: "about:blank" });
  act.then(() => ev("guarded", { tabId: d.tabId, when, url: d.url, ms: Date.now() - t0 }), (e) => ev("guarderr", { tabId: d.tabId, error: String(e && e.message) }));
}

chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId === 0) ev("before", { tabId: d.tabId, url: d.url, ts: d.timeStamp });
  guard(d, "before");
});

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) ev("commit", { tabId: d.tabId, url: d.url, ts: d.timeStamp, tt: d.transitionType, tq: d.transitionQualifiers });
  guard(d, "commit");
});

// The retry: a tab whose first main-frame request was blocked before its rule was in force gets one
// reload once the rule is in force and covers the URL's host.
function retry(tabId) {
  const url = S.blocked.get(tabId);
  if (!S.retry || url === undefined || !S.ruled.has(tabId)) return;
  S.blocked.delete(tabId);
  const host = hostOf(url);
  if (host === null || !covers(listOf(S.tabScope.get(tabId)), host)) return;
  chrome.tabs.reload(tabId).then(() => ev("retried", { tabId, url }), (e) => ev("retryerr", { tabId, error: String(e && e.message) }));
}

chrome.webNavigation.onErrorOccurred.addListener((d) => {
  if (d.frameId !== 0) return;
  ev("error", { tabId: d.tabId, url: d.url, error: d.error, ts: d.timeStamp });
  if (d.error !== "net::ERR_BLOCKED_BY_CLIENT" || S.tried.has(d.tabId)) return;
  S.tried.add(d.tabId);
  S.blocked.set(d.tabId, d.url);
  // The error page commits a moment later; reload after it.
  setTimeout(() => retry(d.tabId), 50);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== "Fetch.requestPaused" || source.sessionId) return;
  ev("paused", { tabId: source.tabId, url: params.request && params.request.url, frameId: params.frameId });
  const list = S.held.get(source.tabId);
  if (list) list.push(params.requestId);
  else chrome.debugger.sendCommand(source, "Fetch.continueRequest", { requestId: params.requestId }).catch(() => {});
});

chrome.debugger.onDetach.addListener((source) => {
  S.attached.delete(source.tabId);
  S.held.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  S.attached.delete(tabId);
  S.held.delete(tabId);
  if (S.tabScope.delete(tabId)) void apply();
});

// ---- the driver's calls ----

P.config = (o) => {
  for (const k of ["inherit", "hold", "guard", "guardAction", "retry", "inheritDelay"]) if (k in o) S[k] = o[k];
  return true;
};

P.setLists = async (lists, scopes, def = null) => {
  S.lists = lists;
  S.scopes = scopes;
  S.def = def;
  return apply();
};

P.newTab = async (scope, active = true) => {
  const tab = await chrome.tabs.create({ url: "about:blank", active });
  if (scope) await assign(tab.id, scope, "create");
  return tab.id;
};

P.assign = (tabId, scope) => assign(tabId, scope, "driver");

P.cmd = async (tabId, method, params = {}) => {
  await attach(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
};

P.nav = (tabId, url) => P.cmd(tabId, "Page.navigate", { url });

P.eval = async (tabId, expression) => {
  const r = await P.cmd(tabId, "Runtime.evaluate", { expression, userGesture: true, awaitPromise: true, returnByValue: true });
  return r && r.result ? r.result.value : null;
};

P.hold = (tabId) => {
  S.held.set(tabId, []);
  return P.cmd(tabId, "Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] });
};

P.release = async (tabId) => {
  const ids = S.held.get(tabId) || [];
  S.held.delete(tabId);
  for (const requestId of ids) await chrome.debugger.sendCommand({ tabId }, "Fetch.continueRequest", { requestId }).catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, "Fetch.disable", {}).catch(() => {});
  return ids.length;
};

P.log = () => {
  const out = log;
  log = [];
  return out;
};

P.tabs = async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url, pendingUrl: t.pendingUrl, active: t.active, openerTabId: t.openerTabId }));

P.activate = (tabId) => chrome.tabs.update(tabId, { active: true }).then(() => true);

P.close = (tabId) => chrome.tabs.remove(tabId).then(() => true, () => false);

// Close every tab but one new about:blank tab, forget every scope and every rule of the probe.
P.reset = async () => {
  const keep = await chrome.tabs.create({ url: "about:blank" });
  for (const t of await chrome.tabs.query({})) if (t.id !== keep.id) await chrome.tabs.remove(t.id).catch(() => {});
  for (const tabId of [...S.attached]) await chrome.debugger.detach({ tabId }).catch(() => {});
  S.attached.clear();
  S.held.clear();
  S.tabScope.clear();
  S.ruled.clear();
  S.blocked.clear();
  S.tried.clear();
  Object.assign(S, { inherit: "none", hold: false, guard: "none", guardAction: "close", retry: false, inheritDelay: 0 });
  await apply();
  const extra = (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id).filter((id) => !S.ruleIds.includes(id));
  if (extra.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: extra });
  log = [];
  return keep.id;
};

P.rules = async () => ({
  session: await chrome.declarativeNetRequest.getSessionRules(),
  dynamic: await chrome.declarativeNetRequest.getDynamicRules(),
});

P.session = (add, removeIds = []) => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: removeIds, addRules: add }).then(() => true);
P.dynamic = (add, removeIds = []) => chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds, addRules: add }).then(() => true);

P.limits = () => {
  const d = chrome.declarativeNetRequest;
  const out = {};
  for (const k of Object.keys(d)) if (/^[A-Z_]+$/.test(k) && typeof d[k] === "number") out[k] = d[k];
  out.version = navigator.userAgent;
  out.id = chrome.runtime.id;
  return out;
};

// How many session rules one extension may hold: n rules at once (then removed).
P.ruleCount = async (n, base = 20000) => {
  const add = [];
  for (let i = 0; i < n; i++) add.push({ id: base + i, priority: 1, action: { type: "allow" }, condition: { requestDomains: [`x${i}.example`], resourceTypes: ["main_frame"], tabIds: [999999] } });
  const t0 = Date.now();
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: add });
  } catch (e) {
    return { n, ok: false, error: String(e && e.message), ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: add.map((r) => r.id) });
  return { n, ok: true, ms };
};

// One rule with nDomains hosts and nTabs tab ids: added, then replaced once (the cost of a new tab), then removed.
P.ruleSize = async (nDomains, nTabs) => {
  const domains = Array.from({ length: nDomains }, (_, i) => `d${i}.example`);
  const tabIds = Array.from({ length: nTabs }, (_, i) => 900000 + i);
  const rule = (ids) => ({ id: 30000, priority: 1, action: { type: "allow" }, condition: { requestDomains: domains, resourceTypes: ["main_frame"], tabIds: ids } });
  const t0 = Date.now();
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule(tabIds)] });
  } catch (e) {
    return { nDomains, nTabs, ok: false, error: String(e && e.message), ms: Date.now() - t0 };
  }
  const add = Date.now() - t0;
  const t1 = Date.now();
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [30000], addRules: [rule([...tabIds, 999999])] });
  const replace = Date.now() - t1;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [30000] });
  return { nDomains, nTabs, ok: true, add, replace };
};

P.removeWorkers = async () => {
  const t0 = Date.now();
  await chrome.browsingData.remove({}, { serviceWorkers: true });
  return Date.now() - t0;
};

P.reload = () => {
  setTimeout(() => chrome.runtime.reload(), 50);
  return true;
};

// nLists lists of nDomains hosts each, two rules per list as the design has them; then the time of
// one tab's assignment (the replace of one list's two rules), as a popup's rule takes it.
P.ruleSet = async (nLists, nDomains) => {
  const rules = (extraTab) => {
    const out = [];
    for (let l = 0; l < nLists; l++) {
      const domains = Array.from({ length: nDomains }, (_, i) => `l${l}d${i}.example`);
      const tabIds = [800000 + l, ...(l === 0 && extraTab ? [999999] : [])];
      out.push({ id: 40000 + 2 * l, priority: 2, action: { type: "allow" }, condition: { requestDomains: domains, resourceTypes: ["main_frame"], tabIds } });
      out.push({ id: 40001 + 2 * l, priority: 2, action: { type: "allow" }, condition: { topDomains: domains, resourceTypes: ["sub_frame", "object"], tabIds } });
    }
    return out;
  };
  const all = rules(false);
  const t0 = Date.now();
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: all });
  } catch (e) {
    return { nLists, nDomains, ok: false, error: String(e && e.message) };
  }
  const add = Date.now() - t0;
  const two = rules(true).slice(0, 2);
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t1 = Date.now();
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [40000, 40001], addRules: two });
    times.push(Date.now() - t1);
  }
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: all.map((r) => r.id) });
  return { nLists, nDomains, ok: true, add, assign: times };
};
