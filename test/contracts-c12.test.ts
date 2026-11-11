// Contract C12 (the control door between the service and the agentwatch daemon) and the format of the MCP's allow
// list (a part of C11), board task ab-v16.94.1: docs/contracts/C12.md and docs/contracts/mcp-allow-list.md are their
// masters, and test/vectors/control.json and test/vectors/mcp-allow-list.json their vectors. Stage 1a (board
// ab-v16.94.2) builds the service's control door: test/service-*.test.ts run the real service and its fake against the
// same vectors, and agentwatch's stage 2 (the daemon's client) tests against them too. The small reference rules below
// follow the text, so a vector that breaks a rule fails here first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
// A missing file reads as "", so each assertion fails on its own (tests first).
const readOr = (p: string) => { try { return read(p); } catch { return ""; } };
const C12 = readOr("docs/contracts/C12.md");
const ALLOW = readOr("docs/contracts/mcp-allow-list.md");
const control = JSON.parse(read("test/vectors/control.json"));
const allowV = JSON.parse(read("test/vectors/mcp-allow-list.json"));
const endpoint = JSON.parse(read("test/vectors/endpoint.json"));
const SCOPE = new RegExp(endpoint.scope.pattern);
// The stored sign-ins (board ab-v16.97.1): C11's part on the sign-in act gives the results of the act, and the service
// design (2026-11-09) gains the rows of the sign-in design's section 10.
const C11 = readOr("docs/contracts/C11.md");
const SERVICE_DESIGN = readOr("docs/superpowers/specs/2026-11-09-self-contained-agent-browser-design.md");

const flat = (t: string) => t.replace(/\s+/g, " ");
const says = (text: string, s: string) => flat(text).includes(flat(s));
const isObj = (x: unknown): x is Record<string, any> => x !== null && typeof x === "object" && !Array.isArray(x);
const keysOf = (o: object) => Object.keys(o).sort();
// The part of a text from a bold heading to the next bold heading, or "" when it is missing.
function part(text: string, heading: string) {
  const start = text.indexOf(`**${heading}`);
  if (start < 0) return "";
  const next = text.indexOf("\n**", start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}
// The rows of the Markdown table under a header line: each code span of the first cell -> the other cells.
function table(text: string, header: string) {
  const lines = text.split("\n");
  const at = lines.indexOf(header);
  assert.ok(at >= 0, `the table ${header}`);
  const rows = new Map<string, string[]>();
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith("| ")) break;
    const cells = line.slice(2, -2).split(" | ").map((c) => c.trim());
    // The names before the first " (": a note in parentheses names no row.
    for (const m of cells[0].split(" (")[0].matchAll(/`([^`]+)`/g)) rows.set(m[1], cells.slice(1));
  }
  return rows;
}
const spans = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);


// ---- C12: the reference of the door's rules, each rule from a sentence that C12 states ----

const KINDS = ["operator", "token", "daemon"];
const VIAS = ["web", "send", "cli", "config", "daemon"];
const ERRORS = ["unsupported", "bad request", "not the operator", "this prompt is gone", "no such session"];
// The errors of the stored sign-ins (C12, the stored sign-ins), and the template of the rules of `record`.
const STORE_ERRORS = [
  "the stored sign-ins have no snapshot yet", "the store is set up already", "the store is not set up", "the store is locked",
  "the sealed value cannot be opened", "the passphrase does not open the store", "the passphrase has fewer than 16 characters",
  "the store's key file is not valid", "the stored sign-in was removed", "there is no stored sign-in with this id",
  "a change of the origin needs a new seal of the password", "the stored sign-in cannot be opened",
  // review-112: the names and ids of the store.
  "another stored sign-in has this name", "an offer needs a new id",
];
const RECORD_ERROR = "the stored sign-in is not valid (field <field>)";
// review-112 B5: a protection of the service's memory that does not hold (the design, section 5.5), with its reason.
const UNPROTECTED_ERROR = "the service's memory is not protected (<reason>)";
const REASONS = ["dumpable", "signal"];
const unprotectedError = (reason: string) => UNPROTECTED_ERROR.replace("<reason>", reason);
const recordError = (field: string) => RECORD_ERROR.replace("<field>", field);
const isRecordError = (e: unknown) => typeof e === "string" && /^the stored sign-in is not valid \(field (id|name|origin|path|send_to)\)$/.test(e);
/** agentwatch's user pattern (C12, provenance): a `user` that does not match is a bad request. */
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const LINE_KEYS = ["t", "v", "id", "op", "by"];
const strings = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === "string");
const text1 = (x: unknown) => typeof x === "string" && x.length > 0;
// The field rules of the shape step: each sentence of C12's part, and the check that it states. The test below asserts
// that the part holds exactly these bullets, so the reference takes no rule that C12 does not state.
const RULES = part(C12, "The field rules (the shape step).");
const PATTERN = /`(\^[^`]+\$)`/.exec(RULES)?.[1] ?? "^$";
const scope = (x: unknown) => typeof x === "string" && new RegExp(PATTERN).test(x);
const isRoot = (r: any) => isObj(r) && Number.isSafeInteger(r.pid) && r.pid >= 2 && Number.isSafeInteger(r.start) && r.start >= 0;
/** `mcp_token` (the token design): null, or the 64 lowercase hex digits of a SHA-256. */
const FINGERPRINT = /^[0-9a-f]{64}$/;
const fingerprintOrNull = (x: unknown) => x === null || (typeof x === "string" && FINGERPRINT.test(x));
const onceEach = (list: unknown[]) => new Set(list).size === list.length;
/** The snapshot's rules of the token design: one fingerprint once, one scope once in each list, no fingerprint with a null lifetime id. */
function snapshotFits(req: any): boolean {
  const ss = Array.isArray(req.sessions) ? req.sessions.filter(isObj) : [];
  const rs = Array.isArray(req.remote) ? req.remote.filter(isObj) : [];
  const fps = [...ss, ...rs].map((x: any) => x.mcp_token).filter((t: unknown) => typeof t === "string");
  return onceEach(fps) && onceEach(ss.map((s: any) => s.scope)) && onceEach(rs.map((x: any) => x.scope)) && ss.every((s: any) => s.lifetime_id !== null || s.mcp_token === null);
}
// A rule checks one field (f, its value), or the whole request against the fields of its row (whole).
type FieldRule = [string, (f: string, v: any) => boolean | null, ((req: any, fields: string[]) => boolean)?];
const FIELD_RULES: FieldRule[] = [
  ["A request carries each field of its row of the requests (for `config`, the four fields that it names). A request that omits one of them gets `bad request`. The shape step checks no field outside its row: a side ignores a field that it does not know, and `config` passes agentwatch's other `browser.*` keys as data.",
    () => null, (req, fields) => fields.every((f) => Object.hasOwn(req, f))],
  ["`scope` and `list` at the top level of a request, and `sessions[].scope`, match C11's scope pattern, `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. `remote[].scope` and `remote[].list` are strings, and the shape step checks no pattern for them: `remote` stays empty until stage 5, which gives a remote scope a `<box>/` part (the self-contained design, section 9) and changes this rule first.",
    (f, v) => (f === "scope" || f === "list" ? scope(v) : null)],
  ["A root (`roots` of `set_sessions`) follows C11's root rule: an object with an integer `pid` from 2 to 2^53 - 1 and an integer `start` from 0 to 2^53 - 1. One root that breaks it makes the whole request a bad request (C11's line drops such an item; a snapshot of the daemon is never applied in part).", () => null],
  ["`sessions` is a list of objects with a `scope`, a `repo` (a string or `null`), `roots` (a list of roots), a `cgroup` (a string or `null`), a `lifetime_id` (a string or `null`) and an `mcp_token`. `remote` is a list of objects with the strings `scope`, `box` and `list` and an `mcp_token`. `box` is an object with the lists of strings `hosts` and `cookie_names`.",
    (f, v) => f === "sessions" ? Array.isArray(v) && v.every((s: any) => isObj(s) && scope(s.scope) && (s.repo === null || typeof s.repo === "string") && Array.isArray(s.roots) && s.roots.every(isRoot) && (s.cgroup === null || typeof s.cgroup === "string") && (s.lifetime_id === null || typeof s.lifetime_id === "string"))
      : f === "remote" ? Array.isArray(v) && v.every((x: any) => isObj(x) && typeof x.scope === "string" && typeof x.box === "string" && typeof x.list === "string")
      : f === "box" ? isObj(v) && strings(v.hosts) && strings(v.cookie_names) : null],
  // The token design (board ab-v16.94.10; this stage, board ab-v16.94.5): the fingerprint of each session's connection token, never the token.
  ["`mcp_token` (of an item of `sessions` or of `remote`) is `null` or 64 lowercase hex digits: the fingerprint of the session's connection token, the lowercase hex SHA-256 of the token's ASCII bytes (the connection tokens, below). It is never the token itself.",
    (f, v) => (f === "sessions" || f === "remote" ? Array.isArray(v) && v.every((x: any) => !isObj(x) || fingerprintOrNull(x.mcp_token)) : null)],
  ["One fingerprint appears at most once in a snapshot (in `sessions` and `remote` together). One scope appears at most once in `sessions`, and one remote scope at most once in `remote` (stage 5): the daemon sends no item for a launch name that two live sessions have, so neither of them gets a list or a token. The daemon sends `session_ended` for a launch name only when the last live session of that name ends: when one of two live sessions of a name ends, its next snapshot names the survivor with the survivor's own `lifetime_id` and an `mcp_token` that is the fingerprint of the token that the daemon minted at the survivor's own launch, or `null` when it minted none then (a session launched while the name was shared has none, so agentwatch writes no MCP entry for it: its client sends no `Authorization` header and gets the first 401 of C11's step 7, and only a request with a bearer gets the second 401). An item with `\"lifetime_id\":null` has `\"mcp_token\":null`. A snapshot that breaks one of these rules gets `bad request`, and the service keeps its old snapshot.",
    () => null, (req, fields) => !fields.includes("sessions") || snapshotFits(req)],
  ["`enabled` and `control` are booleans; `chrome_bin` is a string or `null`; `chrome_args` is a list of strings.",
    (f, v) => (f === "enabled" || f === "control" ? typeof v === "boolean" : f === "chrome_bin" ? v === null || typeof v === "string" : f === "chrome_args" ? strings(v) : null)],
  ["`add` and `remove` are lists of strings, and each entry is checked later by the host rules (`list_set`, below). `prompt` and `host` are strings of one character or more.",
    (f, v) => (f === "add" || f === "remove" ? strings(v) : f === "prompt" || f === "host" ? text1(v) : null)],
  ["`payload` is an object. The shape step checks no more of it: the C2 check comes after the kind check, so an `import` with a token's kind gets `not the operator`, whatever its payload.",
    (f, v) => (f === "payload" ? isObj(v) : null)],
  ["`sealed` (the pane's seal) is an object with the strings `text`, `sender`, `rid` and `at`. `record` is an object with the strings `id`, `name`, `origin` and `path` and the list of strings `send_to`. `offer` is a boolean. The shape step checks no more of them: the rules of the stored sign-ins (below) come after the kind check.",
    (f, v) => f === "sealed" ? isObj(v) && ["text", "sender", "rid", "at"].every((k) => typeof v[k] === "string")
      : f === "record" ? isObj(v) && ["id", "name", "origin", "path"].every((k) => typeof v[k] === "string") && strings(v.send_to)
      : f === "offer" ? typeof v === "boolean" : null],
  ["`key` is `null` or an object, and `records` is a list of objects. The shape step checks no more of them: a key or a record that breaks the rules of the stored sign-ins breaks only itself (below).",
    (f, v) => (f === "key" ? v === null || isObj(v) : f === "records" ? Array.isArray(v) && v.every(isObj) : null)],
  // review-112 B4: the field of sign_in_start_again is `credential`, because `id` is a line key.
  ["`credential` is a string of `c-` and 8 lowercase hex digits: a credential's id, as in a record. Its name is not `id`, because `id` is a line key.",
    (f, v) => (f === "credential" ? typeof v === "string" && /^c-[0-9a-f]{8}$/.test(v) : null)],
];
const fieldFits = (f: string, v: unknown) => FIELD_RULES.every(([, check]) => check(f, v) !== false);
const requestFits = (req: any, fields: string[]) => FIELD_RULES.every(([, , whole]) => !whole || whole(req, fields));
// Each op of C12: its fields (from C12's table) and the kinds that it takes (null: any kind).
const OWN = ["daemon"], ACT = ["operator"], START = ["operator", "token"];
// sign_ins_lock: the operator, or the daemon at the uninstall; sign_in_seal with "offer":true: only kind token.
const LOCK = ["operator", "daemon"], OFFER = ["token"];
const SIGN_IN_OPS = ["sign_ins_setup", "sign_ins_unlock", "sign_ins_lock", "sign_ins_rekey", "sign_in_seal", "sign_in_reseal", "sign_in_start_again", "sign_ins"];
const OPS: Record<string, { fields: string[]; kinds: string[] | null }> = {
  sign_ins_setup: { kinds: ACT, fields: ["sealed"] },
  sign_ins_unlock: { kinds: ACT, fields: ["sealed"] },
  sign_ins_lock: { kinds: LOCK, fields: [] },
  sign_ins_rekey: { kinds: ACT, fields: ["sealed"] },
  sign_in_seal: { kinds: ACT, fields: ["record", "offer", "sealed"] },
  sign_in_reseal: { kinds: ACT, fields: ["record"] },
  sign_in_start_again: { kinds: ACT, fields: ["credential"] },
  sign_ins: { kinds: OWN, fields: ["key", "records"] },
  config: { kinds: OWN, fields: ["enabled", "control", "chrome_bin", "chrome_args"] },
  set_sessions: { kinds: OWN, fields: ["sessions", "remote", "box"] },
  session_ended: { kinds: OWN, fields: ["scope"] },
  launch_check: { kinds: OWN, fields: ["scope"] },
  list_set: { kinds: ACT, fields: ["list", "add", "remove"] },
  prompt_allow: { kinds: ACT, fields: ["prompt", "host", "list"] },
  prompt_dismiss: { kinds: ACT, fields: ["prompt"] },
  import: { kinds: ACT, fields: ["payload"] },
  start: { kinds: START, fields: [] },
  stop: { kinds: START, fields: [] },
  status: { kinds: null, fields: [] },
  lists_get: { kinds: null, fields: [] },
  prompts_get: { kinds: null, fields: [] },
  endpoint: { kinds: null, fields: ["scope"] },
  sender: { kinds: null, fields: [] },
};
const byFits = (by: any) => isObj(by) && keysOf(by).join() === "kind,user,via" && KINDS.includes(by.kind) && typeof by.user === "string" && USER.test(by.user) && VIAS.includes(by.via);
type Prompt = { id: string; host: string; list: string };
// The service's error for a request, in C12's order (null: the service applies it). `scopes`: the scopes of the last
// set_sessions less the ones that ended since (for endpoint's `no such session`).
function serviceError(req: any, state: { prompts: Prompt[]; scopes?: Set<string> }): string | null {
  const o = OPS[req.op];
  if (!o) return "unsupported";
  if (!byFits(req.by) || !requestFits(req, o.fields) || !o.fields.every((f) => fieldFits(f, req[f]))) return "bad request";
  const kinds = req.op === "sign_in_seal" && req.offer === true ? OFFER : o.kinds;
  if (kinds !== null && !kinds.includes(req.by.kind)) return kinds === ACT ? "not the operator" : "bad request";
  const p = state.prompts.find((x) => x.id === req.prompt);
  if (req.op === "prompt_dismiss" && !p) return "this prompt is gone";
  if (req.op === "prompt_allow" && (!p || p.host !== req.host || p.list !== req.list)) return "this prompt is gone";
  if (req.op === "endpoint" && state.scopes && !state.scopes.has(req.scope)) return "no such session";
  return null;
}
// ---- The stored sign-ins: the reference of C12's rules (the part "The stored sign-ins") ----
// The vectors' fake values (state.sign_ins): the fake opens no seal and makes no key, so the reference answers the same
// fixed values, and it checks each rule that needs no key: the rules of `record`, the order of the checks, the snapshot,
// the state, the `rid` of a pane's seal, the KDF bounds, the fields that the service seals, the generation and the
// removed ids.
const LOOPBACK = (h: string) => h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1";
/** `origin`: a URL origin as the WHATWG URL parser gives it, `https:`, or `http:` with a loopback host. */
function originFits(o: unknown): boolean {
  if (typeof o !== "string" || !URL.canParse(o)) return false;
  const u = new URL(o);
  return u.origin === o && (u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK(u.hostname)));
}
/** The first field of `record` that breaks its rule, in the order of C12's text, or null. */
function recordBreaks(r: any): string | null {
  if (!/^c-[0-9a-f]{8}$/.test(r.id)) return "id";
  if (!scope(r.name)) return "name";
  if (!originFits(r.origin)) return "origin";
  // review-118 note 8: printable ASCII only, as the binding needs.
  if (!/^\/[\x20-\x7e]*$/.test(r.path) || /[?#]/.test(r.path)) return "path";
  if (!r.send_to.includes(r.origin) || !r.send_to.every(originFits) || new Set(r.send_to).size !== r.send_to.length) return "send_to";
  return null;
}
const B64URL = /^[A-Za-z0-9_-]+$/;
/** The KDF bounds of a `key`: scrypt, N a power of two from 2^15 to 2^18, r 8, p 1, a salt of 16 bytes. */
function kdfFits(key: any): boolean {
  const k = key?.kdf;
  return isObj(k) && k.name === "scrypt" && Number.isSafeInteger(k.n) && k.n >= 2 ** 15 && k.n <= 2 ** 18 && (k.n & (k.n - 1)) === 0 && k.r === 8 && k.p === 1
    && typeof k.salt === "string" && B64URL.test(k.salt) && Buffer.from(k.salt, "base64url").length === 16;
}
/** A `key` that the service takes: a string `public`, an object `wrapped` of the strings `iv`, `ct` and `tag`, and the KDF bounds. */
const keyFits = (key: any) => isObj(key) && key.v === 1 && typeof key.public === "string" && isObj(key.wrapped) && ["iv", "ct", "tag"].every((k) => typeof key.wrapped[k] === "string") && kdfFits(key);
/** The form of a pane's seal's `rid` and `at` (C12, the pane's seal). */
const RID = /^[A-Za-z0-9_-]{22,64}$/, AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/;
/** An `at` of that form that is a real time in UTC (open point 8 of PR #112): the date and the time exist. */
const realTime = (at: string) => { const t = Date.parse(at); return Number.isFinite(t) && new Date(t).toISOString() === (at.length === 20 ? `${at.slice(0, 19)}.000Z` : at); };
type Store = { snap: null | { key: any; records: any[] }; open: boolean; openPublic: string | null; highest: Map<string, number>; removed: Set<string>; rids: Set<string>; unprotected: string | null };
const newStore = (unprotected: string | null = null): Store => ({ snap: null, open: false, openPublic: null, highest: new Map(), removed: new Set(), rids: new Set(), unprotected });
/** Another approved record of the last snapshot has this name (C12, names and ids). */
const nameTaken = (st: Store, id: string, name: string) => (st.snap?.records ?? []).some((x: any) => x.id !== id && x.name === name && x.approved === true);
const storeState = (st: Store) => (st.open ? "open" : st.snap && st.snap.key !== null ? "locked" : "none");
/**
 * C12's answer of an op of the stored sign-ins after the kind check: the rules of record, the snapshot, the state, the
 * protections, the pane's seal, then the op's own checks (review-112: the order of each op's own checks).
 */
function storeAnswer(req: any, st: Store, S: any): { error: string } | { data: Record<string, unknown> } {
  const err = (error: string) => ({ error });
  if (req.op === "sign_in_seal" || req.op === "sign_in_reseal") { const f = recordBreaks(req.record); if (f) return err(recordError(f)); }
  if (req.op === "sign_ins_lock") { st.open = false; return { data: {} }; }
  if (req.op === "sign_ins") {
    // A record that breaks its shape still holds its id (a string) for the removed ids (review-112).
    const ids = new Set(req.records.map((r: any) => r.id));
    for (const r of st.snap?.records ?? []) if (!ids.has(r.id)) st.removed.add(r.id);
    for (const r of req.records) if (Number.isSafeInteger(r.gen) && r.gen >= 1 && r.gen > (st.highest.get(r.id) ?? 0)) st.highest.set(r.id, r.gen);
    if (req.key === null || req.key.public !== st.openPublic) st.open = false;
    st.snap = { key: req.key, records: req.records };
    return { data: { records: req.records.length } };
  }
  if (!st.snap) return err("the stored sign-ins have no snapshot yet");
  const state = storeState(st);
  // The pane's seal: the form of rid and at, a rid seen in the last 120 s, and the vectors' seal more than 120 s from the clock.
  const seal = () => {
    if (!RID.test(req.sealed.rid) || !AT.test(req.sealed.at) || !realTime(req.sealed.at) || st.rids.has(req.sealed.rid)) return false;
    st.rids.add(req.sealed.rid);
    return req.sealed.text !== S.stale_seal;
  };
  const sealed = err("the sealed value cannot be opened");
  // The vectors' seal texts of a new passphrase of fewer than 16 characters: the set-up's and the rekey's.
  const short = (text: string) => text === S.short_passphrase || text === S.short_rekey;
  const unprotected = st.unprotected === null ? null : err(unprotectedError(st.unprotected));
  switch (req.op) {
    case "sign_ins_setup":
      if (st.snap.key !== null || st.open) return err("the store is set up already");
      if (unprotected) return unprotected;
      if (!seal()) return sealed;
      if (short(req.sealed.text)) return err("the passphrase has fewer than 16 characters");
      st.open = true; st.openPublic = S.key.public;
      return { data: { key: S.key } };
    case "sign_ins_unlock":
      if (st.open) return { data: {} };
      if (st.snap.key === null) return err("the store is not set up");
      if (unprotected) return unprotected;
      if (!seal()) return sealed;
      if (!keyFits(st.snap.key)) return err("the store's key file is not valid");
      if (req.sealed.text === S.wrong_passphrase) return err("the passphrase does not open the store");
      st.open = true; st.openPublic = st.snap.key.public;
      return { data: {} };
    case "sign_ins_rekey":
      if (state === "none" || st.snap.key === null) return err("the store is not set up");
      if (state === "locked") return err("the store is locked");
      if (!seal()) return sealed;
      // The new passphrase's length first (the vectors' short_passphrase also holds an old one that does not open).
      if (short(req.sealed.text)) return err("the passphrase has fewer than 16 characters");
      if (!keyFits(st.snap.key)) return err("the store's key file is not valid");
      if (req.sealed.text === S.wrong_passphrase) return err("the passphrase does not open the store");
      return { data: { key: S.rekeyed } };
    case "sign_in_seal": {
      if (state === "none") return err("the store is not set up");
      if (state === "locked") return err("the store is locked");
      if (!seal()) return sealed;
      const r = req.record;
      const offer = req.offer === true;
      if (st.removed.has(r.id)) return err("the stored sign-in was removed");
      // Open point 10 of PR #112: also an id that has a highest gen (of a sign_ins, or of the service's own seal since).
      if (offer && (st.snap.records.some((x: any) => x.id === r.id) || st.highest.has(r.id))) return err("an offer needs a new id");
      if (!offer && nameTaken(st, r.id, r.name)) return err("another stored sign-in has this name");
      const gen = (st.highest.get(r.id) ?? 0) + 1;
      st.highest.set(r.id, gen);
      const record = { v: 1, id: r.id, gen, name: r.name, origin: r.origin, path: r.path, send_to: offer ? [r.origin] : [...r.send_to], repos: null, by: offer ? "offer" : "operator", approved: !offer };
      return { data: { record, sealed: S.sealed } };
    }
    case "sign_in_reseal": {
      if (state === "none") return err("the store is not set up");
      if (state === "locked") return err("the store is locked");
      const r = req.record;
      const old = st.snap.records.find((x: any) => x.id === r.id);
      if (!old) return err("there is no stored sign-in with this id");
      if (old.origin !== r.origin) return err("a change of the origin needs a new seal of the password");
      if (!Number.isSafeInteger(old.gen) || old.gen < 1 || old.gen < (st.highest.get(r.id) ?? 0) || st.removed.has(r.id)) return err("the stored sign-in cannot be opened");
      if (nameTaken(st, r.id, r.name)) return err("another stored sign-in has this name");
      const gen = (st.highest.get(r.id) ?? 0) + 1;
      st.highest.set(r.id, gen);
      const record = { v: 1, id: r.id, gen, name: r.name, origin: r.origin, path: r.path, send_to: [...r.send_to], repos: null, by: old.by, approved: true };
      return { data: { record, sealed: S.sealed } };
    }
    case "sign_in_start_again":
      // review-112 B4: it needs no state; an id that the last snapshot does not hold gets the reseal's text.
      // Open point 9 of PR #112: a removed id is no credential, also when a later sign_ins holds its file again.
      if (!st.snap.records.some((x: any) => x.id === req.credential) || st.removed.has(req.credential)) return err("there is no stored sign-in with this id");
      return { data: {} };
  }
  throw new Error(`not an op of the stored sign-ins: ${req.op}`);
}

/** C12's line rules for the bytes of one line (with its newline): true when the line closes the connection. */
function lineCloses(bytes: Buffer): boolean {
  const line = bytes.subarray(0, bytes.length - 1);
  if (bytes[bytes.length - 1] !== 10 || line.includes(10) || line.includes(13)) return true;
  if (line[0] === 0xef && line[1] === 0xbb && line[2] === 0xbf) return true;
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(line); } catch { return true; }
  let msg: unknown;
  try { msg = JSON.parse(text); } catch { return true; }
  return !isObj(msg) || (msg.t === "req" && typeof msg.id !== "string");
}
// Each event of C12 and its fields (stopped with the reason stop also has by).
const EVENTS: Record<string, string[]> = {
  ready: ["chrome_pid", "chrome_version", "extension_version", "endpoint"],
  prompt: ["id", "state", "host", "scope", "list", "from", "warnings"],
  stopped: ["reason"],
  chrome: ["version", "update"],
  error: ["op", "user", "domain", "counts"],
  sign_in: ["phase", "act", "scope", "repo", "id", "name", "origin", "at"],
  sign_ins: ["state", "pane_key"],
};
// An event's fields, with the extra fields of a stop (`by`) and of a sign-in act's end (`result`, `ms`, `blocked`, `guarded`,
// `stopped_now`: review-112 B1 and B4).
const END_KEYS = ["result", "ms", "blocked", "guarded", "stopped_now"];
const eventKeys = (ev: any) => ["ev", "t", ...EVENTS[ev.ev], ...(ev.ev === "stopped" && ev.reason === "stop" ? ["by"] : []), ...(ev.ev === "sign_in" && ev.phase === "end" ? END_KEYS : [])].sort();
const sayAll =(text: string, list: string[], what = "C12") => { for (const s of list) assert.ok(says(text, s), `${what} says: ${s}`); };

test("C12's master is this file (board ab-v16.94.1): new, two parties, its source, the stages, and no use before stage 1", () => {
  assert.ok(C12.startsWith("# C12. The control door (agent-browser's service <-> the agentwatch daemon)\n"), "the heading");
  sayAll(C12, [
    "This file is the master for C12. C12 is new in board task ab-v16.94.1, stage 0 of the self-contained agent browser.",
    "It binds this repository (the service, `agent-browser service`) and agentwatch (its daemon), and no other.",
    "Its source is the design `docs/superpowers/specs/2026-11-09-self-contained-agent-browser-design.md`, section 7.1: the daemon lead's proposal and review (R1, R7, m1, C4, C7 and C8), the operator's answers of 2026-11-10 (its section 19), and the daemon lead's answers to stage 0's choices (2026-11-10).",
    "The vectors: `test/vectors/control.json`.",
    "| The door, its admission, the hello, the service's answers and its events | agent-browser's service | stage 1 (boards ab-v16.94.2 to ab-v16.94.5), off by default |",
    "| The client, its check of the service, the provenance and the requests | the agentwatch daemon | stage 2, off by default |",
    "Nothing uses C12 before stage 1. The old daemon path stays the default, and it does not change, until stage 3 turns the switch on for a box (with the operator's approval).",
    "The switch moves the parties of C4 and C10 from the daemon to the service on that box; C12 is how the daemon then talks to the service.",
  ]);
});

test("C12 states the door: compact UTF-8 lines, the daemon's own size check (413), and the log rule", () => {
  sayAll(part(C12, "The door."), [
    "A Unix socket with mode 0600, `control.sock`, in the service's run folder (mode 0700): `$XDG_RUNTIME_DIR/agent-browser/` on Linux, `~/.cache/agent-browser/run/` on the Mac. A path is at most 103 bytes. The door has no TCP port.",
    "One JSON object per line, in compact UTF-8 with a newline at its end: no ASCII escapes of characters that UTF-8 can hold (with them a valid C2 payload can grow to three times its size).",
    "A line is at most `CONTROL_MAX_LINE = 33619968` bytes (the 33,554,432 bytes of a C2 payload and 64 KiB more).",
    "The daemon measures each line before it sends it. When a line is longer than `CONTROL_MAX_LINE`, the daemon does not send it, and it answers its own caller with a 413. So the service never has to close the control connection for a line's size. A side that still reads a longer line closes the connection.",
    "The daemon sends the requests. The service sends the answers and the events. The service sends no request.",
    "No side logs page content, a cookie, a URL path, a payload, a token, a token's fingerprint, a username, a password, a passphrase, a wrapped key, a sealed record, a pane's seal or a form value in any log line. A line that a side refuses for its size or its shape is never logged.",
  ]);
  // The stored sign-ins' log rule (board ab-v16.97.1): the old sentence is gone.
  assert.ok(!says(C12, "No side logs page content, a cookie, a URL path or a payload in any log line."), "the door's log rule names the stored sign-ins' values");
  // review-112: the log rules name the wrapped key (the `wrapped` part of key.json).
  assert.ok(!says(C12, "a passphrase, a sealed record, a pane's seal or a form value in any log line"), "the door's log rule names the wrapped key");
  assert.ok(!says(C12, "a payload, a token or a token's fingerprint in any log line"), "the door's log rule names the token and the stored sign-ins' values together (the merge of the two)");
  assert.equal(control.constants.CONTROL_MAX_LINE, 33554432 + 65536, "the C2 limit and 64 KiB");
  for (const v of [...control.requests, ...control.badRequests]) {
    const line = JSON.stringify(v.req);
    assert.ok(!/\\u[0-9a-fA-F]{4}/.test(line), `${v.note}: compact UTF-8, no ASCII escape`);
    assert.ok(Buffer.byteLength(line) + 1 <= control.constants.CONTROL_MAX_LINE, v.note);
  }
});

test("C12 states who connects (R1, m1): the MainPID and its pidfd, the parent, argv[1:] and the exe from agentwatch's file, the same process, a refused peer, and the daemon's check of the service", () => {
  const who = part(C12, "Who connects: only the agentwatch daemon process itself (the daemon lead's R1).");
  sayAll(who, [
    "At each accept the service reads the peer (`SO_PEERCRED` and `SO_PEERPIDFD` on Linux) and admits it only when all of these hold:",
    "1. The service gets the MainPID of agentwatch's unit from the user's systemd at this accept, and it holds a pidfd of the MainPID itself. A daemon restart changes the MainPID.",
    "2. The peer is the MainPID itself, or a direct child of it: the peer's parent pid is the MainPID, and the parent's start time (field 22 of `/proc/<ppid>/stat`) equals the MainPID's start time, read in the same check.",
    "(If agentwatch's unit makes the daemon itself its MainPID, the child case goes, and this file changes first.)",
    "3. The peer is the daemon's command. The service reads the expected command from a file that agentwatch's daemon writes at its start, before it connects, so an agentwatch update needs no restart of the service.",
    "It compares the peer's command line (`/proc/<pid>/cmdline`) from argv[1] on: argv[0] is the interpreter's path in uv's cache, which changes with the script's dependencies (agentwatch runs a uv script).",
    "It also checks the peer's executable (`/proc/<pid>/exe`) against the interpreter that the file names.",
    "4. The peer is the same process during the whole check: the service holds its pidfd, and the peer's start time is the same before and after the reads, and not earlier than its parent's (start times count in clock ticks, so a child can start in its parent's tick). Its parent pid is the same before and after the reads. After the checks the service reads the MainPID again, and it must be the same.",
    "The service checks at most 4 connections at a time. A connection over that limit gets the refused line with its reason (`The control door checks 4 other connections now, so it refuses this one: connect again.`), and the service closes it.",
    "A process of agentwatch's cgroup is not enough. A child that the daemon forks and that connects itself has the daemon, not the MainPID, as its parent, and it is refused. The daemon never passes its connection to another process.",
    "The service's own pid never passes. No agent-browser CLI command is a control client.",
    "A peer that fails a rule of 1 to 4 gets one line `{\"t\":\"refused\",\"reason\":\"<text>\"}` that names the rule, and the service closes the connection and logs the reason.",
    "When the check cannot run, the door refuses (the daemon lead's m1). If the systemd query fails, or the daemon runs with no systemd user unit, the service sends the same line with the reason, closes the connection, and logs the reason.",
    "The daemon shows that line in `agentwatch health`. The service never admits by a weaker rule.",
    "The daemon checks the service too. Before it sends its hello, the daemon admits the peer of `control.sock` only when that peer is the MainPID of `agent-browser.service`, by a pidfd and its start time.",
    "Else it closes the connection and sends nothing: a process of the same user that replaced `control.sock` would otherwise get sign-in payloads and list acts.",
    "On the Mac the service reads `LOCAL_PEERPID`, gets the job's pid from `launchctl print gui/<uid>/<agentwatch's label>` (its `pid` line) at each accept, reads the parent and the start time with `proc_pidinfo` and the command line with `sysctl` (`KERN_PROCARGS2`), and applies the same rules (stage 4; not run on the Mac yet).",
  ]);
  assert.ok(!says(who, "which the service's unit file names"), "the expected command comes from agentwatch's file, not from the unit file");
  for (const r of control.refused) {
    assert.deepEqual(keysOf(r.line), ["reason", "t"], r.note);
    assert.equal(r.line.t, "refused", r.note);
    assert.ok(typeof r.line.reason === "string" && r.line.reason.length > 0, r.note);
  }
  assert.ok(control.refused.some((r: any) => /rule [1-4]/.test(r.line.reason)), "a refused line that names a failed rule (D3)");
});

test("C12 states the hello (C7): its two shapes, v 1, the commit for the pin only, the side check, a new v, additive features, fake, --hello, and no request before the hellos", () => {
  sayAll(part(C12, "The hello (the daemon lead's C7)."), [
    "After the admission each side sends its hello as its first line:",
    "The service: `{\"t\":\"hello\",\"v\":1,\"side\":\"service\",\"version\":\"<agent-browser version>\",\"commit\":\"<commit or null>\",\"features\":[...]}`.",
    "The daemon: `{\"t\":\"hello\",\"v\":1,\"side\":\"daemon\",\"version\":\"<agentwatch version>\",\"features\":[...]}`.",
    "`v` is the version of this door's lines: 1. `version` is the side's package version.",
    "The service's `commit` is the 40-hex commit of agent-browser that it runs, or `null` when it cannot tell; the daemon compares it with its pin (the design, section 7.3). The `commit` is for the pin check only, never for trust.",
    "The daemon refuses a hello whose `side` is not `\"service\"`, and the service refuses a hello whose `side` is not `\"daemon\"`: each closes the connection.",
    "A side that reads a hello whose `v` is not 1 closes the connection and sends no request and no answer; the daemon shows it in `agentwatch health`. A new `v` is a new door, not an additive change.",
    "Fields and features are only added, never changed: a side ignores a field and a feature that it does not know.",
    "A request for an op that the service does not have gets `{\"t\":\"res\",\"id\":\"<id>\",\"ok\":false,\"error\":\"unsupported\"}`. So an older service and a newer daemon (or the reverse) degrade, with no lock-step bump.",
    "Feature names: `fake` (the hello of `agent-browser service --fake`, a scripted state with no Chrome, for agentwatch's hermetic tests), `mcp_token` (the service checks each MCP request's connection token against the `mcp_token` of `set_sessions`: the connection tokens, below), and `sign_ins` (the stored sign-ins, from stage 1e part 1: their eight ops, their two events and the key `sign_ins` of `status`). A stage that adds an op or a field adds its feature name to this list first.",
    "`agent-browser service --hello` prints the service's hello as one line and exits, with no service running.",
    "The daemon sends no request before it has read the service's hello, and the service answers no request before it has read the daemon's hello.",
  ]);
  assert.ok(!says(C12, "for agentwatch's hermetic tests). A stage that adds"), "the feature names gain sign_ins");
  const FEATURES = ["fake", "mcp_token", "sign_ins"];
  const sides = new Set<string>();
  for (const { note, line, newer } of control.hellos) {
    assert.equal(line.t, "hello", note);
    assert.equal(line.v, 1, note);
    assert.ok(["service", "daemon"].includes(line.side), note);
    sides.add(line.side);
    assert.ok(typeof line.version === "string" && line.version.length > 0, note);
    assert.ok(strings(line.features), note);
    const want = line.side === "service" ? ["commit", "features", "side", "t", "v", "version"] : ["features", "side", "t", "v", "version"];
    if (newer) {
      for (const k of want) assert.ok(Object.hasOwn(line, k), `${note}: ${k}`);
      assert.ok(keysOf(line).some((k) => !want.includes(k)) && line.features.some((f: string) => !FEATURES.includes(f)), `${note}: a field and a feature that a reader ignores`);
    } else {
      assert.deepEqual(keysOf(line), want, note);
      for (const f of line.features) assert.ok(FEATURES.includes(f), `${note}: a feature of C12: ${f}`);
    }
    if (line.side === "service") assert.ok(line.commit === null || /^[0-9a-f]{40}$/.test(line.commit), `${note}: the commit`);
  }
  assert.deepEqual([...sides].sort(), ["daemon", "service"], "both sides");
  assert.ok(control.hellos.some((h: any) => h.line.features.includes("fake")), "the hello of --fake");
  assert.deepEqual(control.hellos.find((h: any) => h.line.features.includes("fake")).line.features, ["fake", "mcp_token", "sign_ins"], "the fake's hello has the features mcp_token (the token design) and sign_ins (the stored sign-ins)");
  assert.deepEqual(control.hellos.find((h: any) => h.line.side === "service" && !h.line.features.includes("fake")).line.features, [], "the service of stages 1a to 1c: no feature mcp_token before its token check");
  // A reader closes at a hello of the wrong side or another v (D2, F9).
  const closes = (reader: string, line: any) => line.v !== 1 || line.side !== (reader === "daemon" ? "service" : "daemon");
  for (const h of control.badHellos) assert.equal(closes(h.reader, h.line), h.closes, h.note);
  assert.ok(control.badHellos.some((h: any) => h.reader === "daemon" && h.line.side !== "service" && h.line.v === 1), "the daemon reads a hello that is not the service's");
  assert.ok(control.badHellos.some((h: any) => h.reader === "service" && h.line.side !== "daemon" && h.line.v === 1), "the service reads a hello that is not the daemon's");
  assert.ok(control.badHellos.some((h: any) => h.line.v !== 1), "a hello with another v");
  for (const { line } of control.hellos) assert.equal(closes(line.side === "service" ? "daemon" : "service", line), false, "a good hello does not close");
});

test("C12 states the lines, the line keys, an unknown ev, the field rules (exactly), and provenance (R7) with the order of the service's checks", () => {
  sayAll(part(C12, "The lines."), [
    "A request: `{\"t\":\"req\",\"id\":\"<id>\",\"op\":\"<op>\",\"by\":{\"kind\":\"<kind>\",\"user\":\"<user>\",\"via\":\"<via>\"},...}`, with the op's fields at the top level, as in C4. `id` is a string, unique on its connection.",
    "An answer: `{\"t\":\"res\",\"id\":\"<id>\",\"ok\":true,\"data\":{...}}` or `{\"t\":\"res\",\"id\":\"<id>\",\"ok\":false,\"error\":\"<text>\"}`. The service answers each request once.",
    "An event: `{\"t\":\"ev\",\"ev\":\"<event>\",...}`, with the event's fields at the top level.",
    "No op field uses a line key: `t`, `v`, `id`, `op` or `by`.",
    "A line that is not a JSON object, or a request with no string `id`, closes the connection.",
    "A request with an op that the service does not have gets `unsupported` (the hello, above).",
    "A request whose `by` breaks the shape of provenance (below), or whose fields break the field rules (below), gets `{\"t\":\"res\",\"id\":\"<id>\",\"ok\":false,\"error\":\"bad request\"}`.",
    "A line is strict UTF-8, with no byte order mark and no CR: a line that is not valid UTF-8 (for example the bytes `ED A0 80` of a lone surrogate), a line that starts with a byte order mark (`EF BB BF`), and a line that holds a CR (byte `0D`, for example a line that ends in CR LF) break the compact-line rule, and each closes the connection.",
    "Bytes after the last newline are not a line: a side does not answer them. At the end of the stream it drops them and closes the connection. Many lines can come in one read: a side takes each of them, in order.",
    "A side ignores a line whose `t` it does not know: a newer side can add a kind of line. The daemon ignores an event whose `ev` it does not know, as it ignores a field that it does not know: a newer service can add an event.",
  ]);
  // The field rules: the part holds exactly the reference's bullets, so the reference takes its rules only from C12.
  assert.ok(says(RULES, "The service checks each field of a request with these rules, and with no other rule, before it checks the kind:"), "the field rules' lead sentence");
  const bullets = RULES.split("\n- ").slice(1).map((b) => flat(b).trim());
  assert.deepEqual(bullets, FIELD_RULES.map(([s]) => flat(s)), "the field rules are exactly the reference's");
  assert.equal(PATTERN, endpoint.scope.pattern, "C12's scope pattern is C11's");
  // No op field is a line key (D1).
  for (const [op, o] of Object.entries(OPS)) for (const f of o.fields) assert.ok(!LINE_KEYS.includes(f), `${op}: ${f} is no line key`);
  sayAll(part(C12, "Provenance (the daemon lead's R7)."), [
    "Each request carries one shape of provenance: `\"by\":{\"kind\":\"operator\"|\"token\"|\"daemon\",\"user\":\"<user>\",\"via\":\"web\"|\"send\"|\"cli\"|\"config\"|\"daemon\"}`.",
    "`kind: operator` only when the gateway's field is present with `\"login\":\"password\"`: the gateway adds `\"operator\":{\"user\":...,\"login\":\"password\"}` to the daemon's op only after its password-login check.",
    "The daemon refuses a list change, an allow, a dismissal, an import or an operator act of the stored sign-ins without it. A caller with the API token (an agent, or `agentwatch browser ...` in a terminal) never produces it. Stage 2 tests that an `operator` key in an HTTP body never gives `kind: operator`.",
    "`kind: token` for a start, a stop or a read with the API token (for a start and a stop, today's rule), and for an agent's offer of a stored sign-in (`sign_in_seal` with `\"offer\":true`; the stored sign-ins, below).",
    "`kind: daemon` for the daemon's own requests: `config`, `set_sessions`, `session_ended`, `launch_check`, `sign_ins`, the uninstall's `sign_ins_lock`, and the daemon's own reads.",
    "`browser.control` is a key of agentwatch's config file, so it comes in `config` with `kind: daemon` and `via: config`. The daemon's other own requests have `via: daemon`.",
    "`user` is the agentwatch user: the login's user for `operator`, the token's user for `token`, and the daemon's own user for `daemon`. It matches agentwatch's user pattern, `^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`; a `user` that does not match breaks the shape of provenance (so no log line gets a newline or a control character from it).",
    "`via` is where the act came from: `web` (the web viewer), `send` (the operator extension's send, C9), `cli` (the agentwatch CLI), `config` (the config file), `daemon` (the daemon itself).",
    "The service checks a request in this order: its op (`unsupported`); the shape of its `by` and its fields (`bad request`); then its kind.",
    "The service applies an operator act (`list_set`, `prompt_allow`, `prompt_dismiss`, `import`, `sign_ins_setup`, `sign_ins_unlock`, `sign_ins_rekey`, `sign_in_reseal`, `sign_in_start_again`, and `sign_in_seal` with `\"offer\":false`) only with `kind: operator`; any other kind gets `{\"t\":\"res\",\"id\":\"<id>\",\"ok\":false,\"error\":\"not the operator\"}`.",
    "It applies `start` and `stop` only with `kind: operator` or `kind: token`, `sign_ins_lock` only with `kind: operator` or `kind: daemon`, `sign_in_seal` with `\"offer\":true` only with `kind: token`, and the daemon's own requests (`config`, `set_sessions`, `session_ended`, `launch_check`, `sign_ins`) only with `kind: daemon`; another kind gets `bad request`. The reads (`status`, `lists_get`, `prompts_get`, `endpoint`, `sender`) take any kind.",
    "The service does not check `via`: it logs it.",
    "The service takes provenance only from the control door, never from a client request (C11), and it logs each act with its provenance.",
  ]);
  // The old sentences of provenance are gone (board ab-v16.97.1).
  for (const s of [
    "The daemon refuses a list change, an allow, a dismissal or an import without it.",
    "The service applies an operator act (`list_set`, `prompt_allow`, `prompt_dismiss`, `import`) only with `kind: operator`",
    "and the daemon's own requests (`config`, `set_sessions`, `session_ended`, `launch_check`) only with `kind: daemon`",
  ]) assert.ok(!says(C12, s), `C12 no longer says: ${s}`);
});

test("C12's table of requests names exactly the ops of the reference, with their fields, and states each row", () => {
  const rows = table(C12, "| Op | Fields | What the service does, and its answer's `data` |");
  assert.deepEqual([...rows.keys()].sort(), Object.keys(OPS).sort(), "the ops");
  for (const [op, cells] of rows) {
    const named = spans(cells[0]).filter((s) => /^[a-z_]+$/.test(s));
    for (const f of OPS[op].fields) assert.ok(named.includes(f), `${op}: the field ${f}`);
    if (OPS[op].fields.length === 0) assert.equal(cells[0], "none", `${op}: no field`);
  }
  assert.deepEqual(spans(rows.get("list_set")![0]), ["list", "add", "remove"], "list_set: add and remove, no whole list");
  assert.equal(rows.get("set_sessions")![0], "`sessions` (`[{\"scope\",\"repo\",\"roots\":[{\"pid\",\"start\"}],\"cgroup\",\"lifetime_id\",\"mcp_token\"}]`), `remote` (`[{\"scope\",\"box\",\"list\",\"mcp_token\"}]`, empty until stage 5), `box` (`{\"hosts\",\"cookie_names\"}`)", "the shape of sessions (with each session's lifetime id: D11, and its mcp_token: the token design), remote and box");
  sayAll(C12, [
    "Applies agentwatch's `browser.*` config keys, as data. The daemon sends it at each connect and at each change. `chrome_bin` keeps the way back to Chromium with `--load-extension`; `control: false` makes the endpoint and the MCP path answer their 503 (C11, from stage 3); `enabled: false` stops the browser.",
    "A complete snapshot. The service builds the scopes, the list of each scope (by repo), the `set_scopes` object (C4) and the model's roots. No scope object goes out before the first complete snapshot (the daemon lead's C4).",
    "Ends the scope: closes its tabs (`end_scope`, the receiver's sweep), drops its roots, closes its MCP connections and ends its MCP sessions (C11), removes its list copy, and records the ended scope.",
    "Today's `launch_refusal`.",
    "`data`: `{\"refusal\":\"<text>\"}` while an ended scope of that name is held in memory only, else `{\"refusal\":null}`. The daemon asks before each launch. If the service does not answer in 2 s, the daemon refuses only a name that ended since its own start, with a text that says to try again.",
    "Adds the entries of `add` to one list and removes those of `remove`, as the gateway's list route does today: it never replaces the whole list, so an allow between the daemon's read and its `list_set` stays.",
    "Checks each entry of `add` with the host rules, writes the list file, and the next `set_scopes` carries it.",
    "`data`: `{\"allow\":[\"<entry>\"],\"refused\":[{\"entry\":\"<entry>\",\"reason\":\"<text>\"}]}`, with the list's entries after the change.",
    "Adds the prompt's host to the prompt's list, as a `list_set` with that one host, and answers as `list_set` does.",
    "`host` and `list` are what the operator saw: when they are not the prompt's host and list now, or the service does not know the prompt, the answer is the error `this prompt is gone`.",
    "Dismisses the prompt. The service owns the prompts and their dismissals. A prompt that the service does not know gets the error `this prompt is gone`.",
    "Checks the payload (C2), drops the box's own sign-in cookies (the hosts and names of `set_sessions`), sends `import` to the receiver (C4), and answers the counts of C4's `import`. Nothing is written to disk.",
    "Starts or stops Chrome and Xvfb. The operator answered Q5 on board item ab-1n8: start and stop become automatic, by use (board ab-v16.94.11). Until then today's rule stays (the API token may start and stop).",
    "the state (`off`, `starting`, `ready` or `failed closed`), with an agent's text and an operator's text for each state (I2: no agent's text names a stop or a start)",
    "Chrome's kind, version, pid and update state, and the extension's version; the endpoint's state (the peer check's form, or why it cannot run); the MCP's state; the sessions and lists that the service has; the last stop with its reason and time; the open prompts; the update state; with the feature `sign_ins`, the stored sign-ins' state.",
    // The eight ops of the stored sign-ins (board ab-v16.97.1; the sign-in design, section 6.2; review-112 B4).
    "| `sign_ins_setup` (operator) | `sealed` | Sets up the store with the passphrase of the pane's seal: makes the store key, wraps its private half, and opens the store (the stored sign-ins, below). `data`: `{\"key\":{...}}`, the content of `key.json`, which the daemon writes. |",
    "| `sign_ins_unlock` (operator) | `sealed` | Opens the store: unwraps the wrapped key of the last `sign_ins` with the passphrase of the pane's seal. `data`: `{}`. |",
    "| `sign_ins_lock` (`kind: operator`, or `kind: daemon` for the uninstall) | none | Locks the store: the service drops the open private half. `data`: `{}`. |",
    "| `sign_ins_rekey` (operator) | `sealed` | Checks the old passphrase of the pane's seal against the wrapped key of the last `sign_ins`, and wraps the open private half again with the new one. `data`: `{\"key\":{...}}`, the new content of `key.json`. |",
    "| `sign_in_seal` (operator; `kind: token` for an offer) | `record`, `offer`, `sealed` | Seals the username and the password of the pane's seal (or of the offer command's seal) to the store's public half, with the plain fields as the seal's additional data. `data`: `{\"record\":{...},\"sealed\":{...}}`: the ten plain fields as the service sealed them, and the sealed part, which the daemon writes as one record file. |",
    "| `sign_in_reseal` (operator) | `record` | Opens the record of `record.id` in the last `sign_ins` and seals its values again with the fields of `record`. `data`: as for `sign_in_seal`. |",
    "| `sign_in_start_again` (operator) | `credential` | The operator's \"Start again\": clears the stop of the credential and its count of failed results in a row (the stored sign-ins, below). `data`: `{}`. |",
    "| `sign_ins` | `key`, `records` | A complete snapshot of the store's files, as `set_sessions` is of the sessions: the content of `key.json` (`null` while the store is not set up) and each record file. The service replaces its last snapshot. `data`: `{\"records\":<count>}`. |",
    "| `lists_get`, `prompts_get` | none | The lists and the old single list (read only); the open prompts, each with its recipients. |",
    "The endpoint's URL for the scope (for `agentwatch browser endpoint` and `env`). A scope that the service does not have (no session of the last `set_sessions` has it, or it ended) gets the error `no such session`, not a URL.",
    "The sender's ID, its version and its package (C1, C9).",
    "Stage 1a (board ab-v16.94.2) fixes the keys of the `data` of `status`, `lists_get`, `prompts_get`, `endpoint` and `sender` in the part \"The data of the reads\", below, with the daemon lead's review. They include:",
    "It keeps each session's `lifetime_id` (agentwatch's id of that run of the session) for the recipients of a prompt.",
    "It keeps each session's `mcp_token` (the fingerprint of the session's connection token, or `null`) in memory only, for the token check of the MCP path (C11). The service drops a session's fingerprint with the session, and closes the MCP connections of a session that the snapshot drops or whose `mcp_token` changed.",
    "the agent's text and the operator's text of a state as two separate keys, because the gateway gives the operator's text only to a password login;",
    "each prompt's recipients, the session name and the lifetime id of each session that the block stopped, because the daemon sends them the allow notice (today's gateway does, at an allow);",
    "the MCP's state, for `agentwatch health`.",
    "The design's table names the prompt's field `id`; here it is `prompt`, because `id` is the request's id.",
    "The design's table names a field `providers` for `list_set` too. No list has providers: the operator chose the allow prompt, not a list of sign-in providers (board item ab-pbk). So `list_set` has no such field, and a later rule can add it as an additive field.",
    "The design's `list_set` names the whole list (`allow`); here it adds and removes (the daemon lead's change of 2026-11-10).",
  ]);
  for (const e of [...ERRORS, ...STORE_ERRORS, RECORD_ERROR, UNPROTECTED_ERROR]) assert.ok(C12.includes("`" + e + "`") || C12.includes(`"error":"${e}"`), `C12 names the error ${e}`);
});

const has0 = (f: (v: any) => boolean) => [...control.requests, ...control.badRequests].some(f);
test("each request vector fits C12, gets its answer, and each bad request vector gets the error of C12's order", () => {
  const ids = new Set<string>();
  const ops = new Set<string>();
  // The scopes of the last set_sessions that applied, less the ones that ended since (for endpoint, A1).
  let scopes = new Set<string>();
  // The store of the stored sign-ins, by the reference of C12's rules (the vectors run in their order on one connection).
  const store = newStore();
  // The cases of review-112 that need the order of the vectors: an unlock while the store is open, a reseal of a removed
  // id, and a record that broke its shape for one snapshot and still opens after (its id was not removed).
  const seen = new Set<string>();
  const broken = new Set<string>();
  for (const { note, req, res } of [...control.requests, ...control.badRequests]) {
    if (req.op === "sign_ins_unlock" && store.open && res.ok) seen.add("unlock while open");
    if (req.op === "sign_in_reseal" && store.removed.has(req.record?.id) && store.snap?.records.some((x: any) => x.id === req.record.id) && res.error === "the stored sign-in cannot be opened") seen.add("reseal of a removed id");
    if (req.op === "sign_in_reseal" && broken.has(req.record?.id) && res.ok) seen.add("a broken shape removes nothing");
    // review-112b: the vectors that only the order shows (Start again while locked, a record that breaks its shape, a key
    // file with no public or no wrapped half).
    if (req.op === "sign_in_start_again" && storeState(store) === "locked" && res.ok) seen.add("start again while locked");
    // R24: an offer holds no name; only an approved record does (the lead's merge commit: s53).
    if (req.op === "sign_in_reseal" && res.ok && store.snap?.records.some((x: any) => x.id !== req.record?.id && x.name === req.record?.name && x.approved !== true)) seen.add("an offer holds no name");
    if (req.op === "sign_in_reseal" && store.snap?.records.some((x: any) => x.id === req.record?.id && !Number.isSafeInteger(x.gen)) && res.error === "the stored sign-in cannot be opened") seen.add("a broken shape does not open");
    // review-118 note 9: a key whose v is not 1.
    if (req.op === "sign_ins_unlock" && isObj(store.snap?.key) && store.snap.key.v !== 1 && res.error === "the store's key file is not valid") seen.add("unlock with a key whose v is not 1");
    for (const half of ["public", "wrapped"]) if (req.op === "sign_ins_unlock" && isObj(store.snap?.key) && !Object.hasOwn(store.snap.key, half) && res.error === "the store's key file is not valid") seen.add(`unlock with a key with no ${half}`);
    if (req.op === "sign_ins" && res.ok) for (const r of req.records) if (!Number.isSafeInteger(r.gen)) broken.add(r.id);
    // Open points 8, 9 and 10 of PR #112 (board ab-v16.97.2).
    if (req.op === "sign_in_seal" && req.offer === true && store.highest.has(req.record?.id) && !store.snap?.records.some((x: any) => x.id === req.record.id) && res.error === "an offer needs a new id") seen.add("an offer with an id sealed since the last snapshot");
    if (isObj(req.sealed) && AT.test(req.sealed.at) && !realTime(req.sealed.at) && res.error === "the sealed value cannot be opened") seen.add("an at that is no real time");
    if (req.op === "sign_in_start_again" && store.removed.has(req.credential) && store.snap?.records.some((x: any) => x.id === req.credential) && res.error === "there is no stored sign-in with this id") seen.add("start again of a removed id whose file came back");
    assert.equal(req.t, "req", note);
    assert.ok(typeof req.id === "string" && !ids.has(req.id), `${note}: a unique id`);
    ids.add(req.id);
    assert.equal(res.t, "res", note);
    assert.equal(res.id, req.id, note);
    if (res.ok) {
      assert.deepEqual(keysOf(res), ["data", "id", "ok", "t"], note);
      assert.ok(isObj(res.data), `${note}: data is an object`);
    } else {
      assert.deepEqual(keysOf(res), ["error", "id", "ok", "t"], note);
      assert.ok(ERRORS.includes(res.error) || STORE_ERRORS.includes(res.error) || isRecordError(res.error), `${note}: an error of C12`);
    }
    let error = serviceError(req, { ...control.state, scopes });
    if (error === null && SIGN_IN_OPS.includes(req.op)) {
      const a = storeAnswer(req, store, control.state.sign_ins);
      if ("error" in a) error = a.error;
      else assert.deepEqual(res.data, a.data, `${note}: the data of C12's rules`);
    }
    assert.equal(error, res.ok ? null : res.error, note);
    if (res.ok && req.op === "set_sessions") scopes = new Set(req.sessions.map((x: any) => x.scope));
    if (res.ok && req.op === "session_ended") scopes.delete(req.scope);
  }
  assert.deepEqual([...seen].sort(), ["a broken shape does not open", "a broken shape removes nothing", "an at that is no real time", "an offer holds no name", "an offer with an id sealed since the last snapshot", "reseal of a removed id", "start again of a removed id whose file came back", "start again while locked", "unlock while open", "unlock with a key whose v is not 1", "unlock with a key with no public", "unlock with a key with no wrapped"], "the vectors of review-112, review-112b, open points 8 to 10 of PR #112 and review-118 that need the order");
  // A1: endpoint for a scope that the service does not have, and for a scope that ended: no such session.
  assert.ok(has0((v) => v.req.op === "endpoint" && v.req.scope === "web-3" && v.res.error === "no such session"), "endpoint: a scope never named");
  assert.ok(has0((v) => v.req.op === "endpoint" && control.requests.some((r: any) => r.req.op === "session_ended" && r.req.scope === v.req.scope) && v.res.error === "no such session"), "endpoint: a scope that ended");
  // N8: a user that breaks the pattern is a bad request.
  assert.ok(has0((v) => typeof v.req.by?.user === "string" && !USER.test(v.req.by.user) && /\n/.test(v.req.by.user) && v.res.error === "bad request"), "a user with a newline");
  for (const { req, res } of control.requests) {
    ops.add(req.op);
    if (req.op === "list_set" || req.op === "prompt_allow") assert.ok(strings(res.data.allow) && Array.isArray(res.data.refused), `${req.id}: allow and refused`);
  }
  for (const op of ["config", "set_sessions", "session_ended", "launch_check", "list_set", "prompt_allow", "prompt_dismiss", "import", "start", "stop"]) assert.ok(ops.has(op), `a vector for ${op}`);
  const has = (f: (v: any) => boolean) => [...control.requests, ...control.badRequests].some(f);
  assert.ok(has((v) => v.req.op === "config" && v.req.by.via === "config" && v.req.control === false), "browser.control in config, via config");
  assert.ok(has((v) => v.req.op === "set_sessions" && v.req.sessions.length > 1 && v.req.remote.length === 0), "a complete snapshot, no remote scope before stage 5");
  assert.ok(has((v) => v.req.op === "import" && v.req.by.kind === "operator" && v.req.by.via === "send"), "an import from the send");
  assert.ok(has((v) => v.req.op === "start" && v.req.by.kind === "token" && v.res.ok), "a start with the token: today's rule");
  assert.ok(has((v) => v.req.op === "stop" && v.req.by.kind === "token" && v.res.ok), "a stop with the token: today's rule until ab-v16.94.11");
  for (const op of ["list_set", "prompt_allow", "import"]) assert.ok(has((v) => v.req.op === op && v.req.by?.kind !== "operator" && v.res.error === "not the operator"), `${op} by another kind`);
  for (const e of ERRORS) assert.ok(has((v) => v.res.error === e), `a vector of ${e}`);
  assert.ok(has((v) => v.req.op === "launch_check" && typeof v.res.data?.refusal === "string") && has((v) => v.req.op === "launch_check" && v.res.data?.refusal === null), "launch_check: a refusal and none");
  // D9: the host or the list that the operator saw is not the prompt's now.
  for (const f of ["host", "list"]) assert.ok(has((v) => v.req.op === "prompt_allow" && control.state.prompts.some((p: any) => p.id === v.req.prompt && p[f] !== v.req[f]) && v.res.error === "this prompt is gone"), `prompt_allow: another ${f}`);
  // F8: list_set adds and removes; the old form with the whole list is a bad request.
  assert.ok(has((v) => v.req.op === "list_set" && Object.hasOwn(v.req, "allow") && !Object.hasOwn(v.req, "add") && v.res.error === "bad request"), "list_set: the old whole-list form");
  // B3: each field rule has a bad vector.
  assert.ok(has((v) => v.req.op === "session_ended" && !scope(v.req.scope) && v.res.error === "bad request"), "a scope that breaks the pattern");
  assert.ok(has((v) => v.req.op === "set_sessions" && v.req.sessions.some((s: any) => s.roots.some((r: any) => !isRoot(r))) && v.res.error === "bad request"), "a root that breaks C11's root rule");
  assert.ok(has((v) => v.req.op === "config" && !strings(v.req.chrome_args) && v.res.error === "bad request"), "chrome_args that is not a list of strings");
  assert.ok(has((v) => v.req.op === "import" && v.req.by.kind === "token" && isObj(v.req.payload) && v.res.error === "not the operator"), "an import's payload is only checked as an object before the kind");
});

test("C12's event table names exactly the events of the reference, each event vector has their fields only, with no URL path, page or cookie, and an unknown ev is ignored", () => {
  const rows = table(C12, "| Event | Fields |");
  assert.deepEqual([...rows.keys()].sort(), Object.keys(EVENTS).sort());
  for (const [ev, cells] of rows) for (const f of EVENTS[ev]) assert.ok(spans(cells[0]).includes(f), `${ev}: the field ${f}`);
  const seen = new Set<string>();
  for (const { note, ev } of control.events) {
    assert.equal(ev.t, "ev", note);
    const fields = EVENTS[ev.ev];
    assert.ok(fields, `${note}: an event of C12`);
    seen.add(ev.ev);
    assert.deepEqual(keysOf(ev), eventKeys(ev), note);
    if (ev.ev === "stopped") assert.ok(["receiver_missing", "sessions_unread", "start_failed", "stop"].includes(ev.reason), note);
    if (ev.by !== undefined) assert.ok(byFits(ev.by), `${note}: the stop's provenance`);
    if (ev.ev === "prompt") assert.ok(["open", "changed", "closed"].includes(ev.state) && strings(ev.warnings), note);
    if (ev.ev === "ready") assert.ok(isObj(ev.endpoint) && (["pidfd", "stat", "mac"].includes(ev.endpoint.form) ? keysOf(ev.endpoint).join() === "form" : ev.endpoint.form === null && typeof ev.endpoint.reason === "string"), note);
    assert.ok(!/"(url|path|page|cookie|cookies)"/.test(JSON.stringify(ev)), `${note}: no URL, path, page or cookie`);
  }
  assert.deepEqual([...seen].sort(), Object.keys(EVENTS).sort(), "every event has a vector");
  for (const reason of ["receiver_missing", "sessions_unread", "start_failed", "stop"]) assert.ok(control.events.some((v: any) => v.ev.ev === "stopped" && v.ev.reason === reason), `stopped: ${reason}`);
  // F9: an event that the daemon does not know is ignored.
  assert.ok(control.newerEvents.length > 0, "a vector of an unknown ev");
  for (const v of control.newerEvents) assert.equal(!Object.hasOwn(EVENTS, v.ev.ev), v.ignored, `${v.note}: the daemon ignores an ev that it does not know`);
  sayAll(C12, [
    "`reason`: `receiver_missing`, `sessions_unread`, `start_failed` or `stop`; for `stop`, `by` (the stop's provenance). The daemon sees each fail-closed stop (the daemon lead's C4).",
    "`id`, `state` (`open`, `changed` or `closed`), `host`, `scope`, `list`, `from`, `warnings`; no URL path; the per-host limit of once in 10 s stays",
    "`op`, `user`, `domain`, `counts`; never a page, a cookie or a URL path",
  ]);
});

test("C12 states what happens when the daemon drops, and the vectors' part", () => {
  sayAll(part(C12, "When the daemon drops (a daemon restart or stop)."), [
    "The service goes on. Chrome, the endpoint and the last `set_sessions` stay, and the walk refuses each root that is gone.",
    "The event stream keeps no event for a later reader.",
    "At each connect the daemon reads `status`, which gives the state, the last stop with its reason and time, the open prompts and the update state, so the daemon still sees a `stopped` event that it missed.",
    "The next complete `set_sessions` is the truth again.",
  ]);
  assert.ok(says(part(C12, "The vectors."), "`test/vectors/control.json` holds lines of each kind"), "C12 names its vectors");
});

// ---- Stage 1a (board ab-v16.94.2): the expected command, the data of the reads, the ops of stage 1a, the command, the fake ----

test("C12 names the path and the format of the daemon's expected command (rule 3's file): agentwatch writes it, the service reads it at each accept", () => {
  assert.ok(says(part(C12, "Who connects"), "The part \"The daemon's expected command\", below, names the file's path and its format."), "rule 3 points to the part");
  sayAll(part(C12, "The daemon's expected command (rule 3's file; board ab-v16.94.2)."), [
    "agentwatch's daemon writes this file at its start, before it connects. The service reads it at each accept, so a new file takes effect at the next connection, with no restart of the service.",
    "The path: `$XDG_CONFIG_HOME/agent-browser/daemon-command.json`, or `~/.config/agent-browser/daemon-command.json` when `XDG_CONFIG_HOME` is not set, on Linux and on the Mac. agentwatch's unit passes `--daemon-command <file>` and `--daemon-unit <unit>` explicitly (the command, below): a systemd user unit's environment can lack the user's `XDG_CONFIG_HOME`.",
    "The format: one JSON object in UTF-8, `{\"v\":1,\"interpreter\":\"<path>\",\"args\":[\"<argument>\",...]}`. `v` is 1.",
    "`interpreter` is the absolute, resolved path (`realpath`) of the daemon's interpreter, because `/proc/<pid>/exe` resolves links: a path through a link never matches.",
    "`args` is the daemon's command line from argv[1] on, one string for each argument, in order. The daemon takes `args` from `/proc/self/cmdline`, not from Python's `sys.argv` (which drops the interpreter's flags; `-m` changes argv[0]). The service ignores a key that it does not know.",
    "When the interpreter is replaced on disk, `/proc/<pid>/exe` ends with ` (deleted)`: the door then refuses the daemon (rule 3) until the daemon restarts and writes the file again.",
    "The service opens it once, with no link followed (`O_NOFOLLOW`), and checks the open file (`fstat`), so the file that it checks is the file that it reads.",
    "The check: the target of the peer's `/proc/<pid>/exe` equals `interpreter`, and the peer's `/proc/<pid>/cmdline` from argv[1] on equals `args`, with the same count and each argument the same.",
    "The file is a regular file, not a link, owned by the service's user, and not writable by its group or by others (agentwatch writes it with mode 0600).",
    "A file that is missing, that breaks one of these rules, or whose content breaks the format fails rule 3 at each connection: the refused line names rule 3 and the reason.",
  ]);
  // The example in the text has the format: v 1, an absolute interpreter, args a list of strings, and no box path.
  const m = /`(\{"v":1,"interpreter":"\/[^`]+\})`/.exec(part(C12, "The daemon's expected command"));
  assert.ok(m, "an example of the file");
  const ex = JSON.parse(m![1]);
  assert.deepEqual(keysOf(ex), ["args", "interpreter", "v"]);
  assert.ok(ex.interpreter.startsWith("/") && strings(ex.args) && ex.args.length > 0);
  assert.ok(!/\/home\//.test(m![1]), "no box path in the example");
});

// The keys of the data of each read, from C12's table (stage 1a): a key with an object or a list of objects in braces names
// its inner keys too.
const READS: Record<string, string[]> = {
  status: ["agent_text", "chrome_kind", "chrome_pid", "chrome_version", "endpoint", "extension_version", "last_stop", "lists", "mcp", "operator_text", "prompts", "sessions", "sign_ins", "state", "update"],
  lists_get: ["lists", "old_allow"],
  prompts_get: ["prompts"],
  endpoint: ["url"],
  sender: ["id", "package", "version"],
};
const PROMPT_KEYS = ["from", "host", "id", "list", "recipients", "repo", "scopes", "warnings"];
const LIST_KEYS = ["allow", "error", "name", "repo", "sessions"];

test("C12 fixes the keys of the data of the reads (D11): the agent's text and the operator's text as two keys, each prompt's recipients with the session name and the lifetime id, and a transport-neutral MCP state", () => {
  const rows = table(C12, "| Read | Its answer's `data` |");
  assert.deepEqual([...rows.keys()].sort(), Object.keys(READS).sort(), "the five reads");
  // The top-level keys of each row's shape, in the order of the text.
  const top = (shape: string) => [...shape.slice(1, -1).matchAll(/"([a-z_]+)"(:(\[\{[^\]]*\]|\{[^}]*\}))?/g)].map((x) => x[1]);
  for (const [op, [cell]] of rows) assert.deepEqual(top(spans(cell)[0]).sort(), READS[op], `${op}: its keys`);
  assert.equal(spans(rows.get("prompts_get")![0])[0], "{\"prompts\":[{\"id\",\"host\",\"list\",\"repo\",\"scopes\",\"from\",\"warnings\",\"recipients\":[{\"session\",\"lifetime_id\"}]}]}");
  assert.equal(spans(rows.get("lists_get")![0])[0], "{\"lists\":[{\"name\",\"repo\",\"allow\",\"sessions\",\"error\"}],\"old_allow\"}");
  assert.equal(spans(rows.get("sender")![0])[0], "{\"id\",\"version\",\"package\":{\"name\",\"sha256\",\"base64\"}}");
  sayAll(part(C12, "The data of the reads (stage 1a)."), [
    "`state` is `off`, `starting`, `ready` or `failed closed`. `agent_text` is the state's text for an agent, and `operator_text` is the state's text for the operator: two keys, so the gateway drops `operator_text` for a caller with no password login. No `agent_text` names a stop or a start (I2).",
    "`chrome_kind`, `chrome_version` and `chrome_pid` are Chrome's kind, version and pid, and `extension_version` is the agent extension's version. Each one is `null` while the service does not have that fact (no Chrome runs).",
    "`update` is Chrome's update state, as the `update` of the `chrome` event, or `null`: it is the update state of the requests' table and of a daemon's connect.",
    "`endpoint` is the endpoint's state, as in the `ready` event: `{\"form\":\"<form>\"}` or `{\"form\":null,\"reason\":\"<text>\"}`.",
    "`mcp` is the MCP's state, for `agentwatch health`: `{\"state\":\"<state>\",\"address\":<text or null>}`. `state` is `none` while the service serves no MCP (before stage 1d, and from stage 1d while its MCP path is off), and then `address` is `null`. From stage 1d `state` is also `ready` while the service serves the MCP with its admission and its token check, and `closed` while the service closes each MCP connection with no answer (the Mac, until its peer reader exists), each with the MCP's `address` (C11: `127.0.0.1:<port>`); and `failed` when the service could not open its MCP path, with the `address` `null`. The daemon shows `address` as it is.",
    "`sessions` holds each session of the last `set_sessions`, as `{\"scope\",\"repo\",\"list\",\"mcp_token\"}`: `list` is the name of the scope's list, or `null` while the scope has no list, and `mcp_token` is `true` while the session's item has a fingerprint, else `false`: `status` never gives the fingerprint. `lists` holds the names of the lists that the service has.",
    "`sign_ins` is the stored sign-ins' state, `{\"state\",\"records\",\"acts\",\"pane_key\",\"stopped\",\"unprotected\"}` (the stored sign-ins, below). A service whose hello has no feature `sign_ins` gives no key `sign_ins`.",
    "`last_stop` is `null`, or `{\"reason\",\"at\",\"by\"}`: the reason of the last `stopped` event, its time in UTC (ISO 8601, for example `2026-11-10T06:30:00Z`), and its `by` (`null` for a reason other than `stop`).",
    "Each prompt has its `id`, `host` and `list`, the list's `repo` (or `null`), the `scopes` that its blocks came from, its `from` host (or `null`), its `warnings`, and its `recipients`: the session name (`session`) and the lifetime id (`lifetime_id`) of each session that a block of the prompt stopped, from that session's `lifetime_id` in `set_sessions`. The daemon sends each recipient the allow notice. No log line holds a lifetime id.",
    "`lists_get`: each list with its `name`, its `repo` (or `null`), its entries (`allow`, as `list_set` names them), the scopes that use it (`sessions`), and its read error (`error`, `\"\"` when it has none); `old_allow` is the old single list, read only (`[]` when it cannot be read).",
    "`endpoint`: `url` is the endpoint's URL for the scope, as a client gives it to Playwright (C11).",
    "`sender`: `id` is the sender's extension ID, `version` its version, and `package` the sender package (C1): its file `name`, its `sha256` (64 hex digits) and its bytes in `base64`.",
  ]);
  // The status row of the requests' table keeps the MCP's state with no port number or URL form (the lead's transport rule).
  assert.ok(!/"port"|mcp_port|http:\/\/127/.test(part(C12, "The data of the reads")), "no MCP port or URL in the data's keys");
});

test("the read vectors (q1 to q5) have exactly the keys of C12's data, and status keeps the agent's and the operator's texts apart", () => {
  const reads = control.requests.filter((v: any) => Object.hasOwn(READS, v.req.op));
  assert.deepEqual(reads.map((v: any) => v.req.op).sort(), Object.keys(READS).sort(), "one vector for each read");
  for (const { note, req, res } of reads) {
    assert.ok(res.ok, note);
    assert.deepEqual(keysOf(res.data), READS[req.op], note);
  }
  const data = (op: string) => reads.find((v: any) => v.req.op === op).res.data;
  const status = data("status");
  assert.ok(["off", "starting", "ready", "failed closed"].includes(status.state));
  assert.ok(text1(status.agent_text) && text1(status.operator_text), "two texts");
  assert.doesNotMatch(status.agent_text, /\b(stop|start|restart)/i, "I2: the agent's text names no stop and no start");
  assert.deepEqual(status.mcp, { state: "none", address: null }, "the MCP's state before stage 1d (the only vector of mcp now)");
  // The stored sign-ins' state (the fake has the feature sign_ins): q1 comes before any op of the store.
  assert.deepEqual(status.sign_ins, { state: "none", records: 0, acts: 0, pane_key: control.state.sign_ins.pane_key, stopped: [], unprotected: null }, "the store's state, with no credential's name");
  assert.deepEqual(keysOf(status.endpoint), ["form"]);
  for (const s of status.sessions) assert.deepEqual(keysOf(s), ["list", "mcp_token", "repo", "scope"]);
  // mcp_token in status: true or false for each session of the snapshot, never the fingerprint (the token design).
  const items = control.requests.find((v: any) => v.req.op === "set_sessions").req.sessions;
  assert.deepEqual(status.sessions.map((s: any) => [s.scope, s.mcp_token]), items.map((s: any) => [s.scope, s.mcp_token !== null]), "status's mcp_token: whether the item has a fingerprint");
  assert.ok(status.sessions.some((s: any) => s.mcp_token === true) && status.sessions.some((s: any) => s.mcp_token === false), "both values");
  assert.ok(!/[0-9a-f]{64}/.test(JSON.stringify(status.sessions)), "no fingerprint in status");
  assert.ok(strings(status.lists));
  assert.equal(status.last_stop, null);
  for (const p of [...status.prompts, ...data("prompts_get").prompts]) {
    assert.deepEqual(keysOf(p), PROMPT_KEYS);
    assert.ok(p.recipients.length > 0, "a prompt names its recipients");
    for (const r of p.recipients) assert.deepEqual(keysOf(r), ["lifetime_id", "session"]);
  }
  assert.deepEqual(status.prompts, data("prompts_get").prompts, "status gives the open prompts as prompts_get does");
  // Each recipient is a session of the snapshot, with its lifetime id from set_sessions (D11).
  const snap = control.requests.find((v: any) => v.req.op === "set_sessions").req.sessions;
  for (const p of status.prompts) for (const r of p.recipients) assert.ok(snap.some((s: any) => s.scope === r.session && s.lifetime_id === r.lifetime_id), `${p.id}: ${r.session}`);
  for (const l of data("lists_get").lists) assert.deepEqual(keysOf(l), LIST_KEYS);
  assert.ok(Array.isArray(data("lists_get").old_allow));
  const ep = reads.find((v: any) => v.req.op === "endpoint");
  assert.equal(ep.res.data.url, `ws+unix://${control.state.agent_door}:/devtools/browser/${ep.req.scope}`);
  const sender = data("sender");
  assert.match(sender.id, /^[a-p]{32}$/);
  assert.deepEqual(keysOf(sender.package), ["base64", "name", "sha256"]);
  assert.equal(createHash("sha256").update(Buffer.from(sender.package.base64, "base64")).digest("hex"), sender.package.sha256, "the package's sha256");
  // A set_sessions whose session has no lifetime_id is a bad request (b18).
  assert.ok(control.badRequests.some((v: any) => v.req.op === "set_sessions" && v.req.sessions.some((s: any) => !Object.hasOwn(s, "lifetime_id")) && v.res.error === "bad request"), "a session with no lifetime_id");
});

test("C12 states the ops of stage 1a and the ops that stage 1c adds: unsupported only for the ops of a later stage, and no Chrome, no list and no MCP in stage 1a", () => {
  sayAll(part(C12, "The ops of stage 1a."), [
    "Stage 1a's service (board ab-v16.94.2) has the ops `config`, `set_sessions`, `session_ended`, `status` and `endpoint`.",
    "Stage 1c (board ab-v16.94.4) adds the ops `launch_check`, `list_set`, `prompt_allow`, `prompt_dismiss`, `import`, `lists_get` and `prompts_get`, with the lists, the scopes, the prompts and the sign-ins (the part \"The lists, the scopes, the prompts and the sign-ins (stage 1c)\", below). Each stage adds its ops to the service's table.",
    "The service answers each other op of the requests' table `unsupported`, as the hello says for an op that a service does not have, until a later stage adds that op: `start` and `stop` come with the Chrome unit (stage 1b part 1, board ab-v16.94.3), `sender` with the agent package (stage 1b part 2, board ab-v16.94.9), and `sign_ins_setup`, `sign_ins_unlock`, `sign_ins_lock`, `sign_ins_rekey`, `sign_in_seal`, `sign_in_reseal`, `sign_in_start_again` and `sign_ins` with the stored sign-ins (stage 1e part 1, board ab-v16.97.2).",
    "Stages 1a to 1d add no feature name: the daemon's client (stage 2) needs each of their ops, and stage 2 comes after them. Stage 1e part 1 adds the feature name `sign_ins` with its ops (the stored sign-ins, below), because stage 2's client can come before stage 1e.",
    "Stage 1a has no Chrome, no list and no MCP. `config` and `set_sessions` keep their data in memory. `session_ended` drops the scope's session and records the ended scope in memory.",
    "Its `status` gives the state `off`, `null` for each fact of Chrome and the extension, the `mcp` state `none`, no list and no prompt. Its event stream sends no event, because each event comes from Chrome or a later stage.",
    "From stage 1c, `status` gives each session with its list, the lists and the open prompts, and stage 1c's sentences in the two texts (below). The state stays `off` until stage 1b. The event stream sends stage 1c's `prompt` and `error` events.",
    "`agent-browser service --fake` (below) has every op of the requests' table.",
  ]);
  // Each op of the requests' table is in one sentence once: stage 1a's, stage 1c's, or a later stage's.
  const p = flat(part(C12, "The ops of stage 1a."));
  const cut = (a: string, b: string) => p.slice(p.indexOf(a), p.indexOf(b));
  const opsIn = (t: string) => spans(t).filter((x) => Object.hasOwn(OPS, x));
  const a = opsIn(cut("Stage 1a's service", "Stage 1c (board")), c = opsIn(cut("Stage 1c (board", "The service answers")), later = opsIn(cut("The service answers", "Stages 1a to 1d add no feature name"));
  assert.deepEqual(a, ["config", "set_sessions", "session_ended", "status", "endpoint"]);
  assert.deepEqual(c, ["launch_check", "list_set", "prompt_allow", "prompt_dismiss", "import", "lists_get", "prompts_get"]);
  assert.deepEqual(later, ["start", "stop", "sender", ...SIGN_IN_OPS]);
  assert.ok(!says(C12, "These stages add no feature name"), "stage 1e adds a feature name");
  assert.deepEqual([...a, ...c, ...later].sort(), Object.keys(OPS).sort(), "every op once");
});

test("C12 states the part of stage 1c: the files, a session's repo, the object, the end of a session, the list copy, the texts, the prompts and their events, the dismissals, the import, the error event, later answers and the log", () => {
  const P = part(C12, "The lists, the scopes, the prompts and the sign-ins (stage 1c).");
  sayAll(P, [
    "The service talks to the receiver (C4) and to the model (C10) through one receiver port. In stage 1c the service has no native link: it sends no `set_scopes` and no `import`, and the model gets no allowlist line, until stage 1b part 2 (board ab-v16.94.9) puts the port on the native link.",
    "The lists are today's files in the folder of `--lists-folder`, in today's format: `<list>.json`, `{\"allow\":[<host>...],\"repo\":\"<owner>/<repo>\"|null}`. Only the owner of the Chrome unit writes them (the design, section 13.2), so the service takes no file lock.",
    "A `repo` string that is not an `owner/repo` says that the daemon cannot read the session's repo yet: the scope gets the list `unread-repo`, which is always empty, and the service reads no file of that name.",
    "The service sends `set_scopes` with `default` `null` and `operator` `\"*\"` (C4). It keeps C4's rules 1 and 2 of the tabs of a session that ended: no object before the first complete `set_sessions`, the file of ended scopes and the restart gate. An ok in time is an ok within 10 s on the same link. Only then does the model get the allowlist line, with each session's roots. With no ok in time, the service sends its current object again every 10 s.",
    "At `session_ended` the service writes the file of ended scopes first, then sends `end_scope` to the model (not for a scope that another live session holds), then sends the object without the scope.",
    "The list copy of a scope is `<state>/session-lists/<scope>/allowlist.json`, `{\"allow\":[<host>...]}`: the hosts of the scope's list, for agent-browser's CLI.",
    "At the same times it removes each copy that it wrote whose scope the object no longer names (also a launch name that two live sessions have: the daemon sends no item for it, by the field rules) or names with no list, `unread-repo` or a list with no file, so the CLI refuses that session and never reads an old list's hosts.",
    "A session's `list` in the status is the list that the current object gives its scope, or `null` while the object gives none (a launch that the restart gate holds, an ended name). A launch name that two live sessions have has no session in the status: the daemon sends no item for it (the field rules), so neither session gets a list.",
    "`launch_check`'s refusal is today's text: \"A session named <scope> ended a moment ago, and the agent browser could not record it (<error>). Choose another name, or wait until the agent browser confirms its lists.\" The vectors' `r6` gives it with the error `the file of ended scopes cannot be written: ENOSPC`, and the fake answers so.",
    "Each entry of `refused` has the host rules' reason, for example `paste the host only` (the vectors' `r7`).",
    "`list_set` changes nothing and answers an error for the list `unread-repo` (`the list unread-repo is always empty, so it takes no entry`), for a list file that it cannot read (`the list file of <list> cannot be read, so the service does not change it`), and for a write that fails (`the list file of <list> cannot be written: <kind>`).",
    "The agent's text gets only \"The agent browser's extension has not confirmed the lists yet.\" while a receiver is there and has not confirmed the current object.",
    "A blocked report (the receiver's `blocked`, or the model's `daemon.blocked`) goes on at most once in 10 s for each host, across scopes and sources, and the service keeps at most 256 hosts for this.",
    "A `closed` event names the prompt's host, its first scope and its list, with `from` `null` and `warnings` empty.",
    "A dismissal holds 24 hours and outlives a restart of the service: `prompt-dismissals.json` keeps at most 500. When the service cannot write a dismissal, `prompt_dismiss` answers the error `the dismissal cannot be written: <kind>`, and the prompt stays open.",
    "Before the first `set_sessions`, or with no box host, it answers `the sign-in send is not valid (field box_hosts)`. It drops each cookie whose name is one of `box.cookie_names` or starts with `agentwatch` (today's rule), and each cookie that a box host would get.",
    "After an `import` whose answer holds errors, the service sends the `error` event: `op` is `import`, `user` is the act's user, `domain` is the payload's domain, and `counts` is `{\"errors\":<their number>}` (never their texts, which can name a cookie). The event goes out before the `import`'s answer line, when the receiver's answer comes.",
    "An answer can come after the answers of later requests: an `import` answers when the receiver answers, and the service answers the other requests of the connection in that time. The daemon matches each answer by its `id`. When the daemon ends its side of the connection, it still gets the answers that the service owes it; then the service ends its side.",
    "No log line holds an entry of a `list_set`, a refused entry, a lifetime id, a cookie, a storage value or a payload.",
  ]);
  for (const old of ["(also a name that two live sessions share)", "while the object gives none (a launch name that two live sessions have,"]) assert.ok(!says(C12, old), `C12: no ${old} (review-113 B1)`);
  // The texts that the part names are the code's (one text on both sides).
  const r7 = control.requests.find((v: any) => v.req.id === "r7");
  assert.deepEqual(r7.res.data.refused, [{ entry: "https://bad/x", reason: "paste the host only" }], "r7: the host rules' reason");
  assert.ok(!/\/home\//.test(P), "no box path");
});

test("C12 states the ops of stage 1b part 2 (board ab-v16.94.9): sender and its data, extension_version, the agent package, the native link, the receiver port, the model and the watch; the values are the code's", async () => {
  const P = part(C12, "The ops of stage 1b part 2 (board ab-v16.94.9).");
  sayAll(P, [
    "Stage 1b part 2 adds the native link, the agent package and the model to the service (the design, sections 5.1, 5.3 and 5.4), and the op `sender`: the service no longer answers it `unsupported`. Now no op of stages 1a to 1d gets `unsupported` from the service; only the ops of the stored sign-ins do, until stage 1e part 1 (the stored sign-ins, below). The stage adds no feature name, as the part of stage 1a says.",
    "`id` is the sender's ID, `bpfkgknpndlpkcffmaaelkfcbpackiip`. `version` is the version in the manifest of that commit's `operator/` folder (`0.2.0`), not the receiver's version. `package` is a zip of that folder: its `name` is `agentwatch-sender-<version>.zip`, its `sha256` is the SHA-256 of the zip's bytes, and `base64` holds the bytes.",
    "When the service cannot read the folder, `sender` answers the error `the sender package cannot be read: <kind>`. The fake gives the vectors' empty zip.",
    "`extension_version` (in `status` and in the `ready` event) is the receiver's version from the hello of the link's current connection.",
    "With no connection (before the first hello, and after the link drops until the next hello) it is the version of the agent package that the service gave this Chrome at its start (also a start with the package file of the last start, which the service uses only while its staged CRX has the pinned SHA-256), or `null` (an adopted Chrome, or a Chromium of `chrome_bin`).",
    "Before each start of Google Chrome from the tools folder, the service checks the CRX against the pinned SHA-256 and ID, copies it into `agent-crx/` in the tools folder, and writes Chrome's external extensions file next to the copy's binary (`extensions/<receiver ID>.json`).",
    "The link socket is `link.sock` in the folder of `control.sock`, with mode 0600.",
    "The link admits only a shim whose parent is the service's Chrome, by pid and start time, on the agent profile. After it writes the manifest, the service ends the old owner's host by the rule of the design's build note 7, through a pidfd.",
    "Stage 1c's `set_scopes`, `import`, allowlist line, `end_scope` and blocked reports use this link now, with the rules of stage 1c's part (below): the push, its 10 s wait, the import's waits and the `prompt` events.",
    "one request of channel `main` at a time, a bridge channel that never waits behind an import, parts of at most 700,000 bytes, the joins of result parts, `MAX_BYTES_IN_FLIGHT`, the waits and the deadline answers.",
    "`daemon.pointerAt`, `daemon.movePointer` and `daemon.blocked` are calls inside the service, with C10's checks. The X pointer is the Chrome unit's own Xvfb.",
  ]);
  // The stored sign-ins (board ab-v16.97.1): their eight ops get `unsupported` until stage 1e part 1, so the old sentence is gone.
  assert.ok(!says(C12, "Now no op of the requests' table gets `unsupported` from the service."), "the stored sign-ins' ops stay unsupported until stage 1e");
  // The values that the part names are the code's.
  const { SENDER_ID, RECEIVER_ID, CHROME_EXTENSION_COMMIT, NATIVE_HOST_NAME } = await import("../src/service/package/pins.ts");
  const { senderData } = await import("../src/service/package/sender.ts");
  const { PART_BYTES } = await import("../src/service/link/parts.ts");
  const { linkSocketFor } = await import("../src/service/main.ts");
  const real = senderData();
  assert.ok(says(P, `\`${SENDER_ID}\``) && says(P, `\`${RECEIVER_ID}\``) && says(P, `\`${CHROME_EXTENSION_COMMIT.slice(0, 7)}\``) && says(P, `\`${NATIVE_HOST_NAME}\``));
  assert.ok(says(P, `(\`${real.version}\`)`), "the sender's version");
  assert.equal(PART_BYTES, 700_000);
  assert.equal(linkSocketFor("/run/x/agent-browser/control.sock"), "/run/x/agent-browser/link.sock");
  // The vectors' sender has the real ID, version and name; only its zip is the fake's empty one.
  const q5 = control.requests.find((v: any) => v.req.op === "sender");
  assert.deepEqual([q5.res.data.id, q5.res.data.version, q5.res.data.package.name], [real.id, real.version, real.package.name]);
  assert.deepEqual(control.state.sender, q5.res.data);
});

test("C12 states the ops of stage 1b part 1 (board ab-v16.94.3): start and stop, their answers after the work, the owner rule's error, the events of the Chrome unit, the values of Chrome's facts, and the command's new flags", () => {
  sayAll(part(C12, "The ops of stage 1b part 1 (board ab-v16.94.3)."), [
    "Stage 1b part 1 adds the Chrome unit to the service (the design, sections 5.1, 5.6 and 13.2) and the ops `start` and `stop`: the service no longer answers them `unsupported`. Each other op that stage 1a answers `unsupported` stays so until its stage.",
    "`start` starts Chrome and Xvfb and answers when they run, with `data` `{}`, or with the start's error text (for example a refused switch of `chrome_args`, or that Google Chrome is being installed into the tools folder). `stop` stops them and answers when they are gone, with `data` `{}`.",
    "A `start` or a `stop` while the service does not own the Chrome unit (the design, section 13.2) gets the error `the agent-browser service does not own the agent browser now`, and the service changes nothing.",
    "A `start` and a `stop` answer when their work ends, so their answer can come after the answer of a later request and after their events: the daemon matches each answer by its `id`. A daemon that half-closes the connection after a request still gets that answer; the service closes the connection after its last answer.",
    "`ready` comes when Chrome and Xvfb run after a `start`, a restart by the service's supervisor, an adoption at the service's start, or a Chrome move. Each start of Chrome sends one `ready` with its new `chrome_pid`, and no Chrome gets a second one: a `start`, a restart by the supervisor, the start of a wanted Chrome at the first `config` after an adoption that found no live Chrome (or at the service's start, when that `config` came before the adoption ended), a move and the way back of a failed move; the daemon follows Chrome's pid (its memory guard) from these events. Stage 1b part 1 has no native link and no agent package (stage 1b part 2), so `extension_version` is `null`, and with no receiver the fail-closed watch stops Chrome 60 s after the last confirm on it, with the `stopped` reason `receiver_missing`.",
    "`chrome` comes when the version or the update state of the running Chrome changes.",
    "`stopped` comes at a `stop` that stopped a running Chrome (with the stop's `by`), at a stop of the fail-closed watch (`receiver_missing` or `sessions_unread`), and once after three failed starts or early exits (an exit within 5 minutes) in a row (`start_failed`). A `config` with `enabled: false` stops Chrome with no event, also one that came before the service's start ended (the adopted Chrome then stops).",
    "`state` is `ready` while Chrome and Xvfb run; `starting` during a start, while the supervisor starts a wanted Chrome again, and while a wanted Chrome waits for the first `config`; `failed closed` after a stop of the fail-closed watch; else `off`. After a stop of the fail-closed watch, only a `start` starts Chrome again: a later `config` starts nothing, and `state` stays `failed closed`.",
    "`chrome_kind` is `google-chrome` (Google Chrome stable from the tools folder, when `chrome_bin` is empty or `null`) or `chromium` (the Chromium of `chrome_bin`): the kinds of the unit record.",
    "`chrome_version` is the version of the tools folder's copy, in the form of Google's index (`a.b.c.d-r`, for example `157.0.7000.1-1`), or `null` when the service does not know it (a Chromium of `chrome_bin`). The `ready` and `chrome` events carry the same value.",
    "`update` is `null` while no Google Chrome of the tools folder runs; else `current`, `waiting` (a newer copy waits for the idle hour and for the clients to leave), `moving` (a move or the probation of its new copy runs), or `failed` (the last move failed, and the last good copy runs).",
  ]);
  sayAll(part(C12, "The command (stage 1b part 1)."), [
    "`agent-browser service` takes two more flags: `--tools-dir <folder>` (required, with no default), the tools folder of Google Chrome (today's `~/.local/share/agentwatch-tools/`, which agentwatch's unit gives); and `--service-unit <unit>`, the service's own unit, whose state decides the owner (the design, section 13.2), by default `agent-browser.service`. The Chrome unit keeps its files in the folder of `--state-folder` (stage 1c's flag, the agent browser's state folder): the profile, `unit.json`, the X auth file, `chrome-update.json` and `watch.json`.",
    "The service owns the Chrome unit only while its own unit is `active`, `activating` or `deactivating` and the unit's MainPID is the service. When it does not own at its start, it closes its control door and exits with status 1. When it finds later that it no longer owns, it stops its owner parts and exits with status 1. Chrome and Xvfb stay, for the next owner.",
    "`agent-browser service stop --all --state-folder <folder>` stops the Chrome unit with no service running (the uninstall, and the Mac's open point 3 of the design's section 17): each Chrome on the profile and the unit's Xvfb, of this user only. It finds them also when `<folder>`, or their own arguments, name the folder through a link: it compares the real paths. It writes no file.",
    "`--test` serves the real service for the live harness only: the service owns with no systemd unit, the MainPID of rule 1 is the service's parent (the harness), and it needs `--test-display`. It is refused when a folder is missing or is a default folder, and when `--test-display` names a reserved display (0, 90, 147, 190, 191 or 192: the harnesses' list). Its test-only `--test-chrome-source` names a local folder and a test key in place of Google's index. agentwatch never passes these flags.",
  ]);
  // The vectors use the values that this part fixes.
  assert.equal(control.state.chrome.kind, "google-chrome");
  assert.match(control.state.chrome.version, /^\d+(\.\d+){3}-\d+$/);
  for (const v of control.events.filter((e: any) => e.ev.ev === "ready")) assert.equal(v.ev.chrome_version, control.state.chrome.version);
  for (const v of control.events.filter((e: any) => e.ev.ev === "chrome")) assert.ok(["current", "waiting", "moving", "failed", null].includes(v.ev.update) && v.ev.version === control.state.chrome.version);
  assert.ok(["current", "waiting", "moving", "failed", null].includes(control.state.update));
});

test("C12 states the command of stage 1a and the fake service (the daemon lead's C10): the flags, the fake's admission, its own rules and its events from standard input", () => {
  sayAll(part(C12, "The command (stage 1a)."), [
    "agentwatch's unit runs `agent-browser service --agent-door <address> --lists-folder <folder> --state-folder <folder> [--control-door <path>] [--daemon-unit <unit>] [--daemon-command <file>]`. Nothing starts it before stage 2, and no install step of this repository writes a unit for it.",
    "`--lists-folder` (required, from stage 1c): the folder of the lists, `CONFIG_DIR/browser/lists/` (the design, section 7.5). The old single list is `allowlist.json` in its parent folder. It has no default, so the service never reads the lists of a folder that the unit did not give.",
    "`--state-folder` (required, from stage 1c): the agent browser's state folder (the design, section 5.2). The service keeps `ended-scopes.json`, `session-lists/<scope>/allowlist.json` and `prompt-dismissals.json` in it. It has no default.",
    "`--agent-door` (required): the agent door's address, which the daemon gives (today's endpoint path during the move: the design, section 13). In stage 1a it is the path of a Unix socket, and the agent door is today's endpoint with today's peer check (C11).",
    "`--control-door`: the path of `control.sock`. The default is `control.sock` in the run folder (the door, above).",
    "`--daemon-unit`: agentwatch's unit, whose MainPID rule 1 reads. The default is `agentwatch.service`.",
    "`--daemon-command`: the file of the daemon's expected command. The default is its path above.",
    "`--hello` prints the hello and exits (the hello, above). `--fake` serves the fake (below).",
    "The service runs until `SIGTERM` or `SIGINT`, and then it removes its sockets.",
  ]);
  sayAll(part(C12, "The fake service (`--fake`; the daemon lead's C10)."), [
    "`agent-browser service --fake --control-door <path>` serves the control door for agentwatch's hermetic tests, with the scripted state of the vectors (the `state` of `test/vectors/control.json`) and no Chrome. Its code is `src/service/fake.ts`.",
    "Its hello has `\"commit\":null` and the features `fake`, `mcp_token` and `sign_ins`. It has every op of the requests' table, and it gives each request vector its answer when the vectors run in their order on one connection.",
    "It takes `mcp_token` by the field rules and keeps it for each session of the last `set_sessions`, in memory only, and its `status` gives `mcp_token` (`true` or `false`) for each session. It serves no MCP.",
    "It admits each connection that reaches its socket: the socket has mode 0600 in a folder of mode 0700, and the fake holds no list, no sign-in, no Chrome and no data of the user. It never listens in the service's run folder: the folder of the default `control.sock`, and on Linux also `/run/user/<uid>/agent-browser/` (the default when `XDG_RUNTIME_DIR` is not set). It compares the real folder of its socket (after links, before and after it makes the folder) with each of them, so it never takes the place of the service. With `--refuse`, each connection gets the refused line of rule 2 of the vectors, and the fake closes it.",
    "Its own rules where the vectors stop: it starts in the state `ready`. A `start` in the state `off` sends the vectors' first `ready` event, and a `stop` in the state `ready` sends `stopped` with the reason `stop` and the stop's `by`. An allow or a dismissal closes the prompt, with a `prompt` event in the state `closed`. `session_ended` holds the ended scope until the next `set_sessions`. `endpoint` gives the URL of the address of `--agent-door` (no agent door listens), else of the vectors' address.",
    "Each line on its standard input that is an event of the event table, with exactly its fields, goes to each connection that has sent its hello. The fake drops each other line. So a test sends the events that it needs.",
    "After its socket listens, the fake prints one line on its standard output, `{\"t\":\"listening\"}`, so that a test waits for that line.",
  ]);
  assert.ok(says(part(C12, "The vectors."), "Its `set_sessions` lines carry `mcp_token`, and its bad lines `b22` to `b32` break each rule of `mcp_token`, each with the fixed `bad request` answer. `r14` is the daemon's snapshot while two live sessions have one launch name: it has no item for that name. `r15` is its next snapshot after one of them ended, with no `session_ended`: it names the survivor with its own `lifetime_id` and `\"mcp_token\":null`. Its `testTokens` are made-up test values in a token's form, with their fingerprints: the door never carries a token."));
  assert.ok(!says(C12, "Its hello has `\"commit\":null` and the feature `fake`."), "the fake's old hello sentence is gone");
  assert.ok(says(part(C12, "The vectors."), "Its `state` is the service's state for these lines and the fake's state at its start; the reads (`q1` to `q5`) give the keys of the data of the reads. Its `badLines` are lines as bytes (in hex) that close the connection: a byte order mark, a CR, and bytes that are not UTF-8."));
  // The vectors' state holds the prompts of the reference (id, host, list) and the fake's other facts.
  for (const p of control.state.prompts) assert.deepEqual(keysOf(p), PROMPT_KEYS, p.id);
  assert.equal(control.state.state, "ready", "the fake starts ready");
  assert.deepEqual(control.state.mcp, { state: "none", address: null });
});

test("C12 states the recipients' lifetime ids (B4): the run that the block stopped, a new run with a new set_sessions, null passes through, and no feature name for lifetime_id", () => {
  sayAll(part(C12, "The data of the reads (stage 1a)."), [
    "A recipient's `lifetime_id` is the one of the run that the block stopped: the session's `lifetime_id` in the `set_sessions` in force when the block happened, not a later one. A new run of a session comes with a new `set_sessions` that carries its new `lifetime_id`. A session whose `lifetime_id` is `null` is still a recipient, with `\"lifetime_id\":null`.",
  ]);
  sayAll(part(C12, "The ops of stage 1a."), [
    "The field `lifetime_id` of `set_sessions` (stage 1a) comes with no feature name either, although the hello says that a stage that adds a field adds its feature name first: the daemon's client (stage 2) comes after stage 1, so no daemon talks to a service without it.",
  ]);
  // A vector of a recipient whose lifetime id is null: its session has null in set_sessions.
  const snap = control.requests.find((v: any) => v.req.op === "set_sessions").req.sessions;
  const nulls = control.state.prompts.flatMap((p: any) => p.recipients).filter((r: any) => r.lifetime_id === null);
  assert.ok(nulls.length > 0, "a recipient with a null lifetime id");
  for (const r of nulls) assert.ok(snap.some((s: any) => s.scope === r.session && s.lifetime_id === null), r.session);
  assert.ok(!/MCP port/.test(C12), "no MCP port in C12 (B3)");
});

// ---- The connection tokens (board ab-v16.94.5, build task 1 of the token design, board ab-v16.94.10): C12's part, the field and its vectors ----

const TOKEN_HEADING = "The connection tokens (from stage 1d, board ab-v16.94.5; the token design, board ab-v16.94.10).";
// The part's lead paragraph and its bullets, in order: the part holds exactly these.
const TOKEN_PART: string[] = [
  `**${TOKEN_HEADING}** The token design is \`docs/superpowers/specs/2026-11-10-mcp-connection-tokens-design.md\`, with the operator's answers of 2026-11-10. agentwatch's daemon mints a connection token for each session that it launches while the rules of the token design's section 9.1 hold (agentwatch launches the session with a lifetime id and the switch on; the session's repo's list has a site; the service's hello has the feature \`mcp_token\`; the \`LISTEN\` line of the MCP path's TCP port has the user's uid; the client takes the entry's form). It writes the token into the session's MCP entry only after the service took the token's fingerprint (rule 6). The service never gets a token: \`set_sessions\` carries only each token's fingerprint, in the session's own item (\`mcp_token\`). C11 states the token check of the MCP path (its admission, step 7).`,
  "No new op and no provenance change: `set_sessions` stays `kind: daemon`.",
  "The daemon sends `mcp_token` in each item of `sessions`, to every service: the fingerprint of the session's token, or `null` for a session that has no token. An item with no `mcp_token` gets `bad request` (the field rules). The daemon writes no MCP entry for a service whose hello has no feature `mcp_token`, and it then sends `null` for each session.",
  "The service keeps the fingerprints of the last `set_sessions` in memory only, never on disk, and it drops a session's fingerprint with the session. Its log and its `status` name a scope and say whether the session has a token, never a fingerprint.",
  "The `bad request` answer to `set_sessions` never echoes the snapshot or any field of it: no scope, no lifetime id and no fingerprint.",
  "Before a launch with the entry, the daemon waits up to 5 s for the answer to the `set_sessions` that carries the session's fingerprint. At a failure (`bad request`, or no answer in 5 s) it writes no entry file, it launches the session without the entry, and its next snapshot carries `\"mcp_token\":null` for that session.",
  "When a `set_sessions` that drops a session or a remote fingerprint fails (`bad request`, or no answer in 5 s), the daemon sends its current snapshot again after 1 s, then with a delay that doubles up to 60 s, and at each reconnect. A `bad request` on such a snapshot is a fault: the daemon's health line is red. \"Drops\" compares with the last snapshot that the service took, so the daemon sends again until the service takes a snapshot without that session or that fingerprint. Each resend is the current snapshot, so it also carries each later change. The daemon may send every failed snapshot again in the same way, and the service takes each one as it takes any `set_sessions`.",
  "Each item of `remote` carries its remote session's fingerprint in the same field (stage 5: the calling box's daemon mints the remote token). `remote` stays empty until stage 5.",
  "The service's hello gets the feature `mcp_token` in stage 1d, with the MCP path and its token check. The hello lists it while `status`'s `mcp` state is `ready`, and only then; `agent-browser service --hello` serves no MCP, so its hello has no `mcp_token`. The service opens its MCP path before its control door, so its `mcp` state is fixed before its first hello and stays the same for the service's run: each connection of a run gets the same features, and a hello with no `mcp_token` means no MCP until the service's next start. The daemon waits for no other line. Before stage 1d the service takes the field by the field rules and gives it in `status`, and it serves no MCP.",
];

test("C12's part on the connection tokens holds exactly its sentences, after the part of stage 1b part 2 and before the part of stage 1c (the token design, section 13)", () => {
  const P = part(C12, TOKEN_HEADING);
  assert.ok(P, "the part");
  const items = P.trim().split("\n- ").map((x) => flat(x).trim());
  assert.deepEqual(items, TOKEN_PART.map(flat), "the part holds exactly its sentences, in order");
  assert.ok(C12.indexOf("**The ops of stage 1b part 2 (board ab-v16.94.9).**") < C12.indexOf(`**${TOKEN_HEADING}**`), "after the part of stage 1b part 2");
  assert.ok(C12.indexOf(`**${TOKEN_HEADING}**`) < C12.indexOf("**The lists, the scopes, the prompts and the sign-ins (stage 1c).**"), "before the part of stage 1c");
  // No token, no box path and no MCP port in the part (C12's own rules).
  assert.ok(!/abt1_[A-Za-z0-9_-]/.test(C12) && !/\/home\//.test(P) && !/MCP port/.test(P));
});

const sha256 = (s: string) => createHash("sha256").update(s, "ascii").digest("hex");
const setSessionsLines = () => [...control.requests, ...control.badRequests].filter((v: any) => v.req.op === "set_sessions");
const strsOf = (x: unknown): string[] => typeof x === "string" ? [x] : Array.isArray(x) ? x.flatMap(strsOf) : isObj(x) ? Object.values(x).flatMap(strsOf) : [];
/** The fields of a set_sessions line that its answer must not echo: each scope, lifetime id and mcp_token (and a remote item's box and list). */
const lineFields = (req: any) => [...(Array.isArray(req.sessions) ? req.sessions : []), ...(Array.isArray(req.remote) ? req.remote : [])]
  .flatMap((x: any) => strsOf([x.scope, x.lifetime_id, x.mcp_token, x.box, x.list])).filter((s) => s.length >= 4);
const echoes = (res: unknown, fields: string[]) => fields.filter((f) => JSON.stringify(res).includes(f));

test("the test tokens are made-up values in a token's form (abt1_ and 43 base64url characters, 32 bytes of their own ASCII label), each with its fingerprint (the lowercase hex SHA-256 of its ASCII bytes)", () => {
  assert.ok(control.testTokens.length >= 2, "two test tokens");
  for (const t of control.testTokens) {
    assert.match(t.token, /^abt1_[A-Za-z0-9_-]{43}$/, t.name);
    const raw = Buffer.from(t.token.slice(5), "base64url");
    assert.equal(raw.length, 32, `${t.name}: 32 bytes`);
    assert.equal(raw.toString("base64url"), t.token.slice(5), `${t.name}: the canonical base64url of its bytes`);
    assert.ok(/^test, not a token: [ -~]+$/.test(raw.toString("latin1")), `${t.name}: its bytes name it a test value`);
    assert.equal(t.fingerprint, sha256(t.token), `${t.name}: the fingerprint`);
  }
  assert.ok(says(control.testTokensNote, "none is a real token"), "the note names them test values");
});

test("the set_sessions vectors carry mcp_token: a good line with two fingerprints and nulls, and a bad line for each rule of mcp_token, each with the fixed bad request answer (the token design, section 13)", () => {
  const fp = (name: string) => control.testTokens.find((t: any) => t.name === name).fingerprint;
  const token = (name: string) => control.testTokens.find((t: any) => t.name === name).token;
  const good = control.requests.filter((v: any) => v.req.op === "set_sessions");
  for (const { note, req } of good) {
    for (const s of req.sessions) assert.ok(Object.hasOwn(s, "mcp_token") && fingerprintOrNull(s.mcp_token), `${note}: ${s.scope} carries its mcp_token`);
    assert.ok(snapshotFits(req), note);
  }
  const r3 = good.find((v: any) => v.req.id === "r3").req.sessions;
  assert.deepEqual(r3.filter((s: any) => s.mcp_token !== null).map((s: any) => [s.scope, s.mcp_token]), [["web-1", fp("web-1")], ["tool-4", fp("tool-4")]], "r3: two sessions with their own fingerprints");
  assert.ok(r3.some((s: any) => s.lifetime_id === null && s.mcp_token === null), "r3: a session with no lifetime id has no fingerprint");
  const bad = control.badRequests.filter((v: any) => v.req.op === "set_sessions");
  for (const v of bad) assert.deepEqual(v.res, { t: "res", id: v.req.id, ok: false, error: "bad request" }, `${v.note}: the fixed answer`);
  const items = (v: any) => [...v.req.sessions, ...v.req.remote];
  // Each rule has a bad line that breaks it.
  const by = (what: string, f: (v: any) => boolean) => assert.ok(bad.some((v: any) => f(v)), what);
  by("63 hex digits", (v) => items(v).some((x: any) => typeof x.mcp_token === "string" && /^[0-9a-f]{63}$/.test(x.mcp_token)));
  by("65 hex digits in a remote item", (v) => v.req.remote.some((x: any) => /^[0-9a-f]{65}$/.test(x.mcp_token)));
  by("uppercase hex", (v) => items(v).some((x: any) => typeof x.mcp_token === "string" && /^[0-9A-F]{64}$/.test(x.mcp_token) && /[A-F]/.test(x.mcp_token)));
  by("a token in place of its fingerprint (never on the door)", (v) => items(v).some((x: any) => x.mcp_token === token("web-1")));
  by("an item with no mcp_token", (v) => v.req.sessions.some((s: any) => !Object.hasOwn(s, "mcp_token")) && v.req.sessions.every((s: any) => !Object.hasOwn(s, "mcp_token") || fingerprintOrNull(s.mcp_token)));
  by("one fingerprint in two items", (v) => v.req.sessions.length === 2 && v.req.sessions[0].mcp_token !== null && v.req.sessions[0].mcp_token === v.req.sessions[1].mcp_token && v.req.sessions[0].scope !== v.req.sessions[1].scope);
  by("one scope in two items (each with no fingerprint)", (v) => v.req.sessions.length === 2 && v.req.sessions[0].scope === v.req.sessions[1].scope && v.req.sessions.every((s: any) => s.mcp_token === null));
  by("a fingerprint with the lifetime id null", (v) => v.req.sessions.some((s: any) => s.lifetime_id === null && FINGERPRINT.test(s.mcp_token ?? "")));
  by("one fingerprint in a session and in a remote item", (v) => v.req.sessions.some((s: any) => v.req.remote.some((x: any) => x.mcp_token === s.mcp_token && s.mcp_token !== null)));
  by("one remote scope in two remote items", (v) => v.req.remote.length === 2 && v.req.remote[0].scope === v.req.remote[1].scope && v.req.remote[0].mcp_token !== v.req.remote[1].mcp_token);
  by("a remote item with no mcp_token (review-113)", (v) => v.req.remote.length > 0 && v.req.remote.some((x: any) => !Object.hasOwn(x, "mcp_token")) && v.req.sessions.length === 0);
  // review-113 B1: the daemon sends no item for a launch name that two live sessions have (r14 and its live sessions).
  const shared = good.find((v: any) => Array.isArray(v.live));
  assert.ok(shared, "a set_sessions vector with the daemon's live sessions (r14)");
  const names = shared.live.map((s: any) => s.scope);
  assert.ok(names.some((n: string) => names.indexOf(n) !== names.lastIndexOf(n)), "two live sessions with one launch name");
  assert.deepEqual(shared.req.sessions.map((s: any) => s.scope), names.filter((n: string) => names.indexOf(n) === names.lastIndexOf(n)), "an item for each launch name of one live session only");
  for (const s of shared.req.sessions) assert.equal(s.lifetime_id, shared.live.find((x: any) => x.scope === s.scope).lifetime_id, `${s.scope}: its lifetime id`);
  assert.deepEqual(shared.res, { t: "res", id: shared.req.id, ok: true, data: {} });
  // The bad request answer echoes no field of the refused snapshot (14.1: the scan of the answer), and the scan reads its text (its twin).
  for (const v of bad) assert.deepEqual(echoes(v.res, lineFields(v.req)), [], `${v.note}: no field of the line in the answer`);
  const planted = bad.map((v: any) => ({ ...v.res, error: `bad request: ${lineFields(v.req)[0]}` }));
  for (const [i, v] of bad.entries()) assert.notDeepEqual(echoes(planted[i], lineFields(v.req)), [], `${v.note}: the scan finds a planted field (its twin)`);
  // No line of the door carries a token, except b24, which shows a token in place of its fingerprint (a bad request).
  const withToken = [...control.requests, ...control.badRequests, ...control.events].filter((v: any) => /abt1_/.test(JSON.stringify(v.req ?? v.ev)) || /abt1_/.test(JSON.stringify(v.res ?? null)));
  assert.deepEqual(withToken.map((v: any) => v.req?.id), ["b24"], "only b24 carries a token, and its answer does not");
  assert.ok(!/abt1_/.test(JSON.stringify(control.state)) && !/abt1_/.test(JSON.stringify(control.hellos)), "no token in the state or the hellos");
  assert.ok(/abt1_/.test(JSON.stringify({ ...control.events[0], ev: { ...control.events[0].ev, chrome_version: token("web-1") } })), "the token scan finds a planted token (its twin)");
  assert.ok(bad.length >= 11 && bad.every((v: any) => /^b(2[2-9]|3[0-2])$/.test(v.req.id) || ["b15", "b18"].includes(v.req.id)), "the bad set_sessions lines b15, b18 and b22 to b32");
  assert.equal(setSessionsLines().length, good.length + bad.length);
});

// Open point 6 (the daemon lead's decision): the daemon sends session_ended for a launch name only when the last live
// session of that name ends, and its next snapshot names the survivor with the survivor's own lifetime id and token.
test("C12 states the daemon's rule for a launch name that two live sessions had (open point 6), and r15 follows it after r14", () => {
  assert.ok(says(C12, "The daemon sends `session_ended` for a launch name only when the last live session of that name ends: when one of two live sessions of a name ends, its next snapshot names the survivor with the survivor's own `lifetime_id` and an `mcp_token` that is the fingerprint of the token that the daemon minted at the survivor's own launch, or `null` when it minted none then (a session launched while the name was shared has none, so agentwatch writes no MCP entry for it: its client sends no `Authorization` header and gets the first 401 of C11's step 7, and only a request with a bearer gets the second 401)."), "C12: the daemon's rule of open point 6");
  const at = (id: string) => control.requests.findIndex((v: any) => v.req.id === id);
  const r14 = control.requests[at("r14")], r15 = control.requests[at("r15")];
  assert.ok(r15 && at("r15") > at("r14"), "r15 follows r14");
  // No session_ended for web-5 between them: a live session of that name is left.
  assert.ok(!control.requests.slice(at("r14"), at("r15")).some((v: any) => v.req.op === "session_ended" && v.req.scope === r15.ended.scope), "no session_ended for the shared name");
  const left = r14.live.filter((s: any) => !(s.scope === r15.ended.scope && s.lifetime_id === r15.ended.lifetime_id));
  assert.deepEqual(r15.live, left, "r15's live sessions: r14's, less the one that ended");
  const survivor = r15.req.sessions.find((s: any) => s.scope === r15.ended.scope);
  assert.ok(survivor, "r15 names the survivor");
  assert.equal(survivor.lifetime_id, r15.live.find((s: any) => s.scope === r15.ended.scope).lifetime_id, "the survivor's own lifetime id");
  assert.notEqual(survivor.lifetime_id, r15.ended.lifetime_id, "not the lifetime id of the session that ended");
  assert.equal(survivor.mcp_token, null, "a session launched while the name was shared has no token");
  assert.deepEqual(r15.req.sessions.map((s: any) => s.scope).sort(), r15.live.map((s: any) => s.scope).sort(), "an item for each live launch name, each once");
  assert.ok(snapshotFits(r15.req), "r15 fits the snapshot rules");
  assert.deepEqual(r15.res, { t: "res", id: "r15", ok: true, data: {} });
});

test("the line rules' vectors (badLines, B1): a byte order mark, a CR and bytes that are not UTF-8 each close the connection, by the reference of C12's line rules", () => {
  assert.ok(Array.isArray(control.badLines) && control.badLines.length >= 3);
  for (const v of control.badLines) {
    const bytes = Buffer.from(v.hex, "hex");
    assert.equal(lineCloses(bytes), v.closes, v.note);
    assert.equal(v.closes, true, v.note);
  }
  const lines = control.badLines.map((v: any) => Buffer.from(v.hex, "hex"));
  assert.ok(lines.some((b: Buffer) => b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf), "a BOM line");
  assert.ok(lines.some((b: Buffer) => b.includes(13)), "a CR LF line");
  assert.ok(lines.some((b: Buffer) => b.includes(Buffer.from([0xed, 0xa0, 0x80]))), "a lone surrogate's bytes");
  // Without its BOM, its CR or its bad bytes each line is a good request: only the rule closes it.
  const req = Buffer.from(JSON.stringify(control.requests.find((v: any) => v.req.op === "status").req) + "\n");
  assert.equal(lineCloses(req), false);
});

// ---- The MCP's allow list: the reference of the format ----

const NEVER = ["core-install", "storage", "devtools", "testing", "config"];
const UNSAFE = "browser_run_code_unsafe";
// A property that names a file or a path: a string (or a list of strings) whose name or description says so.
const speaksOfFile = (k: string, p: any) => isObj(p) && (p.type === "string" || (p.type === "array" && p.items?.type === "string")) && /file|path|folder|directory/i.test(`${k} ${p.description ?? ""}`);
// The service's own tools (the stored sign-ins, board ab-v16.97.1): the value that the format's text gives, in every list.
const SERVICE_TOOLS_TEXT = /They are exactly these two, in every list:\s*```json\s*(\{.*?\})\s*```/s.exec(ALLOW)?.[1] ?? null;
const SERVICE_TOOLS = SERVICE_TOOLS_TEXT === null ? null : JSON.parse(SERVICE_TOOLS_TEXT);
const REMOTE_TOOL_ERROR = { isError: true, text: "Not signed in: Stored sign-ins work only for sessions of this box." };
function brokenRules(list: any, pinned: { name: string; inputSchema: any }[], pin: string) {
  const out = new Set<string>();
  const service = list.service_tools ?? {};
  for (const n of Object.keys(service)) if (pinned.some((t) => t.name === n)) out.add("no service tool is a tool of the pinned tools/list");
  if (JSON.stringify(service) !== JSON.stringify(SERVICE_TOOLS)) out.add("service_tools is exactly the service's own tools");
  if (list.package !== "@playwright/mcp" || list.version !== pin) out.add("version is the pin");
  if (list.capabilities.some((c: string) => NEVER.includes(c))) out.add("no core-install, storage, devtools, testing or config");
  const names = pinned.map((t) => t.name);
  for (const n of names) if (Object.hasOwn(list.tools, n) === Object.hasOwn(list.refused, n)) out.add("each tool in tools or refused, once");
  for (const n of [...Object.keys(list.tools), ...Object.keys(list.refused)]) if (!names.includes(n)) out.add("each tool in tools or refused, once");
  if (!Object.hasOwn(list.refused, UNSAFE) || Object.hasOwn(list.tools, UNSAFE)) out.add("browser_run_code_unsafe in refused");
  for (const [n, r] of Object.entries<any>(list.tools)) {
    const p = pinned.find((t) => t.name === n);
    if (p && JSON.stringify(r.schema) !== JSON.stringify(p.inputSchema)) out.add("each schema equals the pinned schema");
    const props = r.schema?.properties ?? {};
    if (r.keys.some((k: string) => !Object.hasOwn(props, k))) out.add("keys are properties of the schema");
    if (r.paths.some((k: string) => !r.keys.includes(k))) out.add("paths are keys");
    for (const k of r.keys) if (speaksOfFile(k, props[k]) && !r.paths.includes(k)) out.add("a file or path key is in paths");
  }
  return [...out].sort();
}
function callAnswer(list: any, call: { name: string; arguments: Record<string, unknown> }, folder: string, realpath: Record<string, string> = {}, admission: "local" | "remote" = "local") {
  const service = list.service_tools ?? {};
  if (Object.hasOwn(service, call.name)) {
    // The service answers its own tools itself: a remote admission gets the sign-in act's check 1, whatever the arguments.
    if (admission === "remote") return REMOTE_TOOL_ERROR;
    for (const k of Object.keys(call.arguments ?? {})) if (!service[call.name].keys.includes(k)) return { code: -32602, message: `Not available in the agent browser: the argument ${k} of ${call.name}` };
    return "service";
  }
  const r = Object.hasOwn(list.tools, call.name) ? list.tools[call.name] : null;
  if (!r) return { code: -32601, message: `Not available in the agent browser: ${call.name}` };
  for (const k of Object.keys(call.arguments ?? {})) if (!r.keys.includes(k)) return { code: -32602, message: `Not available in the agent browser: the argument ${k} of ${call.name}` };
  for (const k of r.paths) {
    if (!Object.hasOwn(call.arguments, k)) continue;
    for (const p of ([] as unknown[]).concat(call.arguments[k])) {
      if (!String(realpath[String(p)] ?? "").startsWith(folder)) return { code: -32602, message: `Not available in the agent browser: ${k} must name a file in the session's folder ${folder}` };
    }
  }
  return "pass";
}
/** The names of `tools/list`: the pinned tools that `tools` names, in the pinned order, and the service's own tools for a local admission. */
const toolsList = (list: any, pinned: { name: string }[], admission: "local" | "remote") =>
  [...pinned.map((t) => t.name).filter((n) => Object.hasOwn(list.tools, n)), ...(admission === "local" ? Object.keys(list.service_tools ?? {}) : [])];

test("the allow list's format: the master file, why, the file's fields, what the service does and the test of stage 1d", () => {
  assert.ok(ALLOW.startsWith("# The MCP's allow list (a part of C11)\n"), "the heading");
  for (const s of [
    "This file is the master for the format of the MCP's allow list. It is a part of C11 (`docs/contracts/C11.md`, the MCP inside the service).",
    "Its source is the design `docs/superpowers/specs/2026-11-09-self-contained-agent-browser-design.md`, section 8.2, and the operator's answer Q4 of 2026-11-10 (the standard Playwright MCP, pinned, under the allow list; the design's section 19).",
    "Stage 1d (board ab-v16.94.5) writes the first list for the pinned version of `@playwright/mcp`, and its test.",
    "Stage 1d's first list, `src/service/mcp/allow-list.json`, is for `@playwright/mcp` 0.0.83: it holds the 24 tools of that version's `tools/list` other than `browser_run_code_unsafe`, as M3's part C did for 0.0.85 (the self-contained design, section 8.2). Stage 0 adds no package. The vectors of the format: `test/vectors/mcp-allow-list.json`.",
    "each tool of the pinned version's `tools/list` is in `tools` or in `refused`, once;",
    "`browser_run_code_unsafe` is in `refused`;",
    "The service serves only the tools and the argument keys that the list names, not every tool except some. So a new tool or a new argument in a newer `@playwright/mcp` reaches no client until a review adds it to the list.",
    "One JSON file for the one pinned version of `@playwright/mcp`, in this repository.",
    "`package` is `@playwright/mcp`. `version` is the exact pinned version, the same as the pin in `package.json`.",
    "`capabilities` names the MCP's capabilities that the service turns on, explicitly: the ones that give the tools of `tools`. It never names `core-install`, `storage`, `devtools`, `testing` or `config`.",
    "`tools` maps each allowed tool to its rule. `keys` lists each argument key that the service passes. `paths` lists each key of `keys` that names a file or a path. `schema` is the tool's input schema in the pinned version's `tools/list`, as it is.",
    "`refused` maps each other tool of the pinned version's `tools/list` to the reason why the service never serves it.",
    "`browser_run_code_unsafe` is always in `refused`: it runs a client's JavaScript in the MCP server's process, which inside the service holds the lists, the native link and the control door's state.",
    "Each tool of the pinned version's `tools/list` is in `tools` or in `refused`, and in only one of them.",
    "`tools/list`: the service drops each tool that `tools` does not name, and adds each tool of `service_tools` for a request with a local admission; a request that a remote token admitted gets no tool of `service_tools`.",
    "`tools/call` of a tool that neither `tools` nor `service_tools` names: the service refuses it before the call reaches the MCP's code, with the JSON-RPC error `-32601` and the message `Not available in the agent browser: <tool>`.",
    // The service's own tools (board ab-v16.97.1; the sign-in design, section 10).
    "The stored sign-ins design (`docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md`, board ab-v16.95, section 10) adds the service's own tools, `service_tools`; their MCP build is board ab-v16.97.5, with stage 1d.",
    "`service_tools` maps each of the service's own tools to its rule: `keys` (each argument key that the service takes), a `description` and a `schema` (the tool's input schema). They are no tools of `@playwright/mcp`: the service answers them itself (C11, the sign-in act). They are exactly these two, in every list:",
    "`tools/call` of a tool of `service_tools`: the service answers it itself, and the call never reaches the MCP's code. For a request that a remote token admitted, the answer is the tool error of the sign-in act's check 1, a result with `isError: true` and the text `Not signed in: Stored sign-ins work only for sessions of this box.`, whatever its arguments. For a request with a local admission, an argument key that the tool's `keys` does not name gets the `-32602` answer above; else the service runs the sign-in act's method for the MCP session's scope (C11, the sign-in act).",
    "no name of `service_tools` is a tool of the pinned version's `tools/list`;",
    "`service_tools` is exactly the value that this file gives;",
    "`tools/call` with an argument key that the tool's `keys` does not name: the service refuses it before the call reaches the MCP's code, with the JSON-RPC error `-32602` and the message `Not available in the agent browser: the argument <key> of <tool>`.",
    "An argument whose key is in the tool's `paths`: the service refuses it when the path is outside the scope's folder, `<state>/mcp/<scope>/`, after `realpath` (C11), with the JSON-RPC error `-32602` and the message `Not available in the agent browser: <key> must name a file in the session's folder <folder>`.",
    "The MCP answers `initialize` and `tools/list` with no CDP connection (the design, section 18), so the test needs no Chrome. It fails when any of these is false:",
    "each `schema` equals that tool's input schema in the pinned version, so any change of a tool fails the test, and each bump of the pin needs a new review of the list;",
    "each key of `keys` is a property of its tool's `schema`, and each key of `paths` is a key of `keys`;",
    "each string property whose schema speaks of a file or a path (its name or its description) is in `paths`, or is left out of `keys`;",
    "`capabilities` names none of `core-install`, `storage`, `devtools`, `testing` and `config`.",
  ]) assert.ok(says(ALLOW, s), `the allow list's format says: ${s}`);
  // The file's example shape in the text is the vector's list shape.
  const m = /```json\s*(\{.*?\})\s*```/s.exec(ALLOW);
  assert.ok(m, "the text shows the file's fields");
  assert.deepEqual(keysOf(JSON.parse(m![1])), keysOf(allowV.list), "the same fields as the example list");
  // The old sentences of tools/list and of an unknown tool are gone (board ab-v16.97.1).
  for (const s of ["`tools/list`: the service drops each tool that `tools` does not name.", "`tools/call` of a tool that `tools` does not name:"]) assert.ok(!says(ALLOW, s), `the format no longer says: ${s}`);
  // The service's own tools: exactly browser_sign_in (name) and browser_sign_ins (no argument), each with its schema.
  assert.ok(SERVICE_TOOLS, "the text gives the value of service_tools");
  assert.deepEqual(Object.keys(SERVICE_TOOLS), ["browser_sign_in", "browser_sign_ins"]);
  for (const [n, r] of Object.entries<any>(SERVICE_TOOLS)) {
    assert.deepEqual(keysOf(r), ["description", "keys", "schema"], n);
    assert.ok(text1(r.description) && !/\b(stop|start|restart)/i.test(r.description), `${n}: a description that names no stop or start (I2)`);
    assert.deepEqual(r.keys, Object.keys(r.schema.properties), `${n}: its keys are the properties of its schema`);
    assert.equal(r.schema.additionalProperties, false, `${n}: no other argument`);
  }
  assert.deepEqual(SERVICE_TOOLS.browser_sign_in.keys, ["name"]);
  assert.deepEqual(SERVICE_TOOLS.browser_sign_in.schema.required, ["name"]);
  assert.deepEqual(SERVICE_TOOLS.browser_sign_ins.keys, []);
});

test("each allow list vector follows the format: the example breaks no rule, each bad list breaks exactly its rule, each call gets the format's answer", () => {
  assert.deepEqual(brokenRules(allowV.list, allowV.pinnedTools, allowV.pin), [], "the example list");
  assert.ok(Object.hasOwn(allowV.list.refused, UNSAFE));
  const rules = new Set<string>();
  for (const b of allowV.badLists) {
    // A bad list can carry its own pinned tools/list (a newer version with a tool of a service tool's name).
    assert.deepEqual(brokenRules(b.list, b.pinnedTools ?? allowV.pinnedTools, allowV.pin), [b.breaks], b.note);
    rules.add(b.breaks);
  }
  assert.equal(rules.size, 10, "each rule of the format's test has a bad list (the rule \"once\" has two: a tool in neither and a tool in both)");
  for (const r of ["no service tool is a tool of the pinned tools/list", "service_tools is exactly the service's own tools"]) assert.ok(rules.has(r), `a bad list of the rule: ${r}`);
  const answers = new Set<string>();
  for (const c of allowV.calls) {
    assert.deepEqual(callAnswer(allowV.list, c.call, allowV.folder, c.realpath, c.admission ?? "local"), c.answer, c.note);
    answers.add(c.answer === "pass" || c.answer === "service" ? c.answer : c.answer.isError ? "tool error" : String(c.answer.code));
  }
  assert.deepEqual([...answers].sort(), ["-32601", "-32602", "pass", "service", "tool error"]);
  // The service's own tools: run for a local admission, the tool error of check 1 for a remote one (each tool), and the key check.
  for (const n of ["browser_sign_in", "browser_sign_ins"]) {
    assert.ok(allowV.calls.some((c: any) => c.call.name === n && (c.admission ?? "local") === "local" && c.answer === "service"), `${n}: a local call runs`);
    assert.ok(allowV.calls.some((c: any) => c.call.name === n && c.admission === "remote" && c.answer.isError === true), `${n}: a remote call gets check 1`);
  }
  assert.ok(allowV.calls.some((c: any) => c.call.name === "browser_sign_in" && c.admission === "remote" && Object.keys(c.call.arguments).some((k) => k !== "name")), "a remote call with another key still gets check 1");
  assert.ok(allowV.calls.some((c: any) => c.call.name === "browser_sign_in" && (c.admission ?? "local") === "local" && c.answer.code === -32602), "a local call with another key gets -32602");
  assert.ok(allowV.calls.some((c: any) => c.call.name === "browser_sign_in" && (c.admission ?? "local") === "local" && !Object.hasOwn(c.call.arguments, "name") && c.answer === "service"), "a local call with no name runs the act's method, and check 2 refuses it (review-112b)");
  // tools/list: the service's own tools for a local admission only.
  assert.deepEqual(allowV.toolsLists.map((t: any) => t.admission).sort(), ["local", "remote"]);
  for (const t of allowV.toolsLists) assert.deepEqual(t.names, toolsList(allowV.list, allowV.pinnedTools, t.admission), t.note);
  assert.ok(allowV.toolsLists.find((t: any) => t.admission === "remote").names.every((n: string) => !Object.hasOwn(SERVICE_TOOLS ?? {}, n)), "no service tool for a remote admission");
  assert.ok(allowV.calls.some((c: any) => c.call.name === UNSAFE && c.answer.code === -32601), "the unsafe tool is refused");
  assert.ok(allowV.calls.some((c: any) => c.realpath && Object.entries(c.realpath).some(([a, b]) => a.startsWith(allowV.folder) && !String(b).startsWith(allowV.folder)) && c.answer !== "pass"), "a link that leaves the folder");
  assert.ok(allowV.calls.some((c: any) => c.realpath && Object.values(c.realpath).some((b) => String(b).startsWith(allowV.folder.slice(0, -1)) && !String(b).startsWith(allowV.folder)) && c.answer !== "pass"), "a folder with the same start");
});

// ---- The stored sign-ins (board ab-v16.97.1; the stored sign-ins design, section 10) ----
// C12's part "The stored sign-ins" is the contract that stage 1e part 1 (board ab-v16.97.2) and agentwatch's client
// follow. The tests assert each sentence of the part exactly, and that the part holds no other text; they assert the
// changed sentences in the other parts; and the reference above (storeAnswer) checks the vectors against the part's rules.

// The text of a part with no Markdown markup: no list marker, no table rule, one space for each run of white space.
const clean = (text: string) => text.split("\n").filter((l) => !/^\|(?: --- \|)+$/.test(l.trim())).map((l) => l.trim().replace(/^(?:- |\d+\. )/, "")).join(" ").replace(/\s+/g, " ").trim();
const STORE_HEADING = "The stored sign-ins (from stage 1e part 1; board ab-v16.97.2).";
// Every sentence of the part, in order (a list item is one item). The part holds exactly these, and no other text.
const STORE_ITEMS: string[] = [
  "**The stored sign-ins (from stage 1e part 1; board ab-v16.97.2).** The design is `docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md` (board ab-v16.95), sections 5, 6 and 8, with the operator's answers of 2026-11-10 (board item ab-8w8: Q1 a, Q2 b, Q3 b, Q4 a). The service holds the open store key and no file of the store. The daemon holds the store's files and no open key, and no plain value reaches it. Nothing uses this part before stage 1e part 1, and no session uses a stored sign-in before stage 3.",
  "The feature. The service has the eight ops of the stored sign-ins (`sign_ins_setup`, `sign_ins_unlock`, `sign_ins_lock`, `sign_ins_rekey`, `sign_in_seal`, `sign_in_reseal`, `sign_in_start_again` and `sign_ins`), the events `sign_in` and `sign_ins`, and the key `sign_ins` of `status` only with the feature name `sign_ins` in its hello. A service whose hello does not have it answers the eight ops `unsupported`, sends neither event and gives no key `sign_ins`. The daemon sends the eight ops only to a service whose hello has it. From stage 1e part 1 the service's hello on Linux has the feature `sign_ins`, also the hello of `agent-browser service --hello`. On the Mac its hello has no `sign_ins` until stage 4 (C11, the sign-in act).",
  "Words. A credential is one stored sign-in. The store is the credentials of one OS user on one box: `key.json` and one record file for each credential in agentwatch's token store, `tokens/agent-browser/sign-ins/` (0600 files in a 0700 folder), which only the daemon writes. The store key is an X25519 key pair: its private half is on disk only wrapped, with a key that scrypt gives from the passphrase. The pane key is an X25519 key pair that the service makes at each start: its private half is only in the service's memory, and its public half is no secret.",
  "The state. `none`: the store is not open, and the last `sign_ins` has no key, or no `sign_ins` came since the service's start. `locked`: the last `sign_ins` has a key, and the service holds no open private half. `open`: the service holds the open private half in its memory. Only `sign_ins_setup` and `sign_ins_unlock` open the store. `sign_ins_lock`, a `sign_ins` whose `key` is `null` or whose `key.public` is not the open key's public half, and each stop of the service drop the open private half. A restart of the daemon, and a stop and a start of Chrome, do not drop it.",
  "The order at each connect: `config`, `set_sessions`, then `sign_ins`, before any other op of the stored sign-ins. The daemon sends `sign_ins` again at each change of the store's files.",
  "The pane's seal (`sealed`). The Browser pane, and the offer command on an agent's side, seal each plain value to the pane key's public half with agentwatch's Secret box seal (`screen-seal.js`, `sealPayload`) before the value leaves them. `text` is the seal's text (`sealed` in the answer of `sealPayload`: `aw1:` and base64url), `sender` its sender key (`senderPublicB64` in that answer: standard base64), `rid` a random request id of 22 to 64 base64url characters, and `at` the seal's time in UTC (ISO 8601). The seal's binding has the purpose `browser-sign-in` and the fields `op` (the request's op), `rid` and `at`, and for `sign_in_seal` also `name`, `origin`, `path` and `send_to` (from `record`) and `offer`, so a seal for a request with `\"offer\":true` never opens for a request with `\"offer\":false`, and the reverse. Each value of the binding is a string: `send_to` is its origins joined with one space, `offer` is `\"true\"` or `\"false\"`, and `at` is the seal's time in ISO 8601. The sealed object is `{\"passphrase\":\"<text>\"}` for `sign_ins_setup` and `sign_ins_unlock`, `{\"old\":\"<text>\",\"new\":\"<text>\"}` for `sign_ins_rekey`, and `{\"username\":\"<text>\",\"password\":\"<text>\"}` for `sign_in_seal`.",
  "The binding's bytes. The service builds them as `bindingInfo` of `screen-seal.js` does (agentwatch's `mail_crypto.Binding.info`): `agentwatch-browser-sign-in-v1`, one NUL byte, then the fields as JSON with sorted keys and no spaces. Each name and value is printable ASCII (the bytes 0x20 to 0x7E): the rules of `record` keep its fields to it. The service opens a seal as `mail_crypto.open_payload` does: HPKE (RFC 9180) base mode with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and ChaCha20-Poly1305, with the binding's bytes as the info and no additional data; then the sender tag, HMAC-SHA256 over the info and the JSON, with a key from HKDF-SHA256 of X25519 of the pane key and the `sender` key; then the JSON object. The service does not check the JSON's padding: `screen-seal.js` pads it with spaces to a multiple of 256 bytes, and `mail_crypto.seal_payload` does not pad.",
  "The service opens a pane's seal only with the binding that it builds from the request. A seal that does not open with that binding, a seal whose `at` is more than 120 s from the service's clock (before or after it), a seal whose `rid` the service keeps, a `rid` that is not 22 to 64 base64url characters, an `at` that is not a time in UTC of the form `2026-11-10T20:00:00Z` or `2026-11-10T20:00:00.000Z`, and an `at` of that form that is no real time (for example `2026-02-30T20:00:00Z`) get `the sealed value cannot be opened`, one text for each case. The service keeps the `rid` of each seal whose `rid` and `at` have their form and whose `at` is within 120 s of its clock, until that seal can no longer open: until its `at` is more than 120 s in the past and at least 120 s have passed since the service first saw the `rid`. A new start of the service makes a new pane key, so a seal to an older one does not open: the pane gets the new public half from `status` or from the `sign_ins` event, and seals again.",
  "The passphrase. `sign_ins_setup` and `sign_ins_rekey` refuse a new passphrase of fewer than 16 characters with `the passphrase has fewer than 16 characters`; `sign_ins_rekey` checks the new passphrase's length before the old passphrase. A passphrase that does not open the wrapped key gets `the passphrase does not open the store` 2 s after the op's turn began. The service runs one `sign_ins_setup`, `sign_ins_unlock` or `sign_ins_rekey` at a time, in the order that they came, and it begins the next one only after that answer, so an op that waits for its turn answers later.",
  "A lock during a derivation. A `sign_ins_lock` that comes while a `sign_ins_setup`, `sign_ins_unlock` or `sign_ins_rekey` derives its key wins (the design, section 5.2: the operator's \"Lock\" locks the store at once): the op opens nothing. After its derivation each of the three checks the lock and the last `sign_ins` again. `sign_ins_setup` answers `the store is set up already` and gives no key when the last `sign_ins` has a key by then; else it answers its `key` (the daemon writes it), and the store stays closed when a lock came. `sign_ins_unlock` whose passphrase opens the key answers `the store is not set up` when the last `sign_ins` has no key by then, and `the store is locked` when a lock came or the key's `public` is not the public half of the key that the passphrase opened. `sign_ins_rekey` answers `the store is not set up` or `the store is locked`, by the state, and gives no key, when the store is no longer open with the key that it checked.",
  "The protections. The service opens the store only in a process where both protections of the design's section 5.5 hold: the process is not dumpable (`prctl(PR_SET_DUMPABLE, 0)` at its start), and the protection of board ab-v16.96 holds (hold SIGUSR1 at start; disable the inspector signal). When one does not hold, `sign_ins_setup` and `sign_ins_unlock` get `the service's memory is not protected (<reason>)`, with the reason `dumpable` (the call failed) or `signal` (the protection of board ab-v16.96 does not hold); `dumpable` comes first when both fail. `status` gives the same reason (the status, below).",
  "`key` is the content of `key.json`: `{\"v\":1,\"public\":\"<base64url>\",\"kdf\":{\"name\":\"scrypt\",\"n\":<N>,\"r\":8,\"p\":1,\"salt\":\"<base64url>\"},\"wrapped\":{\"iv\":\"<base64url>\",\"ct\":\"<base64url>\",\"tag\":\"<base64url>\"}}`. `sign_ins_setup` makes it with N = 131072 (2^17) and a new salt of 16 bytes, and wraps the private half with AES-256-GCM under the scrypt key (`maxmem` 257 MiB: scrypt needs 128 times r times (N + 2) bytes and more, so N = 2^18 does not derive under 256 MiB). The service takes the KDF values of a `key` only within these bounds: `name` `scrypt`, N a power of two from 32768 (2^15) to 262144 (2^18), r 8, p 1, and a salt of 16 bytes. Outside them, `sign_ins_unlock` and `sign_ins_rekey` get `the store's key file is not valid`, and no derivation runs. A `key` whose `v` is not 1, with no string `public`, or with no object `wrapped` of the strings `iv`, `ct` and `tag`, gets the same text. Such a `key` still counts as a key: the state is `locked`, and `sign_ins_setup` gets `the store is set up already`.",
  "The record. A record file is `{\"v\":1,\"id\",\"gen\",\"name\",\"origin\",\"path\",\"send_to\",\"repos\",\"by\",\"approved\",\"state\",\"added\",\"changed\",\"sealed\"}`. The seal binds its plain fields `v`, `id`, `gen`, `name`, `origin`, `path`, `send_to`, `repos`, `by` and `approved` as its additional data. With the answer Q2 b, `repos` is `null` in the file, not absent as the design's section 5.3 says: so each field of the additional data is in the file, and the service reads the additional data from the file alone. `state`, `added` and `changed` are the daemon's, for the Browser pane: they are outside the seal, and no decision of the service reads them. `sealed` is `{\"epk\",\"iv\",\"ct\",\"tag\"}` in base64url: an ephemeral X25519 key; HKDF-SHA256 to a 32-byte key from two shared secrets, the ephemeral key's with the store's public half and the store's private half's with the store's public half (as HPKE's auth mode does, with the store key as the sender and the recipient), so only the open store key makes a seal that opens, not a program that reads the `public` of `key.json`; and AES-256-GCM over `{\"username\":<text>,\"password\":<text>,\"totp\":null}`.",
  "The rules of `record`. A `record` that breaks one gets `the stored sign-in is not valid (field <field>)`, which names the field, never a value. `id` is `c-` and 8 lowercase hex digits; the daemon makes it. `name` matches C11's scope pattern. `origin` is a URL origin as the WHATWG URL parser gives it: `https:`, or `http:` with a loopback host (`localhost`, a host that ends in `.localhost`, or `127.0.0.1`), for tests. `path` starts with `/`, holds no `?` and no `#`, and holds printable ASCII only (the bytes 0x20 to 0x7E), as the binding needs. `send_to` holds `origin`, and only origins by the rule of `origin`, each once.",
  "Names and ids. A name is unique in the store among the approved records (`approved` `true`): an offer can have the name of a credential, and the operator gives it another name at the approval (the design, section 6.3). `sign_in_seal` with `kind: operator` and `sign_in_reseal` get `another stored sign-in has this name` when another `id` of the last `sign_ins` has that `name` and `approved` `true`. Two approved records of one name in a snapshot each break, so the sign-in act's check 2 finds neither (C11). An offer gets its own new id, and an offer never changes or replaces a credential (the design, section 6.3): an offer with an `id` that the last `sign_ins` holds, or that has a highest `gen` in the service (from a `sign_ins`, or from its own seal also since the last `sign_ins`), gets `an offer needs a new id`.",
  "The order of the checks. After the kind, the service checks a request of the stored sign-ins in this order: the rules of `record`; the snapshot; the state; the protections (`sign_ins_setup` and `sign_ins_unlock`); the pane's seal; then the op's own checks. The first check that fails gives its error. The op's own checks come in this order: for `sign_ins_setup` the new passphrase's length; for `sign_ins_unlock` the `key` (its form and its KDF bounds), then the passphrase; for `sign_ins_rekey` the new passphrase's length, the `key`, then the old passphrase; for `sign_in_seal` a removed id, an offer's id, then the name; for `sign_in_reseal` the id, the origin, whether the record opens, then the name.",
  "The snapshot and the state. Before the first `sign_ins` since the service's start, `sign_ins_setup`, `sign_ins_unlock`, `sign_ins_rekey`, `sign_in_seal`, `sign_in_reseal` and `sign_in_start_again` get `the stored sign-ins have no snapshot yet`. `sign_ins_setup` while the last `sign_ins` has a key, or while the store is open, gets `the store is set up already`. `sign_ins_unlock` while the store is open answers `{}` and changes nothing; while the last `sign_ins` has no key it gets `the store is not set up`. `sign_ins_rekey`, `sign_in_seal` and `sign_in_reseal` get `the store is not set up` in the state `none` and `the store is locked` in the state `locked`. `sign_ins_rekey` gets `the store is not set up` also while the last `sign_ins` has no key. `sign_ins_lock` answers `{}` in each state, and `sign_in_start_again` needs no state.",
  "The fields that the service seals. The service seals each record with `v` 1, `repos` `null` (the operator's answer Q2 b: a credential names no repos), and a `gen` one higher than the highest `gen` that it saw for that `id` (in a `sign_ins` or in its own seal), or 1 for an `id` that it never saw. `sign_in_seal` with `kind: operator` seals `by` `\"operator\"` and `approved` `true`. An agent's offer (`sign_in_seal` with `\"offer\":true`; the operator's answer Q3 b: an agent that holds a credential may offer it once, for the operator's approval) seals `by` `\"offer\"`, `approved` `false` and `send_to` `[<origin>]`, whatever the request holds. `sign_in_reseal` seals the values of the open record again with the fields of `record`, the record's own `by`, and `approved` `true`: a change, or the operator's approval of an offer. So only the operator's approval, in the seal, makes an offer usable (C11, the sign-in act, check 5). The answer's `record` holds the ten plain fields as the service sealed them, so the daemon writes a record that opens.",
  "The service seals only while the store is open, with the public half that it derives from its open private half, never with the `public` of a `key`. It keeps no copy of a value that it opens or seals.",
  "The op's own checks. `sign_in_seal` with the `id` of a removed credential gets `the stored sign-in was removed`. `sign_in_reseal` with an `id` that the last `sign_ins` does not hold gets `there is no stored sign-in with this id`; with another `origin` than the record's, `a change of the origin needs a new seal of the password`; and with a record that does not open (its tag, its shape, a `gen` lower than the highest that the service saw, or a removed id), `the stored sign-in cannot be opened`.",
  "Start again. `sign_in_start_again` is the operator's \"Start again\" in the Browser pane (C11, the sign-in act's lockout guard). It clears the stop of the credential `credential` and its count of failed results in a row; the times of its acts in the last hour stay. It answers `{}`, also for a credential that is not stopped. A `credential` that the last `sign_ins` does not hold gets `there is no stored sign-in with this id`. A removed id is no credential: `stopped` in `status` never names it, and `sign_in_start_again` with it gets `there is no stored sign-in with this id`, also when a later `sign_ins` holds its file again. When an id becomes a removed id, the service drops its stop, its count and the times of its acts from its file.",
  "The snapshot. `sign_ins` replaces the service's last snapshot of the store: its key and its records. A record that breaks the record's shape, or that does not open at its use, breaks only itself. Each `id` of the last snapshot that a new `sign_ins` does not hold is a removed id from then on. A record that breaks its shape still holds its `id` (a string) for this rule, so a file that is bad for a short time removes nothing for good. The answer's `records` is the number of records in the request.",
  "The service's own file. In the folder of `--state-folder`, `sign-ins-state.json` keeps the highest `gen` of each `id`, the removed ids, and for each credential the count of its failed results in a row, its stop and the times of its acts in the last hour (C11, the sign-in act). It holds ids and numbers only, no secret. A file that the service cannot read at its start (for example a damaged one) counts as no file, as on a new box (the design, section 5.6), and the service logs the error's kind. When a write fails, the service keeps its state in memory and logs the error's kind.",
  "The lines that hold a seal. Only the request lines of `sign_ins_setup`, `sign_ins_unlock`, `sign_ins_rekey` and `sign_in_seal` hold a pane's seal. Only the request line of `sign_ins` and the answers of `sign_in_seal` and `sign_in_reseal` hold a sealed record. Only the request line of `sign_ins` and the answers of `sign_ins_setup` and `sign_ins_rekey` hold a wrapped key. No line holds a plain passphrase, username or password.",
  "The events. `sign_ins` comes at each change of the state, with the state and the pane key's public half. `sign_in` comes from the sign-in act's method, `AgentBrowser.signIn` (C11), for each request. `act` is an id of 16 lowercase hex digits that the service makes at random for the request. An act sends a `start` (`phase` `start`) and an `end` (`phase` `end`) with its `act`. A request that a check before the act refuses (C11, checks 1 to 7) is no act: it sends one `end` with its own `act` and no `start`. `scope` is the caller's scope, `repo` its session's `repo` in the last `set_sessions` (or `null`), `id`, `name` and `origin` are the credential's (`null` for a refusal by check 1 or 2, which names no credential), and `at` is the time in UTC (ISO 8601). An `end` also has `result` (C11's result), `ms` (the time in milliseconds), `blocked` and `guarded` (the number of requests that the act's block and its guard stopped), and `stopped_now` (`true` when the act's result stopped the credential: C11's lockout guard).",
  "No host of a blocked request. No event, prompt or log line names the host of a request that the act's block or its guard stopped, because a host that the page chooses can carry the password. A block of the list rules (C4, C5) in an act tab or its popups makes no blocked-site prompt, no `prompt` event and no blocked report that names its host: the service counts it in the act's `blocked`.",
  "What the daemon does with them. The live view sends no frame and plays no input from a `start` to the `end` with the same `act`, or for 60 s after a `start` with no such `end`. An `end` whose `act` had no `start` ends no blank. An `end` with the result `locked` gives the operator one Web Push, at most one in an hour. An `end` with `stopped_now` `true` shows the credential as stopped in the Browser pane. The daemon keeps the last 200 `sign_in` events in its own state, and the Browser pane shows the last 20 of each credential.",
  "The status. `sign_ins` in `status` is `{\"state\",\"records\",\"acts\",\"pane_key\",\"stopped\",\"unprotected\"}`: the state, the number of records of the last `sign_ins`, the number of acts that started since the service's start (a refusal by a check before the act is no act), the pane key's public half (standard base64), the ids of the stopped credentials (a list, empty when none), and the reason of a protection that does not hold (`dumpable` or `signal`: the protections, above), or `null` while both hold. It names no name and no origin of a credential.",
  "The daemon's part. The daemon applies an operator act of the stored sign-ins only with the gateway's field (provenance, above), and it logs each one with its user, the op, and the credential's id and name. It takes an offer's source from its walk of the offer command's peer pid (`SO_PEERCRED`) to its session, never from a field of the request, and it sends the offer with `kind: token`. It checks the service before its hello (who connects, above), so only the real service gets a seal.",
  "The session's repo. The sign-in act takes the caller's scope from the walk, and the scope's list from its session's `repo` in the last `set_sessions`. With the answer Q2 b it needs no other field of `set_sessions`, and no `repo_key` (the token design, section 11).",
  "The log. No log line of either side holds a username, a password, a passphrase, a wrapped key (the `wrapped` part of `key.json`), a sealed record, a pane's seal, a form value, a page's text, a URL path or a query. The service logs each op of the stored sign-ins with its provenance and the credential's id and name, and one line for each request of the sign-in act's method (C11).",
];

test("C12's part on the stored sign-ins holds exactly its sentences, after the part of stage 1c and before the event stream", () => {
  const p = part(C12, STORE_HEADING);
  for (const s of STORE_ITEMS) assert.ok(says(p, s), `C12 says: ${s}`);
  assert.equal(clean(p), STORE_ITEMS.join(" "), "the part holds no other text");
  const at = C12.indexOf(`**${STORE_HEADING}`);
  assert.ok(C12.indexOf("**The lists, the scopes, the prompts and the sign-ins (stage 1c).**") < at && at < C12.indexOf("**The event stream (service to daemon; the daemon lead's C8).**"), "the part's place");
  // Each error of the store is in the part, once, as a code span; and each code span holds no line break (C12 names its texts whole).
  for (const e of [...STORE_ERRORS, RECORD_ERROR, UNPROTECTED_ERROR]) assert.ok(p.includes("`" + e + "`"), `the part names ${e} whole, as a code span`);
  assert.ok(p.split("\n").every((l) => (l.match(/`/g) ?? []).length % 2 === 0), "no code span over a line break");
  assert.ok(!/\/home\//.test(p), "no box path");
});

test("C12 states the stored sign-ins in its other parts: the field rules, the events' rows, the status key, the fake's rules and the vectors", () => {
  sayAll(C12, [
    "| `sign_in` | `phase` (`start` or `end`), `act`, `scope`, `repo`, `id`, `name`, `origin`, `at`; for `end` also `result`, `ms`, `blocked`, `guarded` and `stopped_now`; never a username, a password, a form value, a URL path or the host of a blocked request |",
    "| `sign_ins` | `state` (`none`, `locked` or `open`), `pane_key` (the pane key's public half) |",
  ]);
  sayAll(part(C12, "The fake service (`--fake`; the daemon lead's C10)."), [
    "Its stored sign-ins (the feature `sign_ins`; the vectors' `state.sign_ins`). The fake opens no seal, makes no key and seals nothing, so it checks no binding and no seal's time on its own clock.",
    "It follows the rules of the state, of the errors, of the names and ids and of the fields that the service seals (the stored sign-ins, above), and the rules of the form of `rid` and `at`, of an `at` that is no real time and of a `rid` that it keeps (until the seal's `at` is more than 120 s in the past by the fake's clock and at least 120 s have passed since it first saw the `rid`).",
    "`sign_ins_setup` answers the vectors' `key`, and `sign_ins_rekey` their `rekeyed`. `sign_ins_unlock` opens the store, except with a seal whose `text` is the vectors' `wrong_passphrase`, which gets `the passphrase does not open the store` at once.",
    "A seal whose `text` is the vectors' `short_passphrase` or `short_rekey` stands for a new passphrase of fewer than 16 characters (`short_rekey` in `sign_ins_rekey`, with an old passphrase that does not open the store), and a seal whose `text` is the vectors' `stale_seal` stands for a seal more than 120 s from the service's clock.",
    "`sign_in_seal` and `sign_in_reseal` answer the fields that the service seals and the vectors' `sealed`. A record of a `sign_ins` does not open in the fake only for its `gen` (lower than the highest, or not a whole number of 1 or more) or its removed `id`.",
    "The fake runs no act, so its `status` gives `acts` 0 and `stopped` `[]`. With `--unprotected dumpable` or `--unprotected signal`, it answers as a process where that protection does not hold (the vectors' `unprotected`).",
    "Each change of the state sends a `sign_ins` event with the vectors' `pane_key`.",
  ]);
  assert.ok(!says(C12, "so it checks no passphrase's length, no seal's time and no binding"), "the fake's vectors show the passphrase's length and a seal's time (review-112)");
  // Board ab-v16.97.2: the old sentences are gone.
  assert.ok(!says(C12, "and the rules of the form of `rid` and `at` and of a `rid` that it saw.") && !says(C12, "(each on a new fake with `--unprotected`), and its") && !says(C12, "(`maxmem` 256 MiB)") && !says(C12, "an offer with an `id` that the last `sign_ins` holds gets"), "the old sentences of board ab-v16.97.2's changes");
  // review-118: the old sentences of the fix round are gone.
  assert.ok(!says(C12, "a seal whose `rid` the service saw in the last 120 s") && !says(C12, "2 s after the request.") && !says(C12, "an ephemeral X25519 key, the shared secret with the store's public half, HKDF-SHA256 to a 32-byte key,") && !says(C12, "which ends in spaces up to a multiple of 256 bytes") && !says(C12, "of a `rid` that it saw."), "the old sentences of review-118's fix round");
  sayAll(part(C12, "The vectors."), [
    "Its `state.sign_ins` holds the fake values of the stored sign-ins, its `unprotected` the cases of a protection that does not hold (each on a new fake with `--unprotected` and the case's `reason`; in the case where both protections fail the `reason` is `dumpable`, which comes first), with seals that the service refuses for their form, so the protections come before the pane's seal, and its `signInScan` the canaries of the scan: no line of the vectors holds a canary in one of the five forms of the sign-in act's guard (C11), and only the lines that the stored sign-ins name hold a seal.",
    "Each pane's seal of its lines is a seal that agentwatch's `screen-seal.js` (`sealPayload`) made with fixed test keys, to the test pane key of `paneSeal`, whose private half is a test value; `paneSeal` also holds one seal with its binding, the binding's bytes, its test keys and its payload, for the tests of both sides.",
    "The real service gives each line of the stored sign-ins its answer too, except the values that it makes from new random bytes (the `key` of `sign_ins_setup` and `sign_ins_rekey`, and the `sealed` of `sign_in_seal` and `sign_in_reseal`): the daemon writes the service's own answers, so a test sends them in the later `sign_ins` in place of the vectors' `key`, `rekeyed` and `sealed`.",
  ]);
  // The fake's hello has the feature (the vectors' hello of --fake).
  assert.ok(control.hellos.some((h: any) => h.line.commit === null && h.line.features.join() === "fake,mcp_token,sign_ins"), "the fake's hello has fake, mcp_token and sign_ins");
  assert.ok(control.hellos.some((h: any) => h.line.side === "service" && !h.line.features.includes("sign_ins")), "a service hello with no sign_ins");
});

const has1 = (f: (v: any) => boolean) => [...control.requests, ...control.badRequests].some(f);
test("each op of the stored sign-ins has a vector with fake values and its answer, a vector of a refused kind, and each error of the store a vector", () => {
  for (const op of SIGN_IN_OPS) {
    assert.ok(has1((v) => v.req.op === op && v.res.ok), `${op}: a good request`);
    assert.ok(has1((v) => v.req.op === op && ["not the operator", "bad request"].includes(v.res.error) && v.req.by && !(op === "sign_in_seal" && v.req.offer === true ? OFFER : OPS[op].kinds!).includes(v.req.by.kind)), `${op}: a refused kind`);
  }
  for (const e of STORE_ERRORS) assert.ok(has1((v) => v.res.error === e), `a vector of ${e}`);
  // review-112: the passphrase's 16 characters (also before the old passphrase of a rekey), a seal more than 120 s old,
  // a rid and an at of the wrong form, a key with no public or no wrapped, the names and ids, and Start again.
  const S = control.state.sign_ins;
  for (const [op, text] of [["sign_ins_setup", S.short_passphrase], ["sign_ins_rekey", S.short_rekey]]) assert.ok(has1((v) => v.req.op === op && v.req.sealed?.text === text && v.res.error === "the passphrase has fewer than 16 characters"), `${op}: fewer than 16 characters`);
  const stale = control.requests.find((v: any) => v.req.sealed?.text === S.stale_seal);
  assert.ok(stale && stale.res.error === "the sealed value cannot be opened", "a seal more than 120 s old");
  assert.ok(control.requests.filter((v: any) => isObj(v.req.sealed) && AT.test(v.req.sealed.at) && realTime(v.req.sealed.at) && v !== stale).every((v: any) => Date.parse(v.req.sealed.at) - Date.parse(stale.req.sealed.at) > 120_000), "the stale seal's at is more than 120 s before the others");
  assert.ok(has1((v) => isObj(v.req.sealed) && !RID.test(v.req.sealed.rid) && v.res.error === "the sealed value cannot be opened"), "a rid of the wrong form");
  assert.ok(has1((v) => isObj(v.req.sealed) && RID.test(v.req.sealed.rid) && !AT.test(v.req.sealed.at) && v.res.error === "the sealed value cannot be opened"), "an at of the wrong form");
  assert.ok(has1((v) => v.req.op === "sign_ins" && isObj(v.req.key) && !Object.hasOwn(v.req.key, "public")), "a key with no public");
  assert.ok(has1((v) => v.req.op === "sign_ins" && isObj(v.req.key) && !Object.hasOwn(v.req.key, "wrapped")), "a key with no wrapped");
  assert.ok(has1((v) => v.req.op === "sign_in_seal" && v.req.offer === false && v.res.error === "another stored sign-in has this name") && has1((v) => v.req.op === "sign_in_reseal" && v.res.error === "another stored sign-in has this name"), "a name in use: a seal and a reseal");
  assert.ok(has1((v) => v.req.op === "sign_in_seal" && v.req.offer === true && v.res.error === "an offer needs a new id"), "an offer with the id of a credential");
  assert.ok(has1((v) => v.req.op === "sign_in_start_again" && v.res.ok) && has1((v) => v.req.op === "sign_in_start_again" && v.res.error === "there is no stored sign-in with this id") && has1((v) => v.req.op === "sign_in_start_again" && v.res.error === "the stored sign-ins have no snapshot yet"), "Start again: a credential, no such id, no snapshot");
  assert.ok(has1((v) => v.req.op === "sign_in_start_again" && typeof v.req.credential === "string" && v.res.error === "bad request"), "Start again: a credential of the wrong form");
  assert.ok(has1((v) => v.req.op === "sign_in_start_again" && !Object.hasOwn(v.req, "credential") && v.res.error === "bad request"), "Start again: no credential field (review-112b)");
  for (const f of ["id", "name", "origin", "path", "send_to"]) assert.ok(has1((v) => v.res.error === recordError(f)), `a vector of the rule of ${f}`);
  assert.ok(has1((v) => v.req.op === "sign_in_reseal" && /[^\x20-\x7e]/.test(v.req.record?.path ?? "") && v.res.error === recordError("path")), "a reseal's path outside printable ASCII (review-118 note 8)");
  // The offer (Q3 b): sealed by "offer", approved false and send_to [origin], whatever the request holds.
  const offer = control.requests.find((v: any) => v.req.op === "sign_in_seal" && v.req.offer === true && v.res.ok);
  assert.ok(offer, "a good offer");
  assert.ok(offer.req.by.kind === "token" && offer.req.record.send_to.length > 1 && offer.req.record.approved === true && offer.req.record.by === "operator" && Array.isArray(offer.req.record.repos), "the offer's request holds other values");
  assert.deepEqual([offer.res.data.record.by, offer.res.data.record.approved, offer.res.data.record.send_to, offer.res.data.record.repos], ["offer", false, [offer.req.record.origin], null], "the offer's seal");
  // The approval of the offer: sign_in_reseal keeps its by, seals approved true and gen + 1.
  const approval = control.requests.find((v: any) => v.req.op === "sign_in_reseal" && v.res.ok && v.req.record.id === offer.req.record.id);
  assert.ok(approval && approval.res.data.record.by === "offer" && approval.res.data.record.approved === true && approval.res.data.record.gen === offer.res.data.record.gen + 1, "the approval is in the seal");
  // Q2 b: every record that the service seals has repos null, and so does each record file of a snapshot (R3).
  for (const v of control.requests.filter((x: any) => x.req.op === "sign_ins")) for (const r of v.req.records) assert.equal(r.repos, null, `${v.req.id}: a record file with repos null`);
  for (const v of control.requests.filter((x: any) => x.res.ok && x.res.data?.record)) assert.equal(v.res.data.record.repos, null, `${v.req.id}: repos null`);
  // The order of the checks: the snapshot before the state, and the rules of record before the snapshot.
  const first = control.requests.findIndex((v: any) => v.req.op === "sign_ins");
  assert.ok(control.requests.slice(0, first).some((v: any) => SIGN_IN_OPS.includes(v.req.op) && v.res.error === "the stored sign-ins have no snapshot yet"), "an op before the first snapshot");
  // The generation, the removed id, the KDF bounds and the replay each have their case.
  assert.ok(control.requests.some((v: any) => v.req.op === "sign_ins" && v.req.key !== null && !kdfFits(v.req.key)), "a key outside the KDF bounds");
  assert.ok(control.requests.some((v: any) => v.req.op === "sign_ins" && v.req.records.some((r: any) => control.requests.some((w: any) => w.req.op === "sign_ins" && w.req.records.some((q: any) => q.id === r.id && q.gen > r.gen)))), "an old copy of a record");
  const rids = control.requests.filter((v: any) => v.req.sealed).map((v: any) => v.req.sealed.rid);
  assert.ok(rids.some((r: string, i: number) => rids.indexOf(r) !== i), "a replayed rid");
  // Each pane's seal of the vectors has the form of C12: aw1: text, a sender key, a rid and a time (except the seals of
  // the wrong form, which the service cannot open).
  for (const v of [...control.requests, ...control.badRequests].filter((x: any) => isObj(x.req.sealed) && typeof x.req.sealed.rid === "string" && RID.test(x.req.sealed.rid) && AT.test(x.req.sealed.at))) {
    assert.match(v.req.sealed.text, /^aw1:[A-Za-z0-9_-]+$/, v.req.id);
    assert.match(v.req.sealed.rid, /^[A-Za-z0-9_-]{22,64}$/, v.req.id);
    assert.match(v.req.sealed.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, v.req.id);
    assert.equal(Buffer.from(v.req.sealed.sender, "base64").length, 32, v.req.id);
  }
});

// The scans of the stored sign-ins: the canaries in the five forms of the guard (C11), and the places of the seals (C12).
const FORMS = (s: string) => [s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1), Buffer.from(s).toString("base64"), Buffer.from(s).toString("base64url")];
const holdsCanary = (text: string, canaries: string[]) => canaries.some((c) => FORMS(c).some((f) => text.includes(f)));
const isPaneSeal = (o: unknown) => isObj(o) && keysOf(o).join() === "at,rid,sender,text";
const isSealedRecord = (o: unknown) => isObj(o) && keysOf(o).join() === "ct,epk,iv,tag";
const isWrapped = (o: unknown) => isObj(o) && keysOf(o).join() === "ct,iv,tag";
/** The paths of each object in x that matches. */
function places(x: unknown, match: (o: unknown) => boolean, at = ""): string[] {
  if (Array.isArray(x)) return x.flatMap((y, i) => places(y, match, `${at}[]`));
  if (!isObj(x)) return [];
  return [...(match(x) ? [at] : []), ...Object.entries(x).flatMap(([k, y]) => places(y, match, `${at}.${k}`))];
}
const FOUR = ["sign_ins_setup", "sign_ins_unlock", "sign_ins_rekey", "sign_in_seal"];
/** Each seal in a line that C12 does not name for it (C12, the lines that hold a seal). */
function sealBreaks(v: { req: any; res: any }): string[] {
  const out: string[] = [];
  const want = (got: string[], ok: string[], what: string) => { for (const g of got) if (!ok.includes(g)) out.push(`${v.req.id}: ${what} at ${g}`); };
  want(places(v.req, isPaneSeal), FOUR.includes(v.req.op) ? [".sealed"] : [], "a pane's seal in the request");
  want(places(v.req, isSealedRecord), v.req.op === "sign_ins" ? [".records[].sealed"] : [], "a sealed record in the request");
  want(places(v.req, isWrapped), v.req.op === "sign_ins" ? [".key.wrapped"] : [], "a wrapped key in the request");
  want(places(v.res, isPaneSeal), [], "a pane's seal in the answer");
  want(places(v.res, isSealedRecord), ["sign_in_seal", "sign_in_reseal"].includes(v.req.op) ? [".data.sealed"] : [], "a sealed record in the answer");
  want(places(v.res, isWrapped), ["sign_ins_setup", "sign_ins_rekey"].includes(v.req.op) ? [".data.key.wrapped"] : [], "a wrapped key in the answer");
  return out;
}

test("the stored sign-ins' scan: no line of the vectors holds a canary in one of its five forms, and only the lines that C12 names hold a seal; each scan finds its planted twin", () => {
  const scan = control.signInScan;
  assert.ok(isObj(scan) && strings(scan.canaries) && scan.canaries.length >= 3, "the canaries: a username, a password and a passphrase");
  const { signInScan, ...lines } = control;
  assert.equal(holdsCanary(JSON.stringify(lines), scan.canaries), false, "no line holds a canary");
  // The twin: a canary planted in an answer, in each of the five forms, is found.
  for (const c of scan.canaries) for (const f of FORMS(c)) assert.equal(holdsCanary(JSON.stringify({ ...lines, planted: { res: { data: { text: `x${f}x` } } } }), [c]), true, `the scan finds ${JSON.stringify(f)}`);
  // Open point 7 of PR #112: the unprotected cases' lines too.
  const all = [...control.requests, ...control.badRequests, ...control.unprotected.cases.flatMap((c: any) => c.requests)];
  assert.ok(all.some((v) => /^u-/.test(v.req.id) && places(v.req, isPaneSeal).length > 0), "the scan reads the unprotected lines");
  for (const v of all) assert.deepEqual(sealBreaks(v), [], v.note);
  for (const { note, ev } of control.events) assert.deepEqual([...places(ev, isPaneSeal), ...places(ev, isSealedRecord), ...places(ev, isWrapped)], [], `${note}: no seal in an event`);
  // Each kind of seal is in the vectors where C12 names it, so the scan reads real lines.
  assert.ok(all.some((v) => places(v.req, isPaneSeal).length > 0) && all.some((v) => places(v.req, isSealedRecord).length > 0) && all.some((v) => places(v.res, isSealedRecord).length > 0) && all.some((v) => places(v.res, isWrapped).length > 0), "the vectors hold each kind of seal");
  // The twin: a pane's seal in a lock, a sealed record in a status answer and a wrapped key in a seal's answer are found.
  const seal = all.find((v) => v.req.op === "sign_ins_unlock" && isPaneSeal(v.req.sealed))!.req.sealed;
  assert.notDeepEqual(sealBreaks({ req: { id: "t1", op: "sign_ins_lock", by: {}, sealed: seal }, res: { data: {} } }), [], "a pane's seal in a lock");
  assert.notDeepEqual(sealBreaks({ req: { id: "t2", op: "status", by: {} }, res: { data: { x: control.state.sign_ins.sealed } } }), [], "a sealed record in a status");
  assert.notDeepEqual(sealBreaks({ req: { id: "t3", op: "sign_in_seal", by: {}, sealed: seal }, res: { data: { key: control.state.sign_ins.key } } }), [], "a wrapped key in a seal's answer");
});

// Board ab-v16.97.2 (open point 1 of PR #112): the shared vector of a real seal of agentwatch's screen-seal.js.
test("the vectors' paneSeal: the test pane key (its private half a test value, its public half the vectors' pane_key) and one seal of screen-seal.js with its binding, the binding's bytes of C12, its test keys and its payload", () => {
  const P = control.paneSeal;
  assert.ok(isObj(P) && P.note.startsWith("TEST keys and values only, never a real key or secret."), "named a test value");
  const label = (l: string) => createHash("sha256").update(`test, not a key: ${l}`).digest("hex");
  assert.equal(P.pane_secret_hex, label("the pane key of the stored sign-ins' vectors"), "the test pane key comes from its label");
  assert.equal(P.pane_key, control.state.sign_ins.pane_key);
  const v = P.vector;
  assert.deepEqual(keysOf(v), ["ephemeral_secret_hex", "fields", "info_hex", "payload", "purpose", "sealed", "sender_public_b64", "sender_secret_hex"]);
  assert.deepEqual([v.ephemeral_secret_hex, v.sender_secret_hex], [label("ephemeral paneSeal"), label("sender paneSeal")], "test keys from their labels");
  assert.equal(v.purpose, "browser-sign-in");
  assert.deepEqual(keysOf(v.fields), ["at", "name", "offer", "op", "origin", "path", "rid", "send_to"], "the binding of sign_in_seal (C12)");
  assert.ok(Object.values(v.fields).every((x) => typeof x === "string" && /^[\x20-\x7e]*$/.test(x as string)), "printable ASCII text");
  assert.equal(v.fields.send_to.split(" ").length, 2, "send_to: its origins joined with one space");
  // C12's bytes: agentwatch-browser-sign-in-v1, one NUL byte, the fields as JSON with sorted keys and no spaces.
  assert.equal(Buffer.from(v.info_hex, "hex").toString("latin1"), `agentwatch-browser-sign-in-v1\u0000{${keysOf(v.fields).map((n) => `${JSON.stringify(n)}:${JSON.stringify(v.fields[n])}`).join(",")}}`);
  assert.match(v.sealed, /^aw1:[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(v.sealed.slice(4), "base64url").length, 32 + 32 + 256 + 16, "enc, the sender tag, the JSON padded to 256 bytes, the AEAD tag");
  assert.equal(Buffer.from(v.sender_public_b64, "base64").length, 32);
  assert.ok(/not-a-secret/.test(v.payload.password) && /[^\x00-\x7f]/.test(v.payload.password) && !holdsCanary(JSON.stringify(v), control.signInScan.canaries), "a test payload with UTF-8, and no canary");
});

// The results of the sign-in act: the codes of C11's table of what the agent sees.
function actResults(): string[] {
  const lines = C11.split("\n");
  const at = lines.indexOf("| The cause | The result | The text |");
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 2)) { if (!l.startsWith("| ")) break; out.push(spans(l.slice(2, -2).split(" | ")[1])[0]); }
  return out;
}

// The results of C11's checks before the act (the rows of its table whose cause names a check): a refusal, no act.
function checkResults(): string[] {
  const lines = C11.split("\n");
  const at = lines.indexOf("| The cause | The result | The text |");
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 2)) { if (!l.startsWith("| ")) break; const [cause, result] = l.slice(2, -2).split(" | "); if (/\(check \d\)/.test(cause)) out.push(spans(result)[0]); }
  return out;
}

test("the stored sign-ins' events: sign_in with its act id and phase, C11's result at its end (also an end with no start), counts and no host, and sign_ins with the state and the pane key; no event holds a value", () => {
  const results = actResults();
  const refusals = checkResults();
  assert.ok(results.includes("signed_in") && results.includes("locked"), "C11's results");
  assert.deepEqual(refusals, ["remote", "not_ready", "no_such_name", "not_allowed", "locked", "cannot_open", "stopped", "hour_limit", "busy"], "the results of checks 1 to 7");
  const signIns = control.events.filter((v: any) => v.ev.ev === "sign_in").map((v: any) => v.ev);
  const starts = new Map(signIns.filter((e: any) => e.phase === "start").map((e: any) => [e.act, e]));
  for (const ev of signIns) {
    assert.ok(["start", "end"].includes(ev.phase), ev.phase);
    // review-112 B3: an act id of 16 lowercase hex digits in each phase.
    assert.match(ev.act, /^[0-9a-f]{16}$/, "the act id");
    const named = ev.id !== null;
    assert.ok(scope(ev.scope) && (ev.repo === null || typeof ev.repo === "string"), JSON.stringify(ev));
    assert.ok(named ? /^c-[0-9a-f]{8}$/.test(ev.id) && scope(ev.name) && originFits(ev.origin) : ev.name === null && ev.origin === null, `the credential, or null for each of its fields: ${JSON.stringify(ev)}`);
    assert.match(ev.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    if (ev.phase === "end") {
      assert.ok(results.includes(ev.result), `a result of C11: ${ev.result}`);
      // review-112 B1: counts, never a host.
      assert.ok(Number.isSafeInteger(ev.ms) && ev.ms >= 0 && Number.isSafeInteger(ev.blocked) && ev.blocked >= 0 && Number.isSafeInteger(ev.guarded) && ev.guarded >= 0, "the time and two counts");
      assert.equal(typeof ev.stopped_now, "boolean", "stopped_now");
      if (ev.stopped_now) assert.ok(["not_accepted", "timeout", "second_factor"].includes(ev.result), "only a result of the lockout guard stops a credential");
      const start = starts.get(ev.act);
      if (refusals.includes(ev.result)) assert.ok(!start, `${ev.result}: a refusal by a check is no act, so its act id has no start`);
      else assert.ok(start && start.id === ev.id && start.scope === ev.scope, `${ev.result}: the end of the start with its act id`);
      if (!named) assert.ok(["remote", "not_ready", "no_such_name"].includes(ev.result), `${ev.result}: only checks 1 and 2 name no credential`);
      // Open point 6 of PR #112: and an end of check 1 or 2 names none (R22 in both directions).
      if (["remote", "not_ready", "no_such_name"].includes(ev.result)) assert.ok(!named, `${ev.result}: a refusal by check 1 or 2 names no credential`);
      // review-112b: check 7 refuses only after its wait of at most 60 s for the act before it.
      if (ev.result === "busy") assert.ok(ev.ms >= 60_000, "busy: the end comes after the wait of 60 s");
    }
  }
  const ends = signIns.filter((e: any) => e.phase === "end");
  for (const s of starts.values()) assert.ok(ends.some((e: any) => e.act === (s as any).act), "each start has its end");
  assert.ok(ends.some((e: any) => e.result === "signed_in" && e.blocked > 0 && e.guarded > 0), "an end that counts requests of the block and of the guard");
  assert.ok(ends.some((e: any) => e.result === "locked" && !starts.has(e.act)), "a refusal at check 4: an end with no start");
  assert.ok(ends.some((e: any) => e.id === null && e.result === "no_such_name"), "a refusal at check 2: an end that names no credential");
  assert.ok(ends.some((e: any) => e.stopped_now === true), "an end that stops its credential");
  // A refusal with no start runs while an act of the same credential runs: only the act id tells them apart (B3).
  assert.ok(ends.some((e: any) => !starts.has(e.act) && [...starts.values()].some((s: any) => s.id === e.id && s.scope === e.scope)), "a refusal of the same credential and scope as an act");
  assert.ok(!/tracker\.example|"blocked":\[/.test(JSON.stringify(control.events)), "no event names a blocked host");
  for (const ev of control.events.filter((v: any) => v.ev.ev === "sign_ins").map((v: any) => v.ev)) {
    assert.ok(["none", "locked", "open"].includes(ev.state), ev.state);
    assert.equal(ev.pane_key, control.state.sign_ins.pane_key);
    assert.equal(Buffer.from(ev.pane_key, "base64").length, 32, "the pane key's public half: 32 bytes in standard base64");
  }
  assert.ok(!holdsCanary(JSON.stringify(control.events), control.signInScan?.canaries ?? ["\u0000"]), "no event holds a canary");
});

// review-112 B5: the protections of the service's memory. Each case runs on a new fake with `--unprotected <reason>`.
test("the cases of a protection that does not hold: sign_ins_setup and sign_ins_unlock get the error with its reason, and status gives the reason", () => {
  const cases = control.unprotected?.cases ?? [];
  assert.deepEqual([...new Set(cases.map((c: any) => c.reason))].sort(), REASONS, "a case for each reason");
  // Open point 5 of PR #112: a case where both fail, whose reason is the first (dumpable), and each refusal of a protection
  // comes with a seal that the service refuses for its form (the protections come before the pane's seal).
  for (const c of cases) assert.equal(c.reason, REASONS.find((r) => c.failing.includes(r)), `${c.note}: the reason is the first that fails`);
  assert.ok(cases.some((c: any) => c.failing.length === 2 && c.reason === "dumpable"), "both fail: dumpable");
  for (const c of cases) for (const v of c.requests) if (v.res.error === unprotectedError(c.reason)) assert.ok(!RID.test(v.req.sealed.rid) || !AT.test(v.req.sealed.at), `${v.req.id}: a seal of the wrong form`);
  const ops = new Set<string>();
  for (const c of cases) {
    const store = newStore(c.reason);
    for (const { note, req, res } of c.requests) {
      let error = serviceError(req, { ...control.state, scopes: new Set() });
      if (error === null && SIGN_IN_OPS.includes(req.op)) {
        const a = storeAnswer(req, store, control.state.sign_ins);
        if ("error" in a) error = a.error;
        else assert.deepEqual(res.data, a.data, `${note}: the data`);
      }
      assert.equal(error, res.ok ? null : res.error, note);
      if (!res.ok && res.error === unprotectedError(c.reason)) ops.add(req.op);
    }
    assert.deepEqual(c.sign_ins, { state: storeState(store), records: store.snap?.records.length ?? 0, acts: 0, pane_key: control.state.sign_ins.pane_key, stopped: [], unprotected: c.reason }, `${c.note}: status`);
  }
  assert.deepEqual([...ops].sort(), ["sign_ins_setup", "sign_ins_unlock"], "both ops refuse");
  assert.equal(newStore().unprotected, null, "the vectors' other lines run where both protections hold");
});

// review-112 B4: the sign-in design's table of C12 ops (its section 6.2) names the op that the contract added.
test("the sign-in design's section 6.2 names sign_in_start_again, which the contract added (review-112 B4)", () => {
  const design = readOr("docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md");
  const s62 = design.slice(design.indexOf("### 6.2 "), design.indexOf("### 6.3 "));
  sayAll(s62, ["| `sign_in_start_again` | `credential` (the credential's id; C12 names the field `credential`, because `id` is a line key) | `kind: operator` | clears the credential's stop and its count of results in a row (section 7.7: the operator's \"Start again\"); the times of its acts in the last hour stay; answers `{}`. The contract added this op (review-112 B4): this table had no op for \"Start again\" |"], "the sign-in design");
});

// review-118 note 11 and B1, B2: the sign-in design's section 5.2 says what the service does (the daemon lead asked for maxmem).
test("the sign-in design's section 5.2 says maxmem 257 MiB, the 120 s of a pane's seal in both directions with the rid kept until the seal cannot open, and the record's second shared secret (review-118)", () => {
  const design = readOr("docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md");
  const s52 = design.slice(design.indexOf("### 5.2 "), design.indexOf("### 5.3 "));
  sayAll(s52, [
    "so the service passes `maxmem` = 257 MiB: scrypt needs 128 times r times (N + 2) bytes and more, so N = 2^18 does not derive under 256 MiB (measured; board ab-v16.97.2).",
    "refuses a time more than 120 s from its clock (before or after it) and a request id that it keeps, and only then uses the values. It keeps the request id of each seal that it takes until that seal can no longer open: until its time is more than 120 s in the past and at least 120 s after the service first saw the id (review-118 B2; C12 is the master).",
    "two shared secrets (the ephemeral key's with the store's public key, and the store's private key's with the store's public key, as HPKE's auth mode does, so only the open store key makes a seal that opens: review-118 B1)",
  ], "the sign-in design");
  assert.ok(!says(s52, "`maxmem` = 256 MiB") && !says(s52, "refuses a time more than 120 s old"), "the old sentences are gone");
});

test("the service design (2026-11-09) gains the rows of the stored sign-ins (the sign-in design, section 10)", () => {
  sayAll(SERVICE_DESIGN, [
    "| Stored sign-ins | none | section 5 of the sign-in design (`2026-11-10-stored-sign-in-credentials-design.md`) |",
    "| `sign_ins_setup {sealed}`, `sign_ins_unlock {sealed}`, `sign_ins_rekey {sealed}`, `sign_in_seal {record, offer, sealed}`, `sign_in_reseal {record}`, `sign_in_start_again {credential}` (operator; an offer with `kind: token`), `sign_ins_lock` (operator, or the daemon at the uninstall) | The stored sign-ins (C12; the sign-in design, section 6.2): the set-up, the unlock, a new passphrase, the seal and the new seal of a record, the operator's \"Start again\" of a stopped credential, the lock. Only sealed text crosses the door. |",
    "| `sign_ins {key, records}` | A complete snapshot of the store's files, at each connect after `set_sessions` and at each change. |",
    "| `sign_in` | the act's `phase` (`start` or `end`) and its act id, the scope, the repo, the credential's id, name and origin, and the time; at the end also the result, the time, the numbers of the requests that the block and the guard stopped (no host), and whether the act stopped the credential; never a username, a password or a form value |",
    "| `sign_ins` | the store's state and the pane key's public half |",
    "| Stored sign-ins | none | sealed records in agentwatch's token store; the open store key only in the service's memory, after the operator's unlock; the pane key, so that agentwatch gets only sealed text (the sign-in design, section 5) |",
    "| The service's memory | none | board ab-v16.96 (hold SIGUSR1 at start; disable the inspector signal), non-dumpable, `LimitCORE=0` (the sign-in design, section 5.5) |",
    "; stage 1e (the sign-in design, section 13): the stored sign-ins' store and the sign-in act, off by default",
  ]);
});
