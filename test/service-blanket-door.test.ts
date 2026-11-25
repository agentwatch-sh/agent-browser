// The blanket profile through the real service (board ab-4wh.3; C12 and C11, the blanket profile): the service on the
// fake unit world, with its two links and a host that gives each fake Chrome a shim on its own link (the main Chrome's on
// link.sock, the blanket Chrome's on link-blanket.sock), each shim with a fake receiver behind it. A use of the blanket
// scope at the same endpoint URL starts the blanket Chrome on its own folder and reaches only the blanket Chrome's
// receiver; another scope reaches only the main one; the main object never names the blanket scope, and only the
// blanket link gets "*". The scope's end stops the blanket Chrome and deletes its folder; the service's start deletes a
// folder of an earlier run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { CDPConnection } from "../src/cdp.ts";
import { NOT_READY } from "../src/relay/model.ts";
import { startService, type ServiceOptions } from "../src/service/service.ts";
import { ControlDoor } from "../src/service/control.ts";
import type { UnitState } from "../src/service/unit/owner.ts";
import { BLANKET_FEATURE } from "../src/service/blanket/part.ts";
import { FakeReceiver, raw, until } from "./fake-bridge.ts";
import { DAEMON_HELLO, daemonClient } from "./fake-daemon.ts";
import { sessionRefusal, type PeerReader } from "../src/relay/peer.ts";
import { WHY } from "../src/service/link/peer.ts";
import { procReader, type McpReader } from "../src/service/mcp/proc.ts";
import { FakeTools, World } from "./fake-unit-world.ts";
import { tempDir } from "./temp-dirs.ts";

const DAEMON = { kind: "daemon", user: "ann", via: "daemon" };
/** The pid of each shim for the blanket link's real peer check. */
const SHIM_PID = 4242;
const CONFIG = { t: "req", id: "cfg", op: "config", by: { kind: "daemon", user: "ann", via: "config" }, enabled: true, control: true, chrome_bin: "/usr/bin/chromium", chrome_args: [] };
const ACTIVE: UnitState = { active: "active", sub: "running", mainPid: process.pid };
const startOf = (pid: number | "self") => { const st = readFileSync(`/proc/${pid}/stat`, "latin1"); return Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[19]); };
const myStart = () => startOf("self");
const me = () => [{ pid: process.pid, start: myStart() }];
/** The root of this process's parent: a session whose root is above this process's own session (a nested session). */
const myParent = () => [{ pid: process.ppid, start: startOf(process.ppid) }];
/** A session's item; `gone`: a root that is gone (this process is in one session only: the session check of C11). */
const session = (scope: string, extra: object = {}, gone = false) => ({ scope, repo: "owner/repo", roots: gone ? [{ pid: 999_999, start: 1 }] : me(), cgroup: null, lifetime_id: null, mcp_token: null, ...extra });

/** A shim on `path` for a fake Chrome: its hello with `features`, a fake receiver behind its bridge, set_scopes answered ok. */
function shimOn(path: string, features: string[]) {
  const fr = new FakeReceiver();
  const s = connect(path);
  const main: any[] = [];
  s.on("error", () => {});
  let buf = "";
  const open = new Map<string, Buffer[]>();
  s.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0;) {
      const p = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      const key = `${p.ch ?? "main"} ${p.id}`;
      const parts = open.get(key) ?? []; parts.push(Buffer.from(p.b64, "base64")); open.set(key, parts);
      if (parts.length < p.n) continue;
      open.delete(key);
      const q = JSON.parse(Buffer.concat(parts).toString("utf8"));
      if (p.ch === "bridge") { fr.output.write(`${JSON.stringify(q)}\n`); continue; }
      main.push(q);
      if (!s.destroyed) s.write(`${JSON.stringify({ t: "res", id: q.id, ok: true, data: q.op === "set_scopes" ? { rules: 1, closed: 0, refused: 0 } : {} })}\n`);
    }
  });
  fr.input.on("data", (d) => { if (!s.destroyed) s.write(d); });
  s.once("connect", () => s.write(`${JSON.stringify({ t: "hello", v: 2, version: "0.3.16", channels: ["main", "bridge"], features })}\n`));
  return { s, fr, main };
}

async function svc(t: { after: (f: () => Promise<void> | void) => void }, o: { blanketFeatures?: string[]; before?: (state: string) => void; mcp?: ServiceOptions["mcp"] } = {}) {
  const w = new World();
  const dir = tempDir("ab-blanket-door-");
  mkdirSync(join(dir, "lists"));
  writeFileSync(join(dir, "lists", "owner.repo.json"), JSON.stringify({ allow: ["a.example"], repo: "owner/repo" }));
  o.before?.(w.paths.state);
  const tools = new FakeTools();
  const logs: string[] = [];
  // The blanket link's REAL peer check (link/peer.ts, as the service wires it: the blanket Chrome's pid, start time and
  // profile) over a reader of the fake world: each shim is SHIM_PID, and its parent is `peerOf.parent` (the host sets it to
  // the blanket Chrome that it makes the shim for). The main link keeps the faked check of service-use.test.ts.
  const peerOf = { parent: 0 };
  const peerReader: PeerReader = {
    form: "stat", peer: () => ({ pid: SHIM_PID, uid: w.uid, pidfd: null, start: 77 }),
    proc: (pid) => (pid === SHIM_PID ? { ppid: peerOf.parent, start: 77, state: "S" } : w.procs.stat(pid)),
    cgroup: () => null, poll: () => 0, fdinfoPid: () => null, close: () => {},
  };
  const s = await startService({
    agentDoor: join(dir, "cdp.sock"), controlDoor: join(dir, "control.sock"), daemonCommand: join(dir, "daemon-command.json"), log: (l) => logs.push(l), mainPid: async () => null,
    lists: { listsFolder: join(dir, "lists"), stateFolder: w.paths.state },
    unit: { paths: w.paths, owner: async () => ACTIVE, tools, procs: w.procs, part: { unit: w.deps(tools), firstCheckMs: 3_600_000, usePollMs: 5, watchMs: 20 } },
    link: { socket: join(dir, "link.sock"), pidfds: { failed: "none" }, xdotool: null, peer: async () => ({ ok: true as const, pid: 4242 }) },
    // No DNS in a unit test: the address rule's own tests are test/blanket-scope.test.ts's and test/page-fetch*.
    blanket: { chrome: { spawn: (a, e) => w.spawn(a, e), kill: (p, sig) => w.kill(p, sig), clock: () => w.now, sleep: (ms) => w.sleep(ms) }, addressCheck: async () => null, peerReader },
    ...(o.mcp ? { mcp: o.mcp } : {}),
  });
  const blanketProfile = join(w.paths.state, "blanket", "profile");
  const shims = { main: [] as ReturnType<typeof shimOn>[], blanket: [] as ReturnType<typeof shimOn>[] };
  let mainPid = 0, blanketPid = 0;
  const onProfile = (profile: string) => w.named("chromium").find((p) => p.argv.includes(`--user-data-dir=${profile}`));
  const host = setInterval(() => {
    const m = onProfile(w.paths.profile), b = onProfile(blanketProfile);
    if (m && m.pid !== mainPid) { mainPid = m.pid; shims.main.at(-1)?.s.destroy(); shims.main.push(shimOn(join(dir, "link.sock"), ["scopes"])); }
    else if (!m && mainPid !== 0) { mainPid = 0; shims.main.at(-1)?.s.destroy(); }
    if (b && b.pid !== blanketPid) { blanketPid = b.pid; peerOf.parent = b.pid; shims.blanket.at(-1)?.s.destroy(); shims.blanket.push(shimOn(join(dir, "link-blanket.sock"), o.blanketFeatures ?? ["scopes", "blanket"])); }
    else if (!b && blanketPid !== 0) { blanketPid = 0; shims.blanket.at(-1)?.s.destroy(); }
  }, 5);
  t.after(async () => { clearInterval(host); for (const x of [...shims.main, ...shims.blanket]) x.s.destroy(); await s.stop(); rmSync(dir, { recursive: true, force: true }); w.close(); });
  await s.state.handle({ ...CONFIG, by: { kind: "daemon", user: "ann", via: "config" } } as any);
  const sessions = async (items: any[]) => { await s.state.handle({ t: "req", id: "s", op: "set_sessions", by: DAEMON, sessions: items, remote: [], box: { hosts: ["box.example"], cookie_names: [] } } as any); };
  return Object.assign(s, { w, dir, logs, shims, blanketProfile, onProfile, peerOf, url: (scope: string) => `ws+unix://${join(dir, "cdp.sock")}:/devtools/browser/${scope}`, sessions });
}

test("the blanket scope through the real service: its use starts the blanket Chrome on a new folder; it reaches only the blanket receiver, with \"*\" on the blanket link alone; another scope reaches only the main Chrome; its end stops the blanket Chrome and deletes the folder", { skip: process.platform !== "linux", timeout: 90_000 }, async (t) => {
  const x = await svc(t, { before: (state) => { mkdirSync(join(state, "blanket", "profile", "Default"), { recursive: true }); writeFileSync(join(state, "blanket", "profile", "Default", "Cookies"), "an earlier run"); } });
  assert.ok(x.blanket, "the service has the blanket profile");
  assert.ok(!existsSync(join(x.w.paths.state, "blanket")), "the service's start deleted the folder of an earlier run");
  assert.ok((x.state.hello.features as string[]).includes(BLANKET_FEATURE));
  await x.sessions([session("web-1", {}, true), session("bl", { blanket: true })]);
  const bl = await CDPConnection.connect(x.url("bl"), 60_000);
  const conns = [bl];
  try {
    // The blanket Chrome runs on its own folder, from the same binary as the main Chrome, on the same display.
    const main = x.onProfile(x.w.paths.profile)!, blanket = x.onProfile(x.blanketProfile)!;
    assert.ok(main && blanket, "two Chromes");
    assert.equal(blanket.env!.DISPLAY, main.env!.DISPLAY);
    assert.ok(existsSync(join(x.w.paths.state, "blanket", "profile", "Default", "Preferences")));
    assert.ok(!existsSync(join(x.w.paths.state, "blanket", "profile", "Default", "Cookies")));
    // The blanket link got only the object of "*" for bl; the main link's objects never name bl.
    const bShim = x.shims.blanket.at(-1)!, mShim = x.shims.main.at(-1)!;
    assert.deepEqual(bShim.main.map((q) => [q.op, q.scopes, q.lists, q.default, q.operator, Array.isArray(q.exclude)]), [["set_scopes", { bl: "*" }, {}, null, null, true]]);
    for (const q of x.shims.main.flatMap((s) => s.main)) {
      assert.ok(!Object.hasOwn(q.scopes ?? {}, "bl"), "the main object leaves bl out");
      // The main link's object is never blanket-shaped: its operator stays "*" (the pin's review).
      if (q.op === "set_scopes") assert.equal(q.operator, "*", JSON.stringify(q));
    }
    // bl opens a public host on the blanket Chrome only.
    const before = mShim.fr.sent("windows.create").length + mShim.fr.sent("tabs.create").length;
    await bl.send("Target.createTarget", { url: "https://news.example.org/" });
    assert.equal(bShim.fr.sent("windows.create").length + bShim.fr.sent("tabs.create").length, 1);
    assert.equal(mShim.fr.sent("windows.create").length + mShim.fr.sent("tabs.create").length, before);
    const local = await bl.send("Target.createTarget", { url: "http://localhost:8080/" }).then(() => "no refusal", (e: Error) => e.message);
    assert.match(local, /localhost is not a public host name/);
    // The connection is the blanket model's; the main model has none.
    assert.deepEqual([x.agent.relay.blanketModel!.connectionCount, x.agent.relay.model.connectionCount], [1, 0]);
    // status.
    const st = x.state.status() as any;
    const byScope = Object.fromEntries(st.sessions.map((s: any) => [s.scope, s]));
    assert.deepEqual([byScope.bl.blanket, byScope.bl.blanket_state, byScope.bl.list], [true, "ready", null]);
    assert.equal(byScope["web-1"].blanket, false);
    // The end: session_ended stops the blanket Chrome and deletes its folder; its connection closes.
    await x.state.handle({ t: "req", id: "e", op: "session_ended", by: DAEMON, scope: "bl" } as any);
    await until(() => !x.onProfile(x.blanketProfile) && !existsSync(join(x.w.paths.state, "blanket")), "the blanket Chrome's end and the folder's removal", 20_000);
    assert.ok(x.onProfile(x.w.paths.profile), "the main Chrome runs on");
    const after = await raw(x.url("bl"));
    assert.deepEqual([after.status, after.body], [503, NOT_READY.noList], "bl ended: the main model does not name it, and no Chrome starts for it");
    // web-1 (now this process's session) reaches the main Chrome with its list, never the blanket one.
    await x.sessions([session("web-1")]);
    const web = await CDPConnection.connect(x.url("web-1"), 30_000);
    conns.push(web);
    const bBefore = bShim.fr.requests.length;
    await web.send("Target.createTarget", { url: "https://a.example/" });
    const off = await web.send("Target.createTarget", { url: "https://news.example.org/" }).then(() => "no refusal", (e: Error) => e.message);
    assert.match(off, /not on the allowlist/);
    assert.equal(bShim.fr.requests.length, bBefore, "web-1 never reaches the blanket Chrome");
    assert.deepEqual([x.agent.relay.blanketModel!.connectionCount, x.agent.relay.model.connectionCount], [0, 1]);
  } finally { for (const c of conns) await c.close().catch(() => {}); }
});

test("a blanket receiver with no feature blanket: the use gets the too-old 503, no \"*\" goes, and the blanket Chrome stops", { skip: process.platform !== "linux", timeout: 90_000 }, async (t) => {
  const x = await svc(t, { blanketFeatures: ["scopes"] });
  await x.sessions([session("bl", { blanket: true })]);
  const r = await raw(x.url("bl"));
  assert.deepEqual([r.status, r.body], [503, "The agent browser is not ready: the blanket profile's extension is too old for the blanket profile."]);
  assert.deepEqual(x.shims.blanket.flatMap((s) => s.main).filter((q) => q.op === "set_scopes"), []);
  await until(() => !x.onProfile(x.blanketProfile), "the blanket Chrome's stop", 20_000);
  const st = x.state.status() as any;
  assert.equal(st.sessions[0].blanket_state, "failed");
  assert.match(st.operator_text, /The blanket Chrome of the session bl could not start: the blanket profile's extension is too old for the blanket profile\./);
});

test("M2: the real service wiring gives the blanket link's peer check the blanket Chrome's pid, start time and profile: a shim of the main Chrome is refused there; M6: the service's stop ends the blanket Chrome and deletes its folder", { skip: process.platform !== "linux", timeout: 90_000 }, async (t) => {
  const x = await svc(t);
  await x.sessions([session("bl", { blanket: true })]);
  const bl = await CDPConnection.connect(x.url("bl"), 60_000);
  try {
    const main = x.onProfile(x.w.paths.profile)!, blanket = x.onProfile(x.blanketProfile)!;
    assert.ok(main && blanket);
    assert.ok(x.logs.some((l) => /^blanket: link: the host shim connected \(pid 4242\)/.test(l)), "the blanket Chrome's shim passed the real check");
    // A shim whose parent is the main Chrome, at the blanket link: refused by the check's parent rule.
    x.peerOf.parent = main.pid;
    const intruder = connect(join(x.dir, "link-blanket.sock"));
    intruder.on("error", () => {});
    intruder.write('{"t":"hello","v":2,"version":"9.9.9","channels":["main","bridge"],"features":["scopes","blanket"]}\n');
    await until(() => x.logs.some((l) => l.startsWith("blanket: link: refused") && l.includes(WHY.parent)), "the blanket link's refusal of the main Chrome's shim", 10_000);
    intruder.destroy();
    // The blanket Chrome's own shim stays linked: the receiver of the blanket link is still the blanket Chrome's.
    x.peerOf.parent = blanket.pid;
    assert.ok(x.blanket!.part.ready("bl"));
  } finally { await bl.close().catch(() => {}); }
  // M6: the service's own stop: the blanket Chrome ends and <state>/blanket goes; the main Chrome stays for the next owner.
  assert.ok(existsSync(join(x.w.paths.state, "blanket")));
  await x.stop();
  assert.ok(!x.onProfile(x.blanketProfile), "no blanket Chrome after the service's stop");
  assert.ok(!existsSync(join(x.w.paths.state, "blanket")), "the blanket folder is deleted");
  assert.ok(x.onProfile(x.w.paths.profile), "the main Chrome stays (detached for the next owner)");
});

test("N1 (board ab-4wh.7): the blanket door's session check reads the roots of every session: a process of a nested session (its root under the blanket root) and a process under a root that two scopes name get the session's 403 at once, and no Chrome starts", { skip: process.platform !== "linux", timeout: 90_000 }, async (t) => {
  const x = await svc(t);
  // The nested session: the blanket item's root is this process's parent, and web-1's root is this process. The walk from
  // this process meets web-1's root first, so it is no process of bl (C11: a pane is never under another pane).
  await x.sessions([session("bl", { blanket: true, roots: myParent() }), session("web-1")]);
  const nested = await raw(x.url("bl"));
  assert.deepEqual([nested.status, nested.body], [403, sessionRefusal(process.pid)], "a process of a nested session");
  // The shared root: bl and web-1 both name this process; a root that two scopes name counts for neither.
  await x.sessions([session("bl", { blanket: true }), session("web-1")]);
  const shared = await raw(x.url("bl"));
  assert.deepEqual([shared.status, shared.body], [403, sessionRefusal(process.pid)], "a process under a root that two scopes name");
  assert.deepEqual(x.w.named("chromium").map((p) => p.argv.find((a) => a.startsWith("--user-data-dir="))), [], "no Chrome starts for either");
  assert.equal(x.blanket!.part.holder(), "bl", "bl still holds the blanket Chrome: only its use was refused");
  // bl's own process (bl's root alone, no other session over it) passes the door: the use starts the blanket Chrome.
  await x.sessions([session("bl", { blanket: true }), session("web-1", {}, true)]);
  const own = await CDPConnection.connect(x.url("bl"), 60_000);
  try { assert.ok(x.onProfile(x.blanketProfile), "the blanket Chrome runs for bl's own process"); }
  finally { await own.close().catch(() => {}); }
});

// ------------------------------------------------------------------ M3's open test (board ab-4wh.7): the real endMcp wiring

/** A POST to the MCP port on a connection of its own (the port admits each connection by its holder's walk). */
function mcpPost(port: number, scope: string, token: string, body: unknown, sid?: string): Promise<{ status: number; sid: string | null; text: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port, path: `/mcp/${scope}`, method: "POST", agent: false, headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, Connection: "close",
      "Content-Length": Buffer.byteLength(data), ...(sid ? { "Mcp-Session-Id": sid } : {}),
    } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d)).on("end", () => resolve({ status: res.statusCode ?? 0, sid: (res.headers["mcp-session-id"] as string | undefined) ?? null, text }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

test("M3 (board ab-4wh.7): the real endMcp wiring: at the blanket scope's end (its session_ended, a set_sessions that leaves it out, one that drops its blanket) the scope's MCP sessions end, and another scope's MCP session stays", { skip: process.platform !== "linux", timeout: 120_000 }, async (t) => {
  // The MCP port's reader: the real /proc for the TCP lines and their holders (this process holds the client sockets),
  // and a fake parent of this process, so that each connection walks to the root of the scope that the test names. The
  // two roots are made-up pids with their own start times; no real process has them.
  const ROOT_BL = { pid: 900_001, start: 1 }, ROOT_WEB = { pid: 900_002, start: 2 };
  const real = procReader();
  const walk = { parent: ROOT_BL.pid };
  const reader: McpReader = {
    tcp: () => real.tcp(), holders: (i) => real.holders(i), cgroup: () => null,
    proc: (pid) => {
      if (pid === ROOT_BL.pid || pid === ROOT_WEB.pid) return { ppid: 1, start: pid === ROOT_BL.pid ? ROOT_BL.start : ROOT_WEB.start, state: "S" };
      const p = real.proc(pid);
      return p && pid === process.pid ? { ...p, ppid: walk.parent } : p;
    },
  };
  const x = await svc(t, { mcp: { listen: { port: 0 }, port: { reader } } });
  const port = x.mcp!.mcpPort!.port;
  const token = (name: string) => "abt1_" + Buffer.from(`test, not a token: ${name}`, "latin1").toString("base64url");
  const fp = (tok: string) => createHash("sha256").update(tok, "latin1").digest("hex");
  const blItem = (scope: string, blanket: boolean) => session(scope, { blanket, roots: [ROOT_BL], mcp_token: fp(token(scope)) });
  const webItem = session("web-1", { roots: [ROOT_WEB], mcp_token: fp(token("web-1")) });
  const open = async (scope: string, root: { pid: number }) => {
    walk.parent = root.pid;
    const init = await mcpPost(port, scope, token(scope), { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "0" } } });
    assert.equal(init.status, 200, `${scope}: ${init.text}`);
    assert.ok(init.sid, `${scope}: an MCP session id`);
    await mcpPost(port, scope, token(scope), { jsonrpc: "2.0", method: "notifications/initialized" }, init.sid!);
    return init.sid!;
  };
  const sessionsNow = () => ((x.state.status() as any).mcp.sessions ?? {}) as Record<string, number>;
  await x.sessions([blItem("bl1", true), webItem]);
  await open("web-1", ROOT_WEB);
  const ends: [string, string, () => Promise<void>][] = [
    ["bl1", "its session_ended", async () => { await x.state.handle({ t: "req", id: "e", op: "session_ended", by: DAEMON, scope: "bl1" } as any); }],
    ["bl2", "a set_sessions that leaves it out", async () => { await x.sessions([webItem]); }],
    // The scope lives on with its token and its root: only the blanket part's end (endMcp) ends its MCP sessions.
    ["bl3", "a set_sessions that drops its blanket", async () => { await x.sessions([blItem("bl3", false), webItem]); }],
  ];
  for (const [scope, why, end] of ends) {
    await x.sessions([blItem(scope, true), webItem]);
    assert.equal(x.blanket!.part.holder(), scope, `${why}: ${scope} holds the blanket Chrome`);
    await open(scope, ROOT_BL);
    await open(scope, ROOT_BL);
    assert.deepEqual(sessionsNow(), { "web-1": 1, [scope]: 2 }, `${why}: before the end`);
    await end();
    await until(() => sessionsNow()[scope] === undefined, `${why}: the MCP sessions of ${scope} end`, 20_000);
    assert.equal(x.blanket!.part.holder(), null, `${why}: no holder`);
    assert.deepEqual(sessionsNow(), { "web-1": 1 }, `${why}: web-1's MCP session stays`);
    assert.equal(x.logs.filter((l) => new RegExp(`^mcp: MCP session \\d+ of scope ${scope} ended`).test(l)).length, 2, `${why}: two MCP sessions of ${scope} ended`);
  }
  assert.ok(!x.logs.some((l) => /^mcp: MCP session \d+ of scope web-1 ended/.test(l)), "no MCP session of web-1 ended");
});

// ------------------------------------------------------------------ the vectors' blanket lines (board ab-4wh.7)

test("the vectors' blanket lines (test/vectors/control.json): the real service with the blanket part answers each line through a control door, gives the status of each line after it, and refuses each bad line", { skip: process.platform !== "linux", timeout: 90_000 }, async (t) => {
  const control = JSON.parse(readFileSync(new URL("./vectors/control.json", import.meta.url), "utf8"));
  const V = control.blanket;
  const x = await svc(t);
  assert.ok((x.state.hello.features as string[]).includes(V.feature), "the hello's feature");
  // The service's own control door admits only the daemon (service-admission.test.ts); a second door over the service's
  // own handler, with an admission that admits this test, carries the lines.
  const door = await ControlDoor.open({ path: join(x.dir, "door.sock"), handler: x.state, log: () => {}, admit: async () => ({ ok: true }) });
  try {
    const c = await daemonClient(join(x.dir, "door.sock"));
    await c.next((l) => l.t === "hello");
    c.send(DAEMON_HELLO);
    const blanketSentences = (text: string) => text.split(/(?<=\.)\s+/).filter((s) => /blanket/.test(s));
    for (const v of [...V.requests, ...V.badRequests]) {
      c.send(v.req);
      assert.deepEqual(await c.answer(v.req.id), v.res, v.note);
      if (!v.status) continue;
      c.send({ t: "req", id: `${v.req.id}-status`, op: "status", by: DAEMON });
      const data = (await c.answer(`${v.req.id}-status`)).data;
      // Each item with this part's keys only (the vectors' format): the list names are the service's own.
      const part = (r: any) => (r.blanket === true ? { scope: r.scope, list: r.list, blanket: true, blanket_state: r.blanket_state } : { scope: r.scope, blanket: r.blanket });
      assert.deepEqual(data.sessions.map(part), v.status.sessions, `${v.note}: status's sessions`);
      for (const r of data.sessions) if (r.blanket !== true) assert.ok(!Object.hasOwn(r, "blanket_state"), `${v.note}: ${r.scope} has no blanket_state`);
      assert.deepEqual(blanketSentences(data.operator_text), v.operator, `${v.note}: the blanket sentences of operator_text`);
    }
    assert.deepEqual(x.w.named("chromium"), [], "no line starts a Chrome");
    c.end();
  } finally { await door.stop(); }
});
