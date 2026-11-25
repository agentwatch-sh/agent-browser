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
import { connect } from "node:net";
import { join } from "node:path";
import { CDPConnection } from "../src/cdp.ts";
import { NOT_READY } from "../src/relay/model.ts";
import { startService } from "../src/service/service.ts";
import type { UnitState } from "../src/service/unit/owner.ts";
import { BLANKET_FEATURE } from "../src/service/blanket/part.ts";
import { FakeReceiver, raw, until } from "./fake-bridge.ts";
import type { PeerReader } from "../src/relay/peer.ts";
import { WHY } from "../src/service/link/peer.ts";
import { FakeTools, World } from "./fake-unit-world.ts";
import { tempDir } from "./temp-dirs.ts";

const DAEMON = { kind: "daemon", user: "ann", via: "daemon" };
/** The pid of each shim for the blanket link's real peer check. */
const SHIM_PID = 4242;
const CONFIG = { t: "req", id: "cfg", op: "config", by: { kind: "daemon", user: "ann", via: "config" }, enabled: true, control: true, chrome_bin: "/usr/bin/chromium", chrome_args: [] };
const ACTIVE: UnitState = { active: "active", sub: "running", mainPid: process.pid };
const myStart = () => { const st = readFileSync("/proc/self/stat", "latin1"); return Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[19]); };
const me = () => [{ pid: process.pid, start: myStart() }];
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

async function svc(t: { after: (f: () => Promise<void> | void) => void }, o: { blanketFeatures?: string[]; before?: (state: string) => void } = {}) {
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
