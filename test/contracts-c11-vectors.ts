// Typed readers of the JSON vectors that test/contracts-c11.test.ts reads: test/vectors/endpoint.json and the bridge's
// constants in the copy of chrome-extension's bridge.json. Each reader checks at run time the shape that its type states,
// so a vector that breaks the shape fails at the read (with its path), and the tests read typed values. A reader checks
// the fields that the tests read; a field that it does not name may be there (the tests check the known fields).
import assert from "node:assert/strict";

/** A JSON value: what JSON.parse gives. */
export type Json = null | boolean | number | string | Json[] | JsonObject;
export type JsonObject = { [key: string]: Json };

const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isJson = (v: unknown): v is Json =>
  v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string" ||
  (Array.isArray(v) && v.every(isJson)) || (isPlain(v) && Object.values(v).every(isJson));

/** A reader of one shape: it gives v as T when v has the shape, and fails with the path `at` when it has not. */
export type Shape<T> = (v: unknown, at: string) => T;
/** A field that may be missing; when it is there, it has the shape. */
export type Optional<T> = { readonly optional: Shape<T> };
type Fields = { readonly [key: string]: Shape<unknown> | Optional<unknown> };
type Of<F> = F extends Optional<infer T> ? T : F extends Shape<infer T> ? T : never;
type Flat<T> = { [K in keyof T]: T[K] } & {};
export type ObjectOf<F extends Fields> = Flat<
  { -readonly [K in keyof F as F[K] extends Optional<unknown> ? never : K]: Of<F[K]> } &
  { -readonly [K in keyof F as F[K] extends Optional<unknown> ? K : never]?: Of<F[K]> }
>;
export type ShapeOf<S> = S extends Shape<infer T> ? T : never;

const fail = (at: string, want: string, v: unknown): never => assert.fail(`${at}: ${want}, not ${String(JSON.stringify(v)).slice(0, 160)}`);

export const str: Shape<string> = (v, at) => (typeof v === "string" ? v : fail(at, "a string", v));
export const num: Shape<number> = (v, at) => (typeof v === "number" ? v : fail(at, "a number", v));
export const bool: Shape<boolean> = (v, at) => (typeof v === "boolean" ? v : fail(at, "a boolean", v));
export const nul: Shape<null> = (v, at) => (v === null ? v : fail(at, "null", v));
/** No value: with `optional`, a field that is never there. */
export const none: Shape<undefined> = (v, at) => (v === undefined ? v : fail(at, "no field", v));
/** Any JSON value: the vectors that hold a client's message or params (the rules under test read them). */
export const json: Shape<Json> = (v, at) => (isJson(v) ? v : fail(at, "a JSON value", v));
export const jsonObject: Shape<JsonObject> = (v, at) => (isJson(v) && isPlain(v) ? v : fail(at, "a JSON object", v));
/** One of the values. */
export const lit = <const L extends readonly (string | number | boolean | null)[]>(...values: L): Shape<L[number]> => (v, at) => {
  const hit = values.find((x) => x === v);
  return hit === undefined ? fail(at, `one of ${JSON.stringify(values)}`, v) : hit;
};
export const optional = <T>(shape: Shape<T>): Optional<T> => ({ optional: shape });
export const arr = <T>(item: Shape<T>): Shape<T[]> => (v, at) => {
  if (!Array.isArray(v)) return fail(at, "an array", v);
  v.forEach((x, i) => item(x, `${at}[${i}]`));
  return v as T[]; // each item has the shape (checked above)
};
/** An object used as a map: each value has the shape. */
export const record = <T>(item: Shape<T>): Shape<Record<string, T>> => (v, at) => {
  if (!isPlain(v)) return fail(at, "an object", v);
  for (const [k, x] of Object.entries(v)) item(x, `${at}.${k}`);
  return v as Record<string, T>; // each value has the shape (checked above)
};
export const object = <F extends Fields>(fields: F): Shape<ObjectOf<F>> => (v, at) => {
  if (!isPlain(v)) return fail(at, "an object", v);
  for (const [k, f] of Object.entries(fields)) {
    if (typeof f === "function") f(v[k], `${at}.${k}`);
    else if (Object.hasOwn(v, k)) f.optional(v[k], `${at}.${k}`);
  }
  return v as ObjectOf<F>; // each named field has its shape (checked above)
};
/** The first shape that v has. */
export const oneOf = <S extends Shape<unknown>[]>(...shapes: S): Shape<ShapeOf<S[number]>> => (v, at) => {
  const why: string[] = [];
  for (const s of shapes) {
    try {
      s(v, at);
      return v as ShapeOf<S[number]>; // v has the shape s (checked above)
    } catch (e) {
      why.push(e instanceof Error ? e.message : String(e));
    }
  }
  return fail(at, `one of ${shapes.length} shapes (${why.join("; ")})`, v);
};

// ---- test/vectors/endpoint.json ----

const pidStart = object({ pid: num, start: num });
const procFields = { pid: num, ppid: num, start: num, state: str, cgroup: oneOf(str, nul) };
/** A process of a world (the fake process table of the session check). */
const proc = object({ world: str, ...procFields, note: str });
/** A case's own process: one that has gone, or one in place of the world's. */
const caseProc = oneOf(
  object({ pid: num, gone: lit(true), ppid: optional(none), start: optional(none), state: optional(none), cgroup: optional(none), note: optional(none) }),
  object({ ...procFields, gone: optional(none), note: optional(str) }),
);
/** The blanket link of a relay with the blanket Chrome (board ab-4wh): the blanket scope now, and its link, bridge.info and line. */
const blanketRelay = object({ scope: oneOf(str, nul), link: bool, bridge: oneOf(num, nul), line: oneOf(str, nul) });
const relayFields = { link: bool, bridge: oneOf(num, nul), line: oneOf(str, nul), ended: optional(arr(str)), blanket: optional(blanketRelay) };
const request = object({ path: str, headers: record(str), upgrade: optional(bool) });
const peer = object({ read: bool, pid: num, uid: str, pidfd: optional(oneOf(nul, object({ poll: num, fdinfoPid: num }))), start: optional(oneOf(num, nul)) });
/** An answer id of the endpoint, or the upgrade (with the blanket Chrome: the model that takes the connection). */
const answer = oneOf(str, object({ status: lit(101), model: optional(lit("blanket", "main")) }));
/** A check before the upgrade: with the peer check (a peer, a world, the self-test's result), or without (none of them). */
const upgradeCheck = oneOf(
  object({ note: str, peerCheck: lit(true), relay: object({ ...relayFields, selfTest: str }), request, peer, world: str, procs: optional(arr(caseProc)), service: optional(none), answer }),
  object({ note: str, peerCheck: lit(false), relay: object({ ...relayFields, selfTest: optional(none) }), request, peer: optional(none), world: optional(none), procs: optional(arr(caseProc)), service: optional(none), answer }),
);
/** A check of a remote scope (stage 5 T2): the relay inside the service, with the MCP's ticket. */
const remoteCheck = object({
  note: str, peerCheck: lit(true), relay: object({ ...relayFields, selfTest: str }), service: object({ pid: num, ticket: oneOf(str, nul) }),
  request, peer, world: str, procs: optional(arr(caseProc)), answer,
});
const routed = { session: str, method: str, params: jsonObject, note: optional(str) };
const mcpSession = object({ scope: str, repo: oneOf(str, nul), roots: arr(pidStart), cgroup: str, lifetime_id: oneOf(str, nul), mcp_token: oneOf(str, nul) });
const tcpLine = object({ local: str, remote: str, uid: num, inode: num });
/** A set_sessions of the daemon (C12): the sessions, and each scope's list. */
const mcpSnapshot = object({ sessions: arr(mcpSession), lists: record(oneOf(str, nul)) });

const endpointShape = object({
  contract: str,
  scopeList: arr(str),
  mainFrameId: str,
  scope: object({ pattern: str, valid: arr(str), invalid: arr(str) }),
  defaultContext: str,
  constants: record(num),
  upgradeAnswers: arr(object({ id: str, status: num, body: str })),
  closes: arr(object({ code: num, reason: str, id: optional(str) })),
  templates: arr(str),
  refusals: arr(object({ ...routed, error: str, example: optional(bool) })),
  passes: arr(object(routed)),
  cookieMethods: arr(str),
  cookieMarker: str,
  cookieHide: arr(object({ method: str, in: jsonObject, out: jsonObject, note: optional(str) })),
  modelSet: arr(str),
  pageModelSet: arr(str),
  routing: arr(object({ ...routed, to: str, child: optional(bool), withAct: optional(str) })),
  cookieLimits: arr(str),
  procs: arr(proc),
  /** The allowlist lines: a client's messages, which the reference rules read as they come. */
  lines: record(jsonObject),
  upgradeChecks: arr(upgradeCheck),
  remoteChecks: arr(remoteCheck),
  endScopes: arr(object({
    note: str, peerCheck: bool, scope: str, answer: str,
    steps: arr(object({ line: optional(str), endScope: optional(str), restart: optional(bool) })),
  })),
  lineCloses: arr(oneOf(
    object({ note: str, peerCheck: lit(true), model: optional(lit("blanket")), connection: object({ scope: str, root: pidStart }), line: str, close: oneOf(str, nul) }),
    object({ note: str, peerCheck: lit(false), connection: object({ scope: str, root: nul }), line: str, close: oneOf(str, nul) }),
  )),
  mcpNote: str,
  mcpService: object({ port: num, uid: num }),
  mcpAnswers: arr(object({ id: str, status: num, body: oneOf(str, nul), headers: optional(record(str)), note: optional(str) })),
  mcpTokens: record(object({ token: str, fingerprint: str })),
  mcpSessionIds: record(str),
  mcpLists: record(arr(str)),
  mcpSnapshots: record(mcpSnapshot),
  mcpChecks: arr(object({
    note: str, world: str,
    service: object({ ready: str, snapshot: oneOf(str, nul) }),
    connection: object({ client: str, holders: arr(num), tcp: optional(oneOf(arr(tcpLine), nul)), tcpAgain: optional(oneOf(arr(tcpLine), nul)) }),
    procs: optional(arr(caseProc)),
    requests: arr(object({ path: str, headers: arr(arr(str)), answer: str, pid: optional(oneOf(num, nul)), tool: optional(str) })),
  })),
  mcpCloses: arr(object({ note: str, connection: object({ scope: str, root: pidStart, snapshot: str }), snapshot: str, close: oneOf(str, nul) })),
  /** The blanket profile (board ab-4wh; its cases from board ab-4wh.7): the format's note, step 4's answers and the scope's refusals. */
  blanketNote: str,
  blanketAnswers: arr(object({ id: str, status: num, body: str })),
  blanketRefusals: arr(object({ ...routed, error: str })),
});

export type Endpoint = ShapeOf<typeof endpointShape>;
export type Proc = ShapeOf<typeof proc>;
export type CaseProc = ShapeOf<typeof caseProc>;
export type UpgradeCheck = Endpoint["upgradeChecks"][number];
export type RemoteCheck = Endpoint["remoteChecks"][number];
/** A check before the upgrade, of a local or a remote scope. */
export type Check = UpgradeCheck | RemoteCheck;
/** A check with the peer check: it has a peer, a world and the self-test's result. */
export type Checked = Extract<Check, { peerCheck: true }>;
export type McpCheck = Endpoint["mcpChecks"][number];
export type McpSession = ShapeOf<typeof mcpSession>;
export type McpSnapshot = ShapeOf<typeof mcpSnapshot>;
export type TcpLine = ShapeOf<typeof tcpLine>;

/** test/vectors/endpoint.json, checked. */
export const readEndpoint = (text: string): Endpoint => endpointShape(JSON.parse(text), "endpoint.json");

// ---- The bridge's vectors (C10): its constants, the daemon.blocked vectors and the merge guard's floor ----

const bridgeShape = object({
  constants: record(num),
  pointerConstants: record(num),
  /** A daemon.blocked request and its answer (the tests read the args of two of them as they come). */
  blockedVectors: arr(object({ note: str, req: object({ id: str, op: str, args: json }), res: object({ ok: bool, error: optional(str) }) })),
  floor: object({
    state: object({ hosts: arr(str), guarded: arr(num), marked: arr(num), act: arr(num) }),
    rules: arr(object({
      id: num, priority: num, action: jsonObject,
      condition: object({
        requestDomains: optional(arr(str)), excludedInitiatorDomains: optional(arr(str)), resourceTypes: optional(arr(str)),
        excludedResourceTypes: optional(arr(str)), excludedRequestMethods: optional(arr(str)), excludedTabIds: optional(arr(num)),
      }),
    })),
    cases: arr(object({
      note: str,
      request: object({ tabId: num, type: str, method: str, url: str, initiator: oneOf(str, nul) }),
      blockedBy: arr(num),
    })),
  }),
});
export type Bridge = ShapeOf<typeof bridgeShape>;
/** A daemon.blocked vector whose args are one report with a scope (bl44, bl37): the tests read its scope. */
export const blockedReport = object({ req: object({ id: str, args: arr(object({ scope: str })) }), res: object({ ok: bool, error: optional(str) }) });
/** The copy of chrome-extension's bridge.json: the parts that the tests read, checked. */
export const readBridge = (text: string): Bridge => bridgeShape(JSON.parse(text), "bridge.json");
