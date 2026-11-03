// Probe only: several CDP clients at the same time. Two Playwright
// connections in one scope, one in another scope, and a raw CDP client.
// Checks: a tab belongs to one connection; a scope sees only its own tabs;
// a tab that its owner left carries no domain state into the next owner;
// Browser.close ends only the connection that sends it.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(path.join(process.env.PW_DIR, "package.json"));
const { chromium } = require("playwright-core");
const WebSocket = require("ws");

const SOCK = process.env.RELAY_SOCK;
const OUT = process.env.OUT;
const A = "http://a.localhost:8781";
const url = (scope) => `ws+unix://${SOCK}:/devtools/browser/${scope}`;
const results = [];
async function step(name, fn, want) {
  const t0 = Date.now();
  try {
    let timer;
    const limit = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("probe timeout: no answer in 20 s")), 20000)));
    const detail = await Promise.race([fn(), limit]).finally(() => clearTimeout(timer));
    results.push({ case: name, ok: want(detail), ms: Date.now() - t0, detail });
  } catch (e) {
    results.push({ case: name, ok: false, ms: Date.now() - t0, error: String(e.message || e).split("\n")[0].slice(0, 240) });
  }
}
async function tryError(fn) {
  try {
    await fn();
    return "no error";
  } catch (e) {
    return String(e.message || e).split("\n")[0];
  }
}

const a = await chromium.connectOverCDP(url("s1"));
const ctxA = a.contexts()[0];
const pageA = await ctxA.newPage();
await pageA.goto(A + "/");
const idA = (await (await ctxA.newCDPSession(pageA)).send("Target.getTargetInfo")).targetInfo.targetId;

const b = await chromium.connectOverCDP(url("s1"));
const ctxB = b.contexts()[0];
await step("a second connection of the scope gets no page for a tab that the first holds", async () => ctxB.pages().length, (d) => d === 0);
await step("it sees the held tab in Target.getTargets, marked attached", async () => {
  const s = await b.newBrowserCDPSession();
  const { targetInfos } = await s.send("Target.getTargets");
  const t = targetInfos.find((x) => x.targetId === idA);
  return t ? { attached: t.attached } : null;
}, (d) => d && d.attached === true);
await step("it cannot attach to the held tab", async () => {
  const s = await b.newBrowserCDPSession();
  return tryError(() => s.send("Target.attachToTarget", { targetId: idA, flatten: true }));
}, (d) => /in use by another connection/.test(d));
const pageB = await ctxB.newPage();
await pageB.goto(A + "/m");
await step("both connections work at the same time (10 evaluates each, interleaved)", async () => {
  const r = await Promise.all(Array.from({ length: 10 }, (_, i) => Promise.all([pageA.evaluate((x) => x + 1, i), pageB.evaluate((x) => x + 2, i)])));
  return r.every(([x, y], i) => x === i + 1 && y === i + 2);
}, (d) => d === true);
await step("a popup belongs to the connection that holds its opener", async () => {
  const [pop] = await Promise.all([pageA.waitForEvent("popup", { timeout: 10000 }), pageA.locator("#winopen").click()]);
  await pop.waitForLoadState("load");
  const r = { inA: ctxA.pages().includes(pop), pagesInB: ctxB.pages().length };
  await pop.close();
  return r;
}, (d) => d.inA === true && d.pagesInB === 1);
await step("a dialog in A's tab goes to A only", async () => {
  pageA.once("dialog", (d) => d.accept());
  await pageA.locator("#alert").click();
  return pageA.locator("#alertout").textContent();
}, (d) => d === "true");
// B intercepts /api/data in its own tab, then leaves with the route still on.
await pageB.goto(A + "/");
await pageB.route("**/api/data", (r) => r.fulfill({ body: "from B", contentType: "text/plain" }));
await step("B's interception is on before B leaves (the control)", async () => {
  await pageB.locator("#fetch").click();
  await pageB.waitForFunction(() => document.getElementById("fetchout").textContent !== "", null, { timeout: 5000 });
  const t = await pageB.locator("#fetchout").textContent();
  await pageB.evaluate(() => (document.getElementById("fetchout").textContent = ""));
  return t;
}, (d) => d === "from B");
await b.close();
await new Promise((r) => setTimeout(r, 500));
const c = await chromium.connectOverCDP(url("s1"));
const ctxC = c.contexts()[0];
await step("the next connection of the scope takes the tab that B left", async () => ctxC.pages().map((p) => p.url()), (d) => d.length === 1 && d[0] === A + "/");
await step("B's interception did not stay behind in that tab", async () => {
  const p = ctxC.pages()[0];
  await p.locator("#fetch").click();
  await p.waitForFunction(() => document.getElementById("fetchout").textContent !== "", null, { timeout: 5000 });
  return p.locator("#fetchout").textContent();
}, (d) => d === "real");

const d = await chromium.connectOverCDP(url("s2"));
await step("another scope gets no page of scope s1", async () => d.contexts()[0].pages().length, (x) => x === 0);
await step("another scope does not see s1's tab in Target.getTargets", async () => {
  const s = await d.newBrowserCDPSession();
  const { targetInfos } = await s.send("Target.getTargets");
  return targetInfos.some((x) => x.targetId === idA);
}, (x) => x === false);
await step("another scope cannot attach to s1's tab", async () => {
  const s = await d.newBrowserCDPSession();
  return tryError(() => s.send("Target.attachToTarget", { targetId: idA, flatten: true }));
}, (x) => /No target with given id found/.test(x));
await step("context.storageState() in a context that showed no off-list frame", async () => {
  const p = await d.contexts()[0].newPage();
  await p.goto(A + "/m");
  await p.evaluate(() => localStorage.setItem("k", "v"));
  const st = await d.contexts()[0].storageState();
  await p.close();
  return { origins: st.origins.map((o) => o.origin), local: st.origins.flatMap((o) => o.localStorage.map((x) => x.name)) };
}, (x) => x.origins.includes(A) && x.local.includes("k"));
await d.close();

await step("a raw client's Browser.close ends only its own connection", async () => {
  const ws = new WebSocket(url("s3"));
  await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  const closed = new Promise((r) => ws.once("close", (code, reason) => r({ code, reason: reason.toString() })));
  ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
  const r = await closed;
  const still = await pageA.evaluate(() => document.title);
  return { ...r, otherPageTitle: still };
}, (x) => x.code === 1000 && x.otherPageTitle === "probe a");

await c.close();
await a.close();
fs.writeFileSync(OUT, JSON.stringify({ results }, null, 2) + "\n");
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.case} (${r.ms} ms): ${r.error !== undefined ? r.error : JSON.stringify(r.detail)}`);
