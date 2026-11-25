// The blanket profile in the service (board ab-4wh.3; C12, the blanket profile): the control door's field, the hello's
// feature, one blanket scope per box, the remote item's blanket, the main object without the blanket scope and no list
// copy of the service's for it, the blanket link's object and line, the start at a use (the hello's feature `blanket`),
// the end, the stops, status; the blanket Chrome's folder (made new, reused after a stop by use, deleted at the end and at
// the service's start, no link followed) and its process on the unit's flags; the blanket link's peer check (a link is
// known by the Chrome that launched its shim, never by the receiver's claim); the host files of the blanket profile.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fieldFits } from "../src/service/control.ts";
import { Stage1a } from "../src/service/service.ts";
import { Stage1c, type Clock } from "../src/service/stage1c.ts";
import { ReceiverError, type ReceiverEvents, type ReceiverPort } from "../src/service/receiver.ts";
import type { AllowlistLine } from "../src/service/lists/scopes.ts";
import { BLANKET_FEATURE, BLANKET_TEXT, BlanketPart, type BlanketPort } from "../src/service/blanket/part.ts";
import { blanketPaths, BlanketChrome } from "../src/service/blanket/chrome.ts";
import { BLANKET_NOT_READY } from "../src/relay/endpoint.ts";
import { useFailed } from "../src/service/unit/part.ts";
import { ChromeUnit, DEFAULT_CONFIG } from "../src/service/unit/unit.ts";
import { AGENT_ARGS } from "../src/agent.ts";
import { manifestPath, wrapperPath, writeHostFiles } from "../src/service/link/manifest.ts";
import { ENV_PROFILE, ENV_SOCKET } from "../src/service/link/host.ts";
import { linkPeerCheck, WHY } from "../src/service/link/peer.ts";
import { RECEIVER_ID } from "../src/service/package/pins.ts";
import { World, FakeTools } from "./fake-unit-world.ts";
import { tempDir } from "./temp-dirs.ts";

const settle = () => new Promise((r) => setImmediate(r));
const NOW_CLOCK: Clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };

/** The receiver port of a link: set_scopes answers ok (or a refusal), the lines and end_scopes are kept. */
class FakePort implements BlanketPort {
  events!: ReceiverEvents;
  up = false;
  feats = new Set(["scopes", "bridge"]);
  refuse = false;
  readonly requests: { op: string; body: any }[] = [];
  readonly lines: AllowlistLine[] = [];
  readonly ends: string[] = [];
  attach(e: ReceiverEvents) { this.events = e; }
  isUp() { return this.up; }
  features() { return this.feats; }
  request(op: "set_scopes" | "import", body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.up) return Promise.reject(new ReceiverError("down", "the agent extension is not connected"));
    this.requests.push({ op, body: JSON.parse(JSON.stringify(body)) });
    return this.refuse ? Promise.reject(new ReceiverError("refused", "no")) : Promise.resolve({ rules: 1, closed: 0, refused: 0 });
  }
  allowlist(line: AllowlistLine) { this.lines.push(JSON.parse(JSON.stringify(line))); }
  endScope(scope: string) { this.ends.push(scope); }
  hello(features: string[]) { this.feats = new Set(features); this.up = true; this.events.up(); }
  drop() { this.up = false; this.events.down(); }
  pushes() { return this.requests.filter((r) => r.op === "set_scopes").map((r) => r.body); }
}

/** The blanket Chrome as the part sees it: its starts, stops and ends; a start makes the receiver say hello. */
class FakeChrome {
  runs = false;
  readonly calls: string[] = [];
  hello: string[] | null = ["scopes", "bridge", "blanket"];
  fail: string | null = null;
  private readonly port: FakePort;
  constructor(port: FakePort) { this.port = port; }
  running() { return this.runs; }
  async start(scope: string) {
    this.calls.push(`start ${scope}`);
    if (this.fail) throw new Error(this.fail);
    this.runs = true;
    if (this.hello) { const f = this.hello; setImmediate(() => this.port.hello(f)); }
  }
  async stop() { this.calls.push("stop"); this.runs = false; this.port.up = false; return true; }
  async end() { this.calls.push("end"); this.runs = false; this.port.up = false; }
}

/** The blanket model's readiness from the lines that the part gave it (the relay's model: test/blanket-scope.test.ts). */
const modelOf = (port: FakePort) => ({
  notReady: () => (port.up && port.lines.length ? null : "not ready"),
  named: (scope: string) => { const l = port.lines.at(-1) as any; return !!l && Object.hasOwn(l.scopes, scope) && l.scopes[scope] === "*"; },
});

const sess = (scope: string, blanket?: boolean, roots: [number, number][] = [[101, 5000]]) =>
  ({ scope, repo: "a/b", roots: roots.map(([pid, start]) => ({ pid, start })), cgroup: null, lifetime_id: `lt-${scope}`, mcp_token: null, ...(blanket === undefined ? {} : { blanket }) });
const BOX = { hosts: ["box.localhost"], cookie_names: ["__Host-session"] };

function rig() {
  const dir = tempDir("ab-blanket-");
  const lists = join(dir, "lists"), state = join(dir, "state");
  mkdirSync(lists, { recursive: true });
  writeFileSync(join(lists, "a.b.json"), JSON.stringify({ repo: "a/b", allow: ["example.com"] }));
  const main = new FakePort(), bport = new FakePort(), chrome = new FakeChrome(bport), logs: string[] = [];
  let unitCalls = 0;
  const stage1c = new Stage1c({ listsFolder: lists, stateFolder: state, receiver: main, log: (l) => logs.push(l), clock: NOW_CLOCK, blanketScope: () => part.holder() });
  const part: BlanketPart = new BlanketPart({ chrome: chrome as unknown as BlanketChrome, port: bport, model: () => modelOf(bport), removeCopy: (s) => stage1c.removeCopy(s), log: (l) => logs.push(l), helloWaitMs: 2000, readyWaitMs: 2000 });
  const svc = new Stage1a({ agentDoor: { url: (s) => `ws+unix:///x/cdp.sock:/devtools/browser/${s}`, state: () => ({ form: "pidfd" }) }, parts: [part, stage1c] });
  let n = 0;
  const req = (op: string, fields: Record<string, unknown> = {}) => svc.handle({ t: "req", id: `r${++n}`, op, by: { kind: "daemon", user: "ann", via: "daemon" }, ...fields } as any) as any;
  const setSessions = (sessions: unknown[], remote: unknown[] = []) => req("set_sessions", { sessions, remote, box: BOX });
  const copyOf = (scope: string) => { const p = join(state, "session-lists", scope, "allowlist.json"); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; };
  const unit = async () => { unitCalls++; return null; };
  return { dir, state, main, bport, chrome, logs, stage1c, part, svc, req, setSessions, copyOf, unit, unitCalls: () => unitCalls, done: () => { part.stop(); stage1c.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test("the control door: a session's blanket is absent or a boolean; any other value is a bad request", () => {
  const item = sess("w");
  assert.ok(fieldFits("sessions", [item]));
  assert.ok(fieldFits("sessions", [{ ...item, blanket: true }]) && fieldFits("sessions", [{ ...item, blanket: false }]));
  for (const bad of ["true", 1, null, {}, []]) assert.ok(!fieldFits("sessions", [{ ...item, blanket: bad }]), JSON.stringify(bad));
});

test("the hello has blanket_scope; one blanket scope per box; the main object leaves it out; no list copy of the service's for it; a remote item's blanket is ignored", async () => {
  const r = rig();
  try {
    assert.ok((r.svc.hello.features as string[]).includes(BLANKET_FEATURE));
    r.main.hello(["scopes", "bridge"]);
    // Two blanket items: the first in the order of sessions gets it.
    await r.setSessions([sess("w"), sess("b1", true), sess("b2", true)], [{ scope: "box2/s9", box: "box2", list: "l", mcp_token: "0".repeat(64), blanket: true }]);
    await settle();
    assert.equal(r.part.holder(), "b1");
    const body = r.main.pushes().at(-1);
    assert.deepEqual(Object.keys(body.scopes).sort(), ["b2", "box2/s9", "w"], "the main object leaves the blanket scope out; b2 runs with its repo's list");
    // The list copies: w and b2 (their repo's list), none of the service's for b1 (agentwatch's CLI writes "*" there).
    assert.deepEqual(r.copyOf("w"), { allow: ["example.com"] });
    assert.deepEqual(r.copyOf("b2"), { allow: ["example.com"] });
    assert.equal(r.copyOf("b1"), null);
    // The CLI's copy stays while the scope has the blanket Chrome: no write of the service's replaces it.
    mkdirSync(join(r.state, "session-lists", "b1"), { recursive: true });
    writeFileSync(join(r.state, "session-lists", "b1", "allowlist.json"), JSON.stringify({ allow: ["*"] }));
    await r.req("list_set", { list: "a.b", add: ["example.org"], remove: [] });
    assert.deepEqual(r.copyOf("b1"), { allow: ["*"] });
    // The holder keeps it while its item has blanket, also when an earlier item gets it.
    await r.setSessions([sess("b0", true), sess("w"), sess("b1", true), sess("b2", true)]);
    assert.equal(r.part.holder(), "b1");
    // status: each item has blanket; the blanket scope's has blanket_state and list null; the operator's sentences.
    const st = (await r.req("status")).data;
    const byScope = Object.fromEntries(st.sessions.map((s: any) => [s.scope, s]));
    assert.deepEqual([byScope.b1.blanket, byScope.b1.blanket_state, byScope.b1.list], [true, "stopped", null]);
    for (const s of ["b0", "w", "b2"]) { assert.equal(byScope[s].blanket, false, s); assert.ok(!("blanket_state" in byScope[s]), s); }
    assert.ok(st.operator_text.includes(BLANKET_TEXT.second("b0", "b1")) && st.operator_text.includes(BLANKET_TEXT.second("b2", "b1")), st.operator_text);
    assert.equal(st.agent_text.includes("blanket"), false, "the agent's text gets no sentence");
    // The remote item's blanket: ignored, with its sentence (from the set_sessions before).
    await r.setSessions([sess("b1", true)], [{ scope: "box2/s9", box: "box2", list: "l", mcp_token: "0".repeat(64), blanket: true }]);
    assert.ok((await r.req("status")).data.operator_text.includes(BLANKET_TEXT.remote("box2/s9")));
  } finally { r.done(); }
});

test("the start at a use: the unit, the blanket Chrome, the hello with blanket, the set_scopes of \"*\" alone, then the line with the scope's roots; ready", async () => {
  const r = rig();
  try {
    await r.setSessions([sess("w"), sess("bl", true, [[202, 7000]])]);
    assert.equal(r.part.wake("w", r.unit) instanceof Promise, true);
    assert.equal(await r.part.wake("w", r.unit), null, "another scope's use starts no blanket Chrome");
    assert.equal(r.unitCalls(), 0);
    const p = r.part.wake("bl", r.unit);
    assert.equal(r.part.state(), "starting");
    assert.equal(await p, null);
    assert.equal(r.unitCalls(), 1);
    assert.deepEqual(r.chrome.calls, ["start bl"]);
    assert.deepEqual(r.bport.pushes(), [{ lists: {}, scopes: { bl: "*" }, default: null, operator: null }]);
    assert.deepEqual(r.bport.lines.at(-1), { t: "allowlist", lists: {}, scopes: { bl: "*" }, default: null, operator: null, roots: { bl: [{ pid: 202, start: 7000 }] } });
    assert.ok(r.part.ready("bl"));
    assert.equal(r.part.state(), "ready");
    // No import and no other request goes on the blanket link.
    assert.deepEqual(r.bport.requests.map((x) => x.op), ["set_scopes"]);
    // A root change: the line again, with the new roots.
    await r.setSessions([sess("w"), sess("bl", true, [[203, 7100]])]);
    assert.deepEqual((r.bport.lines.at(-1) as any).roots, { bl: [{ pid: 203, start: 7100 }] });
    // A second use while ready starts nothing.
    assert.equal(await r.part.wake("bl", r.unit), null);
    assert.deepEqual(r.chrome.calls, ["start bl"]);
  } finally { r.done(); }
});

test("a blanket receiver with no feature blanket fails the start with the too-old 503; a failed start gives the start at a use's 503 and its status sentence", async () => {
  const r = rig();
  try {
    await r.setSessions([sess("bl", true)]);
    r.chrome.hello = ["scopes", "bridge"];
    assert.equal(await r.part.wake("bl", r.unit), BLANKET_NOT_READY.old);
    assert.deepEqual(r.bport.pushes(), [], "no \"*\" to an old receiver");
    assert.deepEqual(r.chrome.calls, ["start bl", "stop"]);
    let st = (await r.req("status")).data;
    assert.equal(st.sessions[0].blanket_state, "failed");
    assert.ok(st.operator_text.includes(BLANKET_TEXT.failed("bl", BLANKET_TEXT.tooOld)), st.operator_text);
    // A Chrome that cannot start.
    r.chrome.fail = "Chrome exited at start (exit 1)";
    assert.equal(await r.part.wake("bl", r.unit), useFailed("Chrome exited at start (exit 1)"));
    st = (await r.req("status")).data;
    assert.ok(st.operator_text.includes(BLANKET_TEXT.failed("bl", "Chrome exited at start (exit 1)")));
    // The unit's own failure goes to the use as it is.
    r.chrome.fail = null;
    assert.equal(await r.part.wake("bl", async () => "The agent browser could not get ready: Xvfb not found on PATH."), "The agent browser could not get ready: Xvfb not found on PATH.");
  } finally { r.done(); }
});

test("the end: session_ended, a set_sessions that leaves the scope out or drops its blanket: the line names it no more, the Chrome ends (its folder goes), and its list copy goes", async () => {
  for (const how of ["session_ended", "left out", "blanket false"] as const) {
    const r = rig();
    try {
      r.main.hello(["scopes", "bridge"]);
      await r.setSessions([sess("w"), sess("bl", true)]);
      assert.equal(await r.part.wake("bl", r.unit), null);
      mkdirSync(join(r.state, "session-lists", "bl"), { recursive: true });
      writeFileSync(join(r.state, "session-lists", "bl", "allowlist.json"), JSON.stringify({ allow: ["*"] }));
      if (how === "session_ended") await r.req("session_ended", { scope: "bl" });
      else if (how === "left out") await r.setSessions([sess("w")]);
      else await r.setSessions([sess("w"), sess("bl", false)]);
      await settle(); await settle();
      assert.equal(r.part.holder(), null, how);
      assert.deepEqual(r.bport.lines.at(-1), { t: "allowlist", lists: {}, scopes: {}, default: null, operator: null, roots: {} }, how);
      assert.deepEqual(r.bport.ends, ["bl"], how);
      assert.deepEqual(r.chrome.calls, ["start bl", "end"], how);
      if (how === "blanket false") {
        // The switch off: the scope runs with its repo's list in the shared profile, and its copy is the service's again.
        assert.deepEqual(r.copyOf("bl"), { allow: ["example.com"] }, how);
        await settle();
        assert.ok(Object.hasOwn(r.main.pushes().at(-1)?.scopes ?? {}, "bl"), `${how}: the main object names it again`);
      } else assert.equal(r.copyOf("bl"), null, `${how}: the CLI's "*" copy goes`);
    } finally { r.done(); }
  }
});

test("the stops of the unit: a stop by use keeps the blanket folder (the next use reuses it); the daemon's stop and enabled false delete it", async () => {
  const r = rig();
  try {
    await r.setSessions([sess("bl", true)]);
    assert.equal(await r.part.wake("bl", r.unit), null);
    r.part.stopFor("idle");
    await settle(); await settle();
    assert.deepEqual(r.chrome.calls, ["start bl", "stop"]);
    assert.equal(r.part.state(), "stopped");
    assert.equal(r.part.holder(), "bl", "the session keeps its approval");
    assert.equal(await r.part.wake("bl", r.unit), null);
    r.part.stopFor("stop");
    await settle(); await settle();
    r.part.onConfig({ enabled: false });
    await settle(); await settle();
    assert.deepEqual(r.chrome.calls, ["start bl", "stop", "start bl", "end", "end"]);
  } finally { r.done(); }
});

// ------------------------------------------------------------------ the blanket Chrome: the folder and the process

/** A unit of the fake world that runs Chromium on :173, and the blanket Chrome on its launch. */
async function chromeIn(w: World, linkSocket = "/run/ab/link.sock") {
  const u = new ChromeUnit(w.deps(new FakeTools(), { displays: { first: 173, last: 175 } }));
  u.config = { ...DEFAULT_CONFIG, chromeBin: "/usr/bin/chromium", chromeArgs: ["--force-dark-mode"] };
  const paths = blanketPaths(w.paths.state, linkSocket);
  const hostFiles: string[] = [];
  const chrome = new BlanketChrome({
    paths, procs: w.procs, log: (l) => w.logs.push(l), launch: () => u.blanketLaunch(paths.profile, paths.home),
    hostFiles: () => { hostFiles.push("written"); }, spawn: (argv, env) => w.spawn(argv, env), kill: (pid, sig) => w.kill(pid, sig),
    clock: () => w.now, sleep: (ms) => w.sleep(ms),
  });
  return { u, chrome, paths, hostFiles };
}

test("the blanket Chrome: the same binary, flags and display as the main Chrome, its own user-data-dir and HOME in <state>/blanket, a new empty folder (0700) with the agent Preferences", async () => {
  const w = new World();
  try {
    const { u, chrome, paths, hostFiles } = await chromeIn(w);
    await assert.rejects(chrome.start("bl"), /Xvfb does not run/, "no unit, no blanket Chrome");
    await u.start();
    const main = w.spawned.find((p) => p.argv[0] === "/usr/bin/chromium")!;
    await chrome.start("bl");
    const b = w.spawned.at(-1)!;
    assert.equal(b.argv[0], "/usr/bin/chromium");
    assert.deepEqual(b.argv.slice(2), main.argv.slice(2), "the same flags (AGENT_ARGS and the checked chrome_args)");
    assert.equal(b.argv[1], `--user-data-dir=${paths.profile}`);
    assert.equal(main.argv[1], `--user-data-dir=${w.paths.profile}`);
    for (const a of AGENT_ARGS) assert.ok(b.argv.includes(a), a);
    assert.ok(b.argv.includes("--force-dark-mode"));
    assert.ok(!b.argv.some((a) => a.startsWith("--remote-debugging")));
    assert.deepEqual([b.env!.DISPLAY, b.env!.XAUTHORITY, b.env!.HOME], [main.env!.DISPLAY, main.env!.XAUTHORITY, paths.home]);
    assert.equal(b.env!.AGENTWATCH_TOKEN, undefined, "no token reaches it");
    assert.equal(paths.root, join(w.paths.state, "blanket"));
    assert.equal(paths.profile, join(w.paths.state, "blanket", "profile"));
    assert.equal(paths.wrapper, `${wrapperPath(w.paths.state)}-blanket`);
    assert.equal(paths.socket, "/run/ab/link-blanket.sock");
    for (const d of [paths.root, paths.profile, paths.home, paths.downloads]) assert.equal(statSync(d).mode & 0o777, 0o700, d);
    const prefs = JSON.parse(readFileSync(paths.preferences, "utf8"));
    assert.equal(prefs.download.default_directory, paths.downloads);
    assert.equal(prefs.credentials_enable_service, false);
    assert.deepEqual(prefs.extensions.settings[RECEIVER_ID], { incognito: true, newAllowFileAccess: true });
    assert.equal(statSync(paths.preferences).mode & 0o777, 0o600);
    assert.deepEqual(hostFiles, ["written"]);
    assert.deepEqual(chrome.chromeId(), { pid: b.pid, start: b.start });
    assert.ok(chrome.running());
  } finally { w.close(); }
});

test("the blanket folder: reused after a stop of the same scope, new for another scope, deleted at the end and at the service's start (with the leftover Chrome stopped); a link is removed as a link", async () => {
  const w = new World();
  try {
    const { u, chrome, paths } = await chromeIn(w);
    await u.start();
    await chrome.start("bl");
    writeFileSync(join(paths.profile, "Default", "Cookies"), "session cookies");
    // A stop (by use) keeps the folder; the next start of the same scope reuses it.
    await chrome.stop();
    assert.equal(chrome.running(), false);
    assert.ok(existsSync(join(paths.profile, "Default", "Cookies")));
    await chrome.start("bl");
    assert.ok(existsSync(join(paths.profile, "Default", "Cookies")), "the same session keeps its cookies");
    // Another scope's first start: a new, empty folder.
    await chrome.stop();
    await chrome.start("other");
    assert.ok(!existsSync(join(paths.profile, "Default", "Cookies")), "a new folder for another scope");
    writeFileSync(join(paths.profile, "Default", "Cookies"), "x");
    // The end: the Chrome stops (SIGTERM to its group), and the folder goes.
    const pid = chrome.chromeId()!.pid;
    await chrome.end();
    assert.ok(w.signals.some(([p, s]) => Math.abs(p) === pid && s === "SIGTERM"));
    assert.ok(!existsSync(paths.root));
    // The service's start: a Chrome on the blanket profile that this service does not hold (a crash's leftover) stops,
    // and the folder goes.
    mkdirSync(join(paths.profile, "Default"), { recursive: true });
    writeFileSync(join(paths.profile, "Default", "Cookies"), "leftover");
    const left = w.add({ argv: ["/usr/bin/chromium", `--user-data-dir=${paths.profile}`, "--no-first-run"] });
    const otherChrome = w.add({ argv: ["/usr/bin/chromium", `--user-data-dir=${w.paths.profile}`] });
    const fresh = new BlanketChrome({ paths, procs: w.procs, log: (l) => w.logs.push(l), launch: () => null, hostFiles: () => {}, kill: (p, s) => w.kill(p, s), clock: () => w.now, sleep: (ms) => w.sleep(ms) });
    await fresh.sweep();
    assert.ok(!w.alive(left.pid), "the leftover blanket Chrome stopped");
    assert.ok(w.alive(otherChrome.pid), "a Chrome on another profile is never signalled");
    assert.ok(!existsSync(paths.root));
    // A symbolic link at <state>/blanket: removed as a link; its target and its files stay.
    const target = join(w.dir, "elsewhere");
    mkdirSync(target);
    writeFileSync(join(target, "keep"), "x");
    symlinkSync(target, paths.root);
    assert.ok(fresh.removeFolder());
    assert.ok(!existsSync(paths.root) && existsSync(join(target, "keep")));
    // A start never makes the folder through a link: the old link goes first, then new folders.
    symlinkSync(target, paths.root);
    await chrome.start("bl");
    assert.ok(lstatSync(paths.root).isDirectory() && !lstatSync(paths.root).isSymbolicLink());
    assert.ok(existsSync(join(target, "keep")));
  } finally { w.close(); }
});

// ------------------------------------------------------------------ the second link: known by its launch

test("the blanket host files: the manifest in the blanket profile names agent-browser-host-blanket, which gives the shim link-blanket.sock and the blanket profile", () => {
  const dir = tempDir("ab-blanket-host-");
  try {
    const state = join(dir, "state");
    mkdirSync(state, { mode: 0o700 });
    const p = blanketPaths(state, join(dir, "run", "link.sock"));
    mkdirSync(p.profile, { recursive: true });
    const main = writeHostFiles({ state, profile: join(state, "profile"), socket: join(dir, "run", "link.sock"), node: "/usr/bin/node", bin: "/opt/ab/bin/agent-browser.js" });
    const b = writeHostFiles({ state, profile: p.profile, socket: p.socket, wrapper: p.wrapper, node: "/usr/bin/node", bin: "/opt/ab/bin/agent-browser.js" });
    assert.equal(b.wrapper, join(state, "agent-browser-host-blanket"));
    assert.equal(b.manifest, manifestPath(p.profile));
    assert.notEqual(b.wrapper, main.wrapper);
    const manifest = JSON.parse(readFileSync(b.manifest, "utf8"));
    assert.equal(manifest.path, b.wrapper);
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${RECEIVER_ID}/`]);
    const text = readFileSync(b.wrapper, "utf8");
    assert.ok(text.includes(`${ENV_SOCKET}='${p.socket}'`) && text.includes(`${ENV_PROFILE}='${p.profile}'`), text);
    assert.ok(readFileSync(main.wrapper, "utf8").includes(`${ENV_SOCKET}='${join(dir, "run", "link.sock")}'`), "the main wrapper keeps the main socket");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the blanket link's peer check admits only a shim whose parent is the blanket Chrome on the blanket profile; the main Chrome's shim gets the parent refusal (no receiver claim takes part)", async () => {
  const procs: Record<number, { ppid: number; start: number; state: string; argv: string[] }> = {
    100: { ppid: 1, start: 10, state: "S", argv: ["/opt/chrome", "--user-data-dir=/s/profile"] },
    200: { ppid: 1, start: 20, state: "S", argv: ["/opt/chrome", "--user-data-dir=/s/blanket/profile"] },
    101: { ppid: 100, start: 11, state: "S", argv: ["/usr/bin/node", "bin", "host"] },
    201: { ppid: 200, start: 21, state: "S", argv: ["/usr/bin/node", "bin", "host"] },
  };
  let peerPid = 0;
  const reader = { form: "stat", peer: () => ({ pid: peerPid, uid: 1000, pidfd: null, start: procs[peerPid]?.start ?? null }), proc: (pid: number) => procs[pid] ? { ppid: procs[pid].ppid, start: procs[pid].start, state: procs[pid].state } : null,
    cgroup: () => null, poll: () => 0, fdinfoPid: () => 0, close: () => {} } as any;
  const socket = { _handle: { fd: 7 } } as any;
  const check = (chrome: { pid: number; start: number }, profile: string) => linkPeerCheck({ reader, chrome: () => chrome, profile, cmdline: (pid) => procs[pid]?.argv ?? [], uid: 1000, platform: "linux" });
  const blanketLink = check({ pid: 200, start: 20 }, "/s/blanket/profile"), mainLink = check({ pid: 100, start: 10 }, "/s/profile");
  peerPid = 201;
  assert.deepEqual(await blanketLink(socket), { ok: true, pid: 201 });
  assert.deepEqual(await mainLink(socket), { ok: false, reason: WHY.parent });
  peerPid = 101;
  assert.deepEqual(await mainLink(socket), { ok: true, pid: 101 });
  assert.deepEqual(await blanketLink(socket), { ok: false, reason: WHY.parent });
  // A blanket Chrome of another start time (a reused pid) is not the blanket Chrome.
  peerPid = 201;
  assert.deepEqual(await check({ pid: 200, start: 19 }, "/s/blanket/profile")(socket), { ok: false, reason: WHY.parentStart });
  // The blanket link's check with the main profile's name refuses a Chrome on the blanket profile.
  assert.deepEqual(await check({ pid: 200, start: 20 }, "/s/profile")(socket), { ok: false, reason: WHY.profile });
});

test("the blanket Chrome's stop by use: after the grace time with no open connection of its model it stops, and its folder stays; an open connection is a use", async () => {
  const port = new FakePort(), chrome = new FakeChrome(port), logs: string[] = [];
  let now = 0, conns = 0;
  const part = new BlanketPart({ chrome: chrome as unknown as BlanketChrome, port, model: () => modelOf(port), removeCopy: () => {}, log: (l) => logs.push(l), clock: () => now,
    sleep: async () => { now += 50; await settle(); }, idle: { ms: () => 600_000, uses: () => conns, everyMs: 3_600_000 } });
  try {
    part.setSessions({ sessions: [sess("bl", true)], remote: [] } as any);
    assert.equal(await part.wake("bl", async () => null), null);
    const start = now;
    conns = 1;
    now = start + 900_000; part.idleCheck();
    assert.ok(chrome.running(), "an open connection is a use");
    conns = 0;
    now += 599_000; part.idleCheck();
    assert.ok(chrome.running(), "not yet");
    now += 2_000; part.idleCheck();
    await settle(); await settle();
    assert.deepEqual(chrome.calls, ["start bl", "stop"], "a stop, not an end: the folder stays");
    assert.equal(part.state(), "stopped");
    assert.ok(logs.some((l) => l.includes("no agent used the blanket Chrome for 10 min")));
  } finally { part.stop(); }
});
