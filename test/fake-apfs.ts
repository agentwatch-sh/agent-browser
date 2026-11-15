// A fake of the Mac's file system for the tests on Linux (board ab-v16.94.26, review-159b N2): APFS ignores case, so under
// `root` a name finds the entry that is the same in lower case (`<root>/S1` is the folder `<root>/s1` when that one is
// there, and a mkdir of `<root>/S1` then gets EEXIST). The fake changes node:fs and node:fs/promises in place
// (syncBuiltinESMExports), so the code under test runs as it is; `restore()` puts them back. `holdRm()` holds each
// removal of node:fs/promises under `root` until its release (a removal that still runs). With `caseless` false the
// names keep their case (Linux), and only the hold applies.

import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, join, relative, sep } from "node:path";

const SYNC = ["existsSync", "lstatSync", "mkdirSync", "readdirSync", "readFileSync", "rmSync", "statSync", "writeFileSync"];
const ASYNC = ["mkdir", "mkdtemp", "readdir", "rm", "utimes", "writeFile"];
type Fn = (...a: unknown[]) => unknown;

export function fakeApfs(root: string, o: { caseless?: boolean } = {}): { restore(): void; holdRm(): () => void } {
  const caseless = o.caseless ?? true;
  const readdir = fs.readdirSync;
  const under = (p: unknown): p is string => typeof p === "string" && isAbsolute(p) && relative(root, p) !== "" && !relative(root, p).startsWith("..");
  /** The path as APFS finds it: each name under `root` becomes the entry of its folder that is the same in lower case. */
  const fold = (p: unknown): unknown => {
    if (!caseless || !under(p)) return p;
    let at = root;
    for (const name of relative(root, p).split(sep)) {
      let hit: string | undefined;
      try { hit = readdir(at).find((n) => n.toLowerCase() === name.toLowerCase()); } catch {}
      at = join(at, hit ?? name);
    }
    return at;
  };
  let gate: Promise<void> | null = null;
  const saved: [Record<string, unknown>, Record<string, unknown>][] = [];
  for (const [mod, names] of [[fs, SYNC], [fsp, ASYNC]] as [Record<string, unknown>, string[]][]) {
    const old: Record<string, unknown> = {};
    for (const n of names) {
      const f = (old[n] = mod[n]) as Fn;
      mod[n] = mod === fsp
        ? async (p: unknown, ...rest: unknown[]) => { if (n === "rm" && gate !== null && under(p)) await gate; return f(fold(p), ...rest); }
        : (p: unknown, ...rest: unknown[]) => f(fold(p), ...rest);
    }
    saved.push([mod, old]);
  }
  syncBuiltinESMExports();
  return {
    restore() { for (const [mod, old] of saved) Object.assign(mod, old); syncBuiltinESMExports(); },
    holdRm() {
      let go!: () => void;
      gate = new Promise<void>((r) => { go = r; });
      return () => { gate = null; go(); };
    },
  };
}
