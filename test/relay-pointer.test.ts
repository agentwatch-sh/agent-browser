// The relay's side of the daemon's pointer ops (board ab-v16.71; the agent pointer design,
// docs/superpowers/specs/2026-11-06-agent-pointer-move-design.md, sections 2, 3 and 7; contract C10 "The daemon's own
// ops" and C11 "The pointer at an activation" in chrome-extension's docs/protocol.md). The vectors are copies of
// chrome-extension test/vectors/{bridge,endpoint}.json at commit 8a3b66f (main, the merge of PR #31: C10's daemon ops
// with the pointer vectors p1-p108, C11's pointer constants); the folder name names that commit. The older tests read
// the copy at 40c2d93: its vectors are not a subset of these (a request vector and the endpoint's upgrade checks changed).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Bridge, BridgeError, MAX_IN_FLIGHT_PER_TAB, RELAY_TIMER } from "../src/relay/bridge.ts";

const vectors = (name: string) => JSON.parse(readFileSync(new URL(`./vectors/chrome-extension-8a3b66f/${name}.json`, import.meta.url), "utf8"));
const bridgeV = vectors("bridge");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MOVE = bridgeV.pointerVectors.find((v: any) => v.req.id === "p14").req.args[0];

// ------------------------------------------------------------------ the bridge

test("an error answer keeps its data (C10: an error res of a daemon. op may carry data); an ok answer gives its data", async () => {
  const lines: any[] = [];
  const b = new Bridge((l) => lines.push(JSON.parse(l)));
  const moved = b.call("daemon.movePointer", [MOVE], { wait: 1565 }).catch((e) => e);
  const plain = b.call("daemon.pointerAt").catch((e) => e);
  const ok = b.call("daemon.pointerAt");
  const res = (id: string) => bridgeV.pointerVectors.find((v: any) => v.req.id === id).res;
  b.answer({ ...res("p70"), id: lines[0].id });
  b.answer({ ...res("p5"), id: lines[1].id });
  b.answer({ ...res("p1"), id: lines[2].id });
  const e = await moved;
  assert.ok(e instanceof BridgeError);
  assert.equal(e.message, "pointer moved");
  assert.deepEqual(e.data, { x: 900, y: 431, views: 0 });
  const p = await plain;
  assert.equal(p.message, "too many moves");
  assert.equal(p.data, undefined, "no data on an error that has none");
  assert.deepEqual(await ok, { x: 812, y: 431, width: 1280, height: 900, views: 0 });
});

test("the daemon's ops have their own waits (daemon.pointerAt POINTER_READ_WAIT_MS, daemon.movePointer per request) and the in-flight key pointer", async () => {
  const c = bridgeV.pointerConstants;
  const lines: any[] = [];
  const b = new Bridge((l) => lines.push(JSON.parse(l)));
  for (const row of bridgeV.daemonOps) assert.equal(row.inFlightKey, "pointer", row.op);
  assert.equal(bridgeV.daemonOps.find((r: any) => r.op === "daemon.pointerAt").wait, "`POINTER_READ_WAIT_MS`");
  void b.call("daemon.pointerAt").catch(() => {});
  void b.call("daemon.movePointer", [MOVE], { wait: 1565 }).catch(() => {});
  assert.deepEqual(lines.map((l) => [l.op, l.args, l.wait]), [["daemon.pointerAt", [], c.POINTER_READ_WAIT_MS], ["daemon.movePointer", [MOVE], 1565]]);
  // The key pointer is apart: the shared key full of requests does not hold the daemon's ops back, nor they it.
  for (let i = 0; i < MAX_IN_FLIGHT_PER_TAB; i++) void b.call("tabs.query", [{}]).catch(() => {});
  void b.call("daemon.pointerAt").catch(() => {});
  assert.equal(lines.at(-1).op, "daemon.pointerAt");
  b.dropAll();
});

test("the relay's own timer ends the wait of a daemon op at its wait; the late answer is dropped, and the key's slot is free", async () => {
  const lines: any[] = [];
  const b = new Bridge((l) => lines.push(JSON.parse(l)));
  const t0 = Date.now();
  const late = await b.call("daemon.movePointer", [MOVE], { wait: 60 }).catch((e) => e);
  assert.ok(late instanceof BridgeError);
  assert.equal(late.message, RELAY_TIMER);
  assert.ok(Date.now() - t0 >= 55, "it waited its wait");
  b.answer({ t: "res", ch: "bridge", id: lines[0].id, ok: true, data: { x: 1, y: 1, views: 0 } }); // dropped: no request waits
  // A bridge op of the receiver keeps C10's way: no timer of the relay (the daemon always answers).
  const kept = b.call("tabs.get", [7]);
  await sleep(80);
  b.answer({ t: "res", ch: "bridge", id: lines[1].id, ok: true, data: { id: 7 } });
  assert.deepEqual(await kept, { id: 7 });
  // The pointer key has no request in flight after the timer: 64 more go out at once.
  for (let i = 0; i < MAX_IN_FLIGHT_PER_TAB; i++) void b.call("daemon.pointerAt").catch(() => {});
  assert.equal(lines.filter((l) => l.op === "daemon.pointerAt").length, MAX_IN_FLIGHT_PER_TAB);
  b.dropAll();
});
