// The input lock stays one per agent browser (board task ab-v16.46; the operator's choice on ab-1bi, 2026-11-05: "Go
// back to one lock per browser", after one lock per site, ab-hbt, showed each page alone a blur and a focus during its
// own typing): agents on two sites share the one input.lock with agents on one site, and wait for each other.
// Also review-52's notes 3 (Tab.waitFor polls during its wait for the lock) and 4 (withFileLock takes a crashed
// holder's lock in its last try). Against the fake Chrome.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBrowser } from "../src/browser.ts";
import { commands } from "../src/commands.ts";
import { INPUT_LOCK, POINTER_FILE } from "../src/input.ts";
import { withFileLock } from "../src/lock.ts";
import { type BrowserOptions, type InputTiming } from "../src/options.ts";
import { resolveOptions } from "../src/options.ts";
import { stopProxy } from "../src/proxy.ts";
import { FakeChrome, type FakePage } from "./fake-chrome.ts";
import { consumer, ROOT, type Consumer } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- withFileLock (review-52 note 4) ----------

test("withFileLock: a crashed holder's lock is cleared and then taken, also in the one try after the deadline (review-52 note 4)", async () => {
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
    await assert.rejects(withFileLock(path, Date.now() + 5_000, async () => "no", "the test lock", { signal: stop.signal }));
    assert.ok(Date.now() - t0 < 1_000, `${Date.now() - t0} ms`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("withFileLock: a second waiter that read the same dead pid and removes the lock after the first one cleared it never removes the first one's live lock (review-55)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-lock-"));
  try {
    const path = join(dir, "x.lock");
    writeFileSync(path, String(spawnSync("true").pid!)); // a crashed holder
    // The first waiter: it clears the crashed holder's lock and takes the lock; inside, its own lock file must stay.
    let intact: boolean | undefined;
    const first = withFileLock(path, Date.now() + 2_000, async () => {
      await sleep(150);
      intact = existsSync(path) && readFileSync(path, "utf8") === String(process.pid);
    }, "the test lock");
    // The second waiter read the same dead pid before the first one cleared it; its removal comes now (lock.ts,
    // clearCrashed: the known gap needs that read and this removal on both sides of the first one's take).
    rmSync(path, { force: true });
    await first;
    assert.equal(intact, true, "the first waiter held its own lock file for all of its run");
    assert.equal(existsSync(path), false, "released");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- one lock for the pages of every site, against the fake Chrome ----------

/** Short input times, so that the suite stays fast (as person-input.test.ts). */
const FAST: Partial<InputTiming> = { pressMs: [6, 9], keyMs: [6, 9], holdMs: [1, 2], settleMs: [1, 3], wheelMs: [1, 3], moveScale: 0.05, activateMs: 300 };
const PAGE = {
  title: "site",
  elements: [
    { tag: "button", id: "b", text: "Go", rect: [40, 100, 120, 30], onclick: (p: FakePage) => { p.title = "clicked"; } },
    { tag: "input", id: "i", rect: [40, 160, 200, 24] },
  ],
};
/** Beta's page: its button at the right, so that a test can tell which page an X pointer move was for. */
const PAGE_B = { ...PAGE, elements: [{ ...PAGE.elements[0], rect: [600, 500, 120, 30] }, PAGE.elements[1]] };
// Two hosts of one site, and another site; all on the allowlist.
const A1 = "http://www.alpha.test/", A2 = "http://app.alpha.test/", B = "http://beta.test/";

let fake: FakeChrome, c: Consumer, operator: FakePage;
before(async () => {
  fake = await FakeChrome.start((url) => (url.hostname === "beta.test" ? PAGE_B as never : url.hostname.endsWith(".test") ? PAGE as never : undefined));
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
/** The X pointer through a fake xdotool (as person-input.test.ts): each move, and the window that was active then. */
const xMoves: { x: number; y: number; active: number }[] = [];
const xdotool = async (args: string[]): Promise<string> => {
  const at = fake.xPointer ?? { x: 900, y: 700 };
  if (args[0] === "getmouselocation") return `X=${Math.round(at.x)}\nY=${Math.round(at.y + 87)}\nSCREEN=0\nWINDOW=200\n`;
  if (args[0] === "mousemove") { const x = Number(args[1]), y = Number(args[2]); xMoves.push({ x, y, active: fake.focusedWindow }); fake.xPointer = { x, y: y - 87 }; return ""; }
  if (args[0] === "search" && args.includes("--maxdepth")) return "1\n";
  if (args[0] === "search") return "1\n200\n201\n";
  if (args[0] === "getwindowfocus") return "200\n";
  if (args[0] === "getwindowpid") return args[1] === "1" ? "" : "4242\n";
  throw new Error(`fake xdotool: ${args.join(" ")}`);
};
const linuxX = (extra: Partial<BrowserOptions> = {}) => linux({ display: { own: true, xdotool, chromePid: 4242 }, ...extra });
const LOCK = () => join(c.stateDir, INPUT_LOCK);
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
const apart = ([a0, a1]: [number, number], [b0, b1]: [number, number]) => a1 <= b0 || b1 <= a0;
/** Another agent-browser process holds the input lock (a live pid in input.lock) for `ms`. */
function holdLock(ms: number) {
  const holder = spawn("sleep", [String(ms / 1000)], { stdio: "ignore" });
  writeFileSync(LOCK(), String(holder.pid), { mode: 0o600 });
  return holder;
}
/** This process holds the input lock: input.lock holds this process's pid (a holder's file can outlive it). */
const ours = () => { try { return readFileSync(LOCK(), "utf8") === String(process.pid); } catch { return false; } };
/** Record whether this process holds the input lock when the page's #b gets its click. */
function lockAtClick(page: FakePage): boolean[] {
  const seen: boolean[] = [];
  page.select("#b")[0].onclick = (p: FakePage) => { p.title = "clicked"; seen.push(ours()); };
  return seen;
}

test("agents on two sites share the one input lock: their input never overlaps, as on one site (ab-1bi)", async () => {
  operatorInFront();
  const a1 = await windowPage(A1), a2 = await windowPage(A2), b = await windowPage(B);
  const slow = linux({ inputTiming: { ...FAST, pressMs: [150, 160] } });
  let t = Date.now();
  await Promise.all([commands.click(slow, { tab: a1.name, target: "#b" }), commands.click(slow, { tab: a2.name, target: "#b" })]);
  assert.ok(apart(span(a1.page, t), span(a2.page, t)), `one site: never at once (www ${span(a1.page, t)}, app ${span(a2.page, t)})`);
  operatorInFront();
  t = Date.now();
  await Promise.all([commands.click(slow, { tab: a1.name, target: "#b" }), commands.click(slow, { tab: b.name, target: "#b" })]);
  assert.ok(apart(span(a1.page, t), span(b.page, t)), `two sites: never at once (alpha ${span(a1.page, t)}, beta ${span(b.page, t)})`);
  for (const p of [a1, a2, b]) assert.equal(p.page.title, "clicked");
  // Both pages' pointer places are kept (pointer.json is written inside the one lock).
  const pages = JSON.parse(readFileSync(join(c.stateDir, POINTER_FILE), "utf8")).pages;
  assert.ok(pages[a1.page.targetId] && pages[b.page.targetId], JSON.stringify(Object.keys(pages)));
  for (const p of [a1, a2, b]) await commands.close(linux(), { tab: p.name });
});

test("the lock is the state folder's one input.lock for the pages of every site, held from the activation to the end of the input", async () => {
  operatorInFront();
  const a1 = await windowPage(A1), b = await windowPage(B);
  const seenA = lockAtClick(a1.page), seenB = lockAtClick(b.page);
  await commands.click(linux(), { tab: a1.name, target: "#b" });
  await commands.click(linux(), { tab: b.name, target: "#b" });
  assert.deepEqual([seenA, seenB], [[true], [true]]);
  assert.equal(existsSync(LOCK()), false, "released");
  for (const f of ["input-alpha.test.lock", "input-beta.test.lock"]) assert.equal(existsSync(join(c.stateDir, f)), false, `no lock of a site: ${f}`);
  await commands.close(linux(), { tab: a1.name });
  await commands.close(linux(), { tab: b.name });
});

test("another process's input on one site holds the lock: input on another site waits for it", async () => {
  operatorInFront();
  const b = await windowPage(B);
  const holder = holdLock(1200);
  try {
    const t0 = Date.now();
    await commands.click(linux(), { tab: b.name, target: "#b" });
    assert.ok(Date.now() - t0 >= 1000, `beta waited: ${Date.now() - t0} ms`);
  } finally { holder.kill(); }
  await commands.close(linux(), { tab: b.name });
});

test("reentrance in one call chain: pages of another site in the chain do not wait for the chain's own lock; another chain waits for it", async () => {
  operatorInFront();
  const a1 = await windowPage(A1), a2 = await windowPage(A2), b = await windowPage(B);
  const ab = await AgentBrowser.connect(linux());
  try {
    const [t1, t2, tb] = [await ab.find(a1.name), await ab.find(a2.name), await ab.find(b.name)];
    // Another agent, outside this chain (started from a timer that was set before the chain took the lock).
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
    await other;
    assert.ok(otherAt >= endAt, "the other agent waited for the chain");
    assert.equal(b.page.title, "clicked");
  } finally { await ab.disconnect(); }
  for (const p of [a1, a2, b]) await commands.close(linux(), { tab: p.name });
});

test("Tab.waitFor polls during its wait for the lock: a condition that holds ends it at once, one that comes true ends it then (review-52 note 3)", async () => {
  operatorInFront();
  const a1 = await windowPage(A1);
  const popup = fake.openFrom(a1.page, A1); // the page is hidden behind its popup tab
  assert.equal(a1.page.visibilityState, "hidden");
  const ab = await AgentBrowser.connect(linux());
  const holder = holdLock(4000);
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

test("Tab.waitFor: when its timeout comes while the tab switch still runs, it waits for the switch and reads the condition once more (review-55 note 1)", async () => {
  operatorInFront();
  const a1 = await windowPage(A1);
  const popup = fake.openFrom(a1.page, A1); // the page is hidden behind its popup tab
  const ab = await AgentBrowser.connect(linux());
  fake.delays.set("Page.bringToFront", 600); // a slow switch: it ends after the timeout
  try {
    const tab = await ab.find(a1.name);
    const t0 = Date.now();
    assert.equal(await tab.waitFor(() => document.visibilityState === "visible", { timeoutMs: 100, intervalMs: 50 }), true);
    assert.ok(Date.now() - t0 >= 550, `it waited for the switch: ${Date.now() - t0} ms`);
  } finally { fake.delays.delete("Page.bringToFront"); await ab.disconnect(); }
  await commands.close(linux(), { tab: popup.targetId.slice(0, 8) });
  await commands.close(linux(), { tab: a1.name });
});

test("Tab.waitFor: a condition that holds while the switched tab is still hidden ends the switch's wait for the page to show at once (review-55 note 1)", async () => {
  operatorInFront();
  const a1 = await windowPage(A1);
  const popup = fake.openFrom(a1.page, A1);
  fake.stayBehind.add(a1.page.targetId); // Page.bringToFront leaves it hidden: toFront waits up to 1 s for it to show
  const lines: string[] = [];
  const ab = await AgentBrowser.connect(linux({ log: (l) => { lines.push(l); } }));
  try {
    const tab = await ab.find(a1.name);
    a1.page.title = "before";
    setTimeout(() => { a1.page.title = "later"; }, 200);
    const t0 = Date.now();
    assert.equal(await tab.waitFor(() => document.title === "later", { timeoutMs: 3000, intervalMs: 50 }), true);
    assert.ok(Date.now() - t0 < 600, `it ended with the condition, not 1 s after the switch: ${Date.now() - t0} ms`);
    assert.ok(fake.calls.some((x) => x.method === "Page.bringToFront" && x.targetId === a1.page.targetId), "the switch was sent");
    assert.deepEqual(lines.filter((l) => /still hidden/.test(l)), [], "no log line for a wait that the condition ended");
  } finally { fake.stayBehind.delete(a1.page.targetId); await ab.disconnect(); }
  await commands.close(linux(), { tab: popup.targetId.slice(0, 8) });
  await commands.close(linux(), { tab: a1.name });
});

test("two processes on two sites never send input at the same time, as two processes on one site", async () => {
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
  assert.ok(apart(span(a1.page, t), span(b.page, t)), `two sites: never at once (alpha ${span(a1.page, t)}, beta ${span(b.page, t)})`);
  operatorInFront();
  t = Date.now();
  assert.deepEqual(await Promise.all([run(a1.name), run(a2.name)]), [0, 0]);
  assert.ok(apart(span(a1.page, t), span(a2.page, t)), `one site: never at once (www ${span(a1.page, t)}, app ${span(a2.page, t)})`);
  for (const p of [a1, a2, b]) await commands.close(linux(), { tab: p.name });
});

// ---------- one X focus: what the one lock keeps from each page ----------

test("two sites typing at once leave no page with the focus behind another window: a later command on the first site never gives it two focused pages", async () => {
  operatorInFront();
  const a1 = await windowPage(A1), b = await windowPage(B), a2 = await windowPage(A2);
  const text = "hello world, hello";
  // With one lock per site, beta's window came forward while alpha typed, and the keys gave alpha's page the focus with
  // no window switch (FakePage.keyFocus; measured on taylor, window-keys-inactive). The one lock keeps them apart.
  await Promise.all([commands.type(linux(), { tab: a1.name, text, into: "#i" }), sleep(30).then(() => commands.type(linux(), { tab: b.name, text, into: "#i" }))]);
  assert.equal(a1.page.select("#i")[0].value, text);
  assert.equal(b.page.select("#i")[0].value, text);
  const focused = () => [a1, b, a2].filter((p) => p.page.hasFocus).map((p) => p.name);
  assert.ok(focused().length <= 1, `after both: ${focused().join(", ")} focused`);
  await commands.type(linux(), { tab: a2.name, text: "hi", into: "#i" });
  assert.deepEqual(focused(), [a2.name], "one focused page on alpha (and in the browser)");
  assert.deepEqual([a1, b].map((p) => p.page.focusEvents.filter((e) => e === "blur").length), [1, 1], "one blur each: when the next agent's window came forward");
  for (const p of [a1, b, a2]) await commands.close(linux(), { tab: p.name });
});

test("the X pointer moves only over the window in front: with one lock no other site's window comes forward during a path", async () => {
  operatorInFront();
  const a1 = await windowPage(A1), b = await windowPage(B);
  fake.xPointer = { x: 700, y: 500 };
  xMoves.length = 0;
  const o = linuxX({ inputTiming: { ...FAST, moveScale: 0.4 } });
  await Promise.all([commands.click(o, { tab: a1.name, target: "#b" }), sleep(20).then(() => commands.click(o, { tab: b.name, target: "#b" }))]);
  assert.equal(a1.page.title, "clicked");
  assert.equal(b.page.title, "clicked");
  assert.equal(xMoves.length, 2, "one X move at each path's end");
  // Alpha's button is at the left, beta's at the right: each X move went to the window that was active then.
  for (const m of xMoves) assert.equal(m.active, m.x < 400 ? a1.page.windowId : b.page.windowId, JSON.stringify(xMoves));
  for (const p of [a1, b]) await commands.close(linux(), { tab: p.name });
});
