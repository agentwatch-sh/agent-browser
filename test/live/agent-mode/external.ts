// The external mode of the agent-mode live suite (run.ts; boards ab-v16.57 and ab-v16.60): the guard that it runs
// before it makes its run folder or connects, and the answer of its control command. Pure, so that `npm test` checks
// it (test/agent-live-external.test.ts).

import { basename, dirname, join, resolve } from "node:path";

export const EXTERNAL_USAGE = "usage: RELAY_SOCK=<socket> CONTROL=<status|end-scope|restart-relay executable> npm run test:live:agent";

export type ExternalMode = { ok: true; socket: null } | { ok: true; socket: string; control: string } | { ok: false; message: string };

/** The live daemon's socket folder of any user (/run/user/<uid>/agentwatch), so that a run as root refuses it too. */
const ANY_LIVE = /^\/run\/user\/\d+\/agentwatch(\/|$)/;
/** The characters that a ws+unix URL keeps as they are in a socket's path. */
const PLAIN_PATH = /^\/[A-Za-z0-9._/-]+$/;

/** The run's client URL of a scope (run.ts; the probe's concurrency.mjs builds the same one). */
export const wsUrl = (sock: string, scope: string) => `ws+unix://${sock}:/devtools/browser/${scope}`;

/**
 * True when the client URL of the socket (wsUrl) leads ws to that same socket. ws takes the path from the parsed URL
 * up to its first ':', and the URL parse changes a path: it percent-encodes a space or a non-ASCII letter, reads
 * %2e%2e as "..", and removes a TAB, LF or CR (review-62b, B3). So only an absolute path of plain characters is kept,
 * and the parse must give it back.
 */
export function wsPathKept(p: string): boolean {
  if (!PLAIN_PATH.test(p)) return false;
  try {
    const u = new URL(wsUrl(p, "x"));
    return (u.pathname + u.search).split(":")[0] === p;
  } catch {
    return false;
  }
}

/**
 * The external mode from the environment: no RELAY_SOCK is the own mode. A socket in a socket folder of agentwatch
 * (/run/user/<uid>/agentwatch of any uid, also as $XDG_RUNTIME_DIR/agentwatch; the gateway's /run/agentwatch; the
 * macOS ~/.cache/agentwatch; the real path of each, of the socket and of its folder) is refused first: the suite never
 * runs in the operator's agent browser. Then the client URL must keep the socket's path and its real path (wsPathKept),
 * the socket must exist, and it must not be the same file (device and inode) as an entry of the live folders: a hard
 * link to a live socket (review-62b, B4). The run connects to the real path, which the guard checked: a link that is
 * gone, or that changes later, can never lead the run to the live socket. The group peer needs the stand-in daemon's
 * roots, and CONTROL must be an executable.
 */
export function externalMode(env: { RELAY_SOCK?: string; CONTROL?: string; CASES?: string; XDG_RUNTIME_DIR?: string },
  o: { uid: number; home: string; realpath: (p: string) => string | null; socket: (p: string) => boolean; id: (p: string) => string | null;
    entries: (dir: string) => string[]; executable: (p: string) => boolean }): ExternalMode {
  if (!env.RELAY_SOCK) return { ok: true, socket: null };
  const sock = resolve(env.RELAY_SOCK);
  const real = o.realpath(sock);
  const dir = o.realpath(dirname(sock));
  const paths = [sock, real, dir === null ? null : join(dir, basename(sock))].filter((p): p is string => p !== null);
  const live = [`/run/user/${o.uid}/agentwatch`, ...(env.XDG_RUNTIME_DIR ? [join(resolve(env.XDG_RUNTIME_DIR), "agentwatch")] : []),
    "/run/agentwatch", join(resolve(o.home), ".cache/agentwatch")];
  const folders = [...live, ...live.map((d) => o.realpath(d)).filter((p): p is string => p !== null)];
  if (paths.some((p) => ANY_LIVE.test(p) || folders.some((d) => p === d || p.startsWith(`${d}/`))))
    return { ok: false, message: `refused: ${sock} is in the live daemon's socket folder (the operator's agent browser); the suite never runs there` };
  if (!wsPathKept(sock) || (real !== null && !wsPathKept(real)))
    return { ok: false, message: `refused: the ws+unix URL changes ${JSON.stringify(real ?? sock)} (use a path of letters, digits and ._-/ only), so the run would connect elsewhere` };
  const own = real === null ? null : o.id(real);
  if (real === null || own === null || !o.socket(sock))
    return { ok: false, message: `${sock} is no socket that exists: the external mode needs the socket of an agent browser that runs already` };
  const others = o.entries("/run/user").map((d) => join(d, "agentwatch"));
  const liveIds = new Set([...folders, ...others, join(resolve(o.home), ".cache/agentwatch/run")].flatMap((d) => o.entries(d)).map((p) => o.id(p)));
  if (liveIds.has(own))
    return { ok: false, message: `refused: ${sock} is the same file as a socket of the live daemon (a hard link; the operator's agent browser); the suite never runs there` };
  if ((env.CASES ?? "").split(",").includes("peer"))
    return { ok: false, message: "the group peer needs the stand-in daemon (the relay's --peer-check and the sessions' roots): it runs in the own mode only" };
  const control = env.CONTROL ? resolve(env.CONTROL) : "";
  if (!control || !o.executable(control)) return { ok: false, message: EXTERNAL_USAGE };
  return { ok: true, socket: real, control };
}

/** The control's answer: the JSON object from the first "{" of its output to its end, or a failed answer that says why. */
export function controlAnswer(stdout: string, exit: number | string): Record<string, unknown> {
  const i = stdout.indexOf("{");
  try {
    const v = JSON.parse(stdout.slice(i));
    if (i >= 0 && v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch { /* the failed answer below */ }
  return { ok: false, error: `no JSON answer (exit ${exit})` };
}
