// The end of the agent-mode live suite's run folder (test/live/agent-mode/run.ts and run-folder.ts, board ab-v16.64):
// after the run stopped its children and wrote results.json, it removes the large parts that it made (the scratch
// install, the tarball's folder, Chromium's home and profile, the copy of the agent package), and the whole run folder
// when it made that folder itself and no case failed. KEEP_RUN=1 keeps everything. It never removes a path that it did
// not make. The spawn tests run the suite against a stand-in endpoint (test/helpers.ts, suiteStandIn): a stand-in npm
// that fails stops the run at its scratch install, before it starts anything; with STAND_IN_NPM=install and CASES=none
// the run passes with no group. Most spawn tests use SITE_PORT=0. The taken-port test redirects the fixed port check
// to its own listener, so no spawn test touches a port of another program.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { keepRun, runFolderEnd, type RunEnd } from "./live/agent-mode/run-folder.ts";
import { suiteStandIn } from "./helpers.ts";

const RUN = "/tmp/ab-agent-live-Ab12Cd";
const PARTS = ["home", "install", "pack", "agent", "profile"].map((p) => join(RUN, p));
const end = (o: Partial<RunEnd> = {}) => runFolderEnd({ run: RUN, ownRun: true, made: PARTS, failed: 0, running: 0, ...o });
/** A run that passes: the stand-in npm makes the modules, and no group runs. */
const PASS = { STAND_IN_NPM: "install", CASES: "none" };

test("a run that made its run folder and had no failed case removes the whole folder", () => {
  const r = end();
  assert.deepEqual(r.remove, [RUN]);
  assert.equal(r.whole, true);
  assert.match(r.line, /^removed the run folder \/tmp\/ab-agent-live-Ab12Cd: no case failed \(KEEP_RUN=1 keeps it\)$/);
});

test("a run with RUN from the environment removes only the large parts that it made, never RUN itself", () => {
  const r = end({ ownRun: false });
  assert.deepEqual(r.remove, PARTS);
  assert.equal(r.whole, false);
  assert.match(r.line, /^removed home, install, pack, agent, profile from \/tmp\/ab-agent-live-Ab12Cd; logs and results\.json stay: RUN came from the environment/);
  // Only what the run made: a run that made no profile (the external mode) removes none.
  assert.deepEqual(end({ ownRun: false, made: [join(RUN, "home"), join(RUN, "install")] }).remove, [join(RUN, "home"), join(RUN, "install")]);
  assert.deepEqual(end({ ownRun: false, made: [] }).remove, []);
  assert.match(end({ ownRun: false, made: [] }).line, /^the run made no large part in \/tmp\/ab-agent-live-Ab12Cd: it removed nothing/);
});

test("the removal list has only entries of the run folder: never the folder itself, a path above it or elsewhere", () => {
  const odd = [RUN, `${RUN}/`, "/tmp", "/", "/tmp/other/install", `${RUN}/../install`, `${RUN}-x/install`, `${RUN}/logs/../../x`, `${RUN}/install/deep`, "install"];
  assert.deepEqual(end({ ownRun: false, made: [...odd, join(RUN, "home")] }).remove, [join(RUN, "home")]);
  // A part that the run recorded twice is removed once.
  assert.deepEqual(end({ ownRun: false, made: [join(RUN, "home"), join(RUN, "home")] }).remove, [join(RUN, "home")]);
  // The whole folder needs a folder that is not the root.
  assert.deepEqual(runFolderEnd({ run: "/", ownRun: true, made: [], failed: 0, running: 0 }).remove, []);
});

test("a failed case or an abort keeps the run folder that the run made, with its logs and results.json", () => {
  const failed = end({ failed: 2 });
  assert.deepEqual(failed.remove, PARTS);
  assert.equal(failed.whole, false);
  assert.match(failed.line, /logs and results\.json stay: 2 cases failed/);
  const aborted = end({ aborted: "signal SIGINT" });
  assert.deepEqual(aborted.remove, PARTS);
  assert.match(aborted.line, /logs and results\.json stay: the run was aborted \(signal SIGINT\)/);
});

test("KEEP_RUN=1 keeps everything; an empty KEEP_RUN or 0 does not", () => {
  for (const keep of ["1", "yes", "true"]) {
    assert.equal(keepRun(keep), true, keep);
    for (const o of [{}, { ownRun: false }, { failed: 1 }]) {
      const r = end({ ...o, keep });
      assert.deepEqual(r.remove, [], keep);
      assert.match(r.line, new RegExp(`^KEEP_RUN=${keep}: the run removed nothing in /tmp/ab-agent-live-Ab12Cd$`));
    }
  }
  for (const keep of [undefined, "", "0"]) {
    assert.equal(keepRun(keep), false, String(keep));
    assert.deepEqual(end({ keep }).remove, [RUN], String(keep));
  }
});

test("a process of the run that still runs after the stop keeps everything", () => {
  const r = end({ running: 1 });
  assert.deepEqual(r.remove, []);
  assert.match(r.line, /^1 process of the run still runs: the run removed nothing in \/tmp\/ab-agent-live-Ab12Cd$/);
  assert.match(end({ running: 2, ownRun: false }).line, /^2 processes of the run still run: /);
});

test("an abort with an empty reason is an abort: the run keeps its folder", () => {
  const r = end({ aborted: "" });
  assert.deepEqual(r.remove, PARTS);
  assert.equal(r.whole, false);
  assert.match(r.line, /logs and results\.json stay: the run was aborted \(no reason\)/);
});

/** The run folder that a run without RUN made (the first line of its output). */
const runOf = (stdout: string) => /^run (.*)$/m.exec(stdout)?.[1] ?? "";
const results = (run: string) => JSON.parse(readFileSync(join(run, "results.json"), "utf8"));

test("a run with RUN from the environment removes the parts that it made at its end, and keeps RUN, logs/ and results.json", async () => {
  const s = await suiteStandIn();
  try {
    const run = join(s.dir, "run");
    const r = await s.run({ RUN: run });
    assert.equal(r.status, 1, r.stderr);
    assert.match(results(run).aborted, /^Command failed: npm pack /);
    assert.equal(existsSync(join(run, "logs/control.log")), true);
    for (const part of ["home", "install", "pack"]) assert.equal(existsSync(join(run, part)), false, part);
    assert.match(r.stdout, /results\.json\nremoved home, install, pack from .*; logs and results\.json stay: RUN came from the environment/);
    // The run stopped before its first client: its only CONTROL call is the env line's status, and it ends no scope.
    assert.deepEqual(s.calls(), ["status"]);
    assert.doesNotMatch(r.stdout, /ended the run's scopes/);
  } finally { await s.remove(); }
});

test("a run removes nothing that it did not make, keeps the mode of a RUN that it did not make, and KEEP_RUN=1 keeps every part", async () => {
  const s = await suiteStandIn();
  try {
    // A RUN with a home/ that was there before the run: the run uses it, and both stay as they were.
    const run = join(s.dir, "run");
    mkdirSync(join(run, "home"), { recursive: true });
    chmodSync(run, 0o755);
    const r = await s.run({ RUN: run });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(existsSync(join(run, "home")), true);
    assert.equal(statSync(run).mode & 0o777, 0o755);
    assert.match(r.stdout, /\nremoved install, pack from /);
    const kept = join(s.dir, "kept");
    const k = await s.run({ RUN: kept, KEEP_RUN: "1" });
    assert.equal(k.status, 1, k.stderr);
    for (const part of ["home", "install", "pack"]) assert.equal(existsSync(join(kept, part)), true, part);
    assert.match(k.stdout, /\nKEEP_RUN=1: the run removed nothing in /);
  } finally { await s.remove(); }
});

test("a part that another run makes just before this run's make is never removed (review-64, B1)", async () => {
  const s = await suiteStandIn();
  try {
    const run = join(s.dir, "run");
    const r = await s.run({ RUN: run, STAND_IN_HOOK: "race:home,install" });
    assert.deepEqual(s.hookLog(), ["made home", "made install"]);
    // The run uses a home/ that is there; it stops at an install/ that is there (EEXIST), and records neither.
    assert.equal(r.status, 1, r.stderr);
    assert.match(results(run).aborted, /EEXIST/);
    for (const part of ["home", "install"]) assert.equal(existsSync(join(run, part, "theirs.txt")), true, part);
    assert.match(r.stdout, /\nthe run made no large part in .*: it removed nothing\n/);
  } finally { await s.remove(); }
});

test("a taken site port stops the run before it makes anything or calls CONTROL (review-64, B2)", async () => {
  // The hook redirects the fixed site port check to this test's own listener. It touches no shared port.
  const held = createServer();
  await new Promise<void>((r) => held.listen(0, "127.0.0.1", r));
  const s = await suiteStandIn();
  try {
    const port = (held.address() as { port: number }).port, tmp = join(s.dir, "tmp"), run = join(s.dir, "run");
    mkdirSync(tmp);
    for (const env of [{ RUN: run }, { TMPDIR: tmp }]) {
      const r = await s.run({ ...env, SITE_PORT: "8781", STAND_IN_HOOK: `site-port:${port}` });
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.equal(r.stderr, `port 8781 is taken (the probe's site needs it)\n`);
    }
    assert.deepEqual(s.calls(), []);
    assert.equal(existsSync(run), false);
    assert.deepEqual(readdirSync(tmp), []);
  } finally { held.close(); await s.remove(); }
});

test("a run that made its run folder keeps it after an abort, without its large parts", async () => {
  const s = await suiteStandIn();
  try {
    const tmp = join(s.dir, "tmp");
    mkdirSync(tmp);
    const r = await s.run({ TMPDIR: tmp });
    assert.equal(r.status, 1, r.stderr);
    const run = runOf(r.stdout);
    assert.match(run, new RegExp(`^${tmp}/ab-agent-live-`));
    assert.equal(existsSync(join(run, "results.json")), true);
    assert.equal(existsSync(join(run, "home")), false);
    assert.match(r.stdout, /; logs and results\.json stay: the run was aborted/);
  } finally { await s.remove(); }
});

test("an error with an empty message is an abort: the run exits 1 and keeps its folder (review-64, note 1)", async () => {
  const s = await suiteStandIn();
  try {
    const tmp = join(s.dir, "tmp");
    mkdirSync(tmp);
    const r = await s.run({ TMPDIR: tmp, STAND_IN_HOOK: "empty-error" });
    assert.deepEqual(s.hookLog(), ["threw an empty error"]);
    assert.equal(r.status, 1, r.stderr);
    const run = runOf(r.stdout);
    assert.equal(results(run).aborted, "an error with no message");
    assert.equal(existsSync(join(run, "logs")), true);
    assert.match(r.stdout, /\nABORTED \(an error with no message\): .*\nremoved home from .*: the run was aborted/);
  } finally { await s.remove(); }
});

test("a signal stays the abort's reason when an error follows it (review-64, note 1)", async () => {
  const s = await suiteStandIn();
  try {
    const run = join(s.dir, "run");
    const r = await s.run({ RUN: run, ...PASS, STAND_IN_HOOK: "signal-then-error" });
    assert.deepEqual(s.hookLog(), ["the site sent SIGINT", "threw after the signal"]);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(results(run).aborted, "signal SIGINT");
  } finally { await s.remove(); }
});

test("a failed case without an abort keeps the run folder that the run made, with logs/ and results.json (review-64, B3)", async () => {
  const s = await suiteStandIn();
  try {
    const tmp = join(s.dir, "tmp");
    mkdirSync(tmp);
    // The CONTROL stub says that the browser does not run: the external mode's last case fails.
    const r = await s.run({ TMPDIR: tmp, ...PASS, STAND_IN_RUNNING: "false" });
    assert.equal(r.status, 1, r.stderr);
    const run = runOf(r.stdout);
    assert.equal(results(run).aborted, undefined);
    assert.equal(results(run).results.filter((x: { status: string }) => x.status === "fail").length, 1);
    assert.equal(existsSync(join(run, "logs/site.log")), true);
    for (const part of ["home", "install", "pack"]) assert.equal(existsSync(join(run, part)), false, part);
    assert.match(r.stdout, /\n2 cases: 0 pass, 1 fail, 1 skipped, .*\nremoved home, install, pack from .*; logs and results\.json stay: 1 case failed/);
  } finally { await s.remove(); }
});

test("a process of the run that still runs at the cleanup keeps everything (review-64, note 2)", async () => {
  const s = await suiteStandIn();
  try {
    // The CONTROL stub's second status call (the last case) sends SIGINT to the run and answers 2 s later: the cleanup
    // runs while that call still runs.
    const run = join(s.dir, "run");
    const r = await s.run({ RUN: run, ...PASS, STAND_IN_CONTROL: "signal" });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(results(run).aborted, "signal SIGINT");
    assert.match(r.stdout, /\n1 process of the run still runs: the run removed nothing in /);
    for (const part of ["home", "install", "pack"]) assert.equal(existsSync(join(run, part)), true, part);
  } finally { await s.remove(); }
});

test("a run that made its run folder and passed removes the whole folder", async () => {
  const s = await suiteStandIn();
  try {
    const tmp = join(s.dir, "tmp");
    mkdirSync(tmp);
    const r = await s.run({ TMPDIR: tmp, ...PASS });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const run = runOf(r.stdout);
    assert.match(run, new RegExp(`^${tmp}/ab-agent-live-`));
    assert.match(r.stdout, /\n2 cases: 1 pass, 0 fail, 1 skipped, .*\nremoved the run folder (.*): no case failed \(KEEP_RUN=1 keeps it\)\n$/);
    assert.equal(existsSync(run), false);
    // The run had clients: it ends their scopes at its end.
    assert.deepEqual(s.calls(), ["status", "status", "end-scope s1", "end-scope s2", "end-scope s3"]);
  } finally { await s.remove(); }
});

test("a run that passed with RUN from the environment keeps RUN, its logs and results.json", async () => {
  const s = await suiteStandIn();
  try {
    const run = join(s.dir, "run");
    const r = await s.run({ RUN: run, ...PASS });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\nremoved home, install, pack from .*; logs and results\.json stay: RUN came from the environment/);
    assert.equal(results(run).results.length, 2);
    for (const kept of ["logs/site.log", "upload.txt"]) assert.equal(existsSync(join(run, kept)), true, kept);
    for (const part of ["home", "install", "pack"]) assert.equal(existsSync(join(run, part)), false, part);
  } finally { await s.remove(); }
});
