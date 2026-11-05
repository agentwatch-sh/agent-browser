// One input lock per site (board task ab-v16.46; the operator's choice on ab-hbt, 2026-11-05: "One lock per site.
// Agents on one site wait; agents on different sites work at full speed."). The site key (input.ts, siteKey: it never
// splits one site into two keys), the lock files, reentrancy per key, a page that goes to another site during a command
// or during the wait, and review-52's notes 3 (Tab.waitFor polls during its wait for the lock) and 4 (withFileLock takes
// a crashed holder's lock in its last try); also the pointer file under two commands at once. Against the fake Chrome.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBrowser } from "../src/browser.ts";
import { commands } from "../src/commands.ts";
import { inputLockPath, NO_SITE, POINTER_FILE, siteKey } from "../src/input.ts";
import { withFileLock } from "../src/lock.ts";
import { resolveOptions, type BrowserOptions, type InputTiming } from "../src/options.ts";
import { stopProxy } from "../src/proxy.ts";
import { FakeChrome, type FakePage } from "./fake-chrome.ts";
import { consumer, ROOT, type Consumer } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- the site key (no Chrome) ----------

test("the site key: every host of one site gets one key (a registrable domain has two labels or more), with no public-suffix list", () => {
  // Registrable domains (the public-suffix list's domain and one label more) and hosts of each: one key for each.
  const sites: Record<string, string[]> = {
    "example.com": ["example.com", "www.example.com", "app.example.com", "a.b.c.example.com", "WWW.Example.COM", "example.com."],
    "example.co.uk": ["example.co.uk", "www.example.co.uk", "shop.example.co.uk"],
    "user.github.io": ["user.github.io", "docs.user.github.io"],
    "tenant.auth0.com": ["tenant.auth0.com", "login.tenant.auth0.com"],
    "a.localhost": ["a.localhost", "x.a.localhost"],
  };
  for (const [site, hosts] of Object.entries(sites)) {
    const keys = new Set(hosts.flatMap((h) => [`https://${h}/`, `http://${h}:8080/x?y#z`]).map((u) => siteKey(u)));
    assert.equal(keys.size, 1, `${site}: ${[...keys].join(", ")}`);
  }
  assert.equal(siteKey("https://www.example.com/a"), "example.com");
  assert.notEqual(siteKey("https://example.com/"), siteKey("https://example.org/"));
  assert.notEqual(siteKey("http://www.alpha.test/"), siteKey("http://beta.test/"));
  // The cost of no public-suffix list: sites under a public suffix of two labels share one key (they wait for each other, as
  // every site did before this change).
  assert.equal(siteKey("https://example.co.uk/"), siteKey("https://other.co.uk/"));
  assert.equal(siteKey("https://a.github.io/"), siteKey("https://b.github.io/"));
  // An IP address is its own site; one label (localhost, an intranet host) is its own key.
  assert.equal(siteKey("http://127.0.0.1:9/"), "127.0.0.1");
  assert.notEqual(siteKey("http://10.0.0.1/"), siteKey("http://10.0.1.1/"));
  assert.equal(siteKey("http://[::1]:8000/"), "[::1]");
  assert.equal(siteKey("http://localhost:3000/"), "localhost");
  assert.notEqual(siteKey("http://localhost/"), siteKey("http://a.localhost/"));
  // No host: one shared key.
  for (const u of ["about:blank", "data:text/html,x", "chrome-error://chromewebdata/", "", "not a url"]) assert.equal(siteKey(u), NO_SITE, u);
  // A page with no host of its own that a site made (window.open() gives about:blank the opener's origin; a blob: URL):
  // the site of its security origin, never the shared key.
  assert.equal(siteKey("about:blank", "https://www.example.com"), "example.com");
  assert.equal(siteKey("blob:https://app.example.com/0b1c", "https://app.example.com"), "example.com");
  for (const o of ["://", "null", "", undefined]) assert.equal(siteKey("about:blank", o), NO_SITE, String(o));
  // The URL's host comes first (a sandboxed page has an opaque origin, and stays its URL's site).
  assert.equal(siteKey("https://www.example.com/", "null"), "example.com");
});

test("the lock file of each site is in the state folder, with a name that is a plain file name", () => {
  const c = consumer();
  try {
    const s = resolveOptions(c.options());
    assert.equal(inputLockPath(s, "example.com"), join(c.stateDir, "input-example.com.lock"));
    assert.equal(inputLockPath(s, NO_SITE), join(c.stateDir, "input-_.lock"));
    const v6 = inputLockPath(s, "[::1]");
    assert.equal(join(v6, ".."), c.stateDir);
    assert.match(v6.slice(c.stateDir.length + 1), /^input-[a-z0-9._-]+\.lock$/);
    assert.notEqual(inputLockPath(s, "a.test"), inputLockPath(s, "b.test"));
  } finally { c.remove(); }
});

// ---------- withFileLock (review-52 note 4) ----------

test("withFileLock: a crashed holder's lock is cleared and taken in the same try, also in the one try after the deadline (review-52 note 4)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-lock-"));
  try {
    const path = join(dir, "x.lock");
    const gone = spawnSync("true").pid!; // a pid that has ended
    writeFileSync(path, String(gone));
    assert.equal(await withFileLock(path, Date.now() - 1, async () => "ran", "the test lock"), "ran");
    assert.equal(existsSync(path), false, "released");
    // A lock with no pid for more than 5 s (a holder that crashed before it wrote its pid): cleared and taken too.
    writeFileSync(path, "");
    const old = new Date(Date.now() - 10_000);
    utimesSync(path, old, old);
    assert.equal(await withFileLock(path, Date.now() - 1, async () => "ran again", "the test lock"), "ran again");
    // A live holder's lock is never cleared: the try after the deadline refuses, and the lock stays.
    writeFileSync(path, String(process.pid));
    await assert.rejects(withFileLock(path, Date.now() - 1, async () => "no", "the test lock"), /the test lock timed out/);
    assert.equal(readFileSync(path, "utf8"), String(process.pid));
    // A wait can be cancelled (Tab.waitFor ends its toFront's wait when its condition holds).
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    const t0 = Date.now();
    await assert.rejects(withFileLock(path, Date.now() + 5_000, async () => "no", "the test lock", stop.signal));
    assert.ok(Date.now() - t0 < 1_000, `${Date.now() - t0} ms`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- the lock of each site, against the fake Chrome ----------

/** Short input times, so that the suite stays fast (as person-input.test.ts). */
const FAST: Partial<InputTiming> = { pressMs: [6, 9], keyMs: [6, 9], holdMs: [1, 2], settleMs: [1, 3], wheelMs: [1, 3], moveScale: 0.05, activateMs: 300 };
const PAGE = {
  title: "site",
  elements: [
    { tag: "button", id: "b", text: "Go", rect: [40, 100, 120, 30], onclick: (p: FakePage) => { p.title = "clicked"; } },
    { tag: "input", id: "i", rect: [40, 160, 200, 24] },
  ],
};
// Two hosts of one site, and another site; all on the allowlist.
const A1 = "http://www.alpha.test/", A2 = "http://app.alpha.test/", B = "http://beta.test/";

let fake: FakeChrome, c: Consumer, operator: FakePage;
before(async () => {
  fake = await FakeChrome.start((url) => (url.hostname.endsWith(".test") ? PAGE as never : undefined));
  fake.backgroundTabs = true;
  fake.tabSwitches = true;
  c = consumer(["alpha.test", "beta.test"]);
  operator = fake.addPage("http://operator.test/");
});
after(async () => {
  stopProxy(resolveOptions(c.options()));
  await fake?.close();
  c?.remove();
});

/** Agent mode on Linux, on a display of the agent browser's own (no xdotool). */
const linux = (extra: Partial<BrowserOptions> = {}) => c.options({ endpoint: fake.ws, platform: "linux", inputTiming: FAST,
  display: { own: true, xdotool: false, chromePid: 4242 }, ...extra });
const lockOf = (key: string) => inputLockPath(resolveOptions(linux()), key);
function operatorInFront() { fake.focusWindow(operator.windowId, "test"); fake.xPointer = undefined; }
let n = 0;
async function windowPage(url: string): Promise<{ name: string; page: FakePage }> {
  const name = `s${++n}`;
  const r = await commands.open(linux(), { url, name });
  return { name, page: fake.pages.get(r.tab.targetId)! };
}
/** The span of a page's activation and input calls, from the first to the last. */
function span(p: FakePage, from = 0): [number, number] {
  const xs = fake.calls.filter((x) => x.t >= from && x.targetId === p.targetId && (x.method === "Input.dispatchMouseEvent" || x.method === "Page.bringToFront"));
  return [xs[0].t, xs.at(-1)!.t];
}
/** Another agent-browser process holds the lock of `key` (a live pid in its lock file) for `ms`. */
function holdLock(key: string, ms: number) {
  const holder = spawn("sleep", [String(ms / 1000)], { stdio: "ignore" });
  writeFileSync(lockOf(key), String(holder.pid), { mode: 0o600 });
  return holder;
}
/** This process holds the lock of `key`: its lock file holds this process's pid (a holder's file can outlive it). */
const ours = (key: string) => { try { return readFileSync(lockOf(key), "utf8") === String(process.pid); } catch { return false; } };
/** Record which sites' locks this process holds when the page's #b gets its click. */
function lockAtClick(page: FakePage, keys: string[]): Record<string, boolean>[] {
  const seen: Record<string, boolean>[] = [];
  page.select("#b")[0].onclick = (p: FakePage) => { p.title = "clicked"; seen.push(Object.fromEntries(keys.map((k) => [k, ours(k)]))); };
  return seen;
}

test("agents on two sites send input at the same time; agents on one site (two hosts of it) still one at a time", async () => {
  operatorInFront();
  const a1 = await windowPage(A1), a2 = await windowPage(A2), b = await windowPage(B);
  const slow = linux({ inputTiming: { ...FAST, pressMs: [150, 160] } });
  let t = Date.now();
  await Promise.all([commands.click(slow, { tab: a1.name, target: "#b" }), commands.click(slow, { tab: a2.name, target: "#b" })]);
  let [x0, x1] = span(a1.page, t), [y0, y1] = span(a2.page, t);
  assert.ok(x1 <= y0 || y1 <= x0, `one site: never at once (www ${x0}-${x1}, app ${y0}-${y1})`);
  operatorInFront();
  t = Date.now();
  await Promise.all([commands.click(slow, { tab: a1.name, target: "#b" }), commands.click(slow, { tab: b.name, target: "#b" })]);
  [x0, x1] = span(a1.page, t); [y0, y1] = span(b.page, t);
  assert.ok(x0 < y1 && y0 < x1, `two sites: at once (alpha ${x0}-${x1}, beta ${y0}-${y1})`);
  for (const p of [a1, a2, b]) assert.equal(p.page.title, "clicked");
  for (const p of [a1, a2, b]) await commands.close(linux(), { tab: p.name });
});

test("each site's lock is its own file in the state folder (input-<site>.lock), held from the activation to the end of the input", async () => {
  operatorInFront();
  const a1 = await windowPage(A1), b = await windowPage(B);
  const seen = lockAtClick(a1.page, ["alpha.test", "beta.test"]);
  await commands.click(linux(), { tab: a1.name, target: "#b" });
  assert.deepEqual(seen, [{ "alpha.test": true, "beta.test": false }]);
  assert.equal(existsSync(lockOf("alpha.test")), false, "released");
  assert.equal(existsSync(join(c.stateDir, "input.lock")), false, "no lock for every site");
  await commands.close(linux(), { tab: a1.name });
  await commands.close(linux(), { tab: b.name });
});

test("another process holds one site's lock: input on another site does not wait for it; input on that site does", async () => {
  operatorInFront();
  const a1 = await windowPage(A1), b = await windowPage(B);
  const holder = holdLock("alpha.test", 1500);
  try {
    let t0 = Date.now();
    await commands.click(linux(), { tab: b.name, target: "#b" });
    assert.ok(Date.now() - t0 < 1000, `beta did not wait: ${Date.now() - t0} ms`);
    t0 = Date.now();
    await commands.click(linux(), { tab: a1.name, target: "#b" });
    assert.ok(Date.now() - t0 >= 1300, `alpha waited: ${Date.now() - t0} ms`);
  } finally { holder.kill(); }
  await commands.close(linux(), { tab: a1.name });
  await commands.close(linux(), { tab: b.name });
});

test("reentrance holds per key: in one call chain, a page of the same site does not wait for its own lock; a page of another site takes that site's lock too", async () => {
  operatorInFront();
  const a1 = await windowPage(A1), a2 = await windowPage(A2), b = await windowPage(B);
  const ab = await AgentBrowser.connect(linux());
  try {
    const [t1, t2, tb] = [await ab.find(a1.name), await ab.find(a2.name), await ab.find(b.name)];
    const seenB = lockAtClick(b.page, ["alpha.test", "beta.test"]);
    // Another agent on the site, outside this chain (started from a timer that was set before the chain took the lock).
    let otherAt = 0;
    const other = sleep(100).then(() => commands.click(linux(), { tab: a2.name, target: "#i" })).then(() => { otherAt = Date.now(); });
    let endAt = 0;
    const t0 = Date.now();
    await t1.withInput(async () => {
      await t2.click("#b");
      await tb.click("#b");
      await sleep(300);
      endAt = Date.now();
    });
    assert.ok(endAt - t0 < 1500, `no wait for itself: ${endAt - t0} ms`);
    assert.deepEqual(seenB, [{ "alpha.test": true, "beta.test": true }], "both sites' locks while the chain sent input to beta");
    await other;
    assert.ok(otherAt >= endAt, "the other agent on alpha waited for the chain");
    assert.equal(a2.page.title, "clicked");
  } finally { await ab.disconnect(); }
  for (const p of [a1, a2, b]) await commands.close(linux(), { tab: p.name });
});

test("a command whose page goes to another site keeps the key it took: no wait for the new site's lock in the same command", async () => {
  operatorInFront();
  const a1 = await windowPage(A1);
  const holder = holdLock("beta.test", 2000);
  const ab = await AgentBrowser.connect(linux());
  try {
    const tab = await ab.find(a1.name);
    const t0 = Date.now();
    let during: Record<string, boolean>[] = [];
    await tab.withInput(async () => {
      fake.navigate(a1.page, B); // the page goes to beta (on the allowlist) while the command holds alpha's lock
      await sleep(50);
      during = lockAtClick(a1.page, ["alpha.test"]);
      await tab.click("#b");
      await tab.toFront();
    });
    assert.ok(Date.now() - t0 < 1500, `no wait for beta's lock: ${Date.now() - t0} ms`);
    assert.deepEqual(during, [{ "alpha.test": true }], "alpha's lock held to the end");
    assert.equal(a1.page.title, "clicked");
  } finally { holder.kill(); await ab.disconnect(); }
  await commands.close(linux(), { tab: a1.name });
});

test("a page that goes to another site while its command waits for the lock takes that site's lock before any input", async () => {
  operatorInFront();
  const a1 = await windowPage(A1);
  const holder = holdLock("alpha.test", 800);
  const done = commands.click(linux(), { tab: a1.name, target: "#b" });
  await sleep(300);
  fake.navigate(a1.page, B);
  const seen = lockAtClick(a1.page, ["alpha.test", "beta.test"]);
  await done;
  holder.kill();
  assert.deepEqual(seen, [{ "alpha.test": false, "beta.test": true }]);
  await commands.close(linux(), { tab: a1.name });
});

test("Tab.waitFor polls during its wait for the lock: a condition that holds ends it at once, one that comes true ends it then (review-52 note 3)", async () => {
  operatorInFront();
  const a1 = await windowPage(A1);
  const popup = fake.openFrom(a1.page, A1); // the page is hidden behind its popup tab
  assert.equal(a1.page.visibilityState, "hidden");
  const ab = await AgentBrowser.connect(linux());
  const holder = holdLock("alpha.test", 4000);
  try {
    const tab = await ab.find(a1.name);
    let t0 = Date.now();
    assert.equal(await tab.waitFor(() => 7, { timeoutMs: 3000 }), 7);
    assert.ok(Date.now() - t0 < 600, `a condition that holds: ${Date.now() - t0} ms`);
    a1.page.title = "before";
    setTimeout(() => { a1.page.title = "later"; }, 500);
    t0 = Date.now();
    assert.equal(await tab.waitFor(() => document.title === "later", { timeoutMs: 3000, intervalMs: 50 }), true);
    assert.ok(Date.now() - t0 < 1200, `one that comes true: ${Date.now() - t0} ms`);
    assert.equal(a1.page.visibilityState, "hidden", "the lock was busy: no tab switch");
  } finally { holder.kill(); await ab.disconnect(); }
  await commands.close(linux(), { tab: popup.targetId.slice(0, 8) });
  await commands.close(linux(), { tab: a1.name });
});

test("two commands at once on two sites keep both pages' pointer places (pointer.json is changed under its own short lock)", async () => {
  operatorInFront();
  const a1 = await windowPage(A1), b = await windowPage(B);
  const slow = linux({ inputTiming: { ...FAST, pressMs: [150, 160] } });
  await Promise.all([commands.click(slow, { tab: a1.name, target: "#b" }), commands.click(slow, { tab: b.name, target: "#b" })]);
  const pages = JSON.parse(readFileSync(join(c.stateDir, POINTER_FILE), "utf8")).pages;
  assert.ok(pages[a1.page.targetId] && pages[b.page.targetId], JSON.stringify(Object.keys(pages)));
  await commands.close(linux(), { tab: a1.name });
  await commands.close(linux(), { tab: b.name });
});

test("an about:blank page that a site opened takes that site's lock (its security origin), not the shared one", async () => {
  operatorInFront();
  const a1 = await windowPage(A1);
  const blank = fake.openFrom(a1.page, "about:blank");
  const ab = await AgentBrowser.connect(linux());
  try {
    assert.equal(await (await ab.find(blank.targetId.slice(0, 8))).siteKey(), "alpha.test");
    assert.equal(await (await ab.find(a1.name)).siteKey(), "alpha.test");
  } finally { await ab.disconnect(); }
  await commands.close(linux(), { tab: blank.targetId.slice(0, 8) });
  await commands.close(linux(), { tab: a1.name });
});

test("two processes on two sites send input at the same time; two processes on one site never do", async () => {
  operatorInFront();
  const a1 = await windowPage(A1), a2 = await windowPage(A2), b = await windowPage(B);
  const script = join(c.dir, "click-child.ts");
  writeFileSync(script, `import { commands } from ${JSON.stringify(join(ROOT, "src/commands.ts"))};
const o = JSON.parse(process.argv[2]);
await commands.click({ ...o, log: () => {} }, { tab: process.argv[3], target: "#b" });
`);
  const o = { ...linux({ inputTiming: { ...FAST, pressMs: [250, 260] } }), log: undefined };
  const run = (tab: string) => new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [script, JSON.stringify(o), tab], { stdio: ["ignore", "ignore", "inherit"] });
    child.on("exit", (code) => resolve(code));
  });
  let t = Date.now();
  assert.deepEqual(await Promise.all([run(a1.name), run(b.name)]), [0, 0]);
  let [x0, x1] = span(a1.page, t), [y0, y1] = span(b.page, t);
  assert.ok(x0 < y1 && y0 < x1, `two sites: at once (alpha ${x0}-${x1}, beta ${y0}-${y1})`);
  operatorInFront();
  t = Date.now();
  assert.deepEqual(await Promise.all([run(a1.name), run(a2.name)]), [0, 0]);
  [x0, x1] = span(a1.page, t); [y0, y1] = span(a2.page, t);
  assert.ok(x1 <= y0 || y1 <= x0, `one site: never at once (www ${x0}-${x1}, app ${y0}-${y1})`);
  for (const p of [a1, a2, b]) await commands.close(linux(), { tab: p.name });
});
