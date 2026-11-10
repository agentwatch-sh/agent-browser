// Every command of agent-browser holds SIGUSR1 at start: the inspector signal is disabled (board ab-v16.96).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BIN = join(ROOT, "bin/agent-browser.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a long-running command holds SIGUSR1 at start (the inspector signal is disabled) and keeps running", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-sig-"));
  const sock = join(dir, "control.sock");
  // A random inspector port, so that the test never takes port 9229.
  const child = spawn(process.execPath, ["--inspect-port=127.0.0.1:0", BIN, "service", "--fake", "--control-door", sock], { stdio: ["pipe", "pipe", "pipe"] });
  let err = "", out = "";
  child.stderr!.on("data", (d) => (err += d));
  child.stdout!.on("data", (d) => (out += d));
  try {
    for (let i = 0; i < 200 && !out.includes("\n"); i++) await sleep(50);
    assert.equal(out, '{"t":"listening"}\n', err);
    child.kill("SIGUSR1");
    await sleep(1000);
    assert.doesNotMatch(err, /Debugger listening/, "no inspector opened");
    assert.equal(child.exitCode, null, "the command still runs");
    assert.ok(existsSync(sock), "the command still serves");
    child.kill("SIGTERM");
    assert.equal(await new Promise((r) => child.once("exit", (c) => r(c))), 0, err);
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
});
