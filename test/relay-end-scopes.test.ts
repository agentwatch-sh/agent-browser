// The refusal after end_scope against the real relay (board ab-v16.94.27): C11's master text, docs/contracts/C11.md
// ("When a connection ends", end_scope, and step 7 of the order of the checks), with its shared vectors `endScopes` in
// test/vectors/endpoint.json. test/contracts-c11.test.ts checks the same vectors with its reference rules; this test
// runs each of them through the relay's HTTP door on a socket of its own, with the fake receiver and daemon of
// fake-bridge.ts: the link comes up, the vector's steps go to the relay in order as the daemon's lines (an allowlist
// line of `lines`, an end_scope), and a restart stops the relay and starts a new one (it loses its line and its set of
// ended scopes; the link comes up again). Then a new connection of the vector's scope gets the vector's answer: the
// no-list 503, or the upgrade (admit).
//
// The session check (step 6) is not part of these vectors. So with the peer check the relay gets a peer gate whose
// session check admits every peer that it read at the accept (one fake peer of the relay's uid): the list checks
// (steps 5 and 7) decide the answer, and an admit is the upgrade.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PeerGate, type Peer, type PeerReader, type Root } from "../src/relay/peer.ts";
import { readEndpoint, type Endpoint } from "./contracts-c11-vectors.ts";
import { harness, raw, until, type Harness } from "./fake-bridge.ts";

const endpoint = readEndpoint(readFileSync(new URL("./vectors/endpoint.json", import.meta.url), "utf8"));
type Vector = Endpoint["endScopes"][number];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The uid of the gate and of its one fake peer. */
const UID = 1001;

/** A reader that gives one peer of the gate's uid at each accept, with a new pidfd number; it reads no process. */
function onePeer(): PeerReader {
  let next = 100;
  return {
    form: "pidfd",
    peer: () => ({ pid: 4242, uid: UID, pidfd: next++, start: null }),
    proc: () => null,
    cgroup: () => null,
    poll: () => 0,
    fdinfoPid: () => 4242,
    close: () => {},
  };
}

/** The peer check with a session check (step 6) that admits every peer that the relay read; it records each check's scope. */
class EverySession extends PeerGate {
  readonly checked: string[] = [];
  override check(scope: string, peer: Peer): Root | null {
    this.checked.push(scope);
    return { pid: peer.pid, start: 0 };
  }
}

/** A relay of the vector's kind with its link up: the link line, then the steps of the link up up to debugger.getTargets. */
async function start(v: Vector): Promise<{ h: Harness; gate: EverySession | null }> {
  const gate = v.peerCheck ? new EverySession({ reader: onePeer(), uid: UID }) : null;
  const h = await harness(gate ? { peerCheck: gate } : {});
  h.fake.line({ t: "link", up: true, version: "0.3.13" });
  await until(() => h.fake.sent("debugger.getTargets").length, "the steps of the link up");
  return { h, gate };
}

/** The relay has read every line that the test wrote: it reads its standard input line by line, in order. */
async function read(h: Harness): Promise<void> {
  await until(() => h.fake.input.writableLength === 0 && h.fake.input.readableLength === 0, "the relay to read the lines");
  await sleep(5);
}

test("the refusal after end_scope (C11): each endScopes vector runs against the relay, and a new connection of its scope gets its answer", { timeout: 120_000 }, async (t) => {
  const vectors = endpoint.endScopes;
  assert.ok(vectors.length > 0, "the master has endScopes vectors");
  const noList = endpoint.upgradeAnswers.find((a) => a.id === "noList");
  assert.ok(noList, "the no-list 503 of upgradeAnswers");
  let ran = 0;
  for (const [i, v] of vectors.entries()) {
    await t.test(`${i}: ${v.note}`, async () => {
      let r: Awaited<ReturnType<typeof start>> | null = await start(v);
      try {
        for (const [n, st] of v.steps.entries()) {
          const at = `${v.note}: step ${n}`;
          assert.equal([st.line, st.endScope, st.restart].filter((x) => x !== undefined).length, 1, `${at}: one of line, endScope and restart`);
          if (st.line !== undefined) {
            assert.ok(Object.hasOwn(endpoint.lines, st.line), `${at}: the line ${st.line} is in lines`);
            r.h.fake.line(endpoint.lines[st.line]);
          } else if (st.endScope !== undefined) {
            r.h.fake.line({ t: "end_scope", scope: st.endScope });
          } else {
            assert.equal(st.restart, true, at);
            const old = r.h;
            r = null;
            await old.close();
            r = await start(v);
          }
          await read(r.h);
        }
        const { h, gate } = r;
        // Step 4 passes (the link is up, bridge.info answered, a line applied): only the list checks can refuse.
        await until(() => h.relay.model.notReady() === null, `${v.note}: the relay to be ready`);
        const got = await raw(h.url(v.scope));
        got.ws?.close();
        if (v.answer === "noList") assert.deepEqual([got.status, got.body], [noList.status, noList.body], v.note);
        else {
          assert.equal(v.answer, "admit", `${v.note}: an answer of the vectors`);
          assert.ok(got.ws, `${v.note}: the upgrade, not ${got.status} ${got.body}`);
          // With the peer check the session check ran once, for this scope, and admitted the peer.
          if (gate) assert.deepEqual(gate.checked, [v.scope], `${v.note}: the session check`);
        }
        ran++;
      } finally { await r?.h.close(); }
    });
  }
  assert.equal(ran, vectors.length, "every endScopes vector ran and got its answer");
});
