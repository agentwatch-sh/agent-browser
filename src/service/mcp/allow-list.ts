// The MCP's allow list (contract C11, "The MCP inside the service", and its part docs/contracts/mcp-allow-list.md; stage 1d
// of the self-contained agent browser, board ab-v16.94.5, part 2b). One JSON file for the one pinned version of
// `@playwright/mcp` (allow-list.json, next to this file) names each tool that the service serves, each argument key that
// it passes, and each key that names a file or a path. The transport (transport.ts) applies it before a message reaches
// the MCP's code: `tools/list` loses each other tool, and a `tools/call` of another tool, with another key, or with a path
// outside the scope's folder gets the format's JSON-RPC error. The format's test (checkList) runs in npm test against the
// pinned version's own `tools/list`, which the MCP gives with no browser.
//
// The service's own tools of the format (`service_tools`: browser_sign_in and browser_sign_ins, the stored sign-ins'
// MCP tools; board ab-v16.97.5) are in the file, exactly as the format gives them. The transport serves them itself, for
// a request with a local admission only, while the service has the sign-in act (serviceTools, serviceCall): a request
// that a remote token admitted gets none of them in `tools/list`, and its call of one gets the tool error of the act's
// check 1 and never reaches the act (C11, the sign-in act).

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

/** The rule of one allowed tool: the keys that the service passes, the keys of them that name a file or a path, and the pinned input schema. */
export type ToolRule = { readonly keys: readonly string[]; readonly paths: readonly string[]; readonly schema: Record<string, unknown> };
/** One of the service's own tools (the stored sign-ins' MCP tools: the transport answers them itself). */
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
/** The service's own tools, exactly as the format gives them (docs/contracts/mcp-allow-list.md; the transport serves them). */
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
  shape: "each key's schema has a shape that the test can read",
  required: "each required key is in keys",
  meta: "no key is _meta",
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
const propsOf = (schema: Record<string, unknown>) => ((schema.properties ?? {}) as Record<string, unknown>);

/** The keywords of a schema that the format's test reads; any other keyword (a `$ref`, `not`, `if`) is a shape that it cannot read. */
const READ_KEYWORDS = new Set(["type", "description", "title", "default", "examples", "enum", "const", "format", "pattern", "minLength", "maxLength",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "items", "minItems", "maxItems", "uniqueItems", "properties", "required",
  "additionalProperties", "propertyNames", "anyOf", "oneOf", "allOf", "$schema"]);
const PRIMITIVE = new Set(["string", "number", "integer", "boolean", "null", "array", "object"]);

/**
 * Whether a key's schema holds a string that speaks of a file or a path (the format's test, review-115 note 5): the key's
 * own string, or a string in `anyOf`, `oneOf`, `allOf`, `items`, nested `properties`, `additionalProperties` or
 * `propertyNames`, read with
 * the names and descriptions on its way. "unreadable" for a shape that the test cannot read (no `type` and no
 * `anyOf`, `oneOf`, `allOf`, `enum` or `const`, or a keyword that it does not know).
 */
export function fileString(name: string, schema: unknown, way = ""): boolean | "unreadable" {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return "unreadable";
  const s = schema as Record<string, unknown>;
  if (Object.keys(s).some((k) => !READ_KEYWORDS.has(k))) return "unreadable";
  const text = `${way} ${name} ${typeof s.description === "string" ? s.description : ""}`;
  let found = false;
  const sub = (n: string, x: unknown) => { const r = fileString(n, x, text); if (r === "unreadable") return false; found ||= r; return true; };
  for (const k of ["anyOf", "oneOf", "allOf"] as const) {
    if (s[k] === undefined) continue;
    if (!Array.isArray(s[k]) || !(s[k] as unknown[]).every((x) => sub("", x))) return "unreadable";
  }
  const types = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
  if (!types.every((t) => typeof t === "string" && PRIMITIVE.has(t))) return "unreadable";
  if (types.length === 0 && s.anyOf === undefined && s.oneOf === undefined && s.allOf === undefined && s.enum === undefined && s.const === undefined) return "unreadable";
  // A string whose values an enum or a const fixes is no exception (review-115b P1): the format's rule holds for each
  // string that speaks of a file or a path, also an enum or a const of strings with no type (review-121 note 8).
  const untypedString = types.length === 0 && ((Array.isArray(s.enum) && s.enum.some((v) => typeof v === "string")) || typeof s.const === "string");
  if ((types.includes("string") || untypedString) && speaksOfPath("", { description: text })) found = true;
  if (types.includes("array") && s.items !== undefined && !sub("", s.items)) return "unreadable";
  if (s.properties !== undefined) {
    if (s.properties === null || typeof s.properties !== "object") return "unreadable";
    for (const [k, x] of Object.entries(s.properties as Record<string, unknown>)) if (!sub(k, x)) return "unreadable";
  }
  if (s.additionalProperties !== undefined && typeof s.additionalProperties !== "boolean" && !sub("", s.additionalProperties)) return "unreadable";
  if (s.propertyNames !== undefined && !sub("", s.propertyNames)) return "unreadable";
  return found;
}

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
    if (rule.keys.includes("_meta") || rule.paths.includes("_meta")) broken.add(RULES.meta);
    const required = Array.isArray(rule.schema.required) ? (rule.schema.required as unknown[]) : [];
    for (const k of required) if (typeof k !== "string" || !rule.keys.includes(k)) broken.add(RULES.required);
    for (const [k, prop] of Object.entries(props)) {
      const f = fileString(k, prop);
      if (f === "unreadable") broken.add(RULES.shape);
      else if (f && rule.keys.includes(k) && !rule.paths.includes(k)) broken.add(RULES.pathKey);
    }
  }
  if (list.capabilities.some((c) => NEVER_CAPABILITIES.includes(c))) broken.add(RULES.capabilities);
  if (list.version !== pin) broken.add(RULES.version);
  const service = list.service_tools ?? {};
  if (Object.keys(service).some((n) => names.includes(n))) broken.add(RULES.serviceNotPinned);
  if (JSON.stringify(service) !== JSON.stringify(SERVICE_TOOLS)) broken.add(RULES.serviceExact);
  return Object.values(RULES).filter((r) => broken.has(r));
}

/**
 * `tools/list`'s tools without each tool that the list does not name (the MCP's own; the service's own tools come from
 * serviceTools),
 * and each tool's input schema with only the keys of its `keys`: each other property and its `required` entry are
 * dropped (review-115 note 6).
 */
export function filterTools<T extends { name?: unknown; inputSchema?: unknown }>(list: AllowList, tools: readonly T[]): T[] {
  return tools.filter((t) => typeof t.name === "string" && Object.hasOwn(list.tools, t.name)).map((t) => {
    const keys = list.tools[t.name as string].keys;
    const s = t.inputSchema;
    if (s === null || typeof s !== "object" || Array.isArray(s)) return t;
    const schema = s as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, unknown>;
    const kept: Record<string, unknown> = { ...schema, properties: Object.fromEntries(Object.entries(props).filter(([k]) => keys.includes(k))) };
    if (Array.isArray(schema.required)) kept.required = schema.required.filter((k) => typeof k === "string" && keys.includes(k));
    return { ...t, inputSchema: kept };
  });
}

/** A folder of the service's user that is no link (lstat), for the path rule (review-115 note 2). */
export function realFolder(path: string, uid = process.getuid?.() ?? -1): boolean {
  try {
    const st = lstatSync(path.replace(/\/+$/, "") || "/");
    return st.isDirectory() && !st.isSymbolicLink() && (uid < 0 || st.uid === uid);
  } catch { return false; }
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
 * the folder, the MCP's root of the session); a value that is no string or list of strings is refused as a path; and when
 * one of `folders` (the service gives `<state>/mcp` and the scope's folder) is a link or no folder of the service's user,
 * each path argument is refused.
 */
export function checkCall(list: AllowList, params: { name?: unknown; arguments?: unknown }, folder: string, real: (p: string) => string = (x) => realpathSync.native(x), folders: readonly string[] = []): Refused | null {
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
    // `<state>/mcp` and the scope's folder must be folders of the service's user, not links (lstat at each path argument).
    if (!folders.every((f) => realFolder(f))) return refusePath(key, shown);
    inside ??= (() => { try { return folderText(realpathDeep(resolve(folder), real)); } catch { return null; } })();
    for (const value of values) {
      let r: string | null;
      try { r = realpathDeep(isAbsolute(value) ? resolve(value) : resolve(folder, value), real); } catch { r = null; }
      if (inside === null || r === null || !r.startsWith(inside) || r.length === inside.length) return refusePath(key, shown);
    }
  }
  return null;
}

/**
 * How the MCP port admitted a request (C11, the sign-in act's check 1): `local` for a connection that steps 1 and 2
 * admitted (the uid check of its TCP line and the walk to a root of its scope), `remote` for a request that a remote
 * token admitted with no walk (stage 5). A request with no word is remote, so a new path to the transport fails closed.
 */
export type Admission = "local" | "remote";

/** The service's own tools as `tools/list` gives them (the format: after the tools of `tools`, in the format's order). */
export function serviceTools(list: AllowList): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  return Object.entries(list.service_tools ?? {}).map(([name, r]) => ({ name, description: r.description, inputSchema: r.schema }));
}

/**
 * A `tools/call` of one of the service's own tools (the format, "What the service does with it"): null when `params`
 * names none of them (checkCall then reads it); `"remote"` for each request whose admission is not `local`, whatever its
 * arguments and whether the service has the act (the tool error of the sign-in act's check 1); the format's -32601 while
 * the service has no sign-in act (`served` false); its -32602 for `arguments` that are no JSON object, or a key that the
 * tool's `keys` does not name; else the tool and its arguments, for the act's method.
 */
export function serviceCall(list: AllowList, params: { name?: unknown; arguments?: unknown }, admission: Admission | undefined, served: boolean): null | "remote" | Refused | { tool: string; args: Record<string, unknown> } {
  const name = typeof params.name === "string" ? params.name : "";
  const own = list.service_tools ?? {};
  const rule = Object.hasOwn(own, name) ? own[name] : undefined;
  if (rule === undefined) return null;
  if (admission !== "local") return "remote";
  if (!served) return refuseTool(name);
  const args = params.arguments === undefined ? {} : params.arguments;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return refuseArguments(name);
  for (const key of Object.keys(args)) if (!rule.keys.includes(key)) return refuseKey(name, key);
  return { tool: name, args: args as Record<string, unknown> };
}
