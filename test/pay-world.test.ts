// The facts of the card payment's checks 1, 5 and 6 (contract C11, the card payment; board ab-sta.6, the plan's Task
// 5a): the real PayWorld (src/service/pay/world.ts) over a port, and the model's act port that gives it the scope's tabs
// with their URLs from Chrome (tabs.get), never a hidden tab. The receiver is test/fake-bridge.ts. TEST values only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { payWorld } from "../src/service/pay/world.ts";
import { harness, lineOf } from "./fake-bridge.ts";

test("the real PayWorld: check 1 is the model's readiness text, check 5 the scope's list (coveredBy), check 6 the scope's tabs with their URLs; a read that fails gives no tab", async () => {
  let notReady: string | null = "The agent browser is not ready: its extension is not connected.";
  const lists: Record<string, string[]> = { "web-1": ["example.com", "pay.localhost"] };
  let tabs: () => Promise<{ id: number; url: string }[]> = async () => [{ id: 7, url: "https://shop.example.com/checkout" }, { id: 8, url: "" }, { id: 1.5, url: "x" } as any, null as any];
  const w = payWorld({ notReady: () => notReady, entries: (s) => lists[s] ?? null, tabs: () => tabs() });
  assert.equal(w.notReady(), notReady);
  notReady = null;
  assert.equal(w.notReady(), null);
  assert.equal(w.covers("web-1", "shop.example.com"), true, "a subdomain of an entry");
  assert.equal(w.covers("web-1", "example.com"), true);
  assert.equal(w.covers("web-1", "badexample.com"), false);
  assert.equal(w.covers("web-1", "pay.localhost"), true);
  assert.equal(w.covers("web-2", "shop.example.com"), false, "a scope with no list covers no host");
  assert.deepEqual(await w.tabs("web-1"), [{ id: 7, url: "https://shop.example.com/checkout" }, { id: 8, url: "" }], "only tabs of the read's shape");
  tabs = async () => { throw new Error("the link went down"); };
  assert.deepEqual(await w.tabs("web-1"), []);
});

test("the model's act port: tabs(scope) gives the scope's tabs with their URLs as Chrome gives them (tabs.get), and never an act tab", async () => {
  const h = await harness();
  try {
    await h.ready(lineOf(["a.example", "shop.example.com"]));
    const port = h.relay.model.actPort();
    const a = h.fake.newTab("https://shop.example.com/checkout?cart=1", undefined, 1, 0, "s1");
    const b = h.fake.newTab("https://a.example/", undefined, 1, 0, "s2");
    for (const end = Date.now() + 3000; (await port.tabs("s1")).length === 0 || (await port.tabs("s2")).length === 0;) {
      assert.ok(Date.now() < end, "the tabs of s1 and s2");
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(await port.tabs("s1"), [{ id: a.id, url: "https://shop.example.com/checkout?cart=1" }]);
    assert.deepEqual(await port.tabs("s2"), [{ id: b.id, url: "https://a.example/" }]);
    // Chrome's URL now (the agent moved the tab), not a URL that the model kept.
    a.url = "https://shop.example.com/checkout/pay";
    assert.deepEqual(await port.tabs("s1"), [{ id: a.id, url: "https://shop.example.com/checkout/pay" }]);
    // A hidden tab (an act tab) is no tab of the scope.
    port.hide(a.id);
    assert.deepEqual(await port.tabs("s1"), []);
    assert.deepEqual(await port.tabs("s9"), []);
  } finally { await h.close(); }
});

test("check 6 reads the tabs with a wait (the real world asks Chrome): two calls of one scope at the same time still give the second \"A payment request of this scope waits\" (check 7 and the hold of the scope have no wait between them); a failed read is no tab", async () => {
  const { payWorld: world, withCard, PAY, ORIGIN, SCOPE_A } = await import("./pay-fakes.ts");
  let fail = false;
  const w = world({ cardPay: { world: { notReady: () => null, covers: () => true, tabs: async () => { await new Promise((r) => setTimeout(r, 20)); if (fail) throw new Error("the link went down"); return [{ id: 7, url: `${ORIGIN}/checkout?cart=1` }]; } } } });
  try {
    await withCard(w);
    let open!: () => void;
    w.page.gate = new Promise<void>((r) => { open = r; });
    const local = { scope: SCOPE_A, admission: "local" as const };
    const a = w.part.pay!.open(PAY, local), b = w.part.pay!.open(PAY, local);
    assert.equal((await b).text, "A payment request of this scope waits.");
    assert.equal(w.prepared.length, 1);
    open();
    w.part.pay!.stop();
    await a;
    fail = true;
    assert.equal((await w.part.pay!.open(PAY, local)).text, `Exactly one tab of this session must show the checkout of ${ORIGIN}.`);
  } finally { w.close(); }
});
