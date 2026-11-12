// The act window outside the screen (contract C11, the sign-in act; the stored sign-ins design, section 7.3; board
// ab-v16.97.4). The receiver cannot place a window outside the screen (`windows.update` keeps half of it on the screen,
// and it refuses an act window and an act popup's window), and chrome.debugger has no Browser.setWindowBounds. The
// service runs Xvfb and holds its X authority, so it moves the act window at the X level, to the right of the screen's
// area, as `xdotool windowmove` did in the design's round 1. It finds the act window, and the window of each act
// popup, by a title marker that the act gives that tab's page (review-124 B4: never by the bounds of a window). The X world is the Chrome unit's own Xvfb only (as the pointer's ops, link/pointer-ops.ts): an absolute
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

/**
 * The act's X screen on the display that `display()` gives at each call (null: no Xvfb runs, so no move). `run` is a
 * test's runner in place of xdotool.
 */
export function xScreen(o: { display: () => XDisplay | null; xdotool: string | null; run?: (d: XDisplay) => Run }): ActScreen {
  const runOn = (): { d: XDisplay; run: Run } | null => {
    const d = o.display();
    if (!d || (!o.run && !o.xdotool)) return null;
    return { d, run: o.run ? o.run(d) : runner(o.xdotool!, d) };
  };
  return {
    size: () => o.display()?.size ?? null,
    moveOff: async (marker) => {
      const x = runOn();
      if (!x || !MARKER.test(marker)) return 0;
      const found = ids((await x.run(["search", "--name", marker])).out);
      let n = 0;
      for (const id of found) if ((await x.run(["windowmove", id, String(x.d.size.width + OFF_SCREEN_GAP), "0"])).code === 0) n++;
      return n;
    },
  };
}
