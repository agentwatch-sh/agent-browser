// The pure parts of the Mac input probe (test/live/mac-input-probe/parts.ts; board ab-t30.32): the arguments, the --out
// check, the points, the recorder page's scripts (in a stand-in window of node:vm), the summary statistics, the three
// questions' values and the result's check of numbers only, with made-up numbers. The probe itself (probe.ts) drives a
// browser, so it is not part of `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import {
  CLOSE_RESERVE_MS, PATH_PX, Q1_POINT, TIME_LIMIT_MS, WHEEL_DELTAS, checkResult, chromeVersion, clean, failResult, gaps, hasFraction, inside, okResult,
  outPath, parseArgs, pathEnd, phase, q1Of, q1Point, q2Of, q3Of, quantile, readPage, readRecords, summarize, wholeMs,
  FRAMES, PAGE_INFO, READ, RECORDER, type Args, type Meta, type Move, type Records, type Wheel,
} from "./live/mac-input-probe/parts.ts";

const URL_ = "ws+unix:///var/probe-test/run/browser-cdp.sock:/devtools/browser/probe-1";
const META: Meta = { version: 1, commit: "0123456789abcdef0123456789abcdef01234567", dirty: false, seed: null };
const PLATFORM = { os: "darwin", arch: "arm64", node: "26.12.0", chrome: "158.0.7100.1" };
const PAGE = { width: 1280, height: 800, dpr: 2, visible: true, focused: true, secure: false, frames: true };
/** A free text of a result: no URL, path, address or long id. */
const safe = (s: string) => !/[/\\@]/.test(s) && !/[A-Za-z0-9_+=-]{24,}/.test(s);

test("the arguments: --cdp-url is agent mode's endpoint and required; --out and --seed are optional; no refusal holds the URL", () => {
  assert.deepEqual(parseArgs(["--cdp-url", URL_]), { cdpUrl: URL_, out: null, seed: null });
  assert.deepEqual(parseArgs([`--cdp-url=${URL_}`, "--out", "r.json", "--seed", "7"]), { cdpUrl: URL_, out: "r.json", seed: 7 });
  assert.deepEqual((parseArgs(["--cdp-url", URL_, "--seed", "0"]) as Args).seed, 0);
  assert.deepEqual((parseArgs(["--cdp-url", URL_, "--seed", "4294967295"]) as Args).seed, 4294967295);
  const refusals: [string[], RegExp][] = [
    [[], /--cdp-url is required/],
    [["--cdp-url", "ws://127.0.0.1:9222/devtools/browser/x"], /agent mode's endpoint \(the ws\+unix form\)/],
    [["--cdp-url", "wss://example.com/devtools/browser/x"], /agent mode's endpoint/],
    [["--cdp-url", "ws+unix://relative.sock:/devtools/browser/x"], /agent mode's endpoint/],
    [["--cdp-url"], /argument missing/],
    [["--cdp-url", URL_, "--other"], /Unknown option '--other'/],
    [[URL_], /Unexpected argument '<url>/],
    [["--cdp-url", URL_, URL_], /Unexpected argument '<url>/],
    [["--cdp-url", URL_, "--out", " "], /--out needs a file name/],
    ...["-1", "1.5", "4294967296", "abc", "", "12345678901", " 7"].map((s): [string[], RegExp] => [["--cdp-url", URL_, `--seed=${s}`], /--seed is a whole number from 0 to 4294967295/]),
  ];
  for (const [argv, want] of refusals) {
    const r = parseArgs(argv);
    assert.ok("error" in r, argv.join(" "));
    assert.match(r.error, want, argv.join(" "));
    assert.ok(!r.error.includes("browser-cdp.sock") && !r.error.includes("probe-1") && safe(r.error), r.error);
  }
});

test("--out: a new file in a folder that exists, outside every git checkout (also through a link), never a file that exists", () => {
  // A box with a checkout at /work/repo (its .git), a worktree at /work/wt (a .git file), a link /tmp/into to
  // /work/repo/sub, and the file /tmp/old.json.
  const dirs = new Set(["/", "/tmp", "/work", "/work/repo", "/work/repo/sub", "/work/wt", "/data/u", "/data"]);
  const files = new Set(["/work/repo/.git", "/work/wt/.git", "/tmp/old.json"]);
  const fs = {
    realDir: (p: string) => { const r = p.startsWith("/tmp/into") ? p.replace("/tmp/into", "/work/repo/sub") : p; return dirs.has(r) ? r : null; },
    exists: (p: string) => files.has(p) || dirs.has(p),
  };
  assert.deepEqual(outPath("/tmp/r.json", "/", fs), { path: "/tmp/r.json" });
  assert.deepEqual(outPath("r.json", "/data/u", fs), { path: "/data/u/r.json" });
  assert.deepEqual(outPath("../r.json", "/data/u", fs), { path: "/data/r.json" });
  const refusals: [string, string, RegExp][] = [
    ["/work/repo/r.json", "/", /inside a git checkout/],
    ["/work/repo/sub/r.json", "/", /inside a git checkout/],
    ["sub/r.json", "/work/repo", /inside a git checkout/],
    ["/work/wt/r.json", "/", /inside a git checkout/],
    ["/tmp/into/r.json", "/", /inside a git checkout/],
    ["/tmp/old.json", "/", /a file that exists/],
    ["/nowhere/r.json", "/", /the folder of --out does not exist/],
    ["/tmp/", "/", /names a folder/],
    ["/tmp/..", "/", /names a folder/],
  ];
  for (const [file, cwd, want] of refusals) {
    const r = outPath(file, cwd, fs);
    assert.ok("error" in r, file);
    assert.match(r.error, want, file);
    assert.ok(safe(r.error), r.error);
  }
});

test("the points: Q1's point has a fraction on both axes; Q3's end is 600 px away inside the viewport; a seed gives the same points each time", () => {
  assert.deepEqual(q1Point(null), { x: 300.37, y: 200.61 });
  assert.deepEqual(pathEnd(Q1_POINT, { width: 1280, height: 800 }, null), { to: { x: 780.37, y: 560.61 }, lengthPx: 600 });
  // Less room down and to the right: up and to the right.
  const up = pathEnd({ x: 300.37, y: 450.61 }, { width: 1280, height: 500 }, null)!;
  assert.deepEqual(up, { to: { x: 780.37, y: 90.61 }, lengthPx: 600 });
  // No direction has 600 px: the most room, a whole px less.
  const short = pathEnd(Q1_POINT, { width: 700, height: 420 }, null)!;
  assert.ok(short.lengthPx >= 300 && short.lengthPx < PATH_PX && inside(short.to, { width: 700, height: 420 }), JSON.stringify(short));
  assert.equal(pathEnd({ x: 150, y: 110 }, { width: 320, height: 220 }, null), null);
  assert.equal(inside(Q1_POINT, { width: 300, height: 800 }), false);
  for (let seed = 0; seed < 200; seed++) {
    const p = q1Point(seed), again = q1Point(seed);
    assert.deepEqual(p, again);
    for (const [v, whole] of [[p.x, 300], [p.y, 200]]) {
      const f = Math.round((v - whole) * 100);
      assert.ok(f >= 5 && f <= 95 && f !== 50 && Math.abs(v - (whole + f / 100)) < 1e-9, `${seed}: ${v}`);
      assert.ok(hasFraction(v));
    }
    const e = pathEnd(p, { width: 1280, height: 800 }, seed)!;
    assert.deepEqual(e, pathEnd(p, { width: 1280, height: 800 }, seed));
    assert.ok(Math.abs(e.lengthPx - PATH_PX) < 0.02 && inside(e.to, { width: 1280, height: 800 }), `${seed}: ${JSON.stringify(e)}`);
  }
  // From Q1's point in 1280 x 800, two directions have 600 px (down and to the right, and to the right): the seeds take both.
  const dirs = new Set(Array.from({ length: 50 }, (_, s) => { const p = q1Point(s), e = pathEnd(p, { width: 1280, height: 800 }, s)!; return `${Math.sign(Math.round(e.to.x - p.x))},${Math.sign(Math.round(e.to.y - p.y))}`; }));
  assert.deepEqual([...dirs].sort(), ["1,0", "1,1"]);
  assert.ok(TIME_LIMIT_MS === 60_000 && CLOSE_RESERVE_MS < TIME_LIMIT_MS);
  assert.deepEqual(WHEEL_DELTAS, [13, 120]);
});

test("the statistics: quantiles by linear interpolation, count, median, p10, p90, min and max to 3 decimals", () => {
  const g = [8.0, 8.1, 7.9, 8.3, 8.2, 8.0, 7.95, 8.25, 8.05, 8.15];
  assert.deepEqual(summarize(g), { count: 10, median: 8.075, p10: 7.945, p90: 8.255, min: 7.9, max: 8.3 });
  assert.deepEqual(summarize([]), { count: 0, median: null, p10: null, p90: null, min: null, max: null });
  assert.deepEqual(summarize([4.12345]), { count: 1, median: 4.123, p10: 4.123, p90: 4.123, min: 4.123, max: 4.123 });
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([3, 1, 2], 0), 1);
  assert.equal(quantile([3, 1, 2], 1), 3);
  assert.equal(quantile([], 0.5), null);
  assert.deepEqual(gaps([10, 18.3, 26.5, 26.5]).map((x) => Math.round(x * 10) / 10), [8.3, 8.2, 0]);
  assert.equal(wholeMs(8), true);
  assert.equal(wholeMs(8.0004), true);
  assert.equal(wholeMs(8.3), false);
  assert.equal(hasFraction(300.36999511), true);
  assert.equal(hasFraction(300.0001), false);
  assert.equal(hasFraction(null), false);
});

/** Made-up records: a Mac-like move (fractional end), a path at 8.3 ms with 2 samples each, the frames at 120 Hz, and two wheel calls. */
function records(o: { endX: number; endY: number; whole?: boolean }): Records {
  const pt = (t: number, x: number, y: number) => ({ t, x, y, ox: x, oy: y });
  const moves: Move[] = [];
  for (let i = 0; i < 5; i++) {
    const x = o.whole ? 290 + 2 * i : 290.5 + 2 * i, y = o.whole ? 190 + 2 * i : 190.25 + 2 * i;
    moves.push({ p: "q1", ...pt(100 + 16 * i, x, y), tr: true, mouse: true, api: true, c: [pt(92 + 16 * i, x - 1, y - 1), pt(100 + 16 * i, x, y)], pr: 0 });
  }
  moves.push({ p: "q1", ...pt(180, o.endX, o.endY), tr: true, mouse: true, api: true, c: [pt(180, o.endX, o.endY)], pr: 0 });
  for (let i = 0; i < 20; i++) {
    const t = 500 + 16.6 * i, x = 300 + 24 * i, y = 200 + 18 * i;
    moves.push({ p: "q3", ...pt(t, x, y), tr: true, mouse: true, api: true, c: [pt(t - 8.3, x - 12, y - 9), pt(t, x, y)], pr: 1 });
  }
  const w = (p: string, t: number, dy: number, wdy: number): Wheel => ({ p, t, dx: 0, dy, mode: 0, wdx: 0, wdy, tr: true });
  return { moves, mice: moves.filter((m) => m.p === "q1").map((m) => ({ p: m.p, t: m.t, x: Math.round(m.x!), y: Math.round(m.y!), ox: m.ox, oy: m.oy, tr: true })), wheels: [w("q2-0", 900, 13, -39), w("q2-1", 1300, 120, -360)],
    frames: Array.from({ length: 41 }, (_, i) => 490 + 8.33 * i), scrollY: 133 };
}

test("Q1: the page's last pointermove is at the asked fractional point (the Mac), or at a whole px (Linux's rounding)", () => {
  const mac = q1Of(records({ endX: 300.3699951171875, endY: 200.61000061035156 }), Q1_POINT);
  assert.equal(mac.pointermoves, 6);
  assert.equal(mac.samples, 11);
  assert.equal(mac.trusted, 6);
  assert.equal(mac.reached, true);
  assert.equal(mac.lastHasFraction, true);
  assert.deepEqual(mac.withFraction, { pointermove: 6, pointermoveOffset: 6, sample: 11, sampleOffset: 11, mousemove: 0 });
  assert.equal(mac.last!.clientX, 300.3699951171875);
  assert.ok(Math.abs(mac.lastErrorPx!.x) < 1e-5 && Math.abs(mac.lastErrorPx!.y) < 1e-5);
  const linux = q1Of(records({ endX: 300, endY: 201, whole: true }), Q1_POINT);
  assert.equal(linux.reached, false);
  assert.equal(linux.lastHasFraction, false);
  assert.deepEqual(linux.lastErrorPx, { x: -0.37, y: 0.39 });
  assert.deepEqual(linux.withFraction, { pointermove: 0, pointermoveOffset: 0, sample: 0, sampleOffset: 0, mousemove: 0 });
  const none = q1Of({ moves: [], mice: [], wheels: [], frames: [], scrollY: 0 }, Q1_POINT);
  assert.equal(none.pointermoves, 0);
  assert.equal(none.last, null);
  assert.equal(none.reached, false);
});

test("Q2 and Q3: the wheel values of each call, and the sample gaps of the path", () => {
  const r = records({ endX: 300.37, endY: 200.61 });
  const q2 = q2Of(r, WHEEL_DELTAS);
  assert.equal(q2.calls.length, 2);
  assert.deepEqual(q2.calls.map((c) => [c.deltaY, c.events, c.deltaYs, c.deltaModes, c.wheelDeltaYs, c.wheelPerDeltaY]), [[13, 1, [13], [0], [-39], -3], [120, 1, [120], [0], [-360], -3]]);
  assert.equal(q2.scrollY, 133);
  assert.equal(q2Of({ ...r, wheels: [] }, WHEEL_DELTAS).calls[0].wheelPerDeltaY, null);
  const q3 = q3Of(r, Q1_POINT, { x: 780.37, y: 560.61 });
  assert.equal(q3.pointermoves, 20);
  assert.equal(q3.samples, 40);
  assert.equal(q3.chordPx, 600);
  assert.equal(q3.sampleGapsMs.count, 39);
  assert.equal(q3.sampleGapsMs.median, 8.3);
  assert.equal(q3.sampleGapsMs.min, 8.3);
  assert.equal(q3.samplesPerPointermove.median, 2);
  assert.equal(q3.pointermoveGapsMs.median, 16.6);
  assert.equal(q3.wholeMsGaps, 0);
  assert.equal(q3.gapsMs.length, 39);
  assert.equal(q3.pathMs, 323.7);
  assert.equal(q3.endReached, false);
  assert.equal(q3.fromCoalesced, true);
  assert.equal(q3.frames, 41);
  assert.equal(q3.framesMs.median, 8.33);
  // A page that hides getCoalescedEvents (not a secure context): each pointermove is one sample, at its own time.
  const bare = { ...r, moves: r.moves.map((m) => ({ ...m, api: false, c: [] })) };
  const b3 = q3Of(bare, Q1_POINT, { x: 780.37, y: 560.61 });
  assert.equal(b3.fromCoalesced, false);
  assert.equal(b3.coalescedApi, 0);
  assert.equal(b3.samples, 20);
  assert.equal(b3.sampleGapsMs.count, 19);
  assert.equal(b3.sampleGapsMs.median, 16.6);
  assert.deepEqual(b3.sampleGapsMs, b3.pointermoveGapsMs);
  const b1 = q1Of(bare, Q1_POINT);
  assert.equal(b1.coalescedApi, 0);
  assert.equal(b1.samples, 0);
  assert.equal(b1.last!.sampleX, null);
});

test("the records: the page's shape passes; a wrong value or part fails closed; other fields are dropped", () => {
  const r = records({ endX: 300.37, endY: 200.61 });
  const raw = JSON.parse(JSON.stringify(r));
  raw.moves[0].text = "page text";
  raw.wheels[0].url = "https://example.com/";
  const back = readRecords(raw)!;
  assert.deepEqual(back, r);
  assert.equal("text" in back.moves[0], false);
  for (const bad of [
    (x: any) => { x.moves[0].x = "300"; }, (x: any) => { x.moves[0].p = "other"; }, (x: any) => { x.moves[0].c[0].t = Infinity; },
    (x: any) => { x.wheels[0].wdy = "x"; }, (x: any) => { x.mice = null; }, (x: any) => { x.scrollY = "0"; }, (x: any) => { x.moves[0].pr = 1.5; },
    (x: any) => { x.moves[0].api = 1; }, (x: any) => { x.frames = [1, "2"]; }, (x: any) => { delete x.frames; },
  ]) {
    const x = JSON.parse(JSON.stringify(r));
    bad(x);
    assert.equal(readRecords(x), null);
  }
  assert.equal(readRecords(null), null);
  assert.deepEqual(readPage({ width: 1280, height: 800, dpr: 2, visible: true, focused: false, secure: false }, true), { width: 1280, height: 800, dpr: 2, visible: true, focused: false, secure: false, frames: true });
  assert.equal(readPage({ width: 0, height: 800, dpr: 2, visible: true, focused: false, secure: true }, true), null);
  assert.equal(readPage({ width: 1280, height: 800, dpr: 2, visible: "visible", focused: false, secure: true }, true), null);
  assert.equal(readPage({ width: 1280, height: 800, dpr: 2, visible: true, focused: false }, true), null);
});

test("the recorder in a stand-in window: passive listeners, numbers only, Q3's frames, and the records read back in their shape", () => {
  const listeners = new Map<string, { fn: (e: any) => void; o: any }>();
  const raf: ((t: number) => void)[] = [];
  const frame = (t: number) => { for (const f of raf.splice(0)) f(t); };
  const el = () => ({ style: { cssText: "" } as { cssText: string } });
  const sandbox: any = {
    document: { documentElement: el(), body: { ...el(), children: [] as unknown[], appendChild(c: unknown) { this.children.push(c); } }, createElement: el, visibilityState: "visible", hasFocus: () => true },
    addEventListener: (type: string, fn: (e: any) => void, o: any) => { listeners.set(type, { fn, o }); },
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 2, scrollY: 0, isSecureContext: false,
    setTimeout, clearTimeout, requestAnimationFrame: (f: (t: number) => void) => { raf.push(f); },
  };
  sandbox.window = sandbox;
  createContext(sandbox);
  assert.equal(runInContext(RECORDER, sandbox), true);
  assert.equal(runInContext(RECORDER, sandbox), false, "a second recorder is refused");
  assert.deepEqual([...listeners.keys()].sort(), ["mousemove", "pointermove", "wheel"]);
  for (const { o } of listeners.values()) assert.deepEqual({ ...o }, { capture: true, passive: true });
  assert.match(sandbox.document.body.children[0].style.cssText, /height:400vh/);
  runInContext(phase("q1"), sandbox);
  const ev = (t: number, x: number, y: number) => ({ timeStamp: t, clientX: x, clientY: y, offsetX: x, offsetY: y, isTrusted: true, pointerType: "mouse" });
  listeners.get("pointermove")!.fn({ ...ev(10, 300.37, 200.61), target: { textContent: "page text" }, getCoalescedEvents: () => [ev(2, 299.5, 200.1), ev(10, 300.37, 200.61)], getPredictedEvents: () => [ev(18, 301, 201)] });
  listeners.get("mousemove")!.fn(ev(10, 300, 200));
  // Q3 records the page's frames until the next part.
  frame(1);
  runInContext(phase("q3"), sandbox);
  for (const t of [16.7, 25, 33.3]) frame(t);
  runInContext(phase("q2-0"), sandbox);
  frame(41.7);
  frame(50);
  assert.equal(raf.length, 0, "the frame loop ends with Q3");
  listeners.get("wheel")!.fn({ timeStamp: 20, deltaX: 0, deltaY: 13, deltaMode: 0, wheelDeltaX: 0, wheelDeltaY: -39, isTrusted: true, clientX: 300 });
  const r = readRecords(JSON.parse(JSON.stringify(runInContext(READ, sandbox))))!;
  assert.ok(r, "the records are in their shape");
  assert.deepEqual(r.moves, [{ p: "q1", t: 10, x: 300.37, y: 200.61, ox: 300.37, oy: 200.61, tr: true, mouse: true, api: true, c: [{ t: 2, x: 299.5, y: 200.1, ox: 299.5, oy: 200.1 }, { t: 10, x: 300.37, y: 200.61, ox: 300.37, oy: 200.61 }], pr: 1 }]);
  assert.deepEqual(r.wheels, [{ p: "q2-0", t: 20, dx: 0, dy: 13, mode: 0, wdx: 0, wdy: -39, tr: true }]);
  assert.equal(r.mice.length, 1);
  assert.deepEqual(r.frames, [16.7, 25, 33.3]);
  assert.deepEqual(JSON.parse(JSON.stringify(runInContext(PAGE_INFO, sandbox))), { width: 1280, height: 800, dpr: 2, visible: true, focused: true, secure: false });
  assert.throws(() => phase("q4"));
  assert.throws(() => phase(""));
  assert.match(FRAMES, /requestAnimationFrame/);
});

test("the result: numbers only passes its check; a string, a path, a URL or a NaN in it fails; a stop's texts are clean", () => {
  const r = records({ endX: 300.3699951171875, endY: 200.61000061035156 });
  const ok = okResult({ meta: META, platform: PLATFORM, page: PAGE, parts: { q1: q1Of(r, Q1_POINT), q2: q2Of(r, WHEEL_DELTAS), q3: q3Of(r, Q1_POINT, { x: 780.37, y: 560.61 }) }, ms: 4321.4, tabClosed: true });
  assert.equal(checkResult(ok), null);
  assert.deepEqual(Object.keys(ok), ["ok", "probe", "platform", "page", "q1", "q2", "q3", "tabClosed", "ms"]);
  assert.equal(ok.ms, 4321);
  const text = JSON.stringify(ok);
  for (const no of ["/", "http", "about", "cookie", "token"]) assert.ok(!text.includes(no), no);
  const bad = (f: (x: any) => void) => { const x = JSON.parse(JSON.stringify(ok)); f(x); return checkResult(x); };
  assert.equal(bad((x) => { x.q1.last.clientX = "300.37"; }), "q1.last.clientX");
  assert.equal(bad((x) => { x.q3.gapsMs[3] = "8.3"; }), "q3.gapsMs[3]");
  assert.equal(bad((x) => { x.page.url = "about:blank"; }), "page.url");
  assert.equal(bad((x) => { x.platform.chrome = "Chrome 158 (Macintosh; Intel Mac OS X 10_15_7)"; }), "platform.chrome");
  assert.equal(bad((x) => { x.platform.os = "/data/someone"; }), "platform.os");
  assert.equal(bad((x) => { x.probe.commit = "main"; }), "probe.commit");
  assert.equal(bad((x) => { x["a/b"] = 1; }), ".<key>");
  assert.equal(bad((x) => { delete x.q2; }), "<parts>");
  assert.equal(bad((x) => { x.q3.gapsMs = Array(40_000).fill(8.333); }), "<size>");
  assert.equal(checkResult({ ...ok, ms: NaN }), "ms");
  assert.equal(checkResult({ ...ok, ms: Infinity }), "ms");
  assert.equal(checkResult("ok"), "ok");

  const detail = clean("could not connect to ws+unix:///var/probe-test/run/browser-cdp.sock:/devtools/browser/probe-1: HTTP 503: The agent browser could not get ready: Chromium not found: /nonexistent/chromium. Mail me@example.com, token abt1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ~/x C:\\x", [URL_, "/var/probe-test/run/browser-cdp.sock", "probe-1"]);
  assert.ok(safe(detail) && detail.length <= 200, detail);
  for (const no of ["run", "probe-test", "browser-cdp", "probe-1", "nonexistent", "example", "abt1"]) assert.ok(!detail.includes(no), `${no}: ${detail}`);
  assert.match(detail, /HTTP 503: The agent browser could not get ready: Chromium not found: <path>/);
  assert.ok(clean("x".repeat(500) + " y").length <= 200);
  const stop = failResult({ meta: META, platform: PLATFORM, stage: "connect", reason: "the endpoint is not ready", code: 503, detail, tabClosed: null, ms: 12.6 });
  assert.equal(checkResult(stop), null);
  assert.deepEqual(Object.keys(stop), ["ok", "stage", "reason", "code", "detail", "probe", "platform", "tabClosed", "ms"]);
  assert.equal(checkResult({ ...stop, reason: "see /data/someone/x" }), "reason");
  assert.equal(checkResult({ ...stop, detail: "token abcdefghijklmnopqrstuvwxyz0123" }), "detail");
  assert.equal(checkResult({ ...stop, stage: "Connect now" }), "stage");
  assert.equal(checkResult({ ok: false, probe: META, ms: 1 }), "<stop>");
  assert.equal(chromeVersion("Chrome/158.0.7100.1"), "158.0.7100.1");
  assert.equal(chromeVersion("HeadlessChrome/146.0.1"), "146.0.1");
  assert.equal(chromeVersion("Chrome/"), "unknown");
  assert.equal(chromeVersion(undefined), "unknown");
  assert.equal(chromeVersion("Chrome/1.2.3.4 (Macintosh)"), "unknown");
});
