// `agent-browser service` on the command line (contract C12, "The command" and "The fake service"; board ab-v16.94.2):
// --hello with no service running, the usage errors, the service as a process (its control door fails closed when its
// peer check cannot run), and the fake as a process for agentwatch's hermetic tests. Nothing starts the service by
// default: no install step and no unit file of this repository names it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { raw } from "./fake-bridge.ts";
import { NOT_READY } from "../src/relay/model.ts";
import { closesWithin, DAEMON_HELLO, daemonClient } from "./fake-daemon.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BIN = join(ROOT, "bin/agent-browser.js");
const control = JSON.parse(readFileSync(new URL("./vectors/control.json", import.meta.url), "utf8"));
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const runNode = (args: string[], cwd = ROOT) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
  execFile(process.execPath, args, { cwd, timeout: 30_000 }, (e, stdout, stderr) => resolve({ code: e ? (e as any).code ?? 1 : 0, stdout, stderr }));
});
async function until(f: () => boolean, what: string, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!f()) { if (Date.now() - t0 > ms) throw new Error(`no ${what} in ${ms} ms`); await new Promise((r) => setTimeout(r, 20)); }
}

test("service --hello prints the service's hello as one line and exits, with no service running and no node:ffi; --fake --hello prints the fake's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-hello-"));
  try {
    const r = await runNode([BIN, "service", "--hello"], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.split("\n").length, 2, "one line");
    const h = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(h), ["t", "v", "side", "version", "commit", "features"]);
    assert.deepEqual([h.t, h.v, h.side, h.version, h.features], ["hello", 1, "service", VERSION, []]);
    assert.ok(h.commit === null || /^[0-9a-f]{40}$/.test(h.commit));
    assert.doesNotMatch(r.stderr, /ExperimentalWarning|FFI/);
    assert.deepEqual(readdirSync(dir), [], "no socket, no file");
    const f = await runNode([BIN, "service", "--hello", "--fake"], dir);
    assert.equal(f.code, 0, f.stderr);
    assert.deepEqual(JSON.parse(f.stdout), { ...control.hellos.find((x: any) => x.line.features.includes("fake")).line, version: VERSION });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the usage of service: --agent-door is required; its flags are its own and no other command takes them; --refuse goes with --fake, and --fake with --control-door", async () => {
  for (const [args, what] of [
    [["service"], /--agent-door is required/],
    [["service", "--agent-door", "/x/cdp.sock", "--bogus"], /Unknown option|bogus/],
    [["service", "--agent-door", "/x/cdp.sock", "--state-dir", "/x"], /--state-dir is not an option of service/],
    [["service", "extra", "--agent-door", "/x/cdp.sock"], /usage: agent-browser service/],
    [["service", "--fake"], /--fake needs --control-door/],
    [["service", "--refuse", "--agent-door", "/x/cdp.sock"], /--refuse goes with --fake/],
    [["commands", "--agent-door", "/x/cdp.sock"], /--agent-door is only for service/],
    [["relay", "--socket", "/x/cdp.sock", "--fake"], /--fake is only for service/],
  ] as const) {
    const r = await runNode([BIN, ...args]);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, what, args.join(" "));
  }
});

test("the service as a process with node:ffi off: its peer check cannot run, so the control door refuses each connection with the reason and the agent door answers the 503 of step 3; SIGTERM stops it and removes both sockets", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-svc-"));
  const sock = join(dir, "control.sock"), cdp = join(dir, "cdp.sock");
  const child = spawn(process.execPath, ["--no-experimental-ffi", BIN, "service", "--agent-door", cdp, "--control-door", sock,
    "--daemon-unit", "agent-browser-test-none.service", "--daemon-command", join(dir, "daemon-command.json")], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr!.on("data", (d) => (err += d));
  try {
    await until(() => err.includes("service: ready"), "the ready line");
    assert.match(err, /^service: the peer check cannot run: node:ffi does not load \(ERR_UNKNOWN_BUILTIN_MODULE\)$/m);
    const c = await daemonClient(sock);
    assert.equal(await closesWithin(c), true);
    assert.deepEqual(c.lines, [{ t: "refused", reason: "The control door cannot read the program that connects (node:ffi does not load (ERR_UNKNOWN_BUILTIN_MODULE)), so it admits no connection." }]);
    const r = await raw(`ws+unix://${cdp}:/devtools/browser/web-1`);
    assert.deepEqual([r.status, r.body], [503, NOT_READY.cannotRead]);
    child.kill("SIGTERM");
    const code = await new Promise((r) => child.once("exit", (c) => r(c)));
    assert.equal(code, 0, err);
    assert.equal(existsSync(sock), false);
    assert.equal(existsSync(cdp), false);
    assert.match(err, /^service: stopped$/m);
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
});

test("the fake as a process (agentwatch's hermetic tests): the hello, the vectors' answers, an event from its standard input; SIGTERM stops it and removes its socket", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-fake-"));
  const sock = join(dir, "control.sock");
  const child = spawn(process.execPath, [BIN, "service", "--fake", "--control-door", sock], { stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  child.stderr!.on("data", (d) => (err += d));
  try {
    await until(() => err.includes("control: ready on"), "the ready line");
    const c = await daemonClient(sock);
    assert.deepEqual((await c.next()).features, ["fake"]);
    c.send(DAEMON_HELLO);
    for (const v of control.requests.slice(0, 3)) { c.send(v.req); assert.deepEqual(await c.answer(v.req.id), v.res, v.note); }
    const ev = control.events.find((v: any) => v.ev.ev === "prompt").ev;
    child.stdin!.write(JSON.stringify(ev) + "\n");
    assert.deepEqual(await c.next((l) => l.t === "ev"), ev);
    c.end();
    child.kill("SIGTERM");
    assert.equal(await new Promise((r) => child.once("exit", (c) => r(c))), 0, err);
    assert.equal(existsSync(sock), false);
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
});

test("off by default: no install step, unit file or script of this repository starts the service", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.ok(!JSON.stringify(pkg.scripts).includes("service"), "no npm script runs it");
  const files = (d: string): string[] => readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]));
  assert.deepEqual([...files("bin"), ...files("src"), ...files("python")].filter((f) => /\.(service|socket|plist)$/.test(f)), [], "no unit file");
  assert.ok(!readFileSync(join(ROOT, "index.js"), "utf8").includes("service"), "the library does not start it");
});
