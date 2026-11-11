// The live test's stand-in daemon's two pointer ops (board ab-v16.71; contract C10 "The daemon's own ops"): the same
// ops as `agent-browser service` (src/service/link/pointer-ops.ts), on the harness's own private Xvfb only
// (xdotoolWorld refuses :0 and :90). test/pointer-daemon.test.ts gives the ops the worlds of the contract's vectors.

import { xWorld } from "../../../src/service/link/pointer-ops.ts";

export { parseLocation, PointerOps, scriptOf, type Played, type PlayEnd, type XWorld } from "../../../src/service/link/pointer-ops.ts";

/** The X world of the harness's own private Xvfb: an absolute xdotool, an environment of only DISPLAY and XAUTHORITY of that Xvfb. */
export function xdotoolWorld(o: { display: string; xauth: string; size: { width: number; height: number }; xdotool?: string }) {
  if (!/^:\d+$/.test(o.display) || o.display === ":0" || o.display === ":90") throw new Error(`the stand-in daemon's xdotool runs only on the harness's own Xvfb, not ${o.display}`);
  const d = { display: o.display, xauth: o.xauth, size: o.size };
  return xWorld({ display: () => d, xdotool: o.xdotool ?? "/usr/bin/xdotool" });
}
