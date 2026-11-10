// The bridge carrier inside the service (stage 1b part 2, board ab-v16.94.9; contract C10, the daemon's side, "From
// stage 3"): the cases of agentwatch's tests/daemon/browser/test_bridge.py that apply in one process, ported, with the
// shared vectors (test/vectors/chrome-extension-3d84667/bridge.json: constants, resultParts, daemonAnswers,
// daemonLines and blockedVectors).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { BridgeRequest } from "../src/relay/bridge.ts";
import { Carrier, DISCONNECTED, MAX_BYTES_IN_FLIGHT, MAX_REQUEST, MAX_RESULT, MAX_RESULT_PARTS, NOT_CONNECTED, RESULT_PART_BYTES, TIMEOUT, TOO_LARGE, WAIT_DEFAULT_MS, WAIT_MAX_MS, WAIT_SLACK_MS, waitOf, type PointerPort } from "../src/service/link/carrier.ts";
import { PART_BYTES, type Part } from "../src/service/link/parts.ts";

const V = JSON.parse(readFileSync(new URL("./vectors/chrome-extension-3d84667/bridge.json", import.meta.url), "utf8"));

/** A carrier with a fake link (its sent parts), a fake model (its answers and lines) and a clock that the test moves. */
function rig(o: { up?: boolean; maxBytes?: number; pointer?: PointerPort; refuse?: boolean } = {}) {
  let now = 1_000_000;
  const sent: Part[][] = [], answers: any[] = [], lines: any[] = [], logs: string[] = [], blocked: any[] = [];
  const c = new Carrier({ send: (parts) => { if (o.refuse) return false; sent.push(parts); return true; }, log: (l) => logs.push(l), clock: () => now, maxBytes: o.maxBytes, pointer: o.pointer, blocked: (b) => blocked.push(b) });
  c.bind({ answer: (m) => answers.push(m), daemon: (m) => lines.push(m) });
  if (o.up !== false) c.linkUp("0.3.6");
  let n = 0;
  const req = (op: string, args: unknown[] = [], wait?: number, id = `5f3a9c01-${++n}`): BridgeRequest => ({ t: "req", id, op, args, wait: wait ?? (op === "debugger.sendCommand" ? WAIT_MAX_MS : WAIT_DEFAULT_MS) });
  const send = (r: BridgeRequest) => c.fromModel(JSON.stringify(r), r);
  const joined = (parts: Part[]) => JSON.parse(Buffer.concat(parts.map((p) => Buffer.from(p.b64, "base64"))).toString("utf8"));
  return { c, sent, answers, lines, logs, blocked, req, send, joined, tick: (ms: number) => { now += ms; } };
}

test("the constants are C10's (the vector's)", () => {
  const k = V.constants;
  assert.deepEqual({ WAIT_DEFAULT_MS, WAIT_MAX_MS, WAIT_SLACK_MS, MAX_BYTES_IN_FLIGHT, MAX_REQUEST, MAX_RESULT, RESULT_PART_BYTES, PART_BYTES },
    { WAIT_DEFAULT_MS: k.WAIT_DEFAULT_MS, WAIT_MAX_MS: k.WAIT_MAX_MS, WAIT_SLACK_MS: k.WAIT_SLACK_MS, MAX_BYTES_IN_FLIGHT: k.MAX_BYTES_IN_FLIGHT, MAX_REQUEST: k.MAX_REQUEST, MAX_RESULT: k.MAX_RESULT, RESULT_PART_BYTES: k.RESULT_PART_BYTES, PART_BYTES: k.PART_BYTES });
  assert.equal(MAX_RESULT_PARTS, MAX_RESULT / RESULT_PART_BYTES);
});

test("the daemon's lines to the model have the vector's shapes: link up and down, allowlist, end_scope", () => {
  const r = rig({ up: false });
  r.c.linkUp("0.2.0");
  r.c.linkDown();
  r.c.linkUp("0.2.0");
  r.c.allowlist({ t: "allowlist", lists: { md: ["a.example"] }, scopes: { "my-repo": "md" }, default: null });
  r.c.endScope("my-repo");
  assert.deepEqual(r.lines, [V.daemonLines[0], V.daemonLines[1], V.daemonLines[0], V.daemonLines[2], V.daemonLines[4]]);
});

test("bind after a link up gives the model the link-up line; the allowlist line goes only while the link is up", () => {
  const r = rig({ up: false });
  r.c.allowlist({ t: "allowlist", lists: {}, scopes: {}, default: null });
  assert.deepEqual(r.lines, []);
  r.c.linkUp("0.3.6");
  const lines: any[] = [];
  r.c.bind({ answer: () => {}, daemon: (m) => lines.push(m) });
  assert.deepEqual(lines, [{ t: "link", up: true, version: "0.3.6" }]);
});

test("end_scope skips a name that is not a scope", () => {
  const r = rig();
  r.lines.length = 0;
  for (const bad of ["", "-x", "a b", "x".repeat(65), "a/b"]) r.c.endScope(bad);
  assert.deepEqual(r.lines, []);
});

test("not connected answers at once, and the request never goes", () => {
  const r = rig({ up: false });
  r.send(r.req("tabs.query", [{}], undefined, "5f3a9c01-30"));
  assert.deepEqual(r.answers, [V.daemonAnswers[0].res]);
  assert.equal(r.sent.length, 0);
});

test("a request goes as bridge parts with its wait, and the answer goes to the model", () => {
  const r = rig();
  const q = r.req("tabs.get", [7]);
  r.send(q);
  assert.equal(r.sent.length, 1);
  assert.ok(r.sent[0].every((p) => p.ch === "bridge" && p.id === q.id));
  assert.deepEqual(r.joined(r.sent[0]), q);
  r.c.message({ t: "res", ch: "bridge", id: q.id, ok: true, data: { id: 7 } });
  assert.deepEqual(r.answers, [{ t: "res", ch: "bridge", id: q.id, ok: true, data: { id: 7 } }]);
  assert.equal(r.c.inFlight(), 0);
});

test("a large request goes in several parts of PART_BYTES", () => {
  const r = rig();
  const q = r.req("debugger.sendCommand", [{ tabId: 1 }, "DOM.setFileInputFiles", { data: "x".repeat(1_600_000) }]);
  r.send(q);
  assert.equal(r.sent[0].length, 3);
  assert.deepEqual(r.joined(r.sent[0]), q);
});

test("the waits: an op's default, a bad wait goes unchanged and counts the default, an integral wait counts as it is", () => {
  assert.deepEqual(waitOf({ op: "debugger.sendCommand" }), [WAIT_MAX_MS, false]);
  assert.deepEqual(waitOf({ op: "tabs.get" }), [WAIT_DEFAULT_MS, false]);
  assert.deepEqual(waitOf({ op: "tabs.get", wait: 0 }), [WAIT_DEFAULT_MS, true]);
  assert.deepEqual(waitOf({ op: "tabs.get", wait: WAIT_MAX_MS + 1 }), [WAIT_DEFAULT_MS, true]);
  assert.deepEqual(waitOf({ op: "tabs.get", wait: 1.5 }), [WAIT_DEFAULT_MS, true]);
  assert.deepEqual(waitOf({ op: "tabs.get", wait: 5000 }), [5000, false]);
  const r = rig();
  const bad = { ...r.req("tabs.get", [1]), wait: 0 };
  r.send(bad);
  assert.equal(r.joined(r.sent[0]).wait, 0, "a bad wait goes as it is: the receiver answers bad wait");
});

test("queue time is taken from the wait, and a wait used up in the queue is a timeout and never sent", () => {
  const r = rig({ maxBytes: 10 });
  const a = r.req("tabs.get", [1]), b = r.req("tabs.get", [2], 5000), c = r.req("tabs.get", [3], 3000);
  r.send(a); r.send(b); r.send(c);
  assert.equal(r.sent.length, 1, "the bytes bound holds b and c: one request is in flight");
  r.tick(2000);
  r.c.message({ t: "res", ch: "bridge", id: a.id, ok: true, data: null });
  assert.equal(r.sent.length, 2);
  assert.equal(r.joined(r.sent[1]).wait, 3000, "b goes with its wait minus the 2 s in the queue");
  r.tick(3000);
  r.c.expire();
  assert.deepEqual(r.answers.slice(1).map((m) => [m.id, m.error]), [[c.id, TIMEOUT]], "c's 3 s ran out in the queue");
  assert.equal(r.sent.length, 2, "c never goes");
});

test("one request over the bytes bound goes when none is in flight, and requests go in their order", () => {
  const r = rig({ maxBytes: 10 });
  const a = r.req("tabs.get", [1]), b = r.req("tabs.get", [2]);
  r.send(a); r.send(b);
  assert.deepEqual(r.sent.map((p) => p[0].id), [a.id]);
  r.c.message({ t: "res", ch: "bridge", id: a.id, ok: true, data: null });
  assert.deepEqual(r.sent.map((p) => p[0].id), [a.id, b.id]);
});

test("MAX_BYTES_IN_FLIGHT: requests go while the bytes in flight and their own are within the bound", () => {
  const size = Buffer.byteLength(JSON.stringify({ t: "req", id: "5f3a9c01-1", op: "tabs.get", args: [1], wait: WAIT_DEFAULT_MS }));
  const r = rig({ maxBytes: 2 * size + 1 });
  const qs = [1, 2, 3, 4, 5].map((i) => r.req("tabs.get", [i]));
  for (const q of qs) r.send(q);
  assert.equal(r.sent.length, 2, "two requests fit the bound; the next ones wait");
  assert.equal(r.c.inFlight(), 2);
  r.c.message({ t: "res", ch: "bridge", id: qs[0].id, ok: true, data: null });
  assert.deepEqual(r.sent.map((p) => p[0].id), [qs[0].id, qs[1].id, qs[2].id]);
});

test("a second request with an id that waits is dropped", () => {
  const r = rig();
  const q = r.req("tabs.get", [1]);
  r.send(q); r.send(q);
  assert.equal(r.sent.length, 1);
  assert.ok(r.logs.some((l) => l.includes("its id waits already")));
});

test("a request above MAX_REQUEST is dropped and logged by its size only", () => {
  const r = rig();
  const q = r.req("tabs.get", [1]);
  r.c.fromModel(`${JSON.stringify(q)}${" ".repeat(MAX_REQUEST)}`, q);
  assert.equal(r.sent.length, 0);
  assert.ok(r.logs.some((l) => /dropped a request of \d+ bytes \(above MAX_REQUEST\)/.test(l)));
});

test("timeout after wait plus slack, and the late res is ignored; a timeout frees its bytes for the next request", () => {
  const r = rig({ maxBytes: 10 });
  const a = r.req("tabs.get", [1], 1000), b = r.req("tabs.get", [2], 60_000);
  r.send(a); r.send(b);
  r.tick(1000 + WAIT_SLACK_MS - 1);
  r.c.expire();
  assert.equal(r.answers.length, 0);
  r.tick(1);
  r.c.expire();
  assert.deepEqual(r.answers.map((m) => [m.id, m.error]), [[a.id, TIMEOUT]]);
  assert.deepEqual(r.sent.map((p) => p[0].id), [a.id, b.id], "the freed bytes let b go");
  r.c.message({ t: "res", ch: "bridge", id: a.id, ok: true, data: {} });
  assert.equal(r.answers.length, 1, "the late res is ignored");
});

test("a send on a link that refuses it answers disconnected", () => {
  const r = rig({ refuse: true });
  const q = r.req("tabs.get", [1]);
  r.send(q);
  assert.deepEqual(r.answers.map((m) => [m.id, m.error]), [[q.id, DISCONNECTED]]);
  assert.equal(r.c.inFlight(), 0);
});

test("res and events reach the model unchanged and in their order; a res for an id that the carrier does not wait for is ignored", () => {
  const r = rig();
  const q = r.req("tabs.get", [1]);
  r.send(q);
  r.lines.length = 0;
  const ev = { t: "ev", ch: "bridge", ev: "tabs.onUpdated", params: [1, { status: "loading" }] };
  r.c.message(ev);
  r.c.message({ t: "res", ch: "bridge", id: "other-1", ok: true, data: {} });
  r.c.message({ t: "res", ch: "bridge", id: q.id, ok: true, data: { x: 1 } });
  assert.deepEqual(r.lines, [ev]);
  assert.deepEqual(r.answers, [{ t: "res", ch: "bridge", id: q.id, ok: true, data: { x: 1 } }]);
});

test("result parts join into one res (the vector), in the place of the last part", () => {
  const v = V.resultParts;
  const r = rig();
  const q = { ...r.req("debugger.sendCommand", [{ tabId: 1 }, "Page.captureScreenshot", {}]), id: v.id };
  r.send(q);
  for (const p of v.parts) r.c.message(p);
  assert.deepEqual(r.answers, [v.res]);
});

test("more than 32 parts is too large; 32 parts is not", () => {
  const r = rig();
  const q = r.req("debugger.sendCommand", [{ tabId: 1 }, "Page.captureScreenshot", {}]);
  r.send(q);
  r.c.message({ t: "part", ch: "bridge", id: q.id, seq: 0, n: 33, b64: "e30=" });
  assert.deepEqual(r.answers.map((m) => m.error), [TOO_LARGE]);
  const q2 = r.req("debugger.sendCommand", [{ tabId: 1 }, "Page.captureScreenshot", {}]);
  r.send(q2);
  const body = Buffer.from(JSON.stringify({ t: "res", ch: "bridge", id: q2.id, ok: true, data: { d: "x".repeat(60) } }));
  const size = Math.ceil(body.length / 32);
  for (let i = 0; i < 32; i++) r.c.message({ t: "part", ch: "bridge", id: q2.id, seq: i, n: 32, b64: body.subarray(i * size, (i + 1) * size).toString("base64") });
  assert.equal(r.answers[1].ok, true);
});

test("another message before the last part times out its request; a part of another id drops the join", () => {
  const r = rig();
  const a = r.req("debugger.sendCommand", [{ tabId: 1 }, "Page.captureScreenshot", {}]), b = r.req("debugger.sendCommand", [{ tabId: 2 }, "Page.captureScreenshot", {}]);
  r.send(a); r.send(b);
  r.c.message({ t: "part", ch: "bridge", id: a.id, seq: 0, n: 2, b64: "e30=" });
  r.c.message({ t: "ev", ch: "bridge", ev: "tabs.onRemoved", params: [3] });
  assert.deepEqual(r.answers.map((m) => [m.id, m.error]), [[a.id, TIMEOUT]]);
  r.c.message({ t: "part", ch: "bridge", id: b.id, seq: 0, n: 2, b64: "e30=" });
  r.c.message({ t: "part", ch: "bridge", id: a.id, seq: 1, n: 2, b64: "e30=" });
  assert.deepEqual(r.answers.map((m) => [m.id, m.error]), [[a.id, TIMEOUT], [b.id, TIMEOUT]]);
});

test("a bad part times out its request: a bad seq, a bad n, bad base64, a join that is not one object line", () => {
  for (const bad of [{ seq: 1, n: 2, b64: "e30=" }, { seq: 0, n: 0, b64: "e30=" }, { seq: 0, n: 1, b64: "!!" }, { seq: 0, n: 1, b64: Buffer.from("[1]").toString("base64") }, { seq: 0, n: 1, b64: Buffer.from('{"a":\n1}').toString("base64") }]) {
    const r = rig();
    const q = r.req("debugger.sendCommand", [{ tabId: 1 }, "Page.captureScreenshot", {}]);
    r.send(q);
    r.c.message({ t: "part", ch: "bridge", id: q.id, ...bad });
    assert.deepEqual(r.answers.map((m) => m.error), [TIMEOUT], JSON.stringify(bad));
  }
});

test("parts of an id that the carrier does not wait for are skipped", () => {
  const r = rig();
  r.c.message({ t: "part", ch: "bridge", id: "x-1", seq: 0, n: 1, b64: "e30=" });
  assert.deepEqual(r.answers, []);
});

test("link down answers disconnected in order, then writes link down, and drops an unfinished join", () => {
  const r = rig();
  const a = r.req("tabs.get", [1], undefined, "5f3a9c01-31"), b = r.req("debugger.sendCommand", [{ tabId: 1 }, "Page.captureScreenshot", {}]);
  r.send(a); r.send(b);
  r.c.message({ t: "part", ch: "bridge", id: b.id, seq: 0, n: 2, b64: "e30=" });
  r.lines.length = 0;
  r.c.linkDown();
  assert.deepEqual(r.answers, [V.daemonAnswers[1].res, { t: "res", ch: "bridge", id: b.id, ok: false, error: DISCONNECTED }]);
  assert.deepEqual(r.lines, [{ t: "link", up: false }]);
  r.c.linkUp("0.3.6");
  r.c.message({ t: "part", ch: "bridge", id: b.id, seq: 1, n: 2, b64: "e30=" });
  assert.equal(r.answers.length, 2);
});

test("link up while up counts as a link change: disconnected first; link gen counts each change", () => {
  const r = rig({ up: false });
  assert.equal(r.c.linkGen(), 0);
  r.c.linkUp("0.3.6");
  const q = r.req("tabs.get", [1]);
  r.send(q);
  r.c.linkUp("0.3.7");
  assert.deepEqual(r.answers.map((m) => m.error), [DISCONNECTED]);
  assert.deepEqual(r.lines.map((l) => l.up), [true, false, true]);
  assert.equal(r.c.linkGen(), 3);
  r.c.linkDown(); r.c.linkDown();
  assert.equal(r.c.linkGen(), 4, "a down of a link that is down counts nothing");
});

test("attachNewOff sends [false] and its res never goes to the model; it fails with no link, at a drop and at a timeout", async () => {
  const r = rig();
  const p = r.c.attachNewOff();
  const parts = r.sent.at(-1)!;
  const msg = r.joined(parts);
  assert.deepEqual([msg.op, msg.args], ["bridge.attachNew", [false]]);
  assert.match(msg.id, /^aw-[0-9a-f]{8}-1$/);
  r.c.message({ t: "res", ch: "bridge", id: msg.id, ok: true, data: null });
  assert.equal(await p, true);
  assert.deepEqual(r.answers, []);
  const drop = r.c.attachNewOff();
  r.c.linkDown();
  assert.equal(await drop, false);
  assert.equal(await r.c.attachNewOff(), false);
  r.c.linkUp("0.3.6");
  const late = r.c.attachNewOff();
  r.tick(WAIT_DEFAULT_MS + WAIT_SLACK_MS);
  r.c.expire();
  assert.equal(await late, false);
});

test("up, in flight and idle for; clients follow the model's eager attach and reset at each link change", () => {
  const r = rig({ up: false });
  assert.equal(r.c.idleFor(), Infinity);
  r.c.linkUp("0.3.6");
  r.send(r.req("bridge.attachNew", [true]));
  assert.equal(r.c.clients(), true);
  assert.equal(r.c.inFlight(), 1);
  r.tick(500);
  assert.equal(r.c.idleFor(), 500);
  r.c.linkDown();
  assert.equal(r.c.clients(), false);
  r.c.linkUp("0.3.6");
  r.send(r.req("bridge.attachNew", [true]));
  r.send(r.req("bridge.attachNew", [false]));
  assert.equal(r.c.clients(), false);
});

test("daemon.blocked: the blocked vectors' answers and notices, before the link checks and outside the queue", () => {
  const r = rig({ up: false, maxBytes: 1 });
  for (const v of V.blockedVectors) {
    // The per-host limit (previous, attempts, now) is the prompts' (stage 1c's tests); an older carrier is not this one.
    if (!v.req || v.olderCarrier || v.previous || v.attempts) continue;
    const before = r.blocked.length;
    r.c.fromModel(JSON.stringify(v.req), v.req);
    assert.deepEqual(r.answers.at(-1), v.res, v.note);
    if (v.res.ok && v.notice) assert.deepEqual(r.blocked.at(-1), v.notice, v.note);
    if (!v.res.ok) assert.equal(r.blocked.length, before, v.note);
  }
  assert.equal(r.sent.length, 0, "no daemon op goes to the receiver");
});

test("the pointer ops go to the X pointer, also while the link is down; an unknown daemon op gets unknown op", async () => {
  const seen: string[] = [];
  const pointer: PointerPort = { answer: async (q) => { seen.push(q.op); return { t: "res", ch: "bridge", id: q.id, ok: true, data: { x: 1, y: 2, width: 3, height: 4, views: 0 } }; }, pending: () => false };
  const r = rig({ up: false, pointer });
  const q = r.req("daemon.pointerAt", [], 1200);
  r.send(q);
  await new Promise((s) => setImmediate(s));
  assert.deepEqual(seen, ["daemon.pointerAt"]);
  assert.deepEqual(r.answers.at(-1), { t: "res", ch: "bridge", id: q.id, ok: true, data: { x: 1, y: 2, width: 3, height: 4, views: 0 } });
  r.send(r.req("daemon.other", []));
  assert.equal(r.answers.at(-1).error, "unknown op");
  assert.equal(r.sent.length, 0);
});

test("a pointer op with no X pointer is no display; the stop answers nothing more and kills a playing path", async () => {
  const kills: string[] = [];
  let finish!: (v: any) => void;
  const pointer: PointerPort = { answer: (q) => new Promise((res) => { finish = () => res({ t: "res", ch: "bridge", id: q.id, ok: true, data: {} }); }), pending: () => false, kill: (k) => kills.push(k) };
  const r0 = rig();
  r0.send(r0.req("daemon.pointerAt", [], 1200));
  assert.equal(r0.answers.at(-1).error, "no display");
  const r = rig({ pointer });
  r.send(r.req("daemon.movePointer", [{}], 1500));
  r.c.stop();
  finish(null);
  await new Promise((s) => setImmediate(s));
  assert.deepEqual(r.answers, []);
  assert.ok(kills.includes("daemonStop"));
  r.c.linkDown();
  assert.ok(kills.includes("linkChange"));
});

test("no log line holds a request's args, a result or an event's params", () => {
  const r = rig({ maxBytes: 10 });
  const secret = "sekret-cookie-value";
  const a = r.req("debugger.sendCommand", [{ tabId: 1 }, "Runtime.evaluate", { expression: secret }], 1000);
  const b = r.req("debugger.sendCommand", [{ tabId: 1 }, "Runtime.evaluate", { expression: secret }], 1000);
  r.send(a); r.send(b);
  r.c.message({ t: "part", ch: "bridge", id: a.id, seq: 0, n: 2, b64: Buffer.from(secret).toString("base64") });
  r.c.message({ t: "ev", ch: "bridge", ev: "x", params: [secret] });
  r.tick(10_000);
  r.c.expire();
  r.c.fromModel(`{"t":"req","x":"${secret}"}`, { t: "req" } as any);
  assert.ok(r.logs.length >= 2);
  for (const l of r.logs) assert.doesNotMatch(l, new RegExp(secret));
});

test("daemon.blocked and the receiver's notice share one per-host limit in the service's prompts: the blocked vectors with a history", async () => {
  const { PromptBook } = await import("../src/service/prompts/prompts.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ab-limit-"));
  try {
    let checked = 0;
    for (const v of V.blockedVectors) {
      if (!v.req || v.olderCarrier || !(v.previous || v.attempts) || !v.res.ok) continue;
      let now = 0;
      const book = new PromptBook({ file: join(dir, `d${checked}.json`), now: () => now, wall: () => 0, log: () => {} });
      for (const p of v.previous ?? []) { now = p.at; assert.equal(book.admit(p.host), true, v.note); }
      for (const a of v.attempts ?? []) { now = a.at; assert.equal(book.admit(a.host), a.emitted, v.note); }
      now = v.now ?? 0;
      assert.equal(book.admit(v.req.args[0].host), v.notice !== null && v.notice !== undefined, v.note);
      checked++;
    }
    assert.ok(checked >= 6, `${checked} vectors with a history`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the X pointer of the service: no unit Xvfb or no xdotool is no display, with no X call; a read runs xdotool with only DISPLAY and XAUTHORITY", async () => {
  const { PointerOps, xWorld } = await import("../src/service/link/pointer-ops.ts");
  const { mkdtempSync, rmSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const req = (op: string, args: unknown[] = []) => ({ t: "req" as const, id: `p-${op}`, op, args, wait: 1200 });
  const none = new PointerOps(xWorld({ display: () => null, xdotool: "/usr/bin/xdotool" }));
  assert.equal((await none.answer(req("daemon.pointerAt")))!.error, "no display");
  const noTool = new PointerOps(xWorld({ display: () => ({ display: ":174", xauth: "/x", size: { width: 1280, height: 900 } }), xdotool: null }));
  assert.equal((await noTool.answer(req("daemon.pointerAt")))!.error, "no display");
  // A stand-in xdotool that prints its environment's two variables in its answer's place.
  const dir = mkdtempSync(join(tmpdir(), "ab-xdo-"));
  try {
    const tool = join(dir, "xdotool");
    writeFileSync(tool, `#!/bin/sh\nenv > ${join(dir, "env")}\necho "x:12 y:34 screen:0 window:1"\n`, { mode: 0o755 });
    const ops = new PointerOps(xWorld({ display: () => ({ display: ":174", xauth: join(dir, "xauth"), size: { width: 1280, height: 900 } }), xdotool: tool }));
    assert.deepEqual(await ops.answer(req("daemon.pointerAt")), { t: "res", ch: "bridge", id: "p-daemon.pointerAt", ok: true, data: { x: 12, y: 34, width: 1280, height: 900, views: 0 } });
    const env = readFileSync(join(dir, "env"), "utf8").split("\n").filter((l) => l && !l.startsWith("PWD=") && !l.startsWith("SHLVL=") && !l.startsWith("_="));
    assert.deepEqual(env.sort(), [`DISPLAY=:174`, `XAUTHORITY=${join(dir, "xauth")}`]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
