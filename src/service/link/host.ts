// The host shim, `agent-browser host` (stage 1b part 2 of the self-contained agent browser, board ab-v16.94.9; the
// design, section 5.3; chrome-extension docs/protocol.md, C1 and C4; a port of agentwatch's
// daemon/browser/native_host.py). Chrome starts it for the receiver (chrome.runtime.connectNative), from the host
// manifest in <profile>/NativeMessagingHosts/ (manifest.ts). It holds no logic and no state:
//
// - it relays Chrome's native frames (a 4-byte little-endian length, then JSON) to one JSON line on the service's link
//   socket, and each line of the socket to one frame; a frame with a raw line break is made compact first;
// - after each connect it tells the receiver {"t":"link","up":true}; while Chrome's port is open (its standard input)
//   it tries its socket again each second, so a restart of the service does not close the receiver's port;
// - a frame that comes while the socket is down is dropped; at the end of standard input it exits 0;
// - before it connects, it checks its parent (today's host's own check): the parent runs Chrome on the agent profile
//   (`--user-data-dir=<profile>` in /proc/<ppid>/cmdline; `ps` on the Mac). Any other parent gets exit 3, with no
//   connect and no read of standard input.
//
// The wrapper of manifest.ts gives it the socket and the profile in its environment. It logs only to standard error,
// and never a message body.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

/** The link socket's path (the wrapper sets it). */
export const ENV_SOCKET = "AGENT_BROWSER_LINK_SOCKET";
/** The agent profile, which the parent must run (the wrapper sets it). */
export const ENV_PROFILE = "AGENT_BROWSER_PROFILE";
/** Chrome's limit of a message from the extension to the host. */
export const MAX_FROM_EXTENSION = 64 * 1024 * 1024;
/** A line above this is not forwarded (Chrome's limit to the extension is 1 MiB). */
export const MAX_TO_EXTENSION = 1_000_000;
/** A longer socket line with no line end drops the socket (the host then connects again). */
export const MAX_LINE = 2 * 1024 * 1024;
export const RETRY_MS = 1000;
const LINK_UP = Buffer.from('{"t":"link","up":true}');

/** True when a command line names `--user-data-dir=<profile>`: as a whole argument, or in one joined process title, followed by its end or " --". */
export function namesProfile(fields: readonly string[], profile: string): boolean {
  const flag = `--user-data-dir=${profile}`;
  if (fields.includes(flag)) return true;
  const parts = fields.filter(Boolean);
  if (parts.length !== 1) return false;
  const line = parts[0];
  for (let start = 0; ;) {
    const at = line.indexOf(flag, start);
    if (at < 0) return false;
    const end = at + flag.length;
    if ((at === 0 || line[at - 1] === " ") && (end === line.length || line.startsWith(" --", end))) return true;
    start = at + 1;
  }
}

/** The command line of `pid` from /bin/ps (the Mac), or null. */
function psLine(pid: number): Promise<string | null> {
  return new Promise((resolve) => execFile("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], { timeout: 5000 }, (e, out) => resolve(e ? null : String(out).trim() || null)));
}

/** True when process `ppid` runs on `profile` (Linux: /proc/<ppid>/cmdline; the Mac: ps; elsewhere never). */
export async function parentRunsProfile(ppid: number, profile: string, o: { platform?: NodeJS.Platform; procRoot?: string; psLine?: (pid: number) => Promise<string | null> } = {}): Promise<boolean> {
  const platform = o.platform ?? process.platform;
  if (platform === "linux") {
    let raw: Buffer;
    try { raw = readFileSync(join(o.procRoot ?? "/proc", String(ppid), "cmdline")); } catch { return false; }
    return namesProfile(raw.toString("utf8").split("\0"), profile);
  }
  if (platform === "darwin") {
    const line = await (o.psLine ?? psLine)(ppid);
    return !!line && namesProfile([line], profile);
  }
  return false;
}

export type HostOptions = {
  env: Record<string, string | undefined>;
  stdin: Readable;
  stdout: Writable;
  /** The parent's pid (Chrome). */
  ppid: number;
  procRoot?: string;
  platform?: NodeJS.Platform;
  log: (line: string) => void;
  retryMs?: number;
};

/** Run the shim: 0 at the end of standard input, 2 with no socket or profile, 3 when the parent is not the agent Chrome. */
export async function runHost(o: HostOptions): Promise<number> {
  const log = (s: string) => o.log(`agent-browser host: ${s}`);
  const path = o.env[ENV_SOCKET];
  if (!path) { log(`${ENV_SOCKET} is not set`); return 2; }
  const profile = o.env[ENV_PROFILE];
  if (!profile) { log(`${ENV_PROFILE} is not set`); return 2; }
  if (!(await parentRunsProfile(o.ppid, profile, { platform: o.platform, procRoot: o.procRoot }))) {
    log("the parent process is not the agent Chrome on its profile; not connecting");
    return 3;
  }
  const retryMs = o.retryMs ?? RETRY_MS;
  let stopped = false;
  let sock: Socket | null = null;
  let retry: NodeJS.Timeout | null = null;
  let done!: (code: number) => void;
  const finished = new Promise<number>((r) => { done = r; });

  const toExtension = (data: Buffer): boolean => {
    if (stopped) return false;
    const h = Buffer.alloc(4);
    h.writeUInt32LE(data.length);
    try { o.stdout.write(Buffer.concat([h, data])); return true; } catch { finish(); return false; }
  };
  const finish = () => {
    if (stopped) return;
    stopped = true;
    if (retry) clearTimeout(retry);
    sock?.destroy();
    sock = null;
    o.stdin.pause();
    done(0);
  };

  // The socket side: connect, say link up, relay each line; on a close, try again after retryMs.
  const connectOnce = () => {
    retry = null;
    if (stopped) return;
    const s = connect(path);
    let buf = Buffer.alloc(0);
    s.on("connect", () => {
      if (stopped) { s.destroy(); return; }
      sock = s;
      toExtension(LINK_UP);
    });
    s.on("data", (d: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      for (let i: number; (i = buf.indexOf(10)) >= 0;) {
        const line = buf.subarray(0, i);
        buf = buf.subarray(i + 1);
        if (!line.toString("latin1").trim()) continue;
        if (line.length > MAX_TO_EXTENSION) { log("dropped a line over the size limit"); continue; }
        if (!toExtension(Buffer.from(line))) return;
      }
      if (buf.length > MAX_LINE) { log("a line with no end over the limit; connecting again"); s.destroy(); }
    });
    s.on("error", () => {});
    s.on("close", () => {
      if (sock === s) sock = null;
      if (!stopped) retry = setTimeout(connectOnce, retryMs);
    });
  };

  const forward = (data: Buffer) => {
    const s = sock;
    if (!s) return; // dropped while the socket is down
    if (data.includes(10) || data.includes(13)) {
      try { data = Buffer.from(JSON.stringify(JSON.parse(data.toString("utf8")))); }
      catch { log("dropped a message that is not JSON"); return; }
    }
    s.write(Buffer.concat([data, Buffer.from("\n")]));
  };

  // Chrome's side: frames of a 4-byte little-endian length and the JSON.
  let chunks: Buffer[] = [], have = 0, need: number | null = null;
  const take = (n: number): Buffer => {
    const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    chunks = rest.length ? [rest] : []; have = rest.length;
    return out;
  };
  o.stdin.on("data", (d: Buffer) => {
    if (stopped) return;
    chunks.push(d); have += d.length;
    for (;;) {
      if (need === null) {
        if (have < 4) return;
        need = take(4).readUInt32LE(0);
        if (need > MAX_FROM_EXTENSION) { log("a message over the size limit; closing"); finish(); return; }
      }
      if (have < need) return;
      const body = take(need);
      need = null;
      forward(body);
    }
  });
  o.stdin.once("end", finish);
  o.stdin.once("close", finish);
  o.stdin.once("error", finish);
  o.stdout.on("error", finish);
  connectOnce();
  return finished;
}
