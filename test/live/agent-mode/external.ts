// The external mode of the agent-mode live suite (run.ts; boards ab-v16.57 and ab-v16.60): the guard that it runs
// before it makes its run folder or connects, and the answer of its control command. Pure, so that `npm test` checks
// it (test/agent-live-external.test.ts).

import { basename, dirname, join, resolve } from "node:path";

export const EXTERNAL_USAGE = "usage: RELAY_SOCK=<socket> CONTROL=<status|end-scope|restart-relay executable> npm run test:live:agent";

export type ExternalMode = { ok: true; socket: null } | { ok: true; socket: string; control: string } | { ok: false; message: string };

/**
 * The external mode from the environment: no RELAY_SOCK is the own mode. A socket in the live daemon's socket folder
 * (/run/user/<uid>/agentwatch, also as $XDG_RUNTIME_DIR/agentwatch, and the real path of each, of the socket and of
 * its folder) is refused first: the suite never runs in the operator's agent browser. The group peer needs the
 * stand-in daemon's roots, and CONTROL must be an executable.
 */
export function externalMode(env: { RELAY_SOCK?: string; CONTROL?: string; CASES?: string; XDG_RUNTIME_DIR?: string },
  o: { uid: number; realpath: (p: string) => string | null; executable: (p: string) => boolean }): ExternalMode {
  if (!env.RELAY_SOCK) return { ok: true, socket: null };
  const sock = resolve(env.RELAY_SOCK);
  const dir = o.realpath(dirname(sock));
  const paths = [sock, o.realpath(sock), dir === null ? null : join(dir, basename(sock))].filter((p): p is string => p !== null);
  const live = [`/run/user/${o.uid}/agentwatch`, ...(env.XDG_RUNTIME_DIR ? [join(resolve(env.XDG_RUNTIME_DIR), "agentwatch")] : [])];
  const folders = [...live, ...live.map((d) => o.realpath(d)).filter((p): p is string => p !== null)];
  if (paths.some((p) => folders.some((d) => p === d || p.startsWith(`${d}/`))))
    return { ok: false, message: `refused: ${sock} is in the live daemon's socket folder (the operator's agent browser); the suite never runs there` };
  if ((env.CASES ?? "").split(",").includes("peer"))
    return { ok: false, message: "the group peer needs the stand-in daemon (the relay's --peer-check and the sessions' roots): it runs in the own mode only" };
  const control = env.CONTROL ? resolve(env.CONTROL) : "";
  if (!control || !o.executable(control)) return { ok: false, message: EXTERNAL_USAGE };
  return { ok: true, socket: sock, control };
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
