// A lock file that the processes of one consumer share: the proxy's start lock (proxy.ts), the lock of the tab
// record, tabs.json and tab-scopes.json (browser.ts), and the input lock (input.ts). One holder at a time.

import { closeSync, fstatSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

/**
 * Clear the lock at `path` when its holder crashed: its pid is gone, or no pid was written within 5 s. A live
 * holder's lock is never cleared. True when it removed the lock.
 */
function clearCrashed(path: string): boolean {
  let owner = 0;
  try { owner = Number(readFileSync(path, "utf8")); } catch { return false; /* gone, or being written */ }
  if (owner > 0) {
    try { process.kill(owner, 0); } catch (err) {
      // A known gap: two waiters can both read the same dead pid. If the first one clears the lock
      // and takes it before the second one's rmSync, the second one removes the first one's live
      // lock and takes its own, and for that one change two holders run at the same time. It needs
      // a crashed holder and two waiters in the same few milliseconds; the README's limits say so.
      if ((err as NodeJS.ErrnoException).code === "ESRCH") { rmSync(path, { force: true }); return true; }
    }
    return false;
  }
  try {
    if (Date.now() - statSync(path).mtimeMs > 5_000) { rmSync(path, { force: true }); return true; }
  } catch { /* another caller removed it */ }
  return false;
}

/**
 * Run `fn` while this process holds the lock file at `path`: the file is created exclusively and
 * holds this process's pid. Another holder is waited for until `deadline` (epoch ms), then the
 * error names `what`; a free lock is taken also when the deadline has passed (one try). A crashed
 * holder's lock (clearCrashed) is cleared and taken in the same try, also in the try after the deadline
 * (review-52 note 4); a live holder's lock is never cleared. `signal` ends the wait (not `fn`) with its
 * reason. The lock is removed only if it is still ours.
 */
export async function withFileLock<T>(path: string, deadline: number, fn: () => Promise<T>, what = "lock",
  opts: { signal?: AbortSignal } = {}): Promise<T> {
  const { signal } = opts;
  let fd: number | undefined;
  for (let cleared = 0; ;) {
    signal?.throwIfAborted();
    try {
      fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // A crashed launcher can leave a lock: take it now (at most 3 times in one call, for a lock that keeps coming back).
      if (clearCrashed(path) && cleared++ < 3) continue;
      if (Date.now() >= deadline) break;
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
