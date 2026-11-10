// `agent-browser service stop --all` (the self-contained design, sections 5.1 and 17, open point 3; board ab-v16.94.3):
// with no service running it stops this user's Chrome on the unit's profile and the unit's Xvfb, and nothing else. It
// runs on the fake world of test/fake-unit-world.ts (a fake /proc and fake signals).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeJsonDurable } from "../src/service/unit/record.ts";
import { stopAll } from "../src/service/unit/stop-all.ts";
import { World } from "./fake-unit-world.ts";

const deps = (w: World) => ({ paths: w.paths, procs: w.procs, kill: (p: number, s: NodeJS.Signals) => w.kill(p, s), clock: () => w.now, sleep: (ms: number) => w.sleep(ms) });

test("stop --all: SIGTERM to each Chrome root on the profile, then the record's Xvfb (its display and the X auth file) and any other Xvfb with the X auth file; a child left after the grace gets its own SIGKILL", async () => {
  const w = new World();
  try {
    const profile = `--user-data-dir=${w.paths.profile}`;
    const chrome = w.add({ argv: ["/opt/google/chrome/chrome", profile] });
    const renderer = w.add({ argv: ["/opt/google/chrome/chrome", "--type=renderer", profile], ppid: chrome.pid, pgrp: 1, stubborn: true });
    const x1 = w.add({ argv: ["/usr/bin/Xvfb", ":173", "-auth", w.paths.xauth] });
    const x2 = w.add({ argv: ["/usr/bin/Xvfb", ":174", "-auth", w.paths.xauth] });
    writeJsonDurable(w.paths.unitFile, { wanted: true, display: 173, xvfb_pid: x1.pid, chrome_pid: chrome.pid });
    const stopped = await stopAll(deps(w));
    assert.deepEqual(stopped, [["Chrome", chrome.pid], ["Xvfb", x1.pid], ["Xvfb", x2.pid]]);
    assert.deepEqual(w.signals, [[chrome.pid, "SIGTERM"], [renderer.pid, "SIGKILL"], [x1.pid, "SIGTERM"], [x2.pid, "SIGTERM"]]);
    assert.equal(w.live.size, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(await stopAll(deps(w)))), [], "nothing left: nothing to stop");
  } finally { w.close(); }
});

test("stop --all never signals another user's process, another profile, a similar profile path, an xauth that names the file, or a record pid that runs another program; it writes no file", async () => {
  const w = new World();
  try {
    const profile = `--user-data-dir=${w.paths.profile}`;
    const keep = [
      w.add({ argv: ["/usr/bin/chromium", profile], uid: w.uid + 1 }),
      w.add({ argv: ["/usr/bin/chromium", "--user-data-dir=/home/ann/.config/chromium"] }),
      w.add({ argv: ["/usr/bin/chromium", `${profile}-old`] }),
      w.add({ argv: ["/usr/bin/xauth", "-f", w.paths.xauth, "add", ":173"], exe: "/usr/bin/xauth" }),
      w.add({ argv: ["/usr/bin/vim", ":173", w.paths.xauth], exe: "/usr/bin/vim" }),
    ];
    writeJsonDurable(w.paths.unitFile, { wanted: true, display: 173, xvfb_pid: keep[4].pid });
    const before = JSON.stringify(JSON.parse(readFileSync(w.paths.unitFile, "utf8")));
    assert.deepEqual(await stopAll(deps(w)), []);
    assert.deepEqual(w.signals, []);
    for (const p of keep) assert.ok(w.alive(p.pid));
    assert.equal(JSON.stringify(JSON.parse(readFileSync(w.paths.unitFile, "utf8"))), before, "the record stays: only the owner writes it");
  } finally { w.close(); }
});
