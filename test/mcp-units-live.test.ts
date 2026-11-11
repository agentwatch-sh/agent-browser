// The opt-in live test of the units that hold the MCP port (the self-contained design, section 19, build note 1; C11, "The
// MCP path"; stage 1d part 2a, board ab-v16.94.5). It INSTALLS USER UNITS: it is skipped unless AB_LIVE_UNITS=1, and only
// the lead runs it. It writes three units with unique test names (test/live/mcp-units.ts) into the user manager's runtime
// folder ($XDG_RUNTIME_DIR/systemd/user, gone at a reboot), on a free port, starts only its own socket unit (and, in the
// last check, its own stand-in service), and in every path stops its units, removes its files and reloads the manager.
// It starts no browser and no Xvfb, and it never touches agentwatch's or the agent browser's own units.
//
// The three checks of build note 1, and the takeover:
// 1. A connect while the daemon owns (the service is down) leaves the service unit inactive with no job, and the
//    connection waits with no answer (fail closed).
// 2. 300 connects in 2 s leave the socket unit active, and its LISTEN line has the user's uid.
// 3. A daemon-reload and a restart of the holder keep the port held.
// 4. The service stand-in takes the socket's fd through Sockets= (sd_listen_fds) and serves the admission on it; after
//    its stop the socket unit still holds the port.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStat } from "../src/relay/peer.ts";
import { parseTcp } from "../src/service/mcp/proc.ts";
import { STANDIN, unitNames, unitTexts } from "./live/mcp-units.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const LIVE = process.env.AB_LIVE_UNITS === "1" && process.platform === "linux";
const SKIP = LIVE ? false : "opt-in: set AB_LIVE_UNITS=1 (it installs user units with test names; only the lead runs it)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** systemctl --user, with a time limit; it rejects on a failure. */
const systemctl = (...args: string[]) => new Promise<string>((resolve, reject) => {
  execFile("systemctl", ["--user", ...args], { timeout: 30_000, encoding: "utf8" }, (e, out, err) => (e ? reject(new Error(`systemctl --user ${args.join(" ")}: ${err || e.message}`)) : resolve(out)));
});
const show = async (unit: string) => Object.fromEntries((await systemctl("show", unit, "--property=ActiveState", "--property=SubState", "--property=Job")).trim().split("\n").map((l) => l.split("=", 2) as [string, string]));

/** A free port on 127.0.0.1 (a listen on port 0, then its close). */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as { port: number };
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** The uid of the LISTEN line of 127.0.0.1:<port> in /proc/net/tcp, or null. */
function listenUid(port: number): number | null {
  const line = parseTcp(readFileSync("/proc/net/tcp", "latin1")).find((l) => l.local === `127.0.0.1:${port}` && l.remote === "0.0.0.0:0");
  return line ? line.uid : null;
}

/** A connect and a request that get no answer and no close in `ms` (the port is held, and nothing serves it). */
async function waitsWithNoAnswer(port: number, ms = 1500): Promise<boolean> {
  const s: Socket = connect({ host: "127.0.0.1", port });
  let got = false;
  s.on("data", () => { got = true; });
  s.on("close", () => { got = true; });
  s.on("error", () => { got = true; });
  s.write(`GET /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
  await sleep(ms);
  s.destroy();
  return !got;
}

test("the units that hold the MCP port (build note 1): live, with user units of test names", { skip: SKIP, timeout: 300_000 }, async (t) => {
  const runtime = process.env.XDG_RUNTIME_DIR;
  assert.ok(runtime && runtime.startsWith("/"), "XDG_RUNTIME_DIR");
  const unitDir = join(runtime, "systemd", "user");
  const madeDir = !existsSync(unitDir);
  const names = unitNames(randomBytes(4).toString("hex"));
  const port = await freePort();
  const work = mkdtempSync(join(tmpdir(), "ab-mcp-units-"));
  const token = "abt1_" + Buffer.from("test, not a token: the live units", "latin1").toString("base64url");
  const self = parseStat(readFileSync(`/proc/${process.pid}/stat`, "latin1"))!;
  writeFileSync(join(work, "standin.mjs"), STANDIN, { mode: 0o600 });
  writeFileSync(join(work, "config.json"), JSON.stringify({ scope: "t-units", root: { pid: process.pid, start: self.start }, fingerprint: createHash("sha256").update(token, "latin1").digest("hex") }), { mode: 0o600 });
  const texts = unitTexts({ names, port, execStart: `${process.execPath} --disable-sigusr1 --no-warnings ${join(work, "standin.mjs")} ${ROOT} ${join(work, "config.json")}` });
  mkdirSync(unitDir, { recursive: true });
  const written: string[] = [];
  try {
    for (const [name, text] of Object.entries(texts)) { writeFileSync(join(unitDir, name), text); written.push(join(unitDir, name)); }
    await systemctl("daemon-reload");
    await systemctl("start", names.socket);
    assert.equal((await show(names.socket)).ActiveState, "active", "the socket unit holds the port");
    assert.equal(listenUid(port), process.getuid!(), "its LISTEN line has the user's uid");

    await t.test("1. a connect while the daemon owns leaves the service inactive with no job, and waits with no answer", async () => {
      assert.ok(await waitsWithNoAnswer(port), "the connection waits with no answer");
      const svc = await show(names.service);
      assert.deepEqual([svc.ActiveState, svc.Job], ["inactive", ""], "no connection starts the service");
      assert.equal((await show(names.hold)).ActiveState, "active", "the holder took the trigger (it ran /bin/true)");
    });

    await t.test("2. 300 connects in 2 s leave the socket unit active and its LISTEN line with the user's uid", async () => {
      const started = Date.now();
      const socks: Socket[] = [];
      for (let i = 0; i < 300; i++) {
        const s = connect({ host: "127.0.0.1", port });
        s.on("error", () => {});
        socks.push(s);
        if (i % 50 === 49) await sleep(1);
      }
      assert.ok(Date.now() - started < 2000, "300 connects within 2 s");
      await sleep(500);
      for (const s of socks) s.destroy();
      assert.equal((await show(names.socket)).ActiveState, "active");
      assert.equal(listenUid(port), process.getuid!());
      assert.deepEqual([(await show(names.service)).ActiveState, (await show(names.service)).Job], ["inactive", ""]);
    });

    await t.test("3. a daemon-reload and a restart of the holder keep the port held", async () => {
      await systemctl("daemon-reload");
      assert.equal(listenUid(port), process.getuid!(), "after the daemon-reload");
      await systemctl("restart", names.hold);
      assert.equal((await show(names.socket)).ActiveState, "active");
      assert.equal(listenUid(port), process.getuid!(), "after the holder's restart");
      assert.ok(await waitsWithNoAnswer(port), "still fail closed");
      assert.equal((await show(names.service)).ActiveState, "inactive");
    });

    await t.test("4. the service stand-in takes the fd through Sockets= and admits this test's process with its token; after its stop the port stays held", async () => {
      await systemctl("start", names.service);
      let res: { status: number; body: string } | null = null;
      for (let i = 0; i < 50 && res === null; i++) {
        res = await new Promise((resolve) => {
          const req = httpRequest({ host: "127.0.0.1", port, path: "/mcp/t-units", headers: { Authorization: `Bearer ${token}` }, agent: false, timeout: 2000 }, (r) => {
            let body = ""; r.on("data", (d) => (body += d)); r.on("end", () => resolve({ status: r.statusCode!, body }));
          });
          req.on("error", () => resolve(null));
          req.on("timeout", () => { req.destroy(); resolve(null); });
          req.end();
        });
        if (res === null) await sleep(200);
      }
      assert.deepEqual(res, { status: 200, body: "admitted t-units" });
      await systemctl("stop", names.service);
      assert.equal((await show(names.socket)).ActiveState, "active");
      assert.equal(listenUid(port), process.getuid!(), "the socket unit holds the port after the service's stop");
      assert.ok(await waitsWithNoAnswer(port), "fail closed again");
    });
  } finally {
    // Stop the test's own units, remove their files and the stand-in's folder, and reload.
    await systemctl("stop", names.service, names.socket, names.hold).catch(() => {});
    for (const f of written) rmSync(f, { force: true });
    await systemctl("daemon-reload").catch(() => {});
    await systemctl("reset-failed", names.service, names.socket, names.hold).catch(() => {});
    if (madeDir) { try { rmdirSync(unitDir); } catch {} }
    rmSync(work, { recursive: true, force: true });
  }
});
