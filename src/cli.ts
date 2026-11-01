// `agent-browser <command> ... [--json]`. With --json each call prints exactly one JSON document on
// standard output, success or failure; progress and warnings go to standard error. Exit status: 0 on
// success, 1 on a failure, 2 on a usage error. The consumer's own folders come in as flags, never
// from the environment, so two consumers on one machine never share a profile by accident.

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { commands, COMMAND_SPECS, type CommandName, type CommandSpec } from "./commands.ts";
import { errorCode, UsageError } from "./errors.ts";
import { resolveOptions, type BrowserOptions, type Settings } from "./options.ts";
import { outlineText, type NetEntry } from "./outline.ts";
import { runProxy } from "./proxy.ts";

type Flag = { type: "string" | "boolean"; short?: string };

export const GLOBAL_FLAGS: Record<string, Flag & { description: string }> = {
  json: { type: "boolean", description: "print one JSON document" },
  help: { type: "boolean", short: "h", description: "this text" },
  "state-dir": { type: "string", description: "this consumer's own state folder (required)" },
  allowlist: { type: "string", description: 'JSON file {"allow": ["example.com", ...]}; read, never written' },
  profile: { type: "string", description: "agent Chrome profile (default <state-dir>/profile)" },
  socket: { type: "string", description: "proxy socket (default <state-dir>/chrome-proxy.sock)" },
  mode: { type: "string", description: "agent (default) or personal (the operator's Chrome; only when asked)" },
  "chrome-bin": { type: "string", description: "agent Chrome binary (default Chrome Beta, else Google Chrome)" },
  "chrome-args": { type: "string", description: 'extra Chrome flags, a JSON array e.g. ["--enable-unsafe-swiftshader"]; never --remote-debugging-*, --enable-automation, --headless, --user-data-dir or --profile-directory; no secrets (flags show in ps)' },
  endpoint: { type: "string", description: "a known upstream ws:// endpoint (still used through the proxy)" },
  "personal-user-data-dir": { type: "string", description: "personal mode: the operator's Chrome user-data folder" },
  "no-launch": { type: "boolean", description: "never start Chrome; fail with the launch command instead" },
  "no-prompt": { type: "boolean", description: "never open a new connection (a new Allow prompt); with no approved proxy, fail at once (approval_needed)" },
  "notify-command": { type: "string", description: 'status --notify runs this argv, a JSON array; "{message}" and stdin carry the text' },
  approve: { type: "string", description: 'approve Chrome\'s debugging dialog for unattended use: auto|osascript|xdotool' },
  "approve-command": { type: "string", description: "a custom approver argv, a JSON array (in place of --approve)" },
  "proxy-idle-ms": { type: "string", description: "the proxy exits after this long with no clients (default 12 h)" },
  "command-name": { type: "string", description: 'how hints name this command line (default "agent-browser")' },
};

/** Flags of the internal `proxy` command, which startProxy runs in the background. */
const PROXY_FLAGS: Record<string, Flag> = { attempt: { type: "string" }, "timeout-ms": { type: "string" } };

/** The command flags in the spec (`--name`), plus --stdin for a command with a parameter that can come from stdin. */
function commandFlags(spec: CommandSpec): Record<string, Flag> {
  const out: Record<string, Flag> = {};
  for (const p of spec.params) {
    if (p.cli.startsWith("--")) out[p.cli.slice(2)] = { type: p.type === "boolean" ? "boolean" : "string" };
    if (p.stdin) out.stdin = { type: "boolean" };
  }
  return out;
}

const ALL_FLAGS: Record<string, Flag> = Object.assign({}, ...COMMAND_SPECS.map(commandFlags), PROXY_FLAGS,
  Object.fromEntries(Object.entries(GLOBAL_FLAGS).map(([k, { type, short }]) => [k, short ? { type, short } : { type }])));

export const USAGE = `agent-browser <command> [args] --state-dir DIR --allowlist FILE [--json]

Drives allowlisted tabs in this consumer's agent browser: a separate Chrome on its own profile, with
its own cookies. Remote debugging is turned on in it at chrome://inspect/#remote-debugging and
approved once per proxy; Chrome is never started with --remote-debugging-port. Every connection goes
through this consumer's proxy socket. Read pages with outline or text before any screenshot.

Commands:
${COMMAND_SPECS.map((c) => `  ${c.usage.padEnd(52)} ${c.summary}`).join("\n")}

<tab> is a name given to 'open --name', a target-id prefix, or a URL substring (allowlisted tabs only).

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
  const abs = (k: string) => (str(k) === undefined ? undefined : resolve(str(k)!));
  if (!str("state-dir")) throw new UsageError("--state-dir is required: this consumer's own state folder");
  let notify: BrowserOptions["notify"];
  if (str("notify-command")) {
    let argv: unknown;
    try { argv = JSON.parse(str("notify-command")!); } catch { throw new UsageError("--notify-command must be a JSON array of strings"); }
    notify = { command: argv as string[] };
  }
  let approve: BrowserOptions["approve"];
  if (str("approve-command")) {
    let argv: unknown;
    try { argv = JSON.parse(str("approve-command")!); } catch { throw new UsageError("--approve-command must be a JSON array of strings"); }
    approve = { command: argv as string[] };
  } else if (str("approve")) {
    const a = str("approve")!;
    if (a !== "auto" && a !== "osascript" && a !== "xdotool" && a !== "true") throw new UsageError("--approve must be auto, osascript or xdotool");
    approve = a === "true" ? true : (a as "auto" | "osascript" | "xdotool");
  }
  let chromeArgs: BrowserOptions["chromeArgs"];
  if (str("chrome-args")) {
    let argv: unknown;
    try { argv = JSON.parse(str("chrome-args")!); } catch { throw new UsageError("--chrome-args must be a JSON array of strings"); }
    if (!Array.isArray(argv)) throw new UsageError("--chrome-args must be a JSON array of strings");
    chromeArgs = argv as string[];
  }
  const idle = str("proxy-idle-ms");
  return resolveOptions({
    stateDir: abs("state-dir")!, profileDir: abs("profile"), socketPath: abs("socket"), allowlistFile: abs("allowlist"),
    mode: str("mode") as BrowserOptions["mode"], chromeBin: abs("chrome-bin"), chromeArgs, endpoint: str("endpoint"),
    personalUserDataDir: abs("personal-user-data-dir"), noLaunch: !!v["no-launch"], noPrompt: !!v["no-prompt"], notify, approve,
    proxyIdleMs: idle === undefined ? undefined : Number(idle), commandName: str("command-name"), log,
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
    return params;
  }
  const positional = spec.params.filter((p) => p.cli === "positional");
  const fromStdin = spec.params.find((p) => p.stdin);
  const taken = v.stdin ? positional.filter((p) => p !== fromStdin) : positional;
  if (positionals.length > taken.length) throw usage();
  taken.forEach((p, i) => { if (positionals[i] !== undefined) params[p.name] = positionals[i]; });
  if (v.stdin && fromStdin) params[fromStdin.name] = await readAll(stdin);
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

/** The human (non-JSON) form of a result. */
export function human(r: any): string {
  const lines = (xs: string[]) => xs.filter((x) => x !== "").join("\n") + "\n";
  switch (r.command) {
    case "launch":
      return lines([`agent browser ${r.started ? "started" : "already running"} with remote debugging on; profile ${r.profileDir}`,
        ...r.errors.map((e: { url: string; error: string }) => `${e.url}: ${e.error}`),
        r.login ? "sign in to each site in the agent browser window; the logins persist in its profile" : ""]);
    case "quit": return lines([r.proxyStopped ? "proxy stopped" : "", r.closed ? "agent browser closed" : "agent browser is not running"]);
    case "status":
      if (!r.connected) return lines([r.detail, r.notification ? r.notification.detail : ""]);
      return lines([`target: ${r.target}`, `${r.product}  ${r.proxy ? `via proxy pid ${r.proxy.pid} -> ${r.proxy.upstream}` : ""}`,
        r.mode === "agent" ? `browser: agent (profile ${r.profileDir})` : "browser: personal (operator's Chrome)",
        `allowlisted tabs: ${r.allowedTabs}  (other tabs, untouched: ${r.otherTabs})`, `allowlist: ${r.allowlist.join(", ")}`,
        `window: ${r.window ?? "not pinned"}`]);
    case "connect": return lines([`connected: ${r.product}`]);
    case "stop": return lines([r.stopped ? "proxy stopped" : "no proxy running"]);
    case "window":
      return lines([r.window === null ? "no window pinned: any window may be used" : `pinned to window ${r.window}; tabs in it:`,
        ...r.tabs.map((t: any) => `  ${t.id}  ${t.url}`)]);
    case "tabs": return r.tabs.length ? lines(r.tabs.map(tabLine)) : "";
    case "open": case "goto": return lines([`${r.tab.id}  ${r.tab.url}`]);
    case "outline": return lines([outlineText(r.elements)]);
    case "click": return lines([`clicked ${r.text !== null ? JSON.stringify(r.text) : r.target} in ${r.tab.id}`]);
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
 * Run one command line. Returns the exit status, or "serve" for the proxy, which keeps running.
 * Output goes to `io`, so tests can run it in-process.
 */
export async function main(argv: string[], io: IO = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin }): Promise<number | "serve"> {
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
    if (name === "proxy") {
      if (!rest[0]) throw new UsageError("usage: agent-browser proxy <ws-url> --state-dir DIR (started by the library, not by hand)");
      const timeout = typeof values["timeout-ms"] === "string" ? Number(values["timeout-ms"]) : undefined;
      await runProxy(optionsFromFlags(values, log), rest[0], { attempt: values.attempt as string | undefined, timeoutMs: timeout });
      return "serve";
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
