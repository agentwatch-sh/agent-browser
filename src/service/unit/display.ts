// The display of the unit's private Xvfb (the self-contained design, section 5.1, the row "Xvfb and its auth file";
// board ab-v16.94.3). The unit takes the first free display from 90 to 189. A display is in use when its socket or its
// lock file exists (<x root>/.X11-unix/X<n>, <x root>/.X<n>-lock, as agentwatch's unit checks today), or when an X
// server holds its abstract socket (@/tmp/.X11-unix/X<n> in /proc/net/unix), which a server can hold with no file.

import { lstatSync } from "node:fs";
import { join } from "node:path";

export const DISPLAY_FIRST = 90;
export const DISPLAY_LAST = 189;

/** What the chooser reads: whether a path exists (no link followed), and /proc/net/unix. A test gives fakes. */
export type DisplayFs = { exists(path: string): boolean; netUnix(): string };

export const realDisplayFs = (netUnix: () => string): DisplayFs => ({
  exists: (p) => { try { lstatSync(p); return true; } catch { return false; } },
  netUnix,
});

/** The abstract sockets of /proc/net/unix that name an X display: the display numbers. */
export function abstractDisplays(netUnix: string): Set<number> {
  const out = new Set<number>();
  for (const line of netUnix.split("\n")) {
    const at = line.lastIndexOf(" @/tmp/.X11-unix/X");
    if (at < 0) continue;
    const n = line.slice(at + " @/tmp/.X11-unix/X".length).trim();
    if (/^[0-9]{1,5}$/.test(n)) out.add(Number(n));
  }
  return out;
}

/** True when display `n` is in use: its socket, its lock file, or its abstract socket. */
export function displayInUse(n: number, xRoot: string, fs: DisplayFs, abstract: Set<number> = abstractDisplays(fs.netUnix())): boolean {
  return fs.exists(join(xRoot, ".X11-unix", `X${n}`)) || fs.exists(join(xRoot, `.X${n}-lock`)) || abstract.has(n);
}

/** The free displays from `first` to `last`, in order (one read of /proc/net/unix). */
export function freeDisplays(xRoot: string, fs: DisplayFs, first = DISPLAY_FIRST, last = DISPLAY_LAST): number[] {
  const abstract = abstractDisplays(fs.netUnix());
  const out: number[] = [];
  for (let n = first; n <= last; n++) if (!displayInUse(n, xRoot, fs, abstract)) out.push(n);
  return out;
}
