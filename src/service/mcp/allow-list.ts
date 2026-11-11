// The MCP's allow list (contract C11, "The MCP inside the service", and its part docs/contracts/mcp-allow-list.md; stage 1d
// of the self-contained agent browser, board ab-v16.94.5, part 2b). One JSON file for the one pinned version of
// `@playwright/mcp` (allow-list.json, next to this file) names each tool that the service serves, each argument key that
// it passes, and each key that names a file or a path. The transport (transport.ts) applies it before a message reaches
// the MCP's code: `tools/list` loses each other tool, and a `tools/call` of another tool, with another key, or with a path
// outside the scope's folder gets the format's JSON-RPC error. The format's test (checkList) runs in npm test against the
// pinned version's own `tools/list`, which the MCP gives with no browser.
//
// The service's own tools of the format (`service_tools`, board ab-v16.97.5, stage 1e) are in the file, exactly as the
// format gives them, and the runtime of this stage serves none of them: they stay out of `tools/list`, and a call of one
// gets the -32601 of a tool that the runtime does not serve, until stage 1e answers them.

import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

/** The rule of one allowed tool: the keys that the service passes, the keys of them that name a file or a path, and the pinned input schema. */
export type ToolRule = { readonly keys: readonly string[]; readonly paths: readonly string[]; readonly schema: Record<string, unknown> };
/** One of the service's own tools (stage 1e; this stage serves none). */
export type ServiceToolRule = { readonly keys: readonly string[]; readonly description: string; readonly schema: Record<string, unknown> };
/** The list file (docs/contracts/mcp-allow-list.md, "The file"). */
export type AllowList = {
  readonly package: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly tools: Readonly<Record<string, ToolRule>>;
  readonly service_tools?: Readonly<Record<string, ServiceToolRule>>;
  readonly refused: Readonly<Record<string, string>>;
};
/** A tool of the pinned version's `tools/list`, as the MCP gives it. */
export type PinnedTool = { readonly name: string; readonly inputSchema: Record<string, unknown> };

/** The capabilities that the service never turns on (C11). */
export const NEVER_CAPABILITIES: readonly string[] = Object.freeze(["core-install", "storage", "devtools", "testing", "config"]);
/** The one tool that is always refused: it runs a client's JavaScript in the MCP server's process (C11, the format). */
export const RUN_CODE = "browser_run_code_unsafe";
/** The list file of the pinned version. */
export const LIST_FILE = fileURLToPath(new URL("./allow-list.json", import.meta.url));
/** The service's own tools, exactly as the format gives them (docs/contracts/mcp-allow-list.md; stage 1e serves them). */
export const SERVICE_TOOLS: Readonly<Record<string, ServiceToolRule>> = Object.freeze({
  browser_sign_in: { keys: ["name"], description: "Sign in to a site with a credential that the operator stored. Give its name: browser_sign_ins lists the names. The agent never gets the password.", schema: { type: "object", properties: { name: { type: "string", description: "The name of a stored sign-in" } }, required: ["name"], additionalProperties: false } },
  browser_sign_ins: { keys: [], description: "List the stored sign-ins that this session may use, and the state of the store.", schema: { type: "object", properties: {}, additionalProperties: false } },
});

/** The rules of the format's test, by the names of the vectors' `breaks`. */
export const RULES = {
  once: "each tool in tools or refused, once",
  runCode: "browser_run_code_unsafe in refused",
  schema: "each schema equals the pinned schema",
  keys: "keys are properties of the schema",
  paths: "paths are keys",
  pathKey: "a file or path key is in paths",
  capabilities: "no core-install, storage, devtools, testing or config",
  version: "version is the pin",
  serviceNotPinned: "no service tool is a tool of the pinned tools/list",
  serviceExact: "service_tools is exactly the service's own tools",
} as const;

/** The JSON-RPC answer of a refused call (the format's texts). */
export type Refused = { readonly code: number; readonly message: string };
const NA = "Not available in the agent browser";
export const refuseTool = (tool: string): Refused => ({ code: -32601, message: `${NA}: ${tool}` });
export const refuseKey = (tool: string, key: string): Refused => ({ code: -32602, message: `${NA}: the argument ${key} of ${tool}` });
export const refusePath = (key: string, folder: string): Refused => ({ code: -32602, message: `${NA}: ${key} must name a file in the session's folder ${folder}` });
/** A tools/call whose `arguments` is not a JSON object (the format, "What the service does with it"). */
export const refuseArguments = (tool: string): Refused => ({ code: -32602, message: `${NA}: the arguments of ${tool} must be a JSON object` });

/** The list file, read and checked for its shape (a broken file throws: the service then serves no MCP). */
export function readAllowList(file = LIST_FILE): AllowList {
  const o = JSON.parse(readFileSync(file, "utf8"));
  const strs = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === "string");
  const obj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
  if (!obj(o) || o.package !== "@playwright/mcp" || typeof o.version !== "string" || !strs(o.capabilities) || !obj(o.tools) || !obj(o.refused)) throw new Error(`the MCP's allow list ${basename(file)} breaks the format`);
  for (const [name, r] of Object.entries(o.tools)) {
    if (!obj(r) || !strs(r.keys) || !strs(r.paths) || !obj(r.schema)) throw new Error(`the MCP's allow list ${basename(file)} breaks the format at ${name}`);
  }
  if (o.service_tools !== undefined && !obj(o.service_tools)) throw new Error(`the MCP's allow list ${basename(file)} breaks the format at service_tools`);
  return o as unknown as AllowList;
}

/**
 * A property's schema speaks of a file or a path: its name or its description holds `file`, `path`, `folder` or
 * `directory`, in any case and inside a word too (`filename`, `profile`): the format's test reads it widely, so a key
 * that it names wrongly stays out of `keys` rather than outside `paths`.
 */
const FILE_WORD = /file|path|folder|directory/i;
export function speaksOfPath(key: string, prop: unknown): boolean {
  const p = (prop ?? {}) as { description?: unknown };
  return FILE_WORD.test(`${key} ${typeof p.description === "string" ? p.description : ""}`);
}
/** A string property, or a list of strings (the format's test reads both as strings). */
function stringish(prop: unknown): boolean {
  const p = (prop ?? {}) as { type?: unknown; items?: { type?: unknown } };
  return p.type === "string" || (p.type === "array" && p.items?.type === "string");
}
const propsOf = (schema: Record<string, unknown>) => ((schema.properties ?? {}) as Record<string, unknown>);

/**
 * The format's test (docs/contracts/mcp-allow-list.md, "The test"): the rules that `list` breaks against the pinned
 * version's `tools/list` and its pin, by the names of RULES. An empty list: the list holds.
 */
export function checkList(list: AllowList, pinned: readonly PinnedTool[], pin: string): string[] {
  const broken = new Set<string>();
  const tools = Object.keys(list.tools), refused = Object.keys(list.refused);
  const names = pinned.map((t) => t.name);
  for (const n of names) if (tools.includes(n) === refused.includes(n)) broken.add(RULES.once);
  for (const n of [...tools, ...refused]) if (!names.includes(n)) broken.add(RULES.once);
  if (!refused.includes(RUN_CODE) || tools.includes(RUN_CODE)) broken.add(RULES.runCode);
  for (const [name, rule] of Object.entries(list.tools)) {
    const p = pinned.find((t) => t.name === name);
    if (p && !isDeepStrictEqual(rule.schema, p.inputSchema)) broken.add(RULES.schema);
    const props = propsOf(rule.schema);
    for (const k of rule.keys) if (!Object.hasOwn(props, k)) broken.add(RULES.keys);
    for (const k of rule.paths) if (!rule.keys.includes(k)) broken.add(RULES.paths);
    for (const [k, prop] of Object.entries(props)) {
      if (stringish(prop) && speaksOfPath(k, prop) && rule.keys.includes(k) && !rule.paths.includes(k)) broken.add(RULES.pathKey);
    }
  }
  if (list.capabilities.some((c) => NEVER_CAPABILITIES.includes(c))) broken.add(RULES.capabilities);
  if (list.version !== pin) broken.add(RULES.version);
  const service = list.service_tools ?? {};
  if (Object.keys(service).some((n) => names.includes(n))) broken.add(RULES.serviceNotPinned);
  if (JSON.stringify(service) !== JSON.stringify(SERVICE_TOOLS)) broken.add(RULES.serviceExact);
  return Object.values(RULES).filter((r) => broken.has(r));
}

/** `tools/list`'s tools without each tool that the list does not name (the service's own tools of stage 1e stay out too). */
export function filterTools<T extends { name?: unknown }>(list: AllowList, tools: readonly T[]): T[] {
  return tools.filter((t) => typeof t.name === "string" && Object.hasOwn(list.tools, t.name));
}

/**
 * The realpath of `p`, also for a file that does not exist yet (a screenshot to save): the realpath of its deepest
 * folder that exists, and the rest of the path as it is. `real` is fs's realpath (tests give a map).
 */
export function realpathDeep(p: string, real: (p: string) => string = (x) => realpathSync.native(x)): string {
  const tail: string[] = [];
  let at = p;
  for (let i = 0; i < 4096; i++) {
    try { return tail.length ? join(real(at), ...tail.reverse()) : real(at); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
      const up = dirname(at);
      if (up === at) throw e;
      tail.push(basename(at));
      at = up;
    }
  }
  throw new Error("the path is too deep");
}

/** The folder with one trailing slash, as the answers name it. */
export const folderText = (folder: string) => (folder.endsWith("/") ? folder : `${folder}/`);

/**
 * A `tools/call`'s params against the list (the format, "What the service does with it"): null when the call passes,
 * else its JSON-RPC error. `folder` is the scope's folder, `<state>/mcp/<scope>/`; `real` is the realpath (tests give a
 * map). A path argument passes only when its realpath is inside the realpath of the folder (a relative one is read from
 * the folder, the MCP's root of the session); a value that is no string or list of strings is refused as a path.
 */
export function checkCall(list: AllowList, params: { name?: unknown; arguments?: unknown }, folder: string, real: (p: string) => string = (x) => realpathSync.native(x)): Refused | null {
  const name = typeof params.name === "string" ? params.name : "";
  const rule = Object.hasOwn(list.tools, name) ? list.tools[name] : undefined;
  if (rule === undefined) return refuseTool(name);
  const args = params.arguments === undefined ? {} : params.arguments;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return refuseArguments(name);
  for (const key of Object.keys(args)) if (!rule.keys.includes(key)) return refuseKey(name, key);
  const shown = folderText(folder);
  let inside: string | null = null;
  for (const key of rule.paths) {
    if (!Object.hasOwn(args, key)) continue;
    const v = (args as Record<string, unknown>)[key];
    const values = typeof v === "string" ? [v] : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
    if (values === null) return refusePath(key, shown);
    inside ??= (() => { try { return folderText(realpathDeep(resolve(folder), real)); } catch { return null; } })();
    for (const value of values) {
      let r: string | null;
      try { r = realpathDeep(isAbsolute(value) ? resolve(value) : resolve(folder, value), real); } catch { r = null; }
      if (inside === null || r === null || !r.startsWith(inside) || r.length === inside.length) return refusePath(key, shown);
    }
  }
  return null;
}
