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
import { connect, Server } from "node:net";
import { basename, join } from "node:path";
import { CDPConnection } from "../src/cdp.ts";
import { NOT_READY } from "../src/relay/model.ts";
import { BLANKET_NOT_READY } from "../src/relay/endpoint.ts";
import { Stage1a, startService, type ServiceOptions } from "../src/service/service.ts";
import { ControlDoor } from "../src/service/control.ts";
import type { UnitState } from "../src/service/unit/owner.ts";
import type { UnitDeps } from "../src/service/unit/unit.ts";
import { BLANKET_FEATURE } from "../src/service/blanket/part.ts";
import { FakeReceiver, raw, until } from "./fake-bridge.ts";
import { DAEMON_HELLO, daemonClient } from "./fake-daemon.ts";
import { NO_SCOPE, Peer, RootState, sessionRefusal, type PeerReader } from "../src/relay/peer.ts";
import { WHY } from "../src/service/link/peer.ts";
import { procReader, type McpReader } from "../src/service/mcp/proc.ts";
import { FakeTools, World } from "./fake-unit-world.ts";
import { tempDir } from "./temp-dirs.ts";

const DAEMON = { kind: "daemon", user: "ann", via: "daemon" };
/** The pid of each shim for the blanket link's real peer check. */
const SHIM_PID = 4242;
const CONFIG = { t: "req", id: "cfg", op: "config", by: { kind: "daemon", user: "ann", via: "config" }, enabled: true, control: true, chrome_bin: "/usr/bin/chromium", chrome_args: [] };
const ACTIVE: UnitState = { active: "active", sub: "running", mainPid: process.pid };
/**
 * A process's start time as the Linux reader reads it (/proc/<pid>/stat, field 22). Every test that reads a real
 * process skips off Linux; the tests that run on every system use session()'s roots only as data, so on another
 * system a fixed stand-in serves (board ab-g7e: agentwatch's Mac check of the unit tests has no /proc).
 */
const startOf = (pid: number | "self") => {
  if (process.platform !== "linux") return 1;
  const st = readFileSync(`/proc/${pid}/stat`, "latin1");
  return Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[19]);
};
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
  // `hold.scopes` (board ab-4wh.9, m1): set_scopes gets no answer, so no new allowlist line comes.
  const hold = { scopes: false };
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
      if (q.op === "set_scopes" && hold.scopes) continue;
      if (!s.destroyed) s.write(`${JSON.stringify({ t: "res", id: q.id, ok: true, data: q.op === "set_scopes" ? { rules: 1, closed: 0, refused: 0 } : {} })}\n`);
    }
  });
  fr.input.on("data", (d) => { if (!s.destroyed) s.write(d); });
  s.once("connect", () => s.write(`${JSON.stringify({ t: "hello", v: 2, version: "0.3.16", channels: ["main", "bridge"], features })}\n`));
  return { s, fr, main, hold };
}

/** `noBlanket` (board ab-4wh.10): the same service without the blanket profile, as every Mac service and a Linux one without it. */
/**
 * `blanketIdleOff` (board ab-4wh.8): no stop by use of the blanket Chrome (its 15 s check), so a test drives its stops.
 * `owner`: the owner rule's read of the unit (ACTIVE by default); `unit`: more of the unit's deps; `config`: more keys of
 * the first `config` (the review of board ab-4wh.8).
 */
async function svc(t: { after: (f: () => Promise<void> | void) => void }, o: { blanketFeatures?: string[]; before?: (state: string) => void; mcp?: ServiceOptions["mcp"]; noBlanket?: boolean; blanketIdleOff?: boolean;
  owner?: () => Promise<UnitState>; unit?: (w: World, tools: FakeTools) => Partial<UnitDeps>; config?: Record<string, unknown> } = {}) {
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
    unit: { paths: w.paths, owner: o.owner ?? (async () => ACTIVE), tools, procs: w.procs, part: { unit: w.deps(tools, o.unit?.(w, tools) ?? {}), firstCheckMs: 3_600_000, usePollMs: 5, watchMs: 20 } },
    link: { socket: join(dir, "link.sock"), pidfds: { failed: "none" }, xdotool: null, peer: async () => ({ ok: true as const, pid: 4242 }) },
    // No DNS in a unit test: the address rule's own tests are test/blanket-scope.test.ts's and test/page-fetch*.
    ...(o.noBlanket ? { blanket: { off: true } } : { blanket: { chrome: { spawn: (a, e) => w.spawn(a, e), kill: (p, sig) => w.kill(p, sig), clock: () => w.now, sleep: (ms) => w.sleep(ms) }, addressCheck: async () => null, peerReader, ...(o.blanketIdleOff ? { part: { idle: undefined } } : {}) } }),
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
  await s.state.handle({ ...CONFIG, ...o.config, by: { kind: "daemon", user: "ann", via: "config" } } as any);
  const sessions = async (items: any[]) => { await s.state.handle({ t: "req", id: "s", op: "set_sessions", by: DAEMON, sessions: items, remote: [], box: { hosts: ["box.example"], cookie_names: [] } } as any); };
  return Object.assign(s, { w, dir, logs, shims, blanketProfile, onProfile, peerOf, tools, url: (scope: string) => `ws+unix://${join(dir, "cdp.sock")}:/devtools/browser/${scope}`, sessions });
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
    // The blanket Chrome runs on its own folder, on the unit's Xvfb alone: no main Chrome starts (board ab-4wh.8).
    const blanket = x.onProfile(x.blanketProfile)!;
    assert.ok(blanket, "the blanket Chrome");
    assert.equal(x.onProfile(x.w.paths.profile), undefined, "no main Chrome");
    assert.deepEqual(x.w.named("Xvfb").map((p) => p.argv[1]), [blanket.env!.DISPLAY], "on the unit's one Xvfb");
    assert.ok(existsSync(join(x.w.paths.state, "blanket", "profile", "Default", "Preferences")));
    assert.ok(!existsSync(join(x.w.paths.state, "blanket", "profile", "Default", "Cookies")));
    // The blanket link got only the object of "*" for bl.
    const bShim = x.shims.blanket.at(-1)!;
    assert.deepEqual(bShim.main.map((q) => [q.op, q.scopes, q.lists, q.default, q.operator, Array.isArray(q.exclude)]), [["set_scopes", { bl: "*" }, {}, null, null, true]]);
    assert.equal(x.shims.main.length, 0, "no main link");
    // bl opens a public host on the blanket Chrome only.
    await bl.send("Target.createTarget", { url: "https://news.example.org/" });
    assert.equal(bShim.fr.sent("windows.create").length + bShim.fr.sent("tabs.create").length, 1);
    const local = await bl.send("Target.createTarget", { url: "http://localhost:8080/" }).then(() => "no refusal", (e: Error) => e.message);
    assert.match(local, /localhost is not a public host name/);
    // The connection is the blanket model's; the main model has none.
    assert.deepEqual([x.agent.relay.blanketModel!.connectionCount, x.agent.relay.model.connectionCount], [1, 0]);
    // status: the main Chrome's state stays off (board ab-4wh.8); blanket_state tells the blanket Chrome.
    const st = x.state.status() as any;
    const byScope = Object.fromEntries(st.sessions.map((s: any) => [s.scope, s]));
    assert.deepEqual([byScope.bl.blanket, byScope.bl.blanket_state, byScope.bl.list], [true, "ready", null]);
    assert.equal(byScope["web-1"].blanket, false);
    assert.deepEqual([st.state, st.chrome_pid], ["off", null]);
    // The end: session_ended stops the blanket Chrome and deletes its folder; its connection closes; Xvfb stops with it.
    await x.state.handle({ t: "req", id: "e", op: "session_ended", by: DAEMON, scope: "bl" } as any);
    await until(() => !x.onProfile(x.blanketProfile) && !existsSync(join(x.w.paths.state, "blanket")), "the blanket Chrome's end and the folder's removal", 20_000);
    await until(() => x.w.named("Xvfb").length === 0, "the stop of Xvfb with no Chrome on it", 20_000);
    const after = await raw(x.url("bl"));
    // No Chrome runs now (board ab-4wh.8), so the readiness answers first (C11's order), and no Chrome starts for bl.
    assert.deepEqual([after.status, after.body], [503, NOT_READY.link], "bl ended: no Chrome starts for it");
    assert.deepEqual(x.w.named("chromium"), [], "no Chrome starts for the ended bl");
    // web-1 (now this process's session) reaches the main Chrome with its list, never the blanket one.
    await x.sessions([session("web-1")]);
    const web = await CDPConnection.connect(x.url("web-1"), 30_000);
    conns.push(web);
    const bBefore = bShim.fr.requests.length;
    await web.send("Target.createTarget", { url: "https://a.example/" });
    // The main link's objects never name bl.
    for (const q of x.shims.main.flatMap((s) => s.main)) {
      assert.ok(!Object.hasOwn(q.scopes ?? {}, "bl"), "the main object leaves bl out");
      // The main link's object is never blanket-shaped: its operator stays "*" (the pin's review).
      if (q.op === "set_scopes") assert.equal(q.operator, "*", JSON.stringify(q));
    }
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
    // The op `start` starts the main Chrome on the blanket Chrome's Xvfb (board ab-4wh.8: a blanket use starts none).
    assert.equal(x.onProfile(x.w.paths.profile), undefined);
    assert.deepEqual(await x.part!.startBrowser(null), { data: {} });
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

// ------------------------------------------------------------------ board ab-4wh.9: the gate holds every session's roots

test("ab-4wh.9 (a): while the blanket Chrome is stopped, a process of the blanket session whose root is under a main session's root gets the session's 403 at that main scope (the relay's gate holds every session's roots), and no blanket Chrome starts; the main use goes on", { skip: process.platform !== "linux", timeout: 90_000 }, async (t) => {
  const x = await svc(t);
  // The main session web-1 (root: this process's parent) starts the main Chrome; its line, with web-1's roots, is confirmed.
  await x.sessions([session("web-1", { roots: myParent() })]);
  const first = await CDPConnection.connect(x.url("web-1"), 60_000);
  await first.close();
  const main = x.agent.relay.model;
  assert.equal(main.notReady(), null, "the main model is ready");
  // The blanket session bl, nested under web-1: its root is this process. The blanket Chrome is stopped, so no blanket
  // line gives the gate bl's root; the service's sessions do.
  await x.sessions([session("web-1", { roots: myParent() }), session("bl", { blanket: true })]);
  assert.equal(x.blanket!.part.holder(), "bl");
  const nested = await raw(x.url("web-1"));
  assert.deepEqual([nested.status, nested.body], [403, sessionRefusal(process.pid)], "bl's process gets no connection of web-1 (the shared profile)");
  assert.ok(!x.onProfile(x.blanketProfile), "no blanket Chrome starts");
  assert.equal(main.connectionCount, 0);
  // A shared root: bl names web-1's root too. A root that two sessions name counts for neither.
  await x.sessions([session("web-1", { roots: myParent() }), session("bl", { blanket: true, roots: myParent() })]);
  const shared = await raw(x.url("web-1"));
  assert.deepEqual([shared.status, shared.body], [403, sessionRefusal(process.pid)], "a root that two sessions name");
  // The normal main use: web-1's own process (no other session over it) gets its connection on the main Chrome.
  await x.sessions([session("web-1"), session("bl", { blanket: true, roots: [{ pid: 999_999, start: 1 }] })]);
  await until(() => main.notReady() === null, "the main line with web-1's new root");
  const own = await CDPConnection.connect(x.url("web-1"), 30_000);
  try { assert.equal(main.connectionCount, 1, "web-1's process reaches the main model"); }
  finally { await own.close().catch(() => {}); }
});

// Board ab-4wh.9, the review's I1: a set_sessions that comes while the agent door opens. The relay reads the sessions'
// roots once before its listen, and the state's `sessionsChanged` hook (board ab-4wh.10; before it, the blanket part's
// `changed` hook) finds no relay until the service has it, so the service reads them again right after. The test holds the agent door's listen and sends the set_sessions in the hold.
// It is narrow: it reads the gate's own walk (a private field), because the window is not visible from a client. Any
// main line refreshes the gate by itself, and the main model admits no connection before its first line.
test("ab-4wh.9 I1: a set_sessions while the agent door's listen is held reaches the relay's gate: right after the start, the gate's walk stops at the nested blanket session's root", { skip: process.platform !== "linux", timeout: 90_000 }, async (t) => {
  const listen = Server.prototype.listen;
  const roots = Stage1a.prototype.roots;
  let state: Stage1a | null = null;
  let held = false;
  Stage1a.prototype.roots = function (this: Stage1a) { state ??= this; return roots.call(this); };
  Server.prototype.listen = function (this: Server, ...args: any[]) {
    if (typeof args[0] !== "string" || !args[0].endsWith("/cdp.sock") || typeof args.at(-1) !== "function") return (listen as any).apply(this, args);
    const done = args.pop();
    return (listen as any).call(this, ...args, () => setTimeout(() => {
      held = true;
      // The main session web-1 (root: this process's parent) and the blanket session bl nested under it (root: this process).
      void state!.handle({ t: "req", id: "held", op: "set_sessions", by: DAEMON, sessions: [session("web-1", { roots: myParent() }), session("bl", { blanket: true })], remote: [], box: { hosts: ["box.example"], cookie_names: [] } } as any);
      done();
    }, 20));
  };
  let x: Awaited<ReturnType<typeof svc>>;
  try { x = await svc(t); } finally { Server.prototype.listen = listen; Stage1a.prototype.roots = roots; }
  assert.ok(held && state, "the set_sessions came while the listen was held");
  assert.equal(x.blanket!.part.holder(), "bl");
  const gate = x.agent.relay.peer as any;
  const mine = `${process.pid}:${startOf("self")}`;
  assert.equal(gate.state.walk(gate.reader, process.pid), mine, "the gate's walk stops at bl's root (this process), not at web-1's root");
});

// Board ab-4wh.9, the review's m1, with board ab-4wh.11: the gate reads the roots again at session_ended, and it keeps the
// ended session's roots as roots that refuse until the next set_sessions. The blanket Chrome is stopped, so no blanket
// line comes at the end; the main receiver holds its answer to the push of the end, so no main line comes either (a main
// line would read the roots again by itself).
test("ab-4wh.9 m1 and ab-4wh.11: when the nested blanket session ends, its left-over process (its root still runs) still gets the session's 403 at web-1 until the next set_sessions; after a set_sessions without it, web-1's own process is admitted again", { skip: process.platform !== "linux", timeout: 90_000 }, async (t) => {
  const x = await svc(t);
  await x.sessions([session("web-1", { roots: myParent() })]);
  const first = await CDPConnection.connect(x.url("web-1"), 60_000);
  await first.close();
  const main = x.agent.relay.model;
  await x.sessions([session("web-1", { roots: myParent() }), session("bl", { blanket: true })]);
  const nested = await raw(x.url("web-1"));
  assert.deepEqual([nested.status, nested.body], [403, sessionRefusal(process.pid)], "bl's process gets no connection of web-1");
  // bl ends, and its root (this process) still runs. No new main line comes.
  x.shims.main.at(-1)!.hold.scopes = true;
  await x.state.handle({ t: "req", id: "e", op: "session_ended", by: DAEMON, scope: "bl" } as any);
  assert.equal(x.blanket!.part.holder(), null);
  assert.equal(main.notReady(), null, "the main model is ready, with no new line");
  const left = await raw(x.url("web-1"));
  assert.deepEqual([left.status, left.body], [403, sessionRefusal(process.pid)], "bl's left-over process gets no connection of web-1 (board ab-4wh.11)");
  // The next set_sessions leaves bl out: this process is web-1's only, under web-1's root.
  await x.sessions([session("web-1", { roots: myParent() })]);
  const own = await CDPConnection.connect(x.url("web-1"), 30_000);
  try { assert.equal(main.connectionCount, 1, "web-1's process reaches the main model again"); }
  finally { await own.close().catch(() => {}); }
});

// ------------------------------------------------------------------ board ab-4wh.10: the same roots without the blanket Chrome

// Board ab-4wh.10 (the review of ab-4wh.9, m3): a service without the blanket profile (every Mac service, and Linux
// without it) gives the relay's gate the roots of every session that it holds too. Before, its gate had the main line's
// roots only, so a process of a session whose root no main line carried yet passed the walk as the session above it. (A
// launch name that two live sessions share has no item in set_sessions, C12, and the control door refuses two items of
// one scope; the roots of such sessions come in context_roots: board ab-4wh.12, below.)
test("ab-4wh.10: without the blanket profile, web-1's own process gets its connection as before while no session is nested; a process of a new session nested under web-1, whose push the receiver has not confirmed yet, gets the session's 403 at web-1", { skip: process.platform !== "linux", timeout: 90_000 }, async (t) => {
  const x = await svc(t, { noBlanket: true });
  assert.equal(x.blanket, null, "the service has no blanket profile");
  await x.sessions([session("web-1", { roots: myParent() })]);
  const first = await CDPConnection.connect(x.url("web-1"), 60_000);
  await first.close();
  const main = x.agent.relay.model;
  // No nested session: the normal main use of web-1's own process, as before.
  await x.sessions([session("web-1", { roots: myParent() }), session("other", {}, true)]);
  await until(() => main.named("other") && main.notReady() === null, "the main line with other's gone root");
  const own = await CDPConnection.connect(x.url("web-1"), 30_000);
  try { assert.equal(main.connectionCount, 1, "web-1's process reaches the main model"); }
  finally { await own.close().catch(() => {}); }
  await until(() => main.connectionCount === 0, "the close");
  // A new session nested under web-1 (its root: this process) whose push the receiver has not confirmed yet: the main
  // line does not carry its root.
  x.shims.main.at(-1)!.hold.scopes = true;
  await x.sessions([session("web-1", { roots: myParent() }), session("other", {}, true), session("nest")]);
  assert.ok(!main.named("nest"), "no line names nest yet");
  const early = await raw(x.url("web-1"));
  assert.deepEqual([early.status, early.body], [403, sessionRefusal(process.pid)], "nest's process gets no connection of web-1 before nest's line");
});

// Board ab-4wh.11 (aw-lead's note on ab-4wh.9): an ended session's roots refuse until the next set_sessions, also without
// the blanket profile. The main receiver confirms the push of the end, so the main line without nest comes.
test("ab-4wh.11: without the blanket profile, after session_ended of a session nested under web-1 whose root still runs, its left-over process gets the session's 403 at web-1 until the next set_sessions, also after the line without it; after a set_sessions without it, the walk admits that process as web-1's", { skip: process.platform !== "linux", timeout: 90_000 }, async (t) => {
  const x = await svc(t, { noBlanket: true });
  await x.sessions([session("web-1", { roots: myParent() })]);
  const first = await CDPConnection.connect(x.url("web-1"), 60_000);
  await first.close();
  const main = x.agent.relay.model;
  await x.sessions([session("web-1", { roots: myParent() }), session("nest")]);
  await until(() => main.named("nest"), "the main line with nest");
  const nested = await raw(x.url("web-1"));
  assert.deepEqual([nested.status, nested.body], [403, sessionRefusal(process.pid)], "nest's process gets no connection of web-1");
  await x.state.handle({ t: "req", id: "e", op: "session_ended", by: DAEMON, scope: "nest" } as any);
  await until(() => !main.named("nest") && main.notReady() === null, "the main line without nest");
  const left = await raw(x.url("web-1"));
  assert.deepEqual([left.status, left.body], [403, sessionRefusal(process.pid)], "nest's left-over process gets no connection of web-1 after its end");
  // The next set_sessions leaves nest out: no session's root is under web-1's any more, so the walk admits this process.
  await x.sessions([session("web-1", { roots: myParent() })]);
  const own = await CDPConnection.connect(x.url("web-1"), 30_000);
  try { assert.equal(main.connectionCount, 1, "the process reaches the main model as web-1's"); }
  finally { await own.close().catch(() => {}); }
});

// Board ab-4wh.10: the state's own rules of the gate's roots, with no relay. It reads them again after each set_sessions
// and session_ended (also the Mac's end of a case twin's name, which goes to no part), and keeps an ended session's roots
// until the next set_sessions.
test("ab-4wh.10 and ab-4wh.11: the state calls its hook after each set_sessions and session_ended, also the Mac's end that goes to no part; contextRoots keeps an ended session's roots until the next set_sessions", () => {
  for (const foldCase of [false, true]) {
    let calls = 0;
    const st = new Stage1a({ agentDoor: { url: (s) => s, state: () => ({ form: "pidfd" }) }, foldCase, sessionsChanged: () => { calls++; } });
    const snap = (items: any[]) => st.handle({ t: "req", id: "s", op: "set_sessions", by: DAEMON, sessions: items, remote: [], box: { hosts: [], cookie_names: [] } } as any);
    const r = (pid: number) => [{ pid, start: pid * 10 }];
    const ctx = () => Object.fromEntries(st.contextRoots());
    snap([session("web-1", { roots: r(2001) }), session("nest", { roots: r(2002) })]);
    assert.equal(calls, 1, `${foldCase}: after set_sessions`);
    assert.deepEqual(ctx(), { "web-1": r(2001), nest: r(2002) });
    st.handle({ t: "req", id: "e", op: "session_ended", by: DAEMON, scope: "nest" } as any);
    assert.equal(calls, 2, `${foldCase}: after session_ended`);
    assert.deepEqual(Object.fromEntries(st.roots()), { "web-1": r(2001) }, `${foldCase}: the ended session leaves the sessions`);
    assert.deepEqual(ctx(), { "web-1": r(2001), nest: r(2002) }, `${foldCase}: its roots stay in the context`);
    // The Mac's end of a name whose case twin lives (WEB-1 for web-1) goes to no part, and still reads the roots again.
    st.handle({ t: "req", id: "e2", op: "session_ended", by: DAEMON, scope: "WEB-1" } as any);
    assert.equal(calls, 3, `${foldCase}: after the end of a case twin's name`);
    assert.deepEqual(ctx(), { "web-1": r(2001), nest: r(2002) }, `${foldCase}: no root moves`);
    snap([session("web-1", { roots: r(2001) })]);
    assert.equal(calls, 4);
    assert.deepEqual(ctx(), { "web-1": r(2001) }, `${foldCase}: the next set_sessions drops the ended session's roots`);
    // A hook that throws stops no op.
    const bad = new Stage1a({ agentDoor: { url: (s) => s, state: () => ({ form: "pidfd" }) }, foldCase, sessionsChanged: () => { throw new Error("no relay"); } });
    assert.deepEqual(bad.handle({ t: "req", id: "s", op: "set_sessions", by: DAEMON, sessions: [session("web-1")], remote: [], box: { hosts: [], cookie_names: [] } } as any), { data: {} });
  }
});

// Board ab-4wh.11, the review's m4: a part that throws at set_sessions or session_ended does not skip the refresh of the
// gate's roots: the state's sessions changed before the parts ran.
test("ab-4wh.11 m4: when a part's setSessions or sessionEnded throws, the state still calls its hook", () => {
  let calls = 0;
  const throwing = { ops: {}, setSessions: () => { throw new Error("a part's set_sessions"); }, sessionEnded: () => { throw new Error("a part's session_ended"); } };
  const st = new Stage1a({ agentDoor: { url: (s) => s, state: () => ({ form: "pidfd" }) }, parts: [throwing], sessionsChanged: () => { calls++; } });
  assert.throws(() => st.handle({ t: "req", id: "s", op: "set_sessions", by: DAEMON, sessions: [session("web-1"), session("nest", { roots: [{ pid: 2002, start: 20020 }] })], remote: [], box: { hosts: [], cookie_names: [] } } as any), /a part's set_sessions/);
  assert.equal(calls, 1, "the hook after the set_sessions that threw");
  assert.throws(() => st.handle({ t: "req", id: "e", op: "session_ended", by: DAEMON, scope: "nest" } as any), /a part's session_ended/);
  assert.equal(calls, 2, "the hook after the session_ended that threw");
  assert.deepEqual(st.contextRoots().get("nest"), [{ pid: 2002, start: 20020 }], "the ended session's roots are in the context");
});

// Board ab-4wh.11, the review's m3: while Chrome is down, the service's own session check before a start at a use (C11,
// the start at a use) reads the roots of an ended session too, as the relay's gate does: so the answer comes at once, and
// nothing starts. Without them that check passes, a start runs, and only the relay's gate refuses after it.
test("ab-4wh.11 m3: while Chrome is down, a process under the still running root of an ended session nested under web-1 (and under the blanket session bl) gets the session's 403 at once from the service's own check, and no Chrome starts; after the next set_sessions the use starts Chrome", { skip: process.platform !== "linux", timeout: 90_000 }, async (t) => {
  for (const blanket of [false, true]) {
    const x = await svc(t, { noBlanket: !blanket });
    const scope = blanket ? "bl" : "web-1";
    const top = session(scope, { roots: myParent(), ...(blanket ? { blanket: true } : {}) });
    // nest's root is this process, under the root of `scope`. Chrome does not run yet.
    await x.sessions([top, session("nest")]);
    await x.state.handle({ t: "req", id: "e", op: "session_ended", by: DAEMON, scope: "nest" } as any);
    if (blanket) assert.equal(x.blanket!.part.holder(), "bl");
    const refused = await raw(x.url(scope));
    assert.deepEqual([refused.status, refused.body], [403, sessionRefusal(process.pid)], `${scope}: the service's own check refuses`);
    assert.deepEqual(x.w.named("chromium"), [], `${scope}: no Chrome starts`);
    // The next set_sessions leaves nest out: this process is a process of `scope` only, and its use starts Chrome.
    await x.sessions([top]);
    const own = await CDPConnection.connect(x.url(scope), 60_000);
    try { assert.equal((blanket ? x.agent.relay.blanketModel! : x.agent.relay.model).connectionCount, 1, `${scope}: the use reaches its model`); }
    finally { await own.close().catch(() => {}); }
  }
});

// ------------------------------------------------------------------ board ab-4wh.12: the roots of no scope

// Board ab-4wh.12 (C12, `context_roots` of set_sessions; C11, the service's sessions): the daemon sends no item for a launch
// name that two live sessions share, but it sends their roots in `context_roots` to a service whose hello lists the
// feature. The lines go through a second control door over the service's own handler (the door's shape step), as above.
async function doorOf(x: Awaited<ReturnType<typeof svc>>, t: { after: (f: () => Promise<void> | void) => void }) {
  const door = await ControlDoor.open({ path: join(x.dir, "door.sock"), handler: x.state, log: () => {}, admit: async () => ({ ok: true }) });
  const c = await daemonClient(join(x.dir, "door.sock"));
  t.after(async () => { c.end(); await door.stop(); });
  await c.next((l) => l.t === "hello");
  c.send(DAEMON_HELLO);
  let n = 0;
  return async (items: any[], extra: object = {}) => {
    const id = `cr${++n}`;
    c.send({ t: "req", id, op: "set_sessions", by: DAEMON, sessions: items, remote: [], box: { hosts: ["box.example"], cookie_names: [] }, ...extra });
    return c.answer(id);
  };
}

test("ab-4wh.12: the real service's hello lists context_roots; a process of a session of a shared launch name, whose root comes only in context_roots and is under web-1's root, gets the session's 403 at web-1; a bad context_roots keeps the old snapshot; the next set_sessions without it admits the process as web-1's again", { skip: process.platform !== "linux", timeout: 90_000 }, async (t) => {
  const x = await svc(t, { noBlanket: true });
  assert.ok((x.state.hello.features as string[]).includes("context_roots"), "the hello's feature");
  const snap = await doorOf(x, t);
  const web1 = () => [session("web-1", { roots: myParent() })];
  assert.equal((await snap(web1())).ok, true);
  const first = await CDPConnection.connect(x.url("web-1"), 60_000);
  await first.close();
  const main = x.agent.relay.model;
  await until(() => main.connectionCount === 0, "the close");
  // The shared-name session's root is this process, under web-1's root; no item names it, so no line carries it.
  assert.deepEqual(await snap(web1(), { context_roots: me() }), { t: "res", id: "cr2", ok: true, data: {} });
  const shared = await raw(x.url("web-1"));
  assert.deepEqual([shared.status, shared.body], [403, sessionRefusal(process.pid)], "the shared-name session's process gets no connection of web-1");
  // A bad field refuses the whole snapshot, and the service keeps the old one, with its roots of no scope.
  assert.deepEqual(await snap(web1(), { context_roots: [...me(), { pid: 1, start: 0 }] }), { t: "res", id: "cr3", ok: false, error: "bad request" });
  const kept = await raw(x.url("web-1"));
  assert.deepEqual([kept.status, kept.body], [403, sessionRefusal(process.pid)], "the old snapshot stays");
  // The next set_sessions without the field (the session's name is no longer shared, or it ended): web-1's process again.
  assert.equal((await snap(web1())).ok, true);
  const own = await CDPConnection.connect(x.url("web-1"), 30_000);
  try { assert.equal(main.connectionCount, 1, "the process reaches the main model as web-1's"); }
  finally { await own.close().catch(() => {}); }
});

// The service's own session check before a start at a use (C11) reads the roots of no scope too: the answer comes at once,
// and no Chrome starts. Without them that check passes, a start runs, and only the relay's gate refuses after it.
test("ab-4wh.12: while Chrome is down, a process under a root of no scope (context_roots) under web-1's root (and under the blanket session bl's root) gets the session's 403 at once from the service's own check, and no Chrome starts; after a set_sessions without it the use starts Chrome", { skip: process.platform !== "linux", timeout: 90_000 }, async (t) => {
  for (const blanket of [false, true]) {
    const x = await svc(t, { noBlanket: !blanket });
    const snap = await doorOf(x, t);
    const scope = blanket ? "bl" : "web-1";
    const top = session(scope, { roots: myParent(), ...(blanket ? { blanket: true } : {}) });
    assert.equal((await snap([top], { context_roots: me() })).ok, true);
    if (blanket) assert.equal(x.blanket!.part.holder(), "bl");
    const refused = await raw(x.url(scope));
    assert.deepEqual([refused.status, refused.body], [403, sessionRefusal(process.pid)], `${scope}: the service's own check refuses`);
    assert.deepEqual(x.w.named("chromium"), [], `${scope}: no Chrome starts`);
    assert.equal((await snap([top])).ok, true);
    const own = await CDPConnection.connect(x.url(scope), 60_000);
    try { assert.equal((blanket ? x.agent.relay.blanketModel! : x.agent.relay.model).connectionCount, 1, `${scope}: the use reaches its model`); }
    finally { await own.close().catch(() => {}); }
  }
});

// The Mac's form (no Mac here: the state, the door and the gate's rules over the Mac world of test/vectors/endpoint.json):
// on the Mac the service drops a pair of names that differ only in case and that it did not have (C12), and it adds the
// dropped sessions' roots to its roots of no scope. So the process 4010, under md-sub's root 4005 under md-deep's root
// 4000, gets no connection of md-deep. Without those roots (the old code) the walk meets md-deep's root and admits it.
test("ab-4wh.12, the Mac's form: the roots of the sessions that the Mac's case rule drops, and the roots of context_roots, become roots of no scope that refuse a process under md-deep's root in the Mac's walk; on Linux the names stay, with their own roots; a set_sessions without them admits again", async () => {
  const endpointV = JSON.parse(readFileSync(new URL("./vectors/endpoint.json", import.meta.url), "utf8"));
  const procs = new Map<number, any>(endpointV.procs.filter((p: any) => p.world === "mac").map((p: any) => [p.pid, p]));
  const mac: PeerReader = {
    form: "mac", peer: () => null, proc: (pid) => { const p = procs.get(pid); return p ? { ppid: p.ppid, start: p.start, state: p.state } : null; },
    cgroup: () => null, poll: () => 0, fdinfoPid: () => null, close: () => {},
  };
  const root = (pid: number) => [{ pid, start: procs.get(pid).start }];
  const peer = new Peer({ pid: 4010, uid: 501, pidfd: null, start: procs.get(4010).start });
  const line = new Map([["md-deep", root(4000)]]);
  const admits = (st: Stage1a) => RootState.read(mac, line, st.contextRoots()).check(mac, "md-deep", peer) !== null;
  assert.ok(RootState.read(mac, line).check(mac, "md-deep", peer) !== null, "the line alone admits 4010 as md-deep's");
  for (const foldCase of [true, false]) {
    const st = new Stage1a({ agentDoor: { url: (s) => s, state: () => ({ form: "mac" }) }, foldCase, contextRoots: true });
    const dir = tempDir("ab-noscope-");
    const door = await ControlDoor.open({ path: join(dir, "control.sock"), handler: st, log: () => {}, admit: async () => ({ ok: true }) });
    try {
      const c = await daemonClient(join(dir, "control.sock"));
      await c.next((l) => l.t === "hello");
      c.send(DAEMON_HELLO);
      const snap = async (id: string, items: any[], extra: object = {}) => {
        c.send({ t: "req", id, op: "set_sessions", by: DAEMON, sessions: items, remote: [], box: { hosts: [], cookie_names: [] }, ...extra });
        assert.equal((await c.answer(id)).ok, true, `${foldCase}: ${id}`);
      };
      // md-sub and MD-Sub are new to the service: on the Mac both go (C12), and their roots become roots of no scope.
      await snap("m1", [session("md-deep", { roots: root(4000) }), session("md-sub", { roots: root(4005) }), session("MD-Sub", { roots: root(4006) })]);
      if (foldCase) assert.deepEqual(st.contextRoots().get(NO_SCOPE), [...root(4005), ...root(4006)], "the dropped sessions' roots");
      else assert.deepEqual([st.contextRoots().get("md-sub"), st.contextRoots().get(NO_SCOPE)], [root(4005), undefined], "on Linux the names stay");
      assert.equal(admits(st), false, `${foldCase}: 4010 gets no connection of md-deep`);
      await snap("m2", [session("md-deep", { roots: root(4000) })]);
      assert.equal(st.contextRoots().get(NO_SCOPE), undefined, `${foldCase}: the next set_sessions replaces them`);
      assert.equal(admits(st), true, `${foldCase}: 4010 is md-deep's again`);
      // The same root in context_roots (a launch name that two live sessions share), with no case twin.
      await snap("m3", [session("md-deep", { roots: root(4000) })], { context_roots: root(4005) });
      assert.equal(admits(st), false, `${foldCase}: context_roots refuses 4010 too`);
      c.end();
    } finally { await door.stop(); rmSync(dir, { recursive: true, force: true }); }
  }
});

// ------------------------------------------------------------------ board ab-4wh.13: the MCP path keeps the same roots

/** A GET of the MCP path on a connection of its own, with `token`: the transport answers an admitted one with its 405. */
function mcpGet(port: number, scope: string, token: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: `/mcp/${scope}`, method: "GET", agent: false, headers: { Authorization: `Bearer ${token}`, Connection: "close" } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d)).on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    req.end();
  });
}

// Board ab-4wh.13 (the review of ab-4wh.10, m5): the real service gives its MCP port the relay's gate's own source of the
// roots that admit nothing (the state's contextRoots), so on the MCP path too a left-over process of an ended nested
// session, and a process under a root of context_roots, get the session's 403 at the walk (step 2) at the outer scope,
// with that scope's valid token. The port's reader: the real /proc for the TCP lines and their holders (this process),
// and made-up parents of this process (pids that no real process has here): nest's root under web-1's root.
test("ab-4wh.13: the real service's MCP path: a left-over process of an ended session nested under web-1 (its root still runs) gets the session's 403 at the walk with web-1's valid token until the next set_sessions, and a process under a root of context_roots under web-1's root too; a live session's process is admitted as before", { skip: process.platform !== "linux", timeout: 90_000 }, async (t) => {
  const ROOT_WEB = { pid: 900_011, start: 1 }, ROOT_NEST = { pid: 900_012, start: 2 }, ROOT_ELSE = { pid: 900_013, start: 3 }, ROOT_NONE = { pid: 900_014, start: 4 };
  const real = procReader();
  const walk = { parent: ROOT_WEB.pid };
  const fake = new Map([[ROOT_WEB.pid, { ppid: 1, start: ROOT_WEB.start, state: "S" }], [ROOT_NEST.pid, { ppid: ROOT_WEB.pid, start: ROOT_NEST.start, state: "S" }], [ROOT_ELSE.pid, { ppid: 1, start: ROOT_ELSE.start, state: "S" }], [ROOT_NONE.pid, { ppid: 1, start: ROOT_NONE.start, state: "S" }]]);
  const reader: McpReader = {
    tcp: () => real.tcp(), holders: (i) => real.holders(i), cgroup: () => null,
    proc: (pid) => {
      const f = fake.get(pid);
      if (f) return f;
      const p = real.proc(pid);
      return p && pid === process.pid ? { ...p, ppid: walk.parent } : p;
    },
  };
  const x = await svc(t, { noBlanket: true, mcp: { listen: { port: 0 }, port: { reader } } });
  const port = x.mcp!.mcpPort!.port;
  const token = (name: string) => "abt1_" + Buffer.from(`test, not a token: ${name}`, "latin1").toString("base64url");
  const fp = (tok: string) => createHash("sha256").update(tok, "latin1").digest("hex");
  const web1 = session("web-1", { roots: [ROOT_WEB], mcp_token: fp(token("web-1")) });
  const nest = session("nest", { roots: [ROOT_NEST], mcp_token: fp(token("nest")) });
  const snap = (items: any[], extra: object = {}) => x.state.handle({ t: "req", id: "s", op: "set_sessions", by: DAEMON, sessions: items, remote: [], box: { hosts: ["box.example"], cookie_names: [] }, ...extra } as any);
  const step2 = () => x.logs.filter((l) => /^mcp: connection \d+ refused at step 2 \(403\)$/.test(l)).length;
  /** The answer to a GET of `scope` with its valid token: admitted (the transport's 405), or the session's 403 at step 2. */
  const ask = async (scope: string) => {
    const before = step2();
    const got = await mcpGet(port, scope, token(scope));
    if (got.status === 405) return "admitted";
    assert.deepEqual([got.status, got.text, step2() - before], [403, sessionRefusal(process.pid), 1], `${scope}: the walk's refusal`);
    return "refused";
  };
  // The steady state: web-1's own process; with nest live, nest's process is nest's.
  walk.parent = ROOT_WEB.pid;
  await snap([web1]);
  assert.equal(await ask("web-1"), "admitted", "web-1's own process");
  walk.parent = ROOT_NEST.pid;
  await snap([web1, nest]);
  assert.equal(await ask("nest"), "admitted", "nest's process is nest's");
  // nest ends; its root still runs. Its left-over process is no process of web-1 until the next set_sessions.
  await x.state.handle({ t: "req", id: "e", op: "session_ended", by: DAEMON, scope: "nest" } as any);
  assert.equal(await ask("web-1"), "refused", "the ended session's left-over process gets no connection of web-1");
  await snap([web1]);
  assert.equal(await ask("web-1"), "admitted", "after the next set_sessions it is web-1's");
  // A root of no scope (context_roots) under web-1's root.
  await snap([web1], { context_roots: [ROOT_NEST] });
  assert.equal(await ask("web-1"), "refused", "a process under a root of context_roots gets no connection of web-1");
  // Roots that refuse elsewhere change nothing for web-1's own process: a root of no scope and an ended session's root
  // that are under no root of web-1.
  walk.parent = ROOT_WEB.pid;
  await snap([web1, session("other", { roots: [ROOT_ELSE] })], { context_roots: [ROOT_NONE] });
  await x.state.handle({ t: "req", id: "e2", op: "session_ended", by: DAEMON, scope: "other" } as any);
  assert.equal(await ask("web-1"), "admitted", "web-1's own process, with roots that refuse elsewhere");
});

// The review of ab-4wh.12, m3: an end of a scope (C12's session_ended, and on the Mac the end of a case twin's name, which
// goes to no part) changes no root of no scope: the roots of context_roots and of the dropped case twins stay in the
// gate's context until the next set_sessions replaces them.
test("ab-4wh.12 m3: a session_ended, and on the Mac the end of a case twin's name, keeps the roots of no scope (context_roots and the dropped twins' roots) until the next set_sessions", () => {
  for (const foldCase of [false, true]) {
    const st = new Stage1a({ agentDoor: { url: (s) => s, state: () => ({ form: "pidfd" }) }, foldCase, contextRoots: true });
    const snap = (items: any[], extra: object = {}) => st.handle({ t: "req", id: "s", op: "set_sessions", by: DAEMON, sessions: items, remote: [], box: { hosts: [], cookie_names: [] }, ...extra } as any);
    const end = (scope: string) => st.handle({ t: "req", id: "e", op: "session_ended", by: DAEMON, scope } as any);
    const r = (pid: number) => [{ pid, start: pid * 10 }];
    snap([session("web-1", { roots: r(2001) }), session("nest", { roots: r(2002) })]);
    // tool and TOOL are new: on the Mac both go, and their roots become roots of no scope too.
    snap([session("web-1", { roots: r(2001) }), session("nest", { roots: r(2002) }), session("tool", { roots: r(2005) }), session("TOOL", { roots: r(2006) })], { context_roots: r(2003) });
    const want = foldCase ? [...r(2003), ...r(2005), ...r(2006)] : r(2003);
    assert.deepEqual(st.contextRoots().get(NO_SCOPE), want, `${foldCase}: the roots of no scope`);
    end("nest");
    assert.deepEqual(st.contextRoots().get(NO_SCOPE), want, `${foldCase}: session_ended keeps them`);
    assert.deepEqual(st.contextRoots().get("nest"), r(2002), `${foldCase}: and the ended session's own roots`);
    // The Mac's end of WEB-1 while web-1 lives goes to no part (C12); on Linux it ends a name that the service does not have.
    end("WEB-1");
    assert.deepEqual(st.contextRoots().get(NO_SCOPE), want, `${foldCase}: the end of a case twin's name keeps them`);
    end("TOOL");
    assert.deepEqual(st.contextRoots().get(NO_SCOPE), want, `${foldCase}: the end of a dropped twin's name keeps them`);
    snap([session("web-1", { roots: r(2001) })]);
    assert.equal(st.contextRoots().get(NO_SCOPE), undefined, `${foldCase}: the next set_sessions replaces them`);
  }
});

// The review of ab-4wh.12, m4, the Mac's form: the service keeps the case twin that it had (md-lead) and drops the new one
// (MD-LEAD), whose root 4005 is under md-deep's root 4000. md-lead's own process 3102 is still md-lead's: only the dropped
// twin's roots become roots of no scope (a kept twin's root under NO_SCOPE too would be a root that two scopes name, which
// counts for neither). The process 4010 under the dropped twin's root gets no connection of md-deep.
test("ab-4wh.12 m4, the Mac's form: the service keeps one case twin and drops the other: the kept twin's own process is admitted as its scope, and a process under the dropped twin's root is refused at another scope", () => {
  const endpointV = JSON.parse(readFileSync(new URL("./vectors/endpoint.json", import.meta.url), "utf8"));
  const procs = new Map<number, any>(endpointV.procs.filter((p: any) => p.world === "mac").map((p: any) => [p.pid, p]));
  const mac: PeerReader = {
    form: "mac", peer: () => null, proc: (pid) => { const p = procs.get(pid); return p ? { ppid: p.ppid, start: p.start, state: p.state } : null; },
    cgroup: () => null, poll: () => 0, fdinfoPid: () => null, close: () => {},
  };
  const root = (pid: number) => [{ pid, start: procs.get(pid).start }];
  const peer = (pid: number) => new Peer({ pid, uid: 501, pidfd: null, start: procs.get(pid).start });
  const st = new Stage1a({ agentDoor: { url: (s) => s, state: () => ({ form: "mac" }) }, foldCase: true, contextRoots: true });
  const snap = (items: any[]) => st.handle({ t: "req", id: "s", op: "set_sessions", by: DAEMON, sessions: items, remote: [], box: { hosts: [], cookie_names: [] } } as any);
  // The gate as the service holds it: the main line carries the items' roots (roots()), the context the rest.
  const admits = (scope: string, pid: number) => RootState.read(mac, st.roots(), st.contextRoots()).check(mac, scope, peer(pid)) !== null;
  snap([session("md-lead", { roots: root(3100) }), session("md-deep", { roots: root(4000) })]);
  assert.ok(admits("md-lead", 3102) && admits("md-deep", 4010), "before the twin: each process is its scope's");
  snap([session("md-lead", { roots: root(3100) }), session("MD-LEAD", { roots: root(4005) }), session("md-deep", { roots: root(4000) })]);
  assert.deepEqual([...st.roots().keys()], ["md-lead", "md-deep"], "the service keeps md-lead, which it had, and drops MD-LEAD");
  assert.equal(admits("md-lead", 3102), true, "the kept twin's own process is md-lead's");
  assert.equal(admits("md-deep", 4010), false, "a process under the dropped twin's root gets no connection of md-deep");
  assert.deepEqual(st.contextRoots().get(NO_SCOPE), root(4005), "only the dropped twin's root is a root of no scope");
});

// ------------------------------------------------------------------ the unit's Xvfb alone (board ab-4wh.8)
// C12, the blanket profile: on Linux a use of the blanket scope starts the unit's Xvfb alone and then the blanket
// Chrome; the main Chrome does not start. Xvfb runs while either Chrome runs: the stop by use of one keeps the other
// and Xvfb, and Xvfb stops at the later of the two stops. The daemon's `stop` stops both Chromes and Xvfb.

const xvfbPids = (x: { w: World }) => x.w.named("Xvfb").map((p) => p.pid);
const unitRecord = (x: { w: World }) => JSON.parse(readFileSync(x.w.paths.unitFile, "utf8"));

test("ab-4wh.8: a blanket use starts the unit's Xvfb alone and the blanket Chrome, no main Chrome (state off, chrome_pid null); a later use of another scope starts the main Chrome on the same Xvfb; the blanket Chrome's stop by use keeps the main Chrome and Xvfb; the main Chrome's stop by use then stops Xvfb too", { skip: process.platform !== "linux", timeout: 90_000 }, async (t) => {
  const x = await svc(t);
  await x.sessions([session("bl", { blanket: true }), session("web-1", {}, true)]);
  const bl = await CDPConnection.connect(x.url("bl"), 60_000);
  let web: CDPConnection | null = null;
  try {
    const blanket = x.onProfile(x.blanketProfile)!;
    assert.ok(blanket, "the blanket Chrome runs");
    assert.equal(x.onProfile(x.w.paths.profile), undefined, "no main Chrome");
    const xvfb = xvfbPids(x);
    assert.equal(xvfb.length, 1, "the unit's one Xvfb");
    let st = x.state.status() as any;
    assert.deepEqual([st.state, st.chrome_pid, st.chrome_version, st.sessions.find((s: any) => s.scope === "bl").blanket_state], ["off", null, null, "ready"]);
    assert.ok(!x.logs.some((l) => l.includes("an agent uses the agent browser; starting Chrome")), "no start at a use of the main Chrome");
    // The unit record names the Xvfb and no Chrome, and wants none: a new service stops that Xvfb (adopt).
    const rec = unitRecord(x);
    assert.deepEqual([rec.wanted, rec.xvfb_pid, rec.chrome_pid], [false, xvfb[0], null]);
    // A use of another scope: the main Chrome starts on the same Xvfb.
    await bl.close();
    await x.sessions([session("bl", { blanket: true }, true), session("web-1")]);
    web = await CDPConnection.connect(x.url("web-1"), 60_000);
    const main = x.onProfile(x.w.paths.profile)!;
    assert.ok(main, "the main Chrome runs");
    assert.equal(main.env!.DISPLAY, blanket.env!.DISPLAY);
    assert.deepEqual(xvfbPids(x), xvfb, "the same Xvfb");
    assert.ok(x.onProfile(x.blanketProfile), "the blanket Chrome runs on");
    st = x.state.status() as any;
    assert.deepEqual([st.state, st.chrome_pid], ["ready", main.pid]);
    // The blanket Chrome's stop by use: the main Chrome and Xvfb stay, and the folder stays.
    x.blanket!.part.stopFor("idle");
    await until(() => !x.onProfile(x.blanketProfile), "the blanket Chrome's stop", 20_000);
    assert.ok(x.w.alive(main.pid), "the main Chrome stays");
    assert.deepEqual(xvfbPids(x), xvfb, "Xvfb stays");
    assert.ok(existsSync(join(x.w.paths.state, "blanket", "profile")), "the folder stays");
    // The main Chrome's stop by use: now no Chrome runs on Xvfb, so it stops too.
    await web.close(); web = null;
    (x.part as any).idleMinutes = 0.02;
    await until(() => (x.state.status() as any).last_stop?.reason === "idle" && !x.part!.idleStopping, "the main Chrome's stop by use", 20_000);
    (x.part as any).idleMinutes = 10;
    assert.ok(!x.w.alive(main.pid));
    assert.deepEqual(xvfbPids(x), [], "Xvfb stops with the later of the two stops");
  } finally { await bl.close().catch(() => {}); await web?.close().catch(() => {}); }
});

test("ab-4wh.8: the main Chrome's stop by use keeps the blanket Chrome and Xvfb (the blanket scope works on); the blanket Chrome's stop then stops Xvfb at once; an exit of the blanket Chrome by itself stops Xvfb at the next check", { skip: process.platform !== "linux", timeout: 90_000 }, async (t) => {
  const x = await svc(t, { blanketIdleOff: true });
  await x.sessions([session("bl", { blanket: true })]);
  let bl = await CDPConnection.connect(x.url("bl"), 60_000);
  try {
    const xvfb = xvfbPids(x);
    assert.deepEqual(await x.part!.startBrowser(null), { data: {} });
    const main = x.onProfile(x.w.paths.profile)!, blanket = x.onProfile(x.blanketProfile)!;
    assert.ok(main && blanket);
    assert.deepEqual(xvfbPids(x), xvfb, "the main Chrome starts on the blanket Chrome's Xvfb");
    // The blanket scope's open connection is no use of the main Chrome (board ab-4wh.24): it stays open over the stop.
    (x.part as any).idleMinutes = 0.02;
    await until(() => (x.state.status() as any).last_stop?.reason === "idle" && !x.part!.idleStopping, "the main Chrome's stop by use", 20_000);
    (x.part as any).idleMinutes = 10;
    assert.ok(!x.w.alive(main.pid), "the main Chrome stopped");
    assert.ok(x.w.alive(blanket.pid), "the blanket Chrome stays");
    assert.deepEqual(xvfbPids(x), xvfb, "Xvfb stays");
    assert.ok(x.w.logs.some((l) => l.startsWith(`unit: Xvfb :`) && l.endsWith("stays: the blanket Chrome runs on it")), "the unit's log");
    const st = x.state.status() as any;
    assert.deepEqual([st.state, st.chrome_pid, st.sessions[0].blanket_state], ["off", null, "ready"]);
    // The blanket scope works on: a new connection reaches the blanket receiver, and no main Chrome starts.
    const bShim = x.shims.blanket.at(-1)!;
    await bl.close();
    bl = await CDPConnection.connect(x.url("bl"), 60_000);
    await bl.send("Target.createTarget", { url: "https://news.example.org/" });
    assert.equal(bShim.fr.sent("windows.create").length + bShim.fr.sent("tabs.create").length, 1);
    assert.equal(x.onProfile(x.w.paths.profile), undefined, "no main Chrome");
    // The blanket Chrome's stop: Xvfb stops with it (the later of the two stops).
    x.blanket!.part.stopFor("idle");
    await until(() => !x.onProfile(x.blanketProfile) && xvfbPids(x).length === 0, "the blanket Chrome's stop and Xvfb's", 20_000);
    assert.ok(x.w.logs.some((l) => /^unit: Xvfb :\d+ \(pid \d+\) stopped: no Chrome runs on it$/.test(l)), "the unit's log");
    // A new use; then the blanket Chrome exits by itself: the part's next check stops Xvfb.
    await bl.close().catch(() => {});
    bl = await CDPConnection.connect(x.url("bl"), 60_000);
    const again = x.onProfile(x.blanketProfile)!;
    assert.ok(again && xvfbPids(x).length === 1 && !x.onProfile(x.w.paths.profile));
    x.w.end(again.pid);
    await until(() => xvfbPids(x).length === 0, "the stop of Xvfb after the blanket Chrome's exit", 20_000);
  } finally { await bl.close().catch(() => {}); }
});

const idleStopOf = (x: Awaited<ReturnType<typeof svc>>, pid: number) => () => !x.w.alive(pid) && (x.state.status() as any).last_stop?.reason === "idle" && !x.part!.idleStopping;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("ab-4wh.24: the blanket scope's open connection and its client message that runs keep no unused main Chrome from its stop by use, and the blanket Chrome runs on; a main scope's open connection still keeps the main Chrome; the blanket Chrome's own stop by use stays as before", { skip: process.platform !== "linux", timeout: 120_000 }, async (t) => {
  const x = await svc(t);
  const mainUse = () => x.part!.usedBy();
  // bl is this process's session; web-1's root is gone.
  await x.sessions([session("bl", { blanket: true }), session("web-1", {}, true)]);
  const bl = await CDPConnection.connect(x.url("bl"), 60_000);
  let web: CDPConnection | null = null;
  let release = () => {};
  try {
    // An unused main Chrome: the daemon's start (board ab-4wh.8: on the blanket Chrome's Xvfb).
    assert.deepEqual(await x.part!.startBrowser(null), { data: {} });
    const main = x.onProfile(x.w.paths.profile)!, blanket = x.onProfile(x.blanketProfile)!;
    assert.ok(main && blanket);
    const xvfb = xvfbPids(x);
    // bl's open connection, its message, and its message that runs (the blanket receiver holds its bridge call): each is a
    // use of the blanket Chrome, none a use of the main Chrome.
    assert.deepEqual(mainUse(), [], "bl's open connection");
    await bl.send("Browser.getVersion");
    const held = new Promise<void>((r) => { release = r; });
    x.shims.blanket.at(-1)!.fr.op = async ({ op }) => { if (op === "windows.create" || op === "tabs.create") await held; return undefined; };
    const create = bl.send("Target.createTarget", { url: "https://news.example.org/" }).catch((e: Error) => e.message);
    await until(() => x.agent.relay.blanketTraffic().busy === 1, "bl's client message that runs");
    assert.deepEqual(mainUse(), [], "bl's client message that runs");
    assert.equal((x.part as any).o.use.quietFor(), Infinity, "no use of the main Chrome since its start");
    // The main Chrome's stop by use after the grace time; the blanket Chrome and Xvfb stay, and bl's use goes on.
    (x.part as any).idleMinutes = 0.02; // 1.2 s
    await until(idleStopOf(x, main.pid), "the main Chrome's stop by use", 20_000);
    (x.part as any).idleMinutes = 10;
    assert.ok(x.w.alive(blanket.pid), "the blanket Chrome runs on");
    assert.deepEqual(xvfbPids(x), xvfb, "Xvfb stays");
    assert.deepEqual([x.agent.relay.blanketTraffic().agents, x.agent.relay.blanketTraffic().busy], [1, 1], "bl's use goes on");
    // The blanket Chrome's own stop by use as before: bl's open connection keeps it over the grace time; after the
    // connection's close it stops, and its folder stays.
    release();
    const got = await create;
    assert.equal(typeof got, "object", `bl's held message gets its answer: ${String(got)}`);
    await until(() => x.agent.relay.blanketTraffic().busy === 0, "bl's client message ends");
    (x.part as any).idleMinutes = 0.02;
    await pause(1_500);
    x.blanket!.part.idleCheck();
    assert.ok(x.w.alive(blanket.pid), "bl's open connection keeps the blanket Chrome");
    await bl.close();
    await until(() => { x.blanket!.part.idleCheck(); return !x.onProfile(x.blanketProfile); }, "the blanket Chrome's stop by use", 20_000);
    (x.part as any).idleMinutes = 10;
    assert.ok(existsSync(join(x.w.paths.state, "blanket", "profile")), "the folder stays");
    // A main scope's use still keeps the main Chrome: web-1 is this process's session now (bl stays the blanket scope).
    await x.sessions([session("bl", { blanket: true }, true), session("web-1")]);
    assert.equal(x.blanket!.part.holder(), "bl");
    web = await CDPConnection.connect(x.url("web-1"), 60_000);
    const main2 = x.onProfile(x.w.paths.profile)!;
    assert.ok(main2, "web-1's use started the main Chrome");
    (x.part as any).idleMinutes = 0.02;
    await pause(2_500);
    assert.ok(x.w.alive(main2.pid), "web-1's open connection keeps the main Chrome");
    assert.deepEqual(mainUse(), ["client"]);
    await web.close(); web = null;
    await until(idleStopOf(x, main2.pid), "the main Chrome's stop by use after web-1's use", 20_000);
    (x.part as any).idleMinutes = 10;
  } finally { release(); await bl.close().catch(() => {}); await web?.close().catch(() => {}); }
});

test("ab-4wh.24: the blanket scope's MCP tool call that runs keeps no unused main Chrome from its stop by use, and the blanket Chrome runs on; a main scope's MCP tool call still keeps the main Chrome; ab-4wh.28: the blanket scope's tool call keeps the blanket Chrome from its own stop by use, which comes after the call's end", { skip: process.platform !== "linux", timeout: 120_000 }, async (t) => {
  // The MCP port's reader as in M3 above: each connection of this process walks to the root of the scope that the test
  // names (made-up pids; no real process has them). The test worker (no Playwright, no browser): its browser_wait_for gets
  // no answer, so a call runs until its cancel.
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
  const x = await svc(t, { mcp: { listen: { port: 0 }, port: { reader }, transport: { worker: { heapMb: 64, entry: new URL("./fixtures/mcp-answer-worker.ts", import.meta.url) } } } });
  const port = x.mcp!.mcpPort!.port;
  const token = (name: string) => "abt1_" + Buffer.from(`test, not a token: ${name}`, "latin1").toString("base64url");
  const fp = (tok: string) => createHash("sha256").update(tok, "latin1").digest("hex");
  const as = (root: { pid: number }) => { walk.parent = root.pid; };
  const open = async (scope: string) => {
    const init = await mcpPost(port, scope, token(scope), { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "0" } } });
    assert.equal(init.status, 200, `${scope}: ${init.text}`);
    await mcpPost(port, scope, token(scope), { jsonrpc: "2.0", method: "notifications/initialized" }, init.sid!);
    return init.sid!;
  };
  const call = (scope: string, sid: string, id: number) => mcpPost(port, scope, token(scope), { jsonrpc: "2.0", id, method: "tools/call", params: { name: "browser_wait_for", arguments: { time: 30 } } }, sid);
  const cancel = (scope: string, sid: string, id: number) => mcpPost(port, scope, token(scope), { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }, sid);
  await x.sessions([session("bl", { blanket: true, roots: [ROOT_BL], mcp_token: fp(token("bl")) }), session("web-1", { roots: [ROOT_WEB], mcp_token: fp(token("web-1")) })]);
  // bl's tool call starts the blanket Chrome at its browser gate, then runs.
  as(ROOT_BL);
  const blSid = await open("bl");
  const blCall = call("bl", blSid, 5);
  await until(() => x.mcp!.activity("blanket").calls === 1, "bl's tool call that runs", 60_000);
  const blanket = x.onProfile(x.blanketProfile)!;
  assert.ok(blanket, "the blanket Chrome");
  // An unused main Chrome: the daemon's start.
  assert.deepEqual(await x.part!.startBrowser(null), { data: {} });
  const main = x.onProfile(x.w.paths.profile)!;
  assert.ok(main);
  assert.deepEqual(x.part!.usedBy(), [], "bl's tool call is no use of the main Chrome");
  assert.equal((x.part as any).o.use.quietFor(), Infinity, "no use of the main Chrome since its start");
  (x.part as any).idleMinutes = 0.02; // 1.2 s
  await until(idleStopOf(x, main.pid), "the main Chrome's stop by use", 20_000);
  assert.ok(x.w.alive(blanket.pid), "the blanket Chrome runs on");
  assert.equal(x.mcp!.activity("blanket").calls, 1, "bl's tool call runs on");
  // The test worker opens no MCP connection to the agent door, so only the tool call can keep the blanket Chrome.
  const blanketIdle = () => x.logs.some((l) => l.startsWith("blanket: no agent used the blanket Chrome"));
  x.blanket!.part.idleCheck();
  await pause(500);
  assert.ok(!blanketIdle() && x.w.alive(blanket.pid), "bl's tool call keeps the blanket Chrome");
  // web-1's tool call starts the main Chrome at its browser gate, and it keeps the main Chrome while it runs.
  as(ROOT_WEB);
  const webSid = await open("web-1");
  const webCall = call("web-1", webSid, 6);
  await until(() => x.mcp!.activity().calls === 1, "web-1's tool call that runs", 60_000);
  const main2 = x.onProfile(x.w.paths.profile)!;
  assert.ok(main2, "web-1's use started the main Chrome");
  await pause(2_500);
  assert.ok(x.w.alive(main2.pid), "web-1's tool call keeps the main Chrome");
  assert.deepEqual(x.part!.usedBy(), ["mcp"]);
  await cancel("web-1", webSid, 6);
  await until(idleStopOf(x, main2.pid), "the main Chrome's stop by use after web-1's call", 20_000);
  (x.part as any).idleMinutes = 10;
  assert.ok(x.w.alive(blanket.pid), "the blanket Chrome runs on");
  as(ROOT_BL);
  await cancel("bl", blSid, 5);
  await until(() => x.mcp!.activity("blanket").calls === 0, "bl's tool call ends");
  (x.part as any).idleMinutes = 0.02;
  x.blanket!.part.idleCheck();
  assert.ok(!blanketIdle() && x.w.alive(blanket.pid), "the grace time counts from the call's end");
  for (const r of [await blCall, await webCall]) assert.match(r.text, /-32800/, "each call gets the cancelled answer");
  await until(() => { x.blanket!.part.idleCheck(); return !x.onProfile(x.blanketProfile); }, "the blanket Chrome's stop by use after bl's call", 20_000);
  (x.part as any).idleMinutes = 10;
  assert.ok(blanketIdle(), "the stop by use's log line");
  assert.ok(existsSync(join(x.w.paths.state, "blanket", "profile")), "the folder stays");
});

test("ab-4wh.8: the daemon's `stop` stops both Chromes and Xvfb, and the folder goes; enabled false: a blanket use starts no Xvfb, and it stops Xvfb alone with the blanket Chrome; with Xvfb alone the service's own stop ends the blanket Chrome and Xvfb", { skip: process.platform !== "linux", timeout: 90_000 }, async (t) => {
  const x = await svc(t);
  await x.sessions([session("bl", { blanket: true })]);
  let bl = await CDPConnection.connect(x.url("bl"), 60_000);
  try {
    assert.deepEqual(await x.part!.startBrowser(null), { data: {} });
    assert.ok(x.onProfile(x.w.paths.profile) && x.onProfile(x.blanketProfile) && xvfbPids(x).length === 1);
    assert.deepEqual(await x.part!.stopBrowser(null), { data: {} });
    await until(() => x.w.named("chromium").length === 0 && xvfbPids(x).length === 0 && !existsSync(join(x.w.paths.state, "blanket")), "the stop of both Chromes, Xvfb and the folder", 20_000);
    assert.equal((x.state.status() as any).last_stop.reason, "stop");
    // enabled false: a blanket use starts nothing (as a use of another scope).
    await bl.close().catch(() => {});
    await x.state.handle({ ...CONFIG, enabled: false } as any);
    const off = await raw(x.url("bl"));
    assert.equal(off.status, 503);
    assert.deepEqual([x.w.named("chromium").length, xvfbPids(x).length], [0, 0], "no Xvfb and no Chrome with enabled false");
    await x.state.handle(CONFIG as any);
    // Xvfb alone and the blanket Chrome: enabled false stops both, and the folder goes.
    bl = await CDPConnection.connect(x.url("bl"), 60_000);
    assert.ok(x.onProfile(x.blanketProfile) && xvfbPids(x).length === 1 && !x.onProfile(x.w.paths.profile));
    await x.state.handle({ ...CONFIG, enabled: false } as any);
    await until(() => x.w.named("chromium").length === 0 && xvfbPids(x).length === 0 && !existsSync(join(x.w.paths.state, "blanket")), "enabled false: the blanket Chrome, Xvfb and the folder go", 20_000);
    await bl.close().catch(() => {});
    await x.state.handle(CONFIG as any);
    // Xvfb alone and the blanket Chrome: the service's own stop ends both.
    bl = await CDPConnection.connect(x.url("bl"), 60_000);
    assert.ok(x.onProfile(x.blanketProfile) && xvfbPids(x).length === 1 && !x.onProfile(x.w.paths.profile));
  } finally { await bl.close().catch(() => {}); }
  await x.stop();
  assert.deepEqual([x.w.named("chromium").length, xvfbPids(x).length], [0, 0], "no Chrome and no Xvfb after the service's stop");
  assert.ok(!existsSync(join(x.w.paths.state, "blanket")));
});

// ------------------------------------------------------------------ the review's fix round of board ab-4wh.8

test("ab-4wh.8 C1: the daemon's stop during the install wait of a blanket use holds: when the install ends, no Xvfb and no blanket Chrome start, and the use gets that moment's answer", { skip: process.platform !== "linux", timeout: 90_000 }, async (t) => {
  const x = await svc(t, {
    config: { chrome_bin: null },
    // The install's poll (500 ms) waits on the real clock and leaves the fake one, so the wait lasts until the install ends.
    unit: (w) => ({ sleep: async (ms) => { if (ms === 500) { await new Promise((r) => setTimeout(r, 5)); return; } await w.sleep(ms); }, prepare: { run: () => "0.3.17", lastFile: () => null } }),
  });
  await x.sessions([session("bl", { blanket: true })]);
  const use = raw(x.url("bl"));
  await until(() => x.tools.pending, "the install of the blanket use", 20_000);
  assert.deepEqual(x.tools.calls, ["ensure latest"]);
  assert.deepEqual(await x.part!.stopBrowser(null), { data: {} });
  x.tools.pending!.resolve();
  const r = await use;
  assert.deepEqual([r.status, r.body], [503, BLANKET_NOT_READY.link], "that moment's answer");
  assert.deepEqual(x.w.spawned.map((p) => basename(p.argv[0])), [], "no Xvfb and no Chrome started");
  assert.ok(x.logs.includes("unit: a stop came during the start of Xvfb for the blanket Chrome; it stays stopped"));
  const st = x.state.status() as any;
  assert.deepEqual([st.state, st.sessions[0].blanket_state], ["off", "stopped"], "no failed start");
});

test("ab-4wh.8 M1: a service that no longer owns leaves Xvfb, for the next owner, at the blanket Chrome's stop and at its check each second", { skip: process.platform !== "linux", timeout: 90_000 }, async (t) => {
  let unit: UnitState = ACTIVE;
  const x = await svc(t, { owner: async () => unit, blanketIdleOff: true });
  await x.sessions([session("bl", { blanket: true })]);
  const bl = await CDPConnection.connect(x.url("bl"), 60_000);
  try {
    const xvfb = xvfbPids(x);
    assert.equal(xvfb.length, 1);
    unit = { ...ACTIVE, mainPid: process.pid + 1 };
    x.blanket!.part.stopFor("idle");
    await until(() => !x.onProfile(x.blanketProfile), "the blanket Chrome's stop", 20_000);
    // The part's check runs every 20 ms here.
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(xvfbPids(x), xvfb, "Xvfb stays");
    assert.ok(!x.w.logs.some((l) => /^unit: Xvfb :\d+ \(pid \d+\) stopped: no Chrome runs on it$/.test(l)));
  } finally { await bl.close().catch(() => {}); }
});

test("ab-4wh.8 M2: in the hold-off after a fail-closed stop, a use of the blanket scope starts no Xvfb and no Chrome, and the state stays failed closed", { skip: process.platform !== "linux", timeout: 90_000 }, async (t) => {
  const x = await svc(t);
  await x.sessions([session("bl", { blanket: true })]);
  assert.deepEqual(await x.part!.startBrowser(null), { data: {} });
  assert.equal(await (x.part as any).failClosed("receiver_missing"), true, "the watch's stop");
  assert.ok(x.part!.failClosedHold());
  const before = x.w.spawned.length;
  assert.deepEqual([x.w.named("chromium").length, xvfbPids(x).length], [0, 0]);
  const r = await raw(x.url("bl"));
  assert.equal(r.status, 503, r.body ?? "");
  assert.equal(x.w.spawned.length, before, "no Xvfb and no Chrome started in the hold-off");
  assert.equal((x.state.status() as any).state, "failed closed");
});
