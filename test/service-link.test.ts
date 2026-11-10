// The native link of the service (stage 1b part 2, board ab-v16.94.9; contract C4): the link socket, its peer check,
// the hello and its features, channel main (one request at a time, its wait, its errors), channel bridge (only with a
// hello that lists it; parts of the two channels in turn), the blocked notice, and the end of the old owner's host by
// note 7 through a pidfd. The cases of agentwatch's tests/daemon/browser/test_link.py, ported, with the shared vectors
// (test/vectors/chrome-extension-3d84667: hello.json and blocked.json).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PeerReader, Proc, RawPeer } from "../src/relay/peer.ts";
import { ReceiverError, type Blocked } from "../src/service/receiver.ts";
import { Carrier } from "../src/service/link/carrier.ts";
import { LinkReceiverPort, MAX_TO_DAEMON, NativeLink, type LinkPeerCheck } from "../src/service/link/link.ts";
import { endOldHosts, findOldHosts, isOwnShim, type Pidfds } from "../src/service/link/old-host.ts";
import { linkPeerCheck, WHY } from "../src/service/link/peer.ts";
import { splitParts } from "../src/service/link/parts.ts";
import { Procs } from "../src/service/unit/procs.ts";

const V = (f: string) => JSON.parse(readFileSync(new URL(`./vectors/chrome-extension-3d84667/${f}`, import.meta.url), "utf8"));
const HELLO = V("hello.json").hello;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error("timed out"); await sleep(5); } };

/** The shim's side of a test: a connection that sends lines and keeps the lines that it gets. */
class Shim {
  readonly s: Socket;
  readonly lines: any[] = [];
  closed = false;
  private buf = "";
  constructor(path: string) {
    this.s = connect(path);
    this.s.on("data", (d) => { this.buf += d; for (let i; (i = this.buf.indexOf("\n")) >= 0;) { this.lines.push(JSON.parse(this.buf.slice(0, i))); this.buf = this.buf.slice(i + 1); } });
    this.s.on("close", () => { this.closed = true; });
    this.s.on("error", () => {});
  }
  send(o: object | string) { this.s.write(typeof o === "string" ? o : `${JSON.stringify(o)}\n`); }
  /** The requests that its parts carry, joined by channel and id. */
  requests(ch?: string): any[] {
    const out: any[] = [], open = new Map<string, Buffer[]>();
    for (const p of this.lines) {
      if (p.t !== "part" || (ch === undefined ? p.ch !== undefined : p.ch !== ch)) continue;
      const k = p.id;
      const parts = open.get(k) ?? [];
      parts.push(Buffer.from(p.b64, "base64"));
      open.set(k, parts);
      if (parts.length === p.n) { out.push(JSON.parse(Buffer.concat(parts).toString("utf8"))); open.delete(k); }
    }
    return out;
  }
}

function rig(t: { after: (f: () => Promise<void> | void) => void }, o: { peer?: LinkPeerCheck; carrier?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ab-link-"));
  const logs: string[] = [], events: string[] = [], blocked: Blocked[] = [];
  const carrierLines: any[] = [];
  const carrier = o.carrier ? new Carrier({ send: (p) => link.sendBridge(p), log: (l) => logs.push(l) }) : undefined;
  carrier?.bind({ answer: (m) => carrierLines.push(m), daemon: (m) => carrierLines.push(m) });
  const link: NativeLink = new NativeLink({ path: join(dir, "link.sock"), peer: o.peer ?? (async () => ({ ok: true, pid: 4242 })), log: (l) => logs.push(l), carrier });
  link.attach({ up: () => events.push("up"), down: () => events.push("down"), blocked: (b) => blocked.push(b) });
  t.after(async () => { await link.stop(); rmSync(dir, { recursive: true, force: true }); });
  const shim = async (hello: object | null = HELLO) => {
    const s = new Shim(join(dir, "link.sock"));
    await new Promise((r) => s.s.once("connect", r));
    if (hello) { s.send(hello); await until(() => link.version() === (hello as any).version && link.connected()); }
    return s;
  };
  return { dir, link, logs, events, blocked, carrier, carrierLines, shim, start: () => link.start() };
}

test("the socket is 0600 and goes at the stop; it is removed only while it is still the link's", async (t) => {
  const r = rig(t);
  await r.start();
  const path = join(r.dir, "link.sock");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  await r.link.stop();
  assert.equal(statSync(path, { throwIfNoEntry: false }), undefined);
});

test("the hello vector gives the scopes feature, the bridge and the version; an up for the receiver port", async (t) => {
  const r = rig(t);
  await r.start();
  await r.shim();
  assert.equal(r.link.version(), "0.3.0");
  assert.equal(r.link.ready(), true);
  assert.equal(r.link.bridgeReady(), true);
  assert.equal(r.link.scopesReady(), true);
  assert.deepEqual(r.events, ["up"]);
});

test("old hellos have no scopes: no up; a later hello without features clears them and says down", async (t) => {
  const r = rig(t);
  await r.start();
  const s = await r.shim();
  s.send(V("hello.json").oldHellos[0].hello);
  await until(() => !r.link.scopesReady());
  assert.deepEqual(r.events, ["up", "down"]);
  assert.equal(r.link.bridgeReady(), true);
  s.send(V("hello.json").oldHellos[1].hello);
  await until(() => !r.link.bridgeReady());
  assert.equal(r.link.version(), "0.1.0");
});

test("features ignores items that are not text", async (t) => {
  const r = rig(t);
  await r.start();
  await r.shim({ ...HELLO, features: [1, null, "scopes", { a: 1 }] });
  assert.deepEqual([...r.link.features()], ["scopes"]);
});

test("a main request goes as parts with no ch, and its res's data comes back", async (t) => {
  const r = rig(t);
  await r.start();
  const s = await r.shim();
  const p = r.link.request("set_scopes", { lists: {}, scopes: {}, default: null, operator: "*" }, 10_000);
  await until(() => s.requests().length === 1);
  const [req] = s.requests();
  assert.deepEqual(Object.keys(req).slice(0, 3), ["t", "id", "op"]);
  assert.equal(req.op, "set_scopes");
  assert.ok(s.lines.every((l) => !("ch" in l)));
  s.send({ t: "res", id: req.id, ok: true, data: { rules: 0, closed: 0, refused: 0 } });
  assert.deepEqual(await p, { rules: 0, closed: 0, refused: 0 });
});

test("a big request goes as parts of 700000 bytes, each under a line of 1,000,000", async (t) => {
  const r = rig(t);
  await r.start();
  const s = await r.shim();
  const p = r.link.request("import", { state: { pad: "x".repeat(1_500_000) } }, 10_000);
  await until(() => s.requests().length === 1);
  assert.equal(s.lines.length, 3);
  const req = s.requests()[0];
  s.send({ t: "res", id: req.id, ok: true, data: { cookies_set: 1 } });
  assert.deepEqual(await p, { cookies_set: 1 });
});

test("ok:false is refused with the receiver's text (cut to 500); ok with data that is not an object is refused too", async (t) => {
  const r = rig(t);
  await r.start();
  const s = await r.shim();
  const a = r.link.request("set_scopes", {}, 10_000);
  await until(() => s.requests().length === 1);
  s.send({ t: "res", id: s.requests()[0].id, ok: false, error: "x".repeat(600) });
  await assert.rejects(a, (e: ReceiverError) => e.kind === "refused" && e.message.length === 500);
  const b = r.link.request("set_scopes", {}, 10_000);
  await until(() => s.requests().length === 2);
  s.send({ t: "res", id: s.requests()[1].id, ok: true, data: [1] });
  await assert.rejects(b, (e: ReceiverError) => e.kind === "refused" && e.message === "the receiver sent no result object");
});

test("no answer in the wait is a timeout; with no connection a request is down and nothing goes; a drop while waiting is dropped", async (t) => {
  const r = rig(t);
  await r.start();
  await assert.rejects(r.link.request("set_scopes", {}, 1000), (e: ReceiverError) => e.kind === "down");
  const s = await r.shim();
  await assert.rejects(r.link.request("set_scopes", {}, 50), (e: ReceiverError) => e.kind === "timeout");
  assert.equal(r.link.connected(), true, "a timeout after the last part keeps the link");
  const p = r.link.request("set_scopes", {}, 10_000);
  await until(() => s.requests().length === 2);
  s.s.destroy();
  await assert.rejects(p, (e: ReceiverError) => e.kind === "dropped");
  await until(() => !r.link.connected());
  assert.deepEqual(r.events, ["up", "down"]);
});

test("main requests run one at a time, in their order: the second goes only after the first's answer", async (t) => {
  const r = rig(t);
  await r.start();
  const s = await r.shim();
  const a = r.link.request("import", { state: {} }, 10_000);
  const b = r.link.request("set_scopes", {}, 10_000);
  await until(() => s.requests().length === 1);
  await sleep(50);
  assert.equal(s.requests().length, 1, "the set_scopes waits behind the import");
  assert.equal(r.link.importing(), true);
  assert.equal(r.link.busy(), true);
  s.send({ t: "res", id: s.requests()[0].id, ok: true, data: {} });
  await a;
  await until(() => s.requests().length === 2);
  assert.equal(s.requests()[1].op, "set_scopes");
  s.send({ t: "res", id: s.requests()[1].id, ok: true, data: {} });
  await b;
  assert.equal(r.link.busy(), false);
});

test("a body may not replace the fixed keys t, id or op", async (t) => {
  const r = rig(t);
  await r.start();
  await r.shim();
  for (const k of ["t", "id", "op"]) await assert.rejects(r.link.request("set_scopes", { [k]: 1 }, 1000), /may not use the keys/);
});

test("a new connection replaces the old one; the old one's lines are ignored and its request is dropped", async (t) => {
  const r = rig(t);
  await r.start();
  const s1 = await r.shim();
  const p = r.link.request("set_scopes", {}, 10_000);
  await until(() => s1.requests().length === 1);
  const s2 = await r.shim({ ...HELLO, version: "0.3.7" });
  await assert.rejects(p, (e: ReceiverError) => e.kind === "dropped");
  await until(() => s1.closed);
  assert.equal(r.link.version(), "0.3.7");
  assert.deepEqual(r.events, ["up", "down", "up"]);
  s2.send({ t: "blocked", tab: 1, host: "a.example", scope: "s", from: null });
  await until(() => r.blocked.length === 1);
});

test("a refused peer is closed unread, and the refusals are logged at most once a minute with their count", async (t) => {
  const r = rig(t, { peer: async () => ({ ok: false, reason: WHY.parent }) });
  await r.start();
  for (let i = 0; i < 3; i++) {
    const s = new Shim(join(r.dir, "link.sock"));
    s.send(HELLO);
    await until(() => s.closed);
  }
  assert.equal(r.link.connected(), false);
  assert.equal(r.link.version(), null);
  assert.deepEqual(r.logs.filter((l) => l.startsWith("link: refused")), [`link: refused 1 peer(s) since the last line (${WHY.parent})`]);
});

test("a peer check that throws refuses the peer", async (t) => {
  const r = rig(t, { peer: async () => { throw new Error("x"); } });
  await r.start();
  const s = new Shim(join(r.dir, "link.sock"));
  await until(() => s.closed);
  assert.equal(r.link.connected(), false);
});

test("the version goes at a disconnect, and a stop says down", async (t) => {
  const r = rig(t);
  await r.start();
  const s = await r.shim();
  s.s.destroy();
  await until(() => !r.link.connected());
  assert.equal(r.link.version(), null);
  await r.shim();
  await r.link.stop();
  assert.deepEqual(r.events, ["up", "down", "up", "down"]);
});

test("the blocked vector reaches the prompts with its scope and from; a value of another shape passes as null", async (t) => {
  const r = rig(t);
  await r.start();
  const s = await r.shim();
  const notices = V("blocked.json").notices;
  for (const n of notices) s.send(n.msg);
  s.send({ t: "blocked", tab: 1, host: "b.example", scope: 7, from: ["x"] });
  s.send({ t: "blocked", tab: 1, host: "" });
  await until(() => r.blocked.length === notices.length + 1);
  assert.deepEqual(r.blocked.slice(0, notices.length), notices.map((n: any) => ({ host: n.msg.host, scope: n.msg.scope, from: n.msg.from })));
  assert.deepEqual(r.blocked.at(-1), { host: "b.example", scope: null, from: null });
});

test("a receiver line of MAX_TO_DAEMON bytes is read; a longer one drops the link; a line that is not a JSON object drops it too", async (t) => {
  const r = rig(t);
  await r.start();
  const s = await r.shim();
  // C4's MAX_TO_DAEMON, from the shared vectors (not the code's constant).
  const limit = V("bridge.json").constants.MAX_TO_DAEMON;
  assert.equal(MAX_TO_DAEMON, limit);
  const pad = limit - JSON.stringify({ t: "x", p: "" }).length;
  s.send(`${JSON.stringify({ t: "x", p: "a".repeat(pad) })}\n`);
  s.send({ t: "blocked", tab: 1, host: "c.example", scope: null, from: null });
  await until(() => r.blocked.length === 1, 10_000);
  s.send(`${JSON.stringify({ t: "x", p: "a".repeat(pad + 1) })}\n`);
  await until(() => !r.link.connected(), 10_000);
  const s2 = await r.shim();
  s2.send("[1]\n");
  await until(() => !r.link.connected());
  assert.ok(r.logs.some((l) => /not a JSON object/.test(l)));
});

test("a line whose t is not a string, and a res of another channel, are ignored; ch main is main", async (t) => {
  const r = rig(t);
  await r.start();
  const s = await r.shim();
  const p = r.link.request("set_scopes", {}, 10_000);
  await until(() => s.requests().length === 1);
  const id = s.requests()[0].id;
  s.send({ t: 1, id });
  s.send({ t: "res", ch: "other", id, ok: true, data: { wrong: 1 } });
  s.send({ t: "res", ch: "bridge", id, ok: true, data: { wrong: 2 } });
  s.send({ t: "res", ch: "main", id, ok: true, data: { right: 1 } });
  assert.deepEqual(await p, { right: 1 });
});

test("channel bridge: a hello v2 with bridge says link up to the carrier once; a later hello without it says down; a drop says down once", async (t) => {
  const r = rig(t, { carrier: true });
  await r.start();
  const s = await r.shim();
  s.send(HELLO);
  await sleep(50);
  assert.deepEqual(r.carrierLines.filter((l) => l.t === "link"), [{ t: "link", up: true, version: "0.3.0" }]);
  s.send(V("hello.json").oldHellos[1].hello);
  await until(() => r.carrierLines.length === 2);
  assert.deepEqual(r.carrierLines[1], { t: "link", up: false });
  s.send(HELLO);
  await until(() => r.carrierLines.length === 3);
  s.s.destroy();
  await until(() => r.carrierLines.length === 4);
  await r.link.stop();
  assert.deepEqual(r.carrierLines.map((l) => l.up), [true, false, true, false]);
});

test("a hello v1 gets main parts with no ch and no bridge message; bridge lines on a link without bridge are ignored", async (t) => {
  const r = rig(t, { carrier: true });
  await r.start();
  const s = await r.shim(V("hello.json").oldHellos[1].hello);
  assert.equal(r.link.sendBridge(splitParts("b1", "{}", "bridge")), false);
  s.send({ t: "ev", ch: "bridge", ev: "x" });
  await sleep(30);
  assert.deepEqual(r.carrierLines, []);
  assert.throws(() => r.link.sendBridge(splitParts("b1", "{}")), /"ch":"bridge"/);
});

test("res, ev and parts of channel bridge reach the carrier in their order; other kinds do not; a bridge res never answers a main request", async (t) => {
  const r = rig(t, { carrier: true });
  await r.start();
  const s = await r.shim();
  const q = { t: "req" as const, id: "5f3a9c01-1", op: "tabs.get", args: [1], wait: 30000 };
  r.carrier!.fromModel(JSON.stringify(q), q);
  const main = r.link.request("set_scopes", {}, 10_000);
  await until(() => s.requests("bridge").length === 1 && s.requests().length === 1);
  s.send({ t: "ev", ch: "bridge", ev: "tabs.onCreated", params: [{ id: 1 }] });
  s.send({ t: "hello", ch: "bridge", version: "9" });
  s.send({ t: "res", ch: "bridge", id: s.requests()[0].id, ok: true, data: {} });
  s.send({ t: "res", ch: "bridge", id: q.id, ok: true, data: { id: 1 } });
  await until(() => r.carrierLines.length === 3);
  assert.deepEqual(r.carrierLines.slice(1).map((l) => [l.t, l.ev ?? l.id]), [["ev", "tabs.onCreated"], ["res", q.id]]);
  assert.equal(r.link.version(), "0.3.0");
  s.send({ t: "res", id: s.requests()[0].id, ok: true, data: { main: 1 } });
  assert.deepEqual(await main, { main: 1 });
});

test("the parts of two channels go in turn: a bridge message never waits behind a long import, and the import's parts never interleave", async (t) => {
  const r = rig(t, { carrier: true });
  await r.start();
  const s = await r.shim();
  const imp = r.link.request("import", { state: { pad: "x".repeat(4 * 700_000) } }, 10_000);
  const q = { t: "req" as const, id: "5f3a9c01-9", op: "tabs.get", args: [1], wait: 30000 };
  r.carrier!.fromModel(JSON.stringify(q), q);
  await until(() => s.requests().length === 1 && s.requests("bridge").length === 1);
  const kinds = s.lines.map((l) => l.ch ?? "main");
  const firstBridge = kinds.indexOf("bridge");
  assert.ok(firstBridge > 0 && firstBridge < kinds.lastIndexOf("main"), `the bridge part overtakes the import: ${kinds.join(",")}`);
  const mainSeq = s.lines.filter((l) => !l.ch).map((l) => l.seq);
  assert.deepEqual(mainSeq, [...mainSeq].sort((a, b) => a - b));
  s.send({ t: "res", id: s.requests()[0].id, ok: true, data: {} });
  await imp;
});

test("queued bridge parts never reach a new connection", async (t) => {
  const r = rig(t, { carrier: true });
  await r.start();
  const s1 = await r.shim();
  s1.s.pause();
  for (let i = 0; i < 40; i++) r.link.sendBridge(splitParts(`x-${i}`, JSON.stringify({ pad: "y".repeat(600_000) }), "bridge"));
  const s2 = await r.shim();
  await sleep(100);
  assert.equal(s2.lines.length, 0);
});

test("the receiver port on the link: up and down from the hellos, set_scopes and import on channel main, the allowlist and end_scope lines to the model", async (t) => {
  const r = rig(t, { carrier: true });
  const port = new LinkReceiverPort(r.link, r.carrier!);
  const events: string[] = [];
  port.attach({ up: () => events.push("up"), down: () => events.push("down"), blocked: (b) => events.push(`blocked ${b.host}`) });
  await r.start();
  assert.equal(port.isUp(), false);
  await assert.rejects(port.request("set_scopes", {}, 1000), (e: ReceiverError) => e.kind === "down");
  const s = await r.shim();
  assert.equal(port.isUp(), true);
  const p = port.request("set_scopes", { lists: { l: ["a.example"] }, scopes: { s: "l" }, default: null, operator: "*" }, 10_000);
  await until(() => s.requests().length === 1);
  s.send({ t: "res", id: s.requests()[0].id, ok: true, data: { rules: 1, closed: 0, refused: 0 } });
  await p;
  port.allowlist({ t: "allowlist", lists: { l: ["a.example"] }, scopes: { s: "l" }, default: null, operator: "*", roots: {} });
  port.endScope("s");
  port.blocked({ host: "d.example", scope: "s", from: null });
  assert.deepEqual(r.carrierLines.slice(1), [{ t: "allowlist", lists: { l: ["a.example"] }, scopes: { s: "l" }, default: null, operator: "*", roots: {} }, { t: "end_scope", scope: "s" }]);
  assert.deepEqual(events, ["up", "blocked d.example"]);
  // A receiver whose hello has no `scopes` holds the link, but the port is not up: no object and no import goes to it.
  s.send(V("hello.json").oldHellos[0].hello);
  await until(() => !r.link.scopesReady());
  assert.equal(r.link.connected(), true);
  assert.equal(port.isUp(), false);
  await assert.rejects(port.request("import", { state: {} }, 1000), (e: ReceiverError) => e.kind === "down");
});

test("a stalled reader: a timeout before the last part of a request drops the connection, and a new shim gets the link", async (t) => {
  const r = rig(t);
  await r.start();
  const s = await r.shim();
  s.s.pause();
  const p = r.link.request("import", { state: { pad: "x".repeat(24 * 1024 * 1024) } }, 300);
  await assert.rejects(p, (e: ReceiverError) => e.kind === "timeout");
  await until(() => !r.link.connected());
  s.s.destroy();
  await r.shim();
  assert.equal(r.link.connected(), true);
});

test("a raising handler leaves the link up, and its log line holds no page data", async (t) => {
  const r = rig(t, { carrier: true });
  await r.start();
  r.link.attach({ up: () => { throw new Error("secret-page-text"); }, down: () => {}, blocked: () => { throw new Error("secret-page-text"); } });
  r.carrier!.bind({ answer: () => { throw new Error("secret-page-text"); }, daemon: () => { throw new Error("secret-page-text"); } });
  const s = await r.shim();
  s.send({ t: "blocked", tab: 1, host: "a.example", scope: null, from: null });
  s.send({ t: "ev", ch: "bridge", ev: "x", params: ["secret-page-text"] });
  const p = r.link.request("set_scopes", {}, 10_000);
  await until(() => s.requests().length === 1);
  s.send({ t: "res", id: s.requests()[0].id, ok: true, data: {} });
  await p;
  assert.equal(r.link.connected(), true);
  assert.ok(r.logs.some((l) => l.startsWith("link: a handler failed (Error)")));
  assert.ok(r.logs.some((l) => l.startsWith("bridge: the model failed on a ev message (Error)")));
  for (const l of r.logs) assert.doesNotMatch(l, /secret-page-text/);
});

test("a main request never waits behind a large bridge message, and the parts of one bridge message never interleave with the next", async (t) => {
  const r = rig(t, { carrier: true });
  await r.start();
  const s = await r.shim();
  const big = { t: "req" as const, id: "5f3a9c01-1", op: "debugger.sendCommand", args: [{ tabId: 1 }, "DOM.setFileInputFiles", { pad: "y".repeat(4 * 700_000) }], wait: 600_000 };
  const small = { t: "req" as const, id: "5f3a9c01-2", op: "tabs.get", args: [1], wait: 30_000 };
  r.carrier!.fromModel(JSON.stringify(big), big);
  r.carrier!.fromModel(JSON.stringify(small), small);
  const main = r.link.request("set_scopes", {}, 10_000);
  await until(() => s.requests().length === 1 && s.requests("bridge").length === 2);
  const order = s.lines.map((l) => `${l.ch ?? "main"} ${l.id}`);
  const mainAt = order.findIndex((x) => x.startsWith("main"));
  const lastBig = order.lastIndexOf(`bridge ${big.id}`);
  assert.ok(mainAt < lastBig, `the main part goes before the large bridge message ends: ${order.join(", ")}`);
  assert.ok(order.indexOf(`bridge ${small.id}`) > lastBig, "the next bridge message goes after the last part of the one before");
  s.send({ t: "res", id: s.requests()[0].id, ok: true, data: {} });
  await main;
});

// ------------------------------------------------------------------ the peer check

/** A peer reader over a table of processes. */
function fakeReader(procs: Record<number, Proc>, peer: RawPeer | null, o: { form?: "pidfd" | "stat"; alive?: () => boolean } = {}): PeerReader & { closed: number[] } {
  const closed: number[] = [];
  return {
    form: o.form ?? "pidfd", closed,
    peer: () => peer, proc: (pid) => procs[pid] ?? null, cgroup: () => null,
    poll: () => (o.alive?.() ?? true ? 0 : 1), fdinfoPid: () => (o.alive?.() ?? true ? peer?.pid ?? null : -1), close: (fd) => { closed.push(fd); },
  };
}
const SOCK = { _handle: { fd: 9 } } as unknown as Socket;
const CHROME = { pid: 100, start: 5000 };
const PROFILE_ARGV = ["/opt/chrome", "--user-data-dir=/s/profile", "--no-first-run"];

test("the link's peer check: the shim's parent is the service's Chrome by pid and start time, on the agent profile", async () => {
  const procs = { 200: { ppid: 100, start: 6000, state: "S" }, 100: { ppid: 1, start: 5000, state: "S" } };
  const check = (o: { procs?: Record<number, Proc>; peer?: RawPeer | null; chrome?: typeof CHROME | null; argv?: string[]; alive?: () => boolean; form?: "pidfd" | "stat" } = {}) => {
    const reader = fakeReader(o.procs ?? procs, o.peer === undefined ? { pid: 200, uid: 1000, pidfd: 33, start: null } : o.peer, { alive: o.alive, form: o.form });
    return { reader, run: linkPeerCheck({ reader, chrome: () => (o.chrome === undefined ? CHROME : o.chrome), profile: "/s/profile", cmdline: () => o.argv ?? PROFILE_ARGV, uid: 1000 })(SOCK) };
  };
  const ok = check();
  assert.deepEqual(await ok.run, { ok: true, pid: 200 });
  assert.deepEqual(ok.reader.closed, [33], "the peer's pidfd is closed once");
  assert.deepEqual(await check({ peer: { pid: 200, uid: 1001, pidfd: 33, start: null } }).run, { ok: false, reason: WHY.unread });
  assert.deepEqual(await check({ peer: null }).run, { ok: false, reason: WHY.unread });
  assert.deepEqual(await check({ chrome: null }).run, { ok: false, reason: WHY.noChrome });
  assert.deepEqual(await check({ procs: { ...procs, 200: { ppid: 101, start: 6000, state: "S" } } }).run, { ok: false, reason: WHY.parent });
  assert.deepEqual(await check({ procs: { ...procs, 100: { ppid: 1, start: 5001, state: "S" } } }).run, { ok: false, reason: WHY.parentStart });
  assert.deepEqual(await check({ argv: ["/opt/chrome", "--user-data-dir=/s/profile2"] }).run, { ok: false, reason: WHY.profile });
  assert.deepEqual(await check({ alive: () => false }).run, { ok: false, reason: WHY.changed });
  assert.deepEqual(await check({ form: "stat", peer: { pid: 200, uid: 1000, pidfd: null, start: 5999 } }).run, { ok: false, reason: WHY.unread }, "the stat form: the start at the accept is not the process's");
  assert.deepEqual(await check({ form: "stat", peer: { pid: 200, uid: 1000, pidfd: null, start: 6000 } }).run, { ok: true, pid: 200 });
  assert.deepEqual(await linkPeerCheck({ reader: { failed: "no ffi" }, chrome: () => CHROME, profile: "/p", cmdline: () => [] })(SOCK), { ok: false, reason: WHY.noRun("no ffi") });
  assert.deepEqual(await linkPeerCheck({ reader: fakeReader(procs, { pid: 200, uid: 1000, pidfd: 33, start: null }), chrome: () => CHROME, profile: "/s/profile", cmdline: () => PROFILE_ARGV, uid: 1000, platform: "darwin" })(SOCK), { ok: false, reason: WHY.platform("darwin") }, "the Mac is not built: it refuses");
});

// ------------------------------------------------------------------ the end of the old host (note 7)

/** A fake /proc: each process with its parent, start time, uid and command line. */
function fakeProc(t: { after: (f: () => void) => void }, procs: Record<number, { ppid: number; start: number; uid?: number; argv: string[] }>): Procs {
  const root = mkdtempSync(join(tmpdir(), "ab-proc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [pid, p] of Object.entries(procs)) {
    mkdirSync(join(root, pid));
    writeFileSync(join(root, pid, "stat"), `${pid} (x) S ${p.ppid} ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${p.start} 0 0`);
    writeFileSync(join(root, pid, "cmdline"), `${p.argv.join("\0")}\0`);
    writeFileSync(join(root, pid, "status"), `Name:\tx\nUid:\t${p.uid ?? 1000}\t${p.uid ?? 1000}\t0\t0\n`);
  }
  return new Procs({ root, uid: 1000, self: 1 });
}
const ID = "ifhfjdmdbgbnmllffiadajepajbcdnai";
const OWN = ["/usr/bin/node", "--disable-sigusr1", "/ab/bin/agent-browser.js", "host"];

test("note 7: an old host is a direct child of the recorded Chrome with the receiver's origin and no --type=, and not the service's own shim", (t) => {
  const procs = fakeProc(t, {
    100: { ppid: 1, start: 5000, argv: ["/opt/chrome", "--user-data-dir=/s/profile"] },
    201: { ppid: 100, start: 6001, argv: ["/usr/bin/python3", "-I", "/aw/native_host.py", `chrome-extension://${ID}/`] },
    202: { ppid: 100, start: 6002, argv: ["/opt/chrome", "--type=renderer", `chrome-extension://${ID}/`] },
    203: { ppid: 100, start: 6003, argv: [...OWN, `chrome-extension://${ID}/`] },
    204: { ppid: 100, start: 6004, argv: ["/x/host", "chrome-extension://otherotherotherotherotherotherot/"] },
    205: { ppid: 999, start: 6005, argv: ["/usr/bin/python3", "/aw/native_host.py", `chrome-extension://${ID}/`] },
    206: { ppid: 100, start: 6006, uid: 1001, argv: ["/usr/bin/python3", "/aw/native_host.py", `chrome-extension://${ID}/`] },
    207: { ppid: 100, start: 6007, argv: ["/usr/bin/node", "--disable-sigusr1", "/old/bin/agent-browser.js", "host", `chrome-extension://${ID}/`] },
  });
  const rule = { procs, chrome: { pid: 100, start: 5000 }, receiverId: ID, own: OWN };
  assert.deepEqual(findOldHosts(rule), [201, 207], "the daemon's host and an earlier agent-browser's shim; never a renderer, another user's process or the service's own shim");
  assert.deepEqual(findOldHosts({ ...rule, chrome: { pid: 100, start: 5001 } }), [], "a Chrome whose start time is not the recorded one has no old host");
  assert.equal(isOwnShim([...OWN, "x"], OWN), true);
  assert.equal(isOwnShim([...OWN, "x", "y"], OWN), false);
});

test("note 7: each old host gets SIGTERM through a pidfd, after its facts are checked again; with no pidfd nothing is signalled", (t) => {
  const procs = fakeProc(t, {
    100: { ppid: 1, start: 5000, argv: ["/opt/chrome"] },
    201: { ppid: 100, start: 6001, argv: ["/usr/bin/python3", "/aw/native_host.py", `chrome-extension://${ID}/`] },
  });
  const calls: string[] = [];
  const pidfds: Pidfds = { open: (pid) => { calls.push(`open ${pid}`); return 40; }, signal: (fd, sig) => { calls.push(`signal ${fd} ${sig}`); return 0; }, close: (fd) => { calls.push(`close ${fd}`); } };
  const logs: string[] = [];
  const rule = { procs, chrome: { pid: 100, start: 5000 }, receiverId: ID, own: OWN, log: (l: string) => logs.push(l) };
  assert.deepEqual(endOldHosts({ ...rule, pidfds }), [201]);
  assert.deepEqual(calls, ["open 201", "signal 40 15", "close 40"]);
  assert.ok(logs.some((l) => l.includes("ended the old host (pid 201)")));
  assert.deepEqual(endOldHosts({ ...rule, pidfds: { failed: "no ffi" } }), []);
  assert.ok(logs.some((l) => l.includes("cannot end them: no ffi")));
  // A pidfd that opens on a process that has changed (a reused pid): no signal.
  const swap: Pidfds = { open: () => { writeFileSync(join(procs.root, "201", "stat"), `201 (x) S 100 201 201 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 7777 0 0`); return 41; }, signal: () => { calls.push("signal again"); return 0; }, close: () => {} };
  assert.deepEqual(endOldHosts({ ...rule, pidfds: swap }), []);
  assert.ok(!calls.includes("signal again"));
});
