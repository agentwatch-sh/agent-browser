// The act window outside the screen (contract C11, the sign-in act; the stored sign-ins design, section 7.3; board
// ab-v16.97.4). The receiver cannot place a window outside the screen (`windows.update` keeps half of it on the screen,
// and it refuses an act window and an act popup's window), and chrome.debugger has no Browser.setWindowBounds. The
// service runs Xvfb and holds its X authority, so it moves the act window at the X level, to the right of the screen's
// area, as `xdotool windowmove` did in the design's round 1. It finds the act window by a title marker that the act
// gives its about:blank page, and an act popup's window by its bounds among the X windows that were not there before
// the act. The X world is the Chrome unit's own Xvfb only (as the pointer's ops, link/pointer-ops.ts): an absolute
// xdotool, an environment of only DISPLAY and XAUTHORITY, no shell, and arguments that are numbers or the marker
// (16 hex digits): never a value of a page or of the store.

import { spawn } from "node:child_process";
import type { XDisplay } from "../link/pointer-ops.ts";
import type { ActScreen } from "./act.ts";

/** How far to the right of the screen the act's windows go (px). */
export const OFF_SCREEN_GAP = 200;
const X_CALL_MS = 2_000;
const MARKER = /^aw-act-[0-9a-f]{16}$/;

type Run = (args: string[]) => Promise<{ code: number | null; out: string }>;

/** One xdotool call on the display, with only DISPLAY and XAUTHORITY, killed after 2 s. */
function runner(xdotool: string, d: XDisplay): Run {
  return (args) => new Promise((resolve) => {
    let out = "";
    let child;
    try { child = spawn(xdotool, args, { env: { DISPLAY: d.display, XAUTHORITY: d.xauth }, stdio: ["ignore", "pipe", "ignore"] }); }
    catch { resolve({ code: -1, out: "" }); return; }
    child.stdout!.on("data", (b) => (out += b));
    const timer = setTimeout(() => child.kill("SIGKILL"), X_CALL_MS);
    child.once("error", () => { clearTimeout(timer); resolve({ code: -1, out }); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

const ids = (out: string) => out.split("\n").map((l) => l.trim()).filter((l) => /^\d+$/.test(l));

/** getwindowgeometry's `Position: X,Y (screen: 0)` and `Geometry: WxH`, or null. */
export function geometryOf(out: string): { left: number; top: number; width: number; height: number } | null {
  const p = /Position:\s*(-?\d+),(-?\d+)/.exec(out), g = /Geometry:\s*(\d+)x(\d+)/.exec(out);
  return p && g ? { left: Number(p[1]), top: Number(p[2]), width: Number(g[1]), height: Number(g[2]) } : null;
}

/**
 * The act's X screen on the display that `display()` gives at each call (null: no Xvfb runs, so no move). `run` is a
 * test's runner in place of xdotool.
 */
export function xScreen(o: { display: () => XDisplay | null; xdotool: string | null; run?: (d: XDisplay) => Run }): ActScreen {
  let known = new Set<string>();
  const runOn = (): { d: XDisplay; run: Run } | null => {
    const d = o.display();
    if (!d || (!o.run && !o.xdotool)) return null;
    return { d, run: o.run ? o.run(d) : runner(o.xdotool!, d) };
  };
  const visible = async (run: Run) => ids((await run(["search", "--onlyvisible", "--name", ".*"])).out);
  return {
    size: () => o.display()?.size ?? null,
    snapshot: async () => {
      const x = runOn();
      known = x ? new Set(await visible(x.run)) : new Set();
    },
    moveOff: async (marker) => {
      const x = runOn();
      if (!x || !MARKER.test(marker)) return 0;
      const found = ids((await x.run(["search", "--name", marker])).out);
      let n = 0;
      for (const id of found) if ((await x.run(["windowmove", id, String(x.d.size.width + OFF_SCREEN_GAP), "0"])).code === 0) { n++; known.add(id); }
      return n;
    },
    movePopup: async (b) => {
      const x = runOn();
      if (!x) return 0;
      let n = 0;
      for (const id of await visible(x.run)) {
        if (known.has(id)) continue;
        const g = geometryOf((await x.run(["getwindowgeometry", id])).out);
        if (!g || g.left !== b.left || g.top !== b.top || g.width !== b.width || g.height !== b.height) continue;
        if ((await x.run(["windowmove", id, String(x.d.size.width + OFF_SCREEN_GAP), "0"])).code === 0) n++;
      }
      return n;
    },
  };
}
