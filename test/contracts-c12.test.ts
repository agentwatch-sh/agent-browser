// Contract C12 (the control door between the service and the agentwatch daemon) and the format of the MCP's allow
// list (a part of C11), board task ab-v16.94.1: docs/contracts/C12.md and docs/contracts/mcp-allow-list.md are their
// masters, and test/vectors/control.json and test/vectors/mcp-allow-list.json their vectors. Nothing builds them yet:
// stage 1 (the service) and agentwatch's stage 2 (the daemon's client) test against the same vectors. The small
// reference rules below follow the text, so a vector that breaks a rule fails here first.
import { test } from "node:test";
import assert from "node:assert/strict";
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

// ---- C12: the reference of the door's rules ----

const KINDS = ["operator", "token", "daemon"];
const VIAS = ["web", "send", "cli", "config", "daemon"];
const ERRORS = ["unsupported", "bad request", "not the operator", "this prompt is gone"];
const isRoot = (r: any) => isObj(r) && Number.isSafeInteger(r.pid) && r.pid > 1 && Number.isSafeInteger(r.start) && r.start >= 0;
const strings = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === "string");
const scope = (x: unknown) => typeof x === "string" && SCOPE.test(x);
// Each op of C12: its fields' check, and the kinds that it takes (null: any kind).
const OWN = ["daemon"], ACT = ["operator"], START = ["operator", "token"];
const OPS: Record<string, { fields: (r: any) => boolean; kinds: string[] | null }> = {
  config: { kinds: OWN, fields: (r) => typeof r.enabled === "boolean" && typeof r.control === "boolean" && (r.chrome_bin === null || typeof r.chrome_bin === "string") && strings(r.chrome_args) },
  set_sessions: {
    kinds: OWN,
    fields: (r) => Array.isArray(r.sessions) && r.sessions.every((s: any) => isObj(s) && scope(s.scope) && (s.repo === null || typeof s.repo === "string") && Array.isArray(s.roots) && s.roots.every(isRoot) && (s.cgroup === null || typeof s.cgroup === "string")) &&
      Array.isArray(r.remote) && r.remote.every((x: any) => isObj(x) && typeof x.scope === "string" && typeof x.box === "string" && typeof x.list === "string") &&
      isObj(r.box) && strings(r.box.hosts) && strings(r.box.cookie_names),
  },
  session_ended: { kinds: OWN, fields: (r) => scope(r.scope) },
  launch_check: { kinds: OWN, fields: (r) => scope(r.scope) },
  list_set: { kinds: ACT, fields: (r) => scope(r.list) && strings(r.allow) },
  prompt_allow: { kinds: ACT, fields: (r) => typeof r.prompt === "string" && r.prompt.length > 0 },
  prompt_dismiss: { kinds: ACT, fields: (r) => typeof r.prompt === "string" && r.prompt.length > 0 },
  import: { kinds: ACT, fields: (r) => isObj(r.payload) },
  start: { kinds: START, fields: () => true },
  stop: { kinds: START, fields: () => true },
  status: { kinds: null, fields: () => true },
  lists_get: { kinds: null, fields: () => true },
  prompts_get: { kinds: null, fields: () => true },
  endpoint: { kinds: null, fields: (r) => scope(r.scope) },
  sender: { kinds: null, fields: () => true },
};
const byFits = (by: any) => isObj(by) && keysOf(by).join() === "kind,user,via" && KINDS.includes(by.kind) && typeof by.user === "string" && by.user.length > 0 && VIAS.includes(by.via);
// The service's error for a request, in C12's order (null: the service applies it).
function serviceError(req: any, state: { prompts: string[] }): string | null {
  const o = OPS[req.op];
  if (!o) return "unsupported";
  if (!byFits(req.by) || !o.fields(req)) return "bad request";
  if (o.kinds !== null && !o.kinds.includes(req.by.kind)) return o.kinds === ACT ? "not the operator" : "bad request";
  if ((req.op === "prompt_allow" || req.op === "prompt_dismiss") && !state.prompts.includes(req.prompt)) return "this prompt is gone";
  return null;
}
// Each event of C12 and its fields (stopped with the reason stop also has by).
const EVENTS: Record<string, string[]> = {
  ready: ["chrome_pid", "chrome_version", "extension_version", "endpoint"],
  prompt: ["id", "state", "host", "scope", "list", "from", "warnings"],
  stopped: ["reason"],
  chrome: ["version", "update"],
  error: ["op", "user", "domain", "counts"],
};

test("C12's master is this file (board ab-v16.94.1): new, two parties, its source, the stages, and no use before stage 1", () => {
  assert.ok(C12.startsWith("# C12. The control door (agent-browser's service <-> the agentwatch daemon)\n"), "the heading");
  for (const s of [
    "This file is the master for C12. C12 is new in board task ab-v16.94.1, stage 0 of the self-contained agent browser.",
    "It binds this repository (the service, `agent-browser service`) and agentwatch (its daemon), and no other.",
    "Its source is the design `docs/superpowers/specs/2026-11-09-self-contained-agent-browser-design.md`, section 7.1: the daemon lead's proposal and review (R1, R7, m1, C4, C7 and C8), and the operator's answers of 2026-11-10 (its section 19).",
    "The vectors: `test/vectors/control.json`.",
    "| The door, its admission, the hello, the service's answers and its events | agent-browser's service | stage 1 (boards ab-v16.94.2 to ab-v16.94.5), off by default |",
    "| The client, the provenance and the requests | the agentwatch daemon | stage 2, off by default |",
    "Nothing uses C12 before stage 1. The old daemon path stays the default, and it does not change, until stage 3 turns the switch on for a box (with the operator's approval).",
  ]) assert.ok(says(C12, s), `C12 says: ${s}`);
});

test("C12 states the door and who connects: only the agentwatch daemon process itself (R1), and a refusal when the check cannot run (m1)", () => {
  const door = part(C12, "The door.");
  for (const s of [
    "A Unix socket with mode 0600, `control.sock`, in the service's run folder (mode 0700): `$XDG_RUNTIME_DIR/agent-browser/` on Linux, `~/.cache/agent-browser/run/` on the Mac. A path is at most 103 bytes. The door has no TCP port.",
    "One JSON object per line, in UTF-8, with a newline at its end. A line is at most `CONTROL_MAX_LINE = 33619968` bytes (the 33,554,432 bytes of a C2 payload and 64 KiB more). A side that reads a longer line closes the connection.",
    "The daemon sends the requests. The service sends the answers and the events. The service sends no request.",
  ]) assert.ok(says(door, s), `C12 says: ${s}`);
  assert.equal(control.constants.CONTROL_MAX_LINE, 33554432 + 65536, "the C2 limit and 64 KiB");
  const who = part(C12, "Who connects: only the agentwatch daemon process itself (the daemon lead's R1).");
  for (const s of [
    "At each accept the service reads the peer (`SO_PEERCRED` and `SO_PEERPIDFD` on Linux) and admits it only when all of these hold:",
    "1. The service gets the MainPID of agentwatch's unit from the user's systemd at this accept. A daemon restart changes it.",
    "2. The peer is the MainPID itself, or a direct child of it: the peer's parent pid is the MainPID, and the parent's start time (field 22 of `/proc/<ppid>/stat`) equals the MainPID's start time, read in the same check.",
    "3. The peer's command line (`/proc/<pid>/cmdline`) is the daemon's command, which the service's unit file names.",
    "The command line, not the executable, carries this check: a venv's `python` is a symbolic link, so `/proc/<pid>/exe` names the shared interpreter of every Python process.",
    "4. The peer is the same process during the whole check: the service holds its pidfd, and the peer's start time is the same before and after the reads, and later than its parent's.",
    "A process of agentwatch's cgroup is not enough. A child that the daemon forks and that connects itself has the daemon, not the MainPID, as its parent, and it is refused. The daemon never passes its connection to another process.",
    "The service's own pid never passes. No agent-browser CLI command is a control client.",
    "When the check cannot run, the door refuses (the daemon lead's m1). If the systemd query fails, or the daemon runs with no systemd user unit, the service sends one line `{\"t\":\"refused\",\"reason\":\"<text>\"}` that gives the reason, closes the connection, and logs the reason.",
    "The daemon shows that line in `agentwatch health`. The service never admits by a weaker rule.",
    "On the Mac the service reads `LOCAL_PEERPID`, gets the job's pid from `launchctl print gui/<uid>/<agentwatch's label>` (its `pid` line) at each accept, reads the parent and the start time with `proc_pidinfo` and the command line with `sysctl` (`KERN_PROCARGS2`), and applies the same rules (stage 4; not run on the Mac yet).",
  ]) assert.ok(says(who, s), `C12 says: ${s}`);
  for (const r of control.refused) {
    assert.deepEqual(keysOf(r.line), ["reason", "t"], r.note);
    assert.equal(r.line.t, "refused", r.note);
    assert.ok(typeof r.line.reason === "string" && r.line.reason.length > 0, r.note);
  }
});

test("C12 states the hello (C7): its two shapes, v 1, the commit for the pin, additive features, fake, --hello, and no request before the hellos", () => {
  const hello = part(C12, "The hello (the daemon lead's C7).");
  for (const s of [
    "After the admission each side sends its hello as its first line:",
    "The service: `{\"t\":\"hello\",\"v\":1,\"side\":\"service\",\"version\":\"<agent-browser version>\",\"commit\":\"<commit or null>\",\"features\":[...]}`.",
    "The daemon: `{\"t\":\"hello\",\"v\":1,\"side\":\"daemon\",\"version\":\"<agentwatch version>\",\"features\":[...]}`.",
    "`v` is the version of this door's lines: 1. `version` is the side's package version.",
    "The service's `commit` is the 40-hex commit of agent-browser that it runs, or `null` when it cannot tell; the daemon compares it with its pin (the design, section 7.3).",
    "Fields and features are only added, never changed: a side ignores a field and a feature that it does not know.",
    "A request for an op that the service does not have gets `{\"t\":\"res\",\"id\":\"<id>\",\"ok\":false,\"error\":\"unsupported\"}`. So an older service and a newer daemon (or the reverse) degrade, with no lock-step bump.",
    "Feature names: `fake` (the hello of `agent-browser service --fake`, a scripted state with no Chrome, for agentwatch's hermetic tests). A stage that adds an op or a field adds its feature name to this list first.",
    "`agent-browser service --hello` prints the service's hello as one line and exits, with no service running.",
    "The daemon sends no request before it has read the service's hello, and the service answers no request before it has read the daemon's hello.",
  ]) assert.ok(says(hello, s), `C12 says: ${s}`);
  const FEATURES = ["fake"];
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
});

test("C12 states the lines, provenance (R7) and the order of the service's checks", () => {
  const lines = part(C12, "The lines.");
  for (const s of [
    "A request: `{\"t\":\"req\",\"id\":\"<id>\",\"op\":\"<op>\",\"by\":{\"kind\":\"<kind>\",\"user\":\"<user>\",\"via\":\"<via>\"},...}`, with the op's fields at the top level, as in C4. `id` is a string, unique on its connection.",
    "An answer: `{\"t\":\"res\",\"id\":\"<id>\",\"ok\":true,\"data\":{...}}` or `{\"t\":\"res\",\"id\":\"<id>\",\"ok\":false,\"error\":\"<text>\"}`. The service answers each request once.",
    "An event: `{\"t\":\"ev\",\"ev\":\"<event>\",...}`, with the event's fields at the top level.",
    "A line that is not a JSON object, or a request with no string `id`, closes the connection.",
    "A request with an op that the service does not have gets `unsupported` (the hello, above).",
    "A request whose `by` breaks the shape of provenance (below), or whose fields break its row of the requests (below), gets `{\"t\":\"res\",\"id\":\"<id>\",\"ok\":false,\"error\":\"bad request\"}`.",
    "A side ignores a line whose `t` it does not know: a newer side can add a kind of line.",
  ]) assert.ok(says(lines, s), `C12 says: ${s}`);
  const prov = part(C12, "Provenance (the daemon lead's R7).");
  for (const s of [
    "Each request carries one shape of provenance: `\"by\":{\"kind\":\"operator\"|\"token\"|\"daemon\",\"user\":\"<user>\",\"via\":\"web\"|\"send\"|\"cli\"|\"config\"|\"daemon\"}`.",
    "`kind: operator` only when the gateway's field is present: the gateway adds `\"operator\":{\"user\":...,\"login\":\"password\"}` to the daemon's op only after its password-login check.",
    "The daemon refuses a list change, an allow, a dismissal or an import without it. A caller with the API token (an agent, or `agentwatch browser ...` in a terminal) never produces it.",
    "`kind: token` for a start, a stop or a read with the API token (for a start and a stop, today's rule).",
    "`kind: daemon` for the daemon's own requests: `config`, `set_sessions`, `session_ended`, `launch_check`, and the daemon's own reads.",
    "`browser.control` is a key of agentwatch's config file, so it comes in `config` with `kind: daemon` and `via: config`. The daemon's other own requests have `via: daemon`.",
    "`user` is the agentwatch user: the login's user for `operator`, the token's user for `token`, and the daemon's own user for `daemon`.",
    "`via` is where the act came from: `web` (the web viewer), `send` (the operator extension's send, C9), `cli` (the agentwatch CLI), `config` (the config file), `daemon` (the daemon itself).",
    "The service checks a request in this order: its op (`unsupported`); the shape of its `by` and its fields (`bad request`); then its kind.",
    "The service applies an operator act (`list_set`, `prompt_allow`, `prompt_dismiss`, `import`) only with `kind: operator`; any other kind gets `{\"t\":\"res\",\"id\":\"<id>\",\"ok\":false,\"error\":\"not the operator\"}`.",
    "It applies `start` and `stop` only with `kind: operator` or `kind: token`, and the daemon's own requests (`config`, `set_sessions`, `session_ended`, `launch_check`) only with `kind: daemon`; another kind gets `bad request`. The reads (`status`, `lists_get`, `prompts_get`, `endpoint`, `sender`) take any kind.",
    "The service does not check `via`: it logs it.",
    "The service takes provenance only from the control door, never from a client request (C11), and it logs each act with its provenance.",
  ]) assert.ok(says(prov, s), `C12 says: ${s}`);
});

test("C12's table of requests names exactly the ops of the reference, with their fields and kinds", () => {
  const rows = table(C12, "| Op | Fields | What the service does, and its answer's `data` |");
  assert.deepEqual([...rows.keys()].sort(), Object.keys(OPS).sort(), "the ops");
  const fields: Record<string, string[]> = {
    config: ["enabled", "control", "chrome_bin", "chrome_args"], set_sessions: ["sessions", "remote", "box"], session_ended: ["scope"], launch_check: ["scope"],
    list_set: ["list", "allow"], prompt_allow: ["prompt"], prompt_dismiss: ["prompt"], import: ["payload"], endpoint: ["scope"],
  };
  for (const [op, cells] of rows) {
    for (const f of fields[op] ?? []) assert.ok(spans(cells[0]).includes(f), `${op}: the field ${f}`);
    if (!fields[op]) assert.equal(cells[0], "none", `${op}: no field`);
  }
  for (const s of [
    "Applies agentwatch's `browser.*` config keys, as data. The daemon sends it at each connect and at each change. `chrome_bin` keeps the way back to Chromium with `--load-extension`; `control: false` makes the endpoint and the MCP path answer their 503 (C11, from stage 3); `enabled: false` stops the browser.",
    "Ends the scope: closes its tabs (`end_scope`, the receiver's sweep), drops its roots, removes its list copy, and records the ended scope.",
    "The service owns the prompts and their dismissals. The allow adds the host to the prompt's list, as a `list_set`, and answers as `list_set` does; the dismissal's `data` is `{}`.",
    "The endpoint's URL for the scope (for `agentwatch browser endpoint` and `env`).",
    "The sender's ID, its version and its package (C1, C9).",
    "A complete snapshot. The service builds the scopes, the list of each scope (by repo), the `set_scopes` object (C4) and the model's roots. No scope object goes out before the first complete snapshot (the daemon lead's C4).",
    "`data`: `{\"refusal\":\"<text>\"}` while an ended scope of that name is held in memory only, else `{\"refusal\":null}`. The daemon asks before each launch. If the service does not answer in 2 s, the daemon refuses only a name that ended since its own start, with a text that says to try again.",
    "`data`: `{\"refused\":[{\"entry\":\"<entry>\",\"reason\":\"<text>\"}]}`.",
    "A prompt that the service does not know gets the error `this prompt is gone`.",
    "Checks the payload (C2), drops the box's own sign-in cookies (the hosts and names of `set_sessions`), sends `import` to the receiver (C4), and answers the counts of C4's `import`. Nothing is written to disk.",
    "Starts or stops Chrome and Xvfb. Today's rule stays (the API token may start and stop) until the operator answers Q5 (board item ab-6ng).",
    "the state (`off`, `starting`, `ready` or `failed closed`), with an agent's text and an operator's text for each state (I2: no agent's text names a stop or a start)",
    "Stage 1a fixes the keys of the `data` of `status`, `lists_get`, `prompts_get`, `endpoint` and `sender` in this table before it builds them, with the daemon lead's review.",
    "The design's table names the prompt's field `id`; here it is `prompt`, because `id` is the request's id.",
    "The design's table names a field `providers` for `list_set` too. No list has providers: the operator chose the allow prompt, not a list of sign-in providers (board item ab-pbk). So `list_set` has no such field, and a later rule can add it as an additive field.",
  ]) assert.ok(says(C12, s), `C12 says: ${s}`);
  for (const e of ERRORS) assert.ok(C12.includes("`" + e + "`") || C12.includes(`"error":"${e}"`), `C12 names the error ${e}`);
});

test("each request vector fits C12, gets its answer, and each bad request vector gets the error of C12's order", () => {
  const ids = new Set<string>();
  const ops = new Set<string>();
  for (const { note, req, res } of [...control.requests, ...control.badRequests]) {
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
      assert.ok(ERRORS.includes(res.error), `${note}: an error of C12`);
    }
    assert.equal(serviceError(req, control.state), res.ok ? null : res.error, note);
    assert.ok(JSON.stringify(req).length < control.constants.CONTROL_MAX_LINE, note);
  }
  for (const { req } of control.requests) ops.add(req.op);
  for (const op of ["config", "set_sessions", "session_ended", "launch_check", "list_set", "prompt_allow", "prompt_dismiss", "import", "start", "stop"]) assert.ok(ops.has(op), `a vector for ${op}`);
  // Each kind's rule has a vector.
  const has = (f: (v: any) => boolean) => [...control.requests, ...control.badRequests].some(f);
  assert.ok(has((v) => v.req.op === "config" && v.req.by.via === "config" && v.req.control === false), "browser.control in config, via config");
  assert.ok(has((v) => v.req.op === "set_sessions" && v.req.sessions.length > 1 && v.req.remote.length === 0), "a complete snapshot, no remote scope before stage 5");
  assert.ok(has((v) => v.req.op === "import" && v.req.by.kind === "operator" && v.req.by.via === "send"), "an import from the send");
  assert.ok(has((v) => v.req.op === "start" && v.req.by.kind === "token" && v.res.ok), "a start with the token: today's rule");
  assert.ok(has((v) => v.req.op === "stop" && v.req.by.kind === "token" && v.res.ok), "a stop with the token: today's rule until Q5");
  for (const op of ["list_set", "prompt_allow", "import"]) assert.ok(has((v) => v.req.op === op && v.req.by?.kind !== "operator" && v.res.error === "not the operator"), `${op} by another kind`);
  for (const e of ERRORS) assert.ok(has((v) => v.res.error === e), `a vector of ${e}`);
  assert.ok(has((v) => v.req.op === "launch_check" && typeof v.res.data?.refusal === "string") && has((v) => v.req.op === "launch_check" && v.res.data?.refusal === null), "launch_check: a refusal and none");
});

test("C12's event table names exactly the events of the reference, and each event vector has their fields only, with no URL path, page or cookie", () => {
  const rows = table(C12, "| Event | Fields |");
  assert.deepEqual([...rows.keys()].sort(), Object.keys(EVENTS).sort());
  for (const [ev, cells] of rows) for (const f of EVENTS[ev]) assert.ok(spans(cells[0]).includes(f), `${ev}: the field ${f}`);
  const seen = new Set<string>();
  for (const { note, ev } of control.events) {
    assert.equal(ev.t, "ev", note);
    const fields = EVENTS[ev.ev];
    assert.ok(fields, `${note}: an event of C12`);
    seen.add(ev.ev);
    const want = ["ev", "t", ...fields, ...(ev.ev === "stopped" && ev.reason === "stop" ? ["by"] : [])].sort();
    assert.deepEqual(keysOf(ev), want, note);
    if (ev.ev === "stopped") assert.ok(["receiver_missing", "sessions_unread", "start_failed", "stop"].includes(ev.reason), note);
    if (ev.by !== undefined) assert.ok(byFits(ev.by), `${note}: the stop's provenance`);
    if (ev.ev === "prompt") assert.ok(["open", "changed", "closed"].includes(ev.state) && strings(ev.warnings), note);
    if (ev.ev === "ready") assert.ok(isObj(ev.endpoint) && (["pidfd", "stat", "mac"].includes(ev.endpoint.form) ? keysOf(ev.endpoint).join() === "form" : ev.endpoint.form === null && typeof ev.endpoint.reason === "string"), note);
    assert.ok(!/"(url|path|page|cookie|cookies)"/.test(JSON.stringify(ev)), `${note}: no URL, path, page or cookie`);
  }
  assert.deepEqual([...seen].sort(), Object.keys(EVENTS).sort(), "every event has a vector");
  for (const reason of ["receiver_missing", "sessions_unread", "start_failed", "stop"]) assert.ok(control.events.some((v: any) => v.ev.ev === "stopped" && v.ev.reason === reason), `stopped: ${reason}`);
  for (const s of [
    "`reason`: `receiver_missing`, `sessions_unread`, `start_failed` or `stop`; for `stop`, `by` (the stop's provenance). The daemon sees each fail-closed stop (the daemon lead's C4).",
    "`id`, `state` (`open`, `changed` or `closed`), `host`, `scope`, `list`, `from`, `warnings`; no URL path; the per-host limit of once in 10 s stays",
    "`op`, `user`, `domain`, `counts`; never a page, a cookie or a URL path",
  ]) assert.ok(says(C12, s), `C12 says: ${s}`);
});

test("C12 states what happens when the daemon drops, and the vectors' part", () => {
  const drop = part(C12, "When the daemon drops (a daemon restart or stop).");
  for (const s of [
    "The service goes on. Chrome, the endpoint and the last `set_sessions` stay, and the walk refuses each root that is gone.",
    "The event stream keeps no event for a later reader.",
    "At each connect the daemon reads `status`, which gives the state, the last stop with its reason and time, the open prompts and the update state, so the daemon still sees a `stopped` event that it missed.",
    "The next complete `set_sessions` is the truth again.",
  ]) assert.ok(says(drop, s), `C12 says: ${s}`);
  assert.ok(says(part(C12, "The vectors."), "`test/vectors/control.json` holds lines of each kind"), "C12 names its vectors");
});

// ---- The MCP's allow list: the reference of the format ----

const NEVER = ["core-install", "storage", "devtools", "testing", "config"];
const UNSAFE = "browser_run_code_unsafe";
// A property that names a file or a path: a string (or a list of strings) whose name or description says so.
const speaksOfFile = (k: string, p: any) => isObj(p) && (p.type === "string" || (p.type === "array" && p.items?.type === "string")) && /file|path|folder|directory/i.test(`${k} ${p.description ?? ""}`);
function brokenRules(list: any, pinned: { name: string; inputSchema: any }[], pin: string) {
  const out = new Set<string>();
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
function callAnswer(list: any, call: { name: string; arguments: Record<string, unknown> }, folder: string, realpath: Record<string, string> = {}) {
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

test("the allow list's format: the master file, why, the file's fields, what the service does and the test of stage 1d", () => {
  assert.ok(ALLOW.startsWith("# The MCP's allow list (a part of C11)\n"), "the heading");
  for (const s of [
    "This file is the master for the format of the MCP's allow list. It is a part of C11 (`docs/contracts/C11.md`, the MCP inside the service).",
    "Its source is the design `docs/superpowers/specs/2026-11-09-self-contained-agent-browser-design.md`, section 8.2, and the operator's answer Q4 of 2026-11-10 (the standard Playwright MCP, pinned, under the allow list; the design's section 19).",
    "Stage 1d (board ab-v16.94.5) writes the first list for the pinned version of `@playwright/mcp`, and its test. Stage 0 adds no package. The vectors of the format: `test/vectors/mcp-allow-list.json`.",
    "The service serves only the tools and the argument keys that the list names, not every tool except some. So a new tool or a new argument in a newer `@playwright/mcp` reaches no client until a review adds it to the list.",
    "One JSON file for the one pinned version of `@playwright/mcp`, in this repository.",
    "`package` is `@playwright/mcp`. `version` is the exact pinned version, the same as the pin in `package.json`.",
    "`capabilities` names the MCP's capabilities that the service turns on, explicitly: the ones that give the tools of `tools`. It never names `core-install`, `storage`, `devtools`, `testing` or `config`.",
    "`tools` maps each allowed tool to its rule. `keys` lists each argument key that the service passes. `paths` lists each key of `keys` that names a file or a path. `schema` is the tool's input schema in the pinned version's `tools/list`, as it is.",
    "`refused` maps each other tool of the pinned version's `tools/list` to the reason why the service never serves it.",
    "`browser_run_code_unsafe` is always in `refused`: it runs a client's JavaScript in the MCP server's process, which inside the service holds the lists, the native link and the control door's state.",
    "Each tool of the pinned version's `tools/list` is in `tools` or in `refused`, and in only one of them.",
    "`tools/list`: the service drops each tool that `tools` does not name.",
    "`tools/call` of a tool that `tools` does not name: the service refuses it before the call reaches the MCP's code, with the JSON-RPC error `-32601` and the message `Not available in the agent browser: <tool>`.",
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
});

test("each allow list vector follows the format: the example breaks no rule, each bad list breaks exactly its rule, each call gets the format's answer", () => {
  assert.deepEqual(brokenRules(allowV.list, allowV.pinnedTools, allowV.pin), [], "the example list");
  assert.ok(Object.hasOwn(allowV.list.refused, UNSAFE));
  const rules = new Set<string>();
  for (const b of allowV.badLists) {
    assert.deepEqual(brokenRules(b.list, allowV.pinnedTools, allowV.pin), [b.breaks], b.note);
    rules.add(b.breaks);
  }
  assert.equal(rules.size, 8, "each rule of the format's test has a bad list (the rule \"once\" has two: a tool in neither and a tool in both)");
  const answers = new Set<string>();
  for (const c of allowV.calls) {
    assert.deepEqual(callAnswer(allowV.list, c.call, allowV.folder, c.realpath), c.answer, c.note);
    answers.add(c.answer === "pass" ? "pass" : String(c.answer.code));
  }
  assert.deepEqual([...answers].sort(), ["-32601", "-32602", "pass"]);
  assert.ok(allowV.calls.some((c: any) => c.call.name === UNSAFE && c.answer.code === -32601), "the unsafe tool is refused");
  assert.ok(allowV.calls.some((c: any) => c.realpath && Object.entries(c.realpath).some(([a, b]) => a.startsWith(allowV.folder) && !String(b).startsWith(allowV.folder)) && c.answer !== "pass"), "a link that leaves the folder");
  assert.ok(allowV.calls.some((c: any) => c.realpath && Object.values(c.realpath).some((b) => String(b).startsWith(allowV.folder.slice(0, -1)) && !String(b).startsWith(allowV.folder)) && c.answer !== "pass"), "a folder with the same start");
});
