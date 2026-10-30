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
// The dialog is native Chrome UI, not a web page, and we are not connected to CDP yet, so CDP cannot
// dismiss it: the click must be a real OS input event, which needs an OS tool. macOS uses osascript
// (Accessibility permission required); Linux uses xdotool (a virtual display required). Neither is an
// npm dependency; both are documented prerequisites. A custom `{ command }` replaces the built-in.
//
// Safety: the macOS mechanism clicks the button named "Allow" through the accessibility tree, so it
// can never hit "Cancel" or the left "Turn off in settings" button; if it cannot find "Allow" it
// clicks nothing. The success of an approval is confirmed by the upstream connection opening, never
// by this module's own claim.

import { execFile } from "node:child_process";
import { basename } from "node:path";
import type { ApproveSpec, Settings } from "./options.ts";
import { validateApprove } from "./options.ts";

export type ApproveMechanism = "osascript" | "xdotool" | "command";

/** How long to keep looking for the dialog before giving up (it appears ~0.8 s after connect). */
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
export function approveMechanism(spec: ApproveSpec | undefined, platform: NodeJS.Platform): ApproveMechanism | undefined {
  if (spec === undefined || spec === false) return undefined;
  if (typeof spec === "object") return "command";
  if (spec === "osascript") return "osascript";
  if (spec === "xdotool") return "xdotool";
  // true / "auto": pick by platform.
  return platform === "darwin" ? "osascript" : "xdotool";
}

/** The AppleScript that clicks the "Allow" button by name in the agent browser's process. */
export function osascriptApprove(processName: string): string {
  const p = processName.replace(/"/g, '\\"');
  return `tell application "${p}" to activate
delay 0.2
tell application "System Events" to tell process "${p}"
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
end tell`;
}

/** The macOS process name of the agent browser (how System Events addresses it), from the binary path. */
export function macProcessName(chromeBin: string): string {
  const name = basename(chromeBin); // "Google Chrome Beta" or "Google Chrome"
  return name || "Google Chrome";
}

/**
 * A function that performs the one approval, or undefined when approval is off. It is best-effort:
 * it never throws, and it logs what it did. The caller fires it as the proxy opens upstream.
 */
export function makeApprover(
  s: Settings,
  deps: { platform?: NodeJS.Platform; run?: Runner; chromeBin?: string } = {},
): (() => Promise<RunResult>) | undefined {
  if (s.approve === undefined || s.approve === false) return undefined;
  validateApprove(s.approve);
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? execRunner;
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
    const proc = macProcessName(deps.chromeBin ?? s.chromeBin ?? "Google Chrome");
    return async () => {
      const r = await run("osascript", ["-e", osascriptApprove(proc)], APPROVE_TIMEOUT_MS);
      s.log(`approve (macOS): ${r.ok ? r.detail : `failed: ${r.detail}`}`);
      return r;
    };
  }
  // xdotool (Linux): the agent browser is the one window on the virtual display; the dialog opens
  // with keyboard focus on "Cancel", so one Tab moves it to "Allow", then Return grants it (verified
  // on Chromium 156). This relies on the dialog's focus order, so pin the Chrome/Chromium version.
  return async () => {
    const seq = await run("xdotool", ["key", "--clearmodifiers", "Tab"], APPROVE_TIMEOUT_MS);
    if (!seq.ok) { s.log(`approve (Linux): xdotool Tab failed: ${seq.detail}`); return seq; }
    const enter = await run("xdotool", ["key", "--clearmodifiers", "Return"], APPROVE_TIMEOUT_MS);
    s.log(`approve (Linux): ${enter.ok ? "sent Tab,Return to Allow" : `Return failed: ${enter.detail}`}`);
    return enter;
  };
}
