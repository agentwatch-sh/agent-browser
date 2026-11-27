// The act window outside the screen (contract C11, the sign-in act; the stored sign-ins design, section 7.3; board
// ab-v16.97.4). The receiver cannot place a window outside the screen (`windows.update` keeps half of it on the screen,
// and it refuses an act window and an act popup's window), and chrome.debugger has no Browser.setWindowBounds. The
// service runs Xvfb and holds its X authority, so it moves the act window at the X level, to the right of the screen's
// area, as `xdotool windowmove` did in the design's round 1. It finds the act window, and the window of each act
// popup, by a title marker that the act gives that tab's page (review-124 B4: never by the bounds of a window). PageFetch's
// fetch window moves the same way, by its own marker (aw-fetch-). The X world is the Chrome unit's own Xvfb only (as the pointer's ops, link/pointer-ops.ts): an absolute
// xdotool, an environment of only DISPLAY and XAUTHORITY, no shell, and arguments that are numbers or the marker
// (16 hex digits): never a value of a page or of the store.
//
// The Mac (board ab-v16.97.15; the Mac design note docs/superpowers/specs/2026-11-26-stored-sign-ins-mac-design.md,
// section 4.4, option f; the operator's answer on board item ab-58h): the service has no X there, and the probe's Mac run
// (2026-11-27) found that a window that the receiver opens minimized comes up normal. So on the Mac the act window is a
// normal window with `focused: false` and no place, as on Linux, and it stays on the screen for the act's seconds:
// macScreen moves nothing, and the act reads no place.

import { spawn } from "node:child_process";
import type { XDisplay } from "../link/pointer-ops.ts";
import type { ActScreen } from "./act.ts";

/** How far to the right of the screen the act's windows go (px). */
export const OFF_SCREEN_GAP = 200;
const X_CALL_MS = 2_000;
/** The act's marker and PageFetch's (its fetch window, C11: "as the act window"; the first live run, board ab-v16.102). */
const MARKER = /^aw-(?:act|fetch)-[0-9a-f]{16}$/;

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

/** The Mac's act screen (the head of this file): the act window and an act popup's window stay on the screen; nothing moves. */
export function macScreen(): ActScreen {
  return { onScreen: true, size: () => null, moveOff: async () => 0 };
}

/** The act's screen of this system: the Mac's (no move), else the X screen of the unit's Xvfb (`x`). */
export function actScreen(darwin: boolean, x: Parameters<typeof xScreen>[0]): ActScreen {
  return darwin ? macScreen() : xScreen(x);
}
