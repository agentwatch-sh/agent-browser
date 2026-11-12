// The MCP port's socket from systemd (contract C11, "The MCP path": the port stays held while the service is down; the
// self-contained design, section 19, build note 1). agentwatch's install writes the units: agent-browser-mcp.socket
// holds 127.0.0.1:<port> (Accept=no, with a oneshot holder that never touches Chrome), and agent-browser.service takes
// the socket's fd through Sockets=. The service reads it by the sd_listen_fds protocol (sd_listen_fds(3)): LISTEN_PID is
// the service's pid, LISTEN_FDS the number of fds from fd 3 on, and LISTEN_FDNAMES their names, separated by colons (a
// socket unit's fd has the unit's name). As sd_listen_fds does, the service sets FD_CLOEXEC on each passed fd as soon as
// LISTEN_PID and LISTEN_FDS are valid, before it reads the names, so no child (Chrome, a tool) keeps the port; and it
// removes the three variables from its environment in every path, also when the take fails (the review of part 2a,
// note 1).
//
// Stage 1d part 2b: the real service takes the socket when systemd passes one (main.ts); with no LISTEN_* variable it
// opens no MCP port.

/** The socket unit that holds the MCP port, and so the name of its fd. */
export const MCP_SOCKET_UNIT = "agent-browser-mcp.socket";
/** The first fd that systemd passes (SD_LISTEN_FDS_START). */
export const LISTEN_FDS_START = 3;
const F_GETFD = 1, F_SETFD = 2, FD_CLOEXEC = 1;

/**
 * The fd of `name` by the sd_listen_fds protocol, or why there is none: LISTEN_PID must be `pid`, LISTEN_FDS a count of
 * one or more, LISTEN_FDNAMES one name for each fd, and `name` exactly one of them.
 */
export function listenFd(env: Record<string, string | undefined>, pid: number, name = MCP_SOCKET_UNIT): { fd: number; count: number } | { none: string; count?: number } {
  const c = listenCount(env, pid);
  if ("none" in c) return c;
  return namedFd(env.LISTEN_FDNAMES, c.count, name);
}

/** The fd of `name` among `count` passed fds, by LISTEN_FDNAMES (`names`): one name for each fd, and `name` exactly once. */
function namedFd(fdNames: string | undefined, count: number, name: string): { fd: number; count: number } | { none: string; count: number } {
  const names = (fdNames ?? "").split(":");
  if (fdNames === undefined || names.length !== count) return { none: "LISTEN_FDNAMES does not name each fd", count };
  const at = names.indexOf(name);
  if (at < 0 || names.lastIndexOf(name) !== at) return { none: `systemd passed no socket named ${name}`, count };
  return { fd: LISTEN_FDS_START + at, count };
}

/** The number of passed fds when LISTEN_PID is `pid` and LISTEN_FDS a count of one or more (sd_listen_fds's first checks), or why not. */
export function listenCount(env: Record<string, string | undefined>, pid: number): { count: number } | { none: string } {
  if (env.LISTEN_PID === undefined || env.LISTEN_FDS === undefined) return { none: "systemd passed no socket (no LISTEN_PID or LISTEN_FDS)" };
  if (env.LISTEN_PID !== String(pid)) return { none: `the sockets are for pid ${/^\d{1,10}$/.test(env.LISTEN_PID) ? env.LISTEN_PID : "(not a pid)"}, not for this process` };
  const count = /^[1-9]\d{0,3}$/.test(env.LISTEN_FDS) ? Number(env.LISTEN_FDS) : 0;
  if (count === 0) return { none: "LISTEN_FDS is not a count of one or more" };
  return { count };
}

/** libc's fcntl through node:ffi (a dynamic import, as the peer check's self-test loads it). */
export type Fcntl = (fd: number, cmd: number, arg: number) => number;
async function loadFcntl(): Promise<Fcntl> {
  const mod: any = await import("node:ffi");
  const ffi = mod.default ?? mod;
  const { functions } = ffi.dlopen("libc.so.6", { fcntl: { return: "int32", arguments: ["int32", "int32", "int32"] } });
  return functions.fcntl;
}

/** The variables of the sd_listen_fds protocol, which the service removes in every path (C11). */
export const LISTEN_VARS = ["LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES"] as const;

/**
 * Mark the passed fds close-on-exec when LISTEN_PID and LISTEN_FDS are this process's, and remove the three variables in
 * every path (sd_listen_fds with unset_environment). The count of the fds and LISTEN_FDNAMES, which it reads only after
 * the marks (C11; review-115b's note), or why there is none; a failed fcntl throws after it tried each fd and removed the
 * variables.
 */
export async function markListenFds(env: Record<string, string | undefined>, o: { pid?: number; fcntl?: Fcntl } = {}): Promise<{ count: number; names: string | undefined } | { none: string }> {
  try {
    const c = listenCount(env, o.pid ?? process.pid);
    if ("none" in c) return c;
    const fcntl = o.fcntl ?? await loadFcntl();
    let failed: number | null = null;
    for (let fd = LISTEN_FDS_START; fd < LISTEN_FDS_START + c.count; fd++) {
      const flags = fcntl(fd, F_GETFD, 0);
      if (flags < 0 || fcntl(fd, F_SETFD, flags | FD_CLOEXEC) < 0) failed ??= fd;
    }
    if (failed !== null) throw new Error(`the MCP port's socket: fd ${failed} cannot be marked close-on-exec`);
    // The names only now, after the marks, and before the finally removes them.
    return { count: c.count, names: env.LISTEN_FDNAMES };
  } finally {
    for (const k of LISTEN_VARS) delete env[k];
  }
}

/**
 * Take the MCP port's fd by the sd_listen_fds protocol: the fd of agent-browser-mcp.socket. As soon as LISTEN_PID and
 * LISTEN_FDS are valid, FD_CLOEXEC goes on every passed fd, before the names are read; and LISTEN_PID, LISTEN_FDS and
 * LISTEN_FDNAMES are gone from `env` in every path, also when the take throws. A failure throws: the service then opens
 * no MCP port (fail closed: the socket unit keeps the port, and a connection waits with no answer).
 */
export async function takeMcpSocket(env: Record<string, string | undefined> = process.env, o: { pid?: number; fcntl?: Fcntl } = {}): Promise<number> {
  // The marks first, then the names (markListenFds reads LISTEN_FDNAMES after its marks): C11, as sd_listen_fds does.
  const c = await markListenFds(env, o);
  if ("none" in c) throw new Error(`the MCP port's socket: ${c.none}`);
  const named = namedFd(c.names, c.count, MCP_SOCKET_UNIT);
  if ("none" in named) throw new Error(`the MCP port's socket: ${named.none}`);
  return named.fd;
}

/**
 * The MCP port of the service's start (main.ts; C11, "The MCP path"): `--test`'s port (`testPort`), or systemd's socket
 * when any variable of the protocol is set and the service is not in `--test` mode, else none. In every path the
 * variables are removed and the passed fds that are this process's are marked close-on-exec: also in `--test` mode,
 * which takes no passed fd, and when only LISTEN_FDNAMES is set (review-115 note 1). A take that fails gives `failed`.
 */
export async function mcpListen(o: { test: boolean; testPort?: number; env?: Record<string, string | undefined>; pid?: number; fcntl?: Fcntl }): Promise<{ port: number } | { fd: number } | { failed: string } | null> {
  const env = o.env ?? process.env;
  const passed = LISTEN_VARS.some((k) => env[k] !== undefined);
  if (o.test) {
    if (passed) { try { await markListenFds(env, o); } catch {} }
    return o.testPort === undefined ? null : { port: o.testPort };
  }
  if (!passed) return null;
  try { return { fd: await takeMcpSocket(env, o) }; }
  catch (e) { return { failed: (e as Error).message }; }
}
