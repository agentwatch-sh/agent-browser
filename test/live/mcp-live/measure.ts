// The pure helpers of the MCP port's live check (board ab-v16.94.13; test/live/mcp-live/check.ts): the reads of
// /proc/net/unix, /proc/net/tcp and a process's status, the snapshot's element references, the memory row's rule, and the
// rule of the row of a worker's start and stop (board ab-v16.94.17, O1), and the input stage's file counts from its trace
// lines (board ab-t30.27).
// test/mcp-live.test.ts tests them with made-up lines.

/** One socket of /proc/net/unix: its inode, its state (1 unconnected or listening, 3 connected), whether it listens, and its path ("" with none). */
export type UnixSocket = { inode: number; state: number; listens: boolean; path: string };

/** The sockets of /proc/net/unix's text (its first line is the header). */
export function unixSockets(text: string): UnixSocket[] {
  const out: UnixSocket[] = [];
  for (const line of text.split("\n").slice(1)) {
    // Num RefCount Protocol Flags Type St Inode [Path]
    const f = line.trim().split(/\s+/);
    if (f.length < 7) continue;
    const flags = parseInt(f[3], 16), state = parseInt(f[5], 16), inode = Number(f[6]);
    if (!Number.isSafeInteger(inode)) continue;
    out.push({ inode, state, listens: (flags & 0x10000) !== 0, path: f.slice(7).join(" ") });
  }
  return out;
}

/** The connected sockets whose path is `path`: the server ends of the connections that a listener at `path` accepted. */
export const acceptedAt = (socks: readonly UnixSocket[], path: string): number[] =>
  socks.filter((s) => s.path === path && s.state === 3 && !s.listens).map((s) => s.inode);

/** One TCP socket in LISTEN of /proc/net/tcp or tcp6: its local address (hex, as the file gives it), port, uid and inode. */
export type TcpListener = { address: string; port: number; uid: number; inode: number };

/** The listeners (state 0A) of /proc/net/tcp's or tcp6's text. */
export function tcpListeners(text: string): TcpListener[] {
  const out: TcpListener[] = [];
  for (const line of text.split("\n").slice(1)) {
    // sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== "0A") continue;
    const [address, port] = f[1].split(":");
    out.push({ address, port: parseInt(port, 16), uid: Number(f[7]), inode: Number(f[9]) });
  }
  return out;
}

/** The resident set (VmRSS) of a /proc/<pid>/status text, in KiB, or null. */
export function rssKib(status: string): number | null {
  const m = /^VmRSS:\s+(\d+) kB$/m.exec(status);
  return m ? Number(m[1]) : null;
}

/**
 * The reference of the first element of the snapshot's text with `role` and the accessible name `name`: the MCP's
 * snapshot writes it as `- <role> "<name>" [ref=<ref>]`. Null when no such element is there.
 */
export function refOf(snapshot: string, role: string, name: string): string | null {
  for (const line of snapshot.split("\n")) {
    const m = /^\s*- (\w+) "((?:[^"\\]|\\.)*)"[^\n]*\[ref=([^\]\s]+)\]/.exec(line);
    if (m && m[1] === role && m[2] === name) return m[3];
  }
  return null;
}

/** The memory row's bound (MiB): the second half of the calls may grow the RSS by less than this, or by half of the first half's growth. */
export const SECOND_HALF_MIB = 64;

/**
 * The memory row's rule: RSS samples (KiB) after each round of calls; it passes when the second half of the rounds
 * grows the RSS by less than SECOND_HALF_MIB, or by at most half of what the first half did (the growth slows: no growth
 * without a bound). `growth` gives both halves in MiB.
 */
export function boundedGrowth(samples: readonly number[]): { ok: boolean; first: number; second: number } {
  if (samples.length < 3) return { ok: false, first: NaN, second: NaN };
  const mid = Math.floor((samples.length - 1) / 2);
  const mib = (k: number) => Math.round((k / 1024) * 10) / 10;
  const first = mib(samples[mid] - samples[0]), second = mib(samples[samples.length - 1] - samples[mid]);
  return { ok: second < SECOND_HALF_MIB || second <= first / 2, first, second };
}

/** The cycles row's bound (MiB; board ab-v16.94.17, O1): after the first cycle of a worker's start and stop, the RSS after the stops may grow by less than this in all. */
export const CYCLES_MIB = 32;

/**
 * The cycles row's rule: the RSS samples (KiB) after each worker's stop, cycle by cycle; it passes when the RSS after
 * the last stop is less than CYCLES_MIB above the RSS after the first one (flat after the first cycle: a worker's start
 * and stop leaves nothing that grows). `growth` gives that difference in MiB.
 */
export function flatCycles(samples: readonly number[]): { ok: boolean; growth: number } {
  if (samples.length < 2) return { ok: false, growth: NaN };
  const growth = Math.round(((samples[samples.length - 1] - samples[0]) / 1024) * 10) / 10;
  return { ok: growth < CYCLES_MIB, growth };
}

/** The MCP sessions of `scope` that the service's log begins and does not end (its lines "MCP session N of scope S begins" and "... ended: why"). */
export function openSessions(log: string, scope: string): number {
  const count = (s: string) => log.split(s).length - 1;
  return count(` of scope ${scope} begins`) - count(` of scope ${scope} ended:`);
}

/** True when `text` holds a ticket of the agent door's CDP path: the query key `ticket=` (C11's log and answer rule). */
export const holdsTicket = (text: string): boolean => /ticket=/i.test(text);

/**
 * The input stage's file counts (C11, files; board ab-t30.27) from its trace lines in a service log (the service runs
 * with AGENT_BROWSER_POINTER_LOG=1): each line of filesStep stands for one count of it. `fileClicks` for "a click on the
 * input (or label) and the chooser", the line's own key for "the files to the chooser's input (<key>)", and
 * `filesPass:<why>` for "setInputFiles passes (<why>)".
 */
export function fileCounts(log: string): Record<string, number> {
  const c: Record<string, number> = {};
  const add = (k: string) => { c[k] = (c[k] ?? 0) + 1; };
  for (const line of log.split("\n")) {
    if (!line.includes("relay: the input stage: tab ")) continue;
    const l = line.trimEnd();
    let m: RegExpExecArray | null;
    if (/: setInputFiles: a click on the (?:input|label) and the chooser \((?:paths|buffers)\)$/.test(l)) add("fileClicks");
    else if ((m = /: setInputFiles: the files to the chooser's input \((\w+)\)$/.exec(l))) add(m[1]);
    else if ((m = /: setInputFiles passes \((\w+)\)$/.exec(l))) add(`filesPass:${m[1]}`);
  }
  return c;
}
