// Local connection evidence. A pending handshake alone cannot identify a Chrome approval prompt, so
// every record and message says "approval status unknown" rather than guess.

import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import { agentChromeBin, agentChromePid, agentEndpoint, findAgentPid } from "./agent.ts";
import { statePath, type NotifyHook, type Settings } from "./options.ts";

export function browserTarget(s: Settings, ps = () => execFileSync("ps", ["axww", "-o", "pid=,command="], { encoding: "utf8", timeout: 2000, maxBuffer: 64 << 20 })): string {
  if (s.mode === "personal") return "personal Chrome: operator's Chrome";
  if (s.endpoint) return "agent Chrome: configured endpoint override; browser channel unknown";
  let configured: string;
  try { configured = basename(agentChromeBin(s)); } catch { configured = "unknown"; }
  try {
    const rows = ps();
    const pid = findAgentPid(rows, s.profileDir);
    const command = rows.split("\n").find((line) => line.trim().startsWith(`${pid} `))?.trim().replace(/^\d+ /, "");
    if (pid && command) return `agent Chrome: agent browser on ${basename(command.split(" --")[0])} (pid ${pid})`;
  } catch { /* report the configured target without inventing a running channel */ }
  return `agent Chrome: agent browser, configured binary ${configured}; running channel unknown`;
}

export const proxyLogPath = (s: Settings) => statePath(s, "chrome-proxy.log");

export type ProxyAttempt = {
  at: string; attempt: string; pid: number; phase: string; target: string; upstream: string;
  code?: number | null; signal?: string | null; detail?: string; child?: number; approval: "unknown";
};

export function recordProxyAttempt(s: Settings, row: Omit<ProxyAttempt, "at" | "pid" | "approval">): void {
  try { appendFileSync(proxyLogPath(s), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, approval: "unknown", ...row }) + "\n"); }
  catch { /* a diagnostic never hides the connection result */ }
}

/** Read only the bounded tail. Preserve the latest attempt's timestamp, even when it is old. */
export function lastProxyAttempt(s: Settings): ProxyAttempt | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(proxyLogPath(s), "r");
    const size = fstatSync(fd).size, length = Math.min(size, 65536), bytes = Buffer.alloc(length);
    readSync(fd, bytes, 0, length, size - length);
    const rows: ProxyAttempt[] = [];
    for (const line of bytes.toString("utf8").split("\n").reverse()) {
      try {
        const row = JSON.parse(line);
        if (typeof row.at === "string" && typeof row.attempt === "string" && typeof row.phase === "string" && typeof row.target === "string") rows.push(row);
      } catch { /* free text or a partial line */ }
    }
    const latest = rows[0];
    if (!latest) return undefined;
    const attempt = rows.filter((row) => row.attempt === latest.attempt);
    const failure = attempt.find((row) => ["parent-timeout", "parent-lock-error", "parent-spawn-error", "child-error"].includes(row.phase));
    const exit = attempt.find((row) => row.phase === "parent-exit");
    return { ...latest, ...failure, ...(exit ? { code: exit.code, signal: exit.signal } : {}) };
  } catch { /* no attempts recorded */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return undefined;
}

export async function localBrowserStatus(s: Settings, deps: {
  target?: () => string; pid?: () => number | undefined; endpoint?: () => Promise<string | undefined>;
} = {}): Promise<string> {
  const target = (deps.target ?? (() => browserTarget(s)))();
  let step: string;
  if (s.mode === "agent") {
    if (s.endpoint) step = "DevTools endpoint override configured (unverified); proxy not connected";
    else {
      const pid = (deps.pid ?? (() => agentChromePid(s)))();
      const endpoint = await (deps.endpoint ?? (() => agentEndpoint(s)))();
      step = endpoint ? "DevTools endpoint found; proxy not connected" : pid ? `Chrome pid ${pid}; no live DevTools endpoint` : "no running Chrome found";
    }
  } else step = "no usable existing proxy; personal Chrome is not contacted";
  const last = lastProxyAttempt(s);
  const previous = last ? `; last attempt ${last.at} ${last.attempt}: ${last.phase} upstream=${last.upstream}${last.code !== undefined ? ` exit=${last.code}` : ""}${last.signal ? ` signal=${last.signal}` : ""}${last.detail ? ` (${last.detail})` : ""}` : "; no recorded proxy attempt";
  return `${target}; ${step}; approval status unknown${previous}; log ${proxyLogPath(s)}; run ${s.commandName} tabs to connect, then check Chrome for an approval prompt`;
}

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
