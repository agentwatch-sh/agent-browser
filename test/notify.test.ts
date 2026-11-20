// The notify hook of `status --notify` (src/notify.ts; ported from vedlo's diagnostics.test.ts): one message to a
// callback or a command when agent mode's endpoint does not answer. A notify command writes only into this test's temp
// folder. Board ab-v16.9.3 removed the CDP proxy's diagnostics and their tests; this hook stays.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { notifyBrowserStatus } from "../src/notify.ts";
import { resolveOptions, type Settings } from "../src/options.ts";
import { consumer, type Consumer } from "./helpers.ts";

let c: Consumer, s: Settings;
before(() => {
  c = consumer(["example.org"]);
  s = resolveOptions(c.options({ cdpUrl: "ws+unix:///tmp/ab-no-endpoint.sock:/devtools/browser/n" }));
});
after(() => c.remove());

test("the notify hook: one attempt, as a callback or as a command, and an uncertain transport reported truthfully", async () => {
  const got: string[] = [];
  assert.deepEqual(await notifyBrowserStatus(s, "agent mode's endpoint did not answer", (m) => { got.push(m); }), { delivery: "queued", detail: "notification queued" });
  assert.deepEqual(got, ["agent-browser connection needs attention: agent mode's endpoint did not answer"]);
  assert.match((await notifyBrowserStatus(s, "x", () => { throw new Error("transport"); })).detail, /unconfirmed.*outcome unknown/);
  assert.match((await notifyBrowserStatus(s, "x", undefined)).detail, /no notify hook configured/);

  const out = join(c.dir, "notified.txt"), stdinOut = join(c.dir, "notified-stdin.txt");
  const write = "const fs = require('node:fs'); fs.writeFileSync(process.argv[1], process.argv[2]); fs.writeFileSync(process.argv[3], fs.readFileSync(0, 'utf8'));";
  const r = await notifyBrowserStatus(s, "pending", { command: [process.execPath, "-e", write, out, "inbox: {message}", stdinOut] });
  assert.deepEqual(r, { delivery: "queued", detail: "notification queued" });
  assert.equal(readFileSync(out, "utf8"), "inbox: agent-browser connection needs attention: pending", "{message} is replaced in argv");
  assert.equal(readFileSync(stdinOut, "utf8"), "agent-browser connection needs attention: pending", "and the message is on stdin");
  assert.match((await notifyBrowserStatus(s, "x", { command: [process.execPath, "-e", "process.exit(6)"] })).detail, /unconfirmed \(exit 6\)/);
  assert.match((await notifyBrowserStatus(s, "x", { command: [join(c.dir, "no-such-program")] })).detail, /unconfirmed \(ENOENT; outcome unknown/);
  assert.throws(() => resolveOptions(c.options({ cdpUrl: s.cdpUrl, notify: { command: [] } })), /notify must be a function or \{ command/);
});
