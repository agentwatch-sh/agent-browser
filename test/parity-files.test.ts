// The parity probe's files (test/live/parity/files.ts): developer mode and the probe extension in
// a profile's preference files, on Linux and on macOS, and a run folder's summary.json across a
// --serve run and a full run, with the note of compare.ts for a column of another run. The fixtures
// are made up; none comes from a real profile or a real run.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { otherRun, readPrefs, writeServeColumn, writeSummary, type Summary } from "./live/parity/files.ts";
import { ROOT } from "./helpers.ts";

let tmp = "";
before(() => { tmp = mkdtempSync(join(tmpdir(), "ab-parity-")); });
after(() => rmSync(tmp, { recursive: true, force: true }));

function profile(name: string, files: { [file: string]: unknown }): string {
  const p = join(tmp, name, "profile");
  mkdirSync(join(p, "Default"), { recursive: true });
  for (const [f, v] of Object.entries(files)) writeFileSync(join(p, "Default", f), JSON.stringify(v));
  return p;
}

const UNPACKED = { location: 4, state: 1, path: "/runs/stable/parity-ext" };
const OTHER = { location: 1, path: "/somewhere/else" };

test("readPrefs on Linux: developer mode and the extension settings come from Preferences", () => {
  const p = profile("linux", {
    Preferences: { extensions: { ui: { developer_mode: true }, settings: { aaaa: UNPACKED, bbbb: OTHER } } },
    "Secure Preferences": { extensions: { ui: { developer_mode: false } }, protection: { macs: {} } },
  });
  const r = readPrefs(p, new Set(), "linux");
  assert.equal(r.developerMode, true, "Preferences, not Secure Preferences");
  assert.deepEqual(Object.keys(r.ours), ["aaaa"]);
  assert.equal(r.ours.aaaa.location, 4);
});

test("readPrefs on macOS: Chrome keeps developer mode in Secure Preferences", () => {
  const p = profile("mac", {
    Preferences: { extensions: { ui: {} } },
    "Secure Preferences": { extensions: { ui: { developer_mode: true }, settings: { aaaa: UNPACKED } } },
  });
  const r = readPrefs(p, new Set(), "darwin");
  assert.equal(r.developerMode, true);
  assert.deepEqual(Object.keys(r.ours), ["aaaa"]);
});

test("readPrefs on macOS: Secure Preferences wins when both files hold developer mode; the extension settings too", () => {
  const p = profile("both", {
    Preferences: { extensions: { ui: { developer_mode: true }, settings: { aaaa: { ...UNPACKED, state: 1 } } } },
    "Secure Preferences": { extensions: { ui: { developer_mode: false }, settings: { aaaa: { ...UNPACKED, state: 0 } } } },
  });
  const r = readPrefs(p, new Set(), "darwin");
  assert.equal(r.developerMode, false);
  assert.equal(r.ours.aaaa.state, 0);
  // The extension settings merge the same way on Linux (as before).
  assert.equal(readPrefs(p, new Set(), "linux").ours.aaaa.state, 0);
});

test("readPrefs: a new or missing profile says nothing, and the packed extension counts by its ID", () => {
  assert.deepEqual(readPrefs(join(tmp, "none")), { developerMode: undefined, ours: {} });
  const p = profile("packed", { Preferences: { extensions: { settings: { cccc: { location: 3, path: "/runs/stable/parity-crx" }, dddd: OTHER } } } });
  assert.deepEqual(Object.keys(readPrefs(p).ours), []);
  assert.deepEqual(Object.keys(readPrefs(p, new Set(["cccc"])).ours), ["cccc"]);
});

// What a full run writes for its own labels, and the entry that an older serve() wrote.
const FULL_STARTED = "2026-01-02T03:04:05.000Z";
const full = (browsers: Summary["browsers"], blockedEgress: Summary["blockedEgress"]): Summary =>
  ({ started: FULL_STARTED, platform: "darwin", spki: "full-run-spki", browsers, blockedEgress });
const operator = { bin: "(operator: a browser that a person opened)", version: "the browser's own", runs: {} };

function folder(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir);
  return join(dir, "summary.json");
}
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));

test("writeSummary: a full run keeps the --serve column written before it, with that run's start and platform", () => {
  const file = folder("serve-then-full");
  writeFileSync(file, JSON.stringify({ started: "2026-01-01T00:00:00.000Z", platform: "darwin", browsers: { operator }, blockedEgress: [] }));
  const stable = { bin: "/bin/stable", version: "Chrome 1.2.3.4", runs: { site: { records: 3 } } };
  writeSummary(file, full({ stable }, [{ run: "stable/site-plain", host: "a.invalid:443" }]));
  const s = read(file);
  assert.deepEqual(Object.keys(s.browsers), ["stable", "operator"], "this run's columns first, then the kept one");
  assert.deepEqual(s.browsers.operator, { ...operator, started: "2026-01-01T00:00:00.000Z", platform: "darwin" });
  assert.deepEqual(s.browsers.stable, stable);
  assert.equal(s.started, FULL_STARTED);
  assert.equal(s.spki, "full-run-spki");
  assert.deepEqual(s.blockedEgress, [{ run: "stable/site-plain", host: "a.invalid:443" }]);
  assert.equal(otherRun(s, "operator"), "from an earlier run: darwin 2026-01-01T00:00:00.000Z");
  assert.equal(otherRun(s, "stable"), undefined);
});

test("writeSummary: a run rewrites its own labels and keeps the others with their run and blocked hosts", () => {
  const file = folder("full-then-full");
  writeSummary(file, { ...full({ stable: { version: "old stable" }, beta: { version: "old beta" } }, [
    { run: "stable/site-plain", host: "old-stable.invalid:443" }, { run: "beta/site-plain", host: "beta.invalid:443" },
  ]), started: "2025-12-01T00:00:00.000Z", platform: "linux" });
  writeSummary(file, full({ stable: { version: "new stable" } }, [{ run: "stable/site-plain", host: "new-stable.invalid:443" }]));
  const s = read(file);
  assert.deepEqual(s.browsers, { stable: { version: "new stable" }, beta: { version: "old beta", started: "2025-12-01T00:00:00.000Z", platform: "linux" } });
  assert.deepEqual(s.blockedEgress, [{ run: "stable/site-plain", host: "new-stable.invalid:443" }, { run: "beta/site-plain", host: "beta.invalid:443" }]);
  assert.equal(otherRun(s, "beta"), "from an earlier run: linux 2025-12-01T00:00:00.000Z");
  // A third run keeps beta's own run, not the second run's.
  writeSummary(file, { ...full({ stable: { version: "newer stable" } }, []), started: "2026-02-01T00:00:00.000Z" });
  assert.deepEqual(read(file).browsers.beta, { version: "old beta", started: "2025-12-01T00:00:00.000Z", platform: "linux" });
});

test("writeSummary: a label that is also an Object member is kept, and a blocked host without a run is skipped", () => {
  const file = folder("odd");
  writeFileSync(file, JSON.stringify({ started: "2026-01-01T00:00:00.000Z", platform: "darwin", browsers: { toString: { version: "t" }, constructor: { version: "c" } },
    blockedEgress: [{ host: "no-run.invalid:443" }, { run: "toString/site-plain", host: "t.invalid:443" }] }));
  writeSummary(file, full({ stable: { version: "v" } }, []));
  const s = read(file);
  assert.deepEqual(Object.keys(s.browsers), ["stable", "toString", "constructor"]);
  assert.deepEqual(s.blockedEgress, [{ run: "toString/site-plain", host: "t.invalid:443" }]);
});

test("writeSummary: a summary.json that is not JSON is replaced", () => {
  const file = folder("broken");
  writeFileSync(file, "{ not json");
  writeSummary(file, full({ stable: { version: "v" } }, []));
  assert.deepEqual(Object.keys(read(file).browsers), ["stable"]);
});

test("writeServeColumn: the --serve column carries its own start and platform", () => {
  // Alone in a new folder: the summary is that run's, so compare.ts adds no note.
  const alone = folder("serve-alone");
  writeServeColumn(alone, "operator", "2026-01-01T00:00:00.000Z", "darwin");
  const a = read(alone);
  assert.equal(a.started, "2026-01-01T00:00:00.000Z");
  assert.equal(a.platform, "darwin");
  assert.deepEqual(a.browsers.operator, { ...operator, started: "2026-01-01T00:00:00.000Z", platform: "darwin" });
  assert.equal(otherRun(a, "operator"), undefined);
  // After a full run: the summary stays the full run's, and the column names its own run.
  const after = folder("full-then-serve");
  writeSummary(after, full({ stable: { version: "v" } }, [{ run: "stable/site-plain", host: "a.invalid:443" }]));
  writeServeColumn(after, "operator", "2026-01-03T00:00:00.000Z", "linux");
  const b = read(after);
  assert.equal(b.started, FULL_STARTED);
  assert.equal(b.spki, "full-run-spki");
  assert.deepEqual(Object.keys(b.browsers), ["stable", "operator"]);
  assert.equal(b.blockedEgress.length, 1);
  assert.equal(otherRun(b, "operator"), "from a later run: linux 2026-01-03T00:00:00.000Z");
});

test("compare.ts names the run of a column that came from another run", () => {
  const file = folder("compare");
  writeServeColumn(file, "operator", "2026-01-01T00:00:00.000Z", "darwin");
  writeSummary(file, full({ stable: { bin: "/bin/stable", version: "Chrome 1.2.3.4", runs: {} } }, []));
  const out = execFileSync(process.execPath, [join(ROOT, "test/live/parity/compare.ts"), join(tmp, "compare")], { encoding: "utf8" });
  const lines = out.split("\n");
  assert.ok(lines.includes("- **stable**: Chrome 1.2.3.4 (`/bin/stable`)"), out);
  assert.ok(lines.includes("- **operator**: the browser's own (`(operator: a browser that a person opened)`); from an earlier run: darwin 2026-01-01T00:00:00.000Z"), out);
});
