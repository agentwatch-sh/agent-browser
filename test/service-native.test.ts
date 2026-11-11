// The model inside the service over the native link (stage 1b part 2 of the self-contained agent browser, board
// ab-v16.94.9; the design, sections 5.1 and 5.4; C4, C10, C12): the relay's model with no change of its rules, its
// bridge as calls on the carrier, the carrier's parts on the link, and stage 1c's receiver port on the same link. A
// fake shim connects to the link socket and carries the lines to the relay tests' fake receiver (test/fake-bridge.ts)
// and answers channel main itself, as the agent package does. The last tests start the real service with the link.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay, type Relay } from "../src/relay/endpoint.ts";
import { Carrier } from "../src/service/link/carrier.ts";
import { LinkReceiverPort, NativeLink } from "../src/service/link/link.ts";
import { manifestPath, wrapperPath } from "../src/service/link/manifest.ts";
import { WHY } from "../src/service/link/peer.ts";
import { RECEIVER_ID } from "../src/service/package/pins.ts";
import { senderData } from "../src/service/package/sender.ts";
import { startService } from "../src/service/service.ts";
import { Stage1c } from "../src/service/stage1c.ts";
import { FakeReceiver } from "./fake-bridge.ts";
import { FakeTools, World } from "./fake-unit-world.ts";
import type { UnitState } from "../src/service/unit/owner.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error("timed out"); await sleep(5); } };
const HELLO = { t: "hello", v: 2, version: "0.3.6", channels: ["main", "bridge"], features: ["scopes"] };
const DAEMON = { kind: "daemon", user: "ann", via: "daemon" };

/** A fake shim and agent package: the bridge to the fake receiver, channel main answered here. */
class FakeShim {
  readonly s: Socket;
  readonly fr = new FakeReceiver();
  readonly main: any[] = [];
  readonly lines: any[] = [];
  /** The answer to a main request (default: set_scopes ok, import counts). */
  answerMain: (req: any) => object | null = (req) => req.op === "set_scopes" ? { rules: Object.keys(req.scopes ?? {}).length, closed: 0, refused: 0 } : { cookies_removed: 0, cookies_set: 2, tabs_closed: 0, local: 0, session: 0, idb_databases: 0, idb_records: 0, cache_entries: 0, errors: [] };
  private buf = "";
  private readonly open = new Map<string, Buffer[]>();
  constructor(path: string) {
    this.s = connect(path);
    this.s.on("error", () => {});
    this.s.on("data", (d) => { this.buf += d; for (let i; (i = this.buf.indexOf("\n")) >= 0;) { this.part(JSON.parse(this.buf.slice(0, i))); this.buf = this.buf.slice(i + 1); } });
    // The fake receiver's res and ev lines (with "ch":"bridge") go back on the link.
    this.fr.input.on("data", (d) => this.s.write(d));
  }
  send(o: object) { this.s.write(`${JSON.stringify(o)}\n`); }
  private part(p: any) {
    this.lines.push(p);
    const key = `${p.ch ?? "main"} ${p.id}`;
    const parts = this.open.get(key) ?? [];
    parts.push(Buffer.from(p.b64, "base64"));
    this.open.set(key, parts);
    if (parts.length < p.n) return;
    this.open.delete(key);
    const req = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (p.ch === "bridge") { this.fr.output.write(`${JSON.stringify(req)}\n`); return; }
    this.main.push(req);
    const data = this.answerMain(req);
    if (data) this.send({ t: "res", id: req.id, ok: true, data });
  }
}

/** The link, the carrier, the model (the relay's endpoint in its in-process form) and stage 1c on one receiver port. */
async function rig(t: { after: (f: () => Promise<void> | void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "ab-native-"));
  const logs: string[] = [], events: any[] = [];
  let port!: LinkReceiverPort;
  const carrier: Carrier = new Carrier({ send: (p) => link.sendBridge(p), log: (l) => logs.push(l), blocked: (b) => port.blocked(b) });
  const link: NativeLink = new NativeLink({ path: join(dir, "link.sock"), peer: async () => ({ ok: true, pid: 4242 }), log: (l) => logs.push(l), carrier });
  port = new LinkReceiverPort(link, carrier);
  const stage1c = new Stage1c({ listsFolder: join(dir, "lists"), stateFolder: join(dir, "state"), receiver: port, log: (l) => logs.push(l) });
  stage1c.attach((ev) => events.push(ev));
  await link.start();
  const relay: Relay = await startRelay({ socket: join(dir, "cdp.sock"), input: null as never, output: null as never, log: (l) => logs.push(l), peerCheck: true, windowPerPage: false,
    transport: { send: (line, msg) => carrier.fromModel(line, msg), bind: (to) => carrier.bind(to) } });
  const shims: FakeShim[] = [];
  t.after(async () => { stage1c.stop(); await relay.stop(); carrier.stop(); for (const s of shims) s.s.destroy(); await link.stop(); rmSync(dir, { recursive: true, force: true }); });
  const shim = async () => { const s = new FakeShim(join(dir, "link.sock")); shims.push(s); await new Promise((r) => s.s.once("connect", r)); s.send(HELLO); return s; };
  const sessions = (list: Record<string, string[]>) => {
    mkdirSync(join(dir, "lists"), { recursive: true });
    for (const [name, allow] of Object.entries(list)) writeFileSync(join(dir, "lists", `${name}.json`), JSON.stringify({ allow, repo: "owner/repo" }));
    stage1c.setSessions({ t: "req", id: "s", op: "set_sessions", by: DAEMON, sessions: [{ scope: "web-1", repo: "owner/repo", roots: [{ pid: process.pid, start: 1 }], cgroup: null, lifetime_id: "lt-1", mcp_token: null }], remote: [], box: { hosts: ["box.example"], cookie_names: [] } } as any);
  };
  return { dir, logs, events, link, carrier, port, stage1c, relay, model: relay.model, shim, sessions };
}

test("the model's link-up steps go over the native link as bridge parts, and the fake receiver's answers come back: the model is linked", async (t) => {
  const r = await rig(t);
  const s = await r.shim();
  await until(() => s.fr.requests.some((q) => q.op === "debugger.getTargets"));
  const ops = s.fr.requests.map((q) => q.op);
  assert.ok(ops.indexOf("bridge.info") < ops.indexOf("bridge.tabScopes") && ops.indexOf("bridge.tabScopes") < ops.indexOf("debugger.getTargets"), ops.join(" "));
  assert.ok(s.lines.filter((p) => p.ch === "bridge").length >= 3, "the bridge requests went as parts with ch bridge");
  assert.ok(s.fr.daemonRequests.length === 0, "no daemon op reaches the receiver");
  assert.equal(r.carrier.up(), true);
});

test("stage 1c's set_scopes goes on channel main through the receiver port; its ok in time gives the model the allowlist line with the roots", async (t) => {
  const r = await rig(t);
  const s = await r.shim();
  r.sessions({ "owner.repo": ["a.example"] });
  await until(() => r.stage1c.listsConfirmed());
  const set = s.main.find((q) => q.op === "set_scopes");
  assert.deepEqual({ lists: set.lists, scopes: set.scopes, default: set.default, operator: set.operator }, { lists: { "owner.repo": ["a.example"] }, scopes: { "web-1": "owner.repo" }, default: null, operator: "*" });
  assert.ok(s.lines.filter((p) => p.id === set.id).every((p) => !("ch" in p)), "channel main: no ch");
  await until(() => r.model.named("web-1"));
  assert.equal(r.model.noList("web-1"), false);
  await until(() => r.model.notReady() === null);
});

test("a client of the model gets its answers from the receiver over the link, and an off-list navigation is a blocked report through daemon.blocked to the prompts", async (t) => {
  const r = await rig(t);
  const s = await r.shim();
  r.sessions({ "owner.repo": ["a.example"] });
  await until(() => r.model.notReady() === null && r.model.named("web-1"));
  const sent: any[] = [];
  const conn = r.model.open("web-1", { send: (text) => sent.push(JSON.parse(text)), close: () => {} }, { pid: process.pid, start: 1 });
  void r.model.onMessage(conn, { id: 1, method: "Browser.getVersion" });
  await until(() => sent.some((m) => m.id === 1));
  assert.match(sent.find((m) => m.id === 1).result.userAgent, /Chrome/);
  void r.model.onMessage(conn, { id: 2, method: "Target.createTarget", params: { url: "https://b.example/x" } });
  await until(() => sent.some((m) => m.id === 2));
  assert.ok(sent.find((m) => m.id === 2).error, "the off-list navigation is refused");
  await until(() => r.events.some((e) => e.ev === "prompt"));
  const p = r.events.find((e) => e.ev === "prompt");
  assert.deepEqual({ state: p.state, host: p.host, scope: p.scope, list: p.list, from: p.from }, { state: "open", host: "b.example", scope: "web-1", list: "owner.repo", from: null });
  assert.equal(s.fr.daemonRequests.length, 0, "daemon.blocked never reaches the receiver");
});

test("the receiver's blocked notice reaches the prompts through the port; an import goes on channel main and gives the receiver's counts", async (t) => {
  const r = await rig(t);
  const s = await r.shim();
  r.sessions({ "owner.repo": ["a.example"] });
  await until(() => r.stage1c.listsConfirmed());
  s.send({ t: "blocked", tab: 9, host: "c.example", scope: "web-1", from: "a.example" });
  await until(() => r.events.some((e) => e.ev === "prompt" && e.host === "c.example"));
  const counts = await r.port.request("import", { state: { domain: "x.example" } }, 10_000);
  assert.equal(counts.cookies_set, 2);
  assert.equal(s.main.at(-1).op, "import");
});

test("a drop of the shim is a link down for the model and the receiver port; a new shim is a new link with a new push", async (t) => {
  const r = await rig(t);
  const s = await r.shim();
  r.sessions({ "owner.repo": ["a.example"] });
  await until(() => r.stage1c.listsConfirmed());
  s.s.destroy();
  await until(() => !r.port.isUp() && !r.carrier.up());
  assert.notEqual(r.model.notReady(), null);
  const s2 = await r.shim();
  await until(() => s2.main.some((q) => q.op === "set_scopes") && r.stage1c.listsConfirmed());
  await until(() => r.model.notReady() === null);
});

// ------------------------------------------------------------------ the real service with the link

const ACTIVE: UnitState = { active: "active", sub: "running", mainPid: process.pid };

test("the service with the link: link.sock (0600) and the host files of its shim; sender gives the pinned sender package; a peer that is not the service's Chrome is refused", { timeout: 30_000 }, async (t) => {
  const w = new World();
  const dir = mkdtempSync(join(tmpdir(), "ab-svc-link-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); w.close(); });
  const logs: string[] = [];
  const tools = new FakeTools();
  const s = await startService({
    agentDoor: join(dir, "cdp.sock"), controlDoor: join(dir, "control.sock"), daemonCommand: join(dir, "daemon-command.json"), log: (l) => logs.push(l), mainPid: async () => null,
    lists: { listsFolder: join(dir, "lists"), stateFolder: w.paths.state },
    unit: { paths: w.paths, owner: async () => ACTIVE, tools, procs: w.procs, part: { unit: w.deps(tools), firstCheckMs: 3_600_000 } },
    link: { socket: join(dir, "link.sock"), pidfds: { failed: "the test gives no pidfd" }, xdotool: null },
  });
  try {
    assert.equal(statSync(join(dir, "link.sock")).mode & 0o777, 0o600);
    assert.ok(logs.some((l) => /service: ready \(pid \d+; the Chrome unit runs, with the native link\)/.test(l)));
    const manifest = JSON.parse(readFileSync(manifestPath(w.paths.profile), "utf8"));
    assert.deepEqual(manifest, { name: "sh.agentwatch.browser", description: "agent-browser link", path: wrapperPath(w.paths.state), type: "stdio", allowed_origins: [`chrome-extension://${RECEIVER_ID}/`] });
    assert.match(readFileSync(wrapperPath(w.paths.state), "utf8"), new RegExp(`AGENT_BROWSER_LINK_SOCKET='${join(dir, "link.sock").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
    // The service's sender op (any kind may read it), on its control door, with this process as the daemon: no
    // expected command file exists, so the door refuses it; the op is checked on the handler instead.
    assert.deepEqual(await s.state.handle({ t: "req", id: "q5", op: "sender", by: DAEMON } as any), { data: senderData() });
    // This process is not the service's Chrome's child: the link refuses it and logs the reason.
    const c = connect(join(dir, "link.sock"));
    c.on("error", () => {});
    c.write(`${JSON.stringify(HELLO)}\n`);
    await until(() => logs.some((l) => l.startsWith("link: refused 1 peer(s)")));
    assert.ok(logs.some((l) => l.includes(WHY.noChrome) || l.includes(WHY.parent)), logs.filter((l) => l.startsWith("link:")).join("; "));
    assert.equal(s.link?.connected(), false);
    // status: no Chrome runs, so no extension version.
    assert.equal((s.state.status() as any).extension_version, null);
    c.destroy();
  } finally { await s.stop(); }
  assert.equal(existsSync(join(dir, "link.sock")), false, "the link socket goes at the stop");
});

test("the service with no link option keeps stage 1b part 1's form: no link socket and no host files; sender still answers", { timeout: 30_000 }, async (t) => {
  const w = new World();
  const dir = mkdtempSync(join(tmpdir(), "ab-svc-nolink-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); w.close(); });
  const tools = new FakeTools();
  const s = await startService({
    agentDoor: join(dir, "cdp.sock"), controlDoor: join(dir, "control.sock"), daemonCommand: join(dir, "daemon-command.json"), log: () => {}, mainPid: async () => null,
    lists: { listsFolder: join(dir, "lists"), stateFolder: w.paths.state },
    unit: { paths: w.paths, owner: async () => ACTIVE, tools, procs: w.procs, part: { unit: w.deps(tools), firstCheckMs: 3_600_000 } },
  });
  try {
    assert.equal(s.link, null);
    assert.equal(existsSync(manifestPath(w.paths.profile)), false);
    assert.equal(((await s.state.handle({ t: "req", id: "q5", op: "sender", by: DAEMON } as any)) as any).data.id, "bpfkgknpndlpkcffmaaelkfcbpackiip");
  } finally { await s.stop(); }
});

test("the service's wiring: a shim on its link gets stage 1c's set_scopes, the model takes the confirmed line, the watch's port says confirmed, and the status's extension version is the receiver's", { timeout: 30_000 }, async (t) => {
  const w = new World();
  const dir = mkdtempSync(join(tmpdir(), "ab-svc-wire-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); w.close(); });
  const x = w.add({ argv: ["/usr/bin/Xvfb", ":173", "-nolisten", "tcp", "-auth", w.paths.xauth, "-screen", "0", "1280x900x24"] });
  const ch = w.add({ argv: ["/usr/bin/chromium", `--user-data-dir=${w.paths.profile}`, "about:blank"] });
  const { writeJsonDurable } = await import("../src/service/unit/record.ts");
  writeJsonDurable(w.paths.unitFile, { wanted: true, display: 173, display_size: [1280, 900], xvfb_pid: x.pid, xvfb_start: x.start, chrome_pid: ch.pid, chrome_start: ch.start, chrome: { kind: "chromium", version: "" }, chrome_bin: "/usr/bin/chromium" });
  mkdirSync(join(dir, "lists"));
  writeFileSync(join(dir, "lists", "owner.repo.json"), JSON.stringify({ allow: ["a.example"], repo: "owner/repo" }));
  const tools = new FakeTools();
  const s = await startService({
    agentDoor: join(dir, "cdp.sock"), controlDoor: join(dir, "control.sock"), daemonCommand: join(dir, "daemon-command.json"), log: () => {}, mainPid: async () => null,
    lists: { listsFolder: join(dir, "lists"), stateFolder: w.paths.state },
    unit: { paths: w.paths, owner: async () => ACTIVE, tools, procs: w.procs, part: { unit: w.deps(tools), firstCheckMs: 3_600_000 } },
    link: { socket: join(dir, "link.sock"), pidfds: { failed: "none" }, xdotool: null, peer: async () => ({ ok: true, pid: 4242 }) },
  });
  const shim = new FakeShim(join(dir, "link.sock"));
  try {
    await new Promise((r) => shim.s.once("connect", r));
    shim.send(HELLO);
    s.state.handle({ t: "req", id: "s", op: "set_sessions", by: DAEMON, sessions: [{ scope: "web-1", repo: "owner/repo", roots: [{ pid: process.pid, start: 1 }], cgroup: null, lifetime_id: null, mcp_token: null }], remote: [], box: { hosts: [], cookie_names: [] } } as any);
    await until(() => shim.main.some((q) => q.op === "set_scopes"));
    const watchPort = (s.part as any).o.link;
    await until(() => watchPort.confirmed() === true);
    assert.equal(watchPort.ready(), true);
    const model = (s.agent as any).relay.model;
    await until(() => model.named("web-1") && model.notReady() === null);
    assert.equal((s.state.status() as any).extension_version, "0.3.6");
    assert.ok(shim.fr.requests.some((q) => q.op === "bridge.info"), "the model's bridge goes to the shim");
  } finally { shim.s.destroy(); await s.stop(); }
});
