// The X player (board ab-t30.3; the input design, section 11.1): a plan on the X display, as real X input (XTEST). One
// point is one `xdotool mousemove`; a path is one `xdotool -` script, so each step's time is xdotool's own `sleep`, not a
// process start (20 to 26 ms each: the agent pointer design's measurement). Real X input stays only for the X pointer
// (the activation path of C10 and C11, and agent-browser's last step of a path): every other event is CDP input.

import type { Pt, Sample } from "./path.ts";

/** Run xdotool with these arguments (and this standard input), on the agent browser's own display only. */
export type XRun = (args: string[], input?: string) => Promise<string>;

/** The lines of one `xdotool -` script for a plan: a sleep to each sample's time (times `scale`), then the move there on the screen. */
export function xScript(samples: readonly Sample[], toScreen: (p: Pt) => Pt, scale = 1): string {
  const lines: string[] = [];
  let t = 0;
  for (const s of samples) {
    const at = s.t * scale, p = toScreen(s);
    if (at > t) lines.push(`sleep ${((at - t) / 1000).toFixed(3)}`);
    lines.push(`mousemove ${Math.round(p.x)} ${Math.round(p.y)}`);
    t = Math.max(t, at);
  }
  return lines.join("\n") + "\n";
}

/** Play a plan on the X display: one point as one move, more as one script. */
export async function playX(run: XRun, samples: readonly Sample[], toScreen: (p: Pt) => Pt, scale = 1): Promise<void> {
  if (!samples.length) return;
  if (samples.length === 1) {
    const p = toScreen(samples[0]);
    await run(["mousemove", String(Math.round(p.x)), String(Math.round(p.y))]);
    return;
  }
  await run(["-"], xScript(samples, toScreen, scale));
}
