// The end of the agent-mode live suite's run folder (test/live/agent-mode/run.ts and run-folder.ts, board ab-v16.64):
// after the run stopped its children and wrote results.json, it removes the large parts that it made (the scratch
// install, the tarball's folder, Chromium's home and profile, the copy of the agent package), and the whole run folder
// when it made that folder itself and no case failed. KEEP_RUN=1 keeps everything. It never removes a path that it did
// not make. The spawn tests stop the run at its scratch install (a stand-in npm that fails), before it starts anything.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { keepRun, runFolderEnd, type RunEnd } from "./live/agent-mode/run-folder.ts";
import { suiteStandIn } from "./helpers.ts";

const RUN = "/tmp/ab-agent-live-Ab12Cd";
const PARTS = ["home", "install", "pack", "agent", "profile"].map((p) => join(RUN, p));
const end = (o: Partial<RunEnd> = {}) => runFolderEnd({ run: RUN, ownRun: true, made: PARTS, failed: 0, running: 0, ...o });
/** The run checks that port 8781 (the probe's site) is free; with SITE_PORT=0 its site takes another port. */
const port8781Free = () => new Promise<boolean>((r) => { const c = connect(8781, "127.0.0.1"); c.once("connect", () => { c.destroy(); r(false); }); c.once("error", () => r(true)); });
/** A run that passes: the stand-in npm makes the modules, no group runs, and the site takes a free port. */
const PASS = { STAND_IN_NPM: "install", CASES: "none", SITE_PORT: "0" };

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

test("a child of the run that still runs after the stop keeps everything", () => {
  const r = end({ running: 1 });
  assert.deepEqual(r.remove, []);
  assert.match(r.line, /^1 child of the run still runs: the run removed nothing in \/tmp\/ab-agent-live-Ab12Cd$/);
  assert.match(end({ running: 2, ownRun: false }).line, /^2 children of the run still run: /);
});

test("a run with RUN from the environment removes the parts that it made at its end, and keeps RUN, logs/ and results.json", async () => {
  const s = await suiteStandIn();
  try {
    const run = join(s.dir, "run");
    const r = await s.run({ RUN: run });
    assert.equal(r.status, 1, r.stderr);
    const results = JSON.parse(readFileSync(join(run, "results.json"), "utf8"));
    assert.equal(typeof results.aborted, "string");
    assert.equal(existsSync(join(run, "logs/control.log")), true);
    for (const part of ["home", "install", "pack"]) assert.equal(existsSync(join(run, part)), false, part);
    // The stand-in npm stops the run after it made its install folders (a taken port 8781 stops it before them).
    assert.match(r.stdout, /results\.json\nremoved home(, install, pack)? from .*; logs and results\.json stay: RUN came from the environment/);
    if (/npm/.test(results.aborted)) assert.match(r.stdout, /removed home, install, pack from /);
  } finally { await s.remove(); }
});

test("a run removes nothing that it did not make, and KEEP_RUN=1 keeps every part that it made", async () => {
  const s = await suiteStandIn();
  try {
    // A home/ that was there before the run: the run uses it, and it stays.
    const run = join(s.dir, "run");
    mkdirSync(join(run, "home"), { recursive: true });
    const r = await s.run({ RUN: run });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(existsSync(join(run, "home")), true);
    assert.doesNotMatch(r.stdout, /removed home/);
    const kept = join(s.dir, "kept");
    const k = await s.run({ RUN: kept, KEEP_RUN: "1" });
    assert.equal(k.status, 1, k.stderr);
    assert.equal(existsSync(join(kept, "home")), true);
    assert.match(k.stdout, /\nKEEP_RUN=1: the run removed nothing in /);
  } finally { await s.remove(); }
});

test("a run that made its run folder keeps it after an abort, without its large parts", async () => {
  const s = await suiteStandIn();
  try {
    const tmp = join(s.dir, "tmp");
    mkdirSync(tmp);
    const r = await s.run({ TMPDIR: tmp });
    assert.equal(r.status, 1, r.stderr);
    const run = /^run (.*)$/m.exec(r.stdout)?.[1] ?? "";
    assert.match(run, new RegExp(`^${tmp}/ab-agent-live-`));
    assert.equal(existsSync(join(run, "results.json")), true);
    assert.equal(existsSync(join(run, "home")), false);
    assert.match(r.stdout, /; logs and results\.json stay: the run was aborted/);
  } finally { await s.remove(); }
});

test("a run that made its run folder and passed removes the whole folder", async (t) => {
  if (!(await port8781Free())) return t.skip("port 8781 is taken (a live run): the run would abort");
  const s = await suiteStandIn();
  try {
    const tmp = join(s.dir, "tmp");
    mkdirSync(tmp);
    const r = await s.run({ TMPDIR: tmp, ...PASS });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const run = /^run (.*)$/m.exec(r.stdout)?.[1] ?? "";
    assert.match(run, new RegExp(`^${tmp}/ab-agent-live-`));
    assert.match(r.stdout, /\n2 cases: 1 pass, 0 fail, 1 skipped, .*\nremoved the run folder (.*): no case failed \(KEEP_RUN=1 keeps it\)\n$/);
    assert.equal(existsSync(run), false);
  } finally { await s.remove(); }
});

test("a run that passed with RUN from the environment keeps RUN, its logs and results.json", async (t) => {
  if (!(await port8781Free())) return t.skip("port 8781 is taken (a live run): the run would abort");
  const s = await suiteStandIn();
  try {
    const run = join(s.dir, "run");
    const r = await s.run({ RUN: run, ...PASS });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\nremoved home, install, pack from .*; logs and results\.json stay: RUN came from the environment/);
    assert.equal(JSON.parse(readFileSync(join(run, "results.json"), "utf8")).results.length, 2);
    for (const kept of ["logs/site.log", "upload.txt"]) assert.equal(existsSync(join(run, kept)), true, kept);
    for (const part of ["home", "install", "pack"]) assert.equal(existsSync(join(run, part)), false, part);
  } finally { await s.remove(); }
});
