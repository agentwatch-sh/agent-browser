// Approve Chrome's per-connection "Allow remote debugging?" dialog, for unattended use.
//
// agent-browser keeps navigator.webdriver false by enabling remote debugging the chrome://inspect
// way (never --remote-debugging-port). The cost is that Chrome shows a native "Allow?" dialog for
// each new DevTools connection, and the grant is not remembered (verified on Linux Chromium 156:
// every connection re-prompts). Because the proxy holds ONE upstream connection per Chrome start,
// one approval per Chrome start is enough. This module performs that one approval, and only for the
// connection the proxy itself opens (runProxy fires it right as it connects upstream), so it never
// answers a dialog it did not cause.
//
// It is for the AGENT browser only. In personal mode the dialog guards the operator's own Chrome, so
// auto-approval is refused there (options.ts and makeApprover both reject it). It targets the agent
// Chrome by its own pid, so it never acts on another Chrome (for example the operator's) that happens
// to share the binary name.
//
// The dialog is native Chrome UI, not a web page, and we are not connected to CDP yet, so CDP cannot
// dismiss it: the click must be a real OS input event, which needs an OS tool. macOS uses osascript
// (Accessibility permission required); Linux uses xdotool (a virtual display required). Neither is an
// npm dependency; both are documented prerequisites. A custom `{ command }` replaces the built-in.
//
// Safety: the macOS mechanism clicks the button named "Allow" through the accessibility tree, so it
// can never hit "Cancel" or the left "Turn off in settings" button; if it cannot find "Allow" it
// clicks nothing. Success is confirmed by the upstream connection opening, never by this module.

import { execFile } from "node:child_process";
import { basename } from "node:path";
import { agentChromeBin, agentChromePid } from "./agent.ts";
import { validateApprove } from "./options.ts";
import type { Settings } from "./options.ts";

export type ApproveMechanism = "osascript" | "xdotool" | "command";

/** How long a single approver command may run (the dialog appears ~0.8 s after connect). */
export const APPROVE_TIMEOUT_MS = 15_000;

export type RunResult = { ok: boolean; detail: string };
export type Runner = (bin: string, args: string[], timeoutMs: number) => Promise<RunResult>;

const execRunner: Runner = (bin, args, timeoutMs) => new Promise((resolve) => {
  execFile(bin, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
    if (error) resolve({ ok: false, detail: `${bin}: ${String((stderr || error.message) ?? "").trim().slice(0, 300)}` });
    else resolve({ ok: true, detail: String(stdout).trim().slice(0, 300) });
  });
});

/** Which mechanism a spec selects on a platform; undefined means no approver. */
export function approveMechanism(spec: Settings["approve"], platform: NodeJS.Platform): ApproveMechanism | undefined {
  if (spec === undefined || spec === false) return undefined;
  if (typeof spec === "object") return "command";
  if (spec === "osascript") return "osascript";
  if (spec === "xdotool") return "xdotool";
  // true / "auto": pick by platform.
  return platform === "darwin" ? "osascript" : "xdotool";
}

/**
 * The AppleScript that clicks the "Allow" button by name. It addresses the agent Chrome by its unix
 * id when known (so it never touches another same-named Chrome, e.g. the operator's), falling back to
 * the process name only when the pid is unknown.
 */
export function osascriptApprove(processName: string, pid?: number): string {
  const name = processName.replace(/"/g, '\\"');
  const procRef = pid !== undefined ? `(first process whose unix id is ${pid})` : `process "${name}"`;
  const bring = pid !== undefined ? `set frontmost of ${procRef} to true` : `tell application "${name}" to activate`;
  return `tell application "System Events"
  try
    ${bring}
  end try
  delay 0.2
  tell ${procRef}
    repeat 40 times
      repeat with w in windows
        repeat with e in (entire contents of w)
          try
            if (role of e) is "AXButton" and (name of e) is "Allow" then
              click e
              return "clicked Allow"
            end if
          end try
        end repeat
      end repeat
      delay 0.25
    end repeat
    return "no Allow button found"
  end tell
end tell`;
}

/** The macOS process name of the agent browser (how System Events addresses it), from the binary path. */
export function macProcessName(chromeBin: string): string {
  return basename(chromeBin) || "Google Chrome";
}

export type ApproverDeps = {
  platform?: NodeJS.Platform;
  run?: Runner;
  chromeBin?: string;
  pid?: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * A function that performs the one approval, or undefined when approval is off or refused (personal
 * mode). It is best-effort: it never throws, and it logs what it did. The caller fires it as the
 * proxy opens upstream.
 */
export function makeApprover(s: Settings, deps: ApproverDeps = {}): (() => Promise<RunResult>) | undefined {
  if (s.approve === undefined || s.approve === false) return undefined;
  if (s.mode === "personal") return undefined; // never auto-approve the operator's own Chrome dialog
  validateApprove(s.approve);
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? execRunner;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const mechanism = approveMechanism(s.approve, platform);
  if (!mechanism) return undefined;

  if (mechanism === "command") {
    const command = (s.approve as { command: string[] }).command;
    return async () => {
      const r = await run(command[0], command.slice(1), APPROVE_TIMEOUT_MS);
      s.log(`approve: ran ${command[0]} (${r.ok ? r.detail || "ok" : r.detail})`);
      return r;
    };
  }

  if (mechanism === "osascript") {
    return async () => {
      const proc = macProcessName(deps.chromeBin ?? agentChromeBin(s));
      const pid = deps.pid ?? agentChromePid(s);
      const r = await run("osascript", ["-e", osascriptApprove(proc, pid)], APPROVE_TIMEOUT_MS);
      s.log(`approve (macOS, ${proc}${pid ? ` pid ${pid}` : ""}): ${r.ok ? r.detail : `failed: ${r.detail}`}`);
      return r;
    };
  }

  // xdotool (Linux): scope the keys to the agent Chrome's OWN window (found by its pid, waited for
  // with --sync), then let the dialog render and send Tab -> Allow, Return. This relies on the
  // dialog opening with focus on "Cancel", so pin the Chrome/Chromium version; for stronger safety
  // point `approve` at a verify-first custom command.
  return async () => {
    const pid = deps.pid ?? agentChromePid(s);
    if (!pid) { s.log("approve (Linux): no agent Chrome pid found; not approving"); return { ok: false, detail: "no agent Chrome pid" }; }
    const found = await run("xdotool", ["search", "--sync", "--onlyvisible", "--pid", String(pid)], APPROVE_TIMEOUT_MS);
    if (!found.ok) { s.log(`approve (Linux): window search failed: ${found.detail}`); return found; }
    const win = found.detail.split(/\s+/).filter(Boolean).pop();
    if (!win) { s.log("approve (Linux): no window for the agent Chrome pid"); return { ok: false, detail: "no window" }; }
    await run("xdotool", ["windowactivate", "--sync", win], APPROVE_TIMEOUT_MS);
    await sleep(1200); // the dialog renders inside the window (not a window of its own); give it a moment
    await run("xdotool", ["key", "--window", win, "--clearmodifiers", "Tab"], APPROVE_TIMEOUT_MS);
    const enter = await run("xdotool", ["key", "--window", win, "--clearmodifiers", "Return"], APPROVE_TIMEOUT_MS);
    s.log(`approve (Linux, window ${win}): ${enter.ok ? "sent Tab,Return to Allow" : `Return failed: ${enter.detail}`}`);
    return enter;
  };
}
