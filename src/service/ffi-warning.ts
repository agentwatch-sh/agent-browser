// node:ffi's one ExperimentalWarning in the service process (board ab-v16.94.35). The service loads node:ffi at each start
// (on Linux the non-dumpable start's prctl, the control door's pidfd_open and the peer check's self-test; on the Mac
// libproc and sysctl), and Node printed "(node:<pid>) ExperimentalWarning: FFI is an experimental feature and might change
// at any time" in its journal at each start. The service drops that one warning, by its type and its exact text, in its
// own process; every other warning goes on to Node, which prints it as always. The service's command stays as agentwatch
// writes it (no --disable-warning flag). The relay with --peer-check is another process and keeps its warning.
//
// Node gives the warning through process.emitWarning (its internal emitExperimentalWarning calls it once per feature), so
// the filter wraps that function, as loader.js drops the one warning of stripTypeScriptTypes. A 'warning' listener alone
// cannot do it: Node's own listener prints each warning that reaches the event. The service sets the filter first, before
// any of its modules imports node:ffi (each does so dynamically, inside the service's start).

/** The text of node:ffi's ExperimentalWarning (Node 26). */
export const FFI_WARNING = "FFI is an experimental feature and might change at any time";

/** True for node:ffi's ExperimentalWarning only: its exact text with the type ExperimentalWarning, as a string or as a warning object. */
export function isFfiWarning(warning: unknown, type: unknown): boolean {
  if (typeof warning === "string") {
    const t = typeof type === "string" ? type : type !== null && typeof type === "object" ? (type as { type?: unknown }).type : undefined;
    return warning === FFI_WARNING && t === "ExperimentalWarning";
  }
  return warning instanceof Error && warning.name === "ExperimentalWarning" && warning.message === FFI_WARNING;
}

const quieted = new WeakSet<object>();

/** Drop node:ffi's ExperimentalWarning in this process (once; a second call does nothing); every other warning goes on to Node unchanged. */
export function quietFfiWarning(proc: NodeJS.Process = process): void {
  if (quieted.has(proc)) return;
  quieted.add(proc);
  const emit = proc.emitWarning;
  proc.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]): void {
    if (isFfiWarning(warning, rest[0])) return;
    return (emit as (...a: unknown[]) => void).call(this, warning, ...rest);
  } as typeof proc.emitWarning;
}
