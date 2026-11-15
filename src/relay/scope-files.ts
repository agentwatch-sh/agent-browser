// The scopes' own folders of the input stage's files (C11, files; board ab-t30.12.2). The operator's answer Q3 a (design
// section 15): "files from buffers get a click on the input, and the service writes them to the scope's own folder for the
// file chooser". Playwright's setInputFiles with buffers sends the files' bytes in its set files call; the stage writes
// them here and gives the input their paths after its click (src/relay/stage.ts, filesStep).
//
// The rules: the folder is <parent>/scope-files, where the parent is the service's state folder (beside Chrome's HOME and
// its downloads), or the live rows' run folder (the relay's door, STAGE_FILES_ENV). The service's start removes it with
// every file of an earlier run and makes it again (mode 0700). Each scope has one folder in it (its name is the scope's,
// mode 0700), and each call a new folder in the scope's (mkdtemp, mode 0700), with each file under its own name (mode
// 0600, never over a file that is there). A scope's end removes the scope's folder. The stage writes a call's files only
// into the folder of its tab's scope, and the model refuses a client's DOM.setFileInputFiles that names a path in this
// folder, the folder itself or a folder that holds it (holds; board ab-t30.27: Chrome lists a folder's files on a folder
// input or a drop), so no client's call carries a file of another scope. In the service the model also refuses each such
// path of the state folder (StateFolder): the agent profile is there.

import { realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { SCOPE } from "./scopes.ts";
import { realOf } from "../service/unit/paths.ts";
import { STAGE_TEST_ENV, type StageFile, type StageFiles } from "./stage.ts";

/** The name of the stage's files folder in its parent folder. */
export const SCOPE_FILES = "scope-files";
/** The live rows' door to the stage's files (cli.ts): an absolute folder of the run, with the stage's test value only. */
export const STAGE_FILES_ENV = "AGENT_BROWSER_STAGE_FILES";

export class ScopeFiles implements StageFiles {
  /** The folder, and its real path (a link in the parent's path resolved). */
  readonly root: string;
  private readonly real: string;
  /**
   * The Mac (APFS ignores case, so `S1`'s folder is `s1`'s; board ab-v16.94.26, review-159b N2): the scopes that wrote
   * since their end, and the removals that still run. A write waits for each removal of a case twin; a removal spares a
   * folder that a case twin wrote into. On Linux both stay empty.
   */
  private readonly foldCase: boolean;
  private readonly wrote = new Set<string>();
  private readonly removals = new Set<{ scope: string; done: Promise<void> }>();
  private constructor(root: string, foldCase: boolean) { this.root = root; this.real = realpathSync(root); this.foldCase = foldCase; }

  /** The folder at the start: <parent>/scope-files, removed with every file of an earlier run, then made again (mode 0700). `foldCase`: the Mac. */
  static async open(parent: string, foldCase = false): Promise<ScopeFiles> {
    const root = join(resolve(parent), SCOPE_FILES);
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { mode: 0o700 });
    return new ScopeFiles(root, foldCase);
  }

  /** A start with the stage off (review-135b N4): <parent>/scope-files is removed with every file of an earlier run, and not made again. */
  static async clear(parent: string): Promise<void> {
    await rm(join(resolve(parent), SCOPE_FILES), { recursive: true, force: true });
  }

  /** One call's files in a new folder of the scope's folder: their paths, in order. The names are safe (stage.ts, safeNames). */
  async write(scope: string, files: readonly StageFile[]): Promise<string[]> {
    if (!SCOPE.test(scope)) throw Object.assign(new Error("not a scope's name"), { code: "ESCOPE" });
    // On the Mac a case twin's removal that still runs ends first: its folder is this scope's (review-159b N2).
    for (let twins = this.twinRemovals(scope); twins.length; twins = this.twinRemovals(scope)) await Promise.allSettled(twins);
    if (this.foldCase) this.wrote.add(scope);
    const dir = join(this.root, scope);
    await mkdir(dir, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
    const call = await mkdtemp(join(dir, "call-"));
    const paths: string[] = [];
    for (const f of files) {
      const p = join(call, f.name);
      await writeFile(p, Buffer.from(f.buffer, "base64"), { mode: 0o600, flag: "wx" });
      // The file's time is the client's (Playwright's lastModifiedMs), as the File that Playwright's own script makes.
      if (f.lastModifiedMs !== undefined) { const t = new Date(f.lastModifiedMs); await utimes(p, t, t); }
      paths.push(p);
    }
    return paths;
  }

  /**
   * Whether a path is in the folder, is the folder, or is a folder that holds it (board ab-t30.27): as it is written, or
   * after the links of it or of its nearest folder that exists.
   */
  holds(path: string): boolean { return this.holdsAny([path]); }
  /** Whether one of a call's paths is such a path (holds), with the folder's side read once for the call (review-157 N2). */
  holdsAny(paths: readonly string[]): boolean { return paths.some(nearTo(this.root, this.real)); }

  /**
   * The end of a scope: its folder is removed, with every file of its calls. On the Mac a folder that a case twin wrote
   * into since its own end stays (it is the twin's too), and the twin's next write waits for the removal (review-159b N2).
   */
  async endScope(scope: string): Promise<void> {
    if (!SCOPE.test(scope)) return;
    if (!this.foldCase) { await rm(join(this.root, scope), { recursive: true, force: true }); return; }
    this.wrote.delete(scope);
    if ([...this.wrote].some((n) => n.toLowerCase() === scope.toLowerCase())) return;
    const r = { scope, done: rm(join(this.root, scope), { recursive: true, force: true }) };
    this.removals.add(r);
    try { await r.done; } finally { this.removals.delete(r); }
  }

  /** The removals that still run of the other names with the lower case of `scope` (none on Linux). */
  private twinRemovals(scope: string): Promise<void>[] {
    return [...this.removals].filter((r) => r.scope !== scope && r.scope.toLowerCase() === scope.toLowerCase()).map((r) => r.done);
  }
}

/**
 * The file system's reads of the compare (a seam for the tests' fakes): `id`, a path's device and inode after its links,
 * or null when it has none (it does not exist, or the service cannot reach it); `realpath`, a path's real path after its
 * links (it throws when the path does not exist).
 */
export type FileLook = { id(path: string): string | null; realpath(path: string): string };
/** The service's file system. */
export const FS_LOOK: FileLook = {
  id: (p) => { try { const s = statSync(p, { bigint: true }); return `${s.dev}:${s.ino}`; } catch { return null; } },
  realpath: (p) => realpathSync(p),
};
/** The Mac's data volume: /Users, /private and the other firmlinks name the same folders in it (/System/Volumes/Data/Users). */
const DATA_VOLUME = "/System/Volumes/Data";

/** A path and each folder above it, up to `/`. */
function upward(path: string): string[] {
  const out = [resolve(path)];
  for (let up = dirname(out[0]); up !== out[out.length - 1]; up = dirname(up)) out.push(up);
  return out;
}

/**
 * Whether `path` is in the folder `root` (its real path `real`), is that folder, or is a folder that holds it, as written
 * or after the links of it or of its nearest folder that exists (C11, files; board ab-t30.27). A folder that holds it counts
 * because Chrome lists a folder's files, with its subfolders, on a folder input or a drop. The compare is of the text, and
 * also of device and inode (board ab-v16.94.22, review-155 N1, review-153b N1), so that another form of the folder or of a
 * folder above it counts too (review-157 N1: not of a folder inside it; a /.vol form is systemPath's): on the Mac a change
 * of case or of Unicode normalization (APFS ignores both by default), the data volume's form or a firmlink, and on Linux a
 * bind mount. The path is in the folder, or is it, when the folder's device and inode are those of the path or of a folder
 * above it, as written or after links (a part that does not exist: its nearest folder that exists); it holds the folder
 * when its device and inode are those of a folder above the folder (as the service names it, after links, or in the data
 * volume's form). So a missing path counts by its nearest folder that exists: Chrome makes no file through a file input,
 * so a missing file gives no file.
 */
export function nearFolder(path: string, root: string, real: string, look: FileLook = FS_LOOK): boolean {
  return nearTo(root, real, look)(path);
}

/**
 * The compare of nearFolder for the paths of one call (review-157 N2): the folder's side (its device and inode, and those
 * of each folder above it in each of its forms) is read once, at the first path that needs it, not once for each path.
 */
export function nearTo(root: string, real: string, look: FileLook = FS_LOOK): (path: string) => boolean {
  const near = (p: string, f: string) => p === f || p.startsWith(f + sep) || f.startsWith(p.endsWith(sep) ? p : p + sep);
  let folder: string | null | undefined, above: Set<string | null> | undefined;
  return (path) => {
    const written = resolve(path), linked = realOf(path, (p) => look.realpath(p));
    if (near(written, root) || near(written, real) || near(linked, root) || near(linked, real)) return true;
    if (folder === undefined) folder = look.id(real);
    if (folder === null) return false;
    if ([...new Set([...upward(written), ...upward(linked)])].some((p) => look.id(p) === folder)) return true;
    const own = look.id(written);
    if (own === null) return false;
    if (above === undefined) {
      const forms = [root, real, ...(look.id(DATA_VOLUME + real) === folder ? [DATA_VOLUME + real] : [])];
      above = new Set([...new Set(forms.flatMap(upward))].map((p) => look.id(p)));
    }
    return above.has(own);
  };
}

/**
 * Whether a path is in /proc, /dev, /sys or /.vol, or is one of them, as written or after its links (C11, files; review-153b
 * B1, board ab-t30.29, review-157 N1). Chrome opens a client's path in its own process, where /proc/self, /proc/thread-self
 * and /dev/fd name Chrome's own open files (the profile's Cookies and Login Data too), while the model reads the path in the
 * service's process. On the Mac /.vol/<device>/<inode>/... names a file by the device and inode of a file or folder inside
 * the state folder (the profile, for example), which nearFolder's walk does not compare. Case does not count (the Mac).
 */
export function systemPath(path: string, realpath: (p: string) => string = realpathSync): boolean {
  const system = /^\/(proc|dev|sys|\.vol)(\/|$)/i;
  return system.test(resolve(path)) || system.test(realOf(path, realpath));
}

/**
 * The service's state folder as a guard of the clients' file paths (C11, files; board ab-t30.27, review-153 B1 and N1): it
 * holds the agent profile (its cookies and saved passwords) and the stage's files, and the receiver has access to local
 * files, so the model refuses a path in it, the folder itself and each folder that holds it. One part is the scope's own:
 * a path whose real path is inside the scope's MCP folder, `<state>/mcp/<scope>/` (the MCP's Playwright sends a folder of
 * it as its path), for a tab of that scope, while that folder and `<state>/mcp` are no links. That part compares the real
 * path's text (board ab-v16.94.22): it lets a path pass, so another form of the folder (on the Mac a change of case or the
 * data volume's form) gets the refusal, and the MCP sends the service's own form. A path in /proc, /dev, /sys or /.vol
 * counts as the folder's (systemPath): there Chrome reads its own open files of the folder, or a file by its inode. `look`:
 * the file system (nearFolder).
 */
export class StateFolder {
  readonly root: string;
  private readonly real: string;
  private readonly look: FileLook;
  constructor(folder: string, look: FileLook = FS_LOOK) { this.look = look; this.root = resolve(folder); this.real = realOf(this.root, (p) => look.realpath(p)); }
  covers(path: string, scope: string | null = null): boolean { return this.coversAny([path], scope); }
  /** Whether one of a call's paths is covered (covers), with the folder's side read once for the call (review-157 N2). */
  coversAny(paths: readonly string[], scope: string | null = null): boolean {
    const realpath = (p: string) => this.look.realpath(p);
    const near = nearTo(this.root, this.real, this.look);
    // The scope's own MCP folder, while it and <state>/mcp are no links: a path inside it passes.
    const own = scope !== null && SCOPE.test(scope) ? join(this.real, "mcp", scope) : null;
    const mine = own !== null && realOf(join(this.root, "mcp", scope!), realpath) === own;
    return paths.some((path) => systemPath(path, realpath) || (near(path) && !(mine && realOf(path, realpath).startsWith(own + sep))));
  }
}

/** The live rows' door (cli.ts, the relay): STAGE_FILES_ENV names an absolute folder of the run, with the stage's test value only. */
export async function relayTestFiles(env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<ScopeFiles | null> {
  const v = env[STAGE_FILES_ENV];
  if (env[STAGE_TEST_ENV] !== "test" || !v) return null;
  if (!isAbsolute(v)) { log(`relay: ${STAGE_FILES_ENV} is ignored: it must be an absolute folder of the run`); return null; }
  log("relay: the input stage's files are in the run's folder (the live rows' door)");
  return ScopeFiles.open(v);
}
