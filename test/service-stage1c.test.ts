// Stage 1c of the self-contained agent browser (board ab-v16.94.4): the lists, the scopes, the prompts and the sign-ins
// inside `agent-browser service`, behind the receiver port (src/service/receiver.ts). The service's stage 1a handler
// runs with stage 1c's part, a fake of the receiver port and a fake clock; the last tests run it behind the real control
// door (contract C12) and against the vectors. The cases are agentwatch's reference cases of
// tests/daemon/browser/test_service.py (the push of set_scopes and the line, set_sessions, session_ended and the list
// copies, the list change, the import, on_blocked and the status of the lists), ported. Each test uses temp folders
// only: never the operator's lists, state or sockets. Every payload is a test payload made here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OPS, ControlDoor, type Admit, type Req } from "../src/service/control.ts";
import { LATER_OPS, STAGE_1B2_OPS, Stage1a, STAGE_1A_OPS } from "../src/service/service.ts";
import { STAGE_1B1_OPS } from "../src/service/unit/part.ts";
import { NO_RECEIVER, ReceiverError, type ReceiverEvents, type ReceiverPort } from "../src/service/receiver.ts";
import { AGENT_LISTS_WAIT, DISMISS_WRITE_ERROR, IMPORT_WAIT_MS, LAUNCH_HELD_TEXT, LIST_DAMAGED_ERROR, LISTS_FOLDER_TEXT, PUSH_RETRY_MS, SCOPES_ERROR_TEXT, SET_SCOPES_WAIT_MS, Stage1c, STAGE_1C_OPS, UNREAD_LIST_ERROR, UNREAD_TEXT, type Clock } from "../src/service/stage1c.ts";
import { DAMAGED_TEXT } from "../src/service/lists/lists.ts";
import type { AllowlistLine } from "../src/service/lists/scopes.ts";
import { RECEIVER_MISSING_TEXT, RECEIVER_WAIT_MS } from "../src/service/signin/send-text.ts";
import { MAX_SEND_BYTES } from "../src/service/signin/payload.ts";
import { DAEMON_HELLO, daemonClient, sleep } from "./fake-daemon.ts";

const control = JSON.parse(readFileSync(new URL("./vectors/control.json", import.meta.url), "utf8"));
const SENTINEL = "s3cr3t-SENTINEL-cookie-value-7f3a";
const STORAGE_SENTINEL = "s3cr3t-SENTINEL-storage-value-91c2";
const I2 = /\b(stop|start|restart)/i;
const OPERATOR_HINT = /(?:\bbrowser (?:stop|start)\b|\bstop and start\b|\bagentwatch restart\b)|Update it\./i;
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

/** A fake clock: its timers run only when a test moves it. */
class FakeClock implements Clock {
  t = 0;
  private n = 0;
  private readonly timers = new Map<number, { at: number; f: () => void }>();
  now() { return this.t; }
  setTimeout(f: () => void, ms: number) { const id = ++this.n; this.timers.set(id, { at: this.t + ms, f }); return id; }
  clearTimeout(h: unknown) { this.timers.delete(h as number); }
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = [...this.timers].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].f();
      await settle();
    }
    this.t = end;
    await settle();
  }
}

type Pending = { op: string; body: any; wait: number; resolve: (d: any) => void; reject: (e: Error) => void };
/** A fake of the receiver port: `mode` answers each set_scopes (ok, a refusal, a timeout, or held for the test). */
class FakeReceiver implements ReceiverPort {
  events!: ReceiverEvents;
  up = false;
  mode: "ok" | "hold" | "refuse" | "timeout" = "ok";
  importMode: "ok" | "hold" | ReceiverError = "ok";
  refused = 0;
  importCounts: Record<string, unknown> = { cookies_removed: 0, cookies_set: 4, tabs_closed: 0, local: 1, session: 1, idb_databases: 1, idb_records: 1, cache_entries: 1, errors: [] };
  readonly requests: Pending[] = [];
  readonly lines: AllowlistLine[] = [];
  readonly ends: string[] = [];
  readonly order: string[] = [];
  attach(e: ReceiverEvents) { this.events = e; }
  isUp() { return this.up; }
  request(op: "set_scopes" | "import", body: Record<string, unknown>, wait: number): Promise<Record<string, unknown>> {
    if (!this.up) return Promise.reject(new ReceiverError("down", "the agent extension is not connected"));
    return new Promise((resolve, reject) => {
      const p: Pending = { op, body: JSON.parse(JSON.stringify(body)), wait, resolve, reject };
      this.requests.push(p);
      this.order.push(op);
      const mode = op === "set_scopes" ? this.mode : this.importMode;
      if (mode === "ok") resolve(op === "set_scopes" ? { rules: 1, closed: 0, refused: this.refused } : { ...this.importCounts });
      else if (mode === "refuse") reject(new ReceiverError("refused", "tabs: not closed"));
      else if (mode === "timeout") reject(new ReceiverError("timeout", "timeout"));
      else if (mode instanceof ReceiverError) reject(mode);
    });
  }
  allowlist(line: AllowlistLine) { this.lines.push(JSON.parse(JSON.stringify(line))); this.order.push("line"); }
  endScope(scope: string) { this.ends.push(scope); this.order.push(`end ${scope}`); }
  connect() { this.up = true; this.events.up(); }
  drop() { this.up = false; this.events.down(); }
  pushes() { return this.requests.filter((r) => r.op === "set_scopes").map((r) => r.body); }
  imports() { return this.requests.filter((r) => r.op === "import"); }
}

type Rig = { dir: string; lists: string; state: string; clock: FakeClock; rx: FakeReceiver; part: Stage1c; svc: Stage1a; logs: string[]; evs: any[]; done: () => void;
  req: (op: string, fields?: Record<string, unknown>, kind?: string) => Promise<any> };
let ids = 0;
function rig(o: { receiver?: ReceiverPort; before?: (dir: string) => void; writeEnded?: (p: string, v: unknown) => void } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "ab-1c-"));
  const lists = join(dir, "config", "browser", "lists"), state = join(dir, "state");
  o.before?.(dir);
  const clock = new FakeClock(), rx = new FakeReceiver(), logs: string[] = [], evs: any[] = [];
  const part = new Stage1c({ listsFolder: lists, stateFolder: state, receiver: o.receiver ?? rx, log: (l) => logs.push(l), clock, wall: () => 1000 + clock.t / 1000, writeEnded: o.writeEnded });
  const svc = new Stage1a({ agentDoor: { url: (s) => `ws+unix:///x/cdp.sock:/devtools/browser/${s}`, state: () => ({ form: "pidfd" }) }, parts: [part] });
  svc.attach((ev) => evs.push(ev));
  const req = async (op: string, fields: Record<string, unknown> = {}, kind?: string) => {
    const k = kind ?? (OPS[op].kinds === null ? "daemon" : OPS[op].kinds![0]);
    const r = { t: "req", id: `r${++ids}`, op, by: { kind: k, user: "ann", via: k === "operator" ? "web" : "daemon" }, ...fields } as Req;
    return await svc.handle(r);
  };
  return { dir, lists, state, clock, rx, part, svc, logs, evs, req, done: () => { part.stop(); rmSync(dir, { recursive: true, force: true }); } };
}
function withRig(f: (r: Rig) => Promise<void>, o?: Parameters<typeof rig>[0]): () => Promise<void> {
  return async () => { const r = rig(o); try { await f(r); } finally { r.done(); } };
}
const sess = (scope: string, repo: string | null = "a/b", roots: [number, number][] = [[101, 5000]], lifetime_id: string | null = `lt-${scope}`, mcp_token: string | null = null) =>
  ({ scope, repo, roots: roots.map(([pid, start]) => ({ pid, start })), cgroup: null, lifetime_id, mcp_token });
const BOX = { hosts: ["box.localhost"], cookie_names: ["__Host-session"] };
const setSessions = (r: Rig, sessions: unknown[], box = BOX) => r.req("set_sessions", { sessions, remote: [], box });
const W = sess("w");
const W_BODY = { lists: { "a.b": [] as string[] }, scopes: { w: "a.b" }, default: null, operator: "*" };
const writeList = (r: Rig, name: string, body: unknown) => { mkdirSync(r.lists, { recursive: true }); writeFileSync(join(r.lists, `${name}.json`), typeof body === "string" ? body : JSON.stringify(body)); };
const ended = (r: Rig) => JSON.parse(readFileSync(join(r.state, "ended-scopes.json"), "utf8"));
const copyOf = (r: Rig, scope: string) => { const p = join(r.state, "session-lists", scope, "allowlist.json"); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; };
const status = async (r: Rig) => (await r.req("status")).data;
const filesIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
const failingDisk = (disk: { failing: boolean }) => (p: string, v: unknown) => {
  if (disk.failing) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v));
};

// ------------------------------------------------------------------ the ops and the port

test("stage 1c adds its seven ops to the service's table; start and stop come with stage 1b part 1's part, sender with stage 1b part 2's, and each op of C12 is in one place", withRig(async (r) => {
  assert.deepEqual([...STAGE_1C_OPS].sort(), ["import", "launch_check", "list_set", "lists_get", "prompt_allow", "prompt_dismiss", "prompts_get"]);
  assert.deepEqual(Object.keys(r.part.ops).sort(), [...STAGE_1C_OPS].sort());
  assert.deepEqual(Object.fromEntries(Object.entries(LATER_OPS).sort()), { sign_in_reseal: "1e1", sign_in_seal: "1e1", sign_in_start_again: "1e1", sign_ins: "1e1", sign_ins_lock: "1e1", sign_ins_rekey: "1e1", sign_ins_setup: "1e1", sign_ins_unlock: "1e1" });
  assert.deepEqual([...STAGE_1A_OPS, ...STAGE_1C_OPS, ...STAGE_1B1_OPS, ...STAGE_1B2_OPS, ...Object.keys(LATER_OPS)].sort(), Object.keys(OPS).sort());
  for (const op of STAGE_1C_OPS) assert.equal(r.svc.has(op), true, op);
  for (const op of Object.keys(LATER_OPS)) assert.equal(r.svc.has(op), false, op);
  assert.equal(new Stage1a({ agentDoor: { url: (s) => s, state: () => ({ form: "pidfd" }) } }).has("list_set"), false, "a service with no part");
}));

test("the receiver port with no native link (NO_RECEIVER, until stage 1b part 2): never up, so no object goes and the model gets no line", withRig(async (r) => {
  await setSessions(r, [W]);
  await settle();
  assert.equal(NO_RECEIVER.isUp(), false);
  await assert.rejects(NO_RECEIVER.request("set_scopes", {}, 10), (e: any) => e instanceof ReceiverError && e.kind === "down");
  assert.equal(r.part.listsConfirmed(), false);
}, { receiver: NO_RECEIVER }));

// ------------------------------------------------------------------ item 2: the scopes, the push and the line

test("no set_scopes before the first complete set_sessions (C4 rule 1); then a hello sends the book's object with C4's 10 s wait", withRig(async (r) => {
  r.rx.connect();
  await settle();
  assert.deepEqual(r.rx.requests, [], "no object before the first set_sessions");
  assert.equal(r.part.sessionsRead(), false);
  await setSessions(r, [W]);
  await settle();
  assert.equal(SET_SCOPES_WAIT_MS, 10_000);
  assert.equal(PUSH_RETRY_MS, 10_000);
  assert.deepEqual(r.rx.requests.map((x) => [x.op, x.body, x.wait]), [["set_scopes", W_BODY, 10_000]]);
  assert.equal(r.part.listsConfirmed(), true);
  assert.equal(r.part.sessionsRead(), true);
}));

test("every hello pushes the object again; zero sessions push empty objects", withRig(async (r) => {
  await setSessions(r, []);
  r.rx.connect();
  await settle();
  r.rx.drop();
  r.rx.connect();
  await settle();
  assert.deepEqual(r.rx.pushes(), [{ lists: {}, scopes: {}, default: null, operator: "*" }, { lists: {}, scopes: {}, default: null, operator: "*" }]);
}));

test("only an ok in time writes the line, with the roots; a refusal or a timeout writes none, names the error for the operator, and goes again after 10 s", async () => {
  for (const mode of ["refuse", "timeout"] as const) {
    const r = rig();
    try {
      await setSessions(r, [W]);
      r.rx.mode = mode;
      r.rx.connect();
      await settle();
      assert.deepEqual(r.rx.lines, [], mode);
      assert.equal(r.part.listsConfirmed(), false);
      const error = mode === "refuse" ? "tabs: not closed" : "timeout";
      const s = await status(r);
      assert.ok(s.operator_text.includes("The agent extension did not confirm the lists: " + error), s.operator_text);
      assert.equal(SCOPES_ERROR_TEXT.replace("{error}", error), "the agent extension did not confirm the lists: " + error);
      assert.ok(s.agent_text.includes(AGENT_LISTS_WAIT) && !s.agent_text.includes(error), "the agent's text says the lists wait, and no error text");
      await r.clock.advance(PUSH_RETRY_MS - 1);
      assert.equal(r.rx.pushes().length, 1);
      r.rx.mode = "ok";
      await r.clock.advance(1);
      assert.equal(r.rx.pushes().length, 2);
      assert.deepEqual(r.rx.lines, [{ t: "allowlist", ...W_BODY, roots: { w: [{ pid: 101, start: 5000 }] } }]);
      const s2 = await status(r);
      assert.ok(!s2.operator_text.includes("did not confirm"), "the error goes with the ok");
      assert.ok(!s2.agent_text.includes(AGENT_LISTS_WAIT));
      assert.equal(r.part.listsConfirmed(), true);
    } finally { r.done(); }
  }
});

test("a list that the receiver refuses goes again every 10 s, and a confirmation ends the retries", withRig(async (r) => {
  await setSessions(r, [W]);
  r.rx.mode = "refuse";
  r.rx.connect();
  await settle();
  await r.clock.advance(3.5 * PUSH_RETRY_MS);
  assert.equal(r.rx.pushes().length, 4, "at 0, 10, 20 and 30 s");
  r.rx.mode = "ok";
  await r.clock.advance(PUSH_RETRY_MS);
  assert.equal(r.part.listsConfirmed(), true);
  const n = r.rx.pushes().length;
  await r.clock.advance(180_000);
  assert.equal(r.rx.pushes().length, n, "no push after the ok");
}));

test("a list file that changed outside the service goes to the receiver at the next check (every 10 s while the link is up)", withRig(async (r) => {
  await setSessions(r, [W]);
  r.rx.connect();
  await settle();
  assert.equal(r.rx.pushes().length, 1);
  await r.clock.advance(PUSH_RETRY_MS);
  assert.equal(r.rx.pushes().length, 1, "nothing changed: no push");
  writeList(r, "a.b", { allow: ["hand.localhost"], repo: "a/b" });
  assert.equal(r.part.listsConfirmed(), false, "the current object is not the confirmed one");
  await r.clock.advance(PUSH_RETRY_MS);
  assert.deepEqual(r.rx.pushes().at(-1)!.lists, { "a.b": ["hand.localhost"] });
  assert.equal(r.part.listsConfirmed(), true);
}));

test("a push on its way confirms nothing; a change meanwhile waits for it, and only the newest object counts", withRig(async (r) => {
  await setSessions(r, [W]);
  r.rx.mode = "hold";
  r.rx.connect();
  await settle();
  assert.equal(r.part.listsConfirmed(), false);
  await r.req("list_set", { list: "a.b", add: ["a.example"], remove: [] });
  await r.req("list_set", { list: "a.b", add: ["b.example"], remove: [] });
  await settle();
  assert.equal(r.rx.pushes().length, 1, "one push at a time");
  r.rx.requests[0].resolve({ rules: 1, closed: 0, refused: 0 });
  await settle();
  assert.equal(r.rx.pushes().length, 2);
  assert.deepEqual(r.rx.pushes()[1].lists, { "a.b": ["a.example", "b.example"] });
  assert.equal(r.part.listsConfirmed(), false);
  r.rx.requests[1].resolve({ rules: 1, closed: 0, refused: 0 });
  await settle();
  assert.equal(r.part.listsConfirmed(), true);
  assert.deepEqual(r.rx.lines.map((l) => l.lists["a.b"]), [[], ["a.example", "b.example"]], "each ok writes its line");
}));

test("an ok after a link change writes no line: only the new link's push does", withRig(async (r) => {
  await setSessions(r, [W]);
  r.rx.mode = "hold";
  r.rx.connect();
  await settle();
  r.rx.drop();
  r.rx.mode = "ok";
  r.rx.connect();
  await settle();
  r.rx.requests[0].resolve({ rules: 1, closed: 0, refused: 0 });
  await settle();
  assert.equal(r.rx.lines.length, 1, "the line of the new link's push only");
  assert.equal(r.part.listsConfirmed(), true);
}));

test("a root change writes the last confirmed object with the new roots at once, with no new set_scopes; the same roots write nothing; before the first ok on a link nothing", withRig(async (r) => {
  await setSessions(r, [W]);
  r.rx.connect();
  await settle();
  assert.equal(r.rx.lines.length, 1);
  await setSessions(r, [sess("w", "a/b", [[101, 5000], [102, 5001]])]);
  assert.equal(r.rx.pushes().length, 1, "no new set_scopes");
  assert.deepEqual(r.rx.lines.at(-1)!.roots, { w: [{ pid: 101, start: 5000 }, { pid: 102, start: 5001 }] });
  await setSessions(r, [sess("w", "a/b", [[101, 5000], [102, 5001]])]);
  assert.equal(r.rx.lines.length, 2, "the same roots write no line");
  r.rx.drop();
  await setSessions(r, [sess("w", "a/b", [[103, 5002]])]);
  assert.equal(r.rx.lines.length, 2, "no line while the link is down");
  r.rx.mode = "hold";
  r.rx.connect();
  await settle();
  await setSessions(r, [sess("w", "a/b", [[201, 6000]])]);
  assert.equal(r.rx.lines.length, 2, "no line before the first ok of the new link");
  r.rx.requests.at(-1)!.resolve({ rules: 1, closed: 0, refused: 0 });
  await settle();
  assert.deepEqual(r.rx.lines.at(-1)!.roots, { w: [{ pid: 201, start: 6000 }] });
}));

test("a session's end: the file first, then end_scope to the model, then the push without it; the ok prunes the file", withRig(async (r) => {
  await setSessions(r, [W, sess("x", "a/b", [[104, 5003]])]);
  r.rx.connect();
  await settle();
  r.rx.order.length = 0;
  await r.req("session_ended", { scope: "x" });
  assert.equal(r.rx.order[0], "end x");
  await settle();
  assert.deepEqual(r.rx.order.slice(1), ["set_scopes", "line"]);
  assert.deepEqual(r.rx.lines.at(-1)!.scopes, { w: "a.b" });
  assert.deepEqual(ended(r), { ended: [] });
}));

test("the file of ended scopes is written before end_scope goes", async () => {
  const seen: unknown[] = [];
  const r = rig();
  try {
    await setSessions(r, [W, sess("x")]);
    r.rx.mode = "hold";
    r.rx.connect();
    await settle();
    const orig = r.rx.endScope.bind(r.rx);
    r.rx.endScope = (s) => { seen.push(ended(r)); orig(s); };
    await r.req("session_ended", { scope: "x" });
    assert.deepEqual(seen, [{ ended: ["x"] }]);
  } finally { r.done(); }
});

test("no end_scope for a scope that another live session holds, but the push still goes", withRig(async (r) => {
  await setSessions(r, [sess("x"), sess("x", "c/d", [[102, 2]]), W]);
  r.rx.connect();
  await settle();
  const n = r.rx.pushes().length;
  await r.req("session_ended", { scope: "x" });
  await settle();
  assert.deepEqual(r.rx.ends, []);
  assert.equal(r.rx.pushes().length, n + 1);
}));

test("an ok for an object from before the end writes a line without the scope; the next push goes at once", withRig(async (r) => {
  await setSessions(r, [W, sess("x", "a/b", [[104, 5003]])]);
  r.rx.mode = "hold";
  r.rx.connect();
  await settle();
  await r.req("session_ended", { scope: "x" });
  r.rx.requests[0].resolve({ rules: 1, closed: 0, refused: 0 });
  await settle();
  assert.deepEqual(r.rx.lines[0].scopes, { w: "a.b" });
  assert.deepEqual(Object.keys(r.rx.lines[0].roots!), ["w"]);
  assert.equal(r.rx.pushes().length, 2);
  r.rx.requests[1].resolve({ rules: 1, closed: 0, refused: 0 });
  await settle();
  assert.deepEqual(r.rx.lines[1].scopes, { w: "a.b" });
  assert.deepEqual(ended(r), { ended: [] });
}));

test("a freed name sends the next set_scopes at once (the restart gate and the names of the file)", async () => {
  const r = rig({ before: (dir) => { mkdirSync(join(dir, "state"), { recursive: true }); writeFileSync(join(dir, "state", "ended-scopes.json"), JSON.stringify({ ended: ["x"] })); } });
  try {
    await setSessions(r, [sess("x"), W]);
    r.rx.connect();
    await settle();
    assert.deepEqual(r.rx.pushes().map((b) => Object.keys(b.scopes).sort()), [["w"], ["w", "x"]]);
    assert.deepEqual(ended(r), { ended: [] });
  } finally { r.done(); }
});

test("a prune whose write failed goes to the receiver again after 10 s and logs that once; the fixed disk prunes and frees the name", async () => {
  const disk = { failing: true };
  const r = rig({
    before: (dir) => { mkdirSync(join(dir, "state"), { recursive: true }); writeFileSync(join(dir, "state", "ended-scopes.json"), JSON.stringify({ ended: ["x"] })); },
    writeEnded: failingDisk(disk),
  });
  try {
    await setSessions(r, [sess("x", null), W]);
    r.rx.connect();
    await settle();
    assert.deepEqual(r.rx.pushes().map((b) => Object.keys(b.scopes).sort()), [["w"]]);
    await r.clock.advance(4 * PUSH_RETRY_MS);
    assert.ok(r.rx.pushes().length >= 4);
    assert.equal(r.logs.filter((l) => /the prune of the ended names could not be written/.test(l)).length, 1);
    disk.failing = false;
    await r.clock.advance(PUSH_RETRY_MS);
    assert.deepEqual(ended(r), { ended: [] });
    assert.deepEqual(r.rx.lines.at(-1)!.scopes, { w: "a.b", x: "no-repo" });
    const n = r.rx.pushes().length;
    await r.clock.advance(3 * PUSH_RETRY_MS);
    assert.equal(r.rx.pushes().length, n);
  } finally { r.done(); }
});

test("launch_check: null for a free name; while an ended name is held in memory only (its write failed), today's refusal with the write's error", async () => {
  const disk = { failing: false };
  const r = rig({ writeEnded: failingDisk(disk) });
  try {
    await setSessions(r, [W]);
    assert.deepEqual((await r.req("launch_check", { scope: "web-3" })).data, { refusal: null });
    await r.req("session_ended", { scope: "w" });
    assert.deepEqual((await r.req("launch_check", { scope: "w" })).data, { refusal: null }, "in the file: no refusal");
    disk.failing = true;
    await setSessions(r, [sess("v")]);
    await r.req("session_ended", { scope: "v" });
    const refusal = (await r.req("launch_check", { scope: "v" })).data.refusal;
    assert.equal(refusal, LAUNCH_HELD_TEXT.replace("{name}", "v").replace("{error}", "the file of ended scopes cannot be written: ENOSPC"));
    assert.equal(refusal, "A session named v ended a moment ago, and the agent browser could not record it (the file of ended scopes cannot be written: ENOSPC). Choose another name, or wait until the agent browser confirms its lists.");
    const r6 = control.requests.find((v: any) => v.req.id === "r6").res.data.refusal;
    assert.equal(r6, LAUNCH_HELD_TEXT.replace("{name}", "web-1").replace("{error}", "the file of ended scopes cannot be written: ENOSPC"), "the vectors' r6 is the service's text (review-102 B2)");
    assert.doesNotMatch(refusal, I2, "I2: the caller is often an agent");
    disk.failing = false;
    await setSessions(r, []);
    assert.deepEqual((await r.req("launch_check", { scope: "v" })).data, { refusal: null }, "the next write holds the name");
  } finally { r.done(); }
});

test("a session whose repo the daemon cannot read yet (a repo that is no owner/repo) gets the always empty unread-repo list", withRig(async (r) => {
  writeList(r, "no-repo", { allow: ["x.example"], repo: null });
  await setSessions(r, [sess("s", ""), sess("m", null)]);
  r.rx.connect();
  await settle();
  assert.deepEqual(r.rx.pushes()[0], { lists: { "no-repo": ["x.example"], "unread-repo": [] }, scopes: { m: "no-repo", s: "unread-repo" }, default: null, operator: "*" });
  const lists = (await r.req("lists_get")).data.lists;
  assert.deepEqual(lists.find((l: any) => l.name === "unread-repo"), { name: "unread-repo", repo: null, allow: [], sessions: ["s"], error: UNREAD_TEXT });
}));

// ------------------------------------------------------------------ item 1: the lists, list_set, lists_get and the list copies

test("list_set adds and removes entries of one list (never the whole list), writes today's file, answers the list and the refused entries, and the next set_scopes carries it", withRig(async (r) => {
  await setSessions(r, [W]);
  r.rx.connect();
  await settle();
  const a = await r.req("list_set", { list: "a.b", add: ["X.com", "bad entry"], remove: [] });
  assert.deepEqual(a, { data: { allow: ["x.com"], refused: [{ entry: "bad entry", reason: "whitespace is not allowed" }] } });
  assert.deepEqual(JSON.parse(readFileSync(join(r.lists, "a.b.json"), "utf8")), { allow: ["x.com"], repo: "a/b" }, "the repo of the list's live session");
  await settle();
  assert.deepEqual(r.rx.pushes().at(-1), { ...W_BODY, lists: { "a.b": ["x.com"] } });
  assert.equal(r.part.listsConfirmed(), true);
  assert.deepEqual(await r.req("list_set", { list: "a.b", add: ["y.com"], remove: [] }), { data: { allow: ["x.com", "y.com"], refused: [] } }, "an add keeps the other entries");
  assert.deepEqual(await r.req("list_set", { list: "a.b", add: [], remove: ["x.com", "y.com"] }), { data: { allow: [], refused: [] } });
  await settle();
  assert.deepEqual(r.rx.pushes().at(-1), W_BODY);
  assert.ok(r.logs.includes("lists: list a.b changed: 1 entries, 1 refused"));
  assert.ok(r.logs.every((l) => !l.includes("bad entry") && !l.includes("x.com")), "no entry in a log line");
}));

test("list_set of no-repo writes the repo null; a list that no session uses keeps the repo null; the old single list stays as it is", withRig(async (r) => {
  mkdirSync(join(r.lists, ".."), { recursive: true });
  writeFileSync(join(r.lists, "..", "allowlist.json"), JSON.stringify({ allow: ["old.localhost"] }));
  assert.deepEqual(await r.req("list_set", { list: "no-repo", add: ["a.localhost"], remove: [] }), { data: { allow: ["a.localhost"], refused: [] } });
  assert.deepEqual(JSON.parse(readFileSync(join(r.lists, "no-repo.json"), "utf8")), { allow: ["a.localhost"], repo: null });
  await r.req("list_set", { list: "c.d", add: ["c.localhost"], remove: [] });
  assert.equal(JSON.parse(readFileSync(join(r.lists, "c.d.json"), "utf8")).repo, null);
  assert.deepEqual(JSON.parse(readFileSync(join(r.lists, "..", "allowlist.json"), "utf8")), { allow: ["old.localhost"] });
  assert.deepEqual((await r.req("lists_get")).data.old_allow, ["old.localhost"]);
}));

test("list_set refuses the unread-repo list and a list file that cannot be read (which stays as it is); a field that is not a list of text is a bad request at the door", withRig(async (r) => {
  assert.deepEqual(await r.req("list_set", { list: "unread-repo", add: ["x.example"], remove: [] }), { error: UNREAD_LIST_ERROR });
  writeList(r, "a.b", "{not json");
  assert.deepEqual(await r.req("list_set", { list: "a.b", add: ["x.example"], remove: [] }), { error: LIST_DAMAGED_ERROR.replace("{name}", "a.b") });
  assert.equal(readFileSync(join(r.lists, "a.b.json"), "utf8"), "{not json");
  assert.equal(existsSync(join(r.lists, "unread-repo.json")), false);
}));

test("lists_get: each list that has a file or that a live session uses, with its repo, its entries, its sessions and its error; the old single list read only", withRig(async (r) => {
  writeList(r, "c.d", { allow: ["c.localhost"], repo: "c/d" });
  writeList(r, "e.f", "{");
  await setSessions(r, [W, sess("v", "a/b"), sess("m", null)]);
  const d = (await r.req("lists_get")).data;
  assert.deepEqual(d, {
    lists: [
      { name: "a.b", repo: "a/b", allow: [], sessions: ["v", "w"], error: "" },
      { name: "c.d", repo: "c/d", allow: ["c.localhost"], sessions: [], error: "" },
      { name: "e.f", repo: null, allow: [], sessions: [], error: DAMAGED_TEXT },
      { name: "no-repo", repo: null, allow: [], sessions: ["m"], error: "" },
    ],
    old_allow: [],
  });
  const s = await status(r);
  assert.deepEqual(s.lists, ["a.b", "c.d", "e.f", "no-repo"]);
}));

test("a damaged list fails closed for its own repo and the push goes on; a lists folder that cannot be read makes every list empty; the operator's text names both", withRig(async (r) => {
  writeList(r, "c.d", { allow: ["c.localhost"], repo: "c/d" });
  writeList(r, "a.b", "{");
  await setSessions(r, [W, sess("v", "c/d")]);
  r.rx.connect();
  await settle();
  assert.deepEqual(r.rx.pushes()[0].lists, { "a.b": [], "c.d": ["c.localhost"] });
  assert.equal(r.part.listsConfirmed(), true);
  let s = await status(r);
  assert.ok(s.operator_text.includes(`List a.b: ${DAMAGED_TEXT}.`), s.operator_text);
  assert.ok(!s.agent_text.includes(DAMAGED_TEXT));
  rmSync(r.lists, { recursive: true });
  writeFileSync(r.lists, "x");
  await setSessions(r, [W, sess("v", "c/d")]); // the object changed (its lists read empty now): it goes
  await settle();
  s = await status(r);
  assert.ok(s.operator_text.includes(LISTS_FOLDER_TEXT.replace("{kind}", "ENOTDIR").replace(/^./, (c) => c.toUpperCase())), s.operator_text);
  assert.deepEqual(r.rx.pushes().at(-1)?.lists ?? {}, { "a.b": [], "c.d": [] }, "every list applies as empty");
}));

test("the list copy of each named scope whose list has a file: written at set_sessions and at each list change, none for a list with no file, removed at the scope's end", withRig(async (r) => {
  writeList(r, "a.b", { allow: ["a.example"], repo: "a/b" });
  await setSessions(r, [W, sess("m", null)]);
  assert.deepEqual(copyOf(r, "w"), { allow: ["a.example"] });
  assert.equal(copyOf(r, "m"), null, "no-repo has no file: no copy");
  await r.req("list_set", { list: "a.b", add: ["b.example"], remove: [] });
  assert.deepEqual(copyOf(r, "w"), { allow: ["a.example", "b.example"] });
  await r.req("list_set", { list: "no-repo", add: ["n.example"], remove: [] });
  assert.deepEqual(copyOf(r, "m"), { allow: ["n.example"] });
  await r.req("session_ended", { scope: "w" });
  assert.equal(existsSync(join(r.state, "session-lists", "w")), false);
  assert.deepEqual(copyOf(r, "m"), { allow: ["n.example"] }, "no other copy goes");
}));

test("a copy goes when its scope's list has no file any more or its scope leaves the object, so the CLI never reads an old list's hosts (review-102 note 5)", withRig(async (r) => {
  writeList(r, "a.b", { allow: ["a.example"], repo: "a/b" });
  await setSessions(r, [W, sess("v")]);
  assert.deepEqual(copyOf(r, "w"), { allow: ["a.example"] });
  assert.deepEqual(copyOf(r, "v"), { allow: ["a.example"] });
  await setSessions(r, [sess("w", "c/d"), sess("v")]); // w's list is now c.d, which has no file
  assert.equal(copyOf(r, "w"), null, "a list with no file: no copy");
  assert.deepEqual(copyOf(r, "v"), { allow: ["a.example"] }, "no other copy goes");
  await setSessions(r, [sess("w", "c/d")]); // v leaves the object with no session_ended
  assert.equal(copyOf(r, "v"), null, "a scope out of the object: no copy");
  await setSessions(r, [W]);
  assert.deepEqual(copyOf(r, "w"), { allow: ["a.example"] }, "back on a list with a file: the copy again");
}));

test("the end of a name that another live session holds keeps its copy; an end before the first complete read removes no copy", async () => {
  const pre = (dir: string) => { mkdirSync(join(dir, "state", "session-lists", "x"), { recursive: true }); writeFileSync(join(dir, "state", "session-lists", "x", "allowlist.json"), "{}"); };
  let r = rig({ before: pre });
  try {
    await r.req("session_ended", { scope: "x" });
    assert.equal(existsSync(join(r.state, "session-lists", "x", "allowlist.json")), true, "before the first complete read");
    await setSessions(r, [sess("x"), sess("x", "c/d")]);
    await r.req("session_ended", { scope: "x" });
    assert.equal(existsSync(join(r.state, "session-lists", "x", "allowlist.json")), true, "a live session holds the name");
    await setSessions(r, []);
    await r.req("session_ended", { scope: "x" });
    assert.equal(existsSync(join(r.state, "session-lists", "x")), false);
  } finally { r.done(); }
});

// ------------------------------------------------------------------ item 3: the blocked-site prompts

async function blockedRig(r: Rig) {
  writeList(r, "a.b", { allow: ["app.example"], repo: "a/b" });
  await setSessions(r, [sess("worker", "a/b", [[101, 1]], "life1"), sess("w2", "a/b", [[102, 2]], null)]);
  r.rx.connect();
  await settle();
}

test("a blocked report makes one prompt with its list, its warnings and its recipients; the prompt event goes on the control door; prompts_get and status hold it", withRig(async (r) => {
  await blockedRig(r);
  r.rx.events.blocked({ host: "accounts.google.com", scope: "worker", from: "app.example" });
  const [p] = (await r.req("prompts_get")).data.prompts;
  assert.deepEqual(p, { id: p.id, host: "accounts.google.com", list: "a.b", repo: "a/b", scopes: ["worker"], from: "app.example",
    warnings: [{ kind: "shared", text: p.warnings[0].text }], recipients: [{ session: "worker", lifetime_id: "life1" }] });
  assert.deepEqual(r.evs, [{ t: "ev", ev: "prompt", id: p.id, state: "open", host: "accounts.google.com", scope: "worker", list: "a.b", from: "app.example", warnings: p.warnings }]);
  assert.deepEqual((await status(r)).prompts, [p]);
  assert.ok((await status(r)).operator_text.includes("1 blocked site waits for your answer on the Browser page."));
  assert.ok(!(await status(r)).agent_text.includes("blocked site"));
  assert.ok(r.logs.includes("prompts: blocked a navigation to accounts.google.com"));
}));

test("the recipients: the session that a block stopped with the lifetime id of its run then; a later run's block adds its own; a null lifetime id is still a recipient", withRig(async (r) => {
  await blockedRig(r);
  r.rx.events.blocked({ host: "blocked.example", scope: "worker", from: null });
  await setSessions(r, [sess("worker", "a/b", [[201, 3]], "life2"), sess("w2", "a/b", [[102, 2]], null)]);
  await r.clock.advance(10_000);
  r.rx.events.blocked({ host: "blocked.example", scope: "worker", from: null });
  await r.clock.advance(10_000);
  r.rx.events.blocked({ host: "blocked.example", scope: "w2", from: null });
  const [p] = (await r.req("prompts_get")).data.prompts;
  assert.deepEqual(p.recipients, [{ session: "worker", lifetime_id: "life1" }, { session: "worker", lifetime_id: "life2" }, { session: "w2", lifetime_id: null }]);
  assert.ok(r.logs.every((l) => !l.includes("life1") && !l.includes("life2")), "no lifetime id in a log line");
}));

test("no prompt for a host that the list covers, a scope with no list now, or a report within 10 s of the last one of its host (across sources)", withRig(async (r) => {
  await blockedRig(r);
  r.rx.events.blocked({ host: "www.app.example", scope: "worker", from: null });
  r.rx.events.blocked({ host: "x.example", scope: "nobody", from: null });
  r.rx.events.blocked({ host: "y.example", scope: null, from: null });
  assert.deepEqual((await r.req("prompts_get")).data.prompts, []);
  r.clock.t += 10_000;
  r.rx.events.blocked({ host: "y.example", scope: "worker", from: "listed.example" });
  r.clock.t += 6000;
  r.rx.events.blocked({ host: "y.example", scope: "w2", from: null }); // the model's daemon.blocked: dropped by the limit
  const [p] = (await r.req("prompts_get")).data.prompts;
  assert.deepEqual(p.scopes, ["worker"]);
}));

test("prompt_allow adds the prompt's host to its list as a list_set does, closes the prompt with its event, and the next set_scopes carries it", withRig(async (r) => {
  await blockedRig(r);
  r.rx.events.blocked({ host: "login.example", scope: "worker", from: null });
  const [p] = (await r.req("prompts_get")).data.prompts;
  r.evs.length = 0;
  const a = await r.req("prompt_allow", { prompt: p.id, host: "login.example", list: "a.b" });
  assert.deepEqual(a, { data: { allow: ["app.example", "login.example"], refused: [] } });
  assert.deepEqual(r.evs, [{ t: "ev", ev: "prompt", id: p.id, state: "closed", host: "login.example", scope: "worker", list: "a.b", from: null, warnings: [] }]);
  assert.deepEqual((await r.req("prompts_get")).data.prompts, []);
  await settle();
  assert.deepEqual(r.rx.pushes().at(-1)!.lists["a.b"], ["app.example", "login.example"]);
}));

test("prompt_allow of a prompt that the service does not know, or whose host or list is not the one that the operator saw, is this prompt is gone; nothing changes", withRig(async (r) => {
  await blockedRig(r);
  r.rx.events.blocked({ host: "login.example", scope: "worker", from: null });
  const [p] = (await r.req("prompts_get")).data.prompts;
  for (const f of [{ prompt: "p-gone", host: "login.example", list: "a.b" }, { prompt: p.id, host: "other.example", list: "a.b" }, { prompt: p.id, host: "login.example", list: "c.d" }]) {
    assert.deepEqual(await r.req("prompt_allow", f), { error: "this prompt is gone" }, JSON.stringify(f));
  }
  assert.deepEqual(JSON.parse(readFileSync(join(r.lists, "a.b.json"), "utf8")).allow, ["app.example"]);
  assert.equal((await r.req("prompts_get")).data.prompts.length, 1);
}));

test("prompt_dismiss closes the prompt, and its host stays dismissed for that list (the dismissals file in the state folder); an unknown prompt is gone", withRig(async (r) => {
  await blockedRig(r);
  r.rx.events.blocked({ host: "login.example", scope: "worker", from: null });
  const [p] = (await r.req("prompts_get")).data.prompts;
  r.evs.length = 0;
  assert.deepEqual(await r.req("prompt_dismiss", { prompt: p.id }), { data: {} });
  assert.deepEqual(r.evs.map((e) => [e.state, e.id]), [["closed", p.id]]);
  assert.deepEqual(await r.req("prompt_dismiss", { prompt: p.id }), { error: "this prompt is gone" });
  r.clock.t += 10_000;
  r.rx.events.blocked({ host: "login.example", scope: "worker", from: null });
  assert.deepEqual((await r.req("prompts_get")).data.prompts, [], "dismissed");
  assert.ok(existsSync(join(r.state, "prompt-dismissals.json")));
}));

test("a dismissal that cannot be written is an error, and the prompt stays open", withRig(async (r) => {
  await blockedRig(r);
  r.rx.events.blocked({ host: "login.example", scope: "worker", from: null });
  const [p] = (await r.req("prompts_get")).data.prompts;
  mkdirSync(join(r.state, "prompt-dismissals.json"), { recursive: true }); // a folder in its place: the rename fails
  const a = await r.req("prompt_dismiss", { prompt: p.id });
  assert.match(a.error, new RegExp("^" + DISMISS_WRITE_ERROR.replace("{kind}", "E[A-Z]+") + "$"));
  assert.equal((await r.req("prompts_get")).data.prompts.length, 1);
}));

test("a list change that covers a prompt's host, or the end of its scope's session, closes the prompt with its event", withRig(async (r) => {
  await blockedRig(r);
  r.rx.events.blocked({ host: "a.login.example", scope: "worker", from: null });
  r.clock.t += 10_000;
  r.rx.events.blocked({ host: "b.example", scope: "w2", from: null });
  r.evs.length = 0;
  await r.req("list_set", { list: "a.b", add: ["login.example"], remove: [] });
  assert.deepEqual(r.evs.map((e) => [e.state, e.host]), [["closed", "a.login.example"]]);
  await r.req("session_ended", { scope: "w2" });
  assert.deepEqual(r.evs.map((e) => [e.state, e.host]), [["closed", "a.login.example"], ["closed", "b.example"]]);
  assert.deepEqual((await r.req("prompts_get")).data.prompts, []);
}));

// ------------------------------------------------------------------ item 4: the sign-in import (C2 to C6)

const cookie = (over: Record<string, unknown> = {}) => ({ name: "sid", value: SENTINEL, domain: ".site.localhost", hostOnly: false, path: "/", secure: true, httpOnly: true, sameSite: "lax", session: false, expirationDate: 1893456000.5, ...over });
const payload = (over: Record<string, unknown> = {}) => ({
  v: 1, domain: "site.localhost", url: "https://www.site.localhost/app/private-path?x=1", origin: "https://www.site.localhost",
  cookies: [cookie(), cookie({ name: "__Host-session" }), cookie({ name: "agentwatch_board" })],
  storage: { local: { token: STORAGE_SENTINEL }, session: {}, idb: [], caches: [] }, ...over,
});

test("import checks the payload, drops the box's own cookies (set_sessions' box), sends C4's import with its 120 s wait, and answers C4's counts; nothing is written to disk and no log line holds the payload", withRig(async (r) => {
  await setSessions(r, [W]);
  r.rx.connect();
  await settle();
  const before = filesIn(r.state);
  const a = await r.req("import", { payload: payload() });
  assert.deepEqual(a, { data: r.rx.importCounts });
  const [imp] = r.rx.imports();
  assert.equal(imp.wait, IMPORT_WAIT_MS);
  assert.equal(IMPORT_WAIT_MS, 120_000);
  assert.deepEqual(imp.body.state.cookies.map((c: any) => c.name), ["sid"], "the box's cookie names and agentwatch's prefix drop");
  assert.equal(imp.body.state.cookies[0].value, SENTINEL, "the payload reaches the receiver");
  assert.deepEqual(Object.keys(imp.body.state).sort(), ["cookies", "domain", "origin", "storage", "url", "v"]);
  assert.deepEqual(filesIn(r.state), before, "no file");
  const text = r.logs.join("\n");
  for (const s of [SENTINEL, STORAGE_SENTINEL, "private-path", "__Host-session", "agentwatch_board"]) assert.ok(!text.includes(s), s);
  assert.ok(r.logs.some((l) => l.startsWith("signin: imported a sign-in for site.localhost: 4 cookies set, 2 box cookies dropped")), text);
  assert.deepEqual(r.rx.pushes().at(-1), W_BODY, "a send adds its site to no list");
  assert.equal(existsSync(join(r.lists, "site.localhost.json")), false);
}));

test("an import with errors in its counts sends the error event: op, user, domain and the count of errors, never a cookie or a store name", withRig(async (r) => {
  await setSessions(r, [W]);
  r.rx.connect();
  r.rx.importCounts = { ...r.rx.importCounts, errors: ["sid: bad value", "store x: failed"] };
  await r.req("import", { payload: payload() });
  assert.deepEqual(r.evs.filter((e) => e.ev === "error"), [{ t: "ev", ev: "error", op: "import", user: "ann", domain: "site.localhost", counts: { errors: 2 } }]);
}));

test("a failed import answers the Browser pane's text of the send: a step after the swap, the swap, a step before it, a timeout, a drop, and a link that is gone", withRig(async (r) => {
  await setSessions(r, [W]);
  r.rx.connect();
  await settle();
  const cases: [ReceiverError, string][] = [
    [new ReceiverError("refused", "write storage"), 'The sign-in for site.localhost was sent, but the import did not complete: the step "write storage" failed after the cookies were set, so the site\'s page storage can be missing.'],
    [new ReceiverError("refused", "cookies"), 'The sign-in for site.localhost failed during the step "cookies": its cookies in the agent browser can be partly replaced. Send it again.'],
    [new ReceiverError("refused", "close tabs"), 'The sign-in for site.localhost was not sent: the step "close tabs" failed (a page of the site stayed open). Nothing changed.'],
    [new ReceiverError("timeout"), "The agent browser did not answer the sign-in for site.localhost in time: it can be sent in part or in full."],
    [new ReceiverError("dropped"), "The agent browser did not answer the sign-in for site.localhost in time: it can be sent in part or in full."],
    [new ReceiverError("down"), "The sign-in for site.localhost was not sent: the agent extension is not connected."],
  ];
  for (const [e, text] of cases) {
    r.rx.importMode = e;
    assert.deepEqual(await r.req("import", { payload: payload() }), { error: text }, `${e.kind} ${e.message}`);
  }
  assert.ok(!filesIn(r.lists).includes("site.localhost.json"));
}));

test("an import waits at most 45 s for the receiver's hello: a hello at 30 s imports; none says the extension did not connect", withRig(async (r) => {
  await setSessions(r, [W]);
  assert.equal(RECEIVER_WAIT_MS, 45_000);
  const late = r.req("import", { payload: payload() });
  await settle();
  await r.clock.advance(30_000);
  r.rx.connect();
  assert.deepEqual(await late, { data: r.rx.importCounts });
  r.rx.drop();
  const none = r.req("import", { payload: payload() });
  await settle();
  await r.clock.advance(44_999);
  assert.equal(r.rx.imports().length, 1);
  await r.clock.advance(1);
  assert.deepEqual(await none, { error: `The sign-in for site.localhost was not sent: ${RECEIVER_MISSING_TEXT.replace(/^The/, "the").replace(/\.$/, "")}.` });
}));

test("an import needs no list push: it goes when set_scopes fails", withRig(async (r) => {
  await setSessions(r, [W]);
  r.rx.mode = "timeout";
  r.rx.connect();
  await settle();
  assert.deepEqual(await r.req("import", { payload: payload() }), { data: r.rx.importCounts });
}));

test("an import before set_sessions, or with no box host, is refused (field box_hosts); a payload over the limit is too large; a send of the box's domain is refused; none reaches the receiver", withRig(async (r) => {
  r.rx.connect();
  assert.deepEqual(await r.req("import", { payload: payload() }), { error: "the sign-in send is not valid (field box_hosts)" });
  await setSessions(r, [W], { hosts: [], cookie_names: [] });
  assert.deepEqual(await r.req("import", { payload: payload() }), { error: "the sign-in send is not valid (field box_hosts)" });
  await setSessions(r, [W], { hosts: ["www.site.localhost"], cookie_names: [] });
  assert.deepEqual(await r.req("import", { payload: payload() }), { error: "the sign-in send is not valid (field domain)" });
  await setSessions(r, [W]);
  const big = payload();
  (big.storage.local as any).pad = "x".repeat(MAX_SEND_BYTES);
  assert.deepEqual(await r.req("import", { payload: big }), { error: `a sign-in send is at most ${MAX_SEND_BYTES} bytes` });
  assert.deepEqual(await r.req("import", { payload: { ...payload(), cookies: [cookie({ value: 5 })] } }), { error: "the sign-in send is not valid (field cookies[0].value)" });
  assert.equal(r.rx.imports().length, 0);
}));

test("sends run one at a time: the second waits for the first", withRig(async (r) => {
  await setSessions(r, [W]);
  r.rx.connect();
  await settle();
  r.rx.importMode = "hold";
  const first = r.req("import", { payload: payload() });
  const second = r.req("import", { payload: payload() });
  await settle();
  assert.equal(r.rx.imports().length, 1);
  r.rx.imports()[0].reject(new ReceiverError("refused", "cookies"));
  assert.match((await first).error, /failed during the step "cookies"/);
  await settle();
  assert.equal(r.rx.imports().length, 2);
  r.rx.imports()[1].resolve({ ...r.rx.importCounts });
  assert.deepEqual(await second, { data: r.rx.importCounts });
}));

// ------------------------------------------------------------------ item 5: the status texts (I2)

test("status with stage 1c: C12's keys, the sessions with the list that the object gives them (null while it gives none), the lists and the prompts; no agent's text names a stop or a start (I2)", withRig(async (r) => {
  // m has a fingerprint (the token design): status says true, and never gives the fingerprint.
  const m = sess("m", null, undefined, undefined, "a".repeat(64));
  await setSessions(r, [W, m]);
  await setSessions(r, [W, m, sess("z", "c/d")]); // z is a launch: the gate holds it
  const s = await status(r);
  assert.deepEqual(Object.keys(s).sort(), ["agent_text", "chrome_kind", "chrome_pid", "chrome_version", "endpoint", "extension_version", "last_stop", "lists", "mcp", "operator_text", "prompts", "sessions", "state", "update"]);
  assert.deepEqual(s.sessions, [{ scope: "w", repo: "a/b", list: "a.b", mcp_token: false }, { scope: "m", repo: null, list: "no-repo", mcp_token: true }, { scope: "z", repo: "c/d", list: null, mcp_token: false }]);
  assert.ok(!JSON.stringify(s).includes("a".repeat(64)), "status gives no fingerprint");
  // Each note that the part can add: no agent's note names a stop or a start, and the operator's notes stay out of the agent's text.
  r.rx.mode = "refuse";
  r.rx.connect();
  writeList(r, "a.b", "{");
  r.rx.events.blocked({ host: "x.example", scope: "w", from: null });
  await settle();
  const t = await status(r);
  assert.doesNotMatch(t.agent_text, I2);
  assert.doesNotMatch(t.agent_text, OPERATOR_HINT);
  assert.doesNotMatch(AGENT_LISTS_WAIT, I2);
  for (const n of r.part.notes().operator) assert.ok(!t.agent_text.includes(n), n);
  assert.ok(t.agent_text.startsWith("The agent browser is not running."));
  assert.ok(t.operator_text.startsWith("The agent browser is not running:"));
}));

// ------------------------------------------------------------------ the control door: the vectors, the half-close and the log rule

const admitAll: Admit = async () => ({ ok: true });
async function doorRig(o: { receiver?: ReceiverPort } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ab-1c-door-"));
  const lists = join(dir, "config", "browser", "lists");
  mkdirSync(lists, { recursive: true });
  writeFileSync(join(lists, "owner-repo.json"), JSON.stringify({ allow: ["a.example", "old.example"], repo: null }));
  const logs: string[] = [];
  const part = new Stage1c({ listsFolder: lists, stateFolder: join(dir, "state"), receiver: o.receiver ?? NO_RECEIVER, log: (l) => logs.push(l) });
  const svc = new Stage1a({ agentDoor: { url: (s) => `ws+unix:///run/user/1000/agent-browser/cdp.sock:/devtools/browser/${s}`, state: () => ({ form: "pidfd" }) }, parts: [part] });
  const path = join(dir, "control.sock");
  const door = await ControlDoor.open({ path, admit: admitAll, handler: svc, log: (l) => logs.push(l) });
  const c = await daemonClient(path);
  await c.next();
  c.send(DAEMON_HELLO);
  return { dir, logs, c, close: async () => { part.stop(); await door.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test("the stage 1c service behind the control door: the vectors of its ops that its own state can give (r5, r7, the kinds, the gone prompts, the old form of list_set) get the vectors' answers, and its reads have C12's keys", async () => {
  const d = await doorRig();
  try {
    const want = new Map<string, any>();
    for (const v of [...control.requests, ...control.badRequests]) if (["r3", "r5", "r7", "b1", "b2", "b3", "b10", "b12", "b13", "b14"].includes(v.req.id)) want.set(v.req.id, v.res);
    for (const v of [...control.requests, ...control.badRequests]) if (want.has(v.req.id)) d.c.send(v.req);
    for (const [id, res] of want) assert.deepEqual(await d.c.answer(id), res, id);
    for (const [id, op, keys] of [["q2", "lists_get", ["lists", "old_allow"]], ["q3", "prompts_get", ["prompts"]]] as const) {
      d.c.send(control.requests.find((v: any) => v.req.id === id).req);
      const a = await d.c.answer(id);
      assert.equal(a.ok, true, op);
      assert.deepEqual(Object.keys(a.data).sort(), [...keys].sort(), op);
    }
    const lists = (await d.c.answer("q2")).data.lists;
    assert.deepEqual(lists.map((l: any) => Object.keys(l).sort()), lists.map(() => ["allow", "error", "name", "repo", "sessions"]));
    d.c.end();
  } finally { await d.close(); }
});

test("a peer that half-closes after its import still gets the answer, then the door closes (the import answers later)", async () => {
  const rx = new FakeReceiver();
  rx.importMode = "hold";
  const d = await doorRig({ receiver: rx });
  try {
    d.c.send({ t: "req", id: "s", op: "set_sessions", by: { kind: "daemon", user: "ann", via: "daemon" }, sessions: [W], remote: [], box: BOX });
    await d.c.answer("s");
    rx.connect();
    d.c.send({ t: "req", id: "i", op: "import", by: { kind: "operator", user: "ann", via: "send" }, payload: payload() });
    d.c.send({ t: "req", id: "st", op: "status", by: { kind: "daemon", user: "ann", via: "daemon" } });
    assert.equal((await d.c.answer("st")).ok, true, "a later request gets its answer while the import waits");
    d.c.socket.end();
    await sleep(100);
    assert.equal(d.c.isClosed(), false, "the door waits for the answer it owes");
    rx.imports()[0].resolve({ ...rx.importCounts });
    assert.deepEqual(await d.c.answer("i"), { t: "res", id: "i", ok: true, data: rx.importCounts });
    await d.c.closed;
    assert.ok(d.logs.includes("control: import by operator ann via send: ok"));
  } finally { await d.close(); }
});

test("an import whose answer holds errors: the error event goes out before the import's answer line (C12, the error event; review-102 note 1)", async () => {
  const rx = new FakeReceiver();
  rx.importCounts = { ...rx.importCounts, errors: ["e1", "e2"] };
  const d = await doorRig({ receiver: rx });
  try {
    d.c.send({ t: "req", id: "s", op: "set_sessions", by: { kind: "daemon", user: "ann", via: "daemon" }, sessions: [W], remote: [], box: BOX });
    await d.c.answer("s");
    rx.connect();
    d.c.send({ t: "req", id: "i", op: "import", by: { kind: "operator", user: "ann", via: "send" }, payload: payload() });
    assert.equal((await d.c.answer("i")).ok, true);
    const at = (want: (l: any) => boolean) => d.c.lines.findIndex(want);
    const ev = at((l) => l.t === "ev" && l.ev === "error" && l.op === "import");
    assert.ok(ev >= 0, "the error event");
    assert.ok(ev < at((l) => l.t === "res" && l.id === "i"), "before the import's answer");
    d.c.end();
  } finally { await d.close(); }
});

test("the log rule: no log line of stage 1c holds a cookie or storage value, a URL path, a lifetime id, a refused entry or a list entry of an act", async () => {
  const rx = new FakeReceiver();
  const d = await doorRig({ receiver: rx });
  try {
    const by = { kind: "daemon", user: "ann", via: "daemon" }, op = { kind: "operator", user: "ann", via: "web" };
    d.c.send({ t: "req", id: "s", op: "set_sessions", by, sessions: [sess("web-1", "owner/repo", [[3100, 6000]], "lt-secret-1"), sess("web-2", null, [[3200, 6100]], "lt-secret-2")], remote: [], box: BOX });
    await d.c.answer("s");
    rx.connect();
    await settle();
    rx.events.blocked({ host: "blocked.example", scope: "web-1", from: null });
    d.c.send({ t: "req", id: "l", op: "list_set", by: op, list: "owner.repo", add: ["kept-entry.example", "https://refused-entry/x"], remove: ["gone-entry.example"] });
    d.c.send({ t: "req", id: "i", op: "import", by: { ...op, via: "send" }, payload: payload() });
    d.c.send({ t: "req", id: "e", op: "session_ended", by, scope: "web-2" });
    for (const id of ["l", "i", "e"]) await d.c.answer(id);
    const text = d.logs.join("\n");
    for (const s of [SENTINEL, STORAGE_SENTINEL, "private-path", "lt-secret-1", "lt-secret-2", "kept-entry", "refused-entry", "gone-entry"]) assert.ok(!text.includes(s), `a log line holds ${s}:\n${text}`);
    assert.ok(d.logs.includes("control: list_set by operator ann via web: ok"));
    d.c.end();
  } finally { await d.close(); }
});
