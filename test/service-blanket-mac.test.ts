// The blanket profile on the Mac (board ab-4wh.16; C12, the blanket profile on the Mac; C11, the blanket profile: the
// address proxy; the design docs/superpowers/specs/2026-11-26-blanket-profile-mac-design.md), with fakes (no Mac here):
// the blanket template's set-up op and its states, the copy of its two preference files into a new blanket folder, the
// Mac start through `open -n -g` and the check of the address proxy's flags in the process's arguments, the address
// proxy's Mac peer check on the blanket Chrome's own sockets and its closed mode, the versions (a profile in the state
// folder is never the operator's Chrome), the hello's feature and the op, status's key and its sentences, the off read,
// the version stop, and `service stop --all`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { AGENT_ARGS, CHROME_STABLE_BIN } from "../src/agent.ts";
import { ChromeUnit, macChromeArgs } from "../src/service/unit/unit.ts";
import { BLANKET_PACKAGE_FOLDER, blanketVersionStop, chromeVersions, macStart, type MacStart } from "../src/service/unit/mac-chrome.ts";
import { blanketPaths, BlanketChrome, MAC_FLAGS_TEXT, type BlanketProxy } from "../src/service/blanket/chrome.ts";
import { BlanketTemplate, checkLoad, SETUP_REASON, TEMPLATE_START, TEMPLATE_TEXT } from "../src/service/blanket/template.ts";
import { holdsFlags } from "../src/service/blanket/mac-start.ts";
import { AddressProxy, proxyFlags } from "../src/service/blanket/proxy.ts";
import { BLANKET_FEATURE, BLANKET_TEXT, BlanketPart, SETUP_FEATURE, type BlanketPort } from "../src/service/blanket/part.ts";
import { macTreeTcpReader, MAC_NO_UID, type BsdInfo, type MacSocket } from "../src/service/mac.ts";
import { stateFolderRefusal, stopAll } from "../src/service/unit/stop-all.ts";
import { RECEIVER_ID } from "../src/service/package/pins.ts";
import { Stage1a } from "../src/service/service.ts";
import { checkRequest } from "../src/service/control.ts";
import { useFailed } from "../src/service/unit/part.ts";
import type { ReceiverEvents } from "../src/service/receiver.ts";
import type { AllowlistLine } from "../src/service/lists/scopes.ts";
import { FakeTools, World } from "./fake-unit-world.ts";
import { tempDir } from "./temp-dirs.ts";

const APP = "/Applications/Google Chrome.app";
const CONFIG = { enabled: true, chromeBin: "", chromeArgs: ["--force-dark-mode"], displaySize: "1280x900", lang: "en-US", timezone: "" };
const settle = () => new Promise((r) => setImmediate(r));

/** A fake `open` that adds the new Chrome as launchd's child (`argv` changes its arguments: a lost flag), and records each call. */
function fakeMac(w: World, o: { argv?: (args: string[]) => string[]; onOpen?: (profile: string, pid: number) => void } = {}) {
  const calls: { bundle: string; args: string[]; front: boolean }[] = [], guards: string[] = [];
  const mac: MacStart = {
    app: (bin) => ({ binary: bin || CHROME_STABLE_BIN, bundle: APP, version: "158.0.8127.37", google: !bin }),
    open: async (bundle, args, how) => {
      calls.push({ bundle, args, front: how?.front === true });
      const p = w.add({ argv: [CHROME_STABLE_BIN, ...(o.argv ? o.argv(args) : args)], ppid: 1 });
      const profile = args.find((a) => a.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
      o.onOpen?.(profile, p.pid);
      return 0;
    },
    guard: async (bundle) => { guards.push(`begin ${bundle}`); return { finish: async (ms) => { guards.push(`finish ${ms}`); } }; },
    blanketPackage: () => { const folder = join(w.paths.state, BLANKET_PACKAGE_FOLDER); mkdirSync(folder, { recursive: true }); return { folder, version: "0.3.16", written: true }; },
  };
  return { mac, calls, guards };
}

/** Chrome's write of a load into a profile (the operator's Load unpacked): the entry and developer mode, only in Secure Preferences (M2). */
function writeLoad(profile: string, pkg: string, o: { dev?: boolean; reasons?: number[]; location?: number; noEntry?: boolean; others?: Record<string, unknown> } = {}): void {
  mkdirSync(join(profile, "Default"), { recursive: true });
  const entry = { path: pkg, location: o.location ?? 4, ...(o.reasons ? { disable_reasons: o.reasons } : {}), service_worker_registration_info: { version: "0.3.16" } };
  const secure = { extensions: { settings: { ...(o.noEntry ? {} : { [RECEIVER_ID]: entry }), ...o.others }, ui: { developer_mode: o.dev ?? true } }, protection: { macs: { extensions: { ui: { developer_mode: "AB" } } }, super_mac: "CD" } };
  writeFileSync(join(profile, "Default", "Secure Preferences"), JSON.stringify(secure));
}

/** An entry of a second unpacked extension (not the receiver, not one of Chrome's own). */
const OTHER_UNPACKED = { aaaabbbbccccddddeeeeffffgggghhhh: { location: 4, path: "/tmp/other" } };

class FakeProxy implements BlanketProxy {
  readonly events: string[] = [];
  next = 41000;
  private on = false;
  async start() { this.events.push("start"); this.on = true; return ++this.next; }
  async stop() { if (this.on) this.events.push("stop"); this.on = false; }
  listening() { return this.on; }
}

function templateIn(w: World, f: ReturnType<typeof fakeMac>, o: { sleep?: (ms: number) => Promise<void> } = {}) {
  const u = new ChromeUnit(w.deps(new FakeTools(), { mac: f.mac }));
  u.config = { ...CONFIG };
  const proxy = new FakeProxy();
  const t = new BlanketTemplate({
    state: w.paths.state, procs: w.procs, launch: (p, e) => u.macBlanketLaunch(p, e), open: (b, a, how) => f.mac.open(b, a, how),
    writePackage: () => { f.mac.blanketPackage!(); }, proxy, log: (l) => w.logs.push(l), kill: (p, s) => w.kill(p, s),
    clock: () => w.now, sleep: o.sleep ?? ((ms) => w.sleep(ms)), foldCase: false,
  });
  return { u, t, proxy, pkg: join(w.paths.state, BLANKET_PACKAGE_FOLDER) };
}

test("the blanket template's set-up: the blanket Chrome stops first, the package folder, a new template folder, the set-up Chrome through open -n (no -g) on a closed proxy; the operator's load makes it ready, and the set-up Chrome stops", async () => {
  const w = new World();
  try {
    const f = fakeMac(w, { onOpen: (profile) => { if (profile.endsWith(join("blanket-template", "profile"))) writeLoad(profile, join(w.paths.state, BLANKET_PACKAGE_FOLDER)); } });
    const { t, proxy, pkg } = templateIn(w, f);
    assert.equal(t.state(), "none");
    assert.equal(t.startRefusal(), TEMPLATE_START.none);
    assert.deepEqual(t.notes(false), [], "no blanket item: no sentence");
    assert.deepEqual(t.notes(true), [TEMPLATE_TEXT.none(pkg)], "the real absolute path of the package folder");
    assert.ok(TEMPLATE_TEXT.none(pkg).includes(`choose the folder ${pkg} (Command-Shift-G`) && TEMPLATE_TEXT.none(pkg).includes("in the Chrome window that opens on this Mac's screen"));
    // A leftover file in an old template folder goes with the folder.
    mkdirSync(join(t.profile, "Default"), { recursive: true });
    writeFileSync(join(t.profile, "Default", "Cookies"), "leftover");
    const order: string[] = [];
    t.setup(async () => { order.push("blanket stopped"); });
    assert.equal(t.state(), "setting_up");
    assert.equal(t.startRefusal(), TEMPLATE_START.settingUp);
    assert.deepEqual(t.notes(false), [TEMPLATE_TEXT.settingUp(pkg)]);
    await t.running();
    assert.equal(t.state(), "ready", w.logs.join("\n"));
    assert.equal(t.startRefusal(), null);
    assert.deepEqual(t.notes(true), []);
    assert.deepEqual(order, ["blanket stopped"]);
    assert.equal(f.calls.length, 1);
    const call = f.calls[0];
    assert.equal(call.front, true, "no -g: the window of the operator's load comes forward");
    assert.equal(call.args[0], `--user-data-dir=${t.profile}`);
    for (const a of AGENT_ARGS) assert.ok(call.args.includes(a), a);
    const flags = proxyFlags(proxy.next);
    assert.deepEqual(call.args.slice(call.args.indexOf(flags[0]), call.args.indexOf(flags[0]) + 5), [...flags, "--force-dark-mode"], "the closed proxy's flags, then the config's chrome_args");
    assert.deepEqual(proxy.events, ["start", "stop"], "the closed proxy lives only with the set-up Chrome");
    assert.equal(w.named("Google Chrome").length, 0, "the set-up Chrome stopped");
    assert.ok(!existsSync(join(t.profile, "Default", "Cookies")), "the template folder is new");
    assert.ok(existsSync(pkg), "the package folder");
    const prefs = JSON.parse(readFileSync(join(t.profile, "Default", "Preferences"), "utf8"));
    assert.equal(prefs.credentials_enable_service, false);
    assert.equal(prefs.extensions, undefined, "no extension key");
    // The service's next start reads the files again: the template stays ready.
    const again = templateIn(w, f).t;
    assert.equal(again.state(), "ready");
  } finally { w.close(); }
});

test("a set-up that fails: no load in 10 minutes, a set-up Chrome that closes first, another folder, Developer mode off, an extension that Chrome turned off; each with its reason and sentence; a second blanket_setup while one runs changes nothing", async () => {
  const cases: { name: string; load?: (profile: string, pkg: string) => void; quit?: boolean; reason: string }[] = [
    { name: "no load", reason: SETUP_REASON.timeout },
    { name: "closed", quit: true, reason: SETUP_REASON.closed },
    { name: "folder", load: (p) => { mkdirSync(join(p, "..", "..", "elsewhere"), { recursive: true }); writeLoad(p, join(p, "..", "..", "elsewhere")); }, reason: SETUP_REASON.folder },
    { name: "dev", load: (p, pkg) => writeLoad(p, pkg, { dev: false }), reason: SETUP_REASON.devOff },
    { name: "off", load: (p, pkg) => writeLoad(p, pkg, { reasons: [16777216] }), reason: SETUP_REASON.off([16777216]) },
  ];
  for (const c of cases) {
    const w = new World();
    try {
      let setupPid = 0;
      const f = fakeMac(w, { onOpen: (profile, pid) => { setupPid = pid; c.load?.(profile, join(w.paths.state, BLANKET_PACKAGE_FOLDER)); } });
      const { t } = templateIn(w, f, { sleep: async (ms) => { await w.sleep(ms); if (c.quit && ms === 5000 && w.alive(setupPid)) w.end(setupPid); } });
      t.setup(async () => {});
      t.setup(async () => {});
      await t.running();
      assert.equal(f.calls.length, 1, `${c.name}: one set-up Chrome`);
      assert.equal(t.state(), "failed", c.name);
      assert.deepEqual(t.notes(true), [TEMPLATE_TEXT.failed(c.reason)], c.name);
      assert.equal(t.startRefusal(), TEMPLATE_START.none, c.name);
      assert.equal(w.named("Google Chrome").length, 0, `${c.name}: the set-up Chrome stopped`);
    } finally { w.close(); }
  }
});

test("the Mac start: the template's copy in a new blanket folder, open -n -g with the address proxy's flags before chrome_args, the found main process held by pid and start time, the guard and the watcher; the agent Chrome's arguments hold no proxy flag", async () => {
  const w = new World();
  try {
    const f = fakeMac(w);
    const { u, t, pkg } = templateIn(w, f);
    const B = blanketPaths(w.paths.state, join(w.dir, "run", "link.sock"));
    const proxy = new FakeProxy(), ticks: unknown[] = [];
    let hostFiles = 0, packages = 0;
    const chrome = new BlanketChrome({
      paths: B, procs: w.procs, log: (l) => w.logs.push(l), launch: () => null, proxy, hostFiles: () => { hostFiles++; }, kill: (p, s) => w.kill(p, s), clock: () => w.now, sleep: (ms) => w.sleep(ms),
      mac: { launch: (p, e) => u.macBlanketLaunch(p, e), open: (b, a) => f.mac.open(b, a), guard: (b) => f.mac.guard(b), template: t, writePackage: () => { packages++; f.mac.blanketPackage!(); }, watcher: { tick: (c) => ticks.push(c), stop: () => ticks.push("stop") } },
    });
    // No template: the start fails before any open, proxy or folder.
    await assert.rejects(chrome.start("bl"), new RegExp(TEMPLATE_START.none.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual([f.calls.length, proxy.events.length, existsSync(B.root)], [0, 0, false]);
    // The operator's load in the template (as its set-up leaves it).
    mkdirSync(pkg, { recursive: true });
    writeLoad(t.profile, pkg);
    writeFileSync(join(t.profile, "Default", "Preferences"), JSON.stringify({ profile: { name: "Template" }, browser: { has_seen_welcome_page: true } }));
    writeFileSync(join(t.profile, "Default", "Cookies"), "never copied");
    assert.ok(t.refresh());
    await chrome.start("bl");
    // The copy: Secure Preferences byte for byte; Preferences with the folder's keys, no extension key; nothing else.
    assert.deepEqual(readFileSync(join(B.profile, "Default", "Secure Preferences")), readFileSync(join(t.profile, "Default", "Secure Preferences")));
    const prefs = JSON.parse(readFileSync(join(B.profile, "Default", "Preferences"), "utf8"));
    assert.equal(prefs.download.default_directory, B.downloads);
    assert.equal(prefs.profile.name, "Template", "the template's own keys stay");
    assert.equal(prefs.profile.password_manager_enabled, false);
    assert.equal(prefs.extensions, undefined, "no extension key in the copy's Preferences");
    assert.ok(!existsSync(join(B.profile, "Default", "Cookies")), "only the two files are copied");
    assert.ok(checkLoad(B.profile, pkg, false).ok, "the copy holds the load");
    assert.deepEqual([hostFiles, packages], [1, 1]);
    // open -n -g: the blanket profile, the flags before the config's chrome_args, about:blank last.
    assert.equal(f.calls.length, 1);
    const { args, front } = f.calls[0];
    assert.equal(front, false, "-g: the blanket Chrome takes no focus");
    const flags = proxyFlags(proxy.next);
    assert.deepEqual(args, macChromeArgs(B.profile, u.config!, 1280, 900, flags));
    assert.deepEqual(args.slice(args.indexOf(flags[0]), args.indexOf(flags[0]) + 5), [...flags, "--force-dark-mode"]);
    assert.deepEqual(f.guards, [`begin ${APP}`, "finish 10000"]);
    const main = w.named("Google Chrome")[0];
    assert.deepEqual(chrome.chromeId(), { pid: main.pid, start: main.start });
    assert.deepEqual(ticks, [{ pid: main.pid, start: main.start }], "the give-back watcher runs for it");
    assert.deepEqual(chrome.macApp(), { binary: CHROME_STABLE_BIN, bundle: APP });
    // The agent Chrome on the Mac: the same flags with no proxy flag.
    assert.deepEqual(macChromeArgs(w.paths.profile, u.config!, 1280, 900).filter((a) => /proxy|webrtc|quic/i.test(a)), []);
    await u.start();
    const agent = f.calls.at(-1)!.args;
    assert.equal(agent[0], `--user-data-dir=${w.paths.profile}`);
    assert.deepEqual(agent.filter((a) => /proxy|webrtc|quic/i.test(a)), [], "the agent Chrome never gets the flags");
    // The stop: the process ends, the proxy and the watcher stop, the folder stays; the next start reuses it.
    assert.equal(await chrome.stop(), true);
    assert.ok(!w.alive(main.pid));
    assert.deepEqual(proxy.events, ["start", "stop"]);
    assert.equal(ticks.at(-1), "stop");
    writeFileSync(join(B.profile, "Default", "Cookies"), "session cookie");
    await chrome.start("bl");
    assert.ok(existsSync(join(B.profile, "Default", "Cookies")), "a start after a stop of the same scope reuses the folder");
    await chrome.end();
    assert.ok(!existsSync(B.root));
  } finally { w.close(); }
});

test("the flags check: a blanket Chrome whose arguments lack a proxy flag, or name another port, stops, and the start fails closed with its reason", async () => {
  for (const change of [(a: string[]) => a.filter((x) => !x.startsWith("--proxy-server=")), (a: string[]) => a.map((x) => (x.startsWith("--proxy-server=") ? "--proxy-server=socks5://127.0.0.1:9" : x)),
    (a: string[]) => [...a, "--proxy-server=direct://"]]) {
    const w = new World();
    try {
      const f = fakeMac(w, { argv: change });
      const { u, t, pkg } = templateIn(w, f);
      mkdirSync(pkg, { recursive: true });
      writeLoad(t.profile, pkg);
      writeFileSync(join(t.profile, "Default", "Preferences"), "{}");
      t.refresh();
      const B = blanketPaths(w.paths.state, join(w.dir, "run", "link.sock"));
      const proxy = new FakeProxy();
      const chrome = new BlanketChrome({ paths: B, procs: w.procs, log: (l) => w.logs.push(l), launch: () => null, proxy, hostFiles: () => {}, kill: (p, s) => w.kill(p, s), clock: () => w.now, sleep: (ms) => w.sleep(ms),
        mac: { launch: (p, e) => u.macBlanketLaunch(p, e), open: (b, a) => f.mac.open(b, a), template: t, writePackage: () => {} } });
      await assert.rejects(chrome.start("bl"), new RegExp(MAC_FLAGS_TEXT.replace(/'/g, "'")));
      assert.equal(w.named("Google Chrome").length, 0, "that Chrome stopped");
      assert.ok(w.signals.some(([, s]) => s === "SIGTERM"));
      assert.equal(chrome.running(), false);
      assert.deepEqual(proxy.events, ["start", "stop"], "the proxy stops with the failed start");
    } finally { w.close(); }
  }
  assert.ok(holdsFlags(["/x", ...proxyFlags(5), "about:blank"], proxyFlags(5)));
  assert.ok(!holdsFlags(["/x", ...proxyFlags(5), "-Proxy-Server=socks5://h:1"], proxyFlags(5)), "another value of a switch in any form that Chrome reads");
});

// ------------------------------------------------------------------ the address proxy on the Mac

/** Fake libSystem reads for the socket scan: processes with their parent, real uid and start, and their sockets. */
function fakeReads(procs: Record<number, { ppid: number; ruid: number; start: number; sockets?: (() => MacSocket)[] }>) {
  return {
    allPids: () => Object.keys(procs).map(Number),
    bsd: (pid: number): BsdInfo | null => (procs[pid] ? { status: 2, ppid: procs[pid].ppid, uid: procs[pid].ruid, ruid: procs[pid].ruid, pgid: pid, start: procs[pid].start } : null),
    socketFds: (pid: number) => (procs[pid]?.sockets ?? []).map((_, i) => i + 3),
    socket: (pid: number, fd: number) => procs[pid]?.sockets?.[fd - 3]?.() ?? null,
  };
}
const sock = (local: string, remote: string, handle: bigint) => () => ({ local, remote, uid: 0, handle });

test("the Mac's peer check reads only the blanket Chrome's own sockets: its main process and its children, by the held start time; another process's socket, also of the same uid, gives no line, and a helper of another uid gives no match", () => {
  const UID = 501;
  const reads = fakeReads({
    100: { ppid: 1, ruid: UID, start: 5, sockets: [sock("127.0.0.1:50000", "127.0.0.1:9000", 1n)] },
    101: { ppid: 100, ruid: UID, start: 6, sockets: [sock("127.0.0.1:50001", "127.0.0.1:9000", 2n)] },
    102: { ppid: 100, ruid: 502, start: 7, sockets: [sock("127.0.0.1:50002", "127.0.0.1:9000", 3n)] },
    200: { ppid: 1, ruid: UID, start: 8, sockets: [sock("127.0.0.1:50003", "127.0.0.1:9000", 4n)] },
    201: { ppid: 200, ruid: UID, start: 9, sockets: [sock("127.0.0.1:50004", "127.0.0.1:9000", 5n)] },
  });
  const lines = macTreeTcpReader(reads, () => ({ pid: 100, start: 5 }))()!;
  assert.deepEqual(lines.map((l) => [l.local, l.uid]).sort(), [["127.0.0.1:50000", UID], ["127.0.0.1:50001", UID], ["127.0.0.1:50002", 502]]);
  assert.equal(macTreeTcpReader(reads, () => ({ pid: 100, start: 99 }))(), null, "a pid used again: no line");
  assert.equal(macTreeTcpReader(reads, () => null)(), null, "no blanket Chrome held: no line");
  assert.equal(macTreeTcpReader({ ...reads, allPids: () => null }, () => ({ pid: 100, start: 5 }))(), null, "the processes cannot be listed");
  // A socket that a helper of another uid also holds: the line's uid matches no user.
  const shared = fakeReads({ 100: { ppid: 1, ruid: UID, start: 5, sockets: [sock("127.0.0.1:1", "127.0.0.1:2", 7n)] }, 101: { ppid: 100, ruid: 502, start: 6, sockets: [sock("127.0.0.1:1", "127.0.0.1:2", 7n)] } });
  assert.equal(macTreeTcpReader(shared, () => ({ pid: 100, start: 5 }))()![0].uid, MAC_NO_UID);
});

/** One SOCKS5 greeting on `port`: the first bytes of the answer, or "closed". */
function greet(port: number, bytes: number[], until = 2): Promise<{ client: Socket; got: Buffer | "closed" }> {
  return new Promise((resolve) => {
    const client = createConnection({ host: "127.0.0.1", port });
    let got = Buffer.alloc(0);
    client.on("connect", () => client.write(Buffer.from(bytes)));
    client.on("data", (d: Buffer) => { got = Buffer.concat([got, d]); if (got.length >= until) resolve({ client, got }); });
    client.on("close", () => resolve({ client, got: got.length ? got : "closed" }));
    client.on("error", () => {});
  });
}

test("the address proxy with the Mac's reader: an exact socket of the blanket Chrome's tree passes to the handshake, the same client seen in another process is refused; the closed mode answers each CONNECT 02 with no lookup", async () => {
  const UID = process.getuid!();
  let owner = 101, portNow = 0;
  const clientPorts: number[] = [];
  const reads = fakeReads({
    100: { ppid: 1, ruid: UID, start: 5 },
    101: { ppid: 100, ruid: UID, start: 6, sockets: [() => (owner === 101 && clientPorts.length ? { local: `127.0.0.1:${clientPorts.at(-1)}`, remote: `127.0.0.1:${portNow}`, uid: 0, handle: 1n } : null as unknown as MacSocket)] },
    200: { ppid: 1, ruid: UID, start: 7, sockets: [() => (owner === 200 && clientPorts.length ? { local: `127.0.0.1:${clientPorts.at(-1)}`, remote: `127.0.0.1:${portNow}`, uid: 0, handle: 2n } : null as unknown as MacSocket)] },
  });
  const logs: string[] = [];
  const tree = macTreeTcpReader(reads, () => ({ pid: 100, start: 5 }));
  // The client's port is known only after its connect: the reader sees it at the accept.
  const proxy = new AddressProxy({ log: (l) => logs.push(l), uid: UID, tcp: () => { const l = tree(); return l; }, resolve: async () => { throw new Error("no lookup"); } });
  portNow = await proxy.start();
  // Each client binds a port picked before its connect, so the fake socket names it at the proxy's accept.
  const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
  try {
    clientPorts.push(await freePort());
    const pass = await new Promise<Buffer | "closed">((resolve) => {
      const c = createConnection({ host: "127.0.0.1", port: portNow, localAddress: "127.0.0.1", localPort: clientPorts.at(-1) }, () => { c.write(Buffer.from([5, 1, 0])); });
      let got = Buffer.alloc(0);
      c.on("data", (d: Buffer) => { got = Buffer.concat([got, d]); if (got.length >= 2) { c.destroy(); resolve(got); } });
      c.on("close", () => resolve(got.length ? got : "closed"));
      c.on("error", () => {});
    });
    assert.deepEqual(pass, Buffer.from([5, 0]), "the blanket Chrome's own socket: the greeting's answer");
    owner = 200;
    clientPorts.push(await freePort());
    const refused = await new Promise<Buffer | "closed">((resolve) => {
      const c = createConnection({ host: "127.0.0.1", port: portNow, localAddress: "127.0.0.1", localPort: clientPorts.at(-1) }, () => { c.write(Buffer.from([5, 1, 0])); });
      let got = Buffer.alloc(0);
      c.on("data", (d: Buffer) => { got = Buffer.concat([got, d]); });
      c.on("close", () => resolve(got.length ? got : "closed"));
      c.on("error", () => {});
    });
    assert.equal(refused, "closed", "a socket of another process of the same uid: no answer");
    assert.ok(logs.some((l) => l.includes("it is not a process of the service's user")));
  } finally { await proxy.stop(); }
  // The closed mode (the set-up Chrome): the greeting passes, each CONNECT gets 02, and no lookup runs.
  let lookups = 0;
  const closed = new AddressProxy({ log: () => {}, closed: true, tcp: () => null, resolve: async () => { lookups++; return ["93.184.216.34"]; } });
  const port = await closed.start();
  try {
    const host = Buffer.from("example.com");
    const { client, got } = await greet(port, [5, 1, 0, 5, 1, 0, 3, host.length, ...host, 1, 187], 12);
    client.destroy();
    assert.ok(got !== "closed");
    assert.deepEqual([...(got as Buffer).subarray(0, 4)], [5, 0, 5, 2], "the greeting, then the reply 02");
    assert.equal(lookups, 0);
    assert.equal(closed.counts().refused, 1);
  } finally { await closed.stop(); }
});

// ------------------------------------------------------------------ the versions

test("the versions: a Chrome on a profile inside the state folder (the blanket Chrome, the set-up Chrome) is never the operator's Chrome; the blanket Chrome's own version reads as the agent's of its pid", () => {
  const w = new World();
  try {
    const app = { binary: CHROME_STABLE_BIN, bundle: APP };
    const helper = (v: string, kind: string) => `${APP}/Contents/Frameworks/Google Chrome Framework.framework/Versions/${v}/Helpers/Google Chrome Helper (${kind}).app/Contents/MacOS/Google Chrome Helper (${kind})`;
    const agent = w.add({ argv: [CHROME_STABLE_BIN, `--user-data-dir=${w.paths.profile}`], ppid: 1 });
    const blanket = w.add({ argv: [CHROME_STABLE_BIN, `--user-data-dir=${join(w.paths.state, "blanket", "profile")}`], ppid: 1 });
    // The set-up Chrome's argument in another case: the Mac's disk ignores case, so the rule does too.
    const setup = w.add({ argv: [CHROME_STABLE_BIN, `--user-data-dir=${join(w.paths.state.toUpperCase(), "blanket-template", "profile")}`], ppid: 1 });
    const operator = w.add({ argv: [CHROME_STABLE_BIN], ppid: 1 });
    w.add({ argv: [helper("158.0.8127.37", "Renderer"), "--type=renderer"], ppid: agent.pid });
    w.add({ argv: [helper("159.0.1.1", "Renderer"), "--type=renderer"], ppid: blanket.pid });
    w.add({ argv: [helper("159.0.2.2", "GPU"), "--type=gpu-process"], ppid: setup.pid });
    w.add({ argv: [helper("158.0.8127.50", "GPU"), "--type=gpu-process"], ppid: operator.pid });
    // The old call: the blanket Chrome's helper came first, so it read as the operator's Chrome.
    assert.equal(chromeVersions(w.procs, app, agent.pid, w.paths.profile).operator, "159.0.1.1", "the bug of the old call");
    assert.deepEqual(chromeVersions(w.procs, app, agent.pid, w.paths.profile, w.paths.state), { agent: "158.0.8127.37", operator: "158.0.8127.50" });
    assert.deepEqual(chromeVersions(w.procs, app, blanket.pid, join(w.paths.state, "blanket", "profile"), w.paths.state), { agent: "159.0.1.1", operator: "158.0.8127.50" });
    w.end(operator.pid);
    assert.deepEqual(chromeVersions(w.procs, app, agent.pid, w.paths.profile, w.paths.state), { agent: "158.0.8127.37", operator: null }, "with no operator's Chrome, none");
  } finally { w.close(); }
});

// ------------------------------------------------------------------ the part: the op, the feature, status, the off read, the version stop

class FakePort implements BlanketPort {
  events!: ReceiverEvents;
  up = false;
  feats = new Set(["scopes", "bridge", "blanket"]);
  readonly lines: AllowlistLine[] = [];
  attach(e: ReceiverEvents) { this.events = e; }
  isUp() { return this.up; }
  features() { return this.feats; }
  async request(): Promise<Record<string, unknown>> { return { rules: 1, closed: 0, refused: 0 }; }
  allowlist(line: AllowlistLine) { this.lines.push(line); }
  endScope() {}
}
class FakeChrome {
  runs = false;
  readonly calls: string[] = [];
  readonly paths: { profile: string };
  constructor(profile: string) { this.paths = { profile }; }
  running() { return this.runs; }
  async start(scope: string) { this.calls.push(`start ${scope}`); this.runs = true; }
  async stop() { this.calls.push("stop"); this.runs = false; return true; }
  async end() { this.calls.push("end"); this.runs = false; }
}
const sess = (scope: string, blanket?: boolean) => ({ scope, repo: "a/b", roots: [{ pid: 101, start: 5000 }], cgroup: null, lifetime_id: `lt-${scope}`, mcp_token: null, ...(blanket === undefined ? {} : { blanket }) });

function partRig(o: { template?: BlanketTemplate | null; newer?: () => string | null; use?: { inUse: boolean; quietFor: number }; profile?: string } = {}) {
  const port = new FakePort(), chrome = new FakeChrome(o.profile ?? "/nonexistent/profile"), logs: string[] = [];
  let now = 0;
  const part = new BlanketPart({
    chrome: chrome as unknown as BlanketChrome, port, model: () => ({ notReady: () => null, named: () => true }), removeCopy: () => {}, log: (l) => logs.push(l),
    helloWaitMs: 200, readyWaitMs: 200, clock: () => now, sleep: async (ms) => { now += ms; await settle(); },
    ...(o.template ? { template: o.template } : {}), ...(o.newer ? { newerVersion: o.newer, versionEveryMs: 0 } : {}),
    idle: { ms: () => 60_000, use: () => o.use ?? { inUse: false, quietFor: 0 }, everyMs: 1 << 30 },
  });
  const svc = new Stage1a({ agentDoor: { url: (s) => `ws+unix:///x/cdp.sock:/devtools/browser/${s}`, state: () => ({ form: "pidfd" }) }, parts: [part] });
  let n = 0;
  // As the control door: C12's checks (the op, the shape, the kind), then the handler.
  const req = async (op: string, kind = "daemon", fields: Record<string, unknown> = {}) => {
    const line = { t: "req", id: `r${++n}`, op, by: { kind, user: "ann", via: kind === "daemon" ? "daemon" : "web" }, ...fields };
    const error = checkRequest(line, (x) => svc.has(x));
    return error !== null ? { error } : await (svc.handle(line as any) as any);
  };
  return { port, chrome, logs, part, svc, req, done: () => part.stop() };
}

test("the hello's feature blanket_setup and the op on the Mac only: the operator's op answers at once and starts the set-up; without the template (Linux) the op is unsupported and the hello has no feature, status has no key, and the part is unchanged", async () => {
  const w = new World();
  try {
    const f = fakeMac(w, { onOpen: (profile) => writeLoad(profile, join(w.paths.state, BLANKET_PACKAGE_FOLDER)) });
    const { t, pkg } = templateIn(w, f);
    const mac = partRig({ template: t });
    assert.deepEqual(mac.svc.hello.features, [BLANKET_FEATURE, SETUP_FEATURE].filter((x) => (mac.svc.hello.features as string[]).includes(x)));
    assert.ok((mac.svc.hello.features as string[]).includes(SETUP_FEATURE));
    // status: the key, and the sentence only while a local item has a blanket approval.
    let st = await mac.req("status");
    assert.equal(st.data.blanket_template, "none");
    assert.ok(!st.data.operator_text.includes("The blanket profile is not set up on this Mac."));
    await mac.req("set_sessions", "daemon", { sessions: [sess("b1", true)], remote: [], box: { hosts: [], cookie_names: [] } });
    st = await mac.req("status");
    assert.ok(st.data.operator_text.includes(TEMPLATE_TEXT.none(pkg)), st.data.operator_text);
    // The op: only the operator's kind; the daemon's gets the kind refusal.
    assert.deepEqual(await mac.req("blanket_setup", "daemon"), { error: "not the operator" });
    assert.deepEqual(await mac.req("blanket_setup", "token"), { error: "not the operator" }, "an agent's token never sets it up");
    const res = await mac.req("blanket_setup", "operator");
    assert.deepEqual(res, { data: {} });
    assert.equal((await mac.req("status")).data.blanket_template, "setting_up");
    await t.running();
    await settle();
    st = await mac.req("status");
    assert.equal(st.data.blanket_template, "ready");
    assert.ok(!st.data.operator_text.includes("blanket profile is not set up"));
    mac.done();
    // Linux: no template.
    const linux = partRig();
    assert.ok(!(linux.svc.hello.features as string[]).includes(SETUP_FEATURE));
    assert.ok((linux.svc.hello.features as string[]).includes(BLANKET_FEATURE));
    assert.deepEqual(await linux.req("blanket_setup", "operator"), { error: "unsupported" });
    assert.ok(!Object.hasOwn((await linux.req("status")).data, "blanket_template"));
    assert.deepEqual(linux.part.ops, {});
    assert.deepEqual(linux.part.status(), {});
    linux.done();
  } finally { w.close(); }
});

test("the off read: a blanket start on the Mac whose receiver says no hello reads the copy after the stop; Chrome turned the receiver off there, so the template goes and the start fails with its reason; status says to set it up again", async () => {
  const w = new World();
  try {
    const f = fakeMac(w);
    const { t, pkg } = templateIn(w, f);
    mkdirSync(pkg, { recursive: true });
    writeLoad(t.profile, pkg);
    writeFileSync(join(t.profile, "Default", "Preferences"), "{}");
    assert.ok(t.refresh());
    const copy = join(w.dir, "copy");
    writeLoad(copy, pkg, { reasons: [16777216] });
    writeFileSync(join(copy, "Default", "Preferences"), "{}");
    const r = partRig({ template: t, profile: copy });
    await r.req("set_sessions", "daemon", { sessions: [sess("b1", true)], remote: [], box: { hosts: [], cookie_names: [] } });
    const why = await r.part.wake("b1", async () => null);
    assert.equal(why, useFailed(BLANKET_TEXT.macOff));
    assert.deepEqual(r.chrome.calls, ["start b1", "stop"], "the stop comes before the read");
    assert.equal(t.state(), "none");
    assert.ok(!existsSync(t.root), "the template is deleted");
    const st = await r.req("status");
    assert.ok(st.data.operator_text.includes(`${TEMPLATE_TEXT.offLead}${TEMPLATE_TEXT.none(pkg)}`), st.data.operator_text);
    assert.ok(st.data.operator_text.includes(BLANKET_TEXT.failed("b1", BLANKET_TEXT.macOff)));
    r.done();
    // A copy that still holds the load (a slow receiver): no off read, the template stays, the old reason.
    writeLoad(t.profile, pkg);
    writeFileSync(join(t.profile, "Default", "Preferences"), "{}");
    t.refresh();
    const good = join(w.dir, "good");
    writeLoad(good, pkg);
    writeFileSync(join(good, "Default", "Preferences"), "{}");
    const r2 = partRig({ template: t, profile: good });
    await r2.req("set_sessions", "daemon", { sessions: [sess("b1", true)], remote: [], box: { hosts: [], cookie_names: [] } });
    assert.equal(await r2.part.wake("b1", async () => null), useFailed(BLANKET_TEXT.noHello));
    assert.equal(t.state(), "ready");
    r2.done();
  } finally { w.close(); }
});

test("the version stop on the Mac: a newer version of the operator's Chrome stops the blanket Chrome at a moment with no use, and its folder stays; with a use it waits", async () => {
  let newer: string | null = "the operator's Chrome runs 159.0.1.1 and 159.0.1.1 is on disk, newer than the blanket Chrome's 158.0.8127.37";
  const busy = partRig({ newer: () => newer, use: { inUse: true, quietFor: 0 } });
  busy.chrome.runs = true;
  busy.part.idleCheck();
  await settle();
  assert.deepEqual(busy.chrome.calls, [], "an agent uses it: no stop");
  busy.done();
  const r = partRig({ newer: () => newer });
  r.chrome.runs = true;
  r.port.up = true;
  r.part.idleCheck();
  await settle(); await settle();
  assert.deepEqual(r.chrome.calls, ["stop"], "a stop, not an end: the folder stays");
  assert.ok(r.logs.some((l) => l.includes("the next use starts the new version")));
  newer = null;
  r.chrome.runs = true;
  r.part.idleCheck();
  await settle();
  assert.deepEqual(r.chrome.calls, ["stop"], "no newer version: no stop");
  r.done();
});

// ------------------------------------------------------------------ stop --all and the open of the set-up

test("`service stop --all` on the Mac: the set-up Chrome on the template's profile stops too; a state folder with no unit record but with agent-package-blanket is the service's, so its blanket folder goes; the template stays", async () => {
  const w = new World();
  try {
    const B = blanketPaths(w.paths.state, join(w.dir, "run", "link.sock"));
    mkdirSync(B.profile, { recursive: true });
    const tplProfile = join(w.paths.state, "blanket-template", "profile");
    mkdirSync(tplProfile, { recursive: true });
    assert.match(stateFolderRefusal(w.paths.state, w.uid, "darwin")!, /it holds no record of the Chrome unit, unit\.json/, "the old reason with neither");
    mkdirSync(join(w.paths.state, BLANKET_PACKAGE_FOLDER));
    assert.equal(stateFolderRefusal(w.paths.state, w.uid, "darwin"), null);
    // The review's m3: on Linux (which never writes that folder) it marks no state folder.
    assert.match(stateFolderRefusal(w.paths.state, w.uid, "linux")!, /it holds no record of the Chrome unit, unit\.json/);
    const blanket = w.add({ argv: [CHROME_STABLE_BIN, `--user-data-dir=${B.profile}`] });
    const setup = w.add({ argv: [CHROME_STABLE_BIN, `--user-data-dir=${tplProfile}`] });
    const other = w.add({ argv: [CHROME_STABLE_BIN, `--user-data-dir=${join(w.dir, "elsewhere")}`] });
    const stopped = await stopAll({ paths: w.paths, procs: w.procs, kill: (p, s) => w.kill(p, s), clock: () => w.now, sleep: (ms) => w.sleep(ms), platform: "darwin" });
    assert.deepEqual(stopped.map(([n, p]) => [n, p]).sort(), [["Chrome", blanket.pid], ["Chrome", setup.pid]].sort());
    assert.ok(!w.alive(blanket.pid) && !w.alive(setup.pid) && w.alive(other.pid));
    assert.ok(!existsSync(B.root), "the blanket folder goes");
    assert.ok(existsSync(tplProfile), "the template stays");
  } finally { w.close(); }
});

test("MacStart.open with front leaves out -g (the set-up Chrome's window for the operator's load); without it, -g as before", async () => {
  const home = tempDir("ab-mac-open-");
  try {
    const out = join(home, "open-args.txt"), openBin = join(home, "open");
    writeFileSync(openBin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${out}'\n`);
    chmodSync(openBin, 0o700);
    const m = macStart({ state: home, home, openBin });
    assert.equal(await m.open(APP, ["--user-data-dir=/p", "about:blank"], { front: true }), 0);
    assert.equal(readFileSync(out, "utf8"), ["-n", "-a", APP, "--args", "--user-data-dir=/p", "about:blank", ""].join("\n"));
    assert.equal(await m.open(APP, ["--user-data-dir=/p"]), 0);
    assert.equal(readFileSync(out, "utf8"), ["-n", "-g", "-a", APP, "--args", "--user-data-dir=/p", ""].join("\n"));
    // The package folder of the blanket template: agent-package-blanket in the state folder.
    assert.equal(BLANKET_PACKAGE_FOLDER, "agent-package-blanket");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ the vectors

const control = JSON.parse(readFileSync(new URL("./vectors/control.json", import.meta.url), "utf8"));

test("the vectors' blanketSetup lines: the Mac's service with the part answers each request through C12's checks; its status key takes the vectors' states; the sentences are the code's", async () => {
  const V = control.blanketSetup;
  const w = new World();
  try {
    const f = fakeMac(w, { onOpen: (profile) => writeLoad(profile, join(w.paths.state, BLANKET_PACKAGE_FOLDER)) });
    const { t } = templateIn(w, f);
    const r = partRig({ template: t });
    assert.ok((r.svc.hello.features as string[]).includes(V.feature));
    for (const v of V.requests) {
      const error = checkRequest(v.req, (x) => r.svc.has(x));
      const got = error !== null ? { t: "res", id: v.req.id, ok: false, error } : { t: "res", id: v.req.id, ok: true, ...(await (r.svc.handle(v.req) as any)) };
      assert.deepEqual(got, v.res, v.note);
    }
    await t.running();
    assert.ok(V.states.includes((await r.req("status")).data[V.statusKey]));
    assert.deepEqual(V.states, ["none", "setting_up", "ready", "failed"]);
    assert.deepEqual(V.sentences, { none: TEMPLATE_TEXT.none("<folder>"), offLead: TEMPLATE_TEXT.offLead, settingUp: TEMPLATE_TEXT.settingUp("<folder>"), failed: TEMPLATE_TEXT.failed("<reason>") });
    r.done();
    const linux = partRig();
    for (const v of V.withoutFeature) assert.deepEqual({ t: "res", id: v.req.id, ok: false, ...(await linux.req(v.req.op, v.req.by.kind)) }, v.res, v.note);
    linux.done();
  } finally { w.close(); }
});

test("a Mac start that finds two Chromes on the blanket profile, or one that does not run the app, stops each of them and fails closed; so does a set-up whose find fails", async () => {
  for (const what of ["two", "other app"] as const) {
    const w = new World();
    try {
      const f = fakeMac(w, { onOpen: (profile) => {
        if (what === "two") w.add({ argv: [CHROME_STABLE_BIN, `--user-data-dir=${profile}`], ppid: 1 });
      } });
      if (what === "other app") f.mac.open = async (_b, args) => { w.add({ argv: ["/Applications/Other.app/Contents/MacOS/Other", ...args], ppid: 1 }); return 0; };
      const { u, t, pkg } = templateIn(w, f);
      mkdirSync(pkg, { recursive: true });
      writeLoad(t.profile, pkg);
      writeFileSync(join(t.profile, "Default", "Preferences"), "{}");
      t.refresh();
      const B = blanketPaths(w.paths.state, join(w.dir, "run", "link.sock"));
      const proxy = new FakeProxy();
      const chrome = new BlanketChrome({ paths: B, procs: w.procs, log: (l) => w.logs.push(l), launch: () => null, proxy, hostFiles: () => {}, kill: (p, s) => w.kill(p, s), clock: () => w.now, sleep: (ms) => w.sleep(ms),
        mac: { launch: (p, e) => u.macBlanketLaunch(p, e), open: (b, a) => f.mac.open(b, a), template: t, writePackage: () => {}, findMs: 1000 } });
      await assert.rejects(chrome.start("bl"), what === "two" ? /2 Chromes run on the blanket profile after the start/ : /does not run \/Applications\/Google Chrome\.app/);
      assert.equal([...w.live.values()].filter((p) => p.argv.includes(`--user-data-dir=${B.profile}`)).length, 0, `${what}: no Chrome runs on the blanket profile`);
      assert.deepEqual(proxy.events, ["start", "stop"]);
      // The set-up: the same find, the same stop.
      t.setup(async () => {});
      await t.running();
      assert.equal(t.state(), "failed");
      assert.equal([...w.live.values()].filter((p) => p.argv.includes(`--user-data-dir=${t.profile}`)).length, 0, `${what}: no set-up Chrome runs`);
    } finally { w.close(); }
  }
});

// ------------------------------------------------------------------ the review's fix round (C1, I1, m1, m2, m3)

test("C1: the set-up refuses a config whose chrome_args hold a proxy switch (--proxy-server, --no-proxy-server), before any open; a found set-up Chrome whose arguments lack the closed proxy's flags stops, and the set-up fails", async () => {
  for (const bad of ["--proxy-server=socks5://127.0.0.1:1", "--no-proxy-server"]) {
    const w = new World();
    try {
      const f = fakeMac(w);
      const { u, t, proxy } = templateIn(w, f);
      u.config = { ...CONFIG, chromeArgs: [bad] };
      t.setup(async () => {});
      await t.running();
      assert.equal(t.state(), "failed", bad);
      const name = bad.slice(2).split("=")[0];
      assert.deepEqual(t.notes(true), [TEMPLATE_TEXT.failed(SETUP_REASON.start(`the config's chrome_args hold --${name}, which would take the blanket Chrome past its address proxy`))], bad);
      assert.equal(f.calls.length, 0, `${bad}: no open`);
      assert.deepEqual(proxy.events, ["start", "stop"]);
    } finally { w.close(); }
  }
  for (const change of [(a: string[]) => a.filter((x) => !x.startsWith("--proxy-server=")), (a: string[]) => [...a, "--proxy-pac-url=http://x/p.pac"]]) {
    const w = new World();
    try {
      const f = fakeMac(w, { argv: change, onOpen: (profile) => writeLoad(profile, join(w.paths.state, BLANKET_PACKAGE_FOLDER)) });
      const { t } = templateIn(w, f);
      t.setup(async () => {});
      await t.running();
      assert.equal(t.state(), "failed");
      assert.deepEqual(t.notes(true), [TEMPLATE_TEXT.failed(SETUP_REASON.flags)], "the files hold the load, but that Chrome never counts");
      assert.equal(w.named("Google Chrome").length, 0, "that set-up Chrome stopped");
      assert.ok(w.signals.some(([, sig]) => sig === "SIGTERM"));
    } finally { w.close(); }
  }
});

test("I1: a template whose files hold another extension's entry (a second unpacked one, a store one, one with no location) fails the set-up with its reason, and its copy goes into no blanket folder; Chrome's own component entries pass", async () => {
  const pkgOf = (w: World) => join(w.paths.state, BLANKET_PACKAGE_FOLDER);
  const others: [string, Record<string, unknown>, boolean][] = [
    ["a second unpacked extension", { aaaabbbbccccddddeeeeffffgggghhhh: { location: 4, path: "/tmp/other" } }, false],
    ["a store extension", { aaaabbbbccccddddeeeeffffgggghhhh: { location: 1 } }, false],
    ["an entry with no location", { aaaabbbbccccddddeeeeffffgggghhhh: { disable_reasons: [1] } }, false],
    ["Chrome's own component entries", { mhjfbmdgcfjbbpaeojofohoefgiehjai: { location: 5 }, neajdppkdcdipfabeoofebfddakdcjhd: { location: 10 } }, true],
  ];
  for (const [name, more, ok] of others) {
    const w = new World();
    try {
      const f = fakeMac(w, { onOpen: (profile) => writeLoad(profile, pkgOf(w), { others: more }) });
      const { t } = templateIn(w, f);
      t.setup(async () => {});
      await t.running();
      assert.equal(t.state(), ok ? "ready" : "failed", name);
      if (!ok) assert.deepEqual(t.notes(true), [TEMPLATE_TEXT.failed(SETUP_REASON.other)], name);
      assert.equal(checkLoad(t.profile, pkgOf(w), false).ok, ok, name);
    } finally { w.close(); }
  }
  // An entry that comes in Preferences after the set-up: the copy's own read refuses it, and status says why.
  const w = new World();
  try {
    const f = fakeMac(w);
    const { u, t, pkg } = templateIn(w, f);
    mkdirSync(pkg, { recursive: true });
    writeLoad(t.profile, pkg);
    writeFileSync(join(t.profile, "Default", "Preferences"), "{}");
    assert.ok(t.refresh());
    writeFileSync(join(t.profile, "Default", "Preferences"), JSON.stringify({ extensions: { settings: { aaaabbbbccccddddeeeeffffgggghhhh: { location: 4 } } } }));
    const B = blanketPaths(w.paths.state, join(w.dir, "run", "link.sock"));
    const chrome = new BlanketChrome({ paths: B, procs: w.procs, log: (l) => w.logs.push(l), launch: () => null, proxy: new FakeProxy(), hostFiles: () => {}, kill: (p, s) => w.kill(p, s), clock: () => w.now, sleep: (ms) => w.sleep(ms),
      mac: { launch: (p, e) => u.macBlanketLaunch(p, e), open: (b, a) => f.mac.open(b, a), template: t, writePackage: () => {} } });
    await assert.rejects(chrome.start("bl"), (e: Error) => e.message === TEMPLATE_START.other);
    assert.equal(f.calls.length, 0, "no open");
    assert.ok(!existsSync(join(B.profile, "Default", "Secure Preferences")), "no copy");
    assert.equal(t.state(), "failed");
    assert.deepEqual(t.notes(true), [TEMPLATE_TEXT.failed(SETUP_REASON.other)]);
  } finally { w.close(); }
});

test("m1: the flags check refuses every proxy switch beyond the exact flags: --no-proxy-server, --proxy-pac-url, --proxy-auto-detect, a bypass list, an unpacked extension", () => {
  const flags = proxyFlags(7);
  assert.ok(holdsFlags(["/x", ...flags, "--force-dark-mode", "about:blank"], flags));
  for (const extra of ["--no-proxy-server", "--proxy-pac-url=http://x/p.pac", "--proxy-auto-detect", "--proxy-bypass-list=*", "-Proxy-Bypass-List=*", "--load-extension=/x", "--disable-extensions-except=/x", "--webrtc-ip-handling-policy=default"]) {
    assert.ok(!holdsFlags(["/x", ...flags, extra, "about:blank"], flags), extra);
  }
});

test("m2: the off read deletes the template only for a copy that Chrome turned off or that holds no entry: a copy that cannot be read, of another folder, or with developer mode off keeps it", () => {
  const w = new World();
  try {
    const f = fakeMac(w);
    const { t, pkg } = templateIn(w, f);
    mkdirSync(pkg, { recursive: true });
    const other = join(w.dir, "elsewhere");
    mkdirSync(other);
    const copies: [string, (p: string) => void, boolean][] = [
      ["unread", (p) => { writeLoad(p, pkg); writeFileSync(join(p, "Default", "Preferences"), "[1]"); }, false],
      ["another folder", (p) => { writeLoad(p, other); writeFileSync(join(p, "Default", "Preferences"), "{}"); }, false],
      ["developer mode off", (p) => { writeLoad(p, pkg, { dev: false }); writeFileSync(join(p, "Default", "Preferences"), "{}"); }, false],
      ["turned off", (p) => { writeLoad(p, pkg, { reasons: [16777216] }); writeFileSync(join(p, "Default", "Preferences"), "{}"); }, true],
      ["no entry", (p) => { writeLoad(p, pkg, { noEntry: true }); writeFileSync(join(p, "Default", "Preferences"), "{}"); }, true],
      // Board ab-4wh.19 (point 2): an entry of another extension hides no off read, in either file.
      ["turned off, with another extension's entry", (p) => { writeLoad(p, pkg, { reasons: [16777216], others: OTHER_UNPACKED }); writeFileSync(join(p, "Default", "Preferences"), "{}"); }, true],
      ["no entry, with another extension's entry", (p) => { writeLoad(p, pkg, { noEntry: true, others: OTHER_UNPACKED }); writeFileSync(join(p, "Default", "Preferences"), "{}"); }, true],
      ["turned off, with another extension's entry in Preferences", (p) => { writeLoad(p, pkg, { reasons: [1] }); writeFileSync(join(p, "Default", "Preferences"), JSON.stringify({ extensions: { settings: OTHER_UNPACKED } })); }, true],
      ["the load, with another extension's entry", (p) => { writeLoad(p, pkg, { others: OTHER_UNPACKED }); writeFileSync(join(p, "Default", "Preferences"), "{}"); }, false],
      ["unread, with another extension's entry", (p) => { writeLoad(p, pkg, { reasons: [1], others: OTHER_UNPACKED }); writeFileSync(join(p, "Default", "Preferences"), "[1]"); }, false],
    ];
    for (const [name, make, off] of copies) {
      const p = join(w.dir, `copy-${name.replace(/ /g, "-")}`);
      make(p);
      assert.equal(t.offRead(p), off, name);
    }
  } finally { w.close(); }
});

test("board ab-4wh.19 (point 2): a copy where Chrome turned the receiver off and that also holds another extension's entry gets the off read: the template goes, and the start fails with the off text, not the no-hello text", async () => {
  const w = new World();
  try {
    const f = fakeMac(w);
    const { t, pkg } = templateIn(w, f);
    mkdirSync(pkg, { recursive: true });
    writeLoad(t.profile, pkg);
    writeFileSync(join(t.profile, "Default", "Preferences"), "{}");
    assert.ok(t.refresh());
    const copy = join(w.dir, "copy");
    writeLoad(copy, pkg, { reasons: [16777216], others: OTHER_UNPACKED });
    writeFileSync(join(copy, "Default", "Preferences"), "{}");
    assert.deepEqual(checkLoad(copy, pkg, false), { ok: false, why: "other" }, "the case that checkLoad's order hides: the other extension's entry");
    const r = partRig({ template: t, profile: copy });
    await r.req("set_sessions", "daemon", { sessions: [sess("b1", true)], remote: [], box: { hosts: [], cookie_names: [] } });
    assert.equal(await r.part.wake("b1", async () => null), useFailed(BLANKET_TEXT.macOff));
    assert.equal(t.state(), "none");
    assert.ok(!existsSync(t.root), "the template is deleted");
    const st = await r.req("status");
    assert.ok(st.data.operator_text.includes(`${TEMPLATE_TEXT.offLead}${TEMPLATE_TEXT.none(pkg)}`), st.data.operator_text);
    r.done();
  } finally { w.close(); }
});

test("m2: the blanket Chrome's version stop: only when the operator's running Chrome and the app on disk are both newer than the blanket Chrome; a set-up Chrome's newer version never counts", () => {
  const w = new World();
  try {
    const app = { binary: CHROME_STABLE_BIN, bundle: APP };
    const helper = (v: string) => `${APP}/Contents/Frameworks/Google Chrome Framework.framework/Versions/${v}/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper`;
    const blanketProfile = join(w.paths.state, "blanket", "profile");
    const blanket = w.add({ argv: [CHROME_STABLE_BIN, `--user-data-dir=${blanketProfile}`], ppid: 1 });
    w.add({ argv: [helper("158.0.8127.37"), "--type=renderer"], ppid: blanket.pid });
    const setup = w.add({ argv: [CHROME_STABLE_BIN, `--user-data-dir=${join(w.paths.state, "blanket-template", "profile")}`], ppid: 1 });
    w.add({ argv: [helper("160.0.1.1"), "--type=renderer"], ppid: setup.pid });
    const stop = (disk: string | null) => blanketVersionStop(w.procs, app, blanket.pid, blanketProfile, w.paths.state, () => disk);
    assert.equal(stop("160.0.1.1"), null, "no operator's Chrome: the set-up Chrome's version does not count");
    const operator = w.add({ argv: [CHROME_STABLE_BIN], ppid: 1 });
    w.add({ argv: [helper("159.0.1.1"), "--type=gpu-process"], ppid: operator.pid });
    assert.equal(stop("159.0.1.1"), "the operator's Chrome runs 159.0.1.1 and 159.0.1.1 is on disk, newer than the blanket Chrome's 158.0.8127.37");
    assert.equal(stop("158.0.8127.37"), null, "the disk holds the blanket Chrome's version: no stop");
    assert.equal(stop(null), null, "the disk cannot be read: no stop");
  } finally { w.close(); }
});
