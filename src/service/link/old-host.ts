// The end of the old owner's host (stage 1b part 2 of the self-contained agent browser, board ab-v16.94.9; the design,
// section 13.2 "A host retries; the new owner ends the old host", and build note 7 of section 13.5). At its start the
// service writes its own host manifest, then ends every host among its Chrome's children that is not its own shim (the
// daemon's host, or a shim of an earlier agent-browser). The receiver's port then closes, the receiver connects again
// after 1 s, and Chrome reads the new manifest and starts the service's shim. A host never exits by itself.
//
// The one rule of note 7: an old host is a direct child of the recorded Chrome (its pid AND its start time), of this
// user, with no `--type=` in its command line and the receiver's origin `chrome-extension://<receiver ID>/` as an
// argument; the service's own shim (its exact command line) is not one. The service opens a pidfd of it, checks the
// same facts again (so the pidfd names the process that it checked), and sends SIGTERM through the pidfd. It never
// signals a pid without a pidfd, and it never ends another child of Chrome (a renderer, say).

import type { Procs } from "../unit/procs.ts";

/** pidfd_open(2), pidfd_send_signal(2) and close(2), through node:ffi. */
export type Pidfds = { open(pid: number): number; signal(pidfd: number, sig: number): number; close(fd: number): void };
const SIGTERM = 15;

/** Load the pidfd calls from libc (glibc 2.36 and later; Linux only). */
export async function loadPidfds(): Promise<Pidfds | { failed: string }> {
  if (process.platform !== "linux") return { failed: `no pidfd on ${process.platform}` };
  let ffi: any;
  try { const mod: any = await import("node:ffi"); ffi = mod.default ?? mod; }
  catch (e) { return { failed: `node:ffi does not load (${(e as { code?: string }).code ?? (e as Error).message})` }; }
  try {
    const { functions: f } = ffi.dlopen("libc.so.6", {
      pidfd_open: { return: "int32", arguments: ["int32", "uint32"] },
      pidfd_send_signal: { return: "int32", arguments: ["int32", "int32", "pointer", "uint32"] },
      close: { return: "int32", arguments: ["int32"] },
    });
    return { open: (pid) => f.pidfd_open(pid, 0), signal: (fd, sig) => f.pidfd_send_signal(fd, sig, null, 0), close: (fd) => { f.close(fd); } };
  } catch (e) { return { failed: `the pidfd calls do not load: ${(e as Error).message}` }; }
}

export type HostRule = { procs: Procs; chrome: { pid: number; start: number | null }; receiverId: string; own: readonly string[] };

/** True when `argv` is the service's own shim: its exact command line and one argument more (the origin). */
export const isOwnShim = (argv: readonly string[], own: readonly string[]) => argv.length === own.length + 1 && own.every((a, i) => argv[i] === a);

/** The facts of note 7 for `pid`, or null when it is no old host: its start time and its command line. */
function oldHost(r: HostRule, pid: number): { start: number; argv: string } | null {
  const st = r.procs.stat(pid);
  if (!st || st.ppid !== r.chrome.pid || !r.procs.mine(pid)) return null;
  const argv = r.procs.cmdline(pid);
  if (!argv.length || argv.some((a) => a.startsWith("--type=")) || !argv.includes(`chrome-extension://${r.receiverId}/`) || isOwnShim(argv, r.own)) return null;
  return { start: st.start, argv: argv.join("\0") };
}

/** The old hosts of note 7 among the children of the recorded Chrome (none when Chrome's start time is not the recorded one). */
export function findOldHosts(r: HostRule): number[] {
  const c = r.procs.stat(r.chrome.pid);
  if (!c || r.chrome.start === null || c.start !== r.chrome.start) return [];
  return r.procs.pids().filter((pid) => oldHost(r, pid) !== null);
}

/** End each old host through a pidfd (SIGTERM), with the facts checked again after the open; the pids that got it. */
export function endOldHosts(r: HostRule & { pidfds: Pidfds | { failed: string }; log: (line: string) => void }): number[] {
  const found = findOldHosts(r);
  if (!found.length) return [];
  if ("failed" in r.pidfds) { r.log(`link: ${found.length} old host(s) run, but the service cannot end them: ${r.pidfds.failed}`); return []; }
  const ended: number[] = [];
  for (const pid of found) {
    const before = oldHost(r, pid);
    if (!before) continue;
    const fd = r.pidfds.open(pid);
    if (fd < 0) continue; // it has gone
    try {
      const after = oldHost(r, pid);
      const chrome = r.procs.stat(r.chrome.pid);
      if (!after || after.start !== before.start || after.argv !== before.argv || !chrome || chrome.start !== r.chrome.start) continue;
      if (r.pidfds.signal(fd, SIGTERM) === 0) ended.push(pid);
    } finally { r.pidfds.close(fd); }
  }
  if (ended.length) r.log(`link: ended the old host (pid ${ended.join(", ")}): the receiver connects to the service's shim`);
  return ended;
}
