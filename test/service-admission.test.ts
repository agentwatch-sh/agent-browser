// The control door's admission (contract C12, "Who connects" and "The daemon's expected command"; board ab-v16.94.2,
// stage 1a): only the agentwatch daemon process connects. The service runs in this process with the real peer reader
// (the relay's self-test), the real pidfd of the MainPID and the real /proc reads; only the MainPID comes from the test
// in place of the user's systemd (and the systemd query runs against a fake systemctl). The daemon is a real process:
// a fake "uv" (the MainPID) that starts a fake daemon as its child, with known command lines, in temp folders. No test
// connects to agentwatch's own service or its daemon.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseExpectedCommand, readExpectedCommand, REFUSED_NO_MAINPID, refusedRule, systemdMainPid, defaultDaemonCommandFile } from "../src/service/admission.ts";
import { startService, type Service } from "../src/service/service.ts";
import { raw } from "./fake-bridge.ts";
import { NOT_READY } from "../src/relay/model.ts";
import { closesWithin, DAEMON_HELLO, daemonClient } from "./fake-daemon.ts";

const linux = process.platform === "linux";
const control = JSON.parse(readFileSync(new URL("./vectors/control.json", import.meta.url), "utf8"));
const NODE = realpathSync(process.execPath);

/** The fake daemon: it connects to control.sock (or, with `fork:<marker>`, starts a child of its own that connects), and prints each line. */
const DAEMON = `const net = require("node:net"); const { spawn } = require("node:child_process");
const [sock, flag, marker] = process.argv.slice(1);
const out = (o) => process.stdout.write(JSON.stringify({ pid: process.pid, ...o }) + "\\n");
if (marker.startsWith("fork:")) { spawn(process.execPath, [...process.execArgv, sock, flag, marker.slice(5)], { stdio: ["ignore", "inherit", "inherit"] }).on("exit", () => process.exit(0)); setInterval(() => {}, 1000); }
else {
  const s = net.connect(sock); let buf = "";
  s.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const l = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); out({ line: l });
    if (l.t === "hello") s.write(JSON.stringify(${JSON.stringify(DAEMON_HELLO)}) + "\\n" + JSON.stringify({ t: "req", id: "s1", op: "status", by: { kind: "daemon", user: "ann", via: "daemon" } }) + "\\n"); } });
  s.on("close", () => { out({ closed: true }); process.exit(0); }); s.on("error", () => {}); setInterval(() => {}, 1000);
}`;
/** The fake uv (the MainPID): for each line of its standard input, `daemon <marker>` starts a fake daemon as its child; `self` connects itself. */
const UV = `const { spawn } = require("node:child_process"); const net = require("node:net");
const [sock, daemon] = process.argv.slice(1);
const out = (o) => process.stdout.write(JSON.stringify({ pid: process.pid, ...o }) + "\\n");
out({ uv: process.pid });
require("node:readline").createInterface({ input: process.stdin }).on("line", (l) => {
  const [what, marker] = l.split(" ");
  if (what === "daemon") spawn(process.execPath, ["-e", daemon, sock, "--daemon", marker], { stdio: ["ignore", "inherit", "inherit"] });
  if (what === "self") { const s = net.connect(sock); let buf = ""; s.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { out({ line: JSON.parse(buf.slice(0, i)) }); buf = buf.slice(i + 1); } }); s.on("close", () => out({ closed: true })); s.on("error", () => {}); }
});`;

type Proc = { child: ChildProcess; lines: any[]; next: (want: (l: any) => boolean, ms?: number) => Promise<any> };
function run(args: string[]): Proc {
  const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "inherit"] });
  const lines: any[] = [], waiters: { want: (l: any) => boolean; done: (l: any) => void }[] = [];
  createInterface({ input: child.stdout! }).on("line", (s) => {
    const l = JSON.parse(s);
    lines.push(l);
    for (const w of [...waiters]) if (w.want(l)) { waiters.splice(waiters.indexOf(w), 1); w.done(l); }
  });
  const next = (want: (l: any) => boolean, ms = 10_000) => {
    const hit = lines.find(want);
    if (hit) return Promise.resolve(hit);
    return new Promise((done, fail) => { waiters.push({ want, done }); setTimeout(() => fail(new Error(`no such line in ${ms} ms: ${JSON.stringify(lines)}`)), ms); });
  };
  return { child, lines, next };
}

/** The pids under `pid` (its children, theirs, ...), from /proc, the deepest first. */
function descendants(pid: number): number[] {
  let kids: number[] = [];
  try { kids = readFileSync(`/proc/${pid}/task/${pid}/children`, "latin1").trim().split(/\s+/).filter(Boolean).map(Number); } catch {}
  return kids.flatMap((k) => [...descendants(k), k]);
}

/** A world: a temp folder with the two doors' paths and the expected command's file, the service, and the processes that it started. */
type World = { dir: string; sock: string; file: string; logs: string[]; service: Service; procs: Proc[]; pids: number[]; main: { pid: number | null; queue: (number | null)[]; hold?: Promise<void> }; uv: () => Promise<{ p: Proc; pid: number }>; daemon: (uv: Proc, marker: string) => Promise<any[]>; close: () => Promise<void> };
async function world(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "ab-adm-"));
  const sock = join(dir, "control.sock"), file = join(dir, "daemon-command.json");
  const logs: string[] = [];
  // The MainPID of the test's systemd: the queue's next value, else `pid`; `hold` holds the next read once.
  const main: World["main"] = { pid: null, queue: [] };
  const service = await startService({
    agentDoor: join(dir, "cdp.sock"), controlDoor: sock, daemonCommand: file, log: (l) => logs.push(l),
    mainPid: async () => { if (main.hold) { const h = main.hold; main.hold = undefined; await h; } return main.queue.length ? main.queue.shift()! : main.pid; },
  });
  const procs: Proc[] = [], pids: number[] = [];
  const uv = async () => { const p = run(["-e", UV, sock, DAEMON]); procs.push(p); const pid = (await p.next((l) => l.uv)).uv; return { p, pid }; };
  /** Start a fake daemon under `uv`: the lines that it got, up to its close or the answer of its status. */
  const daemon = async (u: Proc, marker: string) => {
    const known = new Set(u.lines.map((l) => l.pid));
    u.child.stdin!.write(`daemon ${marker}\n`);
    const first = await u.next((l) => l.pid !== undefined && !known.has(l.pid) && l.line !== undefined);
    pids.push(first.pid);
    await u.next((l) => l.pid === first.pid && (l.closed || l.line?.t === "res"));
    return u.lines.filter((l) => l.pid === first.pid && l.line).map((l) => l.line);
  };
  return {
    dir, sock, file, logs, service, procs, pids, main, uv, daemon,
    close: async () => {
      // Each process that this test started, and each process under it.
      for (const pid of [...procs.flatMap((p) => descendants(p.child.pid!)), ...pids]) try { process.kill(pid, "SIGKILL"); } catch {}
      for (const p of procs) p.child.kill("SIGKILL");
      await service.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const expect = (w: World, o: { interpreter?: string; args: string[] }, mode = 0o600) => {
  writeFileSync(w.file, JSON.stringify({ v: 1, interpreter: o.interpreter ?? NODE, args: o.args }));
  chmodSync(w.file, mode);
};
const daemonArgs = (w: World, marker: string) => ["-e", DAEMON, w.sock, "--daemon", marker];
const admitted = (lines: any[]) => lines[0]?.t === "hello" && lines[0].side === "service" && lines.some((l) => l.t === "res" && l.id === "s1" && l.ok);
const refusedWith = (lines: any[]) => (lines.length === 1 && lines[0].t === "refused" ? lines[0].reason : null);

test("the expected command's file: its format (v 1, an absolute interpreter, args), its default path, and a regular file of the user that its group and others cannot write", () => {
  assert.deepEqual(parseExpectedCommand('{"v":1,"interpreter":"/usr/bin/python3","args":["/a/agentwatch","--daemon"],"later":true}'), { interpreter: "/usr/bin/python3", args: ["/a/agentwatch", "--daemon"] });
  for (const [bad, why] of [["not json", /not JSON/], ["[]", /not a JSON object/], ['{"v":2,"interpreter":"/x","args":[]}', /v is not 1/],
    ['{"v":1,"interpreter":"x","args":[]}', /interpreter is not an absolute path/], ['{"v":1,"args":[]}', /interpreter is not an absolute path/],
    ['{"v":1,"interpreter":"/x","args":"a"}', /args is not a list of strings/], ['{"v":1,"interpreter":"/x","args":[1]}', /args is not a list of strings/]] as const) {
    const r = parseExpectedCommand(bad);
    assert.ok(typeof r === "string" && why.test(r), `${bad}: ${JSON.stringify(r)}`);
  }
  assert.equal(defaultDaemonCommandFile({ XDG_CONFIG_HOME: "/c" }, "/h"), "/c/agent-browser/daemon-command.json");
  assert.equal(defaultDaemonCommandFile({}, "/h"), "/h/.config/agent-browser/daemon-command.json");
  const dir = mkdtempSync(join(tmpdir(), "ab-cmd-"));
  try {
    const f = join(dir, "daemon-command.json");
    const uid = process.getuid!();
    assert.match(String(readExpectedCommand(f, uid)), /cannot be read/, "a missing file");
    writeFileSync(f, '{"v":1,"interpreter":"/x","args":[]}');
    chmodSync(f, 0o600);
    assert.deepEqual(readExpectedCommand(f, uid), { interpreter: "/x", args: [] });
    chmodSync(f, 0o620);
    assert.match(String(readExpectedCommand(f, uid)), /writable by its group or by others/);
    chmodSync(f, 0o602);
    assert.match(String(readExpectedCommand(f, uid)), /writable by its group or by others/);
    chmodSync(f, 0o644);
    assert.deepEqual(readExpectedCommand(f, uid), { interpreter: "/x", args: [] }, "readable by others is not writable");
    assert.match(String(readExpectedCommand(f, uid + 1)), /not owned by the service's user/);
    const link = join(dir, "link.json");
    symlinkSync(f, link);
    assert.match(String(readExpectedCommand(link, uid)), /not a regular file/);
    assert.match(String(readExpectedCommand(dir, uid)), /not a regular file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the systemd query: systemctl --user show --property=MainPID --value <unit>; a pid, 0 for a unit with no process, null for a failure, an answer that is not a number, or no answer in time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-sysd-"));
  try {
    const bin = join(dir, "systemctl"), args = join(dir, "args");
    const fake = (body: string) => { writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(args)}\n${body}\n`); chmodSync(bin, 0o700); };
    fake("echo 4242");
    assert.equal(await systemdMainPid("agentwatch.service", { systemctl: bin }), 4242);
    assert.deepEqual(readFileSync(args, "utf8").trim().split("\n"), ["--user", "show", "--property=MainPID", "--value", "agentwatch.service"]);
    fake("echo 0");
    assert.equal(await systemdMainPid("agentwatch.service", { systemctl: bin }), 0);
    fake("echo 'Failed to connect to bus' >&2; exit 1");
    assert.equal(await systemdMainPid("agentwatch.service", { systemctl: bin }), null);
    fake("echo 12ab");
    assert.equal(await systemdMainPid("agentwatch.service", { systemctl: bin }), null);
    fake("exec sleep 30");
    const t0 = Date.now();
    assert.equal(await systemdMainPid("agentwatch.service", { systemctl: bin, timeoutMs: 300 }), null);
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(await systemdMainPid("agentwatch.service", { systemctl: join(dir, "missing") }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("admission with real processes: the MainPID's direct child with the daemon's command is admitted (the live case on taylor), and so is the MainPID itself with its command", { skip: !linux, timeout: 60_000 }, async () => {
  const w = await world();
  try {
    assert.ok(w.logs.includes("service: the peer check runs (pidfd)"), w.logs.join("\n"));
    const { p, pid } = await w.uv();
    w.main.pid = pid;
    expect(w, { args: daemonArgs(w, "m1") });
    const lines = await w.daemon(p, "m1");
    assert.ok(admitted(lines), JSON.stringify(lines));
    assert.equal(lines.find((l) => l.t === "res").data.state, "off");
    // The MainPID itself, with its own command line in the file.
    expect(w, { args: ["-e", UV, w.sock, DAEMON] });
    p.child.stdin!.write("self\n");
    const hello = await p.next((l) => l.pid === pid && l.line);
    assert.equal(hello.line.t, "hello", JSON.stringify(hello));
    assert.ok(w.logs.some((l) => /^control: connection \d+ admitted \(pid \d+\)$/.test(l)), w.logs.join("\n"));
  } finally { await w.close(); }
});

test("rule 2: a child that the daemon forks and that connects itself, a process with the daemon's command and another parent, and the service's own pid are refused, each with one line that names rule 2, logged", { skip: !linux, timeout: 60_000 }, async () => {
  const w = await world();
  try {
    const { p, pid } = await w.uv();
    w.main.pid = pid;
    // The daemon's child: its parent is the daemon, not the MainPID (its command line is the file's).
    expect(w, { args: daemonArgs(w, "g") });
    const grand = await w.daemon(p, "fork:g");
    assert.equal(refusedWith(grand), control.refused.find((r: any) => /rule 2/.test(r.line.reason)).line.reason, JSON.stringify(grand));
    // The same command started by another parent (this test, which is also the service).
    const other = run(daemonArgs(w, "g"));
    w.procs.push(other);
    await other.next((l) => l.closed);
    assert.equal(refusedWith(other.lines.filter((l) => l.line).map((l) => l.line)), refusedRule(2, "its parent is not the MainPID of agentwatch's unit"));
    // The service's own pid as the MainPID: a connection of the service's process never passes.
    w.main.pid = process.pid;
    const self = await daemonClient(w.sock);
    assert.equal(await closesWithin(self), true);
    assert.deepEqual(self.lines, [{ t: "refused", reason: refusedRule(2, "it is the service itself") }]);
    assert.ok(w.logs.includes(`control: connection 3 refused: ${refusedRule(2, "it is the service itself")}`), w.logs.join("\n"));
  } finally { await w.close(); }
});

test("rule 3: the peer's argv[1:] and its executable against the expected command's file, read at each accept (a new file takes effect with no restart); a missing or unsafe file refuses", { skip: !linux, timeout: 60_000 }, async () => {
  const w = await world();
  try {
    const { p, pid } = await w.uv();
    w.main.pid = pid;
    rmSync(w.file, { force: true });
    assert.match(String(refusedWith(await w.daemon(p, "a"))), /^The control door admits only the agentwatch daemon process: rule 3 failed \(the file of the daemon's expected command cannot be read \(ENOENT\)\)\.$/);
    expect(w, { args: daemonArgs(w, "a") });
    assert.equal(refusedWith(await w.daemon(p, "b")), refusedRule(3, "its command line is not the daemon's command"));
    expect(w, { args: daemonArgs(w, "a").slice(0, -1) });
    assert.equal(refusedWith(await w.daemon(p, "a")), refusedRule(3, "its command line is not the daemon's command"), "one argument fewer");
    expect(w, { args: daemonArgs(w, "a"), interpreter: "/usr/bin/env" });
    assert.equal(refusedWith(await w.daemon(p, "a")), refusedRule(3, "its executable is not the interpreter of the daemon's command"));
    expect(w, { args: daemonArgs(w, "a") }, 0o660);
    assert.match(String(refusedWith(await w.daemon(p, "a"))), /rule 3 failed \(the file of the daemon's expected command .*writable by its group or by others/);
    // The file now names this command: the next connection is admitted, with no restart of the service.
    expect(w, { args: daemonArgs(w, "a") });
    assert.ok(admitted(await w.daemon(p, "a")));
  } finally { await w.close(); }
});

test("rule 1 and the systemd query (m1): no MainPID (the query failed, or no unit) gives the vectors' refused line; a MainPID that has no process fails rule 1; a new MainPID after a restart admits only its own child", { skip: !linux, timeout: 60_000 }, async () => {
  const w = await world();
  try {
    const { p, pid } = await w.uv();
    expect(w, { args: daemonArgs(w, "a") });
    const m1 = control.refused.find((r: any) => !/rule/.test(r.line.reason)).line.reason;
    w.main.pid = null;
    assert.equal(refusedWith(await w.daemon(p, "a")), m1, "the query failed");
    w.main.pid = 0;
    assert.equal(refusedWith(await w.daemon(p, "a")), m1, "no process of the unit");
    // A pid with no process: no pidfd of the MainPID.
    const gone = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => gone.once("exit", r));
    w.main.pid = gone.pid!;
    assert.equal(refusedWith(await w.daemon(p, "a")), refusedRule(1, "the service cannot hold a pidfd of the MainPID"));
    // A restart: a new uv is the MainPID. Its child is admitted; a new child of the old uv is refused (rule 2).
    w.main.pid = pid;
    assert.ok(admitted(await w.daemon(p, "a")));
    const second = await w.uv();
    w.main.pid = second.pid;
    assert.ok(admitted(await w.daemon(second.p, "a")), "the new MainPID's child");
    assert.equal(refusedWith(await w.daemon(p, "a")), refusedRule(2, "its parent is not the MainPID of agentwatch's unit"), "the old MainPID's child");
  } finally { await w.close(); }
});

test("rule 4: the MainPID read again after the checks must be the same, and a peer that exits during the check is refused", { skip: !linux, timeout: 60_000 }, async () => {
  const w = await world();
  try {
    const { p, pid } = await w.uv();
    expect(w, { args: daemonArgs(w, "a") });
    w.main.pid = pid;
    w.main.queue = [pid, pid + 100_000];
    assert.equal(refusedWith(await w.daemon(p, "a")), refusedRule(4, "the MainPID changed during the check"));
    assert.deepEqual(w.main.queue, [], "two reads of the MainPID, before and after the checks");
    // The peer exits while the service waits for the first MainPID read.
    let release!: () => void;
    w.main.hold = new Promise((r) => { release = r; });
    const known = new Set(p.lines.map((l) => l.pid));
    p.child.stdin!.write("daemon a\n");
    await new Promise((r) => setTimeout(r, 300));
    const ours = w.logs.length;
    const peer = await childOf(pid, known);
    w.pids.push(peer);
    process.kill(peer, "SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
    release();
    await waitFor(() => w.logs.slice(ours).some((l) => l.includes("refused")), "the refusal");
    assert.ok(w.logs.slice(ours).some((l) => l.endsWith(refusedRule(4, "the peer changed during the check"))), w.logs.slice(ours).join("\n"));
  } finally { w.main.hold = undefined; await w.close(); }
});

/** The pid of a child of `parent` that `known` does not hold, from /proc. */
async function childOf(parent: number, known: Set<number>): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const kids = readFileSync(`/proc/${parent}/task/${parent}/children`, "latin1").trim().split(/\s+/).filter(Boolean).map(Number).filter((k) => !known.has(k));
    if (kids.length) return kids[kids.length - 1];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("no child");
}
async function waitFor(f: () => boolean, what: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!f()) { if (Date.now() - t0 > ms) throw new Error(`no ${what} in ${ms} ms`); await new Promise((r) => setTimeout(r, 20)); }
}

test("the service's two doors: control.sock and the agent door with mode 0600; the agent door is today's endpoint with today's peer check (no Chrome: the link's 503); the stop removes both sockets", { skip: !linux, timeout: 60_000 }, async () => {
  const w = await world();
  const cdp = join(w.dir, "cdp.sock");
  try {
    for (const s of [w.sock, cdp]) assert.equal(statSync(s).mode & 0o777, 0o600, s);
    assert.ok(w.logs.some((l) => l.startsWith("relay: ready on ")), w.logs.join("\n"));
    const r = await raw(`ws+unix://${cdp}:/devtools/browser/web-1`);
    assert.deepEqual([r.status, r.body], [503, NOT_READY.link], "the endpoint is not ready: no extension is connected");
    const page = await raw(`ws+unix://${cdp}:/devtools/browser/web-1`, { origin: "https://example.com" });
    assert.equal(page.status, 403, "a web page's Origin");
    assert.equal(w.service.state.endpointState().form, "pidfd");
  } finally {
    await w.service.stop();
    assert.equal(existsSync(w.sock), false);
    assert.equal(existsSync(cdp), false);
    await w.close();
  }
});
