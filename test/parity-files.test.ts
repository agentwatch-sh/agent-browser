// The parity probe's files (test/live/parity/files.ts): developer mode and the probe extension in
// a profile's preference files, on the Linux and the macOS layout, and a run folder's summary.json
// across a --serve run and a full run. The fixtures are made up; none comes from a real profile.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrefs, writeSummary, type Summary } from "./live/parity/files.ts";

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

test("readPrefs: on Linux, developer mode and the extension settings come from Preferences", () => {
  const p = profile("linux", {
    Preferences: { extensions: { ui: { developer_mode: true }, settings: { aaaa: UNPACKED, bbbb: OTHER } } },
    "Secure Preferences": { protection: { macs: {} } },
  });
  const r = readPrefs(p);
  assert.equal(r.developerMode, true);
  assert.deepEqual(Object.keys(r.ours), ["aaaa"]);
  assert.equal(r.ours.aaaa.location, 4);
});

test("readPrefs: on macOS, Chrome keeps developer mode in Secure Preferences", () => {
  const p = profile("mac", {
    Preferences: { extensions: { ui: {} } },
    "Secure Preferences": { extensions: { ui: { developer_mode: true }, settings: { aaaa: UNPACKED } } },
  });
  const r = readPrefs(p);
  assert.equal(r.developerMode, true);
  assert.deepEqual(Object.keys(r.ours), ["aaaa"]);
});

test("readPrefs: Secure Preferences wins when both files hold developer mode, as for the extension settings", () => {
  const p = profile("both", {
    Preferences: { extensions: { ui: { developer_mode: true }, settings: { aaaa: { ...UNPACKED, state: 1 } } } },
    "Secure Preferences": { extensions: { ui: { developer_mode: false }, settings: { aaaa: { ...UNPACKED, state: 0 } } } },
  });
  const r = readPrefs(p);
  assert.equal(r.developerMode, false);
  assert.equal(r.ours.aaaa.state, 0);
});

test("readPrefs: a new or missing profile says nothing, and the packed extension counts by its ID", () => {
  assert.deepEqual(readPrefs(join(tmp, "none")), { developerMode: undefined, ours: {} });
  const p = profile("packed", { Preferences: { extensions: { settings: { cccc: { location: 3, path: "/runs/stable/parity-crx" }, dddd: OTHER } } } });
  assert.deepEqual(Object.keys(readPrefs(p).ours), []);
  assert.deepEqual(Object.keys(readPrefs(p, new Set(["cccc"])).ours), ["cccc"]);
});

// The entry that serve() writes for its label, and what a full run writes for its own labels.
const operator = { bin: "(operator: a browser that a person opened)", version: "the browser's own", runs: {} };
const full = (browsers: Summary["browsers"], blockedEgress: Summary["blockedEgress"]): Summary =>
  ({ started: "2026-01-02T03:04:05.000Z", platform: "darwin", spki: "full-run-spki", browsers, blockedEgress });

test("writeSummary: a full run keeps the --serve column written before it into the same folder", () => {
  const dir = join(tmp, "serve-then-full");
  mkdirSync(dir);
  const file = join(dir, "summary.json");
  writeFileSync(file, JSON.stringify({ started: "2026-01-01T00:00:00.000Z", platform: "darwin", browsers: { operator }, blockedEgress: [] }));
  const stable = { bin: "/bin/stable", version: "Chrome 1.2.3.4", runs: { site: { records: 3 } } };
  writeSummary(file, full({ stable }, [{ run: "stable/site-plain", host: "a.invalid:443" }]));
  const s = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(s.browsers), ["stable", "operator"], "this run's columns first, then the kept one");
  assert.deepEqual(s.browsers.operator, operator);
  assert.deepEqual(s.browsers.stable, stable);
  assert.equal(s.started, "2026-01-02T03:04:05.000Z");
  assert.equal(s.spki, "full-run-spki");
  assert.deepEqual(s.blockedEgress, [{ run: "stable/site-plain", host: "a.invalid:443" }]);
});

test("writeSummary: a run rewrites its own labels and keeps the blocked hosts of the labels it kept", () => {
  const dir = join(tmp, "full-then-full");
  mkdirSync(dir);
  const file = join(dir, "summary.json");
  writeSummary(file, full({ stable: { version: "old stable" }, beta: { version: "old beta" } }, [
    { run: "stable/site-plain", host: "old-stable.invalid:443" }, { run: "beta/site-plain", host: "beta.invalid:443" },
  ]));
  writeSummary(file, full({ stable: { version: "new stable" } }, [{ run: "stable/site-plain", host: "new-stable.invalid:443" }]));
  const s = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(s.browsers, { stable: { version: "new stable" }, beta: { version: "old beta" } });
  assert.deepEqual(s.blockedEgress, [{ run: "stable/site-plain", host: "new-stable.invalid:443" }, { run: "beta/site-plain", host: "beta.invalid:443" }]);
});

test("writeSummary: a summary.json that is not JSON is replaced", () => {
  const dir = join(tmp, "broken");
  mkdirSync(dir);
  const file = join(dir, "summary.json");
  writeFileSync(file, "{ not json");
  writeSummary(file, full({ stable: { version: "v" } }, []));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).browsers), ["stable"]);
});
