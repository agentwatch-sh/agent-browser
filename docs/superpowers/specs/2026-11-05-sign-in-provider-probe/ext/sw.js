// The probe extension of part "initiator" (board task ab-v16.45). Not the agent package. It logs, for every
// main-frame and frame request, who started it (webRequest's initiator), its redirects, the DNR rule that matched
// (onRuleMatchedDebug, unpacked only), the webNavigation transition, and the chrome.debugger events that the relay
// would see (Page.frameRequestedNavigation, Page.frameStartedNavigating). The probe calls the functions on
// globalThis through Chromium's debugging pipe. It sends nothing anywhere.

const log = [];
globalThis.log = log;
globalThis.take = () => log.splice(0, log.length);
const push = (e) => log.push({ t: Date.now(), ...e });
const types = ["main_frame", "sub_frame"];

chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (types.includes(d.type)) push({ ev: "request", tabId: d.tabId, type: d.type, method: d.method, url: d.url, initiator: d.initiator ?? null, requestId: d.requestId });
}, { urls: ["<all_urls>"] });
chrome.webRequest.onBeforeRedirect.addListener((d) => {
  if (types.includes(d.type)) push({ ev: "redirect", tabId: d.tabId, type: d.type, url: d.url, to: d.redirectUrl, initiator: d.initiator ?? null, requestId: d.requestId, status: d.statusCode });
}, { urls: ["<all_urls>"] });
chrome.webRequest.onErrorOccurred.addListener((d) => {
  if (types.includes(d.type)) push({ ev: "error", tabId: d.tabId, type: d.type, url: d.url, error: d.error, initiator: d.initiator ?? null, requestId: d.requestId });
}, { urls: ["<all_urls>"] });
chrome.webRequest.onCompleted.addListener((d) => {
  if (types.includes(d.type)) push({ ev: "completed", tabId: d.tabId, type: d.type, url: d.url, status: d.statusCode, initiator: d.initiator ?? null, requestId: d.requestId });
}, { urls: ["<all_urls>"] });
chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((i) => {
  push({ ev: "rule", rule: i.rule.ruleId, tabId: i.request.tabId, type: i.request.type, url: i.request.url, initiator: i.request.initiator ?? null, method: i.request.method });
});
chrome.webNavigation.onBeforeNavigate.addListener((d) => { if (d.frameId === 0) push({ ev: "nav.before", tabId: d.tabId, url: d.url }); });
chrome.webNavigation.onCommitted.addListener((d) => {
  push({ ev: "nav.committed", tabId: d.tabId, frameId: d.frameId, url: d.url, transitionType: d.transitionType, transitionQualifiers: d.transitionQualifiers });
});
chrome.webNavigation.onErrorOccurred.addListener((d) => { push({ ev: "nav.error", tabId: d.tabId, frameId: d.frameId, url: d.url, error: d.error }); });
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => { push({ ev: "nav.target", tabId: d.tabId, sourceTabId: d.sourceTabId, url: d.url }); });
chrome.tabs.onCreated.addListener((t) => { push({ ev: "tab.created", tabId: t.id, openerTabId: t.openerTabId ?? null, url: t.pendingUrl || t.url }); });

const mainFrame = new Map();
const CDP = new Set(["Page.frameRequestedNavigation", "Page.frameStartedNavigating", "Page.frameScheduledNavigation", "Page.windowOpen", "Page.frameNavigated"]);
chrome.debugger.onEvent.addListener((src, method, p) => {
  if (!CDP.has(method)) return;
  const f = p.frame;
  push({ ev: "cdp", tabId: src.tabId, method, url: p.url ?? f?.url, reason: p.reason, disposition: p.disposition, navigationType: p.navigationType,
    frameId: p.frameId ?? f?.id, main: (p.frameId ?? f?.id) === mainFrame.get(src.tabId), userGesture: p.userGesture, windowName: p.windowName });
});

globalThis.extId = () => chrome.runtime.id;
globalThis.setRules = async (rules) => {
  const old = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.map((r) => r.id), addRules: rules });
  return (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id);
};
globalThis.clearCookies = async () => {
  let n = 0;
  for (const c of await chrome.cookies.getAll({})) {
    const url = `${c.secure ? "https" : "http"}://${c.domain.replace(/^\./, "")}${c.path}`;
    if (await chrome.cookies.remove({ url, name: c.name, storeId: c.storeId })) n++;
  }
  return n;
};
globalThis.cookies = async () => (await chrome.cookies.getAll({})).map((c) => ({ domain: c.domain, name: c.name, sameSite: c.sameSite, secure: c.secure }));
globalThis.attach = async (tabId) => {
  await chrome.debugger.attach({ tabId }, "1.3");
  await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  const { frameTree } = await chrome.debugger.sendCommand({ tabId }, "Page.getFrameTree");
  mainFrame.set(tabId, frameTree.frame.id);
  return true;
};
globalThis.detach = (tabId) => chrome.debugger.detach({ tabId }).then(() => true, () => false);
globalThis.cmd = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);
globalThis.newTab = async (url) => (await chrome.tabs.create({ url, active: true })).id;
globalThis.newWindow = async (url) => { const w = await chrome.windows.create({ url, focused: true }); return { windowId: w.id, tabId: w.tabs[0].id }; };
globalThis.updateTab = async (tabId, url) => (await chrome.tabs.update(tabId, { url })).id;
globalThis.closeTab = (tabId) => chrome.tabs.remove(tabId).then(() => true, () => false);
globalThis.tabsNow = async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url, pendingUrl: t.pendingUrl, windowId: t.windowId, openerTabId: t.openerTabId }));
/** A trusted click at an element's centre, as the relay's client sends it (CDP Input on the tab). */
globalThis.click = async (tabId, selector) => {
  const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression: `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`,
    returnByValue: true,
  });
  const at = r.result.value;
  if (!at) throw new Error(`no element ${selector}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type, x: at[0], y: at[1], button: type === "mouseMoved" ? "none" : "left", clickCount: 1 });
  }
  return at;
};
globalThis.typeText = async (tabId, text) => {
  for (const ch of text) {
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch });
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyUp", key: ch });
  }
  return true;
};
globalThis.thirdPartyCookies = () => chrome.privacy.websites.thirdPartyCookiesAllowed.get({});
globalThis.setThirdPartyCookies = (value) => chrome.privacy.websites.thirdPartyCookiesAllowed.set({ value }).then(() => chrome.privacy.websites.thirdPartyCookiesAllowed.get({}));
globalThis.cookieSetting = (details) => chrome.contentSettings.cookies.set(details).then(() => true);
globalThis.cookieSettingClear = () => chrome.contentSettings.cookies.clear({}).then(() => true);
globalThis.frameResult = async (tabId) => (await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "document.getElementById('status').textContent", returnByValue: true })).result.value;
