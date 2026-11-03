// Probe only: what chrome.debugger allows an extension to send. Each CDP
// command goes to one attached tab of a.localhost through the bridge's
// fixed matrix call; the row says ok or Chrome's error. Then two checks
// outside a page: a chrome:// tab, and the target types the extension sees.
import fs from "node:fs";

import http from "node:http";

// The probe's control calls go over the relay's 0600 Unix socket only.
const SOCK = process.env.RELAY_SOCK;
const OUT = process.env.OUT || "results/matrix.json";
const UPLOAD = process.env.UPLOAD_FILE;
const DL_DIR = process.env.DL_DIR;

function ctl(method, ...params) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCK, path: "/control", method: "POST" }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        const j = JSON.parse(body);
        if (j.error) reject(new Error(j.error));
        else resolve(j.result);
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify({ method, params }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CASES = [
  { method: "Target.getTargetInfo", keep: { ownTarget: "targetInfo.targetId" }, show: ["targetInfo.type", "targetInfo.browserContextId"] },
  { method: "Browser.getVersion", show: ["product"] },
  { method: "Browser.getWindowForTarget", keep: { windowId: "windowId" } },
  { method: "Browser.getWindowBounds", params: { windowId: "$windowId" } },
  { method: "Browser.setDownloadBehavior", params: { behavior: "allowAndName", downloadPath: DL_DIR, eventsEnabled: true } },
  { method: "Browser.grantPermissions", params: { permissions: ["geolocation"], origin: "http://a.localhost:8781" } },
  { method: "Browser.resetPermissions" },
  { method: "Browser.getHistograms", params: { query: "x" } },
  { method: "Target.getTargets" },
  { method: "Target.setDiscoverTargets", params: { discover: true } },
  { method: "Target.createTarget", params: { url: "about:blank" } },
  { method: "Target.attachToTarget", params: { targetId: "$ownTarget", flatten: true } },
  { method: "Target.attachToBrowserTarget" },
  { method: "Target.createBrowserContext" },
  { method: "Target.getBrowserContexts" },
  { method: "Target.activateTarget", params: { targetId: "$ownTarget" } },
  { method: "Target.setAutoAttach", label: "Target.setAutoAttach (page session)", params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } },
  { method: "Storage.getCookies", show: ["cookies.length", "cookies.0.domain", "cookies.1.domain"] },
  { method: "Storage.setCookies", params: { cookies: [{ name: "m", value: "1", domain: "a.localhost", path: "/" }] } },
  { method: "Storage.getUsageAndQuota", params: { origin: "http://a.localhost:8781" } },
  { method: "Network.enable" },
  { method: "Network.getAllCookies" },
  { method: "Network.getCookies", params: { urls: ["http://a.localhost:8781/"] } },
  { method: "Network.setCookie", params: { name: "n", value: "1", url: "http://a.localhost:8781/" } },
  { method: "Network.setExtraHTTPHeaders", params: { headers: {} } },
  { method: "Network.emulateNetworkConditions", params: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } },
  { method: "Network.setBypassServiceWorker", params: { bypass: false } },
  { method: "Network.setCacheDisabled", params: { cacheDisabled: false } },
  { method: "Page.enable" },
  { method: "Page.getFrameTree", keep: { frameId: "frameTree.frame.id" } },
  { method: "Page.setLifecycleEventsEnabled", params: { enabled: true } },
  { method: "Page.addScriptToEvaluateOnNewDocument", params: { source: "void 0", worldName: "probe-world" } },
  { method: "Page.createIsolatedWorld", params: { frameId: "$frameId", worldName: "probe-world" } },
  { method: "Page.setBypassCSP", params: { enabled: false } },
  { method: "Page.setInterceptFileChooserDialog", params: { enabled: true } },
  { method: "Page.setInterceptFileChooserDialog", label: "Page.setInterceptFileChooserDialog off", params: { enabled: false } },
  { method: "Page.setDownloadBehavior", params: { behavior: "allow", downloadPath: DL_DIR } },
  { method: "Page.getLayoutMetrics" },
  { method: "Page.captureScreenshot", params: { format: "png" } },
  { method: "Page.printToPDF" },
  { method: "Page.startScreencast", params: { format: "jpeg", maxWidth: 200, maxHeight: 200 } },
  { method: "Page.stopScreencast" },
  { method: "Page.getNavigationHistory" },
  { method: "Page.bringToFront" },
  { method: "Runtime.enable" },
  { method: "Runtime.evaluate", params: { expression: "1 + 1" } },
  { method: "Runtime.addBinding", params: { name: "__probeBinding" } },
  { method: "Runtime.runIfWaitingForDebugger" },
  { method: "DOM.enable" },
  { method: "DOM.getDocument", keep: { root: "root.nodeId" } },
  { method: "DOM.querySelector", params: { nodeId: "$root", selector: "#file" }, keep: { fileNode: "nodeId" } },
  { method: "DOM.setFileInputFiles", params: { files: [UPLOAD], nodeId: "$fileNode" } },
  { method: "CSS.enable" },
  { method: "Overlay.enable" },
  { method: "Accessibility.getFullAXTree" },
  { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 5, y: 5 } },
  { method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 } },
  { method: "Input.dispatchKeyEvent", label: "Input.dispatchKeyEvent keyUp", params: { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 } },
  { method: "Input.insertText", params: { text: "" } },
  { method: "Emulation.setDeviceMetricsOverride", params: { width: 800, height: 600, deviceScaleFactor: 1, mobile: false } },
  { method: "Emulation.clearDeviceMetricsOverride" },
  { method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } },
  { method: "Emulation.setFocusEmulationEnabled", label: "Emulation.setFocusEmulationEnabled off", params: { enabled: false } },
  { method: "Emulation.setGeolocationOverride", params: { latitude: 0, longitude: 0, accuracy: 1 } },
  { method: "Emulation.clearGeolocationOverride" },
  { method: "Emulation.setTimezoneOverride", params: { timezoneId: "UTC" } },
  { method: "Emulation.setTimezoneOverride", label: "Emulation.setTimezoneOverride reset", params: { timezoneId: "" } },
  { method: "Emulation.setEmulatedMedia", params: { media: "" } },
  { method: "Fetch.enable", params: { patterns: [{ urlPattern: "*never-matches-probe*" }] } },
  { method: "Fetch.disable" },
  { method: "Security.setIgnoreCertificateErrors", params: { ignore: false } },
  { method: "Log.enable" },
  { method: "Debugger.enable" },
  { method: "Debugger.disable" },
  { method: "Profiler.enable" },
  { method: "HeapProfiler.collectGarbage" },
  { method: "ServiceWorker.enable" },
  { method: "ServiceWorker.disable" },
  { method: "Tracing.start", params: { transferMode: "ReturnAsStream" } },
  { method: "Tracing.end", waitMs: 300 },
  { method: "SystemInfo.getInfo" },
  { method: "Extensions.loadUnpacked", params: { path: "/nonexistent" } },
  { method: "Network.clearBrowserCookies" },
  { method: "Page.navigate", label: "Page.navigate off-list b.localhost", params: { url: "http://b.localhost:8781/" }, waitMs: 500, show: ["errorText"] },
  { method: "Page.getNavigationHistory", label: "history after the off-list navigate", show: ["currentIndex", "entries"] },
  { method: "Page.navigate", label: "Page.navigate (plain), for the headers", params: { url: "http://a.localhost:8781/m?nav=plain" }, waitMs: 400 },
  { method: "Page.navigate", label: "Page.navigate transitionType typed", params: { url: "http://a.localhost:8781/m?nav=typed", transitionType: "typed" }, waitMs: 400 },
  { method: "Page.navigate", label: "Page.navigate transitionType address_bar", params: { url: "http://a.localhost:8781/m?nav=address_bar", transitionType: "address_bar" }, waitMs: 400 },
  { method: "Page.navigate", label: "Page.navigate transitionType auto_bookmark", params: { url: "http://a.localhost:8781/m?nav=auto_bookmark", transitionType: "auto_bookmark" }, waitMs: 400 },
  { method: "Runtime.evaluate", label: "location.href with a user gesture", params: { expression: "location.href = '/m?nav=script_gesture'", userGesture: true }, waitMs: 400 },
  { method: "Page.navigate", label: "Page.navigate file://", params: { url: "file:///etc/hostname" }, waitMs: 500, show: ["errorText"] },
  { method: "Runtime.evaluate", label: "what the file:// tab shows", params: { expression: "location.protocol + ' ' + document.body.innerText.length + ' characters'", returnByValue: true }, show: ["result.value"] },
  { method: "Page.navigate", label: "Page.navigate chrome://version", params: { url: "chrome://version" } },
];

const rows = { started: new Date().toISOString(), info: await ctl("bridge.info") };
// A cookie of another site (the frame host c.localhost), for Storage.getCookies on a tab session.
await ctl("cookies.set", { url: "http://c.localhost:8781/", name: "other_site", value: "1" });
const tab = await ctl("tabs.create", { url: "http://a.localhost:8781/", active: true });
await sleep(2000);
rows.page = await ctl("bridge.matrix", tab.id, CASES);
await sleep(500);
// Where the off-list navigation left the tab, and the targets the extension sees.
// The last case left the tab on chrome://version; bring it back to the site first.
await ctl("tabs.update", tab.id, { url: "http://a.localhost:8781/m?nav=back_to_site" });
await sleep(800);
// Can a DNR rule set Sec-Fetch-Site: none on a Page.navigate?
await ctl("dnr.updateSessionRules", {
  addRules: [{ id: 50, priority: 3, action: { type: "modifyHeaders", requestHeaders: [{ header: "sec-fetch-site", operation: "set", value: "none" }] }, condition: { resourceTypes: ["main_frame"], requestDomains: ["a.localhost"] } }],
});
rows.dnrHeader = await ctl("bridge.matrix", tab.id, [{ method: "Page.navigate", label: "Page.navigate with a DNR rule that sets sec-fetch-site", params: { url: "http://a.localhost:8781/m?nav=plain_with_dnr_rule" }, waitMs: 500 }]);
await ctl("dnr.updateSessionRules", { removeRuleIds: [50] });
// The same rule, limited to navigations that the extension starts (initiatorDomains = its own ID):
// a Page.navigate gets "none", a page script's navigation keeps its own value.
await ctl("dnr.updateSessionRules", {
  addRules: [{ id: 51, priority: 3, action: { type: "modifyHeaders", requestHeaders: [{ header: "sec-fetch-site", operation: "set", value: "none" }] }, condition: { resourceTypes: ["main_frame"], initiatorDomains: [rows.info.id] } }],
});
rows.dnrInitiator = await ctl("bridge.matrix", tab.id, [
  { method: "Page.navigate", label: "Page.navigate, rule limited to the extension's initiator", params: { url: "http://a.localhost:8781/m?nav=initiator_rule_navigate" }, waitMs: 500 },
  { method: "Runtime.evaluate", label: "a page script navigates, same rule", params: { expression: "location.href = '/m?nav=initiator_rule_script'", userGesture: true }, waitMs: 500 },
]);
await ctl("dnr.updateSessionRules", { removeRuleIds: [51] });
// The navigation headers of the chrome.tabs calls, for the comparison with Page.navigate.
await ctl("tabs.update", tab.id, { url: "http://a.localhost:8781/m?nav=tabs_update" });
await sleep(500);
const t2 = await ctl("tabs.create", { url: "http://a.localhost:8781/m?nav=tabs_create", active: false });
await sleep(500);
await ctl("tabs.remove", t2.id).catch(() => {});
const targets = await ctl("debugger.getTargets");
rows.targetTypes = [...new Set(targets.map((t) => t.type))];
// A chrome:// page.
const ch = await ctl("tabs.create", { url: "chrome://version", active: false });
await sleep(800);
try {
  await ctl("debugger.attach", ch.id);
  rows.chromePage = "attached";
} catch (e) {
  rows.chromePage = e.message;
}
await ctl("tabs.remove", ch.id).catch(() => {});
await ctl("debugger.detach", tab.id).catch(() => {});
await ctl("tabs.remove", tab.id).catch(() => {});
fs.writeFileSync(OUT, JSON.stringify(rows, null, 2) + "\n");
const bad = rows.page.filter((r) => !r.ok).map((r) => `${r.label}: ${r.error}`);
console.log(`matrix: ${rows.page.length} commands, ${rows.page.length - bad.length} ok`);
for (const b of bad) console.log("  refused " + b);
console.log("  target types:", rows.targetTypes.join(", "), "| chrome:// tab:", rows.chromePage);
