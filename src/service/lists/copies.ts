// The list copy of each scope for agent-browser's CLI (stage 1c, board ab-v16.94.4; the design, section 5.1): the
// port of agentwatch's commands/browser.py `_write_session_list` and daemon/browser/service.py `_remove_session_list`.
// The copy is `<state>/session-lists/<scope>/allowlist.json`, `{"allow":[<host>...]}`, the list's normalized hosts
// only (agent-browser refuses a whole --allowlist file for one bad entry). The service writes it at each list change
// (it owns the state folder) and removes it at the scope's end.
//
// No write and no removal goes through a symbolic link: a link at `session-lists`, at the scope's folder or at the
// file stays as it is, and the act logs that it did not run. A log line names the scope, never a host.

import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SCOPE } from "./hosts.ts";
import { errorKind, privateDir, writeJson } from "./files.ts";

export class ListCopies {
  /** `<state>/session-lists`. */
  readonly root: string;
  private readonly log: (line: string) => void;

  constructor(stateFolder: string, log: (line: string) => void) {
    this.root = join(stateFolder, "session-lists");
    this.log = log;
  }

  path(scope: string): string { return join(this.root, scope, "allowlist.json"); }

  /** True when `p` is a symbolic link (a missing path is none). */
  private static link(p: string): boolean {
    try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
  }

  /** Write the copy of `scope` with `hosts`: mode 0600 (a new file, then a rename), in folders of mode 0700; false when it did not. */
  write(scope: string, hosts: readonly string[]): boolean {
    if (!SCOPE.test(scope)) return false;
    const file = this.path(scope);
    const folder = join(this.root, scope);
    for (const p of [this.root, folder, file]) {
      if (ListCopies.link(p)) { this.log(`lists: the list copy of session ${scope} is not written: a symbolic link is in its path`); return false; }
      if (p !== file) {
        try { privateDir(p); } catch (e) { this.log(`lists: the list copy of session ${scope} is not written (${errorKind(e)})`); return false; }
      }
    }
    try { writeJson(file, { allow: [...hosts] }); return true; }
    catch (e) { this.log(`lists: the list copy of session ${scope} is not written (${errorKind(e)})`); return false; }
  }

  /**
   * Remove the folder of the copy of `scope` and nothing else. A name that is no scope names no folder. `session-lists`
   * and the folder are read with lstat first: a link at either, or a path that is not a folder, stays.
   */
  remove(scope: string): void {
    if (typeof scope !== "string" || !SCOPE.test(scope)) return;
    const folder = join(this.root, scope);
    let rootLink: boolean, folderStat;
    try {
      const r = lstatSync(this.root);
      rootLink = !r.isDirectory();
      if (rootLink) { this.log(`lists: the folder of the list copies is not a folder; the copy of session ${scope} stays`); return; }
      folderStat = lstatSync(folder);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.log(`lists: the copy of the list of session ${scope} cannot be read (${errorKind(e)})`);
      return;
    }
    if (!folderStat.isDirectory()) { this.log(`lists: the copy of the list of session ${scope} is not a folder; it stays`); return; }
    try { rmSync(folder, { recursive: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.log(`lists: the copy of the list of session ${scope} is not removed (${errorKind(e)})`); }
  }
}
