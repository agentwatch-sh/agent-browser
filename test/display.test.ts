// The agent Chrome's display (src/display.ts; ab-v16.26, review-45 F7 and review-45b): the window design applies only
// where the agent Chrome runs on a display of its own. Behind agent mode's endpoint (the only way since board
// ab-v16.9.3) that is agentwatch's private Xvfb: own, and an activation verifies it before the X pointer moves
// (input.ts). Against a fake xdotool: the windows check of that verification, the endpoint's answer, a test's own
// answer and its log line. The check of an agent Chrome that agent-browser started itself went with the CDP proxy.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { displayOf, noticeNotOwn, onlyWindowsOf, type XAccess } from "../src/display.ts";
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

const settings = (extra: Partial<BrowserOptions> = {}) => resolveOptions(c.options({ platform: "linux", cdpUrl: "ws+unix:///tmp/x.sock:/devtools/browser/a", ...extra }));

test("onlyWindowsOf: every visible window but the root is the pid's; another pid, or no window, is not a display of its own", async () => {
  assert.equal(await onlyWindowsOf(fakeX({ 10: "4242", 11: "4242" }).x, "4242"), true);
  assert.equal(await onlyWindowsOf(fakeX({ 10: "4242", 11: "999" }).x, "4242"), false, "another program's window");
  assert.equal(await onlyWindowsOf(fakeX({}).x, "4242"), false, "no window at all");
  const noPid = fakeX({ 10: "4242" });
  noPid.x.run = async (args) => (args[0] === "getwindowpid" && args[1] === "12" ? Promise.reject(new Error("no pid")) : args[0] === "search" && !args.includes("--maxdepth") ? "1\n10\n12\n" : fakeX({ 10: "4242" }).x.run(args));
  assert.equal(await onlyWindowsOf(noPid.x, "4242"), false, "a window with no pid is not the Chrome's");
});

test("behind agent mode's endpoint (agentwatch's private Xvfb): own, with xdotool on this process's DISPLAY; a test's own answer comes first, with its log line each time", async () => {
  const saved = process.env.DISPLAY;
  try {
    process.env.DISPLAY = ":4194";
    let env: Record<string, string> | undefined;
    const info = await displayOf(settings(), false, { runner: (e) => { env = e; return { display: e.DISPLAY, run: async () => "" }; } });
    assert.equal(info.own, true);
    assert.deepEqual([info.x?.display, env?.DISPLAY], [":4194", ":4194"]);
    assert.equal((await displayOf(settings({ display: { xdotool: false } }), false, { runner: () => { throw new Error("no runner"); } })).x, undefined, "xdotool: false");
    delete process.env.DISPLAY;
    assert.deepEqual(await displayOf(settings(), false, { runner: () => { throw new Error("no runner"); } }), { own: true, x: undefined }, "no DISPLAY: own, with no xdotool");
  } finally { if (saved === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = saved; }
  assert.equal((await displayOf(settings({ display: { own: false } }))).own, false);
  assert.equal((await displayOf(settings({ display: { own: true, chromePid: 7 } }))).chromePid, 7);
  const lines: string[] = [];
  const s = settings({ display: { own: false }, log: (l) => { lines.push(l); } });
  await displayOf(s, true);
  noticeNotOwn(s, { own: false, why: "the test says so" });
  noticeNotOwn(s, { own: true });
  assert.deepEqual(lines.length, 2, "a test's own answer: the line each time");
  assert.match(lines[0], /^agent-browser: the agent Chrome is not on a display of its own \(the test says so\); agent-browser opens each page as a background tab/);
});
