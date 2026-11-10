// The test helpers clean up after themselves: a consumer's temp folder goes at the test process's exit, also when the
// test never calls remove() (taylor's /tmp once ran out of inodes from such folders).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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
