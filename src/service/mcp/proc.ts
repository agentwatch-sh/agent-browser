// The reads of the MCP path's admission (contract C11, "The admission of the MCP path", steps 1 and 2; stage 1d of the
// self-contained agent browser, board ab-v16.94.5): the lines of /proc/net/tcp (the client's socket by the full tuple,
// and its uid column), the processes that hold a socket's inode (/proc/<pid>/fd), and the stat and cgroup files that the
// walk reads. The walk itself is the endpoint's (src/relay/peer.ts, RootState): this file only gives it its reads.
//
// One reader interface (McpReader) stands behind the admission: the real one reads /proc with fs (no node:ffi), and the
// tests' fake gives the lines, the holders and the process tables of the shared vectors (test/vectors/endpoint.json,
// mcpChecks).

import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { endianness } from "node:os";
import { readCgroup, readProc, type PeerReader, type Proc } from "../../relay/peer.ts";

/** One line of /proc/net/tcp as the admission reads it: the local and the remote address (`a.b.c.d:port`), the uid and the inode. */
export type TcpLine = { readonly local: string; readonly remote: string; readonly uid: number; readonly inode: number };

/** The reads of the MCP path's admission. */
export interface McpReader {
  /** The lines of /proc/net/tcp, or null when the service cannot read it. */
  tcp(): TcpLine[] | null;
  /** The pids whose /proc/<pid>/fd holds the socket of `inode`, lowest first. */
  holders(inode: number): number[];
  /** A process's parent, start time and state (/proc/<pid>/stat), or null when it cannot be read. */
  proc(pid: number): Proc | null;
  /** A process's cgroup (the `0::` line of /proc/<pid>/cgroup), or null. */
  cgroup(pid: number): string | null;
}

/** An address of /proc/net/tcp (`0100007F:B8CF`: the IPv4 address in the host's byte order, the port), as `a.b.c.d:port`. */
function address(hex: string, order: "LE" | "BE"): string | null {
  const m = /^([0-9A-Fa-f]{8}):([0-9A-Fa-f]{4})$/.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16) >>> 0;
  const bytes = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return `${(order === "LE" ? bytes.reverse() : bytes).join(".")}:${parseInt(m[2], 16)}`;
}

/** The lines of a /proc/net/tcp text; a line that does not parse is left out. */
export function parseTcp(text: string, order: "LE" | "BE" = endianness()): TcpLine[] {
  const out: TcpLine[] = [];
  for (const line of text.split("\n")) {
    // sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode ...
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || !/^\d+:$/.test(f[0])) continue;
    const local = address(f[1], order), remote = address(f[2], order);
    const uid = Number(f[7]), inode = Number(f[9]);
    if (local === null || remote === null || !/^\d+$/.test(f[7]) || !/^\d+$/.test(f[9]) || !Number.isSafeInteger(uid) || !Number.isSafeInteger(inode)) continue;
    out.push({ local, remote, uid, inode });
  }
  return out;
}

/** The real reads of /proc. A holder scan reads each process's fd folder that the service can read. */
export function procReader(): McpReader {
  const root = "/proc";
  return {
    tcp: () => { try { return parseTcp(readFileSync(`${root}/net/tcp`, "latin1")); } catch { return null; } },
    holders: (inode) => {
      const link = `socket:[${inode}]`, out: number[] = [];
      let names: string[];
      try { names = readdirSync(root); } catch { return out; }
      for (const name of names) {
        if (!/^\d+$/.test(name)) continue;
        let fds: string[];
        try { fds = readdirSync(`${root}/${name}/fd`); } catch { continue; } // another user's process, or one that has gone
        for (const fd of fds) {
          let target: string;
          try { target = readlinkSync(`${root}/${name}/fd/${fd}`); } catch { continue; }
          if (target === link) { out.push(Number(name)); break; }
        }
      }
      return out.sort((a, b) => a - b);
    },
    proc: (pid) => readProc(pid),
    cgroup: (pid) => readCgroup(pid),
  };
}

/**
 * The walk's reader for the MCP path (the stat form of C11's session check): a holder has no pidfd, so it is alive
 * while its pid has the start time of the holder scan and its state is not Z. Only `proc` and `cgroup` are read.
 */
export function walkReader(reader: McpReader): PeerReader {
  return { form: "stat", peer: () => null, proc: (pid) => reader.proc(pid), cgroup: (pid) => reader.cgroup(pid), poll: () => -1, fdinfoPid: () => null, close: () => {} };
}
