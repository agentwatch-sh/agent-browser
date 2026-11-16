// The MCP port's socket from launchd on the Mac (contract C11, "The MCP path"; C12, the Mac's command; board
// ab-v16.94.30): the Mac's form of listen-fds.ts. agentwatch's plist of the service's job, com.agentwatch.agent-browser,
// has the Sockets entry agent-browser-mcp (SockNodeName 127.0.0.1, SockServiceName the port, SockType stream, SockFamily
// IPv4), so launchd holds the port while the service is down. The service takes it with launch_activate_socket(3)
// through node:ffi, into libSystem: exactly one fd, a TCP listener on 127.0.0.1 (port.ts listens on it as on Linux and
// refuses any other address). It marks each fd that launchd gives close-on-exec at once, in the same synchronous run as
// the call and before the count decides, so no child (Chrome, a tool) keeps the port; and it frees launchd's array with
// free(3) in every path. No socket entry (ENOENT) or no launchd job (ESRCH) gives no MCP port, as Linux's start with no
// LISTEN_* variable does; each other answer (EALREADY, no fd, two or more, an fd that cannot be marked) gives `failed`
// (fail closed: no MCP port; McpPart logs it, and status says failed).
//
// The mark: ioctl(fd, FIOCLEX), then fcntl(fd, F_GETFD) reads it back. fcntl(2) and ioctl(2) are variadic, and on the
// Mac's arm64 a variadic argument goes on the stack, which node:ffi's fixed signature does not do: F_SETFD's FD_CLOEXEC
// would not arrive. FIOCLEX passes no third argument, and F_GETFD reads none, so each call has only fixed arguments.

/** The name of the Sockets entry in the job's plist: the base name of Linux's socket unit, agent-browser-mcp.socket. */
export const MCP_SOCKET_KEY = "agent-browser-mcp";
/** macOS's errno values (sys/errno.h) of launch_activate_socket(3). */
export const ENOENT = 2, ESRCH = 3, EALREADY = 37;
export const F_GETFD = 1, FD_CLOEXEC = 1;
/** _IO('f', 1) on macOS (sys/filio.h): set close-on-exec on the fd. */
export const FIOCLEX = 0x20006601;
/** At most this many fds are read from launchd's array (launchd gives one for each address of the entry). */
const MAX_FDS = 64;

/** The libSystem calls of the take (the tests give a fake). */
export type LaunchLib = {
  /** launch_activate_socket(3): `name` a C string; `fds` gets an int * (8 bytes), `cnt` a size_t (8 bytes). 0, or an errno value. */
  launch_activate_socket(name: Buffer, fds: Buffer, cnt: Buffer): number;
  /** The int at `offset` bytes from `ptr` (node:ffi's getInt32). */
  getInt32(ptr: bigint, offset: number): number;
  /** free(3) of launchd's array. */
  free(ptr: bigint): void;
  /** ioctl(2) with no third argument (FIOCLEX). */
  ioctl(fd: number, request: number): number;
  /** fcntl(2) with no third argument (F_GETFD). */
  fcntl(fd: number, cmd: number): number;
};

/** node:ffi's dlopen of libSystem (a dynamic import, as the peer check's self-test loads it); why it failed, else the calls. */
export async function loadLaunchLib(): Promise<LaunchLib | { failed: string }> {
  let ffi: any;
  try { const mod: any = await import("node:ffi"); ffi = mod.default ?? mod; }
  catch (e) { return { failed: `node:ffi does not load (${(e as { code?: string }).code ?? (e as Error).message})` }; }
  try {
    const { functions: f } = ffi.dlopen("/usr/lib/libSystem.B.dylib", {
      launch_activate_socket: { return: "int32", arguments: ["buffer", "buffer", "buffer"] },
      free: { return: "void", arguments: ["pointer"] },
      ioctl: { return: "int32", arguments: ["int32", "uint64"] },
      fcntl: { return: "int32", arguments: ["int32", "int32"] },
    });
    return {
      launch_activate_socket: f.launch_activate_socket, free: f.free, fcntl: f.fcntl,
      getInt32: (ptr, offset) => ffi.getInt32(ptr, offset),
      ioctl: (fd, request) => f.ioctl(fd, BigInt(request)),
    };
  } catch (e) { return { failed: `dlopen of libSystem failed: ${(e as Error).message}` }; }
}

/** Mark `fd` close-on-exec and read the mark back: true only when F_GETFD shows FD_CLOEXEC. */
function markCloexec(lib: LaunchLib, fd: number): boolean {
  if (fd < 0 || lib.ioctl(fd, FIOCLEX) !== 0) return false;
  const flags = lib.fcntl(fd, F_GETFD);
  return flags >= 0 && (flags & FD_CLOEXEC) !== 0;
}

/** Why launch_activate_socket gave `err`: `none` when launchd has no socket for the service, else `failed`. */
function activateError(err: number): { none: string } | { failed: string } {
  if (err === ENOENT) return { none: `the service's launchd job has no Sockets entry ${MCP_SOCKET_KEY} (ENOENT)` };
  if (err === ESRCH) return { none: "the service is not a launchd job (ESRCH)" };
  if (err === EALREADY) return { failed: `the MCP port's socket: launch_activate_socket: the socket ${MCP_SOCKET_KEY} was taken already (EALREADY)` };
  return { failed: `the MCP port's socket: launch_activate_socket gave the error ${err}` };
}

/**
 * Take the MCP port's fd from launchd: launch_activate_socket("agent-browser-mcp"), each fd marked close-on-exec at once,
 * launchd's array freed in every path, and exactly one fd. `none` when launchd has no socket for the service (ENOENT,
 * ESRCH); `failed` for each other answer. A call that throws (a read of the array) throws, after the free.
 */
export async function takeLaunchdSocket(load: () => Promise<LaunchLib | { failed: string }> = loadLaunchLib): Promise<{ fd: number } | { none: string } | { failed: string }> {
  const lib = await load();
  if ("failed" in lib) return { failed: `the MCP port's socket: ${lib.failed}` };
  // From the call to the last mark nothing awaits, so no child starts in between.
  const out = Buffer.alloc(8), cnt = Buffer.alloc(8);
  const err = lib.launch_activate_socket(Buffer.from(`${MCP_SOCKET_KEY}\0`, "latin1"), out, cnt);
  const ptr = out.readBigUInt64LE(0), count = cnt.readBigUInt64LE(0);
  const fds: number[] = [];
  let unmarked: number | null = null;
  try {
    if (err !== 0) return activateError(err);
    for (let i = 0; ptr !== 0n && i < Math.min(Number(count), MAX_FDS); i++) {
      const fd = lib.getInt32(ptr, 4 * i);
      fds.push(fd);
      if (!markCloexec(lib, fd)) unmarked ??= fd;
    }
  } finally {
    if (ptr !== 0n) lib.free(ptr);
  }
  if (unmarked !== null) return { failed: `the MCP port's socket: fd ${unmarked} cannot be marked close-on-exec` };
  if (count !== 1n || fds.length !== 1) return { failed: `the MCP port's socket: launchd gave ${count} fds for ${MCP_SOCKET_KEY}, not exactly one` };
  return { fd: fds[0] };
}

/**
 * The MCP port of the service's start on the Mac (main.ts; C11, "The MCP path"): `--test`'s port (`testPort`), which
 * never asks launchd, or launchd's socket. No socket for the service gives no MCP port and a log line; a take that fails
 * gives `failed` (McpPart logs it, and status says failed).
 */
export async function launchdMcpListen(o: { test: boolean; testPort?: number; log: (line: string) => void; load?: () => Promise<LaunchLib | { failed: string }> }): Promise<{ port: number } | { fd: number } | { failed: string } | null> {
  if (o.test) return o.testPort === undefined ? null : { port: o.testPort };
  let got;
  try { got = await takeLaunchdSocket(o.load); }
  catch (e) { return { failed: `the MCP port's socket: ${(e as Error).message}` }; }
  if ("none" in got) { o.log(`service: launchd gives the service no socket for the MCP port (${got.none}), so it opens no MCP port`); return null; }
  return got;
}
