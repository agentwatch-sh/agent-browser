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
// folder (holds), so no client's call carries a file of another scope.

import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { SCOPE } from "./scopes.ts";
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

  /** Whether a path is in the folder: as it is written, or after its links. */
  holds(path: string): boolean {
    const inside = (p: string, root: string) => p === root || p.startsWith(root + sep);
    if (inside(resolve(path), this.root) || inside(resolve(path), this.real)) return true;
    try { return inside(realpathSync(path), this.real); } catch { return false; }
  }

  /** The end of a scope: its folder is removed, with every file of its calls. */
  async endScope(scope: string): Promise<void> {
    if (SCOPE.test(scope)) await rm(join(this.root, scope), { recursive: true, force: true });
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
