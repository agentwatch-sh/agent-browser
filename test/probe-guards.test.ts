// Contract checks for historical probes. These tests never execute a probe or start Xvfb or Chromium.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { startMode } from "./live/function-keys/trials.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const probes = "docs/superpowers/specs/";
for (const file of ["2026-11-05-sign-in-provider-probe/common.ts", "2026-11-05-orphan-agent-tabs-probe/probe.ts"]) {
  test(`${file}: display refusal and the guard precede effects; the guard tracks each spawned process`, () => {
    const s = read(probes + file);
    const effects = s.indexOf("mkdirSync(");
    const check = s.indexOf('reservedDisplay(DISPLAY_N, "DISPLAY_N")');
    assert.ok(check > 0 && check < effects, "reserved displays are refused before the probe writes or starts anything");
    const displayCode = s.slice(s.indexOf("const DISPLAY_N ="), s.indexOf("const reserved =") + s.slice(s.indexOf("const reserved =")).indexOf("process.exit(2); }") + "process.exit(2); }".length);
    const displayCheck = new Function("process", "reservedDisplay", displayCode);
    for (const n of [0, 90, 147, 190, 191, 192, 90.5]) {
      assert.throws(() => displayCheck({ env: { DISPLAY_N: String(n) }, stderr: { write() {} }, exit() { throw new Error("display refused"); } }, (n: number) => [0, 90, 147, 190, 191, 192].includes(n) ? "reserved" : null), /display refused/);
    }
    const guard = s.indexOf("await harnessGuard(");
    assert.ok(guard > 0 && guard < effects, "the guard precedes the probe's effects");
    for (const line of s.split("\n").filter((l) => /const \w+ = spawn\(/.test(l))) {
      const name = /const (\w+) = spawn\(/.exec(line)![1];
      const afterSpawn = s.slice(s.indexOf(";", s.indexOf(line)) + 1);
      assert.match(afterSpawn, new RegExp(`^\\s*harness\\.track\\(${name}\\.pid,`), `the guard tracks ${name} immediately after spawn`);
    }
  });
}
test("the shell doc probe refuses reserved displays before effects and guards all children", () => {
  const s = read(probes + "2026-11-03-two-modes-probe/run.sh");
  const check = s.indexOf('reserved_display "$DISPLAY_N"');
  assert.ok(check > 0 && check < s.indexOf("mkdir -p"));
  assert.match(s, /0\|90\|147\|190\|191\|192/);
  const fn = s.slice(s.indexOf("reserved_display()"), s.indexOf('reserved_display "$DISPLAY_N"'));
  for (const n of ["0", "90", "147", "190", "191", "192", "90.5", "00", "090", "bad"]) {
    const r = spawnSync("bash", ["-c", `${fn}\nreserved_display "$1"`, "display-check", n], { encoding: "utf8" });
    assert.equal(r.status, 2, `the shell refuses ${n}: ${r.stderr}`);
  }
  assert.equal(spawnSync("bash", ["-c", `${fn}\nreserved_display "$1"`, "display-check", "167"]).status, 0);
  const guard = s.indexOf('harness_guard.py');
  assert.ok(guard > 0 && guard < s.indexOf('Xvfb ":$DISPLAY_N"'));
  assert.match(s, /--driver "\$\$" --pid-dir "\$RUN\/pids"/);
  assert.match(s, /echo "\$!" >"\$RUN\/pids\/xvfb"/);
  assert.match(s, /echo "\$!" >"\$RUN\/pids\/chromium"/);
  assert.match(s, /echo "\$!" >"\$RUN\/pids\/site"/);
  assert.match(s, /echo "\$!" >"\$RUN\/pids\/relay"/);
});
test("the sign-in probe instructions use a non-reserved display", () => {
  const s = read(probes + "2026-11-05-sign-in-provider-probe/README.md");
  for (const m of s.matchAll(/DISPLAY_N=(\d+)/g)) assert.ok(![0, 90, 147, 190, 191, 192].includes(Number(m[1])));
});
test("function keys refuse fractional and invalid display numbers", () => {
  for (const display of ["90.5", "NaN", "", "-1", "1.5"]) {
    assert.match((startMode("linux", { display }) as { error: string }).error ?? "", /whole number/);
  }
});
test("anti-detect refuses a fractional display before effects", () => {
  const s = read("test/live/anti-detect/run.ts");
  const prefix = s.slice(s.indexOf('const CHROME ='), s.indexOf('const OUT ='));
  const check = new Function("values", "reservedDisplay", "refuse", prefix);
  assert.throws(() => check({ display: "90.5" }, () => null, (m: string) => { throw new Error(m); }), /whole number/);
});
test("anti-detect extra starts no Chromium when Xvfb exits or its socket never appears", async () => {
  const s = read("test/live/anti-detect/extra.ts");
  const body = s.slice(s.indexOf('const xvfb ='), s.indexOf('const XENV:'));
  const start = new Function("spawn", "DISPLAY", "xauth", "children", "harness", "existsSync", "sleep", "say", "process", `return (async () => { ${body} })()`);
  for (const [exitCode, signalCode, socket] of [[1, null, true], [null, "SIGTERM", true], [null, null, false]]) {
    await assert.rejects(start(() => ({ pid: 123, exitCode, signalCode }), 167, "test-auth", [], { track() {} }, () => socket, async () => {}, () => {}, { exit() { throw new Error("Xvfb refused"); } }), /Xvfb/);
  }
  await start(() => ({ pid: 123, exitCode: null, signalCode: null }), 167, "test-auth", [], { track() {} }, () => true, async () => {}, () => {}, { exit() { throw new Error("a ready Xvfb must pass"); } });
});

test("the shell doc probe prints a guard refusal even with errexit", () => {
  const s = read(probes + "2026-11-03-two-modes-probe/run.sh");
  const guardStart = s.indexOf('python3 -I -B');
  const start = s.lastIndexOf('\n', guardStart) + 1;
  const commands = s.slice(start, s.indexOf('mkdir -p "$RES"'));
  const dir = mkdtempSync(join(tmpdir(), "probe-refusal-"));
  try {
    const script = `set -euo pipefail\nRUN="$1"\nHERE=unused\npython3() { printf 'refused fixture lock\\n'; return 2; }\n${commands}`;
    const r = spawnSync("bash", ["-c", script, "guard-refusal", dir], { encoding: "utf8" });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /refused fixture lock/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
