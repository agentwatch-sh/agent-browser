// The agent Chrome's display (src/display.ts; ab-v16.26, review-45 F7 and review-45b): the window design applies only
// where the agent Chrome runs on a display of its own. Against a fake xdotool, a fake pid and a fake clock: the
// windows check, the cache of one minute for the same Chrome pid, the log line at most once in 5 minutes, a check that
// fails, cdpUrl, and a test's own answer.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { displayOf, hasWindowManager, onlyWindowsOf, type DisplayDeps, type XAccess } from "../src/display.ts";
import { resolveOptions, type BrowserOptions } from "../src/options.ts";
import { consumer, type Consumer } from "./helpers.ts";

let c: Consumer;
before(() => { c = consumer(); });
after(() => c?.remove());

/** A fake display: its root, its visible windows and each window's pid; every xdotool call is counted. */
function fakeX(windows: Record<string, string>, root = "1") {
  const calls: string[][] = [];
  const x: XAccess = {
    display: ":42",
    run: async (args) => {
      calls.push(args);
      if (args[0] === "search" && args.includes("--maxdepth")) return `${root}\n`;
      if (args[0] === "search") return [root, ...Object.keys(windows)].join("\n") + "\n";
      if (args[0] === "getwindowpid") { const p = windows[args[1]]; if (p === undefined) throw new Error("no pid"); return `${p}\n`; }
      throw new Error(`fake xdotool: ${args.join(" ")}`);
    },
  };
  return { x, calls };
}

const settings = (extra: Partial<BrowserOptions> = {}) => resolveOptions(c.options({ platform: "linux", ...extra }));
/** xprop on a display with no window manager (agentwatch's Xvfb), or with one (a person's desktop). */
const noWm = () => async () => "_NET_SUPPORTING_WM_CHECK:  not found.\n";
const aWm = () => async () => "_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x21f\n";
/** xprop on a new Xvfb: no client has named the atom yet. */
const noAtom = () => async () => "_NET_SUPPORTING_WM_CHECK:  no such atom on any window.\n";

/** xdpyinfo's extension list on a server that is not XWayland. No real display is queried. */
const noXwayland = () => async () => "number of extensions:    2\n    RANDR\n    XTEST\ndefault screen number:    0\n";


test("onlyWindowsOf: every visible window but the root is the pid's; another pid, or no window, is not a display of its own", async () => {
  assert.equal(await onlyWindowsOf(fakeX({ 10: "4242", 11: "4242" }).x, "4242"), true);
  assert.equal(await onlyWindowsOf(fakeX({ 10: "4242", 11: "999" }).x, "4242"), false, "another program's window");
  assert.equal(await onlyWindowsOf(fakeX({}).x, "4242"), false, "no window at all");
  const noPid = fakeX({ 10: "4242" });
  noPid.x.run = async (args) => (args[0] === "getwindowpid" && args[1] === "12" ? Promise.reject(new Error("no pid")) : args[0] === "search" && !args.includes("--maxdepth") ? "1\n10\n12\n" : fakeX({ 10: "4242" }).x.run(args));
  assert.equal(await onlyWindowsOf(noPid.x, "4242"), false, "a window with no pid is not the Chrome's");
});

test("an agent Chrome that agent-browser started: own when its display holds only its windows; the answer holds a minute for that pid", async () => {
  let t = 1_000_000, pid = 4242;
  const disp = fakeX({ 10: "4242" });
  const deps: DisplayDeps = { pid: () => pid, env: () => ({ DISPLAY: ":42" }), runner: () => disp.x, xprop: noWm, xdpyinfo: noXwayland, now: () => t };
  const s = settings();
  let info = await displayOf(s, false, deps);
  assert.deepEqual([info.own, info.chromePid, !!info.x], [true, 4242, true]);
  const kept = JSON.parse(readFileSync(join(c.stateDir, "display.json"), "utf8"));
  assert.deepEqual([kept.chromePid, kept.own, kept.display], [4242, true, ":42"]);
  const n = disp.calls.length;
  t += 30_000;
  info = await displayOf(s, false, deps);
  assert.equal(info.own, true);
  assert.equal(disp.calls.length, n, "within the minute, no xdotool call");
  // A restart (another pid) within the minute checks again, on its own display.
  pid = 5151;
  info = await displayOf(s, false, deps);
  assert.equal(info.own, false, "the windows there are 4242's, not 5151's");
  assert.ok(disp.calls.length > n);
  pid = 4242;
  t += 61_000;
  const m = disp.calls.length;
  info = await displayOf(s, false, deps);
  assert.equal(info.own, true);
  assert.ok(disp.calls.length > m, "after the minute, the check runs again");
});

test("not a display of its own: the log line says why, at most once in 5 minutes; no xdotool, no DISPLAY, no agent Chrome", async () => {
  const o = consumer();
  try {
    let t = 2_000_000;
    const lines: string[] = [];
    const s = resolveOptions(o.options({ platform: "linux", log: (l) => { lines.push(l); } }));
    const other = fakeX({ 10: "4242", 11: "777" });
    const deps: DisplayDeps = { pid: () => 4242, env: () => ({ DISPLAY: ":42" }), runner: () => other.x, xprop: noWm, xdpyinfo: noXwayland, now: () => t };
    let info = await displayOf(s, true, deps);
    assert.equal(info.own, false);
    assert.match(info.why!, /another program's window is on the display :42/);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /not on a display of its own \(another program's window is on the display :42\); agent-browser opens each page as a background tab/);
    t += 61_000;
    info = await displayOf(s, true, deps);
    assert.equal(lines.length, 1, "not again within 5 minutes");
    t += 5 * 60_000;
    await displayOf(s, true, deps);
    assert.equal(lines.length, 2, "again after 5 minutes");
    const broken: XAccess = { display: ":42", run: async () => { throw new Error("xdotool: not found"); } };
    info = await displayOf(s, false, { ...deps, runner: () => broken, now: () => (t += 61_000) });
    assert.match(info.why!, /cannot check the display :42 \(no xdotool/);
    info = await displayOf(s, false, { ...deps, env: () => undefined, now: () => (t += 61_000) });
    const saved = process.env.DISPLAY;
    delete process.env.DISPLAY;
    try { info = await displayOf(s, false, { ...deps, env: () => undefined, now: () => (t += 61_000) }); } finally { if (saved !== undefined) process.env.DISPLAY = saved; }
    assert.match(info.why!, /cannot see the agent Chrome's display \(no DISPLAY\)/);
    info = await displayOf(s, false, { ...deps, pid: () => undefined });
    assert.match(info.why!, /finds no agent Chrome of its own/);
  } finally { o.remove(); }
});

test("a Wayland session or a window manager is not a display of its own: WAYLAND_DISPLAY in the chosen environment, _NET_SUPPORTING_WM_CHECK on the root, or no xprop (ab-v16.42)", async () => {
  const o = consumer();
  try {
    let t = 3_000_000;
    const s = resolveOptions(o.options({ platform: "linux" }));
    // The agent Chrome forced to X11 (--ozone-platform=x11) is the only XWayland client, and nothing frames it: xdotool alone says "own".
    const only = fakeX({ 10: "4242" });
    const base: DisplayDeps = { pid: () => 4242, runner: () => only.x, xprop: noWm, xdpyinfo: noXwayland, now: () => (t += 61_000) };
    let info = await displayOf(s, false, { ...base, env: () => ({ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }) });
    assert.equal(info.own, false);
    assert.match(info.why!, /chosen display environment has WAYLAND_DISPLAY=wayland-0: treat its X display :0/);
    info = await displayOf(s, false, { ...base, env: () => ({ DISPLAY: ":0" }), xprop: aWm });
    assert.equal(info.own, false);
    assert.match(info.why!, /a window manager runs on the display :0 \(_NET_SUPPORTING_WM_CHECK\)/);
    info = await displayOf(s, false, { ...base, env: () => ({ DISPLAY: ":0" }), xprop: () => async () => { throw new Error("spawn xprop ENOENT"); } });
    assert.equal(info.own, false);
    assert.match(info.why!, /cannot check for a window manager on the display :0 \(no xprop/);
    // This process's environment, when the agent Chrome's cannot be read: its WAYLAND_DISPLAY counts too.
    const saved = { d: process.env.DISPLAY, w: process.env.WAYLAND_DISPLAY };
    process.env.DISPLAY = ":0"; process.env.WAYLAND_DISPLAY = "wayland-1";
    try { info = await displayOf(s, false, { ...base, env: () => undefined }); }
    finally {
      if (saved.d === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = saved.d;
      if (saved.w === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = saved.w;
    }
    assert.match(info.why!, /WAYLAND_DISPLAY=wayland-1/);
    // No window manager and no Wayland: own, as before.
    info = await displayOf(s, false, { ...base, env: () => ({ DISPLAY: ":42" }) });
    assert.equal(info.own, true);
  } finally { o.remove(); }
});

test("hasWindowManager reads xprop's answer: a window id, not found, no such atom, or an answer it does not know (an error)", async () => {
  assert.equal(await hasWindowManager(aWm()), true);
  assert.equal(await hasWindowManager(noWm()), false);
  assert.equal(await hasWindowManager(noAtom()), false);
  await assert.rejects(hasWindowManager(async () => "xprop: unable to open display ':9'\n"), /xprop gave no answer/);
});

test("within the minute, the kept pid's /proc/<pid>/cmdline stands in for ps: no ps while it is still this profile's agent Chrome (review-45c)", async () => {
  const o = consumer();
  try {
    let t = 4_000_000, psCalls = 0;
    const s = resolveOptions(o.options({ platform: "linux" }));
    const disp = fakeX({ 10: "4242" });
    let cmdline: string | undefined = `/usr/lib/chromium/chromium --user-data-dir=${s.profileDir} --window-name=agent`;
    const deps: DisplayDeps = { pid: () => { psCalls++; return 4242; }, cmdline: (p) => (p === 4242 ? cmdline : undefined), env: () => ({ DISPLAY: ":42" }),
      runner: () => disp.x, xprop: noWm, xdpyinfo: noXwayland, now: () => t };
    assert.equal((await displayOf(s, false, deps)).own, true);
    assert.equal(psCalls, 1, "the first check finds the pid with ps");
    t += 30_000;
    assert.equal((await displayOf(s, false, deps)).own, true);
    assert.equal(psCalls, 1, "the kept pid is still the agent Chrome: no ps");
    // The pid now belongs to another process (a renderer, another profile, or none): ps again.
    for (const other of [`/usr/lib/chromium/chromium --type=renderer --user-data-dir=${s.profileDir}`, `/usr/lib/chromium/chromium --user-data-dir=${s.profileDir}-other`, undefined]) {
      cmdline = other;
      const n = psCalls;
      await displayOf(s, false, deps);
      assert.equal(psCalls, n + 1, String(other));
    }
    // After the minute the check runs again, with ps.
    cmdline = `/usr/lib/chromium/chromium --user-data-dir=${s.profileDir}`;
    t += 61_000;
    const n = psCalls;
    await displayOf(s, false, deps);
    assert.equal(psCalls, n + 1);
  } finally { o.remove(); }
});

test("a check that fails (no ps) gives not own with a clear log line, never an error of the connection", async () => {
  const lines: string[] = [];
  const s = settings({ log: (l) => { lines.push(l); } });
  const info = await displayOf(s, true, { pid: () => { throw new Error("spawnSync ps ENOENT"); }, now: () => 9_000_000_000 });
  assert.equal(info.own, false);
  assert.match(info.why!, /the check of the display failed \(spawnSync ps ENOENT\)/);
  assert.ok(lines.some((l) => /the check of the display failed/.test(l)), lines.join("\n"));
});

test("behind cdpUrl (agentwatch's private Xvfb): own, with no check; a test's own answer comes first; no test runner skips the check", async () => {
  const cdp = resolveOptions(c.options({ platform: "linux", cdpUrl: "ws+unix:///tmp/x.sock:/devtools/browser/a", noLaunch: false }));
  let called = false;
  const info = await displayOf(cdp, false, { pid: () => { called = true; return 1; } });
  assert.equal(info.own, true);
  assert.equal(called, false);
  assert.equal((await displayOf(settings({ display: { own: false } }))).own, false);
  assert.equal((await displayOf(settings({ display: { own: true, chromePid: 7 } }))).chromePid, 7);
  // Under this test runner, with nothing given: the real check (no agent Chrome on this test's profile).
  const real = await displayOf(settings());
  assert.equal(real.own, false);
  assert.match(real.why!, /finds no agent Chrome of its own/);
  assert.ok(existsSync(join(c.stateDir, "display.json")));
});


test("the display gate rejects XWAYLAND without WAYLAND_DISPLAY or a window manager, and fails closed without xdpyinfo", async () => {
  const c = consumer();
  try {
    let t = 20_000_000;
    const seen: string[][] = [], displays: string[] = [];
    const s = resolveOptions(c.options({ platform: "linux" }));
    const deps: DisplayDeps = { pid: () => 4242, env: () => ({ DISPLAY: ":42", XAUTHORITY: "/tmp/test-cookie" }),
      runner: () => fakeX({ 10: "4242" }).x, xprop: noWm, now: () => (t += 61_000) };
    for (const output of [
      "number of extensions:    3\n    RANDR\n    XTEST\n    XWAYLAND\ndefault screen number:    0\n",
      "missing", "unreadable", "", "number of extensions: 2\n    RANDR\ndefault screen number: 0\n",
    ]) {
      const info = await displayOf(s, false, { ...deps, xdpyinfo: (env) => {
        displays.push(env.DISPLAY);
        assert.equal(env.XAUTHORITY, "/tmp/test-cookie");
        assert.equal(env.WAYLAND_DISPLAY, undefined);
        return async (args) => {
          seen.push(args);
          if (output === "missing") throw new Error("spawn xdpyinfo ENOENT");
          if (output === "unreadable") throw new Error("unable to open display");
          return output;
        };
      } });
      assert.equal(info.own, false, output);
      assert.equal(info.x, undefined, "no pointer access on a rejected display");
      assert.match(info.why!, output.includes("XWAYLAND") ? /XWAYLAND.*person's screen/ : /cannot check.*xdpyinfo/);
    }
    assert.deepEqual(displays, Array(5).fill(":42"));
    assert.deepEqual(seen, Array.from({ length: 5 }, () => []));
    assert.equal((await displayOf(s, false, { ...deps, xdpyinfo: noXwayland })).own, true, "a complete list without XWAYLAND passes");
  } finally { c.remove(); }
});


test("the display gate matches the exact XWAYLAND extension name", async () => {
  const c = consumer();
  try {
    const s = resolveOptions(c.options({ platform: "linux" }));
    const info = await displayOf(s, false, {
      pid: () => 4242, env: () => ({ DISPLAY: ":42" }), runner: () => fakeX({ 10: "4242" }).x, xprop: noWm,
      xdpyinfo: () => async () => "number of extensions: 3\n    XTEST\n    XWAYLAND-EXT\n    NOT_XWAYLAND\ndefault screen number: 0\n",
    });
    assert.equal(info.own, true, "similar extension names do not identify XWayland");
    assert.ok(info.x, "the accepted display keeps its pointer access");
  } finally { c.remove(); }
});
