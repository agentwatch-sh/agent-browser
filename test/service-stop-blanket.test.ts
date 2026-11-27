// `agent-browser service stop --blanket --state-folder FOLDER` (board ab-4wh.17; C11, the blanket profile; C12, the
// command): after a crash of the service the blanket Chrome stops at once and its folder goes; the main Chrome, its Xvfb
// and a Chrome on another profile stay; on the Mac the set-up Chrome stops and the template stays; a live service on the
// state folder stops the command (it stops and deletes nothing), and so does a read that cannot tell (fail safe). It runs
// on the fake world of test/fake-unit-world.ts (a fake /proc and fake signals); the CLI's checks and one run on real
// processes are in test/service-cli.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blanketPaths } from "../src/service/blanket/chrome.ts";
import { BLANKET_PACKAGE_FOLDER } from "../src/service/unit/mac-chrome.ts";
import { Procs } from "../src/service/unit/procs.ts";
import { writeJsonDurable } from "../src/service/unit/record.ts";
import { serviceOn, STOP_BLANKET_EXIT, stopBlanket, stopBlanketLine, type StopBlanketDeps } from "../src/service/unit/stop-blanket.ts";
import { World } from "./fake-unit-world.ts";

const CHROME = "/opt/google/chrome/chrome";
const NODE = "/usr/bin/node";
const BIN = "/opt/agent-browser/bin/agent-browser.js";

/** A state folder of the service (it holds the unit's record), with a blanket folder that holds the session's cookies. */
function killed(w: World) {
  writeJsonDurable(w.paths.unitFile, { wanted: true, display: 173 });
  const B = blanketPaths(w.paths.state, join(w.dir, "run", "link.sock"));
  mkdirSync(join(B.profile, "Default"), { recursive: true });
  writeFileSync(join(B.profile, "Default", "Cookies"), "the session's cookies");
  // Another process of the box (pid 1's child, root's): a box always has more processes than this one.
  w.add({ argv: ["/usr/sbin/cron"], uid: w.uid + 1 });
  return B;
}

/** A service's arguments as agentwatch's unit gives them. */
const serviceArgv = (state: string, form: "space" | "equals" = "space") => [NODE, BIN, "service", "--agent-door", "/run/x/cdp.sock", "--lists-folder", "/x/lists",
  ...(form === "space" ? ["--state-folder", state] : [`--state-folder=${state}`]), "--tools-dir", "/x/tools"];

const deps = (w: World, logs: string[], extra: Partial<StopBlanketDeps> = {}): StopBlanketDeps => ({
  paths: { state: w.paths.state }, procs: async () => w.procs, kill: (p, s) => w.kill(p, s), clock: () => w.now, sleep: (ms) => w.sleep(ms),
  log: (l) => logs.push(l), platform: "linux", uid: w.uid, ...extra,
});

test("stop --blanket after a SIGKILL of the service: each Chrome on the blanket profile stops (SIGTERM to the root, SIGKILL to a child left) and <state>/blanket goes; the main Chrome, its Xvfb and a Chrome on another profile stay", async () => {
  const w = new World();
  try {
    const B = killed(w);
    const main = w.add({ argv: [CHROME, `--user-data-dir=${w.paths.profile}`] });
    const xvfb = w.add({ argv: ["/usr/bin/Xvfb", ":173", "-auth", w.paths.xauth] });
    const blanket = w.add({ argv: [CHROME, `--user-data-dir=${B.profile}`, "--proxy-server=socks5://127.0.0.1:40111"] });
    const renderer = w.add({ argv: [CHROME, "--type=renderer", `--user-data-dir=${B.profile}`], ppid: blanket.pid, stubborn: true });
    const other = w.add({ argv: [CHROME, `--user-data-dir=${join(w.dir, "elsewhere")}`] });
    const similar = w.add({ argv: [CHROME, `--user-data-dir=${B.profile}-old`] });
    const theirs = w.add({ argv: [CHROME, `--user-data-dir=${B.profile}`], uid: w.uid + 1 });
    // The operator's Chrome: no profile of the state folder.
    const operator = w.add({ argv: [CHROME] });
    // The service's own shim of the main Chrome (its arguments name no state folder) stays too.
    const shim = w.add({ argv: [NODE, BIN, "host", "chrome-extension://abc/"], ppid: main.pid });
    const logs: string[] = [];
    const r = await stopBlanket(deps(w, logs));
    assert.deepEqual(r, { code: STOP_BLANKET_EXIT.done, stopped: [["Chrome", blanket.pid]], deleted: true });
    assert.deepEqual(w.signals, [[blanket.pid, "SIGTERM"], [renderer.pid, "SIGKILL"]]);
    assert.ok(!w.alive(blanket.pid) && !w.alive(renderer.pid));
    for (const p of [main, xvfb, other, similar, theirs, operator, shim]) assert.ok(w.alive(p.pid), p.argv.join(" "));
    assert.ok(!existsSync(B.root), "the blanket folder goes");
    assert.ok(existsSync(w.paths.unitFile), "the unit's record stays: the command writes and deletes no other file");
    assert.deepEqual(logs, []);
    assert.equal(stopBlanketLine(r), `Stopped the blanket Chrome: Chrome pid ${blanket.pid}; deleted the blanket folder\n`);
    // A second run (the daemon's after the unit's ExecStopPost) finds nothing.
    const again = await stopBlanket(deps(w, logs));
    assert.deepEqual(again, { code: STOP_BLANKET_EXIT.done, stopped: [], deleted: false });
    assert.equal(stopBlanketLine(again), "");
    assert.deepEqual(logs, []);
  } finally { w.close(); }
});

test("stop --blanket after a normal stop finds nothing and exits 0 with no line; a blanket folder with no Chrome (a Chrome that ended by itself) just goes", async () => {
  const w = new World();
  try {
    const B = killed(w);
    const main = w.add({ argv: [CHROME, `--user-data-dir=${w.paths.profile}`] });
    const logs: string[] = [];
    const r = await stopBlanket(deps(w, logs));
    assert.deepEqual([r, stopBlanketLine(r)], [{ code: 0, stopped: [], deleted: true }, "Deleted the blanket folder\n"]);
    assert.ok(!existsSync(B.root) && w.alive(main.pid));
    const none = await stopBlanket(deps(w, logs));
    assert.deepEqual([none, stopBlanketLine(none), w.signals, logs], [{ code: 0, stopped: [], deleted: false }, "", [], []]);
  } finally { w.close(); }
});

test("stop --blanket on the Mac: the blanket Chrome and the set-up Chrome on the template's profile stop, <state>/blanket goes, the template stays; a state folder with agent-package-blanket and no unit record is the service's", async () => {
  const w = new World();
  try {
    const B = blanketPaths(w.paths.state, join(w.dir, "run", "link.sock"));
    mkdirSync(B.profile, { recursive: true });
    const template = join(w.paths.state, "blanket-template", "profile");
    mkdirSync(join(template, "Default"), { recursive: true });
    writeFileSync(join(template, "Default", "Secure Preferences"), "{}");
    mkdirSync(join(w.paths.state, BLANKET_PACKAGE_FOLDER));
    w.add({ argv: ["/usr/libexec/logd"], uid: 0 });
    const agent = w.add({ argv: [CHROME, `--user-data-dir=${w.paths.profile}`], ppid: 1 });
    const blanket = w.add({ argv: [CHROME, `--user-data-dir=${B.profile}`], ppid: 1 });
    const setup = w.add({ argv: [CHROME, `--user-data-dir=${template}`], ppid: 1 });
    const operator = w.add({ argv: [CHROME], ppid: 1 });
    const logs: string[] = [];
    const r = await stopBlanket(deps(w, logs, { platform: "darwin" }));
    assert.deepEqual(r, { code: 0, stopped: [["Chrome", blanket.pid], ["set-up Chrome", setup.pid]], deleted: true });
    assert.ok(!w.alive(blanket.pid) && !w.alive(setup.pid));
    assert.ok(w.alive(agent.pid) && w.alive(operator.pid), "the agent Chrome and the operator's Chrome stay");
    assert.ok(!existsSync(B.root), "the blanket folder goes");
    assert.ok(existsSync(join(template, "Default", "Secure Preferences")), "the template stays");
    assert.equal(stopBlanketLine(r), `Stopped the blanket Chrome: Chrome pid ${blanket.pid}, set-up Chrome pid ${setup.pid}; deleted the blanket folder\n`);
    assert.deepEqual(logs, []);
  } finally { w.close(); }
});

test("stop --blanket while a service runs on the state folder (a broken connection, a daemon restart): nothing stops, nothing is deleted, exit 4 with one line; in each form of the argument, through a link, and on the Mac in another case", async () => {
  const cases: [string, (w: World, link: string) => string[], NodeJS.Platform][] = [
    ["--state-folder <folder>", (w) => serviceArgv(w.paths.state), "linux"],
    ["--state-folder=<folder>", (w) => serviceArgv(w.paths.state, "equals"), "linux"],
    ["a --test run of the live harness", (w) => [NODE, BIN, "service", "--test", "--test-display", "173", "--state-folder", w.paths.state], "linux"],
    ["the service runs on a link to the folder", (w, link) => serviceArgv(link), "linux"],
    ["--state-folder=<a link to the folder>", (w, link) => serviceArgv(link, "equals"), "linux"],
    ["the Mac: another case", (w) => serviceArgv(w.paths.state.toUpperCase()), "darwin"],
    ["the Mac: --state-folder=<folder> in another case", (w) => serviceArgv(w.paths.state.toUpperCase(), "equals"), "darwin"],
  ];
  for (const [what, argv, platform] of cases) {
    const w = new World();
    try {
      const B = killed(w);
      if (platform === "darwin") mkdirSync(join(w.paths.state, BLANKET_PACKAGE_FOLDER));
      const link = join(w.dir, "state-link");
      symlinkSync(w.paths.state, link);
      const service = w.add({ argv: argv(w, link) });
      const blanket = w.add({ argv: [CHROME, `--user-data-dir=${B.profile}`] });
      const logs: string[] = [];
      const r = await stopBlanket(deps(w, logs, { platform }));
      assert.deepEqual(r, { code: STOP_BLANKET_EXIT.live, stopped: [], deleted: false }, what);
      assert.deepEqual(logs, [`service stop --blanket: a service runs on the state folder (pid ${service.pid}): nothing is stopped or deleted`], what);
      assert.deepEqual(w.signals, [], what);
      assert.ok(w.alive(blanket.pid) && existsSync(join(B.profile, "Default", "Cookies")), what);
      // The same folder given through the link finds the service too.
      if (platform === "linux") assert.equal((await stopBlanket(deps(w, [], { platform, paths: { state: link } }))).code, STOP_BLANKET_EXIT.live, `${what}, through the link`);
    } finally { w.close(); }
  }
});

test("stop --blanket: the service's parser takes --state-folder <folder> and --state-folder=<folder>, so the check reads both forms", async () => {
  const { parseArgs } = await import("node:util");
  for (const args of [["service", "--state-folder", "/x/state"], ["service", "--state-folder=/x/state"]]) {
    const { values } = parseArgs({ args, options: { "state-folder": { type: "string" } }, allowPositionals: true, strict: true });
    assert.equal(values["state-folder"], "/x/state", args.join(" "));
  }
  const cli = (await import("node:fs")).readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.ok(cli.includes("parseArgs({ args: argv, options: ALL_FLAGS, allowPositionals: true, strict: true })") && cli.includes('"state-folder": { type: "string" }'), "the CLI parses with node's parseArgs, --state-folder a string");
});

test("stop --blanket: no service of the state folder is a service on it: a service on another folder, a similar folder, a service of another user, a zombie, and the runs of service stop --blanket and stop --all; with them the command acts", async () => {
  const w = new World();
  try {
    const B = killed(w);
    w.add({ argv: serviceArgv(join(w.dir, "another-state")) });
    w.add({ argv: serviceArgv(`${w.paths.state}-old`) });
    w.add({ argv: serviceArgv(w.paths.state), uid: w.uid + 1 });
    w.add({ argv: [NODE, BIN, "service", "stop", "--blanket", "--state-folder", w.paths.state] });
    w.add({ argv: [NODE, BIN, "service", "stop", "--all", "--state-folder", w.paths.state] });
    w.add({ argv: [NODE, BIN, "service", "--hello"] });
    w.add({ argv: [NODE, "/x/other-tool.js", "--state-folder", w.paths.state], exe: NODE });
    // The killed service, not yet reaped: a zombie holds no door and runs no code.
    const zombie = w.add({ argv: serviceArgv(w.paths.state) });
    writeFileSync(join(w.proc, String(zombie.pid), "stat"), `${zombie.pid} (node) Z 1 ${zombie.pid} ${zombie.pid} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${zombie.start} 0 0\n`);
    assert.deepEqual(serviceOn(w.paths.state, w.procs, "linux"), { kind: "none" });
    const blanket = w.add({ argv: [CHROME, `--user-data-dir=${B.profile}`] });
    const r = await stopBlanket(deps(w, []));
    assert.deepEqual(r, { code: 0, stopped: [["Chrome", blanket.pid]], deleted: true });
  } finally { w.close(); }
});

test("stop --blanket: a service that starts during the stop (agentwatch's restart) stops the act before the next round of signals and before the delete: exit 4; the stdout line names only a root that got a signal and ended (I2)", async () => {
  // The review's case: the service starts in the TERM wait of the blanket Chrome; the set-up Chrome gets no signal.
  for (const ends of [false, true]) {
    const w = new World();
    try {
      const B = killed(w);
      const template = join(w.paths.state, "blanket-template", "profile");
      mkdirSync(template, { recursive: true });
      // A blanket Chrome that ignores SIGTERM, or one that ends at once while its renderer ignores it (the wait goes on).
      const blanket = w.add({ argv: [CHROME, `--user-data-dir=${B.profile}`], stubborn: !ends });
      const renderer = ends ? w.add({ argv: [CHROME, "--type=renderer", `--user-data-dir=${B.profile}`], ppid: blanket.pid, stubborn: true }) : null;
      const setup = w.add({ argv: [CHROME, `--user-data-dir=${template}`] });
      let started: number | null = null;
      const logs: string[] = [];
      const r = await stopBlanket(deps(w, logs, { sleep: async (ms) => { if (started === null) started = w.add({ argv: serviceArgv(w.paths.state) }).pid; await w.sleep(ms); } }));
      const what = ends ? "the root ends at SIGTERM" : "the root ignores SIGTERM";
      assert.deepEqual(r, { code: STOP_BLANKET_EXIT.live, stopped: ends ? [["Chrome", blanket.pid]] : [], deleted: false }, what);
      assert.deepEqual(w.signals, [[blanket.pid, "SIGTERM"]], `${what}: one SIGTERM, no SIGKILL after the service's start`);
      assert.ok(w.alive(setup.pid) && (renderer === null || w.alive(renderer.pid)), `${what}: the set-up Chrome (and the renderer) got no signal`);
      assert.equal(stopBlanketLine(r), ends ? `Stopped the blanket Chrome: Chrome pid ${blanket.pid}\n` : "", what);
      assert.ok(existsSync(B.root), `${what}: no delete after the service's start`);
      assert.deepEqual(logs, [`service stop --blanket: a service runs on the state folder (pid ${started}): nothing more is stopped or deleted`], what);
    } finally { w.close(); }
  }
});

test("stop --blanket reads the processes again right before the SIGTERM round (I3): a service that starts between the first check and that round gets no Chrome signalled: exit 4", async () => {
  const w = new World();
  try {
    const B = killed(w);
    const blanket = w.add({ argv: [CHROME, `--user-data-dir=${B.profile}`] });
    // The first check lists the processes once; the blanket profile's scan is the next list, right before the SIGTERM round.
    let lists = 0, started: number | null = null;
    const procs = Object.assign(Object.create(w.procs), {
      pids(this: Procs) { if (++lists === 2) started = w.add({ argv: serviceArgv(w.paths.state) }).pid; return Procs.prototype.pids.call(this); },
    }) as Procs;
    const logs: string[] = [];
    const r = await stopBlanket(deps(w, logs, { procs: async () => procs }));
    assert.deepEqual(r, { code: STOP_BLANKET_EXIT.live, stopped: [], deleted: false });
    assert.deepEqual(w.signals, [], "no SIGTERM");
    assert.ok(w.alive(blanket.pid) && existsSync(B.root));
    assert.deepEqual(logs, [`service stop --blanket: a service runs on the state folder (pid ${started}): nothing more is stopped or deleted`]);
  } finally { w.close(); }
});

test("stop --blanket: a halt drops the lines of its acts, so exit 4 has its one line (m3); with no halt they come", async () => {
  for (const halt of [true, false]) {
    const w = new World();
    try {
      writeJsonDurable(w.paths.unitFile, { wanted: false });
      w.add({ argv: ["/usr/sbin/cron"], uid: 0 });
      // A link at the blanket folder: a line of the acts (no Chrome on it is signalled).
      const target = join(w.dir, "elsewhere");
      mkdirSync(join(target, "profile"), { recursive: true });
      symlinkSync(target, join(w.paths.state, "blanket"));
      // The template's profile has a Chrome, so the acts read the processes again before its SIGTERM round.
      const template = join(w.paths.state, "blanket-template", "profile");
      mkdirSync(template, { recursive: true });
      const setup = w.add({ argv: [CHROME, `--user-data-dir=${template}`] });
      let lists = 0, started: number | null = null;
      const procs = Object.assign(Object.create(w.procs), {
        pids(this: Procs) { if (halt && ++lists === 2) started = w.add({ argv: serviceArgv(w.paths.state) }).pid; return Procs.prototype.pids.call(this); },
      }) as Procs;
      const logs: string[] = [];
      const r = await stopBlanket(deps(w, logs, { procs: async () => procs }));
      const link = "service stop --blanket: the blanket folder or its profile is a link or a file, not a folder: no Chrome on it is signalled";
      if (halt) {
        assert.deepEqual([r.code, logs], [STOP_BLANKET_EXIT.live, [`service stop --blanket: a service runs on the state folder (pid ${started}): nothing more is stopped or deleted`]]);
        assert.ok(w.alive(setup.pid));
      } else {
        assert.deepEqual([r, logs], [{ code: 0, stopped: [["set-up Chrome", setup.pid]], deleted: true }, [link]]);
      }
    } finally { w.close(); }
  }
});

test("stop --blanket fails safe: when it cannot tell whether a service runs (no process list, the Mac's reads do not load, a node process whose arguments cannot be read, a relative --state-folder, a user that cannot be read, /proc with hidepid or subset=pid) it stops nothing: exit 5 with one line", async () => {
  const cases: [string, (w: World) => Partial<StopBlanketDeps>, RegExp][] = [
    ["an empty process list", (w) => ({ procs: async () => new Procs({ root: join(w.dir, "no-proc"), uid: w.uid }) }), /\(the processes cannot be listed\)/],
    ["proc_listallpids fails", (w) => ({ procs: async () => Object.assign(Object.create(w.procs), { pids: () => { throw new Error("proc_listallpids failed: the processes cannot be listed"); } }) }), /\(the processes cannot be listed: proc_listallpids failed: the processes cannot be listed\)/],
    ["libSystem does not load", () => ({ procs: async () => ({ failed: "node:ffi does not load (ERR_UNKNOWN_BUILTIN_MODULE)" }) }), /\(the processes cannot be read: node:ffi does not load \(ERR_UNKNOWN_BUILTIN_MODULE\)\)/],
    ["the reads throw", () => ({ procs: async () => { throw new Error("x"); } }), /\(the processes cannot be read: x\)/],
    ["a node process with no arguments to read", (w) => { const p = w.add({ argv: [NODE], exe: NODE }); writeFileSync(join(w.proc, String(p.pid), "cmdline"), ""); return {}; }, /\(the arguments of pid \d+ cannot be read\)/],
    ["a process whose program and arguments cannot be read", (w) => { const p = w.add({ argv: ["x"] }); writeFileSync(join(w.proc, String(p.pid), "cmdline"), ""); rmSync(join(w.proc, String(p.pid), "exe")); return {}; }, /\(the arguments of pid \d+ cannot be read\)/],
    ["a service with a relative --state-folder", (w) => { w.add({ argv: [NODE, BIN, "service", "--state-folder", "state"] }); return {}; }, /\(the service of pid \d+ names its state folder by a relative path\)/],
    // m1: a process whose user cannot be read (its status is gone while its stat is there).
    ["a process whose user cannot be read", (w) => { const p = w.add({ argv: serviceArgv(w.paths.state) }); rmSync(join(w.proc, String(p.pid), "status")); return {}; }, /\(the user of pid \d+ cannot be read\)/],
    // I1: /proc with hidepid (hidepid=2 or 4 lists no non-dumpable service; hidepid=1 refuses its reads) or subset=pid.
    ["/proc with hidepid=2", (w) => { writeFileSync(join(w.proc, "self", "mountinfo"), "25 29 0:23 / /proc rw,nosuid,nodev,noexec,relatime shared:11 - proc proc rw,hidepid=2\n"); return {}; }, /\(\/proc is mounted with hidepid=2\)/],
    ["/proc with hidepid=invisible", (w) => { writeFileSync(join(w.proc, "self", "mountinfo"), "25 29 0:23 / /proc rw,relatime - proc proc rw,hidepid=invisible,subset=pid\n"); return {}; }, /\(\/proc is mounted with hidepid=invisible\)/],
    ["/proc with subset=pid", (w) => { writeFileSync(join(w.proc, "self", "mountinfo"), "25 29 0:23 / /proc rw,relatime - proc proc rw,subset=pid\n"); return {}; }, /\(\/proc is mounted with subset=pid\)/],
    ["a mountinfo that cannot be read", (w) => { rmSync(join(w.proc, "self", "mountinfo")); return {}; }, /\(\/proc\/self\/mountinfo cannot be read \(ENOENT\)\)/],
  ];
  for (const [what, setup, why] of cases) {
    const w = new World();
    try {
      const B = killed(w);
      const blanket = w.add({ argv: [CHROME, `--user-data-dir=${B.profile}`] });
      const logs: string[] = [];
      const r = await stopBlanket(deps(w, logs, setup(w)));
      assert.deepEqual(r, { code: STOP_BLANKET_EXIT.unknown, stopped: [], deleted: false }, what);
      assert.equal(logs.length, 1, what);
      assert.match(logs[0], /^service stop --blanket: it cannot tell whether a service runs on the state folder \(.*\): nothing is stopped or deleted$/, what);
      assert.match(logs[0], why, what);
      assert.deepEqual(w.signals, [], what);
      assert.ok(w.alive(blanket.pid) && existsSync(B.root), what);
    } finally { w.close(); }
  }
  // A process of another program (its exe link reads) whose arguments cannot be read is no service. (A process in its
  // exit has no exe link: board ab-4wh.26, below.)
  const w = new World();
  try {
    killed(w);
    const p = w.add({ argv: ["/usr/bin/bash"], exe: "/usr/bin/bash" });
    writeFileSync(join(w.proc, String(p.pid), "cmdline"), "");
    assert.deepEqual(serviceOn(w.paths.state, w.procs, "linux"), { kind: "none" });
  } finally { w.close(); }
});

test("stop --blanket fails safe when /proc refuses a read of a process (I1: hidepid=1 and ProtectProc=noaccess give EPERM for the non-dumpable service, a security module EACCES; the fake gives EACCES): its stat, its user or its arguments; hidepid=0, another mount's option and a proc mount at another path change nothing, a second proc mount at /proc counts", { skip: process.getuid?.() === 0 }, async () => {
  for (const file of ["stat", "status", "cmdline"]) {
    const w = new World();
    try {
      const B = killed(w);
      const blanket = w.add({ argv: [CHROME, `--user-data-dir=${B.profile}`] });
      const service = w.add({ argv: serviceArgv(w.paths.state) });
      chmodSync(join(w.proc, String(service.pid), file), 0o000);
      const logs: string[] = [];
      const r = await stopBlanket(deps(w, logs));
      assert.deepEqual(r, { code: STOP_BLANKET_EXIT.unknown, stopped: [], deleted: false }, file);
      assert.deepEqual(logs, [`service stop --blanket: it cannot tell whether a service runs on the state folder (a read of pid ${service.pid} fails (${file}: EACCES)): nothing is stopped or deleted`], file);
      assert.ok(w.alive(blanket.pid) && existsSync(B.root) && !w.signals.length, file);
    } finally { w.close(); }
  }
  const w = new World();
  try {
    const B = killed(w);
    // Board ab-4wh.21 (point 1): a proc mount at another path (a chroot's) plays no part; the reads go to /proc.
    writeFileSync(join(w.proc, "self", "mountinfo"), "25 29 0:23 / /proc rw - proc proc rw,hidepid=0\n31 25 0:40 / /tmp rw - tmpfs tmpfs rw,hidepid=2\n40 31 0:51 / /srv/chroot/proc rw,relatime - proc proc rw,hidepid=2,subset=pid\n");
    assert.deepEqual(serviceOn(w.paths.state, w.procs, "linux"), { kind: "none" });
    // A second proc mount at /proc (on top of the first) counts.
    writeFileSync(join(w.proc, "self", "mountinfo"), "25 29 0:23 / /proc rw - proc proc rw\n41 25 0:52 / /proc rw - proc proc rw,hidepid=invisible\n");
    assert.deepEqual(serviceOn(w.paths.state, w.procs, "linux"), { kind: "unknown", why: "/proc is mounted with hidepid=invisible" });
    writeFileSync(join(w.proc, "self", "mountinfo"), "25 29 0:23 / /proc rw - proc proc rw\n");
    const blanket = w.add({ argv: [CHROME, `--user-data-dir=${B.profile}`] });
    assert.deepEqual(await stopBlanket(deps(w, [])), { code: 0, stopped: [["Chrome", blanket.pid]], deleted: true });
  } finally { w.close(); }
});

/**
 * Board ab-4wh.26: a reader of the fake /proc in which one process of this user, which the command did not start, ends
 * during the command's reads. Right before its `at`-th read of that process (stat, status, cmdline, exe, the fault read,
 * the exit flag), the process goes one step on in its end: `gone` (its /proc entry goes), `zombie`, or `exit` (in its exit,
 * its memory gone, and so it stays: a slow exit over several scans).
 */
class Ending extends Procs {
  reads = 0;
  readonly w: World;
  readonly target: number;
  readonly at: number;
  readonly how: "gone" | "zombie" | "exit";
  constructor(w: World, target: number, at: number, how: "gone" | "zombie" | "exit") {
    super({ root: w.proc, uid: w.uid, self: w.self });
    this.w = w; this.target = target; this.at = at; this.how = how;
  }
  private step(pid: number) {
    if (pid !== this.target || ++this.reads !== this.at) return;
    if (this.how === "gone") this.w.end(pid);
    else { this.w.exiting(pid, "exit"); if (this.how === "zombie") this.w.exiting(pid, "zombie"); }
  }
  override stat(pid: number) { this.step(pid); return super.stat(pid); }
  override realUid(pid: number) { this.step(pid); return super.realUid(pid); }
  override cmdline(pid: number) { this.step(pid); return super.cmdline(pid); }
  override exe(pid: number) { this.step(pid); return super.exe(pid); }
  override readFault(pid: number) { this.step(pid); return super.readFault(pid); }
  override exiting(pid: number) { this.step(pid); return super.exiting(pid); }
}

test("stop --blanket and a process of this user that ends during its scans (board ab-4wh.26): gone, a zombie or in its exit (PF_EXITING, its arguments and its exe link gone, its stat still R) at each of its reads, a short-lived shell or node, it is no service: the blanket Chrome stops and the folder goes (exit 0), and it gets no signal", async () => {
  for (const argv of [["/usr/bin/sh", "-c", "true"], [NODE, "/x/tool.js"]]) {
    const run = async (at: number, how: "gone" | "zombie" | "exit") => {
      const w = new World();
      try {
        const B = killed(w);
        const blanket = w.add({ argv: [CHROME, `--user-data-dir=${B.profile}`] });
        const short = w.add({ argv, exe: argv[0] });
        const procs = new Ending(w, short.pid, at, how);
        const logs: string[] = [];
        const r = await stopBlanket(deps(w, logs, { procs: async () => procs }));
        const what = `${argv[0]} ${how} at its read ${at}`;
        assert.deepEqual([r, logs], [{ code: STOP_BLANKET_EXIT.done, stopped: [["Chrome", blanket.pid]], deleted: true }, []], what);
        assert.deepEqual(w.signals, [[blanket.pid, "SIGTERM"]], `${what}: only the blanket Chrome gets a signal`);
        assert.ok(!existsSync(B.root), what);
        return procs.reads;
      } finally { w.close(); }
    };
    // The reads of that process in a whole run (its four scans of the processes and the scans of the profiles).
    const total = await run(Infinity, "gone");
    assert.ok(total >= 12, `${total} reads`);
    for (let at = 1; at <= total; at++) for (const how of ["gone", "zombie", "exit"] as const) await run(at, how);
  }
});

test("stop --blanket and the exit flag (board ab-4wh.26): only a process whose arguments read empty AND whose stat holds PF_EXITING is skipped; a live process whose arguments cannot be read still stops the command (exit 5); a service in its exit whose arguments still read is a service (exit 4)", async () => {
  // A live node process (no PF_EXITING) whose arguments and exe link cannot be read: it cannot tell.
  const w = new World();
  try {
    killed(w);
    const p = w.add({ argv: [NODE, BIN, "service", "--state-folder", w.paths.state] });
    writeFileSync(join(w.proc, String(p.pid), "cmdline"), "");
    rmSync(join(w.proc, String(p.pid), "exe"));
    assert.equal(w.procs.exiting(p.pid), false);
    assert.deepEqual(serviceOn(w.paths.state, w.procs, "linux"), { kind: "unknown", why: `the arguments of pid ${p.pid} cannot be read` });
    // The same process in its exit (PF_EXITING; its memory, its arguments and its exe link gone): it is none.
    w.exiting(p.pid, "exit");
    assert.equal(w.procs.exiting(p.pid), true);
    assert.deepEqual(serviceOn(w.paths.state, w.procs, "linux"), { kind: "none" });
  } finally { w.close(); }
  // The service at the start of its exit (PF_EXITING, its arguments still there) is still a service: it stops nothing.
  const v = new World();
  try {
    const B = killed(v);
    const blanket = v.add({ argv: [CHROME, `--user-data-dir=${B.profile}`] });
    const service = v.add({ argv: serviceArgv(v.paths.state) });
    v.exiting(service.pid, "flag");
    assert.equal(v.procs.exiting(service.pid), true);
    const logs: string[] = [];
    assert.deepEqual(await stopBlanket(deps(v, logs)), { code: STOP_BLANKET_EXIT.live, stopped: [], deleted: false });
    assert.deepEqual(logs, [`service stop --blanket: a service runs on the state folder (pid ${service.pid}): nothing is stopped or deleted`]);
    // Then its memory goes (it runs no more code): it is none, and the blanket Chrome stops.
    v.exiting(service.pid, "exit");
    assert.deepEqual(await stopBlanket(deps(v, [])), { code: STOP_BLANKET_EXIT.done, stopped: [["Chrome", blanket.pid]], deleted: true });
    assert.ok(v.alive(service.pid) && !v.signals.some(([pid]) => pid === service.pid), "the service in its exit gets no signal");
  } finally { v.close(); }
});

test("stop --blanket refuses a state folder that is no state folder of the service (stop --all's rule): it signals no Chrome and deletes nothing, exit 3 with one line that names no path", async () => {
  const w = new World();
  try {
    const B = blanketPaths(w.paths.state, join(w.dir, "run", "link.sock"));
    mkdirSync(B.profile, { recursive: true });
    writeFileSync(join(B.root, "notes.txt"), "the operator's own file");
    w.add({ argv: ["/usr/sbin/cron"], uid: 0 });
    const blanket = w.add({ argv: [CHROME, `--user-data-dir=${B.profile}`] });
    const run = async (extra: Partial<StopBlanketDeps>) => { const logs: string[] = []; const r = await stopBlanket(deps(w, logs, extra)); return { r, logs }; };
    const cases: [string, Partial<StopBlanketDeps>, string][] = [
      ["no unit record (Linux)", {}, "it holds no record of the Chrome unit, unit.json (ENOENT)"],
      ["no unit record and no agent-package-blanket (the Mac)", { platform: "darwin" }, "it holds no record of the Chrome unit, unit.json (ENOENT)"],
      ["a folder of another user", { uid: w.uid + 1 }, "it is not a folder of this user"],
      ["a file", { paths: { state: join(B.root, "notes.txt") } }, "it is not a folder"],
      ["no folder", { paths: { state: join(w.dir, "nothing") } }, "it cannot be read (ENOENT)"],
    ];
    for (const [what, extra, why] of cases) {
      const { r, logs } = await run(extra);
      assert.deepEqual(r, { code: STOP_BLANKET_EXIT.folder, stopped: [], deleted: false }, what);
      assert.deepEqual(logs, [`service stop --blanket: the state folder is no state folder of the agent browser (${why}): nothing is stopped or deleted`], what);
      assert.ok(!logs[0].includes(w.dir), `${what}: no path`);
    }
    assert.deepEqual(w.signals, []);
    assert.ok(w.alive(blanket.pid) && existsSync(join(B.root, "notes.txt")), "nothing is signalled or deleted");
    // A link at <state>/blanket in a state folder of the service: no Chrome is signalled for it, only the link goes (N2).
    const target = join(w.dir, "elsewhere");
    mkdirSync(join(target, "profile"), { recursive: true });
    const linked = new World();
    try {
      writeJsonDurable(linked.paths.unitFile, { wanted: false });
      linked.add({ argv: ["/usr/sbin/cron"], uid: 0 });
      symlinkSync(target, join(linked.paths.state, "blanket"));
      const onTarget = linked.add({ argv: [CHROME, `--user-data-dir=${join(target, "profile")}`] });
      const onLink = linked.add({ argv: [CHROME, `--user-data-dir=${join(linked.paths.state, "blanket", "profile")}`] });
      const logs: string[] = [];
      const r = await stopBlanket(deps(linked, logs));
      assert.deepEqual(r, { code: 0, stopped: [], deleted: true });
      assert.ok(linked.alive(onTarget.pid) && linked.alive(onLink.pid) && existsSync(join(target, "profile")));
      assert.deepEqual(logs, ["service stop --blanket: the blanket folder or its profile is a link or a file, not a folder: no Chrome on it is signalled"]);
    } finally { linked.close(); }
  } finally { w.close(); }
});

test("stop --blanket exits 1 when something is left after its acts: a Chrome that outlives its SIGKILL, a blanket folder that cannot be deleted", { skip: process.getuid?.() === 0 }, async () => {
  const w = new World();
  try {
    const B = killed(w);
    const blanket = w.add({ argv: [CHROME, `--user-data-dir=${B.profile}`] });
    const logs: string[] = [];
    // A kill that ends nothing (a process stuck in the kernel).
    const r = await stopBlanket(deps(w, logs, { kill: (p, s) => { w.signals.push([p, s]); } }));
    assert.deepEqual(r, { code: STOP_BLANKET_EXIT.left, stopped: [], deleted: true }, "a Chrome that still runs is not named as stopped (I2)");
    assert.deepEqual(w.signals, [[blanket.pid, "SIGTERM"], [blanket.pid, "SIGKILL"]]);
    assert.equal(stopBlanketLine(r), "Deleted the blanket folder\n");
    assert.deepEqual(logs, [`service stop --blanket: a Chrome on the blanket profile still runs (pid ${blanket.pid})`]);
  } finally { w.close(); }
  const v = new World();
  const locked = join(v.paths.state, "blanket", "profile", "Default");
  try {
    killed(v);
    chmodSync(locked, 0o500);
    const logs: string[] = [];
    const r = await stopBlanket(deps(v, logs));
    assert.deepEqual(r, { code: STOP_BLANKET_EXIT.left, stopped: [], deleted: false });
    assert.deepEqual(logs, ["blanket: the blanket folder is not deleted (EACCES)"]);
    chmodSync(locked, 0o700);
    assert.deepEqual(await stopBlanket(deps(v, [])), { code: 0, stopped: [], deleted: true });
  } finally { try { chmodSync(locked, 0o700); } catch {} v.close(); }
});
