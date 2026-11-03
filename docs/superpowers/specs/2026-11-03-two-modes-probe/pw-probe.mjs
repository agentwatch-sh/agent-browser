// Probe only: Playwright drives the agent Chrome through the extension, with
// chromium.connectOverCDP and no change to Playwright. One case per feature.
// A case passes only when its value is the expected one (want), or, for a
// refusal the design wants, only when Playwright gets the expected error.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(path.join(process.env.PW_DIR, "package.json"));
const { chromium } = require("playwright-core");

const ENDPOINT = process.env.ENDPOINT;
const OUT = process.env.OUT;
const UPLOAD = process.env.UPLOAD_FILE;
const RUN = process.env.RUN_DIR;
const A = "http://a.localhost:8781";
const B = "http://b.localhost:8781";
const results = [];

async function step(name, fn, opts = {}) {
  const t0 = Date.now();
  let detail;
  let error = null;
  try {
    let timer;
    const limit = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("probe timeout: no answer in 20 s")), 20000)));
    detail = await Promise.race([fn(), limit]).finally(() => clearTimeout(timer));
  } catch (e) {
    error = String(e && e.message ? e.message : e).split("\n")[0].slice(0, 240);
  }
  const ms = Date.now() - t0;
  if (opts.refused) {
    const ok = error !== null && opts.refused.test(error);
    results.push({ case: name, expect: "refused", ok, ms, ...(error !== null ? { error } : { detail }) });
  } else {
    const ok = error === null && (!opts.want || opts.want(detail));
    results.push({ case: name, ok, ms, ...(error === null ? { detail: detail === undefined ? null : detail } : { error }), ...(error === null && !ok ? { why: "value not as expected" } : {}) });
  }
}
// A fresh page for a case, closed after it.
async function onPage(fn) {
  const p = await context.newPage();
  try {
    return await fn(p);
  } finally {
    await p.close().catch(() => {});
  }
}
const BLOCKED = /ERR_BLOCKED_BY_CLIENT/;

const t0 = Date.now();
// Over loopback TCP the endpoint needs the run's token (every local user can reach the port).
const browser = await chromium.connectOverCDP(ENDPOINT, { timeout: 20000, headers: { "x-probe-token": process.env.RELAY_TOKEN || "" } });
results.push({ case: "connectOverCDP", ok: /^156\./.test(browser.version()), ms: Date.now() - t0, detail: { version: browser.version(), contexts: browser.contexts().length } });
const context = browser.contexts()[0];
let page;

await step("context.newPage (Target.createTarget)", async () => {
  page = await context.newPage();
  return { pages: context.pages().length };
}, { want: (d) => d.pages === 1 });
await step("page.goto allowlisted page", async () => {
  const r = await page.goto(A + "/", { waitUntil: "load" });
  return { status: r.status(), title: await page.title() };
}, { want: (d) => d.status === 200 && d.title === "probe a" });
await step("response.body()", async () => {
  const r = await page.goto(A + "/m");
  const body = await r.body();
  await page.goto(A + "/");
  return body.toString().includes("<p id='m'>m</p>");
}, { want: (d) => d === true });
await step("navigator.webdriver (page.evaluate)", async () => page.evaluate(() => navigator.webdriver), { want: (d) => d === false });
await step("locator.fill + click + read text", async () => {
  await page.locator("#name").fill("Ada");
  await page.locator("#go").click();
  return page.locator("#out").textContent();
}, { want: (d) => d === "Hello, Ada" });
await step("keyboard.type + press", async () => {
  await page.locator("#name").fill("");
  await page.locator("#name").click();
  await page.keyboard.type("Grace");
  await page.keyboard.press("Enter");
  return page.locator("#name").inputValue();
}, { want: (d) => d === "Grace" });
await step("mouse press pressure (the relay sets force 0.5)", async () => {
  await page.locator("#report").click();
  return page.evaluate(() => window.__siteSignals().pressure);
}, { want: (d) => d.includes("mouse:0.5") && !d.includes("mouse:0") });
await step("hover", async () => {
  await page.locator("#hov").hover();
  return page.locator("#hov").textContent();
}, { want: (d) => d === "hovered" });
await step("selectOption", async () => {
  await page.locator("#sel").selectOption("y");
  return page.locator("#sel").inputValue();
}, { want: (d) => d === "y" });
await step("ariaSnapshot (the MCP's page read)", async () => (await page.locator("body").ariaSnapshot()).includes('button "Greet"'), { want: (d) => d === true });
await step("screenshot", async () => (await page.screenshot()).length, { want: (d) => d > 10000 });
await step("cross-site frame: click and read (c.localhost)", async () => {
  const f = page.frameLocator("#frame");
  await f.locator("#fbtn").click();
  return f.locator("#fout").textContent();
}, { want: (d) => d === "frame clicked" });
await step("dialog (confirm) accept", async () => {
  page.once("dialog", (d) => d.accept());
  await page.locator("#alert").click();
  return page.locator("#alertout").textContent();
}, { want: (d) => d === "true" });
await step("page.route (network interception, fulfill)", async () => {
  await page.route("**/api/data", (r) => r.fulfill({ body: "mocked", contentType: "text/plain" }));
  await page.locator("#fetch").click();
  await page.waitForFunction(() => document.getElementById("fetchout").textContent !== "");
  const t = await page.locator("#fetchout").textContent();
  await page.unroute("**/api/data");
  return t;
}, { want: (d) => d === "mocked" });
await step("setInputFiles (file path)", async () => {
  await page.locator("#file").setInputFiles(UPLOAD);
  return page.locator("#fileout").textContent();
}, { want: (d) => d === "upload.txt:18" });
await step("setInputFiles (buffer)", async () => {
  await page.locator("#file").setInputFiles({ name: "buf.txt", mimeType: "text/plain", buffer: Buffer.from("buffer upload") });
  return page.locator("#fileout").textContent();
}, { want: (d) => d === "buf.txt:13" });
await step("download", async () => {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), page.locator("#dl").click()]);
  const p = await dl.path();
  return { name: dl.suggestedFilename(), body: fs.readFileSync(p, "utf8").trim() };
}, { want: (d) => d.name === "probe.txt" && d.body === "probe download body" });
await step("popup (window.open)", async () => {
  const [pop] = await Promise.all([page.waitForEvent("popup", { timeout: 10000 }), page.locator("#winopen").click()]);
  await pop.waitForLoadState("load");
  const r = { url: pop.url(), text: await pop.locator("#p").textContent() };
  await pop.close();
  return r;
}, { want: (d) => d.text === "Popup open" });
await step("popup (target=_blank link)", async () => {
  const [pop] = await Promise.all([page.waitForEvent("popup", { timeout: 10000 }), page.locator("#blank").click()]);
  await pop.waitForLoadState("load");
  const r = { url: pop.url() };
  await pop.close();
  return r;
}, { want: (d) => d.url === A + "/popup?via=blank" });
await step("a dedicated worker (page.on worker)", () => onPage(async (p) => {
  const [w] = await Promise.all([p.waitForEvent("worker", { timeout: 10000 }), p.goto(A + "/worker")]);
  return w.evaluate(() => 6 * 7);
}), { want: (d) => d === 42 });
await step("context.addInitScript, then a new page", async () => {
  await context.addInitScript(() => {
    window.__probeInit = 1;
  });
  const p2 = await context.newPage();
  await p2.goto(A + "/m");
  const r = await p2.evaluate(() => typeof window.__probeInit);
  await p2.close();
  return r;
}, { want: (d) => d === "number" });
await step("init script in a popup (late attach)", async () => {
  const [pop] = await Promise.all([page.waitForEvent("popup", { timeout: 10000 }), page.locator("#winopen").click()]);
  await pop.waitForLoadState("load");
  const r = await pop.evaluate(() => typeof window.__probeInit);
  await pop.close();
  return r;
}, { want: (d) => d === "number" });
await step("page.exposeFunction", async () => {
  await page.exposeFunction("__probeExposed", (x) => x * 2);
  await page.reload();
  return page.evaluate(() => window.__probeExposed(21));
}, { want: (d) => d === 42 });
await step("context.cookies + addCookies (allowlisted)", async () => {
  await context.addCookies([{ name: "pw", value: "1", domain: "a.localhost", path: "/" }]);
  const c = await context.cookies(A);
  return c.map((x) => x.name).sort();
}, { want: (d) => d.includes("pw") });
await step("context.addCookies (off-list domain)", async () => {
  await context.addCookies([{ name: "pw", value: "1", domain: "b.localhost", path: "/" }]);
  return "accepted";
}, { refused: /not on the allowlist/ });
// Playwright's storageState() opens a page for each origin that a frame of the
// context showed; DNR blocks the off-list frame origin c.localhost.
await step("context.storageState() after a page with an off-list frame", async () => {
  const st = await context.storageState();
  return { cookies: st.cookies.length, origins: st.origins.map((o) => o.origin) };
}, { refused: BLOCKED });
await step("setViewportSize (Emulation)", async () => {
  await page.setViewportSize({ width: 900, height: 700 });
  return page.evaluate(() => [innerWidth, innerHeight]);
}, { want: (d) => d[0] === 900 && d[1] === 700 });
await step("page.goto off-list host (DNR)", () => onPage(async (p) => {
  await p.goto(B + "/");
  return "loaded: " + p.url();
}), { refused: BLOCKED });
await step("after a blocked goto, the same page goes on", () => onPage(async (p) => {
  await p.goto(B + "/").catch(() => {});
  // Chrome commits its error page just after the failed navigation; wait for it.
  await p.waitForURL(/^chrome-error:/, { timeout: 3000 }).catch(() => {});
  await p.goto(A + "/m");
  return { url: p.url(), title: await p.title() };
}), { want: (d) => d.title === "probe m" });
await step("an off-list link click stays blocked (DNR)", () => onPage(async (p) => {
  await p.goto(A + "/");
  await p.locator("#off").click();
  await p.waitForTimeout(1000);
  return { url: p.url(), title: await p.title() };
}), { want: (d) => d.url.startsWith("chrome-error:") && d.title !== "probe b" });
await step("an off-list popup is blocked (DNR)", () => onPage(async (p) => {
  await p.goto(A + "/");
  const [pop] = await Promise.all([p.waitForEvent("popup", { timeout: 10000 }), p.locator("#winopenoff").click()]);
  await pop.waitForTimeout(800);
  const r = { url: pop.url(), title: await pop.title().catch((e) => e.message.split("\n")[0]) };
  await pop.close().catch(() => {});
  return r;
}), { want: (d) => d.url.startsWith("chrome-error:") && d.title !== "probe b" });
await step("page.route fulfill of an off-list document (does Fetch come before DNR?)", () => onPage(async (p) => {
  await p.route(B + "/**", (r) => r.fulfill({ body: "<title>fulfilled</title><p>made up</p>", contentType: "text/html" }));
  await p.goto(B + "/x");
  return { url: p.url(), title: await p.title() };
}), { refused: BLOCKED });
await step("an off-list frame in a page that is not on the list (setContent)", () => onPage(async (p) => {
  await p.setContent(`<iframe id="f" src="http://c.localhost:8781/frame"></iframe>`);
  await p.waitForTimeout(1000);
  const f = p.frames().find((x) => x.url().includes("c.localhost"));
  return { frameLoaded: Boolean(f && (await f.locator("#fbtn").count().catch(() => 0))) };
}), { want: (d) => d.frameLoaded === false });
// Chrome leaves the tab on about:blank (also without the frame rule: the control run).
await step("Page.navigate to a data: URL with an off-list frame", () => onPage(async (p) => {
  await p.goto(`data:text/html,<iframe src="http://c.localhost:8781/frame"></iframe>`).catch(() => {});
  await p.waitForTimeout(1000);
  const f = p.frames().find((x) => x.url().includes("c.localhost"));
  return { url: p.url().slice(0, 20), frameLoaded: Boolean(f && (await f.locator("#fbtn").count().catch(() => 0))) };
}), { want: (d) => d.url === "about:blank" && d.frameLoaded === false });
await step("context.grantPermissions geolocation, one origin (chrome.contentSettings)", async () => {
  await context.grantPermissions(["geolocation"], { origin: A });
  return onPage(async (p) => {
    await p.goto(A + "/geo");
    return p.evaluate(async () => (await navigator.permissions.query({ name: "geolocation" })).state);
  });
}, { want: (d) => d === "granted" });
await step("context.grantPermissions clipboard-read, no origin (the allowlisted domains)", async () => {
  await context.grantPermissions(["clipboard-read"]);
  return onPage(async (p) => {
    await p.goto(A + "/geo");
    return p.evaluate(async () => (await navigator.permissions.query({ name: "clipboard-read" })).state);
  });
}, { want: (d) => d === "granted" });
await step("context.grantPermissions midi", async () => {
  await context.grantPermissions(["midi"], { origin: A });
  return "granted";
}, { refused: /Not available/ });
await step("context.clearPermissions", async () => {
  await context.clearPermissions();
  return onPage(async (p) => {
    await p.goto(A + "/geo");
    return p.evaluate(async () => (await navigator.permissions.query({ name: "geolocation" })).state);
  });
}, { want: (d) => d === "prompt" });
await step("CDPSession on a page (newCDPSession)", async () => {
  const s = await context.newCDPSession(page);
  const r = await s.send("Runtime.evaluate", { expression: "6*7", returnByValue: true });
  await s.detach();
  return r.result.value;
}, { want: (d) => d === 42 });
await step("context.tracing start/stop", async () => {
  await context.tracing.start({ screenshots: true, snapshots: true });
  await page.goto(A + "/m");
  // The trace goes to the run's scratch folder, never into the repo.
  const p = path.join(RUN, "trace-" + path.basename(OUT, ".json") + ".zip");
  await context.tracing.stop({ path: p });
  return fs.statSync(p).size;
}, { want: (d) => d > 1000 });
await step("page.pdf", async () => (await page.pdf()).length, { want: (d) => d > 1000 });
await step("browser.newContext (an isolated context)", async () => {
  const c = await browser.newContext();
  await c.close();
  return "created";
}, { refused: /Not available in the agent browser/ });
await step("browser.newBrowserCDPSession", async () => {
  const s = await browser.newBrowserCDPSession();
  const v = await s.send("Browser.getVersion");
  return v.product;
}, { want: (d) => /^Chrome\/156\./.test(d) });
await step("context.serviceWorkers()", async () => context.serviceWorkers().length, { want: (d) => d === 0 });
await step("site report (trusted click on #report)", async () => {
  await page.goto(A + "/");
  await page.locator("#report").click();
  return "sent";
});
await step("round trip: 20 x page.evaluate", async () => {
  const s = Date.now();
  for (let i = 0; i < 20; i++) await page.evaluate(() => 1);
  return Math.round((Date.now() - s) / 20);
}, { want: (d) => d < 50 });
await step("page.close", async () => {
  await page.close();
  return { pages: context.pages().length };
}, { want: (d) => d.pages === 0 });
await step("browser.close (closes Playwright's connection)", async () => {
  await browser.close();
  return "closed";
});

fs.writeFileSync(OUT, JSON.stringify({ endpoint: ENDPOINT.replace(/\/devtools.*/, "/devtools/browser/<scope>"), results }, null, 2) + "\n");
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.case}${r.expect ? " [refusal expected]" : ""} (${r.ms} ms): ${r.error !== undefined ? r.error : JSON.stringify(r.detail)}`);
