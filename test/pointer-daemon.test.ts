// The live test's stand-in daemon answers the two daemon ops (board ab-v16.71; the agent pointer design, section 4;
// contract C10 "The daemon's own ops"): every pointer vector p1-p108 of chrome-extension's bridge.json at 8a3b66f, with
// the vector's world (the Xvfb, xdotool, another X call, the live view, the counts, the clock, the read and the play).
// The stand-in's ops (test/live/agent-mode/pointer-ops.ts) run with an X world that the test gives: no xdotool runs here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PointerOps, type PlayEnd, type XWorld } from "./live/agent-mode/pointer-ops.ts";

const bridgeV = JSON.parse(readFileSync(new URL("./vectors/chrome-extension-8a3b66f/bridge.json", import.meta.url), "utf8"));

/** The X world of a vector: pointerWorld with the vector's keys, and a record of the reads and the script. */
function worldOf(v: any) {
  const w = { ...bridgeV.pointerWorld, ...(v.world ?? {}) };
  const seen = { reads: 0, script: null as string[] | null };
  let clock = w.now;
  const x: XWorld = {
    xvfb: w.xvfb, xdotool: w.xdotool, xCall: () => w.xCall,
    liveView: () => w.liveView === null ? null : { views: w.liveView.views, quietMs: w.liveView.lastInputMs },
    clock: () => clock,
    read: async () => { seen.reads++; clock = w.playAt; return w.pointer; },
    play: async (script) => {
      seen.script = script;
      const p = w.play;
      if (typeof p === "string") return p as PlayEnd;
      return { end: p.end };
    },
  };
  return { x, seen, w };
}

test("the stand-in daemon answers each pointer vector of the contract (p1-p108): the answer, the read and the script on xdotool's standard input", async () => {
  assert.equal(bridgeV.pointerVectors.length, 108);
  for (const v of bridgeV.pointerVectors) {
    const { x, seen, w } = worldOf(v);
    const ops = new PointerOps(x);
    ops.started(w.started.paths, w.started.reads);
    const res = await ops.answer(v.req);
    assert.deepEqual(res, v.res, `${v.req.id}: ${v.note}`);
    assert.equal(seen.reads > 0, v.read, `${v.req.id}: the read`);
    const asNumbers = (s: string[] | null) => s?.map((l) => (l.startsWith("sleep ") ? ["sleep", Number(l.slice(6))] : l));
    assert.deepEqual(asNumbers(seen.script), asNumbers(v.script), `${v.req.id}: the script`);
  }
});

test("the counts: a play counts when it starts and a read when its X call starts, apart; a refusal does not count", async () => {
  const v = bridgeV.pointerVectors.find((p: any) => p.req.id === "p14");
  const { x } = worldOf(v);
  const ops = new PointerOps(x);
  for (let i = 0; i < 5; i++) assert.equal((await ops.answer({ ...v.req, id: `m${i}` }))?.ok, true, `play ${i}`);
  assert.equal((await ops.answer({ ...v.req, id: "m5" }))?.error, "too many moves");
  assert.equal((await ops.answer({ t: "req", id: "r0", op: "daemon.pointerAt", args: [], wait: 1200 }))?.ok, true, "the plays do not count for a read");
});
