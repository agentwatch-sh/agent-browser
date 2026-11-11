// What protects the service's memory (the design docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md,
// section 5.5; contract C12, "The stored sign-ins", the protections; board ab-v16.97.2). The open store key lives only in
// the service's memory, so the service opens the store only in a process where both protections hold:
//
// - dumpable: the service calls prctl(PR_SET_DUMPABLE, 0) at its start, through node:ffi (as the peer check loads it).
//   A process of the user without CAP_SYS_PTRACE then cannot attach the service or read its memory, also with
//   ptrace_scope 0, and no crash writes a core of it. Each check reads the flag again (PR_GET_DUMPABLE).
// - signal: the protection of board ab-v16.96 (hold SIGUSR1 at start; disable the inspector signal): the bin installs a
//   listener before any other code, or Node runs with --disable-sigusr1; and no inspector is open.
//
// The reason of the first protection that does not hold: `dumpable` comes before `signal` (C12).

import { url as inspectorUrl } from "node:inspector";

export const PROTECTIONS = ["dumpable", "signal"] as const;
export type Unprotected = (typeof PROTECTIONS)[number];

const PR_GET_DUMPABLE = 3, PR_SET_DUMPABLE = 4;
type Prctl = (option: number, a: bigint, b: bigint, c: bigint, d: bigint) => number;

/** prctl(2) through node:ffi; a failure gives its reason (node:ffi does not load, or the dlopen of libc fails). */
export async function loadPrctl(platform: NodeJS.Platform = process.platform): Promise<{ prctl: Prctl } | { failed: string }> {
  if (platform !== "linux") return { failed: `no prctl on ${platform}` };
  let ffi: any;
  try { const mod: any = await import("node:ffi"); ffi = mod.default ?? mod; }
  catch (e) { return { failed: `node:ffi does not load (${(e as { code?: string }).code ?? (e as Error).message})` }; }
  try {
    const { functions: f } = ffi.dlopen("libc.so.6", { prctl: { return: "int32", arguments: ["int32", "uint64", "uint64", "uint64", "uint64"] } });
    return { prctl: (o, a, b, c, d) => f.prctl(o, a, b, c, d) };
  } catch (e) { return { failed: `prctl does not load: ${(e as Error).message}` }; }
}

/**
 * The non-dumpable start: prctl(PR_SET_DUMPABLE, 0), then a reader of the flag for each later check. A failure leaves a
 * reader that always says "dumpable", with the reason for the log.
 */
export async function nonDumpableStart(load: () => Promise<{ prctl: Prctl } | { failed: string }> = () => loadPrctl()): Promise<{ dumpable: () => boolean; failed: string | null }> {
  const p = await load();
  if ("failed" in p) return { dumpable: () => true, failed: p.failed };
  if (p.prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n) !== 0) return { dumpable: () => true, failed: "prctl(PR_SET_DUMPABLE, 0) failed" };
  return { dumpable: () => p.prctl(PR_GET_DUMPABLE, 0n, 0n, 0n, 0n) !== 0, failed: null };
}

/** The protection of board ab-v16.96 holds: a SIGUSR1 listener or --disable-sigusr1, and no open inspector. */
export function signalHeld(o: { listeners?: () => number; execArgv?: readonly string[]; inspector?: () => string | undefined } = {}): boolean {
  const listeners = o.listeners ? o.listeners() : process.listenerCount("SIGUSR1");
  const argv = o.execArgv ?? process.execArgv;
  const open = (o.inspector ?? inspectorUrl)();
  return (listeners > 0 || argv.includes("--disable-sigusr1")) && open === undefined;
}

/** The reason of the first protection that does not hold, or null while both hold (C12: dumpable comes first). */
export function protectionReason(dumpable: () => boolean, signal: () => boolean = () => signalHeld()): Unprotected | null {
  if (dumpable()) return "dumpable";
  if (!signal()) return "signal";
  return null;
}
