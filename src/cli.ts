// `agent-browser <command> ... [--json]`. With --json each call prints exactly one JSON document on
// standard output, success or failure; progress and warnings go to standard error. Exit status: 0 on
// success, 1 on a failure, 2 on a usage error. The consumer's own folders come in as flags, never
// from the environment, so two consumers on one machine never share a state folder by accident.

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { commands, COMMAND_SPECS, type CommandName, type CommandSpec } from "./commands.ts";
import { errorCode, UsageError } from "./errors.ts";
import { CDP_URL_NEEDED, resolveOptions, type BrowserOptions, type Settings } from "./options.ts";
import { outlineText, type NetEntry } from "./outline.ts";
import { startRelay } from "./relay/endpoint.ts";
import { SERVICE_USAGE, serviceMain } from "./service/main.ts";
import { runHost } from "./service/link/host.ts";
import { relayTestClipboard } from "./service/unit/clipboard.ts";
import { relayTestFiles } from "./relay/scope-files.ts";
import { signIn, signInHuman, signIns } from "./sign-in-cli.ts";

type Flag = { type: "string" | "boolean"; short?: string };

export const GLOBAL_FLAGS: Record<string, Flag & { description: string }> = {
  json: { type: "boolean", description: "print one JSON document" },
  help: { type: "boolean", short: "h", description: "this text" },
  "state-dir": { type: "string", description: "this consumer's own state folder (required)" },
  allowlist: { type: "string", description: 'JSON file {"allow": ["example.com", ...]}; read, never written' },
  "cdp-url": { type: "string", description: "agent mode's endpoint (ws+unix://<socket>:/devtools/browser/<scope>, from `agentwatch browser endpoint`; required): the only way to drive the agent browser" },
  "notify-command": { type: "string", description: 'status --notify runs this argv, a JSON array; "{message}" and stdin carry the text' },
  "command-name": { type: "string", description: 'how hints name this command line (default "agent-browser")' },
  "tab-scope": { type: "string", description: "work only in this scope's tabs, e.g. a session's name (1-64 of A-Z a-z 0-9 . _ -)" },
  "hidden-drive": { type: "boolean", description: "keep a background tab's page hidden while a command drives it (no focus emulation; Linux-measured); only where a page has no window of its own (the relay on the Mac)" },
  "input-timing": { type: "string", description: 'the shape of a person\'s input in a window of its own (Linux), a JSON object of ms ranges, e.g. {"pressMs":[70,90],"keyMs":[90,150]}' },
};

/**
 * The flags that went with the CDP proxy, the agent Chrome that agent-browser started itself and personal mode (board
 * ab-v16.9.3). The parser still knows them, so that each one is refused by name with the way to the endpoint, not as an
 * unknown flag. `socket` stays the relay's own flag (RELAY_FLAGS).
 */
const REMOVED_FLAGS: Record<string, Flag> = {
  profile: { type: "string" }, mode: { type: "string" }, "chrome-bin": { type: "string" }, "chrome-args": { type: "string" }, endpoint: { type: "string" },
  "personal-user-data-dir": { type: "string" }, "no-launch": { type: "boolean" }, "no-prompt": { type: "boolean" }, approve: { type: "string" }, "approve-command": { type: "string" }, "approve-after-wake": { type: "boolean" },
  "proxy-idle-ms": { type: "string" }, login: { type: "boolean" }, attempt: { type: "string" }, "timeout-ms": { type: "string" },
  "wake-approve": { type: "string" }, "chrome-pid": { type: "string" }, "watch-back-command": { type: "string" },
};
/** The commands that went with the CDP proxy (board ab-v16.9.3): each one is refused by name with the way to the endpoint. */
const REMOVED_COMMANDS: ReadonlySet<string> = new Set(["launch", "quit", "connect", "stop", "chromes", "front", "proxy", "give-back-watch"]);
/** The flags of the internal `relay` command (the agentwatch daemon starts it): its socket, and the peer check (C11; board ab-v16.51). */
const RELAY_FLAGS: Record<string, Flag> = { socket: { type: "string" }, "peer-check": { type: "boolean" } };
/** The flags of `service` (contract C12, "The command"; board ab-v16.94.2): only `service` takes them, and it takes no other flag. */
const SERVICE_FLAGS: Record<string, Flag> = {
  "agent-door": { type: "string" }, "control-door": { type: "string" }, "daemon-unit": { type: "string" }, "daemon-command": { type: "string" },
  "lists-folder": { type: "string" }, "state-folder": { type: "string" },
  hello: { type: "boolean" }, fake: { type: "boolean" }, refuse: { type: "boolean" },
  // The fake as a process where a protection of the service's memory does not hold (C12, the fake; review-112 B5).
  unprotected: { type: "string" },
  // The Chrome unit (stage 1b part 1, board ab-v16.94.3).
  "tools-dir": { type: "string" }, "service-unit": { type: "string" },
  test: { type: "boolean" }, "test-display": { type: "string" }, "test-chrome-source": { type: "string" },
  // The MCP path in --test mode only (stage 1d part 2b, board ab-v16.94.5): a free port on 127.0.0.1, never a default.
  "test-mcp-port": { type: "string" },
  // The merge guard's stand-in host in --test mode only (board ab-v16.99): a *.localhost host, never a default.
  "test-merge-guard-host": { type: "string" },
  // The MCP's stand-in of a remote admission in --test mode only (board ab-v16.97.5): one scope, for the live check.
  "test-mcp-remote-scope": { type: "string" },
  // The carrier's switch (stage 5 T4, board ab-v16.94.7.5): the gateway's launchd label and its command file; in --test
  // mode only, the fake gateway's pid in place of the label.
  "gateway-label": { type: "string" }, "gateway-command": { type: "string" }, "test-gateway-pid": { type: "string" },
};
/** The flags that service takes and other commands take too: `service stop --all`. */
const SERVICE_SHARED: ReadonlySet<string> = new Set(["all"]);

/** The command flags in the spec (`--name`), plus --stdin for a command with a parameter that can come from stdin. */
function commandFlags(spec: CommandSpec): Record<string, Flag> {
  const out: Record<string, Flag> = {};
  for (const p of spec.params) {
    if (p.cli.startsWith("--")) out[p.cli.slice(2)] = { type: p.type === "boolean" ? "boolean" : "string" };
    if (p.stdin) out.stdin = { type: "boolean" };
  }
  return out;
}

const ALL_FLAGS: Record<string, Flag> = Object.assign({}, ...COMMAND_SPECS.map(commandFlags), REMOVED_FLAGS, RELAY_FLAGS, SERVICE_FLAGS,
  Object.fromEntries(Object.entries(GLOBAL_FLAGS).map(([k, { type, short }]) => [k, short ? { type, short } : { type }])));

export const USAGE = `agent-browser <command> [args] --cdp-url URL --state-dir DIR --allowlist FILE [--json]

Drives allowlisted tabs in agentwatch's agent browser through agent mode's endpoint (--cdp-url, from
\`agentwatch browser endpoint\`): the only way to drive it. agent-browser starts no Chrome and no proxy,
and no "Allow remote debugging?" prompt appears. Read pages with outline or text before any screenshot.

Commands:
${COMMAND_SPECS.map((c) => `  ${c.usage.padEnd(52)} ${c.summary}`).join("\n")}

sign-in <name> and sign-ins: sign in to a site with a credential that the operator stored, by its name, and list the
names that this session may use. The agent browser types the stored username and password itself, in a private
window that no agent sees; no answer holds them.

commands needs no --cdp-url and no --state-dir.

<tab> is a name given to 'open --name', a target-id prefix, or a URL substring (allowlisted tabs only).
With --tab-scope NAME, open records each new tab under that scope, <tab> resolves only among the
scope's tabs, and tabs lists them and counts the others. Names are kept per scope. --any-scope (on
tabs, window and every command that takes <tab>) reaches the tabs outside the scope. In a scope,
window pin and window unpin need --any-scope: the pin confines every scope.

Options:
${Object.entries(GLOBAL_FLAGS).map(([k, f]) => `  --${(k + (f.type === "string" ? " X" : "")).padEnd(30)} ${f.description}`).join("\n")}`;

export type IO = { stdout: Writable; stderr: Writable; stdin: Readable };

const write = (w: Writable, text: string) => new Promise<void>((r) => { w.write(text, () => r()); });

async function readAll(stdin: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

type Values = Record<string, string | boolean | undefined>;

/** The consumer's settings from the global flags. Relative paths are taken from the current folder. */
export function optionsFromFlags(v: Values, log: (line: string) => void): Settings {
  const str = (k: string) => (typeof v[k] === "string" ? v[k] as string : undefined);
  // An empty path is a usage error, as in the library: resolve("") would be the current folder (a checkout, for example).
  const abs = (k: string) => {
    const value = str(k);
    if (value === "") throw new UsageError(`--${k} is empty: give a path, or leave the flag out`);
    return value === undefined ? undefined : resolve(value);
  };
  if (str("cdp-url") === undefined) throw new UsageError(`--cdp-url is required: ${CDP_URL_NEEDED}`);
  if (!str("state-dir")) throw new UsageError("--state-dir is required: this consumer's own state folder");
  let notify: BrowserOptions["notify"];
  if (str("notify-command")) {
    let argv: unknown;
    try { argv = JSON.parse(str("notify-command")!); } catch { throw new UsageError("--notify-command must be a JSON array of strings"); }
    notify = { command: argv as string[] };
  }
  let inputTiming: BrowserOptions["inputTiming"];
  if (str("input-timing") !== undefined) {
    let t: unknown;
    try { t = JSON.parse(str("input-timing")!); } catch { t = undefined; }
    if (!t || typeof t !== "object" || Array.isArray(t)) throw new UsageError("--input-timing must be a JSON object, for example {\"pressMs\":[70,90]}");
    inputTiming = t as BrowserOptions["inputTiming"];
  }
  return resolveOptions({
    stateDir: abs("state-dir")!, cdpUrl: str("cdp-url")!, allowlistFile: abs("allowlist"), notify, commandName: str("command-name"), tabScope: str("tab-scope"),
    hiddenDrive: !!v["hidden-drive"], inputTiming, log,
  });
}

/** The command's parameters from its positionals, its flags and (with --stdin) standard input. */
export async function paramsFor(spec: CommandSpec, positionals: string[], v: Values, stdin: Readable): Promise<Record<string, unknown>> {
  const usage = () => new UsageError(`usage: agent-browser ${spec.usage}`);
  const params: Record<string, unknown> = {};
  if (spec.name === "window") {
    if (positionals.length === 2 && positionals[0] === "pin") params.pin = positionals[1];
    else if (positionals.length === 1 && positionals[0] === "unpin") params.unpin = true;
    else if (positionals.length) throw usage();
    if (v["any-scope"]) params.anyScope = true;
    return params;
  }
  const positional = spec.params.filter((p) => p.cli === "positional");
  const fromStdin = spec.params.find((p) => p.stdin);
  const taken = v.stdin ? positional.filter((p) => p !== fromStdin) : positional;
  if (positionals.length > taken.length) throw usage();
  taken.forEach((p, i) => { if (positionals[i] !== undefined) params[p.name] = positionals[i]; });
  if (v.stdin && fromStdin) params[fromStdin.name] = await readAll(stdin);
  // A text on stdin is how agentwatch's skill sends a secret: type marks it, so the input stage never pastes it (board ab-t30.22).
  if (v.stdin && spec.name === "type") params.secret = true;
  for (const p of spec.params) {
    if (!p.cli.startsWith("--")) continue;
    const raw = v[p.cli.slice(2)];
    if (raw === undefined) continue;
    if (p.type === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new UsageError(`${p.cli} must be a number`);
      params[p.name] = n;
    } else params[p.name] = raw;
  }
  for (const p of spec.params) if (p.required && params[p.name] === undefined) throw usage();
  return params;
}

function tabLine(t: { id: string; name: string | null; title: string; url: string }): string {
  return `${t.id}  ${(t.name ?? "").padEnd(10)}  ${t.title.slice(0, 50).padEnd(50)}  ${t.url}`;
}

/** The text form of `tabs` with a tab scope: each tab outside the scope says whose it is, then the count of the others. */
function scopedTabLines(r: { tabs: { id: string; name: string | null; scope?: string; title: string; url: string }[]; scope: string; outOfScope: number }): string[] {
  return [...r.tabs.map((t) => tabLine(t) + (t.scope === r.scope ? "" : t.scope === undefined ? "  [no scope]" : `  [scope ${t.scope}]`)),
    `${r.outOfScope} allowlisted tab${r.outOfScope === 1 ? "" : "s"} outside scope ${r.scope}`];
}

/** The human (non-JSON) form of a result. */
export function human(r: any): string {
  const lines = (xs: string[]) => xs.filter((x) => x !== "").join("\n") + "\n";
  switch (r.command) {
    case "status":
      if (!r.connected) return lines([r.detail, r.notification ? r.notification.detail : ""]);
      return lines([`target: ${r.target}`, r.product,
        `allowlisted tabs: ${r.allowedTabs}  (other tabs, untouched: ${r.otherTabs})`, `allowlist: ${r.allowlist.join(", ")}`,
        `window: ${r.window ?? "not pinned"}`]);
    case "window":
      return lines([r.window === null ? "no window pinned: any window may be used" : `pinned to window ${r.window}; tabs in it:`,
        ...r.tabs.map((t: any) => `  ${t.id}  ${t.url}`)]);
    case "tabs":
      if (r.scope !== undefined) return lines(scopedTabLines(r));
      return r.tabs.length ? lines(r.tabs.map(tabLine)) : "";
    case "open": case "goto": return lines([`${r.tab.id}  ${r.tab.url}`]);
    case "outline": return lines([outlineText(r.elements)]);
    case "click": return lines([`clicked ${r.text !== null ? JSON.stringify(r.text) : r.target} in ${r.tab.id}`,
      ...(r.download ? [`path: ${r.download.path}`, `name: ${r.download.suggestedFilename}`, `url: ${r.download.url}`, `${r.download.bytes} bytes`] : [])]);
    case "hover": return lines([`hovering ${r.target} in ${r.tab.id}`]);
    case "type": return lines([`typed ${r.length} characters in ${r.tab.id}`]);
    case "press": return lines([`pressed ${r.key} in ${r.tab.id}`]);
    case "text": return r.text.endsWith("\n") ? r.text : r.text + "\n";
    case "eval": return JSON.stringify(r.value, null, 2) + "\n";
    case "shot": return lines([r.path]);
    case "record":
      return lines([`${r.path}  ${r.videoWidth}x${r.videoHeight}  ${r.fps} fps  ${r.seconds.toFixed(1)} s  ${r.frames} frames`, `provenance: ${r.provenance}`,
        ...r.warnings.map((w: string) => `warning: ${w}`)]);
    case "fetch": return lines([`${r.path}  ${r.bytes} bytes  ${r.contentType}`]);
    case "download": return lines([`${r.path}  ${r.bytes} bytes  HTTP ${r.status}`]);
    case "close": return lines([`closed ${r.tab.id}`]);
    case "net": return ""; // streamed as it happened
    case "commands": return USAGE + "\n";
    default: return JSON.stringify(r) + "\n";
  }
}

/**
 * Run one command line. Returns the exit status. Output goes to `io`, so tests can run it in-process.
 */
export async function main(argv: string[], io: IO = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin }): Promise<number> {
  let json = argv.includes("--json");
  let command: string | null = null;
  const log = (line: string) => { io.stderr.write(`${line}\n`); };
  try {
    let values: Values, positionals: string[];
    try { ({ values, positionals } = parseArgs({ args: argv, options: ALL_FLAGS, allowPositionals: true, strict: true }) as { values: Values; positionals: string[] }); }
    catch (e) { throw new UsageError((e as Error).message); }
    json = !!values.json;
    const [name, ...rest] = positionals;
    command = name ?? null;
    if (!name || name === "help" || values.help) { await write(io.stdout, json ? JSON.stringify({ ok: true, command: "help", usage: USAGE }) + "\n" : USAGE + "\n"); return 0; }
    // The commands and flags of the CDP proxy are gone (board ab-v16.9.3): each one is refused by name, with the way to the endpoint.
    if (REMOVED_COMMANDS.has(name)) throw new UsageError(`${name}: this command is gone with the CDP proxy; ${CDP_URL_NEEDED}`);
    for (const k of Object.keys(REMOVED_FLAGS)) if (values[k] !== undefined) throw new UsageError(`--${k}: this flag is gone with the CDP proxy; ${CDP_URL_NEEDED}`);
    // --socket was also the proxy's socket of every command: now only the relay takes it.
    if (name !== "relay" && values.socket !== undefined) throw new UsageError(`--socket: this flag of the CDP proxy is gone (it stays the relay's own flag); ${CDP_URL_NEEDED}`);
    if (name !== "relay" && values["peer-check"] !== undefined) throw new UsageError(`--peer-check is only for relay (started by the agentwatch daemon), not ${name}`);
    if (name !== "service") for (const k of Object.keys(SERVICE_FLAGS)) if (values[k] !== undefined) throw new UsageError(`--${k} is only for service (started by agentwatch's unit), not ${name}`);
    if (name === "service") {
      // The self-contained agent browser's service (stage 1a): off by default; agentwatch's unit starts it from stage 2.
      for (const k of Object.keys(values)) if (!(k in SERVICE_FLAGS) && !SERVICE_SHARED.has(k)) throw new UsageError(`--${k} is not an option of service; ${SERVICE_USAGE}`);
      return await serviceMain(values, io, log, rest);
    }
    if (name === "host") {
      // The host shim of the self-contained agent browser (stage 1b part 2): Chrome starts it for the receiver, with the
      // receiver's origin as its one argument. Its standard output is Chrome's native port, so it prints nothing else there.
      for (const k of Object.keys(values)) throw new UsageError(`--${k} is not an option of host (Chrome starts it, not a person)`);
      return await runHost({ env: process.env, stdin: io.stdin, stdout: io.stdout, ppid: process.ppid, log });
    }
    if (name === "relay") {
      // Agent mode's CDP endpoint. Its standard output is the bridge to the daemon, so it prints nothing else there.
      if (typeof values.socket !== "string" || !values.socket || rest.length) throw new UsageError("usage: agent-browser relay --socket PATH [--peer-check] (started by the agentwatch daemon, not by hand)");
      // --peer-check: the relay admits a connection only from a process of its scope's agentwatch session. It loads
      // node:ffi for that (only then), in its self-test.
      // The live rows' door to the stage's paste (board ab-t30.19): an X clipboard on the run's own display, with the stage's test value only.
      const clipboard = relayTestClipboard(process.env, log);
      // The live rows' door to the stage's files (board ab-t30.12.2): a folder of the run, with the stage's test value only.
      const files = await relayTestFiles(process.env, log);
      const relay = await startRelay({ socket: resolve(values.socket), input: io.stdin, output: io.stdout, log, peerCheck: values["peer-check"] === true, ...(clipboard ? { clipboard } : {}), ...(files ? { files } : {}) });
      await relay.closed;
      return 0;
    }
    if (name === "sign-in" || name === "sign-ins") {
      // The stored sign-ins (C11, the sign-in act): the method over agent mode's endpoint, so the walk gives the scope.
      for (const k of Object.keys(values)) if (!(k in GLOBAL_FLAGS)) throw new UsageError(`--${k} is not an option of ${name}`);
      if (name === "sign-in" ? rest.length !== 1 : rest.length !== 0) throw new UsageError(`usage: agent-browser ${name === "sign-in" ? "sign-in <name>" : "sign-ins"} --cdp-url URL --state-dir DIR`);
      const s = optionsFromFlags(values, log);
      const result = name === "sign-in" ? await signIn(s, rest[0]) : await signIns(s);
      await write(io.stdout, json ? JSON.stringify(result) + "\n" : signInHuman(result));
      return 0;
    }
    const spec = COMMAND_SPECS.find((c) => c.name === name);
    if (!spec) throw new UsageError(`unknown command "${name}"; see agent-browser --help`);
    const allowed = { ...commandFlags(spec), ...GLOBAL_FLAGS };
    for (const k of Object.keys(values)) if (!(k in allowed)) throw new UsageError(`--${k} is not an option of ${name}`);
    const params = await paramsFor(spec, rest, values, io.stdin);
    let result: unknown;
    if (name === "commands") result = await commands.commands();
    else {
      const options = optionsFromFlags(values, log);
      const hooks = name === "net" && !json ? { onEntry: (e: NetEntry) => { io.stdout.write(JSON.stringify(e) + "\n"); } } : undefined;
      result = await (commands[name as Exclude<CommandName, "commands">] as (o: Settings, p: unknown, h?: unknown) => Promise<unknown>)(options, params, hooks);
    }
    await write(io.stdout, json ? JSON.stringify(result) + "\n" : human(result));
    return 0;
  } catch (e) {
    const code = errorCode(e);
    const message = e instanceof Error ? e.message : String(e);
    if (json) await write(io.stdout, JSON.stringify({ ok: false, command, error: { code, message } }) + "\n");
    else await write(io.stderr, `agent-browser: ${message}\n`);
    return code === "usage" ? 2 : 1;
  }
}
