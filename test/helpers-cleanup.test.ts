// The test helpers clean up after themselves: a consumer's temp folder goes at the test process's exit, also when the
// test never calls remove() (taylor's /tmp once ran out of inodes from such folders).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveOptions } from "../src/options.ts";
import { proxyInfo, startProxy } from "../src/proxy.ts";
import { FakeChrome } from "./fake-chrome.ts";
import { consumer } from "./helpers.ts";

const HELPERS = fileURLToPath(new URL("./helpers.ts", import.meta.url));

test("a consumer's temp folder is removed at the process's exit, also with no remove(); remove() still removes it at once", () => {
  const code = `import { consumer } from ${JSON.stringify(HELPERS)};
const kept = consumer(); const gone = consumer(); gone.remove();
console.log(JSON.stringify({ kept: kept.dir, gone: gone.dir }));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  const { kept, gone } = JSON.parse(out.trim().split("\n").at(-1)!);
  assert.match(kept, /ab-/);
  assert.equal(existsSync(gone), false, "remove() removes it at once");
  assert.equal(existsSync(kept), false, "the exit removes the folder that no test removed");
});

test("board ab-v16.98, cause 2: a proxy child that ends after its consumer's remove(), and its parent's record of that end, make no state folder again", { timeout: 60_000 }, async () => {
  const fake = await FakeChrome.start();
  const c = consumer();
  const s = resolveOptions(c.options());
  let pid: number | undefined;
  const runs = (p: number) => { try { process.kill(p, 0); return true; } catch { return false; } };
  try {
    await startProxy(s, fake.ws, 20_000);
    pid = proxyInfo(s)!.pid;
    c.remove();
    // The child's Chrome goes: the child records its exit and reads its pid file, and this process (its parent) records
    // the child's end. Each went through stateDir (mkdirSync with recursive), which made the removed folder again.
    await fake.close();
    for (let i = 0; i < 250 && runs(pid); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(runs(pid), false, "the proxy child ended");
    assert.equal(existsSync(c.dir), false, "no state folder again after remove()");
  } finally {
    // A red run: the child and the folder that it made again (this test's own).
    if (pid !== undefined && runs(pid)) process.kill(pid, "SIGTERM");
    await fake.close();
    rmSync(c.dir, { recursive: true, force: true });
  }
});
