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
/** Runs one approver command. `signal`: the proxy child stops it at once when its connection fails (a 403, a timeout). */
export type Runner = (bin: string, args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<RunResult>;

/** macOS's osascript, by its full path (never a program of that name earlier on PATH). */
export const OSASCRIPT = "/usr/bin/osascript";

export const execRunner: Runner = (bin, args, timeoutMs, signal) => new Promise((resolve) => {
  execFile(bin, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 1 << 20, ...(signal ? { signal } : {}) }, (error, stdout, stderr) => {
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

/** What the remote-debugging dialog's script prints after its click; any other output means that it clicked nothing. */
export const DEBUG_DIALOG_CLICKED = "clicked Allow in the remote-debugging dialog";

/**
 * The approve-after-wake click (wake.ts): "Allow" only in Chrome's "Allow remote debugging?" dialog, never another button
 * named Allow (a site's permission bubble, a page's button). The dialog is found by its own text: a window whose title, or
 * a static text outside any web content (AXWebArea), names remote debugging. Its scope is the smallest container of that
 * text that holds a button named Allow; the script clicks only when that scope holds no web content and exactly one such
 * button. Else it clicks nothing and prints why. Always by the agent Chrome's pid.
 */
export function osascriptApproveDebugDialog(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`not a pid: ${pid}`);
  return `on inWeb(e)
  tell application "System Events"
    set p to e
    repeat 80 times
      try
        if (role of p) is "AXWebArea" then return true
        set p to value of attribute "AXParent" of p
      on error
        return false
      end try
    end repeat
  end tell
  return true
end inWeb

on onlyAllow(scope)
  tell application "System Events"
    set found to missing value
    set n to 0
    repeat with x in (entire contents of scope)
      try
        set r to role of x
        if r is "AXWebArea" then return missing value
        if r is "AXButton" and (name of x) is "Allow" then
          set n to n + 1
          set found to contents of x
        end if
      end try
    end repeat
    if n is 1 then return found
  end tell
  return missing value
end onlyAllow

on dialogAllow(t)
  tell application "System Events"
    set p to t
    repeat 12 times
      try
        set p to value of attribute "AXParent" of p
      on error
        return missing value
      end try
      try
        if (role of p) is "AXWebArea" then return missing value
      end try
      set b to my onlyAllow(p)
      if b is not missing value then return b
      -- review-133b note 1: the walk stops at the dialog's window, so an Allow of another window can never get the click.
      try
        if (role of p) is "AXWindow" then return missing value
      end try
    end repeat
  end tell
  return missing value
end dialogAllow

on namesDebugging(e)
  tell application "System Events"
    try
      if ((value of e) as text) contains "remote debugging" then return true
    end try
    try
      if ((name of e) as text) contains "remote debugging" then return true
    end try
    try
      if ((description of e) as text) contains "remote debugging" then return true
    end try
  end tell
  return false
end namesDebugging

tell application "System Events"
  try
    set frontmost of (first process whose unix id is ${pid}) to true
  end try
  delay 0.2
  tell (first process whose unix id is ${pid})
    repeat 40 times
      repeat with w in windows
        try
          if (name of w) contains "remote debugging" then
            set b to my onlyAllow(w)
            if b is not missing value then
              click b
              return "${DEBUG_DIALOG_CLICKED}"
            end if
          end if
        end try
        repeat with e in (entire contents of w)
          try
            set el to contents of e
            if (role of el) is "AXStaticText" and my namesDebugging(el) and not my inWeb(el) then
              set b to my dialogAllow(el)
              if b is not missing value then
                click b
                return "${DEBUG_DIALOG_CLICKED}"
              end if
            end if
          end try
        end repeat
      end repeat
      delay 0.25
    end repeat
    return "no remote-debugging dialog found; clicked nothing"
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
export function makeApprover(s: Settings, deps: ApproverDeps = {}): ((signal?: AbortSignal) => Promise<RunResult>) | undefined {
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
    return async (signal) => {
      const r = await run(command[0], command.slice(1), APPROVE_TIMEOUT_MS, signal);
      s.log(`approve: ran ${command[0]} (${r.ok ? r.detail || "ok" : r.detail})`);
      return r;
    };
  }

  if (mechanism === "osascript") {
    return async (signal) => {
      const proc = macProcessName(deps.chromeBin ?? agentChromeBin(s));
      const pid = deps.pid ?? agentChromePid(s);
      const r = await run(OSASCRIPT, ["-e", osascriptApprove(proc, pid)], APPROVE_TIMEOUT_MS, signal);
      s.log(`approve (macOS, ${proc}${pid ? ` pid ${pid}` : ""}): ${r.ok ? r.detail : `failed: ${r.detail}`}`);
      return r;
    };
  }

  // xdotool (Linux): scope the keys to the agent Chrome's OWN window (found by its pid, waited for
  // with --sync), then let the dialog render and send Tab -> Allow, Return. This relies on the
  // dialog opening with focus on "Cancel", so pin the Chrome/Chromium version; for stronger safety
  // point `approve` at a verify-first custom command.
  return async (signal) => {
    const pid = deps.pid ?? agentChromePid(s);
    if (!pid) { s.log("approve (Linux): no agent Chrome pid found; not approving"); return { ok: false, detail: "no agent Chrome pid" }; }
    const found = await run("xdotool", ["search", "--sync", "--onlyvisible", "--pid", String(pid)], APPROVE_TIMEOUT_MS, signal);
    if (!found.ok) { s.log(`approve (Linux): window search failed: ${found.detail}`); return found; }
    const win = found.detail.split(/\s+/).filter(Boolean).pop();
    if (!win) { s.log("approve (Linux): no window for the agent Chrome pid"); return { ok: false, detail: "no window" }; }
    await run("xdotool", ["windowactivate", "--sync", win], APPROVE_TIMEOUT_MS, signal);
    await sleep(1200); // the dialog renders inside the window (not a window of its own); give it a moment
    if (signal?.aborted) { s.log("approve (Linux): stopped: the connection ended first"); return { ok: false, detail: "stopped" }; }
    await run("xdotool", ["key", "--window", win, "--clearmodifiers", "Tab"], APPROVE_TIMEOUT_MS, signal);
    const enter = await run("xdotool", ["key", "--window", win, "--clearmodifiers", "Return"], APPROVE_TIMEOUT_MS, signal);
    s.log(`approve (Linux, window ${win}): ${enter.ok ? "sent Tab,Return to Allow" : `Return failed: ${enter.detail}`}`);
    return enter;
  };
}
