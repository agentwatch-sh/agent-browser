// Chrome's own copy of a remote scope's download (C11, the remote scope's folder; board ab-v16.94.7.8). Chrome saves each
// download in the agent profile's downloads folder (the unit's Preferences and HOME: the folder `Downloads` of Chrome's
// HOME in the state folder), also a download of a remote scope's page. The model (model.ts, finish) learns that a
// download is complete from the tab's Page.downloadProgress, and it reads Chrome's path from the receiver's
// downloads.search. For a connection of a remote admission it then gives that path here, at the end of its handling of
// the download, and this file removes the file only through its own guard:
//
//   - the downloads folder is a folder of the service's user and no link;
//   - the path is absolute, and its folder after realpath is the downloads folder or a folder in it (after realpath);
//   - the path is no link and a regular file.
//
// The model's own rule (model.ts, removeChromeCopy) comes first: the item is the download's own, no download of
// another scope had the same URL while it ran, and Chrome has no other item of that URL in the download's time. Each
// refusal and each failed removal is a reason with no path, for the model's log line (C11's rule of a removal's line:
// the scope and the error's code, never a path).

import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/** The guard's reasons (log texts with no path). */
export const CHROME_COPY = Object.freeze({
  folderNotOurs: "the downloads folder is a link or no folder of the service's user",
  outside: "outside the downloads folder",
  link: "a link",
  notAFile: "no regular file",
  otherScope: "another scope's download",
  notOwn: "not its own item",
  noItem: "no complete item of its own",
  sameUrl: "another download of the same URL",
  searchFailed: "the search for another download of the same URL failed",
});

export type CopyRemoval = { removed: true } | { removed: false; why: string };

/** The code of an error, for a log line: never its message, which holds the path. */
const codeOf = (e: unknown) => String((e as NodeJS.ErrnoException)?.code ?? "an error with no code");
const no = (why: string): CopyRemoval => ({ removed: false, why });

export class ChromeDownloads {
  /** The agent profile's downloads folder (UnitPaths.downloads). */
  readonly folder: string;
  private readonly uid: number;
  constructor(folder: string, uid = process.getuid?.() ?? -1) { this.folder = resolve(folder); this.uid = uid; }

  /** Remove Chrome's copy at `path` (the item's `filename`) through the guard: `removed`, or why not. */
  remove(path: unknown): CopyRemoval {
    let real: string;
    try {
      const st = lstatSync(this.folder);
      if (!st.isDirectory() || (this.uid >= 0 && st.uid !== this.uid)) return no(CHROME_COPY.folderNotOurs);
      real = realpathSync(this.folder);
    } catch (e) { return no(codeOf(e)); }
    if (typeof path !== "string" || !isAbsolute(path)) return no(CHROME_COPY.outside);
    let dir: string;
    try { dir = realpathSync(dirname(path)); } catch (e) { return no(codeOf(e)); }
    if (dir !== real && !dir.startsWith(real + sep)) return no(CHROME_COPY.outside);
    // The file by its folder's real path: a link in the path's folders is already resolved and checked above.
    const name = basename(path);
    if (name === "" || name === "." || name === "..") return no(CHROME_COPY.notAFile);
    const file = join(dir, name);
    let st;
    try { st = lstatSync(file); } catch (e) { return no(codeOf(e)); }
    if (st.isSymbolicLink()) return no(CHROME_COPY.link);
    if (!st.isFile()) return no(CHROME_COPY.notAFile);
    try { unlinkSync(file); return { removed: true }; } catch (e) { return no(codeOf(e)); }
  }
}
