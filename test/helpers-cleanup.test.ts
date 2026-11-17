// The test helpers clean up after themselves: a consumer's temp folder goes at the test process's exit, also when the
// test never calls remove() (the Linux server's /tmp once ran out of inodes from such folders), and also when SIGTERM,
// SIGINT or SIGHUP ends the test process (a stopped run, the timeout of a test wrapper: thousands of folders stayed).
// Board ab-v16.9.3 removed the test of the proxy child's end (the CDP proxy is gone).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

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

const WORLD = fileURLToPath(new URL("./fake-unit-world.ts", import.meta.url));

/** A node child that runs `code` (it prints `DIRS <JSON array of folders>` and then stays), ended by `signal`. */
async function endedBy(signal: NodeJS.Signals, code: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; dirs: string[]; stderr: string }> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `${code}\nsetInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", stderr = "";
  child.stderr.on("data", (b) => { stderr += b; });
  const ended = new Promise<[number | null, NodeJS.Signals | null]>((r) => child.once("exit", (c, s) => r([c, s])));
  const dirs = await new Promise<string[]>((resolve, reject) => {
    child.stdout.on("data", (b) => { out += b; const m = /^DIRS (.+)$/m.exec(out); if (m) resolve(JSON.parse(m[1])); });
    void ended.then(([c, s]) => reject(new Error(`the child ended before its folders: ${c ?? s}\n${stderr}`)));
  });
  child.kill(signal);
  const [c, s] = await ended;
  return { code: c, signal: s, dirs, stderr };
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  test(`${signal} that ends a test process removes its consumer's temp folder and a fake unit World's, and the process ends with 128 + the signal's number`, { timeout: 30_000 }, async () => {
    const r = await endedBy(signal, `import { consumer } from ${JSON.stringify(HELPERS)}; import { World } from ${JSON.stringify(WORLD)};
const c = consumer(), w = new World(); console.log("DIRS " + JSON.stringify([c.dir, w.dir]));`);
    try {
      assert.equal(r.dirs.length, 2);
      assert.match(r.dirs[0], /\/ab-[^/]+$/);
      assert.match(r.dirs[1], /\/ab-unit-[^/]+$/);
      assert.deepEqual([r.code, r.signal], [128 + constants.signals[signal], null], r.stderr);
      for (const d of r.dirs) assert.equal(existsSync(d), false, `${d} is gone`);
    } finally {
      // A red run: the folders that the child left (this test's own).
      for (const d of r.dirs) rmSync(d, { recursive: true, force: true });
    }
  });
}
