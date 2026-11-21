// The card payment's check 1 in the real service (contract C11, the card payment, check 1; board ab-sta.8, a defect that
// the live check found): the service's PayWorld gives the model's readiness as it is. A ready model (no text) lets the
// request go on to its next checks; before the fix, `notReady() ?? <the link's text>` turned that ready answer into "The
// agent browser is not ready: its extension is not connected.", so every browser_pay of a ready agent browser stopped at
// check 1. The service runs over the fake unit world (test/fake-unit-world.ts): no Chrome starts. TEST values only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PAY_TEXT } from "../src/service/pay/texts.ts";
import { tempDir } from "./temp-dirs.ts";

test("the service's PayWorld (service.ts): a ready model lets browser_pay go past check 1 to the store's check; a model that is not ready gives its own text", { skip: process.platform !== "linux", timeout: 90_000 }, async () => {
  const { startService } = await import("../src/service/service.ts");
  const { FakeTools, World } = await import("./fake-unit-world.ts");
  const w = new World();
  const tools = new FakeTools();
  const dir = tempDir("ab-pay-ready-");
  mkdirSync(join(dir, "lists"));
  writeFileSync(join(dir, "lists", "owner.repo.json"), JSON.stringify({ allow: ["a.example"], repo: "owner/repo" }));
  const s = await startService({
    agentDoor: join(dir, "cdp.sock"), controlDoor: join(dir, "control.sock"), daemonCommand: join(dir, "daemon-command.json"), log: () => {}, mainPid: async () => null,
    lists: { listsFolder: join(dir, "lists"), stateFolder: w.paths.state },
    unit: { paths: w.paths, owner: async () => ({ active: "active", sub: "running", mainPid: process.pid }), tools, procs: w.procs, part: { unit: w.deps(tools), firstCheckMs: 3_600_000, usePollMs: 5 } },
    link: { socket: join(dir, "link.sock"), pidfds: { failed: "none" }, xdotool: null, peer: async () => ({ ok: true, pid: 4242 }) },
    mcp: { listen: { port: 0 } },
    signIns: { protections: () => null },
    payAct: {},
  } as any);
  try {
    const part = (s.state as any).parts.find((p: any) => "pay" in p && "store" in p);
    assert.ok(part?.pay, "the payment requests with the option");
    const model = (s.agent as any).relay.model;
    const input = { card: "travel", origin: "https://a.example", amount: "1.00", currency: "USD", description: "a test" };
    // No receiver: the model's own text.
    const own = model.notReady();
    assert.match(String(own), /^The agent browser is not ready: /);
    const down = await part.pay.open(input, { scope: "web-1", admission: "local" });
    assert.deepEqual([down.state, down.text], ["stopped", own]);
    // A ready model (no text): check 1 passes, and the request stops at check 3 (no store is set up here).
    model.notReady = () => null;
    const up = await part.pay.open(input, { scope: "web-1", admission: "local" });
    assert.deepEqual([up.state, up.text], ["stopped", PAY_TEXT.locked], "a ready model is no readiness refusal");
    // Another text of the model is the one that the request gets.
    model.notReady = () => "The agent browser is not ready: a test's own reason.";
    assert.equal((await part.pay.open(input, { scope: "web-1", admission: "local" })).text, "The agent browser is not ready: a test's own reason.");
  } finally { await s.stop(); w.close(); rmSync(dir, { recursive: true, force: true }); }
});
