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

import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
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
  private constructor(root: string) { this.root = root; this.real = realpathSync(root); }

  /** The folder at the start: <parent>/scope-files, removed with every file of an earlier run, then made again (mode 0700). */
  static async open(parent: string): Promise<ScopeFiles> {
    const root = join(resolve(parent), SCOPE_FILES);
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { mode: 0o700 });
    return new ScopeFiles(root);
  }

  /** A start with the stage off (review-135b N4): <parent>/scope-files is removed with every file of an earlier run, and not made again. */
  static async clear(parent: string): Promise<void> {
    await rm(join(resolve(parent), SCOPE_FILES), { recursive: true, force: true });
  }

  /** One call's files in a new folder of the scope's folder: their paths, in order. The names are safe (stage.ts, safeNames). */
  async write(scope: string, files: readonly StageFile[]): Promise<string[]> {
    if (!SCOPE.test(scope)) throw Object.assign(new Error("not a scope's name"), { code: "ESCOPE" });
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
  holds(path: string): boolean { return nearFolder(path, this.root, this.real); }

  /** The end of a scope: its folder is removed, with every file of its calls. */
  async endScope(scope: string): Promise<void> {
    if (SCOPE.test(scope)) await rm(join(this.root, scope), { recursive: true, force: true });
  }
}

/**
 * Whether `path` is in the folder `root` (its real path `real`), is that folder, or is a folder that holds it, as written
 * or after the links of it or of its nearest folder that exists (C11, files; board ab-t30.27). A folder that holds it counts
 * because Chrome lists a folder's files, with its subfolders, on a folder input or a drop. `fold`: the compare ignores case,
 * on the Mac (review-153b N1: APFS ignores case by default, and realpath keeps the case as written).
 */
export function nearFolder(path: string, root: string, real: string, fold = process.platform === "darwin"): boolean {
  const near = (p: string, f: string) => {
    if (fold) { p = p.toLowerCase(); f = f.toLowerCase(); }
    return p === f || p.startsWith(f + sep) || f.startsWith(p.endsWith(sep) ? p : p + sep);
  };
  const written = resolve(path), linked = realOf(path);
  return near(written, root) || near(written, real) || near(linked, root) || near(linked, real);
}

/**
 * Whether a path is in /proc, /dev or /sys, or is one of them, as written or after its links (C11, files; review-153b B1,
 * board ab-t30.29). Chrome opens a client's path in its own process, where /proc/self, /proc/thread-self and /dev/fd name
 * Chrome's own open files (the profile's Cookies and Login Data too), while the model reads the path in the service's
 * process. Case does not count (the Mac).
 */
export function systemPath(path: string): boolean {
  const system = /^\/(proc|dev|sys)(\/|$)/i;
  return system.test(resolve(path)) || system.test(realOf(path));
}

/**
 * The service's state folder as a guard of the clients' file paths (C11, files; board ab-t30.27, review-153 B1 and N1): it
 * holds the agent profile (its cookies and saved passwords) and the stage's files, and the receiver has access to local
 * files, so the model refuses a path in it, the folder itself and each folder that holds it. One part is the scope's own:
 * a path whose real path is inside the scope's MCP folder, `<state>/mcp/<scope>/` (the MCP's Playwright sends a folder of
 * it as its path), for a tab of that scope, while that folder and `<state>/mcp` are no links. A path in /proc, /dev or /sys
 * counts as the folder's (systemPath): there Chrome reads its own open files of the folder.
 */
export class StateFolder {
  readonly root: string;
  private readonly real: string;
  constructor(folder: string) { this.root = resolve(folder); this.real = realOf(this.root); }
  covers(path: string, scope: string | null = null): boolean {
    if (systemPath(path)) return true;
    if (!nearFolder(path, this.root, this.real)) return false;
    if (scope === null || !SCOPE.test(scope)) return true;
    const own = join(this.real, "mcp", scope);
    return realOf(join(this.root, "mcp", scope)) !== own || !realOf(path).startsWith(own + sep);
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
