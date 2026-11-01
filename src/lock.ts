// A lock file that the processes of one consumer share: the proxy's start lock (proxy.ts), and the
// lock of the tab record, tabs.json and tab-scopes.json (browser.ts). One holder at a time.

import { closeSync, fstatSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

/**
 * Run `fn` while this process holds the lock file at `path`: the file is created exclusively and
 * holds this process's pid. Another holder is waited for until `deadline` (epoch ms), then the
 * error names `what`. A crashed holder's lock (its pid is gone, or no pid was written within 5 s)
 * is cleared; a live holder's lock is never cleared. The lock is removed only if it is still ours.
 */
export async function withFileLock<T>(path: string, deadline: number, fn: () => Promise<T>, what = "lock"): Promise<T> {
  let fd: number | undefined;
  while (Date.now() < deadline) {
    try {
      fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // A crashed launcher can leave a lock. Never clear a live owner's lock.
      let owner = 0;
      try { owner = Number(readFileSync(path, "utf8")); } catch { /* being written */ }
      if (owner > 0) {
        try { process.kill(owner, 0); } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ESRCH") rmSync(path, { force: true });
        }
      } else {
        try { if (Date.now() - statSync(path).mtimeMs > 5_000) rmSync(path, { force: true }); } catch { /* another caller removed it */ }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (fd === undefined) throw new Error(`${what} timed out: ${path}`);
  try { return await fn(); }
  finally {
    const owned = statSync(path, { throwIfNoEntry: false });
    const mine = fstatSync(fd);
    if (owned && mine && owned.dev === mine.dev && owned.ino === mine.ino) rmSync(path, { force: true });
    closeSync(fd);
  }
}
