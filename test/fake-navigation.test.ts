// Chromium navigation events: modified links request a new page; same-tab links request the current page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CDPConnection } from "../src/cdp.ts";
import { FakeChrome } from "./fake-chrome.ts";

for (const [label, attrs, button, modifiers, expected] of [
  ["plain target=_blank", { target: "_blank" }, "left", 0, []],
  ["target=_blank with noopener", { target: "_blank", rel: "noopener" }, "left", 0, []],
  ["target=_blank with opener", { target: "_blank", rel: "opener" }, "left", 0, []],
  ["Ctrl-click", {}, "left", 2, ["newTab"]],
  ["middle click", {}, "middle", 0, ["newTab"]],
  ["Shift-click", {}, "left", 8, ["newWindow"]],
  ["same-tab link", {}, "left", 0, ["currentTab", "start", "commit"]],
  ["window.open", {}, "left", 0, []],
] as const) test(`fake navigation: ${label} sends the Chromium events on the opener`, async () => {
  const fake = await FakeChrome.start(() => ({ title: "links", elements: [
    { tag: "a", id: "link", attrs: { href: "/next", ...attrs }, rect: [0, 0, 100, 30] },
  ] }));
  const conn = await CDPConnection.connect(fake.ws);
  try {
    const page = fake.addPage("http://example.test/");
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    await conn.send("Page.enable", {}, sessionId);
    const seen: string[] = [];
    for (const [method, value] of [["Page.frameRequestedNavigation", "request"], ["Page.frameStartedNavigating", "start"], ["Page.frameNavigated", "commit"]])
      conn.on(method, (p, sid) => { if (sid === sessionId) seen.push(value === "request" ? p.disposition : value); });
    if (label === "window.open") await conn.send("Runtime.evaluate", { expression: "window.open('http://example.test/next', '_blank')" }, sessionId);
    else await conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 10, y: 10, button, buttons: 0, clickCount: 1, modifiers }, sessionId);
    assert.deepEqual(seen, expected);
    if (label === "same-tab link") assert.equal(page.url, "http://example.test/next");
    else {
      assert.equal(page.url, "http://example.test/");
      const opened = [...fake.pages.values()].find((p) => p !== page)!;
      assert.equal(opened?.url, "http://example.test/next");
      assert.equal(opened.windowId !== page.windowId, label === "Shift-click");
      if (label.startsWith("target=_blank") || label === "plain target=_blank")
        assert.equal(opened.noopener, attrs.rel !== "opener");
    }
  } finally { conn.close(); await fake.close(); }
});
