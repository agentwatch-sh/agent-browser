// The agent browser's Chrome: the flags that agent-browser's service starts it with (src/service/unit/), and the
// switches that a caller's flags never carry. agentwatch's agent browser is a separate Chrome on its own profile, so
// the operator's own Chrome (mail, banking, admin) is never reachable from the tooling.
//
// It is NEVER started with --remote-debugging-port: that flag makes navigator.webdriver true in every page, and
// Cloudflare, hCaptcha and Google then block even a human (verified on Chrome 154). The service drives it through the
// agent extension, and every client reaches it through agent mode's endpoint (board ab-v16.9.3: the CDP proxy and its
// "Allow remote debugging?" approvals are gone). assertSafeChromeArgs() enforces this for every start.

import { UsageError } from "./errors.ts";

/**
 * Google Chrome.app: on the Mac the service's agent browser is a second instance of it (measured 2026-11-03) with its
 * own profile, its own Dock icon and its own Cmd-Tab entry, so the operator's own Chrome and the agent browser stay
 * apart.
 */
export const CHROME_STABLE_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// No timer flag (--disable-background-timer-throttling, --disable-renderer-backgrounding; dropped in
// ab-v16.13): a site can measure its timers in a hidden tab, and with those flags they ran at full
// rate there, unlike in the operator's Chrome. A hidden tab's timers now slow down as in plain Chrome,
// and agent-browser still drives a tab that is not in front (README, **Launch flags and background tabs**).
export const AGENT_ARGS: readonly string[] = [
  "--no-first-run",
  "--no-default-browser-check",
  // The agent window usually sits behind the operator's windows. Without this flag macOS marks a
  // covered window's page hidden (no animation frames, slow timers) while the agent's clicks and
  // typing still reach it, so a site sees input on a hidden page (docs/research/
  // 2026-11-03-chrome-vs-chrome-beta.md, section 8, check 9). With it the page stays visible.
  "--disable-backgrounding-occluded-windows",
];

// The Chrome switches a caller's flags (the service's chrome_args) may never carry, by class:
// - remote debugging (every --remote-debugging-* switch) and automation mode (--enable-automation)
//   set navigator.webdriver, so bot checks then block every page;
// - --headless, in every form (--headless=new, --headless=old, ...), lets every page tell that the
//   browser is headless, so bot checks block it too;
// - --user-data-dir and --profile-directory: the caller's flags come AFTER the service's own
//   --user-data-dir, so either one could point the agent Chrome at another profile, for example
//   the operator's own.
// Match the switch NAME as Chrome's own parser reads it (base/command_line.cc), not the raw arg:
// one argv element is one switch; Chrome first trims whitespace from the element, accepts "--" or a
// single "-" as the prefix ("/" too on Windows), ends the name at the first "=", and lowercases the
// name on Windows. So a raw /^--/ test is a parser differential that "-remote-debugging-port" or
// " --headless" would slip through. Normalize first (trim, strip leading dashes/slashes, cut at "=",
// lowercase), then match: a superset of what Chrome reads as that switch. Text after a space or an
// "=" inside one element is that switch's value, never a second switch, so it is not inspected.
// A denylist on these classes is deliberate: chrome_args exists to pass arbitrary legitimate flags,
// so an allowlist would defeat it.
// The refusal names the switch by the text its pattern matched (lowercase letters, digits and "-"
// only), never the raw element: one element can hold the switch's value after a space or a "/"
// ("--headless /a/path"), and a value can be a path or a secret.
const REFUSED_SWITCHES: readonly { name: RegExp; why: string }[] = [
  {
    name: /^(?:remote-debugging-[a-z0-9-]*|enable-automation$)/,
    why: "it turns on remote debugging or automation mode, which sets navigator.webdriver and makes bot checks block every page; the service reaches its Chrome through the agent extension and agent mode's endpoint instead",
  },
  {
    name: /^headless/,
    why: "it runs Chrome headless, which every page can tell (the user agent carries the HeadlessChrome token), and bot checks then block it; the agent browser always runs Chrome with a window (on a box with no screen, give it a virtual display)",
  },
  {
    name: /^(?:user-data-dir|profile-directory)$/,
    why: "it would point the agent Chrome at another profile, for example the operator's own; the service sets the agent profile itself",
  },
];

/** The normalized switch name of one Chrome argv element (see above), or undefined if Chrome reads it as no switch. */
export function chromeSwitchName(arg: string): string | undefined {
  const trimmed = arg.trim();
  if (!/^[-/]/.test(trimmed)) return undefined;
  return trimmed.replace(/^[-/]+/, "").split("=")[0].toLowerCase();
}

/**
 * Refuse, before any spawn, a Chrome argv that turns on remote debugging, automation mode or
 * headless mode, or that names a profile (--user-data-dir, --profile-directory), in any dash, slash
 * or case form, with or without a value. Throws a UsageError that says why and names the switch as
 * "--" plus its canonical (matched, lowercase) name: never the element's value.
 */
export function assertSafeChromeArgs(args: readonly string[]): void {
  for (const arg of args) {
    const name = chromeSwitchName(arg);
    if (name === undefined) continue;
    for (const r of REFUSED_SWITCHES) {
      const m = r.name.exec(name);
      if (m) throw new UsageError(`refusing to launch Chrome with --${m[0]}: ${r.why}`);
    }
  }
}

/** The app bundle of a macOS Chrome binary (".../X.app/Contents/MacOS/X" -> ".../X.app"), or undefined. */
export function appBundle(bin: string): string | undefined {
  return /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(bin)?.[1];
}

export type ProcessRow = { pid: number; ppid: number; command: string };

/** Rows of `ps ax -o pid=,ppid=,command=`. */
export function parsePs(ps: string): ProcessRow[] {
  return ps.split("\n").flatMap((line) => {
    const m = line.trim().match(/^(\d+) +(\d+) (.*)$/);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }] : [];
  });
}

/**
 * Was this `ps` command line started with `--user-data-dir=<dir>`? Folders can contain spaces
 * ("Application Support", a checkout under "My Projects"), so the whole flag is matched between
 * spaces, not word by word; a longer folder that starts with `dir` does not match.
 */
export function hasUserDataDir(command: string, dir: string): boolean {
  return ` ${command} `.includes(` --user-data-dir=${dir} `);
}

/**
 * A process and everything below it, for example a Chrome's process tree to record its audio. Chrome starts its
 * renderers, GPU process and audio service as children of its main process, so this is one browser instance, and only
 * that one. Empty if `root` is not in `rows`.
 */
export function processTree(rows: ProcessRow[], root: number): number[] {
  if (!rows.some((r) => r.pid === root)) return [];
  const seen = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (!seen.has(r.pid) && seen.has(r.ppid)) { seen.add(r.pid); grew = true; }
  }
  return [...seen].sort((a, b) => a - b);
}
