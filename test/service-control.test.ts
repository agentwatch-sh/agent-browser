// The service's control door (contract C12, docs/contracts/C12.md; board ab-v16.94.2, stage 1a of the self-contained
// agent browser): the lines, the hellos, the order of the checks, the line limit, the log rule and the event stream,
// for the stage 1a service and for its fake (`--fake`), against the vectors of test/vectors/control.json. The door
// runs in this process with an admission that admits each connection; test/service-admission.test.ts checks the
// admission with real processes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { CONTROL_MAX_LINE, ControlDoor, encodeLine, OPS, type Admit, type Handler } from "../src/service/control.ts";
import { commitOf, defaultControlDoor, LATER_OPS, packageInfo, serviceHello, Stage1a, STAGE_1A_OPS, STAGE_1A_TEXTS, STAGE_1B2_OPS } from "../src/service/service.ts";
import { STAGE_1C_OPS } from "../src/service/stage1c.ts";
import { STAGE_1B1_OPS } from "../src/service/unit/part.ts";
import { FAKE_STATE, FakeService, serviceRunFolders, startFake } from "../src/service/fake.ts";
import { closesWithin, DAEMON_HELLO, daemonClient, sleep, type DaemonClient } from "./fake-daemon.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const control = JSON.parse(readFileSync(new URL("./vectors/control.json", import.meta.url), "utf8"));
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const keysOf = (o: object) => Object.keys(o).sort();
const READ_KEYS: Record<string, string[]> = {
  status: ["agent_text", "chrome_kind", "chrome_pid", "chrome_version", "endpoint", "extension_version", "last_stop", "lists", "mcp", "operator_text", "prompts", "sessions", "state", "update"],
  endpoint: ["url"],
};
const AGENT_DOOR = "/run/user/1000/agent-browser/cdp.sock";
const admitAll: Admit = async () => ({ ok: true });

type Door = { door: ControlDoor; path: string; logs: string[]; close: () => Promise<void> };
async function openDoor(handler: Handler, o: { admit?: Admit; maxLine?: number } = {}): Promise<Door> {
  const dir = mkdtempSync(join(tmpdir(), "ab-ctl-"));
  const path = join(dir, "control.sock");
  const logs: string[] = [];
  let door: ControlDoor;
  // The folder goes also when the open throws (N10).
  try { door = await ControlDoor.open({ path, admit: o.admit ?? admitAll, handler, log: (l) => logs.push(l), maxLine: o.maxLine }); }
  catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
  return { door, path, logs, close: async () => { await door.stop(); rmSync(dir, { recursive: true, force: true }); } };
}
const stage1a = () => new Stage1a({ agentDoor: { url: (scope) => `ws+unix://${AGENT_DOOR}:/devtools/browser/${scope}`, state: () => ({ form: "pidfd" }) } });

/** A client past the hellos: the service's hello first, then the daemon's. */
async function hello(path: string): Promise<{ c: DaemonClient; hello: any }> {
  const c = await daemonClient(path);
  const h = await c.next();
  c.send(DAEMON_HELLO);
  return { c, hello: h };
}

// ------------------------------------------------------------------ the hello

test("the service's hello is its first line after the admission: v 1, side service, the package's version, the commit that it runs, and the features ([] for stage 1a, [\"fake\",\"mcp_token\",\"sign_ins\"] with commit null for the fake)", async () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  assert.deepEqual(packageInfo(), { version: VERSION, commit: head }, "this checkout's version and commit");
  const real = await openDoor(stage1a());
  const fake = await openDoor(new FakeService({}));
  try {
    const a = await daemonClient(real.path);
    const ha = await a.next();
    assert.deepEqual(ha, { t: "hello", v: 1, side: "service", version: VERSION, commit: head, features: [] });
    assert.equal(a.lines.length, 1, "nothing before the daemon's hello");
    const b = await daemonClient(fake.path);
    const hb = await b.next();
    const vector = control.hellos.find((h: any) => h.line.features.includes("fake")).line;
    assert.deepEqual(hb, { ...vector, version: VERSION }, "the fake's hello: the vector's, with this package's version");
    assert.deepEqual(hb.features, ["fake", "mcp_token", "sign_ins"], "the fake's features: fake, mcp_token (the token design) and sign_ins (the stored sign-ins)");
    a.end(); b.end();
  } finally { await real.close(); await fake.close(); }
});

test("the commit of the service: a folder named by a 40-hex commit (agentwatch's install), a git checkout's HEAD, else null", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-commit-"));
  try {
    const pinned = join(dir, "0123456789abcdef0123456789abcdef01234567");
    mkdirSync(pinned);
    assert.equal(commitOf(pinned), "0123456789abcdef0123456789abcdef01234567");
    const plain = join(dir, "plain");
    mkdirSync(plain);
    assert.equal(commitOf(plain), null);
    assert.equal(commitOf(ROOT), execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim());
    assert.deepEqual(serviceHello("1.2.3", null, ["fake"]), { t: "hello", v: 1, side: "service", version: "1.2.3", commit: null, features: ["fake"] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the daemon's hello: a hello whose side is not daemon or whose v is not 1 closes the connection with no answer; a newer daemon's hello (a field and a feature) is taken; a request before the hello closes it", async () => {
  const d = await openDoor(stage1a());
  try {
    const status = { t: "req", id: "s1", op: "status", by: { kind: "daemon", user: "ann", via: "daemon" } };
    for (const bad of control.badHellos.filter((h: any) => h.reader === "service")) {
      const c = await daemonClient(d.path);
      await c.next();
      c.send(bad.line); c.send(status);
      assert.equal(await closesWithin(c), true, bad.note);
      assert.equal(c.lines.length, 1, `${bad.note}: no answer`);
    }
    const v2 = await daemonClient(d.path);
    await v2.next();
    v2.send({ ...DAEMON_HELLO, v: 2 }); v2.send(status);
    assert.equal(await closesWithin(v2), true, "a hello with v 2");
    assert.equal(v2.lines.length, 1, "no answer after a hello with v 2");
    const early = await daemonClient(d.path);
    await early.next();
    early.send(status);
    assert.equal(await closesWithin(early), true, "a request before the daemon's hello");
    assert.equal(early.lines.length, 1);
    const newer = await daemonClient(d.path);
    await newer.next();
    newer.send(control.hellos.find((h: any) => h.newer).line);
    newer.send(status);
    assert.equal((await newer.answer("s1")).ok, true, "a newer hello is taken");
    newer.end();
  } finally { await d.close(); }
});

// ------------------------------------------------------------------ the lines

test("a line that is not a JSON object, a request with no string id, or bytes that are not UTF-8 close the connection; a line whose t the service does not know is ignored", async () => {
  const d = await openDoor(stage1a());
  try {
    for (const [what, bytes] of [["not JSON", "{not json\n"], ["an array", "[1]\n"], ["a number", "7\n"], ["null", "null\n"],
      ["a request with no id", JSON.stringify({ t: "req", op: "status", by: { kind: "daemon", user: "ann", via: "daemon" } }) + "\n"],
      ["a request with a number id", JSON.stringify({ t: "req", id: 7, op: "status", by: { kind: "daemon", user: "ann", via: "daemon" } }) + "\n"],
      ["bytes that are not UTF-8", Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a])]] as const) {
      const { c } = await hello(d.path);
      c.send(bytes as any);
      assert.equal(await closesWithin(c), true, what);
      assert.equal(c.lines.length, 1, `${what}: no answer`);
    }
    const { c } = await hello(d.path);
    c.send({ t: "later_kind", x: 1 });
    c.send({ t: "res", id: "x", ok: true, data: {} });
    c.send({ t: "ev", ev: "later_event" });
    c.send({ t: "req", id: "k1", op: "status", by: { kind: "daemon", user: "ann", via: "daemon" } });
    assert.equal((await c.answer("k1")).ok, true, "the connection stays after lines it ignores");
    c.end();
  } finally { await d.close(); }
});

test("each answer and event is one compact UTF-8 line: no ASCII escape of a character that UTF-8 holds", async () => {
  assert.equal(encodeLine({ s: "é✓ü" }), "{\"s\":\"é✓ü\"}\n");
  const handler: Handler = { hello: serviceHello("1.0.0", null, []), has: () => true, handle: () => ({ data: { text: "Größe ✓" } }) };
  const d = await openDoor(handler);
  try {
    const { c } = await hello(d.path);
    c.send({ t: "req", id: "u1", op: "status", by: { kind: "daemon", user: "ann", via: "daemon" } });
    assert.deepEqual((await c.answer("u1")).data, { text: "Größe ✓" });
    d.door.emit({ t: "ev", ev: "error", op: "import", user: "ann", domain: "bücher.example", counts: {} });
    await c.next((l) => l.t === "ev");
    const raw = c.bytes().toString("utf8");
    assert.ok(raw.includes("Größe ✓") && raw.includes("bücher.example"), "the characters as UTF-8");
    assert.doesNotMatch(raw, /\\u[0-9a-fA-F]{4}/, "no ASCII escape");
    assert.ok(raw.split("\n").slice(0, -1).every((l) => !/\n/.test(l) && !/^\s|\s$/.test(l)), "compact lines");
    c.end();
  } finally { await d.close(); }
});

// ------------------------------------------------------------------ the vectors

/** Run the request vectors and the bad request vectors in their order on one connection; each answer by id. */
async function runVectors(path: string): Promise<{ c: DaemonClient; answers: Map<string, any> }> {
  const { c } = await hello(path);
  const answers = new Map<string, any>();
  for (const v of [...control.requests, ...control.badRequests]) {
    c.send(v.req);
    answers.set(v.req.id, await c.answer(v.req.id));
  }
  return { c, answers };
}

test("the fake answers every request vector and every bad request vector as the vectors say, in their order on one connection, and sends the events of its own rules", async () => {
  const d = await openDoor(new FakeService({ agentDoor: AGENT_DOOR }));
  try {
    const { c, answers } = await runVectors(d.path);
    for (const v of [...control.requests, ...control.badRequests]) assert.deepEqual(answers.get(v.req.id), v.res, v.note);
    // Each request has one answer.
    const res = c.lines.filter((l) => l.t === "res");
    assert.equal(res.length, control.requests.length + control.badRequests.length, "one answer for each request");
    // The events of the fake's own rules: the allow and the dismissal close the prompts; the stop of a ready browser.
    const evs = c.lines.filter((l) => l.t === "ev");
    const p1 = control.state.prompts[0], p2 = control.state.prompts[1];
    assert.deepEqual(evs, [
      { t: "ev", ev: "prompt", id: "p1", state: "closed", host: p1.host, scope: "web-1", list: p1.list, from: null, warnings: [] },
      { t: "ev", ev: "prompt", id: "p2", state: "closed", host: p2.host, scope: "web-1", list: p2.list, from: null, warnings: [] },
      { t: "ev", ev: "stopped", reason: "stop", by: control.requests.find((v: any) => v.req.id === "r12").req.by },
      // The stored sign-ins: each change of the store's state (s6 open, s25 locked, s29 open, s43 locked, s52 none).
      ...["open", "locked", "open", "locked", "none"].map((state) => ({ t: "ev", ev: "sign_ins", state, pane_key: control.state.sign_ins.pane_key })),
    ]);
    c.end();
  } finally { await d.close(); }
});

// review-112 B5: each case of a protection that does not hold runs on a new fake with that reason (--unprotected).
test("the fake with a protection that does not hold answers each case of the vectors' unprotected, and its status gives the reason", async () => {
  assert.deepEqual(control.unprotected.cases.map((x: any) => x.reason).sort(), ["dumpable", "signal"]);
  for (const k of control.unprotected.cases) {
    const d = await openDoor(new FakeService({ agentDoor: AGENT_DOOR, unprotected: k.reason }));
    try {
      const { c } = await hello(d.path);
      for (const v of k.requests) { c.send(v.req); assert.deepEqual(await c.answer(v.req.id), v.res, v.note); }
      c.send({ t: "req", id: "st", op: "status", by: { kind: "daemon", user: "ann", via: "daemon" } });
      assert.deepEqual((await c.answer("st")).data.sign_ins, k.sign_ins, `${k.note}: status`);
      c.end();
    } finally { await d.close(); }
  }
  assert.throws(() => new FakeService({ unprotected: "other" as any }), /dumpable or signal/);
});

test("the stage 1a service answers each vector of its five ops as the vectors say, and each vector of another op unsupported (C12's ops of stage 1a); it sends no event", async () => {
  assert.deepEqual([...STAGE_1A_OPS].sort(), ["config", "endpoint", "session_ended", "set_sessions", "status"]);
  // Stage 1c's part adds its seven ops (test/service-stage1c.test.ts), stage 1b part 1's part start and stop
  // (test/service-unit-part.test.ts), stage 1b part 2's part sender (test/service-native.test.ts); the stored sign-ins'
  // eight ops come with stage 1e part 1 (board ab-v16.97.2).
  assert.deepEqual(Object.fromEntries(Object.entries(LATER_OPS).sort()), { sign_in_reseal: "1e1", sign_in_seal: "1e1", sign_in_start_again: "1e1", sign_ins: "1e1", sign_ins_lock: "1e1", sign_ins_rekey: "1e1", sign_ins_setup: "1e1", sign_ins_unlock: "1e1" });
  assert.deepEqual([...STAGE_1B1_OPS], ["start", "stop"]);
  assert.deepEqual([...STAGE_1B2_OPS], ["sender"]);
  assert.deepEqual([...STAGE_1A_OPS, ...STAGE_1C_OPS, ...STAGE_1B1_OPS, ...STAGE_1B2_OPS, ...Object.keys(LATER_OPS)].sort(), Object.keys(OPS).sort(), "each op of C12 once");
  const d = await openDoor(stage1a());
  try {
    const { c, answers } = await runVectors(d.path);
    for (const v of [...control.requests, ...control.badRequests]) {
      const got = answers.get(v.req.id);
      if (!(STAGE_1A_OPS as readonly string[]).includes(v.req.op)) {
        assert.deepEqual(got, { t: "res", id: v.req.id, ok: false, error: "unsupported" }, `${v.note}: stage 1a has no ${v.req.op}`);
      } else if (v.res.ok && Object.hasOwn(READ_KEYS, v.req.op)) {
        assert.equal(got.ok, true, v.note);
        assert.deepEqual(keysOf(got.data), READ_KEYS[v.req.op], `${v.note}: the keys of C12's data`);
      } else assert.deepEqual(got, v.res, v.note);
    }
    assert.equal(c.lines.filter((l) => l.t === "res").length, control.requests.length + control.badRequests.length, "one answer for each request");
    await sleep(50);
    assert.deepEqual(c.lines.filter((l) => l.t === "ev"), [], "no event in stage 1a");
    c.end();
  } finally { await d.close(); }
});

test("the stage 1a status: state off, the agent's text and the operator's text as two keys (I2), no Chrome fact, the endpoint's form, the MCP state none, the sessions of the last set_sessions after session_ended, no list, no prompt, no stop", async () => {
  assert.doesNotMatch(STAGE_1A_TEXTS.agent_text, /\b(stop|start|restart)/i, "I2");
  assert.notEqual(STAGE_1A_TEXTS.agent_text, STAGE_1A_TEXTS.operator_text);
  const d = await openDoor(stage1a());
  try {
    const { c } = await hello(d.path);
    const by = { kind: "daemon", user: "ann", via: "daemon" };
    c.send({ t: "req", id: "a", op: "status", by: { kind: "token", user: "ann", via: "cli" } });
    const empty = (await c.answer("a")).data;
    assert.deepEqual(empty.sessions, [], "no session before set_sessions");
    c.send(control.requests.find((v: any) => v.req.op === "set_sessions").req);
    c.send({ t: "req", id: "e", op: "session_ended", by, scope: "web-1" });
    c.send({ t: "req", id: "s", op: "status", by });
    c.send({ t: "req", id: "u", op: "endpoint", by, scope: "shell-2" });
    const s = (await c.answer("s")).data;
    assert.deepEqual(s, {
      state: "off", agent_text: STAGE_1A_TEXTS.agent_text, operator_text: STAGE_1A_TEXTS.operator_text,
      chrome_kind: null, chrome_version: null, chrome_pid: null, extension_version: null, update: null,
      endpoint: { form: "pidfd" }, mcp: { state: "none", address: null },
      sessions: [{ scope: "shell-2", repo: null, list: null, mcp_token: false }, { scope: "web-2", repo: "owner/repo", list: null, mcp_token: false }, { scope: "tool-4", repo: null, list: null, mcp_token: true }], lists: [], last_stop: null, prompts: [],
    });
    assert.deepEqual((await c.answer("u")).data, { url: `ws+unix://${AGENT_DOOR}:/devtools/browser/shell-2` });
    c.end();
  } finally { await d.close(); }
});

// ------------------------------------------------------------------ the connection tokens (board ab-v16.94.5; the token design, board ab-v16.94.10)

test("a refused set_sessions (each bad line of mcp_token, b22 to b32) gets the fixed bad request, which echoes no field of the line, and the service and the fake keep their old snapshot", async () => {
  const strs = (x: unknown): string[] => typeof x === "string" ? [x] : Array.isArray(x) ? x.flatMap(strs) : x && typeof x === "object" ? Object.values(x).flatMap(strs) : [];
  const r3 = control.requests.find((v: any) => v.req.id === "r3").req;
  const bad = control.badRequests.filter((v: any) => v.req.op === "set_sessions" && /^b(2[2-9]|3[0-2])$/.test(v.req.id));
  assert.equal(bad.length, 11, "the bad lines b22 to b32");
  const own = { kind: "daemon", user: "ann", via: "daemon" };
  const want = r3.sessions.map((s: any) => [s.scope, s.mcp_token !== null]);
  for (const make of [stage1a, () => new FakeService({ agentDoor: AGENT_DOOR })]) {
    const d = await openDoor(make());
    try {
      const { c } = await hello(d.path);
      c.send(r3);
      assert.equal((await c.answer("r3")).ok, true);
      for (const v of bad) {
        c.send(v.req);
        const a = await c.answer(v.req.id);
        assert.deepEqual(a, v.res, v.note);
        // The scan of the answer: no scope, lifetime id, fingerprint or token of the line (each string of 4 characters or more).
        const fields = strs([v.req.sessions, v.req.remote]).filter((s) => s.length >= 4);
        for (const f of fields) assert.ok(!JSON.stringify(a).includes(f), `${v.note}: the answer holds ${f}`);
        c.send({ t: "req", id: `s-${v.req.id}`, op: "status", by: own });
        const s = (await c.answer(`s-${v.req.id}`)).data;
        assert.deepEqual(s.sessions.map((x: any) => [x.scope, x.mcp_token]), want, `${v.note}: the old snapshot stays`);
      }
      c.end();
      // No log line holds a fingerprint or a token of the vectors (C12's log rule).
      const secret = [...control.testTokens.flatMap((t: any) => [t.token, t.fingerprint]), ...bad.flatMap((v: any) => strs([v.req.sessions, v.req.remote]).filter((x) => /^[0-9a-fA-F]{63,65}$|^abt1_/.test(x)))];
      for (const l of d.logs) for (const x of secret) assert.ok(!l.includes(x), `a log line holds ${x}: ${l}`);
    } finally { await d.close(); }
  }
});

// ------------------------------------------------------------------ the line limit and the log rule

test("the line limit: a line of CONTROL_MAX_LINE bytes with its newline is read; a longer one closes the connection, also before its newline comes, and neither is logged", { timeout: 120_000 }, async () => {
  assert.equal(CONTROL_MAX_LINE, 33_619_968);
  const d = await openDoor(stage1a());
  try {
    /** A status request of `id` whose line, with its newline, has `total` bytes. */
    const sized = (id: string, total: number) => {
      const head = { t: "req", id, op: "status", by: { kind: "daemon", user: "ann", via: "daemon" }, pad: "" };
      const line = JSON.stringify({ ...head, pad: "x".repeat(total - 1 - Buffer.byteLength(JSON.stringify(head))) });
      assert.equal(Buffer.byteLength(line) + 1, total);
      return line + "\n";
    };
    const ok = await hello(d.path);
    ok.c.send(sized("big", CONTROL_MAX_LINE));
    assert.equal((await ok.c.answer("big", 30_000)).ok, true, "a line at the limit is read");
    ok.c.end();
    const over = await hello(d.path);
    over.c.send(sized("over", CONTROL_MAX_LINE + 1));
    assert.equal(await closesWithin(over.c, 30_000), true, "a line one byte longer closes the connection");
    assert.equal(over.c.lines.length, 1, "no answer");
    const open = await hello(d.path);
    open.c.send("x".repeat(CONTROL_MAX_LINE + 10));
    assert.equal(await closesWithin(open.c, 30_000), true, "a longer line closes before its newline comes");
    assert.ok(d.logs.every((l) => !l.includes("xxxxxxxx")), "no log line holds a line's content");
  } finally { await d.close(); }
});

test("the log rule: the service logs each act with its provenance, and no log line holds a field of a request (no page, cookie, URL path or payload), a line that it refused for its shape, or a lifetime id", async () => {
  const strs = (x: unknown): string[] => typeof x === "string" ? [x] : Array.isArray(x) ? x.flatMap(strs) : x && typeof x === "object" ? Object.values(x).flatMap(strs) : [];
  // Every string of a request's fields (not t, id, op or by), and of the fake's state of prompts (lifetime ids).
  const secrets = new Set<string>();
  for (const v of [...control.requests, ...control.badRequests]) {
    const { t, id, op, by, ...fields } = v.req;
    // The words of provenance are logged by design (a record file of the stored sign-ins holds "by":"operator"), and so is
    // the record's other `by`, "offer", in a fixed error text (`an offer needs a new id`, review-112).
    for (const s of strs(fields)) if (s.length >= 4 && !["operator", "offer", "token", "daemon", "config", "send"].includes(s)) secrets.add(s);
  }
  secrets.add("lt-1a2b");
  for (const make of [stage1a, () => new FakeService({ agentDoor: AGENT_DOOR })]) {
    const d = await openDoor(make());
    try {
      const { c } = await runVectors(d.path);
      c.send({ t: "req", id: "bad-shape", op: "list_set", by: { kind: "operator", user: "ann", via: "web" }, list: "secret-list-name", add: "not-a-list", remove: [] });
      await c.answer("bad-shape");
      // N8: a user with a newline or a control character is a bad request, so no log line gets it.
      for (const [id, user] of [["u1", "ann\ncontrol: forged-line"], ["u2", "ann\u0007forged-bell"]]) {
        c.send({ t: "req", id, op: "config", by: { kind: "daemon", user, via: "config" }, enabled: true, control: true, chrome_bin: null, chrome_args: [] });
        assert.deepEqual(await c.answer(id), { t: "res", id, ok: false, error: "bad request" });
      }
      c.end();
      for (const l of d.logs) for (const s of secrets) assert.ok(!l.includes(s), `a log line holds ${JSON.stringify(s)}: ${l}`);
      assert.ok(d.logs.every((l) => !l.includes("secret-list-name") && !l.includes("not-a-list")), "a refused line is never logged");
      assert.ok(d.logs.every((l) => !l.includes("forged")), "no forged log line");
      // An act is logged with its provenance; a read is not an act.
      assert.ok(d.logs.some((l) => l === "control: config by daemon ann via config: ok"), d.logs.join("\n"));
      assert.ok(d.logs.some((l) => l === "control: session_ended by daemon ann via daemon: ok"), d.logs.join("\n"));
      assert.ok(!d.logs.some((l) => / status by /.test(l)), "a read is not logged");
    } finally { await d.close(); }
  }
});

// ------------------------------------------------------------------ the event stream

test("the event stream: an event goes to each connection past the hellos, and to no connection that has not sent its hello; no event is kept for a later reader", async () => {
  const d = await openDoor(stage1a());
  try {
    const { c: a } = await hello(d.path);
    const early = await daemonClient(d.path);
    await early.next();
    await sleep(50);
    const ev = control.events[0].ev;
    assert.equal(d.door.emit(ev), 1, "one connection past the hellos");
    assert.deepEqual(await a.next((l) => l.t === "ev"), ev);
    early.send(DAEMON_HELLO);
    early.send({ t: "req", id: "z", op: "status", by: { kind: "daemon", user: "ann", via: "daemon" } });
    await early.answer("z");
    assert.deepEqual(early.lines.filter((l) => l.t === "ev"), [], "no event that came before its hello");
    assert.equal(d.door.emit(ev), 2);
    await early.next((l) => l.t === "ev");
    a.end(); early.end();
  } finally { await d.close(); }
});

// ------------------------------------------------------------------ the fake: its own rules, its standard input, --refuse

test("the fake's own rules: a start in the state off sends the vectors' first ready event, an ended scope is held until the next set_sessions, endpoint names --agent-door, and the state is the vectors'", async () => {
  assert.deepEqual(JSON.parse(JSON.stringify(FAKE_STATE)), control.state, "the fake's state is the vectors' state");
  const d = await openDoor(new FakeService({}));
  try {
    const { c } = await hello(d.path);
    const op = { kind: "operator", user: "ann", via: "web" };
    const own = { kind: "daemon", user: "ann", via: "daemon" };
    c.send({ t: "req", id: "1", op: "stop", by: op });
    await c.next((l) => l.t === "ev" && l.ev === "stopped");
    c.send({ t: "req", id: "2", op: "status", by: own });
    const s = (await c.answer("2")).data;
    assert.equal(s.state, "off");
    assert.deepEqual([s.chrome_pid, s.agent_text], [null, control.state.texts.off.agent_text]);
    assert.deepEqual(keysOf(s.last_stop), ["at", "by", "reason"]);
    assert.deepEqual([s.last_stop.reason, s.last_stop.by], ["stop", op]);
    assert.match(s.last_stop.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
    c.send({ t: "req", id: "3", op: "start", by: { kind: "token", user: "ann", via: "cli" } });
    assert.deepEqual(await c.next((l) => l.t === "ev" && l.ev === "ready"), control.events[0].ev);
    c.send({ t: "req", id: "4", op: "session_ended", by: own, scope: "web-1" });
    c.send({ t: "req", id: "5", op: "launch_check", by: own, scope: "web-1" });
    assert.equal(typeof (await c.answer("5")).data.refusal, "string");
    c.send({ ...control.requests.find((v: any) => v.req.op === "set_sessions").req, id: "6" });
    c.send({ t: "req", id: "7", op: "launch_check", by: own, scope: "web-1" });
    assert.deepEqual((await c.answer("7")).data, { refusal: null });
    c.send({ t: "req", id: "8", op: "endpoint", by: own, scope: "web-1" });
    assert.deepEqual((await c.answer("8")).data, { url: `ws+unix://${control.state.agent_door}:/devtools/browser/web-1` });
    // An allow whose host or list is not the open prompt's now: this prompt is gone, and the prompt stays open.
    for (const [id, host, list] of [["9", "other.example", "owner-repo"], ["10", "login.example", "other-repo"]]) {
      c.send({ t: "req", id, op: "prompt_allow", by: op, prompt: "p1", host, list });
      assert.deepEqual(await c.answer(id), { t: "res", id, ok: false, error: "this prompt is gone" });
    }
    c.send({ t: "req", id: "11", op: "prompt_allow", by: op, prompt: "p1", host: "login.example", list: "owner-repo" });
    assert.equal((await c.answer("11")).ok, true, "the prompt was still open");
    c.end();
  } finally { await d.close(); }
});

test("the fake sends each event line of its standard input to each connection past the hellos, and drops each other line without logging it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-fake-"));
  const input = new PassThrough();
  const logs: string[] = [];
  const fake = await startFake({ controlDoor: join(dir, "control.sock"), input, log: (l) => logs.push(l) });
  try {
    const { c } = await hello(join(dir, "control.sock"));
    await c.next((l) => l.t === "hello");
    await sleep(50);
    const bad = [
      "not json at all secret-word",
      JSON.stringify({ t: "ev", ev: "later_event", count: 1 }),
      JSON.stringify({ ...control.events[2].ev, url: "https://example.com/secret-path" }),
      JSON.stringify({ t: "req", id: "x", op: "status" }),
      JSON.stringify({ t: "ev", ev: "prompt", id: "p1" }),
    ];
    for (const l of bad) input.write(l + "\n");
    for (const { ev } of control.events) input.write(JSON.stringify(ev) + "\n");
    for (const { ev } of control.events) assert.deepEqual(await c.next((l) => l.t === "ev" && JSON.stringify(l) === JSON.stringify(ev)), ev);
    await sleep(50);
    assert.equal(c.lines.filter((l) => l.t === "ev").length, control.events.length, "only the events of the event table");
    assert.ok(logs.some((l) => /dropped a line of its standard input/.test(l)));
    assert.ok(logs.every((l) => !l.includes("secret")), logs.join("\n"));
    c.end();
  } finally { await fake.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("the fake with --refuse sends the refused line of rule 2 of the vectors and closes; the fake refuses the default path of control.sock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-fake-"));
  const fake = await startFake({ controlDoor: join(dir, "control.sock"), refuse: true, log: () => {} });
  try {
    const c = await daemonClient(join(dir, "control.sock"));
    assert.equal(await closesWithin(c), true);
    assert.deepEqual(c.lines, [control.refused.find((r: any) => /rule 2/.test(r.line.reason)).line]);
    assert.equal((statSync(join(dir, "control.sock")).mode & 0o777), 0o600, "the socket's mode");
  } finally { await fake.stop(); rmSync(dir, { recursive: true, force: true }); }
  const def = defaultControlDoor({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux", "/nonexistent-home");
  assert.equal(def, "/run/user/1000/agent-browser/control.sock");
  assert.equal(defaultControlDoor({}, "darwin", "/Users/u"), "/Users/u/.cache/agent-browser/run/control.sock");
});

test("the fake never listens in the service's run folder (B2): the run folders with and with no XDG_RUNTIME_DIR, the real folder through a link in a parent folder, and no folder made there", async () => {
  // With no XDG_RUNTIME_DIR, Linux's default run folder is /run/user/<uid>/agent-browser.
  assert.deepEqual(serviceRunFolders({}, "linux", "/h", 1234), ["/run/user/1234/agent-browser"]);
  assert.deepEqual(serviceRunFolders({ XDG_RUNTIME_DIR: "/x/run" }, "linux", "/h", 1234), ["/run/user/1234/agent-browser", "/x/run/agent-browser"]);
  assert.deepEqual(serviceRunFolders({ XDG_RUNTIME_DIR: "/x/run" }, "darwin", "/Users/u", 501), ["/Users/u/.cache/agent-browser/run"]);
  // A temp folder stands in for the run root (never the real /run/user/<uid>/agent-browser).
  const dir = mkdtempSync(join(tmpdir(), "ab-run-"));
  try {
    const root = join(dir, "run"), link = join(dir, "L");
    mkdirSync(root, { mode: 0o700 });
    symlinkSync(root, link);
    const runFolder = join(root, "agent-browser");
    for (const path of [join(runFolder, "control.sock"), join(link, "agent-browser", "control.sock"), join(link, "agent-browser", "other.sock"), join(dir, "L", ".", "agent-browser", "x.sock")]) {
      await assert.rejects(startFake({ controlDoor: path, log: () => {}, refusedFolders: [runFolder] }), /never takes the place of the service/, path);
    }
    assert.throws(() => statSync(runFolder), /ENOENT/, "no folder made in the run folder's place");
    // The run folder exists: the same check after links.
    mkdirSync(runFolder, { mode: 0o700 });
    await assert.rejects(startFake({ controlDoor: join(link, "agent-browser", "control.sock"), log: () => {}, refusedFolders: [runFolder] }), /never takes the place of the service/);
    // Another folder is fine.
    const fake = await startFake({ controlDoor: join(dir, "ok", "control.sock"), log: () => {}, refusedFolders: [runFolder] });
    await fake.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ the line rules (B1), the folder, the admission limit

test("the line rules (B1): each badLines vector closes the connection (a BOM, a CR LF, a lone surrogate's bytes); a last line with no newline before the end gets no answer and the connection closes; many lines in one read get their answers in order", async () => {
  for (const make of [stage1a, () => new FakeService({})]) {
    const d = await openDoor(make());
    try {
      for (const v of control.badLines) {
        const { c } = await hello(d.path);
        c.send(Buffer.from(v.hex, "hex"));
        assert.equal(await closesWithin(c), true, v.note);
        assert.equal(c.lines.length, 1, `${v.note}: no answer`);
      }
      // Many lines in one read: each one answered, in order.
      const many = await hello(d.path);
      const by = { kind: "daemon", user: "ann", via: "daemon" };
      many.c.send(["m1", "m2", "m3"].map((id) => JSON.stringify({ t: "req", id, op: "status", by }) + "\n").join(""));
      await many.c.answer("m3");
      assert.deepEqual(many.c.lines.filter((l) => l.t === "res").map((l) => l.id), ["m1", "m2", "m3"]);
      many.c.end();
      // A last line with no newline, then the end of the stream: no answer; the connection closes.
      const last = await hello(d.path);
      last.c.send(JSON.stringify({ t: "req", id: "tail", op: "status", by }));
      last.c.socket.end();
      assert.equal(await closesWithin(last.c), true, "the end of the stream closes the connection");
      assert.deepEqual(last.c.lines.filter((l) => l.t === "res"), [], "no answer to bytes after the last newline");
    } finally { await d.close(); }
  }
});

test("a peer that half-closes in the same write as its request gets the whole answer, also one much larger than the socket's buffer (review-102 B1)", async () => {
  const big = "x".repeat(4_000_000);
  const handler: Handler = { hello: stage1a().hello, has: (op) => op === "status", handle: () => ({ data: { big } }) };
  const d = await openDoor(handler);
  try {
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const sock = connect(d.path);
      sock.on("error", reject);
      sock.on("data", (b: Buffer) => chunks.push(b));
      sock.on("close", () => resolve(Buffer.concat(chunks)));
      // After the service's hello: the daemon's hello, one request and the end of the stream, in one write.
      sock.once("data", () => { sock.end(encodeLine(DAEMON_HELLO) + encodeLine({ t: "req", id: "big", op: "status", by: { kind: "daemon", user: "ann", via: "daemon" } })); });
    });
    const lines = bytes.toString("utf8").split("\n");
    assert.equal(lines.length, 3, "the hello, the answer, and nothing after the answer's newline");
    const res = JSON.parse(lines[1]);
    assert.equal(res.id, "big");
    assert.equal(res.data.big.length, big.length, "the whole answer");
    assert.ok(d.logs.includes("control: connection 1 closed: the end of the stream"));
  } finally { await d.close(); }
});

test("the control door's folder: a new folder gets mode 0700; a folder that the group or others can enter stops the open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-fold-"));
  try {
    const made = join(dir, "made");
    const door = await ControlDoor.open({ path: join(made, "control.sock"), admit: admitAll, handler: stage1a(), log: () => {} });
    assert.equal(statSync(made).mode & 0o777, 0o700);
    await door.stop();
    const open = join(dir, "open");
    mkdirSync(open);
    chmodSync(open, 0o755);
    // A door that opens by mistake is stopped at once, so the test fails and does not hang.
    const r = await ControlDoor.open({ path: join(open, "control.sock"), admit: admitAll, handler: stage1a(), log: () => {} })
      .then(async (d) => { await d.stop(); return "the door opened"; }, (e: Error) => e.message);
    assert.match(r, /must be a folder of this user with mode 0700/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the admission limit (N9): at most 4 connections are checked at a time; one more gets the refused line with its reason and closes; the 4 go on", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let calls = 0;
  const d = await openDoor(stage1a(), { admit: async () => { calls++; await held; return { ok: true }; } });
  try {
    const waiting = await Promise.all([1, 2, 3, 4].map(() => daemonClient(d.path)));
    await sleep(100);
    assert.equal(calls, 4);
    const over = await daemonClient(d.path);
    assert.equal(await closesWithin(over), true);
    assert.deepEqual(over.lines, [{ t: "refused", reason: "The control door checks 4 other connections now, so it refuses this one: connect again." }]);
    assert.equal(calls, 4, "the admission did not run for the fifth");
    release();
    for (const c of waiting) assert.equal((await c.next()).t, "hello");
    // The limit counts only the checks that run: a new connection is checked again.
    const after = await daemonClient(d.path);
    assert.equal((await after.next()).t, "hello");
    for (const c of [...waiting, after]) c.end();
  } finally { await d.close(); }
});
