// `agent-browser service ...` on the command line (contract C12, "The command" and "The fake service"; boards
// ab-v16.94.2 and ab-v16.94.3). agentwatch's unit starts it from stage 2; nothing starts it before. Its log goes to
// standard error (the unit's journal), and it runs until SIGTERM or SIGINT, or until the owner rule says that it no
// longer owns the Chrome unit (then it exits 1, and Chrome stays for the next owner).
//
// `--test` (the live harness only; the design, section 13.1, stage 1): the service owns with no systemd unit, and the
// MainPID of the control door's admission is the service's parent (the harness). It is refused when any folder is a
// default folder, and it needs --test-display. `service stop --all` stops the Chrome unit with no service running. The
// folders have no default (stage 1c's rule): agentwatch's unit gives --lists-folder, --state-folder and --tools-dir.
//
// The MCP path (stage 1d part 2b, board ab-v16.94.5; C11: off by default, it serves sessions from stage 3): the real
// service opens the MCP port only when systemd passes the socket of agent-browser-mcp.socket (the sd_listen_fds protocol,
// mcp/listen-fds.ts), on the Mac only when launchd gives it the socket of its job's Sockets entry agent-browser-mcp
// (launch_activate_socket, mcp/launchd-socket.ts; board ab-v16.94.30); `--test` opens it only with `--test-mcp-port PORT`,
// a free port on 127.0.0.1 that the harness gives (0: one that the kernel picks), never a default port. With neither, the
// service opens no MCP port.
//
// The carrier's switch (stage 5 T4, board ab-v16.94.7.5; C11, "The remote MCP path (stage 5)"; C12, "The command"):
// `--gateway-label <launchd label>` and `--gateway-command <file>` go together; agentwatch's install gives them only when
// stage 5 is on. With neither, the agent door has no carrier and the hello has no remote_scopes. The label names a launchd
// job, so only the Mac reads it; a Linux serving box comes later, and on Linux the switch gives no carrier. In `--test`
// mode only, `--test-gateway-pid <pid>` takes the place of the label: the live harness's fake gateway (no unit, no job).
//
// The stored sign-ins (stage 1e part 1, board ab-v16.97.2; C12, "The stored sign-ins"): on Linux the service makes itself
// non-dumpable at its start (prctl through node:ffi), before it opens any door, and it has the store with the feature
// sign_ins; the store opens only while both protections of its memory hold (signins/protect.ts). On the Mac the service
// makes the Mac's protected start at the same place (board ab-v16.97.8, part 2: ptrace PT_DENY_ATTACH, RLIMIT_CORE 0,
// and the checks of get-task-allow, SIP and DevToolsSecurity), with one log line before it and one with its result; the
// store stays off there until stage 4 (board ab-v16.97.14), so its hello has no sign_ins.
//
// The card payment (board ab-sta.7; C11, the card payment; C12, the card payments): `--card-pay`, off by default, and
// agentwatch does not pass it yet. On Linux only (the stored sign-ins' store holds the card): the hello then has the
// feature card_pay, and the MCP path serves browser_pay and browser_pay_status for a local admission. It does not go with
// --fake (the fake never has the feature). In `--test` mode with `--card-pay` only, `--test-provider-origin <origin>`
// (board ab-sta.8, the live check of the card payment) adds the test merchant's provider origin, a *.localhost origin, to
// the payment act's provider origins of this run, and `--test-provider-api <origin>` gives that test provider its API
// origin on a second *.localhost host: never a real provider's origin, and never the shipped list (pay/providers.ts).

import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { UsageError } from "../errors.ts";
import { normalizeEntry, SCOPE } from "../relay/scopes.ts";
import { defaultDaemonCommandFile } from "./admission.ts";
import { agentDoorAddress } from "./agent-door.ts";
import { encodeLine, serviceHello } from "./control.ts";
import { FAKE_FEATURES, serviceRunFolders, startFake, UNPROTECTED, type Unprotected } from "./fake.ts";
import { defaultControlDoor, NotOwnerAtStart, packageInfo, startService } from "./service.ts";
import { mcpListen } from "./mcp/listen-fds.ts";
import { launchdMcpListen } from "./mcp/launchd-socket.ts";
import { GOOGLE_SOURCE, GoogleChromeTools, type ChromeSource } from "./unit/google-chrome.ts";
import { SERVICE_UNIT, systemdUnitState, testOwner } from "./unit/owner.ts";
import { launchdMainPid, launchdUnitState, loadMacLib, MAC_DAEMON_LABEL, MAC_SERVICE_LABEL, MacProcs, type MacLib } from "./mac.ts";
import { defaultStateDir, defaultToolsDir, realOf, unitPaths } from "./unit/paths.ts";
import { Procs } from "./unit/procs.ts";
import { stopAll } from "./unit/stop-all.ts";
import { stopBlanket, stopBlanketLine } from "./unit/stop-blanket.ts";
import { quietFfiWarning } from "./ffi-warning.ts";
import { CARD_PAY_FEATURE, SIGN_INS_FEATURE } from "./signins/part.ts";
import { macProtectedStart, nonDumpableStart, protectionReason } from "./signins/protect.ts";

export const SERVICE_USAGE = "usage: agent-browser service --agent-door ADDRESS --lists-folder FOLDER --state-folder FOLDER --tools-dir FOLDER [--control-door PATH] [--daemon-unit UNIT] [--daemon-command FILE] [--service-unit UNIT] [--gateway-label LABEL --gateway-command FILE] [--card-pay] [--test --test-display N [--test-mcp-port PORT [--test-mcp-remote-scope SCOPE]] [--test-merge-guard-host HOST.localhost] [--test-gateway-pid PID] [--test-provider-origin ORIGIN [--test-provider-api ORIGIN]]]"
  + " | agent-browser service --hello [--fake] | agent-browser service --fake --control-door PATH [--agent-door ADDRESS] [--refuse] [--unprotected dumpable|signal]"
  + " | agent-browser service stop --all --state-folder FOLDER | agent-browser service stop --blanket --state-folder FOLDER"
  + " (agentwatch's unit starts it, not a person)";

type Values = Record<string, string | boolean | undefined>;

/** The link socket of the native link (stage 1b part 2): `link.sock` in the folder of control.sock. */
export const linkSocketFor = (controlDoor: string) => join(dirname(controlDoor), "link.sock");

/**
 * The features of the real service's hello that its run fixes at its start: sign_ins on Linux (C12; the Mac at stage 4),
 * and card_pay next to it only with `--card-pay` (board ab-sta.7).
 */
export const serviceFeatures = (platform: NodeJS.Platform = process.platform, cardPay = false): string[] => (platform === "linux" ? [SIGN_INS_FEATURE, ...(cardPay ? [CARD_PAY_FEATURE] : [])] : []);

/** The result of a start of the memory's protection: the reader for each later check, and the failure for the log. */
export type MemoryProtection = { dumpable: () => boolean; failed: string | null };

/** The log line before the Mac's protected start (review M5: a service that a debugger traces exits at the ptrace call). */
export const MAC_START_BEGINS = "service: the Mac's protected start begins";
/** The log line of the Mac's protected start when each of its checks holds; it names the checks, and claims no more. */
export const MAC_START_HOLDS = "service: the Mac's protected start holds (ptrace PT_DENY_ATTACH, RLIMIT_CORE 0, no get-task-allow, SIP enabled, DevToolsSecurity disabled); the stored sign-ins stay off on the Mac";

/**
 * The protection of the service's memory (the design, section 5.5), at the service's start before any door opens, and its
 * log line. On Linux the non-dumpable start: its reader goes to the store. On the Mac a line before the Mac's protected
 * start (board ab-v16.97.8, part 2), then the start: its result is only logged, and the store stays off until board
 * ab-v16.97.14, so it gives null (no store part, no sign_ins). On another system nothing runs: null.
 */
export async function memoryStart(
  platform: NodeJS.Platform, log: (line: string) => void,
  starts: { linux: () => Promise<MemoryProtection>; mac: () => Promise<MemoryProtection> } = { linux: () => nonDumpableStart(), mac: () => macProtectedStart() },
): Promise<MemoryProtection | null> {
  if (platform === "linux") {
    const m = await starts.linux();
    log(m.failed === null ? "service: the process is not dumpable (prctl PR_SET_DUMPABLE 0)" : `service: the process stays dumpable (${m.failed}), so the stored sign-ins do not open`);
    return m;
  }
  if (platform === "darwin") {
    log(MAC_START_BEGINS);
    const m = await starts.mac();
    log(m.failed === null ? MAC_START_HOLDS : `service: the Mac's protected start does not hold (${m.failed}); the stored sign-ins stay off on the Mac`);
    return null;
  }
  return null;
}

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

/** `--test-mcp-port`: a port number, 0 (the kernel picks a free one) or 1024 to 65535; the port is always on 127.0.0.1. */
export function testMcpPort(raw: string): number {
  const n = /^[0-9]{1,5}$/.test(raw) ? Number(raw) : -1;
  if (n !== 0 && (n < 1024 || n > 65535)) throw new UsageError("--test-mcp-port must be 0 (a free port) or a port from 1024 to 65535 on 127.0.0.1");
  return n;
}

/**
 * `--test-mcp-remote-scope` (board ab-v16.97.5; C11, the sign-in act): the one scope whose MCP connections get the
 * admission `remote`, a stand-in of stage 5's remote token for the live check of the stored sign-ins' MCP tools. Only a
 * scope name (C11's pattern). It only takes rights away: the port still runs steps 1 to 8 for each request.
 */
export function testMcpRemoteScope(raw: string): string {
  if (!SCOPE.test(raw)) throw new UsageError("--test-mcp-remote-scope must be a scope name: a letter or a digit, then letters, digits, '.', '_' or '-', at most 64 in all");
  return raw;
}

/**
 * The service's MCP option (stage 1d part 2b; board ab-v16.97.5): the port's socket, and with `--test-mcp-remote-scope`
 * the port's set of the one scope whose requests get the admission `remote` (the live check's stand-in).
 */
export function mcpOption<L>(listen: L, remoteScope: string | undefined): { listen: L; port?: { remote: ReadonlySet<string> } } {
  return { listen, ...(remoteScope !== undefined ? { port: { remote: new Set([remoteScope]) } } : {}) };
}

/**
 * The carrier's switch (stage 5 T4; C12): `--gateway-label` and `--gateway-command` together, or in `--test` mode
 * `--test-gateway-pid` with `--gateway-command` (never with the label). The label and the file as given, the test pid;
 * null with no switch. serviceMain says why a box's switch gives no carrier (on Linux the label names no job).
 */
export function gatewayOption(v: Values, test: boolean): { label: string | null; commandFile: string; testPid: number | null } | null {
  const s = (k: string) => { const x = v[k]; if (x === "") throw new UsageError(`--${k} is empty`); return typeof x === "string" ? x : undefined; };
  const label = s("gateway-label"), file = s("gateway-command"), pid = s("test-gateway-pid");
  if (pid !== undefined) {
    if (!test) throw new UsageError("--test-gateway-pid goes with --test");
    if (label !== undefined) throw new UsageError("--test-gateway-pid does not go with --gateway-label: it takes the label's place in --test");
    if (!/^[1-9][0-9]{0,9}$/.test(pid)) throw new UsageError("--test-gateway-pid must be a pid: a number above 0");
    if (file === undefined) throw new UsageError("--test-gateway-pid goes with --gateway-command");
    return { label: null, commandFile: file, testPid: Number(pid) };
  }
  if (label !== undefined && file === undefined) throw new UsageError("--gateway-label goes with --gateway-command");
  if (file !== undefined && label === undefined) throw new UsageError("--gateway-command goes with --gateway-label (or, in --test, with --test-gateway-pid)");
  return label === undefined ? null : { label, commandFile: file!, testPid: null };
}

/**
 * `--test-merge-guard-host` (board ab-v16.99; C11, the merge guard): a stand-in of GitHub for the live check, beside GitHub's
 * own hosts. Only a normalized host under .localhost (a loopback name in Chrome), never a real host, so a test page can
 * never mark or unmark a real host.
 */
export function testMergeGuardHost(raw: string): string {
  const h = normalizeEntry(raw);
  if (h === null || h !== raw || !h.endsWith(".localhost")) throw new UsageError("--test-merge-guard-host must be a host under .localhost (a stand-in of GitHub), in its normalized form");
  return h;
}

/**
 * `--test-provider-origin` (board ab-sta.8; C11, the card payment, the list of payment providers' origins): the test
 * merchant's provider origin for the live check of the card payment (test/fixtures/pay-merchant/, `pay.localhost`). Only
 * an `http:` or `https:` origin as the WHATWG URL parser gives it (no path, no query, no user) whose host is a name under
 * .localhost (a loopback name in Chrome), so a test can never make a real host a provider. It never goes to the shipped
 * list (pay/providers.ts, PROVIDER_ORIGINS).
 */
export function testProviderOrigin(raw: string, flag: "--test-provider-origin" | "--test-provider-api" = "--test-provider-origin"): string {
  const u = URL.canParse(raw) ? new URL(raw) : null;
  if (u === null || u.origin !== raw || (u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname.endsWith(".localhost") || u.hostname === ".localhost") {
    throw new UsageError(`${flag} must be an origin of a host under .localhost (the test merchant's provider), for example http://pay.localhost:8080`);
  }
  return raw;
}

/** `--test-provider-api` (board ab-sta.8): an origin as `--test-provider-origin` takes it, and another one than that flag's. */
export function testProviderApi(raw: string, providerOrigin: string): string {
  const api = testProviderOrigin(raw, "--test-provider-api");
  if (api === providerOrigin) throw new UsageError("--test-provider-api must be another origin than --test-provider-origin: the provider's API on a second host");
  return api;
}

/**
 * The service's option of the payment act (board ab-sta.7): with `--test-provider-origin` (board ab-sta.8), that one test
 * frame origin, and with `--test-provider-api` the test provider's one API origin.
 */
export function payActOption(providerOrigin: string | undefined, providerApi?: string): { providerOrigins?: readonly string[]; providerApis?: readonly string[] } {
  if (providerOrigin === undefined) return {};
  return { providerOrigins: Object.freeze([providerOrigin]), ...(providerApi !== undefined ? { providerApis: Object.freeze([providerApi]) } : {}) };
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

/**
 * The process reads of `service stop --all`: /proc on Linux, libSystem on the Mac (board ab-v16.94.6; review-145 B2). On a
 * Mac whose libSystem does not load, or whose process list cannot be read, the command fails: it never reports a stop
 * that it could not make.
 */
export async function stopAllProcs(platform: NodeJS.Platform = process.platform, load: () => Promise<MacLib | { failed: string }> = loadMacLib): Promise<Procs> {
  const p = await stopProcs(platform, load);
  if ("failed" in p) throw new Error(`service stop --all cannot read the processes on the Mac (${p.failed}), so it stops nothing`);
  return p;
}

/** The process reads of `service stop --all` and `service stop --blanket` (board ab-4wh.17), or why the Mac's do not load. */
export async function stopProcs(platform: NodeJS.Platform = process.platform, load: () => Promise<MacLib | { failed: string }> = loadMacLib): Promise<Procs | { failed: string }> {
  if (platform !== "darwin") return new Procs();
  const lib = await load();
  if ("failed" in lib) return { failed: lib.failed };
  // A proc_listallpids that fails is an error too, never an empty list (review-145b N6).
  return new MacProcs(lib, { strict: true });
}

/**
 * Board ab-dbm: each line of the running service's log with its UTC time first (ISO 8601, whole seconds), for the Mac,
 * where launchd writes the log to a plain file with no time. Linux's journal gives each line its time.
 */
export const stampedLog = (log: (line: string) => void, now: () => number = Date.now) =>
  (line: string) => log(`${new Date(now()).toISOString().replace(/\.\d{3}Z$/, "Z")} ${line}`);

export async function serviceMain(v: Values, io: { stdout: Writable; stdin: Readable }, log: (line: string) => void, rest: string[] = []): Promise<number> {
  // Before any import of node:ffi (each is dynamic, inside the service's start): no ExperimentalWarning of node:ffi in the
  // service's journal, and every other warning as Node prints it (board ab-v16.94.35; ffi-warning.ts).
  quietFfiWarning();
  const str = (k: string) => {
    const x = v[k];
    if (x === "") throw new UsageError(`--${k} is empty`);
    return typeof x === "string" ? x : undefined;
  };
  if (rest.length) {
    // `service stop --all`: the Chrome unit stops, with no service running (the uninstall; the Mac's open point 3).
    // `service stop --blanket` (board ab-4wh.17; unit/stop-blanket.ts): after a crash of the service, the blanket Chrome
    // stops and its folder goes, unless a service runs on the state folder; its exit code is its result.
    const all = v.all === true, blanket = v.blanket === true;
    if (rest.length !== 1 || rest[0] !== "stop" || (!all && !blanket)) throw new UsageError(SERVICE_USAGE);
    if (all && blanket) throw new UsageError("--all and --blanket do not go together: service stop takes one of them");
    const what = blanket ? "service stop --blanket" : "service stop --all";
    for (const k of Object.keys(v)) if (k !== "all" && k !== "blanket" && k !== "state-folder") throw new UsageError(`--${k} does not go with ${what}`);
    const stateFolder = str("state-folder");
    if (!stateFolder) throw new UsageError(`${what} needs --state-folder: the agent browser's state folder (no default)`);
    const state = resolve(stateFolder);
    if (blanket) {
      const r = await stopBlanket({ paths: { state }, procs: () => stopProcs(), log });
      const line = stopBlanketLine(r);
      await new Promise<void>((done) => io.stdout.write(line, () => done()));
      return r.code;
    }
    const stopped = await stopAll({ paths: unitPaths(state, defaultToolsDir()), procs: await stopAllProcs(), log });
    await new Promise<void>((r) => io.stdout.write(stopped.length ? `Stopped the agent browser: ${stopped.map(([n, p]) => `${n} pid ${p}`).join(", ")}\n` : "", () => r()));
    return 0;
  }
  if (v.all === true) throw new UsageError("--all goes with service stop");
  if (v.blanket === true) throw new UsageError("--blanket goes with service stop");
  const fake = v.fake === true, test = v.test === true;
  if (v.refuse === true && !fake) throw new UsageError("--refuse goes with --fake");
  if (v.unprotected !== undefined && !fake) throw new UsageError("--unprotected goes with --fake");
  if (v.unprotected !== undefined && !UNPROTECTED.includes(v.unprotected as Unprotected)) throw new UsageError("--unprotected takes dumpable or signal");
  for (const k of ["test-display", "test-chrome-source", "test-mcp-port", "test-mcp-remote-scope", "test-gateway-pid", "test-provider-origin", "test-provider-api", "test-merge-guard-host"]) if (v[k] !== undefined && !test) throw new UsageError(`--${k} goes with --test`);
  if (fake && (v["gateway-label"] !== undefined || v["gateway-command"] !== undefined)) throw new UsageError("--gateway-label and --gateway-command do not go with --fake");
  if (v["test-mcp-remote-scope"] !== undefined && v["test-mcp-port"] === undefined) throw new UsageError("--test-mcp-remote-scope goes with --test-mcp-port");
  if (test && fake) throw new UsageError("--test does not go with --fake");
  // The card payment (board ab-sta.7): Linux only, never the fake's.
  const cardPay = v["card-pay"] === true;
  if (cardPay && fake) throw new UsageError("--card-pay does not go with --fake: the fake never has the card payment");
  if (cardPay && process.platform !== "linux") throw new UsageError("--card-pay works only on Linux: the stored sign-ins and cards are off on this box");
  if (v["test-provider-origin"] !== undefined && !cardPay) throw new UsageError("--test-provider-origin goes with --card-pay");
  if (v["test-provider-api"] !== undefined && v["test-provider-origin"] === undefined) throw new UsageError("--test-provider-api goes with --test-provider-origin");
  if (v.hello === true) {
    const { version, commit } = packageInfo();
    await new Promise<void>((r) => io.stdout.write(encodeLine(fake ? serviceHello(version, null, FAKE_FEATURES) : serviceHello(version, commit, serviceFeatures(process.platform, cardPay))), () => r()));
    return 0;
  }
  if (fake) {
    const controlDoor = str("control-door");
    if (!controlDoor) throw new UsageError("--fake needs --control-door: the fake never takes the place of the service");
    const agentDoor = str("agent-door");
    const f = await startFake({ controlDoor: resolve(controlDoor), agentDoor: agentDoor === undefined ? undefined : agentDoorAddress(agentDoor), refuse: v.refuse === true, unprotected: v.unprotected as Unprotected | undefined, input: io.stdin, log });
    // One line after the socket listens, so that a test waits for it (C12, the fake).
    await new Promise<void>((r) => io.stdout.write(encodeLine({ t: "listening" }), () => r()));
    await signalled();
    await f.stop();
    log("fake: stopped");
    return 0;
  }
  // The running service on the Mac (board ab-dbm): each log line starts with its UTC time (stampedLog).
  if (process.platform === "darwin") log = stampedLog(log);
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
  // The protection of the memory (the design, section 5.5): before any door opens. On Linux the non-dumpable start, and
  // the store opens only while it holds; on the Mac the Mac's protected start, only logged (no store until ab-v16.97.14).
  const darwin = process.platform === "darwin";
  const memory = await memoryStart(process.platform, log);
  const paths = unitPaths(resolve(stateFolder), resolve(toolsDir));
  const display = test ? Number(str("test-display")) : null;
  // The MCP port: --test's port, or systemd's socket (never in --test), else none; the LISTEN_* variables go in every
  // path. A take that fails leaves the MCP path failed (status says so); the socket unit keeps the port (fail closed).
  // On the Mac launchd's socket in place of systemd's (board ab-v16.94.30; mcp/launchd-socket.ts): the job's Sockets
  // entry agent-browser-mcp, never in --test; launchd keeps the port when the take fails.
  const testPort = str("test-mcp-port");
  const listen = darwin
    ? await launchdMcpListen({ test, testPort: test && testPort !== undefined ? testMcpPort(testPort) : undefined, log })
    : await mcpListen({ test, testPort: test && testPort !== undefined ? testMcpPort(testPort) : undefined });
  const source = test && str("test-chrome-source") ? testChromeSource(resolve(str("test-chrome-source")!)) : undefined;
  const guardHost = test && str("test-merge-guard-host") ? testMergeGuardHost(str("test-merge-guard-host")!) : undefined;
  const remoteScope = test && str("test-mcp-remote-scope") !== undefined ? testMcpRemoteScope(str("test-mcp-remote-scope")!) : undefined;
  // The test merchant's provider origin (board ab-sta.8): --test with --card-pay only.
  const providerOrigin = test && cardPay && str("test-provider-origin") !== undefined ? testProviderOrigin(str("test-provider-origin")!) : undefined;
  const providerApi = providerOrigin !== undefined && str("test-provider-api") !== undefined ? testProviderApi(str("test-provider-api")!, providerOrigin) : undefined;
  // The carrier's switch (stage 5 T4): the Mac reads the label's job from launchctl at each accept; --test takes the fake
  // gateway's pid; on Linux the label gives no carrier (a Linux serving box comes later).
  const gw = gatewayOption(v, test);
  const gateway = gw === null ? undefined
    : gw.testPid !== null ? { mainPid: async () => gw.testPid, commandFile: resolve(gw.commandFile) }
    : darwin ? { mainPid: launchdMainPid(gw.label!), commandFile: resolve(gw.commandFile) }
    : undefined;
  if (gw !== null && gateway === undefined) log("service: the agent door has no carrier: --gateway-label names a launchd job, and only the Mac has one (a Linux serving box comes later)");
  let s;
  try {
    s = await startService({
      agentDoor: agentDoorAddress(agentDoor), controlDoor: resolve(controlDoor), daemonUnit: str("daemon-unit") ?? (darwin ? MAC_DAEMON_LABEL : "agentwatch.service"),
      daemonCommand: resolve(str("daemon-command") ?? defaultDaemonCommandFile()), log,
      // --test: the harness is the "daemon" (the service's parent), with its own expected command file.
      mainPid: test ? async () => process.ppid : undefined,
      lists: { listsFolder: resolve(listsFolder), stateFolder: paths.state },
      unit: {
        // The owner rule reads the service's own unit: its systemd unit, or on the Mac its launchd job (board ab-v16.94.6).
        paths, owner: test ? testOwner() : darwin ? launchdUnitState(str("service-unit") ?? MAC_SERVICE_LABEL) : systemdUnitState(str("service-unit") ?? SERVICE_UNIT),
        tools: new GoogleChromeTools({ tools: paths.tools, source, log }),
        part: display !== null ? { unit: { displays: { first: display, last: display } } } : undefined,
      },
      // The native link (stage 1b part 2): link.sock next to control.sock, in the service's run folder.
      link: { socket: linkSocketFor(resolve(controlDoor)) },
      // The MCP path (stage 1d part 2b): only with its socket.
      // --test-mcp-remote-scope: that scope's MCP connections get the remote admission (the live check's stand-in).
      ...(listen ? { mcp: mcpOption(listen, remoteScope) } : {}),
      // The stored sign-ins (stage 1e part 1): on Linux only, with the protections of the service's memory.
      ...(memory ? { signIns: { protections: () => protectionReason(memory.dumpable) } } : {}),
      // The card payment (board ab-sta.7): only with --card-pay, off by default; --test-provider-origin: --test only.
      ...(cardPay && memory ? { payAct: payActOption(providerOrigin, providerApi) } : {}),
      // The merge guard's stand-in host (board ab-v16.99): --test only.
      ...(guardHost ? { mergeGuard: { testHosts: [guardHost] } } : {}),
      // The carrier's switch (stage 5 T4): off by default.
      ...(gateway ? { gateway } : {}),
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
