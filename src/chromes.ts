// Every agent-browser Chrome of this user on the machine (#3): several agent browsers can run at
// once, and their windows look the same. Read only: the listing reads the process table (this user's
// rows only) and this user's own state-folder and profile files (it checks each one's owner first).
// It never connects to a Chrome (a new debugging connection raises Chrome's "Allow remote debugging?"
// prompt) and never signals a process.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { AGENT_ARGS, isBrowserChild, restoresOnStartup, STARTUP_PREFERENCES } from "./agent.ts";

/** One agent Chrome. A field that the evidence does not give is null. */
export type AgentChrome = {
  /** Its main process. */
  pid: number;
  /** The profile it runs on: its --user-data-dir. */
  profileDir: string;
  /** The consumer's state folder: from the window name of agent-browser's launch, else from a proxy of this profile, else the profile's parent when that holds a launches.log. */
  stateDir: string | null;
  /** Its window's name (the title): its last --window-name, only when the profile does not restore its session (then Chrome keeps the restored window's old name). */
  windowName: string | null;
  /** The consumer's command name: from the window name of agent-browser's launch, else from a proxy of this profile. */
  commandName: string | null;
  /** The state folder's approved proxy, when it is up: see approvedProxy. */
  proxy: { pid: number; upstream: string } | null;
};

export type UserProcess = { uid: number; pid: number; command: string };

/** Rows of `ps axww -o uid=,pid=,command=`: procps (Linux) and BSD ps (macOS) differ only in the column widths. */
export function parseUserPs(ps: string): UserProcess[] {
  return ps.split("\n").flatMap((line) => {
    const m = line.trim().match(/^(\d+) +(\d+) (.*)$/);
    return m ? [{ uid: Number(m[1]), pid: Number(m[2]), command: m[3] }] : [];
  });
}

// The browser binary as ps shows it. On Linux, Chrome titles its processes with its real binary
// (/proc/self/exe), so the path of a wrapper script (google-chrome, Debian's chromium) never shows.
const LINUX_CHROME = /^(?:chrome|chromium|chromium-browser|google-chrome(?:-beta|-unstable|-stable)?)$/;
const MAC_CHROME = /\/(Google Chrome(?: Beta| Dev| Canary)?|Chromium)\.app\/Contents\/MacOS\/([^/]+)$/;

/**
 * Is `argv0` the binary of a Chrome (any channel) or Chromium browser? It is one absolute path: a
 * " /" in it is a second argument (`/usr/bin/timeout 5 /opt/google/chrome/chrome`). A Helper app,
 * the crashpad handler, `open` and a program that only names a profile in its arguments are not.
 */
export function isChromeBinary(argv0: string): boolean {
  if (!argv0.startsWith("/") || argv0.includes(" /")) return false;
  const app = MAC_CHROME.exec(argv0);
  if (app) return app[1] === app[2];
  return !argv0.includes(" ") && LINUX_CHROME.test(basename(argv0));
}

/**
 * The value of the switch whose value starts at `at` in a ps command line. ps joins the argv with
 * spaces, and a folder can hold one, so the value runs to the next switch (" --x" or " -x", Chrome
 * reads both) or URL (" chrome://", " https://"): the elements that come after a value in
 * agent-browser's own launch. The limit: a folder whose name holds " -" and a letter, or " x://",
 * is read short at that point.
 */
function valueAt(command: string, at: number): string {
  const rest = command.slice(at), end = rest.search(/ (?:-[-a-z]|[a-z][a-z0-9+.-]*:\/\/)/i);
  return end < 0 ? rest : rest.slice(0, end);
}

/** The values of every `--<name>=` switch in a ps command line, in their order. */
function switchValues(command: string, name: string): string[] {
  const flag = ` --${name}=`, out: string[] = [];
  for (let at = command.indexOf(flag); at >= 0; at = command.indexOf(flag, at + flag.length)) out.push(valueAt(command, at + flag.length));
  return out;
}

/**
 * The profile of a Chrome main process: the browser binary, with no --type= (a renderer, GPU, zygote
 * or utility child carries one), on its last --user-data-dir (Chrome takes the last). Undefined for
 * any other process.
 */
export function chromeMainProfile(command: string): string | undefined {
  if (!isChromeBinary(command.split(" -")[0]) || isBrowserChild(command)) return undefined;
  return switchValues(command, "user-data-dir").at(-1) || undefined;
}

/**
 * agent-browser's own launch flags, as ps shows them in front of the profile (launchAgentChrome): today's,
 * and those of agent-browser 0.2.9 and before, which also had the two timer flags (dropped in ab-v16.13).
 * An agent Chrome that an earlier version started keeps its flags until it quits.
 */
const LAUNCHES = [
  AGENT_ARGS,
  ["--no-first-run", "--no-default-browser-check", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"],
].map((args) => ` ${args.join(" ")} --user-data-dir=`);

/** The command name and state folder in agent-browser's own window name (agentWindowName), which its launch puts right after the profile. */
function launchWindowName(command: string, profile: string): { commandName: string; stateDir: string } | undefined {
  const flag = ` --user-data-dir=${profile} --window-name=`, at = command.lastIndexOf(flag);
  if (at < 0) return undefined;
  const m = /^(.+?): (\/.*)$/.exec(valueAt(command, at + flag.length));
  return m ? { commandName: m[1], stateDir: m[2] } : undefined;
}

type ProxyRow = { pid: number; upstream: string; stateDir?: string; profileDir?: string; mode?: string; commandName?: string };

/** The upstream and the flags of an agent-browser proxy (proxyArgs in proxy.ts) from its ps command line, or undefined for any other process. */
function proxyRow(p: UserProcess): ProxyRow | undefined {
  const start = "/bin/agent-browser.js proxy ", at = p.command.indexOf(start);
  if (at < 0) return undefined;
  const [upstream, ...parts] = p.command.slice(at + start.length).split(" --");
  const flags = new Map<string, string>();
  // The first of each flag: a later one can only be inside a value (an approve command's JSON, which comes later).
  for (const part of parts) {
    const space = part.indexOf(" ");
    const name = space < 0 ? part : part.slice(0, space);
    if (!flags.has(name)) flags.set(name, space < 0 ? "" : part.slice(space + 1));
  }
  return { pid: p.pid, upstream, stateDir: flags.get("state-dir"), profileDir: flags.get("profile"), mode: flags.get("mode"), commandName: flags.get("command-name") };
}

/** What the listing needs of a path's stat: its owner and its kind. Undefined when the path is missing. */
export type StatLike = (path: string) => { uid: number; isFile(): boolean; isDirectory(): boolean } | undefined;

const statPath: StatLike = (path) => statSync(path, { throwIfNoEntry: false });

/** Is `path` a folder or a file of this user (`uid`)? The listing reads no other user's files. */
function owned(stat: StatLike, path: string, uid: number, kind: "dir" | "file"): boolean {
  try {
    const st = stat(path);
    return !!st && st.uid === uid && (kind === "dir" ? st.isDirectory() : st.isFile());
  } catch { return false; }
}

/** Does the path exist? A path that stat cannot reach (another user's folder) counts as there. */
function present(stat: StatLike, path: string): boolean {
  try { return stat(path) !== undefined; } catch { return true; }
}

/**
 * The approved proxy of `stateDir` for the Chrome on `profile`, or null. The proxy writes its pid file
 * (chrome-proxy.json) only once Chrome has accepted its connection, so it is approved and up when the
 * pid in that file is a live agent-browser proxy of this user, of this state folder and profile, in
 * agent mode, with the upstream that the file names. A stale file (that pid ended, or now belongs to
 * another process or to a later proxy) names no proxy.
 */
function approvedProxy(stat: StatLike, stateDir: string, profile: string, proxies: ProxyRow[], uid: number): AgentChrome["proxy"] {
  const file = join(stateDir, "chrome-proxy.json");
  if (!owned(stat, stateDir, uid, "dir") || !owned(stat, file, uid, "file")) return null;
  let info: { pid?: unknown; upstream?: unknown };
  try { info = JSON.parse(readFileSync(file, "utf8")) ?? {}; } catch { return null; }
  const { pid, upstream } = info;
  if (typeof pid !== "number" || !Number.isInteger(pid) || typeof upstream !== "string") return null;
  const live = proxies.find((p) => p.pid === pid);
  return live && live.stateDir === stateDir && live.profileDir === profile && live.mode === "agent" && live.upstream === upstream ? { pid, upstream } : null;
}

/** The state folder of a profile in its default place (`<state folder>/profile`), when agent-browser's launches.log is there. */
function launchedFrom(stat: StatLike, profile: string, uid: number): string | undefined {
  const dir = dirname(profile);
  return basename(profile) === "profile" && owned(stat, dir, uid, "dir") && owned(stat, join(dir, "launches.log"), uid, "file") ? dir : undefined;
}

/**
 * Does the profile restore its session? Undefined when that is not known: the profile or one of the
 * preference files that restoresOnStartup reads is another user's, so it is not read.
 */
function restoresSession(stat: StatLike, profile: string, uid: number): boolean | undefined {
  if (!owned(stat, profile, uid, "dir")) return undefined;
  for (const f of STARTUP_PREFERENCES) if (present(stat, join(profile, f)) && !owned(stat, join(profile, f), uid, "file")) return undefined;
  return restoresOnStartup(profile) === true;
}

/**
 * Every agent-browser Chrome of this user on the machine, by pid. An agent Chrome is a Chrome main
 * process (chromeMainProfile) that agent-browser started (its launch flags are in front of the
 * profile), or one on a profile that an agent-browser proxy of this user drives. Other users' rows
 * are skipped. It reads only the process table and this user's files.
 */
export function listAgentChromes(deps: { ps?: () => string; uid?: number; stat?: StatLike } = {}): AgentChrome[] {
  const uid = deps.uid ?? process.getuid!(), stat = deps.stat ?? statPath;
  const ps = deps.ps ?? (() => execFileSync("ps", ["axww", "-o", "uid=,pid=,command="], { encoding: "utf8", maxBuffer: 64 << 20 }));
  const rows = parseUserPs(ps()).filter((r) => r.uid === uid);
  const proxies = rows.flatMap((r) => proxyRow(r) ?? []);
  const chromes: AgentChrome[] = [];
  for (const { pid, command } of rows) {
    const profileDir = chromeMainProfile(command);
    if (profileDir === undefined) continue;
    const drivers = proxies.filter((p) => p.profileDir === profileDir && p.mode === "agent" && p.stateDir);
    if (!LAUNCHES.some((flags) => command.includes(`${flags}${profileDir}`)) && !drivers.length) continue;
    const launch = launchWindowName(command, profileDir);
    const driver = drivers.find((p) => approvedProxy(stat, p.stateDir!, profileDir, proxies, uid)) ?? drivers[0];
    const stateDir = launch?.stateDir ?? driver?.stateDir ?? launchedFrom(stat, profileDir, uid) ?? null;
    const name = switchValues(command, "window-name").at(-1);
    chromes.push({
      pid, profileDir, stateDir,
      windowName: name !== undefined && restoresSession(stat, profileDir, uid) === false ? name : null,
      commandName: launch?.commandName ?? driver?.commandName ?? null,
      proxy: stateDir === null ? null : approvedProxy(stat, stateDir, profileDir, proxies, uid),
    });
  }
  return chromes.sort((a, b) => a.pid - b.pid);
}
