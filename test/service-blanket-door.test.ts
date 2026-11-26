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
import { join } from "node:path";
import { CDPConnection } from "../src/cdp.ts";
import { NOT_READY } from "../src/relay/model.ts";
import { Stage1a, startService, type ServiceOptions } from "../src/service/service.ts";
import { ControlDoor } from "../src/service/control.ts";
import type { UnitState } from "../src/service/unit/owner.ts";
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
async function svc(t: { after: (f: () => Promise<void> | void) => void }, o: { blanketFeatures?: string[]; before?: (state: string) => void; mcp?: ServiceOptions["mcp"]; noBlanket?: boolean } = {}) {
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
    ...(o.noBlanket ? { blanket: { off: true } } : { blanket: { chrome: { spawn: (a, e) => w.spawn(a, e), kill: (p, sig) => w.kill(p, sig), clock: () => w.now, sleep: (ms) => w.sleep(ms) }, addressCheck: async () => null, peerReader } }),
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
