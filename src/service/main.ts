// `agent-browser service ...` on the command line (contract C12, "The command" and "The fake service"; boards
// ab-v16.94.2 and ab-v16.94.3). agentwatch's unit starts it from stage 2; nothing starts it before. Its log goes to
// standard error (the unit's journal), and it runs until SIGTERM or SIGINT, or until the owner rule says that it no
// longer owns the Chrome unit (then it exits 1, and Chrome stays for the next owner).
//
// `--test` (the live harness only; the design, section 13.1, stage 1): the service owns with no systemd unit, and the
// MainPID of the control door's admission is the service's parent (the harness). It is refused when any folder is a
// default folder, and it needs --test-display. `service stop --all` stops the Chrome unit with no service running. The
// folders have no default (stage 1c's rule): agentwatch's unit gives --lists-folder, --state-folder and --tools-dir.

import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { UsageError } from "../errors.ts";
import { defaultDaemonCommandFile } from "./admission.ts";
import { agentDoorAddress } from "./agent-door.ts";
import { encodeLine, serviceHello } from "./control.ts";
import { serviceRunFolders, startFake } from "./fake.ts";
import { defaultControlDoor, NotOwnerAtStart, packageInfo, startService } from "./service.ts";
import { GOOGLE_SOURCE, GoogleChromeTools, type ChromeSource } from "./unit/google-chrome.ts";
import { SERVICE_UNIT, systemdUnitState, testOwner } from "./unit/owner.ts";
import { defaultStateDir, defaultToolsDir, realOf, unitPaths } from "./unit/paths.ts";
import { Procs } from "./unit/procs.ts";
import { stopAll } from "./unit/stop-all.ts";

export const SERVICE_USAGE = "usage: agent-browser service --agent-door ADDRESS --lists-folder FOLDER --state-folder FOLDER --tools-dir FOLDER [--control-door PATH] [--daemon-unit UNIT] [--daemon-command FILE] [--service-unit UNIT]"
  + " | agent-browser service --hello [--fake] | agent-browser service --fake --control-door PATH [--agent-door ADDRESS] [--refuse]"
  + " | agent-browser service stop --all --state-folder FOLDER"
  + " (agentwatch's unit starts it, not a person)";

type Values = Record<string, string | boolean | undefined>;

/** Resolves at the first SIGTERM or SIGINT. */
const signalled = () => new Promise<void>((r) => { process.once("SIGTERM", () => r()); process.once("SIGINT", () => r()); });

/**
 * The displays that `--test` refuses (review-106 note 7): the harnesses' reserved displays, the same list as
 * RESERVED_DISPLAYS of test/live/guard.ts (a test keeps the two equal). :90 is agentwatch's agent browser.
 */
export const TEST_RESERVED_DISPLAYS: readonly number[] = Object.freeze([0, 90, 147, 190, 191, 192]);

/** True when `a` is `b`, or one holds the other. */
const overlaps = (a: string, b: string) => { const x = realOf(a), y = realOf(b); return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`); };

/**
 * The refusals of `--test`: each folder is given, and none is a default folder (the operator's state folder, tools
 * folder, the service's run folders, agentwatch's run folder) or holds one or lies in one; the display is a number
 * and no reserved display.
 */
export function testRefusal(v: { listsFolder?: string; stateFolder?: string; toolsDir?: string; controlDoor?: string; agentDoor?: string; daemonCommand?: string; display?: string }, env: Record<string, string | undefined> = process.env, uid = process.getuid?.() ?? -1): string | null {
  for (const [flag, x] of [["--lists-folder", v.listsFolder], ["--state-folder", v.stateFolder], ["--tools-dir", v.toolsDir], ["--control-door", v.controlDoor], ["--agent-door", v.agentDoor], ["--daemon-command", v.daemonCommand], ["--test-display", v.display]] as const) {
    if (!x) return `--test needs ${flag}: it never runs with a default`;
  }
  // Today's folders: agentwatch's browser state and tools folders, its config folder (the lists), the run folders.
  const config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(homedir(), ".config");
  const defaults = [defaultStateDir(), defaultToolsDir(), join(config, "agentwatch"), ...serviceRunFolders(env), `/run/user/${uid}/agentwatch`, dirname(defaultDaemonCommandFile(env))];
  if (env.XDG_RUNTIME_DIR && isAbsolute(env.XDG_RUNTIME_DIR)) defaults.push(join(env.XDG_RUNTIME_DIR, "agentwatch"));
  const folders: [string, string][] = [["--lists-folder", v.listsFolder!], ["--state-folder", v.stateFolder!], ["--tools-dir", v.toolsDir!], ["--control-door", dirname(v.controlDoor!)], ["--agent-door", dirname(v.agentDoor!)], ["--daemon-command", dirname(v.daemonCommand!)]];
  for (const [flag, f] of folders) for (const d of defaults) if (overlaps(f, d)) return `--test refuses ${flag} in or around a default folder (${d}): give it a temp folder`;
  if (!/^[0-9]{1,5}$/.test(v.display!)) return "--test-display must be a display number";
  const display = Number(v.display);
  if (TEST_RESERVED_DISPLAYS.includes(display)) return `--test-display names :${display}, a reserved display (${TEST_RESERVED_DISPLAYS.join(", ")}): --test never takes it; give another one`;
  return null;
}

/** The test-only source of Google Chrome (`--test-chrome-source FILE`): {"repo":"<abs folder>","key":"<abs file>","fingerprints":["<40 hex>"]}. */
export function testChromeSource(file: string): ChromeSource {
  let o: any;
  try { o = JSON.parse(readFileSync(file, "utf8")); } catch { throw new UsageError("--test-chrome-source must name a JSON file"); }
  if (!o || typeof o.repo !== "string" || !isAbsolute(o.repo) || typeof o.key !== "string" || !isAbsolute(o.key) || !Array.isArray(o.fingerprints) || !o.fingerprints.every((f: unknown) => typeof f === "string" && /^[0-9A-Fa-f]{40}$/.test(f))) {
    throw new UsageError("--test-chrome-source: {\"repo\":\"<absolute folder>\",\"key\":\"<absolute file>\",\"fingerprints\":[\"<40 hex>\"]}; a test source is a local folder, never a URL");
  }
  return { ...GOOGLE_SOURCE, repo: o.repo.replace(/\/+$/, ""), keyFile: o.key, fingerprints: o.fingerprints };
}

export async function serviceMain(v: Values, io: { stdout: Writable; stdin: Readable }, log: (line: string) => void, rest: string[] = []): Promise<number> {
  const str = (k: string) => {
    const x = v[k];
    if (x === "") throw new UsageError(`--${k} is empty`);
    return typeof x === "string" ? x : undefined;
  };
  if (rest.length) {
    // `service stop --all`: the Chrome unit stops, with no service running (the uninstall; the Mac's open point 3).
    if (rest.length !== 1 || rest[0] !== "stop" || v.all !== true) throw new UsageError(SERVICE_USAGE);
    for (const k of Object.keys(v)) if (k !== "all" && k !== "state-folder") throw new UsageError(`--${k} does not go with service stop --all`);
    const stateFolder = str("state-folder");
    if (!stateFolder) throw new UsageError("service stop --all needs --state-folder: the agent browser's state folder (no default)");
    const state = resolve(stateFolder);
    const stopped = await stopAll({ paths: unitPaths(state, defaultToolsDir()), procs: new Procs() });
    await new Promise<void>((r) => io.stdout.write(stopped.length ? `Stopped the agent browser: ${stopped.map(([n, p]) => `${n} pid ${p}`).join(", ")}\n` : "", () => r()));
    return 0;
  }
  if (v.all === true) throw new UsageError("--all goes with service stop");
  const fake = v.fake === true, test = v.test === true;
  if (v.refuse === true && !fake) throw new UsageError("--refuse goes with --fake");
  for (const k of ["test-display", "test-chrome-source"]) if (v[k] !== undefined && !test) throw new UsageError(`--${k} goes with --test`);
  if (test && fake) throw new UsageError("--test does not go with --fake");
  if (v.hello === true) {
    const { version, commit } = packageInfo();
    await new Promise<void>((r) => io.stdout.write(encodeLine(fake ? serviceHello(version, null, ["fake"]) : serviceHello(version, commit, [])), () => r()));
    return 0;
  }
  if (fake) {
    const controlDoor = str("control-door");
    if (!controlDoor) throw new UsageError("--fake needs --control-door: the fake never takes the place of the service");
    const agentDoor = str("agent-door");
    const f = await startFake({ controlDoor: resolve(controlDoor), agentDoor: agentDoor === undefined ? undefined : agentDoorAddress(agentDoor), refuse: v.refuse === true, input: io.stdin, log });
    // One line after the socket listens, so that a test waits for it (C12, the fake).
    await new Promise<void>((r) => io.stdout.write(encodeLine({ t: "listening" }), () => r()));
    await signalled();
    await f.stop();
    log("fake: stopped");
    return 0;
  }
  const agentDoor = str("agent-door");
  if (!agentDoor) throw new UsageError(`--agent-door is required: the agent door's address, which the daemon gives; ${SERVICE_USAGE}`);
  if (test) {
    const why = testRefusal({ listsFolder: str("lists-folder"), stateFolder: str("state-folder"), toolsDir: str("tools-dir"), controlDoor: str("control-door"), agentDoor, daemonCommand: str("daemon-command"), display: str("test-display") });
    if (why) throw new UsageError(why);
    if (str("service-unit")) throw new UsageError("--service-unit does not go with --test: --test owns with no unit");
  }
  // The folders have no default: the unit gives them (a test gives temp folders), so no run reads the operator's files by chance.
  const listsFolder = str("lists-folder"), stateFolder = str("state-folder"), toolsDir = str("tools-dir");
  if (!listsFolder) throw new UsageError(`--lists-folder is required: the folder of the lists (CONFIG_DIR/browser/lists), which agentwatch's unit gives; ${SERVICE_USAGE}`);
  if (!stateFolder) throw new UsageError(`--state-folder is required: the agent browser's state folder, which agentwatch's unit gives; ${SERVICE_USAGE}`);
  if (!toolsDir) throw new UsageError(`--tools-dir is required: the tools folder of Google Chrome, which agentwatch's unit gives; ${SERVICE_USAGE}`);
  const controlDoor = str("control-door") ?? defaultControlDoor();
  if (!controlDoor) throw new UsageError("--control-door is required when XDG_RUNTIME_DIR is not set");
  const paths = unitPaths(resolve(stateFolder), resolve(toolsDir));
  const display = test ? Number(str("test-display")) : null;
  const source = test && str("test-chrome-source") ? testChromeSource(resolve(str("test-chrome-source")!)) : undefined;
  let s;
  try {
    s = await startService({
      agentDoor: agentDoorAddress(agentDoor), controlDoor: resolve(controlDoor), daemonUnit: str("daemon-unit") ?? "agentwatch.service",
      daemonCommand: resolve(str("daemon-command") ?? defaultDaemonCommandFile()), log,
      // --test: the harness is the "daemon" (the service's parent), with its own expected command file.
      mainPid: test ? async () => process.ppid : undefined,
      lists: { listsFolder: resolve(listsFolder), stateFolder: paths.state },
      unit: {
        paths, owner: test ? testOwner() : systemdUnitState(str("service-unit") ?? SERVICE_UNIT),
        tools: new GoogleChromeTools({ tools: paths.tools, source, log }),
        part: display !== null ? { unit: { displays: { first: display, last: display } } } : undefined,
      },
    });
  } catch (e) {
    if (e instanceof NotOwnerAtStart) { log(`service: ${e.message}`); return 1; }
    throw e;
  }
  const why = await Promise.race([signalled().then(() => null), s.lost]);
  await s.stop();
  if (why !== null) { log(`service: exits: it no longer owns the Chrome unit (${why})`); return 1; }
  return 0;
}
