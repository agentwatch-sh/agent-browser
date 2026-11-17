// The notify hook of `status --notify` (CLI --notify-command, Python notify_command=): one message to a callback or a
// command when agent mode's endpoint does not answer, so that an unattended caller can tell a person. It came from the
// old diagnostics (board ab-v16.9.3 removed the CDP proxy's diagnostics and approval notices; this hook stays).

import { execFile } from "node:child_process";
import type { NotifyHook, Settings } from "./options.ts";

export type NotifyResult = { delivery: "queued" | "unconfirmed"; detail: string };

export const NOTIFY_TIMEOUT_MS = 15_000;

/**
 * Run a notify command: an argv list, never a shell string. The message goes to its stdin, and an
 * argument "{message}" (or one that contains it) is replaced with the message text.
 */
export function runNotifyCommand(command: string[], message: string, timeoutMs = NOTIFY_TIMEOUT_MS): Promise<{ exitCode: number | null; failure?: string }> {
  const [bin, ...args] = command.map((a) => a.replaceAll("{message}", message));
  return new Promise((resolve) => {
    const child = execFile(bin, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024, encoding: "utf8" }, (error) => {
      if (!error) return resolve({ exitCode: 0 });
      if (typeof error.code === "number") return resolve({ exitCode: error.code });
      resolve({ exitCode: null, failure: error.killed ? "TIMEOUT" : typeof error.code === "string" ? error.code : "Error" });
    });
    child.stdin?.on("error", () => { /* EPIPE: the child ended first; the callback above reports why */ });
    child.stdin?.end(message);
  });
}

/** One explicit notification attempt. No automatic retry, and no claim about approval. */
export async function notifyBrowserStatus(s: Settings, detail: string, hook: NotifyHook | undefined = s.notify): Promise<NotifyResult> {
  const message = `${s.commandName} connection needs attention: ${detail}`;
  const unknown: NotifyResult = { delivery: "unconfirmed", detail: "notification unconfirmed (outcome unknown; check before retrying)" };
  if (!hook) return { delivery: "unconfirmed", detail: "no notify hook configured" };
  if (typeof hook === "function") {
    try { await hook(message); return { delivery: "queued", detail: "notification queued" }; } catch { return unknown; }
  }
  let r: { exitCode: number | null; failure?: string };
  try { r = await runNotifyCommand(hook.command, message); } catch { return unknown; }
  if (r.exitCode === 0) return { delivery: "queued", detail: "notification queued" };
  if (r.exitCode === null) return { delivery: "unconfirmed", detail: `notification unconfirmed (${r.failure ?? "no exit code"}; outcome unknown; check before retrying)` };
  return { delivery: "unconfirmed", detail: `notification unconfirmed (exit ${r.exitCode})` };
}
