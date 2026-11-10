// The link socket's peer check (stage 1b part 2 of the self-contained agent browser, board ab-v16.94.9; the design,
// section 5.3): the service tells its own shim from any other process. At each accept it reads the peer (SO_PEERCRED,
// and SO_PEERPIDFD in the pidfd form, through the relay's peer reader), and it admits it only when all of these hold:
//
//   1. the peer runs as the service's user;
//   2. the peer's parent is the Chrome that the service runs, by its pid AND its start time (field 22 of
//      /proc/<pid>/stat), and that Chrome runs on the agent profile (`--user-data-dir=<profile>` on its command line);
//   3. the peer is the same process during the whole check: its pidfd still names it (the pidfd form), or its start
//      time is the same before and after the reads (the stat form), and its parent pid too.
//
// When the check cannot run (no peer reader), the link admits no connection: it never admits by a weaker rule. The Mac
// (stage 4) is not built: there the link refuses each connection.

import type { Socket } from "node:net";
import { readPeer, type PeerReader } from "../../relay/peer.ts";
import { namesProfile } from "./host.ts";
import type { LinkPeerCheck } from "./link.ts";

export const WHY = {
  noRun: (why: string) => `the peer check cannot run (${why})`,
  platform: (p: string) => `the link's check is not built for ${p} yet (stage 4)`,
  unread: "the service cannot read the peer, or it runs as another user",
  noChrome: "no Chrome of the service runs",
  parent: "its parent is not the service's Chrome",
  parentStart: "its parent's start time is not the service's Chrome's",
  profile: "the service's Chrome is not on the agent profile",
  changed: "the peer changed during the check",
} as const;

export function linkPeerCheck(d: {
  reader: PeerReader | { failed: string };
  /** The Chrome that the service runs now, by pid and start time, or null. */
  chrome: () => { pid: number; start: number | null } | null;
  profile: string;
  cmdline: (pid: number) => string[];
  uid?: number;
  platform?: NodeJS.Platform;
}): LinkPeerCheck {
  const uid = d.uid ?? process.getuid?.() ?? -1;
  const platform = d.platform ?? process.platform;
  return async (socket: Socket) => {
    if (platform !== "linux") return { ok: false, reason: WHY.platform(platform) };
    if ("failed" in d.reader) return { ok: false, reason: WHY.noRun(d.reader.failed) };
    const reader = d.reader;
    const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
    const peer = typeof fd === "number" && fd >= 0 ? readPeer(reader, fd, uid) : null;
    if (!peer) return { ok: false, reason: WHY.unread };
    try {
      const before = reader.proc(peer.pid);
      if (!before || (peer.start !== null && before.start !== peer.start)) return { ok: false, reason: WHY.unread };
      const chrome = d.chrome();
      if (!chrome || chrome.start === null) return { ok: false, reason: WHY.noChrome };
      if (before.ppid !== chrome.pid) return { ok: false, reason: WHY.parent };
      const parent = reader.proc(chrome.pid);
      if (!parent || parent.start !== chrome.start) return { ok: false, reason: WHY.parentStart };
      if (!namesProfile(d.cmdline(chrome.pid), d.profile)) return { ok: false, reason: WHY.profile };
      const after = reader.proc(peer.pid);
      const alive = peer.pidfd === null || (reader.poll(peer.pidfd) === 0 && reader.fdinfoPid(peer.pidfd) === peer.pid);
      if (!after || after.start !== before.start || after.ppid !== before.ppid || after.state === "Z" || !alive) return { ok: false, reason: WHY.changed };
      return { ok: true, pid: peer.pid };
    } finally { peer.release(reader); }
  };
}
